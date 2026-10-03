import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as runner from './runner.mjs';
import {digest} from './shared.mjs';
import childProcess from 'node:child_process';

const baseRequest={stage:'author',prompt:'本地执行器超时回归',instructions:'输出JSON',settings:{model:'gpt-6.1-sol',reasoning:'medium'},inputHash:'timeout-fixture',promptHash:digest('本地执行器超时回归')};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const windows=process.platform==='win32';
function assertNativeTreeTermination(receipt){
  assert.equal(receipt.localProcess.exitSignal,null);
  assert.ok(receipt.localProcess.terminationRequests.some(r=>r.mechanism==='windows_taskkill_tree'&&r.forced===true&&r.signal===null&&r.result==='sent'));
}
async function fixture(t,body,{request=baseRequest,...options}={}){
  const directory=await mkdtemp(path.join(tmpdir(),'v4-cli-timeout-'));
  const script=path.join(directory,'fake-cli.mjs'),attemptId='timing';
  await writeFile(script,`process.stdin.resume();\nawait new Promise(resolve=>process.stdin.on('end',resolve));\nconst emit=e=>process.stdout.write(JSON.stringify(e)+'\\n');\n${body}`);
  const completion=runner.runModel(request,{directory,attemptId,executable:process.execPath,executableArgs:[script],...options}).then(result=>({result}),error=>({error}));
  t.after(async()=>{await completion;await rm(directory,{recursive:true,force:true});});
  const receipt=()=>readFile(path.join(directory,'attempts',attemptId,'receipt.json'),'utf8').then(JSON.parse);
  return {directory,attemptId,completion,receipt};
}
async function waitReceipt(f,predicate,limit=2200){
  const until=Date.now()+limit;
  let receipt;
  do{receipt=await f.receipt().catch(()=>null);if(receipt&&predicate(receipt))return receipt;await pause(20);}while(Date.now()<until);
  assert.fail(`No matching live receipt; last phase=${receipt?.execution?.phase}, state=${receipt?.state}`);
}

test('default time budgets grow with observed author/finish workload and remain bounded',()=>{
  assert.equal(typeof runner.resolveRunnerLimits,'function');
  const heavy={...baseRequest,prompt:'字'.repeat(76177),plan:{provisionalUnits:Array.from({length:9},()=>({}))}};
  const small=runner.resolveRunnerLimits(baseRequest),large=runner.resolveRunnerLimits(heavy);
  assert.equal(large.totalMs,24*60000);
  assert.ok(large.totalMs>small.totalMs);
  assert.ok(large.idleMs>600000,'heavy silent generation is not still killed at ten minutes');
  assert.ok(large.startupMs<large.idleMs);
  assert.ok(runner.resolveRunnerLimits({...heavy,stage:'finish',previousDraft:{units:Array.from({length:12},()=>({}))}}).totalMs>large.totalMs);
  assert.equal(runner.resolveRunnerLimits({...heavy,plan:{provisionalUnits:Array.from({length:200},()=>({}))}}).totalMs,30*60000);
  assert.equal(runner.resolveRunnerLimits(baseRequest,{timeoutMs:900000}).totalMs,900000,'explicit caller budget is no longer capped at ten minutes');
  assert.equal(runner.resolveRunnerLimits(baseRequest,{timeoutMs:20}).totalMs,20);
});

test('startup errors do not count as lifecycle start and timeout keeps redacted evidence',async t=>{
  const f=await fixture(t,`
process.stderr.write('failed to refresh available models: request timed out; api_key=PRIVATE_KEY\\n');
const interval=setInterval(()=>{emit({type:'error',message:'request timed out Authorization: Bearer PRIVATE_AUTH'});process.stderr.write('still retrying\\n');},15);
setTimeout(()=>{clearInterval(interval);process.exit(0);},1200);`,{timeoutMs:800,startupTimeoutMs:180,idleTimeoutMs:400});
  const {error}=await f.completion,receipt=await f.receipt();
  assert.equal(error?.code,'TIMEOUT');
  assert.equal(receipt.execution?.timeoutKind,'startup');
  assert.equal(receipt.execution.phase,'failed');
  assert.equal(receipt.execution.lastProgressAt,null);
  assert.ok(receipt.execution.eventCount>0);
  assert.match(error.message,/启动.*已等待/);
  assert.match(error.message,/request timed out/);
  assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE_KEY|PRIVATE_AUTH/);
  assert.equal(receipt.usage.totalTokens,null);
  assert.equal(receipt.localProcess.closeObserved,true);
  if(windows)assertNativeTreeTermination(receipt);
  else{assert.equal(receipt.localProcess.exitSignal,'SIGTERM');assert.ok(receipt.localProcess.terminationRequests.some(r=>r.signal==='SIGTERM'&&r.requestedAt));}
});

