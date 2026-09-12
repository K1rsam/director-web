/** Explicit historical material preparation only. No execution, publication, or database writer. */
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PipelineRun } from "@prisma/client";
import { loadFoundationCalibrationProfile } from "@/lib/foundation-calibration-profile";
import { bindQ1ReviewEvidence } from "@/lib/foundation-review-evidence";
import { buildQ1ScopedSupply, requireBoundF1AuthorChunks } from "@/lib/foundation-review-input";
import {
  buildNumberedSource, buildSourceIndex, hashFoundationPrompt, isRecord, loadFoundationSystemPrompt,
  mergeF2Outputs, requireF2Output, requireQ1Output,
  type F1Output, type F2Output, type FoundationStageCode, type RawSourceEpisode
} from "@/lib/project-foundation-contracts";
import type { EpisodeFoundationDraft, FoundationCandidate } from "@/lib/foundation-state";

type Run = Pick<PipelineRun, "id" | "projectId" | "episodeId" | "stageCode" | "status" | "inputSummary" | "outputSummary" | "log">;
type SavedSnapshot = { id: string; projectId: string; sceneKey: string; content: string };
type SavedCall = Record<string, unknown> & { input: Record<string, unknown>; response: Record<string, unknown> };
function fail(message: string): never { throw new Error(message); }
function record(value: unknown, label: string): Record<string, unknown> { if (!isRecord(value)) fail(`${label}不是完整对象。`); return value; }
function parsed(value: unknown, label: string) { if (typeof value !== "string") fail(`${label}缺失。`); try { return record(JSON.parse(value), label); } catch { fail(`${label}不是完整JSON对象。`); } }
function same(actual: unknown, expected: unknown, label: string) { if (!isDeepStrictEqual(actual, expected)) fail(`${label}不一致。`); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0; }
function existsEntry(value: string) { try { lstatSync(value); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; } }
function parameters() {
  const names = ["--source-db", "--project-id", "--q1-run-id", "--out-dir"];
  const argv = process.argv.slice(2); const args = new Map<string, string>();
  if (argv.length !== names.length * 2) fail("必须显式提供--source-db、--project-id、--q1-run-id和--out-dir；本入口不支持执行选项。");
  for (let i = 0; i < argv.length; i += 2) {
    if (!names.includes(argv[i]) || args.has(argv[i]) || !nonempty(argv[i + 1]) || argv[i + 1].startsWith("--")) fail("参数未知、重复或缺少值。");
    args.set(argv[i], argv[i + 1]);
  }
  const database = args.get("--source-db")!; const out = args.get("--out-dir")!;
  if (!path.isAbsolute(database) || !path.isAbsolute(out)) fail("数据库和输出目录必须使用绝对路径。");
  if (!statSync(database).isFile()) fail("来源数据库不是文件。");
  if (existsEntry(out)) fail("输出目录已存在；禁止覆盖目录、文件或软链接。");
  if (!statSync(path.dirname(out)).isDirectory()) fail("输出目录的父目录必须已存在。");
  return { database: realpathSync(database), out: path.resolve(out), projectId: args.get("--project-id")!, q1RunId: args.get("--q1-run-id")! };
}

