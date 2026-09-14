"use client";

import { useEffect, useRef, useState, type ButtonHTMLAttributes, type FormEvent } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import type { getFoundationState } from "@/lib/foundation-state";
import { inspectFoundationWorkerAction, preprocessProjectAction, runFoundationStageAction, startProjectFoundationAction } from "@/app/actions";
import type { FoundationRecoveries } from "@/lib/foundation-state";
import { aggregateFoundationUsage, type FoundationRunUsage } from "@/lib/foundation-run-usage";

export type FoundationRunView = {
  stageCode: string;
  uiStage: string;
  name: string;
  current: boolean;
  status: string;
  model: string;
  duration: string;
  error?: string | null;
  errorHistorical?: boolean;
  errorCreatedAt?: string | null;
  usage?: FoundationRunUsage;
  durationMs?: number | null;
  reasoningEffort?: string | null;
};

export function FoundationUsage({ runs }: { runs: FoundationRunView[] }) {
  const aggregate = aggregateFoundationUsage(runs.map(run => run.usage ?? aggregateFoundationUsage([])));
  const count = (value: number | null | undefined) => value == null ? "未返回／未知" : value.toLocaleString("zh-CN");
  const status = (usage?: FoundationRunUsage) => !usage || usage.totalTokens === null ? "用量未返回／未知"
    : usage.unknownCalls > 0 ? "部分用量未返回 · 已记录合计" : "已记录合计";
  const cells = (usage?: FoundationRunUsage) => <>
    <td>{count(usage?.inputTokens)}</td><td>{count(usage?.cachedInputTokens)}</td>
    <td>{count(usage?.outputTokens)}</td><td>{count(usage?.reasoningOutputTokens)}</td><td>{count(usage?.totalTokens)}</td>
    <td>{count(usage?.newRequests)}</td><td>{count(usage?.reusedCalls)}</td>
  </>;
  const duration = runs.length && runs.every(run => typeof run.durationMs === "number" && Number.isFinite(run.durationMs) && run.durationMs >= 0)
    ? `${(runs.reduce((sum, run) => sum + run.durationMs!, 0) / 1000).toFixed(1)} 秒` : "未记录";
  return <details className="maintenancePanel" open>
    <summary>已记录用量（token）</summary>
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", minWidth: 760, textAlign: "left", fontVariantNumeric: "tabular-nums" }}>
        <thead><tr><th scope="col">岗位记录</th><th scope="col">输入</th><th scope="col">其中缓存</th><th scope="col">输出</th><th scope="col">其中推理</th><th scope="col">总量</th><th scope="col">新请求尝试</th><th scope="col">复用</th><th scope="col">耗时</th><th scope="col">完整性</th></tr></thead>
        <tbody>{runs.map(run => <tr key={run.stageCode}><th scope="row">{run.name}</th>{cells(run.usage)}<td>{run.duration}</td><td>{status(run.usage)}</td></tr>)}</tbody>
        <tfoot><tr><th scope="row">已记录合计</th>{cells(aggregate)}<td>{duration}</td><td>{status(aggregate)}</td></tr></tfoot>
      </table>
    </div>
    <p>每个岗位汇总其最近任务内的所有已记录批次；不同岗位可能来自不同任务，旧任务不混入。耗时为批次运行时间之和，不是整剧墙钟时间；运行中或记录不全时不显示完整耗时。</p>
    <p>缓存包含在输入中，推理包含在输出中；总量＝输入＋输出。复用不重计原请求；新请求尝试指外层岗位调用，不是内部 HTTP 次数。未返回不代表未收费，已记录 0 不保证存储没有遗漏。</p>
    {runs.some(run => run.reasoningEffort) ? <p>已记录推理强度：{runs.filter(run => run.reasoningEffort).map(run => `${run.name} ${run.reasoningEffort}`).join(" · ")}</p> : null}
  </details>;
}

