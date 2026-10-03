import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {compileStandardScript} from '../lib/standard-script';
import {prepareStandardEpisode, deriveStandardScriptLines} from '../lib/standard-script-plan';

const require = createRequire(import.meta.url);
const {standardPackageSource} = require('../runtime/storyboard-v4/core/standard-source.mjs');
const {normalizeSource} = require('../runtime/storyboard-v4/core/source.mjs');
const {sliceSource} = require('../runtime/storyboard-v4/core/core.mjs');
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)), 'utf16le').digest('hex');
const prepared = (text: string, knownSpeakers?: string[]) => prepareStandardEpisode(text, 'inline-dialogue', {knownSpeakers, syntax: 'legacy'});
const receive = (result: ReturnType<typeof prepared>) => normalizeSource(standardPackageSource(result.compiled!.package, {key: 'ep', title: '合成双说者', context: {}, sourceText: result.index.text}));
const good = (text: string, knownSpeakers?: string[]) => {
  const result = prepared(text, knownSpeakers);
  assert.deepEqual(result.diagnostics, [], `应保真接收明确同线说者：${text}`);
  assert.ok(result.compiled);
  assert.equal(result.index.units.map(unit => unit.text).join(''), text);
  assert.deepEqual(result.plan.entries.flatMap(entry => entry.unitIds), result.index.units.map(unit => unit.id));
  return result;
};

const basic = good('人物：甲、乙\n甲：你好。乙：再见。');
const group: any = basic.compiled!.package.script.entries.at(-1);
assert.equal(group.kind, 'DIALOGUE_GROUP');
assert.equal(group.text, '甲：你好。乙：再见。');
assert.equal(basic.plan.schemaVersion, 'STANDARD_SCRIPT_PLAN_V2');
assert.equal(basic.compiled!.package.schemaVersion, 'DIRECTOR_STANDARD_SCRIPT_SLICE_V2');
assert.equal(basic.compiled!.package.assemblerVersion, 'standard-script-compiler-v2');
assert.equal(basic.compiled!.receipt.schemaVersion, 'STANDARD_SCRIPT_MECHANICAL_RECEIPT_V2');
assert.deepEqual(group.dialogues.map((d: any) => [d.speaker.text, d.text, d.channel]), [['甲', '你好。', 'SPEECH'], ['乙', '再见。', 'SPEECH']]);
assert.deepEqual((deriveStandardScriptLines(basic)[1] as any).speakers, ['甲', '乙']);
assert.equal(deriveStandardScriptLines(basic).length, 2);
assert.ok(basic.compiled!.readingText.includes('【说者】甲') && basic.compiled!.readingText.includes('【说者】乙'));

for (const eol of ['\n', '\r\n', '\r']) for (const separator of ['。', '。 ', '，', ',', '；', ';', ' ', '\t']) {
  const line = `  甲：你好${separator}乙：再见😀。${eol}`;
  const result = good(`人物：甲、乙${eol}${line}`), body: any = result.compiled!.package.script.entries.at(-1);
  assert.equal(body.text, line, '组主text逐字保留完整物理行，包括缩进和换行');
  const source = receive(result);
  assert.deepEqual(source.dialogue.map((d: any) => d.id), ['ep:line-2:D1', 'ep:line-2:D2']);
  assert.deepEqual(source.dialogue.map((d: any) => d.quote), [`你好${separator.trimEnd()}`, '再见😀。']);
  assert.deepEqual(normalizeSource(JSON.parse(JSON.stringify(source))), source);
}
const voices = good('甲（OS，压低声音）：你好。乙（vo,对讲机声）：再见。', ['甲', '乙']);
assert.deepEqual(receive(voices).dialogue.map((d: any) => [d.speaker, d.channel, d.cue]), [['甲', 'OS', 'OS；压低声音'], ['乙', 'VO', 'vo；对讲机声']]);
const quoted = good('人物：甲、乙\n甲：他说“乙：别走”。');
assert.equal(quoted.compiled!.package.schemaVersion, 'DIRECTOR_STANDARD_SCRIPT_SLICE_V1');
assert.equal(receive(quoted).dialogue.length, 1);
assert.equal(receive(quoted).dialogue[0].quote, '他说“乙：别走”。');
assert.equal(receive(good('人物：甲、乙\n甲：“你好。”乙：再见。')).dialogue.length, 2);

