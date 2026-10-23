import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {prepareStandardEpisode, deriveStandardScriptLines} from '../lib/standard-script-plan';
import {compileStandardScript} from '../lib/standard-script';
import {prepareEpisodeReception, prepareEpisodeScript} from '../lib/standard-script-reception';
import {applyScriptResolutions} from '../lib/script-resolution-plan';

const require=createRequire(import.meta.url);
const {standardPackageSource}=require('../runtime/storyboard-v4/core/standard-source.mjs');
const {normalizeSource}=require('../runtime/storyboard-v4/core/source.mjs');
function accepted(text:string,knownSpeakers:string[]=[]){
 const prepared=prepareStandardEpisode(text,'episode-7',{knownSpeakers});
 assert.deepEqual(prepared.diagnostics,[]);
 assert.ok(prepared.compiled);
 assert.equal(prepared.index.text,text);
 assert.equal(deriveStandardScriptLines(prepared).map(line=>line.text).join(''),text);
 assert.deepEqual(prepared.plan.entries.flatMap(entry=>entry.unitIds),prepared.index.units.map(unit=>unit.id));
 const source=normalizeSource(standardPackageSource(prepared.compiled.package,{key:'synthetic',sourceText:text}));
 assert.deepEqual(normalizeSource(JSON.parse(JSON.stringify(source))),source);
 assert.equal(prepared.compiled.receipt.semantic,'NOT_RUN');
 assert.equal(prepared.compiled.receipt.acceptedForDispatch,false);
 return {prepared,source,entries:prepared.compiled.package.script.entries};
}
function resign(pkg:any){
 const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;
 const {packageId,...rest}=pkg,{receipt,...fidelity}=rest.fidelity;
 const hash=createHash('sha256').update(JSON.stringify(canonical({...rest,fidelity})),'utf16le').digest('hex');
 pkg.packageId=`standard:${hash}`;receipt.packageDigest=hash;
}

test('episode title metadata is structural only in the explicit episode preamble',()=>{
 for(const eol of ['\n','\r\n','\r']){
  const text=['第七集','','集名：门后的钟','7-1 日 内 控制室','林岚：到了。',''].join(eol);
  const {entries,source}=accepted(text);
  assert.deepEqual(entries.filter(entry=>entry.kind==='SCENE_METADATA').map(entry=>entry.text),['集名：门后的钟']);
  assert.ok(!entries.some(entry=>entry.kind==='ONSCREEN_TEXT'));
  assert.deepEqual(source.dialogue.map((voice:any)=>voice.quote),['到了。']);
 }
 for(const text of ['集名：没有集头','第七集\n7-1 日 内 控制室\n集名：已经入场','第七集\n△门开了。\n集名：已经开始正文','第七集\n集名：混入：额外标签','第七集\n集名：△混入动作','第七集\n集名：']){
  const p=prepareStandardEpisode(text,'unsafe-title');assert.equal(p.compiled,null,text);assert.ok(p.diagnostics.some(d=>d.code==='UNKNOWN_COLON_LINE'),text);
 }
 assert.equal(prepareStandardEpisode('第七集\n集名：门后的钟\n△门开了。','legacy-title',{syntax:'legacy'}).compiled,null);
});

