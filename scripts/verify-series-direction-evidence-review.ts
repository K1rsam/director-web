import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { readSeriesDirectionEvidence, type SeriesDirectionSourceUnit } from '../lib/series-direction-evidence';

type Packet = { coverage: string[]; summary: string; evidence: Array<Record<string, unknown>>; knowledge?: Array<Record<string, unknown>>; [key: string]: unknown };
const text = '1-1 日 内 屋\n甲OS：我还没告诉乙。\n▲甲把信封放下。';
const units: SeriesDirectionSourceUnit[] = [{ id: 'episode:e1/part-1-of-1', evidenceId: 'episode:e1', kind: 'EPISODE', title: '第1集',
  text, production: true, episodeId: 'e1', sourceOffset: 100, dialogueRanges: [{ start: 100 + text.indexOf('甲OS'), end: 100 + text.indexOf('\n▲') }] }];
const packet = (): Packet => ({ coverage: [units[0].id], summary: '甲保留秘密。', evidence: [{ unitId: units[0].id, quote: '甲把信封放下。', signal: '原文动作', extra: { original: true } }],
  knowledge: [{ unitId: units[0].id, kind: 'RELATIONSHIP', claim: 'SOURCE', statement: '甲内心说尚未告诉乙。', subjects: ['甲', '乙'], quote: '我还没告诉乙。', start: text.indexOf('我还') }], metadata: { sourceVersion: 'keep-source-version', immutable: ['keep'] } });
const purpose = '逐字核对第1集OS原句与动作行，纠正误引及说法归属；不代表方向采用。';
async function validator() {
  assert.ok(existsSync(path.resolve('lib/series-direction-evidence-review.ts')), 'explicit source-review validation must exist before a saved response can be replaced');
  return (await import('../lib/series-direction-evidence-review')).validateSeriesDirectionEvidenceReview;
}
const hasCode = (code: string) => (error: unknown) => (error as { code?: string }).code === code;

test('an invalid original may receive only explicit permitted corrections with exact before/after receipts', async () => {
  const validate = await validator(), original = packet(), corrected = packet();
  original.evidence[0].quote = '甲把信封放下!'; original.evidence[0].signal = '待核动作';
  Object.assign(original.knowledge![0], { unitId: 'episode:e1/part-1-of-l', claim: 'SOURCE', statement: '甲已经告诉乙。', subjects: ['甲'], quote: '我已经告诉乙。', start: 999 });
  corrected.knowledge![0].claim = 'CHARACTER_CLAIM';
  const beforeOriginal = structuredClone(original), beforeCorrected = structuredClone(corrected);
  assert.throws(() => readSeriesDirectionEvidence(original, units), hasCode('DIRECTION_MODEL_EVIDENCE'));
  const result = validate(original, corrected, units, purpose);
  assert.deepEqual(result.data, corrected); assert.notEqual(result.data, corrected);
  assert.deepEqual(result.batch, readSeriesDirectionEvidence(corrected, units).batch);
  assert.equal(result.batch.knowledge?.[0].claim, 'CHARACTER_CLAIM');
  assert.deepEqual(result.changes.map(change => change.path).sort(), ['evidence[0].quote', 'evidence[0].signal', 'knowledge[0].unitId', 'knowledge[0].claim', 'knowledge[0].statement', 'knowledge[0].subjects', 'knowledge[0].quote', 'knowledge[0].start'].sort());
  assert.deepEqual(result.changes.find(change => change.path === 'knowledge[0].unitId'), { path: 'knowledge[0].unitId',
    before: { present: true, value: 'episode:e1/part-1-of-l' }, after: { present: true, value: units[0].id } });
  assert.deepEqual(original, beforeOriginal); assert.deepEqual(corrected, beforeCorrected);
  (result.data.evidence as Array<Record<string, unknown>>)[0].quote = 'caller mutation';
  assert.deepEqual(corrected, beforeCorrected, 'the returned data must not alias the submitted correction');
});

test('purpose is explicit and the validator never fabricates approval or authorization', async () => {
  const validate = await validator();
  for (const value of ['', ' \n ', null, 1]) assert.throws(() => validate(packet(), packet(), units, value as string), hasCode('DIRECTION_EVIDENCE_REVIEW'));
  const result = validate(packet(), packet(), units, purpose);
  assert.deepEqual(Object.keys(result).sort(), ['data', 'batch', 'coordinateCorrections', 'changes'].sort());
  assert.deepEqual(result.changes, []);
});

test('coverage, summary, root metadata and every non-allowlisted field remain unchanged', async () => {
  const validate = await validator();
  const edits: Array<(value: Packet) => void> = [
    value => { value.coverage = []; }, value => { value.summary += '新的结论'; },
    value => { value.approved = true; }, value => { delete value.metadata; },
    value => { (value.metadata as Record<string, unknown>).sourceVersion = 'changed'; },
    value => { value.evidence[0].unitId = 'foreign'; }, value => { value.evidence[0].future = true; },
    value => { delete value.evidence[0].extra; }, value => { (value.evidence[0].extra as Record<string, unknown>).original = false; },
    value => { value.knowledge![0].kind = 'CHANGE'; }, value => { value.knowledge![0].approved = true; },
  ];
  for (const edit of edits) { const corrected = packet(); edit(corrected); assert.throws(() => validate(packet(), corrected, units, purpose), hasCode('DIRECTION_EVIDENCE_REVIEW')); }
});

