import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import type {PromptWorkspace} from '../lib/asset-prompt-contract';
import type {AssetDesignAdoptionWorkspace} from '../lib/asset-design-adoption';

async function main() {
  assert.ok(existsSync('app/projects/[projectId]/asset-prompts/adoption-panel.tsx'), 'RED: asset adoption panel is not implemented');
  const require = createRequire(import.meta.url);
  require.extensions['.css'] = module => {module.exports = new Proxy({}, {get: (_, key) => key === '__esModule' ? false : String(key)});};
  const {AssetDesignAdoptionPanel} = require('../app/projects/[projectId]/asset-prompts/adoption-panel') as typeof import('../app/projects/[projectId]/asset-prompts/adoption-panel');
  const workspace: PromptWorkspace = {projectId: 'fixture', title: 'fixture', style: '3D', stylePrefix: '3D', styleRevision: 0, busy: false, assets: [
    {key: 'hero', baseKey: 'hero', name: '甲', baseName: '甲', type: 'CH', variant: false, episodes: [1], mode: 'REFERENCE', description: '', note: '', evidence: [], reasons: [], eligible: true, fingerprint: 'source-1'},
  ], records: {hero: {schema: 'ASSET_PROMPT_V1', key: 'hero', revision: 1, status: 'READY', body: '全量提示词：白衣黑发。', facts: '', suggestions: '', error: '', fingerprint: 'source-1', updatedAt: '', origin: 'MANUAL'}}};
  const initial: AssetDesignAdoptionWorkspace = {projectId: 'fixture', canAdopt: true, assets: {hero: {assetKey: 'hero', revision: 0, materialToken: 'material-1', status: 'UNADOPTED', canAdopt: true, reason: '', current: null, references: [], history: []}}};
  const html = renderToStaticMarkup(createElement(AssetDesignAdoptionPanel, {projectId: 'fixture', assetKey: 'hero', workspace, initial}));
  assert.match(html, /分镜简述/); assert.match(html, /未采用/); assert.match(html, /全量提示词：白衣黑发/);
  assert.match(html,/自由设计范围/);assert.match(html,/门.*通路.*遮挡/,'production brief prioritizes action-functional design without writing shots');
  assert.doesNotMatch(html, /<textarea[^>]*aria-label="分镜简述"[^>]*>全量提示词/);
  const inline = structuredClone(workspace); inline.assets[0].mode = 'INLINE'; inline.assets[0].eligible = false;
  assert.match(renderToStaticMarkup(createElement(AssetDesignAdoptionPanel, {projectId: 'fixture', assetKey: 'hero', workspace: inline, initial})), /无需独立图/);
  const bundle = await build({stdin: {contents: `import React from 'react';import{createRoot}from'react-dom/client';import{AssetDesignAdoptionPanel}from'./app/projects/[projectId]/asset-prompts/adoption-panel';createRoot(document.getElementById('root')).render(<AssetDesignAdoptionPanel projectId="fixture" assetKey="hero" workspace={${JSON.stringify(workspace)}} initial={${JSON.stringify(initial)}}/>);`, resolveDir: process.cwd(), loader: 'tsx'}, bundle: true, write: false, outdir: 'out', platform: 'browser', jsx: 'automatic', define: {'process.env.NODE_ENV': '"production"'}});
  const browser = await chromium.launch({headless: true, ...(existsSync(chromium.executablePath()) ? {} : {channel: 'chrome'})});
  const page = await browser.newPage({viewport: {width: 1280, height: 900}}), actions: Record<string, unknown>[] = [], errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  let server = structuredClone(initial), conflict = true;
  try {
    await page.route('http://adoption.test/**', async route => {
      if (!new URL(route.request().url()).pathname.endsWith('/adoption')) return route.fulfill({contentType: 'text/html', body: '<main id="root"></main>'});
      if (route.request().method() !== 'POST') return route.fulfill({json: server});
      const input = route.request().postDataJSON(); actions.push(input);
      if (conflict) {conflict = false; server.assets.hero.revision = 1; return route.fulfill({status: 409, json: {error: '另一窗口已更新采用记录，请刷新；你的简述会保留。'}});}
      server.assets.hero.revision++;
      if (input.action === 'revoke') {server.assets.hero.status = 'UNADOPTED'; server.assets.hero.current = null;}
      else {
        server.assets.hero.status = 'TEXT_ADOPTED';
        server.assets.hero.current = {schema: 'ASSET_DESIGN_ADOPTION_V1', action: 'ADOPT', assetKey: 'hero', version: server.assets.hero.revision, actor: {id: 'human', name: '人工审查'}, createdAt: new Date().toISOString(), brief: input.brief, referenceIds: [], references: [], previousVersion: null, sourceFingerprint: 'source-1', factsFingerprint: 'facts', promptRevision: 1, promptFingerprint: 'prompt', styleRevision: 0, styleFingerprint: 'style', referenceDependencies: []};
        server.assets.hero.history.push(server.assets.hero.current);
      }
      return route.fulfill({json: server});
    });
    await page.goto('http://adoption.test/');
    await page.addStyleTag({content: bundle.outputFiles.find(file => file.path.endsWith('.css'))!.text});
    await page.addScriptTag({content: bundle.outputFiles.find(file => file.path.endsWith('.js'))!.text});
    await page.getByLabel('分镜简述', {exact: true}).fill('只给分镜的白衣、黑发约束。');
    await page.getByLabel('自由设计范围', {exact: true}).fill('衣料细纹可调整，不新增身份徽记。');
    assert.equal(await page.getByRole('button', {name: '采用当前设计', exact: true}).isDisabled(), true);
    await page.getByLabel('我已核对简述与当前已保存提示词').check();
    await page.getByRole('button', {name: '采用当前设计', exact: true}).click();
    await page.getByRole('alert').filter({hasText: '另一窗口'}).waitFor();
    assert.equal(await page.getByLabel('分镜简述', {exact: true}).inputValue(), '只给分镜的白衣、黑发约束。');
    await page.getByLabel('我已核对简述与当前已保存提示词').check();
    await page.getByRole('button', {name: '采用当前设计', exact: true}).click();
    await page.getByText('已采用 · 仅文字', {exact: true}).waitFor();
    assert.equal(actions[1].expectedRevision, 1); assert.equal(actions[1].brief, '只给分镜的白衣、黑发约束。');
    assert.equal(actions[1].freeDesignScope,'衣料细纹可调整，不新增身份徽记。');
    assert.equal(actions[1].actorId, undefined);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', {name: '撤销采用', exact: true}).click();
    await page.getByText('未采用 · 仅文字', {exact: true}).waitFor();
    await page.locator('summary').filter({hasText: '采用历史'}).click();
    await page.getByRole('button', {name: '载入简述并核对恢复'}).click();
    assert.equal(await page.getByRole('button', {name: '核对后恢复采用'}).isDisabled(), true);
    await page.getByLabel('我已核对简述与当前已保存提示词').check();
    await page.getByRole('button', {name: '核对后恢复采用'}).click();
    await page.getByText('已采用 · 仅文字', {exact: true}).waitFor();
    assert.equal(actions.at(-1)?.action, 'restore');
    await page.setViewportSize({width: 375, height: 812});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'narrow layout does not overflow');
    assert.deepEqual(errors, []);
    console.log('PASS adoption UI: real browser; manual brief, confirmation, conflict draft preservation, CAS refresh, revoke, reviewed restore, narrow layout; model/DB/image calls 0');
  } finally {await browser.close();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
