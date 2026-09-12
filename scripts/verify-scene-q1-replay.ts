/** Recover the production controller's paid evidence locally, including old scene coordinates. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '@/lib/role-runner';

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'scene-q1-replay-')), url = `file:${directory}/check.db`;
  process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe', timeout: 20000 });
  const db = new PrismaClient({ datasourceUrl: url });
  const response = (data: unknown): RoleRunResult => ({ data: data as Record<string, unknown>, stdout: '', stderr: '', sessionId: null, rawOutput: JSON.stringify(data) });
  try {
    const { queueFoundationDelivery, executeFoundationDelivery, getFoundationDeliveryState, applyFoundationProgramRepair } = await import('@/lib/foundation-delivery');
    const { buildSourceIndex, hashFoundationPrompt } = await import('@/lib/project-foundation-contracts');
    const { parseSceneBatch } = await import('@/lib/source-parser');
    const { readLightEpisodeFoundation } = await import('@/lib/light-foundation-reader');
    const content = '第1集\r\n1.1 日，内，甲厅\r\n人物：甲\r\n甲：来了。😀  \r\n1.2 夜，外，乙院\r\n人物：甲\r\n甲：走吧。\r\n';
    const project = await db.project.create({ data: { title: 'historical scene response recovery', episodes: { create: { number: 1, title: '第1集', content } } } });
    const episode = await db.episode.findFirstOrThrow({ where: { projectId: project.id } }), index = buildSourceIndex([episode]);
    await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'SOURCE_IMPORT', metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }), content: JSON.stringify({ sourceText: content,
      sourceStructure: { version: 'SOURCE_STRUCTURE_V1', issues: [], sections: [{ key: 'ep1', kind: 'EPISODE', episodeNumber: 1, start: 0, end: content.length }] } }) } });
    await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'FOUNDATION_SOURCE', content: JSON.stringify({ schema: 'FOUNDATION_SOURCE_V1', sourceVersion: index.version, sourceIndex: index }), metadata: JSON.stringify({ schema: 'FOUNDATION_SOURCE_V1', sourceVersion: index.version }) } });
    for (const scene of parseSceneBatch([episode], [], { versions: { 1: 'SCENE_PARSER_V1' } })[0].scenes) await db.scriptScene.create({ data: { ...scene, episodeId: episode.id, metadata: JSON.stringify({ ...scene.metadata, sourceHash: createHash('sha256').update(scene.sourceText).digest('hex') }) } });
    const catalog = { format: 'ASSET_CATALOG_V2', coverage: [1], assets: [{ name: '甲', type: 'CH', episodes: [1], sceneRefs: [{ episode: 1, sceneKey: '1-1' }], preparation: { mode: 'REFERENCE' } }] };
    let saved: Record<string, unknown> | null = null, calls = 0;
    const task = await queueFoundationDelivery(project.id, {}, db);
    await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async stage => {
      calls++;
      if (stage === 'F2') return response(catalog);
      assert.equal(stage, 'Q1');
      const state = await getFoundationDeliveryState(project.id, db), key = state.document.f2!.assets[0].key;
      saved = { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {
        assets: [{ key, episodes: [1], sceneRefs: [{ episode: 1, sceneKey: '1-1' }, { episode: 1, sceneKey: '1-1__L5' }] }],
        sceneSplits: [{ episode: 1, sceneKey: '1-1', cuts: [
          { startLine: 1, anchor: '第1集\r\n', location: '甲厅', timeOfDay: '日', interiorExterior: '内', timeLayer: '现实' },
          { startLine: 5, anchor: '1.2 夜，外，乙院\r\n', location: '乙院', timeOfDay: '夜', interiorExterior: '外' }
        ] }]
      } };
      // Transport returned its complete body but the historical receiver did not accept it.
      throw Object.assign(new Error('historical receiver failure with paid body'), { requestOutcome: 'RESPONDED', rawOutput: JSON.stringify(saved) });
    } });
    assert.equal(calls, 2); assert.ok(saved);
    const runsBefore = await db.pipelineRun.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } });
    const episodesBefore = await db.episode.findMany({ where: { projectId: project.id } });
    const before = await getFoundationDeliveryState(project.id, db);
    assert.ok(before.action === 'CONTINUE' || before.action === 'START', `Existing response must become locally restorable, got ${before.action}: ${before.continuationBlocker}`);
    const retry = await queueFoundationDelivery(project.id, {}, db);
    await executeFoundationDelivery(project.id, retry.id, { db, stageRunner: async () => { calls++; throw Object.assign(new Error('no new provider request is authorized'), { requestOutcome: 'NOT_SENT' }); } });
    const after = await getFoundationDeliveryState(project.id, db);
    assert.equal(calls, 2, 'No fresh F2/Q1 request is allowed during replay');
    assert.ok(after.complete, after.task?.error ?? after.issues.map(issue => issue.problem).join(';'));
    assert.deepEqual(after.document.editorialCoverage, [1]);
    assert.deepEqual(await db.pipelineRun.findMany({ where: { projectId: project.id }, orderBy: { createdAt: 'asc' } }), runsBefore, 'Old paid evidence must remain byte-for-byte represented in its original rows');
    assert.deepEqual(await db.episode.findMany({ where: { projectId: project.id } }), episodesBefore);
    const read = await readLightEpisodeFoundation(project.id, 1, db);
    assert.equal(read.readiness, 'READY', read.reasons.join(';'));
    assert.equal(read.packet.sourceText, content);
    assert.deepEqual(read.packet.scenes.map(scene => scene.sceneKey), ['1-1', '1-1__L5']);
    assert.deepEqual(read.packet.scenes.map(scene => [scene.location, scene.timeOfDay, scene.interiorExterior]), [['甲厅', '日', '内'], ['乙院', '夜', '外']]);
    assert.equal(read.packet.scenes[0].timeLayer, '现实');
    const rowsBefore = await db.scriptScene.findMany({ where: { episodeId: episode.id }, orderBy: { sortOrder: 'asc' } });
    const canonical = { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: { sceneSplits: [{ episode: 1, sceneKey: '1-1', sourceHash: hashFoundationPrompt(content), cuts: [{ startLine: 5, anchor: '1.2 夜，外，乙院', location: '乙院', timeOfDay: '夜', interiorExterior: '外' }] }] } };
    const plansBefore = await db.sceneSnapshot.count({ where: { projectId: project.id, sceneKey: 'SOURCE_SCENE_SPLIT_PLAN' } });
    await applyFoundationProgramRepair(project.id, { expectedRevision: after.document.revision, scope: [1], output: canonical }, db);
    assert.deepEqual(await db.scriptScene.findMany({ where: { episodeId: episode.id }, orderBy: { sortOrder: 'asc' } }), rowsBefore, 'Canonical saved plan replay must use its original whole family, preserve first-scene metadata and be idempotent');
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: project.id, sceneKey: 'SOURCE_SCENE_SPLIT_PLAN' } }), plansBefore);
    assert.equal(calls, 2);
    const current = await getFoundationDeliveryState(project.id, db), previewFile = `${directory}/preview.json`;
    writeFileSync(previewFile, JSON.stringify({ projectId: project.id, expectedRevision: current.document.revision, scope: [1], output: saved }), { mode: 0o600 });
    const previewCount = await db.sceneSnapshot.count({ where: { projectId: project.id } });
    const cliPreview = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/apply-foundation-program-repair.ts', '--plan', previewFile], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: url }, timeout: 20000 });
    assert.equal(JSON.parse(cliPreview.trim()).mode, 'PREVIEW');
    assert.equal((await getFoundationDeliveryState(project.id, db)).document.revision, current.document.revision);
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: project.id } }), previewCount, 'The actual maintenance CLI preview must remain read-only');
    console.log('PASS actual controller: source-bound EOL/first-segment replay, stable old scene keys, no additional requests, preserved evidence and idempotent canonical plan');
  } finally { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
