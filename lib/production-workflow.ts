import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readdir,readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {withProductionBudgetContext,productionBudgetRoot,type ProductionBudgetContext} from './production-budget';
import {prepareEpisodeReception} from './standard-script-reception';
import {isProductionEpisodeNumber} from './production-episodes';
import {promptNeedsReview} from './asset-prompt-contract';
import {retryDatabaseRead,createInflightRead} from './production-read-guard';
import type {PromptWorkspace} from './asset-prompt-contract';
import type {PrismaClient} from '@prisma/client';
import type {ProductionModelSelection} from '../runtime/production-policy.mjs';
import {productionProgress} from './production-progress';

type Row=Record<string,any>;
export type ProductionChain={id:string;mode:'CHAIN'|'SINGLE';selectionRevision:number;selectedRuns:Record<string,string>;episodeNumbers:number[];selectionProtocol?:'per-episode-selection-v1';selectedRunRevisions?:Record<string,number>};
export type ProductionWorkflow=ProductionChain&{schema:'PRODUCTION_WORKFLOW_V1';projectId:string;actorId:string;budgetId:string;budgetPolicy?:{version:string;episode:{maxCalls:number;maxTokens:number};warningTokens:number};sourceVersion:string;revision:number;criticalAssetKeys:string[];requestedAssetKeys:string[];paused:boolean;costAcknowledged:boolean;status:'READY'|'RUNNING'|'INTERRUPTED';activeAction:Row|null;receipts:Row[];qualityReviews:Row[];materialRequests:Row[];createdAt:string;updatedAt:string;delivery?:{version:'production-delivery-v1';enabled:boolean;result?:{identity:string;directory:string;reused:boolean;at:string}};parallel?:{version:'production-parallel-v1';waitPolicy?:'evidence-watch-v1';reconnectPolicy?:'wake-reconnect-v1';modelSelection?:ProductionModelSelection;enabled:boolean;executionTier:'standard'|'fast';runBudget?:{maxCalls:number;maxTokens:number};lanes:number[][];authorizedBy?:string;authorizedAt?:string;participatingRuns?:string[];worker?:Row;lastStop?:string|null}};
export type ProductionWorkflowCommand=Row&{action:'create'|'advance'|'pause'|'resume'|'recover'|'select-run'|'quality-review'|'request-materials'|'configure-parallel'|'start-parallel'|'reconnect-parallel'|'boundary-evidence'|'boundary-review'|'configure-delivery'|'export-delivery';workflowId?:string;expectedRevision?:number};
export const productionWorkflowRoot=path.resolve(/*turbopackIgnore: true*/ process.env.DIRECTOR_PRODUCTION_WORKFLOW_DIR||path.join(process.cwd(),'.production-workflows'));
const nativeRequire=createRequire(path.join(process.cwd(),'package.json'));
const workflowRuntime=nativeRequire(path.join(process.cwd(),'runtime/production-workflow.mjs'));
const {createStore}=nativeRequire(path.join(process.cwd(),'runtime/storyboard-v4/core/store.mjs'));
const {productionBlock,freePreparationRecoveryCause}=nativeRequire(path.join(process.cwd(),'runtime/storyboard-v4/coordinator.mjs'));
const {hasPendingSavedResponse}=nativeRequire(path.join(process.cwd(),'runtime/storyboard-v4/core/pipeline.mjs'));
const maintenanceRuntime=nativeRequire(path.join(process.cwd(),'runtime/production-maintenance-state.mjs'));
const maintenanceDataRoot=path.resolve(process.env.DIRECTOR_STORYBOARD_DATA_DIR||path.join(process.cwd(),'.storyboard-stage3-v2'));
const runtimeMaintenance=async()=>(await maintenanceRuntime.loadRuntimeMaintenanceHost()).createRuntimeMaintenance({workflowDirectory:productionWorkflowRoot,dataRoot:maintenanceDataRoot,budgetDirectory:productionBudgetRoot});
const fail=(code:string,message:string,status=409):never=>{throw Object.assign(new Error(message),{code,status,requestOutcome:'NOT_SENT'});};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Bind real source/interpretation content, never a snapshot ID, timestamp or metadata revision. */
export function productionWorkflowSourceVersion(input:Row):string{
 return digest({episodes:input.sourceVersion,background:(input.sourceContext?.background??[]).map((s:Row)=>s.text),unresolved:(input.sourceContext?.unresolved??[]).map((s:Row)=>s.text),interpretations:input.scriptInterpretationVersions??{}});
}
/** Zero materialized episodes is an honest P1 input state, not an invented empty SourceIndex. */
export async function readProductionWorkflowInputs(projectId:string,options:{db?:PrismaClient}={}):Promise<Row>{
 const [source,foundation,context,database]=await Promise.all([import('./source-preparation'),import('./foundation-state'),import('./foundation-source'),import('./prisma')]);
 const db=options.db??database.prisma,raw=await source.readSourcePreparation(projectId,db);
 if(raw.project.episodes.length)return foundation.loadFoundationInputs(projectId,db);
 return {project:raw.project,sourceVersion:digest({unmaterializedOriginal:raw.sourceText}),sourceIndex:{episodes:[]},sourceContext:await context.loadFoundationSourceContext(projectId,db),
  sourceUnmaterialized:true,sourcePreparation:{sourceInputVersion:raw.sourceInputVersion,hasOriginal:Boolean(raw.sourceText)}};
}

/** Service boundaries stay injectable so tests exercise real orchestration without a provider or production DB. */
export type ProductionWorkflowServices={
 readInputs:(projectId:string)=>Promise<Row>;readStage1:(projectId:string)=>Promise<Row>;readDirection:(projectId:string,actorId:string)=>Promise<Row>;
 readScope:(projectId:string)=>Promise<{sourceKnown:boolean;episodeNumbers:number[]}>;readAssets:(projectId:string)=>Promise<PromptWorkspace>;
 planAssets:(projectId:string,episodeNumbers:number[],assetKeys:string[],prepared?:{workspace:PromptWorkspace;input:Row;production:Row})=>Promise<Row>;readAdoptions:(projectId:string,actorId:string,workspace:PromptWorkspace)=>Promise<Row>;
 queueStage1:(projectId:string,options:Row)=>Promise<Row>;executeStage1:(projectId:string,taskId:string,options:Row)=>Promise<Row|null>;
 generateDirection:(projectId:string,actorId:string,command:Row,options:Row)=>Promise<unknown>;
 generateAssets:(projectId:string,episodeNumbers:number[],options:Row)=>Promise<Row>;
 episode:(projectId:string,episodeNumber:number)=>Promise<Row|null>;createStoryboard:(episode:Row,command:Row)=>Promise<Row>;
 readStoryboard:(id:string)=>Promise<Row>;storyboardView:(run:Row,episode:Row)=>Promise<Row>;storyboardSavedView?:(run:Row,episode:Row)=>Promise<Row>;startStoryboard:(id:string)=>Promise<Row>;
 recoverSavedStoryboard?:(id:string)=>Promise<Row>;
 reviewStoryboardBoundary?:(id:string,review:Row)=>Promise<Row>;resolveStoryboardSource?:(id:string,value:Row,approval:Row)=>Promise<Row>;
 readStoryboardAttempt?:(id:string)=>Promise<Row>;
 pauseStoryboard:(id:string)=>Promise<unknown>;refreshChain:(projectId:string,changedRunId?:string)=>Promise<unknown>;runRole?:(request:any)=>Promise<any>;
 readMaterialReceipts?:(projectId:string,workflowId:string,requestIds:string[])=>Promise<Row[]>;
};

