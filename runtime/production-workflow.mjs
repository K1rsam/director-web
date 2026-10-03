import {randomUUID} from 'node:crypto';
import {readdir} from 'node:fs/promises';
import {hostname} from 'node:os';
import path from 'node:path';
import {createStore} from './storyboard-v4/core/store.mjs';
import {createProductionBudgetStore} from './production-budget.mjs';

export const PRODUCTION_WORKFLOW_VERSION='PRODUCTION_WORKFLOW_V1';
const paid=new Set(['STAGE1','DIRECTION','ASSETS','STORYBOARD_CREATE','STORYBOARD_CONTINUE']);
const runningActions=new Set();
const now=()=>new Date().toISOString();
const fail=(code,message)=>{throw Object.assign(new Error(message),{code,requestOutcome:'NOT_SENT'});};
const keys=value=>Array.isArray(value)&&value.every(x=>typeof x==='string'&&x.length>0&&x.length<=200)?[...new Set(value)]:fail('WORKFLOW_INPUT','材料键列表无效。');
const episodes=value=>Array.isArray(value)&&value.length&&value.length<=500&&value.every(x=>Number.isSafeInteger(x)&&x>=0)?[...new Set(value)].sort((a,b)=>a-b):fail('WORKFLOW_INPUT','请选择有效的生产集数。');
const wait=(kind,message,owner='EXECUTOR',extra={})=>({kind,message,owner,...extra});
const isCurrentReview=(workflow,run)=>workflow.qualityReviews.some(r=>r.runId===run.id&&r.fingerprint===run.fingerprint&&r.episodeNumber===workflow.episodeNumbers[0]);
const check=d=>{if(d.schema!==PRODUCTION_WORKFLOW_VERSION)fail('WORKFLOW_SCHEMA','流程记录版本不可识别。');return d;};
const checkRevision=(d,revision)=>{if(!Number.isSafeInteger(revision)||revision!==d.revision)fail('WORKFLOW_CONFLICT','流程已更新，请刷新后再操作。');};
const publicBudget=d=>({id:d.id,projectIds:d.projectIds,maxCalls:d.maxCalls,maxTokens:d.maxTokens,paused:d.paused,summary:d.summary});
const sameRefs=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.every(x=>typeof x==='string')&&b.every(x=>typeof x==='string')&&JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const currentMaterialNeed=(workflow,snapshot,need)=>Object.values(workflow.selectedRuns).includes(need.runId)&&snapshot.runs?.[need.runId]?.needs?.some(n=>n.resolved!==true&&n.stage===2&&n.target===need.target&&sameRefs(n.sourceRefs,need.sourceRefs)&&sameRefs(n.packageIds,need.packageIds));

