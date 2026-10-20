import {digest,fail} from './storyboard-v4/core/shared.mjs';
import {PRODUCTION_SUPPLY_VERSION} from './production-supply.mjs';
import {EPISODE_EVIDENCE_VERSION,historicalSourceRequest} from './episode-evidence.mjs';
import {isFeedbackResultVersion,effectiveProductionFeedback,validateDraftEvidence} from './storyboard-v4/core/production-feedback-result.mjs';
import {ENTRY_REVIEW_VERSION,validateEntryReview,entryReviewEntries,nativeEntryReview} from './storyboard-v4/core/entry-evidence.mjs';

export const EPISODE_BOUNDARY_VERSION='episode-boundary-v1';
export const PRODUCTION_FEEDBACK_VERSION='production-feedback-v1';
export const PRODUCTION_FEEDBACK_CONTRACT_VERSION='production-feedback-design-v2';
export const PRODUCTION_FEEDBACK_VALIDATION_VERSION='production-feedback-coordinate-v2';
export const PRODUCTION_FEEDBACK_INHERITANCE_VERSION='production-feedback-inheritance-v2';
export const PRODUCTION_FEEDBACK_INHERITANCE_VERSIONS=['production-feedback-inheritance-v1',PRODUCTION_FEEDBACK_INHERITANCE_VERSION];
export const BOUNDARY_REVIEW_VERSION='boundary-review-v1';
export const BOUNDARY_SOURCE_REVIEW_VERSION='boundary-review-v2';
const BOUNDARY_CHECK_VERSION='boundary-check-entry-evidence-v5';
const text=x=>typeof x==='string'&&x.trim().length>0;
const relations=['DIRECT','TIME_JUMP','LOCATION_CHANGE','FLASHBACK','FANTASY','INDEPENDENT','UNKNOWN'];
const authorities=['SOURCE','DESIGN','CHARACTER_CLAIM','INTERPRETATION'];
const stateKey=s=>s.key;
const unique=a=>new Set(a).size===a.length;
const copy=x=>structuredClone(x);

// An actual tail is eligible only through the explicitly selected production chain.
// Neither most-recent-file nor episode number alone is an adoption decision.
export function makeBoundaryContext({seed,selected=null,actual=null,agreements=[],chainMode='SINGLE'}){
 if(seed?.schema!=='EPISODE_BOUNDARY_SEED_V1'||!seed.currentOpening?.text?.trim())fail('EPISODE_BOUNDARY_SOURCE','缺少可读取的跨集来源底稿。');
 const compatible=Boolean(actual&&selected&&actual.validated===true&&seed.adjacentEpisode===true
  &&actual.runId===selected.runId&&actual.episode===seed.fromEpisode&&actual.episode===selected.episode
  &&actual.sourceVersion===selected.sourceVersion&&actual.sourceVersion===seed.sourceVersion
  &&actual.selectionRevision===selected.selectionRevision);
 const context={version:EPISODE_BOUNDARY_VERSION,seed:copy(seed),selected:copy(selected),actual:compatible?copy(actual):null,
  agreements:copy(agreements),chainMode,mode:compatible?'ACTUAL':'PRELIMINARY'};
 context.versionId=digest(context);return context;
}
export function selectBoundaryForRequest(context,stage,touchesOpening,reviews=[],source){
 if(!context||stage!=='plan'&&!touchesOpening)return null;
 // Versions still bind the canonical tail/context; additions carry their own review provenance.
 const view=copy(context),states=reviewedBoundarySupplementStates(context,reviews);
 if(states.length)view.actual.states.push(...states);
 const observations=reviewedSourceObservations(context,reviews,source);
 if(observations.length)view.sourceObservations=observations;
 return view;
}
export function boundaryEvidenceRows(context,{factHeadings=false}={}){
 const rows=[];
 for(const evidence of [context?.seed?.previousSource,context?.seed?.currentOpening]){
  if(!evidence||typeof evidence.text!=='string')continue;
  for(const node of evidence.nodes||[]){
   const start=node.sourceRange?.start-evidence.sourceRange?.start,end=node.sourceRange?.end-evidence.sourceRange?.start;
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>evidence.text.length)continue;
   const action=node.target==='BODY'&&node.kind==='ACTION',heading=factHeadings&&node.target==='STRUCTURE'&&node.kind==='SCENE_HEADING';
   rows.push({id:`boundary:${evidence.episode}:${node.id}`,text:evidence.text.slice(start,end),kind:action?'action':heading?'metadata':'guidance',evidenceRole:action||heading?'source':'guidance'});
  }
 }
 return rows;
}

// The final assembled unit and its currently adopted owner are one inseparable receipt.
// A later local entrance repair must never overwrite the episode's exit with its own report.
export function selectedActualTail(run){
 const unit=run.assembly?.draft?.units?.at(-1);
 if(!unit||run.assembly.validation?.errors?.length||run.production?.pendingRepair||run.production?.blocking)return null;
 const owner=run.adopted?.find(a=>a.draft?.units?.some(u=>u.id===unit.id));
 const ids=new Set([owner?.candidateId,...(owner?.candidateIds||[])]);
 const candidate=run.candidates?.findLast(c=>ids.has(c.id)&&c.productionFeedback
  &&run.operations?.find(o=>o.attemptId===c.attemptId)?.productionSnapshot?.touchesEnding===true);
 const receipt=candidate?effectiveProductionFeedback(candidate):null;
 return {unit:copy(unit),states:copy((receipt?.exit||[]).filter(s=>['SOURCE','DESIGN'].includes(s.authority)))};
}

/** This is a model's interpretation receipt, never promoted to source evidence by itself. */
export function productionFeedbackFactRefs(request){
 const evidence=[...(request.source?.sourceRows||[]),...(request.source?.contextRows||[]),...boundaryEvidenceRows(request.episodeBoundary,{factHeadings:request.productionSnapshot?.supplyVersion===PRODUCTION_SUPPLY_VERSION})];
 const spoken=new Set((request.source?.dialogue||[]).flatMap(q=>q.sourceIds||[q.rowId]));
 return new Set(evidence.filter(r=>r.kind!=='guidance'&&r.evidenceRole!=='guidance'&&r.kind!=='dialogue'&&!spoken.has(r.id)).map(r=>r.id));
}

