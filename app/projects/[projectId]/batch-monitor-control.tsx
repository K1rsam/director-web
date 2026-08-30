"use client";

import { useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { startEpisodeBatchMonitorAction, stopEpisodeBatchMonitorAction } from "@/app/actions";

type MonitorView = {
  status: string;
  message: string | null;
  error: string | null;
  processed: number | null;
  total: number | null;
  legacyAutoRepair: boolean;
  skippedEpisodes: number[];
};

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING"]);

export function BatchMonitorControl({
  projectId,
  foundationReady,
  foundationActive,
  executionMode,
  monitor
}: {
  projectId: string;
  foundationReady: boolean;
  foundationActive: boolean;
  executionMode: string;
  monitor: MonitorView | null;
}) {
  const router = useRouter();
  const active = Boolean(monitor && ACTIVE_STATUSES.has(monitor.status));
  const providerLabel = String(executionMode).toUpperCase() === "API" ? "API" : "CLI";
  const concurrencyLabel = providerLabel === "CLI" ? "CLI 单集串行" : "API 最多 3 集并发";

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [active, router]);

  const statusLabel = monitorStatusLabel(monitor, foundationReady, foundationActive);
  const statusClass = monitorStatusClass(monitor);
  const canStart = foundationReady && !foundationActive && !active;
  const pausedByQuota = Boolean(monitor && monitor.status === "FAILED" && isCapacityPause(monitor));
  const compactDescription = foundationActive
    ? "全剧基础工程完成后，批量推进会自动进入未完成剧集。"
    : active
      ? `正在按${providerLabel === "CLI" ? "串行" : "最多 3 集并发"}推进未完成剧集；完成一集后自动启动下一集。`
      : monitor?.status === "FAILED" || monitor?.status === "CANCELED"
        ? pausedByQuota
          ? "检测到额度或频率限制，批量推进已暂停；额度恢复后可继续，不会重复消耗额度。"
          : "批量推进已暂停；请先查看暂停原因，再决定是否继续，不会在批量阶段自动返修。"
        : monitor?.status === "SUCCEEDED"
          ? "全剧初稿推进已结束；需要修改的内容请进入对应单集处理。"
          : foundationReady
            ? "可从页面启动全剧初稿推进；批量阶段只生成 E0–E5，不自动返修。"
            : "先完成 P1–P2，再从页面启动全剧初稿推进。";
  const actionLabel = foundationActive
    ? "等待 P1–P2 完成"
    : !foundationReady
    ? "完成 P1–P2 后可启动"
    : monitor?.status === "FAILED"
      ? isCapacityPause(monitor) ? `额度恢复后继续推进（${providerLabel}）` : `继续批量推进（${providerLabel}）`
      : monitor?.status === "CANCELED"
        ? `继续自动推进全部剧集（${providerLabel}）`
        : monitor?.status === "SUCCEEDED"
          ? monitor.skippedEpisodes.length
            ? `初稿已完成，${monitor.skippedEpisodes.length} 集待单独处理`
            : "全剧初稿已完成"
          : `开始自动推进全部剧集（${providerLabel}）`;

  const legacyMessage = monitor?.message ?? monitor?.error;
  const currentMessage = monitor?.message?.trim() || null;
  const currentError = monitor?.error?.trim() && monitor.error.trim() !== currentMessage ? monitor.error.trim() : null;
  const hasMonitorNotice = Boolean(currentMessage || currentError || monitor?.legacyAutoRepair || monitor?.skippedEpisodes.length);

  return (
    <section className="batchMonitorCard" id="batch-episode-monitor" aria-labelledby="batch-monitor-title">
      <div className="batchMonitorCopy">
        <div className="batchMonitorHeading">
          <div>
            <span className="batchMonitorEyebrow">EPISODE AUTOMATION</span>
            <h2 id="batch-monitor-title">批量剧集推进</h2>
          </div>
        </div>
        {!hasMonitorNotice ? <p className="batchMonitorSummary">{compactDescription}</p> : null}
        {monitor?.legacyAutoRepair ? (
          <>
            <p className="batchMonitorMessage batchMonitorLegacyNotice">
              这是旧版批量记录：当时曾尝试自动返修并因此暂停。当前流程已取消批量自动返修；重新启动后只生成未完成初稿，全部初稿完成后再单独处理返修。
            </p>
            {legacyMessage ? <p className="batchMonitorMessage batchMonitorLegacyReason">停止原因：{legacyMessage}</p> : null}
          </>
        ) : (
          <>
            {currentMessage ? <p className={`batchMonitorMessage ${statusClass}`}>{currentMessage}</p> : null}
            {currentError ? <p className="batchMonitorMessage bad">{currentError}</p> : null}
            {monitor?.skippedEpisodes.length ? (
              <p className="batchMonitorMessage batchMonitorSkippedNotice">
                已跳过 {monitor.skippedEpisodes.length} 集：{formatSkippedEpisodes(monitor.skippedEpisodes)}。这些集不会阻塞批量推进，可稍后进入单集页面单独重做。
              </p>
            ) : null}
          </>
        )}
        <details className="batchMonitorDetails">
          <summary>查看执行规则与历史说明</summary>
          <div className="batchMonitorDetailsBody">
            <p>从页面启动后台监控（当前使用 {providerLabel}）：先完成所有正式集的 E0–E5 初稿；{concurrencyLabel}，避免 CLI 同时读取多份大上下文并触发额度窗口限制。普通执行失败会整集重做 1 次，仍失败就自动跳过并继续后续剧集；如果检测到额度不足或频率限制，批量会立即暂停，不会继续消耗额度。BLOCKER、MAJOR 和 MINOR 只记录，不在批量阶段自动返修；全部初稿完成后，再到各集的“问题与返修”中统一处理。</p>
            <div className="batchMonitorMeta" aria-label="批量推进规则">
              <span>页面后台运行</span>
              <span>{providerLabel} 执行</span>
              <span>{concurrencyLabel}</span>
              <span>普通失败整集重做 1 次</span>
              <span>重做仍失败自动跳过</span>
              <span>额度不足立即暂停</span>
              <span>只生成首轮初稿</span>
              <span>问题完成后统一返修</span>
            </div>
          </div>
        </details>
      </div>

      <div className="batchMonitorActions">
        <span className={`batchMonitorStatus batchMonitorStatusInline ${statusClass}`}><i aria-hidden="true" />{statusLabel}</span>
        {active ? (
          <form action={stopEpisodeBatchMonitorAction} onSubmit={(event) => {
            if (!window.confirm("确定停止页面上的批量推进监控吗？已经启动的剧集任务会继续完成。")) event.preventDefault();
          }}>
            <input name="projectId" type="hidden" value={projectId} />
            <StopBatchMonitorButton />
          </form>
        ) : (
          <form action={startEpisodeBatchMonitorAction}>
            <input name="projectId" type="hidden" value={projectId} />
            <StartBatchMonitorButton disabled={!canStart || monitor?.status === "SUCCEEDED"} label={actionLabel} />
          </form>
        )}
      </div>
    </section>
  );
}

