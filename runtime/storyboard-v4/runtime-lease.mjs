import {spawn,execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir,open,realpath} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {fail} from './core/shared.mjs';

const holder='process.stdin.on("end",()=>process.exit(0));process.stdin.resume();process.stdout.write("LOCKED\\n");';
const runFile=promisify(execFile);let machineIdentity;

// os.hostname() can be a DHCP address on macOS. Store only a namespaced hash
// of the hardware identity; a changing network name is not another machine.
export function readRuntimeMachineIdentity(){
 return machineIdentity??=(async()=>{
  let stdout;try{({stdout}=await runFile('/usr/sbin/ioreg',['-rd1','-c','IOPlatformExpertDevice'],{encoding:'utf8',timeout:3000,maxBuffer:131072}));}
  catch{fail('LEASE_UNAVAILABLE','无法核验本机稳定身份，未发送模型请求');}
  const uuid=stdout.match(/"IOPlatformUUID"\s*=\s*"([0-9a-f-]{36})"/i)?.[1]?.toLowerCase();
  if(!uuid||!/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(uuid)||uuid==='00000000-0000-0000-0000-000000000000')fail('LEASE_UNAVAILABLE','无法核验本机稳定身份，未发送模型请求');
  return 'mac-hardware-v1:'+createHash('sha256').update('director-runtime-host-v1\0'+uuid).digest('hex');
 })().catch(error=>{machineIdentity=null;throw error;});
}

// The macOS local runtime and maintenance tools share this permanent flock inode.
// Never unlink or move it: file presence is not ownership, the kernel lock is.
export async function acquireRuntimeLease(directory){
 if(typeof directory!=='string'||!directory.trim())fail('LEASE_UNAVAILABLE','缺少有效的执行锁目录');
 await mkdir(directory,{recursive:true,mode:0o700});
 const file=path.join(await realpath(directory),'.runtime-lease.lock');
 const handle=await open(file,constants.O_RDWR|constants.O_CREAT|constants.O_NOFOLLOW,0o600);await handle.close();
 const child=spawn('/usr/bin/lockf',['-k','-s','-t','0',file,process.execPath,'-e',holder],{stdio:['pipe','pipe','ignore'],detached:true});
 let held=false,finished=false,releasePromise;
 const killed=()=>{try{process.kill(-child.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')child.kill('SIGKILL');}};
 const closed=new Promise(resolve=>child.once('close',()=>{finished=true;held=false;resolve();}));
 child.stdin.on('error',()=>{});
 try{await new Promise((resolve,reject)=>{
  let decided=false,output='';const finish=error=>{if(decided)return;decided=true;clearTimeout(timer);error?reject(error):resolve();};
  const timer=setTimeout(()=>{killed();finish(Object.assign(new Error('无法及时取得本机执行锁'),{code:'LEASE_UNAVAILABLE'}));},5000);
  child.stdout.setEncoding('utf8');child.stdout.on('data',part=>{output+=part;if(output==='LOCKED\n'){held=true;finish();}else if(output.length>32){killed();finish(Object.assign(new Error('执行锁握手无法核验'),{code:'LEASE_UNAVAILABLE'}));}});
  child.once('error',()=>finish(Object.assign(new Error('本机执行锁工具不可用'),{code:'LEASE_UNAVAILABLE'})));
  child.once('close',code=>finish(Object.assign(new Error(code===75?'另一执行者或维护操作持有运行锁':'无法取得本机执行锁'),{code:code===75?'LEASE_BUSY':'LEASE_UNAVAILABLE'})));
 });}catch(error){child.stdin.end();if(!finished)killed();await closed;throw error;}
 child.unref();child.stdin.unref?.();child.stdout.unref?.();
 return {
  assertHeld(){if(!held||finished||child.exitCode!==null||child.signalCode!==null)fail('LEASE_LOST','执行锁已丢失，禁止继续写入或派发');},
  release(){return releasePromise??=(async()=>{held=false;child.ref();child.stdin.ref?.();child.stdout.ref?.();child.stdin.end();const timeout=setTimeout(killed,2000);try{await closed;}finally{clearTimeout(timeout);}})();}
 };
}
