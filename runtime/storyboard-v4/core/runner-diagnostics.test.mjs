import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,open,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as runner from './runner.mjs';
import {createAttemptDiagnostics} from './attempt-diagnostics.mjs';
import {digest} from './shared.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const nativeTimeout=globalThis.setTimeout;
const delay=ms=>new Promise(resolve=>nativeTimeout(resolve,ms));
const request=stage=>({stage,prompt:'PRIVATE_PROMPT',instructions:'PRIVATE_INSTRUCTIONS',settings:{model:'gpt-6.1-sol',reasoning:'medium'},inputHash:'input',promptHash:digest('PRIVATE_PROMPT')});
const keys=['PLAN','AUTHOR','FINISH'].map(stage=>`DIRECTOR_STORYBOARD_${stage}_TIMEOUT_MS`);
function env(t,values={}){
  const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
  for(const key of keys){if(values[key]===undefined)delete process.env[key];else process.env[key]=String(values[key]);}
  t.after(()=>{for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}});
}
async function fixture(t,body='await writeFile(output,JSON.stringify({ok:true}));'){
  const directory=await mkdtemp(path.join(tmpdir(),'v4-diagnostics-test-')),script=path.join(directory,'fake.mjs');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  await writeFile(script,`import {writeFile,access} from 'node:fs/promises';
const args=process.argv.slice(2),output=args[args.indexOf('-o')+1];
await new Promise(resolve=>{process.stdin.resume();process.stdin.on('end',resolve);});
${body}`);
  return {directory,options:attemptId=>({directory,attemptId,executable:process.execPath,executableArgs:[script]}),file:(attemptId,name)=>path.join(directory,'attempts',attemptId,name)};
}
async function until(read){
  const stop=Date.now()+3000;
  while(Date.now()<stop){const result=await read();if(result)return result;await delay(10);}
  assert.fail('Timed out waiting for fake CLI evidence');
}
const readJSON=file=>readFile(file,'utf8').then(JSON.parse);
async function assertPrivateMetadata(file){
  const folder=path.dirname(file);
  if(process.platform!=='win32'){
    assert.equal((await stat(file)).mode&0o777,0o600);assert.equal((await stat(folder)).mode&0o777,0o700);return;
  }
  // Node's POSIX mode bits on Windows do not represent NTFS ACLs. Verify the
  // actual fixture ACL instead of pretending 0600/0700 enforce Windows access.
  const command=`$ErrorActionPreference='Stop';$paths=ConvertFrom-Json $env:DIRECTOR_TEST_PRIVATE_FILES;$broad=@('S-1-1-0','S-1-5-11','S-1-5-32-545');$mask=[Security.AccessControl.FileSystemRights]::ReadData -bor [Security.AccessControl.FileSystemRights]::WriteData -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership;$checks=@(foreach($p in $paths){$acl=if([IO.Directory]::Exists($p)){[IO.Directory]::GetAccessControl($p)}else{[IO.File]::GetAccessControl($p)};$rules=$acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]);$unsafe=@($rules|Where-Object{$_.AccessControlType -eq 'Allow' -and $broad -contains $_.IdentityReference.Value -and ($_.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ($_.FileSystemRights -band $mask) -ne 0});@{private=($unsafe.Count -eq 0)}});[Console]::Out.Write((ConvertTo-Json -InputObject $checks -Compress))`;
  const {stdout}=await promisify(execFile)(path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,timeout:3000,env:{...process.env,DIRECTOR_TEST_PRIVATE_FILES:JSON.stringify([file,folder])}});
  const checks=JSON.parse(stdout);assert.equal(checks.length,2);assert.ok(checks.every(item=>item.private),'native ACL must deny broad identities metadata read/write');
}

