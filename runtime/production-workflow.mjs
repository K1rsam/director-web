import {assertSeasonEpisodes,assertSeasonBinding,seasonHash,seasonDurationException} from './season-scope.mjs';
import {randomUUID} from 'node:crypto';
import {readdir,readFile,lstat} from 'node:fs/promises';
import {hostname} from 'node:os';
import path from 'node:path';
import {createStore} from './storyboard-v4/core/store.mjs';
import {createProductionBudgetStore} from './production-budget.mjs';
import {DEFAULT_EPISODE_BUDGET,EPISODE_TOKEN_WARNING,PRODUCTION_LIMIT_POLICY,recommendedWorkflowBudget,productionModelSelection,PRODUCTION_PARALLEL_VERSION,productionLaneCount,productionParallelLaneCount} from './production-policy.mjs';
import {writeProductionDelivery,productionDeliveryFingerprint} from './production-delivery.mjs';

export const PRODUCTION_WORKFLOW_VERSION='PRODUCTION_WORKFLOW_V1';
const paid=new Set(['STAGE1','DIRECTION','ASSETS','STORYBOARD_CREATE','STORYBOARD_CONTINUE']);
const runningActions=new Set();
const parallelPumps=globalThis[Symbol.for('director.production.parallel-pumps')]??=new Map();
const parallelLane=Symbol('parallel-lane');
const savedRunRecovery=Symbol('saved-run-recovery');
const provenAdmissionReadError=(action,error)=>['STORYBOARD_CREATE','STORYBOARD_CONTINUE'].includes(action?.kind)&&error?.requestOutcome==='NOT_SENT'&&error.retryableRead===true
 &&['CONTEXT_UNAVAILABLE','P1008','P2028','SQLITE_BUSY','SQLITE_LOCKED','DATABASE_READ_UNAVAILABLE'].includes(error.code);
// A created-but-unsent run is resumed, never recreated. Paid/nonempty runs retain their existing recovery gates.
const reconnectableCreate=(action,error,view,budgetDirectory)=>{
 if(!provenAdmissionReadError(action,error))return false;
 if(!action.runId)return action.kind==='STORYBOARD_CREATE';
 const workflow=view?.workflow,run=view?.readiness?.runs?.[action.runId];
 return Boolean(workflow&&run?.emptyAdmission===true&&run.id===action.runId&&run.projectId===workflow.projectId&&run.episodeNumber===action.episodeNumber
  &&workflow.selectedRuns[action.episodeNumber]===action.runId&&run.productionChain?.id===workflow.id&&run.productionChain?.mode===workflow.mode
  &&run.productionBudget?.id===workflow.budgetId&&typeof run.productionBudget.directory==='string'&&path.resolve(run.productionBudget.directory)===path.resolve(budgetDirectory));
};
const now=()=>new Date().toISOString();
const fail=(code,message)=>{throw Object.assign(new Error(message),{code,requestOutcome:'NOT_SENT'});};
export function assertPaidRepairPolicy(workflow){
 if(workflow.paidRepairPolicy?.version!=='paid-repair-consent-v1'||workflow.paidRepairPolicy.automatic!==true)
  fail('PAID_REPAIR_NOT_AUTHORIZED','已有付费回包保留；未单独授权额外付费补正。请先免费核验或恢复，不自动重发。');
}
const keys=value=>Array.isArray(value)&&value.every(x=>typeof x==='string'&&x.length>0&&x.length<=200)?[...new Set(value)]:fail('WORKFLOW_INPUT','材料键列表无效。');
const episodes=value=>Array.isArray(value)&&value.length&&value.length<=500&&value.every(x=>Number.isSafeInteger(x)&&x>=0)?[...new Set(value)].sort((a,b)=>a-b):fail('WORKFLOW_INPUT','请选择有效的生产集数。');
const wait=(kind,message,owner='EXECUTOR',extra={})=>({kind,message,owner,...extra});
const isCurrentReview=(workflow,run)=>workflow.qualityReviews.some(r=>r.runId===run.id&&r.fingerprint===run.fingerprint&&r.episodeNumber===workflow.episodeNumbers[0]);
const check=d=>{if(d.schema!==PRODUCTION_WORKFLOW_VERSION)fail('WORKFLOW_SCHEMA','流程记录版本不可识别。');return d;};
const checkRevision=(d,revision)=>{if(!Number.isSafeInteger(revision)||revision!==d.revision)fail('WORKFLOW_CONFLICT','流程已更新，请刷新后再操作。');};
const publicBudget=d=>({id:d.id,projectIds:d.projectIds,maxCalls:d.maxCalls,maxTokens:d.maxTokens,paused:d.paused,summary:d.summary});
const sameRefs=(a,b)=>Array.isArray(a)&&Array.isArray(b)&&a.every(x=>typeof x==='string')&&b.every(x=>typeof x==='string')&&JSON.stringify([...a].sort())===JSON.stringify([...b].sort());
const currentMaterialNeed=(workflow,snapshot,need)=>Object.values(workflow.selectedRuns).includes(need.runId)&&snapshot.runs?.[need.runId]?.needs?.some(n=>n.resolved!==true&&n.stage===2&&n.target===need.target&&sameRefs(n.sourceRefs,need.sourceRefs)&&sameRefs(n.packageIds,need.packageIds));
const runBudget=value=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==2||!Number.isSafeInteger(value.maxCalls)||value.maxCalls<0||value.maxCalls>128||!Number.isSafeInteger(value.maxTokens)||value.maxTokens<0||value.maxTokens>2000000)fail('WORKFLOW_PARALLEL_BUDGET','四路单集停止线须完整且符合内核范围，未改变已有任务。');
 return {maxCalls:value.maxCalls,maxTokens:value.maxTokens};
};

