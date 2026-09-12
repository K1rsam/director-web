import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { buildSourceIndex, requireF1Output, FoundationContractError, type FoundationIssue } from "@/lib/project-foundation-contracts";
import { requireProductionOptimization } from '@/lib/foundation-production-contracts';
import type { FoundationCallContext, FoundationStageRunner } from "@/lib/project-foundation";
import type { RoleRunResult } from "@/lib/role-runner";
import type { DeliveryAttempt, DeliveryCallError } from "@/lib/foundation-delivery-call";

// Fake runner only: no environment writes, real provider calls, or database operations.
const issue = (coordinate: string): FoundationIssue => ({ severity: "BLOCKER", owner: "PROGRAM", coordinate, problem: "须为有效文本", sourceRefs: [] });
const context: FoundationCallContext = {
  provider: "CLI", role: { code: "F1", skill: "", systemPrompt: "完整岗位规则", model: "offline-model", reasoningEffort: "high" },
  sessionMode: "ephemeral", runId: "offline-run", batchToken: "offline-batch", sourceVersion: "source-v1", inputVersion: "input-v1", chunkIndex: 2, scope: [2]
};
const task = { scope: [2], source: [{ number: 2, content: "不可改写的原文，含 INPUT_JSON: 字样。" }], registry: [{ key: "CH_EXPLICIT", name: "原角色" }] };
const prompt = `执行本批。\nINPUT_JSON:\n${JSON.stringify(task)}`;
const valid = { coverage: [2], overview: "保留概述", episodes: [{ number: 2, summary: "有效摘要", context: "保留前情" }] };
const invalid = { ...valid, episodes: [{ ...valid.episodes[0], summary: 17 }] };
function response(data: unknown, rawOutput = JSON.stringify(data)): RoleRunResult {
  return { data: data as Record<string, unknown>, rawOutput, sessionId: null, stdout: '{"type":"turn.completed","usage":{"input_tokens":42,"output_tokens":9}}', stderr: "原始诊断" };
}
function validate(data: unknown) {
  const value = data as typeof valid;
  if (!value || typeof value !== "object" || !Array.isArray(value.episodes)) throw new FoundationContractError("返回结构错误", [issue("F1")]);
  if (typeof value.episodes[0]?.summary !== "string") throw new FoundationContractError("摘要结构错误", [issue("episodes.0.summary")], { inventedCandidate: true });
  assert.deepEqual(value.coverage, [2]);
  return value;
}
function queued(...values: Array<RoleRunResult | Error>) {
  const calls: Array<{ stage: string; prompt: string; context: FoundationCallContext }> = [];
  const runner: FoundationStageRunner = async (stage, prompt, context) => {
    calls.push({ stage, prompt, context: structuredClone(context) });
    const value = values[calls.length - 1];
    assert.ok(value, "unexpected extra provider call");
    if (value instanceof Error) throw value;
    return value;
  };
  return { calls, runner };
}
async function main() {
  assert.ok(existsSync(resolve("lib/foundation-delivery-call.ts")), "delivery call adapter must exist");
  const { runFoundationDeliveryCall: run, DeliveryCallError: CallError } = await import("@/lib/foundation-delivery-call");
  assert.equal(typeof run, "function", "delivery adapter must expose a callable entry point");
  const failed = async (operation: () => Promise<unknown>) => {
    let error: unknown;
    try { await operation(); } catch (value) { error = value; }
    assert.ok(error instanceof CallError, "failure must retain typed call evidence");
    return error as DeliveryCallError;
  };
  let passed = 0;
  async function check(name: string, test: () => Promise<void>) { await test(); passed++; console.log(`PASS ${name}`); }

  const savedAttempt = (extra: Partial<DeliveryAttempt> = {}): DeliveryAttempt => ({ sequence: 1, kind: 'INITIAL', scope: [2], systemPrompt: context.role.systemPrompt!, taskPrompt: prompt,
    provider: 'CLI', model: 'offline-model', reasoningEffort: 'high', startedAt: new Date(0).toISOString(), status: 'FAILED', requestOutcome: 'RESPONDED', providerCallCount: 1, response: response(invalid), issues: [issue('episodes.0.summary')], ...extra });
  await check('a saved response is revalidated locally with no new request or counted attempt', async () => {
    const saved = savedAttempt({ response: { rawOutput: `\ufeff\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`` } }), fake = queued();
    const result = await run({ stage: 'F1', prompt, context, validate, runner: fake.runner, resumeFrom: saved, maxRepairAttempts: 0,
      onAttempt: async () => assert.fail('local response replay must not append a paid attempt'), beforeRequest: async () => assert.fail('local replay does not reserve a call') });
    assert.deepEqual(result.output, valid); assert.equal(fake.calls.length, 0); assert.deepEqual(result.attempts, []); assert.equal(saved.providerCallCount, 1);
  });
  await check('resuming a paid invalid response purchases only its remaining scoped format repair', async () => {
    const fake = queued(response({ ...valid, overview: '越界改写应丢弃' }));
    const result = await run({ stage: 'F1', prompt, context, validate, runner: fake.runner, resumeFrom: savedAttempt(), takeRepairBudget: async () => true });
    assert.equal(fake.calls.length, 1); assert.equal(result.output.overview, valid.overview);
    assert.deepEqual(result.attempts.map(attempt => [attempt.kind, attempt.sequence, attempt.providerCallCount]), [['FORMAT_REPAIR', 1, 1]]);
    assert.ok(JSON.parse(fake.calls[0].prompt.split('INPUT_JSON:\n').at(-1)!).repairRequest);
  });
  await check('an exhausted saved failure cannot fall back to a fresh initial request', async () => {
    const fake = queued();
    const error = await failed(() => run({ stage: 'F1', prompt, context, validate, runner: fake.runner, resumeFrom: savedAttempt(), maxRepairAttempts: 0 }));
    assert.equal(fake.calls.length, 0); assert.deepEqual(error.attempts, []); assert.equal(error.outcome, 'RESPONDED');
  });
  await check('a persistent call guard runs before any dispatch intent is counted', async () => {
    const fake = queued(response(valid));
    const error = await failed(() => run({ stage: 'F1', prompt, context, validate, runner: fake.runner, beforeRequest: async () => { throw new Error('同一输入已消费请求额度'); } }));
    assert.equal(fake.calls.length, 0); assert.equal(error.outcome, 'NOT_SENT'); assert.equal(error.attempts[0]?.providerCallCount, 0);
  });
  await check('saved UNKNOWN and NOT_SENT fragments are never replayed as responded evidence', async () => {
    for (const requestOutcome of ['UNKNOWN', 'NOT_SENT'] as const) {
      const fake = queued();
      await failed(() => run({ stage: 'F1', prompt, context, validate, runner: fake.runner, resumeFrom: savedAttempt({ requestOutcome, response: response(valid) }) }));
      assert.equal(fake.calls.length, 0);
    }
  });

  await check('an aggregate error never grants authority to rewrite correct nested edits', async () => {
    const index = buildSourceIndex([{ number: 2, title: null, content: '原事件。' }]);
    const original = { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [2], changes: { episodes: [{ number: 2, summary: '原正确摘要' }], unknownFormatKey: true } };
    const replacement = { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [2], changes: { episodes: [{ number: 2, summary: '被换成另一事件' }] } };
    const fake = queued(response(original), response(replacement));
    const error = await failed(() => run({ stage: 'Q1', prompt, context: { ...context, role: { ...context.role, code: 'Q1' } }, validate: value => requireProductionOptimization(value, index, [2]), runner: fake.runner, takeRepairBudget: async () => true }));
    assert.equal(fake.calls.length, 1, 'unsafe aggregate paths fail before purchasing a content rewrite');
    assert.deepEqual(error.attempts[0].response?.data, original);
  });

  await check("real F1 validation repairs mechanical paths without applying author-reported issues", async () => {
    const source = buildSourceIndex([{ number: 0, title: null, content: "第0集原文，必须保留。" }]);
    for (const owner of ["F1", "PROGRAM"] as const) {
      const authorIssue: FoundationIssue = { severity: "MINOR", owner, coordinate: owner === "F1" ? "第0集" : "overview", problem: "作者自报提醒，不授权修改正确概述", sourceRefs: [] };
      const malformed = { coverage: [0], overview: "正确概述原样保留", episodes: [{ number: 0, summary: 17 }], issues: [authorIssue] };
      const repaired = { coverage: [0], overview: "修复轮越权改写", episodes: [{ number: 0, summary: "修好摘要" }], issues: [] };
      const fake = queued(response(malformed), response(repaired));
      const result = await run({ stage: "F1", prompt: `INPUT_JSON:\n${JSON.stringify({ scope: [0], source })}`, context: { ...context, scope: [0], sourceVersion: source.version },
        validate: value => requireF1Output(value, source, [0]), runner: fake.runner, takeRepairBudget: async () => true });
      assert.equal(fake.calls.length, 2);
      assert.equal(result.output.overview, malformed.overview);
      assert.equal(result.output.episodes[0].summary, "修好摘要");
      assert.deepEqual(result.output.issues, [authorIssue], "author notes stay intact as content, not repair instructions");
      assert.deepEqual(result.attempts[1].normalization?.paths, ["episodes.0.summary"]);
      const repairRequest = JSON.parse(fake.calls[1].prompt.split("INPUT_JSON:\n").at(-1)!).repairRequest;
      assert.deepEqual(repairRequest.issues.map((item: FoundationIssue) => item.coordinate), ["episodes.0.summary"]);
      assert.deepEqual(result.attempts[0].response?.data, malformed);
      assert.deepEqual(result.attempts[1].response?.data, repaired);
    }
  });

  await check("unmapped mechanical issues cannot expand a known repair to the whole parsed object", async () => {
    const fake = queued(response(invalid), response({ ...valid, overview: "不得采纳" }));
    const result = await run({ stage: "F1", prompt, context, runner: fake.runner, validate: data => {
      if (typeof (data as typeof valid).episodes[0].summary !== "string") throw new FoundationContractError("two mechanical issues", [issue("第2集全局约束"), issue("episodes.0.summary")]);
      return validate(data);
    }, takeRepairBudget: async () => true });
    assert.equal(result.output.overview, valid.overview);
    assert.deepEqual(result.attempts[1].normalization?.paths, ["episodes.0.summary"]);
  });

  await check("one scoped repair preserves raw responses and every correct field", async () => {
    const original = response(structuredClone(invalid), "  原始返回完整保留\n");
    const repair = response({ coverage: [99], overview: "不得采纳", episodes: [{ number: 99, summary: "修好的摘要", context: "不得采纳" }] });
    const fake = queued(original, repair), saved: DeliveryAttempt[] = [];
    let budgetCalls = 0;
    const result = await run({ stage: "F1", prompt, context, validate, runner: fake.runner,
      onAttempt: async attempt => { saved.push(structuredClone(attempt)); },
      takeRepairBudget: async () => { budgetCalls++; assert.equal(saved.at(-1)?.status, "FAILED"); return true; }
    });
    assert.equal(fake.calls.length, 2);
    assert.equal(budgetCalls, 1);
    assert.deepEqual(result.output, { ...valid, episodes: [{ ...valid.episodes[0], summary: "修好的摘要" }] });
    assert.deepEqual(result.attempts.map(a => [a.kind, a.status, a.providerCallCount, a.scope]), [["INITIAL", "FAILED", 1, [2]], ["FORMAT_REPAIR", "SUCCEEDED", 1, [2]]]);
    assert.deepEqual(result.attempts[0].response, original);
    assert.deepEqual(result.attempts[1].response, repair);
    assert.deepEqual(original.data, invalid);
    assert.ok(result.attempts[1].normalization, "program merge must be labelled, not masquerade as provider output");
    const repairedTask = JSON.parse(fake.calls[1].prompt.split(/\nINPUT_JSON:\s*\n/).at(-1)!);
    assert.equal(repairedTask.source, undefined);
    assert.equal(repairedTask.registry, undefined);
    assert.deepEqual(repairedTask.repairRequest.fields.map((f: {path:string}) => f.path), ["episodes.0.summary"]);
    assert.deepEqual(repairedTask.scope, task.scope);
    assert.deepEqual(repairedTask.repairRequest.issues, [issue("episodes.0.summary")]);
    assert.ok(fake.calls[1].prompt.includes("只修"));
    assert.equal(result.response.rawOutput, repair.rawOutput);
    assert.equal(result.response.stdout, repair.stdout, "must not invent token/cache accounting");
  });

  await check("validator mutations cannot overwrite provider evidence", async () => {
    const original = response(structuredClone(valid)), fake = queued(original);
    const result = await run({ stage: "F1", prompt, context, runner: fake.runner, validate: value => {
      const parsed = validate(value); parsed.overview = "程序规范化"; return parsed;
    } });
    assert.equal(result.output.overview, "程序规范化");
    assert.equal(result.attempts[0].response?.data?.overview, "保留概述");
    assert.equal(original.data.overview, "保留概述");
  });

  await check("BOM, fences and trailing commas normalize without changing strings or a new request", async () => {
    const text = '\ufeff```json\n{"coverage":[2,],"overview":"保留,}与,]及\\\"引号", "episodes":[{"number":2,"summary":"有效摘要","context":"保留前情",},],}\n```';
    const error = Object.assign(new Error("CLI返回内容不是合法JSON"), { requestOutcome: "RESPONDED", rawOutput: text, stdout: "完整stdout", stderr: "完整stderr" });
    const fake = queued(error);
    const result = await run({ stage: "F1", prompt, context, validate, runner: fake.runner, takeRepairBudget: async () => { assert.fail("normalization needs no repair budget"); } });
    assert.equal(fake.calls.length, 1);
    assert.equal(result.output.overview, '保留,}与,]及"引号');
    assert.equal(result.attempts[0].response?.rawOutput, text);
    assert.equal(result.attempts[0].response?.data, undefined, "parsed normalization must not overwrite the transport error");
    assert.ok(result.attempts[0].normalization);
  });

  await check("one reversible JSON string wrapper unwraps with no repair", async () => {
    const fake = queued(response(JSON.stringify(valid)));
    const result = await run({ stage: "F1", prompt, context, validate, runner: fake.runner });
    assert.deepEqual(result.output, valid);
    assert.equal(fake.calls.length, 1);
  });

  await check("unknown and not-sent outcomes never retry even with raw fragments", async () => {
    for (const outcome of ["UNKNOWN", "NOT_SENT"] as const) {
      const fake = queued(Object.assign(new Error("CLI返回内容不是合法JSON"), { requestOutcome: outcome, rawOutput: JSON.stringify(valid), stdout: "片段", stderr: "故障", data: valid }));
      const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner, takeRepairBudget: async () => { assert.fail("transport failure must not request repair budget"); } }));
      assert.equal(fake.calls.length, 1);
      assert.equal(error.outcome, outcome);
      assert.equal(error.attempts[0].response?.data, undefined, "error.data is not proof of model response");
      assert.equal(error.attempts[0].response?.rawOutput, JSON.stringify(valid));
    }
  });

  await check("HTTP, configuration and API-envelope errors are not model-format repairs", async () => {
    for (const message of ["DeepSeek API 请求失败（HTTP 503）", "缺少 API Key", "DeepSeek API 响应结构异常：缺少字符串 choices[0].message.content", "Unexpected token '<', '<html>' is not valid JSON"]) {
      const fake = queued(Object.assign(new Error(message), { requestOutcome: "RESPONDED", rawOutput: '{"error":"service unavailable"}', stderr: "服务错误" }));
      const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner, takeRepairBudget: async () => { assert.fail("service error is not repairable model content"); } }));
      assert.equal(fake.calls.length, 1);
      assert.equal(error.outcome, "RESPONDED");
      assert.equal(error.attempts[0].response?.stderr, "服务错误");
    }
  });

  await check("empty model output is not repaired", async () => {
    const fake = queued(Object.assign(new Error("CLI返回内容不是合法JSON"), { requestOutcome: "RESPONDED", rawOutput: "  " }));
    await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner, takeRepairBudget: async () => { assert.fail("no content to repair"); } }));
    assert.equal(fake.calls.length, 1);
  });

  await check("no explicit budget means no automatic repair", async () => {
    for (const takeRepairBudget of [undefined, async () => false]) {
      const fake = queued(response(invalid));
      const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner, takeRepairBudget }));
      assert.equal(fake.calls.length, 1);
      assert.equal(error.attempts[0].status, "FAILED");
      assert.deepEqual(error.issues, [issue("episodes.0.summary")]);
    }
  });

  await check("no-progress and exhausted repair never loop, even with a larger supplied maximum", async () => {
    for (const maximum of [1, 9]) {
      const fake = queued(response(invalid), response(invalid));
      const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner, maxRepairAttempts: maximum, takeRepairBudget: async () => true }));
      assert.equal(fake.calls.length, 2);
      assert.equal(error.attempts.length, 2);
      assert.equal(error.attempts[1].status, "FAILED");
    }
  });

  await check("invalid JSON repairs current task without injecting another INPUT_JSON marker", async () => {
    const fake = queued(Object.assign(new Error("CLI返回内容不是合法JSON"), { requestOutcome: "RESPONDED", rawOutput: '{"coverage":[' }), response(valid));
    const result = await run({ stage: "F1", prompt, context, validate, runner: fake.runner, takeRepairBudget: async () => true });
    assert.deepEqual(result.output, valid);
    assert.equal(fake.calls.length, 2);
    const taskText = fake.calls[1].prompt.slice(fake.calls[1].prompt.indexOf("\nINPUT_JSON:\n") + "\nINPUT_JSON:\n".length);
    const parsed = JSON.parse(taskText);
    assert.deepEqual(parsed.source, task.source);
    assert.deepEqual(parsed.registry, task.registry);
    assert.deepEqual(parsed.scope, [2]);
  });

  await check("legacy prompt gets an explicit parseable current-task repair envelope", async () => {
    const fake = queued(response(invalid), response(valid));
    await run({ stage: "F1", prompt: "旧任务：只处理第二集。原文。", context, validate, runner: fake.runner, takeRepairBudget: async () => true });
    const envelope = JSON.parse(fake.calls[1].prompt.split("\nINPUT_JSON:\n").at(-1)!);
    assert.equal(envelope.originalTaskPrompt, undefined);
    assert.deepEqual(envelope.repairRequest.fields.map((f: {path:string}) => f.path), ["episodes.0.summary"]);
    assert.deepEqual(envelope.scope, [2]);
    assert.ok(envelope.repairRequest);
  });

  await check("explicit bracket paths work, while identity-like coordinates are never guessed", async () => {
    const fake = queued(response(invalid), response({ ...valid, overview: "越界改写" }));
    const result = await run({ stage: "F1", prompt, context, runner: fake.runner, validate: value => {
      const candidate = value as typeof valid;
      if (typeof candidate.episodes[0].summary !== "string") throw new FoundationContractError("bad", [issue("$.episodes[0].summary")]);
      return candidate;
    }, takeRepairBudget: async () => true });
    assert.equal(result.output.overview, "保留概述");
    const unknown = queued(response(invalid), response(valid));
    const rejected = await failed(() => run({ stage: "F1", prompt, context, runner: unknown.runner, validate: value => {
      const candidate = value as typeof valid;
      if (typeof candidate.episodes[0].summary !== "string") throw new FoundationContractError("bad", [issue("assets.CH_EXPLICIT.variants.V1.episodes")]);
      return candidate;
    }, takeRepairBudget: async () => true }));
    assert.equal(unknown.calls.length, 1, "no safe path means no speculative paid format repair");
    assert.deepEqual(rejected.attempts[0].response?.data, invalid);
  });

  await check("cancel before the initial request leaves zero calls", async () => {
    const fake = queued(response(valid));
    const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner, checkCurrent: async () => { throw new Error("已停止"); } }));
    assert.equal(fake.calls.length, 0);
    assert.equal(error.outcome, "NOT_SENT");
  });

  await check("cancel while initial persistence is pending blocks dispatch", async () => {
    const fake = queued(response(valid)); let current = true;
    const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner,
      checkCurrent: async () => { if (!current) throw new Error("源文已变化"); }, onAttempt: async () => { current = false; }
    }));
    assert.equal(fake.calls.length, 0);
    assert.equal(error.attempts.reduce((sum, a) => sum + a.providerCallCount, 0), 0);
  });

  await check("cancel after provider response retains raw output and blocks repair", async () => {
    let current = true, calls = 0;
    const runner: FoundationStageRunner = async () => { calls++; current = false; return response(invalid); };
    const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner,
      checkCurrent: async () => { if (!current) throw new Error("已停止"); }, takeRepairBudget: async () => { assert.fail("must stop before repair"); }
    }));
    assert.equal(calls, 1);
    assert.equal(error.outcome, "RESPONDED");
    assert.deepEqual(error.attempts[0].response?.data, invalid);
  });

  await check("cancel during failed-attempt persistence blocks repair budget and request", async () => {
    const fake = queued(response(invalid)); let current = true;
    const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner,
      checkCurrent: async () => { if (!current) throw new Error("已停止"); },
      onAttempt: async attempt => { if (attempt.status === "FAILED") current = false; },
      takeRepairBudget: async () => { assert.fail("cannot allocate repair after cancellation"); }
    }));
    assert.equal(fake.calls.length, 1);
    assert.equal(error.outcome, "RESPONDED");
  });

  await check("response-persistence failures retain evidence and cannot trigger another request", async () => {
    const fake = queued(response(invalid));
    const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner,
      onAttempt: async attempt => { if (attempt.response) throw new Error("存储失败"); },
      takeRepairBudget: async () => { assert.fail("storage failures must not repair"); }
    }));
    assert.equal(fake.calls.length, 1);
    assert.equal(error.outcome, "RESPONDED");
    assert.deepEqual(error.attempts[0].response?.data, invalid);
    assert.equal(error.attempts[0].status, "FAILED");
  });

  await check("cancel during repair-budget allocation prevents second request", async () => {
    const fake = queued(response(invalid)); let current = true;
    await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner,
      checkCurrent: async () => { if (!current) throw new Error("已停止"); }, takeRepairBudget: async () => { current = false; return true; }
    }));
    assert.equal(fake.calls.length, 1);
  });

  await check("global stage errors preserve a parsed object when no safe repair path exists", async () => {
    const fake = queued(response({ malformed: true }), response(valid));
    const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner, takeRepairBudget: async () => true }));
    assert.equal(fake.calls.length, 1);
    assert.deepEqual(error.attempts[0].response?.data, { malformed: true });
  });

  await check("field repair uses its patch contract and one terminal input object", async () => {
    const fake = queued(response(invalid), response(valid));
    const originalPrompt = `OUTPUT_SCHEMA:\n{"coverage":[],"episodes":[{"summary":"必需文本"}]}\n${prompt}`;
    await run({ stage: "F1", prompt: originalPrompt, context, validate, runner: fake.runner, takeRepairBudget: async () => true });
    assert.ok(fake.calls[1].prompt.includes("FIELD_REPAIR_V1"));
    assert.ok(!fake.calls[1].prompt.includes("OUTPUT_SCHEMA"), "field repair must not reintroduce the full authoring schema");
    assert.deepEqual(JSON.parse(fake.calls[1].prompt.split("\nINPUT_JSON:\n").at(-1)!).scope, [2]);
  });

  await check("a thrown falsy validation value can never mark a call successful", async () => {
    const fake = queued(response(valid)), saved: DeliveryAttempt[] = [];
    const error = await failed(() => run({ stage: "F1", prompt, context, runner: fake.runner,
      validate: () => { throw undefined; }, onAttempt: async attempt => { saved.push(attempt); }
    }));
    assert.equal(error.attempts[0].status, "FAILED");
    assert.equal(saved.some(attempt => attempt.status === "SUCCEEDED"), false);
  });

  await check("dispatch intent is durably UNKNOWN and counted before an uncertain provider call", async () => {
    let lastSaved: DeliveryAttempt | undefined;
    const runner: FoundationStageRunner = async () => {
      assert.equal(lastSaved?.requestOutcome, "UNKNOWN");
      assert.equal(lastSaved?.providerCallCount, 1);
      throw Object.assign(new Error("response lost after dispatch"), { requestOutcome: "UNKNOWN" });
    };
    const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner,
      onAttempt: async attempt => { lastSaved = attempt; }
    }));
    assert.equal(error.attempts[0].providerCallCount, 1);
    assert.equal(error.outcome, "UNKNOWN");
  });

  await check("known pre-dispatch persistence failure records zero calls in returned proof", async () => {
    const fake = queued(response(valid));
    const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner,
      onAttempt: async attempt => { if (attempt.requestOutcome === "UNKNOWN") throw new Error("dispatch marker save failed"); }
    }));
    assert.equal(fake.calls.length, 0);
    assert.equal(error.outcome, "NOT_SENT");
    assert.equal(error.attempts[0].providerCallCount, 0);
  });

  await check("a response save failure cannot turn an invoked request into zero calls", async () => {
    const fake = queued(response(valid));
    const error = await failed(() => run({ stage: "F1", prompt, context, validate, runner: fake.runner,
      onAttempt: async attempt => { if (attempt.response) throw new Error("response save failed"); }
    }));
    assert.equal(fake.calls.length, 1);
    assert.equal(error.attempts[0].providerCallCount, 1);
    assert.equal(error.outcome, "RESPONDED");
  });

  await check("a reversible trailing-text JSON wrapper requires no extra provider call", async () => {
    const raw = `${JSON.stringify(valid)}\n以上为本批结果。`;
    const fake = queued(Object.assign(new Error("CLI返回内容不是合法JSON"), { requestOutcome: "RESPONDED", rawOutput: raw }));
    const result = await run({ stage: "F1", prompt, context, validate, runner: fake.runner });
    assert.deepEqual(result.output, valid);
    assert.equal(fake.calls.length, 1);
    assert.equal(result.attempts[0].response?.rawOutput, raw);
  });

  await check("unexpected validator service errors never consume repair budget", async () => {
    const fake = queued(response(valid));
    const error = await failed(() => run({ stage: "F1", prompt, context, runner: fake.runner,
      validate: () => { throw new Error("database service unavailable"); },
      takeRepairBudget: async () => { assert.fail("program/service errors are not model content errors"); }
    }));
    assert.equal(fake.calls.length, 1);
    assert.match(error.message, /database service unavailable/);
  });

  console.log(`Foundation delivery-call: ${passed} offline checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
