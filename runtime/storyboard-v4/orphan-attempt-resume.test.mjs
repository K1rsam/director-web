import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createCoordinator} from './coordinator.mjs';
import {createStore} from './core/store.mjs';

async function exitedPid(){
 const child=spawn(process.execPath,['-e','process.exit(0)'],{detached:true,stdio:'ignore'});
 await once(child,'spawn');await once(child,'close');return child.pid;
}
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'v4-orphan-resume-'));
 let calls=0;
 const c=createCoordinator({dataRoot:directory,modelRunner:async()=>{calls++;throw Error('No model is allowed during orphan acknowledgement');}});
 const store=createStore(directory),owner=await exitedPid(),pid=await exitedPid(),attemptId='orphan-request';
 t.after(async()=>{await c.shutdown();await rm(directory,{recursive:true,force:true});});
 const d=await c.create({source:{key:'orphan-source',sourceRows:[{id:'r1',text:'△甲推门。'}]},settings:{maxUnits:null,fantasyMode:'off'},binding:{projectId:'p',episodeId:'e',sourceVersion:'v1'}});
 const receipt={state:'SUBMITTING',requestOutcome:'UNKNOWN',usage:{inputTokens:null,cachedInputTokens:null,outputTokens:null,totalTokens:null},responseDisposition:null,
  localProcess:{pid,host:hostname(),startedAt:new Date().toISOString(),exitedAt:null,closeObserved:false},execution:{phase:'waiting',terminalEvent:null}};
 const folder=path.join(directory,'attempts',attemptId),receiptFile=path.join(folder,'receipt.json');await mkdir(folder,{recursive:true});
 await writeFile(path.join(folder,'request.json'),'{}');await writeFile(receiptFile,JSON.stringify(receipt));
 await store.update(d.id,r=>{r.status='running';r.web.owner=owner;r.web.progress='running';r.web.reservedAttemptIds=[attemptId];r.web.reserved=1;
  r.operations=[{attemptId,stage:'plan',packageIds:[],epoch:r.epoch,status:'running',fingerprint:'saved-request',createdAt:new Date().toISOString()}];return r;});
 await c.recover(d.id,attemptId);
 return {c,store,id:d.id,attemptId,receipt,receiptFile,folder,owner,pid,calls:()=>calls};
}

test('dead executor and dead CLI allow explicit local acknowledgement without forging a native FINAL',async t=>{
 const f=await fixture(t),before=await readFile(f.receiptFile,'utf8'),saved=await f.c.read(f.id);
 const status=(await f.c.cancellationStatus(f.id))[0];assert.equal(status.kind,'orphan');assert.equal(status.canAcknowledge,true);
 await assert.rejects(f.c.acknowledgeCancelled(f.id,{attemptId:f.attemptId}),{code:'UNKNOWN_USAGE_CONFIRMATION'});
 const accepted=await f.c.acknowledgeCancelled(f.id,{attemptId:f.attemptId,acceptUnknownUsage:true}),op=accepted.operations[0];
 assert.equal(op.status,'unknown');assert.equal(op.cancelAcknowledgement.kind,'orphan');assert.equal(op.cancelAcknowledgement.acceptUnknownUsage,true);
 assert.ok(Number.isFinite(Date.parse(op.localSettledAt)));assert.equal(op.cancelAcknowledgement.evidence.ownerPid,f.owner);
 assert.equal(op.cancelAcknowledgement.evidence.cliPid,f.pid);assert.ok(op.cancelAcknowledgement.evidence.receiptHash);
 assert.equal(accepted.web.owner,null);assert.deepEqual(accepted.web.reservedAttemptIds,[]);assert.equal(accepted.web.progress,'paused');
 assert.deepEqual(accepted.source,saved.source);assert.deepEqual(accepted.candidates,saved.candidates);assert.deepEqual(accepted.adopted,saved.adopted);
 assert.equal(await readFile(f.receiptFile,'utf8'),before);assert.equal(JSON.parse(before).state,'SUBMITTING');assert.equal(f.calls(),0);
 const again=await f.c.acknowledgeCancelled(f.id,{attemptId:f.attemptId,acceptUnknownUsage:true});
 assert.deepEqual(again.operations[0].cancelAcknowledgement,op.cancelAcknowledgement);
});

