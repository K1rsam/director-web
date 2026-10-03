import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCoordinator} from './coordinator.mjs';
import {createStore} from './core/store.mjs';
import {DELTA_VERSION} from './core/delta.mjs';
import {tailFixture,tailDraft} from './core/author-call-group-test-fixtures.mjs';

const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
const packageScopes=items=>items.map(x=>x.packageIds).sort((a,b)=>a[0].localeCompare(b[0]));
async function setup(t,{before=async()=>{},legacy=false,budget,failure=()=>null,authorOutput=tailDraft}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'v4-author-group-')),f=tailFixture(),calls=[];
 const c=createCoordinator({dataRoot:directory,maxConcurrent:2,modelRunner:async(r,options)=>{
  calls.push(r);await before(r);
  const current=await c.read(options.runId);
  const output=r.stage==='plan'?f.plan:r.stage==='author'?authorOutput(r):r.finishMode==='delta'?{schemaVersion:DELTA_VERSION,baseDraftHash:r.baseDraftHash,retainedUnitIds:current.adopted.filter(a=>a.packageIds.some(id=>r.packageIds.includes(id))).flatMap(a=>a.draft.units.map(u=>u.id)),replacements:[],revisionNotes:[],unresolved:[]}:tailDraft(r);
  const raw=JSON.stringify(output),usage={inputTokens:8,outputTokens:2,totalTokens:10},failed=failure(r);
  const folder=path.join(directory,'attempts',options.attemptId);await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'request.json'),JSON.stringify(r));await writeFile(path.join(folder,'raw.txt'),raw);
  await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED',usage,errorCode:failed?.code||null}));
  if(failed)throw Object.assign(new Error('saved fixture response'),failed,{raw,requestOutcome:'RESPONDED',usage});
  return {output,raw,requestOutcome:'RESPONDED',usage};
 }});
 t.after(async()=>{await c.shutdown();await rm(directory,{recursive:true,force:true});});
 const d=await c.create({source:f.source,settings:f.settings,binding:{projectId:'tail-project',episodeId:'tail-episode',sourceVersion:'tail-source'},...(budget?{budget}:{})});
 if(legacy)await createStore(directory).update(d.id,x=>{delete x.rulesSnapshot.authorCallGroupingVersion;return x;});
 return {c,id:d.id,calls,directory};
}

test('three-package shape adopts P1 before requesting adjacent P2/P3 with no duplicate tail call',async t=>{
 const entered=gate(),hold=gate();
 const {c,id,calls}=await setup(t,{before:async r=>{if(r.stage==='author'&&r.packageIds.includes('p1')){entered.resolve();await hold.promise;}}});
 await c.start(id);await entered.promise;
 try{await new Promise(resolve=>setTimeout(resolve,30));const running=await c.read(id);assert.deepEqual(packageScopes(running.operations.filter(o=>o.stage==='author')),[['p1']]);assert.equal(calls.filter(r=>r.stage==='author').length,1);}
 finally{hold.resolve();}
 const done=await c.wait(id);
 assert.deepEqual(calls.map(r=>r.stage),['plan','author','author','finish']);assert.deepEqual(packageScopes(calls.filter(r=>r.stage==='author')),[['p1'],['p2','p3']]);
 assert.deepEqual(calls.at(-1).packageIds,['p1','p2','p3']);
 assert.equal(done.status,'text_ready_for_review');assert.deepEqual(done.assembly.validation.errors,[]);
 assert.deepEqual(done.plan.workPackages.map(w=>w.id),['p1','p2','p3']);assert.equal(done.plan.events.length,3);
 assert.deepEqual(done.assembly.draft.units.map(u=>u.eventId),['e1','e1','e1','e2','e2','e3']);
});

test('legacy task still authors all three original packages separately',async t=>{
 const {c,id,calls}=await setup(t,{legacy:true});await c.start(id);const done=await c.wait(id);
 assert.equal(done.status,'text_ready_for_review');assert.deepEqual(packageScopes(calls.filter(r=>r.stage==='author')),[['p1'],['p2'],['p3']]);
});

test('a grouped pair consumes one call-budget slot',async t=>{
 const {c,id,calls}=await setup(t,{budget:{maxCalls:3,maxTokens:1000}});await c.start(id);const done=await c.wait(id);
 assert.equal(done.web.progress,'budget_stop');assert.equal(calls.length,3);assert.equal(done.adopted.length,3);
 assert.deepEqual(packageScopes(calls.filter(r=>r.stage==='author')),[['p1'],['p2','p3']]);
});

for(const code of ['TIMEOUT','CLI_FAILED'])test(`saved grouped ${code} output recovers without another author call or changed fingerprint`,async t=>{
 let once=true;const {c,id,calls}=await setup(t,{failure:r=>{if(once&&r.stage==='author'&&r.packageIds.length===2){once=false;return {code};}return null;}});
 await c.start(id);const failed=await c.wait(id),op=failed.operations.find(o=>o.error?.code===code);assert.ok(op);
 assert.deepEqual(op.packageIds,['p2','p3']);assert.equal(failed.adopted.length,1);
 await c.start(id);const done=await c.wait(id);
 assert.equal(done.status,'text_ready_for_review');assert.deepEqual(packageScopes(calls.filter(r=>r.stage==='author')),[['p1'],['p2','p3']]);
 const recovered=done.operations.find(o=>o.attemptId===op.attemptId);assert.equal(recovered.fingerprint,op.fingerprint);assert.equal(recovered.recovery.epoch,done.epoch);
 const count=calls.length;await c.start(id);assert.equal(calls.length,count);assert.deepEqual((await c.read(id)).assembly,done.assembly);
});

