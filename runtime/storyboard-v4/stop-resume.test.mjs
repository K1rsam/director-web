import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {once} from 'node:events';
import {createCoordinator} from './coordinator.mjs';
import {buildRequest} from './core/core.mjs';
import {createStore} from './core/store.mjs';
import {VERSION,PLAN_VERSION,digest} from './core/shared.mjs';
import {DELTA_VERSION} from './core/delta.mjs';

const source={key:'episode',sourceRows:[{id:'r1',text:'△甲推门。'},{id:'r2',text:'△乙点头。'}]};
const settings={maxUnits:null,fantasyMode:'off'};
const binding={projectId:'p',episodeId:'e',sourceVersion:'v1'};
const emotionContract={subject:'甲',contextTone:'紧张',audienceEffect:'担忧',change:'转机',landing:'释然',retain:['动作']};
const plan={schemaVersion:PLAN_VERSION,emotionArc:'由紧张到释然',entryFacts:[],workPackages:[1,2].map(i=>({id:`p${i}`,sourceRefs:[`r${i}`],emotionContract,dependsOn:[]})),provisionalUnits:[1,2].map(i=>({id:`u${i}`,packageId:`p${i}`,sourceRefs:[`r${i}`],secondsRange:[5,10]})),fantasyCandidates:[]};
const emptyUsage={inputTokens:null,cachedInputTokens:null,outputTokens:null,totalTokens:null};
const completed=output=>({output,raw:JSON.stringify(output),usage:{inputTokens:8,cachedInputTokens:0,outputTokens:2,totalTokens:10},requestOutcome:'RESPONDED'});
function draft(request){return {schemaVersion:VERSION,units:request.source.sourceRows.map(r=>({id:`u-${r.id}`,title:'动作',intent:{subject:'甲',change:'回应',landing:'释然',retain:['动作']},scene:'室内',props:[],participants:['甲','乙'],lighting:'柔光',initialState:'相望',exitState:'点头',shots:[{id:`s-${r.id}`,duration:5,camera:'近景',picture:r.text,lighting:'柔光',sound:'环境声',dialogueParts:[],transition:'切',sourceRefs:[r.id]}]})),fantasyRealization:[]};}
function gate(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
async function until(check){for(let i=0;i<200;i++){if(await check())return;await new Promise(r=>setTimeout(r,5));}assert.fail('test condition did not become true');}
async function fixture(t,{runner=async request=>completed(request.stage==='plan'?plan:draft(request)),maxConcurrent=2,beforeExecute}={}){
 const dir=await mkdtemp(path.join(tmpdir(),'v4-stop-resume-')),calls=[],gates=[];
 const modelRunner=async(request,options)=>{
  calls.push({request,options});const folder=path.join(dir,'attempts',options.attemptId);await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'request.json'),JSON.stringify(request));
  try{const result=await runner(request,options);await writeFile(path.join(folder,'raw.txt'),result.raw);await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:result.requestOutcome,usage:result.usage,errorCode:null}));return result;}
  catch(error){if(error.raw)await writeFile(path.join(folder,'raw.txt'),error.raw);await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:error.requestOutcome,usage:error.usage||emptyUsage,errorCode:error.code}));throw error;}
 };
 const c=createCoordinator({dataRoot:dir,modelRunner,maxConcurrent,...(beforeExecute?{beforeExecute}:{})}),store=createStore(dir),create=c.create.bind(c);
 // These saved-plan fixtures exercise lifecycle behavior under their explicit v1 contract.
 c.create=async options=>{const d=await create(options);return store.update(d.id,x=>{x.rulesSnapshot.outputSchemaVersion='structured-v1';delete x.rulesSnapshot.unitPackingPolicy;delete x.rulesSnapshot.unitDirectionVersion;return x;});};
 t.after(async()=>{gates.forEach(g=>g.resolve());await c.shutdown();await rm(dir,{recursive:true,force:true});});
 return {c,dir,calls,gates,store};
}
const abortUnknown=async(_request,{signal})=>{await new Promise((_,reject)=>{const abort=()=>reject(Object.assign(new Error('user cancelled; billing not known'),{code:'ABORTED',requestOutcome:'UNKNOWN',usage:emptyUsage}));if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});});};

const timeoutUnknown=async()=>{throw Object.assign(new Error('timed out; billing not known'),{code:'TIMEOUT',requestOutcome:'UNKNOWN',usage:emptyUsage});};
async function timedAttempt(t,options={}){
 const f=await fixture(t,{runner:timeoutUnknown,...options}),d=await f.c.create({source,settings,binding});
 await f.c.start(d.id,{mode:'next'});const timed=await f.c.wait(d.id),op=timed.operations.at(-1);
 return {...f,timed,op,folder:path.join(f.dir,'attempts',op.attemptId)};
}

