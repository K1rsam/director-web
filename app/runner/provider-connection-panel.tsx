"use client";

import { useActionState, useEffect, useRef } from "react";
import {
  checkCodexCliAction,
  removeDeepSeekCredentialAction,
  saveDeepSeekCredentialAction,
  type ProviderConnectionState
} from "@/app/actions";

type InitialApiStatus = {
  connected: boolean;
  apiBase: string;
  model: string;
  keyHint: string | null;
  lastTestedAt: string | null;
  error: string | null;
};

const initialActionState: ProviderConnectionState = { ok: false, message: "" };
type CliStatus = NonNullable<ProviderConnectionState["cliStatus"]>;

export function ProviderConnectionPanel({ initialApi }: { initialApi: InitialApiStatus }) {
  const [apiState, apiAction, apiPending] = useActionState(saveDeepSeekCredentialAction, initialActionState);
  const [removeState, removeAction, removePending] = useActionState(removeDeepSeekCredentialAction, initialActionState);
  const [cliState, cliAction, cliPending] = useActionState(checkCodexCliAction, initialActionState);
  const apiKeyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (apiState.ok && apiState.provider === "DEEPSEEK" && apiKeyRef.current) {
      apiKeyRef.current.value = "";
    }
  }, [apiState]);

  const apiMessage = apiState.message || initialApi.error || "Key 只会加密保存在当前账号下，不会写入浏览器 localStorage。";
  const apiMessageClass = apiState.message
    ? (apiState.ok ? "success" : "error")
    : (initialApi.error ? "error" : "");
  const cliHasResult = Boolean(cliState.message);
  const cliResultTone = cliPending ? "pending" : cliState.ok ? "success" : cliHasResult ? "error" : "";
  const apiStatusLabel = initialApi.connected ? "已连接" : "未连接";
  const cliStatusLabel = cliPending ? "检测中" : cliState.ok ? "可调用" : cliHasResult ? "暂不可用" : "未检测";
  const cliStatusClass = cliState.ok ? "connected" : cliHasResult ? "attention" : "";
  const cliResultTitle = cliPending
    ? "正在检测本机 CLI"
    : cliState.ok
      ? "本机 CLI 可调用"
      : cliHasResult
        ? "本机 CLI 暂不可用"
        : "尚未检测本机 CLI";
  const cliResultMessage = cliPending
    ? "正在检查启动程序与必要的本机执行条件。"
    : cliState.message || "点击下方按钮开始检查。这里只保留可用性结果。";

  return (
    <div className="runnerConnectionGrid">
      <section className="runnerConnectionCard studioCard">
        <div className="runnerConnectionHeader">
          <div>
            <p className="sectionEyebrow">API MODE</p>
            <h2>连接自己的 DeepSeek</h2>
            <p>先验证 `/models`，验证成功后才保存。保存的是当前账号的加密凭证，项目 API 执行会读取项目管理员账号的凭证。</p>
          </div>
          <span className={`runnerConnectionStatus ${initialApi.connected ? "connected" : ""}`}>{apiStatusLabel}</span>
        </div>

        <div className="runnerCredentialForm">
          <form action={apiAction} className="runnerSaveForm">
            <div className="runnerFieldGrid">
              <label>
                <span>DeepSeek API Key</span>
                <input
                  ref={apiKeyRef}
                  name="apiKey"
                  type="password"
                  autoComplete="new-password"
                  required
                  placeholder={initialApi.connected ? "输入新 Key 以替换当前 Key" : "粘贴 sk- 开头的 API Key"}
                />
              </label>
              <label>
                <span>模型</span>
                <select name="model" defaultValue={initialApi.model}>
                  <option value="deepseek-chat">deepseek-chat</option>
                  <option value="deepseek-reasoner">deepseek-reasoner</option>
                  <option value="deepseek-v4-flash">deepseek-v4-flash</option>
                </select>
              </label>
            </div>
            <label className="runnerWideField">
              <span>API 地址</span>
              <input name="apiBase" type="url" defaultValue={initialApi.apiBase} required />
            </label>
            <div className="runnerCredentialMeta">
              <span>{initialApi.keyHint ? `当前 Key：${initialApi.keyHint}` : "尚未保存账号 Key"}</span>
              {initialApi.lastTestedAt ? <time dateTime={initialApi.lastTestedAt}>最近验证：{formatDate(initialApi.lastTestedAt)}</time> : null}
            </div>
            <div className="runnerActions">
              <button className="glassPrimary runnerPrimaryButton" type="submit" disabled={apiPending}>
                {apiPending ? "正在验证…" : "验证并保存"}
              </button>
              {apiMessage ? <p className={`runnerMessage ${apiMessageClass}`} role="status">{apiMessage}</p> : null}
            </div>
            {apiState.ok && apiState.models?.length ? (
              <p className="runnerConnectionNote">已读取模型：{apiState.models.slice(0, 5).join("、")}{apiState.models.length > 5 ? " 等" : ""}</p>
            ) : null}
          </form>
          {initialApi.connected ? (
            <form action={removeAction} className="runnerActions runnerRemoveAction">
              <button className="quietButton runnerSecondaryButton" type="submit" disabled={removePending}>
                {removePending ? "正在删除…" : "删除已保存 Key"}
              </button>
              {removeState.message ? <p className={`runnerMessage ${removeState.ok ? "success" : "error"}`} role="status">{removeState.message}</p> : null}
            </form>
          ) : null}
        </div>
      </section>

      <section className="runnerConnectionCard studioCard">
        <div className="runnerConnectionHeader">
          <div>
            <p className="sectionEyebrow">CLI MODE</p>
            <h2>使用本机 Codex CLI</h2>
            <p>检测会读取本机 Codex /status 的账号、计划、额度窗口和用量摘要；不会显示或上传登录令牌，也不会调用模型。</p>
          </div>
          <span className={`runnerConnectionStatus ${cliStatusClass}`}>{cliStatusLabel}</span>
        </div>

        {cliState.cliStatus && !cliPending ? (
          <CodexCliStatusView status={cliState.cliStatus} note={cliResultMessage} />
        ) : (
          <div className={`runnerCliCheckResult ${cliResultTone}`} role="status" aria-live="polite">
            <span className="runnerCliCheckDot" aria-hidden="true" />
            <div>
              <strong>{cliResultTitle}</strong>
              <p>{cliResultMessage}</p>
            </div>
          </div>
        )}
        <form action={cliAction} className="runnerCliCheckForm">
          <button className="glassPrimary runnerPrimaryButton" type="submit" disabled={cliPending}>
            {cliPending ? "正在检查…" : cliHasResult ? "重新检测本机 CLI" : "测试本机 Codex CLI"}
          </button>
        </form>
      </section>
    </div>
  );
}

