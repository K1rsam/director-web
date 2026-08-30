/**
 * 个人 Runner 的本地执行桥。
 *
 * 重要边界：这里创建的是一次性临时 SQLite，只装入网站 D1 发来的任务快照。
 * 不读取本机 dev.db，也不把本机项目库当成线上数据源。执行完成后只导出
 * 当前任务 writeScope 内的表和删除差异，交给 Sites 回写 D1。
 */
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { recordLocalDiagnosticLog } from "../lib/local-diagnostic-log";

type Row = Record<string, unknown>;
type TableRows = Record<string, Row[]>;

type RunnerInput = {
  protocolVersion: number;
  inputOrigin: "sites-d1";
  job: {
    id: string;
    projectId: string;
    kind: "project_foundation" | "episode_pipeline";
    payload: Record<string, unknown>;
    attempt: number;
  };
  writeScope: {
    kind: "foundation" | "episode";
    projectId: string;
    episodeId?: string;
    tables: string[];
  };
  tables: TableRows;
};

const PROTOCOL_VERSION = 1;
const INPUT_ORIGIN = "sites-d1";
const RESULT_TABLES = new Set([
  "Asset",
  "CliRoleSession",
  "CompiledPromptVersion",
  "PipelineRun",
  "PresentationContract",
  "SceneSnapshot",
  "ScriptScene",
  "SeedanceUnit",
  "SeedanceUnitShot",
  "StoryboardShot",
  "TaskPackage",
  "WorkflowIssue",
]);

const args = parseArgs(process.argv.slice(2));
const inputPath = required(args.input, "缺少 --input 参数。");
const outputPath = required(args.output, "缺少 --output 参数。");

const input = JSON.parse(await readFile(inputPath, "utf8")) as RunnerInput;
validateInput(input);

const tempRoot = await mkdtemp(join(tmpdir(), "director-runner-job-"));
const databasePath = join(tempRoot, "runner.sqlite");
let executionError: string | null = null;

try {
  await provisionDatabase(databasePath);
  hydrateDatabase(databasePath, input.tables);
  await executeJob(databasePath, input);
  const tables = readResultTables(databasePath, input);
  const output = {
    protocolVersion: PROTOCOL_VERSION,
    inputOrigin: INPUT_ORIGIN,
    jobId: input.job.id,
    projectId: input.job.projectId,
    writeScope: input.writeScope,
    tables,
    deletions: buildDeletions(input.tables, tables, input.writeScope.tables),
    meta: {
      attempt: input.job.attempt,
      completedAt: new Date().toISOString(),
      executionError,
    },
  };
  await writeFile(outputPath, JSON.stringify(output));
} catch (error) {
  executionError = messageOf(error);
  await recordLocalDiagnosticLog({
    kind: /超时|timeout/i.test(executionError) ? "task_timeout" : "task_failed",
    code: /超时|timeout/i.test(executionError) ? "LOCAL_TASK_TIMEOUT" : "LOCAL_TASK_FAILED",
    operation: "task",
    error,
    jobId: input.job.id,
    taskKind: input.job.kind,
    attempt: input.job.attempt,
  });
  // 如果数据库已经完成初始化，尽量导出部分结果。这样网站仍能把已经完成的
  // 岗位状态和诊断日志写回 D1，而不是只留下一个永远“进行中”的任务。
  try {
    const tables = readResultTables(databasePath, input);
    await writeFile(
      outputPath,
      JSON.stringify({
        protocolVersion: PROTOCOL_VERSION,
        inputOrigin: INPUT_ORIGIN,
        jobId: input.job.id,
        projectId: input.job.projectId,
        writeScope: input.writeScope,
        tables,
        deletions: buildDeletions(input.tables, tables, input.writeScope.tables),
        meta: { attempt: input.job.attempt, completedAt: new Date().toISOString(), executionError },
      }),
    );
  } catch {
    // 初始化失败时没有可回写的数据，保留原始错误由 Runner 上报。
  }
  console.error(executionError);
  process.exitCode = 1;
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

function validateInput(value: RunnerInput): void {
  if (!value || value.protocolVersion !== PROTOCOL_VERSION) throw new Error("Runner 任务协议版本不匹配，请更新本地执行代码。");
  if (value.inputOrigin !== INPUT_ORIGIN) throw new Error("Runner 任务不是来自 Sites D1，已拒绝使用本地项目库作为输入。");
  if (!value.job?.id || !value.job.projectId) throw new Error("Runner 任务缺少项目标识。");
  if (value.job.kind !== "project_foundation" && value.job.kind !== "episode_pipeline") {
    throw new Error(`不支持的 Runner 任务类型：${String(value.job.kind)}`);
  }
  if (value.writeScope.projectId !== value.job.projectId) throw new Error("Runner 任务范围与项目不一致。");
  for (const table of value.writeScope.tables) {
    if (!RESULT_TABLES.has(table)) throw new Error(`Runner 任务包含未授权的回写表：${table}`);
  }
}

async function provisionDatabase(databasePath: string): Promise<void> {
  const prismaCli = join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  const databaseUrl = pathToFileURL(databasePath).toString();
  await runProcess(
    process.execPath,
    [prismaCli, "db", "push", "--skip-generate", "--accept-data-loss"],
    process.cwd(),
    { ...process.env, DATABASE_URL: databaseUrl },
    120_000,
  );
}

function hydrateDatabase(databasePath: string, tables: TableRows): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec("PRAGMA foreign_keys=OFF;");
    for (const [table, rows] of Object.entries(tables)) {
      if (!RESULT_TABLES.has(table) && table !== "Episode" && table !== "Project") continue;
      const columns = new Set(
        (db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Row[]).map((row) => String(row.name)),
      );
      for (const row of rows) {
        const entries = Object.entries(row).filter(([column]) => columns.has(column));
        if (!entries.length || typeof row.id !== "string") continue;
        const names = entries.map(([column]) => quoteIdentifier(column));
        const placeholders = entries.map(() => "?").join(", ");
        const updates = entries
          .map(([column]) => column)
          .filter((column) => column !== "id")
          .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
          .join(", ");
        const sql = `INSERT INTO ${quoteIdentifier(table)} (${names.join(", ")}) VALUES (${placeholders})` +
          (updates ? ` ON CONFLICT(${quoteIdentifier("id")}) DO UPDATE SET ${updates}` : ' ON CONFLICT("id") DO NOTHING');
        try {
          db.prepare(sql).run(...entries.map(([, value]) => sqliteValue(value)));
        } catch (error) {
          throw new Error(`${table}/${row.id} 写入临时库失败：${messageOf(error)}`);
        }
      }
    }
    db.exec("PRAGMA foreign_keys=ON;");
  } finally {
    db.close();
  }
}