test('pause waits for dispatched response, adopts it, and resume does not regenerate the completed plan',async t=>{
 const hold=gate(),entered=gate();let first=true;
 const {c,calls,gates}=await fixture(t,{runner:async request=>{if(first){first=false;entered.resolve();await hold.promise;}return completed(request.stage==='plan'?plan:draft(request));}});gates.push(hold);
 const d=await c.create({source,settings,binding});await c.start(d.id);await entered.promise;
 const pausing=await c.pause(d.id);assert.equal(pausing.web.progress,'pausing');assert.equal(pausing.epoch,d.epoch);
 hold.resolve();const paused=await c.wait(d.id);
 assert.equal(paused.web.progress,'paused');assert.equal(paused.web.pauseRequested,true);assert.ok(paused.plan);assert.equal(paused.candidates.at(-1).status,'adopted');assert.equal(calls.length,1);
 await c.start(d.id,{mode:'next'});const resumed=await c.wait(d.id);
 assert.equal(resumed.web.pauseRequested,false);assert.equal(calls.filter(c=>c.request.stage==='plan').length,1);assert.equal(calls.at(-1).request.stage,'author');assert.equal(resumed.adopted.length,1);
});

test('pause removes a queued model call as NOT_SENT without aborting another episode',async t=>{
 const hold=gate(),entered=gate();const {c,calls,gates}=await fixture(t,{maxConcurrent:1,runner:async()=>{entered.resolve();await hold.promise;return completed(plan);}});gates.push(hold);
 const first=await c.create({source,settings,binding}),second=await c.create({source,settings,binding:{...binding,episodeId:'queued'}});
 await c.start(first.id,{mode:'next'});await entered.promise;await c.start(second.id,{mode:'next'});await until(async()=>(await c.read(second.id)).operations.length===1);
 await c.pause(second.id);const paused=await c.wait(second.id);assert.equal(paused.web.progress,'paused');assert.equal(paused.operations[0].error.requestOutcome,'NOT_SENT');assert.equal(paused.epoch,0);assert.equal(calls.length,1);
 hold.resolve();await c.wait(first.id);assert.equal(calls.length,1);assert.ok((await c.read(first.id)).plan);
});

test('explicit recovery adopts a saved late response across a hard-stop epoch without a new call',async t=>{
 const hold=gate(),entered=gate();const {c,calls,gates,dir}=await fixture(t,{runner:async()=>{entered.resolve();await hold.promise;return completed(plan);}});gates.push(hold);
 const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await entered.promise;await c.stop(d.id);hold.resolve();const stopped=await c.wait(d.id),op=stopped.operations[0],old=stopped.candidates[0];
 assert.equal(old.status,'cancelled_late');assert.equal(stopped.plan,null);
 const rawBefore=await readFile(path.join(dir,'attempts',op.attemptId,'raw.txt'),'utf8');const recovered=await c.recover(d.id,op.attemptId);
 assert.ok(recovered.plan);assert.equal(recovered.candidates[0].status,'cancelled_late');assert.equal(recovered.candidates.at(-1).status,'adopted');assert.equal(recovered.candidates.at(-1).derivedFrom,old.id);assert.equal(recovered.operations[0].epoch,op.epoch);assert.equal(recovered.operations.length,1);assert.equal(calls.length,1);
 assert.equal(await readFile(path.join(dir,'attempts',op.attemptId,'raw.txt'),'utf8'),rawBefore);
 const again=await c.recover(d.id,op.attemptId);assert.equal(again.candidates.length,recovered.candidates.length);assert.equal(calls.length,1);
});

test('saved rejected JSON recovers to repair debt, not a new paid request or a fabricated success',async t=>{
 const hold=gate(),entered=gate();const {c,calls,gates}=await fixture(t,{runner:async()=>{entered.resolve();await hold.promise;throw Object.assign(new Error('bad saved JSON'),{code:'INVALID_JSON',requestOutcome:'RESPONDED',raw:'{bad',usage:{totalTokens:10}});}});gates.push(hold);
 const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await entered.promise;await c.stop(d.id);hold.resolve();const stopped=await c.wait(d.id);
 const recovered=await c.recover(d.id,stopped.operations[0].attemptId);assert.equal(recovered.candidates.at(-1).status,'needs_repair');assert.equal(recovered.candidates[0].status,'cancelled_late');assert.equal(recovered.plan,null);assert.equal(calls.length,1);
});

test('acknowledging an aborted no-body attempt keeps UNKNOWN billing and only explicit start can retry',async t=>{
 let aborted=true;const {c,calls,dir}=await fixture(t,{runner:async(request,options)=>aborted?abortUnknown(request,options):completed(plan)});
 const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await until(()=>calls.length===1);await c.stop(d.id);const stopped=await c.wait(d.id),op=stopped.operations[0];
 const receiptFile=path.join(dir,'attempts',op.attemptId,'receipt.json'),receiptBefore=await readFile(receiptFile,'utf8');
 await assert.rejects(c.start(d.id,{mode:'next'}),{code:'ATTEMPT_UNRESOLVED'});
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:op.attemptId}),{code:'UNKNOWN_USAGE_CONFIRMATION'});
 assert.equal((await c.cancellationStatus(d.id))[0].canAcknowledge,true);
 const accepted=await c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true});
 assert.equal(accepted.web.progress,'paused','UI must leave unknown state after all cancelled attempts were acknowledged');
 assert.equal(accepted.operations[0].status,'unknown');assert.deepEqual(accepted.operations[0].error,op.error);assert.equal(accepted.operations[0].cancelAcknowledgement.acceptUnknownUsage,true);assert.equal(calls.length,1);assert.equal(await readFile(receiptFile,'utf8'),receiptBefore);
 aborted=false;await c.start(d.id,{mode:'next'});const resumed=await c.wait(d.id);assert.equal(calls.length,2);assert.ok(resumed.plan);assert.equal(resumed.operations.length,2);assert.equal(resumed.operations[0].status,'unknown');
 assert.equal((await c.cancellationStatus(d.id)).find(x=>x.attemptId===op.attemptId).canAcknowledge,false);
});

