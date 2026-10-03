import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir,hostname} from 'node:os';
import path from 'node:path';
import {createCoordinator} from './core/legacy-test-fixtures.mjs';
import {createStore} from './core/store.mjs';
import {VERSION,PLAN_VERSION} from './core/shared.mjs';
import {DELTA_VERSION} from './core/delta.mjs';

const source={key:'episode',sourceRows:[{id:'r1',text:'甲：第一句'},{id:'r2',text:'乙：第二句'},{id:'r3',text:'甲：第三句'}]};
const settings={maxUnits:null,fantasyMode:'off'};
const emotionContract={subject:'甲',contextTone:'紧张',audienceEffect:'担忧',change:'转机',landing:'释然',retain:['对话']};
const binding={projectId:'p',episodeId:'e',sourceVersion:'v1'};
const plan={schemaVersion:PLAN_VERSION,emotionArc:'由紧张到释然',entryFacts:[],workPackages:[
 {id:'p1',sourceRefs:['r1'],emotionContract,dependsOn:[]},
 {id:'p2',sourceRefs:['r2'],emotionContract,dependsOn:['p1']},
 {id:'p3',sourceRefs:['r3'],emotionContract,dependsOn:[]},
],provisionalUnits:[1,2,3].map(i=>({id:`u${i}`,packageId:`p${i}`,sourceRefs:[`r${i}`],secondsRange:[5,10]})),fantasyCandidates:[]};
function draft(request){
 const rows=request.source.sourceRows,dialogue=request.source.dialogue;
 return {schemaVersion:VERSION,units:rows.map((r,i)=>({id:`${request.stage}-${request.packageIds.join('-')}-${r.id}`,title:'对话',intent:{subject:'甲',change:'回应',landing:'释然',retain:['原话']},scene:'室内',props:[],participants:['甲','乙'],lighting:'柔光',initialState:'相望',exitState:'点头',shots:[{id:`s-${request.stage}-${request.packageIds.join('-')}-${r.id}`,duration:5,camera:'近景',picture:'人物说话',lighting:'柔光',sound:'人声',dialogueParts:dialogue.filter(q=>q.rowId===r.id).map(q=>({lineId:q.id,text:q.quote,presentation:'画内',delivery:'自然',voiceStart:0,voiceEnd:3})),transition:'切',sourceRefs:[r.id]}]})),fantasyRealization:[]};
}
async function fixture(fn,{runner}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'v4-coordinator-test-'));
 const calls=[];
 const authored=[];
 const modelRunner=runner||(async request=>{calls.push({stage:request.stage,ids:request.packageIds,mode:request.finishMode});const output=request.stage==='plan'?plan:request.finishMode==='delta'?{schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:authored.flatMap(x=>x.units.filter(u=>request.packageIds.some(id=>u.id.includes(id))).map(u=>u.id)),replacements:[],revisionNotes:[],unresolved:[]}:draft(request);if(request.stage==='author')authored.push(output);return {output,raw:JSON.stringify(output),usage:{totalTokens:100},requestOutcome:'RESPONDED'};});
 const coordinator=createCoordinator({dataRoot:dir,modelRunner});
 try{await fn({coordinator,calls,dir,modelRunner});}finally{await coordinator.shutdown();await rm(dir,{recursive:true,force:true});}
}
test('next dispatches one request and all respects dependencies, then assembles',async()=>fixture(async({coordinator,calls})=>{
 const d=await coordinator.create({source,settings,binding});
 await coordinator.start(d.id,{mode:'next'});await coordinator.wait(d.id);
 assert.deepEqual(calls.map(c=>c.stage),['plan']);
 await coordinator.start(d.id,{mode:'all'});await coordinator.wait(d.id);
 const final=await coordinator.read(d.id);
 assert.equal(final.status,'text_ready_for_review',JSON.stringify({web:final.web,operations:final.operations.map(o=>[o.stage,o.packageIds,o.status]),candidates:final.candidates.map(c=>[c.stage,c.packageIds,c.status,c.errors,c.validation?.errors]),adopted:final.adopted.map(a=>[a.stage,a.packageIds])}));
 assert.equal(calls.at(-1).mode,'delta',JSON.stringify(calls));
 assert.ok(calls.findIndex(c=>c.ids?.[0]==='p1')<calls.findIndex(c=>c.ids?.[0]==='p2'));
}));

test('call budget is checked before each serial package',async()=>fixture(async({coordinator,calls})=>{
 const d=await coordinator.create({source,settings,binding,budget:{maxCalls:2,maxTokens:300000}});
 await coordinator.start(d.id,{mode:'all'});await coordinator.wait(d.id);
 assert.equal(calls.length,2);
 assert.equal((await coordinator.read(d.id)).web.progress,'budget_stop');
}));

test('repeat start is idempotent and another run of the episode is excluded',async()=>fixture(async({coordinator,calls})=>{
 const first=await coordinator.create({source,settings,binding});
 const second=await coordinator.create({source,settings,binding});
 await coordinator.start(first.id,{mode:'all'});
 await coordinator.start(first.id,{mode:'all'});
 await assert.rejects(coordinator.start(second.id,{mode:'all'}),{code:'EPISODE_BUSY'});
 await coordinator.wait(first.id);
 assert.equal(calls.filter(c=>c.stage==='plan').length,1);
}));

test('unknown request is not retried on a new coordinator',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-restart-test-'));
 let calls=0;
 const runner=async()=>{calls++;throw Object.assign(new Error('uncertain'),{requestOutcome:'UNKNOWN',code:'TIMEOUT'});};
 const a=createCoordinator({dataRoot:dir,modelRunner:runner});
 try{
  const d=await a.create({source,settings,binding});await a.start(d.id,{mode:'all'});await a.wait(d.id);await a.shutdown();
  const b=createCoordinator({dataRoot:dir,modelRunner:runner});
  try{await assert.rejects(b.start(d.id,{mode:'all'}),{code:'ATTEMPT_UNRESOLVED'});assert.equal(calls,1);}finally{await b.shutdown();}
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('global model slots never exceed two across episodes',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-slots-test-'));let running=0,peak=0,release,arrived,timer;
 const gate=new Promise(resolve=>release=resolve),saturated=new Promise(resolve=>arrived=resolve);
 const runner=async request=>{running++;peak=Math.max(peak,running);if(running===2)arrived();await gate;running--;const output=request.stage==='plan'?plan:draft(request);return {output,raw:JSON.stringify(output),usage:{totalTokens:10},requestOutcome:'RESPONDED'};};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner,maxConcurrent:2});
 try{const docs=await Promise.all([1,2,3].map(i=>c.create({source,settings,binding:{...binding,episodeId:`e${i}`}})));
  await Promise.all(docs.map(d=>c.start(d.id,{mode:'next'})));
  await Promise.race([saturated,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('two independent runs did not fill the two available slots')),10000);})]);
  release();await Promise.all(docs.map(d=>c.wait(d.id)));
  assert.equal(peak,2);
 }finally{release();clearTimeout(timer);await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('source version check prevents dispatch',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-stale-test-'));let calls=0;
 const c=createCoordinator({dataRoot:dir,beforeExecute:async()=>false,modelRunner:async()=>{calls++;throw Error('unreachable');}});
 try{const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'all'});await c.wait(d.id);
  assert.equal(calls,0);assert.equal((await c.read(d.id)).web.progress,'source_stale');
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('successful response with unknown usage has an explicit zero-call acknowledgement',async()=>{
 let count=0;await fixture(async({coordinator:c})=>{
  const d=await c.create({source,settings,binding});await c.start(d.id);let saved=await c.wait(d.id);
  assert.equal(saved.plan.schemaVersion,PLAN_VERSION);assert.equal(saved.web.progress,'usage_review');assert.equal(count,1);
  const attemptId=saved.operations[0].attemptId,check=(await c.cancellationStatus(d.id))[0];
  assert.equal(check.kind,'usage');assert.equal(check.canAcknowledge,true);
  await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId}),{code:'UNKNOWN_USAGE_CONFIRMATION'});
  await c.acknowledgeCancelled(d.id,{attemptId,acceptUnknownUsage:true});saved=await c.read(d.id);
  assert.equal(count,1);assert.equal(saved.operations[0].receipt.usage,null);assert.equal(saved.operations[0].status,'completed');
  assert.equal(saved.operations[0].cancelAcknowledgement.kind,'usage');assert.notEqual(saved.web.progress,'usage_review');
  await c.start(d.id,{mode:'next'});await c.wait(d.id);assert.equal(count,2);
 },{runner:async request=>{count++;const output=request.stage==='plan'?plan:draft(request);return {output,raw:JSON.stringify(output),usage:count===1?null:{totalTokens:10},requestOutcome:'RESPONDED'};}});
});

