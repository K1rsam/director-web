import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,lstat} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir,hostname} from 'node:os';
import {createStore} from './core/store.mjs';
import {parseHostBootTime} from './host-boot.mjs';

test('boot proof parser rejects unavailable, malformed and future epochs',()=>{
 assert.equal(parseHostBootTime('{ sec = 100, usec = 123456 } Mon Oct 19 15:21:19 2026\n'),100123.456);
 for(const text of ['',null,'100','{ sec = 100, usec = 1000000 }','{ sec = 0, usec = 0 }',`{ sec = ${Math.ceil(Date.now()/1000)+60}, usec = 0 }`])assert.equal(parseHostBootTime(text),null);
});

test('a reused live PID from a proven previous boot is archived, never signalled or deleted',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'store-previous-boot-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let boot=null;const store=createStore(directory,{hostBootTime:async()=>boot});await store.create('one',{kept:true});
 const file=path.join(directory,'documents','one.lock'),bytes=JSON.stringify({pid:process.pid,token:'old-boot',host:hostname()});
 await writeFile(file,bytes,{flag:'wx'});const s=await lstat(file);boot=Math.max(s.birthtimeMs,s.mtimeMs,s.ctimeMs)+1;
 await new Promise(resolve=>setTimeout(resolve,3));
 const result=await store.recoverStaleLock('one');assert.equal(result.recovered,true);assert.equal(result.reason,'PREVIOUS_BOOT');
 assert.equal(await readFile(result.archived,'utf8'),bytes);assert.deepEqual(await store.read('one'),{kept:true});
 await store.update('one',d=>({...d,continued:true}));assert.equal((await store.read('one')).continued,true);
});

test('missing, future or same-boot evidence and symlinks never authorize live-owner recovery',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'store-boot-negative-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let boot=null;const store=createStore(directory,{hostBootTime:async()=>boot});await store.create('one',{kept:true});
 const file=path.join(directory,'documents','one.lock'),bytes=JSON.stringify({pid:process.pid,token:'live',host:hostname()});
 await writeFile(file,bytes,{flag:'wx'});const s=await lstat(file);
 for(const value of [null,NaN,0,Date.now()+60000,s.birthtimeMs-1,s.mtimeMs,s.ctimeMs]){
  boot=value;await assert.rejects(store.recoverStaleLock('one'),{code:'BUSY'});assert.equal(await readFile(file,'utf8'),bytes);
 }
 const {symlink,unlink}=await import('node:fs/promises');await unlink(file);await writeFile(file+'.evidence',bytes);await symlink(file+'.evidence',file);
 boot=Date.now();await assert.rejects(store.recoverStaleLock('one'),{code:'UNKNOWN_LOCK'});assert.equal(await readFile(file+'.evidence','utf8'),bytes);
});
