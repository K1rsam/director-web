import { composeShotCells } from "../shot-cells.ts";
import { cleanEpisodeTitle } from "../import-script.ts";

const ROLE_STAGES = [
  ["E0", "叙事节奏"],
  ["E1", "结构导演"],
  ["E2", "表演调度"],
  ["E3", "单元视听"],
  ["E4", "摄影光影"],
  ["E5", "审查总控"],
] as const;

type EpisodeRow = {
  id: string;
  projectId: string;
  number: number;
  title: string | null;
  content: string;
  projectTitle: string;
  style: string | null;
  aspectRatio: string;
  executionMode: string;
};

type NavRow = { id: string; number: number; title: string | null; shotCount: number; unitCount: number };
type SceneRow = {
  id: string;
  sceneKey: string;
  sortOrder: number;
  heading: string | null;
  location: string | null;
  interiorExterior: string | null;
  timeOfDay: string | null;
  weather: string | null;
  timeLayer: string;
  sourceText: string;
};
type ShotRow = {
  id: string;
  sceneId: string;
  shotKey: string;
  sortOrder: number;
  duration: number;
  sourceNodeRefs: string;
  dialogue: string;
  e1Data: string;
  e2Data: string;
  e3Data: string;
  e4Data: string;
  revision: string;
};
type UnitRow = {
  id: string;
  sceneId: string;
  unitKey: string;
  sortOrder: number;
  duration: number;
  dominantGoal: string | null;
  startPremise: string;
  endState: string;
  data: string;
  revision: string;
};
type LinkRow = { unitId: string; shotId: string; shotKey: string; sortOrder: number };
type VersionRow = {
  id: string;
  unitId: string;
  version: number;
  content: string;
  syncStatus: string;
  selectedAt: number;
};
type IssueRow = {
  id: string;
  shotId: string | null;
  unitId: string | null;
  coordinate: string;
  code: string;
  severity: string;
  status: string;
  ownerRole: string;
  evidence: string;
  requestedEffect: string;
  createdAt: number;
};
type AssetRow = {
  code: string;
  type: string;
  name: string;
  status: string;
  episodeId: string | null;
  metadata: string | null;
};
type RunRow = {
  id: string;
  episodeId: string | null;
  stageCode: string;
  roleName: string;
  provider: string;
  model: string | null;
  status: string;
  inputSummary: string | null;
  outputSummary: string | null;
  log: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  createdAt: number;
};
type PackageRow = { payload: string | null; createdAt: number };

