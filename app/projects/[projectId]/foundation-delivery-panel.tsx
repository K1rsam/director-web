"use client";

import { useEffect, useState } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { startFoundationDeliveryAction, stopFoundationDeliveryAction, preprocessProjectAction } from "@/app/actions";
import type { FoundationDeliveryState } from "@/lib/foundation-delivery-types";
import styles from "./foundation-delivery.module.css";

type PanelState = Pick<FoundationDeliveryState, "task" | "totalEpisodes" | "availableEpisodes" | "editedEpisodes" | "busy" | "complete" | "needsContextEdit" | "action" | "expectedState" | "suggestionsCount" | "continuationBlocker" | "methodUpdateAvailable" | "activeCallStartedAt">;

function currentWork(state: PanelState) {
  if (!state.busy) return state.complete ? "P4 · 交接就绪" : null;
  switch (state.task?.phase) {
    case "PREPARE_SOURCE": return "P1 · 原文结构检查";
    case "GENERATE_F1": return "P2 · 拆集分场";
    case "GENERATE_F2": return "P3 · 素材提取";
    case "EDIT": return "P3 · 自动校验";
    case "REPAIR": return "P3 · 局部修复";
    case "APPLY_DECISION": return "P3 · 应用决定";
    default: return "正在整理 · 阶段待确认";
  }
}

/** Use the live request's persisted start when known; never invent pure execution duration. */
export function FoundationTaskElapsed({ task, active, activeCallStartedAt }: { task: PanelState["task"]; active: boolean; activeCallStartedAt?: string | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active, task?.id, activeCallStartedAt]);
  if (!task) return null;
  const requestStart = active && activeCallStartedAt ? Date.parse(activeCallStartedAt) : NaN;
  const currentRequest = Number.isFinite(requestStart);
  const start = currentRequest ? requestStart : Date.parse(task.createdAt);
  const recorded = Date.parse(task.updatedAt);
  const end = active ? Math.max(start, recorded, now ?? recorded) : recorded;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const seconds = Math.floor((end - start) / 1000);
  const duration = `${Math.floor(seconds / 3600) ? `${Math.floor(seconds / 3600)}小时 ` : ""}${Math.floor(seconds / 60) % 60}分 ${seconds % 60}秒`;
  return <span className={styles.elapsed} data-clock={active ? "running" : "stopped"}>{currentRequest ? "当前请求已等待：" : "本任务历时（含等待）："}{duration}{active ? "" : " · 已停止计时"}</span>;
}

function episodeScope(scope: number[]) {
  const numbers = [...new Set(scope)].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < numbers.length; i++) {
    const start = numbers[i];
    let end = start;
    while (numbers[i + 1] === end + 1) end = numbers[++i];
    ranges.push(start === end ? String(start) : `${start}–${end}`);
  }
  return ranges.length ? `第${ranges.join("、")}集` : "尚未确定";
}

function SubmitButton({ label, pendingLabel, stop = false, compact = false }: { label: string; pendingLabel: string; stop?: boolean; compact?: boolean }) {
  const { pending } = useFormStatus();
  return <button type="submit" disabled={pending} className={compact ? stop ? "dangerQuietButton" : "topbarPrimary" : stop ? styles.stop : styles.primary}>{pending ? pendingLabel : label}</button>;
}

