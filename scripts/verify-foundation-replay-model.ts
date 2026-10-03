import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FoundationStageRunner } from "@/lib/project-foundation";

const scratch = mkdtempSync(path.join(tmpdir(), "foundation-replay-model-"));
const url = `file:${path.join(scratch, "test.db")}`;
process.env.DATABASE_URL = url;
copyFileSync(path.resolve("prisma/schema.prisma"), path.join(scratch, "schema.prisma"));
execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", path.join(scratch, "schema.prisma"), "--skip-generate"], { cwd: scratch, env: { ...process.env, DATABASE_URL: url, RUST_LOG: "info" }, stdio: "pipe" });
const db = new PrismaClient({ datasources: { db: { url } } });
type Stage = "F1" | "F2" | "Q1";
type Row = Record<string, any>;

function observedDatabase(queued: Row[], failPublication?: Stage): PrismaClient {
  return new Proxy(db, { get(target, key) {
    if (key !== "$transaction") return Reflect.get(target, key);
    return (action: (tx: unknown) => Promise<unknown>) => target.$transaction(async tx => action(new Proxy(tx, { get(client, delegate) {
      if (delegate === "pipelineRun") return new Proxy(client.pipelineRun, { get(runs, method) {
        if (method === "create") return async (args: Row) => { queued.push(structuredClone(args.data)); return runs.create(args as never); };
        return Reflect.get(runs, method);
      } });
      if (delegate === "sceneSnapshot" && failPublication) return new Proxy(client.sceneSnapshot, { get(snapshots, method) {
        if (method === "create") return async (args: Row) => {
          if (args.data.sceneKey === `FOUNDATION_${failPublication}`) throw new Error("synthetic publication interruption after complete response");
          return snapshots.create(args as never);
        };
        return Reflect.get(snapshots, method);
      } });
      return Reflect.get(client, delegate);
    } })) as never);
  } });
}