test('timeout policy has stage budgets above ten minutes and validates every override',()=>{
  assert.equal(typeof runner.readTimeoutPolicy,'function');
  assert.deepEqual(runner.readTimeoutPolicy({}),{plan:900000,author:1800000,finish:1200000});
  assert.deepEqual(runner.readTimeoutPolicy(Object.fromEntries(keys.map((key,i)=>[key,['1','3600000','1234'][i]]))),{plan:1,author:3600000,finish:1234});
  for(const key of keys)for(const value of ['0','-1','1.5','Infinity','NaN','',' ','3600001',true,null]){
    assert.throws(()=>runner.readTimeoutPolicy({[key]:value}),error=>error.code==='INVALID_TIMEOUT_POLICY');
  }
});

test('unconfigured dispatch records workload-aware totals and arms the startup deadline',async t=>{
  env(t);const f=await fixture(t),delays=[];
  t.mock.method(globalThis,'setTimeout',(fn,ms,...args)=>{delays.push(ms);return nativeTimeout(fn,ms,...args);});
  for(const stage of ['plan','author','finish']){
    delays.length=0;await runner.runModel(request(stage),f.options(stage));
    const expected=runner.resolveRunnerLimits(request(stage)),receipt=await readJSON(f.file(stage,'receipt.json'));
    assert.deepEqual(receipt.execution.limits,expected);assert.ok(delays.some(ms=>ms>0&&ms<=expected.startupMs));
    assert.equal((await runner.readAttemptDiagnostics({directory:f.directory,attemptId:stage})).timeoutMs,expected.totalMs);
  }
});

test('stage timeout is resolved at dispatch and an explicit short timeout still wins',async t=>{
  env(t,Object.fromEntries(keys.map((key,i)=>[key,[100,140,180][i]])));
  const f=await fixture(t,'setInterval(()=>{},1000);');
  for(const [stage,ms] of Object.entries({plan:100,author:140,finish:180})){
    await assert.rejects(runner.runModel(request(stage),f.options(stage)),{code:'TIMEOUT',requestOutcome:'UNKNOWN'});
    const d=await runner.readAttemptDiagnostics({directory:f.directory,attemptId:stage});
    assert.equal(d.timeoutMs,ms);assert.equal(d.failureCategory,'timeout');assert.ok(d.endedAt);
  }
  process.env[keys[1]]='700';
  await assert.rejects(runner.runModel(request('author'),{...f.options('override'),timeoutMs:60}),{code:'TIMEOUT'});
  assert.equal((await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'override'})).timeoutMs,60);
});

test('invalid policy and missing stage cannot dispatch; historical readers ignore live policy',async t=>{
  env(t,{[keys[0]]:'3600001'});const f=await fixture(t);
  await assert.rejects(runner.runModel(request('plan'),f.options('invalid-policy')),{code:'INVALID_TIMEOUT_POLICY',requestOutcome:'NOT_SENT'});
  assert.equal((await readJSON(f.file('invalid-policy','receipt.json'))).requestOutcome,'NOT_SENT');
  assert.equal(await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'legacy'}),null);
  await mkdir(path.dirname(f.file('legacy','receipt.json')),{recursive:true});
  await writeFile(f.file('legacy','receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED'}));
  await writeFile(f.file('legacy','raw.txt'),'{"ok":true}');
  assert.equal((await runner.readCompletedAttempt({directory:f.directory,attemptId:'legacy'})).output.ok,true);
  delete process.env[keys[0]];
  await assert.rejects(runner.runModel(request(undefined),f.options('no-stage')),{code:'INVALID_REQUEST',requestOutcome:'NOT_SENT'});
  await assert.rejects(runner.runModel(request('plan'),{...f.options('bad-override'),timeoutMs:3600001}),{code:'INVALID_TIMEOUT_POLICY',requestOutcome:'NOT_SENT'});
});

