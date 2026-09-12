import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FoundationStageRunner } from "@/lib/project-foundation";

const scratch = mkdtempSync(path.join(tmpdir(), "foundation-recovery-v3-"));
const url = `file:${path.join(scratch, "test.db")}`;
process.env.DATABASE_URL = url;
copyFileSync(path.resolve("prisma/schema.prisma"), path.join(scratch, "schema.prisma"));
execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", path.join(scratch, "schema.prisma"), "--skip-generate"], { cwd: scratch, env: { ...process.env, DATABASE_URL: url, RUST_LOG: "info" }, stdio: "pipe" });
const db = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  const runtime = await import("@/lib/project-foundation");
  const { preprocessProject } = await import("@/lib/project-preprocess");
  const { getFoundationState, loadFoundationInputs } = await import("@/lib/foundation-state");
  for (const failStage of ["F1", "F2", "Q1"] as const) {
    const project = await db.project.create({ data: { title: `__recovery_${failStage}__`, executionMode: "CLI", episodes: { create: [0, 1, 2].map((number) => ({ number, title: `第${number}集`, content: `${number}-1 礼堂 日 内\n李晴交接钥匙。\n${"原文".repeat(6500)}` })) } } });
    await preprocessProject(project.id, db);
    const calls: string[] = [];
    let fail = true;
    const runner: FoundationStageRunner = async (stage, prompt) => {
      const input = JSON.parse(prompt.split("INPUT_JSON:\n").at(-1)!);
      const n = input.scope[0]; calls.push(`${stage}:${n}`);
      if (stage === failStage && n === 1 && fail) { fail = false; throw Object.assign(new Error("synthetic second fragment failure"), { requestOutcome: "NOT_SENT" as const }); }
      const data = stage === "F1" ? { coverage: input.scope, overview: `第${n}片概述`, episodes: [{ number: n, summary: `第${n}集导航` }] }
        : stage === "F2" ? (() => {
          const known = input.registry.find((asset: { name: string }) => asset.name === "李晴") ?? input.previousAssetKeys?.find((asset: { name: string }) => asset.name === "李晴");
          if (n === 0) assert.equal(known, undefined, "首次创建不得预置假身份或伪造 canonical key");
          else assert.ok(known?.key, "后续分片只能复用 registry 或 previousAssetKeys 明示的 key");
          return { format: "ASSET_CATALOG_V2", coverage: input.scope, assets: [{ ...(known ? { key: known.key } : {}), name: "李晴", type: "CH", episodes: [n], preparation: { mode: "REFERENCE" } }] };
        })()
          : { format: "FOUNDATION_OPTIMIZATION_V2", coverage: input.scope, changes: n === 0 ? { overview: "唯一前片改动", episodes: [{ number: 0, summary: "唯一优化" }] } : {} };
      return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic", stderr: "" };
    };
    await assert.rejects(runtime.queueProjectFoundationContinuation(project.id, { db, stageRunner: runner }), /synthetic second/);
    const failed = await db.pipelineRun.findFirstOrThrow({ where: { projectId: project.id, stageCode: failStage, status: "FAILED" } });
    const before = await getFoundationState(project.id, db);
    const inputs = await loadFoundationInputs(project.id, db);
    const upstreams: { f1?: NonNullable<typeof before.candidates.f1>; f2?: NonNullable<typeof before.candidates.f2> } = failStage === "F1" ? {} : { f1: before.candidates.f1!, ...(failStage === "Q1" ? { f2: before.candidates.f2! } : {}) };
    const rows = await db.pipelineRun.findMany({ where: { projectId: project.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const previews = await runtime.previewFoundationRecoveries(project.id, inputs, upstreams, rows, db);
    assert.equal(previews[failStage]?.resumeChunkCount, 1); assert.equal(previews[failStage]?.totalChunks, 3);
    assert.equal((await runtime.previewFoundationRecoveries(project.id, { ...inputs, sourceVersion: "changed" }, upstreams, rows, db))[failStage], null);
    if (failStage === "Q1") assert.equal((await runtime.previewFoundationRecoveries(project.id, inputs, { ...upstreams, f2: { ...upstreams.f2!, id: "changed" } }, rows, db)).Q1, null);
    await db.pipelineRun.update({ where: { id: failed.id }, data: { model: "changed" } });
    const modelChangedRows = await db.pipelineRun.findMany({ where: { projectId: project.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    assert.equal((await runtime.previewFoundationRecoveries(project.id, inputs, upstreams, modelChangedRows, db))[failStage], null, "实际已保存的源模型不一致时不得复用上游/本岗前缀");
    await db.pipelineRun.update({ where: { id: failed.id }, data: { model: failed.model } });
    const unknown = JSON.parse(failed.log!);
    unknown.calls[1].status = "RUNNING"; unknown.calls[1].providerCallCount = 1; unknown.calls[1].requestOutcome = "UNKNOWN"; delete unknown.calls[1].response;
    await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(unknown) } });
    await assert.rejects(runtime.queueProjectFoundationContinuation(project.id, { db, stageRunner: runner }), /未知/);
    await assert.rejects(runtime.queueSingleFoundationStage(project.id, failStage, { resumeFromRunId: failed.id }, { db, stageRunner: runner }), /未知/);
    await db.pipelineRun.update({ where: { id: failed.id }, data: { log: failed.log } });
    await assert.rejects(runtime.queueSingleFoundationStage(project.id, failStage, { resumeFromRunId: failed.id, replayOnly: true }, { db, stageRunner: runner }), /复验|分片/);
    await runtime.queueProjectFoundationContinuation(project.id, { db, stageRunner: runner });
    assert.equal(calls.filter((call) => call === `${failStage}:0`).length, 1, `${failStage} must reuse the saved first fragment`);
    const state = await getFoundationState(project.id, db);
    assert.equal(state.ready, true);
    assert.equal(state.finalOutput!.f1.overview.split("唯一前片改动").length - 1, 1, "Q1 prefix changes applied exactly once");
    const latest = await db.pipelineRun.findFirstOrThrow({ where: { projectId: project.id, stageCode: failStage, status: "SUCCEEDED" } });
    assert.deepEqual(JSON.parse(latest.log!).calls.map((call: {providerCallCount: number}) => call.providerCallCount), [0, 1, 1]);
    assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } }), failed, "original failed evidence is immutable");
    // F2 publication changes its historical-registry input; old F2 replay tests cover the pre-publication case.
    if (failStage !== "F2") {
      await db.pipelineRun.update({ where: { id: latest.id }, data: { status: "FAILED" } });
      let replayCalls = 0;
      await runtime.queueSingleFoundationStage(project.id, failStage, { resumeFromRunId: latest.id, replayOnly: true }, { db, stageRunner: async () => { replayCalls++; throw new Error("offline replay called provider"); } });
      assert.equal(replayCalls, 0);
    }
    console.log(`PASS ${failStage} real queue resumes suffix, publishes once and preserves evidence`);
  }
  const broken = await db.project.create({ data: { title: "__evidence_failure__", executionMode: "CLI", episodes: { create: [{ number: 1, title: "第一集", content: "1-1 礼堂 日 内\n李晴交接钥匙。" }] } } });
  await preprocessProject(broken.id, db);
  const failingDb = new Proxy(db, { get(target, key) {
    if (key === "pipelineRun") return new Proxy(target.pipelineRun, { get(delegate, method) {
      if (method === "update") return async (args: {data: {log?: string}}) => { if (args.data.log) throw new Error("synthetic evidence write unavailable"); return delegate.update(args as never); };
      return Reflect.get(delegate, method);
    } });
    return Reflect.get(target, key);
  } });
  await assert.rejects(runtime.queueProjectFoundationContinuation(broken.id, { db: failingDb, stageRunner: async () => { throw new Error("provider must not run"); } }), /evidence write unavailable/);
  assert.deepEqual((await db.pipelineRun.findMany({ where: { projectId: broken.id, stageCode: { in: ["F1", "F2", "Q1"] } }, orderBy: { stageCode: "asc" } })).map((run) => run.status), ["FAILED", "CANCELED", "CANCELED"], "evidence write failure must not skip terminal updates");
  console.log("PASS evidence write failure still attempts independent terminal updates");
  const uncertain = await db.project.create({ data: { title: "__unsaved_response__", executionMode: "CLI", episodes: { create: [{ number: 1, title: "第一集", content: "1-1 礼堂 日 内\n李晴交接钥匙。" }] } } });
  await preprocessProject(uncertain.id, db);
  const noResponseStorage = new Proxy(db, { get(target, key) {
    if (key === "pipelineRun") return new Proxy(target.pipelineRun, { get(delegate, method) {
      if (method === "update") return async (args: {data: {log?: string}}) => { if (args.data.log && JSON.parse(args.data.log).calls?.some((call: {response?: unknown}) => call.response)) throw new Error("synthetic response storage unavailable"); return delegate.update(args as never); };
      return Reflect.get(delegate, method);
    } });
    return Reflect.get(target, key);
  } });
  let uncertainCalls = 0;
  const paidRunner: FoundationStageRunner = async () => { uncertainCalls++; const data = { coverage: [1], overview: "已付费概述", episodes: [{ number: 1, summary: "已付费导航" }] }; return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "", stderr: "" }; };
  await assert.rejects(runtime.queueProjectFoundationContinuation(uncertain.id, { db: noResponseStorage, stageRunner: paidRunner }), /response storage unavailable/);
  await assert.rejects(runtime.queueProjectFoundationContinuation(uncertain.id, { db, stageRunner: paidRunner }), /未知/);
  assert.equal(uncertainCalls, 1);
  assert.equal((await db.sceneSnapshot.count({ where: { projectId: uncertain.id, sceneKey: "FOUNDATION_F1" } })), 0);
  console.log("PASS lost response storage stays unknown, creates no successful checkpoint and never auto-resends");
  const huge = await db.project.create({ data: { title: "__budget__", executionMode: "CLI", episodes: { create: [{ number: 1, title: "第一集", content: `1-1 礼堂 日 内\n${"原文".repeat(110000)}` }] } } });
  await preprocessProject(huge.id, db);
  let hugeCalls = 0;
  await assert.rejects(runtime.queueProjectFoundationContinuation(huge.id, { db, stageRunner: async () => { hugeCalls++; throw new Error("oversized input reached provider"); } }), /应用.*预算/);
  assert.equal(hugeCalls, 0);
  const hugeRun = await db.pipelineRun.findFirstOrThrow({ where: { projectId: huge.id, stageCode: "F1" } });
  assert.equal(hugeRun.status, "FAILED"); assert.ok(hugeRun.error?.includes("待处理"));
  console.log("PASS full request budget refuses before provider and saves readable pending reason");

  assert.equal(typeof runtime.reconcileAbandonedFoundationRuns, "function", "write action needs a confirmed-dead worker reconciler");
  const worker = await db.project.create({ data: { title: "__worker__" } });
  const live = await db.pipelineRun.create({ data: { projectId: worker.id, stageCode: "F1", roleName: "F1", provider: "Codex CLI", model: "synthetic", status: "RUNNING", inputSummary: JSON.stringify({ foundation: true, batchToken: "live", workerPid: process.pid }) } });
  const dead = await db.pipelineRun.create({ data: { projectId: worker.id, stageCode: "F2", roleName: "F2", provider: "Codex CLI", model: "synthetic", status: "RUNNING", inputSummary: JSON.stringify({ foundation: true, batchToken: "dead", workerPid: 2147483647 }) } });
  await runtime.reconcileAbandonedFoundationRuns(worker.id, db);
  assert.equal((await db.pipelineRun.findUniqueOrThrow({ where: { id: live.id } })).status, "RUNNING");
  assert.equal((await db.pipelineRun.findUniqueOrThrow({ where: { id: dead.id } })).status, "FAILED");
  console.log("PASS only confirmed dead worker is reclaimed; live worker preserved");
  assert.equal(typeof runtime.watchFoundationWorker, "function", "spawn errors and exits require an attached terminal observer");
  for (const kind of ["start-error", "exit"] as const) {
    const row = await db.pipelineRun.create({ data: { projectId: worker.id, stageCode: "Q1", roleName: "Q1", provider: "Codex CLI", model: "synthetic", status: "QUEUED", inputSummary: JSON.stringify({ foundation: true, batchToken: kind }) } });
    const child = kind === "start-error" ? spawn(path.join(scratch, "does-not-exist"), [], { stdio: "ignore" }) : spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "ignore" });
    await runtime.watchFoundationWorker(child, worker.id, kind, db);
    assert.equal((await db.pipelineRun.findUniqueOrThrow({ where: { id: row.id } })).status, "CANCELED");
  }
  const scriptRow = await db.pipelineRun.create({ data: { projectId: worker.id, stageCode: "F1", roleName: "F1", provider: "Codex CLI", model: "synthetic", status: "QUEUED", inputSummary: JSON.stringify({ foundation: true, batchToken: "top-level" }) } });
  assert.throws(() => execFileSync(path.resolve("node_modules/.bin/tsx"), [path.resolve("scripts/run-project-foundation.ts"), worker.id, "top-level", "INVALID"], { env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" }));
  assert.equal((await db.pipelineRun.findUniqueOrThrow({ where: { id: scriptRow.id } })).status, "CANCELED");
  console.log("PASS real child start error/exit and script top-level exception persist terminal states");
  const unreadable = await db.project.create({ data: { title: "__unreadable_source__" } });
  for (const stageCode of ["F1", "F2", "Q1"]) await db.pipelineRun.create({ data: { projectId: unreadable.id, stageCode, roleName: stageCode, provider: "Codex CLI", model: "synthetic", status: "QUEUED", inputSummary: JSON.stringify({ foundation: true, batchToken: "unreadable", provider: "CLI" }) } });
  const badBootstrap = new Proxy(db, { get(target, key) {
    if (key === "pipelineRun") return new Proxy(target.pipelineRun, { get(delegate, method) {
      if (method === "updateMany") return async (args: {data: {log?: string}}) => { if (args.data.log) throw new Error("synthetic bootstrap log failure"); return delegate.updateMany(args as never); };
      return Reflect.get(delegate, method);
    } });
    return Reflect.get(target, key);
  } });
  await assert.rejects(runtime.executeProjectFoundation(unreadable.id, "unreadable", { db: badBootstrap, stageRunner: paidRunner }));
  assert.equal(await db.pipelineRun.count({ where: { projectId: unreadable.id, status: "QUEUED" } }), 0, "bootstrap log failure must still attempt queued cancellation");
  console.log("PASS source-load failure does not let log storage failure skip cancellation");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await db.$disconnect(); const { prisma } = await import("@/lib/prisma"); await prisma.$disconnect(); rmSync(scratch, { recursive: true, force: true }); });
