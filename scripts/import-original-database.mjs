import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const IMPORT_TABLE_ORDER = Object.freeze([
  "User",
  "Project",
  "Episode",
  "ProjectRole",
  "Session",
  "ScriptScene",
  "StoryboardShot",
  "SeedanceUnit",
  "SeedanceUnitShot",
  "CompiledPromptVersion",
  "WorkflowIssue",
  "PipelineRun",
  "PresentationContract",
  "CliRoleSession",
  "ApiRoleSession",
  "Asset",
  "SceneSnapshot",
  "TaskPackage",
  "GenerationRun",
  "ReviewRound",
  "FinalScript",
]);

export function orderAssetRows(rows) {
  const remaining = new Map(rows.map((row) => [row.id, row]));
  const emitted = new Set();
  const ordered = [];

  while (remaining.size > 0) {
    let progressed = false;
    for (const [id, row] of remaining) {
      if (row.parentId == null || emitted.has(row.parentId) || !remaining.has(row.parentId)) {
        ordered.push(row);
        emitted.add(id);
        remaining.delete(id);
        progressed = true;
      }
    }
    if (!progressed) throw new Error("Asset 表存在循环父子关系，已停止导入。");
  }

  return ordered;
}

export function readLocalSnapshot(sourceDb) {
  if (!sourceDb || !existsSync(sourceDb)) {
    throw new Error("DIRECTOR_SOURCE_DB 不存在。");
  }

  return IMPORT_TABLE_ORDER.map((table) => {
    const output = execFileSync(
      "sqlite3",
      ["-readonly", "-cmd", ".timeout 10000", "-json", sourceDb, `SELECT * FROM "${table}"`],
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024 },
    ).trim();
    const rows = output ? JSON.parse(output) : [];
    return { table, rows: table === "Asset" ? orderAssetRows(rows) : rows };
  });
}

export function addCompatibilityProjectRows(snapshot) {
  const projectEntry = snapshot.find((item) => item.table === "Project");
  if (!projectEntry) return snapshot;
  const existingIds = new Set(projectEntry.rows.map((row) => row.id));
  const missingIds = new Set();
  for (const entry of snapshot) {
    if (entry.table === "Project") continue;
    for (const row of entry.rows) {
      if (typeof row.projectId === "string" && row.projectId && !existingIds.has(row.projectId)) {
        missingIds.add(row.projectId);
      }
    }
  }
  if (missingIds.size === 0) return snapshot;

  const compatibilityProjects = [...missingIds].sort().map((id) => ({
    id,
    title: `[兼容归档] ${id}`,
    description: "原 SQLite 中父项目已删除；此隐藏记录仅用于保留孤立历史数据。",
    style: null,
    aspectRatio: "16:9",
    executionMode: "CLI",
    ruleVersion: "TASK_SCHEMA_V4",
    createdAt: 0,
    updatedAt: 0,
    archivedAt: 0,
  }));
  return snapshot.map((entry) => entry.table === "Project"
    ? { ...entry, rows: [...entry.rows, ...compatibilityProjects] }
    : entry);
}

async function importSnapshot(snapshot, siteUrl, token) {
  const endpoint = `${siteUrl.replace(/\/$/, "")}/api/admin/import`;

  for (const { table, rows } of snapshot) {
    for (let index = 0; index < rows.length; index += 50) {
      try {
        curlJson(endpoint, token, "POST", JSON.stringify({ table, rows: rows.slice(index, index + 50) }));
      } catch (error) {
        const message = error instanceof Error ? error.message : "未知错误";
        throw new Error(`${table} 导入失败（${message}）。`);
      }
    }
  }

  const payload = curlJson(endpoint, token, "GET");
  return payload.counts;
}

function curlJson(endpoint, token, method, body) {
  const args = [
    "--silent",
    "--show-error",
    "--request",
    method,
    "--header",
    `Authorization: Bearer ${token}`,
    "--header",
    "Accept: application/json",
    "--max-time",
    "120",
    "--write-out",
    "\n%{http_code}",
  ];
  if (body !== undefined) {
    args.push("--header", "Content-Type: application/json", "--data-binary", "@-");
  }
  args.push(endpoint);

  let output;
  try {
    output = execFileSync("curl", args, {
      encoding: "utf8",
      input: body,
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch {
    throw new Error("无法连接站点");
  }
  return parseCurlJsonResponse(output);
}

export function parseCurlJsonResponse(output) {
  const separator = output.lastIndexOf("\n");
  if (separator < 0) throw new Error("站点响应格式无效");
  const status = Number(output.slice(separator + 1).trim());
  if (!Number.isInteger(status) || status < 200 || status >= 300) {
    throw new Error(`HTTP ${Number.isInteger(status) ? status : "未知"}`);
  }
  try {
    return JSON.parse(output.slice(0, separator));
  } catch {
    throw new Error("站点未返回有效 JSON");
  }
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const sourceDb = process.env.DIRECTOR_SOURCE_DB;
  const sourceSnapshot = readLocalSnapshot(sourceDb);
  const totalRows = sourceSnapshot.reduce((total, item) => total + item.rows.length, 0);

  if (dryRun) {
    console.log(`${sourceSnapshot.length} tables, ${totalRows} rows, no data sent`);
    return;
  }

  const siteUrl = process.env.DIRECTOR_SITE_URL;
  const token = process.env.DIRECTOR_IMPORT_TOKEN;
  if (!siteUrl || !token) throw new Error("缺少 DIRECTOR_SITE_URL 或 DIRECTOR_IMPORT_TOKEN。");

  const snapshot = addCompatibilityProjectRows(sourceSnapshot);
  const importedRows = snapshot.reduce((total, item) => total + item.rows.length, 0);
  const compatibilityRows = importedRows - totalRows;
  const counts = await importSnapshot(snapshot, siteUrl, token);
  for (const { table, rows } of snapshot) {
    if (Number(counts?.[table]) !== rows.length) {
      throw new Error(`${table} 计数不一致：本地 ${rows.length}，远端 ${counts?.[table] ?? "未知"}。`);
    }
  }
  console.log(
    `${sourceSnapshot.length} tables, ${totalRows} source rows imported and verified` +
    (compatibilityRows ? ` (+${compatibilityRows} hidden compatibility row)` : ""),
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
