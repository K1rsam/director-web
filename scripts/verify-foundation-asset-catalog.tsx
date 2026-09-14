import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ProductionCatalog, ProductionAsset } from '../lib/foundation-production-contracts';
const require = createRequire(import.meta.url);
// Node has no CSS pipeline; only stylesheet loading is substituted, never the component.
require.extensions['.css'] = module => { module.exports = {}; };
assert.ok(existsSync(new URL('../app/projects/[projectId]/foundation-asset-catalog.tsx', import.meta.url)), '独立资产目录组件尚未实现');
const { FoundationAssetCatalog, filterAssetCatalog, summarizeAssetCatalog } = require('../app/projects/[projectId]/foundation-asset-catalog') as typeof import('../app/projects/[projectId]/foundation-asset-catalog');
const asset = (key: string, type: ProductionAsset['type'], mode?: string) => ({ key, name: key, type, aliases: [], sourceRefs: [], description: '', appearances: [], usageEpisodes: [1, 2], variants: [], ...(mode ? { preparation: { mode } } : {}) } as ProductionAsset);
const catalog: ProductionCatalog = { format: 'ASSET_CATALOG_V2', coverage: [1, 2], episodes: [], issues: [], assets: [asset('清雅', 'CH', 'REFERENCE'), asset('群体', 'GROUP', 'INLINE'), asset('狼', 'BEAST', 'AUDIO'), asset('院子', 'LOC', 'UNRESOLVED'), asset('旧物', 'PROP'), asset('争议', 'PROP', 'REFERENCE')] };
catalog.assets[0].aliases = ['小雅'];
catalog.assets[0].variants = [{ key: 'white', name: '白裙', episodes: [1], note: '同集换装', preparation: { mode: 'DERIVE', fromKey: '清雅' } }, { key: 'hurt', name: '白裙带伤', episodes: [2], note: '沿用白裙', preparation: { mode: 'DERIVE', fromKey: 'white' } }, { key: 'lost', name: '<script>未知</script>', episodes: [], note: '', preparation: { mode: 'DERIVE', fromKey: 'missing' } }];
catalog.assets[1].variants = [{ key: 'crowd-ref', name: '需参考版本', episodes: [2], note: '', preparation: { mode: 'REFERENCE' } }];
const pendingKeys = ['争议'];
function freeze(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const nested of Object.values(value)) freeze(nested);
  Object.freeze(value);
}
freeze(catalog);
const before = JSON.stringify(catalog);
const summary = summarizeAssetCatalog(catalog, pendingKeys);
assert.deepEqual(summary, { bases: 6, variants: 4, REFERENCE: 2, DERIVE: 3, INLINE: 1, AUDIO: 1, UNRESOLVED: 3 });
const filtered = (query = '', episode = '', type = '', view: 'queue' | 'all' | 'pending' = 'all') => filterAssetCatalog(catalog, { query, episode, type, view }, pendingKeys);
assert.equal(filtered('小雅').length, 1);
assert.equal(filtered('白裙带伤')[0].variants.length, 1);
assert.deepEqual(filtered('', '1')[0].variants.map(v => v.key), ['white']);
assert.equal(filtered('', 'unlocated')[0].variants[0].key, 'lost');
for (const type of ['CH', 'GROUP', 'BEAST', 'LOC', 'PROP']) assert.ok(filtered('', '', type).every(g => g.asset.type === type));
assert.equal(filtered('', '', '', 'pending').length, 3);
assert.ok(!filtered('', '', '', 'queue').some(g => g.asset.key === '争议' || g.asset.key === '旧物'));
assert.equal(filtered('', '', '', 'queue').find(g => g.asset.key === '群体')?.baseVisible, false);
const render = (view: 'queue' | 'all' | 'pending') => renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog, pendingKeys, codes: { hurt: 'CH-001-V2' }, initialView: view }));
const html = render('all');
assert.ok(html.includes('<table') && html.includes('<thead>') && html.includes('<tbody'), '默认目录必须是真实表格而非卡片');
assert.ok(html.includes('剧情角色') && html.includes('仅基础') && html.includes('仅子形象'), '角色与层级筛选可见');
assert.ok(html.includes('清雅 · 白裙') && html.includes('CH-001-V2') && html.includes('同集换装') && html.includes('来源未定位'));
assert.ok(html.includes('&lt;script&gt;') && !html.includes('<script>'));
assert.ok(html.includes('基础对象') && html.includes('必要变体') && html.includes('清空筛选'));
assert.ok(render('queue').includes('仅家族上下文，不是本次制图条目'));
const legacy = { ...catalog, format: 'ASSET_CATALOG_V1' as const, assets: [asset('旧版未分类', 'PROP')] };
assert.equal(filterAssetCatalog(legacy, { query: '', episode: '', type: '', view: 'queue' }).length, 0);
const legacyHtml = renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog: legacy, initialView: 'pending' }));
assert.ok(legacyHtml.includes('历史记录 · 未分类，不默认下单'));
assert.equal(JSON.stringify(catalog), before);
const dependent = { ...catalog, assets: [asset('pending-base', 'CH', 'REFERENCE'), asset('cross-family', 'PROP', 'DERIVE'), asset('unlocated-ref', 'LOC', 'REFERENCE')] };
dependent.assets[0].variants = [{ key: 'dependent-hurt', name: '带伤', episodes: [1], note: '', preparation: { mode: 'DERIVE', fromKey: 'pending-base' } }];
dependent.assets[1].preparation!.fromKey = 'dependent-hurt';
dependent.assets[2].usageEpisodes = [];
freeze(dependent);
const dependentBefore = JSON.stringify(dependent);
const dependentQueue = filterAssetCatalog(dependent, { query: '', episode: '', type: '', view: 'queue' }, ['pending-base']);
assert.equal(dependentQueue.length, 0, 'Q1待定来源经同族和跨族派生链传播，未定位REFERENCE也不默认派图');
const dependentAll = renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog: dependent, pendingKeys: ['pending-base'], initialView: 'all' }));
assert.ok(dependentAll.includes('派生来源待定') && dependentAll.includes('未定位适用范围，不默认出图'));
assert.equal(filterAssetCatalog(dependent, { query: '', episode: 'unlocated', type: '', view: 'all' })[0].asset.key, 'unlocated-ref');
assert.equal(dependent.assets[2].preparation!.mode, 'REFERENCE');
assert.equal(JSON.stringify(dependent), dependentBefore);
const roles = { ...catalog, assets: [asset('主角本人', 'CH', 'REFERENCE'), asset('伙伴', 'CH', 'REFERENCE'), asset('敌人', 'CH', 'REFERENCE'), asset('过客', 'CH', 'REFERENCE'), asset('群众', 'GROUP', 'INLINE'), asset('神兽', 'BEAST', 'REFERENCE'), asset('未标人物', 'CH', 'REFERENCE'), asset('未知角色', 'CH', 'REFERENCE')] };
['主角', '配角', '反派', '路人'].forEach((role, index) => Object.assign(roles.assets[index], { role }));
Object.assign(roles.assets[7], { role: '亦敌亦友' });
Object.assign(roles.assets[5], { relationNote: '主角的契约伙伴；不是人物子形象', preparation: { mode: 'REFERENCE', note: '历史备注：变身' } });
roles.assets[0].aliases = ['小主'];
roles.assets[0].variants = [{ key: 'wound', name: '伤态参考', episodes: [2], note: '第二集起受伤', preparation: { mode: 'DERIVE', fromKey: '主角本人' } }, { key: 'inline-wound', name: '临时伤态', episodes: [1], note: '当场擦伤', preparation: { mode: 'INLINE' } }];
freeze(roles);
const roleBefore = JSON.stringify(roles);
const { buildSourceIndex } = require('../lib/project-foundation-contracts') as typeof import('../lib/project-foundation-contracts');
const { requireProductionCatalogAuthor, projectProductionCatalog } = require('../lib/foundation-production-contracts') as typeof import('../lib/foundation-production-contracts');
const plannedIndex = buildSourceIndex([{ number: 1, title: '准备', content: '1-1 日 内 家中\n甲准备次日潜水，随后仍穿日常装出门。' }]);
const planned = requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [1], assets: [{
  name: '甲', type: 'CH', role: '男主', episodes: [1], sceneRefs: [{ episode: 1, sceneKey: '1-1' }], preparation: { mode: 'REFERENCE' },
  variants: [{ name: '潜水用途', episodes: [], sceneRefs: [], note: '准备用途；原文尚未出现实际穿戴，不绑定使用场。', preparation: { mode: 'DERIVE' } }]
}] }, plannedIndex, [1]);
const plannedVersion = planned.assets[0].variants[0];
assert.deepEqual(plannedVersion.episodes, []);
assert.deepEqual(plannedVersion.sceneRefs, []);
assert.deepEqual(projectProductionCatalog(planned, [1]).assets[0].variants[0].sceneRefs, [], '交接投影不把准备证据变成实际场引用');
assert.equal(filterAssetCatalog(planned, { query: '', episode: '', type: '', view: 'all', layer: 'variant' }).length, 1, '准备用途保留可查看');
assert.equal(filterAssetCatalog(planned, { query: '', episode: '1', type: '', view: 'all', layer: 'variant' }).length, 0, '准备造型不冒充本集实际使用');
assert.equal(filterAssetCatalog(planned, { query: '', episode: '', type: '', view: 'queue', layer: 'variant' }).length, 0, '未定位准备不自动列入必备图队列');
const leads = { ...catalog, assets: ['男主', '女主', '主角', '配角'].map((role, i) => ({
  ...asset(`lead-${i}`, 'CH', 'REFERENCE'), role,
  variants: [{ key: `lead-${i}-v`, name: '工作服', episodes: [1], note: '', preparation: { mode: 'INLINE' as const } }]
})) };
for (const role of ['男主', '女主', '主角', '配角']) {
  const result = filterAssetCatalog(leads, { query: '', episode: '', type: 'CH', view: 'all', role });
  assert.equal(result.length, 1);
  assert.equal(result[0].asset.role, role);
  assert.equal(result[0].variants.length, 1, '角色筛选保留继承该角色的子形象');
}
assert.equal(filterAssetCatalog(leads, { query: '', episode: '', type: '', view: 'all', role: 'other' }).length, 0);
const leadHtml = renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog: leads }));
for (const role of ['男主', '女主']) {
  assert.ok(leadHtml.includes(`value="${role}"`));
  assert.ok(leadHtml.includes(`${role} · 继承`));
}
assert.ok(!leadHtml.includes('男二') && !leadHtml.includes('女二'));
const select = (extra: Record<string, string>) => filterAssetCatalog(roles, { query: '', episode: '', type: '', view: 'all', ...extra });
const labelFixture = { ...roles, assets: [...roles.assets, asset('普通场景', 'LOC', 'REFERENCE'), asset('普通道具', 'PROP', 'REFERENCE'), { ...asset('显式配角群像', 'GROUP', 'REFERENCE'), role: '配角' }] };
freeze(labelFixture);
const labelHtml = renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog: labelFixture }));
const labelBody = (name: string) => labelHtml.split(`<tbody aria-label="${name}">`)[1].split('</tbody>')[0];
const labelFailures: string[] = [];
for (const [name, check] of [
  ['角色展示去噪', () => {
    for (const key of ['普通场景', '普通道具', '神兽']) assert.ok(!labelBody(key).includes('历史／未标') && !labelBody(key).includes('未标角色'));
    assert.ok(labelBody('未标人物').includes('未标角色'));
    assert.ok(labelBody('群众').includes('群像') && !labelBody('群众').includes('群体'));
    assert.equal((labelBody('群众').match(/群像/g) ?? []).length, 1);
  }],
  ['群像按类型筛选', () => assert.deepEqual(filterAssetCatalog(labelFixture, { query: '', episode: '', type: '', view: 'all', role: '群像' }).map(g => g.asset.key), ['群众', '显式配角群像'])],
  ['未标筛选不包含普通非人物', () => assert.deepEqual(filterAssetCatalog(labelFixture, { query: '', episode: '', type: '', view: 'all', role: 'other' }).map(g => g.asset.key), ['未标人物', '未知角色'])],
] as const) { try { check(); } catch { labelFailures.push(name); } }
assert.deepEqual(labelFailures, [], `角色精简缺口：${labelFailures.join('、')}`);
for (const [role, key] of [['主角', '主角本人'], ['配角', '伙伴'], ['反派', '敌人'], ['路人', '过客'], ['群像', '群众']]) assert.deepEqual(select({ role }).map(g => g.asset.key), [key]);
assert.deepEqual(select({ role: 'other' }).map(g => g.asset.key), ['未标人物', '未知角色']);
assert.equal(select({ layer: 'base' }).flatMap(g => g.variants).length, 0);
assert.ok(select({ layer: 'variant' }).every(g => !g.baseVisible));
assert.deepEqual(select({ layer: 'variant', role: '主角', query: '小主', episode: '1', type: 'CH' })[0].variants.map(v => v.key), ['inline-wound']);
assert.equal(select({ layer: 'variant', episode: '1', view: 'queue' }).length, 0, 'INLINE子形象不进入制图队列');
assert.equal(select({ query: '伤态', episode: '2' })[0].variants[0].key, 'wound');
assert.equal(select({ layer: 'variant', type: 'BEAST' }).length, 0, '剧情关联不能将神兽变成人物子形象');
const roleHtml = renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog: roles, initialView: 'all' }));
assert.ok(roleHtml.includes('亦敌亦友') && roleHtml.includes('未标角色'), '未知角色保留原值，历史不自动猜角色');
assert.ok(roleHtml.includes('<details') && roleHtml.includes('剧情关联') && roleHtml.includes('登记素材来源') && roleHtml.includes('状态起止') && roleHtml.includes('原备注'));
assert.ok(roleHtml.includes('主角的契约伙伴；不是人物子形象') && roleHtml.includes('历史备注：变身') && roleHtml.includes('未记录'));
assert.ok(roleHtml.includes('主角 · 继承'), '子形象显示继承的剧情角色');
assert.ok(roleHtml.includes('10 条匹配记录'), '完整目录计数包含8个基础与2个子形象');
const defaultHtml = renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog: roles }));
assert.ok(defaultHtml.includes('id="asset-catalog-details"') && defaultHtml.includes('临时伤态') && defaultHtml.includes('完整目录不是全部制图订单'), '默认完整目录包括INLINE但不宣称全部下单');
const roleQueue = renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog: roles, initialView: 'queue' })).split('<table')[1];
assert.ok(roleQueue.includes('伤态参考') && !roleQueue.includes('临时伤态') && !roleQueue.includes('群众'), '实际queue SSR不渲染INLINE行');
assert.equal(JSON.stringify(roles), roleBefore);
const receiverCatalog: ProductionCatalog = {
  ...catalog, coverage: [0, 1, 2], assets: [asset('repair-parent', 'CH', 'REFERENCE'), asset('repair-cross', 'PROP', 'DERIVE'), asset('repair-safe', 'LOC', 'REFERENCE'), asset('review-pending', 'PROP', 'REFERENCE')],
  repairItems: [{ id: 'scope-1', code: 'VARIANT_SCOPE', assetKey: 'repair-parent', variantKey: 'repair-version', episodes: [2], assetEpisodes: [0, 1], variantEpisodes: [2] }]
};
receiverCatalog.assets[0].usageEpisodes = [0, 1, 2]; // Receiver envelope; not newly verified on-screen presence.
receiverCatalog.assets[0].aliases = ['小原']; receiverCatalog.assets[0].role = '主角';
receiverCatalog.assets[0].variants = [
  { key: 'repair-version', name: '<b>待核伤态</b>', episodes: [2], note: '<img src=x onerror=alert(1)>原备注', preparation: { mode: 'DERIVE', fromKey: 'repair-parent' } },
  { key: 'safe-version', name: '独立完好形象', episodes: [1], note: '独立来源不受派生链影响', preparation: { mode: 'REFERENCE' } }
];
receiverCatalog.assets[1].preparation!.fromKey = 'repair-version';
receiverCatalog.assets[1].variants = [{ key: 'repair-transitive', name: '跨族再次派生', episodes: [2], note: '', preparation: { mode: 'DERIVE', fromKey: 'repair-cross' } }];
freeze(receiverCatalog);
const receiverBefore = JSON.stringify(receiverCatalog);
const receiverSelect = (extra = {}) => filterAssetCatalog(receiverCatalog, { query: '', episode: '', type: '', view: 'all', ...extra }, ['review-pending']);
const selectedKeys = (groups: ReturnType<typeof filterAssetCatalog>) => groups.flatMap(group => [...(group.baseVisible ? [group.asset.key] : []), ...group.variants.map(variant => variant.key)]);
const receiverHtml = renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog: receiverCatalog, pendingKeys: ['review-pending'], codes: { 'repair-safe': 'LOC-VERIFIED' } }));
const receiverQueueHtml = renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog: receiverCatalog, pendingKeys: ['review-pending'], initialView: 'queue' })).split('<table')[1];
const receiverFailures: string[] = [];
for (const [name, verify] of [
  ['程序待核及全部DERIVE依赖退出制图队列', () => {
    assert.deepEqual(selectedKeys(receiverSelect({ view: 'queue' })), ['safe-version', 'repair-safe']);
    assert.ok(receiverQueueHtml.includes('独立完好形象') && receiverQueueHtml.includes('repair-safe'));
    for (const text of ['待核伤态', 'repair-cross', '跨族再次派生', 'review-pending']) assert.ok(!receiverQueueHtml.includes(text));
  }],
  ['完整目录保全且既有筛选仍按自身范围', () => {
    assert.equal(selectedKeys(receiverSelect()).length, 7);
    assert.deepEqual(selectedKeys(receiverSelect({ view: 'pending' })), ['repair-parent', 'repair-version', 'repair-cross', 'repair-transitive', 'review-pending']);
    assert.deepEqual(selectedKeys(receiverSelect({ layer: 'variant', role: '主角', query: '小原', type: 'CH', episode: '2' })), ['repair-version']);
    assert.ok(receiverHtml.includes('7 条匹配记录') && receiverHtml.includes('LOC-VERIFIED'));
  }],
  ['程序待核与Q1待定分别标识且包络不是已核范围', () => {
    const parentBody = receiverHtml.split('<tbody aria-label="repair-parent">')[1].split('</tbody>')[0];
    const q1Body = receiverHtml.split('<tbody aria-label="review-pending">')[1].split('</tbody>')[0];
    assert.ok(parentBody.includes('待Q1核对') && parentBody.includes('暂存范围') && parentBody.includes('不代表已核入镜'));
    assert.ok(!parentBody.includes('Q1 待定') && q1Body.includes('Q1 待定'));
    assert.ok(receiverHtml.includes('派生来源待定'));
  }],
  ['无repair旧统计不变而有repair计入待定', () => {
    assert.deepEqual(summarizeAssetCatalog({ ...receiverCatalog, repairItems: undefined }), { bases: 4, variants: 3, REFERENCE: 4, DERIVE: 3, INLINE: 0, AUDIO: 0, UNRESOLVED: 0 });
    assert.deepEqual(summarizeAssetCatalog(receiverCatalog, ['review-pending']), { bases: 4, variants: 3, REFERENCE: 2, DERIVE: 0, INLINE: 0, AUDIO: 0, UNRESOLVED: 5 });
  }],
  ['只读安全转义且客户端不引入核心运行时', () => {
    assert.ok(receiverHtml.includes('&lt;b&gt;待核伤态&lt;/b&gt;') && receiverHtml.includes('&lt;img src=x onerror=alert(1)&gt;原备注'));
    assert.ok(!receiverHtml.includes('<img') && !receiverHtml.includes('name="contractId"') && !receiverHtml.includes('name="optionIndex"'));
    assert.equal(JSON.stringify(receiverCatalog), receiverBefore);
    const source = readFileSync(new URL('../app/projects/[projectId]/foundation-asset-catalog.tsx', import.meta.url), 'utf8');
    assert.match(source, /import type .*foundation-production-contracts/);
    assert.doesNotMatch(source, /import (?!type )[^\n]*foundation-production-contracts/);
  }]
] as const) { try { verify(); } catch { receiverFailures.push(name); } }
assert.deepEqual(receiverFailures, [], `接收待核缺口：${receiverFailures.join('、')}`);
const dependencyFailures: string[] = [];
for (const [name, mode, pendingKeys] of [
  ['自身未决来源', 'UNRESOLVED', []], ['外部待定来源', 'REFERENCE', ['seed']], ['历史未分类来源', undefined, []]
] as const) {
  try {
    const graph: ProductionCatalog = { ...catalog, assets: [asset('seed', 'CH', mode), asset('cross', 'PROP', 'DERIVE'), asset('independent', 'LOC', 'REFERENCE')] };
    graph.assets[0].variants = [
      { key: 'explicit-child', name: '显式派生', episodes: [1], note: '原说明保留', preparation: { mode: 'DERIVE', fromKey: 'seed' } },
      { key: 'implicit-child', name: '默认父形象派生', episodes: [1], note: '默认父来源', preparation: { mode: 'DERIVE' } },
      { key: 'independent-child', name: '独立子形象', episodes: [1], note: '独立参考不依赖父图', preparation: { mode: 'REFERENCE' } }
    ];
    graph.assets[1].preparation!.fromKey = 'implicit-child';
    graph.assets[1].variants = [{ key: 'transitive-child', name: '跨族继续派生', episodes: [1], note: '', preparation: { mode: 'DERIVE' } }];
    freeze(graph);
    const before = JSON.stringify(graph);
    const pending = [...pendingKeys];
    assert.deepEqual(selectedKeys(filterAssetCatalog(graph, { query: '', episode: '', type: '', view: 'queue' }, pending)), ['independent-child', 'independent'], name);
    assert.deepEqual(selectedKeys(filterAssetCatalog(graph, { query: '', episode: '', type: '', view: 'pending' }, pending)), ['seed', 'explicit-child', 'implicit-child', 'cross', 'transitive-child']);
    assert.deepEqual(summarizeAssetCatalog(graph, pending), { bases: 3, variants: 4, REFERENCE: 2, DERIVE: 0, INLINE: 0, AUDIO: 0, UNRESOLVED: 5 });
    const all = renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog: graph, pendingKeys: pending }));
    const queue = renderToStaticMarkup(createElement(FoundationAssetCatalog, { catalog: graph, pendingKeys: pending, initialView: 'queue' })).split('<table')[1];
    assert.ok(all.includes('7 条匹配记录') && all.includes('默认父来源') && all.includes('原说明保留'));
    const implicitRow = [...all.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].find(match => match[1].includes('默认父形象派生'))?.[1] ?? '';
    assert.ok(implicitRow.includes('登记派生来源：seed · 基线'), '省略fromKey的DERIVE显示约定的父来源');
    assert.ok(!queue.includes('显式派生') && !queue.includes('默认父形象派生') && !queue.includes('跨族继续派生'));
    assert.equal(JSON.stringify(graph), before);
  } catch (error) { dependencyFailures.push(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`); }
}
assert.deepEqual(dependencyFailures, [], `制作来源就绪传播缺口：${dependencyFailures.join('、')}`);
console.log('PASS asset catalog: real table SSR, receiver repair queue closure, original filtering/counts, escaped records and immutable input (not browser verification)');
