/** Offline controller regressions: this file never uses a real provider. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '@/lib/role-runner';

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'unactionable-repair-'));
  const url = `file:${directory}/test.db`; process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  const { queueFoundationDelivery, executeFoundationDelivery, getFoundationDeliveryState, applyFoundationProgramRepair, confirmAndContinueFoundationDelivery } = await import('@/lib/foundation-delivery');
  const response = (data: unknown): RoleRunResult => ({ data: data as Record<string, unknown>, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null });
  const source = '第1集\n1-1 日 内 大厅\n人物：甲\n甲：出事了。\n△城外山顶，一座云台悬在半空。\n';
  const failures: string[] = [];
  async function check(name: string, run: () => Promise<void>) { try { await run(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
  const create = (title: string) => db.project.create({ data: { title, episodes: { create: [{ number: 1, title: '第一集', content: source }] } } });
  const catalog = { format: 'ASSET_CATALOG_V2', coverage: [1], assets: [{ name: '云台', type: 'LOC', episodes: [1], sceneRefs: [{ episode: 1, sceneKey: '1-1' }], preparation: { mode: 'REFERENCE' } }] };
  try {
    await check('响应日志瞬时保存失败不能阻断有效F1/F2/Q1的本地复验', async () => {
      for (const failedStage of ['F2', 'Q1', 'F1']) {
        let project: { id: string };
        if (failedStage === 'F1') {
          const { importProjectFromText } = await import('@/lib/workflow'), owner = await db.user.create({ data: { username: 'log-recovery-f1', email: 'log-recovery-f1@example.invalid', passwordHash: 'offline' } });
          project = (await importProjectFromText({ ownerUserId: owner.id, title: '响应日志故障-F1', sourceName: 'source.txt', sourceText: '第1集\n甲片。\n第2集\n乙片。\n第1集\n丙片。\n' }, db)).project;
        } else project = await create(`响应日志故障-${failedStage}`);
        const task = await queueFoundationDelivery(project.id, {}, db), stages: string[] = [];
        let failOnce = true;
        const failingDb = db.$extends({ query: { pipelineRun: { update({ args, query }) {
          const log = args.data.log && JSON.parse(String(args.data.log));
          if (failOnce && log?.stageCode === failedStage && log.calls?.some((call: { requestOutcome: string; status: string }) => call.requestOutcome === 'RESPONDED' && call.status === 'RUNNING')) { failOnce = false; throw new Error('review transient log persist failure'); }
          return query(args);
        } } } }) as unknown as PrismaClient;
        const runner = async (stage: 'F1' | 'F2' | 'Q1', prompt: string) => {
          stages.push(stage); const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
          if (stage === 'F1') return response({ assignments: input.sections.map((section: { key: string }, index: number) => ({ sectionKey: section.key, kind: 'EPISODE', episodeNumber: index === 0 ? 1 : 3 })) });
          return response(stage === 'F2' ? failedStage === 'F1' ? { format: 'ASSET_CATALOG_V2', coverage: input.scope, assets: [] } : catalog : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: {} });
        };
        await executeFoundationDelivery(project.id, task.id, { db: failingDb, stageRunner: runner });
        const before = await getFoundationDeliveryState(project.id, db), count = await db.pipelineRun.count({ where: { projectId: project.id } });
        assert.match(before.task?.error ?? '', /transient log persist failure/); assert.notEqual(before.action, 'BLOCKED', '必须先复验现有响应，不以旧status/issues判断无法恢复');
        assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), count, '读取及复验不创建运行记录');
        const retry = await queueFoundationDelivery(project.id, {}, db); await executeFoundationDelivery(project.id, retry.id, { db, stageRunner: runner });
        assert.deepEqual(stages, failedStage === 'F1' ? ['F1', 'F2', 'Q1'] : ['F2', 'Q1'], '每岗只购买一次，恢复不能重买已返回正文');
        assert.equal((await getFoundationDeliveryState(project.id, db)).complete, true);
      }
    });
    await check('只给第2集新增确认决定不能解锁第1集已耗尽的格式请求', async () => {
      const project = await db.project.create({ data: { title: '决定不能越范围刷新成本', episodes: { create: [1, 2].map(number => ({ number, content: `第${number}集\n${number}-1 客厅 日 内\n人物：甲\n${'甲：沉默。\n'.repeat(3100)}` })) } } });
      const task = await queueFoundationDelivery(project.id, {}, db); let calls = 0;
      const fail = async (_stage: 'F1' | 'F2' | 'Q1', prompt: string) => { assert.deepEqual(JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!).scope, [1]); calls++; throw Object.assign(new Error('CLI返回内容不是合法JSON'), { requestOutcome: 'RESPONDED', rawOutput: '{坏JSON' }); };
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: fail });
      const { loadFoundationInputs } = await import('@/lib/foundation-state'), input = await loadFoundationInputs(project.id, db);
      await db.presentationContract.create({ data: { projectId: project.id, category: 'VISUAL', question: '仅第2集灰衣颜色', options: '[]', userAnswer: '灰色', status: 'CONFIRMED',
        note: JSON.stringify({ schema: 'FOUNDATION_HUMAN_CHOICE_V1', sourceVersion: input.sourceVersion, decisionKey: 'ep2-color', episodes: [2], sourceStages: ['Q1'], reason: '', recommended: '', recommendationReason: '' }) } });
      const state = await getFoundationDeliveryState(project.id, db);
      if (state.action !== 'BLOCKED') { const retry = await queueFoundationDelivery(project.id, {}, db); await executeFoundationDelivery(project.id, retry.id, { db, stageRunner: fail }); }
      assert.equal(calls, 2, '无关决定不能购买第1集的新INITIAL/FORMAT');
    });
    await check('改第1集可更新第1集，但第4集失败仍绑定原来已耗尽的总预算', async () => {
      for (const identityRelevantToFourth of [false, true]) {
      const project = await db.project.create({ data: { title: '旧失败不能领无关新预算', episodes: { create: [1, 2, 3, 4].map(number => ({ number, content: `第${number}集\n${number}-1 客厅 日 内\n人物：甲\n${identityRelevantToFourth && number === 4 ? '△甲听见铜铃一响。\n' : ''}${'甲：沉默。\n'.repeat(3100)}` })) } } });
      const task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (_stage, prompt) => { const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!); if (!input.repairRequest) throw Object.assign(new Error('CLI返回内容不是合法JSON'), { requestOutcome: 'RESPONDED', rawOutput: '{坏JSON' }); return response({ format: 'ASSET_CATALOG_V2', coverage: input.scope, assets: [] }); } });
      assert.equal((await getFoundationDeliveryState(project.id, db)).task?.repairBudgetUsed, 3);
      const first = await db.episode.findFirstOrThrow({ where: { projectId: project.id, number: 1 } }); await db.episode.update({ where: { id: first.id }, data: { content: first.content.replace('人物：甲\n', '人物：甲\n△甲拿出一枚仅在本场出现的铜铃。\n') } });
      const { preprocessProject } = await import('@/lib/project-preprocess'); await preprocessProject(project.id, db);
      const requests: [string, number[], string][] = [], retry = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, retry.id, { db, stageRunner: async (stage, prompt) => {
        const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!); requests.push([stage, input.scope, input.repairRequest ? 'FORMAT' : 'INITIAL']);
        const known = input.registry?.find((asset: { name: string; key: string }) => asset.name === '铜铃');
        const assets = input.scope.includes(1) || identityRelevantToFourth && input.scope.includes(4)
          ? [{ ...(known ? { key: known.key } : {}), name: '铜铃', type: 'PROP', episodes: input.scope, sceneRefs: input.scope.map((episode: number) => ({ episode, sceneKey: `${episode}-1` })), preparation: { mode: 'REFERENCE' } }] : [];
        return response(stage === 'F2' ? { format: 'ASSET_CATALOG_V2', coverage: input.scope, assets } : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: {} });
      } });
      assert.ok(requests.some(([stage, scope]) => stage === 'F2' && scope.length === 1 && scope[0] === 1), '真实改变的第1集仍能推进');
      const fourth = requests.filter(([, scope]) => scope.includes(4));
      if (identityRelevantToFourth) assert.ok(fourth.some(([stage, , kind]) => stage === 'F2' && kind === 'INITIAL'), '第4集源文明示同一铜铃时，新身份事实可用于真实相关工作');
      else assert.equal(fourth.length, 0, '仅第1集出现的铜铃不能给同一第4集失败领取新费用');
      const state = await getFoundationDeliveryState(project.id, db);
      assert.ok(state.document.f2?.assets.some(asset => asset.name === '铜铃'), '回归必须保存实际新增资产，不能靠空目录通过');
      const { loadFoundationInputs } = await import('@/lib/foundation-state'), { loadLightScenes } = await import('@/lib/light-foundation-supply'), { buildDeliveryInput } = await import('@/lib/foundation-delivery');
      const supplied = buildDeliveryInput('F2', 'GENERATE_F2', await loadFoundationInputs(project.id, db), state.document, [4], [], [], state.document.f2!.assets, await loadLightScenes(project.id, db));
      assert.ok('registry' in supplied && supplied.registry.some(asset => asset.name === '铜铃'), '生产输入仍保留完整身份索引；只收窄成本权限依据');
      }
    });
    await check('删除任务行不能丢掉UNKNOWN的明确同意要求', async () => {
      const project = await create('未知证据独立于任务行'), task = await queueFoundationDelivery(project.id, {}, db); let calls = 0;
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async () => { calls++; throw Object.assign(new Error('发送后连接中断'), { requestOutcome: 'UNKNOWN' }); } });
      assert.equal((await getFoundationDeliveryState(project.id, db)).action, 'UNKNOWN_CONFIRM');
      await db.sceneSnapshot.delete({ where: { id: `foundation-delivery-${project.id}` } });
      assert.equal((await getFoundationDeliveryState(project.id, db)).action, 'UNKNOWN_CONFIRM');
      await assert.rejects(queueFoundationDelivery(project.id, {}, db), /未知|确认|重发/); assert.equal(calls, 1);
      const retry = await queueFoundationDelivery(project.id, { allowUnknownRetry: true }, db);
      await executeFoundationDelivery(project.id, retry.id, { db, stageRunner: async stage => { calls++; return response(stage === 'F2' ? catalog : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {} }); } });
      assert.equal(calls, 3); assert.equal((await getFoundationDeliveryState(project.id, db)).complete, true);
    });
    await check('删除任务后未知请求仍禁止程序维护写入', async () => {
      const project = await create('维护同样尊重未知结果'), task = await queueFoundationDelivery(project.id, {}, db); let calls = 0;
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async stage => {
        calls++; if (stage === 'F2') return response(catalog);
        throw Object.assign(new Error('编辑请求发送后连接中断'), { requestOutcome: 'UNKNOWN' });
      } });
      await db.sceneSnapshot.delete({ where: { id: `foundation-delivery-${project.id}` } });
      const before = await getFoundationDeliveryState(project.id, db);
      assert.equal(before.action, 'UNKNOWN_CONFIRM'); assert.equal(before.task, null);
      const scene = await db.scriptScene.findFirstOrThrow({ where: { sceneKey: '1-1', episode: { projectId: project.id } } });
      const snapshots = await db.sceneSnapshot.count({ where: { projectId: project.id } });
      await assert.rejects(applyFoundationProgramRepair(project.id, { expectedRevision: before.document.revision, scope: [1],
        output: { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: { scenes: [{ episode: 1, sceneKey: '1-1', weather: '雨' }] } } }, db), /未知/);
      assert.equal((await getFoundationDeliveryState(project.id, db)).document.revision, before.document.revision);
      assert.deepEqual(await db.scriptScene.findUniqueOrThrow({ where: { id: scene.id } }), scene);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: project.id } }), snapshots);
      assert.equal(calls, 2, '拒绝维护不会追加模型请求');
    });
    await check('完成即停，普通队列和未知结果按钮都不能无目标重跑', async () => {
      const project = await create('完成没有再次优化入口'), task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async stage => response(stage === 'F2' ? catalog : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {} }) });
      const state = await getFoundationDeliveryState(project.id, db), count = await db.pipelineRun.count({ where: { projectId: project.id } });
      assert.equal(state.complete, true); assert.equal(state.action, 'NONE');
      for (const options of [{}, { allowUnknownRetry: true }, { expectedState: state.expectedState }]) await assert.rejects(queueFoundationDelivery(project.id, options, db), /已完成|已整理|没有.*(?:变化|待办)|无需/);
      assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), count);
      assert.equal((await getFoundationDeliveryState(project.id, db)).document.revision, state.document.revision);
    });
    await check('旧requestedOptimization任务记录不能强制整剧再编辑', async () => {
      const project = await create('旧优化标记不再生效'), task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async stage => response(stage === 'F2' ? catalog : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {} }) });
      const state = await getFoundationDeliveryState(project.id, db);
      await db.sceneSnapshot.update({ where: { id: `foundation-delivery-${project.id}` }, data: { content: JSON.stringify({ ...state.task, status: 'QUEUED', workerPid: null, requestedOptimization: true }) } });
      let calls = 0;
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async () => { calls++; return response({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {} }); } });
      assert.equal(calls, 0, '忽略旧记录里的普通全剧优化开关');
      assert.equal((await getFoundationDeliveryState(project.id, db)).complete, true);
    });
    await check('仅规则版本更新不能触发付费重跑；全源核对后才可明确采纳', async () => {
      const { saveFoundationDocument } = await import('@/lib/foundation-document');
      const { LIGHT_ASSET_METHOD_VERSION } = await import('@/lib/foundation-production-prompts');
      const project = await create('规则更新不是新生成目标'), task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async stage => response(stage === 'F2' ? catalog : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {} }) });
      const before = await getFoundationDeliveryState(project.id, db);
      const older = await saveFoundationDocument(db, project.id, before.document.revision, { ...before.document, assetMethodVersion: 'previous-reviewed-method' }, '保留当时已核对版本');
      const state = await getFoundationDeliveryState(project.id, db);
      assert.equal(state.complete, true); assert.equal(state.action, 'NONE'); assert.equal(state.methodUpdateAvailable, true);
      assert.equal(state.document.assetMethodVersion, 'previous-reviewed-method');
      await assert.rejects(queueFoundationDelivery(project.id, {}, db), /已完成|已整理|无需/);
      const count = await db.pipelineRun.count({ where: { projectId: project.id } });
      await assert.rejects(applyFoundationProgramRepair(project.id, { expectedRevision: older.revision, scope: [1], output: { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {} }, reviewedAssetMethodVersion: 'not-current' }, db), /方法|版本/);
      await assert.rejects(applyFoundationProgramRepair(project.id, { expectedRevision: older.revision, scope: [], output: { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [], changes: {} }, reviewedAssetMethodVersion: LIGHT_ASSET_METHOD_VERSION }, db), /范围|全.*集|覆盖/);
      const adopted = await applyFoundationProgramRepair(project.id, { expectedRevision: older.revision, scope: [1], output: { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {} }, reviewedAssetMethodVersion: LIGHT_ASSET_METHOD_VERSION }, db);
      assert.equal(adopted.document.assetMethodVersion, LIGHT_ASSET_METHOD_VERSION); assert.equal(adopted.methodUpdateAvailable, false);
      assert.deepEqual(adopted.document.editorialCoverage, older.editorialCoverage); assert.deepEqual(adopted.document.origins, older.origins);
      assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), count);
    });
    await check('已付费非法JSON跨继续最多一次格式修复，重建任务也不能重置', async () => {
      const project = await create('跨任务持久格式额度'), task = await queueFoundationDelivery(project.id, {}, db);
      let calls = 0;
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async () => { calls++; throw Object.assign(new Error('CLI返回内容不是合法JSON'), { requestOutcome: 'RESPONDED', rawOutput: '{坏JSON' }); } });
      assert.equal(calls, 2, '初次请求加最多一次格式修复');
      let state = await getFoundationDeliveryState(project.id, db);
      assert.equal(state.action, 'BLOCKED'); assert.match(state.continuationBlocker ?? '', /已付费|格式|重复|额度/);
      for (const options of [{}, { allowUnknownRetry: true }]) await assert.rejects(queueFoundationDelivery(project.id, options, db), /已付费|格式|重复|额度/);
      await db.sceneSnapshot.delete({ where: { id: `foundation-delivery-${project.id}` } });
      state = await getFoundationDeliveryState(project.id, db);
      assert.equal(state.action, 'BLOCKED', '限制依据项目调用证据，不依赖可重建的task行');
      await assert.rejects(queueFoundationDelivery(project.id, {}, db), /已付费|格式|重复|额度/);
      assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), 1);
    });
    await check('旧运行无新指纹时，换任务/提示文案/文稿revision仍不能解锁付费失败', async () => {
      const project = await create('旧证据仍可阻止重复收费'), task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async () => { throw Object.assign(new Error('CLI返回内容不是合法JSON'), { requestOutcome: 'RESPONDED', rawOutput: '{坏JSON' }); } });
      const run = await db.pipelineRun.findFirstOrThrow({ where: { projectId: project.id } }), queued = JSON.parse(run.inputSummary!), log = JSON.parse(run.log!);
      for (const key of ['workFingerprint', 'receiverVersion', 'repairBudgetKey', 'repairBudgetContext']) delete queued[key];
      queued.deliveryTaskId = 'legacy-renamed-task'; queued.documentRevision = 'different-revision-only';
      for (const attempt of log.calls) {
        const input = JSON.parse(attempt.taskPrompt.split('INPUT_JSON:\n').at(-1)!);
        input.delivery.documentRevision = 'another-revision'; input.delivery.instructions = '换了说明而已，不构成新目标';
        attempt.taskPrompt = `只是提示文案调整。\nINPUT_JSON:\n${JSON.stringify(input)}`; attempt.systemPrompt += '\n仅修改规则措辞。'; attempt.error = '同一错误改写了说明';
      }
      await db.pipelineRun.update({ where: { id: run.id }, data: { inputSummary: JSON.stringify(queued), log: JSON.stringify(log) } });
      const { saveFoundationDocument } = await import('@/lib/foundation-document'), state = await getFoundationDeliveryState(project.id, db);
      await saveFoundationDocument(db, project.id, state.document.revision, { ...state.document, notes: ['仅改可读说明，不改变事实'] }, 'revision-only fixture');
      await db.sceneSnapshot.delete({ where: { id: `foundation-delivery-${project.id}` } });
      assert.equal((await getFoundationDeliveryState(project.id, db)).action, 'BLOCKED');
      await assert.rejects(queueFoundationDelivery(project.id, { allowUnknownRetry: true }, db), /已付费|格式|重复|额度/);
      assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), 1);
    });
    await check('文稿保存失败的已付费响应跨task与仅revision变化恢复，不重买该岗位', async () => {
      const { createEmptyDocument, saveFoundationDocument } = await import('@/lib/foundation-document'), { loadFoundationInputs } = await import('@/lib/foundation-state');
      const { LIGHT_ASSET_METHOD_VERSION } = await import('@/lib/foundation-production-prompts');
      const project = await create('保存失败零调用恢复'), input = await loadFoundationInputs(project.id, db), initial = createEmptyDocument(input);
      await saveFoundationDocument(db, project.id, initial.revision, { ...initial, workflow: 'LIGHT_STAGE1_V1', assetMethodVersion: LIGHT_ASSET_METHOD_VERSION }, '保存前工作稿');
      let failSave = true;
      const failingDb = db.$extends({ query: { sceneSnapshot: { create({ args, query }) {
        if (args.data.sceneKey === 'FOUNDATION_DOCUMENT' && failSave) { failSave = false; throw new Error('模拟文稿保存失败'); }
        return query(args);
      } } } }) as unknown as PrismaClient;
      const task = await queueFoundationDelivery(project.id, {}, db); const stages: string[] = [];
      await executeFoundationDelivery(project.id, task.id, { db: failingDb, stageRunner: async stage => { stages.push(stage); return response(catalog); } });
      let state = await getFoundationDeliveryState(project.id, db); assert.equal(state.task?.status, 'PARTIAL'); assert.deepEqual(stages, ['F2']);
      const run = await db.pipelineRun.findFirstOrThrow({ where: { projectId: project.id, stageCode: 'F2' } });
      await saveFoundationDocument(db, project.id, state.document.revision, { ...state.document, notes: [...state.document.notes, '只改工作说明'] }, '换revision但事实不变');
      await db.sceneSnapshot.delete({ where: { id: `foundation-delivery-${project.id}` } });
      const retry = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, retry.id, { db, stageRunner: async stage => { stages.push(stage); assert.equal(stage, 'Q1', '已保存F2须本地复用'); return response({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {} }); } });
      state = await getFoundationDeliveryState(project.id, db); assert.equal(state.complete, true, state.task?.error ?? '应复用已付费响应'); assert.deepEqual(stages, ['F2', 'Q1']);
      assert.equal((await db.pipelineRun.findUniqueOrThrow({ where: { id: run.id } })).log, run.log, '本地重验不重写原调用证据');
      assert.ok(state.document.origins.some(origin => origin.runId === run.id));
    });
    await check('真正只改一集源文时，仅允许该集必要F2和Q1，保留其它已完成集', async () => {
      const project = await db.project.create({ data: { title: '只更新受影响源文', episodes: { create: [1, 2].map(number => ({ number, content: source.replace('第1集', `第${number}集`).replace('1-1', `${number}-1`) })) } } });
      const task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => { const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!); return response(stage === 'F2' ? { format: 'ASSET_CATALOG_V2', coverage: input.scope, assets: [] } : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: {} }); } });
      await db.episode.updateMany({ where: { projectId: project.id, number: 1 }, data: { content: source.replace('出事了。', '原文实际改变了。') } });
      const retry = await queueFoundationDelivery(project.id, {}, db), scopes: [string, number[]][] = [];
      await executeFoundationDelivery(project.id, retry.id, { db, stageRunner: async (stage, prompt) => { const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!); scopes.push([stage, input.scope]); return response(stage === 'F2' ? { format: 'ASSET_CATALOG_V2', coverage: input.scope, assets: [] } : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: {} }); } });
      assert.deepEqual(scopes, [['F2', [1]], ['Q1', [1]]]); assert.equal((await getFoundationDeliveryState(project.id, db)).complete, true);
    });
    await check('无关后续集的修改不能仅靠全剧source version变化解锁前批付费失败', async () => {
      const project = await db.project.create({ data: { title: 'source范围不能用全局revision绕过', episodes: { create: [1, 2].map(number => ({ number, content: `第${number}集\n${number}-1 客厅 日 内\n人物：甲\n${'甲：沉默。\n'.repeat(3100)}` })) } } });
      const task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (_stage, prompt) => { const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!); assert.deepEqual(input.scope, [1]); throw Object.assign(new Error('CLI返回内容不是合法JSON'), { requestOutcome: 'RESPONDED', rawOutput: '{坏JSON' }); } });
      await db.episode.updateMany({ where: { projectId: project.id, number: 2 }, data: { content: '第2集\n2-1 客厅 日 内\n人物：甲\n甲：只改未供给前批的后续集。\n' } });
      const { preprocessProject } = await import('@/lib/project-preprocess'); await preprocessProject(project.id, db);
      assert.equal((await getFoundationDeliveryState(project.id, db)).action, 'BLOCKED');
      await assert.rejects(queueFoundationDelivery(project.id, {}, db), /已付费|格式|重复|额度/);
    });
    await check('F1付费边界失败同样不能跨继续重置', async () => {
      const { importProjectFromText } = await import('@/lib/workflow');
      const owner = await db.user.create({ data: { username: 'cost-source', email: 'cost-source@example.invalid', passwordHash: 'offline' } });
      const { project } = await importProjectFromText({ ownerUserId: owner.id, title: 'F1边界失败额度', sourceName: 'source.txt', sourceText: '第1集\n甲片。\n第2集\n乙片。\n第1集\n丙片。\n' }, db);
      const task = await queueFoundationDelivery(project.id, {}, db); let calls = 0;
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async stage => { assert.equal(stage, 'F1'); calls++; throw Object.assign(new Error('CLI返回内容不是合法JSON'), { requestOutcome: 'RESPONDED', rawOutput: '{坏JSON' }); } });
      assert.equal(calls, 2);
      const state = await getFoundationDeliveryState(project.id, db); assert.equal(state.action, 'BLOCKED');
      await assert.rejects(queueFoundationDelivery(project.id, { allowUnknownRetry: true }, db), /已付费|格式|重复|额度/);
    });
    await check('格式修复NOT_SENT不消费额度，继续只发送尚未发出的修复', async () => {
      const project = await create('未发送不是已消费'), task = await queueFoundationDelivery(project.id, {}, db), attempts: string[] = [];
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => {
        const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!); attempts.push(input.repairRequest ? 'FORMAT_REPAIR' : stage);
        throw Object.assign(new Error(input.repairRequest ? '本地预检失败' : 'CLI返回内容不是合法JSON'), { requestOutcome: input.repairRequest ? 'NOT_SENT' : 'RESPONDED', rawOutput: '{坏JSON' });
      } });
      let state = await getFoundationDeliveryState(project.id, db); assert.equal(state.task?.addedCalls, 1); assert.notEqual(state.action, 'BLOCKED');
      const retry = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, retry.id, { db, stageRunner: async (stage, prompt) => {
        const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!); attempts.push(input.repairRequest ? 'FORMAT_REPAIR' : stage);
        if (stage === 'F2') { assert.ok(input.repairRequest, '已付费首轮不能重新购买'); return response(catalog); }
        return response({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {} });
      } });
      state = await getFoundationDeliveryState(project.id, db);
      assert.deepEqual(attempts, ['F2', 'FORMAT_REPAIR', 'FORMAT_REPAIR', 'Q1']); assert.equal(state.task?.addedCalls, 3); assert.equal(state.complete, true, state.task?.error ?? '应仅恢复未发送修复');
    });
    await check('真实UNKNOWN格式请求必须明确同意才能重发，仍占累计修正预算', async () => {
      const project = await create('未知格式请求保留同意边界'), task = await queueFoundationDelivery(project.id, {}, db); let calls = 0;
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (_stage, prompt) => {
        const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!); calls++;
        throw Object.assign(new Error(input.repairRequest ? '发送后连接中断' : 'CLI返回内容不是合法JSON'), { requestOutcome: input.repairRequest ? 'UNKNOWN' : 'RESPONDED', rawOutput: '{坏JSON' });
      } });
      let state = await getFoundationDeliveryState(project.id, db); assert.equal(state.action, 'UNKNOWN_CONFIRM');
      await assert.rejects(queueFoundationDelivery(project.id, {}, db), /未知|确认|重发/);
      const retry = await queueFoundationDelivery(project.id, { allowUnknownRetry: true }, db);
      await executeFoundationDelivery(project.id, retry.id, { db, stageRunner: async (stage, prompt) => {
        const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!); calls++;
        if (stage === 'F2') assert.ok(input.repairRequest, '只能重发未知的格式修复，不能重买初始稿');
        return response(stage === 'F2' ? catalog : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {} });
      } });
      state = await getFoundationDeliveryState(project.id, db); assert.equal(state.complete, true, state.task?.error ?? '明确同意应能恢复未知请求');
      assert.equal(calls, 4); assert.equal(state.task?.repairBudgetUsed, 2, '未知尝试与同意重发都计入总修正限额');
    });
    await check('显式给足四次测试预算后，各批格式限额独立且后批取得边界事实', async () => {
      const project = await db.project.create({ data: { title: '四批各自格式修复', episodes: { create: [1, 2, 3, 4].map(number => ({ number, content: `第${number}集\n${number}-1 客厅 日 内\n人物：甲\n${'甲：沉默。\n'.repeat(3100)}` })) } } });
      const task = await queueFoundationDelivery(project.id, {}, db), requests: [string, number[]][] = [];
      await db.sceneSnapshot.update({ where: { id: `foundation-delivery-${project.id}` }, data: { content: JSON.stringify({ ...task, maxRepairCalls: 4 }) } });
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => {
        const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!); requests.push([stage, input.scope]);
        if (input.scope[0] > 1) assert.ok(input.boundaryContext, '后批须收到已有边界事实，而不是空上下文');
        if (stage === 'F2' && !input.repairRequest) throw Object.assign(new Error('CLI返回内容不是合法JSON'), { requestOutcome: 'RESPONDED', rawOutput: '{坏JSON' });
        return response(stage === 'F2' ? { format: 'ASSET_CATALOG_V2', coverage: input.scope, assets: [] } : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: {} });
      } });
      const state = await getFoundationDeliveryState(project.id, db);
      assert.equal(state.complete, true, state.task?.error ?? '独立批次不能被前批格式计数锁死');
      assert.equal(requests.filter(([stage]) => stage === 'F2').length, 8); assert.equal(requests.filter(([stage]) => stage === 'Q1').length, 4); assert.equal(state.task?.addedCalls, 12);
    });
    await check('默认累计三次修正用尽后仍允许新片初始请求，但禁止第四次修正及跨任务重置', async () => {
      const project = await db.project.create({ data: { title: '累计三次修正上限', episodes: { create: [1, 2, 3, 4].map(number => ({ number, content: `第${number}集\n${number}-1 客厅 日 内\n人物：甲\n${'甲：沉默。\n'.repeat(3100)}` })) } } });
      const task = await queueFoundationDelivery(project.id, {}, db), requests: number[][] = [];
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => {
        const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!); requests.push(input.scope);
        if (!input.repairRequest) throw Object.assign(new Error('CLI返回内容不是合法JSON'), { requestOutcome: 'RESPONDED', rawOutput: '{坏JSON' });
        return response({ format: 'ASSET_CATALOG_V2', coverage: input.scope, assets: [] });
      } });
      const state = await getFoundationDeliveryState(project.id, db);
      assert.deepEqual(requests, [[1], [1], [2], [2], [3], [3], [4]], '新片初始请求不受修正额度阻断，只有第四次修正被禁止');
      assert.equal(state.availableEpisodes, 3); assert.equal(state.task?.repairCalls, 3); assert.equal(state.task?.repairBudgetUsed, 3); assert.equal(state.action, 'BLOCKED');
      await assert.rejects(queueFoundationDelivery(project.id, {}, db), /额度|修正|重复/);
      await db.sceneSnapshot.delete({ where: { id: `foundation-delivery-${project.id}` } });
      await assert.rejects(queueFoundationDelivery(project.id, { allowUnknownRetry: true }, db), /额度|修正|重复/);
    });
    await check('程序拆场缺口不能循环购买Q1', async () => {
      const project = await create('程序工作不是模型重试'), calls: string[] = [];
      const task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => {
        calls.push(stage); const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
        if (stage === 'F2') return response(catalog);
        assert.equal(stage, 'Q1');
        return response({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {}, unresolved: [{ owner: 'PROGRAM', episodes: [1], note: `现有sceneKey不能新增独立外景场次，须拆场后补引用。第${calls.length}次说明。` }] });
      } });
      const state = await getFoundationDeliveryState(project.id, db);
      assert.deepEqual(calls, ['F2', 'Q1'], '程序任务不应触发任何追加模型修正');
      assert.equal(state.complete, false); assert.equal(state.action, 'BLOCKED');
      assert.match(state.continuationBlocker ?? '', /程序|拆场/);
      const runCount = await db.pipelineRun.count({ where: { projectId: project.id } });
      await assert.rejects(() => queueFoundationDelivery(project.id, {}, db), /程序|拆场|自动重试/);
      assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), runCount);
      assert.equal((await db.episode.findFirstOrThrow({ where: { projectId: project.id } })).content, source);
      assert.equal(state.availableEpisodes, 1); assert.equal(state.editedEpisodes, 1);
      const repaired = await applyFoundationProgramRepair(project.id, { expectedRevision: state.document.revision, scope: [1], output: {
        format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {
          sceneSplits: [{ episode: 1, sceneKey: '1-1', cuts: [{ startLine: 5, anchor: '△城外山顶，一座云台悬在半空。', location: '城外山顶', interiorExterior: '外' }] }],
          assets: [{ key: state.document.f2!.assets[0].key, sceneRefs: [{ episode: 1, sceneKey: '1-1__L5' }] }]
        }, resolvedUnresolved: state.document.editorialTodos.map(todo => todo.id)
      } }, db);
      assert.equal(repaired.complete, true, repaired.task?.error ?? '程序修复后应能交付');
      assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), runCount, '程序修正不能伪造/新增模型运行');
      await assert.rejects(() => applyFoundationProgramRepair(project.id, { expectedRevision: state.document.revision, scope: [1], output: {} }, db), /revision/);
    });
    await check('改写待办说明不算修正进展，普通继续不能重置额度', async () => {
      const project = await create('无进展停止'), calls: string[] = [];
      const task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => {
        calls.push(stage); const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
        if (stage === 'F2') return response(catalog);
        return response({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {}, unresolved: [{ key: input.candidates.f2.assets[0].key, episodes: [1], note: `仍需核对同一资产身份，说明版本${calls.length}` }] });
      } });
      const state = await getFoundationDeliveryState(project.id, db);
      assert.deepEqual(calls, ['F2', 'Q1', 'Q1'], '同一问题无实质进展应立即停，不消耗第二次自动修正');
      assert.equal(state.action, 'BLOCKED'); assert.match(state.continuationBlocker ?? '', /进展|重复|修改/);
      await assert.rejects(() => queueFoundationDelivery(project.id, {}, db), /进展|重复|修改/);
      await db.sceneSnapshot.delete({ where: { id: `foundation-delivery-${project.id}` } });
      assert.equal((await getFoundationDeliveryState(project.id, db)).action, 'BLOCKED', '已保存的无进展停止依据不能随task重建丢失');
      await assert.rejects(queueFoundationDelivery(project.id, { allowUnknownRetry: true }, db), /进展|重复|修改/);
    });
    await check('正常Q1可直接交拆场计划，由程序执行而不另问模型', async () => {
      const project = await create('正常输出包含程序计划'), calls: string[] = [];
      const task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => {
        calls.push(stage); const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
        if (stage === 'F2') return response(catalog);
        return response({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {
          sceneSplits: [{ episode: 1, sceneKey: '1-1', cuts: [{ startLine: 5, anchor: '△城外山顶，一座云台悬在半空。', location: '城外山顶', interiorExterior: '外', timeOfDay: '日' }] }],
          assets: [{ key: input.candidates.f2.assets[0].key, sceneRefs: [{ episode: 1, sceneKey: '1-1__L5' }] }]
        } });
      } });
      const state = await getFoundationDeliveryState(project.id, db);
      assert.deepEqual(calls, ['F2', 'Q1'], state.task?.error ?? '拆场不追加模型调用');
      assert.equal(state.complete, true, state.task?.error ?? '拆场计划应被应用');
      assert.equal(await db.scriptScene.count({ where: { episode: { projectId: project.id } } }), 2);
      assert.deepEqual(state.document.f2!.assets[0].sceneRefs, [{ episode: 1, sceneKey: '1-1__L5' }]);
      const { preprocessProject } = await import('@/lib/project-preprocess');
      await preprocessProject(project.id, db);
      const scenes = await db.scriptScene.findMany({ where: { episode: { projectId: project.id } }, orderBy: { sortOrder: 'asc' } });
      assert.equal(scenes.map(scene => scene.sourceText).join(''), source);
      assert.deepEqual(scenes.map(scene => scene.sceneKey), ['1-1', '1-1__L5']);
    });
    await check('二阶段提醒保留并按集供给，不变成收费待办', async () => {
      const project = await create('镜头提醒不是本阶段阻断'), calls: string[] = [];
      const task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage) => {
        calls.push(stage);
        return response(stage === 'F2' ? catalog : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {}, unresolved: [{ owner: 'STAGE2', episodes: [1], note: '保留原场内机位变化，分镜阶段细化。' }] });
      } });
      const state = await getFoundationDeliveryState(project.id, db);
      assert.deepEqual(calls, ['F2', 'Q1']); assert.equal(state.complete, true);
      const { buildLightEpisodePackets } = await import('@/lib/light-foundation-supply');
      const [packet] = await buildLightEpisodePackets(project.id, state.document, db);
      assert.equal(packet.followUps[0].note, '保留原场内机位变化，分镜阶段细化。');
      assert.equal(state.document.editorialTodos[0].owner, 'STAGE2');
      const registered = await db.asset.findFirstOrThrow({ where: { projectId: project.id } });
      assert.equal(typeof registered.metadata, 'string');
      assert.equal(JSON.parse(registered.metadata!).foundationDelivery.readiness, 'READY', '后续提醒不应阻断已具备条件的资产');
    });
    await check('程序待办不回滚必要选择，也不阻挡真正的新决定应用', async () => {
      const project = await create('确认与程序待办共存');
      const task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage) => response(stage === 'F2' ? catalog : {
        format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {}, unresolved: [{ owner: 'PROGRAM', episodes: [1], note: '需要程序拆场后补引用。' }],
        humanChoices: [{ decisionKey: 'image-style', kind: 'PRODUCTION_CHOICE', question: '图面采用哪一种已列口径？', reason: '本阶段资产制作须明确', options: ['金属图面', '石质图面'], recommended: '金属图面', recommendationReason: '更易辨认', evidence: '原文未规定材质', episodes: [1] }]
      }) });
      const state = await getFoundationDeliveryState(project.id, db), choice = state.requiredChoices[0];
      assert.ok(choice);
      const queued = await confirmAndContinueFoundationDelivery(db, { projectId: project.id, contractId: choice.id, revision: choice.revision, expectedTaskId: task.id, optionIndex: '0' });
      assert.equal(queued.status, 'QUEUED');
      const confirmed = await getFoundationDeliveryState(project.id, db);
      assert.equal(confirmed.requiredChoices.length, 0); assert.equal(confirmed.confirmedChoices.length, 1);
      assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), 2, '确认/排队本身不调用模型');
      const { preprocessProjectProduction } = await import('@/lib/workflow');
      const scenesBefore = await db.scriptScene.findMany({ where: { episode: { projectId: project.id } } });
      await assert.rejects(() => preprocessProjectProduction(project.id, db), /处理中|运行|执行|进行中|正在整理/);
      assert.deepEqual(await db.scriptScene.findMany({ where: { episode: { projectId: project.id } } }), scenesBefore, '运行中的资料不被UI原文检查按钮重建');
    });
    await check('程序修正不能用一集的计划关闭另一集待办', async () => {
      const project = await db.project.create({ data: { title: '修正范围保护', episodes: { create: [1, 2].map(number => ({ number, content: source.replace('第1集', `第${number}集`).replace('1-1', `${number}-1`) })) } } });
      const task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage) => response(stage === 'F2'
        ? { format: 'ASSET_CATALOG_V2', coverage: [1, 2], assets: [] }
        : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1, 2], changes: {}, unresolved: [{ owner: 'PROGRAM', episodes: [2], note: '第2集需要程序拆场。' }] }) });
      const state = await getFoundationDeliveryState(project.id, db);
      await assert.rejects(() => applyFoundationProgramRepair(project.id, { expectedRevision: state.document.revision, scope: [1], output: {
        format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: { sceneSplits: [{ episode: 1, sceneKey: '1-1', cuts: [{ startLine: 5, anchor: '△城外山顶，一座云台悬在半空。' }] }] },
        resolvedUnresolved: state.document.editorialTodos.map(todo => todo.id)
      } }, db), /范围|覆盖/);
      assert.equal((await getFoundationDeliveryState(project.id, db)).document.revision, state.document.revision);
    });
    await check('零模型维护不能冒充尚未完成的Q1覆盖', async () => {
      const project = await create('程序不是Q1');
      const task = await queueFoundationDelivery(project.id, {}, db);
      await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async stage => {
        if (stage === 'F2') return response(catalog);
        throw Object.assign(new Error('Q1尚未发出'), { requestOutcome: 'NOT_SENT' });
      } });
      const before = await getFoundationDeliveryState(project.id, db), count = await db.pipelineRun.count({ where: { projectId: project.id } });
      assert.equal(before.editedEpisodes, 0);
      const after = await applyFoundationProgramRepair(project.id, { expectedRevision: before.document.revision, scope: [1], output: { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: {} } }, db);
      assert.equal(after.complete, false, '程序维护不能声称Q1已执行');
      assert.equal(after.editedEpisodes, 0); assert.deepEqual(after.document.editorialCoverage, before.document.editorialCoverage);
      assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), count);
    });
    for (const failure of failures) console.error(`FAIL ${failure}`);
    assert.equal(failures.length, 0, 'unactionable repair regressions');
    console.log('PASS unactionable repair routing, persistent no-progress hold, deterministic scene-split handoff (offline)');
  } finally { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
