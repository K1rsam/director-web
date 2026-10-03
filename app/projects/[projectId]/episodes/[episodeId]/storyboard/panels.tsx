"use client";

import { useState, type ReactNode } from "react";
import { PromptDocument } from "@/app/ui/prompt-document";
import { MODE_HINTS, MODE_LABELS, STAGE_LABELS, operationLabel, messageOf, statusLabel, type DialogueSource, type Fantasy, type Mode, type NewSettings, type Operation, type Run, type TimeoutPolicy, type Unit } from "./types";
import { candidateFeedback, executionLabel, formatCount, formatElapsed, type deriveView } from "./view-state";
import styles from "./workbench.module.css";

type View = ReturnType<typeof deriveView>;
type Act = (action: string, payload?: Record<string, unknown>) => Promise<Run | null>;
const sourceText = (run: Run, refs: string[]) => run.sourceRows.filter(row => refs.includes(row.id) && row.text.trim());
const dateText = (text?: string) => text ? new Date(text).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
const timeoutText = (ms: number) => ms % 60000 === 0 ? `${ms / 60000} 分钟` : ms >= 1000 ? `${ms / 1000} 秒` : `${ms} 毫秒`;
const diagnosticDate = (text: string | null) => text ? new Date(text).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "未记录";
const diagnosticFaults: Record<string, string> = { timeout: "达到本次运行时限", aborted: "本机已中断", paused: "保存后暂停", cli_failed: "CLI 执行异常", empty_response: "未返回正文", invalid_json: "回包格式异常", spawn_failed: "本机启动失败", unknown: "原因待核对", rate_limit: "额度或频率限制", auth: "登录或授权异常", network: "连接异常" };

export function SectionTitle({ number, title, note, children }: { number?: string; title: string; note?: string; children?: ReactNode }) {
  return <div className={styles.sectionTitle}><div>{number ? <span className={styles.sectionNumber}>{number}</span> : null}<div><h2>{title}</h2>{note ? <p>{note}</p> : null}</div></div>{children}</div>;
}

