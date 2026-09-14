/** Real controller + disposable SQLite; all provider responses are offline stubs. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '@/lib/role-runner';

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'decision-scene-controller-'));
  const url = `file:${directory}/test.db`;
  process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  const api = await import('@/lib/foundation-delivery');
  const response = (data: unknown): RoleRunResult => ({ data: data as Record<string, unknown>, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null });
  const input = (prompt: string) => JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
  const choice = { decisionKey: 'dean-hair', kind: 'PRODUCTION_CHOICE', question: '院长本场采用哪种发型？', options: ['保留长发', '采用秃头'], recommended: '采用秃头', recommendationReason: '本场明确', reason: '本阶段需要确认', evidence: '青龙院长登台。', episodes: [23], applicationScope: { kind: 'SCENES', scenes: [{ episode: 23, sceneKey: '23-1' }] } };
  const optimization = (scope: number[], changes = {}, extra = {}) => ({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: scope, changes, ...extra });
  const setup = async (title: string) => {
    const project = await db.project.create({ data: { title, episodes: { create: { number: 23, content: '第23集\n23-1 日 外 广场\n人物：青龙院长\n△青龙院长登台。\n23-2 日 内 食堂\n人物：保洁大妈\n△保洁大妈擦桌子。\n' } } } });
    const task = await api.queueFoundationDelivery(project.id, {}, db);
    await api.executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => response(stage === 'F2'
      ? { format: 'ASSET_CATALOG_V2', coverage: input(prompt).scope, assets: [] }
      : optimization(input(prompt).scope, {}, { humanChoices: [choice] })) });
    const state = await api.getFoundationDeliveryState(project.id, db);
    assert.equal(state.task?.status, 'WAITING_USER');
    assert.equal(state.requiredChoices.length, 1);
    assert.equal(state.requiredChoices[0].applicationScope?.kind, 'SCENES');
    const resumed = await api.confirmAndContinueFoundationDelivery(db, { projectId: project.id, contractId: state.requiredChoices[0].id, revision: state.requiredChoices[0].revision, optionIndex: '1' });
    return { project, task: resumed, unrelated: await db.scriptScene.findFirstOrThrow({ where: { episode: { projectId: project.id }, sceneKey: '23-2' } }) };
  };
  const patch = (value: ReturnType<typeof input>, sceneKey: string) => optimization(value.scope, { scenes: [{ episode: 23, sceneKey, weather: '雨后' }] }, { appliedDecisions: value.confirmedDecisions.map((row: { id: string }) => ({ id: row.id, note: '采用本场决定。' })) });
  try {
    const fresh = await setup('新确认不可改同集无关场');
    let freshCalls = 0;
    await api.executeFoundationDelivery(fresh.project.id, fresh.task.id, { db, stageRunner: async (_stage, prompt) => {
      freshCalls++;
      const value = input(prompt);
      assert.equal(value.delivery.mode, 'APPLY_DECISION');
      assert.deepEqual(value.delivery.targets.sceneKeys, ['23-1']);
      return response(patch(value, '23-2'));
    } });
    assert.ok(freshCalls > 0 && freshCalls <= 2);
    assert.deepEqual(await db.scriptScene.findUniqueOrThrow({ where: { id: fresh.unrelated.id } }), fresh.unrelated, '同集无关场必须完整不变');
    assert.notEqual((await api.getFoundationDeliveryState(fresh.project.id, db)).task?.status, 'COMPLETE', '越界响应不能被当作完成');

    for (const legacySceneKey of ['23-1', '23-2']) {
    const legacy = await setup(`旧已付费决定响应本地恢复-${legacySceneKey}`);
    let failOnce = true, paidCalls = 0;
    const failLog = (args: { data: { log?: unknown } }) => {
      const log = args.data.log && JSON.parse(String(args.data.log));
      if (failOnce && log?.calls?.some((call: { status: string; requestOutcome: string }) => call.status === 'RUNNING' && call.requestOutcome === 'RESPONDED')) {
        failOnce = false;
        throw new Error('offline transient response log failure');
      }
    };
    const failingDb = db.$extends({ query: { pipelineRun: {
      update({ args, query }) { failLog(args); return query(args); },
      updateMany({ args, query }) { failLog(args); return query(args); }
    } } }) as unknown as PrismaClient;
    // Persist a valid response first, then emulate the exact pre-upgrade stored payload below.
    await api.executeFoundationDelivery(legacy.project.id, legacy.task.id, { db: failingDb, stageRunner: async (_stage, prompt) => { paidCalls++; return response(patch(input(prompt), '23-1')); } });
    assert.equal(paidCalls, 1);
    const failedState = await api.getFoundationDeliveryState(legacy.project.id, db);
    assert.match(failedState.task?.error ?? '', /offline transient response log failure/);
    const runs = await db.pipelineRun.findMany({ where: { projectId: legacy.project.id, stageCode: 'Q1' } });
    let legacyRuns = 0;
    for (const run of runs) {
      const summary = JSON.parse(run.inputSummary ?? '{}');
      if (summary.phase !== 'APPLY_DECISION') continue;
      const log = JSON.parse(run.log ?? '{}');
      for (const call of log.calls) {
        const marker = 'INPUT_JSON:\n', offset = call.taskPrompt.lastIndexOf(marker);
        const request = JSON.parse(call.taskPrompt.slice(offset + marker.length));
        delete request.delivery.targets.sceneKeys;
        call.taskPrompt = call.taskPrompt.slice(0, offset + marker.length) + JSON.stringify(request);
        if (legacySceneKey === '23-2' && call.response) {
          // Old receiving rules accepted this same-episode, wrong-scene response.
          call.response = JSON.parse(JSON.stringify(call.response).replaceAll('23-1', '23-2'));
        }
      }
      await db.pipelineRun.update({ where: { id: run.id }, data: { log: JSON.stringify(log) } });
      legacyRuns++;
    }
    assert.equal(legacyRuns, 1, '必须真实保留一份旧无sceneKeys的已付费响应证据');
    const runCount = await db.pipelineRun.count({ where: { projectId: legacy.project.id } });
    const retry = await api.queueFoundationDelivery(legacy.project.id, {}, db);
    let newCalls = 0;
    await api.executeFoundationDelivery(legacy.project.id, retry.id, { db, stageRunner: async () => { newCalls++; throw new Error('must recover paid response without provider'); } });
    assert.equal(newCalls, 0, '升级范围规则不能重购旧已付费响应');
    assert.equal(await db.pipelineRun.count({ where: { projectId: legacy.project.id } }), runCount);
    const restored = await api.getFoundationDeliveryState(legacy.project.id, db);
    if (legacySceneKey === '23-1') {
      assert.equal(restored.complete, true);
      assert.equal((await db.scriptScene.findFirstOrThrow({ where: { episode: { projectId: legacy.project.id }, sceneKey: '23-1' } })).weather, '雨后');
    } else {
      assert.equal(restored.complete, false, '旧宽targets不能绕过当前场范围校验');
      assert.ok(restored.task?.error || restored.continuationBlocker, '越界旧响应应留下明确阻断');
    }
    assert.deepEqual(await db.scriptScene.findUniqueOrThrow({ where: { id: legacy.unrelated.id } }), legacy.unrelated);
    }
    console.log('PASS decision scene controller: new and legacy wrong-scene responses rejected; valid legacy paid APPLY_DECISION recovered with zero new calls (offline SQLite)');
  } finally {
    await db.$disconnect();
    try { rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { console.warn('Temporary offline fixture retained:', directory); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