for (const raw of [
  '人物：甲\n甲：你好。乙：再见。', '人物：甲\n甲：你好，乙：再见。',
  '人物：甲、乙\n甲：你好。丙（VO，低声）：再见。乙：回来。',
  '人物：甲、乙\n甲：我告诉乙：再见。', '人物：甲、乙\n甲：你好。小乙：再见。',
  '人物：甲、乙\n甲：你好。乙：“再见。', '人物：甲、乙\n甲：你好。△乙转身。乙：再见。',
  '人物：甲、乙\n甲：乙：再见。', '人物：甲、乙\n甲：你好。乙：',
]) assert.equal(prepared(raw).compiled, null, `未知说者、引用或动作边界不确定仍拒收：${raw}`);

const three = good('人物：甲、乙、丙\n甲（低声）：甲句。乙：乙句，丙（OS）：丙句。\n');
const compiled: any = three.compiled!.package;
const corruptPlan = (change: (entry: any, plan: any) => void) => {
  const plan: any = structuredClone(three.plan), entry = plan.entries.at(-1);
  change(entry, plan);
  assert.throws(() => compileStandardScript(three.index, plan), /GROUP|DIALOGUE|PART|FIELD|LAYOUT|TEXT|CHANNEL|SCHEMA/);
};
corruptPlan(entry => {entry.dialogues.pop();});
corruptPlan(entry => {entry.dialogues[1] = structuredClone(entry.dialogues[0]);});
corruptPlan(entry => {entry.dialogues.reverse();});
corruptPlan(entry => {entry.dialogues[1].channel = 'VO';});
corruptPlan(entry => {entry.dialogues[2].channel = 'SPEECH';});
corruptPlan(entry => {entry.dialogues[0].parts[0].start++;});
corruptPlan(entry => {entry.parts[0].start++;});
corruptPlan((_, plan) => {plan.schemaVersion = 'STANDARD_SCRIPT_PLAN_V1';});
corruptPlan(entry => { // An apparently covered parent cannot hide an entire middle speaker inside D1's quote.
  const middle = entry.dialogues.splice(1, 1)[0];
  entry.dialogues[0].parts[0].end = middle.parts.at(-1).end;
  entry.dialogues[0].layout = entry.dialogues[0].layout.filter((p: any) => p.start < entry.dialogues[0].parts[0].start);
});
const single = good('人物：甲\n甲：单句。'), sparsePlan: any = structuredClone(single.plan), ordinary: any = sparsePlan.entries.at(-1), unit = single.index.units.at(-1)!;
sparsePlan.schemaVersion = 'STANDARD_SCRIPT_PLAN_V2';
const child = {parts: ordinary.parts, layout: ordinary.layout, speaker: ordinary.speaker, channel: ordinary.channel, channelSource: ordinary.channelSource, cue: ordinary.cue};
const sparseChildren = [child]; sparseChildren.length = 2;
sparsePlan.entries[sparsePlan.entries.length - 1] = {id: ordinary.id, unitIds: ordinary.unitIds, target: 'BODY', kind: 'DIALOGUE_GROUP', parts: [{kind: 'SOURCE_SLICE', unitId: unit.id, start: unit.start, end: unit.end}], layout: [], dialogues: sparseChildren};
assert.throws(() => compileStandardScript(single.index, sparsePlan), /OBJECT|GROUP|ARRAY/, 'sparse child array cannot fake a second complete dialogue');

function resignedPackage(change: (entry: any) => void) {
  const pkg = structuredClone(compiled); change(pkg.script.entries.at(-1));
  const {packageId: _, ...payload} = pkg, {receipt: __, ...fidelity} = payload.fidelity;
  const hash = fingerprint({...payload, fidelity}); pkg.packageId = `standard:${hash}`; pkg.fidelity.receipt.packageDigest = hash;
  return pkg;
}
for (const change of [
  (entry: any) => {entry.dialogues.pop();},
  (entry: any) => {entry.dialogues.reverse();},
  (entry: any) => {entry.dialogues[1].channel = 'VO';},
  (entry: any) => {entry.dialogues[0].cue.text = '大喊';},
  (entry: any) => {entry.dialogues[1].textAssembly.parts[0].start++; entry.dialogues[1].text = entry.dialogues[1].text.slice(1);},
]) assert.throws(() => standardPackageSource(resignedPackage(change), {key: 'ep', sourceText: three.index.text}), (e: any) => e.code?.startsWith('STANDARD_'));

