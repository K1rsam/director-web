import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine,rebuildFrozenRequest} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {tailFixture,tailDraft} from './author-call-group-test-fixtures.mjs';
import {DELTA_VERSION,baseDraftHash} from './delta.mjs';
import {getRefinementAcceptanceGroups} from './refinement-adoption.mjs';
import {DIALOGUE_SOURCE_LINK_VERSION} from './quality.mjs';

const packages=['p1','p2','p3'],purpose='director_refinement';
const links=candidate=>(candidate.normalizations||[]).filter(c=>c.reason==='verified_dialogue_source_link');
const deltaFor=base=>({schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(base),retainedUnitIds:base.units.map(u=>u.id),replacements:[],revisionNotes:[],unresolved:[]});

async function fixture(t,{ordinaryLink=false,legacy=false,plannedOnly=false,mergeRetained=false,crossEvent=false}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'dialogue-link-flow-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const calls=[],outputs=new Map(),store=createStore(directory),f=tailFixture();
 const engine=createEngine({directory,modelRunner:async(request,{attemptId})=>{
  calls.push({attemptId,stage:request.stage,purpose:request.purpose});
  const d=await store.read('episode'),base=d.operations.find(o=>o.attemptId===attemptId)?.previousDraft;
  let output;
  if(request.stage==='plan')output=structuredClone(f.plan);
  else if(request.stage==='author'){
   output=tailDraft(request);
   if(ordinaryLink&&request.packageIds.includes('p1'))output.units[0].shots[0].sourceRefs=['s2'];
  }else{
   output=deltaFor(base);
   if(request.purpose===purpose){
    const chosen=base.units.filter(u=>u.eventId==='e1').slice(0,2);
    if(crossEvent)chosen.push(base.units.find(u=>u.eventId==='e2'));
    for(const [i,unit] of chosen.entries()){
     const next=structuredClone(unit);
     next.shots[0].picture=`已改组${i+1}：甲先落眼，仍完整说出原话。`;
     next.shots[0].sourceRefs=unit.eventId==='e1'?['s3']:['s5'];
     if(mergeRetained&&i<2){next.shots[0].duration=i?29:2;next.shots[0].dialogueParts[0].voiceEnd=i?28:1;}
     output.replacements.push({replaces:[unit.id],units:[next],fantasyRealization:[]});
     output.revisionNotes.push({coordinate:unit.id,sourceRefs:[...next.shots[0].sourceRefs],change:`组${i+1}明确视线落点`,preservedFunction:'原句、声道及事件边界不变'});
     output.retainedUnitIds=output.retainedUnitIds.filter(id=>id!==unit.id);
    }
    output.reviewDecisions=chosen.map(u=>({unitIds:[u.id],disposition:'changed',reason:'明确视线先后，保留完整原句',preservedFunction:'原话与决定落点'}));
   }else if(ordinaryLink){
    const next=structuredClone(base.units[0]);next.shots[0].sourceRefs=['s2'];
    output.retainedUnitIds=output.retainedUnitIds.filter(id=>id!==next.id);
    output.replacements=[{replaces:[next.id],units:[next],fantasyRealization:[]}];
   }
  }
  const raw=JSON.stringify(output);outputs.set(attemptId,{output:structuredClone(output),raw});
  return {output,raw,requestOutcome:'RESPONDED',usage:{totalTokens:1}};
 }});
 await engine.create({id:'episode',source:f.source,settings:f.settings});
 if(legacy)await store.update('episode',d=>{delete d.rulesSnapshot.dialogueSourceLinkVersion;return d;});
 await engine.execute('episode',{stage:'plan',attemptId:'plan'});
 if(plannedOnly)return {engine,store,calls,outputs};
 for(const packageId of packages)await engine.execute('episode',{stage:'author',packageId,attemptId:`author-${packageId}`});
 await engine.execute('episode',{stage:'finish',finishMode:'delta',packageIds:packages,attemptId:'finish'});
 const base=await engine.assemble('episode');assert.equal(base.status,'text_ready_for_review');
 return {engine,store,calls,outputs,base};
}

function assertNative(candidate,saved){
 assert.equal(candidate.raw,saved.raw);assert.deepEqual(candidate.output,saved.output);
}
async function refine(f){
 const ready=await f.engine.execute('episode',{stage:'finish',finishMode:'delta',purpose,refinementEventIds:['e1'],packageIds:packages,attemptId:'refine'});
 return {ready,candidate:ready.candidates.at(-1),basis:ready.operations.at(-1).refinement.baseAssemblyHash};
}

test('new marker reaches normal author/finish adoption and adds only same-package dialogue provenance',async t=>{
 const f=await fixture(t,{ordinaryLink:true}),author=f.base.candidates.find(c=>c.attemptId==='author-p1'),finished=f.base.candidates.find(c=>c.attemptId==='finish');
 assert.equal(f.base.rulesSnapshot.dialogueSourceLinkVersion,DIALOGUE_SOURCE_LINK_VERSION);
 for(const c of [author,finished]){
  assert.equal(c.status,'adopted');assert.deepEqual(c.validation.errors,[]);assertNative(c,f.outputs.get(c.attemptId));
  assert.deepEqual(links(c).map(n=>[n.from,n.to]),[[['s2'],['s2','s1']]]);
  assert.deepEqual(c.draft.units[0].shots[0].sourceRefs,['s2','s1']);
 }
 assert.deepEqual(f.base.adopted.map(a=>a.packageIds),[['p1'],['p2'],['p3']]);
 assert.equal(f.calls.length,5,'all calls are the five explicit local stub responses');
});