async function checkStage(stage: Stage) {
  const runtime = await import("@/lib/project-foundation");
  const { preprocessProject } = await import("@/lib/project-preprocess");
  const { getFoundationState, loadFoundationInputs } = await import("@/lib/foundation-state");
  const project = await db.project.create({ data: { title: `__legacy_model_replay_${stage}__`, executionMode: "CLI", episodes: { create: [0, 1, 2].map(number => ({ number, title: `第${number}集`, content: `${number}-1 礼堂 日 内\n李晴交接钥匙。\n${"原文".repeat(6500)}` })) } } });
  await preprocessProject(project.id, db);
  const sent: Row[] = [], queued: Row[] = [];
  const runner: FoundationStageRunner = async (code, prompt, context) => {
    const input = JSON.parse(prompt.split("INPUT_JSON:\n").at(-1)!);
    const n = input.scope[0]; sent.push({ code, model: context.role.model, reasoning: context.role.reasoningEffort });
    const known = input.registry?.find((asset: Row) => asset.name === "李晴") ?? input.previousAssetKeys?.find((asset: Row) => asset.name === "李晴");
    const data = code === "F1" ? { coverage: input.scope, overview: `第${n}片概述`, episodes: [{ number: n, summary: `第${n}集导航` }] }
      : code === "F2" ? { format: "ASSET_CATALOG_V2", coverage: input.scope, assets: [{ ...(known ? { key: known.key } : {}), name: "李晴", type: "CH", episodes: [n], preparation: { mode: "REFERENCE" } }] }
      : { format: "FOUNDATION_OPTIMIZATION_V2", coverage: input.scope, changes: {} };
    return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic", stderr: "" };
  };
  await assert.rejects(runtime.queueProjectFoundationContinuation(project.id, { db: observedDatabase(queued, stage), stageRunner: runner }), /synthetic publication interruption/);
  assert.ok(sent.length > 0); assert.ok(sent.every(call => call.model === "gpt-6.1-sol" && call.reasoning === "medium"), "fresh requests use the current model policy");
  assert.ok(queued.every(run => run.model === "gpt-6.1-sol"));
  const failed = await db.pipelineRun.findFirstOrThrow({ where: { projectId: project.id, stageCode: stage, status: "FAILED" } });
  const oldLog: Row = JSON.parse(failed.log!);
  assert.equal(oldLog.calls.length, 3); assert.ok(oldLog.calls.every((call: Row) => call.status === "SUCCEEDED" && call.response?.data));
  for (const call of oldLog.calls) { call.model = "gpt-5.6-terra"; call.reasoningEffort = "high"; }
  const saved = await db.pipelineRun.update({ where: { id: failed.id }, data: { model: "gpt-5.6-terra", log: JSON.stringify(oldLog) } });
  const beforeCalls = sent.length;
  const never: FoundationStageRunner = async () => { sent.push({ unexpected: true }); throw new Error("free replay called a provider"); };
  const replay = () => runtime.queueSingleFoundationStage(project.id, stage, { resumeFromRunId: saved.id, replayOnly: true }, { db, stageRunner: never });
  const tampers: Array<[string, (row: Row) => void]> = [
    ["run model mismatch", row => { row.model = "gpt-6.1-sol"; }],
    ["call model mismatch", row => { row.log.calls[1].model = "gpt-6.1-sol"; }],
    ["call reasoning mismatch", row => { row.log.calls[1].reasoningEffort = "medium"; }],
    ["missing run model", row => { row.model = null; }],
    ["missing call model", row => { delete row.log.calls[1].model; }],
    ["missing reasoning", row => { for (const call of row.log.calls) delete call.reasoningEffort; }],
    ["missing fragment", row => { row.log.calls.pop(); }],
    ["unknown outcome", row => { row.log.calls[1].requestOutcome = "UNKNOWN"; }],
    ["changed source", row => { row.log.sourceVersion = "tampered"; }],
    ["changed rules", row => { row.log.promptHashes[stage] = "tampered"; }],
  ];
  if (stage !== "F1") tampers.push(["changed upstream", row => { row.log.upstreamSnapshotIds.f1 = "tampered"; }]);
  for (const [label, mutate] of tampers) {
    const changed: Row = { model: saved.model, log: JSON.parse(saved.log!) }; mutate(changed);
    const tampered = await db.pipelineRun.update({ where: { id: saved.id }, data: { model: changed.model, log: JSON.stringify(changed.log) } });
    const count = await db.pipelineRun.count({ where: { projectId: project.id } });
    await assert.rejects(replay(), /复用拒绝|分片|复验|未知/, `${stage}: ${label}`);
    assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), count, "reject before creating a new run");
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: saved.id } }), tampered, "rejection never rewrites old evidence");
    await db.pipelineRun.update({ where: { id: saved.id }, data: { model: saved.model, log: saved.log } });
  }
  await assert.rejects(runtime.queueSingleFoundationStage(project.id, stage, { resumeFromRunId: saved.id }, { db, stageRunner: never }), /复用拒绝|模型/, "paid continuation must not reuse an old-model prefix");
  assert.equal(sent.length, beforeCalls);
  const input = await loadFoundationInputs(project.id, db), state = await getFoundationState(project.id, db);
  const upstreams = stage === "F1" ? {} : { f1: state.candidates.f1!, ...(stage === "Q1" ? { f2: state.candidates.f2! } : {}) };
  const rows = await db.pipelineRun.findMany({ where: { projectId: project.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  const preview = (await runtime.previewFoundationRecoveries(project.id, input, upstreams, rows, db))[stage];
  assert.equal(preview?.replayRunId, saved.id, `${stage} complete legacy response must remain available for free replay`);
  assert.equal(preview?.resumeRunId, null);
  queued.length = 0;
  await runtime.queueSingleFoundationStage(project.id, stage, { resumeFromRunId: saved.id, replayOnly: true }, { db: observedDatabase(queued), stageRunner: never });
  assert.equal(sent.length, beforeCalls, "complete replay does not call a provider");
  assert.equal(queued.length, 1); assert.equal(queued[0].model, saved.model, "queued replay must not claim the new model");
  const replayed = await db.pipelineRun.findFirstOrThrow({ where: { projectId: project.id, stageCode: stage, status: "SUCCEEDED" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  assert.equal(replayed.model, saved.model, "executed replay keeps actual historical model attribution");
  const summary = JSON.parse(replayed.inputSummary!), evidence = JSON.parse(replayed.log!);
  assert.equal(summary.providerCalls, 0); assert.equal(summary.reusedCalls, 3);
  for (const [index, call] of evidence.calls.entries()) {
    assert.equal(call.model, "gpt-5.6-terra"); assert.equal(call.reasoningEffort, "high"); assert.equal(call.providerCallCount, 0);
    assert.deepEqual(call.response, oldLog.calls[index].response); assert.deepEqual(call.input, oldLog.calls[index].input);
    assert.equal(call.taskPrompt, oldLog.calls[index].taskPrompt);
  }
  assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: saved.id } }), saved, "all original fields stay byte-identical");
  console.log(`PASS ${stage}: legacy free replay, truthful model attribution, tamper rejection and current-policy fresh dispatch`);
}

async function main() {
  const failures: string[] = [];
  for (const stage of ["F1", "F2", "Q1"] as const) try { await checkStage(stage); }
  catch (error) { failures.push(`${stage}: ${(error as Error).message}`); }
  assert.deepEqual(failures, [], failures.join("\n"));
  console.log("PASS foundation replay-model regression: isolated temporary SQLite and fake providers only");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await db.$disconnect(); const { prisma } = await import("@/lib/prisma"); await prisma.$disconnect(); rmSync(scratch, { recursive: true, force: true });
});
