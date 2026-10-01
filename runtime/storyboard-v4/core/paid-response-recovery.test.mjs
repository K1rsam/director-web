import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fixture,draftForRequest,seeded} from './execution-batch-test-fixtures.mjs';
import {hasPendingSavedResponse,isUnresolvedOperation} from './pipeline.mjs';

test('a late batch response is recoverable only while its original execution manifest is active',async t=>{
 let finish,started;const began=new Promise(resolve=>{started=resolve;});
 const {engine,store}=await seeded(t,request=>new Promise(resolve=>{finish=()=>resolve({output:draftForRequest(request)});started();}));
 const running=engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'late'});
 await began;await engine.cancel('batch');finish();const late=await running,op=late.operations[0];
 assert.equal(late.candidates[0].status,'cancelled_late');assert.equal(hasPendingSavedResponse(late,op),true);
 for(const change of [d=>{delete d.executionBatches;},d=>{d.executionBatches.p1.hash='retired';},d=>{d.executionBatches.p1.generation='another-generation';},d=>{d.executionBatches.p1.version='another-version';}]){
  const retired=structuredClone(late);change(retired);
  assert.equal(hasPendingSavedResponse(retired,op),false,'archived or replaced batch responses must stay historical');
  const unknown={...op,status:'unknown'};
  assert.equal(hasPendingSavedResponse(retired,unknown),false);assert.equal(isUnresolvedOperation(unknown),true,'UNKNOWN still requires explicit acknowledgement');
 }
 const archived=await store.update('batch',d=>{delete d.executionBatches;return d;});
 assert.deepEqual(await engine.recover('batch','late'),archived,'a retired completed operation must not try to rebuild its deleted projection');
 assert.deepEqual(archived.operations,late.operations);assert.deepEqual(archived.candidates,late.candidates);
 assert.equal(hasPendingSavedResponse(archived,{...op,executionProjectionVersion:undefined}),true,'legacy non-batch late responses keep their existing recovery behavior');
});

for(const code of ['TIMEOUT','CLI_FAILED'])test(`${code} raw-only batch response cannot re-enter recovery after its manifest is archived`,async t=>{
 const {engine,store}=await seeded(t,request=>{throw Object.assign(new Error(code),{code,raw:JSON.stringify(draftForRequest(request)),requestOutcome:'RESPONDED'});});
 await assert.rejects(engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'saved-batch'}),e=>e.code===code);
 const active=await engine.read('batch');assert.equal(hasPendingSavedResponse(active,active.operations[0]),true);
 const archived=await store.update('batch',d=>{delete d.executionBatches;return d;});
 assert.equal(hasPendingSavedResponse(archived,archived.operations[0]),false);
 assert.deepEqual(await engine.recover('batch','saved-batch'),archived);
});

for(const code of ['TIMEOUT','CLI_FAILED'])test(`${code} after a complete saved JSON response is recovered without another paid call`,async t=>{
 let directory,calls=0;
 const result=await seeded(t,async request=>{
  calls++;const raw=JSON.stringify(draftForRequest(request)),folder=path.join(directory,'attempts','saved');
  await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'raw.txt'),raw);await writeFile(path.join(folder,'request.json'),JSON.stringify(request));
  await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED',usage:{totalTokens:19}}));
  throw Object.assign(new Error(code),{code,raw,requestOutcome:'RESPONDED',usage:{totalTokens:19}});
 },fixture(2));directory=result.directory;
 await assert.rejects(result.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'saved'}),e=>e.code===code);
 const before=await result.engine.read('batch');assert.equal(before.operations[0].status,'completed');assert.equal(before.adopted.length,0);
 const recovered=await result.engine.recover('batch','saved');
 assert.equal(recovered.adopted.length,1,'the already-paid complete response must be adopted for free');
 assert.equal(calls,1);assert.equal(recovered.operations.length,1);
 assert.deepEqual(recovered.operations[0].error,before.operations[0].error);assert.deepEqual(recovered.operations[0].receipt,before.operations[0].receipt);
 assert.deepEqual(await result.engine.recover('batch','saved'),recovered);
});

test('invalid saved response receives only one free parse attempt before normal repair',async t=>{
 let directory,calls=0;
 const result=await seeded(t,async request=>{
  calls++;const folder=path.join(directory,'attempts','invalid');await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'raw.txt'),'{invalid');await writeFile(path.join(folder,'request.json'),JSON.stringify(request));
  await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED'}));
  throw Object.assign(new Error('timeout'),{code:'TIMEOUT',raw:'{invalid',requestOutcome:'RESPONDED'});
 },fixture(2));directory=result.directory;
 await assert.rejects(result.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'invalid'}));
 const d=await result.engine.recover('batch','invalid');
 assert.equal(d.operations[0].recovery?.epoch,d.epoch);assert.equal(d.candidates.at(-1).errors[0].code,'INVALID_JSON');
 assert.equal(d.candidates.at(-1).status,'needs_repair');assert.equal(calls,1);
 assert.deepEqual(await result.engine.recover('batch','invalid'),d);
 const later=await result.engine.cancel('batch');assert.equal(hasPendingSavedResponse(later,later.operations[0]),false);
 assert.deepEqual(await result.engine.recover('batch','invalid'),later,'the same invalid response is not reparsed after another stop');
});

for(const legacy of [false,true])test(`a consumed late batch response with ${legacy?'legacy':'current'} recovery metadata is not adopted again after another stop`,async t=>{
 let directory,calls=0,release,started;const began=new Promise(resolve=>{started=resolve;});
 const {engine,store,directory:folder}=await seeded(t,async request=>{
  calls++;const output=draftForRequest(request),raw=JSON.stringify(output);
  if(calls===1){const attempt=path.join(directory,'attempts','late-once');await mkdir(attempt,{recursive:true});
   await writeFile(path.join(attempt,'raw.txt'),raw);await writeFile(path.join(attempt,'request.json'),JSON.stringify(request));
   await writeFile(path.join(attempt,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED'}));
   await new Promise(resolve=>{release=resolve;started();});
  }
  return {output,raw};
 });directory=folder;
 const running=engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'late-once'});
 await began;await engine.cancel('batch');release();await running;
 const recovered=await engine.recover('batch','late-once'),accepted=recovered.executionBatches.p1.accepted['p1-B01'];
 if(legacy)await store.update('batch',d=>{delete d.operations[0].recovery.responseHashes;return d;});
 await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'next-batch'});const stopped=await engine.cancel('batch');
 assert.equal(hasPendingSavedResponse(stopped,stopped.operations[0]),false,'saved response consumption survives later epochs');
 assert.deepEqual(await engine.recover('batch','late-once'),stopped);
 assert.equal((await engine.read('batch')).executionBatches.p1.accepted['p1-B01'],accepted);
 await engine.execute('batch',{stage:'finish',packageId:'p1',attemptId:'whole-finish'});
 assert.equal((await engine.assemble('batch')).status,'text_ready_for_review');assert.equal(calls,3);
});