export async function getEpisodeStudio(
  projectId: string,
  episodeId: string,
  userId: string,
  db: D1Database,
) {
  const episode = await db
    .prepare(
      `SELECT e."id", e."projectId", e."number", e."title", e."content",
              p."title" AS "projectTitle", p."style", p."aspectRatio", p."executionMode"
       FROM "Episode" AS e
       INNER JOIN "Project" AS p ON p."id" = e."projectId"
       WHERE e."id" = ? AND e."projectId" = ? AND EXISTS (
         SELECT 1 FROM "ProjectRole" pr WHERE pr."projectId" = p."id" AND pr."userId" = ?
       ) LIMIT 1`,
    )
    .bind(episodeId, projectId, userId)
    .first<EpisodeRow>();
  if (!episode) return null;

  const [navResult, runResult, sceneResult, shotResult, unitResult, linkResult, versionResult, issueResult, assetResult, packageResult] = await Promise.all([
    db
      .prepare(
        `SELECT nav."id", nav."number", nav."title",
                (SELECT COUNT(*) FROM "StoryboardShot" sh WHERE sh."episodeId" = nav."id") AS "shotCount",
                (SELECT COUNT(*) FROM "SeedanceUnit" un WHERE un."episodeId" = nav."id") AS "unitCount"
         FROM "Episode" AS nav WHERE nav."projectId" = ? ORDER BY nav."number"`,
      )
      .bind(projectId)
      .all<NavRow>(),
    db
      .prepare(
        `SELECT "id", "episodeId", "stageCode", "roleName", "provider", "model", "status", "inputSummary",
                "outputSummary", "log", "error", "startedAt", "finishedAt", "durationMs", "createdAt"
         FROM "PipelineRun" WHERE "projectId" = ? ORDER BY "createdAt" DESC LIMIT 500`,
      )
      .bind(projectId)
      .all<RunRow>(),
    db
      .prepare(`SELECT * FROM "ScriptScene" WHERE "episodeId" = ? ORDER BY "sortOrder"`)
      .bind(episodeId)
      .all<SceneRow>(),
    db
      .prepare(`SELECT * FROM "StoryboardShot" WHERE "episodeId" = ? ORDER BY "sortOrder"`)
      .bind(episodeId)
      .all<ShotRow>(),
    db
      .prepare(`SELECT * FROM "SeedanceUnit" WHERE "episodeId" = ? ORDER BY "sortOrder"`)
      .bind(episodeId)
      .all<UnitRow>(),
    db
      .prepare(
        `SELECT us."unitId", us."shotId", sh."shotKey", us."sortOrder"
         FROM "SeedanceUnitShot" AS us
         INNER JOIN "StoryboardShot" AS sh ON sh."id" = us."shotId"
         WHERE sh."episodeId" = ? ORDER BY us."sortOrder"`,
      )
      .bind(episodeId)
      .all<LinkRow>(),
    db
      .prepare(
        `SELECT pv.* FROM "CompiledPromptVersion" AS pv
         INNER JOIN "SeedanceUnit" AS u ON u."id" = pv."unitId"
         WHERE u."episodeId" = ? ORDER BY pv."selectedAt" DESC, pv."version" DESC`,
      )
      .bind(episodeId)
      .all<VersionRow>(),
    db
      .prepare(`SELECT * FROM "WorkflowIssue" WHERE "episodeId" = ? ORDER BY "status", "createdAt" DESC`)
      .bind(episodeId)
      .all<IssueRow>(),
    db
      .prepare(`SELECT "code", "type", "name", "status", "episodeId", "metadata" FROM "Asset" WHERE "projectId" = ? ORDER BY "type", "code"`)
      .bind(projectId)
      .all<AssetRow>(),
    db
      .prepare(`SELECT "payload", "createdAt" FROM "TaskPackage" WHERE "episodeId" = ? ORDER BY "createdAt" DESC LIMIT 1`)
      .bind(episodeId)
      .all<PackageRow>(),
  ]);

  const currentRuns = runResult.results.filter((run) => run.episodeId === episodeId);
  const currentIssues = issueResult.results;
  const sceneKeys = new Set(sceneResult.results.map((scene) => scene.sceneKey));

  return {
    project: {
      id: episode.projectId,
      title: episode.projectTitle,
      style: episode.style ?? "未选择",
      aspectRatio: episode.aspectRatio,
      executionMode: episode.executionMode,
    },
    episode: {
      id: episode.id,
      number: Number(episode.number),
      title: cleanEpisodeTitle(episode.title, Number(episode.number)),
      content: episode.content,
      infoPackage: packageResult.results[0]?.payload ?? "尚未生成本集信息包。",
    },
    episodeNav: navResult.results.map((item) => {
      const runs = runResult.results.filter((run) => run.episodeId === item.id);
      return {
        id: item.id,
        number: Number(item.number),
        title: cleanEpisodeTitle(item.title, Number(item.number)),
        shotCount: Number(item.shotCount),
        unitCount: Number(item.unitCount),
        status: runs.some(isActiveRun) ? "进行中" : Number(item.unitCount) > 0 ? "已生成" : "未开始",
      };
    }),
    otherEpisodesRunning: navResult.results
      .filter((item) => item.id !== episodeId)
      .filter((item) => runResult.results.some((run) => run.episodeId === item.id && isActiveRun(run)))
      .map((item) => Number(item.number))
      .sort((left, right) => left - right),
    episodeHasContent: shotResult.results.length > 0,
    scenes: sceneResult.results.map((scene) => ({
      id: scene.id,
      sceneKey: scene.sceneKey,
      heading: scene.heading ?? scene.location ?? scene.sceneKey,
      location: scene.location ?? "待补充",
      interiorExterior: scene.interiorExterior ?? "待补充",
      timeOfDay: scene.timeOfDay ?? "待补充",
      weather: scene.weather ?? "默认",
      timeLayer: scene.timeLayer,
      shots: shotResult.results
        .filter((shot) => shot.sceneId === scene.id)
        .map(mapShot),
    })),
    units: unitResult.results.map((unit) => {
      const links = linkResult.results.filter((link) => link.unitId === unit.id);
      return {
        id: unit.id,
        unitKey: unit.unitKey,
        sceneId: unit.sceneId,
        duration: Number(unit.duration),
        dominantGoal: unit.dominantGoal ?? "待生成",
        startPremise: unit.startPremise,
        endState: unit.endState,
        unitLighting: stringValue(parseJsonRecord(unit.data).unit_lighting),
        revision: unit.revision,
        shotKeys: links.map((link) => link.shotKey),
        openIssueCount: currentIssues.filter((issue) =>
          issue.status === "OPEN" &&
          issue.severity === "BLOCKER" &&
          (issue.unitId === unit.id || (issue.shotId != null && links.some((link) => link.shotId === issue.shotId)))
        ).length,
        versions: versionResult.results
          .filter((version) => version.unitId === unit.id)
          .map((version) => ({
            id: version.id,
            version: Number(version.version),
            content: version.content,
            syncStatus: version.syncStatus,
            selectedAt: new Date(Number(version.selectedAt)),
          })),
      };
    }),
    assets: assetResult.results
      .filter((asset) => {
        const refs = sceneRefsOf(asset.metadata);
        return refs.length ? refs.some((ref) => sceneKeys.has(ref)) : !asset.episodeId || asset.episodeId === episodeId;
      })
      .map((asset) => ({ code: asset.code, type: asset.type, name: asset.name, status: asset.status })),
    roles: buildRoleProgress(currentRuns),
    activePipeline: deriveActivePipeline(currentRuns),
    pipelineActive: currentRuns.some(isActiveRun),
    runs: currentRuns.slice(0, 50).map((run) => ({
      id: run.id,
      stageCode: run.stageCode,
      roleName: run.roleName,
      provider: run.provider,
      model: run.model ?? "默认模型",
      status: displayRunStatus(run.status),
      duration: displayDuration(run.durationMs),
      startedAt: run.startedAt == null ? null : new Date(Number(run.startedAt)),
      finishedAt: run.finishedAt == null ? null : new Date(Number(run.finishedAt)),
      log: run.log,
      error: run.error,
      inputSummary: run.inputSummary,
      outputSummary: run.outputSummary,
    })),
    issues: currentIssues.map((issue) => ({
      id: issue.id,
      coordinate: issue.coordinate,
      code: issue.code,
      severity: issue.severity,
      status: issue.status,
      ownerRole: issue.ownerRole,
      evidence: issue.evidence,
      requestedEffect: issue.requestedEffect,
    })),
  };
}

