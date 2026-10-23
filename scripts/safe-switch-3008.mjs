// Local operator only: no engine construction and no model invocation.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {createStore} from '../runtime/storyboard-v4/core/store.mjs';
import {createRuntimeMaintenance} from '../runtime/production-maintenance-control.mjs';
import {runtimeCodeIdentity} from '../runtime/production-maintenance-host.mjs';
import {ENTRY_REVIEW_VERSION} from '../runtime/storyboard-v4/core/entry-evidence.mjs';
import {digest} from '../runtime/storyboard-v4/core/shared.mjs';

const fail=(message)=>{throw new Error(message);},sleep=ms=>new Promise(r=>setTimeout(r,ms));
const alive=pid=>{try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}};
const json=async file=>JSON.parse(await fs.readFile(file,'utf8'));
export async function readCoordinatorLease(file){
 try{return {owner:await json(file),leaseAbsent:false};}catch(e){if(e.code!=='ENOENT')throw e;return {owner:null,leaseAbsent:true};}
}
export function inspectLocalHost(repo){
 if(process.platform!=='darwin')fail('本机进程监督器目前仅验证macOS；不猜测Windows命令或强行切换。');
 let output;try{output=execFileSync('/usr/sbin/lsof',['-nP','-iTCP:3008','-sTCP:LISTEN','-Fp'],{encoding:'utf8'});}catch(e){if(e.status===1)return null;throw e;}
 const pids=[...new Set(output.split('\n').filter(l=>/^p\d+$/.test(l)).map(l=>Number(l.slice(1))))];
 if(pids.length!==1)fail('3008监听归属不唯一');
 const pid=pids[0],parentPid=Number(execFileSync('/bin/ps',['-p',String(pid),'-o','ppid='],{encoding:'utf8'}).trim());
 const command=execFileSync('/bin/ps',['-p',String(parentPid),'-o','command='],{encoding:'utf8'}).trim();
 const cwdOkay=[pid,parentPid].every(p=>execFileSync('/usr/sbin/lsof',['-a','-p',String(p),'-d','cwd','-Fn'],{encoding:'utf8'}).split('\n').includes('n'+repo));
 if(!cwdOkay||command!==`${path.join(repo,'runtime-3008/node/bin/node')} scripts/launch-3008.cjs`)fail('监听、父进程、cwd或启动器不符，不发送信号');
 return {pid,parentPid,cwdOkay,launcherVerified:true};
}
export function verifyIdleLeaseAbsence(host,state,workflowId,authorization){
 const c=state?.control;
 if(!state?.safeToRetire||!['RESUMED','ISSUE_STOPPED'].includes(state.phase)||c?.phase!==state.phase||c.userPauseRequestedAt||c.workflowId!==workflowId||c.authorization!==authorization||c.loadedPid!==host?.pid||c.kernel?.pid!==host?.pid)fail('无租约且不能证明当前监听者是原授权已加载空闲内核，不开始维护');
 return {leaseAbsent:true,previousMaintenanceId:c.id,verifiedLoadedPid:c.loadedPid};
}
export function verifyIssueStoppedWorker(host,state,worker,workflowId,authorization){
 const c=state?.control;
 if(state?.phase!=='ISSUE_STOPPED'||c?.phase!=='ISSUE_STOPPED'||!state.safeToRetire||c.userPauseRequestedAt||c.workflowId!==workflowId||c.authorization!==authorization||c.loadedPid!==host?.pid||c.kernel?.pid!==host?.pid||worker?.status!=='WAIT_ISSUES'||c.issueStoppedWorkerHash!==digest(worker))fail('历史问题等待worker与当前已加载空闲内核不符，不开始下一次维护');
 return {previousMaintenanceId:c.id,verifiedLoadedPid:c.loadedPid,historicalWorkerPid:worker.pid};
}
function idleHost(repo,host){
 const rows=execFileSync('/bin/ps',['-axo','pid=,ppid=,comm='],{encoding:'utf8'}).split('\n').map(s=>/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(s)).filter(Boolean).map(m=>({pid:Number(m[1]),ppid:Number(m[2]),name:m[3]}));
 const family=new Set([host.pid,host.parentPid]);for(let i=0;i<16;i++)for(const p of rows)if(family.has(p.ppid))family.add(p.pid);
 const modelProcesses=rows.filter(p=>family.has(p.pid)&&/codex|claude|deepseek/i.test(p.name));
 const url=process.env.DATABASE_URL;if(!url?.startsWith('file:'))fail('数据库类型不明确');
 const db=new DatabaseSync(path.resolve(repo,'prisma',url.slice(5).split('?')[0]),{readOnly:true});
 let databaseActive;try{databaseActive=db.prepare("SELECT status,COUNT(*) AS count FROM PipelineRun WHERE status IN ('RUNNING','QUEUED','PENDING','CANCELLING') GROUP BY status").all();}finally{db.close();}
 if(modelProcesses.length||databaseActive.length)fail('仍有真实模型子进程或数据库在途，拒绝停服');
 return {modelProcesses:0,databaseActive:0};
}
async function installBridge(workflows,runs,workflowId){
 const w=await workflows.read(workflowId),r=await runs.read(Object.values(w.selectedRuns)[0]),episodeId=r.web.binding.episodeId;
 let installed=false;for(let i=0;i<4&&!installed;i++){
  const response=await fetch(`http://127.0.0.1:3008/api/episodes/${encodeURIComponent(episodeId)}/storyboard?view=saved`,{signal:AbortSignal.timeout(45000)});await response.arrayBuffer();
  installed=response.headers.get('x-runtime-maintenance-bridge')==='runtime-maintenance-v1';if(!installed)await sleep(250);
 }
 if(!installed)fail('受控桥接尚未装入，不发送维护信号');
 // Compile the ordinary user-pause entry too; no login or provider check is performed.
 const workflow=await fetch(`http://127.0.0.1:3008/api/projects/${encodeURIComponent(w.projectId)}/production-workflow?workflowId=${encodeURIComponent(w.id)}`);await workflow.arrayBuffer();
}
async function waitFor(maintenance,predicate,timeoutMs){
 const deadline=Date.now()+timeoutMs;
 for(;;){const c=await maintenance.current();if(c.lastError)fail(`维护失败：${c.lastError.code}；门保持关闭，请查看持久证据`);if(predicate(c))return c;if(Date.now()>=deadline)fail('维护等待超时，保留原门与回包，不重复信号或重发模型');await sleep(500);}
}
export async function runLocalSwitch(args=process.argv.slice(2)){
 try{process.loadEnvFile('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
 const repo=process.cwd(),[action,workflowId,authorization]=args;
 if(!['begin','status','retarget','load','resume','release-issues'].includes(action))fail('用法：safe-switch-3008.mjs begin WORKFLOW AUTHORIZATION | status | retarget OLD_CODE_IDENTITY VERIFICATION_FILE | load | resume | release-issues');
 const dataRoot=path.resolve(process.env.DIRECTOR_STORYBOARD_DATA_DIR||'.storyboard-stage3-v2'),workflowDirectory=path.resolve(process.env.DIRECTOR_PRODUCTION_WORKFLOW_DIR||'.production-workflows'),budgetDirectory=path.resolve(process.env.DIRECTOR_PRODUCTION_BUDGET_DIR||'.production-ledgers');
 const maintenance=createRuntimeMaintenance({dataRoot,workflowDirectory,budgetDirectory}),workflows=createStore(workflowDirectory),runs=createStore(dataRoot);
 const audit=path.join(repo,'runtime-3008','maintenance-audit');await fs.mkdir(audit,{recursive:true,mode:0o700});
 const save=async(kind,result)=>{const at=new Date().toISOString(),name=`${kind}-${at.replaceAll(/[-:.]/g,'')}.json`;await fs.writeFile(path.join(audit,name),JSON.stringify({at,action,productionModelCallsByControl:0,...result},null,2),{flag:'wx',mode:0o600});return path.join(audit,name);};
 if(action==='status'){
  const s=await maintenance.status();console.log(JSON.stringify({phase:s.phase,authorization:s.authorization,safeToRetire:s.safeToRetire,blockers:s.blockers,lastError:s.control.lastError??null,loadedPid:s.control.loadedPid??null}));return s;
 }
 if(action==='begin'){
  if(!workflowId||!authorization)fail('必须明确原workflow及原授权');
  const host=inspectLocalHost(repo);if(!host)fail('原服务未运行');await installBridge(workflows,runs,workflowId);
  const fresh=inspectLocalHost(repo);if(fresh?.pid!==host.pid||fresh.parentPid!==host.parentPid)fail('桥接装入期间执行者变化');
  const w=await workflows.read(workflowId);let historicalWorkerProof=null;
  if(w.parallel?.worker?.pid!==host.pid)historicalWorkerProof=verifyIssueStoppedWorker(fresh,await maintenance.status(),w.parallel?.worker,workflowId,authorization);
  const {owner,leaseAbsent}=await readCoordinatorLease(path.join(dataRoot,'.coordinator-owner.json'));let leaseAbsenceEvidence=null;
  if(!leaseAbsent){if(!owner||owner.pid!==host.pid)fail('coordinator租约不是当前监听者');}
  else leaseAbsenceEvidence={...verifyIdleLeaseAbsence(fresh,await maintenance.status(),workflowId,authorization),idle:idleHost(repo,fresh)};
  const code=await runtimeCodeIdentity(repo),c=await maintenance.begin({workflowId,expectedAuthorization:authorization,expectedRevision:w.revision,targetPid:host.pid,codeIdentity:code.identity,requiredCapabilities:{productionEntryReviewVersion:ENTRY_REVIEW_VERSION}});
  const evidence=await save('begin',{control:c,host,historicalWorkerProof,coordinatorOwnerTokenHash:owner?createHash('sha256').update(owner.token).digest('hex'):null,leaseAbsenceEvidence,codeManifest:code.files});
  const checked=inspectLocalHost(repo);if(checked?.pid!==c.targetPid)fail('发送信号前PID/cwd漂移');process.kill(c.targetPid,'SIGUSR2');
  console.log(JSON.stringify({phase:c.phase,workflowId,authorization:c.authorization,evidence,newProductionModelCalls:0}));return c;
 }
 let c=await maintenance.current();
 if(action==='retarget'){
  if(!workflowId||!authorization)fail('须明确旧目标源码身份与离线核验文件');
  const code=await runtimeCodeIdentity(repo),evidenceFile=path.resolve(authorization),bytes=await fs.readFile(evidenceFile),proof=JSON.parse(bytes);
  if(proof.offlineVerified!==true||proof.productionModelCalls!==0||proof.workflowId!==c.workflowId||proof.authorization!==c.authorization||proof.codeIdentity!==code.identity||!Array.isArray(proof.checks)||!proof.checks.length||proof.checks.some(check=>check?.passed!==true))fail('离线核验未通过或不属于当前原授权/源码');
  const host=inspectLocalHost(repo);if(!host||host.pid!==c.targetPid)fail('旧监听执行者已变化，不重绑源码');
  const idle=idleHost(repo,host);
  try{await fs.stat(path.join(dataRoot,'.coordinator-owner.json'));fail('旧coordinator尚未释放租约');}catch(e){if(e.code!=='ENOENT')throw e;}
  const fresh=inspectLocalHost(repo);if(fresh?.pid!==host.pid||fresh.parentPid!==host.parentPid||(await runtimeCodeIdentity(repo)).identity!==code.identity)fail('核验期间执行者或源码改变');
  c=await maintenance.retargetCode({expectedCodeIdentity:workflowId,codeIdentity:code.identity,verification:{codeIdentity:code.identity,evidenceFile,evidenceSha256:createHash('sha256').update(bytes).digest('hex')}});
  const evidence=await save('retargeted',{control:c,host,idle,codeManifest:code.files});console.log(JSON.stringify({phase:c.phase,codeIdentity:c.codeIdentity,evidence,newProductionModelCalls:0}));return c;
 }
 if(action==='load'){
  c=await waitFor(maintenance,v=>['RETIRED','LOADED'].includes(v.phase),20*60*1000);
  const status=await maintenance.status();if(!status.safeToRetire)fail('持久状态仍有在途，不停服');
  const code=await runtimeCodeIdentity(repo);if(code.identity!==c.codeIdentity)fail('离线验收后源码改变，未停服');
  const host=inspectLocalHost(repo);
  if(c.phase==='LOADED'&&host?.pid===c.loadedPid){console.log(JSON.stringify({phase:c.phase,newPid:c.loadedPid,reused:true}));return c;}
  if(c.phase==='LOADED'&&alive(c.loadedPid))fail('已加载执行者仍活着但监听变化，不改绑');
  if(host?.pid===c.targetPid){
  const idle=idleHost(repo,host);
  try{await fs.stat(path.join(dataRoot,'.coordinator-owner.json'));fail('旧coordinator尚未释放租约');}catch(e){if(e.code!=='ENOENT')throw e;}
  await save('pre-stop',{control:c,host,idle});
  // Only verified idle Web processes receive TERM. No model PID or process group is signalled.
  const again=inspectLocalHost(repo);if(again?.pid!==host.pid||again.parentPid!==host.parentPid)fail('停服前执行者变化');idleHost(repo,again);
  process.kill(host.parentPid,'SIGTERM');
  let deadline=Date.now()+15000;while((alive(host.parentPid)||alive(host.pid))&&Date.now()<deadline)await sleep(100);
  if(alive(host.pid)){const remaining=inspectLocalHost(repo);if(remaining?.pid!==host.pid)fail('监听身份变化，不处理旧PID');idleHost(repo,remaining);process.kill(host.pid,'SIGTERM');deadline=Date.now()+10000;while(alive(host.pid)&&Date.now()<deadline)await sleep(100);}
  if(alive(host.parentPid)||alive(host.pid)||inspectLocalHost(repo))fail('旧服务尚未退出，保持维护门，不强杀');
  }else if(alive(c.targetPid))fail('原进程仍存在但监听归属变化，不发送信号');
  let next=inspectLocalHost(repo),deadline;
  if(!next){
  const stamp=new Date().toISOString().replaceAll(/[-:.]/g,''),out=await fs.open(path.join(audit,`server-${stamp}.stdout.log`),'wx',0o600),err=await fs.open(path.join(audit,`server-${stamp}.stderr.log`),'wx',0o600);
  const child=spawn(process.execPath,['scripts/launch-3008.cjs'],{cwd:repo,detached:true,stdio:['ignore',out.fd,err.fd],env:process.env});child.unref();await out.close();await err.close();
  deadline=Date.now()+60000;while(Date.now()<deadline){next=inspectLocalHost(repo);if(next)break;await sleep(500);}if(!next)fail('新服务未就绪，保持维护门，不新建队列');
  }
  await installBridge(workflows,runs,c.workflowId);next=inspectLocalHost(repo);await maintenance.expectLoad(next.pid);process.kill(next.pid,'SIGUSR2');
  c=await waitFor(maintenance,v=>v.phase==='LOADED',60000);
  const evidence=await save('loaded',{control:c,host:next});console.log(JSON.stringify({phase:c.phase,oldPid:c.targetPid,newPid:c.loadedPid,kernel:c.kernel,evidence,newProductionModelCalls:0}));return c;
 }
 if(action==='release-issues'){
  const host=inspectLocalHost(repo);if(!host||host.pid!==c.loadedPid||!['LOADED','RELEASING_ISSUES','ISSUE_STOPPED'].includes(c.phase))fail('新内核加载身份未核验，保持维护门');
  if((await runtimeCodeIdentity(repo)).identity!==c.codeIdentity)fail('加载证明后源码改变');
  if(c.phase!=='ISSUE_STOPPED'){
   c=await maintenance.requestResumeProof();process.kill(c.loadedPid,'SIGUSR2');await waitFor(maintenance,v=>v.resumeProof?.nonce===c.resumeProofNonce,60000);
  }
  c=await maintenance.releaseIssues();const fresh=inspectLocalHost(repo);if(fresh?.pid!==c.loadedPid)fail('释放前执行者变化');process.kill(c.loadedPid,'SIGUSR2');
  const evidence=await save('issue-stopped',{control:c,host:fresh});console.log(JSON.stringify({phase:c.phase,authorization:c.authorization,evidence,maintenanceModelCalls:0,queueEnabled:false}));return c;
 }
 if(action==='resume'){
  const host=inspectLocalHost(repo);if(!host||host.pid!==c.loadedPid||!['LOADED','RESUMING','RESUMED'].includes(c.phase))fail('新内核加载身份未核验，保持维护门');
  if((await runtimeCodeIdentity(repo)).identity!==c.codeIdentity)fail('加载证明后源码改变');
  if(c.phase==='LOADED'){await maintenance.recoverPreDispatchFailures();await maintenance.activateUnfinished();}
  if(c.phase!=='RESUMED'){
   c=await maintenance.requestResumeProof();process.kill(c.loadedPid,'SIGUSR2');
   await waitFor(maintenance,v=>v.resumeProof?.nonce===c.resumeProofNonce,60000);
  }
  c=await maintenance.resume();
  const fresh=inspectLocalHost(repo);if(fresh?.pid!==c.loadedPid)fail('恢复前执行者变化');process.kill(c.loadedPid,'SIGUSR2');
  const evidence=await save('resumed',{control:c,host:fresh});console.log(JSON.stringify({phase:c.phase,authorization:c.authorization,activated:c.activated??[],evidence,maintenanceModelCalls:0,meaning:'仅恢复原授权正常队列；后续原计划调用不算维护额外调用'}));return c;
 }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))runLocalSwitch().catch(error=>{console.error(JSON.stringify({code:error.code??'RUNTIME_MAINTENANCE_FAILED',error:error.message,gateRetained:true}));process.exitCode=1;});