export function validateProductionFeedback(raw,request){
 const bad=(coordinate='productionFeedback',reason='字段或类型不完整')=>{const error=Object.assign(new Error(`${coordinate}：${reason}；已有正文保留，只修生产回执。`),{code:'PRODUCTION_FEEDBACK',coordinate});throw error;};
 if(!raw||!relations.includes(raw.relation)||!['entry','exit','sharedChoices','usedMaterialIds','needs','conflicts'].every(k=>Array.isArray(raw[k])))bad();
 const evidence=[...(request.source?.sourceRows||[]),...(request.source?.contextRows||[]),...boundaryEvidenceRows(request.episodeBoundary,{factHeadings:request.productionSnapshot?.supplyVersion===PRODUCTION_SUPPLY_VERSION})];
 const refs=new Set(evidence.map(r=>r.id));
 const currentRefs=new Set((request.source?.sourceRows||[]).map(r=>r.id));
 const sourceRefs=productionFeedbackFactRefs(request);
 const packages=new Set((request.plan?.workPackages||[]).map(w=>w.id));
 const materials=new Set(request.materialIds||[]);
 for(const name of ['entry','exit','sharedChoices']){
  const list=raw[name];
  if(list.some(s=>!s||typeof s!=='object')||!unique(list.map(stateKey)))bad(`productionFeedback.${name}`,'状态标识重复或类型错误');
  for(const [i,s] of list.entries()){
   const at=`productionFeedback.${name}[${i}]`;
   if(!text(s.key)||!text(s.value)||!authorities.includes(s.authority)||!Array.isArray(s.sourceRefs))bad(at,'状态字段不完整');
   for(const [j,ref] of s.sourceRefs.entries())if(!refs.has(ref)||s.authority==='SOURCE'&&!sourceRefs.has(ref))bad(`${at}.sourceRefs[${j}]`,`${ref}不是本次可用的${s.authority==='SOURCE'?'事实':'来源'}坐标`);
   if(s.authority==='SOURCE'&&!s.sourceRefs.length)bad(`${at}.sourceRefs`,'SOURCE缺少原文证据');
  }
 }
 for(const [i,s] of raw.sharedChoices.entries())if(s.authority!=='DESIGN')bad(`productionFeedback.sharedChoices[${i}].authority`,'跨集制作约定只能使用DESIGN；解释推断不能冒充已锁定的制作选择');
 if(request.productionSnapshot?.touchesEnding===false&&raw.exit.length)bad();
 if(request.productionSnapshot?.touchesEnding===true)for(const locked of request.productionSnapshot.outgoingAgreements||[]){
  if(!raw.exit.some(s=>s.key===locked.key&&s.value===locked.value)&&!raw.conflicts.some(c=>c.key===locked.key))bad();
 }
 if(!unique(raw.usedMaterialIds))bad('productionFeedback.usedMaterialIds','材料ID重复');
 for(const [i,id] of raw.usedMaterialIds.entries())if(!materials.has(id))bad(`productionFeedback.usedMaterialIds[${i}]`,`${id}不是本次已发送材料`);
 for(const [i,n] of raw.needs.entries()){
  const at=`productionFeedback.needs[${i}]`;
  if(!n||![1,2,3].includes(n.stage)||!text(n.target)||!text(n.purpose)||typeof n.blocking!=='boolean'||!Array.isArray(n.packageIds)||!Array.isArray(n.sourceRefs)||!n.sourceRefs.length)bad(at,'需求字段不完整');
  if(n.stage===1&&request.source?.context?.episodeEvidenceVersion===EPISODE_EVIDENCE_VERSION&&n.target.startsWith('HISTORY_SOURCE:')){
   const episode=Number(/^episode-(\d+)$/.exec(request.source.standardPackage?.binding?.sourceId??'')?.[1]??request.source.context.episodeNumber);
   let wanted;try{wanted=historicalSourceRequest(n.target,episode);}catch(error){bad(`${at}.target`,error.message);}
   const original=request.source.context.historicalSourceDirectory?.find(row=>row[0]===wanted.episode);
   if(!original||wanted.end!==null&&wanted.end>original[2])bad(`${at}.target`,'请求的历史集号不存在或范围超出原文；不能预读未来集');
  }
  for(const [j,id] of n.packageIds.entries())if(!packages.has(id))bad(`${at}.packageIds[${j}]`,`${id}不在本次工作包范围`);
  for(const [j,id] of n.sourceRefs.entries())if(!(n.stage===2?currentRefs:refs).has(id))bad(`${at}.sourceRefs[${j}]`,`${id}不在本次${n.stage===2?'制作原文':'可读来源'}范围`);
 }
 for(const [i,n] of raw.conflicts.entries())if(!n||!text(n.key)||!text(n.problem)||!Array.isArray(n.sourceRefs)||!n.sourceRefs.length||n.sourceRefs.some(id=>!refs.has(id)))bad(`productionFeedback.conflicts[${i}]`,'冲突缺少合法原文坐标');
 if(PRODUCTION_FEEDBACK_INHERITANCE_VERSIONS.includes(request.productionSnapshot?.feedbackInheritanceVersion)
   &&request.productionSnapshot.entryReviewVersion!==ENTRY_REVIEW_VERSION
   &&(request.productionSnapshot.feedbackInheritanceVersion==='production-feedback-inheritance-v1'||raw.relation==='DIRECT')){
  const actual=new Map((request.episodeBoundary?.actual?.states||[]).map(s=>[s.key,s.value]));
  for(const [i,s] of raw.entry.entries())if(actual.has(s.key)&&s.value!==actual.get(s.key))bad(`productionFeedback.entry[${i}].value`,'消费已提供的actual状态时须复用其key/value；真实原文矛盾另报conflicts，不改述入口');
 }
 return copy(raw);
}