test('silent author survives ten minutes of virtual time without an inactivity cutoff',async t=>{
  env(t);const f=await fixture(t,`await writeFile(output+'.ready','ready');
while(true){try{await access(output+'.release');break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
await writeFile(output,'{"ok":true}');`);
  const abort=new AbortController();let settled=false;
  t.mock.timers.enable({apis:['setTimeout']});
  const pending=runner.runModel(request('author'),{...f.options('silent'),signal:abort.signal}).then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
  try{
    await until(()=>readFile(f.file('silent','raw.txt.ready'),'utf8').catch(()=>false));
    t.mock.timers.tick(600001);await delay(30);assert.equal(settled,false);
    const live=await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'silent'});
    assert.equal(live.endedAt,null);assert.equal(live.lastActivityAt,null);assert.equal(live.eventCount,0);
    await writeFile(f.file('silent','raw.txt.release'),'release');
    const result=await pending;assert.equal(result.error,undefined);assert.equal(result.value.output.ok,true);
  }finally{abort.abort();t.mock.timers.tick(1001);await pending;}
});

test('live diagnostics are atomic private metadata, bounded and redacted through final success',async t=>{
  env(t);const secret='PRIVATE_CREDENTIAL_REASONING_TOKEN_STREAM';
  const events=[{type:'thread.started',thread_id:secret},...Array.from({length:80},(_,i)=>({type:secret+i,message:secret})),...Array.from({length:40},()=>({type:'item.updated',item:{type:'reasoning',text:secret}})),{type:'turn.completed',usage:{input_tokens:5,output_tokens:2}}];
  const stdout=events.slice(0,-1).map(e=>JSON.stringify(e)+'\n').join(''),stderr='PRIVATE_STDERR_密钥';
  const f=await fixture(t,`process.stdout.write(${JSON.stringify(stdout)});process.stderr.write(${JSON.stringify(stderr)});
await writeFile(output+'.ready','ready');
while(true){try{await access(output+'.release');break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
await writeFile(output,'{"body":"PRIVATE_RAW"}');
process.stdout.write(${JSON.stringify(JSON.stringify(events.at(-1))+'\n')});`);
  const abort=new AbortController(),pending=runner.runModel(request('author'),{...f.options('metadata'),signal:abort.signal}).then(value=>({value}),error=>({error}));
  try{
    const live=await until(async()=>{const d=await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'metadata'});return d?.eventCount===events.length-1&&d.stderrBytes>0?d:null;});
    assert.equal(live.endedAt,null);assert.equal(live.eventCounts.unknown,80);assert.equal(live.stdoutBytes,Buffer.byteLength(stdout));assert.equal(live.stderrBytes,Buffer.byteLength(stderr));
    assert.equal(live.eventTail.length,32);assert.ok(live.lastActivityAt);
    assert.equal(JSON.stringify(live).includes('PRIVATE_'),false);
    assert.ok(live.eventTail.every(e=>Object.keys(e).sort().join(',')==='timestamp,type'));
    await assertPrivateMetadata(f.file('metadata','diagnostics.json'));
    assert.ok((await stat(f.file('metadata','diagnostics.json'))).size<16384);
    await writeFile(f.file('metadata','raw.txt.release'),'release');
    const result=await pending;assert.equal(result.error,undefined);assert.equal(result.value.usage.totalTokens,7);
    const final=await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'metadata'});
    assert.ok(final.endedAt);assert.equal(final.failureCategory,null);assert.equal(final.eventCount,events.length);
    assert.equal(await readFile(f.file('metadata','raw.txt'),'utf8'),'{"body":"PRIVATE_RAW"}');
    assert.equal((await readJSON(f.file('metadata','receipt.json'))).requestOutcome,'RESPONDED');
    assert.equal((await readdir(path.dirname(f.file('metadata','diagnostics.json')))).some(name=>name.endsWith('.tmp')),false);
  }finally{abort.abort();await pending;}
});

