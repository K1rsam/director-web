import { PIPELINE_STAGE_CONFIGS, type PipelineStageCode } from "@/lib/episode-pipeline-contracts";
import { classifyExecutionError } from "@/lib/execution-errors";

export type EpisodePipelineRunLike = {
  stageCode: string;
  status: string;
  inputSummary?: string | null;
  outputSummary?: string | null;
  error?: string | null;
  createdAt: Date;
  finishedAt?: Date | null;
};

export type EpisodeIssueLike = {
  severity: string;
  status: string;
  coordinate?: string;
  code?: string;
  ownerRole?: string;
};

export type EpisodePipelineState = "NOT_STARTED" | "QUEUED" | "RUNNING" | "READY" | "BLOCKED" | "FAILED" | "INCOMPLETE";

export type EpisodePipelineSummary = {
  state: EpisodePipelineState;
  /** E0–E5 都已执行结束；质量问题不影响批量初稿继续排队。 */
  initialComplete: boolean;
  ready: boolean;
  hasRuns: boolean;
  activeCount: number;
  missingStages: PipelineStageCode[];
  failedStages: PipelineStageCode[];
  openBlockers: number;
  openMajors: number;
  openMinors: number;
  latestByStage: Partial<Record<PipelineStageCode, EpisodePipelineRunLike>>;
  e5Decision: string | null;
  reason: string;
};

const STAGE_CODES = PIPELINE_STAGE_CONFIGS.map((stage) => stage.code);

/** 批量初稿的固定策略：首次执行 + 一次整集重做。 */
export const INITIAL_BATCH_MAX_ATTEMPTS = 2;

/** 判断某一集是否还应被批量监控器重做。质量问题不参与这里的判断。 */
export function shouldRetryInitialBatch(attempts: number, maxAttempts = INITIAL_BATCH_MAX_ATTEMPTS) {
  return Math.max(0, attempts) < Math.max(1, maxAttempts);
}

/** 判断某一集是否已经达到“重做后跳过”的终态。 */
export function shouldSkipInitialBatch(attempts: number, maxAttempts = INITIAL_BATCH_MAX_ATTEMPTS) {
  return Math.max(0, attempts) >= Math.max(1, maxAttempts);
}

/**
 * 找到指定批量监控器在每个岗位上的最新额度/限流失败。
 *
 * 监控器重启后，剧集仍会保留历史 E0–E5 记录；因此不能只看某岗位最近一次失败，
 * 必须按当前 monitor token 取最新结果，否则“上一轮额度不足”会阻止额度恢复后的继续执行。
 * 没有 token 的独立命令只看非返修、非单岗位的初稿记录。
 */
export function findLatestBatchCapacityFailure(
  runs: readonly EpisodePipelineRunLike[],
  monitorToken?: string | null
) {
  const latestByStage = new Map<string, EpisodePipelineRunLike>();
  const sortedRuns = [...runs].sort((a, b) => {
    const createdDelta = b.createdAt.getTime() - a.createdAt.getTime();
    return createdDelta || (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0);
  });
  for (const run of sortedRuns) {
    if (!isInitialBatchRun(run, monitorToken) || latestByStage.has(run.stageCode)) continue;
    latestByStage.set(run.stageCode, run);
  }
  return [...latestByStage.values()].find((run) => {
    if (run.status !== "FAILED" && run.status !== "CANCELED") return false;
    const kind = classifyExecutionError(run.error);
    return kind === "quota" || kind === "rate_limit";
  }) ?? null;
}

/**
 * 统计同一批量监控器实际发起过的整集初稿批次。
 * 每个 E0–E5 run 都带同一个 batchToken，因此按 token 去重即可；返修、单岗位和 P1/P2
 * 不计入初稿重做次数。监控器重启后也能从数据库恢复次数，不会因为内存清空而无限重试。
 */
