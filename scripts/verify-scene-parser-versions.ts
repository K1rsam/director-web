/** Actual preprocessing/split binding in disposable SQLite; no provider. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'scene-version-check-'));
  const url = `file:${directory}/check.db`; process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe', timeout: 20000 });
  const db = new PrismaClient({ datasourceUrl: url });
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const { preprocessProject } = await import('@/lib/project-preprocess');
  const { parseSceneBatch } = await import('@/lib/source-parser');
  const { buildSourceIndex } = await import('@/lib/project-foundation-contracts');
  const { previewSceneSplitPlans, applySceneSplitPlans } = await import('@/lib/scene-split-plan');
  const failures: string[] = [];
  const check = async (name: string, run: () => Promise<void>) => { try { await run(); console.log(`PASS ${name}`); } catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : error}`); } };
  const episodes = [1, 2].map(number => ({ number, title: `第${number}集`, content: `第${number}集\r\n${number}.1 日，内，甲厅\r\n人物：甲\r\n甲：来了。😀  \r\n${number}.2 夜，外，乙院\r\n人物：甲\r\n甲：走吧。\r\n` }));
  const create = (title: string) => db.project.create({ data: { title, episodes: { create: structuredClone(episodes) } } });
  const sourceRow = (projectId: string) => db.sceneSnapshot.findFirstOrThrow({ where: { projectId, sceneKey: 'FOUNDATION_SOURCE' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const sceneRows = (projectId: string) => db.scriptScene.findMany({ where: { episode: { projectId } }, orderBy: [{ episode: { number: 'asc' } }, { sortOrder: 'asc' }] });
  async function createLegacy() {
    const project = await create('historical whole-episode scene basis');
    const rows = await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } });
    const index = buildSourceIndex(rows);
    await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'FOUNDATION_SOURCE', content: JSON.stringify({ schema: 'FOUNDATION_SOURCE_V1', sourceVersion: index.version, sourceIndex: index }), metadata: JSON.stringify({ schema: 'FOUNDATION_SOURCE_V1', sourceVersion: index.version }) } });
    const parsed = (parseSceneBatch as (...args: any[]) => ReturnType<typeof parseSceneBatch>)(rows, [], { versions: { 1: 'SCENE_PARSER_V1', 2: 'SCENE_PARSER_V1' } });
    for (const entry of parsed) for (const scene of entry.scenes) await db.scriptScene.create({ data: { ...scene, episodeId: rows.find(row => row.number === entry.episodeNumber)!.id, metadata: JSON.stringify({ ...scene.metadata, sourceHash: hash(scene.sourceText) }) } });
    return { project, rows };
  }
  try {
    await check('new source writes its explicit V2 scene interpretation', async () => {
      const project = await create('fresh dot source'); await preprocessProject(project.id, db);
      const body = JSON.parse((await sourceRow(project.id)).content);
      assert.deepEqual(body.sceneParserVersions, { 1: 'SCENE_PARSER_V2', 2: 'SCENE_PARSER_V2' });
      const scenes = await sceneRows(project.id); assert.equal(scenes.length, 4);
      for (const episode of await db.episode.findMany({ where: { projectId: project.id } })) assert.equal(scenes.filter(scene => scene.episodeId === episode.id).map(scene => scene.sourceText).join(''), episode.content);
    });
    await check('unchanged old source retains its consumed scene keys and rows', async () => {
      const { project } = await createLegacy(), before = await sceneRows(project.id);
      assert.equal(before.length, 2);
      await preprocessProject(project.id, db);
      assert.deepEqual(await sceneRows(project.id), before);
      assert.deepEqual(JSON.parse((await sourceRow(project.id)).content).sceneParserVersions, { 1: 'SCENE_PARSER_V1', 2: 'SCENE_PARSER_V1' });
    });
    await check('changed episode opts into V2 without changing an untouched V1 episode', async () => {
      const { project, rows } = await createLegacy(); const untouched = (await sceneRows(project.id)).find(scene => scene.episodeId === rows[1].id)!;
      await db.episode.update({ where: { id: rows[0].id }, data: { content: rows[0].content.replace('来了。', '真的来了。') } });
      await preprocessProject(project.id, db);
      const scenes = await sceneRows(project.id);
      assert.equal(scenes.filter(scene => scene.episodeId === rows[0].id).length, 2);
      assert.deepEqual(scenes.find(scene => scene.id === untouched.id), untouched);
      assert.deepEqual(JSON.parse((await sourceRow(project.id)).content).sceneParserVersions, { 1: 'SCENE_PARSER_V2', 2: 'SCENE_PARSER_V1' });
    });
    await check('old whole-episode split remains valid when the new parser knows dots', async () => {
      const { project, rows } = await createLegacy();
      const plan = { episode: 1, sceneKey: '1-1', sourceHash: hash(rows[0].content), cuts: [{ startLine: 5, anchor: '1.2 夜，外，乙院', location: '乙院', timeOfDay: '夜', interiorExterior: '外' }] };
      const preview = await previewSceneSplitPlans(project.id, db, [plan]);
      assert.deepEqual(preview.filter(scene => scene.episode === 1).map(scene => scene.sceneKey), ['1-1', '1-1__L5']);
      await db.$transaction(tx => applySceneSplitPlans(project.id, tx, [plan]));
      const before = await sceneRows(project.id); await preprocessProject(project.id, db);
      assert.deepEqual(await sceneRows(project.id), before);
      assert.equal(before.filter(scene => scene.episodeId === rows[0].id).map(scene => scene.sourceText).join(''), rows[0].content);
    });
    await check('unknown explicit parser versions cannot silently change interpretation', async () => {
      for (const version of ['future-unknown', null]) {
        const { project } = await createLegacy(), original = await sourceRow(project.id);
        await db.sceneSnapshot.update({ where: { id: original.id }, data: { content: JSON.stringify({ ...JSON.parse(original.content), sceneParserVersions: { 1: version, 2: 'SCENE_PARSER_V1' } }) } });
        const before = await sceneRows(project.id);
        await assert.rejects(preprocessProject(project.id, db), /解析.*版本|version/i);
        assert.deepEqual(await sceneRows(project.id), before);
      }
    });
    assert.deepEqual(failures, []);
  } finally { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
