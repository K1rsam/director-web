import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {runModel,readCompletedAttempt} from './runner.mjs';
import {digest} from './shared.mjs';

const request={stage:'author',prompt:'仅用于本地回归的请求',instructions:'输出JSON',settings:{model:'gpt-6.1-sol',reasoning:'medium'},inputHash:'diagnostic-fixture',promptHash:digest('仅用于本地回归的请求')};
async function runFixture(t,body){
  const directory=await mkdtemp(path.join(tmpdir(),'v4-cli-diagnostic-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const script=path.join(directory,'fake-cli.mjs');
  await writeFile(script,`import fs from 'node:fs';\nprocess.stdin.resume();\nawait new Promise(resolve=>process.stdin.on('end',resolve));\n${body}`);
  let result,error;
  try{result=await runModel(request,{directory,attemptId:'diagnostic',executable:process.execPath,executableArgs:[script]});}catch(e){error=e;}
  const receipt=JSON.parse(await readFile(path.join(directory,'attempts/diagnostic/receipt.json'),'utf8'));
  return {directory,result,error,receipt};
}

test('CLI error events survive process exit with the specific reason and unknown usage',async t=>{
  const f=await runFixture(t,`
process.stderr.write('warning: optional integration unavailable\\n');
process.stdout.write(JSON.stringify({type:'error',message:'Reconnecting after stream interruption'})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'Stream disconnected before completion: connection reset'}}));
process.exitCode=1;`);
  assert.equal(f.error?.code,'CLI_FAILED');
  assert.match(f.error.message,/Stream disconnected before completion: connection reset/);
  assert.doesNotMatch(f.error.message,/optional integration/,'structured terminal reason takes precedence over startup warning');
  assert.equal(f.error.requestOutcome,'UNKNOWN');
  assert.equal(f.receipt.state,'FINAL');
  assert.equal(f.receipt.requestOutcome,'UNKNOWN');
  assert.equal(f.receipt.usage.totalTokens,null);
  assert.match(f.receipt.errorMessage,/connection reset/);
  assert.equal(f.receipt.diagnostics.events.at(-1).type,'turn.failed');
  assert.equal(f.receipt.localProcess.exitCode,1);
  assert.ok(f.receipt.localProcess.exitedAt);
  await assert.rejects(readCompletedAttempt({directory:f.directory,attemptId:'diagnostic'}),{code:'ATTEMPT_UNRESOLVED'});
});

test('stderr fallback is bounded and credentials never enter the saved error diagnostics',async t=>{
  const f=await runFixture(t,`
process.stderr.write('WARNING '.repeat(1000)+'\\n');
process.stderr.write('Authorization: Bear');
process.stderr.write('er fake-auth-secret\\nCookie: session=fake-cookie-secret\\n');
process.stderr.write('api_key="fake-key-secret" refresh_token=fake-refresh-secret\\n');
process.stderr.write('https://demo:fake-password@example.invalid/v1?token=fake-query-secret&x=1\\n');
process.stderr.write('sk-fake-long-secret-token eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlIn0.signature\\n');
process.stderr.write('ERROR: 网络连接被重置，未收到最终结果\\n');
process.exitCode=1;`);
  assert.match(f.error.message,/网络连接被重置/);
  assert.match(f.receipt.errorMessage,/网络连接被重置/);
  assert.equal(f.receipt.requestOutcome,'UNKNOWN');
  const saved=JSON.stringify({error:f.error.message,diagnostics:f.receipt.diagnostics,errorMessage:f.receipt.errorMessage});
  for(const secret of ['fake-auth-secret','fake-cookie-secret','fake-key-secret','fake-refresh-secret','fake-password','fake-query-secret','sk-fake-long-secret-token','eyJhbGciOiJub25lIn0.eyJzdWIiOiJmYWtlIn0.signature'])assert.ok(!saved.includes(secret),`must redact ${secret}`);
  assert.ok(f.receipt.diagnostics.stderr.length<=4000);
  assert.ok(f.error.message.length<=2300);
});

test('non-error stdout is not copied into diagnostics and a successful final still recovers',async t=>{
  const f=await runFixture(t,`
process.stdout.write(JSON.stringify({type:'thread.started',thread_id:'fixture'})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'PRIVATE_REASONING_NOT_DIAGNOSTICS'}})+'\\n');
process.stdout.write(JSON.stringify({type:'error',message:'Transient retry recovered'})+'\\n');
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:2,cached_input_tokens:1}})+'\\n');`);
  assert.equal(f.error,undefined);
  assert.deepEqual(f.result.output,{ok:true});
  assert.equal(f.receipt.requestOutcome,'RESPONDED');
  assert.equal(f.receipt.errorMessage,null);
  assert.equal(f.receipt.usage.totalTokens,5);
  assert.ok(!JSON.stringify(f.receipt).includes('PRIVATE_REASONING_NOT_DIAGNOSTICS'));
  assert.deepEqual((await readCompletedAttempt({directory:f.directory,attemptId:'diagnostic'})).output,{ok:true});
});

test('error details do not discard a paid body when CLI exits unsuccessfully',async t=>{
  const f=await runFixture(t,`
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}})+'\\n');
process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'Final local shutdown failed'}})+'\\n');
process.exitCode=1;`);
  assert.equal(f.error?.code,'CLI_FAILED');
  assert.match(f.error.message,/Final local shutdown failed/);
  assert.equal(f.error.requestOutcome,'RESPONDED');
  assert.equal(f.receipt.requestOutcome,'RESPONDED');
  assert.equal(f.receipt.usage.totalTokens,5);
  assert.deepEqual((await readCompletedAttempt({directory:f.directory,attemptId:'diagnostic'})).output,{ok:true});
});
