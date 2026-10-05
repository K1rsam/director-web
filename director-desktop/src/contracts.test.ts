import test from 'node:test';
import assert from 'node:assert/strict';
import { assetImages, assetImageSelection, frozenReference, generationChoices, imageBatchEstimate, mediaMatchesAsset, moveItem, normalizeWorkspace, packageEstimate, packageReady, ratioLabel, referenceTimingProblems, resolutionLabel, storyboardRange, unitResultIds, videoAdoptionProblems, videoContainerVerified, workflowResult } from './contracts.ts';
import type { Workspace } from './types.ts';

function fixture(): Workspace { return { project: { id: 'p', title: '项目' }, assets: [{ id: 'a', name: '形象', variantId: 'v', adoptedMediaId: 'image', candidates: ['shared'] }], media: [{ id: 'image', kind: 'image', path: 'a.png', assetId: 'a', variantId: 'v' }, { id: 'shared', kind: 'image', path: 'b.png', assetId: 'other', variantId: 'other' }, { id: 'old-video', kind: 'video', path: 'old.mp4' }], units: [{ id: 'u', prompt: '完整提示词', duration: 12, version: 2, assetRefs: [{ assetId: 'a', variantId: 'v', use: 'scene', role: '', order: 1 }], preparedPackage: { provider: 'bh', model: 'm', unitVersion: 2, ratio: '16:9', resolution: '720p', duration: 12, prompt: '完整提示词', estimatedCost: 0, references: [{ assetId: 'a', variantId: 'v', role: 'scene', order: 0, mediaId: 'image' }] }, resultMediaIds: ['new-video'], adoptedMediaId: 'old-video' }], jobs: [{ id: 'j', kind: 'video', entityId: 'u', provider: 'bh', status: 'downloaded', snapshot: { model: 'm', unitVersion: 2 }, prepared: { estimatedCost: 0.25 }, result: { mediaIds: ['new-video'], actualCost: 0.2 } }, { id: 'design', kind: 'workflow', entityId: 'images.design:', provider: 'local', status: 'completed', result: { blocked: [{ reason: '来源缺失' }], imagePlan: [{ status: 'awaitingTrial' }] } }], settings: {}, providers: [], rules: [] }; }

test('Rust任务摘要投影保留云端结果、身份与费用', () => { const workspace = normalizeWorkspace(fixture()); const job = workspace.jobs[0]; assert.equal(job.unitId, 'u'); assert.equal(job.model, 'm'); assert.deepEqual(job.resultMediaIds, ['new-video']); assert.equal(job.estimate, 0.25); assert.equal(job.actualCost, 0.2); assert.equal(workspace.units[0].assetRefs?.[0].role, 'scene'); assert.equal(workspace.media[0].adopted, true); });
test('准备包精确匹配渠道模型、版本、比例尺寸、时长与编译提示词，并保留零费用', () => { const unit = fixture().units[0]; assert.equal(packageEstimate(unit), 0); assert.equal(packageReady(unit, 'bh', 'm'), true); assert.equal(packageReady(unit, 'dreamina', 'm'), false); assert.equal(packageReady(unit, 'bh', 'wrong'), false); assert.equal(packageReady({ ...unit, version: 3 }, 'bh', 'm'), false); assert.equal(packageReady({ ...unit, problems: ['缺图'] }, 'bh', 'm'), false); assert.equal(packageReady(unit, 'bh', 'm', { ratio: '16:9', resolution: '720p' }), true); assert.equal(packageReady(unit, 'bh', 'm', { ratio: '9:16', resolution: '720p' }), false); assert.equal(packageReady(unit, 'bh', 'm', { ratio: '16:9', resolution: '1080p' }), false); assert.equal(packageReady({ ...unit, duration: 15 }, 'bh', 'm'), false); assert.equal(packageReady({ ...unit, prompt: '已经修改' }, 'bh', 'm'), false); assert.equal(packageReady({ ...unit, preparedPackage: { ...unit.preparedPackage!, prompt: undefined } }, 'bh', 'm'), false); assert.equal(packageReady({ ...unit, prompt: '使用{{asset:a:v}}', preparedPackage: { ...unit.preparedPackage!, prompt: '使用@图片1' } }, 'bh', 'm'), true); });
test('冻结配图不依赖UI一基序号，视频保留旧采用与新候选', () => { const workspace = normalizeWorkspace(fixture()), unit = workspace.units[0]; assert.equal(frozenReference(unit.preparedPackage, unit.assetRefs![0]), 'image'); assert.deepEqual(unitResultIds(workspace, unit).sort(), ['new-video', 'old-video']); });
test('共用图片、设计阻塞与计划可读取，未知参考时长必须阻止提交', () => { const workspace = fixture(); assert.equal(mediaMatchesAsset(workspace.assets[0], workspace.media[1]), true); assert.equal(workflowResult(workspace, 'images.design')?.blocked instanceof Array, true); const unit = { ...workspace.units[0], mediaRefs: [{ mediaId: 'sound', role: 'reference' }] }; assert.equal(referenceTimingProblems(workspace, unit).length, 1); workspace.media.push({ id: 'sound', kind: 'audio', path: 'sound.wav', durationSeconds: 8, metadataVerified: false }); assert.equal(referenceTimingProblems(workspace, unit).length, 1); workspace.media.at(-1)!.metadataVerified = true; assert.equal(referenceTimingProblems(workspace, unit).length, 0); workspace.media.at(-1)!.durationSeconds = 0; assert.equal(referenceTimingProblems(workspace, unit).length, 1); });

