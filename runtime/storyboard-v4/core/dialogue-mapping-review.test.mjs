import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine,rebuildFrozenRequest,canRecheckCandidate} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {digest} from './shared.mjs';
import {tailFixture,tailDraft} from './author-call-group-test-fixtures.mjs';
import {candidateResolvedBy} from './reference-role-review.mjs';
import {normalizeSource} from './source.mjs';
const approval={actorId:'human',reference:'direct-human/free-faithful-recovery',answer:'只补原句映射并把已保存声音转入结构化对白，不改原文、创作镜头或付费记录。'};
async function setup(t){
 const directory=await mkdtemp(path.join(tmpdir(),'dialogue-mapping-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const f=tailFixture();f.source.dialogue=normalizeSource(f.source).dialogue;f.source.sourceRows.at(-1).text='甲（OS）不再加班！';let calls=0;
 const engine=createEngine({directory,modelRunner:async request=>{
  calls++;let output=request.stage==='plan'?structuredClone(f.plan):tailDraft(request);
  if(request.stage!=='plan')for(const u of output.units)for(const s of u.shots)if(s.sourceRefs.includes('s6'))s.sound='甲OS于本单元0秒起声，持续到1.8秒：不再加班！ 低声坚定。脚步停下。';
  if(request.stage==='finish')output.unresolved=[{coordinate:'s6/p3-pu3-1-s1',problem:'OS原话已在sound中，但缺对白映射。'}];
  return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{inputTokens:10,outputTokens:5,totalTokens:15}};
 }});
 await engine.create({id:'mapping',source:f.source,settings:f.settings});await engine.execute('mapping',{stage:'plan',attemptId:'plan'});
 for(const packageId of ['p1','p2','p3'])await engine.execute('mapping',{stage:'author',packageId,attemptId:'author-'+packageId});
 await engine.execute('mapping',{stage:'finish',packageIds:['p1','p2','p3'],attemptId:'finish'});
 const before=await engine.read('mapping'),candidate=before.candidates.at(-1),op=before.operations.at(-1),unit=candidate.draft.units.at(-1),shot=unit.shots.at(-1);
 assert.deepEqual(candidate.validation.errors.map(e=>e.code),['UNRESOLVED']);assert.equal(canRecheckCandidate(before,candidate),true);
 const value={kind:'CANDIDATE_DIALOGUE_MAPPING',candidateId:candidate.id,sourceHash:digest(before.source),planHash:digest({plan:before.plan,settings:before.settings,rulesSnapshot:before.rulesSnapshot,epoch:before.epoch}),candidateHash:digest(candidate),operationHash:digest(op),unresolvedHash:digest(candidate.draft.unresolved),mappings:[{sourceRef:'s6',parts:[{unitId:unit.id,shotId:shot.id,quoteRange:[0,5]}]}]};
 return {engine,store:createStore(directory),before,candidate,op,value,calls:()=>calls,directory};
}
test('approved mapping recovery adopts exact existing speech for free and preserves all original evidence',async t=>{
 const f=await setup(t),request=rebuildFrozenRequest(f.before,f.op),after=await f.engine.resolveSource('mapping',f.value,approval),derived=after.candidates.at(-1);
 assert.equal(after.status,'text_ready_for_review');assert.deepEqual(after.assembly.validation.errors,[]);assert.equal(f.calls(),5);
 for(const key of ['source','plan','settings','rulesSnapshot','operations','choice','epoch'])assert.deepEqual(after[key],f.before[key],key);
 assert.deepEqual(after.candidates.slice(0,f.before.candidates.length),f.before.candidates);assert.equal(derived.raw,f.candidate.raw);assert.deepEqual(derived.receipt,f.candidate.receipt);
 const expected=structuredClone(f.candidate.draft);delete expected.unresolved;const shot=expected.units.at(-1).shots.at(-1);
 shot.sound='脚步停下。';shot.dialogueParts=[{lineId:'s6:dialogue-mapping-v1',text:'不再加班！',presentation:'OS',delivery:'低声坚定',voiceStart:0,voiceEnd:1.8}];
 assert.deepEqual(derived.draft,expected);assert.equal(candidateResolvedBy(after,after.candidates.find(c=>c.id===f.candidate.id)),derived.id);
 assert.deepEqual(rebuildFrozenRequest(after,f.op),request);assert.match(after.assembly.text,/甲（OS/);assert.match(after.assembly.text,/不再加班！/);
 assert.equal((await f.engine.assemble('mapping')).status,'text_ready_for_review');
 const saved=await f.engine.read('mapping');await assert.rejects(f.engine.resolveSource('mapping',f.value,approval));assert.deepEqual(await f.engine.read('mapping'),saved);
 await assert.rejects(f.engine.execute('mapping',{stage:'finish',packageIds:['p1','p2','p3'],attemptId:'must-not-dispatch'}),{code:'DIALOGUE_MAPPING_REVIEW_FROZEN'});assert.equal(f.calls(),5);assert.deepEqual(await f.engine.read('mapping'),saved);
});
test('mapping review rejects stale evidence, invented text/timing, other defects and unsafe state atomically',async t=>{
 const f=await setup(t);
 for(const mode of ['approval','source','candidate','operation','plan','unresolved','unrelated-unresolved','quote-range','quote-short','unknown-shot','voice','delivery','sound','extra-field','running','stopped','sourceStale','other-error']){
  const doc=structuredClone(f.before),value=structuredClone(f.value),part=value.mappings[0].parts[0];let trusted=approval;
  if(mode==='approval')trusted={...approval,reference:''};
  if(['source','candidate','operation','plan','unresolved'].includes(mode))value[mode+'Hash']='0'.repeat(64);
  if(mode==='unrelated-unresolved'){doc.candidates.at(-1).draft.unresolved[0].coordinate='WP01_UNRELATED';value.candidateHash=digest(doc.candidates.at(-1));value.unresolvedHash=digest(doc.candidates.at(-1).draft.unresolved);}
  if(mode==='quote-range')part.quoteRange=[0,6];if(mode==='quote-short')part.quoteRange=[0,4];
  if(mode==='unknown-shot')part.shotId='missing';if(mode==='voice')part.voiceEnd=20;
  if(mode==='delivery')part.delivery='凭空新表演';if(mode==='sound')part.soundKeep='凭空新音效';if(mode==='extra-field')part.picture='改镜';
  if(mode==='running')doc.operations.push({stage:'author',attemptId:'live',status:'running'});if(mode==='stopped')doc.web={stopped:true};if(mode==='sourceStale')doc.web={sourceStale:true};
  if(mode==='other-error'){doc.candidates.at(-1).validation.errors.push({code:'CHANNEL'});value.candidateHash=digest(doc.candidates.at(-1));}
  await f.store.update('mapping',()=>doc);const bytes=await readFile(path.join(f.directory,'documents/mapping.json'),'utf8');
  await assert.rejects(f.engine.resolveSource('mapping',value,trusted),mode);assert.equal(await readFile(path.join(f.directory,'documents/mapping.json'),'utf8'),bytes,mode);assert.equal(f.calls(),5);
 }
});
test('a damaged mapping proof or output cannot hide the original unresolved debt',async t=>{
 const f=await setup(t),after=await f.engine.resolveSource('mapping',f.value,approval);
 for(const mutate of [d=>d.candidates.at(-1).dialogueMappingReview.approval.answer+='drift',d=>d.candidates.at(-1).draft.units.at(-1).shots[0].picture+='drift',d=>d.source.sourceRows.at(-1).text+='drift']){
  const d=structuredClone(after);mutate(d);assert.equal(candidateResolvedBy(d,d.candidates.find(c=>c.id===f.candidate.id)),null);
  await f.store.update('mapping',()=>d);await assert.rejects(f.engine.assemble('mapping'));
 }
});
