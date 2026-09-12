import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildNumberedSource, buildSourceIndex, FoundationContractError, loadFoundationSystemPrompt } from '../lib/project-foundation-contracts';
import { requireProductionOptimization, type ProductionOptimization } from '../lib/foundation-production-contracts';
import { buildLightFoundationPrompt } from '../lib/foundation-production-prompts';
import { parseSceneBatch } from '../lib/source-parser';

const raw = '第7集\r\n7-1 日 内 地下室\r\n人物：甲\r\n  甲：抬头🙂。  \r\n△天空，云遮月。 \r\n\r\n7-2 夜 外 院子\r\n人物：乙\r\n乙：走。\r\n';
const index = buildSourceIndex([{ number: 7, title: null, content: raw }]);
const lines = buildNumberedSource(index, [7]).episodes[0].lines;
const lineBody = (line: number) => lines[line - 1][1].replace(/(?:\r\n|\r|\n)$/, '');
const cut = (startLine: number) => ({ startLine, anchor: lineBody(startLine) });
const wire = (cuts: unknown[]) => ({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [7], changes: { sceneSplits: [{ episode: 7, sceneKey: '7-1', cuts }] } });
const receive = (cuts: unknown[]) => requireProductionOptimization(wire(cuts), index, [7]);

for (const ending of ['\n', '\r\n', '\r']) {
  const value = wire([{ ...cut(4), anchor: `${lineBody(4)}${ending}` }]), before = structuredClone(value);
  let result: ProductionOptimization | undefined;
  assert.doesNotThrow(() => { result = requireProductionOptimization(value, index, [7]); }, 'one terminal line ending is transport syntax, not a source-text change');
  assert.equal(result!.changes.sceneSplits![0].cuts[0].anchor, lineBody(4), 'emoji and leading/trailing spaces remain exact');
  assert.deepEqual(value, before, 'the provider response is never mutated');
}

const multiple = wire([1, 4, 5].map(startLine => ({ startLine, anchor: lines[startLine - 1][1] })));
multiple.changes.sceneSplits.push({ episode: 7, sceneKey: '7-2', cuts: [7, 8, 9].map(startLine => ({ startLine, anchor: lines[startLine - 1][1] })) });
const multipleBefore = structuredClone(multiple);
assert.deepEqual(requireProductionOptimization(multiple, index, [7]).changes.sceneSplits!.flatMap(plan => plan.cuts.map(item => item.anchor)), [1, 4, 5, 7, 8, 9].map(lineBody), 'all anchors normalize in one pure reception, without a repair call');
assert.deepEqual(multiple, multipleBefore);
assert.equal(receive([cut(4)]).changes.sceneSplits![0].cuts[0].anchor, lineBody(4), 'an already canonical anchor is unchanged');

for (const anchor of ['', '  ', null, 4, lineBody(4).trim(), lineBody(4).trimStart(), lineBody(4).trimEnd(), lineBody(4).slice(0, -3), lineBody(5), `${lineBody(4)}\n\n`, `${lineBody(4)}\r\n\r\n`, `${lineBody(4)}\n第二行`]) {
  assert.throws(() => receive([{ startLine: 4, anchor }]), (error: unknown) => error instanceof FoundationContractError && error.issues[0].coordinate === 'changes.sceneSplits.0.cuts.0.anchor', 'blank, partial, altered-space, wrong-line and multiline anchors are rejected');
}
assert.throws(() => receive([{ startLine: 100, anchor: lineBody(4) }]), FoundationContractError);
assert.throws(() => requireProductionOptimization(wire([cut(4)]), { ...index, version: 'stale' }, [7]), /版本/);
assert.throws(() => requireProductionOptimization({ ...wire([cut(4)]), changes: { sceneSplits: [{ episode: 7, sceneKey: '7-1', sourceHash: 'stale', cuts: [cut(4)] }] } }, index, [7]), /版本/);
assert.throws(() => requireProductionOptimization({ ...wire([cut(4)]), changes: { sceneSplits: [{ episode: 8, sceneKey: '8-1', cuts: [cut(4)] }] } }, index, [7]), FoundationContractError);

console.log('PASS light scene edit anchor normalization');

assert.doesNotThrow(() => requireProductionOptimization({ format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [7], changes: { scenes: [{ episode: 7, sceneKey: '7-1', timeLayer: '现实' }] } }, index, [7]), 'first-segment timeLayer must remain a valid scene patch');

