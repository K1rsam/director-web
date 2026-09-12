import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FoundationStageRunner } from "@/lib/project-foundation";

// Render the real component; stylesheet compilation is verified by Next/browser checks.
createRequire(import.meta.url).extensions[".css"] = module => { module.exports = {}; };

const scratch = mkdtempSync(path.join(tmpdir(), "foundation-production-"));
const url = `file:${path.join(scratch, "test.db")}`;
process.env.DATABASE_URL = url;
copyFileSync(path.resolve("prisma/schema.prisma"), path.join(scratch, "schema.prisma"));
execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", path.join(scratch, "schema.prisma"), "--skip-generate"], { cwd: scratch, env: { ...process.env, DATABASE_URL: url, RUST_LOG: "info" }, stdio: "pipe" });
const db = new PrismaClient({ datasources: { db: { url } } });

async function main() {
  const { preprocessProject } = await import("@/lib/project-preprocess");
  const { queueProjectFoundationContinuation } = await import("@/lib/project-foundation");
  const { getFoundationState, readApprovedEpisodeFoundation } = await import("@/lib/foundation-state");
  const { buildFoundationExport } = await import("@/lib/foundation-export");
  const { PRODUCTION_OUTPUT_SCHEMAS } = await import("@/lib/foundation-production-prompts");
  const { loadFoundationSystemPrompt } = await import("@/lib/project-foundation-contracts");
  assert.deepEqual(Object.keys(PRODUCTION_OUTPUT_SCHEMAS.F1.episodes[0]), ["number", "summary", "context", "sourceSelections"]);
  assert.deepEqual(Object.keys(PRODUCTION_OUTPUT_SCHEMAS.F2), ["format", "coverage", "assets", "humanChoices"]);
  assert.equal(PRODUCTION_OUTPUT_SCHEMAS.F2.humanChoices[0].kind, "SOURCE_CONFLICT|PRODUCTION_CHOICE");
  assert.equal("description" in PRODUCTION_OUTPUT_SCHEMAS.F2.assets[0], false);
  assert.equal(PRODUCTION_OUTPUT_SCHEMAS.F2.assets[0].key, "已有身份沿registry或previousAssetKeys明确key；新资产必须省略，由程序编号；同名不自动合并。");
  assert.equal(PRODUCTION_OUTPUT_SCHEMAS.F2.assets[0].preparation.mode, "REFERENCE|DERIVE|INLINE|AUDIO|UNRESOLVED");
  assert.equal("verdict" in PRODUCTION_OUTPUT_SCHEMAS.Q1, false); assert.equal("issues" in PRODUCTION_OUTPUT_SCHEMAS.Q1, false);
  assert.match(loadFoundationSystemPrompt("F2"), /婚服/); assert.match(loadFoundationSystemPrompt("F2"), /伤后独臂/);
  assert.match(loadFoundationSystemPrompt("Q1"), /直接把派生资料改好/);
  assert.doesNotMatch(loadFoundationSystemPrompt("Q1"), /只开问题，不代写/);
  const original = [
    { number: 0, title: "婚礼", content: "0-1 礼堂 日 内\r\n李晴穿婚服。婚服原文唯一标记。\r\n李晴：钥匙交给我。  \r\n" },
    { number: 1, title: "伤后", content: "1-1 医院 日 内\n李晴失去左臂，伤后独臂。\n李晴：继续。\n" },
    { number: 2, title: "出院", content: "2-1 门外 日 外\n李晴仍是独臂，穿常服走出医院。\n" }
  ];
  const project = await db.project.create({ data: { title: "__production_first__", executionMode: "CLI", episodes: { create: original } } });
  await preprocessProject(project.id, db);
  const calls: string[] = [];
  const responses = new Map<string, string>();
  const runner: FoundationStageRunner = async (stage, prompt) => {
    const input = JSON.parse(prompt.split("INPUT_JSON:\n").at(-1)!);
    calls.push(stage);
    assert.equal(input.workflow, "PRODUCTION_FOUNDATION_V3", "normal queue must use the production-first contract");
    assert.equal((prompt.match(/婚服原文唯一标记/g) ?? []).length, 1, "each role sees original source once");
    let data: Record<string, unknown>;
    if (stage === "F1") data = { coverage: input.scope, overview: "一位人物经历婚礼及伤后生活。", episodes: input.scope.map((number: number) => ({ number, summary: number === 0 ? "婚礼交接物件。" : "伤后继续生活。" })) };
    else if (stage === "F2") {
      assert.equal("f1" in input, false, "asset extraction must not reread F1 plot restatement");
      const registered = input.registry.find((asset: { name: string }) => asset.name === "李晴");
      const historical = input.previousAssetKeys?.find((asset: { name: string }) => asset.name === "李晴");
      const known = registered ?? historical;
      if (!known) assert.deepEqual(input.registry, [], "首次新资产不能用预置身份绕过程序创建");
      else assert.ok(known.key, "重跑同一身份只能沿 registry 或 previousAssetKeys 明示 key");
      data = { format: "ASSET_CATALOG_V2", coverage: input.scope, assets: [{ ...(known ? { key: known.key } : {}), name: "李晴", type: "CH", episodes: [0, 1, 2], preparation: { mode: "REFERENCE" }, variants: [
        { name: "婚服", episodes: [0], preparation: { mode: "DERIVE" } }, { name: "伤后独臂", episodes: [1, 2], note: "左臂缺失；常服由人工设计。", preparation: { mode: "DERIVE" } }
      ] }] };
    } else {
      assert.equal("episodePackets" in input, false, "Q1 does not receive a duplicate source packet");
      assert.equal("source" in input.candidates.f2, false);
      assert.equal(JSON.stringify(input.candidates).includes("appearances"), false);
      const liqing = input.candidates.f2.assets.find((asset: { name: string }) => asset.name === "李晴");
      assert.ok(liqing?.key, "Q1 本片候选应携带程序创建的新资产 key");
      data = { format: "FOUNDATION_OPTIMIZATION_V2", coverage: input.scope, summary: "补齐婚礼关键道具，明确本集交接。", changes: {
        episodes: [{ number: 0, summary: "李晴在婚礼上接过钥匙。" }],
        assets: [{ name: "钥匙", type: "PROP", episodes: [0], preparation: { mode: "REFERENCE" } }]
      }, notes: ["常服的具体设计由人工确定。"] };
    }
    responses.set(stage, JSON.stringify(data));
    return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic-provider", stderr: "" };
  };
  await queueProjectFoundationContinuation(project.id, { db, stageRunner: runner });
  assert.deepEqual(calls, ["F1", "F2", "Q1"], "Q1 fixes in its own response, without re-running an author");
  const state = await getFoundationState(project.id, db);
  assert.equal(state.ready, true); assert.equal(state.draftComplete, true);
  const optimized = (state as typeof state & { finalOutput?: { f1: { episodes: Array<{number:number;summary:string}> }; f2: { assets: Array<{key:string;variants?:Array<{name:string;episodes:number[]}>}> } } }).finalOutput;
  assert.ok(optimized, "current Q1 result must expose a complete corrected final output");
  assert.equal(optimized.f1.episodes[0].summary, "李晴在婚礼上接过钥匙。");
  const liqingKey = optimized.f2.assets.find((asset) => asset.name === "李晴")!.key;
  assert.ok(optimized.f2.assets.some((asset) => asset.name === "钥匙"));
  assert.deepEqual(optimized.f2.assets.find((asset) => asset.key === liqingKey)!.variants!.map((variant) => [variant.name, variant.episodes]), [["婚服", [0]], ["伤后独臂", [1, 2]]]);
  assert.equal(optimized.f2.assets.find((asset) => asset.key === liqingKey)!.variants![0]!.preparation?.fromKey, liqingKey, "DERIVE 变体未给 fromKey 时必须自动绑定父资产");
  assert.equal(state.candidates.f1!.output.episodes[0].summary, "婚礼交接物件。", "author snapshot is not overwritten by Q1");
  assert.equal(state.candidates.f2!.output.assets.some((asset) => asset.key === "key"), false);
  const packet = await readApprovedEpisodeFoundation(project.id, 0, db);
  assert.ok(packet.f1Context.includes("李晴在婚礼上接过钥匙。"));
  assert.ok(packet.identities.some((asset) => asset.name === "钥匙"));
  assert.ok(JSON.stringify(packet.identities).includes("婚服"));
  assert.equal(JSON.stringify(packet.identities).includes("伤后独臂"), false, "later variant is not sent as the current episode's reference");
  const exported = await buildFoundationExport(project.id, db);
  assert.deepEqual((exported as typeof exported & { finalOutput?: unknown }).finalOutput, optimized, "export and page share the corrected data");
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { FoundationViewer } = await import("@/app/projects/[projectId]/foundation-viewer");
  const html = renderToStaticMarkup(createElement(FoundationViewer, { state }));
  assert.ok(html.includes("资产目录与必要变体"));
  assert.ok(html.includes("Q1已完成最终优化"));
  assert.ok(html.includes("李晴在婚礼上接过钥匙。") && html.includes("伤后独臂"));
  assert.equal(html.includes("Q1 原始结论"), false, "new result is not a review-gate report");
  const storedAssets = await db.asset.findMany({ where: { projectId: project.id } });
  assert.ok(storedAssets.some((asset) => asset.name === "钥匙"));
  assert.ok(storedAssets.some((asset) => asset.metadata?.includes("伤后独臂")));
  const baseAsset = storedAssets.find((asset) => asset.name === "李晴")!;
  assert.equal(storedAssets.filter((asset) => asset.parentId === baseAsset.id).length, 2, "necessary variants have separate stable asset records for image binding");
  const savedSource = await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" }, select: { number: true, title: true, content: true } });
  assert.deepEqual(savedSource, original);
  const runs = await db.pipelineRun.findMany({ where: { projectId: project.id, stageCode: { in: ["F1", "F2", "Q1"] } } });
  for (const run of runs) {
    const log = JSON.parse(run.log!);
    assert.equal(log.calls.length, 1);
    assert.equal(log.calls[0].response.rawOutput, responses.get(run.stageCode));
    assert.equal(log.calls[0].providerCallCount, 1);
  }
  const f2Raw = JSON.parse(JSON.parse(runs.find((run) => run.stageCode === "F2")!.log!).calls[0].response.rawOutput);
  assert.equal("key" in f2Raw.assets[0], false, "作者不得伪造 canonical key 绕过新资产创建");
  const again = await queueProjectFoundationContinuation(project.id, { db, stageRunner: runner });
  assert.deepEqual(again.stageCodes, []); assert.equal(calls.length, 3);
  console.log("PASS normal compact queue, Q1 direct edits, variants, final publication/export, immutable originals and no extra calls");

  const longSource = original.map((episode) => ({ ...episode, content: `${episode.content}\n${"原文".repeat(12_501)}` }));
  const multi = await db.project.create({ data: { title: "__production_resume__", executionMode: "CLI", episodes: { create: longSource } } });
  await preprocessProject(multi.id, db);
  let failOnce = true;
  const sequences: string[] = [];
  const multiRunner: FoundationStageRunner = async (stage, prompt) => {
    const input = JSON.parse(prompt.split("INPUT_JSON:\n").at(-1)!);
    const number = input.scope[0]; sequences.push(`${stage}:${number}`);
    assert.equal(input.scope.length, 1);
    if (stage === "F2" && number === 1 && failOnce) { failOnce = false; throw Object.assign(new Error("synthetic transport failure"), { requestOutcome: "NOT_SENT" as const }); }
    let data: Record<string, unknown>;
    if (stage === "F1") data = { coverage: input.scope, overview: `第${number}片概述`, episodes: [{ number, summary: `第${number}集导航` }] };
    else if (stage === "F2") {
      const registered = input.registry.find((asset: { name: string }) => asset.name === "李晴");
      const historical = input.previousAssetKeys?.find((asset: { name: string }) => asset.name === "李晴");
      const known = registered ?? historical;
      if (number === 0) assert.equal(known, undefined, "首批不能先 seed 假既有身份");
      else assert.ok(known?.key, "后续批次只能从 registry 或 previousAssetKeys 明示已知 key");
      data = { format: "ASSET_CATALOG_V2", coverage: input.scope, assets: [{ ...(known ? { key: known.key } : {}), name: number === 2 ? "小晴" : "李晴", type: number === 2 ? "GROUP" : "CH", episodes: [number], preparation: { mode: "REFERENCE" },
        variants: [{ name: number === 0 ? "婚服" : number === 1 ? "伤后独臂" : "独臂常服", episodes: [number], ...(number === 0 ? {} : { note: "左臂缺失" }), preparation: { mode: "DERIVE" } }] }] };
    }
    else {
      assert.equal("episodePackets" in input, false);
      if (number === 2) {
        const candidate = input.candidates.f2.assets.find((asset: { name: string }) => asset.name === "小晴");
        assert.ok(candidate?.key, "本片名称/type 应从 candidate 提供给 Q1");
        assert.equal(input.registry.some((asset: { key: string }) => asset.key === candidate.key), false, "Q1 registry 不重发本片基础详情");
        const variants = input.crossBatchVariants.find((item: { assetKey: string }) => item.assetKey === candidate.key)?.variants ?? [];
        assert.ok(variants.some((variant: { name: string }) => variant.name === "伤后独臂"), "跨批变体仅走 crossBatchVariants");
      }
      const local = input.candidates.f2.assets.find((asset: { name: string }) => number === 2 ? asset.name === "小晴" : asset.name === "李晴");
      data = { format: "FOUNDATION_OPTIMIZATION_V2", coverage: input.scope, changes: number === 0 ? { overview: "第0片已优化概述", episodes: [{ number: 0, summary: "婚礼交接钥匙" }], assets: [{ name: "钥匙", type: "PROP", episodes: [0], preparation: { mode: "REFERENCE" } }] }
        : number === 2 ? { assets: [{ key: local.key, name: "李晴", type: "CH", episodes: [2], preparation: { mode: "REFERENCE" }, variants: [{ name: "伤后独臂", episodes: [2], note: "左臂缺失", preparation: { mode: "DERIVE" } }] }] } : {} };
    }
    return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic-multi", stderr: "" };
  };
  await assert.rejects(queueProjectFoundationContinuation(multi.id, { db, stageRunner: multiRunner }), /synthetic transport failure/);
  const beforeResume = await getFoundationState(multi.id, db);
  assert.equal(beforeResume.f2Recovery?.resumeChunkCount, 1);
  assert.equal(beforeResume.f2Recovery?.totalChunks, 3);
  const f1Before = await db.sceneSnapshot.findUniqueOrThrow({ where: { id: beforeResume.candidates.f1!.id } });
  const failedBefore = await db.pipelineRun.findUniqueOrThrow({ where: { id: beforeResume.latestRuns.f2!.id } });
  const restored = await queueProjectFoundationContinuation(multi.id, { db, stageRunner: multiRunner });
  assert.deepEqual(restored.stageCodes, ["F2", "Q1"]);
  assert.deepEqual(sequences, ["F1:0", "F1:1", "F1:2", "F2:0", "F2:1", "F2:1", "F2:2", "Q1:0", "Q1:1", "Q1:2"]);
  const multiState = await getFoundationState(multi.id, db);
  assert.equal(multiState.ready, true);
  assert.deepEqual(multiState.finalOutput!.f1.overview.split("\n\n"), ["第0片已优化概述", "第1片概述", "第2片概述"]);
  const multiLiqing = multiState.finalOutput!.f2.assets.find((asset) => asset.name === "李晴")!;
  assert.deepEqual(multiLiqing.variants.map((variant) => [variant.name, variant.episodes]), [["婚服", [0]], ["伤后独臂", [1, 2]]]);
  assert.ok(multiState.finalOutput!.f2.assets.some((asset) => asset.name === "钥匙"));
  assert.equal(multiState.candidates.f2!.output.assets.find((asset) => asset.name === "小晴")!.type, "GROUP");
  assert.equal(multiLiqing.type, "CH", "Q1 directly finalizes candidate classification");
  assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({ where: { id: f1Before.id } }), f1Before);
  assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({ where: { id: failedBefore.id } }), failedBefore);
  const finalRun = await db.pipelineRun.findUniqueOrThrow({ where: { id: multiState.latestRuns.f2!.id } });
  assert.deepEqual(JSON.parse(finalRun.log!).calls.map((call: {providerCallCount:number}) => call.providerCallCount), [0, 1, 1]);
  assert.deepEqual(await db.episode.findMany({ where: { projectId: multi.id }, orderBy: { number: "asc" }, select: { number: true, title: true, content: true } }), longSource);
  console.log("PASS 25k single-episode chunks resume preserves F1/paid prefix and source; evolving names/classification reach Q1 for direct finalization");

  await db.asset.update({ where: { id: baseAsset.id }, data: { notes: "user-image-binding-note", sourceText: "user-manual-base-design", status: "confirmed" } });
  const protectedChild = storedAssets.find((asset) => asset.parentId === baseAsset.id)!;
  await db.asset.update({ where: { id: protectedChild.id }, data: { notes: "user-variant-image-note", sourceText: "user-manual-variant-design", status: "confirmed" } });
  await db.project.update({ where: { id: project.id }, data: { title: "__production_classification_correction__" } });
  await queueProjectFoundationContinuation(project.id, { db, stageRunner: async (stage, prompt, call) => {
    if (stage !== "Q1") return runner(stage, prompt, call);
    const input = JSON.parse(prompt.split("INPUT_JSON:\n").at(-1)!);
    const known = input.candidates.f2.assets.find((asset: { name: string }) => asset.name === "李晴");
    assert.ok(known?.key, "Q1 分类修正必须从本片 candidate 按名称取得已知 key");
    const data = { format: "FOUNDATION_OPTIMIZATION_V2", coverage: [0, 1, 2], changes: { assets: [{ key: known.key, name: "李晴", type: "GROUP", episodes: [0, 1, 2], preparation: { mode: "REFERENCE" } }] } };
    return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: "synthetic-type-correction", stderr: "" };
  } });
  const reclassified = await db.asset.findUniqueOrThrow({ where: { id: baseAsset.id } });
  const reclassifiedChild = await db.asset.findUniqueOrThrow({ where: { id: protectedChild.id } });
  assert.equal(reclassified.type, "GROUP"); assert.equal(reclassified.code, baseAsset.code); assert.equal(reclassified.notes, "user-image-binding-note"); assert.equal(reclassified.status, "confirmed");
  assert.equal(reclassifiedChild.type, "GROUP"); assert.equal(reclassifiedChild.code, protectedChild.code); assert.equal(reclassifiedChild.notes, "user-variant-image-note"); assert.equal(reclassifiedChild.status, "confirmed");
  assert.equal(reclassified.sourceText, "user-manual-base-design"); assert.equal(reclassifiedChild.sourceText, "user-manual-variant-design");
  assert.equal((await getFoundationState(project.id, db)).ready, true);
  console.log("PASS Q1 can correct a published classification without losing stable IDs/codes or user image notes/status");
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(async () => { await db.$disconnect(); const { prisma } = await import("@/lib/prisma"); await prisma.$disconnect(); rmSync(scratch, { recursive: true, force: true }); });
