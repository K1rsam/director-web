/** Generic permission protocol and real persistence; disposable SQLite, no provider calls. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { readChoiceChangeTargets, changeTargetsIdentity, type ChoiceChangeTargets } from '@/lib/foundation-choice-change-targets';
import { readHumanChoices, mergeHumanChoices, type HumanChoice } from '@/lib/foundation-human-choices';
import { buildSourceIndex, requireF1Output } from '@/lib/project-foundation-contracts';
import { requireProductionCatalogAuthor, requireProductionOptimization } from '@/lib/foundation-production-contracts';

const fields: ChoiceChangeTargets = { assetKeys: ['asset-b', 'asset-a', 'asset-a'], assetFields: ['variants', 'preparation'], sceneFields: [] };
const normalized = readChoiceChangeTargets(fields)!;
assert.deepEqual(normalized, { assetKeys: ['asset-a', 'asset-b'], assetFields: ['preparation', 'variants'], sceneFields: [] });
assert.deepEqual(fields.assetKeys, ['asset-b', 'asset-a', 'asset-a'], 'normalization cannot mutate caller input');
assert.equal(changeTargetsIdentity(fields), changeTargetsIdentity(normalized));
assert.notEqual(changeTargetsIdentity(undefined), changeTargetsIdentity(normalized));
assert.deepEqual(readChoiceChangeTargets({ assetKeys: [], assetFields: [], sceneFields: ['weather'] }), { assetKeys: [], assetFields: [], sceneFields: ['weather'] });
for (const invalid of [null, [], {}, { ...fields, assetFields: ['key'] }, { ...fields, assetFields: ['episodes'] }, { ...fields, sceneFields: ['sceneKey'] }, { ...fields, sceneFields: ['sourceText'] }, { ...fields, removeAssetKeys: ['asset-a'] }, { ...fields, assetKeys: [] }, { ...fields, assetFields: [] }, { assetKeys: [], assetFields: [], sceneFields: [] }]) assert.throws(() => readChoiceChangeTargets(invalid), /changeTargets/);
const choice: HumanChoice = { decisionKey: 'local-production-choice', kind: 'PRODUCTION_CHOICE', question: '本场采用哪种制作方案？', reason: '本场存在必要制作取舍', options: ['方案甲', '方案乙'], recommended: '方案甲', recommendationReason: '保留来源', evidence: '原文依据', episodes: [1], applicationScope: { kind: 'EPISODES', episodes: [1] }, changeTargets: fields };
const other: HumanChoice = { ...choice, changeTargets: { assetKeys: ['asset-a'], assetFields: ['name'], sceneFields: [] } };
const legacy: HumanChoice = { ...choice }; delete legacy.changeTargets;
assert.equal(mergeHumanChoices([[choice, other, legacy]]).length, 3, 'same question with different or absent permissions must stay separate');
assert.equal(mergeHumanChoices([[choice, { ...choice, changeTargets: normalized }]]).length, 1, 'equivalent permission ordering may merge');
assert.deepEqual(readHumanChoices([choice], [1])[0].changeTargets, normalized);
assert.throws(() => readHumanChoices([{ ...choice, changeTargets: null }], [1]), /changeTargets/);
const source = buildSourceIndex([{ number: 1, title: '测试', content: '第1集\n1-1 日 外 广场\n人物：甲\n△甲走过广场。\n' }]);
for (const result of [
  requireF1Output({ coverage: [1], overview: '导航', episodes: [{ number: 1, summary: '甲走过广场', context: '', sourceSelections: [] }], issues: [], humanChoices: [choice] }, source, [1]),
  requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [1], assets: [], humanChoices: [choice] }, source, [1]),
  requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {}, humanChoices: [choice] }, source, [1])
]) assert.deepEqual(result.humanChoices?.[0].changeTargets, normalized);

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'choice-change-targets-')), url = `file:${directory}/test.db`;
  process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const store = await import('@/lib/foundation-choice-store');
    const project = await db.project.create({ data: { title: 'generic target isolation', episodes: { create: { number: 1, title: '测试', content: source.episodes[0].content } } } });
    await store.syncFoundationChoices(db, project.id, source.version, 'Q1', [choice, other, legacy]);
    let loaded = await store.loadFoundationChoices(db, project.id, source.version);
    assert.equal(loaded.pending.length, 3);
    assert.equal(new Set(loaded.pending.map(row => row.id)).size, 3);
    assert.equal(new Set(loaded.registry.map(row => changeTargetsIdentity(row.changeTargets))).size, 3);
    const chosen = loaded.pending.find(row => changeTargetsIdentity(row.changeTargets) === changeTargetsIdentity(fields))!;
    const before = await db.presentationContract.findUniqueOrThrow({ where: { id: chosen.id } });
    assert.deepEqual(JSON.parse(before.note!).changeTargets, normalized);
    await store.confirmFoundationChoice(db, { projectId: project.id, contractId: chosen.id, revision: chosen.revision, optionIndex: '0' });
    await store.syncFoundationChoices(db, project.id, source.version, 'Q1', [choice, other, legacy]);
    loaded = await store.loadFoundationChoices(db, project.id, source.version);
    assert.equal(loaded.confirmed.length, 1);
    assert.deepEqual(loaded.confirmed[0].changeTargets, normalized);
    assert.equal(loaded.pending.length, 2, 'confirming one permission cannot authorize same-key different permissions');
    const appended = store.appendFoundationChoiceRegistry([loaded.registry.find(row => row.status === 'CONFIRMED')!], [choice, other, legacy], [1]);
    assert.equal(appended.length, 3, 'registry cannot consume another target permission as already confirmed');
    assert.equal(appended.filter(row => row.status === 'PENDING').length, 2);
    const invalidMeta = JSON.parse(before.note!); invalidMeta.changeTargets = { ...normalized, assetFields: ['episodes'] };
    await db.presentationContract.update({ where: { id: chosen.id }, data: { note: JSON.stringify(invalidMeta) } });
    await assert.rejects(store.loadFoundationChoices(db, project.id, source.version), /changeTargets/, 'invalid saved explicit permissions cannot become broad legacy consent');
    console.log('PASS generic choice changeTargets: strict protocol, three-role passthrough, permission-isolated merge/registry/persistence/confirmation, legacy compatibility (offline SQLite)');
  } finally {
    await db.$disconnect();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { console.warn('Temporary offline fixture retained:', directory); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