function chooseNext(workflow,snapshot,budgetDirectory){
 if(workflow.paused)return wait('WAIT_PAUSED','流程已暂停；已发送的请求仍保留原回执。');
 if(workflow.activeAction)return wait(workflow.status==='INTERRUPTED'?'WAIT_RECOVERY':'WAIT_RUNNING','已有动作已登记；先读取结果或恢复，不能重复派单。','EXECUTOR',{actionId:workflow.activeAction.id});
 if(snapshot.sourceConflicts?.length)return wait('WAIT_SOURCE_CONFLICT','真实源文存在冲突，需用户裁定。','USER',{issues:snapshot.sourceConflicts});
 if(snapshot.sourceVersion!==workflow.sourceVersion)return wait('WAIT_SOURCE_CHANGED','源稿版本已变更，旧流程与已选版本均保留；请按新源另建流程。','USER');
 if(snapshot.stage1?.busy)return wait('WAIT_STAGE1','基础处理正在进行，查询不会派单。');
 if(snapshot.stage1?.blocker)return wait(snapshot.stage1.userConfirmation?'WAIT_SOURCE_CONFIRM':'WAIT_STAGE1_REPAIR',snapshot.stage1.blocker,snapshot.stage1.userConfirmation?'USER':'EXECUTOR');
 if(!snapshot.stage1?.ready)return {kind:'STAGE1',owner:'EXECUTOR'};
 if(workflow.episodeNumbers.some(n=>!snapshot.availableEpisodes?.includes(n)))return wait('WAIT_SCOPE','标准处理后仍未找到全部所选集数；保留范围，不自动略过或改选。','EXECUTOR');
 if(!snapshot.standard?.ready)return wait('WAIT_STANDARD_SCRIPT','标准稿仍有待处理问题，先处理对应原文节点。','EXECUTOR',{issues:snapshot.standard?.issues??snapshot.technicalIssues??[]});
 if(snapshot.direction?.pending)return wait('WAIT_DIRECTION','全剧方向候选正在生成，查询不会重复请求。');
 if(snapshot.direction?.blocker)return wait('WAIT_DIRECTION_REPAIR',snapshot.direction.blocker);
 if(snapshot.direction?.status!=='CONFIRMED')return snapshot.direction?.hasCandidate
  ?wait('WAIT_DIRECTION_CONFIRM','全剧方向候选已备好，等待用户明确确认。','USER')
  :{kind:'DIRECTION',owner:'EXECUTOR'};
 if(snapshot.assets?.busy)return wait('WAIT_ASSETS','选定材料正在处理。');
 if(snapshot.assets?.blocker)return wait('WAIT_ASSET_REPAIR',snapshot.assets.blocker);
 const pendingMaterials=(workflow.materialRequests??[]).filter(r=>r.status==='REQUESTED');
 if(pendingMaterials.some(r=>r.needs.some(n=>!currentMaterialNeed(workflow,snapshot,n))))return wait('WAIT_MATERIAL_REQUEST_STALE','补料所依赖的选定版本或需求坐标已变化；先恢复检查，不照旧需求付费。');
 const missingCandidates=(snapshot.assets?.missingCandidateKeys??[]).filter(key=>workflow.requestedAssetKeys.includes(key));
 if(pendingMaterials.length){const materialNeeds=pendingMaterials.flatMap(r=>r.needs.map((n,index)=>({...n,workflowId:workflow.id,requestId:r.id,needRef:`${r.id}:${index}`,episodeNumber:snapshot.runs[n.runId].episodeNumber,workflowSourceVersion:workflow.sourceVersion})));return {kind:'ASSETS',assetKeys:[...new Set([...missingCandidates,...materialNeeds.map(n=>n.target)])],materialNeeds,materialRequestIds:pendingMaterials.map(r=>r.id),owner:'EXECUTOR'};}
 if(missingCandidates.length)return {kind:'ASSETS',assetKeys:missingCandidates,owner:'EXECUTOR'};
 const missingCritical=(snapshot.assets?.missingCriticalKeys??[]).filter(key=>workflow.criticalAssetKeys.includes(key));
 if(missingCritical.length)return wait('WAIT_DESIGN_CONFIRM','指定关键设计尚未采用；图片不是必需项。','USER',{assetKeys:missingCritical});
 for(const episodeNumber of workflow.episodeNumbers){
  const runId=workflow.selectedRuns[episodeNumber];
  if(!runId)return {kind:'STORYBOARD_CREATE',episodeNumber,owner:'EXECUTOR'};
  const run=snapshot.runs?.[runId];
  if(!run)return wait('WAIT_RUN_RECOVERY','已选分镜版本暂不可读取，不能另建版本代替。','EXECUTOR',{episodeNumber,runId});
  if(run.busy)return wait('WAIT_STORYBOARD','当前集正在加工，完成后可继续下一动作。','EXECUTOR',{episodeNumber,runId});
  if(run.sourceStale)return wait('WAIT_RUN_SOURCE','已选分镜与当前硬源不符，保留结果并局部核对。','EXECUTOR',{episodeNumber,runId});
  if(run.canAutoRepair&&run.productionChain?.id===workflow.id&&run.productionChain?.mode===workflow.mode&&run.productionBudget?.id===workflow.budgetId&&typeof run.productionBudget?.directory==='string'&&path.resolve(run.productionBudget.directory)===path.resolve(budgetDirectory))return {kind:'STORYBOARD_CONTINUE',episodeNumber,runId,owner:'EXECUTOR'};
  if(run.blocked)return wait(run.needUpstream?'NEED_UPSTREAM':'WAIT_EXECUTOR_REPAIR',run.message||'已有版本需要对应局部处理。','EXECUTOR',{episodeNumber,runId,needs:run.needs??[]});
  if(run.continuityPending)return wait('WAIT_CONTINUITY','本集正文已保存，尚未与所选前集实际尾稿完成承接核对；先补齐证据，不重复启动制作。','EXECUTOR',{episodeNumber,runId});
  if(!run.complete)return {kind:'STORYBOARD_CONTINUE',episodeNumber,runId,owner:'EXECUTOR'};
  if(episodeNumber===workflow.episodeNumbers[0]&&!isCurrentReview(workflow,run))return wait('QUALITY_CHECK','执行者需复核首集主创与整编，并记录主要问题已解决；不要求用户逐集审批。','EXECUTOR',{episodeNumber,runId,fingerprint:run.fingerprint});
 }
 return {kind:'COMPLETE',owner:'EXECUTOR',message:'选集分镜已完成机械交付且首集已留有执行者质量复核；不代表成片或用户验收。'};
}