async function productionServices():Promise<ProductionWorkflowServices>{
 const [foundation,direction,assets,adoptions,episodes,storyboard,db,role,materials]=await Promise.all([
  import('./foundation-delivery'),import('./series-direction-service'),import('./asset-prompt-service'),
  import('./asset-design-adoption'),import('./production-episodes'),import('./storyboard-service'),import('./prisma'),import('./role-runner'),import('./asset-material-candidates')]);
 // The singleton's existing startup reconciliation is initialized outside any
 // retryable read callback. Inspect retries only a fresh projection, not startup,
 // reconciliation, model dispatch or a partially completed workflow action.
 const localStoryboard=storyboard.storyboardService();
 return {
  readInputs:readProductionWorkflowInputs,readStage1:foundation.getFoundationDeliveryState,readDirection:direction.getSeriesDirectionWorkspace,
  readScope:episodes.readProductionScope,readAssets:assets.loadAssetPromptWorkspace,planAssets:(p,n,k,prepared)=>assets.planEpisodeAssetProduction(p,n,k,prepared as Parameters<typeof assets.planEpisodeAssetProduction>[3]),readAdoptions:adoptions.readAssetDesignAdoptions,
  queueStage1:foundation.queueFoundationDelivery,executeStage1:foundation.executeFoundationDelivery,
  generateDirection:(p,a,c,o)=>direction.generateSeriesDirectionCandidate(p,a,c as any,o),generateAssets:assets.generateAssetPromptsForEpisodes,
  episode:(projectId,number)=>db.prisma.episode.findFirst({where:{projectId,number},include:{project:true}}),
  createStoryboard:storyboard.createStoryboardRun,readStoryboard:id=>localStoryboard.read(id),
  storyboardView:(run,episode)=>storyboard.storyboardRunView(run,episode,undefined,false),
  storyboardSavedView:async(run,episode)=>{const view=await storyboard.storyboardSavedRunView(run,episode);return {...view,sourceCheckPending:!view.legacyReadOnly};},startStoryboard:id=>localStoryboard.start(id,{mode:'all'}),
  pauseStoryboard:id=>localStoryboard.pause(id),refreshChain:async(projectId,changedRunId)=>(await import('./storyboard-service')).refreshProductionChain(projectId,changedRunId),runRole:role.runRoleByProvider,
  recoverSavedStoryboard:id=>localStoryboard.recoverSaved(id),
  reviewStoryboardBoundary:(id,review)=>localStoryboard.reviewBoundary(id,review),resolveStoryboardSource:(id,value,approval)=>localStoryboard.resolveSource(id,value,approval),
  readStoryboardAttempt:async id=>{
   if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id))fail('WORKFLOW_DELIVERY_RECEIPT','请求编号无效。');
   const result:Row={hashes:{}};
   for(const [key,name] of [['request','request.json'],['receipt','receipt.json'],['raw','raw.txt'],['eventFinal','event-final.txt']]){
    try{const file=path.join(storyboard.storyboardDataRoot,'attempts',id,name);if(!(await lstat(file)).isFile()||(await lstat(file)).isSymbolicLink())fail('WORKFLOW_DELIVERY_RECEIPT','请求证据不是普通文件。');const bytes=await readFile(file);result.hashes[key]=createHash('sha256').update(bytes).digest('hex');if(key==='request'||key==='receipt')result[key]=JSON.parse(bytes.toString('utf8'));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;result.hashes[key]=null;}
   }return result;
  },
  readMaterialReceipts:materials.readScopedMaterialCandidateReceipt,
 };
}

