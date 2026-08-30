/**
 * 解析全剧基础工程（P1 → P2）的可用状态。
 *
 * P1/P2 每次执行都会写入同一个 batchToken。页面不能只按岗位取“最近一条”，
 * 因为后续一次手动停止的失败重跑不应该覆盖之前已经成功生成、仍然可用的基础资料。
 */

export const FOUNDATION_STAGE_CODES = ["P1", "P2"] as const;
export type FoundationStageCode = (typeof FOUNDATION_STAGE_CODES)[number];

export type FoundationRunLike = {
  id?: string;
  stageCode: string;
  status: string;
  inputSummary?: string | null;
  outputSummary?: string | null;
  log?: string | null;
  error?: string | null;
  createdAt: Date;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  durationMs?: number | null;
  model?: string | null;
  provider?: string | null;
  roleName?: string | null;
};

export type FoundationStatus = {
  /** 当前可供后续剧集生产使用的 P1/P2 是否为同一批次的完整成功结果。 */
  ready: boolean;
  /** 是否存在正在执行的 P1/P2 尝试。 */
  active: boolean;
  /** 供页面显示的 P1/P2 记录：活动尝试优先，否则显示可用的成功批次。 */
  runs: FoundationRunLike[];
  latestSuccessfulBatchToken: string | null;
};

type FoundationAttempt = {
  token: string;
  runs: Map<FoundationStageCode, FoundationRunLike>;
  createdAt: number;
  lastActivityAt: number;
  singleStage: FoundationStageCode | null;
  baseFoundationBatchToken: string | null;
};

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING"]);

function parseSummary(value: string | null | undefined): Record<string, unknown> {
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

function batchTokenOf(run: FoundationRunLike): string | null {
  const value = parseSummary(run.inputSummary).batchToken;
  return typeof value === "string" && value.trim() ? value : null;
}

function runMeta(run: FoundationRunLike) {
  const summary = parseSummary(run.inputSummary);
  const singleStage = summary.singleStage === true && (run.stageCode === "P1" || run.stageCode === "P2")
    ? run.stageCode as FoundationStageCode
    : null;
  const baseToken = typeof summary.baseFoundationBatchToken === "string" && summary.baseFoundationBatchToken.trim()
    ? summary.baseFoundationBatchToken.trim()
    : null;
  return { singleStage, baseToken };
}

function runTime(run: FoundationRunLike): number {
  return (run.finishedAt ?? run.startedAt ?? run.createdAt).getTime();
}

function attemptRuns(attempt: FoundationAttempt): FoundationRunLike[] {
  return FOUNDATION_STAGE_CODES
    .map((stageCode) => attempt.runs.get(stageCode))
    .filter((run): run is FoundationRunLike => Boolean(run));
}

function isSuccessful(run: FoundationRunLike | undefined): run is FoundationRunLike {
  return Boolean(run && run.status === "SUCCEEDED");
}

function latestSuccessfulRun(
  attempts: readonly FoundationAttempt[],
  stageCode: FoundationStageCode,
  preferredToken?: string | null
): FoundationRunLike | null {
  if (preferredToken) {
    const preferred = attempts.find((attempt) => attempt.token === preferredToken)?.runs.get(stageCode);
    if (isSuccessful(preferred)) return preferred;
  }
  return [...attempts]
    .map((attempt) => attempt.runs.get(stageCode))
    .filter(isSuccessful)
    .sort((a, b) => runTime(b) - runTime(a))[0] ?? null;
}

function displayRunsForAttempt(
  attempt: FoundationAttempt,
  attempts: readonly FoundationAttempt[],
  attemptsByToken: ReadonlyMap<string, FoundationAttempt>
): FoundationRunLike[] {
  const direct = new Map(attempt.runs);
  if (attempt.singleStage) {
    const opposite = attempt.singleStage === "P1" ? "P2" : "P1";
    const preferred = attempt.baseFoundationBatchToken
      ? attemptsByToken.get(attempt.baseFoundationBatchToken)?.runs.get(opposite)
      : undefined;
    const fallback = isSuccessful(preferred)
      ? preferred
      // 兼容旧版单岗位记录没有写 baseFoundationBatchToken 的情况。
      : latestSuccessfulRun(attempts, opposite);
    if (!direct.has(opposite) && fallback) direct.set(opposite, fallback);
  }
  return FOUNDATION_STAGE_CODES
    .map((stageCode) => direct.get(stageCode))
    .filter((run): run is FoundationRunLike => Boolean(run));
}

function latestAttempt(attempts: readonly FoundationAttempt[]): FoundationAttempt | null {
  return [...attempts].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0] ?? null;
}

/**
 * 以批次为单位判断 P1/P2，而不是把不同重跑批次的 P1 和 P2 拼成“已完成”。
 * 只有失败/取消且没有成功输出的后续尝试，不会让已有成功基础资料回退成未完成。
 */
