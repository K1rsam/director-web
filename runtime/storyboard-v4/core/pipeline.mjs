import {randomUUID} from 'node:crypto';
import {VERSION,digest,fail} from './shared.mjs';
import {normalizeSource} from './source.mjs';
import {normalizeSettings,normalizePlan,defaultChoice,captureRules,buildRequest,sliceSource} from './core.mjs';
import {confirmSelection,resolveSelection,rebaseSelection} from './selection.mjs';
import {normalizeDraft,validateDraft,renderDraft} from './quality.mjs';
import {createStore} from './store.mjs';
import {runModel,readCompletedAttempt} from './runner.mjs';
import {applyDelta,baseDraftHash} from './delta.mjs';
import {EXECUTION_PROJECTION_VERSION,buildExecutionBatches,executionBaseHash,hasExecutionDrafts,executionProjection,savedExecutionProjection,combinedExecutionDraft} from './execution-batches.mjs';
import {AUTHOR_CALL_GROUPING_VERSION,validateAuthorCallGroup,assertFreshAuthorCallGroup} from './author-call-groups.mjs';
import {ACCEPTED_CONTINUITY_VERSION,acceptsContinuity,acceptedContinuity,sourceOrderedPackages} from './accepted-continuity.mjs';
import {PRODUCTION_FEEDBACK_VERSION,PRODUCTION_FEEDBACK_CONTRACT_VERSION,PRODUCTION_FEEDBACK_VALIDATION_VERSION,PRODUCTION_FEEDBACK_INHERITANCE_VERSIONS,selectBoundaryForRequest,validateProductionFeedback,productionFeedbackFactRefs,validateBoundaryReview,reviewedBoundaryResolution,reconcileBoundary,dependencyScope,nativeBoundaryEntryReview} from '../../episode-boundary.mjs';
import {FEEDBACK_RESULT_VERSION,isFeedbackResultVersion,freezeFeedbackBasis,projectResultFeedback,effectiveProductionFeedback,feedbackMaterialConsumers} from './production-feedback-result.mjs';
import {ENTRY_REVIEW_VERSION,freezeEntryBasis,projectEntryCoverage} from './entry-evidence.mjs';
import {selectProductionMaterials,changedConsumedMaterials,materialChangeCoordinates} from '../../production-materials.mjs';
import {SHARED_PRODUCTION_TRANSPORT_VERSION} from '../../production-transport.mjs';
import {PRODUCTION_SUPPLY_VERSION,scopeProductionSource} from '../../production-supply.mjs';
import {feedbackOnlyFailure,buildFeedbackRepairRequest,mergeFeedbackRepair,CURRENT_FEEDBACK_REPAIR_VERSION} from '../../feedback-repair.mjs';
import {DIRECTOR_REFINEMENT_VERSION,DIRECTOR_REFINEMENT_PURPOSE,isDirectorRefinement,freezeDirectorRefinement,assertDirectorRefinementBase,decorateDirectorRefinementRequest,assertDirectorRefinementDelta,refinementAdoptionBlock} from './director-refinement.mjs';
import {getRefinementComparison} from './refinement-comparison.mjs';
import {REFINEMENT_SELECTION_VERSION,getRefinementAcceptanceGroups,selectRefinementGroups,assertRefinementRetained,assertRefinementSeams} from './refinement-adoption.mjs';
import {normalizeRefinementLinkedUnits} from './refinement-linked-units.mjs';
import {recordRefinementSourceResolution,refinementProductionFeedback} from './refinement-source-resolution.mjs';
import {recordSourceResolution,currentDocumentSourceResolutions,sourceResolutionFeedback,sourceResolutionForNeed} from './source-resolution.mjs';
export {executionState,hasExecutionDrafts} from './execution-batches.mjs';