test('stopped late group is recovered with both original package ids before resuming',async t=>{
 const entered=gate(),hold=gate();
 const {c,id,calls}=await setup(t,{before:async r=>{if(r.stage==='author'&&r.packageIds.length===2){entered.resolve();await hold.promise;}}});
 await c.start(id);await entered.promise;await c.stop(id);hold.resolve();const stopped=await c.wait(id);
 const late=stopped.candidates.find(c=>c.packageIds.length===2);assert.equal(late.status,'cancelled_late');
 await c.start(id);const done=await c.wait(id);assert.equal(done.status,'text_ready_for_review');
 assert.equal(calls.filter(r=>r.stage==='author'&&r.packageIds.includes('p2')).length,1);
 assert.equal(calls.filter(r=>r.stage==='author'&&r.packageIds.includes('p3')).length,1);
 assert.deepEqual(done.adopted.map(a=>a.packageIds),[['p1'],['p2'],['p3']]);
});

const emptyAuthor=r=>({...tailDraft(r),units:[]});
const episodeFinishes=calls=>calls.filter(r=>r.stage==='finish'&&r.packageIds.length===3);

test('local repairs of every author scope still require one whole-episode finish',async t=>{
 const {c,id,calls}=await setup(t,{authorOutput:emptyAuthor});await c.start(id);const done=await c.wait(id);
 assert.deepEqual(calls.filter(r=>r.stage==='finish').map(r=>r.packageIds),[['p1'],['p2','p3'],['p1','p2','p3']]);
 assert.equal(done.status,'text_ready_for_review');assert.deepEqual(done.assembly.validation.errors,[]);
 assert.equal(done.web.autoRepairs,2);const count=calls.length;await c.start(id);assert.equal(calls.length,count);
});

test('later local repairs of every group retain the adopted whole-episode finish lineage',async t=>{
 const {c,id,calls}=await setup(t);await c.start(id);const complete=await c.wait(id),whole=complete.adopted[0].candidateId;
 assert.ok(complete.adopted.every(a=>a.candidateId===whole));
 for(const packageIds of [['p1'],['p2','p3']]){await c.repair(id,{packageIds,notes:[{message:'核对本范围现稿'}]});const repaired=await c.wait(id);assert.equal(repaired.status,'text_ready_for_review');}
 const done=await c.read(id);assert.ok(done.adopted.every(a=>a.candidateId!==whole));
 const count=calls.length;await c.start(id);assert.equal(calls.length,count);assert.equal(episodeFinishes(calls).length,1);
});

test('explicit draft archival invalidates old whole-episode evidence even with unchanged choices',async t=>{
 let broken=false;const {c,id,calls}=await setup(t,{authorOutput:r=>broken&&r.packageIds[0]!=='p3'?emptyAuthor(r):tailDraft(r)});
 await c.start(id);const first=await c.wait(id),oldWhole=first.adopted[0].candidateId;
 await c.choose(id,{mode:'off',resetDrafts:true});broken=true;
 // Archived paid groups are no longer fresh-group eligible. Repair two scopes,
 // author the last one, then explicitly repair it before the automatic finish.
 for(let step=0;step<5;step++){await c.start(id,{mode:'next'});await c.wait(id);}
 await c.repair(id,{packageIds:['p3'],notes:[{message:'核对新一轮末包'}]});const repaired=await c.wait(id);
 assert.equal(repaired.web.progress,'needs_finish');
 await c.start(id);const done=await c.wait(id);
 assert.equal(done.candidates.find(x=>x.id===oldWhole).status,'adopted','the paid historical candidate stays preserved');
 assert.equal(episodeFinishes(calls).length,2,'archived finishing must not stand in for the new draft generation');
 assert.equal(done.status,'text_ready_for_review');assert.deepEqual(done.assembly.validation.errors,[]);
});

test('manual local repair cannot assemble scopes that have never shared a whole-episode finish',async t=>{
 const {c,id,calls}=await setup(t,{authorOutput:emptyAuthor,budget:{maxCalls:4,maxTokens:1000}});
 await c.start(id);const stopped=await c.wait(id);assert.equal(stopped.web.progress,'budget_stop');
 await c.setBudget(id,{maxCalls:32,maxTokens:1000});await c.repair(id,{packageIds:['p2','p3'],notes:[{message:'修复保存的空稿'}]});
 const repaired=await c.wait(id);assert.equal(repaired.assembly===null,true);assert.equal(repaired.web.progress,'needs_finish');
 await c.start(id);const done=await c.wait(id);assert.equal(episodeFinishes(calls).length,1);assert.equal(done.status,'text_ready_for_review');
});
