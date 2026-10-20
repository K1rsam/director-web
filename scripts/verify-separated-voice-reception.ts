import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {compileStandardScript} from '../lib/standard-script';
import {prepareStandardEpisode} from '../lib/standard-script-plan';
import {prepareEpisodeReception, collectScriptReceptionIssues} from '../lib/standard-script-reception';
import {buildSourceIndex} from '../lib/project-foundation-contracts';

const require=createRequire(import.meta.url);
const {makeEpisodeInput}=require('../runtime/storyboard-v4/input.mjs');
const {normalizeSource}=require('../runtime/storyboard-v4/core/source.mjs');
function receive(content:string){
 const episode={id:'ep',projectId:'project',number:1,content};
 const prepared=prepareStandardEpisode(content,'episode-1');
 assert.deepEqual(prepared.diagnostics,[],content);
 assert.ok(prepared.compiled);
 const reception=prepareEpisodeReception(episode,null);
 const source=makeEpisodeInput({episode,project:{id:'project'},handoff:{packet:{sourceText:content,...reception}}}).source;
 assert.deepEqual(normalizeSource(structuredClone(source)),source);
 return {prepared,reception,source};
}

test('OS/VO with horizontal spacing is separate from the exact speaker, without catalogue or AI',()=>{
 for(const speaker of ['柳凡','围观学生甲','神秘声音','Carlos','Mary Jane'])for(const separator of [' ','  ','\t','\u00a0','\u3000'])for(const marker of ['os','OS','Vo','vo'])for(const eol of ['\n','\r\n','\r']){
  const content=`人物：${speaker}${eol}${speaker}${separator}${marker}：这句保留😀：还有下一句！${eol}`;
  const {prepared,source}=receive(content),voice=prepared.compiled!.package.script.entries[1];
  assert.deepEqual([voice.speaker?.text,voice.channelSource?.text,voice.channel,voice.text],[speaker,marker,marker.toUpperCase(),'这句保留😀：还有下一句！']);
  assert.deepEqual(source.dialogue.map((d:any)=>[d.speaker,d.channel,d.quote]),[[speaker,marker.toUpperCase(),'这句保留😀：还有下一句！']]);
  const fields=[...voice.speaker!.parts,...voice.channelSource!.parts,...voice.textAssembly.parts,...voice.layout].sort((a,b)=>a.start-b.start);
  assert.equal(fields.map(p=>content.slice(p.start,p.end)).join(''),prepared.index.units[1].text,'spaces and punctuation remain mapped, not rewritten');
 }
});

test('spaced voice breaks the previous dialogue and preserves pre/post cues, wrapped speech and groups',()=>{
 for(const head of ['柳凡 os：','柳凡 OS（低声）：','柳凡 VO：（大笑）']){
  const {source}=receive(`人物：柳凡、白青禾\n白青禾：你醒了。\n${head}\n我还记得\n昨天的事。\n△柳凡抬头。`);
  assert.equal(source.dialogue.length,2);
  assert.equal(source.dialogue[1].speaker,'柳凡');
  assert.equal(source.dialogue[1].quote,'我还记得\n昨天的事。');
  assert.equal(source.dialogue[0].quote,'你醒了。');
 }
 for(const head of ['柳凡 os：','柳凡 OS（低声）：','柳凡 VO：（大笑）']){
  const {source}=receive(`人物：柳凡、白青禾\n${head}到了。白青禾 vo：收到。`);
  assert.deepEqual(source.dialogue.map((d:any)=>[d.speaker,d.channel,d.quote]),[['柳凡',head.includes('VO')?'VO':'OS','到了。'],['白青禾','VO','收到。']]);
 }
});

test('spaced voice composes with explicit subtitles and cannot be changed to spoken dialogue',()=>{
 for(const head of ['柳凡 os：','柳凡 OS（低声）：','柳凡 VO：（大笑）']){
  const {source}=receive(`人物：柳凡\n${head}我来了。【字幕：柳凡】别走。`);
  assert.equal(source.dialogue[0].speaker,'柳凡');
  assert.equal(source.dialogue[0].quote,'我来了。别走。');
 }
 const {prepared}=receive('人物：柳凡\n柳凡 os：我来了。');
 const plan=structuredClone(prepared.plan),voice=plan.entries[1];
 assert.ok(voice.target==='BODY'&&voice.kind==='DIALOGUE');
 voice.channel='SPEECH';
 assert.throws(()=>compileStandardScript(prepared.index,plan),/VOICE/);
});

test('source notes and conflicting channels still block; literal Carlos and frozen legacy stay unchanged',()=>{
 for(const content of ['备注 os：不是对白。','导演备注 VO：不是对白。','水系升级：不能猜。','柳凡 os（VO）：冲突。','柳凡 os：（VO）冲突。']){
  const prepared=prepareStandardEpisode(content,'episode-1');
  assert.ok(prepared.diagnostics.length,content);assert.equal(prepared.compiled,null);
 }
 assert.equal(receive('人物：Carlos\nCarlos：我来了。').source.dialogue[0].speaker,'Carlos');
 const legacy=prepareStandardEpisode('人物：柳凡 os\n柳凡 os：我来了。','legacy',{syntax:'legacy'});
 assert.equal(legacy.compiled!.package.script.entries[1].speaker?.text,'柳凡 os');
 assert.equal(legacy.compiled!.package.script.entries[1].channel,'SPEECH');
});

