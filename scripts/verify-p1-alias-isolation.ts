/** Optional aliases cannot invalidate accepted structure; isolated SQLite and offline responses. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { planP1ReviewBatches, projectP1ReviewRequest, validateP1ReviewPlan, type P1ReviewRequest, type P1ReviewState } from '../lib/fidelity-p1-review';
const text = '未命名剧本\n第1集\n场1-1 日 内 门厅\n甲：我是小甲。\n小甲：走。\n';
const blocks = planP1ReviewBatches(text)[0];
const request: P1ReviewRequest = { reviewMode: 'FULL_STRUCTURE_V1', sourceVersion: 'offline-source', sourceLength: text.length, batch: { firstBlock: blocks[0].id, lastBlock: blocks.at(-1)!.id, index: 1, total: 1 }, sections: blocks.map(block => ({ key: block.id, start: block.start, end: block.end, text: block.text })), issues: [], baseline: [] };
const answer = (value: P1ReviewRequest) => ({ sourceVersion: value.sourceVersion, reviewed: { firstBlock: value.batch.firstBlock, lastBlock: value.batch.lastBlock }, assignments: [], unresolved: [], aliases: [] as unknown[] });
const validAlias = { alias: '小甲', canonicalCandidate: '甲', firstBlock: blocks[3].id, lastBlock: blocks[4].id, note: '称呼原文可见，保留为候选' };
const badAlias = { ...validAlias, canonicalCandidate: '原文没有的人名' };
const raw = { ...answer(request), assignments: [{ firstBlock: blocks[0].id, lastBlock: blocks[0].id, kind: 'context', note: '独立文档标题' }], aliases: [validAlias, badAlias, { ...validAlias, firstBlock: 'B999999' }, null] };
const before = structuredClone(raw), wireBefore = projectP1ReviewRequest(request);
const accepted = validateP1ReviewPlan(raw, request);
assert.equal(accepted.decisions.length, 1);
assert.equal(accepted.aliases.length, 1);
assert.equal(accepted.aliases[0].alias, '小甲');
assert.deepEqual(accepted.candidateWarnings!.map(warning => warning.index), [1, 2, 3]);
for (const warning of accepted.candidateWarnings!) {
  assert.equal(warning.sourceVersion, request.sourceVersion);
  assert.deepEqual(warning.batch, request.batch);
  assert(warning.reason.length > 0);
  assert(!('start' in warning) && !('end' in warning), 'unreliable alias evidence never receives invented offsets');
}
assert.deepEqual(raw, before, 'the raw response remains intact for the existing run evidence log');
assert.deepEqual(projectP1ReviewRequest(request), wireBefore, 'candidate isolation does not alter the paid request projection');
assert.equal(validateP1ReviewPlan({ ...answer(request), aliases: { alias: 'bad container' } }, request).candidateWarnings![0].index, null);
for (const changed of [
  { sourceVersion: 'stale-source' },
  { reviewed: { firstBlock: 'B999999', lastBlock: request.batch.lastBlock } },
  { assignments: [{ firstBlock: 'B999999', lastBlock: blocks[0].id, kind: 'context', note: '无效核心结构' }] },
  { unresolved: [{ firstBlock: 'B999999', lastBlock: blocks[0].id, note: '无效核心未决' }] },
  { replacementText: '不允许改写正文' },
]) assert.throws(() => validateP1ReviewPlan({ ...raw, ...changed }, request), 'invalid core must still reject the entire response');

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'p1-alias-isolation-'));
  const url = `file:${directory}/test.db`; process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  const { prepareFidelityImport } = await import('../lib/fidelity-import');
  const { readFidelityReceipt } = await import('../lib/fidelity-store');
  const { prepareFidelitySourceAssisted } = await import('../lib/fidelity-source-assist');
  const { fidelityReviewCandidates } = await import('../lib/fidelity-review-candidates');
  try {
    const prepared = await prepareFidelityImport('offline.txt', Buffer.from(text), 'fidelity');
    prepared.receipt.p1Review = { status: 'PENDING' };
    const project = await db.project.create({ data: { title: 'offline alias quarantine', episodes: { create: prepared.imported.episodes } } });
    const source = await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'SOURCE_IMPORT', content: JSON.stringify(prepared.imported), metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }) } });
    prepared.receipt.sourceImportId = source.id;
    await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'FIDELITY_IMPORT', content: JSON.stringify(prepared.receipt) } });
    const seen: P1ReviewRequest[] = [];
    await prepareFidelitySourceAssisted(project.id, db, { checkCurrent: async () => {}, checkAfterCommit: async () => {}, assist: async (input, validate) => {
      const value = input as P1ReviewRequest; seen.push(value);
      const plan = value.repairAttempt ? { ...answer(value), assignments: [{ firstBlock: value.sections[0].key, lastBlock: value.sections[0].key, kind: 'context', note: '独立文档标题' }], aliases: [{ ...badAlias, firstBlock: 'B999999' }] } : { ...answer(value), aliases: [validAlias, badAlias] };
      const original = structuredClone(plan); validate(plan); assert.deepEqual(plan, original);
      return { plan: validate(plan), runId: value.repairAttempt ? 'offline-local-repair' : 'offline-full-review' };
    } });
    assert.equal(seen.length, 2, 'one full review and one genuine title repair, no alias retry');
    const rows = await db.sceneSnapshot.findMany({ where: { projectId: project.id, sceneKey: 'FIDELITY_IMPORT' } });
    const full = JSON.parse(rows.find(row => row.title === 'P1原稿结构检查进度')!.content).p1Review as P1ReviewState;
    const repair = JSON.parse(rows.find(row => row.title === 'P1局部结构补漏进度')!.content).p1Review as P1ReviewState;
    assert.equal(full.candidateWarnings!.length, 1);
    assert.equal(full.candidateWarnings![0].runId, 'offline-full-review');
    assert.equal(repair.candidateWarnings!.length, 2);
    assert.equal(repair.candidateWarnings![1].runId, 'offline-local-repair');
    assert.equal(repair.candidateWarnings![1].repairAttempt, 1);
    const final = (await readFidelityReceipt(project.id, db))!.receipt;
    const state = final.p1Review as P1ReviewState;
    assert.equal(state.status, 'COMPLETE');
    assert.deepEqual(state.candidateWarnings, repair.candidateWarnings, 'both checkpoint warnings persist in the final receipt');
    assert.equal(state.aliases!.length, 1);
    const candidates = fidelityReviewCandidates(final);
    assert.equal(candidates.filter(candidate => candidate.kind === 'ALIAS').length, 1);
    assert(!JSON.stringify(candidates).includes('原文没有的人名'), 'unproven aliases never enter the identity candidate supply');
    assert.equal(final.result.source.text, text);
    assert.equal(final.result.segments.map(segment => segment.text).join(''), text);
    await prepareFidelitySourceAssisted(project.id, db, { checkCurrent: async () => {}, assist: async () => { throw new Error('completed structural review must not repeat for quarantined aliases'); } });
    assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), 0, 'offline fixture never called or fabricated provider runs');
    console.log('PASS invalid alias isolation, valid candidates/core retention, strict core rejection, raw response stability, full/local/final warning persistence and no identity contamination');
  } finally {
    await db.$disconnect(); assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