// This is an explicitly authorized evidence review, never fuzzy text matching.
// The saved candidate remains intact; the review supplies a derived comparison only.
function boundaryReviewPayload(raw){
 return {version:raw.version,checkSignature:raw.checkSignature,contextVersion:raw.contextVersion,actualVersion:raw.actualVersion,sourceHashes:raw.sourceHashes,
  equivalences:raw.equivalences.map(({key,entryValue,actualValue,sourceRefs,reason})=>({key,entryValue,actualValue,sourceRefs:copy(sourceRefs),reason})),
  supplementalStates:raw.supplementalStates.map(({key,entryValue,value,authority,sourcePath,reason})=>({key,entryValue,value,authority,sourcePath,reason})),
  ...(raw.version===BOUNDARY_SOURCE_REVIEW_VERSION?{sourceHash:raw.sourceHash,sourceClaimReviews:raw.sourceClaimReviews.map(({key,claimRefs,factRefs,reason})=>({key,claimRefs:copy(claimRefs),factRefs:copy(factRefs),reason})),
   ...((raw.sourceEntryReviews||[]).length||(raw.resolvedDesignConflicts||[]).length||raw.relationReview?{contextHash:raw.contextHash}:{}),
   ...(raw.relationReview?{relationReview:{relation:raw.relationReview.relation,sourceRefs:copy(raw.relationReview.sourceRefs),reason:raw.relationReview.reason}}:{}),
   ...((raw.sourceEntryReviews||[]).length?{sourceEntryReviews:raw.sourceEntryReviews.map(({key,entryValue,sourceRefs,reason})=>({key,entryValue,sourceRefs:copy(sourceRefs),reason}))}:{}),
   ...((raw.resolvedDesignConflicts||[]).length?{resolvedDesignConflicts:raw.resolvedDesignConflicts.map(({key,originalContextVersion,originalActualVersion,oldActualValue,newActualValue,sourceRefs,reason})=>({key,originalContextVersion,originalActualVersion,oldActualValue,newActualValue,sourceRefs:copy(sourceRefs),reason}))}:{})}:{})};
}

export function predecessorFactRefs(context,source){
 const previous=context.seed.previousSource,refs=new Set(boundaryEvidenceRows(context).filter(r=>r.kind==='action'&&r.id.startsWith(`boundary:${context.seed.fromEpisode}:`)).map(r=>r.id));
 if(!previous)return refs;
 for(const row of source.contextRows||[]){
  const p=row.provenance,node=previous.nodes?.find(n=>n.id===p?.nodeId),origin=p?.origin;
  if(row.kind!=='action'||row.evidenceRole==='guidance'||p?.verifiedAgainst!=='STANDARD_BOUNDARY_NODE'||origin?.episode!==previous.episode
    ||node?.target!=='BODY'||node.kind!=='ACTION'||origin.start!==node.sourceRange?.start||origin.end>node.sourceRange.end||origin.end<=origin.start)continue;
  if(previous.text.slice(origin.start-previous.sourceRange.start,origin.end-previous.sourceRange.start).trim()===row.text.trim())refs.add(row.id);
 }
 return refs;
}

function sourceClaimEvidence(source){
 const spoken=new Set((source?.dialogue||[]).flatMap(q=>q.sourceIds||[q.rowId])),rows=source?.sourceRows||[];
 return {claims:new Set(rows.filter(r=>r.evidenceRole!=='guidance'&&(r.kind==='dialogue'||spoken.has(r.id))).map(r=>r.id)),
  facts:new Set(rows.filter(r=>r.evidenceRole!=='guidance'&&r.kind==='action'&&!spoken.has(r.id)).map(r=>r.id))};
}
function validSourceClaim(s,evidence){
 return text(s?.key)&&text(s.reason)&&Array.isArray(s.claimRefs)&&s.claimRefs.length>0&&Array.isArray(s.factRefs)&&s.factRefs.length>0
  &&unique([...s.claimRefs,...s.factRefs])&&s.claimRefs.every(id=>evidence.claims.has(id))&&s.factRefs.every(id=>evidence.facts.has(id));
}
// A reviewed reading travels as an interpretation, not a new rule or an actual state.
// Exact source/tail bindings expire it; old equivalence decisions never travel.
function reviewedSourceObservations(context,reviews,source){
 if(!source?.sourceRows||!reviews?.length||!context?.seed)return [];
 const sourceHashes={previous:context.seed.previousSource?.sourceTextHash,current:context.seed.currentOpening?.sourceTextHash};
 const evidence=sourceClaimEvidence(source),hard=new Set([...(context.agreements||[]),...(context.actual?.states||[])].map(stateKey)),notes=new Map();
 for(const raw of reviews){
  let review;try{review=boundaryReviewPayload(raw);if(raw.id!==digest(review))continue;}catch{continue;}
  if(review.version!==BOUNDARY_SOURCE_REVIEW_VERSION||review.contextVersion!==context.versionId||review.actualVersion!==(context.actual?.version??null)
    ||review.sourceHash!==digest(source.sourceRows)||digest(review.sourceHashes??null)!==digest(sourceHashes))continue;
  for(const s of review.sourceClaimReviews)if(!hard.has(s.key)&&validSourceClaim(s,evidence))notes.set(s.key,{key:s.key,sourceRefs:[...s.claimRefs,...s.factRefs],authority:'INTERPRETATION',handling:'PRESERVE_SOURCE',reason:s.reason,reviewId:raw.id});
  if(review.contextHash===digest(source.contextRows)){
   for(const s of review.sourceEntryReviews||[])if(!hard.has(s.key))notes.set(s.key,{key:s.key,value:s.entryValue,sourceRefs:copy(s.sourceRefs),authority:'SOURCE',handling:'SOURCE_BACKED_ENTRY_NOT_TAIL',reason:s.reason,reviewId:raw.id});
   if(review.relationReview)notes.set('episode-boundary/relation',{key:'episode-boundary/relation',value:review.relationReview.relation,sourceRefs:copy(review.relationReview.sourceRefs),authority:'INTERPRETATION',handling:'PRESERVE_SOURCE',reason:review.relationReview.reason,reviewId:raw.id});
  }
 }
 return [...notes.values()];
}

export function reviewedBoundaryResolution(context,feedback,reviews,source,originalContext,entryEvidence={}){
 if(!context||!feedback)return null;
 const signature=digest({version:context.versionId,feedback});
 for(const raw of (reviews||[]).toReversed())if(raw.checkSignature===signature){
  try{return validateBoundaryReview(raw,{context,feedback,source,originalContext,...entryEvidence});}catch{/* Expired or unrelated reviews never release a gate. */}
 }
 return null;
}
export function reviewedBoundaryConflictKeys(context,feedback,reviews,source,originalContext){
 const review=reviewedBoundaryResolution(context,feedback,reviews,source,originalContext);
 return [...(review?.sourceClaimReviews||[]),...(review?.resolvedDesignConflicts||[])].map(stateKey);
}