test('raw evidence and knowledge entries cannot be added, deleted, replaced by another shape or silently dropped', async () => {
  const validate = await validator();
  for (const key of ['evidence', 'knowledge'] as const) {
    for (const edit of [(value: Packet) => { value[key]!.push({ ...value[key]![0] }); }, (value: Packet) => { value[key]!.pop(); },
      (value: Packet) => { value[key]![0] = null as unknown as Record<string, unknown>; }]) {
      const corrected = packet(); edit(corrected); assert.throws(() => validate(packet(), corrected, units, purpose), hasCode('DIRECTION_EVIDENCE_REVIEW'));
    }
  }
  const missing = packet(); delete missing.knowledge;
  assert.throws(() => validate(packet(), missing, units, purpose), hasCode('DIRECTION_EVIDENCE_REVIEW'));
  assert.throws(() => validate(missing, packet(), units, purpose), hasCode('DIRECTION_EVIDENCE_REVIEW'));
  assert.deepEqual(validate(missing, missing, units, purpose).data, missing);
  for (const original of [null, [], {}, { ...packet(), knowledge: null }, { ...packet(), evidence: {} }])
    assert.throws(() => validate(original, packet(), units, purpose), hasCode('DIRECTION_EVIDENCE_REVIEW'));
});

test('SOURCE may become CHARACTER_CLAIM but an existing CHARACTER_CLAIM can never become SOURCE', async () => {
  const validate = await validator(), original = packet(), corrected = packet();
  corrected.knowledge![0].claim = 'CHARACTER_CLAIM';
  assert.equal(validate(original, corrected, units, purpose).batch.knowledge?.[0].claim, 'CHARACTER_CLAIM');
  assert.throws(() => validate(corrected, original, units, purpose), hasCode('DIRECTION_EVIDENCE_REVIEW'));
  const actionOriginal = packet(), actionCorrected = packet();
  for (const value of [actionOriginal, actionCorrected]) Object.assign(value.knowledge![0], { quote: '甲把信封放下。', start: text.indexOf('甲把'), statement: '甲放下信封。' });
  actionOriginal.knowledge![0].claim = 'CHARACTER_CLAIM';
  assert.throws(() => validate(actionOriginal, actionCorrected, units, purpose), hasCode('DIRECTION_EVIDENCE_REVIEW'), 'a changed non-dialogue anchor does not authorize upgrading an existing claim');
});

test('corrected data is revalidated as a complete batch, not just the edited fields', async () => {
  const validate = await validator();
  for (const edit of [
    (value: Packet) => { value.evidence[0].quote = '不存在的原文'; },
    (value: Packet) => { value.knowledge![0].unitId = 'foreign'; },
    (value: Packet) => { value.knowledge![0].quote = '我 还没告诉乙。'; },
    (value: Packet) => { value.knowledge![0].subjects = Array(9).fill('甲'); },
  ]) {
    const corrected = packet(); edit(corrected);
    assert.throws(() => validate(packet(), corrected, units, purpose), hasCode('DIRECTION_MODEL_EVIDENCE'));
  }
  const bothInvalid = packet(); bothInvalid.evidence[0].quote = '原包中的另一处未修错误';
  const correction = structuredClone(bothInvalid); correction.knowledge![0].statement = '甲内心仍未告诉乙。';
  assert.throws(() => validate(bothInvalid, correction, units, purpose), hasCode('DIRECTION_MODEL_EVIDENCE'));
});

test('optional start addition/removal has presence receipts and keeps independent coordinate-correction receipts', async () => {
  const validate = await validator(), withoutStart = packet(), withStart = packet();
  delete withoutStart.knowledge![0].start;
  const added = validate(withoutStart, withStart, units, purpose);
  assert.deepEqual(added.changes, [{ path: 'knowledge[0].start', before: { present: false }, after: { present: true, value: text.indexOf('我还') } }]);
  const removed = validate(withStart, withoutStart, units, purpose);
  assert.deepEqual(removed.changes, [{ path: 'knowledge[0].start', before: { present: true, value: text.indexOf('我还') }, after: { present: false } }]);
  assert.equal(removed.coordinateCorrections.length, 1); assert.equal(removed.batch.knowledge?.[0].source.start, 100 + text.indexOf('我还'));
  const wrong = packet(); wrong.knowledge![0].start = 999;
  const located = validate(withStart, wrong, units, purpose);
  assert.equal(located.data.knowledge && (located.data.knowledge as Array<Record<string, unknown>>)[0].start, 999, 'review data is not silently rewritten by the coordinate reader');
  assert.equal(located.coordinateCorrections[0].resolvedStart, text.indexOf('我还'));
});

test('unknown evidence metadata survives intact and semantic truth is not fabricated by structural review', async () => {
  const validate = await validator(), original = packet(), corrected = packet();
  original.knowledge![0].future = corrected.knowledge![0].future = { raw: ['keep', 7] };
  corrected.knowledge![0].statement = '此句是否充分概括引文仍须授权复核者判断。';
  const result = validate(original, corrected, units, purpose);
  assert.deepEqual(result.data, corrected);
  assert.deepEqual(result.changes.map(change => change.path), ['knowledge[0].statement']);
  assert.equal(result.batch.knowledge?.[0].claim, 'CHARACTER_CLAIM', 'the existing source reader still supplies conservative dialogue attribution');
  assert.equal(Object.hasOwn(result, 'approved'), false);
});
