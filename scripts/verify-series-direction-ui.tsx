import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { chromium, type Route } from "playwright";
import { createSeriesDirectionDraft, confirmSeriesDirection } from "../lib/series-direction";
import type { SeriesDirectionWorkspace } from "../lib/series-direction-service";

assert.ok(existsSync(new URL("../app/projects/[projectId]/series-direction-panel.tsx", import.meta.url)), "方向卡必须有可编辑、可确认的独立面板");
const require = createRequire(import.meta.url);
require.extensions[".css"] = module => { module.exports = {}; };
const { SeriesDirectionPanel } = require("../app/projects/[projectId]/series-direction-panel") as typeof import("../app/projects/[projectId]/series-direction-panel");
const workspace: SeriesDirectionWorkspace = { source: { sourceVersion: "synthetic-v1", episodes: [{ id: "ep1", number: 1, title: "相遇" }], evidence: [{ id: "ep1", kind: "EPISODE", title: "第1集" }], warnings: [], blocker: null }, stateToken: "empty", status: "UNCONFIRMED", draft: null, current: null, draftOrigin: null, draftReviewed: false, draftBrief: null, draftIssue: null, brief: null, permissions: { canEdit: true, canConfirm: true }, generationPlan: { batches: 1, calls: 2, characters: 200, allowed: true, reason: null }, generation: null, history: [] };
let requests = 0;
globalThis.fetch = (async () => { requests++; throw new Error("SSR must never call models or APIs"); }) as typeof fetch;
const render = (view = workspace) => renderToStaticMarkup(createElement(SeriesDirectionPanel, { projectId: "synthetic", initialWorkspace: view }));
const html = render();
for (const field of ["全剧创作方向", "背景标签", "故事机制", "主线标签", "主调", "副调", "观众回报", "表达原则", "避免", "单集弹性", "保存草稿", "确认采用", "AI候选", "尚未确认"]) assert.ok(html.includes(field), `缺少${field}`);
assert.equal(requests, 0); assert.ok(!html.includes("checked="), "read coverage is never pre-checked");
assert.ok(!html.includes('我已实际核对当前全部'),'direction consent must not require claiming the human read every source');
assert.ok(html.includes('我认可当前方向及表达边界'));
assert.ok(!html.includes("textarea name=\"json\""));
assert.ok(!render({ ...workspace, permissions: { canEdit: true, canConfirm: false } }).includes(">确认采用</button>"), "OPERATOR has no confirmation action");
const unknown = render({ ...workspace, generation: { id: "run1", status: "FAILED", createdAt: "2026-09-28T00:00:00.000Z", pending: false, held:true, phase: "evidence", completedCalls: 1, totalCalls: 4, outcome: "UNKNOWN", message: "调用结果待核对", usage: null } });
assert.ok(unknown.includes("结果待核对") && unknown.includes("用量与费用未知"));
assert.ok(!unknown.includes('候选处理中'),'failed held requests must not be rendered as running');
assert.match(unknown, /<button[^>]*>保存草稿<\/button>/, "unknown model result does not lock manual editing");
const knownUsage = { inputTokens: 30, cachedInputTokens: null, uncachedInputTokens: null, outputTokens: 6, reasoningOutputTokens: null, totalTokens: 36, recordedCalls: 2, newRequests: 2, reusedCalls: 0, unknownCalls: 1 };
const metered = render({ ...workspace, generation: { id: "run2", status: "FAILED", createdAt: "2026-09-28T00:00:00.000Z", pending: true, phase: "evidence", completedCalls: 1, totalCalls: 2, outcome: "UNKNOWN", message: "部分用量已返回", usage: knownUsage, callUsage: [{ call: 1, provider: "CLI", usage: { ...knownUsage, recordedCalls: 1, newRequests: 1, unknownCalls: 0 } }] } });
assert.ok(metered.includes("已知 Token 36") && metered.includes("未知调用 1"), "known partial totals and unknown calls must remain distinct");
assert.ok(metered.includes("逐次调用用量") && metered.includes("CLI"));
const panel = readFileSync(new URL("../app/projects/[projectId]/series-direction-panel.tsx", import.meta.url), "utf8");
assert.ok(panel.includes('method: "POST"') && panel.includes("coverageAcknowledged") && panel.includes("stateToken"));
console.log("PASS real direction-panel SSR, field coverage, explicit unchecked consent, permission and unknown-result manual flow");

