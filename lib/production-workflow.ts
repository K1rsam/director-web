import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import {withProductionBudgetContext,productionBudgetRoot,type ProductionBudgetContext} from './production-budget';
import {prepareEpisodeReception} from './standard-script-reception';
import {isProductionEpisodeNumber} from './production-episodes';
import {promptNeedsReview} from './asset-prompt-contract';
import type {PromptWorkspace} from './asset-prompt-contract';
import type {PrismaClient} from '@prisma/client';

type Row=Record<string,any>;
export type ProductionChain={id:string;mode:'CHAIN'|'SINGLE';selectionRevision:number;selectedRuns:Record<string,string>;episodeNumbers:number[]};
export type ProductionWorkflow=ProductionChain&{schema:'PRODUCTION_WORKFLOW_V1';projectId:string;actorId:string;budgetId:string;sourceVersion:string;revision:number;criticalAssetKeys:string[];requestedAssetKeys:string[];paused:boolean;costAcknowledged:boolean;status:'READY'|'RUNNING'|'INTERRUPTED';activeAction:Row|null;receipts:Row[];qualityReviews:Row[];materialRequests:Row[];createdAt:string;updatedAt:string};
export type ProductionWorkflowCommand=Row&{action:'create'|'advance'|'pause'|'resume'|'recover'|'select-run'|'quality-review'|'request-materials';workflowId?:string;expectedRevision?:number};
export const productionWorkflowRoot=path.resolve(/*turbopackIgnore: true*/ process.env.DIRECTOR_PRODUCTION_WORKFLOW_DIR||path.join(process.cwd(),'.production-workflows'));
const nativeRequire=createRequire(path.join(process.cwd(),'package.json'));
const workflowRuntime=nativeRequire(path.join(process.cwd(),'runtime/production-workflow.mjs'));
const {createStore}=nativeRequire(path.join(process.cwd(),'runtime/storyboard-v4/core/store.mjs'));
const {productionBlock}=nativeRequire(path.join(process.cwd(),'runtime/storyboard-v4/coordinator.mjs'));
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
 planAssets:(projectId:string,episodeNumbers:number[],assetKeys:string[])=>Promise<Row>;readAdoptions:(projectId:string,actorId:string,workspace:PromptWorkspace)=>Promise<Row>;
 queueStage1:(projectId:string,options:Row)=>Promise<Row>;executeStage1:(projectId:string,taskId:string,options:Row)=>Promise<Row|null>;
 generateDirection:(projectId:string,actorId:string,command:Row,options:Row)=>Promise<unknown>;
 generateAssets:(projectId:string,episodeNumbers:number[],options:Row)=>Promise<Row>;
 episode:(projectId:string,episodeNumber:number)=>Promise<Row|null>;createStoryboard:(episode:Row,command:Row)=>Promise<Row>;
 readStoryboard:(id:string)=>Promise<Row>;storyboardView:(run:Row,episode:Row)=>Promise<Row>;startStoryboard:(id:string)=>Promise<Row>;
 pauseStoryboard:(id:string)=>Promise<unknown>;refreshChain:(projectId:string)=>Promise<unknown>;runRole?:(request:any)=>Promise<any>;
 readMaterialReceipts?:(projectId:string,workflowId:string,requestIds:string[])=>Promise<Row[]>;
};

async function productionServices():Promise<ProductionWorkflowServices>{
 const [foundation,direction,assets,adoptions,episodes,storyboard,db,role,materials]=await Promise.all([
  import('./foundation-delivery'),import('./series-direction-service'),import('./asset-prompt-service'),
  import('./asset-design-adoption'),import('./production-episodes'),import('./storyboard-service'),import('./prisma'),import('./role-runner'),import('./asset-material-candidates')]);
 return {
  readInputs:readProductionWorkflowInputs,readStage1:foundation.getFoundationDeliveryState,readDirection:direction.getSeriesDirectionWorkspace,
  readScope:episodes.readProductionScope,readAssets:assets.loadAssetPromptWorkspace,planAssets:assets.planEpisodeAssetProduction,readAdoptions:adoptions.readAssetDesignAdoptions,
  queueStage1:foundation.queueFoundationDelivery,executeStage1:foundation.executeFoundationDelivery,
  generateDirection:(p,a,c,o)=>direction.generateSeriesDirectionCandidate(p,a,c as any,o),generateAssets:assets.generateAssetPromptsForEpisodes,
  episode:(projectId,number)=>db.prisma.episode.findFirst({where:{projectId,number},include:{project:true}}),
  createStoryboard:storyboard.createStoryboardRun,readStoryboard:id=>storyboard.storyboardService().read(id),
  storyboardView:(run,episode)=>storyboard.storyboardRunView(run,episode,undefined,false),startStoryboard:id=>storyboard.storyboardService().start(id,{mode:'all'}),
  pauseStoryboard:id=>storyboard.storyboardService().pause(id),refreshChain:async projectId=>(await import('./storyboard-service')).refreshProductionChain(projectId),runRole:role.runRoleByProvider,
  readMaterialReceipts:materials.readScopedMaterialCandidateReceipt,
 };
}