test('legacy stopped FINAL ABORTED receipts can be acknowledged without rewriting the original receipt',async t=>{
 const {c,calls,store}=await fixture(t,{runner:abortUnknown});const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await until(()=>calls.length===1);await c.stop(d.id);const stopped=await c.wait(d.id),attemptId=stopped.operations[0].attemptId;
 await store.update(d.id,x=>{delete x.operations[0].cancelReason;delete x.operations[0].cancelRequestedAt;delete x.operations[0].localSettledAt;return x;});
 assert.equal((await c.cancellationStatus(d.id))[0].canAcknowledge,true);
 await c.acknowledgeCancelled(d.id,{attemptId,acceptUnknownUsage:true});assert.equal(calls.length,1);
});

test('TIMEOUT with unconfirmed local process remains blocking, including another run of the episode',async t=>{
 const {c,calls,dir}=await fixture(t,{runner:async()=>{throw Object.assign(new Error('timed out'),{code:'TIMEOUT',requestOutcome:'UNKNOWN',usage:emptyUsage});}});
 const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});const timed=await c.wait(d.id);await c.stop(d.id);
 const file=path.join(dir,'attempts',timed.operations[0].attemptId,'receipt.json'),receipt=JSON.parse(await readFile(file,'utf8'));await writeFile(file,JSON.stringify({...receipt,localProcess:{pid:process.pid,host:hostname(),exitedAt:null}}));
 const status=(await c.cancellationStatus(d.id))[0];assert.equal(status.canAcknowledge,false);
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId:timed.operations[0].attemptId,acceptUnknownUsage:true}));
 await assert.rejects(c.start(d.id),{code:'ATTEMPT_UNRESOLVED'});const other=await c.create({source,settings,binding});await assert.rejects(c.start(other.id),{code:'EPISODE_UNRESOLVED'});assert.equal(calls.length,1);
});

test('saved bodies must be recovered, never acknowledged as absent; stale source cannot be recovered',async t=>{
 const hold=gate(),entered=gate();let fresh=true;const {c,gates}=await fixture(t,{beforeExecute:async()=>fresh,runner:async()=>{entered.resolve();await hold.promise;return completed(plan);}});gates.push(hold);
 const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await entered.promise;await c.stop(d.id);hold.resolve();const stopped=await c.wait(d.id),attemptId=stopped.operations[0].attemptId;
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId,acceptUnknownUsage:true}));fresh=false;
 await assert.rejects(c.recover(d.id,attemptId),{code:'SOURCE_STALE'});assert.equal((await c.read(d.id)).plan,null);
});

test('accepted unknown cost does not bypass the call budget or make known missing usage zero',async t=>{
 let aborted=true;const {c,calls}=await fixture(t,{runner:async(req,options)=>aborted?abortUnknown(req,options):completed(plan)});
 const d=await c.create({source,settings,binding,budget:{maxCalls:1,maxTokens:100}});await c.start(d.id,{mode:'next'});await until(()=>calls.length===1);await c.stop(d.id);const stopped=await c.wait(d.id);
 await c.acknowledgeCancelled(d.id,{attemptId:stopped.operations[0].attemptId,acceptUnknownUsage:true});aborted=false;await c.start(d.id,{mode:'next'});const blocked=await c.wait(d.id);
 assert.equal(blocked.web.progress,'budget_stop');assert.equal(calls.length,1);assert.equal(blocked.operations[0].receipt.usage.totalTokens,null);
});

test('historical independent stopped authors recover one at a time without treating each other as scope conflicts',async t=>{
 const {c,calls,dir,store}=await fixture(t),d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});const planned=await c.wait(d.id),authors=[];
 // Reproduce saved pre-serial history directly; the current scheduler must never dispatch these in parallel.
 for(const w of planned.plan.workPackages){
  const attemptId=`historical-author-${w.id}`,request=buildRequest({stage:'author',source:planned.source,settings:planned.settings,plan:planned.plan,choice:planned.choice,packageId:w.id,packageIds:[w.id],previousDraft:null,voiceReference:planned.voiceReference,rulesSnapshot:planned.rulesSnapshot,dependencyExits:{},issues:[],finishMode:'full'}),folder=path.join(dir,'attempts',attemptId);
  const fingerprint=digest([request.promptHash,request.instructionHash,request.inputHash]);
  authors.push({attemptId,stage:'author',packageIds:[w.id],previousDraft:null,issues:[],finishMode:'full',baseDraftHash:null,dependencyFormat:'continuity-v1',fingerprint,epoch:planned.epoch,status:'unknown',createdAt:new Date().toISOString(),cancelReason:'user_stop',error:{code:'ABORTED',message:'saved pre-serial interruption',requestOutcome:'UNKNOWN'}});
  await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'request.json'),JSON.stringify(request));await writeFile(path.join(folder,'raw.txt'),JSON.stringify(draft(request)));await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED',usage:{totalTokens:10}}));
 }
 await store.update(d.id,x=>{x.operations.push(...authors);x.epoch++;x.status='cancelled';x.web.stopped=true;x.web.progress='stopped';return x;});
 const first=await c.recover(d.id,authors[0].attemptId);assert.deepEqual(first.adopted.flatMap(a=>a.packageIds),['p1']);assert.equal(first.operations.find(o=>o.attemptId===authors[1].attemptId).status,'unknown');assert.equal(calls.length,1);
 const stopped=await c.recover(d.id,authors[1].attemptId);
 assert.equal(stopped.adopted.length,2);assert.equal(calls.length,1);assert.ok(stopped.operations.every(o=>o.status==='completed'));
 assert.deepEqual(stopped.operations.filter(o=>o.stage==='author').map(o=>o.fingerprint),authors.map(o=>o.fingerprint));
});

