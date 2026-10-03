import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createStore} from './storyboard-v4/core/store.mjs';

export const PRODUCTION_BUDGET_VERSION='PRODUCTION_BUDGET_V1';
const count=n=>Number.isSafeInteger(n)&&n>=0;
const fail=(code,message)=>{throw Object.assign(new Error(message),{code,requestOutcome:'NOT_SENT'});};
function summary(d){
 const effective=d.attempts.map(a=>{const recovered=d.reconciliations?.findLast(r=>r.attemptId===a.id);return recovered?{...a,status:'RESPONDED',totalTokens:recovered.totalTokens}:a;});
 const settled=effective.filter(a=>a.status!=='DISPATCHING');
 const inFlight=effective.filter(a=>a.status==='DISPATCHING');
 const orphaned=inFlight.filter(a=>{if(a.host!==hostname())return true;try{process.kill(a.pid,0);return false;}catch{return true;}});
 return {calls:d.attempts.length,knownTokens:settled.reduce((n,a)=>n+(count(a.totalTokens)?a.totalTokens:0),0),
  unknownAttempts:settled.filter(a=>a.totalTokens===null).length+orphaned.length,inFlight:inFlight.length,
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
  async reserve(id,{attemptId=randomUUID(),projectId,stage,provider,model=null,runId=null}){
   if(typeof attemptId!=='string'||!attemptId||typeof stage!=='string'||!stage||!['CLI','API','JEV'].includes(provider))fail('PRODUCTION_BUDGET_CONFIG','派单记账信息无效。');
   await change(id,d=>{
    check(d);if(!d.projectIds.includes(projectId))fail('PRODUCTION_BUDGET_SCOPE','请求不在该预算的项目范围内。');
    if(d.attempts.some(a=>a.id===attemptId))fail('PRODUCTION_ATTEMPT_EXISTS','该请求已经登记；请恢复已有回包，不能重复发送。');
    const s=summary(d);
    if(d.paused)fail('PRODUCTION_BUDGET_PAUSED','共享生产预算已暂停。');
    if(s.unknownAttempts)fail('PRODUCTION_USAGE_UNKNOWN','共享预算存在未知用量；保留结果，先核对回执，不再派发付费请求。');
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

/** Reserves before dispatch; settled unknown usage blocks the next call, not saving this paid result. */
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
