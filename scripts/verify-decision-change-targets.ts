/** Generic decision permissions: real controller, isolated SQLite, offline responses only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '@/lib/role-runner';
import { assertDecisionChanges, restoreUnauthorizedDecisionAliases } from '@/lib/foundation-decision-targets';

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'decision-change-targets-'));
  const url = `file:${directory}/test.db`; process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  const api = await import('@/lib/foundation-delivery');
  const response = (data: unknown): RoleRunResult => ({ data: data as Record<string, unknown>, rawOutput: JSON.stringify(data), stdout: '', stderr: '', sessionId: null });
  const input = (prompt: string) => JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
  const optimization = (changes: object, extra: object = {}) => ({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [7], changes, ...extra });
  const setup = async (name: string, sceneOnly: boolean) => {
    const assetFields = name.includes('rename') ? ['name', 'preparation'] : ['preparation'];
    const project = await db.project.create({ data: { title: name, episodes: { create: { number: 7, content: '第7集\n7-1 日 外 驿站门口\n人物：南桥守卫、驿站使者\n△南桥守卫接过驿站使者的信。\n7-2 夜 内 仓房\n人物：南桥守卫\n△南桥守卫收起信。\n' } } } });
    const task = await api.queueFoundationDelivery(project.id, {}, db);
    await api.executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => {
      const value = input(prompt);
      if (stage === 'F2') return response({ format: 'ASSET_CATALOG_V2', coverage: [7], assets: ['南桥守卫', '驿站使者'].map(name => ({ name, type: 'CH', role: '配角', aliases: [], episodes: [7], sceneRefs: [{ episode: 7, sceneKey: '7-1' }], preparation: { mode: 'REFERENCE', note: '原方案' } })) });
      const target = value.candidates.f2.assets.find((asset: { name: string }) => asset.name === '南桥守卫');
      return response(optimization({}, { humanChoices: [{ decisionKey: sceneOnly ? 'station-weather' : 'guard-preparation', kind: 'PRODUCTION_CHOICE', question: sceneOnly ? '本场天气采用哪种方案？' : '守卫本场采用哪种制作方案？', options: ['方案甲', '方案乙'], recommended: '方案乙', recommendationReason: '本场需要明确', reason: '待用户确定', evidence: '南桥守卫接过驿站使者的信。', episodes: [7], applicationScope: { kind: 'SCENES', scenes: [{ episode: 7, sceneKey: '7-1' }] }, changeTargets: sceneOnly ? { assetKeys: [], assetFields: [], sceneFields: ['weather'] } : { assetKeys: [target.key], assetFields, sceneFields: [] } }] }));
    } });
    const state = await api.getFoundationDeliveryState(project.id, db);
    assert.equal(state.task?.status, 'WAITING_USER', state.task?.error ?? name);
    assert.equal(state.requiredChoices.length, 1);
    const choice = state.requiredChoices[0];
    const before = structuredClone(state.document);
    const assets = before.f2!.assets;
    const target = assets.find(asset => asset.name === '南桥守卫')!;
    const other = assets.find(asset => asset.name === '驿站使者')!;
    const expectedTargets = sceneOnly ? { assetKeys: [], assetFields: [], sceneFields: ['weather'] } : { assetKeys: [target.key], assetFields, sceneFields: [] };
    assert.deepEqual(choice.changeTargets, expectedTargets, 'permissions survive choice persistence');
    const resumed = await api.confirmAndContinueFoundationDelivery(db, { projectId: project.id, contractId: choice.id, revision: choice.revision, optionIndex: '1' });
    assert.ok(resumed, 'the only required choice queues continuation');
    return { project, task: resumed, choice, before, target, other, expectedTargets, scenes: await db.scriptScene.findMany({ where: { episode: { projectId: project.id } }, orderBy: { sortOrder: 'asc' } }) };
  };
  const cases = [
    { name: 'allowed asset preparation', sceneOnly: false, allowed: true, change: (key: string, _other: string) => ({ assets: [{ key, preparation: { mode: 'REFERENCE', note: '已确认方案乙' } }] }) },
    { name: 'authorized rename preserves omitted aliases', sceneOnly: false, allowed: true, change: (key: string) => ({ assets: [{ key, name: '南桥值守人员', preparation: { mode: 'REFERENCE', note: '已确认方案乙' } }] }) },
    { name: 'authorized rename preserves original aliases after projection', sceneOnly: false, allowed: true, change: (key: string) => ({ assets: [{ key, name: '南桥值守人员', aliases: ['未经确认别名'], preparation: { mode: 'REFERENCE', note: '已确认方案乙' } }] }) },
    { name: 'other asset in same scene', sceneOnly: false, allowed: false, change: (_key: string, other: string) => ({ assets: [{ key: other, preparation: { mode: 'REFERENCE', note: '越权方案' } }] }) },
    { name: 'same asset role', sceneOnly: false, allowed: false, change: (key: string) => ({ assets: [{ key, role: '主角' }] }) },
    { name: 'same asset aliases', sceneOnly: false, allowed: false, change: (key: string) => ({ assets: [{ key, aliases: ['未经确认别名'] }] }) },
    { name: 'restore aliases preserving authorized preparation', sceneOnly: false, allowed: true, change: (key: string) => ({ assets: [{ key, aliases: ['未经确认别名'], preparation: { mode: 'REFERENCE', note: '已确认方案乙' } }] }) },
    { name: 'alias dependency cannot be discarded', sceneOnly: false, allowed: false, change: (key: string) => ({ assets: [{ key, aliases: ['未经确认别名'], preparation: { mode: 'REFERENCE', note: '采用未经确认别名形象' } }] }) },
    { name: 'authorized preparation preserves original role and aliases', sceneOnly: false, allowed: true, change: (key: string) => ({ assets: [{ key, aliases: ['未经确认别名'], role: '主角', preparation: { mode: 'REFERENCE', note: '已确认方案乙' } }] }) },
    { name: 'authorized preparation preserves other asset', sceneOnly: false, allowed: true, change: (key: string, other: string) => ({ assets: [{ key, preparation: { mode: 'REFERENCE', note: '已确认方案乙' } }, { key: other, role: '主角', preparation: { mode: 'AUDIO', note: '越权方案' } }] }) },
    { name: 'allowed scene weather', sceneOnly: true, allowed: true, change: () => ({ scenes: [{ episode: 7, sceneKey: '7-1', weather: '雨后' }] }) },
    { name: 'authorized weather preserves wrong field and other scene', sceneOnly: true, allowed: true, change: () => ({ scenes: [{ episode: 7, sceneKey: '7-1', weather: '雨后', location: '未经确认地点' }, { episode: 7, sceneKey: '7-2', weather: '雨后' }] }) },
    { name: 'scene-only cannot modify asset', sceneOnly: true, allowed: false, change: (key: string) => ({ assets: [{ key, preparation: { mode: 'REFERENCE', note: '越权方案' } }] }) },
    { name: 'scene-only wrong field', sceneOnly: true, allowed: false, change: () => ({ scenes: [{ episode: 7, sceneKey: '7-1', location: '未经确认地点' }] }) },
    { name: 'scene-only wrong scene', sceneOnly: true, allowed: false, change: () => ({ scenes: [{ episode: 7, sceneKey: '7-2', weather: '雨后' }] }) },
  ];
  try {
    for (const test of cases) {
      const fixture = await setup(test.name, test.sceneOnly);
      const changes = test.change(fixture.target.key, fixture.other.key);
      if (test.name === 'allowed asset preparation') {
        const after = structuredClone(fixture.before);
        after.f2!.assets.find(asset => asset.key === fixture.target.key)!.preparation = { mode: 'REFERENCE', note: '已确认方案乙' };
        const validate = (next: typeof after) => assertDecisionChanges([fixture.choice], [7], optimization({ assets: [{ key: fixture.target.key, episodes: [7], preparation: { mode: 'REFERENCE', note: '已确认方案乙' } }] }) as Parameters<typeof assertDecisionChanges>[2], fixture.before, next);
        assert.doesNotThrow(() => validate(after));
        const aliasAfter=structuredClone(after);
        aliasAfter.f2!.assets.find(asset=>asset.key===fixture.target.key)!.aliases=['明确授权别名'];
        const aliasOutput=optimization({assets:[{key:fixture.target.key,aliases:['明确授权别名'],preparation:{mode:'REFERENCE',note:'已确认方案乙'}}]}) as Parameters<typeof assertDecisionChanges>[2];
        const aliasConsent={...fixture.choice,changeTargets:{assetKeys:[fixture.target.key],assetFields:['preparation' as const,'aliases' as const],sceneFields:[]}};
        const authorizedAliases=restoreUnauthorizedDecisionAliases([aliasConsent],[7],aliasOutput,fixture.before,aliasAfter);
        assert.equal(authorizedAliases.output,aliasOutput); assert.deepEqual(authorizedAliases.correctedFields,[],'explicitly authorized aliases are never reverted');
        const unchangedInput=structuredClone(aliasOutput);
        restoreUnauthorizedDecisionAliases([fixture.choice],[7],aliasOutput,fixture.before,aliasAfter);
        assert.deepEqual(aliasOutput,unchangedInput,'the original provider object is immutable');
        const hiddenOtherChange = structuredClone(after);
        hiddenOtherChange.f2!.assets.find(asset => asset.key === fixture.other.key)!.role = '主角';
        assert.throws(() => validate(hiddenOtherChange), 'document diff must reject hidden changes even when output names only the authorized asset');
        const weatherChoice = { ...fixture.choice, changeTargets: { assetKeys: [], assetFields: [], sceneFields: ['weather' as const] } };
        const otherSceneLocationChoice = { ...fixture.choice, applicationScope: { kind: 'SCENES' as const, scenes: [{ episode: 7, sceneKey: '7-2' }] }, changeTargets: { assetKeys: [], assetFields: [], sceneFields: ['location' as const] } };
        assert.throws(() => assertDecisionChanges([weatherChoice, otherSceneLocationChoice], [7], optimization({ scenes: [{ episode: 7, sceneKey: '7-1', location: '越权地点' }] }) as Parameters<typeof assertDecisionChanges>[2], fixture.before, fixture.before), 'one issue scene scope cannot combine with another issue field permission');
        const otherAssetRoleChoice = { ...fixture.choice, changeTargets: { assetKeys: [fixture.other.key], assetFields: ['role' as const], sceneFields: [] } };
        const wrongRole = structuredClone(fixture.before);
        wrongRole.f2!.assets.find(asset => asset.key === fixture.target.key)!.role = '主角';
        assert.throws(() => assertDecisionChanges([fixture.choice, otherAssetRoleChoice], [7], optimization({ assets: [{ key: fixture.target.key, episodes: [7], role: '主角' }] }) as Parameters<typeof assertDecisionChanges>[2], fixture.before, wrongRole), 'one issue asset key cannot combine with another issue field permission');
        const sharedBefore = structuredClone(fixture.before);
        sharedBefore.f2!.assets.find(asset => asset.key === fixture.target.key)!.sceneRefs!.push({ episode: 7, sceneKey: '7-2' });
        const sharedAfter = structuredClone(sharedBefore);
        sharedAfter.f2!.assets.find(asset => asset.key === fixture.target.key)!.preparation = { mode: 'REFERENCE', note: '仅确认7-1但修改共享全局方案' };
        assert.throws(() => assertDecisionChanges([fixture.choice], [7], optimization({ assets: [{ key: fixture.target.key, episodes: [7], preparation: sharedAfter.f2!.assets.find(asset => asset.key === fixture.target.key)!.preparation }] }) as Parameters<typeof assertDecisionChanges>[2], sharedBefore, sharedAfter), 'a local scene decision cannot rewrite an asset shared by another scene');
        const unknownRefsBefore = structuredClone(fixture.before);
        delete unknownRefsBefore.f2!.assets.find(asset => asset.key === fixture.target.key)!.sceneRefs;
        const inventedRefsAfter = structuredClone(unknownRefsBefore);
        Object.assign(inventedRefsAfter.f2!.assets.find(asset => asset.key === fixture.target.key)!, { sceneRefs: [{ episode: 7, sceneKey: '7-1' }], preparation: { mode: 'REFERENCE', note: '不能用新场引用证明旧范围' } });
        const refsAndPreparationChoice = { ...fixture.choice, changeTargets: { assetKeys: [fixture.target.key], assetFields: ['sceneRefs' as const, 'preparation' as const], sceneFields: [] } };
        assert.throws(() => assertDecisionChanges([refsAndPreparationChoice], [7], optimization({ assets: [{ key: fixture.target.key, episodes: [7], preparation: { mode: 'REFERENCE', note: '不能用新场引用证明旧范围' }, sceneRefs: [{ episode: 7, sceneKey: '7-1' }] }] }) as Parameters<typeof assertDecisionChanges>[2], unknownRefsBefore, inventedRefsAfter), 'new scene refs cannot retroactively prove the old asset scope');
        const unknownVariantBefore = structuredClone(fixture.before);
        unknownVariantBefore.f2!.assets.find(asset => asset.key === fixture.target.key)!.variants = [{ key: 'guard-state', name: '守卫制服', episodes: [7], note: '原制服' }];
        const inventedVariantAfter = structuredClone(unknownVariantBefore);
        Object.assign(inventedVariantAfter.f2!.assets.find(asset => asset.key === fixture.target.key)!.variants[0], { sceneRefs: [{ episode: 7, sceneKey: '7-1' }], note: '仅本场新制服' });
        const variantChoice = { ...fixture.choice, changeTargets: { assetKeys: [fixture.target.key], assetFields: ['variants' as const], sceneFields: [] } };
        assert.throws(() => assertDecisionChanges([variantChoice], [7], optimization({ assets: [{ key: fixture.target.key, episodes: [7], variants: inventedVariantAfter.f2!.assets.find(asset => asset.key === fixture.target.key)!.variants }] }) as Parameters<typeof assertDecisionChanges>[2], unknownVariantBefore, inventedVariantAfter), 'new scene refs cannot retroactively prove the old variant scope');
      }
      let calls = 0;
      const recoveryCase = test.name === 'restore aliases preserving authorized preparation';
      let interruptResponseSave = recoveryCase;
      const failResponseSave = (args: { data: { log?: unknown } }) => {
        const log = args.data.log && JSON.parse(String(args.data.log));
        if(interruptResponseSave && log?.calls?.some((call: { status: string; requestOutcome: string }) => call.status === 'RUNNING' && call.requestOutcome === 'RESPONDED')) {
          interruptResponseSave = false;
          throw new Error('offline interrupted response bookkeeping');
        }
      };
      const runDb = recoveryCase ? db.$extends({ query: { pipelineRun: {
        update({args,query}) { failResponseSave(args); return query(args); },
        updateMany({args,query}) { failResponseSave(args); return query(args); },
      } } }) as unknown as PrismaClient : db;
      await api.executeFoundationDelivery(fixture.project.id, fixture.task.id, { db: runDb, stageRunner: async (_stage, prompt) => {
        calls++;
        const value = input(prompt);
        assert.equal(value.delivery.mode, 'APPLY_DECISION');
        assert.deepEqual(value.delivery.targets.sceneKeys, ['7-1']);
        assert.deepEqual(value.confirmedDecisions[0].changeTargets, fixture.expectedTargets, 'request carries exactly the stored field permissions');
        return response(optimization(changes, { appliedDecisions: value.confirmedDecisions.map((choice: { id: string }) => ({ id: choice.id, note: '采用已确认方案乙。' })) }));
      } });
      if(recoveryCase) {
        assert.equal(calls,1);
        const savedRuns=await db.pipelineRun.findMany({where:{projectId:fixture.project.id}});
        const paid=savedRuns.find(run=>JSON.parse(run.inputSummary??'{}').phase==='APPLY_DECISION')!;
        const originalLog=JSON.parse(paid.log!);
        assert.ok(originalLog.calls.some((call:{response?:unknown})=>JSON.stringify(call.response).includes('未经确认别名')), 'unaltered paid response retains proposed aliases');
        const queued=await api.queueFoundationDelivery(fixture.project.id,{},db);
        await api.executeFoundationDelivery(fixture.project.id,queued.id,{db,stageRunner:async()=>{calls++;throw new Error('paid response must replay without a new provider call');}});
        assert.equal(calls,1);
        assert.equal(await db.pipelineRun.count({where:{projectId:fixture.project.id}}),savedRuns.length);
        assert.deepEqual(JSON.parse((await db.pipelineRun.findUniqueOrThrow({where:{id:paid.id}})).log!),originalLog,'replay does not rewrite raw evidence or fingerprints');
      }
      assert.ok(calls >= 1 && calls <= 2, `${test.name}: bounded offline calls`);
      const result = await api.getFoundationDeliveryState(fixture.project.id, db);
      const scenes = await db.scriptScene.findMany({ where: { episode: { projectId: fixture.project.id } }, orderBy: { sortOrder: 'asc' } });
      if (test.allowed) {
        assert.equal(result.complete, true, `${test.name}: ${result.task?.error}`);
        if (test.sceneOnly) {
          assert.deepEqual(result.document.f2!.assets, fixture.before.f2!.assets);
          assert.equal(scenes[0].weather, '雨后');
          assert.equal(scenes[0].location, fixture.scenes[0].location);
          assert.deepEqual(scenes[1], fixture.scenes[1]);
        } else {
          assert.equal(result.document.f2!.assets.find(asset => asset.key === fixture.target.key)!.preparation?.note, '已确认方案乙');
          assert.equal(result.document.f2!.assets.find(asset => asset.key === fixture.target.key)!.role,fixture.target.role);
          assert.deepEqual(result.document.f2!.assets.find(asset => asset.key === fixture.target.key)!.aliases,fixture.target.aliases);
          assert.deepEqual(result.document.f2!.assets.find(asset => asset.key === fixture.other.key), fixture.other);
          assert.deepEqual(scenes, fixture.scenes);
          if(test.name.includes('authorized rename')) {
            const renamed=result.document.f2!.assets.find(asset=>asset.key===fixture.target.key)!;
            assert.equal(renamed.name,'南桥值守人员');
            assert.deepEqual(renamed.aliases,fixture.target.aliases,'omitted aliases do not acquire the previous name');
          }
          if(recoveryCase) {
            assert.deepEqual(result.document.f2!.assets.find(asset=>asset.key===fixture.target.key)!.aliases,fixture.target.aliases);
            assert.ok(result.document.notes.some(note=>note.includes('程序纠正')&&note.includes(`assets.${fixture.target.key}.aliases`)&&note.includes('runId=')),'correction provenance persists');
          }
        }
      } else {
        assert.equal(result.complete, false, `${test.name}: unauthorized edit must not complete`);
        assert.deepEqual(result.document.f2!.assets, fixture.before.f2!.assets, `${test.name}: no unauthorized catalog persistence`);
        assert.deepEqual(scenes, fixture.scenes, `${test.name}: no unauthorized scene persistence`);
      }
      console.log(`PASS ${test.name}`);
    }
  } finally {
    await db.$disconnect();
    rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
  console.log('PASS generic decision changeTargets: key/field/scene permissions, document diff, persistence and real controller; offline SQLite, no AI');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
