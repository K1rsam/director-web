/** No providers: test receipt-only continuation after two legitimate repair rounds. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '@/lib/role-runner';
import type { HumanChoice } from '@/lib/foundation-human-choices';

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'missing-receipt-loop-')), url = `file:${directory}/test.db`;
  process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  const api = await import('@/lib/foundation-delivery');
  const { preprocessProject } = await import('@/lib/project-preprocess');
  const { loadFoundationInputs } = await import('@/lib/foundation-state');
  const { createEmptyDocument, mergeDocumentF2, saveFoundationDocument } = await import('@/lib/foundation-document');
  const { requireProductionCatalogAuthor } = await import('@/lib/foundation-production-contracts');
  const { LIGHT_ASSET_METHOD_VERSION } = await import('@/lib/foundation-production-prompts');
  const store = await import('@/lib/foundation-choice-store');
  const failures: string[] = [];
  try {
    for (const kind of ['suggestion', 'decision'] as const) {
      const project = await db.project.create({ data: { title: `missing ${kind} receipt loop`, episodes: { create: { number: 1, content: '第1集\n1-1 日 外 广场\n人物：甲\n△甲站在广场上。\n' } } } });
      await preprocessProject(project.id, db);
      const input = await loadFoundationInputs(project.id, db), empty = createEmptyDocument(input);
      const doc = mergeDocumentF2({ ...empty, workflow: 'LIGHT_STAGE1_V1', assetMethodVersion: LIGHT_ASSET_METHOD_VERSION }, requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [1], assets: [] }, input.sourceIndex, [1]), input.sourceIndex);
      doc.editorialCoverage = [1];
      doc.editorialTodos = [1, 2].map(n => ({ id: `todo-${n}`, key: `independent-issue-${n}`, owner: 'Q1' as const, episodes: [1], note: `需要校核的独立资料事项${n}` }));
      await saveFoundationDocument(db, project.id, empty.revision, doc, 'isolated fixture with two existing repair jobs');
      const choice: HumanChoice = { decisionKey: 'local-weather', kind: 'PRODUCTION_CHOICE', question: '本场天气使用哪种口径？', reason: '制作条件需要确认', options: ['晴', '雨'], recommended: '晴', recommendationReason: '保持中性', evidence: '原文未定', episodes: [1], applicationScope: { kind: 'SCENES', scenes: [{ episode: 1, sceneKey: '1-1' }] }, changeTargets: { assetKeys: [], assetFields: [], sceneFields: ['weather'] } };
      await store.syncFoundationChoices(db, project.id, input.sourceVersion, 'F2', [choice]);
      if (kind === 'decision') {
        const row = (await store.loadFoundationChoices(db, project.id, input.sourceVersion)).pending[0];
        await store.confirmFoundationChoice(db, { projectId: project.id, contractId: row.id, revision: row.revision, optionIndex: '0' });
      }
      const modes: string[] = [];
      const runner = async (_stage: 'F1' | 'F2' | 'Q1', prompt: string): Promise<RoleRunResult> => {
        const request = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
        modes.push(request.delivery.mode);
        // Each real REPAIR closes one distinct issue; no fake revision changes or DB edits.
        const done = request.delivery.mode === 'REPAIR' ? request.pendingChoices?.[0]?.id : undefined;
        const data = { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: request.scope, changes: { scenes: [{ episode: 1, sceneKey: '1-1', weather: modes.length % 2 ? '晴' : '雨' }] }, ...(done ? { resolvedUnresolved: [done] } : {}) };
        return { data, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null };
      };
      const initial = await api.queueFoundationDelivery(project.id, {}, db);
      await api.executeFoundationDelivery(project.id, initial.id, { db, stageRunner: runner });
      let state = await api.getFoundationDeliveryState(project.id, db);
      const firstModes = [...modes], rounds = state.task?.repairRounds, repairCalls = state.task?.repairCalls;
      assert.equal(state.complete, false, 'missing receipt cannot silently mark complete');
      let continued = 0;
      for (let pass = 0; pass < 4 && state.action === 'CONTINUE'; pass++) {
        const task = await api.queueFoundationDelivery(project.id, {}, db);
        await api.executeFoundationDelivery(project.id, task.id, { db, stageRunner: runner });
        continued++;
        state = await api.getFoundationDeliveryState(project.id, db);
      }
      console.log(JSON.stringify({ kind, firstModes, firstRepairRounds: rounds, firstRepairCalls: repairCalls, ordinaryContinues: continued, modes, finalAction: state.action, finalRepairRounds: state.task?.repairRounds, finalRepairCalls: state.task?.repairCalls, finalAddedCalls: state.task?.addedCalls, todos: state.document.editorialTodos.length }));
      if (continued > 0 && modes.length > firstModes.length) failures.push(`${kind}: receipt-only ordinary continuation bought ${modes.length - firstModes.length} extra calls after ${rounds} repair rounds`);
      const beforeDeletion = modes.length;
      let recreatedTasks = 0;
      for (let pass = 0; pass < 4; pass++) {
        await db.sceneSnapshot.deleteMany({ where: { id: `foundation-delivery-${project.id}` } });
        state = await api.getFoundationDeliveryState(project.id, db);
        if (state.action === 'BLOCKED') {
          const count = modes.length;
          await assert.rejects(api.queueFoundationDelivery(project.id, {}, db), /额度|修正|修复|已付费|重复/);
          assert.equal(modes.length, count);
          continue;
        }
        const recreated = await api.queueFoundationDelivery(project.id, {}, db);
        recreatedTasks++;
        await api.executeFoundationDelivery(project.id, recreated.id, { db, stageRunner: runner });
        state = await api.getFoundationDeliveryState(project.id, db);
      }
      const afterDeletion = modes.slice(beforeDeletion);
      const allRepairCalls = modes.filter(mode => mode === 'REPAIR').length;
      console.log(JSON.stringify({ kind, deletedTaskRetries: 4, recreatedTasks, afterDeletionModes: afterDeletion, totalRepairCalls: allRepairCalls, actionAfterDeletion: state.action }));
      assert.equal(recreatedTasks, 0, `${kind}: persisted completed repair rounds must prevent task recreation`);
      assert.equal(afterDeletion.length, 0, `${kind}: deleting a task must not buy any additional receipt-only request`);
      if (allRepairCalls > 3) failures.push(`${kind}: deleting task reset the three-call persistent repair budget`);
      if (afterDeletion.filter(mode => mode !== 'REPAIR').length > 1) failures.push(`${kind}: deleting task repeatedly purchased INITIAL receipt work`);
      if (state.action !== 'BLOCKED') failures.push(`${kind}: missing receipt still permits task recreation after repeated retries`);
    }
    assert.deepEqual(failures, [], 'receipt-only retries must not escape persistent repair budget/round limits');
    console.log('PASS receipt-only continuation remains bounded across ordinary retries (offline SQLite)');
  } finally {
    await db.$disconnect();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { console.warn('Temporary fixture retained:', directory); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
