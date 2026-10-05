import { useState } from 'react';
import { assetMarker, replaceUnitAsset, unitAssetEditingProblems } from './unitAssetEditing';
import { moveItem } from './contracts';
import { adoptedImage, Button, kindName, MediaPreview, Modal } from './components';
import type { AssetRef, Mutation, Unit, Workspace } from './types';
import './unitAssetEditor.css';

export function UnitAssetEditor({ workspace, unit, writable, mutate, onClose }: { workspace: Workspace; unit: Unit; writable: boolean; mutate: Mutation; onClose: () => void }) {
  const [references, setReferences] = useState<AssetRef[]>([...(unit.assetRefs || [])].sort((a, b) => a.order - b.order));
  const [prompt, setPrompt] = useState(unit.prompt), [changed, setChanged] = useState(false), [saving, setSaving] = useState(false);
  const problems = unitAssetEditingProblems(workspace, unit, references, prompt);
  const current = workspace.units.find(item => item.id === unit.id);
  const stale = !current || current.version !== unit.version;
  function replace(index: number, assetId: string) {
    const asset = workspace.assets.find(item => item.id === assetId); if (!asset) return;
    const next = replaceUnitAsset(prompt, references, index, { ...references[index], assetId: asset.id, variantId: asset.variantId, mediaId: undefined });
    setReferences(next.references); setPrompt(next.prompt); setChanged(true);
  }
  async function save() {
    if (!writable || saving || stale || problems.length) return;
    setSaving(true);
    try {
      const next = await mutate('units.save', { unit: { ...unit, expectedVersion: unit.version, prompt, needsAssetMapping: false, assetRefs: references.map((reference, index) => ({ ...reference, use: reference.role, order: index + 1 })) } }, '配图已保存，未提交素材包需重新准备；已提交任务保留原素材。');
      if (next) onClose();
    } finally { setSaving(false); }
  }
  return <Modal title={`调整配图 · ${unit.title || unit.id}`} onClose={onClose}>
    <p className="control-hint">替换错误的资产形象，或增减、调整图片顺序。每处配图使用该形象的当前图片。</p>
    <div className="unit-asset-edit-list">{references.map((reference, index) => {
      const asset = workspace.assets.find(item => item.id === reference.assetId), previous = asset || workspace.deletedAssets?.find(item => item.id === reference.assetId), image = previous && adoptedImage(workspace, previous);
      return <section key={index} className="unit-asset-edit-row">
        <div className="unit-asset-edit-preview"><MediaPreview media={image} compact/><small>图片 {index + 1}</small></div>
        <div className="unit-asset-edit-fields"><label>资产与形象<select aria-label={`配图 ${index + 1} 资产`} value={reference.assetId} disabled={!writable || saving} onChange={event => replace(index, event.target.value)}>
          {!asset && <option value={reference.assetId}>{previous?.name ? `${previous.name} · ` : ''}已删除或缺失 · 请替换</option>}
          {workspace.assets.map(item => <option key={item.id} value={item.id}>{item.name} · {kindName(item.kind || item.type)}{item.description ? ` · ${item.description.slice(0, 36)}` : ''}</option>)}
        </select></label><label>素材用途<input aria-label={`配图 ${index + 1} 用途`} value={reference.role} disabled={!writable || saving} onChange={event => setReferences(current => current.map((item, position) => position === index ? { ...item, role: event.target.value } : item))}/></label>
          <small className="muted">{asset ? image ? '使用当前图片' : '该形象尚无图片，可先保存配图后补图。' : '历史图片和已提交任务保留，当前制作需修正这处引用。'}</small>
          {asset && reference.variantId !== asset.variantId && <Button variant="ghost" disabled={!writable || saving} onClick={() => replace(index, asset.id)}>使用当前形象</Button>}
          {reference.mediaId && <Button variant="ghost" disabled={!writable || saving} onClick={() => { setReferences(current => current.map((item, position) => position === index ? { ...item, mediaId: undefined } : item)); setChanged(true); }}>改用当前图片</Button>}
        </div><div className="unit-asset-edit-actions"><Button aria-label={`配图 ${index + 1} 向前`} disabled={!writable || saving || index === 0} onClick={() => { setReferences(current => moveItem(current, index, index - 1)); setChanged(true); }}>↑</Button><Button aria-label={`配图 ${index + 1} 向后`} disabled={!writable || saving || index === references.length - 1} onClick={() => { setReferences(current => moveItem(current, index, index + 1)); setChanged(true); }}>↓</Button><Button variant="ghost" disabled={!writable || saving} onClick={() => { setReferences(current => current.filter((_, position) => position !== index)); setChanged(true); }}>移除</Button></div>
      </section>;
    })}</div>
    <Button icon="plus" disabled={!writable || saving || !workspace.assets.length} onClick={() => { const asset = workspace.assets[0]; setReferences(current => [...current, { assetId: asset.id, variantId: asset.variantId, role: 'reference', order: current.length + 1 }]); setChanged(true); }}>添加配图</Button>
    <details className="details unit-asset-prompt" open={changed}><summary>核对文字提示词</summary>
      <p className="control-hint">替换时同步明确的素材身份标记；人物称呼、形象描述和已有 @图片编号请自行核对。移除素材时需处理对应文字。</p>
      <textarea aria-label="配图对应提示词" rows={9} value={prompt} disabled={!writable || saving} onChange={event => setPrompt(event.target.value)}/>
      <small className="muted">素材标记按最终顺序编译：{references.map(assetMarker).join('、') || '无图片引用'}</small>
    </details>
    {stale && <p className="warning">单元已更新，请关闭后重新打开配图。</p>}{problems.length > 0 && <div className="warning">{problems.map(problem => <p key={problem}>{problem}</p>)}</div>}
    <div className="form-actions"><Button disabled={saving} onClick={onClose}>取消</Button><Button variant="primary" disabled={!writable || saving || stale || !!problems.length} onClick={() => void save()}>{saving ? '正在保存' : '保存配图'}</Button></div>
  </Modal>;
}
