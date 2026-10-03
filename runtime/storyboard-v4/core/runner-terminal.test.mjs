import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runModel,readCompletedAttempt,readAttemptEvidence} from './runner.mjs';
import {digest} from './shared.mjs';

const request={stage:'author',prompt:'终态回收本地回归',instructions:'输出JSON',settings:{model:'gpt-6.1-sol',reasoning:'medium'},inputHash:'terminal-fixture',promptHash:digest('终态回收本地回归')};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(t,body,options={}){
  const directory=await mkdtemp(path.join(tmpdir(),'v4-cli-terminal-')),attemptId='terminal',script=path.join(directory,'fake-cli.mjs');
  await writeFile(script,`import {writeFile} from 'node:fs/promises';\nprocess.stdin.resume();\nawait new Promise(resolve=>process.stdin.on('end',resolve));\nconst emit=e=>process.stdout.write(JSON.stringify(e)+'\\n');\n${body}`);
  const completion=runModel(request,{directory,attemptId,executable:process.execPath,executableArgs:[script],timeoutMs:900,startupTimeoutMs:300,idleTimeoutMs:250,...options}).then(result=>({result}),error=>({error}));
  t.after(async()=>{await completion;await rm(directory,{recursive:true,force:true});});
  const receipt=()=>readFile(path.join(directory,'attempts',attemptId,'receipt.json'),'utf8').then(JSON.parse);
  return {directory,attemptId,completion,receipt};
}
async function waitFor(read,predicate,limit=2500){
  const until=Date.now()+limit;let value;
  do{value=await read().catch(()=>null);if(predicate(value))return value;await pause(10);}while(Date.now()<until);
  assert.fail('fixture did not reach the expected state');
}
const complete=`emit({type:'item.completed',item:{id:'a1',type:'agent_message',text:'{"ok":true}'}});`;

for(const withUsage of [true,false])test(`complete final settles without CLI exit (${withUsage?'known':'unknown'} usage)`,async t=>{
  const f=await fixture(t,`${complete}\nemit({type:'turn.completed'${withUsage?',usage:{input_tokens:3,output_tokens:2}':''}});\nsetTimeout(()=>process.exit(0),4000);`);
  const {result,error}=await f.completion,receipt=await f.receipt();
  assert.equal(error,undefined);assert.deepEqual(result.output,{ok:true});
  assert.equal(result.usage.totalTokens,withUsage?5:null);assert.equal(result.responseDisposition,'final');
  assert.equal(receipt.execution.timeoutKind,null);assert.equal(receipt.execution.terminalEvent,'turn.completed');
  assert.ok(receipt.execution.terminalAt);assert.equal(receipt.responseDisposition,'final');
  assert.equal(receipt.localProcess.closeObserved,true);assert.equal(receipt.localProcess.exitSignal,'SIGTERM');
  assert.ok(receipt.durationMs<2000,'terminal settlement must not use the generation deadline');
  assert.deepEqual((await readCompletedAttempt(f)).output,{ok:true});
});

test('terminal completion preserves a natural zero exit without synthetic termination',async t=>{
  const f=await fixture(t,`${complete}\nemit({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}});`);
  const {result,error}=await f.completion,receipt=await f.receipt();
  assert.equal(error,undefined);assert.deepEqual(result.output,{ok:true});
  assert.equal(receipt.localProcess.closeObserved,true);assert.equal(receipt.localProcess.exitCode,0);
  assert.equal(receipt.localProcess.exitSignal,null);assert.deepEqual(receipt.localProcess.terminationRequests,[]);
});

test('terminal success recycles a TERM-ignoring CLI without changing the result into CLI_FAILED',async t=>{
  const f=await fixture(t,`process.on('SIGTERM',()=>{});${complete}\nemit({type:'turn.completed'});setTimeout(()=>process.exit(0),4000);`);
  const {result,error}=await f.completion,receipt=await f.receipt();
  assert.equal(error,undefined);assert.deepEqual(result.output,{ok:true});
  assert.equal(receipt.localProcess.closeObserved,true);assert.equal(receipt.localProcess.exitSignal,'SIGKILL');
  assert.deepEqual(receipt.localProcess.terminationRequests.map(r=>r.signal),['SIGTERM','SIGKILL']);
  assert.equal(receipt.execution.timeoutKind,null);assert.equal(receipt.usage.totalTokens,null);
});

for(const body of ['','{','{"ok":true}'])test(`turn.failed settles promptly and never recovers unfinished body ${JSON.stringify(body)}`,async t=>{
  const f=await fixture(t,`${body?`emit({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(body)}}});`:''}
emit({type:'turn.failed',error:{message:'Stream disconnected api_key=PRIVATE_KEY'}});setTimeout(()=>process.exit(0),4000);`);
  const {error}=await f.completion,receipt=await f.receipt();
  assert.equal(error?.code,'CLI_FAILED');assert.match(error.message,/Stream disconnected/);assert.doesNotMatch(error.message,/PRIVATE_KEY/);
  assert.equal(error.requestOutcome,'UNKNOWN');assert.equal(receipt.execution.timeoutKind,null);
  assert.equal(receipt.execution.terminalEvent,'turn.failed');assert.equal(receipt.responseDisposition,body?'incomplete':'none');
  assert.equal(receipt.localProcess.closeObserved,true);assert.equal(receipt.usage.totalTokens,null);
  await assert.rejects(readCompletedAttempt(f),{code:'ATTEMPT_UNRESOLVED'});
  const evidence=await readAttemptEvidence(f);assert.equal(evidence.hasResponseBody,Boolean(body));assert.equal(evidence.responseDisposition,body?'incomplete':'none');
  if(body)assert.equal(await readFile(path.join(f.directory,'attempts',f.attemptId,'event-final.txt'),'utf8'),body);
});

