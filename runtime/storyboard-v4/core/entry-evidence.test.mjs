import test from 'node:test';
import assert from 'node:assert/strict';
import {ENTRY_REVIEW_VERSION,freezeEntryBasis,projectEntryCoverage,entryCoverageSchema} from './entry-evidence.mjs';
import {effectiveProductionFeedback} from './production-feedback-result.mjs';
import {digest} from './shared.mjs';
import {baseDraftHash} from './delta.mjs';

function fixture(){
 const entry={key:'actor/pose',value:'撑着石阶。',authority:'DESIGN',sourceRefs:[]};
 const draft={schemaVersion:'performance-core-v4',units:[{id:'opening',initialState:'甲撑着石阶。',shots:[{id:'s1',picture:'甲用手撑住石阶站起。'}]}],fantasyRealization:[]};
 const feedback={relation:'DIRECT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]};
 const run={plan:{workPackages:[{id:'p'}]},candidates:[{id:'old-paid',attemptId:'old',stage:'author',status:'adopted',packageIds:['p'],draft,productionFeedback:{...feedback,entry:[entry]}}],operations:[{attemptId:'old',productionSnapshot:{touchesOpening:true}}]};
 const basis=freezeEntryBasis(run,draft,['p']),request={stage:'finish',productionSnapshot:{entryReviewVersion:ENTRY_REVIEW_VERSION,touchesOpening:true},previousDraft:{...draft,entryBasis:basis}};
 const proof={unitId:'opening',shotId:'',field:'initialState',quote:'甲撑着石阶'};
 feedback.entryCoverage={complete:true,basisSignature:basis.signature,actualDecisions:[],decisions:[{key:entry.key,decision:'KEEP',replacementKey:'',reason:'仍消费入口',priorEvidence:[],currentEvidence:[proof]}]};
 return {entry,draft,feedback,run,basis,request,proof};
}
test('complete entry projection keeps raw omission and provenance without manufacturing actual or inheriting needs',()=>{
 const f=fixture(),before=structuredClone(f),projection=projectEntryCoverage(f);
 const candidate={productionFeedback:f.feedback,draft:f.draft,entryProjection:projection};
 assert.deepEqual(effectiveProductionFeedback(candidate).entry,[f.entry]);assert.deepEqual(f,before);
 assert.equal(projection.nativeFeedbackHash,digest(f.feedback));assert.equal(projection.draftHash,baseDraftHash(f.draft));
 for(const change of [c=>c.productionFeedback.entry.push(f.entry),c=>c.draft.units[0].initialState='新稿',c=>c.entryProjection.entry[0].authority='SOURCE']){
  const c=structuredClone(candidate);change(c);assert.throws(()=>effectiveProductionFeedback(c));
 }
 assert.equal(projectEntryCoverage({...f,request:{...f.request,productionSnapshot:{}}}),null,'historical frozen requests do not opt in');
});
test('silent omission, stale basis and unchanged/literal consuming evidence forbid a false REMOVE',()=>{
 for(const change of [f=>delete f.feedback.entryCoverage,f=>f.feedback.entryCoverage.decisions=[],f=>f.feedback.entryCoverage.basisSignature='stale',f=>f.feedback.entryCoverage.decisions[0].currentEvidence[0].quote='不存在',f=>{const row=f.feedback.entryCoverage.decisions[0];row.decision='REMOVE';row.priorEvidence=[f.proof];}]){
  const f=fixture();change(f);assert.throws(()=>projectEntryCoverage(f),{code:'PRODUCTION_ENTRY_EVIDENCE'});
 }
 const f=fixture();f.draft=structuredClone(f.draft);f.draft.units[0].id='renamed';f.draft.units[0].initialState='甲撑着石阶；旁边有人。';f.draft.units[0].shots[0].id='renamed-shot';
 f.feedback.entryCoverage.decisions[0]={key:f.entry.key,decision:'REMOVE',replacementKey:'',reason:'不能借改ID掩盖仍有消费',priorEvidence:[f.proof],currentEvidence:[{...f.proof,unitId:'renamed',quote:'甲撑着石阶'}]};
 assert.throws(()=>projectEntryCoverage(f),{code:'PRODUCTION_ENTRY_EVIDENCE'});
});
test('explicit semantic replacement retires the old key for the next basis rather than resurrecting historical entries',()=>{
 const f=fixture(),replacement={...f.entry,key:'actor/renamed-pose'};f.feedback.entry=[replacement];
 f.feedback.entryCoverage.decisions[0]={...f.feedback.entryCoverage.decisions[0],decision:'REPLACE',replacementKey:replacement.key};
 const projection=projectEntryCoverage(f),candidate={id:'new-paid',attemptId:'new',stage:'finish',status:'adopted',packageIds:['p'],draft:f.draft,productionFeedback:f.feedback,entryProjection:projection};
 f.run.candidates.push(candidate);f.run.operations.push({attemptId:'new',productionSnapshot:{touchesOpening:true},previousDraft:f.request.previousDraft});
 assert.deepEqual(freezeEntryBasis(f.run,f.draft,['p']).claims.map(c=>c.entry.key),[replacement.key]);
 const schema=entryCoverageSchema(f.basis);assert.equal(schema.entryCoverage.properties.decisions.minItems,1);assert.equal(schema.entryCoverage.properties.decisions.maxItems,1);
});
test('actual consumption cannot disappear merely because author and finish both omitted the same established state',()=>{
 const f=fixture();f.request.episodeBoundary={actual:{states:[{...f.entry,key:'actor/held-items',value:'右手并持枪扇，左手掌缰。'}]}};
 assert.throws(()=>projectEntryCoverage(f),{code:'PRODUCTION_ENTRY_EVIDENCE'});
});

test('same-key and renamed REPLACE cannot upgrade or downgrade the original entry authority',()=>{
 for(const authority of ['SOURCE','DESIGN'])for(const rename of [false,true]){
  const f=fixture();f.run.candidates[0].productionFeedback.entry[0].authority=authority;
  f.basis=freezeEntryBasis(f.run,f.draft,['p']);f.request.previousDraft.entryBasis=f.basis;
  f.feedback.entryCoverage.basisSignature=f.basis.signature;
  const replacement={...f.entry,key:rename?'actor/new-pose':f.entry.key,authority:authority==='SOURCE'?'DESIGN':'SOURCE',sourceRefs:authority==='SOURCE'?[]:['s1']};
  f.feedback.entry=[replacement];Object.assign(f.feedback.entryCoverage.decisions[0],{decision:'REPLACE',replacementKey:replacement.key});
  assert.throws(()=>projectEntryCoverage(f),{code:'PRODUCTION_ENTRY_EVIDENCE'});
 }
});

function sharedWitnessFixture(){
 const f=fixture();f.request.episodeBoundary={actual:{states:[f.entry]}};
 f.request.productionSnapshot.entryEvidenceContext={draft:f.draft};
 f.feedback.entryCoverage.actualDecisions=[{key:f.entry.key,decision:'CONSUMED',entryKey:f.entry.key,reason:'同键同等级入口已在本次原生回包逐项携证',priorEvidence:[f.proof],currentEvidence:[f.proof]}];
 f.feedback.entryCoverage.decisions[0].currentEvidence=[];
 return f;
}
test('KEEP may reuse an explicit same-key actual-consumption witness without modifying native feedback',()=>{
 const f=sharedWitnessFixture(),before=structuredClone(f),projection=projectEntryCoverage(f);
 assert.deepEqual(projection.entry,[f.entry]);assert.deepEqual(f,before);
 assert.deepEqual(projection.coverageEvidenceSources,[{key:f.entry.key,source:'entryCoverage.actualDecisions',actualKey:f.entry.key}]);
});
test('shared KEEP witness cannot mask malformed evidence, changed keys, replacement, authority drift or missing actual proof',()=>{
 for(const change of [f=>f.feedback.entryCoverage.decisions[0].currentEvidence=null,f=>f.feedback.entryCoverage.decisions[0].currentEvidence=[{...f.proof,quote:'不存在'}],f=>f.feedback.entryCoverage.decisions[0].decision='REPLACE',f=>f.feedback.entryCoverage.actualDecisions[0].entryKey='other',f=>f.feedback.entryCoverage.actualDecisions[0].key='other',f=>f.feedback.entryCoverage.actualDecisions[0].decision='NOT_CONSUMED',f=>f.feedback.entryCoverage.actualDecisions[0].currentEvidence=[],f=>f.feedback.entryCoverage.actualDecisions[0].priorEvidence=[],f=>f.feedback.entryCoverage.actualDecisions=[null],f=>f.feedback.entryCoverage.actualDecisions.unshift(null),f=>f.request.episodeBoundary.actual.states[0]={...f.entry,authority:'SOURCE'}]){
  const f=sharedWitnessFixture();change(f);assert.throws(()=>projectEntryCoverage(f),{code:'PRODUCTION_ENTRY_EVIDENCE'});
 }
});

test('later repeated words are not opening consumption across a real discontinuity',()=>{
 for(const relation of ['TIME_JUMP','LOCATION_CHANGE','INDEPENDENT','DIRECT']){
 const f=fixture(),actual={key:'actor/location',value:'门口',authority:'DESIGN',sourceRefs:[]};
 f.draft={...f.draft,units:[{id:'next-day',initialState:'次日清晨，甲站在山顶。',shots:[{id:'mountain',picture:'甲俯瞰山谷。'}]},{id:'evening',initialState:'当晚甲回到客栈门口。',shots:[]}]};
 f.run.candidates=[];const basis=freezeEntryBasis(f.run,f.draft,['p']);f.request.previousDraft.entryBasis=basis;
 f.request.episodeBoundary={actual:{states:[actual]}};f.feedback.relation=relation;
 f.feedback.entryCoverage.basisSignature=basis.signature;f.feedback.entryCoverage.decisions=[];
 f.feedback.entryCoverage.actualDecisions=[{key:actual.key,decision:'NOT_CONSUMED',entryKey:'',reason:'次日山顶开场，不消费前集门口位置。',priorEvidence:[],currentEvidence:[{unitId:'next-day',shotId:'',field:'initialState',quote:'甲站在山顶'}]}];
 assert.ok(projectEntryCoverage(f));
 }
});
