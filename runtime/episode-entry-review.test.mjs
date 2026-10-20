import test from 'node:test';
import assert from 'node:assert/strict';
import {makeBoundaryContext,validateBoundaryReview,reviewedBoundaryResolution,reconcileBoundary} from './episode-boundary.mjs';
import {digest} from './storyboard-v4/core/shared.mjs';
import {baseDraftHash} from './storyboard-v4/core/delta.mjs';

const seal=body=>({...body,signature:digest(body)});
function fixture({design=false,restore=false}={}){
 const selected={runId:'previous',episode:1,sourceVersion:'sv1',selectionRevision:1};
 const priorDraft={schemaVersion:'performance-core-v4',units:[{id:'early',initialState:'甲用健手撑着石阶。',shots:[{id:'early-s1',picture:'甲用健手撑住石阶，未起身。'}]},{id:'tail',initialState:'甲站在军前，乙骑马来到身旁。',shots:[{id:'tail-s1',picture:'金钟仍罩住谷口，箭矢弹开。'}]}],fantasyRealization:[]};
 const state={key:design?'甲/入口姿态':'金钟/存在',value:design?'甲站在军前，尚未上马。':'谷中金钟可见。',authority:design?'DESIGN':'SOURCE',sourceRefs:design?[]:['s1']};
 const seed={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'sv1',fromEpisode:1,toEpisode:2,adjacentEpisode:true,previousSource:{episode:1,text:'金钟仍在。',sourceTextHash:'prior-text'},currentOpening:{episode:2,text:'金钟可见。',sourceTextHash:'current-text'}};
 const actual={...selected,validated:true,version:'actual-v1',unit:priorDraft.units.at(-1),states:design||restore?[]:[{...state,value:'金钟持续存在，箭矢未穿入。'}]};
 const context=makeBoundaryContext({seed,selected,actual});
 const source={sourceRows:[{id:'s1',kind:'action',text:'△金钟仍在。'}],contextRows:[],dialogue:[]};
 const draft={schemaVersion:'performance-core-v4',units:[{id:'opening',initialState:design?'甲站在军前，尚未上马。':'金钟罩住谷口，甲撑着石阶。',shots:[{id:'opening-s1',picture:design?'甲从站立姿态踩镫上马。':'金钟仍可见，甲用手撑阶站起。'}]}],fantasyRealization:[]};
 const feedback={relation:'DIRECT',entry:restore?[]:[state],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]};
 const evidenceContext=seal({version:'adopted-entry-context-v1',selected,actualVersion:actual.version,sourceTextHash:'prior-text',sourceHash:'prior-source',draftHash:digest(priorDraft),lineageHash:'prior-lineage',draft:priorDraft});
 const restored={key:'甲/入口姿态',value:'撑着石阶。',authority:'DESIGN',sourceRefs:[]};
 const entryBasis=seal({version:'production-entry-basis-v1',draftHash:baseDraftHash(draft),claims:restore?[{candidateId:'paid-earlier',attemptId:'paid-attempt',entry:restored}]:[]});
 const quote=(unitId,shotId,field,value)=>({unitId,shotId,field,quote:value});
 const entryRestorations=restore?[{key:restored.key,candidateId:'paid-earlier',reason:'完整原稿与本稿仍消费撑阶入口，不能以漏报消除依赖。',currentEvidence:[quote('opening','','initialState','甲撑着石阶')]}]:[];
 const key=restore?restored.key:state.key,value=restore?restored.value:state.value;
 const proofs=[{key,entryValue:value,verdict:'CONSISTENT',reason:'逐项读完整前稿和本稿，正证支持同一入口；不补造actual状态。',priorEvidence:restore?[quote('early','early-s1','picture','甲用健手撑住石阶，未起身')]:design?[quote('tail','','initialState','甲站在军前')]:[quote('tail','tail-s1','picture','金钟仍罩住谷口，箭矢弹开')],currentEvidence:[quote('opening','opening-s1','picture',design?'甲从站立姿态踩镫上马':restore?'甲用手撑阶站起':'金钟仍可见')]}];
 const actualDecisions=actual.states.map(s=>({key:s.key,decision:'CONSUMED',entryKey:state.key,reason:'本稿继续消费已核同一状态',priorEvidence:proofs[0].priorEvidence,currentEvidence:proofs[0].currentEvidence}));
 const review={version:'boundary-entry-review-v3',checkSignature:digest({version:context.versionId,feedback}),contextVersion:context.versionId,actualVersion:actual.version,sourceHash:digest(source),draftHash:baseDraftHash(draft),evidenceContextSignature:evidenceContext.signature,basisSignature:entryBasis.signature,entryRestorations,entryRetirements:[],actualDecisions,proofs};
 return {context,feedback,source,draft,evidenceContext,entryBasis,review};
}