test('closed flashback and bracketed time-side-location contexts remain exact structure',()=>{
 for(const eol of ['\n','\r\n','\r']){
  const text=['第一集','1-1 日 外 山口','林岚：看见了。','[闪回开始]','[多年前 深夜 内 山口哨所]','林岚：原来如此。','[旧哨所 日 外 山道]','△门开了。','[闪回结束]',''].join(eol);
  const {entries,source}=accepted(text);
  assert.deepEqual(entries.filter(entry=>entry.target==='STRUCTURE').map(entry=>entry.kind),['EPISODE_HEADING','SCENE_HEADING','SCENE_METADATA','SCENE_HEADING','SCENE_HEADING','SCENE_METADATA']);
  assert.deepEqual(source.dialogue.map((voice:any)=>voice.quote),['看见了。','原来如此。']);
  assert.ok(!entries.some(entry=>entry.kind==='ONSCREEN_TEXT'));
 }
 for(const label of ['[未知提示]','[闪回开始','[闪回结束]附加正文','[日 内]','[哨所 日]','[哨所 日 内：林岚]','[哨所 日 内。]','[哨所 日 内 夜]','【闪回开始】']){
  const p=prepareStandardEpisode(`${label}\n△门开了。`,'unsafe-bracket');assert.equal(p.compiled,null,label);assert.ok(p.diagnostics.some(d=>d.line===1&&d.code==='UNKNOWN_TYPED_LINE'),label);
 }
 const {entries}=accepted('【作者资料】\n制作建议。\n[多年前 深夜 内 山口哨所]\n△门开了。');
 assert.deepEqual(entries.map(entry=>entry.kind),['SCENE_HEADING','ACTION'],'a source scene also ends author material');
});

test('finite functional roles and declared numbered groups keep complete source labels',()=>{
 for(const name of ['征调者甲','应征者乙','受试者3','宿主甲','执勤官','年轻执勤官','巡逻伤员','青年道士','冷土班长']){
  const {source}=accepted(`林岚：到了。\n${name}（紧张）：请进。`);
  assert.deepEqual(source.dialogue.map((voice:any)=>[voice.speaker,voice.quote]),[['林岚','到了。'],[name,'请进。']]);
 }
 const {source}=accepted('人物：夜航使们\n林岚：到了。\n夜航使甲（低声）：请进。');
 assert.equal(source.dialogue[1].speaker,'夜航使甲');
 for(const name of ['未知者甲','未知主乙','说明者甲','注意事项甲','字段标签A','陌生标签']){
  const p=prepareStandardEpisode(`${name}（紧张）：不能猜。`,'unsafe-role');assert.equal(p.compiled,null,name);assert.ok(p.diagnostics.some(d=>d.code==='UNKNOWN_SPEAKER'||d.code==='UNKNOWN_COLON_LINE'),name);
 }
 assert.equal(prepareStandardEpisode('征调者甲（紧张）：请进。','legacy-role',{syntax:'legacy'}).compiled,null);
});

for(const [label,action] of [
 ['negated','△没有一名青铜甲使者撑起。'],
 ['conditional','△若一名青铜甲使者起身，林岚便离开。'],
 ['depiction','△一名青铜甲使者起身的画像挂在墙上。'],
])test(`a ${label} action mention cannot certify an undeclared full group speaker`,()=>{
 const p=prepareStandardEpisode(`人物：使者\n${action}\n青铜甲使者（紧张）：我到了。`,'unsafe-group-actor');
 assert.equal(p.compiled,null);assert.ok(p.diagnostics.some(d=>d.line===3&&d.code==='UNKNOWN_SPEAKER'));
});

test('a full group speaker needs an explicit source-bound decision instead of inferred identity',()=>{
 const text='人物：使者\n△林岚抬手，又一名青铜甲使者撑起，披风落地。\n青铜甲使者（紧张）：我到了。';
 assert.equal(prepareStandardEpisode(text,'episode-7').compiled,null);
 const resolved=applyScriptResolutions(text,'episode-7',[{startLine:3,endLine:3,type:'DIALOGUE',speaker:'青铜甲使者',channel:'SPEECH'}]);
 assert.ok(resolved.compiled);assert.equal(resolved.index.text,text);
 const source=normalizeSource(standardPackageSource(resolved.compiled.package,{key:'synthetic',sourceText:text}));
 assert.deepEqual(source.dialogue.map((voice:any)=>[voice.speaker,voice.quote]),[['青铜甲使者','我到了。']]);
});

