/** Synthetic evidence only: no database writes, actions, or provider calls. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require.extensions[".css"] = module => { module.exports = {}; };
const { FoundationViewer } = require("../app/projects/[projectId]/foundation-viewer") as typeof import("@/app/projects/[projectId]/foundation-viewer");

type State = Parameters<typeof FoundationViewer>[0]["state"];
const checks: Array<[string, () => void | Promise<void>]> = [];
const check = (name: string, run: () => void | Promise<void>) => checks.push([name, run]);
const ref = { episode: 1, startLine: 2, endLine: 3 };
const privateText = "TRANSPORT_OUTPUT_MUST_NOT_LEAK";
const draftData = () => ({
  coverage: Array.from({ length: 28 }, (_, index) => index + 1),
  assets: [{ key: "hero", name: "新稿人物", type: "CH", aliases: ["完整别名"], description: "完整身份定义", sourceRefs: [ref], descriptionVariants: [{ text: "另一个有据描述", sourceRefs: [ref] }] }],
  episodes: Array.from({ length: 28 }, (_, index) => ({ number: index + 1, context: `第${index + 1}集新稿上下文`, uses: [
    { key: "hero", presence: "ONSTAGE", state: `第${index + 1}集完整源状态`, sourceName: "当场工作标签", sourceRefs: [{ ...ref, episode: index + 1 }] },
    { key: "hero", presence: "BACKGROUND", purpose: "仅供当集理解的完整背景用途", sourceRefs: [ref] }
  ] })),
  issues: [{ severity: "MAJOR", owner: "F2", coordinate: "assets.hero", problem: "待独审问题正文", sourceRefs: [ref] }],
  extraAuthorField: { note: "额外字段也不能丢" }
});

function fixture(data: unknown = draftData(), rawOutput = "完整原始输出尾部"): State {
  const common = { schema: "FOUNDATION_CANDIDATE_V1" as const, createdAt: new Date(0).toISOString(), sourceVersion: "source", inputVersion: "input", batchToken: "batch", scope: [1], mechanicalIssues: [] };
  const run = (stageCode: string) => ({ id: `${stageCode}-run`, projectId: "project", episodeId: null, stageCode, roleName: stageCode, provider: "CLI", model: "test-model", status: "SUCCEEDED" as const, inputSummary: null, outputSummary: null, log: null, error: null, startedAt: null, finishedAt: null, durationMs: 10, createdAt: new Date(0) });
  return {
    preprocessReady: true, planningReady: true, assetsReady: false, dataReady: false, dataIssues: [], f2Recovery: null, reviewReady: false, ready: false, draftComplete: false, finalOutput: null,
    sourceContext: { version: "fixture", background: [], unresolved: [], issues: [], complete: true, notices: [], coverage: "COMPLETE" }, recoveries: { F1: null, F2: null, Q1: null }, methodVersions: { F1: "fixture-f1", F2: "fixture-f2", Q1: "fixture-q1" },
    message: "本次F2运行失败，原记录保留", sourceVersion: "source", inputVersion: "input",
    candidates: {
      f1: { ...common, id: "f1", runId: "F1-run", stageCode: "F1", upstreamSnapshotIds: {}, output: { coverage: [1], overview: "当前F1全剧理解", episodes: [{ number: 1, summary: "F1摘要", context: "当前F1上下文", sourceSelections: [] }], issues: [] } },
      f2: { ...common, id: "old-f2", runId: "old-F2-run", stageCode: "F2", upstreamSnapshotIds: { f1: "old-f1" }, output: { coverage: [1], assets: [], episodes: [{ number: 1, context: "旧候选正文独立保留", assetKeys: [] }], issues: [] } }
    },
    review: null, approved: null,
    latestRuns: { f1: run("F1"), f2: { ...run("F2"), status: "FAILED", log: JSON.stringify({
      schema: "FOUNDATION_RUN_EVIDENCE_V1", runId: "F2-run", stageCode: "F2", sourceVersion: "source", inputVersion: "input", upstreamSnapshotIds: { f1: "f1" },
      calls: [{ sequence: 1, scope: Array.from({ length: 28 }, (_, index) => index + 1), status: "FAILED", response: { data, rawOutput, stdout: privateText, stderr: privateText } }],
      stdout: privateText, stderr: privateText
    }) }, q1: null }
  } as State;
}
const render = (state: State) => renderToStaticMarkup(createElement(FoundationViewer, { state }));

check("失败首片28集正文与旧候选分区，可展开阅读全部状态和来源", () => {
  const html = render(fixture());
  for (const text of ["本次已生成草稿（未验收/不完整）", "第1–28集", "运行失败", "第28集新稿上下文", "第28集完整源状态", "完整身份定义", "完整别名", "另一个有据描述", "当场工作标签", "完整背景用途", "待独审问题正文", "额外字段也不能丢", "完整原始输出尾部", "旧候选正文独立保留", "历史候选 · 不供当前生产"]) assert.ok(html.includes(text), `未呈现：${text}`);
  assert.ok(html.includes("<details"));
  assert.ok(!html.includes(privateText));
  assert.ok(!html.includes("当前版本已批准"));
  const start = html.indexOf('id="foundation-drafts"');
  const draftSection = html.slice(start, html.indexOf("</section>", start));
  assert.ok(draftSection.includes("第28集新稿上下文"));
  assert.ok(draftSection.includes('data-run-id="F2-run"') && draftSection.includes("运行记录：F2-run"), "草稿应明确对应岗位及运行记录");
  assert.ok(!draftSection.includes("旧候选正文独立保留"), "不能把旧候选混成新草稿");
});

check("草稿先呈现逐集入口，身份定义默认折叠，标量数组紧凑且不改顺序", () => {
  const data = draftData();
  data.assets[0].aliases = ["别名乙", "别名甲", "别名乙"];
  data.assets.push({ ...data.assets[0], key: "second", name: "第二项后台定义" });
  const html = render(fixture(data));
  const start = html.indexOf('id="foundation-drafts"');
  const draftSection = html.slice(start, html.indexOf("</section>", start));
  const episodes = draftSection.indexOf('data-draft-section="episodes"');
  const assets = draftSection.indexOf('data-draft-section="assets"');
  assert.ok(episodes >= 0 && assets > episodes, "逐集正文入口须在身份定义之前");
  assert.match(draftSection, /<div data-draft-section="episodes"><h4>逐集草稿正文<\/h4>/, "顶层逐集入口默认可见，不再额外折叠");
  assert.ok(draftSection.indexOf("<summary>第1集</summary>") > episodes && draftSection.indexOf("<summary>第1集</summary>") < assets);
  const assetOpening = draftSection.slice(draftSection.lastIndexOf("<details", assets), draftSection.indexOf(">", assets) + 1);
  assert.ok(!assetOpening.includes("open="), "身份定义顶层应默认折叠");
  assert.ok(draftSection.includes("身份定义与描述（2项）"));
  assert.ok(draftSection.includes(data.coverage.join("、")), "coverage不能每个数字占一格或被改写");
  assert.ok(draftSection.includes("别名乙、别名甲、别名乙"), "别名不排序、不去重、不改原文");
  assert.ok(!draftSection.includes('class="bibleLine"'), "普通字段不再逐格套外框");
  for (const text of ["第28集新稿上下文", "完整身份定义", "完整原始 data", "完整原始 rawOutput"]) assert.ok(draftSection.includes(text));
});

check("坏data、空/null/数组、坏typed字段与raw-only不会崩溃或误称完成", () => {
  for (const data of [null, [], "正文字符串", 3, {}, { episodes: null }, { assets: [null, 3], episodes: [null, { number: {}, context: [], uses: [null, { state: {} }] }], issues: "非数组" }, JSON.parse('{"__proto__":{"context":"特殊字段原文"},"constructor":"额外属性","episodes":[{"number":1,"uses":[{"presence":"__proto__"}]}]}')]) {
    const html = render(fixture(data, "RAW_ONLY_READABLE"));
    assert.ok(html.includes("RAW_ONLY_READABLE"));
    assert.ok(!html.includes(privateText));
    assert.ok(!/已完成\s*\d+\s*集|可复用\s*\d+|当前版本已批准/.test(html));
  }
  const rawOnly = fixture();
  const log = JSON.parse(rawOnly.latestRuns.f2!.log!);
  delete log.calls[0].response.data;
  log.calls[0].response.rawOutput = "只有原始文本仍可读";
  rawOnly.latestRuns.f2!.log = JSON.stringify(log);
  const html = render(rawOnly);
  assert.ok(html.includes("只有原始文本仍可读"));
  assert.ok(html.includes("仅原始文本"));
  for (const log of ["{broken", "null", "[]", '{"calls":{}}', '{"calls":[null,{},3]}']) {
    const state = fixture(); state.latestRuns.f2!.log = log;
    assert.doesNotThrow(() => render(state));
  }
});

check("源文本和原始输出始终按文本转义", () => {
  const attack = '<script>alert("source")</script><img src=x onerror=alert(1)>';
  const html = render(fixture({ episodes: [{ number: 1, context: attack, uses: [] }], assets: [] }, attack));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img src=x"));
});

check("纯reader只取已保存响应，深拷贝全部data且不带执行输出", async () => {
  assert.ok(existsSync("lib/foundation-draft.ts"), "需要独立的只读草稿读取器");
  const { readFoundationDrafts } = await import("@/lib/foundation-draft");
  const state = fixture();
  const log = JSON.parse(state.latestRuns.f2!.log!);
  const before = JSON.stringify(log);
  const result = readFoundationDrafts({ ...state, latestRuns: { ...state.latestRuns, f2: { ...state.latestRuns.f2!, log } } });
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].chunks[0].data, log.calls[0].response.data);
  assert.notEqual(result[0].chunks[0].data, log.calls[0].response.data);
  assert.equal(result[0].chunks[0].rawOutput, log.calls[0].response.rawOutput);
  assert.equal(JSON.stringify(log), before);
  assert.ok(!JSON.stringify(result).includes(privateText));
  (result[0].chunks[0].data as ReturnType<typeof draftData>).episodes[0].context = "改返回值不影响原稿";
  assert.equal(JSON.stringify(log), before);
});

check("新运行草稿独立显示，完整当前候选不重复展示，过期日志明确历史", async () => {
  const active = fixture(); active.latestRuns.f2!.status = "RUNNING";
  assert.ok(render(active).includes("运行中"));
  const complete = fixture(); complete.assetsReady = true;
  complete.latestRuns.f2!.status = "SUCCEEDED";
  complete.candidates.f2!.runId = complete.latestRuns.f2!.id;
  assert.ok(!render(complete).includes("本次已生成草稿（未验收/不完整）"));
  const stale = fixture();
  const log = JSON.parse(stale.latestRuns.f2!.log!); log.sourceVersion = "old-source";
  stale.latestRuns.f2!.log = JSON.stringify(log);
  assert.ok(render(stale).includes("历史运行草稿"));
  assert.ok(!render(stale).includes("本次已生成草稿（未验收/不完整）"));
  const replacedUpstream = fixture(); replacedUpstream.planningReady = false;
  replacedUpstream.latestRuns.f1 = { ...replacedUpstream.latestRuns.f1!, id: "new-f1-run", status: "FAILED" };
  assert.ok(render(replacedUpstream).includes("历史运行草稿"), "上游已换新执行，旧F2不能再称本次草稿");
});

check("后台有源定义没有逐集登记时不能宣称出现", () => {
  const state = fixture();
  state.candidates.f2!.output.assets = [{ key: "backend", name: "后台身份", type: "CH", aliases: [], description: "人物小传中有据的后台定义", sourceRefs: [{ episode: 0, startLine: 1, endLine: 2 }], appearances: [] }];
  const html = render(state);
  assert.ok(html.includes("后台定义／未登记逐集使用"));
  assert.ok(!html.includes("第0集 · 入场"));
  const raw = draftData(); raw.episodes = [];
  const draftHtml = render(fixture(raw));
  assert.ok(draftHtml.includes("后台定义／未登记逐集使用"), "已保存原始草稿中的纯后台定义也须明确标注");
});

check("连续入口绑定当前状态，工作稿持续可读，旧恢复协议仅保留历史兼容", () => {
  const page = readFileSync("app/projects/[projectId]/page.tsx", "utf8");
  const controls = readFileSync("app/projects/[projectId]/foundation-actions.tsx", "utf8");
  const delivery = readFileSync("app/projects/[projectId]/foundation-delivery-panel.tsx", "utf8");
  const document = readFileSync("app/projects/[projectId]/foundation-document-viewer.tsx", "utf8");
  assert.equal((page.match(/<FoundationDeliveryPanel\b/g) ?? []).length, 1);
  assert.ok(page.includes("expectedState: delivery.expectedState"));
  assert.equal((delivery.match(/name="expectedState"/g) ?? []).length, 1, "单一续作表单绑定后端返回的当前意图");
  assert.ok(delivery.includes("startFoundationDeliveryAction") && delivery.includes("继续完成"));
  assert.ok(!page.includes("startProjectFoundationAction") && !page.includes("continueProjectFoundationAction"));
  assert.ok(page.includes("<FoundationDocumentViewer state={delivery} />"), "正文始终读取保留工作稿");
  assert.ok(!page.includes("studio.firstPhase.draftComplete") && !page.includes("studio.firstPhase.ready"), "可读性不能以旧批准门禁控制");
  assert.ok(document.includes("state.document") && document.includes("state.previousDocument") && !document.includes("state.ready"));
  assert.ok(page.includes("处理历史与运行设置") && !page.includes("<FoundationActions"));
  assert.ok(controls.includes("整批重跑 F1 → F2 → Q1") && controls.includes("本次版本核对"), "旧恢复工具代码保留，但不再是页面入口");
  assert.ok(controls.includes("{stage} 已保存") && controls.includes("本次新增调用"), "历史恢复范围仍有确切边界");
  assert.ok(delivery.includes("state.availableEpisodes") && delivery.includes("task.addedCalls") && delivery.includes("task.repairCalls"), "处理统计来自真实交付状态");
  assert.ok(delivery.includes('type="checkbox" name="allowUnknownRetry" value="yes" required'), "未知请求只能显式同意费用风险后重发");
  assert.ok(page.includes("searchParams?: Promise"));
  assert.ok(page.includes('foundationNotice === "state-changed"'));
  assert.match(page, /foundationNotice === "state-changed"\s*\?\s*"页面状态已更新，本次未发起新调用；请核对当前资料后再继续。"/, "状态变化固定提示，不回显任意query");
  assert.ok(page.includes('{notice ? <p role="status"') && !page.includes("{foundationNotice}"));
});

async function main() {
  let failed = 0;
  for (const [name, run] of checks) {
    try { await run(); console.log(`PASS ${name}`); }
    catch (error) { failed++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); }
  }
  if (failed) process.exitCode = 1;
  else console.log(`PASS foundation draft view: ${checks.length} synthetic checks`);
}
void main();
