import { STAGE_LABELS, operationLabel, statusLabel, type Candidate, type Run, type Operation } from "./types";
import type { WorkflowGlassState } from "@/app/ui/workflow-glass";

export function executionLabel(operation: Operation) {
  if(operation.localPhase==='queued') return '排队中';
  return ({starting:'本机启动中',waiting:operation.execution?.lastProgressAt?'等待后续输出':'等待首个输出',generating:'生成中',receiving:'接收回包',completed:'回包已保存'} as Record<string,string>)[operation.execution?.phase??'']
    || (operation.localPhase==='executing'?'本机执行中':'准备与回包处理中');
}
const generating = (operation: Operation) => operation.localPhase === 'executing' && (!operation.execution || operation.execution.phase === 'generating');

function executionDescription(operation?: Operation) {
  if (!operation) return '正在核对已保存结果并准备下一步；尚未确认有新的模型请求执行。';
  if (operation.localPhase === 'queued') return '本步骤正在等待本机执行名额，尚未启动这次 CLI；轮到后会继续，无需重复点击。';
  if (operation.execution?.phase === 'starting') return '正在启动本机 CLI，尚未收到执行输出；无需重复点击。';
  if (operation.execution?.phase === 'waiting') return operation.execution.lastProgressAt
    ? '本机 CLI 已启动，正在等待后续有效输出；暂未收到新的生成进展，无需重复点击。'
    : '本机 CLI 已启动，正在等待首个有效输出；暂不能确认生成进展，无需重复点击。';
  if (operation.execution?.phase === 'generating') return `已收到生成进展，正在完成${operationLabel(operation)}；回包保存后会更新本步骤结果。`;
  if (operation.execution?.phase === 'receiving' || operation.execution?.phase === 'completed') return '正在接收并核查本步骤回包，核查后更新步骤与保存成果；无需重复派发。';
  return operation.localPhase === 'executing' ? '本机执行器正在处理当前步骤；该记录没有更细的输出进展，请以回包与执行记录为准。' : '正在准备本步骤资料或处理回包，尚未确认新的模型生成进展。';
}

