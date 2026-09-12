/** Isolated persistence + fake roles; method changes are process-local, never prompt-file edits. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { PRODUCTION_TASK_CONTRACT, PRODUCTION_OUTPUT_SCHEMAS } from '@/lib/foundation-production-prompts';
import type { FoundationStageRunner } from '@/lib/project-foundation';
import type { FoundationStageCode } from '@/lib/project-foundation-contracts';

const scratch = mkdtempSync(path.join(tmpdir(), 'foundation-stage-versions-'));
const url = `file:${path.join(scratch, 'test.db')}`;
process.env.DATABASE_URL = url;
copyFileSync(path.resolve('prisma/schema.prisma'), path.join(scratch, 'schema.prisma'));
execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--schema', path.join(scratch, 'schema.prisma'), '--skip-generate'], { cwd: scratch, env: { ...process.env, DATABASE_URL: url, RUST_LOG: 'info' }, stdio: 'pipe' });
const db = new PrismaClient({ datasources: { db: { url } } });
const contract = PRODUCTION_TASK_CONTRACT as unknown as Record<string, string>;
const schemas = PRODUCTION_OUTPUT_SCHEMAS as unknown as Record<FoundationStageCode, Record<string, unknown>>;
const calls: string[] = [];
const runner: FoundationStageRunner = async (stage, prompt) => {
  const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
  calls.push(`${stage}:${input.scope.join(',')}`);
  const data = stage === 'F1' ? { coverage: input.scope, overview: '关系导航', episodes: input.scope.map((number: number) => ({ number, summary: '甲交接钥匙。' })) }
    : stage === 'F2' ? { format: 'ASSET_CATALOG_V2', coverage: input.scope, assets: [{ name: `甲-${input.scope[0]}`, type: 'CH', episodes: input.scope, preparation: { mode: 'REFERENCE' } }] }
      : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: {} };
  return { data, rawOutput: JSON.stringify(data), sessionId: null, stdout: 'fake provider only', stderr: '' };
};

async function main() {
  const { preprocessProject } = await import('@/lib/project-preprocess');
  const { getFoundationState, loadFoundationInputs } = await import('@/lib/foundation-state');
  const { queueProjectFoundationContinuation, queueSingleFoundationStage, previewFoundationRecoveries, executeProjectFoundation } = await import('@/lib/project-foundation');
  const make = async (long = false) => {
    const project = await db.project.create({ data: { title: '__stage_versions__', executionMode: 'CLI', episodes: { create: (long ? [0, 1, 2] : [1]).map(number => ({ number, content: `${number}-1 礼堂 日 内\n甲交接钥匙。${long ? '原文'.repeat(6500) : ''}` })) } } });
    await preprocessProject(project.id, db); return project;
  };
  // Test the concrete regression before inspecting the new version interface.
  const project = await make();
  await queueProjectFoundationContinuation(project.id, { db, stageRunner: runner });
  assert.equal((await getFoundationState(project.id, db)).ready, true);
  const oldF2 = contract.F2;
  try {
    contract.F2 += ' 本岗校准。';
    const state = await getFoundationState(project.id, db);
    assert.equal(state.planningReady, true, 'F2 task-only calibration must not invalidate completed F1');
    assert.equal(state.assetsReady, false); assert.equal(state.draftComplete, false);
    const next = await queueProjectFoundationContinuation(project.id, { db, stageRunner: runner });
    assert.deepEqual(next.stageCodes, ['F2', 'Q1']);
    assert.equal(calls.filter(call => call.startsWith('F1:')).length, 1);
  } finally { contract.F2 = oldF2; }

  for (const stage of ['F1', 'F2', 'Q1'] as const) for (const kind of ['task', 'schema'] as const) {
    const p = await make();
    await queueProjectFoundationContinuation(p.id, { db, stageRunner: runner });
    const before = await loadFoundationInputs(p.id, db);
    const previousTask = contract[stage], previousSchema = schemas[stage];
    try {
      if (kind === 'task') contract[stage] += ' 仅本岗校准。';
      else schemas[stage] = { ...previousSchema, calibrationNote: '仅本岗字段说明变化' };
      const after = await loadFoundationInputs(p.id, db);
      assert.equal(after.inputVersion, before.inputVersion);
      const state = await getFoundationState(p.id, db);
      assert.equal(state.planningReady, stage !== 'F1');
      assert.equal(state.assetsReady, stage === 'Q1');
      assert.equal(state.draftComplete, false);
      assert.deepEqual((await queueProjectFoundationContinuation(p.id, { db, stageRunner: runner })).stageCodes, stage === 'F1' ? ['F1', 'F2', 'Q1'] : stage === 'F2' ? ['F2', 'Q1'] : ['Q1']);
      assert.equal((await getFoundationState(p.id, db)).ready, true);
    } finally { contract[stage] = previousTask; schemas[stage] = previousSchema; }
  }
  console.log('PASS each role task/schema changes only invalidate that role and downstream; real queue executes only required suffix');

  const failedProject = await make(true);
  await assert.rejects(queueSingleFoundationStage(failedProject.id, 'F1', undefined, { db, stageRunner: async (stage, prompt, context) => {
    if (context.chunkIndex === 2) throw Object.assign(new Error('synthetic prefix stop'), { requestOutcome: 'NOT_SENT' });
    return runner(stage, prompt, context);
  } }), /synthetic prefix stop/);
  const failed = await db.pipelineRun.findFirstOrThrow({ where: { projectId: failedProject.id, stageCode: 'F1', status: 'FAILED' } });
  const failedInput = await loadFoundationInputs(failedProject.id, db);
  assert.equal(JSON.parse(failed.log!).calls[0].checkpoint.protocolVersion, failedInput.methodVersions.F1, 'F1 checkpoint binds F1 method, never F2 transport');
  const oldTask = contract.F1, oldSchema = schemas.F2;
  try {
    contract.F2 += ' 下游变化。'; schemas.F2 = { ...oldSchema, calibrationNote: '下游协议字段变化' };
    const state = await getFoundationState(failedProject.id, db);
    assert.equal(state.recoveries.F1?.resumeChunkCount, 1, 'F1 checkpoint must not depend on F2 protocol/schema');
    contract.F1 += ' 本岗变化。';
    assert.equal((await getFoundationState(failedProject.id, db)).recoveries.F1, null, 'own method change cannot reuse old prefix');
    contract.F1 = oldTask;
    const input = await loadFoundationInputs(failedProject.id, db);
    const rows = await db.pipelineRun.findMany({ where: { projectId: failedProject.id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    assert.equal((await previewFoundationRecoveries(failedProject.id, { ...input, sourceVersion: 'changed' }, {}, rows, db)).F1, null);
    await db.pipelineRun.update({ where: { id: failed.id }, data: { model: 'changed' } });
    assert.equal((await getFoundationState(failedProject.id, db)).recoveries.F1, null);
    await db.pipelineRun.update({ where: { id: failed.id }, data: { model: failed.model } });
    const n = calls.filter(call => call === 'F1:0').length;
    await queueSingleFoundationStage(failedProject.id, 'F1', { resumeFromRunId: failed.id }, { db, stageRunner: runner });
    assert.equal(calls.filter(call => call === 'F1:0').length, n, 'valid paid prefix must not be resent');
  } finally { contract.F1 = oldTask; contract.F2 = oldF2; schemas.F2 = oldSchema; }
  console.log('PASS F1 paid-prefix reuse survives F2 changes; own method/source/model drift rejects reuse');

  for (const drift of ['purpose', 'conditions', 'source'] as const) {
    const p = await make(); await queueProjectFoundationContinuation(p.id, { db, stageRunner: runner });
    const purpose = contract.purpose;
    try {
      if (drift === 'purpose') contract.purpose += ' 共享用途变化';
      if (drift === 'conditions') await db.project.update({ where: { id: p.id }, data: { style: 'changed' } });
      if (drift === 'source') await db.episode.updateMany({ where: { projectId: p.id }, data: { content: '1-1 礼堂 日 内\n甲离开。' } });
      const state = await getFoundationState(p.id, db);
      assert.equal(state.planningReady, false); assert.equal(state.assetsReady, false); assert.equal(state.ready, false);
    } finally { contract.purpose = purpose; }
  }

  const unsigned = await make(); await queueProjectFoundationContinuation(unsigned.id, { db, stageRunner: runner });
  const state = await getFoundationState(unsigned.id, db);
  const originalCandidate = await db.sceneSnapshot.findUniqueOrThrow({ where: { id: state.candidates.f1!.id } });
  const unsignedCandidate = JSON.parse(originalCandidate.content); delete unsignedCandidate.methodVersion;
  await db.sceneSnapshot.update({ where: { id: originalCandidate.id }, data: { content: JSON.stringify(unsignedCandidate) } });
  const unsignedState = await getFoundationState(unsigned.id, db);
  assert.equal(unsignedState.planningReady, false, 'production candidates without method signatures are history only');
  assert.ok(unsignedState.candidates.f1, 'unsigned historic content remains readable');
  await db.sceneSnapshot.update({ where: { id: originalCandidate.id }, data: { content: originalCandidate.content } });
  const signedRun = await db.pipelineRun.findUniqueOrThrow({ where: { id: state.candidates.f1!.runId } });
  const unsignedSummary = JSON.parse(signedRun.inputSummary!); delete unsignedSummary.methodVersion;
  await db.pipelineRun.update({ where: { id: signedRun.id }, data: { inputSummary: JSON.stringify(unsignedSummary) } });
  assert.equal((await getFoundationState(unsigned.id, db)).planningReady, false, 'new production queue evidence cannot omit its signature');

  for (const missing of [false, true]) {
    const p = await make(), input = await loadFoundationInputs(p.id, db);
    const batchToken = `pinned-${p.id}`;
    await db.pipelineRun.create({ data: { projectId: p.id, stageCode: 'F1', roleName: 'F1', provider: 'Codex CLI', status: 'QUEUED', inputSummary: JSON.stringify({ batchToken, provider: 'CLI', foundation: true, workflow: 'PRODUCTION_FOUNDATION_V3', sourceVersion: input.sourceVersion, inputVersion: input.inputVersion, ...(!missing ? { methodVersion: input.methodVersions.F1 } : {}) }) } });
    const original = contract.F1, beforeCalls = calls.length;
    try {
      if (!missing) contract.F1 += ' 排队后变化';
      await assert.rejects(executeProjectFoundation(p.id, batchToken, { db, singleStage: 'F1', stageRunner: runner }), /方法|签名/);
      assert.equal(calls.length, beforeCalls);
    } finally { contract.F1 = original; }
  }

  for (const pinSharedInputs of [false, true]) {
    const p = await make(), input = await loadFoundationInputs(p.id, db);
    const batchToken = `unsigned-legacy-${p.id}`, beforeCalls = calls.length;
    const queuedSummary = JSON.stringify({ batchToken, provider: 'CLI', foundation: true,
      ...(pinSharedInputs ? { sourceVersion: input.sourceVersion, inputVersion: input.inputVersion } : {}) });
    const oldRun = await db.pipelineRun.create({ data: { projectId: p.id, stageCode: 'F1', roleName: 'F1', provider: 'Codex CLI', status: 'QUEUED', inputSummary: queuedSummary } });
    await assert.rejects(executeProjectFoundation(p.id, batchToken, { db, singleStage: 'F1', stageRunner: runner }), /方法|签名/, 'unsigned legacy queue must not execute then gain a current signature');
    const rejected = await db.pipelineRun.findUniqueOrThrow({ where: { id: oldRun.id } });
    assert.equal(calls.length, beforeCalls); assert.equal(rejected.status, 'FAILED');
    assert.equal(rejected.inputSummary, queuedSummary, 'rejected queue evidence must not be retroactively signed');
    assert.equal(JSON.parse(rejected.inputSummary!).methodVersion, undefined);
    assert.deepEqual(JSON.parse(rejected.log!).calls, []);
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: 'FOUNDATION_F1' } }), 0);
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: 'FOUNDATION_APPROVED' } }), 0);
  }

  for (const changedStage of ['F1', 'F2'] as const) {
    const p = await make(), original = contract[changedStage], beforeCalls = calls.length;
    try {
      await assert.rejects(queueProjectFoundationContinuation(p.id, { db, stageRunner: async (stage, prompt, context) => {
        const result = await runner(stage, prompt, context);
        if (stage === 'F1') contract[changedStage] += ' 调用期间变化';
        return result;
      } }), /方法/);
      assert.equal(calls.length - beforeCalls, 1, 'method drift must stop before the next paid call');
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: 'FOUNDATION_F1' } }), changedStage === 'F2' ? 1 : 0, 'downstream-only drift preserves F1; own drift forbids publication');
    } finally { contract[changedStage] = original; }
  }
  console.log('PASS shared drift invalidates all; missing signatures remain history/refuse execution; mid-run method changes stop calls/publication');
}

main().finally(async () => { await db.$disconnect(); rmSync(scratch, { recursive: true, force: true }); }).catch(error => { console.error(error); process.exitCode = 1; });