export function ProductionPanel({run,projectId,episodeNumber}:{run:Run;projectId:string;episodeNumber?:number}){
 const production=run.production;if(!production||run.legacyReadOnly)return null;
 const boundary=production.boundary,shared=production.sharedBudget;
 const labels:Record<string,string>={NO_PREDECESSOR:'无前集承接',PRELIMINARY:'初步承接 · 尚未实际核对',MATCHED:'实际核对已匹配',NOT_CONSUMED:'未使用前集状态',NOT_CONTINUOUS:'非连续时空 · 不继承状态',UNRESOLVED:'承接待核对',REPAIR_REQUIRED:'承接局部待补',CONSTRAINT_CONFLICT:'承接条件存在冲突'};
 const repairLabels:Record<string,string>={CONSUMED_MATERIAL:'已消费的制作材料已补充，需要局部核对',EPISODE_BOUNDARY:'跨集入口存在差异，需要局部核对'};
 const materialRisk=production.blocking||Boolean(production.pendingRepair)||Boolean(boundary&&['UNRESOLVED','REPAIR_REQUIRED','CONSTRAINT_CONFLICT'].includes(boundary.status))||production.materialNeeds.some(need=>need.blocking||need.supplyUpdated);
 const budgetRisk=!shared||'unavailable'in shared||shared.unknownAttempts>0||shared.calls>=shared.maxCalls||shared.knownTokens>=shared.maxTokens;
 return <div className={styles.productionGrid}>
  <details className={styles.productionSummary} aria-label="承接与按需材料" open={materialRisk} data-risk={materialRisk}>
   <summary><strong>资料与承接</strong><span>{boundary?labels[boundary.status]||'承接状态待核对':'承接信息尚未返回'}{production.materialNeeds.length?` · ${production.materialNeeds.length} 项材料需求`:''}</span></summary>
   <div className={styles.summaryBody}><p className={styles.fine}>{production.chainMode==='CHAIN'?'只使用本轮选定的前集版本；变化只核对关联范围。':'单集制作，不把前集原文推测成已完成分镜。'}</p>
   {boundary?.reason?<p>{boundary.reason}</p>:null}
   {boundary?.actualVersion?<p className={styles.fine}>选定前集采用版本：{boundary.actualVersion}</p>:null}
   {production.pendingRepair?<p className={styles.errorText}>局部待补：{repairLabels[production.pendingRepair.reason]||production.pendingRepair.reason}（{production.pendingRepair.packageIds.join('、')}）</p>:null}
   {production.materialNeeds.length?<ul className={styles.materialNeeds}>{production.materialNeeds.map((need,i)=><li key={`${need.stage}-${need.target}-${i}`}><strong>第{need.stage===1?'一':need.stage===2?'二':'三'}阶段 · {need.target}</strong><p>{need.purpose}</p><small>{need.blocking?'必要材料待补':'补充建议'}{need.supplyUpdated?' · 供给已更新，仍需局部核对':''}{need.packageIds?.length?` · ${need.packageIds.join('、')}`:''}</small></li>)}</ul>:<p className={styles.fine}>当前未收到结构化材料需求；这不代表所有关键设计已确认。</p>}
   <div className={styles.actions}><a className="quietButton" href={`/projects/${encodeURIComponent(projectId)}/foundation/handoff${episodeNumber!==undefined?`?episode=${episodeNumber}`:''}`}>{episodeNumber!==undefined?'本集资料与来源':'资料与来源检查'}</a><a className="quietButton" href={`/projects/${encodeURIComponent(projectId)}/production`}>连续制作 · 选集与预算</a></div>
   </div>
  </details>
  <details className={styles.productionSummary} aria-label={production.chainMode==='CHAIN'?'本轮共享预算':'当前任务预算'} open={budgetRisk} data-risk={budgetRisk}>
   <summary><strong>{production.chainMode==='CHAIN'?'共享预算':'任务预算'}</strong><span>{!shared?'未绑定':'unavailable'in shared?'暂不可读':`${shared.calls} / ${shared.maxCalls} 次 · 已知 ${formatCount(shared.knownTokens)} Token${shared.unknownAttempts?` · ${shared.unknownAttempts} 项待核`:''}`}</span></summary>
   <div className={styles.summaryBody}><p className={styles.fine}>{production.chainMode==='CHAIN'?'三阶段共用，不按集重新计数。':'仅显示此任务绑定预算，不代表整轮消耗。'}</p>
   {!shared?<p>此任务未绑定共享预算；不能据此判断整轮余额。</p>:'unavailable'in shared?<p>共享预算暂不可读取，先核对记录。</p>:<><div className={styles.budgetSummary}><span>调用 <strong>{shared.calls} / {shared.maxCalls}</strong></span><span>已知 Token <strong>{formatCount(shared.knownTokens)} / {formatCount(shared.maxTokens)}</strong></span><span>未知用量 <strong>{shared.unknownAttempts} 项</strong></span><span>在途 <strong>{shared.inFlight} 项</strong></span></div><p className={styles.fine}>{shared.unknownAttempts?'存在未知用量，先恢复或核对回执。确认单次费用风险不会解除共享预算暂停线。':shared.complete?'已记录用量完整；仍以服务端停止线为准。':'用量尚未完整，已知量不代表总消耗。'}</p></>}
   </div>
  </details>
 </div>;
}

