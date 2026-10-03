import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {compileStandardScript} from '../lib/standard-script';
import {prepareStandardEpisode} from '../lib/standard-script-plan';
import {prepareEpisodeReception} from '../lib/standard-script-reception';

const require = createRequire(import.meta.url);
const {standardPackageSource} = require('../runtime/storyboard-v4/core/standard-source.mjs');
const {makeEpisodeInput} = require('../runtime/storyboard-v4/input.mjs');
const prepare = (text: string) => prepareStandardEpisode(text, 'compact-format');
function accepted(text: string) {
  const result = prepare(text);
  assert.deepEqual(result.diagnostics, [], text);
  assert.ok(result.compiled);
  assert.equal(result.index.units.map(unit => unit.text).join(''), text);
  assert.deepEqual(result.plan.entries.flatMap(entry => entry.unitIds), result.index.units.map(unit => unit.id));
  const episode = {id: 'ep', projectId: 'p', number: 1, title: '第1集', content: text};
  const reception = prepareEpisodeReception(episode, null);
  const input = makeEpisodeInput({episode, project: {id: 'p', style: '3D国漫', aspectRatio: '16:9'},
    handoff: {readiness: 'READY', reasons: [], packet: {sourceText: text, ...reception}}, inputProtocol: 'upstream-material-v2'});
  return {result, entries: result.compiled.package.script.entries, input};
}

test('compact Han speaker OS/VO keeps separate exact speaker, voice and utterance source ranges', () => {
  for (const [name, marker] of [['林岚', 'os'], ['师父', 'VO'], ['路人', 'vo'], ['神秘声音', 'Os']]) {
    for (const eol of ['\n', '\r\n', '\r']) {
      const text = `人物：林岚、师父${eol}${name}${marker}：到了！${eol}`;
      const {entries, input} = accepted(text), entry = entries[1];
      assert.deepEqual([entry.speaker?.text, entry.channelSource?.text, entry.channel, entry.text], [name, marker, marker.toUpperCase(), '到了！']);
      assert.deepEqual(input.source.dialogue.map((line: any) => [line.speaker, line.channel, line.quote]), [[name, marker.toUpperCase(), '到了！']]);
      assert.equal(text.slice(entry.channelSource!.parts[0].start, entry.channelSource!.parts.at(-1)!.end), marker);
    }
  }
});

test('compact voice terminates the previous utterance instead of becoming an ambiguous continuation', () => {
  const {input} = accepted('人物：林岚、顾辰\n林岚：你来了。\n顾辰vo：小心！');
  assert.deepEqual(input.source.dialogue.map((line: any) => [line.speaker, line.channel, line.quote]), [['林岚', '现场对白', '你来了。'], ['顾辰', 'VO', '小心！']]);
});

test('compact voice composes with pre/post cues and dialogue groups without changing source words', () => {
  for (const head of ['林岚os（低声）：', '林岚os：（低声）']) {
    const {entries, input} = accepted(`人物：林岚、顾辰\n${head}到了。顾辰vo：收到。`);
    assert.equal(entries[1].kind, 'DIALOGUE_GROUP');
    assert.deepEqual(input.source.dialogue.map((line: any) => [line.speaker, line.channel, line.quote]), [['林岚', 'OS', '到了。'], ['顾辰', 'VO', '收到。']]);
    assert.equal(entries[1].dialogues?.[0].cue?.text, '低声');
  }
});

test('compact source voice cannot be reassigned to ordinary speech by a modified plan', () => {
  const {result} = accepted('林岚os：到了。');
  const plan = structuredClone(result.plan), entry = plan.entries[0];
  assert.ok(entry.target === 'BODY' && entry.kind === 'DIALOGUE');
  entry.channel = 'SPEECH';
  assert.throws(() => compileStandardScript(result.index, plan));
});