export function partitionProductionLanes(numbers,laneCount=4,sourceOrder=null){
 const requested=episodes(numbers),ordered=sourceOrder?sourceOrder.filter(n=>requested.includes(n)):requested,size=Math.ceil(ordered.length/productionLaneCount(laneCount));
 if(sourceOrder?(ordered.length!==requested.length||ordered.some((n,i)=>i&&sourceOrder.indexOf(n)!==sourceOrder.indexOf(ordered[i-1])+1)):ordered.some((n,i)=>i&&n!==ordered[i-1]+1))fail('WORKFLOW_PARALLEL_SCOPE','四路制作只接受连续集数，不能把缺集当成连续承接。');
 return Array.from({length:Math.ceil(ordered.length/size)},(_,i)=>ordered.slice(i*size,(i+1)*size));
}
export function productionWorkflowChain(d,{forDispatch=false}={}){
 const chain={...(d.season?{season:d.season}:{}),id:d.id,mode:d.mode,selectionRevision:d.selectionRevision,selectedRuns:d.selectedRuns,episodeNumbers:d.episodeNumbers};
 if(d.parallel){
  const selectedRunRevisions={};
  for(const entry of d.selectionHistory??[])if(d.selectedRuns[entry.episodeNumber]===entry.runId)selectedRunRevisions[entry.episodeNumber]=entry.selectionRevision;
  // New parallel tasks freeze this opt-in protocol; legacy tasks keep their prior global revision semantics.
  Object.assign(chain,{selectionProtocol:'per-episode-selection-v1',selectedRunRevisions});
  if(d.parallel.version===PRODUCTION_PARALLEL_VERSION&&(!forDispatch||d.parallel.enabled))chain.parallelism={version:PRODUCTION_PARALLEL_VERSION,laneCount:productionParallelLaneCount(d.parallel)};
 }
 return chain;
}
function chooseNext(workflow,snapshot,budgetDirectory,{scope=workflow.episodeNumbers,parallel=false}={}){
 if(workflow.paused)return wait('WAIT_PAUSED','流程已暂停；已发送的请求仍保留原回执。');
 if(workflow.activeAction)return wait(workflow.status==='INTERRUPTED'?'WAIT_RECOVERY':'WAIT_RUNNING','已有动作已登记；先读取结果或恢复，不能重复派单。','EXECUTOR',{actionId:workflow.activeAction.id});
 if((workflow.season?.scopeHash??null)!==(snapshot.season?.scopeHash??null))return wait('WAIT_SEASON_SCOPE','冻结季范围已变化，保留旧流程，未继续派发。','USER');
 if(snapshot.seasonTiming?.requiresReview&&!seasonDurationException(workflow.season?.scope))return wait('WAIT_SEASON_DURATION_REVIEW','实际分镜已偏离本季目标，停在未派发边界；先核对邻近原生终点或明确时长例外。','USER',{seasonTiming:snapshot.seasonTiming});
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
 // A scoped material need holds its own run; it does not turn four storyboard lanes into global asset dispatch.
 const pendingMaterials=parallel?[]:(workflow.materialRequests??[]).filter(r=>r.status==='REQUESTED');
 if(pendingMaterials.some(r=>r.needs.some(n=>!currentMaterialNeed(workflow,snapshot,n))))return wait('WAIT_MATERIAL_REQUEST_STALE','补料所依赖的选定版本或需求坐标已变化；先恢复检查，不照旧需求付费。');
 const missingCandidates=(snapshot.assets?.missingCandidateKeys??[]).filter(key=>workflow.requestedAssetKeys.includes(key));
 if(pendingMaterials.length){const materialNeeds=pendingMaterials.flatMap(r=>r.needs.map((n,index)=>({...n,workflowId:workflow.id,requestId:r.id,needRef:`${r.id}:${index}`,episodeNumber:snapshot.runs[n.runId].episodeNumber,workflowSourceVersion:workflow.sourceVersion})));return {kind:'ASSETS',assetKeys:[...new Set([...missingCandidates,...materialNeeds.map(n=>n.target)])],materialNeeds,materialRequestIds:pendingMaterials.map(r=>r.id),owner:'EXECUTOR'};}
 if(missingCandidates.length)return {kind:'ASSETS',assetKeys:missingCandidates,owner:'EXECUTOR'};
 const missingCritical=(snapshot.assets?.missingCriticalKeys??[]).filter(key=>workflow.criticalAssetKeys.includes(key));
 if(missingCritical.length)return wait('WAIT_DESIGN_CONFIRM','指定关键设计尚未采用；图片不是必需项。','USER',{assetKeys:missingCritical});
 for(const episodeNumber of scope){
  const runId=workflow.selectedRuns[episodeNumber];
  if(!runId)return {kind:'STORYBOARD_CREATE',episodeNumber,owner:'EXECUTOR'};
  const run=snapshot.runs?.[runId];
  if(!run)return wait('WAIT_RUN_RECOVERY','已选分镜版本暂不可读取，不能另建版本代替。','EXECUTOR',{episodeNumber,runId});
  if(run.busy)return wait('WAIT_STORYBOARD','当前集正在加工，完成后可继续下一动作。','EXECUTOR',{episodeNumber,runId});
  if(run.sourceStale)return wait('WAIT_RUN_SOURCE','已选分镜与当前硬源不符，保留结果并局部核对。','EXECUTOR',{episodeNumber,runId});
  if(run.canAutoRepair&&run.productionChain?.id===workflow.id&&run.productionChain?.mode===workflow.mode&&run.productionBudget?.id===workflow.budgetId&&typeof run.productionBudget?.directory==='string'&&path.resolve(run.productionBudget.directory)===path.resolve(budgetDirectory))return {kind:'STORYBOARD_CONTINUE',episodeNumber,runId,owner:'EXECUTOR'};
  if(run.blocked)return wait(run.needUpstream?'NEED_UPSTREAM':'WAIT_EXECUTOR_REPAIR',run.message||'已有版本需要对应局部处理。','EXECUTOR',{episodeNumber,runId,needs:run.needs??[]});
  if(run.continuityPending){if(parallel&&run.continuityStatus==='PRELIMINARY')continue;return wait('WAIT_CONTINUITY','本集正文已保存，尚未与所选前集实际尾稿完成承接核对；先补齐证据，不重复启动制作。','EXECUTOR',{episodeNumber,runId});}
  if(!run.complete){
   if(run.productionChain?.id!==workflow.id||run.productionChain?.mode!==workflow.mode||run.productionBudget?.id!==workflow.budgetId||typeof run.productionBudget?.directory!=='string'||path.resolve(run.productionBudget.directory)!==path.resolve(budgetDirectory))return wait('WAIT_RUN_BINDING','这个未完成版本不属于本制作链与共享预算，保留历史；请明确选择可继续的版本。','EXECUTOR',{episodeNumber,runId});
   return {kind:'STORYBOARD_CONTINUE',episodeNumber,runId,owner:'EXECUTOR'};
  }
  if(!parallel&&episodeNumber===workflow.episodeNumbers[0]&&!isCurrentReview(workflow,run))return wait('QUALITY_CHECK','执行者需复核首集主创与整编，并记录主要问题已解决；不要求用户逐集审批。','EXECUTOR',{episodeNumber,runId,fingerprint:run.fingerprint});
 }
 return {kind:'COMPLETE',owner:'EXECUTOR',message:'选集分镜已完成机械交付且首集已留有执行者质量复核；不代表成片或用户验收。'};
}

