import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {renderDraft,validateDraft} from './quality.mjs';
import {buildRequest,captureRules} from './core.mjs';
import * as visualStyle from './visual-style.mjs';
import {normalizeSource} from './source.mjs';
import {VERSION,PLAN_VERSION} from './shared.mjs';
import {DELTA_VERSION} from './delta.mjs';
import {createEngine} from './pipeline.mjs';
import {createStore} from './store.mjs';

const exportVersion='seedance-execution-v2';
const previousExportVersion='seedance-execution-v1';
const newExportVersion='seedance-execution-v3';
const direction='甲先攥紧拳头，再抬眼看向门口；停住的中景随目光缓推，窗光照清指节。';
const workflowText=/额外幻想关闭|遵守已有幻想选择|本单元不加入额外幻想段落|已选幻想只按|开关未开|幻想层关闭|迭代版本|审核解释/;
function fixture(){
 const source=normalizeSource({key:'seedance',title:'决定',sourceRows:[{id:'s1',text:'甲：走。'}]});
 const emotionContract={subject:'甲',contextTone:'克制',audienceEffect:'看见决定',change:'迟疑转决断',landing:'开口',retain:['原话']};
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'迟疑到决定',entryFacts:[],events:[{id:'e1',sourceRefs:['s1'],sceneKey:'室内-日',boundaryBefore:{kind:'episode_start',reason:'本集入口'},emotionContract}],workPackages:[{id:'p1',eventId:'e1',sourceRefs:['s1'],emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'u1',packageId:'p1',sourceRefs:['s1'],secondsRange:[3,5]}],fantasyCandidates:[]};
 const draft={schemaVersion:VERSION,units:[{id:'p1-u1',eventId:'e1',boundaryBefore:{kind:'episode_start',reason:'本集入口'},title:'决定',unitDirection:direction,intent:{subject:'甲',change:'迟疑转决断',landing:'开口',retain:['原话']},scene:'日 内 门厅',props:[],participants:['甲'],lighting:'窗光照亮指节。',initialState:'甲握拳站在门边。',exitState:'甲看向门口。',shots:[{id:'p1-s1',duration:4,camera:'固定中景',picture:'甲握拳后抬眼。',lighting:'窗光照亮指节',sound:'轻微衣料声',dialogueParts:[{lineId:source.dialogue[0].id,text:'走。',presentation:'画内',delivery:'平静',voiceStart:0.5,voiceEnd:1.5}],transition:'目光接下镜',sourceRefs:['s1'],contextRefs:[]}]}],fantasyRealization:[],revisionNotes:[{coordinate:'p1-u1',change:'审核解释：迭代版本已调整',preservedFunction:'原话',sourceRefs:['s1']}],unresolved:[]};
 const settings={model:'gpt-6-sol',reasoning:'medium',maxUnits:null,maxUnitSeconds:30,fantasyMode:'off',visualStyle:'三渲二，16:9；赛璐璐明暗色块。'};
 return {source,plan,draft,settings};
}
const current=f=>renderDraft({...f,seedanceExportVersion:exportVersion});
const latest=f=>renderDraft({...f,seedanceExportVersion:visualStyle.SEEDANCE_EXPORT_VERSION});
const dialogueLines=text=>text.split('\n').filter(line=>line.startsWith('台词：'));
const header=text=>text.slice(text.indexOf('[通用提示词]'),text.indexOf('\n[场景]'));
const legacyRules=()=>{const rules=captureRules();delete rules.seedanceExportVersion;return rules;};

function quotedFixture(quote,fragments=[quote],{acrossUnits=false}={}){
 const f=fixture();f.source=normalizeSource({key:'seedance',title:'决定',sourceRows:[{id:'s1',text:`甲：${quote}`}]});
 const unit=f.draft.units[0],template=unit.shots[0];
 const shots=fragments.map((text,index)=>{const shot=structuredClone(template);shot.id=`p1-s${index+1}`;
  Object.assign(shot.dialogueParts[0],{lineId:f.source.dialogue[0].id,text});return shot;});
 if(acrossUnits)f.draft.units=shots.map((shot,index)=>({...structuredClone(unit),id:`p1-u${index+1}`,shots:[shot]}));
 else unit.shots=shots;
 return f;
}

