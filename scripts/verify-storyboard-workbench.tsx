import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
require.extensions[".css"] = module => { module.exports = {}; };
const { StoryboardWorkbench, ReplanAction, RunFeedback, RecoveryActions, deriveWorkbenchState, mergeSourceWarnings } = require("../app/projects/[projectId]/episodes/[episodeId]/storyboard/workbench") as typeof import("../app/projects/[projectId]/episodes/[episodeId]/storyboard/workbench");
const html = renderToStaticMarkup(createElement(StoryboardWorkbench, { episodeId: "episode-test", episodeTitle: "测试集" }));
assert.ok(html.includes("GPT-6.1 Sol · CLI 中档"), "新分镜应显示当前模型与中档思考");

for (const label of ["情绪统筹", "完整主创", "统一整编", "幻想", "CLI", "额度", "新建任务"]) {
  assert.ok(html.includes(label), `缺少 ${label}`);
}
assert.ok(html.includes("15") && html.includes("30"));
assert.ok(html.includes('value="32"') && html.includes('value="300000"'));
assert.ok(!html.includes("<script"));
const source = readFileSync(new URL("../app/projects/[projectId]/episodes/[episodeId]/storyboard/workbench.tsx", import.meta.url), "utf8");
const advanced = html.match(/<details\b([^>]*)><summary>高级设置（可选）<\/summary>([\s\S]*?)<\/details>/);
assert.ok(advanced, "高级设置应为原生 details 结构");
assert.ok(!/\bopen\b/.test(advanced[1]), "高级设置应默认关闭");
for (const name of ["最多调用次数", "计划 Token 停止线", "创作备注"]) {
  assert.ok(advanced[2].includes(name), `${name} 应在高级设置内`);
}
assert.ok(advanced[2].includes('value="32"') && advanced[2].includes('value="300000"'), "折叠后仍应渲染原默认额度");
assert.ok(advanced[2].includes("<textarea"), "创作备注仍应是可编辑控件");
const budgetDetails = source.match(/<details className=\{styles\.advancedDetails\}><summary>高级额度设置<\/summary>([\s\S]*?)<\/details>/)?.[1];
assert.ok(budgetDetails?.includes("调用次数停止线") && budgetDetails.includes("Token 停止线") && budgetDetails.includes("保存预算"), "已有任务的预算编辑与保存应同在高级额度设置内");
assert.ok(source.includes('notes: settings.notes, maxCalls: settings.maxCalls, maxTokens: settings.maxTokens'), "新建任务仍发送原有设置值");
assert.ok(source.includes('onClick={() => void act("budget", budget)}'), "保存预算仍发送现有预算 state");
for (const field of ["maxCalls", "maxTokens", "notes"]) assert.ok(source.includes(`setSettings({ ...settings, ${field}:`), `${field} 仍应更新设置 state`);
for (const field of ["maxCalls", "maxTokens"]) assert.ok(source.includes(`setBudget({ ...budget, ${field}:`), `${field} 仍应更新预算 state`);
for (const label of ["先分析", "连续完成", "确认幻想选择", "局部返修", "导出 Markdown"]) assert.ok(source.includes(label), `缺少 ${label}`);
assert.ok(source.includes('"x-storyboard-action": "1"') && source.includes('action === "create"'));
const basic = { status: "planned", active: false, sourceStale: false, operations: [], selection: { status: "ready" }, assembly: null, plan: { workPackages: [{ id: "P1" }, { id: "P2" }] }, adopted: [{ stage: "author", packageIds: ["P1"] }, { stage: "finish", packageIds: ["P1"] }] };
const state = deriveWorkbenchState(basic, true);
assert.equal(state.canRun, true);
assert.equal(state.downloadable, false);
assert.equal(state.authorDone, 1);
assert.equal(state.finishDone, 1);
const fullyFinished = deriveWorkbenchState({ ...basic, adopted: [{ stage: "finish", packageIds: ["P1", "P2"] }] }, true);
assert.equal(fullyFinished.authorDone, 2);
assert.equal(fullyFinished.finishDone, 2);
assert.deepEqual(mergeSourceWarnings(["同一提示", "仅索引"], ["同一提示", "仅任务"]), ["同一提示", "仅索引", "仅任务"]);
assert.equal(deriveWorkbenchState({ ...basic, status: "text_ready_for_review", assembly: { text: "正文", errors: [] } }, true).downloadable, true);
assert.equal(deriveWorkbenchState({ ...basic, status: "text_ready_for_review", assembly: { text: "正文", errors: ["问题"] } }, true).downloadable, false);
assert.equal(deriveWorkbenchState({ ...basic, status: "text_ready_for_review", sourceStale: true, assembly: { text: "正文", errors: [] } }, true).downloadable, false);
assert.match(deriveWorkbenchState({ ...basic, sourceStale: true }, true).feedback, /原文或前情资料已更新.*旧结果仍已保存，可查看/);
assert.equal(deriveWorkbenchState({ ...basic, status: "unknown" }, true).canRun, false);
const usageOperation = { attemptId: "saved-usage", status: "completed", stage: "author", packageIds: ["P1"], canRecoverSaved: false };
const usageCheck = { attemptId: "saved-usage", kind: "usage" as const, canAcknowledge: true, reason: "这次结果已保存，但用量未完整返回" };
const usageReview = { ...basic, status: "usage_review", operations: [usageOperation], cancellations: [usageCheck] };
const usageReviewState = deriveWorkbenchState(usageReview, true);
assert.equal(usageReviewState.canRun, false, "成功回包但用量待确认时不能直接启动新调用");
assert.equal(usageReviewState.unresolved, true);assert.equal(usageReviewState.returnedCalls, 1);
assert.match(usageReviewState.feedback, /回包已保存.*用量未知/);
assert.doesNotMatch(usageReviewState.feedback, /中断|失败|未完成的调用|达到预算/);
assert.equal(deriveWorkbenchState({ ...usageReview, status: "planned" }, true).canRun, false, "费用核对仍待处理时不能由正文状态绕过确认");
const acknowledgedUsage = { ...usageOperation, cancelAcknowledgement: { at: "2026-09-30T00:01:00Z", acceptUnknownUsage: true as const, kind: "usage" as const } };
assert.equal(deriveWorkbenchState({ ...basic, operations: [acknowledgedUsage], cancellations: [] }, true).canRun, true);
const usageRecoveryMarkup = renderToStaticMarkup(createElement(RecoveryActions, { operations: [usageOperation], cancellations: [usageCheck], disabled: false, onRecover: () => {}, onAcknowledge: () => {} }));
for (const message of ["确认接受未知用量", "结果已保存", "只解除费用阻断", "不自动重发", "仅补未完成步骤"]) assert.ok(usageRecoveryMarkup.includes(message), `用量确认入口缺少${message}`);
assert.doesNotMatch(usageRecoveryMarkup, /检查并恢复已有回包|中断风险|失败风险|超时风险/);
assert.equal(renderToStaticMarkup(createElement(RecoveryActions, { operations: [acknowledgedUsage], cancellations: [usageCheck], disabled: false, onRecover: () => {}, onAcknowledge: () => {} })), "", "已确认用量风险不应重复显示入口");
assert.ok(!renderToStaticMarkup(createElement(RecoveryActions, { operations: [usageOperation], cancellations: [{ ...usageCheck, canAcknowledge: false }], disabled: false, onRecover: () => {}, onAcknowledge: () => {} })).includes("确认接受未知用量"), "后端未允许确认时不能仅凭completed提供入口");
assert.match(renderToStaticMarkup(createElement(RunFeedback, { state: usageReviewState, pendingAction: "acknowledge_usage", disabled: true, onRecheck: () => {} })), /正在确认未知用量.*不启动新调用/);
assert.equal(deriveWorkbenchState({ ...basic, operations: [{ status: "unknown" }] }, true).canRun, false);
assert.equal(deriveWorkbenchState({ ...basic, status: "interrupted" }, true).canRun, false);
assert.equal(deriveWorkbenchState({ ...basic, active: false, operations: [{ status: "running" }] }, true).canRun, false);
assert.equal(deriveWorkbenchState({ ...basic, selection: { status: "awaiting_confirmation" } }, true).canRun, false);
assert.equal(deriveWorkbenchState({ ...basic, selection: { status: "needs_design" } }, true).canRun, false);
const needsDesign = { ...basic, adopted: [], selection: { status: "needs_design" } };
assert.equal(deriveWorkbenchState(needsDesign, true).canReplan, true);
assert.equal(deriveWorkbenchState({ ...needsDesign, adopted: [{ stage: "author", packageIds: ["P1"] }] }, true).canReplan, false);
assert.equal(deriveWorkbenchState({ ...needsDesign, operations: [{ status: "unknown" }] }, true).canReplan, false);
assert.equal(deriveWorkbenchState({ ...needsDesign, sourceStale: true }, true).canReplan, false);
assert.equal(deriveWorkbenchState({ ...needsDesign, budget: { maxCalls: 0, maxTokens: 300000 } }, true).canReplan, false);
const replanEnabled = renderToStaticMarkup(createElement(ReplanAction, { visible: true, disabled: false, onClick: () => {} }));
assert.ok(replanEnabled.includes("补充幻想规划（一次CLI调用）") && !replanEnabled.includes("disabled="));
assert.ok(renderToStaticMarkup(createElement(ReplanAction, { visible: true, disabled: true, onClick: () => {} })).includes("disabled="));
assert.equal(renderToStaticMarkup(createElement(ReplanAction, { visible: false, disabled: false, onClick: () => {} })), "");
assert.equal(deriveWorkbenchState({ ...basic, budget: { maxCalls: 0, maxTokens: 300000 } }, true).canRun, false);
assert.equal(deriveWorkbenchState({ ...basic, operations: [{ status: "running", stage: "finish", packageIds: ["P2"] }] }, true).current?.stage, "finish");
assert.equal(deriveWorkbenchState({ ...basic, active: true, operations: [{ status: "running", stage: "author" }] }, true).planLabel, "规划已就绪", "正文执行时不能把已通过规划显示成分析中");
const analysis = { ...basic, plan: null, adopted: [], budget: { maxCalls: 32, maxTokens: 300000 }, candidates: [] };
const running = deriveWorkbenchState({ ...analysis, status: "running", active: true, operations: [{ status: "running", stage: "plan" }] }, true);
assert.match(running.feedback, /正在情绪统筹/);
assert.ok(!running.feedback.includes("请求已提交"), "运行中记录也可能还在排队，不能声称已发送模型请求");
assert.equal(running.canRun, false);
const executionEvidence = { phase: "waiting" as const, startedAt: "2026-09-30T00:00:00.000Z", lastEventAt: "2026-09-30T00:00:10.000Z", lastProgressAt: null, eventCount: 50, timeoutKind: null, limits: { startupMs: 30000, idleMs: 60000, totalMs: 180000 }, workload: { stage: "author", promptChars: 1200, unitCount: 2 }, lastEventType: "thread.started" };
for (const [phase, message] of [["starting", "正在启动CLI"], ["waiting", "等待模型响应（尚未观察到生成进展）"], ["generating", "已观察到生成进展"], ["receiving", "收到正文，正在处理"]] as const) {
  const evidenceState = deriveWorkbenchState({ ...analysis, status: "running", active: true, operations: [{ status: "running", stage: "author", execution: { ...executionEvidence, phase, lastProgressAt: ["generating", "receiving"].includes(phase) ? "2026-09-30T00:00:08Z" : null } }] }, true);
  const evidenceMarkup = renderToStaticMarkup(createElement(RunFeedback, { state: evidenceState, pendingAction: "", disabled: false, onRecheck: () => {} }));
  assert.ok(evidenceMarkup.includes(message), `执行阶段缺少${message}`);
  assert.match(evidenceMarkup, /已运行.*启动等待预算.*无生成进展预算.*总时长上限/);
  assert.doesNotMatch(evidenceMarkup, /\d+%/, "没有可核验分母时不能显示进度百分比");
  if (phase === "waiting") assert.doesNotMatch(evidenceMarkup, /已观察到生成进展/, "事件计数或stderr心跳不能冒充生成进展");
}
const timeoutState = deriveWorkbenchState({ ...analysis, status: "unknown", operations: [{ status: "unknown", stage: "author", execution: { ...executionEvidence, phase: "failed", timeoutKind: "idle", lastProgressAt: "2026-09-30T00:00:08Z" } }] }, true);
const timeoutFeedback = renderToStaticMarkup(createElement(RunFeedback, { state: timeoutState, error: { code: "TIMEOUT", message: "生成进展等待超时" }, pendingAction: "", disabled: false, onRecheck: () => {} }));
assert.match(timeoutFeedback, /TIMEOUT.*生成进展等待超时/);assert.match(timeoutFeedback, /无生成进展超时/);assert.match(timeoutFeedback, /最近生成进展/);assert.match(timeoutFeedback, /已观察到生成进展（历史证据）/);
assert.doesNotMatch(timeoutFeedback, /本次执行已结束/, "失败阶段不是本机进程组已退出的证据");
const incompleteEvidence = deriveWorkbenchState({ ...analysis, status: "unknown", operations: [{ status: "unknown", stage: "author", execution: { ...executionEvidence, phase: "failed", limits: { startupMs: null, idleMs: null, totalMs: null } } }] }, true);
assert.match(renderToStaticMarkup(createElement(RunFeedback, { state: incompleteEvidence, pendingAction: "", disabled: false, onRecheck: () => {} })), /启动等待预算 未知.*无生成进展预算 未知.*总时长上限 未知/, "缺失预算不能显示成零");
const legacyFeedback = renderToStaticMarkup(createElement(RunFeedback, { state: running, pendingAction: "", disabled: false, onRecheck: () => {} }));
assert.doesNotMatch(legacyFeedback, /正在启动CLI|已观察到生成进展|已运行|最近生成进展|总时长上限/, "旧回执不能伪造执行阶段或计时");
const scheduling = { maxConcurrent: 4, maxPerEpisode: 2, inFlight: 0, queued: 1 };
const queued = deriveWorkbenchState({ ...analysis, status: "running", active: true, scheduling }, true);
assert.match(queued.feedback, /排队等待执行空位/);
assert.doesNotMatch(deriveWorkbenchState({ ...analysis, status: "running", active: true, scheduling: { ...scheduling, inFlight: 1 } }, true).feedback, /排队等待执行空位/);
assert.match(deriveWorkbenchState({ ...analysis, status: "pausing", active: true, scheduling }, true).feedback, /正在暂停/);
assert.match(deriveWorkbenchState({ ...analysis, status: "unknown", active: true, scheduling }, true).feedback, /未完成的调用待处理/);
const failed = { ...analysis, status: "needs_repair", operations: [{ status: "completed", stage: "plan" }], candidates: [{ id: "c1", stage: "plan", status: "needs_repair" }] };
const returned = deriveWorkbenchState(failed, true);
assert.match(returned.feedback, /分析已返回，规划校验未通过，结果已保存/);
assert.equal(returned.calls, 1);assert.equal(returned.returnedCalls, 1);
assert.equal(returned.planLabel, "分析已返回 · 规划待修");
assert.equal(returned.nextLabel, "修复规划/继续");
assert.ok(!returned.noPlanMessage.includes("点击“先分析”"));
assert.equal(returned.canRecheck, true);
assert.equal(deriveWorkbenchState({ ...failed, budget: { maxCalls: 0, maxTokens: 0 } }, false).canRecheck, true, "免费重校不依赖模型环境或调用预算");
for (const patch of [{ active: true }, { sourceStale: true }, { status: "unknown" }]) assert.equal(deriveWorkbenchState({ ...failed, ...patch }, true).canRecheck, false);
const resolved = deriveWorkbenchState({ ...analysis, status: "planned", candidates: [{ ...failed.candidates[0], resolvedBy: "c2" }], plan: basic.plan }, true);
assert.equal(resolved.planFailure, undefined);assert.ok(!resolved.feedback.includes("校验未通过"));
for (const selectionStatus of ["ready", "awaiting_confirmation", "needs_design"]) {
  const failedSupplement = { ...failed, plan: basic.plan, selection: { status: selectionStatus } };
  const supplementState = deriveWorkbenchState(failedSupplement, true);
  assert.equal(supplementState.planFailure?.id, "c1", "有旧规划也必须识别新规划的未解决失败");
  assert.match(supplementState.feedback, /新规划已返回但校验未通过，保留上一版规划/);
  assert.equal(supplementState.planLabel, "新规划待修 · 旧版保留");
  assert.equal(supplementState.nextLabel, "修复规划/继续");
  assert.equal(supplementState.canRun, true, "旧幻想选择只阻止正文，不能阻止修复新规划");
  assert.equal(supplementState.canRecheck, true);
  assert.equal(supplementState.canReplan, false, "已有失败规划应先定向修复，不另起无关补充调用");
  for (const patch of [{ active: true }, { sourceStale: true }, { status: "unknown" }, { budget: { maxCalls: 0, maxTokens: 0 } }]) assert.equal(deriveWorkbenchState({ ...failedSupplement, ...patch }, true).canRun, false);
  const afterRepair = deriveWorkbenchState({ ...failedSupplement, status: "planned", candidates: [{ ...failed.candidates[0], resolvedBy: "c2" }] }, true);
  assert.equal(afterRepair.planFailure, undefined);
  assert.equal(afterRepair.canRun, selectionStatus === "ready", "修复成功后应恢复幻想选择的正文门禁");
  const supplementFeedback = renderToStaticMarkup(createElement(RunFeedback, { state: supplementState, pendingAction: "", disabled: false, onRecheck: () => {} }));
  assert.ok(supplementFeedback.includes("保留上一版规划") && supplementFeedback.includes("重新核查候选（不调用模型）") && !supplementFeedback.includes("disabled="));
}
const feedback = renderToStaticMarkup(createElement(RunFeedback, { state: returned, error: { code: "ENTRY_FACT_EVIDENCE", detail: "前情证据不匹配" }, pendingAction: "", disabled: false, onRecheck: () => {} }));
for (const text of ["分析已返回", "调用记录 1 次", "已返回 1 次", "ENTRY_FACT_EVIDENCE", "前情证据不匹配", "重新核查候选（不调用模型）", "定向修复一次"]) assert.ok(feedback.includes(text), `反馈缺少 ${text}`);
assert.ok(feedback.includes('role="status"') && feedback.includes('role="alert"'));
assert.ok(!feedback.includes("停止线"), "额度停止线只留在折叠的高级设置中");
const submitting = renderToStaticMarkup(createElement(RunFeedback, { state: returned, pendingAction: "start:next", disabled: true, onRecheck: () => {} }));
assert.ok(submitting.includes("正在提交") && submitting.includes("disabled="));
assert.ok(html.includes("新建任务（仅准备）") && html.includes("新建仅准备原文"), "新建与模型运行的边界应直接可见");
const paused = deriveWorkbenchState({ ...basic, status: "paused" }, true);
assert.match(paused.feedback, /已暂停/);assert.equal(paused.canRun, true);
const pausing = deriveWorkbenchState({ ...basic, status: "pausing", active: true }, true);
assert.match(pausing.feedback, /回包/);assert.equal(pausing.canRun, false);
const acknowledgedOperation = { status: "unknown", stage: "author", cancelAcknowledgement: { at: "2026-09-25T00:00:00Z", acceptUnknownUsage: true as const } };
assert.equal(deriveWorkbenchState({ ...basic, status: "paused", operations: [acknowledgedOperation] }, true).canRun, true, "已明确确认的中断不应永久占据运行锁");
const recoveryMarkup = renderToStaticMarkup(createElement(RecoveryActions, { operations: [{ attemptId: "a", stage: "author", status: "unknown", packageIds: ["P1"] }], cancellations: [{ attemptId: "a", canAcknowledge: true, reason: "本地执行已结束，没有完整回包" }], disabled: false, onRecover: () => {}, onAcknowledge: () => {} }));
for (const message of ["检查并恢复已有回包", "确认中断风险，允许继续", "用量未知", "完整主创"]) assert.ok(recoveryMarkup.includes(message), `恢复入口缺少${message}`);
assert.ok(!renderToStaticMarkup(createElement(RecoveryActions, { operations: [{ attemptId: "a", stage: "author", status: "unknown", packageIds: [], cancelAcknowledgement: acknowledgedOperation.cancelAcknowledgement }], cancellations: [], disabled: false, onRecover: () => {}, onAcknowledge: () => {} })).includes("确认中断风险"));
assert.ok(renderToStaticMarkup(createElement(RecoveryActions, { operations: [{ attemptId: "late", stage: "author", status: "completed", packageIds: [], canRecoverSaved: true }], cancellations: [], disabled: false, onRecover: () => {}, onAcknowledge: () => {} })).includes("检查并恢复已有回包"), "已完成但停止后返回的结果也应有恢复入口");
const failedRecoveryMarkup = renderToStaticMarkup(createElement(RecoveryActions, { operations: [{ attemptId: "failed", stage: "author", status: "unknown", packageIds: ["P1"] }], cancellations: [{ attemptId: "failed", canAcknowledge: true, kind: "failed", reason: "CLI已退出且没有正文回包" }], disabled: false, onRecover: () => {}, onAcknowledge: () => {} }));
for (const message of ["确认失败风险，允许继续", "用量未知", "可能已经消耗额度", "不自动重发", "连续完成", "仅补未完成步骤"]) assert.ok(failedRecoveryMarkup.includes(message), `CLI失败风险入口缺少${message}`);
assert.ok(!failedRecoveryMarkup.includes("确认中断风险"), "CLI执行失败不能误标为用户中断");
const timeoutRecoveryMarkup = renderToStaticMarkup(createElement(RecoveryActions, { operations: [{ attemptId: "timeout", stage: "author", status: "unknown", packageIds: ["P1"] }], cancellations: [{ attemptId: "timeout", canAcknowledge: true, kind: "timeout", reason: "本机进程已退出，没有正文回包" }], disabled: false, onRecover: () => {}, onAcknowledge: () => {} }));
for (const message of ["确认超时风险，允许继续", "用量未知", "不代表已退费", "不自动重发", "从已保存步骤继续"]) assert.ok(timeoutRecoveryMarkup.includes(message), `超时风险入口缺少${message}`);
assert.doesNotMatch(timeoutRecoveryMarkup, /确认中断风险|这次中断/, "超时不能误标为用户中断");
assert.ok(!renderToStaticMarkup(createElement(RecoveryActions, { operations: [{ attemptId: "timeout", stage: "author", status: "unknown", packageIds: [] }], cancellations: [{ attemptId: "timeout", canAcknowledge: false, kind: "timeout", reason: "尚未确认本机进程已结束" }], disabled: false, onRecover: () => {}, onAcknowledge: () => {} })).includes("确认超时风险"), "尚未确定进程退出时不能提供确认入口");
const acknowledgingTimeout = renderToStaticMarkup(createElement(RunFeedback, { state: timeoutState, pendingAction: "acknowledge_timeout", disabled: true, onRecheck: () => {} }));
assert.match(acknowledgingTimeout, /正在记录超时风险确认.*不自动重发/);
const acknowledgingFailure = renderToStaticMarkup(createElement(RunFeedback, { state: returned, pendingAction: "acknowledge_failure", disabled: true, onRecheck: () => {} }));
assert.match(acknowledgingFailure, /正在记录失败风险确认.*不自动重发/);
assert.ok(source.includes('act("pause")') && source.includes('act("acknowledge_cancel"'), "暂停与明确风险确认必须有对应动作");
console.log("PASS 分镜工作台初始界面与状态派生");

