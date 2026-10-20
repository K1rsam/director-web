import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine,canRecheckCandidate} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {tailFixture,tailDraft} from './author-call-group-test-fixtures.mjs';
import {DELTA_VERSION,baseDraftHash} from './delta.mjs';
import {decorateDirectorRefinementRequest} from './director-refinement.mjs';
import {digest} from './shared.mjs';
import {publicRun} from '../input.mjs';

const purpose='director_refinement',skillPath='skills/director-refinement/SKILL.md';
const completed=output=>({output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{inputTokens:10,outputTokens:9,cachedInputTokens:0,totalTokens:19}});
function delta(request,{eventId='e1',invalid=false}={}){
 const base=request.previousDraft,unit=base.units.find(u=>u.eventId===eventId),next=structuredClone(unit);
 next.shots[0].picture='甲的视线先落向门口，再开口。';
 if(invalid)next.shots[0].dialogueParts[0].text='改变原话';
 return {schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(base),retainedUnitIds:base.units.filter(u=>u.id!==unit.id).map(u=>u.id),
  replacements:[{replaces:[unit.id],units:[next],fantasyRealization:[]}],revisionNotes:[{coordinate:unit.id,sourceRefs:unit.shots[0].sourceRefs,change:'明确视线落点',preservedFunction:'保留原话及既有决定'}],unresolved:[]};
}
async function seeded(t,refine=async request=>completed(delta(request))){
 const directory=await mkdtemp(path.join(tmpdir(),'director-refinement-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const calls=[],engine=createEngine({directory,modelRunner:async(request,options)=>{
  if(request.stage==='finish')request={...request,previousDraft:(await store.read('episode')).operations.find(o=>o.attemptId===options.attemptId).previousDraft};
  calls.push(request);if(options.attemptId.startsWith('refine'))return refine(request,{...options,directory});
  if(request.stage==='plan')return completed(tailFixture().plan);
  if(request.stage==='finish')return completed({schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:request.previousDraft.units.map(u=>u.id),replacements:[],revisionNotes:[],unresolved:[]});
  return completed(tailDraft(request));
 }}),store=createStore(directory),f=tailFixture();
 await engine.create({id:'episode',source:f.source,settings:f.settings});
 // This v1 refinement fixture also predates complete-result production receipts.
 await store.update('episode',d=>{d.rulesSnapshot.directorRefinementVersion='director-refinement-v1';d.rulesSnapshot.productionFeedbackResultVersion='production-feedback-result-v1';d.rulesSnapshot.files[skillPath]='冻结导演精修规则：保留原话，仅处理所选事件。';return d;});
 await engine.execute('episode',{stage:'plan',attemptId:'plan'});
 for(const packageId of ['p1','p2','p3'])await engine.execute('episode',{stage:'author',packageId,attemptId:`author-${packageId}`});
 await engine.execute('episode',{stage:'finish',finishMode:'delta',packageIds:['p1','p2','p3'],attemptId:'base-finish'});
 const baseline=await engine.assemble('episode');assert.equal(baseline.status,'text_ready_for_review');
 return {engine,store,directory,calls,baseline};
}
const execute=engine=>engine.execute('episode',{stage:'finish',finishMode:'delta',purpose,refinementEventIds:['e1'],packageIds:['p1','p2','p3'],attemptId:'refine-once'});

test('invalid work-order output cannot crash reading or expose unrecognized fields in the public view',async t=>{
 const {engine}=await seeded(t),d=await execute(engine),c=d.candidates.at(-1);
 const valid={unitIds:[d.assembly.draft.units[0].id],disposition:'retained',reason:'当前听者反应有效',preservedFunction:'保留完整原话'};
 c.output.reviewDecisions=[null,{unitIds:'not-an-array'}, {...valid,reason:[]}, {...valid,disposition:'unknown'}, {...valid,privateTrace:'not-for-public'}];
 const before=structuredClone(d),view=publicRun(d);
 assert.deepEqual(view.candidates.at(-1).refinement.reviewDecisions,[valid]);assert.deepEqual(d,before);
});

