import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Page } from "playwright";

const require = createRequire(import.meta.url);
const { resolveSelection } = require("../runtime/storyboard-v4/core/selection.mjs");
const root = fileURLToPath(new URL("..", import.meta.url));
type Mode = "off" | "all" | "recommended" | "review";
function savedRun(id: string, fantasyMode: Mode, maxUnitSeconds: 15 | 30, active = false, missingUnit = false) {
  const plan = {
    emotionArc: "承压后坚持", workPackages: [{ id: "P1", sourceRefs: ["S1", "S2"], emotionContract: { subject: "甲", contextTone: "严肃", audienceEffect: "坚持", change: "承压", landing: "站稳", retain: [] }, dependsOn: [] }],
    provisionalUnits: [{ id: "U1", packageId: "P1", sourceRefs: ["S1"], secondsRange: [4, 10] }, ...(missingUnit ? [{ id: "U2", packageId: "P1", sourceRefs: ["S2"], secondsRange: [4, 10] }] : [])],
    fantasyCandidates: [{ id: "F1", anchorRefs: ["S1"], subject: "甲的压力", emotionPurpose: "外化压力", recommended: true, proposal: "主观压力" }],
  };
  const choice = { mode: fantasyMode, overrides: {} as Record<string, boolean>, unitOverrides: {} as Record<string, boolean>, confirmedFingerprint: null };
  return {
    id, title: id, createdAt: "2026-09-27T00:00:00Z", status: active ? "running" : "planned", settings: { fantasyMode, maxUnitSeconds }, active, sourceStale: false,
    error: null, sourceRows: [{ id: "S1", text: `已保存原文 ${id}` }, { id: "S2", text: "另一处原文" }], sourceWarnings: [], plan, choice,
    selection: resolveSelection(plan, choice), adopted: [], operations: [], candidates: [], cancellations: [], assembly: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, complete: true }, budget: { maxCalls: 32, maxTokens: 300000, maxRepairs: 2 }, phase: "planned", lastCandidateId: null,
  };
}
type Run = ReturnType<typeof savedRun>;
function hold() {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { ready, release, wait: async () => { entered(); await pending; } };
}
const form = (page: Page) => ({ mode: page.getByLabel(/^幻想处理/), seconds: page.getByLabel(/^单元上限/), create: page.getByRole("button", { name: "新建任务（仅准备）", exact: true }), runs: page.getByLabel(/^查看任务/) });
async function loaded(page: Page) { await page.getByRole("region", { name: "当前状态", exact: true }).waitFor(); }
async function assertSettings(page: Page, mode: Mode, seconds: 15 | 30) {
  assert.equal(await form(page).mode.inputValue(), mode, "新建模式应承接已保存任务，不得退回默认值或串到其他任务");
  assert.equal(await form(page).seconds.inputValue(), String(seconds), "单元上限应承接已保存任务");
}

