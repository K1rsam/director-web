import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import type { FoundationStageRunner } from "@/lib/project-foundation";
import type { ProductionCatalog } from "@/lib/foundation-production-contracts";

// Only synthetic source and an explicitly injected fake provider touch this disposable SQLite database.
const directory = mkdtempSync(path.join(tmpdir(), "foundation-catalog-repair-"));
const url = `file:${path.join(directory, "test.db")}`;
process.env.DATABASE_URL = url;
copyFileSync(path.resolve("prisma/schema.prisma"), path.join(directory, "schema.prisma"));
execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", path.join(directory, "schema.prisma"), "--skip-generate"], { cwd: directory, env: { ...process.env, DATABASE_URL: url, RUST_LOG: "info" }, stdio: "pipe" });
const db = new PrismaClient({ datasourceUrl: url });
(globalThis as unknown as { prisma: PrismaClient }).prisma = db;
type RepairItem = { id: string; code: string; assetKey: string; variantKey: string; episodes: number[]; assetEpisodes: number[]; variantEpisodes: number[] };
type QInput = { scope: number[]; candidates: { f2: { assets: Array<{ key: string; name: string; type: string; episodes: number[]; variants: Array<{ key: string; name: string; episodes: number[] }> }>; repairItems?: RepairItem[] } }; registry?: Array<{ key: string; name: string }> };
const parse = (prompt: string): QInput => JSON.parse(prompt.slice(prompt.lastIndexOf("INPUT_JSON:\n") + "INPUT_JSON:\n".length));

