import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createCoordinator} from './coordinator.mjs';
import {executionState} from './core/pipeline.mjs';
import {DELTA_VERSION} from './core/delta.mjs';
import {fixture,draftForRequest} from './core/execution-batch-test-fixtures.mjs';

const binding={projectId:'batch-project',episodeId:'batch-episode',sourceVersion:'batch-source'};
const usage={inputTokens:8,cachedInputTokens:0,outputTokens:2,totalTokens:10};
const gate=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
async function setup(t,{before=async()=>{},failure=()=>null}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'v4-batch-coordinator-')),f=fixture(),calls=[];
 const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',detached:true});await once(child,'spawn');await once(child,'close');
 const localProcess={pid:child.pid,host:hostname(),exitedAt:new Date().toISOString(),exitCode:null,exitSignal:'SIGTERM',closeObserved:true};
 const coordinator=createCoordinator({dataRoot:directory,maxConcurrent:2,modelRunner:async(request,options)=>{
  calls.push(request);await before(request);const folder=path.join(directory,'attempts',options.attemptId);await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'request.json'),JSON.stringify(request));
  const current=await coordinator.read(options.runId);
  const output=request.stage==='plan'?f.plan:request.stage==='finish'?{schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:current.adopted.flatMap(a=>a.draft.units.map(u=>u.id)),replacements:[]}:draftForRequest(request);
  const failed=failure(request,output),raw=failed?.raw??(failed?'':JSON.stringify(output));
  if(raw)await writeFile(path.join(folder,'raw.txt'),raw);
  await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:failed?.requestOutcome||'RESPONDED',errorCode:failed?.code||null,usage:failed?.requestOutcome==='UNKNOWN'?{totalTokens:null}:usage,...(failed?{localProcess}:{})}));
  if(failed)throw Object.assign(new Error('fixture transport ended'),failed,{usage:failed.requestOutcome==='UNKNOWN'?{totalTokens:null}:usage});
  return {output,raw,requestOutcome:'RESPONDED',usage};
 }});
 t.after(async()=>{await coordinator.shutdown();await rm(directory,{recursive:true,force:true});});
 const document=await coordinator.create({source:f.source,settings:f.settings,binding});
 return {c:coordinator,id:document.id,directory,calls,f};
}
async function one(c,id){await c.start(id,{mode:'next'});return c.wait(id);}

test('continuous mode executes author batches serially and finishes the whole event without a second click',async t=>{
 const {c,id,calls}=await setup(t);await c.start(id);const done=await c.wait(id);
 assert.equal(done.status,'text_ready_for_review');assert.equal(done.web.progress,'text_ready_for_review');
 assert.deepEqual(calls.map(r=>r.stage),['plan','author','author','finish']);
 assert.deepEqual(calls.filter(r=>r.stage==='author').map(r=>r.source.dialogue.length),[5,4]);
 assert.equal(done.plan.workPackages.length,1);assert.equal(done.plan.events.length,1);
 assert.equal(done.assembly.draft.units.length,3,'execution batches must not impose output unit boundaries');
 assert.ok(done.assembly.draft.units.every(u=>u.shots.reduce((n,s)=>n+s.duration,0)===30));
 assert.ok(done.assembly.draft.units.some(u=>{const refs=u.shots.flatMap(s=>s.sourceRefs);return refs.includes('s5')&&refs.includes('s6');}),'final packing can cross the execution batch seam');
 assert.equal(done.assembly.draft.units.flatMap(u=>u.shots.flatMap(s=>s.dialogueParts)).length,9);
});

test('a pause waits for its in-flight batch and resumes only the unfinished batch',async t=>{
 const entered=gate(),hold=gate();let held=false;
 const {c,id,calls}=await setup(t,{before:async r=>{if(r.stage==='author'&&!held){held=true;entered.resolve();await hold.promise;}}});
 t.after(()=>hold.resolve());await c.start(id);await entered.promise;await c.pause(id);hold.resolve();const paused=await c.wait(id);
 assert.equal(paused.web.progress,'paused');assert.equal(paused.adopted.length,0);assert.equal(executionState(paused,'p1').completed,1);
 const accepted=structuredClone(paused.executionBatches.p1.accepted);await c.start(id);const done=await c.wait(id);
 assert.equal(done.status,'text_ready_for_review');assert.equal(calls.filter(r=>r.stage==='author').length,2);
 for(const [batch,candidate] of Object.entries(accepted))assert.equal(done.executionBatches.p1.accepted[batch],candidate);
});

test('partially paid author work is protected from silent replan and selection changes',async t=>{
 const {c,id,calls}=await setup(t);await one(c,id);const partial=await one(c,id);
 assert.equal(partial.adopted.length,0);assert.equal(executionState(partial,'p1').completed,1);
 await assert.rejects(c.replan(id),{code:'RESET_DRAFTS_REQUIRED'});
 await assert.rejects(c.choose(id,{mode:'all'}),{code:'RESET_DRAFTS_REQUIRED'});
 await assert.rejects(c.confirm(id,{selectedIds:[]}),{code:'RESET_DRAFTS_REQUIRED'});
 assert.equal(calls.length,2);assert.deepEqual((await c.read(id)).executionBatches,partial.executionBatches);
});