test('unknown successful usage cannot be acknowledged before recorded cleanup is complete',async()=>fixture(async({coordinator:c,dir})=>{
 const d=await c.create({source,settings,binding});await c.start(d.id);const saved=await c.wait(d.id),attemptId=saved.operations[0].attemptId;
 const child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore'});await once(child,'close');
 const folder=path.join(dir,'attempts',attemptId);await mkdir(folder,{recursive:true});
 await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED',usage:null,localProcess:{pid:child.pid,host:hostname(),closeObserved:false}}));
 assert.equal((await c.cancellationStatus(d.id))[0].canAcknowledge,false);
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId,acceptUnknownUsage:true}),{code:'PROCESS_UNVERIFIED'});
},{runner:async()=>({output:plan,raw:JSON.stringify(plan),usage:null,requestOutcome:'RESPONDED'})}));

test('a returned invalid JSON body with unknown usage can be acknowledged then repaired without replay',async()=>{
 const calls=[];await fixture(async({coordinator:c})=>{
  const d=await c.create({source,settings,binding});await c.start(d.id);await c.wait(d.id);await c.start(d.id);const held=await c.wait(d.id);
  const attemptId=held.operations[0].attemptId;assert.equal(held.web.progress,'usage_review');assert.equal(calls.length,1);
  const check=(await c.cancellationStatus(d.id))[0];assert.equal(check?.kind,'usage');assert.equal(check.canAcknowledge,true);
  await c.acknowledgeCancelled(d.id,{attemptId,acceptUnknownUsage:true});const acknowledged=await c.read(d.id);
  assert.equal(calls.length,1);assert.equal(acknowledged.candidates[0].raw,'saved malformed body');assert.equal(acknowledged.candidates[0].status,'needs_repair');
  assert.equal(acknowledged.operations[0].error.code,'INVALID_JSON');assert.equal(acknowledged.operations[0].receipt.usage,null);
  await c.start(d.id,{mode:'next'});const repaired=await c.wait(d.id);
  assert.equal(calls.length,2);assert.equal(calls[1].stage,'plan');assert.equal(repaired.operations.at(-1).previousDraft.rawText,'saved malformed body');assert.match(calls[1].prompt,/saved malformed body/);assert.ok(repaired.plan);
 },{runner:async request=>{calls.push(request);if(calls.length===1)throw Object.assign(new Error('格式不合法'),{code:'INVALID_JSON',requestOutcome:'RESPONDED',raw:'saved malformed body',usage:null,responseDisposition:'final'});return {output:plan,raw:JSON.stringify(plan),usage:{totalTokens:10},requestOutcome:'RESPONDED'};}});
});

test('author repair stops when the same error returns without progress',async()=>{
 const calls=[];await fixture(async({coordinator:c})=>{
  const d=await c.create({source,settings,binding});await c.start(d.id);const result=await c.wait(d.id);
  assert.deepEqual(calls,['plan','author','finish']);assert.equal(result.web.error?.code,'REPAIR_NO_PROGRESS');
  await c.start(d.id);await c.wait(d.id);assert.equal(calls.length,3);
 },{runner:async request=>{calls.push(request.stage);const output=request.stage==='plan'?{...plan,workPackages:plan.workPackages.slice(0,1).map(w=>({...w,sourceRefs:['r1','r2','r3']})),provisionalUnits:[{...plan.provisionalUnits[0],sourceRefs:['r1','r2','r3']}]}:draft(request);if(request.stage!=='plan')output.units[0].shots[0].dialogueParts[0].text='篡改';return {output,raw:JSON.stringify(output),usage:{totalTokens:10},requestOutcome:'RESPONDED'};}});
});

test('blocked author repairs never consume repair allowance before a model call is sent',async()=>{
 const calls=[];await fixture(async({coordinator:c})=>{
  const d=await c.create({source,settings,binding});
  for(let i=0;i<3;i++){await c.start(d.id);const held=await c.wait(d.id);assert.equal(held.web.progress,'usage_review');assert.equal(held.web.autoRepairs,0);}
  assert.deepEqual(calls.map(r=>r.stage),['plan','author']);
  const author=(await c.read(d.id)).operations.at(-1);await c.acknowledgeCancelled(d.id,{attemptId:author.attemptId,acceptUnknownUsage:true});
  await c.start(d.id);const done=await c.wait(d.id);
  assert.deepEqual(calls.map(r=>r.stage),['plan','author','finish']);assert.equal(done.web.autoRepairs,1);assert.ok(done.assembly);
 },{runner:async request=>{calls.push(request);const output=request.stage==='plan'?{...plan,workPackages:plan.workPackages.slice(0,1).map(w=>({...w,sourceRefs:['r1','r2','r3']})),provisionalUnits:[{...plan.provisionalUnits[0],sourceRefs:['r1','r2','r3']}]}:request.stage==='author'?{schemaVersion:VERSION,units:[],fantasyRealization:[]}:draft(request);return {output,raw:JSON.stringify(output),usage:request.stage==='author'?null:{totalTokens:10},requestOutcome:'RESPONDED'};}});
});