export function SettingsPanel({ settings, onChange, disabled, createDisabled, onCreate, onClose, hasRun, timeoutPolicy }: { settings: NewSettings; onChange: (value: NewSettings) => void; disabled: boolean; createDisabled?: boolean; onCreate: () => void; onClose: () => void; hasRun: boolean; timeoutPolicy?: TimeoutPolicy }) {
  return <section id="stage3-settings" className={styles.panel} aria-label="新建制作任务">
    <SectionTitle title="创作设置" note="仅用于新任务，不覆盖已保存的规则。">{hasRun ? <button className="quietButton" type="button" onClick={onClose}>收起设置</button> : null}</SectionTitle>
    <div className={styles.settingsGrid}>
      <fieldset className={styles.capacity}><legend>视频单元容量</legend><div className={styles.segmented}>{([15, 30] as const).map(value => <button key={value} type="button" aria-pressed={settings.maxUnitSeconds === value} disabled={disabled} onClick={() => onChange({ ...settings, maxUnitSeconds: value })}><strong>{value}<small>秒</small></strong><span>{value === 30 ? "长叙事" : "常规"}</span></button>)}</div><p className={styles.fine}>容量不是强制时长，保留完整行动与自然气口。</p></fieldset>
      <fieldset className={styles.fantasyModes}><legend>幻想如何参与</legend><div className={styles.modeCards}>{(Object.keys(MODE_LABELS) as Mode[]).map(mode => <button type="button" key={mode} aria-pressed={settings.fantasyMode === mode} disabled={disabled} onClick={() => onChange({ ...settings, fantasyMode: mode })}><span className={styles.radioDot} /><span><strong>{MODE_LABELS[mode]}</strong><small>{MODE_HINTS[mode]}</small></span></button>)}</div></fieldset>
    </div>
    <details className={styles.disclosure}><summary>创作要求与运行停止线 <span>可选</span></summary><div className={styles.settingDetails}>
      <label className={styles.field}>本集创作要求<textarea rows={3} value={settings.notes} maxLength={4000} disabled={disabled} onChange={event => onChange({ ...settings, notes: event.target.value })} placeholder="补充本集确实需要遵守的要求，不必重复上传原文。" /></label>
      <div className={styles.twoFields}><label className={styles.field}>最多调用次数<input type="number" min={0} max={128} value={settings.maxCalls} disabled={disabled} onChange={event => onChange({ ...settings, maxCalls: Number(event.target.value) })} /></label><label className={styles.field}>Token 停止线<input type="number" min={0} max={2000000} step={1000} value={settings.maxTokens} disabled={disabled} onChange={event => onChange({ ...settings, maxTokens: Number(event.target.value) })} /></label></div>
      <p className={styles.fine}>停止线限制后续派发，不是账单硬封顶；未知和在途用量可能尚未计入。设为0不再派发模型请求。</p>
      {timeoutPolicy ? <p className={styles.fine}>新请求时限：情绪统筹 {timeoutText(timeoutPolicy.plan)} · 完整主创 {timeoutText(timeoutPolicy.author)} · 统一整编 {timeoutText(timeoutPolicy.finish)}。这是单次本地执行上限，不是预计完成时间；历史请求以其保存的诊断为准。</p> : null}
    </div></details>
    <div className={styles.createFooter}><p>情绪准确 → 人物表演 → 幻想加持。Q版与额外幻想按每单元实际占时合计不超过40%，不是必须用满。</p><button className="studioButton" data-variant="primary" type="button" disabled={disabled || createDisabled} onClick={onCreate}>创建制作任务 <span aria-hidden="true">→</span></button></div>
    <p className={styles.fine}>创建只准备原文与平读参考，不调用生成模型；下一步由你启动。</p>
  </section>;
}

