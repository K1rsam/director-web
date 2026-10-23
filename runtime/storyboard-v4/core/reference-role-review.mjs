import {digest,fail} from './shared.mjs';
import {validDialogueMappingReview} from './dialogue-mapping-review.mjs';

export const REFERENCE_ROLE_REVIEW_VERSION='candidate-reference-role-review-v1';
export const REFERENCE_ROLE_REVIEW_KIND='CANDIDATE_REFERENCE_ROLES';
const text=x=>typeof x==='string'&&Boolean(x.trim())&&!x.includes('\0');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>keys.includes(k));
const unique=items=>Array.isArray(items)&&items.length>0&&items.every(text)&&new Set(items).size===items.length;
const planHash=d=>digest({plan:d.plan,settings:d.settings,rulesSnapshot:d.rulesSnapshot,epoch:d.epoch});
const proofPayload=({id,at,...payload})=>payload;
const units=output=>Array.isArray(output?.units)?output.units:(output?.replacements||[]).flatMap(g=>g.units||[]);
const locate=(items,id,bad)=>{const matches=items.filter(x=>x.id===id);if(matches.length!==1)bad('复核坐标必须唯一对应已保存的原单元与镜头。');return matches[0];};
function creative(draft){const value=structuredClone(draft);for(const u of value.units)for(const s of u.shots){delete s.sourceRefs;delete s.contextRefs;}return value;}
function move(shot,refs){shot.sourceRefs=shot.sourceRefs.filter(id=>!refs.includes(id));shot.contextRefs=[...new Set([...(shot.contextRefs||[]),...refs])];}

/** Human semantics, exact evidence transport. This never repairs creative text. */
export function projectReferenceRoleReview(d,candidate,op,value,approval,derivedCandidateId){
 const bad=message=>fail('SOURCE_RESOLUTION_REFERENCE_REVIEW',message);
 const keys=['kind','candidateId','sourceHash','planHash','candidateHash','operationHash','changes'];
 if(!exact(value,keys)||value.kind!==REFERENCE_ROLE_REVIEW_KIND||value.candidateId!==candidate.id
  ||value.sourceHash!==digest(d.source)||value.planHash!==planHash(d)||value.candidateHash!==digest(candidate)||value.operationHash!==digest(op))bad('引用复核的原文、计划、原候选或冻结作业已经变化。');
 if(!exact(approval,['actorId','reference','answer'])||!['actorId','reference','answer'].every(k=>text(approval[k]))||approval.reference.length>500||approval.answer.length>2000)bad('引用角色复核需要独立明确人类批准及可追溯引用。');
 if(op.stage!=='finish'||op.executionProjectionVersion||op.feedbackRepair||op.purpose||candidate.status!=='needs_repair'||candidate.resolvedBy||!candidate.draft
  ||candidate.errors?.length||!candidate.validation?.errors?.length||candidate.validation.errors.some(e=>e.code!=='EVENT_SOURCE')
  ||!op.previousDraft?.units?.length||d.candidates.some(c=>c.referenceRoleReview?.candidateId===candidate.id))bad('仅可复核未解决整编候选的事件引用角色，不能借此改稿、联修或反复核销。');
 if(op.packageIds?.length!==d.plan?.workPackages.length||d.plan.workPackages.some(w=>!op.packageIds.includes(w.id)))bad('引用角色复核仅接收完整本集整编，不局部切宽或重签已采用组。');
 if(!Array.isArray(value.changes)||!value.changes.length||value.changes.length>20)bad('引用复核须给出有限且精确的镜头坐标。');
 const output=structuredClone(candidate.output),draft=structuredClone(candidate.draft),seen=new Set(),anchors=[];
 for(const change of value.changes){
  if(!exact(change,['unitId','shotId','sourceRefs'])||!text(change.unitId)||!text(change.shotId)||!unique(change.sourceRefs)||change.sourceRefs.length>100||seen.has(change.shotId))bad('引用角色复核不能夹带改稿、重复坐标或空范围。');
  seen.add(change.shotId);
  const unit=locate(draft.units,change.unitId,bad),shot=locate(unit.shots,change.shotId,bad),event=d.plan?.events?.find(e=>e.id===unit.eventId);
  const priorUnit=locate(op.previousDraft.units,change.unitId,bad),prior=locate(priorUnit.shots,change.shotId,bad);
  const outputUnit=locate(units(output),change.unitId,bad),outputShot=locate(outputUnit.shots,change.shotId,bad);
  const spoken=new Set((shot.dialogueParts||[]).flatMap(part=>{const q=d.source.dialogue?.find(q=>q.id===part.lineId);return q?.sourceIds||[q?.rowId];}));
  if(!event||priorUnit.eventId!==unit.eventId||outputUnit.eventId!==unit.eventId)bad('事件归属不能由引用复核新增或扩宽。');
  for(const ref of change.sourceRefs){
   const row=d.source.sourceRows.find(r=>r.id===ref);
   if(!row||row.evidenceRole==='guidance'||spoken.has(ref)||event.sourceRefs.includes(ref)||!shot.sourceRefs.includes(ref)
    ||!outputShot.sourceRefs?.includes(ref)||!prior.contextRefs?.includes(ref)||prior.sourceRefs.includes(ref))bad('仅可把冻结基稿中已有的接续参考恢复为contextRefs，不能降格事件制作源、对白或未知来源。');
   anchors.push({unitId:unit.id,shotId:shot.id,sourceRef:ref,rowHash:digest(row)});
  }
  move(shot,change.sourceRefs);move(outputShot,change.sourceRefs);
  if(!shot.sourceRefs.length||!shot.sourceRefs.some(id=>event.sourceRefs.includes(id)))bad('复核后必须仍有本事件的真实制作源，contextRefs不替代覆盖。');
 }
 if(digest(creative(draft))!==digest(creative(candidate.draft)))bad('引用复核不能改变任何创作字段。');
 const proof={version:REFERENCE_ROLE_REVIEW_VERSION,...structuredClone(value),derivedCandidateId,approval:structuredClone(approval),anchors,
  projectedOutputHash:digest(output),projectedDraftHash:digest(draft),creativeHash:digest(creative(draft)),modelCalls:0};
 return {output,proof:{...proof,id:digest(proof),at:new Date().toISOString()}};
}

