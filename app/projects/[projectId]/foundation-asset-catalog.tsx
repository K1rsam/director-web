"use client";

import { useState } from 'react';
import type { Preparation, ProductionAsset, ProductionCatalog, ProductionVariant } from '@/lib/foundation-production-contracts';
import styles from './foundation-asset-catalog.module.css';

type View = 'queue' | 'all' | 'pending';
type Filters = { query: string; episode: string; type: string; view: View; role?: string; layer?: string };
const labels = { REFERENCE: '独立准备', DERIVE: '复用／派生', INLINE: '随场生成', AUDIO: '声音', UNRESOLVED: '待定／未分类' };
const types = { CH: '人物', GROUP: '群像', BEAST: '非人', LOC: '场景', PROP: '道具' };
const roles = ['主角', '配角', '反派', '路人', '群像'];
const roleOf = (asset: ProductionAsset) => asset.role?.trim() || '';
const defaultFilters: Filters = { query: '', episode: '', type: '', view: 'all', role: '', layer: '' };
const modeOf = (item: { key: string; preparation?: Preparation }, pending: Set<string>) => pending.has(item.key) ? 'UNRESOLVED' : item.preparation?.mode ?? 'UNRESOLVED';
const range = (episodes: number[]) => episodes.length ? `第${[...new Set(episodes)].sort((a, b) => a - b).join('、')}集` : '未定位适用范围，不默认出图';

function pendingDependencies(catalog: ProductionCatalog, pendingKeys: string[]) {
  const items = catalog.assets.flatMap(asset => [
    { key: asset.key, preparation: asset.preparation, parentKey: undefined },
    ...asset.variants.map(variant => ({ key: variant.key, preparation: variant.preparation, parentKey: asset.key }))
  ]);
  const pending = new Set([...pendingKeys, ...(catalog.repairItems ?? []).flatMap(item => [item.assetKey, item.variantKey]),
    ...items.filter(item => !item.preparation || item.preparation.mode === 'UNRESOLVED').map(item => item.key)]);
  // Follow recorded DERIVE edges, including the contract-defined default parent.
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      const sourceKey = item.preparation?.fromKey ?? item.parentKey;
      if (!pending.has(item.key) && item.preparation?.mode === 'DERIVE' && sourceKey && pending.has(sourceKey)) {
        pending.add(item.key);
        changed = true;
      }
    }
  }
  return pending;
}

export function summarizeAssetCatalog(catalog: ProductionCatalog, pendingKeys: string[] = []) {
  const totals = { bases: catalog.assets.length, variants: 0, REFERENCE: 0, DERIVE: 0, INLINE: 0, AUDIO: 0, UNRESOLVED: 0 };
  const pending = pendingDependencies(catalog, pendingKeys);
  for (const asset of catalog.assets) {
    totals.variants += asset.variants.length;
    for (const item of [asset, ...asset.variants]) totals[modeOf(item, pending)]++;
  }
  return totals;
}

export function filterAssetCatalog(catalog: ProductionCatalog, filters: Filters, pendingKeys: string[] = []) {
  const pending = pendingDependencies(catalog, pendingKeys);
  const query = filters.query.trim().toLocaleLowerCase();
  const matches = (item: { key: string; preparation?: Preparation }, episodes: number[], name: string) => {
    const mode = modeOf(item, pending);
    return (!query || name.toLocaleLowerCase().includes(query))
      && (!filters.episode || (filters.episode === 'unlocated' ? episodes.length === 0 : episodes.includes(Number(filters.episode))))
      && (filters.view === 'all' || (filters.view === 'pending' ? mode === 'UNRESOLVED' : episodes.length > 0 && (mode === 'REFERENCE' || mode === 'DERIVE')));
  };
  return catalog.assets.filter(asset => (!filters.type || asset.type === filters.type)
    && (!filters.role || (filters.role === '群像' ? asset.type === 'GROUP' : filters.role === 'other' ? (roleOf(asset) ? !roles.includes(roleOf(asset)) : asset.type === 'CH') : roleOf(asset) === filters.role))).map(asset => {
    const name = [asset.name, ...asset.aliases].join(' ');
    return { asset, baseVisible: filters.layer !== 'variant' && matches(asset, asset.usageEpisodes, name), variants: filters.layer === 'base' ? [] : asset.variants.filter(variant => matches(variant, variant.episodes, `${name} ${variant.name}`)) };
  }).filter(group => group.baseVisible || group.variants.length);
}

