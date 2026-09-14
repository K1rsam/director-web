/** Checkpointed v2 review stays pinned until explicit completion; disposable SQLite, no AI. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { normalize as normalizeV2 } from '../lib/fidelity-v2.mjs';
import { CONTRACT_VERSION } from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import { planP1ReviewBatches, type P1ReviewState } from '../lib/fidelity-p1-review';

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'fidelity-p1-upgrade-guard-'));
  const url = `file:${directory}/test.db`; process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  const { prepareFidelityImport } = await import('../lib/fidelity-import');
  const { readFidelityReceipt } = await import('../lib/fidelity-store');
  const { refreshFidelitySource } = await import('../lib/fidelity-refresh');
  try {
    assert.equal(CONTRACT_VERSION, 'fidelity/3', 'regression exercises a real parser-version upgrade');
    const text = '第一集\r\n场1-1 日 外 门口\r\n' + '甲乙：逐字保留 é😀。  \r\n'.repeat(1800);
    const batches = planP1ReviewBatches(text);
    assert(batches.length > 1);
    const bounds = batches.map(blocks => ({ start: blocks[0].start, end: blocks.at(-1)!.end }));
    const prepared = await prepareFidelityImport('offline-guard.txt', Buffer.from(text), 'fidelity');
    prepared.receipt.result = normalizeV2(text) as typeof prepared.receipt.result;
    assert.equal(prepared.receipt.result.contractVersion, 'fidelity/2');
    assert(prepared.receipt.result.validation.issues.some(issue => issue.code === 'SCENE_BOUNDARY_UNCONFIRMED'));
    const checkpoint: P1ReviewState = { status: 'PENDING', reviewedSourceVersion: prepared.receipt.readingHash, completedRanges: [bounds[0]], runIds: ['offline-paid-p1-first'], pendingDecisions: [], aliases: [] };
    prepared.receipt.p1Review = checkpoint;
    const project = await db.project.create({ data: { title: 'offline v2 pinned P1', episodes: { create: prepared.imported.episodes } } });
    const source = await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'SOURCE_IMPORT', content: JSON.stringify(prepared.imported), metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }) } });
    prepared.receipt.sourceImportId = source.id;
    const receipt = await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'FIDELITY_IMPORT', content: JSON.stringify(prepared.receipt) } });
    const before = (await readFidelityReceipt(project.id, db))!;
    const beforeEpisodes = await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } });
    const snapshots = await db.sceneSnapshot.count({ where: { projectId: project.id } });
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.deepEqual(await refreshFidelitySource(project.id, db), { changed: false });
      const unchanged = (await readFidelityReceipt(project.id, db))!;
      assert.deepEqual(unchanged, before, 'ordinary refresh cannot change receipt/source ids, issues, source hash or checkpoint');
      assert.deepEqual(await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } }), beforeEpisodes);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: project.id } }), snapshots);
    }
    await assert.rejects(refreshFidelitySource(project.id, db, { expectedReceiptId: 'stale-receipt' }), /来源|决定/);
    const completed: P1ReviewState = { ...checkpoint, status: 'COMPLETE', completedRanges: bounds, runIds: bounds.map((_, index) => index ? `offline-paid-p1-${index + 1}` : checkpoint.runIds![0]) };
    const changed = await refreshFidelitySource(project.id, db, { expectedReceiptId: receipt.id, expectedSourceId: source.id, p1Review: completed });
    assert.equal(changed.changed, true);
    const after = (await readFidelityReceipt(project.id, db))!;
    assert.equal(after.receipt.result.contractVersion, 'fidelity/3');
    assert.notEqual(after.snapshot.id, before.snapshot.id);
    assert.notEqual(after.sourceSnapshot!.id, before.sourceSnapshot!.id);
    assert.equal(after.receipt.readingHash, before.receipt.readingHash);
    assert.equal(after.receipt.originalHash, before.receipt.originalHash);
    assert.deepEqual(after.receipt.p1Review, completed);
    assert.deepEqual(after.receipt.p1Review!.completedRanges!.slice(0, 1), checkpoint.completedRanges);
    assert.equal(after.receipt.p1Review!.runIds![0], checkpoint.runIds![0]);
    assert.equal(after.receipt.result.validation.issues.filter(issue => issue.code === 'SCENE_BOUNDARY_UNCONFIRMED').length, 0, 'v3 recognizes the previously unrecognized explicit scene heading only after completion');
    assert.equal(after.receipt.result.segments.map(segment => segment.text).join(''), text);
    assert.equal(after.receipt.result.source.text, text);
    assert.equal(JSON.parse(after.sourceSnapshot!.content).sourceText, text);
    assert.deepEqual((await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } })).map(episode => [episode.id, episode.number, episode.content]), beforeEpisodes.map(episode => [episode.id, episode.number, episode.content]));
    assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({ where: { id: source.id } }), source, 'old source evidence is immutable');
    assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({ where: { id: receipt.id } }), receipt, 'old paid checkpoint receipt is immutable');
    assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), 0, 'local refresh does not fabricate or execute provider calls');
    console.log('PASS v2 checkpoint ordinary refresh pinned; explicit P1 completion upgrades to v3; exact source, episode identities, old evidence and completed run/ranges preserved; no AI');
  } finally {
    await db.$disconnect();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