for(const action of ['pause','stop','shutdown'])test(`${action} releases a hanging preflight and ignores its late success`,async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-preflight-cancel-'));let release,enteredResolve,calls=0;
 const pending=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{enteredResolve=resolve;});
 const c=createCoordinator({dataRoot:dir,beforeExecute:async()=>{enteredResolve();return pending;},modelRunner:async()=>{calls++;throw Error('must not dispatch');}});
 try{const d=await c.create({source,settings,binding});await c.start(d.id);await entered;
  const result=await Promise.race([(async()=>{await c[action](...(action==='shutdown'?[]:[d.id]));await c.wait(d.id);return 'settled';})(),new Promise(resolve=>setTimeout(()=>resolve('hung'),150))]);
  assert.equal(result,'settled');assert.equal(c.active(d.id),false);release(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
  if(action!=='shutdown')assert.equal((await c.read(d.id)).web.progress,action==='pause'?'paused':'stopped');
 }finally{release(true);await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('preflight deadline releases the run without sending a model request',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-preflight-deadline-'));let release,calls=0;
 const pending=new Promise(resolve=>{release=resolve;}),c=createCoordinator({dataRoot:dir,preflightTimeoutMs:30,beforeExecute:()=>pending,modelRunner:async()=>{calls++;throw Error('must not dispatch');}});
 try{const d=await c.create({source,settings,binding});await c.start(d.id);
  const result=await Promise.race([c.wait(d.id),new Promise(resolve=>setTimeout(()=>resolve(null),150))]);
  assert.equal(result?.web.error?.code,'PREFLIGHT_TIMEOUT');assert.equal(calls,0);assert.equal(c.active(d.id),false);
 }finally{release(true);await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

for(const action of ['pause','stop','shutdown'])test(`${action} during saved-plan recheck preserves its cancellation state`,async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-recheck-cancel-'));let release,enteredResolve,checks=0,calls=0;
 const pending=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{enteredResolve=resolve;});
 const c=createCoordinator({dataRoot:dir,beforeExecute:async()=>{if(++checks>1){enteredResolve();return pending;}return true;},modelRunner:async()=>{calls++;return {output:{},raw:'{}',usage:{totalTokens:10},requestOutcome:'RESPONDED'};}});
 try{const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await c.wait(d.id);
  await createStore(dir).update(d.id,x=>{x.candidates[0].validatorVersion='old';return x;});
  await c.start(d.id,{mode:'next'});await entered;await c[action](...(action==='shutdown'?[]:[d.id]));const result=await c.wait(d.id);
  assert.notEqual(result.web.progress,'failed');assert.notEqual(result.web.error?.code,'ABORTED');
  if(action!=='shutdown')assert.equal(result.web.progress,action==='pause'?'paused':'stopped');
  release(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 }finally{release(true);await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('all four selection modes are handled before authorship',async()=>fixture(async({coordinator,calls})=>{
 const d=await coordinator.create({source,settings,binding});await coordinator.start(d.id,{mode:'next'});await coordinator.wait(d.id);
 for(const mode of ['off','recommended','all','review']){
  await coordinator.choose(d.id,{mode,resetDrafts:true});await coordinator.start(d.id,{mode:'all'});await coordinator.wait(d.id);
  const current=await coordinator.read(d.id);
  assert.equal(current.web.progress,mode==='review'?'awaiting_confirmation':'text_ready_for_review');
  if(mode==='review'){
   const fingerprint=(await import('./core/selection.mjs')).selectionFingerprint(current.plan,current.choice);
   await coordinator.confirm(d.id,{selectedIds:[],expectedFingerprint:fingerprint,resetDrafts:true});
  }
 }
 assert.ok(calls.length>1);
}));

test('stop cancels active work and prevents its response from being adopted',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-stop-test-'));let entered;
 const started=new Promise(resolve=>entered=resolve);
 const runner=async(request,{signal})=>{entered();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'ABORTED',requestOutcome:'UNKNOWN'})),{once:true}));};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner});
 try{const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'all'});await started;await c.stop(d.id);await c.wait(d.id);
  const final=await c.read(d.id);assert.equal(final.web.stopped,true);assert.equal(final.web.progress,'stopped');assert.equal(final.adopted.length,0);
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('raising the call budget preserves paid attempts and resumes only missing work',async()=>fixture(async({coordinator,calls})=>{
 const d=await coordinator.create({source,settings,binding,budget:{maxCalls:1,maxTokens:300000}});
 await coordinator.start(d.id,{mode:'all'});await coordinator.wait(d.id);
 assert.equal(calls.length,1);
 await coordinator.setBudget(d.id,{maxCalls:32,maxTokens:300000});
 await coordinator.start(d.id,{mode:'all'});await coordinator.wait(d.id);
 const final=await coordinator.read(d.id);
 assert.equal(final.operations.filter(o=>o.stage==='plan').length,1);
 assert.equal(final.operations.length,calls.length);
 assert.equal(final.status,'text_ready_for_review');
}));

test('explicit local repair uses the paid draft and keeps the earlier candidate',async()=>fixture(async({coordinator,calls})=>{
 const d=await coordinator.create({source,settings,binding});
 await coordinator.start(d.id,{mode:'all'});await coordinator.wait(d.id);
 const before=await coordinator.read(d.id),candidateCount=before.candidates.length;
 await coordinator.repair(d.id,{packageIds:['p1'],notes:[{coordinate:'p1',change:'检查连续性'}]});
 await coordinator.wait(d.id);
 const after=await coordinator.read(d.id);
 assert.equal(calls.at(-1).mode,'delta');
 assert.deepEqual(calls.at(-1).ids,['p1']);
 assert.equal(after.candidates.length,candidateCount+1);
 assert.ok(after.candidates.some(c=>c.id===before.candidates.at(-1).id));
 assert.equal(after.status,'text_ready_for_review');
}));

test('switching mode clears earlier unit overrides',async()=>fixture(async({coordinator})=>{
 const d=await coordinator.create({source,settings,binding});await coordinator.start(d.id,{mode:'next'});await coordinator.wait(d.id);
 await coordinator.choose(d.id,{mode:'off',unitOverrides:{u1:true}});
 await coordinator.choose(d.id,{mode:'recommended'});
 assert.deepEqual((await coordinator.read(d.id)).choice.unitOverrides,{});
}));

test('NOT_SENT keeps the attempt record and can resume after budget edit',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-not-sent-test-'));let calls=0;
 const runner=async()=>{calls++;if(calls===1)throw Object.assign(new Error('not sent'),{code:'NOT_SENT',requestOutcome:'NOT_SENT'});return {output:plan,raw:JSON.stringify(plan),usage:{totalTokens:50},requestOutcome:'RESPONDED'};};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner});
 try{const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await c.wait(d.id);
  await c.setBudget(d.id,{maxCalls:32,maxTokens:300000});await c.start(d.id,{mode:'next'});await c.wait(d.id);
  const result=await c.read(d.id);assert.equal(calls,2);assert.equal(result.operations.length,2);assert.ok(result.plan);
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('recheck of a repair candidate creates a derived candidate without another model call',async()=>fixture(async({coordinator,calls,dir})=>{
 const d=await coordinator.create({source,settings,binding});
 await coordinator.start(d.id,{mode:'next'});await coordinator.wait(d.id);
 await coordinator.start(d.id,{mode:'next'});await coordinator.wait(d.id);
 const before=await coordinator.read(d.id),candidate=before.candidates.at(-1);
 await createStore(dir).update(d.id,document=>{document.candidates.find(item=>item.id===candidate.id).status='needs_repair';return document;});
 await coordinator.recheck(d.id,candidate.id);
 const after=await coordinator.read(d.id);
 assert.equal(calls.length,2);assert.equal(after.operations.length,2);
 assert.equal(after.candidates.at(-1).derivedFrom,candidate.id);
}));

test('mechanically invalid author response receives a bounded local finish',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-auto-repair-test-'));
 const calls=[],drafts=[];let invalid=true;
 const runner=async request=>{calls.push([request.stage,request.packageIds,request.finishMode]);let output;
  if(request.stage==='plan')output=plan;
  else if(request.stage==='author'&&request.packageIds[0]==='p1'&&invalid){invalid=false;output={schemaVersion:VERSION,units:[],fantasyRealization:[]};}
  else if(request.finishMode==='delta')output={schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:drafts.flatMap(x=>x.units.map(u=>u.id)),replacements:[],revisionNotes:[],unresolved:[]};
  else{output=draft(request);drafts.push(output);}
  return {output,raw:JSON.stringify(output),usage:{totalTokens:50},requestOutcome:'RESPONDED'};};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner});
 try{const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'all'});await c.wait(d.id);
  const result=await c.read(d.id);assert.equal(result.status,'text_ready_for_review');assert.equal(result.web.autoRepairs,1,JSON.stringify({calls,candidates:result.candidates.map(x=>[x.stage,x.packageIds,x.status,x.errors,x.validation?.errors])}));
  assert.ok(calls.some(([stage,ids,mode])=>stage==='finish'&&ids.length===1&&ids[0]==='p1'&&mode==='full'));
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('invalid choice or confirmation leaves adopted draft unchanged even with resetDrafts',async()=>fixture(async({coordinator})=>{
 const d=await coordinator.create({source,settings,binding});await coordinator.start(d.id,{mode:'all'});await coordinator.wait(d.id);
 const before=await coordinator.read(d.id);
 await assert.rejects(coordinator.choose(d.id,{mode:'review',expectedFingerprint:'stale',resetDrafts:true}),{code:'SELECTION_FINGERPRINT'});
 assert.deepEqual(await coordinator.read(d.id),before);
 await assert.rejects(coordinator.confirm(d.id,{selectedIds:[],expectedFingerprint:'stale',resetDrafts:true}),{code:'SELECTION_FINGERPRINT'});
 assert.deepEqual(await coordinator.read(d.id),before);
}));

