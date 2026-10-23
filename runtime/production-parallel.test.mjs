import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readdir,readFile} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import path from 'node:path';
import {createProductionWorkflowService} from './production-workflow.mjs';
import {createProductionBudgetStore,withProductionBudget} from './production-budget.mjs';
import {digest} from './storyboard-v4/core/shared.mjs';
const workerModule=await import('./production-parallel.mjs').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));

async function fixture(t,episodeCount=8,laneCount){
 const directory=await mkdtemp(path.join(tmpdir(),'production-parallel-')),starts=[],runs={};
 const adapters={inspect:async()=>({sourceVersion:'source',availableEpisodes:Array.from({length:episodeCount},(_,i)=>i+1),stage1:{ready:true},standard:{ready:true},direction:{status:'CONFIRMED'},assets:{missingCandidateKeys:[],missingCriticalKeys:[]},runs:structuredClone(runs)}),
  readRun:async id=>runs[id],withBudget:async(_context,action)=>action(),run:async(action,workflow,context)=>{
   starts.push(action.episodeNumber);const id=`run-${action.episodeNumber}`;
   runs[id]={id,projectId:'p',episodeNumber:action.episodeNumber,busy:true,complete:false,blocked:false,fingerprint:`fingerprint-${id}`};
   await context.bind({runId:id,episodeNumber:action.episodeNumber});return {status:'RUN_STARTED'};
  }};
 const makeService=async()=>createProductionWorkflowService({directory,budgetDirectory:path.join(directory,'budget'),adapters});
 const service=await makeService();let v=await service.create({projectId:'p',actorId:'u',episodeNumbers:Array.from({length:episodeCount},(_,i)=>i+1)});
 v=await service.configureParallel(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u',...(laneCount?{laneCount}:{})});
 assert.equal(typeof workerModule.createParallelProductionWorker,'function','缺少服务端四路续派，不应依赖网页轮询');
 const worker=workerModule.createParallelProductionWorker({directory,makeService,intervalMs:20});
 t.after(async()=>{await worker.stop(v.workflow.id);await rm(directory,{recursive:true,force:true});});
 return {directory,service,makeService,worker,starts,runs,adapters,id:v.workflow.id,view:v};
}
async function until(check,timeout=4000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(r=>setTimeout(r,15));}assert.fail('免费队列未到达预期状态');}
async function stoppedIssues(t){
 const f=await fixture(t,12,6),started=await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});
 const d=started.workflow;
 for(const n of [1,3,5,7,9,11]){
  const id=`run-${n}`;d.selectedRuns[n]=id;
  f.runs[id]={id,projectId:'p',episodeNumber:n,busy:false,complete:n===9,blocked:![5,9].includes(n),fingerprint:`fp-${n}`,productionChain:{id:f.id,mode:d.mode},productionBudget:{id:d.budgetId,directory:path.join(f.directory,'budget')}};
 }
 d.parallel.enabled=false;d.parallel.lastStop='WAIT_ISSUES';d.parallel.worker={status:'WAIT_ISSUES',pid:123,authorization:d.parallel.authorizedAt};
 await writeFile(path.join(f.directory,'documents',f.id+'.json'),JSON.stringify(d));
 return {...f,before:structuredClone(d),command:{expectedAuthorization:d.parallel.authorizedAt,expectedRevision:d.revision,actorId:'u',resumeReadyIssues:true}};
}
test('explicit ready-lane recovery keeps original authority, holds blocked lanes and starts only ready normal work',async t=>{
 const f=await stoppedIssues(t);
 await f.service.reconnectParallel(f.id,{expectedAuthorization:f.before.parallel.authorizedAt});
 assert.deepEqual(await f.service.read(f.id),f.before,'ordinary reconnect stays read-only');
 const view=await f.service.reconnectParallel(f.id,f.command);
 assert.equal(view.parallel.enabled,true,'eligible original queue remains disabled after source review');
 assert.equal(view.workflow.parallel.authorizedAt,f.before.parallel.authorizedAt);assert.equal(view.workflow.parallel.authorizedBy,f.before.parallel.authorizedBy);
 assert.deepEqual(view.workflow.selectedRuns,f.before.selectedRuns);assert.deepEqual(view.workflow.budgetPolicy,f.before.budgetPolicy);
 assert.deepEqual(view.workflow.parallel.modelSelection,f.before.parallel.modelSelection);assert.deepEqual(view.workflow.paidRepairPolicy,f.before.paidRepairPolicy);
 assert.deepEqual(view.workflow.parallel.readyIssueRecovery.ready.map(x=>x.episodeNumber),[5,10]);assert.deepEqual(f.starts,[],'rearm itself is free');
 await f.worker.start(f.id,{expectedAuthorization:f.command.expectedAuthorization});await until(()=>f.starts.length===2);
 assert.deepEqual(f.starts,[5,10]);assert.deepEqual([1,3,7,11].map(n=>f.runs[`run-${n}`].blocked),[true,true,true,true]);
});
test('ready-lane recovery rejects manual pause, changed authority/revision, source/unknown budget and zero eligible lanes',async t=>{
 for(const kind of ['pause','authority','revision','source','unknown','no-ready','actor']){
  await t.test(kind,async t=>{
   const f=await stoppedIssues(t),command={...f.command};
   if(kind==='authority')command.expectedAuthorization='wrong';
   if(kind==='actor')command.actorId='another-member';
   if(kind==='revision')command.expectedRevision--;
   if(kind==='pause')await f.service.pause(f.id,{expectedRevision:f.before.revision,actorId:'u'});
   if(kind==='source'){const inspect=f.adapters.inspect;f.adapters.inspect=async w=>({...await inspect(w),sourceVersion:'changed'});}
   if(kind==='no-ready'){f.runs['run-5'].blocked=true;f.runs['run-9'].complete=false;f.runs['run-9'].blocked=true;}
   if(kind==='unknown'){const ledger=createProductionBudgetStore(path.join(f.directory,'budget')),attempt=await ledger.reserve(f.before.budgetId,{projectId:'p',stage:'author',provider:'CLI'});await ledger.settle(f.before.budgetId,attempt,{outcome:'UNKNOWN'});}
   const before=await f.service.read(f.id);await assert.rejects(f.service.reconnectParallel(f.id,command));
   assert.deepEqual(await f.service.read(f.id),before);assert.deepEqual(f.starts,[]);
  });
 }
});
test('ready-lane recovery returns its verified projection without a post-commit read that can strand an enabled queue',async t=>{
 const f=await stoppedIssues(t),inspect=f.adapters.inspect;let calls=0;
 f.adapters.inspect=async w=>{if(++calls>1)throw Object.assign(new Error('read unavailable'),{code:'DATABASE_READ_UNAVAILABLE'});return inspect(w);};
 const view=await f.service.reconnectParallel(f.id,f.command);
 assert.equal(view.parallel.enabled,true);assert.equal(view.workflow.parallel.authorizedAt,f.command.expectedAuthorization);assert.equal(calls,1);
});
test('a disabled configuration cannot start a background worker',async t=>{
 const f=await fixture(t);await f.worker.start(f.id);await new Promise(r=>setTimeout(r,50));
 assert.deepEqual(f.starts,[]);assert.equal((await f.service.read(f.id)).parallel.enabled,false);
});
test('six-lane worker refills without browser reads and cannot reconnect through human pause',async t=>{
 const f=await fixture(t,12,6);
 const started=await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});
 await Promise.all([f.worker.start(f.id),f.worker.start(f.id)]);
 await until(()=>f.starts.length===6);assert.deepEqual(f.starts,[1,3,5,7,9,11]);
 Object.assign(f.runs['run-9'],{busy:false,complete:true});
 await until(()=>f.starts.length===7);assert.equal(f.starts.at(-1),10);
 let v=await f.service.inspect(f.id);v=await f.service.pause(f.id,{expectedRevision:v.workflow.revision,expectedAuthorization:started.workflow.parallel.authorizedAt,actorId:'u'});
 for(const run of Object.values(f.runs))Object.assign(run,{busy:false,complete:true});
 await f.service.reconnectParallel(f.id,{expectedAuthorization:started.workflow.parallel.authorizedAt});
 await f.worker.start(f.id);await new Promise(r=>setTimeout(r,70));
 assert.equal(f.starts.length,7);assert.equal(new Set(f.starts).size,7);assert.equal((await f.service.read(f.id)).paused,true);
});
test('authorized restart archives a dead document owner before recording its worker; disabled histories stay untouched',async t=>{
 const f=await fixture(t,1),lock=path.join(f.directory,'documents',f.id+'.lock');
 const bytes=JSON.stringify({pid:99999999,host:hostname(),token:'original-document-owner'});
 await writeFile(lock,bytes,{flag:'wx'});await f.worker.start(f.id);assert.equal(await readFile(lock,'utf8'),bytes,'disabled history is not recovered');
 await rm(lock);let v=await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});
 await writeFile(lock,bytes,{flag:'wx'});await f.worker.start(f.id,{expectedAuthorization:v.workflow.parallel.authorizedAt});
 assert.ok((await readdir(path.dirname(lock))).some(name=>name.startsWith(f.id+'.stale-')));
 await until(()=>f.starts.length===1);assert.equal((await f.service.read(f.id)).parallel.authorizedAt,v.workflow.parallel.authorizedAt);
});
test('an authorized pump consumes saved FINAL responses before budget/repair gates without replay',async t=>{
 const f=await fixture(t,1);let recoveries=0;
 let v=await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});
 await f.service.pumpParallel(f.id);
 Object.assign(f.runs['run-1'],{busy:false,blocked:true,recoveryPending:true,productionChain:{id:f.id,mode:'CHAIN'},productionBudget:{id:v.workflow.budgetId,directory:path.join(f.directory,'budget')}});
 f.adapters.recoverSaved=async(_workflow,id)=>{recoveries++;assert.equal(id,'run-1');Object.assign(f.runs[id],{blocked:false,recoveryPending:false,complete:true});};
 await f.service.pumpParallel(f.id);assert.equal(recoveries,1);assert.deepEqual(f.starts,[1]);
 await f.service.pumpParallel(f.id);assert.equal(recoveries,1);
 const disabled=await f.service.read(f.id);await f.service.recordParallelWorker(f.id,{status:'PAUSED'},{stop:true});
 f.runs['run-1'].recoveryPending=true;await f.service.pumpParallel(f.id);assert.equal(recoveries,1,'disabled history is not automatically recovered or restarted');
 assert.ok(disabled.parallel.enabled);
});
test('one service worker refills all four lanes without browser reads and survives repeated start',async t=>{
 const f=await fixture(t);await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true,fastAcknowledged:true});
 await Promise.all([f.worker.start(f.id),f.worker.start(f.id)]);
 await until(()=>f.starts.length===4);assert.deepEqual(f.starts,[1,3,5,7]);
 Object.assign(f.runs['run-3'],{busy:false,complete:true});
 await until(()=>f.starts.length===5);assert.equal(f.starts.at(-1),4);
 for(const run of Object.values(f.runs))Object.assign(run,{busy:false,complete:true});
 await until(()=>f.starts.length===8);
 for(const run of Object.values(f.runs))Object.assign(run,{busy:false,complete:true});
 await until(async()=>(await f.service.read(f.id)).parallel.worker?.status==='WAITING_EVIDENCE');
 let v=await f.service.inspect(f.id);assert.equal(v.parallel.waitingForEvidence,true);assert.equal(v.parallel.enabled,true);
 assert.equal(v.parallel.completedEpisodes,8);assert.deepEqual(v.workflow.qualityReviews,[],'循环不能伪造审稿通过');
 v=await f.service.recordQualityReview(f.id,{expectedRevision:v.workflow.revision,actorId:'u',runId:'run-1',fingerprint:'fingerprint-run-1',authorReviewed:true,assemblyReviewed:true,majorIssuesResolved:true,note:'合成替身的显式质量核对，不是生产审稿。'});
 await until(async()=>!(await f.service.read(f.id)).parallel.enabled);assert.equal((await f.service.inspect(f.id)).parallel.status,'COMPLETE');
});
test('a changed authorization cannot be pumped by an old worker',async t=>{
 const f=await fixture(t);await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});
 await assert.rejects(f.service.pumpParallel(f.id,{expectedAuthorization:'older-authorization'}),{code:'WORKFLOW_PARALLEL_OWNER'});assert.deepEqual(f.starts,[]);
});
test('wake reconnect never unpauses a human stop or grants a new authorization',async t=>{
 const f=await fixture(t);let v=await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});
 const authorizedAt=v.workflow.parallel.authorizedAt;
 v=await f.service.reconnectParallel(f.id,{expectedAuthorization:authorizedAt});
 assert.equal(v.parallel.enabled,true);assert.equal(v.workflow.parallel.authorizedAt,authorizedAt);assert.deepEqual(f.starts,[]);
 v=await f.service.pause(f.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 v=await f.service.reconnectParallel(f.id,{expectedAuthorization:authorizedAt});await f.worker.start(f.id);
 assert.equal(v.workflow.paused,true);assert.equal(v.parallel.enabled,false);assert.deepEqual(f.starts,[]);
 await assert.rejects(f.service.reconnectParallel(f.id,{expectedAuthorization:'stale'}),{code:'WORKFLOW_PARALLEL_OWNER'});
});
test('read-only reconnect exhaustion parks until a wake instead of spinning or withdrawing permission',async t=>{
 const f=await fixture(t);await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});
 let reads=0,offline=true;const worker=workerModule.createParallelProductionWorker({directory:f.directory,intervalMs:20,makeService:async()=>({...f.service,pumpParallel:async id=>{
  reads++;if(offline)throw Object.assign(new Error('read connection unavailable'),{code:'P1008',retryableRead:true});return f.service.pumpParallel(id);
 }})});
 await worker.start(f.id);await until(async()=>(await f.service.read(f.id)).parallel.worker?.status==='WAIT_CONNECTION');
 const before=await f.service.read(f.id);assert.equal(before.parallel.enabled,true);assert.equal(reads,3);await new Promise(r=>setTimeout(r,80));assert.equal(reads,3);
 offline=false;await worker.start(f.id);await until(async()=>f.starts.length===4&&(await f.service.read(f.id)).parallel.worker.readRecoveryCount===0);
 const after=await f.service.read(f.id);assert.equal(after.parallel.authorizedAt,before.parallel.authorizedAt);assert.equal(after.parallel.worker.readRecoveryCount,0);
});
test('non-draining worker stop acknowledges the gate while an outer preparation finishes',async t=>{
 const f=await fixture(t);let release,entered;
 const gate=new Promise(r=>release=r),arrived=new Promise(r=>entered=r);t.after(()=>release());
 const worker=workerModule.createParallelProductionWorker({directory:f.directory,intervalMs:20,makeService:async()=>({...f.service,pumpParallel:async id=>{entered();await gate;return f.service.inspect(id);}})});
 await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});await worker.start(f.id);await arrived;
 const v=await f.service.inspect(f.id);await f.service.pause(f.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 let returned=false;const stop=worker.stop(f.id,'PAUSED',{drain:false}).then(()=>returned=true);
 await new Promise(r=>setTimeout(r,40));const immediate=returned;release();await stop;await worker.stop(f.id);assert.equal(immediate,true);assert.deepEqual(f.starts,[]);
});
test('an idle pump does not immediately repeat the same full preparation read',async t=>{
 const f=await fixture(t,1);await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});await f.service.pumpParallel(f.id);
 let inspections=0;const inspect=f.adapters.inspect;f.adapters.inspect=async w=>{inspections++;return inspect(w);};
 await f.service.pumpParallel(f.id);assert.equal(inspections,1);
 await f.service.pumpParallel(f.id);assert.equal(inspections,2,'the next tick still reads fresh source and state; no TTL cache');
});
test('completion exports only after an actual review, and repeats reuse files without model work',async t=>{
 const f=await fixture(t,1);let exports=0;
 f.adapters.deliveryBundle=async w=>{exports++;const files={'complete.md':'合成采用稿：0.75秒，不改原文。\n'},manifest={workflowId:w.id,projectId:w.projectId};return {identity:digest([manifest,files]),manifest,files};};
 let v=await f.service.configureDelivery(f.id,{expectedRevision:f.view.workflow.revision,enabled:true});
 v=await f.service.startParallel(f.id,{expectedRevision:v.workflow.revision,actorId:'u',costAcknowledged:true});await f.service.pumpParallel(f.id);
 Object.assign(f.runs['run-1'],{busy:false,complete:true});v=await f.service.pumpParallel(f.id);assert.equal(exports,0,'mechanical completion is not quality acceptance');
 v=await f.service.recordQualityReview(f.id,{expectedRevision:v.workflow.revision,actorId:'u',runId:'run-1',fingerprint:'fingerprint-run-1',authorReviewed:true,assemblyReviewed:true,majorIssuesResolved:true,note:'合成替身明确核对，非生产验收。'});
 assert.ok(v.workflow.delivery.result.identity);assert.deepEqual(f.starts,[1]);
 const identity=v.workflow.delivery.result.identity;
 v=await f.service.exportDelivery(f.id,{expectedRevision:v.workflow.revision});assert.equal(v.workflow.delivery.result.identity,identity);assert.equal(v.workflow.delivery.result.reused,true);assert.deepEqual(f.starts,[1]);
});
test('worker failures are saved and stop instead of spinning or restarting paid actions',async t=>{
 const f=await fixture(t);await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true,fastAcknowledged:true});
 const bad=workerModule.createParallelProductionWorker({directory:f.directory,makeService:async()=>({...f.service,pumpParallel:async()=>{throw Object.assign(new Error('synthetic failure'),{code:'TEST_FAILURE'});}}),intervalMs:20});
 await bad.start(f.id);
 await until(async()=>!(await f.service.read(f.id)).parallel.enabled);
 const d=await f.service.read(f.id);assert.equal(d.parallel.worker.status,'INTERRUPTED');assert.equal(d.parallel.worker.error.code,'TEST_FAILURE');assert.deepEqual(f.starts,[]);
});
test('a bounded proven read-only outage reconnects the original worker without a user restart',async t=>{
 const f=await fixture(t);await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});
 let reads=0;
 const worker=workerModule.createParallelProductionWorker({directory:f.directory,intervalMs:20,makeService:async()=>({...f.service,pumpParallel:async id=>{
  reads++;if(reads<=2)throw Object.assign(new Error('private query unavailable'),{code:'P1008',retryableRead:true});
  return f.service.pumpParallel(id);
 }})});
 await worker.start(f.id);await until(()=>f.starts.length===4);
 const d=await f.service.read(f.id);assert.equal(d.parallel.enabled,true);assert.equal(reads,3);assert.equal(d.receipts.length,4);
 assert.ok(!JSON.stringify(d.parallel.worker).includes('private query'),'diagnostic query text must not leave the server');
});
test('a read outage that makes no progress stops after two reconnects',async t=>{
 const f=await fixture(t);await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});
 let reads=0;const worker=workerModule.createParallelProductionWorker({directory:f.directory,intervalMs:20,makeService:async()=>({...f.service,pumpParallel:async()=>{
  reads++;throw Object.assign(new Error('temporary read outage'),{code:'P1008',retryableRead:true});
 }})});
 await worker.start(f.id);await until(async()=>(await f.service.read(f.id)).parallel.worker?.status==='WAIT_CONNECTION');
 assert.equal(reads,3);assert.deepEqual(f.starts,[]);assert.equal((await f.service.read(f.id)).parallel.enabled,true);
});
test('unbound creation read failures use the same bounded worker reconnect without buying duplicate runs',async t=>{
 const f=await fixture(t),run=f.adapters.run;let reads=0;
 f.adapters.run=async(...args)=>{if(++reads<=2)throw Object.assign(new Error('private read-only context failure'),{code:'CONTEXT_UNAVAILABLE',requestOutcome:'NOT_SENT',retryableRead:true});return run(...args);};
 await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});await f.worker.start(f.id);
 await until(async()=>f.starts.length===4||!(await f.service.read(f.id)).parallel.enabled);
 const d=await f.service.read(f.id);assert.deepEqual(f.starts,[1,3,5,7]);assert.equal(reads,6);
 const rejected=d.receipts.filter(r=>r.error);assert.equal(rejected.length,2);
 assert.ok(rejected.every(r=>r.status==='NOT_SENT'&&r.error.retryableRead===true));
 const budget=await createProductionBudgetStore(path.join(f.directory,'budget')).read(d.budgetId);
 assert.equal(budget.summary.calls,0,'free admission must not fabricate native zero-token calls');assert.equal(budget.summary.unknownAttempts,0);
});
test('a persistent unbound creation outage stops after the original two reconnects',async t=>{
 const f=await fixture(t);let reads=0;
 f.adapters.run=async()=>{reads++;throw Object.assign(new Error('proven read outage'),{code:'CONTEXT_UNAVAILABLE',requestOutcome:'NOT_SENT',retryableRead:true});};
 await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});await f.worker.start(f.id);
 await until(async()=>(await f.service.read(f.id)).parallel.worker?.status==='WAIT_CONNECTION');
 const d=await f.service.read(f.id);assert.equal(reads,3);assert.equal(d.parallel.worker.readRecoveryCount,2);assert.equal(d.receipts.length,3);assert.deepEqual(f.starts,[]);
});
test('bound empty admission resumes the same run across create and continue read failures',async t=>{
 const f=await fixture(t);let failed=0;
 f.adapters.run=async(action,workflow,context)=>{
  const id=action.runId??`run-${action.episodeNumber}`;
  if(action.kind==='STORYBOARD_CREATE'){
   f.starts.push(action.episodeNumber);f.runs[id]={id,projectId:'p',episodeNumber:action.episodeNumber,busy:false,complete:false,blocked:false,emptyAdmission:true,
    productionChain:{id:f.id,mode:'CHAIN'},productionBudget:context.budget};
  }
  await context.bind({runId:id,episodeNumber:action.episodeNumber});
  if(failed<2){failed++;throw Object.assign(new Error('proven empty admission read failure'),{code:'CONTEXT_UNAVAILABLE',requestOutcome:'NOT_SENT',retryableRead:true});}
  Object.assign(f.runs[id],{busy:true,emptyAdmission:false});return {status:'RUN_STARTED'};
 };
 await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});await f.worker.start(f.id);
 await until(async()=>f.starts.length===4||!(await f.service.read(f.id)).parallel.enabled);
 const d=await f.service.read(f.id);assert.deepEqual(f.starts,[1,3,5,7]);assert.equal(d.parallel.enabled,true);
 const rejected=d.receipts.filter(r=>r.error);assert.equal(rejected.length,2);
 assert.deepEqual(rejected.map(r=>r.kind),['STORYBOARD_CREATE','STORYBOARD_CONTINUE']);
 assert.ok(rejected.every(r=>r.status==='RECOVERED'&&r.runId==='run-1'&&r.error.retryableRead===true));
 const budget=await createProductionBudgetStore(path.join(f.directory,'budget')).read(d.budgetId);assert.equal(budget.summary.calls,0);
});
test('persistent bound empty admission stops after two reconnects without recreating the run',async t=>{
 const f=await fixture(t);let reads=0;
 f.adapters.run=async(action,workflow,context)=>{
  reads++;const id=action.runId??'run-1';
  if(action.kind==='STORYBOARD_CREATE'){f.starts.push(1);f.runs[id]={id,projectId:'p',episodeNumber:1,busy:false,complete:false,blocked:false,emptyAdmission:true,productionChain:{id:f.id,mode:'CHAIN'},productionBudget:context.budget};}
  await context.bind({runId:id,episodeNumber:1});throw Object.assign(new Error('persistent proven read failure'),{code:'CONTEXT_UNAVAILABLE',requestOutcome:'NOT_SENT',retryableRead:true});
 };
 await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});await f.worker.start(f.id);
 await until(async()=>(await f.service.read(f.id)).parallel.worker?.status==='WAIT_CONNECTION');
 const d=await f.service.read(f.id);assert.equal(reads,3);assert.deepEqual(f.starts,[1]);assert.equal(d.parallel.worker.readRecoveryCount,2);
 assert.equal(d.receipts.at(-1).status,'INTERRUPTED');assert.equal(d.receipts.at(-1).runId,'run-1');
});
test('bound admission requires empty-run proof, exact binding and a proven NOT_SENT read',async t=>{
 for(const patch of [
  {emptyAdmission:false},{projectId:'foreign'},{productionChain:{id:'foreign',mode:'CHAIN'}},{productionBudget:{id:'foreign',directory:'/not-the-budget'}},
  {error:{code:'CONTEXT_UNAVAILABLE',requestOutcome:'UNKNOWN',retryableRead:true}},
  {error:{code:'CONTEXT_UNAVAILABLE',requestOutcome:'NOT_SENT'}},{error:{code:'SOURCE_STALE',requestOutcome:'NOT_SENT',retryableRead:true}}
 ]){
  const f=await fixture(t);let reads=0;
  f.adapters.run=async(action,workflow,context)=>{reads++;f.starts.push(1);f.runs['run-1']={id:'run-1',projectId:'p',episodeNumber:1,busy:false,complete:false,blocked:false,emptyAdmission:true,productionChain:{id:f.id,mode:'CHAIN'},productionBudget:context.budget,...patch};await context.bind({runId:'run-1',episodeNumber:1});throw Object.assign(new Error('unsafe admission'),patch.error??{code:'CONTEXT_UNAVAILABLE',requestOutcome:'NOT_SENT',retryableRead:true});};
  await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});await f.worker.start(f.id);
  await until(async()=>!(await f.service.read(f.id)).parallel.enabled);assert.equal(reads,1);assert.deepEqual(f.starts,[1]);
 }
});
test('creation never reconnects an unknown fee, unproven transaction or source failure',async t=>{
 for(const error of [
  {code:'CONTEXT_UNAVAILABLE',requestOutcome:'UNKNOWN',retryableRead:true},
  {code:'P2028',requestOutcome:'NOT_SENT'},
  {code:'SOURCE_STALE',requestOutcome:'NOT_SENT',retryableRead:true}
 ]){const f=await fixture(t);let reads=0;
  f.adapters.run=async()=>{reads++;throw Object.assign(new Error('not a safe reconnect'),error);};
  await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});await f.worker.start(f.id);
  await until(async()=>!(await f.service.read(f.id)).parallel.enabled);assert.equal(reads,1);assert.deepEqual(f.starts,[]);
 }
});
test('initial read-only connection failures also reconnect before any dispatch',async t=>{
 const f=await fixture(t);await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});
 let reads=0;const worker=workerModule.createParallelProductionWorker({directory:f.directory,intervalMs:20,makeService:async()=>{
  reads++;if(reads<=2)throw Object.assign(new Error('initial pure read outage'),{code:'P1008',retryableRead:true});return f.makeService();
 }});
 await worker.start(f.id);await until(()=>f.starts.length===4);assert.ok(reads>=3);assert.equal((await f.service.read(f.id)).parallel.enabled,true);
});
test('a paused old worker cannot disable a newly authorized restart',async t=>{
 const f=await fixture(t);let release,entered,first=true;
 const gate=new Promise(r=>release=r),arrived=new Promise(r=>entered=r);
 const worker=workerModule.createParallelProductionWorker({directory:f.directory,intervalMs:20,makeService:async()=>({...f.service,pumpParallel:async id=>{
  if(first){first=false;entered();await gate;return f.service.inspect(id);}return f.service.pumpParallel(id);
 }})});
 t.after(()=>{release();return worker.stop(f.id);});
 await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true,fastAcknowledged:true});
 await worker.start(f.id);await arrived;
 let v=await f.service.inspect(f.id);v=await f.service.pause(f.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 const stopping=worker.stop(f.id);await new Promise(r=>setTimeout(r,15));
 await f.service.startParallel(f.id,{expectedRevision:v.workflow.revision,actorId:'u',costAcknowledged:true,fastAcknowledged:true});
 const restarting=worker.start(f.id);release();await Promise.all([stopping,restarting]);
 await until(()=>f.starts.length===4);
 assert.equal((await f.service.read(f.id)).parallel.enabled,true);
});
test('server pause persistence and another client restart share a lifecycle gate without cancelling models',async t=>{
 const f=await fixture(t);assert.equal(typeof f.worker.serialize,'function','服务端暂停与重启尚未共享同一生命周期门');
 let release,entered;const gate=new Promise(r=>release=r),arrived=new Promise(r=>entered=r);
 t.after(()=>release());
 await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true,fastAcknowledged:true});await f.worker.start(f.id);await until(async()=>f.starts.length===4&&!(await f.service.read(f.id)).activeAction);
 let v=await f.service.inspect(f.id);
 const originalInspect=f.adapters.inspect;let holdNext=true;
 f.adapters.inspect=async w=>{if(w.paused&&holdNext){holdNext=false;entered();await gate;}return originalInspect(w);};
 const pausing=f.worker.serialize(f.id,async()=>{await f.service.pause(f.id,{expectedRevision:v.workflow.revision,actorId:'u'});await f.worker.stop(f.id);});
 await arrived;const intermediate=await f.service.inspect(f.id);let restartEntered=false;
 const restarting=f.worker.serialize(f.id,async()=>{restartEntered=true;await f.service.startParallel(f.id,{expectedRevision:intermediate.workflow.revision,actorId:'u',costAcknowledged:true,fastAcknowledged:true});await f.worker.start(f.id);});
 const rejected=assert.rejects(restarting,e=>e.code==='WORKFLOW_CONFLICT');
 await new Promise(r=>setTimeout(r,20));assert.equal(restartEntered,false);release();await pausing;await rejected;
 v=await f.service.inspect(f.id);assert.equal(v.parallel.enabled,false);assert.deepEqual(f.starts,[1,3,5,7]);
 await f.worker.serialize(f.id,async()=>{await f.service.startParallel(f.id,{expectedRevision:v.workflow.revision,actorId:'u',costAcknowledged:true,fastAcknowledged:true});await f.worker.start(f.id);});
 await until(async()=>(await f.service.read(f.id)).parallel.worker.status==='RUNNING');
 assert.equal((await f.service.read(f.id)).parallel.enabled,true);
});

