"use client";

import { useEffect, useState } from "react";
import { ActivityPanel, PlanningPanel, ProductionPanel, ResultsPanel, SettingsPanel } from "./panels";
import { useWorkbench } from "./use-workbench";
import { derivePhaseSteps, deriveView, formatCount, formatElapsed, formatWorkbenchDate } from "./view-state";
import { WorkflowGlassRail, WorkflowGlassCard, workflowGlassStyles as glass } from "@/app/ui/workflow-glass";
import { MODE_LABELS, operationLabel, messageOf, statusLabel, type WorkbenchSnapshot } from "./types";
import { usePublishStoryboardStatus } from "./page-status";
import { RefinementPanel, productionViewRun, refinementActivityLabel } from "./refinement-panel";
import styles from "./workbench.module.css";
import {EPISODE_TOKEN_WARNING} from '@/runtime/production-policy.mjs';

type Tab = "plan" | "result" | "activity";
const tabs: { id: Tab; label: string }[] = [{ id: "plan", label: "情绪与幻想" }, { id: "result", label: "完整分镜" }, { id: "activity", label: "执行记录" }];
const pendingLabels: Record<string, string> = { create: "正在准备原文与平读参考…", start: "正在提交制作请求…", refine: "正在提交导演精修请求…", accept_refinement: "正在采用精修候选…", pause: "正在请求保存后暂停…", stop: "正在提交立即中断…", choice: "正在保存幻想选择…", confirm: "正在确认选择…", recover: "正在检查已有回包…", recheck: "正在重新核查候选…", replan: "正在提交补充规划…", repair: "正在提交关联返修…", budget: "正在保存运行停止线…", acknowledge_cancel: "正在保存风险确认…" };

function StageIcon() {
  return <svg viewBox="0 0 32 32" fill="none" aria-hidden="true"><rect x="5" y="10" width="22" height="17" rx="3" /><path d="m5 10 21-5 1 5M12 8l3 3m5-5 3 4M5 15h22m-14 4 6 3-6 3z" /></svg>;
}