function CodexCliStatusView({ status, note }: { status: CliStatus; note?: string }) {
  const limit = status.limits.find((item) => item.id === "codex") ?? status.limits[0] ?? null;
  const primary = limit?.primary ?? null;
  const secondary = limit?.secondary ?? null;
  const credits = limit?.credits ?? null;

  return (
    <section className="runnerCliStatusPanel" aria-label="本机 Codex 状态">
      <header className="runnerCliStatusHeader">
        <div>
          <span className="runnerCliStatusEyebrow">LATEST STATUS</span>
          <strong>账号与额度</strong>
        </div>
        <time dateTime={status.checkedAt}>更新于 {formatDate(status.checkedAt)}</time>
      </header>
      {note ? <p className="runnerCliStatusNote">{note}</p> : null}
      <div className="runnerCliStatusGrid">
        <article>
          <span>账号</span>
          <strong>{status.account.email ?? "本机登录账号"}</strong>
          <small>{formatPlanType(status.account.planType)} · {status.version}</small>
        </article>
        <article>
          <span>5 小时额度</span>
          <strong>{formatRemaining(primary)}</strong>
          <small>{formatUsed(primary)} · {formatReset(primary?.resetsAt ?? null)}</small>
        </article>
        <article>
          <span>7 天额度</span>
          <strong>{formatRemaining(secondary)}</strong>
          <small>{formatUsed(secondary)} · {formatReset(secondary?.resetsAt ?? null)}</small>
        </article>
        <article>
          <span>累计用量</span>
          <strong>{formatTokenCount(status.usage.lifetimeTokens)}</strong>
          <small>{formatPeakUsage(status.usage.peakDailyTokens, status.usage.latestDailyUsage)}</small>
        </article>
      </div>
      <div className="runnerCliStatusFooter">
        <span>额外 credits：{formatCredits(credits)}</span>
        {status.usage.currentStreakDays !== null ? <span>连续使用 {status.usage.currentStreakDays} 天</span> : null}
      </div>
      {status.warnings.length ? <p className="runnerCliStatusWarning">提示：{status.warnings.join(" ")}</p> : null}
    </section>
  );
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
    enterprise: "Enterprise 计划"
  };
  return value ? (labels[value] ?? `${value} 计划`) : "计划信息未返回";
}

function formatRemaining(window: CliStatus["limits"][number]["primary"]): string {
  return window?.remainingPercent === null || window?.remainingPercent === undefined
    ? "暂不可读"
    : `剩余 ${window.remainingPercent}%`;
}

function formatUsed(window: CliStatus["limits"][number]["primary"]): string {
  return window?.usedPercent === null || window?.usedPercent === undefined
    ? "已用比例未知"
    : `已用 ${window.usedPercent}%`;
}

function formatReset(value: number | null): string {
  return value ? `重置 ${formatDate(new Date(value * 1000).toISOString())}` : "重置时间未知";
}

function formatCredits(credits: CliStatus["limits"][number]["credits"]): string {
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

function formatPeakUsage(value: number | null, latest: CliStatus["usage"]["latestDailyUsage"]): string {
  const peak = value === null ? "峰值日用量未知" : `峰值日 ${formatTokenCount(value)}`;
  return latest ? `${peak} · 最近 ${latest.date} ${formatTokenCount(latest.tokens)}` : peak;
}

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}
