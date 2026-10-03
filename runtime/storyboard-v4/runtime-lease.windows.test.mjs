import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,stat,unlink,link,mkdir,rmdir} from 'node:fs/promises';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import path from 'node:path';
import {tmpdir,hostname} from 'node:os';
import {acquireRuntimeLease,readRuntimeMachineIdentity} from './runtime-lease.mjs';

const windows=process.platform==='win32';
const leaseURL=new URL('./runtime-lease.mjs',import.meta.url).href;
const coordinatorURL=new URL('./coordinator.mjs',import.meta.url).href;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t){
 const directory=await mkdtemp(path.join(tmpdir(),'v4-native-windows-lease-')),children=new Set(),leases=new Set();
 t.after(async()=>{
  for(const child of children)if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'exit');child.kill('SIGKILL');await closed;}
  for(const lease of leases)await lease.release();
  await rm(directory,{recursive:true,force:true,maxRetries:20,retryDelay:100});
 });
 const script=path.join(directory,'worker.mjs');
 await writeFile(script,`
import cp from 'node:child_process';import {promisify} from 'node:util';import {syncBuiltinESMExports} from 'node:module';import fs from 'node:fs';import path from 'node:path';
const [directory,role]=process.argv.slice(2);let helperPid,lease;
if(role==='watch-helper'){const spawn=cp.spawn;cp.spawn=(...args)=>{const child=spawn(...args);helperPid=child.pid;return child;};syncBuiltinESMExports();}
if(role.startsWith('identity-failure:')){const original=cp.execFile,originalAsync=original[promisify.custom],reason=role.split(':')[1];const replacement=(...args)=>original(...args);replacement[promisify.custom]=async(command,...args)=>{if(path.basename(command).toLowerCase()!=='reg.exe')return originalAsync(command,...args);if(reason==='command')throw Object.assign(Error('unavailable'),{code:'EACCES'});return {stdout:reason==='zero'?'MachineGuid REG_SZ 00000000-0000-0000-0000-000000000000':'unverifiable identity',stderr:''};};cp.execFile=replacement;syncBuiltinESMExports();}
const {acquireRuntimeLease,readRuntimeMachineIdentity}=await import(${JSON.stringify(leaseURL)});
try{
 if(role==='identity'){process.send({event:'identity',identity:await readRuntimeMachineIdentity()});process.disconnect();}
 else if(role.startsWith('identity-failure:')){const {createCoordinator}=await import(${JSON.stringify(coordinatorURL)});let calls=0;const c=createCoordinator({dataRoot:directory,modelRunner:async()=>{calls++;throw Error('model must not run');}});let code;try{await c.prepareWrite();}catch(error){code=error.code;}finally{await c.shutdown();}lease=await acquireRuntimeLease(directory);lease.assertHeld();await lease.release();process.send({event:'identity-failed',code,calls,ownerWritten:fs.existsSync(path.join(directory,'.coordinator-owner.json'))});process.disconnect();}
 else {lease=await acquireRuntimeLease(directory);lease.assertHeld();process.send({event:'held',...(helperPid?{helperPid}:{})});process.on('message',async message=>{if(message==='release'){await lease.release();process.send({event:'released'});process.disconnect();}if(message==='assert'){try{lease.assertHeld();process.send({event:'asserted'});}catch(error){process.send({event:'lost',code:error.code});}}});}
}catch(error){if(lease)await lease.release();process.send({event:'failed',code:error.code});process.disconnect();}
`);
 return {directory,children,leases,script};
}
function worker(context,role='hold',directory=context.directory){
 const child=fork(context.script,[directory,role],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true}),events=[];
 context.children.add(child);child.on('message',message=>events.push(message));
 return {child,events,async waitFor(predicate){for(let i=0;i<800;i++){const found=events.find(predicate);if(found)return found;if(child.exitCode!==null||child.signalCode!==null)throw Error('Worker ended without expected receipt');await delay(10);}throw Error('Worker handshake timeout');}};
}
async function acquireEventually(context){
 for(let attempt=0;attempt<20;attempt++)try{const lease=await acquireRuntimeLease(context.directory);context.leases.add(lease);return lease;}catch(error){if(error.code!=='LEASE_BUSY')throw error;await delay(25);}
 assert.fail('parent death did not release native file handle');
}

