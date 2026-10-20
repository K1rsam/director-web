import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createStore} from './storyboard-v4/core/store.mjs';
import {createEngine,rebuildFrozenRequest} from './storyboard-v4/core/pipeline.mjs';
import {FEEDBACK_RESULT_VERSION} from './storyboard-v4/core/production-feedback-result.mjs';
import {tailFixture} from './storyboard-v4/core/author-call-group-test-fixtures.mjs';
import {freePreparationRecoveryCause} from './storyboard-v4/coordinator.mjs';
const m=await import('./production-maintenance-control.mjs').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));

async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'production-maintenance-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const workflowDirectory=path.join(root,'flows'),dataRoot=path.join(root,'runs'),budgetDirectory=path.join(root,'budgets');
 const flows=createStore(workflowDirectory),runs=createStore(dataRoot,{trackRevision:true}),budgets=createStore(budgetDirectory);
 const workflow={id:'flow',schema:'PRODUCTION_WORKFLOW_V1',projectId:'project',sourceVersion:'source',revision:8,paused:false,status:'READY',activeAction:null,budgetId:'budget',budgetPolicy:{episode:{maxCalls:8,maxTokens:600000},warningTokens:500000},episodeNumbers:[1,2,3],selectedRuns:{1:'done',2:'active'},parallel:{enabled:true,authorizedAt:'original-auth',authorizedBy:'user',modelSelection:{model:'gpt-6.1-sol',reasoning:'high'},executionTier:'standard',runBudget:{maxCalls:8,maxTokens:600000},lanes:[[1],[2],[3]],worker:{token:'worker',pid:process.pid,status:'RUNNING'}}};
 await flows.create('flow',workflow);await budgets.create('budget',{id:'budget',projectIds:['project'],maxCalls:900,maxTokens:67500000,paused:false,attempts:[],summary:{inFlight:0,unknownAttempts:0}});
 const web={binding:{projectId:'project',episodeNumber:2,productionChain:{id:'flow'},productionBudget:{id:'budget',directory:budgetDirectory}},owner:process.pid,reserved:1,reservedAttemptIds:['paid'],pauseRequested:false,stopped:false,sourceStale:false,progress:'running'};
 await runs.create('active',{id:'active',status:'drafting',web,operations:[{attemptId:'paid',status:'running'}],candidates:[],adopted:[],production:{},rulesSnapshot:{}});
 await runs.create('done',{id:'done',status:'text_ready_for_review',web:{...web,owner:null,reserved:0,reservedAttemptIds:[],binding:{...web.binding,episodeNumber:1},progress:'text_ready_for_review'},operations:[{attemptId:'done-paid',status:'completed',receipt:{requestOutcome:'RESPONDED',usage:{totalTokens:4}}}],assembly:{text:'既有采用稿'},production:{}});
 assert.equal(typeof m.createRuntimeMaintenance,'function','缺少通用持久维护入口');
 const service=m.createRuntimeMaintenance({workflowDirectory,dataRoot,budgetDirectory});
 return {root,flows,runs,budgets,workflow,service,dataRoot,workflowDirectory,budgetDirectory};
}
test('maintenance holds new admission, preserves original authorization and never rewrites a completed episode',async t=>{
 const f=await fixture(t),done=await f.runs.read('done');
 const c=await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});
 const flow=await f.flows.read('flow'),active=await f.runs.read('active');
 assert.equal(flow.paused,true);assert.equal(flow.parallel.enabled,false);assert.equal(flow.parallel.authorizedAt,'original-auth');assert.equal(flow.parallel.authorizedBy,'user');
 assert.equal(active.operations[0].status,'running','原付费在途不得被取消或改终态');assert.equal(active.web.pauseRequested,true);
 assert.deepEqual(await f.runs.read('done'),done);assert.equal(c.phase,'DRAINING');
 assert.throws(()=>m.assertRuntimeAdmission(f.dataRoot),{code:'RUNTIME_MAINTENANCE'});
 const state=await f.service.status();assert.equal(state.safeToRetire,false);assert.ok(state.blockers.some(b=>b.code==='RUN_IN_FLIGHT'));
});
test('issue-stopped original queue may cold-load but cannot restore admission before its original hard gates close',async t=>{
 const f=await fixture(t);
 await f.flows.update('flow',d=>{d.parallel.enabled=false;d.parallel.lastStop='WAIT_ISSUES';d.parallel.worker.status='WAIT_ISSUES';return d;});
 await f.runs.update('active',d=>{d.web.owner=null;d.web.reserved=0;d.web.reservedAttemptIds=[];d.operations=[];d.production={blocking:true,globalBlocking:true,boundaryCheck:{status:'CONSTRAINT_CONFLICT',signature:'original-gate'}};return d;});
 const original=await f.flows.read('flow');
 const c=await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});
 assert.ok(c.issueStopProof);assert.equal(c.authorization,'original-auth');await drained(f);await proved(f);
 await assert.rejects(f.service.resume(),{code:'RUNTIME_MAINTENANCE_ISSUES'});
 assert.equal((await f.flows.read('flow')).parallel.enabled,false);
 await f.runs.update('active',d=>{d.production.blocking=false;d.production.globalBlocking=false;d.production.boundaryCheck={status:'MATCHED',signature:'proved'};return d;});
 await proved(f);assert.equal((await f.service.resume()).phase,'RESUMED');
 const after=await f.flows.read('flow');assert.equal(after.parallel.authorizedAt,original.parallel.authorizedAt);assert.deepEqual(after.parallel.modelSelection,original.parallel.modelSelection);
});
async function deliveryStoppedFixture(t){
 const f=await fixture(t);
 await f.budgets.update('budget',b=>{b.schema='PRODUCTION_BUDGET_V1';delete b.summary;return b;});
 await f.flows.update('flow',w=>{w.episodeNumbers=[1,2];w.delivery={enabled:true,version:'production-delivery-v1'};w.parallel.enabled=false;w.parallel.lastStop='INTERRUPTED';w.parallel.worker={...w.parallel.worker,status:'INTERRUPTED',error:{code:'WORKFLOW_DELIVERY_LEDGER'}};return w;});
 for(const id of ['done','active'])await f.runs.update(id,r=>{r.status='text_ready_for_review';r.web.owner=null;r.web.reserved=0;r.web.reservedAttemptIds=[];r.web.pauseRequested=false;r.operations=id==='active'?[]:r.operations;r.assembly={text:'保留本集已采用文字',validation:{errors:[]}};r.production={boundaryCheck:{status:'MATCHED'},needs:[]};return r;});
 return f;
}
test('a fully adopted original queue stopped only by export ledger accounting may cold-load without renewing authority or touching paid drafts',async t=>{
 const f=await deliveryStoppedFixture(t),before=await Promise.all(['done','active'].map(id=>f.runs.read(id)));
 const c=await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});
 assert.equal(c.deliveryStopProof.errorCode,'WORKFLOW_DELIVERY_LEDGER');assert.equal(c.deliveryStopProof.checks.length,2);assert.deepEqual(c.heldRunIds,[]);
 await f.service.retired({pid:process.pid});await f.service.expectLoad(process.pid+1);
 await f.service.loaded({pid:process.pid+1,codeIdentity:'code-v1',kernel:{pid:process.pid+1,productionFeedbackResultVersion:FEEDBACK_RESULT_VERSION,maintenanceVersion:'runtime-maintenance-v1'}});
 await proved(f);assert.equal((await f.service.resume()).phase,'RESUMED');
 const w=await f.flows.read('flow');assert.equal(w.parallel.authorizedAt,'original-auth');assert.equal(w.parallel.enabled,true);assert.deepEqual(await Promise.all(['done','active'].map(id=>f.runs.read(id))),before);
});
test('export-stopped maintenance refuses generic stops, user pause, incomplete/stale/busy/unknown or changed adopted evidence',async t=>{
 for(const change of ['other-error','other-stop','user-paused','missing-episode','unfinished','stale','busy','unknown','inflight','stale-summary','boundary','pending-repair','source-blocked','no-export']){
  const f=await deliveryStoppedFixture(t);
  if(['other-error','other-stop','user-paused','missing-episode','no-export'].includes(change))await f.flows.update('flow',w=>{if(change==='other-error')w.parallel.worker.error.code='OTHER_ERROR';if(change==='other-stop')w.parallel.lastStop='USER';if(change==='user-paused')w.paused=true;if(change==='missing-episode')w.episodeNumbers.push(3);if(change==='no-export')w.delivery.enabled=false;return w;});
  else if(['unknown','inflight','stale-summary'].includes(change))await f.budgets.update('budget',b=>{b.attempts.push({id:'unknown',status:change==='inflight'?'DISPATCHING':'UNKNOWN',totalTokens:null});if(change==='stale-summary')b.summary={inFlight:0,unknownAttempts:0};return b;});
  else await f.runs.update('active',r=>{if(change==='unfinished')r.status='drafting';if(change==='stale')r.web.sourceStale=true;if(change==='busy')r.operations=[{attemptId:'pending',status:'running'}];if(change==='boundary')r.production.boundaryCheck.status='UNRESOLVED';if(change==='pending-repair')r.production.pendingRepair={packageIds:['p']};if(change==='source-blocked')r.production.globalBlocking=true;return r;});
  await assert.rejects(f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'}),e=>e.code?.startsWith('RUNTIME_MAINTENANCE'),change);
  assert.equal((await f.flows.read('flow')).parallel.enabled,false);
 }
 for(const change of ['draft','unknown','user']){
  const f=await deliveryStoppedFixture(t);await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});await drained(f);await proved(f);
  if(change==='draft')await f.runs.update('active',r=>{r.assembly.text+=' changed';return r;});
  if(change==='unknown')await f.budgets.update('budget',b=>{b.attempts.push({id:'unknown',status:'UNKNOWN',totalTokens:null});return b;});
  if(change==='user')await f.service.userPause({workflowId:'flow'});
  await assert.rejects(f.service.resume(),e=>e.code==='RUNTIME_MAINTENANCE_ISSUES'||e.code==='RUNTIME_MAINTENANCE_CANCELLED',change);
  assert.equal((await f.flows.read('flow')).parallel.enabled,false);
 }
});
test('pause, authorization, source and limits drift each refuse automatic restore',async t=>{
 for(const change of ['user','authorization','source','limits']){
  const f=await fixture(t);await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});
  if(change==='user')await f.service.userPause({workflowId:'flow'});
  else await f.flows.update('flow',d=>{if(change==='authorization')d.parallel.authorizedAt='new-auth';if(change==='source')d.sourceVersion='new-source';if(change==='limits')d.parallel.runBudget.maxTokens=900000;return d;});
  await assert.rejects(f.service.resume(),e=>e.code==='RUNTIME_MAINTENANCE_CHANGED'||e.code==='RUNTIME_MAINTENANCE_CANCELLED');
  assert.equal((await f.flows.read('flow')).paused,true);
 }
});
test('a new process must prove actual new kernel before restoring same authorization',async t=>{
 const f=await fixture(t);await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});
 await assert.rejects(f.service.loaded({pid:process.pid,codeIdentity:'code-v1',kernel:{productionFeedbackResultVersion:null}}),{code:'RUNTIME_MAINTENANCE_KERNEL'});
 await assert.rejects(f.service.resume(),{code:'RUNTIME_MAINTENANCE_NOT_LOADED'});
 assert.equal((await f.flows.read('flow')).parallel.authorizedAt,'original-auth');
});
test('retired maintenance may bind a reviewed source revision while admission and original authority stay unchanged',async t=>{
 const f=await fixture(t),done=await f.runs.read('done');
 await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});
 assert.equal(typeof f.service.retargetCode,'function','缺少排空后源码身份受控重绑');
 const args={expectedCodeIdentity:'code-v1',codeIdentity:'code-v2',verification:{codeIdentity:'code-v2',evidenceFile:'/offline/verified.json',evidenceSha256:'a'.repeat(64)}};
 await assert.rejects(f.service.retargetCode(args),{code:'RUNTIME_MAINTENANCE_NOT_RETIRED'});
 await f.runs.update('active',d=>{d.operations=[];d.web.owner=null;d.web.reserved=0;d.web.reservedAttemptIds=[];return d;});
 await f.service.retired({pid:process.pid});
 const before=await f.flows.read('flow'),c=await f.service.retargetCode(args);
 assert.equal(c.phase,'RETIRED');assert.equal(c.codeIdentity,'code-v2');assert.equal(c.authorization,'original-auth');
 assert.deepEqual(c.codeIdentityRevisions.map(r=>({from:r.from,to:r.to,verification:r.verification})),[{from:'code-v1',to:'code-v2',verification:args.verification}]);
 assert.deepEqual(await f.flows.read('flow'),before);assert.deepEqual(await f.runs.read('done'),done);
 assert.throws(()=>m.assertRuntimeAdmission(f.dataRoot),{code:'RUNTIME_MAINTENANCE'});
 await assert.rejects(f.service.retargetCode(args),{code:'RUNTIME_MAINTENANCE_CHANGED'});
 await f.service.expectLoad(process.pid+1);
 await f.service.loaded({pid:process.pid+1,codeIdentity:'code-v2',kernel:{pid:process.pid+1,productionFeedbackResultVersion:FEEDBACK_RESULT_VERSION,maintenanceVersion:'runtime-maintenance-v1'}});
});
test('source rebind refuses user pause, authority drift, active work, unbound evidence and started loading',async t=>{
 for(const change of ['user','authorization','active','evidence','loading']){
  const f=await fixture(t);await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});
  await f.runs.update('active',d=>{d.operations=[];d.web.owner=null;d.web.reserved=0;d.web.reservedAttemptIds=[];return d;});await f.service.retired({pid:process.pid});
  const args={expectedCodeIdentity:'code-v1',codeIdentity:'code-v2',verification:{codeIdentity:'code-v2',evidenceFile:'/offline/verified.json',evidenceSha256:'a'.repeat(64)}};
  if(change==='user')await f.service.userPause({workflowId:'flow'});
  if(change==='authorization')await f.flows.update('flow',d=>{d.parallel.authorizedAt='other';return d;});
  if(change==='active')await f.runs.update('active',d=>{d.operations=[{attemptId:'later',status:'running'}];return d;});
  if(change==='evidence')args.verification.codeIdentity='unverified';
  if(change==='loading')await f.service.expectLoad(process.pid+1);
  await assert.rejects(f.service.retargetCode(args),e=>e.code?.startsWith('RUNTIME_MAINTENANCE_'));
  assert.equal((await f.service.current()).codeIdentity,'code-v1');assert.equal((await f.flows.read('flow')).parallel.enabled,false);
 }
});
test('a parked unbound module-load failure is proved locally, never acknowledged as a paid UNKNOWN',async t=>{
 const f=await fixture(t);
 await f.flows.update('flow',w=>{w.parallel.enabled=false;w.parallel.lastStop='WAIT_RECOVERY';w.status='INTERRUPTED';w.activeAction={id:'create3',kind:'STORYBOARD_CREATE',episodeNumber:3};w.receipts=[{id:'create3',status:'INTERRUPTED',error:{code:'ERR_REQUIRE_ESM_RACE_CONDITION',requestOutcome:'UNKNOWN'}}];return w;});
 const before=await f.flows.read('flow');
 const c=await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});
 const after=await f.flows.read('flow');assert.equal(after.activeAction,null);assert.equal(after.receipts[0].status,'NOT_SENT');assert.deepEqual(after.receipts[0].error,before.receipts[0].error);assert.ok(after.receipts[0].localDispatchProof);assert.equal(c.authorization,'original-auth');
});
test('a maintenance-refused unbound free CREATE is safely recoverable under the original authorization',async t=>{
 const f=await fixture(t);
 await f.flows.update('flow',w=>{w.parallel.enabled=false;w.parallel.lastStop='WAIT_RECOVERY';w.status='INTERRUPTED';w.activeAction={id:'create3',kind:'STORYBOARD_CREATE',episodeNumber:3};w.receipts=[{id:'create3',status:'INTERRUPTED',error:{code:'RUNTIME_MAINTENANCE',requestOutcome:'NOT_SENT'}}];return w;});
 const before=await f.flows.read('flow');
 await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});
 const after=await f.flows.read('flow');assert.equal(after.activeAction,null);assert.equal(after.receipts[0].status,'NOT_SENT');assert.equal(after.receipts[0].localDispatchProof.outcome,'NOT_SENT');assert.deepEqual(after.receipts[0].error,before.receipts[0].error);assert.equal(after.receipts[0].receipt,undefined);assert.equal(after.parallel.authorizedAt,'original-auth');
});
test('cold-load recovery clears a naturally refused free CREATE before restoring admission, preserving its original receipt',async t=>{
 const f=await fixture(t);
 await f.flows.update('flow',w=>{w.status='RUNNING';w.activeAction={id:'create3',kind:'STORYBOARD_CREATE',episodeNumber:3};w.receipts=[{id:'create3',status:'RUNNING'}];return w;});
 await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});
 await f.flows.update('flow',w=>{w.status='INTERRUPTED';Object.assign(w.receipts[0],{status:'INTERRUPTED',error:{code:'RUNTIME_MAINTENANCE',requestOutcome:'NOT_SENT'}});return w;});
 const before=await f.flows.read('flow');await drained(f);await f.service.recoverPreDispatchFailures();
 const after=await f.flows.read('flow');assert.equal(after.activeAction,null);assert.equal(after.status,'READY');assert.equal(after.paused,true);assert.equal(after.parallel.enabled,false);assert.deepEqual(after.receipts[0].error,before.receipts[0].error);assert.equal(after.receipts[0].status,'NOT_SENT');assert.ok(after.receipts[0].localDispatchProof);assert.equal(after.parallel.authorizedAt,'original-auth');
});
async function drained(f){
 await f.runs.update('active',d=>{d.operations=[];d.web.owner=null;d.web.reserved=0;d.web.reservedAttemptIds=[];return d;});
 await f.service.retired({pid:process.pid});await f.service.expectLoad(process.pid+1);
 await f.service.loaded({pid:process.pid+1,codeIdentity:'code-v1',kernel:{pid:process.pid+1,productionFeedbackResultVersion:FEEDBACK_RESULT_VERSION,maintenanceVersion:'runtime-maintenance-v1'}});
}
async function proved(f){
 await f.service.activateUnfinished();
 const c=await f.service.requestResumeProof();
 await f.service.recordResumeProof({pid:process.pid+1,nonce:c.resumeProofNonce,proof:{authorization:'original-auth',sourceVersion:'source',actorVerified:true}});
}
test('a new loaded kernel preserves v1 and v2 frozen pairs; maintenance cannot migrate a partial or changed v2 contract',async t=>{
 const v1='production-feedback-result-v1',v2='production-feedback-result-v2';
 for(const [rule,production,accepted] of [[v1,v1,true],[v2,v2,true],[v1,v2,false],[v2,v1,false],[v2,undefined,false],[undefined,v2,false],['future','future',false]]){
  const f=await fixture(t);await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});await drained(f);
  await f.runs.update('active',r=>{r.rulesSnapshot.productionFeedbackResultVersion=rule;r.production.feedbackResultVersion=production;return r;});
  const before=await f.runs.read('active');
  if(accepted){await f.service.activateUnfinished();const after=await f.runs.read('active');assert.equal(after.rulesSnapshot.productionFeedbackResultVersion,rule);assert.equal(after.production.feedbackResultVersion,production);assert.deepEqual(after.operations,before.operations);}
  else{await assert.rejects(f.service.activateUnfinished(),{code:'RUNTIME_MAINTENANCE_CHANGED'});assert.deepEqual(await f.runs.read('active'),before);}
 }
});
test('unknown maintenance versions fail closed; successful cold resume preserves authorization and completed bytes',async t=>{
 const f=await fixture(t),controls=createStore(path.join(f.dataRoot,'runtime-maintenance')),done=await f.runs.read('done');
 await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});
 await drained(f);await assert.rejects(f.service.resume(),{code:'RUNTIME_MAINTENANCE_UNVERIFIED'});
 await proved(f);const c=await f.service.resume();assert.equal(c.phase,'RESUMED');
 assert.equal((await f.flows.read('flow')).parallel.authorizedAt,'original-auth');assert.equal((await f.runs.read('active')).web.pauseRequested,false);assert.deepEqual(await f.runs.read('done'),done);
 await controls.update('current',d=>({...d,version:'unknown-version'}));assert.throws(()=>m.assertRuntimeAdmission(f.dataRoot),{code:'RUNTIME_MAINTENANCE'});
});
test('resume recovers its own durable intermediate state, but a new user pause always blocks it',async t=>{
 const f=await fixture(t),controls=createStore(path.join(f.dataRoot,'runtime-maintenance'));
 await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});await drained(f);await proved(f);
 await controls.update('current',d=>({...d,phase:'RESUMING'}));
 await f.flows.update('flow',d=>{d.paused=false;d.parallel.enabled=true;d.runtimeMaintenance.phase='RESUMING';return d;});
 assert.equal((await f.service.resume()).phase,'RESUMED');assert.equal((await f.service.resume()).phase,'RESUMED');
 const g=await fixture(t);await g.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});await drained(g);await proved(g);await g.service.userPause({runId:'active'});
 await assert.rejects(g.service.resume(),{code:'RUNTIME_MAINTENANCE_CANCELLED'});assert.equal((await g.flows.read('flow')).paused,true);
});
test('PREPARED crash continuation is idempotent and cannot adopt another authority',async t=>{
 const f=await fixture(t),controls=createStore(path.join(f.dataRoot,'runtime-maintenance'));
 const c=await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});
 await controls.update('current',d=>({...d,phase:'PREPARED'}));
 const continued=await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:9,targetPid:process.pid,codeIdentity:'code-v1'});
 assert.equal(continued.id,c.id);assert.equal(continued.phase,'DRAINING');assert.equal((await f.flows.read('flow')).revision,9);
 await assert.rejects(f.service.begin({workflowId:'flow',expectedAuthorization:'other',expectedRevision:9,targetPid:process.pid,codeIdentity:'code-v1'}));
});
test('activation preserves a real frozen legacy plan and native bytes, and rejects native request drift',async t=>{
 const f=await fixture(t),synthetic=tailFixture();let request;
 const engine=createEngine({directory:f.dataRoot,modelRunner:async q=>{request=q;const output={...synthetic.plan,productionFeedback:{relation:'DIRECT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]}};return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};}});
 await engine.create({id:'paidrun',source:synthetic.source,settings:synthetic.settings,production:{boundary:null,materials:[]}});
 await f.runs.update('paidrun',d=>{delete d.rulesSnapshot.productionFeedbackResultVersion;d.web={binding:{projectId:'project',episodeNumber:2,productionChain:{id:'flow'},productionBudget:{id:'budget',directory:f.budgetDirectory}},owner:null,reserved:0,reservedAttemptIds:[],pauseRequested:false,stopped:false,sourceStale:false};return d;});
 await engine.execute('paidrun',{stage:'plan',attemptId:'frozen-plan'});
 await f.runs.update('paidrun',d=>{d.web.progress='failed';d.web.error={code:'ERR_REQUIRE_ESM_RACE_CONDITION',message:'synthetic before author operation exists'};return d;});
 const folder=path.join(f.dataRoot,'attempts','frozen-plan');await mkdir(folder,{recursive:true});
 const nativeRequest=JSON.stringify(request),nativeReceipt=JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});
 await writeFile(path.join(folder,'request.json'),nativeRequest);await writeFile(path.join(folder,'receipt.json'),nativeReceipt);
 await f.flows.update('flow',d=>{d.selectedRuns[2]='paidrun';return d;});
 const before=await f.runs.read('paidrun'),old=rebuildFrozenRequest(before,before.operations[0]);
 await f.service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:8,targetPid:process.pid,codeIdentity:'code-v1'});await drained(f);
 assert.equal(freePreparationRecoveryCause(await f.runs.read('paidrun')),false);await f.service.recoverPreDispatchFailures();assert.equal(freePreparationRecoveryCause(await f.runs.read('paidrun')),true);
 await f.service.activateUnfinished();const after=await f.runs.read('paidrun');
 assert.deepEqual(after.operations,before.operations);assert.deepEqual(rebuildFrozenRequest(after,after.operations[0]),old);assert.equal(after.production.feedbackResultVersion,'production-feedback-result-v1');assert.equal(after.rulesSnapshot.productionFeedbackResultVersion,'production-feedback-result-v1');
 assert.equal(await readFile(path.join(folder,'request.json'),'utf8'),nativeRequest);assert.equal(await readFile(path.join(folder,'receipt.json'),'utf8'),nativeReceipt);
 await writeFile(path.join(folder,'request.json'),JSON.stringify({...request,prompt:'changed actual native request'}));
 await assert.rejects(f.service.activateUnfinished(),{code:'RUNTIME_MAINTENANCE_REQUEST_DRIFT'});
});
