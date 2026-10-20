import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {digest} from './shared.mjs';
import {makeBoundaryContext} from '../../episode-boundary.mjs';
import {createSourceResolutionRegistry} from './source-resolution.mjs';
import {tailFixture} from './author-call-group-test-fixtures.mjs';

const approval={actorId:'human-user',reference:'specific-question:recap',answer:'确认同一次离台的承接复述，不再次登台。'};
const instruction='本集首句离台是上集同一次离台的承接复述；不是归席后再次登台或第二次离台。保留双源、实际归席尾态及全部后续动作，不新增事件。';
const previousRef='previous-1:excerpt-1';
const binding=(d,c)=>({contextHash:digest(d.production.boundary),contextRowsHash:digest(d.source.contextRows),planHash:digest(d.plan),feedbackHash:digest(c.productionFeedback)});
function valueOf(d){
 const c=d.candidates[0],conflict=c.productionFeedback.conflicts[0],need=c.productionFeedback.needs[0];
 return {sourceHash:digest({sourceRows:d.source.sourceRows,dialogue:d.source.dialogue}),kind:'BOUNDARY_ACTION_RECAP',sourceRefs:[...conflict.sourceRefs],instruction,
  conflicts:[{candidateId:c.id,conflictHash:digest(conflict),needHashes:[digest(need)]}],boundaryBinding:binding(d,c)};
}
async function setup(t){
 const directory=await mkdtemp(path.join(tmpdir(),'source-action-recap-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const f=tailFixture(),previous='△甲已经归席。',current='△甲离开高台，乙随即登阶。';
 f.source.sourceRows[0].text=current;
 f.source.contextRows=[{id:previousRef,text:previous,kind:'action',evidenceRole:'source',provenance:{verifiedAgainst:'STANDARD_BOUNDARY_NODE',origin:{domain:'EPISODE',episode:1,start:0,end:previous.length},nodeId:'previous-fact'}}];
 const node=(id,text)=>({id,target:'BODY',kind:'ACTION',sourceRange:{start:0,end:text.length}});
 const seed={schema:'EPISODE_BOUNDARY_SEED_V1',fromEpisode:1,toEpisode:2,adjacentEpisode:true,sourceVersion:'source-v1',
  previousSource:{episode:1,text:previous,sourceRange:{start:0,end:previous.length},sourceTextHash:digest(previous),nodes:[node('previous-fact',previous)]},
  currentOpening:{episode:2,text:current,sourceRange:{start:0,end:current.length},sourceTextHash:digest(current),nodes:[node('current-fact',current)]}};
 const selected={runId:'previous-run',episode:1,sourceVersion:'source-v1',selectionRevision:1};
 const state={key:'甲/所在相位',value:'已归席。',authority:'SOURCE',sourceRefs:[previousRef]};
 const actual={...selected,validated:true,version:'actual-tail-1',states:[{...state,sourceRefs:['old-source:last']}],unit:{id:'tail-unit',scene:'日 外 席位',shots:[{id:'last',picture:'甲已经归席。'}]}};
 const boundary=makeBoundaryContext({seed,selected,actual});
 const feedback={relation:'DIRECT',entry:[state],exit:[],sharedChoices:[],usedMaterialIds:[],
  needs:[{stage:1,target:'OPENING_CONTINUITY',purpose:'双源重复离台，须明确是否承接复述',packageIds:['p1'],sourceRefs:[previousRef,'s1'],blocking:true}],
  conflicts:[{key:state.key,problem:'前集已归席，本集首又离台，无再次登台来源。',sourceRefs:[previousRef,'s1']}]};
 const seen=[],engine=createEngine({directory,modelRunner:async request=>{
  seen.push(request);
  if(request.stage!=='plan')throw Object.assign(new Error('Local request capture only'),{code:'LOCAL_CAPTURE',requestOutcome:'NOT_SENT'});
  const output={...f.plan,productionFeedback:feedback};return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{inputTokens:10,cachedInputTokens:0,outputTokens:5,totalTokens:15}};
 }});
 await engine.create({id:'recap',source:f.source,settings:f.settings,production:{boundary,outgoingAgreements:[],materials:[]}});
 await engine.execute('recap',{stage:'plan',attemptId:'original-plan'});
 const before=await engine.read('recap');assert.equal(before.candidates[0].status,'adopted');assert.equal(before.production.blocking,true);
 return {directory,engine,store:createStore(directory),seen,before};
}

test('explicit single-action recap releases only its exact plan conflict and reaches the next original author input for free',async t=>{
 const {engine,before,seen}=await setup(t),frozen=structuredClone(seen[0]);
 const after=await engine.resolveSource('recap',valueOf(before),approval);
 assert.equal(after.production.blocking,false);assert.equal(after.production.boundaryCheck.status,'MATCHED');
 assert.equal(after.production.needs[0].resolved,true);assert.equal(seen.length,1);
 for(const key of ['source','plan','rulesSnapshot','settings','choice','operations','candidates','adopted','status'])assert.deepEqual(after[key],before[key],key);
 assert.deepEqual(after.production.boundary,before.production.boundary);
 await assert.rejects(engine.execute('recap',{stage:'author',packageId:'p1',attemptId:'original-author'}),{code:'LOCAL_CAPTURE'});
 assert.equal(seen.length,2);assert.match(seen[1].prompt,/同一次离台的承接复述/);assert.match(seen[1].prompt,/BOUNDARY_ACTION_RECAP/);
 assert.deepEqual(seen[0],frozen,'old paid prompt remains byte-equivalent');
});

test('recap rejects missing approval, non-source/equal-state violations, locks, unrelated coordinates and post-author registration without writes',async t=>{
 for(const mode of ['approval','source','binding','unequal','entryAuthority','tailAuthority','incomingLock','outgoingLock','noActual','relation','guidance','spoken','need','candidate','author']){
  const {engine,store}=await setup(t);let trusted=approval;
  await store.update('recap',d=>{
   const c=d.candidates[0],f=c.productionFeedback;
   if(mode==='unequal')f.entry[0].value='仍在台上。';
   if(mode==='entryAuthority')f.entry[0].authority='DESIGN';
   if(mode==='tailAuthority')d.production.boundary.actual.states[0].authority='DESIGN';
   if(mode==='incomingLock')d.production.boundary.agreements.push({...f.entry[0],authority:'DESIGN'});
   if(mode==='outgoingLock')d.production.outgoingAgreements.push({...f.entry[0],authority:'DESIGN'});
   if(mode==='noActual')d.production.boundary.actual=null;
   if(mode==='relation')f.relation='TIME_JUMP';
   if(mode==='guidance')d.source.contextRows[0].evidenceRole='guidance';
   if(mode==='spoken'){f.conflicts[0].sourceRefs=[previousRef,'s2'];f.needs[0].sourceRefs=[previousRef,'s2'];}
   if(mode==='need')f.needs[0].target='UNRELATED';
   if(mode==='candidate')c.status='needs_repair';
   if(mode==='author')d.operations.push({attemptId:'already-paid-author',stage:'author',status:'completed',packageIds:['p1'],receipt:{requestOutcome:'RESPONDED',usage:{totalTokens:1}}});
   return d;
  });
  const d=await engine.read('recap'),value=valueOf(d);
  if(mode==='approval')trusted={...approval,reference:''};
  if(mode==='source')value.sourceHash='0'.repeat(64);
  if(mode==='binding')value.boundaryBinding.contextHash='0'.repeat(64);
  await assert.rejects(engine.resolveSource('recap',value,trusted),e=>/^SOURCE_RESOLUTION/.test(e.code),mode);
  assert.deepEqual(await engine.read('recap'),d,mode);
 }
});

test('accepted recap expires on current boundary refresh and on plan/context/receipt drift before a new request',async t=>{
 for(const mode of ['actualTail','previousSource','currentOpening','selected','contextRows','plan','feedback','newLock','approval']){
  const {engine,store,before,seen}=await setup(t);
  const saved=await engine.resolveSource('recap',valueOf(before),approval);
  if(['actualTail','previousSource','currentOpening','selected'].includes(mode)){
   const boundary=structuredClone(saved.production.boundary);
   if(mode==='actualTail')boundary.actual.unit.shots[0].picture='实际尾镜已变化。';
   if(mode==='previousSource')boundary.seed.previousSource.sourceTextHash='new-source';
   if(mode==='currentOpening')boundary.seed.currentOpening.sourceTextHash='new-opening';
   if(mode==='selected'){boundary.selected.runId='new-selected';boundary.selected.selectionRevision++;}
   await assert.rejects(engine.refreshProduction('recap',{boundary,materials:[],outgoingAgreements:[]}),{code:'SOURCE_RESOLUTION_STALE'},mode);
   assert.deepEqual(await engine.read('recap'),saved,mode);
  }else{
   await store.update('recap',d=>{
    if(mode==='contextRows')d.source.contextRows[0].text+='源变化';
    if(mode==='plan')d.plan.emotionArc+='新计划';
    if(mode==='feedback')d.candidates[0].productionFeedback.conflicts[0].problem+='新回执';
    if(mode==='newLock')d.production.outgoingAgreements.push({key:'甲/所在相位',value:'已归席。',authority:'DESIGN'});
    if(mode==='approval')d.production.sourceResolutions[0].approval.answer='替换批准';
    return d;
   });
   const changed=await engine.read('recap');
   await assert.rejects(engine.execute('recap',{stage:'author',packageId:'p1',attemptId:'must-not-send'}),{code:'SOURCE_RESOLUTION_STALE'},mode);
   assert.deepEqual(await engine.read('recap'),changed,mode);
  }
  assert.equal(seen.length,1,'no model entry after drift');
 }
});

test('approved recap preserves other hard conflicts and cannot be pre-registered for a different future run',async t=>{
 const {engine,store,before}=await setup(t);
 await store.update('recap',d=>{d.candidates[0].productionFeedback.conflicts.push({key:'another/source',problem:'另一未批准硬冲突',sourceRefs:['s6']});return d;});
 const d=await engine.read('recap'),value=valueOf(d),after=await engine.resolveSource('recap',value,approval);
 assert.equal(after.production.globalBlocking,true);assert.deepEqual(after.production.boundaryCheck.changedKeys,['another/source']);
 const directory=await mkdtemp(path.join(tmpdir(),'recap-registry-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const registry=createSourceResolutionRegistry(directory);
 await assert.rejects(registry.register({projectId:'p',episodeId:'future'},before.source,{...value,conflicts:[]},approval),e=>/^SOURCE_RESOLUTION/.test(e.code));
 await assert.rejects(engine.create({id:'future',source:before.source,settings:before.settings,production:{...before.production,sourceResolutions:after.production.sourceResolutions}}),e=>/^SOURCE_RESOLUTION/.test(e.code));
});