export function createProductionWorkflowAdapters(actorId:string,services:ProductionWorkflowServices){
 const inspectionReads=createInflightRead<Row>();
 const boundaryPacket=async(workflow:ProductionWorkflow,id:string)=>{
  if(!Object.values(workflow.selectedRuns).includes(id))fail('WORKFLOW_RUN_SCOPE','只复核原队列明确采用的版本。');
  await services.refreshChain(workflow.projectId,id);
  const input=await services.readInputs(workflow.projectId);
  if(productionWorkflowSourceVersion(input)!==workflow.sourceVersion)fail('WORKFLOW_SOURCE_CHANGED','双源已变化，未套用旧裁决。');
  const current=await services.readStoryboard(id),from=current.production?.boundary?.seed?.fromEpisode,previousId=workflow.selectedRuns[from];
  if(!previousId)fail('WORKFLOW_BOUNDARY_EVIDENCE','所选前集实际尾稿尚未齐备。');
  const previous=await services.readStoryboard(previousId);
  for(const run of [previous,current]){
   const episode=await services.episode(workflow.projectId,run.web.binding.episodeNumber);
   if(!episode||episode.id!==run.web.binding.episodeId)fail('WORKFLOW_RUN_SCOPE','双源分集绑定已变化。');
   const view=await services.storyboardView(run,episode!);
   if(view.sourceStale||view.active||view.legacyReadOnly||view.preparation?.ready!==true)fail('WORKFLOW_BOUNDARY_EVIDENCE','先核对当前双源及已结回执。');
  }
  const sources={previous:input.sourceIndex.episodes.find((e:Row)=>e.number===from)?.content,current:input.sourceIndex.episodes.find((e:Row)=>e.number===current.web.binding.episodeNumber)?.content};
  const nativeEvidence:Row={};
  if(services.readStoryboardAttempt)for(const run of [previous,current])for(const op of run.operations??[]){
   const saved=await services.readStoryboardAttempt(op.attemptId),fingerprint=saved.request?digest([saved.request.promptHash,saved.request.instructionHash,saved.request.inputHash]):null;
   if(fingerprint&&fingerprint!==op.fingerprint)fail('WORKFLOW_BOUNDARY_EVIDENCE','保存 request 与当前入口/尾稿作业指纹不符。');
   nativeEvidence[op.attemptId]={fingerprint,hashes:saved.hashes??null,state:saved.receipt?.state??null,requestOutcome:saved.receipt?.requestOutcome??null};
  }
  return nativeRequire(path.join(process.cwd(),'runtime/production-boundary-review.mjs')).buildProductionBoundaryPacket(workflow,current,previous,sources,nativeEvidence);
 };
 const readRun=async(id:string,workflow:ProductionWorkflow,queue?:{input:Row;sourceGatePassed:boolean},document?:Row)=>{
  const run=document??await services.readStoryboard(id),binding=run.web?.binding;
  if(!binding||binding.projectId!==workflow.projectId)fail('WORKFLOW_RUN_SCOPE','分镜版本不属于当前项目。');
  const queueInput=queue?.input,saved=Boolean(queueInput&&services.storyboardSavedView);let sourceGatePassed=saved?queue!.sourceGatePassed:undefined;
  const row=saved?queueInput!.project?.episodes?.find((e:Row)=>e.number===binding.episodeNumber):null;
  const episode=saved?(row?{...row,project:queueInput!.project}:null):await services.episode(workflow.projectId,binding.episodeNumber);
  if(!episode||episode.id!==binding.episodeId)fail('WORKFLOW_RUN_SCOPE','分镜版本的分集绑定已失效。');
  const view=saved?await services.storyboardSavedView!(run,episode):await services.storyboardView(run,episode);
  const terminalProblem=['interrupted','unknown','usage_review','failed','stopped','budget_stop','needs_repair','needs_dependency_repair','waiting_dependencies','awaiting_confirmation','needs_design'].includes(view.status);
  const pending=run.production?.pendingRepair,needs=run.production?.needs??[],boundaryStatus=run.production?.boundaryCheck?.status;
  const hardStop=Boolean(view.blocked||view.legacyReadOnly||run.production?.blocking||view.production?.blocking||boundaryStatus==='CONSTRAINT_CONFLICT'||needs.some((n:Row)=>n.resolved!==true&&n.blocking&&!n.supplyUpdated));
  const unknownOrStopped=['interrupted','unknown','usage_review','failed','stopped','budget_stop','awaiting_confirmation','needs_design'].includes(view.status)
   ||Number(view.usage?.unknownAttempts)>Number(view.usage?.acknowledgedUnknownAttempts??0)||(run.operations??[]).some((op:Row)=>op.status==='running'||op.status==='unknown'&&op.cancelAcknowledgement?.acceptUnknownUsage!==true);
  const prior=run.operations?.at(-1),noProgress=prior?.status==='completed'&&prior.issues?.some((issue:Row)=>issue.productionVersion===pending?.versionId);
  const bound=workflow.selectedRuns[binding.episodeNumber]===run.id&&binding.productionChain?.id===workflow.id&&binding.productionChain?.mode===workflow.mode&&binding.productionBudget?.id===workflow.budgetId;
  const assemblyReady=run.status==='text_ready_for_review'&&Boolean(run.assembly?.text)&&run.assembly?.validation?.errors?.length===0;
  const operations:Row[]=run.operations??[],recovery=run.web.localReadRecovery;
  const nativeReceipt=(op:Row)=>run.candidates?.findLast((candidate:Row)=>candidate.attemptId===op.attemptId)?.receipt??op.receipt;
  const newSettledResult=Number.isSafeInteger(recovery?.afterAttemptCount)&&recovery.afterAttemptCount>=0&&operations.slice(recovery.afterAttemptCount).some(op=>{
   const receipt=nativeReceipt(op);return op.status==='completed'&&receipt?.requestOutcome==='RESPONDED'&&Number.isSafeInteger(receipt.usage?.totalTokens)&&receipt.usage.totalTokens>0;
  });
  const recoveryAttempts=newSettledResult?0:Number.isSafeInteger(recovery?.attempts)&&recovery.attempts>=0?recovery.attempts:recovery?2:0;
  const settled=operations.every(op=>op.status==='completed'||op.status==='failed'&&op.error?.requestOutcome==='NOT_SENT'||op.status==='unknown'&&op.cancelAcknowledgement?.acceptUnknownUsage===true&&Boolean(op.localSettledAt));
  const localBudgetStop=Boolean(run.web.budget&&(new Set(operations.map(op=>op.attemptId)).size>=run.web.budget.maxCalls||Number(view.usage?.knownTokens??view.usage?.totalTokens)>=run.web.budget.maxTokens));
  const unresolvedPaid:Row[]=(run.candidates??[]).filter((candidate:Row)=>['needs_repair','needs_dependency_repair','stale'].includes(candidate.status)&&!candidate.resolvedBy);
  // A queue pause can reject the already-scoped finish before provider dispatch.
  // Keep its paid candidate and let the bounded coordinator resume that same repair.
  const rejectedScopedRepair=run.web.error?.code==='WORKFLOW_PAUSED'&&prior?.stage==='finish'&&prior.error?.requestOutcome==='NOT_SENT'
   &&Array.isArray(prior.packageIds)&&prior.packageIds.length>0&&unresolvedPaid.every(candidate=>candidate.status==='needs_repair'
    &&Array.isArray(candidate.requiredPackageIds??candidate.packageIds)&&(candidate.requiredPackageIds??candidate.packageIds).length>0
    &&(candidate.requiredPackageIds??candidate.packageIds).every((id:string)=>prior.packageIds.includes(id)))&&productionBlock(run,'finish',prior.packageIds)===null;
  const technicalCandidate=Boolean(view.status==='failed'&&freePreparationRecoveryCause(run)
   &&bound&&!assemblyReady&&!hardStop&&!view.active&&!view.sourceStale&&!run.web.sourceStale&&!run.web.stopped&&!run.web.pauseRequested&&!run.web.owner
   &&!(run.web.reservedAttemptIds?.length)&&!['unknown','usage_review','budget_stop','stopped','interrupted'].includes(run.status)
   &&Number(view.usage?.unknownAttempts)===Number(view.usage?.acknowledgedUnknownAttempts??0)&&settled&&!localBudgetStop&&(!unresolvedPaid.length||rejectedScopedRepair)&&recoveryAttempts<2&&(saved||view.preparation?.ready===true));
  const emptyCandidate=Boolean(bound&&run.status==='created'&&run.plan==null&&run.assembly==null
   &&Array.isArray(run.operations)&&operations.length===0&&Array.isArray(run.candidates)&&run.candidates.length===0&&Array.isArray(run.adopted)&&run.adopted.length===0
   &&run.web.owner===null&&run.web.reserved===0&&Array.isArray(run.web.reservedAttemptIds)&&run.web.reservedAttemptIds.length===0
   &&run.web.sourceStale===false&&run.web.stopped===false&&run.web.pauseRequested===false&&!view.active&&!view.sourceStale&&!hardStop&&!terminalProblem&&!pending
   &&view.usage?.unknownAttempts===0&&(view.usage?.knownTokens??view.usage?.totalTokens)===0&&!localBudgetStop&&(saved||view.preparation?.ready===true));
  if((technicalCandidate||emptyCandidate)&&!saved)sourceGatePassed=productionWorkflowSourceVersion(await services.readInputs(workflow.projectId))===workflow.sourceVersion;
  const canRecoverRead=technicalCandidate&&sourceGatePassed===true;
  // Only the coordinator's scoped pending delta may pass an unrelated aggregate material block.
  const canAutoRepair=canRecoverRead||Boolean(pending?.versionId&&Array.isArray(pending.packageIds)&&pending.packageIds.length&&pending.packageIds.every((id:unknown)=>typeof id==='string'&&id.length>0)&&bound&&sourceGatePassed!==false&&!view.active&&!view.sourceStale&&!view.blocked&&!view.legacyReadOnly&&!unknownOrStopped&&!noProgress&&productionBlock(run,'finish',pending.packageIds)===null);
  const continuityPending=Boolean(assemblyReady&&!pending&&!hardStop&&!terminalProblem&&!unknownOrStopped&&view.production?.chainComplete===false&&binding.productionChain?.mode==='CHAIN'&&['PRELIMINARY','UNRESOLVED'].includes(boundaryStatus));
 const activeOp=view.operations?.findLast((o:Row)=>['running','queued'].includes(o.status));
  const sourceCheckPending=saved||Boolean(view.sourceCheckPending)||view.preparation?.ready!==true;
 return {id:run.id,projectId:binding.projectId,episodeNumber:binding.episodeNumber,status:view.status,busy:Boolean(view.active),sourceStale:Boolean(view.sourceStale),
   sourceCheckPending,freshness:saved?'DEFERRED':sourceCheckPending?'UNAVAILABLE':'CHECKED',preparation:saved?{ready:false,deferred:true}:view.preparation,...(sourceGatePassed!==undefined?{sourceGatePassed}:{}),
   ...(canRecoverRead?{technicalReadRecovery:{eligible:true,code:run.web.error.code,attempts:recoveryAttempts,contextSnapshotSame:saved?null:true}}:{}),
  stage:activeOp?.stage??run.operations?.at(-1)?.stage??null,executionPhase:activeOp?.execution?.phase??null,inFlight:view.scheduling?.inFlight??0,queued:view.scheduling?.queued??0,
  knownTokens:Number.isSafeInteger(view.usage?.knownTokens??view.usage?.totalTokens)?view.usage.knownTokens??view.usage.totalTokens:null,
   recoveryPending:bound&&!view.active&&!view.sourceStale&&!view.legacyReadOnly&&operations.some(op=>op.epoch===run.epoch&&(['unknown','running'].includes(op.status)||hasPendingSavedResponse(run,op))&&!op.cancelAcknowledgement&&!op.cancelRequestedAt),
   boundaryReviewPending:!view.active&&!view.sourceStale&&!unknownOrStopped&&!pending&&['PRELIMINARY','UNRESOLVED'].includes(boundaryStatus)&&needs.filter((n:Row)=>n.resolved!==true).every((n:Row)=>n.target==='OPENING_CONTINUITY'),
   // Saved completion schedules the next episode; it never authorizes export or payment without current checkSource.
   textAdopted:sourceGatePassed!==false&&!view.active&&!view.sourceStale&&!hardStop&&!terminalProblem&&!unknownOrStopped&&!pending&&assemblyReady,
   complete:sourceGatePassed!==false&&!view.active&&!view.sourceStale&&!hardStop&&!terminalProblem&&!unknownOrStopped&&!pending&&assemblyReady&&view.production?.chainComplete===true,
   blocked:Boolean(hardStop||terminalProblem||unknownOrStopped||pending),canAutoRepair,emptyAdmission:emptyCandidate&&sourceGatePassed===true,continuityPending,continuityStatus:boundaryStatus??null,needUpstream:needs.some((n:Row)=>n.resolved!==true&&!n.supplyUpdated),needs,message:view.error?.message??null,
   fingerprint:digest({assembly:run.assembly??null,adopted:run.adopted??[],sourceBasisVersion:binding.sourceBasisVersion??binding.sourceVersion}),productionBudget:binding.productionBudget??null,productionChain:binding.productionChain??null};
 };
 const inspect=async(workflow:ProductionWorkflow)=>inspectionReads(digest([actorId,workflow]),()=>retryDatabaseRead(async()=>{
  const [input,stage1,scope]=await Promise.all([services.readInputs(workflow.projectId),services.readStage1(workflow.projectId),services.readScope(workflow.projectId)]);
  const sourceVersion=productionWorkflowSourceVersion(input);
  // An unmaterialized original is a valid P1 input; do not require an episode-bound direction before P1 can run.
  const direction=input.sourceIndex.episodes.length?await services.readDirection(workflow.projectId,actorId):{status:'UNCONFIRMED',source:{blocker:null},generationPlan:{allowed:true},generation:null,draft:null};
  const availableEpisodes=input.sourceIndex.episodes.filter((e:Row)=>isProductionEpisodeNumber(e.number,scope)).map((e:Row)=>e.number);
  const sourceConflicts=(input.sourceContext.issues??[]).filter((issue:Row)=>stage1.task?.status==='WAITING_USER'&&issue.code==='DUPLICATE_EPISODE_NUMBER');
  const technicalIssues=[...(input.sourceContext.issues??[]).filter((issue:Row)=>!sourceConflicts.includes(issue)),...(input.sourceContext.unresolved??[]).map((section:Row)=>({code:'UNRESOLVED_SOURCE',coordinate:section.key,message:'保留尚未归属的来源，先由基础处理核对；不把未解析直接断言为源文冲突。'}))];
  const issues=input.sourceIndex.episodes.filter((e:Row)=>workflow.episodeNumbers.includes(e.number)).flatMap((episode:Row)=>{
   try{return prepareEpisodeReception(episode as {number:number;content:string},stage1.document.f2,input.scriptResolutions?.[episode.number]).scriptReception.diagnostics.map(d=>({episodeNumber:episode.number,...d}));}
   catch(error){return [{episodeNumber:episode.number,code:'SCRIPT_RECEPTION',message:(error as Error).message}];}
  });
  const requiredChoices=stage1.requiredChoices??[];
  let stage1Blocker=stage1.continuationBlocker??null,userConfirmation=false;
  if(stage1.action==='UNKNOWN_CONFIRM')stage1Blocker='已有基础处理回执或用量未知，请先恢复已有结果，不自动重试。';
  else if(requiredChoices.length){stage1Blocker='基础资料中有已明确标为必须由用户裁定的源文问题。';userConfirmation=true;}
  else if(!stage1.complete&&stage1.action==='NONE'&&!stage1.busy)stage1Blocker='尚无可继续处理的原文，请检查来源接入。';
  let assetProgress:{total:number;ready:number;adopted:number}|null=null;
  let assets:Row={missingCandidateKeys:[],missingCriticalKeys:[...workflow.criticalAssetKeys],busy:false,requestedAssetKeys:workflow.requestedAssetKeys};
  if(stage1.complete){
   // Always explicit: [] means use existing source cards, never implicitly generate the entire catalogue.
   const workspace=await services.readAssets(workflow.projectId);
   const plan=await services.planAssets(workflow.projectId,workflow.episodeNumbers,workflow.requestedAssetKeys,{workspace,input,production:scope});
   const adoptions=workflow.criticalAssetKeys.length||workflow.requestedAssetKeys.length?await services.readAdoptions(workflow.projectId,actorId,workspace):{assets:{}};
   const needs=(key:string)=>{const asset=workspace.assets.find(a=>a.key===key),record=workspace.records[key];return !asset||!record?.body||record.status!=='READY'||promptNeedsReview(asset,workspace.records,workspace.assets);};
   const missingCandidateKeys=workflow.requestedAssetKeys.filter(key=>plan.eligibleKeys.includes(key)&&needs(key));
   const affected=(plan.assetKeys as string[]).filter(key=>plan.eligibleKeys.includes(key)&&needs(key));
   const retained=affected.find(key=>workspace.records[key]?.status==='FAILED'||workspace.records[key]?.origin==='MANUAL'&&Boolean(workspace.records[key]?.body));
   const requested=[...new Set(workflow.requestedAssetKeys)];
   assetProgress={total:requested.length,ready:requested.filter(key=>!needs(key)).length,adopted:requested.filter(key=>!needs(key)&&['TEXT_ADOPTED','REFERENCE_ADOPTED'].includes(adoptions.assets[key]?.status)).length};
   assets={requestedAssetKeys:workflow.requestedAssetKeys,materialSourceOnlyKeys:plan.materialSourceOnlyKeys??[],missingCandidateKeys,
    missingCriticalKeys:workflow.criticalAssetKeys.filter(key=>!['TEXT_ADOPTED','REFERENCE_ADOPTED'].includes(adoptions.assets[key]?.status)),
    busy:affected.some(key=>workspace.records[key]?.status==='RUNNING'),...(retained?{blocker:`材料 ${retained} 已有待核对回包或人工稿，先检查已有记录；不自动覆盖或重发。`}:{})};
  }
  const runs:Row={};
  await Promise.all(Object.values(workflow.selectedRuns).map(async id=>{try{runs[id]=await readRun(id,workflow,{input,sourceGatePassed:sourceVersion===workflow.sourceVersion});}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}));
  const hasDirectionCandidate=Boolean(direction.draft&&direction.draft.sourceVersion===direction.source.sourceVersion||direction.draft&&!direction.draft.sourceVersion);
  const independentDirectionLimit=direction.status!=='CONFIRMED'&&!hasDirectionCandidate&&!direction.generationPlan.allowed?direction.generationPlan.reason:null;
  const directionSupplement=direction.status!=='CONFIRMED'&&!hasDirectionCandidate&&!direction.generation?.held&&direction.foundationPreparation?.status==='NEEDS_SUPPLEMENT'
   ? '第一阶段正确资料已保存，但方向候选待补。可手工完善，或明确发起额外方向分析；未自动重读全剧。' : null;
  return {sourceVersion,availableEpisodes,canPrepareSource:!availableEpisodes.length&&stage1.action==='START',sourceConflicts,technicalIssues,
   progress:productionProgress({...workflow,sourceVersion},stage1,runs,assetProgress),
   standard:{ready:issues.length===0&&workflow.episodeNumbers.every(n=>availableEpisodes.includes(n)),issues},
   stage1:{ready:Boolean(stage1.complete),busy:Boolean(stage1.busy),blocker:stage1Blocker,userConfirmation,taskId:stage1.task?.id??null,requiredChoices:requiredChoices.map((c:Row)=>({id:c.id,question:c.question}))},
   direction:{status:direction.status,hasCandidate:hasDirectionCandidate,pending:Boolean(direction.generation?.pending),
    generationId:direction.generation?.id??null,settledKnown:direction.generation?.status==='FAILED'&&!direction.generation.pending&&direction.generation.usage?.unknownCalls===0&&Boolean(direction.generation.callUsage?.length),
    blocker:direction.source.blocker??independentDirectionLimit??(direction.generation?.held&&!direction.generation.pending&&!direction.generation.resumable?(direction.generation.recoveryIssue??'方向调用已停止，需核对已有回包与用量；未自动重发。'):null)??directionSupplement,brief:direction.brief??direction.draftBrief??null},assets,runs};
 }));
 return {inspect,readRun,withBudget:withProductionBudgetContext,
  deliveryBundle:services.readStoryboardAttempt?async(workflow:ProductionWorkflow,ledger:Row)=>{
   if(!services.readStoryboardAttempt)fail('WORKFLOW_DELIVERY_EVIDENCE','此适配器没有原生回执读取入口。');
   if(workflow.episodeNumbers.some(n=>!workflow.selectedRuns[n]))fail('WORKFLOW_DELIVERY_NOT_READY','所选集数的采用稿尚未齐备，未导出或生成替代稿。');
   const input=await services.readInputs(workflow.projectId);
   if(productionWorkflowSourceVersion(input)!==workflow.sourceVersion)fail('WORKFLOW_DELIVERY_STALE','交付时真实来源已变化。');
   const runs=await Promise.all(workflow.episodeNumbers.map(n=>services.readStoryboard(workflow.selectedRuns[n]))),views:Row={};
   for(const run of runs)views[run.id]=await readRun(run.id,workflow,undefined,run);
   return nativeRequire(path.join(process.cwd(),'runtime/production-delivery.mjs')).buildProductionDelivery({workflow,runs,views,ledger,readAttempt:services.readStoryboardAttempt});
  }:undefined,
  boundaryPacket,
  reviewBoundary:async(workflow:ProductionWorkflow,command:Row)=>{
   const packet=await boundaryPacket(workflow,command.runId);
   nativeRequire(path.join(process.cwd(),'runtime/production-boundary-review.mjs')).assertBoundaryPacket(packet,command.evidenceHash);
   if(command.sourceResolution!==undefined){
    if(!services.resolveStoryboardSource||!command.approval)fail('WORKFLOW_BOUNDARY_APPROVAL','源文裁决需要独立明确批准，不能用普通复核替代。');
    return services.resolveStoryboardSource!(command.runId,command.sourceResolution,{actorId,reference:command.approval.reference,answer:command.approval.answer});
   }
   if(!services.reviewStoryboardBoundary||!command.review)fail('WORKFLOW_BOUNDARY_REVIEW','请提交完整坐标化复核；没有自动放行。');
   return services.reviewStoryboardBoundary!(command.runId,command.review);
  },
  recoverSaved:async(workflow:ProductionWorkflow,id:string)=>{
   if(!services.recoverSavedStoryboard)return;
   const run=await services.readStoryboard(id),b=run.web?.binding;
   if(!b||b.projectId!==workflow.projectId||workflow.selectedRuns[b.episodeNumber]!==id||b.productionChain?.id!==workflow.id||b.productionBudget?.id!==workflow.budgetId)fail('WORKFLOW_RUN_SCOPE','恢复目标不属于当前原队列。');
   return services.recoverSavedStoryboard(id);
  },
  recoverAction:async(workflow:ProductionWorkflow,action:Row)=>{
   if(action.kind!=='ASSETS'||!action.materialNeeds?.length||!services.readMaterialReceipts)return false;
   const input=await services.readInputs(workflow.projectId);if(productionWorkflowSourceVersion(input)!==workflow.sourceVersion)return false;
   const receipts=await services.readMaterialReceipts(workflow.projectId,workflow.id,action.materialRequestIds??[]);
   return action.materialNeeds.every((need:Row)=>receipts.some(receipt=>receipt.status==='READY'&&receipt.key===need.target&&receipt.scope.workflowId===workflow.id&&receipt.scope.runId===need.runId&&receipt.scope.episodeNumber===need.episodeNumber&&receipt.scope.sourceVersion===input.sourceVersion&&receipt.needRefs.includes(need.needRef)));
  },
  validateMaterialRequest:async(workflow:ProductionWorkflow,needs:Row[])=>{
   const targets=[...new Set<string>(needs.map(n=>n.target))],plan=await services.planAssets(workflow.projectId,workflow.episodeNumbers,targets);
   if(targets.some(key=>!plan.assetKeys.includes(key)||!plan.eligibleKeys.includes(key)))fail('WORKFLOW_MATERIAL_TARGET','需求目标尚不能精确对应可处理的资产键；请执行者按原文坐标定位，未猜测或新建资产。');
  },
  onSelectionChanged:(workflow:ProductionWorkflow,changedRunId?:string)=>services.refreshChain(workflow.projectId,changedRunId),
  onPause:async(workflow:ProductionWorkflow)=>{for(const id of Object.values(workflow.selectedRuns)){const run=await services.readStoryboard(id);if(run.web?.binding?.productionChain?.id===workflow.id)await services.pauseStoryboard(id);}},
  run:async(action:Row,workflow:ProductionWorkflow,context:{bind:(binding:Row)=>Promise<unknown>;budget:ProductionBudgetContext;isPaused:()=>Promise<boolean>})=>{
   const check=async()=>{if(await context.isPaused())fail('WORKFLOW_PAUSED','流程已暂停，未发送后续请求。');};
   const runner=async(request:any)=>{await check();if(!services.runRole)fail('WORKFLOW_RUNNER','执行适配器缺少模型入口。');return services.runRole!(request);};
   await check();
   const currentInput=await services.readInputs(workflow.projectId);
   if(productionWorkflowSourceVersion(currentInput)!==workflow.sourceVersion)fail('WORKFLOW_SOURCE_CHANGED','动作开始前源稿已变化，未发送新请求。');
   if(action.kind==='STAGE1'){
    const before=await services.readStage1(workflow.projectId);
    const task=await services.queueStage1(workflow.projectId,{expectedState:before.expectedState,autoAssetPrompts:false});
    await context.bind({taskId:task.id});
    const result=await services.executeStage1(workflow.projectId,task.id,{workerToken:task.workerToken,stageRunner:async(_stage:string,prompt:string,call:Row)=>runner({...call,prompt})});
    if(!result)return fail('WORKFLOW_STAGE1_RECEIPT','基础处理回执尚不可读，请先核对已保存任务。');
    if(['INTERRUPTED','STOPPED'].includes(result.status))throw Object.assign(new Error(result.error??result.message??'基础处理已中断，已保存记录保留。'),{code:'WORKFLOW_STAGE1_INTERRUPTED',requestOutcome:result.unknownOutcome?'UNKNOWN':'RESPONDED'});
    return {taskId:task.id,status:result.status,...(result.message?{message:result.message}:{}),...(result.error?{error:result.error}:{}),...(result.status==='COMPLETE'?{sourceVersion:productionWorkflowSourceVersion(await services.readInputs(workflow.projectId))}:{})};
   }
   if(action.kind==='DIRECTION'){
    const workspace=await services.readDirection(workflow.projectId,actorId);
    await services.generateDirection(workflow.projectId,actorId,{action:workspace.generation?.resumable?'resume':'generate',stateToken:workspace.stateToken,sourceVersion:workspace.source.sourceVersion,costAcknowledged:true},{runner});
    const after=await services.readDirection(workflow.projectId,actorId);
    await context.bind({directionGenerationId:after.generation?.id??null});
    if(after.generation?.status==='FAILED'){
      if(after.generation.usage?.unknownCalls===0)return{status:'PARTIAL',message:after.generation.message??'方向候选未完成，已保存回包保留。',draftHash:null};
      throw Object.assign(new Error(after.generation.message??'方向调用结果待核对。'),{code:'WORKFLOW_DIRECTION_REVIEW',requestOutcome:'UNKNOWN'});
    }
    return {status:'CANDIDATE_SAVED',draftHash:after.draft?.hash??null};
   }
   if(action.kind==='ASSETS'){
    const result=await services.generateAssets(workflow.projectId,workflow.episodeNumbers,{assetKeys:action.assetKeys??[],...(action.materialNeeds?.length?{materialNeeds:action.materialNeeds.map((n:Row)=>({...n,sourceVersion:currentInput.sourceVersion}))}:{}),runner,shouldContinue:async()=>!await context.isPaused()});
    if(result.results.some((r:Row)=>r.status!=='READY'))throw Object.assign(new Error('选定材料有未完成回包，请查看已保存结果，未自动重试。'),{code:'WORKFLOW_ASSET_REVIEW',requestOutcome:'RESPONDED'});
    await services.refreshChain(workflow.projectId);
    return {status:'CANDIDATES_SAVED',assetKeys:result.assetKeys,resultKeys:result.results.map((r:Row)=>r.key)};
   }
   if(action.kind==='STORYBOARD_CREATE'){
    const episode=await services.episode(workflow.projectId,action.episodeNumber);
    if(!episode)fail('WORKFLOW_EPISODE','找不到所选集原文。');
    const productionChain:ProductionChain=workflowRuntime.productionWorkflowChain(workflow);
    const run=await services.createStoryboard(episode!,{productionBudget:context.budget,productionChain,...workflow.budgetPolicy?.episode,...(workflow.parallel?.enabled?{modelSelection:workflow.parallel.modelSelection,executionTier:workflow.parallel.executionTier,...workflow.parallel.runBudget}:{} )});
    await context.bind({runId:run.id,episodeNumber:action.episodeNumber});await check();
    await services.startStoryboard(run.id);return {status:'RUN_STARTED',runId:run.id};
   }
   if(action.kind==='STORYBOARD_CONTINUE'){
    const run=await readRun(action.runId,workflow);
    if(run.productionBudget?.id!==workflow.budgetId||path.resolve(run.productionBudget?.directory??'')!==path.resolve(context.budget.directory)||run.productionChain?.id!==workflow.id)fail('WORKFLOW_RUN_BUDGET','已有版本未绑定本流程共享预算，不能在此入口继续付费；已完成稿仍可被选用。');
    if(run.sourceStale||run.continuityPending||run.blocked&&!run.canAutoRepair)fail('WORKFLOW_RUN_NOT_READY','已有版本需要先核对承接或回执，未启动新的付费动作。');
    await context.bind({runId:run.id,episodeNumber:run.episodeNumber});await check();await services.startStoryboard(run.id);return {status:'RUN_STARTED',runId:run.id};
   }
   return fail('WORKFLOW_ACTION','未知流程动作。',400);
  }
 };
}