export function FoundationDeliveryPanel({ projectId, state, requiredChoiceCount, compact = false }: { projectId: string; state: PanelState; requiredChoiceCount: number; compact?: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!state.busy) return;
    const timer = window.setInterval(() => router.refresh(), 3000);
    return () => window.clearInterval(timer);
  }, [state.busy, router]);

  const task = state.task;
  const unknown = state.action === "UNKNOWN_CONFIRM" || Boolean(task?.unknownOutcome);
  const waiting = requiredChoiceCount > 0 && !state.busy && !unknown && state.action !== "BLOCKED";
  const blocked = !state.busy && !unknown && state.action === "BLOCKED";
  const noSource = state.action === "NONE" && !state.busy && !state.complete && state.totalEpisodes === 0;
  const phase = task?.phase === "PREPARE_SOURCE" ? "正在检查原文结构" : task?.phase === "GENERATE_F1" ? "正在整理分集内容" : task?.phase === "GENERATE_F2" ? "正在补充资产目录"
    : task?.phase === "REPAIR" ? "正在局部修复资料" : task?.phase === "APPLY_DECISION" ? "正在应用你的决定" : task?.phase === "EDIT" ? "正在自动校验资料" : "正在整理，阶段待确认";
  const title = state.busy ? phase : noSource ? "原文暂未就绪" : blocked ? "整理已暂停" : waiting ? "需要你确认" : unknown ? task?.status === "INTERRUPTED" ? "处理已中断，请求结果尚未确认" : "上次请求结果尚未确认" : state.complete ? "资料已整理"
    : task?.status === "STOPPED" ? "已停止，资料已保留" : task?.status === "INTERRUPTED" ? "处理已中断，资料已保留"
      : state.availableEpisodes > 0 || task?.status === "PARTIAL" ? "已生成的资料已保留" : "从剧本开始整理资料";
  const description = state.busy ? "你可以继续阅读下方资料；处理进度与正文会自动更新。"
    : blocked ? "整理遇到技术问题，当前已暂停，已保存资料仍可阅读。这类问题由工作流处理，无需你修改剧本格式；恢复前不会继续请求。" : noSource ? "尚未取得可整理的原文内容，暂时不能开始。原文读取状态与已有内容可在来源页查看。"
      : waiting ? `有 ${requiredChoiceCount} 项确实需要你的取舍。确认后会自动接着完成，其余资料仍可阅读。`
      : unknown ? "已有内容仍保留。普通继续不会重发；只有你明确接受可能重复计费后，才会再次请求。"
        : state.complete ? "当前范围的分集导航与资产目录已整理。图片和后续分镜尚未制作。"
          : state.action === "START" ? "一次开始，持续补齐分集导航与资产目录；只有必要取舍才会请你确认。"
            : "继续时会接着处理尚未完成的部分，已保存内容保持可读。";
  const canContinue = unknown || !state.complete && (state.action === "START" || state.action === "CONTINUE");
  const startForm = <form key={state.expectedState} action={startFoundationDeliveryAction} className={compact ? "topbarStopForm" : styles.startForm}>
    <input name="projectId" type="hidden" value={projectId} />
    <input name="expectedState" type="hidden" value={state.expectedState} />
    {unknown ? <label className={compact ? "biblePlaceholder" : styles.consent}>
      <input type="checkbox" name="allowUnknownRetry" value="yes" required />
      <span>我理解结果尚未确认，重发可能重复计费，同意重发并继续。</span>
    </label> : null}
    <SubmitButton label={unknown ? "确认重发并继续" : state.action === "START" ? "整理资料" : "继续完成"} pendingLabel="正在提交…" compact={compact} />
  </form>;
  if (compact) return <div className="cardHeaderActions" id="foundation-delivery" aria-busy={state.busy}>
    <span className="topbarStatus" role="status" aria-live="polite"><i className={state.busy ? "live" : ""} />{state.busy ? currentWork(state) : blocked ? "整理已暂停" : noSource ? "原文暂未就绪" : waiting ? "需要你确认" : unknown ? task?.status === "INTERRUPTED" ? "处理中断 · 请求结果待确认" : "请求结果待确认" : state.complete ? "资料已整理" : task?.status === "STOPPED" ? "已停止" : task?.status === "INTERRUPTED" ? "处理中断" : "资料待整理"}</span>
    {state.busy ? <>
      <button className="topbarPrimary" type="button" disabled>正在整理…</button>
      {task ? <form action={stopFoundationDeliveryAction} className="topbarStopForm">
        <input name="projectId" type="hidden" value={projectId} /><input name="taskId" type="hidden" value={task.id} />
        <SubmitButton label="停止" pendingLabel="停止中…" stop compact />
      </form> : null}
    </> : blocked ? <a href="#foundation-status" className="quietButton">查看整理状态</a> : noSource ? null : waiting ? <a href="#presentation-contracts" className="quietButton">查看必要取舍</a> : canContinue ? unknown ? <details className="bibleSection">
      <summary className="quietButton">请求恢复</summary>
      <p className="biblePlaceholder">上次结果尚未确认；重发可能重复计费。</p>
      {startForm}
    </details> : startForm : null}
  </div>;
  return <section className={styles.panel} id="foundation-delivery" aria-labelledby="delivery-heading" aria-busy={state.busy}>
    <div className={styles.panelHeading}>
      <div><p className={styles.eyebrow}>全剧资料</p><h2 id="delivery-heading">{title}</h2></div>
      <div className={styles.controls}>
        {state.busy ? <>
          <button className={styles.primary} type="button" disabled>正在整理…</button>
          {task ? <form action={stopFoundationDeliveryAction}>
            <input name="projectId" type="hidden" value={projectId} />
            <input name="taskId" type="hidden" value={task.id} />
            <SubmitButton label="停止" pendingLabel="停止中…" stop />
          </form> : null}
        </> : blocked ? <a href="#foundation-status" className={styles.primary}>查看整理状态</a> : noSource ? null : waiting ? <a href="#presentation-contracts" className={styles.primary}>查看需要确认的事项</a> : canContinue ? startForm : null}
      </div>
    </div>
    <p role="status" aria-live="polite" className={unknown ? styles.warning : styles.description}>{description}</p>
    <div className={styles.progress} aria-label="资料整理进度">
      <div><span>已有资料</span><strong>{state.availableEpisodes}<small> / {state.totalEpisodes} 集</small></strong><progress max={Math.max(1, state.totalEpisodes)} value={state.availableEpisodes} aria-label="已有资料集数" /></div>
      <div><span>已完善</span><strong>{state.editedEpisodes}<small> / {state.totalEpisodes} 集</small></strong><progress max={Math.max(1, state.totalEpisodes)} value={state.editedEpisodes} aria-label="已完善资料集数" /></div>
    </div>
    {state.needsContextEdit ? <p className={styles.note}>原文或制作条件已有变化；继续时会更新受影响的资料，旧修订保留可读。</p> : null}
    {state.methodUpdateAvailable ? <p className={styles.note}>规则有更新，未自动重跑；当前资料保留原核对版本。</p> : null}
    {state.suggestionsCount ? <p className={styles.note}>另有 {state.suggestionsCount} 条建议已保留，不阻挡当前资料整理。</p> : null}
    <details className={styles.processing}>
      <summary>处理与调用说明</summary>
      <p>当前原文与已定条件累计最多 {task?.maxRepairCalls ?? 3} 次自动修正（格式与内容合计）、最多 {task?.maxRepairRounds ?? 2} 轮；同一输入最多一次格式修复，未知结果须另行明确同意。继续或重建任务不会重置已消费额度，已保存响应优先本地恢复。</p>
      {state.continuationBlocker ? <p>{state.continuationBlocker}</p> : null}
      {task ? <>
        <p>{task.message}</p>
        <p>处理范围：{task.scope.length ? `第${task.scope.join("、")}集` : "尚未确定"} · 本任务累计请求 {task.addedCalls} 次 · 其中修正请求 {task.repairCalls} 次</p>
        {task.error ? <p className={styles.warning}>{task.error}</p> : null}
        <p>任务记录：{task.id} · 更新时间：<time dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>（北京时间）</p>
      </> : null}
    </details>
  </section>;
}