test('new marker reaches complete refinement adoption without changing retained events or native output',async t=>{
 const f=await fixture(t),{ready,candidate,basis}=await refine(f);
 assert.equal(candidate.status,'refinement_ready');assert.deepEqual(candidate.validation.errors,[]);
 assert.deepEqual(links(candidate).map(n=>n.sourceId),['s1','s2']);assertNative(candidate,f.outputs.get('refine'));
 const groups=getRefinementAcceptanceGroups(ready,candidate);assert.equal(groups.length,2);
 const count=f.calls.length,adopted=await f.engine.acceptRefinement('episode',candidate.id,basis,groups.map(g=>g.id)),current=adopted.candidates.at(-1);
 assert.equal(current.status,'adopted');assert.equal(current.adoptedRefinement.partial,false);
 assert.deepEqual(adopted.assembly.draft,candidate.draft);
 assert.deepEqual(adopted.assembly.draft.units.slice(2),f.base.assembly.draft.units.slice(2));
 assert.deepEqual(adopted.refinementArchives[0].assembly,f.base.assembly);assertNative(current,f.outputs.get('refine'));
 assert.equal(f.calls.length,count,'acceptance is free and cannot invoke the stub runner');
});

test('new marker reaches partial refinement normalization while nonselected units remain exact',async t=>{
 const f=await fixture(t),{ready,candidate,basis}=await refine(f),groups=getRefinementAcceptanceGroups(ready,candidate);
 assert.equal(candidate.status,'refinement_ready');assert.equal(groups.length,2);
 const count=f.calls.length,adopted=await f.engine.acceptRefinement('episode',candidate.id,basis,[groups[0].id]),current=adopted.candidates.at(-1);
 assert.equal(current.adoptedRefinement.partial,true);
 assert.deepEqual(adopted.assembly.draft.units[0].shots[0].sourceRefs,['s3','s1']);
 assert.deepEqual(adopted.assembly.draft.units.slice(1),f.base.assembly.draft.units.slice(1));
 assert.deepEqual(links({normalizations:current.adoptedRefinement.normalizations}).map(n=>n.sourceId),['s1']);
 assert.deepEqual(current.draft,candidate.draft,'the unselected full preview remains saved');assertNative(current,f.outputs.get('refine'));
 assert.match(adopted.assembly.text,/已改组1/);assert.doesNotMatch(adopted.assembly.text,/已改组2/);assert.equal(f.calls.length,count);
});

test('partial refinement cannot let dialogue linking and packing absorb a retained unit',async t=>{
 const f=await fixture(t,{mergeRetained:true}),{ready,candidate,basis}=await refine(f),groups=getRefinementAcceptanceGroups(ready,candidate);
 assert.equal(candidate.status,'refinement_ready');assert.equal(groups.length,2);assert.deepEqual(links(candidate).map(n=>n.sourceId),['s1','s2']);
 const count=f.calls.length;
 await assert.rejects(f.engine.acceptRefinement('episode',candidate.id,basis,[groups[0].id]),{code:'REFINEMENT_SCOPE'});
 const after=await f.engine.read('episode');assert.deepEqual(after.assembly,f.base.assembly);assert.equal(after.refinementArchives?.length||0,0);
 assertNative(after.candidates.at(-1),f.outputs.get('refine'));assert.equal(f.calls.length,count);
});

test('a refinement replacement from another event is retained as invalid without adoption or retry',async t=>{
 const f=await fixture(t,{crossEvent:true}),{ready,candidate,basis}=await refine(f),count=f.calls.length;
 assert.equal(candidate.status,'refinement_invalid');assert.equal(candidate.errors[0].code,'REFINEMENT_SCOPE');
 assert.deepEqual(ready.assembly,f.base.assembly);assertNative(candidate,f.outputs.get('refine'));
 await assert.rejects(f.engine.acceptRefinement('episode',candidate.id,basis),{code:'REFINEMENT_STALE'});
 const after=await f.engine.read('episode');assert.deepEqual(after.assembly,f.base.assembly);assert.equal(after.refinementArchives?.length||0,0);assert.equal(f.calls.length,count);
});

test('refreshRules refuses a paid legacy plan without rewriting its marker or frozen request',async t=>{
 const f=await fixture(t,{legacy:true,plannedOnly:true}),before=await f.engine.read('episode'),op=before.operations[0],request=rebuildFrozenRequest(before,op);
 assert.equal(before.rulesSnapshot.dialogueSourceLinkVersion,undefined);assert.ok(before.plan);
 await assert.rejects(f.engine.refreshRules('episode'),{code:'RULES_PROTOCOL_CHANGE'});
 const after=await f.engine.read('episode');assert.deepEqual(after,before);assert.deepEqual(rebuildFrozenRequest(after,after.operations[0]),request);
 assertNative(after.candidates[0],f.outputs.get('plan'));assert.equal(f.calls.length,1);
});
