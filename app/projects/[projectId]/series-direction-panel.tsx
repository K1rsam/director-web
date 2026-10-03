"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SeriesDirectionContent } from "@/lib/series-direction";
import type { SeriesDirectionWorkspace } from "@/lib/series-direction-service";
import styles from "./series-direction-panel.module.css";

type Fields = Record<keyof SeriesDirectionContent, string>;
const empty: Fields = { settingTags: "", mechanismTags: "", arcTags: "", primaryTone: "", secondaryTones: "", audiencePromise: "", expressionRules: "", avoidances: "", episodeFlexibility: "" };
function fieldsFor(view: SeriesDirectionWorkspace): Fields {
  const content = view.draft?.content ?? view.current?.content;
  return content ? Object.fromEntries(Object.entries(content).map(([key, value]) => [key, Array.isArray(value) ? value.join(["expressionRules", "avoidances"].includes(key) ? "\n" : "、") : value ?? ""])) as Fields : empty;
}
function contentFor(fields: Fields): SeriesDirectionContent {
  const tags = (value: string) => value.split(/[、,，]/).map(s => s.trim()).filter(Boolean);
  const lines = (value: string) => value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return { settingTags: tags(fields.settingTags), mechanismTags: tags(fields.mechanismTags), arcTags: tags(fields.arcTags), primaryTone: fields.primaryTone.trim() || null, secondaryTones: tags(fields.secondaryTones), audiencePromise: fields.audiencePromise.trim() || null, expressionRules: lines(fields.expressionRules), avoidances: lines(fields.avoidances), episodeFlexibility: fields.episodeFlexibility.trim() || null };
}
function bindingFor(view: SeriesDirectionWorkspace) { return { stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, draftHash: view.draft?.hash ?? null, currentHash: view.current?.hash ?? null }; }
const fields: Array<{ key: keyof Fields; label: string; hint: string; rows?: number; maxLength: number }> = [
  { key: "settingTags", label: "背景标签", hint: "世界与时代 · 最多3项，用顿号分隔", maxLength: 74 },
  { key: "mechanismTags", label: "故事机制", hint: "如存在循环等机制才填写 · 无依据可留空", maxLength: 74 },
  { key: "arcTags", label: "主线标签", hint: "全剧持续推进的主线 · 不提前泄露角色认知", maxLength: 74 },
  { key: "primaryTone", label: "主调", hint: "稳定的情绪取向 · 30字以内", maxLength: 30 },
  { key: "secondaryTones", label: "副调", hint: "最多2项，用顿号分隔 · 允许复合，不设比例", maxLength: 49 },
  { key: "audiencePromise", label: "观众回报", hint: "一句话说明观众持续期待什么 · 100字以内", rows: 2, maxLength: 100 },
  { key: "expressionRules", label: "表达原则", hint: "最多3条，每行一条、每条70字以内", rows: 3, maxLength: 212 },
  { key: "avoidances", label: "避免", hint: "最多3条，每行一条、每条50字以内", rows: 3, maxLength: 152 },
  { key: "episodeFlexibility", label: "单集弹性", hint: "允许哪些局部起伏，避免把每集拍成一样 · 100字以内", rows: 2, maxLength: 100 },
];

