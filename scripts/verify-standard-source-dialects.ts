import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {prepareStandardEpisode} from '../lib/standard-script-plan';
import {prepareEpisodeReception} from '../lib/standard-script-reception';

const require=createRequire(import.meta.url);
const {standardPackageSource}=require('../runtime/storyboard-v4/core/standard-source.mjs');
const {normalizeSource}=require('../runtime/storyboard-v4/core/source.mjs');
const accepted=(text:string,knownSpeakers:string[]=[])=>{
 const result=prepareStandardEpisode(text,'source-dialects',{knownSpeakers});
 assert.deepEqual(result.diagnostics,[],text);assert.ok(result.compiled);
 assert.equal(result.index.text,text);
 assert.equal(result.index.units.map(u=>u.text).join(''),text);
 assert.deepEqual(result.plan.entries.flatMap(e=>e.unitIds),result.index.units.map(u=>u.id));
 const source=normalizeSource(standardPackageSource(result.compiled.package,{key:'ep',sourceText:text}));
 assert.deepEqual(normalizeSource(JSON.parse(JSON.stringify(source))),source);
 return {result,source};
};

test('explicit unnumbered scene headers terminate dialogue without becoming a speaker',()=>{
 for(const separator of [' ','\t','：',':'])for(const eol of ['\n','\r\n','\r']){
  const text=`第一集${eol}场景${separator}工作室（快切）${eol}林岚：我看见了。${eol}场景${separator}走廊${eol}△门关上。${eol}`;
  const {result,source}=accepted(text);
  assert.deepEqual(result.compiled!.package.script.entries.filter(e=>e.kind==='SCENE_HEADING').map(e=>e.text),[`场景${separator}工作室（快切）`,`场景${separator}走廊`]);
  assert.deepEqual(source.dialogue.map((d:any)=>[d.speaker,d.quote]),[['林岚','我看见了。']]);
 }
});

test('role and collective source speakers do not require generated asset aliases',()=>{
 for(const name of ['众人','助理','闺蜜A','闺蜜B','监控员A','监控员B','男考生A','女考生B','护士乙','工作人员3']){
  const quote='他说：“别动：等我回来。”';
  const {source}=accepted(`${name}（低声）：${quote}`);
  assert.deepEqual(source.dialogue.map((d:any)=>[d.speaker,d.cue,d.quote]),[[name,'低声',quote]]);
 }
});

test('explicit Q-version source labels preserve depiction and complete source identity',()=>{
 for(const name of ['陈曜Q版','Q版林岚']){
  const {source}=accepted(`${name}：这也太刺激了！`);
  assert.deepEqual(source.dialogue.map((d:any)=>[d.speaker,d.quote]),[[name,'这也太刺激了！']]);
 }
 assert.equal(prepareStandardEpisode('未知标签Q版：不要猜。','unknown-q').compiled,null);
});

test('system-window statements remain exact source speaker and cue, not an invented physical cast',()=>{
 const text='系统窗口（系统）：叮！是否继续？\n林岚：继续。\n系统窗口：成功！\n系统音：连接就绪。';
 const {source}=accepted(text);
 assert.deepEqual(source.dialogue.map((d:any)=>[d.speaker,d.cue,d.quote,d.channel]),[
  ['系统窗口','系统','叮！是否继续？','现场对白'],['林岚','','继续。','现场对白'],
  ['系统窗口','','成功！','现场对白'],['系统音','','连接就绪。','系统音'],
 ]);
});

test('combined writer dialect is accepted with no catalogue and produces exact third-stage lines',()=>{
 const text='第一集\n场景 工作室（快切）\n林岚：我回来了。\n林岚Q版：真惊险！\n众人（大笑）：终于！\n助理：请进。\n闺蜜B：等等！\n场景 门口\n监控员A（惊叫）：有人！\n男考生B（带着哭腔）：别关门！\n系统窗口（系统）：叮！\n系统窗口：连接完成。';
 const received=prepareEpisodeReception({number:1,content:text},null);
 assert.equal(received.scriptReception.ready,true,JSON.stringify(received.scriptReception.diagnostics));
 const {source}=accepted(text);
 assert.equal(source.dialogue.length,9);
 assert.deepEqual(source.dialogue.map((d:any)=>d.quote),['我回来了。','真惊险！','终于！','请进。','等等！','有人！','别关门！','叮！','连接完成。']);
});

test('unknown notes, missing speakers and genuinely ambiguous continuations remain blocked',()=>{
 for(const text of ['未知标签：（低声）仅供参考。','林岚备注：（低声）不确定。','系统说明：（低声）仅为说明。','场景说明（低声）：保留待核对。','：缺少说者。','林岚：说完了。\n她没有走。']){
  const p=prepareStandardEpisode(text,'unsafe');assert.ok(p.diagnostics.length,text);assert.equal(p.compiled,null,text);
 }
 const legacy=prepareStandardEpisode('人物：林岚\n林岚：回来。\n场景 走廊','frozen',{syntax:'legacy'});
 assert.ok(legacy.diagnostics.length,'Legacy parsing is not retroactively upgraded.');
});
