import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCoordinator} from './coordinator.mjs';
import {tailFixture,tailDraft} from './core/author-call-group-test-fixtures.mjs';
import {makeBoundaryContext} from '../episode-boundary.mjs';
import {DELTA_VERSION} from './core/delta.mjs';
import {createStore} from './core/store.mjs';

const seed={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'source-v1',fromEpisode:null,toEpisode:1,adjacentEpisode:false,previousSource:null,currentOpening:{episode:1,text:'甲：第1句。',nodes:[],sourceRange:{start:0,end:7}},story:{timeLayer:'UNKNOWN',realityDomain:'UNKNOWN'},unknowns:[]};
const baseFeedback=()=>({relation:'INDEPENDENT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]});
const makeNeed=(packageIds=['p3'])=>({stage:2,target:'CH01',purpose:'确定本包动作所需服装范围',packageIds,sourceRefs:['s6'],blocking:true});
const initial=()=>({version:'production-feedback-v1',globalBlocking:false,boundary:makeBoundaryContext({seed,selected:null}),materials:[]});
// These scoped-gate receipts have no full-result revision; replay their original contract.
function legacyCoordinator(options){
 const c=createCoordinator(options),create=c.create.bind(c);
 c.create=async input=>{const run=await create(input);await createStore(options.dataRoot).update(run.id,d=>{d.rulesSnapshot.productionFeedbackResultVersion='production-feedback-result-v1';return d;});return c.read(run.id);};
 return c;
}

async function fixture(fn,{need=makeNeed(),conflicts=[]}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'scoped-production-gate-')),f=tailFixture(),calls=[];
 let context=initial();
 const coordinator=legacyCoordinator({dataRoot:directory,loadProductionContext:async()=>context,modelRunner:async request=>{
  calls.push({stage:request.stage,packageIds:[...request.packageIds],finishMode:request.finishMode});
  const feedback={...baseFeedback(),...(request.stage==='plan'?{needs:need?[need]:[],conflicts}:{}),usedMaterialIds:request.materialIds||[]};
  let output=request.stage==='plan'?f.plan:tailDraft(request);
  if(request.finishMode==='delta'){
   const sent=JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以')[0]);
   output={schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:sent.previousDraft.units.map(u=>u.id),replacements:[],revisionNotes:[],unresolved:[]};
  }
  return {output:{...output,productionFeedback:feedback},usage:{totalTokens:1},requestOutcome:'RESPONDED'};
 }});
 try{await fn({coordinator,calls,source:f.source,settings:f.settings,setContext:value=>{context=value;},context});}
 finally{await coordinator.shutdown();await rm(directory,{recursive:true,force:true});}
}
const create=(c,source,settings,production,budget)=>c.create({source,settings,production,binding:{projectId:'scoped-test',episodeId:'ep1',sourceVersion:'source-v1'},budget});

test('a late-package need allows prior source-ordered packages without crossing the blocked package',async()=>fixture(async({coordinator:c,calls,source,settings,context})=>{
 const run=await create(c,source,settings,context);await c.start(run.id);const stopped=await c.wait(run.id);
 assert.deepEqual(calls.map(x=>[x.stage,x.packageIds]),[['plan',[]],['author',['p1']],['author',['p2']]]);
 assert.deepEqual(stopped.adopted.flatMap(a=>a.packageIds),['p1','p2']);
 assert.equal(stopped.web.progress,'upstream_review');assert.equal(stopped.web.error.code,'PRODUCTION_DEPENDENCY');
 assert.equal(stopped.operations.length,3,'blocked p3 must not reserve or send an attempt');
 const count=calls.length;await c.start(run.id);await c.wait(run.id);assert.equal(calls.length,count,'retrying unchanged need is free and converges');
}));

test('next mode advances one safe package at a time and resumes exactly at the supplied package',async()=>fixture(async({coordinator:c,calls,source,settings,context,setContext})=>{
 const run=await create(c,source,settings,context);
 for(let count=1;count<=3;count++){await c.start(run.id,{mode:'next'});await c.wait(run.id);assert.equal(calls.length,count);}
 await c.start(run.id,{mode:'next'});assert.equal((await c.wait(run.id)).web.progress,'upstream_review');assert.equal(calls.length,3);
 setContext({...context,materials:[{id:'asset:CH01',version:'v2',value:{assetKey:'CH01',design:'供p3动作使用的宽袖'}}]});
 await c.start(run.id);const done=await c.wait(run.id);
 assert.equal(done.status,'text_ready_for_review',JSON.stringify({status:done.status,web:done.web,candidates:done.candidates.map(c=>({status:c.status,errors:c.errors}))}));
 assert.deepEqual(calls.filter(x=>x.stage==='author').map(x=>x.packageIds),[['p1'],['p2'],['p3']]);
 assert.equal(done.production.needs[0].resolved,true);
}));

