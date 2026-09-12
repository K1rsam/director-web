import { prisma } from "@/lib/prisma";
import type { PrismaClient } from "@prisma/client";
import { assetSceneRefsOf } from "@/lib/assets";
import { composeShotCells } from "@/lib/shot-cells";
import { PIPELINE_STAGE_CONFIGS } from "@/lib/episode-pipeline-contracts";
import { foundationJson, getFoundationState } from "@/lib/foundation-state";
import { isRecord, PROJECT_FOUNDATION_STAGES } from "@/lib/project-foundation-contracts";
import { summarizeFoundationRunUsage } from "@/lib/foundation-run-usage";

/** 岗位条与流水线契约同源，避免手工维护漂移（E0 叙事节奏 → E5 审查总控）。 */
export const ROLE_STAGES = PIPELINE_STAGE_CONFIGS.map((stage) => [stage.code, stage.name] as const);

type Db = PrismaClient;

type RunLike = {
  stageCode: string;
  status: string;
  model: string | null;
  durationMs: number | null;
  createdAt: Date;
};

export type RoleProgress = {
  code: string;
  name: string;
  status: "未开始" | "排队中" | "进行中" | "已完成" | "失败";
  model: string;
  duration: string;
};

type ActiveRunLike = {
  stageCode: string;
  status: string;
  inputSummary: string | null;
  createdAt: Date;
};

export type ActivePipelineScope = {
  kind: "single" | "repair" | "full";
  stages: string[];
  label: string;
};