import {OPPORTUNITY_COVERAGE_VERSION,proposeOpportunityAppend} from './opportunity-coverage.mjs';
const identity=r=>digest([r.promptHash,r.instructionHash,r.inputHash]);
const validAttempt=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
const ids=(d,o)=>o.stage==='plan'?[]:(o.packageIds||[o.packageId]);
const overlap=(a,b)=>a.some(x=>b.includes(x));
const errorRecord=(e,outcome=e.requestOutcome||'UNKNOWN')=>({code:e.code||'RUNNER_ERROR',message:e.message,requestOutcome:outcome,...(e.coordinate?{coordinate:e.coordinate}:{})});
export const PLAN_VALIDATION_VERSION='plan-citations-v1';
const invalidate=(d,status)=>{d.assembly=null;d.status=status;};
const renderResolved=(d,draft)=>renderDraft({draft,source:d.source,settings:d.settings,seedanceExportVersion:d.rulesSnapshot.seedanceExportVersion,sourceResolutions:currentDocumentSourceResolutions(d)});
export const isUnresolvedOperation=o=>o.status==='running'||(o.status==='unknown'&&o.cancelAcknowledgement?.acceptUnknownUsage!==true);
const savedResponseHash=c=>c?digest(c.raw?.trim()?{raw:c.raw}:{output:c.output??null}):null;
const consumedResponseHashes=(d,op)=>{
 const candidates=d.candidates||[],recovered=candidates.find(c=>c.id===op.recovery?.candidateId),original=candidates.find(c=>c.id===recovered?.derivedFrom);
 return new Set([...(op.recovery?.responseHashes||[]),savedResponseHash(recovered),savedResponseHash(original)].filter(Boolean));
};
export function hasPendingSavedResponse(d,op){
 if(op.receipt?.responseDisposition==='incomplete')return false;
 if(op.executionProjectionVersion){
  const manifest=d.executionBatches?.[op.packageIds?.[0]];
  if(!manifest||manifest.version!==op.executionProjectionVersion||manifest.hash!==op.executionManifestHash||manifest.generation!==op.executionBatch?.generation)return false;
 }
 const consumed=consumedResponseHashes(d,op);
 return op.recovery?.epoch!==d.epoch&&(d.candidates||[]).some(c=>c.attemptId===op.attemptId&&!consumed.has(savedResponseHash(c))&&(c.status==='cancelled_late'||op.status==='completed'&&['TIMEOUT','CLI_FAILED'].includes(op.error?.code)&&c.output==null&&c.raw?.trim()&&['needs_repair','refinement_invalid'].includes(c.status)&&!c.resolvedBy));
}
const attentionStatus=d=>d.operations.some(o=>o.epoch===d.epoch&&o.status==='running')?'running':d.operations.some(o=>o.status==='unknown'&&isUnresolvedOperation(o))?'unknown':null;
function assertFeedbackResultPair(d){
 if(!d.production)return;
 const rules=d.rulesSnapshot.productionFeedbackResultVersion,production=d.production.feedbackResultVersion;
 if(production!==undefined&&!isFeedbackResultVersion(production)||(rules===FEEDBACK_RESULT_VERSION||production===FEEDBACK_RESULT_VERSION)&&rules!==production)fail('RULE_SNAPSHOT','新生产完整结果回执双marker缺失或漂移，保留原请求');
}
function productionSnapshot(d,stage,packageIds,executionBatch){
 if(!d.production)return null;
 if(stage==='finish')assertFeedbackResultPair(d);
 const ordered=d.plan?sourceOrderedPackages(d):[],first=ordered[0]?.id,last=ordered.at(-1)?.id;
 const opening=stage==='plan'||packageIds.includes(first)&&(!executionBatch||executionBatch.index===0);
 const ending=stage!=='plan'&&packageIds.includes(last)&&(!executionBatch||executionBatch.index===executionBatch.total-1);
 const supplyVersion=d.rulesSnapshot.productionSupplyVersion===PRODUCTION_SUPPLY_VERSION?PRODUCTION_SUPPLY_VERSION:null;
 let supplySource=d.source;
 if(supplyVersion&&stage!=='plan'){
  const workPackages=d.plan.workPackages.filter(w=>packageIds.includes(w.id)),sourceRefs=executionBatch?.batch.sourceRefs||workPackages.flatMap(w=>w.sourceRefs),contextRefs=workPackages.flatMap(w=>w.contextRefs);
  for(const w of workPackages){const first=d.source.sourceRows.findIndex(r=>w.sourceRefs.includes(r.id));contextRefs.push(...d.source.sourceRows.slice(Math.max(0,first-3),first).map(r=>r.id));}
  if(executionBatch)contextRefs.push(...workPackages.flatMap(w=>w.sourceRefs).filter(id=>!sourceRefs.includes(id)));
  const entryFacts=[...d.source.entryFacts,...d.plan.entryFacts.filter(f=>!d.source.entryFacts.some(x=>x.id===f.id))],factIds=[...d.source.entryFacts.map(f=>f.id),...workPackages.flatMap(w=>w.entryFactIds)];
  supplySource=sliceSource({...d.source,entryFacts},sourceRefs,factIds,contextRefs);
  supplySource=scopeProductionSource(supplySource,{fullSource:d.source,stage,plan:{workPackages,events:d.plan.events?.filter(e=>workPackages.some(w=>w.eventId===e.id))},episodeEvidenceVersion:d.rulesSnapshot.episodeEvidenceVersion,historyPolicy:d.web?.inputPolicy?.historyPolicy??d.rulesSnapshot.historyPolicy??null});
 }
 return {version:PRODUCTION_FEEDBACK_VERSION,transportVersion:d.rulesSnapshot.productionTransportVersion??SHARED_PRODUCTION_TRANSPORT_VERSION,...((d.web?.inputPolicy?.historyPolicy??d.rulesSnapshot.historyPolicy)?{historyPolicy:d.web?.inputPolicy?.historyPolicy??d.rulesSnapshot.historyPolicy}:{}),...(d.rulesSnapshot.productionSupplyVersion===PRODUCTION_SUPPLY_VERSION?{supplyVersion:PRODUCTION_SUPPLY_VERSION}:{}),touchesOpening:opening,touchesEnding:ending,
  ...(d.rulesSnapshot.productionFeedbackContractVersion===PRODUCTION_FEEDBACK_CONTRACT_VERSION?{feedbackContractVersion:PRODUCTION_FEEDBACK_CONTRACT_VERSION}:{}),
  ...(stage==='finish'&&isFeedbackResultVersion(d.production.feedbackResultVersion)&&d.rulesSnapshot.productionFeedbackResultVersion===d.production.feedbackResultVersion?{feedbackResultVersion:d.production.feedbackResultVersion}:{}),
  ...(stage==='finish'&&d.production.entryReviewVersion===ENTRY_REVIEW_VERSION&&d.rulesSnapshot.productionEntryReviewVersion===ENTRY_REVIEW_VERSION?{entryReviewVersion:ENTRY_REVIEW_VERSION,...(opening&&d.production.entryEvidenceContext?{entryEvidenceContext:structuredClone(d.production.entryEvidenceContext)}:{})}:{}),
  ...(PRODUCTION_FEEDBACK_INHERITANCE_VERSIONS.includes(d.web?.inputPolicy?.feedbackInheritanceVersion??d.rulesSnapshot.productionFeedbackInheritanceVersion)?{feedbackInheritanceVersion:d.web?.inputPolicy?.feedbackInheritanceVersion??d.rulesSnapshot.productionFeedbackInheritanceVersion}:{}),
  outgoingAgreements:stage==='plan'||ending?structuredClone(d.production.outgoingAgreements||[]):[],
  ...(d.production.sourceResolutions?.length?{sourceResolutions:structuredClone(currentDocumentSourceResolutions(d))}:{}),
  episodeBoundary:selectBoundaryForRequest(d.production.boundary,stage,opening,d.production.boundaryReviews||[],d.source),
  materials:selectProductionMaterials(d.production.materials,stage,d.plan,packageIds,d.production.needs||[],supplySource,supplyVersion)};
}
const requestOf=(d,stage,packageIds,previousDraft,issues=[],format='continuity-v1',finishMode='full',executionBatch=null,continuityVersion=d.rulesSnapshot.acceptedContinuityVersion,production=productionSnapshot(d,stage,packageIds,executionBatch),directorRefinement=null,opportunityBasis=null)=>{
 const external=new Set(packageIds.flatMap(id=>d.plan?.workPackages.find(w=>w.id===id)?.dependsOn||[]).filter(id=>!packageIds.includes(id)));
 const rank=new Map(d.source.sourceRows.map((row,i)=>[row.id,i]));
 const dependencyExits=format==='legacy'?Object.fromEntries(d.adopted.filter(a=>a.packageIds.some(id=>external.has(id))).map(a=>[a.packageIds.join('+'),a.draft.units.map(u=>u.exitState)])):Object.fromEntries([...external].map(id=>{
  const refs=new Set(d.plan.workPackages.find(w=>w.id===id).sourceRefs),adopted=d.adopted.find(a=>a.packageIds.includes(id));
  const relevant=adopted?.draft.units.filter(u=>u.shots.some(s=>s.sourceRefs.some(ref=>refs.has(ref))))||[];
  const last=relevant.sort((a,b)=>Math.max(...a.shots.flatMap(s=>s.sourceRefs.filter(ref=>refs.has(ref)).map(ref=>rank.get(ref)??-1)))-Math.max(...b.shots.flatMap(s=>s.sourceRefs.filter(ref=>refs.has(ref)).map(ref=>rank.get(ref)??-1)))).at(-1);
  if(!last)fail('DEPENDENCY_EXIT',`依赖工作包${id}缺少可定位的出口单元`);
  return [id,{unitId:last.id,scene:last.scene,lighting:last.lighting,props:last.props,participants:last.participants,exitState:last.exitState}];
 }));
 const continuity=stage==='plan'?null:acceptedContinuity(d,packageIds,executionBatch,continuityVersion);
 return buildRequest({stage,...(opportunityBasis?{opportunityBasis}:{}),source:d.source,settings:d.settings,plan:d.plan,choice:d.choice,packageId:packageIds[0],packageIds,previousDraft,voiceReference:d.voiceReference,rulesSnapshot:d.rulesSnapshot,dependencyExits,issues,finishMode,...(continuity?{acceptedContinuity:continuity}:{}),...(executionBatch?{executionBatch}:{}),...(production?{productionSnapshot:production}:{}),...(directorRefinement?{directorRefinement}:{})});
};
// An old operation must never acquire a newly enabled input on recovery/recheck.
const currentRequest=(d,op)=>{
 const request=op.feedbackRepair?feedbackRequestFor(d,op.feedbackRepair.candidateId,op.issues,op.feedbackRepair.version):requestOf(d,op.stage,op.packageIds,op.previousDraft,op.issues,op.dependencyFormat||'legacy',op.finishMode||'full',savedExecutionProjection(d,op),op.acceptedContinuityVersion??null,op.productionSnapshot??null,op.refinement??null,op.opportunityBasis??null);
 return isDirectorRefinement(op)?decorateDirectorRefinementRequest(request,op.refinement):request;
};
// Pure audit surface: rebuild the exact frozen operation without touching a store or runner.
export {currentRequest as rebuildFrozenRequest};
function feedbackRequestFor(d,candidateId,issues,version){
 const c=d.candidates.find(c=>c.id===candidateId),op=c&&d.operations.find(o=>o.attemptId===c.attemptId);
 if(!op||!c.output||!op.productionSnapshot)fail('FEEDBACK_REPAIR_INPUT','缺少已保存的完整回包和消费范围。');
 const base=currentRequest(d,op);
 if(identity(base)!==op.fingerprint)fail('STALE_CANDIDATE','待修回执的原稿或来源已变化，不能覆盖新版本。');
 return buildFeedbackRepairRequest(base,c,issues,{version});
}
const adoptionOperations=(d,a)=>[...new Set([a.candidateId,...(a.candidateIds||[])])].map(id=>d.operations.find(o=>o.attemptId===d.candidates.find(c=>c.id===id)?.attemptId)).filter(Boolean);
function assertBatchContinuity(d,manifest){
 for(const id of Object.values(manifest?.accepted||{})){
  const candidate=d.candidates.find(c=>c.id===id),op=d.operations.find(o=>o.attemptId===candidate?.attemptId);
  if(op&&acceptsContinuity(d,op.acceptedContinuityVersion??null)&&identity(currentRequest(d,op))!==op.fingerprint)fail('EXECUTION_STALE','已采用前批使用的外部前稿已变化，请保留现稿并联修');
 }
}
function continuityRepairScope(d,op,next,explicitOutside){
 if(!acceptsContinuity(d,op.acceptedContinuityVersion??null))return explicitOutside.length?[...new Set([...op.packageIds,...explicitOutside.map(w=>w.id)])]:[];
 const outside=d.adopted.filter(a=>!overlap(a.packageIds,op.packageIds)),proposed={...d,adopted:[...outside,...next]};
 // A shared transport scope is not an adopted group's semantic boundary: after
 // whole-episode finishing, each group still depends on its own source neighbor.
 const context=(doc,a,o)=>acceptedContinuity(doc,a.packageIds,o.executionBatch,o.acceptedContinuityVersion??null);
 const affected=new Set(explicitOutside.map(w=>w.id));
 for(const a of outside)if(adoptionOperations(d,a).some(o=>digest(context(d,a,o))!==digest(context(proposed,a,o))))for(const id of a.packageIds)affected.add(id);
 if(!affected.size)return [];
 // A repair can change its own tail too: include every already-adopted downstream consumer.
 let expanded=true;
 while(expanded){expanded=false;for(const a of outside){
  const depends=a.packageIds.some(id=>d.plan.workPackages.find(w=>w.id===id).dependsOn.some(id=>affected.has(id)))||adoptionOperations(d,a).some(o=>affected.has(context(d,a,o)?.packageId));
  if(depends)for(const id of a.packageIds)if(!affected.has(id)){affected.add(id);expanded=true;}
 }}
 const required=new Set([...op.packageIds,...affected]);return sourceOrderedPackages(d).filter(w=>required.has(w.id)).map(w=>w.id);
}
const executionFields=batch=>batch?{executionProjectionVersion:batch.version,executionBatchId:batch.id,executionManifestHash:batch.manifestHash,executionBatch:batch}:{};
const candidateExecutionFields=op=>({...op.executionProjectionVersion?{executionProjectionVersion:op.executionProjectionVersion,executionBatchId:op.executionBatchId,executionManifestHash:op.executionManifestHash}:{},...isDirectorRefinement(op)?{purpose:op.purpose,refinement:{version:op.refinement.version,baseAssemblyHash:op.refinement.baseAssemblyHash,eventIds:op.refinement.eventIds,...(op.refinement.unitIds?{unitIds:op.refinement.unitIds,scope:op.refinement.scope}:{}),...(op.refinement.workOrder?{workOrder:op.refinement.workOrder}:{})}}:{}});
const batchCandidate=(d,batch)=>d.candidates.findLast(c=>c.executionManifestHash===batch.manifestHash&&c.executionBatchId===batch.id&&!c.resolvedBy&&c.status==='needs_repair');
function nextExecution(d,stage,packageIds){
 if(packageIds.length!==1)return null;
 const packageId=packageIds[0];let manifest=d.executionBatches?.[packageId];
 if(manifest&&!hasExecutionDrafts({...d,executionBatches:{[packageId]:manifest}})){
  let current=false;try{current=manifest.baseHash===executionBaseHash(d,manifest.opportunityBasis);}catch{}
  if(!current){delete d.executionBatches[packageId];manifest=null;}
 }
 if(stage==='author'&&!d.adopted.some(a=>a.packageIds.includes(packageId))){
  if(!manifest&&d.rulesSnapshot.unitPackingPolicy==='event-first-v1'&&!d.candidates.some(c=>!c.executionProjectionVersion&&c.stage!=='plan'&&c.status!=='adopted'&&!c.resolvedBy&&c.packageIds.includes(packageId)&&(c.raw?.trim()||c.output!=null||c.draft!=null))){
   const next=buildExecutionBatches({...d,packageId,generation:randomUUID()});
   if(next.batches.length>1){d.executionBatches??={};d.executionBatches[packageId]=manifest=next;}
  }
  if(manifest){const batch=manifest.batches.find(b=>!manifest.accepted[b.id]);if(batch){assertBatchContinuity(d,manifest);return executionProjection(d,manifest,batch);}}
 }
 if(stage==='finish'&&manifest&&!d.adopted.some(a=>a.packageIds.includes(packageId))){
  const candidate=d.candidates.findLast(c=>c.executionManifestHash===manifest.hash&&c.status==='needs_repair'&&!c.resolvedBy);
  if(candidate){assertBatchContinuity(d,manifest);return executionProjection(d,manifest,manifest.batches.find(b=>b.id===candidate.executionBatchId));}
 }
 return null;
}
function rawCandidateInput(d,candidate){
 const coordinates=d.operations.find(o=>o.attemptId===candidate.attemptId)?.modelCoordinates;
 if(!coordinates)return {rawText:candidate.raw};
 // The paid raw never changes. A parsed repair uses its already-restored full value;
 // malformed raw carries its original namespace instead of guessing references.
 if(candidate.output!=null)return {rawText:JSON.stringify(candidate.output)};
 return {rawText:candidate.raw,rawCoordinateBindings:structuredClone(coordinates.aliases)};
}
function previousBatch(d,batch){
 const bad=batchCandidate(d,batch),accepted=d.candidates.find(c=>c.id===d.executionBatches[batch.packageId].accepted[batch.id]);
 if(bad?.draft)return structuredClone(bad.draft);
 if(bad?.raw)return rawCandidateInput(d,bad);
 if(accepted?.draft)return structuredClone(accepted.draft);
 fail('AUTHOR_REQUIRED','缺少本执行批次的待修初稿');
}
function assertGroupScope(d,packageIds){
 if(d.adopted.some(a=>overlap(a.packageIds,packageIds)&&a.packageIds.some(id=>!packageIds.includes(id))))fail('GROUP_SCOPE','已采用关联组须一起重写');
 if(d.candidates.some(c=>c.status==='needs_dependency_repair'&&!c.resolvedBy&&overlap(c.requiredPackageIds,packageIds)&&c.requiredPackageIds.some(id=>!packageIds.includes(id))))fail('GROUP_SCOPE','依赖返修须包含完整扩大范围');
}
function scopeCheck(d,stage,packageIds,{freshAuthor=false}={}){
 if(stage==='plan'){if(d.operations.some(isUnresolvedOperation))fail('SCOPE_BUSY','整集计划仍有未结操作');if(hasExecutionDrafts(d))fail('RESET_DRAFTS_REQUIRED','已有执行批次正文，须先明确归档重做');return;}
 if(d.operations.some(o=>o.stage==='plan'&&isUnresolvedOperation(o)))fail('SCOPE_BUSY','整集计划仍有未结操作');
 if(!d.plan)fail('PLAN_REQUIRED','请先完成整集计划');
 if(!packageIds.length||new Set(packageIds).size!==packageIds.length||packageIds.some(id=>!d.plan.workPackages.some(w=>w.id===id)))fail('PACKAGE','工作包不存在或重复');
 const grouped=stage==='author'&&packageIds.length>1;
 if(grouped)validateAuthorCallGroup(d,packageIds);
 assertGroupScope(d,packageIds);
 const internal=grouped||stage==='finish'&&d.rulesSnapshot.authorCallGroupingVersion===AUTHOR_CALL_GROUPING_VERSION;
 for(const id of packageIds){const w=d.plan.workPackages.find(x=>x.id===id);for(const dep of w.dependsOn)if(!(internal&&packageIds.includes(dep))&&!d.adopted.some(a=>a.packageIds.includes(dep)))fail('DEPENDENCY_NOT_READY',`依赖工作包${dep}尚未成稿`);}
 if(d.operations.some(o=>o.stage!=='plan'&&isUnresolvedOperation(o)&&overlap(o.packageIds,packageIds)))fail('SCOPE_BUSY','同范围仍有未结作业');
 if(grouped&&freshAuthor)assertFreshAuthorCallGroup(d,packageIds);
 if(stage==='finish'&&packageIds.some(id=>!d.adopted.some(a=>a.packageIds.includes(id))&&!d.candidates.some(c=>c.packageIds.includes(id)&&c.status==='needs_repair'&&c.raw)))fail('AUTHOR_REQUIRED','请先形成工作包初稿或待修候选');
}
// Shared read-only eligibility; the atomic mutation must check the same current evidence.
export function canRecheckCandidate(d,candidate){
 if(isDirectorRefinement(candidate)){
  const op=d.operations?.find(o=>o.attemptId===candidate.attemptId);
  if(!op||op.status!=='completed'||candidate.resolvedBy||candidate.status!=='refinement_invalid'||!candidate.output||d.web?.sourceStale||d.operations.some(isUnresolvedOperation))return false;
  try{assertDirectorRefinementBase(d,op.refinement);return identity(currentRequest(d,op))===op.fingerprint;}catch{return false;}
 }
 if(!candidate||candidate.resolvedBy||!['needs_repair','needs_dependency_repair'].includes(candidate.status)||!candidate.output||typeof candidate.output!=='object'||Array.isArray(candidate.output)||d.web?.sourceStale||(d.operations||[]).some(isUnresolvedOperation))return false;
 const op=d.operations?.find(o=>o.attemptId===candidate.attemptId);
 if(!op||op.status!=='completed'||op.epoch!==d.epoch&&op.recovery?.epoch!==d.epoch&&!consumedResponseHashes(d,op).has(savedResponseHash(candidate)))return false;
 try{scopeCheck(d,candidate.stage,candidate.packageIds);if(op.finishMode==='delta'&&baseDraftHash(op.executionProjectionVersion?previousBatch(d,op.executionBatch):previousOf(d,op.packageIds))!==op.baseDraftHash)return false;return identity(currentRequest(d,op))===op.fingerprint;}catch{return false;}
}
function previousOf(d,packageIds){
 assertFeedbackResultPair(d);
 const entries=d.adopted.filter(a=>overlap(a.packageIds,packageIds));
 if(entries.some(a=>a.packageIds.some(id=>!packageIds.includes(id))))fail('GROUP_SCOPE','关联组须一起返修');
 for(const entry of entries.filter(a=>a.executionManifestHash)){
  const manifest=d.executionBatches?.[entry.packageIds[0]],combined=manifest&&combinedExecutionDraft(d,manifest);
  if(!combined||manifest.hash!==entry.executionManifestHash||digest(combined)!==digest(entry.draft))fail('STALE_ADOPTION','执行批次正文与完整工作包来源不一致');
  for(const candidateId of entry.candidateIds||[]){const candidate=d.candidates.find(c=>c.id===candidateId),op=d.operations.find(o=>o.attemptId===candidate?.attemptId);if(!op||identity(currentRequest(d,op))!==op.fingerprint)fail('STALE_ADOPTION','执行批次依赖的材料或前序末态已经变化');}
 }
 const rank=new Map(d.source.sourceRows.map((row,i)=>[row.id,i]));
 const units=entries.flatMap(a=>a.draft.units).sort((a,b)=>Math.min(...a.shots.flatMap(s=>s.sourceRefs.map(ref=>rank.get(ref)??Infinity)))-Math.min(...b.shots.flatMap(s=>s.sourceRefs.map(ref=>rank.get(ref)??Infinity))));
 const seen=new Set(),supplementalCandidates=[];
 for(const c of d.candidates.toReversed())if(['needs_repair','needs_dependency_repair'].includes(c.status)&&!c.resolvedBy&&overlap(c.packageIds,packageIds)&&c.packageIds.some(id=>packageIds.includes(id)&&!seen.has(id))){for(const id of c.packageIds)seen.add(id);supplementalCandidates.push({packageIds:c.packageIds,status:c.status,...(c.draft?{draft:c.draft}:rawCandidateInput(d,c))});}
 supplementalCandidates.reverse();
 if(entries.length){
  const draft={schemaVersion:VERSION,units,fantasyRealization:entries.flatMap(a=>a.draft.fantasyRealization),...(supplementalCandidates.length?{supplementalCandidates}:{})};
  if(isFeedbackResultVersion(d.production?.feedbackResultVersion)&&d.rulesSnapshot.productionFeedbackResultVersion===d.production.feedbackResultVersion)draft.feedbackBasis=freezeFeedbackBasis(d,draft,packageIds,{touchesEnding:packageIds.includes(sourceOrderedPackages(d).at(-1)?.id),version:d.production.feedbackResultVersion});
  if(d.production?.entryReviewVersion===ENTRY_REVIEW_VERSION&&d.rulesSnapshot.productionEntryReviewVersion===ENTRY_REVIEW_VERSION&&packageIds.includes(sourceOrderedPackages(d)[0]?.id))draft.entryBasis=freezeEntryBasis(d,draft,packageIds);
  return draft;
 }
 if(supplementalCandidates.length)return {rawText:supplementalCandidates.map(c=>c.rawText||JSON.stringify(c.draft)).join('\n\n'),supplementalCandidates};
 fail('AUTHOR_REQUIRED','缺少待修初稿');
}
function groups(d,packageIds,draft){
 const owners=new Map(d.plan.workPackages.flatMap(w=>w.sourceRefs.map(ref=>[ref,w.id]))),parent=new Map(packageIds.map(id=>[id,id]));
 const root=id=>{while(parent.get(id)!==id)id=parent.get(id);return id;};
 for(const u of draft.units){const touched=[...new Set(u.shots.flatMap(s=>s.sourceRefs||[]).map(ref=>owners.get(ref)).filter(Boolean))];if(!touched.length||touched.some(id=>!parent.has(id)))fail('GROUP_SCOPE','候选单元缺少本次范围源或引用范围外源');for(const id of touched.slice(1))parent.set(root(id),root(touched[0]));}
 const result=new Map();for(const id of packageIds){const key=root(id);result.set(key,[...(result.get(key)||[]),id]);}
 return [...result.values()].map(group=>{const refs=new Set(group.flatMap(id=>d.plan.workPackages.find(w=>w.id===id).sourceRefs));const units=draft.units.filter(u=>u.shots.some(s=>s.sourceRefs.some(ref=>refs.has(ref))));const unitIds=new Set(units.map(u=>u.id));return {packageIds:group,draft:{schemaVersion:VERSION,units,fantasyRealization:draft.fantasyRealization.filter(f=>f.unitIds?.some(id=>unitIds.has(id)))}};});
}
function adoptExecution(d,candidate,op,draft,opportunity){
 const manifest=d.executionBatches[op.packageIds[0]],accepted=d.candidates.find(c=>c.id===manifest.accepted[op.executionBatchId]);
 if(accepted&&digest(accepted.draft)===digest(draft)){candidate.status='adopted';candidate.equivalentTo=accepted.id;return;}
 if(accepted&&manifest.batches.slice(manifest.batches.findIndex(b=>b.id===op.executionBatchId)+1).some(b=>manifest.accepted[b.id])){candidate.status='stale';candidate.errors=[errorRecord({code:'EXECUTION_STALE',message:'后续批次已使用此前正文，不能只替换前序批次'},'RESPONDED')];return;}
 const combined=combinedExecutionDraft(d,manifest,{batchId:op.executionBatchId,draft});
 if(combined){
  const proposed=opportunity?{...d,plan:opportunity.plan}:d;
  const full=requestOf(proposed,'author',op.packageIds,null),check=validateDraft({draft:combined,source:full.source,settings:{...d.settings,maxUnits:null},selection:full.selection,plan:proposed.plan,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion});
  if(check.errors.length){candidate.validation=check;candidate.status='needs_repair';return;}
 }
 manifest.accepted[op.executionBatchId]=candidate.id;
 for(const prior of d.candidates)if(prior!==candidate&&prior.executionManifestHash===manifest.hash&&prior.executionBatchId===op.executionBatchId&&prior.status==='needs_repair'&&!prior.resolvedBy)prior.resolvedBy=candidate.id;
 candidate.status='adopted';d.status='drafting';
 if(combined){
  d.adopted=d.adopted.filter(a=>!overlap(a.packageIds,op.packageIds));
  d.adopted.push({packageIds:op.packageIds,draft:combined,candidateId:candidate.id,candidateIds:manifest.batches.map(b=>manifest.accepted[b.id]),executionManifestHash:manifest.hash,stage:'author'});
 }
}
function adopt(d,candidate,{recovery=false}={}){
 const op=d.operations.find(o=>o.attemptId===candidate.attemptId);
 if(op.epoch!==d.epoch&&!recovery){candidate.status='cancelled_late';return;}
 if(isDirectorRefinement(op)){prepareRefinementCandidate(d,candidate,op);return;}
 try{if(op.stage!=='plan')assertGroupScope(d,op.packageIds);}catch(e){candidate.status='stale';candidate.errors=[errorRecord(e)];return;}
 let actual;try{if(op.executionProjectionVersion)assertBatchContinuity(d,d.executionBatches?.[op.packageIds[0]]);actual=currentRequest(d,op);}catch(e){candidate.status='stale';candidate.errors=[errorRecord(e)];return;}
 if(identity(actual)!==op.fingerprint){candidate.status='stale';return;}
 if(op.stage==='plan')candidate.validatorVersion=PLAN_VALIDATION_VERSION;
 if(op.feedbackRepair&&!candidate.feedbackMerged){
  try{const original=d.candidates.find(c=>c.id===op.feedbackRepair.candidateId);
   if(!original||digest(original.output)!==op.feedbackRepair.outputHash)fail('STALE_CANDIDATE','回执修复的原稿版本已变化。');
   candidate.modelOutput=structuredClone(candidate.output);candidate.output=mergeFeedbackRepair(candidate.output,original.output,op.issues);
   candidate.feedbackMerged=true;candidate.derivedFrom=original.id;
  }catch(e){candidate.status=e.code==='STALE_CANDIDATE'?'stale':'needs_repair';candidate.errors=[errorRecord(e,'RESPONDED')];return;}
 }
 if(op.productionSnapshot){candidate.productionFeedbackValidationVersion=PRODUCTION_FEEDBACK_VALIDATION_VERSION;try{candidate.productionFeedback=validateProductionFeedback(candidate.output?.productionFeedback,{...actual,plan:op.stage==='plan'?candidate.output:actual.plan});}
  catch(e){candidate.status='needs_repair';candidate.errors=[errorRecord(e,'RESPONDED')];return;}}
 if(op.stage==='plan'){
  candidate.validatorVersion=PLAN_VALIDATION_VERSION;
  try{const next=normalizePlan(candidate.output,d.source,{unitPackingPolicy:d.rulesSnapshot.unitPackingPolicy});
   candidate.normalizations=next.entryFacts.flatMap((f,i)=>JSON.stringify(f.evidence)===JSON.stringify(candidate.output.entryFacts[i].evidence)?[]:[{coordinate:f.id,field:'evidence',from:candidate.output.entryFacts[i].evidence??null,to:f.evidence,action:f.evidenceMode==='source_rows'?'extract_source':'verified_segments'}]);
   d.choice=d.plan?rebaseSelection(d.plan,next,d.choice):d.choice;d.plan=next;d.adopted=[];candidate.status='adopted';for(const prior of d.candidates)if(prior!==candidate&&prior.stage==='plan'&&prior.status==='needs_repair'&&!prior.resolvedBy)prior.resolvedBy=candidate.id;invalidate(d,'planned');refreshProductionState(d);}catch(e){candidate.status='needs_repair';candidate.errors=[errorRecord(e,'RESPONDED')];}
  return;
 }
 try{
  if(op.finishMode==='delta'&&baseDraftHash(op.executionProjectionVersion?previousBatch(d,op.executionBatch):previousOf(d,op.packageIds))!==op.baseDraftHash){candidate.status='stale';return;}
  const output=op.finishMode==='delta'?applyDelta(op.previousDraft,candidate.output):candidate.output;
  const opportunity=proposeOpportunityAppend({document:d,operation:op,candidate,request:actual,output,normalizePlan});
  const adoptionPlan=opportunity?.plan??d.plan,adoptionSelection=opportunity?.selection??actual.selection;
  const {draft,changes}=normalizeDraft(output,actual.source,{plan:actual.plan,settings:actual.settings,unitPackingPolicy:d.rulesSnapshot.unitPackingPolicy,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion,fantasyTimingVersion:d.rulesSnapshot.fantasyTimingVersion,dialogueSourceLinkVersion:d.rulesSnapshot.dialogueSourceLinkVersion,stage:op.stage});candidate.draft=draft;candidate.normalizations=changes;
  if(candidate.output?.fantasySupplements?.length)candidate.draft.fantasySupplements=structuredClone(candidate.output.fantasySupplements);
  const check=validateDraft({draft,source:actual.source,settings:op.executionProjectionVersion?{...d.settings,maxUnits:null}:d.settings,selection:adoptionSelection,plan:adoptionPlan,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion});candidate.validation=check;
  if(check.errors.length){candidate.status='needs_repair';return;}
  if(isFeedbackResultVersion(op.productionSnapshot?.feedbackResultVersion)){
   const projection=projectResultFeedback({request:actual,feedback:candidate.productionFeedback,draft,candidateId:candidate.id,attemptId:candidate.attemptId,packageIds:candidate.packageIds,delta:op.finishMode==='delta'?candidate.output:null,factRefs:productionFeedbackFactRefs(actual)});
   if(projection)candidate.feedbackProjection=projection;
   const entryProjection=projectEntryCoverage({request:actual,feedback:candidate.productionFeedback,draft});if(entryProjection)candidate.entryProjection=entryProjection;
   nativeBoundaryEntryReview({request:actual,feedback:effectiveProductionFeedback(candidate),draft});
  }
  if(op.executionProjectionVersion){adoptExecution(d,candidate,op,draft,opportunity);if(candidate.status==='adopted'&&opportunity)commitOpportunity(d,candidate,op,opportunity);refreshProductionState(d);return;}
  const next=groups(d,op.packageIds,draft);
  if(d.rulesSnapshot.authorCallGroupingVersion===AUTHOR_CALL_GROUPING_VERSION&&op.packageIds.length>1){
   // One transport scope must not weaken the original packages' dialogue or fantasy ownership.
   for(const group of next){
    const refs=new Set(d.plan.workPackages.filter(w=>group.packageIds.includes(w.id)).flatMap(w=>w.sourceRefs));
    const source=sliceSource(actual.source,[...refs],actual.source.entryFacts.map(f=>f.id),actual.source.sourceRows.map(r=>r.id));
    const selectedIds=adoptionSelection.selectedIds.filter(id=>adoptionPlan.fantasyCandidates.some(c=>c.id===id&&c.anchorRefs.some(ref=>refs.has(ref))));
    check.errors.push(...validateDraft({draft:group.draft,source,settings:d.settings,selection:{...adoptionSelection,selectedIds},plan:adoptionPlan,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion}).errors);
   }
   if(check.errors.length){candidate.status='needs_repair';return;}
  }
  const outside=d.plan.workPackages.filter(w=>!op.packageIds.includes(w.id)&&w.dependsOn.some(id=>op.packageIds.includes(id))&&d.adopted.some(a=>a.packageIds.includes(w.id)));
  const old=d.adopted.filter(a=>overlap(a.packageIds,op.packageIds));
  const changed=old.some(a=>a.draft.units.some(u=>{const revised=next.flatMap(n=>n.draft.units).find(v=>v.id===u.id);return revised?.exitState!==u.exitState||revised?.initialState!==u.initialState;}));
  const requiredPackageIds=continuityRepairScope(d,op,next,changed?outside:[]);
  if(requiredPackageIds.length){candidate.status='needs_dependency_repair';candidate.requiredPackageIds=requiredPackageIds;return;}
  d.adopted=d.adopted.filter(a=>!overlap(a.packageIds,op.packageIds));
  d.adopted.push(...next.map(n=>({...n,candidateId:candidate.id,stage:op.stage})));
  if(opportunity)commitOpportunity(d,candidate,op,opportunity);
  for(const prior of d.candidates)if(prior!==candidate&&!prior.resolvedBy&&((prior.status==='needs_dependency_repair'&&prior.requiredPackageIds.every(id=>op.packageIds.includes(id)))||(prior.status==='needs_repair'&&prior.packageIds.every(id=>op.packageIds.includes(id)))))prior.resolvedBy=candidate.id;
  candidate.status='adopted';d.status='drafting';refreshProductionState(d);
 }catch(e){candidate.status='needs_repair';candidate.errors=[errorRecord(e,'RESPONDED')];if(e.code==='PRODUCTION_ENTRY_EVIDENCE'&&d.production){d.production.entryEvidenceHold={candidateId:candidate.id,code:e.code,message:e.message};d.production.globalBlocking=true;d.production.blocking=true;}}
}

