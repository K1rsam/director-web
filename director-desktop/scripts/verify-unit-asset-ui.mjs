import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
globalThis.location = { search: '?preview=1' };
let networkRequests = 0;
globalThis.fetch = async () => { networkRequests++; throw new Error('No network in isolated UI verification'); };
const marker = '{{asset:old:base}}';
const unit = { id: 'u-1', title: '推门进入', episodeId: 'ep-1', sceneId: 'scene-1', version: 3, prompt: `林夏推开院门。${marker}，保持人物服装。`, assetRefs: [{ assetId: 'old', variantId: 'base', role: '人物', order: 1 }], sourceRefs: ['row-1'], duration: 12 };
const image = { id: 'current', kind: 'image', assetId: 'new', variantId: 'base', path: '', previewUrl: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="100" height="80"%3E%3Crect width="100" height="80" fill="%23bbb1d2"/%3E%3C/svg%3E' };
const workspace = { project: { id: 'isolated' }, assets: [{ id: 'new', name: '林夏 · 校服', variantId: 'base', kind: 'character', adoptedMediaId: image.id, applicability: { episodes: ['ep-1'] } }], media: [image], units: [unit], jobs: [], providers: [], settings: {}, rules: [] };
const cases = [];
async function test(name, task) { try { await task(); cases.push({ name, passed: true }); } catch (error) { cases.push({ name, passed: false, error: error.message }); } }
class Host {
  cells = []; cursor = 0;
  useState(initial) { const index = this.cursor++; if (!(index in this.cells)) this.cells[index] = typeof initial === 'function' ? initial() : initial; return [this.cells[index], next => this.cells[index] = typeof next === 'function' ? next(this.cells[index]) : next]; }
  useEffect() { this.cursor++; }
  useMemo(callback) { this.cursor++; return callback(); }
  render(Component, props) { this.cursor = 0; globalThis.__assetUnitHooks = this; return Component(props); }
}
function descendants(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(descendants)]; }
function text(tree) { return typeof tree === 'string' || typeof tree === 'number' ? String(tree) : React.Children.toArray(tree?.props?.children).map(text).join(''); }
function button(tree, label) { const node = descendants(tree).find(node => node.type?.name === 'Button' && text(node) === label); assert.ok(node, label); return node.props; }
function field(tree, label) { const node = descendants(tree).find(node => node.props?.['aria-label'] === label); assert.ok(node, label); return node.props; }
const server = await createServer({ logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', plugins: [{ name: 'unit-assets-isolated-hooks', enforce: 'pre', transform(code, id) { if (/\/src\/(UnitAssetEditor|UnitPanel)\.tsx$/.test(id.replaceAll('\\', '/').split('?')[0])) return code.replaceAll("from 'react'", "from '/@asset-unit-hooks'"); }, resolveId(id, importer) { if (id === '/@asset-unit-hooks') return '\0asset-unit-hooks'; if (id === './api' && /\/src\/UnitPanel\.tsx$/.test((importer || '').replaceAll('\\', '/'))) return '\0asset-unit-api'; }, load(id) { if (id === '\0asset-unit-hooks') return ['useState', 'useEffect', 'useMemo'].map(name => `export function ${name}(...args) { return globalThis.__assetUnitHooks.${name}(...args); }`).join('\n'); if (id === '\0asset-unit-api') return 'export async function request(input) { return globalThis.__unitAssetsRead(input); } export async function choose() { throw new Error("File dialog forbidden"); }'; } }] });
try {
  const { UnitAssetEditor } = await server.ssrLoadModule('/src/UnitAssetEditor.tsx'), { UnitPanel } = await server.ssrLoadModule('/src/UnitPanel.tsx');
  function setup(overrides = {}) { const host = new Host(), calls = [], state = { closed: false }, values = { workspace, unit, writable: true, mutate: async (action, payload) => { calls.push({ action, payload }); return workspace; }, onClose: () => state.closed = true, ...overrides }; return { calls, state, values, render: () => host.render(UnitAssetEditor, values) }; }
  await test('Deleted asset has a visible repair action and cannot save until resolved', () => { const item = setup(), tree = item.render(); assert.ok(text(tree).includes('已删除或缺失')); assert.equal(button(tree, '保存配图').disabled, true); assert.ok(text(tree).includes('历史图片和已提交任务保留')); });
  await test('Replacement saves only unit version, prompt and exact new identity; never submits generation', async () => { const item = setup(); field(item.render(), '配图 1 资产').onChange({ target: { value: 'new' } }); const tree = item.render(); assert.equal(button(tree, '保存配图').disabled, false); await button(tree, '保存配图').onClick(); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(item.calls.length, 1); assert.equal(item.calls[0].action, 'units.save'); const saved = item.calls[0].payload.unit; assert.equal(saved.expectedVersion, 3); assert.deepEqual(saved.sourceRefs, ['row-1']); assert.equal(saved.prompt, '林夏推开院门。{{asset:new:base}}，保持人物服装。'); assert.equal(saved.assetRefs[0].assetId, 'new'); assert.equal(saved.assetRefs[0].mediaId, undefined); assert.equal(item.state.closed, true); });
  await test('Removing a used asset waits for explicit text correction, never truncates prompt', () => { const item = setup(); button(item.render(), '移除').onClick(); assert.equal(field(item.render(), '配图对应提示词').value, unit.prompt); assert.equal(button(item.render(), '保存配图').disabled, true); field(item.render(), '配图对应提示词').onChange({ target: { value: '空景：院门缓缓打开。' } }); assert.equal(button(item.render(), '保存配图').disabled, false); });
  await test('Concurrent unit update blocks stale draft and read-only mode blocks saving', () => { const item = setup({ workspace: { ...workspace, units: [{ ...unit, version: 4 }] } }); field(item.render(), '配图 1 资产').onChange({ target: { value: 'new' } }); assert.equal(button(item.render(), '保存配图').disabled, true); assert.ok(text(item.render()).includes('单元已更新')); assert.equal(button(setup({ writable: false }).render(), '保存配图').disabled, true); });
  await test('Stage 4 adjustment reads full unit, keeps the version and exposes separate editor', async () => { const host = new Host(), reads = [], values = { workspace, mode: 'videos', writable: true, mutate: async () => { throw new Error('No mutation on opening'); }, inspect() {}, onNotice() {}, onError: error => { throw new Error(error); } }; globalThis.__unitAssetsRead = async input => { reads.push(input); assert.equal(input.action, 'units.get'); return unit; }; await button(host.render(UnitPanel, values), '调整配图').onClick(); await new Promise(resolve => setTimeout(resolve, 0)); const editor = descendants(host.render(UnitPanel, values)).find(node => node.type?.name === 'UnitAssetEditor'); assert.ok(editor); assert.equal(editor.props.unit.version, 3); assert.deepEqual(reads, [{ action: 'units.get', projectId: 'isolated', unitId: 'u-1' }]); });
} finally { await server.close(); }
// Actual SSR of the component, with the same stylesheet, for browser layout QA.
const ssr = await createServer({ logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { UnitAssetEditor } = await ssr.ssrLoadModule('/src/UnitAssetEditor.tsx');
  const html = renderToStaticMarkup(React.createElement(UnitAssetEditor, { workspace, unit, writable: true, mutate() { throw new Error('Static fixture'); }, onClose() {} })).replace('<dialog ', '<dialog open ');
  await mkdir('docs/verification/asset-lifecycle', { recursive: true });
  await writeFile('docs/verification/asset-lifecycle/unit-editor-layout.html', `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/unitAssetEditor.css"><style>body{min-height:100vh;padding:32px;background:#ebe6f5}dialog[open]{position:relative;margin:auto;max-height:calc(100vh - 64px)}</style></head><body>${html}</body></html>`);
} finally { await ssr.close(); }
const report = { method: 'Actual components: SSR and isolated callback replay', passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length, networkRequests, productionDatabaseWritten: false, generationRequestsSent: 0, cases };
await writeFile('docs/verification/asset-lifecycle/unit-editor-ui.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
if (report.failed || networkRequests) process.exitCode = 1;
