import assert from 'node:assert/strict';
import { buildSourceIndex, hashFoundationPrompt, loadFoundationSystemPrompt } from '../lib/project-foundation-contracts';
import { createEmptyDocument, applyDocumentEdit } from '../lib/foundation-document';
import { applyProductionOptimizations, mergeProductionCatalogs, projectProductionCatalog, requireProductionCatalogAuthor, requireProductionOptimization } from '../lib/foundation-production-contracts';
import { LIGHT_ASSET_METHOD, LIGHT_ASSET_METHOD_VERSION, LIGHT_F2_TRANSPORT_SCHEMA, buildLightFoundationPrompt } from '../lib/foundation-production-prompts';

const index = buildSourceIndex([{ number: 1, title: null, content: '第一集。' }]);
const catalog = requireProductionCatalogAuthor({
  format: 'ASSET_CATALOG_V2', coverage: [1], assets: [{ name: '主角', type: 'CH', episodes: [1], sceneRefs: [{ episode: 1, sceneKey: '1-1' }], preparation: { mode: 'REFERENCE' } }]
}, index, [1]);
const edit = requireProductionOptimization({
  format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {
    assets: [{ key: catalog.assets[0].key, name: '主角', type: 'CH', episodes: [1], preparation: { mode: 'REFERENCE' } }],
    scenes: [{ episode: 1, sceneKey: '1-1', location: '大厅', characters: ['主角'] }]
  }
}, index, [1]);

const result = applyProductionOptimizations(null, catalog, [edit], index);
const patchByKey = requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: { assets: [{ key: catalog.assets[0].key, episodes: [1], sceneRefs: [{ episode: 1, sceneKey: '1-1' }] }] } }, index, [1], catalog.assets);
assert.equal(patchByKey.changes.assets![0].name, catalog.assets[0].name, '明确已有key的增量继承名称，不要求模型复抄');
assert.equal(patchByKey.changes.assets![0].type, catalog.assets[0].type);
assert.throws(() => requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: { assets: [{ key: 'unknown', episodes: [1] }] } }, index, [1], catalog.assets));
assert.equal(result.f1, null, '轻量目录编辑不得伪造 F1');
assert.equal(result.f2.assets[0].key, catalog.assets[0].key, '既有稳定资产身份应保留');
assert.deepEqual(result.f2.assets[0].sceneRefs, [{ episode: 1, sceneKey: '1-1' }], '省略新定位不得抹去已有场景引用');
assert.throws(() => requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [1], assets: [{ name: '越界', type: 'CH', episodes: [1], sceneRefs: [{ episode: 2, sceneKey: 'bad' }], preparation: { mode: 'REFERENCE' } }] }, index, [1]));

const wider = buildSourceIndex([1, 2].map(number => ({ number, title: null, content: `第${number}集。` })));
const first = requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [1], assets: [{ name: '甲', type: 'CH', episodes: [1], sceneRefs: [{ episode: 1, sceneKey: '1-a' }], preparation: { mode: 'REFERENCE' } }] }, wider, [1]);
const second = requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [2], assets: [{ key: first.assets[0].key, name: '甲', type: 'CH', episodes: [2], sceneRefs: [{ episode: 2, sceneKey: '2-a' }], preparation: { mode: 'REFERENCE' } }] }, wider, [2], first.assets);
const merged = mergeProductionCatalogs([first, second], wider, [1, 2]);
const reduced = requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1, 2], changes: { assets: [{ key: first.assets[0].key, name: '甲', type: 'CH', episodes: [1] }] } }, wider, [1, 2]);
assert.deepEqual(applyProductionOptimizations(null, merged, [reduced], wider).f2.assets[0].sceneRefs, [{ episode: 1, sceneKey: '1-a' }], '继承引用必须随实际用途收窄');
assert.deepEqual(projectProductionCatalog(merged, [1]).assets[0].sceneRefs, [{ episode: 1, sceneKey: '1-a' }], '投影只发送本批场景引用');
const scopeOne = requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: { assets: [{ key: first.assets[0].key, name: '甲', type: 'CH', episodes: [1], preparation: { mode: 'REFERENCE' } }] } }, wider, [1]);
assert.deepEqual(applyProductionOptimizations(null, merged, [scopeOne], wider).f2.assets[0].sceneRefs, [{ episode: 1, sceneKey: '1-a' }, { episode: 2, sceneKey: '2-a' }], '本批编辑保留不在范围内的定位');
const localVoice = requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [2], changes: { assets: [{ key: first.assets[0].key, preparation: { mode: 'AUDIO', note: '本集只有画外音' } }] } }, wider, [2], merged.assets);
const protectedVisual = applyProductionOptimizations(null, merged, [localVoice], wider).f2.assets[0];
assert.equal(protectedVisual.preparation?.mode, 'REFERENCE', '本批声音出现不能撤销其它集可视基线');
assert.deepEqual(protectedVisual.usageEpisodes, [1, 2]);
const wholeVoice = requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1, 2], changes: { assets: [{ key: first.assets[0].key, preparation: { mode: 'AUDIO', note: '已在完整适用范围核对，仅声音' } }] } }, wider, [1, 2], merged.assets);
assert.equal(applyProductionOptimizations(null, merged, [wholeVoice], wider).f2.assets[0].preparation?.mode, 'AUDIO', '完整范围的明确修正仍可采用');
assert.throws(() => applyProductionOptimizations(null, catalog, [requireProductionOptimization({
  format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: { episodes: [{ number: 1, summary: '不得生成摘要' }] }
}, index, [1])], index), /F1/);
assert.throws(() => requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: { scenes: [{ episode: 2, sceneKey: '越界' }] } }, index, [1]));

