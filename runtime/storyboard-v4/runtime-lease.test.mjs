import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,stat} from 'node:fs/promises';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {tmpdir,hostname} from 'node:os';

const coordinatorURL=new URL('./coordinator.mjs',import.meta.url).href;
const leaseURL=new URL('./runtime-lease.mjs',import.meta.url).href;
async function fixture(t){const directory=await mkdtemp(path.join(tmpdir(),'v4-kernel-lease-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
function worker(t,file,args){
 const child=fork(file,args,{stdio:['ignore','ignore','ignore','ipc']}),events=[];child.on('message',message=>events.push(message));
 t.after(async()=>{if(child.connected)child.send('release');if(child.exitCode===null&&child.signalCode===null){const ended=once(child,'exit');child.kill();await ended;}});
 return {child,events,async waitFor(predicate){for(let i=0;i<500;i++){const found=events.find(predicate);if(found)return found;if(child.exitCode!==null)throw Error('Worker ended before its expected receipt');await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Worker receipt timed out');}};
}

test('a second process cannot steal a newly recovered live coordinator lease at the stale-rename boundary',async t=>{
 const directory=await fixture(t),script=path.join(directory,'coordinator-worker.mjs');
 const {readRuntimeMachineIdentity}=await import('./runtime-lease.mjs');
 await writeFile(path.join(directory,'.coordinator-owner.json'),JSON.stringify({pid:99999999,host:hostname(),token:'dead',machineId:await readRuntimeMachineIdentity()}));
 await writeFile(script,`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const [directory,role]=process.argv.slice(2);let releaseRename,releaseModel,releaseBefore;const renameGate=new Promise(r=>releaseRename=r),modelGate=new Promise(r=>releaseModel=r),beforeGate=new Promise(r=>releaseBefore=r);
process.on('message',message=>{if(message==='release'){releaseRename();releaseBefore();releaseModel();}});
if(role==='paused-reclaimer'){const rename=fs.promises.rename;fs.promises.rename=async(from,to)=>{if(from.endsWith('.coordinator-owner.json')){process.send({event:'rename-ready'});await renameGate;}return rename(from,to);};syncBuiltinESMExports();}
const {createCoordinator}=await import(${JSON.stringify(coordinatorURL)});
const c=createCoordinator({dataRoot:directory,beforeExecute:async()=>{if(role==='contender'){process.send({event:'preflight'});await beforeGate;}return true;},modelRunner:async()=>{process.send({event:'model-started'});await modelGate;throw Object.assign(new Error('fake completed'),{code:'FAKE',requestOutcome:'NOT_SENT'});}});
try{const d=await c.create({source:{key:'episode',sourceRows:[{id:'r1',text:'甲：走。'}]},settings:{fantasyMode:'off',maxUnits:null},binding:{projectId:'p',episodeId:'e',sourceVersion:'1'}});await c.start(d.id,{mode:'next'});await c.wait(d.id);process.send({event:'done'});}catch(error){process.send({event:'failed',code:error.code});}finally{await c.shutdown();process.disconnect();}`);
 const first=worker(t,script,[directory,'paused-reclaimer']);await first.waitFor(x=>x.event==='rename-ready');
 const second=worker(t,script,[directory,'contender']);const contender=await second.waitFor(x=>['failed','preflight'].includes(x.event));
 assert.deepEqual(contender,{event:'failed',code:'LEASE_BUSY'});
 first.child.send('release');await first.waitFor(x=>x.event==='model-started');await first.waitFor(x=>x.event==='done');assert.equal(second.events.some(x=>x.event==='model-started'),false);
 for(const process of [first.child,second.child])if(process.exitCode===null)await once(process,'exit');
});

test('runtime kernel lease excludes a second process, survives lock-file presence, and releases when the parent dies',async t=>{
 const directory=await fixture(t),script=path.join(directory,'holder-worker.mjs');
 await writeFile(script,`const {acquireRuntimeLease}=await import(${JSON.stringify(leaseURL)});try{const lease=await acquireRuntimeLease(process.argv[2]);process.send({event:'held'});process.on('message',async message=>{if(message==='release'){await lease.release();process.disconnect();}});}catch(error){process.send({event:'failed',code:error.code});process.disconnect();}`);
 const holder=worker(t,script,[directory]);assert.deepEqual(await holder.waitFor(x=>['held','failed'].includes(x.event)),{event:'held'});
 const challenger=worker(t,script,[directory]);assert.deepEqual(await challenger.waitFor(x=>['held','failed'].includes(x.event)),{event:'failed',code:'LEASE_BUSY'});
 const exited=once(holder.child,'exit');holder.child.kill('SIGKILL');await exited;
 const {acquireRuntimeLease}=await import('./runtime-lease.mjs');let lease;
 for(let i=0;i<100;i++){try{lease=await acquireRuntimeLease(directory);break;}catch(error){if(error.code!=='LEASE_BUSY')throw error;await new Promise(resolve=>setTimeout(resolve,20));}}
 assert.ok(lease,'kernel lease must become available after parent death');lease.assertHeld();const inode=(await stat(path.join(directory,'.runtime-lease.lock'))).ino;await lease.release();await lease.release();
 assert.equal((await stat(path.join(directory,'.runtime-lease.lock'))).ino,inode);assert.throws(()=>lease.assertHeld(),{code:'LEASE_LOST'});
 const again=await acquireRuntimeLease(directory);again.assertHeld();await again.release();
});

test('multiple coordinators share the process lease until the last shutdown and every write entry is excluded',async t=>{
 const directory=await fixture(t),{createCoordinator}=await import('./coordinator.mjs'),{acquireRuntimeLease}=await import('./runtime-lease.mjs');
 const make=()=>createCoordinator({dataRoot:directory,modelRunner:async()=>{throw Error('no model calls');}}),first=make(),second=make();t.after(async()=>{await first.shutdown();await second.shutdown();});
 const input={source:{key:'episode',sourceRows:[{id:'r1',text:'甲：走。'}]},settings:{fantasyMode:'off',maxUnits:null},binding:{projectId:'p',episodeId:'e',sourceVersion:'1'}};
 await first.create(input);await second.create({...input,binding:{...input.binding,episodeId:'e2'}});await assert.rejects(acquireRuntimeLease(directory),{code:'LEASE_BUSY'});await first.shutdown();await assert.rejects(acquireRuntimeLease(directory),{code:'LEASE_BUSY'});await second.shutdown();
 const external=await acquireRuntimeLease(directory);const third=make();try{await assert.rejects(third.create(input),{code:'LEASE_BUSY'});}finally{await third.shutdown();await external.release();}
 await assert.rejects(readFile(path.join(directory,'.coordinator-owner.json'),'utf8'),{code:'ENOENT'});
});

test('shutdown keeps the lease until an admitted create finishes writing',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'v4-shutdown-write-'));
 const {createCoordinator}=await import('./coordinator.mjs'),{acquireRuntimeLease}=await import('./runtime-lease.mjs');
 const c=createCoordinator({dataRoot:directory});let entered,release,pending,stopping,blocked=false;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r),rename=fs.promises.rename;
 fs.promises.rename=async(from,to)=>{if(!blocked&&String(to).startsWith(path.join(directory,'documents')+path.sep)){blocked=true;entered();await gate;}return rename(from,to);};syncBuiltinESMExports();
 try{
  pending=c.create({source:{key:'x',sourceRows:[{id:'r',text:'△甲站立。'}]},settings:{maxUnits:null,fantasyMode:'off'},binding:{projectId:'p',episodeId:'e',sourceVersion:'1'}});
  await ready;stopping=c.shutdown();
  const result=await Promise.race([stopping.then(()=> 'released'),new Promise(r=>setTimeout(()=>r('held'),300))]);
  assert.equal(result,'held','shutdown cannot release the lease while create is inside its write');
  await assert.rejects(acquireRuntimeLease(directory),{code:'LEASE_BUSY'});
  release();await pending;await stopping;const lock=await acquireRuntimeLease(directory);await lock.release();
 }finally{release();await pending?.catch(()=>{});fs.promises.rename=rename;syncBuiltinESMExports();await stopping?.catch(()=>{});await c.shutdown();await rm(directory,{recursive:true,force:true});}
});

test('asynchronous source preparation retains the lease through shutdown',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'v4-shutdown-preparation-'));
 const {createCoordinator}=await import('./coordinator.mjs'),{acquireRuntimeLease}=await import('./runtime-lease.mjs');
 const c=createCoordinator({dataRoot:directory});let entered,release,pending,stopping;
 const ready=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
 try{
  pending=c.withPreparation(async()=>{entered();await gate;await writeFile(path.join(directory,'prepared.txt'),'complete');});
  await ready;stopping=c.shutdown();await assert.rejects(acquireRuntimeLease(directory),{code:'LEASE_BUSY'});
  release();await pending;await stopping;assert.equal(await readFile(path.join(directory,'prepared.txt'),'utf8'),'complete');
  const lock=await acquireRuntimeLease(directory);await lock.release();
 }finally{release();await pending?.catch(()=>{});await stopping?.catch(()=>{});await c.shutdown();await rm(directory,{recursive:true,force:true});}
});

