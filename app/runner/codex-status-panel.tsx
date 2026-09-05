"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

import type { RunnerStatusLimit, RunnerStatusSnapshot, RunnerStatusWindow } from "@/lib/runner-status";
import { DiagnosticLogPanel } from "./diagnostic-log-panel";

export type RunnerStatusDevice = {
  id: string;
  name: string;
  revoked: boolean;
  status: RunnerStatusSnapshot | null;
};

export function CodexStatusPanel({ devices }: { devices: RunnerStatusDevice[] }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const activeDevices = devices.filter((device) => !device.revoked);
  const syncedDevices = activeDevices.filter((device) => device.status);

  useEffect(() => {
    const timer = window.setInterval(() => router.refresh(), 60_000);
    return () => window.clearInterval(timer);
  }, [router]);

  function refreshStatus() {
    startRefresh(() => router.refresh());
  }

  return (
    <>
    <section className="runnerStatusCard studioCard" aria-label="本机 Codex 账号与额度">
      <header className="runnerStatusHeader">
        <div>
          <p className="sectionEyebrow">LATEST STATUS</p>
          <h2>本机账号与额度</h2>
          <p>状态由每台设备自己的 Runner 读取并回传；网站只保存不含登录令牌的状态快照。</p>
        </div>
        <div className="runnerStatusActions">
          <span className={`runnerStatusSyncState ${syncedDevices.length ? "synced" : ""}`}>
            {syncedDevices.length ? `${syncedDevices.length} 台已同步` : "等待本机状态"}
          </span>
          <button className="studioButton quietButton runnerStatusRefresh" data-variant="secondary" type="button" onClick={refreshStatus} disabled={refreshing} aria-busy={refreshing}>
            {refreshing ? "刷新中…" : "刷新线上状态"}
          </button>
        </div>
      </header>

      {activeDevices.length === 0 ? (
        <p className="runnerStatusEmpty">尚未生成可用的 CLI 设备启动器。生成后，在对应电脑启动 Runner 即会显示该电脑自己的账号和额度。</p>
      ) : syncedDevices.length === 0 ? (
        <div className="runnerStatusEmpty runnerStatusPendingList">
          {activeDevices.map((device) => (
            <div key={device.id} className="runnerStatusPendingDevice">
              <span className="runnerDeviceDot" aria-hidden="true" />
              <div><strong>{device.name}</strong><small>等待这台电脑的 Runner 首次上报状态</small></div>
            </div>
          ))}
          <p>请保持对应设备的启动器窗口运行；页面不会直接读取其他电脑的 CLI。</p>
        </div>
      ) : (
        <div className="runnerStatusDeviceGrid">
          {activeDevices.map((device) => (
            <StatusDeviceCard key={device.id} device={device} />
          ))}
        </div>
      )}
    </section>
    <DiagnosticLogPanel devices={devices} />
    </>
  );
}

function StatusDeviceCard({ device }: { device: RunnerStatusDevice }) {
  if (!device.status) {
    return (
      <article className="runnerStatusDevice pending">
        <header><strong>{device.name}</strong><span>等待上报</span></header>
        <p>启动这台设备的 Runner 后，账号和额度会自动显示在这里。</p>
      </article>
    );
  }

  const status = device.status;
  const limit = status.limits.find((item) => item.id === "codex") ?? status.limits[0] ?? null;
  const primary = limit?.primary ?? null;
  const secondary = limit?.secondary ?? null;

  return (
    <article className="runnerStatusDevice">
      <header>
        <div><strong>{device.name}</strong><small>更新于 {formatDate(status.checkedAt)}</small></div>
        <span className="runnerStatusDeviceReady">已同步</span>
      </header>
      <div className="runnerStatusIdentity">
        <strong>{status.account.email ?? "本机登录账号"}</strong>
        <span>{formatPlanType(status.account.planType)} · {status.version}</span>
      </div>
      <div className="runnerStatusMetricGrid">
        <StatusMetric label="5 小时额度" value={formatRemaining(primary)} detail={`${formatUsed(primary)} · ${formatReset(primary?.resetsAt ?? null)}`} />
        <StatusMetric label="7 天额度" value={formatRemaining(secondary)} detail={`${formatUsed(secondary)} · ${formatReset(secondary?.resetsAt ?? null)}`} />
        <StatusMetric label="累计用量" value={formatTokenCount(status.usage.lifetimeTokens)} detail={formatPeakUsage(status.usage.peakDailyTokens, status.usage.latestDailyUsage)} />
        <StatusMetric label="额外 credits" value={formatCredits(limit?.credits ?? null)} detail={formatStreak(status.usage.currentStreakDays, status.usage.longestStreakDays)} />
      </div>
      {status.warnings.length ? <p className="runnerStatusWarning">提示：{status.warnings.join(" ")}</p> : null}
    </article>
  );
}

function StatusMetric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="runnerStatusMetric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>;
}

function formatPlanType(value: string | null): string {
  const labels: Record<string, string> = {
    free: "Free 计划",
    go: "Go 计划",
    plus: "Plus 计划",
    pro: "Pro 计划",
    prolite: "Pro Lite 计划",
    team: "Team 计划",
    business: "Business 计划",
    enterprise: "Enterprise 计划",
  };
  return value ? (labels[value] ?? `${value} 计划`) : "计划信息未返回";
}

function formatRemaining(window: RunnerStatusWindow | null): string {
  return window?.remainingPercent === null || window?.remainingPercent === undefined
    ? "暂不可读"
    : `剩余 ${window.remainingPercent}%`;
}

function formatUsed(window: RunnerStatusWindow | null): string {
  return window?.usedPercent === null || window?.usedPercent === undefined
    ? "已用比例未知"
    : `已用 ${window.usedPercent}%`;
}

function formatReset(value: number | null): string {
  return value === null ? "重置时间未知" : `重置 ${formatDate(new Date(value * 1000).toISOString())}`;
}

function formatCredits(credits: RunnerStatusLimit["credits"]): string {
  if (!credits) return "未返回";
  if (credits.unlimited) return "无限额外额度";
  if (credits.balance !== null) return credits.balance;
  return credits.hasCredits ? "有可用额度" : "无可用额度";
}

function formatTokenCount(value: number | null): string {
  if (value === null) return "暂不可读";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B tokens`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M tokens`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K tokens`;
  return `${value} tokens`;
}

function formatPeakUsage(value: number | null, latest: RunnerStatusSnapshot["usage"]["latestDailyUsage"]): string {
  const peak = value === null ? "峰值日用量未知" : `峰值日 ${formatTokenCount(value)}`;
  return latest ? `${peak} · 最近 ${latest.date} ${formatTokenCount(latest.tokens)}` : peak;
}

function formatStreak(current: number | null, longest: number | null): string {
  if (current === null && longest === null) return "连续使用信息未返回";
  const currentText = current === null ? "当前未知" : `当前 ${current} 天`;
  return longest === null ? currentText : `${currentText} · 最长 ${longest} 天`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}