function commitOpportunity(d,candidate,op,opportunity){d.plan=opportunity.plan;candidate.opportunityAppend={version:op.opportunityBasis.version,addedIds:opportunity.addedIds,origin:'automatic_recommendation',choiceHash:op.opportunityBasis.choiceHash};}

// Validation only: the accepted baseline and its production receipts remain untouched.
function prepareRefinementCandidate(d,candidate,op){
 try{
  delete candidate.errors;delete candidate.refinementDelta;
  assertDirectorRefinementBase(d,op.refinement);
  const actual=currentRequest(d,op);if(identity(actual)!==op.fingerprint)fail('REFINEMENT_STALE','精修请求与当前来源或规则不一致。');
  assertDirectorRefinementDelta(op.previousDraft,candidate.output,op.refinement);
  const linked=normalizeRefinementLinkedUnits(op.previousDraft,candidate.output,op.refinement);
  if(linked.changes.length)candidate.refinementDelta=linked.delta;
  const output=applyDelta(op.previousDraft,linked.delta),normalized=normalizeDraft(output,actual.source,{plan:actual.plan,settings:d.settings,unitPackingPolicy:d.rulesSnapshot.unitPackingPolicy,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion,fantasyTimingVersion:d.rulesSnapshot.fantasyTimingVersion,dialogueSourceLinkVersion:d.rulesSnapshot.dialogueSourceLinkVersion,stage:'finish'});
  candidate.draft=normalized.draft;candidate.normalizations=[...linked.changes,...normalized.changes];
  assertDirectorRefinementDelta(op.previousDraft,candidate.output,op.refinement,candidate.draft);
  candidate.validation=validateDraft({draft:candidate.draft,source:d.source,settings:d.settings,selection:resolveSelection(d.plan,d.choice),plan:d.plan,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion});
  if(candidate.validation.errors.length){candidate.status='refinement_invalid';return;}
  if(op.productionSnapshot){candidate.productionFeedbackValidationVersion=PRODUCTION_FEEDBACK_VALIDATION_VERSION;candidate.productionFeedback=validateProductionFeedback(candidate.output?.productionFeedback,actual);}
  candidate.previewText=renderResolved(d,candidate.draft);
  candidate.adoptionBlocked=refinementAdoptionBlock(d,candidate);
  candidate.status=op.refinement.version===DIRECTOR_REFINEMENT_VERSION&&candidate.previewText===d.assembly.text?'refinement_no_change':'refinement_ready';
 }catch(error){candidate.status=error.code==='REFINEMENT_STALE'?'refinement_stale':'refinement_invalid';candidate.errors=[errorRecord(error,'RESPONDED')];}
}

