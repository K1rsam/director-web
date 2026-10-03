import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createCoordinator} from './coordinator.mjs';
import {createStore} from './core/store.mjs';
import {VERSION,PLAN_VERSION} from './core/shared.mjs';
import {publicRun} from './input.mjs';

const source={key:'failed-episode',sourceRows:[{id:'r1',text:'△甲推门。'},{id:'r2',text:'△乙点头。'}]};
const settings={maxUnits:null,fantasyMode:'off'};
const binding={projectId:'p',episodeId:'e',sourceVersion:'v1'};
const emotionContract={subject:'甲',contextTone:'紧张',audienceEffect:'担忧',change:'转机',landing:'释然',retain:['动作']};
const plan={schemaVersion:PLAN_VERSION,emotionArc:'由紧张到释然',entryFacts:[],workPackages:[1,2].map(i=>({id:`p${i}`,sourceRefs:[`r${i}`],emotionContract,dependsOn:[]})),provisionalUnits:[1,2].map(i=>({id:`u${i}`,packageId:`p${i}`,sourceRefs:[`r${i}`],secondsRange:[5,10]})),fantasyCandidates:[]};
const emptyUsage={inputTokens:null,cachedInputTokens:null,outputTokens:null,totalTokens:null};
const completed=output=>({output,raw:JSON.stringify(output),usage:{inputTokens:8,cachedInputTokens:0,outputTokens:2,totalTokens:10},requestOutcome:'RESPONDED'});
function draft(request){return {schemaVersion:VERSION,units:request.source.sourceRows.map(r=>({id:`u-${r.id}`,title:'动作',intent:{subject:'甲',change:'回应',landing:'释然',retain:['动作']},scene:'室内',props:[],participants:['甲','乙'],lighting:'柔光',initialState:'相望',exitState:'点头',shots:[{id:`s-${r.id}`,duration:5,camera:'近景',picture:r.text,lighting:'柔光',sound:'环境声',dialogueParts:[],transition:'切',sourceRefs:[r.id]}]})),fantasyRealization:[]};}
async function exitedProcess(){
 const startedAt=new Date().toISOString(),child=spawn(process.execPath,['-e','process.exit(1)'],{stdio:'ignore',detached:true});
 await once(child,'spawn');const [exitCode]=await once(child,'close');
 return {pid:child.pid,host:hostname(),startedAt,exitedAt:new Date().toISOString(),exitCode};
}
async function fixture(t,{budget,errorCode='CLI_FAILED',incomplete=false}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'v4-failed-resume-')),calls=[],localProcess=await exitedProcess();let failAuthor=true;
 const modelRunner=async(request,options)=>{
  calls.push({stage:request.stage,packageIds:request.packageIds});const folder=path.join(dir,'attempts',options.attemptId);await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'request.json'),JSON.stringify(request));
  if(request.stage==='author'&&request.packageIds[0]==='p2'&&failAuthor){
   const partial=incomplete?{raw:'{"units":[',responseDisposition:'incomplete'}:{};
   const error=Object.assign(new Error(errorCode==='TIMEOUT'?'等待模型响应超时':'CLI exited 1'),{code:errorCode,requestOutcome:'UNKNOWN',usage:emptyUsage,...partial});
   if(incomplete)await writeFile(path.join(folder,'raw.txt'),partial.raw);
   await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'UNKNOWN',errorCode,usage:emptyUsage,localProcess,...(incomplete?{responseDisposition:'incomplete'}:{})}));throw error;
  }
  const result=completed(request.stage==='plan'?plan:draft(request));await writeFile(path.join(folder,'raw.txt'),result.raw);await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:result.requestOutcome,usage:result.usage,errorCode:null}));return result;
 };
 const c=createCoordinator({dataRoot:dir,modelRunner,maxConcurrent:1}),store=createStore(dir),originalCreate=c.create.bind(c);
 // Lifecycle fixtures retain their saved v1 output contract; no real model is called.
 c.create=async options=>{const d=await originalCreate(options);return store.update(d.id,x=>{x.rulesSnapshot.outputSchemaVersion='structured-v1';delete x.rulesSnapshot.unitPackingPolicy;delete x.rulesSnapshot.unitDirectionVersion;return x;});};
 t.after(async()=>{await c.shutdown();await rm(dir,{recursive:true,force:true});});
 const created=await c.create({source,settings,binding,...(budget?{budget}:{})});
 for(let i=0;i<3;i++){await c.start(created.id,{mode:'next'});await c.wait(created.id);}
 const d=await c.read(created.id),op=d.operations.at(-1),folder=path.join(dir,'attempts',op.attemptId),receiptFile=path.join(folder,'receipt.json');
 assert.equal(op.error?.code,errorCode);assert.deepEqual(d.adopted.flatMap(a=>a.packageIds),['p1']);
 return {c,store,dir,d,op,folder,receiptFile,calls,localProcess,allowSuccess:()=>{failAuthor=false;}};
}