test('refinement saves a separate candidate while preserving the complete accepted baseline',async t=>{
 const {engine,baseline,calls}=await seeded(t);const ready=await execute(engine),candidate=ready.candidates.at(-1);
 assert.deepEqual(ready.assembly,baseline.assembly);assert.deepEqual(ready.adopted,baseline.adopted);assert.equal(ready.status,'text_ready_for_review');
 assert.equal(candidate.status,'refinement_ready');assert.equal(candidate.purpose,purpose);assert.equal(candidate.draft.units[0].shots[0].picture,'甲的视线先落向门口，再开口。');
 assert.deepEqual(candidate.draft.units.filter(u=>u.eventId!=='e1'),baseline.assembly.draft.units.filter(u=>u.eventId!=='e1'));
 assert.equal(calls.at(-1).stage,'finish');assert.equal(calls.at(-1).finishMode,'delta');assert.match(calls.at(-1).prompt,/冻结导演精修规则/);
 assert.ok(!calls.at(-1).loadedFiles.some(f=>f.path==='skills/episode-finishing-editor/SKILL.md'));assert.ok(calls.at(-1).loadedFiles.some(f=>f.path===skillPath));
 assert.ok(calls.filter(r=>r.purpose!==purpose).every(r=>!r.loadedFiles.some(f=>f.path===skillPath)));
 await assert.rejects(execute(engine),e=>['REFINEMENT_LIMIT','ATTEMPT_EXISTS'].includes(e.code));
 await assert.rejects(engine.execute('episode',{stage:'finish',finishMode:'delta',purpose,refinementEventIds:['e2'],packageIds:['p1','p2','p3'],attemptId:'refine-twice'}),e=>e.code==='REFINEMENT_LIMIT');
});

test('successful free recheck resolves the old invalid candidate and cannot clone it repeatedly',async t=>{
 const {engine,store,calls,baseline}=await seeded(t),ready=await execute(engine),id=ready.candidates.at(-1).id,count=calls.length;
 await store.update('episode',d=>{const c=d.candidates.find(c=>c.id===id);c.status='refinement_invalid';c.errors=[{code:'OLD_RECEIVER',message:'旧接收器误报'}];return d;});
 const checked=await engine.recheckCandidate('episode',id),derived=checked.candidates.at(-1),original=checked.candidates.find(c=>c.id===id);
 assert.equal(derived.status,'refinement_ready');assert.equal(original.resolvedBy,derived.id);assert.equal(derived.derivedFrom,id);
 assert.equal(canRecheckCandidate(checked,original),false);assert.deepEqual(checked.assembly,baseline.assembly);assert.equal(calls.length,count);
 assert.equal(publicRun(checked).candidates.at(-1).derivedFrom,id);
 await assert.rejects(engine.recheckCandidate('episode',id),{code:'RECHECK_INELIGIBLE'});
 assert.deepEqual(await engine.read('episode'),checked);
});

test('an unsuccessful free recheck does not falsely resolve the original source-fidelity error',async t=>{
 const {engine,calls,baseline}=await seeded(t,async request=>completed(delta(request,{invalid:true}))),ready=await execute(engine),original=ready.candidates.at(-1),count=calls.length;
 const checked=await engine.recheckCandidate('episode',original.id);
 assert.equal(checked.candidates.at(-1).status,'refinement_invalid');assert.equal(checked.candidates.find(c=>c.id===original.id).resolvedBy,undefined);
 assert.deepEqual(checked.assembly,baseline.assembly);assert.equal(calls.length,count);
});

test('free adoption checks the baseline hash and archives the exact original draft',async t=>{
 const {engine,baseline,calls}=await seeded(t),ready=await execute(engine),candidate=ready.candidates.at(-1),count=calls.length;
 assert.equal(typeof engine.acceptRefinement,'function');
 await assert.rejects(engine.acceptRefinement('episode',candidate.id,'wrong-hash'),e=>e.code==='REFINEMENT_STALE');
 const adopted=await engine.acceptRefinement('episode',candidate.id,ready.operations.at(-1).refinement.baseAssemblyHash);
 assert.equal(adopted.candidates.at(-1).status,'adopted');assert.equal(adopted.assembly.draft.units[0].shots[0].picture,'甲的视线先落向门口，再开口。');
 assert.deepEqual(adopted.refinementArchives[0].assembly,baseline.assembly);assert.deepEqual(adopted.refinementArchives[0].adopted,baseline.adopted);assert.equal(calls.length,count);
 await assert.rejects(engine.acceptRefinement('episode',candidate.id,ready.operations.at(-1).refinement.baseAssemblyHash),e=>e.code==='REFINEMENT_STALE');
});

test('source fidelity failures remain optional invalid candidates and never replace the ready baseline',async t=>{
 const {engine,baseline}=await seeded(t,async request=>completed(delta(request,{invalid:true}))),d=await execute(engine),c=d.candidates.at(-1);
 assert.equal(c.status,'refinement_invalid');assert.ok(c.validation.errors.some(e=>e.code==='DIALOGUE_CONTENT'));assert.deepEqual(d.assembly,baseline.assembly);assert.deepEqual(d.adopted,baseline.adopted);
 assert.equal(d.status,'text_ready_for_review');
});