test('a dead owner on the same machine can be recovered after its network hostname changes',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'v4-kernel-lease-')),{createCoordinator}=await import('./coordinator.mjs');let calls=0;
 const make=()=>createCoordinator({dataRoot:directory,modelRunner:async()=>{calls++;throw Error('unexpected model call');}}),first=make(),second=make();
 // Windows correctly denies deletion of a held permanent lock. Release both
 // coordinators before removing this disposable test directory on every exit.
 t.after(async()=>{try{await first.shutdown();await second.shutdown();}finally{await rm(directory,{recursive:true,force:true});}});
 await first.prepareWrite();
 const file=path.join(directory,'.coordinator-owner.json'),owner=JSON.parse(await readFile(file,'utf8'));
 const inode=(await stat(path.join(directory,'.runtime-lease.lock'))).ino;
 await first.shutdown();
 const previous=JSON.stringify({...owner,pid:99999999,host:'previous-network-address'});await writeFile(file,previous);
 await second.prepareWrite();
 const archived=(await readdir(directory)).filter(name=>name.startsWith('.coordinator-owner.stale-'));
 assert.equal(archived.length,1);assert.equal(await readFile(path.join(directory,archived[0]),'utf8'),previous);
 const current=JSON.parse(await readFile(file,'utf8'));assert.match(current.machineId,process.platform==='win32'?/^windows-machine-v1:[a-f0-9]{64}$/:/^mac-hardware-v1:[a-f0-9]{64}$/);
 assert.equal(current.machineId,owner.machineId);assert.equal(current.pid,process.pid);
 assert.equal((await stat(path.join(directory,'.runtime-lease.lock'))).ino,inode);assert.equal(calls,0);
});

