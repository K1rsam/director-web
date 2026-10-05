import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

globalThis.location = { search: '?preview=1' };
globalThis.document = { hidden: false };
globalThis.window = { setInterval() { return 1; }, clearInterval() {} };
let networkRequests = 0;
globalThis.fetch = async () => { networkRequests++; throw Error('Live network is forbidden in inline project UI verification.'); };
const directory = resolve('docs/verification/foundation-scope');
await mkdir(directory, { recursive: true });
const cases = [], calls = [];
const current = { id: 'existing-project', title: '原有制作项目', rootPath: 'E:\\existing-project', lifecycleVersion: 0 };
let registry = [current], failCreation = false;
const workspaceFor = project => ({ project, source: { version: 0, text: '', episodes: [], scenes: [], rows: [] }, assets: [], media: [], units: [], jobs: [], settings: { textProvider: 'codex', textModel: 'gpt-6.1-sol', reasoning: 'medium' }, providers: [], rules: [] });
globalThis.__inlineRequest = async payload => {
  calls.push(payload);
  if (payload.action === 'projects.list') return structuredClone(registry);
  if (payload.action === 'workspace.get') return workspaceFor(registry.find(item => item.id === payload.projectId));
  if (payload.action === 'projects.create') {
    if (failCreation) throw Error('测试用创建错误');
    const project = { id: `created-${registry.length}`, title: payload.title, rootPath: `C:\\isolated-default-projects\\created-${registry.length}` };
    registry.push(project); return structuredClone(project);
  }
  throw Error(`Unexpected action ${payload.action}`);
};
function descendants(tree) { return !tree || typeof tree !== 'object' ? [] : [tree, ...React.Children.toArray(tree.props?.children).flatMap(descendants)]; }
function text(value) { return typeof value === 'string' || typeof value === 'number' ? String(value) : React.Children.toArray(value?.props?.children).map(text).join(''); }
function component(tree, name) { const node = descendants(tree).find(item => item.type?.name === name); assert.ok(node, name); return node; }
function input(tree) { return descendants(tree).find(item => item.type === 'input').props; }
function form(tree) { return descendants(tree).find(item => item.type === 'form').props; }
function button(tree, label) { const node = descendants(tree).find(item => (item.type === 'button' || item.type?.name === 'Button') && text(item) === label); assert.ok(node, label); return node.props; }
async function settle() { await new Promise(done => setImmediate(done)); }
async function test(name, task) { try { await task(); cases.push({ name, passed: true }); } catch (error) { cases.push({ name, passed: false, error: error.message }); } }
class HookHost {
  cells = []; cursor = 0; effects = [];
  useState(initial) { const index = this.cursor++; if (!(index in this.cells)) this.cells[index] = typeof initial === 'function' ? initial() : initial; return [this.cells[index], value => this.cells[index] = typeof value === 'function' ? value(this.cells[index]) : value]; }
  useRef(initial) { const index = this.cursor++; if (!(index in this.cells)) this.cells[index] = { current: initial }; return this.cells[index]; }
  useCallback(callback, dependencies) { const index = this.cursor++, previous = this.cells[index]; if (!previous || dependencies.some((value, position) => value !== previous.dependencies[position])) this.cells[index] = { callback, dependencies }; return this.cells[index].callback; }
  useEffect(callback, dependencies) { const index = this.cursor++, previous = this.cells[index]; if (!previous || dependencies.some((value, position) => value !== previous.dependencies[position])) this.effects.push(() => { previous?.cleanup?.(); this.cells[index].cleanup = callback(); }); this.cells[index] = { dependencies, cleanup: previous?.cleanup }; }
  render(Component, props) { this.cursor = 0; this.effects = []; globalThis.__inlineHooks = this; return Component(props); }
  async flushEffects() { for (const callback of this.effects) callback(); this.effects = []; await settle(); }
}
const ssr = await createServer({ logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const replay = await createServer({ logLevel: 'error', optimizeDeps: { noDiscovery: true }, server: { middlewareMode: true, hmr: false }, appType: 'custom', plugins: [{ name: 'isolated-inline-project-hooks', enforce: 'pre', transform(code, id) { if (/\/src\/(?:App|ProjectLibrary|InlineProjectCreate)\.tsx$/.test(id.replaceAll('\\', '/').split('?')[0])) return code.replaceAll("from 'react'", "from '/@inline-hooks'").replaceAll("from './api'", "from '/@inline-api'"); }, resolveId(id) { if (id === '/@inline-hooks') return '\0inline-hooks'; if (id === '/@inline-api') return '\0inline-api'; }, load(id) { if (id === '\0inline-hooks') return ['useState', 'useRef', 'useCallback', 'useEffect'].map(name => `export function ${name}(...args) { return globalThis.__inlineHooks.${name}(...args); }`).join('\n'); if (id === '\0inline-api') return 'export const desktop = true; export const preview = false; export function request(value) { return globalThis.__inlineRequest(value); } export function isWorkspace(value) { return value?.project && Array.isArray(value.assets); } export async function choose() { return []; } export function mediaUrl() { return ""; }'; } }] });
try {
  const { InlineProjectCreate } = await replay.ssrLoadModule('/src/InlineProjectCreate.tsx');
  const { default: App } = await replay.ssrLoadModule('/src/App.tsx');
  const onCreate = async () => true, base = { writable: true, busy: false, onCreate };
  const submit = tree => form(tree).onSubmit({ preventDefault() {} });
  async function appHost() { const host = new HookHost(); host.render(App); await host.flushEffects(); return host; }
  function createEntry(tree) { return descendants(tree).find(item => item.type?.name === 'InlineProjectCreate') || descendants(tree).find(item => item.type?.name === 'ProjectLibrary')?.props.createForm; }
  await test('Inline form replaces directory picker and create modal with one accessible input', async () => {
    const { InlineProjectCreate: RealCreate } = await ssr.ssrLoadModule('/src/InlineProjectCreate.tsx');
    const html = renderToStaticMarkup(React.createElement(RealCreate, base));
    assert.ok(html.includes('新项目名称')); assert.ok(html.includes('添加项目')); assert.equal((html.match(/<input /g) || []).length, 1); assert.ok(!html.includes('保存目录')); assert.ok(!html.includes('<dialog')); assert.ok(/maxlength="160"/i.test(html)); assert.ok(html.includes('type="submit"'));
  });
  await test('Blank, overlong, read-only and busy submissions are refused even when called directly', async () => {
    let submitted = 0;
    for (const variant of [{ title: '   ' }, { title: 'x'.repeat(161) }, { title: '测试', writable: false }, { title: '测试', busy: true }]) {
      const host = new HookHost(), props = { ...base, ...variant, onCreate: async () => { submitted++; return true; } };
      input(host.render(InlineProjectCreate, props)).onChange({ target: { value: variant.title } }); const view = host.render(InlineProjectCreate, props);
      assert.equal(button(view, '添加项目').disabled, true); submit(view); await settle();
    }
    assert.equal(submitted, 0);
  });
  await test('Enter submission trims the name, blocks duplicate events and clears only after success', async () => {
    const sent = []; let release; const props = { ...base, onCreate: async title => { sent.push(title); await new Promise(done => release = done); return true; } }, host = new HookHost();
    input(host.render(InlineProjectCreate, props)).onChange({ target: { value: '  新剧本  ' } }); const view = host.render(InlineProjectCreate, props); submit(view); submit(view);
    assert.deepEqual(sent, ['新剧本']); const pending = host.render(InlineProjectCreate, props); assert.equal(button(pending, '正在添加…').disabled, true); assert.equal(input(pending).value, '  新剧本  ');
    release(); await settle(); assert.equal(input(host.render(InlineProjectCreate, props)).value, '');
  });
  await test('Failed creation retains the name for retry', async () => {
    const host = new HookHost(), props = { ...base, onCreate: async () => false }; input(host.render(InlineProjectCreate, props)).onChange({ target: { value: '需要重试的项目' } }); submit(host.render(InlineProjectCreate, props)); await settle(); assert.equal(input(host.render(InlineProjectCreate, props)).value, '需要重试的项目'); assert.equal(button(host.render(InlineProjectCreate, props), '添加项目').disabled, false);
  });
  await test('Empty library retains inline entry and project package import without a modal', async () => {
    registry = []; const host = await appHost(), tree = host.render(App); assert.ok(createEntry(tree)); assert.ok(button(tree, '导入项目包')); assert.ok(!descendants(tree).some(item => item.type?.name === 'Modal'));
  });
  await test('Actual App submits only trimmed title, uses the default folder and opens stage one', async () => {
    registry = [structuredClone(current)]; calls.length = 0; const host = await appHost(); assert.equal(await createEntry(host.render(App)).props.onCreate('  新制作项目  '), true);
    assert.deepEqual(calls.find(item => item.action === 'projects.create'), { action: 'projects.create', title: '新制作项目' });
    const tree = host.render(App), foundation = component(tree, 'FoundationPanel'); assert.equal(foundation.props.workspace.project.title, '新制作项目'); assert.equal(foundation.props.workspace.project.id, 'created-1'); assert.ok(!createEntry(tree)); assert.ok(text(tree).includes('剧本与基础')); assert.equal(registry[0].rootPath, current.rootPath);
  });
  await test('Only the project library exposes creation; all four production stages keep the current project', async () => {
    registry = [structuredClone(current)]; calls.length = 0; const host = await appHost(); component(host.render(App), 'ProjectLibrary').props.onOpen(current); await settle(); const tree = host.render(App); assert.equal(component(tree, 'FoundationPanel').props.workspace.project.id, current.id);
    for (const stage of ['剧本与基础', '图片资产', '分镜提示词', '单元视频']) {
      const stageButton = descendants(host.render(App)).find(item => item.type === 'button' && item.props.className?.includes('stage-link') && text(item).includes(stage)); assert.ok(stageButton, stage); stageButton.props.onClick(); assert.ok(!createEntry(host.render(App)), stage);
    }
    button(host.render(App), '所有项目1').onClick(); assert.ok(createEntry(host.render(App))); assert.equal(calls.filter(item => item.action === 'projects.create').length, 0); assert.deepEqual(registry[0], current);
  });
  await test('Actual App rejects duplicate create before rerender and invalid direct payloads', async () => {
    registry = [structuredClone(current)]; calls.length = 0; const host = await appHost(), entry = createEntry(host.render(App)), dispatch = globalThis.__inlineRequest; let release;
    globalThis.__inlineRequest = async payload => { if (payload.action === 'projects.create') await new Promise(done => release = done); return dispatch(payload); };
    try { const first = entry.props.onCreate('单次添加'); assert.equal(await entry.props.onCreate('重复添加'), false); release(); await first; assert.equal(calls.filter(item => item.action === 'projects.create').length, 1); assert.equal(await entry.props.onCreate('   '), false); assert.equal(await entry.props.onCreate('x'.repeat(161)), false); }
    finally { globalThis.__inlineRequest = dispatch; }
  });
  await test('Actual App presents backend failure and does not switch the current project', async () => {
    registry = [structuredClone(current)]; failCreation = true; const host = await appHost(); component(host.render(App), 'ProjectLibrary').props.onOpen(current); await settle(); button(host.render(App), '所有项目1').onClick(); const entry = createEntry(host.render(App)); assert.equal(await entry.props.onCreate('失败项目'), false); const tree = host.render(App); assert.ok(text(tree).includes('测试用创建错误')); assert.ok(component(tree, 'ProjectLibrary')); assert.ok(text(tree).includes(current.title)); assert.deepEqual(registry[0], current); failCreation = false;
  });
  const { InlineProjectCreate: RealCreate } = await ssr.ssrLoadModule('/src/InlineProjectCreate.tsx');
  const { ProjectLibrary: RealLibrary } = await ssr.ssrLoadModule('/src/ProjectLibrary.tsx');
  function realTree(tree) {
    if (!React.isValidElement(tree)) return tree;
    const type = tree.type?.name === 'InlineProjectCreate' ? RealCreate : tree.type?.name === 'ProjectLibrary' ? RealLibrary : tree.type;
    const props = { ...tree.props }; if (props.createForm) props.createForm = realTree(props.createForm);
    return React.createElement(type, props, ...React.Children.toArray(props.children).map(realTree));
  }
  const css = (await Promise.all(['src/styles.css', 'src/stage-production.css', 'src/projectLibrary.css', 'src/inlineProjectCreate.css'].map(path => readFile(resolve(path), 'utf8')))).join('\n');
  for (const name of ['foundation-empty', 'projects-empty']) {
    registry = name === 'foundation-empty' ? [structuredClone(current)] : []; const host = await appHost(); if (name === 'foundation-empty') { component(host.render(App), 'ProjectLibrary').props.onOpen(current); await settle(); }
    const markup = renderToStaticMarkup(realTree(host.render(App)));
    await writeFile(resolve(directory, `layout-${name}.html`), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>隔离新建项目布局 · ${name}</title><style>${css}</style></head><body>${markup}</body></html>`);
  }
} finally { await replay.close(); await ssr.close(); }
assert.equal(networkRequests, 0);
const report = { method: 'Actual InlineProjectCreate/App callback replay and React SSR layout fixtures', passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length, networkRequests, generationCalls: calls.filter(item => /images\.|videos\.|workflow\.|text\./.test(item.action)).length, productionDatabaseAccess: false, fixtures: ['layout-foundation-empty.html', 'layout-projects-empty.html'], cases };
await writeFile(resolve(directory, 'inline-create-ui.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (report.failed) process.exitCode = 1;