export function PlanningPanel({ run, view, disabled, act }: { run: Run; view: View; disabled: boolean; act: Act }) {
  const [saving, setSaving] = useState("");
  const plan = run.plan, mode = run.choice?.mode || run.settings.fantasyMode;
  const selected = run.selection?.selectedIds || [];
  const locked = disabled || !view.canChangeChoice;
  const approveReset = () => !run.adopted.length || window.confirm("本任务已有正文。更改幻想选择会保留旧稿历史，并使正文需要重新生成；此次保存选择本身不调用模型。继续吗？");
  const choose = async (key: string, payload: Record<string, unknown>) => {
    if (locked || !run.selection || !approveReset()) return;
    setSaving(key);
    try { await act("choice", { expectedFingerprint: run.selection.fingerprint, ...payload, ...(run.adopted.length ? { resetDrafts: true } : {}) }); }
    finally { setSaving(""); }
  };
  const candidateChoice = (candidate: Fantasy, checked: boolean) => choose(candidate.id, { mode, overrides: { ...run.choice.overrides, [candidate.id]: checked }, unitOverrides: run.choice.unitOverrides || {} });
  return <div className={styles.stack}>
    <section className={styles.panel} aria-label="情绪统筹方案">
      <SectionTitle number="01" title="情绪统筹方案" note="完整事件交给同一主创；工作包不等于最终视频单元。" />
      {!plan ? <div className={styles.emptyInline}><span className={styles.emptyGlyph}>◎</span><h3>{view.planFailure ? "规划已返回，等待定向处理" : run.active ? "正在整理本集的情绪脉络" : "情绪方案将在分析后出现"}</h3><p>{view.description}</p></div> : <>
        <div className={styles.emotionArc}><span>本集情绪主线</span><p>{plan.emotionArc}</p></div>
        <div className={styles.eventGrid}>{plan.workPackages.map((item, position) => <article className={styles.eventCard} key={item.id}><header><span className={styles.eventIndex}>{String(position + 1).padStart(2, "0")}</span><div><h3>{item.emotionContract.subject || "完整事件"}</h3><span>{item.id}{item.dependsOn?.length ? ` · 承接 ${item.dependsOn.join("、")}` : " · 可独立创作"}</span></div></header><p className={styles.eventChange}>{item.emotionContract.change}</p><dl><div><dt>观众回报</dt><dd>{item.emotionContract.audienceEffect}</dd></div><div><dt>最终落点</dt><dd>{item.emotionContract.landing}</dd></div></dl><details className={styles.sourceDisclosure}><summary>基调、保留项与原文依据</summary><p>{item.emotionContract.contextTone}</p><ul>{item.emotionContract.retain.map((text, i) => <li key={i}>{text}</li>)}</ul>{sourceText(run, item.sourceRefs).map(row => <p className={styles.sourceLine} key={row.id}><code>{row.id}</code><span>{row.text}</span></p>)}</details></article>)}</div>
      </>}
    </section>
    {plan ? <section className={styles.panel} aria-label="幻想表达选择">
      <SectionTitle number="02" title="幻想表达" note="表达选择不等于已生成画面；主体表演始终保留。"><span className={styles.pill}>{selected.length} 项已选</span></SectionTitle>
      <div className={styles.choiceModes} aria-label="当前任务幻想模式">{(Object.keys(MODE_LABELS) as Mode[]).map(value => <button type="button" key={value} aria-pressed={mode === value} disabled={locked || Boolean(saving)} onClick={() => void choose("mode", { mode: value, overrides: {}, unitOverrides: {} })}>{MODE_LABELS[value]}</button>)}</div>
      {run.selection?.status === "needs_design" ? <div className={styles.noticeBox}><strong>有选中位置尚未形成方案</strong><p>可在下方取消这些位置的请求，保留其他选择；也可补充规划。未设计不代表已完成。</p>{view.canReplan ? <button type="button" className="studioButton" data-variant="secondary" disabled={disabled} onClick={() => void act("replan")}>补充幻想规划 · 将调用模型</button> : null}</div> : null}
      <div className={styles.fantasyGrid}>{plan.fantasyCandidates.map((candidate, index) => <article className={`${styles.fantasyCard} ${selected.includes(candidate.id) ? styles.fantasySelected : ""}`} key={candidate.id}>
        <label className={styles.choiceHeading}><input type="checkbox" aria-label={`采用幻想：${candidate.subject}`} checked={selected.includes(candidate.id)} disabled={locked || mode === "off" || Boolean(saving)} onChange={event => void candidateChoice(candidate, event.target.checked)} /><span><small>表达 {String(index + 1).padStart(2, "0")}</small><strong>{candidate.subject}</strong></span>{candidate.recommended ? <span className={styles.recommendTag}>推荐</span> : null}</label>
        <p className={styles.fantasyPurpose}>{candidate.emotionPurpose}</p><p className={styles.prose}>{candidate.proposal}</p>
        <footer>{candidate.screenSecondsRange?.length ? <span>预计占画面 {candidate.screenSecondsRange.join("–")} 秒</span> : <span>细排时核定占时</span>}<span>{selected.includes(candidate.id) ? "已选择 · 待正文兑现" : "未选择"}</span></footer>
        <details className={styles.sourceDisclosure}><summary>查看对应原文</summary>{sourceText(run, candidate.anchorRefs).map(row => <p className={styles.sourceLine} key={row.id}><code>{row.id}</code><span>{row.text}</span></p>)}</details>
      </article>)}</div>
      {!plan.fantasyCandidates.length ? <p className={styles.emptyCopy}>本版没有额外幻想候选。源剧情中的Q版、法术、梦境和必要信息仍须保留。</p> : null}
      <details className={styles.disclosure} open={run.selection?.status === "needs_design"}><summary>按初排单元调整 <span>{plan.provisionalUnits.length} 个初排范围，非最终切分</span></summary><div className={styles.unitChoices}>{plan.provisionalUnits.map(unit => {
        const related = plan.fantasyCandidates.filter(item => item.anchorRefs.some(ref => unit.sourceRefs.includes(ref)));
        const checked = related.length ? related.every(item => selected.includes(item.id)) : mode !== "off" && run.choice.unitOverrides?.[unit.id] === true;
        return <label key={unit.id}><input type="checkbox" checked={checked} disabled={locked || mode === "off" || Boolean(saving)} onChange={event => {
          const overrides = { ...run.choice.overrides };
          for (const candidate of related) overrides[candidate.id] = event.target.checked;
          void choose(unit.id, { mode, overrides, unitOverrides: { ...run.choice.unitOverrides, [unit.id]: event.target.checked } });
        }} /><span><strong>{unit.id}</strong><small>{related.length ? `关联${related.length}项表达` : "希望加入幻想（待设计）"}</small></span><em>{unit.secondsRange.join("–")}秒</em></label>;
      })}</div><p className={styles.fine}>同一表达跨多个初排单元时共用选择；勾选单元会同步它关联的候选。</p></details>
      {mode === "review" ? <div className={styles.confirmBar}><p>{run.selection?.status === "awaiting_confirmation" ? "检查已选位置，确认后才能进入正文创作。" : "本次选择已确认；继续制作将调用模型。"}</p><button type="button" className="studioButton" data-variant="primary" disabled={locked || run.selection?.status !== "awaiting_confirmation"} onClick={() => { if (approveReset()) void act("confirm", { selectedIds: selected, expectedFingerprint: run.selection?.fingerprint, ...(run.adopted.length ? { resetDrafts: true } : {}) }); }}>确认本次选择</button></div> : null}
    </section> : null}
    <details className={`${styles.panel} ${styles.sourceDisclosure}`}><summary>完整原文与稳定位置 <span>紧凑阅读 · 原行号保留</span></summary><div className={styles.sourceRows}>{run.sourceRows.filter(row => row.text.trim()).map(row => <p className={styles.sourceLine} key={row.id}><code>{row.id}</code><span>{row.text}</span></p>)}</div></details>
  </div>;
}