test('agent_message alone does not settle early and transient errors are not terminal',async t=>{
  const f=await fixture(t,`${complete}\nemit({type:'error',message:'Reconnecting after interruption'});setTimeout(()=>process.exit(0),4000);`);
  const {error}=await f.completion,receipt=await f.receipt();
  assert.equal(error?.code,'TIMEOUT');assert.equal(receipt.execution.timeoutKind,'idle');
  assert.equal(receipt.execution.terminalEvent,null);assert.equal(receipt.usage.totalTokens,null);
});

test('turn.completed with half JSON settles into the original parser rejection without losing raw',async t=>{
  const f=await fixture(t,`emit({type:'item.completed',item:{type:'agent_message',text:'{'}});emit({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}});setTimeout(()=>process.exit(0),4000);`);
  const {error}=await f.completion,receipt=await f.receipt();
  assert.equal(error?.code,'INVALID_JSON');assert.equal(error.raw,'{');assert.equal(receipt.execution.timeoutKind,null);
  assert.equal(receipt.requestOutcome,'RESPONDED');assert.equal(receipt.responseDisposition,'final');
  await assert.rejects(readCompletedAttempt(f),{code:'INVALID_JSON'});
});

test('cancellation before the terminal event keeps a late complete-looking body non-adoptable',async t=>{
  const controller=new AbortController();
  const f=await fixture(t,`process.on('SIGTERM',()=>{${complete}emit({type:'turn.completed'});process.exit(0);});
emit({type:'turn.started'});await writeFile(new URL('./ready',import.meta.url),'ready');setTimeout(()=>process.exit(0),4000);`,{signal:controller.signal,timeoutMs:3000,idleTimeoutMs:2500});
  await waitFor(()=>readFile(path.join(f.directory,'ready'),'utf8'),Boolean);controller.abort();
  const {error}=await f.completion,receipt=await f.receipt();
  assert.equal(error?.code,'ABORTED');assert.equal(error.requestOutcome,'UNKNOWN');
  assert.equal(receipt.responseDisposition,'incomplete');assert.equal(receipt.execution.terminalEvent,'turn.completed');
  assert.equal(receipt.localProcess.closeObserved,true);assert.equal(error.raw,'{"ok":true}');
  await assert.rejects(readCompletedAttempt(f),{code:'ATTEMPT_UNRESOLVED'});
});

test('cancellation after a complete terminal body does not adopt but keeps paid recovery',async t=>{
  const controller=new AbortController();
  const f=await fixture(t,`process.on('SIGTERM',()=>{});${complete}emit({type:'turn.completed'});setTimeout(()=>process.exit(0),4000);`,{signal:controller.signal,timeoutMs:3000,idleTimeoutMs:2500});
  await waitFor(f.receipt,r=>r?.execution?.eventCounts?.['turn.completed']);controller.abort();
  const {error}=await f.completion,receipt=await f.receipt();
  assert.equal(error?.code,'ABORTED');assert.equal(error.requestOutcome,'RESPONDED');
  assert.equal(receipt.responseDisposition,'final');assert.equal(receipt.localProcess.closeObserved,true);
  assert.deepEqual((await readCompletedAttempt(f)).output,{ok:true});
});

test('terminal settlement never fabricates close when detached inherited pipes stay open',async t=>{
  const f=await fixture(t,`import {spawn} from 'node:child_process';
const descendant=spawn(process.execPath,['-e','setTimeout(()=>process.exit(0),6000)'],{detached:true,stdio:['ignore',process.stdout,process.stderr]});
await writeFile(new URL('./descendant-pid',import.meta.url),String(descendant.pid));
${complete}emit({type:'turn.completed'});setTimeout(()=>process.exit(0),4000);`);
  let pid;t.after(()=>{if(pid)try{process.kill(pid,'SIGKILL');}catch{}});
  pid=Number(await waitFor(()=>readFile(path.join(f.directory,'descendant-pid'),'utf8'),Boolean));
  const {result,error}=await f.completion,receipt=await f.receipt();
  assert.equal(error,undefined);assert.deepEqual(result.output,{ok:true});
  assert.equal(receipt.localProcess.closeObserved,false);assert.equal(receipt.localProcess.exitedAt,null);assert.equal(receipt.localProcess.exitSignal,null);
  assert.deepEqual(receipt.localProcess.terminationRequests.map(r=>r.signal),['SIGTERM','SIGKILL']);
  assert.equal(receipt.execution.timeoutKind,null);assert.equal(receipt.usage.totalTokens,null);
});
