import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine,rebuildFrozenRequest,canRecheckCandidate} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {digest} from './shared.mjs';
import {baseDraftHash,DELTA_VERSION} from './delta.mjs';
import {tailFixture,tailDraft} from './author-call-group-test-fixtures.mjs';
import {publicRun} from '../input.mjs';
import {repairControl} from '../../feedback-repair.mjs';
import {summarizeRun} from '../../../scripts/inspect-production-usage.mjs';

const approval={actorId:'human',reference:'direct-human-answer/reference-role-review',answer:'仅把已核对的原接续行恢复为contextRefs，不改正文和旧候选。'};
const creative=draft=>{const value=structuredClone(draft);for(const u of value.units)for(const s of u.shots){delete s.sourceRefs;delete s.contextRefs;}return value;};
async function setup(t){
 const directory=await mkdtemp(path.join(tmpdir(),'reference-role-review-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const f=tailFixture();
 f.source.sourceRows.unshift({id:'prior',text:'△甲沿走廊向楼梯走去。'});
 f.plan.events[0].sourceRefs.unshift('prior');f.plan.workPackages[0].sourceRefs.unshift('prior');f.plan.provisionalUnits[0].sourceRefs.unshift('prior');
 f.plan.workPackages[2].contextRefs=['prior'];
 const store=createStore(directory);let calls=0;
 const engine=createEngine({directory,modelRunner:async(request,options)=>{
  calls++;
  let output=request.stage==='plan'?structuredClone(f.plan):tailDraft(request);
  if(request.stage==='author')for(const u of output.units.filter(u=>u.eventId==='e3'))u.shots[0].contextRefs=['prior'];
  if(request.stage==='finish'){
   const previous=(await store.read('review')).operations.find(o=>o.attemptId===options.attemptId).previousDraft;
   const unit=structuredClone(previous.units.at(-1));unit.shots[0].sourceRefs.push('prior');unit.shots[0].contextRefs=[];
   output={schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(previous),retainedUnitIds:previous.units.slice(0,-1).map(u=>u.id),replacements:[{replaces:[unit.id],units:[unit],fantasyRealization:[]}]};
  }
  return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{inputTokens:10,outputTokens:5,totalTokens:15}};
 }});
 await engine.create({id:'review',source:f.source,settings:f.settings});
 await engine.execute('review',{stage:'plan',attemptId:'plan'});
 for(const packageId of ['p1','p2','p3'])await engine.execute('review',{stage:'author',packageId,attemptId:'author-'+packageId});
 await engine.execute('review',{stage:'finish',packageIds:['p1','p2','p3'],finishMode:'delta',attemptId:'finish'});
 const before=await engine.read('review'),candidate=before.candidates.at(-1),op=before.operations.at(-1),unit=candidate.draft.units.at(-1);
 assert.deepEqual(candidate.validation.errors.map(e=>e.code),['EVENT_SOURCE']);assert.equal(canRecheckCandidate(before,candidate),true);
 const value={kind:'CANDIDATE_REFERENCE_ROLES',candidateId:candidate.id,sourceHash:digest(before.source),planHash:digest({plan:before.plan,settings:before.settings,rulesSnapshot:before.rulesSnapshot,epoch:before.epoch}),candidateHash:digest(candidate),operationHash:digest(op),changes:[{unitId:unit.id,shotId:unit.shots[0].id,sourceRefs:['prior']}]};
 return {engine,store,before,candidate,op,value,calls:()=>calls,directory};
}

test('human reference-role review appends a fully checked candidate without changing any old candidate, creative field or frozen operation',async t=>{
 const {engine,before,candidate,op,value,calls}=await setup(t),request=rebuildFrozenRequest(before,op);
 const after=await engine.resolveSource('review',value,approval),derived=after.candidates.at(-1);
 assert.equal(derived.status,'adopted');assert.equal(derived.derivedFrom,candidate.id);
 assert.deepEqual(after.candidates.slice(0,before.candidates.length),before.candidates);
 for(const key of ['source','plan','choice','rulesSnapshot','operations','settings','epoch'])assert.deepEqual(after[key],before[key],key);
 assert.deepEqual(creative(derived.draft),creative(candidate.draft));assert.deepEqual(derived.validation.errors,[]);
 assert.deepEqual(derived.draft.units.at(-1).shots[0].sourceRefs,['s6']);assert.deepEqual(derived.draft.units.at(-1).shots[0].contextRefs,['prior']);
 assert.equal(derived.raw,candidate.raw);assert.deepEqual(derived.receipt,candidate.receipt);
 assert.equal(derived.referenceRoleReview.version,'candidate-reference-role-review-v1');assert.equal(derived.referenceRoleReview.modelCalls,0);
 assert.deepEqual(rebuildFrozenRequest(after,op),request);assert.equal(canRecheckCandidate(after,after.candidates.find(c=>c.id===candidate.id)),false);
 assert.equal(publicRun(after).lastCandidateId,null);assert.equal(publicRun(after).candidates.find(c=>c.id===candidate.id).resolvedBy,derived.id);
 assert.equal(repairControl(after),null);assert.equal(summarizeRun(after,new Map()).candidateErrors.find(c=>c.candidateId===candidate.id).resolvedBy,derived.id);
 const complete=await engine.assemble('review');assert.equal(complete.status,'text_ready_for_review');assert.equal(complete.assembly.validation.errors.length,0);
 assert.deepEqual(creative(complete.assembly.draft),creative(candidate.draft));assert.equal(calls(),5);
 const saved=structuredClone(complete);await assert.rejects(engine.resolveSource('review',value,approval),e=>/^SOURCE_RESOLUTION/.test(e.code));assert.deepEqual(await engine.read('review'),saved);
});

test('reference-role review rejects unapproved, stale, unknown, in-event or unsupported reclassification atomically',async t=>{
 const f=await setup(t),file=path.join(f.directory,'documents/review.json');
 const modes=['approval','sourceHash','candidateHash','operationHash','planHash','unknownShot','inEvent','unknownRef','duplicateRef','unapprovedField','notPriorContext','running','stopped','sourceStale','otherError'];
 for(const mode of modes){
  const doc=structuredClone(f.before),value=structuredClone(f.value);let trusted=approval;
  if(mode==='approval')trusted={...approval,reference:''};
  if(['sourceHash','candidateHash','operationHash','planHash'].includes(mode))value[mode]='0'.repeat(64);
  if(mode==='unknownShot')value.changes[0].shotId='missing';
  if(mode==='inEvent')value.changes[0].sourceRefs=['s6'];
  if(mode==='unknownRef')value.changes[0].sourceRefs=['missing'];
  if(mode==='duplicateRef')value.changes[0].sourceRefs=['prior','prior'];
  if(mode==='unapprovedField')value.changes[0].picture='不得夹带改稿';
  if(mode==='notPriorContext')doc.operations.at(-1).previousDraft.units.at(-1).shots[0].contextRefs=[];
  if(mode==='running')doc.operations.push({attemptId:'live',status:'running',stage:'author',packageIds:['p1']});
  if(mode==='stopped')doc.web={stopped:true};
  if(mode==='sourceStale')doc.web={sourceStale:true};
  if(mode==='otherError')doc.candidates.at(-1).validation.errors.push({code:'VOICE_TIMING',coordinate:'other'});
  await f.store.update('review',()=>doc);const before=await readFile(file,'utf8');
  await assert.rejects(f.engine.resolveSource('review',value,trusted),e=>/^SOURCE_RESOLUTION/.test(e.code),mode);
  assert.equal(await readFile(file,'utf8'),before,mode);assert.equal(f.calls(),5);
 }
});

test('a damaged review receipt or projected draft never masks the preserved original error',async t=>{
 const f=await setup(t),after=await f.engine.resolveSource('review',f.value,approval);
 for(const mutate of [d=>{d.candidates.at(-1).referenceRoleReview.approval.answer='未批准的变更';},d=>{d.candidates.at(-1).draft.units.at(-1).shots[0].picture+='漂移';},d=>{d.candidates[0].raw+='漂移';},d=>{d.source.sourceRows[0].text+='漂移';}]){
  const copy=structuredClone(after);mutate(copy);
  // Altering an unrelated plan candidate does not invalidate a bound finish review.
  const changedPlanOnly=copy.candidates[0].raw!==after.candidates[0].raw;
  assert.equal(publicRun(copy).lastCandidateId,changedPlanOnly?null:f.candidate.id);
 }
});

