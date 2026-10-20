import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run=promisify(execFile);
export function parseHostBootTime(value){
 const match=typeof value==='string'&&/^\{\s*sec\s*=\s*(\d+),\s*usec\s*=\s*(\d+)\s*\}[^\n]*(?:\n)?$/.exec(value);
 if(!match)return null;
 const sec=Number(match[1]),usec=Number(match[2]),ms=sec*1000+usec/1000;
 return Number.isSafeInteger(sec)&&sec>0&&Number.isSafeInteger(usec)&&usec>=0&&usec<1e6&&Number.isFinite(ms)&&ms<=Date.now()?ms:null;
}

/** macOS kernel boot time, not a PID, hostname timestamp or process uptime guess. */
export async function readHostBootTime(){
 if(process.platform!=='darwin')return null;
 try{const {stdout}=await run('/usr/sbin/sysctl',['-n','kern.boottime'],{encoding:'utf8',timeout:3000,maxBuffer:1024});return parseHostBootTime(stdout);}
 catch{return null;}
}
