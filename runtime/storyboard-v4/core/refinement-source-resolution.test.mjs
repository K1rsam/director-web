import test from 'node:test';
import assert from 'node:assert/strict';
import {getRefinementConflictReview,recordRefinementSourceResolution,refinementProductionFeedback} from './refinement-source-resolution.mjs';

function fixture(){
 const d={source:{sourceRows:[{id:'s1',text:'巨狼的毛发如黑夜般深邃。'}]},production:{},web:{}};
 const candidate={productionFeedback:{needs:[],conflicts:[{key:'color',problem:'工作单误写白狼，候选保留原文黑狼。',sourceRefs:['s1']}]}};
 return {d,candidate};
}
const decision=(d,candidate)=>({conflictHash:getRefinementConflictReview(d,candidate).conflictHash,reason:'工作单颜色笔误；已核对原文与候选，候选为黑狼，保留原文。'});
test('source-note resolution is explicit, bound to full evidence and keeps the raw feedback',()=>{
 const {d,candidate}=fixture(),original=structuredClone(candidate.productionFeedback),review=getRefinementConflictReview(d,candidate);
 assert.equal(review.items[0].sources[0].text,d.source.sourceRows[0].text);
 recordRefinementSourceResolution(d,candidate,decision(d,candidate));
 assert.deepEqual(candidate.productionFeedback,original);
 assert.deepEqual(refinementProductionFeedback(d,candidate).conflicts,[]);
 assert.equal(candidate.refinementSourceResolution.kind,'work_order_note_error');
 candidate.productionFeedback.conflicts[0].problem+='另一个冲突';
 assert.equal(refinementProductionFeedback(d,candidate).conflicts.length,1);
});
test('missing evidence, source drift, stale conflict identities and empty reasons fail closed',()=>{
 for(const mutation of [
  (d,c)=>{c.productionFeedback.conflicts[0].sourceRefs=['future:s1'];},
  (d,c)=>{c.productionFeedback.needs=[{blocking:true}];},
  d=>{d.production.outgoingAgreements=[{key:'locked'}];},
  d=>{d.production.boundary={selected:{id:'accepted-tail'}};},
  d=>{d.web.binding={productionChain:{mode:'CHAIN'}};},
 ]){const {d,candidate}=fixture();mutation(d,candidate);assert.equal(getRefinementConflictReview(d,candidate),null);assert.throws(()=>recordRefinementSourceResolution(d,candidate,{conflictHash:'0'.repeat(64),reason:'按原文'}),{code:'REFINEMENT_CONFLICT_REVIEW'});}
 for(const change of [value=>({...value,conflictHash:'0'.repeat(64)}),value=>({...value,reason:' '}),value=>({...value,override:true})]){
  const {d,candidate}=fixture();assert.throws(()=>recordRefinementSourceResolution(d,candidate,change(decision(d,candidate))),{code:'REFINEMENT_CONFLICT_REVIEW'});assert.equal(candidate.refinementSourceResolution,undefined);
 }
 const {d,candidate}=fixture();recordRefinementSourceResolution(d,candidate,decision(d,candidate));d.source.sourceRows[0].text='原文已修改';assert.equal(refinementProductionFeedback(d,candidate).conflicts.length,1);
});