test('matching network names do not authorize a record from another machine',async t=>{
 const directory=await fixture(t),{createCoordinator}=await import('./coordinator.mjs');let calls=0;
 const c=createCoordinator({dataRoot:directory,modelRunner:async()=>{calls++;throw Error('unexpected model call');}});t.after(()=>c.shutdown());
 const previous=JSON.stringify({pid:99999999,host:hostname(),token:'foreign',machineId:(process.platform==='win32'?'windows-machine-v1:':'mac-hardware-v1:')+'0'.repeat(64)});
 await writeFile(path.join(directory,'.coordinator-owner.json'),previous);
 await assert.rejects(c.prepareWrite(),{code:'LEASE_UNKNOWN'});
 assert.equal(await readFile(path.join(directory,'.coordinator-owner.json'),'utf8'),previous);assert.equal(calls,0);
});

for(const machineId of [null,'',false,'mac-hardware-v1:bad'])test(`malformed machine identity ${JSON.stringify(machineId)} remains blocked`,async t=>{
 const directory=await fixture(t),{createCoordinator}=await import('./coordinator.mjs');
 const c=createCoordinator({dataRoot:directory});t.after(()=>c.shutdown());
 const previous=JSON.stringify({pid:99999999,host:hostname(),token:'bad-identity',machineId});
 await writeFile(path.join(directory,'.coordinator-owner.json'),previous);
 await assert.rejects(c.prepareWrite(),{code:'LEASE_UNKNOWN'});
 assert.equal(await readFile(path.join(directory,'.coordinator-owner.json'),'utf8'),previous);
});

