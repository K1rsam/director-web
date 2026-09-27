import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {hostname} from 'node:os';
import path from 'node:path';
import {digest} from './shared.mjs';
import {buildRunnerArgs, runModel,readCompletedAttempt} from './runner.mjs';
import {createStore} from './store.mjs';

async function fixture(t) {
  const directory=await mkdtemp(path.join(tmpdir(),'v4-runtime-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const script=path.join(directory,'fake.mjs');
  await writeFile(script,`import {writeFile,appendFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2), value=flag=>args[args.indexOf(flag)+1];
await appendFile(process.env.FAKE_CALLS,'1');
const prompt=await new Promise(resolve=>{let s='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>s+=x);process.stdin.on('end',()=>resolve(s));});
const instruction=JSON.parse(value('-c')==='unused'?'""':args.find(x=>x.startsWith('model_instructions_file='))?.slice(24)||'""');
if(process.env.FAKE_MODE==='hang') {setInterval(()=>{},1000);}
else if(process.env.FAKE_MODE==='descendant') {
  const child=spawn(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'});
  await writeFile(process.env.FAKE_CHILD_PID,String(child.pid));
  process.on('SIGTERM',()=>process.exit(0));
  setInterval(()=>{},1000);
}
else {
  const raw=process.env.FAKE_MODE==='bad'?'not json':process.env.FAKE_MODE==='repair'?String.fromCharCode(96).repeat(3)+'json\\n'+JSON.stringify({line:'say ,} and go'}).replace(/}$/,',}')+'\\n'+String.fromCharCode(96).repeat(3):JSON.stringify({prompt,instruction:await readFile(instruction,'utf8'),model:value('--model'),reasoning:args.find(x=>x.startsWith('model_reasoning_effort=')),cwd:value('--cd'),hasSchema:args.includes('--output-schema')});
  if(process.env.FAKE_MODE==='blank'){await writeFile(value('-o'),'   ');process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:raw}})+'\\n');}
  else await writeFile(value('-o'),raw);
  process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:11,cached_input_tokens:3,output_tokens:7}})+'\\n');
  if(process.env.FAKE_MODE==='conflict')process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:99,output_tokens:99}})+'\\n');
}
`);
  return {directory,script,calls:path.join(directory,'calls')};
}
const request={prompt:'镜头正文',instructions:'只执行本次指令',settings:{model:'gpt-6-sol',reasoning:'medium'},inputHash:'input',promptHash:digest('镜头正文')};

test('runner args preserve selected model and effort and isolation',()=>{
  const args=buildRunnerArgs({model:'gpt-6-astra',reasoning:'high',cwd:'/empty',outputPath:'/raw',instructionsPath:'/instructions'});
  assert.equal(args[args.indexOf('--model')+1],'gpt-6-astra');
  assert.ok(args.includes('model_reasoning_effort="high"'));
  assert.ok(args.includes('--ignore-user-config'));
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('--ephemeral'));
  assert.equal(args[args.indexOf('--cd')+1],'/empty');
  assert.throws(()=>buildRunnerArgs({model:'gpt-6-astra',reasoning:'extreme',cwd:'/x',outputPath:'/o',instructionsPath:'/i'}));
});

test('runner saves request and paid raw, returns usage, never resends same attempt',async t=>{
  const f=await fixture(t), options={directory:f.directory,attemptId:'a1',executable:process.execPath,executableArgs:[f.script]};
  const prev=process.env.FAKE_CALLS;process.env.FAKE_CALLS=f.calls;
  t.after(()=>{if(prev===undefined)delete process.env.FAKE_CALLS;else process.env.FAKE_CALLS=prev;});
  const result=await runModel(request,options);
  assert.equal(result.requestOutcome,'RESPONDED');
  assert.equal(result.model,'gpt-6-sol');
  assert.equal(result.reasoning,'medium');
  assert.equal(result.usage.totalTokens,18);
  assert.equal(result.output.prompt,'镜头正文');
  assert.equal(result.output.instruction,'只执行本次指令');
  assert.equal(result.output.hasSchema,false);
  assert.notEqual(result.output.cwd,f.directory);
  assert.equal((await readFile(path.join(f.directory,'attempts','a1','raw.txt'),'utf8')),result.raw);
  assert.deepEqual(JSON.parse(await readFile(path.join(f.directory,'attempts','a1','request.json'),'utf8')),request);
  const receipt=JSON.parse(await readFile(path.join(f.directory,'attempts','a1','receipt.json'),'utf8'));
  assert.equal(receipt.requestOutcome,'RESPONDED');
  assert.equal(receipt.usage.totalTokens,18);
  assert.equal(receipt.model,'gpt-6-sol');
  assert.equal(receipt.reasoning,'medium');
  await assert.rejects(runModel(request,options),error=>error.code==='ATTEMPT_EXISTS'&&error.requestOutcome==='RESPONDED');
  await assert.rejects(runModel({...request,inputHash:'different'},options),error=>error.code==='ATTEMPT_CONFLICT');
  assert.equal(await readFile(f.calls,'utf8'),'1');
});

test('runner validates prompt digest and treats null schema as absent',async t=>{
  const f=await fixture(t),prev=process.env.FAKE_CALLS;process.env.FAKE_CALLS=f.calls;
  t.after(()=>{if(prev===undefined)delete process.env.FAKE_CALLS;else process.env.FAKE_CALLS=prev;});
  await assert.rejects(runModel({...request,prompt:'changed'}, {directory:f.directory,attemptId:'wrong',executable:process.execPath,executableArgs:[f.script]}),error=>error.code==='PROMPT_HASH_MISMATCH'&&error.requestOutcome==='NOT_SENT');
  const result=await runModel({...request,schema:null},{directory:f.directory,attemptId:'null-schema',executable:process.execPath,executableArgs:[f.script]});
  assert.equal(result.output.hasSchema,false);
  assert.equal(await readFile(f.calls,'utf8'),'1');
});

test('blank output file keeps event text; conflicting usage is unknown',async t=>{
  const f=await fixture(t),prevCalls=process.env.FAKE_CALLS,prevMode=process.env.FAKE_MODE;
  process.env.FAKE_CALLS=f.calls;process.env.FAKE_MODE='blank';
  t.after(()=>{if(prevCalls===undefined)delete process.env.FAKE_CALLS;else process.env.FAKE_CALLS=prevCalls;if(prevMode===undefined)delete process.env.FAKE_MODE;else process.env.FAKE_MODE=prevMode;});
  const result=await runModel(request,{directory:f.directory,attemptId:'blank',executable:process.execPath,executableArgs:[f.script]});
  assert.equal(result.output.prompt,request.prompt);
  assert.equal(await readFile(path.join(f.directory,'attempts','blank','raw.txt'),'utf8'),'   ');
  assert.equal(await readFile(path.join(f.directory,'attempts','blank','event-final.txt'),'utf8'),result.raw);
  process.env.FAKE_MODE='conflict';
  const conflict=await runModel(request,{directory:f.directory,attemptId:'conflict',executable:process.execPath,executableArgs:[f.script]});
  assert.equal(conflict.usage.totalTokens,null);
});

test('completed attempt restores event final when raw file is blank without rewriting original files',async t=>{
  const f=await fixture(t),attempt=path.join(f.directory,'attempts','resume');
  await mkdir(attempt,{recursive:true});
  const raw='   ',event='```json\n{"line":"说 ,} 不删",}\n```';
  await writeFile(path.join(attempt,'raw.txt'),raw);
  await writeFile(path.join(attempt,'event-final.txt'),event);
  await writeFile(path.join(attempt,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED',usage:{inputTokens:3,outputTokens:2,totalTokens:5}}));
  const result=await readCompletedAttempt({directory:f.directory,attemptId:'resume'});
  assert.equal(result.output.line,'说 ,} 不删');
  assert.equal(result.raw,event);
  assert.equal(result.usage.totalTokens,5);
  assert.equal(await readFile(path.join(attempt,'raw.txt'),'utf8'),raw);
});

test('unfinished or invalid paid attempt cannot be restored as completed',async t=>{
  const f=await fixture(t),attempt=path.join(f.directory,'attempts','pending');
  await mkdir(attempt,{recursive:true});
  await writeFile(path.join(attempt,'raw.txt'),'not json');
  await writeFile(path.join(attempt,'receipt.json'),JSON.stringify({state:'SUBMITTING',requestOutcome:'UNKNOWN'}));
  await assert.rejects(readCompletedAttempt({directory:f.directory,attemptId:'pending'}),error=>error.code==='ATTEMPT_UNRESOLVED');
  await writeFile(path.join(attempt,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED'}));
  await assert.rejects(readCompletedAttempt({directory:f.directory,attemptId:'pending'}),error=>error.code==='INVALID_JSON'&&error.raw==='not json');
  await assert.rejects(readCompletedAttempt({directory:f.directory,attemptId:'../pending'}),error=>error.code==='INVALID_ATTEMPT');
});

test('bad JSON retains raw and reports responded',async t=>{
  const f=await fixture(t), prevCalls=process.env.FAKE_CALLS,prevMode=process.env.FAKE_MODE;
  process.env.FAKE_CALLS=f.calls;process.env.FAKE_MODE='bad';
  t.after(()=>{if(prevCalls===undefined)delete process.env.FAKE_CALLS;else process.env.FAKE_CALLS=prevCalls;if(prevMode===undefined)delete process.env.FAKE_MODE;else process.env.FAKE_MODE=prevMode;});
  await assert.rejects(runModel(request,{directory:f.directory,attemptId:'bad',executable:process.execPath,executableArgs:[f.script]}),error=>error.requestOutcome==='RESPONDED'&&error.raw==='not json'&&error.usage.totalTokens===18);
  assert.equal(await readFile(path.join(f.directory,'attempts','bad','raw.txt'),'utf8'),'not json');
});

test('repairing fenced trailing comma changes parse view only',async t=>{
  const f=await fixture(t),prevCalls=process.env.FAKE_CALLS,prevMode=process.env.FAKE_MODE;
  process.env.FAKE_CALLS=f.calls;process.env.FAKE_MODE='repair';
  t.after(()=>{if(prevCalls===undefined)delete process.env.FAKE_CALLS;else process.env.FAKE_CALLS=prevCalls;if(prevMode===undefined)delete process.env.FAKE_MODE;else process.env.FAKE_MODE=prevMode;});
  const result=await runModel(request,{directory:f.directory,attemptId:'repair',executable:process.execPath,executableArgs:[f.script]});
  assert.equal(result.output.line,'say ,} and go');
  assert.ok(result.raw.includes('say ,}'));
});

test('pre-abort is NOT_SENT and started timeout is UNKNOWN',async t=>{
  const f=await fixture(t),prevCalls=process.env.FAKE_CALLS,prevMode=process.env.FAKE_MODE;
  process.env.FAKE_CALLS=f.calls;process.env.FAKE_MODE='hang';
  t.after(()=>{if(prevCalls===undefined)delete process.env.FAKE_CALLS;else process.env.FAKE_CALLS=prevCalls;if(prevMode===undefined)delete process.env.FAKE_MODE;else process.env.FAKE_MODE=prevMode;});
  const abort=new AbortController();abort.abort();
  await assert.rejects(runModel(request,{directory:f.directory,attemptId:'pre',signal:abort.signal,executable:process.execPath,executableArgs:[f.script]}),error=>error.requestOutcome==='NOT_SENT');
  await assert.rejects(runModel(request,{directory:f.directory,attemptId:'hung',timeoutMs:100,executable:process.execPath,executableArgs:[f.script]}),error=>error.requestOutcome==='UNKNOWN');
  assert.equal((await readFile(f.calls,'utf8')).length,1);
  const receipt=JSON.parse(await readFile(path.join(f.directory,'attempts','hung','receipt.json'),'utf8'));
  assert.equal(receipt.requestOutcome,'UNKNOWN');
});

test('pause during preparation withdraws the unsent request and retains a truthful final receipt',async t=>{
  const f=await fixture(t),prevCalls=process.env.FAKE_CALLS;process.env.FAKE_CALLS=f.calls;
  t.after(()=>{if(prevCalls===undefined)delete process.env.FAKE_CALLS;else process.env.FAKE_CALLS=prevCalls;});
  await assert.rejects(runModel(request,{directory:f.directory,attemptId:'paused-before-dispatch',shouldDispatch:()=>false,executable:process.execPath,executableArgs:[f.script]}),error=>error.code==='PAUSED'&&error.requestOutcome==='NOT_SENT');
  const receipt=JSON.parse(await readFile(path.join(f.directory,'attempts','paused-before-dispatch','receipt.json'),'utf8'));
  assert.equal(receipt.state,'FINAL');assert.equal(receipt.requestOutcome,'NOT_SENT');assert.equal(receipt.usage.totalTokens,null);assert.equal(receipt.localProcess,null);
  await assert.rejects(readFile(f.calls,'utf8'),{code:'ENOENT'});
});

test('timeout kills TERM-ignoring descendant after parent closes',async t=>{
  const f=await fixture(t),prevCalls=process.env.FAKE_CALLS,prevMode=process.env.FAKE_MODE,prevPid=process.env.FAKE_CHILD_PID;
  process.env.FAKE_CALLS=f.calls;process.env.FAKE_MODE='descendant';process.env.FAKE_CHILD_PID=path.join(f.directory,'child-pid');
  t.after(()=>{if(prevCalls===undefined)delete process.env.FAKE_CALLS;else process.env.FAKE_CALLS=prevCalls;if(prevMode===undefined)delete process.env.FAKE_MODE;else process.env.FAKE_MODE=prevMode;if(prevPid===undefined)delete process.env.FAKE_CHILD_PID;else process.env.FAKE_CHILD_PID=prevPid;});
  await assert.rejects(runModel(request,{directory:f.directory,attemptId:'descendant',timeoutMs:200,executable:process.execPath,executableArgs:[f.script]}),error=>error.requestOutcome==='UNKNOWN');
  const pid=Number(await readFile(process.env.FAKE_CHILD_PID,'utf8'));
  t.after(()=>{try{process.kill(pid,'SIGKILL');}catch{}});
  let alive=true;
  for(let i=0;i<20;i++){
    try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH'){alive=false;break;}throw error;}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  assert.equal(alive,false);
});

test('store serializes concurrent updates and rereads across instances',async t=>{
  const f=await fixture(t),a=createStore(f.directory),b=createStore(f.directory);
  await a.create('task-1',{count:0,nested:{keep:true}});
  const results=await Promise.allSettled([a.update('task-1',d=>({...d,count:d.count+1})),b.update('task-1',d=>({...d,count:d.count+1}))]);
  assert.equal(results.filter(x=>x.status==='fulfilled').length,2);
  assert.deepEqual(await createStore(f.directory).read('task-1'),{count:2,nested:{keep:true}});
});

test('store rejects unsafe ids and failed or async mutators leave complete prior document',async t=>{
  const f=await fixture(t),store=createStore(f.directory);
  await assert.rejects(store.create('../bad',{}));
  await store.create('safe',{value:1});
  await assert.rejects(store.update('safe',d=>{d.value=2;throw Error('no');}));
  await assert.rejects(store.update('safe',async d=>({...d,value:3})));
  await assert.rejects(store.update('safe',()=>null));
  assert.deepEqual(await store.read('safe'),{value:1});
});

test('store recovers only a verified dead-owner lock and handles different ids independently',async t=>{
  const f=await fixture(t),store=createStore(f.directory);
  await Promise.all([store.create('one',{n:1}),store.create('two',{n:2})]);
  const lock=path.join(f.directory,'documents','one.lock');
  await writeFile(lock,JSON.stringify({pid:process.pid,token:'live',host:hostname()}));
  await assert.rejects(store.recoverStaleLock('one'),error=>error.code==='BUSY');
  await writeFile(lock,'{}');
  await assert.rejects(store.recoverStaleLock('one'),error=>error.code==='UNKNOWN_LOCK');
  await writeFile(lock,JSON.stringify({pid:99999999,token:'dead',host:hostname()}));
  const recovered=await store.recoverStaleLock('one');
  assert.equal(recovered.recovered,true);
  assert.deepEqual(await store.update('one',d=>({...d,n:3})),{n:3});
  assert.deepEqual(await store.read('two'),{n:2});
});