function StartBatchMonitorButton({ disabled, label }: { disabled: boolean; label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="batchMonitorButton primary" disabled={disabled || pending}>
      {pending ? "启动中…" : label}
      {!pending && !disabled ? <span aria-hidden="true">→</span> : null}
    </button>
  );
}

function StopBatchMonitorButton() {
  const { pending } = useFormStatus();
  return <button type="submit" className="batchMonitorButton stop" disabled={pending}>{pending ? "停止中…" : "停止监控"}</button>;
}

function monitorStatusLabel(monitor: MonitorView | null, foundationReady: boolean, foundationActive: boolean) {
  if (!monitor) {
    if (foundationActive) return "P1–P2 执行中";
    if (!foundationReady) return "等待 P1–P2";
    return "尚未启动";
  }
  if (monitor.status === "QUEUED") return "准备启动";
  if (monitor.status === "RUNNING") return "监控中";
  if (monitor.status === "SUCCEEDED") {
    return monitor.skippedEpisodes.length ? `初稿已完成 · 跳过 ${monitor.skippedEpisodes.length} 集` : "初稿已完成";
  }
  if (monitor.status === "CANCELED") return "已停止";
  return isCapacityPause(monitor) ? "额度不足 · 已暂停" : "已暂停";
}

function isCapacityPause(monitor: MonitorView) {
  return /额度不足|配额不足|余额不足|频率限制|rate\s*limit|usage\s*limit|quota/i.test(`${monitor.message ?? ""} ${monitor.error ?? ""}`);
}

function formatSkippedEpisodes(numbers: readonly number[]) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  if (sorted.length <= 12) return sorted.map((number) => `第${number}集`).join("、");
  return `${sorted.slice(0, 12).map((number) => `第${number}集`).join("、")}等${sorted.length}集`;
}

function monitorStatusClass(monitor: MonitorView | null) {
  if (!monitor) return "idle";
  if (monitor.status === "RUNNING" || monitor.status === "QUEUED") return "active";
  if (monitor.status === "SUCCEEDED") return "success";
  if (monitor.status === "FAILED") return "blocked";
  return "idle";
}