test('transaction and explicit spoken predicates retain their business colons in one utterance',()=>{
 for(const [cue,quote] of [['开价','旧任务作废，换新约：你们守哨所，报酬三十。'],['','工种变更：请到西门。'],['翻出收据','先看清：这张票据。'],['','三件事：关窗，熄灯，锁门。'],['','先算费用：三十。']]){
  const head=`林岚${cue?`（${cue}）`:''}：`;
  for(const tail of ['', '程野：收到。', '【字幕：稍后】']){
   const {source}=accepted(head+quote+tail);
   assert.equal(source.dialogue[0].quote,quote);
   assert.equal(source.dialogue.length,tail.startsWith('程野')?2:1);
  }
 }
 for(const quote of ['你好。未知标签：别走。','我告诉学生甲：别走。','到了。换约者甲：回去。','到了。换新约（紧张）：回去。'])assert.equal(prepareStandardEpisode(`林岚：${quote}`,'unsafe-colon').compiled,null,quote);
 const {source}=accepted('林岚：开门。程野：收到。');
 assert.deepEqual(source.dialogue.map((voice:any)=>voice.speaker),['林岚','程野']);
});

test('a unique channel between cue fragments is source-bound through standalone, group and mixed reception',()=>{
 for(const eol of ['\n','\r\n','\r'])for(const post of [false,true])for(const marker of ['VO','os']){
  const head=post?`林岚：（大笑，${marker}，前沿通讯）`:`林岚（大笑，${marker}，前沿通讯）：`;
  for(const tail of ['好！','好！程野：收到。','好！【字幕：稍后】']){
   const {prepared,source}=accepted(head+tail+eol);
   const entry=prepared.compiled!.package.script.entries[0];
   const voice=entry.kind==='DIALOGUE_GROUP'?entry.dialogues![0]:entry.kind==='BODY_GROUP'?entry.children![0]:entry;
   assert.ok('speaker' in voice);
   assert.equal(voice.cue?.text,'大笑，前沿通讯');
   assert.deepEqual(voice.cue?.parts.map((part:any)=>prepared.index.text.slice(part.start,part.end)),['大笑，','前沿通讯']);
   assert.equal(voice.channelSource?.text,marker);
   assert.equal(voice.channel,marker.toUpperCase());
   assert.equal(source.dialogue[0].quote,'好！');
   assert.equal(source.dialogue[0].cue,`${marker}；大笑，前沿通讯`);
   assert.equal(prepareEpisodeReception({number:7,content:head+tail+eol},null).scriptReception.ready,true);
  }
 }
 for(const cue of ['大笑，OS，VO，前沿通讯','大笑，OS/VO，前沿通讯','大笑，O.S.，前沿通讯'])assert.equal(prepareStandardEpisode(`林岚（${cue}）：好！`,'unsafe-cue').compiled,null,cue);
 assert.equal(prepareStandardEpisode('人物：林岚\n林岚（大笑，VO，前沿通讯）：好！','legacy-cue',{syntax:'legacy'}).compiled,null);
});

test('compiler and independent receiver reject cue-gap tampering even with a resigned receipt',()=>{
 const text='林岚（大笑，VO，前沿通讯）：好！程野：收到。';
 const {prepared}=accepted(text);
 for(const mutate of [
  (voice:any)=>{voice.cue[0].end++;},
  (voice:any)=>{voice.cue[1].start++;},
  (voice:any)=>{voice.cue.reverse();},
  (voice:any)=>{voice.channel='SPEECH';},
  (voice:any)=>{voice.channelSource[0].end--;},
 ]){
  const plan=structuredClone(prepared.plan);mutate((plan.entries[0] as any).dialogues[0]);
  assert.throws(()=>compileStandardScript(prepared.index,plan));
 }
 for(const mutate of [
  (voice:any)=>{voice.cue.parts[0].end++;voice.cue.text='大笑，V前沿通讯';},
  (voice:any)=>{voice.cue.parts[1].start++;voice.cue.text='大笑，沿通讯';},
  (voice:any)=>{voice.channel='SPEECH';},
 ]){
  const pkg=structuredClone(prepared.compiled!.package);mutate(pkg.script.entries[0].dialogues![0]);resign(pkg);
  assert.throws(()=>standardPackageSource(pkg,{key:'synthetic',sourceText:text}));
 }
});

