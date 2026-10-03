import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildRequest,captureRules} from './core.mjs';
import {normalizeSource} from './source.mjs';
import {PLAN_VERSION,VERSION} from './shared.mjs';

const shared='references/common-contract.md';
const fantasy='skills/fantasy-expression-methods/SKILL.md';
const role=stage=>`skills/${stage==='plan'?'episode-emotion-planner':stage==='author'?'unit-performance-director':'episode-finishing-editor'}/SKILL.md`;
function fixture(){
 const source=normalizeSource({key:'synthetic-payoff',context:{directorNotes:'青春逆袭，痛快反差；守住事实但不压低演出。'},sourceRows:[
  {id:'r1',text:'甲OS：这里的人得到祝福后可以化成异兽。'},
  {id:'r2',text:'△同学热烈期待甲，检测失败后嘲笑他。'},
  {id:'r3',text:'乙：我们分手，不要纠缠我。'},
  {id:'r4',text:'△系统只在甲脑海告知绑定S级应龙，以后可进化至SSS；旁人不知，现实没有变身。'},
  {id:'r5',text:'甲OS：原来如此！那只鹤不就是小白鸡！'},
  {id:'r6',text:'甲：分得好！我还想庆祝呢！'},
  {id:'r7',text:'△甲大笑张臂，乙怒瞪后离开，没有懊悔或求饶。'},
 ]});
 const refs=source.sourceRows.map(row=>row.id);
 const emotionContract={subject:'甲与乙',contextTone:'期待、受辱、私下得势、公开释放',audienceEffect:'理解世界并感到话语权反转',change:'检测失败后被抛弃，秘密信息改变底气，主动接受分手',landing:'公开释放而非公开显露应龙',retain:['r1源已有世界规则的观看理解','r4-r5私下获得底气','r6-r7独立公开释放','现实知情、原话及真实结果不改变']};
 const candidates=[['world','r1',true,'源规则具体主观图示'],['reward','r5',true,'私下强弱对比'],['release','r6',true,'公开大笑与张臂释放'],['accent','r2',false,'可选的群像短强调']].map(([id,anchor,recommended,emotionPurpose])=>({id,anchorRefs:[anchor],subject:'甲与同学',emotionPurpose,recommended,proposal:`为${emotionPurpose}设计可替换的强演出`,screenSecondsRange:[1,6],extraSecondsRange:[0,1]}));
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'受辱后主动翻转关系',entryFacts:[],events:[{id:'e1',sourceRefs:refs,sceneKey:'教室',boundaryBefore:{kind:'episode_start',reason:'合成连续事件'},emotionContract}],workPackages:[{id:'p1',eventId:'e1',sourceRefs:refs,emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'pu1',packageId:'p1',sourceRefs:refs,secondsRange:[10,30]}],fantasyCandidates:candidates};
 const previousDraft={schemaVersion:VERSION,units:[{id:'p1-u1',eventId:'e1',shots:[{id:'p1-s1',duration:6,picture:'甲大笑张臂，乙怒瞪。',dialogueParts:[]}]}],fantasyRealization:[]};
 return {source,plan,packageId:'p1',settings:{maxUnits:null,maxUnitSeconds:30,fantasyMode:'all'},previousDraft};
}
function inputOf(request){
 const input=JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以')[0]);
 const target=pointer=>pointer.slice(2).split('/').reduce((v,k)=>v[k.replaceAll('~1','/').replaceAll('~0','~')],input);
 const expand=value=>{
  if(!value||typeof value!=='object')return value;
  if(Object.hasOwn(value,'$same'))return structuredClone(target(value.$same));
  if(Object.hasOwn(value,'$rowIds'))return value.$rowIds.flatMap(([catalog,start,end])=>input.source[catalog].slice(start,end+1).map(row=>row.id));
  return Array.isArray(value)?value.map(expand):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expand(v)]));
 };
 return expand(input);
}

test('new role requests carry the exact installed payoff skills, not a separate unused copy',()=>{
 const rules=captureRules(),payload=fixture();
 for(const stage of ['plan','author','finish']){
  const request=buildRequest({...payload,stage,rulesSnapshot:rules});
  for(const file of [shared,role(stage),fantasy]){
   const installed=readFileSync(new URL(file,import.meta.url),'utf8');
   assert.equal(request.snapshot.find(row=>row.path===file)?.body,installed);
   assert.ok(request.prompt.includes(`【${file}】\n${installed}`));
   assert.equal(request.loadedFiles.filter(row=>row.path===file).length,1);
  }
 }
});

test('all and recommended preserve separate world, private and public payoff contracts in actual model input',()=>{
 const payload=fixture();
 for(const stage of ['author','finish'])for(const mode of ['all','recommended']){
  const request=buildRequest({...payload,stage,settings:{...payload.settings,fantasyMode:mode}}),input=inputOf(request);
  const expected=mode==='all'?['world','reward','release','accent']:['world','reward','release'];
  assert.deepEqual(input.selection.selectedIds,expected);
  assert.deepEqual(input.plan.fantasyCandidates.map(row=>row.id),expected);
  assert.deepEqual(input.plan.workPackages[0].emotionContract,payload.plan.workPackages[0].emotionContract);
  assert.deepEqual(input.plan.events[0].emotionContract,payload.plan.events[0].emotionContract);
  assert.deepEqual(input.source.dialogue,request.source.dialogue.map(({id,rowId,speaker,quote,cue,kind,channel,performanceCues})=>({id,rowId,speaker,quote,cue,kind,channel,...(performanceCues?{performanceCues}:{})})));
  assert.deepEqual(input.source.sourceRows.map(row=>row.text),payload.source.sourceRows.map(row=>row.text));
 }
});

test('stronger methods do not bypass off or a user cancellation',()=>{
 const payload=fixture();
 for(const stage of ['author','finish']){
  const off=buildRequest({...payload,stage,settings:{...payload.settings,fantasyMode:'off'}});
  assert.deepEqual(off.selection.selectedIds,[]);
  assert.deepEqual(off.plan.fantasyCandidates,[]);
  assert.equal(off.settings.fantasyEnabled,false);
  assert.ok(!off.loadedFiles.some(row=>row.path===fantasy));
  const cancel=buildRequest({...payload,stage,choice:{mode:'all',overrides:{release:false}}});
  assert.deepEqual(cancel.selection.selectedIds,['world','reward','accent']);
  assert.ok(!cancel.plan.fantasyCandidates.some(row=>row.id==='release'));
 }
});

test('old frozen rules keep their request identity through a later skill installation',()=>{
 const payload=fixture(),frozen=captureRules();
 for(const file of [shared,fantasy,...['plan','author','finish'].map(role)])frozen.files[file]='本例冻结的旧规则，不读取磁盘新修订。';
 const saved=structuredClone(frozen);
 for(const stage of ['plan','author','finish']){
  const first=buildRequest({...payload,stage,rulesSnapshot:frozen}),live=buildRequest({...payload,stage});
  const again=buildRequest({...payload,stage,rulesSnapshot:frozen});
  assert.equal(again.inputHash,first.inputHash);
  assert.equal(again.promptHash,first.promptHash);
  assert.notEqual(live.inputHash,first.inputHash);
  assert.equal(again.schemaHash,live.schemaHash);
  assert.deepEqual(again.source,live.source);
  if(stage!=='plan')assert.deepEqual(again.plan,live.plan);
 }
 assert.deepEqual(frozen,saved);
});