test('stage1 and stage3 share the receiver: no late whole-project blocker for ordinary voice spacing',()=>{
 const episodes=[{number:1,title:null,content:'第一集\n人物：柳凡\n柳凡 os：我变成乌龟了？\n'},
  {number:2,title:null,content:'第二集\n人物：白青禾\n白青禾 VO：（轻声）不要怕。\n'}];
 assert.deepEqual(collectScriptReceptionIssues(buildSourceIndex(episodes),null),[]);
 for(const episode of episodes)assert.equal(receive(episode.content).source.dialogue.length,1);
});

test('voice after a parenthesized cue has identical meaning in standalone, grouped and mixed dialogue',()=>{
 for(const gap of ['',' ','\t','\u3000'])for(const marker of ['os','VO'])for(const cue of ['低声','盯着屏幕，眼神渐沉']){
  const head=`柳凡（${cue}）${gap}${marker}：`;
  for(const tail of ['到了。','到了。白青禾：收到。','到了。【字幕：柳凡】别走。']){
   const {source}=receive(`人物：柳凡、白青禾\n${head}${tail}`);
   assert.deepEqual([source.dialogue[0].speaker,source.dialogue[0].channel,source.dialogue[0].cue],['柳凡',marker.toUpperCase(),`${marker}；${cue}`]);
  }
 }
 for(const text of ['柳凡（OS）VO：冲突。','柳凡OS（低声）VO：冲突。','柳凡（低声）OS：（VO）冲突。'])assert.ok(prepareStandardEpisode(text,'bad').diagnostics.length,text);
});

test('incidental and qualified source roles do not require an AI-generated catalogue alias',()=>{
 for(const name of ['血月观察者','防护队员','小男孩','网友A','网友B','网友','手下','副官','老兵','年轻士兵','漂亮国研究员','霓虹官员','钢铁之城的刘老','霓虹新闻主持人']){
  const {source}=receive(`人物：柳凡\n柳凡：来了。\n${name}（低声）：不要怕。`);
  assert.deepEqual(source.dialogue.map((d:any)=>[d.speaker,d.quote]),[['柳凡','来了。'],[name,'不要怕。']]);
 }
 for(const label of ['资料说明观察者','导演备注官员','未经确认字段','接口说明'])assert.ok(prepareStandardEpisode(`${label}：不能猜。`,'bad').diagnostics.length,label);
});

test('bounded bare performance introducers keep actor, cue and quotation separately, without inventing identities',()=>{
 for(const [speaker,cue] of [['王东','憋笑'],['王东','笑容瞬间僵死'],['王东','急得眼圈发红'],['柳凡','听完'],['变异虎鲨','精神传音'],['毒蛇鱼','冷笑'],['血月首领','怒吼'],['霓虹新闻主持人','声音发抖'],['系统','这时再次提示']]){
  for(const tail of ['来了。','来了。白青禾：收到。','来了。【字幕：注意】']){
   const {source}=receive(`人物：${speaker}、白青禾\n${speaker}${cue}：${tail}`);
   assert.deepEqual([source.dialogue[0].speaker,source.dialogue[0].cue,source.dialogue[0].quote],[speaker,cue,'来了。']);
  }
 }
 const {source}=receive('人物：王东憋笑\n王东憋笑：不要缩短原文名字。');
 assert.equal(source.dialogue[0].speaker,'王东憋笑');
 for(const tail of ['备注','升级说明','从此获得新技能'])assert.ok(prepareStandardEpisode(`人物：王东\n王东${tail}：不应当猜成提示。`,'bad').diagnostics.length,tail);
});

test('explicit bullet comments and subtitles are picture text, never invented speakers or spoken dialogue',()=>{
 for(const label of ['弹幕','字幕','屏幕文字']){
  const {source}=receive(`人物：柳凡\n柳凡：来了。\n${label}：“神龟来了！”“快看！”\n柳凡：别慌。`);
  assert.deepEqual(source.dialogue.map((d:any)=>d.quote),['来了。','别慌。']);
  assert.equal(source.onscreenTexts.length,1);
  assert.equal(source.onscreenTexts[0].text,'“神龟来了！”“快看！”');
  assert.equal(source.sourceRows.find((r:any)=>r.text.includes(`${label}：`)).standard.kind,'ONSCREEN_TEXT');
 }
});

test('standalone omission dots do not get appended to a speaker; quoted wrapped dots remain literal speech',()=>{
 const {source}=receive('网友A：太好了！\n网友B：快看！\n......\n△人群散去。');
 assert.deepEqual(source.dialogue.map((d:any)=>d.quote),['太好了！','快看！']);
 assert.ok(source.contextRows.some((r:any)=>r.text.trim()==='......'));
 const quoted=receive('人物：柳凡\n柳凡：“别走\n......\n我还有话说。”').source;
 assert.equal(quoted.dialogue[0].quote,'“别走\n......\n我还有话说。”');
});

