import assert from 'node:assert/strict';
import test, {before, after} from 'node:test';
import {mkdtempSync, readdirSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {PrismaClient} from '@prisma/client';
import type {P1ReviewState} from '../lib/fidelity-p1-review';
import {prepareFidelityImport} from '../lib/fidelity-import';
import {planP1ReviewBatches} from '../lib/fidelity-p1-review';

const clean = '第一集\n1-1 屋内 日 内\n出场人物：林岚\n△林岚放下铜钥匙。\n林岚：明天见。\n';
let db: PrismaClient, ownerId: string;
let assistSource: typeof import('../lib/fidelity-source-assist').prepareFidelitySourceAssisted;
let readReceipt: typeof import('../lib/fidelity-store').readFidelityReceipt;
let importProject: typeof import('../lib/workflow').importParsedProject;
before(async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'p1-program-check-')), file = path.join(directory, 'test.db');
  const sql = new DatabaseSync(file);
  for (const migration of readdirSync('prisma/migrations').sort()) if (/^\d/.test(migration)) sql.exec(readFileSync(path.join('prisma/migrations', migration, 'migration.sql'), 'utf8'));
  sql.close(); process.env.DATABASE_URL = `file:${file}`;
  db = (await import('../lib/prisma')).prisma;
  assistSource = (await import('../lib/fidelity-source-assist')).prepareFidelitySourceAssisted;
  readReceipt = (await import('../lib/fidelity-store')).readFidelityReceipt;
  importProject = (await import('../lib/workflow')).importParsedProject;
  ownerId = (await db.user.create({data: {username: 'p1-program', email: 'p1-program@synthetic.invalid', passwordHash: 'offline'}})).id;
});
after(async () => { await db?.$disconnect(); });

async function create(text = clean, review: P1ReviewState = {status: 'PENDING'}, readerGap = false) {
  const prepared = await prepareFidelityImport('program.txt', Buffer.from(text), 'fidelity');
  prepared.receipt.p1Review = review;
  if (readerGap) {
    prepared.imported.sourceStructure.issues.push({code: 'DOCX_UNSUPPORTED_OBJECT', message: '文档对象未完整读取', sectionKeys: []});
    prepared.imported.readingView.kind = 'DOCX';
    prepared.imported.readingView.warnings.push('文档对象未完整读取');
  }
  return (await importProject({ownerUserId: ownerId, title: '隔离程序结构检查', sourceName: 'program.txt', fidelityReceipt: prepared.receipt}, prepared.imported, db)).project;
}
const noAssist = async () => { assert.fail('UNEXPECTED_AI'); };
const options = {checkCurrent: async () => {}, assist: noAssist};

test('41-character explicit source completes P1 through deterministic evidence with zero AI and no source writes', async () => {
  assert.equal(clean.length, 41);
  const project = await create();
  const previous = (await readReceipt(project.id, db))!;
  const episodes = await db.episode.findMany({where: {projectId: project.id}});
  const result = await assistSource(project.id, db, options);
  assert.equal(result.assisted, false); assert.deepEqual(result.unresolved, []);
  const current = (await readReceipt(project.id, db))!;
  assert.equal(Reflect.get(current.receipt.p1Review!, 'method'), 'PROGRAM');
  assert.equal(current.receipt.p1Review?.status, 'COMPLETE');
  assert.equal(current.receipt.p1Review?.reviewedSourceVersion, previous.receipt.readingHash);
  assert.equal(current.receipt.p1Review?.runIds, undefined); assert.equal(current.receipt.p1Review?.completedRanges, undefined);
  assert.notEqual(current.snapshot.id, previous.snapshot.id);
  assert.deepEqual(current.sourceSnapshot, previous.sourceSnapshot);
  assert.deepEqual(current.receipt.result, previous.receipt.result);
  assert.deepEqual(await db.episode.findMany({where: {projectId: project.id}}), episodes);
  assert.equal(await db.pipelineRun.count({where: {projectId: project.id}}), 0);
  const count = await db.sceneSnapshot.count({where: {projectId: project.id}});
  await assistSource(project.id, db, options);
  assert.equal(await db.sceneSnapshot.count({where: {projectId: project.id}}), count, '同一程序证据不重复落记录');
});

test('missing headings, unresolved ownership, syntax diagnostics and DOCX reading gaps retain validated assistance', async () => {
  for (const [text, readerGap] of [
    ['林岚：没有集场。\n', false], ['第一集\n林岚：没有场头。\n', false],
    ['第一集\n2-1 屋内 日 内\n出场人物：林岚\n林岚：场号属于别集。\n', false],
    ['第一集\n1-1 屋内 日 内\n没有身份依据：原话。\n', false], [clean, true]
  ] as const) {
    const project = await create(text, {status: 'PENDING'}, readerGap); let calls = 0;
    await assert.rejects(assistSource(project.id, db, {...options, assist: async () => {calls++; throw new Error('ASSIST_REQUIRED');}}), /ASSIST_REQUIRED/);
    assert.equal(calls, 1); assert.notEqual(Reflect.get((await readReceipt(project.id, db))!.receipt.p1Review!, 'method'), 'PROGRAM');
  }
});

