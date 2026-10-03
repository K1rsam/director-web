/** Persistent local executor. Opens only owned task tabs; never retries a submitted generation. */
import {mkdir,readFile,writeFile,rename,unlink,lstat} from 'node:fs/promises';
import path from 'node:path';
import {BridgeClient,BridgeError,generatedTurnImages,imageBrowserDirectory,readImageBrowserConfig,boundImagePrompt,imagePromptDigest,verifyNativeImageResult,nativeImageFileId,type NativeImageProof} from '../lib/image-browser-client';
import {listEnabledImageProjects} from '../lib/image-browser-service';
import {claimImageJob,failImageJob,importImageJobPaths,listExecutorImageJobs,listImageJobs,readImageHandoff} from '../lib/asset-image-job-service';
import {prisma} from '../lib/prisma';
import {randomUUID} from 'node:crypto';

type Journal={id:string;projectId:string;actorId:string;revision:number;token:string;phase:'PREPARING'|'OPENING'|'SUBMITTING'|'WAITING'|'DOWNLOADING'|'IMPORTING';startedAt:string;sourceClientId?:string;promptSha256?:string;emptyPreflight?:unknown;recordProof?:NativeImageProof;files?:{path:string;sha256:string;size:number}[];url?:string};
const directory=imageBrowserDirectory(),journalPath=path.join(directory,'active.json'),lockPath=path.join(directory,'worker.lock');
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
async function atomic(filename:string,value:unknown){const temp=filename+`.${randomUUID()}.tmp`;await writeFile(temp,JSON.stringify(value),{mode:0o600});await rename(temp,filename);}
async function loadJournal():Promise<Journal|null>{try{const info=await lstat(journalPath);if(!info.isFile()||info.isSymbolicLink())throw Error('unsafe journal');const item=JSON.parse(await readFile(journalPath,'utf8')) as Journal;if(!/^[a-f0-9-]{36}$/.test(item.id)||!item.token||!item.actorId||!item.projectId||!Number.isSafeInteger(item.revision)||!['PREPARING','OPENING','SUBMITTING','WAITING','DOWNLOADING','IMPORTING'].includes(item.phase)||!Number.isFinite(Date.parse(item.startedAt)))throw Error('invalid journal');return item;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
async function lock(){await mkdir(directory,{recursive:true});try{await writeFile(lockPath,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const previous=JSON.parse(await readFile(lockPath,'utf8')) as {pid:number};if(!Number.isSafeInteger(previous.pid)||alive(previous.pid))throw Error('Executor already running or lock needs review');await unlink(lockPath);await writeFile(lockPath,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});}}
export function bridgeBusy(health:{activeRequests?:unknown;pendingRequests?:number}){const value=health.activeRequests;return (Array.isArray(value)?value.length>0:typeof value==='number'?value>0:Boolean(value))||Number(health.pendingRequests??0)>0;}
let latestJournal:Journal|null=null,latestError:string|undefined;
async function heartbeat(journal:Journal|null,error?:string){latestJournal=journal;latestError=error;await atomic(path.join(directory,'heartbeat.json'),{pid:process.pid,updatedAt:new Date().toISOString(),currentProjectId:journal?.projectId,currentJobId:journal?.id,error});}
async function clear(){await unlink(journalPath).catch(error=>{if(error.code!=='ENOENT')throw error;});}
async function archive(journal:Journal,outcome:string){await mkdir(path.join(directory,'receipts'),{recursive:true});const {token:_,...receipt}=journal;await atomic(path.join(directory,'receipts',`${journal.id}.json`),{...receipt,outcome,finishedAt:new Date().toISOString()});await clear();}
async function reject(journal:Journal,message:string){await failImageJob(journal.projectId,journal.actorId,journal.id,journal.revision,journal.token,message);await archive(journal,'FAILED');}
async function progress(client:BridgeClient,journal:Journal){
  const current=(await listImageJobs(journal.projectId,journal.actorId)).jobs.find(job=>job.id===journal.id);
  if(!current)throw new BridgeError('INVALID','本地任务已移除，需要人工核对网页。');
  if(current.status==='REVIEW'){
    if(journal.phase!=='IMPORTING'||!journal.files||current.images.length!==journal.files.length||current.images.some((image,i)=>image.sha256!==journal.files![i].sha256))throw new BridgeError('INVALID','导入状态存在冲突，需要人工核对。');
    await archive(journal,'REVIEW');return;
  }
  if(['CANCELLED','FAILED'].includes(current.status)){await archive(journal,current.status);return;}
  if(current.status!=='RUNNING'||current.revision!==journal.revision)throw new BridgeError('INVALID','本地任务版本存在冲突，需要人工核对。');
  if(Date.now()-Date.parse(journal.startedAt)>20*60*1000){await reject(journal,'网页原图未在20分钟内确认，任务已停止接收。请核对原会话，不会自动重发。');return;}
  if(journal.phase==='OPENING'){
    journal.sourceClientId=await client.taskBrowser(journal.id,false);journal.phase='PREPARING';await atomic(journalPath,journal);return;
  }
  if(journal.phase==='PREPARING'){
    if(!journal.sourceClientId){
      journal.phase='OPENING';await atomic(journalPath,journal);
      // Select only the new owned task tab, without focusing the Chrome window.
      // Inactive tabs throttle upload/composer timers; users need not click it.
      journal.sourceClientId=await client.taskBrowser(journal.id,true,process.env.IMAGE_BROWSER_FOREGROUND!=='0');journal.phase='PREPARING';await atomic(journalPath,journal);return;
    }
    if(await client.taskBrowser(journal.id,false)!==journal.sourceClientId)throw new BridgeError('INVALID','任务标签页身份已变化。');
    journal.emptyPreflight=await client.emptyImagePreflight(journal.sourceClientId);
    const handoff=await readImageHandoff(journal.projectId,journal.actorId,journal.id);
    const files=[];for(const reference of handoff.references)files.push(await client.uploadReference(reference));
    // Recheck source/status after uploads, then persist the no-resend boundary before the only POST.
    const checked=await readImageHandoff(journal.projectId,journal.actorId,journal.id);
    if(checked.status!=='RUNNING'||checked.revision!==journal.revision||checked.stale)throw new BridgeError('INVALID','发送前来源发生变化。');
    const message=boundImagePrompt(checked.prompt,journal.id);journal.promptSha256=imagePromptDigest(message);
    journal.phase='SUBMITTING';await atomic(journalPath,journal);
    try{await client.submitTurn(journal.id,message,files,journal.projectId,journal.sourceClientId);}catch(error){
      // Even an uncertain POST response means GET only on all future ticks and restarts.
      if(!(error instanceof BridgeError))throw new BridgeError('OFFLINE','提交回执暂未确认。');throw error;
    }
    journal.phase='WAITING';await atomic(journalPath,journal);return;
  }
  if(journal.phase==='IMPORTING'){
    if(!journal.files||!journal.url)throw new BridgeError('INVALID','原图导入凭据不完整。');
    const imported=await importImageJobPaths(journal.projectId,journal.actorId,journal.id,journal.revision,journal.files.map(file=>file.path),journal.token,journal.url);
    if(imported.images.some((image,i)=>image.sha256!==journal.files![i].sha256||image.size!==journal.files![i].size))throw new BridgeError('INVALID','原图导入后内容校验不匹配。');
    await archive(journal,'REVIEW');return;
  }
  const turn=await client.turn(journal.id);
  if(['failed','interrupted','cancelled','completed_without_artifact'].includes(turn.status)){await reject(journal,'网页任务结束，但没有确认本任务的完整原图。请核对原会话；不会自动重发。');return;}
  if(turn.status!=='completed'){
    if(journal.emptyPreflight&&journal.promptSha256&&journal.sourceClientId){
      try{const proof=await client.confirmImageRecord(journal.id,journal.sourceClientId,journal.promptSha256,current.expectedCount);if(proof){journal.recordProof=proof;await atomic(journalPath,journal);}}
      catch(error){if(error instanceof BridgeError&&error.code==='INVALID')throw error;/* Read-only record unavailable: continue observing the one submitted turn. */}
    }
    return;
  }
  const selection=generatedTurnImages(turn,journal.id,current.expectedCount,journal.sourceClientId);
  if(journal.recordProof?.status==='matched_complete')verifyNativeImageResult(turn,journal.recordProof,journal.promptSha256||'');
  const handoff=await readImageHandoff(journal.projectId,journal.actorId,journal.id);
  journal.phase='DOWNLOADING';await atomic(journalPath,journal);
  const files=[];for(const image of selection.artifacts){const saved=await client.download(image,handoff.outputDirectory),proof=journal.recordProof?.status==='matched_complete'?journal.recordProof.bindings?.find(b=>b.imageFileId===nativeImageFileId(image.url)):undefined;if(proof&&(saved.sha256!==proof.bytesSha256||proof.size!==undefined&&saved.size!==proof.size||proof.mime!==undefined&&image.mime!==proof.mime))throw new BridgeError('INVALID','下载原图与原生来源字节不一致，未导入。');files.push(saved);}
  if(new Set(files.map(file=>file.sha256)).size!==files.length)throw new BridgeError('INVALID','网页返回了重复原图，未导入。');
  journal.phase='IMPORTING';journal.files=files;journal.url=selection.url;await atomic(journalPath,journal);
}
async function main(){
  await lock();let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
  const pulse=setInterval(()=>{void heartbeat(latestJournal,latestError).catch(()=>{});},5000);
  try{
    while(!stopping){
      let journal:Journal|null=null;
      try{
        journal=await loadJournal();await heartbeat(journal);
        const config=await readImageBrowserConfig();if(!config){await heartbeat(journal,'UNCONFIGURED');continue;}
        const client=new BridgeClient(config);
        if(journal){
          try{await progress(client,journal);}catch(error){
            if(error instanceof BridgeError&&['INVALID','MISSING','HTTP'].includes(error.code))await reject(journal,error.message);
            else throw error;
          }
        }else{
          const jobs=await listExecutorImageJobs();
          if(jobs.some(job=>job.status==='RUNNING')){await heartbeat(null,'UNRESOLVED_RUNNING_JOB');continue;}
          const enabled=await listEnabledImageProjects();
          if(!enabled.length)continue;
          // Global health.ok may be false solely because multiple tabs need selection.
          // Every command below instead binds the uniquely available/selected opener.
          const health=await client.health();if(health.clients<1||bridgeBusy(health)){await heartbeat(null,health.clients>0?'BROWSER_BUSY':'BROWSER_OFFLINE');continue;}
          const availability=await client.browserAvailability();if(!availability.opener){await heartbeat(null,availability.quarantined?'BROWSER_QUARANTINED':'BROWSER_NOT_READY');continue;}
          const next=jobs.find(job=>enabled.some(project=>project.projectId===job.projectId));
          if(!next)continue;
          const actorId=enabled.find(project=>project.projectId===next.projectId)!.actorId;
          const claim=await claimImageJob(next.projectId,actorId,next.id,next.revision);
          journal={id:next.id,projectId:next.projectId,actorId,revision:claim.job.revision,token:claim.claimToken,phase:'PREPARING',startedAt:new Date().toISOString()};
          await atomic(journalPath,journal);await heartbeat(journal);
        }
      }catch(error){await heartbeat(journal,error instanceof BridgeError?error.code:'EXECUTOR_CHECK_REQUIRED');}
      finally{await new Promise(resolve=>setTimeout(resolve,3000));}
    }
  }finally{clearInterval(pulse);await unlink(lockPath).catch(()=>{});await prisma.$disconnect();}
}
main().catch(()=>{console.error('Chrome 执行器未启动，请检查本地服务与运行锁。');process.exitCode=1;});