test('generic carried evidence supports legacy equivalence, missing DESIGN and restored consumption without editing paid facts',()=>{
 for(const options of [{},{design:true},{restore:true}]){
  const f=fixture(options),before=structuredClone(f);
  const review=validateBoundaryReview(f.review,f),check=reconcileBoundary({...f,review});
  assert.ok(['MATCHED','NOT_CONSUMED'].includes(check.status),check.status);
  assert.ok(check.entryEvidenceReviewId);
  if(options.restore)assert.deepEqual(check.restoredEntryKeys,['甲/入口姿态']);
  assert.deepEqual(f,before,'derived evidence cannot rewrite source, actual, feedback or draft');
 }
});

function matchingEntryFixture(design){
 const f=fixture({design});
 f.context=makeBoundaryContext({...f.context,actual:{...f.context.actual,states:structuredClone(f.feedback.entry)}});
 Object.assign(f.review,{contextVersion:f.context.versionId,checkSignature:digest({version:f.context.versionId,feedback:f.feedback}),actualDecisions:[{key:f.feedback.entry[0].key,decision:'CONSUMED',entryKey:f.feedback.entry[0].key,reason:'开场直接消费完全相同的实际入口',priorEvidence:f.review.proofs[0].priorEvidence,currentEvidence:f.review.proofs[0].currentEvidence}]});
 return f;
}
test('matching SOURCE and DESIGN entries may carry additional valid proofs without deleting native evidence',()=>{
 for(const design of [false,true]){
  const f=matchingEntryFixture(design),before=structuredClone(f),review=validateBoundaryReview(f.review,f);
  assert.deepEqual(review.proofs,f.review.proofs);assert.equal(reconcileBoundary({...f,review}).status,'MATCHED');assert.deepEqual(f,before);
 }
});
test('additional proofs must still bind a known entry and valid opening evidence, and cannot hide uncertainty or conflict',()=>{
 for(const change of [f=>f.review.proofs[0].key='unrelated',f=>f.review.proofs[0].entryValue='偷换原值',f=>f.review.proofs[0].priorEvidence=[],f=>f.review.proofs[0].currentEvidence=[{...f.review.proofs[0].currentEvidence[0],quote:'不存在'}],f=>f.review.proofs[0].verdict='UNRESOLVED',f=>f.review.proofs[0].verdict='CONFLICT',f=>f.review.proofs.push(structuredClone(f.review.proofs[0]))]){
  const f=matchingEntryFixture(true);change(f);assert.throws(()=>validateBoundaryReview(f.review,f),{code:'PRODUCTION_ENTRY_EVIDENCE'});
 }
 const required=fixture({design:true});required.review.proofs=[];assert.throws(()=>validateBoundaryReview(required.review,required),{code:'PRODUCTION_ENTRY_EVIDENCE'});
});
test('additional matching proof cannot substitute for a required missing-state proof',()=>{
 const f=matchingEntryFixture(true),missing={...f.feedback.entry[0],key:'甲/仍未上马'};
 f.feedback.entry.push(missing);f.review.checkSignature=digest({version:f.context.versionId,feedback:f.feedback});
 assert.throws(()=>validateBoundaryReview(f.review,f),{code:'PRODUCTION_ENTRY_EVIDENCE'});
 f.review.proofs.push({...structuredClone(f.review.proofs[0]),key:missing.key});
 assert.equal(validateBoundaryReview(f.review,f).proofs.length,2);
});

