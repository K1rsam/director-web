import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCoordinator} from './coordinator.mjs';
import {createStore} from './core/store.mjs';
import {tailFixture,tailDraft} from './core/author-call-group-test-fixtures.mjs';
import {DELTA_VERSION} from './core/delta.mjs';
import {refinementAssemblyHash} from './core/director-refinement.mjs';
function retainedRefinement(request,op){
 const output={schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:op.previousDraft.units.map(u=>u.id),replacements:[],revisionNotes:[],unresolved:[]};
 if(op.refinement.version==='director-refinement-v2')output.reviewDecisions=op.refinement.unitIds.map(id=>({unitIds:[id],disposition:'retained',reason:'完整原句与现有观看切点可连续执行，未发现更强且守源的局部演法。',preservedFunction:'原话、近脸决定与连续动作保持。'}));
 if(op.refinement.version==='director-refinement-v3')output.reviewDecisions=[];
 return output;
}
function changedRefinement(request,op,unitId=op.refinement.unitIds?.[0]??op.previousDraft.units[0].id){
 const output=retainedRefinement(request,op),old=op.previousDraft.units.find(u=>u.id===unitId),unit=structuredClone(old);
 unit.id=`${old.id}-refined`;unit.shots[0].picture='甲眉间舒开，随抬眼将目光转向门口，清楚作出决定。';
 output.retainedUnitIds=output.retainedUnitIds.filter(id=>id!==old.id);
 output.replacements=[{replaces:[old.id],units:[unit],fantasyRealization:[]}];
 output.revisionNotes=[{coordinate:old.shots[0].id,sourceRefs:old.shots[0].sourceRefs,change:'眉眼舒展与转向门口共时，决定的观看对象明确。',preservedFunction:'保留原话、近脸决定及原有声窗和切点。'}];
 if(op.refinement.version==='director-refinement-v3')output.reviewDecisions=[{unitIds:[old.id],disposition:'changed',reason:'决定缺少观看对象→补出眉眼舒展与转向门口的同相位动作。',preservedFunction:'保留原话、近脸决定及原有声窗和切点。'}];
 else if(output.reviewDecisions)output.reviewDecisions=output.reviewDecisions.map(decision=>decision.unitIds.includes(old.id)?{...decision,disposition:'changed',reason:'用具体目光转向承接决定，原句及有效切点不变。'}:decision);
 return output;
}
const response=output=>({output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{totalTokens:10}});
const requestContract=request=>JSON.parse(request.prompt.split('【本次精修边界】\n')[1].split('\n')[0]);
async function fixture(t,runner,{refinementVersion='director-refinement-v2'}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'director-refinement-coordinator-')),store=createStore(dir),calls=[];
 const service=createCoordinator({dataRoot:dir,modelRunner:async(request,options)=>{
  calls.push(request);const d=await store.read(options.runId),op=d.operations.find(o=>o.attemptId===options.attemptId);
  if(request.purpose&&runner)return runner(request,op);
  const output=request.purpose?retainedRefinement(request,op):request.stage==='plan'?tailFixture().plan:request.stage==='finish'?{schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:op.previousDraft.units.map(u=>u.id),replacements:[],revisionNotes:[],unresolved:[]}:tailDraft(request);
  return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{totalTokens:10}};
 }});
 t.after(async()=>{await service.shutdown();await rm(dir,{recursive:true,force:true});});
 const f=tailFixture(),d=await service.create({source:f.source,settings:f.settings,binding:{projectId:'p',episodeId:'e',sourceVersion:'v'}});
 // Historical tests deliberately keep their frozen v2 output contract.
 await store.update(d.id,saved=>{saved.rulesSnapshot.directorRefinementVersion=refinementVersion;return saved;});
 await service.start(d.id,{mode:'all'});const baseline=await service.wait(d.id);assert.equal(baseline.status,'text_ready_for_review');
 return {service,calls,baseline,store};
}
const options=d=>({eventIds:['e1'],expectedBaseHash:refinementAssemblyHash(d)});
test('an unchanged refinement dispatches once, records retention and cannot rewrite adoption history',async t=>{
 const {service,calls,baseline,store}=await fixture(t),before=calls.length;
 assert.equal(typeof service.refine,'function');await service.refine(baseline.id,options(baseline));const ready=await service.wait(baseline.id);
 assert.equal(calls.length,before+1);assert.equal(calls.at(-1).purpose,'director_refinement');
 assert.deepEqual(ready.assembly,baseline.assembly);assert.equal(ready.status,'text_ready_for_review');assert.equal(ready.web.progress,'text_ready_for_review');
 assert.equal(ready.candidates.at(-1).status,'refinement_ready');
 assert.ok(ready.candidates.at(-1).output.reviewDecisions.every(d=>d.disposition==='retained'));
 assert.deepEqual(ready.adopted,baseline.adopted);
 await assert.rejects(service.refine(ready.id,options(ready)),e=>e.code==='REFINEMENT_LIMIT');assert.equal(calls.length,before+1);
 await assert.rejects(service.acceptRefinement(ready.id,ready.candidates.at(-1).id,options(ready).expectedBaseHash),e=>e.code==='REFINEMENT_UNCHANGED');
 const kept=await store.read(ready.id);assert.equal(calls.length,before+1);assert.equal(kept.refinementArchives?.length??0,0);assert.deepEqual(kept.adopted,baseline.adopted);assert.deepEqual(kept.assembly,baseline.assembly);
});
test('free adoption uses a changed local picture and preserves every unit outside the selected unit',async t=>{
 const {service,calls,baseline}=await fixture(t,async(request,op)=>response(changedRefinement(request,op))),before=calls.length;
 const selected=baseline.assembly.draft.units[0].id,selection={...options(baseline),unitIds:[selected]};
 await service.refine(baseline.id,selection);const ready=await service.wait(baseline.id);
 assert.equal(calls.length,before+1);assert.equal(ready.candidates.at(-1).status,'refinement_ready');assert.deepEqual(ready.assembly,baseline.assembly);
 const adopted=await service.acceptRefinement(ready.id,ready.candidates.at(-1).id,selection.expectedBaseHash);
 assert.equal(calls.length,before+1);assert.equal(adopted.refinementArchives.length,1);assert.notDeepEqual(adopted.assembly,baseline.assembly);
 assert.equal(adopted.assembly.validation.errors.length,0);
 assert.deepEqual(adopted.assembly.draft.units[0].shots[0].dialogueParts,baseline.assembly.draft.units[0].shots[0].dialogueParts);
 assert.deepEqual(adopted.assembly.draft.units.slice(1),baseline.assembly.draft.units.slice(1));
 assert.deepEqual(adopted.refinementArchives[0].assembly,baseline.assembly);
 await assert.rejects(service.refine(adopted.id,options(adopted)),e=>e.code==='REFINEMENT_LIMIT');assert.equal(calls.length,before+1);
});
test('posted unit selection and work-order notes reach the frozen operation and model request',async t=>{
 const {service,calls,baseline}=await fixture(t),selected=baseline.assembly.draft.units[1].id,before=calls.length;
 const reviewNotes='  只核完整反问是否因切镜而摊慢。  ',preserveNotes='  保住听者切镜，其他单元原样保留。  ';
 await service.refine(baseline.id,{...options(baseline),unitIds:[selected],reviewNotes,preserveNotes});const ready=await service.wait(baseline.id),op=ready.operations.at(-1),request=calls.at(-1),contract=requestContract(request);
 assert.equal(calls.length,before+1);assert.equal(ready.candidates.at(-1).status,'refinement_ready');
 assert.deepEqual(op.refinement.unitIds,[selected]);assert.deepEqual(op.refinement.workOrder,{version:'refinement-work-order-v1',reviewNotes:reviewNotes.trim(),preserveNotes:preserveNotes.trim()});
 assert.deepEqual(contract.unitIds.map(id=>request.modelCoordinates?.aliases?.[id]??id),[selected]);assert.deepEqual(contract.workOrder,op.refinement.workOrder);assert.equal(contract.scopeSummary.unitCount,1);assert.equal(contract.scopeSummary.wholeEpisode,false);
 assert.ok(request.schema.required.includes('reviewDecisions'));assert.deepEqual(ready.assembly,baseline.assembly);
 assert.ok(calls.filter(c=>c.stage==='finish'&&!c.purpose).every(c=>!c.schema.required.includes('reviewDecisions')));
});
test('refinement rejects stale UI and stops at the original call budget without sending',async t=>{
 const {service,calls,baseline}=await fixture(t),before=calls.length;
 await assert.rejects(service.refine(baseline.id,{...options(baseline),expectedBaseHash:'stale'}),e=>e.code==='REFINEMENT_STALE');
 await service.setBudget(baseline.id,{maxCalls:before,maxTokens:300000});
 const stopped=await service.refine(baseline.id,options(baseline));assert.equal(stopped.web.progress,'budget_stop');assert.equal(calls.length,before);assert.deepEqual(stopped.assembly,baseline.assembly);
});
test('a malformed refinement does not enter normal automatic repair or discard the baseline',async t=>{
 const {service,calls,baseline}=await fixture(t,async()=>({output:{broken:true},raw:'{"broken":true}',requestOutcome:'RESPONDED',usage:{totalTokens:10}})),before=calls.length;
 await service.refine(baseline.id,options(baseline));const ready=await service.wait(baseline.id);
 assert.equal(calls.length,before+1);assert.deepEqual(ready.assembly,baseline.assembly);assert.equal(ready.web.autoRepairs,baseline.web.autoRepairs);assert.equal(ready.candidates.at(-1).status,'refinement_invalid');
});
test('unknown refinement usage preserves paid results and blocks a new paid attempt',async t=>{
 const {service,calls,baseline}=await fixture(t,async()=>{throw Object.assign(new Error('timeout'),{code:'TIMEOUT',requestOutcome:'UNKNOWN'});}),before=calls.length;
 await service.refine(baseline.id,options(baseline));const unknown=await service.wait(baseline.id);
 assert.equal(calls.length,before+1);assert.deepEqual(unknown.assembly,baseline.assembly);assert.equal(unknown.web.progress,'unknown');
 await assert.rejects(service.refine(baseline.id,options(baseline)),e=>['REFINEMENT_BASE_REQUIRED','REFINEMENT_BUSY','REFINEMENT_LIMIT'].includes(e.code));assert.equal(calls.length,before+1);
});
test('free adoption preserves the unknown-usage attention state and cannot issue another paid refinement',async t=>{
 const {service,calls,baseline}=await fixture(t,async(request,op)=>({...response(changedRefinement(request,op)),usage:null}));
 await service.refine(baseline.id,options(baseline));const ready=await service.wait(baseline.id),before=calls.length;
 assert.equal(ready.web.progress,'usage_review');assert.equal(ready.candidates.at(-1).status,'refinement_ready');const adopted=await service.acceptRefinement(ready.id,ready.candidates.at(-1).id,options(ready).expectedBaseHash);
 assert.equal(adopted.web.progress,'usage_review');assert.equal(adopted.web.error.code,'USAGE_UNKNOWN');assert.equal(calls.length,before);
 assert.notDeepEqual(adopted.assembly,baseline.assembly);assert.equal(adopted.refinementArchives.length,1);
 await assert.rejects(service.refine(adopted.id,options(adopted)),e=>['REFINEMENT_BASE_REQUIRED','REFINEMENT_BUSY','REFINEMENT_LIMIT'].includes(e.code));assert.equal(calls.length,before);
});
test('a proven NOT_SENT optional request can be explicitly retried without reopening ordinary production',async t=>{
 let first=true;const {service,calls,baseline}=await fixture(t,async(request,op)=>{
  if(first){first=false;throw Object.assign(new Error('local unavailable'),{code:'LOCAL_UNAVAILABLE',requestOutcome:'NOT_SENT'});}
  return response(retainedRefinement(request,op));
 });
 await service.refine(baseline.id,options(baseline));const failed=await service.wait(baseline.id);assert.equal(failed.operations.at(-1).error.requestOutcome,'NOT_SENT');
 const before=calls.length;await service.refine(failed.id,options(failed));const ready=await service.wait(failed.id);assert.equal(calls.length,before+1);assert.equal(ready.candidates.at(-1).status,'refinement_ready');assert.deepEqual(ready.assembly,baseline.assembly);
});
test('refinement cannot change an unselected unit even when it belongs to the same selected event',async t=>{
 const {service,calls,baseline}=await fixture(t,async(request,op)=>response(changedRefinement(request,op,op.previousDraft.units[1].id))),before=calls.length;
 await service.refine(baseline.id,{...options(baseline),unitIds:[baseline.assembly.draft.units[0].id]});const ready=await service.wait(baseline.id);
 assert.equal(calls.length,before+1);assert.equal(ready.candidates.at(-1).status,'refinement_invalid');assert.ok(ready.candidates.at(-1).errors.some(e=>e.code==='REFINEMENT_SCOPE'));
 assert.deepEqual(ready.assembly,baseline.assembly);assert.deepEqual(ready.adopted,baseline.adopted);assert.equal(ready.web.autoRepairs,baseline.web.autoRepairs);
});
for(const omission of ['missing','incomplete','duplicate'])test(`${omission} review decisions preserve the baseline without another paid repair`,async t=>{
 const {service,calls,baseline}=await fixture(t,async(request,op)=>{
  const output=retainedRefinement(request,op);
  if(omission==='missing')delete output.reviewDecisions;
  else if(omission==='incomplete')output.reviewDecisions.pop();
  else output.reviewDecisions.push(structuredClone(output.reviewDecisions[0]));
  return response(output);
 }),before=calls.length;
 await service.refine(baseline.id,options(baseline));const ready=await service.wait(baseline.id);
 assert.equal(calls.length,before+1);assert.equal(ready.candidates.at(-1).status,'refinement_invalid');assert.ok(ready.candidates.at(-1).errors.some(e=>e.code==='REFINEMENT_REVIEW'));
 assert.deepEqual(ready.assembly,baseline.assembly);assert.deepEqual(ready.adopted,baseline.adopted);assert.equal(ready.web.autoRepairs,baseline.web.autoRepairs);
 await assert.rejects(service.refine(ready.id,options(ready)),e=>e.code==='REFINEMENT_LIMIT');assert.equal(calls.length,before+1);
});
test('frozen v1 tasks retain their event contract without mandatory review decisions',async t=>{
 const {service,calls,baseline,store}=await fixture(t,async(request,op)=>response(changedRefinement(request,op))),before=calls.length;
 const legacy=await store.update(baseline.id,d=>{d.rulesSnapshot.directorRefinementVersion='director-refinement-v1';d.rulesSnapshot.files['skills/director-refinement/SKILL.md']='# Frozen v1 event refinement\nReturn the original delta contract; selected events only.';return d;});
 await assert.rejects(service.refine(legacy.id,{...options(legacy),unitIds:[legacy.assembly.draft.units[0].id]}),e=>e.code==='REFINEMENT_RULES');assert.equal(calls.length,before);
 await service.refine(legacy.id,options(legacy));const ready=await service.wait(legacy.id),request=calls.at(-1),contract=requestContract(request);
 assert.equal(calls.length,before+1);assert.equal(ready.candidates.at(-1).status,'refinement_ready');assert.equal(contract.version,'director-refinement-v1');assert.equal(contract.unitIds,undefined);assert.equal(contract.workOrder,undefined);
 assert.equal(request.schema.required.includes('reviewDecisions'),false);assert.equal(ready.candidates.at(-1).output.reviewDecisions,undefined);
 const adopted=await service.acceptRefinement(ready.id,ready.candidates.at(-1).id,options(ready).expectedBaseHash);assert.equal(calls.length,before+1);assert.equal(adopted.refinementArchives.length,1);
});

