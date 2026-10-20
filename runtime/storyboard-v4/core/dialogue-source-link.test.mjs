import test from 'node:test';
import assert from 'node:assert/strict';
import * as quality from './quality.mjs';
import {normalizeSource} from './source.mjs';

const marker='dialogue-source-link-v1';
const make=(quote='嗯。',speaker='昭翎')=>{
 const source=normalizeSource({key:'entry',sourceRows:[
  {id:'entry:line-19',line:19,text:`${speaker}：${quote}`},
  {id:'entry:line-20',line:20,text:'△昭翎退到山石后。'}],contextRows:[],entryFacts:[]});
 const q=source.dialogue[0],refs=source.sourceRows.map(r=>r.id);
 const plan={unitPackingPolicy:'event-first-v1',events:[{id:'E1',sourceRefs:[...refs]}],workPackages:[{id:'WP1',eventId:'E1',sourceRefs:[...refs]}],fantasyCandidates:[]};
 const part={lineId:q.id,text:q.quote,presentation:q.channel==='现场对白'?'画内':q.channel,delivery:'短促应下',voiceStart:0,voiceEnd:0.35};
 const shot={id:'WP1_S1',duration:2.4,camera:'斜后中远景',picture:'昭翎应声后退到山石后。',lighting:'日光',sound:'短应声后接蹄声',dialogueParts:[part],transition:'接下镜',sourceRefs:[refs[1]],contextRefs:[]};
 const unit={id:'WP1_U1',eventId:'E1',boundaryBefore:{kind:'episode_start',reason:'本集开场'},title:'退入遮挡',intent:{subject:'昭翎',change:'应下后退',landing:'隐入石后',retain:['保留应声与退后']},scene:'山谷，日外',props:[],participants:['昭翎'],lighting:'日光',initialState:'昭翎在山石边。',exitState:'昭翎隐入山石后。',shots:[shot]};
 return {source,plan,draft:{schemaVersion:'performance-core-v4',units:[unit],fantasyRealization:[]},settings:{maxUnitSeconds:30},q};
};
const normalize=(f,version=marker)=>quality.normalizeDraft(f.draft,f.source,{plan:f.plan,dialogueSourceLinkVersion:version});
const check=(f,draft=f.draft)=>quality.validateDraft({draft,source:f.source,plan:f.plan,settings:f.settings,selection:{selectedIds:[]}});
const first=f=>f.draft.units[0].shots[0];
const links=changes=>changes.filter(c=>c.reason==='verified_dialogue_source_link');

test('新接收合同补挂已验证对白的唯一源行，保留正文与原生对象',()=>{
 const f=make(),before=structuredClone(f),result=normalize(f);
 assert.deepEqual(result.draft.units[0].shots[0].sourceRefs,['entry:line-20','entry:line-19']);
 assert.equal(quality.DIALOGUE_SOURCE_LINK_VERSION,marker);
 assert.deepEqual(check(f,result.draft).errors,[]);
 assert.deepEqual(f,before);
 const expected=structuredClone(f.draft);expected.units[0].shots[0].sourceRefs.push(f.q.rowId);
 assert.deepEqual(result.draft,expected);
 assert.deepEqual(links(result.changes),[{coordinate:'WP1_S1',field:'sourceRefs',from:['entry:line-20'],to:['entry:line-20','entry:line-19'],action:'derive',reason:'verified_dialogue_source_link',version:marker,lineId:f.q.id,sourceId:f.q.rowId,speaker:'昭翎',sourcePartRange:[0,2]}]);
 assert.deepEqual(links(normalize({...f,draft:result.draft}).changes),[]);
});

test('没有新marker的旧稿逐字保持原接收结果',()=>{
 for(const version of [undefined,'future-unknown-version']){
  const f=make(),result=quality.normalizeDraft(f.draft,f.source,{plan:f.plan,dialogueSourceLinkVersion:version});
  assert.deepEqual(result.draft,f.draft);assert.deepEqual(result.changes,[]);
  assert.ok(check(f,result.draft).errors.some(e=>e.code==='SOURCE_COVERAGE'));
 }
});

