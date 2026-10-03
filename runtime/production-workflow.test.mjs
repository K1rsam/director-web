import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
test('budget is shared, immutable and unknown usage blocks subsequent dispatch',async t=>{
 const f=await fixture(t),ledger=createProductionBudgetStore(f.budgetDirectory);await ledger.create('shared',{projectIds:['p','q'],maxCalls:3,maxTokens:100});
 let v=await f.service.create({projectId:'p',actorId:'u',episodeNumbers:[1],budgetId:'shared',costAcknowledged:true});
 assert.equal(v.budget.maxCalls,3);assert.equal(v.budget.maxTokens,100);
 await assert.rejects(()=>f.service.create({projectId:'x',actorId:'u',episodeNumbers:[1],budgetId:'shared'}),/预算/);
 const attempt=await ledger.reserve('shared',{projectId:'q',stage:'OTHER',provider:'API'});await ledger.settle('shared',attempt,{usage:{totalTokens:null}});
 v=await f.service.advance(v.workflow.id,{expectedRevision:v.workflow.revision,actorId:'u'});assert.equal(v.nextAction.kind,'WAIT_BUDGET');assert.equal(f.calls.length,0);
 assert.equal((await ledger.read('shared')).maxCalls,3);
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
