import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { terminateWorkerProcessTree } from './process-control';

const exec = promisify(execFile);
export type FoundationWorkerIdentity = { projectId: string; id: string; workerToken: string | null; workerPid?: number | null };
const defaultScript = () => path.resolve('scripts/run-foundation-delivery.ts');
function commandTokens(command: string): string[] {
  return [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)].map(m=>m[1]??m[2]??m[3]);
}
export function matchesFoundationWorker(command: string, identity: FoundationWorkerIdentity, script = defaultScript()): boolean {
  if(!identity.projectId || !identity.id || !identity.workerToken)return false;
  const normalize=(value:string)=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  const tokens=commandTokens(command),at=tokens.findIndex(token=>normalize(token)===normalize(script));
  return at>=0 && tokens[at+1]===identity.projectId && tokens[at+2]===identity.id && tokens[at+3]===identity.workerToken && tokens.length===at+4;
}
export async function foundationWorkerCommand(pid: number): Promise<string | null> {
  if(!Number.isSafeInteger(pid)||pid<=0)return null;
  try {
    if(process.platform==='win32') {
      const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command',`[Console]::OutputEncoding=[Text.UTF8Encoding]::new(); (Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`],{encoding:'utf8',windowsHide:true,timeout:8000,maxBuffer:65536});
      return stdout.trim()||null;
    }
    const {stdout}=await exec('ps',['-p',String(pid),'-o','command='],{encoding:'utf8',timeout:3000,maxBuffer:65536});
    return stdout.trim()||null;
  }catch{return null;}
}
/** Refuses missing credentials, substring matches, wrong script/project/task/token, and this server PID. */
export async function stopFoundationWorkerProcess(identity: FoundationWorkerIdentity, script = defaultScript()): Promise<boolean> {
  const pid=identity.workerPid;
  if(!pid||pid===process.pid)return false;
  const command=await foundationWorkerCommand(pid);
  if(!command||!matchesFoundationWorker(command,identity,script))return false;
  await terminateWorkerProcessTree(pid);
  return true;
}
export function spawnFoundationWorkerProcess(identity: FoundationWorkerIdentity, script = defaultScript()) {
  if(!identity.projectId||!identity.id||!identity.workerToken)throw new Error('缺少后台任务身份参数');
  return spawn(process.execPath,['--import','tsx',path.resolve(script),identity.projectId,identity.id,identity.workerToken],{
    cwd:process.cwd(),env:process.env,detached:true,stdio:'ignore',windowsHide:true,
  });
}