test('generated project style is executable without fantasy-switch or review commentary',()=>{
 for(const style of ['3D国漫','2D动漫','真人电影写实','古装电影写实','赛博科幻']){
  const text=visualStyle.buildVisualStyle({style,aspectRatio:'9:16'});
  assert.doesNotMatch(text,workflowText);assert.match(text,/9:16/);assert.match(text,/惯性/);assert.match(text,/口型/);assert.match(text,/OS\/VO\/系统音/);
 }
 const custom='手绘纸纹，保留道具上的“开关未开”字样';
 assert.ok(visualStyle.buildVisualStyle({style:custom}).includes(custom));
});

test('new default states common execution physics without unused carriers or negative examples',()=>{
 const text=visualStyle.buildVisualStyle();
 assert.match(text,/正常比例[^。；]*脸型[^。；]*五官结构稳定/);
 assert.match(text,/有力表情/);assert.match(text,/大幅身体动作/);
 assert.match(text,/支点/);assert.match(text,/重心/);
 assert.match(text,/制动或转体[^。；]*下一动作/);
 assert.match(text,/衣发[^。；]*惯性[^。；]*错时/);
 assert.match(text,/摄影[^。；]*动作[^。；]*结果/);assert.match(text,/受光方向明确/);
 assert.match(text,/画外\/OS\/VO\/系统音依台词标记呈现/);assert.match(text,/听者保持自己的反应/);
 assert.doesNotMatch(text,/Q版|二维载体|超常五官|不把全员|不以全场变暗|不跟随他人|按源|源剧情|源明确|遵守|选择|下文为准|后期添加/);
 for(const requirement of ['字幕条','水印','BGM'])assert.equal(text.split(requirement).length-1,1,requirement);
});

test('new export contains only project style and decided unit direction in its common header',()=>{
 const f=fixture(),before=structuredClone(f);
 for(const fantasyMode of ['off','recommended']){
  const text=current({...f,settings:{...f.settings,fantasyMode}});
  assert.equal(header(text),`[通用提示词] ${f.settings.visualStyle}\n${direction}`);
  assert.doesNotMatch(text,workflowText);assert.doesNotMatch(text,/revisionNotes|seedance-execution-v1|sourceRefs|p1-s1/);
 }
 assert.deepEqual(f,before);
});

test('ordinary dialogue omits routine labels while retaining actor, delivery, exact words and shot-relative window',()=>{
 const text=current(fixture());
 assert.ok(text.includes('台词：甲（平静｜本镜0.5-1.5s）：“走。”'));
 assert.doesNotMatch(text,/台词：[^\n]*(?:画内|对白|演法：)/);
});

test('v2 does not add a second shell to a complete source-quoted utterance and never mutates stored words',()=>{
 const f=quotedFixture('“走。”'),before=structuredClone(f),text=current(f);
 assert.ok(text.includes('台词：甲（平静｜本镜0.5-1.5s）：“走。”'));
 assert.ok(!text.includes('：““走。””'));assert.deepEqual(f,before);
 assert.deepEqual(validateDraft({...f,selection:{selectedIds:[]},unitDirectionVersion:'unit-direction-v1'}).errors,[]);
});

test('v2 suppresses only matching source-shell edges across shot and unit boundaries',()=>{
 for(const acrossUnits of [false,true]){
  const f=quotedFixture('“前半，中间，后半。”',['“前半，','中间，','后半。”'],{acrossUnits}),before=structuredClone(f),text=current(f);
  assert.ok(text.includes('：“前半，”'));assert.ok(text.includes('：“中间，”'));assert.ok(text.includes('：“后半。”'));
  assert.ok(!text.includes('：““前半，'));assert.ok(!text.includes('后半。””'));
  assert.deepEqual(f,before);
 }
});

