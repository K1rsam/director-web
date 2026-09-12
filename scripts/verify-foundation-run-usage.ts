import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
import { summarizeFoundationRunUsage, aggregateFoundationUsage } from "@/lib/foundation-run-usage";
import { buildFoundationStageViews } from "@/lib/studio";

const usage = { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5 };
const completed = (value: unknown = usage) => JSON.stringify({ type: "turn.completed", usage: value });
const call = (overrides: Record<string, unknown> = {}) => ({ sequence: 1, provider: "CLI", model: "recorded-model", reasoningEffort: "high", providerCallCount: 1,
  requestOutcome: "RESPONDED", response: { stdout: completed(), data: { usage: { input_tokens: 99999 } } }, ...overrides });
const record = (calls: unknown[]) => ({ schema: "FOUNDATION_RUN_EVIDENCE_V1", calls });
const read = (calls: unknown[]) => summarizeFoundationRunUsage(JSON.stringify(record(calls)));
const one = read([call()]);
assert.equal(one.inputTokens, 100);
assert.equal(one.cachedInputTokens, 40);
assert.equal(one.outputTokens, 20);
assert.equal(one.reasoningOutputTokens, 5);
assert.equal(one.totalTokens, 120);
assert.equal(one.uncachedInputTokens, 60);
assert.equal(read([call(), call()]).totalTokens, 240);
assert.equal(read([call({ response: { stdout: 'broken\n' + completed() + '\n' + completed() } })]).totalTokens, 120);
const differentTurns = ["turn-a", "turn-b"].map(turn_id => JSON.stringify({ type: "turn.completed", turn_id,
  usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20 } })).join("\n");
const ambiguousTurns = read([call({ response: { stdout: differentTurns } })]);
assert.equal(ambiguousTurns.totalTokens, null, "different complete events with identical usage must remain unknown");
assert.equal(ambiguousTurns.unknownCalls, 1);
for (const stdout of [completed({ ...usage, input_tokens: -1 }), completed({ ...usage, cached_input_tokens: 101 }), completed({ ...usage, reasoning_output_tokens: 21 }),
  completed({ ...usage, input_tokens: "100" }), completed({ ...usage, output_tokens: 1.5 }), completed({ ...usage, input_tokens: Number.MAX_SAFE_INTEGER }),
  completed() + '\n' + completed({ ...usage, input_tokens: 101 }), '{"type":"turn.completed","usage":',
  JSON.stringify({ type: "item.completed", data: { type: "turn.completed", usage } }), JSON.stringify({ type: "token_count", usage })]) {
  const result = read([call({ response: { stdout, stderr: completed(), data: { usage } } })]);
  assert.equal(result.totalTokens, null, stdout);
  assert.equal(result.unknownCalls, 1);
}
const optional = read([call({ response: { stdout: completed({ input_tokens: 100, output_tokens: 20 }) } })]);
assert.equal(optional.totalTokens, 120);
assert.equal(optional.cachedInputTokens, null);
assert.equal(optional.reasoningOutputTokens, null);
assert.equal(optional.uncachedInputTokens, null);
assert.equal(read([call({ provider: "API" })]).totalTokens, null);
const replay = read([call({ providerCallCount: 0, reusedFrom: { runId: "original", sequence: 1 } })]);
assert.equal(replay.totalTokens, 0);
assert.equal(replay.newRequests, 0);
assert.equal(replay.reusedCalls, 1);
assert.equal(read([call({ providerCallCount: 0, requestOutcome: "NOT_SENT", response: undefined })]).totalTokens, 0);
assert.equal(read([call({ providerCallCount: 1, requestOutcome: "NOT_SENT", response: undefined })]).totalTokens, 0);
assert.equal(read([call({ providerCallCount: 0, requestOutcome: "UNKNOWN", response: undefined })]).totalTokens, null);
for (const log of [null, "broken", "{}", '{"calls":[]}']) assert.equal(summarizeFoundationRunUsage(log).totalTokens, null);
assert.equal(read([]).totalTokens, 0);
const partial = read([call(), call({ response: {} })]);
assert.equal(partial.totalTokens, 120);
assert.equal(partial.unknownCalls, 1);
assert.equal(partial.newRequests, 2);
assert.equal(aggregateFoundationUsage([one, replay, partial]).totalTokens, 240);
assert.equal(aggregateFoundationUsage([]).totalTokens, null);
assert.equal(aggregateFoundationUsage([summarizeFoundationRunUsage(null)]).totalTokens, null);
const frozen = Object.freeze(record(Object.freeze([Object.freeze(call())]) as unknown as unknown[]));
const before = JSON.stringify(frozen);
assert.equal(summarizeFoundationRunUsage(frozen).totalTokens, 120);
assert.equal(JSON.stringify(frozen), before);
assert.ok(Object.values(one).every(value => value === null || typeof value === "number"));
console.log("PASS parser: additive calls, subsets, replay, unknown/partial, NDJSON trust boundary and immutable inputs");