function DialogueMeta({ part, source }: { part: Unit["shots"][number]["dialogueParts"][number]; source?: DialogueSource }) {
  return <small><strong>{source?.speaker || "说者未返回"}</strong> · {part.presentation}{source?.channel && source.channel !== "现场对白" && source.channel !== part.presentation ? ` · 源声道 ${source.channel}` : ""} · {part.voiceStart}–{part.voiceEnd}秒 · {part.delivery}</small>;
}

function UnitSheet({ unit, dialogue }: { unit: Unit; dialogue: Map<string, DialogueSource> }) {
  return <article className={styles.unitSheet}><header><div><span className={styles.kicker}>视频单元 · {unit.id}</span><h3>{unit.title}</h3></div><span className={styles.pill}>{unit.shots.reduce((n, shot) => n + shot.duration, 0).toFixed(1)} 秒 · 文字估时</span></header>
    <div className={styles.unitMeta}><p><span>场景</span>{unit.scene}</p><p><span>人物</span>{unit.participants.join("、") || "无"}</p><p><span>道具</span>{unit.props.join("、") || "无"}</p><p><span>光影</span>{unit.lighting}</p><p><span>入场状态</span>{unit.initialState}</p><p><span>退出状态</span>{unit.exitState}</p></div>
    {unit.shots.map((shot, index) => <section className={styles.shot} key={shot.id}><div className={styles.shotHeading}><strong>镜头 {String(index + 1).padStart(2, "0")}</strong><span>{shot.duration} 秒</span></div><dl className={styles.shotFields}><div><dt>机位 / 运镜</dt><dd>{shot.camera}</dd></div><div><dt>画面</dt><dd>{shot.picture}</dd></div><div><dt>光影</dt><dd>{shot.lighting}</dd></div><div><dt>声音</dt><dd>{shot.sound}</dd></div><div><dt>台词</dt><dd>{shot.dialogueParts.length ? shot.dialogueParts.map((part, i) => <p key={i}><DialogueMeta part={part} source={dialogue.get(part.lineId)} /><span>{part.text}</span></p>) : "无"}</dd></div><div><dt>转场</dt><dd>{shot.transition}</dd></div></dl></section>)}
  </article>;
}