for(const [name,change]of [
 ['live executor',async f=>f.store.update(f.id,r=>{r.web.owner=process.pid;return r;})],
 ['missing executor',async f=>f.store.update(f.id,r=>{r.web.owner=null;return r;})],
 ['live CLI',async f=>{f.receipt.localProcess.pid=process.pid;await writeFile(f.receiptFile,JSON.stringify(f.receipt));}],
 ['foreign CLI',async f=>{f.receipt.localProcess.host='other-machine';await writeFile(f.receiptFile,JSON.stringify(f.receipt));}],
 ['native known usage',async f=>{f.receipt.usage={inputTokens:1,outputTokens:1,totalTokens:2};await writeFile(f.receiptFile,JSON.stringify(f.receipt));}],
 ['terminal native event',async f=>{f.receipt.execution.terminalEvent='turn.completed';await writeFile(f.receiptFile,JSON.stringify(f.receipt));}],
 ['another reservation',async f=>f.store.update(f.id,r=>{r.web.reservedAttemptIds.push('other-request');return r;})]
])test(`orphan acknowledgement refuses ${name}`,async t=>{
 const f=await fixture(t);await change(f);const status=(await f.c.cancellationStatus(f.id))[0];
 assert.equal(status.canAcknowledge,false);await assert.rejects(f.c.acknowledgeCancelled(f.id,{attemptId:f.attemptId,acceptUnknownUsage:true}));
 assert.equal((await f.c.read(f.id)).operations[0].cancelAcknowledgement,undefined);assert.equal(f.calls(),0);
});

test('a surviving CLI process group blocks orphan acknowledgement',async t=>{
 const f=await fixture(t),kill=process.kill.bind(process);
 t.mock.method(process,'kill',(pid,signal)=>pid===-f.pid?true:kill(pid,signal));
 assert.equal((await f.c.cancellationStatus(f.id))[0].canAcknowledge,false);
 await assert.rejects(f.c.acknowledgeCancelled(f.id,{attemptId:f.attemptId,acceptUnknownUsage:true}),{code:'RUN_ACTIVE'});
});

test('another unresolved operation cannot be cleared by orphan acknowledgement',async t=>{
 const f=await fixture(t);await f.store.update(f.id,r=>{r.operations.push({attemptId:'other',status:'unknown',epoch:r.epoch,stage:'author',packageIds:[]});return r;});
 await assert.rejects(f.c.acknowledgeCancelled(f.id,{attemptId:f.attemptId,acceptUnknownUsage:true}));assert.equal(f.calls(),0);
 assert.equal((await f.c.read(f.id)).operations[0].cancelAcknowledgement,undefined);
});

test('a sibling live run blocks orphan acknowledgement',async t=>{
 const f=await fixture(t),other=await f.c.create({source:{key:'sibling',sourceRows:[{id:'r1',text:'△甲推门。'}]},settings:{maxUnits:null,fantasyMode:'off'},binding:{projectId:'p',episodeId:'e',sourceVersion:'v1'}});
 await f.store.update(other.id,r=>{r.web.owner=process.pid;return r;});
 await assert.rejects(f.c.acknowledgeCancelled(f.id,{attemptId:f.attemptId,acceptUnknownUsage:true}),{code:'EPISODE_BUSY'});assert.equal(f.calls(),0);
});

test('orphan acknowledgement sends nothing and only a later explicit start retries the missing step',async t=>{
 const f=await fixture(t);await assert.rejects(f.c.start(f.id,{mode:'next'}),{code:'ATTEMPT_UNRESOLVED'});assert.equal(f.calls(),0);
 await f.c.acknowledgeCancelled(f.id,{attemptId:f.attemptId,acceptUnknownUsage:true});assert.equal(f.calls(),0);
 await f.c.start(f.id,{mode:'next'});const resumed=await f.c.wait(f.id);assert.equal(f.calls(),1);
 assert.equal(resumed.operations.length,2);assert.equal(resumed.operations[0].status,'unknown');assert.equal(resumed.operations[1].stage,'plan');
});

for(const name of ['raw.txt','event-final.txt','candidate'])test(`orphan acknowledgement prioritizes saved ${name}`,async t=>{
 const f=await fixture(t);
 if(name==='candidate')await f.store.update(f.id,r=>{r.candidates.push({id:'saved',attemptId:f.attemptId,raw:'saved content'});return r;});
 else await writeFile(path.join(f.folder,name),'saved content');
 const status=(await f.c.cancellationStatus(f.id))[0];assert.equal(status.canAcknowledge,false);assert.equal(status.code,'RECOVER_RESPONSE_FIRST');
 await assert.rejects(f.c.acknowledgeCancelled(f.id,{attemptId:f.attemptId,acceptUnknownUsage:true}),{code:'RECOVER_RESPONSE_FIRST'});assert.equal(f.calls(),0);
});
