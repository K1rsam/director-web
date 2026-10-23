import path from 'node:path';
import {readdir,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRuntimeMaintenance,RUNTIME_MAINTENANCE_VERSION,runtimeMaintenanceState} from './production-maintenance-control.mjs';
export {createRuntimeMaintenance} from './production-maintenance-control.mjs';

const state=globalThis[Symbol.for('director.runtime-maintenance-bridge')]??={callbacks:new Set(),task:null,closing:false,installed:false,config:null};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
export function trackRuntimeSettlement(action){
 if(state.closing)return Promise.resolve();
 const task=Promise.resolve().then(action);state.callbacks.add(task);task.finally(()=>state.callbacks.delete(task)).catch(()=>{});return task;
}
export async function runtimeCodeIdentity(repoRoot){
 const entries=[];
 async function walk(directory){for(const item of await readdir(path.join(repoRoot,directory),{withFileTypes:true})){
  const file=path.join(directory,item.name);if(item.isSymbolicLink())fail('RUNTIME_MAINTENANCE_CODE','源码身份范围内不接受符号链接');
  if(item.isDirectory()){if(!['fixtures','__tests__'].includes(item.name))await walk(file);}
  else if(item.isFile()&&!/\.test\.mjs$|test-fixtures\.mjs$/.test(item.name))entries.push(file);
 }}
 await walk('runtime');
 entries.push('lib/storyboard-service.ts','lib/production-workflow.ts','app/api/episodes/[episodeId]/storyboard/route.ts','app/api/projects/[projectId]/production-workflow/route.ts','scripts/safe-switch-3008.mjs','lib/season-scope-service.ts','lib/season-handoff-service.ts','lib/foundation-state.ts','lib/foundation-delivery.ts','lib/project-foundation.ts','lib/production-episodes.ts','lib/light-foundation-supply.ts','lib/asset-prompt-service.ts','lib/asset-image-job-service.ts','lib/asset-visual-facts-service.ts','lib/asset-design-adoption.ts','lib/asset-prompt-automation.ts','app/projects/[projectId]/season-scope/route.ts','app/projects/[projectId]/season-scope/handoff/route.ts');
 const hashes=[];for(const file of entries.sort())hashes.push([file,createHash('sha256').update(await readFile(path.join(repoRoot,file))).digest('hex')]);
 return {identity:createHash('sha256').update(JSON.stringify(hashes)).digest('hex'),files:hashes};
}
export async function performMaintenanceDrain({maintenance,service,dataRoot,workflowDirectory}){
 const c=await maintenance.current();if(c.targetPid!==process.pid)fail('RUNTIME_MAINTENANCE_OWNER','维护意图不是本进程');
 await maintenance.holdRuns();
 // A maintenance pause is durable, unlike a transient zero in-flight count.
 const prefix=path.resolve(workflowDirectory)+':';
 const pumps=globalThis[Symbol.for('director.production.parallel-pumps')];
 if(pumps)await Promise.all([...pumps].filter(([k])=>k.startsWith(prefix)).map(([,p])=>p));
 const workers=globalThis[Symbol.for('director.production.parallel-workers')];
 if(workers)await Promise.all([...workers].filter(([k])=>k.startsWith(prefix)).map(([,w])=>w.finished));
 await maintenance.holdRuns();
 const all=await service.list();await Promise.all(all.filter(r=>!r.web?.legacyReadOnly&&service.active(r.id)).map(r=>service.wait(r.id)));
 state.closing=true;await Promise.allSettled([...state.callbacks]);
 if(service.drain)await service.drain();
 const s=await maintenance.status();if(!s.safeToRetire)fail('RUNTIME_MAINTENANCE_BUSY','在途、保留项、owner、动作或用户暂停仍阻断安全退出');
 for(const r of await service.list())if(!r.web?.legacyReadOnly&&(service.active(r.id)||service.scheduling(r.id).inFlight||service.scheduling(r.id).queued))fail('RUNTIME_MAINTENANCE_BUSY','尚有原内核执行槽位');
 if(service.retire)await service.retire();
 else{
  // One-time bridge for the pre-maintenance kernel: zero active is checked in
  // the same JS turn before shutdown closes admission, so cancel has no target.
  // Its existing shutdown also waits all registered public writes before lease release.
  if((await service.list()).some(r=>!r.web?.legacyReadOnly&&service.active(r.id)))fail('RUNTIME_MAINTENANCE_BUSY','旧内核仍有在途');
  await service.shutdown();
 }
 return maintenance.retired({pid:process.pid});
}

/** A signal is only a wakeup. The filesystem intent, PID, auth and kernel proofs grant the scope. */
export function installRuntimeMaintenanceBridge(config){
 state.config=config;if(state.installed||process.platform==='win32')return;
 state.installed=true;
 process.on('SIGUSR2',()=>{
  if(state.task)return;
  const options=state.config,c=runtimeMaintenanceState(options.dataRoot);if(!c)return;
  const maintenance=createRuntimeMaintenance(options);
  const task=(async()=>{
   if(c.phase==='DRAINING'&&c.targetPid===process.pid){
    const service=options.getService();if(!service)fail('RUNTIME_MAINTENANCE_OWNER','本进程没有原coordinator，不能伪报已退出');
    await performMaintenanceDrain({...options,maintenance,service});
   }else if(c.phase==='RETIRED'&&c.loadingPid===process.pid){
    const service=options.getService()??options.initializeService();
    const kernel=service.runtimeIdentity?.();if(!kernel)fail('RUNTIME_MAINTENANCE_KERNEL','旧缓存没有原生内核加载证明');
    const code=await runtimeCodeIdentity(process.cwd());await maintenance.loaded({pid:process.pid,codeIdentity:code.identity,kernel});
   }else if(['LOADED','RESUMING','RELEASING_ISSUES'].includes(c.phase)&&c.loadedPid===process.pid&&c.resumeProofNonce){
    const proof=await options.verify(c);await maintenance.recordResumeProof({pid:process.pid,nonce:c.resumeProofNonce,proof});
   }else if(c.phase==='RESUMED'&&c.loadedPid===process.pid){state.closing=false;await options.resume(c);}
   else if(c.phase==='ISSUE_STOPPED'&&c.loadedPid===process.pid){state.closing=false;}
  })();
  state.task=task;
  task.catch(error=>maintenance.recordFailure(error).catch(()=>{})).finally(()=>{if(state.task===task)state.task=null;});
 });
}
export const runtimeMaintenanceBridgeVersion=()=>state.installed?RUNTIME_MAINTENANCE_VERSION:null;