export function ResultsPanel({ run, view, endpoint, copy }: { run: Run; view: View; endpoint: string; copy: () => void }) {
  const [format, setFormat] = useState<"reader" | "table" | "original">("reader"), [selectedId, setSelectedId] = useState("");
  const units = run.assembly?.draft?.units || [], selected = units.find(unit => unit.id === selectedId) || units[0];
  const dialogue = new Map((run.dialogue || []).map(line => [line.id, line]));
  const exportUrl = `${endpoint}?runId=${encodeURIComponent(run.id)}`;
  return <section className={styles.panel} aria-label="完整分镜成果">
    <SectionTitle title="完整分镜" note={run.sourceStale ? "当前为历史稿，不能作为新资料下的完成稿。" : "当前采用版本；文字估时不代表实配或视频已验收。"}><div className={styles.actions}><button type="button" className="studioButton" data-variant="secondary" disabled={!run.assembly?.text} onClick={copy}>{run.sourceStale ? "复制历史整稿" : "复制完整稿"}</button><a className="studioButton" data-variant="primary" aria-disabled={!view.downloadable} href={view.downloadable ? `${exportUrl}&format=md` : undefined} download>导出 Markdown</a></div></SectionTitle>
    {!run.assembly?.text ? <div className={styles.emptyInline}><span className={styles.emptyGlyph}>▤</span><h3>完整分镜将在整编后出现</h3><p>已完成的工作包和回包保存在执行记录中，不会因这块空态而丢失。</p></div> : <>
      <div className={styles.resultToolbar}><div className={styles.choiceModes} aria-label="成果阅读方式">{([['reader', '单元阅读'], ['table', '分镜表'], ['original', '原始完整稿']] as const).map(([key, title]) => <button type="button" key={key} aria-pressed={format === key} disabled={key !== "original" && !units.length} onClick={() => setFormat(key)}>{title}</button>)}</div><span>{units.length ? `${units.length} 个单元 · ${units.reduce((n, unit) => n + unit.shots.length, 0)} 个镜头` : "完整文本"}</span></div>
      {run.assembly.errors?.length ? <div role="alert" className={styles.noticeBox}>{run.assembly.errors.map((error, i) => <p key={i}>{messageOf(error)}</p>)}</div> : null}
      {run.assembly.warnings?.length ? <details className={styles.disclosure}><summary>文字核对提示（{run.assembly.warnings.length}）</summary>{run.assembly.warnings.map((warning, i) => <p key={i}>{messageOf(warning)}</p>)}</details> : null}
      {format === "original" || !units.length ? <div className={styles.originalText}><PromptDocument content={run.assembly.text} /></div> : format === "reader" ? <div className={styles.readerLayout}><nav className={styles.unitNav} aria-label="视频单元">{units.map((unit, i) => <button type="button" key={unit.id} aria-current={unit.id === selected?.id ? "true" : undefined} onClick={() => setSelectedId(unit.id)}><b>{String(i + 1).padStart(2, "0")}</b><span>{unit.title}<small>{unit.shots.length} 镜 · {unit.shots.reduce((n, shot) => n + shot.duration, 0).toFixed(1)} 秒</small></span></button>)}</nav><div>{selected ? <UnitSheet unit={selected} dialogue={dialogue} /> : null}</div></div> : <div className={styles.tableScroll}><table><thead><tr><th>单元 / 镜头</th><th>机位 / 运镜</th><th>画面</th><th>光影</th><th>声音与台词</th><th>转场</th></tr></thead><tbody>{units.flatMap(unit => unit.shots.map(shot => <tr key={`${unit.id}-${shot.id}`}><th>{unit.title}<small>{shot.id} · {shot.duration}秒</small></th><td>{shot.camera}</td><td>{shot.picture}</td><td>{shot.lighting}</td><td>{shot.sound}{shot.dialogueParts.map((part, i) => <p key={i}><DialogueMeta part={part} source={dialogue.get(part.lineId)} />{part.text}</p>)}</td><td>{shot.transition}</td></tr>))}</tbody></table></div>}
    </>}
  </section>;
}