export function StoryboardWorkbench({ episodeId, episodeTitle, projectId, episodeNumber, initialSnapshot }: { episodeId: string; episodeTitle: string; projectId: string; episodeNumber?: number; initialSnapshot?:WorkbenchSnapshot }) {
  const work = useWorkbench(episodeId,initialSnapshot);
  const { run, index, pending } = work;
  const [tab, setTab] = useState<Tab>(initialSnapshot?.run?.status==='text_ready_for_review'&&initialSnapshot.run.assembly?.text?'result':'plan'), [settingsOpen, setSettingsOpen] = useState(false), [now, setNow] = useState(initialSnapshot?.savedAt??Date.now());
  // Unknown connection status permits a request for server-side preflight, not a paid dispatch.
  const canRequestExecution=Boolean(index&&(index.runner.checked===false||index.runner.ready)&&(index.preparation?.ready!==false||index.preparation.deferred));
  const productionRun = run ? productionViewRun(run) : null;
  const refinementActivity = run ? refinementActivityLabel(run) : null;
  const view = productionRun ? deriveView(productionRun, canRequestExecution) : null;
  const phases = derivePhaseSteps(productionRun, canRequestExecution);
  const disabled = Boolean(pending) || work.detailLoading;
  const warnings = [...new Set([...(index?.sourceWarnings || []), ...(run?.sourceWarnings || [])])];
  const showSettings = settingsOpen || !work.loading && !work.runId;
  const knownTokens = run?.usage.knownTokens ?? run?.usage.totalTokens;
  const endedRecords = run?.operations.filter(operation => operation.status === "completed").length ?? 0;
  const currentStart = view?.currentStartedAt || (refinementActivity ? [...(run?.operations || [])].reverse().find(operation => operation.purpose === "director_refinement")?.createdAt : undefined);
  const modelLabel = run ? ({ "gpt-6.1-sol": "GPT-6.1 Sol", "gpt-6-sol": "GPT-6 Sol", "gpt-6-astra": "GPT-6 Astra" } as Record<string, string>)[run.settings.model || ""] || run.settings.model || "未记录模型" : "GPT-6.1 Sol";
  const reasoningLabel = run ? run.settings.reasoning === "medium" ? "中档" : run.settings.reasoning || "未记录档位" : "中档";

  usePublishStoryboardStatus({
    label: pending ? pendingLabels[pending] || '操作处理中' : refinementActivity || view?.title || (work.loading || work.detailLoading ? '正在读取任务状态' : '尚未开始制作'),
    description: refinementActivity ? '可选精修单独生成候选，已有完整稿仍可审看。' : view?.description || '创建任务后，可连续完成情绪统筹、完整主创与统一整编。',
    tone: pending || run?.sourceCheckPending || refinementActivity ? 'waiting' : run?.active && view?.tone !== 'attention' ? phases.find(phase => phase.isCurrent)?.state || view?.tone || 'idle' : view?.tone || 'idle'
  });

  useEffect(() => { if (!run?.active) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, [run?.active]);
  useEffect(() => { setTab("plan"); }, [work.runId]);
  useEffect(() => { if (run) setTab(run.status === "text_ready_for_review" && run.assembly?.text ? "result" : "plan"); }, [run?.id]);

  const reveal = (id: string) => requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }));
  const showPanel = (next: Tab) => { setTab(next); reveal(`stage3-panel-${next}`); };
  const showResult = () => showPanel("result");
  const openSettings = () => { setSettingsOpen(true); reveal("stage3-settings"); };

  const copy = async () => {
    if (!run?.assembly?.text) return;
    try { await navigator.clipboard.writeText(run.assembly.text); work.setNotice(run.sourceStale ? "已复制完整历史稿。" : "已复制完整分镜，未删减或改写正文。"); }
    catch (reason) { work.setError(`复制没有完成：${messageOf(reason)}。仍可使用Markdown下载。`); }
  };
  const start = () => { if (run && view?.canRun) void work.act("start", { mode: "all" }); };
  const repairCheck = view?.repairStopped || view?.repairNeedsRecheck ? view.repairCandidate?.canRecheck ? <button type="button" className="studioButton" data-variant="secondary" disabled={disabled || !view.canRecheck} onClick={() => void work.act("recheck", {candidateId:view.repairCandidate?.id})}>先核查已有回包 · 不调用模型</button> : <button type="button" className="studioButton" data-variant="secondary" onClick={() => showPanel("activity")}>查看具体修复问题</button> : null;

  const controls = run?.legacyReadOnly ? <button type="button" className="studioButton" data-variant="secondary" onClick={showResult}>查看已有分镜</button> : run && view ? <>
          {!run.active&&!run.plan&&!view.planFailure&&!view.unresolved&&!run.sourceStale?<button type="button" className="studioButton" data-variant="secondary" disabled={disabled||!view.canRun} onClick={()=>void work.act('start',{mode:'next'})}>只做情绪分析</button>:null}
          {run.active ? <button type="button" className="studioButton" data-variant="caution" disabled={disabled || !view.canPause} onClick={() => void work.act("pause")}>{run.status === "pausing" ? "正在保存后暂停" : "暂停 · 保留回包"}</button> : view.ready && !run.sourceStale ? <button type="button" className="studioButton" data-variant="primary" onClick={showResult}>审看完整分镜 <span aria-hidden="true">→</span></button> : view.unresolved ? <button type="button" className="studioButton" data-variant="secondary" disabled={disabled} onClick={() => document.getElementById("stage3-recovery")?.scrollIntoView({ behavior: "smooth", block: "center" })}>先检查已有回包</button> : run.sourceStale ? <button type="button" className="studioButton" data-variant="secondary" disabled={disabled} onClick={openSettings}>用新资料创建任务</button> : repairCheck ? repairCheck : run.selection?.status === "awaiting_confirmation" ? <button type="button" className="studioButton" data-variant="primary" onClick={() => showPanel("plan")}>审看并确认幻想</button> : view.budgetReason ? <button type="button" className="studioButton" data-variant="secondary" onClick={() => showPanel("activity")}>检查运行停止线</button> : <button type="button" className="studioButton" data-variant="primary" disabled={disabled || !view.canRun} onClick={start}>{view.nextLabel} <span aria-hidden="true">→</span></button>}
          {run.active ? <details className={styles.moreActions}><summary>更多操作</summary><button type="button" disabled={disabled} onClick={() => { if (window.confirm("立即中断可能无法取回完整回包，已发出的请求仍可能消耗额度。若想保存本次结果后再停，请使用暂停。仍要立即中断吗？")) void work.act("stop"); }}>立即中断</button></details> : null}
          </> : null;

  return <section className={styles.workbench} aria-label="第三阶段分镜工作台">
    <div className={styles.taskToolbar} aria-label="本集任务控制栏"><div className={styles.taskIdentity}><span className={styles.stageBadge}>第三阶段</span><span title={episodeTitle} aria-label="运行状态摘要">{pending ? pendingLabels[pending] || "操作处理中" : run?.active ? `${view?.stageTitle} · ${view?.activityLabel}` : run ? statusLabel(run.status) : episodeTitle}</span></div><div className={styles.taskTools}>
      {index?.runs.length ? <label className={styles.taskSelect}><span>任务版本</span><select aria-label="任务版本" value={work.runId} disabled={disabled} onChange={event => void work.chooseRun(event.target.value)}>{index.runs.map((item, position) => <option key={item.id} value={item.id}>{position === 0 ? "最新 · " : ""}{formatWorkbenchDate(item.createdAt, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} · {item.legacyReadOnly||item.id===run?.id&&run.legacyReadOnly?'旧版只读':statusLabel(item.status)}</option>)}</select></label> : null}
      <button type="button" className="quietButton" disabled={disabled} onClick={() => void work.refresh()} aria-label="刷新任务状态">刷新状态</button>
      {run ? <button type="button" className="studioButton" data-variant="secondary" aria-expanded={showSettings} disabled={disabled} onClick={() => showSettings ? setSettingsOpen(false) : openSettings()}>新建任务</button> : null}
      {controls ? <div className={styles.primaryActions}>{controls}</div> : null}
    </div></div>

    <section className={`${styles.statusSurface} ${view?.tone === "running" || run?.active && refinementActivity ? styles.statusRunning : ""}`} aria-label="制作状态">
      <div className={styles.statusTop}><div className={styles.statusMain}><span className={styles.statusIcon}><StageIcon /></span><div><span className={styles.kicker}>{pending ? "操作处理中" : run?.active ? "LIVE · 实际作业状态" : view?.ready ? "文字成果" : "本集制作"}</span><h2>{pending ? pendingLabels[pending] || "正在保存操作…" : refinementActivity || (!run&&(work.loading || work.detailLoading) ? "正在读取任务…" : view?.title || "一场完整的戏，从情绪开始")}</h2><p aria-live="polite" role="status">{pending === "create" ? "正在准备资料，尚未派发生成模型。创建完成后可连续制作，也可只做情绪分析。" : refinementActivity ? "可选精修单独生成候选，已有完整稿仍可审看。" : view?.description || "先规划本集情绪，再由完整主创联合处理表演、摄影、光影与声音，最后整编交稿。"}</p></div></div>
        <span className={styles.modelTag}>{modelLabel} <i /> {reasoningLabel} · 全局4 / 同集1</span>
      </div>
      {run ? <div className={styles.statusBottom}><div className={styles.savedSettings} aria-label="当前任务已保存配置"><span><i className={run.active ? styles.liveDot : ""} />{run.settings.maxUnitSeconds}秒单元档</span><span>{MODE_LABELS[run.choice?.mode || run.settings.fantasyMode]}</span><span>{modelLabel} · {reasoningLabel}</span></div><div className={styles.metrics}><span>{run.usage.complete ? "已知完整用量" : "已知用量"}<strong>{formatCount(knownTokens)} <small>Token</small></strong></span><span>{run.active && currentStart ? "当前作业历时" : "已结束记录"}<strong>{run.active && currentStart ? formatElapsed(currentStart, undefined, now) : `${endedRecords} / ${run.operations.length}`}</strong></span><span className={styles.syncTime}>状态同步于<br />{work.syncedAt ? formatWorkbenchDate(work.syncedAt,{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : "—"}</span></div></div> : null}
    </section>

    {work.error ? <div className={styles.errorBanner} role="alert"><strong>这次操作需要留意</strong><p>{work.error}</p>{work.creationUncertain ? <button type="button" className="quietButton" onClick={() => void work.refresh()}>核对已有任务列表</button> : null}</div> : null}
    {work.notice ? <p className={styles.savedNotice} role="status">{work.notice}</p> : null}
    <WorkflowGlassRail label="制作流程" className={styles.phaseGlassRail}>
      {phases.map((phase, index) => <WorkflowGlassCard key={phase.id} index={index} state={phase.state} activity={phase.activity} aria-current={phase.isCurrent ? "step" : undefined}>
        <span className={glass.number} aria-hidden="true">{phase.state === "complete" ? "✓" : phase.state === "attention" ? "!" : phase.number}</span>
        <div className={glass.heading}><h3 className={glass.title}>{phase.title}</h3><span className={glass.status}>{phase.label}</span></div>
        {phase.isCurrent ? <span className={styles.currentStep}>当前步骤</span> : null}
        <p className={glass.detail}>{phase.note}</p><small className={glass.detail}>{phase.detail}</small>
      </WorkflowGlassCard>)}
    </WorkflowGlassRail>

    {run?<ProductionPanel run={run} projectId={projectId} episodeNumber={episodeNumber}/>:null}
    {index && !index.runner.ready && index.runner.checked!==false && !index.preparation?.checking ? <div className={styles.noticeBox}><strong>{index.runner.configurationError?'执行配置需要检查':'本机 CLI 尚未就绪'}</strong><p>{index.runner.message}</p><a className="quietButton" href={`/runner?projectId=${encodeURIComponent(projectId)}`}>检查执行连接</a></div> : null}
    {run?.error ? <details className={styles.issueSummary} open={view?.tone === "attention"}><summary>当前问题与下一步</summary><p>{messageOf(run.error)}</p>{view?.planFailure?.canRecheck ? <button type="button" className="studioButton" data-variant="secondary" disabled={disabled || !view.canRecheck} onClick={() => void work.act("recheck", { candidateId: view.planFailure?.id })}>重新核查已保存规划 · 不调用模型</button> : null}</details> : null}
    {warnings.length ? <details className={styles.issueSummary}><summary>制作资料提示 <span>{warnings.length}项</span></summary><ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul><p className={styles.fine}>资料提示不等于整集无法制作；不确定事实不能用创作假设补造。</p></details> : null}

    {showSettings ? <SettingsPanel settings={work.settings} onChange={work.setSettings} disabled={disabled || !work.settingsReady} createDisabled={!work.canCreate} hasRun={Boolean(run)} timeoutPolicy={index?.runner.timeoutPolicy} onClose={() => setSettingsOpen(false)} onCreate={() => void work.act("create", { settings: { maxUnitSeconds: work.settings.maxUnitSeconds, fantasyMode: work.settings.fantasyMode }, notes: work.settings.notes, maxCalls: work.settings.maxCalls, maxTokens: work.settings.maxTokens }).then(next => { if (next) setSettingsOpen(false); })} /> : null}
    {showSettings && work.settingsReady && !work.canCreate ? <p className={styles.fine}>同集仍有运行或未结请求；可先编辑下次参数，处理已有回包后再创建新任务。</p> : null}

    {run && view ? <>
      {!run.legacyReadOnly && run.operations.some(op => op.canRecoverSaved || ["running", "unknown"].includes(op.status) && !op.cancelAcknowledgement?.acceptUnknownUsage) && !run.active ? <section id="stage3-recovery" className={styles.recovery} aria-label="回包恢复">
        <header><strong>先接住已有成果</strong><span>检查、恢复与风险确认均不调用模型</span></header>
        {run.production?.sharedBudget&&'unknownAttempts'in run.production.sharedBudget&&run.production.sharedBudget.unknownAttempts>0?<p>共享预算仍有未知用量；风险确认只解除本任务的本地未结状态，不会解除本轮预算暂停线。请先恢复或核对用量。</p>:null}
        {run.operations.filter(op => op.canRecoverSaved || ["running", "unknown"].includes(op.status) && !op.cancelAcknowledgement?.acceptUnknownUsage).map(op => {
          const check = run.cancellations?.find(item => item.attemptId === op.attemptId);
          const timedOut = check?.kind === "timeout" || typeof op.error === "object" && op.error?.code === "TIMEOUT";
          const confirmRisk = () => {
            const explanation = timedOut
              ? "本机执行已超时结束，未找到可恢复的完整回包；远端请求结果和费用仍未知，可能已经消耗额度。确认仅解除本任务的本地未结状态，不撤销计费，也不自动继续。"
              : "这次中断的费用未知，可能已经消耗额度。确认只解除本任务的本地未结状态，不撤销计费，也不自动继续。";
            const sharedUnknown=run.production?.sharedBudget&&'unknownAttempts'in run.production.sharedBudget&&run.production.sharedBudget.unknownAttempts>0;
            if (window.confirm(explanation+(sharedUnknown?'本轮共享预算仍会暂停，须先恢复或核对用量；此确认不能解除。':'之后另点继续制作可能发起新请求、再次消耗额度。')+'是否确认？')) void work.act("acknowledge_cancel", { attemptId: op.attemptId, acceptUnknownUsage: true });
          };
          return <div key={op.attemptId}><p>{operationLabel(op)} · {op.packageIds.join("、") || "整集"}：{check?.reason || "尚未确认完整回包。"}</p><div className={styles.actions}>
            <button type="button" className="studioButton" data-variant="secondary" disabled={disabled || run.sourceStale} onClick={() => void work.act("recover", { attemptId: op.attemptId })}>检查并恢复已有回包</button>
            {check?.canAcknowledge ? <button type="button" className="quietButton" disabled={disabled} onClick={confirmRisk}>{timedOut ? "确认超时费用风险" : "确认未知费用风险"}</button> : null}
          </div></div>;
        })}
      </section> : null}
      {(knownTokens??0)>=EPISODE_TOKEN_WARNING?<p role="status" className={styles.fine}>本集已知用量超过50万提醒线；当前停止线为{run.budget.maxTokens.toLocaleString('zh-CN')}Token / {run.budget.maxCalls}条请求记录。提醒不触发重做、扩额或额外AI调用。</p>:null}
      {!run.usage.complete ? <p className={styles.fine}>用量尚未完整，另有 {run.usage.unknownAttempts || 0} 项待回执；上面的已知用量不代表实际总消耗。</p> : null}
      <div className={styles.tabs} role="tablist" aria-label="本集工作视图">{tabs.map((item, position) => <button key={item.id} id={`stage3-tab-${item.id}`} role="tab" type="button" tabIndex={tab === item.id ? 0 : -1} aria-selected={tab === item.id} aria-controls={`stage3-panel-${item.id}`} onClick={() => setTab(item.id)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (position + 1) % tabs.length : event.key === "ArrowLeft" ? (position + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
        if (next < 0) return; event.preventDefault(); setTab(tabs[next].id); document.getElementById(`stage3-tab-${tabs[next].id}`)?.focus();
      }}>{item.label}{item.id === "result" && run.assembly?.draft?.units.length ? <span>{run.assembly.draft.units.length}</span> : item.id === "activity" && run.operations.length ? <span>{run.operations.length}</span> : null}</button>)}<span className={styles.tabsHint}>{view.ready ? "文字待人工审看，不等于成片验收" : "已保存成果随任务保留"}</span></div>
      <div role="tabpanel" id="stage3-panel-plan" aria-labelledby="stage3-tab-plan" className={styles.tabPanel} hidden={tab !== "plan"}><PlanningPanel key={run.id} run={run} view={view} disabled={disabled} act={work.act} /></div>
      <div role="tabpanel" id="stage3-panel-result" aria-labelledby="stage3-tab-result" className={styles.tabPanel} hidden={tab !== "result"}><ResultsPanel key={run.id} run={run} view={view} endpoint={work.endpoint} copy={() => void copy()} /><RefinementPanel key={`refinement-${run.id}`} run={run} endpoint={work.endpoint} disabled={disabled} pending={pending} canExecute={canRequestExecution} act={work.act} /></div>
      <div role="tabpanel" id="stage3-panel-activity" aria-labelledby="stage3-tab-activity" className={styles.tabPanel} hidden={tab !== "activity"}><ActivityPanel key={run.id} run={run} view={view} pending={pending} act={work.act} endpoint={work.endpoint} budget={work.budget} setBudget={work.setBudget} /></div>
    </> : null}
  </section>;
}
