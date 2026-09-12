import assert from 'node:assert/strict';
import { buildSourceIndex, mergeF1Outputs, requireF1Output } from '@/lib/project-foundation-contracts';
import { mergeProductionCatalogs, requireProductionCatalogAuthor, requireProductionOptimization } from '@/lib/foundation-production-contracts';
import { buildProductionFoundationPrompt, PRODUCTION_OUTPUT_SCHEMAS } from '@/lib/foundation-production-prompts';
import { mergeHumanChoices, normalizeDecisionKey, readHumanChoices } from '@/lib/foundation-human-choices';

const source = buildSourceIndex([
  { number: 0, title: '序', content: '林川召出青麟，二者并肩站着。\n角色说明却写青麟是林川的变身，仅有一个身体。' },
  { number: 1, title: '后续', content: '青麟与林川的身份关系仍沿用前述设定。' },
]);
const choice = {
  decisionKey: '林川与青麟/身体关系', kind: 'SOURCE_CONFLICT',
  question: '林川和青麟按哪种身份关系准备资产？',
  reason: '原文同时写两个主体并肩、又明确只有一个身体；两种口径互斥且不能由现有材料判定。',
  options: ['两个独立主体，保留契约关联', '同一主体的变身形态，不按两个独立身体处理'],
  recommended: '两个独立主体，保留契约关联', recommendationReason: '与明确的并肩动作一致；保留另一处原文冲突，不修改原文。',
  evidence: '序：二者并肩站着；角色说明：仅有一个身体。', episodes: [0],
};
const f1 = (number: number) => ({ coverage: [number], overview: '简明导航', episodes: [{ number, summary: '保留原文的身份冲突', context: '', sourceSelections: [] }], issues: [] });
const first = requireF1Output({ ...f1(0), humanChoices: [choice] }, source, [0]);
assert.equal((first as any).humanChoices?.[0].recommended, choice.recommended, 'F1 must retain a necessary user choice with its recommendation');
const f2wire = { format: 'ASSET_CATALOG_V2', coverage: [0], assets: [{ name: '林川', type: 'CH', episodes: [0], preparation: { mode: 'REFERENCE' } }], humanChoices: [choice] };
const f2 = requireProductionCatalogAuthor(f2wire, source, [0]);
assert.deepEqual((f2 as any).humanChoices, [choice]);
const q1wire = { format: 'FOUNDATION_OPTIMIZATION_V2', coverage: [0], changes: {}, humanChoices: [choice] };
assert.deepEqual((requireProductionOptimization(q1wire, source, [0]) as any).humanChoices, [choice]);

const later = { ...choice, episodes: [1], evidence: '后续仍沿用相同设定。', question: '相同议题的另一种问法' };
const mergedF1 = mergeF1Outputs([first, requireF1Output({ ...f1(1), humanChoices: [later] }, source, [1])], source, [0, 1]) as any;
assert.equal(mergedF1.humanChoices.length, 1);
assert.deepEqual(mergedF1.humanChoices[0].episodes, [0, 1]);
assert.equal(mergedF1.humanChoices[0].question, choice.question);
assert.match(mergedF1.humanChoices[0].evidence, /后续/);
const mergedF2 = mergeProductionCatalogs([f2, requireProductionCatalogAuthor({ ...f2wire, coverage: [1], assets: [], humanChoices: [later] }, source, [1])], source, [0, 1]) as any;
assert.equal(mergedF2.humanChoices.length, 1);
assert.deepEqual(mergedF2.humanChoices[0].episodes, [0, 1]);

for (const invalid of [
  { ...choice, options: ['只有一个方案'] },
  { ...choice, options: ['A', 'B', 'C', 'D'] },
  { ...choice, options: ['相同', ' 相同 '] },
  { ...choice, recommended: '并不存在的推荐' },
  { ...choice, reason: '' },
  { ...choice, kind: 'MODEL_FORMAT_ERROR' },
  { ...choice, episodes: [1] },
  { ...choice, options: [17, '另一方案'] },
]) {
  assert.throws(() => requireF1Output({ ...f1(0), humanChoices: [invalid] }, source, [0]), /humanChoices/);
  assert.throws(() => requireProductionCatalogAuthor({ ...f2wire, humanChoices: [invalid] }, source, [0]), /humanChoices/);
  assert.throws(() => requireProductionOptimization({ ...q1wire, humanChoices: [invalid] }, source, [0]), /humanChoices/);
}
for (const absent of [undefined, null, []]) {
  assert.equal((requireF1Output({ ...f1(0), humanChoices: absent }, source, [0]) as any).humanChoices, undefined);
  assert.equal((requireProductionCatalogAuthor({ ...f2wire, humanChoices: absent }, source, [0]) as any).humanChoices, undefined);
  assert.equal((requireProductionOptimization({ ...q1wire, humanChoices: absent }, source, [0]) as any).humanChoices, undefined);
}
const ordinary = requireProductionOptimization({ ...q1wire, humanChoices: undefined, unresolved: [{ note: '派生来源资料仍需修正' }] }, source, [0]);
assert.equal((ordinary as any).humanChoices, undefined, 'unresolved is not automatically a human question');
const inputBefore = structuredClone({ f2wire, q1wire });
requireProductionCatalogAuthor(f2wire, source, [0]); requireProductionOptimization(q1wire, source, [0]);
assert.deepEqual({ f2wire, q1wire }, inputBefore);
assert.equal(mergeHumanChoices([[first.humanChoices![0]], [{ ...first.humanChoices![0], decisionKey: '另一人物/身体关系' }]]).length, 2);
assert.equal(normalizeDecisionKey(' ＰＲＯＪＥＣＴ ／ 取舍 '), normalizeDecisionKey('project/取舍'));
assert.notEqual(normalizeDecisionKey('reference/Ann A'), normalizeDecisionKey('reference/Anna'), 'normalization must not concatenate distinct subject names');
assert.equal(readHumanChoices([{ ...choice, decisionKey: 'reference/Ann A' }, { ...choice, decisionKey: 'reference/Anna', question: '另一人物的独立选择', episodes: [1] }], [0, 1]).length, 2);
assert.equal(mergeHumanChoices([[first.humanChoices![0]], [{ ...first.humanChoices![0], episodes: [] }]]).length, 2, '未知范围不得吞并已知范围为全剧');
assert.throws(() => readHumanChoices('错误结构', [0]), /humanChoices/);
const frozen = Object.freeze({ ...choice, options: Object.freeze([...choice.options]), episodes: Object.freeze([0]) });
assert.deepEqual(readHumanChoices(Object.freeze([frozen]), [0]), [choice]);
assert.deepEqual(readHumanChoices([{ ...choice, episodes: ['0'] }], [0])[0].episodes, [0], 'choice episode spelling follows existing integer-string compatibility');
assert.throws(() => readHumanChoices([{ ...choice, episodes: ['0.0'] }], [0]), /episodes/);
for (const stage of ['F1', 'F2', 'Q1'] as const) {
  assert.ok('humanChoices' in PRODUCTION_OUTPUT_SCHEMAS[stage], `${stage} must declare the optional human-choice envelope`);
  const prompt = buildProductionFoundationPrompt(stage, { humanChoiceRegistry: [{ decisionKey: choice.decisionKey, status: 'CONFIRMED', answer: choice.options[0] }] });
  assert.match(prompt, /humanChoiceRegistry/);
  assert.match(prompt, /推荐不当确认/);
  assert.match(prompt, /同议题同适用范围合并一次/);
}
console.log('PASS optional human choices: three-role contracts, same-decision merging, recommendations, nil compatibility, source scope and immutable input (not model judgement)');
