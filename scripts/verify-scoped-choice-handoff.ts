/** Shared consumer-input checks. Temporary DB only, no model or generation call. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'light-handoff-'));
  const url = `file:${directory}/test.db`; process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, ['node_modules/prisma/build/index.js', 'db', 'push', '--schema', `${directory}/schema.prisma`, '--skip-generate'], { env: { ...process.env, RUST_LOG: 'info' }, stdio: 'pipe' });
  const db = new PrismaClient({ datasourceUrl: url });
  try {
    const { preprocessProject } = await import('@/lib/project-preprocess');
    const { loadFoundationInputs } = await import('@/lib/foundation-state');
    const { createEmptyDocument, mergeDocumentF2, saveFoundationDocument } = await import('@/lib/foundation-document');
    const { requireProductionCatalogAuthor } = await import('@/lib/foundation-production-contracts');
    const { LIGHT_ASSET_METHOD_VERSION } = await import('@/lib/foundation-production-prompts');
    const supply = await import('@/lib/light-foundation-supply');
    const { buildSourceIndex } = await import('@/lib/project-foundation-contracts');
    const episodes = [
      { number: 7, title: '第七集', content: '第七集\r\n7-1 日 内 旧牢房\r\n人物：甲\r\n△甲穿灰衣，捂着胸口，血透出来。\r\n甲：整座城。\r\n' },
      { number: 8, title: '第八集', content: '第八集\n8-1 日 内 收容所\n人物：甲\n甲：整座城？\n△甲仍捂胸，慢慢坐下。\n8-2 日 内 走廊\n人物：甲\n△甲带伤走出。\n' },
      { number: 9, title: '第九集', content: '第九集\n9-1 夜 内 宴会厅\n人物：甲\n△甲换成礼服。\n' }
    ];
    const project = await db.project.create({ data: { title: '只读交接', episodes: { create: episodes } } });
    const sourceText = episodes.map(episode => episode.content).join('');
    let offset = 0;
    await db.sceneSnapshot.create({ data: { projectId: project.id, sceneKey: 'SOURCE_IMPORT', metadata: JSON.stringify({ schema: 'IMPORTED_SOURCE_TEXT_V2' }), content: JSON.stringify({ sourceText,
      sourceStructure: { version: 'SOURCE_STRUCTURE_V1', issues: [], sections: episodes.map(episode => { const start = offset; offset += episode.content.length; return { key: `ep-${episode.number}`, kind: 'EPISODE', episodeNumber: episode.number, start, end: offset }; }) } }) } });
    await preprocessProject(project.id, db);
    const input = await loadFoundationInputs(project.id, db), empty = createEmptyDocument(input);
    const catalog = requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [7, 8, 9], assets: [{ name: '甲｜灰衣', type: 'CH', episodes: [7, 8, 9],
      sceneRefs: episodes.map(e => ({ episode: e.number, sceneKey: `${e.number}-1` })), preparation: { mode: 'REFERENCE' }, variants: [
        { name: '胸口带伤', episodes: [7, 8], sceneRefs: [7, 8].map(episode => ({ episode, sceneKey: `${episode}-1` })), preparation: { mode: 'INLINE' }, note: '未见解除；下一段须结合原文判断。' },
        { name: '礼服', episodes: [9], sceneRefs: [{ episode: 9, sceneKey: '9-1' }], preparation: { mode: 'DERIVE' } }
      ] }] }, input.sourceIndex, [7, 8, 9]);
    const draft = mergeDocumentF2({ ...empty, workflow: 'LIGHT_STAGE1_V1', assetMethodVersion: LIGHT_ASSET_METHOD_VERSION }, catalog, input.sourceIndex);
    draft.editorialCoverage = [7, 8, 9]; draft.editorialTodos = [{ id: 'later-8', owner: 'STAGE2', episodes: [8], note: '按对话承接再细化机位。' }];
    const doc = await saveFoundationDocument(db, project.id, empty.revision, draft, 'offline prepared document fixture');
    const scopeFns = await import('@/lib/foundation-application-scope');
    const scope12 = scopeFns.readApplicationScope({kind:'SCENES',scenes:[{episode:12,sceneKey:'12-2'},{episode:13,sceneKey:'13-1'}]});
    assert.equal(scopeFns.scopeApplies(scope12,12,'12-1'),false);
    assert.equal(scopeFns.scopeApplies(scope12,12,'12-2'),true);
    assert.equal(scopeFns.scopeApplies(scope12,13,'13-1'),true);
    assert.equal(scopeFns.scopeApplies(scope12,14,'14-1'),false);
    assert.throws(()=>scopeFns.readApplicationScope({kind:'GLOBAL'}));
    assert.throws(()=>scopeFns.readChoiceEvidence([{sourceVersion:'old',episode:12}],input.sourceVersion));
    const contracts = await import('@/lib/foundation-production-contracts');
    const {applyDocumentEdit} = await import('@/lib/foundation-document');
    const followUp = {owner:'STAGE2',note:'只在走廊场细化交接动作',applicationScope:{kind:'SCENES',scenes:[{episode:8,sceneKey:'8-2'}]},evidenceRefs:[{sourceVersion:input.sourceVersion,episode:8,sceneKey:'8-2',startLine:1,endLine:1}]};
    const wire = {format:'FOUNDATION_OPTIMIZATION_V2',coverage:[8],changes:{},unresolved:[followUp]};
    const output = contracts.requireProductionOptimization(wire,input.sourceIndex,[8],catalog.assets);
    const realScenes = await supply.loadLightScenes(project.id,db);
    contracts.assertUnresolvedSourceScopes(output,input.sourceIndex,[8],realScenes);
    const scopedDoc = applyDocumentEdit(doc,output,input.sourceIndex);
    const [scopedPacket] = await supply.buildLightEpisodePackets(project.id,scopedDoc,db,[8]);
    assert.ok(!scopedPacket.scenes.find(s=>s.sceneKey==='8-1')!.followUps.some(t=>t.note===followUp.note));
    assert.ok(scopedPacket.scenes.find(s=>s.sceneKey==='8-2')!.followUps.some(t=>t.note===followUp.note));
    for (const bad of [
      {...followUp,applicationScope:{kind:'SCENES',scenes:[{episode:9,sceneKey:'9-1'}]}},
      {...followUp,evidenceRefs:[{sourceVersion:'stale',episode:8,startLine:1,endLine:1}]},
      {...followUp,evidenceRefs:[{sourceVersion:input.sourceVersion,episode:8,startLine:1,endLine:999}]}
    ]) assert.throws(()=>contracts.requireProductionOptimization({...wire,unresolved:[bad]},input.sourceIndex,[8],catalog.assets));
    const invented=contracts.requireProductionOptimization({...wire,unresolved:[{...followUp,applicationScope:{kind:'SCENES',scenes:[{episode:8,sceneKey:'fake-scene'}]}}]},input.sourceIndex,[8],catalog.assets);
    assert.throws(()=>contracts.assertUnresolvedSourceScopes(invented,input.sourceIndex,[8],realScenes),/场次不存在/);
    await assert.rejects(supply.buildLightEpisodePackets(project.id,applyDocumentEdit(doc,invented,input.sourceIndex),db,[8]),/场次不存在/);
    const scopeStore = await import('@/lib/foundation-choice-store');
    const baseChoice = { decisionKey: '钥匙/归属', kind: 'SOURCE_CONFLICT' as const, question: '钥匙由谁保管？', reason: '交接动作影响连续性', options: ['甲保管','乙保管'], recommended: '甲保管', recommendationReason: '有动作证据', evidence: '第8集8-2', episodes: [8], applicationScope: {kind:'SCENES' as const,scenes:[{episode:8,sceneKey:'8-2'},{episode:9,sceneKey:'9-1'}]}, evidenceRefs:[{sourceVersion:input.sourceVersion,episode:8,sceneKey:'8-2',startLine:1,endLine:1}] };
    await scopeStore.syncFoundationChoices(db, project.id, input.sourceVersion, 'F2', [baseChoice, {...baseChoice, options:['原物','替代物'],recommended:'原物'}]);
    assert.equal(await db.presentationContract.count({where:{projectId:project.id}}),2,'冲突选项不能合并');
    await db.presentationContract.updateMany({where:{projectId:project.id},data:{status:'CONFIRMED',userAnswer:'甲保管'}});
    await db.presentationContract.create({data:{projectId:project.id,category:'legacy',question:'明确全剧',options:'[]',status:'CONFIRMED',userAnswer:'全剧规则',scopeMode:'ALL_EPISODES'}});
    await db.presentationContract.create({data:{projectId:project.id,category:'legacy',question:'未知范围',options:'[]',status:'CONFIRMED',userAnswer:'不能广播'}});
    const scopedPackets = await supply.buildLightEpisodePackets(project.id, doc, db);
    assert.equal(scopedPackets.find(p=>p.episode===8)!.scenes.find(s=>s.sceneKey==='8-1')!.decisions.length,1);
    assert.equal(scopedPackets.find(p=>p.episode===8)!.scenes.find(s=>s.sceneKey==='8-2')!.decisions.length,3);
    assert.equal(scopedPackets.find(p=>p.episode===9)!.scenes[0].decisions.length,3);
    assert.equal(scopedPackets.find(p=>p.episode===7)!.scenes[0].decisions.length,1);
    assert.ok(!JSON.stringify(scopedPackets).includes('不能广播'));
    const { buildTaskSchemaV4Payload } = await import('@/lib/task-package');
    const scopedDecisions = (await scopeStore.loadFoundationChoices(db,project.id,input.sourceVersion)).confirmed;
    const task = await buildTaskSchemaV4Payload({projectName:'scope',episodeNumber:8,episodeText:episodes[1].content,sceneId:'8-1',scopedDecisions,existingAssets:[]});
    assert.equal((task['任务范围']['已确认决定'] as unknown[]).length,1);
    assert.equal((task['任务范围']['按场接收决定'] as unknown[]).length,0);
    const multi = await buildTaskSchemaV4Payload({projectName:'scope',episodeNumber:9,episodeText:episodes[2].content,sceneId:'9-1',scopedDecisions,existingAssets:[]});
    assert.equal((multi['任务范围']['按场接收决定'] as unknown[]).length,2);
    assert.equal((await scopeStore.loadFoundationChoices(db,project.id,'stale')).confirmed.length,2,'旧来源的模型决定不供给');
    // Different issues in different episode/scene positions retain exact mutation permissions.
    const { readChoiceChangeTargets } = await import('@/lib/foundation-choice-change-targets');
    const assetTargets = readChoiceChangeTargets({ assetKeys: [catalog.assets[0].key], assetFields: ['preparation'], sceneFields: [] })!;
    const sceneTargets = readChoiceChangeTargets({ assetKeys: [], assetFields: [], sceneFields: ['weather'] })!;
    const localIssues = [
      { ...baseChoice, decisionKey: 'generic-material-issue', question: '本场素材采用哪种方式？', changeTargets: assetTargets, episodes: [8], applicationScope: { kind: 'SCENES' as const, scenes: [{ episode: 8, sceneKey: '8-1' }] } },
      { ...baseChoice, decisionKey: 'generic-weather-issue', question: '本场天气采用哪种口径？', changeTargets: sceneTargets, episodes: [9], applicationScope: { kind: 'SCENES' as const, scenes: [{ episode: 9, sceneKey: '9-1' }] }, evidenceRefs: [{ sourceVersion: input.sourceVersion, episode: 9, sceneKey: '9-1', startLine: 1, endLine: 1 }] }
    ];
    await scopeStore.syncFoundationChoices(db, project.id, input.sourceVersion, 'Q1', localIssues);
    let issueRows = (await scopeStore.loadFoundationChoices(db, project.id, input.sourceVersion)).pending;
    assert.equal(issueRows.length, 2);
    for (const issue of issueRows) await scopeStore.confirmFoundationChoice(db, { projectId: project.id, contractId: issue.id, revision: issue.revision, optionIndex: '0' });
    const current = await scopeStore.loadFoundationChoices(db, project.id, input.sourceVersion);
    issueRows = current.confirmed.filter(row => issueRows.some(issue => issue.id === row.id));
    const scopedAgain = await supply.buildLightEpisodePackets(project.id, doc, db);
    const localOnly = (rows: typeof issueRows) => rows.filter(row => issueRows.some(issue => issue.id === row.id));
    const packet8 = scopedAgain.find(packet => packet.episode === 8)!, packet9 = scopedAgain.find(packet => packet.episode === 9)!;
    assert.deepEqual(localOnly(packet8.decisions).map(row => row.changeTargets), [assetTargets]);
    assert.deepEqual(localOnly(packet8.scenes.find(scene => scene.sceneKey === '8-1')!.decisions).map(row => row.changeTargets), [assetTargets]);
    assert.equal(localOnly(packet8.scenes.find(scene => scene.sceneKey === '8-2')!.decisions).length, 0);
    assert.deepEqual(localOnly(packet9.scenes[0].decisions).map(row => row.changeTargets), [sceneTargets]);
    assert.equal(localOnly(scopedAgain.find(packet => packet.episode === 7)!.decisions).length, 0);
    for (const [episodeNumber, sceneId, expected] of [[8, '8-1', assetTargets], [8, '8-2', null], [9, '9-1', sceneTargets]] as const) {
      const packageInput = await buildTaskSchemaV4Payload({ projectName: 'permission handoff', episodeNumber, episodeText: episodes.find(row => row.number === episodeNumber)!.content, sceneId, scopedDecisions: issueRows, existingAssets: [] });
      const received = packageInput['任务范围']['按场接收决定'] as typeof issueRows;
      assert.deepEqual(received.map(row => row.changeTargets), expected ? [expected] : []);
      assert.ok(received.every(row => row.applicationScope?.kind === 'SCENES'), '不能升级为全剧口径');
    }
    const wholeEpisodeTask = await buildTaskSchemaV4Payload({ projectName: 'whole episode', episodeNumber: 8, episodeText: episodes[1].content, scopedDecisions: issueRows, existingAssets: [] });
    assert.deepEqual(wholeEpisodeTask['任务范围']['已确认决定'], [], '场级事项不能上提成整集通用决定');
    assert.deepEqual((wholeEpisodeTask['任务范围']['按场接收决定'] as typeof issueRows).map(row => row.changeTargets), [assetTargets]);
    const { loadPipelineContext } = await import('@/lib/episode-pipeline');
    for (const number of [8, 9]) {
      const episode = await db.episode.findFirstOrThrow({ where: { projectId: project.id, number } });
      const context = await loadPipelineContext(project.id, episode.id);
      const actual = context.contracts.filter(contract => localIssues.some(issue => issue.question === contract.question));
      assert.equal(actual.length, 1);
      assert.deepEqual(actual[0].changeTargets, number === 8 ? assetTargets : sceneTargets);
      assert.deepEqual(actual[0].applicationScope, { kind: 'SCENES', scenes: [{ episode: number, sceneKey: `${number}-1` }] });
    }
    await (await import('@/lib/prisma')).prisma.$disconnect();
    await db.presentationContract.deleteMany({where:{projectId:project.id}});
    const before = { episodes: await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } }), snapshots: await db.sceneSnapshot.count(), runs: await db.pipelineRun.count() };
    const failures: string[] = [];
    async function check(name: string, test: () => Promise<void> | void) { try { await test(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
    await check('一场直接拿到基础与适用变体，不混入其它集', async () => {
      const packets = await supply.buildLightEpisodePackets(project.id, doc, db, [8]);
      assert.equal(packets.length, 1, '只读取所选集');
      const packet = packets[0], asset = catalog.assets[0];
      assert.equal(packet.schema, 'LIGHT_EPISODE_SUPPLY_V2');
      assert.equal(packet.sourceText, episodes[1].content);
      assert.deepEqual(packet.scenes[0].assetKeys, [asset.key, asset.variants[0].key]);
      assert.ok(!JSON.stringify(packet).includes('礼服'));
      assert.equal(packet.followUps[0].id, 'later-8');
      assert.equal(typeof supply.resolveLightAsset, 'function');
      assert.equal(supply.resolveLightAsset(packet, asset.variants[0].key)?.baseKey, asset.key);
      assert.equal(supply.resolveLightAsset(packet, 'unknown'), null);
    });
    await check('同集变体另场使用仍同时供给基础身份，不伪改目录定位', async () => {
      const changed = structuredClone(doc), asset = changed.f2!.assets[0];
      asset.variants[0].sceneRefs = [{ episode: 7, sceneKey: '7-1' }, { episode: 8, sceneKey: '8-2' }];
      assert.deepEqual(supply.collectLightSceneIssues(changed.f2!, await supply.loadLightScenes(project.id, db)), []);
      const packet = (await supply.buildLightEpisodePackets(project.id, changed, db, [8]))[0];
      assert.deepEqual(packet.scenes.find(scene => scene.sceneKey === '8-2')!.assetKeys, [asset.key, asset.variants[0].key]);
      assert.ok(!packet.assets[0].sceneRefs!.some(ref => ref.sceneKey === '8-2'));
      assert.equal(supply.resolveLightAsset(packet, asset.variants[0].key)?.baseKey, asset.key);
      const context = supply.buildLightBoundaryContext(input.sourceIndex, changed.f2, await supply.loadLightScenes(project.id, db), [9]);
      assert.equal(context?.previousSource.sceneKey, '8-2');
      assert.deepEqual(context?.priorStates.map(state => state.assetKey), [asset.key]);
      assert.equal(context?.priorStates[0].variants[0].key, asset.variants[0].key);
    });
    await check('仅提供必要前场事实和相关状态，不编摘要或自动永久继承', async () => {
      assert.equal(typeof supply.buildLightBoundaryContext, 'function');
      const context = supply.buildLightBoundaryContext(input.sourceIndex, catalog, await supply.loadLightScenes(project.id, db), [8]);
      assert.equal(context?.previousSource.episode, 7);
      assert.equal(context?.previousSource.sceneKey, '7-1');
      assert.ok(context?.previousSource.text.includes('血透出来'));
      assert.equal(context?.priorStates[0].variants[0].key, catalog.assets[0].variants[0].key);
      assert.ok(!JSON.stringify(context).includes('礼服') && !JSON.stringify(context).includes('summary'));
      assert.equal(supply.buildLightBoundaryContext(input.sourceIndex, catalog, await supply.loadLightScenes(project.id, db), [7]), null);
    });
    await check('共享读取函数只返回当前一集包，无原始运行历史且只读', async () => {
      const { readLightEpisodeFoundation } = await import('@/lib/light-foundation-reader');
      const result = await readLightEpisodeFoundation(project.id, 8, db);
      assert.deepEqual(result.packet, (await supply.buildLightEpisodePackets(project.id, doc, db, [8]))[0]);
      assert.ok(!('pipelineRuns' in result) && !('history' in result.packet));
      assert.equal(result.readiness, 'READY');
      await assert.rejects(() => readLightEpisodeFoundation(project.id, 100, db), /不存在|集号/);
    });
    await check('源文与存储记录未变，未产生模型调用', async () => {
      assert.deepEqual(await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } }), before.episodes);
      assert.equal(await db.sceneSnapshot.count(), before.snapshots); assert.equal(await db.pipelineRun.count(), before.runs);
    });
    let latest = doc;
    async function readDraft(change: (draft: typeof doc) => void, expected: 'READY' | 'PARTIAL', reason?: RegExp) {
      const next = structuredClone(doc); change(next);
      latest = await saveFoundationDocument(db, project.id, latest.revision, next, 'isolated readiness fixture');
      const counts = [await db.sceneSnapshot.count(), await db.pipelineRun.count(), await db.asset.count()];
      const result = await (await import('@/lib/light-foundation-reader')).readLightEpisodeFoundation(project.id, 8, db);
      assert.equal(result.readiness, expected, result.reasons.join(';'));
      if (reason) assert.match(result.reasons.join(';'), reason);
      assert.deepEqual([await db.sceneSnapshot.count(), await db.pipelineRun.count(), await db.asset.count()], counts, '读取不得登记资产或制造历史/调用');
      return result;
    }
    await check('准备方式未定必须可读但不能假READY', async () => {
      await readDraft(draft => { draft.f2!.assets[0].preparation = { mode: 'UNRESOLVED', note: '灰衣材质待定' }; }, 'PARTIAL', /灰衣材质待定/);
    });
    await check('无效场次引用不能假READY；其它集未编辑不污染本集', async () => {
      await readDraft(draft => { draft.f2!.assets[0].sceneRefs = [{ episode: 7, sceneKey: '7-1' }, { episode: 8, sceneKey: '不存在' }, { episode: 9, sceneKey: '9-1' }]; }, 'PARTIAL', /场次/);
      await readDraft(draft => { draft.editorialCoverage = [7, 8]; draft.f2!.assets[0].variants[1].preparation = { mode: 'UNRESOLVED', note: '无关礼服待定' }; }, 'READY');
    });
    await check('跨集派生来源闭包仅供制图，不伪装本集出场', async () => {
      const result = await readDraft(draft => {
        const base = draft.f2!.assets[0];
        base.variants.push({ key: 'old-material-7', name: '旧灰衣素材', episodes: [7], sceneRefs: [{ episode: 7, sceneKey: '7-1' }], note: '来源身份', preparation: { mode: 'REFERENCE' } });
        base.variants[0].preparation = { mode: 'DERIVE', fromKey: 'old-material-7' };
      }, 'READY');
      assert.deepEqual(result.packet.materialDependencies.map(item => item.key), ['old-material-7']);
      assert.equal(result.packet.materialDependencies[0].use, 'MATERIAL_SOURCE_ONLY');
      assert.equal(supply.resolveLightAsset(result.packet, 'old-material-7')?.preparation?.mode, 'REFERENCE');
      assert.ok(!result.packet.scenes.some(scene => scene.assetKeys.includes('old-material-7')));
      assert.ok(!JSON.stringify(result.packet).includes('礼服'));
      await readDraft(draft => {
        const base = draft.f2!.assets[0];
        base.variants.push({ key: 'old-material-7', name: '旧灰衣素材', episodes: [7], sceneRefs: [{ episode: 7, sceneKey: '7-1' }], note: '', preparation: { mode: 'UNRESOLVED', note: '旧来源待完善' } });
        base.variants[0].preparation = { mode: 'DERIVE', fromKey: 'old-material-7' };
      }, 'PARTIAL', /旧来源待完善|派生来源/);
    });
    await check('已确认但本集未采用的决定仍须提示；分集采用回执有效', async () => {
      const { loadFoundationChoices } = await import('@/lib/foundation-choice-store');
      const choice = await db.presentationContract.create({ data: { projectId: project.id, category: 'VISUAL', question: '灰衣颜色确认', options: '[]', userAnswer: '保留灰色', status: 'CONFIRMED',
        note: JSON.stringify({ schema: 'FOUNDATION_HUMAN_CHOICE_V1', sourceVersion: input.sourceVersion, decisionKey: 'gray', episodes: [8, 9], sourceStages: ['Q1'], reason: '', recommended: '', recommendationReason: '' }) } });
      const confirmed = (await loadFoundationChoices(db, project.id, input.sourceVersion)).confirmed[0];
      await readDraft(() => {}, 'PARTIAL', /灰衣颜色确认|选择|决定/);
      await readDraft(draft => { draft.decisionCoverage = { [choice.id]: { revision: confirmed.revision, episodes: [8], notes: ['第8集已采用'] } }; }, 'READY');
      await db.presentationContract.delete({ where: { id: choice.id } });
    });
    await check('目录缺本集时仍返回原文和PARTIAL', async () => {
      await readDraft(draft => { draft.f2 = null; }, 'PARTIAL', /资产尚未编目/);
      await readDraft(draft => {
        draft.f2!.coverage = [7, 9]; draft.f2!.episodes = draft.f2!.episodes.filter(episode => episode.number !== 8);
        for (const asset of draft.f2!.assets) { asset.usageEpisodes = asset.usageEpisodes.filter(number => number !== 8); asset.sceneRefs = asset.sceneRefs?.filter(ref => ref.episode !== 8);
          for (const variant of asset.variants) { variant.episodes = variant.episodes.filter(number => number !== 8); variant.sceneRefs = variant.sceneRefs?.filter(ref => ref.episode !== 8); } }
      }, 'PARTIAL', /资产尚未编目/);
    });
    await check('前场截取和断集缺口显式；单字名字不靠正文误匹配', async () => {
      const scenes = await supply.loadLightScenes(project.id, db);
      const context = supply.buildLightBoundaryContext(input.sourceIndex, catalog, scenes, [8]);
      assert.deepEqual(context?.gaps, []);
      assert.equal(context?.previousSource.clipped, false);
      const unrelated = structuredClone(catalog); unrelated.assets.push({ ...structuredClone(unrelated.assets[0]), key: 'other-person', name: '城', aliases: [], variants: [] });
      const safe = supply.buildLightBoundaryContext(input.sourceIndex, unrelated, scenes, [8]);
      assert.ok(!safe?.priorStates.some(state => state.assetKey === 'other-person'));
      const named = structuredClone(catalog); named.assets[0].aliases.push('整座城');
      const missingFirst = supply.buildLightBoundaryContext(input.sourceIndex, named, scenes.filter(scene => scene.episode !== 8), [8]);
      assert.ok(!missingFirst?.priorStates.some(state => state.type === 'CH'), '首场缺失不能用整集正文猜相关旧状态');
      const index = buildSourceIndex(input.sourceIndex.episodes.filter(episode => episode.number !== 8));
      const gap = supply.buildLightBoundaryContext(index, catalog, scenes.filter(scene => scene.episode !== 8), [9]);
      assert.ok(gap?.gaps.some(note => /间隔|缺|相邻/.test(note)));
      const longIndex = structuredClone(input.sourceIndex), previous = longIndex.episodes.find(episode => episode.number === 7)!;
      previous.content = '原文长行'.repeat(700); const longScenes = structuredClone(scenes); longScenes[0].sourceRange = { start: 0, end: previous.content.length };
      const clipped = supply.buildLightBoundaryContext(buildSourceIndex(longIndex.episodes), catalog, longScenes, [8]);
      assert.ok(clipped?.previousSource.clipped && clipped.gaps.length, '超长一行不得悄悄变成无前场');
      assert.ok(clipped.previousSource.text.length <= 2400);
    });
    await check('本集末尾原文漏出场次时可读但必须PARTIAL', async () => {
      await readDraft(() => {}, 'READY');
      const row = await db.scriptScene.findFirstOrThrow({ where: { sceneKey: '8-1', episode: { projectId: project.id } } });
      try {
        await db.scriptScene.update({ where: { id: row.id }, data: { sourceText: row.sourceText.slice(0, -12) } });
        const result = await (await import('@/lib/light-foundation-reader')).readLightEpisodeFoundation(project.id, 8, db);
        assert.equal(result.packet.sourceText, episodes[1].content);
        assert.equal(result.readiness, 'PARTIAL');
        assert.match(result.reasons.join(';'), /末尾|场次/);
      } finally { await db.scriptScene.update({ where: { id: row.id }, data: { sourceText: row.sourceText } }); }
    });
    await check('必要前场定位丢失仍可读原文，但不可假READY', async () => {
      await readDraft(() => {}, 'READY');
      const row = await db.scriptScene.findFirstOrThrow({ where: { sceneKey: '7-1', episode: { projectId: project.id } } });
      try {
        await db.scriptScene.update({ where: { id: row.id }, data: { sourceText: '不匹配源文的前场旧定位' } });
        const result = await (await import('@/lib/light-foundation-reader')).readLightEpisodeFoundation(project.id, 8, db);
        assert.equal(result.packet.sourceText, episodes[1].content);
        assert.equal(result.readiness, 'PARTIAL');
        assert.match(result.reasons.join(';'), /前一集末场尚未定位|原文定位待重建/);
      } finally { await db.scriptScene.update({ where: { id: row.id }, data: { sourceText: row.sourceText } }); }
    });
    await check('其它集错误定位不得使所选集不可读取', async () => {
      const row = await db.scriptScene.findFirstOrThrow({ where: { sceneKey: '9-1', episode: { projectId: project.id } } });
      try {
        await db.scriptScene.update({ where: { id: row.id }, data: { sourceText: '另一个不相关的场次旧定位' } });
        const result = await (await import('@/lib/light-foundation-reader')).readLightEpisodeFoundation(project.id, 8, db);
        assert.equal(result.readiness, 'READY');
        assert.equal(result.packet.scenes[0].sceneKey, '8-1');
      } finally { await db.scriptScene.update({ where: { id: row.id }, data: { sourceText: row.sourceText } }); }
    });
    await check('显式只属于其它集的旧提醒不能污染本集准备度或后续事项', async () => {
      const result = await readDraft(draft => { draft.editorialTodos.push(
        { id: 'other-legacy', owner: 'PROGRAM', note: '第9集场次需要检查。' },
        { id: 'other-later', owner: 'STAGE2', note: '第9集礼服场面稍后细化。' }); }, 'READY');
      assert.ok(!result.packet.followUps.some(todo => todo.id === 'other-later'));
    });
    await check('导入器读取警告不能在单集交接中丢失', async () => {
      const imported = await db.sceneSnapshot.findFirstOrThrow({ where: { projectId: project.id, sceneKey: 'SOURCE_IMPORT' } });
      const body = JSON.parse(imported.content); body.readingView = { kind: 'DOCX', warnings: ['源文件中的图片文字未提取，请核对。'] };
      await db.sceneSnapshot.update({ where: { id: imported.id }, data: { content: JSON.stringify(body) } });
      const packet = (await supply.buildLightEpisodePackets(project.id, doc, db, [8]))[0];
      assert.deepEqual(packet.warnings, ['源文件中的图片文字未提取，请核对。']);
    });
    await check('不能给新原文套用旧工作稿版本标签', async () => {
      await assert.rejects(() => supply.buildLightEpisodePackets(project.id, { ...doc, sourceVersion: 'stale-source' }, db, [8]), /原文版本|source|旧版/);
    });
    for (const failure of failures) console.error(`FAIL ${failure}`);
    assert.equal(failures.length, 0, 'light handoff checks');
    console.log('PASS light handoff: scoped source, base/variant resolution, boundary evidence, shared readonly reader');
  } finally { await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
