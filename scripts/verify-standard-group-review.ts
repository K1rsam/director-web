import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {prepareStandardEpisode} from '../lib/standard-script-plan';

const require = createRequire(import.meta.url);
const {standardPackageSource} = require('../runtime/storyboard-v4/core/standard-source.mjs');
const {normalizeSource} = require('../runtime/storyboard-v4/core/source.mjs');
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)])) : value;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)), 'utf16le').digest('hex');
function resign(pkg: any) {
  const {packageId: _, ...payload} = pkg, {receipt: __, ...fidelity} = payload.fidelity;
  const hash = fingerprint({...payload, fidelity}); pkg.packageId = `standard:${hash}`; pkg.fidelity.receipt.packageDigest = hash;
  return pkg;
}
const receive = (pkg: any, text: string) => normalizeSource(standardPackageSource(pkg, {key: 'review', sourceText: text}));
const failures: string[] = [];
function check(name: string, run: () => void) {try {run(); console.log(`PASS ${name}`);} catch (error) {failures.push(`${name}: ${(error as Error).message.split('\n')[0]}`);}}

check('ASCII quoted fake speaker is never promoted to a dialogue owner', () => {
  const text = "人物：甲、乙、丙\n甲：'有人说。乙：别走。' 丙：回去。";
  const prepared = prepareStandardEpisode(text, 'review-quote');
  assert.deepEqual(prepared.diagnostics, []);
  const source = receive(prepared.compiled!.package, text);
  assert.deepEqual(source.dialogue.map((d: any) => [d.speaker, d.quote]), [['甲', "'有人说。乙：别走。'"], ['丙', '回去。']]);
  assert.deepEqual(normalizeSource(JSON.parse(JSON.stringify(source))), source);
});
check('word-internal apostrophes do not open quotes or hide following heads', () => {
  for (const utterance of ["Don't leave.", 'Don’t leave.', "James' book.", "students' books.", "JAMES' book.", "'James'", "'Don't say 乙：走。'", "他说：'乙：别走。'"]) {
    const text = `人物：甲、乙\n甲：${utterance} 乙：好。`;
    const prepared = prepareStandardEpisode(text, 'review-apostrophe');
    assert.deepEqual(prepared.diagnostics, [], text);
    const source = receive(prepared.compiled!.package, text);
    assert.deepEqual(source.dialogue.map((d: any) => [d.speaker, d.quote]), [['甲', utterance], ['乙', '好。']]);
  }
});
check('unfinished quotes diagnose instead of swallowing a known head', () => {
  for (const quote of ["'未闭引号。乙：别走。", '“未闭引号。乙：别走。']) {
    const prepared = prepareStandardEpisode(`人物：甲、乙\n甲：${quote}`, 'review-quote-boundary');
    assert.equal(prepared.compiled, null);
    assert.ok(prepared.diagnostics.some(d => d.code === 'UNCLOSED_DIALOGUE_QUOTE'));
  }
  const text = "人物：甲、乙\n甲：'有人说。\n乙：别走。'\n乙：真正回应。";
  const prepared = prepareStandardEpisode(text, 'review-wrapped-quote');
  assert.deepEqual(prepared.diagnostics, []);
  assert.deepEqual(receive(prepared.compiled!.package, text).dialogue.map((d: any) => [d.speaker, d.quote]), [['甲', "'有人说。\n乙：别走。'"], ['乙', '真正回应。']]);
});
check('two physical lines cannot be forged into one group with a re-signed receipt', () => {
  const text = '甲：一句。\n 乙：二句。';
  const prepared = prepareStandardEpisode(text, 'review-physical', {knownSpeakers: ['甲', '乙']});
  assert.ok(prepared.compiled);
  const pkg: any = structuredClone(prepared.compiled.package), combined = {...pkg.evidence[0], end: text.length, text};
  const remap = (value: any): any => Array.isArray(value) ? value.map(remap) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'unitId' ? combined.id : remap(item)])) : value;
  const dialogues = pkg.script.entries.map((entry: any) => remap({text: entry.text, textAssembly: entry.textAssembly, layout: entry.layout, speaker: entry.speaker, channel: entry.channel, channelSource: entry.channelSource, cue: entry.cue}));
  pkg.evidence = [combined];
  pkg.script.entries = [{id: 'line-1', target: 'BODY', kind: 'DIALOGUE_GROUP', sourceUnitIds: [combined.id], text, textAssembly: {parts: [{kind: 'SOURCE_SLICE', unitId: combined.id, start: 0, end: text.length}]}, layout: [], dialogues}];
  pkg.schemaVersion = 'DIRECTOR_STANDARD_SCRIPT_SLICE_V2'; pkg.assemblerVersion = 'standard-script-compiler-v2';
  pkg.fidelity.receipt.schemaVersion = 'STANDARD_SCRIPT_MECHANICAL_RECEIPT_V2'; pkg.fidelity.receipt.assemblerVersion = pkg.assemblerVersion;
  assert.throws(() => receive(resign(pkg), text), (e: any) => e.code === 'STANDARD_EVIDENCE', 'evidence must match independently reconstructed physical lines, not just concatenate to sourceText');
});
check('each evidence edition and offset unit is independently bound to the physical index', () => {
  const text = '甲：一句。\n乙：二句。', prepared = prepareStandardEpisode(text, 'review-evidence', {knownSpeakers: ['甲', '乙']});
  for (const [field, value] of [['sourceVersion', 'src:forged'], ['offsetUnit', 'CODE_POINT']]) {
    const pkg: any = structuredClone(prepared.compiled!.package); pkg.evidence[1][field] = value;
    assert.throws(() => receive(resign(pkg), text), (e: any) => e.code === 'STANDARD_EVIDENCE', `${field} cannot be rebound by rehashing`);
  }
});
assert.deepEqual(failures, [], 'independent C2 review counterexamples');
console.log('PASS review quote and physical-evidence regressions; no DB, model or source edits');
