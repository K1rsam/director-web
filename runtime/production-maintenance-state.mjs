import {readFileSync} from 'node:fs';
import path from 'node:path';

// This synchronous admission module has no engine/controller imports. Native
// require() must never race the host's asynchronous ESM graph initialization.
export const RUNTIME_MAINTENANCE_VERSION='runtime-maintenance-v1';
const loader=globalThis[Symbol.for('director.runtime-maintenance-host-loader')]??={promise:null};
export function loadRuntimeMaintenanceHost(){return loader.promise??=import('./production-maintenance-host.mjs');}
export function runtimeMaintenanceState(dataRoot){
 try{return JSON.parse(readFileSync(path.join(path.resolve(dataRoot),'runtime-maintenance','documents','current.json'),'utf8'));}
 catch(e){if(e.code==='ENOENT')return null;throw e;}
}
export function assertRuntimeAdmission(dataRoot){
 const c=runtimeMaintenanceState(dataRoot);
 if(c&&(c.version!==RUNTIME_MAINTENANCE_VERSION||!['RESUMED','ABORTED','ISSUE_STOPPED'].includes(c.phase)))throw Object.assign(new Error('本机内核正在安全切换；已有回包保留，未准入新请求。'),{code:'RUNTIME_MAINTENANCE',requestOutcome:'NOT_SENT'});
}
export function runtimeMaintenanceBridgeVersion(){return globalThis[Symbol.for('director.runtime-maintenance-bridge')]?.installed?RUNTIME_MAINTENANCE_VERSION:null;}