const source = receive(three);
assert.deepEqual(source.dialogue.map((d: any) => d.id), ['ep:line-2:D1', 'ep:line-2:D2', 'ep:line-2:D3']);
for (const change of [
  (s: any) => {s.dialogue = [];}, (s: any) => {s.dialogue.splice(1, 1);},
  (s: any) => {s.dialogue[1] = structuredClone(s.dialogue[0]);},
  (s: any) => {s.dialogue[1].cue = '愤怒';}, (s: any) => {s.dialogue[1].channel = 'VO';},
  (s: any) => {s.sourceRows[1].standard.dialogues[1].parts[0][0]++; delete s.dialogue;},
]) {const forged = structuredClone(source); change(forged); assert.throws(() => normalizeSource(forged), /标准|对白|绑定/);}
const sliced = sliceSource(source, [source.dialogue[1].rowId]);
assert.deepEqual(sliced.dialogue, source.dialogue, '按body节点切片同时保留所有子对白，不容许单独丢D2');
assert.deepEqual(normalizeSource(JSON.parse(JSON.stringify(sliced))), sliced);

// A saved V1 classification is evidence, not an instruction to re-run the newer group inference.
const oldInlinePlan: any = structuredClone(basic.plan), oldGroup = oldInlinePlan.entries.at(-1), firstChild = oldGroup.dialogues[0], lastChild = oldGroup.dialogues.at(-1);
oldInlinePlan.schemaVersion = 'STANDARD_SCRIPT_PLAN_V1';
oldInlinePlan.entries[oldInlinePlan.entries.length - 1] = {id: oldGroup.id, unitIds: oldGroup.unitIds, target: 'BODY', kind: 'DIALOGUE', speaker: firstChild.speaker, channel: 'SPEECH', cue: null, channelSource: null, parts: [{...firstChild.parts[0], end: lastChild.parts.at(-1).end}], layout: firstChild.layout};
const savedV1 = compileStandardScript(basic.index, oldInlinePlan);
const oldInline = normalizeSource(standardPackageSource(savedV1.package, {key: 'ep', sourceText: basic.index.text}));
assert.deepEqual(oldInline.dialogue.map((d: any) => [d.id, d.speaker, d.quote]), [['ep:line-2:D1', '甲', '你好。乙：再见。']]);
assert.deepEqual(normalizeSource(JSON.parse(JSON.stringify(oldInline))), oldInline, 'old structured snapshots are never silently re-inferred by the new syntax');

const old = prepareStandardEpisode('人物：甲、乙\r\n甲（OS，低声）：你好😀。\r\n乙：再见。\r\n', 'v1-regression');
assert.equal(old.compiled!.package.schemaVersion, 'DIRECTOR_STANDARD_SCRIPT_SLICE_V1');
assert.equal(old.compiled!.receipt.packageDigest, 'f3b70017863dc0ad0c5bf4900919c91d4fdc28b8c8e56b0e86be56be2accbe46');
assert.equal(old.compiled!.receipt.planDigest, '1bc442995f256b454d58536e2212dfe64419a717e09bfcd792a741b2b8c114b3');
assert.equal(old.compiled!.receipt.readingTextDigest, 'a0c7ba9e7ad5a1ec988b7ad92ead4e7ecc4460b564749e029dc562a67a65848c');
assert.deepEqual(receive(old).dialogue.map((d: any) => d.id), ['ep:line-2:D1', 'ep:line-3:D1']);
console.log('PASS inline dialogue groups: full physical source, nested exact fields, V2/legacy V1 receipts, 24 separator/EOL cases, unknown/ambiguous refusals, independent receiver, saved catalog and whole-node slicing');
