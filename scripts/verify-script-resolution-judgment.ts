import assert from "node:assert/strict";
import { test } from "node:test";
import { createScriptResolutionJudgment } from "../lib/script-resolution-judgment";
import { semanticRequestFingerprint, type SemanticJudgmentRequest, type SemanticJudgmentResult, type SemanticProvider } from "../lib/semantic-judgment";
import type { ResolutionJudgmentInput } from "../lib/script-resolution-service";

const context = { actorId: "actor-test", sourceVersion: "source-test-v1", explicitExternalConsent: true };
const input = (text = "林青：我说：“阿宁：别走。”"): ResolutionJudgmentInput => ({
  projectId: "project-test", episodeId: "episode-test", provider: "CLI", episode: 1,
  startLine: 2, endLine: 2, lines: [{ line: 1, text: "第一集\n" }, { line: 2, text }, { line: 3, text: "△门关上。" }]
});
function fakeResult(request: SemanticJudgmentRequest, choice: string, kind: "jev-distribution" | "none" = "jev-distribution"): SemanticJudgmentResult {
  const question = request.questions.block_type;
  assert.equal(question.type, "choice");
  if (question.type !== "choice") throw new Error("fixture requires Choice");
  return {
    status: "review", reason: "uncalibrated", scope: { ...request.scope }, requestFingerprint: semanticRequestFingerprint(request),
    providerId: kind === "none" ? "local-rule" : "jev", probabilityKind: kind, model: kind === "none" ? null : "jev-1.13.0",
    answers: { block_type: { type: "choice", choice,
      probabilities: kind === "none" ? null : Object.fromEntries(Object.keys(question.criteria).map(key => [key, key === choice ? 1 : 0])),
      confidence: kind === "none" ? null : 1 } },
    usage: { inputTokens: 81, outputTokens: 9 }, httpStatus: null, policyVersion: null
  };
}
const fakeProvider = (choice: string, inspect?: (request: SemanticJudgmentRequest) => void): SemanticProvider => ({
  evaluate: async request => { inspect?.(request); return fakeResult(request, choice); }
});
const rawResponse = (body: string, choice = "DIALOGUE", extra: Record<string, unknown> = {}) => {
  const payload = JSON.parse(body);
  return { model: "jev-1.13.0", answers: { block_type: { type: "choice", choice,
    probabilities: Object.fromEntries(Object.keys(payload.questions.block_type.criteria).map(key => [key, key === choice ? 1 : 0])), confidence: 1
  } }, usage: { input_tokens: 23, output_tokens: 5 }, ...extra };
};