test('explicit reset archives partial batch work instead of reusing it under changed choices',async t=>{
 const {c,id}=await setup(t);await one(c,id);const partial=await one(c,id);
 const reset=await c.choose(id,{mode:'off',resetDrafts:true});assert.equal(reset.executionBatches,undefined);
 assert.deepEqual(reset.web.archives.at(-1).executionBatches,partial.executionBatches);assert.deepEqual(reset.operations,partial.operations);
 assert.deepEqual(reset.candidates,partial.candidates);
 const restarted=await one(c,id);assert.equal(executionState(restarted,'p1').completed,1);
 const newCandidate=Object.values(restarted.executionBatches.p1.accepted)[0],oldCandidate=Object.values(partial.executionBatches.p1.accepted)[0];assert.notEqual(newCandidate,oldCandidate);
});

test('reset after a stopped late batch archives it without recovering the stale batch on restart',async t=>{
 const entered=gate(),hold=gate();let held=false;
 const {c,id,calls}=await setup(t,{before:async r=>{if(r.stage==='author'&&!held){held=true;entered.resolve();await hold.promise;}}});
 t.after(()=>hold.resolve());await c.start(id);await entered.promise;await c.stop(id);hold.resolve();const stopped=await c.wait(id);
 const late=stopped.candidates.find(x=>x.status==='cancelled_late');assert.ok(late);assert.equal(stopped.adopted.length,0);
 const reset=await c.choose(id,{mode:'off',resetDrafts:true});assert.equal(reset.executionBatches,undefined);
 assert.deepEqual(reset.web.archives.at(-1).executionBatches,stopped.executionBatches);
 await c.start(id);const done=await c.wait(id);assert.equal(done.status,'text_ready_for_review');
 assert.deepEqual(calls.map(r=>r.stage),['plan','author','author','author','finish']);
 assert.deepEqual(done.candidates.find(x=>x.id===late.id),late);
 assert.ok(!Object.values(done.executionBatches.p1.accepted).includes(late.id));
});

test('a never-sent empty batch manifest does not block later selection changes',async t=>{
 let onceOnly=true;const {c,id,calls}=await setup(t,{failure:r=>{if(onceOnly&&r.stage==='author'){onceOnly=false;return {code:'PAUSED',requestOutcome:'NOT_SENT'};}return null;}});
 await c.start(id);const failed=await c.wait(id);assert.equal(failed.operations.at(-1).error.requestOutcome,'NOT_SENT');assert.equal(Object.keys(failed.executionBatches.p1.accepted).length,0);
 const changed=await c.choose(id,{mode:'all'});assert.equal(changed.executionBatches,undefined);
 await c.start(id);const done=await c.wait(id);assert.equal(done.status,'text_ready_for_review');assert.equal(calls.filter(r=>r.stage==='author').length,3);
});

for(const code of ['TIMEOUT','CLI_FAILED'])test(`a complete saved batch response from ${code} is recovered for free before finishing`,async t=>{
 let onceOnly=true;const {c,id,calls}=await setup(t,{failure:(r,output)=>{if(onceOnly&&r.stage==='author'&&r.executionBatch?.index===1){onceOnly=false;return {code,requestOutcome:'RESPONDED',raw:JSON.stringify(output)};}return null;}});
 await c.start(id);const failed=await c.wait(id);assert.equal(failed.operations.at(-1).error.code,code);assert.equal(failed.adopted.length,0);assert.equal(calls.length,3);
 const failedAttempt=failed.operations.at(-1).attemptId;await c.start(id);const done=await c.wait(id);
 assert.equal(done.status,'text_ready_for_review');assert.deepEqual(calls.map(r=>r.stage),['plan','author','author','finish']);
 assert.equal(done.operations.find(o=>o.attemptId===failedAttempt).error.code,code);assert.equal(done.operations.find(o=>o.attemptId===failedAttempt).recovery.epoch,done.epoch);
});

test('unknown second batch needs explicit risk acknowledgement and never repeats the accepted first batch',async t=>{
 let onceOnly=true;const {c,id,calls,directory}=await setup(t,{failure:r=>{if(onceOnly&&r.stage==='author'&&r.executionBatch?.index===1){onceOnly=false;return {code:'TIMEOUT',requestOutcome:'UNKNOWN'};}return null;}});
 await c.start(id);const failed=await c.wait(id),op=failed.operations.at(-1),saved=structuredClone(failed.executionBatches.p1.accepted);
 assert.equal(calls.length,3);await assert.rejects(c.start(id),{code:'ATTEMPT_UNRESOLVED'});assert.equal(calls.length,3);
 const receiptFile=path.join(directory,'attempts',op.attemptId,'receipt.json'),before=await readFile(receiptFile,'utf8');
 const status=(await c.cancellationStatus(id)).find(x=>x.attemptId===op.attemptId);assert.equal(status.kind,'timeout');assert.equal(status.canAcknowledge,true);
 await c.acknowledgeCancelled(id,{attemptId:op.attemptId,acceptUnknownUsage:true});assert.equal(calls.length,3);
 await c.start(id);const done=await c.wait(id);assert.equal(done.status,'text_ready_for_review');
 assert.deepEqual(calls.filter(r=>r.stage==='author').map(r=>r.executionBatch.index),[0,1,1]);assert.equal(await readFile(receiptFile,'utf8'),before);
 for(const [batch,candidate] of Object.entries(saved))assert.equal(done.executionBatches.p1.accepted[batch],candidate);
});
