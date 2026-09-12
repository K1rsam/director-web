import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FoundationStageRunner } from "@/lib/project-foundation";

const scratch = mkdtempSync(path.join(tmpdir(), "foundation-transport-"));
const url = `file:${path.join(scratch, "test.db")}`;
process.env.DATABASE_URL = url;
process.env.DEEPSEEK_API_KEY = "";
process.env.CODEX_CLI_PATH = "/__offline_only__/no-real-codex";
copyFileSync(path.resolve("prisma/schema.prisma"), path.join(scratch, "schema.prisma"));
execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", path.join(scratch, "schema.prisma"), "--skip-generate"], { cwd: scratch, env: { ...process.env, RUST_LOG: "info" }, stdio: "pipe" });
const db = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  const { runDeepSeekJson } = await import("@/lib/deepseek-api");
  const apiRequest = { prompt: "offline", model: "deepseek-chat", retry: false };
  const outcome = (expected: string) => (error: unknown) => { assert.equal((error as { requestOutcome?: string }).requestOutcome, expected); return true; };
  await assert.rejects(runDeepSeekJson(apiRequest), outcome("NOT_SENT"));
  const savedFetch = globalThis.fetch;
  process.env.DEEPSEEK_API_KEY = "offline-fake-key";
  try {
    for (const name of ["ECONNRESET", "ETIMEDOUT", "AbortError"]) {
      globalThis.fetch = async () => { throw Object.assign(new Error("offline network failure"), { name, code: name }); };
      await assert.rejects(runDeepSeekJson(apiRequest), outcome("UNKNOWN"));
    }
    globalThis.fetch = async () => new Response("rejected", { status: 401 });
    await assert.rejects(runDeepSeekJson(apiRequest), outcome("RESPONDED"));
    globalThis.fetch = async () => new Response("invalid envelope", { status: 200 });
    await assert.rejects(runDeepSeekJson(apiRequest), outcome("RESPONDED"));
    globalThis.fetch = async () => ({ ok: true, text: async () => { throw new Error("response body interrupted"); } }) as unknown as Response;
    await assert.rejects(runDeepSeekJson(apiRequest), outcome("UNKNOWN"));
  } finally { globalThis.fetch = savedFetch; process.env.DEEPSEEK_API_KEY = ""; }
  const { runCodexJson } = await import("@/lib/codex-cli");
  const cliRequest = { prompt: "offline", model: "offline", reasoningEffort: "low" as const, cwd: scratch, minimalRuntime: false };
  await assert.rejects(runCodexJson({ ...cliRequest, executable: path.join(scratch, "absent") }), outcome("NOT_SENT"));
  await assert.rejects(runCodexJson({ ...cliRequest, executable: process.execPath, executableArgs: ["-e", "setInterval(()=>{},1000)", "--"], timeoutMs: 20 }), outcome("UNKNOWN"));
  await assert.rejects(runCodexJson({ ...cliRequest, executable: process.execPath, executableArgs: ["-e", "require('node:fs').writeFileSync(process.argv[process.argv.indexOf('-o')+1], 'invalid complete output')", "--"] }), outcome("RESPONDED"));
  console.log("PASS adapter control metadata: local failure, disconnect, timeout, complete rejection and parse failure");
  const runtime = await import("@/lib/project-foundation");
  const { preprocessProject } = await import("@/lib/project-preprocess");
  for (const failStage of ["F1", "F2", "Q1"] as const) {
    for (const kind of ["UNKNOWN", "UNKNOWN_FIRST", "NOT_SENT", "RESPONDED"] as const) {
      const failIndex = kind === "UNKNOWN_FIRST" ? 0 : 1;
      const project = await db.project.create({ data: { title: `__transport_${failStage}_${kind}__`, executionMode: "CLI", episodes: { create: [0, 1, 2].map((number) => ({ number, title: `第${number}集`, content: `${number}-1 礼堂 日 内\n李晴交接钥匙。\n${"原文".repeat(6500)}` })) } } });
      await preprocessProject(project.id, db);
      const calls: string[] = [];
      let fail = true;
      const runner: FoundationStageRunner = async (stage, prompt) => {
        const input = JSON.parse(prompt.split("INPUT_JSON:\n").at(-1)!);
        const n = input.scope[0]; calls.push(`${stage}:${n}`);
        if (stage === failStage && n === failIndex && fail) {
          fail = false;
          if (kind !== "RESPONDED") throw Object.assign(new Error("synthetic transport failure"), {
            code: "ECONNRESET", ...(kind === "NOT_SENT" ? { requestOutcome: "NOT_SENT" } : {}),
            data: { requestOutcome: "NOT_SENT", coverage: input.scope },
          });
          return { data: { malformed: true, requestOutcome: "UNKNOWN" }, rawOutput: "{\"malformed\":true}", sessionId: null, stdout: "", stderr: "" };
        }
        const known = input.registry?.find((asset: { name: string }) => asset.name === "李晴");
        const data = stage === "F1" ? { coverage: input.scope, overview: `第${n}片概述`, episodes: [{ number: n, summary: `第${n}集导航` }] }
          : stage === "F2" ? { format: "ASSET_CATALOG_V2", coverage: input.scope, assets: [{ ...(known ? { key: known.key } : {}), name: "李晴", type: "CH", episodes: [n], preparation: { mode: "REFERENCE" } }] }
            : { format: "FOUNDATION_OPTIMIZATION_V2", coverage: input.scope, changes: {} };
        return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic", stderr: "" };
      };
      await assert.rejects(runtime.queueProjectFoundationContinuation(project.id, { db, stageRunner: runner }));
      const failed = await db.pipelineRun.findFirstOrThrow({ where: { projectId: project.id, stageCode: failStage, status: "FAILED" } });
      const log = JSON.parse(failed.log!);
      const count = calls.length;
      if (kind === "UNKNOWN" || kind === "UNKNOWN_FIRST") {
        await assert.rejects(runtime.queueProjectFoundationContinuation(project.id, { db, stageRunner: runner }), /未知/, `${failStage}: lost response must block ordinary continuation`);
        for (const replayOnly of [false, true]) await assert.rejects(runtime.queueSingleFoundationStage(project.id, failStage, { resumeFromRunId: failed.id, replayOnly }, { db, stageRunner: runner }), /未知|分片/);
        assert.equal(calls.length, count);
        assert.equal(log.calls[failIndex].response?.data, undefined, "error.data cannot masquerade as a saved model response");
        delete log.calls[failIndex].requestOutcome;
        await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(log) } });
        await assert.rejects(runtime.queueProjectFoundationContinuation(project.id, { db, stageRunner: runner }), /未知/, "legacy FAILED without response is unknown too");
        if (failStage === "F1" && kind === "UNKNOWN_FIRST") {
          await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify({ ...log, calls: [null] }) } });
          await assert.rejects(runtime.queueProjectFoundationContinuation(project.id, { db, stageRunner: runner }), /未知/, "malformed legacy call is not proof that no request was sent");
          await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(log) } });
        }
        const { getFoundationState } = await import("@/lib/foundation-state");
        const preview = (await getFoundationState(project.id, db)).recoveries[failStage];
        assert.equal(preview?.unknownRetryRunId, failed.id);
        assert.equal(preview?.unknownRetryChunkCount, failIndex);
        assert.equal(preview?.resumeRunId, null);
        await assert.rejects(runtime.queueSingleFoundationStage(project.id, failStage, { resumeFromRunId: failed.id, replayOnly: true, allowUnknownRetry: true }, { db, stageRunner: runner }), /复验/);
        const originalLog = JSON.stringify(log);
        log.calls[failIndex].model = "changed";
        await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(log) } });
        await assert.rejects(runtime.queueSingleFoundationStage(project.id, failStage, { resumeFromRunId: failed.id, allowUnknownRetry: true }, { db, stageRunner: runner }), /不匹配|绑定/);
        await db.pipelineRun.update({ where: { id: failed.id }, data: { log: originalLog } });
        await runtime.queueSingleFoundationStage(project.id, failStage, { resumeFromRunId: failed.id, allowUnknownRetry: true }, { db, stageRunner: runner });
        assert.equal(calls.filter((call) => call === `${failStage}:${failIndex}`).length, 2, "explicit consent permits unknown slot retry");
        if (failIndex) assert.equal(calls.filter((call) => call === `${failStage}:0`).length, 1, "explicit retry preserves prefix");
        assert.equal((await db.pipelineRun.findUniqueOrThrow({ where: { id: failed.id } })).log, originalLog, "retry preserves original evidence");
      } else if (kind === "NOT_SENT") {
        // Legacy successful response remains reusable without new metadata.
        delete log.calls[0].requestOutcome;
        await db.pipelineRun.update({ where: { id: failed.id }, data: { log: JSON.stringify(log) } });
        await runtime.queueProjectFoundationContinuation(project.id, { db, stageRunner: runner });
        assert.equal(calls.filter((call) => call === `${failStage}:0`).length, 1, "saved prefix reused");
        assert.equal(calls.filter((call) => call === `${failStage}:1`).length, 2, "proven NOT_SENT permits suffix continuation");
      }
      assert.equal(JSON.parse(failed.log!).calls[failIndex].requestOutcome, kind === "UNKNOWN_FIRST" ? "UNKNOWN" : kind, `${failStage}: metadata must reflect transport, not model data`);
      console.log(`PASS ${failStage} ${kind}: transport evidence and retry boundary`);
    }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await db.$disconnect(); const { prisma } = await import("@/lib/prisma"); await prisma.$disconnect(); rmSync(scratch, { recursive: true, force: true }); });
