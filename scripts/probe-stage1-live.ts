/** Bounded current-pipeline probe. Default is prepare-only; --live permits at most four CLI calls. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PrismaClient } from "@prisma/client";
import type { FoundationStageRunner } from "@/lib/project-foundation";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const live = process.argv.includes("--live");
const limit = 4, timeoutMs = 300000;

async function main() {
  const directory = resolve("runtime-3008/stage1-probe", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const save = (name: string, data: unknown) => writeFileSync(join(directory, name), JSON.stringify(data, null, 2), { mode: 0o600 });
  const source = readFileSync("examples/stage1-probe-v1/source.txt", "utf8");
  writeFileSync(join(directory, "source.txt"), source, { mode: 0o600 });
  const dbPath = join(directory, "isolated.db"), sqlite = new DatabaseSync(dbPath);
  for (const name of readdirSync("prisma/migrations").sort()) if (/^\d/.test(name)) sqlite.exec(readFileSync(join("prisma/migrations", name, "migration.sql"), "utf8"));
  sqlite.close();
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.CODEX_CLI_TIMEOUT_MS = String(timeoutMs); // this probe process only
  const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL });
  (globalThis as unknown as { prisma: PrismaClient }).prisma = db;
  const calls: Array<Record<string, any>> = [], stages = new Set<string>();
  let projectId = "";
  const startedAt = new Date().toISOString();
  save("manifest.json", { schema: "STAGE1_PROBE_V1", directory, startedAt, live, sourceHash: hash(source), sourceChars: source.length, callLimit: limit, timeoutMs, database: dbPath, autoAssetPrompts: false, purpose: "Current checked-out first-stage behavior; no webpage or production DB. Integration status is evidenced by the saved handoff and receiver checks." });
  console.log(JSON.stringify({ event: "prepared_directory", directory, live }));
  try {
    const databases = await db.$queryRawUnsafe<Array<{ name: string; file: string }>>("PRAGMA database_list");
    if (resolve(databases.find(row => row.name === "main")?.file || "") !== dbPath) throw Error("ISOLATION_DATABASE_MISMATCH");
    if ((await import("@/lib/prisma")).prisma !== db) throw Error("ISOLATION_SINGLETON_MISMATCH");
    const user = await db.user.create({ data: { username: "synthetic-stage1-probe", email: "stage1-probe@example.invalid", name: "合成小案例", passwordHash: "unused-isolated-account" } });
    const { prepareFidelityImport } = await import("@/lib/fidelity-import");
    const { importParsedProject } = await import("@/lib/workflow");
    const prepared = await prepareFidelityImport("stage1-probe.txt", Buffer.from(source), "fidelity");
    prepared.receipt.p1Review = { status: "PENDING" };
    save("import-receipt.json", prepared.receipt);
    const imported = await importParsedProject({ ownerUserId: user.id, title: "第一阶段小案例：借来的钥匙", style: "3D国漫", aspectRatio: "16:9", executionMode: "CLI", sourceName: "stage1-probe.txt", fidelityReceipt: prepared.receipt }, prepared.imported, db);
    projectId = imported.project.id;
    const initialEpisodes = await db.episode.findMany({ where: { projectId }, orderBy: { number: "asc" }, select: { id: true, number: true, title: true, content: true } });
    save("initial-episodes.json", initialEpisodes);
    if (!live) { save("summary.json", { mode: "prepare-only", projectId, calls: 0, importValidation: prepared.receipt.result.validation, episodes: initialEpisodes.map(e => ({ number: e.number, title: e.title })) }); console.log(JSON.stringify({ status: "PREPARED_ONLY", directory, projectId, calls: 0, episodes: initialEpisodes.map(e => e.number) })); return; }
    const cli = await import("@/lib/codex-cli"), runner = await import("@/lib/role-runner"), core = await import("@/lib/project-foundation");
    const usage = await import("@/lib/foundation-run-usage");
    const ready = await cli.assertCodexCliReady();
    save("preflight.json", { executable: ready.executable, version: ready.version, provider: "CLI", requestedModelPolicy: "use current production resolver without changing it", timeoutMs });
    const stageRunner: FoundationStageRunner = async (stage, prompt, call) => {
      const repair = /allowedPaths|"repairAttempt"\s*:\s*1/.test(prompt);
      if (!["F1", "F2", "Q1"].includes(stage) || calls.length >= limit || (stages.has(stage) && !repair)) throw Object.assign(Error("TEST_CALL_BUDGET_OR_SCOPE"), { requestOutcome: "NOT_SENT" });
      core.assertFoundationRequestBudget(call.role.systemPrompt || "", prompt);
      const model = runner.resolveCliModel(stage, call.role.model), reasoning = runner.resolveCliReasoning(stage, call.role.reasoningEffort);
      const systemPrompt = call.role.systemPrompt || "";
      const sentPrompt = call.role.systemPrompt === undefined ? prompt : `### 岗位规则（内嵌指令）\n\n${systemPrompt}\n\n### 当前任务\n\n${prompt}`;
      const number = calls.length + 1, prefix = `${number}-${stage}`;
      const record: Record<string, any> = { number, stage, displayStage: stage === "F1" ? "P1来源结构" : stage, repair, model, reasoning, status: "SENT", startedAt: new Date().toISOString(), systemChars: systemPrompt.length, taskChars: prompt.length, sentChars: sentPrompt.length, sentHash: hash(sentPrompt), requestOutcome: "UNKNOWN", usage: null };
      calls.push(record); stages.add(stage);
      save(`${prefix}-request.json`, { ...record, systemPrompt, taskPrompt: prompt, sentPrompt, transportScope: "application-constructed stdin; excludes CLI implicit system/tool context" });
      save("calls.json", calls); console.log(JSON.stringify({ event: "request_started", number, stage, model, reasoning, inputChars: sentPrompt.length }));
      try {
        const result = await runner.runRoleByProvider({ provider: "CLI", projectId, role: call.role, prompt, sessionMode: "ephemeral" });
        const events = result.stdout.split(/\r?\n/).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        record.usage = usage.summarizeFoundationRunUsage({ schema: "FOUNDATION_RUN_EVIDENCE_V1", calls: [{ provider: "CLI", providerCallCount: 1, requestOutcome: "RESPONDED", response: { stdout: result.stdout } }] });
        record.status = "RESPONDED"; record.requestOutcome = "RESPONDED";
        record.outputChars = (result.rawOutput || JSON.stringify(result.data)).length;
        record.eventCounts = Object.fromEntries([...new Set(events.map(e => e.type))].map(type => [type, events.filter(e => e.type === type).length]));
        save(`${prefix}-response.json`, { data: result.data, rawOutput: result.rawOutput, usage: record.usage, eventCounts: record.eventCounts, note: "Final output only; reasoning/tool transcript not exported here." });
        return result;
      } catch (error) {
        const e = error as Error & { requestOutcome?: string; rawOutput?: string; stdout?: string };
        record.status = "FAILED"; record.requestOutcome = e.requestOutcome || "UNKNOWN";
        record.error = e.message;
        if (e.stdout) record.usage = usage.summarizeFoundationRunUsage({ schema: "FOUNDATION_RUN_EVIDENCE_V1", calls: [{ provider: "CLI", providerCallCount: 1, requestOutcome: record.requestOutcome, response: { stdout: e.stdout } }] });
        save(`${prefix}-error.json`, { message: e.message, outcome: record.requestOutcome, rawOutput: e.rawOutput ?? null, usage: record.usage });
        throw error;
      } finally {
        record.finishedAt = new Date().toISOString(); record.durationMs = Date.parse(record.finishedAt) - Date.parse(record.startedAt);
        save("calls.json", calls); console.log(JSON.stringify({ event: "request_ended", number, stage, status: record.status, durationMs: record.durationMs, usage: record.usage }));
      }
    };
    const api = await import("@/lib/foundation-delivery");
    const task = await api.queueFoundationDelivery(projectId, { autoAssetPrompts: false }, db);
    await api.executeFoundationDelivery(projectId, task.id, { db, stageRunner });
    const state = await api.getFoundationDeliveryState(projectId, db);
    save("final-state.json", state);
    const receipt = await (await import("@/lib/fidelity-store")).readFidelityReceipt(projectId, db);
    save("final-source-receipt.json", receipt?.receipt);
    const episodes = await db.episode.findMany({ where: { projectId }, orderBy: { number: "asc" }, select: { id: true, number: true, title: true, content: true } });
    save("final-episodes.json", episodes);
    const reader = await import("@/lib/light-foundation-reader");
    const packets: unknown[] = [];
    for (const episode of episodes) if (episode.number > 0) { try { packets.push(await reader.readLightEpisodeFoundation(projectId, episode.number)); } catch (error) { packets.push({ episode: episode.number, error: error instanceof Error ? error.message : String(error) }); } }
    save("handoff-packets.json", packets);
    const summary = { directory, projectId, startedAt, finishedAt: new Date().toISOString(), count: calls.length, calls, status: state.task?.status, complete: state.complete, documentReady: state.documentReady, blocker: state.continuationBlocker, sourceUnchanged: receipt?.receipt.result.source.text === source, episodes: episodes.map(e => ({ number: e.number, title: e.title })), issues: state.issues, requiredChoices: state.requiredChoices };
    save("summary.json", summary); console.log(JSON.stringify({ event: "probe_finished", directory, count: calls.length, status: summary.status, complete: summary.complete, sourceUnchanged: summary.sourceUnchanged }));
    if (!state.complete || !summary.sourceUnchanged) process.exitCode = 1;
  } catch (error) {
    save("blocked.json", { directory, projectId, calls, error: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
    console.log(JSON.stringify({ event: "probe_blocked", directory, calls: calls.length, error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1;
  } finally { await db.$disconnect(); }
}
main().catch(() => { console.error("Probe setup could not complete; no automatic retry."); process.exitCode = 1; });