test('完整原句按连续片段跨镜或跨单元时分别关联同一真实源行',()=>{
 for(const crossUnit of [false,true]){
  const f=make('别怕，我在。'),shot=first(f),second=structuredClone(shot);
  shot.dialogueParts[0].text='别怕，';second.id='WP1_S2';second.dialogueParts[0].text='我在。';
  if(crossUnit){const unit=structuredClone(f.draft.units[0]);unit.id='WP1_U2';unit.boundaryBefore={kind:'capacity',reason:'延续同句'};unit.shots=[second];f.draft.units.push(unit);}
  else f.draft.units[0].shots.push(second);
  const result=normalize(f);
  assert.deepEqual(links(result.changes).map(c=>c.sourcePartRange),[[0,3],[3,6]]);
  assert.ok(result.draft.units.flatMap(u=>u.shots).every(s=>s.sourceRefs.includes(f.q.rowId)));
  assert.deepEqual(check(f,result.draft).errors,[]);
 }
});

test('同文异说者只用精确lineId绑定，不按台词文本选行',()=>{
 const f=make(),second={id:'entry:line-21',line:21,text:'随从：嗯。'};
 f.source=normalizeSource({...f.source,sourceRows:[...f.source.sourceRows,second],dialogue:undefined});
 const q=f.source.dialogue[1],shot=structuredClone(first(f));shot.id='WP1_S2';shot.dialogueParts[0].lineId=q.id;
 f.draft.units[0].shots.push(shot);f.plan.events[0].sourceRefs.push(second.id);f.plan.workPackages[0].sourceRefs.push(second.id);
 const result=normalize(f),shots=result.draft.units[0].shots;
 assert.deepEqual(shots.map(s=>s.sourceRefs),[['entry:line-20','entry:line-19'],['entry:line-20','entry:line-21']]);
 assert.deepEqual(links(result.changes).map(c=>c.speaker),['昭翎','随从']);
 assert.deepEqual(check(f,result.draft).errors,[]);
});

