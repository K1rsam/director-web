import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createStore} from './storyboard-v4/core/store.mjs';
import {digest,fail} from './storyboard-v4/core/shared.mjs';
import {FEEDBACK_RESULT_VERSION,LEGACY_FEEDBACK_RESULT_VERSION,isFeedbackResultVersion} from './storyboard-v4/core/production-feedback-result.mjs';
import {ENTRY_REVIEW_VERSION} from './storyboard-v4/core/entry-evidence.mjs';
import {sealUnsentProof,isVerifiedUnsent,sealPreparationProof,isVerifiedPreparationFailure} from './storyboard-v4/core/pre-dispatch-evidence.mjs';
import {RUNTIME_MAINTENANCE_VERSION} from './production-maintenance-state.mjs';
import {createProductionBudgetStore} from './production-budget.mjs';
export {RUNTIME_MAINTENANCE_VERSION,runtimeMaintenanceState,assertRuntimeAdmission} from './production-maintenance-state.mjs';
const final=new Set(['RESUMED','ABORTED']);
const now=()=>new Date().toISOString();
const active=c=>c&&c.version===RUNTIME_MAINTENANCE_VERSION&&!final.has(c.phase);
const controlRoot=dataRoot=>path.join(path.resolve(dataRoot),'runtime-maintenance');
const contract=w=>({projectId:w.projectId,sourceVersion:w.sourceVersion,budgetId:w.budgetId,episodeNumbers:w.episodeNumbers,budgetPolicy:w.budgetPolicy??null,authorizedAt:w.parallel?.authorizedAt,authorizedBy:w.parallel?.authorizedBy,modelSelection:w.parallel?.modelSelection??null,executionTier:w.parallel?.executionTier,runBudget:w.parallel?.runBudget??null,lanes:w.parallel?.lanes});
const documentFiles=async directory=>(await readdir(path.join(directory,'documents')).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e))).filter(f=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(f));
const documents=async directory=>Promise.all((await documentFiles(directory)).map(async f=>JSON.parse(await readFile(path.join(directory,'documents',f),'utf8'))));
const plainNativeUsage=op=>op.receipt?.requestOutcome==='NOT_SENT'||op.error?.requestOutcome==='NOT_SENT'||isVerifiedUnsent(op);
const unsafe=op=>['running','queued'].includes(op.status)||op.status==='unknown'&&!op.cancelAcknowledgement;
function activationVersion(run){
 const rule=run.rulesSnapshot?.productionFeedbackResultVersion,production=run.production?.feedbackResultVersion;
 if(rule===production&&isFeedbackResultVersion(rule))return rule;
 if([rule,production].every(v=>v===undefined||v===LEGACY_FEEDBACK_RESULT_VERSION))return LEGACY_FEEDBACK_RESULT_VERSION;
 fail('RUNTIME_MAINTENANCE_CHANGED','既有任务完整结果合同不匹配；冷加载不能替换已冻结的生产协议。');
}
function settledDeliveryChecks(w,b,all){
 if(!w.delivery?.enabled||!w.episodeNumbers?.length||Object.keys(w.selectedRuns).length!==w.episodeNumbers.length||b.paused||b.summary?.inFlight!==0||b.summary?.unknownAttempts!==0)return null;
 const checks=[];
 for(const n of w.episodeNumbers){
  const r=all.find(r=>r.id===w.selectedRuns[n]),v=r?.web,binding=v?.binding;
  if(!r||r.status!=='text_ready_for_review'||!r.assembly?.text||!Array.isArray(r.assembly.validation?.errors)||r.assembly.validation.errors.length
   ||binding?.projectId!==w.projectId||binding.episodeNumber!==n||binding.productionChain?.id!==w.id||binding.productionBudget?.id!==w.budgetId
   ||v.sourceStale||v.stopped||v.pauseRequested||v.owner||v.reserved||v.reservedAttemptIds?.length||r.operations?.some(unsafe)
   ||r.production?.blocking||r.production?.globalBlocking||r.production?.pendingRepair||r.production?.needs?.some(x=>x.blocking&&!x.resolved)
   ||!['NO_PREDECESSOR','MATCHED','NOT_CONTINUOUS','NOT_CONSUMED'].includes(r.production?.boundaryCheck?.status))return null;
  checks.push({runId:r.id,episodeNumber:n,fingerprint:digest({source:r.source,assembly:r.assembly,adopted:r.adopted,operations:r.operations,production:r.production,binding})});
 }return checks;
}

