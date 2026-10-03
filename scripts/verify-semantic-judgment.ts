import assert from "node:assert/strict";
import { test } from "node:test";
import * as semanticJudgment from "../lib/semantic-judgment";
import {
  buildSemanticCacheKey, createDisabledProvider, createJevProvider,
  gateSemanticResult, validateSemanticResult,
  type SemanticGatePolicy, type SemanticJudgmentRequest, type SemanticProvider
} from "../lib/semantic-judgment";

// Synthetic evidence only. Every HTTP call below is replaced at the transport boundary.
const request: SemanticJudgmentRequest = {
  scope: { accountId: "account-a", projectId: "project-a", sourceVersion: "source-1", questionVersion: "questions-1" },
  state: { source: "林青推门进入房间。", candidates: ["林青", "小林"] },
  questions: {
    identity: { type: "choice", instructions: "根据原文选择明确出现的名字；无法确定时选unknown。", criteria: { lin: "林青", unknown: "证据不足" } },
    hasDoor: { type: "noul", instructions: { question: "原文是否明确提到推门？" }, criteria: { true: "明确推门", false: "未提到推门" } },
    action: { type: "score", instructions: ["原文动作有多明确？"], criteria: ["未写动作", "写明具体动作"] }
  }
};
const responseBody = () => ({
  model: "jev-1.13.0",
  answers: {
    identity: { type: "choice", choice: "lin", probabilities: { lin: 0.96, unknown: 0.04 }, confidence: 0.9 },
    hasDoor: { type: "noul", noul: 0.97 },
    action: { type: "score", score: 0.95, probabilities: { "0": 0.05, "1": 0.95 }, legend: { "0": "未写动作", "1": "写明具体动作" }, confidence: 0.9 }
  },
  usage: { input_tokens: 91, output_tokens: 17 }
});
const fakeFetch = (body: unknown = responseBody()): typeof fetch => async () => new Response(JSON.stringify(body));
const evaluate = (body: unknown = responseBody()) => createJevProvider({ apiKey: "synthetic-key", fetch: fakeFetch(body) }).evaluate(request);
const policy: SemanticGatePolicy = {
  policyVersion: "policy-1", calibrationId: "synthetic-offline-fixture-not-production-calibration",
  providerId: "jev", modelVersion: "jev-1.13.0", questionVersion: "questions-1",
  thresholds: {
    identity: { type: "choice", minProbability: 0.9, minConfidence: 0.8 },
    hasDoor: { type: "noul", noAtMost: 0.1, yesAtLeast: 0.9 },
    action: { type: "score", minConfidence: 0.8 }
  }
};

test("disabled/missing key never call transport and preserve unknown usage", async () => {
  let calls = 0;
  const noNetwork: typeof fetch = async () => { calls++; throw new Error("unexpected transport"); };
  const disabled = await createDisabledProvider().evaluate(request);
  const missing = await createJevProvider({ apiKey: "  ", fetch: noNetwork }).evaluate(request);
  assert.equal(disabled.status, "unavailable");
  assert.equal(disabled.reason, "disabled");
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.reason, "missing_api_key");
  assert.deepEqual(missing.usage, { inputTokens: null, outputTokens: null });
  assert.equal(missing.answers, null);
  assert.equal(calls, 0);
});

test("provider construction is inert; evaluate sends only official payload fields", async () => {
  let calls = 0;
  const input = structuredClone(request);
  input.questions.identity = { ...input.questions.identity, candidateCoverage: "complete-set" } as typeof input.questions.identity;
  const provider = createJevProvider({ apiKey: "synthetic-key", fetch: async (url, init) => {
    calls++;
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-key");
    const payload = JSON.parse(String(init?.body));
    assert.deepEqual(Object.keys(payload).sort(), ["model", "questions", "state"]);
    assert.equal(payload.model, "jev-latest");
    assert.equal(payload.questions.identity.candidateCoverage, undefined);
    assert.equal(String(init?.body).includes("synthetic-key"), false);
    assert.equal(String(init?.body).includes("account-a"), false);
    return new Response(JSON.stringify(responseBody()));
  } });
  assert.equal(calls, 0);
  const result = await provider.evaluate(input);
  assert.equal(calls, 1);
  assert.equal(result.status, "review");
  assert.equal(result.reason, "uncalibrated");
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.probabilityKind, "jev-distribution");
  assert.deepEqual(result.usage, { inputTokens: 91, outputTokens: 17 });
  assert.deepEqual(result.answers?.identity, responseBody().answers.identity);
  assert.deepEqual(result.answers?.action, responseBody().answers.action);
  assert.deepEqual(result.answers?.hasDoor, { type: "noul", noul: 0.97, decision: null });
  assert.deepEqual(result.scope, input.scope);
});

