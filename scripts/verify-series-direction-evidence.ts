import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readSeriesDirectionEvidence as read, type SeriesDirectionSourceUnit } from '../lib/series-direction-evidence';

const unit = (text = '前言。\n甲：我是乙的兄长。\n△档案落地。', changes: Partial<SeriesDirectionSourceUnit> = {}): SeriesDirectionSourceUnit => ({
  id: 'episode:e1/part-1-of-1', evidenceId: 'episode:e1', kind: 'EPISODE', title: '第一集', text,
  production: true, episodeId: 'e1', dialogueRanges: [{ start: 4, end: 14 }], ...changes,
});
const sample = (source = unit(), knowledge: Record<string, unknown> = {}): {
  coverage: string[]; summary: string; evidence: Array<{ unitId: string; quote: string; signal: string }>;
  knowledge: Array<Record<string, unknown>>;
} => ({
  coverage: [source.id], summary: '原文证据',
  evidence: [{ unitId: source.id, quote: source.text.slice(0, 12), signal: '关系主张' }],
  knowledge: [{ unitId: source.id, quote: '我是乙的兄长。', start: 6, kind: 'RELATIONSHIP', claim: 'SOURCE',
    statement: ' 甲自称乙的兄长。 ', subjects: ['甲', '乙', '甲'], ...knowledge }],
});
const rejects = (data: unknown, units = [unit()], code = 'DIRECTION_MODEL_EVIDENCE') => assert.throws(
  () => read(data, units), (error: unknown) => (error as { code?: string }).code === code,
);

test('unique verbatim quote corrects a wrong legacy coordinate without changing evidence meaning', () => {
  const source = unit(), data = sample(source, { start: 1135 }), before = structuredClone(data);
  const result = read(data, [source]);
  assert.equal(result.batch.knowledge?.[0].source.start, 6);
  assert.equal(result.batch.knowledge?.[0].source.quote, data.knowledge[0].quote);
  assert.equal(result.batch.knowledge?.[0].claim, 'CHARACTER_CLAIM');
  assert.deepEqual(result.batch.evidence, data.evidence);
  assert.deepEqual(data, before, 'model output stays unchanged for audit');
  assert.deepEqual(result.coordinateCorrections, [{ knowledgeIndex: 0, unitId: source.id,
    originalStart: { supplied: true, value: 1135 }, resolvedStart: 6, absoluteStart: 6, absoluteEnd: 13,
    reason: 'UNIQUE_EXACT_QUOTE' }]);
});

test('correct legacy positions preserve the exact old item hash and batch shape', () => {
  const result = read(sample(), [unit()]);
  assert.equal(result.batch.knowledge?.[0].id, 'e16df3a1ba58a1a068207d7781b822bae79f57d0b91dd0d37999b108240399ca');
  assert.deepEqual(result.batch.knowledge?.[0].subjects, ['甲', '乙']);
  assert.equal(result.batch.knowledge?.[0].statement, '甲自称乙的兄长。');
  assert.deepEqual(result.coordinateCorrections, []);
  assert.deepEqual(Object.keys(result.batch), ['coverage', 'summary', 'evidence', 'knowledge']);
});