/** Local operator capability. No engine/coordinator construction, runner, signal or network here. */
export function createRuntimeMaintenance({workflowDirectory,dataRoot,budgetDirectory}){
 const workflows=createStore(workflowDirectory),runs=createStore(dataRoot,{trackRevision:true}),budgets=createStore(budgetDirectory),budgetUsage=createProductionBudgetStore(budgetDirectory),controls=createStore(controlRoot(dataRoot));
 const current=()=>controls.read('current');
 const event=(c,phase,details={})=>({...c,...details,phase,updatedAt:now(),events:[...c.events,{phase,at:now()}]});
 async function change(fn){return controls.update('current',fn);}
 function assertContract(c,w){if(digest(contract(w))!==c.contractHash||w.runtimeMaintenance?.id!==c.id)fail('RUNTIME_MAINTENANCE_CHANGED','原授权、源稿、模型、停止线或维护归属已变化，保持维护门。');}
 async function assertUnchanged(c,{resuming=false}={}){
  if(c.userPauseRequestedAt)fail('RUNTIME_MAINTENANCE_CANCELLED','用户在维护期间暂停，禁止自动恢复。');
  const w=await workflows.read(c.workflowId);assertContract(c,w);
  const b=await budgets.read(w.budgetId);if(digest({maxCalls:b.maxCalls,maxTokens:b.maxTokens,projectIds:b.projectIds})!==c.budgetContractHash||b.paused)fail('RUNTIME_MAINTENANCE_CHANGED','共享账本停止线或暂停状态已变化。');
  if((w.paused!==true||w.parallel.enabled!==false)&&!(resuming&&c.phase==='RESUMING'&&['RESUMING','RESUMED'].includes(w.runtimeMaintenance.phase)&&w.paused===false&&w.parallel.enabled===true))fail('RUNTIME_MAINTENANCE_CHANGED','维护暂停状态已被外部改变。');
  return w;
 }
 async function unboundCreateProof(w,b){
  const a=w.activeAction,receipt=w.receipts?.find(r=>r.id===a?.id);
  if(a?.kind!=='STORYBOARD_CREATE'||a.runId||w.selectedRuns[a.episodeNumber]||!receipt
   ||(b.summary?.blockingUnknownAttempts??b.summary?.unknownAttempts)||(b.attempts??[]).some(v=>v.id===a.id)
   ||(await documents(dataRoot)).some(r=>r.web?.binding?.projectId===w.projectId&&r.web.binding.episodeNumber===a.episodeNumber))return null;
  try{await readdir(path.join(dataRoot,'attempts',a.id));return null;}catch(e){if(e.code!=='ENOENT')throw e;}
  return sealUnsentProof(receipt,{scope:'UNBOUND_STORYBOARD_CREATE',budgetId:w.budgetId,nativeDirectoryAbsent:true,ledgerAttemptAbsent:true,candidateAbsent:true,episodeNumber:a.episodeNumber});
 }
 async function completeBegin(c){
  const w=await workflows.read(c.workflowId);
  if(w.runtimeMaintenance?.id!==c.id)await workflows.update(w.id,d=>{
   if(d.revision!==c.originalRevision||digest(contract(d))!==c.contractHash||d.paused||!d.parallel.enabled&&!c.preparationProof&&!c.issueStopProof&&!c.deliveryStopProof)fail('RUNTIME_MAINTENANCE_CHANGED','准入暂停前状态已变化，保留维护意图待核。');
   if(c.preparationProof){const receipt=d.receipts.find(r=>r.id===d.activeAction?.id);if(!receipt||digest(receipt)!==c.preparationReceiptHash)fail('RUNTIME_MAINTENANCE_CHANGED','零派发动作回执已变化');receipt.localDispatchProof=c.preparationProof;receipt.status='NOT_SENT';receipt.recoveredAt=now();receipt.recoveryMethod='VERIFIED_LOCAL_PRE_DISPATCH';d.activeAction=null;d.status='READY';}
   d.runtimeMaintenance={version:RUNTIME_MAINTENANCE_VERSION,id:c.id,phase:'DRAINING',authorization:c.authorization};
   d.paused=true;d.parallel.enabled=false;d.parallel.lastStop='MAINTENANCE';d.revision++;d.updatedAt=now();return d;
  });
  const held=await holdRuns(c);return change(d=>{if(d.id!==c.id||d.userPauseRequestedAt)fail('RUNTIME_MAINTENANCE_CANCELLED','维护归属或用户控制变化');return event(d,'DRAINING',{heldRunIds:held,lastError:null});});
 }
 async function holdRuns(c){
  const w=await assertUnchanged(c),held=[];
  for(const id of Object.values(w.selectedRuns)){
   const r=await runs.read(id);if(r.status==='text_ready_for_review'||r.web?.legacyReadOnly)continue;
   if(r.web?.binding?.projectId!==w.projectId||r.web.binding.productionChain?.id!==w.id||r.web.binding.productionBudget?.id!==w.budgetId)fail('RUNTIME_MAINTENANCE_CHANGED','未完成版本绑定无法核验。');
   if(r.web.stopped||r.web.sourceStale||r.web.pauseRequested&&!r.web.runtimeMaintenance)continue;
   await runs.update(id,d=>{
    if(d.status==='text_ready_for_review')return d;
    if(d.web.runtimeMaintenance?.id===c.id){held.push(id);return d;}
    if(d.web.pauseRequested||d.web.stopped||d.web.sourceStale)fail('RUNTIME_MAINTENANCE_CHANGED','本集已有人为暂停或源变化。');
    d.web.runtimeMaintenance={id:c.id,priorPauseRequested:false,at:now()};d.web.pauseRequested=true;held.push(id);return d;
   });
  }
  return held;
 }
 return {
  current,
  async begin({workflowId,expectedAuthorization,expectedRevision,targetPid,codeIdentity,requiredCapabilities={}}){
   if(!Number.isSafeInteger(targetPid)||targetPid<=0||typeof codeIdentity!=='string'||!codeIdentity)fail('RUNTIME_MAINTENANCE_INPUT','缺少当前执行者与源码身份。');
   let previous;try{previous=await current();}catch(e){if(e.code!=='ENOENT')throw e;}
   if(previous&&!final.has(previous.phase)){
    if(previous.workflowId!==workflowId||previous.authorization!==expectedAuthorization||previous.targetPid!==targetPid||previous.codeIdentity!==codeIdentity||digest(previous.requiredCapabilities??{})!==digest(requiredCapabilities)||!['PREPARED','DRAINING'].includes(previous.phase))fail('RUNTIME_MAINTENANCE_BUSY','已有不同归属或阶段的维护，不重复建单。');
    if(previous.phase==='DRAINING'){await assertUnchanged(previous);return previous;}
    return completeBegin(previous);
   }
   const w=await workflows.read(workflowId),b=await budgets.read(w.budgetId);
   if(Object.keys(requiredCapabilities).some(k=>k!=='productionEntryReviewVersion')||requiredCapabilities.productionEntryReviewVersion!==undefined&&requiredCapabilities.productionEntryReviewVersion!==ENTRY_REVIEW_VERSION)fail('RUNTIME_MAINTENANCE_INPUT','未知目标内核能力，不能忽略。');
   const issueStopped=!w.parallel?.enabled&&w.status==='READY'&&!w.activeAction&&w.parallel?.lastStop==='WAIT_ISSUES'&&w.parallel?.worker?.status==='WAIT_ISSUES';
   const issueStopProof=issueStopped?{status:w.status,lastStop:w.parallel.lastStop,workerStatus:w.parallel.worker.status,checks:(await documents(dataRoot)).filter(r=>Object.values(w.selectedRuns).includes(r.id)&&['CONSTRAINT_CONFLICT','UNRESOLVED','REPAIR_REQUIRED'].includes(r.production?.boundaryCheck?.status)).map(r=>({runId:r.id,status:r.production.boundaryCheck.status,signature:r.production.boundaryCheck.signature}))}:null;
   const deliveryStopped=!w.parallel?.enabled&&w.status==='READY'&&!w.activeAction&&w.parallel?.lastStop==='INTERRUPTED'&&w.parallel?.worker?.status==='INTERRUPTED'&&w.parallel.worker.error?.code==='WORKFLOW_DELIVERY_LEDGER';
   const deliveryChecks=deliveryStopped?settledDeliveryChecks(w,await budgetUsage.read(w.budgetId),await documents(dataRoot)):null;
   const deliveryStopProof=deliveryChecks?{errorCode:'WORKFLOW_DELIVERY_LEDGER',checks:deliveryChecks}:null;
   let preparationProof=null;
   if(!w.parallel?.enabled&&w.status==='INTERRUPTED'&&w.activeAction?.kind==='STORYBOARD_CREATE'&&!w.activeAction.runId&&!w.selectedRuns[w.activeAction.episodeNumber]){
    if(['WAIT_RECOVERY','INTERRUPTED'].includes(w.parallel?.lastStop))preparationProof=await unboundCreateProof(w,b);
   }
   if(w.parallel?.authorizedAt!==expectedAuthorization||w.revision!==expectedRevision||w.paused||!w.parallel?.enabled&&!preparationProof&&!issueStopProof&&!deliveryStopProof||!w.parallel.authorizedBy)fail('RUNTIME_MAINTENANCE_CHANGED','原授权或当前修订已变化；不越过用户暂停。');
   const other=(await documents(workflowDirectory)).filter(d=>d.id!==w.id&&(d.parallel?.enabled||d.activeAction?.status==='RUNNING'||d.status==='RUNNING'&&d.activeAction));
   if(other.length)fail('RUNTIME_MAINTENANCE_OTHER_WORK','其他流程尚在运行，不能为本流程切换整个内核。');
   const id=randomUUID(),c={version:RUNTIME_MAINTENANCE_VERSION,id,workflowId:w.id,projectId:w.projectId,phase:'PREPARED',targetPid,codeIdentity,requiredCapabilities,issueStopProof,deliveryStopProof,authorization:expectedAuthorization,originalRevision:w.revision,preparationProof,preparationReceiptHash:preparationProof?digest(w.receipts.find(r=>r.id===w.activeAction.id)):null,originalWorkerToken:w.parallel.worker?.token??null,contractHash:digest(contract(w)),budgetContractHash:digest({maxCalls:b.maxCalls,maxTokens:b.maxTokens,projectIds:b.projectIds}),baselineSelectedRuns:w.selectedRuns,createdAt:now(),updatedAt:now(),events:[{phase:'PREPARED',at:now()}]};
   if(previous){await controls.create(previous.id,previous);await controls.update('current',old=>{if(old.id!==previous.id||!final.has(old.phase))fail('RUNTIME_MAINTENANCE_BUSY','维护归属已变化');return c;});}else await controls.create('current',c);
   return completeBegin(c);
  },
  async userPause({workflowId,runId}){
   let c;try{c=await current();}catch(e){if(e.code==='ENOENT')return null;throw e;}
   if(!active(c)||workflowId&&workflowId!==c.workflowId)return null;
   if(runId){const w=await workflows.read(c.workflowId);if(!Object.values(w.selectedRuns).includes(runId))return null;}
   return change(d=>active(d)?({...d,userPauseRequestedAt:d.userPauseRequestedAt??now()}):d);
  },
  async status(){
   const c=await current(),w=await workflows.read(c.workflowId),allRuns=await documents(dataRoot),ledgers=await documents(budgetDirectory),blockers=[];
   for(const r of allRuns){
    if((r.operations??[]).some(unsafe))blockers.push({code:'RUN_IN_FLIGHT',runId:r.id});
    if(r.web?.owner||r.web?.reserved||(r.web?.reservedAttemptIds??[]).length)blockers.push({code:'RUN_OWNER_OR_RESERVATION',runId:r.id});
   }
   for(const l of ledgers)for(const a of l.attempts??[])if(a.status==='DISPATCHING')blockers.push({code:'LEDGER_DISPATCHING',budgetId:l.id,attemptId:a.id});
   if(w.activeAction&&w.status==='RUNNING')blockers.push({code:'WORKFLOW_ACTION',actionId:w.activeAction.id});
   if(c.userPauseRequestedAt)blockers.push({code:'USER_PAUSE'});
   if(digest(contract(w))!==c.contractHash)blockers.push({code:'CONTRACT_CHANGED'});
   return {control:c,workflowId:w.id,authorization:w.parallel?.authorizedAt,phase:c.phase,safeToRetire:blockers.length===0,blockers};
  },
  holdRuns:async()=>{const c=await current();return holdRuns(c);},
  async recordFailure(error){return change(c=>({...c,lastError:{code:error.code??'RUNTIME_MAINTENANCE_ERROR',message:String(error.message).slice(0,500),at:now()}}));},
  async retargetCode({expectedCodeIdentity,codeIdentity,verification}){
   const c=await current();await assertUnchanged(c);
   if(c.phase!=='RETIRED'||c.loadingPid||c.loadedPid)fail('RUNTIME_MAINTENANCE_NOT_RETIRED','仅旧内核排空、尚未开始冷加载时可重绑审查后的源码。');
   if(c.codeIdentity!==expectedCodeIdentity)fail('RUNTIME_MAINTENANCE_CHANGED','原目标源码身份已变化，不覆盖其他维护决定。');
   if(typeof codeIdentity!=='string'||!codeIdentity||codeIdentity===expectedCodeIdentity||verification?.codeIdentity!==codeIdentity||typeof verification.evidenceFile!=='string'||!verification.evidenceFile||!(/^[a-f0-9]{64}$/).test(verification.evidenceSha256??''))fail('RUNTIME_MAINTENANCE_UNVERIFIED','缺少与新源码绑定的离线核验文件及摘要。');
   const s=await this.status();if(!s.safeToRetire)fail('RUNTIME_MAINTENANCE_BUSY','仍有在途、执行权或控制变化，不改目标源码。');
   return change(d=>{
    if(d.userPauseRequestedAt)fail('RUNTIME_MAINTENANCE_CANCELLED','用户已暂停，保留维护门。');
    if(d.id!==c.id||d.phase!=='RETIRED'||d.loadingPid||d.loadedPid||d.codeIdentity!==expectedCodeIdentity)fail('RUNTIME_MAINTENANCE_CHANGED','重绑时维护归属、阶段或源码已变化。');
    return event(d,'RETIRED',{codeIdentity,codeIdentityRevisions:[...(d.codeIdentityRevisions??[]),{from:expectedCodeIdentity,to:codeIdentity,verification:{...verification},at:now()}]});
   });
  },
  async expectLoad(pid){
   const c=await current();await assertUnchanged(c);
   if(!['RETIRED','LOADED'].includes(c.phase)||!Number.isSafeInteger(pid)||pid<=0||pid===c.targetPid)fail('RUNTIME_MAINTENANCE_KERNEL','仅安全退出后可登记新进程');
   if(c.phase==='LOADED'){try{process.kill(c.loadedPid,0);fail('RUNTIME_MAINTENANCE_OWNER','已验证的新内核仍活着，不改绑');}catch(e){if(e.code!=='ESRCH')throw e;}}
   return change(d=>({...d,phase:'RETIRED',loadingPid:pid,previousLoadedPid:d.loadedPid??null,resumeProof:null,resumeProofNonce:null,lastError:null}));
  },
  async retired({pid}){const c=await current();await assertUnchanged(c);if(pid!==c.targetPid)fail('RUNTIME_MAINTENANCE_CHANGED','旧执行者身份不符');const s=await this.status();if(!s.safeToRetire)fail('RUNTIME_MAINTENANCE_BUSY','原在途、owner、账本或动作未排空。');return change(d=>event(d,'RETIRED',{retiredPid:pid}));},
  async loaded({pid,codeIdentity,kernel}){
   const c=await current();await assertUnchanged(c);
   if(!Number.isSafeInteger(pid)||pid<=0||codeIdentity!==c.codeIdentity||kernel?.pid!==pid||kernel?.productionFeedbackResultVersion!==FEEDBACK_RESULT_VERSION||kernel?.maintenanceVersion!==RUNTIME_MAINTENANCE_VERSION)fail('RUNTIME_MAINTENANCE_KERNEL','实际加载内核身份或完整结果协议未核验。');
   if(Object.entries(c.requiredCapabilities??{}).some(([key,value])=>kernel[key]!==value))fail('RUNTIME_MAINTENANCE_KERNEL','新内核未实际加载目标能力；只改源码或HMR不算加载证明。');
   if(c.phase!=='RETIRED'||pid===c.targetPid||c.loadingPid!==pid)fail('RUNTIME_MAINTENANCE_KERNEL','必须由安全冷加载的新进程证明，不能把HMR当重载。');
   return change(d=>event(d,'LOADED',{loadedPid:pid,kernel}));
  },
  async requestResumeProof(){const c=await current();await assertUnchanged(c,{resuming:true});if(!['LOADED','RESUMING'].includes(c.phase))fail('RUNTIME_MAINTENANCE_NOT_LOADED','内核尚未加载');return change(d=>({...d,resumeProofNonce:randomUUID(),resumeProof:null,lastError:null}));},
  async recordResumeProof({pid,nonce,proof}){
   const c=await current(),w=await assertUnchanged(c,{resuming:true});
   if(pid!==c.loadedPid||nonce!==c.resumeProofNonce||proof?.authorization!==c.authorization||proof?.sourceVersion!==w.sourceVersion||proof?.actorVerified!==true)fail('RUNTIME_MAINTENANCE_UNVERIFIED','当前来源或原启动者权限未核验');
   return change(d=>{if(d.id!==c.id||d.resumeProofNonce!==nonce||d.userPauseRequestedAt)fail('RUNTIME_MAINTENANCE_CHANGED','恢复核验归属变化');return {...d,resumeProof:{...proof,pid,nonce,selectedRunsHash:digest(w.selectedRuns),at:now()}};});
  },
  async activateUnfinished(){
   const {rebuildFrozenRequest,hasPendingSavedResponse}=await import('./storyboard-v4/core/pipeline.mjs');
   const c=await current(),w=await assertUnchanged(c);if(c.phase!=='LOADED')fail('RUNTIME_MAINTENANCE_NOT_LOADED','新内核未核验。');
   const activated=[];
   for(const id of Object.values(w.selectedRuns)){
    const before=await runs.read(id);if(before.status==='text_ready_for_review')continue;
    if(before.web?.sourceStale||before.web?.stopped||before.web?.owner||before.web?.reserved||(before.web?.reservedAttemptIds??[]).length||before.operations.some(unsafe)||before.operations.some(op=>hasPendingSavedResponse(before,op)))fail('RUNTIME_MAINTENANCE_BUSY','未完成任务还有未结回包或源变化，不能激活。');
    if(!before.production||!before.rulesSnapshot)fail('RUNTIME_MAINTENANCE_CHANGED','未完成任务缺少冻结生产框架。');
    // Loading the latest kernel is not authority to migrate an old model contract.
    // Unmarked historical runs retain the previously approved v1 activation path.
    const version=activationVersion(before),next=structuredClone(before);next.rulesSnapshot.productionFeedbackResultVersion=version;next.production.feedbackResultVersion=version;
    const native=[];
    for(const op of before.operations){
     if(plainNativeUsage(op))continue;
     const oldRequest=rebuildFrozenRequest(before,op),newRequest=rebuildFrozenRequest(next,op);
     if(digest(oldRequest)!==digest(newRequest))fail('RUNTIME_MAINTENANCE_REQUEST_DRIFT','激活会改变已付冻结请求，拒绝写入。');
     const dir=path.join(dataRoot,'attempts',op.attemptId),[requestBytes,receiptBytes]=await Promise.all([readFile(path.join(dir,'request.json')),readFile(path.join(dir,'receipt.json'))]);
     const request=JSON.parse(requestBytes),receipt=JSON.parse(receiptBytes);
     if(receipt.state!=='FINAL'||receipt.requestOutcome!=='RESPONDED'||['prompt','instructions','schema','inputHash','promptHash','instructionHash'].some(k=>digest(request[k]??null)!==digest(oldRequest[k]??null)))fail('RUNTIME_MAINTENANCE_REQUEST_DRIFT','原生请求/FINAL与冻结作业不符。');
     native.push({attemptId:op.attemptId,requestHash:digest(requestBytes.toString('base64')),receiptHash:digest(receiptBytes.toString('base64'))});
    }
    const saved=await runs.update(id,d=>{
     if(digest(d)!==digest(before))fail('RUNTIME_MAINTENANCE_CHANGED','激活时任务修订变化。');
     if(d.production.feedbackResultVersion===version&&d.rulesSnapshot.productionFeedbackResultVersion===version)return d;
     d.rulesSnapshot.productionFeedbackResultVersion=version;d.production.feedbackResultVersion=version;
     d.runtimeActivations=[...(d.runtimeActivations??[]),{maintenanceId:c.id,version,at:now(),oldOperationsPreserved:native}];return d;
    });
    activated.push({runId:id,oldNativeRequests:native.length,documentRevision:saved.documentRevision});
   }
   return change(d=>({...d,activated}));
  },
  async recoverPreDispatchFailures(){
   const c=await current(),w=await assertUnchanged(c);if(c.phase!=='LOADED')fail('RUNTIME_MAINTENANCE_NOT_LOADED','新内核未核验。');
   const ledger=await budgets.read(w.budgetId),recovered=[];
   const action=w.activeAction,receipt=w.receipts?.find(r=>r.id===action?.id);
   if(action?.kind==='STORYBOARD_CREATE'&&receipt?.error?.code==='RUNTIME_MAINTENANCE'&&receipt.error.requestOutcome==='NOT_SENT'){
    const proof=await unboundCreateProof(w,ledger);if(!proof)fail('PRE_DISPATCH_UNPROVEN','维护拒绝的创建仍有绑定、账本或原生证据，不能重建。');
    await workflows.update(w.id,d=>{
     assertContract(c,d);if(d.revision!==w.revision||!d.paused||d.parallel.enabled||digest(d.activeAction)!==digest(action)||digest(d.receipts.find(r=>r.id===action.id))!==digest(receipt))fail('RUNTIME_MAINTENANCE_CHANGED','免费创建恢复时原动作或控制变化。');
     Object.assign(d.receipts.find(r=>r.id===action.id),{status:'NOT_SENT',localDispatchProof:proof,recoveredAt:now(),recoveryMethod:'VERIFIED_LOCAL_PRE_DISPATCH'});d.activeAction=null;d.status='READY';d.revision++;d.updatedAt=now();return d;
    });
    recovered.push({actionId:action.id,episodeNumber:action.episodeNumber,kind:'UNBOUND_MAINTENANCE_REFUSED_CREATE',newAttemptCreated:false,proof});
   }
   for(const id of Object.values(w.selectedRuns)){
    const r=await runs.read(id);if(r.status==='text_ready_for_review')continue;
    if(['ERR_REQUIRE_ESM_RACE_CONDITION','ERR_REQUIRE_ASYNC_MODULE','ERR_MODULE_NOT_FOUND','RUNTIME_RELOAD_REQUIRED'].includes(r.web?.error?.code)&&r.web.progress==='failed'&&r.operations.length&&r.operations.every(o=>o.status==='completed'&&!o.error)&&!isVerifiedPreparationFailure(r)){
     if(r.web.owner||r.web.reserved||r.web.reservedAttemptIds?.length||ledger.attempts.some(a=>a.status==='DISPATCHING'))fail('PRE_DISPATCH_UNPROVEN','仍有在途或保留项，准备失败不能免费解锁');
     const native=[];for(const op of r.operations){const dir=path.join(dataRoot,'attempts',op.attemptId),bytes=await readFile(path.join(dir,'receipt.json')),receipt=JSON.parse(bytes);if(receipt.state!=='FINAL'||receipt.requestOutcome!=='RESPONDED')fail('PRE_DISPATCH_UNPROVEN','既有作业没有最终原生回执');native.push({attemptId:op.attemptId,receiptHash:digest(bytes.toString('base64'))});}
     const proof=sealPreparationProof(r,{allNativeFinal:true,native,workflowId:w.id,budgetId:w.budgetId});
     await runs.update(id,d=>{if(digest(d)!==digest(r))fail('RUNTIME_MAINTENANCE_CHANGED','准备失败核验期间版本变化');d.web.localPreparationProof=proof;return d;});
     recovered.push({runId:id,kind:'PREPARATION_BEFORE_NEXT_OPERATION',newAttemptCreated:false,proof});
    }
    for(const op of r.operations){
     if(!['ERR_REQUIRE_ESM_RACE_CONDITION','ERR_REQUIRE_ASYNC_MODULE','ERR_MODULE_NOT_FOUND','RUNTIME_RELOAD_REQUIRED'].includes(op.error?.code)||isVerifiedUnsent(op)||op.error?.requestOutcome==='NOT_SENT')continue;
     if(op.status!=='completed'||r.web.owner||r.web.reserved||r.web.reservedAttemptIds?.length||r.candidates.some(c=>c.attemptId===op.attemptId)||ledger.attempts.some(a=>a.id===op.attemptId))fail('PRE_DISPATCH_UNPROVEN','有候选、账本、owner或未结作业，不能证明零派发。');
     try{await readdir(path.join(dataRoot,'attempts',op.attemptId));fail('PRE_DISPATCH_UNPROVEN','原生目录存在，先核原回执，不按缺少账本猜零费用。');}catch(e){if(e.code!=='ENOENT')throw e;}
     const proof=sealUnsentProof(op,{scope:'BOUND_MODEL_ADAPTER',budgetId:w.budgetId,nativeDirectoryAbsent:true,ledgerAttemptAbsent:true,candidateAbsent:true,workflowId:w.id});
     await runs.update(id,d=>{const target=d.operations.find(o=>o.attemptId===op.attemptId);if(digest(target)!==digest(op)||d.web.owner||d.web.reserved||d.web.reservedAttemptIds?.length)fail('RUNTIME_MAINTENANCE_CHANGED','作业在零派发核对时变化');target.localDispatchProof=proof;return d;});
     recovered.push({runId:id,attemptId:op.attemptId,proof});
    }
   }
   return change(d=>({...d,unsentRecoveries:[...(d.unsentRecoveries??[]),...recovered]}));
  },
  async resume(){
   let c=await current();if(c.phase==='RESUMED'){const w=await workflows.read(c.workflowId);assertContract(c,w);if(c.userPauseRequestedAt||w.paused||!w.parallel.enabled)fail('RUNTIME_MAINTENANCE_CANCELLED','用户已改变恢复状态');return c;}
   const w=await assertUnchanged(c,{resuming:true});
   if(!['LOADED','RESUMING'].includes(c.phase))fail('RUNTIME_MAINTENANCE_NOT_LOADED','尚无新进程实际加载证明，不恢复付费准入。');
   const proof=c.resumeProof;
   if(!proof||proof.pid!==c.loadedPid||proof.nonce!==c.resumeProofNonce||proof.selectedRunsHash!==digest(w.selectedRuns)||Date.now()-Date.parse(proof.at)>30000)fail('RUNTIME_MAINTENANCE_UNVERIFIED','缺少当前来源、权限及选定版本的恢复核验，保持维护门。');
   const s=await this.status();if(!s.safeToRetire)fail('RUNTIME_MAINTENANCE_BUSY','存在未结请求或执行权，保持维护门。');
   if(c.issueStopProof)for(const {runId} of c.issueStopProof.checks){const r=await runs.read(runId);if(r.web?.sourceStale||r.production?.blocking||r.production?.pendingRepair||!['MATCHED','NOT_CONSUMED','NOT_CONTINUOUS','NO_PREDECESSOR'].includes(r.production?.boundaryCheck?.status))fail('RUNTIME_MAINTENANCE_ISSUES','原停派门禁尚未通过有效证据闭合，不因加载补丁恢复派发。');}
   if(c.deliveryStopProof&&digest(settledDeliveryChecks(w,await budgetUsage.read(w.budgetId),await documents(dataRoot)))!==digest(c.deliveryStopProof.checks))fail('RUNTIME_MAINTENANCE_ISSUES','原导出停派的已采用稿、实际承接或结算证据已变化，保持维护门。');
   for(const id of Object.values(w.selectedRuns)){const r=await runs.read(id);if(r.status!=='text_ready_for_review'&&(!isFeedbackResultVersion(r.production?.feedbackResultVersion)||r.rulesSnapshot?.productionFeedbackResultVersion!==r.production.feedbackResultVersion))fail('RUNTIME_MAINTENANCE_UNVERIFIED','未完成版本尚未安全激活其冻结的完整结果协议');}
   if(c.phase==='LOADED')c=await change(d=>{if(d.userPauseRequestedAt)fail('RUNTIME_MAINTENANCE_CANCELLED','用户已暂停');return event(d,'RESUMING');});
   for(const id of Object.values(w.selectedRuns)){
    const r=await runs.read(id);if(r.web?.runtimeMaintenance?.id!==c.id)continue;
    await runs.update(id,d=>{if(d.web.runtimeMaintenance?.id!==c.id||d.web.stopped||d.web.sourceStale)fail('RUNTIME_MAINTENANCE_CHANGED','本集控制状态已变化');d.web.pauseRequested=d.web.runtimeMaintenance.priorPauseRequested;delete d.web.runtimeMaintenance;if(d.web.progress==='paused')d.web.progress=d.status;return d;});
   }
   // Control lock serializes user-pause intent with authority restoration. The
   // RESUMING gate remains closed if the process dies before the final write.
   await controls.withLockedRead('current',async latest=>{
    const fresh=await assertUnchanged(latest,{resuming:true});if(latest.phase!=='RESUMING')fail('RUNTIME_MAINTENANCE_CHANGED','恢复阶段变化');
    await workflows.update(w.id,d=>{assertContract(latest,d);if(d.revision!==fresh.revision)fail('RUNTIME_MAINTENANCE_CHANGED','恢复前修订变化');if(d.runtimeMaintenance.phase==='RESUMING'&&!d.paused&&d.parallel.enabled)return d;d.paused=false;d.parallel.enabled=true;d.parallel.lastStop=null;d.runtimeMaintenance={...d.runtimeMaintenance,phase:'RESUMING'};d.revision++;d.updatedAt=now();return d;});
   });
   await workflows.update(w.id,d=>{assertContract(c,d);if(d.paused||!d.parallel.enabled)fail('RUNTIME_MAINTENANCE_CANCELLED','恢复时用户已暂停');d.runtimeMaintenance.phase='RESUMED';return d;});
   return change(d=>{if(d.userPauseRequestedAt)fail('RUNTIME_MAINTENANCE_CANCELLED','用户已暂停');return event(d,'RESUMED');});
  }
 };
}