test('a final exited CLI failure can be explicitly acknowledged without a user stop or a model call',async t=>{
 const {c,d,op,calls,receiptFile}=await fixture(t),receiptBefore=await readFile(receiptFile,'utf8');
 const status=(await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId);
 assert.equal(status.canAcknowledge,true);assert.equal(status.kind,'failed');
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId}),{code:'UNKNOWN_USAGE_CONFIRMATION'});
 const accepted=await c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true});
 const acknowledged=accepted.operations.find(o=>o.attemptId===op.attemptId),{cancelAcknowledgement,...originalFields}=acknowledged;
 assert.deepEqual(originalFields,op);assert.equal(cancelAcknowledgement.kind,'failed');assert.equal(cancelAcknowledgement.acceptUnknownUsage,true);
 assert.deepEqual(accepted.plan,d.plan);assert.deepEqual(accepted.adopted,d.adopted);assert.equal(calls.length,3);assert.equal(await readFile(receiptFile,'utf8'),receiptBefore);
 const view=publicRun(accepted,{active:c.active(d.id),cancellations:await c.cancellationStatus(d.id)});
 assert.equal(view.status,'paused');assert.equal(view.active,false);assert.equal(view.operations.some(o=>o.status==='unknown'&&!o.cancelAcknowledgement?.acceptUnknownUsage),false);
 assert.equal(view.usage.complete,false);assert.equal(view.usage.unknownAttempts,1);assert.equal(view.usage.acknowledgedUnknownAttempts,1);assert.deepEqual(view.operations.at(-1).usage,emptyUsage);
 assert.equal(view.cancellations.find(s=>s.attemptId===op.attemptId).canAcknowledge,false);
});

test('only a later explicit start retries the missing author and keeps the plan and prior author',async t=>{
 const {c,d,op,calls,allowSuccess}=await fixture(t);
 await assert.rejects(c.start(d.id,{mode:'next'}),{code:'ATTEMPT_UNRESOLVED'});assert.equal(calls.length,3);
 await c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true});assert.equal(calls.length,3);
 allowSuccess();await c.start(d.id,{mode:'next'});const resumed=await c.wait(d.id);
 assert.equal(calls.length,4);assert.deepEqual(calls.at(-1),{stage:'author',packageIds:['p2']});
 assert.deepEqual(resumed.plan,d.plan);assert.deepEqual(resumed.adopted.find(a=>a.packageIds.includes('p1')),d.adopted[0]);
 assert.equal(resumed.operations.find(o=>o.attemptId===op.attemptId).status,'unknown');assert.equal(resumed.operations.length,4);
 assert.deepEqual(resumed.adopted.flatMap(a=>a.packageIds),['p1','p2']);
});

test('explicitly incomplete failed text is preserved but never repaired or adopted after acknowledgement',async t=>{
 const {c,d,op,calls,folder,receiptFile,allowSuccess}=await fixture(t,{incomplete:true});
 assert.equal(op.receipt.responseDisposition,'incomplete');
 const before=await readFile(receiptFile,'utf8'),raw=await readFile(path.join(folder,'raw.txt'),'utf8');
 const recovered=await c.recover(d.id,op.attemptId);
 assert.deepEqual(recovered.adopted,d.adopted);assert.equal(calls.length,3);
 const status=(await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId);
 assert.equal(status.canAcknowledge,true);assert.match(status.reason,/未完成片段/);
 const accepted=await c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true});
 assert.equal(calls.length,3);assert.equal(accepted.candidates.find(candidate=>candidate.attemptId===op.attemptId).raw,raw);
 assert.equal(await readFile(receiptFile,'utf8'),before);
 allowSuccess();await c.start(d.id,{mode:'next'});const resumed=await c.wait(d.id);
 assert.equal(calls.length,4);assert.deepEqual(calls.at(-1),{stage:'author',packageIds:['p2']});
 assert.deepEqual(resumed.plan,d.plan);assert.deepEqual(resumed.adopted.find(a=>a.packageIds.includes('p1')),d.adopted[0]);
 assert.deepEqual(resumed.adopted.flatMap(a=>a.packageIds),['p1','p2']);
 assert.equal(resumed.operations.find(o=>o.attemptId===op.attemptId).receipt.usage.totalTokens,null);
});