export function SeriesDirectionPanel({ projectId, initialWorkspace }: { projectId: string; initialWorkspace: SeriesDirectionWorkspace }) {
  const [view, setView] = useState(initialWorkspace), [values, setValues] = useState<Fields>(() => fieldsFor(initialWorkspace));
  const [coverage, setCoverage] = useState(false), [dirty, setDirty] = useState(false), [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false), [generating, setGenerating] = useState(false), [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const binding = useRef(bindingFor(initialWorkspace)), dirtyRef = useRef(false), mutationPending = useRef(false), generationPending = useRef(false);
  const requestGeneration = useRef(0), readSequence = useRef(0);
  const endpoint = `/projects/${encodeURIComponent(projectId)}/series-direction`;
  const install = useCallback((next: SeriesDirectionWorkspace, mode: "replace" | "preserve" | "progress") => {
    setView(next);
    const nextBinding = bindingFor(next), prior = binding.current;
    if (mode !== "progress") {
      binding.current = nextBinding; setConflict(false); setCoverage(false);
      if (mode === "replace") { setValues(fieldsFor(next)); setDirty(false); dirtyRef.current = false; }
    } else if (prior.sourceVersion === nextBinding.sourceVersion && prior.draftHash === nextBinding.draftHash && prior.currentHash === nextBinding.currentHash) binding.current = nextBinding;
    else { setConflict(true); setCoverage(false); }
  }, []);
  const read = useCallback(async () => {
    const generation = requestGeneration.current, sequence = ++readSequence.current;
    const current = () => generation === requestGeneration.current && sequence === readSequence.current && !mutationPending.current;
    try {
      const response = await fetch(endpoint, { cache: "no-store" }); const body = await response.json();
      if (!current()) return null;
      if (!response.ok) throw new Error(body.error || "暂时无法刷新方向。");
      return body as SeriesDirectionWorkspace;
    } catch (error) { if (!current()) return null; throw error; }
  }, [endpoint]);
  useEffect(() => {
    if (!generating && !(view.generation?.pending && view.generation.outcome === "RUNNING")) return;
    let disposed = false, reading = false;
    const timer = window.setInterval(async () => {
      if (reading) return; reading = true;
      try { const next = await read(); if (next && !disposed) install(next, "progress"); }
      catch { /* A read failure never retries generation; the explicit refresh remains available. */ }
      finally { reading = false; }
    }, 2500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [generating, view.generation?.pending, view.generation?.outcome, read, install]);
  async function refresh() {
    setError("");
    try { const next = await read(); if (!next) return; install(next, dirtyRef.current ? "preserve" : "replace"); setMessage(dirtyRef.current ? "已读取最新版本，保留你的未保存输入；请重新核对来源后再保存。" : "已读取最新方向状态。"); }
    catch (e) { setError(e instanceof Error ? e.message : "刷新失败，请稍后再试。"); }
  }
  async function send(action: "save" | "confirm" | "revoke" | "generate" | "resume" | "release-generation") {
    const isGeneration=action==='generate'||action==='resume';
    if (mutationPending.current || (isGeneration && generationPending.current)) return;
    if (action === "generate" && !window.confirm(`将读取全部${view.source.episodes.length}集与背景来源，分${view.generationPlan.batches}批取证并综合，最多${view.generationPlan.calls}次模型调用。按项目的API/CLI方式执行，费用未知；仅生成候选，不自动采用。是否开始？`)) return;
    if(action==='resume'&&!window.confirm(`已核验${view.generation?.reusableCalls??0}份已保存回包，将复用这些结果，只补充剩余${view.generation?.remainingCalls??'待核对'}次调用。旧记录保留，候选不会自动采用。是否继续？`))return;
    if (action === "revoke" && !window.confirm("撤销当前采用后，后续制作将不再收到这张方向卡。已有结果与所有历史版本保留，是否继续？")) return;
    if (action === "release-generation" && !window.confirm("这只结束本地等待，不保证上游调用已终止。原输入与输出保留，用量和费用可能未知；再次生成可能额外计费。是否已核对并结束等待？")) return;
    if (isGeneration) { generationPending.current = true; setGenerating(true); } else { mutationPending.current = true; setSaving(true); }
    const generation = ++requestGeneration.current;
    let refreshAfter = false;
    setError(""); setMessage("");
    const base = { stateToken: binding.current.stateToken, sourceVersion: binding.current.sourceVersion };
    const command = { ...base, action, ...(action === "save" ? { content: contentFor(values), coverageAcknowledged: coverage } : action === "confirm" ? { draftHash: view.draft?.hash, coverageAcknowledged: coverage } : isGeneration ? { costAcknowledged: true } : action === "release-generation" ? { generationId: view.generation?.id, unknownOutcomeAcknowledged: true } : {}) };
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) }); const body = await response.json();
      if (generation !== requestGeneration.current) { refreshAfter = isGeneration; return; }
      if (!response.ok) { if (["DIRECTION_CONFLICT", "DIRECTION_STALE"].includes(body.code)) setConflict(true); throw new Error(body.error || "操作未完成。"); }
      ++requestGeneration.current; // Reads dispatched before this commit cannot replace its newer state.
      const next = body as SeriesDirectionWorkspace;
      if (isGeneration && dirtyRef.current) install(next, "progress");
      else if (["revoke", "release-generation"].includes(action) && dirtyRef.current) install(next, "preserve");
      else install(next, "replace");
      setMessage(action === "save" ? "草稿已保存；当前采用卡没有变化。" : action === "confirm" ? "已采用这版方向，后续各集将读取同一短brief。" : action === "revoke" ? "已撤销当前采用，历史仍保留。" : action === "release-generation" ? "已结束本地等待；上游结果和费用仍需核对，没有自动重试。" : next.generation?.message || "候选状态已更新。");
    } catch (e) {
      if (generation !== requestGeneration.current) refreshAfter = isGeneration;
      else setError(isGeneration ? `${e instanceof Error ? e.message : "请求中断。"} 请先刷新查看调用记录；不要直接重复生成，费用可能未知。` : e instanceof Error ? e.message : "操作未完成，原记录保留。");
    } finally {
      if (generation === requestGeneration.current) ++requestGeneration.current;
      if (isGeneration) { generationPending.current = false; setGenerating(false); } else { mutationPending.current = false; setSaving(false); }
      if (refreshAfter && !mutationPending.current) {
        try { const next = await read(); if (next) install(next, dirtyRef.current ? "progress" : "replace"); } catch { /* Explicit refresh remains available; never retry the paid request. */ }
      }
    }
  }
  const currentLabel = view.status === "CONFIRMED" ? `已采用 v${view.current?.revision}` : view.status === "STALE" ? "已采用卡已过期" : "尚未确认";
  const canConfirm = Boolean(view.draft && view.draft.sourceVersion === view.source.sourceVersion && view.draftReviewed && coverage && !dirty && !conflict && !view.source.blocker && !view.draftIssue && view.draft.hash !== view.current?.hash);
  return <section className={styles.panel} id="series-direction" aria-labelledby="series-direction-title">
    <header className={styles.header}><div><span className={styles.eyebrow}>全剧共享 · 各集保持弹性</span><h2 id="series-direction-title">全剧创作方向</h2><p>定位与表达边界由你定稿；草稿、AI候选与当前采用卡分开保留。</p></div><span className={styles.badge} data-status={view.status}>{currentLabel}</span></header>
    {view.status === "STALE" ? <p className={styles.warning}>全剧来源或制作背景已变化。旧卡仍在历史中，当前不会作为全剧方向投递。</p> : !view.current ? <p className={styles.note}>尚未确认全剧方向；不会根据首集或局部情绪生成默认定位。</p> : null}
    {view.brief ? <details className={styles.preview} open><summary>当前采用 · 各集收到的短brief <small>{Array.from(view.brief).length}/600字</small></summary><p>{view.brief}</p></details> : null}
    <div className={styles.actions}>
      <button className="studioButton" data-variant="secondary" type="button" onClick={() => void refresh()} disabled={saving}>刷新状态</button>
      {view.permissions.canEdit ? <button className="studioButton" data-variant="secondary" type="button" onClick={() => void send("generate")} disabled={generating || saving || !view.generationPlan.allowed || Boolean(view.generation?.held??view.generation?.pending) || conflict}>{generating ? "AI候选生成中…" : "生成AI候选"}</button> : null}
      {view.permissions.canEdit&&view.generation?.resumable?<button className="studioButton" data-variant="primary" type="button" onClick={()=>void send('resume')} disabled={generating||saving||conflict||Boolean(view.source.blocker)}>继续已保存进度 · 剩余{view.generation.remainingCalls}次</button>:null}
      <span className={styles.meta}>完整来源 {view.source.episodes.length} 集 · {view.generationPlan.characters.toLocaleString()} 字 · 候选需 {view.generationPlan.calls} 次调用</span>
    </div>
    {view.generationPlan.reason ? <p className={styles.warning}>{view.generationPlan.reason}</p> : null}
    {view.generation ? <div className={styles.generation} aria-live="polite" aria-busy={generating || (view.generation.pending && view.generation.outcome === "RUNNING")}>
      <strong>{view.generation.pending ? "候选处理中" : view.generation.resumable?'已停止 · 可继续已保存进度':view.generation.status==='FAILED'?'已停止 · 需核对':view.generation.outcome === "UNKNOWN" ? "调用结果待核对" : view.generation.outcome === "REVIEW_REQUIRED" ? "候选已留在历史" : "候选已返回"}</strong>
      <p>{view.generation.message}</p><small>已记录完成 {view.generation.completedCalls}/{view.generation.totalCalls} 次 · {view.generation.usage?.totalTokens != null ? `已知 Token ${view.generation.usage.totalTokens.toLocaleString()} · 未知调用 ${view.generation.usage.unknownCalls} 次；费用未知。` : `用量与费用未知，不按0计费${view.generation.usage ? ` · 未知调用 ${view.generation.usage.unknownCalls} 次` : ""}`}</small>
      {Boolean(view.generation.callUsage?.length) ? <details><summary>逐次调用用量</summary><ul>{view.generation.callUsage!.map(item => <li key={item.call}>{`调用 ${item.call} · ${item.provider} · 输入 ${item.usage.inputTokens ?? "未知"} · 输出 ${item.usage.outputTokens ?? "未知"} · 合计 ${item.usage.totalTokens ?? "未知"}`}</li>)}</ul></details> : null}
      {Boolean(view.generation.reusedCalls)&&<p>复用已保存回包 {view.generation.reusedCalls} 份；用量保留在原调用记录，不计为本次新消耗。</p>}
      {view.generation.recoveryIssue&&<p className={styles.warning}>{view.generation.recoveryIssue}</p>}
      {(view.generation.held??view.generation.pending) && view.permissions.canConfirm ? <button className="studioButton" data-variant="caution" type="button" disabled={saving} onClick={() => void send("release-generation")}>核对后结束等待</button> : null}
    </div> : null}
    <details className={styles.editor} open={!view.current || Boolean(view.draft && view.draft.hash !== view.current.hash)}>
      <summary>编辑方向草稿{view.draft ? ` · v${view.draft.revision}` : ""}{view.draftOrigin === "AI" ? " · AI候选待人工核对" : ""}</summary>
      <div className={styles.formGrid}>{fields.map(field => <div className={`${styles.field} ${field.rows ? styles.wide : ""}`} key={field.key}>
        <label htmlFor={`direction-${field.key}`}>{field.label}</label>
        {field.rows ? <textarea id={`direction-${field.key}`} rows={field.rows} maxLength={field.maxLength} value={values[field.key]} disabled={!view.permissions.canEdit || saving} onChange={event => { setValues({ ...values, [field.key]: event.target.value }); setDirty(true); dirtyRef.current = true; setCoverage(false); }} aria-describedby={`direction-${field.key}-hint`} />
          : <input id={`direction-${field.key}`} type="text" maxLength={field.maxLength} value={values[field.key]} disabled={!view.permissions.canEdit || saving} onChange={event => { setValues({ ...values, [field.key]: event.target.value }); setDirty(true); dirtyRef.current = true; setCoverage(false); }} aria-describedby={`direction-${field.key}-hint`} />}
        <small id={`direction-${field.key}-hint`}>{field.hint}</small>
      </div>)}</div>
      <details className={styles.sources}><summary>核对依据 · 全部生产集与背景来源</summary><p><a href={`/projects/${encodeURIComponent(projectId)}/source`} target="_blank" rel="noreferrer">打开全剧来源，核对实际依据 ↗</a></p><ul>{view.source.evidence.map(item => <li key={item.id}>{item.title}</li>)}</ul>{view.source.warnings.map((warning, i) => <p className={styles.warning} key={i}>{warning}</p>)}</details>
      <label className={styles.coverage}><input type="checkbox" checked={coverage} disabled={saving || !view.permissions.canEdit} onChange={event => setCoverage(event.target.checked)} /><span>我认可当前方向及表达边界，采用后仍以原文事实与揭示时点为准。<small>不要求你声明逐字读完 {view.source.episodes.length} 集；模型是否完整读取由实际分批回执核验。方向确认不替代普通制作授权。</small></span></label>
      {view.draft?.knowledgeIndex&&<p className={styles.meta}>保留关键关系／揭示／变化索引 {view.draft.knowledgeIndex.length} 项；按来源集与原文位置投递，不新增逐集摘要，不提前套用未来状态。</p>}
      {view.source.blocker ? <p className={styles.warning}>{view.source.blocker}</p> : null}
      {conflict ? <p className={styles.warning} role="alert">来源或方向已被其它操作更新。请先刷新核对；你的未保存输入会保留。</p> : null}
      {dirty ? <p className={styles.note}>有未保存修改；预览与当前采用仍是服务器已保存的版本。</p> : null}
      <div className={styles.actions}>
        {view.permissions.canEdit ? <button className="studioButton" data-variant="primary" type="button" disabled={saving || conflict} onClick={() => void send("save")}>{saving ? "保存中…" : "保存草稿"}</button> : null}
        {view.permissions.canConfirm ? <button className="studioButton" data-variant="secondary" type="button" disabled={saving || !canConfirm} onClick={() => void send("confirm")}>确认采用</button> : <span className={styles.meta}>草稿由管理员或审查人确认后生效。</span>}
        {view.permissions.canConfirm && view.current ? <button className="studioButton" data-variant="caution" type="button" disabled={saving || conflict} onClick={() => void send("revoke")}>撤销当前采用</button> : null}
      </div>
      {view.draft && !view.draftReviewed ? <p className={styles.note}>定稿前请先核对来源、勾选并保存，再确认采用。</p> : null}
      {view.draftBrief ? <details className={styles.preview}><summary>已保存草稿 · 短brief预览 <small>{Array.from(view.draftBrief).length}/600字</small></summary><p>{view.draftBrief}</p></details> : view.draftIssue ? <p className={styles.warning}>{view.draftIssue}</p> : null}
    </details>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}{message ? <p className={styles.feedback} role="status">{message}</p> : null}
    {view.history.length ? <details className={styles.history}><summary>版本历史 · {view.history.length} 条</summary>{view.history.map(item => <details key={item.id}><summary>{item.title} <small>{item.createdAt.replace("T", " ").slice(0, 16)} UTC</small></summary>{item.brief ? <p>{item.brief}</p> : <p>原始记录已保留。</p>}{item.card && view.permissions.canEdit ? <button className="studioButton" data-variant="secondary" type="button" disabled={saving} onClick={() => { setValues(fieldsFor({ ...view, draft: item.card })); setDirty(true); dirtyRef.current = true; setCoverage(false); setError(""); setMessage("历史内容已载入表单；当前采用未变。请重新核对来源、保存新草稿并确认，旧确认不会复用。"); }}>载入为新草稿</button> : null}</details>)}</details> : null}
  </section>;
}
