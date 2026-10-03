import assert from 'node:assert/strict';
import { buildSourceIndex } from '../lib/project-foundation-contracts';
import { requireProductionCatalogAuthor } from '../lib/foundation-production-contracts';
import { buildLightBoundaryContext } from '../lib/light-foundation-supply';
import { buildFoundationFacts } from '../lib/foundation-facts';
import type { FoundationSourceContext } from '../lib/foundation-source';
import { prepareEpisodeReception, collectScriptReceptionIssues, scriptStructureTable } from '../lib/standard-script-reception';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {makeEpisodeInput} = require('../runtime/storyboard-v4/input.mjs');
const {normalizeSource} = require('../runtime/storyboard-v4/core/source.mjs');
const {buildRequest, sliceSource} = require('../runtime/storyboard-v4/core/core.mjs');

const content = '第一集：钥匙\n1-1 后台 日 内\n出场人物：林岚、程野\n林岚（压低声音）：\n你刚才说：“借你一天：明早还我。”\n现在又催？\n△林岚把铜钥匙放进右口袋。\n';
const second = '第二集：还钥匙\n2-1 后台 日 内\n出场人物：林岚、程野\n△林岚将带蓝色钥匙扣的铜钥匙放进程野手里。\n';
const index = buildSourceIndex([{ number: 1, title: null, content }, { number: 2, title: null, content: second }]);
const context: FoundationSourceContext = { version: 'test', background: [], unresolved: [], notices: [], issues: [], complete: true, coverage: 'COMPLETE' };
const catalog = requireProductionCatalogAuthor({ format: 'ASSET_CATALOG_V2', coverage: [1, 2], assets: [
  { name: '林岚', type: 'CH', episodes: [1, 2], sceneRefs: [{ episode: 1, sceneKey: '1-1' }, { episode: 2, sceneKey: '2-1' }] },
  { name: '铜钥匙（蓝色钥匙扣）', type: 'PROP', episodes: [1, 2], sceneRefs: [{ episode: 1, sceneKey: '1-1' }, { episode: 2, sceneKey: '2-1' }] }
] }, index, [1, 2]);
let failures = 0;
function check(name: string, run: () => void) { try { run(); console.log(`PASS ${name}`); } catch (error) { failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); } }
check('standard fact projection does not invent speakers from headings or wrapped quotes', () => {
  const facts = (buildFoundationFacts as Function)(index, context, catalog, { standard: true }).facts;
  const speech = facts.filter((f: any) => f.kind === 'UTTERANCE');
  assert(!speech.some((f: any) => f.subjects.some((s: string) => ['第一集', '第二集', '出场人物', '你刚才说'].includes(s))));
  const quote = speech.find((f: any) => f.statement.includes('你刚才说'));
  assert(quote?.subjects.includes('林岚'));
  for (const fact of facts) assert.equal(fact.statement, index.episodes.find(e => e.number === fact.evidence.episode)!.content.slice(fact.evidence.start, fact.evidence.end));
});
check('legacy fact extraction remains separately reproducible for saved tasks', () => {
  const legacy = buildFoundationFacts(index, context, catalog);
  assert(legacy.facts.some(f => f.kind === 'UTTERANCE' && f.subjects.includes('你刚才说')));
});
const scenes = index.episodes.map(e => ({ episode: e.number, sceneKey: `${e.number}-1`, heading: '后台 日 内', location: '后台', timeOfDay: '日', interiorExterior: '内', weather: null, timeLayer: '现实', characters: ['林岚', '程野'], sourceRange: { start: 0, end: e.content.length } }));
check('continuity uses current stable scene asset identity despite decorated display name', () => {
  const boundary = buildLightBoundaryContext(index, catalog, scenes, [2]);
  assert(boundary?.priorStates.some(a => a.name === '铜钥匙（蓝色钥匙扣）'));
  assert.equal(boundary!.previousSource.text, content);
});
check('similar names alone do not add unrelated previous assets', () => {
  const unrelated = structuredClone(catalog);
  unrelated.assets.push({ ...structuredClone(catalog.assets[1]), key: 'unrelated-key', name: '铜钥匙（另一把）', sceneRefs: [{ episode: 1, sceneKey: '1-1' }], usageEpisodes: [1] });
  const boundary = buildLightBoundaryContext(index, unrelated, scenes, [2]);
  assert(!boundary?.priorStates.some(a => a.assetKey === 'unrelated-key'));
});
check('same-name identities without a current-scene reference are not inherited', () => {
  const ambiguous = structuredClone(catalog);
  ambiguous.assets.push({...structuredClone(catalog.assets[0]), key: 'same-name-old-only', sceneRefs: [{episode: 1, sceneKey: '1-1'}], usageEpisodes: [1]});
  const boundary = buildLightBoundaryContext(index, ambiguous, scenes, [2]);
  assert(!boundary?.priorStates.some(a => a.assetKey === 'same-name-old-only'));
});
const prepare = (text = content) => {
  const episode = {id: 'ep', projectId: 'p', number: 1, title: '第一集', content: text};
  const packet = {sourceText: text, ...prepareEpisodeReception(episode, catalog)};
  return makeEpisodeInput({episode, project: {id: 'p', style: '3D国漫', aspectRatio: '16:9'}, handoff: {readiness: 'READY', reasons: [], packet}});
};
check('actual stage3 consumes the compiled multiline dialogue without re-guessing colons', () => {
  const result = prepare();
  assert.deepEqual(result.source.diagnostics, []);
  assert.equal(result.source.dialogue.length, 1);
  assert.equal(result.source.dialogue[0].speaker, '林岚');
  assert.equal(result.source.dialogue[0].cue, '压低声音');
  assert.equal(result.source.dialogue[0].quote, '你刚才说：“借你一天：明早还我。”\n现在又催？');
  assert(buildRequest({stage: 'plan', source: result.source, settings: {maxUnits: null, fantasyMode: 'off'}}).prompt.length > 0);
  assert.deepEqual(normalizeSource(JSON.parse(JSON.stringify(result.source))), result.source);
});
check('guidance is retained separately and cannot prove an entry fact', () => {
  const result = prepare(content + '连续性备注：钥匙位置请结合前文核对。\n');
  const note = result.source.contextRows.find((r: any) => r.evidenceRole === 'guidance');
  assert(note?.text.includes('钥匙位置'));
  assert(!result.source.dialogue.some((d: any) => d.speaker === '连续性备注'));
  assert.throws(() => normalizeSource({...result.source, entryFacts: [{id: 'false-fact', subject: '钥匙', statement: '钥匙位置请结合前文核对。', sourceRefs: [note.id], evidenceMode: 'source_rows'}]}), (error: any) => error.code === 'ENTRY_FACT_GUIDANCE');
});
check('unknown ownership is reported as an upstream program issue, not extra AI prose', () => {
  const bad = buildSourceIndex([{number: 1, title: null, content: '第一集\n不明字段：未定内容\n'}]);
  assert(collectScriptReceptionIssues(bad, null).some(i => i.owner === 'PROGRAM' && i.coordinate.endsWith('L2')));
});
check('a stale standardized handoff cannot silently fall back to legacy parsing', () => {
  const episode = {id: 'ep', projectId: 'p', number: 1, content: content + '△新动作。\n'};
  assert.throws(() => makeEpisodeInput({episode, project: {id: 'p'}, handoff: {packet: {sourceText: content, ...prepareEpisodeReception({number: 1, content}, catalog)}}}), (error: any) => error.code === 'STANDARD_SOURCE_BINDING');
});
check('altered compiled text/channel cannot reuse a mechanical receipt', () => {
  for (const field of ['text', 'channel']) {
    const reception = prepareEpisodeReception({number: 1, content}, catalog);
    const node = reception.standardScript!.script.entries.find(e => e.kind === 'DIALOGUE')!;
    if (field === 'text') { node.text = node.text.slice(1); node.layout.push({...node.textAssembly.parts[0], end: node.textAssembly.parts[0].start + 1}); node.textAssembly.parts[0].start++; }
    else node.channel = 'VO';
    assert.throws(() => makeEpisodeInput({episode: {id: 'ep', projectId: 'p', number: 1, content}, project: {id: 'p'}, handoff: {packet: {sourceText: content, ...reception}}}), /标准|回执|摘要/);
  }
});
check('saved standard rows remain bound to the package during later normalization', () => {
  const result = prepare();
  const copy = structuredClone(result.source);
  copy.sourceRows.find((r: any) => r.standard.kind === 'DIALOGUE').standard.channel = 'VO';
  delete copy.dialogue;
  assert.throws(() => normalizeSource(copy), /标准|绑定/);
});
check('root standard source cannot drop or reorder canonical rows', () => {
  for (const mutation of ['remove', 'reverse']) {
    const source = structuredClone(prepare().source);
    if (mutation === 'remove') source.sourceRows.splice(1, 1); else source.sourceRows.reverse();
    assert.throws(() => normalizeSource(source), /标准|覆盖|顺序/);
  }
});
check('saved dialogue cannot omit, duplicate or change the canonical cue', () => {
  for (const mutation of ['omit', 'duplicate', 'cue']) {
    const source = structuredClone(prepare().source);
    if (mutation === 'omit') source.dialogue = [];
    else if (mutation === 'duplicate') source.dialogue.push({...source.dialogue[0], id: 'forged'});
    else source.dialogue[0].cue = '愤怒大喊';
    assert.throws(() => normalizeSource(source), /标准|对白|提示/);
  }
});
check('authorized work-package slicing keeps complete dialogue and guidance but cannot become a full-episode plan', () => {
  const source = prepare(content + '情绪备注：保持克制。\n').source;
  const id = source.dialogue[0].rowId;
  const slice = sliceSource(source, [id]);
  assert.deepEqual(slice.dialogue, source.dialogue);
  assert(slice.contextRows.some((r: any) => r.evidenceRole === 'guidance'));
  assert.throws(() => buildRequest({stage: 'plan', source: slice, settings: {maxUnits: null, fantasyMode: 'off'}}), (error: any) => error.code === 'STANDARD_SCOPE');
  const missing = structuredClone(source); missing.contextRows = [];
  assert.throws(() => normalizeSource(missing), (error: any) => error.code === 'STANDARD_NOTE_COVERAGE');
});
check('model structure hints contain only exceptional ownership, not a second ordinary scene outline', () => {
  const table = scriptStructureTable(index, catalog, [1]);
  assert.equal(table.rows.length, 1);
  assert.deepEqual(table.rows[0].slice(0, 3), [1, 4, 6]);
  assert(!JSON.stringify(table).includes('钥匙放进'));
});
if (failures) process.exitCode = 1;
