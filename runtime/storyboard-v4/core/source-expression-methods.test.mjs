import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules} from './core.mjs';
import {normalizeSource} from './source.mjs';
import {PLAN_VERSION,VERSION} from './shared.mjs';

const method='skills/fantasy-expression-methods/SKILL.md';
const emotionContract={subject:'甲',contextTone:'坚定',audienceEffect:'读清决定',change:'犹疑转决定',landing:'说完原话',retain:['源表现与原话']};
function fixture(text='甲：（Q版，OS）“先走，别回头。”'){
 const source=normalizeSource({key:'source-expression',sourceRows:[{id:'s1',text}]});
 const boundaryBefore={kind:'episode_start',reason:'本次制作源开始'};
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'坚定',entryFacts:[],events:[{id:'e1',sceneKey:'门厅',sourceRefs:['s1'],boundaryBefore,emotionContract}],workPackages:[{id:'p1',eventId:'e1',sourceRefs:['s1'],emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'u1',packageId:'p1',sourceRefs:['s1'],secondsRange:[2,6]}],fantasyCandidates:[]};
 return {source,plan};
}
function request(stage,mode='off',f=fixture(),rulesSnapshot=captureRules()){
 return buildRequest({stage:stage==='delta'?'finish':stage,...f,packageId:'p1',settings:{maxUnits:null,fantasyMode:mode},rulesSnapshot,...(stage==='finish'?{previousDraft:{rawText:'保留的待修原始响应'}}:{}),...(stage==='delta'?{finishMode:'delta',previousDraft:{schemaVersion:VERSION,units:[{id:'p1-u1',shots:[]}],fantasyRealization:[]}}:{})});
}

test('new source-expression loading preserves off and zero-selected semantics across the roles',()=>{
 for(const stage of ['plan','author','finish']){
  const r=request(stage);
  assert.ok(r.loadedFiles.some(f=>f.path===method),stage);
  assert.equal(r.settings.fantasyEnabled,false,stage);
  if(stage==='plan')assert.equal(r.schema.properties.fantasyCandidates.maxItems,0);
  else{
   assert.deepEqual(r.selection.selectedIds,[]);
   assert.equal(r.schema.properties.fantasyRealization.maxItems,0);
   assert.match(r.prompt,/Q版，OS/);
  }
 }
 for(const stage of ['author','finish']){
  const r=request(stage,'recommended');
  assert.ok(r.loadedFiles.some(f=>f.path===method));
  assert.equal(r.settings.fantasyEnabled,false);
  assert.deepEqual(r.selection.selectedIds,[]);
 }
});

test('ordinary source with off does not load expression methods or enable an unselected candidate',()=>{
 const f=fixture('甲：“先走，别回头。”');
 f.plan.fantasyCandidates=[{id:'f1',anchorRefs:['s1'],subject:'甲',emotionPurpose:'决定',recommended:true,proposal:'新增Q版提案',screenSecondsRange:[1,2],extraSecondsRange:[0,1]}];
 for(const stage of ['author','finish']){
  const r=request(stage,'off',f);
  assert.ok(!r.loadedFiles.some(f=>f.path===method));
  assert.equal(r.settings.fantasyEnabled,false);
  assert.deepEqual(r.selection.selectedIds,[]);
  assert.deepEqual(r.plan.fantasyCandidates,[]);
 }
});

test('source dream and explicit 2D Q-form retain detailed methods without adding fantasy',()=>{
 for(const text of ['△甲在梦境中站在门口。','△甲成为二维线描Q版，抬起头。']){
  const r=request('author','off',fixture(text));
  const body=r.snapshot.find(f=>f.path===method)?.body;
  assert.ok(body);assert.match(body,/二维/);assert.match(body,/同一角色的3D建模Q版/);
  assert.equal(r.settings.fantasyEnabled,false);
 }
});

test('explicit miniature avatars without a Q label load methods across plan, author and both finish modes',()=>{
 for(const text of ['△甲耳侧漂浮的二维小化身双手抱头，随着甲的思绪团团转；旁人看不见。','△甲的内心小人以2D线描呈现，抱膝缩成一团。'])for(const stage of ['plan','author','finish','delta']){
  const r=request(stage,'off',fixture(text));
  assert.ok(r.loadedFiles.some(f=>f.path===method),`${stage}: ${text}`);
  assert.equal(r.settings.fantasyEnabled,false);
  if(stage!=='plan')assert.deepEqual(r.selection.selectedIds,[]);
  if(stage==='delta')assert.equal(r.finishMode,'delta');
 }
});

test('evidenced entry facts carry source Q-state into the current work package, without scanning all context',()=>{
 const f=fixture('甲：（OS）“先走，别回头。”');
 f.source.contextRows=[{id:'prior',text:'△甲化为Q版，继续盘算，尚未恢复原比例。'}];
 const fact={id:'q-state',subject:'甲',statement:'甲在本段入口仍是Q版造型。',sourceRefs:['prior'],evidenceMode:'source_rows'};
 f.source.entryFacts=[fact];
 for(const stage of ['plan','author','finish','delta']){
  const r=request(stage,'off',f);
  assert.ok(r.loadedFiles.some(f=>f.path===method),stage);
  assert.equal(r.settings.fantasyEnabled,false);
 }
 f.source.entryFacts=[];
 f.plan.entryFacts=[fact];
 // A fact synthesized by the planner is relevant only when the work package cites it.
 for(const stage of ['author','finish','delta'])assert.ok(!request(stage,'off',f).loadedFiles.some(f=>f.path===method));
 f.plan.workPackages[0].entryFactIds=['q-state'];
 for(const stage of ['author','finish','delta'])assert.ok(request(stage,'off',f).loadedFiles.some(f=>f.path===method));
});

test('Q-form in unrelated preceding context does not load methods for an ordinary work package',()=>{
 const f=fixture('甲：“先走，别回头。”');
 f.source.contextRows=[{id:'prior',text:'△前一场甲变成Q版。'}];
 f.plan.workPackages[0].contextRefs=['prior'];
 assert.ok(!request('author','off',f).loadedFiles.some(f=>f.path===method));
});

test('saved snapshots without the loading marker keep the former off branch and reject unknown markers',()=>{
 const saved=captureRules();delete saved.sourceExpressionMethodsVersion;
 assert.ok(!request('author','off',fixture(),saved).loadedFiles.some(f=>f.path===method));
 assert.throws(()=>request('author','off',fixture(),{...saved,sourceExpressionMethodsVersion:'future'}),e=>e.code==='RULE_SNAPSHOT');
});

test('saved v1 loading snapshots keep their original cue-only branch in every role',()=>{
 const saved={...captureRules(),sourceExpressionMethodsVersion:'source-expression-methods-v1'};
 const f=fixture('甲：（OS）“先走，别回头。”');
 f.source.contextRows=[{id:'prior',text:'△甲化为Q版，继续盘算，尚未恢复原比例。'}];
 f.source.entryFacts=[{id:'q-state',subject:'甲',statement:'甲在本段入口仍是Q版造型。',sourceRefs:['prior'],evidenceMode:'source_rows'}];
 for(const stage of ['plan','author','finish','delta']){
  assert.ok(!request(stage,'off',f,saved).loadedFiles.some(f=>f.path===method));
  assert.ok(!request(stage,'off',fixture('△甲耳侧浮出二维小化身。'),saved).loadedFiles.some(f=>f.path===method));
  assert.ok(request(stage,'off',fixture(),saved).loadedFiles.some(f=>f.path===method));
 }
});