export function FoundationAssetCatalog({ catalog, codes = {}, pendingKeys = [], initialView = 'all', plainLanguage = false, historical = false }: {
  catalog: ProductionCatalog; codes?: Record<string, string>; pendingKeys?: string[]; initialView?: View; plainLanguage?: boolean; historical?: boolean;
}) {
  const [filters, setFilters] = useState<Filters>({ ...defaultFilters, view: initialView });
  const unavailableKeys = historical ? catalog.assets.flatMap(asset => [asset.key, ...asset.variants.map(variant => variant.key)]) : pendingKeys;
  const totals = summarizeAssetCatalog(catalog, unavailableKeys);
  const groups = filterAssetCatalog(catalog, filters, unavailableKeys);
  const pending = pendingDependencies(catalog, unavailableKeys);
  const repairKeys = new Set((catalog.repairItems ?? []).flatMap(item => [item.assetKey, item.variantKey]));
  const names = new Map(catalog.assets.flatMap(asset => [[asset.key, `${asset.name} · 基线`], ...asset.variants.map(variant => [variant.key, `${asset.name} · ${variant.name}`])] as [string, string][]));
  const episodes = [...new Set(catalog.assets.flatMap(asset => [...asset.usageEpisodes, ...asset.variants.flatMap(variant => variant.episodes)]))].sort((a, b) => a - b);
  const row = (asset: ProductionAsset, variant?: ProductionVariant) => {
    const item = variant ?? asset;
    const scope = variant ? variant.episodes : asset.usageEpisodes;
    const roleLabel = roleOf(asset) ? asset.role : asset.type === 'CH' ? '未标角色' : '';
    const sourceKey = item.preparation?.fromKey ?? (variant && item.preparation?.mode === 'DERIVE' ? asset.key : undefined);
    return <tr key={item.key} className={variant ? styles.variant : undefined}>
      <td><span className={styles.code}>{codes[item.key] ? `已核编号 ${codes[item.key]}` : '未核编号'}</span><div className={styles.tags}><span>{types[asset.type]}</span>{roleLabel && roleLabel !== types[asset.type] ? <span>{roleLabel}{variant ? ' · 继承' : ''}</span> : null}</div></td>
      <td><div className={variant ? styles.childName : styles.assetName}>{variant ? '↳ ' : ''}{item.name}<span className={styles.level}>{variant ? '子形象' : '基础'}</span></div>
        {!variant && asset.aliases.length ? <p className={styles.alias}>别名：{asset.aliases.join('、')}</p> : null}
        <details className={styles.details}><summary>查看说明</summary><dl>
          <dt>剧情关联{variant ? '（所属资产）' : ''}</dt><dd>{asset.relationNote || '未记录'}</dd>
          <dt>登记素材来源</dt><dd>{item.preparation?.mode === 'DERIVE' || item.preparation?.fromKey ? <>登记派生来源：{sourceKey && names.has(sourceKey) ? names.get(sourceKey) : '来源未定位'}</> : '未登记派生来源'}</dd>
          <dt>状态起止</dt><dd>{variant?.note || '未记录'}{variant ? <p>仅适用自身标注集号：{range(scope)}</p> : null}</dd>
          <dt>原备注</dt><dd>{item.preparation?.note ? <>原制作备注：{item.preparation.note}</> : '未记录'}</dd>
        </dl></details>
      </td>
      <td>{repairKeys.has(item.key) ? <>暂存范围：{range(scope)}<p className={styles.pending}>仅保留待核，不代表已核入镜。</p></> : range(scope)}</td>
      <td><span className={styles.badge}>{historical ? '历史记录' : repairKeys.has(item.key) ? plainLanguage ? '范围待核对' : '待Q1核对' : labels[modeOf(item, pending)]}</span>
        {pending.has(item.key) ? <p className={styles.pending}>{historical ? '历史记录，仅供阅读，不列入当前制图队列' : `${repairKeys.has(item.key) ? plainLanguage ? '范围待核对' : '待Q1核对' : pendingKeys.includes(item.key) ? plainLanguage ? '资料待完善' : 'Q1 待定' : item.preparation?.mode === 'DERIVE' ? '派生来源待定' : '制作方式待定'}：暂不列入制图队列`}；原记录方式：{item.preparation ? labels[item.preparation.mode] : '未分类'}。</p> : null}
        {!item.preparation ? <p className={styles.pending}>历史记录 · 未分类，不默认下单</p> : null}
        {item.preparation?.mode === 'AUDIO' ? <p>声音记录，无图片订单。</p> : null}
      </td>
    </tr>;
  };
  return <div className={styles.catalog}>
    <div className={styles.overview}><div><strong>{totals.bases}</strong><span>基础对象</span></div><div><strong>{totals.variants}</strong><span>必要变体／子形象</span></div>
      {Object.entries(labels).map(([key, label]) => <div key={key}><strong>{totals[key as keyof typeof labels]}</strong><span>{label}</span></div>)}
    </div>
    <p className={styles.hint}>全目录统计：制作方式计数包含基础对象与变体；完整目录不是全部制图订单，记录数不是图片张数。{plainLanguage ? '待定含接收范围待核项、未确认取舍与待续事项、依赖其来源的派生项及历史未分类。' : '待定含接收时发现的待Q1核对项、Q1 标记、依赖其来源的派生项及历史未分类。'}各版本仅适用自身标注集号，未定位范围不默认出图。</p>
    <div className={styles.filters}>
      <label>名称／别名<input type="search" placeholder="搜索人物、版本或别名" value={filters.query} onChange={event => setFilters({ ...filters, query: event.target.value })} /></label>
      <label>适用集号<select value={filters.episode} onChange={event => setFilters({ ...filters, episode: event.target.value })}><option value="">全部集号</option>{episodes.map(episode => <option key={episode} value={episode}>第{episode}集</option>)}<option value="unlocated">未定位范围</option></select></label>
      <label>资产类型<select value={filters.type} onChange={event => setFilters({ ...filters, type: event.target.value })}><option value="">全部类型</option>{Object.entries(types).map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <label>剧情角色<select value={filters.role} onChange={event => setFilters({ ...filters, role: event.target.value })}><option value="">全部角色</option>{roles.map(role => <option key={role} value={role}>{role}</option>)}<option value="other">未标或其他</option></select></label>
      <label>资产层级<select value={filters.layer} onChange={event => setFilters({ ...filters, layer: event.target.value })}><option value="">全部层级</option><option value="base">仅基础</option><option value="variant">仅子形象</option></select></label>
      <button type="button" onClick={() => setFilters({ ...defaultFilters, view: initialView })}>清空筛选</button>
    </div>
    <div className={styles.views} aria-label="目录视图">{([['queue', '制图队列'], ['all', '完整目录'], ['pending', '待定项']] as const).map(([view, title]) => <button key={view} type="button" disabled={historical && view === 'queue'} aria-pressed={filters.view === view} onClick={() => setFilters({ ...filters, view })}>{title}</button>)}</div>
    <p aria-live="polite">当前显示 {groups.length} 个对象组 · {groups.reduce((sum, group) => sum + Number(group.baseVisible) + group.variants.length, 0)} 条匹配记录{filters.view === 'queue' ? '（仅独立准备／派生，待定除外）' : ''}</p>
    <div className={styles.tableScroll} role="region" aria-label="资产目录表格" tabIndex={0} id={filters.view === 'queue' ? 'asset-preparation-queue' : 'asset-catalog-details'}>
      <table className={styles.table}><caption>资产与子形象 · {filters.view === 'queue' ? '制图队列' : filters.view === 'pending' ? '待定项' : '完整目录'}</caption><thead><tr><th scope="col">编号／类别／剧情角色</th><th scope="col">资产／子形象</th><th scope="col">适用集</th><th scope="col">制作方式</th></tr></thead>
        {groups.length ? groups.map(({ asset, baseVisible, variants }) => <tbody key={asset.key} aria-label={asset.name}>
          {baseVisible ? row(asset) : <tr className={styles.context}><td colSpan={4}>{asset.name} · 仅家族上下文，不是本次制图条目；基础不符合当前筛选。</td></tr>}
          {variants.map(variant => row(asset, variant))}
        </tbody>) : <tbody><tr><td colSpan={4}>没有匹配记录，可清空筛选或查看完整目录。</td></tr></tbody>}
      </table>
    </div>
    <p className={styles.hint}>剧情角色是剧情功能，不是身份；未标历史记录不推断，子形象继承所属资产角色。剧情关联与登记素材来源分开；派生来源按已登记关系原样展示，制作备注单独保留，不按备注推断或改写来源。</p>
  </div>;
}