test('a replacement outside the selected event is rejected without changing accepted work',async t=>{
 const {engine,baseline}=await seeded(t,async request=>completed(delta(request,{eventId:'e2'}))),d=await execute(engine);
 assert.equal(d.candidates.at(-1).status,'refinement_invalid');assert.equal(d.candidates.at(-1).errors[0].code,'REFINEMENT_SCOPE');assert.deepEqual(d.assembly,baseline.assembly);
});

test('a saved timeout response recovers with its frozen request and no second model call',async t=>{
 const {engine,store,baseline,calls}=await seeded(t,async(request,{directory,attemptId})=>{
  const raw=JSON.stringify(delta(request)),folder=path.join(directory,'attempts',attemptId);await mkdir(folder,{recursive:true});
  await writeFile(path.join(folder,'raw.txt'),raw);await writeFile(path.join(folder,'request.json'),JSON.stringify(request));
  await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED',usage:{totalTokens:19}}));
  throw Object.assign(new Error('saved timeout'),{code:'TIMEOUT',requestOutcome:'RESPONDED',raw,usage:{totalTokens:19}});
 });
 await assert.rejects(execute(engine),e=>e.code==='TIMEOUT');const saved=await engine.read('episode'),fingerprint=saved.operations.at(-1).fingerprint;
 await store.update('episode',d=>{d.rulesSnapshot.files[skillPath]='后来编辑的规则不能改写旧请求';return d;});
 const restored=await engine.recover('episode','refine-once');assert.equal(restored.candidates.at(-1).status,'refinement_ready');assert.equal(restored.operations.at(-1).fingerprint,fingerprint);
 assert.deepEqual(restored.assembly,baseline.assembly);assert.deepEqual(restored.adopted,baseline.adopted);assert.equal(calls.length,6);
 assert.deepEqual(await engine.recover('episode','refine-once'),restored);
});

test('unknown usage stays unknown while the candidate and baseline remain available',async t=>{
 const {engine,baseline}=await seeded(t,async request=>({...completed(delta(request)),usage:null})),d=await execute(engine);
 assert.equal(d.candidates.at(-1).status,'refinement_ready');assert.equal(d.operations.at(-1).receipt.usage,null);assert.deepEqual(d.assembly,baseline.assembly);
});

test('an in-flight baseline change makes the refinement stale without replacing the newer baseline',async t=>{
 let release,started;const began=new Promise(r=>started=r),wait=new Promise(r=>release=r);
 const {engine,store}=await seeded(t,async request=>{started();await wait;return completed(delta(request));});
 const running=execute(engine);await began;await store.update('episode',d=>{d.assembly.text='较新的已采用正文';return d;});release();const d=await running;
 assert.equal(d.candidates.at(-1).status,'refinement_stale');assert.equal(d.assembly.text,'较新的已采用正文');
});

test('cross-episode production candidates stay preview only when safe propagation is not established',async t=>{
 const {engine,store,baseline}=await seeded(t);await store.update('episode',d=>{d.web={binding:{productionChain:{mode:'CHAIN'}}};return d;});
 const d=await execute(engine),c=d.candidates.at(-1);assert.equal(c.status,'refinement_ready');assert.equal(c.adoptionBlocked?.code,'REFINEMENT_PREVIEW_ONLY');
 await assert.rejects(engine.acceptRefinement('episode',c.id,d.operations.at(-1).refinement.baseAssemblyHash),e=>e.code==='REFINEMENT_PREVIEW_ONLY');assert.deepEqual((await engine.read('episode')).assembly,baseline.assembly);
});

test('noncontiguous events are refused before dispatch',async t=>{
 const {engine,calls}=await seeded(t),count=calls.length;
 await assert.rejects(engine.execute('episode',{stage:'finish',finishMode:'delta',purpose,refinementEventIds:['e1','e3'],packageIds:['p1','p2','p3'],attemptId:'refine-bad-scope'}),e=>e.code==='REFINEMENT_SCOPE');assert.equal(calls.length,count);
});

test('normalization cannot merge a replacement into a unit declared retained',async t=>{
 const {engine,baseline}=await seeded(t,async request=>{
  const output=delta(request),shot=output.replacements[0].units[0].shots[0];shot.duration=1;shot.dialogueParts[0].voiceEnd=0.9;return completed(output);
 }),d=await execute(engine);
 assert.equal(d.candidates.at(-1).status,'refinement_invalid');assert.equal(d.candidates.at(-1).errors[0].code,'REFINEMENT_SCOPE');assert.deepEqual(d.assembly,baseline.assembly);
});