export function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 解析 JSON 数组（对白等）。 */
function parseJsonRecordList(value: string | null | undefined): Array<Record<string, unknown>> {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 从资产 metadata 中读取 scene_refs（P2 写入的场次命中列表）。 */

function displayRunStatus(status: string): RoleProgress["status"] {
  if (status === "RUNNING") return "进行中";
  if (status === "SUCCEEDED") return "已完成";
  if (status === "FAILED" || status === "CANCELED") return "失败";
  return "排队中";
}

function displayDuration(durationMs: number | null): string {
  if (durationMs === null) return "—";
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}秒`;
  return `${Math.floor(durationMs / 60_000)}分${Math.round((durationMs % 60_000) / 1000)}秒`;
}

export function buildRoleProgress(runs: readonly RunLike[]): RoleProgress[] {
  const latestByStage = new Map<string, RunLike>();
  for (const run of [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())) {
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
          duration: displayDuration(run.durationMs)
        }
      : { code, name, status: "未开始", model: "默认模型", duration: "—" };
  });
}

/** 从真实活动批次判断 UI 应显示“单岗位 / 完整流水线 / 局部修复”，避免全局 busy 布尔值误导用户。 */
export function deriveActivePipelineScope(runs: readonly ActiveRunLike[]): ActivePipelineScope | null {
  const active = [...runs]
    .filter((run) => run.status === "QUEUED" || run.status === "RUNNING")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (!active.length) return null;

  const stageOrder = new Map<string, number>(ROLE_STAGES.map(([code], index) => [code, index]));
  const stages = [...new Set(active.map((run) => run.stageCode))]
    .sort((a, b) => (stageOrder.get(a) ?? 99) - (stageOrder.get(b) ?? 99));
  const metadata = parseJsonRecord(active[0].inputSummary);
  const kind: ActivePipelineScope["kind"] = metadata.repairPipeline === true
    ? "repair"
    : metadata.singleStage === true
      ? "single"
      : "full";
  const label = kind === "repair"
    ? "正在修复"
    : kind === "single"
      ? `正在运行 ${stages[0]}`
      : "正在生成 E0–E5";
  return { kind, stages, label };
}

/** SUCCEEDED 是执行结果；只有当前候选及批准链匹配才可显示资料就绪。 */
export function buildFoundationStageViews(state: Awaited<ReturnType<typeof getFoundationState>>) {
  return PROJECT_FOUNDATION_STAGES.map((stage) => {
    const run = state.latestRuns[stage.code === "F1" ? "f1" : stage.code === "F2" ? "f2" : "q1"];
    const current = stage.code === "F1" ? state.planningReady : stage.code === "F2" ? state.assetsReady : state.ready;
    const input = foundationJson(run?.inputSummary);
    const upstreamIds = isRecord(input.upstreamSnapshotIds) ? input.upstreamSnapshotIds : {};
    const upstreamRuns = stage.code === "F1" ? [] : stage.code === "F2" ? [state.latestRuns.f1] : [state.latestRuns.f1, state.latestRuns.f2];
    const staleRun = Boolean(run && (
      (state.sourceVersion && typeof input.sourceVersion === "string" && input.sourceVersion !== state.sourceVersion)
      || (state.inputVersion && typeof input.inputVersion === "string" && input.inputVersion !== state.inputVersion)
      || (stage.code !== "F1" && state.candidates.f1 && typeof upstreamIds.f1 === "string" && upstreamIds.f1 !== state.candidates.f1.id)
      || (stage.code === "Q1" && state.candidates.f2 && typeof upstreamIds.f2 === "string" && upstreamIds.f2 !== state.candidates.f2.id)
      || upstreamRuns.some((upstream) => upstream && upstream.createdAt.getTime() > run.createdAt.getTime())
    ));
    const reviewCurrent = state.assetsReady && run?.status === "SUCCEEDED" && state.review?.runId === run.id
      && state.review?.sourceVersion === state.sourceVersion && state.review?.inputVersion === state.inputVersion
      && state.review?.upstreamSnapshotIds.f1 === state.candidates.f1?.id && state.review?.upstreamSnapshotIds.f2 === state.candidates.f2?.id;
    const status = run?.status === "RUNNING" ? "进行中" : run?.status === "QUEUED" ? "排队中"
      : staleRun ? "旧版／待重跑"
      : run?.status === "CANCELED" ? "已停止" : run?.status === "FAILED" ? "失败"
        : stage.code === "F2" && state.assetsReady && !state.dataReady ? "候选待补资料"
          : stage.code === "Q1" && reviewCurrent && state.review?.output.verdict === "READY" && !state.dataReady ? "资料待补，未发布"
        : stage.code === "Q1" && reviewCurrent && state.review?.output.verdict === "REPAIR" ? state.finalOutput ? "已整理 · 有待定项" : "需返修"
          : stage.code === "Q1" && reviewCurrent && state.review?.output.verdict === "BLOCKED" ? "拒收"
            : current ? stage.code === "Q1" ? state.finalOutput ? "已完成优化" : "当前已批准" : state.candidates.f1?.workflow ? "已整理" : "当前候选就绪"
              : stage.code === "Q1" && state.reviewReady ? "已审待发布"
                : run ? "旧版／待重跑" : "未开始";
    const calls = foundationJson(run?.log).calls;
    const efforts = Array.isArray(calls) ? [...new Set(calls.filter(isRecord).map(call => call.reasoningEffort).filter((effort): effort is string => typeof effort === "string" && effort.length > 0))] : [];
    return { stageCode: stage.code, uiStage: stage.uiStage, name: stage.name, current, status,
      usage: summarizeFoundationRunUsage(run?.log), durationMs: run?.durationMs ?? null, reasoningEffort: efforts.length ? efforts.join(" / ") : null,
      model: run?.model ?? "默认模型", duration: displayDuration(run?.durationMs ?? null), error: run?.error ?? null,
      errorHistorical: staleRun, errorCreatedAt: run?.createdAt.toISOString() ?? null };
  });
}

export async function getProjectStudio(projectId: string, userId: string, db: Db = prisma) {
  const project = await db.project.findFirst({
    where: { id: projectId, roles: { some: { userId } } },
    include: {
      assets: { orderBy: [{ type: "asc" }, { code: "asc" }] },
      pipelineRuns: { where: { episodeId: null }, orderBy: { createdAt: "desc" }, take: 30 },
      episodes: {
        orderBy: { number: "asc" },
        include: {
          scriptScenes: { orderBy: { sortOrder: "asc" } },
          pipelineRuns: { orderBy: { createdAt: "desc" }, take: 10 },
          _count: {
            select: {
              storyboardShots: true,
              seedanceUnits: true,
              workflowIssues: true,
              taskPackages: true
            }
          }
        }
      }
    }
  });

  if (!project) return null;
  const foundation = await getFoundationState(projectId, db);
  // An invalid source blocks approval, but must not hide an active task or its stop control.
  const stageState = foundation.sourceVersion ? foundation : { ...foundation, latestRuns: {
    f1: project.pipelineRuns.find((run) => run.stageCode === "F1") ?? null,
    f2: project.pipelineRuns.find((run) => run.stageCode === "F2") ?? null,
    q1: project.pipelineRuns.find((run) => run.stageCode === "Q1") ?? null
  } };

  return {
    project: {
      id: project.id,
      title: project.title,
      description: project.description ?? "暂无项目简介",
      style: project.style ?? "未选择",
      aspectRatio: project.aspectRatio,
      executionMode: project.executionMode,
      updatedAt: project.updatedAt
    },
    firstPhase: {
      ...foundation,
      stages: buildFoundationStageViews(stageState)
    },
    assets: project.assets.map((asset) => ({
      id: asset.id,
      code: asset.code,
      type: asset.type,
      name: asset.name,
      status: asset.status,
      episodeId: asset.episodeId,
      parentId: asset.parentId,
      role: (parseJsonRecord(asset.metadata).role as string | null) ?? null
    })),
    episodes: project.episodes.map((episode) => ({
      id: episode.id,
      number: episode.number,
      title: episode.title ?? `第${episode.number}集`,
      contentPreview: compactText(episode.content, 120),
      scenes: episode.scriptScenes,
      shotCount: episode._count.storyboardShots,
      unitCount: episode._count.seedanceUnits,
      openIssueCount: episode._count.workflowIssues,
      taskPackageCount: episode._count.taskPackages,
      roles: buildRoleProgress(episode.pipelineRuns)
    })),
    projectRuns: project.pipelineRuns.map((run) => ({
      id: run.id,
      stageCode: run.stageCode,
      roleName: run.roleName,
      status: displayRunStatus(run.status),
      model: run.model ?? "默认模型",
      duration: displayDuration(run.durationMs),
      createdAt: run.createdAt,
      error: run.error
    }))
  };
}

export async function getEpisodeStudio(projectId: string, episodeId: string, userId: string, db: Db = prisma) {
  const episode = await db.episode.findFirst({
    where: { id: episodeId, projectId, project: { roles: { some: { userId } } } },
    include: {
      project: {
        include: {
          assets: { orderBy: [{ type: "asc" }, { code: "asc" }] },
          episodes: {
            orderBy: { number: "asc" },
            include: {
              pipelineRuns: { orderBy: { createdAt: "desc" }, take: 10 },
              _count: { select: { storyboardShots: true, seedanceUnits: true } }
            }
          }
        }
      },
      scriptScenes: {
        orderBy: { sortOrder: "asc" },
        include: { shots: { orderBy: { sortOrder: "asc" } }, units: { orderBy: { sortOrder: "asc" } } }
      },
      seedanceUnits: {
        orderBy: { sortOrder: "asc" },
        include: {
          shotLinks: { orderBy: { sortOrder: "asc" }, include: { shot: true } },
          promptVersions: { orderBy: [{ selectedAt: "desc" }, { version: "desc" }] }
        }
      },
      pipelineRuns: { orderBy: { createdAt: "desc" }, take: 50 },
      workflowIssues: { orderBy: [{ status: "asc" }, { createdAt: "desc" }] },
      taskPackages: { orderBy: { createdAt: "desc" }, take: 1 }
    }
  });

  if (!episode) return null;

  return {
    project: {
      id: episode.project.id,
      title: episode.project.title,
      style: episode.project.style ?? "未选择",
      aspectRatio: episode.project.aspectRatio,
      executionMode: episode.project.executionMode
    },
    episode: {
      id: episode.id,
      number: episode.number,
      title: episode.title ?? `第${episode.number}集`,
      content: episode.content,
      infoPackage: episode.taskPackages[0]?.payload ?? "尚未生成本集信息包。"
    },
    episodeNav: episode.project.episodes.map((item) => ({
      id: item.id,
      number: item.number,
      title: item.title ?? `第${item.number}集`,
      shotCount: item._count.storyboardShots,
      unitCount: item._count.seedanceUnits,
      status: buildRoleProgress(item.pipelineRuns).some((role) => role.status === "进行中")
        ? "进行中"
        : item._count.seedanceUnits > 0
          ? "已生成"
          : "未开始"
    })),
    // 项目级并行运行提示：其他集正在执行时，本页按钮不动，但页面顶部给出说明（不同集可并行是设计行为）
    otherEpisodesRunning: episode.project.episodes
      .filter((item) => item.id !== episode.id)
      .filter((item) => item.pipelineRuns.some((run) => run.status === "QUEUED" || run.status === "RUNNING"))
      .map((item) => item.number)
      .sort((a, b) => a - b),
    episodeHasContent: episode.scriptScenes.some((scene) => scene.shots.length > 0),
    scenes: episode.scriptScenes.map((scene) => ({
      id: scene.id,
      sceneKey: scene.sceneKey,
      heading: scene.heading ?? scene.location ?? scene.sceneKey,
      location: scene.location ?? "待补充",
      interiorExterior: scene.interiorExterior ?? "待补充",
      timeOfDay: scene.timeOfDay ?? "待补充",
      weather: scene.weather ?? "默认",
      timeLayer: scene.timeLayer,
      shots: scene.shots.map((shot) => {
        const e1 = parseJsonRecord(shot.e1Data);
        const e2 = parseJsonRecord(shot.e2Data);
        const e3 = parseJsonRecord(shot.e3Data);
        const e4 = parseJsonRecord(shot.e4Data);
        const cells = composeShotCells({ e1, e2, e3, e4 });
        return {
          id: shot.id,
          shotKey: shot.shotKey,
          duration: shot.duration,
          sourceNodeRefs: shot.sourceNodeRefs,
          dialogue: parseJsonRecordList(shot.dialogue),
          e1,
          e2,
          e3,
          e4,
          picture: cells.picture,
          cameraMotion: cells.camera_motion,
          lighting: (() => { const t = String(e4.lighting ?? "").trim(); return t || null; })(),
          sound: cells.sound,
          transition: cells.transition,
          revision: shot.revision
        };
      })
    })),
    units: episode.seedanceUnits.map((unit) => ({
      id: unit.id,
      unitKey: unit.unitKey,
      sceneId: unit.sceneId,
      duration: unit.duration,
      dominantGoal: unit.dominantGoal ?? "待生成",
      startPremise: unit.startPremise,
      endState: unit.endState,
      unitLighting: (() => { try { const d = JSON.parse(unit.data); return String(d.unit_lighting ?? "").trim() || null; } catch { return null; } })(),
      revision: unit.revision,
      shotKeys: unit.shotLinks.map((link) => link.shot.shotKey),
      openIssueCount: episode.workflowIssues.filter(
        (issue) =>
          issue.status === "OPEN" &&
          issue.severity === "BLOCKER" &&
          (issue.unitId === unit.id || (issue.shotId != null && unit.shotLinks.some((link) => link.shotId === issue.shotId)))
      ).length,
      versions: unit.promptVersions.map((version) => ({
        id: version.id,
        version: version.version,
        content: version.content,
        syncStatus: version.syncStatus,
        selectedAt: version.selectedAt
      }))
    })),
    assets: (() => {
      // 本集命中资产：严格按每个资产自身 metadata.scene_refs 与本集场次求交集——
      // 命中哪个变体就显示哪个（如「赵清雅｜战斗服·受伤」只在其命中场次出现），
      // 不因主资产命中就带出全部子资产。旧数据（无 scene_refs）退回 episodeId 归属判断。
      const sceneKeys = new Set(episode.scriptScenes.map((scene) => scene.sceneKey));
      return episode.project.assets
        .filter((asset) => {
          const refs = assetSceneRefsOf(asset.metadata);
          if (refs.length) return refs.some((ref) => sceneKeys.has(ref));
          return !asset.episodeId || asset.episodeId === episode.id;
        })
        .map((asset) => ({ code: asset.code, type: asset.type, name: asset.name, status: asset.status }));
    })(),
    roles: buildRoleProgress(episode.pipelineRuns),
    activePipeline: deriveActivePipelineScope(episode.pipelineRuns),
    pipelineActive: episode.pipelineRuns.some((run) => run.status === "QUEUED" || run.status === "RUNNING"),
    runs: episode.pipelineRuns.map((run) => ({
      id: run.id,
      stageCode: run.stageCode,
      roleName: run.roleName,
      provider: run.provider,
      model: run.model ?? "默认模型",
      status: displayRunStatus(run.status),
      duration: displayDuration(run.durationMs),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      log: run.log,
      error: run.error,
      inputSummary: run.inputSummary,
      outputSummary: run.outputSummary
    })),
    issues: episode.workflowIssues.map((issue) => ({
      id: issue.id,
      coordinate: issue.coordinate,
      code: issue.code,
      severity: issue.severity,
      status: issue.status,
      ownerRole: issue.ownerRole,
      evidence: issue.evidence,
      requestedEffect: issue.requestedEffect
    }))
  };
}

export function compactText(value: string, maxLength = 240): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}