test('background preflight failure is recorded without an unhandled rejection',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-background-error-test-'));
 const c=createCoordinator({dataRoot:dir,beforeExecute:async()=>{throw Object.assign(new Error('preflight failed'),{code:'PREFLIGHT_FAILED'});},modelRunner:async()=>{throw Error('unreachable');}});
 try{const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'all'});await c.wait(d.id);
  const result=await c.read(d.id);assert.equal(result.web.progress,'failed');assert.equal(result.web.error?.code,'PREFLIGHT_FAILED');
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('stopping a completed draft keeps it ready and restarting buys nothing',async()=>fixture(async({coordinator,calls})=>{
 const d=await coordinator.create({source,settings,binding});await coordinator.start(d.id,{mode:'all'});await coordinator.wait(d.id);
 const count=calls.length,ready=await coordinator.read(d.id);
 await coordinator.stop(d.id);await coordinator.start(d.id,{mode:'all'});await coordinator.wait(d.id);
 const after=await coordinator.read(d.id);
 assert.equal(after.status,'text_ready_for_review');assert.equal(after.web.progress,'text_ready_for_review');
 assert.equal(after.assembly.text,ready.assembly.text);assert.equal(calls.length,count);
}));

test('source stale is a terminal run boundary',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-source-boundary-test-'));let calls=0;
 const c=createCoordinator({dataRoot:dir,beforeExecute:async()=>false,modelRunner:async()=>{calls++;throw Error('unreachable');}});
 try{const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'all'});await c.wait(d.id);
  await assert.rejects(c.start(d.id,{mode:'all'}),{code:'SOURCE_STALE'});assert.equal(calls,0);
  assert.equal((await c.read(d.id)).web.progress,'source_stale');
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('live external process owns the lease; a dead owner can be archived',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-lease-test-'));let calls=0;
 const child=spawn(process.execPath,['-e',`const fs=require('node:fs'),os=require('node:os'),path=require('node:path');fs.writeFileSync(path.join(process.argv[1],'.coordinator-owner.json'),JSON.stringify({pid:process.pid,host:os.hostname(),token:'external'}));process.stdout.write('READY\\n');process.stdin.resume();`,dir],{stdio:['pipe','pipe','ignore']});
 const c=createCoordinator({dataRoot:dir,modelRunner:async()=>{calls++;throw Object.assign(new Error('uncertain'),{code:'TIMEOUT',requestOutcome:'UNKNOWN'});}});
 try{await once(child.stdout,'data');await assert.rejects(c.create({source,settings,binding}),{code:'LEASE_BUSY'});assert.equal(calls,0);
  child.kill();await once(child,'exit');
  const d=await c.create({source,settings,binding});
  await c.start(d.id,{mode:'next'});await c.wait(d.id);assert.equal(calls,1);
  await assert.rejects(c.start(d.id,{mode:'next'}),{code:'ATTEMPT_UNRESOLVED'});assert.equal(calls,1);
 }finally{if(child.exitCode===null)child.kill();await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('another run cannot bypass an unresolved attempt in the same episode',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-episode-unresolved-test-'));let calls=0;
 const c=createCoordinator({dataRoot:dir,modelRunner:async()=>{calls++;throw Object.assign(new Error('uncertain'),{code:'TIMEOUT',requestOutcome:'UNKNOWN'});}});
 try{const a=await c.create({source,settings,binding});await c.start(a.id,{mode:'next'});await c.wait(a.id);
  const b=await c.create({source,settings,binding});
  await assert.rejects(c.start(b.id,{mode:'next'}),{code:'EPISODE_UNRESOLVED'});assert.equal(calls,1);
  const other=await c.create({source,settings,binding:{...binding,episodeId:'other'}});
  await c.start(other.id,{mode:'next'});await c.wait(other.id);assert.equal(calls,2);
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('repair cannot bypass an unresolved attempt in a sibling run',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-repair-unresolved-test-'));let calls=0;
 const c=createCoordinator({dataRoot:dir,modelRunner:async()=>{calls++;if(calls===1)return {output:plan,raw:JSON.stringify(plan),usage:{totalTokens:1},requestOutcome:'RESPONDED'};throw Object.assign(new Error('uncertain'),{code:'TIMEOUT',requestOutcome:'UNKNOWN'});}});
 try{const b=await c.create({source,settings,binding});await c.start(b.id,{mode:'next'});await c.wait(b.id);
  const a=await c.create({source,settings,binding});await c.start(a.id,{mode:'next'});await c.wait(a.id);
  await assert.rejects(c.repair(b.id,{packageIds:['p1']}),{code:'EPISODE_UNRESOLVED'});assert.equal(calls,2);
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('explicit uncovered-unit requests can replan designs before authorship',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-replan-test-'));const calls=[];
 const candidate=i=>({id:`f${i}`,anchorRefs:[`r${i}`],subject:'甲',emotionPurpose:'承接情绪',recommended:i===1,proposal:'光影意象'});
 const first={...plan,fantasyCandidates:[candidate(1)]},second={...plan,fantasyCandidates:[candidate(1),candidate(2),candidate(3)]};
 const runner=async request=>{calls.push(request.stage);const output=request.stage==='plan'?(calls.filter(x=>x==='plan').length===1?first:second):draft(request);return {output,raw:JSON.stringify(output),usage:{totalTokens:20},requestOutcome:'RESPONDED'};};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner});
 try{const d=await c.create({source,settings:{...settings,fantasyMode:'recommended'},binding});
  await c.start(d.id,{mode:'next'});await c.wait(d.id);await c.choose(d.id,{mode:'all',unitOverrides:{u2:true,u3:true}});
  await c.start(d.id,{mode:'all'});await c.wait(d.id);assert.equal((await c.read(d.id)).web.progress,'needs_design');
  await c.replan(d.id);await c.wait(d.id);const refreshed=await c.read(d.id);
  assert.equal(refreshed.plan.fantasyCandidates.length,3);assert.equal(refreshed.candidates.filter(x=>x.stage==='plan').length,2);
  assert.equal(calls.filter(x=>x==='plan').length,2);assert.equal(refreshed.adopted.length,0);
  await c.start(d.id,{mode:'next'});await c.wait(d.id);assert.ok(calls.includes('author'));
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('replan respects zero budget and unresolved sibling episode',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-replan-guard-test-'));let calls=0;
 const runner=async()=>{calls++;return {output:plan,raw:JSON.stringify(plan),usage:{totalTokens:10},requestOutcome:'RESPONDED'};};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner});
 try{const b=await c.create({source,settings,binding});await c.start(b.id,{mode:'next'});await c.wait(b.id);
  await c.setBudget(b.id,{maxCalls:0,maxTokens:300000});
  await c.replan(b.id);await c.wait(b.id);assert.equal(calls,1);assert.equal((await c.read(b.id)).web.progress,'budget_stop');
  const a=await c.create({source,settings,binding});
  const store=(await import('./core/store.mjs')).createStore(dir);
  await store.update(a.id,d=>{d.operations.push({attemptId:'unresolved',stage:'plan',packageIds:[],status:'unknown',epoch:d.epoch});d.status='unknown';return d;});
  await assert.rejects(c.replan(b.id),{code:'EPISODE_UNRESOLVED'});assert.equal(calls,1);
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('three independent packages complete with exactly five call admissions',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-exact-calls-test-'));const authored=[],calls=[];let checks=0;
 const independent={...plan,workPackages:plan.workPackages.map(w=>({...w,dependsOn:[]}))};
 const runner=async request=>{calls.push(request.stage);if(request.stage==='author')await new Promise(resolve=>setTimeout(resolve,100));const output=request.stage==='plan'?independent:request.finishMode==='delta'?{schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:authored.flatMap(x=>x.units.map(u=>u.id)),replacements:[],revisionNotes:[],unresolved:[]}:draft(request);if(request.stage==='author')authored.push(output);return {output,raw:JSON.stringify(output),usage:{totalTokens:1},requestOutcome:'RESPONDED'};};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner,beforeExecute:async()=>{const n=++checks;if(n>=3)await new Promise(resolve=>setTimeout(resolve,(n-2)*20));return true;}});
 try{const d=await c.create({source,settings,binding,budget:{maxCalls:5,maxTokens:300000}});await c.start(d.id,{mode:'all'});await c.wait(d.id);
  const result=await c.read(d.id);assert.equal(result.status,'text_ready_for_review');assert.equal(calls.length,5);
  assert.equal(result.operations.length,5);assert.equal(result.web.reserved,0);
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('serial admission never exceeds the call cap',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-call-cap-test-'));let calls=0;
 const independent={...plan,workPackages:plan.workPackages.map(w=>({...w,dependsOn:[]}))};
 const runner=async request=>{calls++;const output=request.stage==='plan'?independent:draft(request);return {output,raw:JSON.stringify(output),usage:{totalTokens:1},requestOutcome:'RESPONDED'};};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner});
 try{const d=await c.create({source,settings,binding,budget:{maxCalls:2,maxTokens:300000}});await c.start(d.id,{mode:'all'});await c.wait(d.id);
  assert.equal(calls,2);assert.equal((await c.read(d.id)).operations.length,2);
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('stop leaves all later independent packages unprepared',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-stop-queue-test-'));let started=0,wake;
 const firstStarted=new Promise(resolve=>wake=resolve);
 const independent={...plan,workPackages:plan.workPackages.map(w=>({...w,dependsOn:[]}))};
 const runner=async(request,{signal})=>{if(request.stage==='plan')return {output:independent,raw:JSON.stringify(independent),usage:{totalTokens:1},requestOutcome:'RESPONDED'};
  started++;wake();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'ABORTED',requestOutcome:'UNKNOWN'})),{once:true}));};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner});
 try{const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'all'});await firstStarted;await c.stop(d.id);await c.wait(d.id);
  const result=await c.read(d.id);assert.equal(started,1);assert.deepEqual(result.operations.filter(o=>o.stage==='author').map(o=>o.packageIds),[['p1']]);
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