async function browserChecks() {
  const source = { projectId: "synthetic", sourceVersion: "synthetic-v1", episodeIds: ["ep1"], evidenceIds: ["ep1"] };
  const content = { settingTags: ["都市"], mechanismTags: [], arcTags: [], primaryTone: "历史温情", secondaryTones: [], audiencePromise: "人物成长", expressionRules: [], avoidances: [], episodeFlexibility: "允许单集变化" };
  const historicalDraft = createSeriesDirectionDraft({ id: "direction", revision: 1, sourceVersion: source.sourceVersion, reviewedEpisodeIds: source.episodeIds, evidenceRefs: source.evidenceIds, content }, source);
  const current = confirmSeriesDirection(historicalDraft, source, { id: "old-approval", projectId: source.projectId, sourceVersion: source.sourceVersion, draftHash: historicalDraft.hash, actorId: "old-reviewer", confirmedAt: "2026-09-28T00:00:00.000Z" });
  const draft = createSeriesDirectionDraft({ ...historicalDraft, revision: 2, content: { ...content, primaryTone: "旧草稿" } }, source);
  const initial: SeriesDirectionWorkspace = { ...workspace, stateToken: "token-2", current, draft, status: "CONFIRMED", brief: "当前采用始终保留", draftBrief: "旧草稿", draftOrigin: "HUMAN", draftReviewed: true,
    history: [{ id: "old", title: "历史 v1", createdAt: "2026-09-28T00:00:00.000Z", card: current, brief: "历史温情" }] };
  const bundle = await build({ stdin: { contents: `import React from 'react';import{createRoot}from'react-dom/client';import{SeriesDirectionPanel}from'./app/projects/[projectId]/series-direction-panel';createRoot(document.getElementById('root')).render(<SeriesDirectionPanel projectId="synthetic" initialWorkspace={${JSON.stringify(initial)}}/>);`, resolveDir: process.cwd(), loader: "tsx" }, bundle: true, write: false, outdir: "out", platform: "browser", jsx: "automatic", define: { "process.env.NODE_ENV": '"production"' } });
  const browser = await chromium.launch({ headless: true, ...(existsSync(chromium.executablePath()) ? {} : { channel: "chrome" }) });
  try {
    for (const scenario of ["late-read", "late-post", "history", "preserve", "resume"]) {
      if (process.argv[2] && process.argv[2] !== scenario) continue;
      const page = await browser.newPage();
      let server = structuredClone(initial), heldRead: Route | undefined, heldPost: Route | undefined, latePost: SeriesDirectionWorkspace | undefined;
      if(scenario==='resume')server={...server,generation:{id:'stopped',status:'FAILED',createdAt:'2026-10-01T00:00:00Z',pending:false,held:true,resumable:true,reusableCalls:2,remainingCalls:2,recoveryIssue:null,phase:'evidence',completedCalls:1,totalCalls:12,outcome:'FAILED',message:'引文坐标已核对，可继续已有进度。',usage:{...knownUsage,unknownCalls:0}}};
      const actions: Array<Record<string, unknown>> = [], errors: string[] = [];
      const shouldHoldRead = scenario === "late-read" || scenario === "preserve";
      page.on("pageerror", error => errors.push(error.message));
      await page.route("**/*", async route => {
        if (!new URL(route.request().url()).pathname.endsWith("/series-direction")) return route.fulfill({ contentType: "text/html", body: '<main id="root"></main>' });
        if (route.request().method() === "GET") {
          if (shouldHoldRead && !heldRead) { heldRead = route; return; }
          return route.fulfill({ json: server });
        }
        const command = route.request().postDataJSON(); actions.push(command);
        if(command.action==='resume'){
          assert.equal(scenario,'resume');assert.equal(command.costAcknowledged,true);assert.equal(command.stateToken,server.stateToken);
          server={...server,draft:{...server.draft!,revision:3,hash:'resumed-candidate',content:{...content,primaryTone:'复用回包候选'}},draftOrigin:'AI',draftReviewed:false,generation:{...server.generation!,status:'SUCCEEDED',held:false,resumable:false,reusedCalls:2,phase:'done',completedCalls:2,totalCalls:2,outcome:'SUCCEEDED',message:'候选已保存，未采用。'}};
          return route.fulfill({json:server});
        }
        if (command.action === "generate") {
          server = { ...server, stateToken: "token-ai", draft: { ...server.draft!, revision: 3, hash: "ai-draft", content: { ...content, primaryTone: "较早AI候选" } }, generation: { id: "run", status: "SUCCEEDED", pending: false, createdAt: "2026-09-28T00:00:00.000Z", phase: "done", completedCalls: 2, totalCalls: 2, outcome: "SUCCEEDED", message: "候选已返回", usage: null } };
          latePost = structuredClone(server); heldPost = route; return;
        }
        assert.equal(command.stateToken, server.stateToken, "write must use the latest installed token");
        if (command.action === "save") {
          server = { ...server, stateToken: `token-${actions.length + 3}`, draft: { ...server.draft!, revision: server.draft!.revision + 1, hash: `saved-${actions.length}`, content: command.content, status: "DRAFT", confirmation: null }, draftOrigin: "HUMAN", draftReviewed: command.coverageAcknowledged };
        }
        return route.fulfill({ json: server });
      });
      await page.goto("http://series-ui.invalid/");
      await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text });
      const tone = page.locator("#direction-primaryTone"), save = page.getByRole("button", { name: "保存草稿", exact: true });
      const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if(scenario==='resume'){
        await page.getByRole('button',{name:'刷新状态',exact:true}).click();
        const resume=page.getByRole('button',{name:'继续已保存进度 · 剩余2次',exact:true});await resume.waitFor();
        assert.equal(actions.length,0,'read-only failed status never dispatches');
        assert.equal(await page.getByRole('button',{name:'生成AI候选',exact:true}).isDisabled(),true);
        assert.equal(await page.getByText('候选处理中',{exact:true}).count(),0);
        page.once('dialog',dialog=>dialog.accept());await resume.click();
        await page.getByText('候选已保存，未采用。',{exact:true}).last().waitFor();
        assert.deepEqual(actions.map(command=>command.action),['resume']);
        assert.equal(server.current!.confirmation!.id,'old-approval');
        assert.equal(await page.getByRole('checkbox').isChecked(),false);
        assert.equal(await page.getByRole('button',{name:'确认采用',exact:true}).isDisabled(),true);
      } else if (scenario === "history") {
        await page.locator("summary").filter({ hasText: "版本历史" }).click();
        await page.locator("summary").filter({ hasText: "历史 v1" }).click();
        assert.equal(await page.getByRole("button", { name: "载入为新草稿", exact: true }).count(), 1, "history must offer an explicit draft-only load");
        await page.getByRole("button", { name: "载入为新草稿", exact: true }).click();
        assert.equal(await tone.inputValue(), "历史温情"); assert.equal(actions.length, 0, "loading history is not a mutation or approval");
        assert.equal(await page.getByRole("button", { name: "确认采用", exact: true }).isDisabled(), true);
        assert.equal(await page.getByRole("checkbox").isChecked(), false);
        await page.getByRole("checkbox").check(); await save.click();
        await page.getByText("草稿已保存；当前采用卡没有变化。", { exact: true }).waitFor();
        assert.equal(actions[0].action, "save"); assert.equal(actions[0].confirmation, undefined); assert.equal(actions[0].draftHash, undefined);
        assert.equal(server.current!.confirmation!.id, "old-approval"); assert.equal(server.draft!.confirmation, null);
        assert.ok(server.draft!.revision > current.revision); assert.equal(await page.getByRole("checkbox").isChecked(), false);
      } else {
        if (scenario === "late-post") {
          page.once("dialog", dialog => dialog.accept()); await page.getByRole("button", { name: "生成AI候选", exact: true }).click();
          await page.getByRole("button", { name: "刷新状态", exact: true }).click();
          await page.getByText("已读取最新方向状态。", { exact: true }).waitFor();
        } else await page.getByRole("button", { name: "刷新状态", exact: true }).click();
        await tone.fill(scenario === "preserve" ? "未保存的人工作业" : "已保存的新草稿");
        if (scenario !== "preserve") { await save.click(); await page.getByText("草稿已保存；当前采用卡没有变化。", { exact: true }).waitFor(); }
        if (heldRead) await heldRead.fulfill({ json: initial });
        else { assert.ok(heldPost && latePost); await heldPost.fulfill({ json: latePost }); }
        await settle();
        assert.equal(await tone.inputValue(), scenario === "preserve" ? "未保存的人工作业" : "已保存的新草稿", `${scenario}: late responses must preserve the newest human input`);
        if (scenario !== "preserve") { await save.click(); await page.getByText("草稿已保存；当前采用卡没有变化。", { exact: true }).waitFor(); }
      }
      assert.deepEqual(errors, []); await page.close();
      console.log(`PASS series direction browser ${scenario}; all requests intercepted, no DB/model/network`);
    }
  } finally { await browser.close(); }
}
browserChecks().catch(error => { console.error(error); process.exitCode = 1; });
