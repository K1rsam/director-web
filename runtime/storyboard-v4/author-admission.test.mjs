import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createCoordinator} from './coordinator.mjs';
import {tailFixture,tailDraft} from './core/author-call-group-test-fixtures.mjs';
import {DELTA_VERSION} from './core/delta.mjs';

const binding={projectId:'synthetic-admission',episodeId:'episode-1',sourceVersion:'source-v1'};
const production=()=>({version:'production-feedback-v1',boundary:null,materials:[],outgoingAgreements:[]});
const agreement={key:'PR01/receiver',value:'乙',authority:'DESIGN',sourceRefs:[]};
function singlePackageFixture(){
 const f=tailFixture();
 f.source.sourceRows=f.source.sourceRows.slice(-1);
 f.plan.events=f.plan.events.slice(-1).map(e=>({...e,boundaryBefore:{kind:'episode_start',reason:'本次测试完整源范围开始'}}));
 f.plan.workPackages=f.plan.workPackages.slice(-1).map(w=>({...w,dependsOn:[]}));
 f.plan.provisionalUnits=f.plan.provisionalUnits.filter(u=>u.packageId==='p3');
 return f;
}
function response(request,fixture){
 let output=request.stage==='plan'?fixture.plan:tailDraft(request);
 if(request.finishMode==='delta'){
  const marker='【生效设置与本次完整资料】\n';
  const input=JSON.parse(request.prompt.slice(request.prompt.lastIndexOf(marker)+marker.length).split('\n')[0]);
  output={schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:input.previousDraft.units.map(u=>u.id),replacements:[],revisionNotes:[],unresolved:[]};
 }
 output={...output,productionFeedback:{relation:'INDEPENDENT',entry:[],exit:request.productionSnapshot.touchesEnding?request.productionSnapshot.outgoingAgreements:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]}};
 return {output,usage:{totalTokens:1},requestOutcome:'RESPONDED'};
}

test('author admission is not called by planning or finishing',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'author-admission-stages-')),f=singlePackageFixture(),events=[];
 const c=createCoordinator({dataRoot:directory,beforeAuthorAdmission:async(received,run)=>{
  assert.deepEqual(received,binding);assert.ok(run.plan);assert.equal(run.operations.at(-1).stage,'plan');events.push('admission');
 },modelRunner:async request=>{events.push(request.stage);return response(request,f);}});
 try{
  const run=await c.create({...f,binding,production:production()});await c.start(run.id);const done=await c.wait(run.id);
  assert.equal(done.status,'text_ready_for_review',JSON.stringify(done.web));
  assert.deepEqual(events,['plan','admission','author','finish']);
 }finally{await c.shutdown();await rm(directory,{recursive:true,force:true});}
});

test('admission seals then reloads production before freezing the author request and dispatching it',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'author-admission-order-')),f=singlePackageFixture(),events=[];
 let current=production(),entered,release;
 const enteredHook=new Promise(resolve=>entered=resolve),hold=new Promise(resolve=>release=resolve);
 const c=createCoordinator({dataRoot:directory,loadProductionContext:async()=>{events.push(current.outgoingAgreements.length?'reload-sealed':'reload-empty');return current;},
  beforeAuthorAdmission:async()=>{events.push('admission-enter');entered();await hold;current={...current,outgoingAgreements:[agreement]};events.push('admission-sealed');},
  modelRunner:async(request,options)=>{
   events.push(`model-${request.stage}`);
   if(request.stage==='author'){
    assert.deepEqual(request.productionSnapshot.outgoingAgreements,[agreement]);
    const saved=await c.read(options.runId),operation=saved.operations.find(o=>o.attemptId===options.attemptId);
    assert.deepEqual(operation.productionSnapshot.outgoingAgreements,[agreement],'persisted immutable request must include the sealed choices');
    assert.match(request.prompt,/PR01\/receiver/);
    assert.ok(events.indexOf('admission-sealed')<events.indexOf('reload-sealed'));
    assert.ok(events.indexOf('reload-sealed')<events.indexOf('model-author'));
   }
   return response(request,f);
  }});
 try{
  const run=await c.create({...f,binding,production:production()});await c.start(run.id,{mode:'next'});const planned=await c.wait(run.id);
  await c.start(run.id,{mode:'next'});await enteredHook;
  const held=await c.read(run.id);
  assert.deepEqual(held.operations,planned.operations,'while sealing, no author snapshot or dispatch can be committed');
  assert.deepEqual(held.web.reservedAttemptIds,[]);assert.equal(events.includes('model-author'),false);
  release();const authored=await c.wait(run.id);
  assert.equal(authored.operations.at(-1).stage,'author');assert.equal(authored.operations.at(-1).status,'completed');
  assert.deepEqual(authored.operations[0],planned.operations[0],'new choices must not mutate the old plan request');
 }finally{release();await c.shutdown();await rm(directory,{recursive:true,force:true});}
});

test('admission errors fail before an attempt exists and cannot become unknown model usage',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'author-admission-error-')),f=singlePackageFixture(),calls=[];
 const c=createCoordinator({dataRoot:directory,beforeAuthorAdmission:async()=>{throw Object.assign(new Error('共同制作约定尚不能封存'),{code:'AUTHOR_ADMISSION_REJECTED',requestOutcome:'UNKNOWN'});},
  modelRunner:async request=>{calls.push(request.stage);return response(request,f);}});
 try{
  const run=await c.create({...f,binding,production:production()});await c.start(run.id);const stopped=await c.wait(run.id);
  assert.deepEqual(calls,['plan']);assert.deepEqual(stopped.operations.map(o=>o.stage),['plan']);
  assert.equal(stopped.web.progress,'failed');assert.equal(stopped.web.error.code,'AUTHOR_ADMISSION_REJECTED');
  assert.deepEqual(stopped.web.reservedAttemptIds,[]);assert.equal(stopped.web.reserved,0);
  assert.equal(stopped.operations.some(o=>o.status==='unknown'),false);assert.deepEqual(await c.cancellationStatus(run.id),[]);
  assert.equal(c.active(run.id),false);
 }finally{await c.shutdown();await rm(directory,{recursive:true,force:true});}
});
