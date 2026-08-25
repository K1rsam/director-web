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

async function importSnapshot(snapshot, siteUrl, token) {
  const endpoint = `${siteUrl.replace(/\/$/, "")}/api/admin/import`;

  for (const { table, rows } of snapshot) {
    for (let index = 0; index < rows.length; index += 50) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ table, rows: rows.slice(index, index + 50) }),
      });
      if (!response.ok) throw new Error(`${table} 导入失败（HTTP ${response.status}）。`);
    }
  }

  const response = await fetch(endpoint, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`远端计数校验失败（HTTP ${response.status}）。`);
  const payload = await response.json();
  return payload.counts;
}

async function main() {
  const dryRun = process.argv.slice(2).includes("--dry-run");
  const sourceDb = process.env.DIRECTOR_SOURCE_DB;
  const snapshot = readLocalSnapshot(sourceDb);
  const totalRows = snapshot.reduce((total, item) => total + item.rows.length, 0);

  if (dryRun) {
    console.log(`${snapshot.length} tables, ${totalRows} rows, no data sent`);
    return;
  }

  const siteUrl = process.env.DIRECTOR_SITE_URL;
  const token = process.env.DIRECTOR_IMPORT_TOKEN;
  if (!siteUrl || !token) throw new Error("缺少 DIRECTOR_SITE_URL 或 DIRECTOR_IMPORT_TOKEN。");

  const counts = await importSnapshot(snapshot, siteUrl, token);
  for (const { table, rows } of snapshot) {
    if (Number(counts?.[table]) !== rows.length) {
      throw new Error(`${table} 计数不一致：本地 ${rows.length}，远端 ${counts?.[table] ?? "未知"}。`);
    }
  }
  console.log(`${snapshot.length} tables, ${totalRows} rows imported and verified`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
