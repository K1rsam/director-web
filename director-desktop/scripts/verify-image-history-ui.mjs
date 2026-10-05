import assert from 'node:assert/strict';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

// Render the actual UI against isolated fixtures. Do not connect to a desktop core.
globalThis.location = { search: '?preview=1' };
let networkRequests = 0, mutations = 0;
globalThis.fetch = async () => { networkRequests++; throw new Error('Network access is forbidden in this verification.'); };
const image = (id, assetId = 'asset-1', variantId = 'variant-1', createdAt = '2026-10-04T00:00:00Z', extra = {}) => ({ id, assetId, variantId, createdAt, kind: 'image', path: `${id}.png`, name: `fixture-${id}`, previewUrl: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="lightblue"/></svg>')}`, ...extra });
const base = {
  project: { id: 'fixture-project', title: '图片历史验证' },
  assets: [{ id: 'asset-1', variantId: 'variant-1', name: '测试形象', prompt: '完整图片提示词。', version: 1, adoptedMediaId: 'current', candidates: ['old', 'current', 'recent'] }],
  media: [
    image('old', undefined, undefined, '2026-10-01T00:00:00Z'),
    image('current', undefined, undefined, '2026-10-02T00:00:00Z'),
    image('recent', undefined, undefined, '2026-10-03T00:00:00Z'),
    image('other-asset', 'asset-2', 'variant-1', undefined, { adopted: true }),
    image('other-variant', 'asset-1', 'variant-2', undefined, { adopted: true }),
    { ...image('not-an-image'), kind: 'video' },
  ],
  units: [], jobs: [], rules: [],
  settings: { imageProvider: 'dreamina', imageModel: '5.0', imageResolution: '2k', ratio: '16:9', trialApproved: false },
  dreaminaAccount: { status: 'authenticated', ready: true, identityVerified: true, accountKey: 'fixture-account' },
  providers: [{ id: 'dreamina', models: [{ id: '5.0', name: '5.0', kind: 'image', adapted: true, available: true, ratios: ['16:9', '9:16', '1:1'], resolutions: ['2k', '4k', '1080p'] }] }],
};
const props = { writable: true, mutate: async () => { mutations++; throw new Error('Mutation is forbidden in this verification.'); }, inspect() {}, onNotice() {}, onError() {}, onTasks() {} };
const cases = [];
const test = (name, callback) => { try { callback(); cases.push({ name, passed: true }); } catch (error) { cases.push({ name, passed: false, error: error.message }); } };
function button(html, title) { const match = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find(item => item[0].replace(/<[^>]+>/g, '').trim() === title); assert.ok(match, `Missing button: ${title}`); return match[0]; }
function disabled(html, title, expected) { const element = button(html, title); assert.equal(element.includes('disabled=""'), expected, `${title}: ${element.replace(/<[^>]+>/g, '')}`); }
function history(html) { const match = html.match(/<section class="image-history" aria-label="图片历史">([\s\S]*?)<\/section>/); assert.ok(match, 'Missing image history section'); return match[1]; }
function current(html) { const match = html.match(/<div class="selected-asset-image current-asset-image">([\s\S]*?)<\/div>/); assert.ok(match, 'Missing current image preview'); return match[1]; }
const empty = { ...base, assets: [{ ...base.assets[0], adoptedMediaId: undefined, candidates: [] }], media: [] };
const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { AssetPanel } = await server.ssrLoadModule('/src/AssetPanel.tsx');
  const { assetImages, assetImageSelection } = await server.ssrLoadModule('/src/contracts.ts');
  const { adoptedImage } = await server.ssrLoadModule('/src/components.tsx');
  const render = (workspace, extra = {}) => renderToStaticMarkup(React.createElement(AssetPanel, { ...props, workspace, ...extra }));

  test('Left card and right preview display the same explicit current image', () => {
    const html = render(base);
    assert.equal((html.match(/alt="fixture-current"/g) || []).length, 2);
    assert.ok(current(html).includes('fixture-current'));
    assert.ok(html.includes('1 项已有当前图片'));
    disabled(html, '重新生成图片', false);
    disabled(html, '导入图片', false);
  });
  test('History is newest first, excludes current and unrelated asset/variant/video', () => {
    const html = history(render(base));
    assert.ok(html.indexOf('fixture-recent') < html.indexOf('fixture-old'));
    assert.equal((html.match(/使用此图/g) || []).length, 2);
    for (const id of ['current', 'other-asset', 'other-variant', 'not-an-image']) assert.ok(!html.includes(`fixture-${id}`), id);
  });
  test('Historical selection binds exact asset, variant and media identity', () => {
    assert.deepEqual(assetImageSelection(base, base.assets[0], 'old'), { assetId: 'asset-1', variantId: 'variant-1', mediaId: 'old' });
    const workspace = { ...base, assets: [{ ...base.assets[0], adoptedMediaId: 'old' }] };
    const html = render(workspace);
    assert.ok(current(html).includes('fixture-old'));
    assert.ok(history(html).includes('fixture-current'));
    assert.ok(!history(html).includes('fixture-old'));
    assert.throws(() => assetImageSelection(base, base.assets[0], 'other-variant'), /不属于当前资产形象/);
    assert.throws(() => assetImageSelection(base, base.assets[0], 'other-asset'), /不属于当前资产形象/);
  });
  test('An empty asset displays current/history empty states and permits image generation', () => {
    const html = render(empty);
    assert.ok(current(html).includes('暂无图片'));
    assert.ok(history(html).includes('暂无历史图片'));
    assert.ok(!html.includes('重新生成图片'));
    disabled(html, '生成图片', false);
    disabled(html, '确认试稿画风', true);
  });
  test('A current image without older images has an empty history', () => {
    const html = render({ ...base, media: [base.media[1]] });
    assert.ok(current(html).includes('fixture-current'));
    assert.ok(history(html).includes('暂无历史图片'));
    assert.ok(!history(html).includes('使用此图'));
    disabled(html, '重新生成图片', false);
  });
  test('A stale current pointer never displays another asset image', () => {
    const workspace = { ...base, assets: [{ ...base.assets[0], adoptedMediaId: 'other-asset' }] }, html = render(workspace);
    assert.ok(current(html).includes('暂无图片'));
    assert.ok(!html.includes('fixture-other-asset'));
    assert.equal(adoptedImage(workspace, workspace.assets[0]), undefined);
    disabled(html, '生成图片', false);
  });
  test('Shared immutable images require an explicit association for this asset and variant', () => {
    const shared = image('shared', 'owner-asset', 'owner-variant', undefined, { adopted: true });
    const workspace = { ...base, assets: [{ ...base.assets[0], adoptedMediaId: 'shared', candidates: ['shared'] }], media: [shared] };
    assert.equal(adoptedImage(workspace, workspace.assets[0])?.id, 'shared');
    assert.ok(current(render(workspace)).includes('fixture-shared'));
    const unlinked = { ...workspace, assets: [{ ...workspace.assets[0], candidates: [] }] };
    assert.equal(assetImages(unlinked, unlinked.assets[0]).current, undefined);
    assert.ok(current(render(unlinked)).includes('暂无图片'));
  });
  test('Global adopted flags do not choose a current image', () => {
    const workspace = { ...base, assets: [{ ...base.assets[0], adoptedMediaId: undefined }], media: base.media.map(media => ({ ...media, adopted: true })) };
    const html = render(workspace);
    assert.ok(current(html).includes('暂无图片'));
    disabled(html, '生成图片', false);
    assert.deepEqual(assetImages(workspace, workspace.assets[0]).history.map(media => media.id), ['recent', 'current', 'old']);
  });
  test('Candidate and batch adoption UI is removed while historical switching stays available', () => {
    const html = render(base);
    for (const text of ['候选与采用', '批量采用候选', '采用此图', '导入候选原图']) assert.ok(!html.includes(text), text);
    assert.ok(history(html).includes('使用此图'));
  });
  test('Style approval remains manual and requires at least one legitimate image', () => {
    const html = render(base);
    assert.ok(html.includes('先生成少量图片，确认画风后再批量出图'));
    disabled(html, '确认试稿画风', false);
    const approved = render({ ...base, settings: { ...base.settings, trialApproved: true } });
    assert.ok(approved.includes('画风试稿已确认，可以批量出图'));
    disabled(approved, '已确认画风', true);
    const unrelatedOnly = render({ ...empty, media: [base.media[3]] });
    disabled(unrelatedOnly, '确认试稿画风', true);
  });
  test('Read-only view disables historical switching, generation and image import', () => {
    const html = render(base, { writable: false });
    disabled(html, '使用此图', true);
    disabled(html, '重新生成图片', true);
    disabled(html, '导入图片', true);
  });
  test('Unknown submissions keep duplicate generation blocked without removing current/history', () => {
    const html = render({ ...base, jobs: [{ id: 'fixture-job', assetId: 'asset-1', kind: 'image', provider: 'dreamina', status: 'submission_unknown', submissionUnknown: true }] });
    disabled(html, '重新生成图片', true);
    disabled(html, '查看与处理任务', false);
    assert.ok(current(html).includes('fixture-current'));
    assert.ok(history(html).includes('fixture-old'));
  });
  test('Generation still requires a saved prompt', () => {
    disabled(render({ ...empty, assets: [{ ...empty.assets[0], prompt: '' }] }), '生成图片', true);
  });
  test('Generation still requires a verified model', () => {
    disabled(render({ ...empty, providers: [] }), '生成图片', true);
  });
  test('Generation still requires a logged-in account', () => {
    disabled(render({ ...empty, dreaminaAccount: { status: 'logged_out', ready: false, identityVerified: false } }), '生成图片', true);
  });
  test('Waiting and completed jobs use current/history language', () => {
    const job = { id: 'fixture-job', assetId: 'asset-1', kind: 'image', provider: 'dreamina' };
    const waiting = render({ ...base, jobs: [{ ...job, status: 'waiting_dependency' }] });
    assert.ok(waiting.includes('等待来源图片，完成后自动继续'));
    assert.ok(!waiting.includes('等待采用来源'));
    const complete = render({ ...base, jobs: [{ ...job, status: 'downloaded' }] });
    assert.ok(complete.includes('原图已保存，可查看当前图片与历史'));
    disabled(complete, '重新生成图片', false);
  });
} finally { await server.close(); }

assert.equal(networkRequests, 0);
assert.equal(mutations, 0);
const report = {
  verifiedAt: new Date().toISOString(),
  method: 'Actual AssetPanel rendered with Vite SSR and ReactDOMServer; exact image-selection contract checked directly',
  passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length,
  networkRequests, mutations, userDatabaseReadOrWritten: false, channelsCalled: false,
  limitations: ['SSR does not execute React effects, file dialogs or click handlers', 'The history-selection payload and resulting UI were verified with pure contracts; no live media.adopt was invoked', 'Native layout, multi-file import results and paid generation require desktop acceptance', 'Batch-selection state is not opened by SSR; manual style-approval UI and its image prerequisite are verified'],
  cases,
};
console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