test('all eighty episodes refill through the real worker and ledger, including read outages and saved-run recovery',async t=>{
 const f=await fixture(t,80),jobs=[],attempts=new Set(),active=new Set();let peak=0,polls=0;
 const ledger=createProductionBudgetStore(path.join(f.directory,'budget'));
 f.adapters.run=async(action,workflow,context)=>{
  const n=action.episodeNumber;assert.equal(action.kind,'STORYBOARD_CREATE');assert.ok(!f.starts.includes(n),'an episode cannot be bought again');
  f.starts.push(n);const id=`run-${n}`,run=f.runs[id]={id,projectId:'p',episodeNumber:n,busy:true,complete:false,blocked:false,fingerprint:`final-${n}`,
   productionChain:{id:f.id,mode:'CHAIN'},productionBudget:context.budget};
  assert.ok(!active.has(n));active.add(n);peak=Math.max(peak,active.size);assert.ok(peak<=4);
  await context.bind({runId:id,episodeNumber:n});
  // Substitute only the provider: real queue, action persistence and shared accounting remain in use.
  const job=(async()=>{
   for(const stage of n===45?['plan','author','finish','local-finish']:['plan','author','finish']){
    const attemptId=`synthetic-${n}-${stage}`;assert.ok(!attempts.has(attemptId));attempts.add(attemptId);
    await withProductionBudget({...context.budget,projectId:'p',runId:id,attemptId,stage,provider:'CLI'},async()=>{
     await new Promise(r=>setTimeout(r,5));return {usage:{totalTokens:100000},requestOutcome:'RESPONDED'};
    });
   }
   active.delete(n);Object.assign(run,{busy:false,complete:true});
   if(n===41&&!f.runs['run-40']?.complete)Object.assign(run,{complete:false,continuityPending:true,continuityStatus:'PRELIMINARY'});
   if(n===40&&f.runs['run-41'])Object.assign(f.runs['run-41'],{complete:true,continuityPending:false,continuityStatus:'MATCHED'});
  })();jobs.push(job);
  if(n===21)throw Object.assign(new Error('outer read failed after binding'),{code:'P1008',requestOutcome:'NOT_SENT'});
  return {status:'RUN_STARTED'};
 };
 const worker=workerModule.createParallelProductionWorker({directory:f.directory,intervalMs:20,makeService:async()=>({...await f.makeService(),pumpParallel:async id=>{
  polls++;if(polls<=2)throw Object.assign(new Error('synthetic read outage'),{code:'P1008',retryableRead:true});return f.service.pumpParallel(id);
 }})});
 t.after(async()=>{await Promise.allSettled(jobs);});
 await f.service.startParallel(f.id,{expectedRevision:f.view.workflow.revision,actorId:'u',costAcknowledged:true});await worker.start(f.id);
 await until(async()=>(await f.service.inspect(f.id)).parallel.status==='QUALITY_CHECK',30000);await Promise.all(jobs);
 const v=await f.service.inspect(f.id),budget=await ledger.read(v.workflow.budgetId);
 assert.equal(v.parallel.completedEpisodes,80);assert.equal(v.parallel.status,'QUALITY_CHECK');assert.equal(v.parallel.provisionalEpisodes,0);
 assert.deepEqual(f.starts.slice(0,4),[1,21,41,61]);assert.equal(new Set(f.starts).size,80);assert.equal(peak,4);
 assert.equal(attempts.size,241);assert.equal(budget.summary.calls,241);assert.equal(budget.summary.knownTokens,24100000);assert.equal(budget.summary.unknownAttempts,0);
 assert.equal(budget.maxCalls,480);assert.equal(budget.maxTokens,36000000);assert.equal(budget.summary.inFlight,0);
 assert.deepEqual(v.workflow.qualityReviews,[],'mechanical completion must not invent an actual content review');
 assert.equal(v.workflow.receipts.filter(r=>r.recoveryMethod==='SAVED_RUN_ONLY').length,1);
 assert.equal(v.parallel.enabled,true);assert.equal(v.parallel.waitingForEvidence,true,'only the explicitly authorized worker waits for evidence; it cannot approve it');
});
