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
    const before = { episodes: await db.episode.findMany({ where: { projectId: project.id }, orderBy: { number: 'asc' } }), snapshots: await db.sceneSnapshot.count(), runs: await db.pipelineRun.count() };
    const failures: string[] = [];
    async function check(name: string, test: () => Promise<void> | void) { try { await test(); } catch (error) { failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`); } }
    await check('共享输入避免重复全剧加载，缓存依赖变更失效', async () => {
      const { cachedFoundationFacts } = await import('@/lib/foundation-fact-cache');
      const facts=cachedFoundationFacts(input.sourceIndex,input.sourceContext,doc.f2);
      assert.equal(cachedFoundationFacts(input.sourceIndex,input.sourceContext,doc.f2),facts);
      assert.notEqual(cachedFoundationFacts(buildSourceIndex(episodes.map(e=>({...e,content:e.content+'\n'}))),input.sourceContext,doc.f2),facts);
      assert.notEqual(cachedFoundationFacts(input.sourceIndex,{...input.sourceContext,version:'changed-context'},doc.f2),facts);
      const renamed=structuredClone(doc.f2)!;renamed.assets[0].aliases.push('新称呼');
      assert.notEqual(cachedFoundationFacts(input.sourceIndex,input.sourceContext,renamed),facts);
      const guarded=new Proxy(db,{get(target,key){
        if(key==='episode')return new Proxy(target.episode,{get(delegate,method){if(method==='findMany')return (args: { select?: { id?: boolean; number?: boolean; content?: boolean } })=>{if(!args.select||args.select.content)throw new Error('重复读取全剧正文');return delegate.findMany(args);};return Reflect.get(delegate,method);}});
        return Reflect.get(target,key);
      }});
      const shared=(await supply.buildLightEpisodePackets(project.id,doc,guarded,[8],input))[0];
      assert.deepEqual(shared,(await supply.buildLightEpisodePackets(project.id,doc,db,[8]))[0]);
      assert.equal(shared.boundaryContext?.previousSource.episode,7);
      assert.equal(shared.episodeBoundary.schema, 'EPISODE_BOUNDARY_SEED_V1');
      assert.equal(shared.episodeBoundary.sourceVersion, input.sourceVersion);
      assert.equal(shared.episodeBoundary.fromEpisode, 7);
      assert.equal(shared.episodeBoundary.toEpisode, 8);
      await assert.rejects(supply.buildLightEpisodePackets(project.id,{...doc,sourceVersion:'stale'},guarded,[8],input));
      await assert.rejects(supply.buildLightEpisodePackets('other-project',doc,guarded,[8],input));
    });
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
    await check('未定位派生源同时保留材料候选与依赖，但不进入本集出场', async () => {
      const changed = structuredClone(doc), base = changed.f2!.assets[0];
      const material = { ...structuredClone(base), key: 'unlocated-material', name: '未定位灰衣源', usageEpisodes: [], sceneRefs: [], variants: [], preparation: { mode: 'REFERENCE' as const } };
      changed.f2!.assets.push(material);
      base.variants[0].preparation = { mode: 'DERIVE', fromKey: material.key };
      const packet = (await supply.buildLightEpisodePackets(project.id, changed, db, [8], input))[0];
      assert(packet.materialCandidates.some(item => item.key === material.key && item.use === 'CANDIDATE_ONLY'));
      assert(packet.materialDependencies.some(item => item.key === material.key && item.use === 'MATERIAL_SOURCE_ONLY'));
      assert(!packet.assets.some(item => item.key === material.key));
      assert(!packet.scenes.some(item => item.assetKeys.includes(material.key)));
      assert.equal(supply.resolveLightAsset(packet, material.key)?.preparation?.mode, 'REFERENCE');
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
      assert.ok(clipped && !clipped.previousSource.clipped && clipped.previousSource.budgetExceeded, '完整超长节点只超软预算，不冒充已截取');
      assert.equal(clipped.previousSource.text, previous.content, '超长一行必须原样保留，不得截断节点');
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
        assert.equal(result.packet.boundaryContext?.previousSource.sceneKey, null, '旧读取保留尚未重建的定位缺口');
        assert.equal(result.packet.episodeBoundary.previousSource?.sceneKey, '7-1', '新seed独立携带原文结构场号');
        assert(result.packet.episodeBoundary.previousSource?.text.includes('血透出来'));
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