test('recheck of an explicitly recovered old-epoch repair candidate remains free and adoptable',async t=>{
 const hold=gate(),entered=gate();const {c,calls,gates,store}=await fixture(t,{runner:async()=>{entered.resolve();await hold.promise;return completed(plan);}});gates.push(hold);
 const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await entered.promise;await c.stop(d.id);hold.resolve();const stopped=await c.wait(d.id);
 const recovered=await c.recover(d.id,stopped.operations[0].attemptId),candidateId=recovered.candidates.at(-1).id;
 await store.update(d.id,document=>{document.candidates.find(candidate=>candidate.id===candidateId).status='needs_repair';return document;});
 const checked=await c.recheck(d.id,candidateId);
 assert.equal(checked.candidates.at(-1).status,'adopted');assert.equal(calls.length,1);
});

test('acknowledging one aborted run cannot silently acknowledge a sibling run',async t=>{
 const {c,calls,store,dir}=await fixture(t,{runner:abortUnknown});const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await until(()=>calls.length===1);await c.stop(d.id);const stopped=await c.wait(d.id);
 const other=await c.create({source,settings,binding}),old=stopped.operations[0],attemptId='legacy-other-aborted',folder=path.join(dir,'attempts',attemptId);await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'UNKNOWN',errorCode:'ABORTED',usage:emptyUsage}));
 await store.update(other.id,x=>{x.epoch=1;x.web.stopped=true;x.web.progress='stopped';x.operations=[{...old,attemptId}];return x;});
 await c.acknowledgeCancelled(d.id,{attemptId:old.attemptId,acceptUnknownUsage:true});await assert.rejects(c.start(d.id),{code:'EPISODE_UNRESOLVED'});
 assert.equal((await c.read(other.id)).operations[0].cancelAcknowledgement,undefined);assert.equal(calls.length,1);
});

test('start next recovers a completed late plan for free and treats recovery as the one step',async t=>{
 const hold=gate(),entered=gate();const {c,calls,gates}=await fixture(t,{runner:async request=>{if(request.stage==='plan'){entered.resolve();await hold.promise;}return completed(request.stage==='plan'?plan:draft(request));}});gates.push(hold);
 const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await entered.promise;await c.stop(d.id);hold.resolve();await c.wait(d.id);
 await c.start(d.id,{mode:'next'});const restored=await c.wait(d.id);assert.ok(restored.plan);assert.equal(calls.length,1);assert.equal(restored.operations.length,1);assert.equal(restored.candidates[0].status,'cancelled_late');assert.equal(restored.candidates.at(-1).status,'adopted');
});

test('start next restores a persisted response of an UNKNOWN operation before considering a retry',async t=>{
 const {c,calls,dir}=await fixture(t,{runner:abortUnknown});const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await until(()=>calls.length===1);await c.stop(d.id);const stopped=await c.wait(d.id),attemptId=stopped.operations[0].attemptId,folder=path.join(dir,'attempts',attemptId);
 await writeFile(path.join(folder,'raw.txt'),'```json\n'+JSON.stringify(plan).replace(/}$/,',}')+'\n```');await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'RESPONDED',usage:{totalTokens:10}}));
 await c.start(d.id,{mode:'next'});const restored=await c.wait(d.id);assert.ok(restored.plan);assert.equal(calls.length,1);assert.equal(restored.operations[0].status,'completed');assert.equal(restored.operations[0].error.requestOutcome,'UNKNOWN');
});