test('turn.started is waiting, and duplicate snapshots plus heartbeat/error spam cannot renew idle budget',async t=>{
  const f=await fixture(t,`
emit({type:'thread.started',thread_id:'not-a-model-acceptance-proof'});
emit({type:'turn.started'});
emit({type:'item.updated',item:{id:'r1',type:'reasoning',text:'PRIVATE_REASONING'}});
const interval=setInterval(()=>{emit({type:'turn.started'});emit({type:'heartbeat'});emit({type:'error',message:'retrying'});emit({type:'item.updated',item:{id:'r1',type:'reasoning',text:'PRIVATE_REASONING'}});},20);
setTimeout(()=>{clearInterval(interval);process.exit(0);},1500);`,{timeoutMs:1100,startupTimeoutMs:300,idleTimeoutMs:180});
  const {error}=await f.completion,receipt=await f.receipt();
  assert.equal(error?.code,'TIMEOUT');
  assert.equal(receipt.execution?.timeoutKind,'idle');
  assert.ok(Date.parse(receipt.execution.lastEventAt)>Date.parse(receipt.execution.lastProgressAt));
  assert.ok(receipt.durationMs<750,'duplicates must not push timeout to the total limit');
  assert.doesNotMatch(JSON.stringify(receipt),/PRIVATE_REASONING|not-a-model-acceptance-proof/);
});

test('growing model output renews idle waiting without bypassing the absolute total deadline',async t=>{
  const f=await fixture(t,`
emit({type:'turn.started'});
let text='';const interval=setInterval(()=>{text+='字';emit({type:'item.updated',item:{id:'r1',type:'reasoning',text}});},35);
setTimeout(()=>{clearInterval(interval);process.exit(0);},1500);`,{timeoutMs:430,startupTimeoutMs:200,idleTimeoutMs:150});
  const {error}=await f.completion,receipt=await f.receipt();
  assert.equal(error?.code,'TIMEOUT');
  assert.equal(receipt.execution?.timeoutKind,'total');
  assert.ok(receipt.execution.lastProgressAt);
  assert.match(error.message,/生成.*已等待/);
  assert.equal(receipt.usage.totalTokens,null);
});

test('a zero-output turn completion fails as empty without waiting or inventing generation progress',async t=>{
  const f=await fixture(t,`
emit({type:'turn.started'});
setTimeout(()=>emit({type:'turn.completed',usage:{input_tokens:3,output_tokens:0}}),45);
setTimeout(()=>process.exit(0),1200);`,{timeoutMs:800,startupTimeoutMs:300,idleTimeoutMs:180});
  const {error}=await f.completion,receipt=await f.receipt();
  assert.equal(error?.code,'EMPTY_RESPONSE');assert.equal(receipt.execution.timeoutKind,null);
  assert.equal(receipt.execution.lastProgressAt,null);
  assert.equal(receipt.execution.terminalEvent,'turn.completed');assert.equal(receipt.usage.outputTokens,0);
});

