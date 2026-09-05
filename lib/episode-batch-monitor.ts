import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GenerationRunStatus, Prisma } from "@prisma/client";
import { prisma, ensureSqlitePragmas } from "@/lib/prisma";
import { terminateWorkerProcessTree } from "@/lib/process-control";
import { summarizeFoundationRuns } from "@/lib/project-foundation-status";

export const BATCH_MONITOR_STAGE = "BATCH_MONITOR";
export const MAX_EPISODE_BATCH_CONCURRENCY = 3;

/**
 * CLI 与 API 都按最多三集并发调度；每一集内部的 E0→E5 仍然严格串行。
 * 单集 worker 会自己处理 SQLite busy 退避，监控器只负责维持三集窗口。
 */
export function defaultEpisodeBatchConcurrency(executionMode: string | null | undefined) {
  void executionMode;
  return MAX_EPISODE_BATCH_CONCURRENCY;
}

const ACTIVE_STATUSES = ["QUEUED", "RUNNING"] as const;
const TERMINAL_STATUSES = new Set<GenerationRunStatus>(["SUCCEEDED", "FAILED", "CANCELED"]);

export type EpisodeBatchMonitorStatus = GenerationRunStatus;

export type EpisodeBatchMonitorView = {
  id: string;
  status: EpisodeBatchMonitorStatus;
  message: string | null;
  error: string | null;
  processed: number | null;
  total: number | null;
  skippedEpisodes: number[];
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
};

export type EpisodeBatchMonitorOptions = {
  concurrency?: number;
  from?: number;
  to?: number | null;
  intervalMs?: number;
  maxRetries?: number;
  /** 兼容旧调用方；批量阶段最多只做一次整集重做，不自动返修质量问题。 */
  maxAutoRepairs?: number;
  requireNoMajors?: boolean;
};

/** 页面显示的最近一次批量监控记录。BATCH_MONITOR 不参与 P1/P2 或 E0–E5 岗位统计。 */
export async function getLatestEpisodeBatchMonitor(projectId: string): Promise<EpisodeBatchMonitorView | null> {
  const run = await prisma.pipelineRun.findFirst({
    where: { projectId, episodeId: null, stageCode: BATCH_MONITOR_STAGE },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, outputSummary: true, error: true, createdAt: true, startedAt: true, finishedAt: true }
  });
  return run ? toMonitorView(run) : null;
}