test('v2 retains nested quotation and does not mistake disjoint quotations for one enclosing shell',()=>{
 const nested=quotedFixture('“先说“来”，再走。”',['“先说','“来”，','再走。”']),before=structuredClone(nested),text=current(nested);
 assert.ok(text.includes('：“先说”'));assert.ok(text.includes('：““来”，”'));assert.ok(text.includes('：“再走。”'));
 assert.deepEqual(nested,before);
 const disjoint=quotedFixture('“左”与“右”');assert.ok(current(disjoint).includes('：““左”与“右””'));
});

test('v2 rendering cannot repair a stored dialogue-content error by mutating the original part',()=>{
 const f=quotedFixture('“走。”',['走。']),before=structuredClone(f);
 assert.ok(current(f).includes('：“走。”'));assert.deepEqual(f,before);
 assert.ok(validateDraft({...f,selection:{selectedIds:[]},unitDirectionVersion:'unit-direction-v1'}).errors.some(e=>e.code==='DIALOGUE_CONTENT'));
});

test('v1 and unversioned exports preserve their previous source-quoted bytes',()=>{
 const f=quotedFixture('“走。”'),before=structuredClone(f);
 assert.ok(renderDraft({...f,seedanceExportVersion:previousExportVersion}).includes('甲（平静｜本镜0.5-1.5s）：““走。””'));
 assert.ok(renderDraft(f).includes('甲，画内，本镜0.5-1.5s，演法：平静：““走。””'));
 assert.deepEqual(f,before);
});

test('source channels, visibility changes and nonverbal voice types remain explicit',()=>{
 const cases=[['现场对白','speech','画外','画外'],['现场对白','speech','画外转画内','画外转画内'],['现场对白','speech','画内转画外','画内转画外'],['OS','speech','OS','OS'],['VO','speech','VO','VO'],['系统音','speech','画外','系统音·画外'],['系统音','speech','系统音','系统音'],['现场对白','roar','画外','兽吼·画外'],['现场对白','scream','画内','尖叫']];
 for(const [channel,kind,presentation,label] of cases){
  const f=fixture();Object.assign(f.source.dialogue[0],{channel,kind});f.draft.units[0].shots[0].dialogueParts[0].presentation=presentation;
  assert.ok(current(f).includes(`甲（${label}·平静｜本镜0.5-1.5s）：“走。”`),label);
 }
});

test('parsed vocalizations retain their source cue through validation and only the new export',()=>{
 for(const [cue,quote] of [['呻吟','啊。'],['呜咽哭声','呜。'],['轻哼','哼。']]){
  const f=fixture();f.source=normalizeSource({key:'vocalization',sourceRows:[{id:'s1',text:`甲（${cue}）：${quote}`}]});
  const q=f.source.dialogue[0],part=f.draft.units[0].shots[0].dialogueParts[0];
  Object.assign(part,{lineId:q.id,text:q.quote,delivery:'虚弱短促'});
  assert.deepEqual(f.source.diagnostics,[]);assert.equal(q.kind,'vocalization');assert.equal(q.cue,cue);
  assert.deepEqual(validateDraft({...f,selection:{selectedIds:[]},unitDirectionVersion:'unit-direction-v1'}).errors,[]);
  const before=structuredClone(f);
  assert.ok(current(f).includes(`甲（${cue}·虚弱短促｜本镜0.5-1.5s）：“${quote}”`),cue);
  assert.ok(renderDraft(f).includes(`甲，画内，本镜0.5-1.5s，演法：虚弱短促：“${quote}”`));
  assert.deepEqual(f,before);
 }
});

test('cross-shot fragments and all voice windows remain intact even when source words resemble workflow text',()=>{
 const f=fixture(),quote='开关未开，幻想层关闭。',q=f.source.dialogue[0],first=f.draft.units[0].shots[0];
 q.quote=quote;first.dialogueParts[0].text='开关未开，';
 const second=structuredClone(first);second.id='p1-s2';Object.assign(second.dialogueParts[0],{text:'幻想层关闭。',presentation:'画外转画内',delivery:'急促而压低',voiceStart:1.25,voiceEnd:3.5});
 f.draft.units[0].shots.push(second);const before=structuredClone(f),text=current(f);
 assert.ok(text.includes('甲（平静｜本镜0.5-1.5s）：“开关未开，”'));
 assert.ok(text.includes('甲（画外转画内·急促而压低｜本镜1.25-3.5s）：“幻想层关闭。”'));
 assert.deepEqual(validateDraft({...f,selection:{selectedIds:[]},unitDirectionVersion:'unit-direction-v1'}).errors,[]);
 assert.deepEqual(f,before);
});

