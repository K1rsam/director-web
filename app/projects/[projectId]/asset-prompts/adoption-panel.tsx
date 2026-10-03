'use client';
import {useEffect, useRef, useState} from 'react';
import {compileImagePrompt, emptyImageOptions} from '@/lib/asset-image-options';
import type {PromptWorkspace} from '@/lib/asset-prompt-contract';
import type {AssetDesignAdoptionWorkspace} from '@/lib/asset-design-adoption';
import styles from './adoption-panel.module.css';

type Draft = {brief: string; freeDesignScope?: string; referenceIds: string[]; restoredFromVersion?: number};
export function AssetDesignAdoptionPanel({projectId, assetKey, workspace, disabled = false, initial, onStateChange}: {
  projectId: string; assetKey: string; workspace: PromptWorkspace; disabled?: boolean; initial?: AssetDesignAdoptionWorkspace; onStateChange?: (next: AssetDesignAdoptionWorkspace) => void;
}) {
  const [data, setData] = useState(initial), [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [pending, setPending] = useState(false), [loading, setLoading] = useState(!initial), [error, setError] = useState(''), [notice, setNotice] = useState(''), [confirmed, setConfirmed] = useState(false);
  const requestId = useRef(0), submitting = useRef(false);
  const stateChange = useRef(onStateChange); stateChange.current = onStateChange;
  const endpoint = `/projects/${projectId}/asset-prompts/adoption`, asset = workspace.assets.find(item => item.key === assetKey), view = data?.assets[assetKey];
  const draft = drafts[assetKey] ?? {brief: view?.current?.brief ?? '', freeDesignScope:view?.current?.freeDesignScope??'', referenceIds: view?.current?.referenceIds ?? []};
  const relevantKeys = new Set([assetKey]);
  for (const key of relevantKeys) {const item = workspace.assets.find(asset => asset.key === key), source = item?.fromKey ?? (item?.variant ? item.baseKey : undefined); if (source) relevantKeys.add(source);}
  const refreshKey = JSON.stringify([projectId, assetKey, workspace.busy, workspace.styleRevision, workspace.stylePrefix, workspace.style, [...relevantKeys].map(key => [key, workspace.assets.find(item => item.key === key)?.fingerprint, workspace.records[key]?.revision]), workspace.imageOptions?.[assetKey]?.references]);
  const onlyText = asset && ['INLINE', 'AUDIO'].includes(asset.mode);
  const status = !view ? '正在读取采用状态' : view.status === 'STALE' ? '待更新 · 保留旧采用' : view.status === 'REFERENCE_ADOPTED' ? '已采用 · 参考图' : view.status === 'TEXT_ADOPTED' ? '已采用 · 仅文字' : onlyText ? '无需独立图 · 仅文字' : '未采用 · 仅文字';
  const fullPrompt = compileImagePrompt(workspace.stylePrefix, workspace.records[assetKey]?.body ?? '', workspace.imageOptions?.[assetKey] ?? emptyImageOptions());
  async function refresh() {
    const current = ++requestId.current;
    const response = await fetch(endpoint, {cache: 'no-store'}), next = await response.json();
    if (!response.ok) throw new Error(next.error || '暂时无法读取采用记录。');
    if (current === requestId.current) {setData(next); stateChange.current?.(next);}
  }
  useEffect(() => {
    let active = true;
    setLoading(true); setConfirmed(false); setError(''); setNotice('');
    void refresh().catch(reason => {if (active) setError((reason as Error).message);}).finally(() => {if (active) setLoading(false);});
    return () => {active = false; requestId.current++;};
    // Only this asset's saved inputs and actual derivation dependencies trigger a refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, endpoint]);
  function edit(next: Draft) {setDrafts(previous => ({...previous, [assetKey]: next})); setConfirmed(false); setNotice('');}
  async function submit(action: 'adopt' | 'revoke' | 'restore') {
    if (!view || submitting.current) return;
    if (action === 'revoke' && !window.confirm('撤销当前设计采用？历史与参考图文件会保留，可核对后恢复。')) return;
    submitting.current = true; setPending(true); setError(''); setNotice('');
    const submittedKey = assetKey, submittedDraft = {...draft, referenceIds: [...draft.referenceIds]};
    // Keep a user's review text even when another window wins the version check.
    setDrafts(previous => ({...previous, [submittedKey]: submittedDraft}));
    try {
      const response = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action, assetKey: submittedKey, expectedRevision: view.revision,
        ...(action === 'revoke' ? {} : {expectedMaterialToken: view.materialToken, brief: submittedDraft.brief, freeDesignScope:submittedDraft.freeDesignScope??'', referenceIds: submittedDraft.referenceIds, ...(action === 'restore' ? {version: submittedDraft.restoredFromVersion} : {})})})});
      const next = await response.json();
      if (!response.ok) {
        setConfirmed(false);
        try {await refresh();} catch {}
        throw new Error(next.error || '采用操作未完成，请刷新后重试。');
      }
      ++requestId.current; setData(next); stateChange.current?.(next); setConfirmed(false);
      setDrafts(previous => {const result = {...previous}; if (JSON.stringify(result[submittedKey]) === JSON.stringify(submittedDraft)) delete result[submittedKey]; return result;});
      setNotice(action === 'revoke' ? '已撤销；采用历史和参考图文件均保留。' : '已采用此简述；仅交接所需资产文字与参考图描述，不表示分镜已看过图片或图像质量已验收。');
    } catch (reason) {setError((reason as Error).message);} finally {submitting.current = false; setPending(false);}
  }
  const blocked = pending || loading || disabled || !data?.canAdopt;
  const briefLength = [...draft.brief.trim()].length;
  return <section className={styles.panel} aria-label="设计采用与分镜交接" aria-busy={pending || loading}>
    <div className={styles.heading}><h4>设计采用与分镜交接</h4><span className={styles.badge} data-state={view?.status}>{status}</span></div>
    <p className={styles.hint}>{onlyText ? '此资产无需独立制图，不是未完成的图片任务。' : '保存提示词不会自动采用；基础与子形象分别核对。'}缺少图片不阻断文字分镜。</p>
    {view?.current && <p className={styles.version}>采用 v{view.current.version} · 提示词 v{view.current.promptRevision} · {view.current.actor.name} · {new Date(view.current.createdAt).toLocaleString('zh-CN')}</p>}
    {view?.reason && <p className={styles.warning}>{view.reason}</p>}
    <label className={styles.label}>分镜简述 <span>{briefLength} / 600 字</span><textarea aria-label="分镜简述" rows={5} value={draft.brief} disabled={pending || !data?.canAdopt} placeholder="手动填写供分镜使用的外观、空间或道具约束；不要粘贴完整生图提示词。" onChange={event => edit({...draft, brief: event.target.value})}/></label>
    <p className={styles.hint}>优先写支撑动作的门、通路、遮挡、固定物与道具功能，不写分镜。原文视觉／功能依据自动单列；此简述只表示已采用设计增补，不冒充原文事实。未采用也投递本集有来源的文字。</p>
    <label className={styles.label}>自由设计范围 <span>{[...(draft.freeDesignScope??'')].length} / 300 字</span><textarea aria-label="自由设计范围" rows={2} maxLength={300} value={draft.freeDesignScope??''} disabled={pending||!data?.canAdopt} placeholder="可选：如墙面色调可补足；门位、逃生通路与道具能力不得改动。" onChange={event=>edit({...draft,freeDesignScope:event.target.value})}/></label>
    <p className={styles.hint}>简述不会从长提示词截断；生产卡区分实际出场与仅供派生的材料。只传参考说明，不传整库提示词或图片像素。</p>
    <details className={styles.details}><summary>对照当前已保存的完整提示词</summary><textarea aria-label="对照当前已保存的完整提示词" rows={7} readOnly value={fullPrompt}/></details>
    {Boolean(view?.references.length) && <fieldset className={styles.references} disabled={blocked}><legend>明确采用参考图（可不选）</legend>{view!.references.map(reference => <label key={reference.id} className={styles.reference}>
      <input type="checkbox" checked={draft.referenceIds.includes(reference.id)} onChange={event => edit({...draft, referenceIds: event.target.checked ? [...draft.referenceIds, reference.id] : draft.referenceIds.filter(id => id !== reference.id)})}/><span>{reference.name}</span>
      <a href={`/projects/${projectId}/asset-prompts/api?key=${encodeURIComponent(assetKey)}&reference=${encodeURIComponent(reference.id)}`} target="_blank" rel="noreferrer">查看参考图</a>
    </label>)}</fieldset>}
    <p className={styles.hint}>参考图仅来自此资产的人工上传；上传、选用与图片生成、质量验收是不同状态。</p>
    {data && !data.canAdopt ? <p className={styles.hint}>当前为只读；管理员或审查员可采用与撤销。</p> : <label className={styles.confirm}><input type="checkbox" aria-label="我已核对简述与当前已保存提示词" checked={confirmed} disabled={blocked || !view?.canAdopt} onChange={event => setConfirmed(event.target.checked)}/>我已核对简述与当前已保存提示词</label>}
    <div className={styles.actions}>
      {data?.canAdopt && <button className="studioButton" data-variant="primary" disabled={blocked || !view?.canAdopt || !confirmed || !briefLength || briefLength > 600} onClick={() => void submit(draft.restoredFromVersion === undefined ? 'adopt' : 'restore')}>{pending ? '正在保存…' : draft.restoredFromVersion === undefined ? '采用当前设计' : '核对后恢复采用'}</button>}
      {data?.canAdopt && view?.current && <button className="studioButton" data-variant="danger" disabled={blocked} onClick={() => void submit('revoke')}>撤销采用</button>}
      <button className="studioButton" data-variant="secondary" disabled={pending || loading} onClick={async () => {setLoading(true); setConfirmed(false); setError(''); try {await refresh();} catch (reason) {setError((reason as Error).message);} finally {setLoading(false);}}}>刷新采用状态</button>
    </div>
    {disabled && <p className={styles.hint}>请先保存当前提示词、画风或图片设置修改，再核对采用。</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.hint} role="status">{notice}</p>}
    {Boolean(view?.history.length) && <details className={styles.details}><summary>采用历史 · {view!.history.length} 条</summary>{[...view!.history].reverse().map(entry => <article className={styles.history} key={entry.version}>
      <p className={styles.version}>v{entry.version} · {entry.action === 'ADOPT' ? '采用' : '撤销'} · {entry.actor.name} · {new Date(entry.createdAt).toLocaleString('zh-CN')}</p>
      {entry.brief && <p className={styles.brief}>{entry.brief}</p>}
      {entry.action === 'ADOPT' && data?.canAdopt && <button className="studioButton" data-variant="secondary" disabled={blocked} onClick={() => {edit({brief: entry.brief ?? '', freeDesignScope:entry.freeDesignScope??'', referenceIds: (entry.referenceIds ?? []).filter(id => view!.references.some(reference => reference.id === id)), restoredFromVersion: entry.version}); setNotice('已载入历史简述；请对照当前提示词核对修改，再确认恢复。已移除的参考图不会自动恢复。');}}>载入简述并核对恢复</button>}
    </article>)}</details>}
  </section>;
}
