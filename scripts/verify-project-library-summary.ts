/** Isolated real SQLite/controller and optional read-only current-library comparison; no provider calls. */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

async function compare(db: PrismaClient, userId: string, ids: string[], onTiming?: (summaryMs: number, baselineMs: number) => void) {
  const { readProjectLibrarySummaries } = await import('../lib/project-library-summary');
  const { getFoundationDeliveryState } = await import('../lib/foundation-delivery');
  const { readProductionScope } = await import('../lib/production-episodes');
  const started = performance.now();
  const summaries = await readProjectLibrarySummaries(userId, ids, db);
  const summaryMs = performance.now() - started, baselineStarted = performance.now();
  for (const id of ids) {
    assert.deepEqual(summaries.get(id)!.productionScope, await readProductionScope(id, db), 'Scope matches the newest authoritative source, including legacy absence and unreadable current snapshots');
    assert.equal(summaries.get(id)!.complete, (await getFoundationDeliveryState(id, db)).complete, 'Cheap exclusion must agree with complete source/material/registry validation');
  }
  onTiming?.(summaryMs, performance.now() - baselineStarted);
  return summaries;
}

async function live() {
  // Read only the DB locator; never print private .env contents or source text.
  const locator = /^DATABASE_URL\s*=\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(readFileSync(path.resolve('.env'), 'utf8'))?.[1]?.trim();
  assert.ok(locator?.startsWith('file:'), 'A local SQLite locator is required for the read-only comparison');
  const filename = locator!.slice(5);
  const absolute = path.isAbsolute(filename) ? filename : path.resolve('prisma', filename);
  process.env.DATABASE_URL = `file:${absolute}`;
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    const actor = await db.user.findUnique({ where: { username: 'tester01' }, select: { id: true } }); assert.ok(actor);
    const { getProjectLibrary } = await import('../lib/project-library');
    const listingStarted = performance.now();
    const { projects, archivedProjects } = await getProjectLibrary(actor.id, db);
    const listingMs = performance.now() - listingStarted;
    let summaryMs = 0, baselineMs = 0;
    const summaries = await compare(db, actor.id, [...projects, ...archivedProjects].map(project => project.id), (summary, baseline) => { summaryMs = summary; baselineMs = baseline; });
    const full = [...summaries.values()].filter(value => value.completionCheck === 'FULL').length;
    console.log(`PASS current library read-only: ${projects.length} active + ${archivedProjects.length} archived projects; summaries equal authoritative completion and scope; ${full} possible-complete projects require full validation, ${summaries.size - full} excluded; summary ${Math.round(summaryMs)} ms, sequential baseline comparison ${Math.round(baselineMs)} ms; provider calls 0.`);
    const { readProjectLibrarySummaries } = await import('../lib/project-library-summary');
    const uiStarted = performance.now();
    const ui = await readProjectLibrarySummaries(actor.id, [...projects, ...archivedProjects].map(project => project.id), db, { foundationProjectIds: projects.map(project => project.id) });
    const uiMs = performance.now() - uiStarted;
    for (const project of projects) assert.deepEqual(ui.get(project.id), summaries.get(project.id));
    for (const project of archivedProjects) {
      assert.deepEqual(ui.get(project.id)!.productionScope, summaries.get(project.id)!.productionScope);
      assert.equal(ui.get(project.id)!.completionCheck, 'NOT_REQUESTED');
    }
    console.log(`PASS home-page read boundary: ${projects.length} active completion checks (${projects.filter(project => ui.get(project.id)!.completionCheck === 'FULL').length} full fallbacks), ${archivedProjects.length} archived scope-only summaries; fresh request ${Math.round(listingMs)} ms listing + ${Math.round(uiMs)} ms summary; excludes Next rendering/compilation and browser transfer.`);
  } finally { await db.$disconnect(); }
}