test('unknown outcomes keep the baseline and cannot issue a second refinement',async t=>{
 const {engine,baseline,calls}=await seeded(t,async()=>{throw Object.assign(new Error('unknown timeout'),{code:'TIMEOUT',requestOutcome:'UNKNOWN'});});
 await assert.rejects(execute(engine),e=>e.code==='TIMEOUT');const d=await engine.read('episode');assert.equal(d.operations.at(-1).status,'unknown');assert.equal(d.operations.at(-1).receipt.usage,null);assert.deepEqual(d.assembly,baseline.assembly);
 await assert.rejects(engine.execute('episode',{stage:'finish',finishMode:'delta',purpose,refinementEventIds:['e1'],packageIds:['p1','p2','p3'],attemptId:'refine-again'}),e=>['SCOPE_BUSY','REFINEMENT_BUSY'].includes(e.code));assert.equal(calls.length,6);
});

test('final adoption validates saved output again and preserves the baseline on failure',async t=>{
 const {engine,store,baseline,calls}=await seeded(t),d=await execute(engine),c=d.candidates.at(-1),count=calls.length;
 await store.update('episode',run=>{run.candidates.at(-1).output.replacements[0].units[0].shots[0].dialogueParts[0].text='篡改已保存候选';return run;});
 await assert.rejects(engine.acceptRefinement('episode',c.id,d.operations.at(-1).refinement.baseAssemblyHash),e=>e.code==='REFINEMENT_INVALID');assert.deepEqual((await engine.read('episode')).assembly,baseline.assembly);assert.equal(calls.length,count);
});

test('a new production conflict stays a preview and cannot replace a stable single-episode baseline',async t=>{
 const {engine,store,baseline}=await seeded(t,async request=>completed({...delta(request),productionFeedback:{relation:'INDEPENDENT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[{key:'prop',problem:'所需道具缺少可靠材料',sourceRefs:['s1']} ]}}));
 await store.update('episode',d=>{d.production={version:'production-feedback-v1',boundary:null,materials:[],outgoingAgreements:[]};return d;});
 const d=await execute(engine),c=d.candidates.at(-1);assert.equal(c.status,'refinement_ready');assert.equal(c.adoptionBlocked?.code,'REFINEMENT_PREVIEW_ONLY');
 await assert.rejects(engine.acceptRefinement('episode',c.id,d.operations.at(-1).refinement.baseAssemblyHash),e=>e.code==='REFINEMENT_PREVIEW_ONLY');assert.deepEqual((await engine.read('episode')).assembly,baseline.assembly);
});

test('selected events use the same model coordinate namespace as the frozen full request',()=>{
 const eventId='event-original-identity-longer-than-28',body='冻结精修规则',refinement={version:'director-refinement-v1',baseAssemblyHash:'assembly',baseDraftHash:'draft',eventIds:[eventId],skill:{path:skillPath,body,hash:digest(body)}};
 const request={stage:'finish',finishMode:'delta',baseDraftHash:'draft',prompt:'base',inputHash:'input',modelCoordinates:{aliases:{R0001:eventId}},snapshot:[],loadedFiles:[]};
 const decorated=decorateDirectorRefinementRequest(request,refinement),contract=JSON.parse(decorated.prompt.split('【本次精修边界】\n')[1].split('\n')[0]);
 assert.deepEqual(contract.eventIds,['R0001']);assert.deepEqual(refinement.eventIds,[eventId]);
});

test('an unchanged saved refinement is visible as unchanged and cannot mutate adoption lineage',async t=>{
 const {engine,baseline,calls}=await seeded(t,async request=>completed({schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(request.previousDraft),retainedUnitIds:request.previousDraft.units.map(u=>u.id),replacements:[],revisionNotes:[],unresolved:[]}));
 const d=await execute(engine),c=d.candidates.at(-1),count=calls.length,view=publicRun(d);
 assert.equal(view.candidates.at(-1).refinement.comparison.status,'unchanged');
 assert.equal(view.seriesDirectionStatus,'not_adopted');assert.ok(view.refinement.scope.events[0].shotCount>0);
 await assert.rejects(engine.acceptRefinement('episode',c.id,d.operations.at(-1).refinement.baseAssemblyHash),e=>e.code==='REFINEMENT_UNCHANGED');
 const after=await engine.read('episode');assert.deepEqual(after.assembly,baseline.assembly);assert.deepEqual(after.adopted,baseline.adopted);assert.equal(after.refinementArchives?.length||0,0);assert.equal(calls.length,count);
});