// Only the explicitly reviewed scene source path survives a new feedback signature.
// Its source and adopted-tail identity stay exact; old equivalence judgments do not travel.
export function reviewedBoundarySupplementStates(context,reviews=[]){
 if(!context?.actual?.validated)return [];
 const sourceHashes={previous:context.seed.previousSource?.sourceTextHash,current:context.seed.currentOpening?.sourceTextHash};
 if(!text(sourceHashes.previous)||!text(sourceHashes.current))return [];
 const actual=new Set(context.actual.states.map(s=>s.key)),states=new Map();
 for(const raw of reviews){
  let review;
  try{review=boundaryReviewPayload(raw);if(raw.id!==digest(review))continue;}catch{continue;}
 if(![BOUNDARY_REVIEW_VERSION,BOUNDARY_SOURCE_REVIEW_VERSION].includes(review.version)||!text(review.checkSignature)||review.contextVersion!==context.versionId||review.actualVersion!==context.actual.version||digest(review.sourceHashes??null)!==digest(sourceHashes))continue;
  for(const s of review.supplementalStates){
   if(!text(s.key)||actual.has(s.key)||s.authority!=='DESIGN'||s.sourcePath!=='actual.unit.scene'||!text(context.actual.unit?.scene)||s.value!==context.actual.unit.scene||!text(s.reason))continue;
   states.set(s.key,{key:s.key,value:s.value,authority:'DESIGN',sourceRefs:[],sourcePath:s.sourcePath,reviewId:raw.id});
  }
 }
 return [...states.values()];
}

