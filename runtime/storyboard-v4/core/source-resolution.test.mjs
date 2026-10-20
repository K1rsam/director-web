import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {buildRequest} from './core.mjs';
import {digest} from './shared.mjs';
import {renderDraft} from './quality.mjs';
import {tailFixture,tailDraft} from './author-call-group-test-fixtures.mjs';
import * as resolution from './source-resolution.mjs';

const approval={actorId:'human-reviewer',reference:'user-answer-123',answer:'保留原话，夜景到出水段切日景，不补写跨夜过程。'};
async function setup(t){
 const directory=await mkdtemp(path.join(tmpdir(),'source-decision-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const f=tailFixture(),seen=[],feedback={relation:'TIME_JUMP',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[{stage:1,target:'scene/time',purpose:'夜与阳光待裁定',packageIds:['p1'],sourceRefs:['s1','s2'],blocking:true}],conflicts:[{key:'scene/time',problem:'场头夜而出水阳光',sourceRefs:['s1','s2']}]};
 const seed={schema:'EPISODE_BOUNDARY_SEED_V1',fromEpisode:null,toEpisode:1,adjacentEpisode:false,currentOpening:{text:'原文',sourceTextHash:'current'},previousSource:null};
 const boundary={version:'episode-boundary-v1',versionId:'boundary-1',seed,agreements:[],actual:null};
 const store=createStore(directory),engine=createEngine({directory,modelRunner:async request=>{
  seen.push(request);const output=request.stage==='plan'?{...f.plan,productionFeedback:feedback}:{...tailDraft(request),productionFeedback:{...feedback,needs:[],conflicts:[]}};
  return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{inputTokens:10,outputTokens:5,totalTokens:15}};
 }});
 await engine.create({id:'resolution',source:f.source,settings:f.settings,production:{boundary,materials:[]}});
 // This source-adjudication fixture replays receipts from before complete-result inheritance.
 await store.update('resolution',d=>{d.rulesSnapshot.productionFeedbackResultVersion='production-feedback-result-v1';return d;});
 await engine.execute('resolution',{stage:'plan',attemptId:'paid-plan'});
 const before=await engine.read('resolution'),candidate=before.candidates.at(-1);
 const value={sourceHash:digest({sourceRows:before.source.sourceRows,dialogue:before.source.dialogue}),kind:'TIME_LIGHTING_SPLIT',sourceRefs:['s1','s2'],instruction:approval.answer,
  conflicts:[{candidateId:candidate.id,conflictHash:digest(candidate.productionFeedback.conflicts[0]),needHashes:[digest(candidate.productionFeedback.needs[0])]}]};
 return {engine,store,before,seen,value};
}

test('human source decision releases the exact paid conflict and reaches new requests, without changing old paid inputs',async t=>{
 const {engine,before,seen,value}=await setup(t);
 assert.equal(before.production.blocking,true);
 assert.equal(typeof engine.resolveSource,'function','source decisions need a formal receiving path');
 const after=await engine.resolveSource('resolution',value,approval);
 assert.equal(after.production.blocking,false);
 assert.equal(after.production.needs[0].resolved,true);
 for(const key of ['source','plan','choice','rulesSnapshot','candidates','operations','adopted','status'])assert.deepEqual(after[key],before[key],key);
 assert.equal(seen.length,1,'recording the human decision is free');
 const frozen=seen[0];
 await engine.execute('resolution',{stage:'author',packageId:'p1',attemptId:'new-author'});
 assert.match(seen.at(-1).prompt,/用户已确认的有限制作解释/);
 assert.match(seen.at(-1).prompt,/夜景到出水段切日景/);
 assert.deepEqual(seen[0],frozen);
 assert.equal((await engine.read('resolution')).candidates.at(-1).status,'adopted');
});

test('decisions reject missing human evidence, stale source, unrelated needs, live calls and locked constraints',async t=>{
 for(const mode of ['approval','source','need','busy','locked']){
  const {engine,store,before,value}=await setup(t);assert.equal(typeof engine.resolveSource,'function');
  let input=structuredClone(value),trusted=approval;
  if(mode==='approval')trusted={actorId:'human-reviewer',reference:'',answer:approval.answer};
  if(mode==='source')input.sourceHash='0'.repeat(64);
  if(mode==='need')input.conflicts[0].needHashes=['0'.repeat(64)];
  if(mode==='busy')await store.update('resolution',d=>{d.operations.push({attemptId:'live',status:'running'});return d;});
  if(mode==='locked')await store.update('resolution',d=>{d.production.boundary.agreements.push({key:'scene/time',value:'锁定夜景'});return d;});
  const snapshot=await engine.read('resolution');
  await assert.rejects(engine.resolveSource('resolution',input,trusted),e=>/^SOURCE_RESOLUTION/.test(e.code),mode);
  assert.deepEqual(await engine.read('resolution'),snapshot);
  assert.equal(before.candidates[0].productionFeedback.conflicts.length,1);
 }
});

test('speaker correction changes only the authorized rendered speaker and new request view, not source words or old requests',async t=>{
 const {engine,before,seen}=await setup(t);assert.equal(typeof engine.resolveSource,'function');
 const q=before.source.dialogue[0],target=before.source.dialogue[1].id;
 const value={sourceHash:digest({sourceRows:before.source.sourceRows,dialogue:before.source.dialogue}),kind:'SPEAKER_CORRECTION',sourceRefs:[q.rowId],instruction:'仅此句改归乙，台词与表演提示原字不变。',speaker:{lineId:q.id,from:'甲',to:'乙'},conflicts:[]};
 // Explicit human authorization may name a different performer; it is not inferred from a name match.
 const after=await engine.resolveSource('resolution',value,{...approval,answer:value.instruction});
 const draft=tailDraft({plan:before.plan,source:before.source});
 const rendered=renderDraft({draft,source:before.source,settings:before.settings,sourceResolutions:after.production.sourceResolutions});
 assert.match(rendered,/乙，画内/);assert.match(rendered,/甲，画内/);
 assert.deepEqual(after.source,before.source);assert.deepEqual(after.operations,before.operations);
 const request=buildRequest({stage:'author',source:after.source,settings:after.settings,plan:after.plan,choice:after.choice,packageId:'p1',rulesSnapshot:after.rulesSnapshot,productionSnapshot:{version:'production-feedback-v1',touchesOpening:true,touchesEnding:false,materials:[],sourceResolutions:after.production.sourceResolutions}});
 assert.match(request.prompt,/SPEAKER_CORRECTION/);assert.match(request.prompt,/"speaker":"乙"/);
 assert.equal(request.source.dialogue.find(d=>d.id===q.id).speaker,'甲');
 assert.equal(request.source.dialogue.find(d=>d.id===target).speaker,'甲');
 assert.equal(seen.length,1);
});

test('the assembled downloadable script uses the approved speaker while raw source and earlier paid planning remain intact',async t=>{
 const {engine,before,value}=await setup(t);assert.equal(typeof engine.resolveSource,'function');
 await engine.resolveSource('resolution',value,approval);
 const q=before.source.dialogue[0];
 await engine.resolveSource('resolution',{sourceHash:value.sourceHash,kind:'SPEAKER_CORRECTION',sourceRefs:[q.rowId],instruction:'仅此句改归乙，台词原字不变。',speaker:{lineId:q.id,from:q.speaker,to:'乙'},conflicts:[]},{...approval,reference:'user-answer-124',answer:'仅此句改归乙'});
 for(const packageId of ['p1','p2','p3'])await engine.execute('resolution',{stage:'author',packageId,attemptId:`author-${packageId}`});
 await engine.execute('resolution',{stage:'finish',packageIds:['p1','p2','p3'],attemptId:'finish-all'});
 const final=await engine.assemble('resolution');
 assert.equal(final.status,'text_ready_for_review');
 assert.match(final.assembly.text,/乙（/);
 assert.equal(final.source.dialogue[0].speaker,'甲');
 assert.deepEqual(final.operations[0],before.operations[0]);
 assert.deepEqual(final.candidates[0],before.candidates[0]);
});

test('a confirmed future-episode correction is available before its first paid request, but not to another source or project',async t=>{
 const {engine,before,value}=await setup(t);
 assert.equal(typeof resolution.createSourceResolutionRegistry,'function','future episodes need the same source-bound decision before planning');
 const directory=await mkdtemp(path.join(tmpdir(),'source-registry-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const registry=resolution.createSourceResolutionRegistry(directory),binding={projectId:'project-a',episodeId:'episode-future'},q=before.source.dialogue[0];
 const raw={sourceHash:value.sourceHash,kind:'SPEAKER_CORRECTION',sourceRefs:[q.rowId],instruction:'仅此句由乙说出，台词不改。',speaker:{lineId:q.id,from:q.speaker,to:'乙'},conflicts:[]};
 const saved=await registry.register(binding,before.source,raw,{...approval,answer:'这处改归乙'});
 const readings=await registry.read(binding,before.source);assert.equal(readings[0].id,saved.id);
 await assert.rejects(registry.read({...binding,projectId:'project-b'},before.source),{code:'SOURCE_RESOLUTION_STALE'});
 const changed=structuredClone(before.source);changed.sourceRows[0].text+='改';
 await assert.rejects(registry.read(binding,changed),{code:'SOURCE_RESOLUTION_STALE'});
 const created=await engine.create({id:'future',source:before.source,settings:before.settings,production:{boundary:before.production.boundary,materials:[],sourceResolutions:readings}});
 const request=buildRequest({stage:'plan',source:created.source,settings:created.settings,rulesSnapshot:created.rulesSnapshot,productionSnapshot:{version:'production-feedback-v1',touchesOpening:true,touchesEnding:false,materials:[],sourceResolutions:readings}});
 assert.match(request.prompt,/"speaker":"乙"/);assert.equal(created.source.dialogue[0].speaker,'甲');
});
