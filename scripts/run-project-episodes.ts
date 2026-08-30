import { queueEpisodePipeline } from "@/lib/episode-pipeline";
import {
  countInitialBatchAttempts,
  findLatestBatchCapacityFailure,
  hasCompleteInitialBatch,
  INITIAL_BATCH_MAX_ATTEMPTS,
  shouldRetryInitialBatch,
  shouldSkipInitialBatch,
  summarizeEpisodePipeline,
  type EpisodePipelineRunLike,
  type EpisodePipelineSummary,
  type EpisodeIssueLike
} from "@/lib/episode-batch";
import { BATCH_MONITOR_STAGE, setEpisodeBatchMonitorStatus } from "@/lib/episode-batch-monitor";
import { ensureSqlitePragmas, prisma } from "@/lib/prisma";
import { summarizeFoundationRuns } from "@/lib/project-foundation-status";
import { formatExecutionErrorForUser } from "@/lib/execution-errors";

type MonitorOptions = {
  projectId: string;
  concurrency: number;
  from: number;
  to: number | null;
  intervalMs: number;
  maxRetries: number;
  maxAutoRepairs: number;
  requireNoMajors: boolean;
  monitorToken: string | null;
};

type EpisodeRow = {
  id: string;
  number: number;
  title: string | null;
};

type EpisodeSnapshot = EpisodeRow & {
  runs: EpisodePipelineRunLike[];
  issues: EpisodeIssueLike[];
  summary: EpisodePipelineSummary;
  /** 当前这条批量监控器已经发起过的整集初稿次数。 */
  initialBatchAttempts: number;
  /** 历史上已有完整初稿；返修失败不能让批量监控器重复生产整集。 */
  initialDraftComplete: boolean;
};

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING"]);

