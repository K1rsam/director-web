import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {buildRequest,captureRules} from './core.mjs';
import {tailFixture,tailDraft} from './author-call-group-test-fixtures.mjs';
import {freezeDirectorRefinement,decorateDirectorRefinementRequest,assertDirectorRefinementDelta} from './director-refinement.mjs';
import {DELTA_VERSION,baseDraftHash} from './delta.mjs';
import {digest} from './shared.mjs';
import {publicRun} from '../input.mjs';

const version='director-refinement-v3',purpose='director_refinement',skillPath='skills/director-refinement/SKILL.md';
const complete=output=>({output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{inputTokens:10,outputTokens:9,cachedInputTokens:0,totalTokens:19}});
function fixture(){
 const f=tailFixture(),rulesSnapshot=captureRules();rulesSnapshot.directorRefinementVersion=version;
 const draft=tailDraft({plan:f.plan,source:{...f.source,dialogue:[]}});
 return {status:'text_ready_for_review',operations:[],adopted:[],...f,rulesSnapshot,assembly:{validation:{errors:[]},text:'完整基稿',draft}};
}
const noop=d=>({schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(d.assembly.draft),retainedUnitIds:d.assembly.draft.units.map(u=>u.id),replacements:[],revisionNotes:[],reviewDecisions:[],unresolved:[]});
test('v3 defaults to the entire accepted episode, including the last conflict, without changing the baseline',()=>{
 const d=fixture(),before=structuredClone(d),r=freezeDirectorRefinement(d,['p1','p2','p3']);
 assert.deepEqual(r.eventIds,['e1','e2','e3']);assert.equal(r.scope.wholeEpisode,true);assert.deepEqual(r.unitIds,d.assembly.draft.units.map(u=>u.id));assert.deepEqual(d,before);
 const local=freezeDirectorRefinement(d,['p1','p2','p3'],['e2']);assert.equal(local.scope.wholeEpisode,false);assert.ok(local.unitIds.every(id=>id.startsWith('p2-')));
});
test('v3 records concrete problems and changes, not mandatory excuses for every retained unit',()=>{
 const d=fixture(),r=freezeDirectorRefinement(d,['p1','p2','p3']),delta=noop(d);
 assert.doesNotThrow(()=>assertDirectorRefinementDelta(d.assembly.draft,delta,r));
 const u=d.assembly.draft.units.at(-1),changed=structuredClone(u);changed.shots[0].picture='门扇先遮住脸，推开后视线落向室内。';
 delta.retainedUnitIds=delta.retainedUnitIds.filter(id=>id!==u.id);delta.replacements=[{replaces:[u.id],units:[changed],fantasyRealization:[]}];
 assert.throws(()=>assertDirectorRefinementDelta(d.assembly.draft,delta,r),e=>e.code==='REFINEMENT_REVIEW');
 delta.reviewDecisions=[{unitIds:[u.id],disposition:'changed',reason:'入门动作缺乏空间结果→让门扇遮挡到视线落点连续可见',preservedFunction:'保留入门原文与作出决定的落点'}];
 assert.doesNotThrow(()=>assertDirectorRefinementDelta(d.assembly.draft,delta,r));
 delta.reviewDecisions.push({unitIds:[d.assembly.draft.units[0].id],disposition:'retained',reason:'合理，故保留',preservedFunction:'原话'});
 assert.throws(()=>assertDirectorRefinementDelta(d.assembly.draft,delta,r),e=>e.code==='REFINEMENT_REVIEW');
});
test('v3 sends the accepted draft, source and creative contracts once, without the full generation skill stack or old rough units',()=>{
 const d=fixture(),r=freezeDirectorRefinement(d,['p1','p2','p3']);
 const payload={stage:'finish',finishMode:'delta',source:d.source,settings:d.settings,plan:d.plan,choice:d.choice,packageIds:['p1','p2','p3'],previousDraft:d.assembly.draft,rulesSnapshot:d.rulesSnapshot};
 const ordinary=buildRequest(payload),request=decorateDirectorRefinementRequest(buildRequest({...payload,directorRefinement:r}),r);
 assert.deepEqual(request.loadedFiles.map(f=>f.path),[skillPath]);assert.equal(request.snapshot.length,1);
 assert.equal(request.prompt.split(r.skill.body).length,2,'frozen skill appears once');
 const wire=JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n')[0]);
 assert.deepEqual(wire.previousDraft,ordinaryInput(ordinary).previousDraft);assert.deepEqual(wire.source,ordinaryInput(ordinary).source);
 assert.deepEqual(expand(wire,wire.plan.workPackages),expand(ordinaryInput(ordinary),ordinaryInput(ordinary).plan.workPackages));assert.deepEqual(wire.plan.fantasyCandidates,ordinaryInput(ordinary).plan.fantasyCandidates);
 assert.equal(wire.capacityBrief,undefined);assert.equal(wire.plan.provisionalUnits,undefined);
 assert.ok(request.prompt.length<ordinary.prompt.length);assert.equal(request.schema.properties.reviewDecisions.minItems,0);
 assert.doesNotMatch(request.prompt,/不改也要说明|每个选中旧单元恰好登记一次/);
 assert.deepEqual(buildRequest(payload),ordinary,'ordinary generation remains byte-equivalent');
});
function ordinaryInput(request){return JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n')[0]);}
function expand(root,value){
 if(value&&typeof value==='object'&&typeof value.$same==='string')return expand(root,value.$same.slice(2).split('/').reduce((v,key)=>v[key],root));
 if(Array.isArray(value))return value.map(v=>expand(root,v));
 return value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,expand(root,v)])):value;
}
test('v2 keeps its old two-event limit and frozen no-change accounting during replay',()=>{
 const d=fixture();d.rulesSnapshot.directorRefinementVersion='director-refinement-v2';
 const r=freezeDirectorRefinement(d,['p1','p2','p3']);assert.deepEqual(r.eventIds,['e1','e2']);
 assert.throws(()=>freezeDirectorRefinement(d,['p1','p2','p3'],['e1','e2','e3']),e=>e.code==='REFINEMENT_SCOPE');
 assert.throws(()=>assertDirectorRefinementDelta(d.assembly.draft,noop(d),r),e=>e.code==='REFINEMENT_REVIEW');
 const req={stage:'finish',finishMode:'delta',baseDraftHash:r.baseDraftHash,prompt:'base',inputHash:'input',snapshot:[],loadedFiles:[],schema:{type:'object',properties:{},required:[]}};
 const result=decorateDirectorRefinementRequest(req,r);assert.equal(result.schema.properties.reviewDecisions.minItems,1);assert.match(result.prompt,/不改也要说明/);assert.equal(result.promptHash,digest(result.prompt));
});
test('a v3 all-retained reply is explicitly no improvement, preserves the completed baseline and does not dispatch another call',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'refinement-improve-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const calls=[],store=createStore(directory),engine=createEngine({directory,modelRunner:async(request,options)=>{
  calls.push(request);const d=await store.read('episode'),base=d.operations.find(o=>o.attemptId===options.attemptId)?.previousDraft;
  if(request.purpose===purpose)return complete({...noop({assembly:{draft:base}})});
  if(request.stage==='plan')return complete(tailFixture().plan);
  if(request.stage==='finish')return complete({schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:base.units.map(u=>u.id),replacements:[],revisionNotes:[],unresolved:[]});
  return complete(tailDraft(request));
 }});
 const f=tailFixture();await engine.create({id:'episode',source:f.source,settings:f.settings});
 await engine.execute('episode',{stage:'plan',attemptId:'plan'});
 for(const packageId of ['p1','p2','p3'])await engine.execute('episode',{stage:'author',packageId,attemptId:`author-${packageId}`});
 await engine.execute('episode',{stage:'finish',finishMode:'delta',packageIds:['p1','p2','p3'],attemptId:'finish'});
 const before=await engine.assemble('episode');
 const d=await engine.execute('episode',{stage:'finish',finishMode:'delta',purpose,packageIds:['p1','p2','p3'],attemptId:'refine'});
 assert.equal(d.candidates.at(-1).status,'refinement_no_change');assert.deepEqual(d.assembly,before.assembly);assert.equal(d.status,'text_ready_for_review');
 assert.deepEqual(d.operations.at(-1).refinement.eventIds,['e1','e2','e3']);assert.equal(publicRun(d).candidates.at(-1).refinement.comparison.status,'unchanged');assert.equal(calls.length,6);
 await assert.rejects(engine.execute('episode',{stage:'finish',finishMode:'delta',purpose,packageIds:['p1','p2','p3'],attemptId:'refine-again'}),e=>e.code==='REFINEMENT_LIMIT');assert.equal(calls.length,6);
});
