import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {hostname} from 'node:os';
import {acquireRuntimeLease} from './storyboard-v4/runtime-lease.mjs';
import {createStore} from './storyboard-v4/core/store.mjs';

const workers=globalThis[Symbol.for('director.production.parallel-workers')]??=new Map();
const lifecycleChanges=globalThis[Symbol.for('director.production.parallel-lifecycle')]??=new Map();
const now=()=>new Date().toISOString();

/** Opt-in local service loop, not a browser poll, automation or separate production engine. */
export function createParallelProductionWorker({directory,makeService,intervalMs=5000}){
 if(typeof directory!=='string'||typeof makeService!=='function'||!Number.isSafeInteger(intervalMs)||intervalMs<10)throw new Error('Invalid parallel worker configuration');
 const key=id=>`${path.resolve(directory)}:${id}`;
 function serialize(id,action){
  const current=(lifecycleChanges.get(key(id))??Promise.resolve()).catch(()=>{}).then(action).finally(()=>{if(lifecycleChanges.get(key(id))===current)lifecycleChanges.delete(key(id));});
  lifecycleChanges.set(key(id),current);return current;
 }
 async function cleanup(id,item){
  return item.cleaning??=Promise.resolve().then(async()=>{await item.lease?.release();if(workers.get(key(id))===item)workers.delete(key(id));item.finish();});
 }
 async function stop(id,status='PAUSED',{drain=true}={}){
  const item=workers.get(key(id));if(!item)return;
  item.closed=true;clearTimeout(item.timer);
  item.stopping??=Promise.resolve().then(async()=>{
   await item.ready.catch(()=>{});await item.pending?.catch(()=>{});
   await item.service?.recordParallelWorker(id,{token:item.token,pid:process.pid,host:hostname(),status,updatedAt:now()},{stop:true,expectedToken:item.token,expectedAuthorization:item.authorization}).catch(()=>{});
   await cleanup(id,item);
  });
  if(drain)await item.stopping;else void item.stopping.catch(()=>{});
 }
 async function start(id,{expectedAuthorization}={}){
  const existing=workers.get(key(id));
  if(existing){if(expectedAuthorization&&existing.authorization&&existing.authorization!==expectedAuthorization)throw Object.assign(new Error('原队列授权已变化'),{code:'WORKFLOW_PARALLEL_OWNER'});if(existing.closed){await existing.finished;return start(id,{expectedAuthorization});}return existing.ready;}
  let finish;const finished=new Promise(resolve=>finish=resolve);
  const item={token:randomUUID(),authorization:null,readRecoveryCount:0,closed:false,timer:null,pending:null,lease:null,service:null,ready:null,finished,finish};workers.set(key(id),item);
  const checkpoint=(status,error)=>({token:item.token,pid:process.pid,host:hostname(),authorization:item.authorization,readRecoveryCount:item.readRecoveryCount,status,updatedAt:now(),...(error?{error:{code:error.code??'WORKFLOW_PARALLEL_FAILED',message:status==='RECONNECTING'?'正在恢复只读连接；保留原任务，不重发已付请求。':status==='WAIT_CONNECTION'?'只读连接暂不可用；已停止重试，等待开盖或联网后重连原队列，不重发已付请求。':'队列执行中断，请核对已保存动作与回执后继续；没有自动重发。'}}:{})});
  async function tick(){
   if(item.closed)return;
   item.pending=(async()=>{
    try{
     item.lease.assertHeld();item.service=await makeService();
     const view=await item.service.pumpParallel(id,{expectedAuthorization:item.authorization}),p=view.parallel;
     if(item.closed)return;
     if(item.readRecoveryCount){item.readRecoveryCount=0;await item.service.recordParallelWorker(id,checkpoint('RUNNING'),{expectedToken:item.token,expectedAuthorization:item.authorization});}
     item.waitingForEvidence=Boolean(p?.waitingForEvidence);
     const running=p?.enabled&&!view.workflow.paused&&(p.status==='RUNNING'||item.waitingForEvidence);
     const workerStatus=item.waitingForEvidence?'WAITING_EVIDENCE':'RUNNING';
     if(running&&p.worker?.status!==workerStatus)await item.service.recordParallelWorker(id,checkpoint(workerStatus),{expectedToken:item.token,expectedAuthorization:item.authorization});
     if(!running){item.closed=true;await item.service.recordParallelWorker(id,checkpoint(p?.status??'INTERRUPTED'),{stop:true,expectedToken:item.token,expectedAuthorization:item.authorization});}
    }catch(error){
     if(error.retryableRead===true&&item.readRecoveryCount<2&&item.service){
      item.readRecoveryCount++;
      try{await item.service.recordParallelWorker(id,checkpoint('RECONNECTING',error),{expectedToken:item.token,expectedAuthorization:item.authorization});}
      catch{item.closed=true;}
     }else{
      item.closed=true;
      const waiting=item.wakeReconnect&&error.retryableRead===true;
      await item.service?.recordParallelWorker(id,checkpoint(waiting?'WAIT_CONNECTION':'INTERRUPTED',error),{stop:!waiting,expectedToken:item.token,expectedAuthorization:item.authorization}).catch(()=>{});
     }
    }
   })();
   await item.pending;
   if(item.closed){if(!item.stopping)await cleanup(id,item);}
   else{item.timer=setTimeout(()=>void tick(),item.waitingForEvidence?Math.max(intervalMs,Math.min(30000,intervalMs*3)):Math.min(30000,intervalMs*(item.readRecoveryCount+1)));item.timer.unref?.();}
  }
  item.ready=(async()=>{
   try{
    let d;
    for(let attempt=0;;attempt++){
     if(item.closed){await cleanup(id,item);return;}
     try{item.service=await makeService();d=await item.service.read(id);break;}
     catch(error){if(error.retryableRead!==true||attempt>=2)throw error;await new Promise(resolve=>setTimeout(resolve,Math.min(30000,intervalMs*(attempt+1))));}
    }
    if(item.closed){await cleanup(id,item);return;}
    if(!d.parallel?.enabled||d.paused){await cleanup(id,item);return;}
    if(typeof d.parallel.authorizedAt!=='string'||!d.parallel.authorizedAt.trim()||typeof d.parallel.authorizedBy!=='string'||!d.parallel.authorizedBy.trim())throw Object.assign(new Error('原队列授权不完整'),{code:'WORKFLOW_PARALLEL_OWNER'});
    if(expectedAuthorization&&d.parallel.authorizedAt!==expectedAuthorization)throw Object.assign(new Error('原队列授权已变化'),{code:'WORKFLOW_PARALLEL_OWNER'});
    item.authorization=d.parallel.authorizedAt;
    item.wakeReconnect=d.parallel.reconnectPolicy==='wake-reconnect-v1';
    if(d.parallel.worker?.authorization===item.authorization&&Number.isSafeInteger(d.parallel.worker?.readRecoveryCount))item.readRecoveryCount=Math.min(2,Math.max(0,d.parallel.worker.readRecoveryCount));
    // Kernel ownership is shared across reloads/processes; a lock filename alone is not ownership.
    item.lease=await acquireRuntimeLease(path.join(directory,'parallel-workers',id));
    const actor=d.parallel.authorizedBy;
    async function mayResume(){
     item.lease.assertHeld();
     const current=await item.service.read(id);
     item.lease.assertHeld();
     if(item.closed||current.paused||!current.parallel?.enabled)return false;
     if(current.parallel.authorizedAt!==item.authorization||current.parallel.authorizedBy!==actor)throw Object.assign(new Error('原队列授权已变化'),{code:'WORKFLOW_PARALLEL_OWNER'});
     return true;
    }
    if(!await mayResume()){await cleanup(id,item);return;}
    // Restart keeps the original authorization and archived owner evidence. A
    // reused PID is not reclaimed without a strictly proven previous boot.
    await createStore(directory).recoverStaleLock(id);
    if(!await mayResume()){await cleanup(id,item);return;}
    await item.service.recordParallelWorker(id,checkpoint('RUNNING'),{expectedAuthorization:item.authorization});
    item.timer=setTimeout(()=>void tick(),0);item.timer.unref?.();
   }catch(error){item.closed=true;await cleanup(id,item);throw error;}
  })();
  return item.ready;
 }
 return {start,stop,serialize};
}
