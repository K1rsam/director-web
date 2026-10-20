import assert from "node:assert/strict";
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import path from 'node:path';
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
assert.ok(html.includes('系统呈现'), 'the actual direction panel must expose optional system presentation choices');
for (const field of ["全剧创作方向", "背景标签", "故事机制", "主线标签", "主调", "副调", "观众回报", "表达原则", "避免", "单集弹性", "保存草稿", "确认采用", "AI候选", "尚未确认", '情绪强度', '镜头速度', '额外幻想密度', '建议／选择依据', '未设置 · 沿用既有口径']) assert.ok(html.includes(field), `缺少${field}`);
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
    for (const scenario of ["late-read", "late-post", "history", "preserve", "resume", "shared-reading", 'expression-preferences', 'expression-candidate', 'expression-invalid', 'system-presentation', 'system-invalid', 'system-save-failure', 'system-candidate', 'system-history', 'system-alternative', 'system-source-explicit', 'system-source-mixed-unknown', 'system-record-source']) {
      if (process.argv[2] && process.argv[2] !== scenario && !(process.argv[2] === '--systems' && scenario.startsWith('system-'))) continue;
      const page = await browser.newPage();
      let server = structuredClone(initial), heldRead: Route | undefined, heldPost: Route | undefined, latePost: SeriesDirectionWorkspace | undefined;
      if (scenario === 'shared-reading' || scenario === 'expression-candidate' || scenario === 'system-candidate' || scenario === 'system-alternative') server = { ...server, current: null, status: 'UNCONFIRMED', brief: null, draftOrigin: 'AI', draftReviewed: false, draftCanConfirm: true,
        foundationPreparation: { status: 'CANDIDATE_READY', coveredEpisodes: 1, totalEpisodes: 1, extraCalls: 0, message: '第一阶段共用读取已生成候选，没有额外调用。' } };
      const expressionPreferences = { emotion: 'HEIGHTENED' as const, camera: 'DYNAMIC_FAST' as const, fantasy: 'RICH' as const, rationale: '反差喜剧适合更大胆的表演，伤痛仍保留重量。' };
      if (scenario === 'expression-candidate') server.draft = { ...server.draft!, content: { ...server.draft!.content, expressionPreferences } };
      const systemPresentation = { systems: [{ id: 'guide', identity: '引导系统', mode: 'SPRITE' as const, carrierNotes: '同一原提示时以小光点悬停，提示结束后收起', sourceEvidence: [{ evidenceId: 'ep1', quote: '系统：任务开始。' }], sourceCarrier: null, visibility: 'AUDIENCE_ONLY' as const, audibility: 'SOURCE_ONLY' as const, contact: 'NO_ADDED_CONTACT' as const, originalVoice: 'PRESERVE_SOURCE' as const, screenText: 'NO_ADDED_TEXT' as const, rationale: '提示有固定声源，载体只给观众看。', options: [{ mode: 'SPRITE' as const, description: '发出同一“任务开始”时光点悬停，甲仍按原声停步，不让旁人看见。' }, { mode: 'VOICE_ONLY' as const, description: '同一“任务开始”保持系统音，以甲原有停步接收，不另造图片。' }] }] };
      if (scenario === 'system-candidate' || scenario === 'system-alternative') server.draft = { ...server.draft!, content: { ...server.draft!.content, systemPresentation } };
      if (scenario.startsWith('system-source-')) {
        const explicit = { ...systemPresentation.systems[0], mode: 'PRESERVE_SOURCE' as const, sourceCarrier: { mode: 'MIXED' as const, evidenceId: 'ep1', quote: '金色光幕上浮现卡通脸。' }, visibility: 'SOURCE_ONLY' as const, rationale: '原文明示，直接沿用；不授权额外角色或声道。' };
        server.draft = { ...server.draft!, content: { ...server.draft!.content, systemPresentation: { systems: [explicit, ...(scenario === 'system-source-mixed-unknown' ? [{ ...systemPresentation.systems[0], id: 'judge', identity: '裁决系统' }] : [])] } } };
      }
      if (scenario === 'system-history') server.history = [{ ...server.history[0], card: { ...current, content: { ...current.content, systemPresentation } } }];
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
          if (scenario === 'system-save-failure' && actions.length === 1) return route.fulfill({ status: 409, json: { code: 'DIRECTION_SYSTEM_EVIDENCE', error: '系统锚点不在原文中，请核对；原输入保留。' } });
          server = { ...server, stateToken: `token-${actions.length + 3}`, draft: { ...server.draft!, revision: server.draft!.revision + 1, hash: `saved-${actions.length}`, content: command.content, status: "DRAFT", confirmation: null }, draftOrigin: "HUMAN", draftReviewed: command.coverageAcknowledged };
          if (scenario !== 'expression-preferences') assert.equal(Object.hasOwn(command.content, 'expressionPreferences'), false, 'editing a legacy card must not acquire a new default');
        }
        return route.fulfill({ json: server });
      });
      await page.goto("http://series-ui.invalid/");
      await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith(".js"))!.text });
      const css = bundle.outputFiles.find(file => file.path.endsWith('.css')); if (css) await page.addStyleTag({ content: css.text });
      const tone = page.locator("#direction-primaryTone"), save = page.getByRole("button", { name: "保存草稿", exact: true });
      const settle = () => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
      if (scenario.startsWith('system-')) {
        const confirm = page.getByRole('button', { name: '确认采用', exact: true });
        if (scenario.startsWith('system-source-')) {
          await page.getByRole('button', { name: '刷新状态', exact: true }).click();
          await page.getByText('已读取最新方向状态。', { exact: true }).waitFor();
          assert.match(await page.locator('[data-system-source-retained="guide"]').innerText(), /原文明示，直接沿用/);
          assert.match(await page.locator('[data-system-source-retained="guide"]').innerText(), /金色光幕上浮现卡通脸。/);
          assert.match(await page.locator('[data-system-source-retained="guide"]').innerText(), /ep1/);
          assert.equal(await page.getByRole('combobox', { name: '呈现方案', exact: true }).count(), scenario === 'system-source-mixed-unknown' ? 1 : 0, 'source-explicit carrier must not reopen a selection menu; unresolved identity stays editable');
          assert.equal(await page.getByRole('checkbox').isChecked(), false, 'source retention is not an invented overall confirmation');
          assert.deepEqual(actions, [], 'displaying the current form is read-only');
          await page.getByRole('checkbox').check(); await confirm.click();
          assert.deepEqual(actions.map(item => item.action), ['confirm'], 'only the existing overall direction confirmation is required');
          assert.equal(server.draft!.content.systemPresentation!.systems[0].mode, 'PRESERVE_SOURCE');
        } else if (scenario === 'system-candidate' || scenario === 'system-alternative') {
          await page.getByRole('button', { name: '刷新状态', exact: true }).click();
          await page.getByText('第一阶段共用读取已生成候选，没有额外调用。', { exact: true }).waitFor();
          assert.equal(await page.locator('#system-0-mode').inputValue(), 'SPRITE');
          assert.equal(await page.locator('#system-0-source-0-quote').inputValue(), '系统：任务开始。');
          assert.equal(actions.length, 0, 'displayed Q1 suggestion is not adoption');
          if (scenario === 'system-alternative') {
            await page.locator('#system-0-mode').selectOption('VOICE_ONLY');
            assert.equal(await page.locator('#system-0-carrier').inputValue(), systemPresentation.systems[0].options[1].description, 'selecting a concrete alternative uses its actual treatment');
            await page.getByRole('checkbox').check(); await save.click();
            await page.getByText('草稿已保存；当前采用卡没有变化。', { exact: true }).waitFor();
          }
          await page.getByRole('checkbox').check(); await confirm.click();
          assert.deepEqual(actions.map(item => item.action), scenario === 'system-alternative' ? ['save', 'confirm'] : ['confirm']);
        } else if (scenario === 'system-history') {
          await page.getByRole('button', { name: '刷新状态', exact: true }).click();
          await page.getByText('已读取最新方向状态。', { exact: true }).waitFor();
          await page.locator('summary').filter({ hasText: '版本历史' }).click();
          await page.locator('summary').filter({ hasText: '历史 v1' }).click();
          await page.getByRole('button', { name: '载入为新草稿', exact: true }).click();
          assert.equal(await page.locator('#system-0-mode').inputValue(), 'SPRITE');
          assert.equal(await page.getByRole('checkbox').isChecked(), false);
          assert.equal(await confirm.isDisabled(), true); assert.equal(actions.length, 0);
          await page.getByRole('checkbox').check(); await save.click();
          await page.getByText('草稿已保存；当前采用卡没有变化。', { exact: true }).waitFor();
          assert.equal(server.draft!.content.systemPresentation!.systems[0].id, 'guide');
          assert.equal(server.current!.confirmation!.id, 'old-approval');
        } else {
          await page.locator('summary').filter({ hasText: '系统呈现' }).click();
          await page.getByRole('button', { name: '添加有源系统', exact: true }).click();
          await page.locator('#system-0-identity').fill('引导系统');
          await page.locator('#system-0-source-0-evidence').selectOption('ep1');
          await page.locator('#system-0-source-0-quote').fill('系统：任务开始。');
          await page.getByRole('checkbox').check();
          await page.locator('#system-0-mode').selectOption('SPRITE');
          assert.equal(await page.getByRole('checkbox').isChecked(), false, 'system edit clears approval');
          assert.equal(await confirm.isDisabled(), true);
          await page.locator('#system-0-carrier').fill(systemPresentation.systems[0].carrierNotes);
          await page.locator('#system-0-visibility').selectOption('AUDIENCE_ONLY');
          if (scenario === 'system-record-source') {
            await page.locator('#system-0-source-mode').selectOption('SPRITE');
            await page.locator('#system-0-source-carrier-evidence').selectOption('ep1');
            await page.locator('#system-0-source-carrier-quote').fill('系统：任务开始。');
            assert.equal(await page.locator('#system-0-source-carrier-quote').inputValue(), '系统：任务开始。', 'entering a same-carrier source must not collapse the active editor mid-edit');
          }
          if (scenario === 'system-invalid') {
            await page.locator('#system-0-source-mode').selectOption('VOICE_ONLY');
            await page.locator('#system-0-source-carrier-evidence').selectOption('ep1');
            await page.locator('#system-0-source-carrier-quote').fill('系统没有实体。');
            await save.click();
            await page.getByRole('alert').filter({ hasText: '源载体冲突' }).waitFor();
            assert.equal(actions.length, 0); assert.equal(await save.isEnabled(), true);
            assert.equal(await page.locator('#system-0-mode').inputValue(), 'SPRITE');
            await page.locator('#system-0-source-mode').selectOption('');
          }
          await page.getByRole('checkbox').check(); await save.click();
          if (scenario === 'system-save-failure') {
            await page.getByRole('alert').filter({ hasText: '锚点不在原文' }).waitFor();
            assert.equal(await page.locator('#system-0-source-0-quote').inputValue(), '系统：任务开始。');
            assert.equal(await save.isEnabled(), true, 'server validation failure unlocks the editor');
            assert.equal(await page.locator('#system-0-mode').inputValue(), 'SPRITE');
            await save.click();
          }
          await page.getByText('草稿已保存；当前采用卡没有变化。', { exact: true }).waitFor();
          assert.equal(server.draft!.content.systemPresentation!.systems[0].mode, 'SPRITE');
          assert.equal(server.current!.confirmation!.id, 'old-approval');
          if (scenario === 'system-presentation') {
            await page.getByRole('button', { name: '添加有源系统', exact: true }).click();
            await page.locator('#system-1-identity').fill('裁决系统');
            await page.locator('#system-1-source-0-evidence').selectOption('ep1');
            await page.locator('#system-1-source-0-quote').fill('裁决系统：失败。');
            await page.locator('#system-1-mode').selectOption('VOICE_ONLY');
            await page.locator('#system-0-mode').selectOption('HUD');
            assert.equal(await page.locator('#system-1-mode').inputValue(), 'VOICE_ONLY', 'the other identity keeps its own carrier and permissions');
          }
          await tone.fill('系统选择随基础字段保留'); await page.getByRole('checkbox').check(); await save.click();
          await page.getByText('草稿已保存；当前采用卡没有变化。', { exact: true }).waitFor();
          assert.equal(server.draft!.content.systemPresentation!.systems[0].identity, '引导系统');
          await page.getByRole('checkbox').check(); await confirm.click();
          assert.ok(actions.every(item => ['save', 'confirm'].includes(String(item.action))), 'system editing never generates or resumes paid work');
        }
        if (scenario !== 'system-source-explicit') for (const phrase of ['信息面板', '精灵', '纯声音', '象征道具', '混合', '自定义', '保持原文', '同一处原提示', '原系统音不改为嘴部对白']) assert.ok((await page.locator('body').innerText()).includes(phrase), `actual UI explains ${phrase}`);
        if (process.env.SYSTEM_PRESENTATION_UI_EVIDENCE_DIR && scenario === 'system-alternative') {
          const evidenceDirectory = process.env.SYSTEM_PRESENTATION_UI_EVIDENCE_DIR; mkdirSync(evidenceDirectory, { recursive: true });
          await page.setViewportSize({ width: 1366, height: 900 }); await page.locator('#system-0-identity').scrollIntoViewIfNeeded();
          await page.screenshot({ path: path.join(evidenceDirectory, 'system-presentation-desktop.png') });
          await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#system-0-identity').scrollIntoViewIfNeeded();
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'narrow system editor must not overflow horizontally');
          await page.screenshot({ path: path.join(evidenceDirectory, 'system-presentation-mobile.png') });
        }
      } else if (scenario === 'expression-invalid') {
        await page.locator('#direction-rationale').fill('本剧\t轻喜');
        await save.click();
        await page.getByRole('alert').filter({ hasText: '选择依据' }).waitFor({ timeout: 2000 });
        assert.equal(actions.length, 0, 'invalid local content must never be submitted');
        assert.equal(await save.isEnabled(), true, 'failed local validation must release pending state');
        assert.equal(await page.locator('#direction-rationale').inputValue(), '本剧\t轻喜', 'the invalid draft is preserved for editing');
        await page.locator('#direction-rationale').fill('');
        await page.getByRole('checkbox').check(); await save.click();
        await page.getByText('草稿已保存；当前采用卡没有变化。', { exact: true }).waitFor();
        assert.deepEqual(actions.map(command => command.action), ['save']);
      } else if (scenario === 'expression-preferences') {
        const confirm = page.getByRole('button', { name: '确认采用', exact: true });
        assert.equal(await page.locator('#direction-emotion').inputValue(), '');
        await page.getByRole('checkbox').check();
        await page.locator('#direction-emotion').selectOption('HEIGHTENED');
        assert.equal(await page.getByRole('checkbox').isChecked(), false, 'a preference edit resets explicit adoption');
        assert.equal(await confirm.isDisabled(), true, 'cannot confirm the older saved draft after editing');
        await page.locator('#direction-camera').selectOption('DYNAMIC_FAST');
        await page.locator('#direction-fantasy').selectOption('RICH');
        await page.locator('#direction-rationale').fill(expressionPreferences.rationale);
        await page.getByRole('checkbox').check(); await save.click();
        await page.getByText('草稿已保存；当前采用卡没有变化。', { exact: true }).waitFor();
        assert.deepEqual(server.draft!.content.expressionPreferences, expressionPreferences);
        assert.equal(server.current!.confirmation!.id, 'old-approval');
        await tone.fill('保留表达选择的新主调');
        await page.getByRole('checkbox').check(); await save.click();
        await page.getByText('草稿已保存；当前采用卡没有变化。', { exact: true }).waitFor();
        assert.deepEqual(server.draft!.content.expressionPreferences, expressionPreferences, 'editing base fields must preserve the nested profile');
        await page.getByRole('checkbox').check(); await confirm.click();
        await page.getByText('已采用这版方向，后续各集将读取同一短brief。', { exact: true }).waitFor();
        assert.deepEqual(actions.map(command => command.action), ['save', 'save', 'confirm'], 'only free existing commands, never generate/resume');
      } else if(scenario==='shared-reading'||scenario==='expression-candidate'){
        await page.getByRole('button', { name: '刷新状态', exact: true }).click();
        await page.getByText('第一阶段共用读取已生成候选，没有额外调用。', { exact: true }).waitFor();
        assert.equal(await page.getByRole('button', { name: '生成AI候选', exact: true }).isVisible(), false, 'Paid rereading is not a primary/default action once a candidate exists.');
        const confirm = page.getByRole('button', { name: '确认采用', exact: true });
        assert.equal(await confirm.isDisabled(), true);
        if (scenario === 'expression-candidate') {
          assert.equal(await page.locator('#direction-emotion').inputValue(), 'HEIGHTENED');
          assert.equal(await page.locator('#direction-camera').inputValue(), 'DYNAMIC_FAST');
          assert.equal(await page.locator('#direction-fantasy').inputValue(), 'RICH');
          assert.equal(await page.locator('#direction-rationale').inputValue(), expressionPreferences.rationale);
          assert.equal(actions.length, 0, 'a displayed recommendation is not an approval');
        }
        await page.getByRole('checkbox').check();
        assert.equal(await confirm.isEnabled(), true, 'A verified shared-reading candidate needs one explicit adoption, not another paid generation or redundant save.');
        await confirm.click(); assert.deepEqual(actions.map(command => command.action), ['confirm']);
      } else if(scenario==='resume'){
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