test('occupation, ranked fantasy and collective roles preserve the complete source label without a catalogue',()=>{
 for(const name of ['凛州军府府帅','南岭高校联盟主席','其他校长','南岭校长','黑袍拘使','白袍拘使','冥兵甲','幽冥三君','幽冥二君','幽冥大君','其他九位冥君','众仙将','全球百姓','镇天神王','十万神兵','神庭守卫','全校师生','诸天万界生灵']){
  assert.equal(receive(`${name}（低声）：到了。`).source.dialogue[0].speaker,name);
 }
 for(const name of ['格式说明神王','世界规则冥君','资料要求府帅'])assert.ok(prepareStandardEpisode(`${name}（低声）：不能猜。`,'bad').diagnostics.length,name);
});

test('a system message retains its explicitly labelled goals/rewards without inventing extra speakers',()=>{
 const raw='叮！触发主线任务：【守护人间】！任务目标：阻止浩劫！任务奖励：解锁终极形态！';
 for(const head of ['系统：（VO）','系统音：','系统窗口（VO）：']){
  const {source}=receive(`${head}${raw}`);
  assert.equal(source.dialogue.length,1);assert.equal(source.dialogue[0].quote,raw);
 }
 for(const head of ['系统：（VO）到了。未知人物：请进。','人物：甲\n甲：到了。任务奖励：请进。'])assert.ok(prepareStandardEpisode(head,'bad').diagnostics.length,head);
});

test('explicitly reading numbered clauses preserves internal colons, not a new speaker per clause',()=>{
 const raw='条款一：提供安全保障……条款二：宝库作为赔偿……条款三：如有违约，保留追责权利……';
 assert.equal(receive(`柳凡：（看着协议，念出声来）${raw}`).source.dialogue[0].quote,raw);
 assert.ok(prepareStandardEpisode(`柳凡：到了。条款一：不要猜新的身份。`,'bad').diagnostics.length);
});

test('a declared parenthesized identity stays whole when the voice channel follows it',()=>{
 for(const name of ['王东（本体）','王东(本体)'])for(const gap of ['',' ','\t','\u3000'])for(const indent of ['','\u3000','\u00a0'])for(const tail of ['来了。','来了。白青禾：收到。','来了。【字幕：注意】']){
  const {source}=receive(`人物：${name}、白青禾\n${indent}${name}${gap}OS：${tail}`);
  assert.equal(source.dialogue[0].speaker,name);
  assert.equal(source.dialogue[0].channel,'OS');
  assert.equal(source.dialogue[0].cue,'OS');
 }
 for(const tail of ['来了。','来了。白青禾：收到。','来了。【字幕：注意】']){
  const {source}=receive(`人物：王东（本体）、白青禾\n王东（本体）OS：（低声）${tail}`);
  assert.deepEqual([source.dialogue[0].speaker,source.dialogue[0].channel,source.dialogue[0].cue],['王东（本体）','OS','OS；低声']);
 }
});

test('current bare acting cues keep their actor with pre/post OS and VO in all body shapes',()=>{
 for(const cue of ['憋笑','听完','声音发抖'])for(const voice of ['OS','VO'])for(const head of [`王东${cue} ${voice}：`,`王东${cue}（${voice}）：`,`王东${cue}：（${voice}）`])for(const tail of ['来了。','来了。白青禾：收到。','来了。【字幕：注意】']){
  const {source}=receive(`人物：王东、白青禾\n${head}${tail}`);
  assert.equal(source.dialogue[0].speaker,'王东');
  assert.equal(source.dialogue[0].channel,voice);
  assert.equal(source.dialogue[0].cue,`${voice}；${cue}`);
 }
});

test('negative, silent and not-yet reading cannot license unquoted clause colons as speech',()=>{
 for(const cue of ['没念出声来','不许朗读','尚未读出声','不要宣读','未念出声来','默读','念着但没念出声','只在脑海里念着','念出声来但声音没有发出']){
  const prepared=prepareStandardEpisode(`柳凡：（${cue}）条款一：提供保障。`,'bad');
  assert.ok(prepared.diagnostics.length,cue);
 }
});

test('role-shaped documentation headings never gain identity just by carrying a voice marker',()=>{
 for(const name of ['剧情梗概研究员','操作指南守卫','王国设定神王','免责声明主席','全剧概要研究员','制作大纲官员'])for(const marker of ['', '（OS）']){
  assert.ok(prepareStandardEpisode(`${name}${marker}：这里是资料。`,'bad').diagnostics.length,`${name}${marker}`);
 }
 assert.equal(receive('人物：剧情梗概研究员\n剧情梗概研究员：我是原文明确声明的角色。').source.dialogue[0].speaker,'剧情梗概研究员');
});
