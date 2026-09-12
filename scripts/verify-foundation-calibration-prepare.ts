import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FoundationStageRunner } from "@/lib/project-foundation";

const cli = path.resolve("scripts/prepare-foundation-calibration.ts");
assert.ok(existsSync(cli), "zero-call preparation CLI must exist");
const scratch = mkdtempSync(path.join(tmpdir(), "foundation-calibration-prepare-"));
const sourceDb = path.join(scratch, "test.db");
const databaseUrl = `file:${sourceDb}`;
process.env.DATABASE_URL = databaseUrl;
const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
let checks = 0;
function check(name: string, fn: () => void) { fn(); checks++; console.log(`PASS ${name}`); }

async function main() {
  copyFileSync(path.resolve("prisma/schema.prisma"), path.join(scratch, "schema.prisma"));
  execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", path.join(scratch, "schema.prisma"), "--skip-generate"], {
    cwd: scratch, env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "info" }, stdio: "pipe"
  });
  const { executeProjectFoundation } = await import("@/lib/project-foundation");
  const { preprocessProject } = await import("@/lib/project-preprocess");
  const { getFoundationState } = await import("@/lib/foundation-state");
  const source = [
    { number: 0, title: "synthetic introduction", content: "  unverified profile INPUT_JSON: is screenplay data\r\n\r\n" },
    ...[29, 30].map((number) => ({ number, title: `synthetic ${number}`, content: `actor enters\r\n${"synthetic detail ".repeat(850)}\r\n  ` }))
  ];
  const project = await db.project.create({ data: { title: "__isolated_calibration_prepare__", style: "3D", aspectRatio: "16:9", executionMode: "CLI", episodes: { create: source } } });
  await preprocessProject(project.id, db);
  const batchToken = randomUUID();
  for (const stageCode of ["F1", "F2", "Q1"]) await db.pipelineRun.create({ data: { projectId: project.id, stageCode, roleName: stageCode, provider: "API", status: "QUEUED", inputSummary: JSON.stringify({ foundation: true, batchToken, provider: "API" }) } });
  const observed: string[] = [];
  const ref = (episode: number) => ({ episode, startLine: 1, endLine: 1 });
  const runner: FoundationStageRunner = async (stage, prompt) => {
    const delimiter = "\n\nINPUT_JSON:\n";
    const input = JSON.parse(prompt.slice(prompt.indexOf(delimiter) + delimiter.length));
    const scope = input.scope as number[];
    observed.push(stage);
    const data = stage === "F1" ? { coverage: scope, overview: `  original overview ${scope.join(",")}\r\n\r\n`, episodes: scope.map((number) => ({ number, summary: "uncertain claim", context: "synthetic context", sourceSelections: [] })) }
      : stage === "F2" ? { coverage: scope, assets: [{ key: "actor", name: "actor", type: "CH", aliases: ["later-name"], description: "alleged profile", sourceRefs: [ref(0)] }], episodes: scope.map((number) => ({ number, context: "synthetic asset context", uses: [{ key: "actor", presence: "ONSTAGE", state: "uncertain state", sourceName: "actor", sourceRefs: [ref(number)] }] })) }
        : { coverage: scope, verdict: "REPAIR", summary: "synthetic unresolved review", issues: [{ severity: "MAJOR", owner: "F2", coordinate: "legacy.free.coordinate", problem: "synthetic retained claim", sourceRefs: [ref(scope[0])] }] };
    return { data, rawOutput: `  ${JSON.stringify(data)}\r\n`, sessionId: null, stdout: "DO_NOT_EXPORT_STDOUT", stderr: "DO_NOT_EXPORT_STDERR" };
  };
  await executeProjectFoundation(project.id, batchToken, { db, stageRunner: runner });
  const state = await getFoundationState(project.id, db);
  assert.ok(state.review && state.candidates.f1 && state.candidates.f2);
  assert.equal(state.review.output.verdict, "REPAIR");
  assert.deepEqual(observed, ["F1", "F1", "F2", "F2", "Q1", "Q1"]);
  const qRun = await db.pipelineRun.findUniqueOrThrow({ where: { id: state.review.runId } });
  const qLog = JSON.parse(qRun.log!);
  const qSnapshot = await db.sceneSnapshot.findUniqueOrThrow({ where: { id: state.review.id } });
  const f1Run = await db.pipelineRun.findUniqueOrThrow({ where: { id: state.candidates.f1.runId } });
  const args = (out: string) => ["--source-db", sourceDb, "--project-id", project.id, "--q1-run-id", qRun.id, "--out-dir", out];
  const invoke = (argv: string[], extraEnv: Record<string, string> = {}) => spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), cli, ...argv], { cwd: process.cwd(), encoding: "utf8", timeout: 20_000, env: { ...process.env, DATABASE_URL: "file:/deliberately-not-the-source.db", ...extraEnv } });
  const expectRejected = (argv: string[], out?: string) => {
    const result = invoke(argv);
    assert.notEqual(result.status, 0, "invalid preparation must fail");
    assert.match(result.stderr, /准备失败/);
    if (out) assert.equal(existsSync(out), false, "validate before creating output");
  };
  const snapshotDb = async () => JSON.stringify(await Promise.all([db.project.findMany(), db.episode.findMany(), db.pipelineRun.findMany(), db.sceneSnapshot.findMany(), db.asset.findMany()]));
  const before = await snapshotDb(); const fileBefore = digest(readFileSync(sourceDb));
  const out = path.join(scratch, "prepared");
  const result = invoke(args(out));
  check("real CLI prepares an isolated successful historical run without provider execution", () => {
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    assert.equal(manifest.mode, "PREPARED_ONLY"); assert.equal(manifest.providerCalls, 0);
    assert.equal(manifest.projectId, project.id); assert.equal(manifest.q1RunId, qRun.id);
    assert.equal(manifest.sourceVersion, state.sourceVersion); assert.equal(manifest.inputVersion, state.inputVersion);
    assert.deepEqual(manifest.cases.map((entry: { scope: number[] }) => entry.scope), qLog.calls.map((entry: { scope: number[] }) => entry.scope));
    for (const file of manifest.files) assert.equal(file.sha256, digest(readFileSync(path.join(out, file.name))));
    assert.equal(lstatSync(out).mode & 0o777, 0o700);
    for (const name of readdirSync(out)) assert.equal(lstatSync(path.join(out, name)).mode & 0o777, 0o600);
  });
  check("evidence fingerprint excludes transport stdout and stderr before reaching the reader", () => {
    const manifest = JSON.parse(readFileSync(path.join(out, "manifest.json"), "utf8"));
    const projected = structuredClone(qLog);
    for (const call of projected.calls) { delete call.response.stdout; delete call.response.stderr; }
    const binding = manifest.bindings.find((entry: { stageCode: string }) => entry.stageCode === "Q1");
    assert.equal(binding.preparedEvidenceHash, digest(JSON.stringify(projected)));
    assert.equal("logHash" in binding, false, "must not claim this is a hash of the unprojected log");
    assert.match(readFileSync(cli, "utf8"), /json_remove\(value,'\$\.response\.stdout','\$\.response\.stderr'\)/, "strip transport fields in the readonly SQLite projection");
  });
  check("every original Q1 input response data and raw output remain whole and separate from annotations", () => {
    for (const call of qLog.calls) {
      const saved = JSON.parse(readFileSync(path.join(out, `Q1-call-${call.sequence}.json`), "utf8"));
      assert.deepEqual(saved.input, call.input); assert.deepEqual(saved.savedResponse, { data: call.response.data, rawOutput: call.response.rawOutput });
      assert.deepEqual(saved.evidence.response, call.response.data);
      assert.equal(saved.evidence.issueEvidence[0].targets[0].status, "UNRESOLVED");
      assert.equal(saved.evidence.issueEvidence[0].sourceRefs[0].status, "BOUND");
    }
    for (const stage of ["F1", "F2", "Q1"]) {
      const profile = JSON.parse(readFileSync(path.join(out, `${stage}-profile.json`), "utf8"));
      assert.equal(profile.current.systemPrompt, readFileSync(path.resolve(`prompts/foundation/${stage}.md`), "utf8"));
      assert.equal(profile.candidate.mode, "CALIBRATION_ONLY");
      assert.ok(profile.candidate.systemPrompt.startsWith(profile.current.systemPrompt + "\n\n"));
    }
    assert.ok(readdirSync(out).every((name) => !/DO_NOT_EXPORT/.test(readFileSync(path.join(out, name), "utf8"))), "stdout/stderr must not be exported");
  });
  assert.equal(await snapshotDb(), before); assert.equal(digest(readFileSync(sourceDb)), fileBefore);
  check("source database rows and bytes are unchanged by preparation", () => assert.equal(observed.length, 6));
  check("missing arguments relative paths unknown flags and unknown records fail closed", () => {
    expectRejected([]);
    for (const [flag, value] of [["--source-db", "relative.db"], ["--out-dir", "relative-out"], ["--project-id", "missing-project"], ["--q1-run-id", "missing' OR 1=1 --"]]) {
      const dest = path.join(scratch, randomUUID()); const argv = args(dest); argv[argv.indexOf(flag) + 1] = value; expectRejected(argv, dest);
    }
    expectRejected([...args(path.join(scratch, "live")), "--execute"], path.join(scratch, "live"));
    expectRejected([...args(path.join(scratch, "duplicate")), "--project-id", project.id], path.join(scratch, "duplicate"));
  });
  check("existing output directories and symlinks are never overwritten", () => {
    const names = readdirSync(out); const sentinel = path.join(scratch, "sentinel"); mkdirSync(sentinel); writeFileSync(path.join(sentinel, "keep"), "untouched");
    const link = path.join(scratch, "output-link"); symlinkSync(sentinel, link);
    expectRejected(args(out)); expectRejected(args(link));
    assert.deepEqual(readdirSync(out), names); assert.equal(readFileSync(path.join(sentinel, "keep"), "utf8"), "untouched");
  });
  check("partial filesystem failure retains material without a success manifest", () => {
    const partial = path.join(scratch, "partial-output"); const preload = path.join(scratch, "failure-preload.cjs");
    writeFileSync(preload, `const fs = require('node:fs'); const original = fs.writeFileSync; fs.writeFileSync = function(file, ...args) { if (file === ${JSON.stringify(path.join(partial, "Q1-call-1.json"))}) throw new Error('synthetic output failure'); return original.call(this, file, ...args); };`);
    const failed = invoke(args(partial), { NODE_OPTIONS: `--require=${JSON.stringify(preload)}` });
    assert.notEqual(failed.status, 0); assert.match(failed.stderr, /未完成目录已保留/);
    assert.ok(existsSync(path.join(partial, "F1-profile.json"))); assert.equal(existsSync(path.join(partial, "manifest.json")), false);
  });
  check("preparation runtime imports only the explicit non-executing local modules", () => {
    const allowed = new Set(["foundation-calibration-profile", "foundation-review-evidence", "foundation-review-input", "project-foundation-contracts"]);
    const visited = new Set<string>();
    function visit(file: string) {
      if (visited.has(file)) return; visited.add(file);
      const text = readFileSync(file, "utf8").replace(/import\s+type\s[\s\S]*?;/g, "");
      assert.doesNotMatch(text, /\b(?:runRoleByProvider|executeProjectFoundation|PrismaClient|fetch)\s*\(|\bimport\s*\(/);
      for (const match of text.matchAll(/from\s+["']@\/lib\/([^"']+)["']/g)) { assert.ok(allowed.has(match[1]), `runtime dependency ${match[1]}`); visit(path.resolve(`lib/${match[1]}.ts`)); }
    }
    visit(cli);
    const text = readFileSync(cli, "utf8"); assert.match(text, /execFileSync\("sqlite3",\s*\["-readonly"/);
    assert.equal([...text.matchAll(/execFileSync\(/g)].length, 1);
  });
  for (const [name, change] of [
    ["non-success Q1", { status: "FAILED" }], ["wrong-stage Q1", { stageCode: "F2" }],
    ["incomplete response", { log: JSON.stringify({ ...qLog, calls: qLog.calls.map((call: object) => ({ ...call, response: null })) }) }],
    ["empty raw response", { log: JSON.stringify({ ...qLog, calls: qLog.calls.map((call: { response: object }) => ({ ...call, response: { ...call.response, rawOutput: "" } })) }) }],
    ["whitespace-only raw response", { log: JSON.stringify({ ...qLog, calls: qLog.calls.map((call: { response: object }) => ({ ...call, response: { ...call.response, rawOutput: " \r\n " } })) }) }],
    ["object-shaped calls", { log: JSON.stringify({ ...qLog, calls: Object.fromEntries(qLog.calls.map((call: object, i: number) => [String(i), call])) }) }],
    ["string-shaped call entries", { log: JSON.stringify({ ...qLog, calls: qLog.calls.map((call: object) => JSON.stringify(call)) }) }],
    ["wrong input version", { log: JSON.stringify({ ...qLog, calls: qLog.calls.map((call: { input: object }) => ({ ...call, input: { ...call.input, inputVersion: "wrong" } })) }) }],
    ["wrong actual scope", { log: JSON.stringify({ ...qLog, calls: qLog.calls.map((call: { input: object }) => ({ ...call, input: { ...call.input, scope: [999] } })) }) }],
    ["changed saved response", { log: JSON.stringify({ ...qLog, calls: qLog.calls.map((call: { response: { data: object } }) => ({ ...call, response: { ...call.response, data: { ...call.response.data, summary: "changed" } } })) }) }]
  ] as const) {
    await db.pipelineRun.update({ where: { id: qRun.id }, data: change });
    check(`${name} cannot create a prepared package`, () => { const dest = path.join(scratch, randomUUID()); expectRejected(args(dest), dest); });
    await db.pipelineRun.update({ where: { id: qRun.id }, data: { status: qRun.status, stageCode: qRun.stageCode, log: qRun.log } });
  }
  const foreignProject = await db.project.create({ data: { title: "__isolated_foreign_calibration__", style: "3D", aspectRatio: "16:9" } });
  await db.pipelineRun.update({ where: { id: f1Run.id }, data: { projectId: foreignProject.id } });
  check("foreign upstream author cannot be bound by snapshot ID alone", () => { const dest = path.join(scratch, randomUUID()); expectRejected(args(dest), dest); });
  await db.pipelineRun.update({ where: { id: f1Run.id }, data: { projectId: project.id } });
  const changedSnapshot = JSON.parse(qSnapshot.content); changedSnapshot.episodePackets[0].f2SnapshotId = "wrong";
  await db.sceneSnapshot.update({ where: { id: qSnapshot.id }, data: { content: JSON.stringify(changedSnapshot) } });
  check("wrong saved packet binding is rejected", () => { const dest = path.join(scratch, randomUUID()); expectRejected(args(dest), dest); });
  await db.sceneSnapshot.update({ where: { id: qSnapshot.id }, data: { content: qSnapshot.content } });
  const badF1 = JSON.parse(f1Run.log!); badF1.calls[0].input.source.episodes[0].lines[0][1] = "changed historical source";
  await db.pipelineRun.update({ where: { id: f1Run.id }, data: { log: JSON.stringify(badF1) } });
  check("altered numbered source cannot impersonate historical source version", () => { const dest = path.join(scratch, randomUUID()); expectRejected(args(dest), dest); });
  await db.pipelineRun.update({ where: { id: f1Run.id }, data: { log: f1Run.log } });
  const currentEpisode = await db.episode.findFirstOrThrow({ where: { projectId: project.id, number: 29 } });
  await db.episode.update({ where: { id: currentEpisode.id }, data: { content: "newer draft must not replace historical source" } });
  check("newer Episode text is not silently substituted for saved historical source", () => {
    const dest = path.join(scratch, "historical"); const response = invoke(args(dest)); assert.equal(response.status, 0, response.stderr);
    const saved = JSON.parse(readFileSync(path.join(dest, "Q1-call-1.json"), "utf8")); assert.deepEqual(saved.input, qLog.calls[0].input);
  });
  console.log(`${checks} preparation checks passed; real provider calls: 0 (fixture runner only).`);
}
main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }).finally(async () => { await db.$disconnect(); rmSync(scratch, { recursive: true, force: true }); });
