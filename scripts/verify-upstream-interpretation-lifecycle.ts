import assert from 'node:assert/strict';
import {mkdtempSync, readdirSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';
import {PrismaClient} from '@prisma/client';

/** Two synthetic episodes; native migrations, no production data, network or model calls. */
async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'upstream-interpretation-lifecycle-'));
  const filename = path.join(directory, 'test.db');
  process.env.DATABASE_URL = `file:${filename}`;
  process.env.DIRECTOR_ASSET_REFERENCE_DIR = path.join(directory, 'references');
  process.env.TYPESAFE_API_KEY = '';
  globalThis.fetch = async () => { throw new Error('Regression must not make network/model calls'); };
  const sqlite = new DatabaseSync(filename);
  for (const name of readdirSync('prisma/migrations').filter(name => /^\d/.test(name)).sort()) sqlite.exec(readFileSync(path.join('prisma/migrations', name, 'migration.sql'), 'utf8'));
  sqlite.close();
  const db = new PrismaClient({datasourceUrl: `file:${filename}`});
  (globalThis as unknown as {prisma: PrismaClient}).prisma = db;
  const {loadFoundationInputs} = await import('../lib/foundation-state');
  const {createEmptyDocument, mergeDocumentF2, applyDocumentEdit, loadFoundationDocument, saveFoundationDocument} = await import('../lib/foundation-document');
  const {requireProductionCatalogAuthor, requireProductionOptimization} = await import('../lib/foundation-production-contracts');
  const {readScriptReception, confirmScriptResolution, revokeScriptResolution} = await import('../lib/script-resolution-service');
  const {cachedFoundationFacts} = await import('../lib/foundation-fact-cache');
  const {prepareEpisodeReception, scriptStructureTable} = await import('../lib/standard-script-reception');
  const {loadAssetPromptWorkspace, saveAssetPrompt} = await import('../lib/asset-prompt-service');
  const {readAssetDesignAdoptions, adoptAssetDesign} = await import('../lib/asset-design-adoption');
  const require = createRequire(import.meta.url);
  const {standardPackageSource} = require('../runtime/storyboard-v4/core/standard-source.mjs');
  const {normalizeSource} = require('../runtime/storyboard-v4/core/source.mjs');
  try {
    const original = [
      {number: 1, title: '局部核对', content: '第一集\r\n1-1 日 内 客厅\r\n人物：甲、乙\r\n甲：你好。乙：再见。\r\n提示：保持克制。\r\n△甲回头。\r\n'},
      {number: 2, title: '独立第二集', content: '第二集\n2-1 夜 外 石桥\n人物：丙\n丙：我在桥上等你。\n△丙停步。\n'},
    ];
    const reviewer = await db.user.create({data: {username: 'interpretation-reviewer', email: 'reviewer@synthetic.invalid', passwordHash: 'fixture-not-login'}});
    const project = await db.project.create({data: {title: '合成两集解释生命周期', style: '3D', executionMode: 'API', episodes: {create: original}, roles: {create: {userId: reviewer.id, role: 'REVIEWER'}}}});
    const sourceText = original.map(episode => episode.content).join('');
    let start = 0;
    const sections = original.map(episode => {const section = {key: `ep${episode.number}`, kind: 'EPISODE', episodeNumber: episode.number, start, end: start + episode.content.length}; start = section.end; return section;});
    const imported = await db.sceneSnapshot.create({data: {projectId: project.id, sceneKey: 'SOURCE_IMPORT', metadata: JSON.stringify({schema: 'IMPORTED_SOURCE_TEXT_V2'}), content: JSON.stringify({sourceText, sourceStructure: {version: 'SOURCE_STRUCTURE_V1', sections, issues: []}})}});
    const input0 = await loadFoundationInputs(project.id, db), empty = createEmptyDocument(input0);
    assert.equal(input0.sourceContext.complete, true);
    const catalog = requireProductionCatalogAuthor({format: 'ASSET_CATALOG_V2', coverage: [1, 2], assets: [
      {name: '甲', type: 'CH', episodes: [1], preparation: {mode: 'REFERENCE'}},
      {name: '乙', type: 'CH', episodes: [1], preparation: {mode: 'REFERENCE'}},
      {name: '丙', type: 'CH', episodes: [2], preparation: {mode: 'REFERENCE'}},
    ]}, input0.sourceIndex, [1, 2]);
    const baseline = {...mergeDocumentF2({...empty, workflow: 'LIGHT_STAGE1_V1' as const}, catalog, input0.sourceIndex), editorialCoverage: [1, 2]};
    const saved0 = await saveFoundationDocument(db, project.id, empty.revision, baseline, 'synthetic F2/Q1 fixture');
    const preserved = await db.sceneSnapshot.findMany({where: {projectId: project.id, sceneKey: 'FOUNDATION_DOCUMENT'}});
    const beforeFacts = cachedFoundationFacts(input0.sourceIndex, input0.sourceContext, catalog, {standard: true});
    const beforeReception = await readScriptReception(project.id, reviewer.id, 1, {db});
    assert.equal(beforeReception.selected!.ready, false); assert.ok(beforeReception.selected!.diagnostics.some(item => item.line === 5));
    const confirmed = await confirmScriptResolution(project.id, reviewer.id, {episode: 1, sourceVersion: beforeReception.selected!.sourceVersion, expectedRevision: 0, choice: {startLine: 5, endLine: 5, type: 'CREATIVE_GUIDANCE'}}, {db});
    assert.equal(confirmed.selected!.ready, true);
    const input1 = await loadFoundationInputs(project.id, db), read1 = await loadFoundationDocument(db, project.id, input1);
    assert.equal(input1.sourceVersion, input0.sourceVersion, 'manual interpretation cannot rewrite the raw source edition');
    assert.notEqual(input1.inputVersion, input0.inputVersion); assert.ok(input1.scriptInterpretationVersions?.[1]); assert.equal(input1.scriptInterpretationVersions?.[2], undefined);
    assert.deepEqual(read1.document.f2!.coverage, [2]); assert.deepEqual(read1.document.editorialCoverage, [2]);
    assert.equal(read1.document.sourceHashes['2'], saved0.sourceHashes['2']); assert.notEqual(read1.document.sourceHashes['1'], saved0.sourceHashes['1']);
    const afterFacts = cachedFoundationFacts(input1.sourceIndex, input1.sourceContext, catalog, {standard: true, resolutions: input1.scriptResolutions});
    assert.notEqual(afterFacts, beforeFacts, 'changed interpretation must not reuse the previous cached extraction');
    assert.deepEqual(afterFacts.facts.filter(fact => fact.evidence.episode === 2), beforeFacts.facts.filter(fact => fact.evidence.episode === 2));
    const reception1 = prepareEpisodeReception(original[0], read1.document.f2, input1.scriptResolutions?.[1]);
    assert.equal(reception1.scriptReception.ready, true); assert.ok(reception1.standardScript!.script.entries.some(entry => entry.kind === 'DIALOGUE_GROUP'));
    const received = normalizeSource(standardPackageSource(reception1.standardScript, {key: 'synthetic-episode-1', sourceText: original[0].content}));
    assert.deepEqual(received.dialogue.map((entry: {speaker: string; quote: string}) => [entry.speaker, entry.quote]), [['甲', '你好。'], ['乙', '再见。']]);
    assert.equal(prepareEpisodeReception(original[1], read1.document.f2).scriptReception.ready, true);
    console.log('PASS two-episode read, scoped interpretation invalidation, fact-cache refresh and real GROUP receiver');

    let saved1: typeof saved0 | undefined;
    await assert.doesNotReject(async () => {saved1 = await saveFoundationDocument(db, project.id, read1.document.revision, read1.document, 'persist scoped interpretation migration');}, 'current manual interpretation must be part of the transactional source check');
    assert.ok(saved1);
    const retainedEpisode2 = JSON.stringify(saved1.f2!.episodes.find(episode => episode.number === 2));
    const localCatalog = requireProductionCatalogAuthor({format: 'ASSET_CATALOG_V2', coverage: [1], assets: catalog.assets.filter(asset => asset.usageEpisodes.includes(1)).map(asset => ({key: asset.key, name: asset.name, type: asset.type, episodes: [1], preparation: {mode: 'REFERENCE'}}))}, input1.sourceIndex, [1], catalog.assets);
    const authored = mergeDocumentF2(saved1, localCatalog, input1.sourceIndex);
    const edited = applyDocumentEdit(authored, requireProductionOptimization({format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {}, notes: ['合成局部Q1核对']}, input1.sourceIndex, [1], authored.f2!.assets), input1.sourceIndex);
    const saved2 = await saveFoundationDocument(db, project.id, saved1.revision, edited, 'synthetic episode-1 F2/Q1 refresh');
    assert.deepEqual(saved2.f2!.coverage, [1, 2]); assert.deepEqual(saved2.editorialCoverage, [1, 2]);
    assert.equal(JSON.stringify(saved2.f2!.episodes.find(episode => episode.number === 2)), retainedEpisode2, 'local refresh leaves episode 2 unchanged');
    assert.equal((await loadFoundationDocument(db, project.id, await loadFoundationInputs(project.id, db))).document.revision, saved2.revision);

    const asset1 = saved2.f2!.assets.find(asset => asset.name === '甲')!.key, asset2 = saved2.f2!.assets.find(asset => asset.name === '丙')!.key;
    for (const key of [asset1, asset2]) {
      await saveAssetPrompt(project.id, key, 0, `合成已保存提示词 ${key}`);
      const view = (await readAssetDesignAdoptions(project.id, reviewer.id)).assets[key];
      await adoptAssetDesign(project.id, reviewer.id, {assetKey: key, expectedRevision: view.revision, expectedMaterialToken: view.materialToken, brief: `合成采用简述 ${key}`, referenceIds: []});
    }
    assert.equal((await loadAssetPromptWorkspace(project.id)).assets.some(asset => asset.key === asset1), true);
    console.log('PASS scoped F2/Q1 save and asset workspace → explicit text adoption');

    // Writer A read saved2. Writer B confirms another interpretation before A saves.
    const changed = await confirmScriptResolution(project.id, reviewer.id, {episode: 1, sourceVersion: confirmed.selected!.sourceVersion, expectedRevision: 1, choice: {id: confirmed.selected!.decisions[0].id, startLine: 5, endLine: 5, type: 'CONTINUITY'}}, {db});
    const input2 = await loadFoundationInputs(project.id, db);
    assert.notEqual(input2.scriptInterpretationVersions![1], input1.scriptInterpretationVersions![1]);
    await assert.rejects(() => saveFoundationDocument(db, project.id, saved2.revision, {...saved2, notes: [...saved2.notes, 'stale writer A']}, 'stale interpreted edit'), /source|原文|解析|解释|版本/);
    assert.equal((await readScriptReception(project.id, reviewer.id, 1, {db})).selected!.revision, 2, 'rejecting old work must not undo the newer interpretation');
    const read2 = await loadFoundationDocument(db, project.id, input2);
    assert.deepEqual(read2.document.f2!.coverage, [2]); assert.deepEqual(read2.document.editorialCoverage, [2]);
    assert.equal(read2.document.sourceHashes['2'], saved2.sourceHashes['2']);
    const adoption2 = await readAssetDesignAdoptions(project.id, reviewer.id);
    assert.equal(adoption2.assets[asset1].status, 'STALE'); assert.equal(adoption2.assets[asset2].status, 'TEXT_ADOPTED', 'unrelated episode material remains adopted');
    assert.ok(scriptStructureTable(input2.sourceIndex, read2.document.f2, [1], input2.scriptResolutions).rows.some(row => row[4] === 'CONTINUITY'));
    const saved3 = await saveFoundationDocument(db, project.id, read2.document.revision, read2.document, 'persist current interpretation after stale writer refusal');
    await revokeScriptResolution(project.id, reviewer.id, {episode: 1, sourceVersion: changed.selected!.sourceVersion, expectedRevision: 2, decisionId: changed.selected!.decisions[0].id}, {db});
    const revokedInput = await loadFoundationInputs(project.id, db), revoked = await loadFoundationDocument(db, project.id, revokedInput);
    assert.equal(revokedInput.scriptInterpretationVersions?.[1], undefined);
    assert.deepEqual(revoked.document.f2!.coverage, [2]); assert.deepEqual(revoked.document.editorialCoverage, [2]);
    await assert.rejects(() => saveFoundationDocument(db, project.id, saved3.revision, saved3, 'stale save after interpretation revoke'), /source|原文|解析|解释|版本/);
    await saveFoundationDocument(db, project.id, revoked.document.revision, revoked.document, 'persist return to automatic interpretation');
    assert.equal(prepareEpisodeReception(original[0], revoked.document.f2).scriptReception.ready, false);
    assert.equal(prepareEpisodeReception(original[1], revoked.document.f2).scriptReception.ready, true);
    for (const row of preserved) assert.deepEqual(await db.sceneSnapshot.findUnique({where: {id: row.id}}), row, 'old paid work remains byte-identical');
    assert.deepEqual(await db.sceneSnapshot.findUnique({where: {id: imported.id}}), imported);
    assert.deepEqual((await db.episode.findMany({where: {projectId: project.id}, orderBy: {number: 'asc'}})).map(({number, title, content}) => ({number, title, content})), original);
    assert.equal(await db.sceneSnapshot.count({where: {projectId: project.id, sceneKey: 'SCRIPT_RESOLUTION_HISTORY_V1'}}), 3);
    console.log('PASS stale interpretation writer refusal, scoped revoke, immutable source/history; isolated native SQLite, model/network calls 0');
  } finally {await db.$disconnect();}
}
main().catch(error => {console.error(error); process.exitCode = 1;});
