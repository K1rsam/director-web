import test from 'node:test';
import assert from 'node:assert/strict';
import { assetDeletionReady, assetEditPayload, assetScopeProblems, deletedAssetsFrom, initialAssetEdit, toggleAssetScope } from './assetManagement.ts';
import type { Asset, SourceRef } from './types.ts';
import type { AssetUsage } from './assetManagement.ts';

const sourceRefs: SourceRef[] = ['row-1', { start: 4, end: 12, sourceVersion: 3, speaker: '苏远' }];
const asset: Asset = { id: 'test-asset', name: '林夏', kind: 'CH', baseAssetId: 'permanent-base', variantId: 'permanent-variant', version: 7, prompt: '图片提示词', sourceRefs, adoptedMediaId: 'image-1', candidates: ['image-old'], applicability: { episodeIds: ['episode-1'], sceneIds: ['scene-1'] } };
const scenes = [{ id: 'scene-1', episodeId: 'episode-1', title: '校园' }, { id: 'scene-2', episodeId: 'episode-1', title: '家中' }, { id: 'scene-3', episodeId: 'episode-2', title: '操场' }];

test('编辑名称分类范围保留固定绑定身份、当前图、历史图和结构化原文引用', () => {
  const values = initialAssetEdit(asset);
  values.name = ' 苏远 · 觉醒装 '; values.kind = 'beast';
  const edited = assetEditPayload(asset, values, [], scenes);
  assert.equal(edited.name, '苏远 · 觉醒装'); assert.equal(edited.kind, 'beast');
  assert.equal(edited.id, asset.id); assert.equal(edited.baseAssetId, asset.baseAssetId); assert.equal(edited.variantId, asset.variantId);
  assert.equal(edited.expectedVersion, 7); assert.equal(edited.prompt, asset.prompt); assert.equal(edited.adoptedMediaId, 'image-1');
  assert.deepEqual(edited.candidates, ['image-old']); assert.deepEqual(edited.sourceRefs, sourceRefs);
  assert.deepEqual(edited.applicability, { episodes: ['episode-1'], scenes: ['scene-1'] });
  assert.equal(edited.needsReview, false); assert.equal(asset.name, '林夏');
});

test('修改来源绑定对应形象身份，清除来源时同步清除版本；失效旧来源不静默换绑', () => {
  const values = { ...initialAssetEdit(asset), sourceAssetId: 'parent' };
  assert.equal(assetEditPayload(asset, values, [{ id: 'parent', name: '基础形象', variantId: 'parent-v' }], scenes).sourceVariantId, 'parent-v');
  const missing: Asset = { ...asset, sourceAssetId: 'parent', sourceVariantId: 'old-parent-v' };
  assert.equal(assetEditPayload(missing, values, [], scenes).sourceVariantId, 'old-parent-v');
  const cleared = assetEditPayload(missing, { ...values, sourceAssetId: '' }, [], scenes);
  assert.equal(cleared.sourceAssetId, null); assert.equal(cleared.sourceVariantId, null);
});

test('删除操作必须绑定当前资产身份和版本；检查回来后版本漂移不能继续删', () => {
  const usage: AssetUsage = { assetId: asset.id, version: 7, name: asset.name, units: [], derivedAssets: [], activeJobs: [], submittedJobs: [], imageCount: 2 };
  assert.equal(assetDeletionReady(asset, null), false); assert.equal(assetDeletionReady(asset, usage), true);
  assert.equal(assetDeletionReady({ ...asset, version: 8 }, usage), false); assert.equal(assetDeletionReady(asset, { ...usage, assetId: 'other' }), false);
  assert.equal(assetDeletionReady(asset, { ...usage, deletedAt: '2026-10-04' }), false);
});

test('删除列表只显示真实删除标记；选择集场去重而不修改原数组', () => {
  assert.deepEqual(deletedAssetsFrom([{ ...asset, deletedAt: '2026-10-04' }, asset, null, { id: 'invalid', deletedAt: 'date' }]).map(item => item.id), [asset.id]);
  const ids = ['episode-1']; assert.deepEqual(toggleAssetScope(ids, 'episode-1', true), ['episode-1']);
  assert.deepEqual(toggleAssetScope(ids, 'episode-2', true), ['episode-1', 'episode-2']); assert.deepEqual(ids, ['episode-1']);
  assert.deepEqual(toggleAssetScope(ids, 'episode-1', false), []);
});

test('编辑原 UNRESOLVED 形象可明确 GLOBAL，程序提供理由，无原文测试资产也可确认', () => {
  const unresolved = { ...asset, scope: { kind: 'UNRESOLVED', scenes: [], reason: null } };
  const saved = assetEditPayload(unresolved, { ...initialAssetEdit(unresolved), episodeIds: [], sceneIds: [] }, []);
  assert.deepEqual(saved.scope, { kind: 'GLOBAL', scenes: [], reason: '用户在资产编辑中确认该形象全剧通用。' });
  assert.deepEqual(saved.applicability, { episodes: [], scenes: [] }); assert.equal(saved.needsReview, false); assert.deepEqual(saved.sourceRefs, sourceRefs);
});

test('只选集数展开所属全部场景，变更 SCENES 不沿用旧范围', () => {
  const saved = assetEditPayload({ ...asset, scope: { kind: 'SCENES', scenes: [{ episodeId: 'episode-2', sceneId: 'scene-3' }] } }, { ...initialAssetEdit(asset), sceneIds: [] }, [], scenes);
  assert.deepEqual(saved.scope, { kind: 'SCENES', scenes: [{ episodeId: 'episode-1', sceneId: 'scene-1' }, { episodeId: 'episode-1', sceneId: 'scene-2' }], reason: '用户在资产编辑中确认该形象适用于所选集场。' });
  assert.deepEqual(saved.applicability, { episodes: ['episode-1'], scenes: ['scene-1', 'scene-2'] });
});

test('场景必须属于所选集，未知场景和未识别场景集不能标记已核对', () => {
  const values = initialAssetEdit(asset);
  assert.deepEqual(assetScopeProblems(values, scenes), []);
  assert.throws(() => assetEditPayload(asset, { ...values, sceneIds: ['scene-3'] }, [], scenes), /不属于当前集数/);
  assert.throws(() => assetEditPayload(asset, { ...values, sceneIds: ['missing'] }, [], scenes), /引用已失效/);
  assert.throws(() => assetEditPayload(asset, { ...values, episodeIds: ['missing-episode'], sceneIds: [] }, [], scenes), /尚未识别场景/);
});

test('只有 SCENES 存储范围的导入资产仍显示原集场，打开编辑不误变全剧通用', () => {
  const values = initialAssetEdit({ ...asset, applicability: { episodes: [], scenes: [] }, scope: { kind: 'SCENES', scenes: [{ episodeId: 'episode-2', sceneId: 'scene-3' }] } });
  assert.deepEqual(values.episodeIds, ['episode-2']); assert.deepEqual(values.sceneIds, ['scene-3']);
  const saved = assetEditPayload(asset, values, [], scenes); assert.equal((saved.scope as { kind: string }).kind, 'SCENES');
});