export function deriveView(run: Run, runnerReady: boolean) {
  const preparationUnavailable=run.preparation?.ready===false&&!run.preparation.deferred;
  const unresolved = run.status === "unknown" || run.status === "interrupted" || run.operations.some(op => op.status === "unknown" && !op.cancelAcknowledgement?.acceptUnknownUsage || !run.active && op.status === "running");
  const total = run.plan?.workPackages.length || 0;
  const coverage = (stages: string[]) => new Set(run.adopted.filter(item => stages.includes(item.stage)).flatMap(item => item.packageIds)).size;
  const authorDone = coverage(["author", "finish"]), finishDone = coverage(["finish"]);
  const liveOperations = run.active && !run.legacyReadOnly ? run.operations.filter(op => op.status === 'running') : [];
  const current = liveOperations.filter(generating);
  const queued = liveOperations.filter(op => op.localPhase === 'queued');
  const liveOperation = current[0] || liveOperations[0];
  const currentStartedAt = liveOperations.map(op => op.execution?.startedAt || op.createdAt).sort()[0];
  const planFailure = run.candidates.slice().reverse().find(c => c.stage === "plan" && ["needs_repair", "needs_dependency_repair"].includes(c.status) && !c.resolvedBy);
  const repairCandidate = run.candidates.slice().reverse().find(c => ["needs_repair", "needs_dependency_repair"].includes(c.status) && !c.resolvedBy);
  const repairNeedsRecheck = Boolean(run.repairControl?.needsRecheck);
  const repairStopped = Boolean(run.repairControl?.blocked || !run.repairControl && ["REPAIR_NO_PROGRESS", "REPAIR_LIMIT", "FEEDBACK_REPAIR_SCOPE"].includes(run.error?.code || ""));
  const selectionBlocked = Boolean(run.plan && ["awaiting_confirmation", "needs_design"].includes(run.selection?.status || ""));
  const ready = run.status === "text_ready_for_review" && Boolean(run.assembly?.text) && !run.assembly?.errors?.length && !run.production?.pendingRepair && !run.production?.blocking;
  const knownTokens = run.usage.knownTokens ?? run.usage.totalTokens;
  const missingUsage = !run.active && (run.usage.unknownAttempts || 0) > (run.usage.acknowledgedUnknownAttempts || 0);
  const shared=run.production?.sharedBudget;
  const sharedReason=shared&&'unavailable' in shared?'共享预算暂不可读取':shared&&shared.unknownAttempts?'本轮共享预算有未知用量，先恢复核对回执':shared&&(shared.calls>=shared.maxCalls||shared.knownTokens>=shared.maxTokens)?'本轮共享预算已到停止线':'';
  const budgetReason = sharedReason || (run.operations.length >= run.budget.maxCalls ? "已达到调用次数停止线" : knownTokens >= run.budget.maxTokens ? "已达到已知 Token 停止线" : missingUsage ? "部分调用用量尚未核清" : "");
  const mutable = !run.legacyReadOnly && !run.active && !run.sourceStale && !run.sourceCheckPending && !run.blocked && !unresolved;
  const canCharge = mutable && runnerReady && !budgetReason && !run.production?.blocking && !repairStopped && !repairNeedsRecheck;
  const stage = liveOperation && STAGE_LABELS[liveOperation.stage] ? liveOperation.stage : !run.plan || planFailure ? "plan" : selectionBlocked ? "choice" : authorDone < total ? "author" : finishDone < total || !ready ? "finish" : "ready";
  const stageTitle = stage === "choice" ? "幻想选择" : stage === "ready" ? "文字稿已形成" : STAGE_LABELS[stage];
  const activityLabel = liveOperation ? executionLabel(liveOperation) : "准备下一步";
  const title = run.sourceStale ? "资料已更新，旧稿仍保留" : unresolved ? "先核对已有回包" : run.active ? run.status === "pausing" ? "正在保存回包并暂停" : `${liveOperation ? operationLabel(liveOperation) : stageTitle} · ${activityLabel}` : ready ? "完整文字稿，等待你审看" : planFailure ? "规划已返回，需要定向处理" : statusLabel(run.status);
  const description = run.sourceStale ? "请用最新资料新建任务；这里的历史与已付费结果不会被覆盖。" : unresolved ? "请求可能仍在执行或尚无完整回执。先检查已保存结果，不重复派发。" : run.active && run.status === 'pausing' ? '已停止新的派单，正在等待当前回包保存；保存后暂停，不会继续下一步骤。' : run.active && liveOperation?.feedbackRepair ? `${executionDescription(liveOperation)} 只修资料回执中的错误字段，不重写情绪规划、分镜或对白；原稿与已付回包保留。` : run.active ? executionDescription(liveOperation) : ready ? "程序检查与整编已完成。文字、实际配音/视频和你的认可分别验收。" : budgetReason ? `${budgetReason}。可查看记录并调整停止线，保存不会自动启动模型。` : run.selection?.status === "awaiting_confirmation" ? "先审看下面的幻想推荐，确认本次选择后再开始正文创作。" : run.selection?.status === "needs_design" ? "部分选中位置没有方案。可以取消对应请求，或单独补充规划。" : run.status === "paused" ? "已保留完成步骤。继续时只推进未完成部分。" : !run.plan ? "先完成本集情绪统筹，再由同一主创组织完整事件的表演、摄影与声音。" : "查看情绪与选择，继续完成主创和整编。";
  const budgetStopped=Boolean(budgetReason&&!run.active&&!ready&&!run.sourceStale&&!unresolved);
  const budgetDescription=sharedReason?`${sharedReason}。请核对本轮共享回执；本任务的停止线或风险确认不会解除共享暂停。`
    : `${budgetReason}：本任务已知用量 ${knownTokens.toLocaleString('zh-CN')} Token，停止线 ${run.budget.maxTokens.toLocaleString('zh-CN')} Token；已记录 ${run.operations.length} / ${run.budget.maxCalls} 次调用。已有成果保留，未启动新的请求。需要继续时，先明确调整停止线，再手动继续；不会自动重做已完成步骤。`;
  const repairDescription=run.production?.pendingRepair?.reason==='CONSUMED_MATERIAL'?'已消费的制作材料已补充，需要按受影响工作包核对；正确稿与历史保留。'
    : run.production?.pendingRepair?.reason==='EPISODE_BOUNDARY'?'上集实际尾态与本集入口存在差异，需要局部核对；未受影响稿件保留。':run.production?.pendingRepair?.reason||'制作材料需要局部核对；已有成果保留。';
  return { unresolved, total, authorDone, finishDone, current, queued, currentStartedAt, activityLabel, planFailure, repairCandidate, repairStopped, repairNeedsRecheck, ready, stage, stageTitle,
    title: run.legacyReadOnly ? '旧版任务 · 只读保留' : run.sourceCheckPending ? title : preparationUnavailable ? "资料暂不可读，历史仍保留" : budgetStopped ? '已到运行停止线，成果已保存' : !run.active && run.production?.pendingRepair ? '承接局部待补，正确稿保留' : run.production?.blocking ? '制作材料待补充' : title,
    description: run.legacyReadOnly ? '旧版不再继续、改选或返修；原有文字与历史仍可查看和导出。新制作请创建当前版本任务。' : run.sourceCheckPending ? '已显示保存内容，正在核对资料更新；核对前不派发生成或正式交付。' : preparationUnavailable ? run.preparation?.error || "请检查本集资料读取；已有任务和回包仍可查看，不重新派发。" : !run.active && repairNeedsRecheck ? '旧回包的错误定位需要更新。先免费核查已保存内容，再决定是否只修具体字段；不会重新生成已有正文。' : !run.active && repairStopped ? '重复修复已停止，继续点击不会解决当前问题。先免费核查已有回包或查看具体错误；不开放无效付费重试。' : budgetStopped ? budgetDescription : !run.active && run.production?.pendingRepair ? repairDescription : description, budgetReason,
    canRun: canCharge && !ready && (!selectionBlocked || Boolean(planFailure)),
    canChangeChoice: mutable,
    canPause: !run.legacyReadOnly && run.active && run.status !== "pausing",
    canReplan: Boolean(canCharge && run.plan && !planFailure && run.selection?.status === "needs_design" && !run.adopted.length),
    canRepair: Boolean(canCharge && run.plan && run.adopted.length && !selectionBlocked),
    canRecheck: mutable,
    downloadable: run.legacyReadOnly ? Boolean(run.assembly?.text) : ready && !run.active && !run.sourceStale && !run.sourceCheckPending && !preparationUnavailable && !run.blocked,
    nextLabel: planFailure ? "定向修复并继续" : run.status === "paused" || run.status === "stopped" ? "继续制作" : "连续完成本集",
    endedRecords: run.operations.filter(op => op.status === "completed").length,
    respondedRecords: run.operations.filter(op => op.requestOutcome === "RESPONDED").length,
    tone: run.sourceStale || unresolved || run.error || ["failed", "needs_repair", "needs_dependency_repair"].includes(run.status) ? "attention" : run.active ? "running" : ready ? "complete" : "idle"
  };
}

