import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import type { GenerationRunStatus, Prisma, PromptSyncStatus } from "@prisma/client";
import { assertCodexCliReady } from "@/lib/codex-cli";
import {
  resolveApiModel,
  resolveCliModel,
  resolveCliReasoning,
  resolveProvider,
  runApiRoleJson,
  runCliRoleJson,
  type PipelineProvider,
  type RoleConfig,
  type RoleSessionMode
} from "@/lib/role-runner";
import { isFlashModel } from "@/lib/deepseek-api";
import {
  buildSourcePackage,
  isRecord,
  mergeShotPatches,
  PIPELINE_STAGE_CONFIGS,
  readStageModel,
  roundTenth,
  type PipelineStageCode,
  type SourceNode,
  type WorkingShot
} from "@/lib/episode-pipeline-contracts";
import { prisma } from "@/lib/prisma";
import { DEFAULT_NEGATIVE_PROMPT, resolveStylePrompt } from "@/lib/style-prompts";
import { assetAliasesOf, assetSceneRefsOf } from "@/lib/assets";
import { composeShotCells, composeSound, composeTransition, formatDialogueEntry } from "@/lib/shot-cells";
import {
  buildDialogueSchedule,
  buildTickRanges,
  dialogueMinimumTicks,
  countSequentialActionPhases,
  hasExplicitSpeakingActor,
  mentionIsExplicitlyOffscreen,
  renderVisibleTextNegative,
  resolveE1VisibleTextDeclarations,
  validateVisibleTextDeclaration,
  unitStartPreactionReason,
  type VisibleTextDeclaration
} from "@/lib/episode-pipeline-quality";
import { loadStageRules } from "@/lib/rule-engine";
import { buildApprovedFoundationContext, prepareEpisodeProduction } from "@/lib/workflow";
import { readApprovedEpisodeFoundation, requireApprovedFoundation } from "@/lib/foundation-state";

export type { PipelineProvider };
export { resolveProvider, resolveApiModel, resolveCliModel, resolveCliReasoning };

const STRUCTURAL_E1_ISSUE_CODES = new Set([
  "SOURCE_NODE_UNCOVERED", "MULTI_SPEAKER_SHOT", "ACTION_PHASE_OVERLOAD",
  "CONTINUITY_GROUP_OVER_LIMIT", "SEQUENCE_BOUNDARY", "BEAT_BOUNDARY",
  "INTRA_SHOT_SOURCE_ORDER", "NODE_MIXED_IN_SHOT", "SOURCE_ORDER_MONOTONIC",
  "DIALOGUE_TIMING_CAPACITY", "SPEECH_RATE_OVER_LIMIT", "DURATION_OVER_LIMIT"
]);

type RepairPlanIssue = { ownerRole: string; severity: string; code: string };

/** 结构性 E1 卡改变镜头拓扑，必须从 E1 全表重建到 E5；E0 骨架沿用。 */
export function planRepairPipeline(
  issues: RepairPlanIssue[],
  options: { includeSuggestions?: boolean } = {}
): { stages: PipelineStageCode[]; structuralRebuild: boolean } {
  const actionable = issues.filter((issue) => issue.severity === "BLOCKER" || (options.includeSuggestions && issue.severity === "MAJOR"));
  const structuralRebuild = actionable.some((issue) => issue.ownerRole === "E1" && STRUCTURAL_E1_ISSUE_CODES.has(issue.code));
  if (structuralRebuild) return { stages: ["E1", "E2", "E3", "E4", "E5"], structuralRebuild: true };
  const owners = new Set(actionable.map((issue) => issue.ownerRole));
  const stages = (["E1", "E2", "E3", "E4"] as PipelineStageCode[]).filter((code) => owners.has(code));
  if (owners.has("E5") || stages.length) stages.push("E5");
  return { stages, structuralRebuild: false };
}

/** 结构重建允许全表镜头拓扑变化；普通返修仍严格限制坐标范围。 */
export function repairRunPolicy(structuralRebuild: boolean) {
  return structuralRebuild
    ? { e1Revision: false, e24Revision: false, e3Revision: false, enforceScopeGate: false }
    : { e1Revision: true, e24Revision: true, e3Revision: true, enforceScopeGate: true };
}

type IssueKeyFields = { coordinate: string; code: string };

/** E5 只排除 Python 已开出的同一张卡；同坐标的不同语义卡仍须独立裁定。 */
export function filterPythonDuplicateReviewIssues<T extends IssueKeyFields, U extends IssueKeyFields>(pythonIssues: readonly U[], reviewIssues: readonly T[]): T[] {
  const pythonKeys = new Set(pythonIssues.map(workflowIssueKey));
  return reviewIssues.filter((issue) => !pythonKeys.has(workflowIssueKey(issue)));
}

/** 新 BLOCKER 以 coordinate+code 比较；旧批次元数据没有 keys 时兼容原 coordinate 口径。 */
export function newRegressionBlockerKeys({
  beforeKeys,
  beforeCoordinates,
  current
}: {
  beforeKeys?: readonly string[];
  beforeCoordinates?: readonly string[];
  current: readonly IssueKeyFields[];
}): string[] {
  const keySnapshot = new Set(beforeKeys ?? []);
  const coordinateSnapshot = new Set(beforeCoordinates ?? []);
  return current
    .filter((issue) => keySnapshot.size ? !keySnapshot.has(workflowIssueKey(issue)) : !coordinateSnapshot.has(issue.coordinate))
    .map(workflowIssueKey);
}

export function shouldRollbackRepairRegression({
  structuralRebuild,
  genuineNewBlockerKeys,
  scopeViolations
}: {
  structuralRebuild: boolean;
  genuineNewBlockerKeys: readonly string[];
  scopeViolations: readonly string[];
}) {
  return genuineNewBlockerKeys.length > 0 || (!structuralRebuild && scopeViolations.length > 0);
}

type SourceCarrierRow = { shotKey?: unknown; sourceNodeRefs?: unknown; dialogue?: unknown };

/** 某源节点的承载签名：仅记录涉及该节点的 refs 与台词切片，并按镜号稳定排序。 */
export function sourceNodeCarrierSignature(nodeId: string, shots: readonly SourceCarrierRow[]) {
  return JSON.stringify(shots.map((shot) => {
    const list = (value: unknown) => Array.isArray(value) ? value : typeof value === "string" ? parseJsonList(value) : [];
    const refs = list(shot.sourceNodeRefs).map(String);
    const dialogue = list(shot.dialogue)
      .filter(isRecord)
      .filter((entry) => String(entry.source_node_id ?? "") === nodeId)
      .map((entry) => ({
        text: String(entry.text ?? ""),
        type: String(entry.type ?? ""),
        speaker: String(entry.speaker ?? ""),
        span_state: String(entry.span_state ?? ""),
        from_anchor: String(entry.from_anchor ?? ""),
        to_anchor: String(entry.to_anchor ?? "")
      }));
    if (!refs.includes(nodeId) && !dialogue.length) return null;
    return { shotKey: String(shot.shotKey ?? ""), source_ref: refs.includes(nodeId), dialogue };
  }).filter((item): item is NonNullable<typeof item> => item !== null).sort((a, b) => a.shotKey.localeCompare(b.shotKey)));
}

export function sourceNodeCarrierChanged(nodeId: string, snapshotShots: readonly SourceCarrierRow[], currentShots: readonly SourceCarrierRow[]) {
  return sourceNodeCarrierSignature(nodeId, snapshotShots) !== sourceNodeCarrierSignature(nodeId, currentShots);
}

/** E1 分批输出：每批最多处理的源节点数（避免单次输出超过模型上限导致空 content / 截断）。 */
const E1_BATCH_MAX_NODES = 20;
/** API 模式 E1 用 deepseek-chat（输出上限 8K tokens）。10 节点/批：单批输出约 3-4K tokens，
 *  留足余量不截断，同时把重复携带的上下文（资产索引/快照/指令）批数从 11 降到 7，省约 1/3 token。 */
const E1_API_BATCH_MAX_NODES = 10;
/** API 模式 E1 用 flash 家族（deepseek-v4-flash，输出上限 384K tokens、上下文 1M）时几乎不用拆批：
 *  整集一次输出，拆半重试机制兜底极端情况（值设大仅作安全阀）。 */
const E1_API_FLASH_BATCH_MAX_NODES = 1000;
/** 输出截断（finish_reason=length）时把批拆半重试的下限：拆到该节点数以下仍截断就报错，不再无限细分。 */
const E1_MIN_BATCH_NODES = 3;
/** 单批拆半重试的最大递归深度（2^depth 段），防止异常情况下指数爆炸。 */
const E1_MAX_RETRY_DEPTH = 3;
/** 补漏扫描：主批次后仍有源节点未被任何镜头引用时，用 ≤5 节点的小批补跑，最多补 2 轮。 */
const E1_SWEEP_BATCH_NODES = 5;
const E1_SWEEP_MAX_ROUNDS = 2;
/** E5 Skill 的 issues 上限；达到上限时视为可能截断，本轮不凭“缺席”自动销旧卡。 */
const E5_REVIEW_ISSUE_LIMIT = 20;

type PipelineContext = Awaited<ReturnType<typeof loadPipelineContext>>;

async function assertApprovedContextCurrent(context: PipelineContext) {
  if ((await requireApprovedFoundation(context.projectId)).id !== context.foundationApprovalId) {
    throw new Error("第一阶段批准版本已变更，本批次停止，需重新准备信息包。");
  }
}

type E1Output = {
  base_revision: string;
  shots: Record<string, unknown>[];
  tickets?: Record<string, unknown>[];
  status: string;
};

type PatchOutput = {
  role: string;
  base_revision: string;
  patches: Array<{ shot_id?: unknown; action?: unknown; fields?: unknown }>;
  issues?: Record<string, unknown>[];
};

/** E3 输出：每镜 sound/transition 补丁 + 单元组装。 */
type E3UnitOutput = {
  role: string;
  base_revision: string;
  patches: Array<{ shot_id?: unknown; action?: unknown; fields?: unknown }>;
  units: Record<string, unknown>[];
  issues?: Record<string, unknown>[];
};

/** E5 审查总控输出：坐标化问题卡 + 裁定。 */
type E5ReviewOutput = {
  role: string;
  revision: string;
  coverage: Record<string, unknown>;
  issues: Record<string, unknown>[];
  verdict: "professional_pass" | "issues_found";
  decision: "pass" | "targeted_revision" | "admin_attention";
  routes: Record<string, unknown>[];
  reason: string;
};

type PipelineIssue = {
  coordinate: string;
  code: string;
  severity: "BLOCKER" | "MAJOR" | "MINOR";
  ownerRole: string;
  expected: string;
  evidence: string;
  requestedEffect: string;
};

export type PipelineStageRunner = (
  stageCode: PipelineStageCode,
  prompt: string
) => Promise<{
  data: Record<string, unknown>;
  sessionId: string | null;
  stdout: string;
  stderr: string;
}>;

export function assertStageOneTestScope(): void {
  throw new Error("[STAGE1_SCOPE_ONLY] 当前仅开放 v0.2 第一阶段测试 P0/F1/F2/Q1 与资料评审；v0.2 后续阶段尚未启用，不能启动旧 E0–E5。");
}

export async function queueEpisodePipeline(projectId: string, episodeId: string) {
  assertStageOneTestScope();
  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, projectId },
    include: { project: true }
  });
  if (!episode) throw new Error("没有找到这个剧集。");
  await requireApprovedFoundation(projectId);
  // 单并发闸门：同一集同一时间只允许一条流水线；不同集（三线路）可并行，各自持有独立会话与批次
  const active = await prisma.pipelineRun.findFirst({
    where: { projectId, episodeId, status: { in: ["QUEUED", "RUNNING"] } }
  });
  if (active) throw new Error("本集已有岗位正在执行，请等待当前流程完成后重试（不同集可并行）。");
  const provider = resolveProvider(episode.project.executionMode);
  if (provider === "CLI") await assertCodexCliReady();

  await prepareEpisodeProduction(projectId, episodeId);
  const batchToken = crypto.randomUUID();
  await prisma.$transaction(
    PIPELINE_STAGE_CONFIGS.map((stage) =>
      prisma.pipelineRun.create({
        data: {
          projectId,
          episodeId,
          stageCode: stage.code,
          roleName: stage.name,
          provider: provider === "API" ? "DeepSeek API" : "Codex CLI",
          model: provider === "API" ? resolveApiModel(stage.code, ["E1", "E5"].includes(stage.code)) : resolveCliModel(stage.code, stage.model),
          status: "QUEUED",
          inputSummary: JSON.stringify({ batchToken, provider })
        }
      })
    )
  );

  await launchWorker(projectId, episodeId, batchToken);
  return { batchToken };
}

/**
 * 单步骤运行（测试阶段）：只排队并执行一个岗位。
 * 前置校验：E2–E4 需要已有小镜号；E5 需要已有小镜号与单元。
 */
/**
 * 一键整批修复：按 E1→E2→E3→E4→E5 顺序，只跑"有开放问题卡"的岗位（每个岗位一次调用带全部卡），
 * 最后 E5 复审统一销卡。不同岗位的卡不需要逐张跑。
 */
export async function queueRepairPipeline(
  projectId: string,
  episodeId: string,
  options: { includeSuggestions?: boolean; force?: boolean } = {}
) {
  assertStageOneTestScope();
  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, projectId },
    include: { project: true }
  });
  if (!episode) throw new Error("没有找到这个剧集。");
  await requireApprovedFoundation(projectId);
  const active = await prisma.pipelineRun.findFirst({
    where: { projectId, episodeId, status: { in: ["QUEUED", "RUNNING"] } }
  });
  if (active) throw new Error("本集已有岗位正在执行，请等待当前流程完成后重试。");
  const openIssues = await prisma.workflowIssue.findMany({
    where: { episodeId, status: "OPEN" },
    select: { ownerRole: true, severity: true, coordinate: true, code: true }
  });
  if (!openIssues.length) throw new Error("本集没有开放问题卡，无需修复。");
  // 修复前 BLOCKER 快照：回归门用 coordinate+code 识别返修引入的新硬错误；保留坐标兼容旧批次。
  const openBlockerCoords = openIssues.filter((issue) => issue.severity === "BLOCKER").map((issue) => issue.coordinate);
  const openBlockerKeys = openIssues.filter((issue) => issue.severity === "BLOCKER").map(workflowIssueKey);
  // 全部 OPEN 卡坐标（含 MAJOR）：修复轮各岗位的 revisionIssues 会带上同 owner 的 MAJOR 卡
  //（E1/E2/E3/E4 分支查询 ownerRole+OPEN 不限 severity），回归门的"命中镜"判定必须覆盖它们——
  // 否则合法的 MAJOR 修复会被当作"未命中越界"整批回滚（实测 10:17 轮：修 2-2-S017 BLOCKER +
  // 2-1-S011 等 MAJOR 卡，S017 修好却被回滚撤销）
  const openCoords = openIssues.map((issue) => issue.coordinate);
  // 收敛门禁已移除（用户决策）：它只限制人工重试，不帮助 AI 修好——
  // 修 A 破 B 由回归检测（新增 BLOCKER 自动回滚）+ 修复轮坐标过滤兜底，无需前置拦截
  const openBlockers = openIssues.filter((issue) => issue.severity === "BLOCKER").length;
  const openMajors = openIssues.filter((issue) => issue.severity === "MAJOR").length;
  // 选岗：BLOCKER 卡的归属岗位必跑；「连建议一起修」时 MAJOR 卡的归属岗位也纳入（MINOR 与 SYSTEM 卡不触发）
  const plan = planRepairPipeline(openIssues, options);
  if (!plan.stages.length) {
    throw new Error(
      options.includeSuggestions
        ? "本集没有可修复的问题卡（BLOCKER 与 MAJOR 均已清零）。"
        : "本集只有建议卡（MAJOR/MINOR），不阻塞放行；可用「连建议一起修」让建议卡随修复轮一并处理，或用「确认保留」豁免不需要修的卡。"
    );
  }
  // E5 自己也开卡（如 FALSE_RELEASE_BLOCKED）：复审即可销，无需前置岗位
  const needed = plan.stages;
  if (!needed.length) throw new Error("没有可修复的岗位。");

  const provider = resolveProvider(episode.project.executionMode);
  if (provider === "CLI") await assertCodexCliReady();
  if (needed.includes("E1")) await prepareEpisodeProduction(projectId, episodeId);
  const batchToken = crypto.randomUUID();
  await prisma.pipelineRun.createMany({
    data: needed.map((stageCode) => {
      const stage = readStageModel(stageCode);
      return {
        projectId,
        episodeId,
        stageCode,
        roleName: stage.name,
        provider: provider === "API" ? "DeepSeek API" : "Codex CLI",
        model: provider === "API" ? resolveApiModel(stageCode, ["E1", "E5"].includes(stageCode)) : resolveCliModel(stageCode, stage.model),
        status: "QUEUED",
        inputSummary: JSON.stringify({ batchToken, provider, repairPipeline: true, structuralRebuild: plan.structuralRebuild, openBlockers, openMajors, includeSuggestions: options.includeSuggestions === true, openBlockerCoords, openBlockerKeys, openCoords })
      };
    })
  });
  await launchWorker(projectId, episodeId, batchToken, undefined, needed.join(","));
  return { batchToken, stages: needed };
}

/**
 * 单步骤运行（测试阶段）：只排队并执行一个岗位。
 * 前置校验：E2–E4 需要已有小镜号；E5 需要已有小镜号与单元。
 */
export async function queueSingleStagePipeline(projectId: string, episodeId: string, stageCode: string) {
  assertStageOneTestScope();
  const stage = readStageModel(stageCode as PipelineStageCode);
  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, projectId },
    include: { project: true }
  });
  if (!episode) throw new Error("没有找到这个剧集。");
  await requireApprovedFoundation(projectId);
  const active = await prisma.pipelineRun.findFirst({
    where: { projectId, episodeId, status: { in: ["QUEUED", "RUNNING"] } }
  });
  if (active) throw new Error("本集已有岗位正在执行，请等待当前流程完成后重试（不同集可并行）。");
  const provider = resolveProvider(episode.project.executionMode);
  if (provider === "CLI") await assertCodexCliReady();

  const [shotCount, unitCount] = await Promise.all([
    prisma.storyboardShot.count({ where: { episodeId } }),
    prisma.seedanceUnit.count({ where: { episodeId } })
  ]);
  if (stage.code !== "E1" && shotCount === 0) throw new Error(`本集尚无小镜号，请先运行 E1 或整批后再单独运行 ${stage.code}。`);
  // 单元由 E3 生成：只有 E5（审查总控）需要先有单元
  if (stage.code === "E5" && unitCount === 0) {
    throw new Error(`本集尚无 Seedance 单元，请先运行 E3 或整批后再单独运行 E5。`);
  }

  if (stage.code === "E1") await prepareEpisodeProduction(projectId, episodeId);
  const batchToken = crypto.randomUUID();
  await prisma.pipelineRun.create({
    data: {
      projectId,
      episodeId,
      stageCode: stage.code,
      roleName: stage.name,
      provider: provider === "API" ? "DeepSeek API" : "Codex CLI",
      model: provider === "API" ? resolveApiModel(stage.code, ["E1", "E5"].includes(stage.code)) : resolveCliModel(stage.code, stage.model),
      status: "QUEUED",
      inputSummary: JSON.stringify({ batchToken, provider, singleStage: true })
    }
  });

  await launchWorker(projectId, episodeId, batchToken, stage.code);
  return { batchToken };
}

/** provider 在排队时写入批次元数据；执行时以该值为准，避免运行中切换模式导致记录与实际不一致。 */
async function resolveEpisodeBatchProvider(
  projectId: string,
  episodeId: string,
  batchToken: string,
  fallbackExecutionMode: string | null | undefined
): Promise<PipelineProvider> {
  const run = await prisma.pipelineRun.findFirst({
    where: { projectId, episodeId, inputSummary: { contains: batchToken } },
    orderBy: { createdAt: "asc" },
    select: { inputSummary: true }
  });
  const pinned = safeParseJson(run?.inputSummary).provider;
  return pinned === "API" || pinned === "CLI"
    ? pinned
    : resolveProvider(fallbackExecutionMode);
}

export async function executeEpisodePipeline(
  projectId: string,
  episodeId: string,
  batchToken: string,
  options: { stageRunner?: PipelineStageRunner; singleStage?: PipelineStageCode; stages?: PipelineStageCode[] } = {}
) {
  // 仅保留已有注入 runner 的内部离线回归；页面、队列和真实 provider 均无绕行开关。
  if (typeof options.stageRunner !== "function") assertStageOneTestScope();
  const context = await loadPipelineContext(projectId, episodeId);
  const provider = await resolveEpisodeBatchProvider(projectId, episodeId, batchToken, context.project.executionMode);

  // 定向模式（单步骤或一键整批修复）：从数据库回填该岗位需要的前序数据，而不是从空状态开始
  const isTargeted = Boolean(options.singleStage || (options.stages && options.stages.length > 0));
  let workingShots: WorkingShot[] = isTargeted
    ? await hydrateWorkingShots(context)
    : [];
  let unitOutput: E3UnitOutput = isTargeted
    ? await hydrateUnitOutput(context)
    : { role: "E3", base_revision: context.revision, patches: [], units: [], issues: [] };
  // 机械微调（零 Token）：单元略超 15 秒时先从最拖的镜头减时长，再交给审查，避免无谓返修
  if (isTargeted && workingShots.length && unitOutput.units.length) {
    workingShots = await autoRepairUnitDurations(context, workingShots, unitOutput.units);
    unitOutput = await hydrateUnitOutput(context);
  }
  let hardIssues: PipelineIssue[] =
    (options.singleStage === "E5" || (options.stages?.includes("E5") && !options.singleStage))
      ? validatePipeline(context, workingShots, unitOutput.units)
      : [];

  const stages = options.singleStage
    ? PIPELINE_STAGE_CONFIGS.filter((stage) => stage.code === options.singleStage)
    : options.stages?.length
      ? PIPELINE_STAGE_CONFIGS.filter((stage) => options.stages!.includes(stage.code))
      : PIPELINE_STAGE_CONFIGS;

  // REPAIR TRANSACTION：返修批次在事务快照上执行——批次结束回归检测发现新增 BLOCKER 时自动回滚，
  // 坏修复不落库（不是"报警"而是"安全门"）
  const repairSnapshot = (options.stages?.length ?? 0) > 0
    ? await snapshotEpisode(episodeId)
    : null;

  for (const stage of stages) {
    const run = await findBatchRun(projectId, episodeId, batchToken, stage.code);
    if (!run) throw new Error(`缺少${stage.code}执行记录。`);
    const startedAt = new Date();
    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: { status: "RUNNING", startedAt, error: null }
    });

    try {
      await assertApprovedContextCurrent(context);
      const structuralRebuild = safeParseJson(run.inputSummary).structuralRebuild === true;
      const repairPolicy = repairRunPolicy(structuralRebuild);
      let inputCharsTotal = 0;
      let revisionPrompt: string | null = null;
      let revisionMode = false;
      let e1RevisionIssues: Array<{ coordinate: string }> = [];
      let e24RevisionMode = false;
      let e24HitShotKeys = new Set<string>();
      let e3RevisionMode = false;
      let e3HitShotKeys = new Set<string>();   // E3（单元）返修命中镜
      let e3HitUnitKeys = new Set<string>();   // E3（单元）返修命中单元
      let lightingUnitKeys = new Set<string>(); // E4 返修：被开「单元.lighting」卡的单元（唯一允许重写 unit_lighting 的范围）
      let e5Skip = false;
      let fingerprint: string | null = null;
      let released = false;
      // 无 issuer 字段时，用“本轮实际交给 E5 复核的旧卡 key”限定销卡权限；
      // persistReviewIssues 还会识别后续新写入的 E5 source marker，避免误销上游岗位卡。
      let e5ReviewedIssueKeys = new Set<string>();
      // E1 返修轮：存在归属 E1 的开放问题时，带上问题卡定向返修，而不是盲跑
      if (stage.code === "E1") {
        // 锁定剧本变化检测：剧本换了（节点增删/文本改动），旧镜号的台词切片全部失效，必须整表重建
        const currentScriptFingerprint = scriptFingerprint(context);
        const lastE1Run = await prisma.pipelineRun.findFirst({
          where: { projectId, episodeId, stageCode: "E1", status: "SUCCEEDED" },
          orderBy: { createdAt: "desc" }
        });
        const lastScriptFingerprint = safeParseJson(lastE1Run?.inputSummary).scriptFingerprint as string | undefined;
        const scriptChanged = typeof lastScriptFingerprint === "string" && lastScriptFingerprint !== currentScriptFingerprint;
        const openIssues = scriptChanged
          ? []
          : await prisma.workflowIssue.findMany({
              where: { projectId, episodeId, ownerRole: "E1", status: "OPEN" },
              orderBy: { createdAt: "asc" }
            });
        revisionMode = repairPolicy.e1Revision && openIssues.length > 0;
        if (scriptChanged) {
          await createMechanicalIssueOnce(
            context,
            "E1.script_changed",
            "SCRIPT_CHANGED_FULL_REBUILD",
            "锁定剧本变化时整表重建分镜",
            `锁定剧本指纹变化：${currentScriptFingerprint.slice(0, 12)}，旧镜号台词切片全部失效，本轮按全新剧本重建`,
            "已自动执行全量重建，无需处理"
          );
        }
        if (revisionMode) {
          const dbShots = await prisma.storyboardShot.findMany({ where: { episodeId } });
          const shotByKey = new Map(dbShots.map((shot) => [shot.shotKey, shot]));
          const revisionIssues = openIssues.map((item) => ({
            coordinate: item.coordinate,
            code: item.code,
            evidence: item.evidence,
            requested_effect: item.requestedEffect,
            fix_hint: buildFixHint(item, shotByKey)
          }));
          e1RevisionIssues = revisionIssues;
          await recordRepairCoords(run, revisionIssues.map((item) => item.coordinate));
          const input = buildStageInput(stage.code, context, workingShots, unitOutput, hardIssues, revisionIssues) as Record<string, unknown>;
          // 返修轮只给命中场景的锁定剧本：整集剧本重复灌入是纯 token 浪费
          input.locked_script = trimLockedScriptForRevision(context, revisionIssues);
          revisionPrompt = buildE1RevisionPrompt(input);
        }
      }
      // E2/E4 返修轮：命中镜号 ± 相邻镜的定向修补，不再全表重写
      if (stage.code === "E2" || stage.code === "E4") {
        const openIssues = await prisma.workflowIssue.findMany({
          where: { projectId, episodeId, ownerRole: stage.code, status: "OPEN" },
          orderBy: { createdAt: "asc" }
        });
        e24RevisionMode = repairPolicy.e24Revision && openIssues.length > 0;
        if (e24RevisionMode) {
          const revisionIssues = openIssues.map((item) => ({
            coordinate: item.coordinate,
            code: item.code,
            evidence: item.evidence,
            requested_effect: item.requestedEffect
          }));
          const flaggedKeys = new Set(
            revisionIssues.map((item) => item.coordinate.split(".")[0]).filter((key) => key.includes("-S"))
          );
          e24HitShotKeys = flaggedKeys;
          await recordRepairCoords(run, revisionIssues.map((item) => item.coordinate));
          const indexByKey = new Map(workingShots.map((shot, index) => [shot.shot_id, index]));
          const targetIndexes = new Set<number>();
          for (const key of flaggedKeys) {
            const index = indexByKey.get(key);
            if (index === undefined) continue;
            for (let delta = -1; delta <= 1; delta++) {
              const neighbor = index + delta;
              if (neighbor >= 0 && neighbor < workingShots.length) targetIndexes.add(neighbor);
            }
          }
          // E4 返修的光影写入范围（顾问要求：Repair 只改指定坐标，绝不重新解释整条片）：
          // 06:45 轮修 $1（S010/S012 音效卡）时模型顺手重写命中单元 U04/U05 的 unit_lighting、
          // 写入未来状态（水晶熄灭/系统面板）→ TEMPORAL_GROUNDING BLOCKER → 整批回滚，$1 修复被撤。
          // 根因：allowedUnits=命中镜所属单元 太宽。收窄为**只有被开「单元key.lighting」卡
          //（UNIT_LIGHTING_MISSING / UNIT_LIGHTING_TEMPORAL_GROUNDING）的单元**才允许重写布光；
          // 无光影卡的返修轮（$1/摄影卡）机械层直接禁止 unit_lighting 落库。
          if (stage.code === "E4") {
            for (const item of revisionIssues) {
              const match = /^(.*?-U\d+)\.lighting$/.exec(item.coordinate);
              if (match) lightingUnitKeys.add(match[1]);
            }
            // 光影卡单元纳入输入窗口：模型需看到单元内镜头才能正确写布光（其镜头不在命中范围，
            // patches 坐标过滤仍只放行命中镜，写不进来；unit_lighting 则由 lightingUnitKeys 门控）
            if (lightingUnitKeys.size) {
              const partition = computeUnitPartition(context, workingShots);
              for (const part of partition) {
                if (!lightingUnitKeys.has(part.unitKey)) continue;
                for (const id of part.shotIds) {
                  const index = indexByKey.get(id);
                  if (index !== undefined) targetIndexes.add(index);
                }
              }
            }
          }
          // targetedShots 必须在光影卡单元扩展之后计算，输入窗口才包含卡上单元镜头
          const targetedShots = [...targetIndexes].sort((a, b) => a - b).map((index) => workingShots[index]);
          const input = buildStageInput(stage.code, context, targetedShots, unitOutput, hardIssues, revisionIssues);
          revisionPrompt = buildE24RevisionPrompt(stage.code, input);
        }
      }
      // E3 返修轮：只重写命中单元的创作字段（镜号归属由 Python 决定）
      if (stage.code === "E3") {
        const openUnitIssues = await prisma.workflowIssue.findMany({
          where: { projectId, episodeId, status: "OPEN", ownerRole: "E3" },
          orderBy: { createdAt: "asc" }
        });
        e3RevisionMode = repairPolicy.e3Revision && openUnitIssues.length > 0;
        if (e3RevisionMode) {
          const currentUnits = await hydrateUnitOutput(context);
          const revisionIssues = openUnitIssues.map((item) => ({
            coordinate: item.coordinate,
            code: item.code,
            evidence: item.evidence,
            requested_effect: item.requestedEffect,
            fix_hint: buildUnitFixHint(item)
          }));
          const input = buildStageInput(stage.code, context, workingShots, currentUnits, hardIssues, revisionIssues) as Record<string, unknown>;
          // 返修轮窗口：**只修被开卡的命中单元**（衔接卡"1-1-U09→1-1-U10"双向 / 字段卡"1-1-U09.fields"）。
          // 缺失字段的单元不自动纳入：它们没被开卡时是 MAJOR 容忍项，纳入只会让模型重写未命中单元、
          // 引入新 BLOCKER（修 A 破 B，回归回滚整批白跑）；被开 UNIT_FIELDS_INCOMPLETE 卡时自然进入命中
          const hitUnitKeys = new Set<string>();
          for (const coord of revisionIssues.map((item) => item.coordinate.split(".")[0])) {
            if (!coord.includes("-U")) continue;
            for (const part of coord.split("→")) hitUnitKeys.add(part);
          }
          e3HitUnitKeys = hitUnitKeys;
          await recordRepairCoords(run, revisionIssues.map((item) => item.coordinate));
          const partition = computeUnitPartition(context, workingShots);
          const unitList = currentUnits.units as Record<string, unknown>[];
          const targetParts = partition.filter((part) => hitUnitKeys.has(part.unitKey));
          if (targetParts.length) {
            const targetShotIds = new Set(targetParts.flatMap((part) => part.shotIds));
            e3HitShotKeys = targetShotIds;
            input.unit_windows = targetParts.map((part, index) => {
              let previousEndState: string | null = null;
              for (let prev = index - 1; prev >= 0; prev--) {
                const prevPart = targetParts[prev];
                if (prevPart.sceneId !== part.sceneId) break;
                previousEndState = String((unitList.find((unit) => String(unit.unit_id ?? "") === prevPart.unitKey) as Record<string, unknown> | undefined)?.unit_end_state ?? "");
                break;
              }
              return {
                unit_id: part.unitKey,
                shot_ids: part.shotIds,
                duration: part.duration,
                needs_short_reason: part.needsReason,
                previous_end_state: previousEndState,
                current: unitList.find((unit) => String(unit.unit_id ?? "") === part.unitKey) ?? null
              };
            });
            input.shots = stageShotRows(workingShots.filter((shot) => targetShotIds.has(shot.shot_id)), ["e1", "e2", "e3"]);
          }
          revisionPrompt = buildE3RevisionPrompt(input);
        }
      }
      let result: { data: Record<string, unknown>; sessionId: string | null; stdout: string; stderr: string } | null = null;
      // CLI 模式整集一次调用：全量岗位用新会话，只有定向返修续接，不再为规避输出上限分批；
      // API 模式按模型输出能力决定批大小：flash（384K 输出）几乎整集一次，chat（8K）按 10 节点/批拆
      const e1BatchSize = provider === "API"
        ? isFlashModel(resolveApiModel("E1", false))
          ? E1_API_FLASH_BATCH_MAX_NODES
          : E1_API_BATCH_MAX_NODES
        : Number.POSITIVE_INFINITY;
      if (revisionPrompt) {
        let prompt = revisionPrompt;
        // 轻量上下文（API 无会话）：注入本岗位最近一次成功输出的摘要——
        // 模型记得自己首轮拆过什么镜、为什么，返修轮不再"失忆重拆"（16:01 轮把群嘲段
        // 节点塞进 B02 镜号就是失忆重拆的后果）。首轮全量（无历史）自动跳过。
        if (provider === "API") {
          const lastRun = await prisma.pipelineRun.findFirst({
            where: { projectId, episodeId, stageCode: stage.code, status: "SUCCEEDED" },
            orderBy: { createdAt: "desc" },
            select: { outputSummary: true, createdAt: true }
          });
          const prev = lastRun?.outputSummary ? lastRun.outputSummary.slice(0, 12_000) : "";
          if (prev && prev !== "{}") {
            prompt = `### 你上一轮的输出（仅供参考：保持镜号/区域/步骤一致性；本次以问题卡与 INPUT_JSON 为准，只修命中项，不要重拆整片）\n${prev}\n\n### 本次任务\n${revisionPrompt}`;
          }
        }
        inputCharsTotal = prompt.length;
        // 修复轮限制输出上限：模型不守"只修命中镜"时会重写全片（实测一次跑 11 分钟+烧 10 万 token）。
        // 思考模式下 completion 含思维链，上限需加大才能容纳"思考+修正输出"
        const repairMaxTokens = { E1: 40_000, E2: 16_384, E3: 32_768, E4: 96_000 } as Partial<Record<PipelineStageCode, number>>;
        result = options.stageRunner
          ? await options.stageRunner(stage.code, prompt)
          : provider === "API"
            ? await runApiRoleSession({ projectId, episodeId, stageCode: stage.code, prompt, maxTokens: repairMaxTokens[stage.code], useSession: true })
            : await runRoleSession({ projectId, episodeId, stageCode: stage.code, prompt, sessionMode: "resume" });
      } else if (stage.code === "E0") {
        // E0 叙事节奏：首轮全量时先切 Beat 骨架，E1 随后按骨架拆镜
        const input = buildStageInput("E0", context, workingShots, unitOutput, hardIssues);
        const prompt = buildStagePrompt("E0", input);
        inputCharsTotal = prompt.length;
        result = options.stageRunner
          ? await options.stageRunner(stage.code, prompt)
          : provider === "API"
            ? await runApiRoleSession({ projectId, episodeId, stageCode: stage.code, prompt, noSession: true })
            : await runRoleSession({ projectId, episodeId, stageCode: stage.code, prompt, sessionMode: "ephemeral" });
      } else if (stage.code === "E1" && context.sourceNodes.size > e1BatchSize) {
        // E1 分批输出：源节点过多时按批调用（每批 ≤ E1_BATCH_MAX_NODES），避免单次输出超过模型上限（空 content 问题）
        const chunked = await runE1Chunked({ context, provider, projectId, batchSize: e1BatchSize, stageRunner: options.stageRunner });
        result = {
          data: chunked.output as unknown as Record<string, unknown>,
          sessionId: chunked.sessionId,
          stdout: chunked.stdout,
          stderr: chunked.stderr
        };
        inputCharsTotal = chunked.inputChars;
      } else {
        // E4 会在数据库中补写 unit_lighting / camera，但内存 unitOutput 仍是 E3 后快照。
        // E5 的输入、hard checks 与 fingerprint 必须来自同一份最新落库状态，否则会把已经补齐的
        // UNIT_LIGHTING_MISSING 当成现役错误，既误导审查又白耗一次复审 Token。
        if (stage.code === "E5") {
          workingShots = await hydrateWorkingShots(context);
          unitOutput = await hydrateUnitOutput(context);
          hardIssues = validatePipeline(context, workingShots, unitOutput.units);
        }
        // E5 复审只接收：所有旧 BLOCKER + 明确标记为 E5 产出的旧卡。
        // E1-E4 普通 MAJOR 不混入；无 issuer 的历史 E5 卡用上一轮 E5 输出 key 兼容识别。
        const lastSuccessfulE5 = stage.code === "E5"
          ? await prisma.pipelineRun.findFirst({
              where: { projectId, episodeId, stageCode: "E5", status: "SUCCEEDED" },
              orderBy: { createdAt: "desc" }
            })
          : null;
        const previousE5Review = safeParseJson(lastSuccessfulE5?.outputSummary);
        const previousE5IssueKeys = new Set<string>();
        for (const raw of Array.isArray(previousE5Review?.issues) ? previousE5Review.issues : []) {
          if (!isRecord(raw)) continue;
          previousE5IssueKeys.add(workflowIssueKey({
            coordinate: String(raw.coordinate ?? ""),
            code: String(raw.issue_code ?? raw.code ?? "E5_ISSUE")
          }));
        }
        const allOpenIssueRows = stage.code === "E5"
          ? await prisma.workflowIssue.findMany({
              where: { projectId, episodeId, status: "OPEN" },
              orderBy: { createdAt: "asc" }
            })
          : [];
        const severityRank = (severity: string) => severity === "BLOCKER" ? 0 : severity === "MAJOR" ? 1 : 2;
        const openIssueRows = allOpenIssueRows
          .filter((item) => item.severity === "BLOCKER"
            || isE5OwnedIssueRevision(item.revision)
            || previousE5IssueKeys.has(workflowIssueKey(item)))
          .sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.createdAt.getTime() - b.createdAt.getTime())
          .slice(0, E5_REVIEW_ISSUE_LIMIT);
        const openForStage = openIssueRows.map((item) => ({
          coordinate: item.coordinate,
          code: item.code,
          evidence: item.evidence.slice(0, 120),
          requested_effect: item.requestedEffect.slice(0, 80),
          owner_role: item.ownerRole
        }));
        if (stage.code === "E5") {
          e5ReviewedIssueKeys = new Set(openIssueRows.map(workflowIssueKey));
        }
        const input = buildStageInput(stage.code, context, workingShots, unitOutput, hardIssues, openForStage);
        if (stage.code === "E5") {
          fingerprint = crypto.createHash("sha1").update(JSON.stringify(input)).digest("hex");
          // 表格与校验结果都没变时跳过模型复审（零 Token），避免反复点 E5 重复烧钱
          const lastSummary = safeParseJson(lastSuccessfulE5?.inputSummary);
          e5Skip = typeof lastSummary.fingerprint === "string" && lastSummary.fingerprint === fingerprint;
        }
        if (e5Skip) {
          result = null;
        } else {
          const prompt = buildStagePrompt(stage.code, input);
          inputCharsTotal = prompt.length;
          result = options.stageRunner
            ? await options.stageRunner(stage.code, prompt)
            : provider === "API"
              ? await runApiRoleSession({ projectId, episodeId, stageCode: stage.code, prompt })
              : await runRoleSession({ projectId, episodeId, stageCode: stage.code, prompt, sessionMode: "fresh" });
        }
      }

      // External calls may outlive a source edit or a new foundation run.
      await assertApprovedContextCurrent(context);
      if (stage.code === "E0") {
        const output = await persistE0(context, result!.data);
        // 骨架回灌 context：sequences + 扁平 beats，本批次的 E1 立即可用
        context.sequences = Array.isArray(output.sequences) ? output.sequences : [];
        context.beats = context.sequences.flatMap((seq) => seq.beats);
      } else if (stage.code === "E1") {
        const output = requireE1(result!.data);
        workingShots = await persistE1(context, output, { revision: revisionMode, revisionIssues: e1RevisionIssues });
        await persistGenericIssues(context, output.tickets ?? [], "E1");
        // 返修轮只回写命中镜号：回填全表，保证下游岗位与编译看到完整分镜表
        if (revisionMode) workingShots = await hydrateWorkingShots(context);
      } else if (stage.code === "E2" || stage.code === "E4") {
        const output = requirePatchOutput(result!.data, stage.code);
        const field = stage.code.toLowerCase() as "e2" | "e3";
        workingShots = mergeShotPatches(workingShots, output.patches, field);
        await persistShotPatches(context, output, field, { tolerateMissing: e24RevisionMode, allowedShotKeys: e24RevisionMode ? e24HitShotKeys : undefined });
        // E4（单元级光影）：unit_lighting 写入 seedanceUnit.data，编译层合并进单元提示词
        if (stage.code === "E4") {
          // 返修轮只放行被开「.lighting」卡的单元（lightingUnitKeys）；无光影卡的返修轮传空集 → 全部丢弃，完全禁止 unit_lighting 落库
          await persistUnitLighting(context, output as unknown as { unit_lighting?: unknown }, e24RevisionMode ? lightingUnitKeys : undefined);
        }
        await persistGenericIssues(context, output.issues ?? [], stage.code);
        if (e24RevisionMode) workingShots = await hydrateWorkingShots(context);
      } else if (stage.code === "E3") {
        const output = requireE3(result!.data);
        workingShots = mergeShotPatches(workingShots, output.patches, "e3");
        await persistShotPatches(context, output, "e3", { tolerateMissing: e3RevisionMode, allowedShotKeys: e3RevisionMode ? e3HitShotKeys : undefined });
        // E1 机械层可能已新增/修改镜号（42字切批 -c0/-x0、时长归正、台词对账）：
        // 内存里的 E1 原始输出不含这些镜，必须按库重灌，单元分组才不漏镜（否则 -c0 镜成孤儿）
        workingShots = await hydrateWorkingShots(context);
        await persistUnits(context, workingShots, { role: output.role, base_revision: output.base_revision, patches: output.patches, units: output.units, issues: output.issues }, { partial: e3RevisionMode, allowedUnits: e3RevisionMode ? e3HitUnitKeys : undefined });
        // 落库后的权威单元（Python 分组 + 创作字段）回灌内存，编译与后续校验以库为准
        unitOutput = await hydrateUnitOutput(context);
        await persistGenericIssues(context, output.issues ?? [], "E3");
        // 组装后机械微调（减拖拍镜头时长让超时单元回到 15 秒内），再重新校验
        workingShots = await hydrateWorkingShots(context);
        workingShots = await autoRepairUnitDurations(context, workingShots, unitOutput.units);
        unitOutput = await hydrateUnitOutput(context);
        hardIssues = validatePipeline(context, workingShots, unitOutput.units);
      } else if (e5Skip) {
        // 表格与校验结果未变化：跳过模型复审（零 Token），问题卡与放行状态保持上一轮
        const openBlockers = await prisma.workflowIssue.count({
          where: { projectId, episodeId, status: "OPEN", severity: "BLOCKER" }
        });
        released = openBlockers === 0;
      } else {
        // E5 审查总控：问题卡落库 + 裁定；无 BLOCKER 才编译放行。
        // 用当前表重算硬校验（整批修复时前置岗位刚改过表，起始快照已过期）
        const currentUnits = await hydrateUnitOutput(context);
        const currentHard = validatePipeline(context, workingShots, currentUnits.units);
        unitOutput = currentUnits;
        const review = requireE5(result!.data);
        const pictureOfShot = new Map(
          workingShots.map((shot) => [shot.shot_id, composeShotCells({
            e1: shot.e1 as Record<string, unknown>,
            e2: shot.e2 as Record<string, unknown>,
            e3: shot.e3 as Record<string, unknown>,
            e4: shot.e4 as Record<string, unknown>
          }).picture])
        );
        const cameraOfShot = new Map(
          workingShots.map((shot) => [shot.shot_id, composeShotCells({
            e1: shot.e1 as Record<string, unknown>,
            e2: shot.e2 as Record<string, unknown>,
            e3: shot.e3 as Record<string, unknown>,
            e4: shot.e4 as Record<string, unknown>
          }).camera_motion])
        );
        const reviewIssues = filterPythonDuplicateReviewIssues(currentHard, normalizeReviewIssues(review.issues))
          .map((item) => {
            // 数字、格式、单元链接等明确 Python-owned 规则只认 Python；叙事/生成语义 BLOCKER
            // （因果、绑定、站位、光影、机位）可以独立成立，不能因同坐标未命中而总降级。
            const pythonOwnedCodes = new Set([
              "DURATION_OVER_LIMIT",
              "SHOT_DURATION_OVER_LIMIT",
              "SPEECH_RATE_OVER_LIMIT",
              "UNIT_DURATION_OVER_LIMIT",
              "UNIT_DURATION_MISMATCH",
              "UNIT_FIELDS_INCOMPLETE",
              "SHORT_UNIT_REASON_INVALID",
              "UNIT_OVERLAP",
              "SHOT_OVERLAP",
              "UNIT_GAP",
              "SHOT_ORDER_DUPLICATE",
              "SHOT_ID_DUPLICATE",
              "SHOT_UNIT_LINK_INVALID",
              "DIALOGUE_SPLIT",
              "DIALOGUE_INCOMPLETE"
            ]);
            if (pythonOwnedCodes.has(item.code)) {
              return { ...item, severity: item.severity === "BLOCKER" ? "MAJOR" : item.severity };
            }
            // 编号泄漏：Python 机械核对画面文本里有没有真实节点ID（N0000 形式）；没有就是误报
            if (item.coordinate.endsWith(".picture") && /编号泄漏/.test(item.evidence)) {
              const shotKey = item.coordinate.split(".")[0];
              const text = pictureOfShot.get(shotKey) ?? "";
              if (!/N\d{4}/.test(text)) {
                return { ...item, severity: item.severity === "BLOCKER" ? "MINOR" : item.severity };
              }
            }
            // 机位误报佐证：模型称"缺焦点/缺角度"但实际 camera_motion 同时含焦点与角度描述
            // → 事实佐证缺失（实测 07:47 轮 E5 对 S028-S048 共 14 镜全开 CAMERA_ANGLE_MISSING，
            //   实际每镜都有"焦点从…滑到…"），降 MINOR 不再作为可执行建议
            if (item.coordinate.endsWith(".camera_motion") && /缺焦点|缺角度|缺机位/.test(item.evidence)) {
              const shotKey = item.coordinate.split(".")[0];
              const camera = cameraOfShot.get(shotKey) ?? "";
              const hasFocus = /焦点/.test(camera);
              const hasAngle = /(正面|侧面|过肩|背面|平视|仰视|俯视|微仰|微俯|全景|远景|中景|近景|特写)/.test(camera);
              if (hasFocus && hasAngle) {
                return { ...item, severity: "MINOR" as const };
              }
            }
            return item;
          });
        const allIssues = [...currentHard, ...reviewIssues];
        const blockers = allIssues.filter((item) => item.severity === "BLOCKER");
        // 放行裁定：0 条 BLOCKER 即放行（MAJOR/MINOR 是容忍项，只记录不阻塞）；E5 升级 admin_attention 时尊重升级
        released = blockers.length === 0 && review.decision !== "admin_attention";
        if (review.decision === "pass" && !released) {
          allIssues.push({
            coordinate: "E5.release",
            code: "FALSE_RELEASE_BLOCKED",
            severity: "BLOCKER",
            ownerRole: "E5",
            expected: "Python无阻断错误且审查专业通过后才放行",
            evidence: `blockers=${blockers.length}, verdict=${review.verdict}`,
            requestedEffect: "按坐标处理问题后重新审查，禁止直接放行"
          });
        }
        await persistReviewIssues(context, allIssues, {
          hardIssueKeys: new Set(currentHard.map(workflowIssueKey)),
          // 输出打满上限时可能截断；宁可旧卡多留一轮，也不把“未输出”误判为“已修复”。
          reviewedIssueKeys: e5ReviewedIssueKeys,
          resolveReviewedIssues: review.issues.length < E5_REVIEW_ISSUE_LIMIT
        });
      }

      // 每轮都编译一次 Seedance 提示词（纯 TS 确定性编译，零 Token）：
      // 任何岗位跑完都能立刻在单元卡看到最新可投喂稿；E5 全绿才标为正式放行。
      await assertApprovedContextCurrent(context);
      await compileAndPersistPrompts(context, workingShots, unitOutput.units, { release: released });

      const finishedAt = new Date();
      // 发起时元数据（整批修复/单岗位等标记）在 run 更新时保留，供收敛门禁与日志区分轮次
      const initiatedMeta = (() => {
        const raw = safeParseJson(run.inputSummary);
        if (!raw) return null;
        if (raw.repairPipeline === true || raw.singleStage === true || raw.foundation === true) {
          return {
            repairPipeline: raw.repairPipeline === true,
            openBlockers: raw.openBlockers,
            openMajors: raw.openMajors,
            includeSuggestions: raw.includeSuggestions === true,
            structuralRebuild: raw.structuralRebuild === true,
            openBlockerCoords: raw.openBlockerCoords,
            openBlockerKeys: raw.openBlockerKeys,
            singleStage: raw.singleStage === true,
            foundation: raw.foundation === true
          };
        }
        return null;
      })();
      await assertApprovedContextCurrent(context);
      await prisma.pipelineRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCEEDED",
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          // 保留发起时元数据（repairPipeline/openBlockers/openMajors/includeSuggestions），供收敛门禁读取
          inputSummary: JSON.stringify({
            batchToken,
            foundationApprovalId: context.foundationApprovalId,
            inputChars: inputCharsTotal,
            sessionId: result?.sessionId ?? null,
            fingerprint,
            skipped: e5Skip,
            scriptFingerprint: stage.code === "E1" ? scriptFingerprint(context) : undefined,
            ...(initiatedMeta ?? {})
          }),
          outputSummary: result ? JSON.stringify(result.data, null, 2) : JSON.stringify({ skipped: true, reason: "表格与校验结果未变化，跳过模型复审" }),
          log: JSON.stringify(result ? { sessionId: result.sessionId, stderr: result.stderr.slice(-12_000), events: result.stdout.slice(-24_000) } : { skipped: true })
        }
      });
    } catch (error) {
      const finishedAt = new Date();
      // 存完整堆栈（不只 message），异常定位不靠猜
      const message = error instanceof Error ? `${error.stack ?? error.message}` : String(error);
      await prisma.pipelineRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          error: message
        }
      });
      await cancelQueuedBatch(projectId, episodeId, batchToken, `因${stage.code}失败停止：${message}`);
      // 修复轮阶段异常（如机械层崩）同样回滚快照：persistE1 等是逐行写入的，
      // 中途抛错会留下部分写入的脏数据，不回滚会导致后续修复基于脏表（越修越坏）
      if (repairSnapshot && (options.stages?.length ?? 0) > 0) {
        await restoreEpisodeSnapshot(episodeId, repairSnapshot);
      }
      throw error;
    }
  }
  // POST_REPAIR_REGRESSION_GATE：返修批次结束后重跑全量 Gate 口径，比对"修复前 BLOCKER 坐标"——
  // 出现新增 BLOCKER（修复前没有的坐标）说明本轮"修 A 破 B"，标记回归并留提示卡，不允许静默通过
  await checkRepairRegression(projectId, episodeId, batchToken, repairSnapshot);
}

/** 把岗位实际收到的修复卡坐标写入 run.inputSummary（repairCoords）：
 *  回归检测（checkRepairRegression）聚合批次内所有 run 的 repairCoords 作为"命中镜"判定依据——
 *  不依赖 queue 时快照（openCoords 可能因 dev server 未重启/热载失效而缺失，实测 10:50 批次
 *  inputSummary 只有 openBlockerCoords，合法 MAJOR 修复再次被误判越界回滚）。 */
async function recordRepairCoords(run: { id: string; inputSummary: string | null }, coords: Array<string | undefined>) {
  const clean = [...new Set(coords.filter((c): c is string => Boolean(c)))];
  if (!clean.length) return;
  const parsed = safeParseJson(run.inputSummary) ?? {};
  const merged = [...new Set([...(Array.isArray(parsed.repairCoords) ? (parsed.repairCoords as unknown[]).map(String) : []), ...clean])];
  await prisma.pipelineRun.update({
    where: { id: run.id },
    data: { inputSummary: JSON.stringify({ ...parsed, repairCoords: merged }) }
  });
}

/**
 * 返修回归检测（零 Token）+ 事务回滚：修复轮（repairPipeline=true）结束时，若当前 open BLOCKER 中存在
 * 修复前没有的坐标，说明返修引入了新硬错误——自动回滚到批次开始前快照，坏修复不落库。
 */
async function checkRepairRegression(projectId: string, episodeId: string, batchToken: string, snapshot: EpisodeSnapshot | null) {
  const runs = await findBatchRuns(projectId, episodeId, batchToken);
  if (!runs.length) return;
  const first = safeParseJson(runs[0].inputSummary);
  if (first?.repairPipeline !== true) return; // 只查返修批次
  const structuralRebuild = first.structuralRebuild === true;
  const nowOpen = await prisma.workflowIssue.findMany({
    where: { episodeId, status: "OPEN", severity: "BLOCKER" },
    select: { coordinate: true, code: true }
  });
  const newBlockerKeys = newRegressionBlockerKeys({
    beforeKeys: Array.isArray(first.openBlockerKeys) ? first.openBlockerKeys.map(String) : undefined,
    beforeCoordinates: Array.isArray(first.openBlockerCoords) ? first.openBlockerCoords.map(String) : undefined,
    current: nowOpen
  });
  const newBlockerKeySet = new Set(newBlockerKeys);
  const newBlockers = nowOpen.filter((issue) => newBlockerKeySet.has(workflowIssueKey(issue)));
  // 只回滚"修复真正引入的新 BLOCKER"（真·修 A 破 B）——用快照对比判定：
  // newBlocker 坐标的镜，若修复后的相关字段与修复前快照**完全一致**，则该问题修复前就存在
  //（存量问题被 E5 全表重算暴露，如 S008/S013/S034 的台词/时长错位——之前 E5 用内存表漏检
  //  从未开卡），不是本轮修复引入 → 不回滚，修复成果保留。
  // 只有"修复改变了该镜"且该镜出现了新 BLOCKER 才是修 A 破 B → 回滚。
  const currentShots = await prisma.storyboardShot.findMany({ where: { episodeId } });
  const currentByKey = new Map(currentShots.map((shot) => [shot.shotKey, shot]));
  const snapshotByKey = new Map((snapshot?.shots ?? []).map((shot) => [String((shot as Record<string, unknown>).shotKey ?? ""), shot as Record<string, unknown>]));
  const same = (a: unknown, b: unknown) => String(a ?? "") === String(b ?? "");
  const snapshotUnits = new Map(
    (snapshot?.units ?? []).map((unit) => {
      const row = unit as Record<string, unknown>;
      return [String(row.unitKey ?? row.unit_id ?? ""), row];
    })
  );
  const currentUnits = await prisma.seedanceUnit.findMany({ where: { episodeId }, select: { unitKey: true, data: true } });
  const currentUnitsByKey = new Map(currentUnits.map((unit) => [unit.unitKey, unit]));
  // REPAIR_SCOPE_HASH（顾问要求）：修复轮不得改动未命中坐标的字段——
  // 对比快照与当前：非命中镜的任何 e1-e4/duration/dialogue 变化 = 越界修改 = 回滚
  // 命中集合 = 批次内各修复岗位实际收到的卡坐标（repairCoords，执行时记录，最准确）
  // → 兜底 queue 时快照 openCoords（含 MAJOR）→ 再兜底 openBlockerCoords（只 BLOCKER）
  const aggregatedRepairCoords = new Set<string>();
  for (const run of runs) {
    const parsed = safeParseJson(run.inputSummary);
    if (Array.isArray(parsed?.repairCoords)) {
      for (const coord of (parsed.repairCoords as unknown[]).map(String)) aggregatedRepairCoords.add(coord);
    }
  }
  const scopeCoords = aggregatedRepairCoords.size
    ? [...aggregatedRepairCoords]
    : Array.isArray(first.openCoords)
      ? (first.openCoords as unknown[]).map(String)
      : Array.isArray(first.openBlockerCoords)
        ? (first.openBlockerCoords as unknown[]).map(String)
        : [];
  const hitShotKeys = new Set<string>();
  for (const coord of scopeCoords) hitShotKeys.add(coord.split(".")[0]);
  const scopeViolations: string[] = [];
  if (repairRunPolicy(structuralRebuild).enforceScopeGate) {
    for (const snap of snapshot?.shots ?? []) {
      const row = snap as Record<string, unknown>;
      const key = String(row.shotKey ?? "");
      if (hitShotKeys.has(key)) continue;
      const current = currentByKey.get(key);
      if (!current) { scopeViolations.push(`${key}（修复新增镜）`); continue; }
      const snapStr = JSON.stringify([row.e1Data, row.e2Data, row.e3Data, row.e4Data, row.duration, row.dialogue]);
      const curStr = JSON.stringify([current.e1Data, current.e2Data, current.e3Data, current.e4Data, current.duration, current.dialogue]);
      if (snapStr !== curStr) scopeViolations.push(key);
    }
  }
  const genuineNew = newBlockers.filter((blocker) => {
    const coordinate = blocker.coordinate;
    const key = coordinate.split(".")[0];
    // 单元卡（坐标含 -U）：修复轮若没跑 E3，单元字段不会变 → 存量 → 不回滚
    if (key.includes("-U")) {
      const snapUnit = snapshotUnits.get(key);
      const currentUnit = currentUnitsByKey.get(key);
      if (!snapUnit || !currentUnit) return true;
      return !same(currentUnit.data, String(snapUnit.data ?? ""));
    }
    if (coordinate.startsWith("source_node.")) {
      const nodeId = coordinate.slice("source_node.".length);
      return sourceNodeCarrierChanged(nodeId, snapshot?.shots ?? [], currentShots);
    }
    const current = currentByKey.get(key);
    const snap = snapshotByKey.get(key);
    if (!snap) return true; // 快照无此镜（修复新增镜）→ 回滚
    if (!current) return true; // 当前无此镜 → 回滚
    // 按卡类型对比相关字段：一致 = 修复没动它 = 存量
    if (coordinate.includes(".duration")) return !same(current.duration, snap.duration);
    if (coordinate.includes(".dialogue")) return !same(current.dialogue, snap.dialogue);
    if (coordinate.includes(".picture")) return !same(current.e1Data, snap.e1Data) || !same(current.e2Data, snap.e2Data);
    if (coordinate.includes(".sound") || coordinate.includes(".transition")) return !same(current.e3Data, snap.e3Data);
    if (coordinate.includes(".camera") || coordinate.includes(".lighting")) return !same(current.e4Data, snap.e4Data);
    return !same(current.e1Data, snap.e1Data) || !same(current.e2Data, snap.e2Data);
  });
  const genuineNewKeys = genuineNew.map(workflowIssueKey);
  if (!shouldRollbackRepairRegression({ structuralRebuild, genuineNewBlockerKeys: genuineNewKeys, scopeViolations })) {
    if (!newBlockers.length) return;
    // 新增卡全是存量暴露且无越界修改：不回滚，只记录（供日志排查）
    const lastRunInfo = runs.find((run) => run.stageCode === "E5") ?? [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    await prisma.pipelineRun.update({
      where: { id: lastRunInfo.id },
      data: { outputSummary: JSON.stringify({ ...safeParseJson(lastRunInfo.outputSummary), regression: { newBlockers: newBlockerKeys, count: newBlockerKeys.length, rolledBack: false, note: "存量问题暴露，非修复引入，不回滚" } }) }
    });
    return;
  }
  if (scopeViolations.length && !genuineNew.length && !structuralRebuild) {
    // 无新增命中镜 BLOCKER，但存在未命中镜的越界修改（REPAIR_SCOPE_HASH 违规）→ 回滚
    const lastRunInfo = runs.find((run) => run.stageCode === "E5") ?? [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    await prisma.pipelineRun.update({
      where: { id: lastRunInfo.id },
      data: { outputSummary: JSON.stringify({ ...safeParseJson(lastRunInfo.outputSummary), regression: { newBlockers: scopeViolations, count: scopeViolations.length, rolledBack: true, note: "REPAIR_SCOPE_VIOLATION：未命中坐标字段被修改" } }) }
    });
    await restoreEpisodeSnapshot(episodeId, snapshot!);
    await prisma.apiRoleSession.deleteMany({ where: { episodeId } });
    return;
  }
  // 回归标记优先写 E5 复审 run（同批次 createdAt 相同，按时间戳排序不稳定，会随机落到 E1）
  const lastRun = runs.find((run) => run.stageCode === "E5") ?? [...runs].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  const output = safeParseJson(lastRun.outputSummary) ?? {};
  if (snapshot) {
    // 事务回滚：恢复批次开始前的全表状态
    await restoreEpisodeSnapshot(episodeId, snapshot);
    // 清岗位会话历史：被回滚的坏输出会留在会话里诱导下一轮重复同样的坏修复
    //（实测 19:15 与 19:30 轮 E1 输出完全相同的 dialogue patches，死循环根源）
    await prisma.apiRoleSession.deleteMany({ where: { episodeId } });
    await prisma.pipelineRun.update({
      where: { id: lastRun.id },
      data: { outputSummary: JSON.stringify({ ...output, regression: { newBlockers: genuineNewKeys, count: genuineNewKeys.length, rolledBack: true } }) }
    });
    const existingCard = await prisma.workflowIssue.findFirst({
      where: { episodeId, coordinate: "E5.repair_regression", code: "REPAIR_REGRESSION", status: "OPEN" }
    });
    if (!existingCard) {
      await prisma.workflowIssue.create({
        data: {
          projectId,
          episodeId,
          coordinate: "E5.repair_regression",
          code: "REPAIR_REGRESSION",
          severity: "MINOR",
          status: "OPEN",
          ownerRole: "SYSTEM",
          expected: "返修轮不得引入新的硬错误",
          evidence: `本轮修复新增 ${newBlockerKeys.length} 个 BLOCKER（${newBlockerKeys.slice(0, 5).join("、")}${newBlockerKeys.length > 5 ? "…" : ""}），已自动回滚到修复前状态`,
          requestedEffect: "人工评估：确认是误报可「确认保留」后重试；否则调整策略（如重置重跑）",
          revision: `ROLLBACK_${new Date().toISOString().slice(0, 10)}`
        }
      });
    }
  } else {
    await prisma.pipelineRun.update({
      where: { id: lastRun.id },
      data: { outputSummary: JSON.stringify({ ...output, regression: { newBlockers, count: newBlockers.length } }) }
    });
  }
}

type EpisodeSnapshot = {
  shots: Array<Record<string, unknown>>;
  units: Array<Record<string, unknown>>;
  unitShots: Array<Record<string, unknown>>;
  prompts: Array<Record<string, unknown>>;
  issues: Array<Record<string, unknown>>;
};

async function snapshotEpisode(episodeId: string): Promise<EpisodeSnapshot> {
  const [shots, units, unitShots, prompts, issues] = await Promise.all([
    prisma.storyboardShot.findMany({ where: { episodeId } }),
    prisma.seedanceUnit.findMany({ where: { episodeId } }),
    prisma.seedanceUnitShot.findMany({ where: { unit: { episodeId } } }),
    prisma.compiledPromptVersion.findMany({ where: { unit: { episodeId } } }),
    prisma.workflowIssue.findMany({ where: { episodeId } })
  ]);
  return { shots, units, unitShots, prompts, issues };
}

/** 事务回滚：清空并重建为快照状态（保留原 id，历史提示词版本一并恢复）。 */
async function restoreEpisodeSnapshot(episodeId: string, snapshot: EpisodeSnapshot) {
  await prisma.compiledPromptVersion.deleteMany({ where: { unit: { episodeId } } });
  await prisma.seedanceUnitShot.deleteMany({ where: { unit: { episodeId } } });
  await prisma.seedanceUnit.deleteMany({ where: { episodeId } });
  await prisma.storyboardShot.deleteMany({ where: { episodeId } });
  await prisma.workflowIssue.deleteMany({ where: { episodeId } });
  for (const row of snapshot.shots) {
    await prisma.storyboardShot.create({ data: row as never });
  }
  for (const row of snapshot.units) {
    await prisma.seedanceUnit.create({ data: row as never });
  }
  for (const row of snapshot.unitShots) {
    await prisma.seedanceUnitShot.create({ data: row as never });
  }
  for (const row of snapshot.prompts) {
    await prisma.compiledPromptVersion.create({ data: row as never });
  }
  for (const row of snapshot.issues) {
    await prisma.workflowIssue.create({ data: row as never });
  }
}

export async function failActiveBatch(projectId: string, episodeId: string, batchToken: string, reason: string) {
  const runs = await findBatchRuns(projectId, episodeId, batchToken);
  await prisma.pipelineRun.updateMany({
    where: { id: { in: runs.filter((run) => run.status === "RUNNING" || run.status === "QUEUED").map((run) => run.id) } },
    data: { status: "FAILED", finishedAt: new Date(), error: reason }
  });
}

async function launchWorker(projectId: string, episodeId: string, batchToken: string, singleStage?: string, stageList?: string) {
  const executable = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  const script = path.join(process.cwd(), "scripts", "run-episode-pipeline.ts");
  const args = [script, projectId, episodeId, batchToken];
  if (singleStage) args.push(singleStage);
  if (stageList) args.push(stageList);
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    detached: true,
    stdio: "ignore"
  });
  // 记录 worker 进程 PID（进程组组长）：页面「停止」按钮用它 kill 整个 detached 进程组
  //（tsx wrapper + 实际 node 进程同组），没有它只能等批次跑完或从命令行杀进程
  const pid = child.pid;
  if (pid) {
    try {
      const runs = await prisma.pipelineRun.findMany({
        where: { projectId, episodeId, inputSummary: { contains: batchToken } },
        select: { id: true, inputSummary: true }
      });
      for (const run of runs) {
        const parsed = safeParseJson(run.inputSummary) ?? {};
        if (parsed.workerPid !== pid) {
          await prisma.pipelineRun.update({
            where: { id: run.id },
            data: { inputSummary: JSON.stringify({ ...parsed, workerPid: pid }) }
          });
        }
      }
    } catch {
      // PID 记录失败不影响批次执行，仅失去页面停止能力
    }
  }
  child.unref();
}

/** 锁定剧本指纹：场景与节点文本的哈希，剧本一变全部失效。 */
function scriptFingerprint(context: PipelineContext): string {
  return crypto.createHash("sha1")
    .update(JSON.stringify(context.sourcePackage.scenes.map((scene) => ({
      scene_id: scene.scene_id,
      nodes: scene.source_nodes.map((node) => ({
        source_node_id: node.source_node_id,
        type: node.type,
        speaker: node.speaker,
        performance_cue: node.performance_cue ?? null,
        text: node.text,
        raw: node.raw
      }))
    }))))
    .digest("hex");
}

export async function loadPipelineContext(projectId: string, episodeId: string) {
  const episode = await prisma.episode.findFirst({
    where: { id: episodeId, projectId },
    include: {
      project: { include: { assets: { orderBy: [{ type: "asc" }, { code: "asc" }] } } },
      scriptScenes: { orderBy: { sortOrder: "asc" } },
      taskPackages: { orderBy: { createdAt: "desc" }, take: 1 },
      storyboardShots: { select: { revision: true } },
      seedanceUnits: { include: { promptVersions: { select: { version: true } } } }
    }
  });
  if (!episode) throw new Error("没有找到本集数据。");
  const approved = await requireApprovedFoundation(projectId);
  const packet = await readApprovedEpisodeFoundation(projectId, episode.number);
  const approvedCodes = new Set(packet.assetCodes);
  const episodeAssets = episode.project.assets.filter((asset) => approvedCodes.has(asset.code));
  if (episodeAssets.length !== approvedCodes.size) throw new Error("第一阶段批准身份缺失，请重新核对资产与批准包。");
  if (!episode.scriptScenes.length) throw new Error("本集场次结构为空，请先更新本集信息包。");

  // 表现规范（用户已确认）：项目级 + 本集级，注入各岗 input
  const contracts = await prisma.presentationContract.findMany({
    where: { projectId, status: "CONFIRMED" },
    orderBy: { createdAt: "asc" }
  });
  const existingVersions = episode.seedanceUnits.flatMap((unit) => unit.promptVersions.map((version) => version.version));
  const version = Math.max(0, ...existingVersions) + 1;
  const now = new Date();
  const stamp = `${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const knownCharacterNames = episodeAssets
    .filter((asset) => ["CH", "GROUP", "BEAST"].includes(asset.type))
    .flatMap((asset) => {
      const metadata = safeParseJson(asset.metadata);
      const aliases = Array.isArray(metadata.aliases) ? metadata.aliases.map(String) : [];
      return [asset.name, ...aliases];
    });
  const sourcePackage = buildSourcePackage(episode.scriptScenes, { knownCharacterNames });
  // E0 叙事骨架（EP-N-BEATS，schema E0_BEATS_V2）：sequences 两层结构 + 每 beat 容量底盘/视觉步骤
  const beatSnapshot = await prisma.sceneSnapshot.findFirst({
    where: { projectId, episodeId, sceneKey: `EP-${episode.number}-BEATS` }
  });
  const beatsRaw = beatSnapshot ? safeParseJson(beatSnapshot.content) : null;
  const sequencesRaw = Array.isArray(beatsRaw?.sequences)
    ? (beatsRaw.sequences as Record<string, unknown>[])
    : Array.isArray(beatsRaw?.beats)
      ? [{ sequence_id: "S01", title: "本集", causal_chain: "", node_range: [1, sourcePackage.scenes.reduce((sum, s) => sum + s.source_nodes.length, 0)], beats: beatsRaw.beats }]
      : [];
  const sequences = sequencesRaw.map((rawSeq) => ({
    sequence_id: String(rawSeq.sequence_id ?? "S01"),
    title: String(rawSeq.title ?? ""),
    causal_chain: String(rawSeq.causal_chain ?? ""),
    node_range: (Array.isArray(rawSeq.node_range) ? rawSeq.node_range.map(Number) : [1, 1]) as [number, number],
    beats: (Array.isArray(rawSeq.beats) ? rawSeq.beats : []).map((rawBeat) => {
      const beat = rawBeat as Record<string, unknown>;
      return {
        beat_id: String(beat.beat_id ?? ""),
        sequence_id: String(rawSeq.sequence_id ?? "S01"),
        title: String(beat.title ?? ""),
        node_range: (Array.isArray(beat.node_range) ? beat.node_range.map(Number) : [1, 1]) as [number, number],
        drama_function: String(beat.drama_function ?? ""),
        capacity: beat.capacity as Record<string, unknown>,
        target_shots: Number(beat.target_shots ?? beat.max_shots ?? 3),
        max_shots: Number(beat.max_shots ?? beat.target_shots ?? 5),
        target_seconds: Number(beat.target_seconds ?? beat.shot_budget_seconds ?? 10),
        max_seconds: Number(beat.max_seconds ?? beat.target_seconds ?? 15),
        visual_steps: (Array.isArray(beat.visual_steps) ? beat.visual_steps : []).map((step) => step as Record<string, unknown>),
        anchor_nodes: Array.isArray(beat.anchor_nodes) ? beat.anchor_nodes.map(Number) : []
      } as E0Beat;
    })
  })) as E0Sequence[];
  // 扁平 beats（兼容现有 BEAT_BOUNDARY/BEAT_SHOT_OVERFLOW 校验）
  const beats = sequences.flatMap((seq) => seq.beats);

  return {
    projectId,
    episodeId,
    foundationApprovalId: approved.id,
    revision: `V${version}_${stamp}`,
    project: { ...episode.project, assets: episodeAssets },
    contracts: contracts.map((contract) => ({
      category: contract.category,
      question: contract.question,
      user_answer: contract.userAnswer ?? ""
    })),
    episode,
    scenes: episode.scriptScenes,
    sourcePackage,
    sourceNodes: new Map(sourcePackage.scenes.flatMap((scene) => scene.source_nodes).map((node) => [node.source_node_id, node])),
    taskPayload: buildApprovedFoundationContext(packet),
    sequences,
    beats
  };
}

/** 给锁定剧本的每个源节点注入全局序号 seq（与 E0 输入的 nodeList.seq 及 BEAT_BOUNDARY 校验编号完全一致）。
 *  E1 拿到 beats.node_range=[1,7] 时必须能定位到具体节点，否则"只在 Beat 内拆镜"无从谈起。 */
function annotateSourceNodes(sourcePackage: PipelineContext["sourcePackage"]): PipelineContext["sourcePackage"] {
  let seq = 0;
  return {
    ...sourcePackage,
    scenes: sourcePackage.scenes.map((scene) => ({
      ...scene,
      source_nodes: scene.source_nodes.map((node) => {
        seq++;
        return { ...node, seq };
      })
    }))
  };
}

/** CAPACITY PREFLIGHT：E0 的机械容量底盘（顾问要求）——预算不得低于它。 */
export type BeatCapacity = {
  /** 对白/OS/VO/旁白/系统节点有效字符数（去标点） */
  dialogue_chars: number;
  /** 对白最小时长（秒）：字数 ÷ 6字/秒（字速上限），向上取整到 0.1s */
  dialogue_min_seconds: number;
  /** 最低对白镜数：字数 ÷ 42字/镜（单镜台词上限） */
  min_dialogue_shots: number;
  /** 非对白动作节点数 */
  action_node_count: number;
  /** 硬下限镜数：对白镜 + 动作镜（每 2 个动作可并 1 镜，至少 1 镜） */
  hard_min_shots: number;
  /** 硬下限时长（秒）：对白最小时长 + 动作节点数 × 1.5s/节点 */
  hard_min_seconds: number;
};

const DIALOGUE_NODE_TYPES = new Set(["DIALOGUE", "OS", "VO", "NARRATION", "SYSTEM"]);

/** 按节点列表机械计算容量底盘（对白字数/最小时长/最低镜数）。 */
export function computeBeatCapacity(nodes: Array<{ type: string; text: string }>): BeatCapacity {
  let dialogueChars = 0;
  let actionCount = 0;
  for (const node of nodes) {
    const chars = spokenCharCount(String(node.text ?? ""));
    if (DIALOGUE_NODE_TYPES.has(String(node.type))) dialogueChars += chars;
    else if (String(node.type) === "ACTION") actionCount++;
  }
  const dialogueMinSeconds = ceilTenth(dialogueChars / 6);
  const minDialogueShots = Math.max(1, Math.ceil(dialogueChars / 42));
  const actionShots = Math.max(1, Math.ceil(actionCount / 2));
  return {
    dialogue_chars: dialogueChars,
    dialogue_min_seconds: dialogueMinSeconds,
    min_dialogue_shots: minDialogueShots,
    action_node_count: actionCount,
    hard_min_shots: minDialogueShots + actionShots,
    hard_min_seconds: ceilTenth(dialogueMinSeconds + actionCount * 1.5)
  };
}

/** E0 输出的 Beat（钳制后）：容量底盘 + 导演预算 + 视觉步骤合同。 */
export type E0Beat = {
  beat_id: string;
  sequence_id: string;
  title: string;
  node_range: [number, number];
  drama_function: string;
  capacity: BeatCapacity;
  target_shots: number;
  max_shots: number;
  target_seconds: number;
  max_seconds: number;
  /** DIRECTOR_CONTRACT：可验收的视觉升级步骤（E1 每镜声明 fulfills_visual_step，E5 逐项验收） */
  visual_steps: Array<{ step_id: string; label: string; directive: string }>;
  anchor_nodes: number[];
};

export type E0Sequence = {
  sequence_id: string;
  title: string;
  causal_chain: string;
  node_range: [number, number];
  beats: E0Beat[];
};

function buildStageInput(
  stage: PipelineStageCode,
  context: PipelineContext,
  shots: WorkingShot[],
  e5: E3UnitOutput,
  hardIssues: PipelineIssue[],
  revisionIssues: Array<{ coordinate: string; code: string; evidence: string; requested_effect: string }> = []
) {
  const base = { base_revision: context.revision };
  const presentationContracts = context.contracts.length
    ? context.contracts.map((contract) => ({ category: contract.category, user_answer: contract.user_answer }))
    : [];
  if (stage === "E0") {
    const nodeList = context.sourcePackage.scenes.flatMap((scene) =>
      scene.source_nodes.map((node) => ({
        seq: nodeSeqOf(context, node.source_node_id),
        scene_id: scene.scene_id,
        type: node.type,
        speaker: node.speaker,
        performance_cue: node.performance_cue ?? null,
        text: node.text
      }))
    ).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
    // CAPACITY PREFLIGHT：机械容量底盘（对白字数/最小时长/最低镜数），E0 的导演预算不得低于它
    const capacityPreflight = context.sourcePackage.scenes.map((scene) => ({
      scene_id: scene.scene_id,
      node_count: scene.source_nodes.length,
      ...computeBeatCapacity(scene.source_nodes)
    }));
    const totalCapacity = computeBeatCapacity(nodeList);
    return {
      ...base,
      episode_number: context.episode.number,
      project_memory: compactFirstPhaseContext(context.taskPayload),
      nodes: nodeList,
      capacity_preflight: {
        total: totalCapacity,
        per_scene: capacityPreflight,
        // 整集目标时长参考：对白最小时长 + 画面/表演空间（≈台词下限的 1.35 倍，参考值）
        suggested_target_seconds: Math.round(ceilTenth(totalCapacity.hard_min_seconds * 1.35))
      },
      ...(presentationContracts.length ? { presentation_contracts: presentationContracts } : {})
    };
  }
  if (stage === "E1") {
    return {
      ...base,
      episode: { number: context.episode.number, title: context.episode.title },
      locked_script: annotateSourceNodes(context.sourcePackage),
      // E0 叙事骨架（Sequence→Beat 两层）：每 beat 带容量底盘/导演预算/视觉步骤合同
      ...(context.sequences.length ? { sequences: context.sequences } : {}),
      project: { style: context.project.style, aspect_ratio: context.project.aspectRatio },
      asset_index: context.project.assets.map((asset) => ({ id: asset.code, type: asset.type, name: asset.name, status: asset.status })),
      ...(presentationContracts.length ? { presentation_contracts: presentationContracts } : {}),
      episode_context: compactFirstPhaseContext(context.taskPayload),
      ...(revisionIssues.length ? { revision_issues: revisionIssues } : {})
    };
  }
  if (stage === "E2") {
    const visualStepParts = visualStepPartsForShots(context, shots);
    const visualStepByShot = new Map(visualStepParts.map((part) => [part.shot_id, part]));
    const visualStepContracts = new Map<string, Pick<ResolvedVisualStep, "ref" | "beat_id" | "step_id" | "label" | "directive">>();
    for (const part of visualStepParts) {
      const resolved = part;
      visualStepContracts.set(resolved.ref, {
        ref: resolved.ref,
        beat_id: resolved.beat_id,
        step_id: resolved.step_id,
        label: resolved.label,
        directive: resolved.directive
      });
    }
    const rows = trimmedShotRows(shots, [
      ["e1", ["shot_function", "visual_goal", "picture", "rough_camera"]]
    ]).map((row) => {
      const shot = shots.find((item) => item.shot_id === row.shot_id);
      if (!shot) return row;
      const sourceNodeRefs = shotSourceNodeIds(shot);
      const dialogueSlices = compactShotDialogueSlices(context, shot);
      const resolved = visualStepByShot.get(shot.shot_id);
      if (!resolved) {
        return {
          ...row,
          source_node_refs: sourceNodeRefs,
          ...(dialogueSlices.length ? { dialogue_slices: dialogueSlices } : {})
        };
      }
      return {
        ...row,
        source_node_refs: sourceNodeRefs,
        ...(dialogueSlices.length ? { dialogue_slices: dialogueSlices } : {}),
        // directive 只在 visual_step_contracts 中出现一次；镜内只带命名空间与分段序号，
        // 避免同一步骤跨多镜时，每镜都误执行整段导演动作。
        visual_step: {
          ref: resolved.ref,
          beat_id: resolved.beat_id,
          step_id: resolved.step_id,
          label: resolved.label,
          part_index: resolved.part_index,
          part_count: resolved.part_count,
          part_goal: resolved.part_goal
        }
      };
    });
    return {
      ...base,
      // 只发 E2 需要的字段：逐镜 refs + 实际台词切片限定动作范围，完整源节点按引用去重。
      shots: rows,
      source_nodes: referencedNodes(context, shots),
      ...(visualStepContracts.size ? {
        visual_step_contracts: [...visualStepContracts.values()],
        visual_step_execution_rule: "visual_step_contract 是 Beat 级总目标；同一 ref 可跨多镜。本镜只增强自己的 e1.picture、source_node_refs 与 dialogue_slices，禁止补演同一步骤其他镜或未引用节点的动作。"
      } : {}),
      character_assets: assetRows(context, ["CH", "LOOK"]),
      rules: loadStageRules("E2"),
      ...(presentationContracts.length ? { presentation_contracts: presentationContracts } : {}),
      ...(revisionIssues.length ? { revision_issues: revisionIssues } : {})
    };
  }
  if (stage === "E4") {
    // E4 在 E3 之后（单元已划分）：输入带单元窗口，E4 按单元写"合并单元格"级的光影/摄影策略
    const partition = computeUnitPartition(context, shots);
    const unitOfShot = new Map<string, string>();
    for (const part of partition) {
      for (const id of part.shotIds) unitOfShot.set(id, part.unitKey);
    }
    const visualStepParts = visualStepPartsForShots(context, shots);
    const visualStepByShot = new Map(visualStepParts.map((part) => [part.shot_id, part]));
    const visualStepContracts = new Map<string, Pick<ResolvedVisualStep, "ref" | "beat_id" | "step_id" | "label" | "directive">>();
    for (const part of visualStepParts) {
      visualStepContracts.set(part.ref, part);
    }
    const rows = trimmedShotRows(shots, [
      ["e1", ["shot_function", "visual_goal", "picture", "rough_camera"]],
      ["e2", ["picture", "action_chain", "blocking", "emotion"]]
    ]).map((row) => {
      const shot = shots.find((item) => item.shot_id === row.shot_id);
      const vs = shot ? visualStepByShot.get(shot.shot_id) : null;
      return {
        ...row,
        unit_id: unitOfShot.get(String(row.shot_id ?? "")) ?? "",
        ...(vs ? { visual_step: { ref: vs.ref, beat_id: vs.beat_id, step_id: vs.step_id, label: vs.label, part_index: vs.part_index, part_count: vs.part_count, part_goal: vs.part_goal } } : {})
      };
    });
    return {
      ...base,
      project: { style: context.project.style, aspect_ratio: context.project.aspectRatio },
      scene_cards: sceneCards(context),
      unit_windows: partition.map((part) => ({
        unit_id: part.unitKey,
        shot_ids: part.shotIds,
        duration: part.duration,
        needs_short_reason: part.needsReason
      })),
      // 返修轮携带现役 unit_lighting（若有）：模型应"改错处"而不是重写整条布光（整条重写=串台根源）
      ...((e5.units ?? []).length ? {
        existing_unit_lighting: (e5.units ?? [])
          .map((unit) => ({
            unit_id: String((unit as Record<string, unknown>).unit_id ?? ""),
            lighting: String((unit as Record<string, unknown>).unit_lighting ?? "").trim()
          }))
          .filter((item) => item.unit_id && item.lighting)
      } : {}),
      shots: rows,
      ...(visualStepContracts.size ? {
        visual_step_contracts: [...visualStepContracts.values()],
        visual_step_execution_rule: "visual_step_contract 是 Beat 级总目标；同一 ref 可跨多镜。本镜只服务自己的 part_goal，禁止补演同一步骤其他镜或未引用节点的动作。"
      } : {}),
      rules: loadStageRules("E4", { crowd: shots.some(isCrowdShot) }),
      ...(presentationContracts.length ? { presentation_contracts: presentationContracts } : {}),
      ...(revisionIssues.length ? { revision_issues: revisionIssues } : {})
    };
  }
  if (stage === "E3") {
    const partition = computeUnitPartition(context, shots);
    const existing = new Map((e5.units ?? []).map((unit) => [String(unit.unit_id ?? ""), unit]));
    return {
      ...base,
      scene_cards: sceneCards(context),
      assets: assetRows(context, ["CH", "LOOK", "GROUP", "BEAST", "PROP", "LOC"]),
      // Python 已确定性划分单元：E4 只写每个 unit_id 的创作字段，不改镜号归属
      unit_windows: partition.map((part, index) => {
        const current = existing.get(part.unitKey) as Record<string, unknown> | undefined;
        const premise = String(current?.unit_start_premise ?? "");
        const endState = String(current?.unit_end_state ?? "");
        const goal = String(current?.unit_dominant_goal ?? "");
        const needsFields = !current || /待补充|待完善|暂无/.test(`${premise} ${endState} ${goal}`) || !premise || !endState || !goal;
        // 同场次上一单元的结束状态：E4 写本单元 start_premise 时必须与其衔接（形象在场/消失交代）
        let previousEndState: string | null = null;
        for (let prev = index - 1; prev >= 0; prev--) {
          const prevPart = partition[prev];
          if (prevPart.sceneId !== part.sceneId) break;
          previousEndState = String((existing.get(prevPart.unitKey) as Record<string, unknown> | undefined)?.unit_end_state ?? "");
          break;
        }
        return {
          unit_id: part.unitKey,
          shot_ids: part.shotIds,
          duration: part.duration,
          needs_short_reason: part.needsReason,
          needs_fields: needsFields,
          previous_end_state: previousEndState,
          current: current ?? null
        };
      }),
      shots: trimmedShotRows(shots, [
        ["e1", ["shot_function", "visual_goal", "picture"]],
        ["e2", ["picture", "action_chain", "blocking", "emotion"]]
      ]),
      rules: loadStageRules("E3", { crowd: shots.some(isCrowdShot) }),
      ...(presentationContracts.length ? { presentation_contracts: presentationContracts } : {}),
      ...(revisionIssues.length ? { revision_issues: revisionIssues } : {})
    };
  }
  // E5：一次性紧凑证据包。源剧本、E0 合同、资产索引各只出现一次；不发送确定性编译产物。
  const visualStepByShot = safeVisualStepPartsForE5(context, shots);
  return {
    revision: context.revision,
    source_fingerprint: {
      total_nodes: context.sourceNodes.size,
      covered_nodes: coveredNodeCount(shots),
      semantic_hash: scriptFingerprint(context)
    },
    source_nodes: context.sourcePackage.scenes.flatMap((scene) => scene.source_nodes.map((node) => ({
      id: node.source_node_id,
      scene: scene.scene_id,
      type: node.type,
      speaker: node.speaker ?? null,
      performance_cue: node.performance_cue ?? null,
      text: node.text
    }))),
    director_contract: {
      sequences: context.sequences.map((sequence) => ({
        id: sequence.sequence_id,
        node_range: sequence.node_range,
        causal_chain: sequence.causal_chain,
        beats: sequence.beats.map((beat) => ({
          id: beat.beat_id,
          node_range: beat.node_range,
          drama_function: beat.drama_function,
          visual_steps: beat.visual_steps
        }))
      }))
    },
    asset_index: context.project.assets.map((asset) => ({ id: asset.code, type: asset.type, name: asset.name, status: asset.status })),
    shots: shots.map((shot) => {
      const cells = composeShotCells({
        e1: shot.e1 as Record<string, unknown>,
        e2: shot.e2 as Record<string, unknown>,
        e3: shot.e3 as Record<string, unknown>,
        e4: shot.e4 as Record<string, unknown>
      });
      return {
        id: shot.shot_id,
        scene: shot.scene_id,
        duration: shot.duration,
        source_node_refs: shotSourceNodeIds(shot),
        dialogue_slices: compactShotDialogueSlices(context, shot),
        visual_step: (() => {
          const step = visualStepByShot.get(shot.shot_id);
          if (!step) return null;
          if ("invalid" in step) return step;
          return { ref: step.ref, part_goal: step.part_goal, index: step.part_index, count: step.part_count };
        })(),
        field_trace: {
          E1: pickFields(shot.e1 as Record<string, unknown>, ["shot_function", "visual_goal", "picture", "camera_motion", "rough_camera", "sound", "transition", "visible_text", "continuity_id", "beat_id", "visual_step_beat_id", "fulfills_visual_step", "visual_step_part_goal"]),
          E2: pickFields(shot.e2 as Record<string, unknown>, ["picture", "action_chain", "blocking", "emotion"]),
          E3: pickFields(shot.e3 as Record<string, unknown>, ["sound", "transition"]),
          E4: pickFields(shot.e4 as Record<string, unknown>, ["camera_motion", "lighting"])
        },
        final_cells: { picture: cells.picture, camera_motion: cells.camera_motion, sound: cells.sound, transition: cells.transition, dialogue: compactShotDialogueSlices(context, shot), visible_text: (shot.e1 as Record<string, unknown>).visible_text ?? [] }
      };
    }),
    units: e5.units,
    python_hard_checks: hardIssues.map((item) => ({ coordinate: item.coordinate, code: item.code, evidence: item.evidence.slice(0, 120) })),
    approved_exceptions: [],
    rules: loadStageRules("E5", { crowd: shots.some(isCrowdShot) }),
    ...(presentationContracts.length ? { presentation_contracts: presentationContracts } : {}),
    ...(revisionIssues.length ? { open_issues: revisionIssues } : {})
  };
}

function buildStagePrompt(stageCode: PipelineStageCode, input: unknown) {
  const stage = readStageModel(stageCode);
  return [
    `使用 $${stage.skill} 完成当前${stage.code}岗位任务。`,
    "只处理INPUT_JSON，不修改任何本地文件，不输出分析过程、Markdown或自评分。",
    "严格遵守该Skill的字段所有权和Output Contract，只返回一个合法JSON对象。",
    "遇到真实问题按契约开票或输出issue；不得为了过审谎报完成。",
    "INPUT_JSON:",
    JSON.stringify(input)
  ].join("\n\n");
}

/** E1 返修轮提示词：带问题卡，只修命中镜号，不重拆全片。 */
function buildE1RevisionPrompt(input: unknown) {
  return [
    "使用 $e1-structure-director 完成当前E1岗位任务（返修轮）。",
    "**单元格级修复（最重要）**：INPUT_JSON.revision_issues 的每条卡都定位到了具体坐标。**只输出命中坐标对应格子的修正值**，格式为 patches（见下），**禁止输出整镜行、禁止重新拆镜、禁止改未命中格子的内容**。",
    "按坐标类型输出对应字段：",
    "- `.picture` → fields.picture（按 fix_hint 改画面，禁止借未来视觉/抽象情绪）",
    "- `.sound` → fields.sound（清理声音格子的占位符/模板残留，写真实音效；禁止改其它格子）",
    "- `.duration` → fields.duration（直接采用 fix_hint 的数值）",
    "- `.dialogue` / `.speaker` → fields.dialogue_spans（该镜完整台词归属，跨镜切片必须逐字拼接回原文）",
    "- `.visual_step.Vx`（如 B05.visual_step.V4）→ 在该 Beat 内选择一个合适镜号，同时输出 fields.fulfills_visual_step=\"B05.V4\" 与非空 fields.visual_step_part_goal（只写本镜动作结果/视觉贡献）",
    "- `.anchor`（如 1-1-S035.anchor，动作锚点提前）→ 只输出 fields.picture：把该镜画面改回锚点执行前的状态（去掉提前出现的动作），让不可逆动作在锚点节点所属的镜才出现；**禁止改 dialogue_spans / source_node_refs**（改台词归属会破坏节点覆盖）",
    "- 镜号级卡（如 1-1-S005.padding）→ fields.picture 重构该镜画面使其具备独立信息",
    "输出契约：",
    "```jsonc",
    "{",
    "  \"base_revision\": \"...\",",
    "  \"patches\": [",
    "    { \"shot_id\": \"1-1-S045\", \"action\": \"set\", \"fields\": { \"picture\": \"修正后的画面内容\" } },",
    "    { \"shot_id\": \"1-1-S021\", \"action\": \"set\", \"fields\": { \"fulfills_visual_step\": \"B05.V4\", \"visual_step_part_goal\": \"人群后退，苏远在空地显出\" } }",
    "  ],",
    "  \"issues\": [],",
    "  \"status\": \"set\"",
    "}",
    "```",
    "未列出的镜号和未命中的格子**不要输出**。修复后仍满足 E1 时长准则（每镜≤5秒，≤42字台词镜可7秒，字速≤6字/秒）。",
    "只处理INPUT_JSON，不修改任何本地文件，不输出分析过程、Markdown或自评分。",
    "严格遵守该Skill的字段所有权和Output Contract，只返回一个合法JSON对象。",
    "遇到真实问题按契约输出issue；不得为了过审谎报完成。",
    "INPUT_JSON:",
    JSON.stringify(input)
  ].join("\n\n");
}

/** E3 返修轮提示词：只重写命中单元的创作字段；镜号归属由 Python 决定，禁止改动。 */
function buildE3RevisionPrompt(input: unknown) {
  return [
    "使用 $e3-unit-audiovisual-director 完成当前E3岗位任务（返修轮）。",
    "镜号归属与单元时长已由 Python 确定性确定（见 INPUT_JSON.unit_windows），**禁止输出或修改 shot_ids/unit_duration**。",
    "**只重写 revision_issues 命中单元的创作字段**（unit_dominant_goal / unit_start_premise / unit_end_state / short_unit_reason / subject_bindings），按 fix_hint 修复；其余单元原样保留，不要输出。",
    "**命中字段必填**：卡坐标带 `.premise` 或 `.unit_start_premise` 的单元必须输出修正后的 `unit_start_premise`；带 `.end_state` 或 `.unit_end_state` 的必须输出修正后的 `unit_end_state`；带 `.bindings` 的必须输出修正后的 `subject_bindings`；带 `.fields` 的必须输出 goal/premise/end_state 三者。只输出其它字段 = 没修，卡不会被销。",
    "patches 只允许 sound/transition，且只修与命中单元相关镜号；与修复无关的格子禁止改动。",
    "只处理INPUT_JSON，不修改任何本地文件，不输出分析过程、Markdown或自评分。",
    "严格遵守该Skill的字段所有权和Output Contract，只返回一个合法JSON对象。",
    "遇到真实问题按契约输出issue；不得为了过审谎报完成。",
    "INPUT_JSON:",
    JSON.stringify(input)
  ].join("\n\n");
}

/** E2/E4 返修轮提示词：只修命中镜号，输入只含命中镜与相邻镜。 */
function buildE24RevisionPrompt(stageCode: PipelineStageCode, input: unknown) {
  const stage = readStageModel(stageCode);
  const fields = stageCode === "E2" ? "picture / action_chain / emotion / blocking" : "camera_motion / lighting";
  // 本轮被开「单元.lighting」卡的单元：只有它们允许重写 unit_lighting（与机械层 lightingUnitKeys 门控一致）
  const lightingUnits = stageCode === "E4"
    ? [...new Set(
        (((input as Record<string, unknown>)?.revision_issues ?? []) as Array<{ coordinate?: string }>)
          .map((item) => /^(.*?-U\d+)\.lighting$/.exec(String(item.coordinate ?? ""))?.[1])
          .filter((key): key is string => Boolean(key))
      )]
    : [];
  const extra = stageCode === "E4"
    ? lightingUnits.length
      ? `另可输出 unit_lighting：**只允许重写被开「.lighting」卡的单元**（${lightingUnits.join("、")}）；其它单元禁止输出 unit_lighting，保持原样（它们是整片其它单元的光影，越权重写=串台）。`
      : "本轮没有单元光影卡：**禁止输出 unit_lighting**，只修命中镜的 camera_motion / lighting（镜级）。"
    : "";
  return [
    `使用 $${stage.skill} 完成当前${stage.code}岗位任务（返修轮）。`,
    `INPUT_JSON.revision_issues 列出了命中镜号的问题。**只修复这些镜号**：按 evidence / requested_effect 定向修正你负责的格子（${fields}），不越权改其它岗位的列。`,
    "INPUT_JSON.shots 只包含命中镜号及其相邻镜（相邻镜仅供衔接参考）：**只对命中镜号输出 patches**，禁止输出相邻镜的 patch。",
    extra,
    "只处理INPUT_JSON，不修改任何本地文件，不输出分析过程、Markdown或自评分。",
    "严格遵守该Skill的字段所有权和Output Contract，只返回一个合法JSON对象。",
    "遇到真实问题按契约输出issue；不得为了过审谎报完成。",
    "INPUT_JSON:",
    JSON.stringify(input)
  ].filter(Boolean).join("\n\n");
}

/** 返修轮只保留命中场景的锁定剧本：整集剧本重复灌入是纯 token 浪费。 */
function trimLockedScriptForRevision(
  context: PipelineContext,
  issues: Array<{ coordinate: string }>
): Record<string, unknown> {
  const shotSceneIds = new Set(
    issues.map((item) => item.coordinate.split(".")[0])
      .filter((coordinate) => /-\d+-S\d+/.test(coordinate))
      .map((coordinate) => coordinate.split("-S")[0])
  );
  const nodeIds = new Set(
    issues.map((item) => item.coordinate)
      .filter((coordinate) => coordinate.startsWith("source_node."))
      .map((coordinate) => coordinate.slice("source_node.".length))
  );
  if (!shotSceneIds.size && !nodeIds.size) return context.sourcePackage;
  const scenes = context.sourcePackage.scenes.filter(
    (scene) => shotSceneIds.has(scene.scene_id) || scene.source_nodes.some((node) => nodeIds.has(node.source_node_id))
  );
  return { ...context.sourcePackage, scenes: scenes.length ? scenes : context.sourcePackage.scenes };
}

/** E1 分批输出：源节点过多时按批调用（每批 ≤ E1_BATCH_MAX_NODES），把单次输出压到模型安全范围内。
 *  两道安全网兜住"模型不守批次边界"的随机行为：
 *  1) 输出截断（finish_reason=length）→ 该批拆半递归重试，直到批小到模型必然写得完；
 *  2) 主批次跑完后校验覆盖：任何源节点未被镜头引用时，用 ≤5 节点的小批补跑，最多 2 轮，杜绝静默丢节点。 */
async function runE1Chunked(input: {
  context: PipelineContext;
  provider: PipelineProvider;
  projectId: string;
  /** 批大小上限（按模型输出能力由调用方决定：flash 1000 / chat 10 / CLI Infinity） */
  batchSize?: number;
  stageRunner?: PipelineStageRunner;
}) {
  const { context, provider, projectId, stageRunner } = input;
  const baseInput = buildStageInput(
    "E1",
    context,
    [],
    { role: "E3", base_revision: context.revision, patches: [], units: [], issues: [] },
    [],
    []
  ) as Record<string, unknown>;

  const entries: Array<{ scene: (typeof context.sourcePackage.scenes)[number]; node: SourceNode }> = [];
  for (const scene of context.sourcePackage.scenes) {
    for (const node of scene.source_nodes) entries.push({ scene, node });
  }
  const batchSize = input.batchSize ?? (input.provider === "API" ? E1_API_BATCH_MAX_NODES : E1_BATCH_MAX_NODES);
  const batches: Array<typeof entries> = [];
  for (let i = 0; i < entries.length; i += batchSize) batches.push(entries.slice(i, i + batchSize));

  // 每批资产索引只给本批场景命中资产（scene_refs 为空时保留全量，避免漏）
  const batchAssetRows = (batch: typeof entries) => {
    const batchSceneIds = new Set(batch.map((entry) => String(entry.scene.scene_id)));
    const filtered = context.project.assets.filter((asset) => {
      const refs = assetSceneRefsOf(asset.metadata);
      return refs.length === 0 || refs.some((ref) => batchSceneIds.has(ref));
    });
    return filtered.map((asset) => ({ id: asset.code, type: asset.type, name: asset.name, status: asset.status }));
  };

  const allShots: Record<string, unknown>[] = [];
  const allTickets: Record<string, unknown>[] = [];
  let sessionId: string | null = null;
  let stdout = "";
  let stderr = "";
  let inputChars = 0;
  // 压缩上下文块（API 无会话，用它把"上批进度"传给下一批，保持全片节拍/时间线连续）
  let previousContext: Record<string, unknown> = {
    completed_shot_count: 0,
    covered_source_node_ids: [],
    last_shot_by_scene: {}
  };

  // 已覆盖节点（镜头引用 + 台词 span 锚定都算覆盖）
  const coveredNodeIds = () => {
    const covered = new Set<string>();
    for (const shot of allShots) {
      const refs = Array.isArray(shot.source_node_refs) ? shot.source_node_refs.map(String) : [];
      for (const ref of refs) covered.add(ref);
      const spans = Array.isArray(shot.dialogue_spans) ? (shot.dialogue_spans as Array<Record<string, unknown>>) : [];
      for (const span of spans) {
        const id = String(span.source_node_id ?? "");
        if (id) covered.add(id);
      }
    }
    return covered;
  };

  // 单批执行：length 截断时拆半递归重试（模型随机性导致某批输出暴增时的兜底）
  const runBatch = async (opts: {
    nodes: typeof entries;
    batchIndex: number;
    batchCount: number;
    sweep: boolean;
    depth: number;
  }): Promise<{ shots: Record<string, unknown>[]; tickets: Record<string, unknown>[] }> => {
    const { nodes, batchIndex, batchCount, sweep, depth } = opts;
    const batchNodes = new Set(nodes.map((entry) => entry.node.source_node_id));
    const batchInput = {
      ...baseInput,
      asset_index: batchAssetRows(nodes),
      locked_script: {
        scenes: context.sourcePackage.scenes.map((scene) => ({
          ...scene,
          source_nodes: scene.source_nodes.filter((node) => batchNodes.has(node.source_node_id))
        }))
      },
      batch_info: { batch_index: batchIndex, batch_count: batchCount, sweep: sweep ? true : undefined },
      previous_batch_context: previousContext
    };
    const prompt = [
      "使用 $e1-structure-director 完成当前E1岗位任务。",
      sweep
        ? "本次为补漏输出：INPUT_JSON.locked_script 中列出的源节点在之前批次中未被任何镜头覆盖，只输出这些节点的镜头；每节点不超过2镜，宁少勿冗，不要重复已覆盖节点。"
        : batchCount > 1
          ? `本次为分批输出（${batchIndex}/${batchCount}）：只处理 INPUT_JSON.locked_script 中给出的源节点并输出对应镜号；不要输出其它批的镜号，不要重复覆盖 previous_batch_context 中已覆盖的源节点；注意与上批节拍/时间线衔接；镜号编号无需考虑连续性（后台会统一重排）。`
          : "",
      "只处理INPUT_JSON，不修改任何本地文件，不输出分析过程、Markdown或自评分。",
      "严格遵守该Skill的字段所有权和Output Contract，只返回一个合法JSON对象。",
      "遇到真实问题按契约输出issue；不得为了过审谎报完成。",
      "INPUT_JSON:",
      JSON.stringify(batchInput)
    ].filter(Boolean).join("\n\n");
    inputChars += prompt.length;
    try {
      await assertApprovedContextCurrent(context);
      const result = stageRunner
        ? await stageRunner("E1", prompt)
        : provider === "API"
          ? await runApiRoleSession({ projectId, episodeId: context.episodeId, stageCode: "E1", prompt, noSession: true })
          : await runRoleSession({ projectId, episodeId: context.episodeId, stageCode: "E1", prompt, sessionMode: "ephemeral" });
      await assertApprovedContextCurrent(context);
      sessionId = result.sessionId;
      stdout += result.stdout;
      stderr += result.stderr;
      const output = requireE1(result.data);
      return { shots: output.shots ?? [], tickets: output.tickets ?? [] };
    } catch (error) {
      const truncated = error instanceof Error && /finish_reason=length/.test(error.message);
      if (truncated && nodes.length > E1_MIN_BATCH_NODES && depth < E1_MAX_RETRY_DEPTH) {
        const mid = Math.ceil(nodes.length / 2);
        const left = await runBatch({ nodes: nodes.slice(0, mid), batchIndex, batchCount, sweep, depth: depth + 1 });
        const right = await runBatch({ nodes: nodes.slice(mid), batchIndex, batchCount, sweep, depth: depth + 1 });
        return { shots: [...left.shots, ...right.shots], tickets: [...left.tickets, ...right.tickets] };
      }
      throw error;
    }
  };

  // 刷新跨批压缩上下文（主批次与补漏轮共用）
  const refreshPreviousContext = (batchShotIds: string[]) => {
    const covered = coveredNodeIds();
    const byScene: Record<string, string> = {};
    for (const shot of allShots) {
      const sceneId = String(shot.scene_id ?? "");
      if (sceneId) byScene[sceneId] = String(shot.shot_id ?? "");
    }
    previousContext = {
      completed_shot_count: allShots.length,
      covered_source_node_ids: [...covered],
      last_shot_by_scene: byScene,
      previous_batch_shot_ids: batchShotIds
    };
  };

  for (let index = 0; index < batches.length; index++) {
    const out = await runBatch({ nodes: batches[index], batchIndex: index + 1, batchCount: batches.length, sweep: false, depth: 0 });
    allShots.push(...out.shots);
    allTickets.push(...out.tickets);
    refreshPreviousContext(out.shots.map((shot) => String(shot.shot_id ?? "")));
  }

  // 覆盖校验 + 补漏：模型可能在某批偷懒漏节点，最后一批"补齐"时输出暴增截断——改为小批定向补漏，避免把账全压到最后一批
  let sweepRound = 0;
  let pending = entries.filter((entry) => !coveredNodeIds().has(entry.node.source_node_id));
  while (pending.length && sweepRound < E1_SWEEP_MAX_ROUNDS) {
    const sweepBatches: Array<typeof entries> = [];
    for (let i = 0; i < pending.length; i += E1_SWEEP_BATCH_NODES) {
      sweepBatches.push(pending.slice(i, i + E1_SWEEP_BATCH_NODES));
    }
    for (let index = 0; index < sweepBatches.length; index++) {
      const out = await runBatch({
        nodes: sweepBatches[index],
        batchIndex: index + 1,
        batchCount: sweepBatches.length,
        sweep: true,
        depth: 0
      });
      allShots.push(...out.shots);
      allTickets.push(...out.tickets);
      refreshPreviousContext(out.shots.map((shot) => String(shot.shot_id ?? "")));
    }
    sweepRound++;
    pending = entries.filter((entry) => !coveredNodeIds().has(entry.node.source_node_id));
  }
  if (pending.length) {
    throw new Error(
      `E1 分批输出仍有 ${pending.length} 个源节点未被任何镜头覆盖（已补漏 ${E1_SWEEP_MAX_ROUNDS} 轮）：${pending.map((entry) => entry.node.source_node_id).join(",")}`
    );
  }

  // 分批合并后统一重编号：各批模型都会从 S001 重新编号，直接落库会互相覆盖，必须按场次顺序重排
  const seqByScene = new Map<string, number>();
  for (const shot of allShots) {
    const sceneId = String(shot.scene_id ?? "");
    const seq = (seqByScene.get(sceneId) ?? 0) + 1;
    seqByScene.set(sceneId, seq);
    shot.shot_id = `${sceneId}-S${String(seq).padStart(3, "0")}`;
  }

  const merged: E1Output = {
    base_revision: context.revision,
    shots: allShots,
    tickets: allTickets,
    status: "set"
  };
  return { output: merged, sessionId, stdout, stderr, inputChars, batches: batches.length };
}

/** API 执行模式（DeepSeek）岗位调用：Skill 制度稿作为 system 提示。
 *  maxTokens 可传（修复轮必须传小上限：模型不守"只修命中镜"时会重写全片，384K 上限=烧钱+等 10 分钟）。
 *  useSession=true（修复轮）续接同集同岗位历史；noSession=true（E0/分批）不读写会话。 */
async function runApiRoleSession(input: { projectId: string; episodeId: string; stageCode: PipelineStageCode; prompt: string; maxTokens?: number; useSession?: boolean; noSession?: boolean }) {
  const stage = readStageModel(input.stageCode);
  const role: RoleConfig = {
    code: stage.code,
    skill: stage.skill,
    model: stage.model,
    reasoningEffort: stage.reasoningEffort,
    apiReasoner: stage.code === "E5"
  };
  return runApiRoleJson({
    role,
    prompt: input.prompt,
    maxTokens: input.maxTokens,
    projectId: input.projectId,
    episodeId: input.episodeId,
    useSession: input.useSession,
    noSession: input.noSession
  });
}

async function runRoleSession(input: {
  projectId: string;
  episodeId: string;
  stageCode: PipelineStageCode;
  prompt: string;
  sessionMode: RoleSessionMode;
}) {
  const stage = readStageModel(input.stageCode);
  const role: RoleConfig = {
    code: stage.code,
    skill: stage.skill,
    model: stage.model,
    reasoningEffort: stage.reasoningEffort
  };
  return runCliRoleJson({
    projectId: input.projectId,
    episodeId: input.episodeId,
    role,
    prompt: input.prompt,
    sessionMode: input.sessionMode
  });
}

/** E1 的 sound 格子只粗填环境/动作声：剥离"XX说话声/XX的声音"里的角色名——
 *  说话人由台词格决定，E1 若把角色名写进声音格（如"同学乙说话声"）而台词是同学甲，
 *  会触发 SPEAKER_PERFORMANCE_ALIGNMENT BLOCKER（修复轮模型高频踩坑）。 */
function stripSoundSpeakerLabels(context: PipelineContext, raw: Record<string, unknown>) {
  if (typeof raw.sound !== "string" || !raw.sound) return;
  const speakerNames = [...new Set(
    [...context.sourceNodes.values()]
      .filter((node) => ["DIALOGUE", "OS", "VO"].includes(node.type) && node.speaker)
      .map((node) => String(node.speaker).replace(/（.*）$/, "").replace(/内心$/, "").trim())
      .filter((name) => name.length >= 2)
  )].sort((a, b) => b.length - a.length);
  let soundText = String(raw.sound);
  if (speakerNames.length) {
    const speakerPattern = `(?:${speakerNames.map(escapeRegExp).join("|")})`;
    // 单人/多人说话提示整段移除：如「崔乐安说话声」「林砚秋与姜浩然说话声」。
    const spokenLabel = new RegExp(`${speakerPattern}(?:\\s*[、和与]\\s*${speakerPattern})*(?:说话声|的声音|在说话|说道|说着|说)`, "g");
    soundText = soundText.replace(spokenLabel, "");
  }
  soundText = soundText
    .replace(/([、，,；;与和])(?:\s*[、，,；;与和])+/g, (_match, separator: string) => separator)
    .replace(/^[\s、，,；;与和]+|[\s、，,；;与和]+$/g, "")
    .trim();
  raw.sound = soundText || "无";
}

async function persistE1(context: PipelineContext, output: E1Output, options: { revision?: boolean; revisionIssues?: Array<{ coordinate: string }> } = {}): Promise<WorkingShot[]> {
  // 单元格级修复（新契约）：修复轮输出 patches（shot_id + fields 只含命中坐标的格子），
  // 按字段 merge 到该镜 e1Data——未命中的格子原样保留，整镜行重写/重拆从此不可能
  if (options.revision && Array.isArray((output as unknown as { patches?: unknown }).patches)) {
    const hitShotKeys = new Set<string>();
    for (const item of options.revisionIssues ?? []) {
      const key = String(item.coordinate ?? "").split(".")[0];
      if (key && /-S\d+/.test(key)) hitShotKeys.add(key);
    }
    return persistE1Patches(context, (output as unknown as { patches: Array<Record<string, unknown>> }).patches, { ...options, allowedShotKeys: hitShotKeys.size ? hitShotKeys : undefined });
  }
  const sceneByKey = new Map(context.scenes.map((scene) => [scene.sceneKey, scene]));
  const shots: WorkingShot[] = [];
  let sortOrder = 0;
  // 节点 → 全局序号（与校验端编号一致）
  const nodeSeqByKey = new Map<string, number>();
  {
    let seq = 0;
    for (const node of context.sourceNodes.values()) nodeSeqByKey.set(node.source_node_id, ++seq);
  }
  const seqByNode = (node: SourceNode | undefined) => (node ? (nodeSeqByKey.get(node.source_node_id) ?? 0) : 0);
  // 修复轮被机械拒绝（节点跨区）的镜号，结束时留卡说明
  const regionRejected: string[] = [];
  // 机械展开：单镜台词>42字时按语义标点拆成连续镜（零 Token），避免字速/42字上限反复返修
  const expandedShots = expandOversizedDialogueShots(context, output.shots);
  for (const raw of expandedShots) {
    const shotId = requiredString(raw.shot_id, "E1.shot_id");
    const sceneId = requiredString(raw.scene_id, `${shotId}.scene_id`);
    const scene = sceneByKey.get(sceneId);
    if (!scene) throw new Error(`${shotId}引用了不存在的场次${sceneId}。`);
    let duration = positiveNumber(raw.duration, `${shotId}.duration`);
    const existingRow = options.revision
      ? await prisma.storyboardShot.findUnique({
          where: { episodeId_shotKey: { episodeId: context.episodeId, shotKey: shotId } },
          select: { id: true, sortOrder: true, sourceNodeRefs: true, dialogue: true, e1Data: true }
        })
      : null;
    const spanRefs = Array.isArray(raw.dialogue_spans)
      ? raw.dialogue_spans.map((span) => String((span as Record<string, unknown>).source_node_id ?? "")).filter(Boolean)
      : [];
    let sourceNodeRefs = [...new Set([...stringArray(raw.source_node_refs), ...spanRefs])];
    let dialogue = buildShotDialogue(raw, sourceNodeRefs, duration, context.sourceNodes);
    if (existingRow) {
      // 返修轮源节点引用只增不减：模型常为修一个节点而误删同镜的其它节点，造成覆盖震荡
      const oldRefs = parseJsonList(existingRow.sourceNodeRefs).map(String);
      sourceNodeRefs = [...new Set([...oldRefs, ...sourceNodeRefs])];
      const modelNodeIds = new Set(dialogue.map((entry) => String(entry.source_node_id ?? "")).filter(Boolean));
      const oldEntries = parseJsonList(existingRow.dialogue) as Array<Record<string, unknown>>;
      const carried = oldEntries
        .filter((entry) => {
          const nodeId = String(entry.source_node_id ?? "");
          return nodeId && !modelNodeIds.has(nodeId) && sourceNodeRefs.includes(nodeId);
        })
        .map((entry) => ({ ...entry, text_override: String(entry.text ?? "") }));
      if (carried.length) dialogue = [...dialogue, ...carried];
      // 返修轮 DIRECTOR_CONTRACT 保留：模型修其它字段时经常漏带 fulfills_visual_step，
      // 直接覆盖会把原步骤声明清掉（修 V4 丢 V3）——模型没写就用旧声明
      const oldE1 = safeParseJson(existingRow.e1Data);
      const oldStep = String(oldE1.fulfills_visual_step ?? "");
      if (oldStep && !String(raw.fulfills_visual_step ?? "").trim()) {
        raw.fulfills_visual_step = oldStep;
      }
      // 返修轮节点归属校验（Sequence Gate）：镜号位置决定它所属的 Sequence——模型"重拆错位"
      // 时会把别区的节点写进本区镜号（实测：把群嘲段 N0030-N0035 塞进 B02 区的 S015-S020），
      // 新旧 refs 合并后单镜同时含两个 Sequence 的节点 → SEQUENCE_BOUNDARY BLOCKER → 整批回滚。
      // 规则：模型输出镜的节点与镜号原节点必须落在同一 Sequence；跨区输出 = 该镜改动违规，
      // 机械拒绝整镜更新（保留库中原状），并在 E1 上留一条说明卡。
      const regionOk = (() => {
        if (!context.sequences.length) return true;
        const seqOfSeq = (seq: number) => context.sequences.find((s) => Number(s.node_range?.[0] ?? 0) <= seq && seq <= Number(s.node_range?.[1] ?? 0))?.sequence_id ?? "";
        const newNodeIds = [
          ...(Array.isArray(raw.source_node_refs) ? raw.source_node_refs.map(String) : []),
          ...(Array.isArray(raw.dialogue_spans) ? raw.dialogue_spans.map((span) => String((span as Record<string, unknown>).source_node_id ?? "")) : [])
        ];
        const newSeqs = [...new Set(newNodeIds
          .map((id) => context.sourceNodes.get(id))
          .filter((node): node is SourceNode => Boolean(node))
          .map((node) => seqOfSeq(seqByNode(node)))
          .filter(Boolean))];
        const oldRefs2 = parseJsonList(existingRow.sourceNodeRefs).map(String);
        const oldSeqs = [...new Set(oldRefs2
          .map((id) => context.sourceNodes.get(id))
          .filter((node): node is SourceNode => Boolean(node))
          .map((node) => seqOfSeq(seqByNode(node)))
          .filter(Boolean))];
        // 模型输出为空引用（反应镜）时不做跨区判定；新旧都无归属时放行
        const anchor = oldSeqs[0] ?? newSeqs[0];
        if (!anchor) return true;
        return newSeqs.every((s) => s === anchor);
      })();
      if (!regionOk) {
        regionRejected.push(shotId);
        continue; // 该镜整行拒绝：不 upsert，保留库中原状
      }
    }
    // 媒体指令剥离：画面里出现"屏幕出现字幕/字幕：…"（SYSTEM/字幕节点原文泄漏）时机械剔除——
    // 字幕化是知识库硬伤，画面只保留可拍内容；字幕信息由 E2/E3 的声音/台词层承接
    for (const field of ["picture", "visual_goal", "rough_camera"]) {
      if (typeof raw[field] === "string") {
        raw[field] = String(raw[field])
          .replace(/屏幕出现字幕[:：][^。；；]*[。；；]?/g, "")
          .replace(/字幕[:：][^。；；]*[。；；]?/g, "")
          .trim();
      }
    }
    // E1 的 sound 格子只粗填环境/动作声：剥离角色名标签（说话人由台词格决定）
    stripSoundSpeakerLabels(context, raw);
    // 硬规则机械化（只修违规、不缩小合规时长）：台词镜字速≤6字/秒且≤7秒；无台词镜≤5秒
    const totalChars = Math.max(1, dialogue.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0));
    if (dialogue.length) {
      const minForRate = Math.ceil((totalChars / 6) * 10) / 10;
      if (duration < minForRate && duration < 7) duration = roundTenth(Math.min(7, minForRate));
      else if (duration > 7) duration = 7;
    } else if (duration > 5) {
      duration = 5;
    }
    for (const entry of dialogue) {
      entry.duration = ceilTenth(Math.max(0.1, duration * (spokenCharCount(String(entry.text ?? "")) / totalChars)));
    }
    sortOrder += 1;
    const working: WorkingShot = {
      shot_id: shotId,
      scene_id: sceneId,
      time_segment_id: "",
      time_layer: String(raw.time_layer ?? scene.timeLayer),
      duration,
      source_node_refs: sourceNodeRefs,
      dialogue,
      e1: raw,
      e2: {},
      e3: {},
      e4: {}
    };
    // 新产出统一为 Bxx.Vx；旧 Vx 仍可读取，但在服务端按源节点归一，避免后续岗位猜 Beat。
    if (String(raw.fulfills_visual_step ?? "").trim()) {
      raw.fulfills_visual_step = visualStepForShot(context, working)?.ref ?? raw.fulfills_visual_step;
    }
    shots.push(working);
    const existing = existingRow;
    await prisma.storyboardShot.upsert({
      where: { episodeId_shotKey: { episodeId: context.episodeId, shotKey: shotId } },
      create: {
        episodeId: context.episodeId,
        sceneId: scene.id,
        shotKey: shotId,
        sortOrder: existing?.sortOrder ?? sortOrder,
        duration,
        timeLayer: String(working.time_layer),
        sourceNodeRefs: JSON.stringify(sourceNodeRefs),
        dialogue: JSON.stringify(dialogue),
        e1Data: JSON.stringify(raw),
        revision: context.revision
      },
      update: options.revision
        ? {
            sceneId: scene.id,
            duration,
            timeLayer: String(working.time_layer),
            sourceNodeRefs: JSON.stringify(sourceNodeRefs),
            dialogue: JSON.stringify(dialogue),
            e1Data: JSON.stringify(raw),
            revision: context.revision
            // 返修轮保留 e2/e3/e4，不重置
          }
        : {
            sceneId: scene.id,
            sortOrder,
            duration,
            timeLayer: String(working.time_layer),
            sourceNodeRefs: JSON.stringify(sourceNodeRefs),
            dialogue: JSON.stringify(dialogue),
            e1Data: JSON.stringify(raw),
            e2Data: "{}",
            e3Data: "{}",
            e4Data: "{}",
            revision: context.revision
          }
    });
  }
  if (!options.revision && !shots.length) throw new Error("E1没有返回任何小镜号。");
  // 全新 E1：输出即全表，删除本轮未输出的遗留镜号（及其单元链接），杜绝跨轮次垃圾累积
  if (!options.revision) {
    const outputIds = shots.map((shot) => shot.shot_id);
    await prisma.seedanceUnitShot.deleteMany({
      where: { shot: { episodeId: context.episodeId, shotKey: { notIn: outputIds } } }
    });
    await prisma.storyboardShot.deleteMany({
      where: { episodeId: context.episodeId, shotKey: { notIn: outputIds } }
    });
  } else {
    // 返修轮：最新输出覆盖的台词节点，释放旧承载镜（否则旧切片与新切片叠加造成全库重复/缺失）
    await releaseStaleDialogueCarriers(context, expandedShots);
  }
  // 机械修复：同一源节点的台词被 start/continue/end 镜重复整段携带（模型漏写切点锚）时，
  // 按句读标点自动切成连续块并归正时长——零 Token，避免字速/重复台词反复返修
  await applyMechanicalDialogueSlicing(context, shots);
  // 收敛循环（零 Token）：镜头级 42 字拆分 与 节点级完整性对账 会互相触发（拆镜可能破坏节点拼接、
  // 对账重切可能让单镜再超 42 字），迭代到两者同时稳定为止
  for (let pass = 0; pass < 3; pass++) {
    await enforceShotDialogueCap(context);
    await reconcileDialogueSlices(context);
  }
  // 先按源节点序规范化排序，再做最终完整性对账：
  // 返修轮拆镜产生的 S005-a/S005-b 若与台词切片顺序不一致，拼接校验与显示顺序会脱节
  //（模型常按对话流输出续接镜，但后缀字母未必按对话顺序命名），必须让 sortOrder 与切片拼接口径一致
  await renormalizeShotOrder(context);
  // 节点混镜拆分（零 Token，机械兜底）：一镜混入非相邻源节点（模型常把两句台词塞一镜）时
  // 按节点边界拆成多镜——E1 模型修顺序类问题不可靠，必须由机械层确定性完成
  await enforceNodePurity(context);
  // 终验（零 Token）：重新读库按校验口径核对每个对话节点的拼接完整性，仍有违规就再对账，
  // 保证 E1 落库后 DIALOGUE_SLICE_INCOMPLETE 必然清零（不等模型、不等下一轮）
  for (let extra = 0; extra < 3; extra++) {
    if (await countDialogueSliceViolations(context) === 0) break;
    await reconcileDialogueSlices(context);
  }
  // 混镜拆分/对账可能新增镜号：最终再按源节点序重排一次，保证顺序恒单调
  await renormalizeShotOrder(context);
  // 镜号时长变了，立刻按新表重算单元分组（零 Token），避免单元声明与镜号合计脱节
  await resyncUnitsAfterShotsChanged(context);
  if (options.revision && regionRejected.length) {
    await createMechanicalIssueOnce(
      context,
      "E1.region_rejected",
      "SHOT_REGION_REJECTED",
      "修复轮跨区改动被机械拒绝",
      `模型把 ${regionRejected.length} 个镜的节点改到其它 Sequence（${regionRejected.slice(0, 8).join("、")}…），已拒绝整镜更新并保留原状；请只修命中镜号、保持镜号对应区域不变`,
      "该镜保持原状；如需移动节点请输出正确镜号的修正行"
    );
  }
  return shots;
}

/**
 * 单元格级修复落库（零 Token 机械层）：对每个 patch 的 shot_id 按 fields 逐键 merge 到 e1Data，
 * 未命中的格子/镜号原样保留。只做机械归正：媒体指令剥离、sound 角色名剥离、时长 clamp、
 * dialogue_spans 变更时重建台词格。不新增/删除镜号（视觉步骤声明直接写 fulfills_visual_step）。
 */
async function persistE1Patches(
  context: PipelineContext,
  patches: Array<Record<string, unknown>>,
  options: { revision?: boolean; allowedShotKeys?: Set<string> }
): Promise<WorkingShot[]> {
  const logs: string[] = [];
  let changed = 0;
  let dropped = 0;
  for (const patch of patches) {
    const shotId = String(patch.shot_id ?? "");
    const fields = isRecord(patch.fields) ? patch.fields : {};
    if (!shotId || !Object.keys(fields).length) continue;
    // 修复轮坐标过滤：只接受命中卡的镜号（含其合法后缀镜）——模型"顺手修"其它镜是
    // 修 A 破 B 的根源（实测 E1 只该修 S035 却输出 6 个 patch，5 个 dialogue 引发覆盖缺失死循环）
    if (options.allowedShotKeys && !options.allowedShotKeys.has(shotId)) {
      dropped++;
      logs.push(`${shotId} 非命中坐标，已丢弃`);
      continue;
    }
    const row = await prisma.storyboardShot.findUnique({
      where: { episodeId_shotKey: { episodeId: context.episodeId, shotKey: shotId } }
    });
    if (!row) {
      logs.push(`${shotId} 不存在，忽略该 patch`);
      continue;
    }
    const e1 = safeParseJson(row.e1Data);
    const merged: Record<string, unknown> = { ...e1, ...fields };
    // 媒体指令剥离 + sound 角色名剥离（机械兜底，同全量路径）
    for (const field of ["picture", "visual_goal", "rough_camera"]) {
      if (typeof merged[field] === "string") {
        merged[field] = String(merged[field])
          .replace(/屏幕出现字幕[:：][^。；；]*[。；；]?/g, "")
          .replace(/字幕[:：][^。；；]*[。；；]?/g, "")
          .trim();
      }
    }
    stripSoundSpeakerLabels(context, merged);
    // 时长归正（patch 改 duration 时）：正数、≤7 秒、无台词镜 ≤5 秒
    let duration = Number(merged.duration ?? row.duration);
    if (!Number.isFinite(duration) || duration <= 0) duration = Number(row.duration) || 3;
    const refs = parseJsonList(row.sourceNodeRefs).map(String);
    // dialogue_spans 变更时重建台词格（否则保留原台词格）
    let dialogue = parseJsonList(row.dialogue) as Array<Record<string, unknown>>;
    if (fields.dialogue_spans !== undefined || fields.duration !== undefined) {
      dialogue = buildShotDialogue(merged, refs, duration, context.sourceNodes);
    }
    if (String(merged.fulfills_visual_step ?? "").trim()) {
      const normalized = visualStepForShot(context, {
        shot_id: shotId, source_node_refs: refs, dialogue, e1: merged, e2: {}, e3: {}, e4: {}
      } as WorkingShot);
      if (normalized) merged.fulfills_visual_step = normalized.ref;
    }
    const totalChars = Math.max(1, dialogue.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0));
    if (dialogue.length) {
      const minForRate = Math.ceil((totalChars / 6) * 10) / 10;
      if (duration < minForRate && duration < 7) duration = roundTenth(Math.min(7, minForRate));
      else if (duration > 7) duration = 7;
    } else if (duration > 5) {
      duration = 5;
    }
    for (const entry of dialogue) {
      entry.duration = ceilTenth(Math.max(0.1, duration * (spokenCharCount(String(entry.text ?? "")) / totalChars)));
    }
    await prisma.storyboardShot.update({
      where: { id: row.id },
      data: {
        e1Data: JSON.stringify(merged),
        duration,
        dialogue: JSON.stringify(dialogue),
        revision: context.revision
      }
    });
    changed++;
  }
  // 修复轮只回写命中镜号：回填全表，保证下游岗位与编译看到完整分镜表
  await resyncUnitsAfterShotsChanged(context);
  if (logs.length) {
    await createMechanicalIssueOnce(context, "E1.patch_skipped", "PATCH_SHOT_MISSING", "修复 patch 目标镜缺失", logs.join("；"), "忽略缺失镜号的 patch");
  }
  if (dropped) {
    await createMechanicalIssueOnce(context, "E1.patch_dropped", "PATCH_OUT_OF_SCOPE", "修复轮越界输出已丢弃", `${dropped} 个非命中坐标的 patch 被机械丢弃（只修问题卡坐标）`, "无需处理");
  }
  if (changed) {
    await createMechanicalIssueOnce(context, "E1.patch_applied", "PATCH_APPLIED", "单元格修复已落库", `已按字段合并 ${changed} 个镜的修正（未命中格子保留原值）`, "无需处理");
  }
  return [];
}

/** 机械拆镜/切批的后继镜继承父镜创作字段（e1–e4），避免编译出现"待补充"占位与创作字段空洞。 */
function inheritShotCells(
  parent: { e1Data: string; e2Data: string; e3Data: string; e4Data: string },
  shotKey: string,
  duration: number,
  sceneId: string,
  dialogueSpans: unknown[]
) {
  const parentE1 = safeParseJson(parent.e1Data);
  return {
    e1Data: JSON.stringify({
      ...parentE1,
      shot_id: shotKey,
      scene_id: sceneId,
      duration: String(duration),
      dialogue_spans: dialogueSpans
    }),
    e2Data: parent.e2Data || "{}",
    e3Data: parent.e3Data || "{}",
    e4Data: parent.e4Data || "{}"
  };
}

/**
 * 节点混镜拆分（零 Token）：一镜 dialogue 混入跨度 >1 的源节点（如 [N0028, N0036]，
 * 中间节点被其他镜承载）时，按节点边界拆成多镜。拆出的镜继承父镜创作字段，
 * 镜号用 -p0/-p1 后缀（renormalize 会按源节点序重排回正确位置）。
 */
async function enforceNodePurity(context: PipelineContext) {
  const rows = await prisma.storyboardShot.findMany({
    where: { episodeId: context.episodeId },
    orderBy: { sortOrder: "asc" }
  });
  const nodeSeq = new Map<string, number>();
  let seq = 0;
  for (const node of context.sourceNodes.values()) nodeSeq.set(node.source_node_id, ++seq);
  const logs: string[] = [];
  for (const row of rows) {
    const entries = parseJsonList(row.dialogue) as Array<Record<string, unknown>>;
    if (entries.length < 2) continue;
    const seqs = entries.map((entry) => nodeSeq.get(String(entry.source_node_id ?? ""))).filter((value): value is number => value !== undefined);
    if (!seqs.length) continue;
    const minSeq = Math.min(...seqs);
    const maxSeq = Math.max(...seqs);
    if (maxSeq - minSeq <= 1) {
      // 相邻节点（对白交换/一问一答）允许同镜，但条目必须按源节点序排列（修复轮合并镜常写倒序）
      const sorted = [...entries].sort((a, b) => {
        const sa = nodeSeq.get(String(a.source_node_id ?? ""));
        const sb = nodeSeq.get(String(b.source_node_id ?? ""));
        if (sa === undefined && sb === undefined) return 0;
        if (sa === undefined) return 1;
        if (sb === undefined) return -1;
        return sa - sb;
      });
      const changed = (() => {
        for (let i = 0; i < entries.length; i++) {
          const a = nodeSeq.get(String(entries[i].source_node_id ?? ""));
          if (a === undefined) continue;
          for (let j = i + 1; j < entries.length; j++) {
            const b = nodeSeq.get(String(entries[j].source_node_id ?? ""));
            if (b !== undefined && a > b) return true;
          }
        }
        return false;
      })();
      if (changed) {
        await prisma.storyboardShot.update({ where: { id: row.id }, data: { dialogue: JSON.stringify(sorted) } });
        logs.push(`${row.shotKey} 镜内台词按源节点顺序重排`);
      }
      continue;
    }
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const entry of entries) {
      const id = String(entry.source_node_id ?? "orphan");
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id)!.push(entry);
    }
    const ordered = [...groups.entries()].sort(
      (a, b) => (nodeSeq.get(a[0]) ?? Number.MAX_SAFE_INTEGER) - (nodeSeq.get(b[0]) ?? Number.MAX_SAFE_INTEGER)
    );
    // 原镜保留第一个节点的片段，其余节点各建一镜
    await prisma.storyboardShot.update({
      where: { id: row.id },
      data: { dialogue: JSON.stringify(ordered[0][1]) }
    });
    for (const [nodeId, group] of ordered.slice(1)) {
      let suffix = 0;
      let siblingKey = `${row.shotKey}-p${suffix}`;
      while (await prisma.storyboardShot.findUnique({ where: { episodeId_shotKey: { episodeId: context.episodeId, shotKey: siblingKey } }, select: { id: true } })) {
        suffix += 1;
        siblingKey = `${row.shotKey}-p${suffix}`;
      }
      const totalChars = Math.max(1, group.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0));
      const siblingDuration = speechMinimumDuration(totalChars);
      const entries = group.map((entry) => ({
        ...entry,
        duration: ceilTenth(Math.max(0.1, siblingDuration * (spokenCharCount(String(entry.text ?? "")) / totalChars)))
      }));
      await prisma.storyboardShot.create({
        data: {
          episodeId: context.episodeId,
          sceneId: row.sceneId,
          shotKey: siblingKey,
          sortOrder: row.sortOrder + 1,
          duration: siblingDuration,
          timeLayer: row.timeLayer,
          sourceNodeRefs: JSON.stringify([nodeId]),
          dialogue: JSON.stringify(entries),
          ...inheritShotCells(row, siblingKey, siblingDuration, String(safeParseJson(row.e1Data).scene_id ?? ""), [{ source_node_id: nodeId, span_state: "whole", text_override: entries.map((e) => String((e as Record<string, unknown>).text ?? "")).join("") }]),
          revision: context.revision
        }
      });
      logs.push(`${siblingKey}（${nodeId} 混镜拆出）`);
    }
    logs.push(`${row.shotKey} 混镜按节点拆为 ${ordered.length} 镜`);
  }
  if (logs.length) {
    await createMechanicalIssueOnce(context, "E1.node_purity", "NODE_PURITY_SPLIT", "一镜不混入非相邻源节点", logs.join("；"), "已自动完成，无需处理");
  }
}

/** 返修轮：最新输出覆盖的台词节点，从旧镜上释放（删除该节点条目与引用；旧镜被掏空则删除整镜）。 */
async function releaseStaleDialogueCarriers(context: PipelineContext, outputShots: Record<string, unknown>[]) {
  const outputIds = new Set(outputShots.map((shot) => String(shot.shot_id ?? "")).filter(Boolean));
  const dialogueTypes = new Set(["DIALOGUE", "OS", "VO", "NARRATION", "SYSTEM"]);
  const coveredNodes = new Set<string>();
  for (const raw of outputShots) {
    const ids: string[] = [];
    if (Array.isArray(raw.dialogue_spans)) {
      for (const span of raw.dialogue_spans) {
        const id = String((span as Record<string, unknown>).source_node_id ?? "");
        if (id) ids.push(id);
      }
    }
    ids.push(...stringArray(raw.source_node_refs));
    for (const id of ids) {
      if (dialogueTypes.has(String(context.sourceNodes.get(id)?.type ?? ""))) coveredNodes.add(id);
    }
  }
  if (!coveredNodes.size || !outputIds.size) return;
  const stale = await prisma.storyboardShot.findMany({
    where: { episodeId: context.episodeId, shotKey: { notIn: [...outputIds] } }
  });
  for (const row of stale) {
    const entries = parseJsonList(row.dialogue) as Array<Record<string, unknown>>;
    const remaining = entries.filter((entry) => !coveredNodes.has(String(entry.source_node_id ?? "")));
    const refs = parseJsonList(row.sourceNodeRefs).map(String);
    const remainingRefs = refs.filter((ref) => !coveredNodes.has(ref));
    if (remaining.length === entries.length && remainingRefs.length === refs.length) continue;
    if (!remaining.length) {
      await prisma.seedanceUnitShot.deleteMany({ where: { shotId: row.id } });
      await prisma.storyboardShot.delete({ where: { id: row.id } });
    } else {
      await prisma.storyboardShot.update({
        where: { id: row.id },
        data: { dialogue: JSON.stringify(remaining), sourceNodeRefs: JSON.stringify(remainingRefs) }
      });
    }
  }
}

/**
 * 全库台词对账（零 Token）：对话类节点的各承载镜（跨轮次遗留）切片拼接若不等于原文，
 * 按承载镜顺序确定性重切并归正时长。单镜承载的不完整节点留给下一轮 E1 的机械展开处理。
 */
async function reconcileDialogueSlices(context: PipelineContext) {
  const rows = await prisma.storyboardShot.findMany({
    where: { episodeId: context.episodeId },
    orderBy: { sortOrder: "asc" }
  });
  // 每行只 parse 一次：切片改动必须落在同一个数组上再落库（旧实现二次 parse 导致重切永不生效）
  const entriesByRow = new Map<string, Array<Record<string, unknown>>>();
  for (const row of rows) entriesByRow.set(row.id, parseJsonList(row.dialogue) as Array<Record<string, unknown>>);
  const byNode = new Map<string, Array<{ row: (typeof rows)[number]; entry: Record<string, unknown> }>>();
  for (const row of rows) {
    for (const entry of entriesByRow.get(row.id) ?? []) {
      const nodeId = String(entry.source_node_id ?? "");
      const node = context.sourceNodes.get(nodeId);
      if (!node || !["DIALOGUE", "OS", "VO", "NARRATION", "SYSTEM"].includes(node.type)) continue;
      if (!byNode.has(nodeId)) byNode.set(nodeId, []);
      byNode.get(nodeId)!.push({ row, entry });
    }
  }
  const logs: string[] = [];
  for (const [nodeId, members] of byNode) {
    const node = context.sourceNodes.get(nodeId)!;
    const full = String(node.text ?? "");
    if (!full) continue;
    const texts = members.map((member) => String(member.entry.text ?? ""));
    if (members.length < 2) {
      // 单镜承载但切片不完整：≤42字直接补全；>42字生成后继镜承接剩余段
      if (stripPunctuation(texts[0] ?? "") === stripPunctuation(full)) continue;
      const carrier = members[0];
      const fullChars = spokenCharCount(full);
      const entries = entriesByRow.get(carrier.row.id) ?? [];
      if (fullChars <= 42) {
        carrier.entry.text = full;
        carrier.entry.span_state = "whole";
        const totalChars = Math.max(1, entries.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0));
        const newDuration = preserveExistingShotDuration(carrier.row.duration, totalChars);
        for (const entry of entries) {
          entry.duration = ceilTenth(Math.max(0.1, newDuration * (spokenCharCount(String(entry.text ?? "")) / totalChars)));
        }
        const e1 = safeParseJson(carrier.row.e1Data);
        if (e1.duration !== undefined) e1.duration = String(newDuration);
        await prisma.storyboardShot.update({ where: { id: carrier.row.id }, data: { duration: newDuration, dialogue: JSON.stringify(entries), e1Data: JSON.stringify(e1) } });
        logs.push(`${nodeId}（${node.speaker ?? "未知"}）：单镜切片不完整，已补全整句（${spokenCharCount(texts[0] ?? "")}→${fullChars}字）`);
        continue;
      }
      // >42字：机械生成后继镜（父镜保留第一段并落库，后续段各建一个后缀镜）
      const chunks = sliceTextIntoChunks(full, Math.ceil(fullChars / 42));
      carrier.entry.text = chunks[0];
      carrier.entry.span_state = "start";
      const row = carrier.row;
      {
        const totalChars = Math.max(1, entries.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0));
        const newDuration = preserveExistingShotDuration(row.duration, totalChars);
        for (const entry of entries) {
          entry.duration = ceilTenth(Math.max(0.1, newDuration * (spokenCharCount(String(entry.text ?? "")) / totalChars)));
        }
        const e1 = safeParseJson(row.e1Data);
        if (e1.duration !== undefined) e1.duration = String(newDuration);
        await prisma.storyboardShot.update({ where: { id: row.id }, data: { duration: newDuration, dialogue: JSON.stringify(entries), e1Data: JSON.stringify(e1) } });
      }
      for (let chunkIndex = 1; chunkIndex < chunks.length; chunkIndex++) {
        let suffixIndex = 0;
        let siblingKey = `${row.shotKey}-x${suffixIndex}`;
        while (await prisma.storyboardShot.findUnique({ where: { episodeId_shotKey: { episodeId: context.episodeId, shotKey: siblingKey } }, select: { id: true } })) {
          suffixIndex += 1;
          siblingKey = `${row.shotKey}-x${suffixIndex}`;
        }
        const siblingDuration = speechMinimumDuration(spokenCharCount(chunks[chunkIndex]));
        await prisma.storyboardShot.create({
          data: {
            episodeId: context.episodeId,
            sceneId: row.sceneId,
            shotKey: siblingKey,
            sortOrder: row.sortOrder + 1,
            duration: siblingDuration,
            timeLayer: row.timeLayer,
            sourceNodeRefs: JSON.stringify([nodeId]),
            dialogue: JSON.stringify([{
              source_node_id: nodeId,
              speaker: node.speaker ?? "",
              type: node.type === "DIALOGUE" ? "对白" : node.type,
              text: chunks[chunkIndex],
              span_state: chunkIndex === chunks.length - 1 ? "end" : "continue",
              duration: siblingDuration
            }]),
            ...inheritShotCells(row, siblingKey, siblingDuration, row.sceneId, [{ source_node_id: nodeId, span_state: "whole", text_override: chunks[chunkIndex] }]),
            revision: context.revision
          }
        });
        logs.push(`${siblingKey}（${nodeId} 后继镜）已生成：${chunks[chunkIndex].slice(0, 12)}…`);
      }
      logs.push(`${nodeId}（${node.speaker ?? "未知"}）：单镜承载 ${fullChars} 字超42字，机械拆为 ${chunks.length} 镜`);
      continue;
    }
    if (texts.every((text) => text !== full) && stripPunctuation(texts.join("")) === stripPunctuation(full)) continue;
    const chunks = sliceTextIntoChunks(full, members.length);
    const touchedRows = new Set<string>();
    members.forEach((member, index) => {
      member.entry.text = chunks[index];
      member.entry.span_state = index === 0 ? "start" : index === members.length - 1 ? "end" : "continue";
      touchedRows.add(member.row.id);
    });
    for (const rowId of touchedRows) {
      const entries = entriesByRow.get(rowId) ?? [];
      const totalChars = Math.max(1, entries.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0));
      const row = rows.find((item) => item.id === rowId);
      if (!row) continue;
      const newDuration = preserveExistingShotDuration(row.duration, totalChars);
      for (const entry of entries) {
        entry.duration = ceilTenth(Math.max(0.1, newDuration * (spokenCharCount(String(entry.text ?? "")) / totalChars)));
      }
      const e1 = safeParseJson(row.e1Data);
      if (e1.duration !== undefined) e1.duration = String(newDuration);
      await prisma.storyboardShot.update({
        where: { id: row.id },
        data: { duration: newDuration, dialogue: JSON.stringify(entries), e1Data: JSON.stringify(e1) }
      });
    }
    logs.push(`${nodeId}（${node.speaker ?? "未知"}）：全库切片 ${texts.map((text) => spokenCharCount(text)).join("+")}≠原文${spokenCharCount(full)}字，已按 ${members.map((member) => member.row.shotKey).join(" / ")} 重切`);
  }
  if (logs.length) {
    await createMechanicalIssueOnce(context, "E1.dialogue_reconcile", "DIALOGUE_SLICE_RECONCILED", "每个对话节点的各镜切片拼接逐字等于原文", logs.join("；"), "已自动完成，无需处理");
  }
}

/**
 * 镜头级 42 字上限兜底（零 Token）：单镜合并台词 >42 字时按条目顺序切成 ≤42 字批次，
 * 原镜保留第一批，其余批次生成后缀镜（-c0/-c1…）。不依赖模型输出，任何 E1 轮次后全库合规。
 */
/** 按校验口径统计切片拼接不完整的对话节点数（与 validatePipeline 同一判定，同一排序口径）。 */
async function countDialogueSliceViolations(context: PipelineContext): Promise<number> {
  const rows = await prisma.storyboardShot.findMany({
    where: { episodeId: context.episodeId },
    orderBy: { sortOrder: "asc" }
  });
  const byNode = new Map<string, string[]>();
  for (const row of rows) {
    for (const entry of parseJsonList(row.dialogue) as Array<Record<string, unknown>>) {
      const nodeId = String(entry.source_node_id ?? "");
      const node = context.sourceNodes.get(nodeId);
      if (!node || !["DIALOGUE", "OS", "VO", "NARRATION", "SYSTEM"].includes(node.type)) continue;
      if (!byNode.has(nodeId)) byNode.set(nodeId, []);
      byNode.get(nodeId)!.push(String(entry.text ?? ""));
    }
  }
  let violations = 0;
  for (const [nodeId, pieces] of byNode) {
    const node = context.sourceNodes.get(nodeId);
    if (!node) continue;
    if (stripPunctuation(pieces.join("")) !== stripPunctuation(node.text)) violations += 1;
  }
  return violations;
}

async function enforceShotDialogueCap(context: PipelineContext) {
  const rows = await prisma.storyboardShot.findMany({
    where: { episodeId: context.episodeId },
    include: { scene: true },
    orderBy: { sortOrder: "asc" }
  });
  const logs: string[] = [];
  for (const row of rows) {
    const entries = parseJsonList(row.dialogue) as Array<Record<string, unknown>>;
    const totalChars = entries.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0);
    if (totalChars <= 42) continue;
    // 按"节点边界优先"切批：整条台词优先不分家，只有单条 >42 字时才从中间切（该节点多出承载镜，由对账统一重切）。
    // 旧的按字硬切会把一个节点的文本劈到两个镜里、破坏节点拼接完整性，造成对账与拆分互相打架
    const batches: Array<Array<Record<string, unknown>>> = [];
    let current: Array<Record<string, unknown>> = [];
    let currentChars = 0;
    for (const entry of entries) {
      const chars = spokenCharCount(String(entry.text ?? ""));
      if (chars > 42) {
        if (current.length) batches.push(current);
        current = [];
        currentChars = 0;
        // 单条超长：从中间切成多批（每批只含这一条的片段）
        const chunks = sliceTextIntoChunks(String(entry.text ?? ""), Math.max(2, Math.ceil(chars / 42)));
        for (const chunk of chunks) {
          batches.push([{ ...entry, text: chunk }]);
        }
        continue;
      }
      if (currentChars + chars > 42) {
        batches.push(current);
        current = [];
        currentChars = 0;
      }
      current.push(entry);
      currentChars += chars;
    }
    if (current.length) batches.push(current);
    if (batches.length <= 1) continue;
    // 第一批更新原镜
    const batch0 = batches[0];
    const total0 = Math.max(1, batch0.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0));
    const duration0 = preserveExistingShotDuration(row.duration, total0);
    for (const entry of batch0) {
      entry.duration = ceilTenth(Math.max(0.1, duration0 * (spokenCharCount(String(entry.text ?? "")) / total0)));
    }
    const e1 = safeParseJson(row.e1Data);
    if (e1.duration !== undefined) e1.duration = String(duration0);
    await prisma.storyboardShot.update({ where: { id: row.id }, data: { duration: duration0, dialogue: JSON.stringify(batch0), e1Data: JSON.stringify(e1) } });
    // 后续批次生成后缀镜
    for (let batchIndex = 1; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchChars = Math.max(1, batch.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0));
      const batchDuration = speechMinimumDuration(batchChars);
      for (const entry of batch) {
        entry.duration = ceilTenth(Math.max(0.1, batchDuration * (spokenCharCount(String(entry.text ?? "")) / batchChars)));
      }
      let suffixIndex = 0;
      let siblingKey = `${row.shotKey}-c${suffixIndex}`;
      while (await prisma.storyboardShot.findUnique({ where: { episodeId_shotKey: { episodeId: context.episodeId, shotKey: siblingKey } }, select: { id: true } })) {
        suffixIndex += 1;
        siblingKey = `${row.shotKey}-c${suffixIndex}`;
      }
      // 后继镜继承父镜的创作字段（画面/机位/表演/光影/声音/转场同属这一拍），只替换台词与时长，
      // 避免新镜出现 picture/camera_motion 待补充而被 E5 反复开卡
      const parentE1 = safeParseJson(row.e1Data);
      const siblingE1 = {
        ...parentE1,
        shot_id: siblingKey,
        scene_id: row.scene.sceneKey,
        duration: String(batchDuration),
        dialogue_spans: batch.map((entry) => ({
          source_node_id: entry.source_node_id,
          span_state: "whole",
          text_override: entry.text
        }))
      };
      await prisma.storyboardShot.create({
        data: {
          episodeId: context.episodeId,
          sceneId: row.sceneId,
          shotKey: siblingKey,
          sortOrder: row.sortOrder + batchIndex,
          duration: batchDuration,
          timeLayer: row.timeLayer,
          sourceNodeRefs: row.sourceNodeRefs,
          dialogue: JSON.stringify(batch),
          e1Data: JSON.stringify(siblingE1),
          e2Data: row.e2Data,
          e3Data: row.e3Data,
          e4Data: row.e4Data,
          revision: context.revision
        }
      });
      logs.push(`${siblingKey}（${row.shotKey} 合并台词${totalChars}字>42字拆出）`);
    }
  }
  if (logs.length) {
    await createMechanicalIssueOnce(context, "E1.shot_cap", "SHOT_DIALOGUE_CAP_SPLIT", "单镜合并台词≤42字", logs.join("；"), "已自动完成，无需处理");
  }
}

/** 按句读标点把长台词切成 count 个连续块：切点就近理想位置，且不留下过短尾块。 */
function sliceTextIntoChunks(text: string, count: number): string[] {
  if (count <= 1) return [text];
  const strong = Array.from(text.matchAll(/[。！？…]/g), (match) => match.index + 1)
    .filter((position) => position < text.length - 4);
  const weak = Array.from(text.matchAll(/[，、；：]/g), (match) => match.index + 1)
    .filter((position) => position < text.length - 4);
  const target = text.length / count;
  const cuts: number[] = [];
  let cursor = 0;
  for (let index = 1; index < count; index++) {
    const ideal = Math.round(target * index);
    const pool = strong.length >= count - index ? strong : weak;
    const usable = pool.filter((position) => position > cursor && text.length - position >= 3);
    const cut = usable.length
      ? usable.reduce((best, position) => (Math.abs(position - ideal) < Math.abs(best - ideal) ? position : best), usable[0])
      : Math.min(Math.max(cursor + 1, Math.round(ideal)), Math.max(cursor + 1, text.length - 1));
    cuts.push(cut);
    cursor = cut;
  }
  const chunks: string[] = [];
  let start = 0;
  for (const cut of [...cuts, text.length]) {
    chunks.push(text.slice(start, cut).trim());
    start = cut;
  }
  return chunks;
}

function speechMinimumDuration(totalChars: number): number {
  return roundTenth(Math.min(7, Math.max(1.5, Math.ceil((Math.max(1, totalChars) / 6) * 10) / 10)));
}

/** 机械修复现役镜只补足容量，不覆盖导演已留出的动作与气口时间。 */
function preserveExistingShotDuration(existingDuration: unknown, totalChars: number): number {
  const minimum = speechMinimumDuration(totalChars);
  const existing = Number(existingDuration);
  return Number.isFinite(existing) && existing > 0 ? ceilTenth(Math.max(existing, minimum)) : minimum;
}

/**
 * 机械展开（零 Token）：单镜台词条目超过 42 字时，按句读标点切成连续块，
 * 原镜保留第一块，其余每块生成一个后缀镜（1-1-S011-a、1-1-S011-b…），
 * 用 text_override 写死切片，彻底消除"台词超42字/字速超限"类返修。
 */
function expandOversizedDialogueShots(context: PipelineContext, rawShots: Record<string, unknown>[]): Record<string, unknown>[] {
  const expanded: Record<string, unknown>[] = [];
  // 同一源节点在本批输出里被多个镜承载时，交给机械切片/全库对账统一重切，这里不重复拆
  const nodeCarrierCount = new Map<string, number>();
  for (const raw of rawShots) {
    const refs = [
      ...stringArray(raw.source_node_refs),
      ...(Array.isArray(raw.dialogue_spans)
        ? raw.dialogue_spans.map((span) => String((span as Record<string, unknown>).source_node_id ?? "")).filter(Boolean)
        : [])
    ];
    for (const nodeId of new Set(refs)) nodeCarrierCount.set(nodeId, (nodeCarrierCount.get(nodeId) ?? 0) + 1);
  }
  const usedIds = new Set(rawShots.map((raw) => String(raw.shot_id ?? "")).filter(Boolean));
  for (const raw of rawShots) {
    const shotId = String(raw.shot_id ?? "");
    const refs = [
      ...stringArray(raw.source_node_refs),
      ...(Array.isArray(raw.dialogue_spans)
        ? raw.dialogue_spans.map((span) => String((span as Record<string, unknown>).source_node_id ?? "")).filter(Boolean)
        : [])
    ];
    let entries = buildShotDialogue(raw, [...new Set(refs)], 1, context.sourceNodes);
    // 单镜唯一承载且切片不完整：恢复为整句原文，再按 42 字规则切
    entries = entries.map((entry) => {
      const nodeId = String(entry.source_node_id ?? "");
      if ((nodeCarrierCount.get(nodeId) ?? 0) === 1) {
        const node = context.sourceNodes.get(nodeId);
        if (node && stripPunctuation(String(entry.text ?? "")) !== stripPunctuation(node.text)) {
          return { ...entry, text: node.text };
        }
      }
      return entry;
    });
    const totalChars = entries.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0);
    if (totalChars <= 42) {
      expanded.push(raw);
      continue;
    }
    // 单镜合并台词总量 >42 字：按条目顺序切成连续批次，每批 ≤42 字
    const batches: Array<Array<Record<string, unknown>>> = [];
    let current: Array<Record<string, unknown>> = [];
    let currentChars = 0;
    for (const entry of entries) {
      let text = String(entry.text ?? "");
      let chars = spokenCharCount(text);
      while (chars > 0) {
        const room = 42 - currentChars;
        if (chars <= room) {
          current.push({ ...entry, text });
          currentChars += chars;
          text = "";
          chars = 0;
        } else {
          const chunks = sliceTextIntoChunks(text, Math.max(2, Math.ceil(chars / room)));
          const head = chunks[0];
          const rest = chunks.slice(1).join("");
          current.push({ ...entry, text: head });
          batches.push(current);
          current = [];
          currentChars = 0;
          text = rest;
          chars = spokenCharCount(rest);
        }
      }
    }
    if (current.length) batches.push(current);
    // 第 1 批留在原镜：写死 text_override 防止锚点歧义
    const batch0 = batches[0];
    const spans = Array.isArray(raw.dialogue_spans) ? (raw.dialogue_spans as Record<string, unknown>[]) : [];
    const nextSpans = batch0.map((entry) => {
      const existing = spans.find((span) => String(span.source_node_id ?? "") === String(entry.source_node_id ?? ""));
      return {
        source_node_id: entry.source_node_id,
        speaker: entry.speaker ?? "",
        span_state: "whole",
        text_override: entry.text
      };
    });
    raw.dialogue_spans = nextSpans;
    expanded.push(raw);
    // 后续批次逐个生成后缀镜
    for (let batchIndex = 1; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];
      const batchChars = batch.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0);
      let letterIndex = 0;
      let siblingId = `${shotId}-${String.fromCharCode(97 + letterIndex)}`;
      while (usedIds.has(siblingId)) {
        letterIndex += 1;
        siblingId = `${shotId}-${String.fromCharCode(97 + letterIndex)}`;
      }
      usedIds.add(siblingId);
      const siblingDuration = speechMinimumDuration(batchChars);
      const sibling: Record<string, unknown> = {
        ...raw,
        shot_id: siblingId,
        duration: siblingDuration,
        dialogue_spans: batch.map((entry) => ({
          source_node_id: entry.source_node_id,
          speaker: entry.speaker ?? "",
          span_state: "whole",
          text_override: entry.text
        })),
        risk_notes: `${String(raw.risk_notes ?? "")} [后台机械拆分：原镜${shotId}合并台词超42字，本镜承接第${batchIndex + 1}批]`.trim()
      };
      expanded.push(sibling);
    }
  }
  return expanded;
}

/**
 * 机械对话切片（零 Token）：多个镜号共用同一源节点、且每镜都携带整段台词（span 漏写切点锚）时，
 * 自动把整段切成连续块分给各镜，并把时长归正到字速≤6字/秒（上限7秒、下限1.5秒）。
 */
async function applyMechanicalDialogueSlicing(context: PipelineContext, shots: WorkingShot[]) {
  const byNode = new Map<string, Array<{ shot: WorkingShot; entry: Record<string, unknown> }>>();
  for (const shot of shots) {
    for (const entry of shot.dialogue as Array<Record<string, unknown>>) {
      const nodeId = String(entry.source_node_id ?? "");
      if (!nodeId) continue;
      if (!byNode.has(nodeId)) byNode.set(nodeId, []);
      byNode.get(nodeId)!.push({ shot, entry });
    }
  }
  const touched = new Map<string, WorkingShot>();
  const logs: string[] = [];
  for (const [nodeId, members] of byNode) {
    if (members.length < 2) continue;
    const node = context.sourceNodes.get(nodeId);
    if (!node) continue;
    const full = String(node.text ?? "");
    if (!full) continue;
    // 模型切片正确（没有整段重复、去标点后拼接逐字等于原文）才跳过；否则一律机械重切
    const texts = members.map((member) => String(member.entry.text ?? ""));
    if (texts.every((text) => text !== full) && stripPunctuation(texts.join("")) === stripPunctuation(full)) continue;
    const chunks = sliceTextIntoChunks(full, members.length);
    members.forEach((member, index) => {
      member.entry.text = chunks[index];
      const state = index === 0 ? "start" : index === members.length - 1 ? "end" : "continue";
      member.entry.span_state = state;
      touched.set(member.shot.shot_id, member.shot);
    });
    logs.push(`${nodeId}（${node.speaker ?? "未知"}）：台词在${members.length}镜间未正确切片，已机械重切为 ${members.map((member) => member.shot.shot_id).join(" / ")}`);
  }
  for (const shot of touched.values()) {
    const entries = shot.dialogue as Array<Record<string, unknown>>;
    const totalChars = Math.max(1, entries.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0));
    // 向上取整到 0.1 秒，确保字速严格 ≤6 字/秒（不因四舍五入出现 6.04 之类边界违规）
    const oldDuration = Number(shot.duration);
    const newDuration = preserveExistingShotDuration(oldDuration, totalChars);
    shot.duration = newDuration;
    for (const entry of entries) {
      entry.duration = ceilTenth(Math.max(0.1, newDuration * (spokenCharCount(String(entry.text ?? "")) / totalChars)));
    }
    const row = await prisma.storyboardShot.findUnique({
      where: { episodeId_shotKey: { episodeId: context.episodeId, shotKey: shot.shot_id } }
    });
    if (row) {
      const e1 = safeParseJson(row.e1Data);
      if (e1.duration !== undefined) e1.duration = String(newDuration);
      await prisma.storyboardShot.update({
        where: { id: row.id },
        data: { duration: newDuration, dialogue: JSON.stringify(entries), e1Data: JSON.stringify(e1) }
      });
    }
    logs.push(`${shot.shot_id} 时长 ${oldDuration}s→${newDuration}s（${totalChars}字按6字/秒归正）`);
  }
  if (logs.length) {
    await createMechanicalIssueOnce(context, "E1.dialogue_spans", "DIALOGUE_MECH_SLICE", "同一句台词按语义连续拆到相邻镜，不整段重复", logs.join("；"), "已自动完成，无需处理");
  }
}

/**
 * 按"场次 + 源节点序号"重排 sortOrder（叙事顺序是金标准，镜号只是编号）：
 * 每镜取其承载的源节点最小序号（source_node_refs ∪ dialogue），按场景内序号单调排列；
 * 同序号（同一节点跨多镜/切批）再按镜号后缀次序。无任何节点的空镜排场景末尾。
 * 修复两类历史问题：① 后缀镜号（-a/-x0/-c0）被旧正则漏匹配排到末尾；
 * ② 镜号数字顺序与源剧本顺序不一致（模型编号随意，覆盖 100% 但顺序错乱）。
 */
async function renormalizeShotOrder(context: PipelineContext) {
  const rows = await prisma.storyboardShot.findMany({ where: { episodeId: context.episodeId } });
  const nodeSeq = new Map<string, number>();
  let seq = 0;
  for (const node of context.sourceNodes.values()) nodeSeq.set(node.source_node_id, ++seq);
  const orderKeyOf = (row: (typeof rows)[number]): { scene: string; minSeq: number; shotKey: string } => {
    // 顺序键只认 dialogue 承载（台词/OS 归属才是叙事顺序的真相）；
    // sourceNodeRefs 是"覆盖集合"（不保序，模型常混入相邻节点），仅无台词镜时兜底
    const dialogueRefs = (parseJsonList(row.dialogue) as Array<Record<string, unknown>>).map((entry) => String(entry.source_node_id ?? ""));
    let seqs = dialogueRefs.map((id) => nodeSeq.get(id)).filter((value): value is number => value !== undefined);
    if (!seqs.length) {
      seqs = parseJsonList(row.sourceNodeRefs).map(String).map((id) => nodeSeq.get(id)).filter((value): value is number => value !== undefined);
    }
    const e1 = safeParseJson(row.e1Data);
    return {
      scene: typeof e1.scene_id === "string" ? e1.scene_id : "",
      minSeq: seqs.length ? Math.min(...seqs) : Number.POSITIVE_INFINITY,
      shotKey: row.shotKey
    };
  };
  rows.sort((a, b) => {
    const ka = orderKeyOf(a);
    const kb = orderKeyOf(b);
    if (ka.scene !== kb.scene) return ka.scene < kb.scene ? -1 : 1;
    if (ka.minSeq !== kb.minSeq) return ka.minSeq - kb.minSeq;
    return ka.shotKey < kb.shotKey ? -1 : 1;
  });
  for (const [index, row] of rows.entries()) {
    if (row.sortOrder !== index + 1) {
      await prisma.storyboardShot.update({ where: { id: row.id }, data: { sortOrder: index + 1 } });
    }
  }
}

/** 由 Python 按规则算出 E1 返修的具体改法：模型直接采用数值，减少猜测与返修轮次。 */
function buildFixHint(
  item: { coordinate: string; code: string; requestedEffect: string },
  shotByKey: Map<string, { dialogue: string }>
): string {
  const shotKey = item.coordinate.split(".")[0];
  const shot = shotByKey.get(shotKey);
  // 源节点级问题：找出承载该节点台词的镜号，给出精确返修对象
  if (item.coordinate.startsWith("source_node.")) {
    const nodeId = item.coordinate.slice("source_node.".length);
    const carriers: string[] = [];
    for (const [key, row] of shotByKey) {
      const entries = parseJsonList(row.dialogue) as Array<Record<string, unknown>>;
      if (entries.some((entry) => String(entry.source_node_id ?? "") === nodeId)) carriers.push(key);
    }
    return carriers.length
      ? `该节点台词由镜号 ${carriers.join("、")} 承载：重新为这些镜写 dialogue_spans（跨镜必须写 text_override 或精确锚点，禁止整段重复），切片按镜号顺序拼接必须逐字等于原文`
      : item.requestedEffect;
  }
  if (!shot) return item.requestedEffect;
  const entries = parseJsonList(shot.dialogue) as Array<Record<string, unknown>>;
  const chars = entries.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0);
  if (item.code === "SPEECH_RATE_OVER_LIMIT") {
    const required = Math.ceil((chars / 6) * 10) / 10;
    if (chars > 42) {
      return `台词${chars}字超过42字单镜上限：按语义拆成相邻两镜（每镜台词≤42字、时长≤7秒、字速≤6字/秒），禁止单独加时长`;
    }
    if (required > 7) {
      return `台词${chars}字按6字/秒需${required}秒，超过单镜7秒上限：按语义拆成相邻两镜（每镜≤7秒、字速≤6字/秒），禁止单独加时长`;
    }
    return `把该镜时长改为至少 ${required} 秒（台词${chars}字，字速≤6字/秒），或把台词拆到相邻镜`;
  }
  if (item.code === "DURATION_OVER_LIMIT") {
    if (chars > 42) return `该镜台词${chars}字超过42字上限：按语义拆成相邻两镜，每镜≤5秒`;
    if (chars > 0) {
      const required = Math.ceil((chars / 6) * 10) / 10;
      return `把该镜时长改为 ${required}–7 秒（台词${chars}字≤42字，台词镜可到7秒），并保持字速≤6字/秒`;
    }
    return "把该镜时长减到5秒以内（无台词镜≤5秒），或拆成相邻两镜";
  }
  return item.requestedEffect;
}

/** E3 返修的问题卡改法提示（单元级）。 */
function buildUnitFixHint(item: { code: string; requestedEffect: string }): string {
  if (item.code === "UNIT_DURATION_OVER_LIMIT") {
    return "优先微调：把本单元最拖的一镜减0.5秒；仍超则把某一镜拆到相邻单元，或与相邻单元合并重组（单元≤15秒是唯一硬上限）";
  }
  if (item.code === "UNIT_CROSSES_SCENE") return "把跨场次的镜号拆到各自场次的单元里";
  if (item.code === "UNIT_CROSSES_TIME_LAYER") return "把跨时空层的镜号拆到各自时空层的单元里";
  if (item.code === "UNIT_DURATION_MISMATCH") return "让 unit_duration 精确等于所含镜号时长之和";
  if (item.code === "SHOT_UNIT_LINK_INVALID") return "让每个小镜号按顺序且仅归属一个单元";
  return item.requestedEffect;
}

/**
 * 机械微调（零 Token）：单元总时长略超 15 秒时，从"最拖"的镜头减时长使其回到 15 秒内。
 * 硬规则不变（单元 ≤15s），只是用最小动作满足它，避免把整单元打回返修。
 * 优先减无台词镜（拖拍），其次减字速余量最大的台词镜；每镜最多减 1.0 秒，
 * 每镜不低于 max(1.5s, 台词字数÷6)；减不掉的剩余溢出留给 E4 返修重排单元。
 */
export function hasOverLimitContinuityRun(shots: WorkingShot[], selectedShotIds: ReadonlySet<string>): boolean {
  for (let index = 0; index < shots.length;) {
    const first = shots[index];
    const continuityId = String((first.e1 as Record<string, unknown>).continuity_id ?? "").trim();
    if (!continuityId) { index += 1; continue; }
    let end = index + 1;
    let duration = Number(first.duration);
    while (end < shots.length) {
      const next = shots[end];
      if (next.scene_id !== first.scene_id || next.time_layer !== first.time_layer || String((next.e1 as Record<string, unknown>).continuity_id ?? "").trim() !== continuityId) break;
      duration += Number(next.duration);
      end += 1;
    }
    if (duration > 15.0001 && shots.slice(index, end).some((shot) => selectedShotIds.has(shot.shot_id))) return true;
    index = end;
  }
  return false;
}

async function autoRepairUnitDurations(
  context: PipelineContext,
  shots: WorkingShot[],
  units: Record<string, unknown>[]
): Promise<WorkingShot[]> {
  if (!shots.length || !units.length) return shots;
  const dbRows = await prisma.storyboardShot.findMany({ where: { episodeId: context.episodeId } });
  const rowByKey = new Map(dbRows.map((row) => [row.shotKey, row]));
  const changed: Array<{ unitKey: string; detail: string }> = [];

  for (const unit of units) {
    const unitKey = String(unit.unit_id ?? "");
    const ids = stringArray(unit.shot_ids);
    const included = ids.map((id) => shots.find((shot) => shot.shot_id === id)).filter(Boolean) as WorkingShot[];
    if (!included.length) continue;
    // 真正不可切的连续动作/道具交接链超限时，不得靠裁镜长掩盖；保留 E1 的 BLOCKER。
    if (hasOverLimitContinuityRun(shots, new Set(ids))) continue;
    const total = roundTenth(included.reduce((sum, shot) => sum + Number(shot.duration), 0));
    let remaining = roundTenth(total - 15);
    if (remaining <= 0.05) continue;

    const dialogueCharsOf = (shot: WorkingShot) =>
      (shot.dialogue as Array<Record<string, unknown>>).reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0);
    const floorOf = (shot: WorkingShot) => Math.max(1.5, Math.ceil((dialogueCharsOf(shot) / 6) * 10) / 10);
    const trims = new Map<string, number>();
    // 两轮：先无台词镜（拖拍），再台词镜（按字速余量从大到小）
    for (let pass = 0; pass < 2 && remaining > 0.05; pass++) {
      const candidates = included
        .filter((shot) => (pass === 0) === (dialogueCharsOf(shot) === 0))
        .sort((a, b) => (Number(b.duration) - floorOf(b)) - (Number(a.duration) - floorOf(a)));
      for (const shot of candidates) {
        if (remaining <= 0.05) break;
        const already = trims.get(shot.shot_id) ?? 0;
        const cap = roundTenth(1.0 - already);
        if (cap <= 0.05) continue;
        const slack = roundTenth(Number(shot.duration) - floorOf(shot));
        if (slack <= 0.05) continue;
        const amount = roundTenth(Math.min(remaining, slack, cap));
        if (amount <= 0) continue;
        trims.set(shot.shot_id, roundTenth(already + amount));
        remaining = roundTenth(remaining - amount);
      }
    }
    if (remaining > 0.05 || !trims.size) continue; // 减不完：留给 E3 返修重排

    const details: string[] = [];
    for (const [shotId, amount] of trims) {
      const shot = included.find((item) => item.shot_id === shotId);
      if (!shot) continue;
      const oldDuration = Number(shot.duration);
      const newDuration = roundTenth(oldDuration - amount);
      shot.duration = newDuration;
      const row = rowByKey.get(shotId);
      if (row) {
        const e1 = safeParseJson(row.e1Data);
        if (e1.duration !== undefined) e1.duration = String(newDuration);
        const dialogue = parseJsonList(row.dialogue) as Array<Record<string, unknown>>;
        const totalChars = Math.max(1, dialogue.reduce((sum, entry) => sum + spokenCharCount(String(entry.text ?? "")), 0));
        const nextDialogue = dialogue.map((entry) => ({
          ...entry,
          duration: ceilTenth(Math.max(0.1, newDuration * (spokenCharCount(String(entry.text ?? "")) / totalChars)))
        }));
        await prisma.storyboardShot.update({
          where: { id: row.id },
          data: { duration: newDuration, e1Data: JSON.stringify(e1), dialogue: JSON.stringify(nextDialogue) }
        });
      }
      details.push(`${shotId} ${oldDuration}s→${newDuration}s`);
    }
    const newTotal = roundTenth(included.reduce((sum, shot) => sum + Number(shot.duration), 0));
    // 同步内存中的单元声明时长，避免随后校验/审查读到旧的 unit_duration 产生假性不一致
    if (unit.unit_duration !== undefined) unit.unit_duration = newTotal;
    const unitRow = await prisma.seedanceUnit.findUnique({
      where: { episodeId_unitKey: { episodeId: context.episodeId, unitKey } }
    });
    if (unitRow) {
      const data = safeParseJson(unitRow.data);
      if (data.unit_duration !== undefined) data.unit_duration = newTotal;
      await prisma.seedanceUnit.update({ where: { id: unitRow.id }, data: { duration: newTotal, data: JSON.stringify(data) } });
    }
    changed.push({ unitKey, detail: `${unitKey} ${total}s→${newTotal}s：${details.join("，")}` });
  }

  if (changed.length) {
    for (const item of changed) {
      await createMechanicalIssueOnce(context, `${item.unitKey}.auto_trim`, "AUTO_TRIM_APPLIED", "单元≤15秒硬上限", item.detail, "已自动完成，无需处理");
    }
  }
  return shots;
}

/** 单元级光影落库（E4 在 E3 后）：unit_lighting 按 unit_id 写入 seedanceUnit.data，
 *  编译层把它作为该单元所有镜的默认光影（合并单元格），镜级 e3.lighting 差异覆盖。 */
async function persistUnitLighting(context: PipelineContext, output: { unit_lighting?: unknown }, allowedUnits?: Set<string>) {
  if (!Array.isArray(output.unit_lighting)) return;
  for (const item of output.unit_lighting) {
    const record = isRecord(item) ? item : {};
    const unitKey = String(record.unit_id ?? "");
    const text = String(record.lighting ?? record.lighting_design ?? "").trim();
    if (!unitKey || !text) continue;
    if (allowedUnits && !allowedUnits.has(unitKey)) continue;
    const unit = await prisma.seedanceUnit.findUnique({
      where: { episodeId_unitKey: { episodeId: context.episodeId, unitKey } }
    });
    if (!unit) continue;
    const data = safeParseJson(unit.data);
    await prisma.seedanceUnit.update({
      where: { id: unit.id },
      data: { data: JSON.stringify({ ...data, unit_lighting: text }) }
    });
  }
}

async function persistShotPatches(context: PipelineContext, output: PatchOutput, field: "e2" | "e3" | "e4", options: { tolerateMissing?: boolean; allowedShotKeys?: Set<string> } = {}) {
  const column = `${field}Data` as "e2Data" | "e3Data" | "e4Data";
  for (const patch of output.patches) {
    const shotKey = requiredString(patch.shot_id, `${field}.shot_id`);
    // 修复轮坐标过滤：只接受命中卡的镜号（±相邻镜仅供参考，禁止改）——模型"顺手修"其它镜
    // 是修 A 破 B 的根源（实测 E2 只该修 S038 却输出 10 个 patch 改了 9 个无关镜）
    if (options.allowedShotKeys && !options.allowedShotKeys.has(shotKey)) continue;
    if (patch.action === "no_change") continue;
    if (!isRecord(patch.fields)) throw new Error(`${shotKey}.${field}缺少fields对象。`);
    const shot = await prisma.storyboardShot.findUnique({
      where: { episodeId_shotKey: { episodeId: context.episodeId, shotKey } },
      select: { id: true, e2Data: true, e3Data: true, e4Data: true }
    });
    if (!shot) {
      // 返修轮问题卡坐标可能引用上一轮已重编号/删除的镜号（E1 重建后旧坐标失效）：
      // 容忍缺失并跳过，不让整批修复因过期坐标失败
      if (options.tolerateMissing) continue;
      throw new Error(`${field}引用了不存在的镜号${shotKey}。`);
    }
    const previous = safeParseJson(shot[column]);
    await prisma.storyboardShot.update({
      where: { id: shot.id },
      data: { [column]: JSON.stringify({ ...previous, ...patch.fields }), revision: context.revision }
    });
  }
}

/** 确定性单元分组（零 Token）：按场次+时空层连续打包，目标 12–15 秒、硬上限 15 秒。 */
export function computeUnitPartition(
  context: PipelineContext,
  shots: WorkingShot[]
): Array<{ unitKey: string; sceneId: string; timeLayer: string; shotIds: string[]; duration: number; needsReason: boolean }> {
  const sceneKeys = [...new Set(shots.map((shot) => String(shot.scene_id)))];
  const partition: Array<{ unitKey: string; sceneId: string; timeLayer: string; shotIds: string[]; duration: number; needsReason: boolean }> = [];
  let unitSeq = 0;
  for (const sceneKey of sceneKeys) {
    const layers = [...new Set(shots.filter((shot) => String(shot.scene_id) === sceneKey).map((shot) => String(shot.time_layer)))];
    for (const layer of layers) {
      const group = shots.filter((shot) => String(shot.scene_id) === sceneKey && String(shot.time_layer) === layer);
      const units: Array<{ shotIds: string[]; duration: number }> = [];
      let current: string[] = [];
      let currentDuration = 0;
      const runs = group.reduce<Array<{ shots: WorkingShot[]; duration: number }>>((all, shot) => {
        const continuityId = String((shot.e1 as Record<string, unknown>).continuity_id ?? "").trim();
        const previous = all[all.length - 1];
        const previousId = previous ? String((previous.shots[0].e1 as Record<string, unknown>).continuity_id ?? "").trim() : "";
        const adjacent = previous && shots.indexOf(previous.shots[previous.shots.length - 1]) + 1 === shots.indexOf(shot);
        if (continuityId && previous && adjacent && continuityId === previousId) {
          previous.shots.push(shot);
          previous.duration += Number(shot.duration);
        } else {
          all.push({ shots: [shot], duration: Number(shot.duration) });
        }
        return all;
      }, []);
      const speakersOf = (shot: WorkingShot) =>
        new Set((shot.dialogue as Array<Record<string, unknown>>).map((entry) => String(entry.speaker ?? "").replace(/（.*）$/, "").trim()).filter(Boolean));
      for (const run of runs) {
        const shot = run.shots[0];
        const duration = run.duration;
        const runShotIds = run.shots.map((item) => item.shot_id);
        if (current.length && currentDuration + duration > 15.0001) {
          units.push({ shotIds: current, duration: roundTenth(currentDuration) });
          current = runShotIds;
          currentDuration = duration;
          continue;
        }
        // 语义优先断点（12–15s 容器内）：上一镜无台词→本镜有台词（对白完整）；
        // 或已 ≥12s 且说话人切换（对话交换点）——12–15s 是约束不是目标，避免把对白切碎
        if (current.length && currentDuration >= 12) {
          const prevShot = group.find((item) => item.shot_id === current[current.length - 1]);
          const prevSpeakers = prevShot ? speakersOf(prevShot) : new Set<string>();
          const nextSpeakers = speakersOf(shot);
          const prevHasDialogue = prevSpeakers.size > 0;
          const nextHasDialogue = nextSpeakers.size > 0;
          const speakerSwitch = nextHasDialogue && [...prevSpeakers].some((speaker) => !nextSpeakers.has(speaker)) && [...nextSpeakers].some((speaker) => !prevSpeakers.has(speaker));
          if ((!prevHasDialogue && nextHasDialogue) || speakerSwitch) {
            units.push({ shotIds: current, duration: roundTenth(currentDuration) });
            current = runShotIds;
            currentDuration = duration;
            continue;
          }
        }
        current.push(...runShotIds);
        currentDuration += duration;
      }
      if (current.length) units.push({ shotIds: current, duration: roundTenth(currentDuration) });
      // 尾单元 <12 秒：若并给前一个单元仍 ≤15 则合并，否则保留并登记原因（场次/时长余数边界）
      while (units.length >= 2 && units[units.length - 1].duration < 12 && units[units.length - 2].duration + units[units.length - 1].duration <= 15.0001) {
        const tail = units.pop()!;
        const head = units[units.length - 1];
        head.shotIds = [...head.shotIds, ...tail.shotIds];
        head.duration = roundTenth(head.duration + tail.duration);
      }
      for (const unit of units) {
        unitSeq += 1;
        partition.push({
          unitKey: `${sceneKey}-U${String(unitSeq).padStart(2, "0")}`,
          sceneId: sceneKey,
          timeLayer: layer,
          shotIds: unit.shotIds,
          duration: unit.duration,
          needsReason: unit.duration < 12
        });
      }
    }
  }
  return partition;
}

async function persistUnits(context: PipelineContext, shots: WorkingShot[], output: E3UnitOutput, options: { partial?: boolean; allowedUnits?: Set<string> } = {}) {
  if (!(output.units ?? []).length) throw new Error("E3没有返回任何Seedance单元字段。");
  const fieldsByUnit = new Map((output.units ?? []).map((unit) => [String(unit.unit_id ?? ""), unit as Record<string, unknown>]));
  // 修复轮只接受命中单元的创作字段：模型不守"只写命中单元"时，未命中单元的输出一律丢弃
  //（否则模型重写未命中单元会引入新 BLOCKER，修 A 破 B）
  if (options.allowedUnits) {
    for (const key of [...fieldsByUnit.keys()]) {
      if (!options.allowedUnits.has(key)) fieldsByUnit.delete(key);
    }
  }
  await applyUnitPartition(context, shots, fieldsByUnit);
}

/**
 * 确定性单元分组落库（零 Token）：镜号归属与单元时长由 Python 计算（硬上限15秒、不跨场次/时空层、
 * 每镜恰属一个单元）；E3 只提供单元创作字段（主导目标/站位前提/结束状态/短单元原因/绑定）。
 */
async function applyUnitPartition(
  context: PipelineContext,
  shots: WorkingShot[],
  fieldsByUnit: Map<string, Record<string, unknown>>
) {
  const sceneByKey = new Map(context.scenes.map((scene) => [scene.sceneKey, scene]));
  const partition = computeUnitPartition(context, shots);
  if (!partition.length) throw new Error("没有可分组的镜号。");
  const dbShots = await prisma.storyboardShot.findMany({ where: { episodeId: context.episodeId } });
  const shotByKey = new Map(dbShots.map((shot) => [shot.shotKey, shot]));
  const currentUnitKeys: string[] = [];

  for (const [index, part] of partition.entries()) {
    const scene = sceneByKey.get(part.sceneId);
    if (!scene) throw new Error(`${part.unitKey}引用了不存在的场次${part.sceneId}。`);
    const fields = fieldsByUnit.get(part.unitKey) ?? {};
    // 增量更新：E3 返修/机械重排只输出部分单元时，未覆盖单元的既有创作字段必须保留
    //（否则会把已填好的目标/前提洗成待补充，修复轮来回振荡）
    const previousUnit = await prisma.seedanceUnit.findUnique({
      where: { episodeId_unitKey: { episodeId: context.episodeId, unitKey: part.unitKey } }
    });
    const previousData = previousUnit ? safeParseJson(previousUnit.data) : {};
    const previousBindings = Array.isArray(previousData.subject_bindings) ? previousData.subject_bindings.map(String) : [];
    const autoReason = part.needsReason ? "本场分镜时长组合余数不足12秒" : null;
    const shortReason = part.needsReason ? (optionalString(fields.short_unit_reason) ?? previousUnit?.shortUnitReason ?? autoReason) : null;
    // 群像单元标记：出场 ≥3 人或含 GROUP 资产或含群像镜 → crowd，供 E5 审查与编译层按群像约束处理
    const unitShots = part.shotIds.map((id) => shots.find((shot) => shot.shot_id === id)).filter(Boolean) as WorkingShot[];
    const requestedBindings = Array.isArray(fields.subject_bindings) ? fields.subject_bindings.map(String) : previousBindings;
    // 同一资产可能被模型写成“县学书吏@书吏｜默认”和“书吏@CH-005-1”两种别名。
    // 先解析到最终资产 code 再去重，避免一个形象以两个主体名进入 Seedance。
    const unitBindings: string[] = [];
    const boundAssetCodes = new Set<string>();
    const boundAssetFamilies = new Set<string>();
    const boundFallbackNames = new Set<string>();
    for (const binding of requestedBindings) {
      const resolved = resolveAssetReference(context.project.assets, binding, part.sceneId);
      const fallbackName = binding.split("@")[0].trim();
      if (resolved) {
        if (boundAssetCodes.has(resolved.code)) continue;
        boundAssetCodes.add(resolved.code);
        boundAssetFamilies.add(assetFamilyCode(resolved.code));
      } else {
        if (!fallbackName || boundFallbackNames.has(fallbackName)) continue;
        boundFallbackNames.add(fallbackName);
      }
      unitBindings.push(binding);
    }
    // 绑定机械补全（零 Token）：单元文本命中的 CH/BEAST/GROUP/系统面板 未绑定 → 直接追加 "主名@资产码"
    // ——漏绑是纯机械错误（画面写了形象没绑定），无需模型返修
    {
      // 只认最终画面/机位里的可见主体；premise 可能写“刚绕过某人”等历史状态，不能据此把已离场人物重新绑定。
      const unitVisualClauses = unitShots.flatMap((shot) => {
        const cells = composeShotCells({
          e1: shot.e1 as Record<string, unknown>,
          e2: shot.e2 as Record<string, unknown>,
          e3: shot.e3 as Record<string, unknown>,
          e4: shot.e4 as Record<string, unknown>
        });
        return [cells.picture, cells.camera_motion];
      }).join("；").split(/[\r\n，,。！？!?；;]+/u).map((clause) => clause.trim()).filter(Boolean);
      const seenFamilies = new Set<string>();
      for (const asset of context.project.assets) {
        if (!(asset.type === "CH" || asset.type === "BEAST" || asset.type === "GROUP" || (asset.type === "PROP" && /系统|面板/.test(asset.name)))) continue;
        const mainName = asset.name.split("｜")[0].trim();
        const family = assetFamilyCode(asset.code);
        if (mainName.length < 2 || seenFamilies.has(family)) continue;
        seenFamilies.add(family);
        const visibleReferences = collectVisibleAssetReferences(context.project.assets, unitVisualClauses, asset, part.sceneId);
        for (const visible of visibleReferences) {
          if (visible.exact ? boundAssetCodes.has(visible.code) : boundAssetFamilies.has(assetFamilyCode(visible.code))) continue;
          unitBindings.push(`${mainName}@${visible.code}`);
          boundAssetCodes.add(visible.code);
          boundAssetFamilies.add(assetFamilyCode(visible.code));
        }
      }
    }
    const crowd = unitBindings.length >= 3 || unitBindings.some((b) => b.includes("GROUP")) || unitShots.some(isCrowdShot);
    const data: Record<string, unknown> = {
      unit_id: part.unitKey,
      shot_ids: part.shotIds,
      unit_duration: part.duration,
      unit_dominant_goal: optionalString(fields.unit_dominant_goal) ?? previousUnit?.dominantGoal ?? null,
      unit_start_premise: optionalString(fields.unit_start_premise) ?? previousUnit?.startPremise ?? "待补充",
      unit_end_state: optionalString(fields.unit_end_state) ?? previousUnit?.endState ?? "待补充",
      short_unit_reason: shortReason,
      subject_bindings: unitBindings,
      crowd,
      // 单元级光影（E4 产出）不在本岗位白名单：增量重建时必须保留，否则每次修复轮单元重算都丢
      ...(previousData.unit_lighting ? { unit_lighting: previousData.unit_lighting } : {})
    };
    currentUnitKeys.push(part.unitKey);
    const unit = await prisma.seedanceUnit.upsert({
      where: { episodeId_unitKey: { episodeId: context.episodeId, unitKey: part.unitKey } },
      create: {
        episodeId: context.episodeId,
        sceneId: scene.id,
        unitKey: part.unitKey,
        sortOrder: index + 1,
        duration: part.duration,
        shortUnitReason: optionalString(data.short_unit_reason),
        dominantGoal: optionalString(data.unit_dominant_goal),
        startPremise: String(data.unit_start_premise),
        endState: String(data.unit_end_state),
        data: JSON.stringify(data),
        revision: context.revision
      },
      update: {
        sceneId: scene.id,
        sortOrder: index + 1,
        duration: part.duration,
        shortUnitReason: optionalString(data.short_unit_reason),
        dominantGoal: optionalString(data.unit_dominant_goal),
        startPremise: String(data.unit_start_premise),
        endState: String(data.unit_end_state),
        data: JSON.stringify(data),
        revision: context.revision
      }
    });
    await prisma.seedanceUnitShot.deleteMany({ where: { unitId: unit.id } });
    for (const [shotIndex, shotId] of part.shotIds.entries()) {
      const shot = shotByKey.get(shotId);
      if (!shot) throw new Error(`${part.unitKey}无法关联镜号${shotId}。`);
      await prisma.seedanceUnitShot.create({ data: { unitId: unit.id, shotId: shot.id, sortOrder: shotIndex + 1 } });
    }
  }
  // 分组永远由 Python 全量重算：清理本轮不再存在的单元（含其提示词版本）与遗留链接
  await prisma.seedanceUnit.deleteMany({
    where: { episodeId: context.episodeId, unitKey: { notIn: currentUnitKeys } }
  });
}

/**
 * 镜号时长/结构变化后同步单元分组（零 Token）：E1 返修会改动时长，必须立刻按新表重算分组。
 * 字段按"镜号组合完全一致"继承；组合变化的单元字段重置为待补充并开 MINOR 卡给 E3。
 */
async function resyncUnitsAfterShotsChanged(context: PipelineContext) {
  const existing = await prisma.seedanceUnit.findMany({
    where: { episodeId: context.episodeId },
    include: { shotLinks: { include: { shot: true }, orderBy: { sortOrder: "asc" } } }
  });
  if (!existing.length) return; // 尚无单元：等 E3 首次组装
  const full = await hydrateWorkingShots(context);
  if (!full.length) return;
  const fieldsByShotIds = new Map<string, Record<string, unknown>>();
  const needsFields: string[] = [];
  const partition = computeUnitPartition(context, full);
  for (const part of partition) {
    const match = existing.find((unit) => JSON.stringify(unit.shotLinks.map((link) => link.shot.shotKey)) === JSON.stringify(part.shotIds));
    if (match) {
      const raw = safeParseJson(match.data);
      fieldsByShotIds.set(part.unitKey, {
        unit_id: part.unitKey,
        unit_dominant_goal: raw.unit_dominant_goal ?? null,
        unit_start_premise: raw.unit_start_premise ?? null,
        unit_end_state: raw.unit_end_state ?? null,
        short_unit_reason: raw.short_unit_reason ?? null,
        subject_bindings: raw.subject_bindings ?? []
      });
    } else {
      fieldsByShotIds.set(part.unitKey, { unit_id: part.unitKey });
      needsFields.push(part.unitKey);
    }
  }
  await applyUnitPartition(context, full, fieldsByShotIds);
  if (needsFields.length) {
    const coordinate = "E3.unit_fields";
    const existingCard = await prisma.workflowIssue.findFirst({
      where: { episodeId: context.episodeId, coordinate, code: "UNIT_FIELDS_RESET", revision: context.revision, status: "OPEN" }
    });
    if (!existingCard) {
      await prisma.workflowIssue.create({
        data: {
          projectId: context.projectId,
          episodeId: context.episodeId,
          coordinate,
          code: "UNIT_FIELDS_RESET",
          severity: "MINOR",
          status: "OPEN",
          ownerRole: "E3",
          expected: "分组变化后的单元补写创作字段",
          evidence: `镜号时长变化导致分组重排：${needsFields.join("、")} 的站位前提/剧情结果已重置为待补充，请运行 E3 补写`,
          requestedEffect: "运行 E3 定向补写命中单元字段",
          revision: context.revision
        }
      });
    }
  }
}

export function validatePipeline(context: PipelineContext, shots: WorkingShot[], units: Record<string, unknown>[]): PipelineIssue[] {
  const issues: PipelineIssue[] = [];
  const covered = new Set(shots.flatMap((shot) => stringArray(shot.source_node_refs)));
  for (const nodeId of context.sourceNodes.keys()) {
    if (!covered.has(nodeId)) issues.push({
      coordinate: `source_node.${nodeId}`,
      code: "SOURCE_NODE_UNCOVERED",
      severity: "BLOCKER",
      ownerRole: "E1",
      expected: "每个锁定源节点至少由一个镜号承载",
      evidence: `${nodeId}没有出现在任何source_node_refs中`,
      requestedEffect: "在不改原文顺序的前提下补回该节点的真实承载镜号"
    });
  }
  const confirmedContractAnswers = ((context.contracts ?? []) as Array<Record<string, unknown>>)
    .filter((contract) => contract.status === undefined || String(contract.status) === "CONFIRMED")
    .map((contract) => String(contract.user_answer ?? ""));
  for (const shot of shots) {
    const e1 = shot.e1 as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(e1, "visible_text")) continue;
    if (!Array.isArray(e1.visible_text)) {
      issues.push(issue(`${shot.shot_id}.visible_text`, "VISIBLE_TEXT_DECLARATION_INVALID", "BLOCKER", "E1", "visible_text 必须是数组", "按 E1 合同输出合法声明数组，无文字时填 []"));
      continue;
    }
    const refs = new Set(shotSourceNodeIds(shot));
    for (let index = 0; index < e1.visible_text.length; index += 1) {
      const validation = validateVisibleTextDeclaration(e1.visible_text[index]);
      const coordinate = `${shot.shot_id}.visible_text.${index}`;
      if (!validation.valid) {
        issues.push(issue(coordinate, "VISIBLE_TEXT_DECLARATION_INVALID", "BLOCKER", "E1", validation.reason, "删除非法声明，或改为合法剧情内实体/UI文字声明"));
        continue;
      }
      const declaration = validation.declaration;
      const contractVerified = confirmedContractAnswers.some((answer) => answer.includes(declaration.content));
      const actionNodeContains = (id: string) => {
        const node = context.sourceNodes.get(id);
        return node?.type === "ACTION" && node.text.includes(declaration.content);
      };
      const sourceVerified = declaration.source_node_id
        ? refs.has(declaration.source_node_id) && actionNodeContains(declaration.source_node_id)
        : [...refs].some(actionNodeContains);
      const provenanceVerified = declaration.source_node_id ? sourceVerified : sourceVerified || contractVerified;
      if (!provenanceVerified) {
        issues.push(issue(coordinate, "VISIBLE_TEXT_SOURCE_UNVERIFIED", "BLOCKER", "E1", `声明文字“${declaration.content}”未逐字命中本镜锁定源节点或已确认表现合同`, "删除伪造文字，或绑定包含该逐字内容的本镜源节点/确认合同"));
      }
    }
  }
  // 轻量执行容量门：一镜只允许一个可见说话主体；至少三段明确连续动作必须拆镜。
  for (const shot of shots) {
    const speakers = new Set((shot.dialogue as Array<Record<string, unknown>>)
      .filter((entry) => !/(^|_)(OS|VO|NARRATION|SYSTEM)$|旁白|系统/i.test(String(entry.type ?? "")))
      .map((entry) => String(entry.speaker ?? "").replace(/（.*）$/, "").trim()).filter(Boolean));
    if (speakers.size > 1) {
      issues.push(issue(`${shot.shot_id}.speaker`, "MULTI_SPEAKER_SHOT", "BLOCKER", "E1", `同镜包含多个可见说话人：${[...speakers].join("/")}`, "拆为一镜一个说话人；OS/VO/旁白/SYSTEM 可保留画外承载"));
    }
    const picture = String((shot.e2 as Record<string, unknown>).picture ?? (shot.e1 as Record<string, unknown>).picture ?? "");
    if (countSequentialActionPhases(picture) >= 3) {
      issues.push(issue(`${shot.shot_id}.picture`, "ACTION_PHASE_OVERLOAD", "MAJOR", "E1", "同镜画面含至少三段明确连续动作", "按动作阶段拆镜，每镜只保留一个清晰动作结果"));
    }
  }
  // continuity_id 只锁真正不可切的相邻连续动作/道具交接；超过 15 秒允许整组保留，但必须退回 E1 重拆。
  for (let index = 0; index < shots.length;) {
    const first = shots[index];
    const continuityId = String((first.e1 as Record<string, unknown>).continuity_id ?? "").trim();
    if (!continuityId) { index += 1; continue; }
    let end = index + 1;
    let duration = Number(first.duration);
    while (end < shots.length) {
      const next = shots[end];
      const nextId = String((next.e1 as Record<string, unknown>).continuity_id ?? "").trim();
      if (next.scene_id !== first.scene_id || next.time_layer !== first.time_layer || nextId !== continuityId) break;
      duration += Number(next.duration);
      end += 1;
    }
    if (duration > 15.0001) {
      issues.push(issue(`${first.shot_id}.continuity_id`, "CONTINUITY_GROUP_OVER_LIMIT", "BLOCKER", "E1", `连续组 ${continuityId} 共 ${roundTenth(duration)} 秒，超过单元 15 秒上限`, "仅在真正不可切链上保留 continuity_id，并将该连续动作拆至≤15秒"));
    }
    index = end;
  }
  // E0 骨架校验（Narrative + Director Gate）：SEQUENCE_BOUNDARY / BEAT_BOUNDARY / BEAT_SHOT_OVERFLOW / VISUAL_STEP
  if (context.beats.length) {
    const nodeSeq = new Map<string, number>();
    let seq = 0;
    for (const node of context.sourceNodes.values()) nodeSeq.set(node.source_node_id, ++seq);
    const beatRanges = context.beats.map((beat) => {
      const range = Array.isArray(beat.node_range) ? beat.node_range.map(Number) : [];
      return {
        id: String(beat.beat_id ?? ""),
        start: range[0] ?? 0,
        end: range[1] ?? 0,
        maxShots: Number(beat.max_shots ?? 0),
        sequenceId: String(beat.sequence_id ?? ""),
        visualSteps: (Array.isArray(beat.visual_steps) ? beat.visual_steps : [])
          .map((step) => String((step as Record<string, unknown>).step_id ?? ""))
          .filter(Boolean)
      };
    });
    const sequenceRanges = context.sequences.map((seqItem) => ({
      id: String(seqItem.sequence_id ?? ""),
      start: Number(seqItem.node_range?.[0] ?? 0),
      end: Number(seqItem.node_range?.[1] ?? 0)
    }));
    const seqsOf = (shot: WorkingShot): number[] => [
      ...(shot.dialogue as Array<Record<string, unknown>>).map((entry) => nodeSeq.get(String(entry.source_node_id ?? ""))),
      ...stringArray(shot.source_node_refs).map((id) => nodeSeq.get(id))
    ].filter((value): value is number => value !== undefined);
    const visualStepOf = (shot: WorkingShot): { raw: string; beatId: string; stepId: string } | null => {
      const e1 = shot.e1 as Record<string, unknown> | undefined;
      const raw = String(e1?.fulfills_visual_step ?? "").trim();
      if (!raw) return null;
      const namespaced = /^([^.\s]+)\.([^.\s]+)$/.exec(raw);
      return {
        raw,
        beatId: String(e1?.visual_step_beat_id ?? e1?.beat_id ?? namespaced?.[1] ?? "").trim(),
        stepId: namespaced?.[2] ?? raw
      };
    };

    // SEQUENCE_BOUNDARY（因果链闸门）：同一镜承载不同 Sequence 的节点 = 强因果链被打断
    if (sequenceRanges.length) {
      for (const shot of shots) {
        const seqs = seqsOf(shot);
        if (!seqs.length) continue;
        const minSeq = Math.min(...seqs);
        const maxSeq = Math.max(...seqs);
        const hit = sequenceRanges.filter((s) => s.start <= maxSeq && minSeq <= s.end);
        if (hit.length > 1) {
          issues.push(issue(
            `${shot.shot_id}.sequence`,
            "SEQUENCE_BOUNDARY",
            "BLOCKER",
            "E1",
            `镜头跨 Sequence（${hit.map((s) => s.id).join("→")}）：同一镜承载了不同因果链的节点`,
            `按 E0 骨架拆分：一个镜头只承载同一 Sequence 内的节点（Sequence 锁强因果链）`
          ));
        }
      }
    }
    const beatByShot = new Map<string, string>();
    for (const shot of shots) {
      const seqs = seqsOf(shot);
      if (!seqs.length) continue;
      const minSeq = Math.min(...seqs);
      const hit = beatRanges.find((beat) => beat.start <= minSeq && minSeq <= beat.end);
      if (hit) beatByShot.set(shot.shot_id, hit.id);
    }
    const shotCountByBeat = new Map<string, number>();
    for (const shot of shots) {
      const beatId = beatByShot.get(shot.shot_id);
      if (!beatId) continue;
      shotCountByBeat.set(beatId, (shotCountByBeat.get(beatId) ?? 0) + 1);
      // 镜内跨度跨 Beat（如节点#5 与 #12 同镜）：叙事单元被合并打碎
      const seqs = seqsOf(shot);
      if (!seqs.length) continue;
      const minSeq = Math.min(...seqs);
      const maxSeq = Math.max(...seqs);
      const beatsHit = beatRanges.filter((beat) => beat.start <= maxSeq && minSeq <= beat.end);
      if (beatsHit.length > 1) {
        issues.push(issue(
          `${shot.shot_id}.beat`,
          "BEAT_BOUNDARY",
          "BLOCKER",
          "E1",
          `镜头跨叙事 Beat（${beatsHit.map((b) => b.id).join("→")}）：同一镜承载了不同戏剧单元的节点`,
          `按 E0 骨架拆分：一个镜头只承载同一 Beat 内的节点`
        ));
      }
    }
    for (const beat of beatRanges) {
      if (!beat.maxShots) continue;
      const count = shotCountByBeat.get(beat.id) ?? 0;
      if (count > Math.ceil(beat.maxShots * 1.3)) {
        // 预算降级为参考（顾问与用户共识）：E0 的镜数预算是拍脑袋（对话段系统性低估，
        // E1 稳定拆出 57-58 镜），用它开卡只会冤枉合理节奏——降为 MINOR 纯提示，不阻塞不返修
        issues.push(issue(
          `${beat.id}.shots`,
          "BEAT_SHOT_OVERFLOW",
          "MINOR",
          "E1",
          `${beat.id} 实际 ${count} 镜，高于参考预算 ${beat.maxShots} 镜（仅供节奏参考，不阻塞）`,
          `参考：若存在无新信息的过渡镜可合并；否则维持当前节奏`
        ));
      }
      // DIRECTOR_CONTRACT 验收（VISUAL_STEP）：每个视觉步骤必须有镜头声明 fulfills_visual_step
      if (!beat.visualSteps.length) continue;
      const beatShotIds = new Set([...beatByShot.entries()].filter(([, id]) => id === beat.id).map(([shotId]) => shotId));
      const declared = new Set<string>();
      for (const shot of shots) {
        if (!beatShotIds.has(shot.shot_id)) continue;
        const declaredStep = visualStepOf(shot);
        if (!declaredStep) continue;
        if (!String((shot.e1 as Record<string, unknown>).visual_step_part_goal ?? "").trim()) {
          issues.push(issue(`${shot.shot_id}.visual_step_part_goal`, "VISUAL_STEP_PART_GOAL_MISSING", "BLOCKER", "E1", `${shot.shot_id} 声明 ${declaredStep.raw} 但未写本镜视觉贡献`, "为本镜补 visual_step_part_goal，仅写本镜动作结果或视觉贡献"));
        }
        const wrongBeat = Boolean(declaredStep.beatId && declaredStep.beatId !== beat.id);
        if (wrongBeat || !beat.visualSteps.includes(declaredStep.stepId)) {
          issues.push(issue(
            `${shot.shot_id}.visual_step`,
            "VISUAL_STEP_INVALID",
            "MAJOR",
            "E1",
            wrongBeat
              ? `${shot.shot_id} 声明 fulfills_visual_step=${declaredStep.raw}，但其源节点属于 ${beat.id}`
              : `${shot.shot_id} 声明 fulfills_visual_step=${declaredStep.raw}，但 ${beat.id} 没有步骤 ${declaredStep.stepId}（合法：${beat.visualSteps.join("/")}）`,
            `改为 ${beat.id} 内存在的步骤（推荐命名空间 ${beat.id}.Vx），或去掉该声明`
          ));
        } else {
          declared.add(declaredStep.stepId);
        }
      }
      for (const stepId of beat.visualSteps) {
        if (!declared.has(stepId)) {
          issues.push(issue(
            `${beat.id}.visual_step.${stepId}`,
            "VISUAL_STEP_UNFULFILLED",
            "BLOCKER",
            "E1",
            `${beat.id} 视觉步骤 ${stepId} 未被任何镜头声明 fulfills（导演合同未执行：台词拍完了但升级没拍出来）`,
            `为该 Beat 内承载该步骤的镜头补 fulfills_visual_step=${stepId}，或新增一个完成该步骤的镜头`
          ));
        }
      }
    }
  }
  // 源节点顺序单调性（叙事顺序闸门）：沿最终镜头顺序展开对话节点，除闪回/梦境/想象外必须单调向后。
  // 覆盖 100% 但顺序错乱 = 故事死亡（如补漏/重排把早期节点排到末尾），这是比漏覆盖更严重的错误。
  {
    const nodeSeq = new Map<string, number>();
    let seq = 0;
    for (const node of context.sourceNodes.values()) nodeSeq.set(node.source_node_id, ++seq);
    let prevMax = 0;
    let prevShotId = "";
    for (const shot of shots) {
      if (/(闪回|梦境|想象)/.test(String(shot.time_layer ?? ""))) continue;
      // 顺序键只认 dialogue 承载；sourceNodeRefs 是覆盖集合（不保序、常有漏/多），仅无台词镜兜底
      const dialogueSeqs = (shot.dialogue as Array<Record<string, unknown>>)
        .map((entry) => nodeSeq.get(String(entry.source_node_id ?? "")))
        .filter((value): value is number => value !== undefined);
      const refSeqs = stringArray(shot.source_node_refs).map((id) => nodeSeq.get(id)).filter((value): value is number => value !== undefined);
      const hasDialogue = dialogueSeqs.length > 0;
      const seqs = hasDialogue ? dialogueSeqs : refSeqs;
      if (!seqs.length) continue;
      const minSeq = Math.min(...seqs);
      // 镜内顺序（INTRA_SHOT_SOURCE_ORDER）：一镜多节点（相邻对白交换允许）时，条目必须按源节点序排列——
      // 修复轮合并镜时曾出现 [Q版(节点12), OS(节点11)] 倒序，镜间单调检查抓不到
      if (hasDialogue) {
        const entries = shot.dialogue as Array<Record<string, unknown>>;
        let intraReversed = false;
        for (let i = 0; i < entries.length && !intraReversed; i++) {
          const a = nodeSeq.get(String(entries[i].source_node_id ?? ""));
          if (a === undefined) continue;
          for (let j = i + 1; j < entries.length; j++) {
            const b = nodeSeq.get(String(entries[j].source_node_id ?? ""));
            if (b !== undefined && a > b) {
              intraReversed = true;
              break;
            }
          }
        }
        if (intraReversed) {
          issues.push(issue(
            `${shot.shot_id}.dialogue`,
            "INTRA_SHOT_SOURCE_ORDER",
            "BLOCKER",
            "E1",
            `镜内台词顺序违反源剧本：同一镜内节点应按原顺序排列（如先节点#${Math.min(...seqs)} 再 #${Math.max(...seqs)}）`,
            "把本镜 dialogue 条目按源节点顺序重排（同节点续段可相邻），禁止 Q版吐槽/OS 等跨节点倒序"
          ));
        }
      }
      // 一镜混入非相邻节点（跨度>1，如 [N0028, N0036]）：对话交换混镜，需 E1 拆镜重写
      if (hasDialogue && Math.max(...seqs) - minSeq > 1) {
        issues.push(issue(
          `${shot.shot_id}.dialogue`,
          "NODE_MIXED_IN_SHOT",
          "BLOCKER",
          "E1",
          `一镜混入跨度 ${Math.max(...seqs) - minSeq} 的源节点（#${minSeq}–#${Math.max(...seqs)}），中间节点被其他镜承载`,
          "把本镜按源节点边界拆开：每个节点（含其续段）独立成镜或相邻节点按对白交换顺序重排，禁止跨节点混镜"
        ));
        continue; // 混镜镜不参与顺序闸门推进，避免连锁误报
      }
      if (minSeq < prevMax) {
        issues.push(issue(
          `${shot.shot_id}.order`,
          "SOURCE_ORDER_MONOTONIC",
          "BLOCKER",
          "E1",
          `镜头顺序违反源剧本：本镜承载节点#${minSeq}，上一镜(${prevShotId})已达节点#${prevMax}（闪回/梦境除外）`,
          "把本镜（及其后继镜）按源节点顺序插回正确位置，禁止把漏覆盖节点追加到场景末尾"
        ));
      }
      // 台词镜按 max 推进（dialogue 可靠）；动作镜按 min 推进（refs 常有漏写/多写，max 会虚高误伤）
      prevMax = Math.max(prevMax, hasDialogue ? Math.max(...seqs) : minSeq);
      prevShotId = shot.shot_id;
    }
  }
  // SPEAKER_ALIGNMENT（Generation Gate）：非 OS 对白镜的台词说话人必须与声音格子的说话人一致——
  // 修复轮曾把"苏远说低调低调"修成"机位/画面/声音都是同学乙"的错位（台词与声音分离）
  {
    const dialogueSpeakers = new Set<string>();
    for (const node of context.sourceNodes.values()) {
      if (node.type === "DIALOGUE") {
        const name = String(node.speaker ?? "").replace(/（.*）$/, "").replace(/内心$/, "").trim();
        if (name) dialogueSpeakers.add(name);
      }
    }
    const speakerNameList = [...dialogueSpeakers].sort((a, b) => b.length - a.length); // 长名优先，避免"同学甲"吃掉"同学甲二"
    for (const shot of shots) {
      const entries = shot.dialogue as Array<Record<string, unknown>>;
      const hasSpokenDialogue = entries.some((entry) => String(entry.type ?? "对白") === "对白");
      if (!hasSpokenDialogue) continue;
      const speakerSet = new Set(
        entries
          .filter((entry) => String(entry.type ?? "对白") === "对白")
          .map((entry) => String(entry.speaker ?? "").replace(/（.*）$/, "").replace(/内心$/, "").trim())
          .filter(Boolean)
      );
      const soundText = composeSound(shot.e1 as Record<string, unknown>, shot.e3 as Record<string, unknown>);
      for (const name of speakerNameList) {
        if (name.length < 2) continue;
        if (speakerSet.has(name)) continue;
        // 声音格子明示"X说话/开口/说道"，但台词里没有 X——说话人错位
        if (hasExplicitSpeakingActor(soundText, name)) {
          issues.push(issue(
            `${shot.shot_id}.sound`,
            "SPEAKER_ALIGNMENT",
            "BLOCKER",
            "E3",
            `声音格子写「${name}说话声」但本镜台词说话人是 ${[...speakerSet].join("、") || "无"}（非 OS 对白）`,
            "让台词、画面主说话人、声音三者在同一镜保持一致：改台词说话人或改声音格子"
          ));
          break; // 每镜最多一张
        }
      }
    }
  }
  // ACTION_EVENT_ANCHOR（Narrative Gate）：不可逆动作（转身离开/走下/交付/倒下/扑出等）禁止提前执行——
  // 源剧本"好聚好散 → 转身就走"，若转身镜头提前到"还是分开吧"镜里，人物会"走了一次又回来聊"
  {
    const anchorWords = /(?:转身离开|转身就走|转身离去|转身大步|迈步离开|走下高台|走出大厅|走出教室|离开大厅|离开现场|冲出去|跑出去|扑上来|扑倒|跪下来|跪倒在地|倒在地上|晕倒|昏倒|交付|递给|塞给|抱紧|抱起|拔剑|拔刀|抽出|扔出|摔在地上|关门|跳下|按下|碎裂|崩裂)/;
    const nodeSeq = new Map<string, number>();
    let seq = 0;
    for (const node of context.sourceNodes.values()) nodeSeq.set(node.source_node_id, ++seq);
    const anchorNodes = new Map<string, number>(); // nodeId -> seq
    for (const node of context.sourceNodes.values()) {
      if (node.type === "ACTION" && anchorWords.test(node.text)) {
        anchorNodes.set(node.source_node_id, nodeSeq.get(node.source_node_id) ?? 0);
      }
    }
    if (anchorNodes.size) {
      for (const shot of shots) {
        if (/(闪回|梦境|想象)/.test(String(shot.time_layer ?? ""))) continue;
        const dialogueSeqs = (shot.dialogue as Array<Record<string, unknown>>)
          .map((entry) => nodeSeq.get(String(entry.source_node_id ?? "")))
          .filter((value): value is number => value !== undefined);
        if (!dialogueSeqs.length) continue; // 纯动作镜顺序由 renormalize 保证
        const minDialogueSeq = Math.min(...dialogueSeqs);
        const e1Text = String((shot.e1 as Record<string, unknown>)?.picture ?? (shot.e1 as Record<string, unknown>)?.visual_goal ?? "");
        const e2Text = String((shot.e2 as Record<string, unknown>)?.picture ?? "");
        const cells = composeShotCells({
          e1: shot.e1 as Record<string, unknown>,
          e2: shot.e2 as Record<string, unknown>,
          e3: shot.e3 as Record<string, unknown>,
          e4: shot.e4 as Record<string, unknown>
        });
        for (const [nodeId, anchorSeq] of anchorNodes) {
          if (anchorSeq <= minDialogueSeq) continue; // 动作锚点不早于本镜台词
          const anchorText = (context.sourceNodes.get(nodeId)?.text ?? "").slice(0, 12);
          // 按格子归属拆分开卡：e1（E1 画面目标）违规归 E1；e2（E2 表演画面）违规归 E2——
          // 修复轮只改命中坐标的格子，合并画面违规必须分别定位到各自岗位，否则永远修不净。
          // 只按画面文本判断：refs 是节点覆盖标记（S035 可能挂着后续镜的锚点节点），
          // 不是画面内容，用 refs 判"提前执行"会让修好的镜永远开卡
          const e1Mentioned = e1Text.includes(anchorText);
          const e2Mentioned = e2Text.includes(anchorText);
          const mergedMentioned = cells.picture.includes(anchorText);
          if (e1Mentioned) {
            issues.push(issue(
              `${shot.shot_id}.anchor`,
              "ACTION_EVENT_ANCHOR",
              "BLOCKER",
              "E1",
              `【E1 画面目标格子 e1.picture】含不可逆动作「${anchorText}」被提前到节点#${minDialogueSeq} 的镜中执行（原剧本锚点在 #${anchorSeq}）`,
              "把该动作移回其源节点顺序位置之后的镜号（或删除本镜中的提前动作），禁止人物先离开又回来"
            ));
          }
          // e2 违规也单独开 E2 卡（不因 e1 有卡就跳过）：合并画面必须两个格子都清干净，一轮修完
          if (e2Mentioned && mergedMentioned) {
            issues.push(issue(
              `${shot.shot_id}.picture`,
              "ACTION_EVENT_ANCHOR",
              "BLOCKER",
              "E2",
              `【E2 表演画面格子 e2.picture】含不可逆动作「${anchorText}」被提前到节点#${minDialogueSeq} 的镜中执行（原剧本锚点在 #${anchorSeq}）`,
              "把该动作移回其源节点顺序位置之后的镜号（或删除本镜中的提前动作），禁止人物先离开又回来"
            ));
          }
        }
      }
    }
  }
  // 每镜时长与字速硬校验（五岗版规则）
  for (const shot of shots) {
    const duration = Number(shot.duration);
    const dialogueEntries = shot.dialogue as Array<Record<string, unknown>>;
    const dialogueChars = (shot.dialogue as Array<Record<string, unknown>>).reduce(
      (sum, entry) => sum + spokenCharCount(String(entry.text ?? "")),
      0
    );
    const shotTicks = Math.max(0, Math.round(duration * 10));
    const minimumTicks = dialogueMinimumTicks(dialogueEntries);
    if (dialogueEntries.length && minimumTicks > shotTicks) {
      issues.push(issue(`${shot.shot_id}.dialogue`, "DIALOGUE_TIMING_CAPACITY", "BLOCKER", "E1", `对白按6字/秒硬下限至少需${minimumTicks} tick，镜长仅${shotTicks} tick`, "按语义拆到相邻镜或增加合法镜长，禁止伪造对白时段"));
    }
    if (duration > 7) {
      issues.push(issue(`${shot.shot_id}.duration`, "DURATION_OVER_LIMIT", "BLOCKER", "E1", `镜长${duration}秒超过上限`, "每镜≤5秒；仅台词≤42字的台词镜允许到7秒"));
    } else if (duration > 5 && dialogueChars > 42) {
      issues.push(issue(`${shot.shot_id}.duration`, "DURATION_OVER_LIMIT", "BLOCKER", "E1", `台词${dialogueChars}字超过42字，镜长${duration}秒不允许`, "拆成相邻镜，每镜≤5秒"));
    } else if (duration > 5 && dialogueChars === 0) {
      issues.push(issue(`${shot.shot_id}.duration`, "DURATION_OVER_LIMIT", "BLOCKER", "E1", `无台词镜长${duration}秒超过5秒上限`, "拆镜或压缩为≤5秒"));
    }
    for (const entry of shot.dialogue as Array<Record<string, unknown>>) {
      const chars = spokenCharCount(String(entry.text ?? ""));
      const entryDuration = Number(entry.duration ?? 0);
      if (chars > 0 && entryDuration > 0 && chars / entryDuration > 6) {
        issues.push(issue(`${shot.shot_id}.dialogue`, "SPEECH_RATE_OVER_LIMIT", "BLOCKER", "E1", `台词${chars}字÷${entryDuration}秒=${(chars / entryDuration).toFixed(1)}字/秒，超过6字/秒上限`, "拆镜或给足时长，字速不超过6字/秒"));
      }
    }
  }

  const unitShotCount = new Map<string, number>();
  for (const unit of units) {
    const unitId = String(unit.unit_id ?? "unknown-unit");
    const ids = stringArray(unit.shot_ids);
    const included = ids.map((id) => shots.find((shot) => shot.shot_id === id)).filter(Boolean) as WorkingShot[];
    ids.forEach((id) => unitShotCount.set(id, (unitShotCount.get(id) ?? 0) + 1));
    const duration = roundTenth(included.reduce((sum, shot) => sum + Number(shot.duration), 0));
    const declared = roundTenth(Number(unit.unit_duration ?? duration));
    if (duration !== declared) issues.push(issue(unitId, "UNIT_DURATION_MISMATCH", "BLOCKER", "E3", `镜号合计${duration}秒，单元声明${declared}秒`, "让单元时长等于镜号时长之和"));
    if (duration > 15) issues.push(issue(`${unitId}.shot_ids`, "UNIT_DURATION_OVER_LIMIT", "BLOCKER", "E3", `单元总时长${duration}秒，超过15秒上限（Python已自动微调过仍超限，说明本单元余量不足）`, "把最拖的一镜减0.5秒；仍超则把某一镜拆到相邻单元，或与相邻单元合并重组；单元≤15秒是唯一硬上限"));
    if (duration < 12 && !optionalString(unit.short_unit_reason)) issues.push(issue(`${unitId}.short_unit_reason`, "SHORT_REASON_MISSING", "MAJOR", "E3", `${duration}秒但未说明必要原因`, "填写场界、动作阶段、强转折、多人降载或稳定性原因"));
    const scenes = new Set(included.map((shot) => String(shot.scene_id)));
    const layers = new Set(included.map((shot) => String(shot.time_layer)));
    if (scenes.size > 1) issues.push(issue(`${unitId}.shot_ids`, "UNIT_CROSSES_SCENE", "BLOCKER", "E3", `包含场次：${[...scenes].join("、")}`, "拆到单一场次内"));
    if (layers.size > 1) issues.push(issue(`${unitId}.shot_ids`, "UNIT_CROSSES_TIME_LAYER", "BLOCKER", "E3", `包含时空层：${[...layers].join("、")}`, "拆到单一时空层内"));
    // 站位前提/结束状态/主导目标是投喂 Seedance 的独立前提，不允许"待补充"占位
    const premise = optionalString(unit.unit_start_premise);
    const endState = optionalString(unit.unit_end_state);
    const dominantGoal = optionalString(unit.unit_dominant_goal);
    if (!premise || /待补充|待完善|暂无/.test(premise) || !endState || /待补充|待完善|暂无/.test(endState) || !dominantGoal || /待补充|待完善|暂无/.test(dominantGoal)) {
      issues.push(issue(`${unitId}.fields`, "UNIT_FIELDS_INCOMPLETE", "BLOCKER", "E3",
        `站位前提/结束状态/主导目标含待补充（premise=${premise || "空"}）`,
        "按剧本内容写清单元开场各人物/道具站位、结束状态与一句话剧情结果，禁止占位"));
    }
  }
  for (const shot of shots) {
    const count = unitShotCount.get(shot.shot_id) ?? 0;
    if (count !== 1) issues.push(issue(`${shot.shot_id}.unit_link`, "SHOT_UNIT_LINK_INVALID", "BLOCKER", "E3", `该镜关联${count}个单元`, "让每个小镜号按顺序且仅归属一个生成单元"));
  }
  // UNIT_LIGHTING_IDENTITY_GATE（顾问要求）：每个单元必须有 unit_lighting（E4 契约），缺一个即 BLOCKER——
  // 修复轮只写命中单元时，未命中单元的光影若被机械层清掉会静默丢失（实测第二版 8/16 缺失）
  {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i] as Record<string, unknown>;
      if (!String(unit.unit_lighting ?? "").trim()) {
        issues.push(issue(
          `${String(unit.unit_id ?? "")}.lighting`,
          "UNIT_LIGHTING_MISSING",
          "BLOCKER",
          "E4",
          `单元 ${String(unit.unit_id ?? "")} 缺少 unit_lighting（E4 契约：每单元必须一条完整布光设定）`,
          `为该单元补写单元级光影（主光/辅光/色温/摄影基调），镜级只写变化量`
        ));
      }
    }
  }
  // UNIT_LIGHTING_TEMPORAL_GROUNDING（顾问要求）：unit_lighting 禁止引用本单元时间轴之外的未来内容——
  // 实测第二版 U04 写水晶熄灭（实际 U07）、U07 写系统面板（实际 U12）：未来状态泄漏进光影
  {
    const specialAssets = context.project.assets.filter((asset) =>
      /Q版/.test(asset.name) || /系统|面板/.test(asset.name) || asset.type === "BEAST"
    );
    const nodeSeq = new Map<string, number>();
    let seq = 0;
    for (const node of context.sourceNodes.values()) nodeSeq.set(node.source_node_id, ++seq);
    const firstSeqOf = new Map<string, { firstSeq: number; aliases: string[] }>();
    const mentionNamesByMain = effectiveMentionNamesByMain(specialAssets);
    for (const asset of specialAssets) {
      const mainName = asset.name.split("｜")[0].trim();
      if (mainName.length < 2) continue;
      const aliases = mentionNamesByMain.get(mainName) ?? [mainName];
      for (const node of context.sourceNodes.values()) {
        if (assetMentionedIn(node.text, { name: mainName, type: asset.type, aliases })) {
          if (!firstSeqOf.has(mainName)) firstSeqOf.set(mainName, { firstSeq: nodeSeq.get(node.source_node_id) ?? 0, aliases });
        }
      }
    }
    for (const unit of units) {
      const record = unit as Record<string, unknown>;
      const lighting = String(record.unit_lighting ?? "").trim();
      if (!lighting) continue;
      const ids = stringArray(record.shot_ids);
      const included = ids.map((id) => shots.find((shot) => shot.shot_id === id)).filter(Boolean) as WorkingShot[];
      const seqs = included.flatMap((shot) => [
        ...(shot.dialogue as Array<Record<string, unknown>>).map((e) => nodeSeq.get(String(e.source_node_id ?? "")) ?? 0),
        ...stringArray(shot.source_node_refs).map((id) => nodeSeq.get(id) ?? 0)
      ]);
      // 单元时间窗：第一镜最早节点 ~ 最后一镜最晚节点。实体首出在单元窗口内（含窗口内出现）= 合理；
      // 首出在窗口之后 = 本单元根本没出现 = 未来状态泄漏
      const minSeq = seqs.length ? Math.min(...seqs) : 0;
      const maxSeq = seqs.length ? Math.max(...seqs) : 0;
      // 禁止内部镜号泄漏：unit_lighting 不得出现 S\d+（本单元镜号也不行——光影是场级设定，不写镜号）
      const shotRefs = lighting.match(/S\d{3}/g) ?? [];
      if (shotRefs.length) {
        issues.push(issue(
          `${String(record.unit_id ?? "")}.lighting`,
          "UNIT_LIGHTING_TEMPORAL_GROUNDING",
          "BLOCKER",
          "E4",
          `unit_lighting 出现内部镜号（${shotRefs.slice(0, 4).join("/")}）：光影是单元级设定，禁止写镜号（易串台/提前状态）`,
          `删掉镜号引用，只写单元级布光描述（主光/辅光/色温/时间推进可写"手按水晶后""面板弹出后"这类剧情锚点）`
        ));
        continue;
      }
      // 未来实体泄漏：光影提到的特殊实体，其源剧本首次出场节点在本单元时间窗之后 → 未来状态
      //（U12 面板首出#47 在本单元窗口 #45-#48 内 = 单元内合理光源；U07 写 S039 面板（窗口 #25-#30 之外）= 泄漏）
      for (const [mainName, entry] of firstSeqOf) {
        if (maxSeq > 0 && entry.firstSeq > maxSeq && assetMentionedIn(lighting, { name: mainName, type: "CH", aliases: entry.aliases })) {
          issues.push(issue(
            `${String(record.unit_id ?? "")}.lighting`,
            "UNIT_LIGHTING_TEMPORAL_GROUNDING",
            "BLOCKER",
            "E4",
            `unit_lighting 出现「${mainName}」但该实体在源剧本要到节点#${entry.firstSeq} 才出场（本单元时间窗 #${minSeq}-#${maxSeq}）——未来状态泄漏进光影`,
            `删掉本单元尚未出场的实体光效，等它真正出场（对应单元）再写`
          ));
          break;
        }
      }
    }
  }
  // PROMPT_LITERAL_ARTIFACT（顾问要求）：模板/正则替换残留不得进入提示词——$1/undefined/null/待补充 等
  // 归属按字段实际岗位（实测 $1 残留在 E1 的 sound 格，卡却开给 E4 → E4 只能改 camera/lighting，
  // 永远修不掉 → 死循环）：e1.picture/e1.sound→E1，e2.picture→E2，e3.sound→E3，e4.lighting→E4。
  {
    const artifactPattern = /\$\d+|\$\{|\{\{|undefined|\bnull\b|待补充/;
    const shotFields: Array<[recordKey: "e1" | "e2" | "e3" | "e4", field: string, owner: "E1" | "E2" | "E3" | "E4"]> = [
      ["e1", "picture", "E1"],
      ["e1", "sound", "E1"],
      ["e2", "picture", "E2"],
      ["e3", "sound", "E3"],
      ["e4", "lighting", "E4"]
    ];
    for (const shot of shots) {
      for (const [recordKey, field, owner] of shotFields) {
        const text = String((shot[recordKey] as Record<string, unknown> | undefined)?.[field] ?? "");
        if (!artifactPattern.test(text)) continue;
        issues.push(issue(
          `${shot.shot_id}.${recordKey}.${field}`,
          "PROMPT_LITERAL_ARTIFACT",
          "BLOCKER",
          owner,
          `「${recordKey}.${field}」含模板/替换残留「${text.slice(0, 40)}」（$1/undefined/null/待补充 等）`,
          `清理占位符为真实内容（声音写实际音效，画面写实际动作）`
        ));
      }
    }
    // 单元字段：unit_start_premise/unit_end_state 归 E3（单元创作字段），unit_lighting 归 E4
    const unitFields: Array<[field: string, coordinateField: string, owner: "E3" | "E4"]> = [
      ["unit_start_premise", "unit_start_premise", "E3"],
      ["unit_end_state", "unit_end_state", "E3"],
      ["unit_lighting", "lighting", "E4"]
    ];
    for (const unit of units) {
      const record = unit as Record<string, unknown>;
      for (const [field, coordinateField, owner] of unitFields) {
        const text = String(record[field] ?? "");
        if (!artifactPattern.test(text)) continue;
        issues.push(issue(
          `${String(record.unit_id ?? "")}.${coordinateField}`,
          "PROMPT_LITERAL_ARTIFACT",
          "BLOCKER",
          owner,
          `「${field}」含模板/替换残留「${text.slice(0, 40)}」`,
          `清理占位符为真实内容`
        ));
      }
    }
  }
  // UNIT_PREMISE_GROUNDING（Generation Gate）：start_premise 禁止"偷看未来"——
  // premise 中出现的特殊实体（Q版/系统面板/BEAST）必须已在"上一单元 end_state"在场或本单元文本中出现，
  // 否则 E3 把未来剧情状态写进了 Seedance 的独立前提（如还在群嘲却写"系统面板已出现"）
  {
    const specialAssets = context.project.assets.filter((asset) =>
      /Q版/.test(asset.name) || /系统|面板/.test(asset.name) || asset.type === "BEAST"
    );
    if (specialAssets.length) {
      const mentionNamesByMain = effectiveMentionNamesByMain(specialAssets);
      for (let i = 0; i < units.length; i++) {
        const unit = units[i] as Record<string, unknown>;
        const premise = optionalString(unit.unit_start_premise) ?? "";
        if (!premise) continue;
        const ids = stringArray(unit.shot_ids);
        const included = ids.map((id) => shots.find((shot) => shot.shot_id === id)).filter(Boolean) as WorkingShot[];
        const unitText = [
          optionalString(unit.unit_end_state) ?? "",
          ...included.flatMap((shot) => {
            const cells = composeShotCells({
              e1: shot.e1 as Record<string, unknown>,
              e2: shot.e2 as Record<string, unknown>,
              e3: shot.e3 as Record<string, unknown>,
              e4: shot.e4 as Record<string, unknown>
            });
            return [cells.picture, cells.camera_motion, ...(shot.dialogue as Array<Record<string, unknown>>).map((entry) => String(entry.text ?? ""))];
          })
        ].join("；");
        const prev = i > 0 ? (units[i - 1] as Record<string, unknown>) : null;
        const prevScene = String(prev?.scene_id ?? "");
        const prevEnd = prev && prevScene === String(unit.scene_id ?? "") ? optionalString(prev.unit_end_state) ?? "" : "";
        // UNIT_START_T0（顾问要求）：premise 只能描述"本单元第一镜开始时"已成立的状态——
        // 实体必须出现在【第一镜的源节点/画面/台词】或【上一单元 end_state】才允许写入 premise；
        // 实体即使在本单元后面的镜出现（如 U12 面板第二镜才弹出），也不算 T0 在场（那是单元内的未来）
        const firstShot = included[0];
        const firstShotText = (() => {
          if (!firstShot) return "";
          const firstNodeIds = stringArray(firstShot.source_node_refs);
          const nodeTexts = firstNodeIds.map((id) => context.sourceNodes.get(id)?.text ?? "").join("；");
          const cells = composeShotCells({
            e1: firstShot.e1 as Record<string, unknown>,
            e2: firstShot.e2 as Record<string, unknown>,
            e3: firstShot.e3 as Record<string, unknown>,
            e4: firstShot.e4 as Record<string, unknown>
          });
          return [nodeTexts, cells.picture, ...(firstShot.dialogue as Array<Record<string, unknown>>).map((entry) => String(entry.text ?? ""))].join("；");
        })();
        for (const asset of specialAssets) {
          const mainName = asset.name.split("｜")[0].trim();
          if (mainName.length < 2) continue;
          const aliases = mentionNames(asset);
          if (!assetMentionedIn(premise, { name: mainName, type: asset.type, aliases })) continue;
          // 台词引用豁免：前提里的实体名出现在引号内（如同学甲喊'白灵神鹤！'）= 台词提及，不是在场描述
          if (new RegExp(`[‘'\"“]\\s*[^‘'\"“”]*${escapeRegExp(mainName)}[^‘'\"“”]*[’'\"”]`).test(premise)) continue;
          // T0：上一单元 end_state 可直接证明已在场；首镜的"弹出/汇聚/踏出"等是 T0 后入场动作，不能反证开场已在场。
          if (prevEnd && assetMentionedIn(prevEnd, { name: mainName, type: asset.type, aliases })) continue;
          const t0EntryAction = /弹出|出现|汇聚|踏出|走入|进入|现身|浮现|凝聚|召唤/;
          const firstShotAssetClauses = firstShotText
            .split(/[\r\n，,。！？!?；;]+/u)
            .filter((clause) => assetMentionedIn(clause, { name: mainName, type: asset.type, aliases }));
          if (firstShotAssetClauses.length && !firstShotAssetClauses.some((clause) => t0EntryAction.test(clause))) continue;
          issues.push(issue(
            `${String(unit.unit_id ?? "")}.premise`,
            "PREMISE_FUTURE_ENTITY",
            "BLOCKER",
            "E3",
            `站位前提出现「${mainName}」但该实体在本单元第一镜（T0）与上一单元结束状态均未在场（本单元后面才出现的不算开场状态）`,
            `把前提改回本单元第一镜开始时真实成立的状态（来源=上一单元末镜+本单元首镜），实体未出场前不写`
          ));
          break;
        }
      }
    }
  }
  // BINDING_EXTRANEOUS（Generation Gate）：特殊实体（系统/Q版/BEAST）提前绑定——
  // 本单元文本与上一单元 end_state 都没出现该实体，绑定里却有它（Seedance 可能凭空生成出来）
  {
    const specialAssets = context.project.assets.filter((asset) =>
      /Q版/.test(asset.name) || /系统|面板/.test(asset.name) || asset.type === "BEAST"
    );
    if (specialAssets.length) {
      const mentionNamesByMain = effectiveMentionNamesByMain(specialAssets);
      for (let i = 0; i < units.length; i++) {
        const unit = units[i] as Record<string, unknown>;
        const bindings = Array.isArray(unit.subject_bindings) ? unit.subject_bindings.map(String) : [];
        if (!bindings.length) continue;
        const ids = stringArray(unit.shot_ids);
        const included = ids.map((id) => shots.find((shot) => shot.shot_id === id)).filter(Boolean) as WorkingShot[];
        const unitText = [
          optionalString(unit.unit_start_premise) ?? "",
          optionalString(unit.unit_end_state) ?? "",
          ...included.flatMap((shot) => {
            const cells = composeShotCells({
              e1: shot.e1 as Record<string, unknown>,
              e2: shot.e2 as Record<string, unknown>,
              e3: shot.e3 as Record<string, unknown>,
              e4: shot.e4 as Record<string, unknown>
            });
            return [cells.picture, cells.camera_motion, ...(shot.dialogue as Array<Record<string, unknown>>).map((entry) => String(entry.text ?? ""))];
          })
        ].join("；");
        const prev = i > 0 ? (units[i - 1] as Record<string, unknown>) : null;
        const prevScene = String(prev?.scene_id ?? "");
        const prevEnd = prev && prevScene === String(unit.scene_id ?? "") ? optionalString(prev.unit_end_state) ?? "" : "";
        for (const binding of bindings) {
          const boundName = binding.split("@")[0].trim();
          if (boundName.length < 2) continue;
          const asset = specialAssets.find((item) => item.name.split("｜")[0].trim() === boundName);
          if (!asset) continue;
          const aliases = mentionNamesByMain.get(boundName) ?? [boundName];
          if (assetMentionedIn(unitText, { name: boundName, type: asset.type, aliases })) continue;
          if (prevEnd && assetMentionedIn(prevEnd, { name: boundName, type: asset.type, aliases })) continue;
          issues.push(issue(
            `${String(unit.unit_id ?? "")}.bindings`,
            "BINDING_EXTRANEOUS",
            "BLOCKER",
            "E3",
            `「${boundName}」在本单元与上一单元均未出现却被提前绑定（未来特殊实体泄漏）`,
            `从 subject_bindings 移除「${boundName}」，等它真正出场（或上一单元末镜在场）时再绑定`
          ));
          break;
        }
      }
    }
  }
  // SOURCE_VISUAL_COHERENCE（Narrative/Generation Gate）：特殊实体（Q版/系统/BEAST）提前出现在画面——
  // 实体首次出现的源节点序号 > 本镜最小节点序号，说明借用了未来剧情的视觉内容（如穿越 OS 镜配"同学乙羡慕"）
  {
    const specialAssets = context.project.assets.filter((asset) =>
      /Q版/.test(asset.name) || /系统|面板/.test(asset.name) || asset.type === "BEAST"
    );
    if (specialAssets.length) {
      const nodeSeq = new Map<string, number>();
      let seq = 0;
      const nodeList: Array<{ id: string; text: string; type: string }> = [];
      for (const node of context.sourceNodes.values()) {
        nodeSeq.set(node.source_node_id, ++seq);
        nodeList.push({ id: node.source_node_id, text: node.text, type: node.type });
      }
      const firstSeqOf = new Map<string, { firstSeq: number; aliases: string[] }>();
      const mentionNamesByMain = effectiveMentionNamesByMain(specialAssets);
      for (const asset of specialAssets) {
        const mainName = asset.name.split("｜")[0].trim();
        if (mainName.length < 2) continue;
        const aliases = mentionNamesByMain.get(mainName) ?? [mainName];
        const first = nodeList.find((node) => assetMentionedIn(node.text, { name: mainName, type: asset.type, aliases }))
          ?? nodeList.find((node) => node.type === "DIALOGUE" && assetMentionedIn(String(context.sourceNodes.get(node.id)?.speaker ?? ""), { name: mainName, type: asset.type, aliases }));
        if (first) firstSeqOf.set(mainName, { firstSeq: nodeSeq.get(first.id) ?? 0, aliases });
      }
      if (firstSeqOf.size) {
        for (const shot of shots) {
          if (/(闪回|梦境|想象)/.test(String(shot.time_layer ?? ""))) continue;
          const seqs = [
            ...(shot.dialogue as Array<Record<string, unknown>>).map((entry) => nodeSeq.get(String(entry.source_node_id ?? ""))),
            ...stringArray(shot.source_node_refs).map((id) => nodeSeq.get(id))
          ].filter((value): value is number => value !== undefined);
          if (!seqs.length) continue;
          const minSeq = Math.min(...seqs);
          const e1Text = String((shot.e1 as Record<string, unknown>)?.picture ?? (shot.e1 as Record<string, unknown>)?.visual_goal ?? "");
          const e2Text = String((shot.e2 as Record<string, unknown>)?.picture ?? "");
          for (const [mainName, entry] of firstSeqOf) {
            if (entry.firstSeq <= minSeq) continue; // 实体已在本镜节点或之前出场，正常
            // 按格子归属拆分开卡：e1（E1 画面目标）借未来视觉归 E1；e2（E2 表演画面）归 E2——
            // 修复轮只改命中坐标的格子，合并画面违规必须分别定位，否则修了 e2 漏 e1 永远修不净
            const e1Mentioned = assetMentionedIn(e1Text, { name: mainName, type: "CH", aliases: entry.aliases });
            const e2Mentioned = assetMentionedIn(e2Text, { name: mainName, type: "CH", aliases: entry.aliases });
            if (e1Mentioned) {
              issues.push(issue(
                `${shot.shot_id}.picture`,
                "SOURCE_VISUAL_COHERENCE",
                "BLOCKER",
                "E1",
                `【E1 画面目标格子 e1.picture】出现「${mainName}」但该实体在源剧本要到节点#${entry.firstSeq} 才出场（本镜最早节点#${minSeq}）——借用了未来视觉（e2 表演画面若同违规会另开 E2 卡，两个格子各归各的岗位修）`,
                `把本镜画面目标格子改回当前源节点允许的视觉（人物状态/环境/记忆闪回），禁止使用未来剧情画面`
              ));
            }
            // e2 违规也单独开 E2 卡：两个格子都清干净，一轮修完
            if (e2Mentioned) {
              issues.push(issue(
                `${shot.shot_id}.picture`,
                "SOURCE_VISUAL_COHERENCE",
                "BLOCKER",
                "E2",
                `【E2 表演画面格子 e2.picture】出现「${mainName}」但该实体在源剧本要到节点#${entry.firstSeq} 才出场（本镜最早节点#${minSeq}）——借用了未来视觉（e1 画面目标若同违规会另开 E1 卡，两个格子各归各的岗位修）`,
                `把本镜表演画面格子改回当前源节点允许的视觉（人物状态/环境/记忆闪回），禁止使用未来剧情画面`
              ));
            }
          }
        }
      }
    }
  }
  // SPEAKER_PERFORMANCE_ALIGNMENT（Generation Gate 扩展）：非 OS 对白镜的画面表演说话人
  //（"X说话/开口/说道/喊道/说"）必须与台词说话人一致——台词赵清雅、画面/声音却是别人 = 错位
  {
    const dialogueSpeakers = new Set<string>();
    for (const node of context.sourceNodes.values()) {
      if (node.type === "DIALOGUE") {
        const name = String(node.speaker ?? "").replace(/（.*）$/, "").replace(/内心$/, "").trim();
        if (name) dialogueSpeakers.add(name);
      }
    }
    const speakerNameList = [...dialogueSpeakers].sort((a, b) => b.length - a.length);
    for (const shot of shots) {
      const entries = shot.dialogue as Array<Record<string, unknown>>;
      const hasSpokenDialogue = entries.some((entry) => String(entry.type ?? "对白") === "对白");
      if (!hasSpokenDialogue) continue;
      const speakerSet = new Set(
        entries
          .filter((entry) => String(entry.type ?? "对白") === "对白")
          .map((entry) => String(entry.speaker ?? "").replace(/（.*）$/, "").replace(/内心$/, "").trim())
          .filter(Boolean)
      );
      const cells = composeShotCells({
        e1: shot.e1 as Record<string, unknown>,
        e2: shot.e2 as Record<string, unknown>,
        e3: shot.e3 as Record<string, unknown>,
        e4: shot.e4 as Record<string, unknown>
      });
      const pictureText = cells.picture;
      for (const name of speakerNameList) {
        if (name.length < 2 || speakerSet.has(name)) continue;
        if (hasExplicitSpeakingActor(pictureText, name)) {
          issues.push(issue(
            `${shot.shot_id}.picture`,
            "SPEAKER_PERFORMANCE_ALIGNMENT",
            "BLOCKER",
            "E2",
            `画面/声音的表演说话人是「${name}」但本镜台词说话人是 ${[...speakerSet].join("、") || "无"}（非 OS 对白）`,
            `让台词、画面主表演者、机位主体、声音四者一致：改台词归属或改画面/声音`
          ));
          break;
        }
      }
    }
  }
  // PADDING_SHOT（节奏/时长）：无台词镜紧邻下一对白镜，且两镜画面高度相似（同一表演状态反复）——
  // 是"走近3s + 说话3s"式预说话填充，SHOT_VALUE_GATE 的机械落地（MAJOR 建议，首轮就该避免）
  {
    const scenes = new Map<string, WorkingShot[]>();
    for (const shot of shots) {
      const key = String(shot.scene_id ?? "");
      if (!scenes.has(key)) scenes.set(key, []);
      scenes.get(key)!.push(shot);
    }
    for (const group of scenes.values()) {
      for (let i = 1; i < group.length; i++) {
        const prev = group[i - 1];
        const cur = group[i];
        const prevHasDialogue = (prev.dialogue as Array<Record<string, unknown>>).length > 0;
        const curHasDialogue = (cur.dialogue as Array<Record<string, unknown>>).length > 0;
        if (prevHasDialogue || !curHasDialogue) continue;
        const prevPic = composeShotCells({ e1: prev.e1 as Record<string, unknown>, e2: prev.e2 as Record<string, unknown>, e3: prev.e3 as Record<string, unknown>, e4: prev.e4 as Record<string, unknown> }).picture;
        const curPic = composeShotCells({ e1: cur.e1 as Record<string, unknown>, e2: cur.e2 as Record<string, unknown>, e3: cur.e3 as Record<string, unknown>, e4: cur.e4 as Record<string, unknown> }).picture;
        const sim = bigramSimilarity(prevPic, curPic);
        if (sim >= 0.55) {
          issues.push(issue(
            `${prev.shot_id}.padding`,
            "PADDING_SHOT",
            "MAJOR",
            "E1",
            `无台词镜与下一对白镜画面高度相似（${sim.toFixed(2)}），疑似"走近/预备"式填充镜（如 3秒走近+3秒说话）`,
            "合并进下一对白镜（边做边说），或让本镜承担新信息（空间变化/关系变化/道具交互），首轮即避免"
          ));
        }
      }
    }
  }
  // 资产绑定机械化（Generation Gate）：最终 picture/camera 中可见的 CH/BEAST/GROUP/系统面板
  // 必须出现在 subject_bindings（或作为台词说话人）；premise 另按 T0 合同开卡，end_state/sound 不参与。
  {
    const bindableAssets = context.project.assets.filter((asset) =>
      asset.type === "CH" || asset.type === "BEAST" || asset.type === "GROUP" || (asset.type === "PROP" && /系统|面板/.test(asset.name))
    );
    for (const unit of units) {
      const unitId = String(unit.unit_id ?? "unknown-unit");
      const sceneId = String(unit.scene_id ?? "");
      const ids = stringArray(unit.shot_ids);
      const included = ids.map((id) => shots.find((shot) => shot.shot_id === id)).filter(Boolean) as WorkingShot[];
      const bindings = Array.isArray(unit.subject_bindings) ? unit.subject_bindings.map(String) : [];
      const boundCodes = new Set<string>();
      const boundFamilies = new Set<string>();
      const boundNames = new Set<string>();
      const rememberBinding = (raw: string) => {
        const resolved = resolveAssetReference(context.project.assets, raw, sceneId);
        if (resolved) {
          boundCodes.add(resolved.code);
          boundFamilies.add(assetFamilyCode(resolved.code));
          boundNames.add(resolved.name.split("｜")[0].trim());
          return;
        }
        const fallback = raw.split("@")[0].trim().replace(/（.*）$/, "").trim();
        if (fallback) boundNames.add(fallback);
      };
      bindings.forEach(rememberBinding);
      for (const shot of included) {
        for (const entry of shot.dialogue as Array<Record<string, unknown>>) {
          const speaker = String(entry.speaker ?? "").replace(/（.*）$/, "").replace(/内心$/, "").trim();
          if (speaker) rememberBinding(speaker);
        }
      }
      const visualClauses = included.flatMap((shot) => {
        const cells = composeShotCells({
          e1: shot.e1 as Record<string, unknown>,
          e2: shot.e2 as Record<string, unknown>,
          e3: shot.e3 as Record<string, unknown>,
          e4: shot.e4 as Record<string, unknown>
        });
        return [cells.picture, cells.camera_motion];
      }).join("；").split(/[\r\n，,。！？!?；;]+/u).map((clause) => clause.trim()).filter(Boolean);
      const premise = optionalString(unit.unit_start_premise) ?? "";
      const premiseClauses = premise.split(/[\r\n，,。！？!?；;]+/u).map((clause) => clause.trim()).filter(Boolean);
      const preactionReason = unitStartPreactionReason(premise);
      if (preactionReason) {
        issues.push(issue(
          `${unitId}.premise`,
          "UNIT_START_PREACTION",
          "BLOCKER",
          "E3",
          `unit_start_premise 应是 T0 静态快照，但${preactionReason}`,
          "删除前置时序与动作链，只写首镜开始瞬间已经成立的人物站位、姿态、持物与视线，禁止提前完成首镜动作"
        ));
      }
      const seenFamilies = new Set<string>();
      for (const asset of bindableAssets) {
        const mainName = asset.name.split("｜")[0].trim();
        if (mainName.length < 2) continue;
        const assetFamily = assetFamilyCode(asset.code);
        if (seenFamilies.has(assetFamily)) continue;
        seenFamilies.add(assetFamily);
        const isBound = (reference: VisibleAssetReference) => reference.exact
          ? boundCodes.has(reference.code)
          : boundFamilies.has(assetFamilyCode(reference.code)) || boundNames.has(reference.name.split("｜")[0].trim());
        const missingVisualReferences = collectVisibleAssetReferences(context.project.assets, visualClauses, asset, sceneId).filter((reference) => !isBound(reference));
        if (missingVisualReferences.length) {
          issues.push(issue(
            `${unitId}.bindings`,
            "BINDING_MISSING",
            "BLOCKER",
            "E3",
            `最终画面/机位出现可见资产「${missingVisualReferences.map((reference) => `${reference.name}@${reference.code}`).join("、")}」但 subject_bindings 未绑定对应身份（Seedance 会乱出形象穿帮）`,
            `在 subject_bindings 补上 ${missingVisualReferences.map((reference) => `「${mainName}@${reference.code}」`).join("、")}`
          ));
        }
        const missingPremiseReferences = collectVisibleAssetReferences(context.project.assets, premiseClauses, asset, sceneId).filter((reference) => !isBound(reference));
        if (missingPremiseReferences.length) {
          issues.push(issue(
            `${unitId}.premise`,
            "PREMISE_BINDING_CONFLICT",
            "BLOCKER",
            "E3",
            `unit_start_premise 出现可见资产「${missingPremiseReferences.map((reference) => `${reference.name}@${reference.code}`).join("、")}」但 subject_bindings 未绑定，且同分句未明确画外/未入镜`,
            `若资产在 T0 入画，在 subject_bindings 补上 ${missingPremiseReferences.map((reference) => `「${mainName}@${reference.code}」`).join("、")}；若仅声音或历史信息，写明画外/未入镜或从 premise 删除`
          ));
        }
      }
    }
  }
  // 光影状态机（Generation Gate）：同场景内光源被写"熄灭/暗淡"后，后续镜又把它当主光（且无重新亮起）
  // ——E4 光型变化必须成为新状态被后续继承，否则成片光线跳变
  {
    // 光源名白名单（避免把"数字暗淡/光线变暗"等非光源误判）
    const lightSourcePattern = /(水晶石|法阵|传送阵|阵法|烛火|蜡烛|火焰|篝火|炉火|火把|吊灯|顶灯|壁灯|台灯|路灯|霓虹|屏幕|窗外|月光|日光|阳光|天光|晨光|夕阳|主光|灯光)[^，。；]{0,6}?(?:熄灭|暗淡|暗下|关闭|变暗|转暗|收敛|失去光芒|暗去|黯淡|灭掉)/;
    const relightWords = /重新|恢复|再亮|亮起|点燃|光芒大作|骤亮|重新点亮|重新燃起|骤然大亮/;
    const offLights = new Map<string, Set<string>>(); // sceneId -> 已熄灭光源集
    let currentScene = "";
    for (const shot of shots) {
      const scene = String(shot.scene_id ?? "");
      if (scene !== currentScene) {
        currentScene = scene;
        offLights.clear();
        offLights.set(scene, new Set());
      }
      const e4 = shot.e4 as Record<string, unknown>;
      const lighting = typeof e4?.lighting === "string" ? e4.lighting : null;
      const offSet = offLights.get(scene) ?? new Set<string>();
      if (lighting) {
        // 先用上一镜积累的熄灭状态检测冲突，再登记本镜新熄灭（描述镜自身不算冲突）
        if (offSet.size && !relightWords.test(lighting)) {
          const asMain = /主光[为是：:]*([\u4e00-\u9fa5A-Za-z0-9]{2,8})/.exec(lighting);
          const mainName = asMain ? asMain[1] : "";
          for (const name of offSet) {
            if (mainName && mainName.includes(name)) {
              issues.push(issue(
                `${shot.shot_id}.lighting`,
                "LIGHT_STATE_CONFLICT",
                "BLOCKER",
                "E4",
                `「${name}」已在前镜被写为熄灭/暗淡，本镜又把它当主光（未写重新亮起）`,
                "要么保持熄灭状态（后续镜不引用该光源），要么先写重新亮起（如'水晶石重新亮起'）再作主光"
              ));
              // 不 delete：同一光源的所有冲突镜一次全部开卡，E4 一轮全修，避免逐镜收敛
            }
          }
        }
        const match = lightSourcePattern.exec(lighting);
        if (match) offSet.add(match[1]);
      }
    }
  }
  // 单元衔接一致性：同场次相邻单元的"移动形象"（Q版 / 系统面板 / BEAST 凶兽虚影）出现与消失必须交代
  // ——Q版 凭空出现没有粒子汇聚特效、凶兽消失没写消散，Seedance 出片即穿帮
  {
    const continuityAssets = context.project.assets
      .filter((asset) => {
        if (/Q版/.test(asset.name)) return true;
        if (/系统|面板/.test(asset.name)) return true;
        return asset.type === "BEAST";
      })
      .map((asset) => ({ type: asset.type, name: asset.name, core: asset.name.length > 3 ? asset.name.slice(-2) : asset.name, tail: asset.name.slice(-1) }))
      .filter((item) => item.name.length >= 2);
    if (continuityAssets.length) {
      const hasMention = (text: string, asset: { type: string; name: string; core: string; tail: string }, loose: boolean) => {
        if (text.includes(asset.name) || text.includes(asset.core)) return true;
        if (asset.type === "BEAST") {
          // 龙类：龙炎/龙吟/龙影 等是龙在场的画面证据
          if (asset.tail === "龙" && /龙炎|龙吟|龙影|龙爪|龙鳞|龙吼/.test(text)) return true;
          // 尾字+身体/动作后缀：熊爪/狼嚎/鹤影 等变体提及
          if (loose && new RegExp(`${asset.tail}(?:爪|身|掌|影|吼|啸|尾|蹄|角|翅|炎|吟|鳞|嚎)`).test(text)) return true;
        }
        return false;
      };
      const disappearWords = /消散|消失|收回|离开|退去|散去|熄灭|关闭|收走|隐去|淡出|化为|飞灰|化作光点|崩解|瓦解|倒地/;
      const appearWords = /浮现|汇聚|出现|召唤|闪出|落下|亮起|弹出|显现|飘出|形成|涌出|钻出|飞出|凝聚|浮现|冒出|踏出|冲出|走来|现身|亮起|升起/;
      for (let i = 1; i < units.length; i++) {
        const prev = units[i - 1] as Record<string, unknown>;
        const cur = units[i] as Record<string, unknown>;
        const prevScene = String(prev.scene_id ?? "");
        const curScene = String(cur.scene_id ?? "");
        if (!prevScene || prevScene !== curScene) continue; // 只查同场次相邻
        const end = optionalString(prev.unit_end_state) ?? "";
        const start = optionalString(cur.unit_start_premise) ?? "";
        if (!end || !start) continue;
        for (const asset of continuityAssets) {
          const inEnd = hasMention(end, asset, false);
          const inStart = hasMention(start, asset, true);
          if (inEnd && !inStart && !disappearWords.test(end)) {
            issues.push(issue(
              `${String(prev.unit_id ?? "")}→${String(cur.unit_id ?? "")}`,
              "CONTINUITY_GAP",
              "BLOCKER",
              "E3",
              `上一单元结束时「${asset.name}」在场，本单元开场未提及且未交代消失`,
              `在 ${String(cur.unit_id ?? "")} 的 unit_start_premise 补写「${asset.name}」的在场状态，或在上一单元 unit_end_state 补写其消散/收回/离开`
            ));
          } else if (!inEnd && inStart && !appearWords.test(start)) {
            issues.push(issue(
              `${String(prev.unit_id ?? "")}→${String(cur.unit_id ?? "")}`,
              "CONTINUITY_GAP",
              "BLOCKER",
              "E3",
              `本单元开场出现「${asset.name}」但上一单元结束时不在场，且无出现方式`,
              `在 ${String(cur.unit_id ?? "")} 的 unit_start_premise 补写「${asset.name}」的出现方式（如 Q版 光点粒子汇聚、凶兽踏出/召唤现身、系统面板弹出）`
            ));
          }
        }
      }
    }
  }
  // 转场节拍单调性：整集几乎全部"硬切"说明 E3 未做转场设计（动作切/道具停半拍/甩切等）
  {
    const transitions = shots
      .map((shot) => composeTransition(shot.e1 as Record<string, unknown>, shot.e3 as Record<string, unknown>))
      .map((text) => text.replace(/[；;。\s]/g, ""))
      .filter(Boolean);
    const plainCuts = transitions.filter((text) => text === "硬切").length;
    if (transitions.length >= 4 && plainCuts / transitions.length >= 0.9) {
      issues.push(issue("E3.transitions", "TRANSITION_MONOTONE", "MAJOR", "E3",
        `${plainCuts}/${transitions.length} 镜转场均为"硬切"，缺少动作承载/道具停顿/甩切设计`,
        "重点镜写画面内动作承载的转场（如'手落水晶石瞬间切'），道具/打脸可停半拍，普通镜才硬切"));
    }
  }
  // 光影模板化：半数以上镜头共用同一整句光影（无场景光型共享+变化量设计）
  {
    const lightingByText = new Map<string, number>();
    for (const shot of shots) {
      const e4 = shot.e4 as Record<string, unknown>;
      const lighting = typeof e4?.lighting === "string" && e4.lighting.trim().length >= 12 ? e4.lighting.trim() : null;
      if (lighting) lightingByText.set(lighting, (lightingByText.get(lighting) ?? 0) + 1);
    }
    const max = Math.max(0, ...[...lightingByText.values()]);
    const withLighting = [...lightingByText.values()].reduce((sum, count) => sum + count, 0);
    if (withLighting >= 4 && max / withLighting >= 0.3) {
      issues.push(issue("E4.lighting", "LIGHTING_TEMPLATE", "MAJOR", "E4",
        `${max}/${withLighting} 镜共用同一句光影（模板化），无场景光型共享与变化量`,
        "同场景首镜建立光型（主/辅/轮廓/色温），后续无变化镜不重复写光影；光源进出/时间推进才写变化量"));
    }
  }
  // 台词逐字完整性：每个对话类节点的各镜切片按顺序拼接必须等于原文（漏字/重复/空片即 BLOCKER）
  const nodePieces = new Map<string, string[]>();
  for (const shot of shots) {
    for (const entry of shot.dialogue as Array<Record<string, unknown>>) {
      const nodeId = String(entry.source_node_id ?? "");
      const node = context.sourceNodes.get(nodeId);
      if (!node || !["DIALOGUE", "OS", "VO", "NARRATION", "SYSTEM"].includes(node.type)) continue;
      if (!nodePieces.has(nodeId)) nodePieces.set(nodeId, []);
      nodePieces.get(nodeId)!.push(String(entry.text ?? ""));
    }
  }
  for (const [nodeId, pieces] of nodePieces) {
    const node = context.sourceNodes.get(nodeId);
    if (!node) continue;
    const joined = pieces.join("");
    if (stripPunctuation(joined) !== stripPunctuation(node.text)) {
      issues.push(issue(
        `source_node.${nodeId}`,
        "DIALOGUE_SLICE_INCOMPLETE",
        "BLOCKER",
        "E1",
        `台词切片拼接${joined.length}字≠原文${node.text.length}字（漏字/重复/空片）`,
        "按语义重新写各承载镜的 dialogue_spans（跨镜用 text_override 或精确锚点），拼接必须逐字等于原文"
      ));
    }
  }
  return issues;
}

/** 机械修复记录只落一次（同坐标+同修订），避免每轮重复刷 RESOLVED 历史。 */
async function createMechanicalIssueOnce(
  context: PipelineContext,
  coordinate: string,
  code: string,
  expected: string,
  evidence: string,
  requestedEffect: string
) {
  const existing = await prisma.workflowIssue.findFirst({
    where: { episodeId: context.episodeId, coordinate, code, revision: context.revision }
  });
  if (existing) return;
  await prisma.workflowIssue.create({
    data: {
      projectId: context.projectId,
      episodeId: context.episodeId,
      coordinate,
      code,
      severity: "MINOR",
      status: "RESOLVED",
      ownerRole: "SYSTEM",
      expected,
      evidence,
      requestedEffect,
      revision: context.revision
    }
  });
}

const E5_HARD_REVISION_SUFFIX = "::E5_HARD";
const E5_REVIEW_REVISION_SUFFIX = "::E5_REVIEW";

export function workflowIssueKey(item: { coordinate: string; code: string }) {
  return `${item.coordinate}\u001f${item.code}`;
}

function isE5OwnedIssueRevision(revision: string) {
  return revision.endsWith(E5_HARD_REVISION_SUFFIX) || revision.endsWith(E5_REVIEW_REVISION_SUFFIX);
}

async function persistReviewIssues(
  context: PipelineContext,
  issues: PipelineIssue[],
  options: {
    hardIssueKeys?: ReadonlySet<string>;
    reviewedIssueKeys?: ReadonlySet<string>;
    resolveReviewedIssues?: boolean;
  } = {}
) {
  const currentIssues = dedupeIssues(issues);
  const currentKeys = new Set(currentIssues.map(workflowIssueKey));
  const existingOpen = await prisma.workflowIssue.findMany({
    where: { episodeId: context.episodeId, status: "OPEN" },
    orderBy: { createdAt: "asc" }
  });

  // 无 issuer 字段的最小兼容策略：
  // 1) 新卡在 revision 后写 E5_HARD / E5_REVIEW marker；
  // 2) marker 只用于挑选下轮输入，不直接授予销卡权；只有本轮实际放进 open_issues 的 key 才能销卡；
  // 3) 模型输出打满时，不以“未再输出”销 E5_REVIEW；E5_HARD 由 Python 全量重算，消失即可安全销卡；
  // 4) E1-E4 自己产生、且本轮未交给 E5 的卡保持原状态。
  const reviewedKeys = new Set(options.reviewedIssueKeys ?? []);
  const resolvedIds = existingOpen
    .filter((item) => {
      const key = workflowIssueKey(item);
      if (currentKeys.has(key)) return false;
      if (item.revision.endsWith(E5_HARD_REVISION_SUFFIX)) return true;
      return options.resolveReviewedIssues !== false && reviewedKeys.has(key);
    })
    .map((item) => item.id);
  if (resolvedIds.length) {
    await prisma.workflowIssue.updateMany({
      where: { id: { in: resolvedIds } },
      data: { status: "RESOLVED" }
    });
  }

  const openByKey = new Map(
    existingOpen
      .filter((item) => !resolvedIds.includes(item.id))
      .map((item) => [workflowIssueKey(item), item])
  );
  for (const item of currentIssues) {
    const key = workflowIssueKey(item);
    const shotKey = item.coordinate.split(".")[0];
    const shot = await prisma.storyboardShot.findUnique({
      where: { episodeId_shotKey: { episodeId: context.episodeId, shotKey } },
      select: { id: true }
    });
    const unit = await prisma.seedanceUnit.findUnique({
      where: { episodeId_unitKey: { episodeId: context.episodeId, unitKey: shotKey } },
      select: { id: true }
    });
    const revision = `${context.revision}${options.hardIssueKeys?.has(key) ? E5_HARD_REVISION_SUFFIX : E5_REVIEW_REVISION_SUFFIX}`;
    const data = {
      projectId: context.projectId,
      episodeId: context.episodeId,
      shotId: shot?.id,
      unitId: unit?.id,
      coordinate: item.coordinate,
      code: item.code,
      severity: item.severity,
      ownerRole: item.ownerRole,
      expected: item.expected,
      evidence: item.evidence,
      requestedEffect: item.requestedEffect,
      revision
    };
    const existing = openByKey.get(key);
    if (existing) {
      await prisma.workflowIssue.update({
        where: { id: existing.id },
        data: {
          shotId: data.shotId,
          unitId: data.unitId,
          severity: data.severity,
          ownerRole: data.ownerRole,
          expected: data.expected,
          evidence: data.evidence,
          requestedEffect: data.requestedEffect,
          revision: data.revision,
          status: "OPEN"
        }
      });
    } else {
      await prisma.workflowIssue.create({ data });
    }
  }
}

async function persistGenericIssues(context: PipelineContext, rawIssues: Record<string, unknown>[], owner: string) {
  const normalized = rawIssues.map((raw, index): PipelineIssue => ({
    coordinate: String(raw.coordinate ?? raw.scope ?? `${owner}.issue.${index + 1}`),
    code: String(raw.issue_code ?? raw.issue_type ?? `${owner}_ISSUE`),
    severity: normalizeSeverity(raw.severity, owner === "E1" ? "BLOCKER" : "MAJOR"),
    ownerRole: String(raw.owner_role ?? raw.requested_owner ?? owner),
    expected: String(raw.expected ?? "遵守当前岗位契约与锁定事实"),
    evidence: String(raw.actual_evidence ?? raw.evidence ?? raw.reason ?? "岗位返回未决问题"),
    requestedEffect: String(raw.requested_effect ?? "按最小坐标处理后重新校验")
  }));
  if (!normalized.length) return;
  for (const item of normalized) {
    await prisma.workflowIssue.create({
      data: {
        projectId: context.projectId,
        episodeId: context.episodeId,
        coordinate: item.coordinate,
        code: item.code,
        severity: item.severity,
        ownerRole: item.ownerRole,
        expected: item.expected,
        evidence: item.evidence,
        requestedEffect: item.requestedEffect,
        revision: context.revision
      }
    });
  }
}

/**
 * 编译并落库 Seedance 单元提示词（9 分样稿格式）：纯 TS 确定性编译，不消耗模型 Token。
 * 每轮岗位跑完都刷新一份最新稿：E5 全绿 → RELEASE_COMPILED（正式放行），否则 → DRAFT（草稿可看）。
 * 草稿覆盖上一份草稿（不刷版本号），只有正式放行才留版本历史。
 */
async function compileAndPersistPrompts(
  context: PipelineContext,
  shots: WorkingShot[],
  units: Record<string, unknown>[],
  options: { release?: boolean } = {}
) {
  if (!units.length || !shots.length) return;
  const prompts = compileSeedancePrompts(context, shots, units);
  const syncStatus: PromptSyncStatus = options.release ? "RELEASE_COMPILED" : "DRAFT_COMPILED";
  for (const [unitKey, content] of Object.entries(prompts)) {
    const unit = await prisma.seedanceUnit.findUnique({
      where: { episodeId_unitKey: { episodeId: context.episodeId, unitKey } },
      include: { promptVersions: { orderBy: { version: "desc" }, take: 1 } }
    });
    if (!unit) continue;
    const latest = unit.promptVersions[0] ?? null;
    if (latest && latest.content === content) {
      // 内容没变：只在放行时升级状态，其余情况不动（避免无意义的草稿版本）
      if (syncStatus === "RELEASE_COMPILED" && latest.syncStatus !== "RELEASE_COMPILED") {
        await prisma.compiledPromptVersion.update({ where: { id: latest.id }, data: { syncStatus, selectedAt: new Date() } });
      }
      continue;
    }
    if (latest && latest.syncStatus === "DRAFT_COMPILED") {
      // 草稿直接覆盖（不刷版本号）；草稿转正式也原地升级，保留版本线
      await prisma.compiledPromptVersion.update({
        where: { id: latest.id },
        data: { content, syncStatus, selectedAt: new Date() }
      });
      continue;
    }
    await prisma.compiledPromptVersion.create({
      data: {
        unitId: unit.id,
        version: (latest?.version ?? 0) + 1,
        content,
        syncStatus,
        selectedAt: new Date()
      }
    });
  }
}

type AssetReferenceRow = { code: string; name: string; metadata?: string | null; type?: string };

function assetFamilyCode(code: string): string {
  return /^([A-Z]+-\d{3})(?:-\d+)?$/.exec(code)?.[1] ?? code;
}

type VisibleAssetReference = { code: string; name: string; exact: boolean; mention: string };

/** 文本明确写完整变体名/code 时精确解析；只有裸主名/别名才退回资产家族。 */
function resolveVisibleAssetReferences(
  assets: readonly AssetReferenceRow[],
  text: string,
  asset: AssetReferenceRow,
  sceneId?: string
): VisibleAssetReference[] {
  const mainName = asset.name.split("｜")[0].trim();
  const family = assetFamilyCode(asset.code);
  const familyAssets = assets.filter((candidate) =>
    assetFamilyCode(candidate.code) === family || candidate.name.split("｜")[0].trim() === mainName
  );
  const explicitMentions = [...new Set(familyAssets
    .flatMap((candidate) => [candidate.code, candidate.name.includes("｜") ? candidate.name : ""])
    .filter(Boolean))]
    .sort((a, b) => b.length - a.length);
  const occupied: Array<{ start: number; end: number }> = [];
  const exactByCode = new Map<string, VisibleAssetReference>();
  for (const mention of explicitMentions) {
    let cursor = 0;
    while (cursor < text.length) {
      const start = text.indexOf(mention, cursor);
      if (start < 0) break;
      const end = start + mention.length;
      cursor = end;
      if (occupied.some((range) => start < range.end && range.start < end)) continue;
      occupied.push({ start, end });
      const resolved = resolveAssetReference(assets, mention, sceneId);
      if (resolved) exactByCode.set(resolved.code, { ...resolved, exact: true, mention });
    }
  }
  if (exactByCode.size) return [...exactByCode.values()];

  const otherMains = assets
    .map((candidate) => candidate.name.split("｜")[0].trim())
    .filter((candidate) => candidate && candidate !== mainName);
  const aliases = [...new Set(familyAssets.flatMap(mentionNames))]
    .filter((name) => !otherMains.some((other) => other.includes(name) && other !== name));
  if (!assetMentionedIn(text, { name: mainName, type: asset.type ?? "", aliases })) return [];
  const mention = [...aliases].sort((a, b) => b.length - a.length).find((name) => text.includes(name)) ?? mainName;
  const resolved = resolveAssetReference(assets, mainName, sceneId) ?? { code: asset.code, name: asset.name };
  return [{ ...resolved, exact: false, mention }];
}

function collectVisibleAssetReferences(
  assets: readonly AssetReferenceRow[],
  clauses: readonly string[],
  asset: AssetReferenceRow,
  sceneId?: string
): VisibleAssetReference[] {
  const exactByCode = new Map<string, VisibleAssetReference>();
  let familyReference: VisibleAssetReference | null = null;
  for (const clause of clauses) {
    for (const reference of resolveVisibleAssetReferences(assets, clause, asset, sceneId)) {
      if (mentionIsExplicitlyOffscreen(clause, reference.mention)) continue;
      if (reference.exact) exactByCode.set(reference.code, reference);
      else familyReference ??= reference;
    }
  }
  return exactByCode.size ? [...exactByCode.values()] : familyReference ? [familyReference] : [];
}

/** 把模型的“人物@资产名 / 人物@资产码 / 裸别名”统一解析为最终资产身份。 */
function resolveAssetReference(
  assets: readonly AssetReferenceRow[],
  rawName: string,
  sceneId?: string
): { code: string; name: string } | null {
  const trimmed = rawName.trim();
  if (!trimmed) return null;
  const candidates = trimmed.includes("@")
    ? [trimmed.split("@")[1].trim(), trimmed.split("@")[0].trim()]
    : [trimmed];
  for (const candidate of candidates) {
    const exactCode = assets.find((asset) => asset.code === candidate);
    if (exactCode) return { code: exactCode.code, name: exactCode.name };
    const exactName = assets.find((asset) => asset.name === candidate);
    if (exactName) return { code: exactName.code, name: exactName.name };
  }
  for (const asset of assets) {
    const aliases = assetAliasesOf(asset.metadata);
    if (aliases.some((alias) => candidates.includes(alias))) {
      return { code: asset.code, name: asset.name };
    }
  }
  const fallbackName = candidates[candidates.length - 1] ?? "";
  if (!fallbackName) return null;
  const prefixed = assets.filter((asset) => asset.name.startsWith(fallbackName));
  if (!prefixed.length) return null;
  const isMain = (code: string) => /^[A-Z]+-\d{3}$/.test(code);
  const withRefs = sceneId
    ? prefixed.find((asset) => assetSceneRefsOf(asset.metadata).includes(sceneId))
    : undefined;
  const defaultVariant = prefixed.find((asset) => /-1$/.test(asset.code) && !isMain(asset.code));
  const anyVariant = prefixed.find((asset) => !isMain(asset.code));
  const picked = withRefs ?? defaultVariant ?? anyVariant ?? prefixed[0];
  return { code: picked.code, name: picked.name };
}

/** 把一张填好的分镜表编译成 9 分样稿格式的单元提示词。 */
export function compileSeedancePrompts(context: PipelineContext, shots: WorkingShot[], units: Record<string, unknown>[]): Record<string, string> {
  const sceneByKey = new Map(context.scenes.map((scene) => [scene.sceneKey, scene]));
  const stylePrompt = resolveStylePrompt(context.project.style, context.project.aspectRatio);
  const negativePrompt = DEFAULT_NEGATIVE_PROMPT;
  const prompts: Record<string, string> = {};

  let cursorTick = 0; // 本集累计时间轴：全程只累加 0.1 秒整数 tick，杜绝浮点漂移
  let unitIndex = 0;
  for (const unit of units) {
    const unitKey = String(unit.unit_id);
    const shotIds = stringArray(unit.shot_ids);
    const included = shotIds.map((id) => shots.find((shot) => shot.shot_id === id)).filter(Boolean) as WorkingShot[];
    if (!included.length) continue;
    const shotRanges = buildTickRanges(included.map((shot) => Number(shot.duration)));
    const totalTicks = shotRanges.at(-1)?.endTick ?? 0;
    const totalDuration = totalTicks / 10;
    const startTick = cursorTick;
    const endTick = startTick + totalTicks;
    cursorTick = endTick;
    unitIndex += 1;
    const sceneId = String(included[0].scene_id);
    const scene = sceneByKey.get(sceneId);

    // 本集命中资产：按各资产 scene_refs 与本场次求交集（与页面同一口径），杜绝跨集资产串场
    const hitAssets = context.project.assets.filter((asset) => {
      const refs = assetSceneRefsOf(asset.metadata);
      if (refs.length) return refs.includes(sceneId);
      return !asset.episodeId || asset.episodeId === context.episodeId;
    });
    const resolveAsset = (rawName: string) => resolveAssetReference(hitAssets, rawName, sceneId);
    // 出场人物：优先单元绑定；缺失时只从画内对白说话人兜底。OS/VO 留给下方 voiceOnly，不能误列为可见人物。
    const configuredBindings = bindingStrings(unit.subject_bindings);
    const rawBindings = configuredBindings.length
      ? configuredBindings
      : [...new Set(included.flatMap((shot) => (shot.dialogue as Array<Record<string, unknown>>)
        .filter((entry) => ["对白", "DIALOGUE"].includes(String(entry.type ?? "对白")))
        .map((entry) => String(entry.speaker ?? ""))
        .filter(Boolean)))];
    const people: Array<{ person: string; code: string }> = [];
    const peopleAssetCodes = new Set<string>();
    const peopleAssetFamilies = new Set<string>();
    const peopleFallbackNames = new Set<string>();
    const peopleNames = new Set<string>();
    for (const binding of rawBindings) {
      const person = binding.split("@")[0].trim().replace(/（.*）$/, "").trim();
      if (!person) continue;
      peopleNames.add(person);
      // 说话人兜底时 binding 可能带（情绪）后缀，已剥掉再解析；带 @ 的绑定保留变体名精确定位
      const resolved = resolveAsset(binding.includes("@") ? binding : person);
      if (resolved && !peopleAssetCodes.has(resolved.code)) {
        people.push({ person, code: resolved.code });
        peopleAssetCodes.add(resolved.code);
        peopleAssetFamilies.add(assetFamilyCode(resolved.code));
        peopleNames.add(person);
      } else if (!resolved && !peopleFallbackNames.has(person)) {
        people.push({ person, code: "" });
        peopleFallbackNames.add(person);
        peopleNames.add(person);
      }
    }
    // 最终画面/机位文本（不含台词/premise——声音与历史状态都不能证明资产当前入画）：用于可见资产自动补全
    const unitVisualText = included.flatMap((shot) => {
      const cells = composeShotCells({
        e1: shot.e1 as Record<string, unknown>,
        e2: shot.e2 as Record<string, unknown>,
        e3: shot.e3 as Record<string, unknown>,
        e4: shot.e4 as Record<string, unknown>
      });
      return [cells.picture, cells.camera_motion];
    }).join("；");
    const unitVisualClauses = unitVisualText.split(/[\r\n，,。！？!?；;]+/u).map((clause) => clause.trim()).filter(Boolean);
    // 可见资产自动补全：画面文本命中但未绑定的 BEAST/CH/GROUP（如"万古应龙虚影浮现"却没绑定），
    // 机械补进出场人物行，杜绝 Seedance 乱出一个形象穿帮
    const visibleFamilies = new Set<string>();
    for (const asset of hitAssets) {
      if (!["BEAST", "CH", "GROUP"].includes(asset.type)) continue;
      const mainName = asset.name.split("｜")[0].trim();
      const family = assetFamilyCode(asset.code);
      if (mainName.length < 2 || visibleFamilies.has(family)) continue;
      visibleFamilies.add(family);
      const visibleReferences = collectVisibleAssetReferences(hitAssets, unitVisualClauses, asset, sceneId);
      for (const visible of visibleReferences) {
        if (visible.exact ? peopleAssetCodes.has(visible.code) : peopleAssetFamilies.has(assetFamilyCode(visible.code))) continue;
        people.push({ person: mainName, code: visible.code });
        peopleAssetCodes.add(visible.code);
        peopleAssetFamilies.add(assetFamilyCode(visible.code));
        peopleNames.add(mainName);
      }
    }
    const peopleLine = people.map((item) => (item.code ? `${item.person}@${item.code}` : item.person)).join("、") || "无";
    // 道具：只列本单元画面/台词实际用到的（按名称命中）
    const unitText = included.flatMap((shot) => [
      composeShotCells({
        e1: shot.e1 as Record<string, unknown>,
        e2: shot.e2 as Record<string, unknown>,
        e3: shot.e3 as Record<string, unknown>,
        e4: shot.e4 as Record<string, unknown>
      }).picture,
      ...(shot.dialogue as Array<Record<string, unknown>>).map((entry) => String(entry.text ?? ""))
    ]).join("；");
    const propsInUnit = hitAssets
      .filter((asset) => asset.type === "PROP" && asset.name && assetMentionedIn(unitText, { name: asset.name, type: asset.type, aliases: mentionNames(asset) }))
      .map((asset) => `${asset.name}@${asset.code}`);
    const sceneAsset = resolveAsset(scene?.location ?? scene?.heading ?? sceneId);

    const lines: string[] = [];
    lines.push(`### 生成分镜单元${unitIndex}（${startTick / 10}-${endTick / 10}s｜总时长${totalDuration}s）`);
    lines.push("");
    lines.push("[通用提示词]");
    lines.push(stylePrompt);
    // 可见文字合同：新 E1 visible_text 是唯一真源；仅旧数据缺该字段时，从 picture 的载体+引号文本高置信兼容提取。
    const visibleTextDeclarations: VisibleTextDeclaration[] = included.flatMap((shot) => {
      const e1 = shot.e1 as Record<string, unknown>;
      return resolveE1VisibleTextDeclarations(e1);
    });
    lines.push(renderVisibleTextNegative(negativePrompt, visibleTextDeclarations));
    lines.push("");
    // 场次表缺内/外、日/夜时，从场次标题、源文本、本集信息包里场景名附近文本兜底解析
    const headingText = scene?.heading ?? "";
    const sourceFirstLine = (scene?.sourceText ?? "").split("\n").map((line) => line.trim()).find(Boolean) ?? "";
    const location = scene?.location ?? scene?.heading ?? sceneId;
    const episodeText = context.episode.content ?? "";
    const locationHit = location && episodeText.includes(location) ? episodeText.indexOf(location) : -1;
    // 整段场次源文参与日/夜/内外推断（P1 未回写时的兜底，比只看首行与场景名附近 40 字可靠）
    const hintText = `${headingText} ${sourceFirstLine} ${scene?.sourceText ?? ""} ${locationHit >= 0 ? episodeText.slice(locationHit, locationHit + 60) : ""}`;
    // 时间/内外推断（确定性，不再输出"待定"）：优先场次表值（P1 回写），
    // 缺失时从标题/源文关键词推断；无夜戏标记默认白天（短剧惯例）
    const timeOfDay = scene?.timeOfDay
      || (/晨|清晨|早晨/.test(hintText) ? "晨"
        : /黄昏|傍晚/.test(hintText) ? "黄昏"
          : /夜|晚|月光|月色|灯火/.test(hintText) ? "夜"
            : /日|白天|午/.test(hintText) ? "日"
              : "日");
    const interiorExterior = scene?.interiorExterior
      || (/内/.test(hintText) ? "内"
        : /外/.test(hintText) ? "外"
          : /办公室|大厅|房间|教室|室内|密室|病房|卧室|客厅|餐厅|厨房|包厢|走廊|医院|食堂|监控中心|堂/.test(hintText) ? "内"
            : /广场|街道|操场|院子|天台|门口|森林|草原|秘境|室外|空地|桥|山|路|街|园|场$/.test(location ?? "") ? "外"
              : "内");
    lines.push(`[场景:${location}${sceneAsset ? `@${sceneAsset.code}` : ""}｜${interiorExterior}｜${timeOfDay}]`);
    if (propsInUnit.length) lines.push(`[本单元道具：${propsInUnit.join("、")}]`);
    lines.push("");
    const visibleCharacterFamilies = new Set(people
      .map((item) => hitAssets.find((asset) => asset.code === item.code)?.name.split("｜")[0].trim() ?? "")
      .filter(Boolean));
    const speakerNames = [...new Set(included.flatMap((shot) => (shot.dialogue as Array<Record<string, unknown>>).map((entry) => String(entry.speaker ?? ""))).filter(Boolean))];
    const voiceOnlyEntries: string[] = [];
    const voiceOnlyKeys = new Set<string>();
    for (const rawSpeaker of speakerNames) {
      const speaker = rawSpeaker.replace(/（.*）$/, "").trim();
      if (!speaker) continue;
      const boundPerson = people.find((item) => item.person === speaker && item.code);
      const resolved = resolveAsset(speaker) ?? (boundPerson ? { code: boundPerson.code, name: boundPerson.person } : null);
      if (resolved) {
        const family = resolved.name.split("｜")[0].trim();
        // 可见人物可能绑定状态变体 code，而台词说话人只带主名/别名；同一人物不得再作为 voiceOnly 重复出现。
        if (peopleNames.has(speaker) || visibleCharacterFamilies.has(family) || peopleAssetCodes.has(resolved.code) || voiceOnlyKeys.has(`code:${resolved.code}`)) continue;
        voiceOnlyKeys.add(`code:${resolved.code}`);
        voiceOnlyEntries.push(`${speaker}@${resolved.code}`);
      } else {
        if (peopleNames.has(speaker) || voiceOnlyKeys.has(`name:${speaker}`)) continue;
        voiceOnlyKeys.add(`name:${speaker}`);
        voiceOnlyEntries.push(speaker);
      }
    }
    const voiceOnlyLine = voiceOnlyEntries.join("、");
    lines.push(`[本单元出场人物：${peopleLine}${voiceOnlyLine ? `；声音出现：${voiceOnlyLine}` : ""}]`);
    lines.push("");
    // 单元级光影（合并单元格，E4 在 E3 后按单元写）：统一布光段，镜级差异在每镜画面里追加
    const unitLighting = String(unit.unit_lighting ?? "").trim();
    if (unitLighting) lines.push(`[本单元光影：${unitLighting}]`);
    lines.push("");
    lines.push(`[人物状态与站位前提：${String(unit.unit_start_premise ?? "待补充")}]`);
    lines.push("");

    // 光型去重（确定性，防模板光影）：同单元内相同的光影句只保留第一次出现——
    // Seedance 单元独立生成，光型在单元内出现一次即建立场景光型，后续镜不重复追加
    const seenLightingInUnit = new Set<string>();

    included.forEach((shot, index) => {
      const e1 = shot.e1 as Record<string, unknown>;
      const e2 = shot.e2 as Record<string, unknown>;
      const e3 = shot.e3 as Record<string, unknown>;
      const e4 = shot.e4 as Record<string, unknown>;
      // 6 格合并：与分镜表页面共用同一套合并规则，表上看到什么就编译出什么
      const cells = composeShotCells({ e1, e2, e3, e4 });
      let picture = cells.picture;
      // 对白单一真相源（顾问要求）：picture/sound 不得携带完整对白——逐字对白只由台词格提供，
      // 引号内 ≥8 字的完整对白从画面/声音机械剥离（保留说话人与动作，如"赵清雅说'完整台词…'" → "赵清雅说着"），
      // 从结构上消灭"画面说 A、台词栏却 B"的双真相源
      picture = picture.replace(/[“"''][^“"'']{9,}[”"'']/g, "").replace(/[，、；：]{1,2}$/, "").replace(/\s{2,}/g, " ").trim();
      const lighting = typeof e4?.lighting === "string" && e4.lighting.trim() ? e4.lighting.trim() : null;
      if (lighting) {
        if (seenLightingInUnit.has(lighting)) {
          // 重复光型：从画面尾部剥离"；光影：…"，场景光型已由本单元首次出现建立
          picture = picture.replace(/；光影：[\s\S]*$/, "").replace(/\s+$/, "");
        } else {
          seenLightingInUnit.add(lighting);
        }
      }
      const dialogueText = (shot.dialogue as Array<Record<string, unknown>>)
        .map(formatDialogueEntry)
        .join("；");
      const range = shotRanges[index];
      const shotTicks = Math.max(0, range.endTick - range.startTick);
      const dialogueSchedule = buildDialogueSchedule(shot.dialogue as Array<Record<string, unknown>>, shotTicks);
      lines.push(`- 分镜${index + 1},${shot.duration}s,`);
      lines.push(`- 时间范围: 单元内${formatTick(range.startTick)}–${formatTick(range.endTick)}s｜全片${formatTick(startTick + range.startTick)}–${formatTick(startTick + range.endTick)}s;`);
      if ((shot.dialogue as Array<Record<string, unknown>>).length && !dialogueSchedule.length) {
        lines.push("- 对白时段: 容量不足，需E1拆镜;");
      } else if (dialogueSchedule.length) {
        for (const slot of dialogueSchedule) {
          lines.push(`- 对白时段: 单元内${formatTick(range.startTick + slot.startTick)}–${formatTick(range.startTick + slot.endTick)}s｜${formatDialogueEntry(slot)};`);
        }
      } else {
        lines.push("- 对白时段: 无;");
      }
      lines.push(`- 机位/运动: ${cells.camera_motion};`);
      lines.push(`- 画面: ${picture};`);
      lines.push(`- 声音: ${cells.sound.replace(/[“"''][^“"'']{9,}[”"'']/g, "").replace(/[，、；：]{1,2}$/, "").replace(/\s{2,}/g, " ").trim()};`);
      lines.push(`- 台词: ${dialogueText || "无"};`);
      lines.push(`- 转场节拍: ${cells.transition};`);
      lines.push("");
    });

    prompts[unitKey] = lines.join("\n").trim();
  }
  return prompts;
}

function formatTick(tick: number): string {
  return (tick / 10).toFixed(1);
}

function buildShotDialogue(
  raw: Record<string, unknown>,
  refs: string[],
  shotDuration: number,
  nodes: Map<string, SourceNode>
): Array<Record<string, unknown>> {
  const spans = (Array.isArray(raw.dialogue_spans) ? raw.dialogue_spans.filter(isRecord) : []) as Array<Record<string, unknown>>;
  const entries = (spans.length ? spans : refs.map((source_node_id) => ({ source_node_id, span_state: "whole" } as Record<string, unknown>)))
    .map((span) => {
      const node = nodes.get(String(span.source_node_id ?? ""));
      if (!node || !["DIALOGUE", "OS", "VO", "NARRATION", "SYSTEM"].includes(node.type)) return null;
      return {
        source_node_id: node.source_node_id,
        speaker: node.speaker ?? "",
        type: node.type === "DIALOGUE" ? "对白" : node.type,
        // 后台机械拆分（台词>42字）写入的原文切片优先，其次按锚点切片，避免锚点歧义
        text: typeof span.text_override === "string" && span.text_override.trim()
          ? span.text_override.trim()
          : sliceByAnchors(node.text, span),
        span_state: String(span.span_state ?? "whole")
      };
    })
    .filter(Boolean) as Array<Record<string, unknown>>;
  const totalChars = Math.max(1, entries.reduce((sum, entry) => sum + spokenCharCount(String(entry.text)), 0));
  return entries.map((entry) => ({
    ...entry,
    duration: ceilTenth(Math.max(0.1, shotDuration * (spokenCharCount(String(entry.text)) / totalChars)))
  }));
}

function sliceByAnchors(text: string, span: Record<string, unknown>) {
  const state = String(span.span_state ?? "whole");
  const from = optionalString(span.from_anchor);
  const to = optionalString(span.to_anchor);
  if (state === "whole") return text;
  const fromIndex = from ? text.indexOf(from) : -1;
  const start = fromIndex >= 0 ? fromIndex : 0;
  const toIndex = to ? text.indexOf(to, start) : -1;
  const end = toIndex >= 0 && to ? toIndex + to.length : text.length;
  // from/to 都是「本段首尾锚」且均包含；缺失或未命中时才退到原文边界。
  return text.slice(start, end);
}

function normalizeReviewIssues(rawIssues: Record<string, unknown>[]): PipelineIssue[] {
  // 防御性截断：单次审查最多 25 张卡、证据最多 200 字，避免模型输出超长导致 JSON 截断失败
  return rawIssues.slice(0, 25).map((raw, index) => ({
    coordinate: String(raw.coordinate ?? `E5.issue.${index + 1}`).slice(0, 120),
    code: String(raw.issue_code ?? raw.code ?? "E5_ISSUE").slice(0, 60),
    severity: normalizeSeverity(raw.severity, "MAJOR"),
    ownerRole: String(raw.owner_role ?? "E5").slice(0, 20),
    expected: String(raw.expected ?? "满足岗位契约").slice(0, 200),
    evidence: String(raw.actual_evidence ?? raw.evidence ?? "独立审查发现问题").slice(0, 200),
    requestedEffect: String(raw.requested_effect ?? "在最小范围内修复").slice(0, 200)
  }));
}

/** E0 输入里把源节点映射为全局序号（与 buildSourcePackage 计数一致）。 */
function nodeSeqOf(context: PipelineContext, nodeId: string): number {
  let seq = 0;
  for (const scene of context.sourcePackage.scenes) {
    for (const node of scene.source_nodes) {
      seq += 1;
      if (node.source_node_id === nodeId) return seq;
    }
  }
  return 0;
}

/** E0 叙事骨架落库：sceneSnapshot EP-N-BEATS（E1 输入与 BEAT_BOUNDARY 校验共用）。 */
/**
 * E0 落库（含 CAPACITY PREFLIGHT 钳制）：
 * 1) 解析模型输出的 sequences → beats（兼容旧平铺 beats 结构）；
 * 2) 对每个 beat 用节点列表机械算容量底盘 hard_min_shots / hard_min_seconds；
 * 3) 导演预算 target/max 低于硬下限时机械钳制到下限（顾问要求：E0 禁止生成数学上不可能的预算），
 *    钳制详情记录到返回值的 capacity_clamped 供 run 日志展示；
 * 4) 落库 EP-N-BEATS 快照（schema E0_BEATS_V2：sequences 两层结构）。
 */
async function persistE0(context: PipelineContext, output: Record<string, unknown>) {
  const episodeNumber = context.episode.number;
  const seqOf = (() => {
    const map = new Map<string, number>();
    let seq = 0;
    for (const node of context.sourceNodes.values()) map.set(node.source_node_id, ++seq);
    return map;
  })();
  const nodeBySeq = new Map<number, SourceNode>();
  for (const [id, seq] of seqOf) nodeBySeq.set(seq, context.sourceNodes.get(id)!);

  // 兼容：模型可能仍输出旧平铺 beats —— 包成单 sequence
  const rawSequences = Array.isArray(output.sequences)
    ? (output.sequences as Record<string, unknown>[])
    : Array.isArray(output.beats)
      ? [{ sequence_id: "S01", title: "本集", causal_chain: "", node_range: [1, context.sourceNodes.size], beats: output.beats }]
      : [];

  const clamped: string[] = [];
  const sequences: E0Sequence[] = rawSequences.map((rawSeq) => {
    const seqStart = Number((rawSeq.node_range as number[] | undefined)?.[0] ?? 1);
    const seqEnd = Number((rawSeq.node_range as number[] | undefined)?.[1] ?? context.sourceNodes.size);
    const rawBeats = Array.isArray(rawSeq.beats) ? (rawSeq.beats as Record<string, unknown>[]) : [];
    const beats: E0Beat[] = rawBeats.map((rawBeat) => {
      const range = Array.isArray(rawBeat.node_range) ? rawBeat.node_range.map(Number) : [];
      const start = range[0] ?? 1;
      const end = range[1] ?? start;
      const nodes = Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => start + i)
        .map((seq) => nodeBySeq.get(seq))
        .filter((node): node is SourceNode => Boolean(node));
      const capacity = computeBeatCapacity(nodes);
      const targetShots = Number(rawBeat.target_shots ?? rawBeat.max_shots ?? capacity.hard_min_shots);
      const maxShots = Number(rawBeat.max_shots ?? Math.max(targetShots, capacity.hard_min_shots));
      const targetSeconds = Number(rawBeat.target_seconds ?? rawBeat.shot_budget_seconds ?? capacity.hard_min_seconds);
      const maxSeconds = Number(rawBeat.max_seconds ?? Math.max(targetSeconds, capacity.hard_min_seconds));
      const beatId = String(rawBeat.beat_id ?? `B${String(rawBeats.indexOf(rawBeat) + 1).padStart(2, "0")}`);
      // 钳制：导演预算不得低于机械硬下限（顾问 CAPACITY PREFLIGHT 要求）
      if (targetShots < capacity.hard_min_shots) {
        clamped.push(`${beatId} 镜数 target ${targetShots}→${capacity.hard_min_shots}（对白${capacity.dialogue_chars}字需≥${capacity.min_dialogue_shots}镜）`);
      }
      if (targetSeconds < capacity.hard_min_seconds) {
        clamped.push(`${beatId} 时长 target ${targetSeconds}s→${capacity.hard_min_seconds}s（对白${capacity.dialogue_chars}字@6字/s需≥${capacity.dialogue_min_seconds}s）`);
      }
      const visualSteps = (Array.isArray(rawBeat.visual_steps) ? rawBeat.visual_steps : []).map((step, index) => {
        const s = step as Record<string, unknown>;
        return {
          step_id: String(s.step_id ?? `V${index + 1}`),
          label: String(s.label ?? ""),
          directive: String(s.directive ?? "")
        };
      });
      return {
        beat_id: beatId,
        sequence_id: String(rawSeq.sequence_id ?? "S01"),
        title: String(rawBeat.title ?? ""),
        node_range: [start, end] as [number, number],
        drama_function: String(rawBeat.drama_function ?? ""),
        capacity,
        target_shots: Math.max(capacity.hard_min_shots, targetShots),
        max_shots: Math.max(capacity.hard_min_shots, maxShots, targetShots),
        target_seconds: Math.max(capacity.hard_min_seconds, targetSeconds),
        max_seconds: Math.max(capacity.hard_min_seconds, maxSeconds, targetSeconds),
        visual_steps: visualSteps,
        anchor_nodes: Array.isArray(rawBeat.anchor_nodes) ? rawBeat.anchor_nodes.map(Number) : []
      };
    });
    return {
      sequence_id: String(rawSeq.sequence_id ?? "S01"),
      title: String(rawSeq.title ?? ""),
      causal_chain: String(rawSeq.causal_chain ?? ""),
      node_range: [seqStart, seqEnd] as [number, number],
      beats
    };
  });

  const stored = {
    role: "E0",
    episode_number: episodeNumber,
    target_duration: Number(output.target_duration ?? 0),
    sequences,
    notes: String(output.notes ?? ""),
    capacity_clamped: clamped
  };
  await prisma.sceneSnapshot.deleteMany({
    where: { projectId: context.projectId, episodeId: context.episodeId, sceneKey: `EP-${episodeNumber}-BEATS` }
  });
  await prisma.sceneSnapshot.create({
    data: {
      projectId: context.projectId,
      episodeId: context.episodeId,
      sceneKey: `EP-${episodeNumber}-BEATS`,
      title: `第${episodeNumber}集叙事骨架（E0）`,
      content: JSON.stringify(stored, null, 2),
      metadata: JSON.stringify({ schema: "E0_BEATS_V2", source: "E0" })
    }
  });
  return stored;
}

function requireE1(value: Record<string, unknown>): E1Output {
  // 兼容两种输出契约：全量/整镜修复 = shots 数组；单元格修复轮 = patches 数组（persistE1 内分流）
  if (!Array.isArray(value.shots) && !Array.isArray(value.patches)) throw new Error("E1返回缺少shots或patches数组。");
  return value as unknown as E1Output;
}

function requirePatchOutput(value: Record<string, unknown>, role: string): PatchOutput {
  if (!Array.isArray(value.patches)) throw new Error(`${role}返回缺少patches数组。`);
  return value as unknown as PatchOutput;
}

function requireE3(value: Record<string, unknown>): E3UnitOutput {
  if (!Array.isArray(value.units) || !Array.isArray(value.patches)) throw new Error("E3返回缺少patches或units数组。");
  return value as unknown as E3UnitOutput;
}

function requireE5(value: Record<string, unknown>): E5ReviewOutput {
  if (!Array.isArray(value.issues) || !isRecord(value.coverage)) throw new Error("E5返回缺少coverage或issues。");
  if (!["pass", "targeted_revision", "admin_attention"].includes(String(value.decision))) throw new Error("E5返回了无效decision。");
  return value as unknown as E5ReviewOutput;
}

async function findBatchRun(projectId: string, episodeId: string, batchToken: string, stageCode: string) {
  return prisma.pipelineRun.findFirst({
    where: { projectId, episodeId, stageCode, inputSummary: { contains: batchToken } },
    orderBy: { createdAt: "desc" }
  });
}

async function findBatchRuns(projectId: string, episodeId: string, batchToken: string) {
  return prisma.pipelineRun.findMany({
    where: { projectId, episodeId, inputSummary: { contains: batchToken } },
    orderBy: { createdAt: "asc" }
  });
}

async function cancelQueuedBatch(projectId: string, episodeId: string, batchToken: string, reason: string) {
  const runs = await findBatchRuns(projectId, episodeId, batchToken);
  await prisma.pipelineRun.updateMany({
    where: { id: { in: runs.filter((run) => run.status === "QUEUED").map((run) => run.id) } },
    data: { status: "CANCELED" as GenerationRunStatus, finishedAt: new Date(), error: reason }
  });
}

/** 单步骤模式：把数据库里已落盘的小镜号回填为 WorkingShot（e1..e4 解析为对象）。 */
export async function hydrateWorkingShots(context: PipelineContext): Promise<WorkingShot[]> {
  const rows = await prisma.storyboardShot.findMany({
    where: { episodeId: context.episodeId },
    include: { scene: true },
    orderBy: { sortOrder: "asc" }
  });
  return rows.map((shot) => ({
    shot_id: shot.shotKey,
    scene_id: shot.scene.sceneKey,
    time_segment_id: "",
    time_layer: shot.timeLayer,
    duration: shot.duration,
    source_node_refs: parseJsonList(shot.sourceNodeRefs).map(String),
    dialogue: parseJsonList(shot.dialogue),
    e1: safeParseJson(shot.e1Data),
    e2: safeParseJson(shot.e2Data),
    e3: safeParseJson(shot.e3Data),
    e4: safeParseJson(shot.e4Data)
  }));
}

/** 单步骤模式：把数据库里已落盘的 Seedance 单元回填为 E5 输出形状（优先用原 E5 data，缺 shot_ids 时回退到链接表）。 */
export async function hydrateUnitOutput(context: PipelineContext): Promise<E3UnitOutput> {
  const rows = await prisma.seedanceUnit.findMany({
    where: { episodeId: context.episodeId },
    orderBy: { sortOrder: "asc" }
  });
  const units: Record<string, unknown>[] = [];
  for (const row of rows) {
    const raw = safeParseJson(row.data);
    if (Array.isArray(raw.shot_ids) && (raw.shot_ids as unknown[]).length) {
      units.push(raw);
      continue;
    }
    const links = await prisma.seedanceUnitShot.findMany({
      where: { unitId: row.id },
      include: { shot: true },
      orderBy: { sortOrder: "asc" }
    });
    units.push({
      ...raw,
      unit_id: row.unitKey,
      shot_ids: links.map((link) => link.shot.shotKey),
      unit_duration: row.duration,
      unit_start_premise: row.startPremise,
      unit_end_state: row.endState,
      unit_dominant_goal: row.dominantGoal ?? null,
      short_unit_reason: row.shortUnitReason ?? null
    });
  }
  return { role: "E3", base_revision: context.revision, patches: [], units, issues: [] };
}

function parseJsonList(value: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function sceneCards(context: PipelineContext) {
  return context.scenes.map((scene) => ({
    scene_id: scene.sceneKey,
    heading: scene.heading,
    location: scene.location,
    interior_exterior: scene.interiorExterior,
    time_of_day: scene.timeOfDay,
    weather: scene.weather,
    time_layer: scene.timeLayer,
    metadata: safeParseJson(scene.metadata)
  }));
}

function assetRows(context: PipelineContext, types: string[]) {
  return context.project.assets.filter((asset) => types.includes(asset.type)).map((asset) => ({ id: asset.code, type: asset.type, name: asset.name, status: asset.status }));
}

function pickFields(source: Record<string, unknown>, keys: string[]) {
  return Object.fromEntries(keys.filter((key) => source[key] !== undefined).map((key) => [key, source[key]]));
}

/** 按岗位白名单裁剪每镜的 e1/e2/e3 原始对象：只发该岗位需要的字段，其余（source_node_refs/dialogue_spans/risk_notes…）不进提示词。 */
/** 粗判镜头是否为多人/群像镜：画面出现人群词或说话人 ≥3。 */
function isCrowdShot(shot: WorkingShot): boolean {
  const cells = composeShotCells({
    e1: shot.e1 as Record<string, unknown>,
    e2: shot.e2 as Record<string, unknown>,
    e3: shot.e3 as Record<string, unknown>,
    e4: shot.e4 as Record<string, unknown>
  });
  if (/众人|人群|同学们|学生们|大家|围观|群像|师生|村民们|弟兄们|众凶兽/.test(`${cells.picture} ${cells.sound}`)) return true;
  const speakers = new Set((shot.dialogue as Array<Record<string, unknown>>).map((entry) => String(entry.speaker ?? "")).filter(Boolean));
  return speakers.size >= 3;
}

type ResolvedVisualStep = {
  ref: string;
  beat_id: string;
  step_id: string;
  label: string;
  directive: string;
};

type E5VisualStep = (ResolvedVisualStep & { part_index: number; part_count: number; part_goal: string }) | { invalid: string; declared: string } | null;

/** 镜头真实承载的源节点：refs 为主，dialogue 兜底旧数据与机械切片。 */
function shotSourceNodeIds(shot: WorkingShot): string[] {
  const dialogueIds = (Array.isArray(shot.dialogue) ? shot.dialogue : [])
    .filter(isRecord)
    .map((entry) => String(entry.source_node_id ?? "").trim())
    .filter(Boolean);
  return [...new Set([...stringArray(shot.source_node_refs), ...dialogueIds])];
}

/** E2 只需要本镜实际台词切片；说话人与表演提示始终从当前 source_nodes 规范值回填，兼容旧镜头数据。 */
function compactShotDialogueSlices(context: PipelineContext, shot: WorkingShot) {
  return (Array.isArray(shot.dialogue) ? shot.dialogue : [])
    .filter(isRecord)
    .map((entry) => {
      const sourceNodeId = String(entry.source_node_id ?? "");
      const sourceNode = context.sourceNodes.get(sourceNodeId);
      return {
        source_node_id: sourceNodeId,
        speaker: String(sourceNode?.speaker ?? entry.speaker ?? ""),
        type: String(sourceNode?.type ?? entry.type ?? "DIALOGUE"),
        performance_cue: sourceNode?.performance_cue ?? null,
        // 这里保留镜内机械切片，不能用 sourceNode.text 覆盖成长台词全文。
        text: String(entry.text ?? ""),
        span_state: String(entry.span_state ?? "whole")
      };
    })
    .filter((entry) => entry.source_node_id);
}

/**
 * 镜头 → Beat 命名空间内的视觉步骤。
 * 优先用 source_node_refs/dialogue 定位 Beat；旧数据无节点引用时，仅允许显式 beat_id
 * 或全剧唯一 step_id 回退。重复 V1/V2 等歧义值必须显式失败，禁止静默首匹配。
 */
function safeVisualStepPartsForE5(context: PipelineContext, shots: WorkingShot[]): Map<string, E5VisualStep> {
  const resolved = shots.map((shot) => {
    try {
      return { shot, value: visualStepForShot(context, shot), invalid: null as string | null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = /^\[([^\]]+)\]/.exec(message)?.[1] ?? "VISUAL_STEP_INVALID";
      return { shot, value: null, invalid: code };
    }
  });
  const countByRef = new Map<string, number>();
  for (const item of resolved) if (item.value) countByRef.set(item.value.ref, (countByRef.get(item.value.ref) ?? 0) + 1);
  const cursorByRef = new Map<string, number>();
  const result = new Map<string, E5VisualStep>();
  for (const item of resolved) {
    if (item.invalid) {
      result.set(item.shot.shot_id, { invalid: item.invalid, declared: String((item.shot.e1 as Record<string, unknown>)?.fulfills_visual_step ?? "").trim() });
      continue;
    }
    if (!item.value) {
      result.set(item.shot.shot_id, null);
      continue;
    }
    const part_index = (cursorByRef.get(item.value.ref) ?? 0) + 1;
    cursorByRef.set(item.value.ref, part_index);
    result.set(item.shot.shot_id, {
      ...item.value,
      part_index,
      part_count: countByRef.get(item.value.ref) ?? 1,
      part_goal: String((item.shot.e1 as Record<string, unknown>).visual_step_part_goal ?? "").trim()
    });
  }
  return result;
}

export function visualStepPartsForShots(context: PipelineContext, shots: WorkingShot[]): Array<ResolvedVisualStep & { shot_id: string; part_index: number; part_count: number; part_goal: string }> {
  const resolved = shots.map((shot) => ({ shot, visualStep: visualStepForShot(context, shot) })).filter((item): item is { shot: WorkingShot; visualStep: ResolvedVisualStep } => Boolean(item.visualStep));
  const countByRef = new Map<string, number>();
  for (const item of resolved) countByRef.set(item.visualStep.ref, (countByRef.get(item.visualStep.ref) ?? 0) + 1);
  const cursorByRef = new Map<string, number>();
  return resolved.map(({ shot, visualStep }) => {
    const part_index = (cursorByRef.get(visualStep.ref) ?? 0) + 1;
    cursorByRef.set(visualStep.ref, part_index);
    return {
      ...visualStep,
      shot_id: shot.shot_id,
      part_index,
      part_count: countByRef.get(visualStep.ref) ?? 1,
      part_goal: String((shot.e1 as Record<string, unknown>).visual_step_part_goal ?? "").trim()
    };
  });
}

function visualStepForShot(context: PipelineContext, shot: WorkingShot): ResolvedVisualStep | null {
  const e1 = shot.e1 as Record<string, unknown> | undefined;
  const rawStepRef = String(e1?.fulfills_visual_step ?? "").trim();
  if (!rawStepRef || !context.beats.length) return null;

  const namespaced = /^([^.\s]+)\.([^.\s]+)$/.exec(rawStepRef);
  const stepId = namespaced?.[2] ?? rawStepRef;
  const explicitBeatId = String(e1?.visual_step_beat_id ?? e1?.beat_id ?? namespaced?.[1] ?? "").trim();
  const sourceNodeIds = shotSourceNodeIds(shot);
  const sourceBeatIds = new Set<string>();
  const unknownSourceNodes: string[] = [];
  const nodesOutsideBeats: string[] = [];
  for (const nodeId of sourceNodeIds) {
    const nodeSeq = nodeSeqOf(context, nodeId);
    if (!nodeSeq) {
      unknownSourceNodes.push(nodeId);
      continue;
    }
    const hits = context.beats.filter((beat) => beat.node_range[0] <= nodeSeq && nodeSeq <= beat.node_range[1]);
    if (!hits.length) nodesOutsideBeats.push(nodeId);
    for (const beat of hits) sourceBeatIds.add(beat.beat_id);
  }
  if (unknownSourceNodes.length) {
    throw new Error(`[VISUAL_STEP_SOURCE_UNKNOWN] ${shot.shot_id} 引用了不存在的源节点 ${unknownSourceNodes.join("/")}，无法定位 ${rawStepRef}`);
  }
  if (nodesOutsideBeats.length) {
    throw new Error(`[VISUAL_STEP_NODE_OUTSIDE_BEAT] ${shot.shot_id} 的 ${nodesOutsideBeats.join("/")} 不属于任何 E0 Beat，无法定位 ${rawStepRef}`);
  }
  if (sourceBeatIds.size > 1) {
    throw new Error(`[VISUAL_STEP_BEAT_AMBIGUOUS] ${shot.shot_id} 的源节点跨越 ${[...sourceBeatIds].join("/")}，不能把 ${rawStepRef} 静默归给首个 Beat`);
  }

  let beat = sourceBeatIds.size === 1
    ? context.beats.find((item) => item.beat_id === [...sourceBeatIds][0])
    : undefined;
  if (explicitBeatId) {
    const explicitBeat = context.beats.find((item) => item.beat_id === explicitBeatId);
    if (!explicitBeat) {
      throw new Error(`[VISUAL_STEP_BEAT_UNKNOWN] ${shot.shot_id} 声明了不存在的 Beat ${explicitBeatId}`);
    }
    if (beat && beat.beat_id !== explicitBeat.beat_id) {
      throw new Error(`[VISUAL_STEP_BEAT_MISMATCH] ${shot.shot_id} 的源节点属于 ${beat.beat_id}，但视觉步骤声明为 ${explicitBeat.beat_id}.${stepId}`);
    }
    beat = explicitBeat;
  }

  if (!beat) {
    const legacyCandidates = context.beats.filter((item) =>
      item.visual_steps.some((step) => String((step as Record<string, unknown>).step_id ?? "") === stepId)
    );
    if (legacyCandidates.length > 1) {
      throw new Error(`[VISUAL_STEP_LEGACY_AMBIGUOUS] ${shot.shot_id} 缺少可定位源节点，旧步骤 ${stepId} 同时存在于 ${legacyCandidates.map((item) => item.beat_id).join("/")}`);
    }
    beat = legacyCandidates[0];
  }
  if (!beat) {
    throw new Error(`[VISUAL_STEP_UNKNOWN] ${shot.shot_id} 声明的视觉步骤 ${rawStepRef} 不存在`);
  }

  const step = beat.visual_steps.find((item) => String((item as Record<string, unknown>).step_id ?? "") === stepId);
  if (!step) {
    throw new Error(`[VISUAL_STEP_INVALID] ${shot.shot_id} 声明 ${beat.beat_id}.${stepId}，但该 Beat 没有此步骤`);
  }
  const value = step as Record<string, unknown>;
  return {
    ref: `${beat.beat_id}.${stepId}`,
    beat_id: beat.beat_id,
    step_id: stepId,
    label: String(value.label ?? ""),
    directive: String(value.directive ?? "")
  };
}

function trimmedShotRows(
  shots: WorkingShot[],
  spec: Array<[field: "e1" | "e2" | "e3" | "e4", keys: string[]]>
) {
  return shots.map((shot) => {
    const row: Record<string, unknown> = {
      shot_id: shot.shot_id,
      scene_id: shot.scene_id,
      time_layer: shot.time_layer,
      duration: shot.duration
    };
    for (const [field, keys] of spec) {
      const record = shot[field] as Record<string, unknown> | undefined;
      if (!record) continue;
      const picked: Record<string, unknown> = {};
      for (const key of keys) {
        if (record[key] !== undefined && record[key] !== null && record[key] !== "") picked[key] = record[key];
      }
      row[field] = picked;
    }
    return row;
  });
}

function stageShotRows(shots: WorkingShot[], fields: Array<"e1" | "e2" | "e3" | "e4">) {
  return shots.map((shot) => Object.fromEntries([
    ["shot_id", shot.shot_id],
    ["scene_id", shot.scene_id],
    ["time_layer", shot.time_layer],
    ["duration", shot.duration],
    ["source_node_refs", shot.source_node_refs],
    ...fields.map((field) => [field, shot[field]])
  ]));
}

function referencedNodes(context: PipelineContext, shots: WorkingShot[]) {
  const ids = new Set(shots.flatMap(shotSourceNodeIds));
  return [...ids]
    .map((id) => context.sourceNodes.get(id))
    .filter((node): node is SourceNode => Boolean(node))
    .map((node) => ({
      source_node_id: node.source_node_id,
      type: node.type,
      speaker: node.speaker,
      performance_cue: node.performance_cue ?? null,
      text: node.text
    }));
}

function compactFirstPhaseContext(payload: Record<string, unknown>) {
  return {
    project_memory: compactMemory(payload["全剧记忆快照"]),
    episode_context: compactEpisodeContext(payload["本集上下文快照"]),
    scene_snapshot: payload["场次快照"] ?? null
  };
}

/** 全剧记忆（P1 V2）压缩：只保留稳定事实，剥离 source_node_refs 引用数组（占体积大头且 E1 用不到）。 */
function compactMemory(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const memory = value as Record<string, unknown>;
  const strip = (list: unknown): unknown => {
    if (!Array.isArray(list)) return list;
    return list.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const record = { ...(item as Record<string, unknown>) };
      delete record.source_node_refs;
      return record;
    });
  };
  const episodes = Array.isArray(memory.episodes)
    ? memory.episodes.map((episode) => {
        const record = { ...(episode as Record<string, unknown>) };
        delete record.source_node_refs;
        delete record.scenes;
        return record;
      })
    : memory.episodes;
  return {
    ...memory,
    episodes,
    relationships: strip(memory.relationships),
    secrets: strip(memory.secrets),
    foreshadowing: strip(memory.foreshadowing),
    boundaries: strip(memory.boundaries)
  };
}

/** 本集上下文快照压缩：场景快照已在 locked_script 全量给出，这里只留人物/地点/道具/连续性。 */
function compactEpisodeContext(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const record = { ...(value as Record<string, unknown>) };
  delete record.sceneSnapshot;
  return record;
}

function coveredNodeCount(shots: WorkingShot[]) {
  return new Set(shots.flatMap((shot) => stringArray(shot.source_node_refs))).size;
}

function safeParseJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 正则转义（用于把资产名安全嵌入正则）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function requiredString(value: unknown, coordinate: string) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${coordinate}为空。`);
  return text;
}

function optionalString(value: unknown): string | null {
  const text = String(value ?? "").trim();
  return text && text !== "null" ? text : null;
}

function positiveNumber(value: unknown, coordinate: string) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${coordinate}必须是正数。`);
  return roundTenth(number);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).map((item) => item.trim()).filter(Boolean) : [];
}

function normalizeSeverity(value: unknown, fallback: PipelineIssue["severity"]): PipelineIssue["severity"] {
  const text = String(value ?? "").toUpperCase();
  return text === "BLOCKER" || text === "MAJOR" || text === "MINOR" ? text : fallback;
}

function issue(coordinate: string, code: string, severity: PipelineIssue["severity"], ownerRole: string, evidence: string, requestedEffect: string): PipelineIssue {
  return { coordinate, code, severity, ownerRole, expected: "满足结构化分镜生产硬约束", evidence, requestedEffect };
}

function dedupeIssues(issues: PipelineIssue[]) {
  const seen = new Set<string>();
  return issues.filter((item) => {
    const key = `${item.code}:${item.coordinate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function spokenCharCount(value: string) {
  return value.replace(/[\s，。！？、；：,.!?;:‘’“”"'（）()《》【】—…-]/g, "").length;
}

/** 向上取整到 0.1 秒：台词条目时长用它，保证字速严格 ≤6 字/秒（比例分配四舍五入会产生 6.1/6.2 越界）。 */
function ceilTenth(value: number) {
  return Math.ceil(value * 10) / 10;
}


/** 去标点后的原文，用于台词切片拼接完整性比较（锚点切片允许丢失段间标点）。 */
/**
 * 资产提及匹配（别名标准化）：文本中出现资产名或其常见变体即视为提及。
 * 系统类：系统窗口 / 系统面板 / 半透明系统面板 / UI面板 / 面板 归一为同一 PROP；
 * Q版类：苏远Q版 / Q版苏远 / Q版 归一为同一 CH 变体。
 */
/** 资产可提及名 = 主名 + 全名（带｜后缀时）+ metadata.aliases（如 白灵神鹤 → [白灵神鹤, 神鹤, 仙鹤]）。 */
function mentionNames(asset: { name: string; metadata?: string | null }): string[] {
  const main = asset.name.split("｜")[0].trim();
  const names = main.length >= 2 ? [main] : [];
  if (asset.name.trim() && asset.name.trim() !== main) names.push(asset.name.trim());
  const meta = safeParseJson(asset.metadata) as Record<string, unknown> | null;
  const aliases = Array.isArray(meta?.aliases)
    ? (meta.aliases as unknown[]).map((a) => String(a).trim()).filter((a) => a.length >= 2)
    : [];
  return [...names, ...aliases];
}

/** 去歧义后的「主名 → 可提及名列表」：别名若是其它资产主名的子串（如 应龙 ⊂ 苍黄应龙），
 *  文本里出现的是别的实体，不作为本资产提及——防 BINDING 误判与跨资产串台（实测 U16 文本含
 *  "苍黄应龙虚影" 被 万古应龙 的别名 "应龙" 误命中 → 假 BINDING_MISSING）。 */
function effectiveMentionNamesByMain(assets: Array<{ id?: string; name: string; metadata?: string | null }>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  const otherMains = assets.map((a) => a.name.split("｜")[0].trim()).filter((n) => n.length >= 2);
  for (const asset of assets) {
    const main = asset.name.split("｜")[0].trim();
    if (main.length < 2) continue;
    const others = otherMains.filter((n) => n !== main);
    const names = mentionNames(asset).filter((n) => !others.some((other) => other.includes(n) && other !== n));
    map.set(main, names);
  }
  return map;
}

function assetMentionedIn(text: string, asset: { name: string; type: string; aliases?: string[] }): boolean {
  // 主名与别名都要认（实测：源剧本写"仙鹤虚影"、画面写"白灵神鹤"，只查主名会把首出误判到更晚的节点）
  const names = asset.aliases?.length ? asset.aliases : [asset.name];
  if (names.some((n) => text.includes(n))) return true;
  if (/系统|面板/.test(asset.name) && /系统(?:窗口|面板)?|半透明系统面板|UI面板|面板/.test(text)) return true;
  if (/Q版/.test(asset.name) && /苏远Q版|Q版苏远|Q版/.test(text)) return true;
  return false;
}

/** 画面文本相似度（2 字滑动窗口 Jaccard），用于填充镜检测。 */
function bigramSimilarity(a: string, b: string): number {
  const setA = new Set<string>();
  const setB = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) setA.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) setB.add(b.slice(i, i + 2));
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  return inter / (setA.size + setB.size - inter);
}

function stripPunctuation(value: string) {
  return value.replace(/[\s，。！？、；：,.!?;:'‘’“”"'（）()《》【】—…-]/g, "");
}

function firstText(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return recordText(record);
}

function recordText(record: Record<string, unknown>) {
  return Object.entries(record)
    .filter(([, value]) => value !== null && value !== "" && (!Array.isArray(value) || value.length))
    .map(([key, value]) => `${key}：${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("；");
}

function bindingStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => typeof item === "string" ? item : JSON.stringify(item));
  if (isRecord(value)) return Object.entries(value).map(([key, item]) => `${key} ${typeof item === "string" ? item : JSON.stringify(item)}`);
  return [];
}