test('live receipts distinguish waiting from actual generation, and never overwrite FINAL',async t=>{
  const f=await fixture(t,`
emit({type:'thread.started',thread_id:'fixture'});emit({type:'turn.started'});
setTimeout(()=>emit({type:'item.updated',item:{id:'r1',type:'reasoning',text:'PRIVATE_REASONING_SNAPSHOT'}}),1300);
setTimeout(()=>{emit({type:'item.completed',item:{id:'a1',type:'agent_message',text:'{"ok":true}'}});emit({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}});},2400);`,{timeoutMs:4000,startupTimeoutMs:500,idleTimeoutMs:1800});
  const waiting=await waitReceipt(f,r=>r.state!=='FINAL'&&r.execution?.phase==='waiting');
  assert.equal(waiting.execution.lastProgressAt,null,'CLI turn start is not proof of model generation');
  assert.ok(waiting.execution.lastEventAt);
  const generating=await waitReceipt(f,r=>r.state!=='FINAL'&&r.execution?.phase==='generating');
  assert.ok(generating.execution.lastProgressAt);
  assert.doesNotMatch(JSON.stringify(generating),/PRIVATE_REASONING/);
  const {result,error}=await f.completion;
  assert.equal(error,undefined);assert.deepEqual(result.output,{ok:true});
  const final=await f.receipt();
  assert.equal(final.state,'FINAL');assert.equal(final.execution.phase,'completed');
  assert.equal(final.localProcess.closeObserved,true);assert.equal(final.localProcess.exitSignal,null);
  assert.equal(final.execution.workload.stage,'author');assert.equal(final.execution.workload.promptChars,baseRequest.prompt.length);
  assert.equal(final.usage.totalTokens,5);
  await pause(1100);
  assert.deepEqual(await f.receipt(),final,'no late progress write may replace the final snapshot');
});

test('explicit short timeout remains fast and termination records observed SIGKILL close',async t=>{
  const fast=await fixture(t,'setTimeout(()=>process.exit(0),1500);',{timeoutMs:20});
  const started=Date.now(),first=await fast.completion,fastReceipt=await fast.receipt();
  assert.equal(first.error?.code,'TIMEOUT');
  assert.ok(Date.now()-started<1200);assert.equal(fastReceipt.execution?.limits.totalMs,20);
  const forced=await fixture(t,"process.on('SIGTERM',()=>{});emit({type:'turn.started'});setTimeout(()=>process.exit(0),3000);",{timeoutMs:250});
  const second=await forced.completion,receipt=await forced.receipt();
  assert.equal(second.error?.code,'TIMEOUT');
  assert.equal(receipt.localProcess.closeObserved,true);
  if(windows)assertNativeTreeTermination(receipt);
  else{assert.equal(receipt.localProcess.exitSignal,'SIGKILL');assert.ok(receipt.localProcess.terminationRequests.some(r=>r.signal==='SIGKILL'&&r.requestedAt));}
  assert.ok(receipt.localProcess.exitedAt);
});

test('saved body returns directly after terminal cleanup and remains recoverable',async t=>{
  const f=await fixture(t,`
emit({type:'turn.started'});
emit({type:'item.completed',item:{id:'a1',type:'agent_message',text:'{"ok":true}'}});
emit({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}});
setTimeout(()=>process.exit(0),1500);`,{timeoutMs:550,startupTimeoutMs:250,idleTimeoutMs:160});
  const {result,error}=await f.completion,receipt=await f.receipt();
  assert.equal(error,undefined);assert.deepEqual(result.output,{ok:true});assert.equal(result.requestOutcome,'RESPONDED');
  assert.equal(receipt.execution?.timeoutKind,null);assert.equal(receipt.localProcess.closeObserved,true);
  assert.equal(receipt.usage.totalTokens,5);
  assert.deepEqual((await runner.readCompletedAttempt({directory:f.directory,attemptId:f.attemptId})).output,{ok:true});
});

for(const needsCleanup of [true,false])test(`a partial output file cannot hide a complete final event (${needsCleanup?'terminal cleanup':'normal close'})`,async t=>{
  const f=await fixture(t,`
import {writeFile} from 'node:fs/promises';
emit({type:'turn.started'});
await writeFile(process.argv[process.argv.indexOf('-o')+1],'{');
emit({type:'item.completed',item:{id:'a1',type:'agent_message',text:'{"ok":true}'}});
emit({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}});
${needsCleanup?'setTimeout(()=>process.exit(0),1500);':''}`,{timeoutMs:550,startupTimeoutMs:250,idleTimeoutMs:160});
  const {result,error}=await f.completion;
  assert.equal(error,undefined);assert.deepEqual(result.output,{ok:true});
  const restored=await runner.readCompletedAttempt({directory:f.directory,attemptId:f.attemptId});
  assert.deepEqual(restored.output,{ok:true});assert.equal(restored.raw,'{"ok":true}');
  const attempt=path.join(f.directory,'attempts',f.attemptId);
  assert.equal(await readFile(path.join(attempt,'raw.txt'),'utf8'),'{','paid primary file stays untouched');
  assert.equal(await readFile(path.join(attempt,'event-final.txt'),'utf8'),'{"ok":true}');
});

