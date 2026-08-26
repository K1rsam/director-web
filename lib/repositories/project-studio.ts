import { cleanEpisodeTitle } from "../import-script.ts";

const ROLE_STAGES = [
  ["E0", "叙事节奏"],
  ["E1", "结构导演"],
  ["E2", "表演调度"],
  ["E3", "单元视听"],
  ["E4", "摄影光影"],
  ["E5", "审查总控"],
] as const;

type ProjectRow = {
  id: string;
  title: string;
  description: string | null;
  style: string | null;
  aspectRatio: string;
  executionMode: string;
  updatedAt: number;
};

type AssetRow = {
  id: string;
  code: string;
  type: string;
  name: string;
  status: string;
  episodeId: string | null;
  parentId: string | null;
  metadata: string | null;
};

type SnapshotRow = { sceneKey: string; content: string; createdAt: number };

type EpisodeRow = {
  id: string;
  number: number;
  title: string | null;
  content: string;
  shotCount: number;
  unitCount: number;
  issueCount: number;
  taskPackageCount: number;
};

type SceneRow = {
  id: string;
  episodeId: string;
  sceneKey: string;
  sortOrder: number;
  heading: string | null;
  location: string | null;
  interiorExterior: string | null;
  timeOfDay: string | null;
  weather: string | null;
  timeLayer: string;
  sourceText: string;
  metadata: string;
};

type RunRow = {
  id: string;
  episodeId: string | null;
  stageCode: string;
  roleName: string;
  status: string;
  model: string | null;
  durationMs: number | null;
  createdAt: number;
  error: string | null;
};

type ContractRow = {
  id: string;
  category: string;
  question: string;
  options: string;
  evidence: string | null;
  userAnswer: string | null;
  status: string;
  round: number;
  decidedAt: number | null;
};

export async function getProjectStudio(projectId: string, userId: string, db: D1Database) {
  const project = await db
    .prepare(
      `SELECT p."id", p."title", p."description", p."style", p."aspectRatio", p."executionMode", p."updatedAt"
       FROM "Project" AS p
       WHERE p."id" = ? AND EXISTS (
         SELECT 1 FROM "ProjectRole" pr WHERE pr."projectId" = p."id" AND pr."userId" = ?
       ) LIMIT 1`,
    )
    .bind(projectId, userId)
    .first<ProjectRow>();
  if (!project) return null;

  const [assetResult, snapshotResult, episodeResult, sceneResult, runResult] = await Promise.all([
    db
      .prepare(`SELECT * FROM "Asset" WHERE "projectId" = ? ORDER BY "type", "code"`)
      .bind(projectId)
      .all<AssetRow>(),
    db
      .prepare(`SELECT "sceneKey", "content", "createdAt" FROM "SceneSnapshot" WHERE "projectId" = ? ORDER BY "createdAt" DESC`)
      .bind(projectId)
      .all<SnapshotRow>(),
    db
      .prepare(
        `SELECT e."id", e."number", e."title", e."content",
                (SELECT COUNT(*) FROM "StoryboardShot" s WHERE s."episodeId" = e."id") AS "shotCount",
                (SELECT COUNT(*) FROM "SeedanceUnit" u WHERE u."episodeId" = e."id") AS "unitCount",
                (SELECT COUNT(*) FROM "WorkflowIssue" i WHERE i."episodeId" = e."id") AS "issueCount",
                (SELECT COUNT(*) FROM "TaskPackage" t WHERE t."episodeId" = e."id") AS "taskPackageCount"
         FROM "Episode" AS e WHERE e."projectId" = ? ORDER BY e."number"`,
      )
      .bind(projectId)
      .all<EpisodeRow>(),
    db
      .prepare(
        `SELECT s.* FROM "ScriptScene" AS s
         INNER JOIN "Episode" AS e ON e."id" = s."episodeId"
         WHERE e."projectId" = ? ORDER BY e."number", s."sortOrder"`,
      )
      .bind(projectId)
      .all<SceneRow>(),
    db
      .prepare(
        `SELECT "id", "episodeId", "stageCode", "roleName", "status", "model", "durationMs", "createdAt", "error"
         FROM "PipelineRun" WHERE "projectId" = ? ORDER BY "createdAt" DESC LIMIT 500`,
      )
      .bind(projectId)
      .all<RunRow>(),
  ]);

  const memory = snapshotResult.results.find((snapshot) => snapshot.sceneKey === "PROJECT_MEMORY");
  return {
    project: {
      id: project.id,
      title: project.title,
      description: project.description ?? "暂无项目简介",
      style: project.style ?? "未选择",
      aspectRatio: project.aspectRatio,
      executionMode: project.executionMode,
      updatedAt: new Date(Number(project.updatedAt)),
    },
    firstPhase: {
      planningReady: Boolean(memory),
      assetsReady: assetResult.results.length > 0,
      sceneCount: sceneResult.results.length,
      memory: memory?.content ?? "尚未生成项目策划与全剧索引。",
    },
    assets: assetResult.results.map((asset) => ({
      id: asset.id,
      code: asset.code,
      type: asset.type,
      name: asset.name,
      status: asset.status,
      episodeId: asset.episodeId,
      parentId: asset.parentId,
      role: stringValue(parseJsonRecord(asset.metadata).role),
    })),
    episodes: episodeResult.results.map((episode) => ({
      id: episode.id,
      number: Number(episode.number),
      title: cleanEpisodeTitle(episode.title, Number(episode.number)),
      contentPreview: compactText(episode.content, 120),
      scenes: sceneResult.results.filter((scene) => scene.episodeId === episode.id),
      shotCount: Number(episode.shotCount),
      unitCount: Number(episode.unitCount),
      openIssueCount: Number(episode.issueCount),
      taskPackageCount: Number(episode.taskPackageCount),
      roles: buildRoleProgress(runResult.results.filter((run) => run.episodeId === episode.id)),
    })),
    projectRuns: runResult.results
      .filter((run) => run.episodeId == null)
      .map((run) => ({
        id: run.id,
        stageCode: run.stageCode,
        roleName: run.roleName,
        status: displayRunStatus(run.status),
        model: run.model ?? "默认模型",
        duration: displayDuration(run.durationMs),
        createdAt: new Date(Number(run.createdAt)),
        error: run.error,
      })),
  };
}