test('引用重排改变提交顺序并保留完整身份字段', () => { const refs = [{ mediaId: 'a', role: 'character' }, { mediaId: 'b', role: 'sound' }, { mediaId: 'c', role: 'video' }]; const moved = moveItem(refs, 2, 0); assert.deepEqual(moved.map(item => item.mediaId), ['c', 'a', 'b']); assert.equal(moved[0].role, 'video'); assert.deepEqual(refs.map(item => item.mediaId), ['a', 'b', 'c']); assert.equal(moveItem(refs, -1, 0), refs); });

test('图片计划使用最新相关任务而不会被旧设计结果遮蔽', () => { const workspace = fixture(); workspace.jobs.unshift({ id: 'produce', kind: 'workflow', entityId: 'images.produce:', provider: 'local', status: 'completed', result: { imagePlan: [{ status: 'ready' }] } }); assert.deepEqual(workflowResult(workspace, ['images.design', 'images.produce'])?.imagePlan, [{ status: 'ready' }]); });

test('图片只采用已适配单图报价，未知计价与缺图依赖不会伪造总费用', () => {
  const workspace = fixture(); workspace.assets.push({ id: 'parent', name: '基础形象', variantId: 'base', prompt: '基础设计' }); workspace.assets[0].sourceAssetId = 'parent';
  const model = { id: 'image-m', kind: 'image', adapted: true, price: 0.25, billing: 'per_image', currency: 'CNY' };
  const estimate = imageBatchEstimate(workspace, ['a', 'a'], 'bh', model);
  assert.equal(estimate.items.length, 1); assert.equal(estimate.items[0].count, 1); assert.equal(estimate.items[0].amount, 0.25); assert.equal(estimate.selectedTotal, 0.25); assert.deepEqual(estimate.dependencies.map(item => item.assetId), ['parent']);
  for (const provider of ['chrome', 'dreamina']) assert.equal(imageBatchEstimate(workspace, ['a'], provider, model).selectedTotal, undefined);
  for (const invalid of [{ ...model, kind: 'video' }, { ...model, adapted: false }, { ...model, billing: 'per_second' }, { ...model, currency: undefined }, { ...model, price: NaN }, { ...model, price: -1 }]) assert.equal(imageBatchEstimate(workspace, ['a'], 'bh', invalid).selectedTotal, undefined);
  assert.equal(imageBatchEstimate(workspace, ['a'], 'bh', { ...model, price: 0, billing: 'per_call' }).selectedTotal, 0);
  workspace.assets.at(-1)!.adoptedMediaId = 'parent-image'; assert.equal(imageBatchEstimate(workspace, ['a'], 'bh', model).dependencies.length, 0);
  workspace.assets[0].sourceAssetId = 'missing'; assert.equal(imageBatchEstimate(workspace, ['a'], 'bh', model).unresolved, true);
});

