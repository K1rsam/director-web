import {randomUUID,createHash} from 'node:crypto';
import {hostname} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createStore} from './storyboard-v4/core/store.mjs';

export const PRODUCTION_BUDGET_VERSION='PRODUCTION_BUDGET_V1';
const count=n=>Number.isSafeInteger(n)&&n>=0;
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hashString=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code,requestOutcome:'NOT_SENT'});};
function summary(d){
 const effective=d.attempts.map(a=>{const recovered=d.reconciliations?.findLast(r=>r.attemptId===a.id);return recovered?{...a,status:'RESPONDED',totalTokens:recovered.totalTokens}:a;});
 const settled=effective.filter(a=>a.status!=='DISPATCHING');
 const inFlight=effective.filter(a=>a.status==='DISPATCHING');
 const orphaned=inFlight.filter(a=>{if(a.host!==hostname())return true;try{process.kill(a.pid,0);return false;}catch{return true;}});
 const unknown=settled.filter(a=>a.totalTokens===null);
 // Consent is not a native receipt. Keep unknown counts and incomplete totals;
 // only the exact immutable, closed attempt may stop blocking further dispatch.
 const acknowledged=unknown.filter(a=>a.status==='UNKNOWN'&&a.finishedAt&&d.unknownUsageAcknowledgements?.some(r=>r.attemptId===a.id&&r.projectId===a.projectId&&r.runId===a.runId&&r.acceptUnknownUsage===true&&r.attemptHash===hash(a)&&hashString(r.evidenceHash)&&typeof r.actorId==='string'&&r.actorId&&typeof r.note==='string'&&r.note));
 return {calls:d.attempts.length,knownTokens:settled.reduce((n,a)=>n+(count(a.totalTokens)?a.totalTokens:0),0),
  unknownAttempts:unknown.length+orphaned.length,acknowledgedUnknownAttempts:acknowledged.length,blockingUnknownAttempts:unknown.length+orphaned.length-acknowledged.length,inFlight:inFlight.length,
  complete:!inFlight.length&&settled.every(a=>a.totalTokens!==null)};
}
export function productionUsage(provider,result){
 const native=result?.usage??result?.receipt?.usage;
 if(native&&typeof native==='object'){
  const input=native.inputTokens??native.prompt_tokens,output=native.outputTokens??native.completion_tokens;
  const reportedTotal=native.totalTokens===undefined?native.total_tokens:native.totalTokens;
  // Adapters use explicit null for an untrusted receipt; do not reconstruct it
  // from otherwise valid components or fall back to a different receipt.
  if(reportedTotal===null)return {totalTokens:null};
  const total=reportedTotal===undefined&&count(input)&&count(output)?input+output:reportedTotal;
  const validComponents=(input==null||count(input))&&(output==null||count(output));
  if(count(total)&&validComponents&&(input==null||total>=input)&&(output==null||total>=output)
   &&(!count(input)||!count(output)||total===input+output))return {totalTokens:total};
 }
 if(provider!=='CLI'||typeof result?.stdout!=='string')return {totalTokens:null};
 let seen=null,total=null;
 for(const line of result.stdout.split(/\r?\n/)){
  let event;try{event=JSON.parse(line);}catch{continue;}
  if(event.type!=='turn.completed')continue;
  const u=event.usage,serialized=JSON.stringify(event);
  if(!u||!count(u.input_tokens)||!count(u.output_tokens)||!count(u.input_tokens+u.output_tokens)
   ||u.cached_input_tokens!==undefined&&(!count(u.cached_input_tokens)||u.cached_input_tokens>u.input_tokens)
   ||seen!==null&&seen!==serialized)return {totalTokens:null};
  seen=serialized;total=u.input_tokens+u.output_tokens;
 }
 return {totalTokens:total};
}
export function createProductionBudgetStore(directory){
 const store=createStore(directory);
 // Reuse the engine's atomic writer and cross-process lock; never hold it during a model call.
 const change=async(id,mutator)=>{
  for(let attempt=0;;attempt++)try{return await store.update(id,mutator);}catch(e){if(e.code!=='BUSY'||attempt>=39)throw e;await delay(25);}
 };
 const check=d=>{if(d.schema!==PRODUCTION_BUDGET_VERSION||!Array.isArray(d.attempts))fail('PRODUCTION_BUDGET_SCHEMA','预算记录版本不可识别，未发送请求。');return d;};
 return {
  async create(id,{projectIds,maxCalls,maxTokens}){
   if(!Array.isArray(projectIds)||!projectIds.length||projectIds.some(x=>typeof x!=='string'||!x)||new Set(projectIds).size!==projectIds.length||!count(maxCalls)||!count(maxTokens))fail('PRODUCTION_BUDGET_CONFIG','预算范围或停止线无效。');
   return store.create(id,{schema:PRODUCTION_BUDGET_VERSION,id,projectIds,maxCalls,maxTokens,paused:false,createdAt:new Date().toISOString(),attempts:[]});
  },
  async read(id){const d=check(await store.read(id));return {...d,summary:summary(d)};},
  async reviseLimits(id,{projectId,actorId,costAcknowledged,expectedLimits,maxCalls,maxTokens,note}={}){
   if(costAcknowledged!==true||typeof actorId!=='string'||!actorId.trim()||typeof note!=='string'||!note.trim()||note.length>4000||!count(maxCalls)||!count(maxTokens)||!expectedLimits||Object.keys(expectedLimits).length!==2||!count(expectedLimits.maxCalls)||!count(expectedLimits.maxTokens))fail('PRODUCTION_LIMITS_CONSENT','停止线修订须明确授权、完整旧停止线与有限新停止线；不会重置用量。');
   return change(id,d=>{
    check(d);if(!d.projectIds.includes(projectId))fail('PRODUCTION_BUDGET_SCOPE','停止线授权不属于此项目。');
    if(d.maxCalls!==expectedLimits.maxCalls||d.maxTokens!==expectedLimits.maxTokens)fail('PRODUCTION_LIMITS_STALE','共享停止线已变化，未覆盖新的授权。');
    if(d.maxCalls===maxCalls&&d.maxTokens===maxTokens)return d;
    d.limitRevisions??=[];d.limitRevisions.push({projectId,actorId,note,at:new Date().toISOString(),before:{maxCalls:d.maxCalls,maxTokens:d.maxTokens},after:{maxCalls,maxTokens}});
    d.maxCalls=maxCalls;d.maxTokens=maxTokens;return d;
   });
  },
  async reserve(id,{attemptId=randomUUID(),projectId,stage,provider,model=null,runId=null}){
   if(typeof attemptId!=='string'||!attemptId||typeof stage!=='string'||!stage||!['CLI','API','JEV'].includes(provider))fail('PRODUCTION_BUDGET_CONFIG','派单记账信息无效。');
   await change(id,d=>{
    check(d);if(!d.projectIds.includes(projectId))fail('PRODUCTION_BUDGET_SCOPE','请求不在该预算的项目范围内。');
    if(d.attempts.some(a=>a.id===attemptId))fail('PRODUCTION_ATTEMPT_EXISTS','该请求已经登记；请恢复已有回包，不能重复发送。');
    const s=summary(d);
    if(d.paused)fail('PRODUCTION_BUDGET_PAUSED','共享生产预算已暂停。');
    if(s.blockingUnknownAttempts)fail('PRODUCTION_USAGE_UNKNOWN','共享预算存在未授权的未知用量；保留结果，先核对回执，不再派发付费请求。');
    if(s.calls>=d.maxCalls||s.knownTokens>=d.maxTokens)fail('PRODUCTION_BUDGET_LIMIT','已达到共享生产预算停止线，未发送新请求。');
    d.attempts.push({id:attemptId,projectId,stage,provider,model,runId,status:'DISPATCHING',startedAt:new Date().toISOString(),pid:process.pid,host:hostname(),totalTokens:null});return d;
   });return attemptId;
  },
  async settle(id,attemptId,{usage,outcome='RESPONDED',errorCode=null}){
   if(!['RESPONDED','UNKNOWN','NOT_SENT'].includes(outcome))fail('PRODUCTION_RECEIPT_INVALID','调用结果类别无效。');
   const totalTokens=outcome==='NOT_SENT'?0:count(usage?.totalTokens)?usage.totalTokens:null;
   return change(id,d=>{
    check(d);const attempt=d.attempts.find(a=>a.id===attemptId);
    if(!attempt)fail('PRODUCTION_ATTEMPT_MISSING','找不到对应派单，未创建虚构用量。');
    if(attempt.status!=='DISPATCHING'){
     if(attempt.status!==outcome||attempt.totalTokens!==totalTokens)fail('PRODUCTION_RECEIPT_CONFLICT','回执与已有记录冲突，旧记录未覆盖。');
     return d;
    }
    Object.assign(attempt,{status:outcome,totalTokens,errorCode,finishedAt:new Date().toISOString()});return d;
   });
  },
  async pause(id){return change(id,d=>({...check(d),paused:true}));},
  async acknowledgeUnknown(id,attemptId,{projectId,runId,actorId,acceptUnknownUsage,expectedAttemptHash,evidenceHash,note}={}){
   if(acceptUnknownUsage!==true||typeof actorId!=='string'||!actorId.trim()||typeof note!=='string'||!note.trim()||!hashString(expectedAttemptHash)||!hashString(evidenceHash))fail('PRODUCTION_UNKNOWN_CONSENT','须提供针对单条未知费用的明确授权及已核对证据绑定；不会把未知用量改成零。');
   return change(id,d=>{
    check(d);const attempt=d.attempts.find(a=>a.id===attemptId);
    if(!attempt)fail('PRODUCTION_ATTEMPT_MISSING','费用授权没有对应派单。');
    if(!d.projectIds.includes(projectId)||attempt.projectId!==projectId||attempt.runId!==runId)fail('PRODUCTION_BUDGET_SCOPE','费用授权不属于此项目和分镜任务。');
    if(attempt.status!=='UNKNOWN'||attempt.totalTokens!==null||!attempt.finishedAt||d.reconciliations?.some(r=>r.attemptId===attemptId))fail('PRODUCTION_ACK_STATE','仅可接受已结束但用量仍未知的这一次调用；在途或已有原生用量不适用。');
    if(hash(attempt)!==expectedAttemptHash)fail('PRODUCTION_ACK_STALE','该调用记录已变化，请重新核对；未采用旧授权。');
    const record={attemptId,projectId,runId,actorId,acceptUnknownUsage:true,attemptHash:expectedAttemptHash,evidenceHash,note};
    const previous=d.unknownUsageAcknowledgements?.find(r=>r.attemptId===attemptId);
    if(previous){const {at,...binding}=previous;if(hash(binding)!==hash(record))fail('PRODUCTION_ACK_CONFLICT','这次费用授权已记录且绑定不同，未覆盖旧记录。');return d;}
    d.unknownUsageAcknowledgements??=[];d.unknownUsageAcknowledgements.push({...record,at:new Date().toISOString()});return d;
   });
  },
  async reconcile(id,attemptId,{totalTokens,evidenceHash}){
   if(!count(totalTokens)||typeof evidenceHash!=='string'||!evidenceHash)fail('PRODUCTION_RECEIPT_INVALID','缺少已核验的原生用量回执。');
   return change(id,d=>{
    check(d);const attempt=d.attempts.find(a=>a.id===attemptId);
    if(!attempt)fail('PRODUCTION_ATTEMPT_MISSING','恢复回执没有对应派单。');
    const previous=d.reconciliations?.findLast(r=>r.attemptId===attemptId);
    if(previous||count(attempt.totalTokens)){
     if((previous?.totalTokens??attempt.totalTokens)!==totalTokens)fail('PRODUCTION_RECEIPT_CONFLICT','恢复用量与已记录账本冲突，未覆盖历史。');
     return d;
    }
    d.reconciliations??=[];d.reconciliations.push({attemptId,totalTokens,evidenceHash,at:new Date().toISOString()});return d;
   });
  }
 };
}