test(windows?'native Windows tree termination closes inherited pipes but leaves timeout UNKNOWN':'signal requests never masquerade as observed CLI close when inherited pipes remain open',async t=>{
  const f=await fixture(t,`
import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
const child=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),5000)'],{detached:true,stdio:['ignore',process.stdout,process.stderr]});
await writeFile(new URL('./descendant-pid',import.meta.url),String(child.pid));
process.on('SIGTERM',()=>process.exit(0));
emit({type:'turn.started'});
setInterval(()=>{},1000);`,{timeoutMs:300});
  let pid;
  t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}});
  // Read the actual spawned descendant identity. A subsecond timeout need not
  // produce an intermediate heartbeat receipt before FINAL settles.
  const until=Date.now()+2000;
  while(!pid&&Date.now()<until){pid=Number(await readFile(path.join(f.directory,'descendant-pid'),'utf8').catch(()=>''));if(!pid)await pause(10);}
  assert.ok(Number.isSafeInteger(pid)&&pid>0,'fixture descendant actually spawned');
  const {error}=await f.completion,receipt=await f.receipt();
  assert.equal(error?.code,'TIMEOUT');
  if(windows){
    assert.equal(receipt.localProcess.closeObserved,true);assert.ok(receipt.localProcess.exitedAt);assertNativeTreeTermination(receipt);
    assert.throws(()=>process.kill(pid,0),{code:'ESRCH'},'detached fixture descendant actually exited');
  }else{
    assert.equal(receipt.localProcess.closeObserved,false);assert.equal(receipt.localProcess.exitedAt,null);assert.equal(receipt.localProcess.exitSignal,null);
    assert.deepEqual(receipt.localProcess.terminationRequests.map(r=>r.signal),['SIGTERM','SIGKILL']);
  }
  assert.equal(receipt.requestOutcome,'UNKNOWN');assert.equal(receipt.usage.totalTokens,null);
});

if(windows)test('failed native Windows tree termination never fabricates close or permits resend',async t=>{
  const nativeExecFile=childProcess.execFile;
  t.mock.method(childProcess,'execFile',(...args)=>{
    if(path.basename(args[0]).toLowerCase()!=='taskkill.exe')return nativeExecFile(...args);
    process.nextTick(()=>args.at(-1)(Object.assign(new Error('mock unavailable native tree terminator'),{code:'EACCES'}),'',''));
  });
  const f=await fixture(t,"emit({type:'turn.started'});setInterval(()=>{},1000);",{timeoutMs:200});
  let pid;
  try{
    const {error}=await f.completion,receipt=await f.receipt();pid=receipt.localProcess.pid;
    assert.equal(error?.code,'TIMEOUT');assert.equal(error.requestOutcome,'UNKNOWN');
    assert.equal(receipt.localProcess.closeObserved,false);assert.equal(receipt.localProcess.exitedAt,null);assert.equal(receipt.localProcess.exitSignal,null);
    assert.ok(receipt.localProcess.terminationRequests.length>0);assert.ok(receipt.localProcess.terminationRequests.every(r=>r.mechanism==='windows_taskkill_tree'&&r.result==='failed'));
    assert.doesNotThrow(()=>process.kill(pid,0),'the test CLI is genuinely still alive');
    await assert.rejects(runner.runModel(baseRequest,{directory:f.directory,attemptId:f.attemptId,executable:process.execPath,executableArgs:[path.join(f.directory,'fake-cli.mjs')]}),error=>error.code==='ATTEMPT_EXISTS'&&error.requestOutcome==='UNKNOWN');
  }finally{
    // This PID comes from this exact run's native ChildProcess receipt; cleanup
    // deliberately bypasses only the test mock and invokes the real tree tool.
    if(!pid)pid=(await f.receipt().catch(()=>null))?.localProcess?.pid;
    if(pid)await new Promise(resolve=>nativeExecFile(path.join(process.env.SystemRoot,'System32/taskkill.exe'),['/PID',String(pid),'/T','/F'],{windowsHide:true},()=>resolve()));
  }
});
