import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import path from 'node:path';
import {createCoordinator} from './core/legacy-test-fixtures.mjs';
import {createStore} from './core/store.mjs';
import {PLAN_VERSION,VERSION} from './core/shared.mjs';

const plan={schemaVersion:PLAN_VERSION,emotionArc:'警惕转为坚定',entryFacts:[],workPackages:[{id:'p',sourceRefs:['r'],dependsOn:[],emotionContract:{subject:'甲',contextTone:'警惕',audienceEffect:'期待',change:'握拳',landing:'坚定',retain:['握拳']}}],provisionalUnits:[{id:'u',packageId:'p',sourceRefs:['r'],secondsRange:[5,10]}],fantasyCandidates:[]};
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'saved-free-recovery-'));let request,calls=0,sourceValid=true;
 const c=createCoordinator({dataRoot:directory,beforeExecute:async()=>sourceValid,modelRunner:async r=>{calls++;request=r;throw Object.assign(new Error('synthetic disconnect'),{code:'TIMEOUT',requestOutcome:'UNKNOWN'});}});
 t.after(async()=>{await c.shutdown();await rm(directory,{recursive:true,force:true});});
 const d=await c.create({source:{key:'generic',sourceRows:[{id:'r',text:'甲：我知道了。'}]},settings:{maxUnits:null,fantasyMode:'off'},binding:{projectId:'other-project',episodeId:'episode',sourceVersion:'source'}});
 await c.start(d.id,{mode:'next'});const held=await c.wait(d.id),op=held.operations[0],folder=path.join(directory,'attempts',op.attemptId);
 await mkdir(folder,{recursive:true});
 const receipt={state:'FINAL',requestOutcome:'RESPONDED',usage:{inputTokens:13,cachedInputTokens:2,outputTokens:7,totalTokens:20},durationMs:31,localProcess:{pid:2147483647,host:hostname(),closeObserved:true,exitedAt:new Date().toISOString()}};
 const save=async()=>{await writeFile(path.join(folder,'request.json'),JSON.stringify(request));await writeFile(path.join(folder,'raw.txt'),JSON.stringify(plan));await writeFile(path.join(folder,'receipt.json'),JSON.stringify(receipt));};
 await save();return {c,id:d.id,store:createStore(directory),receipt,save,folder,calls:()=>calls,stale:()=>{sourceValid=false;}};
}
test('saved FINAL recovery restores the original attempt without dispatch, is idempotent and preserves native bytes',async t=>{
 const f=await fixture(t),native=await readFile(path.join(f.folder,'receipt.json'));
 const recovered=await f.c.recoverSaved(f.id);
 assert.deepEqual(recovered.recoveredAttemptIds,[(await f.c.read(f.id)).operations[0].attemptId]);
 assert.ok((await f.c.read(f.id)).plan);assert.equal(f.calls(),1);
 assert.deepEqual((await f.c.recoverSaved(f.id)).recoveredAttemptIds,[]);assert.equal(f.calls(),1);
 assert.deepEqual(await readFile(path.join(f.folder,'receipt.json')),native);
});
test('non-final, absent body and unverified/live processes do not become free completed responses',async t=>{
 const f=await fixture(t);
 for(const change of [r=>r.state='SUBMITTING',r=>r.requestOutcome='UNKNOWN',r=>r.localProcess.closeObserved=false,r=>r.localProcess.pid=process.pid,r=>delete r.localProcess]){
  const original=structuredClone(f.receipt);change(f.receipt);await f.save();
  assert.deepEqual((await f.c.recoverSaved(f.id)).recoveredAttemptIds,[]);assert.equal((await f.c.read(f.id)).plan,null);
  Object.assign(f.receipt,original);
 }
 await f.save();await writeFile(path.join(f.folder,'raw.txt'),'');
 assert.deepEqual((await f.c.recoverSaved(f.id)).recoveredAttemptIds,[]);assert.equal(f.calls(),1);
});
test('saved recovery still enforces source and current request identity',async t=>{
 const f=await fixture(t);f.stale();await assert.rejects(f.c.recoverSaved(f.id),{code:'SOURCE_STALE'});assert.equal(f.calls(),1);
});
test('a different saved request cannot be accepted as the original attempt',async t=>{
 const f=await fixture(t);await writeFile(path.join(f.folder,'request.json'),JSON.stringify({promptHash:'other'}));
 await assert.rejects(f.c.recoverSaved(f.id),{code:'ATTEMPT_CONFLICT'});assert.equal(f.calls(),1);assert.equal((await f.c.read(f.id)).plan,null);
});
test('missing original request or a changed epoch never authorizes automatic adoption',async t=>{
 const f=await fixture(t);await rm(path.join(f.folder,'request.json'));
 assert.deepEqual((await f.c.recoverSaved(f.id)).recoveredAttemptIds,[]);assert.equal((await f.c.read(f.id)).plan,null);
 await f.save();await f.store.update(f.id,d=>{d.epoch++;return d;});
 assert.deepEqual((await f.c.recoverSaved(f.id)).recoveredAttemptIds,[]);assert.equal(f.calls(),1);
});
test('a recovered whole-episode finish is assembled for free without starting a fourth request',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'saved-finish-recovery-'));let calls=0,request;
 const c=createCoordinator({dataRoot:directory,modelRunner:async r=>{calls++;request=r;
  if(r.stage==='finish')throw Object.assign(new Error('synthetic disconnect'),{code:'TIMEOUT',requestOutcome:'UNKNOWN'});
  const output=r.stage==='plan'?plan:{schemaVersion:VERSION,units:[{id:'u',title:'回答',intent:{subject:'甲',change:'开口',landing:'说完',retain:['原话']},scene:'房间',props:[],participants:['甲'],lighting:'柔光',initialState:'站定',exitState:'点头',shots:[{id:'s',duration:5,camera:'近景',picture:'甲开口回答。',lighting:'柔光',sound:'人声',dialogueParts:r.source.dialogue.map(q=>({lineId:q.id,text:q.quote,presentation:'画内',delivery:'自然',voiceStart:0,voiceEnd:3})),transition:'切',sourceRefs:['r']}]}],fantasyRealization:[]};
  return {output,raw:JSON.stringify(output),usage:{inputTokens:15,outputTokens:5,totalTokens:20},requestOutcome:'RESPONDED'};
 }});
 t.after(async()=>{await c.shutdown();await rm(directory,{recursive:true,force:true});});
 const d=await c.create({source:{key:'another-story',sourceRows:[{id:'r',text:'甲：我知道了。'}]},settings:{maxUnits:null,fantasyMode:'off'},binding:{projectId:'another',episodeId:'ep',sourceVersion:'sv'}});
 await c.start(d.id);const held=await c.wait(d.id);assert.equal(calls,3);
 const op=held.operations.at(-1),folder=path.join(directory,'attempts',op.attemptId);await mkdir(folder,{recursive:true});
 const {DELTA_VERSION}=await import('./core/delta.mjs');
 await writeFile(path.join(folder,'request.json'),JSON.stringify(request));await writeFile(path.join(folder,'raw.txt'),JSON.stringify({schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:['u'],replacements:[],revisionNotes:[],unresolved:[]}));
 await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED',usage:{inputTokens:15,outputTokens:5,totalTokens:20},localProcess:{host:hostname(),pid:2147483647,exitedAt:new Date().toISOString(),closeObserved:true}}));
 const result=await c.recoverSaved(d.id);assert.deepEqual(result.recoveredAttemptIds,[op.attemptId]);assert.equal(result.document.status,'text_ready_for_review');assert.equal(result.document.assembly.validation.errors.length,0);assert.equal(calls,3);
});
