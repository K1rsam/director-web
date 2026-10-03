import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { DirectionSourceUnit, DirectionSourcePart } from '../lib/series-direction-source';

const require = createRequire(import.meta.url);
const modulePath = fileURLToPath(new URL('../lib/series-direction-source.ts', import.meta.url));
function api(): typeof import('../lib/series-direction-source') {
  assert.ok(existsSync(modulePath), 'missing pure direction-source preparation behavior');
  return require(modulePath);
}
const unit = (id: string, text: string, fields: Partial<DirectionSourceUnit> = {}): DirectionSourceUnit => ({
  id, evidenceId: `evidence:${id}`, kind: 'BACKGROUND', title: `来源 ${id}`, text, production: false, ...fields,
});
const episode = (number: number, text = `正文${number}`) => unit(`episode:${number}`, text, {
  kind: 'EPISODE', title: `第${number}集 · 场景`, production: true, episodeId: `ep-${number}`,
});
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
// Frozen old split semantics: codepoint pieces, UTF16 offsets, and original part IDs.
function legacyParts(units: readonly DirectionSourceUnit[]): DirectionSourcePart[] {
  return units.flatMap(value => {
    const chars = Array.from(value.text), count = Math.max(1, Math.ceil(chars.length / 24_000));
    return Array.from({ length: count }, (_, index) => ({ ...value, id: `${value.id}/part-${index + 1}-of-${count}`,
      sourceOffset: chars.slice(0, index * 24_000).join('').length, text: chars.slice(index * 24_000, (index + 1) * 24_000).join('') }));
  });
}
function legacyBatches(parts: DirectionSourcePart[]) {
  const batches: DirectionSourcePart[][] = [];
  for (const part of parts) {
    const last = batches.at(-1);
    if (!last || last.length >= 6 || last.reduce((sum, item) => sum + item.text.length, 0) + part.text.length > 24_000) batches.push([part]);
    else last.push(part);
  }
  return batches;
}

test('packs semantic units by UTF16 capacity, not a six-unit quota', () => {
  const units = Array.from({ length: 10 }, (_, index) => episode(index + 1, '正文'.repeat(100)));
  assert.equal(legacyBatches(legacyParts(units)).length, 2);
  const result = api().prepareDirectionSource(units);
  assert.equal(result.batches.length, 1);
  assert.equal(result.batches[0].length, 10);
  assert.deepEqual(result.allParts, legacyParts(units));
  assert.deepEqual(result.programRecords, []);
});

test('only complete known episode headers and whitespace receive auditable PROGRAM coverage', () => {
  const units = [episode(1), episode(2), unit('header', ' \r\n第 2 集\r\n\r\n第2集\n'), unit('space', '\r\n \t\n')];
  const result = api().prepareDirectionSource(units);
  assert.equal(result.batches.flat().length, 2);
  assert.deepEqual(result.programRecords.map(record => record.reason), ['EPISODE_HEADER_ONLY', 'WHITESPACE_ONLY']);
  for (const record of result.programRecords) {
    const part = result.allParts.find(part => part.id === record.unitId)!;
    assert.equal(record.evidenceId, part.evidenceId);
    assert.equal(record.text, part.text);
    assert.equal(record.textHash, hash(part.text));
    assert.equal(record.sourceOffset, part.sourceOffset);
    assert.equal('signal' in record || 'knowledge' in record || 'claim' in record, false);
  }
});

test('explicit episode numbers override title inference without treating unknown headers as disposable', () => {
  const units = [episode(1), unit('one', '第1集'), unit('two', '第2集'), unit('unknown', '第999集')];
  const result = api().prepareDirectionSource(units, { episodeNumbers: [2] });
  assert.deepEqual(result.programRecords.map(record => record.unitId), ['two/part-1-of-1']);
  assert.equal(result.batches.flat().length, 3);
  assert.throws(() => api().prepareDirectionSource(units, { episodeNumbers: [2, 2] }));
  assert.throws(() => api().prepareDirectionSource(units, { episodeNumbers: [NaN] }));
});

test('unknown metadata, body text, colon content and other source kinds remain in model input', () => {
  const retained = [episode(1, '第1集'), unit('body', '第1集\n他来了。'), unit('colon', '第1集：'),
    unit('joined', '第1集第1集'), unit('future', '第1集', { future: { statement: '必须保留的未知内容' } }),
    unit('interpretation', '第1集', { interpretations: [{ line: 1, kind: 'ACTION' }] }),
    unit('unresolved', ' \n', { kind: 'UNRESOLVED' }), unit('unknown-kind', '第1集', { kind: 'FUTURE' }),
    unit('production', '第1集', { production: true }), unit('unknown-number', '第2集')];
  const result = api().prepareDirectionSource(retained);
  assert.deepEqual(result.programRecords, []);
  assert.deepEqual(result.batches.flat().map(part => part.id), legacyParts(retained).map(part => part.id));
});

