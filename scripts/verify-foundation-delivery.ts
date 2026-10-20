import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '@/lib/role-runner';

async function main() {
  const api = await import('@/lib/foundation-delivery').catch(() => null); assert.ok(api?.queueFoundationDelivery);
  const dir = mkdtempSync(path.join(tmpdir(), 'foundation-delivery-')), url = `file:${path.join(dir, 'test.db')}`; process.env.DATABASE_URL = url;
  copyFileSync(path.resolve('prisma/schema.prisma'), path.join(dir, 'schema.prisma'));
  execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'), 'db', 'push', '--schema', path.join(dir, 'schema.prisma'), '--skip-generate'], { cwd: dir, env: { ...process.env, DATABASE_URL: url, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasources: { db: { url } } });
  const { preprocessProject } = await import('@/lib/project-preprocess');
  const { loadFoundationInputs } = await import('@/lib/foundation-state');
  const { createEmptyDocument, mergeDocumentF2, saveFoundationDocument } = await import('@/lib/foundation-document');
  const { requireProductionCatalogAuthor } = await import('@/lib/foundation-production-contracts');
  const { LIGHT_ASSET_METHOD_VERSION } = await import('@/lib/foundation-production-prompts');
  const { syncFoundationChoices, loadFoundationChoices, confirmFoundationChoice } = await import('@/lib/foundation-choice-store');
  const out = (data: unknown) => ({ data, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null } as RoleRunResult);
  const input = (prompt: string) => JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
  const refs = (scope: number[]) => scope.map(episode => ({ episode, sceneKey: `${episode}-1` }));
  const f2 = (scope: number[], extra: Record<string, unknown> = {}) => ({ format: 'ASSET_CATALOG_V2', coverage: scope, assets: [{ name: '甲｜默认', type: 'CH', role: '主角', aliases: ['甲'], episodes: scope, sceneRefs: refs(scope), preparation: { mode: 'REFERENCE' } }], ...extra });
  const q1 = (scope: number[], changes: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: scope, changes, ...extra });
  const choice = { decisionKey: 'actor-look', kind: 'PRODUCTION_CHOICE' as const, question: '本次形象需要哪种？', options: ['保留甲', '采用乙'], recommended: '保留甲', recommendationReason: '源文依据', reason: '本阶段确需选择', evidence: '源文无明确口径', episodes: [1] };
  const create = async (title: string, split = false) => {
    const tail = split ? '甲：沉默。\n'.repeat(3100) : '';
    const project = await db.project.create({ data: { title, episodes: { create: [1, 2].map(number => ({ number, title: `第${number}集`, content: `第${number}集\n${number}-1 客厅 日 内\n人物：甲\n甲：原文电棍高压电弧。\n${tail}` })) } } });
    await preprocessProject(project.id, db); return project;
  };
  /** Never seed a fake F1: light drafts carry actual scene refs plus the active asset method. */
  const seed = async (projectId: string) => {
    const state = await loadFoundationInputs(projectId, db); let doc = createEmptyDocument(state); doc = { ...doc, workflow: 'LIGHT_STAGE1_V1', assetMethodVersion: LIGHT_ASSET_METHOD_VERSION };
    doc = mergeDocumentF2(doc, requireProductionCatalogAuthor(f2([1, 2]), state.sourceIndex, [1, 2]), state.sourceIndex);
    return saveFoundationDocument(db, projectId, createEmptyDocument(state).revision, doc, 'light fixture');
  };
  try {
    const legacyAuto = await create('legacy automatic asset generation is retired');
    const legacyTask = await api.queueFoundationDelivery(legacyAuto.id, { autoAssetPrompts: true }, db);
    assert.equal(legacyTask.autoAssetPrompts, false, 'Legacy form/options cannot silently restore the retired full-catalogue dispatch');
    await api.stopFoundationDelivery(legacyAuto.id, legacyTask.id, db);
    assert.equal((await api.queueFoundationDelivery(legacyAuto.id, {}, db)).autoAssetPrompts, false);
    // Zero F1, real parsed scenes and per-scene consumer-ready asset supply.
    const ordinary = await create('light ordinary start'), before = await db.episode.findMany({ where: { projectId: ordinary.id }, orderBy: { number: 'asc' } }), ordinaryCalls: string[] = [];
    const ordinaryTask = await api.queueFoundationDelivery(ordinary.id, {}, db);
    assert.equal(ordinaryTask.autoAssetPrompts, false, 'Stage 1 never defaults to full-catalogue paid asset preparation');
    await assert.rejects(api.queueFoundationDelivery(ordinary.id, {}, db), /运行|处理中|进行|状态/);
    await api.executeFoundationDelivery(ordinary.id, ordinaryTask.id, { db, stageRunner: async (stage, prompt) => { const value = input(prompt); ordinaryCalls.push(stage);
      assert.ok(value.scenes.every((scene: { sceneKey: string; sourceText?: string; sourceLines?: unknown }) => scene.sceneKey && !scene.sourceText && scene.sourceLines));
      if (stage === 'F2') return out(f2(value.scope)); assert.equal(value.candidates.f1, undefined); return out(q1(value.scope, { scenes: [{ episode: 1, sceneKey: '1-1', weather: '雨' }] }));
    } });
    let state = await api.getFoundationDeliveryState(ordinary.id, db); assert.deepEqual(ordinaryCalls, ['F2', 'Q1']); assert.equal(state.task?.status, 'COMPLETE'); assert.equal(state.document.f1, null); assert.equal(state.document.workflow, 'LIGHT_STAGE1_V1'); assert.equal(state.document.assetMethodVersion, LIGHT_ASSET_METHOD_VERSION); assert.equal(state.complete, true); assert.deepEqual(await db.episode.findMany({ where: { projectId: ordinary.id }, orderBy: { number: 'asc' } }), before);
    assert.equal((await db.scriptScene.findFirstOrThrow({ where: { episode: { projectId: ordinary.id, number: 1 }, sceneKey: '1-1' } })).weather, '雨');

    // Completion is free to read and cannot be turned into a second paid review by clicking again.
    const completedDocument = structuredClone(state.document), completedTask = structuredClone(state.task);
    const completedRuns = await db.pipelineRun.count({ where: { projectId: ordinary.id } });
    for (const options of [{}, { expectedState: state.expectedState }, { allowUnknownRetry: true }]) {
      await assert.rejects(api.queueFoundationDelivery(ordinary.id, options, db), /已整理完成|无需重复调用/);
      const unchanged = await api.getFoundationDeliveryState(ordinary.id, db);
      assert.equal(unchanged.complete, true);
      assert.deepEqual(unchanged.document, completedDocument);
      assert.deepEqual(unchanged.task, completedTask);
      assert.equal(await db.pipelineRun.count({ where: { projectId: ordinary.id } }), completedRuns);
    }
    await db.project.update({ where: { id: ordinary.id }, data: { title: 'only a display title changed' } });
    assert.equal((await api.getFoundationDeliveryState(ordinary.id, db)).complete, true, 'A display title is not a new semantic review dependency');
    await assert.rejects(api.queueFoundationDelivery(ordinary.id, {}, db), /已整理完成|无需重复调用/);
    assert.equal(await db.pipelineRun.count({ where: { projectId: ordinary.id } }), completedRuns);

    // Ordinary writer dialects reach completion without manual syntax choices
    // or extra catalogue repair; the original source remains byte-for-byte.
    const dialect=await create('writer dialect completes once');
    await db.episode.updateMany({where:{projectId:dialect.id,number:1},data:{content:'第1集\n1-1 客厅 日 内\n人物：甲\n甲：你好。\n甲 os：别慌。\n甲（盯着门口，眼神渐沉） vo：有人来了。\n甲憋笑：听到了。\n甲Q版：太突然了！\n众人（大笑）：欢迎！\n助理：请进。\n闺蜜B：等等。\n网友A：太好了！\n网友B：快看！\n......\n弹幕：“终于来了！”\n防护队员（低声）：安全。\n血月观察者：目标到了。\n钢铁之城的刘老（沉声）：准备。\n场景 走廊（快切）\n监控员A（惊叫）：有人！\n男考生B：别关门。\n系统窗口（系统）：叮！\n系统窗口：已连接。\n'}});
    const dialectEpisode=await db.episode.findFirstOrThrow({where:{projectId:dialect.id,number:1}});
    await db.episode.update({where:{id:dialectEpisode.id},data:{content:dialectEpisode.content+[
      '人物：甲、乙、两名山门弟子、诸位大能',
      '甲：诸位请听。规矩老样子：价高者得，全程禁武！',
      '乙震惊抬头。',
      '字幕（铜镜镜面）：【本轮结算】',
      '山门弟子甲（恭敬）：多谢。',
      '众修（恭敬）：多谢。',
      '众弟子：谨记教诲。',
      '山门同门（振奋）：好！',
      '四人（郑重）：多谢。',
      '甲、乙及诸位大能：告辞。',
      '',
    ].join('\n')}});
    await preprocessProject(dialect.id,db);
    const dialectBefore=await db.episode.findMany({where:{projectId:dialect.id},orderBy:{number:'asc'}});
    const dialectTask=await api.queueFoundationDelivery(dialect.id,{},db),dialectCalls:string[]=[];
    await api.executeFoundationDelivery(dialect.id,dialectTask.id,{db,stageRunner:async(stage,prompt)=>{
      const value=input(prompt);dialectCalls.push(stage);return out(stage==='F2'?f2(value.scope):q1(value.scope));
    }});
    const dialectState=await api.getFoundationDeliveryState(dialect.id,db);
    assert.equal(dialectState.complete,true,dialectState.task?.error??JSON.stringify(dialectState.issues));
    assert.equal(dialectState.task?.status,'COMPLETE');assert.equal(dialectState.task?.repairCalls,0);
    assert.equal(dialectState.requiredChoices.length,0);assert.deepEqual(dialectCalls,['F2','Q1']);
    assert.deepEqual(await db.episode.findMany({where:{projectId:dialect.id},orderBy:{number:'asc'}}),dialectBefore);

    // Successful author/editor calls must not conceal a final reception-only
    // blocker as a generic "continue" task or spend another catalogue repair.
    const badSyntax=await create('source-only reception issue');
    await db.episode.updateMany({where:{projectId:badSyntax.id,number:1},data:{content:'第1集\n1-1 客厅 日 内\n人物：甲\n甲：你好。\n未知标签：（轻声）原文归属尚不明确。\n'}});
    await preprocessProject(badSyntax.id,db);
    const badSyntaxBefore=await db.episode.findMany({where:{projectId:badSyntax.id},orderBy:{number:'asc'}});
    const badSyntaxTask=await api.queueFoundationDelivery(badSyntax.id,{},db),badSyntaxCalls:string[]=[];
    await api.executeFoundationDelivery(badSyntax.id,badSyntaxTask.id,{db,stageRunner:async(stage,prompt)=>{
      const value=input(prompt);badSyntaxCalls.push(stage);return out(stage==='F2'?f2(value.scope):q1(value.scope));
    }});
    const badSyntaxState=await api.getFoundationDeliveryState(badSyntax.id,db);
    assert.deepEqual(badSyntaxCalls,['F2','Q1'],'Syntax-only blockers must not cause a paid catalogue repair.');
    assert.equal(badSyntaxState.action,'BLOCKED');assert.equal(badSyntaxState.requiredChoices.length,0);
    assert.match(badSyntaxState.continuationBlocker??'',/第1集第5行/);
    assert.equal(badSyntaxState.task?.message,badSyntaxState.continuationBlocker,'The task itself must retain the precise program-owned blocker, not ask for an ineffective continue.');
    const blockedRuns=await db.pipelineRun.count({where:{projectId:badSyntax.id}});
    await assert.rejects(api.queueFoundationDelivery(badSyntax.id,{},db),/技术问题/);
    assert.equal(await db.pipelineRun.count({where:{projectId:badSyntax.id}}),blockedRuns,'A source-only pause must not enqueue another paid call.');
    assert.deepEqual(await db.episode.findMany({where:{projectId:badSyntax.id},orderBy:{number:'asc'}}),badSyntaxBefore);

    // Mechanical validity cannot prove semantic completeness: retain the first Q1 source review.
    const semantic = await create('semantic omission with no mechanical blocker');
    await db.episode.updateMany({ where: { projectId: semantic.id, number: 1 }, data: { content: '第1集\n1-1 客厅 日 内\n人物：甲\n△甲把电棍放在桌上。\n甲：别碰它。\n' } });
    await preprocessProject(semantic.id, db); await seed(semantic.id);
    const semanticBefore = await api.getFoundationDeliveryState(semantic.id, db);
    assert.deepEqual(semanticBefore.issues, [], 'This source-to-catalogue omission is not a mechanical format failure');
    const semanticSource = await db.episode.findMany({ where: { projectId: semantic.id }, orderBy: { number: 'asc' } });
    const semanticTask = await api.queueFoundationDelivery(semantic.id, {}, db), semanticCalls: string[] = [];
    await api.executeFoundationDelivery(semantic.id, semanticTask.id, { db, stageRunner: async (stage, prompt) => {
      const value = input(prompt); semanticCalls.push(stage);
      assert.equal(stage, 'Q1'); assert.equal(value.delivery.mode, 'EDIT');
      assert.match(JSON.stringify(value.source), /甲把电棍放在桌上/);
      return out(q1(value.scope, { assets: [{ name: '电棍', type: 'PROP', episodes: [1], sceneRefs: refs([1]), preparation: { mode: 'REFERENCE' } }] }));
    } });
    const semanticAfter = await api.getFoundationDeliveryState(semantic.id, db);
    assert.deepEqual(semanticCalls, ['Q1'], 'Reuse the existing catalogue but do not skip its first semantic review');
    assert.equal(semanticAfter.complete, true, semanticAfter.task?.error ?? '');
    assert.ok(semanticAfter.document.f2?.assets.some(asset => asset.name === '电棍'));
    assert.deepEqual(await db.episode.findMany({ where: { projectId: semantic.id }, orderBy: { number: 'asc' } }), semanticSource);

    // Real provider suggestions are not erased: each true chunk must receipt only its own scope.
    const suggestion = await create('suggestion receipt scopes', true); await seed(suggestion.id); const suggestionInput = await loadFoundationInputs(suggestion.id, db);
    await syncFoundationChoices(db, suggestion.id, suggestionInput.sourceVersion, 'F2', [{ ...choice, episodes: [1, 2] }]); const suggestionScopes: number[][] = [];
    const suggestionTask = await api.queueFoundationDelivery(suggestion.id, {}, db); await api.executeFoundationDelivery(suggestion.id, suggestionTask.id, { db, stageRunner: async (_stage, prompt) => { const value = input(prompt); suggestionScopes.push(value.scope); assert.equal(value.editorialSuggestions.length, 1); return out(q1(value.scope, {}, { resolvedSuggestions: value.editorialSuggestions.map((c: { id: string }) => ({ id: c.id, note: '原文足够，未提前锁定表现。' })) })); } });
    state = await api.getFoundationDeliveryState(suggestion.id, db); const suggestionId = (await loadFoundationChoices(db, suggestion.id, suggestionInput.sourceVersion, true)).pending[0]!.id;
    assert.deepEqual(suggestionScopes.flat(), [1, 2], '完整请求合批仍须唯一覆盖全部建议范围'); assert.deepEqual(state.document.suggestionCoverage?.[suggestionId]?.episodes, [1, 2]); assert.equal(state.complete, true);

    // A necessary choice stays durable, and only its actual scene scope resumes.
    const decision = await create('choice local resume'); await seed(decision.id); const decisionTask = await api.queueFoundationDelivery(decision.id, {}, db);
    await api.executeFoundationDelivery(decision.id, decisionTask.id, { db, stageRunner: async (_stage, prompt) => out(q1(input(prompt).scope, {}, { humanChoices: [choice] })) });
    state = await api.getFoundationDeliveryState(decision.id, db); const required = state.requiredChoices[0]; assert.ok(required); assert.equal(state.task?.status, 'WAITING_USER');
    const resumed = await api.confirmAndContinueFoundationDelivery(db, { projectId: decision.id, contractId: required.id, revision: required.revision, optionIndex: '1' }); assert.ok(resumed, 'the only required choice queues continuation'); assert.equal(resumed.id, decisionTask.id);
    await api.executeFoundationDelivery(decision.id, resumed.id, { db, stageRunner: async (_stage, prompt) => { const value = input(prompt); assert.deepEqual(value.scope, [1]); assert.deepEqual(value.source.episodes.map((episode: { number: number }) => episode.number), [1], 'A local decision must not reread every episode'); return out(q1(value.scope, { scenes: [{ episode: 1, sceneKey: '1-1', characters: ['甲'] }] }, { appliedDecisions: value.confirmedDecisions.map((c: { id: string }) => ({ id: c.id, note: '已在实际场次采用用户方案。' })) })); } });
    state = await api.getFoundationDeliveryState(decision.id, db); assert.equal(state.task?.status, 'COMPLETE'); assert.ok(state.document.appliedDecisions[required.id]); assert.equal(state.confirmedChoices[0].userAnswer, '采用乙');

    // No-progress repair stays durably blocked; ordinary continue cannot reset its calls or budget.
    const partial = await create('bounded repair resume'); await seed(partial.id); const partialModes: string[] = []; const partialTask = await api.queueFoundationDelivery(partial.id, {}, db);
    await api.executeFoundationDelivery(partial.id, partialTask.id, { db, stageRunner: async (_stage, prompt) => { const value = input(prompt); partialModes.push(value.delivery.mode); return out(q1(value.scope, {}, value.delivery.mode === 'EDIT' ? { unresolved: [{ episodes: [1], note: '第1集天气仍待局部核对' }] } : {})); } });
    state = await api.getFoundationDeliveryState(partial.id, db); assert.equal(state.task?.status, 'PARTIAL'); assert.deepEqual(partialModes, ['EDIT', 'REPAIR']); assert.equal(state.document.editorialTodos.length, 1);
    assert.equal(state.action, 'BLOCKED'); assert.ok(state.task?.repairHalt); assert.match(state.continuationBlocker ?? '', /进展|重复|修改/);
    assert.equal(state.task.addedCalls, 2); assert.equal(state.task.repairCalls, 1); assert.equal(state.task.repairBudgetUsed, 1); assert.equal(state.task.repairRounds, 1);
    const halted = state, haltedRunCount = await db.pipelineRun.count({ where: { projectId: partial.id } });
    for (const options of [{}, { expectedState: state.expectedState }, { allowUnknownRetry: true }]) {
      await assert.rejects(api.queueFoundationDelivery(partial.id, options, db), /进展|重复|修改/);
      state = await api.getFoundationDeliveryState(partial.id, db); assert.equal(state.action, 'BLOCKED'); assert.deepEqual(state.task, halted.task); assert.deepEqual(state.document, halted.document);
      assert.equal(await db.pipelineRun.count({ where: { projectId: partial.id } }), haltedRunCount);
    }

    // A reviewed scene setting is genuinely new context, not a cleared task halt or a rewritten todo.
    const { applyLightScenePatches, loadLightScenes } = await import('@/lib/light-foundation-supply');
    await applyLightScenePatches(partial.id, db, [{ episode: 1, sceneKey: '1-1', weather: '雨后' }], await loadLightScenes(partial.id, db));
    state = await api.getFoundationDeliveryState(partial.id, db); assert.equal(state.action, 'CONTINUE'); assert.deepEqual(state.task, halted.task); assert.deepEqual(state.document.editorialTodos, halted.document.editorialTodos);
    const continuation = await api.queueFoundationDelivery(partial.id, { expectedState: state.expectedState }, db); await api.executeFoundationDelivery(partial.id, continuation.id, { db, stageRunner: async (_stage, prompt) => { const value = input(prompt); partialModes.push(value.delivery.mode); assert.equal(value.delivery.mode, 'REPAIR'); assert.deepEqual(value.scope, [1]); assert.equal(value.scenes[0].weather, '雨后'); assert.deepEqual(value.pendingChoices.map((c: { id: string }) => c.id), halted.document.editorialTodos.map(todo => todo.id)); return out(q1(value.scope, { scenes: [{ episode: 1, sceneKey: '1-1', weather: '雨后' }] }, { resolvedUnresolved: value.pendingChoices.map((c: { id: string }) => c.id) })); } });
    state = await api.getFoundationDeliveryState(partial.id, db); assert.equal(state.task?.status, 'COMPLETE'); assert.deepEqual(partialModes, ['EDIT', 'REPAIR', 'REPAIR']); assert.equal(state.task.addedCalls, 3); assert.equal(state.document.editorialTodos.length, 0);

    // Format repair is bounded; old V1 Q1 output cannot bypass the V2 transport boundary.
    const format = await create('safe V2 format'); let formatCalls = 0; const formatStages: string[] = []; const formatTask = await api.queueFoundationDelivery(format.id, {}, db);
    await api.executeFoundationDelivery(format.id, formatTask.id, { db, stageRunner: async (stage, prompt) => { const value = input(prompt); formatCalls++; formatStages.push(stage); if (formatCalls === 1) return { rawOutput: '{bad json', stdout: '', stderr: '' } as RoleRunResult; return out(stage === 'F2' ? f2(value.scope) : q1(value.scope)); } });
    state = await api.getFoundationDeliveryState(format.id, db); assert.equal(state.task?.status, 'PARTIAL'); assert.deepEqual(formatStages, ['F2']); assert.equal(state.task?.addedCalls, 1); assert.equal(state.task?.repairCalls, 0);
    const oldWire = await create('old V1 wire'); await seed(oldWire.id); const oldWireTask = await api.queueFoundationDelivery(oldWire.id, {}, db); await api.executeFoundationDelivery(oldWire.id, oldWireTask.id, { db, stageRunner: async (_stage, prompt) => out({ format: 'FOUNDATION_OPTIMIZATION_V1', coverage: input(prompt).scope, changes: {} }) }); state = await api.getFoundationDeliveryState(oldWire.id, db); assert.equal(state.complete, false); assert.equal(state.task?.status, 'PARTIAL');

    // Source/style drift, stop, successor and exited worker safety are controller protections, not mocks.
    const stale = await create('source style drift'); await seed(stale.id); state = await api.getFoundationDeliveryState(stale.id, db); await db.project.update({ where: { id: stale.id }, data: { style: '3D' } }); await assert.rejects(api.queueFoundationDelivery(stale.id, { expectedState: state.expectedState }, db), /状态|变化/); const staleTask = await api.queueFoundationDelivery(stale.id, {}, db); let staleCalls = 0; await db.episode.updateMany({ where: { projectId: stale.id, number: 1 }, data: { content: '第1集\n1-1 客厅 日 内\n人物：甲\n甲：新源文。\n' } }); await api.executeFoundationDelivery(stale.id, staleTask.id, { db, stageRunner: async () => { staleCalls++; throw new Error('must not call'); } }); assert.equal(staleCalls, 0);
    const stopped = await create('stop protects work'); const stoppedDoc = await seed(stopped.id); const stopTask = await api.queueFoundationDelivery(stopped.id, {}, db); await api.executeFoundationDelivery(stopped.id, stopTask.id, { db, stageRunner: async (_stage, prompt) => { await api.stopFoundationDelivery(stopped.id, stopTask.id, db); return out(q1(input(prompt).scope, { scenes: [{ episode: 1, sceneKey: '1-1', weather: '不应写入' }] }, { humanChoices: [choice] })); } }); state = await api.getFoundationDeliveryState(stopped.id, db); assert.equal(state.task?.status, 'STOPPED'); assert.deepEqual(state.document.f2, stoppedDoc.f2); assert.equal((await db.scriptScene.findFirstOrThrow({ where: { episode: { projectId: stopped.id, number: 1 }, sceneKey: '1-1' } })).weather, null); assert.equal(await db.presentationContract.count({ where: { projectId: stopped.id } }), 0); assert.equal(await db.asset.count({ where: { projectId: stopped.id } }), 0);
    const replacement = await create('old worker cannot stop successor'); await seed(replacement.id); const oldTask = await api.queueFoundationDelivery(replacement.id, {}, db); let oldEnter!: () => void, oldRelease!: () => void, newEnter!: () => void, newRelease!: () => void; const oldReady = new Promise<void>(r => { oldEnter = r; }), oldGate = new Promise<void>(r => { oldRelease = r; }), newReady = new Promise<void>(r => { newEnter = r; }), newGate = new Promise<void>(r => { newRelease = r; }); const oldRun = api.executeFoundationDelivery(replacement.id, oldTask.id, { db, workerToken: oldTask.workerToken!, stageRunner: async (_stage, prompt) => { oldEnter(); await oldGate; return out(q1(input(prompt).scope)); } }); await oldReady; await api.stopFoundationDelivery(replacement.id, oldTask.id, db); const successor = await api.queueFoundationDelivery(replacement.id, { allowUnknownRetry: true }, db); const newRun = api.executeFoundationDelivery(replacement.id, successor.id, { db, workerToken: successor.workerToken!, stageRunner: async (_stage, prompt) => { newEnter(); await newGate; return out(q1(input(prompt).scope)); } }); await newReady; oldRelease(); await oldRun; assert.equal((await api.getFoundationDeliveryState(replacement.id, db)).task?.status, 'RUNNING'); newRelease(); await newRun;
    const orphan = await create('dead worker continues'); await seed(orphan.id); const orphanTask = await api.queueFoundationDelivery(orphan.id, {}, db), orphanRow = await db.sceneSnapshot.findUniqueOrThrow({ where: { id: `foundation-delivery-${orphan.id}` } }); await db.sceneSnapshot.update({ where: { id: orphanRow.id }, data: { content: JSON.stringify({ ...JSON.parse(orphanRow.content), status: 'RUNNING', workerPid: 2147483647 }) } }); await db.pipelineRun.create({ data: { projectId: orphan.id, stageCode: 'Q1', roleName: 'Q1', status: 'RUNNING', inputSummary: JSON.stringify({ deliveryTaskId: orphanTask.id, workerToken: orphanTask.workerToken }), log: JSON.stringify({ calls: [{ requestOutcome: 'NOT_SENT', providerCallCount: 0 }] }) } }); state = await api.getFoundationDeliveryState(orphan.id, db); assert.equal(state.busy, false); assert.equal(state.action, 'CONTINUE'); await api.queueFoundationDelivery(orphan.id, { expectedState: state.expectedState }, db);

    // A confirmed fact remains pending on NOT_SENT; adaptive batching must not mark it applied early.
    const counted = await create('NOT_SENT never counts', true); await seed(counted.id);
    const countedInput = await loadFoundationInputs(counted.id, db);
    await syncFoundationChoices(db, counted.id, countedInput.sourceVersion, 'F2', [{ ...choice, episodes: [1, 2] }]);
    const pending = (await loadFoundationChoices(db, counted.id, countedInput.sourceVersion, true)).pending[0]!;
    await confirmFoundationChoice(db, { projectId: counted.id, contractId: pending.id, revision: pending.revision, optionIndex: '1' });
    const countedScopes: number[][] = []; const countedTask = await api.queueFoundationDelivery(counted.id, {}, db);
    await api.executeFoundationDelivery(counted.id, countedTask.id, { db, stageRunner: async (_stage, prompt) => {
      countedScopes.push(input(prompt).scope); throw Object.assign(new Error('preflight unavailable'), { requestOutcome: 'NOT_SENT' });
    } });
    state = await api.getFoundationDeliveryState(counted.id, db);
    assert.equal(state.document.decisionCoverage?.[pending.id], undefined, '未发送不能登记决定已采用');
    assert.equal(state.task?.addedCalls, 0);
    const countedResume = await api.queueFoundationDelivery(counted.id, {}, db);
    await api.executeFoundationDelivery(counted.id, countedResume.id, { db, stageRunner: async (_stage, prompt) => {
      const value = input(prompt); countedScopes.push(value.scope);
      return out(q1(value.scope, {}, { appliedDecisions: value.confirmedDecisions.map((c: { id: string }) => ({ id: c.id, note: '已采用' })) }));
    } });
    state = await api.getFoundationDeliveryState(counted.id, db);
    assert.deepEqual(countedScopes, [[1,2],[1,2]]);
    assert.deepEqual(state.document.decisionCoverage?.[pending.id]?.episodes, [1,2]);
    assert.equal(state.task?.addedCalls, 1); assert.equal(state.complete, true);

    // Import/no-source guards and legacy entry lease remain intact.
    const gap = await create('source unresolved'); const gapDoc = await seed(gap.id), sourceText = '甲站立。\n待归属的原文。'; await db.sceneSnapshot.create({ data: { projectId: gap.id, sceneKey: 'SOURCE_IMPORT', metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }), content: JSON.stringify({ sourceText, sourceStructure: { version: 'SOURCE_STRUCTURE_V1', sections: [{ key: 'E', kind: 'EPISODE', start: 0, end: 5 }, { key: 'U', kind: 'UNRESOLVED', start: 5, end: sourceText.length }], issues: [] } }) } }); const gapInput = await loadFoundationInputs(gap.id, db), fresh = createEmptyDocument(gapInput); await saveFoundationDocument(db, gap.id, gapDoc.revision, { ...gapDoc, editorialCoverage: [1, 2], sourceContextVersion: fresh.sourceContextVersion, settingsFingerprint: fresh.settingsFingerprint }, 'current gap fixture'); state = await api.getFoundationDeliveryState(gap.id, db); assert.equal(state.sourceContext.unresolved.length, 1); assert.equal(state.complete, false); assert.ok(state.issues.some((issue: { coordinate: string }) => issue.coordinate.startsWith('source.')));
    const noSource = await db.project.create({ data: { title: 'empty source safe' } }); state = await api.getFoundationDeliveryState(noSource.id, db); assert.equal(state.action, 'NONE'); assert.equal(state.complete, false); assert.ok(state.issues.length);
    const mutex = await create('legacy lease'); const mutexInput = await loadFoundationInputs(mutex.id, db); await db.presentationContract.create({ data: { projectId: mutex.id, category: 'PRODUCTION_CHOICE', question: '旧入口确认', options: '["甲","乙"]' } }); const mutexChoice = (await loadFoundationChoices(db, mutex.id, mutexInput.sourceVersion)).pending[0]!; await api.queueFoundationDelivery(mutex.id, {}, db); await assert.rejects(confirmFoundationChoice(db, { projectId: mutex.id, contractId: mutexChoice.id, revision: mutexChoice.revision, optionIndex: '0' }), /整理|执行|运行/); const { queueSingleFoundationStage } = await import('@/lib/project-foundation'); let legacyCalls = 0; await assert.rejects(queueSingleFoundationStage(mutex.id, 'F1', undefined, { db, stageRunner: async () => { legacyCalls++; return out({}); } }), /整理|执行|运行/); assert.equal(legacyCalls, 0);

    // Snapshot at the true stop point: changes already committed before stop are allowed; no later old-worker write is.
    for (const boundary of [1, 2]) {
      const txProject = await create(`transaction boundary ${boundary}`), txDoc = await seed(txProject.id), txTask = await api.queueFoundationDelivery(txProject.id, {}, db);
      const original = db.$transaction.bind(db); let left = 0, replaced = false;
      let stoppedScene: string | null = null, stoppedF2: unknown = null, stoppedCoverage: number[] = [], stoppedCards = 0, stoppedAssets = 0;
      db.$transaction = (async (...args: unknown[]) => {
        if (left > 0 && --left === 0) {
          stoppedScene = (await db.scriptScene.findFirstOrThrow({ where: { episode: { projectId: txProject.id, number: 1 }, sceneKey: '1-1' } })).weather;
          const atStop = await api.getFoundationDeliveryState(txProject.id, db); stoppedF2 = atStop.document.f2; stoppedCoverage = atStop.document.editorialCoverage; stoppedCards = await db.presentationContract.count({ where: { projectId: txProject.id } }); stoppedAssets = await db.asset.count({ where: { projectId: txProject.id } });
          await api.stopFoundationDelivery(txProject.id, txTask.id, db); const next = await api.queueFoundationDelivery(txProject.id, {}, db); replaced = next.workerToken !== txTask.workerToken;
        }
        return (original as (...args: unknown[]) => Promise<unknown>)(...args);
      }) as typeof db.$transaction;
      try { await api.executeFoundationDelivery(txProject.id, txTask.id, { db, stageRunner: async (_stage, prompt) => { left = boundary; return out(q1(input(prompt).scope, { scenes: [{ episode: 1, sceneKey: '1-1', weather: '旧任务不应落稿' }] }, { humanChoices: [choice] })); } }); } finally { db.$transaction = original; }
      state = await api.getFoundationDeliveryState(txProject.id, db); assert.equal(replaced, true); assert.equal(state.task?.status, 'QUEUED'); assert.deepEqual(state.document.f2, stoppedF2 ?? txDoc.f2); assert.deepEqual(state.document.editorialCoverage, stoppedCoverage);
      assert.equal((await db.scriptScene.findFirstOrThrow({ where: { episode: { projectId: txProject.id, number: 1 }, sceneKey: '1-1' } })).weather, stoppedScene, 'old worker cannot patch a scene after stop');
      assert.equal(await db.presentationContract.count({ where: { projectId: txProject.id } }), stoppedCards, 'old worker cannot create cards after stop'); assert.equal(await db.asset.count({ where: { projectId: txProject.id } }), stoppedAssets, 'old worker cannot register assets after stop');
    }
    const unknown = await create('UNKNOWN preserves draft'); const unknownDoc = await seed(unknown.id), unknownTask = await api.queueFoundationDelivery(unknown.id, {}, db); let unknownCalls = 0; await api.executeFoundationDelivery(unknown.id, unknownTask.id, { db, stageRunner: async () => { unknownCalls++; throw Object.assign(new Error('connection lost after send'), { requestOutcome: 'UNKNOWN' }); } }); state = await api.getFoundationDeliveryState(unknown.id, db); assert.equal(unknownCalls, 1); assert.equal(state.action, 'UNKNOWN_CONFIRM'); assert.deepEqual(state.document.f2, unknownDoc.f2); await assert.rejects(api.queueFoundationDelivery(unknown.id, {}, db), /未知|重发|确认/);
    console.log('PASS: light delivery retains source, scene assets, scoped receipts, lease/stop guards and unknown-call safety');
  } finally { await db.$disconnect(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch (cleanupError) { console.warn("Temporary test database retained because Windows still holds it:", dir); } }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