async function authorizedService(projectId:string,actorId:string){
 const {prisma}=await import('./prisma');
 if(!actorId)fail('UNAUTHORIZED','请先登录。',401);
 const membership=await retryDatabaseRead(()=>prisma.projectRole.findFirst({where:{projectId,userId:actorId},select:{id:true}}));
 if(!membership)fail('WORKFLOW_FORBIDDEN','没有此项目的访问权限。',403);
 return workflowRuntime.createProductionWorkflowService({directory:productionWorkflowRoot,budgetDirectory:productionBudgetRoot,adapters:createProductionWorkflowAdapters(actorId,await productionServices())});
}

function parallelWorker(projectId:string,actorId:string){
 const {createParallelProductionWorker}=nativeRequire(path.join(process.cwd(),'runtime/production-parallel.mjs'));
 return createParallelProductionWorker({directory:productionWorkflowRoot,makeService:()=>authorizedService(projectId,actorId)});
}

/** Server startup only: legacy/manual/configured records never grant autonomous model calls. */
export async function restoreAuthorizedParallelProduction(){
 const maintenance=maintenanceRuntime.runtimeMaintenanceState(maintenanceDataRoot);
 if(maintenance&&!['RESUMED','ABORTED'].includes(maintenance.phase))return;
 const files=await readdir(path.join(productionWorkflowRoot,'documents')).catch((e:NodeJS.ErrnoException)=>e.code==='ENOENT'?[]:Promise.reject(e));
 for(const file of files.filter(f=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(f))){
  const d=JSON.parse(await readFile(path.join(productionWorkflowRoot,'documents',file),'utf8')) as ProductionWorkflow;
  if(d.parallel?.enabled&&!d.paused){
   try{const starter=d.parallel.authorizedBy;if(!starter)fail('WORKFLOW_FORBIDDEN','四路启动授权缺失。',403);await parallelWorker(d.projectId,starter!).start(d.id);}
   catch(error){if((error as NodeJS.ErrnoException).code==='LEASE_BUSY')continue;await createStore(productionWorkflowRoot).update(d.id,(current:Row)=>{
    if(current.parallel?.authorizedAt===d.parallel?.authorizedAt&&current.parallel?.authorizedBy===d.parallel?.authorizedBy){
     const waiting=current.parallel.reconnectPolicy==='wake-reconnect-v1'&&(error as {retryableRead?:boolean}).retryableRead===true;
     if(!waiting){current.parallel.enabled=false;current.parallel.lastStop='INTERRUPTED';}
     current.parallel.worker={status:waiting?'WAIT_CONNECTION':'INTERRUPTED',updatedAt:new Date().toISOString(),error:{code:'WORKFLOW_RESTORE_FAILED',message:waiting?'只读连接暂不可用，等待联网后重连原四路；没有重发请求。':'四路恢复未通过权限或执行者核对，未派发新请求；请检查后重新启用。'}};current.revision++;current.updatedAt=new Date().toISOString();
    }return current;
   });}
  }
 }
}