export async function acknowledgeIssue(
  db: D1Database,
  projectId: string,
  episodeId: string,
  issueId: string,
  now = new Date(),
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE "WorkflowIssue" SET "status" = 'EXCEPTED', "updatedAt" = ?
       WHERE "id" = ? AND "projectId" = ? AND "episodeId" = ? AND "status" = 'OPEN' AND "severity" <> 'BLOCKER'`,
    )
    .bind(now.getTime(), issueId, projectId, episodeId)
    .run();
  if (!result.meta.changes) throw new Error("没有找到可保留的问题卡。");
}

export async function acknowledgeAllSuggestions(
  db: D1Database,
  projectId: string,
  episodeId: string,
  now = new Date(),
): Promise<void> {
  await db
    .prepare(
      `UPDATE "WorkflowIssue" SET "status" = 'EXCEPTED', "updatedAt" = ?
       WHERE "projectId" = ? AND "episodeId" = ? AND "status" = 'OPEN' AND "severity" IN ('MAJOR', 'MINOR')`,
    )
    .bind(now.getTime(), projectId, episodeId)
    .run();
}

export async function restorePromptVersion(
  db: D1Database,
  projectId: string,
  episodeId: string,
  versionId: string,
  now = new Date(),
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE "CompiledPromptVersion" SET "selectedAt" = ?
       WHERE "id" = ? AND "unitId" IN (
         SELECT u."id" FROM "SeedanceUnit" u
         INNER JOIN "Episode" e ON e."id" = u."episodeId"
         WHERE e."projectId" = ? AND e."id" = ?
       )`,
    )
    .bind(now.getTime(), versionId, projectId, episodeId)
    .run();
  if (!result.meta.changes) throw new Error("没有找到该提示词版本。");
}

