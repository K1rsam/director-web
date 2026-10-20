import {setTimeout as delay} from 'node:timers/promises';

/** These retries are only for read callbacks. Never wrap dispatch or a write/reconciliation callback. */
export function isTransientDatabaseReadError(error:unknown):boolean{
 let current=error;
 for(let depth=0;depth<4&&current&&typeof current==='object';depth++){
  const value=current as {code?:string;message?:string;cause?:unknown;readOnlyTransactionExpired?:boolean};
  if(['UPSTREAM_CHANGED','SOURCE_STALE','SOURCE_DIAGNOSTICS','SOURCE_PROTOCOL','EPISODE_NOT_PRODUCTION','PRODUCTION_CHAIN_BINDING','PRODUCTION_SELECTION_CHANGED','WORKFLOW_SOURCE_CHANGED'].includes(value.code??''))return false;
  if(['P1008','SQLITE_BUSY','SQLITE_LOCKED'].includes(value.code??'')||/SQLITE_BUSY|database is locked/i.test(value.message??''))return true;
  if(value.code==='P2028'&&value.readOnlyTransactionExpired===true)return true;
  current=value.cause;
 }
 return false;
}

export async function retryDatabaseRead<T>(read:()=>Promise<T>,options:{signal?:AbortSignal;maxElapsedMs?:number}={}):Promise<T>{
 const started=Date.now();
 for(let attempt=0;;attempt++){
  options.signal?.throwIfAborted();
  try{return await read();}
  catch(error){
   options.signal?.throwIfAborted();
   if(!isTransientDatabaseReadError(error))throw error;
   if(attempt>=2||Date.now()-started>=(options.maxElapsedMs??45_000)){
    // Only this pure-read boundary may authorize a worker's bounded reconnect.
    throw Object.assign(new Error('数据库只读核对暂未完成。',{cause:error}),{code:(error as {code?:string}).code??'DATABASE_READ_UNAVAILABLE',retryableRead:true});
   }
   await delay(50*(attempt+1),undefined,{signal:options.signal});
  }
 }
}

/** ponytail: share only an in-flight read; each caller gets its own immutable snapshot ownership, no TTL. */
export function createInflightRead<T>(){
 const pending=new Map<string,Promise<T>>();
 return async(key:string,read:()=>Promise<T>):Promise<T>=>{
  let value=pending.get(key);
  if(!value){
   const started=Promise.resolve().then(read).finally(()=>{if(pending.get(key)===started)pending.delete(key);});
   pending.set(key,started);value=started;
  }
  return structuredClone(await value);
 };
}

export function upstreamReadKey(projectId:string,episodeNumber:number,scope:{workflowId:string;runId:string}|undefined,options:object):string{
 return JSON.stringify([projectId,episodeNumber,scope?.workflowId??null,scope?.runId??null,Object.entries(options).sort(([a],[b])=>a.localeCompare(b))]);
}

export function productionRefreshTargets<T extends Record<string,any>>(runs:T[],projectId:string,changedRunId?:string):T[]{
 const eligible=runs.filter(run=>run.web?.binding?.projectId===projectId&&run.production&&!run.web?.legacyReadOnly);
 if(changedRunId===undefined)return eligible;
 const changed=runs.find(run=>run.id===changedRunId&&run.web?.binding?.projectId===projectId),number=changed?.web?.binding?.episodeNumber;
 if(!Number.isSafeInteger(number)||number<0)throw Object.assign(new Error('刷新目标不属于本项目的有效分集绑定。'),{code:'PRODUCTION_CHAIN_BINDING',status:409,requestOutcome:'NOT_SENT'});
 return eligible.filter(run=>Math.abs((run.web.binding.episodeNumber??Number.NaN)-number)<=1);
}

/** Startup is not authorization to reopen every accepted project. */
export function productionStartupRecoveryTargets<T extends Record<string,any>>(runs:T[],selectedRunIds:ReadonlySet<string>):T[]{
 return runs.filter(run=>selectedRunIds.has(run.id)&&run.production&&!run.web?.legacyReadOnly&&(run.status!=='text_ready_for_review'
  ||run.production.blocking||run.production.pendingRepair||['PRELIMINARY','UNRESOLVED'].includes(run.production.boundaryCheck?.status)
  ||run.operations?.some((op:Record<string,any>)=>['running','queued'].includes(op.status)||op.status==='unknown'&&op.cancelAcknowledgement?.acceptUnknownUsage!==true)));
}

export function preparedSourceState(knownStale:boolean,preparation:{ready:boolean;deferred?:boolean},compatible:boolean){
 return {sourceStale:knownStale||(preparation.ready&&!compatible),sourceCheckPending:!preparation.ready};
}