test('multiple speakers keep their order and separate windows, while an unvoiced shot remains empty',()=>{
 const f=fixture(),shot=f.draft.units[0].shots[0],line={id:'q2',speaker:'乙',quote:'好！',channel:'现场对白',kind:'speech',sourceIds:['s2']};
 f.source.dialogue.push(line);shot.dialogueParts.push({lineId:line.id,text:line.quote,presentation:'画外',delivery:'短促',voiceStart:2,voiceEnd:3});
 const silent={...structuredClone(shot),id:'p1-s2',dialogueParts:[]};f.draft.units[0].shots.push(silent);
 const before=structuredClone(f),text=current(f);
 assert.ok(text.includes('台词：甲（平静｜本镜0.5-1.5s）：“走。”；乙（画外·短促｜本镜2-3s）：“好！”'));
 assert.equal((text.match(/^台词：无$/gm)||[]).length,1);assert.deepEqual(f,before);
});

test('v3 displays the unit timeline and removes only the repeated delivery speaker',()=>{
 const f=fixture(),unit=f.draft.units[0],shot=unit.shots[0];
 f.source=normalizeSource({key:'seedance',sourceRows:[{id:'s1',text:'顾衡：冠军还能是谁？念快点，我赶时间。'}]});
 const q=f.source.dialogue[0];shot.duration=5;
 Object.assign(shot.dialogueParts[0],{lineId:q.id,text:q.quote,delivery:'顾衡：带笑反问，后半催促，重读“快点”。',voiceStart:0.9,voiceEnd:4.8});
 unit.shots.unshift({...structuredClone(shot),id:'p1-s0',duration:6,dialogueParts:[]});
 const before=structuredClone(f),text=latest(f);
 assert.deepEqual(dialogueLines(text),['台词：无','台词：6.9–10.8秒｜顾衡（带笑反问，后半催促，重读“快点”）：“冠军还能是谁？念快点，我赶时间。”']);
 assert.ok(text.includes('分镜2｜6-11s｜5s'));assert.deepEqual(f,before);
 assert.deepEqual(validateDraft({...f,selection:{selectedIds:[]},unitDirectionVersion:'unit-direction-v1'}).errors,[]);
});

test('v3 does not remove other names or non-prefix mentions from delivery',()=>{
 const cases=[['甲：平静。','平静'],['甲:平静。','平静'],['甲：提到甲时放轻。','提到甲时放轻'],['乙：提醒甲。','乙：提醒甲'],['甲向乙发问。','甲向乙发问'],['甲 ：平静。','甲 ：平静'],['甲（OS）：压低。','甲（OS）：压低'],['甲甲：重读。','甲甲：重读'],['平静...','平静...']];
 for(const [delivery,expected] of cases){
  const f=fixture();f.draft.units[0].shots[0].dialogueParts[0].delivery=delivery;
  const before=structuredClone(f);
  assert.deepEqual(dialogueLines(latest(f)),[`台词：0.5–1.5秒｜甲（${expected}）：“走。”`],delivery);
  assert.deepEqual(f,before);
 }
 const f=fixture();f.source.dialogue[0].speaker='甲(替身)';f.draft.units[0].shots[0].dialogueParts[0].delivery='甲(替身)：轻声。';
 assert.deepEqual(dialogueLines(latest(f)),['台词：0.5–1.5秒｜甲(替身)（轻声）：“走。”']);
});