test("no consent neither reads configuration nor invokes any provider", async () => {
  let reads = 0, calls = 0;
  const judge = createScriptResolutionJudgment({ ...context, explicitExternalConsent: false,
    readConfig: () => { reads++; throw new Error("must not read credentials"); },
    provider: { evaluate: async () => { calls++; throw new Error("must not invoke provider"); } }
  });
  const result = await judge(input());
  assert.equal(result.choice, null);
  assert.equal(result.usage.code, "CONSENT_REQUIRED");
  assert.equal(result.usage.requestOutcome, "NOT_SENT");
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

test("missing key and mutable model aliases do not dispatch", async () => {
  let calls = 0;
  for (const config of [{ apiKey: "" }, { apiKey: "synthetic-secret", model: "jev-latest" }]) {
    const result = await createScriptResolutionJudgment({ ...context, readConfig: () => config,
      fetch: async () => { calls++; throw new Error("unexpected HTTP"); }
    })(input());
    assert.equal(result.choice, null);
    assert.equal(result.usage.requestOutcome, "NOT_SENT");
    assert.deepEqual([result.usage.inputTokens, result.usage.outputTokens], [null, null]);
    assert.ok(["MISSING_API_KEY", "INVALID_MODEL"].includes(result.usage.code));
    assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
  }
  assert.equal(calls, 0);
});

for (const name of ["林青", "阿宁", "Alex Chen", "伊万·彼得"]) test(`speaker is copied from the selected first header, not quoted colon text: ${name}`, async () => {
  const source = input(`${name}：我说：“另一个人：别走。”`), before = structuredClone(source);
  const result = await createScriptResolutionJudgment({ ...context, provider: fakeProvider("DIALOGUE", request => {
    assert.equal(request.scope.accountId, "actor-test");
    assert.equal(request.scope.sourceVersion, "source-test-v1");
    assert.equal(Object.keys(request.questions).length, 1);
    assert.equal(request.questions.block_type.type, "choice");
    assert.deepEqual(Object.keys(request.questions.block_type.criteria!).sort(), ["ACTION", "DIALOGUE", "CONTINUITY", "EMOTION_CLUE", "RELATIONSHIP_CONTEXT", "KNOWLEDGE_REVEAL", "SPACE_CONSTRAINT", "CREATIVE_GUIDANCE", "UNKNOWN"].sort());
  }) })(source);
  assert.deepEqual(result.choice, { type: "DIALOGUE", speaker: name, channel: "SPEECH" });
  assert.equal(result.usage.status, "review");
  assert.equal(result.usage.code, "SUGGESTED_REVIEW");
  assert.equal(result.usage.probabilities?.DIALOGUE, 1);
  assert.deepEqual(source, before);
  assert.match(result.note, /人工|手动/);
});

for (const [text, speaker, channel] of [
  ["林青（OS）：我不能相信。", "林青", "OS"],
  ["阿宁(VO)：别回头。", "阿宁", "VO"],
  ["旁白：风停了。", "旁白", "NARRATION"],
  ["系统音：任务开始。", "系统音", "SYSTEM"]
]) test(`explicit source channel is preserved: ${channel}`, async () => {
  const result = await createScriptResolutionJudgment({ ...context, provider: fakeProvider("DIALOGUE") })(input(text));
  assert.deepEqual(result.choice, { type: "DIALOGUE", speaker, channel });
});

test("unknown choice and unidentifiable dialogue headers never become accepted candidates", async () => {
  const unknown = await createScriptResolutionJudgment({ ...context, provider: fakeProvider("UNKNOWN") })(input());
  assert.equal(unknown.choice, null);
  assert.equal(unknown.usage.code, "UNKNOWN_CHOICE");
  assert.equal(unknown.usage.status, "review");
  for (const text of ["“阿宁：别走。”", "：没有说者。", "林青（OS，VO）：不确定声道。", "△林青：推开了门。", "林青（内心独白）：不能猜作普通对白。"] ) {
    const result = await createScriptResolutionJudgment({ ...context, provider: fakeProvider("DIALOGUE") })(input(text));
    assert.equal(result.choice, null);
    assert.equal(result.usage.code, "DIALOGUE_HEADER_UNKNOWN");
    assert.equal(result.usage.status, "review");
  }
});

test("non-dialogue candidate has no invented speaker, channel or body", async () => {
  const result = await createScriptResolutionJudgment({ ...context, provider: fakeProvider("ACTION") })(input("△林青推门。"));
  assert.deepEqual(result.choice, { type: "ACTION" });
  assert.equal(JSON.stringify(result.choice).includes("林青推门"), false);
});

test("source range validation runs before credentials and external dispatch", async () => {
  let reads = 0, calls = 0;
  const judge = createScriptResolutionJudgment({ ...context, readConfig: () => { reads++; return { apiKey: "synthetic" }; }, fetch: async () => { calls++; throw new Error("unexpected"); } });
  const sparse = input(); delete sparse.lines[1];
  for (const value of [ { ...input(), endLine: 31 }, { ...input(), lines: [{ line: 2, text: "x".repeat(6001) }] }, sparse ]) {
    const result = await judge(value);
    assert.equal(result.choice, null);
    assert.equal(result.usage.code, "INVALID_INPUT");
    assert.equal(result.usage.requestOutcome, "NOT_SENT");
  }
  assert.equal(reads, 0); assert.equal(calls, 0);
});

test("real adapter contract pins the model and records returned usage without automatic acceptance", async () => {
  let calls = 0, reads = 0;
  const result = await createScriptResolutionJudgment({ ...context,
    readConfig: () => { reads++; return { apiKey: "synthetic-secret" }; }, fetch: async (url, init) => {
      calls++;
      assert.equal(url, "https://api.typesafe.ai/v1/systemone");
      assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer synthetic-secret");
      assert.equal(JSON.parse(String(init?.body)).model, "jev-1.13.0");
      assert.equal(String(init?.body).includes("synthetic-secret"), false);
      return new Response(JSON.stringify(rawResponse(String(init?.body))));
    }
  })(input());
  assert.equal(calls, 1); assert.equal(reads, 1);
  assert.equal(result.usage.requestedModel, "jev-1.13.0");
  assert.equal(result.usage.model, "jev-1.13.0");
  assert.equal(result.usage.status, "review");
  assert.equal(result.usage.requestOutcome, "RESPONDED");
  assert.deepEqual([result.usage.inputTokens, result.usage.outputTokens], [23, 5]);
  assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
});

test("malformed response preserves known usage and does not call a fallback", async () => {
  let calls = 0;
  const result = await createScriptResolutionJudgment({ ...context, readConfig: () => ({ apiKey: "synthetic-secret" }), fetch: async (_url, init) => {
    calls++; return new Response(JSON.stringify(rawResponse(String(init?.body), "DIALOGUE", { model: "jev-synthetic-secret" })));
  } })(input());
  assert.equal(calls, 1);
  assert.equal(result.choice, null);
  assert.equal(result.usage.code, "INVALID_RESPONSE");
  assert.equal(result.usage.status, "failed");
  assert.equal(result.usage.requestOutcome, "RESPONDED");
  assert.deepEqual([result.usage.inputTokens, result.usage.outputTokens], [23, 5]);
  assert.equal(JSON.stringify(result).includes("synthetic-secret"), false);
});

test("timeout, HTTP errors and provider exceptions never trigger CLI/API fallback", async () => {
  let calls = 0;
  const timed = await createScriptResolutionJudgment({ ...context, timeoutMs: 10, readConfig: () => ({ apiKey: "synthetic-secret" }),
    fetch: async () => { calls++; return new Promise<Response>(() => {}); }
  })(input());
  assert.equal(timed.choice, null); assert.equal(timed.usage.code, "TIMEOUT");
  assert.equal(timed.usage.requestOutcome, "UNKNOWN"); assert.equal(calls, 1);
  const http = await createScriptResolutionJudgment({ ...context, readConfig: () => ({ apiKey: "synthetic-secret" }), fetch: async () => {
    calls++; return new Response("synthetic-secret private error", { status: 529 });
  } })(input());
  assert.equal(http.choice, null); assert.equal(http.usage.code, "HTTP_ERROR");
  assert.equal(http.usage.requestOutcome, "RESPONDED"); assert.equal(calls, 2);
  const thrown = await createScriptResolutionJudgment({ ...context, provider: { evaluate: async () => { calls++; throw new Error("synthetic-secret"); } } })(input());
  assert.equal(thrown.choice, null); assert.equal(thrown.usage.code, "PROVIDER_ERROR");
  assert.equal(thrown.usage.requestOutcome, "UNKNOWN"); assert.equal(calls, 3);
  assert.equal(JSON.stringify([timed, http, thrown]).includes("synthetic-secret"), false);
});

test("replacement provider is usable without key reads and self-reported scores stay non-Jev", async () => {
  let reads = 0;
  const result = await createScriptResolutionJudgment({ ...context, readConfig: () => { reads++; throw new Error("unneeded key"); },
    provider: { evaluate: async request => ({ ...fakeResult(request, "CONTINUITY", "none"), usage: { inputTokens: null, outputTokens: null } }) }
  })(input("连续性备注：衣服仍然湿着。"));
  assert.deepEqual(result.choice, { type: "CONTINUITY" });
  assert.equal(result.usage.providerId, "local-rule");
  assert.equal(result.usage.probabilityKind, "none");
  assert.equal(result.usage.probabilities, null);
  assert.equal(result.usage.confidence, null);
  assert.equal(result.usage.status, "review");
  assert.equal(reads, 0);
});

test("provider mutation cannot rebind the trusted source, but known usage is retained", async () => {
  const result = await createScriptResolutionJudgment({ ...context, provider: { evaluate: async request => {
    request.scope.accountId = "different-actor";
    request.state = "different evidence";
    return fakeResult(request, "ACTION");
  } } })(input());
  assert.equal(result.choice, null);
  assert.equal(result.usage.code, "INVALID_RESPONSE");
  assert.deepEqual([result.usage.inputTokens, result.usage.outputTokens], [81, 9]);
});

test("configured pinned model and actual returned version are separately recorded", async () => {
  const result = await createScriptResolutionJudgment({ ...context, readConfig: () => ({ apiKey: "synthetic", model: "jev-1.14.0" }),
    fetch: async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).model, "jev-1.14.0");
      return new Response(JSON.stringify(rawResponse(String(init?.body), "DIALOGUE", { model: "jev-1.14.0" })));
    }
  })(input());
  assert.equal(result.usage.requestedModel, "jev-1.14.0");
  assert.equal(result.usage.model, "jev-1.14.0");
  assert.equal(result.usage.status, "review");
});
