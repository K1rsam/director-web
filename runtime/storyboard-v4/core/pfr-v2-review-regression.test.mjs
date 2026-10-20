import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules} from './core.mjs';
import {normalizeSource} from './source.mjs';
import {tailFixture,tailDraft} from './author-call-group-test-fixtures.mjs';
import {freezeDirectorRefinement} from './director-refinement.mjs';
import {freezeFeedbackBasis,projectResultFeedback,LEGACY_FEEDBACK_RESULT_VERSION as v1,FEEDBACK_RESULT_VERSION as v2} from './production-feedback-result.mjs';

function requestFixture(stage='finish'){
 const f=tailFixture(),source=normalizeSource(f.source),rulesSnapshot=captureRules(),previousDraft=tailDraft({plan:f.plan,source});
 const productionSnapshot={version:'production-feedback-v1',materials:[],episodeBoundary:null,touchesOpening:false,touchesEnding:true,outgoingAgreements:[]};
 return {...f,source,stage,packageIds:stage==='author'?['p1']:f.plan.workPackages.map(w=>w.id),rulesSnapshot,productionSnapshot,
  ...(stage==='finish'?{previousDraft,finishMode:'delta'}:{})};
}
const resultFields=request=>request.schema.properties.productionFeedback.properties;

test('v2 ordinary production finish requires its snapshot marker instead of silently dropping resultRevision',()=>{
 const payload=requestFixture(),before=structuredClone(payload);
 assert.throws(()=>buildRequest(payload),{code:'RULE_SNAPSHOT'});assert.deepEqual(payload,before);
});
test('v2 snapshot requires the matching rule marker and rejects an explicit v1 mismatch',()=>{
 for(const missing of [true,false]){
  const payload=requestFixture();payload.productionSnapshot.feedbackResultVersion=v2;
  if(missing)delete payload.rulesSnapshot.productionFeedbackResultVersion;else payload.rulesSnapshot.productionFeedbackResultVersion=v1;
  assert.throws(()=>buildRequest(payload),{code:'RULE_SNAPSHOT'});
 }
});
test('paired v2 production finish includes the typed result contract',()=>{
 const payload=requestFixture();payload.productionSnapshot.feedbackResultVersion=v2;
 const before=structuredClone(payload),request=buildRequest(payload);
 assert.ok(resultFields(request).resultRevision);assert.ok(resultFields(request).resultRevision.properties.exitDecisions.items.properties.continuation);
 assert.deepEqual(payload,before);
});
test('plan and author do not require a finish-only snapshot marker',()=>{
 for(const stage of ['plan','author']){
  const payload=requestFixture(stage),before=structuredClone(payload),request=buildRequest(payload);
  assert.equal(resultFields(request).resultRevision,undefined);assert.deepEqual(payload,before);
 }
});
test('director refinement does not acquire ordinary v2 result schema or hints',()=>{
 for(const paired of [false,true]){
  const payload=requestFixture();if(paired)payload.productionSnapshot.feedbackResultVersion=v2;
  payload.directorRefinement=freezeDirectorRefinement({status:'text_ready_for_review',operations:[],adopted:[],source:payload.source,plan:payload.plan,rulesSnapshot:payload.rulesSnapshot,
   assembly:{draft:payload.previousDraft,text:'离线完整基稿',validation:{errors:[]}}},payload.packageIds);
  const before=structuredClone(payload),request=buildRequest(payload);
  assert.equal(resultFields(request).resultRevision,undefined);assert.ok(!request.prompt.includes('完整结果回执'+v2));assert.deepEqual(payload,before);
 }
});
test('historical rules without a result marker retain their v1 snapshot path',()=>{
 const payload=requestFixture();delete payload.rulesSnapshot.productionFeedbackResultVersion;delete payload.rulesSnapshot.dialogueSourceLinkVersion;
 payload.productionSnapshot.feedbackResultVersion=v1;
 const request=buildRequest(payload),properties=resultFields(request).resultRevision.properties.exitDecisions.items.properties;
 assert.equal(properties.continuation,undefined);assert.equal(request.productionSnapshot.feedbackResultVersion,v1);
});