test("public validator never upgrades typed output; an explicit matched gate can complete", async () => {
  const result = await evaluate();
  assert.equal(gateSemanticResult(request, result).status, "review");
  assert.equal(validateSemanticResult(request, { ...result, status: "complete" }).status, "review");
  const accepted = gateSemanticResult(request, result, policy);
  assert.equal(accepted.status, "complete");
  assert.equal(accepted.reason, "calibrated_policy");
  assert.equal(accepted.policyVersion, "policy-1");
  assert.deepEqual(accepted.answers, result.answers);
});

test("Jev policies cannot be reused for uncalibrated or different model/question versions", async () => {
  const result = await evaluate();
  for (const change of [
    { modelVersion: "jev-1.14.0" }, { providerId: "local-llm" },
    { questionVersion: "questions-2" }, { calibrationId: "" }, { policyVersion: "" }
  ]) assert.equal(gateSemanticResult(request, result, { ...policy, ...change }).status, "review");
  const local = { ...result, providerId: "local-llm", probabilityKind: "self-reported", answers: {
    identity: { type: "choice", choice: "lin", probabilities: null, confidence: 1 },
    hasDoor: { type: "noul", noul: null, decision: true },
    action: { type: "score", score: 1, probabilities: null, legend: null, confidence: 1 }
  } };
  assert.equal(validateSemanticResult(request, local).status, "review");
  assert.equal(gateSemanticResult(request, local, { ...policy, providerId: "local-llm" }).status, "review");
  assert.equal(validateSemanticResult(request, { ...local, probabilityKind: "none" }).status, "failed");
  const rules = { ...local, answers: { ...local.answers,
    identity: { ...local.answers.identity, confidence: null }, action: { ...local.answers.action, confidence: null }
  } };
  assert.equal(validateSemanticResult(request, { ...rules, probabilityKind: "none", model: null }).status, "review");
});

test("unknown, NaN, missing and crossed thresholds do not auto-accept", async () => {
  const result = await evaluate();
  for (const thresholds of [
    {}, { ...policy.thresholds, identity: { type: "choice", minProbability: NaN, minConfidence: 0.8 } },
    { ...policy.thresholds, identity: { type: "noul", noAtMost: 0.1, yesAtLeast: 0.9 } },
    { ...policy.thresholds, hasDoor: { type: "noul", noAtMost: 0.9, yesAtLeast: 0.1 } },
    { ...policy.thresholds, identity: { type: "choice", minProbability: 0.99, minConfidence: 0.8 } },
    { ...policy.thresholds, action: { type: "score", minConfidence: 0.99 } }
  ]) assert.equal(gateSemanticResult(request, result, { ...policy, thresholds } as SemanticGatePolicy).status, "review");
  const body = responseBody(); body.answers.hasDoor.noul = 0.5;
  assert.equal(gateSemanticResult(request, await evaluate(body), policy).status, "review");
  body.answers.hasDoor.noul = 0.02;
  assert.equal(gateSemanticResult(request, await evaluate(body), policy).status, "complete");
});

for (const [name, mutate] of Object.entries<Record<string, (body: any) => void>[string]>({
  missingAnswer: (body) => { delete body.answers.hasDoor; },
  unexpectedAnswer: (body) => { body.answers.extra = body.answers.hasDoor; },
  illegalCandidate: (body) => { body.answers.identity.choice = "invented"; },
  incompleteDistribution: (body) => { delete body.answers.identity.probabilities.unknown; },
  extraDistributionCandidate: (body) => { body.answers.identity.probabilities.extra = 0; },
  invalidDistributionSum: (body) => { body.answers.identity.probabilities.lin = 0.5; },
  negativeProbability: (body) => { body.answers.identity.probabilities = { lin: 1.1, unknown: -0.1 }; },
  inconsistentChoice: (body) => { body.answers.identity.choice = "unknown"; },
  wrongType: (body) => { body.answers.hasDoor.type = "choice"; },
  invalidNoul: (body) => { body.answers.hasDoor.noul = 1.1; },
  missingNoul: (body) => { delete body.answers.hasDoor.noul; },
  invalidConfidence: (body) => { body.answers.identity.confidence = null; },
  outOfRangeScore: (body) => { body.answers.action.score = 2; },
  inconsistentScore: (body) => { body.answers.action.score = 0.5; },
  missingLegend: (body) => { delete body.answers.action.legend; },
  missingModel: (body) => { delete body.model; }
})) test(`malformed provider response fails closed: ${name}`, async () => {
  const body = responseBody(); mutate(body);
  const result = await evaluate(body);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "invalid_response");
  assert.equal(result.answers, null);
});

