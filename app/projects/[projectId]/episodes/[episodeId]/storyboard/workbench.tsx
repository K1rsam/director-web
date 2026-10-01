"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import styles from "./workbench.module.css";

type Mode = "off" | "all" | "recommended" | "review";
type Fantasy = { id: string; anchorRefs: string[]; subject: string; emotionPurpose: string; recommended: boolean; proposal: string };
type Plan = { emotionArc: string; workPackages: { id: string; sourceRefs: string[]; emotionContract: { subject: string; contextTone: string; audienceEffect: string; change: string; landing: string; retain: string[] }; dependsOn: string[] }[]; provisionalUnits: { id: string; packageId: string; sourceRefs: string[]; secondsRange: string | number[] }[]; fantasyCandidates: Fantasy[] };
type RunError = { code?: string; message?: string; detail?: unknown; at?: string };
type SourceDiagnostic = { rowId: string; line?: number; sourceFileLine?: number; text: string; reason: string };
type RequestError = Error & { status?: number; code?: string; creationOutcome?: string; diagnostics?: SourceDiagnostic[] };
type CancelAcknowledgement = { at: string; acceptUnknownUsage: true; kind?: "failed" | "timeout" | "usage" };
type Cancellation = { attemptId: string; canAcknowledge: boolean; reason: string; kind?: "failed" | "timeout" | "usage" };
type Execution = { phase: "starting" | "waiting" | "generating" | "receiving" | "completed" | "failed"; startedAt?: string; lastEventAt?: string | null; lastProgressAt?: string | null; eventCount?: number | null; timeoutKind?: "startup" | "idle" | "total" | null; limits?: { startupMs: number | null; idleMs: number | null; totalMs: number | null }; workload?: { stage: string; promptChars: number | null; unitCount: number | null }; lastEventType?: string | null };
type Scheduling = { maxConcurrent: number; maxPerEpisode: number; inFlight: number; queued: number };
type Run = {
  id: string; status: string; settings: { maxUnitSeconds: 15 | 30; fantasyMode: Mode }; active: boolean; sourceStale: boolean;
  scheduling?: Scheduling;
  error?: RunError; sourceRows: { id: string; text: string }[]; sourceWarnings?: string[]; plan?: Plan;
  choice: { mode: Mode; overrides: Record<string, boolean>; unitOverrides: Record<string, boolean> };
  selection: { status: string; selectedIds: string[]; byUnit: unknown; fingerprint: string; unfulfilledUnitIds: string[] };
  adopted: { packageIds: string[]; stage: string; unitCount: number; shotCount: number; seconds: number }[];
  operations: { attemptId: string; stage: string; packageIds: string[]; status: string; finishMode: string; createdAt: string; error?: string | { message?: string }; cancelAcknowledgement?: CancelAcknowledgement; canRecoverSaved?: boolean; execution?: Execution; usage?: { inputTokens: number; outputTokens: number } | null }[];
  cancellations?: Cancellation[];
  candidates: { id: string; attemptId: string; stage: string; packageIds: string[]; status: string; errors: unknown[]; validation: unknown; requiredPackageIds: string[]; resolvedBy?: string }[];
  assembly?: { text: string; stats: unknown; errors: unknown[]; warnings: unknown[] };
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number; complete: boolean; knownTokens?: number; unknownAttempts?: number; acknowledgedUnknownAttempts?: number };
  budget: { maxCalls: number; maxTokens: number; maxRepairs: number };
};
type Index = { runs: { id: string; title: string; status: string; createdAt: string }[]; model: string; reasoning: string; maxConcurrent: number; maxPerEpisode?: number; runner: { ready: boolean; message: string }; sourceWarnings: string[] };
const modeLabels: Record<Mode, string> = { off: "不加幻想", all: "全部加入", recommended: "只加推荐", review: "逐项选择" };
const base = (episodeId: string) => `/api/episodes/${encodeURIComponent(episodeId)}/storyboard`;
const messageOf = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const problem = value as RunError;
    const text = [problem.at, problem.message, typeof problem.detail === "object" ? JSON.stringify(problem.detail) : problem.detail].filter(Boolean).join("：");
    if (text) return text;
  }
  return JSON.stringify(value) || "未提供详细说明";
};
const dateLabel = (value: string) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? value : d.toLocaleString("zh-CN"); };
const sourceExcerpt = (rows: Run["sourceRows"], ids: string[]) => ids.map(id => rows.find(row => row.id === id)).filter((row): row is Run["sourceRows"][number] => Boolean(row));
const statusLabels: Record<string, string> = { created: "待分析", running: "运行中", pausing: "暂停中 · 等待回包保存", paused: "已暂停", stopped: "已中断", planned: "规划待审", unknown: "回执待核对", usage_review: "回包已保存 · 用量待确认", interrupted: "服务中断待核对", awaiting_confirmation: "等待幻想确认", needs_design: "幻想设计未齐", budget_stop: "达到预算停止线", source_stale: "原文或前情资料已更新", waiting_dependencies: "等待依赖工作包", failed: "执行失败", cancelled: "已停止", needs_repair: "需要返修", needs_dependency_repair: "需要联动返修", rechecking: "重新核查中", text_ready_for_review: "文字稿待人工审看", adopted: "已采纳", received: "已收到", stale: "旧候选", cancelled_late: "停止后返回", completed: "调用已结束" };
const stageLabels: Record<string, string> = { plan: "情绪统筹", author: "完整主创", finish: "统一整编" };
const label = (code: string, table: Record<string, string>) => table[code] || code;
export const mergeSourceWarnings = (...groups: (string[] | undefined)[]) => [...new Set(groups.flatMap(group => group || []))];
type StateInput = { status: string; active: boolean; sourceStale: boolean; scheduling?: Scheduling; operations: { attemptId?: string; status: string; stage?: string; packageIds?: string[]; cancelAcknowledgement?: CancelAcknowledgement; execution?: Execution }[]; cancellations?: Cancellation[]; candidates?: { id: string; status: string; stage: string; resolvedBy?: string }[]; selection: { status: string }; assembly?: { text: string; errors: unknown[] } | null; plan?: { workPackages: { id: string }[] } | null; adopted: { stage: string; packageIds: string[] }[]; budget?: { maxCalls: number; maxTokens: number } };
export function deriveWorkbenchState(run: StateInput, runnerReady: boolean) {
  const total = run.plan?.workPackages.length || 0;
  const count = (stages: string[]) => new Set(run.adopted.filter(item => stages.includes(item.stage)).flatMap(item => item.packageIds)).size;
  const usageReview = run.status === "usage_review" || run.operations.some(item => item.status === "completed" && !item.cancelAcknowledgement?.acceptUnknownUsage && run.cancellations?.some(check => check.attemptId === item.attemptId && check.kind === "usage"));
  const unresolved = usageReview || run.status === "unknown" || run.status === "interrupted" || run.operations.some(item => (item.status === "unknown" && !item.cancelAcknowledgement?.acceptUnknownUsage) || (!run.active && item.status === "running"));
  const selectionBlocked = run.plan && ["awaiting_confirmation", "needs_design"].includes(run.selection.status);
  const noBudget = run.budget?.maxCalls === 0 || run.budget?.maxTokens === 0;
  const canCharge = runnerReady && !run.active && !run.sourceStale && !unresolved && !noBudget;
  const current = run.operations.slice().reverse().find(item => item.status === "running");
  const pendingExecutions = run.operations.filter(item => item.execution && (item.status === "running" || (item.status === "unknown" && !item.cancelAcknowledgement?.acceptUnknownUsage)));
  const latest = run.operations.at(-1);
  const executionOperations = pendingExecutions.length ? pendingExecutions : latest?.execution ? [latest] : [];
  const planFailure = run.candidates?.slice().reverse().find(item => item.stage === "plan" && ["needs_repair", "needs_dependency_repair"].includes(item.status) && !item.resolvedBy);
  const waitingForSlot = run.active && run.scheduling?.inFlight === 0 && run.scheduling.queued > 0;
  const feedback = run.sourceStale ? "原文或前情资料已更新，请新建任务；旧结果仍已保存，可查看。" : usageReview ? "回包已保存，用量未知；请先确认接受未知用量。只解除费用阻断，不自动重发；需要继续时另行操作，仅补未完成步骤。" : unresolved ? "有未完成的调用待处理，请使用下方回包恢复或风险确认入口，不要重复新建。" : run.status === "pausing" ? "正在暂停：不再派新请求，等待已在途回包保存；请勿重复启动。" : run.status === "paused" ? "已暂停，完成的步骤与回包已保存；继续时只推进未完成部分。" : waitingForSlot ? "正在排队等待执行空位；尚未占用执行位，排队不代表模型已收到请求。" : run.active ? current ? `正在${label(current.stage || "", stageLabels)}，等待执行、返回与校验，状态会自动刷新。` : "运行请求已受理，正在准备下一阶段或处理已返回结果。" : planFailure ? run.plan ? "新规划已返回但校验未通过，保留上一版规划；结果已保存。" : "分析已返回，规划校验未通过，结果已保存。" : !run.plan && !run.operations.length ? "任务已建立，仅完成原文准备；尚未调用模型。" : run.status === "text_ready_for_review" ? "整稿已生成，等待人工审看。" : run.plan && run.selection.status === "awaiting_confirmation" ? "规划已返回，等待你确认幻想选择。" : run.plan && run.selection.status === "needs_design" ? "规划已返回，所选幻想仍需补充设计。" : run.status === "planned" ? "规划已返回并通过校验，可以审看幻想选择后继续。" : `当前状态：${label(run.status, statusLabels)}；执行记录已保存。`;
  return { total, authorDone: count(["author", "finish"]), finishDone: count(["finish"]), unresolved, usageReview, active: run.active, executionOperations,
    current, planFailure, feedback, calls: run.operations.length, returnedCalls: run.operations.filter(item => item.status === "completed").length,
    currentStage: label(current?.stage || run.operations.at(-1)?.stage || "", stageLabels) || "原文准备",
    planLabel: run.plan && planFailure ? "新规划待修 · 旧版保留" : run.plan ? "规划已就绪" : run.active ? "分析进行中" : unresolved ? "回执待核对" : planFailure ? "分析已返回 · 规划待修" : run.operations.length ? "规划尚未就绪" : "等待规划",
    noPlanMessage: run.sourceStale || unresolved || run.active || planFailure ? feedback : run.operations.length ? "分析记录已保存，尚未形成可采纳规划。请核对当前状态与执行记录后继续。" : "本集原文已准备；这里不上传全文。点击“先分析”生成情绪规划。",
    nextLabel: planFailure ? "修复规划/继续" : run.plan ? "推进一步" : "先分析",
    canRecheck: Boolean(planFailure && !run.active && !run.sourceStale && !unresolved),
    canRun: canCharge && (!selectionBlocked || Boolean(planFailure)),
    canReplan: Boolean(!planFailure && run.plan && run.selection.status === "needs_design" && canCharge && run.adopted.length === 0),
    downloadable: !run.sourceStale && run.status === "text_ready_for_review" && Boolean(run.assembly?.text) && !run.assembly?.errors?.length };
}
const durationLabel = (milliseconds: number | null | undefined) => {
  if (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) || milliseconds < 0) return "未知";
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};
function ExecutionProgress({ execution, active }: { execution: Execution; active: boolean }) {
  const phaseLabels: Record<Execution["phase"], string> = { starting: "正在启动CLI", waiting: "等待模型响应（尚未观察到生成进展）", generating: "已观察到生成进展", receiving: "收到正文，正在处理", completed: "调用已结束", failed: "本次执行失败" };
  const timeoutLabels = { startup: "启动等待超时", idle: "无生成进展超时", total: "总时长超时" };
  const live = active && !["completed", "failed"].includes(execution.phase);
  const startedAt = execution.startedAt ? Date.parse(execution.startedAt) : NaN;
  return <div className={styles.fine}>
    <p>{!live && !["completed", "failed"].includes(execution.phase) ? "最近记录：" : ""}{phaseLabels[execution.phase]}{execution.timeoutKind ? ` · ${timeoutLabels[execution.timeoutKind]}` : ""}</p>
    {Number.isFinite(startedAt) ? <p>{live ? `已运行 ${durationLabel(Date.now() - startedAt)}` : `开始时间：${dateLabel(execution.startedAt!)}`}</p> : null}
    <p>{execution.lastProgressAt ? `${live ? "" : "已观察到生成进展（历史证据） · "}最近生成进展：${dateLabel(execution.lastProgressAt)}` : "最近生成进展：尚未观察到"}</p>
    {execution.limits ? <p>启动等待预算 {durationLabel(execution.limits.startupMs)} · 无生成进展预算 {durationLabel(execution.limits.idleMs)} · 总时长上限 {durationLabel(execution.limits.totalMs)}</p> : null}
  </div>;
}
export function RunFeedback({ state, error, pendingAction, disabled, onRecheck }: { state: ReturnType<typeof deriveWorkbenchState> | null; error?: RunError; pendingAction: string; disabled: boolean; onRecheck: () => void }) {
  const pending: Record<string, string> = { create: "正在准备本集原文；不调用模型，请等待任务建立。", "start:next": "正在提交单步运行请求，请勿重复点击。", "start:all": "正在提交连续制作请求，请勿重复点击。", recheck: "正在重新核查已保存候选；不调用模型。", recover: "正在检查已保存回包；不调用模型。", pause: "正在暂停后续派单，已在途回包会保留。", stop: "正在立即中断，请以任务状态为准。", acknowledge_cancel: "正在记录中断风险确认，不启动新请求。", acknowledge_failure: "正在记录失败风险确认，不自动重发。", acknowledge_timeout: "正在记录超时风险确认，不自动重发。", acknowledge_usage: "正在确认未知用量；已保存结果保留，不启动新调用。" };
  return <div className={styles.runFeedback} aria-label="操作反馈">
    <div role="status" aria-live="polite" aria-atomic="true"><strong>{pendingAction ? pending[pendingAction] || "正在保存操作，请稍候。" : state?.feedback || "尚未建立任务。新建仅准备原文，不调用模型。"}</strong>{state ? <p className={styles.fine}>当前阶段：{state.currentStage} · 调用记录 {state.calls} 次 · 已返回 {state.returnedCalls} 次</p> : null}</div>
    {error ? <p className={styles.error} role="alert">{error.code ? `${error.code}：` : ""}{messageOf(error)}</p> : null}
    {state?.executionOperations.map((op, i) => <div key={op.attemptId || i} aria-label="调用执行状态"><strong>{label(op.stage || "", stageLabels)}{op.packageIds?.length ? ` · ${op.packageIds.join("、")}` : ""}</strong><ExecutionProgress execution={op.execution!} active={state.active && op.status === "running"} /></div>)}
    {state?.planFailure ? <div className={styles.replan}><p>先重新核查已保存结果；不调用模型。“修复规划/继续”仍不通过时，才可能调用模型定向修复一次，仍受预算与返修上限约束。</p><button type="button" disabled={disabled || !state.canRecheck} onClick={onRecheck}>重新核查候选（不调用模型）</button></div> : null}
  </div>;
}
export function RecoveryActions({ operations, cancellations, disabled, onRecover, onAcknowledge }: { operations: { attemptId: string; stage: string; status: string; packageIds: string[]; cancelAcknowledgement?: CancelAcknowledgement; canRecoverSaved?: boolean }[]; cancellations: Cancellation[]; disabled: boolean; onRecover: (id: string) => void; onAcknowledge: (id: string) => void }) {
  const pending = operations.filter(op => op.canRecoverSaved || (!op.cancelAcknowledgement?.acceptUnknownUsage && (["unknown", "running"].includes(op.status) || (op.status === "completed" && cancellations.some(check => check.attemptId === op.attemptId && check.kind === "usage")))));
  if (!pending.length) return null;
  const usageOnly = pending.every(op => cancellations.some(check => check.attemptId === op.attemptId && check.kind === "usage"));
  return <section className={styles.warning} aria-label={usageOnly ? "用量确认" : "回包恢复"}><strong>先处理已有调用，不重跑已完成步骤</strong>{pending.map(op => {
    const check = cancellations.find(item => item.attemptId === op.attemptId);
    return <div key={op.attemptId}><p>{label(op.stage, stageLabels)}{op.packageIds.length ? ` · ${op.packageIds.join("、")}` : ""}：{check?.reason || "尚未确认最终结果；先检查已保存回包。"}</p><div className={styles.actions}>{check?.kind !== "usage" ? <button type="button" disabled={disabled} onClick={() => onRecover(op.attemptId)}>检查并恢复已有回包（不调用模型）</button> : null}{check?.canAcknowledge ? <button type="button" className={check.kind ? styles.primary : undefined} disabled={disabled} onClick={() => onAcknowledge(op.attemptId)}>{check.kind === "usage" ? "确认接受未知用量" : check.kind === "timeout" ? "确认超时风险，允许继续" : check.kind === "failed" ? "确认失败风险，允许继续" : "确认中断风险，允许继续"}</button> : null}</div>{check?.canAcknowledge ? <p>{check.kind === "usage" ? "结果已保存；本次用量未知，实际消耗可能未完整统计。确认只解除费用阻断，不调用模型、不自动重发，也不重跑已完成步骤。需要继续时请另行点击“连续完成”，仅补未完成步骤，届时才可能产生新调用。" : check.kind === "timeout" ? "这次超时的用量未知，可能已经消耗额度。确认不代表已退费，只解除阻塞，不自动重发；随后点击“从已保存步骤继续”连续完成，会产生新的调用，仅补未完成步骤。" : check.kind === "failed" ? "这次失败的用量未知，可能已经消耗额度。确认只解除阻塞，不自动重发；随后点击“从已保存步骤继续”连续完成，会产生新的调用，仅补未完成步骤。" : "这次中断的用量未知，可能已经消耗额度。确认只解除阻塞，不代表未计费；随后继续会产生新的调用，仅补未完成部分。"}</p> : null}</div>;
  })}</section>;
}
export function ReplanAction({ visible, disabled, onClick }: { visible: boolean; disabled: boolean; onClick: () => void }) {
  if (!visible) return null;
  return <div className={styles.replan}><p>可为你主动请求的待设计单元补充幻想规划；一次 CLI 调用。旧记录保留，不自动开始主创，也不强制加入搞笑内容。</p><button type="button" disabled={disabled} onClick={onClick}>补充幻想规划（一次CLI调用）</button></div>;
}
const selectedForMode = (mode: Mode, candidates: Fantasy[], current: string[], overrides: Record<string, boolean>) => {
  if (mode === "off") return [];
  const selected = new Set(mode === "all" ? candidates.map(candidate => candidate.id) : mode === "review" ? current : candidates.filter(candidate => candidate.recommended).map(candidate => candidate.id));
  for (const [id, checked] of Object.entries(overrides)) checked ? selected.add(id) : selected.delete(id);
  return candidates.filter(candidate => selected.has(candidate.id)).map(candidate => candidate.id);
};