export function FoundationActions({
  projectId,
  active,
  runs,
  foundationReady,
  preprocessReady,
  planningReady,
  assetsReady,
  recovery,
  recoveries
}: {
  projectId: string;
  active: boolean;
  runs: FoundationRunView[];
  foundationReady: boolean;
  preprocessReady: boolean;
  planningReady: boolean;
  assetsReady: boolean;
  recovery?: Awaited<ReturnType<typeof getFoundationState>>["f2Recovery"];
  recoveries?: FoundationRecoveries;
}) {
  const router = useRouter();
  const [submissionPending, setSubmissionPending] = useState(false);
  const submitting = useRef(false);
  const handleSubmit = (event: FormEvent<HTMLFormElement>, confirmation?: string) => {
    if (active || submitting.current || (confirmation && !window.confirm(confirmation))) { event.preventDefault(); return; }
    submitting.current = true;
  };
  useEffect(() => { if (!submissionPending) submitting.current = false; }, [submissionPending]);
  const previews = recoveries ?? { F1: null, F2: recovery ?? null, Q1: null };
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [active, router]);

  return (
    <div className="foundationControlRoom" id="foundation-actions">
      <div className="foundationControlHeader">
        <div>
          <strong>F1 → F2 → Q1</strong>
          <span>按顺序整理必要资料、素材目录并局部核对</span>
        </div>
        {active ? (
          <span className="foundationHeaderState running">F1 / F2 / Q1 执行中…</span>
        ) : foundationReady ? (
          <span className="foundationHeaderState done">F1 / F2 / Q1 已完成</span>
        ) : (
          <form action={startProjectFoundationAction} className="foundationRunAll" onSubmit={(event) => handleSubmit(event, "确定按 F1 → F2 → Q1 顺序执行全剧基础工程吗？")}>
            <input name="projectId" type="hidden" value={projectId} />
            <FoundationSubmitButton className="studioButton foundationRunAllButton" data-variant="primary" disabled={active || submissionPending} onPendingChange={setSubmissionPending}>执行 F1 / F2 / Q1</FoundationSubmitButton>
          </form>
        )}
      </div>
      <div className="foundationRail" aria-label="全剧基础工程岗位">
        <article className={`foundationRole automatic ${preprocessReady ? "done" : ""}`}>
          <span>P0</span>
          <div><strong>原文机械检查</strong><small>程序执行 · 非 AI</small></div>
          <em>{preprocessReady ? "已完成" : "待处理"}</em>
          <span className="foundationCardAction">自动执行</span>
        </article>
      {runs.map((run) => {
        const code = run.stageCode;
        const waiting = code === "F1" ? !preprocessReady : code === "F2" ? !planningReady : !assetsReady;
        const className = run.status === "进行中" || run.status === "排队中" ? "running"
          : ["失败", "已停止", "需返修", "拒收"].includes(run.status) || run.status.includes("待补") ? "failed" : run.current ? "done" : "";
        const actionLabel = run.status === "未开始" ? "运行" : "重跑";
        return (
          <form action={runFoundationStageAction} className="foundationStageForm" key={code} onSubmit={(event) => handleSubmit(event)}>
              <input name="projectId" type="hidden" value={projectId} />
              <input name="stageCode" type="hidden" value={code} />
              <FoundationSubmitButton onPendingChange={setSubmissionPending} className="foundationCardHitArea" disabled={active || waiting || submissionPending} aria-label={`${actionLabel} ${code}`} title={waiting ? "先完成当前版本上游资料" : `${actionLabel} ${code}`} />
              <article className={`foundationRole ${className}`}>
                <span>{run.uiStage}</span>
                <div>
                  <strong>{code} · {run.name}</strong>
                  <small>{run.model} · {run.duration}</small>
                </div>
                <em>{run.status}</em>
                <span className="foundationCardAction">{active && (run.status === "进行中" || run.status === "排队中") ? run.status : waiting ? "等待上游" : actionLabel}</span>
              </article>
          </form>
        );
      })}
      </div>
      <p className="biblePlaceholder">F1 必要事实 → F2 素材目录 → Q1 局部核对并交付资料。图片和后续分镜另行制作。</p>
      <FoundationUsage runs={runs} />
      {runs.filter((run) => run.error).map((run) => <details className="foundationRunError" key={run.stageCode} open={!run.errorHistorical}>
        <summary>{run.stageCode} · {run.errorHistorical ? "历史运行错误" : "运行错误"}</summary>
        {run.errorCreatedAt ? <time dateTime={run.errorCreatedAt}>{new Date(run.errorCreatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}（北京时间）</time> : null}
        {run.errorHistorical ? <p>对应的原文、输入或上游已更新；保留原记录，不代表本次资料处理再次失败。</p> : null}
        <p className="roleRunError">{run.error}</p>
      </details>)}
      {(["F1", "F2", "Q1"] as const).map(stage => {
        const saved = previews[stage];
        const canResume = Boolean(saved?.resumeRunId && saved.resumeChunkCount < saved.totalChunks);
        const waiting = stage === "F1" ? !preprocessReady : stage === "F2" ? !planningReady : !assetsReady;
        return saved && (saved.replayRunId || canResume || saved.unknownRetryRunId) ? <section className="maintenancePanel" key={stage}>
          <p>{stage}：只复用已保存且通过本次版本核对的分片，保留原始响应、失败记录和原耗时。</p>
          {saved.replayRunId ? <form action={runFoundationStageAction}>
            <input name="projectId" type="hidden" value={projectId} /><input name="stageCode" type="hidden" value={stage} />
            <input name="resumeFromRunId" type="hidden" value={saved.replayRunId} /><input name="replayOnly" type="hidden" value="1" />
            <button type="submit" className="quietButton" disabled={active || waiting}>复验已有{stage}完整结果（不调用模型）</button>
            <small>{stage} 已保存 {saved.replayChunkCount} 片；本次剩余调用 0 片。</small>
          </form> : null}
          {canResume ? <form action={runFoundationStageAction}>
            <input name="projectId" type="hidden" value={projectId} /><input name="stageCode" type="hidden" value={stage} />
            <input name="resumeFromRunId" type="hidden" value={saved.resumeRunId!} /><input name="replayOnly" type="hidden" value="0" />
            <button type="submit" className="quietButton" disabled={active || waiting}>继续{stage}未完成分片</button>
            <small>{stage} 已保存 {saved.resumeChunkCount} 片；本次新增调用 {saved.totalChunks - saved.resumeChunkCount} 片。</small>
          </form> : null}
          {saved.unknownRetryRunId ? <form action={runFoundationStageAction} onSubmit={event => {
            if (!window.confirm(`上次请求结果未确认，重发可能重复计费。将复用${saved.unknownRetryChunkCount ?? 0}片，新增${saved.totalChunks - (saved.unknownRetryChunkCount ?? 0)}次${stage}分片请求。确认重发并继续吗？`)) event.preventDefault();
          }}>
            <input name="projectId" type="hidden" value={projectId} /><input name="stageCode" type="hidden" value={stage} />
            <input name="resumeFromRunId" type="hidden" value={saved.unknownRetryRunId} /><input name="allowUnknownRetry" type="hidden" value="1" />
            <button type="submit" className="dangerQuietButton" disabled={active || waiting}>确认重发{stage}未获结果的片段</button>
            <small>可能重复计费。已保存 {saved.unknownRetryChunkCount ?? 0} 片仍复用；仅在你确认后新增 {saved.totalChunks - (saved.unknownRetryChunkCount ?? 0)} 片请求。普通“继续”不会重发。</small>
          </form> : null}
        </section> : null;
      })}
      {active ? <form action={inspectFoundationWorkerAction} className="maintenancePanel">
        <input name="projectId" type="hidden" value={projectId} />
        <button type="submit" className="quietButton">检查后台状态（不调用模型）</button>
        <small>仅收回已确认退出的工作器；仍在运行或无法确定的进程不会被取消。</small>
      </form> : null}
      <details className="maintenancePanel">
        <summary>重跑与原文检查 <span>保留历史版本</span></summary>
        <div>
          <p>重跑会重新生成资料并产生调用费用；历史结果、调用记录和分镜保留。只需补Q1时，请用单岗入口。</p>
          <form action={startProjectFoundationAction} className="foundationRunAll" onSubmit={(event) => {
            if (!window.confirm("确定重新运行 F1 → F2 → Q1？当前批准将失效，历史记录保留。")) event.preventDefault();
          }}>
            <input name="projectId" type="hidden" value={projectId} />
            <button type="submit" className="dangerQuietButton" disabled={active}>整批重跑 F1 → F2 → Q1</button>
          </form>
          <form action={preprocessProjectAction}><input name="projectId" type="hidden" value={projectId} /><button type="submit" className="quietButton" disabled={active}>重新检查 P0 原文</button></form>
        </div>
      </details>
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