export async function saveManualPromptVersion(
  db: D1Database,
  projectId: string,
  episodeId: string,
  unitId: string,
  content: string,
  now = new Date(),
): Promise<void> {
  const normalized = content.trim();
  if (!normalized) throw new Error("提示词内容不能为空。");
  const latest = await db
    .prepare(
      `SELECT COALESCE(MAX("version"), 0) AS "version"
       FROM "SeedanceUnit" u
       LEFT JOIN "CompiledPromptVersion" v ON v."unitId" = u."id"
       INNER JOIN "Episode" e ON e."id" = u."episodeId"
       WHERE u."id" = ? AND e."id" = ? AND e."projectId" = ?
       GROUP BY u."id"`,
    )
    .bind(unitId, episodeId, projectId)
    .first<{ version: number }>();
  if (!latest) throw new Error("没有找到该单元。");
  await db
    .prepare(
      `INSERT INTO "CompiledPromptVersion"
       ("id", "unitId", "version", "content", "syncStatus", "selectedAt", "createdAt")
       VALUES (?, ?, ?, ?, 'DRAFT_COMPILED', ?, ?)`,
    )
    .bind(crypto.randomUUID(), unitId, Number(latest.version) + 1, normalized, now.getTime(), now.getTime())
    .run();
}

export async function resetEpisodeData(db: D1Database, projectId: string, episodeId: string): Promise<void> {
  const episodeScope = `SELECT "id" FROM "Episode" WHERE "id" = ? AND "projectId" = ?`;
  const unitScope = `SELECT "id" FROM "SeedanceUnit" WHERE "episodeId" IN (${episodeScope})`;
  const shotScope = `SELECT "id" FROM "StoryboardShot" WHERE "episodeId" IN (${episodeScope})`;
  await db.batch([
    db.prepare(`DELETE FROM "WorkflowIssue" WHERE "episodeId" IN (${episodeScope})`).bind(episodeId, projectId),
    db.prepare(`DELETE FROM "CompiledPromptVersion" WHERE "unitId" IN (${unitScope})`).bind(episodeId, projectId),
    db.prepare(`DELETE FROM "SeedanceUnitShot" WHERE "unitId" IN (${unitScope}) OR "shotId" IN (${shotScope})`).bind(episodeId, projectId, episodeId, projectId),
    db.prepare(`DELETE FROM "SeedanceUnit" WHERE "episodeId" IN (${episodeScope})`).bind(episodeId, projectId),
    db.prepare(`DELETE FROM "StoryboardShot" WHERE "episodeId" IN (${episodeScope})`).bind(episodeId, projectId),
    db.prepare(`DELETE FROM "SceneSnapshot" WHERE "projectId" = ? AND "episodeId" = ? AND "sceneKey" LIKE '%BEATS%'`).bind(projectId, episodeId),
    db.prepare(`DELETE FROM "ApiRoleSession" WHERE "projectId" = ? AND "episodeId" = ?`).bind(projectId, episodeId),
    db.prepare(`DELETE FROM "CliRoleSession" WHERE "projectId" = ? AND "episodeId" = ?`).bind(projectId, episodeId),
    db.prepare(`DELETE FROM "PipelineRun" WHERE "projectId" = ? AND "episodeId" = ?`).bind(projectId, episodeId),
  ]);
}

