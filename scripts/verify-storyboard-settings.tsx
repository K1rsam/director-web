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
    selection: resolveSelection(plan, choice), adopted: [], operations: [], candidates: [], cancellations: [], assembly: null as { text: string; stats: unknown; errors: unknown[]; warnings: unknown[] } | null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, complete: true }, budget: { maxCalls: 32, maxTokens: 300000, maxRepairs: 2 }, phase: "planned", lastCandidateId: null,
  };
}
type Run = ReturnType<typeof savedRun> & { scheduling?: { maxConcurrent: number; maxPerEpisode: number; inFlight: number; queued: number } };
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
    const errors: string[] = [], posts: Record<string, any>[] = [], reads: string[] = [], holds: ReturnType<typeof hold>[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const runs: Record<string, Run> = { A: savedRun("A", "all", 15), B: savedRun("B", "review", 30) };
    const config = { indexHold: null as ReturnType<typeof hold> | null, runHold: null as { id: string; gate: ReturnType<typeof hold>; failure?: boolean } | null, postHold: null as ReturnType<typeof hold> | null, failIndex: false, failPost: false, postFailure: null as { status: number; body: Record<string, unknown> } | null, abortPost: false, maxConcurrent: 2, maxPerEpisode: undefined as number | undefined };
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== "http://storyboard.invalid") { errors.push(`unexpected network: ${url.origin}`); return route.abort(); }
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
      if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "application/javascript", body: bundle.outputFiles[0].text });
      if (url.pathname !== "/api/episodes/fixture/storyboard") { errors.push(`unexpected path: ${url.pathname}`); return route.abort(); }
      if (request.method() === "POST") {
        const command = request.postDataJSON(); posts.push(command);
        if (config.postHold) await config.postHold.wait();
        if (config.abortPost) return route.abort("failed");
        if (config.postFailure) return route.fulfill({ status: config.postFailure.status, json: config.postFailure.body });
        if (config.failPost) return route.fulfill({ status: 503, json: { error: "选择保存失败" } });
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
        return route.fulfill(config.failIndex ? { status: 503, json: { error: "索引暂不可用" } } : { json: { runs: Object.values(runs).map(({ id, title, createdAt, status }) => ({ id, title, createdAt, status })), model: "gpt-6.1-sol", reasoning: "medium", maxConcurrent: config.maxConcurrent, maxPerEpisode: config.maxPerEpisode, runner: { ready: true, message: "隔离验证" }, sourceWarnings: [] } });
      }
      reads.push(id);
      const run = structuredClone(runs[id]), delay = config.runHold?.id === id ? config.runHold : null;
      if (delay) { config.runHold = null; await delay.gate.wait(); }
      return route.fulfill(delay?.failure ? { status: 503, json: { error: "迟到的旧任务错误" } } : { json: { run } });
    });
    return { context, page, runs, config, posts, reads, errors, holds, hold: () => { const gate = hold(); holds.push(gate); return gate; }, open: () => page.goto("http://storyboard.invalid/?runId=A") };
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
    await check("创建前源诊断拒绝显示原文位置，不误报结果未知", async test => {
      delete test.runs.A; delete test.runs.B;
      test.config.postFailure = { status: 409, body: { code: "SOURCE_DIAGNOSTICS", error: "源材料有未处理歧义；任务未创建，尚未调用模型。", creationOutcome: "NOT_CREATED", diagnostics: [{ rowId: "fixture:L0037", line: 37, text: "无归属普通句<原文>", reason: "无法安全识别为对白" }] } };
      await test.open(); await test.page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent === "新建任务（仅准备）")?.disabled);
      await form(test.page).create.click();
      const alert = test.page.getByRole("alert"); await alert.filter({ hasText: "任务未创建" }).waitFor();
      assert.match(await alert.innerText(), /第\s*37\s*行.*fixture:L0037.*无归属普通句<原文>.*无法安全识别为对白/s);
      assert.equal(await test.page.getByText(/新建结果尚未确认/).count(), 0);
      assert.equal(await test.page.locator("原文").count(), 0, "原文片段必须作为文本呈现");
      assert.deepEqual(test.posts.map(post => post.action), ["create"], "明确拒绝也不能自动重发");
      assert.deepEqual(Object.keys(test.runs), []);
    });
    for (const failure of ["network", "409", "503"] as const) await check(`新建${failure}未证明未写入时仍提示核对，不自动重发`, async test => {
      await test.open(); await loaded(test.page);
      if (failure === "network") test.config.abortPost = true;
      else test.config.postFailure = { status: Number(failure), body: { code: "STORYBOARD_ERROR", error: "创建后的读取暂不可用" } };
      await form(test.page).create.click();
      await test.page.getByRole("status").filter({ hasText: "新建结果尚未确认" }).waitFor();
      assert.equal(await test.page.getByText(/任务未创建/).count(), 0);
      assert.deepEqual(test.posts.map(post => post.action), ["create"]);
    });
    await check("已收到新建回执后索引读取失败，保留已建立结论", async test => {
      await test.open(); await loaded(test.page); test.config.failIndex = true;
      await form(test.page).create.click();
      await test.page.getByRole("alert").filter({ hasText: "索引暂不可用" }).waitFor();
      assert.match(await test.page.getByRole("status").filter({ hasText: "任务已建立" }).innerText(), /任务已建立.*列表刷新失败/);
      assert.equal(await test.page.getByText(/新建结果尚未确认/).count(), 0);
      assert.match(test.page.url(), /runId=C/);
      assert.deepEqual(test.posts.map(post => post.action), ["create"]);
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
    await check("全加默认跳过无候选单元；主动请求与取消只保存选择", async test => {
      test.runs.A = savedRun("A", "all", 15, false, true); await test.open(); await loaded(test.page);
      const missing = test.page.getByRole("article").filter({ hasText: "粗单元 U2" }).getByRole("checkbox");
      assert.equal(await missing.isEnabled(), true, "无候选单元仍可主动请求补设计");
      assert.equal(await missing.isChecked(), false, "全加仅采用已有候选，不默认请求补设计");
      assert.match(await test.page.getByRole("article").filter({ hasText: "粗单元 U2" }).innerText(), /无幻想候选.*跳过.*真实表演/);
      assert.equal(test.runs.A.selection.status, "ready");
      assert.equal(await test.page.getByRole("button", { name: "连续完成", exact: true }).isEnabled(), true);
      assert.deepEqual(test.posts, [], "默认跳过不能写入任务或启动模型");
      await missing.click(); await test.page.getByRole("status").filter({ hasText: "操作已保存" }).waitFor();
      assert.equal(test.runs.A.selection.status, "needs_design");
      assert.equal(await missing.isChecked(), true);
      assert.match(await test.page.getByRole("article").filter({ hasText: "粗单元 U2" }).innerText(), /主动请求.*待设计/);
      assert.deepEqual(test.posts[0].unitOverrides, { U2: true });
      assert.equal(await test.page.getByRole("button", { name: "连续完成", exact: true }).isDisabled(), true);
      assert.doesNotMatch(await test.page.getByRole("region", { name: "幻想选择", exact: true }).innerText(), /不能将.*全加.*完成/);
      await missing.click(); await test.page.getByRole("button", { name: "补充幻想规划（一次CLI调用）", exact: true }).waitFor({ state: "hidden" });
      assert.equal(await missing.isChecked(), false); assert.equal(test.runs.A.selection.status, "ready");
      assert.deepEqual(test.runs.A.selection.selectedIds, ["F1"]); assert.deepEqual(test.posts.map(post => post.action), ["choice", "choice"]);
      assert.equal(await test.page.getByRole("checkbox", { name: /甲的压力/ }).isChecked(), true, "取消缺方案单元不能撤掉其他已有候选");
      assert.deepEqual(test.posts[1].unitOverrides, { U2: false });
      await test.page.reload(); await loaded(test.page); assert.equal(await missing.isChecked(), false, "刷新后应保留显式取消请求");
      test.runs.A.choice.mode = "off"; test.runs.A.settings.fantasyMode = "off";
      await test.page.reload(); await loaded(test.page); assert.equal(await missing.isDisabled(), true);
    });
    await check("按实际配置区分全局/单集上限，显示排队与占位而非模型已发送", async test => {
      test.config.maxConcurrent = 6; test.config.maxPerEpisode = 3;
      test.runs.A.active = true; test.runs.A.status = "running";
      test.runs.A.scheduling = { maxConcurrent: 6, maxPerEpisode: 3, inFlight: 0, queued: 2 };
      await test.page.clock.install(); await test.open(); await loaded(test.page);
      assert.match(await test.page.getByLabel("制作岗位").innerText(), /全局最多 6 路.*单集最多 3 路/);
      assert.match(await test.page.getByLabel("本任务调度状态").innerText(), /占用执行位 0.*排队 2/);
      assert.match(await test.page.getByLabel("操作反馈").innerText(), /排队等待执行空位/);
      assert.match(await test.page.getByLabel("本任务调度状态").innerText(), /不代表模型.*推理/);
      test.runs.A.scheduling = { maxConcurrent: 6, maxPerEpisode: 3, inFlight: 1, queued: 1 };
      const response = test.page.waitForResponse(response => response.url().includes("runId=A"));
      await test.page.clock.fastForward(2100); await response;
      await test.page.getByLabel("本任务调度状态").filter({ hasText: /占用执行位 1.*排队 1/ }).waitFor();
      assert.doesNotMatch(await test.page.getByLabel("操作反馈").innerText(), /排队等待执行空位/);
      assert.deepEqual(test.posts, []);
    });
    await check("离开再返回免费读取完成状态，保留参数且focus/visibility/轮询不叠加读取", async test => {
      test.runs.A.active = true; test.runs.A.status = "running";
      await test.page.clock.install(); await test.open(); await loaded(test.page);
      await test.page.clock.pauseAt(await test.page.evaluate(() => Date.now() + 1000));
      await form(test.page).mode.selectOption("off"); await form(test.page).seconds.selectOption("30");
      await test.page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new Event("visibilitychange")); });
      const before = test.reads.length;
      test.runs.A.active = false; test.runs.A.status = "text_ready_for_review";
      test.runs.A.assembly = { text: "已完成的保存分镜", stats: {}, errors: [], warnings: [] };
      const refresh = test.hold(); test.config.runHold = { id: "A", gate: refresh };
      const firstRead = test.page.waitForRequest(request => request.url().includes("runId=A"), { timeout: 500 });
      await test.page.evaluate(() => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new Event("visibilitychange")); });
      await firstRead; await refresh.ready;
      const duplicate = test.page.waitForRequest(request => request.url().includes("runId=A"), { timeout: 250 }).then(() => true, () => false);
      await test.page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); window.dispatchEvent(new Event("focus")); });
      await test.page.clock.fastForward(2100);
      assert.equal(await duplicate, false, "已有读取时不能叠加请求");
      assert.equal(test.reads.length, before + 1, "focus、visibility和轮询应共享一个在途读取");
      refresh.release(); await test.page.getByText("已完成的保存分镜", { exact: true }).waitFor();
      await assertSettings(test.page, "off", 30);
      assert.equal(await test.page.getByRole("checkbox", { name: /甲的压力/ }).isChecked(), true);
      assert.deepEqual(test.posts, [], "回到页面不能启动模型或写入任务");
    });
    await check("返回页面不打断正在保存的幻想选择", async test => {
      await test.open(); await loaded(test.page);
      const save = test.hold(); test.config.postHold = save;
      const candidate = test.page.getByRole("checkbox", { name: /甲的压力/ });
      await candidate.click(); await save.ready;
      const before = test.reads.length;
      await test.page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
      assert.equal(test.reads.length, before); assert.equal(await candidate.isChecked(), false);
      save.release(); await test.page.getByRole("status").filter({ hasText: "操作已保存" }).waitFor();
      assert.equal(await candidate.isChecked(), false); assert.deepEqual(test.posts.map(post => post.action), ["choice"]);
    });
    await check("首次读取503后focus恢复all/15才能新建，后续恢复不覆盖编辑并清除读取错误", async test => {
      const first = test.hold(); test.config.runHold = { id: "A", gate: first, failure: true };
      await test.open(); await first.ready; first.release(); await test.page.getByRole("alert").waitFor();
      assert.equal(await form(test.page).create.isDisabled(), true);
      await test.page.evaluate(() => window.dispatchEvent(new Event("focus"))); await loaded(test.page);
      await assertSettings(test.page, "all", 15);
      assert.equal(await form(test.page).create.isEnabled(), true); assert.equal(await test.page.getByRole("alert").count(), 0);
      await form(test.page).mode.selectOption("off"); await form(test.page).seconds.selectOption("30");
      const next = test.hold(); test.config.runHold = { id: "A", gate: next, failure: true };
      await test.page.evaluate(() => window.dispatchEvent(new Event("focus"))); await next.ready; next.release();
      await test.page.getByRole("alert").filter({ hasText: "自动刷新失败" }).waitFor();
      test.runs.A.usage.totalTokens = 17;
      await test.page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await test.page.getByRole("region", { name: "当前状态", exact: true }).getByText(/已用 17 Token/).waitFor();
      await assertSettings(test.page, "off", 30); assert.equal(await test.page.getByRole("alert").count(), 0);
      assert.deepEqual(test.posts, []);
    });
    await check("成功读取不能清除尚未处理的POST保存错误", async test => {
      await test.open(); await loaded(test.page); test.config.failPost = true;
      await test.page.getByRole("checkbox", { name: /甲的压力/ }).click();
      await test.page.getByRole("alert").filter({ hasText: "选择保存失败" }).waitFor();
      await form(test.page).create.waitFor();
      await test.page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent === "新建任务（仅准备）")?.disabled);
      test.runs.A.usage.totalTokens = 19;
      await test.page.evaluate(() => window.dispatchEvent(new Event("focus")));
      await test.page.getByRole("region", { name: "当前状态", exact: true }).getByText(/已用 19 Token/).waitFor();
      assert.equal(await test.page.getByRole("alert").filter({ hasText: "选择保存失败" }).count(), 1);
      assert.deepEqual(test.posts.map(post => post.action), ["choice"]);
    });
    assert.equal(failed, 0, `${failed} 项工作台行为验证失败`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
