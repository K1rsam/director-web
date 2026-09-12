import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { Asset, Prisma, PrismaClient } from "@prisma/client";
import type { ProductionCatalog } from "@/lib/foundation-production-contracts";
import type { FoundationStageRunner } from "@/lib/project-foundation";

type SavedCall = { scope: number[]; sourceVersion: string; response?: { data: Record<string, unknown>; rawOutput?: string; stdout: string; stderr: string; sessionId: string | null } };
type SavedRun = { id: string; projectId: string; stageCode: string; log: string; inputSummary: string | null };
type Evidence = { sourceVersion: string; calls: SavedCall[] };
type Episode = { id: string; number: number; title: string | null; content: string };
type Repair = { id: string; code: string; assetKey: string; variantKey: string; episodes: number[]; assetEpisodes: number[]; variantEpisodes: number[] };
type Catalog = ProductionCatalog & { repairItems?: Repair[] };
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

async function main() {
  const args = process.argv.slice(2), supported = new Set(["--source-db", "--project-id", "--f2-run-id", "--f1-run-id"]);
  if (!args.length || args.includes("--help")) {
    console.log("Usage: tsx scripts/verify-foundation-catalog-saved-replay.ts --source-db /absolute/source.db --project-id ID --f2-run-id ID [--f1-run-id ID]");
    console.log("No defaults. Source reads use sqlite3 -readonly. Optional F1 replays the untouched responses in a disposable database with a fake runner; no model call.");
    return;
  }
  assert.equal(args.length % 2, 0, "arguments must be flag/value pairs");
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(supported.has(args[i]) && !values.has(args[i]) && args[i + 1], "unknown, duplicate or missing argument");
    values.set(args[i], args[i + 1]);
  }
  const sourceDb = values.get("--source-db"), projectId = values.get("--project-id"), f2Id = values.get("--f2-run-id"), f1Id = values.get("--f1-run-id");
  assert.ok(sourceDb && path.isAbsolute(sourceDb) && statSync(sourceDb).isFile(), "--source-db must be an existing absolute regular-file path");
  assert.ok(projectId && f2Id, "explicit project and F2 run IDs are required");
  const read = <T,>(sql: string): T[] => JSON.parse(execFileSync("sqlite3", ["-readonly", "-json", sourceDb, sql], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 60_000 }) || "[]");
  const episodeSql = `SELECT id,number,title,content FROM Episode WHERE projectId=${quote(projectId)} ORDER BY number;`;
  const readRun = (id: string): SavedRun | undefined => {
    const where = `WHERE id=${quote(id)} AND projectId=${quote(projectId)}`;
    const row = read<Omit<SavedRun, "log">>(`SELECT id,projectId,stageCode,inputSummary FROM PipelineRun ${where};`)[0];
    if (!row) return undefined;
    // Avoid sqlite CLI's expensive second JSON-escaping pass over an already-JSON log.
    const log = execFileSync("sqlite3", ["-readonly", "-noheader", sourceDb, `SELECT log FROM PipelineRun ${where};`], { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 60_000 }).replace(/\r?\n$/, "");
    return { ...row, log };
  };
  const episodes = read<Episode>(episodeSql), run = readRun(f2Id);
  assert.ok(run && run.stageCode === "F2" && run.log, "specified F2 evidence does not exist in this project");
  const saved = JSON.parse(run.log) as Evidence;
  const { buildSourceIndex } = await import("@/lib/project-foundation-contracts");
  const index = buildSourceIndex(episodes);
  assert.equal(index.version, saved.sourceVersion, "saved F2 source version no longer matches the exact current source");
  assert.ok(Array.isArray(saved.calls) && saved.calls.length, "no saved calls to replay");
  const originalFingerprint = fingerprint({ episodes, run });
  const { requireProductionCatalogAuthor, mergeProductionCatalogs } = await import("@/lib/foundation-production-contracts");
  const parts: Catalog[] = [], summaries: Array<Record<string, unknown>> = [];
  for (const [i, call] of saved.calls.entries()) {
    assert.equal(call.sourceVersion, index.version, `call ${i + 1} source version mismatch`);
    assert.ok(call.response?.data, `call ${i + 1} has no complete saved response`);
    const responseBefore = structuredClone(call.response);
    const prior = parts.length ? mergeProductionCatalogs(parts, index, parts.flatMap(part => part.coverage)).assets : [];
    const part = requireProductionCatalogAuthor(call.response.data, index, call.scope, prior) as Catalog;
    assert.ok(isDeepStrictEqual(call.response, responseBefore), `call ${i + 1} raw response was mutated`);
    const rawAssets = call.response.data.assets as Array<{ key?: string; name: string; episodes: number[]; preparation?: { mode: string; fromKey?: string }; variants?: Array<{ name: string; episodes: number[] }> }>;
    const normalizedScope = (scope: number[]) => [...new Set(scope.map(Number))].sort((a, b) => a - b);
    for (const item of part.repairItems ?? []) {
      const assetIndex = part.assets.findIndex(asset => asset.key === item.assetKey), asset = part.assets[assetIndex];
      const variant = asset?.variants.find(entry => entry.key === item.variantKey);
      const originalAsset = rawAssets[assetIndex], originalVariant = originalAsset?.variants?.find(entry => entry.name === variant?.name);
      assert.ok(originalAsset && originalVariant, "repair must point to a real original asset/variant, not an invented record");
      assert.ok(isDeepStrictEqual(item.assetEpisodes, normalizedScope(originalAsset.episodes)), "repair must retain the original parent scope");
      assert.ok(isDeepStrictEqual(item.variantEpisodes, normalizedScope(originalVariant.episodes)), "repair must retain the original child scope");
    }
    const explicitSelf = rawAssets.filter(asset => asset.key && asset.preparation?.mode === "DERIVE" && asset.preparation.fromKey === asset.key);
    for (const item of explicitSelf) {
      const original = prior.find(asset => asset.key === item.key) as ProductionCatalog["assets"][number] | undefined;
      const received = part.assets.find(asset => asset.key === item.key);
      assert.ok(original && received, "self-reuse must refer to an existing exact identity");
      assert.equal(received.preparation?.mode, original.preparation?.mode, "existing self-reuse must inherit the actual prior preparation");
      assert.equal(received.preparation?.fromKey, original.preparation?.fromKey);
    }
    parts.push(part);
    summaries.push({ call: i + 1, scope: [call.scope[0], call.scope.at(-1)], assets: part.assets.length, variants: part.assets.reduce((sum, asset) => sum + asset.variants.length, 0), selfReuse: explicitSelf.length, repairs: part.repairItems?.map(item => ({ code: item.code, episodes: item.episodes, assetEpisodes: item.assetEpisodes, variantEpisodes: item.variantEpisodes })) ?? [] });
  }
  const merged = mergeProductionCatalogs(parts, index, index.episodes.map(episode => episode.number)) as Catalog;
  const unresolved = merged.assets.flatMap(asset => [asset, ...asset.variants]).filter(item => item.preparation?.mode === "UNRESOLVED").length;
  assert.equal(fingerprint({ episodes: read<Episode>(episodeSql), run: readRun(f2Id) }), originalFingerprint, "source rows or stored evidence changed during read-only replay");
  console.log(JSON.stringify({ check: "offline-original-response-receipt", sourceVersion: index.version, calls: summaries, merged: { assets: merged.assets.length, variants: merged.assets.reduce((sum, asset) => sum + asset.variants.length, 0), repairs: merged.repairItems?.length ?? 0, unresolvedPreparation: unresolved }, realModelCalls: 0 }));
  if (!f1Id) return;

  const f1 = readRun(f1Id);
  assert.ok(f1 && f1.stageCode === "F1" && f1.log, "specified F1 evidence does not exist in this project");
  const f1Saved = JSON.parse(f1.log) as Evidence;
  assert.equal(f1Saved.sourceVersion, index.version, "saved F1 source version mismatch");
  assert.ok(f1Saved.calls.every(call => call.response?.data), "F1 replay requires every original complete response");
  assert.ok(saved.calls.some(call => Array.isArray(call.response!.data.humanChoices) && call.response!.data.humanChoices.length), "full-chain replay requires the original pending human choice to stop before Q1; do not delete or invent one");
  const sourceProject = read<{ id: string; title: string; description: string | null; style: string | null; aspectRatio: string; executionMode: string; ruleVersion: string }>(`SELECT id,title,description,style,aspectRatio,executionMode,ruleVersion FROM Project WHERE id=${quote(projectId)};`)[0];
  assert.ok(sourceProject);
  const sourceImports = read<{ id: string; title: string | null; content: string; metadata: string | null }>(`SELECT id,title,content,metadata FROM SceneSnapshot WHERE projectId=${quote(projectId)} AND sceneKey='SOURCE_IMPORT' ORDER BY createdAt DESC,id DESC LIMIT 1;`);
  const assetSql = `SELECT id,projectId,episodeId,code,type,name,status,sourceText,notes,metadata,parentId,firstSeenNode FROM Asset WHERE projectId=${quote(projectId)} ORDER BY id;`;
  const sourceAssets = read<Prisma.AssetCreateManyInput>(assetSql);
  const sourceChoices = read<Prisma.PresentationContractCreateManyInput>(`SELECT id,projectId,episodeId,category,question,options,evidence,userAnswer,status,round,note FROM PresentationContract WHERE projectId=${quote(projectId)} ORDER BY id;`);
  const sourceBefore = fingerprint({ episodes, run, f1, sourceProject, sourceImports, sourceAssets, sourceChoices });
  const scratch = mkdtempSync(path.join(tmpdir(), "foundation-saved-replay-"));
  let db: PrismaClient | undefined;
  try {
    const url = `file:${path.join(scratch, "isolated.db")}`;
    process.env.DATABASE_URL = url;
    copyFileSync(path.resolve("prisma/schema.prisma"), path.join(scratch, "schema.prisma"));
    execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", path.join(scratch, "schema.prisma"), "--skip-generate"], { cwd: scratch, env: { ...process.env, DATABASE_URL: url, RUST_LOG: "info" }, stdio: "pipe" });
    const { PrismaClient } = await import("@prisma/client");
    db = new PrismaClient({ datasourceUrl: url });
    (globalThis as unknown as { prisma: PrismaClient }).prisma = db;
    await db.project.create({ data: sourceProject });
    await db.episode.createMany({ data: episodes.map(episode => ({ ...episode, projectId })) });
    for (const row of sourceImports) await db.sceneSnapshot.create({ data: { ...row, projectId, sceneKey: "SOURCE_IMPORT" } });
    if (sourceAssets.length) await db.asset.createMany({ data: sourceAssets });
    if (sourceChoices.length) await db.presentationContract.createMany({ data: sourceChoices });
    const { preprocessProject } = await import("@/lib/project-preprocess");
    const { queueProjectFoundationContinuation } = await import("@/lib/project-foundation");
    const { getFoundationState } = await import("@/lib/foundation-state");
    await preprocessProject(projectId, db);
    const replayCalls: string[] = [];
    const fakeRunner: FoundationStageRunner = async (stage, _prompt, context) => {
      assert.notEqual(stage, "Q1", "untouched original F2 human decision must pause Q1");
      const call = (stage === "F1" ? f1Saved : saved).calls[context.chunkIndex - 1];
      assert.ok(call?.response);
      assert.ok(isDeepStrictEqual(context.scope, call.scope), "current batching differs from original saved response scope; replay must not pre-edit data");
      replayCalls.push(`${stage}:${context.chunkIndex}`);
      return structuredClone(call.response);
    };
    await queueProjectFoundationContinuation(projectId, { db, stageRunner: fakeRunner });
    const copiedF2 = await db.pipelineRun.findFirstOrThrow({ where: { projectId, stageCode: "F2" }, orderBy: { createdAt: "desc" } });
    assert.equal(copiedF2.status, "SUCCEEDED", "the real untouched saved catalog must become a readable candidate");
    const newEvidence = JSON.parse(copiedF2.log!) as Evidence;
    assert.equal(newEvidence.calls.length, saved.calls.length);
    for (const [i, call] of newEvidence.calls.entries()) assert.ok(isDeepStrictEqual(call.response, saved.calls[i].response), `saved F2 call ${i + 1} was modified inside fake replay`);
    const copiedF1 = await db.pipelineRun.findFirstOrThrow({ where: { projectId, stageCode: "F1" }, orderBy: { createdAt: "desc" } });
    const newF1Evidence = JSON.parse(copiedF1.log!) as Evidence;
    assert.equal(newF1Evidence.calls.length, f1Saved.calls.length);
    for (const [i, call] of newF1Evidence.calls.entries()) assert.ok(isDeepStrictEqual(call.response, f1Saved.calls[i].response), `saved F1 call ${i + 1} was modified inside fake replay`);
    assert.ok(isDeepStrictEqual(await db.episode.findMany({ where: { projectId }, select: { id: true, number: true, title: true, content: true }, orderBy: { number: "asc" } }), episodes), "isolated business chain must not edit the copied original script");
    for (const asset of sourceAssets) {
      const actual: Asset = await db.asset.findUniqueOrThrow({ where: { id: asset.id! } });
      assert.ok(Object.entries(asset).every(([key, value]) => isDeepStrictEqual(actual[key as keyof Asset], value)), "isolated replay must retain existing asset identifiers and user metadata");
    }
    const state = await getFoundationState(projectId, db);
    assert.equal(state.ready, false);
    assert.equal(await db.pipelineRun.count({ where: { projectId, status: { in: ["QUEUED", "RUNNING"] } } }), 0);
    assert.equal(await db.sceneSnapshot.count({ where: { projectId, sceneKey: "FOUNDATION_APPROVED" } }), 0);
    const pendingChoices = await db.presentationContract.count({ where: { projectId, status: "PENDING" } });
    assert.ok(pendingChoices > 0, "original human choice remains necessary; no fake auto-confirmation");
    console.log(JSON.stringify({ check: "isolated-original-response-business-chain", replayCalls, f2Status: copiedF2.status, pendingChoices, repairs: (state.candidates.f2?.output as Catalog).repairItems?.length ?? 0, approved: false, realModelCalls: 0 }));
  } finally {
    await db?.$disconnect(); rmSync(scratch, { recursive: true, force: true });
  }
  const sourceAfter = fingerprint({ episodes: read<Episode>(episodeSql), run: readRun(f2Id), f1: readRun(f1Id),
    sourceProject: read(`SELECT id,title,description,style,aspectRatio,executionMode,ruleVersion FROM Project WHERE id=${quote(projectId)};`)[0],
    sourceImports: read(`SELECT id,title,content,metadata FROM SceneSnapshot WHERE projectId=${quote(projectId)} AND sceneKey='SOURCE_IMPORT' ORDER BY createdAt DESC,id DESC LIMIT 1;`),
    sourceAssets: read(assetSql),
    sourceChoices: read(`SELECT id,projectId,episodeId,category,question,options,evidence,userAnswer,status,round,note FROM PresentationContract WHERE projectId=${quote(projectId)} ORDER BY id;`) });
  assert.equal(sourceAfter, sourceBefore, "read-only source rows must remain byte-equivalent after isolated replay");
  console.log("PASS selected source rows unchanged; real LLM generation was not run");
}
main().catch(error => { console.error(`${error instanceof Error ? error.name : "ReplayError"}: ${error instanceof Error ? error.message.slice(0, 1200) : "replay failed"}`); process.exitCode = 1; });