function gate(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function until(check,message='scheduler condition did not become true'){
 for(let i=0;i<200;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,5));}
 assert.fail(message);
}
const completed=output=>({output,raw:JSON.stringify(output),usage:{totalTokens:1},requestOutcome:'RESPONDED'});
async function schedulingFixture(t,{maxConcurrent=2,planValue=plan,runner,beforeExecute}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'v4-scheduling-test-')),calls=[],gates=[],authored=new Map(),running=new Map(),peaks=new Map();let total=0,peak=0;
 const c=createCoordinator({dataRoot:dir,maxConcurrent,beforeExecute,modelRunner:async(request,options)=>{
  const {runId}=options;calls.push({stage:request.stage,ids:request.packageIds,runId,signal:options.signal});
  running.set(runId,(running.get(runId)||0)+1);peaks.set(runId,Math.max(peaks.get(runId)||0,running.get(runId)));peak=Math.max(peak,++total);
  try{const result=await runner?.(request,options)??completed(request.stage==='plan'?planValue:request.finishMode==='delta'?{schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:(authored.get(runId)||[]).flatMap(x=>x.units.map(u=>u.id)),replacements:[],revisionNotes:[],unresolved:[]}:draft(request));
   if((request.stage==='author'||request.stage==='finish'&&request.finishMode!=='delta')&&result.output?.units?.length)authored.set(runId,[...(authored.get(runId)||[]),result.output]);return result;
  }finally{total--;running.set(runId,running.get(runId)-1);}
 }});
 t.after(async()=>{gates.forEach(g=>g.resolve());await c.shutdown();await rm(dir,{recursive:true,force:true});});
 return {c,calls,gates,peaks,peak:()=>peak};
}

test('serial authors do not prepare the next request before the prior package is adopted',async t=>{
 const first=gate(),independent={...plan,workPackages:plan.workPackages.map(w=>({...w,dependsOn:[]}))};let checks=0,seenByNextPreflight;
 const {c,calls,gates,peaks}=await schedulingFixture(t,{maxConcurrent:4,planValue:independent,beforeExecute:async()=>{
  if(++checks===3)seenByNextPreflight=(await c.read(id)).adopted.flatMap(a=>a.packageIds);return true;
 },runner:async request=>{if(request.stage==='author'&&request.packageIds[0]==='p1')await first.promise;}});gates.push(first);
 const {id}=await c.create({source,settings,binding});await c.start(id);
 await until(()=>calls.some(x=>x.stage==='author'));await new Promise(resolve=>setTimeout(resolve,30));
 const held=await c.read(id);
 assert.deepEqual(held.operations.filter(o=>o.stage==='author').map(o=>o.packageIds),[['p1']],'a later request was created before prior adoption');
 assert.equal(checks,2,'a later preflight started before prior adoption');assert.equal(c.scheduling(id).maxPerEpisode,1);
 first.resolve();const done=await c.wait(id);
 assert.deepEqual(seenByNextPreflight,['p1']);assert.deepEqual(calls.filter(x=>x.stage==='author').map(x=>x.ids),[['p1'],['p2'],['p3']]);
 assert.equal(peaks.get(id),1);assert.equal(done.status,'text_ready_for_review');assert.equal(done.operations.length,5);
});

test('serial authors follow source order even when legacy package metadata is shuffled',async t=>{
 const shuffled={...plan,workPackages:[plan.workPackages[2],plan.workPackages[0],plan.workPackages[1]].map(w=>({...w,dependsOn:[]}))};
 const {c,calls}=await schedulingFixture(t,{maxConcurrent:4,planValue:shuffled});
 const {id}=await c.create({source,settings,binding});await c.start(id);const done=await c.wait(id);
 assert.deepEqual(calls.filter(x=>x.stage==='author').map(x=>x.ids),[['p1'],['p2'],['p3']]);assert.equal(done.status,'text_ready_for_review');
});

test('serial authors stop at a forward dependency without skipping source order or replanning',async t=>{
 const forward={...plan,workPackages:plan.workPackages.map(w=>({...w,dependsOn:w.id==='p1'?['p3']:[]}))};
 const {c,calls}=await schedulingFixture(t,{maxConcurrent:4,planValue:forward});
 const {id}=await c.create({source,settings,binding});await c.start(id);const blocked=await c.wait(id);
 assert.equal(blocked.web.progress,'waiting_dependencies');assert.equal(blocked.web.error?.code,'DEPENDENCY_NOT_READY');
 assert.match(blocked.web.error.message,/p1.*p3/);assert.deepEqual(calls.map(x=>x.stage),['plan']);assert.equal(blocked.operations.length,1);
 await c.start(id);const repeated=await c.wait(id);assert.equal(calls.length,1);assert.deepEqual(repeated.plan,blocked.plan);assert.deepEqual(repeated.adopted,blocked.adopted);
});