test("validator rejects NaN without JSON coercion and rejects stale scope/evidence", async () => {
  const result = await evaluate();
  const malformed = structuredClone(result);
  if (malformed.answers?.identity.type === "choice") malformed.answers.identity.probabilities!.lin = NaN;
  assert.equal(validateSemanticResult(request, malformed).status, "failed");
  for (const input of [
    { ...request, scope: { ...request.scope, accountId: "account-b" } },
    { ...request, scope: { ...request.scope, projectId: "project-b" } },
    { ...request, scope: { ...request.scope, sourceVersion: "source-2" } },
    { ...request, state: { source: "不同证据" } },
    { ...request, questions: { ...request.questions, identity: { ...request.questions.identity, instructions: "改变的问题" } } }
  ]) assert.equal(gateSemanticResult(input, result, policy).status, "failed");
});

test("candidate coverage and primitive bounds are validated before any HTTP call", async () => {
  let calls = 0;
  const provider = createJevProvider({ apiKey: "synthetic", fetch: async () => { calls++; return new Response("{}"); } });
  const cases: unknown[] = [
    { ...request, scope: { ...request.scope, sourceVersion: "" } },
    { ...request, questions: {} },
    { ...request, state: { broken: NaN } },
    ...[
      { type: "choice", instructions: "谁？", criteria: { lin: "林青" } },
      { type: "choice", instructions: "谁？", criteria: {} },
      { type: "choice", instructions: "谁？", candidateCoverage: "complete-set", criteria: Object.fromEntries(Array.from({ length: 256 }, (_, i) => [String(i), null])) },
      { type: "score", instructions: "多少？", criteria: ["只有一级"] },
      { type: "score", instructions: "多少？", criteria: Array(11).fill("某级") },
      { type: "noul", instructions: "", criteria: { true: "有", false: "无" } }
    ].map((question) => ({ ...request, questions: { q: question } }))
  ];
  for (const input of cases) {
    const result = await provider.evaluate(input as SemanticJudgmentRequest);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "invalid_request");
  }
  assert.equal(calls, 0);
});

test("unknown usage stays null, including partially supplied counts", async () => {
  for (const usage of [undefined, {}, { input_tokens: 10 }, { input_tokens: -1, output_tokens: 4 }, { input_tokens: 1.5, output_tokens: "7" }]) {
    const result = await evaluate({ ...responseBody(), usage });
    assert.equal(result.status, "review");
    assert.deepEqual(result.usage, { inputTokens: usage?.input_tokens === 10 ? 10 : null, outputTokens: usage?.output_tokens === 4 ? 4 : null });
  }
});

for (const status of [401, 422, 429, 529]) test(`HTTP ${status} is sanitized and never retried`, async () => {
  let calls = 0;
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  const result = await createJevProvider({ apiKey: "synthetic-secret", fetch: async () => {
    calls++; return new Response(stream, { status, statusText: "synthetic-secret" });
  } }).evaluate(request);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "http_error");
  assert.equal(result.httpStatus, status);
  assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
});

test("network and JSON parse errors do not expose bodies or credentials", async () => {
  for (const transport of [
    async () => { throw new Error("synthetic-secret private body"); },
    async () => new Response("synthetic-secret invalid json"),
    async () => new Response(JSON.stringify({ error: "synthetic-secret private body" })),
    async () => new Response(JSON.stringify({ ...responseBody(), model: "synthetic-secret", answers: {} }))
  ]) {
    const result = await createJevProvider({ apiKey: "synthetic-secret", fetch: transport }).evaluate(request);
    assert.equal(result.status, "failed");
    assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
    assert.equal(JSON.stringify(result).includes("private body"), false);
  }
});

