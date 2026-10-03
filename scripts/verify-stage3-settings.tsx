import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, type Locator, type Page } from "playwright";
import { MODE_LABELS, type Mode, type Run } from "../app/projects/[projectId]/episodes/[episodeId]/storyboard/types";

const require = createRequire(import.meta.url);
const { resolveSelection } = require("../runtime/storyboard-v4/core/selection.mjs");
const root = fileURLToPath(new URL("..", import.meta.url));
const origin = "http://stage3.invalid";
const endpoint = "/api/episodes/fixture/storyboard";

function savedRun(id: string, fantasyMode: Mode, maxUnitSeconds: 15 | 30, missingUnit = false): Run {
  const plan = {
    emotionArc: "承压后坚持", events: [{ id: "E1", title: "站稳" }],
    workPackages: [{ id: "P1", sourceRefs: ["S1", "S2"], emotionContract: { subject: "甲", contextTone: "严肃", audienceEffect: "坚持", change: "承压", landing: "站稳", retain: ["原文行动"] }, dependsOn: [] }],
    provisionalUnits: [{ id: "U1", packageId: "P1", sourceRefs: ["S1"], secondsRange: [4, 10] }, ...(missingUnit ? [{ id: "U2", packageId: "P1", sourceRefs: ["S2"], secondsRange: [4, 10] }] : [])],
    fantasyCandidates: [{ id: "F1", anchorRefs: ["S1"], subject: "甲的压力", emotionPurpose: "外化压力", recommended: true, proposal: "主观压力", screenSecondsRange: [1, 2] }],
  };
  const choice = { mode: fantasyMode, overrides: {}, unitOverrides: missingUnit ? {U2:true} : {}, confirmedFingerprint: null };
  return {
    id, title: `隔离任务 ${id}`, createdAt: "2026-09-27T00:00:00Z", status: "planned", phase: "planned", active: false, sourceStale: false,
    directorNotes: `已保存要求 ${id}`, settings: { fantasyMode, maxUnitSeconds, model: "gpt-6-sol", reasoning: "medium" }, error: null,
    sourceRows: [{ id: "S1", text: `已保存原文 ${id}` }, { id: "S2", text: "另一处原文" }], sourceWarnings: [], plan, choice,
    selection: resolveSelection(plan, choice), adopted: [], operations: [], candidates: [], cancellations: [], assembly: null,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, complete: true },
    budget: { maxCalls: id === "B" ? 21 : 32, maxTokens: id === "B" ? 210000 : 300000, maxRepairs: 2 },
  };
}

function hold() {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { ready, release, wait: async () => { entered(); await pending; } };
}
async function within<T>(promise: Promise<T>, label: string, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`超时：${label}`)), milliseconds); })]); }
  finally { clearTimeout(timer!); }
}
const form = (page: Page) => {
  const panel = page.getByRole("region", { name: "新建制作任务", exact: true });
  return { panel, mode: (mode: Mode) => panel.getByRole("button", { name: new RegExp(`^${MODE_LABELS[mode]}`) }), seconds: (seconds: 15 | 30) => panel.getByRole("button", { name: new RegExp(`^${seconds}\\s*秒`) }), notes: panel.getByRole("textbox", { name: /^本集创作要求/ }), calls: panel.getByLabel("最多调用次数", { exact: true }), tokens: panel.getByLabel("Token 停止线", { exact: true }), create: panel.getByRole("button", { name: /^创建制作任务/ }) };
};
async function openSettings(page: Page) {
  if (!await form(page).panel.isVisible()) await page.getByRole("button", { name: "新建任务", exact: true }).click();
  if (!await form(page).notes.isVisible()) await form(page).panel.locator("summary").filter({ hasText: "创作要求与运行停止线" }).click();
}
async function expand(panel: Locator, text: string) {
  const summary = panel.locator("summary").filter({ hasText: text });
  if (await summary.evaluate(element => !(element.parentElement as HTMLDetailsElement).open)) await summary.click();
}
async function loaded(page: Page, id = "A") {
  await page.getByLabel("当前任务已保存配置", { exact: true }).waitFor();
  await page.waitForFunction(expected => (document.querySelector('[aria-label="任务版本"]') as HTMLSelectElement | null)?.value === expected, id);
}
async function assertSettings(page: Page, mode: Mode, seconds: 15 | 30, notes: string, calls = 32, tokens = 300000) {
  assert.equal(await form(page).mode(mode).getAttribute("aria-pressed"), "true", "新建模式应承接所选任务，而非默认值或其他任务");
  assert.equal(await form(page).seconds(seconds).getAttribute("aria-pressed"), "true", "新建单元容量应承接所选任务");
  assert.equal(await form(page).notes.inputValue(), notes, "创作要求不应丢失或串任务");
  assert.equal(await form(page).calls.inputValue(), String(calls));
  assert.equal(await form(page).tokens.inputValue(), String(tokens));
}
async function flush(page: Page) { await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); }
const choicePanel = (page: Page) => page.getByRole("region", { name: "幻想表达选择", exact: true });
const savedNotice = (page: Page, text: string) => page.getByRole("status").filter({ hasText: text });
function completedRun() {
  const run = savedRun("A", "all", 15);
  run.status = "text_ready_for_review";
  run.adopted = [{ packageIds: ["P1"], stage: "finish", unitCount: 1, shotCount: 1, seconds: 3 }];
  run.assembly = {
    text: '# 完整稿\r\n\r\n【场景：室内】\r\n镜头 1（3秒）\r\n画面：甲说“不。”  \r\n台词：保留  两个空格\n末行不补换行', errors: [], warnings: [],
    draft: { units: [{ id: "U1", title: "站稳", scene: "室内", props: [], participants: ["甲"], lighting: "窗边侧光", initialState: "承压", exitState: "站稳", shots: [{ id: "SH1", duration: 3, camera: "平视近景", picture: "甲站稳", lighting: "窗边侧光", sound: "衣料轻响", transition: "切", sourceRefs: ["S1"], dialogueParts: [{ lineId: "S1", text: "不。", presentation: "对白", delivery: "压低声音", voiceStart: 1, voiceEnd: 2 }] }] }] },
  };
  return run;
}

function speakingRun() {
  const run = completedRun();
  // The authoritative identity is keyed by lineId, not inferred from the scene's participants.
  const dialogue = [
    { id: "D1", speaker: "人物甲", channel: "现场对白", quote: "我还没输。", rowId: "S1", sourceIds: ["S1"] },
    { id: "D2", speaker: "人物乙", channel: "OS", quote: "别再逞强了。", rowId: "S2", sourceIds: ["S2"] },
  ];
  const unit = run.assembly!.draft!.units[0];
  unit.participants = ["人物甲", "人物乙"];
  unit.shots[0].dialogueParts = [...dialogue].reverse().map((line, index) => ({ lineId: line.id, text: line.quote, presentation: line.channel === "OS" ? "内心声" : "对白", delivery: "压低声音", voiceStart: index, voiceEnd: index + 1 }));
  return Object.assign(run, { dialogue });
}