export function createProductionWorkflowAdapters(actorId:string,services:ProductionWorkflowServices){
 const readRun=async(id:string,workflow:ProductionWorkflow)=>{
  const run=await services.readStoryboard(id),binding=run.web?.binding;
  if(!binding||binding.projectId!==workflow.projectId)fail('WORKFLOW_RUN_SCOPE','分镜版本不属于当前项目。');
  const episode=await services.episode(workflow.projectId,binding.episodeNumber);
  if(!episode||episode.id!==binding.episodeId)fail('WORKFLOW_RUN_SCOPE','分镜版本的分集绑定已失效。');
  const view=await services.storyboardView(run,episode!);
  const terminalProblem=['interrupted','unknown','usage_review','failed','stopped','budget_stop','needs_repair','needs_dependency_repair','waiting_dependencies','awaiting_confirmation','needs_design'].includes(view.status);
  const pending=run.production?.pendingRepair,needs=run.production?.needs??[],boundaryStatus=run.production?.boundaryCheck?.status;
  const hardStop=Boolean(view.blocked||view.legacyReadOnly||run.production?.blocking||view.production?.blocking||boundaryStatus==='CONSTRAINT_CONFLICT'||needs.some((n:Row)=>n.resolved!==true&&n.blocking&&!n.supplyUpdated));
  const unknownOrStopped=['interrupted','unknown','usage_review','failed','stopped','budget_stop','awaiting_confirmation','needs_design'].includes(view.status)
   ||Number(view.usage?.unknownAttempts)>0||(run.operations??[]).some((op:Row)=>['running','unknown'].includes(op.status));
  const prior=run.operations?.at(-1),noProgress=prior?.status==='completed'&&prior.issues?.some((issue:Row)=>issue.productionVersion===pending?.versionId);
  const bound=workflow.selectedRuns[binding.episodeNumber]===run.id&&binding.productionChain?.id===workflow.id&&binding.productionChain?.mode===workflow.mode&&binding.productionBudget?.id===workflow.budgetId;
  // Only the coordinator's scoped pending delta may pass an unrelated aggregate material block.
  const canAutoRepair=Boolean(pending?.versionId&&Array.isArray(pending.packageIds)&&pending.packageIds.length&&pending.packageIds.every((id:unknown)=>typeof id==='string'&&id.length>0)&&bound&&!view.active&&!view.sourceStale&&!view.blocked&&!view.legacyReadOnly&&!unknownOrStopped&&!noProgress&&productionBlock(run,'finish',pending.packageIds)===null);
  const assemblyReady=run.status==='text_ready_for_review'&&Boolean(run.assembly?.text)&&run.assembly?.validation?.errors?.length===0;
  const continuityPending=Boolean(assemblyReady&&!pending&&!hardStop&&!terminalProblem&&!unknownOrStopped&&view.production?.chainComplete===false&&binding.productionChain?.mode==='CHAIN'&&['PRELIMINARY','UNRESOLVED'].includes(boundaryStatus));
  return {id:run.id,projectId:binding.projectId,episodeNumber:binding.episodeNumber,status:view.status,busy:Boolean(view.active),sourceStale:Boolean(view.sourceStale),
   complete:!view.active&&!view.sourceStale&&!hardStop&&!terminalProblem&&!unknownOrStopped&&!pending&&assemblyReady&&view.production?.chainComplete===true,
   blocked:Boolean(hardStop||terminalProblem||unknownOrStopped||pending),canAutoRepair,continuityPending,needUpstream:needs.some((n:Row)=>n.resolved!==true&&!n.supplyUpdated),needs,message:view.error?.message??null,
   fingerprint:digest({assembly:run.assembly??null,adopted:run.adopted??[],sourceBasisVersion:binding.sourceBasisVersion??binding.sourceVersion}),productionBudget:binding.productionBudget??null,productionChain:binding.productionChain??null};
 };
 const inspect=async(workflow:ProductionWorkflow)=>{
  const [input,stage1,direction,scope]=await Promise.all([services.readInputs(workflow.projectId),services.readStage1(workflow.projectId),services.readDirection(workflow.projectId,actorId),services.readScope(workflow.projectId)]);
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
  let assets:Row={missingCandidateKeys:[],missingCriticalKeys:[...workflow.criticalAssetKeys],busy:false,requestedAssetKeys:workflow.requestedAssetKeys};
  if(stage1.complete){
   // Always explicit: [] means use existing source cards, never implicitly generate the entire catalogue.
   const [workspace,plan]=await Promise.all([services.readAssets(workflow.projectId),services.planAssets(workflow.projectId,workflow.episodeNumbers,workflow.requestedAssetKeys)]);
   const adoptions=workflow.criticalAssetKeys.length?await services.readAdoptions(workflow.projectId,actorId,workspace):{assets:{}};
   const needs=(key:string)=>{const asset=workspace.assets.find(a=>a.key===key),record=workspace.records[key];return !asset||!record?.body||record.status!=='READY'||promptNeedsReview(asset,workspace.records,workspace.assets);};
   const missingCandidateKeys=workflow.requestedAssetKeys.filter(key=>plan.eligibleKeys.includes(key)&&needs(key));
   const affected=(plan.assetKeys as string[]).filter(key=>plan.eligibleKeys.includes(key)&&needs(key));
   const retained=affected.find(key=>workspace.records[key]?.status==='FAILED'||workspace.records[key]?.origin==='MANUAL'&&Boolean(workspace.records[key]?.body));
   assets={requestedAssetKeys:workflow.requestedAssetKeys,materialSourceOnlyKeys:plan.materialSourceOnlyKeys??[],missingCandidateKeys,
    missingCriticalKeys:workflow.criticalAssetKeys.filter(key=>!['TEXT_ADOPTED','REFERENCE_ADOPTED'].includes(adoptions.assets[key]?.status)),
    busy:affected.some(key=>workspace.records[key]?.status==='RUNNING'),...(retained?{blocker:`材料 ${retained} 已有待核对回包或人工稿，先检查已有记录；不自动覆盖或重发。`}:{})};
  }
  const runs:Row={};
  await Promise.all(Object.values(workflow.selectedRuns).map(async id=>{try{runs[id]=await readRun(id,workflow);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}));
  const hasDirectionCandidate=Boolean(direction.draft&&direction.draft.sourceVersion===direction.source.sourceVersion||direction.draft&&!direction.draft.sourceVersion);
  const independentDirectionLimit=direction.status!=='CONFIRMED'&&!hasDirectionCandidate&&!direction.generationPlan.allowed?direction.generationPlan.reason:null;
  const directionSupplement=direction.status!=='CONFIRMED'&&!hasDirectionCandidate&&!direction.generation?.held&&direction.foundationPreparation?.status==='NEEDS_SUPPLEMENT'
   ? '第一阶段正确资料已保存，但方向候选待补。可手工完善，或明确发起额外方向分析；未自动重读全剧。' : null;
  return {sourceVersion:productionWorkflowSourceVersion(input),availableEpisodes,canPrepareSource:!availableEpisodes.length&&stage1.action==='START',sourceConflicts,technicalIssues,
   standard:{ready:issues.length===0&&workflow.episodeNumbers.every(n=>availableEpisodes.includes(n)),issues},
   stage1:{ready:Boolean(stage1.complete),busy:Boolean(stage1.busy),blocker:stage1Blocker,userConfirmation,taskId:stage1.task?.id??null,requiredChoices:requiredChoices.map((c:Row)=>({id:c.id,question:c.question}))},
   direction:{status:direction.status,hasCandidate:hasDirectionCandidate,pending:Boolean(direction.generation?.pending),
    generationId:direction.generation?.id??null,settledKnown:direction.generation?.status==='FAILED'&&!direction.generation.pending&&direction.generation.usage?.unknownCalls===0&&Boolean(direction.generation.callUsage?.length),
    blocker:direction.source.blocker??independentDirectionLimit??(direction.generation?.held&&!direction.generation.pending&&!direction.generation.resumable?(direction.generation.recoveryIssue??'方向调用已停止，需核对已有回包与用量；未自动重发。'):null)??directionSupplement,brief:direction.brief??direction.draftBrief??null},assets,runs};
 };
 return {inspect,readRun,withBudget:withProductionBudgetContext,
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
  onSelectionChanged:(workflow:ProductionWorkflow)=>services.refreshChain(workflow.projectId),
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
    const productionChain:ProductionChain={id:workflow.id,mode:workflow.mode,selectionRevision:workflow.selectionRevision,selectedRuns:workflow.selectedRuns,episodeNumbers:workflow.episodeNumbers};
    const run=await services.createStoryboard(episode!,{productionBudget:context.budget,productionChain});
    await context.bind({runId:run.id,episodeNumber:action.episodeNumber});await check();
    await services.startStoryboard(run.id);return {status:'RUN_STARTED',runId:run.id};
   }
   if(action.kind==='STORYBOARD_CONTINUE'){
    const run=await readRun(action.runId,workflow);
    if(run.productionBudget?.id!==workflow.budgetId||path.resolve(run.productionBudget?.directory??'')!==path.resolve(context.budget.directory)||run.productionChain?.id!==workflow.id)fail('WORKFLOW_RUN_BUDGET','已有版本未绑定本流程共享预算，不能在此入口继续付费；已完成稿仍可被选用。');
    if(run.sourceStale||run.continuityPending||run.blocked&&!run.canAutoRepair)fail('WORKFLOW_RUN_NOT_READY','已有版本需要先核对承接或回执，未启动新的付费动作。');
    await context.bind({runId:run.id,episodeNumber:run.episodeNumber});await services.startStoryboard(run.id);return {status:'RUN_STARTED',runId:run.id};
   }
   return fail('WORKFLOW_ACTION','未知流程动作。',400);
  }
 };
}