export function validateBoundaryReview(raw,{context,feedback,source={},originalContext,...entryEvidence}){
 if(raw?.version===ENTRY_REVIEW_VERSION)return validateEntryReview(raw,{context,feedback,source,...entryEvidence,boundaryFacts:boundaryEvidenceRows(context,{factHeadings:true})});
 const bad=(reason,stale=false)=>fail(stale?'BOUNDARY_REVIEW_STALE':'BOUNDARY_REVIEW',reason);
 const sourceReview=raw?.version===BOUNDARY_SOURCE_REVIEW_VERSION;
 if(!raw||![BOUNDARY_REVIEW_VERSION,BOUNDARY_SOURCE_REVIEW_VERSION].includes(raw.version)||!Array.isArray(raw.equivalences)||!Array.isArray(raw.supplementalStates)||sourceReview&&(!Array.isArray(raw.sourceClaimReviews)||[raw.sourceEntryReviews,raw.resolvedDesignConflicts].some(x=>x!==undefined&&!Array.isArray(x))))bad('边界复核格式不完整。');
 const sourceEntries=sourceReview?raw.sourceEntryReviews||[]:[],designs=sourceReview?raw.resolvedDesignConflicts||[]:[];
 const relationReview=sourceReview?raw.relationReview:null,relation=relationReview?.relation??feedback?.relation;
 if(!context||!feedback||(!sourceReview||raw.equivalences.length||raw.supplementalStates.length)&&(!context.actual?.validated||relation!=='DIRECT'))bad('实际尾态比较仅允许复核当前已选定、已验证且故事直连的采用稿。');
 const signature=digest({version:context.versionId,feedback});
 const sourceHashes={previous:context.seed.previousSource?.sourceTextHash,current:context.seed.currentOpening?.sourceTextHash};
 if((!sourceReview||context.seed.fromEpisode!==null)&&!text(sourceHashes.previous)||!text(sourceHashes.current)||raw.checkSignature!==signature||raw.contextVersion!==context.versionId||raw.actualVersion!==(context.actual?.version??null)||digest(raw.sourceHashes??null)!==digest(sourceHashes))bad('边界复核与当前检查、来源或实际尾稿不匹配。',true);
 if(sourceReview&&raw.sourceHash!==digest(source.sourceRows))bad('说法复核绑定的本集原文已变化。',true);
 if((sourceEntries.length||designs.length||relationReview)&&raw.contextHash!==digest(source.contextRows))bad('入口复核绑定的前源证据已变化。',true);
 if(!sourceReview&&feedback.conflicts?.length)bad('明确原文冲突不得通过等价复核解除。');
 const agreements=new Map(context.agreements.map(s=>[s.key,s]));
 if([...feedback.entry,...(context.actual?.states||[])].some(s=>agreements.has(s.key)&&s.value!==agreements.get(s.key).value))bad('锁定制作约定的冲突不得通过等价复核解除。');
 const entry=new Map(feedback.entry.filter(s=>['SOURCE','DESIGN'].includes(s.authority)).map(s=>[s.key,s]));
 const actual=new Map((context.actual?.states||[]).map(s=>[s.key,s]));
 const evidence=[...(source.sourceRows||[]),...(source.contextRows||[]),...boundaryEvidenceRows(context,{factHeadings:true})];
 const spoken=new Set((source.dialogue||[]).flatMap(q=>q.sourceIds||[q.rowId]));
 const hardRefs=new Set(evidence.filter(r=>r.kind!=='guidance'&&r.evidenceRole!=='guidance'&&r.kind!=='dialogue'&&!spoken.has(r.id)).map(r=>r.id));
 const keys=[...raw.equivalences,...raw.supplementalStates].map(s=>s?.key),claims=sourceReview?raw.sourceClaimReviews:[];
 if(!keys.length&&!claims.length&&!sourceEntries.length&&!designs.length&&!relationReview||!unique([...keys,...claims.map(stateKey),...sourceEntries.map(stateKey),...designs.map(stateKey)]))bad('复核必须逐项指定不重复的受影响状态。');
 const previousRefs=predecessorFactRefs(context,source);
 if(relationReview){
  const currentActions=new Set((source.sourceRows||[]).filter(r=>r.kind==='action'&&r.evidenceRole!=='guidance'&&!spoken.has(r.id)).map(r=>r.id));
  if(feedback.relation!=='UNKNOWN'||!relations.includes(relation)||relation==='UNKNOWN'||!text(relationReview.reason)||!Array.isArray(relationReview.sourceRefs)||!unique(relationReview.sourceRefs)
    ||relationReview.sourceRefs.some(id=>!hardRefs.has(id))||!relationReview.sourceRefs.some(id=>previousRefs.has(id))||!relationReview.sourceRefs.some(id=>currentActions.has(id)))bad('关系复核只可补原回执的UNKNOWN，须同时绑定完整前源动作与本集动作，不改已确定关系或豁免硬冲突。');
 }
 for(const s of designs){
  const old=originalContext?.actual?.states?.find(x=>x.key===s?.key),tail=actual.get(s?.key),before=entry.get(s?.key),conflict=feedback.conflicts?.find(c=>c.key===s?.key);
  if(!context.actual?.validated||relation!=='DIRECT'||!originalContext?.actual?.validated||!old||old.authority!=='DESIGN'||tail?.authority!=='DESIGN'||agreements.has(s.key)||before&&(before.authority!=='DESIGN'||before.value!==old.value)
    ||originalContext.versionId!==s.originalContextVersion||originalContext.actual.version!==s.originalActualVersion||old.value!==s.oldActualValue||tail.value!==s.newActualValue||old.value===tail.value
    ||context.actual.version===originalContext.actual.version||digest(context.actual.unit)===digest(originalContext.actual.unit)
    ||digest([originalContext.selected,originalContext.seed.sourceVersion,originalContext.seed.previousSource?.sourceTextHash,originalContext.seed.currentOpening?.sourceTextHash])!==digest([context.selected,context.seed.sourceVersion,sourceHashes.previous,sourceHashes.current])
    ||!conflict||!text(s.reason)||!Array.isArray(s.sourceRefs)||!s.sourceRefs.length||!unique(s.sourceRefs)||s.sourceRefs.some(id=>!hardRefs.has(id))
    ||s.sourceRefs.length!==conflict.sourceRefs.length||conflict.sourceRefs.some(id=>!s.sourceRefs.includes(id))||!s.sourceRefs.some(id=>(source.sourceRows||[]).some(r=>r.id===id&&r.kind==='action'&&r.evidenceRole!=='guidance')))bad('旧设计冲突只能在原选定前稿的DESIGN已真实局部改稿、采用且源文不变后销账；SOURCE与锁定约定不得绕过。');
 }
 for(const s of sourceEntries){
  const before=entry.get(s?.key);
  if(!context.actual?.validated||relation!=='DIRECT'||!before||before.authority!=='SOURCE'||actual.has(s.key)||agreements.has(s.key)||s.entryValue!==before.value||!text(s.reason)
    ||!Array.isArray(s.sourceRefs)||!s.sourceRefs.length||!unique(s.sourceRefs)||s.sourceRefs.some(id=>!hardRefs.has(id))
    ||s.sourceRefs.length!==before.sourceRefs.length||before.sourceRefs.some(id=>!s.sourceRefs.includes(id))||!s.sourceRefs.some(id=>previousRefs.has(id)))bad('入口复核仅可引用完整验证的前集动作与本集事实；不能捏造实际尾态或覆盖锁定约定。');
 }
 const claimEvidence=sourceClaimEvidence(source);
 for(const s of claims){
  const conflict=feedback.conflicts?.find(c=>c.key===s?.key),refs=[...(s.claimRefs||[]),...(s.factRefs||[])];
  if(!validSourceClaim(s,claimEvidence)||!conflict||agreements.has(s.key)||actual.has(s.key)||entry.has(s.key)
    ||new Set(conflict.sourceRefs).size!==refs.length||conflict.sourceRefs.some(id=>!refs.includes(id)))bad('说法复核须完整绑定本集说法与动作；不能覆盖实际尾态、原文入口事实或锁定约定。');
 }
 if(sourceReview&&(feedback.conflicts||[]).some(c=>![...claims,...designs].some(s=>s.key===c.key)))bad('未核对的硬冲突仍须处理，不能一并解除。');
 for(const s of raw.equivalences){
  const before=entry.get(s?.key),tail=actual.get(s?.key);
  if(!before||!tail||!['SOURCE','DESIGN'].includes(tail.authority)||agreements.has(s.key)||before.value===tail.value||s.entryValue!==before.value||s.actualValue!==tail.value||!text(s.reason)||!Array.isArray(s.sourceRefs)||!s.sourceRefs.length||!unique(s.sourceRefs)||s.sourceRefs.some(id=>!hardRefs.has(id)))bad('等价复核须绑定原入口值、实际尾值和可读事实坐标，不能覆盖锁定约定。');
 }
 for(const s of raw.supplementalStates){
  const before=entry.get(s?.key);
  if(!before||before.authority!=='DESIGN'||actual.has(s.key)||agreements.has(s.key)||s.authority!=='DESIGN'||s.entryValue!==before.value||s.sourcePath!=='actual.unit.scene'||!text(context.actual.unit?.scene)||s.value!==context.actual.unit.scene||!text(s.reason))bad('缺状态仅可从实际采用单元的scene逐字补DESIGN空间依据；不能补造SOURCE事实。');
 }
 const currentFacts=new Set((source.sourceRows||[]).filter(r=>['action','metadata'].includes(r.kind)&&r.evidenceRole!=='guidance'&&!spoken.has(r.id)).map(r=>r.id));
 const needed=context.actual&&(!relationReview||relation==='DIRECT')?[...entry.values()].filter(s=>actual.has(s.key)?actual.get(s.key).value!==s.value
   :!(sourceReview&&s.authority==='SOURCE'&&s.sourceRefs?.length&&s.sourceRefs.every(id=>currentFacts.has(id)))).map(s=>s.key):[];
 const entryKeys=[...keys,...sourceEntries.map(stateKey),...designs.filter(s=>entry.has(s.key)).map(stateKey)];
 if(needed.length!==entryKeys.length||needed.some(key=>!entryKeys.includes(key)))bad('复核须完整覆盖当前差异和缺状态，不能删入口依赖或夹带无关更改。');
 const result=boundaryReviewPayload({...raw,checkSignature:signature,contextVersion:context.versionId,actualVersion:context.actual?.version??null,sourceHashes});
 const id=digest(result);if(raw.id&&raw.id!==id)bad('已保存复核的身份不符。',true);
 return {...result,id};
}

