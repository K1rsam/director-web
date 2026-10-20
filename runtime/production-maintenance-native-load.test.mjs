import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
const {verifyIdleLeaseAbsence,readCoordinatorLease}=await import('../scripts/safe-switch-3008.mjs');
test('only ENOENT proves lease absence; present falsy JSON and malformed leases never acquire absence evidence',async t=>{
 assert.equal(typeof readCoordinatorLease,'function','缺少严格租约存在性读取');
 const root=await mkdtemp(path.join(tmpdir(),'maintenance-lease-'));t.after(()=>rm(root,{recursive:true,force:true}));const file=path.join(root,'owner.json');
 assert.deepEqual(await readCoordinatorLease(file),{owner:null,leaseAbsent:true});
 for(const owner of [null,false,0,'',{pid:123,token:'test'}]){await writeFile(file,JSON.stringify(owner));assert.deepEqual(await readCoordinatorLease(file),{owner,leaseAbsent:false});}
 await writeFile(file,'invalid');await assert.rejects(readCoordinatorLease(file));
});
test('a missing lease requires the exact previously loaded idle kernel and original workflow authorization',()=>{
 const host={pid:123},state={phase:'RESUMED',safeToRetire:true,control:{phase:'RESUMED',workflowId:'flow',authorization:'auth',loadedPid:123,kernel:{pid:123}}};
 assert.equal(typeof verifyIdleLeaseAbsence,'function','缺少租约为空时的已加载内核核验');
 assert.equal(verifyIdleLeaseAbsence(host,state,'flow','auth').leaseAbsent,true);
 for(const change of [s=>s.phase='LOADED',s=>s.safeToRetire=false,s=>s.control.loadedPid=124,s=>s.control.kernel.pid=124,s=>s.control.workflowId='other',s=>s.control.authorization='other',s=>s.control.userPauseRequestedAt='now']){const s=structuredClone(state);change(s);assert.throws(()=>verifyIdleLeaseAbsence(host,s,'flow','auth'));}
});
test('native admission state remains synchronously loadable while the shared maintenance host is importing',()=>{
 const script=`const p=require('node:path');const f=p.resolve('runtime/production-maintenance-state.mjs');const s=require(f);const a=s.loadRuntimeMaintenanceHost();const b=s.loadRuntimeMaintenanceHost();if(a!==b)throw Error('not one shared import');require(f);require(p.resolve('runtime/storyboard-v4/coordinator.mjs'));a.then(h=>{if(typeof h.installRuntimeMaintenanceBridge!=='function')throw Error('host');process.stdout.write('native-load-ok');});`;
 let output,error;try{output=execFileSync(process.execPath,['-e',script],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']});}catch(e){error=e.stderr?.toString()??e.message;}
 assert.equal(error,undefined,error);assert.equal(output,'native-load-ok');
});
