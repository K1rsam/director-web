import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine} from './storyboard-v4/core/pipeline.mjs';
import {createStore} from './storyboard-v4/core/store.mjs';
import {makeBoundaryContext, validateProductionFeedback, reconcileBoundary, selectBoundaryForRequest, dependencyScope, selectedActualTail, productionFeedbackSchema} from './episode-boundary.mjs';

const seed={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'source-1',fromEpisode:1,toEpisode:2,adjacentEpisode:true,
 previousSource:{episode:1,text:'甲将钥匙递给乙。',nodes:[],sourceRange:{start:0,end:8}},currentOpening:{episode:2,text:'乙接过钥匙。',nodes:[],sourceRange:{start:0,end:6}},story:{timeLayer:'UNKNOWN',realityDomain:'UNKNOWN'},unknowns:[]};
const state=(value,authority='DESIGN')=>({key:'prop:key/holder',value,authority,sourceRefs:authority==='SOURCE'?['s1']:[]});
const feedback=(entry=[state('乙')])=>({relation:'DIRECT',entry,exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]});
const selected={runId:'prior-run',episode:1,sourceVersion:'source-1',selectionRevision:1};
const actual={...selected,version:'tail-1',states:[state('乙')],unit:{id:'p1-u1',exitState:'乙接住钥匙。'},validated:true};

