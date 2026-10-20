import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createStore} from './storyboard-v4/core/store.mjs';
import {createRuntimeMaintenance} from './production-maintenance-control.mjs';
import {captureRules,normalizePlan,normalizeSettings} from './storyboard-v4/core/core.mjs';
import {normalizeSource} from './storyboard-v4/core/source.mjs';
import {rebuildFrozenRequest} from './storyboard-v4/core/pipeline.mjs';
import {freezeFeedbackBasis} from './storyboard-v4/core/production-feedback-result.mjs';
import {tailFixture,tailDraft} from './storyboard-v4/core/author-call-group-test-fixtures.mjs';
import {digest} from './storyboard-v4/core/shared.mjs';

const v1='production-feedback-result-v1',v2='production-feedback-result-v2';
async function fixture(t,markers=[v1,v1]){
 const root=await mkdtemp(path.join(tmpdir(),'maintenance-version-review-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const workflowDirectory=path.join(root,'flows'),dataRoot=path.join(root,'runs'),budgetDirectory=path.join(root,'budgets');
 const flows=createStore(workflowDirectory),runs=createStore(dataRoot,{trackRevision:true}),budgets=createStore(budgetDirectory);
 const f=tailFixture();f.source.sourceRows=f.source.sourceRows.slice(-1);f.plan.workPackages=f.plan.workPackages.slice(-1).map(w=>({...w,dependsOn:[]}));
 f.plan.events=f.plan.events.slice(-1).map(e=>({...e,boundaryBefore:{kind:'episode_start',reason:'合成独立事件'}}));f.plan.provisionalUnits=f.plan.provisionalUnits.slice(-1);
 const source=normalizeSource(f.source),plan=normalizePlan(f.plan,source,{unitPackingPolicy:'event-first-v1'}),draft=tailDraft({source,plan});
 const material='asset:C_0123456789abcdef_V_fedcba9876543210',version=markers[0]===v2&&markers[1]===v2?v2:v1;
 const origin={id:'original-author',attemptId:'author-origin',status:'adopted',packageIds:['p3'],draft,productionFeedback:{relation:'DIRECT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[material],needs:[],conflicts:[]}};
 const basis=freezeFeedbackBasis({adopted:[{candidateId:origin.id,packageIds:['p3'],draft}],candidates:[origin],operations:[{attemptId:origin.attemptId,productionSnapshot:{materials:[{id:material,version:'original-design'}]}}]},draft,['p3'],{version});
 const rulesSnapshot=captureRules();rulesSnapshot.modelCoordinateVersion='model-coordinates-repair-v3';rulesSnapshot.modelProjectionVersion='production-context-v4';
 if(markers[0]===undefined)delete rulesSnapshot.productionFeedbackResultVersion;else rulesSnapshot.productionFeedbackResultVersion=markers[0];
 const resultVersion=markers[0]===markers[1]?markers[0]:undefined;
 const op={attemptId:'synthetic-frozen-finish',stage:'finish',packageIds:['p3'],previousDraft:{...draft,feedbackBasis:basis},issues:[],dependencyFormat:'continuity-v1',finishMode:'delta',status:'completed',receipt:{requestOutcome:'RESPONDED',usage:{totalTokens:2}},productionSnapshot:{version:'production-feedback-v1',transportVersion:rulesSnapshot.productionTransportVersion,...(resultVersion?{feedbackResultVersion:resultVersion}:{}),materials:[{id:material,version:'original-design'}],touchesOpening:true,touchesEnding:true}};
 const production={boundary:null,materials:[{id:material,version:'original-design'}],...(markers[1]===undefined?{}:{feedbackResultVersion:markers[1]})};
 const run={id:'synthetic-run',epoch:0,status:'needs_repair',source,plan,settings:normalizeSettings(f.settings),choice:f.choice,rulesSnapshot,production,operations:[op],adopted:[],candidates:[],web:{binding:{projectId:'project',episodeNumber:1,productionChain:{id:'flow'},productionBudget:{id:'budget',directory:budgetDirectory}},owner:null,reserved:0,reservedAttemptIds:[],pauseRequested:false,stopped:false,sourceStale:false}};
 const request=rebuildFrozenRequest(run,op);op.fingerprint=digest([request.promptHash,request.instructionHash,request.inputHash]);
 const native=path.join(dataRoot,'attempts',op.attemptId);await mkdir(native,{recursive:true});
 const requestBytes=JSON.stringify(request),receiptBytes=JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED',usage:{inputTokens:1,outputTokens:1,totalTokens:2}});
 await writeFile(path.join(native,'request.json'),requestBytes,{flag:'wx'});await writeFile(path.join(native,'receipt.json'),receiptBytes,{flag:'wx'});
 await runs.create(run.id,run);
 await flows.create('flow',{id:'flow',projectId:'project',sourceVersion:'source',budgetId:'budget',revision:1,paused:false,status:'READY',activeAction:null,episodeNumbers:[1],selectedRuns:{1:run.id},parallel:{enabled:true,authorizedAt:'original-auth',authorizedBy:'original-actor',lanes:[[1]],executionTier:'standard'}});
 await budgets.create('budget',{id:'budget',projectIds:['project'],maxCalls:8,maxTokens:600000,paused:false,attempts:[],summary:{inFlight:0,unknownAttempts:0}});
 const service=createRuntimeMaintenance({workflowDirectory,dataRoot,budgetDirectory});
 await service.begin({workflowId:'flow',expectedAuthorization:'original-auth',expectedRevision:1,targetPid:process.pid,codeIdentity:'review-code'});
 await service.retired({pid:process.pid});await service.expectLoad(process.pid+1);
 const load=protocol=>service.loaded({pid:process.pid+1,codeIdentity:'review-code',kernel:{pid:process.pid+1,productionFeedbackResultVersion:protocol,maintenanceVersion:'runtime-maintenance-v1'}});
 return {flows,runs,service,load,runId:run.id,request,basis,op,native,requestBytes,receiptBytes};
}

async function resume(f){
 const c=await f.service.requestResumeProof();
 await f.service.recordResumeProof({pid:process.pid+1,nonce:c.resumeProofNonce,proof:{authorization:'original-auth',sourceVersion:'source',actorVerified:true}});
 return f.service.resume();
}

for(const version of [v1,v2])test(`maintenance independent review: loaded v2 preserves a synthetic sealed ${version} finish and resumes its matching pair`,async t=>{
 const f=await fixture(t,[version,version]);await f.load(v2);
 const before=await f.runs.read(f.runId);await f.service.activateUnfinished();const after=await f.runs.read(f.runId);
 assert.equal(after.rulesSnapshot.productionFeedbackResultVersion,version);assert.equal(after.production.feedbackResultVersion,version);
 assert.deepEqual(after.operations,before.operations);assert.deepEqual(rebuildFrozenRequest(after,after.operations[0]),f.request);
 assert.deepEqual(after.operations[0].previousDraft.feedbackBasis,f.basis,'canonical seal and material consumers cannot migrate');
 assert.equal(await readFile(path.join(f.native,'request.json'),'utf8'),f.requestBytes);assert.equal(await readFile(path.join(f.native,'receipt.json'),'utf8'),f.receiptBytes);
 assert.equal((await resume(f)).phase,'RESUMED');assert.equal((await f.flows.read('flow')).parallel.authorizedAt,'original-auth');
 assert.equal((await f.service.current()).kernel.productionFeedbackResultVersion,v2,'new kernel identity stays independent of the run protocol');
});

test('maintenance independent review: unmarked and single-sided v1 activation never changes a frozen legacy finish',async t=>{
 for(const markers of [[undefined,undefined],[v1,undefined],[undefined,v1]]){
  const f=await fixture(t,markers);await f.load(v2);const before=await f.runs.read(f.runId);
  await f.service.activateUnfinished();const after=await f.runs.read(f.runId);
  assert.equal(after.rulesSnapshot.productionFeedbackResultVersion,v1);assert.equal(after.production.feedbackResultVersion,v1);
  assert.deepEqual(after.operations,before.operations);assert.deepEqual(rebuildFrozenRequest(after,after.operations[0]),f.request);
  assert.equal(after.runtimeActivations.at(-1).version,v1);
 }
});

test('maintenance independent review: unknown or half-v2 markers reject without rewriting a synthetic paid finish',async t=>{
 for(const markers of [[v2,undefined],[undefined,v2],[v1,v2],[v2,v1],[null,null],['future',undefined]]){
  const f=await fixture(t);await f.load(v2);
  await f.runs.update(f.runId,d=>{if(markers[0]===undefined)delete d.rulesSnapshot.productionFeedbackResultVersion;else d.rulesSnapshot.productionFeedbackResultVersion=markers[0];if(markers[1]===undefined)delete d.production.feedbackResultVersion;else d.production.feedbackResultVersion=markers[1];return d;});
  const before=await f.runs.read(f.runId);await assert.rejects(f.service.activateUnfinished(),{code:'RUNTIME_MAINTENANCE_CHANGED'});
  assert.deepEqual(await f.runs.read(f.runId),before);
  await assert.rejects(resume(f),{code:'RUNTIME_MAINTENANCE_UNVERIFIED'});assert.equal((await f.flows.read('flow')).paused,true);
  assert.equal(await readFile(path.join(f.native,'request.json'),'utf8'),f.requestBytes);
 }
});

test('maintenance independent review: keeping a v1 run cannot weaken the requirement to load a real v2 kernel',async t=>{
 const f=await fixture(t);await assert.rejects(f.load(v1),{code:'RUNTIME_MAINTENANCE_KERNEL'});
 assert.equal((await f.service.current()).phase,'RETIRED');assert.equal((await f.flows.read('flow')).paused,true);
 await f.load(v2);assert.equal((await f.service.current()).phase,'LOADED');
});
