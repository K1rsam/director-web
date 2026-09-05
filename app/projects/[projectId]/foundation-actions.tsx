"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { runFoundationStageAction, startProjectFoundationAction } from "@/app/actions";
import type { FoundationRunDiagnostics } from "@/lib/studio";

export type FoundationRunView = {
  stageCode: string;
  status: string;
  model: string;
  duration: string;
  error?: string | null;
  diagnostics?: FoundationRunDiagnostics | null;
};

function formatTokens(value: number | null | undefined) {
  if (value === null || value === undefined) return "未返回";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 10_000) return `${Math.round(value / 10_000)}万`;
  return String(value);
}

function diagnosticSummary(diagnostics: FoundationRunDiagnostics | null | undefined) {
  if (!diagnostics) return "暂无调用明细";
  const usage = diagnostics.usage;
  const calls = diagnostics.calls ?? usage?.calls;
  const chunks = diagnostics.chunks !== undefined
    ? `${diagnostics.completedChunks ?? 0}/${diagnostics.chunks} 个分片`
    : null;
  const input = usage?.inputTokens !== null && usage?.inputTokens !== undefined
    ? `输入 ${formatTokens(usage.inputTokens)} tokens${usage.cachedInputTokens ? `（缓存 ${formatTokens(usage.cachedInputTokens)}）` : ""}`
    : diagnostics.inputChars !== undefined
      ? `输入 ${formatTokens(diagnostics.inputChars)} 字符`
      : null;
  return [
    calls !== undefined ? `调用 ${calls} 次` : null,
    chunks,
    input,
    usage?.outputTokens !== null && usage?.outputTokens !== undefined ? `输出 ${formatTokens(usage.outputTokens)} tokens` : null
  ].filter(Boolean).join(" · ") || "暂无调用明细";
}