test("optional undefined fields and ignored metadata cannot break source binding", async () => {
  const input = { ...request, questions: { hasDoor: { type: "noul" as const, instructions: "有门吗？", criteria: undefined } } };
  const result = await createJevProvider({ apiKey: "synthetic", fetch: fakeFetch({ ...responseBody(), answers: { hasDoor: responseBody().answers.hasDoor } }) }).evaluate(input);
  assert.equal(result.status, "review");
  const circular: any = {}; circular.self = circular;
  assert.equal(validateSemanticResult(request, { ...await evaluate(), scope: { ...request.scope, accountId: circular } }).status, "failed");
});

test("body timeout cancels a stream even when injected fetch ignores abort", async () => {
  let cancelled = false;
  const result = await createJevProvider({ apiKey: "synthetic", timeoutMs: 10, fetch: async () => new Response(new ReadableStream({
    cancel() { cancelled = true; }
  })) }).evaluate(request);
  assert.equal(result.reason, "timeout");
  assert.equal(cancelled, true);
});

test("deadline covers fetch and body reading; aborts once without retries", async () => {
  for (const hangBody of [false, true]) {
    let calls = 0;
    let signal: AbortSignal | undefined;
    const result = await createJevProvider({ apiKey: "synthetic", timeoutMs: 10, fetch: async (_url, init) => {
      calls++; signal = init?.signal as AbortSignal;
      if (!hangBody) return await new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start(controller) {
        signal!.addEventListener("abort", () => controller.error(new Error("synthetic secret body timeout")), { once: true });
      } }));
    } }).evaluate(request);
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "timeout");
    assert.equal(signal?.aborted, true);
    assert.equal(calls, 1);
  }
});

test("cache key includes source, scope, evidence, questions, policy and immutable model", () => {
  const options = { providerId: "jev", modelVersion: "jev-1.13.0", policyVersion: "policy-1" };
  const key = buildSemanticCacheKey(request, options);
  assert.match(key!, /^semantic-judgment:v1:[a-f0-9]{64}$/);
  assert.equal(buildSemanticCacheKey({ ...request, state: { candidates: ["林青", "小林"], source: "林青推门进入房间。" } }, options), key);
  for (const input of [
    { ...request, scope: { ...request.scope, accountId: "account-b" } },
    { ...request, scope: { ...request.scope, projectId: "project-b" } },
    { ...request, scope: { ...request.scope, sourceVersion: "source-2" } },
    { ...request, scope: { ...request.scope, questionVersion: "questions-2" } },
    { ...request, state: "不同原文" },
    { ...request, questions: { hasDoor: request.questions.hasDoor } }
  ]) assert.notEqual(buildSemanticCacheKey(input, options), key);
  for (const change of [{ policyVersion: "policy-2" }, { modelVersion: "jev-1.14.0" }, { providerId: "local-llm" }])
    assert.notEqual(buildSemanticCacheKey(request, { ...options, ...change }), key);
  for (const modelVersion of [null, "", "jev-latest", "latest", "jev-1.13"])
    assert.equal(buildSemanticCacheKey(request, { ...options, modelVersion }), null);
});

test("unresolved Choice remains review even at certainty and with calibrated thresholds", async () => {
  for (const fallback of ["unknown", "none", "UNKNOWN"]) {
    const input: SemanticJudgmentRequest = { ...request, questions: { identity: {
      type: "choice", instructions: "选择明确的人名，否则选未决项。", candidateCoverage: "complete-set",
      criteria: { lin: "林青", [fallback]: "尚不能决定" }
    } } };
    const raw = { ...responseBody(), answers: { identity: {
      type: "choice", choice: fallback, probabilities: { lin: 0, [fallback]: 1 }, confidence: 1
    } } };
    const result = await createJevProvider({ apiKey: "synthetic-key", fetch: fakeFetch(raw) }).evaluate(input);
    for (const gatePolicy of [undefined, { ...policy, thresholds: { identity: policy.thresholds.identity } }]) {
      const gated = gateSemanticResult(input, result, gatePolicy);
      assert.equal(gated.status, "review");
      assert.equal(gated.reason, "unresolved_choice");
      assert.equal(gated.answers?.identity.type === "choice" && gated.answers.identity.choice, fallback);
    }
  }
});