async function verifySceneNormalization() {
  assert.ok(existsSync(join(process.cwd(), 'lib/light-scene-edit-normalization.ts')), 'a pure first-segment scene normalizer is required');
  const { normalizeLightSceneEdit } = await import('../lib/light-scene-edit-normalization');
  const secondStart = raw.indexOf('7-2 夜 外 院子');
  const scenes = [{ episode: 7, sceneKey: '7-1', sourceRange: { start: 0, end: secondStart } }, { episode: 7, sceneKey: '7-2', sourceRange: { start: secondStart, end: raw.length } }];
  const leading = { ...cut(1), location: '地下室', interiorExterior: '内', timeOfDay: '日', timeLayer: '现实' };
  const output = receive([leading, { ...cut(4), location: '地下室' }, { ...cut(5), location: '天空', interiorExterior: '外', timeLayer: '现实' }]);
  output.changes.scenes = [{ episode: 7, sceneKey: '7-1', location: '地下室', weather: '雨', characters: ['甲'] }, { episode: 7, sceneKey: '7-2', location: '院子' }];
  output.changes.assets = [{ name: '天空', type: 'LOC', episodes: [7], sceneRefs: [{ episode: 7, sceneKey: '7-1__L5' }], variants: [{ name: '云层', episodes: [7], sceneRefs: [{ episode: 7, sceneKey: '7-1__L1' }] }] }];
  const before = structuredClone(output), normalized = normalizeLightSceneEdit(output, index, scenes);
  assert.deepEqual(output, before, 'normalization never mutates the accepted response');
  assert.notEqual(normalized, output);
  assert.notEqual(normalized.changes.assets, output.changes.assets, 'unmodified nested fields are cloned too');
  assert.deepEqual(normalized.changes.scenes, [{ episode: 7, sceneKey: '7-1', location: '地下室', weather: '雨', characters: ['甲'], interiorExterior: '内', timeOfDay: '日', timeLayer: '现实' }, { episode: 7, sceneKey: '7-2', location: '院子' }], 'all first-segment metadata merges without clearing explicit scene fields');
  assert.deepEqual(normalized.changes.sceneSplits![0].cuts, before.changes.sceneSplits![0].cuts.slice(1), 'only the redundant first cut is removed');
  assert.deepEqual(normalized.changes.assets, before.changes.assets, 'asset and variant references are never silently invented or rewritten');
  assert.deepEqual(normalizeLightSceneEdit(normalized, index, scenes), normalized, 'normalization is idempotent');
  assert.deepEqual(requireProductionOptimization(normalized, index, [7]).changes.scenes, normalized.changes.scenes, 'normalized timeLayer survives ordinary contract rereading');

  const later = receive([cut(4)]), laterBefore = structuredClone(later);
  later.changes.sceneSplits![0] = { ...later.changes.sceneSplits![0], sceneKey: '7-2', cuts: [{ ...cut(7), location: '院子', timeLayer: '回忆' }, cut(9)] };
  const laterResult = normalizeLightSceneEdit(later, index, scenes);
  assert.deepEqual(laterResult.changes.scenes, [{ episode: 7, sceneKey: '7-2', location: '院子', timeLayer: '回忆' }], 'a scene beginning after CRLF and emoji uses its actual JS source offset, not line 1 or Unicode code-point length');
  assert.deepEqual(laterResult.changes.sceneSplits![0].cuts, [cut(9)]);
  assert.deepEqual(normalizeLightSceneEdit(laterBefore, index, scenes), laterBefore, 'strictly interior first cuts need no compatibility rewrite');

  const metadataOnly = normalizeLightSceneEdit(receive([leading]), index, scenes);
  assert.equal(metadataOnly.changes.sceneSplits, undefined, 'a one-entry plan becomes an ordinary existing-scene patch');
  assert.deepEqual(metadataOnly.changes.scenes, [{ episode: 7, sceneKey: '7-1', location: '地下室', interiorExterior: '内', timeOfDay: '日', timeLayer: '现实' }]);
  const noop = receive([cut(1)]);
  noop.unresolved = [{ owner: 'PROGRAM', episodes: [7], note: '仍需真实拆场计划' }];
  const noopResult = normalizeLightSceneEdit(noop, index, scenes);
  assert.deepEqual(noopResult.changes, {}, 'a leading entry without fields is only a no-op');
  assert.deepEqual(noopResult.unresolved, noop.unresolved);
  assert.deepEqual(noopResult.resolvedUnresolved, [], 'a no-op never fabricates a PROGRAM completion receipt');

  for (const field of ['location', 'interiorExterior', 'timeOfDay', 'timeLayer'] as const) {
    const conflict = receive([leading, cut(4)]);
    conflict.changes.scenes = [{ episode: 7, sceneKey: '7-1', [field]: '不同值' }];
    assert.throws(() => normalizeLightSceneEdit(conflict, index, scenes), (error: unknown) => error instanceof FoundationContractError && error.issues[0].coordinate === `changes.scenes.0.${field}`, `conflicting explicit ${field} values must not select a winner`);
  }

  assert.throws(() => normalizeLightSceneEdit(output, index, []), /sceneKey/);
  assert.throws(() => normalizeLightSceneEdit(output, index, [scenes[0], scenes[0]]), /sceneKey/);
  for (const sourceRange of [{ start: -1, end: secondStart }, { start: 0, end: raw.length + 1 }, { start: 0, end: 0 }, { start: 0.5, end: secondStart }]) {
    assert.throws(() => normalizeLightSceneEdit(output, index, [{ ...scenes[0], sourceRange }]), /sourceRange/);
  }
  const early = receive([cut(4), cut(9)]);
  early.changes.sceneSplits![0].sceneKey = '7-2';
  assert.throws(() => normalizeLightSceneEdit(early, index, scenes), /cuts\.0\.startLine/, 'an earlier line is not the second scene beginning');
  const outside = receive([cut(7)]);
  assert.throws(() => normalizeLightSceneEdit(outside, index, scenes), /cuts\.0\.startLine/, 'the next scene beginning is not an interior cut');
  const badAnchor = receive([leading]);
  badAnchor.changes.sceneSplits![0].cuts[0].anchor = lineBody(4);
  assert.throws(() => normalizeLightSceneEdit(badAnchor, index, scenes), /cuts\.0\.anchor/);
  const badHash = receive([cut(4)]);
  badHash.changes.sceneSplits![0].sourceHash = 'stale';
  assert.throws(() => normalizeLightSceneEdit(badHash, index, scenes), /sourceHash/);
  assert.throws(() => normalizeLightSceneEdit(output, { ...index, version: 'stale' }, scenes), /版本/);
  const unknownSource = receive([cut(4)]);
  unknownSource.changes.sceneSplits![0].episode = 8;
  assert.throws(() => normalizeLightSceneEdit(unknownSource, index, scenes), /episode/);
  assert.throws(() => normalizeLightSceneEdit(output, index, [{ ...scenes[0], sourceRange: { start: 1, end: secondStart } }]), /cuts\.0\.startLine/, 'a partial source line is not rounded into a valid scene beginning');
  for (const cuts of [[leading, cut(5), cut(4)], [leading, cut(7)], [leading, cut(4), cut(4)]]) {
    const checked = normalizeLightSceneEdit(receive(cuts), index, scenes);
    assert.deepEqual(checked.changes.sceneSplits![0].cuts, cuts.slice(1), 'non-first cuts are neither reordered nor removed');
    assert.throws(() => parseSceneBatch([{ number: 7, content: raw }], checked.changes.sceneSplits), /split|line|原文/i, 'invalid remaining cuts still fail strict downstream boundary validation');
  }
  console.log('PASS light scene edit first-segment normalization');
  for (const prompt of [buildLightFoundationPrompt('Q1', {}), loadFoundationSystemPrompt('Q1')]) {
    assert.ok(/不含行尾换行/.test(prompt), 'Q1 must request canonical line bodies');
    assert.ok(/首尾空格/.test(prompt), 'source whitespace must stay exact');
    assert.ok(/首段.*changes\.scenes/.test(prompt), 'existing first-segment metadata belongs to changes.scenes');
    assert.ok(/严格.*内部/.test(prompt), 'cuts contain only additional strict interior boundaries');
    assert.ok(/timeLayer/.test(prompt), 'all existing cut metadata remains expressible on the first segment');
  }
  console.log('PASS light scene edit prompt boundary contract');
}

verifySceneNormalization().catch(error => { console.error(error); process.exitCode = 1; });