test('视频采用要求可信运动视频容器与当前生成版本，历史成品仍可预览', () => {
  const workspace = normalizeWorkspace(fixture()), unit = workspace.units[0];
  const media = { id: 'new-video', kind: 'video', path: 'new.mp4', metadataVerified: true, streams: [{ kind: 'video', attachedPicture: false }] };
  assert.equal(videoContainerVerified(media), true); assert.deepEqual(videoAdoptionProblems(workspace, unit, media), []);
  assert.equal(videoContainerVerified({ ...media, metadataVerified: false }), false); assert.equal(videoContainerVerified({ ...media, streams: [{ kind: 'video', attachedPicture: true }] }), false); assert.equal(videoContainerVerified({ ...media, streams: [{ kind: 'audio' }] }), false);
  assert.equal(videoAdoptionProblems(workspace, { ...unit, version: 3 }, media).length, 1); assert.equal(videoAdoptionProblems(workspace, { ...unit, version: undefined }, media).length, 1);
  unit.adoptedVideoVersion = 1; assert.equal(unit.adoptedVideoVersion === unit.version, false); assert.equal(unitResultIds(workspace, unit).includes('old-video'), true);
});

test('模型、比例与尺寸只来自对应类型能力，非法旧值不会自动替换或提交', () => {
  const workspace = fixture(); workspace.providers = [{ id: 'dreamina', models: ['unverified', { id: '5.0', kind: 'image', adapted: true, ratios: ['1:1', '9:16', '16:9'], resolutions: ['2k', '4k', '1080p'] }, { id: '2.0', kind: 'video', adapted: true, ratios: ['16:9', '9:16'], resolutions: ['720p', '1080p'] }, { id: 'new', kind: 'image', adapted: false, ratios: ['1:1'], resolutions: ['2k'] }] }];
  const image = generationChoices(workspace, 'dreamina', 'image', { model: '5.0', ratio: '16:9', resolution: '1080p' }); assert.equal(image.valid, true); assert.deepEqual(image.ratios, ['16:9', '9:16', '1:1']); assert.deepEqual(image.resolutions, ['2k', '4k', '1080p']); assert.equal(image.models.some(model => model.id === '2.0'), false);
  for (const invalid of [{ model: '5.0', ratio: '21:9', resolution: '2k' }, { model: '5.0', ratio: '16:9', resolution: '2K' }, { model: 'new', ratio: '1:1', resolution: '2k' }, { model: 'unverified', ratio: '16:9', resolution: '2k' }]) assert.equal(generationChoices(workspace, 'dreamina', 'image', invalid).valid, false);
  assert.equal(generationChoices(workspace, 'dreamina', 'video', { model: '2.0', ratio: '9:16', resolution: '1080p' }).valid, true); assert.equal(generationChoices(workspace, 'dreamina', 'video', { model: '2.0', ratio: '9:16', resolution: '4k' }).valid, false);
  assert.equal(resolutionLabel('1080p', 'image'), '1080P（像素尺寸）'); assert.equal(resolutionLabel('4k', 'image'), '4K'); assert.equal(ratioLabel('9:16'), '9:16 · 竖屏');
});

test('分镜文字创作从当前锁定原文选择制作集，零单元和未配置视频模型也可启动', () => {
  const workspace = fixture(); workspace.units = []; workspace.source = { episodes: [{ id: 'ep-2', number: 2, title: '第二集' }, { id: 'ep-1', number: 1 }, { id: 'ep-2', title: '重复' }, { title: '未确认' }] };
  assert.equal(storyboardRange(workspace).valid, true);
  assert.deepEqual(storyboardRange(workspace).episodeIds, ['ep-2', 'ep-1']);
  assert.deepEqual(storyboardRange(workspace, 'ep-1').episodeIds, ['ep-1']);
  assert.equal(storyboardRange(workspace, 'old-episode').valid, false);
  workspace.source = { episodes: [] }; workspace.units = [{ id: 'old-unit', episodeId: 'old-episode', prompt: '旧分镜' }];
  assert.equal(storyboardRange(workspace).valid, false);
  assert.deepEqual(storyboardRange(workspace).episodeIds, []);
  workspace.source = null;
  assert.equal(storyboardRange(workspace).valid, false);
});