/** Steps describe saved results and current requests independently of decorative glass motion. */
export function derivePhaseSteps(run?: Run | null, runnerReady = true) {
  const view = run ? deriveView(run, runnerReady) : null;
  return ([
    { id: "plan", number: "01", title: "情绪统筹", note: "完整事件 · 情绪落点 · 幻想机会" },
    { id: "author", number: "02", title: "完整主创", note: "表演 · 摄影 · 光影 · 声音联合创作" },
    { id: "finish", number: "03", title: "统一整编", note: "关联修整 · 单元衔接 · 完整交稿" }
  ] as const).map(phase => {
    const done = phase.id === "plan" ? Boolean(run?.plan && !view?.planFailure) : phase.id === "author" ? Boolean(view?.total && view.authorDone === view.total) : Boolean(view?.ready);
    const pending = [...(run?.operations || [])].reverse().find(operation => operation.stage === phase.id && (operation.status === "unknown" && !operation.cancelAcknowledgement?.acceptUnknownUsage || !run?.active && operation.status === "running"));
    const pendingCode = pending?.error && typeof pending.error === "object" ? pending.error.code : null;
    const isCurrent = Boolean(run && !run.legacyReadOnly && (view?.stage === phase.id || phase.id === "author" && view?.stage === "choice"));
    const liveOperation = run?.active && !run.legacyReadOnly ? run.operations.find(operation => operation.stage === phase.id && operation.status === 'running') : undefined;
    const candidateIssue = run?.candidates.some(candidate => candidate.stage === phase.id && !candidate.resolvedBy && ["needs_repair", "needs_dependency_repair"].includes(candidate.status));
    let state: WorkflowGlassState = "idle", label = phase.id === "plan" ? "待开始" : "待推进";
    if (run?.legacyReadOnly) { state = done ? 'complete' : 'idle'; label = '旧版只读'; }
    else if (view?.current.some(operation => operation.stage === phase.id)) { state = "running"; label = run?.status === "pausing" ? "保存后暂停" : run?.sourceStale ? "旧资料执行中" : executionLabel(view.current.find(operation=>operation.stage===phase.id)!); }
    else if (liveOperation) { state = "waiting"; label = run?.status === 'pausing' ? '保存后暂停' : executionLabel(liveOperation); }
    else if (phase.id==='finish' && run?.production?.pendingRepair) { state='attention';label='局部待补'; }
    else if (pending) { state = "attention"; label = pendingCode === "TIMEOUT" ? "超时待核对" : "执行待核对"; }
    else if (candidateIssue || phase.id === "plan" && view?.planFailure) { state = "attention"; label = "需要核对"; }
    else if (done) { state = "complete"; label = run?.sourceStale ? "历史已保存" : "已完成"; }
    else if (isCurrent && run?.sourceCheckPending) { state = "waiting"; label = "核对资料更新"; }
    else if (isCurrent && (run?.sourceStale || run?.preparation?.ready === false&&!run.preparation.deferred)) { state = "attention"; label = "资料待核对"; }
    else if (isCurrent && view?.stage === "choice") { state = "waiting"; label = run?.selection?.status === "needs_design" ? "待补充方案" : "等待你的确认"; }
    else if (isCurrent && run && ["paused", "stopped", "cancelled"].includes(run.status)) { state = "paused"; label = run.status === "paused" ? "已暂停" : "已中断"; }
    else if (isCurrent && run && ["failed", "assembly_failed", "needs_repair", "needs_dependency_repair"].includes(run.status)) { state = "attention"; label = "需要处理"; }
    else if (isCurrent && (run?.status === "budget_stop" || !runnerReady || run?.status === "waiting_dependencies")) { state = "waiting"; label = run?.status === "budget_stop" ? "停止线已到" : !runnerReady ? "等待本机连接" : "等待前置工作包"; }
    const detail = liveOperation ? `${executionLabel(liveOperation)} · ${liveOperation.feedbackRepair ? '仅修资料回执' : liveOperation.packageIds.length ? `本次 ${liveOperation.packageIds.length} 个工作包` : phase.id === 'plan' ? '本集情绪方案' : '整集核对与交稿'}` : phase.id === "plan" ? view?.planFailure ? "已有规划待核对" : run?.plan ? `${run.plan.workPackages.length} 个完整工作包` : "等待分析"
      : phase.id === "author" ? view?.total ? `${view.authorDone} / ${view.total} 工作包已采纳` : "等待情绪方案"
        : view?.total ? `${view.finishDone} / ${view.total} 工作包已整编` : "等待完整主创";
    return { ...phase, state, label, detail, isCurrent };
  });
}

export function formatCount(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(value)) return "未返回";
  return value >= 1000000 ? `${(value / 1000000).toFixed(2)}M` : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

export function candidateFeedback(candidate: Candidate) {
  const validation = candidate.validation && typeof candidate.validation === "object" ? candidate.validation as { errors?: unknown[]; warnings?: unknown[] } : {};
  const errors = [...(candidate.errors || []), ...(Array.isArray(validation.errors) ? validation.errors : [])];
  return { errors: [...new Map(errors.map(error => [JSON.stringify(error), error])).values()], warnings: Array.isArray(validation.warnings) ? validation.warnings : [] };
}

export function formatElapsed(start?: string, end?: string, now = Date.now()) {
  if (!start) return "—";
  const from = new Date(start).getTime(), to = end ? new Date(end).getTime() : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return "—";
  const seconds = Math.max(0, Math.floor((to - from) / 1000));
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
}

/** Project time stays identical in server HTML and the browser's first render. */
export function formatWorkbenchDate(value:string|number,options:Intl.DateTimeFormatOptions){
  return new Date(value).toLocaleString('zh-CN',{...options,timeZone:'Asia/Shanghai',hour12:false});
}