test('unique quotes need no model offset and preserve invalid legacy hints in correction receipts', () => {
  for (const hint of [undefined, null, '6', 6.5, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const data = sample(unit(), { start: hint });
    if (hint === undefined) delete data.knowledge[0].start;
    const result = read(data, [unit()]);
    assert.equal(result.batch.knowledge?.[0].source.start, 6);
    assert.equal(result.coordinateCorrections.length, 1);
    assert.deepEqual(result.coordinateCorrections[0].originalStart,
      hint === undefined ? { supplied: false } : { supplied: true, value: hint });
  }
});

test('repeated quotes require an accurate integer hint, including overlapping occurrences', () => {
  const source = unit('aaaa', { dialogueRanges: [] });
  for (const start of [0, 1, 2]) {
    const result = read(sample(source, { quote: 'aa', start }), [source]);
    assert.equal(result.batch.knowledge?.[0].source.start, start);
    assert.deepEqual(result.coordinateCorrections, []);
  }
  for (const start of [undefined, null, '1', 1.5, -1, 3, Number.MAX_SAFE_INTEGER + 1]) {
    const data = sample(source, { quote: 'aa', start });
    if (start === undefined) delete data.knowledge[0].start;
    rejects(data, [source]);
  }
});

test('quotes cannot move to another unit or undergo whitespace, punctuation, or Unicode normalization', () => {
  const first = unit('这里没有引用。'), second = unit('我是乙的兄长。', { id: 'episode:e2/part-1-of-1', evidenceId: 'episode:e2', episodeId: 'e2' });
  const data = sample(first);
  data.coverage.push(second.id); data.evidence.push(sample(second).evidence[0]);
  rejects(data, [first, second]);
  rejects(sample(unit(), { unitId: 'episode:unknown' }));
  for (const quote of ['我是乙的兄长!', '我 是乙的兄长。', '我是乙的兄长。\n ']) rejects(sample(unit(), { quote }));
  const accented = unit('café', { dialogueRanges: [] });
  rejects(sample(accented, { quote: 'cafe\u0301' }), [accented]);
});

test('program UTF16 coordinates retain sourceOffset, astral characters, CRLF and quote whitespace', () => {
  const quote = ' 甲😀：秘密。\r\n', source = unit('😀前言\r\n' + quote + '后文', {
    sourceOffset: 100, dialogueRanges: [{ start: 107, end: 116 }],
  });
  const result = read(sample(source, { quote, start: 5 }), [source]), item = result.batch.knowledge![0];
  assert.equal(item.source.quote, quote);
  assert.equal(item.source.start, 106);
  assert.equal(item.source.end, 116);
  assert.equal(item.claim, 'CHARACTER_CLAIM');
  assert.equal(result.coordinateCorrections[0].resolvedStart, 6);
});

test('dialogue intersection downgrades SOURCE, never upgrades CHARACTER_CLAIM or bleeds across boundaries', () => {
  const source = unit('AAAABBBBCCCC', { sourceOffset: 20, dialogueRanges: [{ start: 24, end: 28 }] });
  for (const [quote, expected] of [['AAAA', 'SOURCE'], ['BBBB', 'CHARACTER_CLAIM'], ['CCCC', 'SOURCE'], ['AB', 'CHARACTER_CLAIM']] as const) {
    const result = read(sample(source, { quote, start: -99 }), [source]);
    assert.equal(result.batch.knowledge?.[0].claim, expected);
  }
  assert.equal(read(sample(source, { quote: 'AAAA', claim: 'CHARACTER_CLAIM', start: 0 }), [source]).batch.knowledge?.[0].claim, 'CHARACTER_CLAIM');
  const background = { ...source, production: false, kind: 'BACKGROUND' as const };
  assert.equal(read(sample(background, { quote: 'CCCC', start: 8 }), [background]).batch.knowledge?.[0].source.episodeId, null);
});

test('all knowledge survives coordinate correction while exact duplicates retain legacy deduplication', () => {
  const data = sample(), other = { ...data.knowledge[0], quote: '档案落地。', kind: 'CHANGE', claim: 'SOURCE', start: -5, statement: '档案落地。' };
  data.knowledge.push(other, { ...data.knowledge[0] });
  const result = read(data, [unit()]);
  assert.equal(result.batch.knowledge?.length, 2);
  assert.deepEqual(result.batch.knowledge?.map(item => item.source.quote), ['我是乙的兄长。', '档案落地。']);
  assert.equal(result.coordinateCorrections[0].knowledgeIndex, 1);
  const noIndex = sample() as Record<string, unknown>; delete noIndex.knowledge;
  assert(!Object.hasOwn(read(noIndex, [unit()]).batch, 'knowledge'));
  assert.deepEqual(read({ ...sample(), knowledge: [] }, [unit()]).batch.knowledge, []);
});

test('coverage, evidence multiplicity and unit-local evidence checks remain strict', () => {
  for (const data of [{ ...sample(), coverage: [] }, { ...sample(), coverage: [unit().id, unit().id] }, { ...sample(), evidence: [] }])
    rejects(data, [unit()], 'DIRECTION_MODEL_COVERAGE');
  rejects({ ...sample(), evidence: [{ ...sample().evidence[0], unitId: 'foreign' }] });
  rejects({ ...sample(), evidence: [{ ...sample().evidence[0], quote: '不存在的引文' }] });
  rejects({ ...sample(), evidence: [{ ...sample().evidence[0], signal: ' ' }] });
  rejects({ ...sample(), evidence: [{ ...sample().evidence[0], signal: '字'.repeat(101) }] });
  rejects({ ...sample(), evidence: [null] }, [unit()], 'DIRECTION_MODEL_OUTPUT');
  const second = unit('第二集', { id: 'episode:e2/part-1-of-1' }), duplicate = sample();
  duplicate.coverage.push(second.id); duplicate.evidence.push(duplicate.evidence[0]);
  rejects(duplicate, [unit(), second]);
});

test('existing schema and character-count limits are retained, with no truncation', () => {
  for (const data of [null, [], {}, { ...sample(), summary: ' ' }, { ...sample(), summary: '字'.repeat(901) }])
    rejects(data, [unit()], 'DIRECTION_MODEL_OUTPUT');
  for (const knowledge of [null, {}, Array.from({ length: 49 }, () => sample().knowledge[0])]) rejects({ ...sample(), knowledge });
  for (const change of [
    { quote: '' }, { quote: ' ' }, { quote: '字'.repeat(241) }, { kind: 'UNKNOWN' }, { claim: 'FACT' },
    { statement: '' }, { statement: '字'.repeat(241) }, { subjects: null }, { subjects: Array(9).fill('甲') },
    { subjects: [''] }, { subjects: [1] }, { subjects: ['字'.repeat(81)] },
  ]) rejects(sample(unit(), change));
  const source = unit('😀'.repeat(241), { dialogueRanges: [] });
  const data = sample(source, { quote: '😀'.repeat(240), start: 0, statement: '😀'.repeat(240), subjects: ['😀'.repeat(80)] });
  data.summary = '😀'.repeat(900); data.evidence[0].quote = '😀'.repeat(120); data.evidence[0].signal = '😀'.repeat(100);
  assert.equal(read(data, [source]).batch.knowledge?.[0].source.end, 480);
  data.evidence[0].quote += '😀'; rejects(data, [source]);
});