const invalid=[
 ['未知lineId',f=>first(f).dialogueParts[0].lineId='other:D1'],
 ['改词',f=>first(f).dialogueParts[0].text='好。'],
 ['漏词',f=>first(f).dialogueParts[0].text='嗯'],
 ['空片段',f=>first(f).dialogueParts[0].text=''],
 ['重复片段',f=>{const s=first(f);s.dialogueParts.push({...s.dialogueParts[0],voiceStart:0.4,voiceEnd:0.75});}],
 ['错误声道',f=>first(f).dialogueParts[0].presentation='VO'],
 ['现场对白不能转系统音',f=>first(f).dialogueParts[0].presentation='系统音'],
 ['未知呈现',f=>first(f).dialogueParts[0].presentation='任意呈现'],
 ['缺演法',f=>first(f).dialogueParts[0].delivery=''],
 ['负声窗',f=>first(f).dialogueParts[0].voiceStart=-1],
 ['倒声窗',f=>first(f).dialogueParts[0].voiceEnd=0],
 ['声窗越镜',f=>first(f).dialogueParts[0].voiceEnd=3],
 ['非数声窗',f=>first(f).dialogueParts[0].voiceStart='0'],
 ['缺sourceRefs',f=>delete first(f).sourceRefs],
 ['坏sourceRefs',f=>first(f).sourceRefs=null],
 ['未知源引用',f=>first(f).sourceRefs.push('unknown')],
 ['重复源引用',f=>first(f).sourceRefs.push('entry:line-20')],
 ['坏contextRefs',f=>first(f).contextRefs='entry:line-20'],
 ['未知前情引用',f=>first(f).contextRefs=['unknown']],
 ['缺dialogueParts',f=>delete first(f).dialogueParts],
 ['坏dialogueParts',f=>first(f).dialogueParts=[null]],
 ['源说者被改',f=>f.source.dialogue[0].speaker='另一说者'],
 ['源原句被改',f=>f.source.dialogue[0].quote='好。'],
 ['源声道被改',f=>f.source.dialogue[0].channel='VO'],
 ['源行绑定被改',f=>f.source.dialogue[0].sourceIds=['entry:line-20']],
 ['guidance不是制作源',f=>f.source.sourceRows[0].evidenceRole='guidance'],
 ['前情不是制作源',f=>{f.source.contextRows.push(f.source.sourceRows.shift());}],
 ['源行歧义',f=>f.source.sourceRows.push({...f.source.sourceRows[0]})],
 ['未清源诊断',f=>f.source.diagnostics.push({rowId:f.q.rowId,reason:'尚未裁决源歧义'})],
 ['事件未归属',f=>f.draft.units[0].eventId='E2'],
 ['事件身份重复',f=>f.plan.events.push(structuredClone(f.plan.events[0]))],
 ['事件漏该源行',f=>f.plan.events[0].sourceRefs=['entry:line-20']],
 ['现有引用越事件',f=>f.plan.events[0].sourceRefs=['entry:line-19']],
 ['工作包漏该源行',f=>f.plan.workPackages[0].sourceRefs=['entry:line-20']],
 ['重复工作包源归属',f=>f.plan.workPackages.push({...f.plan.workPackages[0],id:'WP2'})],
 ['独立包身份重复',f=>{f.plan.workPackages[0].sourceRefs=['entry:line-20'];f.plan.workPackages.push({id:'WP1',eventId:'E1',sourceRefs:['entry:line-19']});}],
 ['工作包事件不一致',f=>f.plan.workPackages[0].eventId='E2'],
 ['跨独立工作包',f=>{f.plan.workPackages[0].sourceRefs=['entry:line-20'];f.plan.workPackages.push({id:'WP2',eventId:'E1',sourceRefs:['entry:line-19']});}],
 ['无锚多包不能猜包',f=>{first(f).sourceRefs=[];f.plan.workPackages.push({id:'WP2',eventId:'E2',sourceRefs:[]});}],
 ['缺计划范围',f=>f.plan=null],
 ['缺事件范围',f=>delete f.plan.events],
 ['缺独立包范围',f=>delete f.plan.workPackages],
 ['坏单元',f=>f.draft.units=[null]],
 ['坏镜头',f=>f.draft.units[0].shots=[null]],
 ['重镜号',f=>f.draft.units[0].shots.push(structuredClone(first(f)))]
];
for(const [name,mutate] of invalid)test(`${name}时不猜补对白源关联`,()=>{
 const f=make();mutate(f);const before=structuredClone(f),result=normalize(f);
 assert.deepEqual(links(result.changes),[]);assert.deepEqual(f,before);assert.deepEqual(result.draft,f.draft);
});

test('现场对白错标系统音时不靠来源派生掩盖原覆盖缺口',()=>{
 const f=make();first(f).dialogueParts[0].presentation='系统音';
 const result=normalize(f);
 assert.deepEqual(links(result.changes),[]);
 assert.ok(check(f,result.draft).errors.some(e=>e.code==='SOURCE_COVERAGE'));
});

