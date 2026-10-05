import assert from 'node:assert/strict';
import test from 'node:test';
import { replaceUnitAsset, unitAssetEditingProblems } from './unitAssetEditing.ts';
import type { AssetRef, Unit, Workspace } from './types.ts';
const old: AssetRef = { assetId: 'same-name-one', variantId: 'base', role: '人物', order: 1, mediaId: 'old-image' };
const next: AssetRef = { ...old, assetId: 'same-name-two', variantId: 'injury', mediaId: undefined };
const unit: Unit = { id: 'unit', version: 4, episodeId: 'ep-1', sceneId: 'scene-1', prompt: '林夏看向门口 {{asset:same-name-one:base}}', assetRefs: [old] };
const workspace = { assets: [{ id: 'same-name-two', name: '林夏', variantId: 'injury', adoptedMediaId: 'new-image', applicability: { episodes: ['ep-1'], scenes: ['scene-1'] } }], units: [unit] } as Workspace;
test('Changing one identity updates the exact placeholder, not matching names or unrelated markers', () => {
  const text = unit.prompt + ' {{asset:another-person:base}}';
  const changed = replaceUnitAsset(text, [old], 0, next);
  assert.equal(changed.prompt, '林夏看向门口 {{asset:same-name-two:injury}} {{asset:another-person:base}}');
  assert.equal(unit.prompt, '林夏看向门口 {{asset:same-name-one:base}}');
  assert.equal(unit.assetRefs?.[0].assetId, old.assetId);
});
test('A duplicated identity retained by another reference is not globally replaced', () => {
  assert.equal(replaceUnitAsset(unit.prompt, [old, { ...old, order: 2 }], 0, next).prompt, unit.prompt);
});
test('Deleted identity can be replaced precisely and current pictures resolve automatically', () => {
  assert.match(unitAssetEditingProblems(workspace, unit, [old], unit.prompt).join(), /已删除/);
  const changed = replaceUnitAsset(unit.prompt, [old], 0, next);
  assert.deepEqual(unitAssetEditingProblems(workspace, unit, changed.references, changed.prompt), []);
});
test('Removing a reference requires fixing its remaining placeholder and out-of-range channel marker', () => {
  assert.match(unitAssetEditingProblems(workspace, unit, [], unit.prompt + ' @图片1').join(), /已移除素材/);
  assert.match(unitAssetEditingProblems(workspace, unit, [], unit.prompt + ' @图片1').join(), /编号/);
});
test('Wrong appearance, wrong scope and historical media cannot silently prepare', () => {
  assert.match(unitAssetEditingProblems(workspace, unit, [{ ...next, variantId: 'base' }], '').join(), /形象已变化/);
  assert.match(unitAssetEditingProblems(workspace, { ...unit, episodeId: 'ep-2' }, [next], '文字').join(), /不适用/);
  assert.match(unitAssetEditingProblems(workspace, unit, [{ ...next, mediaId: 'old-image' }], '文字').join(), /旧图片/);
});