/** The old candidate is immutable; only a valid new receipt can resolve its debt. */
export function candidateResolvedBy(d,candidate){
 if(!candidate)return null;
 if(candidate.resolvedBy)return candidate.resolvedBy;
 for(const derived of d.candidates||[]){
  if(derived.dialogueMappingReview?.value?.candidateId===candidate.id&&validDialogueMappingReview(d,derived))return derived.id;
  const r=derived.referenceRoleReview;
  if(r?.candidateId!==candidate.id||r.version!==REFERENCE_ROLE_REVIEW_VERSION||r.kind!==REFERENCE_ROLE_REVIEW_KIND)continue;
  const op=d.operations?.find(o=>o.attemptId===candidate.attemptId);
  try{
   if(r.id===digest(proofPayload(r))&&r.modelCalls===0&&r.derivedCandidateId===derived.id&&derived.derivedFrom===candidate.id
    &&derived.status==='adopted'&&derived.attemptId===candidate.attemptId&&derived.raw===candidate.raw&&digest(derived.receipt??null)===digest(candidate.receipt??null)
    &&digest(derived.modelOutput)===digest(candidate.output)&&r.candidateHash===digest(candidate)&&r.operationHash===digest(op)
    &&r.sourceHash===digest(d.source)&&r.planHash===planHash(d)&&r.projectedOutputHash===digest(derived.output)&&r.projectedDraftHash===digest(derived.draft)
    &&r.creativeHash===digest(creative(derived.draft))&&Array.isArray(derived.validation?.errors)&&derived.validation.errors.length===0)return derived.id;
  }catch{/* A damaged or obsolete receipt never hides the original failure. */}
 }
 return null;
}