test('serial authors leave all four global slots available to distinct episodes',async t=>{
 const hold=gate();const {c,calls,gates,peak,peaks}=await schedulingFixture(t,{maxConcurrent:4,runner:async request=>{if(request.stage==='author')await hold.promise;}});gates.push(hold);
 const docs=[];for(const episodeId of ['a','b','c','d'])docs.push(await c.create({source,settings,binding:{...binding,episodeId}}));
 for(const d of docs){await c.start(d.id,{mode:'next'});await c.wait(d.id);}
 for(const d of docs)await c.start(d.id);
 await until(()=>calls.filter(x=>x.stage==='author').length===4);
 assert.equal(new Set(calls.filter(x=>x.stage==='author').map(x=>x.runId)).size,4);assert.equal(peak(),4);assert.ok([...peaks.values()].every(n=>n===1));
 assert.ok(docs.every(d=>c.scheduling(d.id).inFlight===1));hold.resolve();const done=await Promise.all(docs.map(d=>c.wait(d.id)));
 assert.ok(done.every(d=>d.status==='text_ready_for_review'));
});

test('serial authors adopt each dependency before preparing its successor',async t=>{
 const first=gate(),slow=gate();const {c,calls,gates,peaks}=await schedulingFixture(t,{runner:async request=>{if(request.stage==='author'&&request.packageIds[0]==='p1')await first.promise;if(request.stage==='author'&&request.packageIds[0]==='p2')await slow.promise;}});gates.push(first,slow);
 const d=await c.create({source,settings,binding});await c.start(d.id);
 await until(()=>calls.some(x=>x.stage==='author'));assert.equal(calls.some(x=>x.ids[0]==='p2'),false);
 first.resolve();await until(()=>calls.some(x=>x.stage==='author'&&x.ids[0]==='p2'));
 const held=await c.read(d.id);assert.ok(held.adopted.some(x=>x.packageIds.includes('p1')));assert.equal(held.operations.some(o=>o.packageIds.includes('p3')),false);
 assert.equal(calls.some(x=>x.stage==='finish'),false);assert.equal(peaks.get(d.id),1);
 slow.resolve();const result=await c.wait(d.id);assert.equal(result.status,'text_ready_for_review');assert.equal(calls.length,5);assert.equal(result.web.reserved,0);
 assert.deepEqual(calls.filter(x=>x.stage==='author').map(x=>x.ids[0]),['p1','p2','p3']);
});

test('four global slots serve one request per episode and retain FIFO ties',async t=>{
 const planGates=new Map(),authorHold=gate();const {c,calls,gates,peaks,peak}=await schedulingFixture(t,{maxConcurrent:4,runner:async(request,{runId})=>{if(request.stage==='plan')await planGates.get(runId)?.promise;if(request.stage==='author')await authorHold.promise;}});gates.push(authorHold);
 const docs=[];for(const episodeId of ['a','b','blocker','other-blocker','c','d'])docs.push(await c.create({source,settings,binding:{...binding,episodeId}}));
 const [a,b,blocker,otherBlocker,third,fourth]=docs;
 for(const d of [blocker,otherBlocker,third,fourth]){const held=gate();planGates.set(d.id,held);gates.push(held);}
 await c.start(a.id);await until(()=>calls.some(x=>x.runId===a.id&&x.stage==='author'));
 await c.start(b.id);await until(()=>c.scheduling(b.id).inFlight===1);
 await c.start(blocker.id,{mode:'next'});await until(()=>c.scheduling(blocker.id).inFlight===1);
 await c.start(otherBlocker.id,{mode:'next'});await until(()=>c.scheduling(otherBlocker.id).inFlight===1);
 await c.start(third.id,{mode:'next'});await until(()=>c.scheduling(third.id).queued===1);
 await c.start(fourth.id,{mode:'next'});await until(()=>c.scheduling(fourth.id).queued===1);
 assert.deepEqual(c.scheduling(a.id),{maxConcurrent:4,maxPerEpisode:1,inFlight:1,queued:0});
 planGates.get(blocker.id).resolve();await until(()=>c.scheduling(third.id).inFlight===1,'the oldest queued episode did not receive the next slot');
 assert.equal(c.scheduling(fourth.id).queued,1);assert.equal(c.scheduling(b.id).queued,0);
 planGates.get(third.id).resolve();await until(()=>c.scheduling(fourth.id).inFlight===1);
 planGates.get(fourth.id).resolve();planGates.get(otherBlocker.id).resolve();
 for(const d of [blocker,otherBlocker,third,fourth]){await c.wait(d.id);assert.equal(calls.filter(x=>x.runId===d.id).length,1);assert.equal(c.scheduling(d.id).inFlight,0);}
 assert.equal(peak(),4);assert.ok([...peaks.values()].every(n=>n===1));assert.ok(calls.every(x=>!x.signal.aborted));
 await Promise.all([c.pause(a.id),c.pause(b.id)]);authorHold.resolve();await Promise.all([c.wait(a.id),c.wait(b.id)]);
 assert.deepEqual(c.scheduling(a.id),{maxConcurrent:4,maxPerEpisode:1,inFlight:0,queued:0});
});

test('a temporarily ineligible queue head does not block an available global slot',async t=>{
 const hold=gate();const one=await schedulingFixture(t,{maxConcurrent:1,runner:async()=>{await hold.promise;}}),two=await schedulingFixture(t,{maxConcurrent:2,runner:async()=>{await hold.promise;}});one.gates.push(hold);two.gates.push(hold);
 const active=await two.c.create({source,settings,binding}),head=await one.c.create({source,settings,binding}),tail=await two.c.create({source,settings,binding:{...binding,episodeId:'tail'}});
 await two.c.start(active.id,{mode:'next'});await until(()=>two.calls.length===1);
 await one.c.start(head.id,{mode:'next'});await until(async()=>(await one.c.read(head.id)).operations.length===1);
 await two.c.start(tail.id,{mode:'next'});await until(()=>two.calls.length===2,'eligible tail stayed behind the limit-one queue head');
 assert.equal(one.calls.length,0);assert.deepEqual(one.c.scheduling(head.id),{maxConcurrent:1,maxPerEpisode:1,inFlight:0,queued:1});
 hold.resolve();await Promise.all([one.c.wait(head.id),two.c.wait(active.id),two.c.wait(tail.id)]);
});

for(const boundary of ['pause','budget','unknown','usage','repair'])test(`serial authors settle the current request before the ${boundary} boundary`,async t=>{
 const first=gate(),repairHold=gate(),independent={...plan,workPackages:plan.workPackages.map(w=>({...w,dependsOn:[]}))};let repairEntered=false;
 const {c,calls,gates}=await schedulingFixture(t,{planValue:independent,runner:async request=>{
  if(request.stage==='author'&&request.packageIds[0]==='p1'){await first.promise;if(boundary==='unknown')throw Object.assign(new Error('uncertain'),{code:'TIMEOUT',requestOutcome:'UNKNOWN'});if(boundary==='repair')return completed({schemaVersion:VERSION,units:[],fantasyRealization:[]});if(boundary==='usage')return {...completed(draft(request)),usage:null};}
  if(request.stage==='finish'&&request.packageIds.length===1){repairEntered=true;await repairHold.promise;}
 }});gates.push(first,repairHold);
 const d=await c.create({source,settings,binding,...(boundary==='budget'?{budget:{maxCalls:2,maxTokens:300000}}:{})}),sibling=await c.create({source,settings,binding});await c.start(d.id);
 await until(()=>calls.some(x=>x.stage==='author'));if(boundary==='pause')await c.pause(d.id);
 assert.equal(c.active(d.id),true);await assert.rejects(c.start(sibling.id),{code:'EPISODE_BUSY'});assert.equal(calls.some(x=>x.stage==='author'&&x.ids[0]==='p3'),false);assert.equal(calls.some(x=>x.stage==='finish'),false);
 assert.deepEqual((await c.read(d.id)).operations.filter(o=>o.stage==='author').map(o=>o.packageIds),[['p1']]);first.resolve();
 if(boundary==='repair'){await until(()=>repairEntered);assert.deepEqual((await c.read(d.id)).operations.filter(o=>o.stage==='author').map(o=>o.packageIds),[['p1']]);await assert.rejects(c.start(sibling.id),{code:'EPISODE_BUSY'});repairHold.resolve();}
 const result=await c.wait(d.id);assert.equal(result.web.reserved,0);
 if(boundary==='repair'){assert.ok(calls.some(x=>x.stage==='finish'&&x.ids.length===1&&x.ids[0]==='p1'));assert.equal(calls.filter(x=>x.stage==='author').length,3);assert.equal(result.status,'text_ready_for_review');}
 else{assert.equal(result.web.progress,{pause:'paused',budget:'budget_stop',unknown:'unknown',usage:'usage_review'}[boundary]);assert.equal(calls.filter(x=>x.stage==='author').length,1);assert.equal(result.operations.length,2);}
 if(boundary==='unknown'){await assert.rejects(c.start(d.id),{code:'ATTEMPT_UNRESOLVED'});assert.equal(calls.length,2);}
 if(boundary==='pause'){await c.start(d.id,{mode:'next'});const resumed=await c.wait(d.id);assert.deepEqual(calls.filter(x=>x.stage==='author').map(x=>x.ids),[['p1'],['p2']]);assert.deepEqual(resumed.adopted[0],result.adopted[0]);}
 if(boundary==='budget'){await c.setBudget(d.id,{maxCalls:5,maxTokens:300000});await c.start(d.id);assert.equal((await c.wait(d.id)).status,'text_ready_for_review');assert.equal(calls.filter(x=>x.stage==='author'&&x.ids[0]==='p1').length,1);}
 if(boundary==='usage'){await c.start(d.id);await c.wait(d.id);assert.equal(calls.length,2);assert.equal((await c.read(d.id)).operations.at(-1).receipt.usage,null);}
});

