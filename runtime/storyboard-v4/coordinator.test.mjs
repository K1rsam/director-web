import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCoordinator} from './core/legacy-test-fixtures.mjs';
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

test('call budget is reserved across parallel ready packages',async()=>fixture(async({coordinator,calls})=>{
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
 const dir=await mkdtemp(path.join(tmpdir(),'v4-slots-test-'));let running=0,peak=0;
 const runner=async request=>{running++;peak=Math.max(peak,running);await new Promise(resolve=>setTimeout(resolve,15));running--;const output=request.stage==='plan'?plan:draft(request);return {output,raw:JSON.stringify(output),usage:{totalTokens:10},requestOutcome:'RESPONDED'};};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner,maxConcurrent:2});
 try{const docs=await Promise.all([1,2,3].map(i=>c.create({source,settings,binding:{...binding,episodeId:`e${i}`}})));
  await Promise.all(docs.map(d=>c.start(d.id,{mode:'next'})));await Promise.all(docs.map(d=>c.wait(d.id)));
  assert.equal(peak,2);
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('source version check prevents dispatch',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-stale-test-'));let calls=0;
 const c=createCoordinator({dataRoot:dir,beforeExecute:async()=>false,modelRunner:async()=>{calls++;throw Error('unreachable');}});
 try{const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'all'});await c.wait(d.id);
  assert.equal(calls,0);assert.equal((await c.read(d.id)).web.progress,'source_stale');
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('all four selection modes are handled before authorship',async()=>fixture(async({coordinator,calls})=>{
 const d=await coordinator.create({source,settings,binding});await coordinator.start(d.id,{mode:'next'});await coordinator.wait(d.id);
 for(const mode of ['off','recommended','all','review']){
  await coordinator.choose(d.id,{mode,resetDrafts:true});await coordinator.start(d.id,{mode:'all'});await coordinator.wait(d.id);
  const current=await coordinator.read(d.id);
  assert.equal(current.web.progress,mode==='all'?'needs_design':mode==='review'?'awaiting_confirmation':'text_ready_for_review');
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

test('recheck creates a derived candidate without another model call',async()=>fixture(async({coordinator,calls})=>{
 const d=await coordinator.create({source,settings,binding});
 await coordinator.start(d.id,{mode:'next'});await coordinator.wait(d.id);
 await coordinator.start(d.id,{mode:'next'});await coordinator.wait(d.id);
 const before=await coordinator.read(d.id),candidate=before.candidates.at(-1);
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

test('all mode can replan missing fantasy designs once, then continue authorship',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-replan-test-'));const calls=[];
 const candidate=i=>({id:`f${i}`,anchorRefs:[`r${i}`],subject:'甲',emotionPurpose:'承接情绪',recommended:i===1,proposal:'光影意象'});
 const first={...plan,fantasyCandidates:[candidate(1)]},second={...plan,fantasyCandidates:[candidate(1),candidate(2),candidate(3)]};
 const runner=async request=>{calls.push(request.stage);const output=request.stage==='plan'?(calls.filter(x=>x==='plan').length===1?first:second):draft(request);return {output,raw:JSON.stringify(output),usage:{totalTokens:20},requestOutcome:'RESPONDED'};};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner});
 try{const d=await c.create({source,settings:{...settings,fantasyMode:'recommended'},binding});
  await c.start(d.id,{mode:'next'});await c.wait(d.id);await c.choose(d.id,{mode:'all'});
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

test('parallel admission never exceeds the call cap',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-call-cap-test-'));let calls=0;
 const independent={...plan,workPackages:plan.workPackages.map(w=>({...w,dependsOn:[]}))};
 const runner=async request=>{calls++;const output=request.stage==='plan'?independent:draft(request);return {output,raw:JSON.stringify(output),usage:{totalTokens:1},requestOutcome:'RESPONDED'};};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner});
 try{const d=await c.create({source,settings,binding,budget:{maxCalls:2,maxTokens:300000}});await c.start(d.id,{mode:'all'});await c.wait(d.id);
  assert.equal(calls,2);assert.equal((await c.read(d.id)).operations.length,2);
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});

test('stop leaves the third independent package undispatched',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'v4-stop-queue-test-'));let started=0,wake;
 const twoStarted=new Promise(resolve=>wake=resolve);
 const independent={...plan,workPackages:plan.workPackages.map(w=>({...w,dependsOn:[]}))};
 const runner=async(request,{signal})=>{if(request.stage==='plan')return {output:independent,raw:JSON.stringify(independent),usage:{totalTokens:1},requestOutcome:'RESPONDED'};
  started++;if(started===2)wake();await new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'ABORTED',requestOutcome:'UNKNOWN'})),{once:true}));};
 const c=createCoordinator({dataRoot:dir,modelRunner:runner});
 try{const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'all'});await twoStarted;await c.stop(d.id);await c.wait(d.id);
  const result=await c.read(d.id);assert.equal(started,2);assert.equal(result.operations.filter(o=>o.stage==='author').length,2);
 }finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
});