const state={key:'bridge/weight',value:'仍承重',authority:'SOURCE',sourceRefs:['s1']};
const unit=(id,exitState)=>({id,scene:'山谷',exitState,shots:[{id:id+'-s',picture:exitState}]});
function receiptFixture(version=v2){
 const base={schemaVersion:'performance-core-v4',units:['u1','u2','u3'].map(id=>unit(id,'桥面仍承重。')),fantasyRealization:[]};
 const feedback={relation:'DIRECT',entry:[],exit:[structuredClone(state)],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]};
 const candidate={id:'old',attemptId:'a1',status:'adopted',draft:base,productionFeedback:feedback};
 const run={adopted:[{candidateId:'old',packageIds:['p'],draft:base}],candidates:[candidate],operations:[{attemptId:'a1',productionSnapshot:{touchesEnding:true,materials:[]}}]};
 const basis=freezeFeedbackBasis(run,base,['p'],{touchesEnding:true,version}),draft=structuredClone(base);
 const request={stage:'finish',previousDraft:{...base,feedbackBasis:basis},productionSnapshot:{feedbackResultVersion:version}};
 const row={key:state.key,decision:'KEEP',replacementKey:'',reason:'本次明确复核末态',evidence:[{unitId:'u3',shotId:'',field:'exitState',quote:'桥面仍承重'}],continuation:[]};
 const raw={...feedback,exit:[],resultRevision:{baseSignature:basis.signature,exitDecisions:[row],materialDecisions:[]},entryEvidence:[]};
 return {request,raw,draft,row};
}
const project=f=>projectResultFeedback({request:f.request,feedback:f.raw,draft:f.draft,candidateId:'new',attemptId:'a2',packageIds:['p']});
const earlier={unitId:'u1',shotId:'',field:'exitState',quote:'桥面仍承重'};
const unrelatedTail={unitId:'u3',shotId:'',field:'scene',quote:'山谷'};

test('v2 actual final same-state evidence with an explicit empty continuation remains valid',()=>{
 const f=receiptFixture(),before=structuredClone(f);assert.deepEqual(project(f).exit,[state]);assert.deepEqual(f,before);
});
for(const value of [undefined,null])test(`v2 rejects ${value===null?'null':'missing'} continuation even with valid final evidence`,()=>{
 const f=receiptFixture();if(value===undefined)delete f.row.continuation;else f.row.continuation=value;
 assert.throws(()=>project(f),{code:'PRODUCTION_FEEDBACK_RESULT'});
});
test('v2 KEEP cannot treat an unrelated final quote as proof of the kept state',()=>{
 const f=receiptFixture();f.row.evidence=[unrelatedTail];assert.throws(()=>project(f),{code:'PRODUCTION_FEEDBACK_RESULT'});
});
test('v2 earlier KEEP cannot bypass full continuation by adding an unrelated final quote',()=>{
 const f=receiptFixture();f.draft.units[1].exitState='桥面已经坍塌。';f.draft.units[2].exitState='众人站在门口。';
 f.row.evidence=[earlier,unrelatedTail];assert.throws(()=>project(f),{code:'PRODUCTION_FEEDBACK_RESULT'});
});
for(const decision of ['REPLACE','REMOVE'])test(`v2 ${decision} rejects mixed earlier and final evidence`,()=>{
 const f=receiptFixture();f.row.decision=decision;f.row.evidence=[earlier,{unitId:'u3',shotId:'',field:'exitState',quote:'桥面仍承重'}];
 if(decision==='REPLACE'){f.row.replacementKey='bridge/new';f.raw.exit=[{...structuredClone(state),key:'bridge/new',value:'已撤除'}];}
 assert.throws(()=>project(f),{code:'PRODUCTION_FEEDBACK_RESULT'});
});
test('v1 keeps its historical final-unit quotation rule without acquiring v2 continuation requirements',()=>{
 const f=receiptFixture(v1);delete f.row.continuation;f.row.evidence=[unrelatedTail];
 assert.deepEqual(project(f).exit,[state]);
 f.row.evidence=[earlier,unrelatedTail];assert.throws(()=>project(f),{code:'PRODUCTION_FEEDBACK_RESULT'});
});