export function StoryboardWorkbench({ episodeId, episodeTitle }: { episodeId: string; episodeTitle: string }) {
  const [index, setIndex] = useState<Index | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [runId, setRunId] = useState("");
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [notice, setNotice] = useState("");
  const [sourceDiagnostics, setSourceDiagnostics] = useState<SourceDiagnostic[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const busyRef = useRef(false);
  const [settings, setSettings] = useState<{ maxUnitSeconds: 15 | 30; fantasyMode: Mode; notes: string; maxCalls: number; maxTokens: number }>({ maxUnitSeconds: 30, fantasyMode: "recommended", notes: "", maxCalls: 32, maxTokens: 300000 });
  const [selection, setSelection] = useState<string[]>([]);
  const [selectionDirty, setSelectionDirty] = useState(false);
  const [packageIds, setPackageIds] = useState<string[]>([]);
  const [repairNotes, setRepairNotes] = useState("");
  const [budget, setBudget] = useState({ maxCalls: 32, maxTokens: 300000 });
  const [loading, setLoading] = useState(true);
  const currentId = useRef("");
  const requestVersion = useRef(0);
  const pendingRunReads = useRef(new Set<string>());
  const settingsRestorePending = useRef(false);
  const settingsReady = Boolean(index && !loading && (!runId || run?.id === runId));

  const readJson = useCallback(async (url: string, init?: RequestInit) => {
    const response = await fetch(url, { cache: "no-store", ...init });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || `请求失败（${response.status}）`), { status: response.status, code: data.code, creationOutcome: data.creationOutcome, diagnostics: data.diagnostics });
    return data;
  }, []);
  const loadIndex = useCallback(async () => { const data = await readJson(base(episodeId)); setIndex(data as Index); return data as Index; }, [episodeId, readJson]);
  const loadRun = useCallback(async (id: string, { preserveDraft = false, restoreSettings = false }: { preserveDraft?: boolean; restoreSettings?: boolean } = {}) => {
    const version = requestVersion.current;
    const requestKey = `${version}:${id}`;
    if (pendingRunReads.current.has(requestKey)) return;
    pendingRunReads.current.add(requestKey);
    try {
      const data = await readJson(`${base(episodeId)}?runId=${encodeURIComponent(id)}`);
      if (currentId.current !== id || requestVersion.current !== version) return;
      const next = data.run as Run;
      setRun(next);
      if (restoreSettings || settingsRestorePending.current) {
        setSettings(current => ({ ...current, maxUnitSeconds: next.settings.maxUnitSeconds, fantasyMode: next.settings.fantasyMode }));
        settingsRestorePending.current = false;
      }
      setReadError("");
      if (!preserveDraft) { setSelection(next.selection?.selectedIds || []); setSelectionDirty(false); }
      setBudget({ maxCalls: next.budget.maxCalls, maxTokens: next.budget.maxTokens });
    } catch (reason) {
      if (currentId.current === id && requestVersion.current === version) throw reason;
    } finally {
      pendingRunReads.current.delete(requestKey);
    }
  }, [episodeId, readJson]);
  const chooseRun = useCallback((id: string) => {
    requestVersion.current += 1;
    currentId.current = id;
    settingsRestorePending.current = Boolean(id);
    setRunId(id); setRun(null); setSelectionDirty(false); setError(""); setReadError(""); setNotice(""); setSourceDiagnostics([]);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      id ? url.searchParams.set("runId", id) : url.searchParams.delete("runId");
      window.history.replaceState(null, "", url);
    }
    if (id) void loadRun(id, { restoreSettings: true }).catch(reason => setReadError(messageOf(reason)));
  }, [loadRun]);
  useEffect(() => {
    let live = true;
    void loadIndex().then(data => {
      if (!live) return;
      const fromUrl = new URLSearchParams(window.location.search).get("runId");
      const id = data.runs.some(item => item.id === fromUrl) ? fromUrl! : data.runs[0]?.id || "";
      if (id) chooseRun(id);
    }).catch(reason => setError(messageOf(reason))).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [loadIndex, chooseRun]);
  useEffect(() => {
    if (!runId) return;
    const refresh = () => {
      if (busyRef.current || document.visibilityState === "hidden") return;
      void loadRun(runId, { preserveDraft: selectionDirty }).catch(reason => setReadError(`自动刷新失败：${messageOf(reason)}`));
    };
    const timer = run?.active ? window.setInterval(refresh, 2000) : undefined;
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [run?.active, runId, selectionDirty, loadRun]);
  const act = async (action: string, payload: Record<string, unknown> = {}) => {
    if (busyRef.current || (action === "create" && !settingsReady)) return;
    const acknowledgementKind = action === "acknowledge_cancel" ? run?.cancellations?.find(item => item.attemptId === payload.attemptId)?.kind : undefined;
    requestVersion.current += 1;
    busyRef.current = true; setBusy(true); setPendingAction(action === "start" ? `start:${payload.mode}` : acknowledgementKind === "usage" ? "acknowledge_usage" : acknowledgementKind === "timeout" ? "acknowledge_timeout" : acknowledgementKind === "failed" ? "acknowledge_failure" : action); setError(""); setSourceDiagnostics([]); setNotice(action === "create" ? "正在准备本集原文与平读参考；这一步不调用模型，最多约 45 秒。" : "");
    let createdRun: Run | undefined;
    try {
      const data = await readJson(base(episodeId), { method: "POST", headers: { "content-type": "application/json", "x-storyboard-action": "1" }, body: JSON.stringify({ action, ...action === "create" ? {} : { runId }, ...payload }) });
      const next = data.run as Run;
      if (next) {
        if (action === "create") createdRun = next;
        setReadError("");
        currentId.current = next.id; setRunId(next.id); setRun(next); setSelection(next.selection?.selectedIds || []); setSelectionDirty(false);
        setBudget({ maxCalls: next.budget.maxCalls, maxTokens: next.budget.maxTokens });
        const url = new URL(window.location.href); url.searchParams.set("runId", next.id); window.history.replaceState(null, "", url);
      }
      await loadIndex();
      setNotice(action === "create" ? "任务已建立，尚未调用模型。" : action === "start" ? "运行请求已受理，进度会自动更新。" : action === "pause" ? "已请求暂停后续派单，正在保存已有回包。" : action === "stop" ? "已提交立即中断请求，请以任务状态为准。" : acknowledgementKind === "usage" ? "已接受未知用量；已保存结果保留，未启动新调用。若需继续制作，请明确点击“连续完成”，仅补未完成步骤。" : acknowledgementKind === "timeout" ? "已确认超时风险；不代表已退费，未启动新调用。可点击“从已保存步骤继续”连续完成，仅补未完成步骤。" : acknowledgementKind === "failed" ? "已确认失败风险；未自动重发。可点击“从已保存步骤继续”连续完成，仅补未完成步骤。" : action === "acknowledge_cancel" ? "已确认中断风险；未启动新调用，可以从已保存步骤继续。" : "操作已保存。请核对下方最新状态。");
    } catch (reason) {
      setError(messageOf(reason));
      if (action === "create") {
        const failure = reason as RequestError;
        const notCreated = failure?.code === "SOURCE_DIAGNOSTICS" && failure.creationOutcome === "NOT_CREATED";
        setSourceDiagnostics(notCreated && Array.isArray(failure.diagnostics) ? failure.diagnostics : []);
        setNotice(createdRun ? "任务已建立，尚未调用模型；任务列表刷新失败，请刷新页面核对。" : notCreated ? "" : "新建结果尚未确认。请刷新页面核对任务列表，避免重复创建。");
      }
      if (runId) await loadRun(runId, { preserveDraft: selectionDirty }).catch(() => {});
    } finally { busyRef.current = false; setBusy(false); setPendingAction(""); }
  };
  const acknowledgeCancellation = (attemptId: string) => {
    const kind = run?.cancellations?.find(item => item.attemptId === attemptId)?.kind;
    const prompt = kind === "usage" ? "本次结果已保存，但用量未知，实际消耗可能未完整统计。确认只解除费用阻断，不会自动重发，也不重跑已完成步骤；若需继续，请另行点击“连续完成”，仅补未完成步骤。未知部分不记为零，Token停止线只能按已知用量统计。是否确认？" : kind === "timeout" ? "本次调用超时且没有完整回包，用量未知，可能已经消耗额度。确认不代表已退费，只解除阻塞，不会自动重发；随后点击“从已保存步骤继续”连续完成，会新调用模型，仅补未完成步骤，Token停止线只能按已知用量统计。是否确认？" : kind === "failed" ? "本次调用执行失败且没有完整回包，用量未知，可能已经消耗额度。确认只解除阻塞，不会自动重发；随后点击“从已保存步骤继续”连续完成，会新调用模型，仅补未完成步骤，Token停止线只能按已知用量统计。是否确认？" : "本次请求已中断且没有完整回包，用量未知，可能已经消耗额度。确认后保留此记录并解除阻塞；点击继续时会新调用模型，只补未完成部分，Token停止线只能按已知用量统计。是否确认？";
    if (window.confirm(prompt)) void act("acknowledge_cancel", { attemptId, acceptUnknownUsage: true });
  };
  const needReset = () => !run?.adopted?.length || window.confirm("已有正文草稿。更改幻想选择会保留旧稿历史并重新生成正文，不重跑规划。继续吗？");
  const changeMode = (mode: Mode) => {
    if (!run || !needReset()) return;
    setSelectionDirty(false);
    void act("choice", { mode, overrides: {}, unitOverrides: {}, expectedFingerprint: run.selection.fingerprint, ...(run.adopted.length ? { resetDrafts: true } : {}) });
  };
  const changeCandidate = (candidate: Fantasy, checked: boolean) => {
    if (!run || !needReset()) return;
    const overrides = { ...(run.choice.overrides || {}), [candidate.id]: checked };
    setSelection(selectedForMode(run.choice.mode, run.plan?.fantasyCandidates || [], run.selection.selectedIds, overrides));
    setSelectionDirty(true);
    void act("choice", { mode: run.choice.mode, overrides, unitOverrides: run.choice.unitOverrides || {}, expectedFingerprint: run.selection.fingerprint, ...(run.adopted.length ? { resetDrafts: true } : {}) });
  };
  const changeUnit = (unitId: string, checked: boolean) => {
    if (!run?.plan || !needReset()) return;
    const unit = run.plan.provisionalUnits.find(item => item.id === unitId);
    if (!unit) return;
    const next = { ...(run.choice.unitOverrides || {}), [unitId]: checked };
    setSelectionDirty(true);
    void act("choice", { mode: run.choice.mode, overrides: run.choice.overrides || {}, unitOverrides: next, expectedFingerprint: run.selection.fingerprint, ...(run.adopted.length ? { resetDrafts: true } : {}) });
  };
  const state = run ? deriveWorkbenchState(run, Boolean(index?.runner.ready)) : null;
  const downloadable = Boolean(state?.downloadable);
  const canMutate = Boolean(run && !busy && !run.active && !run.sourceStale && !state?.unresolved);
  const canRun = Boolean(canMutate && state?.canRun && budget.maxCalls > 0 && budget.maxTokens > 0);
  const candidates = run?.plan?.fantasyCandidates || [];
  const mode = run?.choice?.mode || run?.settings.fantasyMode || "recommended";
  const selected = selectionDirty ? selection : run?.selection?.selectedIds || [];
  const sourceWarnings = mergeSourceWarnings(index?.sourceWarnings, run?.sourceWarnings);

  return <section className={`${styles.workbench} studioSection`} aria-label="分镜制作工作台">
    <header className={styles.header}><div><span className={styles.eyebrow}>分镜制作</span><h1>{episodeTitle}</h1><p>从本集已有原文开始，先统筹情绪与粗单元，再创作分镜，最后统一整编。</p></div><span className={styles.badge}>GPT-6.1 Sol · CLI 中档</span></header>
    <div className={styles.roles} aria-label="制作岗位">
      <article><span>01</span><strong>情绪统筹</strong><p>理解原文、规划情绪起伏与粗单元，供你审看幻想选择。</p><small>{state?.planLabel || "等待规划"}</small></article>
      <article><span>02</span><strong>完整主创</strong><p>{index ? `全局最多 ${index.maxConcurrent} 路${index.maxPerEpisode !== undefined ? `，单集最多 ${index.maxPerEpisode} 路` : ""}。` : ""}按工作包独立完成画面、表演、镜头与声音。</p><small>{run?.plan && state ? `${state.authorDone}/${state.total} 工作包完成` : state?.planFailure ? "规划待修，主创未开始" : "等待规划"}</small></article>
      <article><span>03</span><strong>统一整编</strong><p>核对来源与结构，整合可复制、可导出的完整分镜。</p><small>{run?.plan && state ? `${state.finishDone}/${state.total} 工作包完成` : "等待主创"}</small></article>
    </div>
    <p className={styles.fine}>内部 9 项专业技能会协作完成三张岗位卡，并非 9 个独立岗位。运行会消耗你的 CLI 账户额度。</p>
    {loading ? <p role="status">正在读取本集任务…</p> : null}
    {error || readError ? <div className={styles.error} role="alert">{error || readError}{sourceDiagnostics.length ? <ul>{sourceDiagnostics.map((problem, i) => <li key={`${problem.rowId}:${i}`}>{problem.line ? `第 ${problem.line} 行` : "原文位置"}（{problem.rowId}）{problem.sourceFileLine ? `，源文件第 ${problem.sourceFileLine} 行` : ""}：原文片段“{problem.text}”；{problem.reason}</li>)}</ul> : null}</div> : null}
    {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
    {index && !index.runner.ready ? <p className={styles.error} role="status">运行环境未就绪：{index.runner.message}</p> : null}
    {sourceWarnings.length ? <details className={styles.warningDetails}><summary>资料提示（{sourceWarnings.length} 项）</summary><ul>{sourceWarnings.map(warning => <li key={warning}>{warning}</li>)}</ul></details> : null}

    <section className={styles.panel} aria-label="任务设置"><div className={styles.row}><h2>制作任务</h2>{index?.runs.length ? <label>查看任务 <select value={runId} disabled={busy} onChange={event => chooseRun(event.target.value)}>{index.runs.map(item => <option key={item.id} value={item.id}>{item.title} · {label(item.status, statusLabels)} · {dateLabel(item.createdAt)}</option>)}</select></label> : null}</div>
      <h3>新建任务参数</h3><p className={styles.fine}>首次读取或切换任务会带入其已保存模式与单元上限。这里的修改仅用于下次新建，不改变当前任务。</p>
      {!settingsReady && !loading && runId ? <p role="status">任务参数尚未就绪；读取成功后才能新建。</p> : null}
      <div className={styles.formGrid}><label>单元上限 <select value={settings.maxUnitSeconds} disabled={busy || !settingsReady} onChange={event => setSettings({ ...settings, maxUnitSeconds: Number(event.target.value) as 15 | 30 })}><option value={15}>15 秒</option><option value={30}>30 秒</option></select></label><label>幻想处理 <select value={settings.fantasyMode} disabled={busy || !settingsReady} onChange={event => setSettings({ ...settings, fantasyMode: event.target.value as Mode })}>{Object.entries(modeLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
      <p className={styles.fine}>“全部加入”采用全部已有幻想候选；没有候选的粗单元默认跳过额外幻想，不要求每段都有幻想。</p>
      <p className={styles.fine}>Q版与幻想按情绪和语义持续，合适的长OS可全段使用，不设单元比例上限；从整集避免幻想喧宾夺主。旧任务保留原规则与记录。</p>
      <details className={styles.advancedDetails}><summary>高级设置（可选）</summary>
        <div className={styles.formGrid}><label>最多调用次数 <input type="number" min={0} value={settings.maxCalls} disabled={busy || !settingsReady} onChange={event => setSettings({ ...settings, maxCalls: Number(event.target.value) })} /></label><label>计划 Token 停止线 <input type="number" min={0} value={settings.maxTokens} disabled={busy || !settingsReady} onChange={event => setSettings({ ...settings, maxTokens: Number(event.target.value) })} /></label></div>
        <label className={styles.fullLabel}>创作备注 <textarea value={settings.notes} disabled={busy || !settingsReady} rows={2} onChange={event => setSettings({ ...settings, notes: event.target.value })} placeholder="可选：只写你对这集的补充要求" /></label>
        <p className={styles.fine}>预算是运行停止线，不是账单硬封顶；设为 0 可禁止继续调用模型。新建任务不自动调用模型。</p>
      </details>
      <div className={styles.actions}><button type="button" className={styles.primary} disabled={busy || !settingsReady} onClick={() => void act("create", { settings: { maxUnitSeconds: settings.maxUnitSeconds, fantasyMode: settings.fantasyMode }, notes: settings.notes, maxCalls: settings.maxCalls, maxTokens: settings.maxTokens })}>新建任务（仅准备）</button>{run ? <><button type="button" disabled={!canRun} onClick={() => void act("start", { mode: "next" })}>{state?.nextLabel || "先分析"}</button><button type="button" disabled={!canRun} onClick={() => void act("start", { mode: "all" })}>{run.status === "paused" ? "从已保存步骤继续" : "连续完成"}</button><button type="button" disabled={!run.active || busy || run.status === "pausing"} onClick={() => void act("pause")}>暂停（保留回包）</button>{run.active ? <button type="button" disabled={busy} onClick={() => { if (window.confirm("立即中断可能失去正在生成的回包，已发出的请求仍可能消耗额度。若希望保存本次结果后再停，请使用暂停。仍要立即中断吗？")) void act("stop"); }}>立即中断</button> : null}</> : null}</div>
      <p className={styles.fine}>新建仅准备原文；“先分析”只到规划；“连续完成”会继续主创与整编，遇确认、校验问题或停止线时暂停。</p>
      <RunFeedback state={state} error={run?.error} pendingAction={pendingAction} disabled={busy} onRecheck={() => { if (state?.planFailure) void act("recheck", { candidateId: state.planFailure.id }); }} />
      {run && !run.active ? <RecoveryActions operations={run.operations} cancellations={run.cancellations || []} disabled={busy || run.sourceStale} onRecover={attemptId => void act("recover", { attemptId })} onAcknowledge={acknowledgeCancellation} /> : null}
      {run?.active ? <p className={styles.fine}>暂停不再派新请求，已在途结果会保存；立即中断可能无法取回完整结果和用量。</p> : null}
    </section>

    {run ? <>
      <section className={styles.panel} aria-label="当前状态"><div className={styles.row}><h2>当前进度</h2><span className={styles.badge}>{label(run.status, statusLabels)}{run.active ? " · 运行中" : ""}</span></div>
        <p className={styles.fine} aria-label="当前任务已保存参数">当前任务：单元上限 {run.settings.maxUnitSeconds} 秒 · 幻想处理 {modeLabels[mode]}</p>
        {run.scheduling ? <p className={styles.fine} aria-label="本任务调度状态">本任务：占用执行位 {run.scheduling.inFlight} · 排队 {run.scheduling.queued}；这是本机调度状态，不代表模型已收到请求或正在推理。</p> : null}
        {run.sourceStale ? <p className={styles.warning}>原文或前情资料已更新。旧稿可查看；请新建任务后再继续制作。</p> : null}
        {state?.unresolved ? <p className={styles.warning}>{state.usageReview ? "回包已保存，仅用量待确认；未知费用不等于零。请使用上方确认入口，不重跑已完成步骤。" : "上次调用结果尚未确认。请查看执行记录和候选回执，不要盲目重发。"}</p> : null}
        {run.plan && run.selection?.status === "awaiting_confirmation" ? <p className={styles.warning}>幻想选择尚待确认。可继续审看原文和候选；确认后才能推进正文。</p> : null}
        {run.plan && run.selection?.status === "needs_design" ? <p className={styles.warning}>你主动请求的粗单元尚无幻想设计；请取消该请求或补充规划后再推进正文。</p> : null}
        {run.plan && run.selection?.status === "needs_design" && run.adopted.length ? <p className={styles.warning}>已有正文草稿。请先在幻想选择中明确重做选择并确认；补规划不会直接覆盖现稿。</p> : null}
        <ReplanAction visible={Boolean(run.plan && !state?.planFailure && run.selection?.status === "needs_design")} disabled={!state?.canReplan || busy || budget.maxCalls <= 0 || budget.maxTokens <= 0} onClick={() => void act("replan")} />
        {state?.current ? <p className={styles.fine}>当前正在{label(state.current.stage || "", stageLabels)}{state.current.packageIds?.length ? ` · 工作包 ${state.current.packageIds.join("、")}` : ""}</p> : null}
        <p className={styles.fine}>{run.usage?.complete ? "已用" : "已知用量"} {run.usage?.totalTokens ?? 0} Token（输入 {run.usage?.inputTokens ?? 0}、输出 {run.usage?.outputTokens ?? 0}、缓存输入 {run.usage?.cachedInputTokens ?? 0}）；统计{run.usage?.complete ? "完整" : "未完整，不等于实际总消耗"}。最多返修 {run.budget.maxRepairs} 次。</p>
        {(run.usage?.acknowledgedUnknownAttempts || 0) > 0 ? <p className={styles.warning}>有 {run.usage.acknowledgedUnknownAttempts} 次调用的用量未知，已由你确认继续；未知部分没有记成零，也未计入上面的已知用量。</p> : null}
        <details className={styles.advancedDetails}><summary>高级额度设置</summary>
          <div className={styles.formGrid}><label>调用次数停止线 <input type="number" min={0} value={budget.maxCalls} disabled={!canMutate} onChange={event => setBudget({ ...budget, maxCalls: Number(event.target.value) })} /></label><label>Token 停止线 <input type="number" min={0} value={budget.maxTokens} disabled={!canMutate} onChange={event => setBudget({ ...budget, maxTokens: Number(event.target.value) })} /></label></div>
          <button type="button" disabled={!canMutate} onClick={() => void act("budget", budget)}>保存预算</button>
        </details>
      </section>
      <section className={styles.panel} aria-label="原文与规划"><h2>{run.plan ? "情绪规划与粗单元" : "本集原文位置"}</h2>
        {!run.plan ? <p className={styles.fine}>{state?.noPlanMessage}</p> : <><p className={styles.prose}>{run.plan.emotionArc}</p><div className={styles.cards}>{run.plan.workPackages.map(item => <article className={styles.card} key={item.id}><strong>工作包 {item.id}</strong><p>情绪主体：{item.emotionContract.subject}</p><p>场景基调：{item.emotionContract.contextTone}</p><p>观众感受：{item.emotionContract.audienceEffect}</p><p>变化与落点：{item.emotionContract.change} → {item.emotionContract.landing}</p>{item.emotionContract.retain?.length ? <p>须保留：{item.emotionContract.retain.join("；")}</p> : null}<p className={styles.fine}>依赖：{item.dependsOn?.join("、") || "无"}</p></article>)}</div></>}
        <details><summary>查看原文短摘与位置（{run.sourceRows?.length || 0} 处）</summary><ol className={styles.sourceList}>{run.sourceRows?.map(row => <li key={row.id}><code>{row.id}</code><span>{row.text}</span></li>)}</ol></details>
      </section>
      {run.plan ? <section className={styles.panel} aria-label="幻想选择"><h2>幻想段落选择</h2><p className={styles.fine}>下方是情绪与容量初排，不是最终视频单元；同一完整事件在容量内优先合并，必要时再分段。四种幻想模式可切换；选择变化后需重新生成正文。</p><div className={styles.modeGrid}>{(Object.keys(modeLabels) as Mode[]).map(value => <button type="button" key={value} className={value === mode ? styles.selectedMode : ""} aria-pressed={value === mode} disabled={!canMutate} onClick={() => changeMode(value)}>{modeLabels[value]}</button>)}</div>
        {mode === "all" ? <p className={styles.fine}>“全部加入”仅采用已有候选；无候选单元默认跳过额外幻想。只有主动勾选才会请求补设计。</p> : null}
        <div className={styles.cards}>{run.plan.provisionalUnits.map(unit => { const related = candidates.filter(item => item.anchorRefs.some(ref => unit.sourceRefs.includes(ref))); const unitSelected = related.length > 0 ? related.every(item => selected.includes(item.id)) : mode !== "off" && run.choice.unitOverrides?.[unit.id] === true; return <article className={styles.card} key={unit.id}><div className={styles.row}><strong>粗单元 {unit.id}</strong><span>{Array.isArray(unit.secondsRange) ? unit.secondsRange.join("–") : unit.secondsRange} 秒</span></div><p className={styles.fine}>工作包 {unit.packageId} · 原文 {unit.sourceRefs.join("、")}</p><label className={styles.check}><input type="checkbox" checked={unitSelected} disabled={!canMutate || mode === "off"} onChange={event => changeUnit(unit.id, event.target.checked)} />{related.length ? `本单元加入相关幻想（${related.length} 项）` : "希望加入幻想（待设计）"}</label>{!related.length ? <p className={styles.fine}>{unitSelected ? "已主动请求额外幻想，当前待设计；取消勾选可继续按真实表演制作。" : "无幻想候选，默认跳过额外幻想；真实表演与情绪强度不降低。"}</p> : null}{sourceExcerpt(run.sourceRows, unit.sourceRefs).map(row => <p className={styles.excerpt} key={row.id}><code>{row.id}</code> {row.text}</p>)}</article>; })}</div>
        <h3>候选片段</h3><div className={styles.cards}>{candidates.map(candidate => <article className={styles.card} key={candidate.id}><label className={styles.check}><input type="checkbox" checked={selected.includes(candidate.id)} disabled={!canMutate || mode === "off"} onChange={event => changeCandidate(candidate, event.target.checked)} /><strong>{candidate.subject}</strong>{candidate.recommended ? <span className={styles.tag}>推荐</span> : null}</label><p>{candidate.emotionPurpose}</p><p className={styles.prose}>{candidate.proposal}</p>{sourceExcerpt(run.sourceRows, candidate.anchorRefs).map(row => <p className={styles.excerpt} key={row.id}><code>{row.id}</code> {row.text}</p>)}</article>)}</div>
        {mode === "review" ? <button type="button" className={styles.primary} disabled={!canMutate} onClick={() => { if (needReset()) void act("confirm", { selectedIds: selected, expectedFingerprint: run.selection.fingerprint, ...(run.adopted.length ? { resetDrafts: true } : {}) }); }}>确认幻想选择</button> : null}
        <p className={styles.fine}>当前已选 {selected.length} 项 · 选择状态：{run.selection?.status || "未确认"}</p>
      </section> : null}
      {run.plan ? <section className={styles.panel} aria-label="局部返修"><h2>局部返修</h2><p className={styles.fine}>只选择有问题的工作包，并写明问题；保留其他已采纳内容。</p><div className={styles.checkGrid}>{run.plan.workPackages.map(item => <label className={styles.check} key={item.id}><input type="checkbox" checked={packageIds.includes(item.id)} disabled={!canMutate} onChange={event => setPackageIds(event.target.checked ? [...packageIds, item.id] : packageIds.filter(id => id !== item.id))} />工作包 {item.id}</label>)}</div><label className={styles.fullLabel}>需要修正的问题 <textarea value={repairNotes} disabled={!canMutate} rows={3} onChange={event => setRepairNotes(event.target.value)} /></label><button type="button" disabled={!canMutate || !packageIds.length || !repairNotes.trim()} onClick={() => void act("repair", { packageIds, notes: repairNotes.trim() })}>提交局部返修</button></section> : null}
      <section className={styles.panel} aria-label="执行与候选历史"><h2>执行与候选历史</h2>{run.adopted?.length ? <p className={styles.fine}>已采纳：{run.adopted.map(item => `${item.stage} ${item.packageIds.join("、")}（${item.unitCount} 单元、${item.shotCount} 镜、${item.seconds} 秒）`).join("；")}</p> : <p className={styles.fine}>尚无已采纳正文。</p>}
        <div className={styles.history}>{run.operations?.map(item => <details key={item.attemptId}><summary>{label(item.stage, stageLabels)} · {label(item.status, statusLabels)} · {dateLabel(item.createdAt)} · 工作包 {item.packageIds.join("、") || "全部"}</summary><p>结束方式：{item.finishMode}</p>{item.error ? <p className={styles.error}>{messageOf(item.error)}</p> : null}<p className={styles.fine}>尝试编号：{item.attemptId}</p>{item.status !== "completed" || item.canRecoverSaved ? <button type="button" disabled={!canMutate} onClick={() => void act("recover", { attemptId: item.attemptId })}>核对并恢复这次结果</button> : null}</details>)}{run.candidates?.map(item => <details key={item.id}><summary>候选 {label(item.stage, stageLabels)} · {item.resolvedBy ? "已修复（历史）" : label(item.status, statusLabels)} · 工作包 {item.packageIds.join("、") || "全部"}</summary><p className={styles.fine}>候选编号：{item.id}</p>{item.errors?.length ? <ul>{item.errors.map((problem, i) => <li key={i}>{messageOf(problem)}</li>)}</ul> : <p>未记录问题。</p>}<pre>{JSON.stringify(item.validation, null, 2)}</pre><button type="button" disabled={!canMutate || state?.unresolved || Boolean(item.resolvedBy)} onClick={() => void act("recheck", { candidateId: item.id })}>重新核查候选（不调用模型）</button></details>)}</div>
      </section>
      <section className={styles.panel} aria-label="完整分镜"><div className={styles.row}><h2>完整分镜</h2><div className={styles.actions}><button type="button" disabled={!run.assembly?.text} onClick={() => void navigator.clipboard.writeText(run.assembly?.text || "").then(() => setNotice("已复制整稿。"), reason => setError(`复制失败：${messageOf(reason)}`))}>复制整稿</button><a className={!downloadable ? styles.disabledLink : ""} aria-disabled={!downloadable} href={downloadable ? `${base(episodeId)}?runId=${encodeURIComponent(run.id)}&format=md` : undefined} download>导出 Markdown</a><a href={`${base(episodeId)}?runId=${encodeURIComponent(run.id)}&format=json`} download>导出 JSON 历史</a></div></div>
        {run.assembly?.errors?.length ? <ul className={styles.error}>{run.assembly.errors.map((item, i) => <li key={i}>{messageOf(item)}</li>)}</ul> : null}{run.assembly?.warnings?.length ? <ul className={styles.warning}>{run.assembly.warnings.map((item, i) => <li key={i}>{messageOf(item)}</li>)}</ul> : null}<pre className={styles.assembly}>{run.assembly?.text || "整稿尚未生成。完成创作与整编后可在这里查看。"}</pre>{!downloadable ? <p className={styles.fine}>整稿未完成或仍有错误，暂不可导出 Markdown。</p> : null}
      </section>
    </> : null}
  </section>;
}