/** 页面按钮调用：创建一条监控记录并启动隐藏的 Node worker。 */
export async function queueEpisodeBatchMonitor(
  projectId: string,
  options: EpisodeBatchMonitorOptions = {}
) {
  await ensureSqlitePragmas();
  const from = Math.max(1, options.from ?? 1);
  const to = options.to ?? null;
  const intervalMs = Math.max(1_000, options.intervalMs ?? 5_000);
  // 批量初稿固定为“首次执行 + 一次整集重做”；不允许通过页面参数变成无限重试。
  const maxRetries = 1;
  // 强制批量只做首轮 E0–E5。返修必须等全剧初稿完成后，从单集页面单独发起。
  const maxAutoRepairs = 0;
  const requireNoMajors = options.requireNoMajors ?? true;

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true, title: true, executionMode: true, archivedAt: true }
  });
  if (!project) throw new Error("没有找到这个项目。");
  if (project.archivedAt) throw new Error(`项目「${project.title}」已归档，不能启动批量推进。`);

  const concurrency = Math.min(
    MAX_EPISODE_BATCH_CONCURRENCY,
    Math.max(1, options.concurrency ?? defaultEpisodeBatchConcurrency(project.executionMode))
  );

  const activeMonitor = await prisma.pipelineRun.findFirst({
    where: {
      projectId,
      episodeId: null,
      stageCode: BATCH_MONITOR_STAGE,
      status: { in: [...ACTIVE_STATUSES] }
    },
    select: { id: true }
  });
  if (activeMonitor) throw new Error("批量推进已经在运行中，请先等待完成或点击页面上的“停止监控”。");

  const foundationRuns = await prisma.pipelineRun.findMany({
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
  const foundationStatus = summarizeFoundationRuns(foundationRuns);
  if (foundationStatus.active) {
    throw new Error("P1/P2 仍在执行中，请等待全剧基础工程完成后再启动批量推进。 ");
  }
  if (!foundationStatus.ready) {
    const failed = foundationStatus.runs.find((run) => run.status === "FAILED" || run.status === "CANCELED");
    throw new Error(failed
      ? `${failed.stageCode} 最近一次没有完成：${failed.error ?? "执行失败"}。请先完成全剧基础工程。`
      : "请先完成同一批次的 P1 → P2 全剧基础工程，再启动批量推进。 ");
  }

  const provider = String(project.executionMode).toUpperCase() === "API" ? "API" : "CLI";

  const monitorToken = crypto.randomUUID();
  const input = {
    monitor: true,
    monitorToken,
    concurrency,
    from,
    to,
    intervalMs,
    maxRetries,
    maxAutoRepairs,
    requireNoMajors
  };
  const run = await prisma.pipelineRun.create({
    data: {
      projectId,
      episodeId: null,
      stageCode: BATCH_MONITOR_STAGE,
      roleName: "批量剧集推进监控",
      provider: provider === "API" ? "DeepSeek API" : "Codex CLI",
      model: "页面后台监控器",
      status: "QUEUED",
      inputSummary: JSON.stringify(input)
    },
    select: { id: true }
  });

  try {
    const child = launchMonitorWorker(projectId, monitorToken, {
      concurrency,
      from,
      to,
      intervalMs,
      maxRetries,
      requireNoMajors
    });
    if (!child.pid) throw new Error("后台监控器没有返回进程编号。");
    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: { inputSummary: JSON.stringify({ ...input, workerPid: child.pid }) }
    });
    return { monitorToken };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.pipelineRun.update({
      where: { id: run.id },
      data: { status: "FAILED", finishedAt: new Date(), error: `后台监控器启动失败：${message}` }
    });
    throw new Error("批量推进没有启动成功，请检查本机服务状态后重试。 ");
  }
}

/** 页面停止按钮调用；只停止监控器，不会强制中断已经启动的剧集任务。 */
export async function stopEpisodeBatchMonitor(projectId: string) {
  await ensureSqlitePragmas();
  const run = await prisma.pipelineRun.findFirst({
    where: {
      projectId,
      episodeId: null,
      stageCode: BATCH_MONITOR_STAGE,
      status: { in: [...ACTIVE_STATUSES] }
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, inputSummary: true }
  });
  if (!run) throw new Error("当前没有正在运行的批量推进监控。 ");

  const now = new Date();
  await prisma.pipelineRun.update({
    where: { id: run.id },
    data: {
      status: "CANCELED",
      finishedAt: now,
      error: "用户从页面停止批量推进监控。已启动的剧集任务会继续完成。"
    }
  });
  const workerPid = readWorkerPid(run.inputSummary);
  if (workerPid > 0) await terminateWorkerProcessTree(workerPid);
}

/** 监控脚本更新页面上的状态；按 token 精确锁定一次页面启动的监控。 */
export async function setEpisodeBatchMonitorStatus(
  monitorToken: string,
  status: GenerationRunStatus,
  details: {
    message?: string;
    error?: string;
    state?: string;
    processed?: number;
    total?: number;
    skippedEpisodes?: number[];
  } = {}
) {
  if (!monitorToken) return;
  const run = await prisma.pipelineRun.findFirst({
    where: { stageCode: BATCH_MONITOR_STAGE, inputSummary: { contains: monitorToken } },
    orderBy: { createdAt: "desc" },
    select: { id: true, status: true, startedAt: true, outputSummary: true }
  });
  if (!run) return;
  if (TERMINAL_STATUSES.has(run.status) && run.status === "CANCELED") return;

  const now = new Date();
  const startedAt = run.startedAt ?? (status === "RUNNING" ? now : null);
  const shouldWriteSummary = details.message !== undefined
    || details.state !== undefined
    || details.processed !== undefined
    || details.total !== undefined
    || details.skippedEpisodes !== undefined;
  const previousSummary = parseJsonRecord(run.outputSummary);
  const outputSummary = shouldWriteSummary
    ? JSON.stringify({
        ...previousSummary,
        ...(details.state !== undefined ? { state: details.state } : { state: previousSummary.state ?? (status === "SUCCEEDED" ? "READY" : status) }),
        ...(details.message !== undefined ? { message: details.message } : {}),
        ...(details.processed !== undefined ? { processed: details.processed } : {}),
        ...(details.total !== undefined ? { total: details.total } : {}),
        ...(details.skippedEpisodes !== undefined ? { skippedEpisodes: normalizeEpisodeNumbers(details.skippedEpisodes) } : {})
      })
    : undefined;
  const data: Prisma.PipelineRunUpdateInput = {
    status,
    ...(startedAt ? { startedAt } : {}),
    ...(TERMINAL_STATUSES.has(status)
      ? {
          finishedAt: now,
          durationMs: startedAt ? Math.max(0, now.getTime() - startedAt.getTime()) : null
        }
      : {}),
    ...(outputSummary !== undefined ? { outputSummary } : {}),
    ...(details.error !== undefined ? { error: details.error } : status === "RUNNING" ? { error: null } : {})
  };
  await prisma.pipelineRun.update({ where: { id: run.id }, data });
}