export async function getFinalScriptExport(db: D1Database, episodeId: string, userId: string) {
  return db
    .prepare(
      `SELECT fs."content", fs."version", p."title" AS "projectTitle", e."number", e."title" AS "episodeTitle"
       FROM "FinalScript" fs
       INNER JOIN "Project" p ON p."id" = fs."projectId"
       LEFT JOIN "Episode" e ON e."id" = fs."episodeId"
       WHERE fs."episodeId" = ? AND EXISTS (
         SELECT 1 FROM "ProjectRole" pr WHERE pr."projectId" = p."id" AND pr."userId" = ?
       ) ORDER BY fs."version" DESC LIMIT 1`,
    )
    .bind(episodeId, userId)
    .first<{ content: string; version: number; projectTitle: string; number: number | null; episodeTitle: string | null }>();
}

export async function getTaskPackageExport(db: D1Database, taskPackageId: string, userId: string) {
  return db
    .prepare(
      `SELECT tp."payload", p."title" AS "projectTitle", e."number", e."title" AS "episodeTitle"
       FROM "TaskPackage" tp
       INNER JOIN "Project" p ON p."id" = tp."projectId"
       LEFT JOIN "Episode" e ON e."id" = tp."episodeId"
       WHERE tp."id" = ? AND EXISTS (
         SELECT 1 FROM "ProjectRole" pr WHERE pr."projectId" = p."id" AND pr."userId" = ?
       ) LIMIT 1`,
    )
    .bind(taskPackageId, userId)
    .first<{ payload: string | null; projectTitle: string; number: number | null; episodeTitle: string | null }>();
}

function mapShot(shot: ShotRow) {
  const e1 = parseJsonRecord(shot.e1Data);
  const e2 = parseJsonRecord(shot.e2Data);
  const e3 = parseJsonRecord(shot.e3Data);
  const e4 = parseJsonRecord(shot.e4Data);
  const cells = composeShotCells({ e1, e2, e3, e4 });
  return {
    id: shot.id,
    shotKey: shot.shotKey,
    duration: Number(shot.duration),
    sourceNodeRefs: shot.sourceNodeRefs,
    dialogue: parseJsonRecordList(shot.dialogue),
    e1,
    e2,
    e3,
    e4,
    picture: cells.picture,
    cameraMotion: cells.camera_motion,
    lighting: stringValue(e4.lighting),
    sound: cells.sound,
    transition: cells.transition,
    revision: shot.revision,
  };
}

function buildRoleProgress(runs: RunRow[]) {
  const latestByStage = new Map<string, RunRow>();
  for (const run of [...runs].sort((left, right) => Number(right.createdAt) - Number(left.createdAt))) {
    if (!latestByStage.has(run.stageCode)) latestByStage.set(run.stageCode, run);
  }
  return ROLE_STAGES.map(([code, name]) => {
    const run = latestByStage.get(code);
    return run
      ? { code, name, status: displayRunStatus(run.status), model: run.model ?? "默认模型", duration: displayDuration(run.durationMs) }
      : { code, name, status: "未开始" as const, model: "默认模型", duration: "—" };
  });
}

function deriveActivePipeline(runs: RunRow[]) {
  const active = runs.filter(isActiveRun);
  if (!active.length) return null;
  const stages = [...new Set(active.map((run) => run.stageCode))];
  const metadata = parseJsonRecord(active[0].inputSummary);
  const kind = metadata.repairPipeline === true ? "repair" : metadata.singleStage === true ? "single" : "full";
  return {
    kind,
    stages,
    label: kind === "repair" ? "正在修复" : kind === "single" ? `正在运行 ${stages[0]}` : "正在生成 E0–E5",
  };
}

function isActiveRun(run: RunRow): boolean {
  return run.status === "QUEUED" || run.status === "RUNNING";
}

function displayRunStatus(status: string): "排队中" | "进行中" | "已完成" | "失败" {
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

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseJsonRecordList(value: string | null | undefined): Array<Record<string, unknown>> {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") as Array<Record<string, unknown>> : [];
  } catch {
    return [];
  }
}

function sceneRefsOf(value: string | null | undefined): string[] {
  const refs = parseJsonRecord(value).scene_refs;
  return Array.isArray(refs) ? refs.map(String).filter(Boolean) : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
