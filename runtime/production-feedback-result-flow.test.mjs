import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine,boundaryEntryEvidence,rebuildFrozenRequest} from './storyboard-v4/core/pipeline.mjs';
import {createStore} from './storyboard-v4/core/store.mjs';
import {tailFixture,tailDraft} from './storyboard-v4/core/author-call-group-test-fixtures.mjs';
import {FEEDBACK_RESULT_VERSION} from './storyboard-v4/core/production-feedback-result.mjs';
import {DELTA_VERSION,baseDraftHash} from './storyboard-v4/core/delta.mjs';
import {selectedActualTail,makeBoundaryContext} from './episode-boundary.mjs';
import {digest} from './storyboard-v4/core/shared.mjs';
import {ENTRY_REVIEW_VERSION,makeEntryEvidenceContext} from './storyboard-v4/core/entry-evidence.mjs';
import {productionBlock} from './storyboard-v4/coordinator.mjs';

test('new normal finish transports complete adopted evidence and preserves omitted-but-consumed entry without any review runner',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'entry-evidence-flow-')),f=tailFixture();let calls=0,suppressCoverage=false;
 f.source.sourceRows=f.source.sourceRows.slice(-1);f.plan.workPackages=f.plan.workPackages.slice(-1).map(w=>({...w,dependsOn:[]}));
 f.plan.events=f.plan.events.slice(-1).map(e=>({...e,boundaryBefore:{kind:'episode_start',reason:'开始'}}));f.plan.provisionalUnits=f.plan.provisionalUnits.slice(-1);
 const selected={runId:'prior',episode:1,sourceVersion:'v',selectionRevision:1},priorDraft={schemaVersion:'performance-core-v4',units:[{id:'prior-early',initialState:'甲撑着石阶。',shots:[{id:'prior-s1',picture:'甲仍用手撑住石阶。'}]},{id:'prior-tail',initialState:'乙守在门边。',shots:[{id:'prior-s2',picture:'乙望向院门。'}]}],fantasyRealization:[]};
 const seed={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'v',fromEpisode:1,toEpisode:2,adjacentEpisode:true,previousSource:{sourceTextHash:'prior-text'},currentOpening:{text:'甲推门。',sourceTextHash:'current-text'}};
 const boundary=makeBoundaryContext({seed,selected,actual:{...selected,validated:true,version:'tail',unit:priorDraft.units.at(-1),states:[]}});
 const entry={key:'甲/入口姿态',value:'撑着石阶。',authority:'DESIGN',sourceRefs:[]},feedback=()=>({relation:'DIRECT',entry:[entry],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]});
 const evidenceContext=makeEntryEvidenceContext({id:'prior',source:{text:'原文'},adopted:[{candidateId:'paid-prior'}],assembly:{draft:priorDraft,validation:{errors:[]}}},boundary);
 const engine=createEngine({directory,modelRunner:async r=>{
  calls++;let output;
  if(r.stage==='plan')output={...f.plan,productionFeedback:feedback()};
  else if(r.stage==='author'){output=tailDraft(r);output.units[0].initialState='甲撑着石阶。';output.units[0].shots[0].picture='甲用手撑阶站起。';output.productionFeedback=feedback();}
  else{
   assert.equal(r.productionSnapshot.entryReviewVersion,ENTRY_REVIEW_VERSION);assert.match(r.prompt,/entryEvidenceContext/);assert.match(r.prompt,/完整已采用前稿/);
   const basis=r.previousDraft.entryBasis,u=r.previousDraft.units[0],proof={unitId:u.id,shotId:'',field:'initialState',quote:'甲撑着石阶'};
   output={schemaVersion:DELTA_VERSION,baseDraftHash:r.baseDraftHash,retainedUnitIds:[u.id],replacements:[],revisionNotes:[],unresolved:[],productionFeedback:{...feedback(),entry:[],
    resultRevision:{baseSignature:r.previousDraft.feedbackBasis.signature,exitDecisions:[],materialDecisions:[]},entryCoverage:{complete:true,basisSignature:basis.signature,actualDecisions:[],decisions:basis.claims.map(c=>({key:c.entry.key,decision:'KEEP',replacementKey:'',reason:'开场仍消费撑阶入口',priorEvidence:[],currentEvidence:[proof]}))},
    entryEvidence:[{key:entry.key,entryValue:entry.value,verdict:'CONSISTENT',reason:'前稿早先撑阶正证与完整后续无改变，本集撑阶站起继续消费；不把没出现当持续证据。',priorEvidence:[{unitId:'prior-early',shotId:'prior-s1',field:'picture',quote:'甲仍用手撑住石阶'}],currentEvidence:[proof]}]}};
  }if(r.stage==='finish'&&suppressCoverage)output.productionFeedback.entryCoverage.decisions=[];
  return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};
 }});
 try{
  await engine.create({id:'flow',source:f.source,settings:f.settings,production:{feedbackResultVersion:FEEDBACK_RESULT_VERSION,entryReviewVersion:ENTRY_REVIEW_VERSION,entryEvidenceContext:evidenceContext,boundary,materials:[]}});
  await engine.execute('flow',{stage:'plan',attemptId:'plan'});await engine.execute('flow',{stage:'author',packageId:'p3',attemptId:'author'});
  const authorBaseline=await engine.read('flow');
  await engine.execute('flow',{stage:'finish',finishMode:'delta',packageId:'p3',attemptId:'finish'});
  const done=await engine.assemble('flow');assert.equal(done.status,'text_ready_for_review');assert.equal(done.production.boundaryCheck.status,'NOT_CONSUMED');
  assert.ok(done.production.boundaryCheck.entryEvidenceReviewId);assert.deepEqual(done.candidates.at(-1).productionFeedback.entry,[],'paid native omission remains unchanged');
  assert.deepEqual(done.candidates.at(-1).entryProjection.entry,[entry]);assert.deepEqual(done.production.boundary.actual.states,[]);assert.equal(calls,3);
  const originalId=done.candidates.at(-1).id;
  // Persist a valid original response rejected by an older receiver. Free recheck
  // must close only that candidate's hold, not erase an unrelated gate.
  await createStore(directory).update('flow',d=>{d.candidates.at(-1).status='needs_repair';d.adopted=structuredClone(authorBaseline.adopted);d.assembly=null;d.production.entryEvidenceHold={candidateId:originalId,code:'PRODUCTION_ENTRY_EVIDENCE',message:'旧接收器误拦，原回包保持'};return d;});
  const rejected=await engine.read('flow'),frozen=rebuildFrozenRequest(rejected,rejected.operations.at(-1));
  assert.equal(digest([frozen.promptHash,frozen.instructionHash,frozen.inputHash]),rejected.operations.at(-1).fingerprint,'free recheck must keep the exact frozen request');
  assert.equal(baseDraftHash({schemaVersion:rejected.version,units:rejected.adopted.flatMap(a=>a.draft.units),fantasyRealization:rejected.adopted.flatMap(a=>a.draft.fantasyRealization)}),rejected.operations.at(-1).baseDraftHash,'fixture must retain the delta base');
  const checked=await engine.recheckCandidate('flow',originalId);
  assert.equal(checked.candidates.at(-1).status,'adopted');assert.equal(checked.candidates.at(-1).derivedFrom,originalId);
  assert.equal(checked.production.entryEvidenceHold,undefined,'valid free descendant evidence closes its own durable hold');
  assert.equal(checked.production.entryEvidenceResolutions.at(-1).candidateId,originalId);assert.equal(calls,3);
  const changed=structuredClone(evidenceContext);changed.lineageHash='drift';
  const next=await engine.refreshProduction('flow',{boundary,entryEvidenceContext:changed,materials:[]});
  assert.equal(next.production.boundaryCheck.status,'UNRESOLVED','current full-predecessor evidence drift must expire native proof');assert.equal(calls,3);
  await engine.refreshProduction('flow',{boundary,entryEvidenceContext:evidenceContext,materials:[]});suppressCoverage=true;
  const held=await engine.execute('flow',{stage:'finish',finishMode:'delta',packageId:'p3',attemptId:'invalid-proof'});
  assert.equal(held.candidates.at(-1).errors[0].code,'PRODUCTION_ENTRY_EVIDENCE');assert.equal(productionBlock(held,'finish',['p3']),'upstream_review');
  const stillHeld=await engine.refreshProduction('flow',{boundary,entryEvidenceContext:evidenceContext,materials:[]});
  assert.equal(productionBlock(stillHeld,'finish',['p3']),'upstream_review','refresh cannot turn a new protocol proof failure into paid full fallback');assert.equal(calls,4,'four synthetic fixture responses, no recovery/refresh runner');
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('normal entry proof requirement does not silently extend into the separate director-refinement contract',()=>{
 const draft={schemaVersion:'performance-core-v4',units:[{id:'u'}],fantasyRealization:[]},entry={id:'c',attemptId:'a',draft,packageIds:['p']};
 const d={candidates:[],operations:[{attemptId:'a',purpose:'director_refinement',productionSnapshot:{entryReviewVersion:ENTRY_REVIEW_VERSION}}],production:{}};
 assert.equal(boundaryEntryEvidence(d,entry).entryReviewRequired,false);
 delete d.operations[0].purpose;assert.equal(boundaryEntryEvidence(d,entry).entryReviewRequired,true);
});

test('new web capability freezes full-result basis, adopts delta, serves complete tail and checks original material consumer for free',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'feedback-result-flow-')),f=tailFixture(),seen=[];
 f.source.sourceRows=f.source.sourceRows.slice(-1);f.plan.workPackages=f.plan.workPackages.slice(-1).map(w=>({...w,dependsOn:[]}));
 f.plan.events=f.plan.events.slice(-1).map(e=>({...e,boundaryBefore:{kind:'episode_start',reason:'本集开始'}}));f.plan.provisionalUnits=f.plan.provisionalUnits.slice(-1);
 const material={id:'asset:door',kind:'ADOPTED_DESIGN',version:'v1',value:{design:'旧门板'}};
 const baseFeedback=()=>({relation:'DIRECT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[material.id],needs:[],conflicts:[]});
 const engine=createEngine({directory,modelRunner:async request=>{
  seen.push(request);let output;
  if(request.stage==='plan')output={...f.plan,productionFeedback:baseFeedback()};
  else if(request.stage==='author')output={...tailDraft(request),productionFeedback:{...baseFeedback(),exit:[{key:'door/location',value:'仍在门口',authority:'DESIGN',sourceRefs:[]}]}};
  else{
   assert.equal(request.productionSnapshot.feedbackResultVersion,FEEDBACK_RESULT_VERSION);
   assert.match(request.prompt,/"feedbackBasis"/);assert.ok(request.prompt.includes('完整结果回执'+FEEDBACK_RESULT_VERSION));
   const basis=request.previousDraft.feedbackBasis;assert.deepEqual(basis.materialIds,[material.id]);
   const u=request.previousDraft.units.at(-1),changed=structuredClone(u);changed.shots[0].picture='甲抬眼后手掌保持按住门板。';changed.exitState=u.exitState+'甲仍在门口，手掌保持按住门板。';
   const rebind=request.productionSnapshot.materials.some(m=>m.id===material.id&&m.version==='v2');
   output={schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:[],replacements:[{replaces:[u.id],units:[changed],fantasyRealization:[]}],revisionNotes:[],unresolved:[],
    productionFeedback:{...baseFeedback(),usedMaterialIds:rebind?[material.id]:[],exit:[{key:'hand/door',value:'保持按住',authority:'DESIGN',sourceRefs:[]}],entryEvidence:[],resultRevision:{baseSignature:basis.signature,
     exitDecisions:basis.exit.map(s=>({key:s.key,decision:'KEEP',replacementKey:'',reason:'只改手掌，所在位置未变',evidence:[{unitId:u.id,shotId:'',field:'exitState',quote:s.value}],continuation:[]})),
     materialDecisions:[{id:material.id,decision:rebind?'REPLACE':'KEEP',reason:rebind?'本次已读取新门板并核对整稿':'仍用原门板设计'}]}}};
  }
  return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};
 }});
 try{
  await engine.create({id:'flow',source:f.source,settings:f.settings,production:{feedbackResultVersion:FEEDBACK_RESULT_VERSION,boundary:null,materials:[material]}});
  await engine.execute('flow',{stage:'plan',attemptId:'plan'});await engine.execute('flow',{stage:'author',packageId:'p3',attemptId:'author'});
  await engine.execute('flow',{stage:'finish',finishMode:'delta',packageId:'p3',attemptId:'finish'});
  const done=await engine.assemble('flow'),paidHash=digest([done.candidates,done.operations]);
  assert.equal(done.status,'text_ready_for_review');assert.deepEqual(selectedActualTail(done).states.map(s=>s.key),['door/location','hand/door']);
  const repaired=done.candidates.at(-1);assert.deepEqual(repaired.productionFeedback.usedMaterialIds,[]);
  assert.equal(repaired.feedbackProjection.materialConsumers[0].attemptId,'author');
  assert.equal((await engine.recover('flow','finish')).status,'text_ready_for_review');assert.equal(seen.length,3,'only the mocked plan/author/finish; recovery has no runner');
  const changed={...material,version:'v2',value:{design:'新门板'}};
  const next=await engine.refreshProduction('flow',{boundary:null,materials:[changed]});
  assert.deepEqual(next.production.pendingRepair.packageIds,['p3'],'old material version must remain a real dependency after local delta');
  assert.equal(digest([next.candidates,next.operations]),paidHash,'refresh cannot edit paid output or original snapshots');
  await engine.refreshProduction('flow',{boundary:null,materials:[changed]});assert.equal(seen.length,3);
  const repairedNewVersion=await engine.execute('flow',{stage:'finish',finishMode:'delta',packageId:'p3',attemptId:'finish-v2'});
  assert.equal(repairedNewVersion.production.pendingRepair,null,'same material ID can rebind to v2 without a permanent old-consumer loop');
  assert.deepEqual(repairedNewVersion.candidates.at(-1).feedbackProjection.materialConsumers.map(c=>c.attemptId),['finish-v2']);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('normal finishing native SOURCE proof reaches the production gate; later actual drift expires it without any extra runner call',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'feedback-source-flow-')),f=tailFixture();let calls=0;
 f.source.sourceRows=[{id:'s6',text:'△甲单手推门入内。'}];f.plan.workPackages=f.plan.workPackages.slice(-1).map(w=>({...w,dependsOn:[]}));
 f.plan.events=f.plan.events.slice(-1).map(e=>({...e,boundaryBefore:{kind:'episode_start',reason:'本集开始'}}));f.plan.provisionalUnits=f.plan.provisionalUnits.slice(-1);
 const selected={runId:'previous',episode:1,sourceVersion:'sv1',selectionRevision:1};
 const seed={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'sv1',fromEpisode:1,toEpisode:2,adjacentEpisode:true,previousSource:{episode:1,text:'甲只有一只手。',sourceRange:{start:0,end:7},nodes:[{id:'n1',target:'BODY',kind:'ACTION',sourceRange:{start:0,end:7}}]},currentOpening:{episode:2,text:'甲单手推门入内。'}};
 const actual={...selected,version:'actual-v1',validated:true,states:[],unit:{id:'previous-tail',initialState:'甲空袖垂下',shots:[{id:'previous-shot',picture:'空袖垂下，剩下的拳头握紧。'}]}};
 const boundary=makeBoundaryContext({seed,selected,actual}),entry={key:'character/limb',value:'仅余一只手',authority:'SOURCE',sourceRefs:['boundary:1:n1']};
 const feedback=()=>({relation:'DIRECT',entry:[entry],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]});
 const engine=createEngine({directory,modelRunner:async r=>{
  calls++;let output;
  if(r.stage==='plan')output={...f.plan,productionFeedback:feedback()};
  else if(r.stage==='author'){
   output=tailDraft(r);output.units[0].shots[0].picture='甲用独手按着门板，空袖下垂。';output.productionFeedback=feedback();
  }else{
   const u=r.previousDraft.units[0],basis=r.previousDraft.feedbackBasis;
   output={schemaVersion:DELTA_VERSION,baseDraftHash:r.baseDraftHash,retainedUnitIds:[u.id],replacements:[],revisionNotes:[],unresolved:[],productionFeedback:{...feedback(),
    resultRevision:{baseSignature:basis.signature,exitDecisions:[],materialDecisions:[]},entryEvidence:[{key:entry.key,verdict:'CONSISTENT',reason:'前尾和本稿均明示空袖与独手，未把漏键补写为actual',
     priorEvidence:[{unitId:actual.unit.id,shotId:'previous-shot',field:'picture',quote:'空袖垂下，剩下的拳头握紧'}],currentEvidence:[{unitId:u.id,shotId:u.shots[0].id,field:'picture',quote:'独手按着门板，空袖下垂'}]}]}};
  }
  return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};
 }});
 try{
  await engine.create({id:'flow',source:f.source,settings:f.settings,production:{feedbackResultVersion:FEEDBACK_RESULT_VERSION,boundary,materials:[]}});
  await engine.execute('flow',{stage:'plan',attemptId:'plan'});await engine.execute('flow',{stage:'author',packageId:'p3',attemptId:'author'});
  assert.equal((await engine.read('flow')).production.boundaryCheck.status,'UNRESOLVED');
  await engine.execute('flow',{stage:'finish',finishMode:'delta',packageId:'p3',attemptId:'finish'});
  const done=await engine.assemble('flow');assert.equal(done.production.boundaryCheck.status,'NOT_CONSUMED');
  assert.deepEqual(done.production.boundaryCheck.missingKeys,[entry.key]);assert.deepEqual(done.production.boundary.actual.states,[]);
  await createStore(directory).update('flow',d=>{d.source.sourceRows[0].text='△甲双手推门入内。';return d;});
  const sourceDrift=await engine.refreshProduction('flow',{boundary,materials:[]});
  assert.equal(sourceDrift.production.boundaryCheck.status,'UNRESOLVED','a rebuilt but non-native request must not lend its identity to the old proof');
  await createStore(directory).update('flow',d=>{d.source=done.source;return d;});
  const changed=makeBoundaryContext({seed,selected,actual:{...actual,version:'actual-v2'}});
  const after=await engine.refreshProduction('flow',{boundary:changed,predecessorRevision:2,materials:[]});
  assert.equal(after.production.boundaryCheck.status,'UNRESOLVED');assert.equal(calls,3);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('shared whole-episode transport does not repurchase an unaffected owner after one local material rebind',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'feedback-owner-scope-')),f=tailFixture();let calls=0;
 f.source.sourceRows=f.source.sourceRows.slice(0,5);f.plan.workPackages=f.plan.workPackages.slice(0,2);f.plan.events=f.plan.events.slice(0,2);f.plan.provisionalUnits=f.plan.provisionalUnits.filter(u=>u.packageId!=='p3');
 const a={id:'asset:A',kind:'ADOPTED_DESIGN',version:'a-v1',value:{design:'A1'}},b={id:'asset:B',kind:'ADOPTED_DESIGN',version:'b-v1',value:{design:'B1'}};
 const feedback=ids=>({relation:'DIRECT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:ids,needs:[],conflicts:[]});
 const engine=createEngine({directory,modelRunner:async r=>{
  calls++;let output;
  if(r.stage==='plan')output={...f.plan,productionFeedback:feedback([a.id,b.id])};
  else if(r.stage==='author')output={...tailDraft(r),productionFeedback:feedback(r.packageIds.includes('p1')?[a.id]:[b.id])};
  else{
   const basis=r.previousDraft.feedbackBasis,rebind=r.productionSnapshot.materials.some(m=>m.id===a.id&&m.version==='a-v2');
   output={schemaVersion:DELTA_VERSION,baseDraftHash:r.baseDraftHash,retainedUnitIds:r.previousDraft.units.map(u=>u.id),replacements:[],revisionNotes:[],unresolved:[],productionFeedback:{...feedback(rebind?[a.id]:[]),entryEvidence:[],resultRevision:{baseSignature:basis.signature,exitDecisions:[],materialDecisions:basis.materialIds.map(id=>({id,decision:rebind&&id===a.id?'REPLACE':'KEEP',reason:'完整核对当前范围消费'}))}}};
  }
  return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};
 }});
 try{
  await engine.create({id:'flow',source:f.source,settings:f.settings,production:{feedbackResultVersion:FEEDBACK_RESULT_VERSION,boundary:null,materials:[a,b]}});
  await engine.execute('flow',{stage:'plan',attemptId:'plan'});
  for(const id of ['p1','p2'])await engine.execute('flow',{stage:'author',packageId:id,attemptId:`author-${id}`});
  await engine.execute('flow',{stage:'finish',finishMode:'delta',packageIds:['p1','p2'],attemptId:'whole'});await engine.assemble('flow');
  const changed={...a,version:'a-v2',value:{design:'A2'}},next=await engine.refreshProduction('flow',{boundary:null,materials:[changed,b]});
  assert.deepEqual(next.production.pendingRepair.packageIds,['p1'],'actual support, not shared transport packageIds, determines local repair');
  const done=await engine.execute('flow',{stage:'finish',finishMode:'delta',packageId:'p1',attemptId:'local'});
  assert.equal(done.production.pendingRepair,null,'old whole owner p2 no longer owns the old A consumer support');
  assert.equal(done.adopted.find(g=>g.packageIds.includes('p2')).candidateId,done.candidates.find(c=>c.attemptId==='whole').id);
  assert.equal(calls,5,'mocked planned calls plus one mocked local repair, never another p2 call');
 }finally{await rm(directory,{recursive:true,force:true});}
});
