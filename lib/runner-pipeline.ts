import { and, eq } from "drizzle-orm";

import { getDb, getD1 } from "@/db";
import { ensureControlPlaneSchema } from "@/db/ensure-schema";
import { runnerJobs } from "@/db/schema";
import { hashRunnerToken } from "@/lib/runner-auth";
import type { RunnerIdentity } from "@/lib/runner-ownership";
import { contractAppliesToEpisode } from "@/lib/presentation-contracts";

export const RUNNER_PROTOCOL_VERSION = 1;
export const RUNNER_INPUT_ORIGIN = "sites-d1" as const;

const FOUNDATION_STAGES = [
  { code: "P1", name: "全剧基础策划", model: "gpt-5.6-terra" },
  { code: "P2", name: "全剧资产拆解", model: "gpt-5.6-terra" },
] as const;

const EPISODE_STAGES = [
  { code: "E0", name: "叙事节奏", model: "gpt-5.6-terra" },
  { code: "E1", name: "结构导演", model: "gpt-5.6-terra" },
  { code: "E2", name: "表演调度", model: "gpt-5.6-terra" },
  { code: "E3", name: "单元视听", model: "gpt-5.6-terra" },
  { code: "E4", name: "摄影光影", model: "gpt-5.6-terra" },
  { code: "E5", name: "审查总控", model: "gpt-5.6-sol" },
] as const;

const FOUNDATION_RESULT_TABLES = [
  "Asset",
  "CliRoleSession",
  "PipelineRun",
  "PresentationContract",
  "SceneSnapshot",
  "ScriptScene",
] as const;

const EPISODE_RESULT_TABLES = [
  "CliRoleSession",
  "CompiledPromptVersion",
  "PipelineRun",
  "SceneSnapshot",
  "ScriptScene",
  "SeedanceUnit",
  "SeedanceUnitShot",
  "StoryboardShot",
  "TaskPackage",
  "WorkflowIssue",
] as const;

type PipelineKind = "project_foundation" | "episode_pipeline";
type FoundationStageCode = (typeof FOUNDATION_STAGES)[number]["code"];
type EpisodeStageCode = (typeof EPISODE_STAGES)[number]["code"];
type Row = Record<string, unknown>;
type TableRows = Record<string, Row[]>;

type RunnerWriteScope = {
  kind: "foundation" | "episode";
  projectId: string;
  episodeId?: string;
  tables: string[];
};

type RunnerJobPayload = {
  protocolVersion?: number;
  projectId?: string;
  episodeId?: string;
  batchToken?: string;
  stage?: string;
  stages?: string[];
  prepareEpisode?: boolean;
  singleStage?: boolean;
  repairPipeline?: boolean;
  includeSuggestions?: boolean;
  structuralRebuild?: boolean;
  openBlockers?: number;
  openMajors?: number;
  openBlockerCoords?: string[];
  openBlockerKeys?: string[];
  openIssueKeys?: string[];
  openCoords?: string[];
};

type RunnerJobRecord = {
  id: string;
  projectId: string;
  kind: PipelineKind | "smoke" | "codex_prompt";
  payload: RunnerJobPayload;
  attempt: number;
};

type RunnerJobResult = {
  protocolVersion: number;
  inputOrigin: typeof RUNNER_INPUT_ORIGIN;
  jobId: string;
  projectId: string;
  writeScope: RunnerWriteScope;
  tables: TableRows;
  deletions?: Record<string, string[]>;
  meta?: Record<string, unknown>;
};