test('generic evidence expires on source, selected draft, lineage or current draft drift and never clears hard conflicts',()=>{
 for(const change of [f=>f.source.sourceRows[0].text='不同原文',f=>f.context.actual.version='new-tail',f=>f.evidenceContext.draft.units[0].initialState='改稿',f=>f.evidenceContext.lineageHash='other',f=>f.draft.units[0].initialState='另一入口',f=>f.feedback.conflicts.push({key:'金钟/存在',problem:'真实冲突',sourceRefs:['s1']}),f=>f.context.agreements.push({key:'金钟/存在',value:'已破碎',authority:'DESIGN'})]){
  const f=fixture();change(f);assert.throws(()=>validateBoundaryReview(f.review,f));
 }
 const unproved=fixture({design:true});unproved.review.proofs[0].priorEvidence=[];
 assert.throws(()=>validateBoundaryReview(unproved.review,unproved));
 const stale=fixture({restore:true});stale.review.entryRestorations[0].candidateId='not-paid';assert.throws(()=>validateBoundaryReview(stale.review,stale));
 const unknown=fixture({design:true});unknown.review.proofs[0].verdict='UNRESOLVED';
 const review=validateBoundaryReview(unknown.review,unknown);assert.equal(reconcileBoundary({...unknown,review}).status,'UNRESOLVED');
});

test('expired legacy restoration keeps the omitted paid dependency closed instead of reverting to NOT_CONSUMED',()=>{
 const f=fixture({restore:true}),review=validateBoundaryReview(f.review,f),before=reconcileBoundary({...f,review});
 assert.equal(reconcileBoundary({...f,review:null}).status,'NOT_CONSUMED','unmigrated old requests do not silently acquire the new coverage contract');
 f.evidenceContext.lineageHash='changed-adoption';
 const applied=reviewedBoundaryResolution(f.context,f.feedback,[review],f.source,null,f);
 assert.equal(applied,null);
 const after=reconcileBoundary({...f,previousCheck:before,review:applied,reviews:[review]});
 assert.equal(after.status,'UNRESOLVED');
 assert.deepEqual(after.pendingEntryKeys,['甲/入口姿态']);
 assert.equal(reconcileBoundary({...f,review:null,previousCheck:after,entryReviewRequired:true}).status,'UNRESOLVED');
});

test('legacy same-key entry cannot change a paid SOURCE or DESIGN authority through free evidence review',()=>{
 const f=fixture({design:true});
 const {signature,...body}=f.entryBasis;
 f.entryBasis=seal({...body,claims:[{candidateId:'paid-earlier',attemptId:'paid-attempt',entry:{...f.feedback.entry[0],authority:'SOURCE',sourceRefs:['s1']}}]});
 f.review.basisSignature=f.entryBasis.signature;
 assert.throws(()=>validateBoundaryReview(f.review,f),{code:'PRODUCTION_ENTRY_EVIDENCE'});
});

test('new empty-entry proof still expires closed and the requirement is independent of native proof availability',()=>{
 const f=fixture({design:true});f.feedback.entry=[];f.review.proofs=[];
 f.review.checkSignature=digest({version:f.context.versionId,feedback:f.feedback});
 const review=validateBoundaryReview(f.review,f),before=reconcileBoundary({...f,review,entryReviewRequired:true});
 assert.equal(before.status,'NOT_CONSUMED');
 const {signature,...body}=f.evidenceContext;f.evidenceContext=seal({...body,lineageHash:'new-adoption'});
 const applied=reviewedBoundaryResolution(f.context,f.feedback,[review],f.source,null,f);
 assert.equal(applied,null);
 const after=reconcileBoundary({...f,review:applied,previousCheck:before,entryReviewRequired:true});
 assert.equal(after.status,'UNRESOLVED');
 const legacy=reconcileBoundary({...f,review:null});assert.equal(legacy.status,'NOT_CONSUMED');
 assert.equal(reconcileBoundary({...f,review:null,previousCheck:legacy,entryReviewRequired:true}).status,'UNRESOLVED');
});