for(const [exitCode,exitSignal] of [[null,'SIGTERM'],[null,'SIGKILL'],[0,null]])test(`a failed terminal followed by observed ${exitSignal||'exit(0)'} cleanup has a zero-call acknowledgement`,async t=>{
 const {c,d,op,calls,receiptFile}=await fixture(t,{incomplete:true}),receipt=JSON.parse(await readFile(receiptFile,'utf8'));
 receipt.localProcess.exitCode=exitCode;receipt.localProcess.exitSignal=exitSignal;receipt.localProcess.closeObserved=true;
 receipt.execution={terminalEvent:'turn.failed'};await writeFile(receiptFile,JSON.stringify(receipt));
 assert.equal((await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId).canAcknowledge,true);
 await c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true});assert.equal(calls.length,3);
});

test('failed terminal acknowledgement still requires observed process close',async t=>{
 const {c,d,op,calls,receiptFile}=await fixture(t,{incomplete:true}),receipt=JSON.parse(await readFile(receiptFile,'utf8'));
 receipt.execution={terminalEvent:'turn.failed'};receipt.localProcess.closeObserved=false;
 await writeFile(receiptFile,JSON.stringify(receipt));
 assert.equal((await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId).canAcknowledge,false);
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true}),{code:'PROCESS_UNVERIFIED'});assert.equal(calls.length,3);
});

test('a no-body recovery keeps the original CLI error and does not retry',async t=>{
 const {c,d,op,calls}=await fixture(t);const recovered=await c.recover(d.id,op.attemptId);
 assert.equal(recovered.web.progress,'unknown');assert.deepEqual(recovered.web.error,d.web.error);assert.deepEqual(recovered.operations.at(-1).error,op.error);assert.equal(calls.length,3);
});

const invalidReceipts=[
 ['submitting',r=>{r.state='SUBMITTING';}],
 ['responded',r=>{r.requestOutcome='RESPONDED';}],
 ['different error',r=>{r.errorCode='TIMEOUT';}],
 ['missing process',r=>{delete r.localProcess;r.execution={phase:'failed',terminalEvent:null};}],
 ['foreign host',r=>{r.localProcess.host='unrelated-host';}],
 ['missing pid',r=>{delete r.localProcess.pid;}],
 ['invalid pid',r=>{r.localProcess.pid=-1;}],
 ['missing exit time',r=>{delete r.localProcess.exitedAt;}],
 ['invalid exit time',r=>{r.localProcess.exitedAt='not-a-date';}],
 ['unknown exit code',r=>{r.localProcess.exitCode=null;}],
 ['successful exit',r=>{r.localProcess.exitCode=0;}],
 ['live pid despite exited receipt',r=>{r.localProcess.pid=process.pid;}],
];
for(const [name,change] of invalidReceipts)test(`CLI failure acknowledgement rejects ${name}`,async t=>{
 const {c,d,op,calls,receiptFile}=await fixture(t),receipt=JSON.parse(await readFile(receiptFile,'utf8'));change(receipt);await writeFile(receiptFile,JSON.stringify(receipt));
 assert.equal((await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId).canAcknowledge,false);
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true}));
 assert.equal((await c.read(d.id)).operations.at(-1).cancelAcknowledgement,undefined);assert.equal(calls.length,3);
});

