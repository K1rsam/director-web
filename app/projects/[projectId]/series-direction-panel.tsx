"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SeriesDirectionContent } from "@/lib/series-direction";
import type { SeriesDirectionWorkspace } from "@/lib/series-direction-service";
import { SERIES_EXPRESSION_OPTIONS, readSeriesExpressionPreferences } from '@/lib/series-expression';
import { readSystemPresentation, SYSTEM_PRESENTATION_MODES, type SystemPresentation } from '@/lib/system-presentation';
import { SystemPresentationEditor } from './system-presentation-editor';
import styles from "./series-direction-panel.module.css";

type DirectionField = Exclude<keyof SeriesDirectionContent, 'expressionPreferences' | 'systemPresentation'>;
type Fields = Record<DirectionField | 'emotion' | 'camera' | 'fantasy' | 'rationale', string>;
const empty: Fields = { settingTags: "", mechanismTags: "", arcTags: "", primaryTone: "", secondaryTones: "", audiencePromise: "", expressionRules: "", avoidances: "", episodeFlexibility: "", emotion: '', camera: '', fantasy: '', rationale: '' };
function fieldsFor(view: SeriesDirectionWorkspace): Fields {
  const content = view.draft?.content ?? view.current?.content;
  if (!content) return { ...empty };
  const { expressionPreferences, systemPresentation: _systemPresentation, ...base } = content;
  return { ...empty, ...Object.fromEntries(Object.entries(base).map(([key, value]) => [key, Array.isArray(value) ? value.join(["expressionRules", "avoidances"].includes(key) ? "\n" : "、") : value ?? ""])),
    emotion: expressionPreferences?.emotion ?? '', camera: expressionPreferences?.camera ?? '', fantasy: expressionPreferences?.fantasy ?? '', rationale: expressionPreferences?.rationale ?? '' };
}
function contentFor(fields: Fields, systemPresentation?: SystemPresentation): SeriesDirectionContent {
  const tags = (value: string) => value.split(/[、,，]/).map(s => s.trim()).filter(Boolean);
  const lines = (value: string) => value.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return { settingTags: tags(fields.settingTags), mechanismTags: tags(fields.mechanismTags), arcTags: tags(fields.arcTags), primaryTone: fields.primaryTone.trim() || null, secondaryTones: tags(fields.secondaryTones), audiencePromise: fields.audiencePromise.trim() || null, expressionRules: lines(fields.expressionRules), avoidances: lines(fields.avoidances), episodeFlexibility: fields.episodeFlexibility.trim() || null,
    ...(fields.emotion || fields.camera || fields.fantasy || fields.rationale.trim() ? { expressionPreferences: readSeriesExpressionPreferences({ emotion: fields.emotion || null, camera: fields.camera || null, fantasy: fields.fantasy || null, rationale: fields.rationale.trim() || null }) } : {}),
    ...(systemPresentation ? { systemPresentation: readSystemPresentation(systemPresentation) } : {}) };
}
function bindingFor(view: SeriesDirectionWorkspace) { return { stateToken: view.stateToken, sourceVersion: view.source.sourceVersion, draftHash: view.draft?.hash ?? null, currentHash: view.current?.hash ?? null }; }
const fields: Array<{ key: DirectionField; label: string; hint: string; rows?: number; maxLength: number }> = [
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
const expressionFields = [
  { key: 'emotion', label: '情绪强度', hint: '强度落到身体、反差和关系变化，不等于人人喊叫。' },
  { key: 'camera', label: '镜头速度', hint: '快速有冲击：明确触发、快速行进与可读落点；必要停顿保留。' },
  { key: 'fantasy', label: '额外幻想密度', hint: '丰富大胆不等于逐镜添加；幻想关闭与逐项取消仍优先。' },
] as const;

export function SeriesDirectionPanel({ projectId, initialWorkspace }: { projectId: string; initialWorkspace: SeriesDirectionWorkspace }) {
  const [view, setView] = useState(initialWorkspace), [values, setValues] = useState<Fields>(() => fieldsFor(initialWorkspace));
  const [systemPresentation, setSystemPresentation] = useState<SystemPresentation | undefined>(() => (initialWorkspace.draft ?? initialWorkspace.current)?.content.systemPresentation);
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
      if (mode === "replace") { setValues(fieldsFor(next)); setSystemPresentation((next.draft ?? next.current)?.content.systemPresentation); setDirty(false); dirtyRef.current = false; }
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
    if (action === "generate" && !window.confirm(`${view.draft?.sourceVersion === view.source.sourceVersion ? '已有候选可核对或直接修改；额外重做会重复读取。\n' : ''}这是独立补充分析，不是第一阶段的共用读取。将读取全部${view.source.episodes.length}集与背景来源，分${view.generationPlan.batches}批取证并综合，最多${view.generationPlan.calls}次模型调用。费用未知；仅生成候选，不自动采用。是否仍要额外分析？`)) return;
    if(action==='resume'&&!window.confirm(`已核验${view.generation?.reusableCalls??0}份已保存回包，将复用这些结果，只补充剩余${view.generation?.remainingCalls??'待核对'}次调用。旧记录保留，候选不会自动采用。是否继续？`))return;
    if (action === "revoke" && !window.confirm("撤销当前采用后，后续制作将不再收到这张方向卡。已有结果与所有历史版本保留，是否继续？")) return;
    if (action === "release-generation" && !window.confirm("这只结束本地等待，不保证上游调用已终止。原输入与输出保留，用量和费用可能未知；再次生成可能额外计费。是否已核对并结束等待？")) return;
    if (isGeneration) { generationPending.current = true; setGenerating(true); } else { mutationPending.current = true; setSaving(true); }
    const generation = ++requestGeneration.current;
    let refreshAfter = false;
    setError(""); setMessage("");
    const base = { stateToken: binding.current.stateToken, sourceVersion: binding.current.sourceVersion };
    try {
      const command = { ...base, action, ...(action === "save" ? { content: contentFor(values, systemPresentation), coverageAcknowledged: coverage } : action === "confirm" ? { draftHash: view.draft?.hash, coverageAcknowledged: coverage } : isGeneration ? { costAcknowledged: true, ...(action === 'generate' ? { repeatAnalysisAcknowledged: true } : {}) } : action === "release-generation" ? { generationId: view.generation?.id, unknownOutcomeAcknowledged: true } : {}) };
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
      else if ((e as { code?: string })?.code === 'DIRECTION_EXPRESSION') setError('请检查表达选项和选择依据：依据须为140字以内的单行文字，不含制表符等控制字符；原输入仍保留。');
      else if ((e as { code?: string })?.code === 'DIRECTION_SYSTEM_SOURCE_CONFLICT') setError('系统呈现与登记的源载体冲突；请沿原文或保留待核对，原输入仍保留。');
      else if ((e as { code?: string })?.code?.startsWith('DIRECTION_SYSTEM_')) setError('请检查系统身份、逐字源锚、呈现方案及权限边界；各系统分别填写，原输入仍保留。');
      else setError(isGeneration ? `${e instanceof Error ? e.message : "请求中断。"} 请先刷新查看调用记录；不要直接重复生成，费用可能未知。` : e instanceof Error ? e.message : "操作未完成，原记录保留。");
    } finally {
      if (generation === requestGeneration.current) ++requestGeneration.current;
      if (isGeneration) { generationPending.current = false; setGenerating(false); } else { mutationPending.current = false; setSaving(false); }
      if (refreshAfter && !mutationPending.current) {
        try { const next = await read(); if (next) install(next, dirtyRef.current ? "progress" : "replace"); } catch { /* Explicit refresh remains available; never retry the paid request. */ }
      }
    }
  }
  const currentLabel = view.status === "CONFIRMED" ? `已采用 v${view.current?.revision}` : view.status === "STALE" ? "已采用卡已过期" : view.foundationPreparation && view.draft ? '候选待确认' : '尚未确认';
  const canConfirm = Boolean(view.draft && view.draft.sourceVersion === view.source.sourceVersion && (view.draftCanConfirm ?? view.draftReviewed) && coverage && !dirty && !conflict && !view.source.blocker && !view.draftIssue && view.draft.hash !== view.current?.hash);
  const generateActions = <>{view.permissions.canEdit ? <button className="studioButton" data-variant="secondary" type="button" onClick={() => void send("generate")} disabled={generating || saving || !view.generationPlan.allowed || Boolean(view.generation?.held??view.generation?.pending) || conflict}>{generating ? "AI候选生成中…" : "生成AI候选"}</button> : null}
    {view.permissions.canEdit&&view.generation?.resumable?<button className="studioButton" data-variant="primary" type="button" onClick={()=>void send('resume')} disabled={generating||saving||conflict||Boolean(view.source.blocker)}>继续已保存进度 · 剩余{view.generation.remainingCalls}次</button>:null}
    <span className={styles.meta}>独立补充分析：{view.source.episodes.length} 集 · {view.generationPlan.characters.toLocaleString()} 字 · 额外 {view.generationPlan.calls} 次调用</span></>;
  return <section className={styles.panel} id="series-direction" aria-labelledby="series-direction-title">
    <header className={styles.header}><div><span className={styles.eyebrow}>全剧共享 · 各集保持弹性</span><h2 id="series-direction-title">全剧创作方向</h2><p>定位与表达边界由你定稿；草稿、AI候选与当前采用卡分开保留。</p></div><span className={styles.badge} data-status={view.status}>{currentLabel}</span></header>
    {view.status === "STALE" ? <p className={styles.warning}>全剧来源或制作背景已变化。旧卡仍在历史中，当前不会作为全剧方向投递。</p> : !view.current ? <p className={styles.note}>尚未确认全剧方向；不会根据首集或局部情绪生成默认定位。</p> : null}
    {view.brief ? <details className={styles.preview} open><summary>当前采用 · 各集收到的短brief <small>{Array.from(view.brief).length}/600字</small></summary><p>{view.brief}</p></details> : null}
    {view.status === 'CONFIRMED' && view.current?.content.systemPresentation ? <details className={styles.preview}><summary>当前采用 · 系统呈现 v{view.current.revision}</summary>{view.current.content.systemPresentation.systems.map(system => <p key={system.id}>{system.identity}：{SYSTEM_PRESENTATION_MODES[system.mode]}{system.carrierNotes ? `；${system.carrierNotes}` : ''}。原声与可见/可听/接触、屏字边界随此版本保存；下方修改须重新保存确认。</p>)}</details> : null}
    {view.foundationPreparation ? <div className={styles.note} role="status"><p>{view.foundationPreparation.message}</p>
      {view.foundationPreparation.status === 'READING' ? <small>已核验完整读取 {view.foundationPreparation.coveredEpisodes}/{view.foundationPreparation.totalEpisodes} 集；这不是创作质量验收。</small> : null}
      {view.foundationPreparation.status === 'PENDING_STAGE1' ? <a href={`/projects/${encodeURIComponent(projectId)}`}>返回第一阶段整理资料</a> : null}
      <p>确认后，第三阶段自动携带同一张精简方向卡；中间方向依据与历史不随每次调用重复发送。</p></div> : null}
    <div className={styles.actions}>
      <button className="studioButton" data-variant="secondary" type="button" onClick={() => void refresh()} disabled={saving}>刷新状态</button>
      {!view.foundationPreparation ? generateActions : null}
    </div>
    {view.foundationPreparation ? <details className={styles.preview} open={Boolean(view.generation?.held??view.generation?.pending)}><summary>额外分析（通常无需使用）</summary><p>优先核对现有候选或手工调整。旧版本缺少候选、或你明确要求重做时才使用；不会自动重新生成资产资料。</p><div className={styles.actions}>{generateActions}</div></details> : null}
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
      <SystemPresentationEditor value={systemPresentation} disabled={!view.permissions.canEdit || saving} evidence={view.source.evidence} onChange={next => { setSystemPresentation(next); setDirty(true); dirtyRef.current = true; setCoverage(false); }} />
      <div className={styles.preview}>
        <h3>要不要更强的情绪、更快的运镜、更多大胆幻想？</h3>
        <p>全文共用读取完成后，会在候选里按剧情与对白气质建议；这是待你确认的表达选择，不是自动采用。旧卡未设置时沿用原口径，不自动重读全剧。可直接修改、免费保存并确认，已有制作结果不变。</p>
        <div className={styles.formGrid}>{expressionFields.map(field => <div className={styles.field} key={field.key}>
          <label htmlFor={`direction-${field.key}`}>{field.label}</label>
          <select id={`direction-${field.key}`} value={values[field.key]} disabled={!view.permissions.canEdit || saving} aria-describedby={`direction-${field.key}-hint`} onChange={event => { setValues({ ...values, [field.key]: event.target.value }); setDirty(true); dirtyRef.current = true; setCoverage(false); }}>
            <option value="">未设置 · 沿用既有口径</option>
            {Object.entries(SERIES_EXPRESSION_OPTIONS[field.key]).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select><small id={`direction-${field.key}-hint`}>{field.hint}</small>
        </div>)}<div className={`${styles.field} ${styles.wide}`}>
          <label htmlFor="direction-rationale">建议／选择依据（非源事实，可编辑）</label>
          <input id="direction-rationale" maxLength={140} value={values.rationale} disabled={!view.permissions.canEdit || saving} onChange={event => { setValues({ ...values, rationale: event.target.value }); setDirty(true); dirtyRef.current = true; setCoverage(false); }} />
          <small>依据只保存在卡内，不随每集重复发送。手工选择不冒充模型已完成全文评估；三维明确选择优先于表达原则中的泛化强弱描述，原文事实和必要情绪仍优先。</small>
        </div></div>
      </div>
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
      {view.draft && !view.draftReviewed ? <p className={styles.note}>{view.draftCanConfirm ? '核对候选后，勾选认可即可确认采用；有修改则先保存草稿，不需要再调用AI。' : '定稿前请先核对来源、勾选并保存，再确认采用。'}</p> : null}
      {view.draftBrief ? <details className={styles.preview}><summary>已保存草稿 · 短brief预览 <small>{Array.from(view.draftBrief).length}/600字</small></summary><p>{view.draftBrief}</p></details> : view.draftIssue ? <p className={styles.warning}>{view.draftIssue}</p> : null}
    </details>
    {error ? <p className={styles.error} role="alert">{error}</p> : null}{message ? <p className={styles.feedback} role="status">{message}</p> : null}
    {view.history.length ? <details className={styles.history}><summary>版本历史 · {view.history.length} 条</summary>{view.history.map(item => <details key={item.id}><summary>{item.title} <small>{item.createdAt.replace("T", " ").slice(0, 16)} UTC</small></summary>{item.brief ? <p>{item.brief}</p> : <p>原始记录已保留。</p>}{item.card?.content.systemPresentation ? <p>系统选择：{item.card.content.systemPresentation.systems.map(system => `${system.identity} · ${system.mode}`).join('；')}（完整源锚与边界随版本保留）</p> : null}{item.card && view.permissions.canEdit ? <button className="studioButton" data-variant="secondary" type="button" disabled={saving} onClick={() => { setValues(fieldsFor({ ...view, draft: item.card })); setSystemPresentation(item.card?.content.systemPresentation); setDirty(true); dirtyRef.current = true; setCoverage(false); setError(""); setMessage("历史内容已载入表单；当前采用未变。请重新核对来源、保存新草稿并确认，旧确认不会复用。"); }}>载入为新草稿</button> : null}</details>)}</details> : null}
  </section>;
}
