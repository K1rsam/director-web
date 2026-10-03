import assert from 'node:assert/strict';
import { buildSourceIndex } from '../lib/project-foundation-contracts';
import { buildLightBoundaryContext } from '../lib/light-foundation-supply';
import { buildFoundationFacts, selectFoundationFacts } from '../lib/foundation-facts';
import { projectProductionCatalog, requireProductionCatalogAuthor } from '../lib/foundation-production-contracts';
import type { FoundationSourceContext } from '../lib/foundation-source';
import { buildEpisodeBoundarySeed } from '../lib/episode-boundary-seed';
import * as boundarySeeds from '../lib/episode-boundary-seed';

let failures = 0;
function check(name: string, run: () => void) {
  try { run(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
const previous = '第一集\r\n1-1 大厅 日 内\r\n△林岚来到大厅。\r\n1-2 走廊 夜 内\r\n林岚：\r\n我已告诉程野真相。\r\n他可以离开了。\r\n';
const current = '第二集\n2-1 走廊 夜 内\n林岚：程野，你还在吗？\n';
const index = buildSourceIndex([{ number: 1, title: null, content: previous }, { number: 2, title: null, content: current }]);
check('a consumed full-source expansion survives later refresh without reusing a changed source',()=>{
  const seed=buildEpisodeBoundarySeed(index,[],2,{softBudget:12});
  const expanded=boundarySeeds.expandEpisodeBoundarySeed(seed,previous);
  const retained=boundarySeeds.retainExpandedEpisodeBoundarySeed(seed,expanded);
  assert.equal(retained.previousSource?.selectionKind,'FULL_EPISODE_EXPANSION');
  assert.equal(retained.previousSource?.text,previous);
  assert.deepEqual(retained.currentOpening,seed.currentOpening);
  const changed=buildEpisodeBoundarySeed(buildSourceIndex([{number:1,title:null,content:previous+'△林岚离开。'},{number:2,title:null,content:current}]),[],2,{softBudget:12});
  assert.deepEqual(boundarySeeds.retainExpandedEpisodeBoundarySeed(changed,expanded),changed);
});
const scene = (episode: number, content: string) => ({ episode, sceneKey: `${episode}-1`, heading: '', location: '', timeOfDay: '', interiorExterior: '', weather: null, timeLayer: '', characters: ['林岚'], sourceRange: { start: 0, end: content.length } });
check('missing saved scenes recovers a real last scene with complete multiline dialogue', () => {
  const boundary = buildLightBoundaryContext(index, null, [], [2]);
  assert.equal(boundary?.previousSource.text, previous.slice(previous.indexOf('1-2')));
  assert.equal(boundary?.previousSource.startLine, 4);
  assert.equal(boundary?.previousSource.endLine, 7);
});
check('a long source node is not clipped even when it exceeds the soft budget', () => {
  const content = '林岚：' + '一句完整且不可截断的陈述😀'.repeat(230) + '。';
  const long = buildSourceIndex([{ number: 1, title: null, content }, { number: 2, title: null, content: current }]);
  const boundary = buildLightBoundaryContext(long, null, [scene(1, content), scene(2, current)], [2]);
  assert.equal(boundary?.previousSource.text.length, content.length, '完整长单行不能按2400字符截断');
  assert.equal(boundary?.previousSource.text, content);
});
check('no heading fallback keeps raw source without pretending it is a located scene', () => {
  const content = '△林岚收起信件。\n林岚：\n明天再说。\n';
  const bare = buildSourceIndex([{ number: 1, title: null, content }, { number: 2, title: null, content: current }]);
  const boundary = buildLightBoundaryContext(bare, null, [], [2]);
  assert.equal(boundary?.previousSource.text, content);
  assert.equal(boundary?.previousSource.sceneKey, null);
});
const context: FoundationSourceContext = { version: 'candidate-test', background: [{ key: 'notes', text: '林岚：你必须相信我，不能告诉程野。\n规则：所有人午夜后不得说谎。\n' }], unresolved: [], notices: [], issues: [], complete: true, coverage: 'COMPLETE' };
const factsIndex = buildSourceIndex([
  { number: 1, title: null, content: '林岚是程野的姐姐。\n林岚的身份是监察员。\n林岚知道程野藏起了钥匙。\n林岚：我并不知道密码。\n△林岚受伤。\n伤已经治好了。\n' },
  { number: 2, title: null, content: '林岚：走吧。\n' }
]);
check('background character dialogue never becomes a global source rule', () => {
  const store = buildFoundationFacts(factsIndex, context, null, { standard: true });
  const quote = store.facts.find(f => f.statement.startsWith('林岚：你必须'))!;
  assert.equal(quote.kind, 'UTTERANCE');
  assert.equal(quote.claim, 'CHARACTER_CLAIM');
  assert.notEqual(quote.applicability, 'GLOBAL');
  assert(store.facts.some(f => f.statement.startsWith('规则：') && f.applicability === 'GLOBAL'));
});
check('history supplies identity relation knowledge and nearby release as evidence candidates', () => {
  const store = buildFoundationFacts(factsIndex, context, null, { standard: true });
  const selected = selectFoundationFacts(store, factsIndex, [2]);
  assert(Array.isArray(selected.historicalEvidenceCandidates), '缺少历史证据候选通道');
  for (const phrase of ['姐姐', '监察员', '藏起了钥匙', '并不知道密码', '治好了']) {
    const candidate = selected.historicalEvidenceCandidates.find(f => f.statement.includes(phrase));
    assert(candidate, `历史候选遗漏 ${phrase}`);
    assert.equal(candidate.candidateUse, 'HISTORICAL_EVIDENCE_ONLY');
    assert.equal(candidate.currentApplicability, 'UNKNOWN');
    assert.equal(candidate.statement, factsIndex.episodes[0].content.slice(candidate.evidence.start, candidate.evidence.end));
  }
  assert.equal(selected.historicalEvidenceCandidates.find(f => f.statement.includes('并不知道密码'))!.claim, 'CHARACTER_CLAIM');
});
const catalog = requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [1, 2], assets: [
  { name: '林岚', type: 'CH', episodes: [2], preparation: { mode: 'REFERENCE' }, variants: [
    { name: '计划雨衣', episodes: [], note: '尚未定位', preparation: { mode: 'DERIVE' } },
    { name: '工作服', episodes: [2], preparation: { mode: 'DERIVE' } }
  ] },
  { name: '候选信件', type: 'PROP', episodes: [], preparation: { mode: 'REFERENCE' } }
] }, index, [1, 2]);
check('unlocated identities and variants are candidates, never current appearances', () => {
  const projected = projectProductionCatalog(catalog, [2]) as ReturnType<typeof projectProductionCatalog> & { materialCandidates?: Array<Record<string, any>> };
  assert.deepEqual(projected.assets.map(a => a.name), ['林岚']);
  assert.deepEqual(projected.assets[0].variants.map(v => v.name), ['工作服']);
  assert.equal(projected.materialCandidates?.length, 2);
  assert(projected.materialCandidates!.every(a => a.use === 'CANDIDATE_ONLY' && a.reason === 'UNLOCATED_USAGE'));
  const raincoat = projected.materialCandidates!.find(a => a.key === catalog.assets[0].variants[0].key)!;
  assert.equal(raincoat.baseKey, catalog.assets[0].key);
  assert.equal(raincoat.preparation?.mode, 'DERIVE');
  assert.deepEqual(raincoat.episodes, []);
});
check('versioned boundary seed distinguishes adjacency from story continuity', () => {
  const seed = buildEpisodeBoundarySeed(index, [], 2);
  assert.equal(seed.schema, 'EPISODE_BOUNDARY_SEED_V1');
  assert.equal(seed.sourceVersion, index.version);
  assert.equal(seed.fromEpisode, 1); assert.equal(seed.toEpisode, 2); assert.equal(seed.adjacentEpisode, true);
  assert.deepEqual(seed.story, { timeLayer: 'UNKNOWN', realityDomain: 'UNKNOWN' });
  assert(!('initialStates' in seed));
  for (const source of [seed.previousSource!, seed.currentOpening]) {
    const text = index.episodes.find(e => e.number === source.episode)!.content;
    assert.equal(source.text, text.slice(source.sourceRange.start, source.sourceRange.end));
    assert(source.nodes.every(n => n.sourceRange.start >= source.sourceRange.start && n.sourceRange.end <= source.sourceRange.end));
  }
  assert.equal(seed.previousSource!.selectionKind, 'STANDARD_SCENE');
  assert(seed.previousSource!.nodes.some(n => n.kind === 'DIALOGUE' && n.endLine > n.startLine));
});
check('soft budget keeps opening dialogue and final action before trailing guidance', () => {
  const opening = '2-1 房间 夜 内\n林岚：' + '完整开场话语'.repeat(600) + '。\n';
  const ending = '1-1 房间 夜 内\n△林岚放下钥匙。\n导演处理：' + '仍是辅助备注'.repeat(600) + '。\n';
  const source = buildSourceIndex([{ number: 1, title: null, content: ending }, { number: 2, title: null, content: opening }]);
  const seed = buildEpisodeBoundarySeed(source, [], 2);
  assert(seed.currentOpening.nodes.some(n => n.kind === 'DIALOGUE'), '预算不能只留开场标题而丢掉完整对白');
  assert(seed.previousSource!.nodes.some(n => n.kind === 'ACTION'), '预算不能只留辅助备注而丢掉末动作');
});
check('explicit time-layer metadata is copied while keywords alone remain unknown', () => {
  const timed = buildSourceIndex([{ number: 1, title: null, content: '1-1 室内\n时间层：十年前\n林岚：我不是在做梦，醒来吧。\n' }]);
  const seed = buildEpisodeBoundarySeed(timed, [], 1);
  assert.equal(seed.story.timeLayer, '十年前');
  assert.equal(seed.story.realityDomain, 'UNKNOWN');
  assert.equal(seed.previousSource, null);
  assert.equal(seed.fromEpisode, null);
  const laterTime = buildSourceIndex([{ number: 1, title: null, content: '1-1 室内\n林岚：走吧。\n时间层：十年前\n' }]);
  assert.equal(buildEpisodeBoundarySeed(laterTime, [], 1).story.timeLayer, 'UNKNOWN', '正文之后的时间层声明不能倒推为开场时间');
  const nonadjacent = buildSourceIndex([{ number: 1, title: null, content: previous }, { number: 4, title: null, content: current }]);
  assert.equal(buildEpisodeBoundarySeed(nonadjacent, [], 4).adjacentEpisode, false);
});
check('candidate evidence rejects stale slices and retains unknown metadata', () => {
  const store = buildFoundationFacts(factsIndex, context, null, { standard: true });
  const first = store.facts.find(f => f.evidence.episode === 1)!;
  Object.assign(first, { futureMetadata: { opaque: ['keep'] } });
  Object.assign(first.evidence, { futureCoordinate: 'keep' });
  Object.assign(store, { futureEnvelope: { sourcePolicy: 'keep' } });
  store.facts.push({ ...structuredClone(first), id: 'fabricated', statement: '林岚永远无伤。' });
  const result = selectFoundationFacts(store, factsIndex, [2]);
  assert(!result.historicalEvidenceCandidates.some(f => f.id === 'fabricated'));
  assert.equal(result.historicalEvidenceRejected, 1);
  const saved = result.historicalEvidenceCandidates.find(f => f.id === first.id)!;
  assert.deepEqual(Reflect.get(saved, 'futureMetadata'), { opaque: ['keep'] });
  assert.equal(Reflect.get(saved.evidence, 'futureCoordinate'), 'keep');
  assert.deepEqual(Reflect.get(result, 'futureEnvelope'), { sourcePolicy: 'keep' });
});
check('material candidates preserve metadata and do not mutate the full catalog', () => {
  const before = JSON.stringify(catalog), candidate = catalog.assets[1];
  Object.assign(candidate, { futureMetadata: { opaque: true } });
  const projection = projectProductionCatalog(catalog, [1]);
  assert.equal(projection.assets.length, 0);
  assert.deepEqual(projection.materialCandidates!.find(c => c.key === candidate.key)!.futureMetadata, { opaque: true });
  assert.equal(catalog.assets[0].variants.length, 2);
 assert.equal(JSON.stringify(catalog).replace(',"futureMetadata":{"opaque":true}', ''), before);
});
check('boundary expansion restores complete original nodes without changing current opening or inventing a last scene', () => {
  const expand=(boundarySeeds as any).expandEpisodeBoundarySeed;
  assert.equal(typeof expand,'function','缺少有哈希约束的免费完整原文补读路径');
  const full='1-1 大厅 日 内\n△林岚曾留下信件。\n1-2 走廊 夜 内\n'+Array.from({length:60},(_,i)=>`△第${i}个完整动作保持在原文中。\n`).join('')+'林岚：\n我已告诉程野真相。\n他可以离开了。\n';
  const original=buildEpisodeBoundarySeed(buildSourceIndex([{number:1,title:null,content:full},{number:2,title:null,content:current}]),[],2,{softBudget:100}),before=structuredClone(original);
  assert.equal(original.previousSource!.clipped,true);
  const result=expand(original,full);
  assert.equal(result.previousSource.text,full);assert.deepEqual(result.previousSource.sourceRange,{start:0,end:full.length});
  assert.equal(result.previousSource.clipped,false);assert.equal(result.previousSource.sceneKey,null);assert.equal(result.previousSource.selectionKind,'FULL_EPISODE_EXPANSION');
  assert(result.previousSource.nodes.some((n:any)=>n.kind==='DIALOGUE'&&n.endLine>n.startLine));
  assert.deepEqual(result.currentOpening,original.currentOpening);assert.deepEqual(result.story,original.story);assert.equal(result.sourceVersion,original.sourceVersion);
  assert.deepEqual(original,before);assert.deepEqual(expand(result,full),result);
  const retained=original.previousSource!;
  const changed='9'+full.slice(1);assert.equal(changed.slice(retained.sourceRange.start,retained.sourceRange.end),retained.text);
  assert.throws(()=>expand(original,changed),/哈希|原文/,'未供部分变更也必须被完整原文哈希识别');
  assert.throws(()=>expand({...original,previousSource:{...retained,text:'冒充原句'}},full),/原文|坐标/);
});
if (failures) process.exitCode = 1;