export function countInitialBatchAttempts(
  runs: readonly EpisodePipelineRunLike[],
  monitorToken?: string | null
) {
  const tokens = new Set<string>();
  for (const run of runs) {
    const meta = parseJsonRecord(run.inputSummary);
    if (meta.repairPipeline === true || meta.singleStage === true) continue;
    if (monitorToken && meta.batchMonitorToken !== monitorToken) continue;
    const token = typeof meta.batchToken === "string" ? meta.batchToken.trim() : "";
    if (token) tokens.add(token);
  }
  return tokens.size;
}

/**
 * 判断历史结果中是否已经有一条完整的初稿 E0–E5 链。
 * 返修批次失败不应让批量监控器把一集已经有初稿的剧集重新当成未生产；只看非返修、非单岗位
 * 的最新结果。当前是否仍有运行中的任务由 summarizeEpisodePipeline.activeCount 另行判断。
 */
export function hasCompleteInitialBatch(runs: readonly EpisodePipelineRunLike[]) {
  const latestInitialByStage = {} as Partial<Record<PipelineStageCode, EpisodePipelineRunLike>>;
  const sortedRuns = [...runs].sort((a, b) => {
    const createdDelta = b.createdAt.getTime() - a.createdAt.getTime();
    return createdDelta || (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0);
  });
  for (const run of sortedRuns) {
    if (!isStageCode(run.stageCode) || latestInitialByStage[run.stageCode]) continue;
    const meta = parseJsonRecord(run.inputSummary);
    if (meta.repairPipeline === true || meta.singleStage === true) continue;
    latestInitialByStage[run.stageCode] = run;
  }
  return STAGE_CODES.every((stage) => latestInitialByStage[stage]?.status === "SUCCEEDED");
}

/**
 * 用数据库中的最新岗位状态判断一集是否真的可以进入批量生产。
 *
 * 注意：返修批次可能只包含 E1/E2/E5 等岗位，所以不能要求六个岗位必须属于同一个
 * batchToken；这里取每个岗位的最新记录，并要求最新 E5 在其它岗位之后完成。
 * 这样既支持定向返修，也不会把“E4 刚修完、E5 还是旧结果”误判为完成。
 */
export function summarizeEpisodePipeline(
  runs: readonly EpisodePipelineRunLike[],
  issues: readonly EpisodeIssueLike[],
  options: { requireNoMajors?: boolean } = {}
): EpisodePipelineSummary {
  const latestByStage = {} as Partial<Record<PipelineStageCode, EpisodePipelineRunLike>>;
  const sortedRuns = [...runs].sort((a, b) => {
    const createdDelta = b.createdAt.getTime() - a.createdAt.getTime();
    return createdDelta || (b.finishedAt?.getTime() ?? 0) - (a.finishedAt?.getTime() ?? 0);
  });
  for (const run of sortedRuns) {
    if (isStageCode(run.stageCode) && !latestByStage[run.stageCode]) latestByStage[run.stageCode] = run;
  }

  const activeRuns = runs.filter((run) => run.status === "QUEUED" || run.status === "RUNNING");
  const missingStages = STAGE_CODES.filter((stage) => !latestByStage[stage]);
  const failedStages = STAGE_CODES.filter((stage) => {
    const run = latestByStage[stage];
    return Boolean(run && (run.status === "FAILED" || run.status === "CANCELED"));
  });
  const openIssues = issues.filter((issue) => issue.status === "OPEN");
  const openBlockers = openIssues.filter((issue) => issue.severity === "BLOCKER").length;
  const openMajors = openIssues.filter((issue) => issue.severity === "MAJOR").length;
  const openMinors = openIssues.filter((issue) => issue.severity === "MINOR").length;
  const e5 = latestByStage.E5;
  const e5Decision = readE5Decision(e5?.outputSummary);
  const allStagesSucceeded = STAGE_CODES.every((stage) => latestByStage[stage]?.status === "SUCCEEDED");
  const reviewIsFresh = allStagesSucceeded && e5
    ? finishedAtOf(e5) >= Math.max(...STAGE_CODES.filter((stage) => stage !== "E5").map((stage) => finishedAtOf(latestByStage[stage]!)))
    : false;
  const qualityBlocked = openBlockers > 0 || (options.requireNoMajors === true && openMajors > 0);
  const initialComplete = allStagesSucceeded && activeRuns.length === 0;
  const ready = allStagesSucceeded && activeRuns.length === 0 && reviewIsFresh && !qualityBlocked && e5Decision !== "admin_attention";

  let state: EpisodePipelineState;
  if (!runs.length) state = "NOT_STARTED";
  else if (activeRuns.some((run) => run.status === "RUNNING")) state = "RUNNING";
  else if (activeRuns.length) state = "QUEUED";
  else if (ready) state = "READY";
  else if (failedStages.length) state = "FAILED";
  else if (allStagesSucceeded && (qualityBlocked || e5Decision === "admin_attention" || !reviewIsFresh)) state = "BLOCKED";
  else state = "INCOMPLETE";

  return {
    state,
    initialComplete,
    ready,
    hasRuns: runs.length > 0,
    activeCount: activeRuns.length,
    missingStages,
    failedStages,
    openBlockers,
    openMajors,
    openMinors,
    latestByStage,
    e5Decision,
    reason: explainEpisodeState({ state, missingStages, failedStages, activeRuns, openBlockers, openMajors, e5Decision, reviewIsFresh, requireNoMajors: options.requireNoMajors === true })
  };
}