test('多包回包中按已有唯一源锚分别关联，不合并或跨越独立范围',()=>{
 const f=make(),extra=[{id:'entry:line-21',line:21,text:'随从：明白。'},{id:'entry:line-22',line:22,text:'△随从转向谷口。'}];
 f.source=normalizeSource({...f.source,sourceRows:[...f.source.sourceRows,...extra],dialogue:undefined});
 const q=f.source.dialogue[1],unit=structuredClone(f.draft.units[0]);unit.id='WP2_U1';unit.eventId='E2';unit.boundaryBefore={kind:'new_event',reason:'随从行动'};
 unit.shots[0].id='WP2_S1';unit.shots[0].sourceRefs=['entry:line-22'];unit.shots[0].dialogueParts[0]={...unit.shots[0].dialogueParts[0],lineId:q.id,text:q.quote};
 f.draft.units.push(unit);f.plan.events.push({id:'E2',sourceRefs:extra.map(r=>r.id)});f.plan.workPackages.push({id:'WP2',eventId:'E2',sourceRefs:extra.map(r=>r.id)});
 const result=normalize(f);assert.deepEqual(result.draft.units.map(u=>u.shots[0].sourceRefs),[['entry:line-20','entry:line-19'],['entry:line-22','entry:line-21']]);
 assert.deepEqual(check(f,result.draft).errors,[]);
 const reversed=structuredClone(f);reversed.draft.units.reverse();const rejected=normalize(reversed);
 assert.deepEqual(links(rejected.changes),[]);assert.ok(check(reversed,rejected.draft).errors.some(e=>e.code==='DIALOGUE_ORDER'));
});

test('多物理源行的legacy对白缺逐行字符区间时不扩散来源',()=>{
 const f=make('别怕，');f.source.sourceRows.push({id:'entry:line-21',line:21,text:'我在。'});
 f.source.dialogue[0].quote='别怕，我在。';f.source.dialogue[0].sourceIds.push('entry:line-21');
 f.source=normalizeSource(f.source);first(f).dialogueParts[0].text='别怕，我在。';
 f.plan.events[0].sourceRefs.push('entry:line-21');f.plan.workPackages[0].sourceRefs.push('entry:line-21');
 const result=normalize(f);assert.deepEqual(result.draft,f.draft);assert.deepEqual(links(result.changes),[]);
});

test('片段倒序或重叠发声时保留原覆盖缺口',()=>{
 for(const overlap of [false,true]){
  const f=make('别怕，我在。'),shot=first(f),p=shot.dialogueParts[0];
  shot.dialogueParts=overlap?[{...p,text:'别怕，',voiceEnd:1},{...p,text:'我在。',voiceStart:0.5,voiceEnd:1.5}]:[{...p,text:'我在。'},{...p,text:'别怕，',voiceStart:0.4,voiceEnd:0.75}];
  const result=normalize(f);assert.deepEqual(result.draft,f.draft);assert.deepEqual(links(result.changes),[]);
 }
});

test('明确VO、OS、系统音必须保留原声道，现场混合呈现仍可关联',()=>{
 for(const [speaker,presentation] of [['昭翎（VO）','VO'],['昭翎（OS）','OS'],['系统音','系统音'],['昭翎','画内转画外']]){
  const f=make('嗯。',speaker);first(f).dialogueParts[0].presentation=presentation;
  const result=normalize(f);assert.equal(links(result.changes).length,1);assert.deepEqual(check(f,result.draft).errors,[]);
 }
});

test('关联派生不撤销未决、冲突或补齐其他动作源行',()=>{
 const f=make();f.draft.unresolved=[{coordinate:'WP1_S1',problem:'当前画面仍依赖未知外观'}];
 f.draft.productionFeedback={conflicts:[{key:'状态',problem:'有原文冲突',sourceRefs:['entry:line-20']}]};
 const action={id:'entry:line-21',line:21,text:'△伏兵放下弓。'};f.source.sourceRows.push(action);
 f.plan.events[0].sourceRefs.push(action.id);f.plan.workPackages[0].sourceRefs.push(action.id);
 const result=normalize(f),errors=check(f,result.draft).errors;
 assert.equal(links(result.changes).length,1);
 assert.deepEqual(result.draft.unresolved,f.draft.unresolved);assert.deepEqual(result.draft.productionFeedback,f.draft.productionFeedback);
 assert.ok(errors.some(e=>e.code==='UNRESOLVED'));assert.ok(errors.some(e=>e.code==='SOURCE_COVERAGE'&&e.coordinate===action.id));
});
