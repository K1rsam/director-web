import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {compileStandardScript} from '../lib/standard-script';
import {prepareStandardEpisode} from '../lib/standard-script-plan';
import {applyScriptResolutions} from '../lib/script-resolution-plan';

const require = createRequire(import.meta.url);
const {standardPackageSource} = require('../runtime/storyboard-v4/core/standard-source.mjs');
const {normalizeSource} = require('../runtime/storyboard-v4/core/source.mjs');
const quote = '快看那个F级废柴苏炎！异能高考连十分都没考到，躲到天台上来哭天抢地了！';
const prepare = (text: string, knownSpeakers: string[] = []) => prepareStandardEpisode(text, 'explicit-head', {knownSpeakers});
const good = (text: string, knownSpeakers: string[] = []) => {
  const result = prepare(text, knownSpeakers);
  assert.deepEqual(result.diagnostics, [], text);
  assert.ok(result.compiled, text);
  assert.equal(result.index.units.map(unit => unit.text).join(''), text);
  assert.deepEqual(result.plan.entries.flatMap(entry => entry.unitIds), result.index.units.map(unit => unit.id));
  assert.equal(result.compiled.receipt.semantic, 'NOT_RUN');
  assert.equal(result.compiled.receipt.acceptedForDispatch, false);
  const source = normalizeSource(standardPackageSource(result.compiled.package, {key: 'ep', sourceText: text}));
  assert.deepEqual(normalizeSource(JSON.parse(JSON.stringify(source))), source);
  return {result, source};
};

test('the supplied crowd line retains the complete source speaker, cue and pure dialogue', () => {
  for (const cast of ['', '人物：围观学生\n', '人物：围观学生、苏炎\n']) {
    const {result, source} = good(`${cast}围观学生甲：（大笑）${quote}`);
    const entry = result.compiled!.package.script.entries.at(-1)!;
    assert.deepEqual([entry.speaker?.text, entry.cue?.text, entry.text, entry.channel], ['围观学生甲', '大笑', quote, 'SPEECH']);
    assert.deepEqual(source.dialogue.map((d: any) => [d.speaker, d.cue, d.quote, d.channel]), [['围观学生甲', '大笑', quote, '现场对白']]);
  }
});

test('numbered crowd roles use positive role or declared-group evidence without truncating names', () => {
  for (const name of ['围观学生甲', '学生乙', '路人1', '保镖A', '男一', '女二']) {
    const {result} = good(`${name}：我看见了。`);
    assert.equal(result.compiled!.package.script.entries[0].speaker?.text, name);
  }
  const {result} = good('人物：天台搜救组\n天台搜救组乙：（低声）人在这里。');
  assert.equal(result.compiled!.package.script.entries.at(-1)?.speaker?.text, '天台搜救组乙');
});

test('ordinary named heads need no cast while OS/VO and cues retain exact source spans', () => {
  for (const [head, name, cue, channel, channelSource] of [
    ['苏炎：', '苏炎', null, 'SPEECH', null], ['林岚（低声）：', '林岚', '低声', 'SPEECH', null],
    ['欧阳澈：（低声）', '欧阳澈', '低声', 'SPEECH', null], ['Alice：（轻声）', 'Alice', '轻声', 'SPEECH', null],
    ['苏炎（os）：（低声）', '苏炎', '低声', 'OS', 'os'], ['围观学生乙：（vo，低声）', '围观学生乙', '低声', 'VO', 'vo'],
  ] as const) for (const eol of ['\n', '\r\n', '\r']) {
    const {result} = good(`${head}我没哭。${eol}`), entry = result.compiled!.package.script.entries[0];
    assert.deepEqual([entry.speaker?.text, entry.cue?.text ?? null, entry.channel, entry.channelSource?.text ?? null, entry.text], [name, cue, channel, channelSource, '我没哭。']);
  }
});

test('current syntax groups explicit full heads on one line without a declared cast', () => {
  for (const separator of ['。', '。 ', '，', '；', ' ', '\t']) {
    const {result, source} = good(`围观学生甲：（大笑）快看${separator}围观学生乙（OS）：又是他。 苏炎：别笑。`);
    assert.equal(result.compiled!.package.script.entries[0].kind, 'DIALOGUE_GROUP');
    assert.deepEqual(source.dialogue.map((d: any) => [d.speaker, d.quote, d.channel]), [
      ['围观学生甲', `快看${separator.trimEnd()}`, '现场对白'], ['围观学生乙', '又是他。', 'OS'], ['苏炎', '别笑。', '现场对白'],
    ]);
  }
});

test('complete multiword and overlapping declared speaker names never degrade to a suffix', () => {
  for (const names of [[], ['Smith', 'Jones'], ['Alice Smith', 'Bob Jones']]) {
    const {source} = good('Alice Smith：Hello. Bob Jones：（低声）Goodbye.', names);
    assert.deepEqual(source.dialogue.map((d: any) => [d.speaker, d.quote]), [['Alice Smith', 'Hello.'], ['Bob Jones', 'Goodbye.']]);
  }
  const {source} = good('围观学生甲：你好。围观学生乙：再见。', ['学生甲', '学生乙']);
  assert.deepEqual(source.dialogue.map((d: any) => d.speaker), ['围观学生甲', '围观学生乙']);
  assert.deepEqual(good('苏炎：“我没哭。”林岚：真的？').source.dialogue.map((d: any) => d.speaker), ['苏炎', '林岚']);
});

