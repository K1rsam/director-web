/** Isolated UI fixtures only: no user DB, real actions, model calls, or live server. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { chromium } from "playwright";
import type { FoundationDeliveryState, FoundationDeliveryTask } from "../lib/foundation-delivery-types";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url).pathname;
require.extensions[".css"] = module => { module.exports = new Proxy({}, { get: (_, key) => key === "__esModule" ? false : String(key) }); };
function stub(path: string, exports: unknown) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as NodeModule;
}
let actionCalls = 0;
const noAction = async () => { actionCalls++; throw new Error("UI fixture must not submit"); };
stub("../app/actions", { startFoundationDeliveryAction: noAction, stopFoundationDeliveryAction: noAction, preprocessProjectAction: noAction });
stub("next/navigation", { useRouter: () => ({ refresh() { throw new Error("SSR must not refresh"); } }) });
const { FoundationWorkflowStatus, FoundationDeliveryPanel } = require("../app/projects/[projectId]/foundation-delivery-panel");
const task: FoundationDeliveryTask = {
  schema: "FOUNDATION_DELIVERY_TASK_V1", id: "fixture-task", revision: 1, projectId: "fixture", provider: "API", contextFingerprint: "fixture",
  sourceVersion: "v1", documentRevision: "v1", status: "RUNNING", phase: "EDIT", scope: [1], completedEpisodes: [], totalEpisodes: 1,
  message: "fixture", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:05Z", workerPid: null, workerToken: null,
  addedCalls: 1, repairCalls: 0, repairRounds: 0, maxRepairCalls: 2, maxRepairRounds: 2, unknownOutcome: false, error: null, decisionIds: [], unresolved: [],
};
const base = { task, totalEpisodes: 1, availableEpisodes: 0, editedEpisodes: 0, busy: true, complete: false, needsContextEdit: false, action: "NONE", expectedState: "fixture", suggestionsCount: 0 } as FoundationDeliveryState;
function render(extra: Partial<FoundationDeliveryState> = {}) {
  return renderToStaticMarkup(createElement(FoundationWorkflowStatus, { projectId: "fixture", state: { ...base, ...extra }, sourceReady: true, sceneCount: 1, remaining: [] }));
}
const selected = (html: string) => html.match(/<article\b[^>]*data-workflow-index="2"[^>]*>[\s\S]*?<\/article>/)?.[0] ?? "";
const failures: string[] = [];
async function check(name: string, run: () => void | Promise<void>) {
  try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); }
}

async function main() {
  await check("Live foundation request without a receipt stays active in header and card", () => {
    for (const [phase, cardIndex] of [["PREPARE_SOURCE", 0], ["GENERATE_F1", 1], ["GENERATE_F2", 2], ["EDIT", 2]] as const) {
      const activeState = { ...base, task: { ...task, phase, unknownOutcome: true } };
      const html = render(activeState);
      const card = html.match(new RegExp(`<article\\b[^>]*data-workflow-index="${cardIndex}"[^>]*>[\\s\\S]*?<\\/article>`))?.[0] ?? "";
      assert.match(card, /data-workflow-state="running"/, `${phase}: an in-flight receipt is not an interrupted request`);
      assert.match(card, /aria-current="step"/);
      assert.match(card, /当前步骤/);
      assert.match(html, /data-clock="running"/);
      assert.doesNotMatch(html, /结果待确认|结果待核对|当前不会自动重发/);
      const header = renderToStaticMarkup(createElement(FoundationDeliveryPanel, { projectId: "fixture", state: activeState, requiredChoiceCount: 0, compact: true }));
      assert.doesNotMatch(header, /请求结果待确认|name="allowUnknownRetry"/);
      assert.match(header, /正在整理/);
    }
  });
  await check("Stale busy plus an interrupted unknown request never claims execution", () => {
    const state = { ...base, action: "UNKNOWN_CONFIRM", task: { ...task, status: "INTERRUPTED", unknownOutcome: true } } as FoundationDeliveryState;
    const html = render(state);
    assert.doesNotMatch(html, /data-workflow-state="running"|data-clock="running"/);
    assert.match(html, /结果待核对/);
    const header = renderToStaticMarkup(createElement(FoundationDeliveryPanel, { projectId: "fixture", state, requiredChoiceCount: 0, compact: true }));
    assert.match(header, /请求结果待确认/);
    assert.doesNotMatch(header, /class="live"/);
  });
  await check("Foundation QUEUED is static waiting, never running", () => {
    const state = { ...base, task: { ...task, status: "QUEUED" } } as FoundationDeliveryState;
    const html = selected(render(state));
    assert.match(html, /data-workflow-state="waiting"/, "排队步骤必须使用 waiting 材质状态");
    assert.match(html, /排队中/);
    assert.doesNotMatch(html, /aria-busy="true"/);
    const panel = renderToStaticMarkup(createElement(FoundationDeliveryPanel, { projectId: "fixture", state, requiredChoiceCount: 0 }));
    assert.match(panel, /已排队，等待本机执行/);
    assert.doesNotMatch(panel, /<h3[^>]*>正在/);
  });
  await check("Foundation running, pause, unknown, waiting and completion are distinct", () => {
    assert.match(selected(render()), /data-workflow-state="running"/);
    assert.match(selected(render()), /aria-busy="true"/);
    for (const extra of [
      { busy: false, action: "UNKNOWN_CONFIRM", task: { ...task, status: "INTERRUPTED", unknownOutcome: true } },
      { busy: false, action: "BLOCKED", task: { ...task, status: "PARTIAL", error: "fixture failure" } },
    ] as Partial<FoundationDeliveryState>[]) assert.match(selected(render(extra)), /data-workflow-state="attention"/);
    assert.match(selected(render({ busy: false, task: { ...task, status: "STOPPED" } })), /data-workflow-state="paused"/);
    assert.match(selected(render({ busy: false, task: { ...task, status: "WAITING_USER" } })), /data-workflow-state="waiting"/);
    const complete = render({ busy: false, complete: true, task: { ...task, status: "COMPLETE" } });
    assert.equal((complete.match(/data-workflow-state="complete"/g) ?? []).length, 4);
    assert.doesNotMatch(complete, /aria-busy="true"/);
  });
  await check("Foundation retains links and controls without an implicit paid Stage 2", () => {
    const html = render({ busy: false, task: { ...task, status: "STOPPED", autoAssetPrompts: false } });
    for (const href of ["/projects/fixture/preparation#script-review", "#foundation-scenes", "#foundation-assets", "/projects/fixture/foundation/handoff"]) assert.ok(html.includes(`href="${href}"`));
    assert.doesNotMatch(html, /name="autoAssetPrompts"/);
    assert.doesNotMatch(render({ busy: false, task: { ...task, status: "STOPPED", autoAssetPrompts: true } }), /name="autoAssetPrompts"/);
    assert.match(html, /第二阶段按需补设计/);
    const panel = renderToStaticMarkup(createElement(FoundationDeliveryPanel, { projectId: "fixture", state: base, requiredChoiceCount: 0, compact: true }));
    assert.match(panel, /name="taskId"[^>]*value="fixture-task"/);
    assert.match(panel, /停止/);
    assert.equal(actionCalls, 0);
  });
  await check("Shared card renders actual busy state and semantic child content", () => {
    const { WorkflowGlassCard } = require("../app/ui/workflow-glass");
    for (const state of ["idle", "running", "complete", "paused", "waiting", "attention"]) {
      const html = renderToStaticMarkup(createElement(WorkflowGlassCard, { state, index: 0 }, createElement("a", { href: "#details" }, "查看详情")));
      assert.match(html, new RegExp(`data-workflow-state="${state}"`));
      assert.equal(html.includes('aria-busy="true"'), state === "running");
      assert.match(html, /<a href="#details">查看详情<\/a>/);
      assert.doesNotMatch(html, /role="progressbar"|aria-valuenow/);
    }
  });
  await check("Real browser material, motion preference, keyboard and narrow layout", async () => {
    const bundle = await build({
      absWorkingDir: root, bundle: true, write: false, outfile: "workflow-fixture.js", loader: { ".module.css": "local-css" },
      define: { "process.env.NODE_ENV": '"production"' },
      stdin: { resolveDir: root, loader: "tsx", contents: `
        import { createElement as h } from 'react';
        import { createRoot } from 'react-dom/client';
        import { WorkflowGlassRail, WorkflowGlassCard, workflowGlassStyles as s } from './app/ui/workflow-glass';
        const states = ['idle', 'running', 'complete', 'paused', 'waiting', 'attention'];
        createRoot(document.getElementById('root')).render(h(WorkflowGlassRail, { label: '流程测试', columns: 3 },
          states.map((state, index) => h(WorkflowGlassCard, { key: state, state, index, activity: state === 'waiting' ? 'waiting' : undefined },
            h('span', { className: s.number }, String(index + 1)),
            h('div', { className: s.heading }, h('strong', { className: s.title }, '长标题与完整状态'.repeat(4)), h('span', { className: s.status }, state)),
            h('p', { className: s.detail }, '保留完整内容与真实链接，不制造运行进度。'.repeat(5)),
            h('a', { href: '#details', onClick: () => document.body.dataset.clicked = state }, '查看详情')))));
      ` },
    });
    const js = bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text;
    const css = bundle.outputFiles.find(file => file.path.endsWith(".css"))!.text;
    const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" }) });
    try {
      const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
      await context.route("http://workflow-glass.test/**", route => route.fulfill({ contentType: "text/html", body: `<!doctype html><meta charset="UTF-8"><style>body{margin:24px;font-family:sans-serif;background:linear-gradient(120deg,#dbe6fa,#ece2f4)}a{color:#6858ab}*{box-sizing:border-box}${css}</style><div id="root"></div><script>${js}</script>` }));
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.goto("http://workflow-glass.test/");
      const cards = page.locator("[data-workflow-state]");
      await cards.first().waitFor();
      const material = await cards.evaluateAll(nodes => nodes.map(node => {
        const after = getComputedStyle(node, "::after");
        const activity = node.querySelector('[data-workflow-activity]')!;
        return { state: node.getAttribute("data-workflow-state"), sheen: after.animationName, duration: after.animationDuration, delay: after.animationDelay,
          opacity: after.opacity, width: after.width, filter: after.filter, activity: getComputedStyle(activity).visibility,
          line: getComputedStyle(activity, "::after").animationName, lineDuration: getComputedStyle(activity, "::after").animationDuration,
          contentOpacity: getComputedStyle(node.querySelector("strong")!).opacity };
      }));
      for (const row of material) {
        assert.notEqual(row.sheen, "none", `${row.state}: glass remains material, independent of status`);
        assert.equal(row.opacity, "0.22");
        assert.equal(row.filter, "blur(2px)");
        assert.equal(row.contentOpacity, "1");
        assert.equal(row.line !== "none", ["running", "waiting"].includes(row.state!));
        assert.equal(row.activity === "visible", ["running", "waiting"].includes(row.state!), `${row.state}: actual execution wait has a distinct activity cue`);
      }
      assert.notEqual(material[4].line, material[1].line, "waiting cannot pretend to be confirmed generation");
      assert.deepEqual(material.slice(0, 4).map(row => row.duration), ["3.2s", "3.6s", "3.9s", "3.4s"]);
      assert.deepEqual(material.slice(0, 4).map(row => row.delay), ["-0.25s", "-1.5s", "-2.65s", "-0.9s"]);
      assert.equal(material[1].lineDuration, "2.4s");
      if (process.env.WORKFLOW_GLASS_SCREENSHOTS) await page.screenshot({ path: `${process.env.WORKFLOW_GLASS_SCREENSHOTS}/workflow-glass-desktop.png`, fullPage: true });
      const toggle = page.getByRole("checkbox", { name: "减少动效" });
      await toggle.focus();
      await page.keyboard.press("Space");
      assert.equal(await toggle.isChecked(), true);
      assert.equal(await cards.first().evaluate(node => getComputedStyle(node, "::after").animationName), "none");
      assert.equal(await cards.nth(1).evaluate(node => getComputedStyle(node.querySelector('[data-workflow-activity]')!, "::after").animationName), "none");
      await page.reload();
      assert.equal(await toggle.isChecked(), true, "manual preference survives a reload");
      await toggle.uncheck();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.waitForFunction(() => document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked);
      assert.equal(await toggle.isChecked(), true, "system motion preference is reflected by native control");
      assert.equal(await cards.first().evaluate(node => getComputedStyle(node, "::after").animationName), "none");
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await page.waitForFunction(() => !document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.disabled);
      await page.setViewportSize({ width: 360, height: 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const rects = await cards.evaluateAll(nodes => nodes.map(node => ({ x: node.getBoundingClientRect().x, width: node.getBoundingClientRect().width })));
      assert.ok(rects.every(rect => rect.x === rects[0].x && rect.width <= 312));
      if (process.env.WORKFLOW_GLASS_SCREENSHOTS) await page.screenshot({ path: `${process.env.WORKFLOW_GLASS_SCREENSHOTS}/workflow-glass-mobile.png`, fullPage: true });
      await toggle.focus();
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), "查看详情");
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement!).outlineStyle), "none", "keyboard link focus outline remains visible");
      await page.keyboard.press("Enter");
      assert.equal(await page.getAttribute("body", "data-clicked"), "idle");
      assert.equal(await cards.first().evaluate(node => node.scrollLeft), 0, "decorative overflow never scrolls on keyboard focus");
      await page.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error("write unavailable"); }; });
      await page.reload();
      await toggle.check();
      assert.equal(await toggle.isChecked(), true, "failed persistence must not restore a readable old preference");
      assert.equal(await cards.first().evaluate(node => getComputedStyle(node, "::after").animationName), "none");
      await page.addInitScript(() => { Storage.prototype.getItem = () => { throw new Error("unavailable"); }; Storage.prototype.setItem = () => { throw new Error("unavailable"); }; });
      await page.reload();
      await toggle.check();
      assert.equal(await cards.first().evaluate(node => getComputedStyle(node, "::after").animationName), "none", "motion control works when storage is unavailable");
      assert.deepEqual(errors, []);
      const actualFoundationStyles = readFileSync(root + 'app/projects/[projectId]/foundation-delivery.module.css', 'utf8') + readFileSync(root + 'app/ui/workflow-glass.module.css', 'utf8');
      await page.setContent(`<style>body{margin:24px;font-family:sans-serif}*{box-sizing:border-box}${actualFoundationStyles}</style>${render({busy:false,task:{...task,status:'STOPPED'}})}`);
      for(const width of [1180,390]){
        await page.setViewportSize({width,height:900});
        const label=page.getByText('第二阶段按需补设计',{exact:true});
        const labelLayout=await label.evaluate(node=>({width:node.getBoundingClientRect().width,parentClass:node.parentElement?.className,parentColumns:getComputedStyle(node.parentElement!).gridTemplateColumns,parentDisplay:getComputedStyle(node.parentElement!).display}));
        assert.ok(labelLayout.width>100,`Retired checkbox layout must not squeeze the new Stage 2 explanation into 15px: ${JSON.stringify({viewport:width,...labelLayout})}`);
        assert.ok((await label.boundingBox())!.height<70,'Stage 2 explanation remains readable without vertical character stacking');
      }
      await context.close();
    } finally { await browser.close(); }
  });
  assert.equal(actionCalls, 0);
  if (failures.length) { console.error(failures.join("\n")); process.exitCode = 1; }
  else console.log("PASS workflow glass: SSR and isolated real-browser UI only; no DB/model/actions.");
}
void main();
