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
export {executionState,hasExecutionDrafts} from './execution-batches.mjs';

const identity=r=>digest([r.promptHash,r.instructionHash,r.inputHash]);
const validAttempt=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
const ids=(d,o)=>o.stage==='plan'?[]:(o.packageIds||[o.packageId]);
const overlap=(a,b)=>a.some(x=>b.includes(x));
const errorRecord=(e,outcome=e.requestOutcome||'UNKNOWN')=>({code:e.code||'RUNNER_ERROR',message:e.message,requestOutcome:outcome});
export const PLAN_VALIDATION_VERSION='plan-citations-v1';
const invalidate=(d,status)=>{d.assembly=null;d.status=status;};
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
 return op.recovery?.epoch!==d.epoch&&(d.candidates||[]).some(c=>c.attemptId===op.attemptId&&!consumed.has(savedResponseHash(c))&&(c.status==='cancelled_late'||op.status==='completed'&&['TIMEOUT','CLI_FAILED'].includes(op.error?.code)&&c.output==null&&c.raw?.trim()&&c.status==='needs_repair'&&!c.resolvedBy));
}
const attentionStatus=d=>d.operations.some(o=>o.epoch===d.epoch&&o.status==='running')?'running':d.operations.some(o=>o.status==='unknown'&&isUnresolvedOperation(o))?'unknown':null;
const requestOf=(d,stage,packageIds,previousDraft,issues=[],format='continuity-v1',finishMode='full',executionBatch=null,continuityVersion=d.rulesSnapshot.acceptedContinuityVersion)=>{
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
 return buildRequest({stage,source:d.source,settings:d.settings,plan:d.plan,choice:d.choice,packageId:packageIds[0],packageIds,previousDraft,voiceReference:d.voiceReference,rulesSnapshot:d.rulesSnapshot,dependencyExits,issues,finishMode,...(continuity?{acceptedContinuity:continuity}:{}),...(executionBatch?{executionBatch}:{})});
};
// An old operation must never acquire a newly enabled input on recovery/recheck.
const currentRequest=(d,op)=>requestOf(d,op.stage,op.packageIds,op.previousDraft,op.issues,op.dependencyFormat||'legacy',op.finishMode||'full',savedExecutionProjection(d,op),op.acceptedContinuityVersion??null);
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
const executionFields=batch=>batch?{executionProjectionVersion:EXECUTION_PROJECTION_VERSION,executionBatchId:batch.id,executionManifestHash:batch.manifestHash,executionBatch:batch}:{};
const candidateExecutionFields=op=>op.executionProjectionVersion?{executionProjectionVersion:op.executionProjectionVersion,executionBatchId:op.executionBatchId,executionManifestHash:op.executionManifestHash}:{};
const batchCandidate=(d,batch)=>d.candidates.findLast(c=>c.executionManifestHash===batch.manifestHash&&c.executionBatchId===batch.id&&!c.resolvedBy&&c.status==='needs_repair');
function nextExecution(d,stage,packageIds){
 if(packageIds.length!==1)return null;
 const packageId=packageIds[0];let manifest=d.executionBatches?.[packageId];
 if(manifest&&manifest.baseHash!==executionBaseHash(d)&&!hasExecutionDrafts({...d,executionBatches:{[packageId]:manifest}})){delete d.executionBatches[packageId];manifest=null;}
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
function previousBatch(d,batch){
 const bad=batchCandidate(d,batch),accepted=d.candidates.find(c=>c.id===d.executionBatches[batch.packageId].accepted[batch.id]);
 if(bad?.draft)return structuredClone(bad.draft);
 if(bad?.raw)return {rawText:bad.raw};
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
function previousOf(d,packageIds){
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
 for(const c of d.candidates.toReversed())if(['needs_repair','needs_dependency_repair'].includes(c.status)&&!c.resolvedBy&&overlap(c.packageIds,packageIds)&&c.packageIds.some(id=>packageIds.includes(id)&&!seen.has(id))){for(const id of c.packageIds)seen.add(id);supplementalCandidates.push({packageIds:c.packageIds,status:c.status,...(c.draft?{draft:c.draft}:{rawText:c.raw})});}
 supplementalCandidates.reverse();
 if(entries.length)return {schemaVersion:VERSION,units,fantasyRealization:entries.flatMap(a=>a.draft.fantasyRealization),...(supplementalCandidates.length?{supplementalCandidates}:{})};
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
function adoptExecution(d,candidate,op,draft){
 const manifest=d.executionBatches[op.packageIds[0]],accepted=d.candidates.find(c=>c.id===manifest.accepted[op.executionBatchId]);
 if(accepted&&digest(accepted.draft)===digest(draft)){candidate.status='adopted';candidate.equivalentTo=accepted.id;return;}
 if(accepted&&manifest.batches.slice(manifest.batches.findIndex(b=>b.id===op.executionBatchId)+1).some(b=>manifest.accepted[b.id])){candidate.status='stale';candidate.errors=[errorRecord({code:'EXECUTION_STALE',message:'后续批次已使用此前正文，不能只替换前序批次'},'RESPONDED')];return;}
 const combined=combinedExecutionDraft(d,manifest,{batchId:op.executionBatchId,draft});
 if(combined){
  const full=requestOf(d,'author',op.packageIds,null),check=validateDraft({draft:combined,source:full.source,settings:{...d.settings,maxUnits:null},selection:full.selection,plan:d.plan,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion});
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
 try{if(op.stage!=='plan')assertGroupScope(d,op.packageIds);}catch(e){candidate.status='stale';candidate.errors=[errorRecord(e)];return;}
 let actual;try{if(op.executionProjectionVersion)assertBatchContinuity(d,d.executionBatches?.[op.packageIds[0]]);actual=currentRequest(d,op);}catch(e){candidate.status='stale';candidate.errors=[errorRecord(e)];return;}
 if(identity(actual)!==op.fingerprint){candidate.status='stale';return;}
 if(op.stage==='plan'){
  candidate.validatorVersion=PLAN_VALIDATION_VERSION;
  try{const next=normalizePlan(candidate.output,d.source,{unitPackingPolicy:d.rulesSnapshot.unitPackingPolicy});
   candidate.normalizations=next.entryFacts.flatMap((f,i)=>JSON.stringify(f.evidence)===JSON.stringify(candidate.output.entryFacts[i].evidence)?[]:[{coordinate:f.id,field:'evidence',from:candidate.output.entryFacts[i].evidence??null,to:f.evidence,action:f.evidenceMode==='source_rows'?'extract_source':'verified_segments'}]);
   d.choice=d.plan?rebaseSelection(d.plan,next,d.choice):d.choice;d.plan=next;d.adopted=[];candidate.status='adopted';for(const prior of d.candidates)if(prior!==candidate&&prior.stage==='plan'&&prior.status==='needs_repair'&&!prior.resolvedBy)prior.resolvedBy=candidate.id;invalidate(d,'planned');}catch(e){candidate.status='needs_repair';candidate.errors=[errorRecord(e,'RESPONDED')];}
  return;
 }
 try{
  if(op.finishMode==='delta'&&baseDraftHash(op.executionProjectionVersion?previousBatch(d,op.executionBatch):previousOf(d,op.packageIds))!==op.baseDraftHash){candidate.status='stale';return;}
  const output=op.finishMode==='delta'?applyDelta(op.previousDraft,candidate.output):candidate.output;
  const {draft,changes}=normalizeDraft(output,actual.source,{plan:actual.plan,settings:actual.settings,unitPackingPolicy:d.rulesSnapshot.unitPackingPolicy,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion,stage:op.stage});candidate.draft=draft;candidate.normalizations=changes;
  const check=validateDraft({draft,source:actual.source,settings:op.executionProjectionVersion?{...d.settings,maxUnits:null}:d.settings,selection:actual.selection,plan:d.plan,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion});candidate.validation=check;
  if(check.errors.length){candidate.status='needs_repair';return;}
  if(op.executionProjectionVersion){adoptExecution(d,candidate,op,draft);return;}
  const next=groups(d,op.packageIds,draft);
  if(d.rulesSnapshot.authorCallGroupingVersion===AUTHOR_CALL_GROUPING_VERSION&&op.packageIds.length>1){
   // One transport scope must not weaken the original packages' dialogue or fantasy ownership.
   for(const group of next){
    const refs=new Set(d.plan.workPackages.filter(w=>group.packageIds.includes(w.id)).flatMap(w=>w.sourceRefs));
    const source=sliceSource(actual.source,[...refs],actual.source.entryFacts.map(f=>f.id),actual.source.sourceRows.map(r=>r.id));
    const selectedIds=actual.selection.selectedIds.filter(id=>d.plan.fantasyCandidates.some(c=>c.id===id&&c.anchorRefs.some(ref=>refs.has(ref))));
    check.errors.push(...validateDraft({draft:group.draft,source,settings:d.settings,selection:{...actual.selection,selectedIds},plan:d.plan,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion}).errors);
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
  for(const prior of d.candidates)if(prior!==candidate&&!prior.resolvedBy&&((prior.status==='needs_dependency_repair'&&prior.requiredPackageIds.every(id=>op.packageIds.includes(id)))||(prior.status==='needs_repair'&&prior.packageIds.every(id=>op.packageIds.includes(id)))))prior.resolvedBy=candidate.id;
  candidate.status='adopted';d.status='drafting';
 }catch(e){candidate.status='needs_repair';candidate.errors=[errorRecord(e,'RESPONDED')];}
}

export function createEngine({directory,modelRunner=runModel,runnerOptions={}}){
 const store=createStore(directory),controllers=new Map();
 async function settle(id,attemptId,result,error){
  return store.update(id,d=>{const op=d.operations.find(o=>o.attemptId===attemptId);if(!op)fail('ATTEMPT','作业不存在');
   if(op.status==='completed')return d;
   const raw=result?.raw??error?.raw??null;op.status=error?.requestOutcome==='UNKNOWN'?'unknown':'completed';op.error=error?errorRecord(error):null;
   const disposition=result?.responseDisposition??error?.responseDisposition;
   op.localSettledAt=new Date().toISOString();op.receipt={requestOutcome:result?.requestOutcome||error?.requestOutcome||'RESPONDED',usage:result?.usage||error?.usage||null,...(['final','incomplete','none'].includes(disposition)?{responseDisposition:disposition}:{})};
   let c;if(result?.output!==undefined||raw){c={id:randomUUID(),attemptId,stage:op.stage,packageIds:op.packageIds,raw,output:result?.output??null,status:'received',receipt:op.receipt,...candidateExecutionFields(op)};d.candidates.push(c);if(op.epoch!==d.epoch)c.status='cancelled_late';else if(c.output===null){c.status='needs_repair';c.errors=[errorRecord(error||{code:'INVALID_JSON',message:'响应不是合法JSON'})];}else adopt(d,c);}
   if(op.epoch!==d.epoch)return d;
   d.status=attentionStatus(d)||(c?c.status==='adopted'?d.status:c.status:error?'failed':d.status);
   return d;
  });
 }
 return {
  async create({id,source,settings,voiceReference=null}){const normalized=normalizeSource(source),effective=normalizeSettings(settings);if(normalized.diagnostics.length)fail('SOURCE_DIAGNOSTICS','源材料有未处理歧义');return store.create(id,{version:VERSION,id,source:normalized,settings:effective,voiceReference,rulesSnapshot:captureRules(),rulesHistory:[],plan:null,choice:defaultChoice(effective.fantasyMode),operations:[],candidates:[],adopted:[],epoch:0,status:'created'});},
  read:id=>store.read(id),
  async execute(id,{stage,packageId,packageIds,attemptId=randomUUID(),issues=[],finishMode='full'}={}){
   if(!['plan','author','finish'].includes(stage))fail('STAGE','未知作业阶段');
   if(!['full','delta'].includes(finishMode))fail('FINISH_MODE','整编模式无效');
   if(!validAttempt(attemptId))fail('INVALID_ATTEMPT','作业编号无效');
   const chosen=stage==='plan'?[]:packageIds||[packageId];let request;
   await store.update(id,d=>{if(d.web?.stopped||d.web?.pauseRequested)throw Object.assign(new Error('任务已停止派发'),{code:'RUN_PAUSED',requestOutcome:'NOT_SENT'});if(d.operations.some(o=>o.attemptId===attemptId))fail('ATTEMPT_EXISTS','已有同编号作业');scopeCheck(d,stage,chosen,{freshAuthor:true});
    const previousPlan=stage==='plan'&&issues.length?d.candidates.findLast(c=>c.stage==='plan'&&c.status==='needs_repair'&&!c.resolvedBy&&c.raw):null;
    const executionBatch=nextExecution(d,stage,chosen);
    const previousDraft=stage==='finish'?(executionBatch?previousBatch(d,executionBatch):previousOf(d,chosen)):previousPlan?{rawText:previousPlan.raw,previousPlan:previousPlan.output}:null;
    request=requestOf(d,stage,chosen,previousDraft,issues,'continuity-v1',finishMode,executionBatch);
    invalidate(d,'running');d.operations.push({attemptId,stage,packageIds:chosen,previousDraft,issues,finishMode:request.finishMode,baseDraftHash:request.baseDraftHash||null,dependencyFormat:'continuity-v1',...(stage!=='plan'&&acceptsContinuity(d)?{acceptedContinuityVersion:ACCEPTED_CONTINUITY_VERSION}:{}),fingerprint:identity(request),epoch:d.epoch,status:'running',createdAt:new Date().toISOString(),...executionFields(executionBatch)});return d;});
   const controller=new AbortController();controllers.set(attemptId,controller);
   try{const result=await modelRunner(request,{directory,attemptId,runId:id,signal:controller.signal,...runnerOptions});return await settle(id,attemptId,result,null);}
   catch(error){await settle(id,attemptId,null,error);throw error;}
   finally{controllers.delete(attemptId);}
  },
  async setChoice(id,choice){return store.update(id,d=>{if(!d.plan)fail('PLAN_REQUIRED','先完成计划');if(hasExecutionDrafts(d))fail('RESET_DRAFTS_REQUIRED','已有执行批次正文，须先明确归档重做');if(choice.mode!==d.settings.fantasyMode)fail('SETTINGS_SELECTION','模式不能被模型或局部选择改写');resolveSelection(d.plan,choice);d.choice=structuredClone(choice);invalidate(d,'planned');return d;});},
  async confirmChoice(id,selectedIds,expectedFingerprint){return store.update(id,d=>{if(!d.plan)fail('PLAN_REQUIRED','先完成计划');if(hasExecutionDrafts(d))fail('RESET_DRAFTS_REQUIRED','已有执行批次正文，须先明确归档重做');d.choice=confirmSelection(d.plan,d.choice,selectedIds,expectedFingerprint);invalidate(d,'planned');return d;});},
  async setFantasyMode(id,mode){return store.update(id,d=>{if(hasExecutionDrafts(d))fail('RESET_DRAFTS_REQUIRED','已有执行批次正文，须先明确归档重做');d.settings=normalizeSettings({...d.settings,fantasyMode:mode});d.choice=defaultChoice(mode);invalidate(d,d.plan?'planned':'created');return d;});},
  async refreshRules(id){return store.update(id,d=>{if(d.operations.some(isUnresolvedOperation))fail('RULES_BUSY','有未结作业时不能刷新规则');if(hasExecutionDrafts(d))fail('RESET_DRAFTS_REQUIRED','已有执行批次正文，须先明确归档重做');const oldHash=digest(d.rulesSnapshot),next=captureRules(),newHash=digest(next);if(d.plan&&(d.rulesSnapshot.outputSchemaVersion!==next.outputSchemaVersion||d.rulesSnapshot.unitPackingPolicy!==next.unitPackingPolicy||d.rulesSnapshot.unitDirectionVersion!==next.unitDirectionVersion||d.rulesSnapshot.seedanceExportVersion!==next.seedanceExportVersion||d.rulesSnapshot.sourceExpressionMethodsVersion!==next.sourceExpressionMethodsVersion||d.rulesSnapshot.authorCallGroupingVersion!==next.authorCallGroupingVersion||d.rulesSnapshot.schemaProjectionVersion!==next.schemaProjectionVersion||d.rulesSnapshot.acceptedContinuityVersion!==next.acceptedContinuityVersion))fail('RULES_PROTOCOL_CHANGE','已有规划不能直接换用不同输出协议；原稿保留，请用新任务测试新版本。');d.rulesSnapshot=next;d.rulesHistory=[...(d.rulesHistory||[]),{at:new Date().toISOString(),oldHash,newHash}];invalidate(d,d.plan?'planned':'created');return d;});},
  async cancel(id,{reason='cancel'}={}){const d=await store.update(id,d=>{d.epoch++;d.status='cancelled';for(const op of d.operations.filter(o=>o.status==='running')){op.cancelRequestedAt=new Date().toISOString();op.cancelReason=reason;}return d;});for(const o of d.operations.filter(o=>o.status==='running'))controllers.get(o.attemptId)?.abort();return d;},
  async recover(id,attemptId){if(!validAttempt(attemptId))fail('INVALID_ATTEMPT','作业编号无效');const before=await store.read(id),prior=before.operations.find(o=>o.attemptId===attemptId);if(!prior)fail('ATTEMPT','作业不存在');if(controllers.has(attemptId))fail('RUN_ACTIVE','本地作业尚未结束');
   if(prior.recovery?.epoch===before.epoch||(prior.status==='completed'&&!hasPendingSavedResponse(before,prior)))return before;
   let result,error;
   try{result=await readCompletedAttempt({directory,attemptId});}
   catch(e){if(e.code==='INVALID_JSON')error=e;else if(e.code==='ATTEMPT_UNRESOLVED')return store.update(id,d=>{const op=d.operations.find(o=>o.attemptId===attemptId);if(op.status!=='completed')op.status='unknown';if(op.epoch===d.epoch)d.status=attentionStatus(d)||d.status;return d;});else throw e;}
   return store.update(id,d=>{const op=d.operations.find(o=>o.attemptId===attemptId);if(op.recovery?.epoch===d.epoch)return d;if(d.web?.sourceStale)fail('SOURCE_STALE','源版本已变化');
    if(d.operations.some(o=>o.attemptId!==attemptId&&isUnresolvedOperation(o)&&(op.stage==='plan'||o.stage==='plan'||overlap(op.packageIds,o.packageIds))))fail('RECOVERY_BUSY','同范围仍有其它未结作业，请先核对回执');
    const actual=currentRequest(d,op);if(identity(actual)!==op.fingerprint)fail('STALE_CANDIDATE','保存回包与当前源、规则或依赖不一致');
    const savedFingerprint=result?.requestFingerprint||error?.requestFingerprint;if(savedFingerprint&&savedFingerprint!==op.fingerprint)fail('ATTEMPT_CONFLICT','保存请求与作业指纹不一致');
    const original=d.candidates.findLast(c=>c.attemptId===attemptId),c={id:randomUUID(),attemptId,stage:op.stage,packageIds:op.packageIds,raw:result?.raw??error.raw,output:result?.output??null,status:'received',receipt:{requestOutcome:'RESPONDED',usage:result?.usage||error?.usage||null},recoveredAt:new Date().toISOString(),...(original?{derivedFrom:original.id}:{}),...candidateExecutionFields(op)};
    const responseHashes=[...new Set([...consumedResponseHashes(d,op),savedResponseHash(original),savedResponseHash(c)].filter(Boolean))];
    d.candidates.push(c);op.recovery={at:c.recoveredAt,epoch:d.epoch,candidateId:c.id,previousStatus:op.status,responseHashes};op.status='completed';
    if(c.output===null){c.status='needs_repair';c.errors=[errorRecord(error,'RESPONDED')];}else adopt(d,c,{recovery:true});
    d.status=attentionStatus(d)||(c.status==='adopted'?d.status:c.status);return d;});
  },
  async recheckCandidate(id,candidateId){return store.update(id,d=>{
   const original=d.candidates.find(c=>c.id===candidateId);if(!original)fail('CANDIDATE','候选不存在');if(original.output===null||original.output===undefined)fail('RECHECK_INPUT','候选没有可重校的结构化响应');
   const op=d.operations.find(o=>o.attemptId===original.attemptId);if(!op)fail('ATTEMPT','候选作业不存在');scopeCheck(d,original.stage,original.packageIds);
   const previousStatus=d.status,previousAssembly=d.assembly,derived={id:randomUUID(),attemptId:original.attemptId,stage:original.stage,packageIds:original.packageIds,raw:original.raw,output:structuredClone(original.output),status:'received',receipt:original.receipt,derivedFrom:original.id,...candidateExecutionFields(op)};
   d.candidates.push(derived);invalidate(d,'rechecking');adopt(d,derived,{recovery:op.recovery?.epoch===d.epoch||consumedResponseHashes(d,op).has(savedResponseHash(original))});
   if(derived.equivalentTo){d.status=previousStatus;d.assembly=previousAssembly;}
   else if(['needs_repair','needs_dependency_repair'].includes(derived.status))d.status=derived.status;
   return d;
  });},
  async assemble(id){return store.update(id,d=>{if(!d.plan)fail('PLAN_REQUIRED','先完成计划');if(d.operations.some(isUnresolvedOperation)||d.candidates.some(c=>c.status==='needs_dependency_repair'&&!c.resolvedBy))fail('ASSEMBLY_BUSY','仍有未结作业或需联修的依赖范围');const all=new Set(d.plan.workPackages.map(w=>w.id)),covered=new Set(d.adopted.filter(a=>a.stage==='finish').flatMap(a=>a.packageIds));if([...all].some(id=>!covered.has(id)))fail('FINISH_REQUIRED','全部工作包完成整编后才能汇总');for(const a of d.adopted){const operations=adoptionOperations(d,a);try{if(!operations.length||operations.some(op=>identity(currentRequest(d,op))!==op.fingerprint))fail('STALE_ADOPTION','已采用稿依赖的材料或选择已变更');}catch(e){if(e.code==='STALE_ADOPTION')throw e;fail('STALE_ADOPTION','已采用稿依赖的材料或选择已变更');}}const rank=new Map(d.source.sourceRows.map((r,i)=>[r.id,i]));const units=d.adopted.flatMap(a=>a.draft.units).sort((a,b)=>Math.min(...a.shots.flatMap(s=>s.sourceRefs.map(r=>rank.get(r)??Infinity)))-Math.min(...b.shots.flatMap(s=>s.sourceRefs.map(r=>rank.get(r)??Infinity))));const draft={schemaVersion:VERSION,units,fantasyRealization:d.adopted.flatMap(a=>a.draft.fantasyRealization)};const check=validateDraft({draft,source:d.source,settings:d.settings,selection:resolveSelection(d.plan,d.choice),plan:d.plan,unitDirectionVersion:d.rulesSnapshot.unitDirectionVersion});d.assembly={draft,validation:check,text:renderDraft({draft,source:d.source,settings:d.settings,seedanceExportVersion:d.rulesSnapshot.seedanceExportVersion})};d.status=check.errors.length?'needs_repair':'text_ready_for_review';return d;});}
 };
}