for(const boundary of ['pause','stop'])test(`a serial author queued behind another episode is NOT_SENT after ${boundary}`,async t=>{
 const blockerHold=gate();let blockerId;
 const {c,calls,gates}=await schedulingFixture(t,{maxConcurrent:1,runner:async(_request,{runId})=>{if(runId===blockerId)await blockerHold.promise;}});gates.push(blockerHold);
 const target=await c.create({source,settings,binding});await c.start(target.id,{mode:'next'});await c.wait(target.id);
 const blocker=await c.create({source,settings,binding:{...binding,episodeId:'blocker'}});blockerId=blocker.id;
 await c.start(blockerId,{mode:'next'});await until(()=>c.scheduling(blockerId).inFlight===1);await c.start(target.id);await until(()=>c.scheduling(target.id).queued===1);
 const queuedAttempt=(await c.read(target.id)).operations.find(o=>o.stage==='author');assert.deepEqual(queuedAttempt.packageIds,['p1']);
 await c[boundary](target.id);const after=await c.wait(target.id),withdrawn=after.operations.find(o=>o.attemptId===queuedAttempt.attemptId);
 assert.equal(withdrawn.status,'completed');assert.equal(withdrawn.error?.requestOutcome,'NOT_SENT');assert.equal(after.web.progress,boundary==='pause'?'paused':'stopped');assert.equal(after.web.reserved,0);
 assert.equal(calls.filter(x=>x.runId===target.id&&x.stage==='author').length,0);assert.equal(after.operations.filter(o=>o.stage==='author').length,1);
 blockerHold.resolve();await c.wait(blockerId);await c.start(target.id,{mode:'next'});const resumed=await c.wait(target.id);
 assert.deepEqual(calls.filter(x=>x.runId===target.id&&x.stage==='author').map(x=>x.ids),[['p1']]);assert.equal(resumed.adopted.length,1);
});

test('serial repair preflight completes before a new author can be prepared',async t=>{
 const preflightHold=gate(),repairHold=gate(),independent={...plan,workPackages:plan.workPackages.map(w=>({...w,dependsOn:[]}))};let checks=0,invalid=true,repairEntered=false;
 const {c,calls,gates}=await schedulingFixture(t,{planValue:independent,beforeExecute:async()=>{if(++checks===3)await preflightHold.promise;return true;},runner:async request=>{
  if(request.stage==='author'&&invalid){invalid=false;return completed({schemaVersion:VERSION,units:[],fantasyRealization:[]});}
  if(request.stage==='finish'&&request.packageIds.length===1){repairEntered=true;await repairHold.promise;}
 }});gates.push(preflightHold,repairHold);
 const d=await c.create({source,settings,binding});await c.start(d.id);await until(async()=>(await c.read(d.id)).candidates.some(x=>x.status==='needs_repair'));preflightHold.resolve();await until(()=>repairEntered);
 assert.equal(calls.filter(x=>x.stage==='author').length,1,'stale author preflight crossed the repair boundary');assert.equal((await c.read(d.id)).operations.filter(o=>o.stage==='author').length,1);
 repairHold.resolve();assert.equal((await c.wait(d.id)).status,'text_ready_for_review');
});

test('synchronous shouldDispatch rechecks pause during local request preparation',async t=>{
 const preparation=gate();let preparing=false,sent=false;
 const {c,gates}=await schedulingFixture(t,{runner:async(request,options)=>{
  if(request.stage!=='author')return;
  preparing=true;await preparation.promise;sent=options.shouldDispatch();if(!sent)throw Object.assign(new Error('withdrawn before stdin'),{code:'PAUSED',requestOutcome:'NOT_SENT'});
 }});gates.push(preparation);
 const d=await c.create({source,settings,binding});await c.start(d.id);await until(()=>preparing);await c.pause(d.id);preparation.resolve();const result=await c.wait(d.id);
 assert.equal(sent,false);assert.equal(result.web.progress,'paused');assert.equal(result.operations.find(o=>o.stage==='author').error?.requestOutcome,'NOT_SENT');assert.equal(result.operations.length,2);
});

test('a queued request does not count its own reservation as an exhausted call budget',async t=>{
 const hold=gate();let blockerId;const {c,calls,gates}=await schedulingFixture(t,{maxConcurrent:1,runner:async(_request,{runId})=>{if(runId===blockerId)await hold.promise;}});gates.push(hold);
 const target=await c.create({source,settings,binding,budget:{maxCalls:2,maxTokens:300000}});await c.start(target.id,{mode:'next'});await c.wait(target.id);
 const blocker=await c.create({source,settings,binding:{...binding,episodeId:'blocker'}});blockerId=blocker.id;await c.start(blockerId,{mode:'next'});await until(()=>c.scheduling(blockerId).inFlight===1);
 await c.start(target.id,{mode:'next'});await until(()=>c.scheduling(target.id).queued===1);hold.resolve();const result=await c.wait(target.id);await c.wait(blockerId);
 assert.equal(calls.filter(x=>x.runId===target.id).length,2);assert.equal(result.adopted.length,1);assert.equal(result.operations.length,2);assert.equal(result.web.reserved,0);
});

