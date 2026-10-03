import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {compileStandardScript} from '../lib/standard-script';
import {prepareStandardEpisode} from '../lib/standard-script-plan';

const require = createRequire(import.meta.url);
const {standardPackageSource} = require('../runtime/storyboard-v4/core/standard-source.mjs');
const {normalizeSource} = require('../runtime/storyboard-v4/core/source.mjs');
const prepare = (text: string) => prepareStandardEpisode(text, 'common-format');
function accepted(text: string) {
  const result = prepare(text);
  assert.deepEqual(result.diagnostics, [], text);
  assert.ok(result.compiled, text);
  assert.equal(result.index.units.map(unit => unit.text).join(''), text);
  assert.deepEqual(result.plan.entries.flatMap(entry => entry.unitIds), result.index.units.map(unit => unit.id));
  const source = normalizeSource(standardPackageSource(result.compiled.package, {key: 'ep', sourceText: text}));
  assert.deepEqual(normalizeSource(JSON.parse(JSON.stringify(source))), source);
  assert.equal(result.compiled.receipt.semantic, 'NOT_RUN');
  return {result, source, entries: result.compiled.package.script.entries};
}

test('numbered scene headings allow a colon while non-head number prose remains action', () => {
  for (const heading of ['11-1：日 外 大比擂台区', '11-1: 日 外 大比擂台区', '11 - 1 ： 日 外 大比擂台区']) {
    const {entries} = accepted(`${heading}\n△苏炎登台。`);
    assert.equal(entries[0].kind, 'SCENE_HEADING');
    assert.equal(entries[0].text, heading);
  }
  assert.equal(accepted('11-1号站点已经停用。').entries[0].kind, 'ACTION');
});

test('a complete parenthesized final-episode title and explicit end marker stay structural', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    const {entries} = accepted(['第七十集（大结局）：', '70-1 日 外 山顶', '苏炎：结束了。', '【全剧终】'].join(eol));
    assert.deepEqual(entries.map(entry => entry.target), ['STRUCTURE', 'STRUCTURE', 'BODY', 'STRUCTURE']);
    assert.equal(entries[0].kind, 'EPISODE_HEADING');
    assert.equal(entries.at(-1)?.text, '【全剧终】');
  }
  assert.equal(accepted('第十集团军的士兵冲进院子。').entries[0].kind, 'ACTION');
  for (const line of ['【未知提示】继续', '第七十集（大结局：', '第七十集（大结局）突然塌下：']) {
    assert.equal(prepare(line).compiled, null, line);
  }
});

test('a post-colon cue with no spoken text before the next explicit speaker is full-source action', () => {
  const action = '楚天野：（反手一巴掌抽在王腾脸上）';
  for (const suffix of ['\n王腾：你敢打我？', '\n△王腾踉跄后退。', '\n【全剧终】', '']) {
    const {entries, source} = accepted(`人物：楚天野、王腾\n${action}${suffix}`);
    assert.deepEqual([entries[1].kind, entries[1].text, entries[1].speaker], ['ACTION', action, undefined]);
    assert.equal(source.dialogue.some((entry: any) => entry.speaker === '楚天野'), false);
  }
  const {entries} = accepted('人物：楚天野、王腾\n楚天野：（压低声音）\n别出声。\n王腾：好。');
  assert.equal(entries[1].kind, 'DIALOGUE');
  assert.equal(entries[1].cue?.text, '压低声音');
  assert.equal(entries[1].text, '别出声。');
  for (const text of ['人物：楚天野、王腾\n楚天野：\n王腾：好。', '人物：楚天野、王腾\n楚天野：（VO）\n王腾：好。', '人物：楚天野\n楚天野（低声）']) {
    assert.ok(prepare(text).diagnostics.some(diagnostic => diagnostic.code === 'EMPTY_DIALOGUE'));
  }
});