test('a surviving process group blocks acknowledgement even after its recorded leader exits',async t=>{
 const {c,d,op,localProcess,calls}=await fixture(t),kill=process.kill.bind(process);
 t.mock.method(process,'kill',(pid,signal)=>pid===-localProcess.pid?true:kill(pid,signal));
 assert.equal((await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId).canAcknowledge,false);
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true}));assert.equal(calls.length,3);
});

for(const body of ['raw.txt','event-final.txt','candidate','structured candidate'])test(`a saved ${body} must be recovered instead of acknowledged as absent`,async t=>{
 const {c,d,op,folder,store,calls}=await fixture(t);
 if(body.includes('candidate'))await store.update(d.id,x=>{x.candidates.push({id:'saved',attemptId:op.attemptId,stage:'author',packageIds:['p2'],...(body==='candidate'?{raw:'saved body'}:{output:{units:[]}}),status:'needs_repair'});return x;});
 else await writeFile(path.join(folder,body),'saved body');
 assert.equal((await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId).canAcknowledge,false);
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true}));assert.equal(calls.length,3);
});

test('a confirmed local TIMEOUT has its own acknowledgement without relabelling or retrying it',async t=>{
 const {c,d,op,calls,receiptFile}=await fixture(t,{errorCode:'TIMEOUT'}),receipt=JSON.parse(await readFile(receiptFile,'utf8'));
 receipt.localProcess.exitCode=null;receipt.localProcess.exitSignal='SIGTERM';receipt.localProcess.closeObserved=true;
 await writeFile(receiptFile,JSON.stringify(receipt));const receiptBefore=await readFile(receiptFile,'utf8');
 const status=(await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId);
 assert.equal(status.kind,'timeout');assert.equal(status.canAcknowledge,true);
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId}),{code:'UNKNOWN_USAGE_CONFIRMATION'});
 const accepted=await c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true});
 const {cancelAcknowledgement,...originalFields}=accepted.operations.at(-1);
 assert.deepEqual(originalFields,op);assert.equal(cancelAcknowledgement.kind,'timeout');assert.equal(accepted.web.progress,'paused');
 assert.deepEqual(accepted.plan,d.plan);assert.deepEqual(accepted.adopted,d.adopted);assert.equal(calls.length,3);
 assert.equal(await readFile(receiptFile,'utf8'),receiptBefore);assert.equal(publicRun(accepted).usage.complete,false);
});

test('legacy exited timeout receipts remain recoverable through an explicit acknowledgement then start',async t=>{
 const {c,d,op,calls,receiptFile,allowSuccess}=await fixture(t,{errorCode:'TIMEOUT'}),receipt=JSON.parse(await readFile(receiptFile,'utf8'));
 receipt.localProcess.exitCode=null;await writeFile(receiptFile,JSON.stringify(receipt));
 await assert.rejects(c.start(d.id),{code:'ATTEMPT_UNRESOLVED'});assert.equal(calls.length,3);
 const recovered=await c.recover(d.id,op.attemptId);assert.equal(recovered.web.error.code,'TIMEOUT');assert.equal(calls.length,3);
 await c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true});assert.equal(calls.length,3);
 allowSuccess();await c.start(d.id,{mode:'next'});const resumed=await c.wait(d.id);
 assert.equal(calls.length,4);assert.deepEqual(calls.at(-1),{stage:'author',packageIds:['p2']});
 assert.deepEqual(resumed.adopted.find(a=>a.packageIds.includes('p1')),d.adopted[0]);
 assert.equal(resumed.operations.find(o=>o.attemptId===op.attemptId).error.code,'TIMEOUT');
});

for(const [name,change] of [
 ['unfinalized receipt',r=>{r.state='SUBMITTING';}],
 ['mismatched error',r=>{r.errorCode='CLI_FAILED';}],
 ['missing process',r=>{delete r.localProcess;r.execution={phase:'failed',terminalEvent:null};}],
 ['foreign host',r=>{r.localProcess.host='other-host';}],
 ['unobserved process close',r=>{r.localProcess.closeObserved=false;}],
 ['missing exit time',r=>{r.localProcess.exitedAt=null;}],
 ['invalid pid',r=>{r.localProcess.pid=0;}],
 ['live process',r=>{r.localProcess.pid=process.pid;}],
])test(`timeout acknowledgement rejects ${name}`,async t=>{
 const {c,d,op,calls,receiptFile}=await fixture(t,{errorCode:'TIMEOUT'}),receipt=JSON.parse(await readFile(receiptFile,'utf8'));change(receipt);await writeFile(receiptFile,JSON.stringify(receipt));
 const status=(await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId);assert.equal(status.kind,'timeout');assert.equal(status.canAcknowledge,false);
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true}));assert.equal(calls.length,3);
});