async function executeJob(databasePath: string, task: RunnerInput): Promise<void> {
  // 必须在设置 DATABASE_URL 后再加载本地 Prisma 模块，否则会误连本机默认数据库。
  process.env.DATABASE_URL = pathToFileURL(databasePath).toString();
  process.env.DIRECTOR_RUNNER_TASK = "1";
  process.chdir(process.cwd());

  const { ensureSqlitePragmas, prisma } = await import("../lib/prisma");
  await ensureSqlitePragmas();
  try {
    const payload = task.job.payload;
    if (task.job.kind === "project_foundation") {
      const { executeProjectFoundation } = await import("../lib/project-foundation");
      const stage = typeof payload.stage === "string" ? payload.stage : undefined;
      await executeProjectFoundation(task.job.projectId, required(String(payload.batchToken ?? ""), "基础工程任务缺少批次标识。"), {
        singleStage: stage as "P1" | "P2" | undefined,
      });
    } else {
      const { prepareEpisodeProduction } = await import("../lib/workflow");
      const { executeEpisodePipeline } = await import("../lib/episode-pipeline");
      const episodeId = required(String(payload.episodeId ?? ""), "单集任务缺少集标识。");
      const batchToken = required(String(payload.batchToken ?? ""), "单集任务缺少批次标识。");
      if (payload.prepareEpisode === true) await prepareEpisodeProduction(task.job.projectId, episodeId);
      const stage = typeof payload.stage === "string" ? payload.stage : undefined;
      const stages = Array.isArray(payload.stages) ? payload.stages.map(String) : undefined;
      await executeEpisodePipeline(task.job.projectId, episodeId, batchToken, {
        singleStage: stage as never,
        stages: stages as never,
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}

function readResultTables(databasePath: string, task: RunnerInput): TableRows {
  const db = new DatabaseSync(databasePath);
  try {
    const result: TableRows = {};
    for (const table of task.writeScope.tables) {
      result[table] = queryScopedTable(db, table, task.writeScope);
    }
    return result;
  } finally {
    db.close();
  }
}

function queryScopedTable(
  db: DatabaseSync,
  table: string,
  scope: RunnerInput["writeScope"],
): Row[] {
  const projectId = scope.projectId;
  const episodeId = scope.episodeId ?? null;
  const queries: Record<string, { sql: string; values: SqliteValue[] }> = {
    Asset: { sql: `SELECT * FROM "Asset" WHERE "projectId" = ?`, values: [projectId] },
    CliRoleSession: scope.kind === "foundation"
      ? { sql: `SELECT * FROM "CliRoleSession" WHERE "projectId" = ? AND "episodeId" = ''`, values: [projectId] }
      : { sql: `SELECT * FROM "CliRoleSession" WHERE "projectId" = ? AND "episodeId" = ?`, values: [projectId, episodeId] },
    CompiledPromptVersion: { sql: `SELECT v.* FROM "CompiledPromptVersion" v INNER JOIN "SeedanceUnit" u ON u."id" = v."unitId" WHERE u."episodeId" = ?`, values: [episodeId] },
    PipelineRun: scope.kind === "foundation"
      ? { sql: `SELECT * FROM "PipelineRun" WHERE "projectId" = ? AND "episodeId" IS NULL`, values: [projectId] }
      : { sql: `SELECT * FROM "PipelineRun" WHERE "projectId" = ? AND "episodeId" = ?`, values: [projectId, episodeId] },
    PresentationContract: { sql: `SELECT * FROM "PresentationContract" WHERE "projectId" = ?`, values: [projectId] },
    SceneSnapshot: scope.kind === "foundation"
      ? { sql: `SELECT * FROM "SceneSnapshot" WHERE "projectId" = ? AND "episodeId" IS NULL`, values: [projectId] }
      : { sql: `SELECT * FROM "SceneSnapshot" WHERE "projectId" = ? AND "episodeId" = ?`, values: [projectId, episodeId] },
    ScriptScene: scope.kind === "foundation"
      ? { sql: `SELECT s.* FROM "ScriptScene" s INNER JOIN "Episode" e ON e."id" = s."episodeId" WHERE e."projectId" = ?`, values: [projectId] }
      : { sql: `SELECT * FROM "ScriptScene" WHERE "episodeId" = ?`, values: [episodeId] },
    SeedanceUnit: { sql: `SELECT * FROM "SeedanceUnit" WHERE "episodeId" = ?`, values: [episodeId] },
    SeedanceUnitShot: { sql: `SELECT l.* FROM "SeedanceUnitShot" l INNER JOIN "SeedanceUnit" u ON u."id" = l."unitId" WHERE u."episodeId" = ?`, values: [episodeId] },
    StoryboardShot: { sql: `SELECT * FROM "StoryboardShot" WHERE "episodeId" = ?`, values: [episodeId] },
    TaskPackage: { sql: `SELECT * FROM "TaskPackage" WHERE "projectId" = ? AND "episodeId" = ?`, values: [projectId, episodeId] },
    WorkflowIssue: { sql: `SELECT * FROM "WorkflowIssue" WHERE "projectId" = ? AND "episodeId" = ?`, values: [projectId, episodeId] },
  };
  const query = queries[table];
  if (!query) throw new Error(`未配置结果表范围：${table}`);
  return db.prepare(query.sql).all(...query.values) as Row[];
}

type SqliteValue = string | number | bigint | Uint8Array | null;

function buildDeletions(before: TableRows, after: TableRows, tables: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const table of tables) {
    const afterIds = new Set((after[table] ?? []).map((row) => String(row.id)));
    result[table] = (before[table] ?? [])
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && !afterIds.has(id));
  }
  return result;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function sqliteValue(value: unknown): string | number | bigint | Uint8Array | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

function parseArgs(values: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    if (key && value) result[key] = value;
  }
  return result;
}

function required(value: string, message: string): string {
  if (!value.trim()) throw new Error(message);
  return value.trim();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

function runProcess(
  command: string,
  commandArgs: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("临时数据库初始化超时。"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout = tail(stdout + chunk, 20_000); });
    child.stderr.on("data", (chunk) => { stderr = tail(stderr + chunk, 20_000); });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(tail(stderr || stdout || `本地命令退出码：${code}`, 20_000)));
    });
  });
}

function tail(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(-maxLength) : value;
}
