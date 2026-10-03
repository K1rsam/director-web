import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import type {SourceIndex, SourcePart, StandardScriptPlan} from '../lib/standard-script';

async function main() {
  assert.ok(existsSync('lib/standard-script.ts'), 'RED: standard-script compiler is not implemented');
  const {createSourceIndex, compileStandardScript, StandardScriptError} = await import('../lib/standard-script');
  const raw = '\uFEFF第0集：回信\r\n0-1 客厅 夜 内\r△甲望着信封😀。\n甲（低声）：他说：“别拆：等我回来。”：：字面\\n（其实 很久）\r\n还要再等吗？：\n系统音：叮！\r屏显：三小时后\n连续性备注：信封尚未拆封。\n情绪线索：克制。\n导演建议：可先关注握信封的手。\n \t\r\n版本：作者草稿\r';
  const index = createSourceIndex(raw, 'synthetic-script');
  const part = (n: number, start = 0, end = index.units[n].text.length, kind: SourcePart['kind'] = 'SOURCE_SLICE'): SourcePart =>
    ({unitId: index.units[n].id, start: index.units[n].start + start, end: index.units[n].start + end, kind});
  const content = (n: number) => index.units[n].text.replace(/[\r\n]+$/, '').length;
  const line = (n: number) => ({unitIds: [index.units[n].id], parts: [part(n, 0, content(n))], layout: [part(n, content(n), undefined, 'SOURCE_SEPARATOR')]});
  const plan: StandardScriptPlan = {
    schemaVersion: 'STANDARD_SCRIPT_PLAN_V1', sourceId: index.sourceId, sourceVersion: index.sourceVersion,
    entries: [
      {id: 'episode', target: 'STRUCTURE', kind: 'EPISODE_HEADING', ...line(0), parts: [part(0, 1, content(0))], layout: [part(0, 0, 1), ...line(0).layout]},
      {id: 'scene', target: 'STRUCTURE', kind: 'SCENE_HEADING', ...line(1)},
      {id: 'action', target: 'BODY', kind: 'ACTION', ...line(2), parts: [part(2, 1, content(2))], layout: [part(2, 0, 1), ...line(2).layout]},
      {id: 'dialogue', target: 'BODY', kind: 'DIALOGUE', unitIds: [index.units[3].id, index.units[4].id],
        parts: [part(3, 6, content(3)), part(3, content(3), undefined, 'SOURCE_SEPARATOR'), part(4, 0, content(4))],
        speaker: [part(3, 0, 1)], cue: [part(3, 2, 4)], channel: 'SPEECH', channelSource: null,
        layout: [part(3, 1, 2), part(3, 4, 6), ...line(4).layout]},
      {id: 'sound', target: 'BODY', kind: 'SFX', ...line(5)},
      {id: 'screen', target: 'BODY', kind: 'ONSCREEN_TEXT', ...line(6)},
      {id: 'continuity', target: 'ANNOTATION', kind: 'CONTINUITY', ...line(7)},
      {id: 'emotion', target: 'ANNOTATION', kind: 'EMOTION_CLUE', ...line(8)},
      {id: 'guidance', target: 'ANNOTATION', kind: 'CREATIVE_GUIDANCE', ...line(9)},
      {id: 'blank', target: 'EXCLUDE', category: 'BLANK', reason: '原文空白行', unitIds: [index.units[10].id]},
      {id: 'metadata', target: 'EXCLUDE', category: 'SOURCE_METADATA', reason: '原文注明作者草稿版本；分类未作语义验收', unitIds: [index.units[11].id]},
    ],
  };
  const frozen = (value: unknown): void => {if (value && typeof value === 'object') {Object.values(value).forEach(frozen); Object.freeze(value);}};
  const before = JSON.stringify({index, plan});
  frozen(index); frozen(plan);
  const compiled = compileStandardScript(index, plan);
  assert.equal(index.text, raw);
  assert.equal(index.units.map(unit => unit.text).join(''), raw);
  assert.equal(index.offsetUnit, 'UTF16');
  assert.equal(index.units.length, 12);
  assert.deepEqual(createSourceIndex(raw, index.sourceId), index);
  assert.notEqual(createSourceIndex(raw + '改', index.sourceId).sourceVersion, index.sourceVersion);
  const dialogue = compiled.package.script.entries.find(entry => entry.id === 'dialogue')!;
  assert.equal(dialogue.text, '他说：“别拆：等我回来。”：：字面\\n（其实 很久）\r\n还要再等吗？：');
  assert.equal(dialogue.speaker?.text, '甲');
  assert.equal(dialogue.cue?.text, '低声');
  assert.equal(compiled.package.annotations.length, 3);
  assert.equal(compiled.package.script.entries.length, 6);
  assert.equal(compiled.package.exclusions[1].text, index.units[11].text);
  assert.equal(compiled.receipt.status, 'MECHANICALLY_VERIFIED');
  assert.equal(compiled.package.readiness.semantic, 'NOT_RUN');
  assert.equal(compiled.package.readiness.acceptedForDispatch, false);
  assert.ok(compiled.readingText.includes(dialogue.text));
  assert.deepEqual(JSON.parse(JSON.stringify(compiled)), compiled);
  assert.deepEqual(compileStandardScript(index, plan), compiled);
  assert.equal(JSON.stringify({index, plan}), before);
  const relabeled = structuredClone(plan);
  relabeled.entries[2] = {...line(2), id: 'action', target: 'ANNOTATION', kind: 'CONTINUITY'};
  const untrusted = compileStandardScript(index, relabeled);
  assert.equal(untrusted.package.readiness.acceptedForDispatch, false, 'coverage cannot prove the caller classified source text correctly');
  assert.equal(untrusted.package.readiness.semantic, 'NOT_RUN');
  assert.notEqual(untrusted.package.packageId, compiled.package.packageId, 'classification changes bind a different package');
  assert.equal(createSourceIndex('', 'empty').units.length, 0);
  assert.notEqual(createSourceIndex('\uD800', 'unicode').sourceVersion, createSourceIndex('\uD801', 'unicode').sourceVersion, 'hash uses exact UTF16, including unpaired surrogates');

  let rejected = 0;
  const reject = (label: string, change: (draft: any) => void, source: SourceIndex = index) => {
    const draft = structuredClone(plan); change(draft);
    assert.throws(() => compileStandardScript(source, draft), error => error instanceof StandardScriptError && Boolean(error.code && error.fieldPath), label);
    rejected++;
  };
  reject('wrong source version', p => {p.sourceVersion = 'old';});
  reject('wrong source identity', p => {p.sourceId = 'other';});
  reject('missing unit', p => {p.entries.pop();});
  reject('duplicate unit', p => {p.entries[1].unitIds = p.entries[0].unitIds;});
  reject('reordered units', p => {[p.entries[2], p.entries[3]] = [p.entries[3], p.entries[2]];});
  reject('unknown source reference', p => {p.entries[2].parts[0].unitId = 'missing';});
  reject('range beyond unit', p => {p.entries[2].parts[0].end = raw.length + 1;});
  reject('fractional range', p => {p.entries[2].parts[0].start += 0.5;});
  reject('surrogate pair split', p => {p.entries[2].parts[0].end = raw.indexOf('😀') + 1;});
  reject('nonblank exclusion', p => {p.entries[11 - 1].category = 'BLANK';});
  reject('unknown target', p => {p.entries[2].target = 'OTHER';});
  reject('unknown body kind', p => {p.entries[2].kind = 'NOTE';});
  reject('unknown annotation kind', p => {p.entries[6].kind = 'DIALOGUE';});
  reject('unknown channel', p => {p.entries[3].channel = 'WHATEVER';});
  reject('missing metadata reason', p => {p.entries[10].reason = ' ';});
  reject('illegal metadata category', p => {p.entries[10].category = 'DISCARD';});
  reject('missing speaker mapping', p => {delete p.entries[3].speaker;});
  reject('duplicate entry ID', p => {p.entries[1].id = p.entries[0].id;});
  reject('replacement body', p => {p.entries[2].text = '新写的动作';});
  reject('replacement structure', p => {p.entries[0].text = '第999集';});
  reject('replacement annotation', p => {p.entries[6].text = '新编事实';});
  reject('missing character', p => {p.entries[2].parts[0].end--;});
  reject('repeated character', p => {p.entries[2].parts.push(p.entries[2].parts[0]);});
  reject('reversed dialogue fragments', p => {p.entries[3].parts.reverse();});
  reject('overlapping speaker/body', p => {p.entries[3].speaker = p.entries[3].parts.slice(0, 1);});
  reject('fabricated separator', p => {p.entries[2].parts[0].kind = 'SOURCE_SEPARATOR';});
  reject('prose hidden as layout', p => {p.entries[2].layout.push(p.entries[2].parts.pop());});
  for (const field of ['parts', 'layout', 'speaker']) reject(`sparse ${field} array`, p => {
    const entry = p.entries[3];
    if (field === 'speaker') {
      entry.speaker = [part(3, 0, 1), part(3, 1, 5)]; entry.cue = null;
      entry.layout = [part(3, 5, 6), ...line(4).layout];
    }
    assert.equal(compileStandardScript(index, p).receipt.status, 'MECHANICALLY_VERIFIED', 'dense control remains valid');
    entry[field].splice(1, 0, entry[field][0]); delete entry[field][1];
  });
  for (const token of ['：：', '（', ' ']) reject(`body ${token} hidden as layout`, p => {
    const entry = p.entries[3], original = entry.parts[0];
    const start = raw.indexOf(token, original.start), end = start + token.length;
    entry.parts.splice(0, 1, {...original, end: start}, {...original, start: end});
    entry.layout.push({...original, start, end}); entry.layout.sort((a: SourcePart, b: SourcePart) => a.start - b.start);
  });
  reject('terminal body colon hidden as layout', p => {
    const entry = p.entries[3], original = entry.parts[2], end = original.end;
    original.end--; entry.layout.push({...original, start: end - 1, end}); entry.layout.sort((a: SourcePart, b: SourcePart) => a.start - b.start);
  });
  reject('caller supplies dispatch PASS', p => {p.readiness = {fidelity: 'VERIFIED', acceptedForDispatch: true};});
  reject('caller supplies semantic PASS', p => {p.semantic = 'VERIFIED';});
  reject('unauthorized patch', p => {p.patches = [{before: '甲', after: '乙'}];});
  reject('invalid schema', p => {p.schemaVersion = 'V99';});
  const damaged = structuredClone(index); damaged.units[0].text += '改';
  reject('tampered source index', () => {}, damaged);
  assert.throws(() => createSourceIndex(raw, ''), StandardScriptError);
  console.log(`PASS standard-script: exact UTF16 source, typed assembly, ${rejected} rejected plans, deterministic immutable inputs; mechanical only; 0 DB/network/model calls`);
}
main().catch(error => {console.error(error); process.exitCode = 1;});