test('part IDs, codepoint splits and UTF16 offsets preserve the complete source and extra metadata', () => {
  const units = [episode(1, '甲'.repeat(24_000) + '😀尾'), unit('background', '作者背景', { future: { rows: ['原始证据'] } })];
  const before = structuredClone(units), result = api().prepareDirectionSource(units);
  assert.deepEqual(result.allParts, legacyParts(units));
  assert.deepEqual(result.allParts.slice(0, 2).map(part => part.sourceOffset), [0, 24_000]);
  assert.equal(result.allParts.slice(0, 2).map(part => part.text).join(''), units[0].text);
  assert.equal(result.batches.length, 2);
  (result.allParts[2].future as { rows: string[] }).rows[0] = '只改变返回副本';
  assert.deepEqual(units, before);
});

test('accepted exact IDs are never rebought or double-recorded; unknown and duplicate IDs fail closed', () => {
  const units = [episode(1), episode(2), unit('title', '第2集')], parts = legacyParts(units);
  const result = api().prepareDirectionSource(units, { alreadyCovered: [parts[0].id, parts[2].id] });
  assert.deepEqual(result.allParts.map(part => part.id), parts.map(part => part.id));
  assert.deepEqual(result.batches.flat().map(part => part.id), [parts[1].id]);
  assert.deepEqual(result.programRecords, []);
  assert.throws(() => api().prepareDirectionSource(units, { alreadyCovered: ['episode:1'] }));
  assert.throws(() => api().prepareDirectionSource(units, { alreadyCovered: [parts[0].id, parts[0].id] }));
  assert.throws(() => api().prepareDirectionSource([units[0], units[0]]));
  assert.throws(() => api().prepareDirectionSource([unit('invalid', '第1集', { production: undefined as unknown as boolean })]));
});

test('oversize UTF16 singleton does not change old parts, raise the limit or silently truncate', () => {
  const units = [episode(1, '😀'.repeat(24_000))], before = structuredClone(units);
  assert.throws(() => api().prepareDirectionSource(units), (error: unknown) => (error as { code?: string }).code === 'DIRECTION_SOURCE_PART_BUDGET');
  assert.deepEqual(units, before);
});

test('actual saved 61 units need three total calls, or two new calls after the first twelve accepted parts', {
  skip: !process.env.DIRECTION_SOURCE_SAVED_DB,
}, () => {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.env.DIRECTION_SOURCE_SAVED_DB!, { readOnly: true });
  try {
    const row = db.prepare("SELECT content FROM SceneSnapshot WHERE sceneKey='SERIES_DIRECTION_MODEL_INPUT' ORDER BY createdAt DESC LIMIT 1").get() as { content: string };
    const saved = JSON.parse(row.content) as { units: DirectionSourceUnit[] }, before = JSON.stringify(saved);
    assert.equal(saved.units.length, 61);
    const old = legacyBatches(legacyParts(saved.units));
    assert.equal(old.length, 11);
    const result = api().prepareDirectionSource(saved.units, { episodeNumbers: Array.from({ length: 30 }, (_, index) => index + 1) });
    assert.deepEqual(result.allParts, old.flat());
    assert.equal(result.batches.length + 1, 3, 'two evidence calls plus one synthesis call');
    assert.equal(result.programRecords.length, 30);
    assert.equal(result.programRecords.reduce((sum, item) => sum + item.text.length, 0), 388);
    assert.equal(result.programRecords.filter(item => item.reason === 'WHITESPACE_ONLY').length, 1);
    const alreadyCovered = old.slice(0, 2).flat().map(part => part.id);
    const resumed = api().prepareDirectionSource(saved.units, { alreadyCovered, episodeNumbers: Array.from({ length: 30 }, (_, index) => index + 1) });
    assert.equal(resumed.batches.length + 1, 2, 'one remaining evidence call plus one synthesis call');
    const covered = [...alreadyCovered, ...resumed.batches.flat().map(part => part.id), ...resumed.programRecords.map(record => record.unitId)];
    assert.equal(new Set(covered).size, result.allParts.length);
    assert.deepEqual([...covered].sort(), result.allParts.map(part => part.id).sort());
    assert.equal(JSON.stringify(saved), before);
  } finally { db.close(); }
});