const input = { sourceVersion: index.version, sourceIndex: index, sourceContext: { version: 'test', background: [] }, projectConditions: { style: '3D', aspectRatio: '16:9' } } as any;
const document = createEmptyDocument(input);
document.workflow = 'LIGHT_STAGE1_V1'; document.assetMethodVersion = LIGHT_ASSET_METHOD_VERSION; document.f2 = catalog;
const patched = applyDocumentEdit(document, edit, index);
assert.equal(patched.f1, null, 'Q1 轻量编辑不补造导航');
assert.deepEqual(patched.scenePatches, [{ episode: 1, sceneKey: '1-1', location: '大厅', characters: ['主角'] }]);
const scalar = requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: { scenes: [{ episode: 1, sceneKey: '1-1', weather: '雨' }] } }, index, [1]);
assert.deepEqual(applyDocumentEdit(patched, scalar, index).scenePatches, [{ episode: 1, sceneKey: '1-1', location: '大厅', characters: ['主角'], weather: '雨' }], '省略的场景标量不得清除旧值');

const prompt = buildLightFoundationPrompt('F2', { scope: [1] });
const q1Prompt = buildLightFoundationPrompt('Q1', { scope: [1], pendingChoices: [], programTasks: [], editorialSuggestions: [], confirmedDecisions: [], candidates: { f2: { repairItems: [] } } });
assert.ok(LIGHT_ASSET_METHOD_VERSION.length >= 8);
assert.match(prompt, /这是自包含资料任务/);
assert.doesNotMatch(prompt, /持续可见实体/, '资产方法只在F2岗位规则，不在task重复');
const receiptFields = ['resolvedSuggestions', 'appliedDecisions', 'resolvedUnresolved', 'resolvedCatalogIssues'] as const;
const outputSchema = (prompt: string) => JSON.parse(prompt.match(/OUTPUT_SCHEMA[^\n]*\n([^\n]+)/)![1]);
for (const receipt of receiptFields) assert.doesNotMatch(q1Prompt, new RegExp(receipt), '空待办不发送无用回执协议');
assert.ok(outputSchema(q1Prompt).humanChoices.length, '无既存待办仍可提出新人工选择');
assert.ok(outputSchema(q1Prompt).unresolved.length, '无既存待办仍可提出有范围的新未决');
const source = { version: 'exact', episodes: [{ number: 1, lineCount: 1, lines: [[1, '  甲（VO）：原文\r\n😀  ']] }] };
const receiptCases = [
  ['resolvedUnresolved', { pendingChoices: [{ id: 'todo-1', episodes: [1], note: '已存在未决' }] }],
  ['resolvedUnresolved', { programTasks: [{ id: 'program-1', owner: 'PROGRAM', episodes: [1], note: '有据拆场' }] }],
  ['resolvedSuggestions', { editorialSuggestions: [{ id: 'suggestion-1', applicationScope: { kind: 'EPISODES', episodes: [1] } }] }],
  ['appliedDecisions', { confirmedDecisions: [{ id: 'decision-1', applicationScope: { kind: 'SCENES', scenes: [{ episode: 1, sceneKey: '1-1' }] }, changeTargets: { assetKeys: [], assetFields: [], sceneFields: ['weather'] } }] }],
  ['resolvedCatalogIssues', { candidates: { f2: { repairItems: [{ id: 'catalog-1', assetKey: 'a', episodes: [1] }] } } }]
] as const;
for (const [field, supplied] of receiptCases) {
  const request = { scope: [1], source, ...supplied, delivery: { mode: 'REPAIR', targets: { episodes: [1], keys: ['a'] } } };
  const before = JSON.stringify(request), prompt = buildLightFoundationPrompt('Q1', request), schema = outputSchema(prompt);
  assert.deepEqual(receiptFields.filter(key => key in schema), [field], '只提供实际已有事项对应的回执schema');
  const wire = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
  assert.deepEqual(wire, request, '准确id、权限、范围、原文及输入结构不因裁协议而变化');
  assert.equal(JSON.stringify(request), before, '不修改调用方输入');
  assert.match(prompt, /scope.*delivery\.targets.*applicationScope\/changeTargets/);
  assert.ok(schema.humanChoices[0].changeTargets && schema.humanChoices[0].applicationScope && schema.unresolved[0].applicationScope);
  if ('programTasks' in supplied) assert.match(JSON.stringify(schema.resolvedUnresolved), /programTasks/);
}
const allReceipts = buildLightFoundationPrompt('Q1', Object.assign({ scope: [1], source }, ...receiptCases.map(([, supplied]) => supplied)));
assert.deepEqual(receiptFields.filter(key => key in outputSchema(allReceipts)), receiptFields, '混合待办保留全部实际需要的回执通道');
assert.match(LIGHT_ASSET_METHOD, /持续可见且需要引用的实体/);
assert.match(LIGHT_ASSET_METHOD, /有真实人形、有名字或有稳定戏份的个体/);
assert.match(LIGHT_ASSET_METHOD, /只有需要锁定稳定身份、新外观或持续连续性才独立备图/);
assert.match(LIGHT_ASSET_METHOD, /情绪\/临时反应/);
assert.match(LIGHT_ASSET_METHOD, /状态解除不建“恢复”资产/);
assert.match(LIGHT_ASSET_METHOD, /不要登记情绪\/临时反应、短暂特效、背景陈设或仅台词提及物/);
assert.equal(LIGHT_ASSET_METHOD_VERSION, `LIGHT_P2_3000_${hashFoundationPrompt(JSON.stringify({ method: loadFoundationSystemPrompt('F2'), transport: LIGHT_F2_TRANSPORT_SCHEMA })).slice(0, 12)}`, '版本只随实际F2岗位规则和F2运输协议变化，Q1不参与');
console.log('PASS light foundation contracts');