void main().catch(async (error) => {
  const monitorToken = readMonitorToken(process.argv.slice(2));
  if (monitorToken) {
    try {
      const rawMessage = error instanceof Error ? error.message : String(error);
      const source = /(?:Codex CLI|CLI执行|usage limit|codex\.cmd)/i.test(rawMessage) ? "cli"
        : /(?:DeepSeek|API|HTTP\s*402)/i.test(rawMessage) ? "api"
          : "unknown";
      const isCapacityPause = /批量已暂停/.test(rawMessage);
      const userMessage = isCapacityPause
        ? rawMessage
        : formatExecutionErrorForUser(rawMessage, { source });
      await setEpisodeBatchMonitorStatus(monitorToken, "FAILED", {
        state: isCapacityPause ? "PAUSED" : "ERROR",
        error: userMessage,
        message: isCapacityPause
          ? "批量推进已暂停：检测到额度或频率限制，未继续启动新的剧集任务。"
          : "批量推进已暂停，请查看下方原因；未继续启动新的剧集任务。"
      });
    } catch (persistError) {
      console.error(`[批量监控] 无法写入页面状态：${persistError instanceof Error ? persistError.message : String(persistError)}`);
    }
  }
  console.error(`[批量监控] ${error instanceof Error ? error.message : String(error)}`);
  await prisma.$disconnect();
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await ensureSqlitePragmas();

  const project = await prisma.project.findUnique({
    where: { id: options.projectId },
    select: { id: true, title: true, executionMode: true, archivedAt: true }
  });
  if (!project) throw new Error(`找不到项目 ${options.projectId}。请使用项目页面 URL 中的项目 ID。`);
  if (project.archivedAt) throw new Error(`项目「${project.title}」已归档，不能启动批量生产。`);

  console.log(`[批量监控] 项目：${project.title}（${project.id}）`);
  const provider = String(project.executionMode).toUpperCase() === "API" ? "API" : "CLI";
  const concurrencyDescription = provider === "CLI" ? "CLI 单集串行" : `API 最多 ${options.concurrency} 集并发`;
  if (options.monitorToken) {
    await setEpisodeBatchMonitorStatus(options.monitorToken, "RUNNING", {
      state: "RUNNING",
      message: `批量推进监控已启动：${concurrencyDescription}；普通执行失败整集重做 1 次，仍失败就跳过；遇到额度不足或频率限制会立即暂停。`
    });
  }
  console.log(`[批量监控] 执行方式：${provider}`);
  console.log(`[批量监控] 策略：只生成初次 E0–E5；${concurrencyDescription}；单集执行失败时整集重做 1 次，仍失败就跳过并继续下一集；质量问题留到全剧初稿完成后统一返修。`);
  if (options.requireNoMajors) console.log("[批量监控] 质量门只做统计：BLOCKER 与 MAJOR 会记录，但不会触发自动返修或阻塞后续集。");
  else console.log("[批量监控] 质量门只做统计：BLOCKER 会记录，MAJOR 也不会触发自动返修。");

  const allEpisodes = await prisma.episode.findMany({
    where: { projectId: project.id, number: { gte: 1 } },
    orderBy: { number: "asc" },
    select: { id: true, number: true, title: true }
  });
  const episodes = allEpisodes.filter((episode) => episode.number >= options.from && (options.to === null || episode.number <= options.to));
  if (!episodes.length) throw new Error("没有找到符合范围的正式剧集；第 0 集是辅助资料，不进入 E0–E5。 ");

  await waitForFoundation(project.id, options.intervalMs);
  console.log("[批量监控] P1/P2 已完成，开始监控正式剧集。按 Ctrl+C 只退出监控器，不会停止已启动的后台任务。 ");

  const printed = new Map<string, string>();
  const launching = new Set<string>();
  const launchAttemptCounts = new Map<string, number>();
  const skippedEpisodes = options.monitorToken
    ? await loadSkippedEpisodes(options.monitorToken)
    : new Set<number>();
  let interrupted = false;
  let lastMonitorMessage = "";
  process.once("SIGINT", () => {
    interrupted = true;
    console.log("\n[批量监控] 已收到停止监控指令；后台剧集任务继续运行。 ");
  });

  while (!interrupted) {
    if (options.monitorToken && await monitorWasCanceled(options.monitorToken)) {
      interrupted = true;
      break;
    }
    const snapshot = await loadSnapshot(project.id, allEpisodes, options.requireNoMajors, options.monitorToken);
    const byId = new Map(snapshot.map((episode) => [episode.id, episode]));
    const selected = episodes.map((episode) => byId.get(episode.id)!).filter(Boolean);
    const activeAll = countActiveEpisodes(snapshot);

    printChanges(selected, printed);

    await scheduleWindow(project.id, selected, activeAll, options, launching, skippedEpisodes, launchAttemptCounts, provider);

    const refreshed = await loadSnapshot(project.id, allEpisodes, options.requireNoMajors, options.monitorToken);
    const refreshedById = new Map(refreshed.map((episode) => [episode.id, episode]));
    const refreshedSelected = episodes.map((episode) => refreshedById.get(episode.id)!).filter(Boolean);
    const activeAfterRefresh = countActiveEpisodes(refreshed);
    if (options.monitorToken) {
      const readyCount = refreshedSelected.filter((episode) => episode.summary.ready).length;
      const initialCompleteCount = refreshedSelected.filter(isInitialProductionComplete).length;
      const skippedCount = refreshedSelected.filter((episode) => skippedEpisodes.has(episode.number)).length;
      const openIssueCount = refreshedSelected.reduce((sum, episode) => sum + episode.issues.filter((issue) => issue.status === "OPEN").length, 0);
      const skippedMessage = skippedCount ? `；已跳过 ${skippedCount} 集（整集重做 1 次仍失败）` : "";
      const monitorMessage = `初稿完成 ${initialCompleteCount}/${refreshedSelected.length} 集${skippedMessage}；质量门通过 ${readyCount} 集；当前 ${activeAfterRefresh} 集执行中；待返修问题 ${openIssueCount} 条。`;
      if (monitorMessage !== lastMonitorMessage) {
        lastMonitorMessage = monitorMessage;
        await setEpisodeBatchMonitorStatus(options.monitorToken, "RUNNING", {
          state: "RUNNING",
          message: monitorMessage,
          processed: initialCompleteCount + skippedCount,
          total: refreshedSelected.length,
          skippedEpisodes: [...skippedEpisodes]
        });
      }
    }

    const allInitialComplete = refreshedSelected.length > 0
      && activeAfterRefresh === 0
      && refreshedSelected.every((episode) => isInitialProductionComplete(episode) || skippedEpisodes.has(episode.number));
    if (allInitialComplete) {
      const initialCompleteCount = refreshedSelected.filter(isInitialProductionComplete).length;
      const skippedCount = refreshedSelected.filter((episode) => skippedEpisodes.has(episode.number)).length;
      const qualityReadyCount = refreshedSelected.filter((episode) => episode.summary.ready).length;
      const openIssueCount = refreshedSelected.reduce((sum, episode) => sum + episode.issues.filter((issue) => issue.status === "OPEN").length, 0);
      const skippedText = skippedCount
        ? `；${skippedCount} 集（${formatEpisodeNumbers([...skippedEpisodes])}）重做 1 次仍失败，已跳过，后续可在单集页面单独处理`
        : "";
      console.log(`[批量监控] 初稿批量处理完成：${initialCompleteCount} 集完成 E0–E5${skippedText}；质量门通过 ${qualityReadyCount}/${refreshedSelected.length} 集，待返修问题 ${openIssueCount} 条。`);
      if (options.monitorToken) {
        await setEpisodeBatchMonitorStatus(options.monitorToken, "SUCCEEDED", {
          state: "READY",
          message: `第 ${episodes[0].number}–${episodes[episodes.length - 1].number} 集初稿批量处理完成：${initialCompleteCount} 集完成 E0–E5${skippedText}；质量门通过 ${qualityReadyCount}/${refreshedSelected.length} 集，待返修问题 ${openIssueCount} 条。批量阶段未自动返修，请完成后统一进入单集处理。`,
          processed: refreshedSelected.length,
          total: refreshedSelected.length,
          skippedEpisodes: [...skippedEpisodes]
        });
      }
      break;
    }

    await delay(options.intervalMs);
  }

  if (interrupted && options.monitorToken) {
    await setEpisodeBatchMonitorStatus(options.monitorToken, "CANCELED", {
      state: "CANCELED",
      message: "批量推进监控已停止；已经启动的剧集任务会继续完成。",
      skippedEpisodes: [...skippedEpisodes]
    });
  }
  await prisma.$disconnect();
}

async function monitorWasCanceled(monitorToken: string) {
  const run = await prisma.pipelineRun.findFirst({
    where: { stageCode: BATCH_MONITOR_STAGE, inputSummary: { contains: monitorToken } },
    orderBy: { createdAt: "desc" },
    select: { status: true }
  });
  return run?.status === "CANCELED";
}

async function loadSkippedEpisodes(monitorToken: string) {
  const run = await prisma.pipelineRun.findFirst({
    where: { stageCode: BATCH_MONITOR_STAGE, inputSummary: { contains: monitorToken } },
    orderBy: { createdAt: "desc" },
    select: { outputSummary: true }
  });
  const values = parseJsonRecord(run?.outputSummary).skippedEpisodes;
  if (!Array.isArray(values)) return new Set<number>();
  return new Set(values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 1));
}