for(const shape of ['standalone','group','mixed'])for(const post of [false,true])for(const absorb of [false,true]){
 const text=(post?'林岚：（大笑，VO，前沿通讯）':'林岚（大笑，VO，前沿通讯）：')+'好！'+(shape==='group'?'程野：收到。':shape==='mixed'?'【字幕：稍后】':'');
 const label=`${shape} ${post?'post':'pre'} split cue ${absorb?'cannot absorb VO into cue':'must keep source channel'}`;
 test(`compiler ${label}`,()=>{
  const {prepared}=accepted(text),plan=structuredClone(prepared.plan),entry=plan.entries[0] as any;
  const voice=entry.dialogues?.[0]??entry.children?.[0]??entry;voice.channel='SPEECH';
  if(absorb){
   const first=voice.cue[0],end=voice.cue.at(-1).end;
   voice.cue=[{...first,end}];voice.channelSource=null;
   voice.layout=voice.layout.filter((part:any)=>part.start<first.start||part.end>end);
  }
  assert.throws(()=>compileStandardScript(prepared.index,plan));
 });
 test(`receiver ${label} even with a resigned synthetic receipt`,()=>{
  const {prepared}=accepted(text),pkg=structuredClone(prepared.compiled!.package),entry=pkg.script.entries[0];
  const voice=(entry.dialogues?.[0]??entry.children?.[0]??entry) as any;voice.channel='SPEECH';
  if(absorb){
   const first=voice.cue.parts[0],end=voice.cue.parts.at(-1).end;
   voice.cue={text:text.slice(first.start,end),parts:[{...first,end}]};voice.channelSource=null;
   voice.layout=voice.layout.filter((part:any)=>part.start<first.start||part.end>end);
  }
  resign(pkg);assert.throws(()=>standardPackageSource(pkg,{key:'synthetic',sourceText:text}));
 });
}

test('legacy explanation labels retain their frozen parenthetical colon syntax',()=>{
 const text='人物：林岚\n林岚：我说，事情如下（强调）：五十。';
 const p=prepareStandardEpisode(text,'legacy-explanation',{syntax:'legacy'});
 assert.deepEqual(p.diagnostics,[]);assert.ok(p.compiled);
 assert.equal(p.compiled.package.script.entries[1].text,'我说，事情如下（强调）：五十。');
 assert.equal(prepareStandardEpisode(text,'current-explanation').compiled,null);
});

for(const receiver of [false,true])test(`split cue cannot be hidden inside the submitted speaker field (${receiver?'receiver':'compiler'})`,()=>{
 const text='林岚（大笑，VO，前沿通讯）：好！',{prepared}=accepted(text),end=text.indexOf('）')+1;
 if(receiver){
  const pkg=structuredClone(prepared.compiled!.package),voice=pkg.script.entries[0];
  voice.speaker={text:text.slice(0,end),parts:[{...voice.speaker!.parts[0],end}]};voice.cue=null;voice.channelSource=null;voice.channel='SPEECH';
  voice.layout=voice.layout.filter(part=>part.end>end).map(part=>({...part,start:Math.max(part.start,end)}));
  resign(pkg);assert.throws(()=>standardPackageSource(pkg,{key:'synthetic',sourceText:text}));
 }else{
  const plan=structuredClone(prepared.plan),voice=plan.entries[0];assert.ok(voice.target==='BODY'&&voice.kind==='DIALOGUE');
  voice.speaker=[{...voice.speaker[0],end}];voice.cue=null;voice.channelSource=null;voice.channel='SPEECH';
  voice.layout=voice.layout.filter(part=>part.end>end).map(part=>({...part,start:Math.max(part.start,end)}));
  assert.throws(()=>compileStandardScript(prepared.index,plan));
 }
});