test('Windows stable machine identity is namespaced, cached and identical across real processes',{skip:!windows},async t=>{
 const context=await fixture(t),identity=await readRuntimeMachineIdentity();
 assert.match(identity,/^windows-machine-v1:[a-f0-9]{64}$/);assert.equal(await readRuntimeMachineIdentity(),identity);
 for(let i=0;i<2;i++){const child=worker(context,'identity');const result=await child.waitFor(x=>['identity','failed'].includes(x.event));assert.equal(result.event,'identity');assert.equal(result.identity,identity);}
});

test('Windows kernel exclusion is cross-process and explicit release preserves permanent file bytes/inode',{skip:!windows},async t=>{
 const context=await fixture(t),file=path.join(context.directory,'.runtime-lease.lock');
 await writeFile(file,'permanent-lock-content');const before=await stat(file,{bigint:true});
 const holder=worker(context);assert.equal((await holder.waitFor(x=>['held','failed'].includes(x.event))).event,'held');
 for(let i=0;i<2;i++)assert.deepEqual(await worker(context).waitFor(x=>['held','failed'].includes(x.event)),{event:'failed',code:'LEASE_BUSY'});
 await assert.rejects(unlink(file),error=>['EPERM','EACCES','EBUSY'].includes(error.code),'held kernel handle denies unlink');
 holder.child.send('release');await holder.waitFor(x=>x.event==='released');
 const after=await stat(file,{bigint:true});assert.equal(after.ino,before.ino);assert.equal(after.dev,before.dev);assert.equal(await readFile(file,'utf8'),'permanent-lock-content');
 const lease=await acquireEventually(context);lease.assertHeld();await lease.release();await lease.release();assert.throws(()=>lease.assertHeld(),{code:'LEASE_LOST'});
 assert.equal((await stat(file,{bigint:true})).ino,before.ino);
});

test('Windows parent SIGKILL releases its real native holder without deleting the lock',{skip:!windows},async t=>{
 const context=await fixture(t),holder=worker(context);assert.equal((await holder.waitFor(x=>['held','failed'].includes(x.event))).event,'held');
 const file=path.join(context.directory,'.runtime-lease.lock'),before=await stat(file,{bigint:true});
 const exited=once(holder.child,'exit');holder.child.kill('SIGKILL');await exited;
 const lease=await acquireEventually(context);lease.assertHeld();await lease.release();assert.equal((await stat(file,{bigint:true})).ino,before.ino);
});

test('Windows holder death makes assertHeld fail closed and permits another kernel owner',{skip:!windows},async t=>{
 const context=await fixture(t),holder=worker(context,'watch-helper'),ready=await holder.waitFor(x=>['held','failed'].includes(x.event));
 assert.equal(ready.event,'held');assert.ok(Number.isSafeInteger(ready.helperPid));process.kill(ready.helperPid,'SIGKILL');
 await delay(150);holder.child.send('assert');assert.deepEqual(await holder.waitFor(x=>['lost','asserted'].includes(x.event)),{event:'lost',code:'LEASE_LOST'});
 const lease=await acquireEventually(context);lease.assertHeld();await lease.release();
 holder.child.send('release');await holder.waitFor(x=>x.event==='released');
});

test('Windows directory aliases share one lock while independent directories can run concurrently',{skip:!windows},async t=>{
 const context=await fixture(t),lease=await acquireRuntimeLease(context.directory);context.leases.add(lease);
 const alias=path.join(context.directory,'nested','..');await writeFile(path.join(context.directory,'marker'),'ok');
 // realpath resolves the logical alias after mkdir, not a second marker file.
 assert.deepEqual(await worker(context,'hold',alias).waitFor(x=>['held','failed'].includes(x.event)),{event:'failed',code:'LEASE_BUSY'});
 const independent=await acquireRuntimeLease(path.join(context.directory,'separate'));context.leases.add(independent);lease.assertHeld();independent.assertHeld();await independent.release();await lease.release();
});