test("invalid model metadata retains known usage without returning secret fields", async () => {
  for (const model of [undefined, "", 17, "invalid model private-body", "jev-synthetic-key"]) {
    const result = await evaluate({ ...responseBody(), model, usage: { input_tokens: 0, output_tokens: 17 } });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, "invalid_response");
    assert.equal(result.model, null);
    assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 17 });
    assert.equal(JSON.stringify(result).includes("synthetic-key"), false);
    assert.equal(JSON.stringify(result).includes("private-body"), false);
  }
  const partial = await evaluate({ ...responseBody(), model: null, usage: { input_tokens: 91, output_tokens: "synthetic-key" } });
  assert.deepEqual(partial.usage, { inputTokens: 91, outputTokens: null });
});

test("Score rejects reversed level meaning even with valid probabilities and score", async () => {
  const raw = responseBody();
  raw.answers.action.legend = { "0": "写明具体动作", "1": "未写动作" };
  const result = await evaluate(raw);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "invalid_response");
  assert.equal(gateSemanticResult(request, result, policy).status, "failed");
});

test("structured Score legend accepts equivalent JSON, normalizes it, and rejects summaries", async () => {
  const criteria = [{ label: "low", examples: ["动作未写明"] }, { label: "high", examples: ["动作明确"] }];
  const input: SemanticJudgmentRequest = { ...request, questions: { action: { type: "score", instructions: "动作是否明确？", criteria } } };
  const raw = { ...responseBody(), answers: { action: { ...responseBody().answers.action, legend: {
    "0": { examples: ["动作未写明"], label: "low" }, "1": JSON.stringify(criteria[1])
  } } } };
  const result = await createJevProvider({ apiKey: "synthetic", fetch: fakeFetch(raw) }).evaluate(input);
  assert.equal(result.status, "review");
  assert.deepEqual(result.answers?.action.type === "score" && result.answers.action.legend, { "0": criteria[0], "1": criteria[1] });
  for (const legend of [
    { "0": JSON.stringify(criteria[1]), "1": JSON.stringify(criteria[0]) },
    { "0": "low", "1": "high" }
  ]) {
    const invalid = await createJevProvider({ apiKey: "synthetic", fetch: fakeFetch({ ...raw, answers: { action: { ...raw.answers.action, legend } } }) }).evaluate(input);
    assert.equal(invalid.status, "failed");
  }
});

test("sparse Score criteria are rejected before transport", async () => {
  let calls = 0;
  const criteria = ["low", "high"];
  delete criteria[1];
  const input: SemanticJudgmentRequest = { ...request, questions: { action: { type: "score", instructions: "动作是否明确？", criteria } } };
  const result = await createJevProvider({ apiKey: "synthetic", fetch: async () => { calls++; return new Response("{}"); } }).evaluate(input);
  assert.equal(result.reason, "invalid_request");
  assert.equal(calls, 0);
});

test("cache refuses mutable model aliases across common separators", () => {
  const options = { providerId: "local-llm", policyVersion: "policy-1" };
  for (const modelVersion of ["local@latest", "local.latest", "local_latest", "local:default", "local/default", "local+AUTO", "local\\stable", "local stable", "latest@local", "local#latest", "local?rev=stable"])
    assert.equal(buildSemanticCacheKey(request, { ...options, modelVersion }), null, modelVersion);
  assert.notEqual(buildSemanticCacheKey(request, { ...options, modelVersion: "local@sha256:ab412f" }), null);
});

test("response byte cap cancels oversized multibyte streams without leaking the body", async () => {
  const encoded = new TextEncoder().encode(JSON.stringify({ ...responseBody(), padding: "界".repeat(750_000) + "synthetic-key" }));
  let offset = 0, cancelled = false, calls = 0;
  const result = await createJevProvider({ apiKey: "synthetic-key", fetch: async () => {
    calls++;
    return new Response(new ReadableStream({
      pull(controller) {
        if (offset >= encoded.length) { controller.close(); return; }
        const chunk = encoded.subarray(offset, offset + 64 * 1024); offset += chunk.length; controller.enqueue(chunk);
      },
      cancel() { cancelled = true; }
    }));
  } }).evaluate(request);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "response_too_large");
  assert.equal(cancelled, true);
  assert.equal(calls, 1);
  assert.ok(offset < encoded.length);
  assert.equal(JSON.stringify(result).includes("synthetic-key"), false);
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null });
});