test('continue all restores the late serial author and buys only the missing author and finish',async t=>{
 const hold=gate();let authored=0;const {c,calls,gates}=await fixture(t,{runner:async request=>{if(request.stage==='author'){authored++;await hold.promise;}return completed(request.stage==='plan'?plan:request.stage==='finish'?{schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:['u-r1','u-r2'],replacements:[],revisionNotes:[],unresolved:[]}:draft(request));}});gates.push(hold);
 const d=await c.create({source,settings,binding});await c.start(d.id);await until(()=>authored===1);
 assert.deepEqual((await c.read(d.id)).operations.filter(o=>o.stage==='author').map(o=>o.packageIds),[['p1']]);
 await c.stop(d.id);hold.resolve();const stopped=await c.wait(d.id),late=stopped.operations.find(o=>o.stage==='author');assert.equal(stopped.adopted.length,0);assert.equal(stopped.operations.length,2);assert.equal(stopped.candidates.find(c=>c.attemptId===late.attemptId).status,'cancelled_late');
 await c.start(d.id);const finished=await c.wait(d.id);
 assert.equal(finished.status,'text_ready_for_review');assert.equal(calls.filter(x=>x.request.stage==='plan').length,1);assert.equal(calls.filter(x=>x.request.stage==='author').length,2);assert.equal(calls.filter(x=>x.request.stage==='finish').length,1);assert.equal(finished.operations.length,4);
 assert.deepEqual(calls.filter(x=>x.request.stage==='author').map(x=>x.request.packageIds),[['p1'],['p2']]);assert.equal(finished.operations.find(o=>o.attemptId===late.attemptId).fingerprint,late.fingerprint);assert.equal(finished.operations.find(o=>o.attemptId===late.attemptId).recovery.epoch,finished.epoch);
});

test('resume after a paused author preserves the adopted draft and waits before issuing the next package',async t=>{
 const hold=gate(),entered=gate();const {c,calls,gates}=await fixture(t,{maxConcurrent:1,runner:async request=>{if(request.stage==='author'&&request.packageIds[0]==='p1'){entered.resolve();await hold.promise;}return completed(request.stage==='plan'?plan:draft(request));}});gates.push(hold);
 const d=await c.create({source,settings,binding});await c.start(d.id);await entered.promise;await c.pause(d.id);hold.resolve();const paused=await c.wait(d.id);assert.deepEqual(paused.adopted.flatMap(x=>x.packageIds),['p1']);const saved=structuredClone(paused.adopted[0]);
 await c.start(d.id,{mode:'next'});const resumed=await c.wait(d.id);assert.deepEqual(resumed.adopted.find(x=>x.packageIds.includes('p1')),saved);assert.equal(calls.filter(x=>x.request.stage==='author'&&x.request.packageIds[0]==='p1').length,1);assert.equal(calls.at(-1).request.packageIds[0],'p2');
});

test('recovery refuses changed request identity, current rules and same-scope unknown conflicts',async t=>{
 const hold=gate(),entered=gate();const {c,gates,store,dir,calls}=await fixture(t,{runner:async()=>{entered.resolve();await hold.promise;return completed(plan);}});gates.push(hold);
 const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await entered.promise;await c.stop(d.id);hold.resolve();const stopped=await c.wait(d.id),op=stopped.operations[0],requestFile=path.join(dir,'attempts',op.attemptId,'request.json'),originalRequest=await readFile(requestFile,'utf8');
 await writeFile(requestFile,JSON.stringify({...JSON.parse(originalRequest),inputHash:'changed'}));await assert.rejects(c.recover(d.id,op.attemptId),{code:'ATTEMPT_CONFLICT'});await writeFile(requestFile,originalRequest);
 await store.update(d.id,x=>{x.operations.push({...op,attemptId:'other-unknown',status:'unknown',error:{code:'TIMEOUT',requestOutcome:'UNKNOWN'}});return x;});await assert.rejects(c.recover(d.id,op.attemptId),{code:'RECOVERY_BUSY'});
 await store.update(d.id,x=>{x.operations.pop();x.rulesSnapshot.instructions+=' changed';return x;});await assert.rejects(c.recover(d.id,op.attemptId),{code:'STALE_CANDIDATE'});assert.equal((await c.read(d.id)).plan,null);assert.equal(calls.length,1);
});

test('a live local process receipt cannot be acknowledged even if the document looks stopped',async t=>{
 const {c,calls,dir}=await fixture(t,{runner:abortUnknown});const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await until(()=>calls.length===1);await c.stop(d.id);const stopped=await c.wait(d.id),attemptId=stopped.operations[0].attemptId,receiptFile=path.join(dir,'attempts',attemptId,'receipt.json'),receipt=JSON.parse(await readFile(receiptFile,'utf8'));
 receipt.localProcess={pid:process.pid,host:(await import('node:os')).hostname(),exitedAt:null};await writeFile(receiptFile,JSON.stringify(receipt));assert.equal((await c.cancellationStatus(d.id))[0].canAcknowledge,false);await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId,acceptUnknownUsage:true}),{code:'RUN_ACTIVE'});assert.equal(calls.length,1);
});

test('legacy missing-pid cancellation cannot be acknowledged while a process references its exact attempt directory',async t=>{
 const {c,calls,dir,store}=await fixture(t,{runner:abortUnknown});const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await until(()=>calls.length===1);await c.stop(d.id);const stopped=await c.wait(d.id),attemptId=stopped.operations[0].attemptId,folder=path.join(dir,'attempts',attemptId),receiptFile=path.join(folder,'receipt.json'),originalReceipt=await readFile(receiptFile,'utf8');
 await store.update(d.id,x=>{delete x.operations[0].cancelReason;delete x.operations[0].cancelRequestedAt;delete x.operations[0].localSettledAt;return x;});
 const child=childProcess.spawn(process.execPath,['-e','setInterval(()=>{},1000)',path.join(folder,'raw.txt')],{stdio:'ignore'});await once(child,'spawn');
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill();await closed;}});
 const status=(await c.cancellationStatus(d.id))[0];assert.equal(status.canAcknowledge,false);assert.equal(status.code,'RUN_ACTIVE');
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId,acceptUnknownUsage:true}),{code:'RUN_ACTIVE'});assert.equal((await c.read(d.id)).operations[0].cancelAcknowledgement,undefined);process.kill(child.pid,0);
 const closed=once(child,'close');child.kill();await closed;
 assert.equal((await c.cancellationStatus(d.id))[0].canAcknowledge,true);await c.acknowledgeCancelled(d.id,{attemptId,acceptUnknownUsage:true});assert.equal(await readFile(receiptFile,'utf8'),originalReceipt);assert.equal(calls.length,1);
});