export function FoundationActions({
  projectId,
  active,
  runs,
  foundationReady,
  preprocessReady,
  validationReady
}: {
  projectId: string;
  active: boolean;
  runs: FoundationRunView[];
  foundationReady: boolean;
  preprocessReady: boolean;
  validationReady: boolean;
}) {
  const router = useRouter();
  const [submissionPending, setSubmissionPending] = useState(false);
  const submitting = useRef(false);
  useEffect(() => { submitting.current = active || submissionPending; }, [active, submissionPending]);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [active, router]);

  const statusOf = (code: string) => runs.find((run) => run.stageCode === code);

  function handleSubmit(event: FormEvent<HTMLFormElement>, confirmation?: string) {
    if (active || submitting.current || (confirmation && !window.confirm(confirmation))) {
      event.preventDefault();
      return;
    }
    // 这里只锁住重复提交；disabled 等 useFormStatus 确认提交后再更新。
    submitting.current = true;
  }

  return (
    <div className="foundationControlRoom" id="foundation-actions">
      <div className="foundationControlHeader">
        <div>
          <strong>P1 → P2</strong>
          <span>按顺序执行全剧基础策划与资产索引</span>
        </div>
        {active ? (
          <span className="foundationHeaderState running">P1 + P2 执行中…</span>
        ) : foundationReady ? (
          <span className="foundationHeaderState done">P1 + P2 已完成</span>
        ) : (
          <form action={startProjectFoundationAction} className="foundationRunAll" onSubmit={(event) => handleSubmit(event, "确定按 P1 → P2 顺序执行全剧基础工程吗？")}>
            <input name="projectId" type="hidden" value={projectId} />
            <FoundationSubmitButton className="studioButton foundationRunAllButton" data-variant="primary" disabled={active || submissionPending} onPendingChange={setSubmissionPending}>执行 P1 + P2</FoundationSubmitButton>
          </form>
        )}
      </div>
      <div className="foundationRail" aria-label="全剧基础工程岗位">
        <article className={`foundationRole automatic ${preprocessReady ? "done" : ""}`}>
          <span>P0</span>
          <div><strong>剧本预处理</strong><small>Python · 自动工程</small></div>
          <em>{preprocessReady ? "已完成" : "待处理"}</em>
          <span className="foundationCardAction">自动执行</span>
        </article>
      {(["P1", "P2"] as const).map((code) => {
        const run = statusOf(code);
        const className = run
          ? run.status === "已完成" ? "done" : run.status === "进行中" ? "running" : run.status === "排队中" ? "queued" : run.status === "失败" ? "failed" : ""
          : "";
        const actionLabel = run?.status === "已完成" ? "重跑" : run?.status === "失败" ? "再试一次" : "运行";
        return (
          <form action={runFoundationStageAction} className="foundationStageForm" key={code} onSubmit={(event) => handleSubmit(event)}>
              <input name="projectId" type="hidden" value={projectId} />
              <input name="stageCode" type="hidden" value={code} />
              <FoundationSubmitButton
                className="foundationCardHitArea"
                data-control="card"
                data-variant={run?.status === "已完成" ? "secondary" : "primary"}
                disabled={active || submissionPending}
                aria-busy={active && (run?.status === "进行中" || run?.status === "排队中")}
                aria-label={`${actionLabel} ${code}`}
                title={`点击整张卡片${actionLabel} ${code}`}
                onPendingChange={setSubmissionPending}
              />
              <article className={`foundationRole ${className}`} title={run?.error ?? undefined}>
                <span>{code}</span>
                <div>
                  <strong>{code === "P1" ? "全剧基础策划" : "全剧资产拆解"}</strong>
                  <small>{run?.model ?? "默认模型"} · {run?.duration ?? "—"}</small>
                </div>
                <em>{run?.status ?? "未开始"}</em>
                {run?.status === "失败" && run?.error ? <p className="roleRunError" title={run.error}>{run.error}</p> : null}
                <span className="foundationCardAction">{active && (run?.status === "进行中" || run?.status === "排队中") ? run.status : actionLabel}</span>
              </article>
          </form>
        );
      })}
        <article className={`foundationRole automatic ${validationReady ? "done" : ""}`}>
          <span>P3</span>
          <div><strong>确定性校验</strong><small>Python · 自动工程</small></div>
          <em>{validationReady ? "通过" : "待校验"}</em>
          <span className="foundationCardAction">自动执行</span>
        </article>
      </div>
      {(() => {
        const failedRun = [...runs].reverse().find((run) => run.status === "失败" && (run.error || run.diagnostics));
        if (!failedRun) return null;
        return (
          <details className="foundationFailureDetails">
            <summary>查看 {failedRun.stageCode} 失败原因与本次消耗</summary>
            <div>
              {failedRun.error ? <p>{failedRun.error}</p> : null}
              <span>{diagnosticSummary(failedRun.diagnostics)}</span>
              {failedRun.diagnostics?.validationIssues?.length ? (
                <ul>
                  {failedRun.diagnostics.validationIssues.slice(0, 5).map((issue, index) => (
                    <li key={`${issue.coordinate ?? issue.code ?? "issue"}-${index}`}>{issue.evidence ?? issue.coordinate ?? issue.code}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          </details>
        );
      })()}
      {foundationReady ? (
        <details className="maintenancePanel">
          <summary>维护与重置 <span>低频操作</span></summary>
          <div>
            <p>重新执行会覆盖当前全剧策划与资产索引，但不会删除已生成的单集分镜。</p>
            <form action={startProjectFoundationAction} className="foundationRunAll" onSubmit={(event) => handleSubmit(event, "确定重新运行 P1–P2 并覆盖当前全剧基础资料吗？")}>
              <input name="projectId" type="hidden" value={projectId} />
              <FoundationSubmitButton className="studioButton quietButton" data-variant="secondary" disabled={active || submissionPending} onPendingChange={setSubmissionPending}>重新生成 P1–P2</FoundationSubmitButton>
            </form>
          </div>
        </details>
      ) : null}
    </div>
  );
}

function FoundationSubmitButton({
  children,
  disabled,
  onPendingChange,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { onPendingChange: (pending: boolean) => void }) {
  const { pending } = useFormStatus();
  useEffect(() => { onPendingChange(pending); }, [pending, onPendingChange]);
  return (
    <button
      {...props}
      type="submit"
      disabled={disabled || pending}
      aria-busy={pending || props["aria-busy"]}
      aria-label={pending && props["aria-label"] ? `正在启动：${props["aria-label"]}` : props["aria-label"]}
    >
      {children ? pending ? "启动中…" : children : null}
    </button>
  );
}
