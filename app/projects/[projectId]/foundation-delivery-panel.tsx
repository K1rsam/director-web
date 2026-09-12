"use client";

import { useEffect } from "react";
import { useFormStatus } from "react-dom";
import { useRouter } from "next/navigation";
import { startFoundationDeliveryAction, stopFoundationDeliveryAction, preprocessProjectAction } from "@/app/actions";
import type { FoundationDeliveryState } from "@/lib/foundation-delivery-types";
import styles from "./foundation-delivery.module.css";

type PanelState = Pick<FoundationDeliveryState, "task" | "totalEpisodes" | "availableEpisodes" | "editedEpisodes" | "busy" | "complete" | "needsContextEdit" | "action" | "expectedState" | "suggestionsCount" | "continuationBlocker" | "methodUpdateAvailable">;

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
  const waiting = requiredChoiceCount > 0 && !state.busy && !unknown;
  const blocked = !state.busy && !unknown && state.action === "BLOCKED";
  const noSource = state.action === "NONE" && !state.busy && !state.complete && state.totalEpisodes === 0;
  const phase = task?.phase === "GENERATE_F1" ? "正在整理分集内容" : task?.phase === "GENERATE_F2" ? "正在补充资产目录"
    : task?.phase === "REPAIR" ? "正在修正资料问题" : task?.phase === "APPLY_DECISION" ? "正在应用你的决定" : "正在完善资料";
  const title = state.busy ? phase : noSource ? "请先检查原文" : blocked ? "待程序处理" : waiting ? "需要你确认" : unknown ? "上次请求结果尚未确认" : state.complete ? "资料已整理"
    : task?.status === "STOPPED" ? "已停止，资料已保留" : task?.status === "INTERRUPTED" ? "处理已中断，资料已保留"
      : state.availableEpisodes > 0 || task?.status === "PARTIAL" ? "已生成的资料已保留" : "从剧本开始整理资料";
  const description = state.busy ? "你可以继续阅读下方资料；处理进度与正文会自动更新。"
    : blocked ? state.continuationBlocker : noSource ? "原文缺少有效分集内容，暂时不能开始整理。请查看下方的原文读取与资料检查记录。"
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
    <span className="topbarStatus" role="status" aria-live="polite"><i className={state.busy ? "live" : ""} />{state.busy ? "正在整理" : blocked ? "待程序处理" : noSource ? "请先检查原文" : waiting ? "需要你确认" : unknown ? "请求结果待确认" : state.complete ? "资料已整理" : task?.status === "STOPPED" ? "已停止" : task?.status === "INTERRUPTED" ? "处理中断" : "资料待整理"}</span>
    {state.busy ? <>
      <button className="topbarPrimary" type="button" disabled>正在整理…</button>
      {task ? <form action={stopFoundationDeliveryAction} className="topbarStopForm">
        <input name="projectId" type="hidden" value={projectId} /><input name="taskId" type="hidden" value={task.id} />
        <SubmitButton label="停止" pendingLabel="停止中…" stop compact />
      </form> : null}
    </> : blocked ? <a href="#foundation-status" className="quietButton">查看原因</a> : noSource ? null : waiting ? <a href="#presentation-contracts" className="quietButton">查看必要取舍</a> : canContinue ? unknown ? <details className="bibleSection">
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
        </> : blocked ? <a href="#foundation-status" className={styles.primary}>查看原因</a> : noSource ? null : waiting ? <a href="#presentation-contracts" className={styles.primary}>查看需要确认的事项</a> : canContinue ? startForm : null}
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
  const blocked = state.action === "BLOCKED";
  const message = state.busy ? state.task?.message ?? "正在处理，状态会自动更新。"
    : blocked ? state.continuationBlocker ?? "需要先处理程序问题；没有发起新的模型请求。"
      : state.complete ? "资料已整理，可查看原文、资产与场次。"
        : state.action === "CONTINUE" ? "已有资料保留；继续仅处理未完成部分，可能新增模型调用费用。请先查看剩余事项。"
          : state.action === "UNKNOWN_CONFIRM" ? "上次请求结果未知，普通操作不会重发；重发可能重复计费。"
            : "先确认上方API / CLI渠道，再点右上角“整理资料”。程序拆集与拆场不调用模型，F2 / Q1会产生模型调用费用。";
  const cards = [
    { code: "P0", name: "原文拆集与场次", note: "固定程序 · 不调用模型", status: sourceReady ? `${state.totalEpisodes}集 / ${sceneCount}场` : "待检查", href: "#foundation-scenes", link: "查看场次" },
    { code: "P1 · F1", name: "来源歧义辅助", note: "仅有歧义时辅助，不生成摘要", status: "按需执行", href: "#foundation-document", link: "查看原文" },
    { code: "P2 · F2", name: "资产拆解", note: "保留已生成的资产目录", status: `${state.availableEpisodes} / ${state.totalEpisodes}集已保存`, href: "#foundation-assets", link: "查看资产" },
    { code: "P3 · Q1", name: "直接完善资料", note: blocked ? "待程序处理，不重复调用" : "直接修改必要内容", status: `${state.editedEpisodes} / ${state.totalEpisodes}集已处理`, href: "#foundation-remaining", link: "查看剩余事项" }
  ];
  return <section className="foundationControlRoom" id="foundation-status" aria-label="第一阶段操作与状态">
    <div className="foundationRail">{cards.map(card => <article className="foundationRole automatic" key={card.code}>
      <span>{card.code}</span><div><strong>{card.name}</strong><small>{card.note}</small></div><em>{card.status}</em>
      <a className="foundationCardAction" href={card.href}>{card.link}</a>
    </article>)}</div>
    <p className={styles.operationMessage} role="status">{message}</p>
    {state.task?.error ? <p className={styles.operationError}>{state.task.error}</p> : null}
    <div className={styles.operationLinks}>
      <form action={preprocessProjectAction}><input type="hidden" name="projectId" value={projectId} /><button type="submit" className="quietButton" disabled={state.busy || state.action === "UNKNOWN_CONFIRM"}>重新检查原文（零模型）</button></form>
      <a href="#foundation-history" className="quietButton">运行记录与用量</a>
      <span>{state.task ? `已记录 ${state.task.addedCalls} 次请求，其中修正 ${state.task.repairCalls} 次。` : "运行中可在右上角停止；已有结果保留。"}</span>
    </div>
    <details id="foundation-remaining" className={styles.remaining} open={blocked || undefined}>
      <summary>剩余事项（{remaining.length}）</summary>
      {remaining.length ? <ul>{remaining.map((note, index) => <li key={index}>{note}</li>)}</ul> : <p>{state.complete ? "当前没有待处理事项。" : "生成尚未完成；具体问题会随处理结果显示。"}</p>}
    </details>
  </section>;
}