async function main() {
  // Real component + browser; only its HTTP boundary and clipboard are isolated. No Next/database/model process.
  const bundle = await build({
    stdin: { contents: `import {createElement,StrictMode} from "react"; import {createRoot} from "react-dom/client"; import {StoryboardWorkbench} from "./app/projects/[projectId]/episodes/[episodeId]/storyboard/workbench";
      import {StoryboardStatusProvider,StoryboardHeaderStatus} from "./app/projects/[projectId]/episodes/[episodeId]/storyboard/page-status";
      const root = createRoot(document.getElementById("root"));
      window.stage3Mount = (episodeId = "fixture", initialSnapshot, strict = false) => {
        const view=createElement(StoryboardStatusProvider, {key:episodeId, initialRun:initialSnapshot?.run}, createElement("header",null,createElement(StoryboardHeaderStatus)),createElement(StoryboardWorkbench, {episodeId, initialSnapshot, episodeTitle: "隔离验证 " + episodeId, projectId: "fixture-project"}));
        root.render(strict?createElement(StrictMode,null,view):view);
      };
      window.stage3Unmount = () => root.unmount();
      Object.defineProperty(navigator, "clipboard", {configurable: true, value: {writeText: async text => {window.stage3Copied = text;}}});
      window.stage3Mount();`, resolveDir: root, loader: "tsx" },
    bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", loader: { ".css": "empty", ".module.css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent",
  });
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: 'chrome' }) });
  let failed = 0, checked = 0;
  async function fixture() {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(2500);
    const errors: string[] = [], posts: { episode: string; command: Record<string, any> }[] = [], requests: string[] = [], holds: ReturnType<typeof hold>[] = [];
    const runs: Record<string, Run> = { A: savedRun("A", "all", 15), B: savedRun("B", "review", 30) };
    const otherRuns: Record<string, Run> = { Z: savedRun("Z", "off", 30) };
    const config = { savedIndexHold: null as ReturnType<typeof hold> | null, indexHold: null as ReturnType<typeof hold> | null, checkedHold: null as ReturnType<typeof hold> | null, runHold: null as { id: string; gate: ReturnType<typeof hold>; failure?: boolean } | null, postHold: null as ReturnType<typeof hold> | null, failIndex: false, failCreate: false, failChecked: false, checkedSourceStale:false };
    page.on("pageerror", error => errors.push(error.message));
    let closing = false;
    await context.route("**/*", async route => {
      try {
        const request = route.request(), url = new URL(request.url()); requests.push(`${request.method()} ${url.pathname}${url.search}`);
        if (url.origin !== origin) { errors.push(`unexpected network: ${url.origin}`); return await route.abort(); }
        if (url.pathname === "/") return await route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
        if (url.pathname === "/fixture.js") return await route.fulfill({ contentType: "application/javascript", body: bundle.outputFiles[0].text });
        const match = url.pathname.match(/^\/api\/episodes\/(fixture|other)\/storyboard$/);
        if (!match) { errors.push(`unexpected path: ${url.pathname}`); return await route.abort(); }
        const episode = match[1], records = episode === "fixture" ? runs : otherRuns;
        if (request.method() === "POST") {
          const command = request.postDataJSON(); posts.push({ episode, command });
          const gate = config.postHold; config.postHold = null;
          if (gate) await gate.wait();
          if (command.action === "create" && config.failCreate) return await route.abort("failed");
          let run: Run;
          if (command.action === "create") {
            run = records.C = savedRun("C", command.settings.fantasyMode, command.settings.maxUnitSeconds);
            run.status = "created"; run.phase = "created"; run.plan = null; run.selection = null;
            run.directorNotes = command.notes; run.budget = { ...run.budget, maxCalls: command.maxCalls, maxTokens: command.maxTokens };
          } else {
            run = records[command.runId];
            if (command.action === "choice") {
              run.choice = { mode: command.mode, overrides: command.overrides, unitOverrides: command.unitOverrides };
              run.settings.fantasyMode = command.mode; run.selection = resolveSelection(run.plan, run.choice);
            } else if (command.action === "recover") {
              run.status = "planned"; run.operations = run.operations.map(op => ({ ...op, status: "completed", canRecoverSaved: false }));
            } else if (command.action === "acknowledge_cancel") {
              assert.equal(command.acceptUnknownUsage, true);
              run.operations = run.operations.map(op => op.attemptId === command.attemptId ? { ...op, cancelAcknowledgement: { at: "2026-09-27T08:00:00Z", acceptUnknownUsage: true } } : op);
              run.status = "paused"; run.error = null; run.usage.acknowledgedUnknownAttempts = 1;
            } else if (command.action === "start") { run.status = "running"; run.active = true; }
            else if (command.action === "recheck") {
              run.error = {code:'PRODUCTION_FEEDBACK',message:'sharedChoices[0].authority：制作约定必须为DESIGN'};
              if (run.repairControl?.needsRecheck) run.repairControl = {blocked:false,needsRecheck:false,reason:null};
            }
            else { errors.push(`unexpected action: ${command.action}`); return await route.abort(); }
          }
          return await route.fulfill({ status: command.action === "create" ? 201 : 200, json: { run } });
        }
        const id = url.searchParams.get("runId");
        if (!id) {
          const saved = url.searchParams.get('view') === 'saved';
          if (saved && config.savedIndexHold) { const gate = config.savedIndexHold; config.savedIndexHold = null; await gate.wait(); }
          if (!saved && config.indexHold) { const gate = config.indexHold; config.indexHold = null; await gate.wait(); }
          return await route.fulfill(config.failIndex && !saved ? { status: 503, json: { error: "索引暂不可用" } } : { json: { runs: Object.values(records).map(({ id, title, createdAt, status, active }) => ({ id, title, createdAt, status, active })), model: "gpt-6-sol", reasoning: "medium", maxConcurrent: 2, runner: { ready: false, checked:false, message: "隔离验证", timeoutPolicy: { plan: 900000, author: 1800000, finish: 1200000 } }, sourceWarnings: [], preparation: { ready: !saved, ...(saved ? {deferred:true} : {}) } } });
        }
        if(!records[id])return await route.fulfill({status:404,json:{error:'任务不存在'}});
        const run = structuredClone(records[id]), delay = config.runHold?.id === id ? config.runHold : null;
        if (delay) { config.runHold = null; await delay.gate.wait(); }
        if(url.searchParams.get('view')==='saved'){run.sourceCheckPending=false;run.blocked=Boolean(run.sourceStale||run.legacyReadOnly);run.preparation={ready:false,deferred:true};}
        else {
          if(config.checkedSourceStale){run.sourceStale=true;run.blocked=true;}
          const waits:Promise<void>[]=[];
          if(config.checkedHold){const gate=config.checkedHold;config.checkedHold=null;waits.push(gate.wait());}
          if(url.searchParams.get('includeIndex')==='1'&&config.indexHold){const gate=config.indexHold;config.indexHold=null;waits.push(gate.wait());}
          await Promise.all(waits);
        }
        const index=url.searchParams.get('includeIndex')==='1'?{runs:Object.values(records).map(({id,title,status,createdAt,active})=>({id,title,status,createdAt,active})),model:'gpt-6.1-sol',reasoning:'medium',maxConcurrent:4,runner:{ready:false,checked:false,message:'isolated'},sourceWarnings:[],preparation:{ready:!config.failIndex,...(url.searchParams.get('view')==='saved'?{ready:false,deferred:true}:{})}}:undefined;
        return await route.fulfill(delay?.failure || config.failChecked && url.searchParams.get('view')!=='saved' ? { status: 503, json: { error: "资料核对暂不可用" } } : { json: { run,...(index?{index}:{}) } });
      } catch (error) { if (!closing) errors.push(`route failure: ${(error as Error).message}`); }
    });
    return { context, page, runs, otherRuns, config, posts, errors, requests,
      hold: () => { const gate = hold(); holds.push(gate); return gate; },
      open: (runId = 'A') => page.goto(`${origin}/${runId ? '?runId='+runId : ''}`),
      close: async () => { closing = true; holds.forEach(gate => gate.release()); await context.close(); },
    };
  }
  async function check(name: string, runTest: (test: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
    if (process.argv[2] && !name.includes(process.argv[2])) return;
    const test = await fixture(); checked++;
    try { await within(runTest(test), name, 15000); assert.deepEqual(test.errors, []); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${(error as Error).message}`); }
    finally { await test.close(); }
  }
  try {
    await check("切页只读保存稿，不自动重做连接和资料核对", async test => {
      await test.open();await loaded(test.page);await flush(test.page);
      const run={...completedRun(),id:'Z',sourceCheckPending:false,blocked:false,preparation:{ready:false,deferred:true}};
      const seed={episodeId:'other',run,savedAt:Date.now(),index:{runs:[{id:'Z',status:run.status,createdAt:run.createdAt}],model:'gpt-6.1-sol',reasoning:'medium',maxConcurrent:4,runner:{ready:false,checked:false,message:'执行时检查连接'},sourceWarnings:[],preparation:{ready:false,deferred:true}}};
      await test.page.evaluate(snapshot=>(window as any).stage3Mount('other',snapshot,true),seed);await loaded(test.page,'Z');await flush(test.page);
      assert.equal(test.requests.filter(r=>r.startsWith('GET /api/episodes/other/storyboard')).length,0,'已有保存稿切页不能重复启动资料或连接读取');
      assert.equal(await test.page.getByLabel('第三阶段当前步骤',{exact:true}).innerText(),'完整文字稿，等待你审看');
      assert.equal(await test.page.getByText('本机 CLI 尚未就绪',{exact:true}).count(),0,'尚未检测不等于连接失败');
      assert.doesNotMatch(await test.page.getByRole('region',{name:'制作状态',exact:true}).innerText(),/正在核对|正在读取/);
      assert.deepEqual(test.posts,[]);
    });
    await check("已有任务不等浏览器预检，点击连续完成才提交执行校验", async test => {
      await test.open();await loaded(test.page);await flush(test.page);
      const run={...savedRun('Z','off',30),sourceCheckPending:false,blocked:false,preparation:{ready:false,deferred:true}};test.otherRuns.Z=run;
      const seed={episodeId:'other',run,savedAt:Date.now(),index:{runs:[{id:'Z',status:run.status,createdAt:run.createdAt}],model:'gpt-6.1-sol',reasoning:'medium',maxConcurrent:4,runner:{ready:false,checked:false,message:'执行时检查连接'},sourceWarnings:[],preparation:{ready:false,deferred:true}}};
      await test.page.evaluate(snapshot=>(window as any).stage3Mount('other',snapshot),seed);await loaded(test.page,'Z');await flush(test.page);
      assert.deepEqual(test.posts,[]);assert.equal(test.requests.filter(r=>r.startsWith('GET /api/episodes/other/storyboard')).length,0);
      const start=test.page.getByRole('button',{name:/^连续完成本集/});assert.equal(await start.isEnabled(),true);
      await start.click();await savedNotice(test.page,'请求已受理').waitFor();
      assert.deepEqual(test.posts.map(p=>p.command),[{action:'start',runId:'Z',mode:'all'}]);
    });
    await check("有已保存待恢复回包不能被当成无需更新的空闲稿",async test=>{
      await test.open();await loaded(test.page);
      const run={...completedRun(),id:'Z',status:'paused',operations:[{attemptId:'response-saved',stage:'author',packageIds:['P1'],status:'completed',canRecoverSaved:true,createdAt:'2026-10-03T00:00:00Z'}],preparation:{ready:false,deferred:true}};
      test.otherRuns.Z=run;
      const seed={episodeId:'other',run,savedAt:Date.now(),index:{runs:[{id:'Z',status:run.status,createdAt:run.createdAt}],model:'gpt-6.1-sol',reasoning:'medium',maxConcurrent:4,runner:{ready:false,checked:false,message:'执行时检查'},sourceWarnings:[],preparation:{ready:false,deferred:true}}};
      const gate=test.hold();test.config.checkedHold=gate;
      await test.page.evaluate(snapshot=>(window as any).stage3Mount('other',snapshot),seed);
      await within(gate.ready,'待恢复回包状态核对');assert.deepEqual(test.posts,[]);gate.release();
    });
    await check("切页首屏使用保存快照，不清空成果等待重复读取", async test => {
      await test.open(); await loaded(test.page);
      const index = test.hold(), detail = test.hold(); test.config.indexHold = index; test.config.checkedHold = detail;
      const run = { ...completedRun(), id: 'Z', sourceCheckPending: false, blocked: false, preparation: {ready:false,deferred:true} };
      const initialSnapshot = { episodeId:'other', run, index:{runs:[{id:'Z',title:'保存稿Z',status:run.status,createdAt:run.createdAt,active:false}],model:'gpt-6.1-sol',reasoning:'medium',maxConcurrent:4,runner:{ready:false,checked:false,message:'执行时核对'},sourceWarnings:[],preparation:{ready:false,deferred:true}}, savedAt:Date.now() };
      await test.page.evaluate(seed => (window as any).stage3Mount('other', seed), initialSnapshot);
      await loaded(test.page,'Z');await flush(test.page);
      assert.equal(await test.page.getByLabel('第三阶段当前步骤',{exact:true}).innerText(),'完整文字稿，等待你审看');
      await test.page.getByRole('heading',{name:'完整文字稿，等待你审看',exact:true}).waitFor();
      assert.equal(test.requests.filter(r => r.includes('/api/episodes/other/storyboard') && r.includes('view=saved')).length,0,'已有首屏快照不能再清空并重读保存稿');
      assert.equal(test.requests.filter(r=>r==='GET /api/episodes/other/storyboard').length,0,'首屏核对复用一次输入，不能另开列表核对');
      assert.equal(await test.page.getByRole('link',{name:'导出 Markdown',exact:true}).count(),1,'导出入口可见，交付资格由导出端点即时校验');
      assert.deepEqual(test.posts,[]);
      await test.page.getByRole('button',{name:'刷新任务状态',exact:true}).click();await within(index.ready,'手动核对索引');await within(detail.ready,'手动核对资料');
      index.release();detail.release();await flush(test.page);
    });
    await check("直达指定任务不等待列表才能读取保存正文", async test => {
      test.runs.A=completedRun();const index=test.hold();test.config.savedIndexHold=index;
      await test.open();await within(index.ready,'保存列表慢读取');
      await within(test.page.getByRole('heading',{name:'完整文字稿，等待你审看',exact:true}).waitFor(),'正文独立显示',1200);
      assert.deepEqual(test.posts,[]);index.release();await loaded(test.page);
    });
    await check("已完成稿不进行无意义的整套资料定时轮询", async test => {
      await test.page.clock.install();test.runs.A=completedRun();await test.open();await loaded(test.page);
      const before=test.requests.filter(r=>r===`GET ${endpoint}?runId=A`).length;
      await test.page.clock.runFor(17000);await flush(test.page);
      assert.equal(test.requests.filter(r=>r===`GET ${endpoint}?runId=A`).length,before,'完成稿应按焦点、手动刷新或变更核对，不每8秒重读上游');
      assert.deepEqual(test.posts,[]);
    });
    await check("开发模式重复挂载也不重做保存稿资料核对", async test => {
      await test.open();await loaded(test.page);
      test.otherRuns.Z={...completedRun(),id:'Z'};
      const gate=test.hold();test.config.checkedHold=gate;
      const run={...test.otherRuns.Z,sourceCheckPending:false,blocked:false,preparation:{ready:false,deferred:true}};
      const seed={episodeId:'other',run,savedAt:Date.now(),index:{runs:[{id:'Z',status:run.status,createdAt:run.createdAt}],model:'gpt-6.1-sol',reasoning:'medium',maxConcurrent:4,runner:{ready:false,checked:false,message:'执行时核对'},sourceWarnings:[],preparation:{ready:false,deferred:true}}};
      await test.page.evaluate(snapshot=>(window as any).stage3Mount('other',snapshot,true),seed);await loaded(test.page,'Z');await flush(test.page);
      assert.equal(test.requests.filter(r=>r==='GET /api/episodes/other/storyboard?runId=Z&includeIndex=1').length,0,'StrictMode 也不能触发重资料检查');
      assert.equal(await test.page.getByLabel('第三阶段当前步骤',{exact:true}).innerText(),'完整文字稿，等待你审看');
      gate.release();await loaded(test.page,'Z');assert.deepEqual(test.posts,[]);
    });
    await check("版本返回使用已有正文，重资料服务故障不影响阅读", async test => {
      test.runs.A=completedRun();await test.open();await loaded(test.page);
      await test.page.getByLabel('任务版本',{exact:true}).selectOption('B');await loaded(test.page,'B');
      const before=test.requests.filter(r=>r===`GET ${endpoint}?runId=A&view=saved`).length;
      const gate=test.hold();test.config.checkedHold=gate;test.config.failChecked=true;
      await test.page.getByLabel('任务版本',{exact:true}).selectOption('A');await loaded(test.page);await flush(test.page);
      await test.page.getByRole('heading',{name:'完整文字稿，等待你审看',exact:true}).waitFor();
      assert.equal(test.requests.filter(r=>r===`GET ${endpoint}?runId=A&view=saved`).length,before+1,'只做一份轻量状态读取，不重建资料或检测连接');
      assert.equal(test.requests.filter(r=>r===`GET ${endpoint}?runId=A`).length,0);
      assert.equal(await test.page.getByRole('link',{name:'导出 Markdown',exact:true}).count(),1);
      assert.equal(await test.page.getByRole('alert').count(),0);gate.release();
      assert.deepEqual(test.posts,[]);
    });
    await check("返回已有版本轻量接收别处启动的状态，不重建资料",async test=>{
      test.runs.A=completedRun();await test.open();await loaded(test.page);
      await test.page.getByLabel('任务版本',{exact:true}).selectOption('B');await loaded(test.page,'B');
      test.runs.A.active=true;test.runs.A.status='running';
      const gate=test.hold();test.config.checkedHold=gate;
      await test.page.getByLabel('任务版本',{exact:true}).selectOption('A');
      await within(gate.ready,'发现新的执行状态后再核对运行任务');
      assert.equal(await test.page.getByRole('region',{name:'制作状态',exact:true}).getByText('LIVE · 实际作业状态',{exact:true}).count(),1);
      assert.deepEqual(test.posts,[]);gate.release();
    });
    await check("轻量同步接收已记录的源文变更，旧稿仍可阅读", async test => {
      test.runs.A=completedRun();await test.open();await loaded(test.page);await flush(test.page);
      test.runs.A.sourceStale=true;test.runs.A.blocked=true;
      await test.page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await test.page.getByRole('heading',{name:'资料已更新，旧稿仍保留',exact:true}).waitFor();
      assert.equal(await test.page.getByRole('link',{name:'导出 Markdown',exact:true}).count(),0);
      await test.page.getByRole('tab',{name:/^完整分镜/}).click();
      await test.page.getByRole('button',{name:'原始完整稿',exact:true}).click();
      assert.equal(await test.page.locator('.promptDocument').textContent(),test.runs.A.assembly!.text);assert.deepEqual(test.posts,[]);
    });
    await check("慢核对服务不被只读入口调用，完整稿直接显示", async test => {
      test.runs.A = completedRun();
      const index=test.hold(),detail=test.hold();test.config.indexHold=index;test.config.checkedHold=detail;
      await test.open();await loaded(test.page);await flush(test.page);
      await test.page.getByRole('heading',{name:'完整文字稿，等待你审看',exact:true}).waitFor();
      assert.doesNotMatch(await test.page.getByRole('region',{name:'制作状态',exact:true}).innerText(),/核对资料更新/);
      assert.deepEqual(test.posts,[]);assert.equal(test.requests.filter(r=>r.startsWith(`GET ${endpoint}`)&&!r.includes('view=saved')).length,0);
      index.release();detail.release();await loaded(test.page);
    });
    await check("新任务可直接连续完成，也保留只做情绪分析且创建不派单", async test => {
      await test.open();await loaded(test.page);await openSettings(test.page);await form(test.page).create.click();await loaded(test.page,'C');
      assert.deepEqual(test.posts.map(p=>p.command.action),['create']);
      await test.page.getByRole('button',{name:/^连续完成本集/}).click();await savedNotice(test.page,'请求已受理').waitFor();
      assert.deepEqual(test.posts[1].command,{action:'start',runId:'C',mode:'all'});
    });
    await check("无指定任务也先显示保存稿，重复焦点共享轻量状态读取", async test => {
      test.runs.A=completedRun();await test.open('');await loaded(test.page);await flush(test.page);
      const detail=test.hold();test.config.runHold={id:'A',gate:detail};
      await test.page.getByRole('heading',{name:'完整文字稿，等待你审看',exact:true}).waitFor();
      await test.page.evaluate(()=>{for(let i=0;i<4;i++)window.dispatchEvent(new Event('focus'));});await within(detail.ready,'焦点轻量同步');await flush(test.page);
      assert.equal(test.requests.filter(r=>r===`GET ${endpoint}?runId=A&view=saved&includeIndex=1`).length,1,'重复焦点共用轻量读取');
      assert.equal(test.requests.filter(r=>r===`GET ${endpoint}?runId=A`).length,0,'完成稿焦点不装配上游资料');
      assert.deepEqual(test.posts,[]);detail.release();await loaded(test.page);
    });
    await check("显式核对失败仍保留保存稿，但不放行派单或正式交付", async test => {
      test.runs.A=completedRun();test.config.failChecked=true;
      await test.open();await loaded(test.page);await test.page.getByRole('button',{name:'刷新任务状态',exact:true}).click();await test.page.getByRole('alert').filter({hasText:'资料核对暂不可用'}).waitFor();
      await test.page.getByRole('heading',{name:'资料暂不可读，历史仍保留',exact:true}).waitFor();
      await test.page.getByRole('tab',{name:/^完整分镜/}).click();
      const result=test.page.getByRole('region',{name:'完整分镜成果',exact:true});
      await result.getByRole('button',{name:'原始完整稿',exact:true}).click();
      assert.equal(await result.locator('.promptDocument').textContent(),test.runs.A.assembly!.text);
      assert.equal(await result.locator('a[href]').count(),0,'核对失败不能提供正式导出地址');
      assert.equal(await test.page.getByRole('button',{name:/连续完成本集|只做情绪分析|继续制作/}).evaluateAll(elements=>elements.some(e=>!(e as HTMLButtonElement).disabled)),false);
      assert.deepEqual(test.posts,[]);
    });
    for(const cause of ['source','unavailable'])await check(`轻量同步不抹掉已核对的${cause==='source'?'源文变更':'检查失败'}，成功复核才能解除`,async test=>{
      test.runs.A=completedRun();await test.open();await loaded(test.page);
      if(cause==='source')test.config.checkedSourceStale=true;else test.config.failChecked=true;
      await test.page.getByRole('button',{name:'刷新任务状态',exact:true}).click();
      const title=cause==='source'?'资料已更新，旧稿仍保留':'资料暂不可读，历史仍保留';
      await test.page.getByRole('heading',{name:title,exact:true}).waitFor();
      test.config.checkedSourceStale=false;test.config.failChecked=false;
      await test.page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await flush(test.page);await test.page.getByRole('heading',{name:title,exact:true}).waitFor();
      await test.page.getByLabel('任务版本',{exact:true}).selectOption('B');await loaded(test.page,'B');
      await test.page.getByLabel('任务版本',{exact:true}).selectOption('A');await loaded(test.page);await flush(test.page);
      assert.equal(await test.page.getByRole('heading',{name:title,exact:true}).count(),1,'未做当前来源核对的保存读取不能清掉明确阻断');
      assert.equal(await test.page.getByRole('link',{name:'导出 Markdown',exact:true}).count(),0);
      await test.page.getByRole('button',{name:'刷新任务状态',exact:true}).click();
      await test.page.getByRole('heading',{name:'完整文字稿，等待你审看',exact:true}).waitFor();
      assert.equal(await test.page.getByRole('link',{name:'导出 Markdown',exact:true}).count(),1);assert.deepEqual(test.posts,[]);
    });
    await check("模型标签沿用实际历史设置，不把旧任务写成当前模型", async test => {
      for (const legacyReadOnly of [false, true]) {
        test.runs.A.settings.model = "gpt-6-astra"; test.runs.A.settings.reasoning = "high"; test.runs.A.legacyReadOnly = legacyReadOnly;
        const original = JSON.stringify(test.runs.A);
        await test.open(); await loaded(test.page);
        const status = await test.page.getByRole("region", { name: "制作状态", exact: true }).innerText();
        assert.match(status, /GPT-6 Astra.*high/s); assert.doesNotMatch(status, /GPT-6\.1 Sol|中档/);
        assert.match(await test.page.getByLabel("当前任务已保存配置", { exact: true }).innerText(), /GPT-6 Astra.*high/s);
        assert.equal(JSON.stringify(test.runs.A), original); assert.deepEqual(test.posts, []);
      }
    });
    await check("模型标签无任务使用当前默认，缺失历史字段不虚构", async test => {
      delete test.runs.A; delete test.runs.B;
      await test.open(); await form(test.page).panel.waitFor();
      assert.match(await test.page.getByRole("region", { name: "制作状态", exact: true }).innerText(), /GPT-6\.1 Sol.*中档/s);
      test.runs.A = savedRun("A", "all", 15); delete test.runs.A.settings.model; delete test.runs.A.settings.reasoning;
      await test.page.reload(); await loaded(test.page);
      const status = await test.page.getByRole("region", { name: "制作状态", exact: true }).innerText();
      assert.match(status, /未记录模型.*未记录档位/s); assert.doesNotMatch(status, /GPT-6\.1 Sol|中档/);
      assert.deepEqual(test.posts, []);
    });
    await check("旧版只读保留导出，所有旧任务变更入口不可用", async test => {
      test.runs.A=Object.assign(completedRun(),{legacyReadOnly:true,blocked:true,sourceStale:true});
      test.runs.A.operations=[{attemptId:'legacy-unknown',stage:'author',packageIds:['P1'],status:'unknown',createdAt:test.runs.A.createdAt,canRecoverSaved:true}];
      await test.open();await loaded(test.page);
      await test.page.getByRole('heading',{name:'旧版任务 · 只读保留',exact:true}).waitFor();
      const option=await test.page.getByLabel('任务版本',{exact:true}).locator('option[value="A"]').textContent();
      assert.match(option??'',/旧版只读/);
      assert.equal(await test.page.getByRole('button',{name:'检查并恢复已有回包',exact:true}).count(),0);
      const md=test.page.getByRole('link',{name:'导出 Markdown',exact:true});
      assert.match(await md.getAttribute('href')??'',/format=md/);
      await test.page.getByRole('tab',{name:/执行记录/}).click();
      assert.match(await test.page.getByRole('link',{name:'导出完整历史',exact:true}).getAttribute('href')??'',/format=json/);
      await expand(test.page.locator('#stage3-panel-activity'),'当前任务的运行停止线');
      assert.equal(await test.page.getByRole('button',{name:'保存停止线',exact:true}).isDisabled(),true);
      assert.deepEqual(test.posts,[]);
    });
    await check("承接初步状态不冒充实际核对，局部待补保留正确稿", async test => {
      test.runs.A=Object.assign(completedRun(),{production:{boundary:{status:'PRELIMINARY',actualVersion:null,changedKeys:[]},materialNeeds:[{stage:2,target:'仓库门',purpose:'补门与通路功能事实',packageIds:['P1'],sourceRefs:['S1'],blocking:true}],sharedBudget:{maxCalls:40,maxTokens:2000000,calls:7,knownTokens:18000,unknownAttempts:1,inFlight:0,complete:false},pendingRepair:{packageIds:['P1'],reason:'门口站位局部待补',changedKeys:['position']},blocking:true,chainComplete:false,chainMode:'CHAIN'}});
      await test.open();await loaded(test.page);
      const materials=test.page.locator('details[aria-label="承接与按需材料"]'),budget=test.page.locator('details[aria-label="本轮共享预算"]');await materials.waitFor();
      assert.notEqual(await materials.getAttribute('open'),null);assert.notEqual(await budget.getAttribute('open'),null);
      assert.match(await materials.innerText(),/初步承接/);
      assert.match(await materials.innerText(),/门与通路/);
      assert.match(await budget.innerText(),/未知.*1|1.*待核/);
      assert.equal(await test.page.locator('[data-workflow-state="running"]').count(),0);
      assert.equal(await test.page.getByRole('button',{name:/连续完成本集|只做情绪分析|继续制作/}).count(),0);
      assert.deepEqual(test.posts,[]);
    });
    await check("停止线与材料标记并存时明确原因，不自动增额或续跑", async test => {
      const run=test.runs.A;run.status='budget_stop';run.usage.knownTokens=340420;run.usage.totalTokens=340420;
      run.production={boundary:null,materialNeeds:[],sharedBudget:null,pendingRepair:{packageIds:['P1'],reason:'CONSUMED_MATERIAL',changedKeys:[]},blocking:false,chainComplete:false,chainMode:'SINGLE'};
      await test.open();await loaded(test.page);
      const status=await test.page.getByRole('region',{name:'制作状态',exact:true}).innerText();
      assert.match(status,/已到运行停止线/);assert.match(status,/340,420/);assert.match(status,/300,000/);
      const material=await test.page.locator('details[aria-label="承接与按需材料"]').innerText();
      assert.match(material,/制作材料已补充/);assert.doesNotMatch(material,/CONSUMED_MATERIAL/);
      await test.page.getByRole('button',{name:'检查运行停止线',exact:true}).click();
      const activity=test.page.getByRole('tabpanel',{name:/执行记录/});
      await expand(activity,'当前任务的运行停止线');
      assert.equal(await activity.getByLabel('Token 停止线',{exact:true}).inputValue(),'300000');
      assert.equal(await test.page.locator('[data-workflow-state="running"]').count(),0);
      assert.deepEqual(test.posts,[]);
    });
    await check("预算范围区分连续制作链与独立单集任务", async test => {
      test.runs.A.production={boundary:null,materialNeeds:[],sharedBudget:{maxCalls:40,maxTokens:2000000,calls:2,knownTokens:100,unknownAttempts:0,inFlight:0,complete:true},pendingRepair:null,blocking:false,chainComplete:true,chainMode:'CHAIN'};
      await test.open();await loaded(test.page);
      const shared=test.page.locator('details[aria-label="本轮共享预算"]');assert.equal(await shared.getAttribute('open'),null);await shared.locator('summary').click();
      assert.match(await shared.innerText(),/三阶段共用，不按集重新计数/);
      assert.equal(await test.page.locator('details[aria-label="当前任务预算"]').count(),0);
      test.runs.A.production.chainMode='SINGLE';
      await test.page.getByRole('button',{name:'刷新任务状态',exact:true}).click();
      const standalone=test.page.locator('details[aria-label="当前任务预算"]');await standalone.waitFor();if(await standalone.getAttribute('open')===null)await standalone.locator('summary').click();
      assert.match(await standalone.innerText(),/仅显示此任务绑定预算，不代表整轮消耗/);
      const materialDetails=test.page.locator('details[aria-label="承接与按需材料"]');if(await materialDetails.getAttribute('open')===null)await materialDetails.locator('summary').click();
      assert.equal(await test.page.getByRole('link',{name:'连续制作 · 选集与预算',exact:true}).getAttribute('href'),'/projects/fixture-project/production');
      assert.doesNotMatch(await standalone.innerText(),/三阶段共用/);
      assert.equal(await shared.count(),0);assert.deepEqual(test.posts,[]);
    });
    await check("并发排队不冒充执行，取得本机执行位后才亮运行条", async test => {
      const run = test.runs.A;
      run.active = true; run.status = "running";
      run.operations = [{ attemptId: "queued-author", stage: "author", packageIds: ["P1"], status: "running", localPhase: "queued", createdAt: run.createdAt }];
      await test.open(); await loaded(test.page);
      const phase = test.page.locator('[aria-label="制作流程"] [data-workflow-index="1"]');
      assert.equal(await phase.getAttribute("data-workflow-state"), "waiting");
      assert.match(await phase.innerText(), /排队中/);
      assert.match(await test.page.getByLabel("运行状态摘要").innerText(), /排队/);
      assert.equal(await test.page.locator('[data-workflow-state="running"]').count(), 0);
      run.operations[0].localPhase = "executing";
      await test.page.getByRole("button", { name: "刷新任务状态", exact: true }).click();
      await test.page.locator('[data-workflow-index="1"][data-workflow-state="running"]').waitFor();
      assert.match(await test.page.getByLabel("运行状态摘要").innerText(), /本机执行中/);
      assert.deepEqual(test.posts, [], "展示实时排队与执行只读状态");
    });
    await check("顶部与步骤共用实时阶段，等待可解释且计时，不多开读取或派单", async test => {
      const run=test.runs.A;run.active=true;run.status='running';run.plan=null;run.selection=null;
      run.operations=[{attemptId:'live-plan',stage:'plan',packageIds:[],status:'running',localPhase:'executing',createdAt:run.createdAt,execution:{phase:'waiting',startedAt:new Date(Date.now()-65000).toISOString(),lastProgressAt:null}}];
      await test.open();await loaded(test.page);
      const header=test.page.getByLabel('第三阶段当前步骤',{exact:true}),status=test.page.getByRole('region',{name:'制作状态',exact:true});
      await header.getByText('情绪统筹 · 等待首个输出',{exact:true}).waitFor();
      assert.match(await status.innerText(),/CLI.*已启动.*等待首个有效输出/);
      assert.match(await status.innerText(),/当前作业历时.*1分\d{2}秒/s);
      assert.doesNotMatch(await status.innerText(),/本机等待/);
      const current=test.page.locator('[aria-label="制作流程"] article[aria-current="step"]');
      assert.equal(await current.count(),1);assert.match(await current.innerText(),/情绪统筹.*当前步骤/s);
      assert.equal(await current.getAttribute('data-workflow-state'),'waiting');
      assert.equal(await test.page.locator('[data-workflow-state="running"]').count(),0,'waiting does not invent model progress');
      assert.ok(await test.page.evaluate(()=>{const rail=document.querySelector('[aria-label="制作流程"]')!,result=document.querySelector('[role="tablist"]')!;return Boolean(rail.compareDocumentPosition(result)&Node.DOCUMENT_POSITION_FOLLOWING);}),'steps remain above secondary panels');
      const readsBefore=test.requests.length;
      await flush(test.page);await flush(test.page);
      assert.equal(test.requests.length,readsBefore,'publishing header state never creates a second polling stream');
      for(const [stage,phase,label] of [['author','generating','完整主创 · 生成中'],['finish','receiving','统一整编 · 接收回包']] as const){
        run.plan=savedRun('A','all',15).plan;run.operations=[{...run.operations[0],attemptId:stage,stage,packageIds:['P1'],execution:{phase,startedAt:new Date().toISOString(),lastProgressAt:new Date().toISOString()}}];
        await test.page.getByRole('button',{name:'刷新任务状态',exact:true}).click();await header.getByText(label,{exact:true}).waitFor();
        assert.match(await current.innerText(),stage==='author'?/完整主创/:/统一整编/);
      }
      test.runs.A=completedRun();await test.page.getByRole('button',{name:'刷新任务状态',exact:true}).click();
      await header.getByText('完整文字稿，等待你审看',{exact:true}).waitFor();
      assert.equal(await header.getAttribute('data-state'),'complete');assert.equal(await current.count(),0);
      assert.deepEqual(test.posts,[],'all live display transitions are read only');
    });
    await check("超时风险确认必须显式同意，保留旧回执且不能自动继续", async test => {
      const run = test.runs.A;
      run.status = "unknown"; run.error = { code: "TIMEOUT", message: "Request timed out" };
      run.operations = [{ attemptId: "author-timeout", stage: "author", packageIds: ["P1"], status: "unknown", createdAt: run.createdAt, requestOutcome: "UNKNOWN", error: { code: "TIMEOUT", message: "Request timed out" } }];
      run.cancellations = [{ attemptId: "author-timeout", canAcknowledge: true, reason: "本机请求已超时结束，无完整回包；费用仍未知。" }];
      run.usage = { ...run.usage, complete: false, unknownAttempts: 1, acknowledgedUnknownAttempts: 0 };
      const dialogs: string[] = []; let accept = false;
      test.page.on("dialog", async dialog => { dialogs.push(dialog.message()); if (accept) await dialog.accept(); else await dialog.dismiss(); });
      await test.open(); await loaded(test.page);
      const acknowledge = test.page.getByRole("button", { name: "确认超时费用风险", exact: true });
      assert.equal(await acknowledge.count(), 1, "Timeout recovery must have an accurately named risk-confirmation action");
      assert.equal(await test.page.locator('[data-workflow-state="running"]').count(), 0);
      assert.ok((await test.page.locator('[aria-label="制作流程"]').innerText()).includes("超时待核对"));
      await acknowledge.click(); assert.deepEqual(test.posts, [], "Dismissed consent sends nothing");
      accept = true; await acknowledge.click(); await savedNotice(test.page, "已记录风险确认").waitFor();
      assert.equal(test.posts.length, 1); assert.deepEqual(test.posts[0].command, { action: "acknowledge_cancel", runId: "A", attemptId: "author-timeout", acceptUnknownUsage: true });
      assert.ok(dialogs.every(text => /超时/.test(text) && /未知/.test(text) && /不会自动|不自动/.test(text)));
      assert.equal(test.runs.A.operations[0].status, "unknown"); assert.equal((test.runs.A.operations[0].error as { code: string }).code, "TIMEOUT");
      assert.equal(test.runs.A.active, false); assert.equal(test.runs.A.usage.complete, false);
      const continueButton = test.page.getByRole("button", { name: /^继续制作/ }); await continueButton.waitFor();
      assert.equal(test.posts.length, 1, "Acknowledgement must not start a second paid request");
      await continueButton.click(); await savedNotice(test.page, "请求已受理").waitFor();
      assert.deepEqual(test.posts.map(post => post.command.action), ["acknowledge_cancel", "start"]);
    });
    await check("执行诊断显示保存的时限和活动，缺失历史不伪造，过程故障不覆盖响应", async test => {
      const run = test.runs.A;
      run.operations = [
        { attemptId: "legacy", stage: "plan", packageIds: [], status: "unknown", createdAt: run.createdAt, diagnostics: null },
        { attemptId: "responded", stage: "author", packageIds: ["P1"], status: "completed", requestOutcome: "RESPONDED", error: { code: "TIMEOUT", message: "Request timed out" }, usage: { totalTokens: 7 }, createdAt: run.createdAt, diagnostics: { timeoutMs: 1200000, startedAt: run.createdAt, endedAt: "2026-09-27T00:10:00Z", lastActivityAt: "2026-09-27T00:09:59Z", eventCount: 7, stdoutBytes: 1234, stderrBytes: 15, failureCategory: "network" } },
      ];
      await test.open(); await loaded(test.page);
      await test.page.getByRole("tab", { name: /^执行记录/ }).click();
      const activity = test.page.getByRole("tabpanel", { name: /^执行记录/ });
      const observed = activity.locator('article').filter({ hasText: "完整主创" });
      await observed.locator("summary").filter({ hasText: "执行诊断" }).click();
      assert.match(await observed.innerText(), /本次时限\s*20 分钟/);
      assert.match(await observed.innerText(), /已响应/);
      assert.match(await observed.innerText(), /7 Token/);
      assert.doesNotMatch(await observed.innerText(), /未取得完整回包|费用仍待确认|费用仍未知/, "TIMEOUT不能覆盖已响应与已知用量事实");
      assert.match(await observed.innerText(), /事件数\s*7/);
      assert.match(await observed.innerText(), /输出量\s*1234 字节/);
      assert.match(await observed.innerText(), /最后记录的故障.*连接异常/s);
      assert.match(await observed.innerText(), /不代表最终结果/);
      const legacy = activity.locator('article').filter({ hasText: "情绪统筹" });
      await legacy.locator("summary").filter({ hasText: "执行诊断" }).click();
      assert.match(await legacy.innerText(), /历史记录未保存执行诊断/);
      assert.doesNotMatch(await legacy.innerText(), /0 字节|0 分钟|30 分钟/);
      await openSettings(test.page);
      assert.match(await form(test.page).panel.innerText(), /新请求时限.*情绪统筹 15 分钟.*完整主创 30 分钟.*统一整编 20 分钟/s);
      assert.deepEqual(test.posts, [], "查看诊断与时限不派发或改写任务");
    });
    await check("原文紧凑阅读保留原始行号及任务数据，不显示空白占位行", async test => {
      test.runs.A.sourceRows = [{ id: "S0001", text: "  \t" }, { id: "S0002", text: "△甲停下。" }, { id: "S0003", text: "　" }, { id: "S0004", text: "甲：留住  两个空格。" }];
      const original = JSON.stringify(test.runs.A.sourceRows);
      await test.open(); await loaded(test.page);
      const source = test.page.locator("details").filter({ has: test.page.locator("summary").filter({ hasText: "完整原文与稳定位置" }) });
      await source.locator("summary").click();
      assert.deepEqual(await source.locator("code").allTextContents(), ["S0002", "S0004"], "Hidden blank rows must not be renumbered into real source IDs");
      assert.equal(await source.locator("p span").last().textContent(), "甲：留住  两个空格。");
      assert.equal(JSON.stringify(test.runs.A.sourceRows), original);
      assert.deepEqual(test.posts, []);
    });
    await check("初载刷新及A→B切换恢复保存配置；新建草稿不改旧任务", async test => {
      await test.open(); await loaded(test.page); await openSettings(test.page);
      await assertSettings(test.page, "all", 15, "已保存要求 A");
      assert.match(await test.page.getByLabel("当前任务已保存配置").innerText(), /15秒单元档.*全部加入/s);
      await form(test.page).mode("off").click(); await form(test.page).seconds(30).click(); await form(test.page).notes.fill("未保存的新任务要求");
      assert.equal(await choicePanel(test.page).getByRole("button", { name: "全部加入", exact: true }).getAttribute("aria-pressed"), "true");
      const refreshed = test.page.waitForResponse(response => response.url().endsWith("?runId=A&includeIndex=1"));
      await test.page.getByRole("button", { name: "刷新任务状态", exact: true }).click(); await refreshed; await flush(test.page);
      await assertSettings(test.page, "off", 30, "未保存的新任务要求");
      assert.deepEqual(test.posts, [], "修改下一次新建参数不能写入旧任务或启动模型");
      await test.page.reload(); await loaded(test.page); await openSettings(test.page);
      await assertSettings(test.page, "all", 15, "已保存要求 A");
      await test.page.getByLabel("任务版本", { exact: true }).selectOption("B"); await loaded(test.page, "B");
      await assertSettings(test.page, "review", 30, "已保存要求 B", 21, 210000);
      await form(test.page).create.click(); await savedNotice(test.page, "任务已创建").waitFor(); await loaded(test.page, "C");
      assert.deepEqual(test.posts.map(post => post.command), [{ action: "create", settings: { maxUnitSeconds: 30, fantasyMode: "review" }, notes: "已保存要求 B", maxCalls: 21, maxTokens: 210000 }]);
      await test.page.getByRole("button", { name: /^只做情绪分析/ }).click(); await savedNotice(test.page, "请求已受理").waitFor();
      assert.deepEqual(test.posts.map(post => post.command.action), ["create", "start"], "只有显式开始才发送制作请求");
      assert.deepEqual(test.posts[1].command, { action: "start", runId: "C", mode: "next" });
    });
    await check("索引或任务详情未就绪时不能用默认设置抢先创建", async test => {
      const index = test.hold(), detail = test.hold(); test.config.savedIndexHold = index; test.config.runHold = { id: "A", gate: detail };
      const cannotCreate = async () => assert.ok(!await form(test.page).create.count() || await form(test.page).create.isDisabled(), "资料未就绪不得创建");
      await test.open(); await within(index.ready, "索引请求"); await cannotCreate();
      index.release(); await within(detail.ready, "详情请求"); await cannotCreate();
      assert.equal(await test.page.getByLabel("任务版本").isDisabled(), true); assert.deepEqual(test.posts, []);
      detail.release(); await loaded(test.page); await openSettings(test.page);
      await assertSettings(test.page, "all", 15, "已保存要求 A"); assert.equal(await form(test.page).create.isEnabled(), true);
    });
    await check("运行轮询不覆盖编辑中的模式容量要求与新任务预算", async test => {
      test.runs.A.active = true; test.runs.A.status = "running";
      await test.page.clock.install(); await test.open(); await loaded(test.page); await openSettings(test.page);
      await form(test.page).mode("off").click(); await form(test.page).seconds(30).click(); await form(test.page).notes.fill("保留这份草稿");
      await form(test.page).calls.fill("17"); await form(test.page).tokens.fill("440000");
      test.runs.A.usage.totalTokens = 11; test.runs.A.directorNotes = "服务端已保存要求";
      const response = test.page.waitForResponse(response => response.url().endsWith("?runId=A"));
      await test.page.clock.fastForward(2100); await response;
      await test.page.getByRole("region", { name: "制作状态", exact: true }).getByText("11 Token", { exact: true }).waitFor();
      await assertSettings(test.page, "off", 30, "保留这份草稿", 17, 440000);
      assert.match(await test.page.getByLabel("当前任务已保存配置").innerText(), /15秒单元档.*全部加入/s);
      assert.equal(await form(test.page).create.isDisabled(), true, "旧任务仍在运行，编辑草稿不应允许重复创建"); assert.deepEqual(test.posts, []);
    });
    for (const failure of [false, true]) await check(`迟到的旧GET${failure ? "错误" : "成功"}不能污染切换后的任务`, async test => {
      await test.open(); await loaded(test.page); await openSettings(test.page);
      const gate = test.hold(); test.config.runHold = { id: "A", gate, failure };
      await test.page.evaluate(() => window.dispatchEvent(new Event("focus"))); await within(gate.ready, "旧任务同步");
      await test.page.getByLabel("任务版本").selectOption("B"); await loaded(test.page, "B");
      const old = test.page.waitForResponse(response => response.url().endsWith("?runId=A&view=saved&includeIndex=1")); gate.release(); await old; await flush(test.page);
      await assertSettings(test.page, "review", 30, "已保存要求 B", 21, 210000);
      assert.equal(await test.page.getByLabel("任务版本").inputValue(), "B");
      assert.equal(await test.page.getByRole("alert").count(), 0, "旧任务错误不能泄漏到当前任务"); assert.deepEqual(test.posts, []);
    });
    await check("创建双击只发一次；卸载后迟到的POST不更新页面或续读", async test => {
      await test.open(); await loaded(test.page); await openSettings(test.page);
      const gate = test.hold(); test.config.postHold = gate;
      await form(test.page).create.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
      await within(gate.ready, "唯一创建请求");
      assert.equal(test.posts.length, 1); assert.equal(await form(test.page).create.isDisabled(), true);
      await test.page.evaluate(() => (window as any).stage3Unmount()); await flush(test.page);
      const requestCount = test.requests.length;
      const response = test.page.waitForResponse(response => response.request().method() === "POST"); gate.release(); await response; await flush(test.page);
      assert.equal(await test.page.locator("#root").innerHTML(), "");
      assert.equal(test.requests.length, requestCount, "卸载后不能继续刷新旧任务索引"); assert.equal(test.posts.length, 1);
    });
    await check("换集时旧POST不得覆盖新剧集或锁死新操作", async test => {
      await test.open(); await loaded(test.page); await openSettings(test.page);
      const gate = test.hold(); test.config.postHold = gate;
      await form(test.page).create.click(); await within(gate.ready, "等待已发出的创建请求");
      const nextIndex = test.page.waitForResponse(response => response.url() === `${origin}/api/episodes/other/storyboard?view=saved`);
      await test.page.evaluate(() => (window as any).stage3Mount("other")); await nextIndex;
      await loaded(test.page, "Z");
      await openSettings(test.page); await assertSettings(test.page, "off", 30, "已保存要求 Z");
      const newGate = test.hold(); test.config.postHold = newGate;
      await form(test.page).create.click(); await within(newGate.ready, "新剧集独立创建请求");
      const readsBefore = test.requests.filter(request => request === "GET /api/episodes/other/storyboard?runId=Z").length;
      const oldPost = test.page.waitForResponse(response => response.request().method() === "POST" && response.url() === `${origin}${endpoint}`);
      gate.release(); await oldPost; await flush(test.page);
      assert.equal(await test.page.getByLabel("当前任务已保存配置").count(), 1, `新剧集索引与旧POST都已返回，却没有读取新任务：${await test.page.getByRole("region", { name: "制作状态", exact: true }).innerText()}`);
      await loaded(test.page, "Z");
      assert.match(await test.page.getByLabel("当前任务已保存配置").innerText(), /不加额外幻想/);
      assert.equal(new URL(test.page.url()).searchParams.get("runId"), "Z", "旧POST不能改写新剧集URL");
      assert.equal(await form(test.page).create.isDisabled(), true, "旧POST结束不能提前解除新POST的pending");
      await test.page.evaluate(() => window.dispatchEvent(new Event("focus"))); await flush(test.page);
      assert.equal(test.requests.filter(request => request === "GET /api/episodes/other/storyboard?runId=Z").length, readsBefore, "旧POST结束不能释放新请求的busy锁并触发中途同步");
      const newPost = test.page.waitForResponse(response => response.request().method() === "POST" && response.url().includes("/other/"));
      newGate.release(); await newPost; await savedNotice(test.page, "任务已创建").waitFor(); await loaded(test.page, "C");
      await openSettings(test.page); await assertSettings(test.page, "off", 30, "已保存要求 Z");
      assert.equal(await form(test.page).create.isEnabled(), true, "旧请求不得把新剧集留在永久pending");
      assert.deepEqual(test.posts.map(post => [post.episode, post.command.action]), [["fixture", "create"], ["other", "create"]]);
    });
    await check("全部加入可取消待设计单元而保留其他候选，刷新仍有效", async test => {
      test.runs.A = savedRun("A", "all", 15, true); await test.open(); await loaded(test.page);
      const missing = choicePanel(test.page).getByRole("checkbox", { name: /^U2/, includeHidden: true });
      assert.equal(await missing.isChecked(), true); assert.equal(await missing.isEnabled(), true);
      const fingerprint = test.runs.A.selection!.fingerprint;
      await missing.click(); await savedNotice(test.page, "选择已保存").waitFor();
      assert.equal(await missing.isChecked(), false);
      assert.equal(await choicePanel(test.page).getByRole("checkbox", { name: "采用幻想：甲的压力", exact: true }).isChecked(), true);
      assert.deepEqual(test.posts.map(post => post.command), [{ action: "choice", runId: "A", expectedFingerprint: fingerprint, mode: "all", overrides: {}, unitOverrides: { U2: false } }]);
      assert.equal(test.runs.A.selection!.status, "ready"); assert.deepEqual(test.runs.A.selection!.selectedIds, ["F1"]);
      await test.page.reload(); await loaded(test.page); assert.equal(await missing.isChecked(), false);
      test.runs.A.choice.mode = "off"; test.runs.A.settings.fantasyMode = "off";
      test.runs.A.selection = resolveSelection(test.runs.A.plan, test.runs.A.choice);
      await test.page.reload(); await loaded(test.page); assert.equal(await missing.isDisabled(), true);
    });
    await check("未知回包禁用选择及付费动作，只能先做非模型恢复", async test => {
      test.runs.A.status = "unknown";
      test.runs.A.operations = [{ attemptId: "old-call", stage: "author", packageIds: ["P1"], status: "unknown", createdAt: test.runs.A.createdAt, canRecoverSaved: true }];
      test.runs.A.usage = { ...test.runs.A.usage, complete: false, unknownAttempts: 1 };
      await test.open(); await loaded(test.page);
      for (const button of await choicePanel(test.page).getByRole("button").all()) assert.equal(await button.isDisabled(), true);
      assert.equal(await choicePanel(test.page).getByRole("checkbox", { name: "采用幻想：甲的压力", exact: true }).isDisabled(), true);
      assert.equal(await test.page.getByRole("button", { name: /连续完成本集|只做情绪分析|继续制作/ }).count(), 0);
      await openSettings(test.page); assert.equal(await form(test.page).create.isDisabled(), true); assert.deepEqual(test.posts, []);
      const recovery = test.page.getByRole("region", { name: "回包恢复", exact: true });
      assert.match(await recovery.innerText(), /不调用模型/);
      await recovery.getByRole("button", { name: "检查并恢复已有回包", exact: true }).click(); await savedNotice(test.page, "操作已保存").waitFor();
      assert.deepEqual(test.posts.map(post => post.command), [{ action: "recover", runId: "A", attemptId: "old-call" }]);
    });
    await check("完整稿不提供重复付费继续；复制保留原始字节和换行", async test => {
      test.runs.A = completedRun(); await test.open(); await loaded(test.page);
      assert.equal(await test.page.getByRole("button", { name: /连续完成本集|只做情绪分析|继续制作/ }).count(), 0);
      await test.page.getByRole("button", { name: /^审看完整分镜/ }).click();
      const result = test.page.getByRole("region", { name: "完整分镜成果", exact: true });
      await result.getByRole("button", { name: "原始完整稿", exact: true }).click();
      assert.equal(await result.locator(".promptDocument").textContent(), test.runs.A.assembly!.text);
      await result.getByRole("button", { name: "复制完整稿", exact: true }).click(); await savedNotice(test.page, "已复制完整分镜").waitFor();
      assert.equal(await test.page.evaluate(() => (window as any).stage3Copied), test.runs.A.assembly!.text);
      assert.deepEqual(test.posts, []);
    });
    await check("键盘页签与来回切换保留未提交表单草稿", async test => {
      test.runs.A = completedRun(); await test.open(); await loaded(test.page); await openSettings(test.page);
      await form(test.page).mode("off").click(); await form(test.page).seconds(30).click(); await form(test.page).notes.fill("下一份任务草稿");
      await form(test.page).panel.getByRole("button", { name: "收起设置", exact: true }).click();
      const plan = test.page.getByRole("tab", { name: "情绪与幻想", exact: true });
      await plan.focus(); await test.page.keyboard.press("ArrowRight");
      assert.equal(await test.page.getByRole("tab", { name: /^完整分镜/ }).getAttribute("aria-selected"), "true");
      await test.page.keyboard.press("End");
      const activity = test.page.getByRole("tabpanel");
      assert.equal(await test.page.getByRole("tab", { name: /^执行记录/ }).getAttribute("aria-selected"), "true");
      await expand(activity, "当前任务的运行停止线");
      await activity.getByLabel("调用次数停止线", { exact: true }).fill("19");
      await activity.getByLabel("Token 停止线", { exact: true }).fill("490000");
      await expand(activity, "定向返修");
      await activity.getByRole("textbox", { name: /^具体需要改善什么/ }).fill("保留声音，只调整停顿");
      await activity.getByRole("checkbox", { name: /甲/ }).check();
      await test.page.getByRole("tab", { name: /^执行记录/ }).focus(); await test.page.keyboard.press("Home");
      assert.equal(await plan.getAttribute("aria-selected"), "true");
      assert.equal(await plan.evaluate(button => button === document.activeElement), true);
      await test.page.keyboard.press("End");
      await expand(activity, "当前任务的运行停止线");
      assert.equal(await activity.getByLabel("调用次数停止线", { exact: true }).inputValue(), "19");
      assert.equal(await activity.getByLabel("Token 停止线", { exact: true }).inputValue(), "490000");
      await expand(activity, "定向返修");
      assert.equal(await activity.getByRole("textbox", { name: /^具体需要改善什么/ }).inputValue(), "保留声音，只调整停顿", "切换阅读页签不能丢弃尚未提交的返修要求");
      assert.equal(await activity.getByRole("checkbox", { name: /甲/ }).isChecked(), true, "返修范围也应保留");
      await openSettings(test.page); await assertSettings(test.page, "off", 30, "下一份任务草稿"); assert.deepEqual(test.posts, []);
    });
    await check("创建网络结果不明时禁止重复创建，成功核对索引才解锁", async test => {
      test.config.failCreate = true; await test.open(); await loaded(test.page); await openSettings(test.page);
      await form(test.page).create.click(); await savedNotice(test.page, "创建结果尚未确认").waitFor();
      assert.equal(await form(test.page).create.isDisabled(), true);
      await form(test.page).create.evaluate(button => (button as HTMLButtonElement).click()); assert.equal(test.posts.length, 1);
      test.config.failIndex = true;
      const failedIndex = test.page.waitForResponse(response => response.url() === `${origin}${endpoint}` && response.status() === 503);
      await test.page.getByRole("button", { name: "核对已有任务列表", exact: true }).click(); await failedIndex;
      await test.page.getByRole("alert").filter({ hasText: "索引暂不可用" }).waitFor();
      assert.equal(await form(test.page).create.isDisabled(), true, "失败的索引核对不能解除创建不确定态");
      test.config.failIndex = false; const gate = test.hold(); test.config.indexHold = gate;
      await test.page.getByRole("button", { name: "核对已有任务列表", exact: true }).click(); await within(gate.ready, "成功核对前仍等待");
      assert.equal(await form(test.page).create.isDisabled(), true); gate.release();
      await savedNotice(test.page, "任务列表已核对").waitFor(); await loaded(test.page);
      assert.equal(await form(test.page).create.isEnabled(), true); assert.equal(test.posts.length, 1);
      test.config.failCreate = false; await form(test.page).create.click(); await savedNotice(test.page, "任务已创建").waitFor();
      assert.deepEqual(test.posts.map(post => post.command.action), ["create", "create"]);
    });
    await check("回归补充：按单元重新选择能覆盖候选此前的显式反向选择", async test => {
      const actual: boolean[] = [];
      for (const previous of [false, true]) {
        test.runs.A = savedRun("A", "all", 15);
        test.runs.A.choice.overrides = { F1: previous };
        test.runs.A.selection = resolveSelection(test.runs.A.plan, test.runs.A.choice);
        if (previous) await test.page.reload(); else await test.open();
        await loaded(test.page); await expand(choicePanel(test.page), "按初排单元调整");
        const unit = choicePanel(test.page).getByRole("checkbox", { name: /^U1/ });
        assert.equal(await unit.isChecked(), previous, "首先复现候选的显式已保存选择");
        await unit.click(); await savedNotice(test.page, "选择已保存").waitFor();
        actual.push(await choicePanel(test.page).getByRole("checkbox", { name: "采用幻想：甲的压力", exact: true }).isChecked());
      }
      assert.deepEqual(actual, [true, false], "F1=false后勾U1应选中F1；F1=true后取消U1应取消F1");
      assert.deepEqual(test.posts.map(post => post.command.action), ["choice", "choice"], "单元选择不能额外调用制作模型");
    });
    await check("回归补充：单元阅读与分镜表逐句展示lineId对应的权威说话人", async test => {
      const run = speakingRun(); test.runs.A = run;
      await test.open(); await loaded(test.page);
      const result = test.page.getByRole("region", { name: "完整分镜成果", exact: true });
      assert.equal(await result.getByRole("button", { name: "单元阅读", exact: true }).getAttribute("aria-pressed"), "true", "已完成稿默认单元阅读");
      const actual: string[] = [], expected: string[] = [];
      for (const format of ["单元阅读", "分镜表"]) {
        if (format === "分镜表") await result.getByRole("button", { name: format, exact: true }).click();
        for (const line of run.dialogue) {
          // A participants paragraph containing both names must not satisfy this assertion.
          const paragraph = result.locator("p").filter({ hasText: line.quote });
          assert.equal(await paragraph.count(), 1, `${format}每句对白应有唯一可读段落`);
          const text = await paragraph.innerText();
          actual.push(`${format}/${line.id}:${run.dialogue.filter(item => text.includes(item.speaker)).map(item => item.speaker).join("、") || "缺少说话人"}`);
          expected.push(`${format}/${line.id}:${line.speaker}`);
        }
      }
      assert.deepEqual(actual, expected, "必须在每句对白本身标出权威speaker，不能只在人物列表出现");
      assert.deepEqual(test.posts, []);
    });
    await check("回归补充：候选历史完整呈现validation错误与警告而不误报无问题", async test => {
      test.runs.A.candidates = [{ id: "candidate-with-validation", attemptId: "validated-attempt", stage: "author", packageIds: ["P1"], status: "needs_repair", errors: [],
        validation: { errors: [{ code: "ACTION_LANDING", at: "P1/U1/SH1", message: "动作落点缺失", detail: "需要保留抬眼后的停顿" }], warnings: [{ code: "DIALOGUE_TIMING", at: "D2", message: "对白起止时间待核对" }] } }];
      await test.open(); await loaded(test.page); await test.page.getByRole("tab", { name: /^执行记录/ }).click();
      const activity = test.page.getByRole("tabpanel");
      const candidate = activity.locator("details").filter({ has: test.page.locator("summary").filter({ hasText: "完整主创" }) });
      await candidate.locator("summary").click();
      const text = await candidate.innerText();
      assert.deepEqual({ error: text.includes("动作落点缺失"), detail: text.includes("需要保留抬眼后的停顿"), warning: text.includes("对白起止时间待核对"), misleadingEmpty: text.includes("没有记录结构问题") },
        { error: true, detail: true, warning: true, misleadingEmpty: false }, "顶层errors为空时仍须显示validation.errors/warnings，不得显示无问题");
      assert.deepEqual(test.posts, []);
    });
    await check("局部回执修复明确保留正文，不显示成重新统筹", async test => {
      Object.assign(test.runs.A,{active:true,status:'running',operations:[{attemptId:'receipt-only',stage:'plan',packageIds:[],status:'running',createdAt:test.runs.A.createdAt,localPhase:'executing',feedbackRepair:true}]});
      await test.open(); await loaded(test.page);
      await test.page.getByRole('region',{name:'制作状态',exact:true}).getByRole('heading',{name:'局部回执修复 · 本机执行中',exact:true}).waitFor();
      await test.page.getByText(/只修资料回执中的错误字段，不重写/).waitFor();
      await test.page.getByRole('tab',{name:/^执行记录/}).click();
      await test.page.getByRole('tabpanel').locator('strong').filter({hasText:'局部回执修复'}).waitFor();
      assert.deepEqual(test.posts,[],'reading the repair scope never dispatches another model');
    });
    await check("旧笼统修复问题先免费核查，不再反复点击付费继续", async test => {
      Object.assign(test.runs.A,{status:'needs_repair',plan:null,selection:null,error:{code:'REPAIR_NO_PROGRESS',message:'修复无进展'},repairControl:{blocked:false,needsRecheck:true,reason:null},candidates:[{id:'old-receipt',attemptId:'old-plan',stage:'plan',packageIds:[],status:'needs_repair',canRecheck:true}]});
      await test.open();await loaded(test.page);
      assert.equal(await test.page.getByRole('button',{name:/^定向修复并继续/}).count(),0);
      await test.page.getByRole('button',{name:'先核查已有回包 · 不调用模型',exact:true}).click();
      await test.page.getByRole('button',{name:/^定向修复并继续/}).waitFor();
      assert.deepEqual(test.posts.map(p=>p.command.action),['recheck']);
    });
    await check("具体问题重复修复失败后，免费重校也不会重新开放付费重试", async test => {
      Object.assign(test.runs.A,{status:'needs_repair',plan:null,selection:null,error:{code:'REPAIR_NO_PROGRESS',message:'修复无进展'},repairControl:{blocked:true,needsRecheck:false,reason:'NO_PROGRESS'},candidates:[{id:'exact-receipt',attemptId:'repair-plan',stage:'plan',packageIds:[],status:'needs_repair',canRecheck:true}]});
      await test.open();await loaded(test.page);
      await test.page.getByRole('button',{name:'先核查已有回包 · 不调用模型',exact:true}).click();await flush(test.page);
      assert.equal(await test.page.getByRole('button',{name:/^定向修复并继续/}).count(),0);
      assert.deepEqual(test.posts.map(p=>p.command.action),['recheck']);
    });
    assert.ok(checked > 0, "没有匹配的测试");
    assert.equal(failed, 0, `${failed}/${checked} 项第三阶段浏览器行为验证失败`);
    console.log(`PASS: ${checked} 项隔离浏览器检查；未启动Next、数据库、CLI或模型`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
