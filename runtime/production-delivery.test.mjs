import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {digest} from './storyboard-v4/core/shared.mjs';
import {sealUnsentProof} from './storyboard-v4/core/pre-dispatch-evidence.mjs';
import {buildProductionDelivery,writeProductionDelivery} from './production-delivery.mjs';

function fixture(){
 const workflow={id:'generic-workflow',projectId:'different-project',sourceVersion:'source',mode:'CHAIN',episodeNumbers:[7,8],selectedRuns:{7:'run7',8:'run8'},selectionRevision:2,qualityReviews:[{runId:'run7',fingerprint:'fp7',episodeNumber:7}]};
 const runs=[7,8].map(n=>({id:`run${n}`,status:'text_ready_for_review',source:{key:`source${n}`,dialogue:[{quote:'原话。'}]},assembly:{text:`## 第${n}集\n0.75秒：原话。\n`,validation:{errors:[]}},adopted:[{candidateId:`final${n}`,stage:'finish'}],production:{boundaryCheck:{status:n===7?'NO_PREDECESSOR':'MATCHED'},needs:[]},web:{binding:{projectId:workflow.projectId,episodeNumber:n,productionChain:{id:workflow.id}}},operations:[{attemptId:`a${n}`,stage:'finish',status:'completed',createdAt:'2026-01-01T00:00:00.000Z',fingerprint:digest(['p','i',`body${n}`])}]}));
 const views=Object.fromEntries(runs.map((r,i)=>[r.id,{complete:true,freshness:'CHECKED',sourceCheckPending:false,fingerprint:`fp${i+7}`}]))
 const ledger={id:'ledger',attempts:[7,8].map(n=>({id:`a${n}`,runId:`run${n}`,totalTokens:20,status:'RESPONDED'})),summary:{calls:2,knownTokens:40,inFlight:0,blockingUnknownAttempts:0}};
 const attempts=new Map([7,8].map(n=>[`a${n}`,{request:{promptHash:'p',instructionHash:'i',inputHash:`body${n}`},receipt:{state:'FINAL',requestOutcome:'RESPONDED',usage:{inputTokens:15,cachedInputTokens:4,outputTokens:5,totalTokens:20},durationMs:23,execution:{startedAt:'2026-01-01T00:00:00.000Z',terminalAt:'2026-01-01T00:00:01.000Z'}}}]));
 return {workflow,runs,views,ledger,attempts,readAttempt:async id=>attempts.get(id)??{}};
}
test('generic exact-text delivery audits native FINAL once and is wx/idempotent',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'generic-delivery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const f=fixture(),bundle=await buildProductionDelivery(f),before=structuredClone(f.runs);
 assert.equal(bundle.usage.summary.knownTokens,40);assert.equal(bundle.usage.summary.knownCachedInputTokens,8);assert.equal(bundle.usage.summary.knownNativeDurationMs,46);
 const first=await writeProductionDelivery({root,bundle,revalidate:async()=>bundle.identity}),second=await writeProductionDelivery({root,bundle,revalidate:async()=>bundle.identity});
 assert.equal(first.directory,second.directory);assert.equal(second.reused,true);
 assert.equal(await readFile(path.join(first.directory,'episodes/episode-0007.md'),'utf8'),f.runs[0].assembly.text);
 assert.deepEqual(f.runs,before);assert.match(await readFile(path.join(first.directory,'complete.md'),'utf8'),/0.75秒：原话/);
 await writeFile(path.join(first.directory,'complete.md'),'tampered');await assert.rejects(writeProductionDelivery({root,bundle,revalidate:async()=>bundle.identity}),{code:'WORKFLOW_DELIVERY_CONFLICT'});
});
test('NOT_SENT has zero dispatch, not a fabricated native zero receipt; unknown remains null',async()=>{
 const f=fixture();f.runs[0].operations.unshift({attemptId:'not-sent',stage:'author',status:'failed',error:{requestOutcome:'NOT_SENT'}});
 f.attempts.get('a8').receipt={state:'SUBMITTING',requestOutcome:'UNKNOWN',usage:null};f.ledger.attempts[1].totalTokens=null;
 const b=await buildProductionDelivery(f),zero=b.usage.attempts.find(a=>a.attemptId==='not-sent');
 assert.equal(zero.dispatchCount,0);assert.equal(zero.nativeUsage,null);assert.equal(zero.nativeDurationMs,null);
 assert.equal(b.usage.summary.localRecords,3);assert.equal(b.usage.summary.nativeRequests,2);assert.equal(b.usage.summary.totalTokens,null);assert.equal(b.usage.summary.nativeDurationMs,null);assert.equal(b.usage.summary.knownTokens,20);
});
test('new editor notes are delivered separately, bound to their draft; old bundles stay unchanged',async()=>{
 const f=fixture(),old=await buildProductionDelivery(f);
 const run=f.runs[0];run.rulesSnapshot={generationTextVersion:'voice-delivery-v1'};
 run.source.sourceRows=[{id:'r1',text:'后期人名条：甲'}];
 run.assembly.draft={units:[{id:'u1',shots:[{id:'s1',postproductionNotes:[{text:'人名条：甲，左下角淡入，停2秒后淡出。',sourceRefs:['r1']}]}]}]};
 const next=await buildProductionDelivery(f),name='episodes/episode-0007/postproduction-notes.md';
 assert.match(next.files[name]||'',/人名条：甲/);assert.match(next.files[name],/u1.*s1/s);
 assert.ok(next.manifest.files[name]);assert.doesNotMatch(next.files['complete.md'],/人名条/);
 assert.equal(old.files[name],undefined);assert.equal(next.files['episodes/episode-0007.md'],old.files['episodes/episode-0007.md']);
});
function provenUnsentFixture(){
 const f=fixture();f.workflow.budgetId=f.ledger.id;
 const op={attemptId:'proven-unsent',stage:'finish',status:'completed',fingerprint:'original-failure',createdAt:'2026-01-01T00:00:00.000Z',localSettledAt:'2026-01-01T00:00:01.000Z',error:{code:'ERR_REQUIRE_ESM_RACE_CONDITION',requestOutcome:'UNKNOWN'},receipt:{requestOutcome:'RESPONDED',usage:null}};
 op.localDispatchProof=sealUnsentProof(op,{scope:'BOUND_MODEL_ADAPTER',workflowId:f.workflow.id,budgetId:f.ledger.id,nativeDirectoryAbsent:true,ledgerAttemptAbsent:true,candidateAbsent:true});
 f.runs[0].operations.unshift(op);return f;
}
test('delivery reconciles a scoped verified local NOT_SENT without changing the original UNKNOWN or creating native usage',async()=>{
 const f=provenUnsentFixture(),before=structuredClone(f.runs),b=await buildProductionDelivery(f),row=b.usage.attempts.find(a=>a.attemptId==='proven-unsent');
 assert.equal(row.dispatchCount,0);assert.equal(row.nativeState,null);assert.equal(row.requestOutcome,null);assert.equal(row.nativeUsage,null);assert.equal(row.nativeDurationMs,null);assert.equal(row.ledgerPresent,false);
 assert.equal(row.localVerifiedOutcome,'NOT_SENT');assert.equal(row.localDispatchProof.identity,f.runs[0].operations[0].localDispatchProof.identity);
 assert.equal(b.usage.summary.localRecords,3);assert.equal(b.usage.summary.zeroDispatch,1);assert.equal(b.usage.summary.nativeRequests,2);assert.equal(b.usage.summary.totalTokens,40);assert.equal(b.usage.summary.nativeDurationMs,46);assert.deepEqual(f.runs,before);
});
test('a local zero-dispatch proof cannot override native, ledger, candidate, scope, settled-state or basis conflicts',async()=>{
 const reseal=(f,patch)=>{const op=f.runs[0].operations[0];op.localDispatchProof=sealUnsentProof(op,{...op.localDispatchProof.evidence,...patch});};
 const cases={
  'bad seal':f=>f.runs[0].operations[0].localDispatchProof.identity='tampered',
  'changed fingerprint':f=>f.runs[0].operations[0].fingerprint='changed',
  'unproven UNKNOWN':f=>delete f.runs[0].operations[0].localDispatchProof,
  'positive local usage':f=>f.runs[0].operations[0].receipt.usage={totalTokens:1},
  'native request':f=>f.attempts.set('proven-unsent',{request:{promptHash:'p',instructionHash:'i',inputHash:'body'}}),
  'native receipt':f=>f.attempts.set('proven-unsent',{receipt:structuredClone(f.attempts.get('a7').receipt)}),
  'native raw without receipt':f=>f.attempts.set('proven-unsent',{hashes:{raw:'existing-native-body'}}),
  'native event without receipt':f=>f.attempts.set('proven-unsent',{hashes:{eventFinal:'existing-native-event'}}),
  'ledger record':f=>f.ledger.attempts.push({id:'proven-unsent',runId:'run7',totalTokens:20}),
  'ledger reconciliation only':f=>f.ledger.reconciliations=[{attemptId:'proven-unsent',totalTokens:20}],
  'candidate exists':f=>f.runs[0].candidates=[{attemptId:'proven-unsent'}],
  'different workflow':f=>reseal(f,{workflowId:'other-workflow'}),
  'different budget':f=>reseal(f,{budgetId:'other-budget'}),
  'different current ledger':f=>f.ledger.id='other-ledger',
  'unbound CREATE scope':f=>reseal(f,{scope:'UNBOUND_STORYBOARD_CREATE'}),
  'not settled':f=>delete f.runs[0].operations[0].localSettledAt,
  'closed before created':f=>f.runs[0].operations[0].localSettledAt='2025-01-01T00:00:00.000Z',
  'still queued':f=>f.runs[0].operations[0].status='queued'
 };
 for(const [name,mutate] of Object.entries(cases)){const f=provenUnsentFixture();mutate(f);await assert.rejects(buildProductionDelivery(f),e=>e.code?.startsWith('WORKFLOW_DELIVERY'),name);}
});
test('delivery refuses stale, unreviewed, pending boundary/repair, duplicate and ledger mismatch',async()=>{
 for(const mutate of [f=>f.views.run8.freshness='DEFERRED',f=>f.workflow.qualityReviews=[],f=>f.runs[1].production.boundaryCheck.status='PRELIMINARY',f=>f.runs[1].production.pendingRepair={packageIds:['p']},f=>f.runs[1].operations[0].attemptId='a7',f=>f.ledger.attempts[0].totalTokens=21,f=>f.ledger.attempts=[]]){
  const f=fixture();mutate(f);await assert.rejects(buildProductionDelivery(f),e=>e.code.startsWith('WORKFLOW_DELIVERY'));
 }
});
test('staged delivery resumes exact existing files and refuses source drift before publication',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'staged-delivery-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const b=await buildProductionDelivery(fixture());
 await assert.rejects(writeProductionDelivery({root,bundle:b,revalidate:async()=> 'source-drift'}),{code:'WORKFLOW_DELIVERY_STALE'});
 const final=path.join(root,b.identity);await assert.rejects(readFile(path.join(final,'manifest.json')),{code:'ENOENT'});
 const result=await writeProductionDelivery({root,bundle:b,revalidate:async()=>b.identity});assert.equal(result.reused,false);
});
test('an existing incomplete directory or symlink is preserved, never replaced by a fresh export',async t=>{
 for(const symbolic of [false,true]){
  const root=await mkdtemp(path.join(tmpdir(),'delivery-conflict-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const b=await buildProductionDelivery(fixture()),target=path.join(root,b.identity),outside=await mkdtemp(path.join(tmpdir(),'delivery-existing-'));t.after(()=>rm(outside,{recursive:true,force:true}));
  if(symbolic)await symlink(outside,target,'dir');else await mkdir(target);
  await assert.rejects(writeProductionDelivery({root,bundle:b,revalidate:async()=>b.identity}),{code:'WORKFLOW_DELIVERY_CONFLICT'});
  await assert.rejects(readFile(path.join(target,'manifest.json')),{code:'ENOENT'});
 }
});
