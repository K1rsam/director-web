import {digest,fail} from './shared.mjs';

export const DIALOGUE_MAPPING_REVIEW_KIND='CANDIDATE_DIALOGUE_MAPPING';
const VERSION='candidate-dialogue-mapping-review-v1';
const text=x=>typeof x==='string'&&Boolean(x.trim())&&!x.includes('\0');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>keys.includes(k));
const basis=d=>digest({plan:d.plan,settings:d.settings,rulesSnapshot:d.rulesSnapshot,epoch:d.epoch});
const payload=({id,at,...value})=>value;
const locate=(items,id,bad)=>{const hits=items.filter(x=>x.id===id);if(hits.length!==1)bad('对白映射须唯一对应原单元与镜头。');return hits[0];};

// This is a human-approved catalog repair, not a parser migration or model retry.
export function projectDialogueMappingReview(d,candidate,op,value,approval,derivedCandidateId){
 const bad=message=>fail('SOURCE_RESOLUTION_DIALOGUE_MAPPING',message);
 if(!exact(value,['kind','candidateId','sourceHash','planHash','candidateHash','operationHash','unresolvedHash','mappings'])||value.kind!==DIALOGUE_MAPPING_REVIEW_KIND
  ||value.candidateId!==candidate?.id||value.sourceHash!==digest(d.source)||value.planHash!==basis(d)||value.candidateHash!==digest(candidate)||value.operationHash!==digest(op)
  ||value.unresolvedHash!==digest(candidate?.draft?.unresolved))bad('原文、计划、冻结作业、原候选或未决项已变化。');
 if(!exact(approval,['actorId','reference','answer'])||!['actorId','reference','answer'].every(k=>text(approval[k]))||approval.reference.length>500||approval.answer.length>2000)bad('须有独立明确人类批准及可追溯引用。');
 if(op?.stage!=='finish'||op.executionProjectionVersion||op.feedbackRepair||op.purpose||op.paidRepair||candidate.status!=='needs_repair'||candidate.resolvedBy||!candidate.draft
  ||candidate.errors?.length||!candidate.validation?.errors?.length||candidate.validation.errors.some(e=>e.code!=='UNRESOLVED')||candidate.draft.unresolved?.length!==1
  ||op.packageIds?.length!==d.plan?.workPackages.length||d.plan.workPackages.some(w=>!op.packageIds.includes(w.id)))bad('仅可恢复完整整编中唯一的对白映射未决项；其它质量问题不能借此核销。');
 if(!Array.isArray(value.mappings)||value.mappings.length!==1)bad('本次只恢复一个明确未决源句的精确映射。');
 const draft=structuredClone(candidate.draft),dialogue=[],seenRows=new Set(),seenShots=new Set();
 const ranks=new Map(draft.units.flatMap(u=>u.shots).map((s,i)=>[s.id,i]));let previousShot=-1,previousRow=-1;
 for(const mapping of value.mappings){
  if(!exact(mapping,['sourceRef','parts'])||!text(mapping.sourceRef)||seenRows.has(mapping.sourceRef)||!Array.isArray(mapping.parts)||!mapping.parts.length||mapping.parts.length>20)bad('源行或对白分段缺失、重复或越界。');
  seenRows.add(mapping.sourceRef);const index=d.source.sourceRows.findIndex(r=>r.id===mapping.sourceRef),row=d.source.sourceRows[index];
  const match=row?.text.match(/^([^\r\n（(：:]{1,60})[（(](OS|VO)[）)]([^\r\n]+)(?:\r?\n)?$/);
  if(!match||row.kind!=='action'||row.evidenceRole==='guidance'||index<=previousRow||d.source.dialogue.some(q=>(q.sourceIds||[q.rowId]).includes(row.id)))bad('仅接收原文已明示OS或VO、却未进入旧对白目录的完整源行；不推断声道或改源。');
  previousRow=index;const quote=match[3],lineId=row.id+':dialogue-mapping-v1';let cursor=0;
  const sourceCoordinates=[row.id,...Object.entries(op.modelCoordinates?.aliases||{}).filter(([,ref])=>ref===row.id).map(([alias])=>alias)],shotCoordinates=mapping.parts.map(p=>p.shotId).join('—');
  const unresolved=candidate.draft.unresolved[0];
  if(!sourceCoordinates.some(ref=>unresolved.coordinate===ref+'/'+shotCoordinates)||!/(?:dialogue|对白映射)/.test(unresolved.problem))bad('唯一未决项必须精确对应本次源句和全部镜头的对白映射，不能删除其它未决问题。');
  for(const part of mapping.parts){
   if(!exact(part,['unitId','shotId','quoteRange'])||!text(part.unitId)||!text(part.shotId)||seenShots.has(part.shotId)
    ||!Array.isArray(part.quoteRange)||part.quoteRange.length!==2||!part.quoteRange.every(Number.isSafeInteger)||part.quoteRange[0]!==cursor||part.quoteRange[1]<=cursor||part.quoteRange[1]>quote.length)bad('对白须逐字连续且仅一次覆盖原句，不能夹带新创作字段。');
   const unit=locate(draft.units,part.unitId,bad),shot=locate(unit.shots,part.shotId,bad),piece=quote.slice(...part.quoteRange),rank=ranks.get(shot.id);
   const actor=match[1]+match[2],sound=typeof shot.sound==='string'&&shot.sound.startsWith(actor)?shot.sound.slice(actor.length):'';
   const timing=sound.match(/^(?:于本单元(\d+(?:\.\d+)?)秒起声，持续到(\d+(?:\.\d+)?)秒(?:并直接接下镜)?|从本单元(\d+(?:\.\d+)?)秒连续接到(\d+(?:\.\d+)?)秒)：/);
   const rest=timing?sound.slice(timing[0].length):'',performance=rest.startsWith(piece+' ')?rest.slice(piece.length+1).match(/^([^。\r\n]+)。([\s\S]+)$/):null;
   const shotStart=unit.shots.slice(0,unit.shots.indexOf(shot)).reduce((n,s)=>n+s.duration,0),voiceStart=timing?Number((Number(timing[1]??timing[3])-shotStart).toFixed(6)):NaN,voiceEnd=timing?Number((Number(timing[2]??timing[4])-shotStart).toFixed(6)):NaN;
   if(rank<=previousShot||!shot.sourceRefs?.includes(row.id)||shot.dialogueParts?.length||!performance||!text(performance[1])||!text(performance[2])||performance[2].includes(piece)
    ||!Number.isFinite(voiceStart)||!Number.isFinite(voiceEnd)||voiceStart<0||voiceEnd<=voiceStart||voiceEnd>shot.duration)bad('原声音须已有明确单元发声窗、逐字原话及演法；只能精确转移该前缀并原样保留全部音效余文。');
   previousShot=rank;seenShots.add(shot.id);cursor=part.quoteRange[1];
   shot.sound=performance[2];shot.dialogueParts=[{lineId,text:piece,presentation:match[2],delivery:performance[1],voiceStart,voiceEnd}];
  }
  if(cursor!==quote.length)bad('原句仍有缺字、标点遗漏或重复。');
  dialogue.push({id:lineId,rowId:row.id,sourceIds:[row.id],line:row.line,speaker:match[1],channel:match[2],quote,cue:'',kind:'speech'});
 }
 delete draft.unresolved;
 const proof={version:VERSION,kind:DIALOGUE_MAPPING_REVIEW_KIND,value:structuredClone(value),approval:structuredClone(approval),derivedCandidateId,dialogue,projectedDraftHash:digest(draft),modelCalls:0};
 return {draft,dialogue,source:withMappedDialogue(d.source,dialogue),proof:{...proof,id:digest(proof),at:new Date().toISOString()}};
}

export function withMappedDialogue(source,dialogue){
 const rank=new Map(source.sourceRows.map((r,i)=>[r.id,i]));
 return {...source,dialogue:[...source.dialogue,...dialogue.filter(q=>rank.has(q.rowId))].sort((a,b)=>rank.get(a.rowId)-rank.get(b.rowId))};
}
export function validDialogueMappingReview(d,derived){
 const r=derived?.dialogueMappingReview;if(r?.version!==VERSION||r.kind!==DIALOGUE_MAPPING_REVIEW_KIND)return null;
 try{
  const original=d.candidates.find(c=>c.id===r.value.candidateId),op=d.operations.find(o=>o.attemptId===original?.attemptId);
  if(derived.status!=='adopted'||derived.derivedFrom!==original?.id||derived.attemptId!==original.attemptId||derived.raw!==original.raw||digest(derived.receipt)!==digest(original.receipt)
   ||digest(derived.modelOutput)!==digest(original.output)||r.id!==digest(payload(r))||r.derivedCandidateId!==derived.id||r.modelCalls!==0)return null;
  const projected=projectDialogueMappingReview(d,original,op,r.value,r.approval,derived.id);
  return projected.proof.id===r.id&&digest(derived.output)===digest(original.output)&&digest(derived.draft)===r.projectedDraftHash&&derived.validation?.errors?.length===0?projected:null;
 }catch{return null;}
}
export function reviewedDialogueSource(d){
 const additions=[];
 for(const entry of d.adopted||[]){const candidate=d.candidates.find(c=>c.id===entry.candidateId);if(!candidate?.dialogueMappingReview)continue;
  const result=validDialogueMappingReview(d,candidate);if(!result)fail('SOURCE_RESOLUTION_DIALOGUE_MAPPING_STALE','已采用对白映射凭证失效，不能沿用或忽略。');
  for(const q of result.dialogue)if(!additions.some(a=>a.id===q.id))additions.push(q);
 }
 return additions.length?withMappedDialogue(d.source,additions):d.source;
}
