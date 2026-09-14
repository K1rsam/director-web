/** Real delivery UI SSR. Only CSS, navigation hooks and uncalled server actions are substituted. No DB or model calls. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FoundationDeliveryState, FoundationDeliveryTask } from "../lib/foundation-delivery-types";
import type { FoundationChoiceView } from "../lib/foundation-choice-store";

const require = createRequire(import.meta.url);
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
assert.ok(existsSync(new URL("../app/projects/[projectId]/foundation-delivery-panel.tsx", import.meta.url)), "主页面缺少连续整理入口");
require.extensions[".css"] = module => { module.exports = {}; };
let actionCalls = 0;
const noAction = async () => { actionCalls += 1; throw new Error("SSR must not submit"); };
const actionPath = require.resolve("../app/actions");
require.cache[actionPath] = { id: actionPath, filename: actionPath, loaded: true, exports: {
  startFoundationDeliveryAction: noAction, stopFoundationDeliveryAction: noAction, preprocessProjectAction: noAction,
  confirmFoundationDeliveryChoiceAction: noAction, decidePresentationContractAction: noAction
} } as NodeModule;
const navigationPath = require.resolve("next/navigation");
require.cache[navigationPath] = { id: navigationPath, filename: navigationPath, loaded: true, exports: { useRouter: () => ({ refresh() { throw new Error("SSR must not refresh"); } }) } } as NodeModule;
const { FoundationDeliveryPanel, FoundationWorkflowStatus } = require("../app/projects/[projectId]/foundation-delivery-panel") as typeof import("../app/projects/[projectId]/foundation-delivery-panel");
const { FoundationDocumentViewer } = require("../app/projects/[projectId]/foundation-document-viewer") as typeof import("../app/projects/[projectId]/foundation-document-viewer");
const { PresentationContracts } = require("../app/projects/[projectId]/presentation-contracts") as typeof import("../app/projects/[projectId]/presentation-contracts");

const choice: FoundationChoiceView = {
  id: "choice-1", revision: "choice-revision", category: "SOURCE_CONFLICT", question: "两种称呼是否同一人？", options: ["合并人物", "保留两人"],
  evidence: "<script>原文依据</script>", userAnswer: null, episodes: [1], sourceStages: ["F2"], reason: "原文有两个合理解释。",
  recommended: "保留两人", recommendationReason: "身份关系尚未确定。", round: 1, decidedAt: null
};
const document: FoundationDeliveryState["document"] = {
  schema: "FOUNDATION_DOCUMENT_V1", revision: "doc-1", sourceVersion: "source-1", sourceContextVersion: "context-1", sourceHashes: {}, settingsFingerprint: "settings",
  f1: { coverage: [1], overview: "持续保留的全剧概述", episodes: [{ number: 1, summary: "<img src=x onerror=alert(1)>", context: "完整的当集内容\n第二段承接", sourceSelections: [] }], issues: [] },
  f2: { format: "ASSET_CATALOG_V2", coverage: [1], issues: [], episodes: [], assets: [{ key: "hero", name: "主角", type: "CH", role: "主角", aliases: [], description: "", sourceRefs: [], appearances: [], usageEpisodes: [1], variants: [], preparation: { mode: "REFERENCE" } }] },
  overviewParts: [], editorialCoverage: [], notes: ["制作说明保持可读"], appliedDecisions: {}, reviewedSuggestions: {}, requiredDecisionIds: [], origins: [], editorialTodos: []
};
const base: FoundationDeliveryState = {
  document, previousDocument: null, task: null, totalEpisodes: 3, availableEpisodes: 1, editedEpisodes: 0, busy: false, complete: false, needsContextEdit: false,
  action: "CONTINUE", requiredChoices: [], confirmedChoices: [], suggestionsCount: 0, codes: {}, issues: [], expectedState: "expected-1",
  sourceContext: { version: "context-1", background: [], unresolved: [], issues: [], complete: true, notices: [], coverage: "COMPLETE" }
};
const task = (extra: Partial<FoundationDeliveryTask> = {}): FoundationDeliveryTask => ({
  schema: "FOUNDATION_DELIVERY_TASK_V1", id: "task-1", revision: 1, projectId: "project-1", sourceVersion: "source-1", documentRevision: "doc-1", provider: "API", contextFingerprint: "context-fingerprint",
  status: "RUNNING", phase: "GENERATE_F2", scope: [2, 3], completedEpisodes: [1], totalEpisodes: 3, message: "正在补充剩余内容", createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
  workerPid: null, workerToken: null, addedCalls: 1, repairCalls: 0, repairRounds: 0, maxRepairCalls: 2, maxRepairRounds: 2, unknownOutcome: false, error: null, decisionIds: [], unresolved: [], ...extra
});
const render = (state: FoundationDeliveryState = base) => renderToStaticMarkup(createElement(FoundationDeliveryPanel, { projectId: "project-1", state, requiredChoiceCount: state.requiredChoices.length }));
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map(match => ({ attributes: match[1], body: match[2] }));
const failures: string[] = [];
let checks = 0;
function check(name: string, test: () => void) { checks += 1; try { test(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`); } }
const before = JSON.stringify(base);

check("紧凑阶段与真实范围进度可见，等待不伪造百分比", () => {
  for (const [phase, label] of [["PREPARE_SOURCE", "P1 · 原文结构检查"], ["GENERATE_F1", "P2 · 拆集分场"], ["GENERATE_F2", "P3 · 素材提取"], ["EDIT", "P3 · 自动校验"], ["REPAIR", "P3 · 局部修复"], ["APPLY_DECISION", "P3 · 应用决定"]] as const) {
    const state = { ...base, busy: true, totalEpisodes: 70, availableEpisodes: 31, editedEpisodes: 0, task: task({ phase, scope: Array.from({ length: 27 }, (_, i) => i + 32) }) };
    const compact = renderToStaticMarkup(createElement(FoundationDeliveryPanel, { projectId: "project-1", state, requiredChoiceCount: 0, compact: true }));
    const status = renderToStaticMarkup(createElement(FoundationWorkflowStatus, { projectId: "project-1", state, sourceReady: true, sceneCount: 70, remaining: [] }));
    assert.ok(compact.includes(label) && status.includes(label));
    assert.ok(status.includes("第32–58集") && status.includes("已保存 31 / 70 集") && status.includes("已核对 0 / 70 集"));
    assert.ok(status.includes("任务最近记录") && status.includes('dateTime="1970-01-01T00:00:00.000Z"') && status.includes("单次模型请求等待返回期间"));
    assert.doesNotMatch(status, /心跳|\d+%/);
  }
  const renderStatus = (state: FoundationDeliveryState) => renderToStaticMarkup(createElement(FoundationWorkflowStatus, { projectId: "project-1", state, sourceReady: true, sceneCount: 3, remaining: [] }));
  assert.ok(renderStatus({ ...base, busy: true, task: task({ scope: [5, 2, 1, 2, 8, 7] }) }).includes("第1–2、5、7–8集"));
  assert.ok(renderStatus({ ...base, busy: true, task: task({ scope: [] }) }).includes("处理范围：尚未确定"));
  const complete = renderStatus({ ...base, complete: true });
  assert.ok(complete.includes("P4 · 交接就绪") && !complete.includes("单次模型请求等待返回期间"));
});

check("普通续作仅一个入口且不允许未知请求重发", () => {
  const html = render();
  assert.equal(buttons(html).filter(button => button.attributes.includes('type="submit"')).length, 1);
  assert.ok(html.includes("继续完成") && html.includes('name="expectedState"') && html.includes('value="expected-1"'));
  assert.ok(!html.includes('name="allowUnknownRetry"'));
  assert.doesNotMatch(html, /F1|F2|Q1|审核通过|未批准|整批重跑/);
});
check("首次整理与完成态", () => {
  const first = render({ ...base, document: { ...document, f1: null, f2: null }, availableEpisodes: 0, action: "START" });
  assert.ok(first.includes("整理资料"));
  const complete = render({ ...base, availableEpisodes: 3, editedEpisodes: 3, complete: true, action: "NONE" });
  assert.ok(complete.includes("资料已整理") && buttons(complete).length === 0);
  const staleAction = render({ ...base, availableEpisodes: 3, editedEpisodes: 3, complete: true, action: "CONTINUE" });
  assert.ok(staleAction.includes("资料已整理") && buttons(staleAction).length === 0);
  assert.doesNotMatch(complete + staleAction, /再完善一次|继续完善（可选）/);
  const empty = render({ ...base, document: { ...document, f1: null, f2: null }, totalEpisodes: 0, availableEpisodes: 0, action: "NONE" });
  assert.ok(empty.includes("原文暂未就绪") && buttons(empty).length === 0);
});
check("运行期间禁止重复提交且停止绑定当前任务", () => {
  const html = render({ ...base, busy: true, action: "NONE", task: task() });
  const all = buttons(html);
  assert.ok(all.some(button => button.body.includes("正在整理") && button.attributes.includes('disabled=""')));
  assert.ok(all.some(button => button.body.includes("停止")));
  assert.ok(html.includes('name="taskId"') && html.includes('value="task-1"'));
  assert.ok(html.includes('role="status"') && html.includes("自动更新"));
  assert.ok(html.includes("本任务累计请求") && html.includes("自动修正") && html.includes("不会重置"));
  assert.ok(!html.includes("继续操作会开启新一轮限额"));
});
check("付费失败原因保留诊断且不提供无目标重跑", () => {
  const html = render({ ...base, action: "BLOCKED", continuationBlocker: "同一输入已付费，格式修复额度已用完；已停止重复请求。", task: task({ status: "PARTIAL" }) });
  assert.ok(html.includes("格式修复额度已用完") && html.includes("查看整理状态"));
  assert.equal(buttons(html).length, 0);
});
check("未知结果必须显式勾选重复计费确认", () => {
  const html = render({ ...base, action: "UNKNOWN_CONFIRM", task: task({ status: "INTERRUPTED", unknownOutcome: true }) });
  assert.ok(html.includes("可能重复计费") && html.includes("结果尚未确认"));
  const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0] ?? "";
  for (const attribute of ['name="allowUnknownRetry"', 'value="yes"', 'required=""']) assert.ok(checkbox.includes(attribute));
  assert.ok(!html.includes('checked=""') && !html.includes('type="hidden" name="allowUnknownRetry"'));
  assert.equal(buttons(html).filter(button => button.attributes.includes('type="submit"')).length, 1);
  const withChoice = render({ ...base, action: "UNKNOWN_CONFIRM", requiredChoices: [choice], task: task({ status: "INTERRUPTED", unknownOutcome: true }) });
  assert.ok(withChoice.includes('name="allowUnknownRetry"'), "请求恢复不能被必要决定挡住");
  assert.ok(read("app/projects/[projectId]/foundation-delivery-panel.tsx").includes("<form key={state.expectedState}"), "资料意图变化须重置未提交的重发勾选");
});
check("部分完成和停止保留正文并给明确续作", () => {
  for (const status of ["PARTIAL", "INTERRUPTED", "STOPPED"] as const) {
    const html = render({ ...base, task: task({ status, error: "<script>错误明细</script>" }) });
    assert.ok(html.includes("已保留") && html.includes("继续完成"));
    assert.ok(!html.includes("<script>错误明细"));
  }
});
check("必要问题阻止普通调用而建议不全局阻断", () => {
  const waiting = render({ ...base, requiredChoices: [choice], task: task({ status: "WAITING_USER" }), action: "NONE" });
  assert.ok(waiting.includes("需要你确认") && waiting.includes('href="#presentation-contracts"'));
  assert.equal(buttons(waiting).length, 0);
  assert.ok(render({ ...base, suggestionsCount: 4 }).includes("继续完成"));
});
check("正文直接读取工作稿且无需批准仍完整可读", () => {
  const html = renderToStaticMarkup(createElement(FoundationDocumentViewer, { state: base }));
  assert.ok(html.includes("持续保留的全剧概述") && html.includes("完整的当集内容") && html.includes("第二段承接") && html.includes("主角") && html.includes("制作说明保持可读"));
  assert.ok(html.includes("&lt;img") && !html.includes("<img src=x"));
  assert.ok(html.includes("分集导航") && html.includes("资产目录"));
  assert.ok(!html.includes("已核编号"));
  assert.doesNotMatch(html, /F1|F2|Q1|未批准/);
});
check("旧稿有独立标识且不替代当前范围", () => {
  const html = renderToStaticMarkup(createElement(FoundationDocumentViewer, { state: { ...base, document: { ...document, f1: null, f2: null }, availableEpisodes: 0, previousDocument: document } }));
  assert.ok(html.includes("历史资料") && html.includes("不计入当前完成范围") && html.includes("持续保留的全剧概述"));
});
check("未确认决定及无key待续项按范围排除制图，不猜身份", () => {
  const catalog = { ...document.f2!, coverage: [1, 2], assets: [...document.f2!.assets, { ...document.f2!.assets[0], key: "other", name: "另一集角色", usageEpisodes: [2] }] };
  const renderDoc = (requiredChoices: FoundationChoiceView[], editorialTodos: FoundationDeliveryState["document"]["editorialTodos"] = []) => renderToStaticMarkup(createElement(FoundationDocumentViewer, { state: { ...base, document: { ...document, f1: { ...document.f1!, coverage: [1, 2] }, f2: catalog, editorialCoverage: [1, 2], editorialTodos }, requiredChoices } }));
  const body = (html: string, name: string) => html.split(`<tbody aria-label="${name}">`)[1].split("</tbody>")[0];
  const scoped = renderDoc([choice]);
  assert.ok(body(scoped, "主角").includes("资料待完善"));
  assert.ok(!body(scoped, "另一集角色").includes("资料待完善"));
  const global = renderDoc([{ ...choice, episodes: [] }]);
  assert.ok(body(global, "另一集角色").includes("资料待完善"));
  const todo = renderDoc([], [{ id: "todo-1", episodes: [2], note: "范围未核" }]);
  assert.ok(body(todo, "另一集角色").includes("资料待完善") && !body(todo, "主角").includes("资料待完善"));
});
const readyDocument: FoundationDeliveryState["document"] = {
  ...document, sourceHashes: { 1: "hash-1", 2: "hash-2" }, editorialCoverage: [1, 2],
  f1: { ...document.f1!, coverage: [1, 2], episodes: [...document.f1!.episodes, { number: 2, summary: "第二集继续可读", context: "第二集完整内容", sourceSelections: [] }] },
  f2: { ...document.f2!, coverage: [1, 2], assets: [1, 2].map(number => ({ ...document.f2!.assets[0], key: `ready-${number}`, name: `第${number}集对象`, usageEpisodes: [number], variants: [
    { key: `ready-child-${number}`, name: `第${number}集子形象`, episodes: [number], note: "保留状态说明", preparation: { mode: "DERIVE", fromKey: `ready-${number}` } }
  ] })) }
};
const readyState: FoundationDeliveryState = { ...base, document: readyDocument, totalEpisodes: 2, availableEpisodes: 2, editedEpisodes: 2, complete: true, action: "NONE" };
const readyBefore = JSON.stringify(readyState);
const renderReady = (extra: Partial<FoundationDeliveryState> = {}) => renderToStaticMarkup(createElement(FoundationDocumentViewer, { state: { ...readyState, ...extra } }));
const assetRows = (html: string) => [...html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map(match => match[1]).filter(row => row.includes("查看说明"));
function assertPendingEpisodes(html: string, episodes: number[]) {
  const rows = assetRows(html);
  assert.equal(rows.length, 4, "完整目录仍保留两个基础和两个子形象");
  for (const row of rows) {
    const number = row.includes("第1集对象") || row.includes("第1集子形象") ? 1 : 2;
    assert.equal(row.includes("<span>待定／未分类</span>"), episodes.includes(number), `第${number}集条目就绪标记`);
    if (episodes.includes(number)) assert.ok(row.includes("暂不列入制图队列"));
  }
  assert.ok(html.includes("完整的当集内容") && html.includes("第二集完整内容") && html.includes("保留状态说明"));
}
check("已编辑且无阻塞的工作目录仍可备图", () => assertPendingEpisodes(renderReady(), []));
check("未编辑集的基础和派生子形象不标为可备图", () => assertPendingEpisodes(renderReady({ document: { ...readyDocument, editorialCoverage: [1] } }), [2]));
check("缺少导航覆盖的目录范围不标为可备图", () => assertPendingEpisodes(renderReady({ document: { ...readyDocument, f1: { ...readyDocument.f1!, coverage: [1] } } }), [2]));
for (const [name, extra] of [
  ["背景或制作条件待重新编辑", { needsContextEdit: true }],
  ["原文未决区", { sourceContext: { ...base.sourceContext, unresolved: [{ key: "unassigned", text: "保留尚未归属的原文" }], complete: false } }],
  ["当前原文结构问题", { sourceContext: { ...base.sourceContext, issues: [{ code: "INVALID_SOURCE_IMPORT_STRUCTURE", message: "范围尚未核对", sectionKeys: [] }], complete: false } }],
  ["当前导入不可读取", { sourceContext: { ...base.sourceContext, notices: [{ code: "CURRENT_SOURCE_IMPORT_METADATA_UNREADABLE", message: "当前导入不可读取" }], coverage: "UNKNOWN", complete: false } }]
] as const) check(`${name}保留正文但暂停全部制图条目`, () => assertPendingEpisodes(renderReady(extra as Partial<FoundationDeliveryState>), [1, 2]));
for (const code of ["LEGACY_SOURCE_IMPORT_BOUNDARY", "NO_SOURCE_IMPORT_METADATA", "DOCX_READER_WARNING"]) check(`${code}仅作来源说明而不冒充硬阻塞`, () => {
  assertPendingEpisodes(renderReady({ sourceContext: { ...base.sourceContext, complete: false, coverage: "UNKNOWN", notices: [{ code, message: "来源说明" }] } }), []);
});
const confirmedChoice = { ...choice, userAnswer: "保留两人", decidedAt: new Date(0) };
check("已确认但未应用的决定按自身范围阻止备图", () => assertPendingEpisodes(renderReady({ confirmedChoices: [confirmedChoice] }), [1]));
check("旧应用修订不能替代最新确认", () => assertPendingEpisodes(renderReady({ confirmedChoices: [confirmedChoice], document: { ...readyDocument, appliedDecisions: { [choice.id]: "old-revision" } } }), [1]));
check("全局未应用决定暂停全部制图条目", () => assertPendingEpisodes(renderReady({ confirmedChoices: [{ ...confirmedChoice, episodes: [] }] }), [1, 2]));
check("当前确认修订已应用即可恢复备图", () => assertPendingEpisodes(renderReady({ confirmedChoices: [confirmedChoice], document: { ...readyDocument, appliedDecisions: { [choice.id]: choice.revision } } }), []));
check("已移除集的历史决定不扩大成全局阻塞", () => {
  assertPendingEpisodes(renderReady({ confirmedChoices: [{ ...confirmedChoice, episodes: [99] }] }), []);
  assertPendingEpisodes(renderReady({ confirmedChoices: [{ ...confirmedChoice, episodes: [1, 99] }] }), [1]);
});
check("key待续项阻止所属基础及子形象而不猜同名身份", () => {
  const current = structuredClone(readyDocument);
  current.editorialTodos = [{ id: "parent-todo", key: "ready-1", note: "基础资料待补全" }];
  current.f2!.assets[0].variants[0].preparation = { mode: "REFERENCE" };
  assertPendingEpisodes(renderReady({ document: current }), [1]);
});
check("历史修订保全原制作记录且不呈现当前制图就绪", () => {
  const html = renderReady({ previousDocument: readyDocument });
  const history = html.split("历史资料 · 上一份保留修订")[1];
  assert.ok(history.includes("历史记录，仅供阅读，不列入当前制图队列"));
  assert.ok(!history.includes("需要备图时可切换"), "历史阅读不邀请进入当前制图队列");
  assert.equal(assetRows(history).length, 4);
  assert.ok(assetRows(history).every(row => row.includes("<span>历史记录</span>") && !row.includes("<span>独立准备</span>") && !row.includes("<span>复用／派生</span>")));
  assert.ok(history.includes("原记录方式：独立准备") && history.includes("原记录方式：复用／派生"));
  assert.ok(buttons(history).find(button => button.body === "制图队列")?.attributes.includes('disabled=""'));
});
check("新增就绪判断不修改工作稿或接入服务端运行时", () => {
  assert.equal(JSON.stringify(readyState), readyBefore);
  const source = read("app/projects/[projectId]/foundation-document-viewer.tsx");
  assert.doesNotMatch(source, /import (?!type )[^\n]*(?:foundation-delivery-assets|foundation-document|foundation-delivery-types)/);
});
check("确认按钮直接采纳并续作，不另需岗位操作", () => {
  const html = renderToStaticMarkup(createElement(PresentationContracts, { projectId: "project-1", pending: [choice], confirmed: [], mode: "delivery", expectedTaskId: "task-1" }));
  assert.ok(html.includes("确认并继续") && html.includes('name="expectedTaskId"') && html.includes('value="task-1"'));
  assert.ok(html.includes('name="revision"') && html.includes("choice-revision") && html.includes("&lt;script&gt;原文依据&lt;/script&gt;"));
  assert.ok(!html.includes("只保存决定，不自动运行") && !html.includes('checked=""'));
  const confirmed = renderToStaticMarkup(createElement(PresentationContracts, { projectId: "project-1", pending: [], confirmed: [{ ...choice, userAnswer: "保留两人", decidedAt: new Date(0) }], mode: "delivery" }));
  assert.ok(confirmed.includes("已确认的决定") && confirmed.includes("保留两人"));
});
check("主页面鉴权后只读加载，旧岗位无普通入口", () => {
  const page = read("app/projects/[projectId]/page.tsx");
  assert.ok(page.includes("await getFoundationDeliveryState(projectId)"));
  assert.ok(page.indexOf("await requireSessionUser") < page.indexOf("await getFoundationDeliveryState"));
  assert.ok(page.indexOf("if (!studio) notFound()") < page.indexOf("await getFoundationDeliveryState"));
  for (const old of ["<FoundationActions", "<FoundationViewer", "runFoundationStageAction", "continueProjectFoundationAction", "confirmAllAssetsAction"]) assert.ok(!page.includes(old), old);
  assert.ok(page.includes("pending={delivery.requiredChoices}") && page.includes("confirmed={delivery.confirmedChoices}"));
  assert.ok(page.includes('"decision-continued"') && page.includes("blockedReason="));
  assert.ok(page.includes('"delivery-unavailable"') && page.includes("已保存资料和决定没有丢失"));
  assert.ok(page.includes("处理历史") && page.includes("<FoundationUsage") && page.includes("<SceneStructureTable") && page.includes("/foundation/export"));
  assert.ok(page.includes("后续阶段尚未启用") && !page.includes("runEpisode"));
});
check("项目列表与当前工作稿完成状态一致且先限定用户项目", () => {
  const home = read("app/page.tsx");
  assert.ok(home.includes("(await getFoundationDeliveryState(project.id)).complete"));
  assert.ok(!home.includes("getFoundationState") && !home.includes(".ready"));
  assert.ok(home.indexOf("await requireSessionUser") < home.indexOf("await getProjectLibrary(currentUser.id)"));
  assert.ok(home.indexOf("await getProjectLibrary(currentUser.id)") < home.indexOf("await getFoundationDeliveryState"));
  assert.ok(home.includes("foundationReady: foundationCompleteByProject.get(project.id) === true"));
});
check("刷新只读且局部样式可键盘和窄屏使用", () => {
  const panel = read("app/projects/[projectId]/foundation-delivery-panel.tsx");
  const css = read("app/projects/[projectId]/foundation-delivery.module.css");
  assert.ok(panel.includes("router.refresh()") && panel.includes("clearInterval") && panel.includes("if (!state.busy) return"));
  assert.ok(!panel.includes("setInterval(() => startFoundationDeliveryAction"));
  assert.ok(css.includes(":focus-visible") && css.includes("overflow-wrap: anywhere") && css.includes("@media"));
});
check("技术故障折叠诊断，正文不转交底层修复，未知结果优先", () => {
  const technical = "请修 JSON sceneKey，再缩减资料 <script>诊断</script>";
  const failed = { ...base, action: "BLOCKED" as const, continuationBlocker: technical, task: task({ status: "PARTIAL", message: technical, error: technical }) };
  const rail = (state: FoundationDeliveryState) => renderToStaticMarkup(createElement(FoundationWorkflowStatus, { projectId: "project-1", state, sourceReady: true, sceneCount: 3, remaining: ["人物身份需创作确认"] }));
  const visible = (html: string) => html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
  for (const html of [render(failed), rail(failed)]) {
    assert.ok(visible(html).includes("当前已暂停") && visible(html).includes("已保存资料"));
    assert.doesNotMatch(visible(html), /sceneKey|JSON|请修|缩减资料|修复成功/);
    assert.ok(html.includes("sceneKey") && html.includes("&lt;script&gt;诊断&lt;/script&gt;"));
    assert.ok(html.includes('role="status"') && html.includes('aria-live="polite"'));
    assert.doesNotMatch(html, /<script>诊断/);
  }
  const diagnostic = rail(failed).match(/<details[^>]*><summary>技术诊断与处理记录<\/summary>/)?.[0];
  assert.ok(diagnostic && !diagnostic.includes("open"));
  assert.ok(rail(failed).includes("人物身份需创作确认"), "内容待办不得隐藏或替代");
  const unknownState = { ...failed, task: task({ status: "INTERRUPTED", unknownOutcome: true, error: technical }) };
  assert.ok(render(unknownState).includes("确认重发并继续") && rail(unknownState).includes("重发可能重复计费"));
  assert.ok(!visible(rail(unknownState)).includes("无需你修改剧本格式"));
  const waiting = { ...base, requiredChoices: [choice], action: "NONE" as const, task: task({ status: "WAITING_USER" }) };
  assert.ok(render(waiting).includes("需要你确认") && rail(waiting).includes("创作取舍"));
});

check("四卡只突出真实当前岗位，计时恢复且非活动状态冻结", () => {
  const rail = (state: FoundationDeliveryState) => renderToStaticMarkup(createElement(FoundationWorkflowStatus, { projectId: "project-1", state, sourceReady: true, sceneCount: 3, remaining: [] }));
  const clockTask = task({ createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:02:05.000Z" });
  for (const [phase, card] of [["PREPARE_SOURCE", "P1"], ["GENERATE_F1", "P2"], ["GENERATE_F2", "P3"], ["EDIT", "P3"], ["REPAIR", "P3"], ["APPLY_DECISION", "P3"]] as const) {
    const html = rail({ ...base, busy: true, task: { ...clockTask, phase } });
    const current = html.match(/<article[^>]*aria-current="step"[^>]*>[\s\S]*?<\/article>/g) ?? [];
    assert.equal(current.length, 1);
    assert.ok(current[0].includes(`<span>${card}</span>`) && current[0].includes("正在工作"));
    assert.ok(html.includes("本任务历时（含等待）：2分 5秒") && html.includes('data-clock="running"'));
  }
  for (const status of ["WAITING_USER", "STOPPED", "INTERRUPTED", "PARTIAL", "COMPLETE"] as const) {
    const html = rail({ ...base, task: { ...clockTask, status }, complete: status === "COMPLETE" });
    assert.doesNotMatch(html, /aria-current="step"|data-clock="running"|正在工作/);
    assert.ok(html.includes('data-clock="stopped"') && html.includes("已停止计时"));
    assert.ok(html.includes("2分 5秒"));
  }
  const queued = rail({ ...base, busy: true, task: { ...clockTask, status: "QUEUED" } });
  assert.ok(queued.includes("排队中") && !queued.includes("正在工作"));
  const unknown = rail({ ...base, busy: true, task: { ...clockTask, unknownOutcome: true } });
  assert.doesNotMatch(unknown, /aria-current="step"|data-clock="running"/);
  const invalid = rail({ ...base, task: { ...clockTask, createdAt: "bad" } });
  assert.doesNotMatch(invalid, /NaN|本任务历时/);
  const requestClock = { ...base, busy: true, task: clockTask, activeCallStartedAt: '2026-09-14T00:01:00.000Z' };
  const requestHtml = rail(requestClock);
  assert.ok(requestHtml.includes('当前请求已等待：1分 5秒'));
  assert.doesNotMatch(requestHtml, /本任务历时|纯工作耗时/);
  const stoppedRequest = rail({ ...requestClock, busy: false, task: { ...clockTask, status: 'WAITING_USER' } });
  assert.ok(stoppedRequest.includes('本任务历时（含等待）：2分 5秒'));
  assert.doesNotMatch(stoppedRequest, /当前请求已等待|data-clock="running"/);
  const badRequest = rail({ ...requestClock, activeCallStartedAt: 'bad' });
  assert.ok(badRequest.includes('本任务历时（含等待）：2分 5秒'));
  assert.doesNotMatch(badRequest, /NaN/);
  assert.match(read("app/projects/[projectId]/foundation-delivery.module.css"), /prefers-reduced-motion: reduce/);
});

check("worker消失后中断与未知结果同时可见，不能显示普通继续或活动计时", () => {
  const interrupted: FoundationDeliveryState = { ...base, busy: false, action: 'UNKNOWN_CONFIRM', activeCallStartedAt: '2026-09-14T03:03:19.000Z', task: task({ status: 'INTERRUPTED', unknownOutcome: true, createdAt: '2026-09-14T02:20:00.000Z', updatedAt: '2026-09-14T03:03:19.000Z' }) };
  for (const compact of [false, true]) {
    const html = renderToStaticMarkup(createElement(FoundationDeliveryPanel, { projectId: 'project-1', state: interrupted, requiredChoiceCount: 0, compact }));
    assert.match(html, /处理中断|处理已中断/);
    assert.match(html, /请求结果.*确认/);
    assert.ok(html.includes('name="allowUnknownRetry"') && html.includes('required=""'));
    assert.ok(buttons(html).some(button => button.body === '确认重发并继续'));
    assert.ok(!buttons(html).some(button => button.body === '继续完成'));
    assert.doesNotMatch(html, /class="live"|正在整理…/);
  }
  const rail = renderToStaticMarkup(createElement(FoundationWorkflowStatus, { projectId: 'project-1', state: interrupted, sourceReady: true, sceneCount: 3, remaining: [] }));
  assert.match(rail, /处理已中断/);
  assert.match(rail, /data-clock="stopped"/);
  assert.doesNotMatch(rail, /aria-current="step"|data-clock="running"|当前请求已等待|当前工作：/);
});

check("客户端保留轮询直到服务回报非busy，然后清理计时器", () => {
  const reactPath = require.resolve('react'), panelPath = require.resolve('../app/projects/[projectId]/foundation-delivery-panel');
  const reactModule = require.cache[reactPath]!, navigationModule = require.cache[navigationPath]!;
  const originalReact = reactModule.exports, originalNavigation = navigationModule.exports, originalPanel = require.cache[panelPath];
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let effect: (() => undefined | (() => void)) | undefined, tick: (() => void) | undefined, refreshes = 0, cleared = 0, intervals = 0;
  try {
    reactModule.exports = { ...originalReact, useEffect: (callback: typeof effect) => { effect = callback; } };
    navigationModule.exports = { useRouter: () => ({ refresh: () => { refreshes++; } }) };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { setInterval: (callback: () => void, delay: number) => { assert.equal(delay, 3000); tick = callback; intervals++; return 71; }, clearInterval: (id: number) => { assert.equal(id, 71); cleared++; } } });
    delete require.cache[panelPath];
    const { FoundationDeliveryPanel: Panel } = require(panelPath) as typeof import('../app/projects/[projectId]/foundation-delivery-panel');
    Panel({ projectId: 'project-1', state: { ...base, busy: true, task: task() }, requiredChoiceCount: 0, compact: true });
    const cleanup = effect!();
    tick!(); tick!(); // A server/worker disappearance does not cancel this client timer.
    assert.equal(refreshes, 2);
    cleanup!();
    Panel({ projectId: 'project-1', state: { ...base, busy: false, action: 'UNKNOWN_CONFIRM', task: task({ status: 'INTERRUPTED', unknownOutcome: true }) }, requiredChoiceCount: 0, compact: true });
    assert.equal(effect!(), undefined);
    assert.equal(intervals, 1);
    assert.equal(cleared, 1);
  } finally {
    reactModule.exports = originalReact;
    navigationModule.exports = originalNavigation;
    require.cache[panelPath] = originalPanel;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
  }
});

check("SSR无提交且不改输入", () => { assert.equal(actionCalls, 0); assert.equal(JSON.stringify(base), before); });

for (const failure of failures) console.error(`FAIL ${failure}`);
assert.equal(failures.length, 0, `${failures.length}/${checks} delivery UI checks failed`);
console.log(`PASS ${checks} delivery UI checks: real SSR, explicit retry consent, readable work document, choice continuation and read-only page wiring (not browser verification)`);