// Proof comes from the already planned finishing call, not a new paid reviewer.
// This does NOT add an actual state or reinterpret an old unproved receipt.
export function nativeBoundaryEntryReview({request,feedback,draft,context=request.episodeBoundary}){
 if(request.productionSnapshot?.entryReviewVersion===ENTRY_REVIEW_VERSION)return feedback.conflicts?.length?null:nativeEntryReview({request,feedback,draft,context,boundaryFacts:boundaryEvidenceRows(context,{factHeadings:request.productionSnapshot?.supplyVersion===PRODUCTION_SUPPLY_VERSION})});
 if(request.stage!=='finish'||!isFeedbackResultVersion(request.productionSnapshot?.feedbackResultVersion)
   ||!context?.actual?.validated||feedback.relation!=='DIRECT'||context.versionId!==request.episodeBoundary?.versionId
   ||digest(context.actual)!==digest(request.episodeBoundary.actual))return null;
 const raw=feedback.entryEvidence;if(!Array.isArray(raw))fail('PRODUCTION_FEEDBACK_RESULT','整编缺少SOURCE入口证据复核数组。');
 const previous=predecessorFactRefs(context,request.source),actual=new Set(context.actual.states.map(s=>s.key)),locked=new Set((context.agreements||[]).map(s=>s.key));
 const needed=feedback.entry.filter(s=>s.authority==='SOURCE'&&!actual.has(s.key)&&!locked.has(s.key)&&s.sourceRefs?.some(id=>previous.has(id)));
 if(!unique(raw.map(s=>s?.key))||raw.length!==needed.length||raw.some(r=>!needed.some(s=>s.key===r?.key)))fail('PRODUCTION_FEEDBACK_RESULT','入口证据复核须逐项覆盖有已验证前源的SOURCE漏键，不夹带DESIGN或已知actual。');
 for(const row of raw){
  if(!['CONSISTENT','CONFLICT','UNRESOLVED'].includes(row.verdict)||!text(row.reason))fail('PRODUCTION_FEEDBACK_RESULT','入口证据复核结论不完整。');
  if(row.verdict!=='UNRESOLVED'){
   validateDraftEvidence(row.priorEvidence,{units:[context.actual.unit]});validateDraftEvidence(row.currentEvidence,draft);
  }
  if(row.verdict==='CONFLICT'&&!feedback.conflicts.some(c=>c.key===row.key))fail('PRODUCTION_FEEDBACK_RESULT','入口复核发现矛盾时必须保留硬冲突。');
 }
 const keys=raw.filter(r=>r.verdict==='CONSISTENT').map(r=>r.key);
 if(!keys.length)return null;
 const body={version:request.productionSnapshot.feedbackResultVersion,contextVersion:context.versionId,actualVersion:context.actual.version,
  feedbackHash:digest(feedback),draftHash:digest(draft),sourceHash:digest(request.source),keys,proofs:copy(raw)};
 return {...body,id:digest(body)};
}