export async function enqueueProjectFoundation(
  projectId: string,
  ownerUserId: string,
  stage?: FoundationStageCode,
): Promise<{ jobId: string; batchToken: string }> {
  const db = getD1();
  await ensureControlPlaneSchema();
  await assertCliProject(db, projectId);
  await assertProjectIdle(db, projectId);

  const stages = stage ? FOUNDATION_STAGES.filter((item) => item.code === stage) : FOUNDATION_STAGES;
  const batchToken = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const scope = foundationScope(projectId);
  const timestamp = Date.now();
  const payload: RunnerJobPayload = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    projectId,
    batchToken,
    ...(stage ? { stage, singleStage: true } : {}),
  };
  const runStatements = stages.map((item) => db.prepare(
    `INSERT INTO "PipelineRun"
      ("id", "projectId", "episodeId", "stageCode", "roleName", "provider", "model", "status", "inputSummary", "createdAt")
     VALUES (?, ?, NULL, ?, ?, 'Codex CLI', ?, 'QUEUED', ?, ?)`,
  ).bind(
    crypto.randomUUID(),
    projectId,
    item.code,
    item.name,
    item.model,
    JSON.stringify({
      batchToken,
      provider: "CLI",
      foundation: true,
      ...(stage ? { singleStage: true } : {}),
      runnerJobId: jobId,
      writeScope: scope,
    }),
    timestamp,
  ));
  runStatements.push(db.prepare(
    `INSERT INTO runner_jobs
      ("id", "project_id", "owner_user_id", "kind", "payload", "status", "attempt", "created_at", "updated_at")
     VALUES (?, ?, ?, 'project_foundation', ?, 'queued', 0, ?, ?)`,
  ).bind(jobId, projectId, ownerUserId, JSON.stringify(payload), timestamp, timestamp));
  await db.batch(runStatements);
  return { jobId, batchToken };
}