test('a live owner remains busy after its network hostname changes',async t=>{
 const directory=await fixture(t),{createCoordinator}=await import('./coordinator.mjs');
 const first=createCoordinator({dataRoot:directory}),second=createCoordinator({dataRoot:directory});t.after(async()=>{await first.shutdown();await second.shutdown();});
 await first.prepareWrite();const file=path.join(directory,'.coordinator-owner.json'),owner=JSON.parse(await readFile(file,'utf8'));await first.shutdown();
 const previous=JSON.stringify({...owner,pid:process.pid,host:'previous-network-address',token:'another-live-owner'});await writeFile(file,previous);
 await assert.rejects(second.prepareWrite(),{code:'LEASE_BUSY'});
 assert.equal(await readFile(file,'utf8'),previous);assert.equal((await readdir(directory)).some(name=>name.startsWith('.coordinator-owner.stale-')),false);
});

test('shutdown releases its own metadata despite a changed network hostname',async t=>{
 const directory=await fixture(t),{createCoordinator}=await import('./coordinator.mjs');
 const c=createCoordinator({dataRoot:directory});t.after(()=>c.shutdown());
 await c.prepareWrite();const file=path.join(directory,'.coordinator-owner.json'),owner=JSON.parse(await readFile(file,'utf8'));
 await writeFile(file,JSON.stringify({...owner,host:'previous-network-address'}));await c.shutdown();
 await assert.rejects(readFile(file,'utf8'),{code:'ENOENT'});
});

test('legacy foreign or corrupt owner records are not silently recovered',async t=>{
 const directory=await fixture(t),{createCoordinator}=await import('./coordinator.mjs');
 const c=createCoordinator({dataRoot:directory});t.after(()=>c.shutdown());
 for(const previous of [JSON.stringify({pid:99999999,host:'unverified-machine',token:'legacy'}),'{truncated','null','[]','true']){
  await writeFile(path.join(directory,'.coordinator-owner.json'),previous);
  await assert.rejects(c.prepareWrite(),{code:'LEASE_UNKNOWN'});
  assert.equal(await readFile(path.join(directory,'.coordinator-owner.json'),'utf8'),previous);
 }
});

for(const unreadable of ['command-failed','invalid-result'])test(`unreadable machine identity ${unreadable} releases the kernel lease without writing`,async t=>{
 const directory=await fixture(t),script=path.join(directory,'unreadable-identity-worker.mjs');
 await writeFile(script,`import cp from 'node:child_process';import fs from 'node:fs';import path from 'node:path';import {promisify} from 'node:util';import {syncBuiltinESMExports} from 'node:module';
const [directory,reason]=process.argv.slice(2),original=cp.execFile,originalAsync=original[promisify.custom];
const replacement=(...args)=>original(...args);replacement[promisify.custom]=async(command,...args)=>{const identityRead=process.platform==='win32'?path.basename(command).toLowerCase()==='reg.exe':command==='/usr/sbin/ioreg';if(!identityRead)return originalAsync(command,...args);if(reason==='command-failed')throw Object.assign(new Error('unavailable'),{code:'ENOENT'});return {stdout:'unverifiable identity',stderr:''};};cp.execFile=replacement;syncBuiltinESMExports();
const {createCoordinator}=await import(${JSON.stringify(coordinatorURL)});const {acquireRuntimeLease}=await import(${JSON.stringify(leaseURL)});let calls=0;
const c=createCoordinator({dataRoot:directory,modelRunner:async()=>{calls++;throw Error('unexpected model');}});let failure;
try{await c.prepareWrite();}catch(error){failure=error.code;}finally{await c.shutdown();}
const lease=await acquireRuntimeLease(directory);lease.assertHeld();await lease.release();process.send({event:'checked',code:failure,ownerWritten:fs.existsSync(path.join(directory,'.coordinator-owner.json')),calls});process.disconnect();`);
 const child=worker(t,script,[directory,unreadable]);
 assert.deepEqual(await child.waitFor(message=>message.event==='checked'),{event:'checked',code:'LEASE_UNAVAILABLE',ownerWritten:false,calls:0});
});