function explainEpisodeState(input: {
  state: EpisodePipelineState;
  missingStages: PipelineStageCode[];
  failedStages: PipelineStageCode[];
  activeRuns: EpisodePipelineRunLike[];
  openBlockers: number;
  openMajors: number;
  e5Decision: string | null;
  reviewIsFresh: boolean;
  requireNoMajors: boolean;
}) {
  if (input.state === "NOT_STARTED") return "尚未启动 E0–E5。";
  if (input.state === "RUNNING") return `正在执行 ${input.activeRuns.map((run) => run.stageCode).join("、")}。`;
  if (input.state === "QUEUED") return `正在排队 ${input.activeRuns.map((run) => run.stageCode).join("、")}。`;
  if (input.state === "FAILED") return `最近失败岗位：${input.failedStages.join("、")}。批量初稿会整集重做 1 次，返修问题请在全剧初稿完成后单独处理。`;
  if (input.missingStages.length) return `缺少岗位结果：${input.missingStages.join("、")}。`;
  if (input.openBlockers) return `E5 留有 ${input.openBlockers} 个 BLOCKER，本集需在初稿批量完成后进入返修阶段。`;
  if (input.requireNoMajors && input.openMajors) return `严格质量门下仍有 ${input.openMajors} 个 MAJOR，本集需在初稿批量完成后进入返修阶段。`;
  if (input.e5Decision === "admin_attention") return "E5 要求人工确认，暂不自动放行。";
  if (!input.reviewIsFresh) return "E5 不是最近一次岗位结果之后的复审，需重新执行 E5。";
  return "结果尚未形成完整的 E0–E5 放行链。";
}

function isStageCode(value: string): value is PipelineStageCode {
  return STAGE_CODES.includes(value as PipelineStageCode);
}

function finishedAtOf(run: EpisodePipelineRunLike) {
  return run.finishedAt?.getTime() ?? run.createdAt.getTime();
}

function readE5Decision(outputSummary: string | null | undefined): string | null {
  if (!outputSummary) return null;
  try {
    const parsed: unknown = JSON.parse(outputSummary);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>).decision;
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function isInitialBatchRun(run: EpisodePipelineRunLike, monitorToken?: string | null) {
  const metadata = parseJsonRecord(run.inputSummary);
  if (metadata.repairPipeline === true || metadata.singleStage === true || metadata.foundation === true) return false;
  if (monitorToken) return metadata.batchMonitorToken === monitorToken;
  return true;
}
