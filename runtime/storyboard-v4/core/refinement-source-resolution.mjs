import {digest,fail} from './shared.mjs';

export const REFINEMENT_SOURCE_RESOLUTION_VERSION='refinement-source-resolution-v1';
const hasText=value=>typeof value==='string'&&Boolean(value.trim());
function reviewable(d,candidate){
 const feedback=candidate?.productionFeedback,conflicts=feedback?.conflicts;
 if(!Array.isArray(conflicts)||!conflicts.length||feedback.needs?.some(n=>n.blocking)
  ||d.web?.binding?.productionChain?.mode==='CHAIN'||d.production?.boundary?.selected||d.production?.outgoingAgreements?.length)return null;
 const rows=new Map((d.source?.sourceRows||[]).map(row=>[row.id,row]));
 if(conflicts.some(c=>!hasText(c.key)||!hasText(c.problem)||!Array.isArray(c.sourceRefs)||!c.sourceRefs.length||c.sourceRefs.some(id=>!hasText(rows.get(id)?.text))))return null;
 return {version:REFINEMENT_SOURCE_RESOLUTION_VERSION,conflictHash:digest(conflicts),items:conflicts.map(c=>({key:c.key,problem:c.problem,sources:c.sourceRefs.map(id=>({id,text:rows.get(id).text}))}))};
}

// This is an explicit source-note correction, not a machine claim that the
// candidate is semantically correct. Original conflicts and request stay saved.
export function refinementProductionFeedback(d,candidate){
 const feedback=candidate?.productionFeedback,resolution=candidate?.refinementSourceResolution,review=reviewable(d,candidate);
 if(!review||resolution?.version!==REFINEMENT_SOURCE_RESOLUTION_VERSION||resolution.kind!=='work_order_note_error'
  ||resolution.conflictHash!==review.conflictHash||resolution.sourceHash!==digest(d.source)||!hasText(resolution.reason))return feedback;
 return {...feedback,conflicts:[]};
}
export function getRefinementConflictReview(d,candidate){
 if(refinementProductionFeedback(d,candidate)!==candidate?.productionFeedback)return null;
 return reviewable(d,candidate);
}
export function recordRefinementSourceResolution(d,candidate,value){
 const review=getRefinementConflictReview(d,candidate);
 if(!review||!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!['conflictHash','reason'].includes(key))
  ||value.conflictHash!==review.conflictHash||!hasText(value.reason)||value.reason.length>1200||value.reason.includes('\0'))
  fail('REFINEMENT_CONFLICT_REVIEW','须核对当前原句和候选，说明工作单笔误；不能覆盖缺料、真实约束冲突或过期证据。');
 candidate.refinementSourceResolution={version:REFINEMENT_SOURCE_RESOLUTION_VERSION,kind:'work_order_note_error',conflictHash:review.conflictHash,sourceHash:digest(d.source),
  sourceRefs:[...new Set(review.items.flatMap(item=>item.sources.map(row=>row.id)))],reason:value.reason.trim(),at:new Date().toISOString()};
}