test('failure diagnostics preserve only classified structured errors and truthful final receipts',async t=>{
  env(t);
  for(const [id,body,code,category,outcome] of [
    ['rate',`process.stdout.write(JSON.stringify({type:'turn.failed',error:{code:'rate_limit_exceeded',message:'PRIVATE_FAILURE'}})+'\\n');process.exitCode=1;`,'CLI_FAILED','rate_limit','UNKNOWN'],
    ['auth',`process.stdout.write(JSON.stringify({type:'error',error:{code:'invalid_api_key',message:'PRIVATE_FAILURE'}})+'\\n');process.exitCode=1;`,'CLI_FAILED','auth','UNKNOWN'],
    ['network',`process.stdout.write(JSON.stringify({type:'turn.failed',error:{code:'connection_error',message:'PRIVATE_FAILURE'}})+'\\n');process.exitCode=1;`,'CLI_FAILED','network','UNKNOWN'],
    ['unknown',`process.stdout.write(JSON.stringify({type:'error',code:'PRIVATE_CODE',message:'PRIVATE_FAILURE'})+'\\n');process.exitCode=1;`,'CLI_FAILED','unknown','UNKNOWN'],
    ['bad',`await writeFile(output,'PRIVATE_BAD_JSON');`,'INVALID_JSON','invalid_json','RESPONDED'],
    ['empty','','EMPTY_RESPONSE','empty_response','UNKNOWN'],
    ['exit','process.exitCode=7;','CLI_FAILED','cli_failed','UNKNOWN']
  ]){
    const f=await fixture(t,body);
    await assert.rejects(runner.runModel(request('finish'),f.options(id)),{code,requestOutcome:outcome});
    const d=await runner.readAttemptDiagnostics({directory:f.directory,attemptId:id});
    assert.equal(d.failureCategory,category);assert.ok(d.endedAt);assert.equal(JSON.stringify(d).includes('PRIVATE_'),false);
    const receipt=await readJSON(f.file(id,'receipt.json'));
    assert.equal(receipt.errorCode,code);assert.equal(receipt.requestOutcome,outcome);assert.equal(receipt.usage.totalTokens,null);
    if(id==='bad')assert.equal(await readFile(f.file(id,'raw.txt'),'utf8'),'PRIVATE_BAD_JSON');
  }
});

test('spawn failure and cancellation both finalize diagnostics without inventing usage',async t=>{
  env(t);const f=await fixture(t,`await writeFile(output+'.ready','ready');setInterval(()=>{},1000);`);
  await assert.rejects(runner.runModel(request('plan'),{...f.options('spawn'),executable:path.join(f.directory,'missing-cli')}),{code:'ENOENT',requestOutcome:'NOT_SENT'});
  assert.equal((await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'spawn'})).failureCategory,'spawn_failed');
  const abort=new AbortController(),pending=runner.runModel(request('plan'),{...f.options('aborted'),signal:abort.signal});
  const rejected=assert.rejects(pending,{code:'ABORTED',requestOutcome:'UNKNOWN'});
  await until(()=>readFile(f.file('aborted','raw.txt.ready'),'utf8').catch(()=>false));abort.abort();await rejected;
  const d=await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'aborted'});
  assert.equal(d.failureCategory,'aborted');assert.ok(d.endedAt);
  assert.equal((await readJSON(f.file('aborted','receipt.json'))).usage.totalTokens,null);
});

test('prepared but unsent attempts finalize diagnostics with a safe failure category',async t=>{
  env(t);const f=await fixture(t);
  await assert.rejects(runner.runModel(request('plan'),{...f.options('paused'),shouldDispatch:()=>false}),{code:'PAUSED',requestOutcome:'NOT_SENT'});
  const paused=await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'paused'});
  assert.equal(paused?.failureCategory,'paused');assert.ok(paused.endedAt);assert.equal(paused.stdoutBytes,0);
});

test('unrecognized local errors cannot use object prototypes as diagnostic categories',async t=>{
  env(t);const f=await fixture(t);
  let checks=0;
  await assert.rejects(runner.runModel(request('plan'),{...f.options('unknown-code'),shouldDispatch:()=>{if(++checks===2)throw Object.assign(new Error('PRIVATE_FAILURE'),{code:'__proto__'});return true;}}),{code:'__proto__',requestOutcome:'NOT_SENT'});
  const unknown=await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'unknown-code'});
  assert.equal(unknown.failureCategory,'unknown');assert.equal(JSON.stringify(unknown).includes('PRIVATE_'),false);
});