function activeProductionReceipts(d){
 const currentIds=new Set(d.adopted.flatMap(a=>[a.candidateId,...(a.candidateIds||[])]));
 const receipts=d.candidates.filter(c=>c.productionFeedback&&!c.adoptedRefinement?.partial&&c.status==='adopted'&&(currentIds.has(c.id)||c.stage==='plan'&&c.output===d.plan));
 const plan=d.candidates.findLast(c=>c.stage==='plan'&&c.status==='adopted'&&c.productionFeedback);
 if(plan&&!receipts.includes(plan))receipts.unshift(plan);
 return receipts.map(c=>{
  const receipt=isDirectorRefinement(c)?refinementProductionFeedback(d,c):sourceResolutionFeedback(d,c);
  const packageIds=c.stage==='plan'?c.packageIds:[...new Set(d.adopted.filter(a=>[a.candidateId,...(a.candidateIds||[])].includes(c.id)).flatMap(a=>a.packageIds))];
  const needs=c.stage==='plan'?receipt.needs:receipt.needs.flatMap(n=>{const scope=n.packageIds.filter(id=>packageIds.includes(id));return scope.length?[{...n,packageIds:scope}]:[];});
  const effective=c.feedbackProjection||c.entryProjection?effectiveProductionFeedback(c):null;
  return {...c,packageIds,productionFeedback:{...receipt,needs,...(effective?{exit:effective.exit,entry:effective.entry}:{})}};
 });
}
function boundaryEntryReceipt(d,receipts){
 const first=d.plan&&sourceOrderedPackages(d)[0]?.id;
 return receipts.findLast(c=>c.stage!=='plan'&&c.packageIds.includes(first)&&d.operations.find(o=>o.attemptId===c.attemptId)?.productionSnapshot?.episodeBoundary)||receipts.findLast(c=>c.stage==='plan');
}
export function boundaryReviewEntry(d){return boundaryEntryReceipt(d,activeProductionReceipts(d))??null;}
export function boundaryEntryEvidence(d,entry=boundaryReviewEntry(d)){
 const draft=entry?.draft??d.assembly?.draft;
 const op=d.operations.find(o=>o.attemptId===entry?.attemptId);
 const entryReviewRequired=!isDirectorRefinement(op)&&op?.productionSnapshot?.entryReviewVersion===ENTRY_REVIEW_VERSION||Boolean(d.production?.boundaryReviews?.some(r=>r.version===ENTRY_REVIEW_VERSION&&r.candidateId===entry?.id));
 return {draft,evidenceContext:d.production?.entryEvidenceContext,entryBasis:draft?freezeEntryBasis(d,draft,entry?.packageIds||[],{candidateId:entry?.id}):null,entryReviewRequired};
}
function refreshProductionState(d){
 if(!d.production)return;
 const materialChanges=(op,materials,ids)=>{
  if(!op)return ids;
  try{return changedConsumedMaterials(op.productionSnapshot?.materials,materials,ids,currentRequest(d,op).source,op.productionSnapshot?.supplyVersion);}
  catch{return changedConsumedMaterials(op.productionSnapshot?.materials,materials,ids);}
 };
 const first=d.plan&&sourceOrderedPackages(d)[0]?.id;
 const receipts=activeProductionReceipts(d),entry=boundaryEntryReceipt(d,receipts);
 const previous=d.production.boundaryCheck;
 const context=d.production.boundary,feedback=entry?.productionFeedback,originalContext=c=>d.operations.find(o=>o.attemptId===c?.attemptId)?.productionSnapshot?.episodeBoundary;
 const receiptReviews=new Map(receipts.map(c=>[c.id,reviewedBoundaryResolution(context,c.productionFeedback,d.production.boundaryReviews,d.source,originalContext(c),boundaryEntryEvidence(d,c))]));
 const review=receiptReviews.get(entry?.id);
 let nativeEvidence;const entryOp=d.operations.find(o=>o.attemptId===entry?.attemptId);
 if(isFeedbackResultVersion(entryOp?.productionSnapshot?.feedbackResultVersion)&&entry?.draft){try{const request=currentRequest(d,entryOp);if(identity(request)===entryOp.fingerprint&&(entryOp.productionSnapshot.entryReviewVersion!==ENTRY_REVIEW_VERSION||digest(entryOp.productionSnapshot.entryEvidenceContext??null)===digest(d.production.entryEvidenceContext??null)))nativeEvidence={request,draft:entry.draft};}catch{/* Frozen-request or full-predecessor drift stays unresolved. */}}
 const check=reconcileBoundary({context,feedback,previousCheck:previous,review,reviews:d.production.boundaryReviews||[],source:d.source,originalContext:originalContext(entry),nativeEvidence,...boundaryEntryEvidence(d,entry)});
 d.production.boundaryCheck=check;
 if(d.production.entryEvidenceHold&&entry&&['NO_PREDECESSOR','MATCHED','NOT_CONTINUOUS','NOT_CONSUMED'].includes(check?.status)){
  const seen=new Set();let ancestor=d.candidates.find(c=>c.id===entry.id);
  while(ancestor&&!seen.has(ancestor.id)){
   seen.add(ancestor.id);
   if(ancestor.id===d.production.entryEvidenceHold.candidateId&&ancestor.id!==entry.id){
    d.production.entryEvidenceResolutions=[...(d.production.entryEvidenceResolutions||[]),{...d.production.entryEvidenceHold,resolvedBy:entry.id,reviewId:check.entryEvidenceReviewId??null,at:new Date().toISOString()}];
    delete d.production.entryEvidenceHold;break;
   }
   ancestor=d.candidates.find(c=>c.id===ancestor.derivedFrom);
  }
 }
 if(check&&(previous?.checkVersion!==check.checkVersion||previous?.status!==check.status||previous?.signature!==check.signature||previous?.reviewId!==check.reviewId||previous?.nativeEvidenceReviewId!==check.nativeEvidenceReviewId||Boolean(previous?.entryReviewRequired)!==Boolean(check.entryReviewRequired)||digest(previous?.pendingEntryKeys||[])!==digest(check.pendingEntryKeys||[])||digest(previous?.supplementalReviewIds||[])!==digest(check.supplementalReviewIds||[])||digest(previous?.currentSourceKeys||[])!==digest(check.currentSourceKeys||[]))){d.production.checkHistory??=[];d.production.checkHistory.push({...check,at:new Date().toISOString()});}
 const needs=receipts.flatMap(c=>c.productionFeedback.needs.map(n=>{
  const operationIndex=d.operations.findIndex(o=>o.attemptId===c.attemptId),operation=d.operations[operationIndex],snapshot=operation?.productionSnapshot;
  const historySource=d.rulesSnapshot.episodeEvidenceVersion==='episode-evidence-v1'&&n.stage===1&&n.target.startsWith('HISTORY_SOURCE:');
  const id=historySource?`history:${n.target}`:`asset:${n.target}`,provided=d.production.materials.filter(m=>m.id===id||m.kind==='ASSET_MATERIAL_CANDIDATE'&&m.assetKey===n.target&&n.packageIds.every(p=>m.packageIds.includes(p)));
  const sourceExpanded=n.stage===1&&['PREVIOUS_SOURCE','BOUNDARY_SOURCE'].includes(n.target)&&d.production.boundary?.seed?.previousSource?.selectionKind==='FULL_EPISODE_EXPANSION'&&snapshot?.episodeBoundary?.seed?.previousSource?.text!==d.production.boundary.seed.previousSource.text;
  const designResolved=n.stage===3&&receiptReviews.get(c.id)?.resolvedDesignConflicts?.some(s=>s.key===n.target&&s.sourceRefs.length===n.sourceRefs.length&&s.sourceRefs.every(id=>n.sourceRefs.includes(id)));
  const sourceResolution=sourceResolutionForNeed(d,c,n);
  const supplyUpdated=Boolean(designResolved||sourceResolution)||sourceExpanded||(n.stage===2||historySource)&&materialChanges(operation,provided,provided.map(m=>m.id)).length>0;
  const consumer=receipts.findLast(other=>other.stage!=='plan'&&other!==c&&n.packageIds.every(p=>other.packageIds.includes(p))
    &&d.operations.findIndex(o=>o.attemptId===other.attemptId)>operationIndex
    &&!other.productionFeedback.needs.some(x=>x.stage===n.stage&&x.target===n.target)
    &&(sourceExpanded?d.operations.find(o=>o.attemptId===other.attemptId)?.productionSnapshot?.episodeBoundary?.seed?.previousSource?.text===d.production.boundary.seed.previousSource.text
      :provided.some(m=>{
       const consumerOp=d.operations.find(o=>o.attemptId===other.attemptId);
       return other.productionFeedback.usedMaterialIds.includes(m.id)&&consumerOp?.productionSnapshot?.materials?.some(sent=>sent.id===m.id)
        &&materialChanges(consumerOp,provided,[m.id]).length===0;
      })));
  return {...n,blocking:n.blocking&&!supplyUpdated&&!consumer,supplyUpdated,resolved:Boolean(consumer||designResolved||sourceResolution),resolvedBy:consumer?.id??(sourceResolution?`sourceResolution:${sourceResolution.id}`:designResolved?`boundaryReview:${receiptReviews.get(c.id).id}`:null),candidateId:c.id,attemptId:c.attemptId};
 }));
 d.production.needs=needs;
 const changed=new Set(),changedMaterials=new Set(),changedFields=new Set();
 for(const candidate of receipts.filter(c=>c.stage!=='plan')){
  const original=d.candidates.find(c=>c.id===candidate.id);
  const currentOwners=d.adopted.filter(a=>[a.candidateId,...(a.candidateIds||[])].includes(candidate.id));
  for(const consumer of feedbackMaterialConsumers(original||candidate)){
  const supportedOwners=original?.feedbackProjection?currentOwners.filter(a=>a.draft.units.some(u=>(consumer.supportUnitIds??consumer.unitIds).includes(u.id))):currentOwners;
  if(original?.feedbackProjection&&!supportedOwners.length)continue;
  const affectedPackages=original?.feedbackProjection?[...new Set(supportedOwners.flatMap(a=>a.packageIds))]:candidate.packageIds;
  const op=d.operations.find(o=>o.attemptId===consumer.attemptId);
  let usedChanges=changedConsumedMaterials(op?.productionSnapshot?.materials,d.production.materials,consumer.materialIds);
  if(usedChanges.length&&op){
   // Reconstruct only the frozen consumer's readable scope. Never rewrite its
   // saved request or treat the full episode as if a local author had read it.
   try{usedChanges=changedConsumedMaterials(op.productionSnapshot?.materials,d.production.materials,consumer.materialIds,currentRequest(d,op).source,op.productionSnapshot?.supplyVersion);}catch{/* Unknown historical shape stays strict. */}
  }
  for(const id of usedChanges)changedMaterials.add(id);
  if(usedChanges.length&&d.rulesSnapshot.productionSupplyVersion===PRODUCTION_SUPPLY_VERSION){
   let source;try{source=currentRequest(d,op).source;}catch{/* Unknown old scope stays strict. */}
   for(const field of materialChangeCoordinates(op?.productionSnapshot?.materials,d.production.materials,usedChanges,source,op?.productionSnapshot?.supplyVersion))changedFields.add(field);
  }
  if(usedChanges.length)
   for(const id of affectedPackages)changed.add(id);
  }
 }
 if(check?.status==='REPAIR_REQUIRED'&&first&&d.adopted.some(a=>a.packageIds.includes(first)))changed.add(first);
 for(const candidate of d.candidates.filter(c=>c.status==='needs_dependency_repair'&&!c.resolvedBy))
  if(candidate.packageIds.some(id=>changed.has(id)))for(const id of candidate.requiredPackageIds||[])changed.add(id);
 // Dependencies that have never been authored have nothing to repair: their first
 // request will already read the new input. Keep paid adopted/raw scopes only.
 const repairable=new Set([...d.adopted.flatMap(a=>a.packageIds),...d.candidates.filter(c=>c.status==='needs_repair'&&c.raw&&!c.resolvedBy).flatMap(c=>c.packageIds)]);
 // Repair direct consumers first. A later package is not stale merely because
 // its predecessor needs a local fix: adoption compares the actual revised tail
 // and expands only then. A unit spanning packages remains indivisible.
 const direct=new Set(changed);
 if(d.rulesSnapshot.productionSupplyVersion===PRODUCTION_SUPPLY_VERSION){
  let size;
  do{size=direct.size;for(const a of d.adopted)if(a.packageIds.some(id=>direct.has(id)))for(const id of a.packageIds)direct.add(id);}while(size!==direct.size);
 }
 const scope=(d.rulesSnapshot.productionSupplyVersion===PRODUCTION_SUPPLY_VERSION?(d.plan?sourceOrderedPackages(d).filter(w=>direct.has(w.id)).map(w=>w.id):[]):dependencyScope(d,[...changed])).filter(id=>repairable.has(id));
 d.production.pendingRepair=scope.length?{versionId:digest({scope,boundary:check?.signature,materials:d.production.materials.filter(m=>changedMaterials.has(m.id)).map(m=>({id:m.id,version:m.version}))}),packageIds:scope,changedKeys:[...new Set([...(check?.changedKeys||[]),...changedFields])],reason:check?.status==='REPAIR_REQUIRED'?'EPISODE_BOUNDARY':'CONSUMED_MATERIAL'}:null;
 d.production.globalBlocking=Boolean(d.production.entryEvidenceHold)||check?.status==='CONSTRAINT_CONFLICT'||receipts.some(c=>{
  const review=receiptReviews.get(c.id),reviewed=new Set([...(review?.sourceClaimReviews||[]),...(review?.resolvedDesignConflicts||[])].map(s=>s.key));
  return c.productionFeedback.conflicts.some(s=>!reviewed.has(s.key));
 });
 d.production.blocking=d.production.globalBlocking||needs.some(n=>n.blocking);
}