async function authorizedService(projectId:string,actorId:string){
 const {prisma}=await import('./prisma');
 if(!actorId)fail('UNAUTHORIZED','请先登录。',401);
 const membership=await prisma.projectRole.findFirst({where:{projectId,userId:actorId},select:{id:true}});
 if(!membership)fail('WORKFLOW_FORBIDDEN','没有此项目的访问权限。',403);
 return workflowRuntime.createProductionWorkflowService({directory:productionWorkflowRoot,budgetDirectory:productionBudgetRoot,adapters:createProductionWorkflowAdapters(actorId,await productionServices())});
}

/** Registry only: no DB read, reconciliation, provider or background dispatch. */
export async function getProductionChain(id:string,projectId:string):Promise<ProductionChain>{
 const workflow=await createStore(productionWorkflowRoot).read(id);
 if(workflow.schema!=='PRODUCTION_WORKFLOW_V1'||workflow.projectId!==projectId)fail('WORKFLOW_SCOPE','流程不属于当前项目。');
 return {id:workflow.id,mode:workflow.mode,selectionRevision:workflow.selectionRevision,selectedRuns:workflow.selectedRuns,episodeNumbers:workflow.episodeNumbers};
}

/** Same durable gate as selection/bind; only short agreement IO inside the callback. */
export async function withChainSelection<T>(id:string,projectId:string,action:(chain:ProductionChain)=>Promise<T>):Promise<T>{
 return createStore(productionWorkflowRoot).withLockedRead(id,(workflow:Row)=>{
  if(workflow.schema!=='PRODUCTION_WORKFLOW_V1'||workflow.projectId!==projectId)fail('WORKFLOW_SCOPE','流程不属于当前项目。');
  return action({id:workflow.id,mode:workflow.mode,selectionRevision:workflow.selectionRevision,selectedRuns:workflow.selectedRuns,episodeNumbers:workflow.episodeNumbers});
 });
}

