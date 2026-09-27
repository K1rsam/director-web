import {randomUUID} from 'node:crypto';
import {mkdir,open,readFile,readdir,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {hostname} from 'node:os';
import {createEngine,PLAN_VALIDATION_VERSION,isUnresolvedOperation} from './core/pipeline.mjs';
import {createStore} from './core/store.mjs';
import {runModel,readAttemptEvidence} from './core/runner.mjs';
import {resolveSelection,selectionFingerprint,confirmSelection} from './core/selection.mjs';
import {defaultChoice,normalizeSettings} from './core/core.mjs';
import {fail,digest} from './core/shared.mjs';
import {acquireRuntimeLease} from './runtime-lease.mjs';

const shared=globalThis[Symbol.for('storyboard-v4.coordinator')]??={owners:new Map(),leaseTokens:new Map(),leaseClaims:new Map(),inFlight:0,queued:[]};
const {owners,leaseTokens,leaseClaims,queued}=shared;
const pausedRuns=shared.pausedRuns??=new Set();
const runtimeLeases=shared.runtimeLeases??=new Map();
const defaults={maxCalls:32,maxTokens:300000};
function budgetOf(value={}){
 const b={...defaults,...value};
 if(!Number.isSafeInteger(b.maxCalls)||b.maxCalls<0||b.maxCalls>128||!Number.isSafeInteger(b.maxTokens)||b.maxTokens<0||b.maxTokens>2000000)fail('BUDGET','预算范围无效');
 return b;
}
const episodeKey=(root,b)=>`${path.resolve(root)}:${b.projectId}:${b.episodeId}`;
const unresolved=d=>d.candidates.filter(c=>['needs_repair','needs_dependency_repair'].includes(c.status)&&!c.resolvedBy);
const covered=(d,stage)=>new Set(d.adopted.filter(a=>a.stage===stage).flatMap(a=>a.packageIds));
const isLive=isUnresolvedOperation;
function settleAcknowledgedStop(d){
 if(d.web.stopped&&!d.operations.some(isLive)){
  d.web.progress='paused';
  if(['UNKNOWN','ATTEMPT_UNRESOLVED','ABORTED'].includes(d.web.error?.code))d.web.error=null;
 }
 return d;
}
const problemKey=errors=>digest((errors||[]).map(e=>({code:e.code,coordinate:e.coordinate||null,message:e.message||e.detail||''})));
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

export function createCoordinator({dataRoot,modelRunner=runModel,executable,maxConcurrent=2,beforeExecute=async()=>true}={}){
 if(typeof dataRoot!=='string'||!dataRoot||!Number.isSafeInteger(maxConcurrent)||maxConcurrent<1||maxConcurrent>2)fail('COORDINATOR_CONFIG','调度配置无效');
 const directory=path.resolve(dataRoot),store=createStore(directory),activeRuns=new Map();
 const pendingWrites=new Set();
 let closed=false,leaseRef=null,leasePending=null,shutdownTask=null;
 async function holdLease(){if(closed)fail('SHUTDOWN','调度已关闭');if(leaseRef){leaseRef.lease.assertHeld();return;}
  leasePending??=claimLease(directory).then(record=>{record.users++;leaseRef=record;}).finally(()=>{leasePending=null;});await leasePending;
  if(closed)fail('SHUTDOWN','调度已关闭');
 }
 const cancelled=new Set();
 const pauseKey=id=>`${directory}:${id}`;
 const limitedRunner=async(request,options)=>{
  try{if(!leaseRef)fail('LEASE_LOST','尚未持有执行锁');leaseRef.lease.assertHeld();}catch(error){throw Object.assign(error,{requestOutcome:'NOT_SENT'});}
  const key=pauseKey(options.runId),shouldDispatch=()=>{try{leaseRef.lease.assertHeld();return !closed&&!pausedRuns.has(key)&&!cancelled.has(options.attemptId);}catch{return false;}};
  if(!shouldDispatch()||options.signal?.aborted)throw Object.assign(new Error('未派发请求已撤回'),{code:'PAUSED',requestOutcome:'NOT_SENT'});
  await new Promise((resolve,reject)=>{const item={resolve,reject,signal:options.signal,limit:maxConcurrent,key};
   const abort=()=>{const index=queued.indexOf(item);if(index>=0){queued.splice(index,1);reject(Object.assign(new Error('已取消'),{code:'ABORTED',requestOutcome:'NOT_SENT'}));}};
   item.abort=abort;options.signal?.addEventListener('abort',abort,{once:true});queued.push(item);pump();});
  try{if(!shouldDispatch()||options.signal?.aborted)throw Object.assign(new Error('未派发请求已撤回'),{code:'PAUSED',requestOutcome:'NOT_SENT'});return await modelRunner(request,{...options,shouldDispatch,...(executable?{executable}:{})});}
  finally{shared.inFlight--;pump();}
 };
 function pump(){for(let i=0;i<queued.length;){const item=queued[i];if(item.signal?.aborted||pausedRuns.has(item.key)){queued.splice(i,1);item.signal?.removeEventListener('abort',item.abort);item.reject(Object.assign(new Error('未派发请求已撤回'),{code:'PAUSED',requestOutcome:'NOT_SENT'}));continue;}if(shared.inFlight>=item.limit)break;queued.splice(i,1);item.signal?.removeEventListener('abort',item.abort);shared.inFlight++;item.resolve();}}
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
 async function dispatch(id,stage,packageIds=[],issues=[],finishMode='full'){
  let d=await read(id);if(d.web.stopped||d.web.pauseRequested) return d;
  if(!(await beforeExecute(d.web.binding))){await changeState(id,{sourceStale:true,progress:'source_stale'});return read(id);}
  const attemptId=randomUUID();let admitted=false;
  await update(id,x=>{const spent=usage(x),reserved=x.web.reservedAttemptIds||[],committed=new Set([...x.operations.map(o=>o.attemptId),...reserved]);
   if(x.web.stopped||x.web.pauseRequested||x.web.sourceStale)return x;
   if(committed.size>=x.web.budget.maxCalls||spent.blockingUnknown||spent.knownTokens>=x.web.budget.maxTokens){x.web.progress='budget_stop';return x;}
   x.web.reservedAttemptIds=[...reserved,attemptId];x.web.reserved=x.web.reservedAttemptIds.length;x.web.progress='running';admitted=true;return x;});
  if(!admitted)return read(id);
  try{const current=await read(id);if(current.web.stopped||current.web.pauseRequested)return current;return await engine.execute(id,{stage,packageIds,attemptId,issues,finishMode});}
  catch(error){const current=await read(id);if(!current.web.stopped&&!current.web.pauseRequested)await changeState(id,{progress:error.requestOutcome==='UNKNOWN'?'unknown':'failed',error:{code:error.code||'RUNNER_ERROR',message:error.message}});return read(id);}
   finally{await update(id,x=>{x.web.reservedAttemptIds=(x.web.reservedAttemptIds||[]).filter(x=>x!==attemptId);x.web.reserved=x.web.reservedAttemptIds.length;return x;});cancelled.delete(attemptId);}
 }
 async function advance(id,mode){
  for(let steps=0;steps<100;steps++){let d=await read(id);if(d.web.stopped||d.web.pauseRequested||d.web.sourceStale||['failed','unknown','budget_stop'].includes(d.web.progress)||d.operations.some(o=>o.status==='unknown'&&isLive(o)))return d;
   if(d.assembly?.validation?.errors?.length===0)return d;
   if(!d.plan||unresolved(d).some(c=>c.stage==='plan')){
    let badPlan=unresolved(d).findLast(c=>c.stage==='plan');
    if(badPlan?.output&&badPlan.validatorVersion!==PLAN_VALIDATION_VERSION){
     if(!(await beforeExecute(d.web.binding))){await changeState(id,{sourceStale:true,progress:'source_stale'});return read(id);}
     d=await engine.recheckCandidate(id,badPlan.id);
     if(d.candidates.at(-1)?.status==='adopted'){if(mode==='next')return d;continue;}
     if(d.candidates.at(-1)?.status==='stale'){await changeState(id,{progress:'failed',error:{code:'STALE_CANDIDATE',message:'已有规划与当前资料或规则不一致；保留原稿，请核对版本，不自动重发。'}});return read(id);}
     badPlan=unresolved(d).findLast(c=>c.stage==='plan');
    }
    const problems=badPlan?.errors||[],prior=badPlan&&d.operations.find(o=>o.attemptId===badPlan.attemptId);
    const repeated=prior?.issues?.length&&problemKey(prior.issues)===problemKey(problems);
    if(badPlan&&((d.web.autoRepairs||0)>=2||repeated)){
     await changeState(id,{progress:'needs_repair',error:{code:repeated?'REPAIR_NO_PROGRESS':'REPAIR_LIMIT',message:repeated?'定向修复仍出现相同问题，已停止重复调用；已有规划保留。'+(problems[0]?.message||''):'已达到定向返修次数，已有规划保留。'}});return read(id);
    }
    const count=d.operations.length;
    await dispatch(id,'plan',[],badPlan?problems:[]);d=await read(id);
    if(badPlan&&d.operations.length>count){await changeState(id,{autoRepairs:(d.web.autoRepairs||0)+1});d=await read(id);}
    if(mode==='next'||(!d.plan&&d.status!=='needs_repair')||['budget_stop','failed','unknown'].includes(d.web.progress))return d;
    continue;
   }
   const selection=resolveSelection(d.plan,d.choice);
   if(selection.status!=='ready'){await changeState(id,{progress:selection.status});return read(id);}
   const bad=unresolved(d);
   if(bad.length){
    const candidate=bad.at(-1),retries=d.web.autoRepairs||0;
    if(retries>=2){await changeState(id,{progress:'needs_repair'});return read(id);}
    const ids=candidate.requiredPackageIds||candidate.packageIds;
    await changeState(id,{autoRepairs:retries+1});await dispatch(id,'finish',ids,candidate.validation?.errors||candidate.errors||[],'delta');
    if(mode==='next')return read(id);continue;
   }
   const packages=d.plan.workPackages,authored=new Set(d.adopted.flatMap(a=>a.packageIds)),finished=covered(d,'finish');
   const ready=packages.filter(w=>!authored.has(w.id)&&!d.operations.some(o=>isLive(o)&&o.packageIds.includes(w.id))&&w.dependsOn.every(dep=>authored.has(dep)));
   if(ready.length){
    const jobs=ready.slice(0,mode==='next'?1:maxConcurrent).map(w=>dispatch(id,'author',[w.id]));
    await Promise.all(jobs);if(mode==='next')return read(id);continue;
   }
   if(packages.some(w=>!authored.has(w.id))){await changeState(id,{progress:'waiting_dependencies'});return read(id);}
   const missing=packages.filter(w=>!finished.has(w.id));
   if(missing.length){await dispatch(id,'finish',packages.map(w=>w.id),[],'delta');if(mode==='next')return read(id);continue;}
   try{d=await engine.assemble(id);await changeState(id,{progress:d.status});return read(id);}
   catch(error){await changeState(id,{progress:error.code||'assembly_failed',error:{code:error.code,message:error.message}});return read(id);}
  }
  fail('SCHEDULER_LOOP','调度未能收敛');
 }
 async function idle(id){if(activeRuns.has(id))await activeRuns.get(id);return read(id);}
 function ensureIdle(id){if(activeRuns.has(id))fail('RUN_ACTIVE','当前任务正在运行');}
 function assertEditable(d){if(owners.has(episodeKey(directory,d.web.binding))||d.web?.owner||d.operations.some(o=>isLive(o)))fail('RUN_ACTIVE','当前任务仍有未结作业');if(!d.plan)fail('PLAN_REQUIRED','先完成计划');}
 function resetDrafts(d){if(!d.adopted.length)return;d.web.archives??=[];d.web.archives.push({at:new Date().toISOString(),adopted:d.adopted,assembly:d.assembly});d.adopted=[];for(const c of unresolved(d))c.resolvedBy='selection_reset';}
 function launch(id,key,action){
  const task=(async()=>{try{return await action();}catch(error){try{await changeState(id,{progress:'failed',error:{code:error.code||'COORDINATOR_ERROR',message:error.message}});}catch{}return read(id).catch(()=>null);}
   finally{owners.delete(key);activeRuns.delete(id);try{await update(id,d=>{d.web.owner=null;if(d.web.pauseRequested&&!d.web.stopped&&!d.web.sourceStale)d.web.progress='paused';else if(['running','rechecking'].includes(d.web.progress))d.web.progress=d.status;return d;});}catch{}}})();
  activeRuns.set(id,task);task.catch(()=>{});return task;
 }
 async function withIdleLease(id,action,{allowUnresolvedSibling=false}={}){
  ensureIdle(id);if(closed)fail('SHUTDOWN','调度已关闭');const d=await read(id),key=episodeKey(directory,d.web.binding);
  if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');await holdLease();if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');owners.set(key,id);
  try{if(!allowUnresolvedSibling)await assertEpisodeResolved(id,d.web.binding);return await action(await read(id));}finally{owners.delete(key);}
 }
 const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
 async function cancellationCheck(d,op,{ownsLease=false}={}){
  const no=(code,reason)=>({attemptId:op.attemptId,canAcknowledge:false,code,reason});
  if(op.cancelAcknowledgement?.acceptUnknownUsage===true)return no('ALREADY_ACKNOWLEDGED','已确认中断未知费用；原始账本不变');
  if(!d.web.stopped)return no('STOP_REQUIRED','仅可确认已立即中断的任务');
  if(activeRuns.has(d.id)||(!ownsLease&&owners.has(episodeKey(directory,d.web.binding)))||d.operations.some(o=>o.status==='running')||alive(d.web.owner))return no('RUN_ACTIVE','本地作业尚未结束');
  if(op.status!=='unknown'||op.error?.code!=='ABORTED'||!(op.cancelReason==='user_stop'||(!op.cancelReason&&op.epoch<d.epoch)))return no('NOT_USER_CANCELLED','不是可确认的用户中断请求');
  const {receipt,hasResponseBody,legacyProcessState}=await readAttemptEvidence({directory,attemptId:op.attemptId});
  if(hasResponseBody||d.candidates.some(c=>c.attemptId===op.attemptId&&c.raw?.trim()))return no('RECOVER_RESPONSE_FIRST','已有保存回包，必须先恢复或核对回包');
  if(receipt?.state!=='FINAL'||receipt.requestOutcome!=='UNKNOWN'||receipt.errorCode!=='ABORTED')return no('RECEIPT_UNRESOLVED','缺少最终用户中断回执，不能解除阻塞');
  if(receipt.localProcess&&!receipt.localProcess.exitedAt&&(receipt.localProcess.host!==hostname()||alive(receipt.localProcess.pid)))return no('RUN_ACTIVE','模型本地进程尚未确认退出');
  if(!receipt.localProcess&&legacyProcessState==='active')return no('RUN_ACTIVE','仍有本地进程引用此旧请求目录，不能确认结束');
  if(!receipt.localProcess&&legacyProcessState!=='not_found')return no('PROCESS_UNVERIFIED','无法核验旧请求的本地进程，暂不能解除阻塞');
  return {attemptId:op.attemptId,canAcknowledge:true,code:'READY',reason:'本地已结束且没有保存回包；费用未知，确认后仅允许另行继续'};
 }
 const recoveryTargets=d=>d.operations.filter(op=>isLive(op)||(op.recovery?.epoch!==d.epoch&&d.candidates.some(c=>c.attemptId===op.attemptId&&c.status==='cancelled_late')));
 async function recoverBeforeStart(id,d){
  const targets=recoveryTargets(d);if(!targets.length)return {document:d,recovered:false};
  if(!(await beforeExecute(d.web.binding))){await changeState(id,{sourceStale:true,progress:'source_stale'});fail('SOURCE_STALE','源版本已变化，不能接纳旧回包');}
  let recovered=false;
  for(const op of targets){const before=d.candidates.length;d=await engine.recover(id,op.attemptId);recovered||=d.candidates.length>before;}
  if(recoveryTargets(d).length)fail('ATTEMPT_UNRESOLVED','保存回包尚不可恢复；无回包的用户中断需先明确确认未知费用');
  return {document:d,recovered};
 }
 const api={
  async prepareWrite(){await holdLease();},
  async withPreparation(callback){if(typeof callback!=='function')fail('PREPARATION','缺少准备回调');await holdLease();return callback();},
  async create({source,settings,binding,budget,title,voiceReference=null}){if(!binding?.projectId||!binding?.episodeId||!binding?.sourceVersion)fail('BINDING','缺少源版本绑定');await holdLease();const id=randomUUID();await engine.create({id,source,settings,voiceReference});return update(id,d=>{d.web={binding,title:title||d.source.title||'',createdAt:new Date().toISOString(),budget:budgetOf(budget),reserved:0,reservedAttemptIds:[],autoRepairs:0,progress:'created',stopped:false,pauseRequested:false,sourceStale:false,owner:null,archives:[],error:null};return d;});},
  async list(binding={}){const names=await readdir(path.join(directory,'documents')).catch(e=>e.code==='ENOENT'?[]:Promise.reject(e));const docs=await Promise.all(names.filter(n=>n.endsWith('.json')).map(n=>read(n.slice(0,-5))));return docs.filter(d=>!binding.episodeId||d.web?.binding?.episodeId===binding.episodeId);},
  read,
  async start(id,{mode='all'}={}){if(!['next','all'].includes(mode))fail('MODE','运行模式无效');const d=await read(id);if(closed)fail('SHUTDOWN','调度已关闭');if(activeRuns.has(id))return d;if(d.web.sourceStale)fail('SOURCE_STALE','源版本已变化，请创建新任务');if(d.assembly?.validation?.errors?.length===0)return d;const key=episodeKey(directory,d.web.binding);if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');await holdLease();if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');
   owners.set(key,id);let launched=false;
   try{await assertEpisodeResolved(id,d.web.binding);const restored=await recoverBeforeStart(id,await read(id));
    await changeState(id,{owner:mode==='next'&&restored.recovered?null:process.pid,stopped:false,pauseRequested:false,progress:mode==='next'&&restored.recovered?restored.document.status:'running',error:null});pausedRuns.delete(pauseKey(id));
    if(mode==='next'&&restored.recovered)return read(id);launch(id,key,()=>advance(id,mode));launched=true;return read(id);
   }finally{if(!launched)owners.delete(key);}},
  async replan(id){ensureIdle(id);const d=await read(id);if(closed)fail('SHUTDOWN','调度已关闭');if(d.web.sourceStale)fail('SOURCE_STALE','源版本已变化，请创建新任务');if(!d.plan)fail('PLAN_REQUIRED','先完成首次计划');if(d.adopted.length)fail('RESET_DRAFTS_REQUIRED','已有正文，须先明确归档重做');if(d.operations.some(isLive))fail('ATTEMPT_UNRESOLVED','先恢复或核对未结请求');
   const key=episodeKey(directory,d.web.binding);if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');await holdLease();if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');owners.set(key,id);
   try{await assertEpisodeResolved(id,d.web.binding);await changeState(id,{owner:process.pid,stopped:false,pauseRequested:false,progress:'running',error:null});pausedRuns.delete(pauseKey(id));}catch(error){owners.delete(key);throw error;}
   launch(id,key,async()=>{await dispatch(id,'plan');const current=await read(id);if(current.web.progress==='running')return changeState(id,{progress:current.status});return current;});return read(id);},
  async repair(id,{packageIds,notes=[]}={}){ensureIdle(id);const d=await read(id),bad=unresolved(d);let ids=packageIds||bad.at(-1)?.requiredPackageIds||bad.at(-1)?.packageIds;if(!Array.isArray(ids)||!ids.length)fail('REPAIR_SCOPE','缺少返修范围');
   let size;do{size=ids.length;for(const group of [...d.adopted,...bad.map(c=>({packageIds:c.requiredPackageIds||c.packageIds}))])if(group.packageIds.some(x=>ids.includes(x)))ids=[...new Set([...ids,...group.packageIds])];}while(ids.length!==size);
   const key=episodeKey(directory,d.web.binding);if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');await holdLease();if(owners.has(key))fail('EPISODE_BUSY','同集已有任务运行');owners.set(key,id);
   try{await assertEpisodeResolved(id,d.web.binding);await changeState(id,{progress:'running',error:null,owner:process.pid});}catch(error){owners.delete(key);throw error;}
   launch(id,key,async()=>{await dispatch(id,'finish',ids,notes,'delta');const current=await read(id);if(current.web.pauseRequested||['failed','budget_stop','unknown','source_stale','stopped'].includes(current.web.progress))return current;
    if(unresolved(current).length)return changeState(id,{progress:'needs_repair'});
    if(current.plan.workPackages.every(w=>covered(current,'finish').has(w.id))){try{const result=await engine.assemble(id);return changeState(id,{progress:result.status});}catch(error){await changeState(id,{progress:error.code||'assembly_failed',error:{code:error.code,message:error.message}});}}
    else await changeState(id,{progress:'needs_finish'});return read(id);});return read(id);},
  async pause(id){const current=await read(id);if(current.web.stopped||(!activeRuns.has(id)&&current.assembly?.validation?.errors?.length===0))return current;await holdLease();pausedRuns.add(pauseKey(id));
   try{await changeState(id,{pauseRequested:true,progress:activeRuns.has(id)||current.operations.some(o=>o.status==='running')?'pausing':'paused'});}catch(error){pausedRuns.delete(pauseKey(id));throw error;}withdrawQueued(id);return read(id);},
  async stop(id){const current=await read(id);if(current.web.stopped||(!activeRuns.has(id)&&current.assembly?.validation?.errors?.length===0))return current;await holdLease();pausedRuns.add(pauseKey(id));const d=await changeState(id,{stopped:true,pauseRequested:false,progress:'stopped'});for(const op of d.operations.filter(o=>o.status==='running'))cancelled.add(op.attemptId);await engine.cancel(id,{reason:'user_stop'});withdrawQueued(id);return read(id);},
  async choose(id,{mode,overrides,unitOverrides,expectedFingerprint,resetDrafts:reset=false}={}){ensureIdle(id);await holdLease();return update(id,d=>{assertEditable(d);if(expectedFingerprint&&selectionFingerprint(d.plan,d.choice)!==expectedFingerprint)fail('SELECTION_FINGERPRINT','幻想选择指纹过期');if(d.adopted.length&&!reset)fail('RESET_DRAFTS_REQUIRED','已有正文，改选须明确归档重做');const nextMode=mode||d.choice.mode,base=nextMode===d.choice.mode?d.choice:defaultChoice(nextMode),choice={...base,overrides:overrides??base.overrides,unitOverrides:unitOverrides??base.unitOverrides,confirmedFingerprint:null},settings=normalizeSettings({...d.settings,fantasyMode:nextMode});resolveSelection(d.plan,choice);if(reset)resetDrafts(d);d.settings=settings;d.choice=choice;d.assembly=null;d.status='planned';d.web.progress='planned';d.web.error=null;return d;});},
  async confirm(id,{selectedIds,expectedFingerprint,resetDrafts:reset=false}={}){ensureIdle(id);await holdLease();return update(id,d=>{assertEditable(d);if(d.adopted.length&&!reset)fail('RESET_DRAFTS_REQUIRED','已有正文，确认须明确归档重做');const choice=confirmSelection(d.plan,d.choice,selectedIds,expectedFingerprint);if(reset)resetDrafts(d);d.choice=choice;d.assembly=null;d.status='planned';d.web.progress='planned';d.web.error=null;return d;});},
  async recover(id,attemptId){return withIdleLease(id,async current=>{if(current.web.sourceStale||!(await beforeExecute(current.web.binding))){await changeState(id,{sourceStale:true,progress:'source_stale'});fail('SOURCE_STALE','源版本已变化，请保留旧稿并创建新任务');}const d=await engine.recover(id,attemptId);return changeState(id,{progress:d.operations.some(o=>o.status==='unknown'&&isLive(o))?'unknown':d.status,error:null});});},
  async cancellationStatus(id){const d=await read(id);return Promise.all(d.operations.filter(o=>o.status==='unknown'||o.error?.code==='ABORTED').map(op=>cancellationCheck(d,op)));},
  async acknowledgeCancelled(id,{attemptId,acceptUnknownUsage}={}){if(acceptUnknownUsage!==true)fail('UNKNOWN_USAGE_CONFIRMATION','须明确接受此次中断费用仍未知；此操作不会启动新请求');return withIdleLease(id,async d=>{const op=d.operations.find(o=>o.attemptId===attemptId);if(!op)fail('ATTEMPT','作业不存在');if(op.cancelAcknowledgement?.acceptUnknownUsage===true)return update(id,settleAcknowledgedStop);
   const status=await cancellationCheck(d,op,{ownsLease:true});if(!status.canAcknowledge)fail(status.code,status.reason);
   return update(id,current=>{const target=current.operations.find(o=>o.attemptId===attemptId);if(!current.web.stopped||target.status!=='unknown'||current.operations.some(o=>o.status==='running'))fail('RUN_ACTIVE','任务状态已变化，请重新核对');target.cancelAcknowledgement??={at:new Date().toISOString(),acceptUnknownUsage:true};return settleAcknowledgedStop(current);});},{allowUnresolvedSibling:true});},
  async recheck(id,candidateId){ensureIdle(id);await holdLease();const d=await engine.recheckCandidate(id,candidateId);return changeState(id,{progress:d.status,error:null});},
  async setBudget(id,value){ensureIdle(id);await holdLease();return update(id,d=>{d.web.budget=budgetOf(value);if(['failed','budget_stop'].includes(d.web.progress))d.web.progress=d.plan?'planned':'created';d.web.error=null;return d;});},
  async exportDraft(id){const d=await read(id);return d.assembly?.text||null;},
  active:id=>activeRuns.has(id),
  wait:idle,
  async shutdown(){return shutdownTask??=(async()=>{closed=true;await leasePending?.catch(()=>{});await Promise.allSettled([...pendingWrites]);await Promise.all([...activeRuns.keys()].map(id=>engine.cancel(id)));await Promise.allSettled([...activeRuns.values()]);if(leaseRef){const record=leaseRef;leaseRef=null;await releaseLease(directory,record);}})();}
 };
 for(const name of ['prepareWrite','withPreparation','create','start','replan','repair','pause','stop','choose','confirm','recover','acknowledgeCancelled','recheck','setBudget']){
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