test('v3 gives each utterance its own line without changing order or relative windows',()=>{
 const f=fixture(),unit=f.draft.units[0],shot=unit.shots[0],line={id:'q2',speaker:'乙',quote:'好！',channel:'现场对白',kind:'speech',sourceIds:['s2']};
 f.source.dialogue.push(line);shot.dialogueParts.push({lineId:line.id,text:line.quote,presentation:'画外',delivery:'乙：短促。',voiceStart:2,voiceEnd:3});
 unit.shots.unshift({...structuredClone(shot),id:'p1-s0',duration:6,dialogueParts:[]});
 const before=structuredClone(f);
 assert.deepEqual(dialogueLines(latest(f)),['台词：无','台词：6.5–7.5秒｜甲（平静）：“走。”','台词：8–9秒｜乙（画外·短促）：“好！”']);
 assert.deepEqual(f,before);
});

test('v3 retains source channels, visibility changes and nonverbal voice labels',()=>{
 const cases=[['现场对白','speech','画外','画外'],['现场对白','speech','画外转画内','画外转画内'],['现场对白','speech','画内转画外','画内转画外'],['OS','speech','OS','OS'],['VO','speech','VO','VO'],['系统音','speech','画外','系统音·画外'],['系统音','speech','系统音','系统音'],['现场对白','roar','画外','兽吼·画外'],['现场对白','scream','画内','尖叫'],['现场对白','vocalization','画内','呻吟']];
 for(const [channel,kind,presentation,label] of cases){
  const f=fixture();Object.assign(f.source.dialogue[0],{channel,kind,cue:'呻吟'});f.draft.units[0].shots[0].dialogueParts[0].presentation=presentation;
  assert.deepEqual(dialogueLines(latest(f)),[`台词：0.5–1.5秒｜甲（${label}·平静）：“走。”`],label);
 }
});

test('v3 resets each unit timeline and rounds summed fractional times',()=>{
 const f=quotedFixture('前半，后半。',['前半，','后半。'],{acrossUnits:true}),first=f.draft.units[0],second=f.draft.units[1];
 const shot=first.shots[0];shot.duration=1;Object.assign(shot.dialogueParts[0],{voiceStart:0.1,voiceEnd:0.5});
 first.shots.unshift({...structuredClone(shot),id:'p1-s0a',duration:0.1,dialogueParts:[]},{...structuredClone(shot),id:'p1-s0b',duration:0.2,dialogueParts:[]});
 const before=structuredClone(f),sections=latest(f).split('\n\n---\n\n');
 assert.deepEqual(dialogueLines(sections[0]),['台词：无','台词：无','台词：0.4–0.8秒｜甲（平静）：“前半，”']);
 assert.deepEqual(dialogueLines(sections[1]),['台词：0.5–1.5秒｜甲（平静）：“后半。”']);
 assert.equal(second.shots[0].dialogueParts[0].voiceStart,0.5);assert.deepEqual(f,before);
});

test('v3 retains v2 source-quote handling without cleaning source dialogue',()=>{
 const fixtures=[quotedFixture('“走。”'),quotedFixture('“前半，中间，后半。”',['“前半，','中间，','后半。”']),quotedFixture('“前半，后半。”',['“前半，','后半。”'],{acrossUnits:true}),quotedFixture('“先说“来”，再走。”',['“先说','“来”，','再走。”']),quotedFixture('“左”与“右”'),quotedFixture('“走。”',['走。'])];
 const spoken=text=>dialogueLines(text).map(line=>line.slice(line.indexOf('）：')+2));
 for(const f of fixtures){const before=structuredClone(f);assert.deepEqual(spoken(latest(f)),spoken(current(f)));assert.deepEqual(f,before);}
 assert.ok(validateDraft({...fixtures.at(-1),selection:{selectedIds:[]},unitDirectionVersion:'unit-direction-v1'}).errors.some(e=>e.code==='DIALOGUE_CONTENT'));
});

test('v1 and v2 execution exports preserve their full frozen bytes',()=>{
 const f=quotedFixture('“走。”');f.draft.units[0].shots[0].dialogueParts[0].delivery='甲：平静。';
 const expected=`# 决定｜4s\n[通用提示词] 三渲二，16:9；赛璐璐明暗色块。\n${direction}\n[场景] 日 内 门厅\n[本单元道具] 无\n[本单元出场人物] 甲\n[本单元光影] 窗光照亮指节。\n[人物状态与站位前提] 甲握拳站在门边。\n分镜1｜0-4s｜4s\n机位/运镜：固定中景\n画面：甲握拳后抬眼。\n光影：窗光照亮指节\n声音：轻微衣料声\n台词：甲（甲：平静。｜本镜0.5-1.5s）：“走。”\n转场：目光接下镜\n`;
 assert.equal(current(f),expected);
 assert.equal(renderDraft({...f,seedanceExportVersion:previousExportVersion}),expected.replace('：“走。”','：““走。””'));
});

