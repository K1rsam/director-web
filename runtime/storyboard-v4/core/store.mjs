import {mkdir,readFile,open,rename,rm,unlink,lstat} from 'node:fs/promises';
import path from 'node:path';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {fail} from './shared.mjs';
import {readHostBootTime} from '../host-boot.mjs';
import {acquireRuntimeLease} from '../runtime-lease.mjs';

const valid=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
const copy=value=>{
  if(!value||typeof value!=='object'||Array.isArray(value))fail('INVALID_DOCUMENT','Document must be an object');
  return JSON.parse(JSON.stringify(value));
};
const queues=new Map();
function enqueue(key,action){
  const previous=queues.get(key)||Promise.resolve();
  const current=previous.catch(()=>{}).then(action);
  const tail=current.catch(()=>{});queues.set(key,tail);
  tail.finally(()=>{if(queues.get(key)===tail)queues.delete(key);});
  return current;
}

export function createStore(directory,{trackRevision=false,hostBootTime=readHostBootTime}={}){
  const base=path.resolve(directory), files=path.join(base,'documents');
  const filename=id=>{if(!valid(id))fail('INVALID_ID','Invalid document id');return path.join(files,`${id}.json`);};
  const lockfile=id=>path.join(files,`${id}.lock`);
  async function atomic(file,value){
    const temp=path.join(files,`.${randomUUID()}.tmp`);
    const handle=await open(temp,'wx',0o600);
    try{await handle.writeFile(JSON.stringify(value));await handle.sync();}finally{await handle.close();}
    try{await rename(temp,file);}finally{await rm(temp,{force:true}).catch(()=>{});}
  }
  async function exclusive(id,action){
    const key=filename(id),lock=lockfile(id);
    return enqueue(key,async()=>{
    await mkdir(base,{recursive:true,mode:0o700});
    await mkdir(files,{recursive:true,mode:0o700});
    let handle;try{handle=await open(lock,'wx',0o600);}catch(error){if(error.code==='EEXIST')fail('BUSY','Document lock held; inspect before recovery');throw error;}
    const token=randomUUID();
    try{
      await handle.writeFile(JSON.stringify({pid:process.pid,token,host:hostname()}));await handle.sync();await handle.close();handle=null;
      return await action();
    }finally{
      if(handle)await handle.close().catch(()=>{});
      const owner=await readFile(lock,'utf8').then(JSON.parse).catch(()=>null);
      if(owner?.token===token)await unlink(lock).catch(()=>{});
    }
    });
  }
  return {
    async create(id,document){
      const file=filename(id);
      return exclusive(id,async()=>{
        try{await readFile(file);fail('EXISTS','Document exists');}catch(error){if(error.code!=='ENOENT')throw error;}
        const value=copy(document);if(trackRevision)value.documentRevision=1;await atomic(file,value);return value;
      });
    },
    async read(id){return JSON.parse(await readFile(filename(id),'utf8'));},
    // Short coordination only. Callback may touch another record, never re-enter
    // this record or call a model. Its changes to this read copy are not persisted.
    async withLockedRead(id,reader){
      if(typeof reader!=='function')fail('INVALID_READER','Expected reader callback');
      return exclusive(id,async()=>reader(JSON.parse(await readFile(filename(id),'utf8'))));
    },
    async update(id,mutator){
      const file=filename(id);if(typeof mutator!=='function')fail('INVALID_MUTATOR','Expected synchronous mutator');
      return exclusive(id,async()=>{
        const previous=JSON.parse(await readFile(file,'utf8'));
        const next=mutator(copy(previous));
        if(next&&typeof next.then==='function')fail('ASYNC_MUTATOR','Mutator must be synchronous');
        const value=copy(next);if(trackRevision)value.documentRevision=(Number.isSafeInteger(previous.documentRevision)?previous.documentRevision:0)+1;await atomic(file,value);return value;
      });
    },
    async recoverStaleLock(id){
      const lock=lockfile(id);
      return enqueue(filename(id),async()=>{
        try{await lstat(lock);}catch(error){if(error.code==='ENOENT')return {recovered:false,reason:'NO_LOCK'};throw error;}
        const lease=await acquireRuntimeLease(path.join(base,'lock-recovery',id));
        try{
        lease.assertHeld();
        let owner,stat;try{stat=await lstat(lock);if(!stat.isFile()||stat.isSymbolicLink())fail('UNKNOWN_LOCK','Lock must be a regular file');owner=JSON.parse(await readFile(lock,'utf8'));}catch(error){if(error.code==='ENOENT')return {recovered:false,reason:'NO_LOCK'};fail('UNKNOWN_LOCK','Lock owner cannot be verified');}
        lease.assertHeld();
        if(!owner||!Number.isSafeInteger(owner.pid)||owner.pid<=0||typeof owner.token!=='string'||!owner.token||owner.host!==hostname())fail('UNKNOWN_LOCK','Lock owner cannot be verified on this host');
        let alive=true;try{process.kill(owner.pid,0);}catch(error){if(error.code!=='ESRCH')throw error;alive=false;}
        let boot=null;
        if(alive){
          boot=await hostBootTime();
          lease.assertHeld();
          // A PID can belong to an unrelated process after reboot. All native file
          // times must predate this boot; unsupported or ambiguous evidence stays closed.
          if(!Number.isFinite(boot)||boot<=0||boot>Date.now()||![stat.birthtimeMs,stat.mtimeMs,stat.ctimeMs].every(n=>Number.isFinite(n)&&n>0&&n<boot))fail('BUSY','Lock owner is alive or its prior boot cannot be proved');
        }
        const current=await readFile(lock,'utf8');
        const latest=await lstat(lock);
        lease.assertHeld();
        if(current!==JSON.stringify(owner)||!latest.isFile()||latest.isSymbolicLink()||['dev','ino','size','birthtimeMs','mtimeMs','ctimeMs'].some(k=>latest[k]!==stat[k]))fail('BUSY','Lock changed during recovery');
        const archived=path.join(files,`${id}.stale-${randomUUID()}.lock`);
        lease.assertHeld();
        await rename(lock,archived);
        return {recovered:true,archived,reason:alive?'PREVIOUS_BOOT':'DEAD_PID',...(alive?{hostBootTimeMs:boot}:{} )};
        }finally{await lease.release();}
      });
    }
  };
}