export function summarizeFoundationRuns(runs: readonly FoundationRunLike[]): FoundationStatus {
  const attemptsByToken = new Map<string, FoundationAttempt>();

  for (const run of runs) {
    if (!FOUNDATION_STAGE_CODES.includes(run.stageCode as FoundationStageCode)) continue;
    const token = batchTokenOf(run);
    if (!token) continue;
    const stageCode = run.stageCode as FoundationStageCode;
    const current = attemptsByToken.get(token) ?? {
      token,
      runs: new Map<FoundationStageCode, FoundationRunLike>(),
      createdAt: run.createdAt.getTime(),
      lastActivityAt: runTime(run),
      singleStage: null,
      baseFoundationBatchToken: null
    };
    const previous = current.runs.get(stageCode);
    // 同一批次极少会出现同一岗位多条记录；保留时间更新的一条，避免旧状态覆盖新状态。
    if (!previous || runTime(run) >= runTime(previous)) current.runs.set(stageCode, run);
    current.createdAt = Math.min(current.createdAt, run.createdAt.getTime());
    current.lastActivityAt = Math.max(current.lastActivityAt, runTime(run));
    const meta = runMeta(run);
    if (meta.singleStage) current.singleStage = meta.singleStage;
    if (meta.baseToken) current.baseFoundationBatchToken = meta.baseToken;
    attemptsByToken.set(token, current);
  }

  const attempts = [...attemptsByToken.values()];
  const activeAttempts = attempts.filter((attempt) => attemptRuns(attempt).some((run) => ACTIVE_STATUSES.has(run.status)));
  const activeAttempt = latestAttempt(activeAttempts);
  const active = Boolean(activeAttempt);

  const completedAttempts = attempts.filter((attempt) => FOUNDATION_STAGE_CODES.every((stageCode) => (
    attempt.runs.get(stageCode)?.status === "SUCCEEDED"
  )));
  const completedAttempt = latestAttempt(completedAttempts);

  // 单岗位重跑是“沿用另一岗位的成功结果 + 更新当前岗位”，不能因为 batchToken
  // 不同就把已成功的 P1/P2 拆成两个未完成状态。新代码会写明确的基准 token；
  // 旧记录则仅在 singleStage=true 时兼容性地沿用最近成功的另一岗位。
  const singleStageCandidates = attempts
    .filter((attempt) => Boolean(attempt.singleStage))
    .map((attempt) => {
      const stage = attempt.singleStage!;
      const opposite = stage === "P1" ? "P2" : "P1";
      const current = attempt.runs.get(stage);
      const base = latestSuccessfulRun(attempts, opposite, attempt.baseFoundationBatchToken);
      return isSuccessful(current) && base
        ? { attempt, current, base, completedAt: Math.max(runTime(current), runTime(base)) }
        : null;
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((a, b) => b.completedAt - a.completedAt);
  const singleStageCandidate = singleStageCandidates[0] ?? null;

  const fullCandidate = completedAttempt
    ? { attempt: completedAttempt, completedAt: completedAttempt.lastActivityAt }
    : null;
  const readyCandidate = [fullCandidate, singleStageCandidate]
    .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
    .sort((a, b) => b.completedAt - a.completedAt)[0] ?? null;

  const latestOverall = latestAttempt(attempts);
  const latestAttemptHasSuccessfulOutput = latestOverall
    ? attemptRuns(latestOverall).some((run) => run.status === "SUCCEEDED" || Boolean(run.outputSummary))
    : false;
  const latestIsSingleStageFailure = Boolean(latestOverall?.singleStage)
    && Boolean(latestOverall && attemptRuns(latestOverall).some((run) => run.status === "FAILED" || run.status === "CANCELED"));
  // 活动批次永远优先显示；活动结束后，单岗位失败显示失败岗位并保留另一岗位，
  // 只有“没有产出”的整批停止才回到此前可用的成功批次。
  const newerIncompleteAttempt = Boolean(
    readyCandidate &&
    latestOverall &&
    latestOverall.token !== readyCandidate.attempt.token &&
    latestOverall.createdAt > readyCandidate.completedAt &&
    latestAttemptHasSuccessfulOutput
  );
  const ready = Boolean(readyCandidate) && !active && !newerIncompleteAttempt && !latestIsSingleStageFailure;

  let displayAttempt = activeAttempt;
  if (!displayAttempt) {
    if (latestIsSingleStageFailure || newerIncompleteAttempt) displayAttempt = latestOverall;
    else if (readyCandidate) displayAttempt = readyCandidate.attempt;
    else displayAttempt = latestOverall;
  }
  const displayRuns = displayAttempt
    ? displayRunsForAttempt(displayAttempt, attempts, attemptsByToken)
    : [];
  const successfulToken = readyCandidate?.attempt.token ?? null;
  return {
    ready,
    active,
    runs: displayRuns,
    latestSuccessfulBatchToken: ready ? successfulToken : null
  };
}
