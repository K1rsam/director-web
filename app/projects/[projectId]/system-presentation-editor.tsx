"use client";

import {useState} from 'react';
import { SYSTEM_PRESENTATION_MODES, SYSTEM_PRESENTATION_HINTS, SYSTEM_PRESENTATION_BOUNDARIES, newSystemPresentationChoice, type SystemPresentation, type SystemPresentationChoice, type SystemSourceEvidence } from '@/lib/system-presentation';
import styles from './series-direction-panel.module.css';

type Props = { value: SystemPresentation | undefined; onChange: (value: SystemPresentation | undefined) => void; disabled: boolean; evidence: Array<{ id: string; title: string }> };
export function SystemPresentationEditor({ value, onChange, disabled, evidence }: Props) {
  const [editing, setEditing] = useState<string[]>([]);
  const systems = value?.systems ?? [];
  const update = (index: number, patch: Partial<SystemPresentationChoice>) => { setEditing(ids => ids.includes(systems[index].id) ? ids : [...ids, systems[index].id]); onChange({ systems: systems.map((item, i) => i === index ? { ...item, ...patch } : item) }); };
  const citation = (ref: SystemSourceEvidence, change: (ref: SystemSourceEvidence) => void, id: string) => <>
    <label htmlFor={`${id}-evidence`}>原文来源</label>
    <select id={`${id}-evidence`} value={ref.evidenceId} disabled={disabled} onChange={event => change({ ...ref, evidenceId: event.target.value })}><option value="">选择实际来源</option>{evidence.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select>
    <label htmlFor={`${id}-quote`}>逐字原文锚点</label><textarea id={`${id}-quote`} rows={2} maxLength={240} value={ref.quote} disabled={disabled} onChange={event => change({ ...ref, quote: event.target.value })} />
  </>;
  return <details className={styles.preview} open={Boolean(systems.length)}>
    <summary>系统呈现 · 可选{systems.length ? ` · ${systems.length} 个叙事身份` : ' · 未设置'}</summary>
    <p>剧本有系统时才设置。原文已明确的形式直接沿用并说明，不必再选一遍；只有未定部分、真实冲突或明确改编才展开选择。各系统分别保存，面板和化身不自动算两个身份；已有整体方向确认仍保留，沿源不伪记为用户逐项确认。</p>
    <p>明确的源实体、外观、原声和提示优先。精灵不自动获得新对白、能力或他人互动；原系统音不改为嘴部对白、不强加人物声源绑定。必要提示与原载体不因额外幻想关闭消失，新增载体仍受既有限制；剧情内面板文字依源保留，额外字幕另需文字许可。</p>
    {systems.map((system, index) => { const retained = Boolean(system.sourceCarrier && (system.mode === 'PRESERVE_SOURCE' || system.mode === system.sourceCarrier.mode)); return <fieldset key={system.id} className={`${styles.preview} ${styles.systemCard}`} disabled={disabled}>
      <legend>系统 {index + 1}{system.identity ? ` · ${system.identity}` : ''}</legend>
      {retained && system.sourceCarrier ? <div data-system-source-retained={system.id}>
        <p><strong>原文明示，直接沿用 · {SYSTEM_PRESENTATION_MODES[system.sourceCarrier.mode]}</strong></p>
        <p>源依据：{evidence.find(item => item.id === system.sourceCarrier!.evidenceId)?.title ?? system.sourceCarrier.evidenceId}（{system.sourceCarrier.evidenceId}）「{system.sourceCarrier.quote}」</p>
        <p>范围：以该源坐标及实际出场时点为准，不向无关集追加系统镜头。可见：{SYSTEM_PRESENTATION_BOUNDARIES.visibility[system.visibility]}；可听：{SYSTEM_PRESENTATION_BOUNDARIES.audibility[system.audibility]}；接触：{SYSTEM_PRESENTATION_BOUNDARIES.contact[system.contact]}。</p>
        <small>仅沿用有据载体，不授权独立身体、旁人知情、新声道或额外叠字。源锚保存时仍须核验；此说明不是新的选择题或逐项用户确认。</small>
      </div> : null}
      <details open={!retained || editing.includes(system.id)} onToggle={event => { const open = event.currentTarget.open; setEditing(ids => open ? ids.includes(system.id) ? ids : [...ids, system.id] : ids.includes(system.id) ? ids.filter(id => id !== system.id) : ids); }}><summary>{retained ? '查看源记录／确需修订时展开' : '未定部分与制作选择'}</summary>
      <div className={styles.formGrid}>
        <div className={styles.field}><label htmlFor={`system-${index}-identity`}>叙事身份／源名称</label><input id={`system-${index}-identity`} maxLength={80} value={system.identity} onChange={event => update(index, { identity: event.target.value })} /><small>按原文实际身份区分，别名或同一系统的不同外观不另造身份。</small></div>
        <div className={styles.field}><label htmlFor={`system-${index}-mode`}>呈现方案</label><select id={`system-${index}-mode`} value={system.mode} onChange={event => { const recommended = system.options?.find(option => option.mode === event.target.value); update(index, { mode: event.target.value as SystemPresentationChoice['mode'], ...(recommended ? { carrierNotes: recommended.description } : {}) }); }}>{Object.entries(SYSTEM_PRESENTATION_MODES).map(([mode, label]) => <option value={mode} key={mode} disabled={Boolean(system.sourceCarrier && mode !== 'PRESERVE_SOURCE' && mode !== system.sourceCarrier.mode)}>{label}</option>)}</select><small>有明确源载体时，只能沿源或在同类载体内设计；不相容选择不能保存。</small></div>
        <div className={`${styles.field} ${styles.wide}`}><label htmlFor={`system-${index}-carrier`}>本剧外观、出现／退出与人物反应规则</label><input id={`system-${index}-carrier`} maxLength={180} value={system.carrierNotes ?? ''} onChange={event => update(index, { carrierNotes: event.target.value || null })} /><small>写轮廓、尺度、位置、提示触发和收起方式。混合模式需写切换规则；人物反应只落实源已有接收关系，不新增旁人知情。</small></div>
      </div>
      <details className={styles.sources} open><summary>以同一处原提示比较方案</summary>
        <p>{system.identity || '本系统'}：{system.sourceEvidence[0]?.quote ? `「${system.sourceEvidence[0].quote}」` : '请先在下方填入一处真实提示；原话和声道保持不变。'}</p>
        <ul className={styles.systemOptions}>{Object.entries(SYSTEM_PRESENTATION_HINTS).map(([mode, hint]) => <li key={mode}><strong>{SYSTEM_PRESENTATION_MODES[mode as keyof typeof SYSTEM_PRESENTATION_MODES]}</strong>{system.sourceCarrier && mode !== 'PRESERVE_SOURCE' && mode !== system.sourceCarrier.mode ? '（与源载体互斥，当前不可选）' : ''}：{system.options?.find(option => option.mode === mode)?.description ?? hint}</li>)}</ul>
        <p>以上是本提示可讨论的创作菜单，不代表某平台统一规范。原文已锁定的实体或外观，改用互斥载体须留待源冲突裁决。</p>
      </details>
      <div className={styles.formGrid}>{(system.sourceEvidence.length ? system.sourceEvidence : [{ evidenceId: '', quote: '' }]).map((ref, refIndex) => <div className={`${styles.field} ${styles.wide}`} key={refIndex}>
        {citation(ref, next => update(index, { sourceEvidence: system.sourceEvidence.length ? system.sourceEvidence.map((old, i) => i === refIndex ? next : old) : [next] }), `system-${index}-source-${refIndex}`)}
        {system.sourceEvidence.length > 1 ? <button className="studioButton" type="button" onClick={() => update(index, { sourceEvidence: system.sourceEvidence.filter((_, i) => i !== refIndex) })}>移除此锚点</button> : null}
      </div>)}</div>
      <small>锚点须与真实源文逐字匹配；摘录只证明出处，不能自证解释正确。前集依据不等于当集出场或永久状态，后续身份不提前投递。</small>
      <div className={styles.actions}><button className="studioButton" data-variant="secondary" type="button" disabled={disabled || system.sourceEvidence.length >= 4} onClick={() => update(index, { sourceEvidence: [...system.sourceEvidence, { evidenceId: '', quote: '' }] })}>添加原文锚点</button></div>
      <div className={styles.field}><label htmlFor={`system-${index}-source-mode`}>原文明确的载体／外观</label><select id={`system-${index}-source-mode`} value={system.sourceCarrier?.mode ?? ''} onChange={event => update(index, { sourceCarrier: event.target.value ? { mode: event.target.value as NonNullable<SystemPresentationChoice['sourceCarrier']>['mode'], evidenceId: '', quote: '' } : null })}>
        <option value="">未登记／待核对 · 不等于原文无实体</option>{Object.entries(SYSTEM_PRESENTATION_MODES).filter(([mode]) => mode !== 'PRESERVE_SOURCE').map(([mode, label]) => <option value={mode} key={mode}>{label}</option>)}
      </select>{system.sourceCarrier ? citation(system.sourceCarrier, ref => update(index, { sourceCarrier: { ...ref, mode: system.sourceCarrier!.mode } }), `system-${index}-source-carrier`) : <small>保留未知，不据此推断没有实体；实际制作仍先核原文，不能用偏好抹去源实体。</small>}</div>
      <div className={styles.formGrid}>{Object.entries(SYSTEM_PRESENTATION_BOUNDARIES).map(([key, options]) => <div className={styles.field} key={key}><label htmlFor={`system-${index}-${key}`}>{({ visibility: '载体可见范围', audibility: '载体可听范围', contact: '实体接触', screenText: '屏字边界' })[key as keyof typeof SYSTEM_PRESENTATION_BOUNDARIES]}</label><select id={`system-${index}-${key}`} value={system[key as keyof typeof SYSTEM_PRESENTATION_BOUNDARIES]} onChange={event => update(index, { [key]: event.target.value })}>{Object.entries(options).map(([option, label]) => <option key={option} value={option}>{label}</option>)}</select></div>)}</div>
      <div className={styles.field}><label htmlFor={`system-${index}-rationale`}>本系统建议／选择理由（非源事实）</label><input id={`system-${index}-rationale`} maxLength={140} value={system.rationale ?? ''} onChange={event => update(index, { rationale: event.target.value || null })} /></div>
      <button className="studioButton" data-variant="secondary" type="button" disabled={disabled} onClick={() => { const next = systems.filter((_, i) => i !== index); onChange(next.length ? { systems: next } : undefined); }}>移除此系统选择</button>
      </details>
    </fieldset>; })}
    <button className="studioButton" data-variant="secondary" type="button" disabled={disabled || systems.length >= 8} onClick={() => onChange({ systems: [...systems, newSystemPresentationChoice(`system-${Date.now()}-${systems.length}`)] })}>添加有源系统</button>
  </details>;
}
