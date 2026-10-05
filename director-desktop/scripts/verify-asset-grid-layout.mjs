import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

// Offline geometry test: render the actual AssetPanel, with synthetic assets only.
// No desktop core, model, production project, HTTP resource, or mutation is used.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const reportPath = resolve(root, process.argv[2] || 'reports/asset-grid-source-conflict-20261005/ui.json');
let playwright;
for (const candidate of ['playwright', resolve(root, '../director-web-3008-stage2-images/node_modules/playwright')]) {
  try { playwright = require(candidate); break; } catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
}
assert.ok(playwright, 'Playwright is required locally; no browser installation is performed by this script.');

const originalExtensions = { ts: Module._extensions['.ts'], tsx: Module._extensions['.tsx'], css: Module._extensions['.css'] };
const extraCss = [];
for (const extension of ['.ts', '.tsx']) Module._extensions[extension] = (module, filename) => {
  const compiled = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } });
  module._compile(compiled.outputText, filename);
};
Module._extensions['.css'] = (_module, filename) => extraCss.push(readFileSync(filename, 'utf8'));
let upstreamCalls = 0, mutations = 0, browserNetworkRequests = 0;
const forbidden = async () => { upstreamCalls++; throw new Error('Desktop or upstream access is forbidden in this verification.'); };
const apiPath = resolve(root, 'src/api.ts');
const originalApiModule = require.cache[apiPath];
require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: { desktop: false, preview: true, request: forbidden, choose: forbidden, mediaUrl: media => media?.previewUrl || '' } };

