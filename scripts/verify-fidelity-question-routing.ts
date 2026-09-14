import assert from 'node:assert/strict';
import { normalize } from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import { routeFidelityQuestions } from '../lib/fidelity-question-routing';
import type { FidelityResult, FidelityDecision } from '../lib/fidelity-import';
import type { P1ReviewState } from '../lib/fidelity-p1-review';
const parse = (text: string, decisions: FidelityDecision[] = []) => normalize(text, { decisions }) as FidelityResult;
const state = (start: number, end: number, note = '集号跳号，是否缺少一集？'): P1ReviewState => ({ status: 'PENDING', unresolved: [{ start, end, note, kind: 'structure' }] });
const route = (value: P1ReviewState, result: FidelityResult) => routeFidelityQuestions(value, result).unresolved![0] as NonNullable<P1ReviewState['unresolved']>[number] & { routing?: { kind: string; basis: string; sourceVersion: string } };
const text = '第1集\r\n场1-1 日 外 门口\r\n甲乙：来了。😀\r\n第3集\r\n场3-1 夜 内 大厅\r\n甲乙：回来了。\r\n';
const result = parse(text), original = structuredClone(result), question = state(0, text.length), questionBefore = structuredClone(question);
const routed = route(question, result);
assert.deepEqual(routed.routing, { kind: 'QUESTION', basis: 'EXPLICIT_SOURCE_OWNERSHIP', sourceVersion: result.source.sourceVersion });
assert.equal(routed.kind, 'structure'); assert.equal(routed.note, question.unresolved![0].note);
assert.deepEqual(result, original); assert.deepEqual(question, questionBefore);
assert.deepEqual(result.episodes.map(episode => episode.sourceNumber), ['1', '3'], 'routing never invents the absent source episode');
const laterLine = text.indexOf('甲乙：回来了。');
assert.equal(route(state(laterLine, text.length, '跨批开头是否沿用第三集场号？'), result).routing?.kind, 'QUESTION', 'the whole-source independent baseline proves scene ownership outside the local batch');
assert.equal(route(state(0, '第1集\r\n'.length), result).routing?.kind, 'QUESTION', 'a standalone title may inherit its own independently explicit episode structure');
const namedHeading = '第 60 集 中举解元・鹿鸣宴首座\n\n60-1\n日 外 门口\n甲乙：来了。\n';
assert.equal(route(state(0, namedHeading.length), parse(namedHeading)).routing?.kind, 'QUESTION', 'a short standalone episode title uses independently proven scenes from the same episode');
for (const title of ['甲乙：这是正文', '△甲乙走进门口', '甲乙走进门口。', '“甲乙来了”', '场60-1', '第1场', '60-1', '长剧情'.repeat(21)]) {
  const raw = `第 60 集 ${title}\n\n60-1\n日 外 门口\n甲乙：来了。\n`;
  assert.equal(route(state(0, raw.length), parse(raw)).routing, undefined, `mixed/narrative episode title must not pass: ${title}`);
}
for (const raw of ['第1集\n甲乙：缺少场界。\n', '第1集\n场2-1 日 外 门口\n甲乙：错集。\n', '甲乙：没有集场。\n', '第1集 甲乙：这是正文。\n']) {
  const parsed = parse(raw); assert.equal(route(state(0, raw.length), parsed).routing, undefined, raw);
}
const aiOnly = '甲乙：没有独立集场证据。\n';
const aiResult = parse(aiOnly, [{ start: 0, end: aiOnly.length, kind: 'body', episodeNumber: 1, sceneNumber: 1, note: '模型决定，不能作为独立原文证据' }]);
assert.equal(aiResult.validation.issues.length, 0);
assert.equal(route(state(0, aiOnly.length), aiResult).routing, undefined);
for (const [start, end] of [[1, text.length], [0, text.length + 1], [-1, text.length], [0, 0], [text.length, 0], [NaN, text.length]]) assert.equal(route(state(start, end), result).routing, undefined, 'invalid/partial-line ranges stay structural blockers');
const moved = structuredClone(result); moved.segments.find(segment => segment.kind === 'body')!.episodeId = 'different-episode';
assert.equal(route(question, moved).routing, undefined);
const lowered = structuredClone(result); lowered.segments.find(segment => segment.kind === 'body')!.kind = 'format';
assert.equal(route(question, lowered).routing, undefined, 'source body cannot be hidden as formatting');
const splitHeaderText = '第60集\n60-1\n日 外 门口\n甲乙：来了。\n第62集\n62-1\n夜 内 大厅\n甲乙：回来了。\n';
const splitBaseline = parse(splitHeaderText);
const splitDecisions = [
  { start: splitHeaderText.indexOf('60-1'), end: splitHeaderText.indexOf('第62集'), kind: 'body' as const, note: '保留已采用整场正文决定' },
  { start: splitHeaderText.indexOf('62-1'), end: splitHeaderText.length, kind: 'body' as const, note: '保留已采用整场正文决定' },
];
const splitAdopted = parse(splitHeaderText, splitDecisions);
assert.ok(splitBaseline.segments.some(segment => segment.reason === 'continued_scene_metadata'));
assert.ok(splitBaseline.segments.some(segment => segment.kind === 'format' && segment.sceneId && splitAdopted.segments.find(actual => actual.start === segment.start)?.kind === 'body'));
assert.equal(route(state(0, splitHeaderText.length), splitAdopted).routing?.kind, 'QUESTION', 'explicit scene numbers and separate metadata may be promoted to body without losing source ownership');
assert.equal(splitAdopted.segments.map(segment => segment.text).join(''), splitHeaderText);
const promotedTitle = structuredClone(result); promotedTitle.segments[0].kind = 'body';
assert.equal(route(question, promotedTitle).routing, undefined, 'a pure episode heading without scene ownership cannot be promoted through the scene-format exception');
const hiddenBody = structuredClone(result); hiddenBody.segments.find(segment => segment.kind === 'body')!.productionEligible = false;
assert.equal(route(question, hiddenBody).routing, undefined, 'source body cannot be made non-production while retaining its body label');
const wrongScene = structuredClone(result); wrongScene.segments.find(segment => segment.kind === 'body')!.sceneId = 'different-scene';
assert.equal(route(question, wrongScene).routing, undefined);
const stale = { ...question, unresolved: [{ ...routed }] };
assert.equal(route(stale, moved).routing, undefined, 'old routing is cleared when final adopted ownership no longer matches');
const corruptSource = structuredClone(result); corruptSource.source.sourceVersion = 'wrong';
assert.equal(route(stale, corruptSource).routing, undefined);
const semantic = { ...question, unresolved: [{ ...question.unresolved![0], kind: 'semantic' as const }] };
assert.equal(route(semantic, result).kind, 'semantic');
assert.equal(route(semantic, result).routing, undefined);
assert.equal(result.segments.map(segment => segment.text).join(''), text);
console.log('PASS independent source ownership routes numbering/cross-batch questions; no missing episodes invented; absent/conflicting/AI-only ownership, invalid ranges and body downgrade remain blocked; original state/source immutable');