export function reconcileBoundary({context,feedback,previousCheck=null,review=null,reviews=[],source,originalContext,nativeEvidence,draft,evidenceContext,entryBasis,entryReviewRequired=false}){
 if(!context)return null;
 const signature=digest({version:context.versionId,feedback});
 const applied=review?validateBoundaryReview(review,{context,feedback,source,originalContext,draft,evidenceContext,entryBasis}):null;
 const supplements=reviewedBoundarySupplementStates(context,applied?[...reviews,applied]:reviews),supplementalReviewIds=[...new Set(supplements.map(s=>s.reviewId))];
 const spoken=new Set((source?.dialogue||[]).flatMap(q=>q.sourceIds||[q.rowId]));
 const currentRefs=new Set((source?.sourceRows||[]).filter(r=>['action','metadata'].includes(r.kind)&&r.evidenceRole!=='guidance'&&!spoken.has(r.id)).map(r=>r.id));
 const existing=new Set((context.actual?.states||[]).map(s=>s.key));
 // A new SOURCE entry backed entirely by this episode is not a claim that the
 // predecessor supplied it. Keep its provenance; never synthesize an actual state.
 const currentSourceKeys=(feedback?.entry||[]).filter(s=>s.authority==='SOURCE'&&!existing.has(s.key)&&s.sourceRefs?.length&&s.sourceRefs.every(ref=>currentRefs.has(ref))).map(stateKey);
 let nativeReview=null;try{if(nativeEvidence)nativeReview=nativeBoundaryEntryReview({...nativeEvidence,feedback,context});}catch{/* Missing, drifted or invalid proof never releases a gate. */}
 const entryReview=applied?.version===ENTRY_REVIEW_VERSION?applied:nativeReview?.version===ENTRY_REVIEW_VERSION?nativeReview:null;
 const entryKeys=entryReview?.proofs.filter(p=>p.verdict==='CONSISTENT').map(p=>p.key)||[];
 const restoredEntryKeys=entryReview?.entryRestorations.map(p=>p.key)||[];
 // A drifted review must not turn a restored paid dependency back into an empty
 // native receipt. Only a currently valid proof may restore or retire it.
 const pendingEntryKeys=entryReview||!entryReviewRequired&&!previousCheck?.entryEvidenceReviewId?[]:(entryBasis?.claims||[]).filter(c=>!(feedback?.entry||[]).some(s=>s.key===c.entry.key)).map(c=>c.entry.key);
 if(previousCheck?.checkVersion===BOUNDARY_CHECK_VERSION&&previousCheck.signature===signature&&previousCheck.reviewId===applied?.id&&previousCheck.nativeEvidenceReviewId===nativeReview?.id&&Boolean(previousCheck.entryReviewRequired)===entryReviewRequired&&digest(previousCheck.supplementalReviewIds||[])===digest(supplementalReviewIds)&&digest(previousCheck.currentSourceKeys||[])===digest(currentSourceKeys)&&digest(previousCheck.pendingEntryKeys||[])===digest(pendingEntryKeys))return previousCheck;
 const sourceReviewedKeys=[...new Set([...(applied?.sourceEntryReviews?.map(stateKey)||[]),...(nativeReview?.keys||[])])];
 const base={checkVersion:BOUNDARY_CHECK_VERSION,signature,version:context.versionId,actualVersion:context.actual?.version??null,changedKeys:[],inherit:false,repairTarget:null,...(entryReviewRequired?{entryReviewRequired:true}:{}),...(pendingEntryKeys.length?{pendingEntryKeys}:{}),...(currentSourceKeys.length?{currentSourceKeys}:{}),...(sourceReviewedKeys.length?{sourceReviewedKeys}:{}),...(entryReview?{entryEvidenceReviewId:entryReview.id,entryReviewedKeys:entryKeys}:{}),...(restoredEntryKeys.length?{restoredEntryKeys}:{}),...(applied?{reviewId:applied.id}:{}),...(nativeReview?{nativeEvidenceReviewId:nativeReview.id}:{}),...(applied?.relationReview?{reviewedRelation:applied.relationReview.relation}:{}),...(supplementalReviewIds.length?{supplementalReviewIds}:{})};
 const reviewedKeys=new Set([...(applied?.sourceClaimReviews||[]),...(applied?.resolvedDesignConflicts||[])].map(stateKey)),conflicts=feedback?.conflicts?.filter(s=>!reviewedKeys.has(s.key))||[];
 if(conflicts.length)return {...base,status:'CONSTRAINT_CONFLICT',changedKeys:conflicts.map(stateKey),repairTarget:'PREDECESSOR_OR_SOURCE_REVIEW'};
 if(supplements.length){context=copy(context);context.actual.states.push(...supplements);}
 if(applied){
  feedback=copy(feedback);
  if(applied.relationReview)feedback.relation=applied.relationReview.relation;
  for(const s of applied.equivalences||[])feedback.entry.find(e=>e.key===s.key).value=s.actualValue;
  for(const s of applied.supplementalStates||[]){
   feedback.entry.find(e=>e.key===s.key).value=s.value;
  }
  for(const s of applied.resolvedDesignConflicts||[]){const before=feedback.entry.find(e=>e.key===s.key);if(before)before.value=s.newActualValue;}
 }
 if(entryReview){
  feedback=copy(feedback);
  if(restoredEntryKeys.length)feedback.entry=entryReviewEntries(feedback,entryReview,entryBasis);
  for(const key of entryKeys){const entry=feedback.entry.find(s=>s.key===key),tail=context.actual.states.find(s=>s.key===key);if(entry&&tail)entry.value=tail.value;}
 }
 if(context.seed.fromEpisode===null)return {...base,status:'NO_PREDECESSOR'};
 if(!feedback||feedback.relation==='UNKNOWN')return {...base,status:'UNRESOLVED',reason:'尚未判明原文时间/现实域关系，不能自动继承。'};
 if(feedback.relation!=='DIRECT')return {...base,status:'NOT_CONTINUOUS'};
 const agreements=new Map(context.agreements.map(s=>[s.key,s]));
 const entryConflict=feedback.entry.filter(s=>agreements.has(s.key)&&s.value!==agreements.get(s.key).value);
 if(entryConflict.length)return {...base,status:'CONSTRAINT_CONFLICT',changedKeys:entryConflict.map(stateKey),repairTarget:'CURRENT_CONSTRAINT'};
 const actualConflict=(context.actual?.states||[]).filter(s=>agreements.has(s.key)&&s.value!==agreements.get(s.key).value);
 if(actualConflict.length)return {...base,status:'CONSTRAINT_CONFLICT',changedKeys:actualConflict.map(stateKey),repairTarget:'PREDECESSOR_OR_SOURCE_REVIEW'};
 if(!context.actual)return {...base,status:'PRELIMINARY',reason:'按原文底稿制作；未与上集实际分镜核对。'};
 if(pendingEntryKeys.length)return {...base,status:'UNRESOLVED',missingKeys:pendingEntryKeys,reason:'已付基稿入口尚无有效恢复或退役证据；复核失效不能退回未消费。'};
 if(entryReviewRequired&&!entryReview)return {...base,status:'UNRESOLVED',reason:'本请求要求当前完整前稿证据；失效或缺失证明不能退回未消费。'};
 const actual=new Map(context.actual.states.map(s=>[s.key,s]));
 const states=feedback.entry.filter(s=>['SOURCE','DESIGN'].includes(s.authority));
 const missingEvidence=states.filter(s=>!actual.has(s.key)&&!currentSourceKeys.includes(s.key)).map(stateKey);
 if((nativeReview||entryReview)&&missingEvidence.length)base.missingKeys=missingEvidence;
 const compared=states.filter(s=>actual.has(s.key));
 const missing=states.filter(s=>!actual.has(s.key)&&!currentSourceKeys.includes(s.key)&&!sourceReviewedKeys.includes(s.key)&&!entryKeys.includes(s.key)).map(s=>s.key);
 const changes=compared.filter(s=>s.value!==actual.get(s.key).value);
 // Hard source/locked-production constraints stay hard. This identifies a conflict for
 // evidence review; it does not prove that the model-labelled SOURCE value is true.
 const hard=changes.filter(s=>s.authority==='SOURCE'||agreements.has(s.key));
 if(hard.length)return {...base,status:'CONSTRAINT_CONFLICT',changedKeys:hard.map(stateKey),repairTarget:'PREDECESSOR_OR_SOURCE_REVIEW'};
 if(changes.length)return {...base,status:'REPAIR_REQUIRED',inherit:true,changedKeys:changes.map(stateKey),repairTarget:'CURRENT_DEPENDENCIES'};
 if(missing.length)return {...base,status:'UNRESOLVED',missingKeys:missing,reason:'上集采用尾稿未回填所消费的状态，不能自动称为一致。'};
 return {...base,status:compared.length?'MATCHED':'NOT_CONSUMED',inherit:compared.length>0};
}

// Follow explicit dependencies and inseparable adopted groups; do not invalidate all episodes.
export function dependencyScope(d,initial){
 const scope=new Set(initial);let size;
 do{size=scope.size;for(const w of d.plan?.workPackages||[])if(w.dependsOn?.some(id=>scope.has(id)))scope.add(w.id);
  for(const group of d.adopted||[])if(group.packageIds.some(id=>scope.has(id)))for(const id of group.packageIds)scope.add(id);
 }while(scope.size!==size);
 return (d.plan?.workPackages||[]).filter(w=>scope.has(w.id)).map(w=>w.id);
}