test('legacy process verification fails closed when the local process inventory cannot be read',async t=>{
 const {c,calls}=await fixture(t,{runner:abortUnknown});const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await until(()=>calls.length===1);await c.stop(d.id);const stopped=await c.wait(d.id),attemptId=stopped.operations[0].attemptId;
 t.mock.method(childProcess,'execFile',(_file,_args,_options,callback)=>callback(new Error('process inventory unavailable')));
 const status=(await c.cancellationStatus(d.id))[0];assert.equal(status.canAcknowledge,false);assert.equal(status.code,'PROCESS_UNVERIFIED');
 await assert.rejects(c.acknowledgeCancelled(d.id,{attemptId,acceptUnknownUsage:true}),{code:'PROCESS_UNVERIFIED'});assert.equal((await c.read(d.id)).operations[0].cancelAcknowledgement,undefined);assert.equal(calls.length,1);
});

test('legacy process scan does not confuse a different attempt with the same id prefix',async t=>{
 const {c,calls,dir}=await fixture(t,{runner:abortUnknown});const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});await until(()=>calls.length===1);await c.stop(d.id);const stopped=await c.wait(d.id),attemptId=stopped.operations[0].attemptId;
 const child=childProcess.spawn(process.execPath,['-e','setInterval(()=>{},1000)',path.join(dir,'attempts',attemptId+'-different','raw.txt')],{stdio:'ignore'});await once(child,'spawn');
 t.after(async()=>{const closed=once(child,'close');child.kill();await closed;});
 assert.equal((await c.cancellationStatus(d.id))[0].canAcknowledge,true);await c.acknowledgeCancelled(d.id,{attemptId,acceptUnknownUsage:true});process.kill(child.pid,0);assert.equal(calls.length,1);
});

test('unconfirmed TIMEOUT stays blocking, including another run of the episode',async t=>{
 const {c,calls,timed,op}=await timedAttempt(t);
 await assert.rejects(c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId}),{code:'UNKNOWN_USAGE_CONFIRMATION'});
 await assert.rejects(c.start(timed.id),{code:'ATTEMPT_UNRESOLVED'});const other=await c.create({source,settings,binding});await assert.rejects(c.start(other.id),{code:'EPISODE_UNRESOLVED'});assert.equal(calls.length,1);
});

test('no-body author TIMEOUT can be acknowledged without stop or calls; separate start preserves plan and authors anew',async t=>{
 let timedOut=true;const {c,calls,dir}=await fixture(t,{maxConcurrent:1,runner:async request=>request.stage==='author'&&timedOut?timeoutUnknown():completed(request.stage==='plan'?plan:draft(request))});
 const d=await c.create({source,settings,binding});await c.start(d.id,{mode:'next'});const planned=await c.wait(d.id);
 await c.start(d.id,{mode:'next'});const timed=await c.wait(d.id),op=timed.operations.at(-1),folder=path.join(dir,'attempts',op.attemptId),receiptFile=path.join(folder,'receipt.json'),requestFile=path.join(folder,'request.json');
 assert.equal(timed.web.stopped,false);assert.equal(timed.web.progress,'unknown');assert.equal(op.error.code,'TIMEOUT');
 const [receiptBefore,requestBefore]=await Promise.all([readFile(receiptFile,'utf8'),readFile(requestFile,'utf8')]);
 const status=(await c.cancellationStatus(d.id)).find(x=>x.attemptId===op.attemptId);assert.equal(status.canAcknowledge,true);assert.equal(status.kind,'timeout');assert.match(status.reason,/超时/);
 const acknowledged=await c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true});
 assert.equal(calls.length,2);assert.equal(acknowledged.web.progress,'paused');assert.equal(acknowledged.web.error,null);assert.deepEqual(acknowledged.plan,planned.plan);assert.equal(acknowledged.status,'unknown');
 const {cancelAcknowledgement,...afterOp}=acknowledged.operations.at(-1);assert.deepEqual(afterOp,op);assert.equal(cancelAcknowledgement.reason,'TIMEOUT');assert.equal(cancelAcknowledgement.acceptUnknownUsage,true);assert.equal(afterOp.receipt.usage.totalTokens,null);
 assert.equal(await readFile(receiptFile,'utf8'),receiptBefore);assert.equal(await readFile(requestFile,'utf8'),requestBefore);
 timedOut=false;await c.start(d.id,{mode:'next'});const resumed=await c.wait(d.id);
 assert.equal(calls.length,3);assert.equal(calls.at(-1).request.stage,'author');assert.notEqual(resumed.operations.at(-1).attemptId,op.attemptId);assert.equal(calls.filter(x=>x.request.stage==='plan').length,1);assert.deepEqual(resumed.plan,planned.plan);
 const again=await c.acknowledgeCancelled(d.id,{attemptId:op.attemptId,acceptUnknownUsage:true});assert.equal(again.web.progress,resumed.web.progress);assert.equal(calls.length,3);
});

