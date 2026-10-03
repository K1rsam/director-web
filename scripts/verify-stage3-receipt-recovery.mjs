import assert from 'node:assert/strict';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createStore} from '../runtime/storyboard-v4/core/store.mjs';
import {createCoordinator} from '../runtime/storyboard-v4/coordinator.mjs';
import {canRecheckCandidate} from '../runtime/storyboard-v4/core/pipeline.mjs';
import {repairControl,CURRENT_FEEDBACK_REPAIR_VERSION} from '../runtime/feedback-repair.mjs';
import {digest} from '../runtime/storyboard-v4/core/shared.mjs';

// Real paid history is read-only. Recheck and provider substitutes run in a temporary store.
const id=process.argv[2]||'386cb58c-6f57-4181-9121-229011dbb40e';
assert.match(id,/^[a-f0-9-]{36}$/);
const file=path.resolve('.storyboard-stage3-v2/documents',id+'.json'),bytes=await readFile(file),original=JSON.parse(bytes);
const latest=original.candidates.findLast(c=>c.status==='needs_repair'&&!c.resolvedBy);
assert.ok(latest&&canRecheckCandidate(original,latest),'historical fingerprint must remain reconstructible');
const report=[];
for(const repaired of [true,false]){
 const directory=await mkdtemp(path.join(tmpdir(),'stage3-receipt-replay-')),store=createStore(directory);let calls=0;
 const c=createCoordinator({dataRoot:directory,modelRunner:async request=>{
  calls++;assert.ok(request.feedbackRepair,'never regenerate the whole plan');
  assert.equal(request.feedbackRepair.version,CURRENT_FEEDBACK_REPAIR_VERSION);
  assert.deepEqual(Object.keys(request.schema.properties),['productionFeedback']);
  const feedback=structuredClone(latest.output.productionFeedback);
  if(repaired)feedback.sharedChoices[0].authority='DESIGN';
  return {output:{productionFeedback:feedback},raw:JSON.stringify({productionFeedback:feedback}),usage:{inputTokens:10,outputTokens:10,totalTokens:20,cachedInputTokens:0},requestOutcome:'RESPONDED'};
 }});
 try{
  await store.create(id,original);await c.recheck(id,latest.id);
  const checked=await c.read(id),derived=checked.candidates.at(-1);
  assert.equal(calls,0);assert.equal(checked.operations.length,original.operations.length);
  assert.equal(derived.errors[0].coordinate,'productionFeedback.sharedChoices[0].authority');
  assert.deepEqual(derived.output,latest.output);assert.equal(repairControl(checked).blocked,false);
  await c.start(id,{mode:'next'});await c.wait(id);const after=await c.read(id);
  assert.equal(calls,1);assert.equal(after.operations.length,original.operations.length+1);
  assert.equal(after.web.autoRepairs,original.web.autoRepairs+1);
  for(let i=0;i<original.operations.length;i++)assert.equal(after.operations[i].fingerprint,original.operations[i].fingerprint);
  for(let i=0;i<original.candidates.length;i++){
   assert.equal(after.candidates[i].raw,original.candidates[i].raw);
   assert.deepEqual(after.candidates[i].output,original.candidates[i].output);
  }
  assert.deepEqual(after.web.budget,original.web.budget);
  if(repaired){
   assert.equal(after.candidates.at(-1).status,'adopted');
   const expected=structuredClone(latest.output);expected.productionFeedback.sharedChoices[0].authority='DESIGN';
   assert.equal(digest(after.candidates.at(-1).output),digest(expected),'the classification is the only changed field');
  }else{
   assert.equal(after.candidates.at(-1).status,'needs_repair');
   await c.start(id,{mode:'all'});await c.wait(id);assert.equal(calls,1,'same precise failure must not buy another retry');
   assert.equal(repairControl(await c.read(id)).blocked,true);
  }
  report.push({substituteRepaired:repaired,freeRechecks:1,substituteCalls:calls,oldPaidOperationsPreserved:original.operations.length,creativeBodyUnchanged:true});
 }finally{await c.shutdown();await rm(directory,{recursive:true,force:true});}
}
assert.deepEqual(await readFile(file),bytes,'the real production document remains byte-for-byte unchanged');
console.log(JSON.stringify({realProviderCalls:0,productionWrites:0,report}));