for(const boundary of ['unknown','repair'])test(`a global slot is released only after its ${boundary} result is persisted`,async t=>{
 const leaderHold=gate(),blockerHold=gate(),independent={...plan,workPackages:plan.workPackages.map(w=>({...w,dependsOn:[]}))};let targetId,blockerId,stateAtNextDispatch;
 const {c,calls,gates}=await schedulingFixture(t,{maxConcurrent:1,planValue:independent,runner:async(request,{runId})=>{
  if(runId===blockerId){stateAtNextDispatch=await c.read(targetId);await blockerHold.promise;}
  if(runId===targetId&&request.stage==='author'&&request.packageIds[0]==='p1'){
   await leaderHold.promise;if(boundary==='unknown')throw Object.assign(new Error('primary timeout'),{code:'TIMEOUT',requestOutcome:'UNKNOWN'});return completed({schemaVersion:VERSION,units:[],fantasyRealization:[]});
  }
 }});gates.push(leaderHold,blockerHold);
 const target=await c.create({source,settings,binding});targetId=target.id;await c.start(targetId,{mode:'next'});await c.wait(targetId);
 await c.start(targetId);await until(()=>c.scheduling(targetId).inFlight===1);
 const blocker=await c.create({source,settings,binding:{...binding,episodeId:'blocker'}});blockerId=blocker.id;await c.start(blockerId,{mode:'next'});await until(()=>c.scheduling(blockerId).queued===1);
 leaderHold.resolve();await until(()=>Boolean(stateAtNextDispatch));
 assert.equal(stateAtNextDispatch.operations.find(o=>o.stage==='author').status,boundary==='unknown'?'unknown':'completed');
 if(boundary==='unknown'){assert.equal(stateAtNextDispatch.web.error?.code,'TIMEOUT');assert.equal(stateAtNextDispatch.web.progress,'unknown');}
 else assert.ok(stateAtNextDispatch.candidates.some(c=>c.stage==='author'&&c.status==='needs_repair'));
 assert.equal(calls.filter(x=>x.runId===targetId&&x.stage==='author').length,1);
 blockerHold.resolve();await c.wait(blockerId);const done=await c.wait(targetId);
 if(boundary==='repair')assert.equal(done.status,'text_ready_for_review');else assert.equal(done.web.error?.code,'TIMEOUT');
 assert.deepEqual(c.scheduling(targetId),{maxConcurrent:1,maxPerEpisode:1,inFlight:0,queued:0});
 assert.equal(c.scheduling(blockerId).inFlight,0);
});

for(const secondFails of [false,true])test(`preflight failure does not prepare later packages or cancel a ${secondFails?'failing':'successful'} other episode`,async t=>{
 const firstEntered=gate(),firstHold=gate(),peerEntered=gate(),peerHold=gate(),checks=new Map();
 const {c,calls,gates}=await schedulingFixture(t,{beforeExecute:async b=>{
  const n=(checks.get(b.episodeId)||0)+1;checks.set(b.episodeId,n);
  if(n===2&&b.episodeId===binding.episodeId){firstEntered.resolve();await firstHold.promise;throw Object.assign(new Error('primary preflight failure'),{code:'PREFLIGHT_FAILED'});}
  if(n===2&&b.episodeId==='peer'){peerEntered.resolve();await peerHold.promise;if(secondFails)throw Object.assign(new Error('secondary preflight failure'),{code:'SECOND_PREFLIGHT_FAILED'});}
  return true;
 }});gates.push(firstEntered,firstHold,peerEntered,peerHold);
 const d=await c.create({source,settings,binding}),peer=await c.create({source,settings,binding:{...binding,episodeId:'peer'}});
 await c.start(d.id);await firstEntered.promise;await c.start(peer.id);await peerEntered.promise;firstHold.resolve();const result=await c.wait(d.id);
 assert.equal(c.active(peer.id),true);assert.equal(c.active(d.id),false);assert.equal(checks.get(binding.episodeId),2);
 assert.equal(calls.filter(x=>x.runId===d.id&&x.stage==='author').length,0);assert.equal(result.web.error?.code,'PREFLIGHT_FAILED');assert.equal(result.operations.length,1);assert.equal(result.web.reserved,0);
 assert.deepEqual(c.scheduling(d.id),{maxConcurrent:2,maxPerEpisode:1,inFlight:0,queued:0});
 peerHold.resolve();const peerDone=await c.wait(peer.id);assert.equal(peerDone.web.progress,secondFails?'failed':'text_ready_for_review');if(secondFails)assert.equal(peerDone.web.error?.code,'SECOND_PREFLIGHT_FAILED');
});

function executionGate(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function queuedAttempt(c,id){
 for(let tries=0;tries<200;tries++){const attempt=(await c.read(id)).operations.at(-1);if(attempt&&c.executionState(id,attempt.attemptId)==='queued')return attempt;await new Promise(resolve=>setTimeout(resolve,5));}
 assert.fail('attempt did not reach the real model queue');
}

test('executionState distinguishes exact queued, executing and response-processing attempts without writing the ledger',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-execution-state-')),entered=[executionGate(),executionGate()],release=[executionGate(),executionGate()],calls=[],settling=[];
 const c=createCoordinator({dataRoot:dir,maxConcurrent:1,modelRunner:async(_request,options)=>{
  const index=calls.length;calls.push(options);entered[index].resolve(options);await release[index].promise;
  return {output:plan,get raw(){settling.push(c.executionState(options.runId,options.attemptId));return JSON.stringify(plan);},usage:{totalTokens:10},requestOutcome:'RESPONDED'};
 }});
 t.after(async()=>{release.forEach(g=>g.resolve());await c.shutdown();await rm(dir,{recursive:true,force:true});});
 assert.equal(typeof c.executionState,'function');assert.equal(c.executionState('missing','missing'),null);assert.equal(c.executionState(null,null),null);
 const first=await c.create({source,settings,binding}),second=await c.create({source,settings,binding:{...binding,episodeId:'second'}});
 await c.start(first.id,{mode:'next'});const firstCall=await entered[0].promise;
 assert.equal(c.executionState(first.id,firstCall.attemptId),'executing');assert.equal(c.executionState(second.id,firstCall.attemptId),null);assert.equal(c.executionState(first.id,'missing'),null);assert.equal(c.executionState(first.id,null),null);
 await c.start(second.id,{mode:'next'});const queued=await queuedAttempt(c,second.id);
 assert.equal(queued.status,'running');assert.equal(calls.length,1);assert.equal(c.executionState(second.id,queued.attemptId),'queued');assert.equal(c.executionState(first.id,queued.attemptId),null);
 const file=path.join(dir,'documents',`${second.id}.json`),before=await readFile(file,'utf8');for(let i=0;i<3;i++)assert.equal(c.executionState(second.id,queued.attemptId),'queued');assert.equal(await readFile(file,'utf8'),before);
 release[0].resolve();const secondCall=await entered[1].promise;await c.wait(first.id);
 assert.equal(c.executionState(second.id,secondCall.attemptId),'executing');assert.equal(c.executionState(first.id,firstCall.attemptId),null);assert.ok(settling.length);assert.ok(settling.every(phase=>phase==='preparing'));
 await c.start(first.id,{mode:'next'});const next=await queuedAttempt(c,first.id);assert.equal(next.stage,'author');assert.equal(c.executionState(first.id,firstCall.attemptId),null);
 await c.pause(first.id);const paused=await c.wait(first.id);assert.equal(c.executionState(first.id,next.attemptId),null);assert.equal(paused.operations.at(-1).error.requestOutcome,'NOT_SENT');assert.equal(calls.length,2);
 await c.pause(second.id);assert.equal(c.executionState(second.id,secondCall.attemptId),'executing');release[1].resolve();await c.wait(second.id);assert.equal(c.executionState(second.id,secondCall.attemptId),null);
 assert.ok((await c.read(first.id)).operations.every(op=>!Object.hasOwn(op,'localPhase')));assert.ok(settling.every(phase=>phase==='preparing'));
});

test('executionState clears after an aborted runner and never resurrects a historical running record',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-execution-abort-')),entered=executionGate();let calls=0;
 const c=createCoordinator({dataRoot:dir,modelRunner:async(_request,options)=>{calls++;entered.resolve(options);await new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'ABORTED',requestOutcome:'UNKNOWN'})),{once:true}));}});
 t.after(async()=>{await c.shutdown();await rm(dir,{recursive:true,force:true});});
 assert.equal(typeof c.executionState,'function');const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});const call=await entered.promise;
 assert.equal(c.executionState(d.id,call.attemptId),'executing');await c.stop(d.id);await c.wait(d.id);assert.equal(c.executionState(d.id,call.attemptId),null);assert.equal(calls,1);
 await createStore(dir).update(d.id,x=>{x.operations[0].status='running';return x;});assert.equal(c.executionState(d.id,call.attemptId),null);
});