export function createEngine({directory,modelRunner=runModel,runnerOptions={}}){
 const store=createStore(directory,{trackRevision:true}),controllers=new Map();
 async function settle(id,attemptId,result,error){
  return store.update(id,d=>{const op=d.operations.find(o=>o.attemptId===attemptId);if(!op)fail('ATTEMPT','作业不存在');
   if(op.status==='completed')return d;
   const raw=result?.raw??error?.raw??null;op.status=error?.requestOutcome==='UNKNOWN'?'unknown':'completed';op.error=error?errorRecord(error):null;
   const disposition=result?.responseDisposition??error?.responseDisposition;
   op.localSettledAt=new Date().toISOString();op.receipt={requestOutcome:result?.requestOutcome||error?.requestOutcome||'RESPONDED',usage:result?.usage||error?.usage||null,...(['final','incomplete','none'].includes(disposition)?{responseDisposition:disposition}:{})};
   let c;if(result?.output!==undefined||raw){c={id:randomUUID(),attemptId,stage:op.stage,packageIds:op.packageIds,raw,output:result?.output??null,status:'received',receipt:op.receipt,...candidateExecutionFields(op)};d.candidates.push(c);if(op.epoch!==d.epoch)c.status='cancelled_late';else if(c.output===null){c.status=isDirectorRefinement(op)?'refinement_invalid':'needs_repair';c.errors=[errorRecord(error||{code:'INVALID_JSON',message:'响应不是合法JSON'})];}else adopt(d,c);}
   if(isDirectorRefinement(op))return d;
   if(op.epoch!==d.epoch)return d;
   d.status=attentionStatus(d)||(c?c.status==='adopted'?d.status:c.status:error?'failed':d.status);
   return d;
  });
 }
 return {
  async create({id,source,settings,voiceReference=null,production=null}){const normalized=normalizeSource(source),effective=normalizeSettings(settings);if(normalized.diagnostics.length)fail('SOURCE_DIAGNOSTICS','源材料有未处理歧义');currentDocumentSourceResolutions({source:normalized,production,plan:null,candidates:[]});return store.create(id,{version:VERSION,id,source:normalized,settings:effective,voiceReference,rulesSnapshot:captureRules(),rulesHistory:[],plan:null,choice:defaultChoice(effective.fantasyMode),operations:[],candidates:[],adopted:[],epoch:0,status:'created',...(production?{production:structuredClone(production)}:{})});},
  read:id=>store.read(id),
  async resolveSource(id,value,approval){return store.update(id,d=>{
   if(!d.production)fail('SOURCE_RESOLUTION','任务没有生产资料接收框架。');
   const resolution=recordSourceResolution(d,value,approval);
   if(!d.production.sourceResolutions?.some(r=>r.id===resolution.id))d.production.sourceResolutions=[...(d.production.sourceResolutions||[]),resolution];
   refreshProductionState(d);return d;
  });},
  async reviewBoundary(id,raw){return store.update(id,d=>{
   if(!d.production?.boundary)fail('BOUNDARY_REVIEW','任务没有可复核的边界。');
   if(d.operations.some(isUnresolvedOperation))fail('BOUNDARY_REVIEW_BUSY','有未结请求时不能复核边界。');
   if(d.web?.sourceStale)fail('BOUNDARY_REVIEW_STALE','原文已变化，不能复用旧边界复核。');
   const entry=boundaryEntryReceipt(d,activeProductionReceipts(d));
   const review=validateBoundaryReview(raw,{context:d.production.boundary,feedback:entry?.productionFeedback,source:d.source,originalContext:d.operations.find(o=>o.attemptId===entry?.attemptId)?.productionSnapshot?.episodeBoundary,...boundaryEntryEvidence(d,entry)});
   if(!d.production.boundaryReviews?.some(r=>r.id===review.id))d.production.boundaryReviews=[...(d.production.boundaryReviews||[]),{...review,candidateId:entry.id,at:new Date().toISOString()}];
   refreshProductionState(d);return d;
  });},
  async refreshProduction(id,context){return store.update(id,d=>{
   if(!d.production)return d;
   const previous=d.production.boundary?.selected?.selectionRevision??0,next=context.boundary?.selected?.selectionRevision??0;
   if(next<previous)fail('PRODUCTION_REVISION','跨集选择版本过期，不能覆盖较新的生产链。');
   const sameSelected=d.production.boundary?.selected?.runId===context.boundary?.selected?.runId&&previous===next;
   if(sameSelected&&(context.predecessorRevision??0)<(d.production.predecessorRevision??0))fail('PRODUCTION_REVISION','前集较早的结果晚到，不能覆盖已核对的较新尾稿。');
   d.production={...d.production,predecessorRevision:context.predecessorRevision??0,boundary:structuredClone(context.boundary??null),entryEvidenceContext:structuredClone(context.entryEvidenceContext??null),outgoingAgreements:structuredClone(context.outgoingAgreements||[]),materials:structuredClone(context.materials||[])};
   refreshProductionState(d);return d;
  });},
  async execute(id,{stage,packageId,packageIds,attemptId=randomUUID(),issues=[],finishMode='full',feedbackCandidateId=null,purpose=null,refinementEventIds,refinementWorkOrder}={}){
   if(!['plan','author','finish'].includes(stage))fail('STAGE','未知作业阶段');
   if(!['full','delta'].includes(finishMode))fail('FINISH_MODE','整编模式无效');
   if(!validAttempt(attemptId))fail('INVALID_ATTEMPT','作业编号无效');
   if(purpose!==null&&purpose!==DIRECTOR_REFINEMENT_PURPOSE)fail('PURPOSE','未知创作目的');
   if(purpose===DIRECTOR_REFINEMENT_PURPOSE&&(stage!=='finish'||finishMode!=='delta'||feedbackCandidateId))fail('REFINEMENT_REQUEST','导演精修只执行一次完整基稿差量请求。');
   const chosen=stage==='plan'?[]:packageIds||[packageId];let request;
   await store.update(id,d=>{if(d.web?.stopped||d.web?.pauseRequested)throw Object.assign(new Error('任务已停止派发'),{code:'RUN_PAUSED',requestOutcome:'NOT_SENT'});if(d.operations.some(o=>o.attemptId===attemptId))fail('ATTEMPT_EXISTS','已有同编号作业');scopeCheck(d,stage,chosen,{freshAuthor:!feedbackCandidateId});
    if(feedbackCandidateId){
     const candidate=d.candidates.find(c=>c.id===feedbackCandidateId),original=candidate&&d.operations.find(o=>o.attemptId===candidate.attemptId);
     if(!feedbackOnlyFailure(candidate)||candidate.resolvedBy||original.stage!==stage||digest(original.packageIds)!==digest(chosen))fail('FEEDBACK_REPAIR_INPUT','回执修复必须沿用未解决原稿的阶段与范围。');
     request=feedbackRequestFor(d,feedbackCandidateId,issues,CURRENT_FEEDBACK_REPAIR_VERSION);
     invalidate(d,'running');d.operations.push({...structuredClone(original),attemptId,feedbackRepair:request.feedbackRepair,issues,fingerprint:identity(request),modelCoordinates:undefined,epoch:d.epoch,status:'running',createdAt:new Date().toISOString(),receipt:undefined,error:undefined,recovery:undefined,cancelAcknowledgement:undefined,cancelRequestedAt:undefined,localSettledAt:undefined});return d;
    }
    const refinement=purpose===DIRECTOR_REFINEMENT_PURPOSE?freezeDirectorRefinement(d,chosen,refinementEventIds,refinementWorkOrder):null;
    const previousPlan=stage==='plan'&&issues.length?d.candidates.findLast(c=>c.stage==='plan'&&c.status==='needs_repair'&&!c.resolvedBy&&c.raw):null;
    const executionBatch=refinement?null:nextExecution(d,stage,chosen);
    const previousDraft=refinement?structuredClone(d.assembly.draft):stage==='finish'?(executionBatch?previousBatch(d,executionBatch):previousOf(d,chosen)):previousPlan?{...rawCandidateInput(d,previousPlan),previousPlan:previousPlan.output}:null;
    request=requestOf(d,stage,chosen,previousDraft,issues,'continuity-v1',finishMode,executionBatch,undefined,undefined,refinement);
    if(refinement)request=decorateDirectorRefinementRequest(request,refinement);else invalidate(d,'running');
    d.operations.push({attemptId,stage,packageIds:chosen,previousDraft,issues,finishMode:request.finishMode,baseDraftHash:request.baseDraftHash||null,...(request.opportunityBasis?{opportunityBasis:structuredClone(request.opportunityBasis)}:{}),dependencyFormat:'continuity-v1',...(refinement?{purpose,refinement}:{}),...(request.modelCoordinates?{modelCoordinates:structuredClone(request.modelCoordinates)}:{}),...(stage!=='plan'&&acceptsContinuity(d)?{acceptedContinuityVersion:ACCEPTED_CONTINUITY_VERSION}:{}),...(request.productionSnapshot?{productionSnapshot:structuredClone(request.productionSnapshot)}:{}),fingerprint:identity(request),epoch:d.epoch,status:'running',createdAt:new Date().toISOString(),...executionFields(executionBatch)});return d;});
   const controller=new AbortController();controllers.set(attemptId,controller);
   try{const result=await modelRunner(request,{directory,attemptId,runId:id,signal:controller.signal,...runnerOptions});return await settle(id,attemptId,result,null);}
   catch(error){await settle(id,attemptId,null,error);throw error;}
   finally{controllers.delete(attemptId);}
  },
  async setChoice(id,choice){return store.update(id,d=>{if(!d.plan)fail('PLAN_REQUIRED','先完成计划');if(hasExecutionDrafts(d))fail('RESET_DRAFTS_REQUIRED','已有执行批次正文，须先明确归档重做');if(choice.mode!==d.settings.fantasyMode)fail('SETTINGS_SELECTION','模式不能被模型或局部选择改写');resolveSelection(d.plan,choice);d.choice=structuredClone(choice);invalidate(d,'planned');return d;});},
  async confirmChoice(id,selectedIds,expectedFingerprint){return store.update(id,d=>{if(!d.plan)fail('PLAN_REQUIRED','先完成计划');if(hasExecutionDrafts(d))fail('RESET_DRAFTS_REQUIRED','已有执行批次正文，须先明确归档重做');d.choice=confirmSelection(d.plan,d.choice,selectedIds,expectedFingerprint);invalidate(d,'planned');return d;});},
  async setFantasyMode(id,mode){return store.update(id,d=>{if(hasExecutionDrafts(d))fail('RESET_DRAFTS_REQUIRED','已有执行批次正文，须先明确归档重做');d.settings=normalizeSettings({...d.settings,fantasyMode:mode});d.choice=defaultChoice(mode);invalidate(d,d.plan?'planned':'created');return d;});},
  async refreshRules(id){return store.update(id,d=>{if(d.operations.some(isUnresolvedOperation))fail('RULES_BUSY','有未结作业时不能刷新规则');if(hasExecutionDrafts(d))fail('RESET_DRAFTS_REQUIRED','已有执行批次正文，须先明确归档重做');const oldHash=digest(d.rulesSnapshot),next=captureRules(),newHash=digest(next);if(d.plan&&(d.rulesSnapshot.systemPresentationVersion!==next.systemPresentationVersion||d.rulesSnapshot.opportunityCoverageVersion!==next.opportunityCoverageVersion||d.rulesSnapshot.outputSchemaVersion!==next.outputSchemaVersion||d.rulesSnapshot.unitPackingPolicy!==next.unitPackingPolicy||d.rulesSnapshot.unitDirectionVersion!==next.unitDirectionVersion||d.rulesSnapshot.seedanceExportVersion!==next.seedanceExportVersion||d.rulesSnapshot.sourceExpressionMethodsVersion!==next.sourceExpressionMethodsVersion||d.rulesSnapshot.authorCallGroupingVersion!==next.authorCallGroupingVersion||d.rulesSnapshot.schemaProjectionVersion!==next.schemaProjectionVersion||d.rulesSnapshot.acceptedContinuityVersion!==next.acceptedContinuityVersion||d.rulesSnapshot.fantasyTimingVersion!==next.fantasyTimingVersion||d.rulesSnapshot.visualSubjectsVersion!==next.visualSubjectsVersion||d.rulesSnapshot.dialogueSourceLinkVersion!==next.dialogueSourceLinkVersion||d.rulesSnapshot.productionFeedbackResultVersion!==next.productionFeedbackResultVersion))fail('RULES_PROTOCOL_CHANGE','已有规划不能直接换用不同输出协议；原稿保留，请用新任务测试新版本。');d.rulesSnapshot=next;d.rulesHistory=[...(d.rulesHistory||[]),{at:new Date().toISOString(),oldHash,newHash}];invalidate(d,d.plan?'planned':'created');return d;});},
  async cancel(id,{reason='cancel'}={}){const d=await store.update(id,d=>{const running=d.operations.filter(o=>o.status==='running');d.epoch++;if(!running.length||!running.every(isDirectorRefinement))d.status='cancelled';for(const op of running){op.cancelRequestedAt=new Date().toISOString();op.cancelReason=reason;}return d;});for(const o of d.operations.filter(o=>o.status==='running'))controllers.get(o.attemptId)?.abort();return d;},
  async recover(id,attemptId){if(!validAttempt(attemptId))fail('INVALID_ATTEMPT','作业编号无效');const before=await store.read(id),prior=before.operations.find(o=>o.attemptId===attemptId);if(!prior)fail('ATTEMPT','作业不存在');if(controllers.has(attemptId))fail('RUN_ACTIVE','本地作业尚未结束');
   if(prior.recovery?.epoch===before.epoch||(prior.status==='completed'&&!hasPendingSavedResponse(before,prior)))return before;
   let result,error;
   try{result=await readCompletedAttempt({directory,attemptId});}
   catch(e){if(e.code==='INVALID_JSON')error=e;else if(e.code==='ATTEMPT_UNRESOLVED')return store.update(id,d=>{const op=d.operations.find(o=>o.attemptId===attemptId);if(op.status!=='completed')op.status='unknown';if(op.epoch===d.epoch&&!isDirectorRefinement(op))d.status=attentionStatus(d)||d.status;return d;});else throw e;}
   return store.update(id,d=>{const op=d.operations.find(o=>o.attemptId===attemptId);if(op.recovery?.epoch===d.epoch)return d;if(d.web?.sourceStale)fail('SOURCE_STALE','源版本已变化');
    if(d.operations.some(o=>o.attemptId!==attemptId&&isUnresolvedOperation(o)&&(op.stage==='plan'||o.stage==='plan'||overlap(op.packageIds,o.packageIds))))fail('RECOVERY_BUSY','同范围仍有其它未结作业，请先核对回执');
    const actual=currentRequest(d,op);if(identity(actual)!==op.fingerprint)fail('STALE_CANDIDATE','保存回包与当前源、规则或依赖不一致');
    const savedFingerprint=result?.requestFingerprint||error?.requestFingerprint;if(savedFingerprint&&savedFingerprint!==op.fingerprint)fail('ATTEMPT_CONFLICT','保存请求与作业指纹不一致');
    const original=d.candidates.findLast(c=>c.attemptId===attemptId),c={id:randomUUID(),attemptId,stage:op.stage,packageIds:op.packageIds,raw:result?.raw??error.raw,output:result?.output??null,status:'received',receipt:{requestOutcome:'RESPONDED',usage:result?.usage||error?.usage||null},recoveredAt:new Date().toISOString(),...(original?{derivedFrom:original.id}:{}),...candidateExecutionFields(op)};
    const responseHashes=[...new Set([...consumedResponseHashes(d,op),savedResponseHash(original),savedResponseHash(c)].filter(Boolean))];
    d.candidates.push(c);op.recovery={at:c.recoveredAt,epoch:d.epoch,candidateId:c.id,previousStatus:op.status,responseHashes};op.status='completed';
    if(c.output===null){c.status=isDirectorRefinement(op)?'refinement_invalid':'needs_repair';c.errors=[errorRecord(error,'RESPONDED')];}else adopt(d,c,{recovery:true});
    if(isDirectorRefinement(op))return d;
    d.status=attentionStatus(d)||(c.status==='adopted'?d.status:c.status);return d;});
  },
  async acceptRefinement(id,candidateId,expectedBaseHash,groupIds,sourceResolution){return store.update(id,d=>{
   const candidate=d.candidates.find(c=>c.id===candidateId),op=d.operations.find(o=>o.attemptId===candidate?.attemptId);
   if(!candidate||!isDirectorRefinement(op))fail('REFINEMENT_CANDIDATE','指定记录不是导演精修候选。');
   if(candidate.status!=='refinement_ready'||expectedBaseHash!==op.refinement.baseAssemblyHash)fail('REFINEMENT_STALE','精修候选或确认基稿已变化。');
   if(d.operations.some(isUnresolvedOperation)||d.web?.stopped||d.web?.pauseRequested)fail('REFINEMENT_BUSY','仍有未结请求或任务暂停，不能采用候选。');
   assertDirectorRefinementBase(d,op.refinement);
   if(sourceResolution!==undefined)recordRefinementSourceResolution(d,candidate,sourceResolution);
   const blocked=refinementAdoptionBlock(d,candidate);if(blocked)fail(blocked.code,blocked.message);
   prepareRefinementCandidate(d,candidate,op);if(candidate.status!=='refinement_ready')fail(candidate.errors?.[0]?.code||'REFINEMENT_INVALID','精修候选最终校验未通过，基稿保留。');
   if(candidate.adoptionBlocked)fail(candidate.adoptionBlocked.code,candidate.adoptionBlocked.message);
   const comparison=getRefinementComparison(d,candidate);
   if(comparison.status==='unchanged')fail('REFINEMENT_UNCHANGED','精修正文没有变化，保留原稿；无需重复采用，不改写采用历史。');
   if(comparison.status!=='changed')fail('REFINEMENT_STALE','无法核验精修与冻结基稿的实际变化，原稿保留。');
   let selected={groupIds:getRefinementAcceptanceGroups(d,candidate).map(g=>g.id),partial:false,retainedUnitIds:(candidate.refinementDelta||candidate.output).retainedUnitIds||[]},adoption={draft:candidate.draft,validation:candidate.validation,text:candidate.previewText,normalizations:candidate.normalizations};
   if(groupIds!==undefined||selected.groupIds.length){
    selected=selectRefinementGroups(d,candidate,groupIds===undefined?selected.groupIds:groupIds);
    if(selected.partial){
     const normalized=normalizeDraft(applyDelta(op.previousDraft,selected.delta),d.source,{plan:d.plan,settings:d.settings,unitPackingPolicy:d.rulesSnapshot.unitPackingPolicy,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion,fantasyTimingVersion:d.rulesSnapshot.fantasyTimingVersion,dialogueSourceLinkVersion:d.rulesSnapshot.dialogueSourceLinkVersion,stage:'finish'});
     assertRefinementRetained(op.previousDraft,normalized.draft,selected.retainedUnitIds);assertRefinementSeams(op.previousDraft,normalized.draft,selected.retainedUnitIds);
     const validation=validateDraft({draft:normalized.draft,source:d.source,settings:d.settings,selection:resolveSelection(d.plan,d.choice),plan:d.plan,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion});
     if(validation.errors.length)fail('REFINEMENT_INVALID','选中修改组与保留基稿的完整校验未通过，基稿保留。');
     adoption={draft:normalized.draft,validation,text:renderResolved(d,normalized.draft),normalizations:normalized.changes};
    }
   }
   if(adoption.text===d.assembly.text)fail('REFINEMENT_UNCHANGED','选中修改组的正文没有变化，保留基稿，不改写采用历史。');
   const next=groups(d,op.packageIds,adoption.draft),baseCandidateIds=selected.partial?[...new Set(d.adopted.flatMap(a=>[a.candidateId,...(a.candidateIds||[])]))]:[];
   d.refinementArchives??=[];d.refinementArchives.push({at:new Date().toISOString(),candidateId:candidate.id,baseAssemblyHash:op.refinement.baseAssemblyHash,assembly:structuredClone(d.assembly),adopted:structuredClone(d.adopted)});
   d.adopted=next.map(n=>({...n,candidateId:candidate.id,...(baseCandidateIds.length?{candidateIds:baseCandidateIds}:{}),stage:'finish'}));candidate.status='adopted';candidate.adoptedAt=new Date().toISOString();
   candidate.adoptedRefinement={version:REFINEMENT_SELECTION_VERSION,groupIds:selected.groupIds,partial:selected.partial,retainedUnitIds:selected.retainedUnitIds,...structuredClone(adoption),at:candidate.adoptedAt};
   d.assembly={draft:structuredClone(adoption.draft),validation:structuredClone(adoption.validation),text:adoption.text};d.status='text_ready_for_review';refreshProductionState(d);return d;
  });},
  async recheckCandidate(id,candidateId){return store.update(id,d=>{
   const original=d.candidates.find(c=>c.id===candidateId);if(!original)fail('CANDIDATE','候选不存在');if(original.output===null||original.output===undefined)fail('RECHECK_INPUT','候选没有可重校的结构化响应');
   const op=d.operations.find(o=>o.attemptId===original.attemptId);if(!op)fail('ATTEMPT','候选作业不存在');scopeCheck(d,original.stage,original.packageIds);
   if(isDirectorRefinement(op)){
    if(!canRecheckCandidate(d,original))fail('RECHECK_INELIGIBLE','精修候选的基稿或来源已变化，不能重校覆盖。');
    const derived={...structuredClone(original),id:randomUUID(),derivedFrom:original.id,status:'received'};d.candidates.push(derived);prepareRefinementCandidate(d,derived,op);
    if(['refinement_ready','refinement_no_change'].includes(derived.status))original.resolvedBy=derived.id;
    return d;
   }
   const equivalentBatch=op.executionProjectionVersion&&original.status==='adopted'&&!original.resolvedBy&&!d.web?.sourceStale&&!d.operations.some(isUnresolvedOperation)&&d.executionBatches?.[op.packageIds[0]]?.accepted?.[op.executionBatchId]===original.id&&identity(currentRequest(d,op))===op.fingerprint;
   if(!canRecheckCandidate(d,original)&&!equivalentBatch)fail('RECHECK_INELIGIBLE','候选已解决、已采用或当前条件不允许重校；已有稿和记录保留');
   const previousStatus=d.status,previousAssembly=d.assembly,derived={id:randomUUID(),attemptId:original.attemptId,stage:original.stage,packageIds:original.packageIds,raw:original.raw,output:structuredClone(original.output),status:'received',receipt:original.receipt,derivedFrom:original.id,...candidateExecutionFields(op)};
   if(original.feedbackMerged){derived.feedbackMerged=true;derived.modelOutput=structuredClone(original.modelOutput);}
   d.candidates.push(derived);invalidate(d,'rechecking');adopt(d,derived,{recovery:op.recovery?.epoch===d.epoch||consumedResponseHashes(d,op).has(savedResponseHash(original))});
   if(derived.equivalentTo){d.status=previousStatus;d.assembly=previousAssembly;}
   else if(['needs_repair','needs_dependency_repair'].includes(derived.status))d.status=derived.status;
   return d;
  });},
  async assemble(id){return store.update(id,d=>{if(!d.plan)fail('PLAN_REQUIRED','先完成计划');if(d.operations.some(isUnresolvedOperation)||d.candidates.some(c=>c.status==='needs_dependency_repair'&&!c.resolvedBy))fail('ASSEMBLY_BUSY','仍有未结作业或需联修的依赖范围');const all=new Set(d.plan.workPackages.map(w=>w.id)),covered=new Set(d.adopted.filter(a=>a.stage==='finish').flatMap(a=>a.packageIds));if([...all].some(id=>!covered.has(id)))fail('FINISH_REQUIRED','全部工作包完成整编后才能汇总');for(const a of d.adopted){const operations=adoptionOperations(d,a);try{if(!operations.length||operations.some(op=>identity(currentRequest(d,op))!==op.fingerprint))fail('STALE_ADOPTION','已采用稿依赖的材料或选择已变更');}catch(e){if(e.code==='STALE_ADOPTION')throw e;fail('STALE_ADOPTION','已采用稿依赖的材料或选择已变更');}}const rank=new Map(d.source.sourceRows.map((r,i)=>[r.id,i]));const units=d.adopted.flatMap(a=>a.draft.units).sort((a,b)=>Math.min(...a.shots.flatMap(s=>s.sourceRefs.map(r=>rank.get(r)??Infinity)))-Math.min(...b.shots.flatMap(s=>s.sourceRefs.map(r=>rank.get(r)??Infinity))));const draft={schemaVersion:VERSION,units,fantasyRealization:d.adopted.flatMap(a=>a.draft.fantasyRealization)};const check=validateDraft({draft,source:d.source,settings:d.settings,selection:resolveSelection(d.plan,d.choice),plan:d.plan,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion});d.assembly={draft,validation:check,text:renderResolved(d,draft)};d.status=check.errors.length?'needs_repair':'text_ready_for_review';return d;});}
 };
}
