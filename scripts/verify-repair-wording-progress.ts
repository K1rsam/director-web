/** Real controller; only offline responses in a disposable SQLite database. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '../lib/role-runner';
async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'repair-wording-progress-'));
  const url = `file:${directory}/test.db`; process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  const api = await import('../lib/foundation-delivery');
  const response = (data: unknown): RoleRunResult => ({ data: data as Record<string, unknown>, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null });
  try {
    const project = await db.project.create({ data: { title: '仅改待定说明不重复修复', episodes: { create: { number: 1, content: '第1集\n1-1 日 外 驿站\n人物：南桥守卫\n△南桥守卫抬头。\n' } } } });
    const task = await api.queueFoundationDelivery(project.id, {}, db);
    const phases: string[] = [];
    await api.executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => {
      const value = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
      phases.push(stage === 'F2' ? 'F2' : value.delivery.mode);
      if (stage === 'F2') return response({ format: 'ASSET_CATALOG_V2', coverage: [1], assets: [{ name: '南桥守卫', type: 'CH', episodes: [1], sceneRefs: [{ episode: 1, sceneKey: '1-1' }], preparation: { mode: 'UNRESOLVED', note: '制作方式尚待决定' } }] });
      return response({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: { assets: [{ key: value.candidates.f2.assets[0].key, preparation: { mode: 'UNRESOLVED', note: `仍然不能确定制作方式，说明版本${phases.length}` } }] }, notes: [`仅说明版本${phases.length}`] });
    } });
    const state = await api.getFoundationDeliveryState(project.id, db);
    console.log(JSON.stringify({ phases, repairCalls: state.task?.repairCalls, repairBudgetUsed: state.task?.repairBudgetUsed, action: state.action }));
    assert.deepEqual(phases, ['F2', 'EDIT', 'REPAIR'], 'rewriting unresolved preparation.note must stop after the first ineffective repair');
    assert.equal(state.action, 'BLOCKED');
    assert.equal(state.task?.repairBudgetUsed, 1);
    assert.equal(state.document.f2!.assets[0].preparation?.mode, 'UNRESOLVED');
    const runs = await db.pipelineRun.count({ where: { projectId: project.id } });
    await assert.rejects(api.queueFoundationDelivery(project.id, {}, db), /进展|重复|修改/);
    await db.sceneSnapshot.delete({ where: { id: `foundation-delivery-${project.id}` } });
    await assert.rejects(api.queueFoundationDelivery(project.id, {}, db), /进展|重复|修改/);
    assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), runs, 'continue or task recreation cannot repurchase a no-progress repair');
    console.log('PASS no-progress preparation wording drift stops one repair; continuation and task recreation stay blocked without a new call');
  } finally {
    await db.$disconnect();
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
