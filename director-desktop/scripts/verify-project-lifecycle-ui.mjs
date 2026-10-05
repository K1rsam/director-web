import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

globalThis.location = { search: '?preview=1' };
let networkRequests = 0;
globalThis.fetch = async () => { networkRequests++; throw Error('Live network is forbidden in project lifecycle UI verification.'); };
const active = { id: 'example-active', title: '校园觉醒 · 示例', rootPath: 'E:\\制作项目\\校园觉醒', counts: { assets: 12, units: 8, videos: 3 } };
const archived = { id: 'example-archived', title: '山海归途 · 示例', rootPath: 'E:\\制作项目\\山海归途', archivedAt: '2026-10-04T05:00:00Z', lifecycleVersion: 3, counts: { assets: 23, units: 17, videos: 17 } };
const archivedSecond = { ...archived, id: 'example-archived-2', title: '长街灯火 · 示例', rootPath: 'E:\\制作项目\\长街灯火', counts: { assets: 9, units: 5, videos: 5 } };
const projects = [active, archived, archivedSecond], cases = [], calls = [];
const directory = resolve('docs/verification/project-lifecycle');
await mkdir(directory, { recursive: true });
const base = { projects, filter: 'active', writable: true, busy: false, onFilterChange() {}, onOpen() {}, onCreate() {}, onLifecycle: async (action, project) => { calls.push({ action, projectId: project.id }); return true; } };
function descendants(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(descendants)]; }
function text(value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : React.Children.toArray(value?.props?.children).map(text).join(''); }
function button(tree, name) { const node = descendants(tree).find(item => (item.type === 'button' || item.type?.name === 'Button') && (item.props['aria-label'] === name || text(item) === name)); assert.ok(node, name); return node.props; }
function component(tree, name) { const node = descendants(tree).find(item => item.type?.name === name); assert.ok(node, name); return node.props; }
async function settle() { await new Promise(done => setImmediate(done)); }
async function test(name, task) { try { await task(); cases.push({ name, passed: true }); } catch (error) { cases.push({ name, passed: false, error: error.message }); } }
class HookHost {
  cells = []; cursor = 0; effects = [];
  useState(initial) { const index = this.cursor++; if (!(index in this.cells)) this.cells[index] = typeof initial === 'function' ? initial() : initial; return [this.cells[index], value => this.cells[index] = typeof value === 'function' ? value(this.cells[index]) : value]; }
  useRef(initial) { const index = this.cursor++; if (!(index in this.cells)) this.cells[index] = { current: initial }; return this.cells[index]; }
  useCallback(callback, dependencies) { const index = this.cursor++, previous = this.cells[index]; if (!previous || dependencies.some((item, position) => item !== previous.dependencies[position])) this.cells[index] = { callback, dependencies }; return this.cells[index].callback; }
  useEffect(callback, dependencies) { const index = this.cursor++, previous = this.cells[index]; if (!previous || dependencies.some((item, position) => item !== previous.dependencies[position])) this.effects.push(() => { previous?.cleanup?.(); this.cells[index].cleanup = callback(); }); this.cells[index] = { dependencies, cleanup: previous?.cleanup }; }
  render(Component, props) { this.cursor = 0; this.effects = []; globalThis.__projectHooks = this; return Component(props); }
  async flushEffects() { for (const callback of this.effects) callback(); this.effects = []; await settle(); }
}
const ssr = await createServer({ logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom' });
try {
  const { ProjectLibrary, ProjectLifecycleConfirmation } = await ssr.ssrLoadModule('/src/ProjectLibrary.tsx');
  const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));
  const ongoing = render(ProjectLibrary, base), archivedView = render(ProjectLibrary, { ...base, filter: 'archived' });
  const archiveDialog = render(ProjectLifecycleConfirmation, { operation: { action: 'projects.archive', project: active }, writable: true, pending: false, error: '', onClose() {}, onConfirm() {} });
  const deleteDialog = render(ProjectLifecycleConfirmation, { operation: { action: 'projects.delete', project: archived }, writable: true, pending: false, error: '', onClose() {}, onConfirm() {} });
  await test('Active and archived projects have separate tabs and counts', () => { assert.ok(ongoing.includes('校园觉醒')); assert.ok(!ongoing.includes('山海归途')); assert.ok(ongoing.includes('role="tablist"')); assert.ok(ongoing.includes('aria-selected="true"')); assert.ok(archivedView.includes('山海归途')); assert.ok(archivedView.includes('长街灯火')); assert.ok(!archivedView.includes('校园觉醒')); });
  await test('Archived cards offer restore and delete, never open; active cards cannot delete', () => { assert.ok(!ongoing.includes('删除项目：')); assert.ok(ongoing.includes('project-card-open')); assert.ok(!archivedView.includes('project-card-open')); assert.ok(archivedView.includes('恢复项目：')); assert.ok(archivedView.includes('删除项目：')); assert.ok(!/<button[^>]*>[\s\S]*?<button/.test(ongoing.split('</button>')[0])); });
  await test('Confirmation distinguishes paused local work from cloud cancellation and retains files on delete', () => { assert.ok(archiveDialog.includes('暂停本地队列与查询')); assert.ok(archiveDialog.includes('云端已提交的任务不会取消')); assert.ok(deleteDialog.includes('从本机项目列表移除')); assert.ok(deleteDialog.includes('剧本、数据库、图片、视频与任务记录保留')); assert.ok(deleteDialog.includes(archived.rootPath)); assert.ok(!deleteDialog.includes('checkbox')); assert.ok(!deleteDialog.includes('textarea')); });
  const css = (await Promise.all(['src/styles.css', 'src/projectLibrary.css'].map(path => readFile(resolve(path), 'utf8')))).join('\n');
  for (const [name, markup] of [['active', ongoing], ['archived', archivedView], ['archive-dialog', archiveDialog], ['delete-dialog', deleteDialog]]) {
    const dialog = name.endsWith('dialog');
    await writeFile(resolve(directory, `layout-${name}.html`), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离项目归档布局 · ${name}</title><style>${css}\nbody{min-height:100dvh;background:linear-gradient(130deg,#e6ebfc,#eee6f3);margin:0}.layout-root{max-width:1140px;margin:auto;padding:36px 28px}.layout-note{font-size:.75rem;color:#8d7d9d;margin-bottom:25px}.modal[open]{position:fixed;inset:0;margin:auto}.modal-body{overflow:auto}</style></head><body>${dialog ? markup.replace('<dialog ', '<dialog open ') : `<main class="layout-root"><div class="layout-note">布局核验示例 · 没有连接真实项目</div>${markup}</main>`}</body></html>`);
  }
} finally { await ssr.close(); }

globalThis.__projectRequests = [];
let registry = structuredClone(projects), dispatch = async input => {
  if (input.action === 'projects.list') return structuredClone(registry);
  if (input.action === 'workspace.get') return { project: registry.find(item => item.id === input.projectId), assets: [], media: [], units: [], jobs: [], settings: {}, providers: [], rules: [] };
  const project = registry.find(item => item.id === input.projectId);
  if (input.action === 'projects.delete') registry = registry.filter(item => item.id !== input.projectId);
  else { project.archivedAt = input.action === 'projects.archive' ? '2026-10-04T08:00:00Z' : null; project.lifecycleVersion = (project.lifecycleVersion ?? 0) + 1; }
  return { projectId: input.projectId, archivedAt: project.archivedAt, lifecycleVersion: project.lifecycleVersion, filesRetained: true };
};
globalThis.__projectRequest = async input => { globalThis.__projectRequests.push(input); return dispatch(input); };
globalThis.__projectDesktop = true;
globalThis.__projectTimers = [];
globalThis.window = { setInterval: callback => { globalThis.__projectTimers.push(callback); return globalThis.__projectTimers.length; }, clearInterval() {} };
globalThis.document = { hidden: false };
const replay = await createServer({ logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true }, appType: 'custom', plugins: [{ name: 'isolated-project-ui-hooks', enforce: 'pre', transform(code, id) { if (/\/src\/(?:ProjectLibrary|App)\.tsx$/.test(id.replaceAll('\\', '/').split('?')[0])) return code.replaceAll("from 'react'", "from '/@project-hooks'").replaceAll("from './api'", "from '/@project-api'"); }, resolveId(id) { if (id === '/@project-hooks') return '\0project-hooks'; if (id === '/@project-api') return '\0project-api'; }, load(id) { if (id === '\0project-hooks') return ['useState', 'useRef', 'useCallback', 'useEffect'].map(name => `export function ${name}(...args) { return globalThis.__projectHooks.${name}(...args); }`).join('\n'); if (id === '\0project-api') return 'export const desktop = globalThis.__projectDesktop; export const preview = false; export function request(value) { return globalThis.__projectRequest(value); } export function isWorkspace(value) { return value?.project && Array.isArray(value.assets); } export async function choose() { return []; } export function mediaUrl() { return ""; }'; } }] });
try {
  const { ProjectLibrary, ProjectLifecycleConfirmation } = await replay.ssrLoadModule('/src/ProjectLibrary.tsx');
  const { default: App } = await replay.ssrLoadModule('/src/App.tsx');
  await test('Archive confirmation calls the real component action once, including duplicate click before rerender', async () => {
    calls.length = 0; let release;
    const host = new HookHost(), props = { ...base, onLifecycle: async (action, project) => { calls.push({ action, projectId: project.id }); await new Promise(done => release = done); return true; } };
    button(host.render(ProjectLibrary, props), `归档项目：${active.title}`).onClick();
    const confirm = component(host.render(ProjectLibrary, props), 'ProjectLifecycleConfirmation'); confirm.onConfirm(); confirm.onConfirm(); assert.deepEqual(calls, [{ action: 'projects.archive', projectId: active.id }]);
    assert.equal(component(host.render(ProjectLibrary, props), 'ProjectLifecycleConfirmation').pending, true);
    release(); await settle(); assert.ok(!descendants(host.render(ProjectLibrary, props)).some(item => item.type?.name === 'ProjectLifecycleConfirmation'));
  });
  await test('Archive failure keeps the confirmation open and displays the actual error', async () => {
    const host = new HookHost(), props = { ...base, onLifecycle: async () => { throw Error('本项目仍有本地请求正在执行，请稍后归档。'); } };
    button(host.render(ProjectLibrary, props), `归档项目：${active.title}`).onClick(); component(host.render(ProjectLibrary, props), 'ProjectLifecycleConfirmation').onConfirm(); await settle();
    const confirm = component(host.render(ProjectLibrary, props), 'ProjectLifecycleConfirmation'); assert.ok(confirm.error.includes('本地请求正在执行')); assert.equal(confirm.pending, false);
  });
  await test('Restore invokes the existing identity without a generation request or another confirmation', async () => {
    calls.length = 0; const host = new HookHost(); button(host.render(ProjectLibrary, { ...base, filter: 'archived' }), `恢复项目：${archived.title}`).onClick(); await settle(); assert.deepEqual(calls, [{ action: 'projects.restore', projectId: archived.id }]);
  });
  await test('Read-only and busy callbacks cannot change project lifecycle even when invoked directly', async () => {
    calls.length = 0;
    for (const extra of [{ writable: false }, { busy: true }]) { const host = new HookHost(), props = { ...base, ...extra }; button(host.render(ProjectLibrary, props), `归档项目：${active.title}`).onClick(); assert.ok(!descendants(host.render(ProjectLibrary, props)).some(item => item.type?.name === 'ProjectLifecycleConfirmation')); button(host.render(ProjectLibrary, { ...props, filter: 'archived' }), `恢复项目：${archived.title}`).onClick(); }
    await settle(); assert.equal(calls.length, 0);
  });
  await test('Delete confirmation can only target archived identity and is disabled while pending', async () => {
    calls.length = 0; const host = new HookHost(), props = { ...base, filter: 'archived' }; button(host.render(ProjectLibrary, props), `删除项目：${archived.title}`).onClick(); const confirmation = component(host.render(ProjectLibrary, props), 'ProjectLifecycleConfirmation'); confirmation.onConfirm(); await settle(); assert.deepEqual(calls, [{ action: 'projects.delete', projectId: archived.id }]);
    const tree = ProjectLifecycleConfirmation({ ...confirmation, pending: true }); assert.equal(button(tree, '正在处理…').disabled, true);
  });
  async function appHost() { const host = new HookHost(); host.render(App); await host.flushEffects(); return host; }
  await test('Actual App project action defaults legacy version to zero and never uses workspace reload', async () => {
    registry = structuredClone(projects); globalThis.__projectRequests.length = 0; const host = await appHost(); const library = component(host.render(App), 'ProjectLibrary'); await library.onLifecycle('projects.archive', active); assert.deepEqual(globalThis.__projectRequests.filter(item => item.action === 'projects.archive'), [{ action: 'projects.archive', projectId: active.id, expectedVersion: 0 }]); assert.equal(globalThis.__projectRequests.filter(item => item.action === 'workspace.get').length, 0);
    const updated = component(host.render(App), 'ProjectLibrary'); assert.equal(updated.projects.find(item => item.id === active.id).lifecycleVersion, 1);
  });
  await test('Actual App closes current archived workspace and invalidates an in-flight workspace read', async () => {
    registry = structuredClone(projects); globalThis.__projectRequests.length = 0; const host = await appHost(); let library = component(host.render(App), 'ProjectLibrary'); library.onOpen(active); await settle(); host.render(App); button(host.render(App), '所有项目1').onClick(); library = component(host.render(App), 'ProjectLibrary');
    const normalDispatch = dispatch; let completeRead;
    dispatch = input => input.action === 'workspace.get' ? new Promise(done => completeRead = done) : normalDispatch(input);
    library.onOpen(active); await library.onLifecycle('projects.archive', active); completeRead({ project: active, assets: [], media: [], units: [], jobs: [] }); await settle(); dispatch = normalDispatch;
    const tree = host.render(App); assert.ok(component(tree, 'ProjectLibrary')); assert.ok(!descendants(tree).some(item => item.type?.name === 'FoundationPanel')); assert.ok(text(tree).includes('选择或创建项目'));
  });
  await test('Actual App archive and delete reject duplicate requests and unarchived delete', async () => {
    registry = structuredClone(projects); globalThis.__projectRequests.length = 0; const host = await appHost(), library = component(host.render(App), 'ProjectLibrary'); assert.equal(await library.onLifecycle('projects.delete', active), false);
    const normalDispatch = dispatch; let release; dispatch = async input => { if (input.action === 'projects.archive') await new Promise(done => release = done); return normalDispatch(input); };
    const first = library.onLifecycle('projects.archive', active); assert.equal(await library.onLifecycle('projects.archive', active), false); release(); await first; dispatch = normalDispatch; assert.equal(globalThis.__projectRequests.filter(item => item.action === 'projects.archive').length, 1);
  });
  await test('Actual App preserves archived tab on restore and uses current lifecycle version', async () => {
    registry = structuredClone(projects); globalThis.__projectRequests.length = 0; const host = await appHost(); component(host.render(App), 'ProjectLibrary').onFilterChange('archived'); await component(host.render(App), 'ProjectLibrary').onLifecycle('projects.restore', archived); const library = component(host.render(App), 'ProjectLibrary'); assert.equal(library.filter, 'archived'); assert.deepEqual(globalThis.__projectRequests.find(item => item.action === 'projects.restore'), { action: 'projects.restore', projectId: archived.id, expectedVersion: 3 });
  });
  await test('Actual App removes archived card without reading removed workspace or deleting local files', async () => {
    registry = structuredClone(projects); globalThis.__projectRequests.length = 0; const host = await appHost(); await component(host.render(App), 'ProjectLibrary').onLifecycle('projects.delete', archived); assert.ok(!component(host.render(App), 'ProjectLibrary').projects.some(item => item.id === archived.id)); assert.deepEqual(globalThis.__projectRequests.filter(item => item.action !== 'projects.list'), [{ action: 'projects.delete', projectId: archived.id, expectedVersion: 3 }]);
  });
} finally { await replay.close(); }
const report = { method: 'Actual React SSR and isolated ProjectLibrary/App callback replay', passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length, networkRequests, generationCalls: globalThis.__projectRequests.filter(item => /images\.|videos\.|workflow\.|text\./.test(item.action)).length, productionDatabaseAccess: false, localProjectFileDeletion: false, fixtures: ['layout-active.html', 'layout-archived.html', 'layout-archive-dialog.html', 'layout-delete-dialog.html'], limitations: ['SSR fixtures do not prove native layout or backend persistence', 'Backend project lifecycle and native interaction are verified separately'], cases };
assert.equal(networkRequests, 0);
await writeFile(resolve(directory, 'ui.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