async function main() {
  // Plain tsx lacks Next's server-only alias; only resolve the inert environment marker.
  const require = createRequire(import.meta.url);
  const loader = require("node:module");
  const originalResolve = loader._resolveFilename;
  loader._resolveFilename = function (request: string, ...args: unknown[]) {
    return originalResolve.call(this, request === "server-only" ? "next/dist/compiled/server-only/empty" : request, ...args);
  };
  const { FoundationUsage } = await import("@/app/projects/[projectId]/foundation-actions");
  loader._resolveFilename = originalResolve;
  assert.equal(typeof FoundationUsage, "function", "real usage component must exist");
  const savedRun = { id: "fixture-run", projectId: "fixture-project", episodeId: null, stageCode: "F1", roleName: "F1", provider: "CLI", model: "recorded-model", status: "SUCCEEDED" as const,
    inputSummary: null, outputSummary: null, log: JSON.stringify(record([call(), call({ response: {} })])), error: null, startedAt: null, finishedAt: null, durationMs: 1000, createdAt: new Date(0) };
  const state: Parameters<typeof buildFoundationStageViews>[0] = {
    preprocessReady: true, planningReady: false, assetsReady: false, dataReady: false, dataIssues: [], reviewReady: false, ready: false, draftComplete: false,
    message: "fixture", sourceVersion: "", inputVersion: "", methodVersions: { F1: "fixture", F2: "fixture", Q1: "fixture" },
    sourceContext: { version: "fixture", background: [], unresolved: [], issues: [], complete: true, notices: [], coverage: "COMPLETE" },
    recoveries: { F1: null, F2: null, Q1: null }, candidates: { f1: null, f2: null }, review: null, finalOutput: null, approved: null,
    latestRuns: { f1: savedRun, f2: null, q1: null }, f2Recovery: null
  };
  const runs = buildFoundationStageViews(state);
  assert.deepEqual(runs[0].usage, partial);
  assert.equal(runs[0].reasoningEffort, "high");
  assert.equal(runs[0].model, "recorded-model");
  assert.ok(!JSON.stringify(runs).includes("stdout"));
  const html = renderToStaticMarkup(createElement(FoundationUsage, { runs }));
  for (const label of ["输入", "其中缓存", "输出", "其中推理", "总量", "新请求尝试", "复用", "耗时", "部分用量未返回", "已记录合计", "上方显示的岗位记录合计，不是全部历史重试/账户账单"]) assert.ok(html.includes(label), label);
  assert.ok(!html.includes("stdout"));
  const unknownHtml = renderToStaticMarkup(createElement(FoundationUsage, { runs: [{ ...runs[0], usage: optional }] }));
  assert.ok(unknownHtml.includes("未返回"));
  const { serializeFoundationExport } = await import("@/lib/foundation-export");
  assert.ok(!serializeFoundationExport({ log: "secret", usage: one }, ["secret"]).includes('"secret"'));
  console.log("PASS real read-only usage component SSR labels");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