test('视频尺寸随核实的型号改变，VIP多尺寸与普通固定尺寸不会串用', () => {
  const workspace = fixture(); workspace.providers = [{ id: 'dreamina', models: [
    { id: 'seedance2.5', kind: 'video', adapted: true, ratios: ['16:9', '9:16'], resolutions: ['480p', '720p', '1080p'] },
    { id: 'seedance2.0_vip', kind: 'video', adapted: true, ratios: ['16:9', '9:16'], resolutions: ['720p', '1080p', '4k'] },
    { id: 'seedance2.0', kind: 'video', adapted: true, ratios: ['16:9', '9:16'], resolutions: ['720p'] }
  ] }];
  const choice = (model: string, resolution = '720p') => generationChoices(workspace, 'dreamina', 'video', { model, ratio: '16:9', resolution });
  assert.deepEqual(choice('seedance2.0_vip').resolutions, ['720p', '1080p', '4k']);
  assert.deepEqual(choice('seedance2.0').resolutions, ['720p']);
  assert.equal(choice('seedance2.0', '4k').valid, false);
  assert.equal(choice('seedance2.0_vip', '4k').valid, true);
});

test('图片当前与历史使用精确形象关联，历史从新到旧且排除当前图', () => {
  const workspace = fixture(), asset = workspace.assets[0];
  workspace.media = [
    { id: 'old', kind: 'image', path: 'old.png', assetId: 'a', variantId: 'v', createdAt: '2026-10-01T00:00:00Z' },
    { id: 'current', kind: 'image', path: 'current.png', assetId: 'a', variantId: 'v', createdAt: '2026-10-02T00:00:00Z' },
    { id: 'latest', kind: 'image', path: 'latest.png', assetId: 'a', variantId: 'v', createdAt: '2026-10-03T00:00:00Z' },
    { id: 'other-variant', kind: 'image', path: 'other.png', assetId: 'a', variantId: 'other', adopted: true },
    { id: 'other-asset', kind: 'image', path: 'other-asset.png', assetId: 'other', variantId: 'v', adopted: true },
    { id: 'video', kind: 'video', path: 'video.mp4', assetId: 'a', variantId: 'v' },
  ];
  asset.adoptedMediaId = 'current'; asset.candidates = [];
  const images = assetImages(workspace, asset);
  assert.equal(images.current?.id, 'current');
  assert.deepEqual(images.history.map(media => media.id), ['latest', 'old']);
  assert.deepEqual(assetImageSelection(workspace, asset, 'old'), { assetId: 'a', variantId: 'v', mediaId: 'old' });
  assert.throws(() => assetImageSelection(workspace, asset, 'other-variant'), /不属于当前资产形象/);
  assert.throws(() => assetImageSelection(workspace, asset, 'other-asset'), /不属于当前资产形象/);
  const switched = assetImages(workspace, { ...asset, adoptedMediaId: 'old' });
  assert.equal(switched.current?.id, 'old');
  assert.deepEqual(switched.history.map(media => media.id), ['latest', 'current']);
  assert.equal(assetImages(workspace, { ...asset, adoptedMediaId: 'other-asset' }).current, undefined);
  assert.equal(assetImages(workspace, { ...asset, adoptedMediaId: undefined }).current, undefined);
});

test('共用原图只通过当前形象明确关联显示，全局采用标记不推断当前图', () => {
  const workspace = fixture(), asset = workspace.assets[0];
  asset.adoptedMediaId = 'shared';
  assert.equal(assetImages(workspace, asset).current?.id, 'shared');
  asset.candidates = [];
  assert.equal(assetImages(workspace, asset).current, undefined);
  asset.candidates = [{ ...workspace.media[1], assetId: 'a', variantId: 'different' }];
  assert.equal(assetImages(workspace, asset).current, undefined);
  asset.candidates = ['shared', 'old-video'];
  assert.equal(assetImages(workspace, asset).images.some(media => media.kind === 'video'), false);
  const empty = assetImages({ ...workspace, media: [] }, asset);
  assert.equal(empty.current, undefined);
  assert.deepEqual(empty.history, []);
});
