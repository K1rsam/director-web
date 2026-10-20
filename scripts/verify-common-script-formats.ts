import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {compileStandardScript,createSourceIndex} from '../lib/standard-script';
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

test('an independently named physical action ends dialogue without requiring a triangle marker', () => {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const action of ['程野震惊抬头。', '程野转身离开。', '程野缓缓低头。', '程野攥紧袖口，林岚微微前倾，两人对视，却不敢出声。']) {
      const text = ['人物：林岚、程野', '林岚（温和）：原来是你。', action, '程野：是我。'].join(eol);
      const {entries, source} = accepted(text);
      assert.deepEqual(entries.filter(entry => entry.target === 'BODY').map(entry => [entry.kind, entry.text]), [
        ['DIALOGUE', '原来是你。'], ['ACTION', action], ['DIALOGUE', '是我。'],
      ]);
      assert.deepEqual(source.dialogue.map((entry: any) => entry.quote), ['原来是你。', '是我。']);
      assert.deepEqual(prepareStandardEpisode(text, 'frozen', {syntax: 'legacy'}).diagnostics.map(d => d.code), ['AMBIGUOUS_CONTINUATION']);
    }
  }
});

test('unmarked-action recognition does not guess quoted, incomplete or uncertain continuations', () => {
  const prefix = '人物：林岚、程野\n林岚：原来是你。\n';
  for (const tail of ['程野原来在这里。', '程野抬头了吗？', '程野说：“是我。”', '陌生人震惊抬头。', '灯光渐暗。']) {
    assert.ok(prepare(prefix + tail).diagnostics.some(d => d.code === 'AMBIGUOUS_CONTINUATION'), tail);
  }
  const {source} = accepted('人物：林岚、程野\n林岚：“我亲眼看见\n程野震惊抬头。\n然后他就跑了。”');
  assert.equal(source.dialogue.length, 1);
  assert.equal(source.dialogue[0].quote, '“我亲眼看见\n程野震惊抬头。\n然后他就跑了。”');
  assert.ok(prepare('人物：林岚、程野\n林岚：\n程野震惊抬头。').diagnostics.some(d => d.code === 'EMPTY_DIALOGUE'));
});

test('position-qualified screen text stays visible text rather than a speaker', () => {
  for (const head of ['字幕（铜镜镜面）', '屏幕文字(炉鼎旁)', '弹幕（直播屏幕）']) {
    const text = `${head}：【奖励：灵果一枚】`;
    const {entries, source} = accepted(text);
    assert.deepEqual([entries[0].kind, entries[0].text], ['ONSCREEN_TEXT', text]);
    assert.equal(source.dialogue.length, 0);
  }
  for (const head of ['字幕（铜镜（正面））', '字幕（）', '资料（铜镜镜面）']) assert.equal(prepare(`${head}：原文。`).compiled, null);
});

test('cultivation crowds, numbered disciples and explicit joined speakers keep whole source labels', () => {
  const cast = '人物：林岚、程野、两名山门弟子、玄门弟子及诸位大能';
  for (const speaker of ['山门弟子甲', '山门弟子乙', '众修', '众弟子', '山门同门', '四人', '林岚、程野及诸位大能']) {
    const {entries, source} = accepted(`${cast}\n${speaker}（恭敬）：多谢。`);
    assert.equal(entries[1].speaker?.text, speaker);
    assert.deepEqual(source.dialogue.map((d: any) => [d.speaker, d.quote]), [[speaker, '多谢。']]);
  }
  for (const speaker of ['林岚及不明资料', '格式说明', '资料同门备注']) assert.equal(prepare(`${cast}\n${speaker}（低声）：不能猜。`).compiled, null);
});

test('an explicit spoken explanation colon does not invent a second speaker', () => {
  const quote = '诸位请听。规矩老样子：价高者得，禁止动武！';
  const {source} = accepted(`人物：林岚\n林岚：${quote}`);
  assert.deepEqual(source.dialogue.map((d: any) => [d.speaker, d.quote]), [['林岚', quote]]);
  const group = accepted(`人物：林岚、程野\n林岚：${quote}程野：明白。`).source;
  assert.deepEqual(group.dialogue.map((d: any) => [d.speaker, d.quote]), [['林岚', quote], ['程野', '明白。']]);
  assert.equal(prepare('人物：林岚\n林岚：你好。不明说者：站住。').compiled, null);
});