test('decimal scene numbers require explicit scene time/interior metadata and end prior dialogue', () => {
  for (const heading of ['3.2 日，内，大厅', '3.2日，外，街道', '3.2\u00a0夜，内，走廊']) {
    const {entries, input} = accepted(`林岚：走吧。\n${heading}\n▲林岚停下。`);
    assert.deepEqual(entries.map(entry => entry.kind), ['DIALOGUE', 'SCENE_HEADING', 'ACTION']);
    assert.equal(entries[1].text, heading);
    assert.equal(input.source.dialogue[0].quote, '走吧。');
  }
  assert.equal(accepted('3.2万元已经到账。').entries[0].kind, 'ACTION');
  assert.equal(accepted('3.2 项规则已经废除。').entries[0].kind, 'ACTION');
});

test('explicit scene-cut marks are preserved as creative guidance, never spoken dialogue or dropped', () => {
  for (const marker of ['【镜头切：竹林】', '【镜头切】', '【一卡】', '【二卡】']) {
    const {result, input} = accepted(`林岚：走吧。\n${marker}\n▲林岚停下。`);
    assert.equal(result.compiled?.package.annotations[0].text, marker);
    assert.equal(result.compiled?.package.annotations[0].kind, 'CREATIVE_GUIDANCE');
    assert.ok(input.source.contextRows.some((row: any) => row.text === `${marker}\n`));
    assert.equal(input.source.dialogue.length, 1);
  }
});

test('unknown labels, conflicting voices and unknown typed marks remain blocked', () => {
  for (const text of ['水系升级：到了。', '备注os：只作说明。', '导演处理vo：这里慢些。', '林岚os（VO）：到了。', '林岚os：（VO）到了。', '【未知提示】', '【卡：含义未明】', '【镜头切：】']) {
    const prepared = prepare(text);
    assert.ok(prepared.diagnostics.length, text);
    assert.equal(prepared.compiled, null, text);
  }
  const {entries} = accepted('人物：Carlos\nCarlos：到了。');
  assert.deepEqual([entries[1].speaker?.text, entries[1].channel], ['Carlos', 'SPEECH']);
});

test('unsupported multi-speaker inline subtitles remain a blocker and quoted literals stay spoken', () => {
  for (const text of ['林岚：到了。【字幕：旅客】顾辰：收到。']) {
    const result = prepare(text);
    assert.ok(result.diagnostics.some(item => item.code === 'MIXED_DIALOGUE_ONSCREEN_TEXT'));
    assert.equal(result.compiled, null);
    const episode = {id: 'ep', projectId: 'p', number: 1, content: text};
    assert.throws(() => makeEpisodeInput({episode, project: {id: 'p'}, handoff: {packet: {sourceText: text, ...prepareEpisodeReception(episode, null)}}}), (error: any) => error.code === 'SOURCE_DIAGNOSTICS');
  }
  const quoted = '他说“【字幕：到了】”，我记住了。';
  assert.equal(accepted(`林岚：${quoted}`).input.source.dialogue[0].quote, quoted);
});

test('legacy parser remains opt-in and old package versions retain their original proof', () => {
  const cases = [
    {id: 'old-parenthesis', text: '人物：林岚\n林岚（OS）：到了。\n', options: {}, digest: 'c43ba8b7a767e52ffcef62eedf55b2ab15fb993f7d31ca4b0a3ccee0715c41e3'},
    {id: 'old-post-cue', text: '人物：林岚\n林岚：（低声）到了。\n', options: {}, digest: '3d0f415268dd8603adc56f2d9258691fcfc01486fdb0d94f2ecc4c82bbb50aa5'},
    {id: 'old-legacy', text: '人物：林岚\n林岚os：到了。\n', options: {syntax: 'legacy' as const, knownSpeakers: ['林岚os']}, digest: 'c5292c35a6e0d9e6970137c2f36a29d66fc11819ba9f5f0f6ea44737897be390'},
  ];
  for (const fixture of cases) {
    const result = prepareStandardEpisode(fixture.text, fixture.id, fixture.options);
    assert.deepEqual(result.diagnostics, []);
    assert.ok(result.compiled);
    assert.equal(result.compiled.package.packageId, `standard:${fixture.digest}`);
    standardPackageSource(result.compiled.package, {key: 'ep', sourceText: fixture.text});
  }
});