test("response byte cap accepts exactly 2 MiB and rejects one extra byte", async () => {
  const empty = { ...responseBody(), padding: "" };
  const remaining = 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(empty));
  for (const extra of [0, 1]) {
    const result = await evaluate({ ...empty, padding: "x".repeat(remaining + extra) });
    assert.equal(result.status, extra ? "failed" : "review");
    if (extra) assert.equal(result.reason, "response_too_large");
  }
});

test("alternative provider binds results using the public request fingerprint", async () => {
  assert.equal(typeof semanticJudgment.semanticRequestFingerprint, "function");
  const provider: SemanticProvider = { evaluate: async input => ({
    status: "review", reason: "uncalibrated", scope: { ...input.scope },
    requestFingerprint: semanticJudgment.semanticRequestFingerprint(input),
    providerId: "local-rule", probabilityKind: "none", model: null,
    answers: {
      identity: { type: "choice", choice: "lin", probabilities: null, confidence: null },
      hasDoor: { type: "noul", noul: null, decision: true },
      action: { type: "score", score: 1, probabilities: null, confidence: null, legend: null }
    },
    usage: { inputTokens: null, outputTokens: null }, httpStatus: null, policyVersion: null
  }) };
  const result = await provider.evaluate(request);
  assert.equal(validateSemanticResult(request, result).status, "review");
  assert.equal(validateSemanticResult({ ...request, state: "证据已改变" }, result).status, "failed");
  assert.equal(semanticJudgment.semanticRequestFingerprint({ ...request, questions: {} }), null);
});

test("credential rotation cannot change in-flight redaction or transport/model binding", async () => {
  let firstCalls = 0, nextCalls = 0;
  const nextFetch: typeof fetch = async (_url, init) => {
    nextCalls++;
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-new-key");
    assert.equal(JSON.parse(String(init?.body)).model, "jev-2.0.0");
    return new Response(JSON.stringify({ ...responseBody(), model: "jev-2.0.0" }));
  };
  const options = { apiKey: "synthetic-old-key", model: "jev-1.13.0", timeoutMs: 1_000, fetch: undefined as typeof fetch | undefined };
  options.fetch = async (_url, init) => {
    firstCalls++;
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-old-key");
    assert.equal(JSON.parse(String(init?.body)).model, "jev-1.13.0");
    options.apiKey = "synthetic-new-key";
    options.fetch = nextFetch;
    options.model = "jev-2.0.0";
    options.timeoutMs = 500;
    return new Response(JSON.stringify({ ...responseBody(), model: "jev-synthetic-old-key" }));
  };
  const provider = createJevProvider(options);
  const first = await provider.evaluate(request);
  assert.equal(first.status, "failed");
  assert.equal(first.reason, "invalid_response");
  assert.equal(first.model, null);
  assert.deepEqual(first.usage, { inputTokens: 91, outputTokens: 17 });
  assert.equal(JSON.stringify(first).includes("synthetic-old-key"), false);
  assert.equal(JSON.stringify(first).includes("synthetic-new-key"), false);
  assert.equal(firstCalls, 1);
  assert.equal(nextCalls, 0);
  const next = await provider.evaluate(request);
  assert.equal(next.status, "review");
  assert.equal(next.model, "jev-2.0.0");
  assert.equal(nextCalls, 1);
});

test("timeout rotation does not extend the deadline of an in-flight evaluation", async () => {
  let aborted = false, replacementCalls = 0;
  const options = { apiKey: "synthetic-old-key", model: "jev-1.13.0", timeoutMs: 10, fetch: undefined as typeof fetch | undefined };
  options.fetch = async (_url, init) => {
    options.timeoutMs = 100_000;
    options.model = "jev-2.0.0";
    options.apiKey = "synthetic-new-key";
    options.fetch = async () => { replacementCalls++; return new Response("{}"); };
    init?.signal?.addEventListener("abort", () => { aborted = true; }, { once: true });
    return await new Promise<Response>(() => {});
  };
  const result = await createJevProvider(options).evaluate(request);
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "timeout");
  assert.equal(result.model, null);
  assert.equal(aborted, true);
  assert.equal(replacementCalls, 0);
});