test('missing predecessor uses full seed; unrelated actual is never silently selected',()=>{
 const context=makeBoundaryContext({seed,selected});
 assert.equal(context.mode,'PRELIMINARY');assert.equal(context.seed.previousSource.text,seed.previousSource.text);
 assert.equal(makeBoundaryContext({seed,selected,actual:{...actual,runId:'unselected'}}).actual,null);
 assert.equal(makeBoundaryContext({seed,selected,actual}).mode,'ACTUAL');
 assert.equal(makeBoundaryContext({seed,selected,actual:{...actual,sourceVersion:'stale'}}).mode,'PRELIMINARY');
});
test('no implicit inheritance across jump/flashback/fantasy/nonadjacent episodes',()=>{
 for(const relation of ['TIME_JUMP','LOCATION_CHANGE','FLASHBACK','FANTASY','INDEPENDENT','UNKNOWN']){
  const r=reconcileBoundary({context:makeBoundaryContext({seed,selected,actual}),feedback:{...feedback(),relation},previousCheck:null});
  assert.notEqual(r.status,'REPAIR_REQUIRED');assert.equal(r.inherit,false);
 }
 const context=makeBoundaryContext({seed:{...seed,fromEpisode:0,adjacentEpisode:false},selected,actual});
 assert.equal(context.actual,null);
});
test('same actual is zero repair, free difference only repairs consuming dependencies',()=>{
 const context=makeBoundaryContext({seed,selected,actual});
 const same=reconcileBoundary({context,feedback:feedback(),previousCheck:null});assert.equal(same.status,'MATCHED');
 const difference=reconcileBoundary({context,feedback:feedback([state('甲')]),previousCheck:null});
 assert.equal(difference.status,'REPAIR_REQUIRED');assert.deepEqual(difference.changedKeys,['prop:key/holder']);
 const ignored=reconcileBoundary({context,feedback:feedback([]),previousCheck:null});assert.equal(ignored.status,'NOT_CONSUMED');
 const doc={plan:{workPackages:[{id:'p1',sourceRefs:['s1'],dependsOn:[]},{id:'p2',sourceRefs:['s2'],dependsOn:['p1']},{id:'p3',sourceRefs:['s3'],dependsOn:[]}]},source:{sourceRows:[{id:'s1'},{id:'s2'},{id:'s3'}]},adopted:[]};
 assert.deepEqual(dependencyScope(doc,['p1']),['p1','p2']);
});
test('hard source/locked choice conflict never lets actual overwrite the constraint',()=>{
 const context=makeBoundaryContext({seed,selected,actual,agreements:[state('甲','SOURCE')]});
 const check=reconcileBoundary({context,feedback:feedback([state('甲','SOURCE')]),previousCheck:null});
 assert.equal(check.status,'CONSTRAINT_CONFLICT');assert.equal(check.repairTarget,'PREDECESSOR_OR_SOURCE_REVIEW');
 assert.equal(context.agreements[0].value,'甲');
});
test('snapshots remain immutable and actual version deduplicates late delivery',()=>{
 const context=makeBoundaryContext({seed,selected}),snapshot=selectBoundaryForRequest(context,'author',true);
 context.seed.previousSource.text='changed';assert.equal(snapshot.seed.previousSource.text,seed.previousSource.text);
 const current=makeBoundaryContext({seed,selected,actual}),check=reconcileBoundary({context:current,feedback:feedback(),previousCheck:null});
 assert.deepEqual(reconcileBoundary({context:current,feedback:feedback(),previousCheck:check}),check);
 assert.equal(selectBoundaryForRequest(current,'author',false),null);
});
test('feedback is evidence/scoped, not arbitrary source authority or missing material claim',()=>{
 const request={source:{sourceRows:[{id:'s1'}],contextRows:[]},episodeBoundary:makeBoundaryContext({seed,selected}),materialIds:['asset:CH01']};
 assert.deepEqual(validateProductionFeedback(feedback(),request),feedback());
 assert.throws(()=>validateProductionFeedback(feedback([state('甲','SOURCE')]),{...request,source:{sourceRows:[],contextRows:[]}}),{code:'PRODUCTION_FEEDBACK'});
 assert.throws(()=>validateProductionFeedback({...feedback(),usedMaterialIds:['invented']},request),{code:'PRODUCTION_FEEDBACK'});
 assert.throws(()=>validateProductionFeedback({...feedback(),needs:[{stage:2,target:'CH01',purpose:'好看',packageIds:['invented'],sourceRefs:['s1'],blocking:true}]},request),{code:'PRODUCTION_FEEDBACK'});
 assert.throws(()=>validateProductionFeedback(feedback([state('甲','SOURCE')]),{...request,source:{sourceRows:[],contextRows:[{id:'s1',kind:'guidance',evidenceRole:'guidance'}]}}),{code:'PRODUCTION_FEEDBACK'});
 assert.throws(()=>validateProductionFeedback(feedback([state('甲','SOURCE')]),{...request,source:{sourceRows:[{id:'s1',kind:'dialogue'}],contextRows:[],dialogue:[{sourceIds:['s1']}]}}),{code:'PRODUCTION_FEEDBACK'});
});
test('only a tail-owning request may report an actual exit; claims remain claims',()=>{
 const request={source:{sourceRows:[{id:'s1',kind:'dialogue'}],contextRows:[]},productionSnapshot:{touchesEnding:false}};
 assert.throws(()=>validateProductionFeedback({...feedback(),exit:[state('甲')]},request),{code:'PRODUCTION_FEEDBACK'});
 const claim=state('自称持钥匙','CHARACTER_CLAIM');claim.sourceRefs=['s1'];
 assert.equal(validateProductionFeedback(feedback([claim]),request).entry[0].authority,'CHARACTER_CLAIM');
});
test('stage two needs point to current-episode supply coordinates, never an unreadable context ID',()=>{
 const source={sourceRows:[{id:'s1',kind:'action'}],contextRows:[{id:'previous-1',kind:'action'}]},request={source,plan:{workPackages:[{id:'p1'}]}};
 const need={stage:2,target:'PR01',purpose:'补本场递交道具的可握部位',packageIds:['p1'],sourceRefs:['s1'],blocking:false};
 assert.deepEqual(validateProductionFeedback({...feedback(),needs:[need]},request).needs,[need]);
 assert.throws(()=>validateProductionFeedback({...feedback(),needs:[{...need,sourceRefs:['previous-1']}]},request),{code:'PRODUCTION_FEEDBACK'});
 assert.equal(validateProductionFeedback({...feedback(),needs:[{...need,stage:1,sourceRefs:['previous-1']}]},request).needs[0].stage,1);
 const alternatives=productionFeedbackSchema(request).properties.needs.items.anyOf;
 assert.deepEqual(alternatives.find(x=>x.properties.stage.enum.includes(2)).properties.sourceRefs.items.enum,['s1']);
 assert.deepEqual(alternatives.find(x=>x.properties.stage.enum.includes(1)).properties.sourceRefs.items.enum,['s1','previous-1']);
});
test('a later opening-only repair cannot supply the previous episode actual tail',()=>{
 const unit={id:'p3-u1',exitState:'乙接住钥匙。'};
 const doc={assembly:{draft:{units:[{id:'p1-u1'},unit]},validation:{errors:[]}},production:{},
  adopted:[{packageIds:['p1'],candidateId:'opening',draft:{units:[{id:'p1-u1'}]}},{packageIds:['p3'],candidateId:'tail',draft:{units:[unit]}}],
  operations:[{attemptId:'a3',productionSnapshot:{touchesEnding:true}},{attemptId:'a1',productionSnapshot:{touchesEnding:false}}],
  candidates:[{id:'tail',attemptId:'a3',productionFeedback:{exit:[state('乙')]}},{id:'opening',attemptId:'a1',productionFeedback:{exit:[state('甲')]}}]};
 assert.deepEqual(selectedActualTail(doc),{unit,states:[state('乙')]});
 doc.operations[0].productionSnapshot.touchesEnding=false;
 assert.deepEqual(selectedActualTail(doc),{unit,states:[]},'no receipt is safer than borrowing unrelated exit');
});
test('locked choices are checked without an actual tail and cannot disappear from entry receipt',()=>{
 const preliminary=makeBoundaryContext({seed,selected,agreements:[state('乙')]});
 assert.equal(reconcileBoundary({context:preliminary,feedback:feedback([state('甲')])}).status,'CONSTRAINT_CONFLICT');
 const current=makeBoundaryContext({seed,selected,actual:{...actual,states:[state('甲')]},agreements:[state('乙')]});
 assert.equal(reconcileBoundary({context:current,feedback:feedback([])}).status,'CONSTRAINT_CONFLICT');
});