test('cast parentheticals establish the base and exact written form without treating the form as a cue', () => {
  for (const [cast, head, speaker] of [
    ['深渊魔龙（未露全貌）', '深渊魔龙', '深渊魔龙'],
    ['围观群众（卫星直播画面）', '围观群众甲', '围观群众甲'],
    ['神帝（虚影）', '神帝虚影', '神帝虚影'],
    ['神帝（残躯）', '神帝（残躯）', '神帝（残躯）'],
    ['看门狗（大黄）', '看门狗（大黄）', '看门狗（大黄）'],
  ]) {
    const {entries, source} = accepted(`人物：${cast}\n${head}：（低声）我来了。`);
    assert.deepEqual([entries[1].speaker?.text, entries[1].cue?.text, entries[1].text], [speaker, '低声', '我来了。']);
    assert.equal(source.dialogue[0].speaker, speaker);
  }
  const {source} = accepted('人物：神帝（残躯）、看门狗（大黄）\n神帝（残躯）：站住。看门狗（大黄）：（低声）我在。');
  assert.deepEqual(source.dialogue.map((d: any) => d.speaker), ['神帝（残躯）', '看门狗（大黄）']);
  assert.equal(prepare('人物：看门狗（大黄）\n看门狗（小白）：（低声）我来了。').compiled, null, 'an undeclared form is not interchangeable with the declared form');
  assert.equal(prepare('人物：怪兽\n怪兽虚影：（低声）我来了。').compiled, null, 'a form absent from the cast cannot be invented');
});

test('explicit jointly named cast preserves a shared utterance or an entire cue-only action', () => {
  const cast = '人物：秦大爷、保洁大妈';
  const action = '秦大爷、保洁大妈：（两位对视，同时爆发出修为）';
  assert.equal(accepted(`${cast}\n${action}`).entries[1].text, action);
  assert.equal(accepted(`${cast}\n${action}`).entries[1].kind, 'ACTION');
  const {entries, source} = accepted(`${cast}\n${action}校长，我们来了。\n秦大爷：走吧。`);
  assert.deepEqual([entries[1].speaker?.text, entries[1].text], ['秦大爷、保洁大妈', '校长，我们来了。']);
  assert.equal(source.dialogue[0].speaker, '秦大爷、保洁大妈');
  assert.equal(prepare('人物：秦大爷\n秦大爷、陌生生物：（低声）我们来了。').compiled, null);
});

test('a pre-header voice cannot be relabeled as an undeclared speaker form', () => {
  const {result} = accepted('人物：林岚\n林岚（OS）：（低声）我来了。');
  const plan = structuredClone(result.plan), entry = plan.entries[1];
  assert.ok(entry.target === 'BODY' && entry.kind === 'DIALOGUE');
  const end = result.index.text.indexOf('）') + 1;
  entry.speaker[0].end = end;
  entry.channelSource = null; entry.channel = 'SPEECH';
  entry.layout = entry.layout.filter(part => part.end > end).map(part => ({...part, start: Math.max(part.start, end)}));
  assert.throws(() => compileStandardScript(result.index, plan), /POST_CUE/);
});

test('paired square-bracket quotations preserve internal colons without hiding a later speaker', () => {
  for (const [open, close] of [['【', '】'], ['[', ']']]) {
    const quote = `收到${open}任务：找到甲，乙：等候${close}。`;
    const {entries} = accepted(`苏炎：（VO）${quote}`);
    assert.equal(entries[0].text, quote);
    const {source} = accepted(`苏炎：（VO）${quote}王腾：收到。`);
    assert.deepEqual(source.dialogue.map((d: any) => [d.speaker, d.quote]), [['苏炎', quote], ['王腾', '收到。']]);
    assert.equal(prepare(`苏炎：（VO）收到${open}任务：尚未闭合。王腾：别吞掉我。`).compiled, null);
  }
});

test('post-colon OS or VO directly followed by a Chinese cue retains both exact fields', () => {
  for (const [marker, cue, body] of [['VO', '从九天之上降落大吼', '尔等放肆！'], ['os', '咬牙暗想', '终于找到了。']] as const) {
    for (const eol of ['\n', '\r\n', '\r']) {
      const {result, entries, source} = accepted(`人物：天尊\n天尊：（${marker}${cue}）${body}${eol}`);
      assert.deepEqual([entries[1].speaker?.text, entries[1].cue?.text, entries[1].channelSource?.text, entries[1].channel, entries[1].text], ['天尊', cue, marker, marker.toUpperCase(), body]);
      assert.equal(source.dialogue[0].channel, marker.toUpperCase());
      for (const mutate of [
        (entry: any) => {entry.channel = 'SPEECH';},
        (entry: any) => {entry.cue[0].start -= 2; entry.channelSource = null;},
      ]) {
        const plan = structuredClone(result.plan); mutate(plan.entries[1]);
        assert.throws(() => compileStandardScript(result.index, plan));
      }
    }
  }
  for (const cue of ['VO、低声', 'OS/VO', '低声VO', 'VO从天降,OS']) {
    assert.equal(prepare(`人物：天尊\n天尊：（${cue}）不可猜测。`).compiled, null, cue);
  }
});