async function main() {
  const { preprocessProject } = await import("@/lib/project-preprocess");
  const runtime = await import("@/lib/project-foundation");
  const stateApi = await import("@/lib/foundation-state");
  const contracts = await import("@/lib/foundation-production-contracts");
  const sourceContracts = await import("@/lib/project-foundation-contracts");
  const source = [0, 1].map(number => ({ number, title: `第${number}集`, content: `${number}-1\n铜镜与镜面裂纹、桌椅都在原文中。  \n` }));
  async function scenario(mode: "fix" | "empty" | "id-only" | "unrelated" | "human", emptyParent = false) {
    const project = await db.project.create({ data: { title: `__catalog_repair_${mode}__`, executionMode: "API", episodes: { create: source } } });
    const userAsset = await db.asset.create({ data: { projectId: project.id, code: "PROP-090", type: "PROP", name: "手工独立资产", metadata: JSON.stringify({ userLabel: "不得覆盖" }) } });
    await preprocessProject(project.id, db);
    const calls: string[] = [], raw = new Map<string, string>();
    const runner: FoundationStageRunner = async (stage, prompt) => {
      calls.push(stage); const input = parse(prompt); let data: Record<string, unknown>;
      if (stage === "F1") data = { coverage: input.scope, overview: "铜镜出现裂纹", episodes: input.scope.map(number => ({ number, summary: "镜面裂纹延续" })) };
      else if (stage === "F2") data = { format: "ASSET_CATALOG_V2", coverage: input.scope, assets: [
        { name: "铜镜", type: "PROP", episodes: emptyParent ? [] : [0], preparation: { mode: "REFERENCE" }, variants: [{ name: "裂纹", episodes: [0, 1], preparation: { mode: "DERIVE" } }] },
        { name: "桌椅", type: "PROP", episodes: [0, 1], preparation: { mode: "REFERENCE" }, variants: [{ name: "铺布", episodes: [1], preparation: { mode: "DERIVE" } }] }
      ], ...(mode === "human" ? { humanChoices: [{ decisionKey: "production/铜镜/reference", kind: "PRODUCTION_CHOICE", question: "采用哪种合法参考？", reason: "用户持有的授权素材没有提供。", options: ["提供自有素材", "重新制作"], recommended: "重新制作", recommendationReason: "当前尚无素材清单。", evidence: "需要用户决定授权来源。", episodes: [] }] } : {}) };
      else {
        const repair = input.candidates.f2.repairItems?.[0];
        assert.ok(repair, "Q1 must receive the program-generated repair with original parent/variant scopes");
        assert.equal(repair.code, "VARIANT_SCOPE");
        assert.deepEqual(repair.assetEpisodes, emptyParent ? [] : [0]);
        assert.deepEqual(repair.variantEpisodes, [0, 1]);
        const mirror = input.candidates.f2.assets.find(asset => asset.name === "铜镜")!;
        const desk = input.candidates.f2.assets.find(asset => asset.name === "桌椅")!;
        const changes = mode === "fix" ? { assets: [{ key: mirror.key, name: "铜镜", type: "PROP", episodes: [0, 1] }] }
          : mode === "unrelated" ? { assets: [{ key: desk.key, name: "桌椅", type: "PROP", episodes: [0, 1] }] } : {};
        data = { format: "FOUNDATION_OPTIMIZATION_V2", coverage: input.scope, changes, ...(mode !== "empty" ? { resolvedCatalogIssues: [repair.id] } : {}) };
      }
      const text = JSON.stringify(data); raw.set(stage, text);
      return { data, rawOutput: text, stdout: `synthetic-${stage}`, stderr: "", sessionId: null };
    };
    await runtime.queueProjectFoundationContinuation(project.id, { db, stageRunner: runner });
    const f2 = await db.pipelineRun.findFirstOrThrow({ where: { projectId: project.id, stageCode: "F2" } });
    assert.equal(f2.status, "SUCCEEDED", "batch-local parent/variant contradiction must preserve a successful candidate, not fail F2");
    const evidence = JSON.parse(f2.log!);
    assert.equal(evidence.calls[0].response.rawOutput, raw.get("F2"));
    assert.equal(JSON.stringify(evidence.calls[0].response.data), raw.get("F2"), "raw scopes/preparation must not be pre-repaired");
    const state = await stateApi.getFoundationState(project.id, db);
    const catalog = state.candidates.f2!.output as ProductionCatalog & { repairItems?: RepairItem[] };
    assert.equal(catalog.repairItems?.length, 1);
    assert.ok(catalog.assets.find(asset => asset.name === "桌椅"));
    assert.equal(await db.presentationContract.count({ where: { projectId: project.id } }), mode === "human" ? 1 : 0, "program repair issues are not human questions");
    assert.deepEqual(calls, mode === "human" ? ["F1", "F2"] : ["F1", "F2", "Q1"]);
    assert.equal(state.ready, mode === "fix");
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: project.id, sceneKey: "FOUNDATION_APPROVED" } }), mode === "fix" ? 1 : 0);
    if (mode !== "human") assert.equal((await db.pipelineRun.findFirstOrThrow({ where: { projectId: project.id, stageCode: "Q1" } })).status, "SUCCEEDED");
    if (mode !== "human" && mode !== "fix") assert.equal(state.review?.output.verdict, "REPAIR", "unfixed catalog stays a readable REPAIR draft, not a false READY or model failure");
    if (mode === "fix") {
      const originalMirror = catalog.assets.find(asset => asset.name === "铜镜")!;
      const finalMirror = state.finalOutput!.f2.assets.find(asset => asset.name === "铜镜")!;
      assert.equal(finalMirror.key, originalMirror.key); assert.equal(finalMirror.variants[0].key, originalMirror.variants[0].key);
      assert.equal(state.finalOutput!.f2.assets.find(asset => asset.name === "桌椅")!.variants[0].name, "铺布", "unrelated legitimate variant survives localized repair");
    }
    const episodes = await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: "asc" } });
    assert.deepEqual(episodes.map(({ number, title, content }) => ({ number, title, content })), source);
    assert.deepEqual(await db.asset.findUniqueOrThrow({ where: { id: userAsset.id } }), userAsset, "unrelated user metadata and asset ID/code remain unchanged");
    console.log(`PASS isolated chain ${mode}${emptyParent ? " empty-parent" : ""}`);
  }
  await scenario("fix");
  await scenario("fix", true);
  for (const mode of ["empty", "id-only", "unrelated", "human"] as const) await scenario(mode);
  const index = sourceContracts.buildSourceIndex([0, 1, 2].map(number => ({ number, title: null, content: `第${number}集原文` })));
  const author = (value: unknown, scope: number[], prior: ProductionCatalog["assets"] = []) => contracts.requireProductionCatalogAuthor(value, index, scope, prior) as ProductionCatalog & { repairItems?: RepairItem[] };
  const wire = (episodes = [0], variantEpisodes = [0, 1]) => ({ format: "ASSET_CATALOG_V2", coverage: [0, 1, 2], assets: [
    { name: "铜镜", type: "PROP", episodes, preparation: { mode: "REFERENCE" }, variants: [{ name: "裂纹", episodes: variantEpisodes, preparation: { mode: "DERIVE" } }] },
    { name: "桌椅", type: "PROP", episodes: [0, 1, 2], preparation: { mode: "REFERENCE" } }
  ] });
  const raw = wire(), rawBefore = structuredClone(raw);
  const pending = author(raw, [0, 1, 2]);
  assert.deepEqual(raw, rawBefore);
  assert.equal(pending.repairItems?.length, 1);
  const repair = pending.repairItems![0], mirror = pending.assets[0], desk = pending.assets[1];
  assert.deepEqual(repair.episodes, [1]); assert.deepEqual(repair.assetEpisodes, [0]); assert.deepEqual(repair.variantEpisodes, [0, 1]);
  assert.equal(author({ ...raw, repairItems: [] }, [0, 1, 2]).repairItems?.length, 1, "author cannot erase a program-owned repair marker");
  assert.throws(() => author({ ...wire([0], [0, 3]) }, [0, 1, 2]), /范围|集号/);
  assert.throws(() => author({ ...wire(), assets: [{ ...wire().assets[0], key: "unknown-existing-key" }] }, [0, 1, 2]), /未知/);
  const f1 = sourceContracts.requireF1Output({ coverage: [0, 1, 2], overview: "合成概述", episodes: [0, 1, 2].map(number => ({ number, summary: "源事实" })) }, index, [0, 1, 2]);
  const optimize = (changes: Record<string, unknown>, ids?: string[], scope = [0, 1, 2]) => {
    const output = contracts.requireProductionOptimization({ format: "FOUNDATION_OPTIMIZATION_V2", coverage: scope, changes, ...(ids ? { resolvedCatalogIssues: ids } : {}) }, index, scope);
    return contracts.applyProductionOptimizations(f1, pending, [output], index).f2 as ProductionCatalog & { repairItems?: RepairItem[] };
  };
  const edit = (episodes: number[]) => ({ assets: [{ key: mirror.key, name: mirror.name, type: mirror.type, episodes }] });
  for (const [changes, ids, scope] of [
    [{}, undefined, [0, 1, 2]], [edit([0, 1]), undefined, [0, 1, 2]], [{}, [repair.id], [0, 1, 2]], [edit([0, 1]), ["fake-repair-id"], [0, 1, 2]],
    [{ assets: [{ key: desk.key, name: desk.name, type: desk.type, episodes: [0, 1, 2] }] }, [repair.id], [0, 1, 2]],
    [edit([0]), [repair.id], [0]], [edit([2]), [repair.id], [0, 1, 2]]
  ] as Array<[Record<string, unknown>, string[] | undefined, number[]]>) assert.ok(optimize(changes, ids, scope).repairItems?.some(item => item.id === repair.id), "claims, unrelated edits, partial scope and still-invalid ranges cannot clear the original repair");
  assert.equal(optimize(edit([0, 1]), [repair.id]).repairItems?.length ?? 0, 0);
  assert.equal(optimize({ assets: [{ key: mirror.key, name: mirror.name, type: mirror.type, episodes: [0], variants: [{ name: "裂纹", episodes: [0], preparation: { mode: "DERIVE" } }] }] }, [repair.id]).repairItems?.length ?? 0, 0);
  assert.equal(optimize({ assets: [{ key: mirror.key, name: mirror.name, type: mirror.type, episodes: [0], variants: [] }] }, [repair.id]).repairItems?.length ?? 0, 0);
  assert.equal(optimize({ removeAssetKeys: [mirror.key] }, [repair.id]).repairItems?.length ?? 0, 0);
  const safe = author(wire([0, 1], [0, 1]), [0, 1, 2]);
  const base = safe.assets[0], variant = base.variants[0];
  const self = author({ format: "ASSET_CATALOG_V2", coverage: [2], assets: [{ key: base.key, name: base.name, type: base.type, episodes: [2],
    preparation: { mode: "DERIVE", fromKey: base.key }, variants: [{ name: variant.name, episodes: [2], preparation: { mode: "DERIVE", fromKey: variant.key } }] }] }, [2], safe.assets);
  assert.deepEqual(self.assets[0].preparation, base.preparation);
  assert.deepEqual(self.assets[0].variants[0].preparation, variant.preparation);
  const newSelfWire = wire([0, 1], [0, 1]);
  const newSelf = author({ ...newSelfWire, assets: [{ ...newSelfWire.assets[0], preparation: { mode: "DERIVE", fromKey: base.key },
    variants: [{ name: variant.name, episodes: [0, 1], preparation: { mode: "DERIVE", fromKey: variant.key } }] }, newSelfWire.assets[1]] }, [0, 1, 2]);
  assert.equal(newSelf.assets[0].preparation?.mode, "UNRESOLVED", "brand-new self cycle is not old registered reuse");
  assert.equal(newSelf.assets[0].variants[0].preparation?.mode, "UNRESOLVED", "brand-new variant self cycle cannot invent prior preparation");
  const unknownFrom = author({ format: "ASSET_CATALOG_V2", coverage: [2], assets: [{ name: "新道具", type: "PROP", episodes: [2], preparation: { mode: "DERIVE", fromKey: "not-a-known-source" } }] }, [2]);
  assert.equal(unknownFrom.assets[0].preparation?.mode, "UNRESOLVED");
  const cycle = author({ format: "ASSET_CATALOG_V2", coverage: [2], assets: safe.assets.map((asset, i) => ({ key: asset.key, name: asset.name, type: asset.type, episodes: [2], preparation: { mode: "DERIVE", fromKey: safe.assets[1 - i].key } })) }, [2], safe.assets);
  assert.ok(cycle.assets.every(asset => asset.preparation?.mode === "UNRESOLVED"));
  console.log("PASS pure repair acknowledgement matrix, original scopes, zero episode, self-reuse, unknown and cycle guards");
  const longSource = [0, 1, 2].map(number => ({ number, title: null, content: `${number}-1\n铜镜裂纹延续。${"原".repeat(24001)}` }));
  const multi = await db.project.create({ data: { title: "__catalog_repair_multi__", executionMode: "API", episodes: { create: longSource } } });
  await preprocessProject(multi.id, db);
  const multiCalls: string[] = [], multiRaw: string[] = [];
  await runtime.queueProjectFoundationContinuation(multi.id, { db, stageRunner: async (stage, prompt, context) => {
    multiCalls.push(`${stage}:${context.chunkIndex}`); const input = parse(prompt); let data: Record<string, unknown>;
    if (stage === "F1") data = { coverage: input.scope, overview: "长片段导航", episodes: input.scope.map(number => ({ number, summary: "裂纹延续" })) };
    else if (stage === "F2") {
      const existing = input.registry?.find(asset => asset.name === "铜镜");
      data = { format: "ASSET_CATALOG_V2", coverage: input.scope, assets: [{ ...(existing ? { key: existing.key } : {}), name: "铜镜", type: "PROP",
        episodes: input.scope[0] === 1 ? [] : input.scope, preparation: existing ? { mode: "DERIVE", fromKey: existing.key } : { mode: "REFERENCE" },
        variants: [{ name: "裂纹", episodes: input.scope, preparation: { mode: "DERIVE" } }] }] };
      multiRaw.push(JSON.stringify(data));
    } else {
      const repairs = input.candidates.f2.repairItems ?? [];
      data = { format: "FOUNDATION_OPTIMIZATION_V2", coverage: input.scope,
        changes: repairs.length ? { assets: [{ key: repairs[0].assetKey, name: "铜镜", type: "PROP", episodes: input.scope }] } : {},
        ...(repairs.length ? { resolvedCatalogIssues: repairs.map(item => item.id) } : {}) };
    }
    return { data, rawOutput: JSON.stringify(data), stdout: "synthetic-multi", stderr: "", sessionId: null };
  } });
  assert.deepEqual(multiCalls, ["F1:1", "F1:2", "F1:3", "F2:1", "F2:2", "F2:3", "Q1:1", "Q1:2", "Q1:3"]);
  const multiState = await stateApi.getFoundationState(multi.id, db);
  assert.equal(multiState.ready, true);
  const multiRun = await db.pipelineRun.findFirstOrThrow({ where: { projectId: multi.id, stageCode: "F2" } });
  assert.deepEqual(JSON.parse(multiRun.log!).calls.map((call: { response: { data: unknown } }) => JSON.stringify(call.response.data)), multiRaw);
  assert.equal(multiState.finalOutput!.f2.assets.length, 1, "registered identity is reused, never renumbered per chunk");
  assert.equal(multiState.finalOutput!.f2.assets[0].variants.length, 1, "same variant identity is retained across chunks");
  assert.deepEqual(multiState.finalOutput!.f2.assets[0].variants[0].episodes, [0, 1, 2]);
  console.log("PASS long three-chunk receiver and scoped Q1 repair retain raw responses and stable identity/variant numbering");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); });