for(const body of ['raw.txt','event-final.txt'])test(`timeout acknowledgement keeps saved ${body} for recovery first`,async t=>{
 const {c,d,op,calls,folder}=await fixture(t,{errorCode:'TIMEOUT'});await writeFile(path.join(folder,body),'saved model response');
 const status=(await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId);assert.equal(status.kind,'timeout');assert.equal(status.code,'RECOVER_RESPONSE_FIRST');
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true}));assert.equal(calls.length,3);
});

test('timeout acknowledgement also verifies the process group, not just its exited leader',async t=>{
 const {c,d,op,calls,localProcess}=await fixture(t,{errorCode:'TIMEOUT'}),kill=process.kill.bind(process);
 t.mock.method(process,'kill',(pid,signal)=>pid===-localProcess.pid?true:kill(pid,signal));
 assert.equal((await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId).canAcknowledge,false);
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true}));assert.equal(calls.length,3);
});

test('execution status reads only validated progress metadata and never modifies production records',async t=>{
 const {c,d,op,calls,receiptFile}=await fixture(t,{errorCode:'TIMEOUT'}),receipt=JSON.parse(await readFile(receiptFile,'utf8'));
 receipt.execution={phase:'waiting',startedAt:op.createdAt,lastEventAt:op.createdAt,lastProgressAt:null,eventCount:2,timeoutKind:'idle',limits:{startupMs:100,idleMs:200,totalMs:300,secret:'hidden'},workload:{stage:'author',promptChars:100,unitCount:9,raw:'hidden'},lastEventType:'turn.started',reasoning:'hidden'};
 receipt.diagnostics={stderr:'hidden'};await writeFile(receiptFile,JSON.stringify(receipt));
 const before=await readFile(receiptFile,'utf8'),view=await c.executionStatus(d.id),current=view.find(x=>x.attemptId===op.attemptId);
 assert.equal(current.execution.phase,'waiting');assert.equal(current.execution.lastProgressAt,null);assert.equal(current.execution.limits.totalMs,300);
 assert.equal(JSON.stringify(view).includes('hidden'),false);assert.equal(await readFile(receiptFile,'utf8'),before);assert.deepEqual(await c.read(d.id),d);assert.equal(calls.length,3);
});

test('missing or malformed legacy progress does not break status or invent generation activity',async t=>{
 const {c,d,op,receiptFile}=await fixture(t);assert.deepEqual(await c.executionStatus(d.id),[]);
 const receipt=JSON.parse(await readFile(receiptFile,'utf8'));receipt.execution={phase:'imagined',startedAt:'not-a-date'};
 await writeFile(receiptFile,JSON.stringify(receipt));assert.deepEqual(await c.executionStatus(d.id),[]);
 await writeFile(receiptFile,'{partial');assert.deepEqual(await c.executionStatus(d.id),[]);
 assert.equal((await c.read(d.id)).operations.find(x=>x.attemptId===op.attemptId).error.code,'CLI_FAILED');
});

test('status timestamps are normalized and malformed timestamp objects cannot break the page',async t=>{
 const {c,d,op,receiptFile}=await fixture(t),receipt=JSON.parse(await readFile(receiptFile,'utf8'));
 receipt.execution={phase:'waiting',startedAt:{toString:null,valueOf:null}};
 await writeFile(receiptFile,JSON.stringify(receipt));assert.deepEqual(await c.executionStatus(d.id),[]);
 receipt.execution={phase:'waiting',startedAt:'Wed, 30 Sep 2026 10:00:00 GMT (PRIVATE_DIAGNOSTIC_TEXT)',lastEventAt:'Wed, 30 Sep 2026 10:01:00 GMT (PRIVATE_DIAGNOSTIC_TEXT)'};
 await writeFile(receiptFile,JSON.stringify(receipt));const view=await c.executionStatus(d.id);
 assert.equal(view.find(x=>x.attemptId===op.attemptId).execution.startedAt,'2026-09-30T10:00:00.000Z');assert.doesNotMatch(JSON.stringify(view),/PRIVATE_DIAGNOSTIC_TEXT/);
});