test('local finish repair may consume an unaffected package while another package still lacks material',async()=>fixture(async({coordinator:c,calls,source,settings,context})=>{
 const run=await create(c,source,settings,context);await c.start(run.id);await c.wait(run.id);const before=calls.length;
 await c.repair(run.id,{packageIds:['p1']});const repaired=await c.wait(run.id);
 assert.deepEqual(calls.slice(before).map(x=>[x.stage,x.packageIds]),[['finish',['p1']]]);
 assert.equal(repaired.adopted.find(a=>a.packageIds.includes('p1')).stage,'finish');
 await c.repair(run.id,{packageIds:['p3']});const stopped=await c.wait(run.id);
 assert.equal(calls.length,before+1);assert.equal(stopped.web.progress,'upstream_review');
}));

test('an unscoped material need blocks every author package',async()=>fixture(async({coordinator:c,calls,source,settings,context})=>{
 const run=await create(c,source,settings,context);await c.start(run.id);const stopped=await c.wait(run.id);
 assert.deepEqual(calls.map(c=>c.stage),['plan']);assert.equal(stopped.web.progress,'upstream_review');
},{need:makeNeed([])}));

test('source hard conflicts still block the entire run despite a late-package material scope',async()=>fixture(async({coordinator:c,calls,source,settings,context})=>{
 const run=await create(c,source,settings,context);await c.start(run.id);const stopped=await c.wait(run.id);
 assert.deepEqual(calls.map(c=>c.stage),['plan']);assert.equal(stopped.web.progress,'upstream_review');
},{conflicts:[{key:'identity',problem:'原文身份出现硬冲突',sourceRefs:['s6']}]}));

test('scoped progress does not bypass the existing call budget',async()=>fixture(async({coordinator:c,calls,source,settings,context})=>{
 const run=await create(c,source,settings,context,{maxCalls:2,maxTokens:300000});await c.start(run.id);const stopped=await c.wait(run.id);
 assert.deepEqual(calls.map(x=>[x.stage,x.packageIds]),[['plan',[]],['author',['p1']]]);
 assert.equal(stopped.web.progress,'budget_stop');
}));

test('automatic consumed-material repair is scoped independently of a later blocking need',async()=>fixture(async({coordinator:c,calls,source,settings,context,setContext})=>{
 const provided={...context,materials:[{id:'asset:CH02',version:'v1',value:{assetKey:'CH02',design:'共用人物初版'}}]};setContext(provided);
 const run=await create(c,source,settings,provided);await c.start(run.id);await c.wait(run.id);const before=calls.length;
 setContext({...provided,materials:[{...provided.materials[0],version:'v2',value:{assetKey:'CH02',design:'共用人物补齐'}}]});
 await c.start(run.id);const stopped=await c.wait(run.id);
 assert.deepEqual(calls.slice(before).map(x=>[x.stage,x.packageIds]),[['finish',['p1','p2']]],JSON.stringify({status:stopped.status,web:stopped.web,pending:stopped.production.pendingRepair,needs:stopped.production.needs,adopted:stopped.adopted.map(a=>a.packageIds)}));
 assert.equal(stopped.production.pendingRepair,null);assert.equal(stopped.web.progress,'upstream_review');
 assert.equal(stopped.production.needs[0].blocking,true,'the unrelated p3 need stays visible');
}));

test('before a valid plan, a scoped-looking need cannot be treated as dispatchable',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'unplanned-production-gate-')),f=tailFixture();let calls=0;
 const c=legacyCoordinator({dataRoot:directory,modelRunner:async()=>{calls++;throw Error('must not dispatch');}});
 try{
  const run=await create(c,f.source,f.settings,{...initial(),blocking:true,needs:[makeNeed(['p3'])]});
  await c.start(run.id);const stopped=await c.wait(run.id);
  assert.equal(calls,0);assert.equal(stopped.web.progress,'upstream_review');
 }finally{await c.shutdown();await rm(directory,{recursive:true,force:true});}
});

test('legacy unknown aggregate blocking remains fail-closed without a scoped classification',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'legacy-production-gate-')),f=tailFixture();let calls=0;
 const c=legacyCoordinator({dataRoot:directory,modelRunner:async()=>{calls++;throw Error('must not dispatch');}});
 try{
  const production=initial();delete production.globalBlocking;production.blocking=true;
  const run=await create(c,f.source,f.settings,production);await c.start(run.id);const stopped=await c.wait(run.id);
  assert.equal(calls,0);assert.equal(stopped.web.progress,'upstream_review');
 }finally{await c.shutdown();await rm(directory,{recursive:true,force:true});}
});
