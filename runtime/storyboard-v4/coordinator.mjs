import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir,open,readFile,readdir,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {hostname} from 'node:os';
import {createEngine,PLAN_VALIDATION_VERSION,isUnresolvedOperation,hasExecutionDrafts,hasPendingSavedResponse} from './core/pipeline.mjs';
import {createStore} from './core/store.mjs';
import {runModel,readAttemptEvidence} from './core/runner.mjs';
import {resolveSelection,selectionFingerprint,confirmSelection} from './core/selection.mjs';
import {defaultChoice,normalizeSettings} from './core/core.mjs';
import {fail,digest} from './core/shared.mjs';
import {acquireRuntimeLease} from './runtime-lease.mjs';
import {readyAuthorCallGroups} from './core/author-call-groups.mjs';
import {feedbackOnlyFailure,repairProblemKey as problemKey} from '../feedback-repair.mjs';
import {PRODUCTION_FEEDBACK_VALIDATION_VERSION} from '../episode-boundary.mjs';

const shared=globalThis[Symbol.for('storyboard-v4.coordinator')]??={owners:new Map(),leaseTokens:new Map(),leaseClaims:new Map(),inFlight:0,queued:[]};
const {owners,leaseTokens,leaseClaims,queued}=shared;
const pausedRuns=shared.pausedRuns??=new Set();
const runtimeLeases=shared.runtimeLeases??=new Map();
const inFlightByRun=shared.inFlightByRun??=new Map(),inFlightByEpisode=shared.inFlightByEpisode??=new Map();
const defaults={maxCalls:32,maxTokens:300000};
function budgetOf(value={}){
 const b={...defaults,...value};
 if(!Number.isSafeInteger(b.maxCalls)||b.maxCalls<0||b.maxCalls>128||!Number.isSafeInteger(b.maxTokens)||b.maxTokens<0||b.maxTokens>2000000)fail('BUDGET','预算范围无效');
 return b;
}
const episodeKey=(root,b)=>`${path.resolve(root)}:${b.projectId}:${b.episodeId}`;
const unresolved=d=>d.candidates.filter(c=>['needs_repair','needs_dependency_repair'].includes(c.status)&&!c.resolvedBy);
const covered=(d,stage)=>new Set(d.adopted.filter(a=>a.stage===stage).flatMap(a=>a.packageIds));
function hasEpisodeFinish(d){
 const packages=new Set(d.plan.workPackages.map(w=>w.id));
 // Retain the accepted whole-episode pass across later local repairs, but never
 // carry it through an explicit draft archival or an adopted replacement plan.
 const archived=new Set((d.web.archives||[]).flatMap(a=>(a.adopted||[]).flatMap(x=>[x.candidateId,...(x.candidateIds||[])])));
 const boundary=d.candidates.findLastIndex(c=>archived.has(c.id)||c.stage==='plan'&&c.status==='adopted');
 return d.candidates.slice(boundary+1).some(c=>{
  if(c.stage!=='finish'||c.status!=='adopted'||c.executionProjectionVersion)return false;
  const op=d.operations.find(o=>o.attemptId===c.attemptId);
  return op?.stage==='finish'&&!op.executionProjectionVersion&&op.packageIds.length===packages.size&&op.packageIds.every(id=>packages.has(id));
 });
}
function pendingPackagesInSourceOrder(d){
 const adopted=new Set(d.adopted.flatMap(a=>a.packageIds)),rank=new Map(d.source.sourceRows.map((row,i)=>[row.id,i]));
 const first=w=>Math.min(...w.sourceRefs.map(ref=>rank.get(ref)));
 return d.plan.workPackages.filter(w=>!adopted.has(w.id)).sort((a,b)=>first(a)-first(b));
}
function nextAuthorCallGroup(d){
 const first=pendingPackagesInSourceOrder(d)[0];
 const group=first&&readyAuthorCallGroups(d).find(ids=>ids[0]===first.id);
 // A short-tail transport optimization must not hold an otherwise ready parent
 // behind its child's scoped need. Never skip the first blocked source package.
 const blockedAt=group?.findIndex(id=>productionBlock(d,'author',[id]));
 return blockedAt>0?group.slice(0,blockedAt):group;
}
export function productionBlock(d,stage,packageIds=[]){
 const production=d.production;if(!production)return null;
 // Older aggregate-only snapshots cannot safely prove that a block is scoped.
 if(production.globalBlocking||production.boundaryCheck?.status==='CONSTRAINT_CONFLICT'||production.blocking&&production.globalBlocking!==false)return 'upstream_review';
 const needs=(production.needs||[]).filter(n=>n.blocking&&!n.resolved);
 if(!needs.length)return null;
 const packages=new Set((d.plan?.workPackages||[]).map(w=>w.id));
 if(!d.plan||needs.some(n=>!Array.isArray(n.packageIds)||!n.packageIds.length||n.packageIds.some(id=>!packages.has(id))))return 'upstream_review';
 if(stage==='plan'||stage&&needs.some(n=>n.packageIds.some(id=>packageIds.includes(id))))return 'upstream_review';
 return null;
}
const isLive=isUnresolvedOperation;
const atRunBoundary=(d,allowReservedBudget=false)=>d.web.stopped||d.web.pauseRequested||d.web.sourceStale||['failed','unknown','usage_review','upstream_review'].includes(d.web.progress)||(!allowReservedBudget&&d.web.progress==='budget_stop')||d.operations.some(o=>o.status==='unknown'&&isLive(o));
function changeSlots(key,groupKey,delta){
 shared.inFlight+=delta;
 for(const [counts,id] of [[inFlightByRun,key],[inFlightByEpisode,groupKey]]){const count=(counts.get(id)||0)+delta;if(count)counts.set(id,count);else counts.delete(id);}
}
function settleAcknowledgedStop(d){
 const acknowledgedFailure=['unknown','failed','paused'].includes(d.web.progress)&&d.operations.some(o=>['failed','timeout'].includes(o.cancelAcknowledgement?.kind));
 if((d.web.stopped||acknowledgedFailure)&&!d.operations.some(isLive)){
  d.web.progress='paused';
  if(['UNKNOWN','ATTEMPT_UNRESOLVED','ABORTED','TIMEOUT','CLI_FAILED'].includes(d.web.error?.code))d.web.error=null;
 }
 return d;
}
function executionView(value){
 const time=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(Date.parse(v)).toISOString():null;
 const startedAt=time(value?.startedAt);
 if(!value||!['starting','waiting','generating','receiving','completed','failed'].includes(value.phase)||!startedAt)return null;
 const count=v=>Number.isSafeInteger(v)&&v>=0?v:null;
 const events=['thread.started','turn.started','turn.completed','turn.failed','item.started','item.updated','item.completed','error','other'];
 return {phase:value.phase,startedAt,lastEventAt:time(value.lastEventAt),lastProgressAt:time(value.lastProgressAt),eventCount:count(value.eventCount),timeoutKind:['startup','idle','total'].includes(value.timeoutKind)?value.timeoutKind:null,
  limits:Object.fromEntries(['startupMs','idleMs','totalMs'].map(k=>[k,count(value.limits?.[k])])),
  workload:{stage:['plan','author','finish'].includes(value.workload?.stage)?value.workload.stage:'unknown',promptChars:count(value.workload?.promptChars),unitCount:count(value.workload?.unitCount)},
  lastEventType:events.includes(value.lastEventType)?value.lastEventType:null};
}
function claimLease(directory){const pending=leaseClaims.get(directory);if(pending)return pending;const task=claimLeaseInner(directory).finally(()=>leaseClaims.delete(directory));leaseClaims.set(directory,task);return task;}
async function claimLeaseInner(directory){
 const current=runtimeLeases.get(directory);
 if(current?.releasing){await current.releasing;return claimLeaseInner(directory);}
 if(current){current.lease.assertHeld();return current;}
 const lease=await acquireRuntimeLease(directory);
 try{const token=await claimLegacyOwner(directory),record={lease,token,users:0,releasing:null};runtimeLeases.set(directory,record);return record;}
 catch(error){await lease.release();throw error;}
}
async function claimLegacyOwner(directory){
 const file=path.join(directory,'.coordinator-owner.json');
 await mkdir(directory,{recursive:true,mode:0o700});
 for(let tries=0;tries<4;tries++){
  const token=randomUUID();
  try{const handle=await open(file,'wx',0o600);try{await handle.writeFile(JSON.stringify({pid:process.pid,host:hostname(),token}));await handle.sync();}finally{await handle.close();}leaseTokens.set(directory,token);return token;}
  catch(error){if(error.code!=='EEXIST')throw error;}
  const previous=await readFile(file,'utf8').catch(error=>error.code==='ENOENT'?null:Promise.reject(error));if(previous===null)continue;
  let owner;try{owner=JSON.parse(previous);}catch{fail('LEASE_UNKNOWN','执行者记录无法核验');}
  if(!Number.isSafeInteger(owner.pid)||owner.pid<=0||owner.host!==hostname()||typeof owner.token!=='string'||!owner.token)fail('LEASE_UNKNOWN','执行者记录无法核验');
  if(owner.pid===process.pid&&leaseTokens.get(directory)===owner.token)return owner.token;
  try{process.kill(owner.pid,0);fail('LEASE_BUSY','另一进程持有执行权');}catch(error){if(error.code!=='ESRCH')throw error;}
  if(await readFile(file,'utf8').catch(()=>null)!==previous)continue;
  try{await rename(file,path.join(directory,`.coordinator-owner.stale-${randomUUID()}.json`));}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 fail('LEASE_BUSY','执行者记录正在变化');
}
async function releaseLease(directory,record){
 record.users--;if(record.users>0)return;
 record.releasing??=(async()=>{try{
  record.lease.assertHeld();const file=path.join(directory,'.coordinator-owner.json'),owner=await readFile(file,'utf8').then(JSON.parse).catch(()=>null);
  if(owner?.pid===process.pid&&owner.host===hostname()&&owner.token===record.token)await unlink(file);
 }finally{if(runtimeLeases.get(directory)===record)runtimeLeases.delete(directory);if(leaseTokens.get(directory)===record.token)leaseTokens.delete(directory);await record.lease.release();}})();
 await record.releasing;
}

export function createCoordinator({dataRoot,modelRunner=runModel,executable,maxConcurrent=4,beforeExecute=async()=>true,beforeAuthorAdmission=null,loadProductionContext=null,onSettled=null,preflightTimeoutMs=45000}={}){
 if(typeof dataRoot!=='string'||!dataRoot||!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>4)fail('COORDINATOR_CONFIG','调度配置无效');
 if(!Number.isSafeInteger(preflightTimeoutMs)||preflightTimeoutMs<1||preflightTimeoutMs>120000)fail('COORDINATOR_CONFIG','前置核验时限无效');
 const directory=path.resolve(dataRoot),store=createStore(directory,{trackRevision:true}),activeRuns=new Map(),maxPerEpisode=1;
 const pendingWrites=new Set(),currentAttempts=new Map(),executingAttempts=new Set();
 const preflights=new Map();
 const cancelPreflights=(id,code='PAUSED')=>{for(const controller of preflights.get(id)||[])controller.abort(Object.assign(new Error('前置核验已取消，未发送模型请求'),{code,requestOutcome:'NOT_SENT'}));};
 async function checkSource(id,binding){
  if(closed)throw Object.assign(new Error('调度已关闭'),{code:'SHUTDOWN',requestOutcome:'NOT_SENT'});
  const controller=new AbortController(),checks=preflights.get(id)||new Set();checks.add(controller);preflights.set(id,checks);
  const timer=setTimeout(()=>controller.abort(Object.assign(new Error('读取原文/前情的核验未及时完成；未发送模型请求，可检查资料后继续。'),{code:'PREFLIGHT_TIMEOUT',requestOutcome:'NOT_SENT'})),preflightTimeoutMs);
  try{return await Promise.race([Promise.resolve().then(()=>{controller.signal.throwIfAborted();return beforeExecute(binding,{signal:controller.signal});}),new Promise((_,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}))]);}
  finally{clearTimeout(timer);checks.delete(controller);if(!checks.size)preflights.delete(id);}
 }
 let closed=false,leaseRef=null,leasePending=null,shutdownTask=null;
 async function holdLease(){if(closed)fail('SHUTDOWN','调度已关闭');if(leaseRef){leaseRef.lease.assertHeld();return;}
  leasePending??=claimLease(directory).then(record=>{record.users++;leaseRef=record;}).finally(()=>{leasePending=null;});await leasePending;
  if(closed)fail('SHUTDOWN','调度已关闭');
 }
 const cancelled=new Set(),heldSlots=new Map();
 const pauseKey=id=>`${directory}:${id}`;
 const limitedRunner=async(request,options)=>{
  let groupKey;
  try{if(!leaseRef)fail('LEASE_LOST','尚未持有执行锁');leaseRef.lease.assertHeld();groupKey=episodeKey(directory,(await read(options.runId)).web.binding);}catch(error){throw Object.assign(error,{requestOutcome:'NOT_SENT'});}
  const key=pauseKey(options.runId),shouldDispatch=()=>{try{leaseRef.lease.assertHeld();
   if(closed||pausedRuns.has(key)||cancelled.has(options.attemptId))return false;
   // The runner calls this synchronously again after local preparation, immediately before sending.
   const current=JSON.parse(readFileSync(path.join(directory,'documents',`${options.runId}.json`),'utf8'));
   return !dispatchBlock(current,request.stage,options.attemptId,request.packageIds,request.feedbackRepair?.candidateId);
  }catch{return false;}};
  if(!shouldDispatch()||options.signal?.aborted)throw Object.assign(new Error('未派发请求已撤回'),{code:'PAUSED',requestOutcome:'NOT_SENT'});
  await new Promise((resolve,reject)=>{const item={resolve,reject,signal:options.signal,limit:maxConcurrent,episodeLimit:maxPerEpisode,key,groupKey,attemptId:options.attemptId};
   const abort=()=>{const index=queued.indexOf(item);if(index>=0){queued.splice(index,1);reject(Object.assign(new Error('已取消'),{code:'ABORTED',requestOutcome:'NOT_SENT'}));}};
   item.abort=abort;options.signal?.addEventListener('abort',abort,{once:true});queued.push(item);pump();});
  // Keep the slot through engine settlement so a response's new boundary is visible before pumping.
  heldSlots.set(options.attemptId,{key,groupKey});
  if(!shouldDispatch()||options.signal?.aborted)throw Object.assign(new Error('未派发请求已撤回'),{code:'PAUSED',requestOutcome:'NOT_SENT'});
  executingAttempts.add(options.attemptId);
  try{return await modelRunner(request,{...options,shouldDispatch,...(executable?{executable}:{})});}
  finally{executingAttempts.delete(options.attemptId);}
 };
 function pump(){for(;;){let selected=-1,least=Infinity;
  // ponytail: scan the small local queue; equal occupancy keeps its original FIFO order.
  for(let i=0;i<queued.length;){const item=queued[i];
   if(item.signal?.aborted||pausedRuns.has(item.key)){queued.splice(i,1);item.signal?.removeEventListener('abort',item.abort);item.reject(Object.assign(new Error('未派发请求已撤回'),{code:'PAUSED',requestOutcome:'NOT_SENT'}));continue;}
   const occupied=inFlightByEpisode.get(item.groupKey)||0;
   if(shared.inFlight<item.limit&&occupied<item.episodeLimit&&occupied<least){selected=i;least=occupied;}i++;
  }
  if(selected<0)return;
  const [item]=queued.splice(selected,1);item.signal?.removeEventListener('abort',item.abort);changeSlots(item.key,item.groupKey,1);item.resolve();
 }}
 function withdrawQueued(id){const key=pauseKey(id);for(let i=queued.length-1;i>=0;i--){const item=queued[i];if(item.key!==key)continue;queued.splice(i,1);item.signal?.removeEventListener('abort',item.abort);item.reject(Object.assign(new Error('暂停前尚未派发'),{code:'PAUSED',requestOutcome:'NOT_SENT'}));}}
 const engine=createEngine({directory,modelRunner:limitedRunner});
 const update=(id,fn)=>store.update(id,fn);
 const read=id=>engine.read(id);
 async function assertEpisodeResolved(id,binding){
  const names=await readdir(path.join(directory,'documents')).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error));
  for(const name of names){if(!name.endsWith('.json')||name===`${id}.json`)continue;
   const other=await read(name.slice(0,-5));
   if(other.web?.binding?.projectId===binding.projectId&&other.web?.binding?.episodeId===binding.episodeId&&other.operations.some(isLive))fail('EPISODE_UNRESOLVED','同集其它任务仍有未结请求，请先核对回执');
  }
 }
 async function changeState(id,patch){return update(id,d=>{d.web={...d.web,...patch};return d;});}
 function usage(d){const seen=new Set();let knownTokens=0,unknown=false,blockingUnknown=false;
  for(const op of d.operations){if(seen.has(op.attemptId))continue;seen.add(op.attemptId);const c=d.candidates.findLast(c=>c.attemptId===op.attemptId),n=(c?.receipt||op.receipt)?.usage?.totalTokens;
   if(Number.isSafeInteger(n)&&n>=0)knownTokens+=n;else if(op.status!=='running'&&op.error?.requestOutcome!=='NOT_SENT'){unknown=true;if(op.cancelAcknowledgement?.acceptUnknownUsage!==true)blockingUnknown=true;}}
  return {calls:seen.size,knownTokens,tokens:unknown?null:knownTokens,unknown,blockingUnknown};}
 function dispatchBlock(d,stage,attemptId,packageIds=[],feedbackCandidateId=null){
  if(atRunBoundary(d,Boolean(attemptId)))return 'boundary';
  const spent=usage(d),committed=new Set([...d.operations.map(o=>o.attemptId),...(d.web.reservedAttemptIds||[])]);
  // An already admitted request owns one slot; a full call budget must not count that slot twice.
  if(attemptId)committed.delete(attemptId);
  if(spent.blockingUnknown)return 'usage_review';
  if(committed.size>=d.web.budget.maxCalls||spent.knownTokens>=d.web.budget.maxTokens)return 'budget_stop';
  const upstream=productionBlock(d,stage,packageIds);if(upstream)return upstream;
  return stage==='author'&&unresolved(d).length&&!feedbackCandidateId?'needs_repair':null;
 }
 function markBlock(d,blocked){if(blocked==='usage_review'){d.web.progress=blocked;d.web.error={code:'USAGE_UNKNOWN',message:'已有回包已保存，但用量未完整返回。请核对下方用量确认；不重跑已完成步骤，未知费用不会记成零。'};}else if(blocked==='upstream_review'){d.web.progress=blocked;d.web.error={code:'PRODUCTION_DEPENDENCY',message:'当前创作范围有带坐标的材料缺口或硬约束冲突；在首个受阻包前暂停，已有稿件保留。'};}else if(blocked==='budget_stop')d.web.progress=blocked;return d;}
 async function dispatch(id,stage,packageIds=[],issues=[],finishMode='full',feedbackCandidateId=null){
  let d=await read(id);if(atRunBoundary(d)||(stage==='author'&&unresolved(d).length&&!feedbackCandidateId))return d;
  const attemptId=randomUUID();let admitted=false;
  try{
  if(!(await checkSource(id,d.web.binding))){await changeState(id,{sourceStale:true,progress:'source_stale'});return read(id);}
  if(stage==='author'&&beforeAuthorAdmission&&!feedbackCandidateId){
   // Close future shared choices before freezing the first creative request.
   // A proposal accepted immediately before admission must be re-read into it.
   await beforeAuthorAdmission(d.web.binding,d);d=await syncProduction(id);
  }
  await update(id,x=>{const reserved=x.web.reservedAttemptIds||[],blocked=dispatchBlock(x,stage,undefined,packageIds,feedbackCandidateId);
   if(blocked)return markBlock(x,blocked);
   x.web.reservedAttemptIds=[...reserved,attemptId];x.web.reserved=x.web.reservedAttemptIds.length;x.web.progress='running';admitted=true;return x;});
  if(!admitted)return read(id);
  const current=await read(id),blocked=dispatchBlock(current,stage,attemptId,packageIds,feedbackCandidateId);if(blocked){await update(id,x=>atRunBoundary(x)?x:markBlock(x,blocked));return read(id);}currentAttempts.set(attemptId,id);return await engine.execute(id,{stage,packageIds,attemptId,issues,finishMode,feedbackCandidateId});}
  catch(error){const outcome=admitted?error.requestOutcome:'NOT_SENT';await update(id,current=>{
   if(outcome==='NOT_SENT'){const blocked=dispatchBlock(current,stage,admitted?attemptId:undefined,packageIds);if(atRunBoundary(current)||blocked)return atRunBoundary(current)?current:markBlock(current,blocked);}
   if(!current.web.stopped&&!current.web.pauseRequested)current.web={...current.web,progress:outcome==='UNKNOWN'?'unknown':'failed',error:{code:error.code||'RUNNER_ERROR',message:error.message}};
   return current;
  });return read(id);}
   finally{if(admitted)try{await update(id,x=>{x.web.reservedAttemptIds=(x.web.reservedAttemptIds||[]).filter(x=>x!==attemptId);x.web.reserved=x.web.reservedAttemptIds.length;return x;});}
    finally{currentAttempts.delete(attemptId);cancelled.delete(attemptId);const held=heldSlots.get(attemptId);if(held){heldSlots.delete(attemptId);changeSlots(held.key,held.groupKey,-1);pump();}}
   }
 }
 async function syncProduction(id){
  const d=await read(id);if(!d.production||!loadProductionContext)return d;
  const context=await loadProductionContext(d.web.binding,d);
  try{return context?await engine.refreshProduction(id,context):d;}
  catch(error){if(error.code==='PRODUCTION_REVISION')return read(id);throw error;}
 }
 async function advance(id,mode){
  for(let steps=0;steps<100;steps++){let d=await syncProduction(id);if(atRunBoundary(d))return d;
   const blocked=productionBlock(d);if(blocked){await update(id,x=>markBlock(x,blocked));return read(id);}
   if(d.production?.pendingRepair){
    const pending=d.production.pendingRepair,prior=d.operations.at(-1),dependencyCandidate=unresolved(d).findLast(c=>c.status==='needs_dependency_repair');
    if(dependencyCandidate?.requiredPackageIds?.some(id=>!pending.packageIds.includes(id))){pending.packageIds=[...new Set([...pending.packageIds,...dependencyCandidate.requiredPackageIds])];pending.versionId=digest({previous:pending.versionId,packages:pending.packageIds});}
    if(prior?.issues?.some(issue=>issue.productionVersion===pending.versionId)&&prior.status==='completed'){
     await changeState(id,{progress:'continuity_review',error:{code:'CONTINUITY_NO_PROGRESS',message:'局部核对后仍有承接差异，已停止重复调用，请核对具体依赖。'}});return read(id);
    }
    await dispatch(id,'finish',pending.packageIds,[{code:pending.reason,scope:pending.packageIds,changedKeys:pending.changedKeys,productionVersion:pending.versionId,problem:'仅核对并修正所消费的跨集入口或材料变化。原文与锁定约定优先，未影响单元完整保留。'}],'delta');
    if(mode==='next')return read(id);continue;
   }
   if(d.assembly?.validation?.errors?.length===0)return d;
   const latestFailure=unresolved(d).at(-1);
   const oldReceipt=feedbackOnlyFailure(latestFailure)&&latestFailure.productionFeedbackValidationVersion!==PRODUCTION_FEEDBACK_VALIDATION_VERSION?latestFailure:null;
   if(oldReceipt){
    if(!(await checkSource(id,d.web.binding))){await changeState(id,{sourceStale:true,progress:'source_stale'});return read(id);}
    d=await engine.recheckCandidate(id,oldReceipt.id);
    if(d.candidates.at(-1)?.status==='stale'){await changeState(id,{progress:'failed',error:{code:'STALE_CANDIDATE',message:'已有回包与当前资料或规则不一致；保留原稿，不自动重发。'}});return read(id);}
    if(mode==='next'&&d.candidates.at(-1)?.status==='adopted')return d;
    continue;
   }
   if(!d.plan||unresolved(d).some(c=>c.stage==='plan')){
    let badPlan=unresolved(d).findLast(c=>c.stage==='plan');
    if(badPlan?.output&&badPlan.validatorVersion!==PLAN_VALIDATION_VERSION){
     if(!(await checkSource(id,d.web.binding))){await changeState(id,{sourceStale:true,progress:'source_stale'});return read(id);}
     d=await engine.recheckCandidate(id,badPlan.id);
     if(d.candidates.at(-1)?.status==='adopted'){if(mode==='next')return d;continue;}
     if(d.candidates.at(-1)?.status==='stale'){await changeState(id,{progress:'failed',error:{code:'STALE_CANDIDATE',message:'已有规划与当前资料或规则不一致；保留原稿，请核对版本，不自动重发。'}});return read(id);}
     badPlan=unresolved(d).findLast(c=>c.stage==='plan');
    }
    const problems=badPlan?.errors||[],prior=badPlan&&d.operations.find(o=>o.attemptId===badPlan.attemptId);
    if(problems.some(e=>e.code==='FEEDBACK_REPAIR_SCOPE')){await changeState(id,{progress:'needs_repair',error:{code:'FEEDBACK_REPAIR_SCOPE',message:'局部回执修复越过允许范围；原稿保留，不升级成整套重写。'}});return read(id);}
    const repeated=prior?.issues?.length&&problemKey(prior.issues)===problemKey(problems);
    if(badPlan&&((d.web.autoRepairs||0)>=2||repeated)){
     await changeState(id,{progress:'needs_repair',error:{code:repeated?'REPAIR_NO_PROGRESS':'REPAIR_LIMIT',message:repeated?'定向修复仍出现相同问题，已停止重复调用；已有规划保留。'+(problems[0]?.message||''):'已达到定向返修次数，已有规划保留。'}});return read(id);
    }
    const count=d.operations.length;
    await dispatch(id,'plan',[],badPlan?problems:[],'full',feedbackOnlyFailure(badPlan)?badPlan.id:null);d=await read(id);
    if(badPlan&&d.operations.slice(count).some(op=>op.receipt?.requestOutcome!=='NOT_SENT')){await changeState(id,{autoRepairs:(d.web.autoRepairs||0)+1});d=await read(id);}
    if(mode==='next'||(!d.plan&&d.status!=='needs_repair')||['budget_stop','usage_review','failed','unknown'].includes(d.web.progress))return d;
    continue;
   }
   const selection=resolveSelection(d.plan,d.choice);
   if(selection.status!=='ready'){await changeState(id,{progress:selection.status});return read(id);}
   const bad=unresolved(d);
   if(bad.length){
    const candidate=bad.at(-1),retries=d.web.autoRepairs||0;
    const problems=candidate.validation?.errors||candidate.errors||[],prior=d.operations.find(o=>o.attemptId===candidate.attemptId),repeated=prior?.issues?.length&&problemKey(prior.issues)===problemKey(problems);
    if(problems.some(e=>e.code==='FEEDBACK_REPAIR_SCOPE')){await changeState(id,{progress:'needs_repair',error:{code:'FEEDBACK_REPAIR_SCOPE',message:'局部回执修复越过允许范围；已有正文保留，不升级成整稿重写。'}});return read(id);}
    if(retries>=2||repeated){await changeState(id,{progress:'needs_repair',error:{code:repeated?'REPAIR_NO_PROGRESS':'REPAIR_LIMIT',message:repeated?'定向返修仍是同一问题，已停止重复调用；原稿保留，请核对具体问题后再决定。':'已达到定向返修上限；已有稿件保留。'}});return read(id);}
    const ids=candidate.requiredPackageIds||candidate.packageIds;
    const count=d.operations.length;
    if(feedbackOnlyFailure(candidate))await dispatch(id,candidate.stage,candidate.packageIds,problems,prior.finishMode||'full',candidate.id);
    else await dispatch(id,'finish',ids,problems,'delta');
    d=await read(id);if(d.operations.slice(count).some(op=>op.receipt?.requestOutcome!=='NOT_SENT'))await changeState(id,{autoRepairs:retries+1});
    if(mode==='next')return read(id);continue;
   }
   const packages=d.plan.workPackages,authored=new Set(d.adopted.flatMap(a=>a.packageIds)),finished=covered(d,'finish');
   if(nextAuthorCallGroup(d)){
    for(;;){d=await read(id);if(atRunBoundary(d)||unresolved(d).length)break;
     const packageIds=nextAuthorCallGroup(d);if(!packageIds)break;
     // Build the next request only after the prior response, adoption and slot release settle.
     await dispatch(id,'author',packageIds);if(mode==='next')return read(id);
    }
    continue;
   }
   if(packages.some(w=>!authored.has(w.id))){const first=pendingPackagesInSourceOrder(d)[0],missing=first.dependsOn.filter(id=>!authored.has(id));
    await changeState(id,{progress:'waiting_dependencies',error:{code:'DEPENDENCY_NOT_READY',message:`工作包${first.id}尚待依赖${missing.join('、')||'前序稿件'}成稿；已停止后包派发，保留原计划和已有稿件，请核对依赖顺序。`}});return read(id);}
   const missing=packages.filter(w=>!finished.has(w.id));
   if(missing.length||!hasEpisodeFinish(d)){await dispatch(id,'finish',packages.map(w=>w.id),[],'delta');if(mode==='next')return read(id);continue;}
   try{d=await engine.assemble(id);await changeState(id,{progress:d.status});return read(id);}
   catch(error){await changeState(id,{progress:error.code||'assembly_failed',error:{code:error.code,message:error.message}});return read(id);}
  }
  fail('SCHEDULER_LOOP','调度未能收敛');
 }
 async function idle(id){if(activeRuns.has(id))await activeRuns.get(id);return read(id);}
 function ensureIdle(id){if(activeRuns.has(id))fail('RUN_ACTIVE','当前任务正在运行');}
 function assertEditable(d){if(owners.has(episodeKey(directory,d.web.binding))||d.web?.owner||d.operations.some(o=>isLive(o)))fail('RUN_ACTIVE','当前任务仍有未结作业');if(!d.plan)fail('PLAN_REQUIRED','先完成计划');}
 function resetDrafts(d){if(!d.adopted.length&&!d.executionBatches)return;d.web.archives??=[];d.web.archives.push({at:new Date().toISOString(),adopted:d.adopted,assembly:d.assembly,...(d.executionBatches?{executionBatches:d.executionBatches}:{})});d.adopted=[];delete d.executionBatches;for(const c of unresolved(d))c.resolvedBy='selection_reset';}
 function launch(id,key,action){
  const task=(async()=>{try{return await action();}catch(error){try{await update(id,d=>{if(!closed&&!d.web.stopped&&!d.web.pauseRequested)d.web={...d.web,progress:'failed',error:{code:error.code||'COORDINATOR_ERROR',message:error.message}};return d;});}catch{}return read(id).catch(()=>null);}
   finally{owners.delete(key);activeRuns.delete(id);try{await update(id,d=>{d.web.owner=null;if(d.web.pauseRequested&&!d.web.stopped&&!d.web.sourceStale)d.web.progress='paused';else if(['running','rechecking'].includes(d.web.progress))d.web.progress=d.status;return d;});if(onSettled)await onSettled(await read(id));}catch{}}})();
  activeRuns.set(id,task);task.catch(()=>{});return task;
 }
 async function withIdleLease(id,action,{allowUnresolvedSibling=false}={}){
  ensureIdle(id);if(closed)fail('SHUTDOWN','调度已关闭');const d=await read(id),key=episodeKey(directory,d.web.binding);
  if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');await holdLease();if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');owners.set(key,id);
  try{if(!allowUnresolvedSibling)await assertEpisodeResolved(id,d.web.binding);return await action(await read(id));}finally{owners.delete(key);}
 }
 const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
 const groupAlive=pid=>{try{process.kill(-pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
 const locallyBusy=d=>activeRuns.has(d.id)||queued.some(item=>item.key===pauseKey(d.id))||d.operations.some(o=>o.status==='running')||(d.web.reservedAttemptIds||[]).length>0||(d.web.owner!=null&&(!Number.isSafeInteger(d.web.owner)||d.web.owner<=0||alive(d.web.owner)));
 const hasCandidateBody=(d,attemptId)=>d.candidates.some(c=>c.attemptId===attemptId&&[c.raw,c.output,c.draft].some(value=>typeof value==='string'?value.trim().length>0:value!=null&&typeof value==='object'&&Object.keys(value).length>0));
 const verifiedExit=local=>{const ended=Date.parse(local.exitedAt),started=local.startedAt==null?null:Date.parse(local.startedAt);return typeof local.exitedAt==='string'&&Number.isFinite(ended)&&new Date(ended).toISOString()===local.exitedAt&&ended<=Date.now()&&(started===null||typeof local.startedAt==='string'&&Number.isFinite(started)&&new Date(started).toISOString()===local.startedAt&&started<=ended)&&(local.closeObserved===undefined||local.closeObserved===true);};
 async function hasActiveWork(d,excludedAttemptId){
  if(locallyBusy(d))return true;
  for(const op of d.operations.filter(o=>isLive(o)&&o.attemptId!==excludedAttemptId)){
   let receipt;try{receipt=JSON.parse(await readFile(path.join(directory,'attempts',op.attemptId,'receipt.json'),'utf8'));}catch(error){if(error.code==='ENOENT')continue;return true;}
   const local=receipt?.localProcess;if(!local)continue;
   if(local.host!==hostname()||!Number.isSafeInteger(local.pid)||local.pid<=0||alive(local.pid)||groupAlive(local.pid))return true;
  }
  return false;
 }
 const missingRespondedUsage=(d,op)=>{const receipt=d.candidates.findLast(c=>c.attemptId===op.attemptId)?.receipt||op.receipt,tokens=receipt?.usage?.totalTokens;return op.status==='completed'&&receipt?.requestOutcome==='RESPONDED'&&!(Number.isSafeInteger(tokens)&&tokens>=0);};
 async function usageCheck(d,op,{ownsLease=false}={}){
  const no=(code,reason)=>({attemptId:op.attemptId,kind:'usage',canAcknowledge:false,code,reason});
  if(!missingRespondedUsage(d,op))return no('NOT_UNKNOWN_USAGE','不是已返回且用量未知的调用');
  if((!ownsLease&&owners.has(episodeKey(directory,d.web.binding)))||await hasActiveWork(d,op.attemptId))return no('RUN_ACTIVE','先等待在途回包落库');
  const {receipt}=await readAttemptEvidence({directory,attemptId:op.attemptId}),local=receipt?.localProcess;
  if(local&&(local.host!==hostname()||!Number.isSafeInteger(local.pid)||local.pid<=0||alive(local.pid)||groupAlive(local.pid)||typeof local.exitedAt!=='string'||!Number.isFinite(Date.parse(local.exitedAt))||(local.closeObserved!==undefined&&local.closeObserved!==true)))return no('PROCESS_UNVERIFIED','本地进程仍未确认结束');
  return {attemptId:op.attemptId,kind:'usage',canAcknowledge:true,code:'READY',reason:'这次结果已保存，但用量未完整返回。确认仅接受未知用量，不重跑本次结果；后续调用另行继续。'};
 }
 async function failedAttemptCheck(d,op,{ownsLease=false}={}){
  const isTimeout=op.error?.code==='TIMEOUT',kind=isTimeout?'timeout':'failed',errorCode=isTimeout?'TIMEOUT':'CLI_FAILED',label=isTimeout?'超时':'CLI 失败';
  const no=(code,reason)=>({attemptId:op.attemptId,kind,canAcknowledge:false,code,reason});
  if(op.status!=='unknown'||op.error?.code!==errorCode||op.error?.requestOutcome!=='UNKNOWN')return no('NOT_FAILED',`不是可确认的${label}请求`);
  if((!ownsLease&&owners.has(episodeKey(directory,d.web.binding)))||await hasActiveWork(d,op.attemptId))return no('RUN_ACTIVE','本地作业尚未确认结束');
  const {receipt,hasResponseBody,legacyProcessState}=await readAttemptEvidence({directory,attemptId:op.attemptId});
  if(receipt?.responseDisposition!=='incomplete'&&(hasResponseBody||hasCandidateBody(d,op.attemptId)))return no('RECOVER_RESPONSE_FIRST','已有保存回包，必须先恢复或核对回包');
  if(receipt?.state!=='FINAL'||receipt.requestOutcome!=='UNKNOWN'||receipt.errorCode!==errorCode)return no('RECEIPT_UNRESOLVED',`缺少最终${label}回执，不能解除阻塞`);
  const local=receipt.localProcess;
  const explicitFailure=receipt.execution?.terminalEvent==='turn.failed'&&local?.closeObserved===true;
  if(local){
   if(local.host!==hostname()||!Number.isSafeInteger(local.pid)||local.pid<=0)return no('PROCESS_UNVERIFIED','无法确认本机 CLI 已结束，暂不能解除阻塞');
   if(alive(local.pid)||groupAlive(local.pid))return no('RUN_ACTIVE','模型本地进程或进程组仍未退出');
   if(!verifiedExit(local)||(!isTimeout&&!explicitFailure&&(!Number.isSafeInteger(local.exitCode)||local.exitCode===0)))return no('PROCESS_UNVERIFIED','无法确认本机 CLI 已结束，暂不能解除阻塞');
  }else{
   // Legacy receipts predate per-process execution evidence. Preserve their exact
   // attempt-directory inventory check; modern missing process evidence fails closed.
   if(!isTimeout||receipt.execution)return no('PROCESS_UNVERIFIED','缺少本机 CLI 退出证据');
   if(legacyProcessState==='active')return no('RUN_ACTIVE','仍有本地进程引用此旧请求目录');
   if(legacyProcessState!=='not_found')return no('PROCESS_UNVERIFIED','无法核验旧请求的本地进程');
  }
  const names=await readdir(path.join(directory,'documents'));
  for(const name of names){if(!name.endsWith('.json')||name===`${d.id}.json`)continue;const other=await read(name.slice(0,-5));
   if(other.web?.binding?.projectId===d.web.binding.projectId&&other.web?.binding?.episodeId===d.web.binding.episodeId&&await hasActiveWork(other))return no('EPISODE_BUSY','同集仍有本地作业未确认结束');}
  return {attemptId:op.attemptId,kind,canAcknowledge:true,code:'READY',responseDisposition:receipt.responseDisposition,reason:`本机 CLI ${isTimeout?'超时后已结束':'已失败退出'}，${receipt.responseDisposition==='incomplete'?'未完成片段已保留，但不是可采用的完整结果':'没有保存回包'}；用量仍未知，确认只解除本次阻塞，不会重试。`};
 }
 async function cancellationCheck(d,op,{ownsLease=false}={}){
  const kind=missingRespondedUsage(d,op)?'usage':op.error?.code==='TIMEOUT'?'timeout':op.error?.code==='CLI_FAILED'?'failed':null;
  const no=(code,reason)=>({attemptId:op.attemptId,...(kind?{kind}:{}),canAcknowledge:false,code,reason});
  if(op.cancelAcknowledgement?.acceptUnknownUsage===true)return no('ALREADY_ACKNOWLEDGED','已确认未知用量风险；原始账本不变');
  if(kind==='usage')return usageCheck(d,op,{ownsLease});
  if(kind)return failedAttemptCheck(d,op,{ownsLease});
  if(!d.web.stopped)return no('STOP_REQUIRED','仅可确认已立即中断的任务');
  if(locallyBusy(d)||(!ownsLease&&owners.has(episodeKey(directory,d.web.binding))))return no('RUN_ACTIVE','本地作业尚未结束');
  if(op.status!=='unknown'||op.error?.code!=='ABORTED'||op.error?.requestOutcome!=='UNKNOWN'||!(op.cancelReason==='user_stop'||(!op.cancelReason&&op.epoch<d.epoch)))return no('NOT_USER_CANCELLED','不是可确认的用户中断请求');
  const {receipt,hasResponseBody,legacyProcessState}=await readAttemptEvidence({directory,attemptId:op.attemptId});
  if(receipt?.responseDisposition!=='incomplete'&&(hasResponseBody||hasCandidateBody(d,op.attemptId)))return no('RECOVER_RESPONSE_FIRST','已有保存回包，必须先恢复或核对回包');
  if(receipt?.state!=='FINAL'||receipt.requestOutcome!=='UNKNOWN'||receipt.errorCode!=='ABORTED')return no('RECEIPT_UNRESOLVED','缺少最终用户中断回执，不能解除阻塞');
  if(receipt.localProcess){const local=receipt.localProcess;
   if(local.host!==hostname()||!Number.isSafeInteger(local.pid)||local.pid<=0)return no('PROCESS_UNVERIFIED','无法核验本地进程记录，暂不能解除阻塞');
   if(alive(local.pid)||groupAlive(local.pid))return no('RUN_ACTIVE','模型本地进程或进程组尚未退出');
   if(!verifiedExit(local))return no('PROCESS_UNVERIFIED','本地进程退出尚未证实，暂不能解除阻塞');
  }
  if(!receipt.localProcess&&legacyProcessState==='active')return no('RUN_ACTIVE','仍有本地进程引用此旧请求目录，不能确认结束');
  if(!receipt.localProcess&&legacyProcessState!=='not_found')return no('PROCESS_UNVERIFIED','无法核验旧请求的本地进程，暂不能解除阻塞');
  return {attemptId:op.attemptId,canAcknowledge:true,code:'READY',responseDisposition:receipt.responseDisposition,reason:receipt.responseDisposition==='incomplete'?'本地已结束，未完成片段已保留但不可采用；费用未知，确认后仅允许另行继续':'本地已结束且没有保存回包；费用未知，确认后仅允许另行继续'};
 }
 const recoveryTargets=d=>d.operations.filter(op=>isLive(op)||hasPendingSavedResponse(d,op));
 async function recoverBeforeStart(id,d){
  const targets=recoveryTargets(d);if(!targets.length)return {document:d,recovered:false};
  if(!(await checkSource(id,d.web.binding))){await changeState(id,{sourceStale:true,progress:'source_stale'});fail('SOURCE_STALE','源版本已变化，不能接纳旧回包');}
  let recovered=false;
  for(const op of targets){const before=d.candidates.length;d=await engine.recover(id,op.attemptId);recovered||=d.candidates.length>before;}
  if(recoveryTargets(d).length)fail('ATTEMPT_UNRESOLVED','保存回包尚不可恢复；仅已核验结束且无回包的中断、CLI 失败或超时，可明确接受未知用量后另行继续');
  return {document:d,recovered};
 }
 const api={
  async prepareWrite(){await holdLease();},
  async withPreparation(callback){if(typeof callback!=='function')fail('PREPARATION','缺少准备回调');await holdLease();return callback();},
  async create({source,settings,binding,budget,title,voiceReference=null,production=null}){if(!binding?.projectId||!binding?.episodeId||!binding?.sourceVersion)fail('BINDING','缺少源版本绑定');await holdLease();const id=randomUUID();await engine.create({id,source,settings,voiceReference,production});return update(id,d=>{d.web={binding,title:title||d.source.title||'',createdAt:new Date().toISOString(),budget:budgetOf(budget),reserved:0,reservedAttemptIds:[],autoRepairs:0,progress:'created',stopped:false,pauseRequested:false,sourceStale:false,owner:null,archives:[],error:null};return d;});},
  async refreshProduction(id,context){await holdLease();return engine.refreshProduction(id,context);},
  async list(binding={}){const names=await readdir(path.join(directory,'documents')).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e));const docs=await Promise.all(names.filter(n=>n.endsWith('.json')).map(n=>read(n.slice(0,-5))));return docs.filter(d=>!binding.episodeId||d.web?.binding?.episodeId===binding.episodeId);},
  read,
  async start(id,{mode='all'}={}){if(!['next','all'].includes(mode))fail('MODE','运行模式无效');let d=await read(id);if(closed)fail('SHUTDOWN','调度已关闭');if(activeRuns.has(id))return d;if(d.web.sourceStale)fail('SOURCE_STALE','源版本已变化，请创建新任务');await holdLease();d=await syncProduction(id);if(d.assembly?.validation?.errors?.length===0&&!d.production?.pendingRepair&&!d.production?.blocking)return d;const key=episodeKey(directory,d.web.binding);if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');
   owners.set(key,id);let launched=false;
   try{await assertEpisodeResolved(id,d.web.binding);const restored=await recoverBeforeStart(id,await read(id));
    await changeState(id,{owner:mode==='next'&&restored.recovered?null:process.pid,stopped:false,pauseRequested:false,progress:mode==='next'&&restored.recovered?restored.document.status:'running',error:null});pausedRuns.delete(pauseKey(id));
    if(mode==='next'&&restored.recovered)return read(id);launch(id,key,()=>advance(id,mode));launched=true;return read(id);
   }finally{if(!launched)owners.delete(key);}},
  async replan(id){ensureIdle(id);const d=await read(id);if(closed)fail('SHUTDOWN','调度已关闭');if(d.web.sourceStale)fail('SOURCE_STALE','源版本已变化，请创建新任务');if(!d.plan)fail('PLAN_REQUIRED','先完成首次计划');if(d.adopted.length||hasExecutionDrafts(d))fail('RESET_DRAFTS_REQUIRED','已有正文或分批保存稿，须先明确归档重做');if(d.operations.some(isLive))fail('ATTEMPT_UNRESOLVED','先恢复或核对未结请求');
   const key=episodeKey(directory,d.web.binding);if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');await holdLease();if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');owners.set(key,id);
   try{await assertEpisodeResolved(id,d.web.binding);await changeState(id,{owner:process.pid,stopped:false,pauseRequested:false,progress:'running',error:null});pausedRuns.delete(pauseKey(id));}catch(error){owners.delete(key);throw error;}
   launch(id,key,async()=>{await dispatch(id,'plan');const current=await read(id);if(current.web.progress==='running')return changeState(id,{progress:current.status});return current;});return read(id);},
  async repair(id,{packageIds,notes=[]}={}){ensureIdle(id);const d=await read(id),bad=unresolved(d);let ids=packageIds||bad.at(-1)?.requiredPackageIds||bad.at(-1)?.packageIds;if(!Array.isArray(ids)||!ids.length)fail('REPAIR_SCOPE','缺少返修范围');
   let size;do{size=ids.length;for(const group of [...d.adopted,...bad.map(c=>({packageIds:c.requiredPackageIds||c.packageIds}))])if(group.packageIds.some(x=>ids.includes(x)))ids=[...new Set([...ids,...group.packageIds])];}while(ids.length!==size);
   const key=episodeKey(directory,d.web.binding);if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');await holdLease();if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');owners.set(key,id);
   try{await assertEpisodeResolved(id,d.web.binding);await changeState(id,{progress:'running',error:null,owner:process.pid});}catch(error){owners.delete(key);throw error;}
   launch(id,key,async()=>{await dispatch(id,'finish',ids,notes,'delta');const current=await read(id);if(current.web.pauseRequested||['failed','budget_stop','usage_review','upstream_review','unknown','source_stale','stopped'].includes(current.web.progress))return current;
    if(unresolved(current).length)return changeState(id,{progress:'needs_repair'});
    if(hasEpisodeFinish(current)&&current.plan.workPackages.every(w=>covered(current,'finish').has(w.id))){try{const result=await engine.assemble(id);return changeState(id,{progress:result.status});}catch(error){await changeState(id,{progress:error.code||'assembly_failed',error:{code:error.code,message:error.message}});}}
    else await changeState(id,{progress:'needs_finish'});return read(id);});return read(id);},
  async pause(id){const current=await read(id);if(current.web.stopped||(!activeRuns.has(id)&&current.assembly?.validation?.errors?.length===0))return current;await holdLease();pausedRuns.add(pauseKey(id));
   try{await changeState(id,{pauseRequested:true,progress:activeRuns.has(id)||current.operations.some(o=>o.status==='running')?'pausing':'paused'});}catch(error){pausedRuns.delete(pauseKey(id));throw error;}cancelPreflights(id);withdrawQueued(id);return read(id);},
  async stop(id){const current=await read(id);if(current.web.stopped||(!activeRuns.has(id)&&current.assembly?.validation?.errors?.length===0))return current;await holdLease();pausedRuns.add(pauseKey(id));const d=await changeState(id,{stopped:true,pauseRequested:false,progress:'stopped'});cancelPreflights(id,'ABORTED');for(const op of d.operations.filter(o=>o.status==='running'))cancelled.add(op.attemptId);await engine.cancel(id,{reason:'user_stop'});withdrawQueued(id);return read(id);},
  async choose(id,{mode,overrides,unitOverrides,expectedFingerprint,resetDrafts:reset=false}={}){ensureIdle(id);await holdLease();return update(id,d=>{assertEditable(d);if(expectedFingerprint&&selectionFingerprint(d.plan,d.choice)!==expectedFingerprint)fail('SELECTION_FINGERPRINT','幻想选择指纹过期');if((d.adopted.length||hasExecutionDrafts(d))&&!reset)fail('RESET_DRAFTS_REQUIRED','已有正文或分批保存稿，改选须明确归档重做');const nextMode=mode||d.choice.mode,base=nextMode===d.choice.mode?d.choice:defaultChoice(nextMode),choice={...base,overrides:overrides??base.overrides,unitOverrides:unitOverrides??base.unitOverrides,confirmedFingerprint:null},settings=normalizeSettings({...d.settings,fantasyMode:nextMode});resolveSelection(d.plan,choice);if(reset)resetDrafts(d);else delete d.executionBatches;d.settings=settings;d.choice=choice;d.assembly=null;d.status='planned';d.web.progress='planned';d.web.error=null;return d;});},
  async confirm(id,{selectedIds,expectedFingerprint,resetDrafts:reset=false}={}){ensureIdle(id);await holdLease();return update(id,d=>{assertEditable(d);if((d.adopted.length||hasExecutionDrafts(d))&&!reset)fail('RESET_DRAFTS_REQUIRED','已有正文或分批保存稿，确认须明确归档重做');const choice=confirmSelection(d.plan,d.choice,selectedIds,expectedFingerprint);if(reset)resetDrafts(d);else delete d.executionBatches;d.choice=choice;d.assembly=null;d.status='planned';d.web.progress='planned';d.web.error=null;return d;});},
  async recover(id,attemptId){return withIdleLease(id,async current=>{if(current.web.sourceStale||!(await checkSource(id,current.web.binding))){await changeState(id,{sourceStale:true,progress:'source_stale'});fail('SOURCE_STALE','源版本已变化，请保留旧稿并创建新任务');}const d=await engine.recover(id,attemptId),pending=d.operations.some(o=>o.status==='unknown'&&isLive(o));return changeState(id,{progress:pending?'unknown':d.status,error:pending?d.web.error:null});});},
  async cancellationStatus(id){const d=await read(id);return Promise.all(d.operations.filter(o=>o.status==='unknown'||o.error?.code==='ABORTED'||missingRespondedUsage(d,o)).map(op=>cancellationCheck(d,op)));},
  async executionStatus(id){const d=await read(id),ops=d.operations.filter(o=>['running','unknown'].includes(o.status)||o===d.operations.at(-1));
   const items=await Promise.all(ops.map(async op=>{const saved=await readFile(path.join(directory,'attempts',op.attemptId,'receipt.json'),'utf8').then(JSON.parse).catch(()=>null),execution=executionView(saved?.execution);return execution?{attemptId:op.attemptId,execution}:null;}));return items.filter(Boolean);},
  async acknowledgeCancelled(id,{attemptId,acceptUnknownUsage}={}){if(acceptUnknownUsage!==true)fail('UNKNOWN_USAGE_CONFIRMATION','须明确接受此次用量仍未知；此操作不会启动新请求');return withIdleLease(id,async d=>{const op=d.operations.find(o=>o.attemptId===attemptId);if(!op)fail('ATTEMPT','作业不存在');if(op.cancelAcknowledgement?.acceptUnknownUsage===true)return update(id,settleAcknowledgedStop);
   const status=await cancellationCheck(d,op,{ownsLease:true});if(!status.canAcknowledge)fail(status.code,status.reason);
   if(status.kind==='usage')return update(id,current=>{const target=current.operations.find(o=>o.attemptId===attemptId);if(!target||current.epoch!==d.epoch||!missingRespondedUsage(current,target)||locallyBusy(current))fail('RUN_ACTIVE','任务状态已变化，请重新核对');target.cancelAcknowledgement={at:new Date().toISOString(),acceptUnknownUsage:true,kind:'usage'};if(!usage(current).blockingUnknown&&['usage_review','budget_stop'].includes(current.web.progress)){current.web.progress=current.status;current.web.error=null;}return current;});
   return update(id,current=>{const target=current.operations.find(o=>o.attemptId===attemptId),expectedCode=status.kind==='timeout'?'TIMEOUT':status.kind==='failed'?'CLI_FAILED':'ABORTED';if(!target||current.epoch!==d.epoch||target.error?.code!==expectedCode||target.error?.requestOutcome!=='UNKNOWN'||(!status.kind&&(!current.web.stopped||!(target.cancelReason==='user_stop'||(!target.cancelReason&&target.epoch<current.epoch))))||target.status!=='unknown'||locallyBusy(current))fail('RUN_ACTIVE','任务状态已变化，请重新核对');if(status.responseDisposition!=='incomplete'&&hasCandidateBody(current,attemptId))fail('RECOVER_RESPONSE_FIRST','已有保存回包，必须先恢复或核对回包');target.cancelAcknowledgement??={at:new Date().toISOString(),acceptUnknownUsage:true,reason:target.error.code,...(status.kind?{kind:status.kind}:{})};if(status.responseDisposition==='incomplete')for(const candidate of current.candidates.filter(c=>c.attemptId===attemptId))candidate.resolvedBy??='incomplete_response_acknowledged';return settleAcknowledgedStop(current);});},{allowUnresolvedSibling:true});},
  async recheck(id,candidateId){ensureIdle(id);await holdLease();const d=await engine.recheckCandidate(id,candidateId);return changeState(id,{progress:d.status,error:null});},
  async setBudget(id,value){ensureIdle(id);await holdLease();return update(id,d=>{d.web.budget=budgetOf(value);if(['failed','budget_stop'].includes(d.web.progress))d.web.progress=d.plan?'planned':'created';d.web.error=null;return d;});},
  async exportDraft(id){const d=await read(id);return d.assembly?.text||null;},
  active:id=>activeRuns.has(id),
  executionState(id,attemptId){if(!activeRuns.has(id)||currentAttempts.get(attemptId)!==id)return null;if(queued.some(item=>item.key===pauseKey(id)&&item.attemptId===attemptId))return 'queued';return executingAttempts.has(attemptId)?'executing':'preparing';},
  scheduling:id=>({maxConcurrent,maxPerEpisode,inFlight:inFlightByRun.get(pauseKey(id))||0,queued:queued.filter(item=>item.key===pauseKey(id)).length}),
  wait:idle,
  async shutdown(){return shutdownTask??=(async()=>{closed=true;for(const id of preflights.keys())cancelPreflights(id,'SHUTDOWN');await leasePending?.catch(()=>{});await Promise.allSettled([...pendingWrites]);await Promise.all([...activeRuns.keys()].map(id=>engine.cancel(id)));await Promise.allSettled([...activeRuns.values()]);if(leaseRef){const record=leaseRef;leaseRef=null;await releaseLease(directory,record);}})();}
 };
 for(const name of ['prepareWrite','withPreparation','create','refreshProduction','start','replan','repair','pause','stop','choose','confirm','recover','acknowledgeCancelled','recheck','setBudget']){
  const operation=api[name];
  api[name]=(...args)=>{
   if(closed)return Promise.reject(Object.assign(new Error('调度已关闭'),{code:'SHUTDOWN'}));
   const task=operation(...args);pendingWrites.add(task);
   task.finally(()=>pendingWrites.delete(task)).catch(()=>{});
   return task;
  };
 }
 return api;
}