for(const state of ['unobserved close','missing exit time','surviving group','foreign host','invalid pid'])test(`user-aborted requests also refuse acknowledgement with ${state}`,async t=>{
 const {c,d,op,store,calls,receiptFile,localProcess}=await fixture(t);await c.stop(d.id);
 await store.update(d.id,x=>{x.operations.at(-1).error.code='ABORTED';x.operations.at(-1).cancelReason='user_stop';return x;});
 const receipt=JSON.parse(await readFile(receiptFile,'utf8'));receipt.errorCode='ABORTED';
 if(state==='unobserved close')receipt.localProcess.closeObserved=false;
 if(state==='missing exit time')receipt.localProcess.exitedAt=null;
 if(state==='foreign host')receipt.localProcess.host='other-host';
 if(state==='invalid pid')receipt.localProcess.pid=-1;
 if(state==='surviving group'){const kill=process.kill.bind(process);t.mock.method(process,'kill',(pid,signal)=>pid===-localProcess.pid?true:kill(pid,signal));}
 await writeFile(receiptFile,JSON.stringify(receipt));assert.equal((await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId).canAcknowledge,false);
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true}));assert.equal(calls.length,3);
});

for(const target of ['current','sibling'])test(`a ${target} live operation blocks failed-attempt acknowledgement`,async t=>{
 const {c,d,op,store,calls}=await fixture(t),other=target==='current'?d:await c.create({source,settings,binding});
 await store.update(other.id,x=>{x.operations.push({...op,attemptId:'live-other',status:'running',error:null});return x;});
 assert.equal((await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId).canAcknowledge,false);
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true}));assert.equal(calls.length,3);
});

for(const target of ['current','sibling'])test(`a ${target} unknown operation with a live receipt process still blocks acknowledgement`,async t=>{
 const {c,d,op,dir,store,calls,localProcess}=await fixture(t),other=target==='current'?d:await c.create({source,settings,binding}),attemptId='unknown-live-process';
 await store.update(other.id,x=>{x.operations.push({...op,attemptId,status:'unknown',error:{code:'TIMEOUT',message:'unknown',requestOutcome:'UNKNOWN'}});return x;});
 const folder=path.join(dir,'attempts',attemptId);await mkdir(folder);await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'UNKNOWN',errorCode:'TIMEOUT',localProcess:{...localProcess,pid:process.pid}}));
 assert.equal((await c.cancellationStatus(d.id)).find(s=>s.attemptId===op.attemptId).canAcknowledge,false);
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true}));assert.equal(calls.length,3);
});

for(const target of ['current','sibling'])test(`acknowledging a CLI failure does not clear a ${target} unresolved attempt`,async t=>{
 const {c,d,op,store,calls}=await fixture(t),other=target==='current'?d:await c.create({source,settings,binding});
 await store.update(other.id,x=>{x.operations.push({...op,attemptId:'unknown-other',status:'unknown',error:{code:'TIMEOUT',message:'unknown',requestOutcome:'UNKNOWN'}});return x;});
 await c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true});
 assert.equal((await c.read(other.id)).operations.find(o=>o.attemptId==='unknown-other').cancelAcknowledgement,undefined);
 await assert.rejects(c.start(d.id,{mode:'next'}),{code:target==='current'?'ATTEMPT_UNRESOLVED':'EPISODE_UNRESOLVED'});assert.equal(calls.length,3);
});

test('acknowledgement is idempotent and never refunds the used call budget',async t=>{
 const {c,d,op,calls,allowSuccess}=await fixture(t,{budget:{maxCalls:3,maxTokens:300000}});
 const accepted=await c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true});
 const again=await c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true});
 assert.deepEqual(again.operations,accepted.operations);allowSuccess();await c.start(d.id,{mode:'next'});const limited=await c.wait(d.id);
 assert.equal(limited.web.progress,'budget_stop');assert.equal(calls.length,3);assert.deepEqual(limited.plan,d.plan);assert.deepEqual(limited.adopted,d.adopted);
});
