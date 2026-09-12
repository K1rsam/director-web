/** Current normal workflow with fake provider only; all persistence is isolated. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PRODUCTION_OUTPUT_SCHEMAS } from '@/lib/foundation-production-prompts';
import type { FoundationStageRunner } from '@/lib/project-foundation';
import { applyProductionOptimizations, mergeProductionCatalogs, requireProductionCatalogAuthor, requireProductionOptimization, type ProductionAsset } from '@/lib/foundation-production-contracts';
import { buildSourceIndex } from '@/lib/project-foundation-contracts';

assert.equal(PRODUCTION_OUTPUT_SCHEMAS.F2.format, 'ASSET_CATALOG_V2', 'normal requests must request the current preparation contract');
assert.ok('preparation' in PRODUCTION_OUTPUT_SCHEMAS.F2.assets[0]);
assert.ok('unresolved' in PRODUCTION_OUTPUT_SCHEMAS.Q1);
const spellingSource = buildSourceIndex([{ number: 1, title: '类型表示', content: '甲站在病房。' }]);
const typeSpellings = { format: 'ASSET_CATALOG_V2', coverage: [1], assets: [
  { name: '甲', type: 'CHARACTER', episodes: [1], preparation: { mode: 'REFERENCE' } },
  { name: '病房', type: 'LOCATION', episodes: [1], preparation: { mode: 'REFERENCE' } }
] };
const spellingBefore = JSON.stringify(typeSpellings);
assert.doesNotThrow(() => requireProductionCatalogAuthor(typeSpellings, spellingSource, [1]), '明确类型全称应兼容为CH/LOC，不能把正常类别表示变成整岗失败');
assert.deepEqual(requireProductionCatalogAuthor(typeSpellings, spellingSource, [1]).assets.map(asset => asset.type), ['CH', 'LOC']);
assert.equal(JSON.stringify(typeSpellings), spellingBefore);
assert.throws(() => requireProductionCatalogAuthor({ ...typeSpellings, assets: [{ ...typeSpellings.assets[0], type: 'UNSUPPORTED_KIND' }] }, spellingSource, [1]), /无效资产类型/);
const keyBase = requireProductionCatalogAuthor({ ...typeSpellings, assets: [typeSpellings.assets[0]] }, spellingSource, [1]);
const keyF1 = { coverage: [1], overview: '索引', issues: [], episodes: [{ number: 1, summary: '摘要', context: '', sourceSelections: [] }] };
const newKeyFor = (name: string) => applyProductionOptimizations(keyF1, keyBase, [requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {
  assets: [{ name, type: 'PROP', episodes: [1], preparation: { mode: 'REFERENCE' } }]
} }, spellingSource, [1])], spellingSource).f2.assets.find(asset => asset.name === name)!.key;
assert.notEqual(newKeyFor('钥匙'), newKeyFor('手机'), 'Q1重跑的同一新增槽不能让不同物件复用同一素材身份');
assert.equal(newKeyFor('钥匙'), newKeyFor('钥匙'), '相同原输入/修改复验仍产生稳定新增key');
const repeatedSets = { format: 'ASSET_CATALOG_V2', coverage: [1, 1], assets: [{ name: '甲', type: 'CH', aliases: ['郎中', '郎中'], episodes: [1, '1'], preparation: { mode: 'REFERENCE' } }] };
const repeatedBefore = JSON.stringify(repeatedSets);
assert.doesNotThrow(() => requireProductionCatalogAuthor(repeatedSets, spellingSource, [1]), '集合字段的重复值可确定去重，不应导致整岗失败');
assert.deepEqual(requireProductionCatalogAuthor(repeatedSets, spellingSource, [1]).assets[0].aliases, ['郎中']);
assert.equal(JSON.stringify(repeatedSets), repeatedBefore);
assert.throws(() => mergeProductionCatalogs([keyBase, keyBase], spellingSource, [1]), /不得重复/, '程序合并重复分片仍须拒绝，不能借集合兼容重复生产同一源范围');
const scratch = mkdtempSync(path.join(tmpdir(), 'foundation-replan-integration-'));
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
  const user = await db.user.create({ data: { email: 'replan@example.invalid', username: 'replan', passwordHash: 'not-an-authentication-fixture' } });
  const source = '人物小传\r\n李晴是江舟的妻子。\r\n第1集\r\n1-1 礼堂 日 内\r\n李晴穿婚服接过婚戒。桌上有普通苹果。\r\n第2集\r\n2-1 医院 日 内\r\n李晴伤后独臂。江舟在门外说话，画面不出现江舟。\r\n';
  const make = async (title: string) => (await importProjectFromText({ ownerUserId: user.id, title, sourceName: 'scene.txt', sourceText: source, executionMode: 'CLI' }, db)).project;
  const calls: string[] = [];
  const runner = (pending: boolean): FoundationStageRunner => async (stage, prompt) => {
    const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
    calls.push(stage);
    assert.equal(input.workflow, 'PRODUCTION_FOUNDATION_V3');
    assert.equal((prompt.match(/李晴穿婚服接过婚戒/g) ?? []).length, 1);
    assert.ok(JSON.stringify(input.backgroundSources).includes('李晴是江舟的妻子'), 'background must reach the role without contaminating episode source');
    let data: Record<string, unknown>;
    if (stage === 'F1') data = { coverage: input.scope, overview: '婚礼后转入伤后照护。', episodes: input.scope.map((number: number) => ({ number, summary: number === 1 ? '婚礼中交接婚戒。' : '伤后收到门外来讯。' })) };
    else if (stage === 'F2') data = { format: 'ASSET_CATALOG_V2', coverage: input.scope, assets: [
      { name: '李晴', type: 'CH', episodes: [1, 2], preparation: { mode: 'REFERENCE' }, variants: [
        { name: '婚服', episodes: [1], preparation: { mode: 'DERIVE' } },
        { name: '伤后独臂', episodes: [2], preparation: { mode: 'DERIVE' } }
      ] },
      { name: '婚戒', type: 'PROP', episodes: [1], preparation: { mode: 'REFERENCE' } },
      { name: '苹果', type: 'PROP', episodes: [1], preparation: { mode: 'REFERENCE' } },
      { name: '江舟', type: 'CH', episodes: [2], preparation: { mode: 'AUDIO' } },
      ...(pending ? [{ name: '未明信物', type: 'PROP', episodes: [2] }] : [])
    ] };
    else {
      const candidates: Array<{ key: string; name: string }> = input.candidates.f2.assets;
      assert.ok(candidates.every(asset => !input.registry.some((entry: { key: string }) => entry.key === asset.key)), 'Q1 must not get the same full identity twice');
      const apple = candidates.find(asset => asset.name === '苹果')!;
      const unknown = candidates.find(asset => asset.name === '未明信物');
      data = { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: { assets: [{ key: apple.key, name: '苹果', type: 'PROP', episodes: [1], preparation: { mode: 'INLINE', note: '普通桌面配件，无需独立制图。' } }] },
        ...(unknown ? { unresolved: [{ key: unknown.key, episodes: [2], note: '原文不足以决定信物身份。' }] } : {}) };
    }
    return { data, rawOutput: JSON.stringify(data), stdout: 'isolated fake provider', stderr: '', sessionId: null };
  };

  const project = await make('__replan_clear__');
  await queueProjectFoundationContinuation(project.id, { db, stageRunner: runner(false) });
  const state = await getFoundationState(project.id, db);
  assert.equal(state.ready, true, JSON.stringify({ message: state.message, issues: state.dataIssues, review: state.review?.output }));
  assert.ok(state.finalOutput);
  const packet = await readApprovedEpisodeFoundation(project.id, 2, db);
  assert.ok(!packet.source.content.includes('李晴是江舟的妻子'));
  const identities = packet.identities as Array<{ name: string; preparation?: { mode: string }; variants?: Array<{ name: string; preparation?: { mode: string; fromKey?: string } }> }>;
  assert.equal(identities.find(asset => asset.name === '江舟')?.preparation?.mode, 'AUDIO');
  const variant = identities.find(asset => asset.name === '李晴')?.variants?.[0];
  assert.equal(variant?.name, '伤后独臂'); assert.equal(variant?.preparation?.mode, 'DERIVE'); assert.ok(variant?.preparation?.fromKey);
  const rows = await db.asset.findMany({ where: { projectId: project.id } });
  assert.ok(rows.some(asset => asset.name === '苹果' && asset.metadata?.includes('INLINE')));
  assert.ok(rows.some(asset => asset.name === '江舟' && asset.metadata?.includes('AUDIO')));
  assert.equal(state.finalOutput.f2.assets.find(asset => asset.name === '苹果')?.preparation?.mode, 'INLINE');
  const exported = await buildFoundationExport(project.id, db);
  assert.deepEqual(exported.finalOutput, state.finalOutput);
  const original = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: project.id, sceneKey: 'SOURCE_IMPORT' } });
  assert.equal(JSON.parse(original.content).sourceText, source);
  assert.equal(state.candidates.f2?.output.assets.find(asset => asset.name === '苹果')?.name, '苹果');
  assert.equal((state.candidates.f2!.output.assets.find(asset => asset.name === '苹果') as ProductionAsset).preparation?.mode, 'REFERENCE', 'author data remains original');

  const pending = await make('__replan_pending__');
  await queueProjectFoundationContinuation(pending.id, { db, stageRunner: runner(true) });
  const pendingState = await getFoundationState(pending.id, db);
  assert.equal(pendingState.draftComplete, true); assert.equal(pendingState.ready, false);
  assert.ok(pendingState.finalOutput, 'unresolved is a complete readable draft, not a thrown run failure');
  assert.equal(pendingState.review!.output.verdict, 'REPAIR');
  const pendingRuns = await db.pipelineRun.findMany({ where: { projectId: pending.id } });
  assert.ok(pendingRuns.every(run => run.status === 'SUCCEEDED'));
  const again = await queueProjectFoundationContinuation(pending.id, { db, stageRunner: runner(true) });
  assert.deepEqual(again.stageCodes, [], 'unresolved choices do not cause automatic author loops');
  assert.deepEqual(calls, ['F1', 'F2', 'Q1', 'F1', 'F2', 'Q1']);
  console.log('PASS current v3 queue: background separation, author boundary, preparation through publication/packet/export, independent edits and readable unresolved draft');

  const merging = await make('__replan_material_merge__');
  await queueProjectFoundationContinuation(merging.id, { db, stageRunner: async (stage, prompt, context) => {
    if (stage === 'F1') return runner(false)(stage, prompt, context);
    const data = stage === 'F2' ? { format: 'ASSET_CATALOG_V2', coverage: [1, 2], assets: [
      { name: '李晴', type: 'CH', episodes: [1], preparation: { mode: 'REFERENCE' }, variants: [{ name: '婚服', episodes: [1], preparation: { mode: 'DERIVE' } }] },
      { name: '新娘', type: 'CH', episodes: [2], preparation: { mode: 'REFERENCE' }, variants: [{ name: '伤后独臂', episodes: [2], preparation: { mode: 'DERIVE' } }] }
    ] } : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1, 2], changes: {} };
    return { data, rawOutput: JSON.stringify(data), stdout: 'isolated preexisting duplicate setup', stderr: '', sessionId: null };
  } });
  const beforeMerge = await getFoundationState(merging.id, db);
  const a = beforeMerge.finalOutput!.f2.assets.find(asset => asset.name === '李晴')!;
  const b = beforeMerge.finalOutput!.f2.assets.find(asset => asset.name === '新娘')!;
  const existing = await db.asset.findMany({ where: { projectId: merging.id } });
  const parentA = existing.find(asset => JSON.parse(asset.metadata!).foundationKey === a.key)!;
  const parentB = existing.find(asset => JSON.parse(asset.metadata!).foundationKey === b.key)!;
  const childB = existing.find(asset => asset.parentId === parentB.id)!;
  await db.asset.update({ where: { id: childB.id }, data: { sourceText: 'USER_VARIANT_DESIGN', notes: 'USER_VARIANT_NOTE', status: 'confirmed', metadata: JSON.stringify({ ...JSON.parse(childB.metadata!), userImage: 'local-user-image-reference' }) } });
  await db.asset.update({ where: { id: parentB.id }, data: { notes: 'USER_SECOND_BASE_NOTE', status: 'confirmed' } });
  await queueSingleFoundationStage(merging.id, 'Q1', undefined, { db, stageRunner: async () => {
    const data = { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1, 2], changes: { mergeAssets: [{ keepKey: a.key, removeKeys: [b.key] }] } };
    return { data, rawOutput: JSON.stringify(data), stdout: 'isolated merge', stderr: '', sessionId: null };
  } });
  const merged = await getFoundationState(merging.id, db);
  assert.equal(merged.ready, true, merged.message);
  const preserved = await db.asset.findUniqueOrThrow({ where: { id: childB.id } });
  assert.equal(preserved.parentId, parentA.id, '归并中的唯一已有造型必须沿用原素材记录，不另建丢绑定');
  assert.equal(preserved.code, childB.code); assert.equal(preserved.sourceText, 'USER_VARIANT_DESIGN'); assert.equal(preserved.notes, 'USER_VARIANT_NOTE'); assert.equal(preserved.status, 'confirmed');
  assert.equal(JSON.parse(preserved.metadata!).userImage, 'local-user-image-reference');
  const survivingVariant = merged.finalOutput!.f2.assets[0].variants.find(variant => variant.name === '伤后独臂')!;
  assert.equal(merged.approved!.assets.find(asset => asset.key === survivingVariant.key)?.id, childB.id);
  const retired = await db.asset.findUniqueOrThrow({ where: { id: parentB.id } });
  assert.equal(retired.notes, 'USER_SECOND_BASE_NOTE'); assert.equal(retired.status, 'confirmed');
  assert.equal(JSON.parse(retired.metadata!).foundationMergedIntoKey, a.key);
  assert.ok(JSON.parse((await db.asset.findUniqueOrThrow({ where: { id: parentA.id } })).metadata!).foundationMergedFromIds.includes(parentB.id));
  console.log('PASS semantic identity merge preserves unique variant record, code, user image metadata and retired alternatives');
}

main().finally(async () => { await db.$disconnect(); rmSync(scratch, { recursive: true, force: true }); }).catch(error => { console.error(error); process.exitCode = 1; });