function ExecutionDiagnostics({ operation }: { operation: Operation }) {
  const data = operation.diagnostics;
  return <details className={styles.diagnostics}><summary>执行诊断 <span>{data ? "本机活动记录" : "未记录"}</span></summary>
    {!data ? <p>{operation.diagnosticsUnavailable ? "执行诊断暂不可读；原始任务与回执仍保留。" : "此条历史记录未保存执行诊断，不能补推当时的活动或时限。"}</p> : <>
      <dl className={styles.diagnosticGrid}>
        <div><dt>本次时限</dt><dd>{timeoutText(data.timeoutMs)}</dd></div>
        <div><dt>开始时间</dt><dd>{diagnosticDate(data.startedAt)}</dd></div>
        <div><dt>结束时间</dt><dd>{diagnosticDate(data.endedAt)}</dd></div>
        <div><dt>最后 CLI 活动</dt><dd>{diagnosticDate(data.lastActivityAt)}</dd></div>
        <div><dt>事件数</dt><dd>{data.eventCount}</dd></div>
        <div><dt>输出量</dt><dd>{data.stdoutBytes} 字节</dd></div>
        <div><dt>错误通道输出</dt><dd>{data.stderrBytes} 字节</dd></div>
      </dl>
      {data.failureCategory ? <p>最后记录的故障：{diagnosticFaults[data.failureCategory] || "原因待核对"}；过程提示不代表最终结果，以回执状态为准。</p> : null}
      <p>仅记录活动时间与数量，不保存完整思考或登录信息；有活动不等于完成进度，无活动也不能单独判定卡死。</p>
    </>}
  </details>;
}