async function main() {
  // Transpile the real client component in memory; no Next build, server, database, or model process.
  const bundle = await build({ stdin: { contents: 'import {createElement} from "react"; import {createRoot} from "react-dom/client"; import {StoryboardWorkbench} from "./app/projects/[projectId]/episodes/[episodeId]/storyboard/workbench"; createRoot(document.getElementById("root")).render(createElement(StoryboardWorkbench, {episodeId:"fixture", episodeTitle:"设置隔离验证"}));', resolveDir: root, loader: "tsx" }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", loader: { ".css": "empty", ".module.css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent" });
  const executablePath = existsSync(chromium.executablePath()) ? undefined : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  let failed = 0;
  async function check(name: string, runTest: (test: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
    const test = await fixture();
    try { await runTest(test); assert.deepEqual(test.errors, []); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${(error as Error).message}`); }
    finally { test.holds.forEach(item => item.release()); await test.context.close(); }
  }
  async function fixture() {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(2000);
    const errors: string[] = [], posts: Record<string, any>[] = [], holds: ReturnType<typeof hold>[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const runs: Record<string, Run> = { A: savedRun("A", "all", 15), B: savedRun("B", "review", 30) };
    const config = { indexHold: null as ReturnType<typeof hold> | null, runHold: null as { id: string; gate: ReturnType<typeof hold>; failure?: boolean } | null, failIndex: false };
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== "http://storyboard.invalid") { errors.push(`unexpected network: ${url.origin}`); return route.abort(); }
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
      if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "application/javascript", body: bundle.outputFiles[0].text });
      if (url.pathname !== "/api/episodes/fixture/storyboard") { errors.push(`unexpected path: ${url.pathname}`); return route.abort(); }
      if (request.method() === "POST") {
        const command = request.postDataJSON(); posts.push(command);
        let run: Run;
        if (command.action === "create") run = runs.C = savedRun("C", command.settings.fantasyMode, command.settings.maxUnitSeconds);
        else if (command.action === "choice") {
          run = runs[command.runId];
          run.choice = { ...run.choice, mode: command.mode, overrides: command.overrides, unitOverrides: command.unitOverrides };
          run.settings.fantasyMode = command.mode; run.selection = resolveSelection(run.plan, run.choice);
        } else { errors.push(`unexpected action: ${command.action}`); return route.abort(); }
        return route.fulfill({ json: { run }, status: command.action === "create" ? 201 : 200 });
      }
      const id = url.searchParams.get("runId");
      if (!id) {
        if (config.indexHold) await config.indexHold.wait();
        return route.fulfill(config.failIndex ? { status: 503, json: { error: "索引暂不可用" } } : { json: { runs: Object.values(runs).map(({ id, title, createdAt, status }) => ({ id, title, createdAt, status })), model: "gpt-6-sol", reasoning: "medium", maxConcurrent: 2, runner: { ready: true, message: "隔离验证" }, sourceWarnings: [] } });
      }
      const run = structuredClone(runs[id]), delay = config.runHold?.id === id ? config.runHold : null;
      if (delay) { config.runHold = null; await delay.gate.wait(); }
      return route.fulfill(delay?.failure ? { status: 503, json: { error: "迟到的旧任务错误" } } : { json: { run } });
    });
    return { context, page, runs, config, posts, errors, holds, hold: () => { const gate = hold(); holds.push(gate); return gate; }, open: () => page.goto("http://storyboard.invalid/?runId=A") };
  }
  try {
    await check("刷新 all/15 并用保存值新建；编辑新建参数不改旧选择", async test => {
      await test.open(); await loaded(test.page); await test.page.reload(); await loaded(test.page);
      await assertSettings(test.page, "all", 15);
      await form(test.page).mode.selectOption("off");
      assert.equal(await test.page.getByRole("button", { name: "全部加入", exact: true }).getAttribute("aria-pressed"), "true");
      assert.deepEqual(test.posts, []);
      await form(test.page).mode.selectOption("all"); await form(test.page).create.click();
      await test.page.getByRole("status").filter({ hasText: "任务已建立，尚未调用模型" }).waitFor();
      assert.deepEqual(test.posts.map(post => ({ action: post.action, settings: post.settings })), [{ action: "create", settings: { maxUnitSeconds: 15, fantasyMode: "all" } }]);
    });
    await check("切换到 review/30 并用切换后的值新建", async test => {
      await test.open(); await loaded(test.page); await form(test.page).runs.selectOption("B"); await loaded(test.page);
      await assertSettings(test.page, "review", 30); await form(test.page).create.click();
      await test.page.getByRole("status").filter({ hasText: "任务已建立，尚未调用模型" }).waitFor();
      assert.deepEqual(test.posts[0].settings, { maxUnitSeconds: 30, fantasyMode: "review" });
    });
    await check("索引及任务参数未就绪时不能抢先新建", async test => {
      const index = test.hold(), detail = test.hold(); test.config.indexHold = index; test.config.runHold = { id: "A", gate: detail };
      await test.open(); await index.ready;
      assert.equal(await form(test.page).create.isDisabled(), true, "索引加载中应禁止新建");
      index.release(); await detail.ready;
      assert.equal(await form(test.page).create.isDisabled(), true, "详情未读取时应禁止用默认值新建");
      assert.equal(await form(test.page).mode.isDisabled(), true);
      detail.release(); await loaded(test.page); await assertSettings(test.page, "all", 15);
      assert.equal(await form(test.page).create.isEnabled(), true); assert.deepEqual(test.posts, []);
    });
    await check("自动轮询不覆盖正在编辑的新建参数", async test => {
      test.runs.A.active = true; test.runs.A.status = "running";
      await test.page.clock.install(); await test.open(); await loaded(test.page);
      await form(test.page).mode.selectOption("off"); await form(test.page).seconds.selectOption("30");
      test.runs.A.usage.totalTokens = 11;
      const response = test.page.waitForResponse(response => response.url().includes("runId=A"));
      await test.page.clock.fastForward(2100); await response;
      await test.page.getByRole("region", { name: "当前状态", exact: true }).getByText(/已用 11 Token/).waitFor();
      await assertSettings(test.page, "off", 30);
      assert.match(await test.page.getByLabel("当前任务已保存参数").innerText(), /15 秒.*全部加入/);
    });
    for (const failure of [false, true]) await check(`迟到的旧任务${failure ? "错误" : "成功"}响应不能串入新任务`, async test => {
      const detail = test.hold(); test.config.runHold = { id: "A", gate: detail, failure };
      await test.open(); await detail.ready; await form(test.page).runs.selectOption("B"); await loaded(test.page);
      const response = test.page.waitForResponse(response => response.url().includes("runId=A")); detail.release(); await response;
      await test.page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      await assertSettings(test.page, "review", 30); assert.equal(await form(test.page).runs.inputValue(), "B");
      assert.equal(await test.page.getByRole("alert").count(), 0, "旧任务的失败不能污染当前任务");
    });
    await check("索引失败不能用未确认的默认值新建", async test => {
      test.config.failIndex = true; await test.open(); await test.page.getByRole("alert").waitFor();
      assert.equal(await form(test.page).create.isDisabled(), true); assert.deepEqual(test.posts, []);
    });
    await check("全加可取消无候选单元请求；只保存选择且其他候选保留", async test => {
      test.runs.A = savedRun("A", "all", 15, false, true); await test.open(); await loaded(test.page);
      const missing = test.page.getByRole("article").filter({ hasText: "粗单元 U2" }).getByRole("checkbox");
      assert.equal(await missing.isEnabled(), true, "无候选的全加请求必须可取消");
      assert.equal(await missing.isChecked(), true, "应显示全加默认的待设计请求态");
      assert.match(await test.page.getByRole("article").filter({ hasText: "粗单元 U2" }).innerText(), /希望加入.*待设计/);
      await missing.click(); await test.page.getByRole("status").filter({ hasText: "操作已保存" }).waitFor();
      assert.equal(await missing.isChecked(), false); assert.equal(test.runs.A.selection.status, "ready");
      assert.deepEqual(test.runs.A.selection.selectedIds, ["F1"]); assert.deepEqual(test.posts.map(post => post.action), ["choice"]);
      assert.equal(await test.page.getByRole("checkbox", { name: /甲的压力/ }).isChecked(), true, "取消缺方案单元不能撤掉其他已有候选");
      assert.deepEqual(test.posts[0].unitOverrides, { U2: false });
      await test.page.reload(); await loaded(test.page); assert.equal(await missing.isChecked(), false, "显式false应优先于全加默认值");
      test.runs.A.choice.mode = "off"; test.runs.A.settings.fantasyMode = "off";
      await test.page.reload(); await loaded(test.page); assert.equal(await missing.isDisabled(), true);
    });
    assert.equal(failed, 0, `${failed} 项工作台行为验证失败`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
