import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createProductionBudgetStore,withProductionBudget} from './production-budget.mjs';
const module=await import('./production-workflow.mjs').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));

async function fixture(t,patch={}){
 assert.equal(typeof module.createProductionWorkflowService,'function','缺少可持久恢复的统一生产流程');
 const directory=await mkdtemp(path.join(os.tmpdir(),'production-workflow-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const budgetDirectory=path.join(directory,'budget'),calls=[],runs={};let budgetContext;
 const snapshot={sourceVersion:'source-1',availableEpisodes:[1,2],sourceConflicts:[],technicalIssues:[],standard:{ready:true},stage1:{ready:false,busy:false},direction:{status:'UNCONFIRMED',hasCandidate:false,pending:false},assets:{missingCandidateKeys:[],missingCriticalKeys:[],busy:false},runs,...patch};
 const adapters={inspect:async()=>structuredClone(snapshot),withBudget:async(context,action)=>{budgetContext=context;return action();},readRun:async id=>structuredClone(runs[id]),
  run:async(action,workflow,context)=>{
   calls.push(action.kind);assert.equal(budgetContext.id,workflow.budgetId);
   await withProductionBudget({...budgetContext,projectId:workflow.projectId,stage:action.kind,provider:'API'},async()=>({usage:{totalTokens:10}}));
   if(action.kind==='STAGE1')snapshot.stage1.ready=true;
   if(action.kind==='DIRECTION')snapshot.direction.hasCandidate=true;
   if(action.kind==='ASSETS')snapshot.assets.missingCandidateKeys=[];
   if(action.kind==='STORYBOARD_CREATE'){
    const id=`run-${action.episodeNumber}`;runs[id]={id,projectId:workflow.projectId,episodeNumber:action.episodeNumber,complete:true,busy:false,blocked:false,fingerprint:id+'-final'};
    await context.bind({runId:id,episodeNumber:action.episodeNumber});
   }
   return {status:'SAVED'};
  }};
 const make=()=>module.createProductionWorkflowService({directory:path.join(directory,'workflow'),budgetDirectory,adapters});
 const service=make();return {service,make,adapters,snapshot,calls,runs,budgetDirectory};
}
test('stage order, explicit confirmations and first-episode executor quality gate survive reload',async t=>{
 const f=await fixture(t);let view=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[2,1],costAcknowledged:true});const id=view.workflow.id;
 assert.deepEqual(view.workflow.episodeNumbers,[1,2]);assert.equal(view.budget.maxCalls,40);assert.equal(view.budget.maxTokens,2000000);
 const advance=async()=>{view=await f.service.advance(id,{expectedRevision:view.workflow.revision,actorId:'u'});};
 await advance();assert.deepEqual(f.calls,['STAGE1']);
 await advance();assert.deepEqual(f.calls,['STAGE1','DIRECTION']);assert.equal(view.nextAction.kind,'WAIT_DIRECTION_CONFIRM');
 await advance();assert.equal(f.calls.length,2,'方向候选不自动确认');
 f.snapshot.direction.status='CONFIRMED';view=await f.make().inspect(id);
 assert.equal(view.keyDesignGate,'NOT_SPECIFIED');assert.equal(view.nextAction.kind,'STORYBOARD_CREATE');
 await advance();assert.equal(view.nextAction.kind,'QUALITY_CHECK');assert.equal(f.runs['run-2'],undefined);
 await assert.rejects(()=>f.service.recordQualityReview(id,{expectedRevision:view.workflow.revision,actorId:'u',runId:'run-1',authorReviewed:true,assemblyReviewed:false,majorIssuesResolved:true,note:'未看整编'}),/质量/);
 view=await f.service.recordQualityReview(id,{expectedRevision:view.workflow.revision,actorId:'u',runId:'run-1',authorReviewed:true,assemblyReviewed:true,majorIssuesResolved:true,note:'已审首集主创及整编，主要问题已解决'});
 assert.equal(view.nextAction.episodeNumber,2);await advance();assert.equal(view.nextAction.kind,'COMPLETE');
 assert.deepEqual((await f.make().read(id)).selectedRuns,{'1':'run-1','2':'run-2'});
 assert.equal((await createProductionBudgetStore(f.budgetDirectory).read(view.workflow.budgetId)).summary.calls,4);
});
test('GET/inspect never dispatch; explicit requested assets gate only specified critical adoptions',async t=>{
 const f=await fixture(t,{stage1:{ready:true},direction:{status:'CONFIRMED'},assets:{missingCandidateKeys:['hero'],missingCriticalKeys:['hero'],busy:false}});
 let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],criticalAssetKeys:['hero'],costAcknowledged:true});
 await f.service.inspect(v.workflow.id);await f.service.list('p');assert.equal(f.calls.length,0);
 assert.equal(v.nextAction.kind,'ASSETS');assert.deepEqual(v.nextAction.assetKeys,['hero']);
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(v.nextAction.kind,'WAIT_DESIGN_CONFIRM');
 f.snapshot.assets.missingCriticalKeys=[];assert.equal((await f.service.inspect(v.workflow.id)).nextAction.kind,'STORYBOARD_CREATE');
});
test('automatic paid repair requires separate consent; changing policy is free and keeps queue authority',async t=>{
 const f=await fixture(t);let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
 const id=v.workflow.id;
 assert.throws(()=>module.assertPaidRepairPolicy(v.workflow),{code:'PAID_REPAIR_NOT_AUTHORIZED'});
 await assert.rejects(()=>f.service.configurePaidRepairPolicy(id,{expectedRevision:v.workflow.revision,actorId:'u',automatic:true}),{code:'WORKFLOW_REPAIR_CONSENT'});
 v=await f.service.configurePaidRepairPolicy(id,{expectedRevision:v.workflow.revision,actorId:'u',automatic:false});
 assert.equal(v.workflow.paidRepairPolicy.automatic,false);const revision=v.workflow.revision;
 v=await f.service.configurePaidRepairPolicy(id,{expectedRevision:revision,actorId:'u',automatic:true,costAcknowledged:true});
 assert.doesNotThrow(()=>module.assertPaidRepairPolicy(v.workflow));
 await assert.rejects(()=>f.service.configurePaidRepairPolicy(id,{expectedRevision:revision,actorId:'u',automatic:false}),{code:'WORKFLOW_CONFLICT'});
 assert.equal(v.budget.summary.calls,0);assert.deepEqual(f.calls,[]);assert.equal(v.workflow.parallel,undefined);
});
test('budget is shared, immutable and unknown usage blocks subsequent dispatch',async t=>{
 const f=await fixture(t),ledger=createProductionBudgetStore(f.budgetDirectory);await ledger.create('shared',{projectIds:['p','q'],maxCalls:3,maxTokens:100});
 let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],budgetId:'shared',costAcknowledged:true});
 assert.equal(v.budget.maxCalls,3);assert.equal(v.budget.maxTokens,100);
 await assert.rejects(()=>f.service.create({projectId:'x',actorId:'u',episodeNumbers:[1],budgetId:'shared'}),/预算/);
 const attempt=await ledger.reserve('shared',{projectId:'q',stage:'OTHER',provider:'API'});await ledger.settle('shared',attempt,{usage:{totalTokens:null}});
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(v.nextAction.kind,'WAIT_BUDGET');assert.equal(f.calls.length,0);
 assert.equal((await ledger.read('shared')).maxCalls,3);
});
test('one explicitly acknowledged unknown remains visible without holding every lane; later unknown stops all lanes',async t=>{
 const f=await fixture(t,{stage1:{ready:true},direction:{status:'CONFIRMED'}}),ledger=createProductionBudgetStore(f.budgetDirectory);
 let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
 const attemptId=await ledger.reserve(v.workflow.budgetId,{projectId:'p',runId:'run-1',stage:'author',provider:'CLI'});
 await ledger.settle(v.workflow.budgetId,attemptId,{outcome:'UNKNOWN'});
 v=await f.service.inspect(v.workflow.id);assert.equal(v.nextAction.kind,'WAIT_BUDGET');
 const a=(await ledger.read(v.workflow.budgetId)).attempts.find(a=>a.id===attemptId);
 await ledger.acknowledgeUnknown(v.workflow.budgetId,attemptId,{projectId:'p',runId:'run-1',actorId:'u',acceptUnknownUsage:true,expectedAttemptHash:createHash('sha256').update(JSON.stringify(a)).digest('hex'),evidenceHash:'a'.repeat(64),note:'仅此已结束尝试费用风险经明确授权。'});
 v=await f.service.inspect(v.workflow.id);assert.equal(v.nextAction.kind,'STORYBOARD_CREATE');
 assert.equal(v.budget.summary.unknownAttempts,1);assert.equal(v.budget.summary.complete,false);assert.equal(v.budget.maxCalls,40);assert.equal(v.budget.maxTokens,2000000);
 const later=await ledger.reserve(v.workflow.budgetId,{projectId:'p',runId:'run-2',stage:'finish',provider:'CLI'});
 await ledger.settle(v.workflow.budgetId,later,{outcome:'UNKNOWN'});
 v=await f.service.inspect(v.workflow.id);assert.equal(v.nextAction.kind,'WAIT_BUDGET');assert.equal(v.budget.summary.blockingUnknownAttempts,1);assert.deepEqual(f.calls,[]);
});
test('source conflicts and stale selections block only dispatch and retain saved mappings',async t=>{
 const f=await fixture(t,{stage1:{ready:true},direction:{status:'CONFIRMED'}});let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1,2],costAcknowledged:true});
 f.runs.saved={id:'saved',projectId:'p',episodeNumber:1,complete:true,fingerprint:'final'};
 v=await f.service.selectRun(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u',episodeNumber:1,runId:'saved'});assert.equal(v.workflow.selectionRevision,1);
 f.snapshot.sourceConflicts=[{message:'同号异稿不能自动合并'}];v=await f.service.inspect(v.workflow.id);assert.equal(v.nextAction.kind,'WAIT_SOURCE_CONFLICT');assert.equal(v.workflow.selectedRuns[1],'saved');
 await assert.rejects(()=>f.service.selectRun(v.workflow.id,{expectedRevision:0,actorId:'u',episodeNumber:1,runId:'saved'}),/更新/);
 assert.equal(f.calls.length,0);
});
test('dispatch failure persists interruption; recovery is read-only and never repeats unknown work',async t=>{
 const f=await fixture(t);f.adapters.run=async()=>{throw Object.assign(new Error('连接中断'),{requestOutcome:'UNKNOWN',code:'CONNECTION_LOST'});};
 let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(v.workflow.status,'INTERRUPTED');
 const restored=f.make();v=await restored.recover(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(v.nextAction.kind,'WAIT_RECOVERY');
 assert.equal(v.workflow.receipts.length,1);assert.equal(f.calls.length,0);
 f.snapshot.stage1.ready=true;v=await restored.recover(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(v.nextAction.kind,'DIRECTION');
 assert.equal(v.workflow.receipts[0].status,'RECOVERED');
});
test('a bound direction action cannot recover using a different generation candidate',async t=>{
 const f=await fixture(t,{stage1:{ready:true}});let actions=0;
 f.adapters.run=async(_action,_workflow,context)=>{
  actions++;await context.bind({directionGenerationId:'owned-generation'});
  throw Object.assign(new Error('回执中断'),{requestOutcome:'UNKNOWN'});
 };
 let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 f.snapshot.direction={status:'CONFIRMED',hasCandidate:true,pending:false,generationId:'other-generation'};
 v=await f.service.recover(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 assert.equal(v.nextAction.kind,'WAIT_RECOVERY');assert.equal(v.workflow.receipts[0].status,'INTERRUPTED');
 assert.equal(v.workflow.activeAction.directionGenerationId,'owned-generation');assert.equal(actions,1);
 f.snapshot.direction.generationId='owned-generation';
 v=await f.service.recover(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 assert.equal(v.workflow.activeAction,null);assert.equal(v.workflow.receipts[0].status,'RECOVERED');assert.equal(actions,1);
});
test('missing asset inspection is not evidence that the paid materials were saved',async t=>{
 const f=await fixture(t,{stage1:{ready:true},direction:{status:'CONFIRMED'},assets:{missingCandidateKeys:['hero']}});
 f.adapters.run=async()=>{throw Object.assign(new Error('材料回执中断'),{requestOutcome:'UNKNOWN'});};
 let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],requestedAssetKeys:['hero'],costAcknowledged:true});
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 f.snapshot.assets={busy:false};
 v=await f.service.recover(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 assert.equal(v.nextAction.kind,'WAIT_RECOVERY');assert.equal(v.workflow.receipts[0].status,'INTERRUPTED');
 f.snapshot.assets={busy:false,missingCandidateKeys:[]};
 v=await f.service.recover(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 assert.equal(v.workflow.activeAction,null);assert.equal(v.workflow.receipts[0].status,'RECOVERED');
});
test('known stage1 partial receipt remains partial and the receiver blocker prevents an empty redispatch',async t=>{
 const f=await fixture(t);let actions=0;
 f.adapters.run=async()=>{actions++;f.snapshot.stage1={ready:false,blocker:'已付费P1回包待接收修复'};return {status:'PARTIAL',error:'P1集场归属无效。',message:'保留首批回包'};};
 let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 assert.equal(v.workflow.receipts[0].status,'PARTIAL');assert.equal(v.workflow.receipts[0].result.error,'P1集场归属无效。');
 assert.equal(v.nextAction.kind,'WAIT_STAGE1_REPAIR');assert.equal(v.workflow.sourceVersion,'source-1');
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(actions,1,'接收堵点不能伪成功后反复空派单');
});
test('known direction validation failure remains partial, recovers the bound stopped action and never repeats unknown work',async t=>{
 const f=await fixture(t,{stage1:{ready:true}});let actions=0;
 f.adapters.run=async(_a,_w,context)=>{actions++;await context.bind({directionGenerationId:'direction-run'});f.snapshot.direction={status:'UNCONFIRMED',hasCandidate:false,pending:false,generationId:'direction-run',settledKnown:true,blocker:'引文需核对'};throw Object.assign(new Error('已返回但接收失败'),{requestOutcome:'RESPONDED'});};
 let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 f.snapshot.direction.generationId='different-run';
 v=await f.service.recover(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(v.nextAction.kind,'WAIT_RECOVERY');
 f.snapshot.direction.generationId='direction-run';f.snapshot.direction.settledKnown=false;
 v=await f.service.recover(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(v.nextAction.kind,'WAIT_RECOVERY');
 f.snapshot.direction.settledKnown=true;
 v=await f.service.recover(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 assert.equal(v.workflow.activeAction,null);assert.equal(v.workflow.receipts[0].status,'PARTIAL');assert.equal(v.nextAction.kind,'WAIT_DIRECTION_REPAIR');
 await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(actions,1);
 const g=await fixture(t,{stage1:{ready:true}});g.adapters.run=async()=>{g.snapshot.direction.blocker='仍需核对';return{status:'PARTIAL',message:'回包已落盘但不完整'};};
 let w=await g.service.create({projectId:'q',actorId:'u',episodeNumbers:[1],costAcknowledged:true});w=await g.service.advance(w.workflow.id,{expectedRevision:w.workflow.revision,actorId:'u'});
 assert.equal(w.workflow.receipts[0].status,'PARTIAL');assert.equal(w.nextAction.kind,'WAIT_DIRECTION_REPAIR');
});
test('concurrent/stale advances cannot double-dispatch and a paused workflow does not spend',async t=>{
 const f=await fixture(t);let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
 const revision=v.workflow.revision;const results=await Promise.allSettled([f.service.advance(v.workflow.id,{expectedRevision:revision,actorId:'u'}),f.service.advance(v.workflow.id,{expectedRevision:revision,actorId:'u'})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.deepEqual(f.calls,['STAGE1']);
 v=await f.service.inspect(v.workflow.id);v=await f.service.pause(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(v.nextAction.kind,'WAIT_PAUSED');assert.equal(f.calls.length,1);
});
test('authorized stage1 source preparation records baseline transition; external edits still stop',async t=>{
 const f=await fixture(t);let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
 f.adapters.run=async()=>{f.snapshot.stage1.ready=true;f.snapshot.sourceVersion='s2';return {status:'COMPLETE',sourceVersion:'s2'};};
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 assert.equal(v.workflow.sourceVersion,'s2');assert.equal(v.workflow.receipts[0].sourceTransition.before,'source-1');assert.equal(v.nextAction.kind,'DIRECTION');
 f.snapshot.sourceVersion='external';assert.equal((await f.service.inspect(v.workflow.id)).nextAction.kind,'WAIT_SOURCE_CHANGED');
});
test('pause reaches owned execution; recovering a live action cannot clear its receipt',async t=>{
 const f=await fixture(t);let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
 let finish,started;const ready=new Promise(resolve=>{started=resolve;});let pauseCalls=0;
 f.adapters.onPause=async()=>{pauseCalls++;};
 f.adapters.run=async()=>{started();await new Promise(resolve=>{finish=resolve;});f.snapshot.stage1.ready=true;return {status:'COMPLETE'};};
 const active=f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});await ready;
 v=await f.make().inspect(v.workflow.id);
 const recovery=await f.make().recover(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 assert.equal(recovery.nextAction.kind,'WAIT_RUNNING');assert.equal(recovery.workflow.status,'RUNNING');
 v=await f.service.pause(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(pauseCalls,1);
 finish();v=await active;assert.equal(v.workflow.receipts[0].status,'SUCCEEDED');assert.equal(v.nextAction.kind,'WAIT_PAUSED');
});
test('missing initial episode can be prepared, but successful stage1 cannot silently skip requested scope',async t=>{
 const f=await fixture(t,{availableEpisodes:[],canPrepareSource:true});let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(v.nextAction.kind,'WAIT_SCOPE');
});
test('existing manual/failed material and changed first draft do not trigger blind generation or stale quality credit',async t=>{
 const f=await fixture(t,{stage1:{ready:true},direction:{status:'CONFIRMED'},assets:{missingCandidateKeys:['hero'],missingCriticalKeys:[],blocker:'人工稿待核对'}});
 let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],requestedAssetKeys:['hero'],costAcknowledged:true});assert.equal(v.nextAction.kind,'WAIT_ASSET_REPAIR');assert.equal(f.calls.length,0);
 f.snapshot.assets={missingCandidateKeys:[],missingCriticalKeys:[]};v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 v=await f.service.recordQualityReview(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u',runId:'run-1',authorReviewed:true,assemblyReviewed:true,majorIssuesResolved:true,note:'主创与整编已复核'});assert.equal(v.nextAction.kind,'COMPLETE');
 f.runs['run-1'].fingerprint='new-final';assert.equal((await f.service.inspect(v.workflow.id)).nextAction.kind,'QUALITY_CHECK');
});
test('coordinate-bound material request is free, exact and dispatched only on the next explicit advance',async t=>{
 const f=await fixture(t,{stage1:{ready:true},direction:{status:'CONFIRMED'}});let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
 const need={stage:2,target:'door',purpose:'门的开向及遮挡关系',sourceRefs:['L4'],packageIds:['p1'],blocking:true};
 f.runs.saved={id:'saved',projectId:'p',episodeNumber:1,complete:false,blocked:true,needUpstream:true,needs:[need]};
 v=await f.service.selectRun(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u',episodeNumber:1,runId:'saved'});
 f.adapters.validateMaterialRequest=async(_workflow,needs)=>{assert.deepEqual(needs,[{runId:'saved',...need}]);};
 await assert.rejects(()=>f.service.requestMaterials(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u',needs:[{runId:'saved',target:'wrong',sourceRefs:['L4'],packageIds:['p1']}]}),/需求/);
 v=await f.service.requestMaterials(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u',needs:[{runId:'saved',target:'door',sourceRefs:['L4'],packageIds:['p1']}]});
 assert.equal(f.calls.length,0);assert.equal(v.nextAction.kind,'ASSETS');assert.deepEqual(v.nextAction.assetKeys,['door']);assert.equal(v.nextAction.materialNeeds[0].purpose,need.purpose);
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.deepEqual(f.calls,['ASSETS']);assert.equal(v.workflow.materialRequests[0].status,'CANDIDATES_SAVED');
 assert.equal(v.nextAction.kind,'NEED_UPSTREAM','候选保存不冒充反馈已解决或自动采用');
 f.runs.saved.needs[0].resolved=true;
 await assert.rejects(()=>f.service.requestMaterials(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u',needs:[{runId:'saved',target:'door',sourceRefs:['L4'],packageIds:['p1']}]}),/需求/,'已解决需求不得再登记付费补料');
});
test('recovery advances source baseline only from the same persisted stage1 task',async t=>{
 const f=await fixture(t);let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
 f.adapters.run=async(_action,_workflow,context)=>{await context.bind({taskId:'task-a'});f.snapshot.stage1={ready:true,taskId:'task-b'};f.snapshot.sourceVersion='prepared-source';throw Object.assign(new Error('工作流收据中断'),{requestOutcome:'RESPONDED'});};
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 v=await f.service.recover(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(v.nextAction.kind,'WAIT_RECOVERY','别的任务不授权更换源版本');
 f.snapshot.stage1.taskId='task-a';v=await f.service.recover(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 assert.equal(v.workflow.sourceVersion,'prepared-source');assert.equal(v.workflow.receipts[0].sourceTransition.before,'source-1');assert.equal(v.workflow.receipts[0].sourceTransition.after,'prepared-source');assert.equal(v.workflow.receipts[0].status,'RECOVERED');assert.equal(v.nextAction.kind,'DIRECTION');
});
test('an otherwise finished chain waits for continuity without restarting or granting quality credit',async t=>{
 const f=await fixture(t,{stage1:{ready:true},direction:{status:'CONFIRMED'}});
 let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true,maxCalls:0});
 f.runs.saved={id:'saved',projectId:'p',episodeNumber:1,complete:false,blocked:false,continuityPending:true,fingerprint:'provisional'};
 v=await f.service.selectRun(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u',episodeNumber:1,runId:'saved'});
 assert.equal(v.nextAction.kind,'WAIT_CONTINUITY');
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});
 assert.equal(v.nextAction.kind,'WAIT_CONTINUITY');assert.deepEqual(f.calls,[]);
 await assert.rejects(()=>f.service.recordQualityReview(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u',runId:'saved',authorReviewed:true,assemblyReviewed:true,majorIssuesResolved:true,note:'仍是预备承接'}),/质量/);
});
test('automatic local repair requires this selected chain and budget and retains all dispatch gates',async t=>{
 const f=await fixture(t,{stage1:{ready:true},direction:{status:'CONFIRMED'}});
 let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1]});
 const run=f.runs.saved={id:'saved',projectId:'p',episodeNumber:1,complete:false,blocked:true,canAutoRepair:true,
  productionChain:{id:v.workflow.id,mode:'CHAIN'},productionBudget:{id:v.workflow.budgetId,directory:f.budgetDirectory}};
 v=await f.service.selectRun(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u',episodeNumber:1,runId:'saved'});
 assert.equal(v.nextAction.kind,'WAIT_COST_CONFIRM');assert.equal(v.nextAction.proposedAction.kind,'STORYBOARD_CONTINUE');
 for(const [field,value] of [['productionBudget',{...run.productionBudget,id:'foreign'}],['productionBudget',{...run.productionBudget,directory:path.join(f.budgetDirectory,'other')}],['productionChain',{id:'foreign',mode:'CHAIN'}]]){
  const saved=run[field];run[field]=value;assert.equal((await f.service.inspect(v.workflow.id)).nextAction.kind,'WAIT_EXECUTOR_REPAIR');run[field]=saved;
 }
 f.snapshot.sourceVersion='changed';assert.equal((await f.service.inspect(v.workflow.id)).nextAction.kind,'WAIT_SOURCE_CHANGED');f.snapshot.sourceVersion='source-1';
 const execute=f.adapters.run;f.adapters.run=async(...args)=>{const result=await execute(...args);Object.assign(run,{complete:true,blocked:false,canAutoRepair:false,fingerprint:'repaired'});return result;};
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u',costAcknowledged:true});
 assert.deepEqual(f.calls,['STORYBOARD_CONTINUE']);assert.equal(v.nextAction.kind,'QUALITY_CHECK','修复完成不能借用未留存的质量复核');
 run.complete=false;run.blocked=true;run.canAutoRepair=true;
 const ledger=createProductionBudgetStore(f.budgetDirectory),attempt=await ledger.reserve(v.workflow.budgetId,{projectId:'p',stage:'pending',provider:'API'});
 await ledger.settle(v.workflow.budgetId,attempt,{usage:{totalTokens:null}});
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(v.nextAction.kind,'WAIT_BUDGET');assert.equal(f.calls.length,1);
});
test('episode zero is allowed only when the source production scope actually includes it',async t=>{
 const f=await fixture(t,{availableEpisodes:[0,1],stage1:{ready:true},direction:{status:'CONFIRMED'}});
 const v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1,0],costAcknowledged:true});
 assert.deepEqual(v.workflow.episodeNumbers,[0,1]);assert.equal(v.nextAction.episodeNumber,0);assert.deepEqual(f.calls,[]);
 f.snapshot.availableEpisodes=[1];await assert.rejects(()=>f.service.create({projectId:'p',actorId:'u',episodeNumbers:[0]}),e=>e.code==='WORKFLOW_SCOPE');
 await assert.rejects(()=>f.service.create({projectId:'p',actorId:'u',episodeNumbers:[-1]}),e=>e.code==='WORKFLOW_INPUT');
});

async function parallelFixture(t,patch={},limits={}){
 const f=await fixture(t,{availableEpisodes:Array.from({length:80},(_,i)=>i+1),stage1:{ready:true},direction:{status:'CONFIRMED'},...patch});
 const starts=[];
 f.adapters.run=async(action,workflow,context)=>{
  starts.push(action.episodeNumber);
  await withProductionBudget({id:workflow.budgetId,directory:f.budgetDirectory,projectId:'p',stage:action.kind,provider:'API'},async()=>({usage:{totalTokens:10}}));
  if(action.kind==='STORYBOARD_CREATE'){
   const id=`run-${action.episodeNumber}`;
   f.runs[id]={id,projectId:'p',episodeNumber:action.episodeNumber,complete:false,busy:true,blocked:false,fingerprint:id};
   await context.bind({runId:id,episodeNumber:action.episodeNumber});
  }else f.runs[action.runId].busy=true;
  return {status:'RUN_STARTED'};
 };
 const created=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:f.snapshot.availableEpisodes,...limits});
 return {...f,starts,id:created.workflow.id,created};
}
const command=v=>({expectedRevision:v.workflow.revision,actorId:'u'});
for(const laneCount of [4,6])test(`${laneCount}-lane start names the actual upstream blocker without dispatch or authorization`,async t=>{
 const f=await parallelFixture(t,{direction:{status:'UNCONFIRMED',hasCandidate:false,blocker:'已保存资料，但全剧方向候选待补。'}});
 const v=await f.service.configureParallel(f.id,{...command(f.created),laneCount});
 await assert.rejects(f.service.startParallel(f.id,{...command(v),costAcknowledged:true}),error=>{
  assert.equal(error.code,'WORKFLOW_PARALLEL_READY');assert.match(error.message,/全剧方向候选待补/);assert.match(error.message,/全剧方向/);return true;
 });
 assert.deepEqual(f.starts,[]);assert.deepEqual(await f.service.read(f.id),v.workflow);assert.equal((await f.service.inspect(f.id)).budget.summary.calls,0);
});
test('saving six-lane settings does not enroll manual dispatch into parallel authorization',async t=>{
 const f=await parallelFixture(t);let v=await f.service.configureParallel(f.id,{...command(f.created),laneCount:6});
 const configured=module.productionWorkflowChain(v.workflow);
 assert.equal(configured.parallelism.laneCount,6);
 assert.equal(module.productionWorkflowChain(v.workflow,{forDispatch:true}).parallelism,undefined);
 v=await f.service.startParallel(f.id,{...command(v),costAcknowledged:true});
 assert.equal(module.productionWorkflowChain(v.workflow,{forDispatch:true}).parallelism.laneCount,6);
 v=await f.service.pause(f.id,command(v));
 assert.equal(module.productionWorkflowChain(v.workflow).parallelism.laneCount,6,'paused bindings retain their authorization identity');
});
test('six lanes share the unchanged call stop line',async t=>{
 const f=await parallelFixture(t,{}, {maxCalls:5,maxTokens:1000});
 let v=await f.service.configureParallel(f.id,{...command(f.created),laneCount:6});
 await f.service.startParallel(f.id,{...command(v),costAcknowledged:true});
 await Promise.all([f.service.pumpParallel(f.id),f.service.pumpParallel(f.id)]);
 v=await f.service.inspect(f.id);assert.equal(f.starts.length,5);assert.equal(v.budget.summary.calls,5);assert.equal(v.budget.maxCalls,5);assert.equal(v.budget.maxTokens,1000);
 await f.service.pumpParallel(f.id);assert.equal(f.starts.length,5);
});
test('six lanes cover 150 episodes and freeze the count across pause and restart',async t=>{
 const f=await parallelFixture(t,{availableEpisodes:Array.from({length:150},(_,i)=>i+1)});
 let v=await f.service.configureParallel(f.id,{...command(f.created),laneCount:6});
 assert.equal(v.parallel.maxConcurrent,6);
 assert.deepEqual(v.workflow.parallel.lanes.map(a=>[a[0],a.at(-1)]),[[1,25],[26,50],[51,75],[76,100],[101,125],[126,150]]);
 assert.deepEqual(v.workflow.parallel.lanes.flat(),f.snapshot.availableEpisodes);
 const budget=structuredClone(v.budget);
 v=await f.service.startParallel(f.id,{...command(v),costAcknowledged:true,laneCount:6});
 await Promise.all([f.service.pumpParallel(f.id),f.make().pumpParallel(f.id)]);
 assert.deepEqual(f.starts,[1,26,51,76,101,126]);
 v=await f.service.inspect(f.id);const selected=structuredClone(v.workflow.selectedRuns);
 v=await f.service.pause(f.id,command(v));
 await assert.rejects(f.service.configureParallel(f.id,{...command(v),laneCount:4}),{code:'WORKFLOW_PARALLEL_FROZEN'});
 await assert.rejects(f.service.startParallel(f.id,{...command(v),costAcknowledged:true,laneCount:4}),{code:'WORKFLOW_PARALLEL_FROZEN'});
 for(const run of Object.values(f.runs))Object.assign(run,{busy:false,complete:true});
 await f.service.pumpParallel(f.id);assert.equal(f.starts.length,6);
 v=await f.make().inspect(f.id);assert.deepEqual(v.workflow.selectedRuns,selected);assert.equal(v.parallel.maxConcurrent,6);
 v=await f.service.startParallel(f.id,{...command(v),costAcknowledged:true});await f.service.pumpParallel(f.id);
 assert.deepEqual(f.starts,[1,26,51,76,101,126,2,27,52,77,102,127]);
 v=await f.service.inspect(f.id);assert.equal(v.budget.id,budget.id);assert.equal(v.budget.maxCalls,budget.maxCalls);assert.equal(v.budget.maxTokens,budget.maxTokens);
 assert.equal(v.budget.summary.calls,12);
});
test('six lanes preserve provisional seams, block unresolved seams and stop on shared unknown usage',async t=>{
 const f=await parallelFixture(t,{availableEpisodes:Array.from({length:150},(_,i)=>i+1)});
 let v=await f.service.configureParallel(f.id,{...command(f.created),laneCount:6});
 v=await f.service.startParallel(f.id,{...command(v),costAcknowledged:true});await f.service.pumpParallel(f.id);
 Object.assign(f.runs['run-26'],{busy:false,continuityPending:true,continuityStatus:'PRELIMINARY'});
 Object.assign(f.runs['run-51'],{busy:false,continuityPending:true,continuityStatus:'UNRESOLVED'});
 await f.service.pumpParallel(f.id);assert.deepEqual(f.starts,[1,26,51,76,101,126,27]);
 v=await f.service.inspect(f.id);assert.equal(v.parallel.completedEpisodes,0);assert.equal(v.parallel.lanes[2].nextAction.kind,'WAIT_CONTINUITY');
 const ledger=createProductionBudgetStore(f.budgetDirectory),a=await ledger.reserve(v.budget.id,{projectId:'p',stage:'test',provider:'API'});
 await ledger.settle(v.budget.id,a,{outcome:'UNKNOWN'});
 for(const r of Object.values(f.runs))Object.assign(r,{busy:false,complete:true,continuityPending:false});
 await f.service.pumpParallel(f.id);v=await f.service.inspect(f.id);assert.equal(v.parallel.status,'WAIT_BUDGET');assert.equal(f.starts.length,7);
});
test('legacy four-lane config stays byte-stable on read and rejects six-lane start',async t=>{
 const f=await parallelFixture(t);let v=await f.service.configureParallel(f.id,command(f.created));
 assert.equal(v.parallel.maxConcurrent,4);const before=JSON.stringify(v.workflow);
 assert.equal(JSON.stringify((await f.make().inspect(f.id)).workflow),before);
 await assert.rejects(f.service.startParallel(f.id,{...command(v),costAcknowledged:true,laneCount:6}),{code:'WORKFLOW_PARALLEL_FROZEN'});
 assert.equal(JSON.stringify((await f.make().inspect(f.id)).workflow),before);
 for(const laneCount of [0,5,7,6.5,'6',null])await assert.rejects(f.service.configureParallel(f.id,{...command(v),laneCount}),{code:'WORKFLOW_PARALLEL_CONFIG'});
});
test('four-lane model choice is validated, persisted, and never changes already selected runs',async t=>{
 const f=await parallelFixture(t);
 let v=await f.service.configureParallel(f.id,command(f.created));
 assert.deepEqual(v.parallel.modelSelection,{version:'production-model-selection-v1',model:'gpt-6.1-sol',reasoning:'medium'});
 const selection={version:'production-model-selection-v1',model:'gpt-6-astra',reasoning:'high'};
 v=await f.service.startParallel(f.id,{...command(v),costAcknowledged:true,modelSelection:selection});
 assert.deepEqual((await f.make().inspect(f.id)).parallel.modelSelection,selection);
 const before=structuredClone(v.workflow.selectedRuns);
 v=await f.service.pause(f.id,command(v));
 v=await f.service.startParallel(f.id,{...command(v),costAcknowledged:true,modelSelection:{...selection,model:'gpt-6-sol'}});
 assert.deepEqual(v.workflow.selectedRuns,before);assert.deepEqual(f.starts,[]);
 v=await f.service.pause(f.id,command(v));
 for(const invalid of [null,{...selection,model:'invented'},{...selection,reasoning:'extreme'},{...selection,version:'old'},{...selection,extra:true}]){
  await assert.rejects(f.service.startParallel(f.id,{...command(v),costAcknowledged:true,modelSelection:invalid}),{code:'WORKFLOW_MODEL_SELECTION'});
 }
 assert.deepEqual(f.starts,[]);
});
test('four-lane pause drains in-flight results without invoking single-run cancellation',async t=>{
 const f=await parallelFixture(t);let cancellations=0;f.adapters.onPause=async()=>{cancellations++;};
 await enableParallel(f);await f.service.pumpParallel(f.id);
 let v=await f.service.inspect(f.id);const selected={...v.workflow.selectedRuns};
 v=await f.service.pause(f.id,command(v));
 assert.equal(cancellations,0);assert.equal(v.parallel.status,'PAUSING');
 for(const run of Object.values(f.runs))Object.assign(run,{busy:false,complete:true});
 await f.service.pumpParallel(f.id);v=await f.service.inspect(f.id);
 assert.equal(v.parallel.status,'PAUSED');assert.deepEqual(v.workflow.selectedRuns,selected);assert.equal(f.starts.length,4);
});
test('pause is idempotent within the same authorization despite newer worker revisions',async t=>{
 const f=await parallelFixture(t);let v=await enableParallel(f);
 const expectedRevision=v.workflow.revision,expectedAuthorization=v.workflow.parallel.authorizedAt;
 await f.service.recordParallelWorker(f.id,{status:'RUNNING'});
 v=await f.service.pause(f.id,{expectedRevision,expectedAuthorization,actorId:'u'});
 assert.equal(v.workflow.paused,true);v=await f.service.pause(f.id,{expectedRevision,expectedAuthorization,actorId:'u'});
 assert.equal(v.parallel.enabled,false);
 await assert.rejects(f.service.pause(f.id,{expectedRevision,expectedAuthorization:'stale',actorId:'u'}),{code:'WORKFLOW_PARALLEL_OWNER'});
});
test('resume recovers a queue-paused NOT_SENT outer action on the same bound run without recreating it',async t=>{
 const f=await parallelFixture(t);let held=false;
 f.adapters.run=async(action,workflow,context)=>{
  if(!held){held=true;f.runs.original={id:'original',projectId:'p',episodeNumber:1,busy:false,complete:false,blocked:false,productionChain:{id:f.id,mode:'CHAIN'},productionBudget:context.budget};await context.bind({runId:'original',episodeNumber:1});
   const v=await f.service.inspect(f.id);await f.service.pause(f.id,command(v));throw Object.assign(new Error('paused before dispatch'),{code:'WORKFLOW_PAUSED',requestOutcome:'NOT_SENT'});
  }
  assert.equal(action.kind,'STORYBOARD_CONTINUE');assert.equal(action.runId,'original');f.runs.original.busy=true;return {status:'RUN_STARTED'};
 };
 await enableParallel(f);await f.service.pumpParallel(f.id);let v=await f.service.inspect(f.id);
 assert.ok(v.workflow.activeAction);assert.equal(v.workflow.paused,true);
 v=await f.service.startParallel(f.id,{...command(v),costAcknowledged:true,fastAcknowledged:true});
 assert.equal(v.workflow.activeAction,null);assert.equal(v.workflow.selectedRuns[1],'original');
 assert.deepEqual(f.starts,[],'resume itself only recovers the NOT_SENT outer receipt; no new provider call');
});
test('new eighty-episode workflows freeze calibrated limits without altering a reused ledger',async t=>{
 const f=await parallelFixture(t);let v=f.created;
 assert.equal(v.budget.maxCalls,480);assert.equal(v.budget.maxTokens,36000000);
 assert.deepEqual(v.workflow.budgetPolicy.episode,{maxCalls:8,maxTokens:600000});
 v=await f.service.configureParallel(f.id,command(v));
 assert.deepEqual(v.workflow.parallel.runBudget,{maxCalls:8,maxTokens:600000});
 const ledger=createProductionBudgetStore(f.budgetDirectory);await ledger.create('old',{projectIds:['p'],maxCalls:40,maxTokens:2000000});
 const old=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:f.snapshot.availableEpisodes,budgetId:'old'});
 assert.equal(old.budget.maxCalls,40);assert.equal(old.budget.maxTokens,2000000);assert.deepEqual(f.starts,[]);
 await assert.rejects(()=>f.service.create({projectId:'p',actorId:'u',episodeNumbers:f.snapshot.availableEpisodes,maxTokens:36000001}),e=>e.code==='WORKFLOW_BUDGET_LIMIT');
});
test('explicit four-lane run budget persists across reload; incomplete or invalid policy cannot change it',async t=>{
 const f=await parallelFixture(t),runBudget={maxCalls:32,maxTokens:2000000};
 let v=await f.service.configureParallel(f.id,{...command(f.created),executionTier:'standard',runBudget});
 assert.deepEqual(v.workflow.parallel.runBudget,runBudget,'全剧测试应沿用明示的单集保护，不偷偷回到30万');
 v=await f.make().inspect(f.id);assert.deepEqual(v.workflow.parallel.runBudget,runBudget);assert.deepEqual(f.starts,[]);
 for(const invalid of [{maxCalls:32},{maxCalls:129,maxTokens:2000000},{maxCalls:32,maxTokens:Infinity},{...runBudget,extra:true}])await assert.rejects(f.service.configureParallel(f.id,{...command(v),runBudget:invalid}),e=>e.code==='WORKFLOW_PARALLEL_BUDGET');
 v=await f.service.configureParallel(f.id,{...command(v),executionTier:'standard'});assert.deepEqual(v.workflow.parallel.runBudget,runBudget,'普通配置保存不能丢掉本轮授权');
 assert.deepEqual(f.starts,[]);assert.equal(v.budget.summary.calls,0);
});
test('budget-stop restart fills original lanes without redoing saved first drafts or selecting new versions for partial work',async t=>{
 const f=await parallelFixture(t,{}, {maxCalls:40,maxTokens:2000000});await enableParallel(f);await f.service.pumpParallel(f.id);
 Object.assign(f.runs['run-1'],{busy:false,complete:true});Object.assign(f.runs['run-61'],{busy:false,complete:true});
 Object.assign(f.runs['run-41'],{busy:false,continuityPending:true,continuityStatus:'PRELIMINARY'});
 const v0=await f.service.inspect(f.id),binding={productionChain:{id:f.id,mode:'CHAIN'},productionBudget:{id:v0.budget.id,directory:f.budgetDirectory}};
 Object.assign(f.runs['run-21'],{busy:false,blocked:true,canAutoRepair:true,...binding});
 let v=await f.service.pause(f.id,command(v0));const original={...v.workflow.selectedRuns};
 const ledger=createProductionBudgetStore(f.budgetDirectory);assert.equal(typeof ledger.reviseLimits,'function');
 await ledger.reviseLimits(v.budget.id,{projectId:'p',actorId:'u',costAcknowledged:true,expectedLimits:{maxCalls:40,maxTokens:2000000},maxCalls:800,maxTokens:60000000,note:'本轮完整测试'});
 v=await f.service.startParallel(f.id,{...command(v),costAcknowledged:true,fastAcknowledged:true});
 await Promise.all([f.service.pumpParallel(f.id),f.make().pumpParallel(f.id)]);
 assert.deepEqual(f.starts,[1,21,41,61,2,21,42,62]);
 v=await f.service.inspect(f.id);for(const [ep,id] of Object.entries(original))assert.equal(v.workflow.selectedRuns[ep],id);
 await f.service.pumpParallel(f.id);assert.equal(f.starts.length,8,'没有新回执时不得重复派单');
 assert.deepEqual(v.workflow.qualityReviews,[],'续作不能伪造审稿认可');
});
async function enableParallel(f){
 assert.equal(typeof f.service.configureParallel,'function','四路配置尚未接入');
 let v=await f.service.configureParallel(f.id,{...command(await f.service.inspect(f.id)),executionTier:'fast'});
 v=await f.service.startParallel(f.id,{...command(v),costAcknowledged:true,fastAcknowledged:true});
 return v;
}
test('four lanes partition 80 episodes without creating four unrelated chains',()=>{
 const lanes=module.partitionProductionLanes?.(Array.from({length:80},(_,i)=>i+1))??[];
 assert.deepEqual(lanes.map(l=>[l[0],l.at(-1)]),[[1,20],[21,40],[41,60],[61,80]]);
 assert.deepEqual(lanes.flat(),Array.from({length:80},(_,i)=>i+1));
});
test('free configuration and inspection never enable or dispatch parallel production',async t=>{
 const f=await parallelFixture(t);
 assert.equal(typeof f.service.configureParallel,'function','缺少只保存四路配置的免费动作');
 let v=await f.service.configureParallel(f.id,{...command(f.created),executionTier:'fast'});
 assert.equal(v.workflow.parallel.enabled,false);assert.equal(v.workflow.parallel.executionTier,'fast');
 await f.service.inspect(f.id);await f.make().inspect(f.id);await f.service.pumpParallel(f.id);
 assert.deepEqual(f.starts,[]);assert.equal((await createProductionBudgetStore(f.budgetDirectory).read(v.workflow.budgetId)).summary.calls,0);
 await assert.rejects(()=>f.service.startParallel(f.id,command(v)),e=>e.code==='WORKFLOW_PARALLEL_CONSENT');
});
test('four head episodes run together; each lane advances only after its own saved text',async t=>{
 const f=await parallelFixture(t);await enableParallel(f);
 await f.service.pumpParallel(f.id);
 assert.deepEqual(f.starts,[1,21,41,61]);
 let v=await f.service.inspect(f.id);assert.deepEqual(v.parallel.lanes.map(l=>l.episodeNumber),[1,21,41,61]);
 assert.equal(v.parallel.activeEpisodes,4);assert.equal(new Set(Object.values(v.workflow.selectedRuns)).size,4);
 await f.make().pumpParallel(f.id);assert.deepEqual(f.starts,[1,21,41,61],'重复轮询不派发同一集');
 Object.assign(f.runs['run-21'],{busy:false,continuityPending:true,continuityStatus:'PRELIMINARY'});
 await f.service.pumpParallel(f.id);assert.deepEqual(f.starts,[1,21,41,61,22]);
 v=await f.service.inspect(f.id);assert.equal(v.parallel.provisionalEpisodes,1);assert.equal(v.parallel.activeEpisodes,4);
 assert.equal(v.parallel.lanes[1].episodeNumber,22);assert.equal(v.parallel.lanes[0].episodeNumber,1);
});
test('saved first episode is reused without fabricating a quality review',async t=>{
 const f=await parallelFixture(t);
 f.runs.saved={id:'saved',projectId:'p',episodeNumber:1,complete:true,busy:false,blocked:false,fingerprint:'same-final'};
 await f.service.selectRun(f.id,{...command(f.created),episodeNumber:1,runId:'saved'});
 await enableParallel(f);await f.service.pumpParallel(f.id);
 assert.deepEqual(f.starts,[2,21,41,61]);
 const v=await f.service.inspect(f.id);assert.equal(v.workflow.selectedRuns[1],'saved');assert.deepEqual(v.workflow.qualityReviews,[]);
 assert.equal(v.parallel.completedEpisodes,1);assert.equal(v.parallel.qualityReviewPending,true);
});
test('local blockers hold only their lane; pause and explicit restart retain run IDs',async t=>{
 const f=await parallelFixture(t);await enableParallel(f);await f.service.pumpParallel(f.id);
 Object.assign(f.runs['run-1'],{busy:false,blocked:true,message:'本集原文冲突'});
 Object.assign(f.runs['run-41'],{busy:false,complete:true});
 await f.service.pumpParallel(f.id);assert.deepEqual(f.starts,[1,21,41,61,42]);
 let v=await f.service.inspect(f.id);assert.equal(v.parallel.lanes[0].nextAction.kind,'WAIT_EXECUTOR_REPAIR');
 v=await f.service.pause(f.id,command(v));assert.equal(v.workflow.parallel.enabled,false);
 Object.assign(f.runs['run-61'],{busy:false,complete:true});await f.service.pumpParallel(f.id);assert.equal(f.starts.length,5);
 v=await f.service.startParallel(f.id,{...command(v),costAcknowledged:true,fastAcknowledged:true});
 await f.service.pumpParallel(f.id);assert.deepEqual(f.starts,[1,21,41,61,42,62]);
 assert.equal(v.workflow.selectedRuns[1],'run-1');
});
test('parallel lanes share one immutable stop line and unknown usage stops all new dispatch',async t=>{
 const f=await parallelFixture(t);await enableParallel(f);await f.service.pumpParallel(f.id);
 const v=await f.service.inspect(f.id),ledger=createProductionBudgetStore(f.budgetDirectory);
 assert.equal(v.budget.summary.calls,4);assert.equal(v.budget.maxCalls,480);assert.equal(v.budget.maxTokens,36000000);
 const attempt=await ledger.reserve(v.workflow.budgetId,{projectId:'p',stage:'uncertain',provider:'API'});
 await ledger.settle(v.workflow.budgetId,attempt,{usage:{totalTokens:null}});
 for(const run of Object.values(f.runs))Object.assign(run,{busy:false,complete:true});
 await f.service.pumpParallel(f.id);assert.equal(f.starts.length,4);
 assert.equal((await f.service.inspect(f.id)).parallel.status,'WAIT_BUDGET');
});
test('concurrent pumps cannot duplicate a lane dispatch and source changes stop the queue',async t=>{
 const f=await parallelFixture(t);await enableParallel(f);
 await Promise.all([f.service.pumpParallel(f.id),f.make().pumpParallel(f.id)]);
 assert.deepEqual([...f.starts].sort((a,b)=>a-b),[1,21,41,61]);
 for(const run of Object.values(f.runs))Object.assign(run,{busy:false,complete:true});
 f.snapshot.sourceVersion='changed';await f.service.pumpParallel(f.id);assert.equal(f.starts.length,4);
 assert.equal((await f.service.inspect(f.id)).parallel.status,'WAIT_SOURCE_CHANGED');
});
test('new lanes change only their selected episode revision, not an unrelated predecessor identity',async t=>{
 const f=await parallelFixture(t);await enableParallel(f);await f.service.pumpParallel(f.id);
 const first=await f.service.getProductionChain(f.id,'p');
 assert.equal(first.selectionProtocol,'per-episode-selection-v1');
 assert.equal(first.selectedRunRevisions?.[1],1);
 Object.assign(f.runs['run-21'],{busy:false,complete:true});await f.service.pumpParallel(f.id);
 const next=await f.service.getProductionChain(f.id,'p');
 assert.ok(next.selectionRevision>first.selectionRevision);
 assert.equal(next.selectedRunRevisions[1],first.selectedRunRevisions[1]);
 assert.equal(next.selectedRunRevisions[21],first.selectedRunRevisions[21]);
 assert.equal(next.selectedRuns[1],first.selectedRuns[1]);
});
test('a registered local material need does not turn the other lanes into global asset dispatch',async t=>{
 const f=await parallelFixture(t);await enableParallel(f);await f.service.pumpParallel(f.id);
 const need={stage:2,target:'door',purpose:'本集入口开向',sourceRefs:['L1'],packageIds:['p1'],blocking:true};
 Object.assign(f.runs['run-1'],{busy:false,blocked:true,needUpstream:true,needs:[need]});
 f.adapters.validateMaterialRequest=async()=>{};
 let v=await f.service.inspect(f.id);
 await f.service.requestMaterials(f.id,{...command(v),needs:[{runId:'run-1',target:'door',sourceRefs:['L1'],packageIds:['p1']}]});
 Object.assign(f.runs['run-41'],{busy:false,complete:true});
 await f.service.pumpParallel(f.id);
 assert.deepEqual(f.starts,[1,21,41,61,42]);
 v=await f.service.inspect(f.id);assert.equal(v.parallel.lanes[0].nextAction.kind,'NEED_UPSTREAM');
});
test('a shared one-call limit does not become four independent lane budgets',async t=>{
 const f=await parallelFixture(t);
 f.created=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:f.snapshot.availableEpisodes,maxCalls:1});f.id=f.created.workflow.id;
 await enableParallel(f);await f.service.pumpParallel(f.id);
 assert.deepEqual(f.starts,[1]);const v=await f.service.inspect(f.id);assert.equal(v.budget.summary.calls,1);assert.equal(v.parallel.status,'WAIT_BUDGET');
});
test('unresolved continuity holds its lane instead of being treated as a preliminary usable draft',async t=>{
 const f=await parallelFixture(t);await enableParallel(f);await f.service.pumpParallel(f.id);
 Object.assign(f.runs['run-21'],{busy:false,continuityPending:true,continuityStatus:'UNRESOLVED'});
 Object.assign(f.runs['run-41'],{busy:false,complete:true});await f.service.pumpParallel(f.id);
 assert.deepEqual(f.starts,[1,21,41,61,42]);assert.equal((await f.service.inspect(f.id)).parallel.lanes[1].nextAction.kind,'WAIT_CONTINUITY');
});
test('an unfinished foreign-budget task is held without repeatedly attempting continuation',async t=>{
 const f=await parallelFixture(t);f.runs.old={id:'old',projectId:'p',episodeNumber:1,busy:false,complete:false,blocked:false,productionChain:{id:f.id,mode:'CHAIN'},productionBudget:{id:'foreign',directory:f.budgetDirectory}};
 await f.service.selectRun(f.id,{...command(f.created),episodeNumber:1,runId:'old'});await enableParallel(f);
 for(let i=0;i<3;i++)await f.service.pumpParallel(f.id);
 const v=await f.service.inspect(f.id);assert.deepEqual(f.starts,[21,41,61]);assert.equal(v.parallel.lanes[0].nextAction.kind,'WAIT_RUN_BINDING');
 assert.equal(v.workflow.receipts.length,3);
});
test('a NOT_SENT failure is not automatic retry permission in a background pump',async t=>{
 const f=await parallelFixture(t);await enableParallel(f);let tries=0;
 f.adapters.run=async()=>{tries++;throw Object.assign(new Error('synthetic dispatch failure'),{code:'FAILED_ADMISSION',requestOutcome:'NOT_SENT'});};
 for(let i=0;i<3;i++)await f.service.pumpParallel(f.id);
 const v=await f.service.inspect(f.id);assert.equal(tries,1);assert.equal(v.workflow.status,'INTERRUPTED');assert.equal(v.workflow.receipts.length,1);
});
test('a saved bound run releases an interrupted outer action without replaying it or freezing the other lanes',async t=>{
 const f=await parallelFixture(t);await enableParallel(f);const execute=f.adapters.run;
 f.adapters.run=async(...args)=>{const result=await execute(...args);if(args[0].episodeNumber===1){Object.assign(f.runs['run-1'],{productionChain:{id:f.id,mode:'CHAIN'},productionBudget:{id:f.created.budget.id,directory:f.budgetDirectory}});throw Object.assign(new Error('outer receipt interrupted after bind'),{code:'READ_FAILED',requestOutcome:'NOT_SENT'});}return result;};
 await f.service.pumpParallel(f.id);await f.service.pumpParallel(f.id);
 const v=await f.service.inspect(f.id);
 assert.deepEqual(f.starts,[1,21,41,61],'the already running first episode must never be restarted');
 assert.equal(v.workflow.activeAction,null);assert.equal(v.workflow.receipts[0].status,'RECOVERED');
 assert.equal(v.workflow.receipts[0].recoveryMethod,'SAVED_RUN_ONLY');
 assert.equal(v.workflow.selectedRuns[1],'run-1');assert.equal(v.parallel.activeEpisodes,4);
});
test('startup failure cleanup cannot stop a worker acquired under the same authorization',async t=>{
 const f=await parallelFixture(t);const v=await enableParallel(f),authorization=v.workflow.parallel.authorizedAt;
 const prior=v.workflow.parallel.worker??null;
 await f.service.recordParallelWorker(f.id,{token:'other-live-worker',status:'RUNNING'},{expectedAuthorization:authorization});
 await assert.rejects(()=>f.service.recordParallelWorker(f.id,{status:'INTERRUPTED'},
  {stop:true,expectedAuthorization:authorization,expectedWorker:prior}),e=>e.code==='WORKFLOW_PARALLEL_OWNER');
 const d=await f.service.read(f.id);assert.equal(d.parallel.enabled,true);assert.equal(d.parallel.worker.token,'other-live-worker');
});
test('an admitted old standard task remains registered even if pause lands before its bind',async t=>{
 const f=await parallelFixture(t);f.runs.old={id:'old',projectId:'p',episodeNumber:1,busy:false,complete:false,blocked:false,productionChain:{id:f.id,mode:'CHAIN'},productionBudget:{id:f.created.workflow.budgetId,directory:f.budgetDirectory}};
 await f.service.selectRun(f.id,{...command(f.created),episodeNumber:1,runId:'old'});await enableParallel(f);
 f.adapters.run=async(action,_workflow,context)=>{
  assert.equal(action.kind,'STORYBOARD_CONTINUE');const v=await f.service.inspect(f.id);await f.service.pause(f.id,command(v));
  await context.bind({runId:'old',episodeNumber:1});return {status:'RUN_STARTED'};
 };
 await f.service.pumpParallel(f.id);const v=await f.service.inspect(f.id);
 assert.equal(v.parallel.enabled,false);assert.ok(v.workflow.parallel.participatingRuns.includes('old'),'暂停不能抹掉已委托继续任务的调用闸');
});
test('standard four-lane production does not need or imply Fast authorization',async t=>{
 const f=await parallelFixture(t);
 let v=await f.service.configureParallel(f.id,{...command(f.created),executionTier:'standard'});
 assert.equal(v.parallel.executionTier,'standard');assert.equal(v.parallel.enabled,false);
 await assert.rejects(()=>f.service.startParallel(f.id,command(v)),e=>e.code==='WORKFLOW_PARALLEL_CONSENT');
 v=await f.service.startParallel(f.id,{...command(v),costAcknowledged:true});
 assert.equal(v.parallel.executionTier,'standard');await f.service.pumpParallel(f.id);assert.deepEqual(f.starts,[1,21,41,61]);
});