test('pending paid decisions, run ids, repairs and unresolved records cannot be erased by the program fast path', async () => {
  const states: P1ReviewState[] = [
    {status: 'PENDING', runIds: ['paid-existing']},
    {status: 'PENDING', pendingDecisions: [{start: 0, end: clean.length, kind: 'body', episodeNumber: 1, sceneNumber: 1, note: '既有付费候选'}]},
    {status: 'PENDING', repairAttempts: 1},
    {status: 'PENDING', unresolved: [{start: 0, end: clean.length, kind: 'semantic', note: '既有问题'}]},
    {status: 'PENDING', aliases: [{alias: '林岚', canonicalCandidate: '林岚', start: 0, end: clean.length, note: '既有身份候选'}]}
  ];
  for (const state of states) {
    const project = await create(clean, state), before = (await readReceipt(project.id, db))!;
    await assert.rejects(assistSource(project.id, db, {...options, assist: async () => {throw new Error('EXISTING_WORK');}}), /EXISTING_WORK/);
    assert.deepEqual((await readReceipt(project.id, db))!.snapshot, before.snapshot);
  }
  const project = await create();
  await db.pipelineRun.create({data: {projectId: project.id, stageCode: 'F1', roleName: '已付费来源检查', provider: 'CLI', status: 'SUCCEEDED'}});
  await assert.rejects(assistSource(project.id, db, {...options, assist: async () => {throw new Error('PAID_RECOVERY');}}), /PAID_RECOVERY/);
});

test('fully checkpointed paid review reuses its ranges without another call or a fake PROGRAM stamp', async () => {
  const completedRanges = planP1ReviewBatches(clean).map(blocks => ({start: blocks[0].start, end: blocks.at(-1)!.end}));
  const project = await create(clean, {status: 'PENDING', completedRanges, runIds: ['paid-block-1']});
  await assistSource(project.id, db, options);
  const current = (await readReceipt(project.id, db))!;
  assert.equal(current.receipt.p1Review?.status, 'COMPLETE');
  assert.deepEqual(current.receipt.p1Review?.completedRanges, completedRanges);
  assert.deepEqual(current.receipt.p1Review?.runIds, ['paid-block-1']);
  assert.notEqual(Reflect.get(current.receipt.p1Review!, 'method'), 'PROGRAM');
});

test('source races and corrupt raw/map evidence reject before committing a program record', async () => {
  const project = await create(), before = (await readReceipt(project.id, db))!;
  await assert.rejects(assistSource(project.id, db, {...options, checkCurrent: async tx => {
    await tx.episode.updateMany({where: {projectId: project.id}, data: {content: clean + '并发变化'}});
  }}), /来源|原文|变化/);
  assert.deepEqual((await readReceipt(project.id, db))!.snapshot, before.snapshot);
  for (const key of ['readingHash', 'blankLineCleanup'] as const) {
    const damaged = await create(), current = (await readReceipt(damaged.id, db))!;
    if (key === 'readingHash') current.receipt.readingHash = 'stale';
    else current.receipt.reader.blankLineCleanup!.removedRanges.push({start: 0, end: 1});
    await db.sceneSnapshot.update({where: {id: current.snapshot.id}, data: {content: JSON.stringify(current.receipt)}});
    await assert.rejects(assistSource(damaged.id, db, options), /一致|校验|原文|来源|清洗/);
  }
});

test('a concurrently saved paid receipt cannot be replaced even if its snapshot id is unchanged', async () => {
  const project = await create(), before = (await readReceipt(project.id, db))!;
  await assert.rejects(assistSource(project.id, db, {...options, checkCurrent: async tx => {
    await tx.sceneSnapshot.update({where: {id: before.snapshot.id}, data: {content: JSON.stringify({...before.receipt, p1Review: {status: 'PENDING', runIds: ['concurrent-paid']}})}});
  }}), /变化|更新|过期/);
  assert.deepEqual((await readReceipt(project.id, db))!.snapshot, before.snapshot);
});

test('real preparation pipeline proceeds from clean P1 to F2 without dispatching an F1 provider call', async () => {
  const project = await create();
  const {queueFoundationDelivery, executeFoundationDelivery} = await import('../lib/foundation-delivery');
  const task = await queueFoundationDelivery(project.id, {}, db), stages: string[] = [];
  await executeFoundationDelivery(project.id, task.id, {db, stageRunner: async stage => {
    stages.push(stage); throw Object.assign(new Error('offline boundary: F2 not sent'), {requestOutcome: 'NOT_SENT'});
  }});
  assert.deepEqual(stages, ['F2']);
  assert.equal(await db.pipelineRun.count({where: {projectId: project.id, stageCode: 'F1'}}), 0);
  assert.equal(Reflect.get((await readReceipt(project.id, db))!.receipt.p1Review!, 'method'), 'PROGRAM');
});