test('a terminal structured failure remains final even when JSON follows or the CLI hangs',async t=>{
  env(t);
  for(const timedOut of [false,true]){
    const f=await fixture(t,`process.stdout.write(JSON.stringify({type:'turn.failed',error:{code:'rate_limit_exceeded',message:'PRIVATE_FAILURE'}})+'\\n');
${timedOut?'setInterval(()=>{},1000);':`await writeFile(output,'{"ok":true}');`}`);
    const options={...f.options('structured'),timeoutMs:150};
    await assert.rejects(runner.runModel(request('author'),options),{code:'CLI_FAILED',requestOutcome:'UNKNOWN'});
    assert.equal((await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'structured'})).failureCategory,'rate_limit');
  }
});

test('byte counts measure original stdout and stderr even for invalid UTF-8',async t=>{
  env(t);const f=await fixture(t,`process.stdout.write(Buffer.from([255,10]));process.stderr.write(Buffer.from([255]));await writeFile(output,'{"ok":true}');`);
  await runner.runModel(request('plan'),f.options('bytes'));
  const d=await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'bytes'});
  assert.equal(d.stdoutBytes,2);assert.equal(d.stderrBytes,1);assert.equal(d.eventCount,0);
});

test('slow diagnostics persistence coalesces updates instead of building a snapshot queue',async t=>{
  const snapshots=[],releases=[];
  const diagnostics=createAttemptDiagnostics({attemptId:'bounded',stage:'plan',timeoutMs:900000,persist:snapshot=>{
    snapshots.push(snapshot);return snapshots.length===1?Promise.resolve():new Promise(resolve=>releases.push(resolve));
  }});
  await diagnostics.start();t.mock.timers.enable({apis:['setTimeout']});
  for(let i=0;i<12;i++){diagnostics.activity('stdout',1);diagnostics.event({type:'item.updated'});t.mock.timers.tick(250);await delay(1);}
  let finished=false;const completion=diagnostics.finish().finally(()=>{finished=true;});
  for(let i=0;i<40&&!finished;i++){releases.shift()?.();await delay(1);}
  await completion;assert.ok(snapshots.length<=3,`expected at most initial/live/final snapshots, got ${snapshots.length}`);
  assert.equal(snapshots.at(-1).stdoutBytes,12);assert.equal(snapshots.at(-1).eventCount,12);assert.ok(snapshots.at(-1).endedAt);
});

test('live and final diagnostics write failure stays visible without losing raw or receipt',async t=>{
  env(t);
  for(const [attemptId,raw] of [['success','{"ok":true}'],['invalid','PRIVATE_BAD_JSON']]){
    const f=await fixture(t,`process.stdout.write(JSON.stringify({type:'thread.started'})+'\\n');await writeFile(output+'.ready','ready');
while(true){try{await access(output+'.release');break;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}
await writeFile(output,${JSON.stringify(raw)});`);
    const abort=new AbortController(),pending=runner.runModel(request('author'),{...f.options(attemptId),signal:abort.signal}).then(value=>({value}),error=>({error}));
    try{
      await until(()=>readFile(f.file(attemptId,'raw.txt.ready'),'utf8').catch(()=>false));
      await rm(f.file(attemptId,'diagnostics.json'));await mkdir(f.file(attemptId,'diagnostics.json'));
      await delay(300);await writeFile(f.file(attemptId,'raw.txt.release'),'release');
      const result=await pending,completion=result.value||result.error;
      assert.equal(completion.diagnosticsError,'DIAGNOSTICS_WRITE_FAILED');assert.equal(completion.requestOutcome,'RESPONDED');
      if(attemptId==='success')assert.equal(result.value.output.ok,true);else assert.equal(result.error.code,'INVALID_JSON');
      assert.equal(await readFile(f.file(attemptId,'raw.txt'),'utf8'),raw);
      const receipt=await readJSON(f.file(attemptId,'receipt.json'));
      assert.equal(receipt.state,'FINAL');assert.equal(receipt.requestOutcome,'RESPONDED');assert.equal(receipt.diagnosticsError,'DIAGNOSTICS_WRITE_FAILED');
      assert.equal((await readdir(path.dirname(f.file(attemptId,'receipt.json')))).some(name=>name.endsWith('.tmp')),false);
    }finally{abort.abort();await pending;}
  }
});