async function waitForFoundation(projectId: string, intervalMs: number) {
  let lastMessage = "";
  while (true) {
    const runs = await prisma.pipelineRun.findMany({
      where: { projectId, episodeId: null, stageCode: { in: ["P1", "P2"] } },
      orderBy: { createdAt: "asc" },
      select: {
        stageCode: true,
        status: true,
        inputSummary: true,
        outputSummary: true,
        error: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        durationMs: true,
        model: true,
        provider: true,
        roleName: true
      }
    });
    const foundation = summarizeFoundationRuns(runs);
    if (foundation.ready) return;
    const active = foundation.runs.filter((run) => ACTIVE_STATUSES.has(run.status)).map((run) => run.stageCode);
    if (active.length) {
      const message = `等待 ${active.join("、")} 完成后再启动正式剧集。`;
      if (message !== lastMessage) {
        console.log(`[批量监控] ${message}`);
        lastMessage = message;
      }
      await delay(intervalMs);
      continue;
    }
    const failed = foundation.runs.find((run) => run.status === "FAILED" || run.status === "CANCELED");
    if (failed) throw new Error(`${failed.stageCode} 最近一次未完成：${failed.error ?? "执行失败"}。请先在全剧工作台修复 P1/P2。`);
    throw new Error("尚未找到同一批次的 P1 → P2 完整成功记录。请先在全剧工作台完成全剧基础工程，再启动批量监控。 ");
  }
}