function budgetGate(action,workflow,budget){
 if(!paid.has(action.kind))return action;
 if(!workflow.costAcknowledged)return wait('WAIT_COST_CONFIRM','继续将使用共享付费预算，请明确确认费用边界。','USER',{proposedAction:action});
 if(budget.paused||(budget.summary.blockingUnknownAttempts??budget.summary.unknownAttempts)||budget.summary.calls>=budget.maxCalls||budget.summary.knownTokens>=budget.maxTokens)return wait('WAIT_BUDGET','共享预算已暂停、到达停止线或存在未授权的未知用量；先核对回执，不自动扩大预算。','USER',{proposedAction:action});
 return action;
}
function parallelView(workflow,snapshot,budget,budgetDirectory){
 if(!workflow.parallel)return null;
 const p=workflow.parallel,laneCount=productionParallelLaneCount(p),expected=partitionProductionLanes(workflow.episodeNumbers,laneCount,workflow.season?.scope?.episodeNumbers);
 if(p.runBudget!==undefined)runBudget(p.runBudget);
 if(!['standard','fast'].includes(p.executionTier)||JSON.stringify(p.lanes)!==JSON.stringify(expected))fail('WORKFLOW_PARALLEL_CONFIG','并行配置无法核验，未派发新请求。');
 const selected=workflow.episodeNumbers.map(n=>snapshot.runs?.[workflow.selectedRuns[n]]).filter(Boolean);
 const completedEpisodes=selected.filter(r=>r.complete).length,provisionalEpisodes=selected.filter(r=>r.continuityPending&&!r.busy&&!r.blocked&&!r.sourceStale).length;
 const first=snapshot.runs?.[workflow.selectedRuns[workflow.episodeNumbers[0]]];
 const qualityReviewPending=Boolean(first?.complete&&!isCurrentReview(workflow,first));
 const lanes=p.lanes.map((scope,index)=>{
  const nextAction=budgetGate(chooseNext(workflow,snapshot,budgetDirectory,{scope,parallel:true}),workflow,budget);
  const run=nextAction.runId?snapshot.runs?.[nextAction.runId]??null:scope.map(n=>snapshot.runs?.[workflow.selectedRuns[n]]).find(r=>r?.busy)??null;
  return {index,from:scope[0],to:scope.at(-1),episodeNumber:nextAction.episodeNumber??run?.episodeNumber??null,nextAction,run,
   completedEpisodes:scope.filter(n=>snapshot.runs?.[workflow.selectedRuns[n]]?.complete).length,
   provisionalEpisodes:scope.filter(n=>snapshot.runs?.[workflow.selectedRuns[n]]?.continuityPending).length};
 });
 const activeEpisodes=selected.filter(r=>r.busy).length;
 const stoppedBudget=budget.paused||(budget.summary.blockingUnknownAttempts??budget.summary.unknownAttempts)||budget.summary.calls>=budget.maxCalls||budget.summary.knownTokens>=budget.maxTokens;
 const globalWait=lanes.find(l=>!l.nextAction.runId&&!l.nextAction.episodeNumber&&l.nextAction.kind!=='COMPLETE'&&!['STORYBOARD_CREATE','STORYBOARD_CONTINUE'].includes(l.nextAction.kind));
 let status=workflow.paused?activeEpisodes||workflow.activeAction?'PAUSING':'PAUSED':!p.enabled?p.lastStop??'CONFIGURED':stoppedBudget?'WAIT_BUDGET':globalWait?.nextAction.kind??'RUNNING';
 if(p.enabled&&!workflow.paused&&lanes.every(l=>l.nextAction.kind==='COMPLETE'))status=provisionalEpisodes?'WAIT_CONTINUITY':qualityReviewPending?'QUALITY_CHECK':'COMPLETE';
 else if(p.enabled&&status==='RUNNING'&&!activeEpisodes&&lanes.every(l=>!['STORYBOARD_CREATE','STORYBOARD_CONTINUE'].includes(l.nextAction.kind)))status='WAIT_ISSUES';
 const waitingForEvidence=p.waitPolicy==='evidence-watch-v1'&&p.enabled&&!workflow.paused&&!stoppedBudget
  &&(['QUALITY_CHECK','WAIT_CONTINUITY'].includes(status)||status==='WAIT_ISSUES'&&lanes.every(l=>l.nextAction.kind==='COMPLETE'||l.nextAction.kind==='WAIT_CONTINUITY'||l.run?.boundaryReviewPending));
 return {enabled:p.enabled,modelSelection:productionModelSelection(p.modelSelection),executionTier:p.executionTier,maxConcurrent:laneCount,activeEpisodes,completedEpisodes,provisionalEpisodes,qualityReviewPending,lanes,status,waitingForEvidence,worker:p.worker??null};
}