export function ActivityPanel({ run, view, pending, act, endpoint, budget, setBudget }: { run: Run; view: View; pending: string; act: Act; endpoint: string; budget: { maxCalls: number; maxTokens: number }; setBudget: (value: { maxCalls: number; maxTokens: number }) => void }) {
  const [selected, setSelected] = useState<string[]>([]), [notes, setNotes] = useState("");
  const locked = Boolean(pending), canMutate = view.canChangeChoice && !locked;
  return <div className={styles.stack}>
    <section className={styles.panel}><SectionTitle title="每一步都有来处，已保存结果可追溯" note="已结束记录包括未发送失败；只有真实回执才能证明模型已响应。"><a className="quietButton" href={`${endpoint}?runId=${encodeURIComponent(run.id)}&format=json`} download>导出完整历史</a></SectionTitle>
      <div className={styles.callList}>{run.operations.length ? [...run.operations].reverse().map(operation => <article className={styles.callRow} key={operation.attemptId}>
        <span className={`${styles.callDot} ${!run.legacyReadOnly && run.active && operation.status === "running" && operation.localPhase === "executing" && (!operation.execution||operation.execution.phase==='generating') ? styles.liveDot : ""}`} />
        <div><strong>{operationLabel(operation)}</strong><p>{operation.packageIds.join("、") || "整集"}</p><small>{dateText(operation.createdAt)}{operation.localSettledAt ? ` · 作业历时 ${formatElapsed(operation.createdAt, operation.localSettledAt)}` : operation.status === "completed" ? " · 结束时刻未返回" : " · 包含等待、执行与回包"}</small>{operation.error ? <p className={styles.errorText}>{messageOf(operation.error)}</p> : null}<ExecutionDiagnostics operation={operation} /></div>
        <div className={styles.callMeta}><span>{operation.requestOutcome === "NOT_SENT" ? "未发送" : operation.requestOutcome === "RESPONDED" ? "已响应" : operation.status === "running" ? !run.active||run.legacyReadOnly ? "执行状态待核对" : executionLabel(operation) : statusLabel(operation.status)}</span><small>{operation.usage?.totalTokens != null ? `${formatCount(operation.usage.totalTokens)} Token` : "用量待回执"}</small>{operation.cancelAcknowledgement?.acceptUnknownUsage ? <small>已确认风险 · 费用仍未知</small> : null}</div>
      </article>) : <p className={styles.emptyCopy}>尚未派发生成请求。创建任务不会产生模型调用。</p>}</div>
    </section>
    {run.candidates.length ? <section className={styles.panel}><SectionTitle title="候选与核对记录" note="收到、采纳、旧版本与中断后返回，不是作品质量等级。" />{[...run.candidates].reverse().map(candidate => {
      const feedback = candidateFeedback(candidate);
      return <details className={styles.disclosure} key={candidate.id}><summary>{STAGE_LABELS[candidate.stage] || "候选"} · {statusLabel(candidate.status)} <span>{candidate.packageIds.join("、") || "整集"}</span></summary><div className={styles.settingDetails}>
        {feedback.errors.length ? feedback.errors.map((error, i) => <p className={styles.errorText} key={i}>{messageOf(error)}</p>) : <p className={styles.fine}>{["needs_repair", "needs_dependency_repair"].includes(candidate.status) ? "该候选仍待处理，请核对当前问题与原始记录。" : "未记录阻断问题；仍需专业审看。"}</p>}
        {feedback.warnings.map((warning, i) => <p className={styles.fine} key={`warning-${i}`}>提示：{messageOf(warning)}</p>)}
        {candidate.requiredPackageIds?.length ? <p>需要关联处理：{candidate.requiredPackageIds.join("、")}</p> : null}
        {candidate.canRecheck ? <button type="button" className="studioButton" data-variant="secondary" disabled={!view.canRecheck || locked} onClick={() => void act("recheck", { candidateId: candidate.id })}>重新核查已有候选 · 不调用模型</button> : null}
      </div></details>;
    })}</section> : null}
    <section className={styles.panel}><details className={styles.disclosure}><summary>定向返修 <span>只改关联范围，正确稿保留</span></summary><div className={styles.settingDetails}><p className={styles.fine}>后台可能扩展到必须一起修的关联工作包。返修会调用模型，原候选和已付费结果保留。</p><div className={styles.packageChecks}>{run.plan?.workPackages.map(item => <label key={item.id}><input type="checkbox" checked={selected.includes(item.id)} disabled={!view.canRepair || locked} onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />{item.emotionContract.subject || item.id}<small>{item.id}</small></label>)}</div><label className={styles.field}>具体需要改善什么<textarea rows={3} value={notes} disabled={!view.canRepair || locked} onChange={event => setNotes(event.target.value)} placeholder="写明哪段出现了什么问题，希望保留什么；无需复述整集。" /></label><button type="button" className="studioButton" data-variant="secondary" disabled={!view.canRepair || locked || !selected.length || !notes.trim()} onClick={() => void act("repair", { packageIds: selected, notes })}>提交关联返修 · 将调用模型</button></div></details>
      <details className={styles.disclosure}><summary>当前任务的运行停止线 <span>不自动开始制作</span></summary><div className={styles.settingDetails}><div className={styles.twoFields}><label className={styles.field}>调用次数停止线<input type="number" min={0} max={128} value={budget.maxCalls} disabled={!canMutate} onChange={event => setBudget({ ...budget, maxCalls: Number(event.target.value) })} /></label><label className={styles.field}>Token 停止线<input type="number" min={0} max={2000000} value={budget.maxTokens} disabled={!canMutate} onChange={event => setBudget({ ...budget, maxTokens: Number(event.target.value) })} /></label></div><p className={styles.fine}>按已知用量控制后续请求，非账单硬封顶。未知费用不会记为0。自动返修上限为 {run.budget.maxRepairs} 次。</p><button type="button" className="studioButton" data-variant="secondary" disabled={!canMutate} onClick={() => void act("budget", budget)}>保存停止线</button></div></details>
    </section>
  </div>;
}
