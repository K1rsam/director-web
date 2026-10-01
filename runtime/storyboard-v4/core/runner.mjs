import childProcess,{spawn} from 'node:child_process';
import {mkdir,mkdtemp,open,readFile,realpath,rm,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir,hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {stripVTControlCharacters} from 'node:util';
import {digest,fail} from './shared.mjs';

const disabled=['apps','browser_use','computer_use','image_generation','in_app_browser','workspace_dependencies','multi_agent','plugins','memories','hooks','shell_tool','unified_exec','view_image','skill_search'];
const usageEmpty=()=>({inputTokens:null,cachedInputTokens:null,outputTokens:null,totalTokens:null});
const validName=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
const efforts={
  'gpt-6.1-sol':new Set(['low','medium','high','xhigh','max','ultra']),
  'gpt-6-sol':new Set(['low','medium','high','xhigh','max','ultra']),
  'gpt-6-astra':new Set(['low','medium','high','xhigh','max','ultra'])
};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const minute=60000,eventTypes=new Set(['thread.started','turn.started','turn.completed','turn.failed','item.started','item.updated','item.completed','error']);
function runnerWorkload(request){
  return {stage:['plan','author','finish'].includes(request?.stage)?request.stage:'unknown',promptChars:typeof request?.prompt==='string'?request.prompt.length:0,unitCount:Math.max(Array.isArray(request?.plan?.provisionalUnits)?request.plan.provisionalUnits.length:0,Array.isArray(request?.previousDraft?.units)?request.previousDraft.units.length:0)};
}
export function resolveRunnerLimits(request,{timeoutMs,startupTimeoutMs,idleTimeoutMs}={}){
  const load=runnerWorkload(request),base=({plan:8,author:10,finish:12})[load.stage]||10;
  // Character/unit counts are observable workload, not token or cost estimates.
  const defaultTotal=Math.min(30*minute,(base+load.unitCount+Math.ceil(load.promptChars/16000))*minute);
  const bounded=(value,fallback,max)=>Math.min(max,Math.max(1,Number.isFinite(value)?Math.round(value):fallback));
  const totalMs=bounded(timeoutMs,defaultTotal,30*minute);
  return {startupMs:bounded(startupTimeoutMs,3*minute,totalMs),idleMs:bounded(idleTimeoutMs,Math.max(6*minute,defaultTotal-2*minute),totalMs),totalMs};
}
// Store only bounded failure evidence, never complete CLI event streams or reasoning.
function safeDiagnostic(value){
  return stripVTControlCharacters(String(value))
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi,'$1[redacted]@')
    .replace(/(["']?(?:authorization|proxy-authorization|cookie|set-cookie)["']?\s*[:=]\s*)[^\r\n]*/gi,'$1[redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi,'$1 [redacted]')
    .replace(/(["']?(?:[a-z0-9_-]*api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s&,;}]+)/gi,'$1[redacted]')
    .replace(/\bsk-[a-z0-9_-]+/gi,'[redacted]')
    .replace(/\beyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+/gi,'[redacted]')
    .trim();
}
function selected(model='gpt-6.1-sol',reasoning='medium'){
  if(!efforts[model]?.has(reasoning))fail('INVALID_MODEL_SETTINGS','Unsupported model or reasoning effort');
  return {model,reasoning};
}
export function buildRunnerArgs({model='gpt-6.1-sol',reasoning='medium',cwd,outputPath,instructionsPath,schemaPath}={}){
  selected(model,reasoning);
  if(![cwd,outputPath,instructionsPath].every(s=>typeof s==='string'&&path.isAbsolute(s)))fail('INVALID_PATH','Absolute runner paths required');
  return ['exec','--ignore-user-config','--ignore-rules','--ephemeral','--json',
    ...disabled.flatMap(name=>['--disable',name]),'--enable','skip_host_skill_discovery',
    '-c','skills.include_instructions=false','-c','project_doc_max_bytes=0',
    '--model',model,'-c',`model_reasoning_effort=${JSON.stringify(reasoning)}`,
    '-c',`model_instructions_file=${JSON.stringify(instructionsPath)}`,'-c','web_search="disabled"',
    '--sandbox','read-only','--skip-git-repo-check','--cd',cwd,
    ...(schemaPath?['--output-schema',schemaPath]:[]),'-o',outputPath,'-'];
}
function parseView(raw){
  let text=raw.trim();const fence=/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i.exec(text);if(fence)text=fence[1];
  try{return JSON.parse(text);}catch{}
  // Only the parsing view changes. The paid raw response remains untouched.
  let view='',quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(quoted){view+=c;if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"'){quoted=true;view+=c;continue;}
    if(c===','&&/^[\s]*[}\]]/.test(text.slice(i+1)))continue;
    view+=c;
  }
  return JSON.parse(view);
}
function parseResponseBodies(raw,fallback=''){
  try{return {output:parseView(raw),raw};}catch(error){
    if(fallback.trim()&&fallback!==raw){try{return {output:parseView(fallback),raw:fallback};}catch{}}
    throw error;
  }
}
function killGroup(child,sig){
  if(!child?.pid)return 'not_sent';
  try{process.kill(-child.pid,sig);return 'sent';}catch(error){
    if(error.code==='ESRCH')return 'not_found';
    try{return child.kill(sig)?'sent':'not_sent';}catch{return 'failed';}
  }
}
function usageOf(event){
  const u=event.usage||{},r=usageEmpty();
  if(integer(u.input_tokens))r.inputTokens=u.input_tokens;
  if(integer(u.output_tokens))r.outputTokens=u.output_tokens;
  if(integer(u.cached_input_tokens)&&r.inputTokens!==null&&u.cached_input_tokens<=r.inputTokens)r.cachedInputTokens=u.cached_input_tokens;
  if(r.inputTokens!==null&&r.outputTokens!==null&&integer(r.inputTokens+r.outputTokens))r.totalTokens=r.inputTokens+r.outputTokens;
  return r;
}
export async function readCompletedAttempt({directory,attemptId}={}){
  if(typeof directory!=='string'||!directory.trim()||!validName(attemptId))fail('INVALID_ATTEMPT','Invalid attempt directory or id');
  const attempt=path.join(path.resolve(directory),'attempts',attemptId);
  const receipt=await readFile(path.join(attempt,'receipt.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(receipt?.state!=='FINAL'||receipt.requestOutcome!=='RESPONDED'||receipt.responseDisposition==='incomplete')fail('ATTEMPT_UNRESOLVED','Attempt has no completed response receipt');
  const saved=await readFile(path.join(attempt,'raw.txt'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  const event=await readFile(path.join(attempt,'event-final.txt'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  let raw=saved.trim()?saved:event;
  if(!raw.trim())fail('ATTEMPT_UNRESOLVED','Completed receipt has no saved response body');
  const request=await readFile(path.join(attempt,'request.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const requestFingerprint=request?digest([request.promptHash,request.instructionHash,request.inputHash]):null;
  let output;try{({output,raw}=parseResponseBodies(raw,event));}catch{
    throw Object.assign(new Error('Saved response is not valid JSON'),{code:'INVALID_JSON',raw,usage:receipt.usage||usageEmpty(),requestOutcome:'RESPONDED',requestFingerprint});
  }
  return {output,raw,usage:receipt.usage||usageEmpty(),requestOutcome:'RESPONDED',requestFingerprint};
}
export async function readAttemptEvidence({directory,attemptId}={}){
  if(typeof directory!=='string'||!directory.trim()||!validName(attemptId))fail('INVALID_ATTEMPT','Invalid attempt directory or id');
  const attempt=path.join(path.resolve(directory),'attempts',attemptId);
  const receipt=await readFile(path.join(attempt,'receipt.json'),'utf8').then(JSON.parse).catch(()=>null);
  const bodies=await Promise.all(['raw.txt','event-final.txt'].map(file=>readFile(path.join(attempt,file),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;})));
  const hasResponseBody=bodies.some(raw=>raw.trim().length>0);
  let legacyProcessState='not_checked';
  if(!receipt?.localProcess&&receipt?.state==='FINAL'&&receipt.requestOutcome==='UNKNOWN'&&receipt.errorCode==='ABORTED'&&!hasResponseBody){
    try{
      const directories=[...new Set([attempt,await realpath(attempt)])];
      const listing=await new Promise((resolve,reject)=>childProcess.execFile('/bin/ps',['-axo','pid=,command=','-ww'],{encoding:'utf8',maxBuffer:16*1024*1024,timeout:2000},(error,stdout)=>error?reject(error):resolve(stdout)));
      const rows=listing.split('\n').filter(line=>line.trim()).map(line=>/^\s*(\d+)\s+(.+)$/.exec(line));
      // A readable receipt alone does not prove an older, untracked CLI has exited.
      // Keep commands local: only the classification leaves this inspection.
      if(!rows.length||rows.some(row=>!row)||!rows.some(row=>Number(row[1])===process.pid))legacyProcessState='unverified';
      else legacyProcessState=rows.some(row=>directories.some(folder=>row[2].includes(folder+path.sep)||row[2].endsWith(folder)||[' ',"'",'"'].some(end=>row[2].includes(folder+end))))?'active':'not_found';
    }catch{legacyProcessState='unverified';}
  }
  return {receipt,hasResponseBody,responseDisposition:receipt?.responseDisposition??null,legacyProcessState};
}
async function durable(file,value,replace=false){
  const target=replace?`${file}.${randomUUID()}.tmp`:file;
  const handle=await open(target,'wx',0o600);
  try{
    await handle.writeFile(typeof value==='string'?value:JSON.stringify(value));await handle.sync();
  }finally{await handle.close();}
  if(replace){try{await rename(target,file);}finally{await rm(target,{force:true}).catch(()=>{});}}
}
export async function runModel(request,{directory,attemptId,signal,shouldDispatch=()=>true,executable='codex',executableArgs=[],timeoutMs,startupTimeoutMs,idleTimeoutMs}={}){
  const start=Date.now();let sent=false,raw='',usage=usageEmpty(),tempDir=null,model,reasoning,attempt=null,owned=false,state='PREPARED',localProcess=null,stderr='',responseDisposition=null,incompleteResponse=false;
  const execution={phase:'starting',startedAt:new Date(start).toISOString(),lastEventAt:null,lastActivityAt:null,lastProgressAt:null,eventCount:0,lastEventType:null,eventCounts:{},terminalEvent:null,terminalAt:null,timeoutKind:null,limits:resolveRunnerLimits(request,{timeoutMs,startupTimeoutMs,idleTimeoutMs}),workload:runnerWorkload(request)};
  const diagnosticEvents=[];
  const diagnostics=()=>({events:diagnosticEvents,stderr:safeDiagnostic(stderr).slice(-4000)});
  const failureDetail=()=>[...diagnosticEvents].reverse().find(e=>e.type==='turn.failed')?.message||diagnosticEvents.at(-1)?.message||diagnostics().stderr.slice(-2000);
  let receiptQueue=Promise.resolve(),progressTimer=null,progressWritePending=false,progressDirty=false;
  const receipt=async(outcome,errorCode,errorMessage)=>{
    if(!owned)return;
    // Snapshot before queuing: a late heartbeat can never replace FINAL.
    const snapshot=JSON.stringify({state,requestOutcome:outcome,responseDisposition,usage,model,reasoning,durationMs:Date.now()-start,errorCode:errorCode||null,errorMessage:errorMessage?safeDiagnostic(errorMessage).slice(-2300):null,diagnostics:diagnostics(),localProcess,execution});
    receiptQueue=receiptQueue.catch(()=>{}).then(()=>durable(path.join(attempt,'receipt.json'),snapshot,true));
    await receiptQueue;
  };
  const persistProgress=()=>{
    if(state==='FINAL'||!progressDirty||progressWritePending)return;
    progressDirty=false;progressWritePending=true;
    receipt(sent?'UNKNOWN':'NOT_SENT').catch(()=>{}).finally(()=>{progressWritePending=false;});
  };
  try{
    if(!directory||!validName(attemptId))fail('INVALID_ATTEMPT','Invalid attempt directory or id');
    if(!request||typeof request.prompt!=='string'||!request.prompt.trim()||typeof request.instructions!=='string'||!request.instructions.trim()||typeof request.inputHash!=='string'||typeof request.promptHash!=='string')fail('INVALID_REQUEST','Incomplete model request');
    ({model,reasoning}=selected(request.settings?.model,request.settings?.reasoning));
    if(request.promptHash!==digest(request.prompt))fail('PROMPT_HASH_MISMATCH','Prompt differs from saved digest');
    if(signal?.aborted)fail('ABORTED','Request cancelled before dispatch');
    attempt=path.join(path.resolve(directory),'attempts',attemptId);
    await mkdir(path.dirname(attempt),{recursive:true,mode:0o700});
    try{await mkdir(attempt,{mode:0o700});owned=true;}catch(error){
      if(error.code==='EEXIST'){
        const old=await readFile(path.join(attempt,'request.json'),'utf8').then(JSON.parse).catch(()=>null);
        const prior=await readFile(path.join(attempt,'receipt.json'),'utf8').then(JSON.parse).catch(()=>null);
        const code=old?.inputHash!==undefined&&old.inputHash!==request.inputHash?'ATTEMPT_CONFLICT':'ATTEMPT_EXISTS';
        throw Object.assign(new Error('Attempt already exists; inspect saved record before retry'),{code,requestOutcome:prior?.requestOutcome||'UNKNOWN',receipt:prior});
      }
      throw error;
    }
    const requestFile=await open(path.join(attempt,'request.json'),'wx',0o600);
    try{await requestFile.writeFile(JSON.stringify(request));await requestFile.sync();}finally{await requestFile.close();}
    await receipt('NOT_SENT');
    tempDir=await mkdtemp(path.join(tmpdir(),'v4-model-'));
    const cwd=path.join(tempDir,'work');await mkdir(cwd,{mode:0o700});
    const instructionsPath=path.join(tempDir,'instructions.txt');await writeFile(instructionsPath,request.instructions,{flag:'wx',mode:0o600});
    let schemaPath;
    if(request.schema!==undefined&&request.schema!==null){schemaPath=path.join(tempDir,'schema.json');await writeFile(schemaPath,JSON.stringify(request.schema),{flag:'wx',mode:0o600});}
    const outputPath=path.join(attempt,'raw.txt');
    const args=[...executableArgs,...buildRunnerArgs({model,reasoning,cwd,outputPath,instructionsPath,schemaPath})];
    if(signal?.aborted)fail('ABORTED','Request cancelled before dispatch');
    if(!shouldDispatch())fail('PAUSED','Request paused before dispatch');
    state='SUBMITTING';await receipt('UNKNOWN');
    if(signal?.aborted)fail('ABORTED','Request cancelled before dispatch');
    if(!shouldDispatch())fail('PAUSED','Request paused before dispatch');
    let finalText='',processError;
    try{await new Promise((resolve,reject)=>{
      let child,pending='',done=false,timer,terminalTimer,forceTimer,closeTimer,termination,terminalFailure,cleanupStarted=false,completedTurn=false,completedBody=false,cliStartedAt=null,lastProgressMs=null;
      const dispatchedAt=Date.now();execution.startedAt=new Date(dispatchedAt).toISOString();
      const finish=error=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(terminalTimer);clearTimeout(forceTimer);clearTimeout(closeTimer);clearInterval(progressTimer);progressTimer=null;signal?.removeEventListener('abort',abort);
        if(!localProcess?.closeObserved){child?.stdin.destroy();child?.stdout.destroy();child?.stderr.destroy();child?.unref();}
        error?reject(error):resolve();};
      const requestTermination=sig=>{
        if(localProcess?.terminationRequests.some(r=>r.signal===sig))return;
        const requestedAt=new Date().toISOString(),result=killGroup(child,sig);
        if(localProcess)localProcess.terminationRequests.push({signal:sig,requestedAt,result});
        progressDirty=true;
      };
      const beginCleanup=()=>{
        if(done||cleanupStarted)return;cleanupStarted=true;requestTermination('SIGTERM');
        forceTimer=setTimeout(()=>{requestTermination('SIGKILL');closeTimer=setTimeout(()=>finish(termination||terminalFailure),1000);},1000);
      };
      const terminate=error=>{
        if(done||termination)return;termination=error;clearTimeout(timer);clearTimeout(terminalTimer);
        if(['ABORTED','PAUSED'].includes(error.code)&&!completedBody)incompleteResponse=true;
        beginCleanup();
      };
      const abort=()=>terminate(Object.assign(new Error('Request cancelled'),{code:'ABORTED'}));
      const armTimeout=()=>{
        if(done||termination||execution.terminalEvent)return;clearTimeout(timer);
        const {startupMs,idleMs,totalMs}=execution.limits,now=Date.now();
        const phaseDeadline=cliStartedAt===null?dispatchedAt+startupMs:(lastProgressMs??cliStartedAt)+idleMs;
        timer=setTimeout(()=>{
          const now=Date.now(),elapsed=now-dispatchedAt;
          const kind=elapsed>=totalMs?'total':cliStartedAt===null&&elapsed>=startupMs?'startup':cliStartedAt!==null&&now-(lastProgressMs??cliStartedAt)>=idleMs?'idle':null;
          if(!kind){armTimeout();return;}
          execution.timeoutKind=kind;
          const phase={starting:'启动阶段，尚未观察到 CLI 生命周期事件',waiting:'等待阶段，CLI 已开始等待但未证明远端受理或正在生成',generating:'生成活动阶段，已观察到内容进展',receiving:'接收正文阶段'}[execution.phase]||'执行阶段';
          const seconds=Math.max(1,Math.ceil(elapsed/1000)),wait=`${Math.floor(seconds/60)}分${seconds%60}秒`;
          const detail=failureDetail(),reason={startup:'启动时限',idle:'无有效进展时限',total:'总时限'}[kind];
          terminate(Object.assign(new Error(`模型请求超时：${phase}；已等待${wait}，达到${reason}${detail?`。最近 CLI 诊断（不代表全程网络状态）：${detail}`:''}`),{code:'TIMEOUT'}));
        },Math.max(1,Math.min(dispatchedAt+totalMs,phaseDeadline)-now));
      };
      armTimeout();
      try{child=spawn(executable,args,{cwd,stdio:['pipe','pipe','pipe'],detached:true});}catch(error){finish(error);return;}
      child.on('spawn',()=>{
        localProcess={pid:child.pid,host:hostname(),startedAt:new Date().toISOString(),exitedAt:null,exitCode:null,exitSignal:null,closeObserved:false,terminationRequests:[]};
        if(signal?.aborted)abort();else if(!shouldDispatch())terminate(Object.assign(new Error('Request paused before dispatch'),{code:'PAUSED'}));else{sent=true;child.stdin.end(request.prompt);}
        progressDirty=true;persistProgress();progressTimer=setInterval(persistProgress,1000);
      });
      child.stdin.on('error',()=>{});
      child.stderr.setEncoding('utf8');child.stderr.on('data',part=>{if(done)return;stderr=(stderr+part).slice(0,64000);execution.lastActivityAt=new Date().toISOString();progressDirty=true;});
      let priorUsage=null,conflictingUsage=false;
      const progressItems=new Map();
      const eventLine=line=>{let e;try{e=JSON.parse(line);}catch{return;}
        if(done||!e||typeof e.type!=='string')return;
        const now=Date.now(),stamp=new Date(now).toISOString(),type=eventTypes.has(e.type)?e.type:'other';
        execution.lastEventAt=stamp;execution.lastEventType=type;execution.eventCount=Math.min(Number.MAX_SAFE_INTEGER,execution.eventCount+1);execution.eventCounts[type]=Math.min(Number.MAX_SAFE_INTEGER,(execution.eventCounts[type]||0)+1);progressDirty=true;
        const lifecycle=e.type==='thread.started'||e.type==='turn.started'||e.type==='turn.completed'||(['item.started','item.updated','item.completed'].includes(e.type)&&['reasoning','agent_message'].includes(e.item?.type));
        if(lifecycle&&cliStartedAt===null){cliStartedAt=now;execution.phase='waiting';armTimeout();}
        if(['item.started','item.updated','item.completed'].includes(e.type)&&['reasoning','agent_message'].includes(e.item?.type)&&typeof e.item.text==='string'&&e.item.text.trim()){
          const key=typeof e.item.id==='string'?e.item.id:e.item.type,hash=digest(e.item.text),prior=progressItems.get(key);
          if(prior!==hash){
            progressItems.set(key,hash);if(progressItems.size>64)progressItems.delete(progressItems.keys().next().value);
            lastProgressMs=now;execution.lastProgressAt=stamp;execution.phase=e.item.type==='agent_message'?'receiving':'generating';armTimeout();
          }
        }
        if(e.type==='error'||e.type==='turn.failed'){
          const message=typeof e.error==='string'?e.error:typeof e.error?.message==='string'?e.error.message:e.message;
          if(typeof message==='string'&&message.trim()){
            diagnosticEvents.push({type:e.type,message:safeDiagnostic(message).slice(-2000)});
            if(diagnosticEvents.length>8)diagnosticEvents.shift();
          }
        }
        if(e.type==='turn.completed'){
          const next=usageOf(e),serialized=JSON.stringify(next);
          if(priorUsage!==null&&priorUsage!==serialized)conflictingUsage=true;
          priorUsage=serialized;usage=conflictingUsage?usageEmpty():next;
          if(!termination&&!terminalFailure){completedTurn=true;try{parseView(finalText);completedBody=true;}catch{}}
        }
        if(e.type==='turn.failed'){
          terminalFailure=Object.assign(new Error(`CLI turn failed${failureDetail()?`: ${failureDetail()}`:''}`),{code:'CLI_FAILED'});
          if(!completedBody)incompleteResponse=true;
        }
        if(e.type==='turn.completed'||e.type==='turn.failed'){
          execution.terminalEvent=e.type;execution.terminalAt=stamp;clearTimeout(timer);
          // A model terminal event ends generation waiting. Give normal CLI shutdown a
          // short grace period, then reclaim the local process independently of usage.
          if(!terminalTimer&&!cleanupStarted)terminalTimer=setTimeout(beginCleanup,100);
          persistProgress();
        }
        if(e.type==='item.completed'&&e.item?.type==='agent_message'&&typeof e.item.text==='string')finalText=e.item.text;
      };
      child.stdout.setEncoding('utf8');child.stdout.on('data',part=>{if(done)return;execution.lastActivityAt=new Date().toISOString();progressDirty=true;pending+=part;let i;while((i=pending.indexOf('\n'))>=0){eventLine(pending.slice(0,i));pending=pending.slice(i+1);}if(pending.length>4_000_000)pending='';});
      child.on('error',finish);
      child.on('close',(code,exitSignal)=>{
        if(done)return;
        if(localProcess){localProcess.exitedAt=new Date().toISOString();localProcess.exitCode=code;localProcess.exitSignal=exitSignal||null;localProcess.closeObserved=true;}
        if(pending)eventLine(pending);if(cleanupStarted)requestTermination('SIGKILL');
        const detail=failureDetail();finish(termination||terminalFailure||(code===0&&!exitSignal||completedTurn&&cleanupStarted?null:Object.assign(new Error(`CLI exited ${code}${exitSignal?` (${exitSignal})`:''}${detail?`: ${detail}`:''}`),{code:'CLI_FAILED'})));
      });
      signal?.addEventListener('abort',abort,{once:true});
    });}catch(error){processError=error;}
    const persisted=await readFile(outputPath,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    raw=persisted?.trim()?persisted:finalText||persisted||'';
    if(finalText)await durable(path.join(attempt,'event-final.txt'),finalText);
    if(raw){
      if(persisted===null)await durable(outputPath,raw);
      else {const handle=await open(outputPath,'r+');try{await handle.sync();}finally{await handle.close();}}
    }
    // "final" is eligible for the existing parser/validation path, not proof of
    // valid JSON. Only explicit failure/cancellation disqualifies the saved body.
    responseDisposition=raw.trim()?(incompleteResponse?'incomplete':'final'):'none';
    if(processError)throw processError;
    if(!raw.trim())fail('EMPTY_RESPONSE','CLI returned no final body');
    let output;try{({output,raw}=parseResponseBodies(raw,finalText));}catch{fail('INVALID_JSON','CLI returned non-JSON body; raw preserved');}
    state='FINAL';execution.phase='completed';await receipt('RESPONDED');
    return {output,raw,usage,requestOutcome:'RESPONDED',responseDisposition,durationMs:Date.now()-start,model,reasoning};
  }catch(error){
    const outcome=error.code==='ATTEMPT_EXISTS'||error.code==='ATTEMPT_CONFLICT'?error.requestOutcome:raw?.trim()&&!incompleteResponse?'RESPONDED':sent?'UNKNOWN':'NOT_SENT';
    if(owned){state='FINAL';execution.phase='failed';try{await receipt(outcome,error.code,error.message);}catch(saveError){error.receiptError=saveError;}}
    throw Object.assign(error,{raw:raw||null,usage,requestOutcome:outcome,responseDisposition,durationMs:Date.now()-start,model,reasoning});
  }
  finally{clearInterval(progressTimer);if(tempDir)await rm(tempDir,{recursive:true,force:true}).catch(()=>{});}
}
