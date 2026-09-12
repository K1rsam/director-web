/** Real light-page components with read-only data fixtures; no DB, model, or browser. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FoundationDeliveryState } from "../lib/foundation-delivery-types";
import type { FoundationChoiceView } from "../lib/foundation-choice-store";

const require = createRequire(import.meta.url);
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
require.extensions[".css"] = module => { module.exports = {}; };
let actionCalls = 0;
const noAction = async () => { actionCalls++; throw new Error("SSR must not submit"); };
function stub(path: string, exports: unknown) {
  const resolved = require.resolve(path);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports } as NodeModule;
}
stub("../app/actions", { startFoundationDeliveryAction: noAction, stopFoundationDeliveryAction: noAction,
  confirmFoundationDeliveryChoiceAction: noAction, decidePresentationContractAction: noAction, setProjectExecutionModeAction: noAction, preprocessProjectAction: noAction });
stub("next/navigation", { useRouter: () => ({ refresh() { throw new Error("SSR must not refresh"); } }), notFound: () => { throw new Error("NOT_FOUND"); } });
const { FoundationDeliveryPanel } = require("../app/projects/[projectId]/foundation-delivery-panel");
const { LightFoundationDocumentViewer } = require("../app/projects/[projectId]/foundation-document-viewer");
const { AssetIndexTabs } = require("../app/projects/[projectId]/asset-index-tabs");
const { SceneStructureTable } = require("../app/projects/[projectId]/scene-structure-table");
const { PresentationContracts } = require("../app/projects/[projectId]/presentation-contracts");
const choice: FoundationChoiceView = { id: "choice", revision: "revision-2", category: "SOURCE_CONFLICT", question: "称呼需要怎样处理？", options: ["保留两个对象", "作为同一对象"], evidence: "<script>原文依据</script>", userAnswer: null, episodes: [1], sourceStages: ["F1"], reason: "原文歧义", recommended: "保留两个对象", recommendationReason: "不猜身份", round: 1, decidedAt: null };
const state: FoundationDeliveryState = {
  document: { schema: "FOUNDATION_DOCUMENT_V1", revision: "doc-1", sourceVersion: "source-1", sourceContextVersion: "context-1", sourceHashes: { 1: "hash-1", 2: "hash-2" }, settingsFingerprint: "settings", f1: null,
    f2: { format: "ASSET_CATALOG_V2", coverage: [1, 2], episodes: [], issues: [], assets: [1, 2].map(number => ({ key: `person-${number}`, name: `原文人物${number}`, type: "CH", role: "主角", aliases: [], description: "", sourceRefs: [], appearances: [], usageEpisodes: [number], preparation: { mode: "REFERENCE" }, variants: [{ key: `version-${number}`, name: `<b>版本${number}</b>`, episodes: [number], note: "保留原状态", preparation: { mode: "DERIVE", fromKey: `person-${number}` } }] })) },
    overviewParts: [], editorialCoverage: [1, 2], editorialTodos: [], notes: [], appliedDecisions: {}, reviewedSuggestions: {}, requiredDecisionIds: [], origins: [] },
  previousDocument: null, task: null, totalEpisodes: 2, availableEpisodes: 2, editedEpisodes: 2, busy: false, complete: true, needsContextEdit: false,
  action: "NONE", requiredChoices: [], confirmedChoices: [], suggestionsCount: 0,
  sourceContext: { version: "context-1", background: [], unresolved: [], issues: [], complete: true, notices: [], coverage: "COMPLETE" },
  codes: { "person-1": "CH-101", "version-1": "CH-101-1" }, issues: [], expectedState: "state-1"
};
const sources = [{ id: "e1", number: 1, title: "原题一", content: "第1集原文\n<img src=x onerror=alert(1)>\n逐字保留，不是AI摘要。", sceneCount: 3 }, { id: "e2", number: 2, title: null, content: "第2集原文全文", sceneCount: 2 }];
const before = JSON.stringify({ state, sources });
const renderPanel = (extra: Partial<FoundationDeliveryState> = {}) => renderToStaticMarkup(createElement(FoundationDeliveryPanel, { projectId: "p1", state: { ...state, ...extra }, requiredChoiceCount: extra.requiredChoices?.length ?? 0, compact: true }));
const renderDocument = (extra = {}) => {
  assert.equal(typeof LightFoundationDocumentViewer, "function", "缺少轻量原文与资产双栏组件");
  return renderToStaticMarkup(createElement(LightFoundationDocumentViewer, { state: { ...state, ...extra }, sourceEpisodes: sources }));
};
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], text: match[2] }));
const failures: string[] = [];
let count = 0;
async function check(name: string, run: () => void | Promise<void>) { count++; try { await run(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); } }

async function main() {
  await check("紧凑入口没有大面板或进度条且正常续作只有一个提交", () => {
    const html = renderPanel({ complete: false, action: "CONTINUE" });
    assert.ok(html.includes("topbarPrimary") && html.includes("继续完成"));
    assert.ok(!html.includes("<progress") && !html.includes("<section") && !html.includes("资料整理进度"));
    assert.equal(buttons(html).filter(button => button.attributes.includes('type="submit"')).length, 1);
    assert.ok(html.includes('name="expectedState"') && !html.includes('name="allowUnknownRetry"'));
  });
  await check("首次整理、已完成和必要选择不会制造重复普通入口", () => {
    assert.ok(renderPanel({ complete: false, action: "START" }).includes("整理资料"));
    assert.equal(buttons(renderPanel()).length, 0);
    const waiting = renderPanel({ complete: false, action: "NONE", requiredChoices: [choice] });
    assert.ok(waiting.includes('href="#presentation-contracts"') && !buttons(waiting).some(button => button.attributes.includes('type="submit"')));
  });
  await check("程序待办明确阻断模型续作，不再显示继续完成提交", () => {
    const html = renderPanel({ complete: false, action: "BLOCKED", continuationBlocker: "需要程序处理：原文须拆场" });
    assert.ok(html.includes("待程序处理") && html.includes('href="#foundation-status"'));
    assert.equal(buttons(html).filter(button => button.attributes.includes('type="submit"')).length, 0);
  });
  const task: FoundationDeliveryState["task"] = { schema: "FOUNDATION_DELIVERY_TASK_V1", id: "task-current", revision: 1, projectId: "p1", provider: "API", contextFingerprint: "ctx", sourceVersion: "source-1", documentRevision: "doc-1", status: "RUNNING", phase: "EDIT", scope: [1, 2], completedEpisodes: [], totalEpisodes: 2, message: "正在直接编辑", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), workerPid: null, workerToken: null, addedCalls: 1, repairCalls: 0, repairRounds: 0, maxRepairCalls: 2, maxRepairRounds: 2, unknownOutcome: false, error: null, decisionIds: [], unresolved: [] };
  await check("忙态保留停止且自动刷新只读", () => {
    const html = renderPanel({ busy: true, complete: false, action: "NONE", task });
    assert.ok(html.includes("停止") && html.includes('name="taskId"') && html.includes('value="task-current"'));
    assert.ok(buttons(html).some(button => button.text.includes("正在整理") && button.attributes.includes("disabled")));
    const source = read("app/projects/[projectId]/foundation-delivery-panel.tsx");
    assert.ok(source.includes("router.refresh()") && source.includes("clearInterval") && source.includes("if (!state.busy) return"));
    assert.doesNotMatch(source, /setInterval\([^\n]*startFoundationDeliveryAction/);
  });
  await check("停止与中断后顶部短状态清楚且可继续", () => {
    for (const [status, label] of [["STOPPED", "已停止"], ["INTERRUPTED", "处理中断"]] as const) {
      const html = renderPanel({ complete: false, action: "CONTINUE", task: { ...task!, status } });
      assert.ok(html.includes(label) && html.includes("继续完成") && !html.includes("<progress"));
    }
  });
  await check("UNKNOWN重发仍要求未预选的显式确认并随修订重置", () => {
    const html = renderPanel({ complete: false, action: "UNKNOWN_CONFIRM", task: { ...task!, status: "INTERRUPTED", unknownOutcome: true } });
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "";
    assert.ok(checkbox.includes('name="allowUnknownRetry"') && checkbox.includes("required") && !checkbox.includes("checked"));
    assert.ok(html.includes("可能重复计费") && html.includes("确认重发并继续"));
    assert.ok(read("app/projects/[projectId]/foundation-delivery-panel.tsx").includes("<form key={state.expectedState}"));
  });
  await check("双栏直接复用3000卡片和简表，null F1正常可读", () => {
    const html = renderDocument();
    assert.ok(html.includes('class="studioGrid twoColumns"') && (html.match(/class="studioCard"/g) ?? []).length === 2);
    assert.ok(html.includes("原文与分集索引") && html.includes("资产名称简表") && html.includes("assetIndexTabs"));
    assert.ok(html.includes("原题一") && html.includes("3 场") && html.includes("第2集原文全文"));
    assert.ok(!html.includes("<progress") && !html.includes("目录视图") && !html.includes("制图队列") && !html.includes("名称／别名"));
    assert.ok(!html.includes("<img src=x") && html.includes("&lt;img src=x") && html.includes("&lt;b&gt;版本1&lt;/b&gt;"));
  });
  await check("简表映射当前key、真实编号、父子和角色而不伪造确认", () => {
    const html = renderDocument();
    assert.ok(html.includes("CH-101") && html.includes("CH-101-1") && html.includes("assetChildRow") && html.includes("roleLead"));
    assert.ok(html.includes("未核编号") && !html.includes("已确认") && !html.includes("待确认"));
    assert.equal((html.match(/已整理/g) ?? []).length, 4);
  });
  await check("旧AI导航不回到主页面，原文依然逐字可读", () => {
    const legacy = { ...state.document, f1: { coverage: [1], overview: "LEGACY_AI_OVERVIEW", issues: [], episodes: [{ number: 1, summary: "LEGACY_AI_SUMMARY", context: "LEGACY_AI_CONTEXT", sourceSelections: [] }] } };
    const html = renderDocument({ document: legacy, previousDocument: legacy });
    assert.doesNotMatch(html, /LEGACY_AI_|分集导航|逐集推进/);
    assert.ok(html.includes("逐字保留，不是AI摘要。"));
  });
  await check("工作稿状态以编辑和必要范围为准，缺少F1不阻挡light", () => {
    const html = renderDocument({ document: { ...state.document, editorialCoverage: [1] } });
    assert.equal((html.match(/待完善/g) ?? []).length, 2);
    assert.equal((html.match(/已整理/g) ?? []).length, 2);
    assert.equal((renderDocument({ requiredChoices: [choice] }).match(/待完善/g) ?? []).length, 2);
    assert.equal((renderDocument({ sourceContext: { ...state.sourceContext, unresolved: [{ key: "u1", text: "尚未归属原文" }] } }).match(/待完善/g) ?? []).length, 4);
    assert.equal((renderDocument({ needsContextEdit: true }).match(/待完善/g) ?? []).length, 4);
    const confirmed = { ...choice, userAnswer: choice.options[0], decidedAt: new Date(0) };
    assert.equal((renderDocument({ confirmedChoices: [confirmed] }).match(/待完善/g) ?? []).length, 2);
    assert.equal((renderDocument({ confirmedChoices: [{ ...confirmed, episodes: [99] }] }).match(/待完善/g) ?? []).length, 0);
    assert.equal((renderDocument({ confirmedChoices: [confirmed], document: { ...state.document, appliedDecisions: { [choice.id]: choice.revision } } }).match(/待完善/g) ?? []).length, 0);
    const issue = { severity: "MAJOR", owner: "PROGRAM", coordinate: "source", problem: "原文场次需核对", sourceRefs: [{ episode: 2, startLine: 1, endLine: 1 }] };
    assert.equal((renderDocument({ issues: [issue] }).match(/待完善/g) ?? []).length, 2);
    assert.equal((renderDocument({ issues: [{ ...issue, sourceRefs: [] }] }).match(/待完善/g) ?? []).length, 4);
    assert.equal((renderDocument({ issues: [{ ...issue, severity: "MINOR", sourceRefs: [] }] }).match(/待完善/g) ?? []).length, 0);
    const intrinsic = structuredClone(state.document);
    intrinsic.f2!.assets[0].preparation = { mode: "UNRESOLVED" };
    intrinsic.f2!.assets[0].variants[0].preparation = { mode: "DERIVE" };
    assert.equal((renderDocument({ document: intrinsic }).match(/待完善/g) ?? []).length, 2);
  });
  await check("旧资产方法短提示且保留表格，不在读取时替换", () => {
    const html = renderDocument({ needsAssetRefresh: true });
    assert.ok(html.includes("旧资产稿，待按当前方法整理") && html.includes("CH-101") && html.includes("assetIndexTabs"));
    assert.equal((html.match(/待完善/g) ?? []).length, 4);
  });
  await check("空目录不再冒称旧资产稿", () => {
    const html = renderDocument({ needsAssetRefresh: true, document: { ...state.document, f2: null } });
    assert.ok(!html.includes("旧资产稿"));
  });
  await check("简表可选状态文本不破坏旧确认默认行为", () => {
    const row = { id: "asset-1", code: "CH-1", type: "CH", name: "人物", status: "working" };
    const legacy = renderToStaticMarkup(createElement(AssetIndexTabs, { assets: [row] }));
    assert.ok(legacy.includes("待确认") && legacy.includes("<th>确认</th>"));
    const html = renderToStaticMarkup(createElement(AssetIndexTabs, { assets: [{ ...row, statusLabel: "资料记录" }] }));
    assert.ok(html.includes("资料记录") && !html.includes("待确认"));
    assert.ok(html.includes("<th>状态</th>"), "工作稿状态不冒充逐项人工确认");
  });
  await check("持续刷新后首次非人物资产及失效分类仍显示真实条目", () => {
    const react = require("react") as typeof import("react");
    const originalUseState = react.useState;
    let selected: string | undefined;
    // Replay one persistent hook across prop refreshes; all returned table markup is the real component.
    react.useState = ((initial: string) => [selected ??= initial, (value: string) => { selected = value; }]) as typeof react.useState;
    try {
      const location = { id: "loc", code: "LOC-001", type: "LOC", name: "原文场景", status: "working", statusLabel: "已整理" };
      AssetIndexTabs({ assets: [] });
      const first = renderToStaticMarkup(AssetIndexTabs({ assets: [location] }));
      assert.ok(first.includes("LOC-001") && first.includes('aria-selected="true"') && !first.includes("该分类暂无资产"));
      selected = "people";
      const removed = renderToStaticMarkup(AssetIndexTabs({ assets: [location] }));
      assert.ok(removed.includes("LOC-001") && removed.includes('aria-selected="true"'));
      selected = "scenes";
      const kept = renderToStaticMarkup(AssetIndexTabs({ assets: [{ ...location, id: "person", code: "CH-001", type: "CH" }, location] }));
      assert.ok(kept.includes("LOC-001") && !kept.includes("CH-001"), "仍有效的用户分类选择不被重置");
    } finally { react.useState = originalUseState; }
  });
  await check("场次表默认折叠，不强迫整页滑过场次", () => {
    const html = renderToStaticMarkup(createElement(SceneStructureTable, { scenes: [{ episodeNumber: 1, sceneKey: "S1", heading: "原场次", location: "院内", timeOfDay: "未注明", interiorExterior: "未注明", weather: "未注明", timeLayer: "现实", sourceText: "原场次原文" }] }));
    assert.ok(html.includes('aria-expanded="false"') && !html.includes("<table"));
  });
  await check("必要选择仍精确绑定revision和task并采纳续作", () => {
    const html = renderToStaticMarkup(createElement(PresentationContracts, { projectId: "p1", pending: [choice], confirmed: [], mode: "delivery", expectedTaskId: "task-current" }));
    for (const text of ["确认并继续", 'value="revision-2"', 'value="task-current"', "&lt;script&gt;原文依据"]) assert.ok(html.includes(text));
    assert.ok(!html.includes('checked=""'));
  });
  await check("页面鉴权后只读查询原文，紧凑入口在顶部且第二阶段仍关闭", async () => {
    const reads: string[] = [];
    let owned = true;
    stub("../lib/auth", { requireSessionUser: async () => { reads.push("auth"); return { id: "owner" }; } });
    stub("../lib/studio", { getProjectStudio: async (_id: string, userId: string) => { assert.equal(userId, "owner"); reads.push("owned-project"); return owned ? { project: { id: "p1", title: "项目", style: "3D", aspectRatio: "16:9", executionMode: "AUTO" }, episodes: sources.map(source => ({ ...source, title: source.title ?? `第${source.number}集`, scenes: [], roles: [], shotCount: 0 })), assets: [{ code: "OLD-ASSET", name: "旧表不是当前资料" }], firstPhase: { stages: [] } } : null; } });
    stub("../lib/foundation-delivery", { getFoundationDeliveryState: async () => { reads.push("delivery"); return state; } });
    stub("../lib/prisma", { prisma: { episode: { findMany: async (args: unknown) => { reads.push("source-read"); assert.deepEqual(args, { where: { projectId: "p1" }, orderBy: { number: "asc" }, select: { id: true, number: true, title: true, content: true } }); return sources.map(({ sceneCount: _count, ...source }) => source); } } } });
    stub("../app/ui/app-chrome", { AppChrome: ({ utility, primaryAction, children }: { utility?: ReactNode; primaryAction?: ReactNode; children?: ReactNode }) => createElement("div", null, createElement("header", null, utility, primaryAction), children) });
    const Page = require("../app/projects/[projectId]/page").default;
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ projectId: "p1" }) }));
    assert.ok(reads.indexOf("auth") < reads.indexOf("owned-project") && reads.indexOf("owned-project") < reads.indexOf("source-read"));
    assert.ok(html.includes("原文与分集索引") && html.includes("后续阶段尚未启用"));
    assert.ok(html.indexOf('id="foundation-delivery"') < html.indexOf("</header>"));
    assert.ok(html.indexOf("executionModeSwitch") < html.indexOf("</header>"), "运行渠道必须在首屏可见，不再藏进历史折叠");
    const workflow = html.split('id="foundation-status"')[1]?.split('id="foundation-document"')[0] ?? '';
    for (const text of ["P0", "F1", "F2", "Q1", "重新检查原文", "查看资产", "查看场次"]) assert.ok(workflow.includes(text), `首屏缺少可见操作/状态 ${text}`);
    assert.ok(html.indexOf('id="foundation-status"') < html.indexOf('id="foundation-document"'));
    assert.ok(!html.includes("<progress") && !html.includes("进入本集") && !html.includes("LEGACY_AI_"));
    const mainAssets = html.split("资产名称简表")[1]?.split("</article>")[0] ?? "";
    assert.ok(mainAssets.includes("CH-101") && !mainAssets.includes("OLD-ASSET"));
    reads.length = 0; owned = false;
    await assert.rejects(() => Page({ params: Promise.resolve({ projectId: "p1" }) }), /NOT_FOUND/);
    assert.deepEqual(reads, ["auth", "owned-project"]);
  });
  await check("不改输入且没有提交或模型调用", () => { assert.equal(JSON.stringify({ state, sources }), before); assert.equal(actionCalls, 0); });
  for (const failure of failures) console.error(`FAIL ${failure}`);
  assert.equal(failures.length, 0, `${failures.length}/${count} light UI checks failed`);
  console.log(`PASS ${count} light UI checks: compact 3000 layout, exact original source, current asset identity table, nullable F1 and action guards (SSR fixtures only)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
