import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '@/lib/role-runner';

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'light-stage1-'));
  const url = `file:${directory}/test.db`; process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  const { queueFoundationDelivery, executeFoundationDelivery, getFoundationDeliveryState } = await import('@/lib/foundation-delivery');
  const response = (data: unknown): RoleRunResult => ({ data: data as Record<string, unknown>, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null });
  try {
    const project = await db.project.create({ data: { title: '轻量正常稿', episodes: { create: [
      { number: 0, title: '第零集', content: '第零集\r\n0-1 院子 夜 外\r\n人物：甲\r\n△雨滴落在钥匙上。\r\n甲：给你。\r\n' },
      { number: 1, title: '第一集', content: '第一集\n1-1 客厅 日 内\n人物：甲\n甲：回来了。\n' }
    ] } } });
    const source = await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } });
    const calls: string[] = [];
    const task = await queueFoundationDelivery(project.id, {}, db);
    await executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => {
      calls.push(stage); const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
      if (stage === 'F1') throw Object.assign(new Error('清晰剧本不应调用F1摘要'), { requestOutcome: 'NOT_SENT' });
      assert.ok(!('navigation' in input), 'do not pass an unused one-line synopsis');
      assert.ok(input.scenes.every((scene: { sourceText?: string; sourceLines?: unknown }) => !scene.sourceText && scene.sourceLines), 'source appears once, scenes carry exact references');
      if (stage === 'F2') return response({ format: 'ASSET_CATALOG_V2', coverage: input.scope, assets: [{ name: '甲｜默认', type: 'CH', role: '主角', episodes: input.scope,
        sceneRefs: input.scenes.map((scene: { episode: number; sceneKey: string }) => ({ episode: scene.episode, sceneKey: scene.sceneKey })), preparation: { mode: 'REFERENCE' } }] });
      assert.ok(!input.candidates.f1, 'Q1 receives useful source/scenes/catalog, not fake F1');
      return response({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: { scenes: [{ episode: 0, sceneKey: '0-1', weather: '雨' }] } });
    } });
    const state = await getFoundationDeliveryState(project.id, db);
    assert.deepEqual(calls, ['F2', 'Q1'], state.task?.error ?? 'clear source must skip F1');
    assert.equal(state.task?.status, 'COMPLETE', state.task?.error ?? 'light delivery');
    assert.equal(state.document.f1, null, 'no fabricated program or AI summary');
    assert.equal(state.document.workflow, 'LIGHT_STAGE1_V1');
    assert.equal(state.needsAssetRefresh, false); assert.equal(state.complete, true);
    assert.deepEqual((await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } })).map(e => e.content), source.map(e => e.content));
    const scene = await db.scriptScene.findFirstOrThrow({ where: { episode: { projectId: project.id, number: 0 }, sceneKey: '0-1' } });
    assert.equal(scene.weather, '雨', 'Q1 directly applies useful scene metadata');
    const { buildLightEpisodePackets } = await import('@/lib/light-foundation-supply');
    const packets = await buildLightEpisodePackets(project.id, state.document, db);
    assert.equal(packets.length, 2); assert.equal(packets[0].sourceText, source[0].content);
    assert.equal(packets[0].scenes[0].weather, '雨');
    assert.equal(packets[0].scenes[0].assetKeys[0], state.document.f2!.assets[0].key);
    assert.ok(packets[0].assets.every(asset => asset.sceneRefs?.every(ref => ref.episode === 0)));
    assert.ok(!('summary' in packets[0]), 'consumer receives source and actual preparation, not filler');
    const { saveFoundationDocument } = await import('@/lib/foundation-document');
    await saveFoundationDocument(db, project.id, state.document.revision, { ...state.document, assetMethodVersion: 'old-method' }, 'old method fixture');
    const oldMethod = await getFoundationDeliveryState(project.id, db), beforeMethodCalls = await db.pipelineRun.count({ where: { projectId: project.id } });
    assert.equal(oldMethod.complete, true); assert.equal(oldMethod.action, 'NONE'); assert.equal(oldMethod.methodUpdateAvailable, true);
    await assert.rejects(queueFoundationDelivery(project.id, {}, db), /已完成|已整理|无需/);
    const { applyFoundationProgramRepair } = await import('@/lib/foundation-delivery');
    const { LIGHT_ASSET_METHOD_VERSION } = await import('@/lib/foundation-production-prompts');
    const adopted = await applyFoundationProgramRepair(project.id, { expectedRevision: oldMethod.document.revision, scope: [0, 1], reviewedAssetMethodVersion: LIGHT_ASSET_METHOD_VERSION,
      output: { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [0, 1], changes: {} } }, db);
    assert.equal(adopted.document.assetMethodVersion, LIGHT_ASSET_METHOD_VERSION); assert.equal(adopted.methodUpdateAvailable, false);
    assert.deepEqual(adopted.document.editorialCoverage, oldMethod.document.editorialCoverage);
    assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), beforeMethodCalls, '仅规则版本更新不购买作者稿或编辑稿');
    const { importProjectFromText } = await import('@/lib/workflow');
    const owner = await db.user.create({ data: { username: 'light-source', email: 'light-source@example.invalid', passwordHash: 'offline' } });
    const ambiguous = await importProjectFromText({ ownerUserId: owner.id, title: '待定边界', sourceName: 'source.txt', sourceText: '第1集\n甲片。\n第2集\n乙片。\n第1集\n丙片。\n' }, db);
    let failResolution = true, f1Calls = 0;
    const failingDb = db.$extends({ query: { sceneSnapshot: { create({ args, query }) {
      if (args.data.sceneKey === 'SOURCE_STRUCTURE_RESOLUTION' && failResolution) { failResolution = false; throw new Error('模拟本地计划保存失败'); }
      return query(args);
    } } } }) as unknown as PrismaClient;
    const sourceRunner = async (stage: 'F1' | 'F2' | 'Q1', prompt: string) => {
      const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
      if (stage === 'F1') { f1Calls++; return response({ assignments: input.sections.map((section: { key: string }, index: number) => ({ sectionKey: section.key, kind: 'EPISODE', episodeNumber: index === 0 ? 1 : 3 })) }); }
      return response(stage === 'F2' ? { format: 'ASSET_CATALOG_V2', coverage: input.scope, assets: [] } : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: input.scope, changes: {} });
    };
    const failedTask = await queueFoundationDelivery(ambiguous.project.id, {}, failingDb);
    await executeFoundationDelivery(ambiguous.project.id, failedTask.id, { db: failingDb, stageRunner: sourceRunner });
    assert.equal(f1Calls, 1); assert.equal((await getFoundationDeliveryState(ambiguous.project.id, db)).task?.status, 'PARTIAL');
    const retryTask = await queueFoundationDelivery(ambiguous.project.id, {}, db);
    await executeFoundationDelivery(ambiguous.project.id, retryTask.id, { db, stageRunner: sourceRunner });
    assert.equal(f1Calls, 1, 'a saved valid F1 response must not be purchased twice after local persistence failure');
    assert.equal((await getFoundationDeliveryState(ambiguous.project.id, db)).complete, true);
    const assetOnly = await db.project.create({ data: { title: '正常无场次补丁', episodes: { create: [{ number: 1, title: '第一集', content: '第1集\n1-1 客厅 日 内\n人物：甲\n甲：回来了。\n' }] } } });
    const assetTask = await queueFoundationDelivery(assetOnly.id, {}, db);
    await executeFoundationDelivery(assetOnly.id, assetTask.id, { db, stageRunner: async (stage, prompt) => {
      const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
      return response(stage === 'F2' ? { format: 'ASSET_CATALOG_V2', coverage: [1], assets: [{ name: '甲', type: 'CH', episodes: [1], sceneRefs: [{ episode: 1, sceneKey: '1-1' }], preparation: { mode: 'REFERENCE' } }] }
        : { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [1], changes: { assets: [{ key: input.candidates.f2.assets[0].key, role: '主角' }] } });
    } });
    const assetState = await getFoundationDeliveryState(assetOnly.id, db);
    assert.equal(assetState.task?.status, 'COMPLETE', assetState.task?.error ?? 'asset-only path');
    assert.equal(await db.asset.count({ where: { projectId: assetOnly.id } }), 1);
    {
    const project=await db.project.create({data:{title:'未关联背景不阻断首次整理',episodes:{create:[{number:1,content:'第1集\n1-1 客厅 日 内\n甲：你好。\n'}]}}});
    const source=await db.episode.findMany({where:{projectId:project.id}});
    const background = '作者资料\n一段尚未匹配姓名的作者资料。\n';
    const sourceText = background + source.map(e => e.content).join('');
    let cursor = background.length;
    await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'SOURCE_IMPORT', title: 'unlinked-background-regression', metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }), content: JSON.stringify({ sourceText, readIssues: [], sourceStructure: { version: 'SOURCE_STRUCTURE_V1', issues: [], sections: [{ key: 'BG', kind: 'BACKGROUND', start: 0, end: cursor }, ...source.map(e => { const start = cursor; cursor += e.content.length; return { key: 'E' + e.number, kind: 'EPISODE', episodeNumber: e.number, start, end: cursor }; })] } }) } });
    assert.equal((await getFoundationDeliveryState(project.id, db)).continuationBlocker, null, 'unmatched background cannot block the first catalog');

    const task=await queueFoundationDelivery(project.id,{},db), calls:string[]=[];
    await executeFoundationDelivery(project.id,task.id,{db,stageRunner:async(stage,prompt)=>{
      calls.push(stage);const input=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
      assert(input.facts.groups.backgroundCandidates.some((i:number)=>input.facts.rows[i][5].includes('尚未匹配')));
      return response(stage==='F2'?{format:'ASSET_CATALOG_V2',coverage:[1],assets:[{name:'甲',type:'CH',episodes:[1],sceneRefs:[{episode:1,sceneKey:'1-1'}],preparation:{mode:'REFERENCE'}}]}:{format:'FOUNDATION_OPTIMIZATION_V2',coverage:[1],changes:{}});
    }});
    const state=await getFoundationDeliveryState(project.id,db);
    assert.deepEqual(calls,['F2','Q1']);assert.equal(state.complete,false);assert.equal(state.task?.status,'PARTIAL');assert(state.continuationBlocker?.includes('作者资料'));
    }
    console.log('PASS lightweight real controller: ordinary source zero F1, F2/Q1 direct edits, source preserved, per-scene consumer supply');
  } finally { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