async function verifyServiceView() {
  // Exercise the service boundary with the real public projection, without reading a database or production receipts.
  const serviceBundle = await build({ entryPoints: [fileURLToPath(new URL("../lib/storyboard-service.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", logLevel: "silent", plugins: [{ name: "isolated-service-dependencies", setup(builder) {
    builder.onResolve({ filter: /^(server-only|node:module|@\/lib\/(?:prisma|light-foundation-reader))$/ }, args => ({ path: args.path, namespace: "service-fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "service-fixture" }, args => ({ contents: args.path === "node:module" ? "export const createRequire = () => globalThis.__storyboardFixtureRequire;" : args.path === "@/lib/light-foundation-reader" ? "export const readLightEpisodeFoundation = async () => null;" : args.path === "@/lib/prisma" ? "export const prisma = {};" : "export {};" }));
  } }] });
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = new Map(["storyboardV4", "__storyboardFixtureRequire"].map(key => [key, { present: Object.hasOwn(globals, key), value: globals[key] }]));
  try {
    let voiceCalls = 0, createCalls = 0;
    globals.__storyboardFixtureRequire = (filename: string) => {
      if (filename.endsWith("/source-context.mjs")) return { readEpisodeSourceContext: async () => null };
      if (filename.endsWith("/voice.mjs")) return { measureVoiceReference: async () => { voiceCalls++; return { warnings: [] }; } };
      if (/\/(input|http)\.mjs$/.test(filename)) return require(filename);
      throw new Error(`Unexpected service dependency: ${filename}`);
    };
    const serviceModule = { exports: {} as { storyboardRunView: (run: Record<string, unknown>, episode: Record<string, unknown>) => Promise<{ operations: { execution?: unknown }[]; cancellations: unknown[] }>; createStoryboardRun: (episode: Record<string, unknown>, command: Record<string, unknown>) => Promise<unknown>; storyboardFailure: (error: unknown) => { status: number; body: Record<string, any> } } };
    new Function("require", "module", "exports", serviceBundle.outputFiles[0].text)(require, serviceModule, serviceModule.exports);
    const episode = { id: "fixture", projectId: "p", number: 1, content: "△甲推开门。", project: { id: "p", style: "3D国漫", aspectRatio: "16:9" } };
    const { makeEpisodeInput } = require("../runtime/storyboard-v4/input.mjs");
    const run = { id: "fixture-run", status: "unknown", operations: [{ attemptId: "a", status: "unknown" }], web: { binding: { episodeId: episode.id, projectId: episode.projectId, sourceVersion: makeEpisodeInput({ episode, project: episode.project }).sourceVersion } } };
    let executionRead = false;
    const cancellations = [{ attemptId: "a", canAcknowledge: true, kind: "timeout", reason: "本机进程已结束" }];
    globals.storyboardV4 = { active: () => false, scheduling: () => undefined, cancellationStatus: async () => { await Promise.resolve(); assert.equal(executionRead, true, "状态读取应并行进行，不等待另一份回执"); return cancellations; }, executionStatus: async () => { executionRead = true; return [{ attemptId: "a", execution: executionEvidence }]; } };
    const current = await serviceModule.exports.storyboardRunView(run, episode);
    assert.deepEqual(current.operations[0].execution, executionEvidence);assert.deepEqual(current.cancellations, cancellations);
    globals.storyboardV4 = { active: () => false, scheduling: () => undefined, cancellationStatus: async () => [] };
    const legacy = await serviceModule.exports.storyboardRunView(run, episode);
    assert.equal(legacy.operations[0].execution, undefined, "热更新期间旧协调器无metadata方法也必须保留原有页面");
    console.log("PASS service并行读取执行证据/旧协调器兼容（隔离数据）");
    globals.storyboardV4 = { withPreparation: (callback: () => Promise<unknown>) => callback(), create: async () => { createCalls++; return { id: "must-not-create" }; } };
    let rejected: unknown;
    try { await serviceModule.exports.createStoryboardRun({ ...episode, content: "甲：走。\n无归属普通句" }, { action: "create" }); } catch (error) { rejected = error; }
    assert.ok(rejected, "源诊断必须在平读参考与任务保存前明确拒绝");
    const failure = serviceModule.exports.storyboardFailure(rejected);
    assert.equal(failure.status, 409); assert.equal(failure.body.code, "SOURCE_DIAGNOSTICS");
    assert.equal(failure.body.creationOutcome, "NOT_CREATED");
    assert.match(failure.body.error, /任务未创建/);
    assert.deepEqual(failure.body.diagnostics, [{ rowId: "fixture:L0002", line: 2, text: "无归属普通句", reason: "无法安全识别为对白" }]);
    assert.equal(voiceCalls, 0); assert.equal(createCalls, 0);
    for (const error of [Object.assign(new Error("保存后读取失败"), { status: 503 }), Object.assign(new Error("其他冲突"), { status: 409 }), Object.assign(new Error("没有创建阶段证明"), { code: "SOURCE_DIAGNOSTICS" })]) {
      assert.equal(serviceModule.exports.storyboardFailure(error).body.creationOutcome, undefined, "不能仅凭HTTP状态或错误码声称未创建");
    }
    console.log("PASS 创建前源诊断/安全原文定位/零平读零保存/未知错误不误标（隔离数据）");
  } finally {
    for (const [key, previous] of saved) previous.present ? globals[key] = previous.value : delete globals[key];
  }
}

async function verifyIndexUsageReview() {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL("../app/api/episodes/[episodeId]/storyboard/route.ts", import.meta.url))], bundle: true, write: false, platform: "node", format: "cjs", packages: "external", logLevel: "silent", plugins: [{ name: "isolated-index-dependencies", setup(builder) {
    builder.onResolve({ filter: /^@\/lib\/(auth|prisma|storyboard-service)$/ }, args => ({ path: args.path, namespace: "index-fixture" }));
    builder.onLoad({ filter: /.*/, namespace: "index-fixture" }, args => ({ contents: args.path === "@/lib/auth" ? 'export const getCurrentUser = async () => ({id:"fixture-user"});' : args.path === "@/lib/prisma" ? 'export const prisma = {episode:{findFirst: async () => ({id:"fixture"})}};' : 'export const storyboardService = () => ({list:async()=>[{id:"saved",status:"planned",web:{title:"已保存稿",progress:"usage_review",createdAt:"2026-09-30T00:00:00Z"}}],scheduling:()=>({maxConcurrent:2,maxPerEpisode:2})}); export const storyboardRunnerStatus=async()=>({ready:true}); export const loadStoryboardInput=async()=>({warnings:[]}); export const storyboardFailure=error=>{throw error}; export const storyboardHttp={}; export const createStoryboardRun=()=>{throw Error("unexpected create")}; export const storyboardRunView=()=>{throw Error("unexpected view")};' }));
  } }] });
  const routeModule = { exports: {} as { GET: (request: Request, context: { params: Promise<{ episodeId: string }> }) => Promise<Response> } };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, routeModule, routeModule.exports);
  const response = await routeModule.exports.GET(new Request("http://storyboard.invalid/api/episodes/fixture/storyboard"), { params: Promise.resolve({ episodeId: "fixture" }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).runs[0].status, "usage_review", "任务列表不能把待确认用量降成普通planned状态");
  console.log("PASS GET任务列表保留用量待确认状态（隔离数据）");
}

async function verifyFantasySelection() {
  // Exercise the real client component against fixed API snapshots, without a server, database, or model call.
  const bundle = await build({ stdin: { contents: 'import {createElement} from "react"; import {createRoot} from "react-dom/client"; import {StoryboardWorkbench} from "./app/projects/[projectId]/episodes/[episodeId]/storyboard/workbench"; createRoot(document.getElementById("root")).render(createElement(StoryboardWorkbench, {episodeId:"fixture", episodeTitle:"幻想选择验证"}));', resolveDir: fileURLToPath(new URL("..", import.meta.url)), loader: "tsx" }, bundle: true, write: false, platform: "browser", format: "iife", jsx: "automatic", loader: { ".css": "empty", ".module.css": "empty" }, define: { "process.env.NODE_ENV": '"development"' }, logLevel: "silent" });
  const executablePath = existsSync(chromium.executablePath()) ? undefined : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const context = await browser.newContext({ serviceWorkers: "block" });
    const page = await context.newPage(); page.setDefaultTimeout(2000);
    const errors: string[] = [], posts: Record<string, unknown>[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const initial = {
      id: "A", title: "幻想选择验证", createdAt: "2026-09-30T00:00:00Z", status: "planned", settings: { maxUnitSeconds: 15, fantasyMode: "all" }, active: false, sourceStale: false,
      sourceRows: [{ id: "S1", text: "甲压住怒气" }, { id: "S2", text: "乙抬眼反击" }], sourceWarnings: [],
      plan: { emotionArc: "承压后反击", workPackages: [{ id: "P1", sourceRefs: ["S1", "S2"], emotionContract: { subject: "甲乙", contextTone: "紧张", audienceEffect: "期待反击", change: "承压", landing: "反击", retain: [] }, dependsOn: [] }], provisionalUnits: [{ id: "U1", packageId: "P1", sourceRefs: ["S1"], secondsRange: [4, 10] }, { id: "U2", packageId: "P1", sourceRefs: ["S2"], secondsRange: [4, 10] }], fantasyCandidates: [{ id: "F1", anchorRefs: ["S1"], subject: "甲的压力", emotionPurpose: "外化压力", recommended: true, proposal: "主观压力" }] },
      choice: { mode: "all", overrides: {}, unitOverrides: {} }, selection: { status: "ready", selectedIds: ["F1"], byUnit: { U1: ["F1"], U2: [] }, fingerprint: "all-ready", unfulfilledUnitIds: [] as string[] },
      adopted: [], operations: [], candidates: [], cancellations: [], assembly: null, error: null,
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0, complete: true }, budget: { maxCalls: 32, maxTokens: 300000, maxRepairs: 2 },
    };
    const requested = { ...initial, choice: { ...initial.choice, unitOverrides: { U2: true } }, selection: { ...initial.selection, status: "needs_design", fingerprint: "requested", unfulfilledUnitIds: ["U2"] } };
    const skipped = { ...initial, choice: { ...initial.choice, unitOverrides: { U2: false } }, selection: { ...initial.selection, fingerprint: "skipped" } };
    const review = { ...initial, settings: { ...initial.settings, fantasyMode: "review" }, choice: { ...initial.choice, mode: "review" }, selection: { ...initial.selection, status: "awaiting_confirmation", fingerprint: "review" } };
    const confirmed = { ...review, selection: { ...review.selection, status: "ready", fingerprint: "confirmed" } };
    const replies = [requested, skipped, review, confirmed];
    let run = initial;
    await context.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== "http://storyboard.invalid") { errors.push(`unexpected network: ${url.origin}`); return route.abort(); }
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
      if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "application/javascript", body: bundle.outputFiles[0].text });
      if (url.pathname !== "/api/episodes/fixture/storyboard") { errors.push(`unexpected path: ${url.pathname}`); return route.abort(); }
      if (request.method() === "POST") {
        posts.push(request.postDataJSON());
        const next = replies.shift();
        if (!next) { errors.push("unexpected extra action"); return route.abort(); }
        run = next;
        return route.fulfill({ json: { run } });
      }
      return route.fulfill({ json: url.searchParams.has("runId") ? { run } : { runs: [{ id: "A", title: run.title, status: run.status, createdAt: run.createdAt }], model: "gpt-6.1-sol", reasoning: "medium", maxConcurrent: 2, maxPerEpisode: 2, runner: { ready: true, message: "隔离验证" }, sourceWarnings: [] } });
    });
    await page.goto("http://storyboard.invalid/?runId=A");
    const panel = page.getByRole("region", { name: "幻想选择", exact: true });
    await panel.waitFor();
    const missing = panel.getByRole("article").filter({ hasText: "粗单元 U2" });
    const missingChoice = missing.getByRole("checkbox");
    const continueButton = page.getByRole("button", { name: "连续完成", exact: true });
    assert.equal(await missingChoice.isChecked(), false, "all只采用已有候选：无候选粗单元默认不得请求补设计");
    assert.match(await missing.innerText(), /无幻想候选.*跳过.*真实表演/, "无候选单元应说明跳过额外幻想但保留真实表演");
    assert.equal(await panel.getByRole("checkbox", { name: /甲的压力/ }).isChecked(), true);
    assert.equal(await continueButton.isEnabled(), true, "部分单元无候选不应阻止连续完成");
    assert.doesNotMatch(await panel.innerText(), /不能将.*全加.*完成/);
    assert.deepEqual(posts, [], "载入all模式不得自动启动任务");

    await missingChoice.click();
    await page.getByRole("button", { name: "补充幻想规划（一次CLI调用）", exact: true }).waitFor();
    assert.deepEqual(posts[0].unitOverrides, { U2: true }, "只有主动勾选才发送补设计意图");
    assert.equal(await missingChoice.isChecked(), true);
    assert.match(await missing.innerText(), /主动请求.*待设计/);
    assert.doesNotMatch(await panel.innerText(), /不能将.*全加.*完成/, "主动请求缺设计不应误报为全部加入未完成");
    assert.equal(await continueButton.isDisabled(), true, "主动请求的未设计幻想仍应阻止正文");

    await missingChoice.click();
    await page.getByRole("button", { name: "补充幻想规划（一次CLI调用）", exact: true }).waitFor({ state: "hidden" });
    assert.equal(await continueButton.isEnabled(), true);
    assert.deepEqual(posts[1].unitOverrides, { U2: false });
    assert.equal(await panel.getByRole("checkbox", { name: /甲的压力/ }).isChecked(), true, "取消补设计不能撤掉其他候选");

    await panel.getByRole("button", { name: "逐项选择", exact: true }).click();
    const confirm = panel.getByRole("button", { name: "确认幻想选择", exact: true }); await confirm.waitFor();
    assert.equal(await missingChoice.isChecked(), false);
    assert.equal(await continueButton.isDisabled(), true, "review模式仍需确认");
    await confirm.click();
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent === "连续完成")?.disabled);
    assert.deepEqual(posts.map(post => post.action), ["choice", "choice", "choice", "confirm"], "改选择与确认不能自动启动模型");
    assert.deepEqual(errors, []);
    console.log("PASS all已有候选/无候选默认跳过/主动补设计/review确认 UI行为");

    for (const recoveryKind of ["failed", "timeout"] as const) {
    const riskTerm = recoveryKind === "timeout" ? "超时" : "失败";
    const failureContext = await browser.newContext({ serviceWorkers: "block" });
    const failurePage = await failureContext.newPage(); failurePage.setDefaultTimeout(2000);
    const failureErrors: string[] = [], failurePosts: Record<string, unknown>[] = [], dialogs: string[] = [];
    failurePage.on("pageerror", error => failureErrors.push(error.message));
    const failure = { ...initial, status: "unknown", error: recoveryKind === "timeout" ? { code: "TIMEOUT", message: "等待生成进展超时，未取得完整回包" } : { code: "CLI_FAILED", message: "执行CLI失败（退出码1），未取得完整回包" }, operations: [{ attemptId: "failure-attempt", stage: "author", status: "unknown", packageIds: ["P1"], finishMode: "UNKNOWN", createdAt: initial.createdAt, execution: recoveryKind === "timeout" ? { ...executionEvidence, phase: "failed", timeoutKind: "idle" } : undefined }], cancellations: [{ attemptId: "failure-attempt", canAcknowledge: true, kind: recoveryKind, reason: "本机进程已退出，没有正文回包" }], usage: { ...initial.usage, complete: false, unknownAttempts: 1, acknowledgedUnknownAttempts: 0 } };
    const acknowledged = { ...failure, status: "paused", operations: [{ ...failure.operations[0], cancelAcknowledgement: { at: initial.createdAt, acceptUnknownUsage: true, kind: recoveryKind } }], cancellations: [], usage: { ...failure.usage, acknowledgedUnknownAttempts: 1 } };
    let failureRun: typeof failure | typeof acknowledged = failure;
    let releaseAcknowledgement!: () => void;
    const acknowledgementGate = new Promise<void>(resolve => { releaseAcknowledgement = resolve; });
    await failureContext.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== "http://storyboard.invalid") { failureErrors.push(`unexpected network: ${url.origin}`); return route.abort(); }
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
      if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "application/javascript", body: bundle.outputFiles[0].text });
      if (url.pathname !== "/api/episodes/fixture/storyboard") { failureErrors.push(`unexpected path: ${url.pathname}`); return route.abort(); }
      if (request.method() === "POST") {
        failurePosts.push(request.postDataJSON()); await acknowledgementGate; failureRun = acknowledged;
        return route.fulfill({ json: { run: failureRun } });
      }
      return route.fulfill({ json: url.searchParams.has("runId") ? { run: failureRun } : { runs: [{ id: "A", title: failureRun.title, status: failureRun.status, createdAt: failureRun.createdAt }], model: "gpt-6.1-sol", reasoning: "medium", maxConcurrent: 2, maxPerEpisode: 2, runner: { ready: true, message: "隔离验证" }, sourceWarnings: [] } });
    });
    await failurePage.goto("http://storyboard.invalid/?runId=A");
    const riskButton = failurePage.getByRole("button", { name: `确认${riskTerm}风险，允许继续`, exact: true }); await riskButton.waitFor();
    const failureContinue = failurePage.getByRole("button", { name: "连续完成", exact: true });
    assert.equal(await failureContinue.isDisabled(), true, "CLI失败未确认前不应继续");
    assert.match(await failurePage.getByLabel("操作反馈").innerText(), recoveryKind === "timeout" ? /TIMEOUT.*等待生成进展超时/ : /CLI_FAILED.*退出码1/);
    if (recoveryKind === "timeout") assert.match(await failurePage.getByLabel("操作反馈").innerText(), /无生成进展超时/);
    assert.match(await failurePage.getByLabel("操作反馈").innerText(), /风险确认/, "已知失败不能只引导恢复不存在的回包");
    failurePage.once("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
    await riskButton.click(); assert.deepEqual(failurePosts, [], "取消风险确认不得发送任何写请求");
    failurePage.once("dialog", async dialog => { dialogs.push(dialog.message()); await dialog.accept(); });
    await riskButton.click();
    await failurePage.getByRole("status").filter({ hasText: `正在记录${riskTerm}风险确认` }).waitFor();
    for (const dialog of dialogs) {
      assert.match(dialog, new RegExp(`调用.*${riskTerm}.*用量未知.*可能已经消耗额度`));
      assert.match(dialog, /不.*自动重发.*连续完成.*仅补未完成步骤/);
      assert.doesNotMatch(dialog, /中断/, "失败确认弹窗不得误称用户中断");
      if (recoveryKind === "timeout") assert.match(dialog, /不代表已退费/);
    }
    assert.doesNotMatch(await failurePage.getByLabel("操作反馈").innerText(), /记录中断风险/);
    assert.deepEqual(failurePosts, [{ action: "acknowledge_cancel", runId: "A", attemptId: "failure-attempt", acceptUnknownUsage: true }]);
    releaseAcknowledgement();
    await failurePage.getByRole("status").filter({ hasText: `已确认${riskTerm}风险` }).waitFor();
    assert.equal(await riskButton.count(), 0, "已确认后不能重复显示风险确认入口");
    assert.equal(await failurePage.getByRole("button", { name: "从已保存步骤继续", exact: true }).isEnabled(), true, "确认仅解除阻塞，用户仍需显式继续");
    assert.match(await failurePage.getByLabel("操作反馈").innerText(), recoveryKind === "timeout" ? /TIMEOUT.*等待生成进展超时/ : /CLI_FAILED.*退出码1/, "确认风险不能擦掉真实失败证据");
    assert.deepEqual(failurePosts.map(post => post.action), ["acknowledge_cancel"], "风险确认绝不能绑定start自动重发");
    assert.deepEqual(failureErrors, []);
    console.log(`PASS CLI${riskTerm}风险确认/取消/pending/保留错误/不自动重发 UI行为`);
    await failureContext.close();
    }

    const usageContext = await browser.newContext({ serviceWorkers: "block" });
    const usagePage = await usageContext.newPage(); usagePage.setDefaultTimeout(2000);
    const usageErrors: string[] = [], usagePosts: Record<string, unknown>[] = [], usageDialogs: string[] = [];
    usagePage.on("pageerror", error => usageErrors.push(error.message));
    const pendingUsage = { ...initial, status: "usage_review", error: { code: "USAGE_UNKNOWN", message: "已有回包已保存，但用量未完整返回" }, operations: [{ ...usageOperation, finishMode: "RESPONDED", createdAt: initial.createdAt, usage: null, execution: { ...executionEvidence, phase: "completed" } }], adopted: [{ stage: "author", packageIds: ["P1"], unitCount: 1, shotCount: 1, seconds: 8 }], cancellations: [usageCheck], usage: { ...initial.usage, complete: false, unknownAttempts: 1, acknowledgedUnknownAttempts: 0 } };
    const acceptedUsage = { ...pendingUsage, status: "planned", error: null, operations: [{ ...pendingUsage.operations[0], cancelAcknowledgement: acknowledgedUsage.cancelAcknowledgement }], cancellations: [], usage: { ...pendingUsage.usage, acknowledgedUnknownAttempts: 1 } };
    let usageRun: typeof pendingUsage | typeof acceptedUsage = pendingUsage;
    let releaseUsage!: () => void;
    const usageGate = new Promise<void>(resolve => { releaseUsage = resolve; });
    await usageContext.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== "http://storyboard.invalid") { usageErrors.push(`unexpected network: ${url.origin}`); return route.abort(); }
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
      if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "application/javascript", body: bundle.outputFiles[0].text });
      if (url.pathname !== "/api/episodes/fixture/storyboard") { usageErrors.push(`unexpected path: ${url.pathname}`); return route.abort(); }
      if (request.method() === "POST") { usagePosts.push(request.postDataJSON()); await usageGate; usageRun = acceptedUsage; return route.fulfill({ json: { run: usageRun } }); }
      return route.fulfill({ json: url.searchParams.has("runId") ? { run: usageRun } : { runs: [{ id: "A", title: usageRun.title, status: usageRun.status, createdAt: usageRun.createdAt }], model: "gpt-6.1-sol", reasoning: "medium", maxConcurrent: 2, maxPerEpisode: 2, runner: { ready: true, message: "隔离验证" }, sourceWarnings: [] } });
    });
    await usagePage.goto("http://storyboard.invalid/?runId=A");
    const usageButton = usagePage.getByRole("button", { name: "确认接受未知用量", exact: true }); await usageButton.waitFor();
    const usageContinue = usagePage.getByRole("button", { name: "连续完成", exact: true });
    assert.equal(await usageContinue.isDisabled(), true);
    assert.equal(await usagePage.getByRole("button", { name: "推进一步", exact: true }).isDisabled(), true);
    assert.equal(await usagePage.getByRole("region", { name: "幻想选择", exact: true }).getByRole("button", { name: "逐项选择", exact: true }).isDisabled(), true, "未确认用量前不能由更改选择绕过费用阻断");
    assert.match(await usagePage.getByLabel("操作反馈").innerText(), /回包已保存.*用量未知/);
    assert.doesNotMatch(await usagePage.getByLabel("操作反馈").innerText(), /中断|失败|达到预算|未完成的调用/);
    assert.equal(await usagePage.getByRole("button", { name: /检查并恢复已有回包|核对并恢复这次结果/ }).count(), 0, "成功稿不应提供恢复按钮");
    assert.match(await usagePage.getByRole("region", { name: "当前状态", exact: true }).innerText(), /用量待确认/);
    usagePage.once("dialog", async dialog => { usageDialogs.push(dialog.message()); await dialog.dismiss(); });
    await usageButton.click(); assert.deepEqual(usagePosts, [], "取消费用确认不发写请求");
    usagePage.once("dialog", async dialog => { usageDialogs.push(dialog.message()); await dialog.accept(); });
    await usageButton.click(); await usagePage.getByRole("status").filter({ hasText: "正在确认未知用量" }).waitFor();
    assert.deepEqual(usagePosts, [{ action: "acknowledge_cancel", runId: "A", attemptId: "saved-usage", acceptUnknownUsage: true }]);
    for (const dialog of usageDialogs) { assert.match(dialog, /结果已保存.*用量未知.*只解除费用阻断.*不.*自动重发.*仅补未完成步骤/); assert.doesNotMatch(dialog, /调用失败|请求已中断|没有完整回包/); }
    releaseUsage(); await usagePage.getByRole("status").filter({ hasText: "已接受未知用量" }).waitFor();
    assert.equal(await usageButton.count(), 0);assert.equal(await usageContinue.isEnabled(), true);
    assert.match(await usagePage.getByRole("region", { name: "当前状态", exact: true }).innerText(), /用量未知.*未知部分没有记成零/);
    assert.match(await usagePage.getByRole("region", { name: "执行与候选历史", exact: true }).innerText(), /已采纳.*author P1/);
    assert.deepEqual(usagePosts.map(post => post.action), ["acknowledge_cancel"], "接受未知用量仅解除阻断，不自动start或recover");
    assert.deepEqual(usageErrors, []);
    console.log("PASS 成功稿未知用量/确认前阻断/取消/pending/保留成果/不自动调用 UI行为");
    await usageContext.close();

    const bodyContext = await browser.newContext({ serviceWorkers: "block" });
    const bodyPage = await bodyContext.newPage(); bodyPage.setDefaultTimeout(2000);
    const bodyErrors: string[] = [], bodyPosts: Record<string, unknown>[] = [];
    bodyPage.on("pageerror", error => bodyErrors.push(error.message));
    bodyPage.on("dialog", async dialog => { bodyErrors.push(`unexpected risk dialog: ${dialog.message()}`); await dialog.dismiss(); });
    const savedBody = { ...initial, status: "needs_repair", error: { code: "TIMEOUT", message: "超时前已有正文，待核对并恢复" }, operations: [{ attemptId: "body-timeout", stage: "author", status: "completed", packageIds: ["P1"], finishMode: "RESPONDED", createdAt: initial.createdAt, canRecoverSaved: true, execution: { ...executionEvidence, phase: "failed", timeoutKind: "total", lastProgressAt: "2026-09-30T00:00:08Z" } }], cancellations: [] };
    const parsedBody = { ...savedBody, status: "planned", operations: [{ ...savedBody.operations[0], canRecoverSaved: false }] };
    let bodyRun = savedBody;
    await bodyContext.route("**/*", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== "http://storyboard.invalid") { bodyErrors.push(`unexpected network: ${url.origin}`); return route.abort(); }
      if (url.pathname === "/") return route.fulfill({ contentType: "text/html", body: '<!doctype html><html><body><div id="root"></div><script src="/fixture.js"></script></body></html>' });
      if (url.pathname === "/fixture.js") return route.fulfill({ contentType: "application/javascript", body: bundle.outputFiles[0].text });
      if (url.pathname !== "/api/episodes/fixture/storyboard") { bodyErrors.push(`unexpected path: ${url.pathname}`); return route.abort(); }
      if (request.method() === "POST") { bodyPosts.push(request.postDataJSON()); bodyRun = parsedBody; return route.fulfill({ json: { run: bodyRun } }); }
      return route.fulfill({ json: url.searchParams.has("runId") ? { run: bodyRun } : { runs: [{ id: "A", title: bodyRun.title, status: bodyRun.status, createdAt: bodyRun.createdAt }], model: "gpt-6.1-sol", reasoning: "medium", maxConcurrent: 2, maxPerEpisode: 2, runner: { ready: true, message: "隔离验证" }, sourceWarnings: [] } });
    });
    await bodyPage.goto("http://storyboard.invalid/?runId=A");
    const freeRecovery = bodyPage.getByRole("button", { name: "检查并恢复已有回包（不调用模型）", exact: true }); await freeRecovery.waitFor();
    assert.equal(await bodyPage.getByRole("button", { name: /确认.*风险，允许继续/ }).count(), 0, "已收到正文不应提供未知回包风险确认");
    const bodyHistory = bodyPage.getByRole("region", { name: "执行与候选历史", exact: true });
    await bodyHistory.locator("summary").first().click();
    const historyRecovery = bodyHistory.getByRole("button", { name: "核对并恢复这次结果", exact: true });
    assert.equal(await historyRecovery.isEnabled(), true, "completed的超时正文仍应开放历史免费恢复");
    await historyRecovery.click(); await freeRecovery.waitFor({ state: "hidden" });
    assert.deepEqual(bodyPosts, [{ action: "recover", runId: "A", attemptId: "body-timeout" }], "恢复正文不得转成风险确认或start调用");
    assert.deepEqual(bodyErrors, []);
    console.log("PASS completed超时正文/历史免费恢复/无风险确认/不自动重发 UI行为");
    await bodyContext.close();
  } finally { await browser.close(); }
}
verifyServiceView().then(verifyIndexUsageReview).then(verifyFantasySelection).catch(error => { console.error(error); process.exitCode = 1; });