async function loadSnapshot(
  projectId: string,
  episodes: readonly EpisodeRow[],
  requireNoMajors: boolean,
  monitorToken?: string | null
): Promise<EpisodeSnapshot[]> {
  const ids = episodes.map((episode) => episode.id);
  const [runs, issues] = await Promise.all([
    prisma.pipelineRun.findMany({
      where: { projectId, episodeId: { in: ids } },
      orderBy: { createdAt: "asc" },
      select: { episodeId: true, stageCode: true, status: true, inputSummary: true, outputSummary: true, error: true, createdAt: true, finishedAt: true }
    }),
    prisma.workflowIssue.findMany({
      where: { projectId, episodeId: { in: ids } },
      select: { episodeId: true, severity: true, status: true, coordinate: true, code: true, ownerRole: true }
    })
  ]);
  const runsByEpisode = new Map<string, EpisodePipelineRunLike[]>();
  const issuesByEpisode = new Map<string, EpisodeIssueLike[]>();
  for (const run of runs) {
    if (!run.episodeId) continue;
    const list = runsByEpisode.get(run.episodeId) ?? [];
    list.push(run);
    runsByEpisode.set(run.episodeId, list);
  }
  for (const issue of issues) {
    const list = issuesByEpisode.get(issue.episodeId) ?? [];
    list.push(issue);
    issuesByEpisode.set(issue.episodeId, list);
  }
  return episodes.map((episode) => {
    const episodeRuns = runsByEpisode.get(episode.id) ?? [];
    const episodeIssues = issuesByEpisode.get(episode.id) ?? [];
    return {
      ...episode,
      runs: episodeRuns,
      issues: episodeIssues,
      summary: summarizeEpisodePipeline(episodeRuns, episodeIssues, { requireNoMajors }),
      initialBatchAttempts: countInitialBatchAttempts(episodeRuns, monitorToken),
      initialDraftComplete: hasCompleteInitialBatch(episodeRuns)
    };
  });
}

/** 批量阶段只判断 E0–E5 是否已经完整执行，不把质量问题当成排队闸门。 */
function isInitialProductionComplete(episode: EpisodeSnapshot) {
  return episode.initialDraftComplete && episode.summary.activeCount === 0;
}

