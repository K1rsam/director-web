/** Generic decision permissions: real controller, isolated SQLite, offline responses only. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '@/lib/role-runner';
import { assertDecisionChanges } from '@/lib/foundation-decision-targets';

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
    const project = await db.project.create({ data: { title: name, episodes: { create: { number: 7, content: '第7集\n7-1 日 外 驿站门口\n人物：南桥守卫、驿站使者\n△南桥守卫接过驿站使者的信。\n7-2 夜 内 仓房\n人物：南桥守卫\n△南桥守卫收起信。\n' } } } });
    const task = await api.queueFoundationDelivery(project.id, {}, db);
    await api.executeFoundationDelivery(project.id, task.id, { db, stageRunner: async (stage, prompt) => {
      const value = input(prompt);
      if (stage === 'F2') return response({ format: 'ASSET_CATALOG_V2', coverage: [7], assets: ['南桥守卫', '驿站使者'].map(name => ({ name, type: 'CH', role: '配角', aliases: [], episodes: [7], sceneRefs: [{ episode: 7, sceneKey: '7-1' }], preparation: { mode: 'REFERENCE', note: '原方案' } })) });
      const target = value.candidates.f2.assets.find((asset: { name: string }) => asset.name === '南桥守卫');
      return response(optimization({}, { humanChoices: [{ decisionKey: sceneOnly ? 'station-weather' : 'guard-preparation', kind: 'PRODUCTION_CHOICE', question: sceneOnly ? '本场天气采用哪种方案？' : '守卫本场采用哪种制作方案？', options: ['方案甲', '方案乙'], recommended: '方案乙', recommendationReason: '本场需要明确', reason: '待用户确定', evidence: '南桥守卫接过驿站使者的信。', episodes: [7], applicationScope: { kind: 'SCENES', scenes: [{ episode: 7, sceneKey: '7-1' }] }, changeTargets: sceneOnly ? { assetKeys: [], assetFields: [], sceneFields: ['weather'] } : { assetKeys: [target.key], assetFields: ['preparation'], sceneFields: [] } }] }));
    } });
    const state = await api.getFoundationDeliveryState(project.id, db);
    assert.equal(state.task?.status, 'WAITING_USER', state.task?.error ?? name);
    assert.equal(state.requiredChoices.length, 1);
    const choice = state.requiredChoices[0];
    const before = structuredClone(state.document);
    const assets = before.f2!.assets;
    const target = assets.find(asset => asset.name === '南桥守卫')!;
    const other = assets.find(asset => asset.name === '驿站使者')!;
    const expectedTargets = sceneOnly ? { assetKeys: [], assetFields: [], sceneFields: ['weather'] } : { assetKeys: [target.key], assetFields: ['preparation'], sceneFields: [] };
    assert.deepEqual(choice.changeTargets, expectedTargets, 'permissions survive choice persistence');
    const resumed = await api.confirmAndContinueFoundationDelivery(db, { projectId: project.id, contractId: choice.id, revision: choice.revision, optionIndex: '1' });
    assert.ok(resumed, 'the only required choice queues continuation');
    return { project, task: resumed, choice, before, target, other, expectedTargets, scenes: await db.scriptScene.findMany({ where: { episode: { projectId: project.id } }, orderBy: { sortOrder: 'asc' } }) };
  };
  const cases = [
    { name: 'allowed asset preparation', sceneOnly: false, allowed: true, change: (key: string, _other: string) => ({ assets: [{ key, preparation: { mode: 'REFERENCE', note: '已确认方案乙' } }] }) },
    { name: 'other asset in same scene', sceneOnly: false, allowed: false, change: (_key: string, other: string) => ({ assets: [{ key: other, preparation: { mode: 'REFERENCE', note: '越权方案' } }] }) },
    { name: 'same asset role', sceneOnly: false, allowed: false, change: (key: string) => ({ assets: [{ key, role: '主角' }] }) },
    { name: 'same asset aliases', sceneOnly: false, allowed: false, change: (key: string) => ({ assets: [{ key, aliases: ['未经确认别名'] }] }) },
    { name: 'allowed scene weather', sceneOnly: true, allowed: true, change: () => ({ scenes: [{ episode: 7, sceneKey: '7-1', weather: '雨后' }] }) },
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
      await api.executeFoundationDelivery(fixture.project.id, fixture.task.id, { db, stageRunner: async (_stage, prompt) => {
        calls++;
        const value = input(prompt);
        assert.equal(value.delivery.mode, 'APPLY_DECISION');
        assert.deepEqual(value.delivery.targets.sceneKeys, ['7-1']);
        assert.deepEqual(value.confirmedDecisions[0].changeTargets, fixture.expectedTargets, 'request carries exactly the stored field permissions');
        return response(optimization(changes, { appliedDecisions: value.confirmedDecisions.map((choice: { id: string }) => ({ id: choice.id, note: '采用已确认方案乙。' })) }));
      } });
      assert.ok(calls >= 1 && calls <= 2, `${test.name}: bounded offline calls`);
      const result = await api.getFoundationDeliveryState(fixture.project.id, db);
      const scenes = await db.scriptScene.findMany({ where: { episode: { projectId: fixture.project.id } }, orderBy: { sortOrder: 'asc' } });
      if (test.allowed) {
        assert.equal(result.complete, true, `${test.name}: ${result.task?.error}`);
        if (test.sceneOnly) {
          assert.deepEqual(result.document.f2!.assets, fixture.before.f2!.assets);
          assert.equal(scenes[0].weather, '雨后');
          assert.deepEqual(scenes[1], fixture.scenes[1]);
        } else {
          assert.equal(result.document.f2!.assets.find(asset => asset.key === fixture.target.key)!.preparation?.note, '已确认方案乙');
          assert.deepEqual(result.document.f2!.assets.find(asset => asset.key === fixture.other.key), fixture.other);
          assert.deepEqual(scenes, fixture.scenes);
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