/** No timers or autonomous loop: one explicit advance dispatches at most one service action. */
export function createProductionWorkflowService({directory,budgetDirectory,adapters}){
 if(!directory||!budgetDirectory||typeof adapters?.inspect!=='function'||typeof adapters?.run!=='function'||typeof adapters?.withBudget!=='function')fail('WORKFLOW_CONFIG','流程必须配置持久目录、共享预算及执行适配器。');
 const store=createStore(directory),ledger=createProductionBudgetStore(budgetDirectory);
 const read=async id=>check(await store.read(id));
 const update=(id,revision,mutator)=>store.update(id,d=>{check(d);checkRevision(d,revision);const next=mutator(d);next.revision=d.revision+1;next.updatedAt=now();return next;});
 const updateAction=(id,actionId,mutator)=>store.update(id,d=>{check(d);if(d.activeAction?.id!==actionId)fail('WORKFLOW_ACTION_CHANGED','动作记录已变化，未覆盖已有结果。');const next=mutator(d);next.revision=d.revision+1;next.updatedAt=now();return next;});
 const inspect=async id=>{
  const workflow=await read(id),snapshot=await adapters.inspect(workflow),budget=publicBudget(await ledger.read(workflow.budgetId));
  let nextAction=chooseNext(workflow,snapshot,budgetDirectory);
  if(paid.has(nextAction.kind)){
   if(!workflow.costAcknowledged)nextAction=wait('WAIT_COST_CONFIRM','继续将使用共享付费预算，请明确确认费用边界。','USER',{proposedAction:nextAction});
   else if(budget.paused||budget.summary.unknownAttempts||budget.summary.calls>=budget.maxCalls||budget.summary.knownTokens>=budget.maxTokens)nextAction=wait('WAIT_BUDGET','共享预算已暂停、到达停止线或存在未知用量；先核对回执，不自动扩大预算。','USER',{proposedAction:nextAction});
  }
  const keyDesignGate=!workflow.criticalAssetKeys.length?'NOT_SPECIFIED':(snapshot.assets?.missingCriticalKeys??[]).some(k=>workflow.criticalAssetKeys.includes(k))?'WAITING_CONFIRMATION':'CONFIRMED';
  return {workflow,readiness:{sourceVersion:snapshot.sourceVersion,standard:snapshot.standard,stage1:snapshot.stage1,direction:snapshot.direction,assets:snapshot.assets,runs:snapshot.runs??{},sourceConflicts:snapshot.sourceConflicts??[],technicalIssues:snapshot.technicalIssues??[],keyDesignGate},keyDesignGate,nextAction,budget};
 };
 const notifySelection=async workflow=>{if(adapters.onSelectionChanged)await adapters.onSelectionChanged(workflow);};
 const service={
  read,inspect,
  async list(projectId){
   const files=await readdir(path.join(directory,'documents')).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e));
   const documents=await Promise.all(files.filter(f=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(f)).map(f=>read(f.slice(0,-5))));
   return documents.filter(d=>d.projectId===projectId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  },
  async create(input){
   if(typeof input.projectId!=='string'||!input.projectId||typeof input.actorId!=='string'||!input.actorId)fail('WORKFLOW_INPUT','项目与执行者身份不可缺失。');
   const episodeNumbers=episodes(input.episodeNumbers),mode=input.mode??'CHAIN';
   if(!['CHAIN','SINGLE'].includes(mode)||mode==='SINGLE'&&episodeNumbers.length!==1)fail('WORKFLOW_INPUT','单集流程必须只选择一集。');
   const criticalAssetKeys=keys(input.criticalAssetKeys??[]),requestedAssetKeys=keys(input.requestedAssetKeys??criticalAssetKeys);
   if(criticalAssetKeys.some(k=>!requestedAssetKeys.includes(k)))fail('WORKFLOW_INPUT','指定关键设计必须包含在请求材料范围内。');
   const workflow={schema:PRODUCTION_WORKFLOW_VERSION,id:randomUUID(),projectId:input.projectId,actorId:input.actorId,episodeNumbers,mode,criticalAssetKeys,requestedAssetKeys,budgetId:input.budgetId??randomUUID(),sourceVersion:null,revision:0,selectionRevision:0,selectedRuns:{},qualityReviews:[],selectionHistory:[],materialRequests:[],receipts:[],activeAction:null,status:'READY',paused:false,costAcknowledged:input.costAcknowledged===true,createdAt:now(),updatedAt:now()};
   const snapshot=await adapters.inspect(workflow);
   if(typeof snapshot.sourceVersion!=='string'||!snapshot.sourceVersion)fail('WORKFLOW_SOURCE','源稿版本不可确定，未创建可派单流程。');
   if(episodeNumbers.some(n=>!snapshot.availableEpisodes?.includes(n))&&!(snapshot.canPrepareSource&&!snapshot.stage1?.ready))fail('WORKFLOW_SCOPE','所选集数不在当前可生产范围。');
   workflow.sourceVersion=snapshot.sourceVersion;
   if(input.budgetId){const budget=await ledger.read(input.budgetId);if(!budget.projectIds.includes(input.projectId))fail('WORKFLOW_BUDGET_SCOPE','项目不在该共享预算范围内。');}
   else{
    const maxCalls=input.maxCalls??40,maxTokens=input.maxTokens??2000000;
    if(!Number.isSafeInteger(maxCalls)||maxCalls<0||maxCalls>40||!Number.isSafeInteger(maxTokens)||maxTokens<0||maxTokens>2000000)fail('WORKFLOW_BUDGET_LIMIT','此入口只允许收紧默认 40 次 / 200 万 Token 停止线，不自动扩大用户预算。');
    await ledger.create(workflow.budgetId,{projectIds:[workflow.projectId],maxCalls,maxTokens});
   }
   await store.create(workflow.id,workflow);return inspect(workflow.id);
  },
  async advance(id,command){
   let view=await inspect(id);checkRevision(view.workflow,command.expectedRevision);
   if(command.costAcknowledged===true&&!view.workflow.costAcknowledged){await update(id,command.expectedRevision,d=>({...d,costAcknowledged:true}));view=await inspect(id);}
   const action=view.nextAction;if(!paid.has(action.kind))return view;
   const actionId=randomUUID(),startedAt=now();
   const dispatched=await update(id,view.workflow.revision,d=>({...d,status:'RUNNING',activeAction:{...action,id:actionId,startedAt,pid:process.pid,host:hostname()},receipts:[...d.receipts,{id:actionId,kind:action.kind,episodeNumber:action.episodeNumber??null,status:'RUNNING',startedAt}]}));
   const bind=async binding=>{
    const changed=await updateAction(id,actionId,d=>{
     const receipt=d.receipts.find(r=>r.id===actionId);Object.assign(receipt,binding);Object.assign(d.activeAction,binding);
     if(binding.runId){
      if(!d.episodeNumbers.includes(binding.episodeNumber)||typeof binding.runId!=='string')fail('WORKFLOW_RUN_SCOPE','分镜版本绑定超出选集范围。');
      if(d.selectedRuns[binding.episodeNumber]!==binding.runId){d.selectedRuns[binding.episodeNumber]=binding.runId;d.selectionRevision++;d.selectionHistory.push({episodeNumber:binding.episodeNumber,runId:binding.runId,selectionRevision:d.selectionRevision,actorId:command.actorId,at:now()});}
     }
     return d;
    });
    if(binding.runId)await notifySelection(changed);return changed;
   };
   const runningKey=`${path.resolve(directory)}:${actionId}`;runningActions.add(runningKey);
   try{
    const result=await adapters.withBudget({id:dispatched.budgetId,directory:budgetDirectory},()=>adapters.run(action,dispatched,{bind,budget:{id:dispatched.budgetId,directory:budgetDirectory},isPaused:async()=>Boolean((await read(id)).paused)}));
    await updateAction(id,actionId,d=>{
     const receipt=d.receipts.find(r=>r.id===actionId);Object.assign(receipt,{status:['STAGE1','DIRECTION'].includes(action.kind)&&['PARTIAL','WAITING_USER'].includes(result?.status)?result.status:'SUCCEEDED',finishedAt:now(),result:result??null});
     if(action.kind==='STAGE1'&&result?.status==='COMPLETE'&&typeof result.sourceVersion==='string'&&result.sourceVersion!==d.sourceVersion){receipt.sourceTransition={before:d.sourceVersion,after:result.sourceVersion,reason:'AUTHORIZED_STAGE1_PREPARATION'};d.sourceVersion=result.sourceVersion;}
     if(action.kind==='ASSETS')for(const request of d.materialRequests??[])if(action.materialRequestIds?.includes(request.id)){request.status='CANDIDATES_SAVED';request.receiptId=actionId;request.finishedAt=now();}
     d.activeAction=null;d.status='READY';return d;
    });
   }catch(error){
    await updateAction(id,actionId,d=>{Object.assign(d.receipts.find(r=>r.id===actionId),{status:'INTERRUPTED',finishedAt:now(),error:{code:error?.code??'WORKFLOW_ACTION_FAILED',message:String(error?.message??'动作中断').slice(0,1200),requestOutcome:error?.requestOutcome??'UNKNOWN'}});d.status='INTERRUPTED';return d;});
   }finally{runningActions.delete(runningKey);}
   return inspect(id);
  },
  async recover(id,command){
   const workflow=await read(id);checkRevision(workflow,command.expectedRevision);
   if(!workflow.activeAction){
    const snapshot=await adapters.inspect(workflow),outdated=(workflow.materialRequests??[]).filter(r=>r.status==='REQUESTED'&&r.needs.some(n=>!currentMaterialNeed(workflow,snapshot,n)));
    if(outdated.length)await update(id,command.expectedRevision,d=>{for(const request of d.materialRequests??[])if(outdated.some(r=>r.id===request.id)){request.status='NO_LONGER_CURRENT';request.finishedAt=now();}return d;});
    return inspect(id);
   }
   if(runningActions.has(`${path.resolve(directory)}:${workflow.activeAction.id}`))return inspect(id);
   if(workflow.status==='RUNNING'&&workflow.activeAction.host===hostname()&&workflow.activeAction.pid!==process.pid){try{process.kill(workflow.activeAction.pid,0);return inspect(id);}catch(error){if(error.code!=='ESRCH')return inspect(id);}}
   const snapshot=await adapters.inspect(workflow),action=workflow.activeAction;
   const receipt=workflow.receipts.find(r=>r.id===action.id);
   const budget=await ledger.read(workflow.budgetId);
   const directionStopped=action.kind==='DIRECTION'&&typeof action.directionGenerationId==='string'&&action.directionGenerationId===snapshot.direction?.generationId
    &&snapshot.direction?.settledKnown===true&&!snapshot.direction.pending&&!budget.summary.unknownAttempts&&!budget.summary.inFlight;
   const stage1Recovered=action.kind==='STAGE1'&&snapshot.stage1?.ready&&(snapshot.sourceVersion===workflow.sourceVersion||Boolean(action.taskId&&snapshot.stage1.taskId===action.taskId));
   // Preserve legacy unbound actions, but a recorded generation cannot be
   // replaced by a newer candidate from another window while recovering.
   const directionMatches=typeof action.directionGenerationId!=='string'||action.directionGenerationId===snapshot.direction?.generationId;
   const recovered=Boolean(adapters.recoverAction&&await adapters.recoverAction(workflow,action,snapshot))||stage1Recovered
    ||action.kind==='DIRECTION'&&directionMatches&&!snapshot.direction?.pending&&(snapshot.direction?.hasCandidate||snapshot.direction?.status==='CONFIRMED')
    ||action.kind==='ASSETS'&&!action.materialRequestIds?.length&&Array.isArray(snapshot.assets?.missingCandidateKeys)&&action.assetKeys.every(k=>!snapshot.assets.missingCandidateKeys.includes(k))
    ||action.kind.startsWith('STORYBOARD_')&&Boolean(snapshot.runs?.[action.runId??workflow.selectedRuns[action.episodeNumber]]);
   if(recovered||directionStopped||receipt?.error?.requestOutcome==='NOT_SENT'){
    const changed=await update(id,command.expectedRevision,d=>{
     const entry=d.receipts.find(r=>r.id===action.id);Object.assign(entry,{status:directionStopped?'PARTIAL':recovered?'RECOVERED':'NOT_SENT',recoveredAt:now()});
     if(stage1Recovered&&snapshot.sourceVersion!==d.sourceVersion){entry.sourceTransition={before:d.sourceVersion,after:snapshot.sourceVersion,taskId:action.taskId,reason:'RECOVERED_AUTHORIZED_STAGE1_PREPARATION'};d.sourceVersion=snapshot.sourceVersion;}
     if(recovered&&action.kind==='ASSETS')for(const request of d.materialRequests??[])if(action.materialRequestIds?.includes(request.id)){request.status='CANDIDATES_SAVED';request.receiptId=action.id;request.finishedAt=now();}
     d.activeAction=null;d.status='READY';return d;
    });
    if(recovered&&action.kind==='ASSETS')await notifySelection(changed);
   }
   else if(workflow.status!=='INTERRUPTED')await update(id,command.expectedRevision,d=>({...d,status:'INTERRUPTED'}));
   return inspect(id);
  },
  async pause(id,command){const changed=await update(id,command.expectedRevision,d=>({...d,paused:true}));if(adapters.onPause)await adapters.onPause(changed);return inspect(id);},
  async resume(id,command){await update(id,command.expectedRevision,d=>({...d,paused:false}));return inspect(id);},
  async selectRun(id,command){
   const workflow=await read(id);checkRevision(workflow,command.expectedRevision);
   if(workflow.activeAction)fail('WORKFLOW_BUSY','当前动作尚未落定，先恢复其回执再切换版本。');
   if(!workflow.episodeNumbers.includes(command.episodeNumber))fail('WORKFLOW_RUN_SCOPE','该集不在流程选集范围。');
   const run=await adapters.readRun(command.runId,workflow);
   if(!run||run.projectId!==workflow.projectId||run.episodeNumber!==command.episodeNumber)fail('WORKFLOW_RUN_SCOPE','分镜版本不属于当前项目与集数。');
   const changed=await update(id,command.expectedRevision,d=>{if(d.selectedRuns[command.episodeNumber]!==command.runId){d.selectedRuns[command.episodeNumber]=command.runId;d.selectionRevision++;d.selectionHistory.push({episodeNumber:command.episodeNumber,runId:command.runId,selectionRevision:d.selectionRevision,actorId:command.actorId,at:now()});}return d;});
   await notifySelection(changed);return inspect(id);
  },
  async requestMaterials(id,command){
   const workflow=await read(id);checkRevision(workflow,command.expectedRevision);
   if(workflow.activeAction)fail('WORKFLOW_BUSY','先恢复当前动作回执，再登记补料需求。');
   if(!Array.isArray(command.needs)||!command.needs.length||command.needs.length>50)fail('WORKFLOW_MATERIAL_NEED','补料必须引用当前结构化需求与坐标。');
   const snapshot=await adapters.inspect(workflow),needs=command.needs.map(request=>{
    if(!request||!currentMaterialNeed(workflow,snapshot,request))fail('WORKFLOW_MATERIAL_NEED','补料需求已变化或不属于当前选定分镜，不按猜测目标派单。');
    if(snapshot.runs[request.runId].busy)fail('WORKFLOW_MATERIAL_BUSY','该需求的分镜仍在执行，先等现有动作落定。');
    const exact=snapshot.runs[request.runId].needs.find(n=>n.resolved!==true&&n.stage===2&&n.target===request.target&&sameRefs(n.sourceRefs,request.sourceRefs)&&sameRefs(n.packageIds,request.packageIds));
    return {runId:request.runId,...exact};
   });
   if((workflow.materialRequests??[]).some(r=>r.status==='REQUESTED'&&r.needs.some(n=>needs.some(v=>JSON.stringify(n)===JSON.stringify(v)))))fail('WORKFLOW_MATERIAL_PENDING','该补料需求已经登记，无需重复添加。');
   if(typeof adapters.validateMaterialRequest!=='function')fail('WORKFLOW_MATERIAL_TARGET','当前适配器尚不能定位该需求材料。');
   await adapters.validateMaterialRequest(workflow,needs);
   await update(id,command.expectedRevision,d=>({...d,materialRequests:[...(d.materialRequests??[]),{id:randomUUID(),status:'REQUESTED',needs,actorId:command.actorId,requestedAt:now()}]}));
   return inspect(id);
  },
  async recordQualityReview(id,command){
   const workflow=await read(id);checkRevision(workflow,command.expectedRevision);
   const first=workflow.episodeNumbers[0],run=await adapters.readRun(command.runId,workflow);
   if(command.authorReviewed!==true||command.assemblyReviewed!==true||command.majorIssuesResolved!==true||typeof command.note!=='string'||!command.note.trim()||command.note.length>4000||workflow.selectedRuns[first]!==command.runId||!run?.complete||run.busy||run.blocked||run.sourceStale||!run.fingerprint)fail('WORKFLOW_QUALITY_REVIEW','质量复核必须对应已选首集成稿，并确认主创、整编及主要问题已解决。');
   await update(id,command.expectedRevision,d=>({...d,qualityReviews:[...d.qualityReviews,{episodeNumber:first,runId:run.id,fingerprint:run.fingerprint,authorReviewed:true,assemblyReviewed:true,majorIssuesResolved:true,note:command.note.trim(),actorId:command.actorId,at:now()}]}));
   return inspect(id);
  },
  async getProductionChain(id,projectId){const d=await read(id);if(d.projectId!==projectId)fail('WORKFLOW_SCOPE','流程不属于当前项目。');return {id:d.id,mode:d.mode,selectionRevision:d.selectionRevision,selectedRuns:d.selectedRuns,episodeNumbers:d.episodeNumbers};}
 };
 return service;
}