export async function getProductionWorkflow(projectId:string,actorId:string,workflowId?:string|null){
 const service=await authorizedService(projectId,actorId);
 if(!workflowId)return {workflows:await service.list(projectId)};
 const workflow=await service.read(workflowId);if(workflow.projectId!==projectId)fail('WORKFLOW_SCOPE','流程不属于当前项目。',403);
 return service.inspect(workflowId);
}
export async function mutateProductionWorkflow(projectId:string,actorId:string,command:ProductionWorkflowCommand){
 const service=await authorizedService(projectId,actorId);
 if(command.action==='create')return service.create({projectId,actorId,episodeNumbers:command.episodeNumbers,mode:command.mode,criticalAssetKeys:command.criticalAssetKeys,requestedAssetKeys:command.requestedAssetKeys,budgetId:command.budgetId,costAcknowledged:command.costAcknowledged,maxCalls:command.maxCalls,maxTokens:command.maxTokens});
 if(typeof command.workflowId!=='string')fail('WORKFLOW_INPUT','缺少流程编号。',400);
 const workflow=await service.read(command.workflowId);if(workflow.projectId!==projectId)fail('WORKFLOW_SCOPE','流程不属于当前项目。',403);
 const input={...command,actorId};
 switch(command.action){
  case 'advance':return service.advance(command.workflowId,input);
  case 'pause':return service.pause(command.workflowId,input);
  case 'resume':return service.resume(command.workflowId,input);
  case 'recover':return service.recover(command.workflowId,input);
  case 'select-run':return service.selectRun(command.workflowId,input);
  case 'quality-review':return service.recordQualityReview(command.workflowId,input);
  case 'request-materials':return service.requestMaterials(command.workflowId,input);
  default:return fail('WORKFLOW_ACTION','未知流程操作。',400);
 }
}
export function productionWorkflowFailure(error:unknown){
 const value=error as {status?:number;code?:string;message?:string},known=value?.code?.startsWith('WORKFLOW_')||value?.code?.startsWith('PRODUCTION_');
 const status=value?.status??(value?.code==='ENOENT'?404:value?.code==='INVALID_ID'?400:known?409:500);
 return {status,body:{code:value?.code??'WORKFLOW_ERROR',error:status===500?'流程检查或保存暂未完成，已有记录保留，请核对后重试。':value?.message??'流程操作暂不能完成。'}};
}
