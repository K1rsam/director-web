import childProcess,{spawn} from 'node:child_process';
import {mkdir,mkdtemp,open,readFile,realpath,rm,rename,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir,hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {digest,fail} from './shared.mjs';

const disabled=['apps','browser_use','computer_use','image_generation','in_app_browser','workspace_dependencies','multi_agent','plugins','memories','hooks','shell_tool','unified_exec','view_image','skill_search'];
const usageEmpty=()=>({inputTokens:null,cachedInputTokens:null,outputTokens:null,totalTokens:null});
const validName=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
const efforts={
  'gpt-6-sol':new Set(['low','medium','high','xhigh','max','ultra']),
  'gpt-6-astra':new Set(['low','medium','high','xhigh','max','ultra'])
};
const integer=n=>Number.isSafeInteger(n)&&n>=0;
function selected(model='gpt-6-sol',reasoning='medium'){
  if(!efforts[model]?.has(reasoning))fail('INVALID_MODEL_SETTINGS','Unsupported model or reasoning effort');
  return {model,reasoning};
}
export function buildRunnerArgs({model='gpt-6-sol',reasoning='medium',cwd,outputPath,instructionsPath,schemaPath}={}){
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
function killGroup(child,sig){if(!child?.pid)return;try{process.kill(-child.pid,sig);}catch(error){if(error.code!=='ESRCH')child.kill(sig);}}
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
  if(receipt?.state!=='FINAL'||receipt.requestOutcome!=='RESPONDED')fail('ATTEMPT_UNRESOLVED','Attempt has no completed response receipt');
  const saved=await readFile(path.join(attempt,'raw.txt'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  const event=saved.trim()?'':await readFile(path.join(attempt,'event-final.txt'),'utf8').catch(error=>{if(error.code==='ENOENT')return '';throw error;});
  const raw=saved.trim()?saved:event;
  if(!raw.trim())fail('ATTEMPT_UNRESOLVED','Completed receipt has no saved response body');
  const request=await readFile(path.join(attempt,'request.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
  const requestFingerprint=request?digest([request.promptHash,request.instructionHash,request.inputHash]):null;
  let output;try{output=parseView(raw);}catch{
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
  return {receipt,hasResponseBody,legacyProcessState};
}
async function durable(file,value,replace=false){
  const target=replace?`${file}.${randomUUID()}.tmp`:file;
  const handle=await open(target,'wx',0o600);
  try{
    await handle.writeFile(typeof value==='string'?value:JSON.stringify(value));await handle.sync();
  }finally{await handle.close();}
  if(replace){try{await rename(target,file);}finally{await rm(target,{force:true}).catch(()=>{});}}
}
export async function runModel(request,{directory,attemptId,signal,shouldDispatch=()=>true,executable='codex',executableArgs=[],timeoutMs=600000}={}){
  const start=Date.now();let sent=false,raw='',usage=usageEmpty(),tempDir=null,model,reasoning,attempt=null,owned=false,state='PREPARED',localProcess=null;
  const receipt=async(outcome,errorCode)=>{
    if(!owned)return;
    await durable(path.join(attempt,'receipt.json'),{state,requestOutcome:outcome,usage,model,reasoning,durationMs:Date.now()-start,errorCode:errorCode||null,localProcess},true);
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
      let child,pending='',done=false,forceTimer,termination;
      const finish=error=>{if(done)return;done=true;clearTimeout(timer);clearTimeout(forceTimer);signal?.removeEventListener('abort',abort);error?reject(error):resolve();};
      const terminate=error=>{if(done||termination)return;termination=error;killGroup(child,'SIGTERM');forceTimer=setTimeout(()=>{killGroup(child,'SIGKILL');finish(error);},1000);};
      const abort=()=>terminate(Object.assign(new Error('Request cancelled'),{code:'ABORTED'}));
      const timer=setTimeout(()=>terminate(Object.assign(new Error('Request timed out'),{code:'TIMEOUT'})),Math.min(Math.max(timeoutMs,1),600000));
      try{child=spawn(executable,args,{cwd,stdio:['pipe','pipe','pipe'],detached:true});}catch(error){finish(error);return;}
      child.on('spawn',()=>{localProcess={pid:child.pid,host:hostname(),startedAt:new Date().toISOString(),exitedAt:null};if(signal?.aborted)abort();else if(!shouldDispatch())terminate(Object.assign(new Error('Request paused before dispatch'),{code:'PAUSED'}));else{sent=true;child.stdin.end(request.prompt);}});
      child.stdin.on('error',()=>{});child.stderr.on('data',()=>{});
      let priorUsage=null,conflictingUsage=false;
      const eventLine=line=>{let e;try{e=JSON.parse(line);}catch{return;}
        if(e.type==='turn.completed'){
          const next=usageOf(e),serialized=JSON.stringify(next);
          if(priorUsage!==null&&priorUsage!==serialized)conflictingUsage=true;
          priorUsage=serialized;usage=conflictingUsage?usageEmpty():next;
        }
        if(e.type==='item.completed'&&e.item?.type==='agent_message'&&typeof e.item.text==='string')finalText=e.item.text;
      };
      child.stdout.setEncoding('utf8');child.stdout.on('data',part=>{pending+=part;let i;while((i=pending.indexOf('\n'))>=0){eventLine(pending.slice(0,i));pending=pending.slice(i+1);}if(pending.length>4_000_000)pending='';});
      child.on('error',finish);
      child.on('close',code=>{if(localProcess){localProcess.exitedAt=new Date().toISOString();localProcess.exitCode=code;}if(pending)eventLine(pending);if(done)return;if(termination)killGroup(child,'SIGKILL');finish(termination|| (code===0?null:Object.assign(new Error(`CLI exited ${code}`),{code:'CLI_FAILED'})));});
      signal?.addEventListener('abort',abort,{once:true});
    });}catch(error){processError=error;}
    const persisted=await readFile(outputPath,'utf8').catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    raw=persisted?.trim()?persisted:finalText||persisted||'';
    if(finalText)await durable(path.join(attempt,'event-final.txt'),finalText);
    if(raw){
      if(persisted===null)await durable(outputPath,raw);
      else {const handle=await open(outputPath,'r+');try{await handle.sync();}finally{await handle.close();}}
    }
    if(processError)throw processError;
    if(!raw.trim())fail('EMPTY_RESPONSE','CLI returned no final body');
    let output;try{output=parseView(raw);}catch{fail('INVALID_JSON','CLI returned non-JSON body; raw preserved');}
    state='FINAL';await receipt('RESPONDED');
    return {output,raw,usage,requestOutcome:'RESPONDED',durationMs:Date.now()-start,model,reasoning};
  }catch(error){
    const outcome=error.code==='ATTEMPT_EXISTS'||error.code==='ATTEMPT_CONFLICT'?error.requestOutcome:raw?.trim()?'RESPONDED':sent?'UNKNOWN':'NOT_SENT';
    if(owned){state='FINAL';try{await receipt(outcome,error.code);}catch(saveError){error.receiptError=saveError;}}
    throw Object.assign(error,{raw:raw||null,usage,requestOutcome:outcome,durationMs:Date.now()-start,model,reasoning});
  }
  finally{if(tempDir)await rm(tempDir,{recursive:true,force:true}).catch(()=>{});}
}