async function scheduleWindow(
  projectId: string,
  episodes: readonly EpisodeSnapshot[],
  activeAll: number,
  options: MonitorOptions,
  launching: Set<string>,
  skippedEpisodes: Set<number>,
  launchAttemptCounts: Map<string, number>,
  provider: "CLI" | "API"
) {
  let slots = Math.max(0, options.concurrency - activeAll);
  if (!slots) return;

  for (const episode of episodes) {
    if (skippedEpisodes.has(episode.number) || isInitialProductionComplete(episode) || episode.summary.activeCount > 0) continue;

    const previousAttempts = Math.max(
      episode.initialBatchAttempts,
      launchAttemptCounts.get(episode.id) ?? 0
    );
    if (hasCapacityFailure(episode, options.monitorToken)) {
      throw new Error(formatCapacityPauseMessage(episode, provider, options.monitorToken));
    }
    const maxAttempts = Math.min(INITIAL_BATCH_MAX_ATTEMPTS, Math.max(1, options.maxRetries + 1));
    if (shouldRetryInitialBatch(previousAttempts, maxAttempts)) {
      const attempt = previousAttempts + 1;
      launchAttemptCounts.set(episode.id, attempt);
      const queued = await queueEpisode(projectId, episode, options, launching, attempt);
      slots -= 1;
      if (!queued && shouldSkipInitialBatch(attempt, maxAttempts)) {
        skippedEpisodes.add(episode.number);
        console.log(`[批量监控] 第 ${episode.number} 集第 ${attempt} 次整集执行未能启动，已跳过；不会阻塞后续剧集。`);
      }
      if (slots <= 0) break;
      continue;
    }

    skippedEpisodes.add(episode.number);
    console.log(`[批量监控] 第 ${episode.number} 集 E0–E5 已失败 ${previousAttempts} 次，已跳过；不会阻塞后续剧集。`);
  }
}

function countActiveEpisodes(episodes: readonly EpisodeSnapshot[]) {
  return episodes.filter((episode) => episode.summary.activeCount > 0).length;
}