test('new projection never rewrites a saved custom style or execution field by keyword',()=>{
 const f=fixture();f.settings.visualStyle='旧保存风格：道具保留“额外幻想关闭”文字。';f.draft.units[0].unitDirection='画面里的旧稿封面印有“迭代版本”四字。';
 const text=current(f);assert.ok(text.includes(f.settings.visualStyle));assert.ok(text.includes(f.draft.units[0].unitDirection));
});

test('an unversioned saved draft preserves the previous rendered bytes including the old header',()=>{
 const f=fixture();
 const expected=`# 决定｜4s\n[通用提示词] 三渲二，16:9；赛璐璐明暗色块。\n本单元不加入额外幻想段落；源剧情明确的Q版、梦境、法术与特效照常表现；主观形变遵守正文声明的主观边界，现实状态及角色知情范围遵循原文。\n${direction}\n[场景] 日 内 门厅\n[本单元道具] 无\n[本单元出场人物] 甲\n[本单元光影] 窗光照亮指节。\n[人物状态与站位前提] 甲握拳站在门边。\n分镜1｜0-4s｜4s\n机位/运镜：固定中景\n画面：甲握拳后抬眼。\n光影：窗光照亮指节\n声音：轻微衣料声\n台词：甲，画内，本镜0.5-1.5s，演法：平静：“走。”\n转场：目光接下镜\n`;
 assert.equal(renderDraft(f),expected);
});

test('new snapshots freeze the export version without changing model schemas or request fingerprints',()=>{
 assert.equal(visualStyle.SEEDANCE_EXPORT_VERSION,newExportVersion);assert.equal(captureRules().seedanceExportVersion,newExportVersion);
 const f=fixture(),rules=legacyRules();
 for(const stage of ['plan','author','finish']){
  const payload={...f,stage,packageId:'p1',...(stage==='finish'?{previousDraft:f.draft}:{})};
  const old=buildRequest({...payload,rulesSnapshot:rules}),next=buildRequest({...payload,rulesSnapshot:{...rules,seedanceExportVersion:newExportVersion}});
  assert.deepEqual([next.inputHash,next.promptHash,next.schemaHash,next.schema],[old.inputHash,old.promptHash,old.schemaHash,old.schema]);
  for(const version of [previousExportVersion,exportVersion]){
   const previous=buildRequest({...payload,rulesSnapshot:{...rules,seedanceExportVersion:version}});
   assert.deepEqual([next.inputHash,next.promptHash,next.schemaHash,next.schema],[previous.inputHash,previous.promptHash,previous.schemaHash,previous.schema]);
  }
 }
});

test('unknown export versions are rejected instead of silently falling back to old rendering',()=>{
 const f=fixture();
 for(const version of ['seedance-future',null]){
  assert.throws(()=>renderDraft({...f,seedanceExportVersion:version}),e=>e.code==='EXPORT_VERSION');
  assert.throws(()=>buildRequest({...f,stage:'plan',rulesSnapshot:{...legacyRules(),seedanceExportVersion:version}}),e=>e.code==='RULE_SNAPSHOT');
 }
});