function toMonitorView(run: {
  id: string;
  status: GenerationRunStatus;
  outputSummary: string | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}): EpisodeBatchMonitorView {
  const summary = parseJsonRecord(run.outputSummary);
  return {
    id: run.id,
    status: run.status,
    message: typeof summary.message === "string" ? summary.message : null,
    error: run.error,
    processed: optionalCount(summary.processed),
    total: optionalCount(summary.total),
    skippedEpisodes: normalizeEpisodeNumbers(summary.skippedEpisodes),
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt
  };
}

function optionalCount(value: unknown) {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function normalizeEpisodeNumbers(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 1))].sort((a, b) => a - b);
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

function readWorkerPid(inputSummary: string | null | undefined) {
  const value = parseJsonRecord(inputSummary).workerPid;
  const pid = Number(value ?? 0);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function launchMonitorWorker(
  projectId: string,
  monitorToken: string,
  options: Required<Pick<EpisodeBatchMonitorOptions, "concurrency" | "from" | "intervalMs" | "maxRetries" | "requireNoMajors">> & { to: number | null }
) {
  const executable = process.execPath;
  const tsxDist = path.join(process.cwd(), "node_modules", "tsx", "dist");
  const tsxLoader = pathToFileURL(path.join(tsxDist, "loader.mjs")).href;
  const script = path.join(process.cwd(), "scripts", "run-project-episodes.ts");
  const args = [
    "--require", path.join(tsxDist, "preflight.cjs"),
    "--import", tsxLoader,
    script,
    projectId,
    "--monitor-token", monitorToken,
    "--concurrency", String(options.concurrency),
    "--from", String(options.from),
    "--interval", String(Math.round(options.intervalMs / 1_000)),
    "--max-retries", String(options.maxRetries)
  ];
  if (options.to !== null) args.push("--to", String(options.to));
  if (options.requireNoMajors) args.push("--require-no-majors");

  const child = spawn(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    detached: true,
    stdio: "ignore"
  });
  child.once("error", (detail) => {
    const message = detail instanceof Error ? detail.message : String(detail);
    void setEpisodeBatchMonitorStatus(monitorToken, "FAILED", {
      state: "ERROR",
      error: `后台监控器启动失败：${message}`,
      message: "页面后台监控器启动失败，请重试。"
    }).catch((error) => console.error("[episode-batch-monitor] failed to persist launch error", error));
  });
  child.once("exit", (code) => {
    if (code === 0) return;
    setTimeout(() => {
      void (async () => {
        const active = await prisma.pipelineRun.count({
          where: { stageCode: BATCH_MONITOR_STAGE, inputSummary: { contains: monitorToken }, status: { in: [...ACTIVE_STATUSES] } }
        });
        if (active > 0) {
          await setEpisodeBatchMonitorStatus(monitorToken, "FAILED", {
            state: "ERROR",
            error: `后台监控器意外结束（exit=${code ?? "null"}）。请查看页面状态后重试。`,
            message: "后台监控器意外结束，请重试。"
          });
        }
      })().catch((error) => console.error("[episode-batch-monitor] failed to inspect worker exit", error));
    }, 1_500);
  });
  child.unref();
  return child;
}