export async function listPresentationContracts(db: D1Database, projectId: string) {
  const result = await db
    .prepare(
      `SELECT "id", "category", "question", "options", "evidence", "userAnswer", "status", "round", "decidedAt"
       FROM "PresentationContract" WHERE "projectId" = ? AND "status" IN ('PENDING', 'CONFIRMED')
       ORDER BY "createdAt" ASC`,
    )
    .bind(projectId)
    .all<ContractRow>();
  const rows = result.results.map((contract) => ({
    id: contract.id,
    category: contract.category,
    question: contract.question,
    options: parseStringList(contract.options),
    evidence: contract.evidence,
    userAnswer: contract.userAnswer,
    episodeNumber: null,
    round: Number(contract.round),
    decidedAt: contract.decidedAt == null ? null : new Date(Number(contract.decidedAt)),
    status: contract.status,
  }));
  return {
    pending: rows.filter((contract) => contract.status === "PENDING"),
    confirmed: rows.filter((contract) => contract.status === "CONFIRMED"),
  };
}

export async function confirmAllAssets(db: D1Database, projectId: string): Promise<void> {
  await db
    .prepare(`UPDATE "Asset" SET "status" = 'confirmed' WHERE "projectId" = ? AND "status" = 'needs_confirmation'`)
    .bind(projectId)
    .run();
}

export async function decidePresentationContract(
  db: D1Database,
  projectId: string,
  contractId: string,
  answer: string,
  now = new Date(),
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE "PresentationContract"
       SET "userAnswer" = ?, "status" = 'CONFIRMED', "decidedAt" = ?, "updatedAt" = ?
       WHERE "id" = ? AND "projectId" = ?`,
    )
    .bind(answer, now.getTime(), now.getTime(), contractId, projectId)
    .run();
  if (!result.meta.changes) throw new Error("表现规范不存在。");
}

export async function skipPresentationContract(
  db: D1Database,
  projectId: string,
  contractId: string,
  now = new Date(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE "PresentationContract" SET "status" = 'SKIPPED', "decidedAt" = ?, "updatedAt" = ?
       WHERE "id" = ? AND "projectId" = ?`,
    )
    .bind(now.getTime(), now.getTime(), contractId, projectId)
    .run();
}

function buildRoleProgress(runs: RunRow[]) {
  const latestByStage = new Map<string, RunRow>();
  for (const run of [...runs].sort((left, right) => Number(right.createdAt) - Number(left.createdAt))) {
    if (!latestByStage.has(run.stageCode)) latestByStage.set(run.stageCode, run);
  }
  return ROLE_STAGES.map(([code, name]) => {
    const run = latestByStage.get(code);
    return run
      ? {
          code,
          name,
          status: displayRunStatus(run.status),
          model: run.model ?? "默认模型",
          duration: displayDuration(run.durationMs),
        }
      : { code, name, status: "未开始" as const, model: "默认模型", duration: "—" };
  });
}

function displayRunStatus(status: string): "未开始" | "排队中" | "进行中" | "已完成" | "失败" {
  if (status === "RUNNING") return "进行中";
  if (status === "SUCCEEDED") return "已完成";
  if (status === "FAILED" || status === "CANCELED") return "失败";
  return "排队中";
}

function displayDuration(durationMs: number | null): string {
  if (durationMs == null) return "—";
  if (Number(durationMs) < 60_000) return `${(Number(durationMs) / 1000).toFixed(1)}秒`;
  return `${Math.floor(Number(durationMs) / 60_000)}分${Math.round((Number(durationMs) % 60_000) / 1000)}秒`;
}

function compactText(value: string, maxLength: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStringList(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