test('metadata and guidance are not character names, including cue-shaped unknown labels', () => {
  const text = '人物：围观学生\n时间：夜\n导演处理：先看双手。\n连续性备注：仍站在原处。\n情绪备注：不能断言羞愧。\n围观学生甲：我看见了。';
  const {result} = good(text);
  assert.equal(result.compiled!.package.annotations.length, 3);
  assert.deepEqual(result.compiled!.package.script.entries.filter(entry => entry.speaker).map(entry => entry.speaker!.text), ['围观学生甲']);
  for (const line of ['注意事项：（保密）不要外传。', '未知标签：保留待核对。', '林岚备注：（低声）仅供参考。', '张三说明：暂不确定。', '慕容备注：仍是资料。', '林提示：（低声）仍是资料。', 'Notes：Only a note.', '导演处理（低声）：放慢节奏。', '注意事项（OS）：不要把声道说明误当人名。']) {
    const result = prepare(line); assert.equal(Boolean(result.compiled), false, line); assert.equal(result.index.text, line);
  }
  assert.equal(prepare('苏炎：我没哭。导演处理：慢一点。').compiled, null, 'inline guidance cannot become a second speaker or be swallowed');
});

test('unmarked prose, reported speech, unknown ownership and ambiguous channels keep their guardrails', () => {
  const {result} = good('△苏炎说：“围观学生甲：别走。”');
  assert.equal(result.compiled!.package.script.entries[0].kind, 'ACTION');
  for (const text of [
    '（大笑）：没说者。', '苏炎说：“围观学生甲：别走。”', '苏炎说：我没有哭。', '苏炎道：我没有哭。', '苏炎说（OS）：我没有哭。', '苏炎（低声）\n没有带冒号的姓名依据。', '苏炎：我在。\n灯光渐暗。',
    '苏炎：我告诉学生甲：别走。', '苏炎：你好。未知标签：回去。', '苏炎：你好。△他转身。学生甲：再见。',
    '苏炎：（低声）（忍泪）我没哭。', '苏炎：（低声，OS，忍泪）我没哭。',
    '苏炎（O.S.）：我没哭。', '苏炎（OS/VO）：我没哭。', '苏炎（内心独白）：我没哭。',
    '苏炎：“没说完。学生甲：别走。', '学生甲：没有边界学生乙：不能猜。',
  ]) {const result = prepare(text); assert.equal(Boolean(result.compiled), false, text); assert.ok(result.diagnostics.length, text);}
  assert.equal(good('人物：陈道\n陈道：我是已声明的姓名。').source.dialogue[0].speaker, '陈道');
});

test('manual neighboring annotation leaves automatic full speaker and source fields intact', () => {
  const text = `围观学生甲：（大笑）${quote}\n提示：先看双手。`;
  const result = applyScriptResolutions(text, 'explicit-head', [{startLine: 2, endLine: 2, type: 'CREATIVE_GUIDANCE'}]);
  assert.ok(result.compiled); assert.equal(result.compiled.package.script.entries[0].speaker?.text, '围观学生甲');
  assert.equal(result.compiled.package.script.entries[0].text, quote);
  assert.throws(() => applyScriptResolutions('学生甲：你好。学生乙：再见。', 'manual-group', [{startLine: 1, endLine: 1, type: 'ACTION'}]), /多个说者/);
});

test('exact fields cannot be shortened, dropped or have the voice changed', () => {
  const {result} = good('围观学生甲：（OS，大笑）快看。围观学生乙：别笑。');
  for (const change of [
    (entry: any) => {entry.dialogues[0].speaker[0].start += 2;},
    (entry: any) => {entry.dialogues[0].channel = 'SPEECH';},
    (entry: any) => {entry.dialogues[0].cue = null;},
    (entry: any) => {entry.dialogues.pop();},
  ]) {const plan = structuredClone(result.plan); change(plan.entries[0]); assert.throws(() => compileStandardScript(result.index, plan));}
});

test('legacy mode and compatibility alias preserve the previous parser and literal cue receipts', () => {
  const text = '人物：林岚、程野\n林岚：（压住颤音）我不是来认输的。';
  const old = prepareStandardEpisode(text, 'old-v1', {postColonCue: false});
  assert.deepEqual(prepareStandardEpisode(text, 'old-v1', {syntax: 'legacy'}), old);
  assert.ok(old.compiled);
  assert.deepEqual([old.compiled.receipt.packageDigest, old.compiled.receipt.planDigest, old.compiled.receipt.readingTextDigest], [
    '1600282c94f10c3b12b6d33eee1d96522482285539948f36452f4e913e0a8239', '64157e1715a586bb1500025c3153a7a765581c4d6f40745ff0a2c778a7c6c410', '794db49e70e8e92ee73fd375de95cc00e95f3c61f7aca76e86c72ec8de359b0e',
  ]);
  assert.equal(prepareStandardEpisode(`人物：围观学生\n围观学生甲：（大笑）${quote}`, 'legacy', {postColonCue: false}).compiled, null);
  assert.equal(prepareStandardEpisode('林岚：我没哭。', 'legacy', {postColonCue: false}).compiled, null);
  assert.ok(prepareStandardEpisode('林岚：（低声）我没哭。', 'current', {syntax: 'current', postColonCue: false}).compiled, 'explicit syntax wins over the compatibility alias');
});
