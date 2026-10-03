import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { chromium, type Browser } from "playwright";
import { migrateDatabase } from "@/lib/database-migration";
import { createSessionToken, hashSessionToken, hashPassword } from "@/lib/auth-crypto";

async function main() {
  const root = process.cwd(), scratch = await mkdtemp(path.join(tmpdir(), "stage3-web-qa-"));
  const distDir = process.env.NEXT_DIST_DIR;
  assert.ok(distDir && distDir !== ".next" && existsSync(path.join(root, distDir, "BUILD_ID")), "请先使用 NEXT_DIST_DIR 独立构建，再以同一路径运行验收；不能误测旧 .next。");
  const databaseUrl = `file:${path.join(scratch, "qa.db")}`, dataRoot = path.join(scratch, "jobs"), cookieName = "stage3_isolated_qa";
  const budgetRoot = path.join(scratch, "budgets"), workflowRoot = path.join(scratch, "workflows"), archiveRoot = path.join(scratch, "archives");
  const screenshots = path.join(root, "runtime-3008", "stage3-preview", path.basename(scratch));
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  let server: ChildProcess | undefined, browser: Browser | undefined, logs = "";
  const until = async (check: () => Promise<boolean>, label: string, timeout = 15000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
    assert.fail(label);
  };
  try {
    await mkdir(screenshots, { recursive: true });
    await migrateDatabase({ databaseUrl, schemaPath: path.join(root, "prisma/schema.prisma"), quiet: true });
    const user = await db.user.create({ data: { username: "stage3-qa", email: "stage3-qa@localhost.invalid", name: "隔离验收", passwordHash: await hashPassword(createSessionToken()) } });
    const project = await db.project.create({ data: { title: "旧戏院的回声 · 合成验收", style: "3D国漫", aspectRatio: "16:9", roles: { create: { userId: user.id, role: "OPERATOR" } }, episodes: { create: [
      { number: 1, title: "第一集：不退场的人", content: "第1集\n1-1 夜 内 旧戏院\n人物：林岚、程野\n△林岚推开侧门，停在舞台边。\n林岚：（压住颤音）我不是来认输的。\n程野：那就证明给我看。\n△林岚握紧手中的剧本，抬头直视程野。" },
      { number: 2, title: "ＥＰ０２：场灯亮起", content: "第2集\n2-1 夜 内 旧戏院\n人物：林岚\n△林岚看向亮起的舞台。\n林岚：准备好了。" }
    ] } }, include: { episodes: true } });
    const episode = project.episodes.find(item => item.number === 1)!, other = project.episodes.find(item => item.number === 2)!;
    const token = createSessionToken();
    await db.session.create({ data: { userId: user.id, tokenHash: await hashSessionToken(token), expiresAt: new Date(Date.now() + 3600000) } });
    const outsider = await db.user.create({ data: { username: "stage3-outsider", email: "outsider@localhost.invalid", passwordHash: await hashPassword(createSessionToken()) } });
    const outsiderToken = createSessionToken();
    await db.session.create({ data: { userId: outsider.id, tokenHash: await hashSessionToken(outsiderToken), expiresAt: new Date(Date.now() + 3600000) } });

    const controlFile = path.join(scratch, "control.json"), enteredFile = path.join(scratch, "entered.json"), callsFile = path.join(scratch, "calls.jsonl"), fake = path.join(scratch, "fake-codex");
    const calls = async () => (await readFile(callsFile, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; })).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { stage: string; output: string; pid: number });
    const timeoutPolicy = { plan: 15000, author: 5000, finish: 15000 };
    const control = async (holdStage: string, release: boolean, progress = true) => { await writeFile(controlFile + ".tmp", JSON.stringify({ holdStage, release, progress })); await rename(controlFile + ".tmp", controlFile); };
    await control("plan", false, false);
    await writeFile(fake, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv[2]!=='exec'){process.stdout.write('isolated fake CLI\\n');process.exit(0);}