test('TIMEOUT acknowledgement refuses absent, corrupt, mismatched or unfinished receipt evidence',async t=>{
 for(const [name,receipt] of [['missing',null],['corrupt','{'],['not-final',{state:'SUBMITTING',requestOutcome:'UNKNOWN',errorCode:'TIMEOUT'}],['wrong-outcome',{state:'FINAL',requestOutcome:'RESPONDED',errorCode:'TIMEOUT'}],['wrong-cause',{state:'FINAL',requestOutcome:'UNKNOWN',errorCode:'ABORTED'}]])await t.test(name,async t=>{
  const {c,calls,timed,op,folder}=await timedAttempt(t),file=path.join(folder,'receipt.json');
  if(receipt===null)await rm(file);else await writeFile(file,typeof receipt==='string'?receipt:JSON.stringify(receipt));
  const status=(await c.cancellationStatus(timed.id))[0];assert.equal(status.canAcknowledge,false);assert.equal(status.code,'RECEIPT_UNRESOLVED');
  await assert.rejects(c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true}),{code:'RECEIPT_UNRESOLVED'});assert.equal(calls.length,1);
 });
});

test('TIMEOUT acknowledgement refuses saved raw, event-final or nonempty structured candidate',async t=>{
 for(const kind of ['raw.txt','event-final.txt','output','draft'])await t.test(kind,async t=>{
  const {c,calls,timed,op,folder,store}=await timedAttempt(t);
  if(kind.endsWith('.txt'))await writeFile(path.join(folder,kind),'saved body');
  else await store.update(timed.id,d=>{d.candidates.push({attemptId:op.attemptId,raw:null,[kind]:{units:[{id:'saved'}]}});return d;});
  assert.equal((await c.cancellationStatus(timed.id))[0].code,'RECOVER_RESPONSE_FIRST');
  await assert.rejects(c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true}),{code:'RECOVER_RESPONSE_FIRST'});assert.equal(calls.length,1);
 });
});

test('TIMEOUT acknowledgement fails closed for live, malformed and unverifiable process proof',async t=>{
 const cases=[['live',{pid:process.pid,host:hostname(),exitedAt:null},'RUN_ACTIVE'],['live-with-exit',{pid:process.pid,host:hostname(),exitedAt:new Date().toISOString()},'RUN_ACTIVE'],['invalid-pid',{pid:0,host:hostname(),exitedAt:null},'PROCESS_UNVERIFIED'],['malformed',{},'PROCESS_UNVERIFIED'],['foreign-host',{pid:123,host:'other-host',exitedAt:null},'PROCESS_UNVERIFIED'],['invalid-exit',{pid:123,host:hostname(),exitedAt:'not-a-time'},'PROCESS_UNVERIFIED'],['future-exit',{pid:99999999,host:hostname(),exitedAt:new Date(Date.now()+60000).toISOString()},'PROCESS_UNVERIFIED'],['reversed-times',{pid:99999999,host:hostname(),startedAt:new Date().toISOString(),exitedAt:'2020-01-01T00:00:00.000Z'},'PROCESS_UNVERIFIED'],['blank-host',{pid:99999999,host:' ',exitedAt:'2020-01-01T00:00:00.000Z'},'PROCESS_UNVERIFIED']];
 for(const [name,localProcess,code] of cases)await t.test(name,async t=>{
  const {c,calls,timed,op,folder}=await timedAttempt(t),file=path.join(folder,'receipt.json'),receipt=JSON.parse(await readFile(file,'utf8'));await writeFile(file,JSON.stringify({...receipt,localProcess}));
  assert.equal((await c.cancellationStatus(timed.id))[0].code,code);await assert.rejects(c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true}),{code});assert.equal(calls.length,1);
 });
 await t.test('legacy-inventory-failed',async t=>{
  const {c,timed,op}=await timedAttempt(t);t.mock.method(childProcess,'execFile',(_file,_args,_options,callback)=>callback(new Error('inventory failed')));
  assert.equal((await c.cancellationStatus(timed.id))[0].code,'PROCESS_UNVERIFIED');await assert.rejects(c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true}),{code:'PROCESS_UNVERIFIED'});
 });
});

test('TIMEOUT acknowledgement never accepts a different UNKNOWN cause or conflicting operation outcome',async t=>{
 for(const error of [{code:'CLI_FAILED',requestOutcome:'UNKNOWN'},{code:'TIMEOUT',requestOutcome:'RESPONDED'}])await t.test(error.code+error.requestOutcome,async t=>{
  const {c,timed,op,store}=await timedAttempt(t);await store.update(timed.id,d=>{d.operations[0].error=error;return d;});
  assert.equal((await c.cancellationStatus(timed.id))[0].canAcknowledge,false);await assert.rejects(c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true}),{code:error.code==='CLI_FAILED'?'RECEIPT_UNRESOLVED':'NOT_FAILED'});
 });
});