export function productionFeedbackSchema({source,plan,materialIds=[],touchesEnding,episodeBoundary,strictAuthorities=false,authoritySource=source,factHeadings=false,designOnlySharedChoices=false,inheritanceVersion}){
 const string={type:'string'},arr=items=>({type:'array',items}),obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
 const enumOf=values=>values.length?{type:'string',enum:[...new Set(values)]}:string;
 const refs=values=>({...arr(enumOf(values)),...(!values.length?{maxItems:0}:{})});
 const boundaryRows=boundaryEvidenceRows(episodeBoundary,{factHeadings});
 const sourceRefs=refs([...(source.sourceRows||[]),...(source.contextRows||[]),...boundaryRows].map(r=>r.id));
 const need=(stages,coordinates)=>obj({stage:{type:'integer',enum:stages},target:string,purpose:string,packageIds:plan?refs((plan.workPackages||[]).map(w=>w.id)):arr(string),sourceRefs:coordinates,blocking:{type:'boolean'}});
 let state=obj({key:string,value:string,authority:enumOf(authorities),sourceRefs});
 if(strictAuthorities){
  const spoken=new Set((authoritySource.dialogue||[]).flatMap(q=>q.sourceIds||[q.rowId]));
  const visible=new Set([...(source.sourceRows||[]),...(source.contextRows||[]),...boundaryRows].map(r=>r.id));
  const hardRefs=[...(authoritySource.sourceRows||[]),...(authoritySource.contextRows||[]),...boundaryRows]
   .filter(r=>visible.has(r.id)&&r.kind!=='guidance'&&r.evidenceRole!=='guidance'&&r.kind!=='dialogue'&&!spoken.has(r.id)).map(r=>r.id);
  const soft=obj({key:string,value:string,authority:enumOf(authorities.filter(a=>a!=='SOURCE')),sourceRefs});
  state={anyOf:[...(hardRefs.length?[obj({key:string,value:string,authority:enumOf(['SOURCE']),sourceRefs:{...refs(hardRefs),minItems:1}})]:[]),soft]};
 }
 const sharedChoice=designOnlySharedChoices?obj({key:string,value:string,authority:enumOf(['DESIGN']),sourceRefs}):state;
 let entryState=state;
 const actual=PRODUCTION_FEEDBACK_INHERITANCE_VERSIONS.includes(inheritanceVersion)?episodeBoundary?.actual?.states:[];
 if(actual?.length){
  const variants=state.anyOf||[state],escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=`^(?!(?:${actual.map(s=>escape(s.key)).join('|')})$)[\\s\\S]+$`;
  const constrain=(variant,key,value)=>({...variant,properties:{...variant.properties,key,...(value?{value}:{})}});
  // v1 spelling is preserved only to rebuild old frozen requests. The provider
  // does not support lookaround; v2 offers generic new-key branches and keeps
  // exact known-key/value enforcement in validateProductionFeedback.
  entryState={anyOf:[...actual.flatMap(s=>variants.map(v=>constrain(v,enumOf([s.key]),enumOf([s.value])))),...variants.map(v=>inheritanceVersion==='production-feedback-inheritance-v1'?constrain(v,{type:'string',pattern}):v)]};
 }
 return obj({relation:enumOf(relations),entry:arr(entryState),exit:{...arr(state),...(touchesEnding===false?{maxItems:0}:{})},sharedChoices:arr(sharedChoice),usedMaterialIds:refs(materialIds),
  needs:arr({anyOf:[need([2],refs((source.sourceRows||[]).map(r=>r.id))),need([1,3],sourceRefs)]}),
  conflicts:arr(obj({key:string,problem:string,sourceRefs}))});
}

// Opt-in: frozen historical prompts must retain their original bytes and hashes.
export const productionFeedbackDesignHint='sharedChoices只允许authority=DESIGN，且value必须是确需共用的最小制作选择。原文事实、角色说法、解释推断应按各自证据等级写入entry/exit，不放入sharedChoices；无需新增制作约定时用[]。不能仅为通过校验把推断标成DESIGN，也不能把设计标成SOURCE。';
export const productionFeedbackInheritanceHint='entry消费已提供actual.states的状态时，逐字复用其key/value，不为同一个事实改述；sourceRefs仍须按本次可读坐标与authority权限填写。entry只写本集开场动作变化之前的入口，本集落缸、攻击等后续进展写入本集正文。若actual与可读原文或锁定约定确实相反，必须用conflicts保留明确矛盾和原文坐标，不能借复用掩盖。没有提供的真实新状态仍按原字段和证据等级记录；未消费的状态不补写。';

export const productionFeedbackHint=`productionFeedback是本次生产消费回执，不是新增审稿岗位或长摘要。relation只据前集尾段与本集开场判断，DIRECT为同一现实时间内的连续动作；跳时/换场/闪回/幻想/未知不得无条件继承。entry只记录本次真正依赖的本集入口状态（在开场动作变化之前），exit只在productionScope.touchesEnding=true时记录采用稿实际尾态，其他用[]。状态key优先复用已提供actual.states/agreements，使用“资产key/状态项”稳定标识，value简短精确。SOURCE必须有本次可读且非guidance/对白的sourceRefs；角色说法用CHARACTER_CLAIM，解释推断用INTERPRETATION，都不能自证世界规则或硬性继承；未规定的制作选择用DESIGN。sharedChoices只提必须跨集共用的最小制作约定，不预写分镜；未指定手、站位、机位不要无用补全。actual只细化自由选择，不覆盖源文和agreements。outgoingAgreements是本集结尾与后集共享的已锁定最小制作约定，若与原文冲突应回报conflicts而不是强行覆盖。usedMaterialIds只列确实影响本次创作的材料ID。needs只报告有坐标、用途、影响工作包的缺料；stage=2的sourceRefs必须锚定本次sourceRows中的受影响资产或场景，不可用前集/context/boundary编号冒充本集供给坐标，前情关系写入purpose；无法定位本集时先向stage=1/3请求定位。目标已在材料中时target必须填准确assetKey，不用显示名猜ID；真正缺失的新资产保留原文坐标待定位。无图片不阻断文字。conflicts只报硬冲突，普通有依据整理直接完成。没有需求/冲突时用[]。`;
