/** Disposable SQLite and offline responses only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '@/lib/role-runner';

async function main() {
  const dir = mkdtempSync(path.join(tmpdir(), 'decision-collection-'));
  const url = `file:${dir}/test.db`; process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${dir}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${dir}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const api = await import('@/lib/foundation-delivery');
    const project = await db.project.create({ data: { title: 'offline collect choices', episodes: { create: { number: 1, content: '第1集\n1-1 日 外 广场\n甲：来了。\n' } } } });
    let calls = 0;
    const task = await api.queueFoundationDelivery(project.id, {}, db);
    await api.executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => {
      calls++;
      const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
      const data = stage === 'F2' ? { format: 'ASSET_CATALOG_V2', coverage: input.scope, assets: [] } : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: {}, humanChoices: [1, 2, 3].map(n => ({ decisionKey: `choice-${n}`, kind: 'PRODUCTION_CHOICE', question: `第${n}项采用哪个方案？`, options: ['方案甲', '方案乙'], recommended: '方案甲', recommendationReason: '需要确认', reason: '本阶段必须确认', evidence: '甲：来了。', episodes: [1] })) };
      return { data, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null } as RoleRunResult;
    } });
    const initial = await api.getFoundationDeliveryState(project.id, db);
    assert.equal(initial.requiredChoices.length, 3);
    const beforeRuns = await db.pipelineRun.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } });
    const beforeCalls = calls;
    const args = initial.requiredChoices.map(choice => ({ projectId: project.id, contractId: choice.id, revision: choice.revision, expectedTaskId: task.id, optionIndex: '0' }));
    await assert.rejects(api.confirmAndContinueFoundationDelivery(db, { ...args[0], expectedTaskId: 'obsolete' }));
    await assert.rejects(api.confirmAndContinueFoundationDelivery(db, { ...args[0], revision: 'obsolete' }));
    assert.equal(await api.confirmAndContinueFoundationDelivery(db, args[0]), null);
    let state = await api.getFoundationDeliveryState(project.id, db);
    assert.equal(state.requiredChoices.length, 2); assert.equal(state.confirmedChoices.length, 1);
    assert.deepEqual(state.task, initial.task, 'partial confirmation must not update or queue a task');
    await assert.rejects(api.confirmAndContinueFoundationDelivery(db, { ...args[0], optionIndex: '1' }), 'stale answer cannot overwrite a saved choice');
    assert.equal(await api.confirmAndContinueFoundationDelivery(db, args[1]), null);
    state = await api.getFoundationDeliveryState(project.id, db);
    assert.equal(state.requiredChoices.length, 1); assert.equal(state.confirmedChoices.length, 2);
    assert.deepEqual(state.task, initial.task);
    assert.deepEqual(await db.pipelineRun.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } }), beforeRuns);
    // Race two stale copies of the last form: only one may queue work.
    const results = await Promise.allSettled([api.confirmAndContinueFoundationDelivery(db, args[2]), api.confirmAndContinueFoundationDelivery(db, { ...args[2], optionIndex: '1' })]);
    const accepted = results.filter(row => row.status === 'fulfilled');
    assert.equal(accepted.length, 1); assert.equal(results.filter(row => row.status === 'rejected').length, 1);
    assert.ok(accepted[0].status === 'fulfilled' && accepted[0].value);
    assert.equal(accepted[0].value.status, 'QUEUED');
    state = await api.getFoundationDeliveryState(project.id, db);
    assert.equal(state.requiredChoices.length, 0); assert.equal(state.confirmedChoices.length, 3);
    assert.equal(state.task?.status, 'QUEUED'); assert.equal(calls, beforeCalls);
    assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), beforeRuns.length, 'queueing does not call a provider');
    const persisted = await db.presentationContract.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } });
    await assert.rejects(api.confirmAndContinueFoundationDelivery(db, args[2]));
    assert.deepEqual(await db.presentationContract.findMany({ where: { projectId: project.id }, orderBy: { id: 'asc' } }), persisted);
    console.log('PASS partial choices persist without task/model activity; last answer queues once; stale/concurrent submissions cannot overwrite answers');
  } finally { await db.$disconnect(); rmSync(dir, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