/** Every real kernel call, including mode=all, rechecks the current parallel authorization before budget reservation. */
export async function assertParallelDispatchAuthorized(binding:Row,runId:string){
 maintenanceRuntime.assertRuntimeAdmission(maintenanceDataRoot);
 const chain=binding.productionChain;if(!chain?.id)return;
 let workflow:ProductionWorkflow;
 try{workflow=await createStore(productionWorkflowRoot).read(chain.id);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'&&chain.selectionProtocol!=='per-episode-selection-v1')return;throw error;}
 if(!workflow.parallel?.participatingRuns?.includes(runId)){
  if(binding.executionTier==='fast')fail('WORKFLOW_RUN_BINDING','Fast任务没有四路参与登记，未发送新的请求。');
  return; // Free configuration must not interrupt old/manual standard tasks.
 }
 if(workflow.projectId!==binding.projectId||workflow.selectedRuns[binding.episodeNumber]!==runId)fail('WORKFLOW_RUN_BINDING','任务已不属于当前四路选定版本，未发送新的请求。');
 if(workflow.paused||!workflow.parallel.enabled)fail('WORKFLOW_PAUSED','四路制作已停止；在途回包保留，不继续新的模型调用。');
 const {prisma}=await import('./prisma'),actorId=workflow.parallel.authorizedBy;
 if(!actorId||!await retryDatabaseRead(()=>prisma.projectRole.findFirst({where:{projectId:binding.projectId,userId:actorId},select:{id:true}})))fail('WORKFLOW_FORBIDDEN','四路启动者的项目权限已失效，未发送新的请求。',403);
 if(productionWorkflowSourceVersion(await retryDatabaseRead(()=>readProductionWorkflowInputs(binding.projectId)))!==workflow.sourceVersion)fail('WORKFLOW_SOURCE_CHANGED','制作链源稿已变化，未发送新的请求；已保存稿和在途回包保留。');
}

/** Registry only: no DB read, reconciliation, provider or background dispatch. */
export async function getProductionChain(id:string,projectId:string):Promise<ProductionChain>{
 const workflow=await createStore(productionWorkflowRoot).read(id);
 if(workflow.schema!=='PRODUCTION_WORKFLOW_V1'||workflow.projectId!==projectId)fail('WORKFLOW_SCOPE','流程不属于当前项目。');
 return workflowRuntime.productionWorkflowChain(workflow);
}

/** Same durable gate as selection/bind; only short agreement IO inside the callback. */
export async function withChainSelection<T>(id:string,projectId:string,action:(chain:ProductionChain)=>Promise<T>):Promise<T>{
 return createStore(productionWorkflowRoot).withLockedRead(id,(workflow:Row)=>{
  if(workflow.schema!=='PRODUCTION_WORKFLOW_V1'||workflow.projectId!==projectId)fail('WORKFLOW_SCOPE','流程不属于当前项目。');
  return action(workflowRuntime.productionWorkflowChain(workflow));
 });
}

export async function getProductionWorkflow(projectId:string,actorId:string,workflowId?:string|null){
 const service=await authorizedService(projectId,actorId);
 if(!workflowId)return {workflows:await service.list(projectId)};
 const workflow=await service.read(workflowId);if(workflow.projectId!==projectId)fail('WORKFLOW_SCOPE','流程不属于当前项目。',403);
 return service.inspect(workflowId);
}
export async function readProductionDeliveryFile(projectId:string,actorId:string,workflowId:string,name:string){
 const service=await authorizedService(projectId,actorId),workflow=await service.read(workflowId);
 if(workflow.projectId!==projectId)fail('WORKFLOW_SCOPE','流程不属于当前项目。',403);
 return service.readDeliveryFile(workflowId,name);
}
export async function mutateProductionWorkflow(projectId:string,actorId:string,command:ProductionWorkflowCommand){
 const service=await authorizedService(projectId,actorId);
 if(command.action==='create')return service.create({projectId,actorId,episodeNumbers:command.episodeNumbers,mode:command.mode,criticalAssetKeys:command.criticalAssetKeys,requestedAssetKeys:command.requestedAssetKeys,budgetId:command.budgetId,costAcknowledged:command.costAcknowledged,maxCalls:command.maxCalls,maxTokens:command.maxTokens});
 if(typeof command.workflowId!=='string')fail('WORKFLOW_INPUT','缺少流程编号。',400);
 const workflow=await service.read(command.workflowId);if(workflow.projectId!==projectId)fail('WORKFLOW_SCOPE','流程不属于当前项目。',403);
 if(command.action==='pause')await (await runtimeMaintenance()).userPause({workflowId:workflow.id});
 else if(['advance','resume','start-parallel','configure-parallel','select-run'].includes(command.action))maintenanceRuntime.assertRuntimeAdmission(maintenanceDataRoot);
 const input={...command,actorId};
 if(command.action==='pause'||command.action==='start-parallel'||command.action==='reconnect-parallel'){
  const worker=parallelWorker(projectId,command.action==='reconnect-parallel'?workflow.parallel?.authorizedBy??actorId:actorId);
  return worker.serialize(workflow.id,async()=>{
   const view=command.action==='pause'?await service.pause(workflow.id,input):command.action==='reconnect-parallel'?await service.reconnectParallel(workflow.id,input):await service.startParallel(workflow.id,input);
   if(command.action==='pause')await worker.stop(workflow.id,'PAUSED',{drain:false});else if(view.parallel?.enabled&&!view.workflow.paused)try{await worker.start(workflow.id);}catch(error){
    // Startup failed before tick could checkpoint it. Never leave a phantom
    // enabled queue; another process's live lease/authorization is not ours to stop.
    const newAuthorization=command.action==='start-parallel'&&(workflow.paused||!workflow.parallel?.enabled);
    if(newAuthorization&&(error as NodeJS.ErrnoException).code!=='LEASE_BUSY')await service.recordParallelWorker(workflow.id,
     {status:'INTERRUPTED',updatedAt:new Date().toISOString(),error:{code:'WORKFLOW_START_FAILED',message:'队列启动读取或执行者核对未完成，已停止新派发；保留原任务。'}},
     {stop:true,expectedAuthorization:view.workflow.parallel.authorizedAt,expectedWorker:view.workflow.parallel.worker??null}).catch(()=>{});
    throw error;
   }
   return service.inspect(view.workflow.id);
  });
 }
 switch(command.action){
  case 'advance':return service.advance(command.workflowId,input);
  case 'resume':return service.resume(command.workflowId,input);
  case 'recover':return service.recover(command.workflowId,input);
  case 'select-run':return service.selectRun(command.workflowId,input);
  case 'quality-review':return service.recordQualityReview(command.workflowId,input);
  case 'request-materials':return service.requestMaterials(command.workflowId,input);
  case 'configure-parallel':return service.configureParallel(command.workflowId,input);
  case 'boundary-evidence':return service.boundaryEvidence(command.workflowId,input);
  case 'boundary-review':return service.reviewBoundary(command.workflowId,input);
  case 'configure-delivery':return service.configureDelivery(command.workflowId,input);
  case 'export-delivery':return service.exportDelivery(command.workflowId,input);
  default:return fail('WORKFLOW_ACTION','未知流程操作。',400);
 }
}
/** Maintenance resume is not a new paid authorization. Never call startParallel here. */
export async function verifyOriginalProductionForMaintenance(control:Row){
 const w=await createStore(productionWorkflowRoot).read(control.workflowId);
 if(w.projectId!==control.projectId||w.parallel?.authorizedAt!==control.authorization||w.runtimeMaintenance?.id!==control.id)fail('WORKFLOW_PARALLEL_OWNER','维护核验的原授权已变化');
 await authorizedService(w.projectId,w.parallel.authorizedBy);
 const sourceVersion=productionWorkflowSourceVersion(await retryDatabaseRead(()=>readProductionWorkflowInputs(w.projectId)));
 if(sourceVersion!==w.sourceVersion)fail('WORKFLOW_SOURCE_CHANGED','当前双源变化，维护门保留');
 return {authorization:control.authorization,sourceVersion,actorVerified:true};
}
export async function resumeOriginalProductionAfterMaintenance(control:Row){
 const w=await createStore(productionWorkflowRoot).read(control.workflowId);
 if(w.projectId!==control.projectId||w.parallel?.authorizedAt!==control.authorization||w.runtimeMaintenance?.id!==control.id||w.runtimeMaintenance.phase!=='RESUMED'||w.paused||!w.parallel.enabled)fail('WORKFLOW_PARALLEL_OWNER','维护后的原授权或用户控制已变化，未续派。');
 const authorized=await authorizedService(w.projectId,w.parallel.authorizedBy);
 await authorized.reconnectParallel(w.id,{expectedAuthorization:control.authorization});
 await parallelWorker(w.projectId,w.parallel.authorizedBy).start(w.id,{expectedAuthorization:control.authorization});
}
export function productionWorkflowFailure(error:unknown){
 const value=error as {status?:number;code?:string;message?:string},known=/^(WORKFLOW_|PRODUCTION_|BOUNDARY_REVIEW|SOURCE_RESOLUTION|SOURCE_STALE$|LEGACY_READ_ONLY$|RUN_ACTIVE$|EPISODE_BUSY$)/.test(value?.code??'');
 const status=value?.status??(value?.code==='ENOENT'?404:value?.code==='INVALID_ID'?400:known?409:500);
 return {status,body:{code:value?.code??'WORKFLOW_ERROR',error:status===500?'流程检查或保存暂未完成，已有记录保留，请核对后重试。':value?.message??'流程操作暂不能完成。'}};
}
