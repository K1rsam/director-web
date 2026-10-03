import {open} from 'node:fs/promises';
import path from 'node:path';
import {fail} from './shared.mjs';

const eventTypes=new Set(['thread.started','turn.started','turn.completed','turn.failed','item.started','item.updated','item.completed','error','unknown']);
const failureTypes=new Set(['timeout','aborted','paused','cli_failed','spawn_failed','empty_response','invalid_json','rate_limit','auth','network','unknown']);
const structuredFailures=new Map([
  ...['rate_limit_exceeded','rate_limit_error','rate_limit','usage_limit_reached','insufficient_quota'].map(code=>[code,'rate_limit']),
  ...['authentication_error','invalid_api_key','unauthorized','auth_error'].map(code=>[code,'auth']),
  ...['connection_error','network_error','connection_failed','ECONNRESET','ECONNREFUSED','ETIMEDOUT'].map(code=>[code,'network'])
]);
const localFailures={TIMEOUT:'timeout',ABORTED:'aborted',PAUSED:'paused',CLI_FAILED:'cli_failed',EMPTY_RESPONSE:'empty_response',INVALID_JSON:'invalid_json'};
const stages=new Set(['plan','author','finish']),tailLimit=32,maxBytes=16384;
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value;
const validName=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
const writeFailure=()=>Object.assign(new Error('Attempt diagnostics could not be saved'),{code:'DIAGNOSTICS_WRITE_FAILED'});

export async function readAttemptDiagnostics({directory,attemptId}={}){
  if(typeof directory!=='string'||!directory.trim()||!validName(attemptId))fail('INVALID_ATTEMPT','Invalid attempt directory or id');
  let handle;
  try{handle=await open(path.join(path.resolve(directory),'attempts',attemptId,'diagnostics.json'),'r');}
  catch(error){if(error.code==='ENOENT')return null;throw error;}
  let value;
  try{
    if((await handle.stat()).size>maxBytes)throw new Error();
    const buffer=Buffer.alloc(maxBytes+1),{bytesRead}=await handle.read(buffer,0,buffer.length,0);
    if(bytesRead>maxBytes)throw new Error();
    value=JSON.parse(buffer.subarray(0,bytesRead).toString('utf8'));
  }catch{fail('DIAGNOSTICS_CORRUPT','Attempt diagnostics are unreadable or invalid');}
  finally{await handle.close();}
  const d=value;
  if(!d||d.version!==1||d.attemptId!==attemptId||!stages.has(d.stage)||!integer(d.timeoutMs)||d.timeoutMs<1||d.timeoutMs>3600000||
    !timestamp(d.startedAt)||(d.endedAt!==null&&!timestamp(d.endedAt))||(d.lastActivityAt!==null&&!timestamp(d.lastActivityAt))||
    ![d.eventCount,d.stdoutBytes,d.stderrBytes].every(integer)||!d.eventCounts||typeof d.eventCounts!=='object'||Array.isArray(d.eventCounts)||
    Object.entries(d.eventCounts).some(([type,count])=>!eventTypes.has(type)||!integer(count))||
    Object.values(d.eventCounts).reduce((sum,count)=>sum+count,0)!==d.eventCount||
    (d.failureCategory!==null&&!failureTypes.has(d.failureCategory))||!Array.isArray(d.eventTail)||d.eventTail.length>tailLimit||d.eventTail.length>d.eventCount||
    d.eventTail.some(event=>!event||!timestamp(event.timestamp)||!eventTypes.has(event.type)))fail('DIAGNOSTICS_CORRUPT','Attempt diagnostics have an invalid shape');
  return {version:1,attemptId,stage:d.stage,timeoutMs:d.timeoutMs,startedAt:d.startedAt,endedAt:d.endedAt,lastActivityAt:d.lastActivityAt,
    eventCount:d.eventCount,eventCounts:Object.fromEntries(Object.entries(d.eventCounts)),stdoutBytes:d.stdoutBytes,stderrBytes:d.stderrBytes,
    failureCategory:d.failureCategory,eventTail:d.eventTail.map(({timestamp,type})=>({timestamp,type}))};
}

export function createAttemptDiagnostics({attemptId,stage,timeoutMs,persist}){
  const data={version:1,attemptId,stage,timeoutMs,startedAt:new Date().toISOString(),endedAt:null,lastActivityAt:null,
    eventCount:0,eventCounts:{},stdoutBytes:0,stderrBytes:0,failureCategory:null,eventTail:[]};
  let timer=null,pending=Promise.resolve(),writing=false,dirty=false,writeError=null,stopped=false,structuredFailure=null;
  const flush=()=>{
    dirty=true;if(writing)return pending;writing=true;
    pending=Promise.resolve().then(async()=>{
      do{
        dirty=false;
        try{await persist(structuredClone(data));writeError=null;}catch{writeError=writeFailure();}
      }while(dirty);
      writing=false;
    });
    return pending;
  };
  const schedule=()=>{if(!timer&&!stopped){timer=setTimeout(()=>{timer=null;void flush();},250);timer.unref?.();}};
  return {
    async start(){await flush();if(writeError)throw writeError;},
    activity(stream,bytes){if(stopped)return;data[stream==='stderr'?'stderrBytes':'stdoutBytes']+=bytes;data.lastActivityAt=new Date().toISOString();schedule();},
    event(event){
      if(stopped)return;
      const type=eventTypes.has(event?.type)?event.type:'unknown',at=new Date().toISOString();
      data.eventCount++;data.eventCounts[type]=(data.eventCounts[type]||0)+1;data.lastActivityAt=at;
      data.eventTail.push({timestamp:at,type});if(data.eventTail.length>tailLimit)data.eventTail.shift();
      if(type==='turn.failed'||type==='error'){
        const category=structuredFailures.get(event?.error?.code??event?.code)||'unknown';
        structuredFailure=category;
        data.failureCategory=structuredFailure;
      }
      schedule();
    },
    async finish(errorCode,{spawnFailed=false}={}){
      stopped=true;clearTimeout(timer);timer=null;data.endedAt=new Date().toISOString();
      data.failureCategory=structuredFailure||(errorCode?(spawnFailed?'spawn_failed':Object.hasOwn(localFailures,errorCode)?localFailures[errorCode]:'unknown'):null);
      await flush();if(writeError)throw writeError;
    }
  };
}