test('new current-source entry facts need not have been restated by the predecessor',()=>{
 const context=makeBoundaryContext({seed,selected,actual});
 const current={key:'character:hostage/location',value:'仍在囚室，尚未获救',authority:'SOURCE',sourceRefs:['current-action']};
 const source={sourceRows:[{id:'current-action',kind:'action',text:'水从通风口渗入囚室，在人质掌心写字。'}],contextRows:[],dialogue:[]};
 const receipt=feedback([state('乙'),current]),before=structuredClone({context,receipt,source});
 const stale=reconcileBoundary({context,feedback:receipt});
 const check=reconcileBoundary({context,feedback:receipt,source,previousCheck:stale});
 assert.equal(check.status,'MATCHED');
 assert.deepEqual(check.currentSourceKeys,[current.key]);
 assert.deepEqual(context.actual.states,[state('乙')],'do not fabricate a missing predecessor state');
 assert.deepEqual({context,receipt,source},before);
 assert.equal(reconcileBoundary({context,feedback:receipt,source,previousCheck:check}),check);

 for(const variant of [
  {...current,authority:'DESIGN'},
  {...current,sourceRefs:[]},
  {...current,sourceRefs:['previous-action']},
  {...current,sourceRefs:['current-action','previous-action']},
  {...current,sourceRefs:['spoken']},
 ])assert.equal(reconcileBoundary({context,feedback:feedback([variant]),source}).status,'UNRESOLVED');
 for(const row of [
  {id:'current-action',kind:'dialogue'},
  {id:'current-action',kind:'guidance'},
  {id:'current-action',kind:'action',evidenceRole:'guidance'},
  {id:'current-action'},
 ])assert.equal(reconcileBoundary({context,feedback:receipt,source:{...source,sourceRows:[row]}}).status,'UNRESOLVED');
 assert.equal(reconcileBoundary({context,feedback:receipt,source:{...source,dialogue:[{sourceIds:['current-action']}]}}).status,'UNRESOLVED');
 const contradictory=makeBoundaryContext({seed,selected,actual:{...actual,states:[state('乙'),{...current,value:'已救出'}]}});
 assert.equal(reconcileBoundary({context:contradictory,feedback:receipt,source}).status,'CONSTRAINT_CONFLICT');
 const locked=makeBoundaryContext({seed,selected,actual,agreements:[{...current,value:'已救出',authority:'DESIGN'}]});
 assert.equal(reconcileBoundary({context:locked,feedback:receipt,source}).status,'CONSTRAINT_CONFLICT');
 assert.equal(reconcileBoundary({context:makeBoundaryContext({seed,selected}),feedback:receipt,source}).status,'PRELIMINARY');
});

test('free boundary revalidation of a completed draft appends provenance without repurchasing or rewriting it',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'boundary-current-source-'));
 try{
  const context=makeBoundaryContext({seed,selected,actual});
  const receipt=feedback([state('乙'),{key:'new/location',value:'仍在囚室',authority:'SOURCE',sourceRefs:['s1']}]);
  const source={sourceRows:[{id:'s1',text:'水渗入囚室，在人质掌心写字。',kind:'action'}],contextRows:[],dialogue:[],entryFacts:[]};
  const plan={workPackages:[{id:'p1',sourceRefs:['s1'],contextRefs:[],entryFactIds:[],dependsOn:[]}],productionFeedback:receipt};
  const oldCheck=reconcileBoundary({context,feedback:receipt});delete oldCheck.checkVersion;
  const document={id:'completed',source,plan,adopted:[],candidates:[{id:'paid',attemptId:'paid',stage:'plan',packageIds:[],status:'adopted',raw:'original-paid-raw',output:plan,productionFeedback:receipt}],operations:[{attemptId:'paid',stage:'plan',status:'completed',fingerprint:'original-paid-hash'}],rulesSnapshot:{},status:'text_ready_for_review',assembly:{draft:{units:[]}},web:{budget:{maxTokens:1000}},production:{boundary:context,materials:[],boundaryCheck:oldCheck,checkHistory:[{...oldCheck,at:'2026-10-01T00:00:00Z'}]}};
  const store=createStore(directory);await store.create(document.id,document);
  let calls=0;const engine=createEngine({directory,modelRunner:async()=>{calls++;throw Error('free revalidation must not dispatch');}});
  const after=await engine.refreshProduction(document.id,{boundary:context,materials:[]});
  assert.equal(after.production.boundaryCheck.status,'MATCHED');
  assert.equal(after.production.checkHistory.length,2);
  assert.deepEqual(after.production.checkHistory.at(-1).currentSourceKeys,['new/location']);
  assert.equal(calls,0);
  for(const key of ['source','plan','adopted','candidates','operations','rulesSnapshot','status','assembly','web'])assert.deepEqual(after[key],document[key],key);
  const again=await engine.refreshProduction(document.id,{boundary:context,materials:[]});
  assert.equal(again.production.checkHistory.length,2,'identical refresh must not append or dispatch repeatedly');
 }finally{await rm(directory,{recursive:true,force:true});}
});
