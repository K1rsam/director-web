import type { PrismaClient, Prisma } from '@prisma/client';
import {isDeepStrictEqual} from 'node:util';
import {CONTRACT_VERSION} from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import type { SourceAssistRequest } from './source-preparation';
import type { SourceBoundaryPlan } from './source-parser';
import { readSourcePreparation } from './source-preparation';
import { readFidelityReceipt } from './fidelity-store';
import { isFidelitySourceBranchIssue, prepareFidelityReading, type FidelityDecision } from './fidelity-import';
import { refreshFidelitySource } from './fidelity-refresh';
import {parseEpisodeNumber, type ImportedScript} from './import-script';
import {projectPinnedFidelitySource} from './fidelity-source-projection';
import {prepareEpisodeReception} from './standard-script-reception';
import { planP1ReviewBatches, validateP1ReviewPlan, projectP1ReviewRequest, p1RepairSections, p1StructureIssues, type P1ReviewState, type P1ReviewRequest } from './fidelity-p1-review';
import { coalesceFidelityDecisions } from './fidelity-decision-ranges';
import { routeFidelityQuestions } from './fidelity-question-routing';
import {reconcileP1OwnershipDecisions} from './fidelity-p1-ownership';
import {reconcileP1BatchContinuityDecisions} from './fidelity-p1-batch-continuity';
export type FidelityBackendPending={kind:'BACKEND_STRUCTURE_PENDING';codes:string[];reason:'DIRECT_STRUCTURE_PENDING'|'BOUNDED_REPAIR_EXHAUSTED'|'REPAIR_NOT_DISPATCHED'};
export async function prepareFidelitySourceAssisted(projectId:string,db:PrismaClient,options:{checkAfterCommit?:(tx:Prisma.TransactionClient)=>Promise<void>;checkCurrent:(tx:Prisma.TransactionClient)=>Promise<void>;assist:(request:SourceAssistRequest,validate:(value:unknown)=>SourceBoundaryPlan)=>Promise<{plan:SourceBoundaryPlan;runId:string}>}){
 const current=await readFidelityReceipt(projectId,db), input=await readSourcePreparation(projectId,db);
 if(!current?.sourceSnapshot)throw new Error('缺少保真来源。');
 const result=current.receipt.result;
 const storedReview=(current.receipt as typeof current.receipt & {p1Review?:P1ReviewState}).p1Review;
 const review=storedReview?routeFidelityQuestions(storedReview,result):undefined;
 const currentIssues=[...result.validation.issues,...p1StructureIssues(review??{status:'PENDING'})];
 const currentTechnicalIssues=currentIssues.filter(i=>!isFidelitySourceBranchIssue(i));
 const done=()=>({sourceInputVersion:input.sourceInputVersion,assisted:false,episodeCount:input.project.episodes.length,unresolved:currentIssues.map(i=>i.code),backendPending:currentTechnicalIssues.length?{kind:'BACKEND_STRUCTURE_PENDING',codes:currentTechnicalIssues.map(i=>i.code),reason:current.receipt.mode==='direct'?'DIRECT_STRUCTURE_PENDING':review?.repairAttempts?'BOUNDED_REPAIR_EXHAUSTED':'REPAIR_NOT_DISPATCHED'} as FidelityBackendPending:undefined});
 // Direct external imports never repeat a paid full review; legacy imports retain their old path.
 if(current.receipt.mode==='direct')return done();
 if(review?.status==='COMPLETE'&&!currentTechnicalIssues.length)return done();
 if(review){
  const original=JSON.parse(current.sourceSnapshot.content) as ImportedScript;
  if(review.reviewedSourceVersion&&review.reviewedSourceVersion!==current.receipt.readingHash)throw new Error('P1检查记录属于旧来源，未复用。');
  const untouched=review.status==='PENDING'&&!review.method&&!review.completedRanges?.length&&!review.runIds?.length&&!review.pendingDecisions?.length&&!review.repairAttempts&&!review.unresolved?.length&&!review.aliases?.length&&!review.candidateWarnings?.length&&!review.ownershipCorrections?.length&&!review.batchContinuityCorrections?.length&&!review.batchContinuityDiagnostics?.length;
  if(untouched&&result.contractVersion===CONTRACT_VERSION&&!current.receipt.decisions.length&&!await db.pipelineRun.count({where:{projectId,stageCode:'F1'}})){
   const pinned=projectPinnedFidelitySource(original,current.receipt);
   if(input.sourceImportId!==current.sourceSnapshot.id||current.receipt.sourceImportId&&current.receipt.sourceImportId!==current.sourceSnapshot.id||input.sourceText!==pinned.sourceText||!isDeepStrictEqual(pinned.readingView,current.receipt.reader))throw new Error('来源与读取证明不一致，未执行程序直通。');
   const ordered=(episodes:Array<{number:number;title:string|null;content:string}>)=>episodes.map(({number,title,content})=>({number,title,content})).sort((a,b)=>a.number-b.number);
   if(!isDeepStrictEqual(ordered(input.project.episodes),ordered(pinned.episodes)))throw new Error('当前正文已变化，未以旧来源执行程序直通。');
   const checked=prepareFidelityReading(pinned,current.receipt.mode,current.receipt.decisions,current.receipt.originalHash,result.plan,current.receipt.sourceBranchDecisions??[]);
   if(!isDeepStrictEqual(checked.receipt.result,result)||!isDeepStrictEqual(checked.imported.sourceStructure,pinned.sourceStructure)||!isDeepStrictEqual(checked.imported.episodes,pinned.episodes))throw new Error('来源结构校验不一致，未执行程序直通。');
   const episodeHeads=new Set(result.segments.filter(s=>s.reason==='explicit_episode_heading').map(s=>s.episodeId));
   const sceneHeads=new Set(result.segments.filter(s=>s.reason==='explicit_scene_heading'||s.reason==='inline_scene_body').filter(s=>{
    const numeric=/^(?:#{1,6}\s*)?(?:场\s*)?(\d+)\s*[-－.．]\s*\d+/u.exec(s.text.trim());
    return !numeric||Number(numeric[1])===parseEpisodeNumber(s.sourceNumber??'');
   }).map(s=>s.sceneId));
   const explicit=result.segments.every(s=>!s.text.trim()||s.kind==='context'&&['explicit_context_heading','context_section'].includes(s.reason)
    ||s.kind==='format'&&(['explicit_episode_heading'].includes(s.reason)&&episodeHeads.has(s.episodeId)||['explicit_scene_heading','continued_scene_metadata'].includes(s.reason)&&episodeHeads.has(s.episodeId)&&sceneHeads.has(s.sceneId))
    ||s.kind==='body'&&s.productionEligible&&!!s.episodeId&&!!s.sceneId&&episodeHeads.has(s.episodeId)&&sceneHeads.has(s.sceneId));
   const ready=!currentIssues.length&&!input.readIssues.length&&!pinned.sourceStructure.issues.length&&!pinned.sourceStructure.sections.some(s=>s.kind==='UNRESOLVED')
    &&!(pinned.readingView.kind==='DOCX'&&pinned.readingView.warnings.length)&&pinned.episodes.length>0&&explicit&&pinned.episodes.every(episode=>prepareEpisodeReception(episode,null).scriptReception.ready);
   if(ready){
    await db.$transaction(async tx=>{
     await options.checkCurrent(tx);
     const latest=await readFidelityReceipt(projectId,tx);
     if(latest?.snapshot.id!==current.snapshot.id||latest.snapshot.content!==current.snapshot.content||latest.sourceSnapshot?.id!==current.sourceSnapshot!.id||(await readSourcePreparation(projectId,tx)).sourceInputVersion!==input.sourceInputVersion||await tx.pipelineRun.count({where:{projectId,stageCode:'F1'}}))throw new Error('来源或P1检查已变化，未保存过期程序检查。');
     const state:P1ReviewState={...review,status:'COMPLETE',method:'PROGRAM',reviewedSourceVersion:current.receipt.readingHash};
     await tx.sceneSnapshot.create({data:{projectId,sceneKey:'FIDELITY_IMPORT',title:'P1 程序结构检查（无模型调用）',content:JSON.stringify({...current.receipt,p1Review:state}),metadata:JSON.stringify({schema:'FIDELITY_RECEIPT_V1',sourceVersion:current.receipt.readingHash,method:'PROGRAM',checkVersion:'P1_PROGRAM_STRUCTURE_V1'})}});
    });
    if(options.checkAfterCommit)await options.checkAfterCommit(db);
    return done();
   }
  }
  const batches=planP1ReviewBatches(original.sourceText);
  if(review.status==='COMPLETE'&&!review.completedRanges?.length)return done();
  let state:P1ReviewState={...review,reviewedSourceVersion:current.receipt.readingHash};
  let checkpoint=current;
  const reconcilePending=(extra:FidelityDecision[]=[],currentBatch?:{start:number;end:number})=>reconcileP1BatchContinuityDecisions(original.sourceText,{manualDecisions:current.receipt.decisions,pendingDecisions:[...(state.pendingDecisions??[]),...extra],completedRanges:state.completedRanges??[],...(currentBatch?{currentBatch}:{})});
  const rememberContinuity=(resolved:ReturnType<typeof reconcilePending>)=>{
   state={...state,pendingDecisions:resolved.decisions,
    batchContinuityCorrections:[...new Map([...(state.batchContinuityCorrections??[]),...resolved.corrections].map(c=>[JSON.stringify(c),c])).values()],
    batchContinuityDiagnostics:resolved.diagnostics.filter(d=>d.status==='UNRESOLVED')};
  };
  for(const [index,blocks] of batches.entries()){
   const bounds={start:blocks[0].start,end:blocks.at(-1)!.end};
   if(state.completedRanges?.some(r=>r.start===bounds.start&&r.end===bounds.end))continue;
   const request:P1ReviewRequest={reviewMode:'FULL_STRUCTURE_V1',sourceVersion:input.sourceInputVersion,sourceLength:original.sourceText.length,
    batch:{firstBlock:blocks[0].id,lastBlock:blocks.at(-1)!.id,index:index+1,total:batches.length},
    sections:blocks.map((b,i)=>({key:b.id,start:b.start,end:b.end,text:b.text,...(i===0?{before:original.sourceText.slice(Math.max(0,b.start-600),b.start)}:{})})),
    issues:result.validation.issues.filter(i=>i.start<bounds.end&&i.end>bounds.start).map(i=>({code:i.code,message:i.message,sectionKeys:blocks.filter(b=>b.start<i.end&&b.end>i.start).map(b=>b.id)})),baseline:result.episodes.filter(e=>e.start<bounds.end&&e.end>bounds.start).map(e=>({episodeNumber:e.sourceNumber,start:e.start,end:e.end}))};
   const validate=(value:unknown):SourceBoundaryPlan=>{
    const proposal=validateP1ReviewPlan(value,request);
    prepareFidelityReading(original,current.receipt.mode,reconcileP1OwnershipDecisions(original.sourceText,coalesceFidelityDecisions(original.sourceText,[...current.receipt.decisions,...reconcilePending(proposal.decisions,bounds).decisions])).decisions,current.receipt.originalHash,undefined,current.receipt.sourceBranchDecisions??[]);
    return value as SourceBoundaryPlan;
   };
   const response=await options.assist(request,validate);
   const proposal=validateP1ReviewPlan(response.plan,request);
   rememberContinuity(reconcilePending(proposal.decisions,bounds));
   state={...state,completedRanges:[...(state.completedRanges??[]),bounds],runIds:[...(state.runIds??[]),response.runId],unresolved:[...(state.unresolved??[]),...proposal.unresolved],aliases:[...(state.aliases??[]),...proposal.aliases],...(proposal.candidateWarnings?.length?{candidateWarnings:[...(state.candidateWarnings??[]),...proposal.candidateWarnings.map(warning=>({...warning,runId:response.runId}))]}:{})};
   const previous=checkpoint;
   await db.$transaction(async tx=>{
    await options.checkCurrent(tx);
    const latest=await readFidelityReceipt(projectId,tx);
    if(latest?.snapshot.id!==previous.snapshot.id||latest.sourceSnapshot?.id!==current.sourceSnapshot!.id)throw new Error('来源或P1检查已更新，未保存过期检查。');
    await tx.sceneSnapshot.create({data:{projectId,sceneKey:'FIDELITY_IMPORT',title:'P1原稿结构检查进度',content:JSON.stringify({...previous.receipt,p1Review:state}),metadata:JSON.stringify({schema:'FIDELITY_RECEIPT_V1',sourceVersion:current.receipt.readingHash})}});
   });
   checkpoint=(await readFidelityReceipt(projectId,db))!;
  }
  const reconciledDecisions=()=>reconcileP1OwnershipDecisions(original.sourceText,coalesceFidelityDecisions(original.sourceText,[...current.receipt.decisions,...(state.pendingDecisions??[])]));
  const materialize=()=>{
   rememberContinuity(reconcilePending());
   const reconciled=reconciledDecisions();
   state={...state,ownershipCorrections:[...new Map([...(state.ownershipCorrections??[]),...reconciled.corrections].map(correction=>[JSON.stringify(correction),correction])).values()]};
   return prepareFidelityReading(original,current.receipt.mode,reconciled.decisions,current.receipt.originalHash,undefined,current.receipt.sourceBranchDecisions??[]);
  };
  let checked=materialize();
  state=routeFidelityQuestions(state,checked.receipt.result);
  const pauseContinuity=async()=>{
   const continuityPending=p1StructureIssues(state).filter(i=>i.code==='P1_BATCH_CONTINUITY_UNRESOLVED');
   if(!continuityPending.length)return null;
   // Keep unresolved transport proposals as pending evidence. Promoting them
   // then clearing pendingDecisions would erase the next retry's proof and
   // silently turn a technical pause into a completed structure.
   state={...state,status:'PENDING'};
   await db.$transaction(async tx=>{
    await options.checkCurrent(tx);const latest=await readFidelityReceipt(projectId,tx);
    if(latest?.snapshot.id!==checkpoint.snapshot.id||latest.sourceSnapshot?.id!==current.sourceSnapshot!.id)throw new Error('来源或P1检查已变化，未保存过期跨批检查。');
    if(!isDeepStrictEqual(latest.receipt.p1Review,state))await tx.sceneSnapshot.create({data:{projectId,sceneKey:'FIDELITY_IMPORT',title:'P1跨批技术检查待处理',content:JSON.stringify({...latest.receipt,p1Review:state}),metadata:JSON.stringify({schema:'FIDELITY_RECEIPT_V1',sourceVersion:current.receipt.readingHash})}});
   });
   if(options.checkAfterCommit)await options.checkAfterCommit(db);
   return {sourceInputVersion:input.sourceInputVersion,assisted:true,episodeCount:input.project.episodes.length,unresolved:continuityPending.map(i=>i.code),backendPending:{kind:'BACKEND_STRUCTURE_PENDING',codes:continuityPending.map(i=>i.code),reason:'REPAIR_NOT_DISPATCHED'} as FidelityBackendPending};
  };
  const initialContinuityPause=await pauseContinuity();if(initialContinuityPause)return initialContinuityPause;
  // One bounded local pass follows full reading. Its paid result has its own fingerprint
  // and durable checkpoint; retry never repurchases the completed full batches.
  const repairableIssues=[...checked.receipt.result.validation.issues,...p1StructureIssues(state)].filter(i=>!isFidelitySourceBranchIssue(i));
  if(repairableIssues.length&&!repairableIssues.some(i=>i.code==='P1_BATCH_CONTINUITY_UNRESOLVED')&&!(state.repairAttempts??0)){
   const issues=repairableIssues;
   const blocks=batches.flat().filter(b=>issues.some(i=>b.start<i.end&&b.end>i.start));
   if(blocks.length&&blocks.reduce((n,b)=>n+b.text.length,0)<=12000){
    const request:P1ReviewRequest={reviewMode:'FULL_STRUCTURE_V1',repairAttempt:1,sourceVersion:input.sourceInputVersion,sourceLength:original.sourceText.length,
     batch:{firstBlock:blocks[0].id,lastBlock:blocks.at(-1)!.id,index:1,total:1},
     sections:p1RepairSections(original.sourceText,blocks),
     issues:issues.map(i=>({code:i.code,message:i.message,sectionKeys:blocks.filter(b=>b.start<i.end&&b.end>i.start).map(b=>b.id)})),
     baseline:checked.receipt.result.episodes.map(e=>({episodeNumber:e.sourceNumber,start:e.start,end:e.end}))};
    if(JSON.stringify(projectP1ReviewRequest(request)).length<=24000){
    const validate=(value:unknown):SourceBoundaryPlan=>{
     const proposal=validateP1ReviewPlan(value,request);
     prepareFidelityReading(original,current.receipt.mode,reconcileP1OwnershipDecisions(original.sourceText,coalesceFidelityDecisions(original.sourceText,[...current.receipt.decisions,...(state.pendingDecisions??[]),...proposal.decisions])).decisions,current.receipt.originalHash,undefined,current.receipt.sourceBranchDecisions??[]);
     return value as SourceBoundaryPlan;
    };
    const response=await options.assist(request,validate),proposal=validateP1ReviewPlan(response.plan,request);
    state={...state,unresolved:(state.unresolved??[]).filter(i=>i.kind==='semantic'||blocks.filter(b=>b.start<i.end&&b.end>i.start).reduce((n,b)=>n+Math.min(i.end,b.end)-Math.max(i.start,b.start),0)!==i.end-i.start)};
    state={...state,repairAttempts:1,runIds:[...(state.runIds??[]),response.runId],pendingDecisions:[...(state.pendingDecisions??[]),...proposal.decisions],unresolved:[...(state.unresolved??[]),...proposal.unresolved],aliases:[...(state.aliases??[]),...proposal.aliases],...(proposal.candidateWarnings?.length?{candidateWarnings:[...(state.candidateWarnings??[]),...proposal.candidateWarnings.map(warning=>({...warning,runId:response.runId}))]}:{})};
    const previous=checkpoint;
    await db.$transaction(async tx=>{
     await options.checkCurrent(tx);const latest=await readFidelityReceipt(projectId,tx);
     if(latest?.snapshot.id!==previous.snapshot.id||latest.sourceSnapshot?.id!==current.sourceSnapshot!.id)throw new Error('来源或P1检查已更新，未保存过期检查。');
     await tx.sceneSnapshot.create({data:{projectId,sceneKey:'FIDELITY_IMPORT',title:'P1局部结构补漏进度',content:JSON.stringify({...previous.receipt,p1Review:state}),metadata:JSON.stringify({schema:'FIDELITY_RECEIPT_V1',sourceVersion:current.receipt.readingHash})}});
    });
    checkpoint=(await readFidelityReceipt(projectId,db))!;checked=materialize();state=routeFidelityQuestions(state,checked.receipt.result);
    }
   }
  }
  const repairContinuityPause=await pauseContinuity();if(repairContinuityPause)return repairContinuityPause;
  const remaining=[...checked.receipt.result.validation.issues,...p1StructureIssues(state)];
  const remainingTechnical=remaining.filter(i=>!isFidelitySourceBranchIssue(i));
  await refreshFidelitySource(projectId,db,{expectedReceiptId:checkpoint.snapshot.id,expectedSourceId:current.sourceSnapshot.id,checkCurrent:options.checkCurrent,checkAfterCommit:options.checkAfterCommit,decisions:reconciledDecisions().decisions,p1Review:{...state,status:remainingTechnical.length?'PENDING':'COMPLETE',pendingDecisions:[]}});
  const refreshed=await readSourcePreparation(projectId,db),receipt=await readFidelityReceipt(projectId,db);
  return {sourceInputVersion:refreshed.sourceInputVersion,assisted:true,episodeCount:refreshed.project.episodes.length,unresolved:remaining.map(i=>i.code),backendPending:remainingTechnical.length?{kind:'BACKEND_STRUCTURE_PENDING',codes:remainingTechnical.map(i=>i.code),reason:state.repairAttempts?'BOUNDED_REPAIR_EXHAUSTED':'REPAIR_NOT_DISPATCHED'} as FidelityBackendPending:undefined};
 }
 if(!currentTechnicalIssues.length)return done();
 const ranges:Array<{start:number;end:number}>=[];
 for(const issue of [...result.validation.issues].sort((a,b)=>a.start-b.start)){
  const last=ranges.at(-1);
  if(last&&issue.start<=last.end || last&&!result.source.text.slice(last.end,issue.start).trim())last.end=Math.max(last.end,issue.end);
  else ranges.push({start:issue.start,end:issue.end});
 }
 if(ranges.length>24||ranges.reduce((n,r)=>n+r.end-r.start,0)>12000)return done();
 const original=JSON.parse(current.sourceSnapshot.content) as ImportedScript;
 const sections=ranges.map((r,i)=>({key:`FIDELITY-${i+1}`,start:r.start,end:r.end,text:original.sourceText.slice(r.start,r.end),before:original.sourceText.slice(Math.max(0,r.start-400),r.start),after:original.sourceText.slice(r.end,r.end+400)}));
 const boundaries=new Set([0,original.sourceText.length,...[...original.sourceText.matchAll(/\r\n|\r|\n/g)].map(m=>m.index+m[0].length)]);
 const validate=(value:unknown):SourceBoundaryPlan=>{
  const raw=value as {sourceVersion?:string;decisions?:FidelityDecision[];unresolved?:unknown[]};
  if(!raw||raw.sourceVersion!==input.sourceInputVersion||!Array.isArray(raw.decisions)||raw.decisions.length>24||!Array.isArray(raw.unresolved)||Object.keys(raw).some(k=>!['sourceVersion','decisions','unresolved'].includes(k)))throw new Error('来源判断须返回本次sourceVersion、decisions和unresolved。');
  for(const d of raw.decisions){
   if(Object.keys(d).some(k=>!['start','end','kind','note','episodeNumber','sceneNumber'].includes(k))||!boundaries.has(d.start)||!boundaries.has(d.end)||d.end<=d.start||!ranges.some(r=>d.start>=r.start&&d.end<=r.end)||!['body','context'].includes(d.kind)||typeof d.note!=='string')throw new Error('判断只能采用给定疑点内完整行的声明式范围；禁止改写正文。');
  }
  prepareFidelityReading(original,current.receipt.mode,[...current.receipt.decisions,...raw.decisions],current.receipt.originalHash,undefined,current.receipt.sourceBranchDecisions??[]);
  return value as SourceBoundaryPlan;
 };
 const response=await options.assist({sourceVersion:input.sourceInputVersion,issues:result.validation.issues.map(i=>({code:i.code,message:i.message,sectionKeys:[]})),sections,sourceLength:original.sourceText.length},validate);
 const plan=validate(response.plan) as unknown as {decisions:FidelityDecision[]};
 if(plan.decisions.length)await refreshFidelitySource(projectId,db,{expectedReceiptId:current.snapshot.id,expectedSourceId:current.sourceSnapshot.id,checkCurrent:options.checkCurrent,checkAfterCommit:options.checkAfterCommit,decisions:[...current.receipt.decisions,...plan.decisions]});
 const refreshed=await readSourcePreparation(projectId,db),receipt=await readFidelityReceipt(projectId,db);
 return {sourceInputVersion:refreshed.sourceInputVersion,assisted:true,episodeCount:refreshed.project.episodes.length,unresolved:receipt!.receipt.result.validation.issues.map(i=>i.code),backendPending:receipt!.receipt.result.validation.issues.length?{kind:'BACKEND_STRUCTURE_PENDING',codes:receipt!.receipt.result.validation.issues.map(i=>i.code),reason:'BOUNDED_REPAIR_EXHAUSTED'} as FidelityBackendPending:undefined};
}