let browser;
const results = [];
try {
  const { AssetPanel } = require(resolve(root, 'src/AssetPanel.tsx'));
  const css = await readFile(resolve(root, 'src/styles.css'), 'utf8');
  const assetGridRule = css.match(/\.asset-grid\{[^}]*\}/)?.[0];
  assert.ok(assetGridRule?.includes('grid-auto-rows:max-content;'), 'The base asset grid must size implicit rows from their contents.');
  const baselineCss = css.replace(assetGridRule, assetGridRule.replace('grid-auto-rows:max-content;', ''));
  const cssSuffix = extraCss.join('\n');
  const illustration = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#ded5e9"/><text x="320" y="240" text-anchor="middle" fill="#67597f">Synthetic asset</text></svg>');
  const props = { writable: true, mutate: async () => { mutations++; throw new Error('Mutation is forbidden in this verification.'); }, inspect() {}, onNotice() {}, onError() {}, onTasks() {} };
  function markup(count, withImages) {
    const assets = Array.from({ length: count }, (_, index) => ({ id: `fixture-asset-${index}`, name: `合成资产形象 ${index + 1}`, kind: ['character', 'scene', 'prop'][index % 3], version: 2, variantId: `fixture-variant-ac2d8c55-3c0e-4f03-ab7f-b86072c1980b-${index}`, prompt: '仅用于界面几何验证的合成形象提示词。', adoptedMediaId: withImages ? `fixture-media-${index}` : undefined, candidates: [] }));
    const workspace = { project: { id: 'asset-grid-offline-fixture', title: '合成资产布局验证' }, assets, media: withImages ? assets.map((asset, index) => ({ id: `fixture-media-${index}`, assetId: asset.id, variantId: asset.variantId, kind: 'image', path: '', previewUrl: illustration, name: `fixture-image-${index}` })) : [], units: [], jobs: [], rules: [], settings: { imageProvider: 'dreamina', imageModel: '5.0', imageResolution: '2k', ratio: '16:9', trialApproved: false }, providers: [{ id: 'dreamina', models: [{ id: '5.0', kind: 'image', available: true, adapted: true, ratios: ['16:9'], resolutions: ['2k'] }] }], dreaminaAccount: { status: 'authenticated', ready: true, identityVerified: true, accountKey: 'synthetic-account' } };
    return renderToStaticMarkup(React.createElement(AssetPanel, { ...props, workspace }));
  }
  browser = await playwright.chromium.launch({ headless: true, channel: process.env.ASSET_GRID_BROWSER_CHANNEL || 'msedge' });
  const page = await browser.newPage();
  await page.route('**/*', route => { browserNetworkRequests++; return route.abort(); });
  async function measure() {
    return page.evaluate(() => {
      const grid = document.querySelector('.asset-grid');
      const cards = [...document.querySelectorAll('.asset-card')].map(element => element.getBoundingClientRect());
      const style = getComputedStyle(grid);
      let minimumGap = Infinity;
      for (const card of cards) {
        const next = cards.find(other => other.top > card.top + 0.5);
        if (next) minimumGap = Math.min(minimumGap, next.top - card.bottom);
      }
      const round = value => Math.round(value * 1000) / 1000;
      const result = { cardCount: cards.length, firstCardHeight: round(cards[0].height), gridHeight: grid.clientHeight, scrollHeight: grid.scrollHeight, implicitRowHeights: style.gridTemplateRows.split(' ').map(value => Number.parseFloat(value)), rowGap: Number.parseFloat(style.rowGap), minimumCardGap: Number.isFinite(minimumGap) ? round(minimumGap) : null, overflowY: style.overflowY };
      grid.scrollTop = grid.scrollHeight;
      const last = document.querySelector('.asset-card:last-child').getBoundingClientRect(), bounds = grid.getBoundingClientRect();
      result.lastCardBottomWithinGrid = last.bottom <= bounds.bottom + 0.5;
      result.lastCardHasPositiveHeight = last.height > 100;
      return result;
    });
  }
  for (const count of [1, 58, 200]) for (const withImages of [false, true]) for (const [width, height] of [[1440, 940], [1280, 720], [900, 900]]) {
    await page.setViewportSize({ width, height });
    const panel = markup(count, withImages);
    const html = style => `<style>${style}\n${cssSuffix}</style><div class="app-shell"><aside class="sidebar">合成工作台</aside><main class="main-area"><header class="topbar"><h1>图片资产</h1></header><div class="page-content">${panel}</div></main></div>`;
    await page.setContent(html(baselineCss));
    const before = await measure();
    await page.setContent(html(css));
    const after = await measure();
    const entry = { count, withImages, viewport: { width, height }, before, after, passed: false };
    try {
      assert.equal(after.cardCount, count);
      assert.ok(after.firstCardHeight > 100, 'Cards retain their natural visual height.');
      assert.ok(after.minimumCardGap === null || after.minimumCardGap >= after.rowGap - 0.5, 'Every next row clears the previous card and preserves its CSS gap.');
      assert.ok(after.lastCardBottomWithinGrid, 'Scrolling to the end exposes the last card bottom.');
      assert.ok(after.lastCardHasPositiveHeight);
      assert.equal(after.overflowY, width <= 950 ? 'visible' : 'auto', 'Existing narrow-screen and desktop scrolling behavior is preserved.');
      if (count > 1 && width > 950) assert.ok(before.minimumCardGap < 0, 'The old auto-row rule reproduces the overlap.');
      entry.passed = true;
    } catch (error) { entry.error = error.message; }
    results.push(entry);
  }
  assert.equal(upstreamCalls, 0);
  assert.equal(mutations, 0);
  assert.equal(browserNetworkRequests, 0);
  const report = { test: 'asset-grid-layout', verifiedAt: new Date().toISOString(), verification: 'Offline actual React AssetPanel SSR markup in headless browser; synthetic assets and embedded SVG media only. No live desktop interaction or production project was used.', browser: browser.version(), browserChannel: process.env.ASSET_GRID_BROWSER_CHANNEL || 'msedge', stylesheetSha256: createHash('sha256').update(css).digest('hex'), fix: '.asset-grid { grid-auto-rows: max-content; }', requests: { upstream: upstreamCalls, mutations, browserNetwork: browserNetworkRequests }, passed: results.every(entry => entry.passed), caseCount: results.length, cases: results };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ passed: report.passed, cases: results.length, report: reportPath, requests: report.requests }));
  assert.ok(report.passed, 'See ui.json for failed geometry cases.');
} finally {
  await browser?.close();
  for (const [extension, original] of [['.ts', originalExtensions.ts], ['.tsx', originalExtensions.tsx], ['.css', originalExtensions.css]]) {
    if (original) Module._extensions[extension] = original; else delete Module._extensions[extension];
  }
  if (originalApiModule) require.cache[apiPath] = originalApiModule; else delete require.cache[apiPath];
}