test('partial diagnostics writes clean only their private temporary files',async t=>{
  env(t);const f=await fixture(t),handle=await open(path.join(f.directory,'fake.mjs'),'r'),prototype=Object.getPrototypeOf(handle),write=prototype.writeFile;
  await handle.close();
  t.mock.method(prototype,'writeFile',async function(value,...args){
    let parsed;try{parsed=JSON.parse(value);}catch{}
    if(parsed?.version===1&&parsed?.attemptId==='write-failure'){
      await write.call(this,'{');throw Object.assign(new Error('PRIVATE_DISK_FAILURE'),{code:'EIO'});
    }
    return write.call(this,value,...args);
  });
  await assert.rejects(runner.runModel(request('plan'),f.options('write-failure')),{code:'DIAGNOSTICS_WRITE_FAILED',requestOutcome:'NOT_SENT'});
  assert.equal((await readdir(path.dirname(f.file('write-failure','receipt.json')))).some(name=>name.endsWith('.tmp')),false);
  assert.equal((await readJSON(f.file('write-failure','receipt.json'))).requestOutcome,'NOT_SENT');
  assert.deepEqual(await readJSON(f.file('write-failure','request.json')),request('plan'));
});

test('diagnostics reader rejects unsafe ids and corruption while projecting only safe fields',async t=>{
  env(t);const f=await fixture(t);assert.equal(typeof runner.readAttemptDiagnostics,'function');
  assert.equal(await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'missing'}),null);
  for(const attemptId of ['../escape','/absolute','',null])await assert.rejects(runner.readAttemptDiagnostics({directory:f.directory,attemptId}),{code:'INVALID_ATTEMPT'});
  await runner.runModel(request('plan'),f.options('safe'));
  const file=f.file('safe','diagnostics.json'),good=await readJSON(file);
  await writeFile(file,JSON.stringify({...good,prompt:'PRIVATE_UNEXPECTED_FIELD'}));
  assert.deepEqual(await runner.readAttemptDiagnostics({directory:f.directory,attemptId:'safe'}),good);
  for(const bad of ['{','null',' '.repeat(16385),JSON.stringify({...good,version:2}),JSON.stringify({...good,attemptId:'other'}),JSON.stringify({...good,stage:'PRIVATE_STAGE'}),JSON.stringify({...good,startedAt:'2026-02-30T00:00:00.000Z'}),JSON.stringify({...good,eventCount:-1}),JSON.stringify({...good,failureCategory:'PRIVATE_CODE'}),JSON.stringify({...good,eventTail:[{timestamp:good.startedAt,type:'PRIVATE_TYPE'}]})]){
    await writeFile(file,bad);await assert.rejects(runner.readAttemptDiagnostics({directory:f.directory,attemptId:'safe'}),{code:'DIAGNOSTICS_CORRUPT'});
  }
});

test('legacy TIMEOUT evidence checks old local process just like ABORTED',async t=>{
  const f=await fixture(t);
  for(const code of ['TIMEOUT','ABORTED']){
    await mkdir(path.dirname(f.file(code,'receipt.json')),{recursive:true});
    await writeFile(f.file(code,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'UNKNOWN',errorCode:code}));
    const evidence=await runner.readAttemptEvidence({directory:f.directory,attemptId:code});
    assert.equal(evidence.hasResponseBody,false);assert.notEqual(evidence.legacyProcessState,'not_checked');
  }
});
