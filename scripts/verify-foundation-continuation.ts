import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FoundationStageRunner } from "@/lib/project-foundation";

// Synthetic data only. Neither the application database nor a real provider is used.
const scratch = mkdtempSync(path.join(tmpdir(), "foundation-continuation-"));
const databaseUrl = `file:${path.join(scratch, "test.db")}`;
process.env.DATABASE_URL = databaseUrl;
copyFileSync(path.resolve("prisma/schema.prisma"), path.join(scratch, "schema.prisma"));
execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", path.join(scratch, "schema.prisma"), "--skip-generate"], {
  cwd: scratch, env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "info" }, stdio: "pipe"
});
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });

async function main() {
  const core = await import("@/lib/project-foundation");
  const stateApi = await import("@/lib/foundation-state");
  const contracts = await import("@/lib/project-foundation-contracts");
  const { preprocessProject } = await import("@/lib/project-preprocess");
  type Stage = "F1" | "F2" | "Q1";
  const compatibleProtocol = "F2_BATCH_V3:d3a940ff21737ff3d7ffd4b9de094df7d90c7b08bbf7e1d470e2d4768513a51d";
  const source = [1, 2, 3].map((number) => ({ number, title: `第${number}集`, content: `${number}-1\n甲在此；史书记载古城。\n${"源".repeat(24_001)}` }));
  const ref = (episode: number) => ({ episode, startLine: 2, endLine: 2 });
  const parse = (prompt: string) => JSON.parse(prompt.slice(prompt.lastIndexOf("INPUT_JSON:\n") + "INPUT_JSON:\n".length));
  function output(stage: Stage, scope: number[], verdict = "REPAIR", unused = false): Record<string, unknown> {
    if (stage === "F1") return { coverage: scope, overview: "合成分片理解", episodes: scope.map((number) => ({ number, summary: `第${number}集理解`, context: `F1-${number}`, sourceSelections: [{ ...ref(number), purpose: "本集主体与背景" }] })), issues: [] };
    if (stage === "F2") return { coverage: scope, assets: [
      { key: "person-jia", name: "甲", type: "CH", description: "合成主体", sourceRefs: scope.map(ref) },
      ...(unused ? [{ key: "old-city", name: "古城", type: "LOC", description: "史书记载的古城身份；不声明本集出场。", sourceRefs: [ref(scope[0])] }] : [])
    ], episodes: scope.map((number) => ({ number, context: `F2-${number}`, uses: [{ key: "person-jia", presence: "ONSTAGE", state: "甲在此。", sourceRefs: [ref(number)] }] })), issues: [] };
    return { coverage: scope, verdict, summary: "合成独立复核", issues: verdict === "READY" ? [] : [{ severity: verdict === "BLOCKED" ? "BLOCKER" : "MAJOR", owner: "F2", coordinate: "assets.person-jia", problem: "仍需专业复核", sourceRefs: [ref(scope[0])] }] };
  }
  const runner: FoundationStageRunner = async (stage, prompt) => {
    const input = parse(prompt);
    const known = [...(input.registry ?? []), ...(input.previousAssetKeys ?? [])].find((asset: { name: string }) => asset.name === "甲");
    const data = input.workflow === "PRODUCTION_FOUNDATION_V3" && stage === "F2" ? { format: "ASSET_CATALOG_V2", coverage: input.scope, assets: [{ ...(known ? { key: known.key } : {}), name: "甲", type: "CH", episodes: input.scope, preparation: { mode: "REFERENCE" } }] }
      : input.workflow === "PRODUCTION_FOUNDATION_V3" && stage === "Q1" ? { format: "FOUNDATION_OPTIMIZATION_V2", coverage: input.scope, changes: {} }
        : output(stage, input.scope);
    return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic evidence", stderr: "" };
  };
  async function project() {
    const p = await db.project.create({ data: { title: "__synthetic_continuation__", style: "3D漫剧", executionMode: "API", episodes: { create: source } }, include: { episodes: true } });
    await preprocessProject(p.id, db); return p;
  }
  async function queue(projectId: string, stages: Stage[], recovery?: { resumeFromRunId: string; replayOnly?: boolean }) {
    const batchToken = randomUUID();
    const input = await stateApi.loadFoundationInputs(projectId, db);
    for (const stageCode of stages) await db.pipelineRun.create({ data: { projectId, stageCode, roleName: stageCode, provider: "API", status: "QUEUED",
      inputSummary: JSON.stringify({ batchToken, provider: "API", foundation: true, sourceVersion: input.sourceVersion, inputVersion: input.inputVersion, methodVersion: input.methodVersions[stageCode], ...(recovery && stageCode === "F2" ? { recovery } : {}) }) } });
    return batchToken;
  }
  const execute = (id: string, token: string, stageRunner = runner, singleStage?: Stage) => core.executeProjectFoundation(id, token, { db, stageRunner, singleStage });
  async function failedPrefix(protocol = contracts.F2_PROTOCOL_VERSION, unused = false, checkpoint = false) {
    const p = await project(); await execute(p.id, await queue(p.id, ["F1"]), runner, "F1");
    const token = await queue(p.id, ["F2"]);
    await assert.rejects(() => execute(p.id, token, async (stage, prompt, call) => {
      if (checkpoint && call.chunkIndex === 2) throw Object.assign(new Error("synthetic provider interruption"), { requestOutcome: "NOT_SENT", rawOutput: "local pre-request diagnostic" });
      if (!checkpoint) await db.pipelineRun.update({ where: { id: call.runId }, data: { status: "FAILED", error: "synthetic former validator rejection" } });
      const data = output(stage, parse(prompt).scope, "REPAIR", unused && call.chunkIndex === 1);
      return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic saved output", stderr: "" };
    }, "F2"));
    const failed = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "F2" } });
    if (protocol !== contracts.F2_PROTOCOL_VERSION) {
      const log = JSON.parse(failed.log!); const summary = JSON.parse(failed.inputSummary!);
      const oldRules = contracts.F2_PROTOCOL_RULES.replace(
        "新key仍须完整name/type/description/非空且有效sourceRefs；本批没有任何uses的有源后台定义仍完整保留，不为通过校验编造使用，程序不派生其assetKeys/appearances或放入消费者包；",
        "新key仍须完整name/type/description/非空sourceRefs，并在uses至少有一条有效状态或明确BACKGROUND使用；"
      );
      assert.equal(`F2_BATCH_V3:${contracts.hashFoundationPrompt(JSON.stringify({ rules: oldRules, schema: contracts.FOUNDATION_OUTPUT_SCHEMAS.F2 }))}`, compatibleProtocol, "测试确切还原已审查旧运输规则");
      log.protocolVersion = protocol; summary.protocolVersion = protocol;
      for (const call of log.calls) {
        call.taskPrompt = call.taskPrompt.replace(`F2_PROTOCOL_VERSION: ${contracts.F2_PROTOCOL_VERSION}\n${contracts.F2_PROTOCOL_RULES}`, `F2_PROTOCOL_VERSION: ${protocol}\n${oldRules}`);
        call.protocolVersion = protocol;
        if (call.checkpoint) call.checkpoint.protocolVersion = protocol;
      }
      await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(log), inputSummary: JSON.stringify(summary) } });
    }
    return { p, failed: await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }) };
  }
  let checks = 0;
  async function check(name: string, run: () => Promise<void>) {
    if (process.argv[2] && !name.includes(process.argv[2])) return;
    await run(); checks++; console.log(`PASS ${name}`);
  }

  await check("saved complete prefix needs no historical success checkpoint", async () => {
    const p = await project(); await execute(p.id, await queue(p.id, ["F1"]), runner, "F1");
    const token = await queue(p.id, ["F2"]);
    await assert.rejects(() => execute(p.id, token, async (stage, prompt, call) => {
      await db.pipelineRun.update({ where: { id: call.runId }, data: { status: "FAILED", error: "synthetic former validator rejection" } });
      return runner(stage, prompt, call);
    }, "F2"));
    const before = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "F2" } });
    assert.equal(JSON.parse(before.log!).calls[0].checkpoint, undefined);
    const preview = (await stateApi.getFoundationState(p.id, db)).f2Recovery;
    assert.equal(preview?.resumeRunId, before.id, "完整首片须先重新校验，不得因旧FAILED/无checkpoint跳过");
    assert.equal(preview?.resumeChunkCount, 1); assert.equal(preview?.replayRunId, null);
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: before.id } }), before, "只读预览不得改旧证据");
  });
  await check("REPAIR and BLOCKED are complete drafts without approval", async () => {
    for (const verdict of ["REPAIR", "BLOCKED"]) {
      const p = await project();
      await execute(p.id, await queue(p.id, ["F1", "F2", "Q1"]), async (stage, prompt, call) => {
        if (stage !== "Q1") return runner(stage, prompt, call);
        const data = output(stage, parse(prompt).scope, verdict);
        return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "", stderr: "" };
      });
      const state = await stateApi.getFoundationState(p.id, db);
      assert.equal(state.draftComplete, true); assert.equal(state.ready, false); assert.equal(state.reviewReady, false);
    }
  });
  await check("continuation queues only the required author and review suffix", async () => {
    for (const prefix of [[], ["F1"], ["F1", "F2"], ["F1", "F2", "Q1"]] as Stage[][]) {
      const p = await project(); for (const stage of prefix) await execute(p.id, await queue(p.id, [stage]), runner, stage);
      const before = await db.pipelineRun.findMany({ where: { projectId: p.id }, orderBy: { createdAt: "asc" } });
      const seen: string[] = [];
      await core.queueProjectFoundationContinuation(p.id, { db, stageRunner: async (stage, prompt, call) => { seen.push(`${stage}:${call.chunkIndex}`); return runner(stage, prompt, call); } });
      const expected = (["F1", "F2", "Q1"] as Stage[]).slice(prefix.length).flatMap((stage) => [1, 2, 3].map((chunk) => `${stage}:${chunk}`));
      assert.deepEqual(seen, expected);
      assert.equal((await stateApi.getFoundationState(p.id, db)).draftComplete, true);
      for (const run of before) assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: run.id } }), run, "已完成上游不得改写");
      assert.equal(await db.pipelineRun.count({ where: { projectId: p.id } }), before.length + 3 - prefix.length);
    }
  });
  await check("compatible paid first response resumes the remaining F2 and Q1 without rewriting F1 or origin", async () => {
    for (const [protocol, checkpoint] of [[contracts.F2_PROTOCOL_VERSION, false], [contracts.F2_PROTOCOL_VERSION, true], [compatibleProtocol, false]] as const) {
      const { p, failed } = await failedPrefix(protocol, protocol === compatibleProtocol, checkpoint);
      const f1Before = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "F1" } });
      const f1Snapshot = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: p.id, sceneKey: "FOUNDATION_F1" } });
      const preview = (await stateApi.getFoundationState(p.id, db)).f2Recovery;
      assert.equal(preview?.resumeRunId, failed.id); assert.equal(preview?.resumeChunkCount, 1); assert.equal(preview?.totalChunks, 3); assert.equal(preview?.replayRunId, null);
      const seen: string[] = [];
      await core.queueProjectFoundationContinuation(p.id, { db, stageRunner: async (stage, prompt, call) => { seen.push(`${stage}:${call.chunkIndex}`); return runner(stage, prompt, call); } });
      assert.deepEqual(seen, ["F2:2", "F2:3", "Q1:1", "Q1:2", "Q1:3"]);
      const state = await stateApi.getFoundationState(p.id, db); assert.equal(state.draftComplete, true); assert.equal(state.ready, false);
      const continued = await db.pipelineRun.findUniqueOrThrow({ where: { id: state.candidates.f2!.runId } });
      const evidence = JSON.parse(continued.log!); const originalCall = JSON.parse(failed.log!).calls[0]; const reused = evidence.calls[0];
      assert.equal(reused.providerCallCount, 0); assert.deepEqual(reused.reusedFrom, { runId: failed.id, sequence: 1 });
      for (const field of ["response", "taskPrompt", "systemPrompt", "input", "startedAt", "finishedAt", "protocolVersion"]) assert.deepEqual(reused[field], originalCall[field], field);
      assert.equal(reused.revalidatedUnder.protocolVersion, contracts.F2_PROTOCOL_VERSION); assert.equal(JSON.parse(continued.inputSummary!).providerCalls, 2);
      const q1 = await db.pipelineRun.findUniqueOrThrow({ where: { id: state.review!.runId } }); assert.equal(JSON.parse(q1.inputSummary!).recovery, undefined);
      if (protocol === compatibleProtocol) {
        const background = state.candidates.f2!.output.assets.find((asset) => asset.key === "old-city")!;
        assert.ok(background); assert.deepEqual(background.appearances, []);
        assert.ok(state.candidates.f2!.output.episodes.every((episode) => !episode.assetKeys.includes("old-city")));
      }
      assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed);
      assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: f1Before.id } }), f1Before);
      assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({ where: { id: f1Snapshot.id } }), f1Snapshot);
    }
  });
  await check("a second failed continuation verifies its direct origin and complete witness", async () => {
    const { p, failed } = await failedPrefix(compatibleProtocol, true);
    await assert.rejects(() => core.queueProjectFoundationContinuation(p.id, { db, stageRunner: async (stage, prompt, call) => {
      if (stage === "F2" && call.chunkIndex === 3) throw Object.assign(new Error("synthetic second interruption"), { requestOutcome: "NOT_SENT", rawOutput: "local pre-request third-fragment diagnostic" });
      return runner(stage, prompt, call);
    } }), /second interruption/);
    const retrySource = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "F2" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    assert.equal((await stateApi.getFoundationState(p.id, db)).f2Recovery?.resumeChunkCount, 2);
    const seen: string[] = [];
    await core.queueProjectFoundationContinuation(p.id, { db, stageRunner: async (stage, prompt, call) => { seen.push(`${stage}:${call.chunkIndex}`); return runner(stage, prompt, call); } });
    assert.deepEqual(seen, ["F2:3", "Q1:1", "Q1:2", "Q1:3"]);
    const state = await stateApi.getFoundationState(p.id, db); const final = await db.pipelineRun.findUniqueOrThrow({ where: { id: state.candidates.f2!.runId } });
    assert.deepEqual(JSON.parse(final.log!).calls[0].reusedFrom, { runId: retrySource.id, sequence: 1 });
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: retrySource.id } }), retrySource);
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed);
  });
  await check("reuse stops at the first invalid saved fragment and keeps the earlier verified prefix", async () => {
    const p = await project(); await execute(p.id, await queue(p.id, ["F1"]), runner, "F1");
    const token = await queue(p.id, ["F2"]);
    await assert.rejects(() => execute(p.id, token, async (stage, prompt, call) => {
      const result = await runner(stage, prompt, call);
      if (call.chunkIndex === 2) {
        const data = JSON.parse(JSON.stringify(result.data)); data.episodes[0].uses[0].state = "";
        return { ...result, data, rawOutput: JSON.stringify(data) };
      }
      return result;
    }, "F2"));
    const failed = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "F2" } });
    const preview = (await stateApi.getFoundationState(p.id, db)).f2Recovery;
    assert.equal(preview?.resumeChunkCount, 1, "后片不合法不能冒称可复用，也不能丢掉合法连续首片");
    assert.equal(preview?.replayRunId, null);
    const seen: string[] = [];
    await core.queueProjectFoundationContinuation(p.id, { db, stageRunner: async (stage, prompt, call) => { seen.push(`${stage}:${call.chunkIndex}`); return runner(stage, prompt, call); } });
    assert.deepEqual(seen, ["F2:2", "F2:3", "Q1:1", "Q1:2", "Q1:3"]);
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed);
  });
  await check("partial resume cannot repair a declared uses author wire by accepting legacy arrays", async () => {
    for (const badChunk of [1, 2]) {
      const p = await project(); await execute(p.id, await queue(p.id, ["F1"]), runner, "F1");
      const input = await stateApi.loadFoundationInputs(p.id, db); const token = await queue(p.id, ["F2"]);
      await assert.rejects(() => execute(p.id, token, async (stage, prompt, call) => {
        const result = await runner(stage, prompt, call);
        if (call.chunkIndex !== badChunk) return result;
        const data = contracts.requireF2Output(result.data, input.sourceIndex, call.scope);
        assert.ok(Array.isArray(data.episodes[0].assetKeys)); assert.ok(Array.isArray(data.assets[0].appearances));
        return { ...result, data, rawOutput: JSON.stringify(data) };
      }, "F2"), /uses|运输协议/);
      const failed = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "F2" } });
      const preview = (await stateApi.getFoundationState(p.id, db)).f2Recovery;
      assert.equal(preview?.resumeChunkCount ?? 0, badChunk - 1, "只有符合原声明作者格式的连续首片可以部分续跑");
      assert.equal(preview?.replayRunId ?? null, null);
      const seen: string[] = [];
      if (badChunk === 1) {
        const resumeToken = await queue(p.id, ["F2"], { resumeFromRunId: failed.id });
        await assert.rejects(() => execute(p.id, resumeToken, async (stage, prompt, call) => { seen.push(`${stage}:${call.chunkIndex}`); return runner(stage, prompt, call); }, "F2"), /uses|运输协议/);
        assert.deepEqual(seen, []);
      } else {
        await core.queueProjectFoundationContinuation(p.id, { db, stageRunner: async (stage, prompt, call) => { seen.push(`${stage}:${call.chunkIndex}`); return runner(stage, prompt, call); } });
        assert.deepEqual(seen, ["F2:2", "F2:3", "Q1:1", "Q1:2", "Q1:3"]);
      }
      assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed);
    }
  });
  await check("even a complete current-wire replay cannot use the legacy parser escape hatch", async () => {
    const p = await project(); await execute(p.id, await queue(p.id, ["F1"]), runner, "F1");
    await execute(p.id, await queue(p.id, ["F2"]), runner, "F2");
    const input = await stateApi.loadFoundationInputs(p.id, db); const latest = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "F2" } });
    const log = JSON.parse(latest.log!);
    // Explicit synthetic old-record fault: keep current protocol/input evidence but replace the author payload with legacy arrays.
    for (const call of log.calls) { call.response.data = contracts.requireF2Output(call.response.data, input.sourceIndex, call.scope); call.response.rawOutput = JSON.stringify(call.response.data); }
    await db.pipelineRun.update({ where: { id: latest.id }, data: { status: "FAILED", error: "synthetic malformed current-wire record", log: JSON.stringify(log) } });
    assert.equal((await stateApi.getFoundationState(p.id, db)).f2Recovery, null);
    const token = await queue(p.id, ["F2"], { resumeFromRunId: latest.id, replayOnly: true }); let calls = 0;
    await assert.rejects(() => execute(p.id, token, async (...args) => { calls++; return runner(...args); }, "F2"), /uses|运输协议/);
    assert.equal(calls, 0);
  });
  await check("missing witness and changed directly referenced raw evidence close reuse", async () => {
    for (const mutation of ["witness", "origin-response"] as const) {
      const { p, failed } = await failedPrefix(compatibleProtocol, true);
      await assert.rejects(() => core.queueProjectFoundationContinuation(p.id, { db, stageRunner: async (stage, prompt, call) => {
        if (stage === "F2" && call.chunkIndex === 2) throw Object.assign(new Error("synthetic interruption"), { requestOutcome: "NOT_SENT" });
        return runner(stage, prompt, call);
      } }));
      const retry = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "F2" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      const target = mutation === "witness" ? retry : failed; const log = JSON.parse(target.log!);
      if (mutation === "witness") delete log.calls[0].revalidatedUnder.finishedAt;
      else log.calls[0].response.rawOutput += " changed direct original text";
      await db.pipelineRun.update({ where: { id: target.id }, data: { log: JSON.stringify(log) } });
      assert.equal((await stateApi.getFoundationState(p.id, db)).f2Recovery, null, mutation);
      const token = await queue(p.id, ["F2"], { resumeFromRunId: retry.id }); let calls = 0;
      await assert.rejects(() => execute(p.id, token, async (...args) => { calls++; return runner(...args); }, "F2"), /复验|来源|证据|复用/);
      assert.equal(calls, 0);
    }
  });
  await check("partial recovery rejects unapproved protocols, empty raw, invalid data and changed bindings", async () => {
    for (const mutation of ["protocol", "call-protocol", "summary-protocol", "free-without-witness", "raw", "data", "no-data", "task", "input", "scope", "timing", "model", "reasoning", "system", "provider"] as const) {
      const { p, failed } = await failedPrefix(mutation === "protocol" ? "F2_UNAPPROVED_LEGACY" : compatibleProtocol, true);
      const log = JSON.parse(failed.log!); const summary = JSON.parse(failed.inputSummary!); const call = log.calls[0];
      if (mutation === "call-protocol") { call.protocolVersion = contracts.F2_PROTOCOL_VERSION; call.taskPrompt = contracts.buildFoundationPrompt("F2", call.input); }
      if (mutation === "summary-protocol") summary.protocolVersion = contracts.F2_PROTOCOL_VERSION;
      if (mutation === "free-without-witness") call.providerCallCount = 0;
      if (mutation === "raw") call.response.rawOutput = "  ";
      if (mutation === "data") call.response.data.episodes[0].uses[0].sourceRefs[0].startLine = 0;
      if (mutation === "no-data") delete call.response.data;
      if (mutation === "task") call.taskPrompt = call.taskPrompt.replace("OUTPUT_SCHEMA", "接受另一条未授权任务。\nOUTPUT_SCHEMA");
      if (mutation === "input") call.input.project.title = "changed actual task input";
      if (mutation === "scope") call.scope = [2];
      if (mutation === "timing") call.finishedAt = "not-a-time";
      if (mutation === "model") call.model = "another-model";
      if (mutation === "reasoning") call.reasoningEffort = "another-effort";
      if (mutation === "system") call.systemPrompt += "changed system";
      if (mutation === "provider") call.provider = "CLI";
      await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(log), inputSummary: JSON.stringify(summary) } });
      const before = await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } });
      assert.equal((await stateApi.getFoundationState(p.id, db)).f2Recovery, null, mutation);
      const token = await queue(p.id, ["F2"], { resumeFromRunId: failed.id }); let calls = 0;
      await assert.rejects(() => execute(p.id, token, async (...args) => { calls++; return runner(...args); }, "F2"), mutation);
      assert.equal(calls, 0, mutation);
      assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), before, mutation);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "FOUNDATION_F2" } }), 0);
    }
  });
  await check("changed source or F1 and foreign recovery cannot call a provider", async () => {
    for (const mutation of ["source", "F1", "foreign"] as const) {
      const { p, failed } = await failedPrefix(compatibleProtocol, true);
      let target = p;
      if (mutation === "source") {
        await db.episode.update({ where: { id: p.episodes[0].id }, data: { content: source[0].content + "新原文" } });
        await preprocessProject(p.id, db);
      }
      if (mutation === "foreign") target = await project();
      await execute(target.id, await queue(target.id, ["F1"]), runner, "F1");
      assert.equal((await stateApi.getFoundationState(target.id, db)).f2Recovery, null);
      const token = await queue(target.id, ["F2"], { resumeFromRunId: failed.id }); let calls = 0;
      await assert.rejects(() => execute(target.id, token, async (...args) => { calls++; return runner(...args); }, "F2"));
      assert.equal(calls, 0);
      assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed);
    }
  });
  await check("concurrent execution and invalid source cannot silently start a full replacement", async () => {
    const { p, failed } = await failedPrefix();
    const competing = await queue(p.id, ["F2"]); const before = await db.pipelineRun.count({ where: { projectId: p.id } }); let calls = 0;
    await assert.rejects(() => core.queueProjectFoundationContinuation(p.id, { db, stageRunner: async (...args) => { calls++; return runner(...args); } }), /正在执行/);
    assert.equal(calls, 0); assert.equal(await db.pipelineRun.count({ where: { projectId: p.id } }), before);
    await db.pipelineRun.updateMany({ where: { projectId: p.id, inputSummary: { contains: competing } }, data: { status: "CANCELED" } });
    assert.equal((await stateApi.getFoundationState(p.id, db)).f2Recovery, null, "最新空取消记录不能回退到更早失败来源");
    const empty = await db.project.create({ data: { title: "__empty_continuation__", executionMode: "API" } });
    assert.equal((await stateApi.getFoundationState(empty.id, db)).draftComplete, false);
    await assert.rejects(() => core.queueProjectFoundationContinuation(empty.id, { db, stageRunner: runner }));
    assert.equal(await db.pipelineRun.count({ where: { projectId: empty.id } }), 0);
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed);
  });
  await check("an old page cannot expand continuation after source F1 or latest failed prefix changed", async () => {
    for (const mutation of ["source", "F1", "latest-prefix"] as const) {
      const { p, failed } = await failedPrefix(compatibleProtocol, true);
      const expectedState = core.foundationContinuationStamp(await stateApi.getFoundationState(p.id, db));
      if (mutation === "source") {
        await db.episode.update({ where: { id: p.episodes[0].id }, data: { content: source[0].content + " source changed since page" } });
        await preprocessProject(p.id, db);
      } else if (mutation === "F1") await execute(p.id, await queue(p.id, ["F1"]), runner, "F1");
      else await db.pipelineRun.create({ data: { projectId: p.id, stageCode: "F2", roleName: "F2", provider: "API", status: "FAILED", error: "synthetic newer failure without a saved prefix" } });
      const before = await db.pipelineRun.count({ where: { projectId: p.id } }); let calls = 0;
      await assert.rejects(() => core.queueProjectFoundationContinuation(p.id, { db, stageRunner: async (...args) => { calls++; return runner(...args); } }, expectedState), (error: Error) => {
        assert.match(error.message, /已变化|刷新|过期/); assert.equal(error.name, "FoundationContinuationStateChangedError");
        assert.ok(error instanceof core.FoundationContinuationStateChangedError); return true;
      });
      assert.equal(calls, 0, mutation); assert.equal(await db.pipelineRun.count({ where: { projectId: p.id } }), before, mutation);
      assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed);
    }
  });
  await check("busy or removed source continuation is a typed state change but unknown DB failures are not swallowed", async () => {
    for (const mutation of ["busy", "removed-source", "unknown-db"] as const) {
      const { p } = await failedPrefix(); const expectedState = core.foundationContinuationStamp(await stateApi.getFoundationState(p.id, db));
      if (mutation === "busy") await queue(p.id, ["F2"]);
      if (mutation === "removed-source") await db.episode.deleteMany({ where: { projectId: p.id } });
      const unknown = new Error("synthetic unknown transaction failure");
      const failingDb = mutation === "unknown-db" ? new Proxy(db, { get(target, property, receiver) {
        if (property === "$transaction") return async () => { throw unknown; };
        return Reflect.get(target, property, receiver);
      } }) : db;
      const before = await db.pipelineRun.count({ where: { projectId: p.id } }); let calls = 0;
      await assert.rejects(() => core.queueProjectFoundationContinuation(p.id, { db: failingDb, stageRunner: async (...args) => { calls++; return runner(...args); } }, expectedState), (error: Error) => {
        if (mutation === "unknown-db") { assert.equal(error, unknown); assert.ok(!(error instanceof core.FoundationContinuationStateChangedError)); }
        else { assert.equal(error.name, "FoundationContinuationStateChangedError"); assert.ok(error instanceof core.FoundationContinuationStateChangedError); }
        return true;
      });
      assert.equal(calls, 0); assert.equal(await db.pipelineRun.count({ where: { projectId: p.id } }), before);
    }
  });
  await check("matching page intent continues while missing intent refuses and a completed draft stays no-op", async () => {
    const { p } = await failedPrefix(); const state = await stateApi.getFoundationState(p.id, db); let calls = 0;
    const before = await db.pipelineRun.count({ where: { projectId: p.id } });
    await assert.rejects(() => core.queueProjectFoundationContinuation(p.id, { db, stageRunner: runner }, ""), /已变化|刷新|过期/);
    assert.equal(await db.pipelineRun.count({ where: { projectId: p.id } }), before);
    await core.queueProjectFoundationContinuation(p.id, { db, stageRunner: async (...args) => { calls++; return runner(...args); } }, core.foundationContinuationStamp(state));
    assert.equal(calls, 5);
    const completeCount = await db.pipelineRun.count({ where: { projectId: p.id } }); calls = 0;
    await core.queueProjectFoundationContinuation(p.id, { db, stageRunner: async (...args) => { calls++; return runner(...args); } }, core.foundationContinuationStamp(state));
    assert.equal(calls, 0); assert.equal(await db.pipelineRun.count({ where: { projectId: p.id } }), completeCount);
  });
  await check("duplicate stages cannot impersonate a complete continuation suffix", async () => {
    for (const duplicated of ["F2", "Q1"] as const) {
      const p = await project(); await execute(p.id, await queue(p.id, ["F1"]), runner, "F1");
      const input = await stateApi.loadFoundationInputs(p.id, db); const batchToken = randomUUID();
      for (let count = 0; count < 2; count++) await db.pipelineRun.create({ data: { projectId: p.id, stageCode: duplicated, roleName: duplicated, provider: "API", status: "QUEUED",
        inputSummary: JSON.stringify({ batchToken, provider: "API", foundation: true, continuation: true, continuationStages: ["F2", "Q1"],
          sourceVersion: input.sourceVersion, inputVersion: input.inputVersion, protocolVersion: contracts.F2_PROTOCOL_VERSION }) } });
      let calls = 0;
      await assert.rejects(() => execute(p.id, batchToken, async (...args) => { calls++; return runner(...args); }), /完整且一致的必要后缀/);
      assert.equal(calls, 0);
      const runs = await db.pipelineRun.findMany({ where: { projectId: p.id, inputSummary: { contains: batchToken } } });
      assert.ok(runs.every((run) => run.status === "CANCELED"), "不完整批次全部关闭，不能开始一岗后才发现另一岗缺失");
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: { in: ["FOUNDATION_F2", "FOUNDATION_Q1"] } } }), 0);
    }
  });
  await check("queue transaction rechecks source F1 and provider before creating any suffix run", async () => {
    for (const mutation of ["source", "F1", "provider"] as const) {
      const { p, failed } = await failedPrefix(); let changed = false; let calls = 0;
      const changingDb = new Proxy(db, { get(target, property, receiver) {
        if (property === "$transaction") return async (...args: Parameters<PrismaClient["$transaction"]>) => {
          if (!changed) {
            changed = true;
            if (mutation === "source") {
              await db.episode.update({ where: { id: p.episodes[0].id }, data: { content: source[0].content + " changed before queue" } });
              await preprocessProject(p.id, db);
            } else if (mutation === "F1") await execute(p.id, await queue(p.id, ["F1"]), runner, "F1");
            else await db.project.update({ where: { id: p.id }, data: { executionMode: "CLI" } });
          }
          return target.$transaction(...args);
        };
        return Reflect.get(target, property, receiver);
      } });
      await assert.rejects(() => core.queueProjectFoundationContinuation(p.id, { db: changingDb, stageRunner: async (...args) => { calls++; return runner(...args); } }), /变化|拒绝|版本/);
      assert.equal(changed, true); assert.equal(calls, 0);
      assert.equal(await db.pipelineRun.count({ where: { projectId: p.id, stageCode: "F2" } }), 1);
      assert.equal(await db.pipelineRun.count({ where: { projectId: p.id, stageCode: "Q1" } }), 0);
      assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed);
    }
  });
  await check("stop after persisting next call input prevents the provider invocation", async () => {
    const { p, failed } = await failedPrefix(); let stopped = false; let calls = 0;
    const stoppingDb = new Proxy(db, { get(target, property, receiver) {
      if (property === "pipelineRun") return new Proxy(target.pipelineRun, { get(delegate, key, innerReceiver) {
        if (key === "update") return async (args: Parameters<typeof delegate.update>[0]) => {
          const saved = await delegate.update(args);
          if (!stopped && typeof args.data.log === "string") {
            const log = JSON.parse(args.data.log); const call = log.calls?.at(-1);
            if (log.stageCode === "F2" && call?.sequence === 2 && call.status === "RUNNING" && !call.response && !call.reusedFrom) {
              stopped = true;
              await db.pipelineRun.updateMany({ where: { projectId: p.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELED", finishedAt: new Date(), error: "synthetic stop before provider" } });
            }
          }
          return saved;
        };
        return Reflect.get(delegate, key, innerReceiver);
      } });
      return Reflect.get(target, property, receiver);
    } });
    await assert.rejects(() => core.queueProjectFoundationContinuation(p.id, { db: stoppingDb, stageRunner: async (...args) => { calls++; return runner(...args); } }), /停止|RUNNING/);
    assert.equal(stopped, true); assert.equal(calls, 0);
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: { in: ["FOUNDATION_F2", "FOUNDATION_Q1"] } } }), 0);
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed);
  });
  await check("stop during the remaining call preserves cancellation and never starts Q1", async () => {
    const { p, failed } = await failedPrefix(compatibleProtocol, true); const seen: string[] = [];
    await assert.rejects(() => core.queueProjectFoundationContinuation(p.id, { db, stageRunner: async (stage, prompt, call) => {
      seen.push(`${stage}:${call.chunkIndex}`);
      await db.pipelineRun.updateMany({ where: { projectId: p.id, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "CANCELED", finishedAt: new Date(), error: "synthetic user stop" } });
      return runner(stage, prompt, call);
    } }), /停止|RUNNING/);
    assert.deepEqual(seen, ["F2:2"]);
    const latest = await db.pipelineRun.findFirstOrThrow({ where: { projectId: p.id, stageCode: "F2" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    assert.equal(latest.status, "CANCELED"); assert.equal(latest.error, "synthetic user stop");
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: { in: ["FOUNDATION_F2", "FOUNDATION_Q1", "FOUNDATION_APPROVED"] } } }), 0);
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed);
  });
  console.log(`foundation-continuation ${checks} checks passed`);
}

void main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await db.$disconnect();
  const { prisma } = await import("@/lib/prisma"); await prisma.$disconnect();
  rmSync(scratch, { recursive: true, force: true });
});