async function setup(t,{legacy=false,finishMode='full',planned=true,frozenExportVersion}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'v4-seedance-export-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const f=fixture(),requests=[];
 f.settings.visualStyle=legacy?'旧保存画风；基础运镜不因额外幻想关闭而禁用。':visualStyle.buildVisualStyle();
 const engine=createEngine({directory,modelRunner:async request=>{
  requests.push(request);
  const output=structuredClone(request.stage==='plan'?f.plan:request.finishMode==='delta'?{schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:[],replacements:[{replaces:['p1-u1'],units:f.draft.units,fantasyRealization:[]}],revisionNotes:[],unresolved:[]}:f.draft);
  return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{inputTokens:10,outputTokens:20,totalTokens:30}};
 }});
 await engine.create({id:'export',source:f.source,settings:f.settings});
 if(legacy)await createStore(directory).update('export',d=>{delete d.rulesSnapshot.seedanceExportVersion;return d;});
 else if(frozenExportVersion)await createStore(directory).update('export',d=>{d.rulesSnapshot.seedanceExportVersion=frozenExportVersion;return d;});
 if(planned){
  await engine.execute('export',{stage:'plan',attemptId:'plan'});
  await engine.execute('export',{stage:'author',packageId:'p1',attemptId:'author'});
  await engine.execute('export',{stage:'finish',finishMode,packageId:'p1',attemptId:'finish'});
 }
 return {engine,requests,f};
}

for(const finishMode of ['full','delta'])test(`new ${finishMode} assembly uses the frozen export format without changing drafts, source or receipts`,async t=>{
 const {engine,requests}=await setup(t,{finishMode}),before=await engine.read('export'),calls=requests.length,d=await engine.assemble('export');
 assert.equal(d.rulesSnapshot.seedanceExportVersion,newExportVersion);assert.equal(d.status,'text_ready_for_review');assert.deepEqual(d.assembly.validation.errors,[]);
 assert.ok(d.assembly.text.includes('台词：0.5–1.5秒｜甲（平静）：“走。”'));assert.doesNotMatch(d.assembly.text,workflowText);
 for(const key of ['source','adopted','operations','candidates','settings'])assert.deepEqual(d[key],before[key],key);
 assert.equal(requests.length,calls);assert.deepEqual(d.assembly.draft.units,before.adopted[0].draft.units);
});

test('saved unversioned work assembles identically without model calls and cannot silently upgrade after planning',async t=>{
 const {engine,requests}=await setup(t,{legacy:true}),before=await engine.read('export'),calls=requests.length;
 await assert.rejects(engine.refreshRules('export'),e=>e.code==='RULES_PROTOCOL_CHANGE');assert.deepEqual(await engine.read('export'),before);
 const d=await engine.assemble('export');assert.equal(d.status,'text_ready_for_review');
 assert.equal(d.assembly.text,renderDraft({draft:d.assembly.draft,source:d.source,settings:d.settings}));
 assert.ok(d.assembly.text.includes('台词：甲，画内，本镜0.5-1.5s，演法：平静：“走。”'));assert.ok(d.assembly.text.includes(before.settings.visualStyle));
 assert.equal(requests.length,calls);for(const key of ['source','adopted','operations','candidates','settings'])assert.deepEqual(d[key],before[key],key);
});

for(const frozenExportVersion of [previousExportVersion,exportVersion])test(`saved ${frozenExportVersion} work keeps its frozen assembly bytes and cannot silently refresh to v3 after planning`,async t=>{
 const {engine,requests}=await setup(t,{frozenExportVersion}),before=await engine.read('export'),calls=requests.length;
 await assert.rejects(engine.refreshRules('export'),e=>e.code==='RULES_PROTOCOL_CHANGE');assert.deepEqual(await engine.read('export'),before);
 const d=await engine.assemble('export');assert.equal(d.rulesSnapshot.seedanceExportVersion,frozenExportVersion);
 assert.equal(d.assembly.text,renderDraft({draft:d.assembly.draft,source:d.source,settings:d.settings,seedanceExportVersion:frozenExportVersion}));
 assert.ok(d.assembly.text.includes('台词：甲（平静｜本镜0.5-1.5s）：“走。”'));
 assert.equal(requests.length,calls);for(const key of ['source','adopted','operations','candidates','settings'])assert.deepEqual(d[key],before[key],key);
});

test('an explicit refresh before planning adopts the export version without rewriting saved settings',async t=>{
 const {engine}=await setup(t,{legacy:true,planned:false}),before=await engine.read('export'),d=await engine.refreshRules('export');
 assert.equal(d.rulesSnapshot.seedanceExportVersion,newExportVersion);assert.deepEqual(d.settings,before.settings);
});
