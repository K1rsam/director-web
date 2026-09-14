/** Completed P1 checkpoint + NOT_SENT continuation. Isolated SQLite, no real provider. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { planP1ReviewBatches, projectP1ReviewRequest, projectP1ReviewEvidenceRequest, type P1ReviewRequest } from '@/lib/fidelity-p1-review';

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'p1-not-sent-recovery-')), url = `file:${directory}/test.db`;
  process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  const { prepareFidelityImport } = await import('@/lib/fidelity-import');
  const { prepareFidelitySourceAssisted } = await import('@/lib/fidelity-source-assist');
  const { readFidelityReceipt } = await import('@/lib/fidelity-store');
  const text = '第1集\n1-1 日 内 大厅\n' + '甲：完整原文，不改一字。\n'.repeat(4200);
  const batches = planP1ReviewBatches(text);
  assert.ok(batches.length > 1);
  try {
    const prepared = await prepareFidelityImport('offline.txt', Buffer.from(text), 'fidelity');
    prepared.receipt.p1Review = { status: 'PENDING' };
    const second = batches[1];
    // Same diagnostic repeated per block/line, like the observed oversized second batch.
    prepared.receipt.result.validation.issues.push(...Array.from({ length: 1500 }, (_, i) => ({ code: 'REPEATED_BOUNDARY_DIAGNOSTIC', message: '相同的结构诊断文字，只需保留一次并完整保留所有来源块关联。', start: second[i % second.length].start, end: second[i % second.length].end })));
    const project = await db.project.create({ data: { title: 'offline P1 checkpoint recovery', episodes: { create: prepared.imported.episodes } } });
    const source = await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'SOURCE_IMPORT', content: JSON.stringify(prepared.imported), metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }) } });
    prepared.receipt.sourceImportId = source.id;
    await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'FIDELITY_IMPORT', content: JSON.stringify(prepared.receipt) } });
    const firstAcceptedBounds = { start: batches[0][0].start, end: batches[0].at(-1)!.end };
    const seen: number[] = [], accepted: number[] = [];
    let failBeforeSend = true, diagnosed = false;
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const assist = async (raw: Parameters<Parameters<typeof prepareFidelitySourceAssisted>[2]['assist']>[0], validate: Parameters<Parameters<typeof prepareFidelitySourceAssisted>[2]['assist']>[1]) => {
      const request = raw as P1ReviewRequest;
      assert.ok(!request.repairAttempt, 'clean actual source should not require an extra review repair');
      seen.push(request.batch.index);
      if (request.batch.index === 2) {
        const wire = projectP1ReviewRequest(request), oldCompact = { ...wire, issues: structuredClone(request.issues) };
        const oldChars = JSON.stringify(oldCompact).length, newChars = JSON.stringify(wire).length;
        assert.ok(oldChars > 100000 && newChars < oldChars / 2, 'repeated diagnostic payload must actually shrink without dropping source');
        assert.equal(wire.blocks.map(row => row[1]).join(''), text.slice(second[0].start, second.at(-1)!.end));
        const refs = (issues: typeof request.issues) => [...new Set(issues.flatMap(row => row.sectionKeys))].sort();
        assert.deepEqual(refs(wire.issues ?? []), refs(request.issues));
        const fingerprint = (value: Record<string, unknown>) => digest({ receiver: 'FIDELITY_SOURCE_ACCEPT_V2', request: projectP1ReviewEvidenceRequest(value) });
        assert.equal(fingerprint(oldCompact), fingerprint(wire), 'old compact paid evidence must match new deduplicated projection');
        assert.equal(fingerprint(request as unknown as Record<string, unknown>), fingerprint(wire), 'legacy full and compact request fingerprints must match');
        diagnosed = true;
        if (failBeforeSend) throw Object.assign(new Error('offline budget blocked before sending batch 2'), { requestOutcome: 'NOT_SENT' });
      }
      const plan = { sourceVersion: request.sourceVersion, reviewed: { firstBlock: request.batch.firstBlock, lastBlock: request.batch.lastBlock }, assignments: [], unresolved: [], aliases: [] };
      accepted.push(request.batch.index);
      return { plan: validate(plan), runId: `offline-accepted-batch-${request.batch.index}` };
    };
    const options = { checkCurrent: async () => {}, assist };
    await assert.rejects(prepareFidelitySourceAssisted(project.id, db, options), /before sending batch 2/);
    const checkpoint = (await readFidelityReceipt(project.id, db))!;
    assert.deepEqual(checkpoint.receipt.p1Review?.completedRanges, [firstAcceptedBounds]);
    assert.deepEqual(checkpoint.receipt.p1Review?.runIds, ['offline-accepted-batch-1']);
    failBeforeSend = false;
    await prepareFidelitySourceAssisted(project.id, db, options);
    const final = (await readFidelityReceipt(project.id, db))!;
    assert.equal(diagnosed, true);
    assert.equal(seen.filter(index => index === 1).length, 1, 'completed first batch must never call assist again');
    assert.equal(seen.filter(index => index === 2).length, 2, 'NOT_SENT batch may resume once, then checkpoint normally');
    assert.deepEqual(accepted, batches.map((_, index) => index + 1), 'each batch is actually accepted once');
    assert.equal(final.receipt.p1Review?.status, 'COMPLETE');
    assert.equal(final.receipt.result.source.text, text);
    assert.equal(final.receipt.readingHash, checkpoint.receipt.readingHash);
    assert.equal((await db.sceneSnapshot.findUniqueOrThrow({ where: { id: source.id } })).content, source.content, 'original immutable source record cannot change');
    await prepareFidelitySourceAssisted(project.id, db, { checkCurrent: async () => {}, assist: async () => { throw new Error('completed review must not call provider'); } });
    console.log('PASS P1 NOT_SENT recovery: first paid checkpoint skipped, unsent batch resumes, all source blocks once, old/full/compact cost fingerprints equivalent, completed review no call (offline SQLite)');
  } finally {
    await db.$disconnect();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { console.warn('Temporary fixture retained:', directory); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