async function queueEpisode(
  projectId: string,
  episode: EpisodeSnapshot,
  options: MonitorOptions,
  launching: Set<string>,
  attempt: number
): Promise<boolean> {
  if (launching.has(episode.id)) return false;
  launching.add(episode.id);
  try {
    const action = attempt > 1 ? `重做第 ${attempt} 次` : "启动";
    console.log(`[批量监控] ${action}第 ${episode.number} 集 E0–E5……`);
    const result = await queueEpisodePipeline(projectId, episode.id, {
      batchMonitorToken: options.monitorToken,
      batchAttempt: attempt
    });
    console.log(`[批量监控] 第 ${episode.number} 集已进入后台队列（batchToken=${result.batchToken}）。`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[批量监控] 第 ${episode.number} 集第 ${attempt} 次整集执行未能进入队列：${message}`);
    return false;
  } finally {
    launching.delete(episode.id);
  }
}

function formatEpisodeNumbers(numbers: readonly number[]) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (sorted.length <= 12) return sorted.map((number) => `第${number}集`).join("、");
  return `${sorted.slice(0, 12).map((number) => `第${number}集`).join("、")}等${sorted.length}集`;
}

function hasCapacityFailure(episode: EpisodeSnapshot, monitorToken: string | null) {
  return Boolean(findLatestBatchCapacityFailure(episode.runs, monitorToken));
}

function formatCapacityPauseMessage(episode: EpisodeSnapshot, provider: "CLI" | "API", monitorToken: string | null) {
  const failedRun = findLatestBatchCapacityFailure(episode.runs, monitorToken);
  const raw = failedRun?.error ?? null;
  const source = provider === "API" ? "api" : "cli";
  const detail = formatExecutionErrorForUser(raw, { source });
  return `第 ${episode.number} 集检测到${detail}批量已暂停，未立即重复重跑，也不会继续消耗额度；额度恢复后请点击“继续生成未完成初稿”。`;
}

function printChanges(episodes: readonly EpisodeSnapshot[], printed: Map<string, string>) {
  let notStarted = 0;
  for (const episode of episodes) {
    const summary = episode.summary;
    const signature = [summary.state, summary.initialComplete, summary.activeCount, summary.openBlockers, summary.openMajors, summary.openMinors, summary.missingStages.join(","), summary.failedStages.join(",")].join("|");
    if (summary.state === "NOT_STARTED" && !printed.has(episode.id)) {
      notStarted += 1;
      continue;
    }
    if (printed.get(episode.id) === signature) continue;
    printed.set(episode.id, signature);
    const title = episode.title ? `「${episode.title}」` : "";
    const quality = `BLOCKER ${summary.openBlockers} / MAJOR ${summary.openMajors} / MINOR ${summary.openMinors}`;
    console.log(`[批量监控] 第 ${episode.number} 集${title}：${summary.state}，${quality}。${summary.reason}`);
  }
  const notStartedKey = "__notStarted";
  if (notStarted > 0 && printed.get(notStartedKey) !== String(notStarted)) {
    printed.set(notStartedKey, String(notStarted));
    console.log(`[批量监控] 另有 ${notStarted} 集尚未启动；监控器只会按并发窗口逐集补入。`);
  }
}

function parseArgs(args: string[]): MonitorOptions {
  let projectId = "";
  // 独立命令默认按 CLI 的安全策略串行；页面启动时会按项目执行方式传入 API 的并发值。
  let concurrency = 1;
  let from = 1;
  let to: number | null = null;
  let intervalMs = 5_000;
  let maxRetries = 1;
  // 批量阶段只产出初稿；返修必须在全剧初稿完成后从单集页面手动发起。
  let maxAutoRepairs = 0;
  let requireNoMajors = true;
  let monitorToken: string | null = null;
  const positional: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--project" || arg === "--project-id") projectId = requireValue(args, ++index, arg);
    else if (arg === "--concurrency") concurrency = parsePositiveInt(requireValue(args, ++index, arg), arg);
    else if (arg === "--from") from = parsePositiveInt(requireValue(args, ++index, arg), arg);
    else if (arg === "--to") to = parsePositiveInt(requireValue(args, ++index, arg), arg);
    else if (arg === "--interval") intervalMs = parsePositiveInt(requireValue(args, ++index, arg), arg) * 1_000;
    else if (arg === "--max-retries") maxRetries = parseNonNegativeInt(requireValue(args, ++index, arg), arg);
    else if (arg === "--max-auto-repairs") {
      const requested = parseNonNegativeInt(requireValue(args, ++index, arg), arg);
      if (requested > 0) throw new Error("批量阶段不自动返修；请完成全剧初稿后从单集页面手动处理问题。 ");
      maxAutoRepairs = 0;
    }
    else if (arg === "--require-no-majors") requireNoMajors = true;
    else if (arg === "--allow-majors") requireNoMajors = false;
    else if (arg === "--monitor-token") monitorToken = requireValue(args, ++index, arg);
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith("-")) positional.push(arg);
    else throw new Error(`未知参数 ${arg}。使用 --help 查看用法。`);
  }
  if (!projectId) projectId = positional[0] ?? "";
  if (!projectId) {
    printUsage();
    throw new Error("缺少项目 ID。 ");
  }
  if (concurrency > 3) throw new Error("并发上限是 3；这是 SQLite 与 CLI/API 执行的稳定上限。 ");
  if (to !== null && to < from) throw new Error("--to 不能小于 --from。 ");
  return { projectId, concurrency, from, to, intervalMs, maxRetries, maxAutoRepairs, requireNoMajors, monitorToken };
}

function readMonitorToken(args: string[]) {
  const index = args.indexOf("--monitor-token");
  return index >= 0 && args[index + 1] ? args[index + 1] : null;
}

function requireValue(args: string[], index: number, flag: string) {
  const value = args[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} 后面需要一个值。`);
  return value;
}

function parsePositiveInt(value: string, flag: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${flag} 必须是正整数。`);
  return parsed;
}

function parseNonNegativeInt(value: string, flag: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${flag} 必须是非负整数。`);
  return parsed;
}

function printUsage() {
  console.log(`用法：npm.cmd run episodes:run -- <projectId> [选项]

选项：
  --concurrency 1       同时执行的剧集数，最大 3（CLI 默认串行）
  --from 1              起始集数，默认 1
  --to 80               结束集数，默认项目最后一集
  --interval 5          状态轮询间隔（秒）
  --max-retries 1       执行失败后的自动重做次数，页面固定为 1（最多 1 次）
  --require-no-majors   MAJOR 也必须清零才允许继续（默认开启）
  --allow-majors        允许保留 MAJOR 后继续，仅建议人工调试使用

监控器会等待 P1/P2 成功；批量阶段只生成所有正式集的 E0–E5 初稿，不自动返修。
`);
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
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