test('military and advisory source roles keep exact incidental and numbered labels', () => {
  for(const speaker of ['士卒','士卒甲','士卒乙','军士','众军士','斥候甲','两名密探','众谋士','同席谋士','主守谋士','反对谋士','其余谋士','其他谋士','北军士卒']) {
    const {source}=accepted(`人物：林岚、两军士卒\n${speaker}（低声）：遵命。`);
    assert.deepEqual(source.dialogue.map((d:any)=>[d.speaker,d.quote]),[[speaker,'遵命。']]);
  }
  for(const label of ['资料士卒说明','人物关系备注','修订谋士规则'])assert.equal(prepare(`${label}（低声）：不得猜测。`).compiled,null);
});

test('closed bracketed screen text without a colon ends speech without becoming dialogue', () => {
  for(const caption of ['字幕【三年后】','字幕【第一季完】','屏幕文字【城门已关闭】']){
    const {entries,source}=accepted(`人物：林岚\n林岚：出发。\n${caption}`);
    assert.equal(entries.at(-1)?.kind,'ONSCREEN_TEXT');assert.equal(entries.at(-1)?.text,caption);
    assert.deepEqual(source.dialogue.map((d:any)=>d.quote),['出发。']);
  }
  for(const caption of ['字幕【】','字幕【未闭合','字幕【外层【内层】】'])assert.equal(prepare(caption).compiled,null);
  assert.equal(accepted('人物：林岚\n林岚：“字幕【此处只是引用】”').source.dialogue[0].quote,'“字幕【此处只是引用】”');
});

test('system status fields and voiced edict predicates remain verbatim utterances', () => {
  for(const [speaker,cue,quote] of [['系统','VO','宿主状态：待定。'],['系统','VO','装备评估完成：可用。'],['传诏官','展开王旨','大王有旨：守军立即回援！']]){
    const {source}=accepted(`人物：${speaker}\n${speaker}（${cue}）：${quote}`);
    assert.deepEqual(source.dialogue.map((d:any)=>[d.speaker,d.quote]),[[speaker,quote]]);
  }
  assert.equal(prepare('人物：林岚\n林岚：你好。不明身份：退下。').compiled,null);
  assert.equal(prepare('人物：林岚\n林岚：装备评估完成：可用。').compiled,null,'system-property exception is not a general label bypass');
});

test('a known actor hearing a remark and physically spitting blood is a separate source action', () => {
  for(const action of ['程野听到这句话，气得又喷出一口血。','程野听见嘲讽，气的吐出一口血。']){
    const {entries,source}=accepted(`人物：林岚、程野\n林岚：退下！\n${action}\n程野：你等着。`);
    assert.equal(entries[2].kind,'ACTION');assert.equal(entries[2].text,action);
    assert.deepEqual(source.dialogue.map((d:any)=>d.quote),['退下！','你等着。']);
  }
  for(const action of ['程野听到这句话。','程野听到“吐出一口血”，没有动。','陌生生物听到这句话，气得又喷出一口血。'])assert.equal(prepare(`人物：林岚、程野\n林岚：退下！\n${action}`).compiled,null);
});

test('an immediately repeated identical empty speaker head remains source layout, not a second utterance', () => {
  for(const head of ['林岚（OS）：','林岚（低声）：','林岚：（VO）']){
    const text=`人物：林岚\n${head}${head}原来如此！`,{result,source}=accepted(text);
    assert.deepEqual(source.dialogue.map((d:any)=>[d.speaker,d.quote]),[['林岚','原来如此！']]);
    assert.equal(result.index.text,text);assert.ok(result.compiled!.package.evidence.map(unit=>unit.text).join('').includes(head+head));
  }
  const result=accepted('人物：林岚\n林岚（OS）：林岚（OS）：原来如此！').result;
  const altered=createSourceIndex(result.index.text.replace('（OS）','（VO）'),result.index.sourceId);
  const plan=JSON.parse(JSON.stringify(result.plan).replaceAll(result.index.sourceVersion,altered.sourceVersion));
  assert.throws(()=>compileStandardScript(altered,plan),'different first header cannot disappear into layout');
  for(const text of ['人物：林岚\n林岚（OS）：林岚（VO）：不可混同。','人物：林岚、程野\n林岚：程野：不能吞头。'])assert.equal(prepare(text).compiled,null);
  assert.deepEqual(accepted('人物：林岚\n林岚：先说。林岚：后说。').source.dialogue.map((d:any)=>d.quote),['先说。','后说。']);
});

test('book-quoted episode titles stay structural and never enter the action body', () => {
  const {entries}=accepted('第十二集《风起》\n12-1 日 外 城门\n△城门打开。');
  assert.equal(entries[0].target,'STRUCTURE');assert.equal(entries[0].kind,'EPISODE_HEADING');
  assert.equal(accepted('第十集团军已经撤离。').entries[0].kind,'ACTION');
});