async function isolated() {
  const repository = process.cwd(), directory = mkdtempSync(path.join(tmpdir(), 'director-library-summary-'));
  process.env.DATABASE_URL = `file:${path.join(directory, 'test.db')}`;
  process.env.PYTHON ??= 'python'; process.env.PYTHONUTF8 = '1'; process.env.PYTHONIOENCODING = 'utf-8';
  const sql = new DatabaseSync(path.join(directory, 'test.db'));
  for (const migration of readdirSync('prisma/migrations').sort()) if (/^\d/.test(migration)) sql.exec(readFileSync(path.join(repository, 'prisma/migrations', migration, 'migration.sql'), 'utf8'));
  sql.close();
  const queries: string[] = [];
  const db = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } }, log: [{ emit: 'event', level: 'query' }] });
  db.$on('query', event => queries.push(event.query));
  const { readProjectLibrarySummaries } = await import('../lib/project-library-summary');
  const delivery = await import('../lib/foundation-delivery');
  const { preprocessProject } = await import('../lib/project-preprocess');
  const { getProjectLibrary } = await import('../lib/project-library');
  try {
    const actor = await db.user.create({ data: { username: 'library-owner', email: 'library-owner@example.invalid', passwordHash: 'fixture' } });
    const outsider = await db.user.create({ data: { username: 'library-outsider', email: 'library-outsider@example.invalid', passwordHash: 'fixture' } });
    const create = async (numbers: number[]) => {
      const project = await db.project.create({ data: { title: 'synthetic library project', roles: { create: { userId: actor.id, role: 'ADMIN' } },
        episodes: { create: numbers.map(number => ({ number, content: `第${number}集\n${number}-1 客厅 日 内\n人物：甲\n△甲放下杯子。\n甲：我会帮你。\n` })) } } });
      if (numbers.length) await preprocessProject(project.id, db);
      return project;
    };
    const source = async (id: string, suffix = '') => {
      const episodes = await db.episode.findMany({ where: { projectId: id }, orderBy: { number: 'asc' } });
      let end = 0;
      const sections = episodes.map(episode => { const start = end; end += episode.content.length; return { key: `ep${episode.number}`, kind: 'EPISODE', episodeNumber: episode.number, start, end }; });
      return db.sceneSnapshot.create({ data: { projectId: id, sceneKey: 'SOURCE_IMPORT', metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }),
        content: JSON.stringify({ sourceText: episodes.map(episode => episode.content).join('') + suffix, sourceStructure: { version: 'SOURCE_STRUCTURE_V1', sections, issues: [] } }) } });
    };
    const ready = await create([0, 2]); await source(ready.id);
    const task = await delivery.queueFoundationDelivery(ready.id, {}, db);
    let syntheticBoundaries = 0;
    await delivery.executeFoundationDelivery(ready.id, task.id, { db, stageRunner: async (stage, prompt) => {
      syntheticBoundaries++;
      const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
      const data = stage === 'F2'
        ? { format: 'ASSET_CATALOG_V2', coverage: input.scope, assets: [{ name: '甲', type: 'CH', role: '主角', episodes: input.scope, sceneRefs: input.scope.map((episode: number) => [episode, `${episode}-1`]), preparation: { mode: 'REFERENCE' } }] }
        : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: {} };
      return { data, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null };
    } });
    assert.ok(syntheticBoundaries > 0); assert.equal((await delivery.getFoundationDeliveryState(ready.id, db)).complete, true, 'The actual controller creates a genuinely complete fixture');
    let checked = await compare(db, actor.id, [ready.id]);
    assert.equal(checked.get(ready.id)!.completionCheck, 'FULL');
    assert.deepEqual(checked.get(ready.id)!.productionScope, { sourceKnown: true, episodeNumbers: [0, 2] });
    const documentRow = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: ready.id, sceneKey: 'FOUNDATION_DOCUMENT' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const current = JSON.parse(documentRow.content);
    const allDocuments = await db.sceneSnapshot.findMany({ where: { projectId: ready.id, sceneKey: 'FOUNDATION_DOCUMENT' } });
    await db.sceneSnapshot.deleteMany({ where: { projectId: ready.id, sceneKey: 'FOUNDATION_DOCUMENT', id: { not: documentRow.id } } });
    await db.sceneSnapshot.update({ where: { id: documentRow.id }, data: { content: JSON.stringify({ ...current, editorialCoverage: [2] }) } });
    checked = await compare(db, actor.id, [ready.id]); assert.equal(checked.get(ready.id)!.completionCheck, 'EXCLUDED', 'Unedited episode 0 cannot disappear from the necessary conditions');
    await db.sceneSnapshot.update({ where: { id: documentRow.id }, data: { content: documentRow.content } });
    assert.equal((await compare(db, actor.id, [ready.id])).get(ready.id)!.complete, true, 'Request-time reads see restored valid coverage without cache expiry');
    await db.sceneSnapshot.update({ where: { id: documentRow.id }, data: { content: '{"workflow":"legacy","editorialCoverage":[],' + documentRow.content.slice(1) } });
    assert.equal((await compare(db, actor.id, [ready.id])).get(ready.id)!.complete, true, 'Duplicate root keys use JSON.parse semantics instead of SQLite first-key projection');
    await db.sceneSnapshot.update({ where: { id: documentRow.id }, data: { content: documentRow.content.replace('"f2":{', '"f2":{"coverage":[],') } });
    assert.equal((await compare(db, actor.id, [ready.id])).get(ready.id)!.complete, true, 'Duplicate nested catalogue keys also fall back to authoritative document reading');
    await db.sceneSnapshot.update({ where: { id: documentRow.id }, data: { content: documentRow.content } });
    const originalSource = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: ready.id, sceneKey: 'SOURCE_IMPORT' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const duplicateSource = await db.sceneSnapshot.create({ data: { projectId: ready.id, sceneKey: 'SOURCE_IMPORT', metadata: originalSource.metadata,
      content: '{"sourceStructure":{"sections":[{"kind":"EPISODE","episodeNumber":99}]},' + originalSource.content.slice(1), createdAt: new Date(Date.now() + 1000) } });
    assert.deepEqual((await compare(db, actor.id, [ready.id])).get(ready.id)!.productionScope, { sourceKnown: true, episodeNumbers: [0, 2] }, 'Duplicate source structure keys preserve the authoritative last-key semantics');
    await db.sceneSnapshot.delete({ where: { id: duplicateSource.id } });
    const registryAsset = await db.asset.findFirstOrThrow({ where: { projectId: ready.id } });
    await db.asset.update({ where: { id: registryAsset.id }, data: { metadata: JSON.stringify({ ...JSON.parse(registryAsset.metadata!), foundationCurrent: false }) } });
    assert.equal((await compare(db, actor.id, [ready.id])).get(ready.id)!.complete, false, 'Complete coverage cannot bypass current registered asset validation');
    await db.asset.update({ where: { id: registryAsset.id }, data: { metadata: registryAsset.metadata } });
    const running = await db.pipelineRun.create({ data: { projectId: ready.id, stageCode: 'synthetic-running', roleName: 'synthetic', status: 'RUNNING', inputSummary: '{}' } });
    assert.equal((await compare(db, actor.id, [ready.id])).get(ready.id)!.complete, false, 'An active run still blocks an otherwise completed document');
    await db.pipelineRun.delete({ where: { id: running.id } });
    const malformed = await db.sceneSnapshot.create({ data: { projectId: ready.id, sceneKey: 'FOUNDATION_DOCUMENT', content: '{broken', createdAt: new Date(Date.now() + 1000) } });
    assert.equal((await compare(db, actor.id, [ready.id])).get(ready.id)!.complete, true, 'A malformed latest document cannot hide an older valid document');
    await db.sceneSnapshot.delete({ where: { id: malformed.id } });
    await db.sceneSnapshot.update({ where: { id: documentRow.id }, data: { content: JSON.stringify({ ...current, workflow: undefined }) } });
    assert.equal((await compare(db, actor.id, [ready.id])).get(ready.id)!.complete, false, 'Legacy workflow is not mislabeled ready');
    await db.sceneSnapshot.update({ where: { id: documentRow.id }, data: { content: documentRow.content } });
    await db.sceneSnapshot.create({ data: { projectId: ready.id, sceneKey: 'SOURCE_IMPORT', content: '{bad latest source', createdAt: new Date(Date.now() + 1000) } });
    checked = await compare(db, actor.id, [ready.id]);
    assert.deepEqual(checked.get(ready.id)!.productionScope, { sourceKnown: true, episodeNumbers: [] }, 'A bad latest import never falls back to older valid source or positive all-episodes');
    assert.equal(checked.get(ready.id)!.complete, false);
    const stringStructure = await db.sceneSnapshot.create({ data: { projectId: ready.id, sceneKey: 'SOURCE_IMPORT', content: JSON.stringify({ sourceStructure: JSON.stringify({ sections: [{ kind: 'EPISODE', episodeNumber: 2 }] }) }), createdAt: new Date(Date.now() + 2000) } });
    assert.deepEqual((await compare(db, actor.id, [ready.id])).get(ready.id)!.productionScope, { sourceKnown: true, episodeNumbers: [] }, 'A string resembling a JSON structure cannot gain an episode scope through projection parsing');
    await db.sceneSnapshot.delete({ where: { id: stringStructure.id } });
    const empty = await create([]), legacy = await create([0, 1]), heavy = await create([1]);
    await db.sceneSnapshot.create({ data: { projectId: heavy.id, sceneKey: 'SOURCE_IMPORT', content: JSON.stringify({ sourceText: 'synthetic'.repeat(1_250_000), sourceStructure: { sections: [{ kind: 'EPISODE', episodeNumber: 1 }] } }) } });
    await db.pipelineRun.create({ data: { projectId: heavy.id, stageCode: 'Q1', roleName: 'synthetic editor', status: 'SUCCEEDED', inputSummary: '{}', log: 'synthetic'.repeat(1_250_000) } });
    await db.sceneSnapshot.create({ data: { projectId: heavy.id, sceneKey: 'FOUNDATION_DELIVERY_TASK', content: JSON.stringify({ status: 'COMPLETE' }) } });
    queries.length = 0;
    const cheap = await readProjectLibrarySummaries(actor.id, [heavy.id], db);
    assert.equal(cheap.get(heavy.id)!.complete, false); assert.equal(cheap.get(heavy.id)!.completionCheck, 'EXCLUDED');
    assert.ok(!queries.some(query => query.includes('PipelineRun')), 'Impossible completion never loads large paid histories');
    assert.ok(!queries.some(query => /SELECT[^]*`(?:main`\.)?`?SceneSnapshot`?\.`?content`?/i.test(query)), 'Only JSON projections cross the DB boundary');
    assert.ok(JSON.stringify([...cheap]).length < 1000, 'Ten-megabyte source/history is not returned in the library summary');
    checked = await compare(db, actor.id, [empty.id, legacy.id, heavy.id]);
    assert.deepEqual(checked.get(legacy.id)!.productionScope, { sourceKnown: false, episodeNumbers: [] }, 'Absent source retains the explicit legacy fallback contract');
    const { isProductionEpisodeNumber } = await import('../lib/production-episodes');
    assert.equal(isProductionEpisodeNumber(0, checked.get(legacy.id)!.productionScope), false); assert.equal(isProductionEpisodeNumber(1, checked.get(legacy.id)!.productionScope), true);
    await assert.rejects(readProjectLibrarySummaries(outsider.id, [ready.id], db), /无权/);
    assert.equal((await getProjectLibrary(outsider.id, db)).projects.length, 0);
    const all = (await getProjectLibrary(actor.id, db)).projects;
    await compare(db, actor.id, all.map(project => project.id));
    assert.ok(allDocuments.length > 0);
    console.log('PASS library summary: isolated real SQLite/controller; true complete fallback, missing editorial episode 0, fresh changes, malformed/legacy document history, empty projects, valid/absent/bad newest sources, permissions and ten-megabyte input/history exclusion; actual provider calls 0.');
  } finally {
    await db.$disconnect();
    const { prisma } = await import('../lib/prisma'); await prisma.$disconnect();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('director-library-summary-'));
    rmSync(directory, { recursive: true, force: true });
  }
}

(process.argv.includes('--live') ? live() : isolated()).catch(error => { console.error(error instanceof Error ? error.message.trim().split('\n').slice(-2).join('\n').slice(0, 500) : 'Library summary verification failed'); process.exitCode = 1; });