function readHistoricalRows(database: string, projectId: string, q1RunId: string) {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  // One SQLite statement observes one consistent read snapshot, following exact IDs, never latest rows.
  const sql = `WITH q AS (SELECT * FROM PipelineRun WHERE id=${quote(q1RunId)} AND projectId=${quote(projectId)}),
    qs AS (SELECT s.* FROM SceneSnapshot s, q WHERE s.projectId=q.projectId AND s.id=json_extract(q.outputSummary,'$.snapshotId')),
    fs AS (SELECT s.* FROM SceneSnapshot s, qs WHERE s.projectId=qs.projectId AND s.id IN (json_extract(qs.content,'$.upstreamSnapshotIds.f1'),json_extract(qs.content,'$.upstreamSnapshotIds.f2'))),
    snaps AS (SELECT * FROM qs UNION ALL SELECT * FROM fs),
    runs AS (SELECT * FROM q UNION SELECT * FROM PipelineRun WHERE projectId=${quote(projectId)} AND id IN (SELECT json_extract(content,'$.runId') FROM fs))
    SELECT json_object('runs',json((SELECT json_group_array(json_object('id',id,'projectId',projectId,'episodeId',episodeId,'stageCode',stageCode,'status',status,'inputSummary',inputSummary,'outputSummary',outputSummary,
    'log',CASE WHEN json_type(log,'$.calls')='array' AND NOT EXISTS (SELECT 1 FROM json_each(log,'$.calls') AS entry WHERE entry.type<>'object')
      THEN substr(json_set(log,'$.calls',json((SELECT json_group_array(json_remove(value,'$.response.stdout','$.response.stderr')) FROM json_each(log,'$.calls')))),1) ELSE NULL END)) FROM runs)),
    'snapshots',json((SELECT json_group_array(json_object('id',id,'projectId',projectId,'sceneKey',sceneKey,'content',content)) FROM snaps)));`;
  const raw = execFileSync("sqlite3", ["-readonly", "-batch", "-noheader", database, sql], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  const rows = parsed(raw, "只读数据库结果");
  if (!Array.isArray(rows.runs) || rows.runs.length !== 3 || !Array.isArray(rows.snapshots) || rows.snapshots.length !== 3) fail("必须有同项目完整的Q1及确切F1/F2上游记录。");
  return { runs: rows.runs as Run[], snapshots: rows.snapshots as SavedSnapshot[] };
}

function boundStage(stage: FoundationStageCode, rows: ReturnType<typeof readHistoricalRows>, projectId: string) {
  const snapshots = rows.snapshots.filter((row) => row.sceneKey === `FOUNDATION_${stage}` && row.projectId === projectId);
  if (snapshots.length !== 1) fail(`${stage}候选快照缺失或重复。`);
  const row = snapshots[0]; const candidate = parsed(row.content, `${stage}候选`);
  if (candidate.schema !== "FOUNDATION_CANDIDATE_V1" || candidate.id !== row.id || candidate.stageCode !== stage
    || !nonempty(candidate.runId) || !nonempty(candidate.batchToken) || !nonempty(candidate.sourceVersion) || !nonempty(candidate.inputVersion)
    || !Array.isArray(candidate.mechanicalIssues)) fail(`${stage}候选身份或版本不完整。`);
  const runs = rows.runs.filter((run) => run.id === candidate.runId);
  if (runs.length !== 1) fail(`${stage}作者执行缺失或重复。`);
  const run = runs[0];
  if (run.projectId !== projectId || run.episodeId !== null || run.stageCode !== stage || run.status !== "SUCCEEDED") fail(`${stage}执行不是同项目的成功记录。`);
  const summary = parsed(run.inputSummary, `${stage}输入摘要`); const outputSummary = parsed(run.outputSummary, `${stage}输出摘要`); const log = parsed(run.log, `${stage}调用证据`);
  if (log.schema !== "FOUNDATION_RUN_EVIDENCE_V1" || log.runId !== run.id || log.stageCode !== stage || outputSummary.snapshotId !== row.id) fail(`${stage}日志或输出快照绑定不符。`);
  for (const key of ["sourceVersion", "inputVersion"]) {
    same(summary[key], candidate[key], `${stage}输入${key}`); same(log[key], candidate[key], `${stage}日志${key}`); same(outputSummary[key], candidate[key], `${stage}输出${key}`);
  }
  for (const key of ["batchToken", "upstreamSnapshotIds"]) { same(summary[key], candidate[key], `${stage}输入${key}`); same(log[key], candidate[key], `${stage}日志${key}`); }
  same(log.mergedOutput, candidate.output, `${stage}合并结果与候选`);
  same(outputSummary.coverage, candidate.scope, `${stage}输出范围`);
  if (!Array.isArray(log.calls) || !log.calls.length || summary.chunks !== log.calls.length) fail(`${stage}调用分片不完整。`);
  const calls: SavedCall[] = log.calls.map((value, index) => {
    const call = record(value, `${stage}分片`); const input = record(call.input, `${stage}实际输入`); const response = record(call.response, `${stage}响应`);
    if (call.sequence !== index + 1 || call.status !== "SUCCEEDED" || !nonempty(call.systemPrompt) || !nonempty(call.taskPrompt)
      || !nonempty(response.rawOutput) || !isRecord(response.data)) fail(`${stage}原始成功输入响应不完整。`);
    for (const key of ["sourceVersion", "inputVersion"]) { same(call[key], candidate[key], `${stage}分片${key}`); same(input[key], candidate[key], `${stage}实际输入${key}`); }
    same(input.scope, call.scope, `${stage}实际scope`);
    const delimiter = "\n\nINPUT_JSON:\n";
    const marker = call.taskPrompt.indexOf(delimiter);
    if (marker < 0) fail(`${stage}提示缺少原始INPUT_JSON。`);
    same(parsed(call.taskPrompt.slice(marker + delimiter.length), `${stage}提示内输入`), input, `${stage}提示与实际输入`);
    return { ...call, input, response };
  });
  return { candidate: candidate as unknown as FoundationCandidate, run, log, calls };
}

function prepare(args: ReturnType<typeof parameters>) {
  const rows = readHistoricalRows(args.database, args.projectId, args.q1RunId);
  const f1 = boundStage("F1", rows, args.projectId); const f2 = boundStage("F2", rows, args.projectId); const q1 = boundStage("Q1", rows, args.projectId);
  same(q1.run.id, args.q1RunId, "指定Q1执行");
  same(f1.candidate.upstreamSnapshotIds, {}, "F1上游");
  same(f2.candidate.upstreamSnapshotIds, { f1: f1.candidate.id }, "F2上游");
  same(q1.candidate.upstreamSnapshotIds, { f1: f1.candidate.id, f2: f2.candidate.id }, "Q1上游");
  // Reconstruct only saved F1 source tuples, not mutable current Episode content.
  const source: RawSourceEpisode[] = f1.calls.flatMap((call) => {
    const numbered = record(call.input.source, "F1编号原文");
    if (numbered.schema !== "NUMBERED_SOURCE_V1" || numbered.version !== f1.candidate.sourceVersion || !Array.isArray(numbered.episodes)) fail("F1编号原文版本或结构无效。");
    return numbered.episodes.map((value) => {
      const episode = record(value, "F1编号集");
      if (!Array.isArray(episode.lines) || episode.lines.length !== episode.lineCount
        || episode.lines.some((line, position) => !Array.isArray(line) || line.length !== 2 || line[0] !== position + 1 || typeof line[1] !== "string")) fail("F1编号原行缺失或错位。");
      return { number: episode.number as number, title: episode.title as string | null, content: episode.lines.map((line) => line[1]).join("") };
    });
  });
  const index = buildSourceIndex(source); const scope = index.episodes.map((episode) => episode.number);
  for (const stage of [f1, f2, q1]) {
    same(stage.candidate.sourceVersion, index.version, "历史源版本"); same(stage.candidate.inputVersion, f1.candidate.inputVersion, "共同输入版本");
    same(stage.candidate.scope, scope, "完整候选范围");
    same(stage.calls.flatMap((call) => call.scope), scope, "完整分片覆盖");
    for (const call of stage.calls) {
      const part = call.scope as number[];
      same(call.input.source, buildNumberedSource(index, part), "实际编号原文与历史源");
      same(call.sourceChars, index.episodes.filter((episode) => part.includes(episode.number)).reduce((sum, episode) => sum + episode.content.length, 0), "原文字数");
      if (typeof call.oversized !== "boolean") fail("分片缺少oversized标记。");
    }
  }
  const authorChunks = requireBoundF1AuthorChunks({ projectId: args.projectId, index, candidate: f1.candidate as FoundationCandidate<F1Output>, run: f1.run });
  const f2Parts: F2Output[] = [];
  for (const call of f2.calls) {
    same(record(call.input.f1, "F2上游输入").snapshotId, f1.candidate.id, "F2实际F1快照");
    same(record(call.input.f1, "F2上游输入").episodes, (f1.candidate.output as F1Output).episodes.filter((episode) => (call.scope as number[]).includes(episode.number)), "F2实际F1供给");
    const prior = f2Parts.length ? mergeF2Outputs(f2Parts, index, f2Parts.flatMap((part) => part.coverage)).assets : [];
    f2Parts.push(requireF2Output(call.response.data, index, call.scope as number[], prior));
  }
  same(mergeF2Outputs(f2Parts, index, scope), f2.candidate.output, "F2原响应合并");
  const qParts = q1.calls.map((call) => requireQ1Output(call.response.data, index, call.scope as number[]));
  const merged = requireQ1Output({ coverage: qParts.flatMap((part) => part.coverage), verdict: qParts.some((part) => part.verdict === "BLOCKED") ? "BLOCKED" : qParts.some((part) => part.verdict === "REPAIR") ? "REPAIR" : "READY", summary: qParts.map((part) => part.summary).join("\n\n"), issues: qParts.flatMap((part) => part.issues) }, index, scope);
  same(merged, q1.candidate.output, "Q1原响应合并");
  if (!Array.isArray(q1.candidate.episodePackets)) fail("Q1缺少保存的完整消费者资料包。");
  const files = new Map<string, string>();
  const jsonFile = (name: string, value: unknown) => files.set(name, JSON.stringify(value, null, 2) + "\n");
  for (const stage of ["F1", "F2", "Q1"] as const) {
    const current = loadFoundationSystemPrompt(stage);
    jsonFile(`${stage}-profile.json`, { current: { stageCode: stage, systemPrompt: current, hash: hashFoundationPrompt(current) }, candidate: loadFoundationCalibrationProfile(stage) });
  }
  const cases = q1.calls.map((call) => {
    const supplied = buildQ1ScopedSupply({ index, scope: call.scope as number[], f1: f1.candidate as FoundationCandidate<F1Output>, f2: f2.candidate as FoundationCandidate<F2Output>, authorChunks, packets: q1.candidate.episodePackets as EpisodeFoundationDraft[] });
    // Explanatory wording may change; saved input remains original. All supplied data must match.
    for (const key of Object.keys(supplied).filter((key) => key !== "reviewScopeNote")) same(call.input[key], Reflect.get(supplied, key), `Q1实际供给${key}`);
    const name = `Q1-call-${call.sequence}.json`;
    jsonFile(name, { mode: "PREPARED_ONLY", sourceRunId: q1.run.id, sourceSnapshotId: q1.candidate.id, sequence: call.sequence, scope: call.scope,
      originalSystemPrompt: call.systemPrompt, originalTaskPrompt: call.taskPrompt, input: call.input,
      savedResponse: { data: call.response.data, rawOutput: call.response.rawOutput }, evidence: bindQ1ReviewEvidence(call.input, call.response.data) });
    return { sequence: call.sequence, scope: call.scope, file: name };
  });
  jsonFile("bound-candidates.json", { f1: f1.candidate, f2: f2.candidate, q1: q1.candidate });
  const manifest = { schema: "FOUNDATION_CALIBRATION_PREPARATION_V1", mode: "PREPARED_ONLY", providerCalls: 0, createdAt: new Date().toISOString(),
    projectId: args.projectId, q1RunId: args.q1RunId, sourceVersion: index.version, inputVersion: f1.candidate.inputVersion,
    sourceBasis: "SAVED_F1_NUMBERED_INPUT_NOT_CURRENT_EPISODE", scope, cases,
    bindings: [f1, f2, q1].map((stage) => ({ stageCode: stage.candidate.stageCode, runId: stage.run.id, snapshotId: stage.candidate.id, inputSummaryHash: hashFoundationPrompt(stage.run.inputSummary!), preparedEvidenceHash: hashFoundationPrompt(JSON.stringify(stage.log)) })),
    files: [...files].map(([name, content]) => ({ name, sha256: hashFoundationPrompt(content) })),
    limits: ["Historical saved inputs/responses, not a new model review or approval.", "Current and candidate rules are not enabled in normal generation.", "BOUND reports a supplied value, not semantic correctness. Legacy free coordinates remain unresolved.", "Private screenplay material; do not commit or share without permission."] };
  return { files, manifest };
}

let createdDirectory: string | undefined;
try {
  const args = parameters(); const prepared = prepare(args);
  mkdirSync(args.out, { mode: 0o700 }); createdDirectory = args.out;
  for (const [name, content] of prepared.files) writeFileSync(path.join(args.out, name), content, { encoding: "utf8", mode: 0o600, flag: "wx" });
  writeFileSync(path.join(args.out, "manifest.json"), JSON.stringify(prepared.manifest, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ mode: "PREPARED_ONLY", providerCalls: 0, cases: prepared.manifest.cases.length, outDir: args.out }));
} catch (error) {
  const reason = error instanceof Error && !("stderr" in error) ? error.message : "读取只读数据库失败。";
  console.error(`准备失败：${reason}${createdDirectory ? ` 未完成目录已保留：${createdDirectory}；不得视作成功材料包。` : " 未创建输出目录。"}`);
  process.exitCode = 1;
}