/** Visible operation rail; uses the current delivery, never the retired paid stage chain. */
export function FoundationWorkflowStatus({ projectId, state, sourceReady, sceneCount, remaining }: {
  projectId: string; state: PanelState; sourceReady: boolean; sceneCount: number; remaining: string[];
}) {
  const unknown = state.action === "UNKNOWN_CONFIRM" || Boolean(state.task?.unknownOutcome);
  const blocked = !state.busy && !unknown && state.action === "BLOCKED";
  const message = state.busy ? "正在按当前步骤整理资料，自动校验和局部修复的进度会在这里更新。已有内容可继续阅读。"
    : unknown ? `${state.task?.status === "INTERRUPTED" ? "处理已中断。" : ""}上次请求结果尚未确认，当前不会自动重发；重发可能重复计费，需要你明确同意。`
      : blocked ? "整理遇到技术问题，当前已暂停，已保存资料仍可阅读。这类问题由工作流处理，无需你修改剧本格式；恢复前不会继续请求。"
        : state.complete ? "资料已整理，可查看原文、资产与场次。"
          : state.task?.status === "WAITING_USER" ? "有内容需要你作创作取舍，请在必要取舍中确认；已有资料仍可阅读。"
            : state.action === "CONTINUE" ? "已有资料保留；继续仅处理未完成部分，可能新增模型调用费用。"
              : "选择执行渠道后，点击右上角“整理资料”。系统会接收原文、统一结构并整理资料，只有必要的内容取舍才需要你确认。";
  const live = state.busy && !unknown && !state.complete && (state.task?.status === "RUNNING" || state.task?.status === "QUEUED");
  const phaseCard = state.task?.phase === "PREPARE_SOURCE" ? "P1" : state.task?.phase === "GENERATE_F1" ? "P2" : state.task && ["GENERATE_F2", "EDIT", "REPAIR", "APPLY_DECISION"].includes(state.task.phase) ? "P3" : null;
  const activity = state.task?.status === "QUEUED" ? "排队中" : "正在工作";
  const paused = unknown ? "结果待确认" : blocked ? "已暂停" : state.task?.status === "WAITING_USER" ? "等待你的确认" : state.task?.status === "STOPPED" ? "已停止" : state.task?.status === "INTERRUPTED" ? "已中断" : null;
  const cards = [
    { code: "P1", name: "接收与清洗", note: "保留原文 · 程序初检，按需 AI 辅助", status: sourceReady ? "原文已接收" : "待检查", href: "/projects/"+encodeURIComponent(projectId)+"/source", link: "查看原文与提示" },
    { code: "P2", name: "拆集分场与必要事实", note: "按原文整理场次、背景与身份", status: sourceReady ? state.totalEpisodes+"集 / "+sceneCount+"场" : "待拆分", href: "#foundation-scenes", link: "查看场次" },
    { code: "P3", name: "素材整理与核对", note: "提取必要素材，完善已有资料", status: state.availableEpisodes+" / "+state.totalEpisodes+"集已保存", href: "#foundation-assets", link: "查看素材" },
    { code: "P4", name: "按集交接", note: "原文、素材与待办汇入单集资料", status: state.complete ? "资料已整理" : "待整理完成", href: "/projects/"+encodeURIComponent(projectId)+"/foundation/handoff", link: "查看交接资料" }
  ];
  return <section className="foundationControlRoom" id="foundation-status" aria-label="第一阶段操作与状态">
    <div className="sectionHeading"><div><h2>资料整理 · P1–P4</h2></div><p>一次开始，自动整理与核对；创作取舍和处理状态分别显示。</p></div>
    <div className="foundationRail">{cards.map(card => {
      const selected = card.code === phaseCard && !state.complete;
      const running = selected && live;
      return <article className={`foundationRole automatic ${running ? `${styles.activeCard} ${state.task?.status === "QUEUED" ? "queued" : "running"}` : selected && paused ? styles.pausedCard : ""}`} key={card.code} aria-current={running ? "step" : undefined} aria-busy={running || undefined}>
        <span>{card.code}</span><div><strong>{card.name}</strong><small>{card.note}</small></div><em>{running ? <><i className={state.task?.status === "QUEUED" ? styles.queuedDot : styles.workSpinner} aria-hidden="true" />{activity}</> : selected && paused ? paused : card.status}</em>
        <a className="foundationCardAction" href={card.href}>{card.link}</a>
      </article>;
    })}</div>
    {state.task ? <p className={styles.operationMessage}><FoundationTaskElapsed task={state.task} active={live} activeCallStartedAt={state.activeCallStartedAt} /></p> : null}
    {currentWork(state) ? <p className={styles.operationMessage} role="status" aria-live="polite"><strong>当前工作：{currentWork(state)}</strong>{state.busy ? ` · 处理范围：${episodeScope(state.task?.scope ?? [])}` : null}</p> : null}
    <p className={styles.operationMessage}>已保存 {state.availableEpisodes} / {state.totalEpisodes} 集 · 已核对 {state.editedEpisodes} / {state.totalEpisodes} 集</p>
    <p className={styles.operationMessage} role="status" aria-live="polite">{message}</p>
    {state.task ? <p className={styles.operationMessage}>任务最近记录：<time dateTime={state.task.updatedAt}>{new Date(state.task.updatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false })}</time>（北京时间）</p> : null}
    {state.busy ? <p className={styles.operationMessage}>状态每 3 秒自动刷新；单次模型请求等待返回期间，阶段和记录时间可能保持不变，不能仅凭这一点判断卡死。</p> : null}
    {state.task || state.continuationBlocker ? <details className={styles.processing}>
      <summary>技术诊断与处理记录</summary>
      {state.continuationBlocker ? <p>{state.continuationBlocker}</p> : null}
      {state.task?.message ? <p>{state.task.message}</p> : null}
      {state.task?.error ? <p className={styles.operationError}>{state.task.error}</p> : null}
      {state.task ? <p>任务记录：{state.task.id} · 当前阶段：{state.task.phase}</p> : null}
    </details> : null}
    <div className={styles.operationLinks}>
      <form action={preprocessProjectAction}><input type="hidden" name="projectId" value={projectId} /><button type="submit" className="quietButton" disabled={state.busy || unknown}>重新检查原文（零模型）</button></form>
      <a href="#foundation-history" className="quietButton">运行记录与用量</a>
      <span>{state.task ? `已记录 ${state.task.addedCalls} 次请求，其中修正 ${state.task.repairCalls} 次。` : "运行中可在右上角停止；已有结果保留。"}</span>
    </div>
    <details id="foundation-remaining" className={styles.remaining} open={blocked || (!state.busy && remaining.length > 0) || undefined}>
      <summary>剩余事项（{remaining.length}）</summary>
      {remaining.length ? <ul>{remaining.map((note, index) => <li key={index}>{note}</li>)}</ul> : <p>{state.complete ? "当前没有待处理事项。" : "生成尚未完成；具体问题会随处理结果显示。"}</p>}
    </details>
  </section>;
}