const output=process.argv[process.argv.indexOf('-o')+1],request=JSON.parse(fs.readFileSync(path.join(path.dirname(output),'request.json'),'utf8'));
const marker='【生效设置与本次完整资料】\\n',business=JSON.parse(request.prompt.slice(request.prompt.lastIndexOf(marker)+marker.length).split('\\n')[0]);
const control=${JSON.stringify(controlFile)},entered=${JSON.stringify(enteredFile)},calls=${JSON.stringify(callsFile)};
const emotion={subject:'林岚',contextTone:'不甘与坚定',audienceEffect:'看见她重新夺回主动权',change:'犹豫进场 → 直面质疑 → 主动接下挑战',landing:'抬头直视对方，仍然留在舞台',retain:['原话完整','不增加胜负结果','手中的剧本保持一致']};
const rows=request.source.sourceRows.filter(r=>r.kind!=='metadata'&&r.kind!=='blank'&&r.text.trim()),refs=rows.map(r=>r.id);
let result;
if(request.stage==='plan')result={schemaVersion:'performance-core-v4-plan',unitPackingPolicy:'event-first-v1',emotionArc:'从被动进入旧戏院，到明确表达不退场，再用身体行动接住挑战。',events:[{id:'E1',sourceRefs:refs,sceneKey:'夜 内 旧戏院',boundaryBefore:{kind:'episode_start',reason:'本次制作范围开始'},emotionContract:emotion}],entryFacts:[],workPackages:[{id:'P1',eventId:'E1',sourceRefs:refs,emotionContract:emotion,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'U1',packageId:'P1',sourceRefs:refs,secondsRange:[24,29]}],fantasyCandidates:[{id:'F1',anchorRefs:[refs[1]],subject:'压住颤音，握住自己的决定',emotionPurpose:'把人物从犹豫到坚持的转折变得可见',recommended:true,proposal:'短暂主观化背景的阴影，现实中的手与剧本仍清晰；在抬眼时回到真实戏院。',screenSecondsRange:[2,4],extraSecondsRange:[0,1]},{id:'F2',anchorRefs:[refs.at(-1)],subject:'抬头的瞬间',emotionPurpose:'加强接下挑战的身体落点',recommended:false,proposal:'以尺度反差强化抬头前后的主体变化，不增添现实能力或胜负。',screenSecondsRange:[1,3],extraSecondsRange:[0,1]}]};
else if(request.stage==='author'){
 const shots=rows.map((r,i)=>{const q=request.source.dialogue.find(d=>d.rowId===r.id);return {id:'P1-U1-S'+(i+1),duration:6,camera:i===0?'侧前中全景，随推门动作缓慢跟进':'侧前中近景，轻推至人物视线落定',picture:r.text.replace(/^△/,''),lighting:'侧门冷光保留人物轮廓，舞台暖光维持空间纵深。',sound:q?'现场对白，保留自然气口。':'衣料与脚步环境声。',transition:i===rows.length-1?'动作落定，保持空间连续':'自然直切',sourceRefs:[r.id],dialogueParts:q?[{lineId:q.id,text:q.quote,presentation:'画内',delivery:'按原文语气，完整说出',voiceStart:.5,voiceEnd:5.5}]:[]};});
 result={schemaVersion:'performance-core-v4',units:[{id:'P1-U1',title:'不退场的人',eventId:'E1',boundaryBefore:{kind:'episode_start',reason:'本次源范围开始'},unitDirection:'随推门进入，保留压住颤音的气口；视线先落在剧本上，再抬头直视对方。保持人物与剧本的连续性，不添加胜负结果。',intent:emotion,scene:'夜 内 旧戏院',props:['剧本'],participants:['林岚','程野'],lighting:'侧门冷光与舞台暖光，保持同场连续。',initialState:'林岚由侧门进入，程野在舞台侧。',exitState:'林岚握着剧本直视程野，挑战尚未解决。',shots}],fantasyRealization:[]};
}else if(request.stage==='finish')result=request.finishMode==='delta'?{schemaVersion:'performance-core-v4-delta',baseDraftHash:request.baseDraftHash,retainedUnitIds:business.previousDraft.units.map(u=>u.id),replacements:[],revisionNotes:[],unresolved:[]}:{...business.previousDraft,revisionNotes:[],unresolved:[]};
else process.exit(88);
result.productionFeedback={relation:'INDEPENDENT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]};
process.stdin.resume();process.stdin.on('end',()=>{const call={stage:request.stage,output,pid:process.pid};fs.appendFileSync(calls,JSON.stringify(call)+'\\n');fs.writeFileSync(entered,JSON.stringify(call));process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'isolated-'+process.pid})+'\\n');let progressed=false;const timer=setInterval(()=>{const c=JSON.parse(fs.readFileSync(control,'utf8'));if(c.progress&&!progressed){progressed=true;process.stdout.write(JSON.stringify({type:'item.updated',item:{id:'qa-progress',type:'reasoning',text:'Synthetic execution progress.'}})+'\\n');}if(c.holdStage===request.stage&&!c.release)return;clearInterval(timer);const text=JSON.stringify(result);fs.writeFileSync(output,text);process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:8,output_tokens:2,cached_input_tokens:0}})+'\\n');process.exit(0);},30);});
`, { mode: 0o700 });

    const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, "127.0.0.1", resolve));
    const selectedPort = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
    const base = `http://127.0.0.1:${selectedPort}`;
    server = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(selectedPort)], {
      cwd: root, env: { ...process.env, NEXT_DIST_DIR: distDir, DATABASE_URL: databaseUrl, DIRECTOR_SESSION_COOKIE_NAME: cookieName, DIRECTOR_CREDENTIAL_KEY: createSessionToken(), DIRECTOR_STORYBOARD_DATA_DIR: dataRoot, DIRECTOR_STORYBOARD_ARCHIVE_DIR: archiveRoot, DIRECTOR_PRODUCTION_BUDGET_DIR: budgetRoot, DIRECTOR_PRODUCTION_BUDGET_ID: "", DIRECTOR_PRODUCTION_WORKFLOW_DIR: workflowRoot, DIRECTOR_CODEX_CLI: fake, CODEX_CLI_PATH: fake, DEEPSEEK_API_KEY: "", TYPESAFE_API_KEY: "", DIRECTOR_STORYBOARD_PLAN_TIMEOUT_MS: String(timeoutPolicy.plan), DIRECTOR_STORYBOARD_AUTHOR_TIMEOUT_MS: String(timeoutPolicy.author), DIRECTOR_STORYBOARD_FINISH_TIMEOUT_MS: String(timeoutPolicy.finish) }, stdio: ["ignore", "pipe", "pipe"]
    });
    for (const stream of [server.stdout, server.stderr]) stream?.on("data", chunk => { logs = (logs + chunk.toString()).slice(-40000); });
    await until(async () => { if (server?.exitCode !== null) throw new Error("隔离服务提前退出"); try { return (await fetch(base + "/login")).status === 200; } catch { return false; } }, "隔离服务启动超时", 30000);
    const endpoint = `${base}/api/episodes/${episode.id}/storyboard`, headers = { cookie: `${cookieName}=${token}` };
    const post = (body: unknown, extra: Record<string, string> = {}) => fetch(endpoint, { method: "POST", headers: { ...headers, "content-type": "application/json", "x-storyboard-action": "1", ...extra }, body: JSON.stringify(body) });
    const get = async (id: string, raw = false) => (await fetch(`${endpoint}?runId=${id}${raw ? "&format=json" : ""}`, { headers })).json();
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await fetch(endpoint, { headers: { cookie: `${cookieName}=${outsiderToken}` } })).status, 404);
    assert.equal((await post({ action: "create" }, { origin: "https://outside.invalid" })).status, 403);
    let response = await post({ action: "create", settings: { maxUnitSeconds: 30, fantasyMode: "review" }, maxCalls: 12, maxTokens: 100000 });
    assert.equal(response.status, 201, await response.clone().text());
    let run = (await response.json()).run; const runId = run.id;
    assert.equal(run.operations.length, 0);
    assert.equal((await fetch(`${base}/api/episodes/${other.id}/storyboard?runId=${run.id}`, { headers })).status, 404);

    browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" }) });
    const context = await browser.newContext({ viewport: { width: 1512, height: 1100 }, permissions: ["clipboard-read", "clipboard-write"] });
    await context.addCookies([{ name: cookieName, value: token, url: base, httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors: string[] = []; page.setDefaultTimeout(10000); page.on("pageerror", error => errors.push(error.message));
    const largeTextChecks: { rail: string; cards: number; reachableControls: number; fontSize: string }[] = [];
    const checkLargeText = async (label: string, screenshot: string) => {
      const oldFont = await page.evaluate(() => { const old = document.documentElement.style.fontSize; document.documentElement.style.fontSize = "200%"; return old; });
      try {
        const rail = page.getByRole("region", { name: label, exact: true });
        const cards = await rail.locator("[data-workflow-state]").evaluateAll(elements => elements.map(element => {
          const card = element.getBoundingClientRect(), container = element.closest("section")!.getBoundingClientRect();
          const content = element.firstElementChild!;
          // Animated decorative light is clipped by the card; measure the actual content slot.
          return { contained: card.left >= container.left - 1 && card.right <= container.right + 1, overflow: content.scrollWidth > content.clientWidth + 1,
            contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth };
        }));
        assert.ok(cards.length >= 3, `${label}应使用共享流程卡`);
        await rail.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(screenshots, screenshot), fullPage: false });
        assert.ok(cards.every(card => card.contained && !card.overflow), `${label}在200%字体下流程卡不得横向溢出：${JSON.stringify(cards)}`);
        const controls = await rail.locator("button:not(:disabled), a[href], input:not(:disabled), summary").all();
        if (label === "制作流程") controls.push(page.getByRole("button", { name: /审看完整分镜/ }));
        for (const control of controls) {
          await control.scrollIntoViewIfNeeded(); await control.focus();
          assert.equal(await control.evaluate(element => {
            const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return document.activeElement === element && Boolean(hit && (hit === element || element.contains(hit)));
          }), true, `${label}在200%字体下操作控件须能聚焦且不被遮挡`);
        }
        await rail.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(screenshots, screenshot), fullPage: false });
        largeTextChecks.push({ rail: label, cards: cards.length, reachableControls: controls.length, fontSize: await page.evaluate(() => getComputedStyle(document.documentElement).fontSize) });
      } finally { await page.evaluate(value => { document.documentElement.style.fontSize = value; }, oldFont); }
    };
    const pageUrl = `${base}/projects/${project.id}/episodes/${episode.id}/storyboard?runId=${runId}`;
    await page.goto(pageUrl);
    await page.getByRole("button", { name: /只做情绪分析/ }).waitFor();
    await page.screenshot({ path: path.join(screenshots, "01-ready-to-plan.png"), fullPage: false });
    await page.getByRole("button", { name: /只做情绪分析/ }).click();
    await until(async () => (await readFile(enteredFile, "utf8").then(JSON.parse).catch(() => ({}))).stage === "plan", "假CLI规划未启动");
    await page.getByRole("button", { name: "暂停 · 保留回包", exact: true }).waitFor();
    await until(async () => (await get(runId)).run.operations.some((operation: any) => operation.execution?.phase === "waiting"), "只有生命周期事件时必须显示等待而非生成");
    await until(async () => await page.locator('[data-workflow-state="waiting"]').count() > 0, "等待状态应来自真实CLI生命周期事件");
    assert.equal(await page.locator('[data-workflow-state="running"]').count(), 0, "材质扫光不能被当作生成证据");
    await control("plan", false);
    await until(async () => await page.locator('[data-workflow-state="running"]').count() > 0, "真实派发后流程卡必须显示运行状态");
    assert.equal(await page.locator('[data-workflow-state="running"]').getAttribute("aria-busy"), "true");
    await page.screenshot({ path: path.join(screenshots, "02-running.png"), fullPage: false });
    await control("plan", true);
    await until(async () => { run = (await get(runId)).run; return Boolean(run.plan && !run.active); }, "合成规划未正常采纳");
    await page.getByRole("region", { name: "幻想表达选择", exact: true }).waitFor();
    const choices = page.getByRole("region", { name: "幻想表达选择", exact: true });
    await choices.getByRole("button", { name: "确认本次选择", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "选择已保存" }).waitFor();
    for (const label of ["全部加入", "按推荐加入", "不加额外幻想"]) {
      await choices.getByRole("button", { name: label, exact: true }).click();
      await until(async () => (await get(runId)).run.choice.mode === ({ "全部加入": "all", "按推荐加入": "recommended", "不加额外幻想": "off" } as Record<string, string>)[label], "幻想模式未保存");
    }
    await page.reload(); await choices.waitFor();
    assert.equal(await choices.getByRole("button", { name: "不加额外幻想", exact: true }).getAttribute("aria-pressed"), "true");
    await page.screenshot({ path: path.join(screenshots, "03-plan-and-fantasy.png"), fullPage: false });

    await control("author", false);
    await page.getByRole("button", { name: /连续完成本集/ }).click();
    await until(async () => (await readFile(enteredFile, "utf8").then(JSON.parse).catch(() => ({}))).stage === "author", "假CLI主创未启动");
    await page.getByRole("button", { name: "暂停 · 保留回包", exact: true }).click();
    await control("author", true);
    await until(async () => { run = (await get(runId)).run; return run.status === "paused" && !run.active; }, "暂停未保存回包");
    assert.ok(run.adopted.some((item: any) => item.stage === "author"), JSON.stringify(run.error));
    await page.getByRole("button", { name: /继续制作/ }).waitFor();
    await page.screenshot({ path: path.join(screenshots, "04-paused.png"), fullPage: false });
    await control("", true);
    await page.getByRole("button", { name: /继续制作/ }).click();
    await until(async () => { run = (await get(runId)).run; return run.status === "text_ready_for_review" && !run.active; }, "整编未得到完整文字稿");
    assert.equal(run.operations.length, 3, JSON.stringify(run.error));
    assert.ok(run.assembly?.draft?.units.length);
    await page.getByRole("button", { name: /审看完整分镜/ }).click();
    await page.getByRole("region", { name: "完整分镜成果", exact: true }).waitFor();
    assert.match(await page.getByText("我不是来认输的。", { exact: true }).locator("..").innerText(), /林岚/);
    assert.match(await page.getByText("那就证明给我看。", { exact: true }).locator("..").innerText(), /程野/);
    await page.getByRole("button", { name: "复制完整稿", exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), run.assembly.text);
    response = await fetch(`${endpoint}?runId=${runId}&format=md`, { headers }); assert.equal(response.status, 200); assert.equal(await response.text(), run.assembly.text);
    await page.screenshot({ path: path.join(screenshots, "05-complete-desktop.png"), fullPage: false });
    await page.getByRole("button", { name: "分镜表", exact: true }).click();
    assert.equal(await page.getByRole("table").locator("tbody tr").count(), 4);
    assert.match(await page.getByRole("table").getByText("我不是来认输的。", { exact: false }).last().innerText(), /林岚/);
    await page.screenshot({ path: path.join(screenshots, "06-table-desktop.png"), fullPage: false });
    await page.getByRole("button", { name: "单元阅读", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "窄屏不应横向撑开整页");
    await page.screenshot({ path: path.join(screenshots, "07-complete-mobile.png"), fullPage: false });
    const mainScroll = await page.locator("main").evaluate(element => ({ top: element.scrollTop, height: element.scrollHeight, client: element.clientHeight }));
    await page.mouse.move(300, 650); await page.mouse.wheel(0, 700);
    await until(async () => page.evaluate(() => (document.querySelector("main")?.scrollTop || window.scrollY) > 100), "真实滚轮无法滚动工作区");
    await page.setViewportSize({ width: 1512, height: 1100 });
    await page.getByRole("tab", { name: /执行记录/ }).click();
    assert.equal(await page.getByText("未发送", { exact: true }).count(), 0);
    await checkLargeText("制作流程", "09-stage3-font-200.png");
    await page.goto(`${base}/projects/${project.id}`);
    await page.getByRole("heading", { name: "全剧基础工程", exact: true }).waitFor();
    assert.ok(await page.locator('a[href$="/storyboard"]').count());
    await checkLargeText("资料整理步骤", "10-project-font-200.png");
    const expectedTitles = ["第1集 · 不退场的人", "第2集 · 场灯亮起"];
    assert.deepEqual(await page.locator(".stageThreeEpisodeEntries a").allTextContents(), expectedTitles, "Source heading prefixes should appear only once");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".mobileNav > summary").click();
    const mobileEpisodes = page.locator(".mobileEpisodeList");
    await mobileEpisodes.locator("summary").click();
    assert.deepEqual(await mobileEpisodes.locator("a").allTextContents(), expectedTitles);
    const mobileToggle = await mobileEpisodes.locator("summary").boundingBox(); assert.ok(mobileToggle);
    assert.ok(mobileToggle.width >= 250 && mobileToggle.height <= 60, "Nested episode toggle must not inherit the 40px menu-button dimensions");
    assert.equal(await page.locator(".mobileNav > nav > a").first().evaluate(element => { const rect = element.getBoundingClientRect(); return Boolean(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest(".mobileNav > nav")); }), true, "Mode controls must not cover the open navigation");
    await page.screenshot({ path: path.join(screenshots, "08-mobile-navigation.png"), fullPage: false });
    await page.locator(".mobileNav > summary").click();
    await page.setViewportSize({ width: 1512, height: 1100 });
    await page.goto(`${base}/projects/${project.id}/asset-prompts`);
    await page.locator(".topbarIdentity").getByText("第二阶段 · 资产形象设计", { exact: true }).waitFor();
    assert.deepEqual(errors, []);

    const savedReadTimes:number[]=[];
    for(let i=0;i<3;i++){
      const start=performance.now(),snapshot=await fetch(`${endpoint}?runId=${runId}&view=saved`,{headers});
      assert.equal(snapshot.status,200);const saved=(await snapshot.json()).run;
      savedReadTimes.push(Math.round(performance.now()-start));
      assert.equal(saved.sourceCheckPending,true);assert.equal(saved.blocked,true);
      assert.equal(saved.assembly.text,run.assembly.text);
    }
    response=await post({action:'create',settings:{maxUnitSeconds:30,fantasyMode:'off'},maxCalls:8,maxTokens:100000});
    assert.equal(response.status,201,await response.clone().text());const continuous=(await response.json()).run;
    assert.equal(continuous.operations.length,0);
    await page.goto(`${base}/projects/${project.id}/episodes/${episode.id}/storyboard?runId=${continuous.id}`);
    await page.getByRole('button',{name:/^连续完成本集/}).click();
    await until(async()=>{run=(await get(continuous.id)).run;return run.status==='text_ready_for_review'&&!run.active;},'新任务的一次连续执行应完成统筹、主创和整编');
    assert.deepEqual(run.operations.map((op:any)=>op.stage),['plan','author','finish']);
    assert.deepEqual((await calls()).map(call=>call.stage),['plan','author','finish','plan','author','finish']);
    const continuousEvidence={runId:continuous.id,savedReadTimes,stages:run.operations.map((op:any)=>op.stage),complete:!!run.assembly?.text};
    const callsBeforeTimeout = await calls(); assert.equal(callsBeforeTimeout.length, 6);
    response = await post({ action: "create", settings: { maxUnitSeconds: 30, fantasyMode: "off" }, maxCalls: 8, maxTokens: 100000 });
    assert.equal(response.status, 201, await response.clone().text());
    const timeoutRunId = (await response.json()).run.id;
    assert.deepEqual((await (await fetch(endpoint, { headers })).json()).runner.timeoutPolicy, timeoutPolicy);
    response = await post({ action: "start", runId: timeoutRunId, mode: "next" });
    assert.equal(response.status, 202, await response.clone().text());
    await until(async () => { run = (await get(timeoutRunId)).run; return Boolean(run.plan && !run.active); }, "超时场景的原方案未完成");
    const planned = await get(timeoutRunId, true);
    assert.deepEqual(planned.operations.map((op: any) => op.stage), ["plan"]);
    await control("author", false);
    response = await post({ action: "start", runId: timeoutRunId, mode: "all" });
    assert.equal(response.status, 202, await response.clone().text());
    await until(async () => { run = (await get(timeoutRunId)).run; return run.status === "unknown" && !run.active; }, "作者短时限未形成已结束的未知费用状态");
    const timedOut = await get(timeoutRunId, true), timedOperation = timedOut.operations.at(-1), attemptId = timedOperation.attemptId;
    assert.equal(timedOut.web.stopped, false, "超时确认不能要求先点击立即中断");
    assert.deepEqual(timedOut.plan, planned.plan);
    assert.equal(timedOperation.stage, "author"); assert.equal(timedOperation.status, "unknown");
    assert.equal(timedOperation.error.code, "TIMEOUT"); assert.equal(timedOperation.error.requestOutcome, "UNKNOWN");
    assert.match(timedOperation.error.message, /超时/);
    assert.deepEqual(timedOperation.receipt.usage, { inputTokens: null, cachedInputTokens: null, outputTokens: null, totalTokens: null });
    const timeoutView = run.operations.find((op: any) => op.attemptId === attemptId);
    assert.equal(timeoutView.requestOutcome, "UNKNOWN"); assert.equal(timeoutView.diagnostics.timeoutMs, timeoutPolicy.author);
    assert.equal(timeoutView.diagnostics.failureCategory, "timeout"); assert.ok(timeoutView.diagnostics.endedAt);
    await until(async () => { run = (await get(timeoutRunId)).run; return run.cancellations.find((item: any) => item.attemptId === attemptId)?.canAcknowledge === true; }, "本地退出和免费回填完成后，超时应可确认风险");
    const receiptFile = path.join(dataRoot, "attempts", attemptId, "receipt.json"), receiptBefore = await readFile(receiptFile, "utf8"), receipt = JSON.parse(receiptBefore);
    assert.equal(receipt.state, "FINAL"); assert.equal(receipt.requestOutcome, "UNKNOWN"); assert.equal(receipt.errorCode, "TIMEOUT");
    assert.deepEqual(receipt.usage, timedOperation.receipt.usage); assert.ok(receipt.localProcess.exitedAt);
    assert.throws(() => process.kill(receipt.localProcess.pid, 0), { code: "ESRCH" }, "本地CLI进程必须确已退出");
    for (const name of ["raw.txt", "event-final.txt"]) assert.equal((await readFile(path.join(dataRoot, "attempts", attemptId, name), "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; })).trim(), "", "超时场景不得存在可恢复正文");
    const callsAfterTimeout = await calls();
    assert.deepEqual(callsAfterTimeout.slice(callsBeforeTimeout.length).map(call => call.stage), ["plan", "author"]);
    for (let i = 0; i < 3; i++) {
      const readOnly = (await get(timeoutRunId)).run;
      assert.equal(readOnly.status, "unknown"); assert.equal(readOnly.active, false); assert.equal(readOnly.operations.length, 2);
      assert.deepEqual(await calls(), callsAfterTimeout, "GET不得派单");
    }
    response = await post({ action: "start", runId: timeoutRunId, mode: "all" });
    assert.equal(response.status, 409, "未确认的未知费用必须阻止续跑");
    for (const consent of [{}, { acceptUnknownUsage: false }]) {
      response = await post({ action: "acknowledge_cancel", runId: timeoutRunId, attemptId, ...consent });
      assert.equal(response.status, 400, await response.clone().text());
    }
    const refused = await get(timeoutRunId, true);
    assert.deepEqual(refused.operations, timedOut.operations, "拒绝操作不得改变已保存调用");
    assert.deepEqual(refused.plan, timedOut.plan, "拒绝操作不得改变已保存方案");
    assert.deepEqual(await calls(), callsAfterTimeout);
    await control("", true);
    response = await post({ action: "acknowledge_cancel", runId: timeoutRunId, attemptId, acceptUnknownUsage: true });
    assert.equal(response.status, 200, await response.clone().text());
    run = (await response.json()).run;
    assert.equal(run.status, "paused"); assert.equal(run.active, false); assert.equal(run.error, null);
    assert.equal(run.usage.complete, false); assert.equal(run.usage.unknownAttempts, 1); assert.equal(run.usage.acknowledgedUnknownAttempts, 1);
    assert.equal(run.production.sharedBudget.unknownAttempts, 1, "确认风险不能抹去共享未知用量");
    await page.goto(`${base}/projects/${project.id}/episodes/${episode.id}/storyboard?runId=${timeoutRunId}`);
    await page.getByText("本轮共享预算有未知用量，先恢复核对回执", { exact: false }).first().waitFor();
    await page.getByRole("button", { name: "检查运行停止线", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: /继续制作|连续完成本集|只做情绪分析/ }).evaluateAll(elements => elements.some(element => !(element as HTMLButtonElement).disabled)), false, "未知用量仍应关闭付费入口");
    for (let i = 0; i < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      const paused = (await get(timeoutRunId)).run;
      assert.equal(paused.status, "paused"); assert.equal(paused.active, false); assert.equal(paused.operations.length, 2);
      assert.deepEqual(await calls(), callsAfterTimeout, "费用确认及后续GET不能自动续跑");
    }
    const acknowledged = await get(timeoutRunId, true), acknowledgedOperation = acknowledged.operations.find((op: any) => op.attemptId === attemptId);
    const { cancelAcknowledgement, ...preservedOperation } = acknowledgedOperation;
    assert.equal(cancelAcknowledgement.acceptUnknownUsage, true); assert.equal(cancelAcknowledgement.reason, "TIMEOUT");
    assert.deepEqual(preservedOperation, timedOperation); assert.deepEqual(acknowledged.plan, planned.plan);
    assert.deepEqual(acknowledged.operations[0], planned.operations[0]); assert.equal(await readFile(receiptFile, "utf8"), receiptBefore);
    response = await post({ action: "start", runId: timeoutRunId, mode: "all" });
    assert.ok([202, 409].includes(response.status), await response.clone().text());
    await until(async () => { run = (await get(timeoutRunId)).run; return !run.active; }, "共享未知费用应在派发前停止");
    const blocked = await get(timeoutRunId, true), completedCalls = await calls();
    assert.deepEqual(completedCalls, callsAfterTimeout, "即使绕过禁用按钮直接请求，未知用量也不能再调用CLI");
    assert.deepEqual(blocked.plan, planned.plan); assert.deepEqual(blocked.operations[0], planned.operations[0]);
    assert.deepEqual(blocked.operations.find((op: any) => op.attemptId === attemptId), acknowledgedOperation);
    assert.equal(await readFile(receiptFile, "utf8"), receiptBefore, "预算拦截后原始超时回执仍须逐字保留");
    assert.equal(run.production.sharedBudget.unknownAttempts, 1); assert.equal(run.production.sharedBudget.calls, 2);
    assert.equal(run.usage.complete, false); assert.equal(run.usage.acknowledgedUnknownAttempts, 1); assert.equal(run.usage.knownTokens, 10);
    assert.equal(run.assembly, null);
    const timeoutEvidence = { runId: timeoutRunId, attemptId, timeoutPolicy, receiptFile, acknowledgedWithoutDispatch: true, sharedUnknownBlocksDispatch: true, stages: blocked.operations.map((op: any) => op.stage), preservedUnknownUsage: blocked.operations[1].receipt.usage, finalUsage: run.usage, sharedBudget: run.production.sharedBudget };

    const original = episode.content;
    await db.episode.update({ where: { id: episode.id }, data: { content: original + "\n△合成资料版本变化。" } });
    const stale = (await get(runId)).run; assert.equal(stale.sourceStale, true);
    assert.equal((await fetch(`${endpoint}?runId=${runId}&format=md`, { headers })).status, 409);
    assert.equal((await fetch(`${endpoint}?runId=${runId}&format=json`, { headers })).status, 200);
    await db.episode.update({ where: { id: episode.id }, data: { content: original } });
    await writeFile(path.join(screenshots, "evidence.json"), JSON.stringify({ scope: "隔离SQLite＋真实Next/HTTP/浏览器＋本地假CLI，非真实生产质量", checks: ["auth", "cross-account", "cross-episode", "same-origin", "create", "four-modes", "plan", "author", "pause-save-resume", "delta-finish", "copy-export", "source-stale", "desktop-mobile-scroll", "font-200-workflow-rails", "event-based-waiting-and-generating", "author-timeout", "read-only-poll", "explicit-unknown-usage-consent", "acknowledge-without-dispatch", "shared-unknown-blocks-paid-dispatch", "preserve-plan-receipt-unknown-usage", "saved-snapshot", "continuous-from-created"], fakeCliCalls: completedCalls.length, productionModelCalls: 0, browserErrors: errors, mainScroll, largeTextChecks, continuousEvidence, timeoutEvidence, scratch, distDir, isolatedDirectories: { dataRoot, budgetRoot, workflowRoot, archiveRoot } }, null, 2));
    console.log(JSON.stringify({ status: "PASS", fakeCliCalls: completedCalls.length, productionModelCalls: 0, screenshots, scratch, continuousEvidence, timeoutEvidence }));
  } catch (error) {
    await writeFile(path.join(scratch, "server.log"), logs);
    const page = browser?.contexts()[0]?.pages()[0];
    if (page) { await writeFile(path.join(scratch, "page.txt"), await page.locator("body").innerText().catch(() => "")); await page.screenshot({ path: path.join(scratch, "failure.png"), fullPage: true }).catch(() => {}); }
    console.error((error as Error).stack); console.error(`隔离证据保留：${scratch}`); process.exitCode = 1;
  } finally {
    await browser?.close();
    if (server?.pid && server.exitCode === null) { server.kill("SIGTERM"); await Promise.race([new Promise(resolve => server!.once("exit", resolve)), new Promise(resolve => setTimeout(resolve, 2000))]); if (server.exitCode === null) server.kill("SIGKILL"); }
    await db.$disconnect();
  }
}
void main().catch(error => { console.error((error as Error).message); process.exitCode = 1; });
