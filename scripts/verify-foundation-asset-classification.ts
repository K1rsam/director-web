/** Synthetic contract and isolated persistence checks; never launches a provider. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { applyProductionOptimizations, mergeProductionCatalogs, projectProductionCatalog, requireProductionCatalog, requireProductionCatalogAuthor, requireProductionOptimization } from '@/lib/foundation-production-contracts';
import { buildSourceIndex } from '@/lib/project-foundation-contracts';
import type { FoundationStageRunner } from '@/lib/project-foundation';

const index = buildSourceIndex([1, 2, 3].map(number => ({ number, title: `第${number}集`, content: '林川召唤青麟，负伤后继续前行。' })));
const wire = { format: 'ASSET_CATALOG_V2', coverage: [1, 2, 3], assets: [
  { name: '林川', type: 'CH', role: '主角', relationNote: '召唤青麟', episodes: [1, 2, 3], preparation: { mode: 'REFERENCE' }, variants: [
    { name: '轻伤', episodes: [2], preparation: { mode: 'INLINE' } },
    { name: '重伤', episodes: [3], preparation: { mode: 'DERIVE' } }
  ] },
  { name: '青麟', type: 'BEAST', role: '伙伴', relationNote: '被林川召唤的独立灵兽', episodes: [1, 2, 3], preparation: { mode: 'REFERENCE' } }
] };
function freeze(value: any): any { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
const original = JSON.stringify(wire);
const catalog = requireProductionCatalogAuthor(freeze(wire), index, [1, 2, 3]);
assert.equal(catalog.assets[0].role, '主角', 'V2 author must preserve role');
assert.equal(catalog.assets[1].role, '伙伴', 'unknown text labels remain literal, without reclassification');
assert.equal(catalog.assets[1].preparation?.fromKey, undefined);
assert.equal(catalog.assets.length, 2, 'story association does not merge independent identities');
assert.equal(JSON.stringify(wire), original);
assert.deepEqual(requireProductionCatalog(freeze(structuredClone(catalog)), index, [1, 2, 3]), catalog);
const projection = projectProductionCatalog(catalog, [2, 3]);
assert.equal(projection.assets[0].relationNote, '召唤青麟');
assert.equal(projection.assets[0].variants[0].key, catalog.assets[0].variants[0].key);
assert.equal('role' in projection.assets[0].variants[0], false);
for (const field of ['role', 'relationNote']) {
  for (const bad of [12, false, {}, []]) assert.throws(() => requireProductionCatalogAuthor({ ...wire, assets: [{ ...wire.assets[0], [field]: bad }] }, index, [1, 2, 3]), new RegExp(field));
  assert.throws(() => requireProductionCatalog({ ...catalog, assets: [{ ...catalog.assets[0], [field]: {} }] }, index, [1, 2, 3]), new RegExp(field));
  const nil = requireProductionCatalogAuthor({ ...wire, assets: [{ ...wire.assets[0], key: catalog.assets[0].key, [field]: null }] }, index, [1, 2, 3], catalog.assets);
  assert.equal((nil.assets[0] as any)[field], (catalog.assets[0] as any)[field]);
}
const legacy = requireProductionCatalogAuthor({ ...wire, format: 'ASSET_CATALOG_V1' }, index, [1, 2, 3]);
assert.equal('role' in legacy.assets[0], false);
assert.equal('relationNote' in projectProductionCatalog(legacy, [1]).assets[0], false);
const f1 = { coverage: [1, 2, 3], overview: '', episodes: [1, 2, 3].map(number => ({ number, summary: '', context: '', sourceSelections: [] })), issues: [] };
const edit = (changes: unknown, base = catalog) => applyProductionOptimizations(f1, base, [requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1, 2, 3], changes }, index, [1, 2, 3])], index).f2;
const renamed = edit({ assets: [{ key: catalog.assets[0].key, name: '林川本体', type: 'CH', episodes: [1, 2, 3], preparation: { mode: 'REFERENCE' } }] });
assert.equal(renamed.assets[0].role, '主角'); assert.equal(renamed.assets[0].relationNote, '召唤青麟');
assert.equal(renamed.assets[0].variants.length, 2);
const cleared = edit({ assets: [{ key: catalog.assets[0].key, name: '林川', type: 'CH', episodes: [1, 2, 3], role: '', relationNote: '' }] });
assert.equal(cleared.assets[0].role, ''); assert.equal(cleared.assets[0].relationNote, ''); assert.equal(cleared.assets[0].key, catalog.assets[0].key);
const clearedThenMerged = edit({ mergeAssets: [{ keepKey: catalog.assets[0].key, removeKeys: [catalog.assets[1].key] }] }, cleared);
assert.equal(clearedThenMerged.assets[0].role, '', 'later identity merge must not revive an explicitly cleared role');
assert.equal(clearedThenMerged.assets[0].relationNote, '', 'later identity merge must not revive an explicitly cleared relation');
const omitted = requireProductionCatalogAuthor({ format: wire.format, coverage: wire.coverage, assets: [{ name: '无标签人物', type: 'CH', episodes: [1] }] }, index, [1, 2, 3]);
assert.equal('role' in omitted.assets[0], false); assert.equal('relationNote' in omitted.assets[0], false);
const newRole = requireProductionCatalogAuthor({ ...wire, assets: [{ ...wire.assets[0], role: '  特别出演  ' }, wire.assets[1]] }, index, [1, 2, 3]);
assert.equal(newRole.assets[0].key, catalog.assets[0].key); assert.equal(newRole.assets[0].role, '特别出演');
const inherited = edit({ mergeAssets: [{ keepKey: catalog.assets[0].key, removeKeys: [catalog.assets[1].key] }] }, { ...catalog, assets: [{ ...catalog.assets[0], role: undefined, relationNote: undefined }, catalog.assets[1]] });
assert.equal(inherited.assets[0].role, '伙伴'); assert.equal(inherited.assets[0].relationNote, '被林川召唤的独立灵兽');
const scoped = applyProductionOptimizations(f1, catalog, [requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [2], changes: { assets: [{ key: catalog.assets[0].key, name: '林川', type: 'CH', episodes: [], role: null, relationNote: null }] } }, index, [2])], index).f2;
assert.deepEqual(scoped.assets[0].usageEpisodes, [1, 3]); assert.equal(scoped.assets[0].role, '主角'); assert.equal(scoped.assets[0].relationNote, '召唤青麟');
const parts = [requireProductionCatalog(projectProductionCatalog(catalog, [1]), index, [1], catalog.assets), requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [2, 3], assets: [{ key: catalog.assets[0].key, name: '林川', type: 'CH', episodes: [2, 3] }] }, index, [2, 3], catalog.assets)];
const mergedParts = mergeProductionCatalogs(parts, index, [1, 2, 3]);
assert.equal(mergedParts.assets[0].role, '主角'); assert.equal(mergedParts.assets[0].relationNote, '召唤青麟');
const merged = edit({ mergeAssets: [{ keepKey: catalog.assets[0].key, removeKeys: [catalog.assets[1].key] }] });
assert.equal(merged.assets[0].role, '主角'); assert.match(merged.assets[0].relationNote!, /召唤青麟/); assert.match(merged.assets[0].relationNote!, /独立灵兽/);
const override = edit({ mergeAssets: [{ keepKey: catalog.assets[0].key, removeKeys: [catalog.assets[1].key] }], assets: [{ key: catalog.assets[0].key, name: '最终', type: 'CH', episodes: [1, 2, 3], role: '反派', relationNote: '最终解释' }] });
assert.equal(override.assets[0].role, '反派'); assert.equal(override.assets[0].relationNote, '最终解释');
console.log('PASS classification contract: author/read/projection/V1/immutable/type/nil/clear/merge/Q1');

const scratch = mkdtempSync(path.join(tmpdir(), 'foundation-classification-'));
const url = `file:${path.join(scratch, 'test.db')}`;
process.env.DATABASE_URL = url;
copyFileSync(path.resolve('prisma/schema.prisma'), path.join(scratch, 'schema.prisma'));
execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--schema', path.join(scratch, 'schema.prisma'), '--skip-generate'], { cwd: scratch, env: { ...process.env, DATABASE_URL: url, RUST_LOG: 'info' }, stdio: 'pipe' });
const db = new PrismaClient({ datasources: { db: { url } } });
async function main() {
  const { importProjectFromText } = await import('@/lib/workflow');
  const { queueProjectFoundationContinuation, queueSingleFoundationStage } = await import('@/lib/project-foundation');
  const { getFoundationState, readApprovedEpisodeFoundation } = await import('@/lib/foundation-state');
  const { buildFoundationExport } = await import('@/lib/foundation-export');
  const user = await db.user.create({ data: { email: 'classification@example.invalid', username: 'classification', passwordHash: 'fake' } });
  const { project } = await importProjectFromText({ ownerUserId: user.id, title: 'classification', sourceName: 'test.txt', sourceText: '第1集\n林川召唤青麟。\n第2集\n林川轻伤。\n第3集\n林川重伤，青麟守护。', executionMode: 'CLI' }, db);
  const seen: string[] = [];
  const runner: FoundationStageRunner = async (stage, prompt) => {
    seen.push(stage);
    const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
    const data = stage === 'F1' ? { coverage: input.scope, overview: '召唤后负伤', episodes: input.scope.map((number: number) => ({ number, summary: '召唤后负伤' })) }
      : stage === 'F2' ? wire : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: {} };
    if (stage === 'Q1') { assert.equal(input.candidates.f2.assets[0].role, '主角'); assert.equal(input.candidates.f2.assets[1].relationNote, '被林川召唤的独立灵兽'); }
    return { data, rawOutput: JSON.stringify(data), stdout: 'fake role only', stderr: '', sessionId: null };
  };
  await queueProjectFoundationContinuation(project.id, { db, stageRunner: runner });
  const state = await getFoundationState(project.id, db);
  assert.equal(state.ready, true, state.message);
  const rows = await db.asset.findMany({ where: { projectId: project.id } });
  const human = rows.find(a => a.name === '林川')!, beast = rows.find(a => a.name === '青麟')!;
  assert.equal(human.parentId, null); assert.equal(beast.parentId, null);
  const meta = JSON.parse(human.metadata!);
  assert.equal(meta.foundation.role, '主角'); assert.equal(meta.foundation.relationNote, '召唤青麟');
  await db.asset.update({ where: { id: human.id }, data: { metadata: JSON.stringify({ ...meta, role: '手工标签', custom: '手工字段' }), notes: '手工备注', status: 'confirmed', sourceText: '手工设计' } });
  await queueSingleFoundationStage(project.id, 'Q1', undefined, { db, stageRunner: runner });
  const after = await db.asset.findUniqueOrThrow({ where: { id: human.id } });
  assert.equal(after.code, human.code); assert.equal(after.notes, '手工备注'); assert.equal(after.sourceText, '手工设计'); assert.equal(after.status, 'confirmed');
  assert.equal(JSON.parse(after.metadata!).role, '手工标签'); assert.equal(JSON.parse(after.metadata!).custom, '手工字段'); assert.equal(JSON.parse(after.metadata!).foundation.role, '主角');
  const exported = await buildFoundationExport(project.id, db);
  assert.equal(exported.finalOutput!.f2.assets[0].role, '主角');
  const packet = await readApprovedEpisodeFoundation(project.id, 2, db);
  assert.equal(JSON.stringify(packet).includes('relationNote'), false); assert.equal(JSON.stringify(packet).includes('"role"'), false);
  await queueSingleFoundationStage(project.id, 'F2', undefined, { db, stageRunner: async (stage, prompt) => {
    assert.equal(stage, 'F2'); const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
    const prior = input.previousAssetKeys.find((a: any) => a.name === '林川');
    assert.equal(prior.role, '主角'); assert.equal('relationNote' in prior, false, 'history hints avoid copying unrelated relation narratives');
    const data = { ...wire, assets: wire.assets.map(({ role: _role, relationNote: _relation, ...a }) => ({ ...a, key: input.previousAssetKeys.find((b: any) => b.name === a.name).key })) };
    return { data, rawOutput: JSON.stringify(data), stdout: 'fake history reuse', stderr: '', sessionId: null };
  } });
  const rerun = await getFoundationState(project.id, db);
  assert.equal((rerun.candidates.f2!.output.assets[0] as any).role, '主角');
  assert.equal((rerun.candidates.f2!.output.assets[0] as any).relationNote, '召唤青麟');
  await queueSingleFoundationStage(project.id, 'Q1', undefined, { db, stageRunner: async (_stage, prompt) => {
    const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
    const data = { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: { assets: [{ key: input.candidates.f2.assets[0].key, name: '林川', type: 'CH', episodes: [1, 2, 3], role: '', relationNote: '' }] } };
    return { data, rawOutput: JSON.stringify(data), stdout: 'fake explicit clear', stderr: '', sessionId: null };
  } });
  const clearedMetadata = JSON.parse((await db.asset.findUniqueOrThrow({ where: { id: human.id } })).metadata!);
  assert.equal(clearedMetadata.foundation.role, ''); assert.equal(clearedMetadata.foundation.relationNote, ''); assert.equal(clearedMetadata.role, '手工标签');
  assert.deepEqual(seen, ['F1', 'F2', 'Q1', 'Q1']);
  const { preprocessProject } = await import('@/lib/project-preprocess');
  const chunked = await db.project.create({ data: { title: 'classification-chunks', executionMode: 'CLI', episodes: { create: [1, 2, 3].map(number => ({ number, title: `第${number}集`, content: `林川负伤，青麟守护。${'测试源文'.repeat(3300)}` })) } } });
  await preprocessProject(chunked.id, db);
  let registryChecks = 0;
  await queueProjectFoundationContinuation(chunked.id, { db, stageRunner: async (stage, prompt) => {
    const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!); const n = input.scope[0];
    let data: Record<string, unknown>;
    if (stage === 'F1') data = { coverage: input.scope, overview: '分片概述', episodes: [{ number: n, summary: '分片导航' }] };
    else if (stage === 'F2') {
      const prior = input.registry.find((a: any) => a.name === '林川');
      if (n > 1) { assert.equal(prior.role, '主角'); assert.equal(prior.relationNote, '召唤青麟'); registryChecks++; }
      data = { format: wire.format, coverage: input.scope, assets: [
        { ...(prior ? { key: prior.key } : { role: '主角', relationNote: '召唤青麟' }), name: '林川', type: 'CH', episodes: [n], preparation: { mode: 'REFERENCE' } },
        ...(n === 1 ? [{ ...wire.assets[1], episodes: [1] }] : [])
      ] };
    } else {
      if (n > 1) { const beast = input.registry.find((a: any) => a.name === '青麟'); assert.equal(beast.role, '伙伴'); assert.equal(beast.relationNote, '被林川召唤的独立灵兽'); registryChecks++; }
      assert.equal(input.candidates.f2.assets[0].role, '主角');
      data = { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: {} };
    }
    return { data, rawOutput: JSON.stringify(data), stdout: 'fake multi-chunk role', stderr: '', sessionId: null };
  } });
  assert.equal(registryChecks, 4); assert.equal((await getFoundationState(chunked.id, db)).ready, true);
  console.log('PASS isolated queue/apply/publish/export: stable materials, framework metadata, stored history, no EP field leakage; fake output is not model-quality evidence');
}
main().finally(async () => { await db.$disconnect(); rmSync(scratch, { recursive: true, force: true }); }).catch(error => { console.error(error); process.exitCode = 1; });
