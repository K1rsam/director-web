import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createCoordinator,freePreparationRecoveryCause} from './storyboard-v4/coordinator.mjs';
import {createStore} from './storyboard-v4/core/store.mjs';
import {buildRequest} from './storyboard-v4/core/core.mjs';
import {tailFixture} from './storyboard-v4/core/author-call-group-test-fixtures.mjs';

test('an interrupted internal dispatch gate only resumes when the operation was demonstrably NOT_SENT',()=>{
 for(const code of ['WORKFLOW_PAUSED','SCHEMA_ADMISSION_REJECTED']){
  assert.equal(freePreparationRecoveryCause({web:{progress:'failed',error:{code}},operations:[{error:{requestOutcome:'NOT_SENT'}}]}),true);
  for(const outcome of ['UNKNOWN','RESPONDED',undefined])assert.equal(freePreparationRecoveryCause({web:{progress:'failed',error:{code}},operations:[{error:{requestOutcome:outcome}}]}),false);
 }
 assert.equal(freePreparationRecoveryCause({web:{progress:'failed',error:{code:'CLI_FAILED'}},operations:[{error:{requestOutcome:'UNKNOWN'}}]}),false);
});

test('future input-policy change preserves paid plan, rule snapshot, candidates and budget without dispatch',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'input-policy-')),f=tailFixture(),sent=[];
 const runner=async request=>{sent.push(structuredClone(request));const output={...structuredClone(f.plan),productionFeedback:{relation:'INDEPENDENT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]}};return{output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{inputTokens:80,outputTokens:20,totalTokens:100}};};
 const coordinator=createCoordinator({dataRoot:directory,modelRunner:runner});
 try{
  const created=await coordinator.create({...f,binding:{projectId:'synthetic',episodeId:'one',sourceVersion:'fixed'},production:{boundary:null,materials:[]}});
  // Reproduce an already frozen legacy task, not a new-policy generation.
  const store=createStore(directory);await store.update(created.id,d=>{delete d.rulesSnapshot.historyPolicy;delete d.rulesSnapshot.productionFeedbackInheritanceVersion;return d;});
  await coordinator.start(created.id,{mode:'next'});await coordinator.wait(created.id);
  const before=await coordinator.read(created.id);assert.equal(before.status,'planned');assert.equal(sent.length,1);
  await coordinator.configureInputPolicy(created.id,{historyPolicy:'episode-history-focused-v2',feedbackInheritanceVersion:'production-feedback-inheritance-v2',note:'只减少将来资料输入，不重跑已付规划。'});
  const after=await coordinator.read(created.id);
  for(const key of ['source','plan','operations','candidates','adopted','rulesSnapshot'])assert.deepEqual(after[key],before[key],key);
  assert.deepEqual(after.web.budget,before.web.budget);assert.equal(sent.length,1);assert.equal(after.web.inputPolicyHistory.length,1);
  const reconstructed=buildRequest({...sent[0],source:after.source,settings:after.settings,rulesSnapshot:after.rulesSnapshot});
  for(const key of ['inputHash','promptHash','instructionHash'])assert.equal(reconstructed[key],sent[0][key],'旧付费请求仍按冻结协议复建：'+key);
  assert.equal(sent.length,1);
  await assert.rejects(()=>coordinator.configureInputPolicy(created.id,{historyPolicy:'unknown',feedbackInheritanceVersion:'production-feedback-inheritance-v2',note:'不能猜'}),e=>e.code==='INPUT_POLICY');
 }finally{await coordinator.shutdown();await rm(directory,{recursive:true,force:true});}
});

test('failed free preparation is counted before read and cannot spin or reset on NOT_SENT operations',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'bounded-read-recovery-')),f=tailFixture();let sent=0;
 const coordinator=createCoordinator({dataRoot:directory,loadProductionContext:async()=>{throw Object.assign(new Error('合成只读锁等待'),{code:'P1008'});},modelRunner:async()=>{sent++;throw new Error('must not send');}});
 try{
  const created=await coordinator.create({...f,binding:{projectId:'synthetic',episodeId:'one',sourceVersion:'fixed'},production:{boundary:null,materials:[]}});
  const store=createStore(directory);await store.update(created.id,d=>{d.web.progress='failed';d.web.error={code:'P1008',message:'synthetic'};return d;});
  for(let i=0;i<2;i++)await assert.rejects(()=>coordinator.start(created.id,{mode:'all'}),e=>e.code==='P1008');
  const stopped=await coordinator.read(created.id);assert.equal(stopped.web.localReadRecovery.attempts,2);
  await store.update(created.id,d=>{d.operations.push({attemptId:'not-sent',status:'failed',receipt:{requestOutcome:'NOT_SENT',usage:{totalTokens:0}}});return d;});
  await assert.rejects(()=>coordinator.start(created.id,{mode:'all'}),e=>e.code==='READ_RECOVERY_EXHAUSTED');
  assert.equal(sent,0);
 }finally{await coordinator.shutdown();await rm(directory,{recursive:true,force:true});}
});

test('a newly recovered known native candidate receipt resets the free preparation cap consistently with queue admission',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'recovered-read-cap-')),f=tailFixture();let sent=0;
 const coordinator=createCoordinator({dataRoot:directory,loadProductionContext:async()=>{throw Object.assign(new Error('合成下一步准备锁等待'),{code:'P1008'});},modelRunner:async()=>{sent++;throw new Error('must not send');}});
 try{
  const created=await coordinator.create({...f,binding:{projectId:'synthetic',episodeId:'one',sourceVersion:'fixed'},production:{boundary:null,materials:[]}});
  const store=createStore(directory);await store.update(created.id,d=>{
   d.web.progress='failed';d.web.error={code:'P1008',message:'synthetic'};
   d.web.localReadRecovery={attempts:2,afterAttemptCount:0};
   d.operations.push({attemptId:'recovered',status:'completed',receipt:{requestOutcome:'UNKNOWN',usage:null}});
   d.candidates.push({id:'recovered-known',attemptId:'recovered',status:'adopted',receipt:{requestOutcome:'RESPONDED',usage:{inputTokens:80,outputTokens:20,totalTokens:100}}});
   return d;
  });
  await assert.rejects(()=>coordinator.start(created.id,{mode:'all'}),e=>e.code==='P1008','the new known response starts a bounded new read recovery, not READ_RECOVERY_EXHAUSTED');
  const after=await coordinator.read(created.id);
  assert.equal(after.web.localReadRecovery.attempts,1);assert.equal(after.web.localReadRecovery.afterAttemptCount,1);assert.equal(sent,0);
 }finally{await coordinator.shutdown();await rm(directory,{recursive:true,force:true});}
});