/** Manual advance remains a single action; an explicitly armed server worker may fill the four lanes. */
export function createProductionWorkflowService({directory,budgetDirectory,adapters}){
 if(!directory||!budgetDirectory||typeof adapters?.inspect!=='function'||typeof adapters?.run!=='function'||typeof adapters?.withBudget!=='function')fail('WORKFLOW_CONFIG','流程必须配置持久目录、共享预算及执行适配器。');
 const store=createStore(directory),ledger=createProductionBudgetStore(budgetDirectory);
 const read=async id=>check(await store.read(id));
 const update=(id,revision,mutator)=>store.update(id,d=>{check(d);checkRevision(d,revision);const next=mutator(d);next.revision=d.revision+1;next.updatedAt=now();return next;});
 const updateAction=(id,actionId,mutator)=>store.update(id,d=>{check(d);if(d.activeAction?.id!==actionId)fail('WORKFLOW_ACTION_CHANGED','动作记录已变化，未覆盖已有结果。');const next=mutator(d);next.revision=d.revision+1;next.updatedAt=now();return next;});
 const describe=(workflow,snapshot,budget)=>{
  let nextAction=chooseNext(workflow,snapshot,budgetDirectory);
  nextAction=budgetGate(nextAction,workflow,budget);
  const keyDesignGate=!workflow.criticalAssetKeys.length?'NOT_SPECIFIED':(snapshot.assets?.missingCriticalKeys??[]).some(k=>workflow.criticalAssetKeys.includes(k))?'WAITING_CONFIRMATION':'CONFIRMED';
  return {workflow,readiness:{...(snapshot.seasonTiming?{seasonTiming:snapshot.seasonTiming}:{}),sourceVersion:snapshot.sourceVersion,standard:snapshot.standard,stage1:snapshot.stage1,direction:snapshot.direction,assets:snapshot.assets,runs:snapshot.runs??{},progress:snapshot.progress??null,sourceConflicts:snapshot.sourceConflicts??[],technicalIssues:snapshot.technicalIssues??[],keyDesignGate},keyDesignGate,nextAction,budget,parallel:parallelView(workflow,snapshot,budget,budgetDirectory)};
 };
 const inspect=async id=>{
  const workflow=await read(id),snapshot=await adapters.inspect(workflow),budget=publicBudget(await ledger.read(workflow.budgetId));
  return describe(workflow,snapshot,budget);
 };
 const notifySelection=async(workflow,changedRunId)=>{if(adapters.onSelectionChanged)await adapters.onSelectionChanged(workflow,changedRunId);};
 const finishReady=async(id,view)=>view.nextAction.kind==='COMPLETE'&&view.workflow.delivery?.enabled&&adapters.deliveryBundle&&view.workflow.delivery.result?.completionFingerprint!==productionDeliveryFingerprint(view.workflow,view.readiness.runs)
  ?service.exportDelivery(id,{expectedRevision:view.workflow.revision}):view;
 const service={
  read,inspect,
  async configureDelivery(id,command){
   if(typeof command.enabled!=='boolean'||!adapters.deliveryBundle)fail('WORKFLOW_DELIVERY_INPUT','请明确选择自动交付，目标路径由服务端管理。');
   if(command.seasonDelivery!==undefined&&!['preview','final'].includes(command.seasonDelivery))fail('SEASON_DELIVERY','请选择preview或final交付。');
   await update(id,command.expectedRevision,d=>({...d,delivery:{...d.delivery,version:'production-delivery-v1',enabled:command.enabled,...(command.seasonDelivery?{seasonDelivery:command.seasonDelivery}:{})}}));return inspect(id);
  },
  async exportDelivery(id,command){
   if(!adapters.deliveryBundle)fail('WORKFLOW_DELIVERY_EVIDENCE','当前适配器不支持原生对账交付。');
   const before=await read(id);checkRevision(before,command.expectedRevision);
   const result=await store.withLockedRead(id,async d=>{
    checkRevision(d,command.expectedRevision);
    const build=async()=>adapters.deliveryBundle(await read(id),await ledger.read(d.budgetId));
    const bundle=await build();
    return {...await writeProductionDelivery({root:path.join(directory,'deliveries',id),bundle,revalidate:async()=>(await build()).identity}),completionFingerprint:bundle.manifest.completionFingerprint};
   });
   await store.update(id,d=>{d.delivery={...d.delivery,version:'production-delivery-v1',result:{...result,at:now()}};d.revision++;d.updatedAt=now();return d;});
   return inspect(id);
  },
  async readDeliveryFile(id,name){
   if(typeof name!=='string'||!(/^(complete\.md|manifest\.json|usage\.json|season-summary\.json|report\.md|episodes\/episode-\d{4,}\.md)$/.test(name)))fail('WORKFLOW_DELIVERY_INPUT','文件不在正式文字交付命名范围内。');
   const d=await read(id);
   if(!d.delivery?.result?.identity||!adapters.deliveryBundle)fail('WORKFLOW_DELIVERY_NOT_READY','尚无已对账的正式文字导出。');
   const bundle=await adapters.deliveryBundle(d,await ledger.read(d.budgetId));
   if(bundle.identity!==d.delivery.result.identity)fail('WORKFLOW_DELIVERY_STALE','当前来源或选用稿已变化，历史导出保留但不冒充当前交付。');
   if(!Object.hasOwn(bundle.files,name))fail('WORKFLOW_DELIVERY_INPUT','文件不在本次交付清单内。');
   const file=path.join(directory,'deliveries',id,bundle.identity,name),stat=await lstat(file);
   if(!stat.isFile()||stat.isSymbolicLink())fail('WORKFLOW_DELIVERY_CONFLICT','交付文件类型已变化。');
   const body=await readFile(file,'utf8');if(body!==bundle.files[name])fail('WORKFLOW_DELIVERY_CONFLICT','交付文件哈希不匹配，未提供错误文件。');
   return {body,filename:path.basename(name),type:name.endsWith('.json')?'application/json; charset=utf-8':'text/markdown; charset=utf-8'};
  },
  async boundaryEvidence(id,command){
   const d=await read(id);checkRevision(d,command.expectedRevision);
   if(!adapters.boundaryPacket)fail('WORKFLOW_BOUNDARY_EVIDENCE','此适配器不支持实际双源证据包。');
   const boundaryEvidence=await adapters.boundaryPacket(d,command.runId);
   return {...await inspect(id),boundaryEvidence};
  },
  async reviewBoundary(id,command){
   const d=await read(id);checkRevision(d,command.expectedRevision);
   if(!adapters.reviewBoundary)fail('WORKFLOW_BOUNDARY_REVIEW','此适配器不支持免费边界复核。');
   if(command.reviewedFullSources!==true||command.reviewedActualShots!==true||typeof command.note!=='string'||!command.note.trim()||command.note.length>4000)fail('WORKFLOW_BOUNDARY_REVIEW','须先完整核对双源及实际尾首镜，并记录坐标化结论。');
   await adapters.reviewBoundary(d,command);await notifySelection(d,command.runId);
   await store.update(id,current=>{current.boundaryReviewReceipts=[...(current.boundaryReviewReceipts??[]),{runId:command.runId,evidenceHash:command.evidenceHash,actorId:command.actorId,note:command.note,at:now()}];current.revision++;current.updatedAt=now();return current;});
   return finishReady(id,await inspect(id));
  },
  async list(projectId){
   const files=await readdir(path.join(directory,'documents')).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e));
   const documents=await Promise.all(files.filter(f=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(f)).map(f=>read(f.slice(0,-5))));
   return documents.filter(d=>d.projectId===projectId).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));
  },
  async create(input){
   if(typeof input.projectId!=='string'||!input.projectId||typeof input.actorId!=='string'||!input.actorId)fail('WORKFLOW_INPUT','项目与执行者身份不可缺失。');
   let episodeNumbers=episodes(input.episodeNumbers);const mode=input.mode??'CHAIN';
   if(!['CHAIN','SINGLE'].includes(mode)||mode==='SINGLE'&&episodeNumbers.length!==1)fail('WORKFLOW_INPUT','单集流程必须只选择一集。');
   const criticalAssetKeys=keys(input.criticalAssetKeys??[]),requestedAssetKeys=keys(input.requestedAssetKeys??criticalAssetKeys);
   if(criticalAssetKeys.some(k=>!requestedAssetKeys.includes(k)))fail('WORKFLOW_INPUT','指定关键设计必须包含在请求材料范围内。');
   const workflow={schema:PRODUCTION_WORKFLOW_VERSION,id:randomUUID(),projectId:input.projectId,actorId:input.actorId,episodeNumbers,mode,criticalAssetKeys,requestedAssetKeys,budgetId:input.budgetId??randomUUID(),budgetPolicy:{version:PRODUCTION_LIMIT_POLICY,episode:{...DEFAULT_EPISODE_BUDGET},warningTokens:EPISODE_TOKEN_WARNING},delivery:{version:'production-delivery-v1',enabled:typeof adapters.deliveryBundle==='function'},sourceVersion:null,revision:0,selectionRevision:0,selectedRuns:{},qualityReviews:[],selectionHistory:[],materialRequests:[],receipts:[],activeAction:null,status:'READY',paused:false,costAcknowledged:input.costAcknowledged===true,createdAt:now(),updatedAt:now()};
   const snapshot=await adapters.inspect(workflow);
   if(snapshot.seasonMode==='season'&&!snapshot.season)fail('SEASON_NOT_LOCKED','本季未锁定，不能新建范围生产流程。');
   if(snapshot.season){assertSeasonEpisodes(snapshot.season.scope,episodeNumbers,'workflow');workflow.season=structuredClone(snapshot.season);episodeNumbers=snapshot.season.scope.episodeNumbers.filter(n=>episodeNumbers.includes(n));workflow.episodeNumbers=episodeNumbers;}
   if(typeof snapshot.sourceVersion!=='string'||!snapshot.sourceVersion)fail('WORKFLOW_SOURCE','源稿版本不可确定，未创建可派单流程。');
   if(episodeNumbers.some(n=>!snapshot.availableEpisodes?.includes(n))&&!(snapshot.canPrepareSource&&!snapshot.stage1?.ready))fail('WORKFLOW_SCOPE','所选集数不在当前可生产范围。');
   workflow.sourceVersion=snapshot.sourceVersion;
   if(input.budgetId){const budget=await ledger.read(input.budgetId);if(!budget.projectIds.includes(input.projectId))fail('WORKFLOW_BUDGET_SCOPE','项目不在该共享预算范围内。');}
   else{
    const recommended=recommendedWorkflowBudget(episodeNumbers.length),maxCalls=input.maxCalls??recommended.maxCalls,maxTokens=input.maxTokens??recommended.maxTokens;
    if(!Number.isSafeInteger(maxCalls)||maxCalls<0||maxCalls>recommended.maxCalls||!Number.isSafeInteger(maxTokens)||maxTokens<0||maxTokens>recommended.maxTokens)fail('WORKFLOW_BUDGET_LIMIT','此入口只允许采用或收紧所选范围的推荐停止线；不自动扩大已有账本。');
    await ledger.create(workflow.budgetId,{projectIds:[workflow.projectId],maxCalls,maxTokens});
   }
   await store.create(workflow.id,workflow);return inspect(workflow.id);
  },
  async advance(id,command){
   let view=await inspect(id);checkRevision(view.workflow,command.expectedRevision);
   if(command.costAcknowledged===true&&!view.workflow.costAcknowledged){await update(id,command.expectedRevision,d=>({...d,costAcknowledged:true}));view=await inspect(id);}
   const lane=command[parallelLane];
   if(view.workflow.parallel?.enabled&&lane===undefined)fail('WORKFLOW_PARALLEL_ACTIVE','四路已启用；请在队列中查看或暂停，不重复手工派单。');
   const action=lane===undefined?view.nextAction:view.parallel?.enabled?view.parallel.lanes[lane]?.nextAction:null;
   if(!action)fail('WORKFLOW_PARALLEL_CONFIG','队列未启用或范围无效。');
   if(!paid.has(action.kind))return finishReady(id,view);
   const actionId=randomUUID(),startedAt=now();
   const dispatched=await update(id,view.workflow.revision,d=>({...d,status:'RUNNING',activeAction:{...action,id:actionId,startedAt,pid:process.pid,host:hostname()},receipts:[...d.receipts,{id:actionId,kind:action.kind,episodeNumber:action.episodeNumber??null,status:'RUNNING',startedAt}]}));
   const bind=async binding=>{
    const changed=await updateAction(id,actionId,d=>{
     const receipt=d.receipts.find(r=>r.id===actionId);Object.assign(receipt,binding);Object.assign(d.activeAction,binding);
     if(binding.runId){
      if(!d.episodeNumbers.includes(binding.episodeNumber)||typeof binding.runId!=='string')fail('WORKFLOW_RUN_SCOPE','分镜版本绑定超出选集范围。');
      if(d.parallel&&lane!==undefined)d.parallel.participatingRuns=[...new Set([...(d.parallel.participatingRuns??[]),binding.runId])];
      if(d.selectedRuns[binding.episodeNumber]!==binding.runId){d.selectedRuns[binding.episodeNumber]=binding.runId;d.selectionRevision++;d.selectionHistory.push({episodeNumber:binding.episodeNumber,runId:binding.runId,selectionRevision:d.selectionRevision,actorId:command.actorId,at:now()});}
     }
     return d;
    });
    if(binding.runId)await notifySelection(changed,binding.runId);return changed;
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
    await updateAction(id,actionId,d=>{Object.assign(d.receipts.find(r=>r.id===actionId),{status:'INTERRUPTED',finishedAt:now(),error:{code:error?.code??'WORKFLOW_ACTION_FAILED',message:String(error?.message??'动作中断').slice(0,1200),requestOutcome:error?.requestOutcome??'UNKNOWN',...(provenAdmissionReadError(d.activeAction,error)?{retryableRead:true}:{})}});d.status='INTERRUPTED';return d;});
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
    &&snapshot.direction?.settledKnown===true&&!snapshot.direction.pending&&!(budget.summary.blockingUnknownAttempts??budget.summary.unknownAttempts)&&!budget.summary.inFlight;
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
     const entry=d.receipts.find(r=>r.id===action.id);Object.assign(entry,{status:directionStopped?'PARTIAL':recovered?'RECOVERED':'NOT_SENT',recoveredAt:now(),...(command[savedRunRecovery]?{recoveryMethod:'SAVED_RUN_ONLY'}:{})});
     if(stage1Recovered&&snapshot.sourceVersion!==d.sourceVersion){entry.sourceTransition={before:d.sourceVersion,after:snapshot.sourceVersion,taskId:action.taskId,reason:'RECOVERED_AUTHORIZED_STAGE1_PREPARATION'};d.sourceVersion=snapshot.sourceVersion;}
     if(recovered&&action.kind==='ASSETS')for(const request of d.materialRequests??[])if(action.materialRequestIds?.includes(request.id)){request.status='CANDIDATES_SAVED';request.receiptId=action.id;request.finishedAt=now();}
     d.activeAction=null;d.status='READY';return d;
    });
    if(recovered&&action.kind==='ASSETS')await notifySelection(changed);
   }
   else if(workflow.status!=='INTERRUPTED')await update(id,command.expectedRevision,d=>({...d,status:'INTERRUPTED'}));
   return inspect(id);
  },
  async pause(id,command){
   const changed=await store.update(id,d=>{
    check(d);
    if(command.expectedAuthorization!==undefined){if(!d.parallel?.authorizedAt||d.parallel.authorizedAt!==command.expectedAuthorization)fail('WORKFLOW_PARALLEL_OWNER','队列授权已更新，旧页面不能暂停新的四路。');}
    else checkRevision(d,command.expectedRevision);
    if(d.paused)return d;
    d.paused=true;if(d.parallel)Object.assign(d.parallel,{enabled:false,lastStop:'PAUSED'});d.revision++;d.updatedAt=now();return d;
   });
   if(!changed.parallel&&adapters.onPause)await adapters.onPause(changed);return inspect(id);
  },
  async resume(id,command){await update(id,command.expectedRevision,d=>({...d,paused:false}));return inspect(id);},
  async selectRun(id,command){
   const workflow=await read(id);checkRevision(workflow,command.expectedRevision);
   if(workflow.activeAction||workflow.parallel?.enabled)fail('WORKFLOW_BUSY','当前动作或四路队列尚未停止，先暂停并核对回执再切换版本。');
   if(!workflow.episodeNumbers.includes(command.episodeNumber))fail('WORKFLOW_RUN_SCOPE','该集不在流程选集范围。');
   const run=await adapters.readRun(command.runId,workflow);
   if(!run||run.projectId!==workflow.projectId||run.episodeNumber!==command.episodeNumber)fail('WORKFLOW_RUN_SCOPE','分镜版本不属于当前项目与集数。');
   const changed=await update(id,command.expectedRevision,d=>{if(d.selectedRuns[command.episodeNumber]!==command.runId){d.selectedRuns[command.episodeNumber]=command.runId;d.selectionRevision++;d.selectionHistory.push({episodeNumber:command.episodeNumber,runId:command.runId,selectionRevision:d.selectionRevision,actorId:command.actorId,at:now()});}return d;});
   await notifySelection(changed,command.runId);return inspect(id);
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
   return finishReady(id,await inspect(id));
  },
  async configurePaidRepairPolicy(id,command){
   const workflow=await read(id);checkRevision(workflow,command.expectedRevision);
   if(typeof command.automatic!=='boolean'||typeof command.actorId!=='string'||!command.actorId||command.automatic&&command.costAcknowledged!==true)
    fail('WORKFLOW_REPAIR_CONSENT','额外自动付费补正须单独明确确认；正常制作授权和预算余量不等于补正授权。');
   await update(id,command.expectedRevision,d=>({...d,paidRepairPolicy:{version:'paid-repair-consent-v1',automatic:command.automatic,actorId:command.actorId,at:now()}}));
   return inspect(id);
  },
  async configureParallel(id,command){
   const workflow=await read(id);checkRevision(workflow,command.expectedRevision);
   if(workflow.mode!=='CHAIN'||workflow.activeAction||workflow.parallel?.enabled)fail('WORKFLOW_PARALLEL_CONFIG','请选择连续制作链并先停止当前派单，再保存四路配置。');
   const previous=workflow.parallel,oldCount=productionParallelLaneCount(previous);
   const laneCount=command.laneCount===undefined?oldCount:productionLaneCount(command.laneCount);
   if(previous&&laneCount!==oldCount&&(previous.version==='production-parallel-v1'||previous.authorizedAt||previous.participatingRuns?.length))fail('WORKFLOW_PARALLEL_FROZEN','原任务路数已冻结，请继续原队列。');
   const lanes=partitionProductionLanes(workflow.episodeNumbers,laneCount,workflow.season?.scope?.episodeNumbers);
   const version=previous?.version==='production-parallel-v1'?'production-parallel-v1':command.laneCount!==undefined||previous?.version===PRODUCTION_PARALLEL_VERSION?PRODUCTION_PARALLEL_VERSION:'production-parallel-v1';
   const executionTier=command.executionTier??workflow.parallel?.executionTier??'standard';
   const modelSelection=productionModelSelection(command.modelSelection===undefined?workflow.parallel?.modelSelection:command.modelSelection);
   if(!['standard','fast'].includes(executionTier))fail('WORKFLOW_PARALLEL_CONFIG','执行速度档无效，未更改已保存配置。');
   const configuredBudget=command.runBudget===undefined?workflow.parallel?.runBudget??workflow.budgetPolicy?.episode??{...DEFAULT_EPISODE_BUDGET}:runBudget(command.runBudget);
   await update(id,command.expectedRevision,d=>({...d,parallel:{...d.parallel,version,...(version===PRODUCTION_PARALLEL_VERSION?{laneCount}:{}),waitPolicy:'evidence-watch-v1',reconnectPolicy:'wake-reconnect-v1',lanes,enabled:false,executionTier,modelSelection,...(configuredBudget?{runBudget:configuredBudget}:{}),participatingRuns:d.parallel?.participatingRuns??[],configuredAt:now(),configuredBy:command.actorId}}));
   return inspect(id);
  },
  async startParallel(id,command){
   let view=await inspect(id);checkRevision(view.workflow,command.expectedRevision);
   if(!view.parallel)fail('WORKFLOW_PARALLEL_CONFIG','先保存四路配置。');
   if(command.laneCount!==undefined&&productionLaneCount(command.laneCount)!==view.parallel.maxConcurrent)fail('WORKFLOW_PARALLEL_FROZEN','启动路数与保存安排不同，请先保存尚未启动的新安排；旧任务继续原路数。');
   const modelSelection=productionModelSelection(command.modelSelection===undefined?view.workflow.parallel.modelSelection:command.modelSelection),executionTier=command.executionTier??view.parallel.executionTier;
   if(!['standard','fast'].includes(executionTier))fail('WORKFLOW_PARALLEL_CONFIG','执行速度档无效。');
   if(command.costAcknowledged!==true||executionTier==='fast'&&command.fastAcknowledged!==true)fail('WORKFLOW_PARALLEL_CONSENT','请明确允许此范围的模型调用；Fast档还须同意额外额度消耗，旧制作授权不自动开启四路。');
   if(view.workflow.parallel.enabled&&!view.workflow.paused)return view;
   if(view.workflow.activeAction&&view.workflow.paused){
    const action=view.workflow.activeAction,receipt=view.workflow.receipts.find(r=>r.id===action.id),run=view.readiness.runs[action.runId];
    if(action.kind.startsWith('STORYBOARD_')&&receipt?.error?.code==='WORKFLOW_PAUSED'&&receipt.error.requestOutcome==='NOT_SENT'
     &&run?.projectId===view.workflow.projectId&&run.episodeNumber===action.episodeNumber&&view.workflow.selectedRuns[action.episodeNumber]===action.runId
     &&run.productionChain?.id===id&&run.productionChain?.mode===view.workflow.mode&&run.productionBudget?.id===view.workflow.budgetId
     &&typeof run.productionBudget.directory==='string'&&path.resolve(run.productionBudget.directory)===path.resolve(budgetDirectory)&&!run.sourceStale)
      view=await service.recover(id,{expectedRevision:view.workflow.revision});
   }
   if(view.workflow.activeAction)fail('WORKFLOW_BUSY','已有准备动作仍在安全收尾；请稍后继续原四路，不重发。');
   const preview=parallelView({...view.workflow,paused:false,costAcknowledged:true,parallel:{...view.workflow.parallel,modelSelection,executionTier,enabled:true}},await adapters.inspect(view.workflow),view.budget,budgetDirectory);
   const blocker=preview.lanes.map(l=>l.nextAction).find(a=>!['STORYBOARD_CREATE','STORYBOARD_CONTINUE','WAIT_STORYBOARD','WAIT_EXECUTOR_REPAIR','NEED_UPSTREAM','WAIT_RUN_SOURCE','WAIT_RUN_BINDING','WAIT_CONTINUITY','COMPLETE'].includes(a.kind));
   if(preview.status==='WAIT_BUDGET'||blocker){
    const reason=blocker?.message??({DIRECTION:'全剧方向尚无已确认的采用卡。',STAGE1:'基础资料尚未整理完成。',ASSETS:'指定材料尚未准备完成。'}[blocker?.kind]??'共享预算需要核对。');
    const next=blocker?.kind==='DIRECTION'||blocker?.kind.startsWith('WAIT_DIRECTION')?'请打开“全剧方向”完善并确认；已有资料可免费手工保存，额外AI分析需另行发起。':'请处理页面对应待办后继续原队列。';
    fail('WORKFLOW_PARALLEL_READY',`${reason} ${next}`);
   }
   await update(id,view.workflow.revision,d=>({...d,paused:false,costAcknowledged:true,parallel:{...d.parallel,modelSelection,executionTier,reconnectPolicy:'wake-reconnect-v1',enabled:true,lastStop:null,authorizedAt:now(),authorizedBy:command.actorId}}));
   return inspect(id);
  },
  async reconnectParallel(id,command){
   const d=await read(id);
   if(!d.parallel?.authorizedAt||command.expectedAuthorization!==d.parallel.authorizedAt)fail('WORKFLOW_PARALLEL_OWNER','原四路授权已变化，未启动任务。');
   // Ordinary page/wake reconnect remains read-only. Explicit recovery may arm
   // ready normal lanes under the original grant; it never clears a run issue.
   if(command.resumeReadyIssues===true){
    if(!Number.isSafeInteger(command.expectedRevision))fail('WORKFLOW_CONFLICT','恢复须绑定当前流程修订。');
    checkRevision(d,command.expectedRevision);
    if(command.actorId!==d.parallel.authorizedBy||d.paused||d.parallel.enabled||d.status!=='READY'||d.activeAction||d.parallel.lastStop!=='WAIT_ISSUES'||d.parallel.worker?.status!=='WAIT_ISSUES')fail('WORKFLOW_PARALLEL_READY','仅可恢复原启动者的问题等待队列，不越过暂停、在途或其它停止。');
    const snapshot=await adapters.inspect(d),budget=publicBudget(await ledger.read(d.budgetId));
    const preview=parallelView({...d,parallel:{...d.parallel,enabled:true,lastStop:null}},snapshot,budget,budgetDirectory);
    const ready=preview.lanes.filter(l=>['STORYBOARD_CREATE','STORYBOARD_CONTINUE'].includes(l.nextAction.kind)).map(l=>({index:l.index,episodeNumber:l.nextAction.episodeNumber,kind:l.nextAction.kind,...(l.nextAction.runId?{runId:l.nextAction.runId}:{})}));
    if(preview.status!=='RUNNING'||!ready.length)fail('WORKFLOW_PARALLEL_READY','当前源、材料、预算或各路问题仍未允许正常制作，未恢复派发。');
    const armed=await update(id,command.expectedRevision,current=>{
     if(current.paused||current.parallel.enabled||current.activeAction||current.status!=='READY'||current.parallel.authorizedAt!==command.expectedAuthorization||current.parallel.authorizedBy!==command.actorId||current.parallel.lastStop!=='WAIT_ISSUES'||current.parallel.worker?.status!=='WAIT_ISSUES')fail('WORKFLOW_PARALLEL_OWNER','恢复核验期间原队列控制已变化。');
     current.parallel.enabled=true;current.parallel.lastStop=null;
     current.parallel.readyIssueRecovery={version:'ready-issue-recovery-v1',at:now(),authorization:command.expectedAuthorization,actorId:command.actorId,fromRevision:command.expectedRevision,sourceVersion:snapshot.sourceVersion,ready,held:preview.lanes.filter(l=>!ready.some(r=>r.index===l.index)).map(l=>({index:l.index,episodeNumber:l.nextAction.episodeNumber??null,kind:l.nextAction.kind}))};
     return current;
    });
    return describe(armed,snapshot,budget);
   }
   return inspect(id);
  },
  async pumpParallel(id,{expectedAuthorization}={}){
   if(expectedAuthorization&&(await read(id)).parallel?.authorizedAt!==expectedAuthorization)fail('WORKFLOW_PARALLEL_OWNER','原授权已改变，旧执行者不能续派。');
   const key=`${path.resolve(directory)}:${id}`;
   if(parallelPumps.has(key))return parallelPumps.get(key);
   const task=(async()=>{
    // ponytail: serialize short admission/bind IO; the existing coordinator owns the four actual CLI slots.
    let view=await inspect(id);
    if(view.parallel?.enabled&&!view.workflow.paused&&view.readiness.sourceVersion===view.workflow.sourceVersion&&adapters.recoverSaved){
     let attempted=false;
     for(const run of Object.values(view.readiness.runs)){
      if(!run.recoveryPending||run.busy||run.sourceStale||run.productionChain?.id!==id||run.productionChain?.mode!==view.workflow.mode
       ||view.workflow.selectedRuns[run.episodeNumber]!==run.id||run.productionBudget?.id!==view.workflow.budgetId
       ||typeof run.productionBudget.directory!=='string'||path.resolve(run.productionBudget.directory)!==path.resolve(budgetDirectory))continue;
      await adapters.recoverSaved(view.workflow,run.id);attempted=true;
     }
     if(attempted)view=await inspect(id);
    }
    for(let lane=0;lane<(view.parallel?.lanes.length??0);lane++){
     if(!view.parallel?.enabled||view.workflow.paused||view.parallel.status==='WAIT_BUDGET')break;
     if(view.workflow.activeAction){
      const a=view.workflow.activeAction,r=view.readiness.runs[a.runId];
      // Release only the outer receipt for an exactly bound saved/running result.
      // The run coordinator retains its source, unknown-usage and no-progress gates.
      const saved=Boolean(a.kind.startsWith('STORYBOARD_')&&a.runId&&view.workflow.selectedRuns[a.episodeNumber]===a.runId&&r?.projectId===view.workflow.projectId
       &&r.productionChain?.id===id&&r.productionChain?.mode===view.workflow.mode&&r.productionBudget?.id===view.workflow.budgetId
       &&typeof r.productionBudget.directory==='string'&&path.resolve(r.productionBudget.directory)===path.resolve(budgetDirectory)
       &&(r.busy||r.complete||r.blocked||r.canAutoRepair||r.continuityPending));
      const receipt=view.workflow.receipts.find(r=>r.id===a.id);
      if(view.workflow.status==='INTERRUPTED'&&!saved&&!reconnectableCreate(a,receipt?.error,view,budgetDirectory))break;
      view=await service.recover(id,{expectedRevision:view.workflow.revision,...(saved?{[savedRunRecovery]:true}:{})});if(view.workflow.activeAction)break;
     }
     const action=view.parallel.lanes[lane]?.nextAction;
     if(!action||!['STORYBOARD_CREATE','STORYBOARD_CONTINUE'].includes(action.kind))continue;
     try{view=await service.advance(id,{expectedRevision:view.workflow.revision,actorId:view.workflow.parallel.authorizedBy,[parallelLane]:lane});
      const a=view.workflow.activeAction,receipt=a&&view.workflow.receipts.find(r=>r.id===a.id);
      if(reconnectableCreate(a,receipt?.error,view,budgetDirectory))throw Object.assign(new Error('只读创建准备暂不可用；保留原动作并有界重连。'),{code:receipt.error.code,retryableRead:true});
     }
     catch(error){if(error.code!=='WORKFLOW_CONFLICT')throw error;view=await inspect(id);}
    }
    // Every advance/recover already returns a fresh inspection. With no action,
    // do not parse all episodes twice in the same tick; the next tick is fresh.
    return view.parallel?.status==='COMPLETE'?finishReady(id,view):view;
   })().finally(()=>parallelPumps.delete(key));
   parallelPumps.set(key,task);return task;
  },
  async recordParallelWorker(id,worker,{stop=false,expectedToken,expectedAuthorization,expectedWorker}={}){
   // Internal worker checkpoint only; no budget or source changes and no dispatch.
   await store.update(id,d=>{
    check(d);if(!d.parallel)fail('WORKFLOW_PARALLEL_CONFIG','四路配置缺失。');
    if(expectedToken&&d.parallel.worker?.token!==expectedToken)fail('WORKFLOW_PARALLEL_OWNER','队列执行者已变化，旧执行者不能覆盖记录。');
    if(expectedAuthorization&&d.parallel.authorizedAt!==expectedAuthorization)fail('WORKFLOW_PARALLEL_OWNER','队列授权已更新，旧执行者不能停掉新授权。');
    if(expectedWorker!==undefined&&JSON.stringify(d.parallel.worker??null)!==JSON.stringify(expectedWorker))fail('WORKFLOW_PARALLEL_OWNER','队列执行者记录已变化，启动失败不能停掉接管者。');
    d.parallel.worker=worker;
    if(stop){d.parallel.enabled=false;d.parallel.lastStop=worker.status;}
    d.revision++;d.updatedAt=now();return d;
   });
  },
  async getProductionChain(id,projectId){const d=await read(id);if(d.projectId!==projectId)fail('WORKFLOW_SCOPE','流程不属于当前项目。');return productionWorkflowChain(d);}
 };
 return service;
}