/** Reserves before dispatch; unacknowledged unknown usage blocks new calls, not saving this paid result. */
export async function withProductionBudget(context,action){
 if(!context)return action();
 const ledger=createProductionBudgetStore(context.directory);
 const attemptId=await ledger.reserve(context.id,context);
 let result;
 try{result=await action();}
 catch(error){
  const outcome=error?.requestOutcome==='NOT_SENT'?'NOT_SENT':error?.requestOutcome==='RESPONDED'?'RESPONDED':'UNKNOWN';
  try{await ledger.settle(context.id,attemptId,{usage:productionUsage(context.provider,error),outcome,errorCode:error?.code??'PROVIDER_ERROR'});}
  catch(accountingError){if(error&&typeof error==='object')error.budgetReceiptError=accountingError.code??'BUDGET_RECEIPT_WRITE';}
  throw error;
 }
 try{await ledger.settle(context.id,attemptId,{usage:productionUsage(context.provider,result),outcome:'RESPONDED'});}
 catch(error){throw Object.assign(new Error('结果已返回，但预算回执保存失败；先恢复现有结果，不能重发。'),{code:'PRODUCTION_RECEIPT_WRITE',requestOutcome:'RESPONDED',raw:result?.raw,rawOutput:result?.rawOutput,stdout:result?.stdout,usage:result?.usage,budgetCause:error.code});}
 return result;
}