test('TIMEOUT acknowledgement refuses unfinished own work and a same-episode live owner',async t=>{
 const {c,calls,timed,op,store}=await timedAttempt(t);
 await store.update(timed.id,d=>{d.operations.push({...op,attemptId:'still-running',status:'running'});return d;});
 await assert.rejects(c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true}),{code:'RUN_ACTIVE'});
 await store.update(timed.id,d=>{d.operations.pop();return d;});const sibling=await c.create({source,settings,binding});await store.update(sibling.id,d=>{d.web.owner=process.pid;return d;});
 assert.equal((await c.cancellationStatus(timed.id))[0].code,'EPISODE_BUSY');await assert.rejects(c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true}),{code:'EPISODE_BUSY'});assert.equal(calls.length,1);
});

test('concurrent TIMEOUT acknowledgements are atomic, repeated confirmation is free, and siblings stay unresolved',async t=>{
 const {c,calls,timed,op,store,dir}=await timedAttempt(t),other=await c.create({source,settings,binding}),otherId='sibling-timeout',folder=path.join(dir,'attempts',otherId);
 await mkdir(folder,{recursive:true});await writeFile(path.join(folder,'receipt.json'),JSON.stringify({state:'FINAL',requestOutcome:'UNKNOWN',errorCode:'TIMEOUT',usage:emptyUsage}));
 await store.update(other.id,d=>{d.operations=[{...op,attemptId:otherId}];d.status='unknown';d.web.progress='unknown';return d;});
 const ack=()=>c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true}),results=await Promise.allSettled([ack(),ack()]);
 assert.ok(results.some(r=>r.status==='fulfilled'));assert.ok(results.every(r=>r.status==='fulfilled'||r.reason.code==='EPISODE_BUSY'));
 const first=await c.read(timed.id),second=await ack();assert.deepEqual(second.operations[0].cancelAcknowledgement,first.operations[0].cancelAcknowledgement);assert.equal(calls.length,1);assert.equal((await c.read(other.id)).operations[0].cancelAcknowledgement,undefined);
 await assert.rejects(c.start(timed.id),{code:'EPISODE_UNRESOLVED'});
});

test('TIMEOUT acknowledgement can release historical fee debt but cannot bypass stale source or call budget',async t=>{
 let fresh=true;const {c,calls,timed,op}=await timedAttempt(t,{beforeExecute:async()=>fresh});fresh=false;
 await c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true});await c.start(timed.id,{mode:'next'});const stale=await c.wait(timed.id);
 assert.equal(stale.web.progress,'source_stale');assert.equal(stale.web.sourceStale,true);assert.equal(calls.length,1);assert.equal(stale.operations[0].receipt.usage.totalTokens,null);
 const again=await c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true});assert.equal(again.web.progress,'source_stale');
 await t.test('budget',async t=>{const {c,calls,timed,op}=await timedAttempt(t);await c.setBudget(timed.id,{maxCalls:1,maxTokens:100});await c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true});await c.start(timed.id,{mode:'next'});assert.equal((await c.wait(timed.id)).web.progress,'budget_stop');assert.equal(calls.length,1);});
});

test('user-stop acknowledgement still requires stopped state and user-stop provenance',async t=>{
 const {c,timed,op,store,folder}=await timedAttempt(t),file=path.join(folder,'receipt.json'),receipt=JSON.parse(await readFile(file,'utf8'));
 await writeFile(file,JSON.stringify({...receipt,errorCode:'ABORTED'}));await store.update(timed.id,d=>{d.operations[0].error.code='ABORTED';d.operations[0].cancelReason='user_stop';return d;});
 assert.equal((await c.cancellationStatus(timed.id))[0].code,'STOP_REQUIRED');await assert.rejects(c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true}),{code:'STOP_REQUIRED'});
 await store.update(timed.id,d=>{d.web.stopped=true;d.operations[0].cancelReason='shutdown';return d;});await assert.rejects(c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true}),{code:'NOT_USER_CANCELLED'});
});

test('TIMEOUT acknowledgement preserves unrelated UI errors and rejects an epoch change during evidence check',async t=>{
 const {c,timed,op,store}=await timedAttempt(t);await store.update(timed.id,d=>{d.web.error={code:'OTHER_PROBLEM',message:'keep this'};return d;});
 const originalExecFile=childProcess.execFile;
 const mock=t.mock.method(childProcess,'execFile',function(...args){const callback=args.pop();store.update(timed.id,d=>{d.epoch++;return d;}).then(()=>originalExecFile.call(this,...args,callback),callback);});
 await assert.rejects(c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true}),{code:'RUN_ACTIVE'});mock.mock.restore();assert.equal((await c.read(timed.id)).operations[0].cancelAcknowledgement,undefined);
 const acknowledged=await c.acknowledgeCancelled(timed.id,{attemptId:op.attemptId,acceptUnknownUsage:true});assert.deepEqual(acknowledged.web.error,{code:'OTHER_PROBLEM',message:'keep this'});assert.equal(acknowledged.web.progress,'paused');
});
