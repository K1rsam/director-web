import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {tailFixture,tailDraft} from './author-call-group-test-fixtures.mjs';
import {DELTA_VERSION,baseDraftHash} from './delta.mjs';
import {buildReviewPacket} from '../review-packet.mjs';
import {getRefinementComparison} from './refinement-comparison.mjs';
import {refinementAssemblyHash} from './director-refinement.mjs';
import {getRefinementAcceptanceGroups,selectRefinementGroups,assertRefinementRetained} from './refinement-adoption.mjs';
import {getRefinementConflictReview} from './refinement-source-resolution.mjs';

const completed=output=>({output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{totalTokens:1}});
const emptyFeedback={relation:'INDEPENDENT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]};
async function fixture(t,{changeDelta=()=>{},beforeRefinement=()=>{},production=false}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'refinement-selection-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=createStore(directory),calls=[],engine=createEngine({directory,modelRunner:async(request,options)=>{
  calls.push(request);const base=(await store.read('episode')).operations.find(o=>o.attemptId===options.attemptId)?.previousDraft;
  const respond=output=>completed(production?{...output,productionFeedback:output.productionFeedback||structuredClone(emptyFeedback)}:output);
  if(request.stage==='plan')return respond(tailFixture().plan);
  if(request.stage==='author')return respond(tailDraft(request));
  const delta={schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(base),retainedUnitIds:base.units.map(u=>u.id),replacements:[],revisionNotes:[],unresolved:[]};
  if(request.purpose==='director_refinement'){
   for(const [i,unit] of base.units.slice(0,2).entries()){
    const next=structuredClone(unit);next.shots[0].picture=`已改组${i+1}：甲先落眼，再说原话。`;
    delta.replacements.push({replaces:[unit.id],units:[next],fantasyRealization:[]});
    delta.revisionNotes.push({coordinate:unit.id,sourceRefs:unit.shots[0].sourceRefs,change:`组${i+1}改动`,preservedFunction:'保留原话'});
   }
   delta.retainedUnitIds=base.units.slice(2).map(u=>u.id);
   delta.reviewDecisions=base.units.filter(u=>u.eventId==='e1').map(u=>({unitIds:[u.id],disposition:delta.retainedUnitIds.includes(u.id)?'retained':'changed',reason:'原话不变，明确视线落点',preservedFunction:'原话与决定'}));
  }
  if(request.purpose==='director_refinement')changeDelta(delta,base);
  return respond(delta);
 }}),f=tailFixture();
 await engine.create({id:'episode',source:f.source,settings:f.settings,...(production?{production:{version:'production-feedback-v1',boundary:null,materials:[],outgoingAgreements:[]}}:{})});
 // Replay v2 refinement decisions and the older production receipts without resultRevision.
 await store.update('episode',d=>{d.rulesSnapshot.directorRefinementVersion='director-refinement-v2';d.rulesSnapshot.productionFeedbackResultVersion='production-feedback-result-v1';return d;});
 await engine.execute('episode',{stage:'plan',attemptId:'plan'});
 for(const packageId of ['p1','p2','p3'])await engine.execute('episode',{stage:'author',packageId,attemptId:`author-${packageId}`});
 await engine.execute('episode',{stage:'finish',finishMode:'delta',packageIds:['p1','p2','p3'],attemptId:'finish'});
 const base=await engine.assemble('episode');
 await store.update('episode',d=>{beforeRefinement(d);return d;});
 const ready=await engine.execute('episode',{stage:'finish',finishMode:'delta',purpose:'director_refinement',refinementEventIds:['e1'],packageIds:['p1','p2','p3'],attemptId:'refine'});
 assert.equal(ready.candidates.at(-1).status,'refinement_ready');
 return {engine,store,base,ready,candidate:ready.candidates.at(-1),calls};
}
const basis=f=>f.ready.operations.at(-1).refinement.baseAssemblyHash;
test('invalid group selections cannot mutate a valid baseline or call the model',async t=>{
 const f=await fixture(t),count=f.calls.length;
 const valid=getRefinementAcceptanceGroups(f.ready,f.candidate)[0].id;
 for(const ids of [[],['unknown'],[valid,valid]]){
  await assert.rejects(f.engine.acceptRefinement('episode',f.candidate.id,basis(f),ids),e=>e.code==='REFINEMENT_GROUP_SELECTION');
  assert.deepEqual((await f.engine.read('episode')).assembly,f.base.assembly);
 }
 assert.equal(f.calls.length,count);
});
test('adopting one complete group retains the other exact unit and exports only actual adoption',async t=>{
 const f=await fixture(t),module=await import('./refinement-adoption.mjs').catch(()=>({}));
 assert.equal(typeof module.getRefinementAcceptanceGroups,'function','missing acceptance group helper');
 const groups=module.getRefinementAcceptanceGroups(f.ready,f.candidate),count=f.calls.length;
 assert.equal(groups.length,2);assert.deepEqual(module.getRefinementAcceptanceGroups(f.ready,f.candidate),groups);
 const adopted=await f.engine.acceptRefinement('episode',f.candidate.id,basis(f),[groups[0].id]),candidate=adopted.candidates.at(-1);
 assert.deepEqual(adopted.assembly.draft.units[1],f.base.assembly.draft.units[1]);
 assert.deepEqual(adopted.assembly.draft.units.slice(2),f.base.assembly.draft.units.slice(2));
 assert.match(adopted.assembly.text,/已改组1/);assert.doesNotMatch(adopted.assembly.text,/已改组2/);
 assert.deepEqual(candidate.draft,f.candidate.draft);assert.equal(candidate.previewText,f.candidate.previewText);
 assert.equal(candidate.adoptedRefinement.version,'refinement-group-selection-v1');assert.equal(candidate.adoptedRefinement.partial,true);
 assert.deepEqual(candidate.adoptedRefinement.groupIds,[groups[0].id]);assert.equal(candidate.adoptedRefinement.text,adopted.assembly.text);
 assert.deepEqual(candidate.adoptedRefinement.draft.revisionNotes.map(n=>n.change),['组1改动']);
 assert.deepEqual(adopted.refinementArchives[0].assembly,f.base.assembly);assert.equal(f.calls.length,count);
 assert.deepEqual(getRefinementComparison(adopted,candidate).changedUnitIds,[f.base.assembly.draft.units[0].id]);
 const packet=buildReviewPacket(adopted,{candidateId:candidate.id});assert.match(packet.text,/已改组1/);assert.doesNotMatch(packet.text,/已改组2/);
});
function linkedFixture(){
 const units=['u1','u2','u3'].map(id=>({id,eventId:'e1',shots:[{id:id+'-s'}]})),draft={schemaVersion:'performance-core-v4',units,fantasyRealization:[]};
 const d={assembly:{draft,text:'base',validation:{errors:[]}},adopted:[],operations:[],candidates:[]};
 const hash=refinementAssemblyHash(d),candidate={id:'candidate',attemptId:'attempt',purpose:'director_refinement',refinement:{baseAssemblyHash:hash},draft:structuredClone(draft),output:{schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(draft),replacements:units.map(u=>({replaces:[u.id],units:[structuredClone(u)],fantasyRealization:[]})),retainedUnitIds:[]}};
 d.operations.push({attemptId:'attempt',purpose:'director_refinement',refinement:{baseAssemblyHash:hash}});d.candidates.push(candidate);return {d,candidate};
}
test('old and new fantasy links combine all replacements, including a moved realization',()=>{
 const {d,candidate}=linkedFixture();d.assembly.draft.fantasyRealization=[{candidateId:'fantasy',unitIds:['u1','u2'],shotIds:['u1-s','u2-s']}];
 candidate.draft.fantasyRealization=[{candidateId:'fantasy',unitIds:['u2','u3'],shotIds:['u2-s','u3-s']}];
 const hash=refinementAssemblyHash(d);d.operations[0].refinement.baseAssemblyHash=hash;candidate.refinement.baseAssemblyHash=hash;candidate.output.baseDraftHash=baseDraftHash(d.assembly.draft);
 const groups=getRefinementAcceptanceGroups(d,candidate);assert.equal(groups.length,1);assert.deepEqual(groups[0].replacedUnitIds,['u1','u2','u3']);assert.deepEqual(groups[0].proposedUnitIds,['u1','u2','u3']);assert.match(groups[0].reasons.join('\n'),/幻想/);
});
test('normalization that combines proposed replacements makes them one acceptance group',()=>{
 const {d,candidate}=linkedFixture();candidate.draft.units=[{...candidate.draft.units[0],shots:candidate.draft.units.slice(0,2).flatMap(u=>u.shots)},candidate.draft.units[2]];
 const groups=getRefinementAcceptanceGroups(d,candidate);assert.equal(groups.length,2);assert.deepEqual(groups[0].replacedUnitIds,['u1','u2']);assert.deepEqual(groups[0].proposedUnitIds,['u1']);
});
test('retained fantasy metadata must stay exact even if all retained units are unchanged',()=>{
 const {d}=linkedFixture(),base=d.assembly.draft;base.fantasyRealization=[{candidateId:'f',unitIds:['u3'],shotIds:['u3-s'],entry:'旧触发'}];const next=structuredClone(base);next.fantasyRealization[0].entry='被整稿候选偷改';
 assert.throws(()=>assertRefinementRetained(base,next,['u3']),e=>e.code==='REFINEMENT_SCOPE');
});
test('notes bound to a replaced old fantasy are assigned to its proved group',()=>{
 const {d,candidate}=linkedFixture();d.assembly.draft.fantasyRealization=[{candidateId:'old-fantasy',unitIds:['u1']}];d.assembly.draft.revisionNotes=[{coordinate:'old-fantasy',change:'原幻想说明'}];candidate.output.revisionNotes=[{coordinate:'old-fantasy',change:'此次幻想处理说明'}];
 const hash=refinementAssemblyHash(d);d.operations[0].refinement.baseAssemblyHash=hash;candidate.refinement.baseAssemblyHash=hash;candidate.output.baseDraftHash=baseDraftHash(d.assembly.draft);
 const groups=getRefinementAcceptanceGroups(d,candidate),selected=selectRefinementGroups(d,candidate,[groups[0].id]);
 assert.deepEqual(selected.delta.revisionNotes,candidate.output.revisionNotes);
});
test('stale sources and unresolved operations still block selected adoption atomically',async t=>{
 for(const mutate of [d=>{d.web={sourceStale:true};},d=>{d.operations.push({attemptId:'unknown',status:'unknown'});}]){
  const f=await fixture(t),ids=getRefinementAcceptanceGroups(f.ready,f.candidate).map(g=>g.id);await f.store.update('episode',d=>{mutate(d);return d;});
  await assert.rejects(f.engine.acceptRefinement('episode',f.candidate.id,basis(f),[ids[0]]),e=>['REFINEMENT_STALE','REFINEMENT_BUSY'].includes(e.code));
  const after=await f.engine.read('episode');assert.deepEqual(after.assembly,f.base.assembly);assert.equal(after.refinementArchives?.length||0,0);
 }
});
test('a partial selection with changed external state stays preview only at its retained seam',async t=>{
 const f=await fixture(t,{changeDelta:delta=>{delta.replacements[0].units[0].exitState='另一出口位置';}}),ids=getRefinementAcceptanceGroups(f.ready,f.candidate).map(g=>g.id);
 await assert.rejects(f.engine.acceptRefinement('episode',f.candidate.id,basis(f),[ids[0]]),e=>e.code==='REFINEMENT_PREVIEW_ONLY');
 assert.deepEqual((await f.engine.read('episode')).assembly,f.base.assembly);
});
test('candidate metadata without a proved group coordinate cannot enter partial adoption',async t=>{
 const f=await fixture(t,{changeDelta:delta=>{delta.revisionNotes.push({coordinate:'whole-episode',change:'未选组整包变化'});}}),ids=getRefinementAcceptanceGroups(f.ready,f.candidate).map(g=>g.id);
 await assert.rejects(f.engine.acceptRefinement('episode',f.candidate.id,basis(f),[ids[0]]),e=>e.code==='REFINEMENT_PREVIEW_ONLY');
 assert.deepEqual((await f.engine.read('episode')).assembly,f.base.assembly);
});
test('valid nonselected production feedback cannot bypass partial adoption metadata gates',async t=>{
 const f=await fixture(t,{beforeRefinement:d=>{d.production={version:'production-feedback-v1',boundary:null,materials:[],outgoingAgreements:[]};},changeDelta:delta=>{delta.productionFeedback={relation:'INDEPENDENT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[{stage:2,target:'new-prop',purpose:'未采用组缺少道具',packageIds:['p1'],sourceRefs:['s2'],blocking:false}],conflicts:[]};}}),ids=getRefinementAcceptanceGroups(f.ready,f.candidate).map(g=>g.id),before=await f.engine.read('episode');
 await assert.rejects(f.engine.acceptRefinement('episode',f.candidate.id,basis(f),[ids[0]]),e=>e.code==='REFINEMENT_PREVIEW_ONLY');
 const after=await f.engine.read('episode');assert.deepEqual(after.assembly,before.assembly);assert.deepEqual(after.production,before.production);assert.equal(after.refinementArchives?.length||0,0);
});
test('identical frozen production feedback permits partial adoption without duplicate receipts or needs',async t=>{
 const f=await fixture(t,{production:true}),groups=getRefinementAcceptanceGroups(f.ready,f.candidate),before=await f.engine.read('episode');
 const after=await f.engine.acceptRefinement('episode',f.candidate.id,basis(f),[groups[0].id]);
 assert.equal(after.candidates.at(-1).adoptedRefinement.partial,true);assert.deepEqual(after.production,before.production);
 assert.deepEqual(after.adopted.flatMap(a=>a.candidateIds),after.adopted.map(()=>f.base.adopted[0].candidateId));
});
test('a reviewed work-order error is resolved during free full adoption, never erased or re-generated',async t=>{
 const f=await fixture(t,{production:true,changeDelta:delta=>{delta.productionFeedback={...structuredClone(emptyFeedback),conflicts:[{key:'note-error',problem:'工作单笔误，候选沿用原文。',sourceRefs:['s2']}]};}});
 const review=getRefinementConflictReview(f.ready,f.candidate),ids=getRefinementAcceptanceGroups(f.ready,f.candidate).map(g=>g.id),count=f.calls.length;
 await assert.rejects(f.engine.acceptRefinement('episode',f.candidate.id,basis(f),ids),{code:'REFINEMENT_PREVIEW_ONLY'});
 await assert.rejects(f.engine.acceptRefinement('episode',f.candidate.id,basis(f),ids,{conflictHash:'0'.repeat(64),reason:'按原文'}),{code:'REFINEMENT_CONFLICT_REVIEW'});
 assert.deepEqual((await f.engine.read('episode')).assembly,f.base.assembly);
 const adopted=await f.engine.acceptRefinement('episode',f.candidate.id,basis(f),ids,{conflictHash:review.conflictHash,reason:'已逐句核对，候选保持原文；冲突仅来自工作单笔误。'});
 assert.equal(adopted.candidates.at(-1).status,'adopted');assert.equal(adopted.production.blocking,false);
 assert.deepEqual(adopted.candidates.at(-1).productionFeedback.conflicts,f.candidate.productionFeedback.conflicts);
 assert.equal(adopted.candidates.at(-1).raw,f.candidate.raw);assert.deepEqual(adopted.refinementArchives[0].assembly,f.base.assembly);
 assert.equal(f.calls.length,count);
});
test('a mixed draft that newly packs a retained unit cannot archive or adopt',async t=>{
 const f=await fixture(t,{changeDelta:delta=>{delta.replacements[0].units[0].shots[0].duration=2;delta.replacements[0].units[0].shots[0].dialogueParts[0].voiceEnd=1;delta.replacements[1].units[0].shots[0].duration=29;}}),groups=getRefinementAcceptanceGroups(f.ready,f.candidate);
 assert.equal(groups.length,2);
 await assert.rejects(f.engine.acceptRefinement('episode',f.candidate.id,basis(f),[groups[0].id]),e=>e.code==='REFINEMENT_SCOPE');
 const after=await f.engine.read('episode');assert.deepEqual(after.assembly,f.base.assembly);assert.equal(after.refinementArchives?.length||0,0);
});
test('notes on retained baseline coordinates survive while unselected candidate notes stay out',async t=>{
 const note={coordinate:'p1-pu1-3',sourceRefs:['s3'],change:'基稿已正确处理的第三单元',preservedFunction:'保留原话'};
 const f=await fixture(t,{beforeRefinement:d=>{d.assembly.draft.revisionNotes=[note];}}),groups=getRefinementAcceptanceGroups(f.ready,f.candidate);
 const after=await f.engine.acceptRefinement('episode',f.candidate.id,basis(f),[groups[0].id]);
 assert.deepEqual(after.assembly.draft.revisionNotes,[note,f.candidate.output.revisionNotes[0]]);
});
test('selecting every saved group and the legacy omitted argument both retain full adoption compatibility',async t=>{
 for(const explicit of [true,false]){
  const f=await fixture(t),groups=getRefinementAcceptanceGroups(f.ready,f.candidate),after=await f.engine.acceptRefinement('episode',f.candidate.id,basis(f),explicit?groups.map(g=>g.id):undefined);
  assert.deepEqual(after.assembly.draft,f.candidate.draft);assert.equal(after.assembly.text,f.candidate.previewText);assert.equal(after.candidates.at(-1).adoptedRefinement.partial,false);assert.equal(f.calls.length,6);
 }
});

function splitOriginalLine(d){
 const [first,second]=d.assembly.draft.units,part=first.shots[0].dialogueParts[0];
 first.shots[0].dialogueParts=[{...part,text:'第1',voiceStart:26,voiceEnd:28}];
 second.shots[0].dialogueParts=[{...part,text:'句。',voiceStart:0,voiceEnd:1},...second.shots[0].dialogueParts.map(p=>({...p,voiceStart:1}))];
 second.shots[0].sourceRefs.unshift(first.shots[0].sourceRefs[0]);
}
function addIndependentThirdReplacement(delta,base){
 const unit=structuredClone(base.units[2]);unit.shots[0].picture='独立第三组：甲保持原话抬眼。';
 delta.replacements.push({replaces:[unit.id],units:[unit],fantasyRealization:[]});delta.retainedUnitIds=delta.retainedUnitIds.filter(id=>id!==unit.id);
 delta.reviewDecisions=delta.reviewDecisions.map(n=>n.unitIds.includes(unit.id)?{...n,disposition:'changed'}:n);
}
function retainSecondReplacement(delta,base){
 const removed=delta.replacements.splice(1,1)[0];delta.retainedUnitIds.push(...removed.replaces);
 delta.reviewDecisions=delta.reviewDecisions.map(n=>n.unitIds.some(id=>removed.replaces.includes(id))?{...n,disposition:'retained'}:n);
 addIndependentThirdReplacement(delta,base);
}
test('a complete original line spanning replacements is one adoption group despite independent review decisions',async t=>{
 const f=await fixture(t,{beforeRefinement:splitOriginalLine,changeDelta:(delta,base)=>{
  delta.replacements[0].units[0].shots[0].dialogueParts[0].delivery='压低声线连说';delta.replacements[1].units[0].shots[0].dialogueParts[0].delivery='压低声线连说';addIndependentThirdReplacement(delta,base);
 }}),groups=getRefinementAcceptanceGroups(f.ready,f.candidate);
 assert.equal(groups.length,2);assert.deepEqual(groups[0].replacedUnitIds,f.ready.assembly.draft.units.slice(0,2).map(u=>u.id));assert.match(groups[0].reasons.join('\n'),/原句/);
 const adopted=await f.engine.acceptRefinement('episode',f.candidate.id,basis(f),[groups[0].id]);
 assert.deepEqual(adopted.assembly.draft.units[2],f.ready.assembly.draft.units[2]);assert.deepEqual(adopted.assembly.draft.units.slice(0,2).flatMap(u=>u.shots[0].dialogueParts.filter(p=>p.lineId===f.ready.assembly.draft.units[0].shots[0].dialogueParts[0].lineId)).map(p=>p.delivery),['压低声线连说','压低声线连说']);
});
test('an original line moving between old and new replacement ownership keeps both sides in one group',()=>{
 const {d,candidate}=linkedFixture();d.assembly.draft.units[0].shots[0].dialogueParts=[{lineId:'q1',text:'整句'}];candidate.draft.units[1].shots[0].dialogueParts=[{lineId:'q1',text:'整句'}];
 const hash=refinementAssemblyHash(d);d.operations[0].refinement.baseAssemblyHash=hash;candidate.refinement.baseAssemblyHash=hash;candidate.output.baseDraftHash=baseDraftHash(d.assembly.draft);
 const groups=getRefinementAcceptanceGroups(d,candidate);assert.equal(groups.length,2);assert.deepEqual(groups[0].replacedUnitIds,['u1','u2']);
});
test('changed speech joining a retained neighbor is blocked without silently expanding the selected group',async t=>{
 const f=await fixture(t,{beforeRefinement:splitOriginalLine,changeDelta:(delta,base)=>{retainSecondReplacement(delta,base);delta.replacements[0].units[0].shots[0].dialogueParts[0].voiceEnd=27;}}),groups=getRefinementAcceptanceGroups(f.ready,f.candidate);
 assert.equal(groups.length,2);assert.deepEqual(groups[0].replacedUnitIds,[f.ready.assembly.draft.units[0].id]);
 await assert.rejects(f.engine.acceptRefinement('episode',f.candidate.id,basis(f),[groups[0].id]),e=>e.code==='REFINEMENT_PREVIEW_ONLY'&&e.message.includes('发声'));
 const after=await f.engine.read('episode');assert.deepEqual(after.assembly,f.ready.assembly);assert.equal(after.refinementArchives?.length||0,0);assert.equal(f.calls.length,6);
});
test('explicit full and omitted selections both block changed speech crossing a retained neighbor',async t=>{
 for(const explicit of [true,false]){
  const f=await fixture(t,{beforeRefinement:splitOriginalLine,changeDelta:(delta,base)=>{retainSecondReplacement(delta,base);delta.replacements[0].units[0].shots[0].dialogueParts[0].voiceEnd=27;}}),groups=getRefinementAcceptanceGroups(f.ready,f.candidate);
  await assert.rejects(f.engine.acceptRefinement('episode',f.candidate.id,basis(f),explicit?groups.map(g=>g.id):undefined),e=>e.code==='REFINEMENT_PREVIEW_ONLY'&&e.message.includes('发声'));
  const after=await f.engine.read('episode');assert.deepEqual(after.assembly,f.ready.assembly);assert.equal(after.refinementArchives?.length||0,0);assert.equal(after.candidates.at(-1).status,'refinement_ready');assert.equal(f.calls.length,6);
 }
});
test('a purely visual replacement may retain the same safe original-line seam with an untouched neighbor',async t=>{
 const f=await fixture(t,{beforeRefinement:splitOriginalLine,changeDelta:retainSecondReplacement}),groups=getRefinementAcceptanceGroups(f.ready,f.candidate);
 assert.equal(groups.length,2);assert.deepEqual(groups[0].replacedUnitIds,[f.ready.assembly.draft.units[0].id]);
 const after=await f.engine.acceptRefinement('episode',f.candidate.id,basis(f),[groups[0].id]);assert.deepEqual(after.assembly.draft.units[1],f.ready.assembly.draft.units[1]);assert.match(after.assembly.draft.units[0].shots[0].picture,/已改组1/);assert.equal(f.calls.length,6);
});