export async function enqueueEpisodePipeline(
  projectId: string,
  episodeId: string,
  ownerUserId: string,
  options: {
    stage?: EpisodeStageCode;
    stages?: EpisodeStageCode[];
    repairPipeline?: boolean;
    includeSuggestions?: boolean;
  } = {},
): Promise<{ jobId: string; batchToken: string; stages: EpisodeStageCode[] }> {
  const db = getD1();
  await ensureControlPlaneSchema();
  await assertCliProject(db, projectId);
  await assertEpisode(db, projectId, episodeId);
  await assertEpisodeIdle(db, projectId, episodeId);

  const stages = options.stage
    ? EPISODE_STAGES.filter((item) => item.code === options.stage).map((item) => item.code)
    : options.stages?.length
      ? [...new Set(options.stages)]
      : EPISODE_STAGES.map((item) => item.code);
  if (!stages.length) throw new Error("没有可执行的单集岗位。");

  const batchToken = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const scope = episodeScope(projectId, episodeId);
  const timestamp = Date.now();
  const payload: RunnerJobPayload = {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    projectId,
    episodeId,
    batchToken,
    ...(options.stage ? { stage: options.stage, singleStage: true } : {}),
    ...(options.stages?.length ? { stages: [...new Set(options.stages)] } : {}),
    prepareEpisode: !options.repairPipeline || stages.includes("E1"),
    ...(options.repairPipeline ? { repairPipeline: true, includeSuggestions: options.includeSuggestions === true } : {}),
  };
  const stageByCode = new Map(EPISODE_STAGES.map((item) => [item.code, item]));
  const runStatements = stages.map((code) => {
    const stage = stageByCode.get(code);
    if (!stage) throw new Error(`未知单集岗位：${code}`);
    return db.prepare(
      `INSERT INTO "PipelineRun"
        ("id", "projectId", "episodeId", "stageCode", "roleName", "provider", "model", "status", "inputSummary", "createdAt")
       VALUES (?, ?, ?, ?, ?, 'Codex CLI', ?, 'QUEUED', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      projectId,
      episodeId,
      stage.code,
      stage.name,
      stage.model,
      JSON.stringify({
        batchToken,
        provider: "CLI",
        ...(options.stage ? { singleStage: true } : {}),
        ...(options.repairPipeline ? { repairPipeline: true, includeSuggestions: options.includeSuggestions === true } : {}),
        runnerJobId: jobId,
        writeScope: scope,
      }),
      timestamp,
    );
  });
  runStatements.push(db.prepare(
    `INSERT INTO runner_jobs
      ("id", "project_id", "owner_user_id", "kind", "payload", "status", "attempt", "created_at", "updated_at")
     VALUES (?, ?, ?, 'episode_pipeline', ?, 'queued', 0, ?, ?)`,
  ).bind(jobId, projectId, ownerUserId, JSON.stringify(payload), timestamp, timestamp));
  await db.batch(runStatements);
  return { jobId, batchToken, stages };
}

export async function buildRunnerJobInput(
  identity: RunnerIdentity,
  jobId: string,
  leaseToken: string,
) {
  const db = getD1();
  const leaseHash = await hashRunnerToken(leaseToken);
  const job = await getDb()
    .select({ id: runnerJobs.id, projectId: runnerJobs.projectId, kind: runnerJobs.kind, payload: runnerJobs.payload, attempt: runnerJobs.attempt })
    .from(runnerJobs)
    .where(and(
      eq(runnerJobs.id, jobId),
      eq(runnerJobs.ownerUserId, identity.ownerUserId),
      eq(runnerJobs.status, "running"),
      eq(runnerJobs.leaseTokenHash, leaseHash),
    ))
    .limit(1);
  const record = job[0];
  if (!record || (record.kind !== "project_foundation" && record.kind !== "episode_pipeline")) return null;
  const payload = parsePayload(record.payload);
  if (!payload || payload.projectId !== record.projectId) throw new Error("Runner 任务参数无效。");
  const writeScope = record.kind === "project_foundation"
    ? foundationScope(record.projectId)
    : episodeScope(record.projectId, required(payload.episodeId, "单集任务缺少集标识。"));
  const tables = await readInputTables(db, record.kind, record.projectId, payload.episodeId);
  return {
    protocolVersion: RUNNER_PROTOCOL_VERSION,
    inputOrigin: RUNNER_INPUT_ORIGIN,
    job: {
      id: record.id,
      projectId: record.projectId,
      kind: record.kind,
      payload,
      attempt: Number(record.attempt),
    },
    writeScope,
    tables,
  };
}

export async function applyRunnerResult(
  job: RunnerJobRecord,
  result: unknown,
  status: "succeeded" | "failed",
  error: string | null,
): Promise<void> {
  if (job.kind !== "project_foundation" && job.kind !== "episode_pipeline") return;
  const parsed = parseRunnerResult(result);
  if (parsed) {
    await validateRunnerResult(job, parsed);
    await writeRunnerDelta(parsed);
  }
  if (status === "failed") {
    await markPipelineRunsFailed(job, error ?? String(parsed?.meta?.executionError ?? "Runner 执行失败。"));
  }
}

export async function markPipelineRunsFailed(job: RunnerJobRecord, reason: string): Promise<void> {
  if (job.kind !== "project_foundation" && job.kind !== "episode_pipeline") return;
  const payload = job.payload;
  if (!payload.batchToken) return;
  const db = getD1();
  const now = Date.now();
  const scope = job.kind === "project_foundation"
    ? `"projectId" = ? AND "episodeId" IS NULL`
    : `"projectId" = ? AND "episodeId" = ?`;
  const values = job.kind === "project_foundation"
    ? [job.projectId, `%${payload.batchToken}%`, now, reason]
    : [job.projectId, payload.episodeId, `%${payload.batchToken}%`, now, reason];
  await db.prepare(
    `UPDATE "PipelineRun"
     SET "status" = 'FAILED', "finishedAt" = ?, "error" = ?
     WHERE ${scope} AND "inputSummary" LIKE ? AND "status" IN ('QUEUED', 'RUNNING')`,
  ).bind(...reorderFailureValues(job.kind, values)).run();
}

async function readInputTables(
  db: D1Database,
  kind: PipelineKind,
  projectId: string,
  episodeId?: string,
): Promise<TableRows> {
  const project = await db.prepare(`SELECT * FROM "Project" WHERE "id" = ? LIMIT 1`).bind(projectId).first<Row>();
  if (!project) throw new Error("线上项目不存在。");
  const episodesResult = await db.prepare(`SELECT * FROM "Episode" WHERE "projectId" = ? ORDER BY "number"`).bind(projectId).all<Row>();
  const episodes = kind === "episode_pipeline" && episodeId
    ? episodesResult.results.map((row) => row.id === episodeId ? row : { ...row, content: "" })
    : episodesResult.results;
  const tables: TableRows = { Project: [project], Episode: episodes };

  if (kind === "project_foundation") {
    tables.ScriptScene = (await db.prepare(
      `SELECT s.* FROM "ScriptScene" s INNER JOIN "Episode" e ON e."id" = s."episodeId"
       WHERE e."projectId" = ? ORDER BY e."number", s."sortOrder"`,
    ).bind(projectId).all<Row>()).results;
    tables.Asset = (await db.prepare(`SELECT * FROM "Asset" WHERE "projectId" = ? ORDER BY "type", "code"`).bind(projectId).all<Row>()).results;
    tables.SceneSnapshot = (await db.prepare(`SELECT * FROM "SceneSnapshot" WHERE "projectId" = ? AND "episodeId" IS NULL`).bind(projectId).all<Row>()).results;
    tables.PresentationContract = (await db.prepare(`SELECT * FROM "PresentationContract" WHERE "projectId" = ? ORDER BY "createdAt"`).bind(projectId).all<Row>()).results;
    tables.PipelineRun = (await db.prepare(`SELECT * FROM "PipelineRun" WHERE "projectId" = ? AND "episodeId" IS NULL`).bind(projectId).all<Row>()).results;
    tables.CliRoleSession = (await db.prepare(`SELECT * FROM "CliRoleSession" WHERE "projectId" = ? AND "episodeId" = ''`).bind(projectId).all<Row>()).results;
    return tables;
  }

  const targetEpisodeId = required(episodeId, "单集任务缺少集标识。");
  const targetEpisode = episodesResult.results.find((row) => String(row.id) === targetEpisodeId);
  if (!targetEpisode) throw new Error("线上单集不存在。");
  const episodeNumberById = new Map(
    episodesResult.results.map((row) => [String(row.id), Number(row.number)]),
  );
  const formalEpisodeNumbers = episodesResult.results
    .map((row) => Number(row.number))
    .filter((number) => Number.isInteger(number) && number >= 1);
  tables.Asset = (await db.prepare(`SELECT * FROM "Asset" WHERE "projectId" = ? ORDER BY "type", "code"`).bind(projectId).all<Row>()).results;
  const confirmedContracts = (await db.prepare(
    `SELECT * FROM "PresentationContract" WHERE "projectId" = ? AND "status" = 'CONFIRMED' ORDER BY "createdAt"`,
  ).bind(projectId).all<Row>()).results;
  tables.PresentationContract = confirmedContracts.filter((contract) => contractAppliesToEpisode({
    scope_mode: typeof contract.scopeMode === "string" ? contract.scopeMode : null,
    target_episode_numbers: typeof contract.targetEpisodeNumbers === "string" || Array.isArray(contract.targetEpisodeNumbers)
      ? contract.targetEpisodeNumbers as string | number[]
      : null,
    source_episode_number: contract.episodeId ? episodeNumberById.get(String(contract.episodeId)) ?? null : null,
  }, Number(targetEpisode.number), formalEpisodeNumbers));
  tables.ScriptScene = (await db.prepare(`SELECT * FROM "ScriptScene" WHERE "episodeId" = ? ORDER BY "sortOrder"`).bind(targetEpisodeId).all<Row>()).results;
  tables.SceneSnapshot = (await db.prepare(
    `SELECT * FROM "SceneSnapshot" WHERE "projectId" = ? AND ("episodeId" = ? OR ("episodeId" IS NULL AND "sceneKey" = 'PROJECT_MEMORY'))`,
  ).bind(projectId, targetEpisodeId).all<Row>()).results;
  tables.TaskPackage = (await db.prepare(`SELECT * FROM "TaskPackage" WHERE "projectId" = ? AND "episodeId" = ?`).bind(projectId, targetEpisodeId).all<Row>()).results;
  tables.StoryboardShot = (await db.prepare(`SELECT * FROM "StoryboardShot" WHERE "episodeId" = ?`).bind(targetEpisodeId).all<Row>()).results;
  tables.SeedanceUnit = (await db.prepare(`SELECT * FROM "SeedanceUnit" WHERE "episodeId" = ?`).bind(targetEpisodeId).all<Row>()).results;
  tables.SeedanceUnitShot = (await db.prepare(
    `SELECT l.* FROM "SeedanceUnitShot" l INNER JOIN "SeedanceUnit" u ON u."id" = l."unitId" WHERE u."episodeId" = ?`,
  ).bind(targetEpisodeId).all<Row>()).results;
  tables.CompiledPromptVersion = (await db.prepare(
    `SELECT v.* FROM "CompiledPromptVersion" v INNER JOIN "SeedanceUnit" u ON u."id" = v."unitId" WHERE u."episodeId" = ?`,
  ).bind(targetEpisodeId).all<Row>()).results;
  tables.WorkflowIssue = (await db.prepare(`SELECT * FROM "WorkflowIssue" WHERE "projectId" = ? AND "episodeId" = ?`).bind(projectId, targetEpisodeId).all<Row>()).results;
  tables.CliRoleSession = (await db.prepare(`SELECT * FROM "CliRoleSession" WHERE "projectId" = ? AND "episodeId" = ?`).bind(projectId, targetEpisodeId).all<Row>()).results;
  tables.PipelineRun = (await db.prepare(`SELECT * FROM "PipelineRun" WHERE "projectId" = ? AND "episodeId" = ?`).bind(projectId, targetEpisodeId).all<Row>()).results;
  return tables;
}

async function validateRunnerResult(job: RunnerJobRecord, result: RunnerJobResult): Promise<void> {
  const expected = job.kind === "project_foundation" ? foundationScope(job.projectId) : episodeScope(job.projectId, required(job.payload.episodeId, "单集任务缺少集标识。"));
  if (result.protocolVersion !== RUNNER_PROTOCOL_VERSION) throw new Error("Runner 返回的协议版本不匹配，请更新本地执行代码。");
  if (result.inputOrigin !== RUNNER_INPUT_ORIGIN) throw new Error("Runner 返回结果不是基于 Sites D1 任务快照生成的。");
  if (result.jobId !== job.id || result.projectId !== job.projectId) throw new Error("Runner 返回结果与当前任务不一致。");
  if (result.writeScope.kind !== expected.kind || result.writeScope.projectId !== expected.projectId || result.writeScope.episodeId !== expected.episodeId) {
    throw new Error("Runner 返回结果超出了本次任务范围。");
  }
  const allowed = new Set(expected.tables);
  for (const table of Object.keys(result.tables ?? {})) {
    if (!allowed.has(table)) throw new Error(`Runner 返回了未授权的表：${table}`);
    if (!Array.isArray(result.tables[table])) throw new Error(`Runner 返回的 ${table} 不是数组。`);
    if (result.tables[table].length > 50_000) throw new Error(`Runner 返回的 ${table} 行数过多。`);
  }
  const episodeIds = new Set(
    (await getD1().prepare(`SELECT "id" FROM "Episode" WHERE "projectId" = ?`).bind(job.projectId).all<{ id: string }>()).results.map((row) => row.id),
  );
  const targetEpisodeId = expected.episodeId;
  const units = new Set((result.tables.SeedanceUnit ?? []).map((row) => String(row.id)));
  const shots = new Set((result.tables.StoryboardShot ?? []).map((row) => String(row.id)));
  for (const [table, rows] of Object.entries(result.tables ?? {})) {
    for (const row of rows) {
      if (!row || typeof row.id !== "string" || row.id.length > 180) throw new Error(`${table} 存在无效记录 ID。`);
      if (row.projectId !== undefined && row.projectId !== job.projectId) throw new Error(`${table} 回写越过项目范围。`);
      if (row.episodeId !== undefined && row.episodeId !== null) {
        if (!episodeIds.has(String(row.episodeId))) throw new Error(`${table} 回写了不属于本项目的集。`);
        if (targetEpisodeId && ["TaskPackage", "ScriptScene", "SceneSnapshot", "StoryboardShot", "SeedanceUnit", "WorkflowIssue", "PipelineRun"].includes(table) && String(row.episodeId) !== targetEpisodeId) {
          throw new Error(`${table} 回写越过本集范围。`);
        }
      }
      if (job.kind === "project_foundation" && ["PipelineRun", "SceneSnapshot"].includes(table) && row.episodeId !== null && row.episodeId !== undefined) {
        throw new Error(`${table} 基础工程结果不应包含单集记录。`);
      }
      if (table === "ScriptScene" && !episodeIds.has(String(row.episodeId))) throw new Error("ScriptScene 回写了不属于本项目的集。");
      if (table === "SeedanceUnitShot") {
        if (row.unitId !== undefined && !units.has(String(row.unitId))) throw new Error("SeedanceUnitShot 回写了不属于本任务的单元。");
        if (row.shotId !== undefined && !shots.has(String(row.shotId))) throw new Error("SeedanceUnitShot 回写了不属于本任务的镜头。");
      }
      if (table === "CliRoleSession" && job.kind === "project_foundation" && String(row.episodeId ?? "") !== "") throw new Error("全剧岗位会话范围无效。");
    }
  }
  for (const [table, ids] of Object.entries(result.deletions ?? {})) {
    if (!allowed.has(table) || !Array.isArray(ids) || ids.some((id) => typeof id !== "string" || id.length > 180)) {
      throw new Error(`Runner 返回了无效的 ${table} 删除差异。`);
    }
  }
}

async function writeRunnerDelta(result: RunnerJobResult): Promise<void> {
  const db = getD1();
  const columnsCache = new Map<string, Set<string>>();
  const getColumns = async (table: string) => {
    const existing = columnsCache.get(table);
    if (existing) return existing;
    const info = await db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all<{ name: string }>();
    const columns = new Set(info.results.map((row) => row.name));
    columnsCache.set(table, columns);
    return columns;
  };

  const deletions = result.deletions ?? {};
  const deleteOrder = [
    "WorkflowIssue",
    "CompiledPromptVersion",
    "SeedanceUnitShot",
    "SeedanceUnit",
    "StoryboardShot",
    "TaskPackage",
    "CliRoleSession",
    "SceneSnapshot",
    "ScriptScene",
    "Asset",
    "PresentationContract",
  ];
  const deleteStatements: D1PreparedStatement[] = [];
  for (const table of deleteOrder) {
    for (const id of deletions[table] ?? []) {
      deleteStatements.push(scopedDelete(db, table, id, result.writeScope));
    }
  }
  await runBatches(db, deleteStatements);

  const insertOrder = [
    "Asset",
    "ScriptScene",
    "PresentationContract",
    "SceneSnapshot",
    "TaskPackage",
    "StoryboardShot",
    "SeedanceUnit",
    "SeedanceUnitShot",
    "CompiledPromptVersion",
    "WorkflowIssue",
    "CliRoleSession",
    "PipelineRun",
  ];
  const insertStatements: D1PreparedStatement[] = [];
  for (const table of insertOrder) {
    const rows = result.tables[table] ?? [];
    const columns = await getColumns(table);
    for (const row of rows) {
      const entries = Object.entries(row).filter(([column]) => columns.has(column));
      if (!entries.length) continue;
      const names = entries.map(([column]) => quoteIdentifier(column));
      const updates = entries
        .map(([column]) => column)
        .filter((column) => column !== "id")
        .map((column) => `${quoteIdentifier(column)} = excluded.${quoteIdentifier(column)}`)
        .join(", ");
      const statement = `INSERT INTO ${quoteIdentifier(table)} (${names.join(", ")}) VALUES (${entries.map(() => "?").join(", ")})` +
        (updates ? ` ON CONFLICT(${quoteIdentifier("id")}) DO UPDATE SET ${updates}` : " ON CONFLICT(\"id\") DO NOTHING");
      insertStatements.push(db.prepare(statement).bind(...entries.map(([, value]) => sqlValue(value))));
    }
  }
  await runBatches(db, insertStatements);
}

function scopedDelete(db: D1Database, table: string, id: string, scope: RunnerWriteScope): D1PreparedStatement {
  const projectId = scope.projectId;
  const episodeId = scope.episodeId ?? null;
  const queries: Record<string, { sql: string; values: unknown[] }> = {
    Asset: { sql: `DELETE FROM "Asset" WHERE "id" = ? AND "projectId" = ?`, values: [id, projectId] },
    CliRoleSession: { sql: `DELETE FROM "CliRoleSession" WHERE "id" = ? AND "projectId" = ?`, values: [id, projectId] },
    CompiledPromptVersion: { sql: `DELETE FROM "CompiledPromptVersion" WHERE "id" = ? AND "unitId" IN (SELECT "id" FROM "SeedanceUnit" WHERE "episodeId" = ?)`, values: [id, episodeId] },
    PresentationContract: { sql: `DELETE FROM "PresentationContract" WHERE "id" = ? AND "projectId" = ?`, values: [id, projectId] },
    SceneSnapshot: scope.kind === "foundation"
      ? { sql: `DELETE FROM "SceneSnapshot" WHERE "id" = ? AND "projectId" = ? AND "episodeId" IS NULL`, values: [id, projectId] }
      : { sql: `DELETE FROM "SceneSnapshot" WHERE "id" = ? AND "projectId" = ? AND "episodeId" = ?`, values: [id, projectId, episodeId] },
    ScriptScene: scope.kind === "foundation"
      ? { sql: `DELETE FROM "ScriptScene" WHERE "id" = ? AND "episodeId" IN (SELECT "id" FROM "Episode" WHERE "projectId" = ?) AND NOT EXISTS (SELECT 1 FROM "StoryboardShot" WHERE "sceneId" = ?)`, values: [id, projectId, id] }
      : { sql: `DELETE FROM "ScriptScene" WHERE "id" = ? AND "episodeId" = ? AND NOT EXISTS (SELECT 1 FROM "StoryboardShot" WHERE "sceneId" = ?)`, values: [id, episodeId, id] },
    SeedanceUnit: { sql: `DELETE FROM "SeedanceUnit" WHERE "id" = ? AND "episodeId" = ?`, values: [id, episodeId] },
    SeedanceUnitShot: { sql: `DELETE FROM "SeedanceUnitShot" WHERE "id" = ? AND "unitId" IN (SELECT "id" FROM "SeedanceUnit" WHERE "episodeId" = ?)`, values: [id, episodeId] },
    StoryboardShot: { sql: `DELETE FROM "StoryboardShot" WHERE "id" = ? AND "episodeId" = ?`, values: [id, episodeId] },
    TaskPackage: { sql: `DELETE FROM "TaskPackage" WHERE "id" = ? AND "projectId" = ? AND "episodeId" = ?`, values: [id, projectId, episodeId] },
    WorkflowIssue: { sql: `DELETE FROM "WorkflowIssue" WHERE "id" = ? AND "projectId" = ? AND "episodeId" = ?`, values: [id, projectId, episodeId] },
  };
  const query = queries[table];
  if (!query) throw new Error(`未配置删除范围：${table}`);
  return db.prepare(query.sql).bind(...query.values);
}

async function runBatches(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let index = 0; index < statements.length; index += 40) {
    const batch = statements.slice(index, index + 40);
    if (batch.length) await db.batch(batch);
  }
}

function foundationScope(projectId: string): RunnerWriteScope {
  return { kind: "foundation", projectId, tables: [...FOUNDATION_RESULT_TABLES] };
}

function episodeScope(projectId: string, episodeId: string): RunnerWriteScope {
  return { kind: "episode", projectId, episodeId, tables: [...EPISODE_RESULT_TABLES] };
}

function assertProjectIdle(db: D1Database, projectId: string): Promise<void> {
  return db.prepare(`SELECT "id" FROM "PipelineRun" WHERE "projectId" = ? AND "status" IN ('QUEUED', 'RUNNING') LIMIT 1`).bind(projectId).first<{ id: string }>().then((row) => {
    if (row) throw new Error("项目已有任务正在执行，请等待 Runner 完成后再开始新的全剧任务。");
  });
}

function assertEpisodeIdle(db: D1Database, projectId: string, episodeId: string): Promise<void> {
  return db.prepare(`SELECT "id" FROM "PipelineRun" WHERE "projectId" = ? AND "episodeId" = ? AND "status" IN ('QUEUED', 'RUNNING') LIMIT 1`).bind(projectId, episodeId).first<{ id: string }>().then((row) => {
    if (row) throw new Error("本集已有任务正在执行，请等待 Runner 完成后再试。");
  });
}

async function assertCliProject(db: D1Database, projectId: string): Promise<void> {
  const project = await db.prepare(`SELECT "executionMode" FROM "Project" WHERE "id" = ? LIMIT 1`).bind(projectId).first<{ executionMode: string }>();
  if (!project) throw new Error("没有找到这个项目。");
  if (String(project.executionMode).toUpperCase() === "API") {
    throw new Error("当前项目执行方式是 API；本地 Runner 任务统一走 Codex CLI，请先把项目切换为 CLI。");
  }
}

async function assertEpisode(db: D1Database, projectId: string, episodeId: string): Promise<void> {
  const episode = await db.prepare(`SELECT "number" FROM "Episode" WHERE "id" = ? AND "projectId" = ? LIMIT 1`).bind(episodeId, projectId).first<{ number: number }>();
  if (!episode) throw new Error("没有找到这个剧集。");
  if (Number(episode.number) < 1) throw new Error("第0集/前置资料只用于全剧分析，不能执行单集 E0–E5。");
}

function parsePayload(value: string): RunnerJobPayload | null {
  try {
    const parsed = JSON.parse(value) as RunnerJobPayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function parseRunnerResult(value: unknown): RunnerJobResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = value as Partial<RunnerJobResult>;
  if (typeof parsed.protocolVersion !== "number" || parsed.inputOrigin !== RUNNER_INPUT_ORIGIN || typeof parsed.jobId !== "string" || typeof parsed.projectId !== "string") {
    throw new Error("Runner 返回结果格式无效。");
  }
  if (!parsed.writeScope || typeof parsed.writeScope !== "object" || !parsed.tables || typeof parsed.tables !== "object") {
    throw new Error("Runner 返回结果缺少写入范围。");
  }
  return parsed as RunnerJobResult;
}

function required(value: unknown, message: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(message);
  return text;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function sqlValue(value: unknown): string | number | bigint | Uint8Array | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "bigint") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  return JSON.stringify(value);
}

function reorderFailureValues(kind: PipelineKind, values: unknown[]): unknown[] {
  // UPDATE 的占位符顺序是 scope 参数、batchToken、finishedAt、error。
  if (kind === "project_foundation") {
    const [projectId, batchToken, now, reason] = values;
    return [now, reason, projectId, batchToken];
  }
  const [projectId, episodeId, batchToken, now, reason] = values;
  return [now, reason, projectId, episodeId, batchToken];
}