test('Windows rejects nonregular or multiply-linked lock targets without changing their bytes',{skip:!windows},async t=>{
 const context=await fixture(t),file=path.join(context.directory,'.runtime-lease.lock');
 await mkdir(file);await assert.rejects(acquireRuntimeLease(context.directory),{code:'LEASE_UNAVAILABLE'});assert.equal((await stat(file)).isDirectory(),true);
 await rmdir(file);const target=path.join(context.directory,'another-file');await writeFile(target,'must-preserve');await link(target,file);
 await assert.rejects(acquireRuntimeLease(context.directory),{code:'LEASE_UNAVAILABLE'});assert.equal(await readFile(target,'utf8'),'must-preserve');assert.equal((await stat(file)).nlink,2);
});

test('Windows owner recovery requires exact stable machine identity, never matching hostname alone',{skip:!windows},async t=>{
 const context=await fixture(t),{createCoordinator}=await import('./coordinator.mjs'),machineId=await readRuntimeMachineIdentity();let calls=0;
 const c=createCoordinator({dataRoot:context.directory,modelRunner:async()=>{calls++;throw Error('model must not run');}});t.after(()=>c.shutdown());
 const file=path.join(context.directory,'.coordinator-owner.json');
 for(const owner of [
  {pid:99999999,host:hostname(),token:'legacy'},
  {pid:99999999,host:hostname(),token:'foreign',machineId:'mac-hardware-v1:'+'a'.repeat(64)},
  {pid:99999999,host:hostname(),token:'foreign',machineId:'windows-machine-v1:'+'a'.repeat(64)},
  ...[null,'',false,'unknown','windows-machine-v1:bad'].map(identity=>({pid:99999999,host:hostname(),token:'unknown',machineId:identity})),
  null,[],true,
 ]){
  const original=JSON.stringify(owner);await writeFile(file,original);
  await assert.rejects(c.prepareWrite(),{code:'LEASE_UNKNOWN'});assert.equal(await readFile(file,'utf8'),original);
  assert.equal((await readdir(context.directory)).some(name=>name.startsWith('.coordinator-owner.stale-')),false);
 }
 await writeFile(file,'{corrupt');await assert.rejects(c.prepareWrite(),{code:'LEASE_UNKNOWN'});assert.equal(await readFile(file,'utf8'),'{corrupt');
 // Unknown failures must release the native lock, not leave a helper holding it.
 await unlink(file);const freed=await acquireRuntimeLease(context.directory);context.leases.add(freed);await freed.release();
 const original=JSON.stringify({pid:99999999,host:'changed-network-host',token:'dead-valid-owner',machineId});await writeFile(file,original);
 await c.prepareWrite();const current=JSON.parse(await readFile(file,'utf8'));assert.equal(current.machineId,machineId);assert.equal(current.pid,process.pid);
 const archives=(await readdir(context.directory)).filter(name=>name.startsWith('.coordinator-owner.stale-'));assert.equal(archives.length,1);assert.equal(await readFile(path.join(context.directory,archives[0]),'utf8'),original);
 await c.shutdown();assert.equal(calls,0);assert.equal((await stat(path.join(context.directory,'.runtime-lease.lock'))).isFile(),true);
});

for(const reason of ['command','invalid','zero'])test('Windows unreadable identity '+reason+' fails closed and releases native lease',{skip:!windows},async t=>{
 const context=await fixture(t),child=worker(context,'identity-failure:'+reason);
 assert.deepEqual(await child.waitFor(x=>['identity-failed','failed'].includes(x.event)),{event:'identity-failed',code:'LEASE_UNAVAILABLE',calls:0,ownerWritten:false});
});
