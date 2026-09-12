/** Explicit local-only recovery; default runs on a new database snapshot, never on the live DB. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { getFoundationDeliveryState, queueFoundationDelivery, executeFoundationDelivery } from '@/lib/foundation-delivery';

async function main() {
  const args = process.argv.slice(2), apply = args.includes('--apply');
  const option = (name: string) => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
  const database = option('--database'), projectId = option('--project-id'), expectedRevision = option('--expected-revision');
  assert.ok(database && path.isAbsolute(database) && existsSync(database), '--database must name an existing absolute SQLite file');
  assert.ok(projectId && /^[a-z0-9-]+$/i.test(projectId), '--project-id is required');
  assert.ok(!apply || expectedRevision, '--apply requires the reviewed --expected-revision');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') continue;
    assert.ok(['--database', '--project-id', '--expected-revision'].includes(args[i]) && args[i + 1], 'Unknown recovery arguments'); i++;
  }
  const directory = mkdtempSync(path.join(tmpdir(), 'foundation-local-recovery-'));
  const sourceDb = realpathSync(database), snapshot = path.join(directory, 'before.db');
  execFileSync('sqlite3', ['-readonly', sourceDb, `.backup '${snapshot}'`], { timeout: 20000, stdio: 'pipe' });
  const target = apply ? sourceDb : path.join(directory, 'working.db');
  if (!apply) execFileSync('sqlite3', ['-readonly', `file:${snapshot}?immutable=1`, `.backup '${target}'`], { timeout: 20000, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: `file:${target}` });
  try {
    const before = await getFoundationDeliveryState(projectId, db);
    assert.ok(!before.busy && before.action !== 'UNKNOWN_CONFIRM' && !before.task?.unknownOutcome, 'A running or uncertain request cannot be locally recovered');
    if (expectedRevision) assert.equal(before.document.revision, expectedRevision, 'Document changed since the reviewed recovery');
    const originals = await db.pipelineRun.findMany({ where: { projectId }, orderBy: { id: 'asc' } });
    const originalIds = new Set(originals.map(run => run.id));
    const episodes = await db.episode.findMany({ where: { projectId }, orderBy: { number: 'asc' } });
    const refused: { stage: string; scope: number[] }[] = [];
    if (!before.complete) {
      const task = await queueFoundationDelivery(projectId, { expectedState: before.expectedState }, db);
      await executeFoundationDelivery(projectId, task.id, { db, stageRunner: async (stage, _prompt, context) => {
        refused.push({ stage, scope: [...context.scope] });
        throw Object.assign(new Error('本次只复验已保存响应；此范围尚无可接收结果，未发送新请求。'), { requestOutcome: 'NOT_SENT' });
      } });
    }
    const after = await getFoundationDeliveryState(projectId, db);
    const allRuns = await db.pipelineRun.findMany({ where: { projectId }, orderBy: { id: 'asc' } });
    assert.deepEqual(allRuns.filter(run => originalIds.has(run.id)), originals, 'Original provider evidence was modified');
    assert.deepEqual(await db.episode.findMany({ where: { projectId }, orderBy: { number: 'asc' } }), episodes, 'Original episode rows changed');
    const newRuns = allRuns.filter(run => !originalIds.has(run.id));
    for (const run of newRuns) {
      const calls = JSON.parse(run.log ?? '{}').calls ?? [];
      assert.ok(calls.every((call: { providerCallCount: number; requestOutcome: string }) => call.providerCallCount === 0 && call.requestOutcome === 'NOT_SENT'), 'Recovery unexpectedly recorded a dispatched request');
    }
    const report = { mode: apply ? 'APPLIED_LOCAL_ONLY' : 'ISOLATED_PREVIEW', projectId, directory, database: target,
      beforeRevision: before.document.revision, revision: after.document.revision, beforeEdited: before.document.editorialCoverage,
      editedEpisodes: after.document.editorialCoverage, totalEpisodes: after.totalEpisodes, availableEpisodes: after.availableEpisodes,
      sceneCount: await db.scriptScene.count({ where: { episode: { projectId } } }), baseAssets: after.document.f2?.assets.length,
      variants: after.document.f2?.assets.reduce((n, asset) => n + asset.variants.length, 0), complete: after.complete, action: after.action,
      taskStatus: after.task?.status, remainingIssues: after.issues.map(issue => ({ coordinate: issue.coordinate, problem: issue.problem })),
      remainingTodos: after.document.editorialTodos, refusedNewWork: refused, providerCalls: 0,
      historicalCalls: { before: before.task?.addedCalls ?? null, after: after.task?.addedCalls ?? null },
      historicalRepairCalls: { before: before.task?.repairCalls ?? null, after: after.task?.repairCalls ?? null },
      receiverBudget: { beforeUsed: before.task?.repairBudgetUsed ?? null, afterUsed: after.task?.repairBudgetUsed ?? null,
        changedDomain: before.task?.repairBudgetKey !== after.task?.repairBudgetKey, maximum: after.task?.maxRepairCalls ?? null,
        note: '接收契约变更可产生新的预算域；这不是历史费用清零，本工具始终不发新请求。' },
      originalRunRowsPreserved: originals.length, originalEpisodeRowsPreserved: episodes.length, newNotSentRuns: newRuns.length,
      recoveredRunIds: after.document.origins.filter(origin => !before.document.origins.some(old => old.runId === origin.runId)).map(origin => origin.runId),
      error: after.task?.error ?? null };
    writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report));
  } finally { await db.$disconnect(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