test('colonless multiline split cues retain exact fields through all supported line endings and indentation',()=>{
 for(const marker of ['VO','os'])for(const eol of ['\n','\r\n','\r'])for(const indent of ['','\t']){
  const text=`人物：林岚${eol}${indent}林岚（大笑，${marker}，前沿通讯） \t${eol}好！`;
  const {prepared,source}=accepted(text),voice=prepared.compiled!.package.script.entries[1];
  assert.equal(voice.channel,marker.toUpperCase());assert.equal(voice.channelSource?.text,marker);
  assert.equal(voice.cue?.text,'大笑，前沿通讯');assert.equal(source.dialogue[0].quote,'好！');
 }
});

for(const marker of ['VO','os'])for(const [eolName,eol] of [['LF','\n'],['CRLF','\r\n'],['CR','\r']])for(const indent of ['','\t'])for(const mutation of ['channel','cue-absorption','header-absorption'])for(const receiver of [false,true]){
 test(`colonless ${marker}/${eolName}/${indent?'tab':'none'} ${mutation} rejects in ${receiver?'receiver':'compiler'}`,()=>{
  const text=`人物：林岚${eol}${indent}林岚（大笑，${marker}，前沿通讯） \t${eol}好！`,{prepared}=accepted(text);
  const outside=(parts:any[],start:number,end:number)=>parts.flatMap(part=>part.end<=start||part.start>=end?[part]:[
   ...(part.start<start?[{...part,end:start}]:[]),...(part.end>end?[{...part,start:end}]:[]),
  ]);
  const mutate=(voice:any,compiled:boolean)=>{
   voice.channel='SPEECH';
   if(mutation==='channel')return;
   const field=mutation==='cue-absorption'?'cue':'speaker',original=compiled?voice[field].parts:voice[field];
   const first=original[0],end=mutation==='cue-absorption'?original.at(-1).end:text.indexOf('）',first.start)+1;
   const parts=[{...first,end}];voice[field]=compiled?{text:text.slice(first.start,end),parts}:parts;
   voice.layout=outside(voice.layout,first.start,end);voice.channelSource=null;
   if(mutation==='header-absorption')voice.cue=null;
  };
  if(receiver){
   const pkg=structuredClone(prepared.compiled!.package);mutate(pkg.script.entries[1],true);resign(pkg);
   assert.throws(()=>standardPackageSource(pkg,{key:'synthetic',sourceText:text}));
  }else{
   const plan=structuredClone(prepared.plan);mutate(plan.entries[1],false);
   assert.throws(()=>compileStandardScript(prepared.index,plan));
  }
 });
}

test('saved resolutions and exact-source speaker decisions remain authoritative',()=>{
 const content='人物：林岚\n林岚（低声）：我（苦笑）到了。',episode={number:7,content};
 const frozen=prepareStandardEpisode(content,'episode-7',{syntax:'legacy'});
 assert.ok(frozen.compiled);
 const entry=frozen.plan.entries[1];assert.ok(entry.target==='BODY'&&entry.kind==='DIALOGUE');
 frozen.speakerDecisions={version:'script-speaker-decisions-v1',sourceVersion:frozen.index.sourceVersion,entries:[{entryId:entry.id,speaker:structuredClone(entry.speaker),channel:entry.channel}]};
 const before=JSON.stringify(frozen);
 const received=prepareEpisodeScript(episode,null,frozen,{inlinePerformance:false});
 assert.deepEqual(received,frozen);
 assert.equal(JSON.stringify(frozen),before);
 const bad=structuredClone(frozen);bad.speakerDecisions!.sourceVersion='stale';
 assert.throws(()=>prepareEpisodeScript(episode,null,bad),/UNSUPPORTED_SPEAKER_DECISIONS/);
 const failedText='人物：林岚\n林岚（大笑，VO，前沿通讯）：好！';
 const unresolved=prepareStandardEpisode(failedText,'episode-7',{syntax:'legacy'});
 assert.equal(unresolved.compiled,null);
 const failedBefore=JSON.stringify(unresolved);
 assert.deepEqual(prepareEpisodeScript({number:7,content:failedText},null,unresolved),unresolved);
 assert.equal(JSON.stringify(unresolved),failedBefore,'saved unresolved classifications do not gain the new grammar');
});