test('v3 scans the whole episode and adopts a real late-event change without touching unaffected work',async t=>{
 const {service,calls,baseline}=await fixture(t,async(request,op)=>response(changedRefinement(request,op,op.previousDraft.units.at(-1).id)),{refinementVersion:'director-refinement-v3'}),before=calls.length;
 const expectedBaseHash=refinementAssemblyHash(baseline);
 await service.refine(baseline.id,{expectedBaseHash});const ready=await service.wait(baseline.id),candidate=ready.candidates.at(-1),request=calls.at(-1);
 assert.equal(candidate.status,'refinement_ready');assert.equal(calls.length,before+1);
 assert.deepEqual(ready.operations.at(-1).refinement.eventIds,['e1','e2','e3']);assert.equal(requestContract(request).scopeSummary.wholeEpisode,true);
 assert.equal(request.loadedFiles.length,1);assert.equal(candidate.output.reviewDecisions.length,1);assert.equal(candidate.output.reviewDecisions[0].disposition,'changed');
 assert.deepEqual(ready.assembly,baseline.assembly,'a proposed improvement never overwrites the baseline');
 const adopted=await service.acceptRefinement(ready.id,candidate.id,expectedBaseHash);
 assert.equal(calls.length,before+1,'adoption does not call AI');assert.equal(adopted.assembly.validation.errors.length,0);
 assert.deepEqual(adopted.assembly.draft.units.slice(0,-1),baseline.assembly.draft.units.slice(0,-1));
 assert.deepEqual(adopted.assembly.draft.units.at(-1).shots[0].dialogueParts,baseline.assembly.draft.units.at(-1).shots[0].dialogueParts);
 assert.deepEqual(adopted.refinementArchives[0].assembly,baseline.assembly);assert.match(adopted.assembly.text,/甲眉间舒开/);
});
test('v3 no-op is no improvement, not a successful refinement, and never launches another paid pass',async t=>{
 const {service,calls,baseline}=await fixture(t,undefined,{refinementVersion:'director-refinement-v3'}),before=calls.length;
 await service.refine(baseline.id,{expectedBaseHash:refinementAssemblyHash(baseline)});const ready=await service.wait(baseline.id);
 assert.equal(calls.length,before+1);assert.equal(ready.candidates.at(-1).status,'refinement_no_change');assert.deepEqual(ready.assembly,baseline.assembly);
 assert.deepEqual(ready.candidates.at(-1).output.reviewDecisions,[]);assert.equal(ready.web.autoRepairs,baseline.web.autoRepairs);
 await assert.rejects(service.refine(ready.id,{expectedBaseHash:refinementAssemblyHash(ready)}),e=>e.code==='REFINEMENT_LIMIT');assert.equal(calls.length,before+1);
});
