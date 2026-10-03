import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {normalizeSource} from './core/source.mjs';
import {PLAN_VERSION,VERSION} from './core/shared.mjs';
import {DELTA_VERSION} from './core/delta.mjs';
import {createCoordinator} from './core/legacy-test-fixtures.mjs';
import {createStore} from './core/store.mjs';

const source={key:'recovery',sourceRows:[{id:'now',text:'甲：我还没输！'}],contextRows:[{id:'before1',text:'△甲收起护罩。'},{id:'before2',text:'△乙转身离开。'}]};
const fact={id:'EF1',subject:'甲和乙',statement:'护罩已收起，乙已离开',sourceRefs:['before1','before2'],evidence:'甲收起护罩。／△乙转身离开。'};
const plan=(evidence=fact.evidence)=>({schemaVersion:PLAN_VERSION,emotionArc:'不甘与坚持',entryFacts:[{...fact,evidence}],workPackages:[{id:'P1',sourceRefs:['now'],emotionContract:{subject:'甲',contextTone:'严肃',audienceEffect:'感到不甘',change:'受压仍坚持',landing:'抬头',retain:['不搞笑']},entryFactIds:['EF1'],contextRefs:['before1','before2'],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'U1',packageId:'P1',sourceRefs:['now'],secondsRange:[3,8]}],fantasyCandidates:[]});
const settings={maxUnits:null,fantasyMode:'off'},binding={projectId:'p',episodeId:'e',sourceVersion:'v1'};
const error={code:'ENTRY_FACT_EVIDENCE',message:'前情事实EF1依据无法在原文定位'};

test('separated citations match each referenced row exactly and normalize idempotently',()=>{
 for(const separator of ['／','\n',' | ']){
  const normalized=normalizeSource({...source,entryFacts:[{...fact,evidence:['甲收起护罩。','△乙转身离开。'].join(separator)}]});
  assert.deepEqual(normalized.entryFacts[0].evidence,['甲收起护罩。','△乙转身离开。']);
  assert.deepEqual(normalizeSource(normalized),normalized);
 }
 for(const bad of [
  {...fact,evidence:'甲升起护罩。／△乙转身离开。'},
  {...fact,sourceRefs:['before2','before1']},
  {...fact,evidence:'甲收起／护罩。／△乙转身离开。'},
  {...fact,evidence:['甲收起护罩。','编造的事件']},
  {...fact,sourceRefs:['before1','missing']},
  {...fact,evidence:{text:'收起护罩'}},
 ])assert.throws(()=>normalizeSource({...source,entryFacts:[bad]}));
 assert.equal(normalizeSource({...source,entryFacts:[{...fact,sourceRefs:['before1'],evidence:'收起护罩'}]}).entryFacts[0].evidence,'收起护罩');
});

test('explicit source_rows mode derives evidence without model transcription, never hides supplied bad text',()=>{
 const {evidence,...base}=fact;
 const normalized=normalizeSource({...source,entryFacts:[{...base,evidenceMode:'source_rows'}]});
 assert.deepEqual(normalized.entryFacts[0].evidence,source.contextRows.map(r=>r.text));
 assert.deepEqual(normalizeSource(normalized),normalized);
 assert.throws(()=>normalizeSource({...source,entryFacts:[base]}));
 assert.throws(()=>normalizeSource({...source,entryFacts:[{...base,evidenceMode:'source_rows',evidence:'甲已痊愈'}]}));
 assert.throws(()=>normalizeSource({...source,entryFacts:[{...base,evidenceMode:'anything'}]}));
});

async function fixture(fn,output=plan()){
 const dir=await mkdtemp(path.join(tmpdir(),'v4-plan-recovery-')),calls=[];
 const c=createCoordinator({dataRoot:dir,modelRunner:async request=>{calls.push(request);return {output:typeof output==='function'?output(request,calls.length):output,raw:JSON.stringify(typeof output==='function'?output(request,calls.length):output),usage:{inputTokens:80,outputTokens:20,cachedInputTokens:0,totalTokens:100},requestOutcome:'RESPONDED'};}});
 try{const d=await c.create({source,settings,binding});await fn({c,d,calls,store:createStore(dir)});}finally{await c.shutdown();await rm(dir,{recursive:true,force:true});}
}

test('saved rejected plan is rechecked for free before any new request, even at zero budget',async()=>fixture(async({c,d,calls,store})=>{
 await c.start(d.id,{mode:'next'});await c.wait(d.id);
 await store.update(d.id,x=>{x.plan=null;x.status='needs_repair';x.web.progress='running';x.candidates[0].status='needs_repair';x.candidates[0].errors=[error];delete x.candidates[0].validatorVersion;return x;});
 const before=await c.read(d.id),raw=before.candidates[0].raw;
 await c.setBudget(d.id,{maxCalls:0,maxTokens:0});
 await c.start(d.id,{mode:'next'});await c.wait(d.id);
 const after=await c.read(d.id);
 assert.ok(after.plan,'already-paid candidate should be recovered');assert.equal(after.web.progress,'planned');
 assert.equal(calls.length,1);assert.equal(after.operations.length,1);
 assert.equal(after.candidates[0].raw,raw);assert.ok(after.candidates[0].resolvedBy);
 assert.deepEqual(after.candidates.at(-1).normalizations.map(x=>x.field),['evidence']);
}));

test('failed first plan exposes settled state and repeated identical repair stops new paid retries',async()=>fixture(async({c,d,calls})=>{
 await c.start(d.id,{mode:'next'});await c.wait(d.id);
 const first=await c.read(d.id);assert.equal(first.web.progress,'needs_repair');assert.equal(calls.length,1);
 await c.start(d.id,{mode:'all'});await c.wait(d.id);
 const after=await c.read(d.id);
 assert.equal(after.web.progress,'needs_repair');assert.equal(calls.length,2);
 assert.match(after.operations[1].previousDraft.rawText,/凭空编造/);assert.ok(calls[1].prompt.includes('ENTRY_FACT_EVIDENCE'));assert.match(calls[1].prompt,/凭空编造/);
 await c.start(d.id,{mode:'all'});await c.wait(d.id);
 assert.equal(calls.length,2,'same unchanged failure must not keep buying another plan');
},plan('凭空编造')));

test('targeted planning repair preserves the previous response and can succeed without replaying authors',async()=>fixture(async({c,d,calls})=>{
 await c.start(d.id,{mode:'next'});await c.wait(d.id);
 await c.start(d.id,{mode:'next'});await c.wait(d.id);
 const after=await c.read(d.id);assert.ok(after.plan);assert.equal(after.web.progress,'planned');assert.equal(calls.length,2);
 assert.deepEqual(calls.map(x=>x.stage),['plan','plan']);assert.match(after.operations[1].previousDraft.rawText,/凭空编造/);assert.match(calls[1].prompt,/凭空编造/);
 assert.equal(after.adopted.length,0);assert.equal(after.web.autoRepairs,1);
},(_r,count)=>count===1?plan('凭空编造'):plan()));

test('continuous mode repairs planning once then runs author and finish, without an extra planning call',async()=>fixture(async({c,d,calls})=>{
 await c.start(d.id,{mode:'all'});await c.wait(d.id);
 const result=await c.read(d.id);
 assert.equal(result.status,'text_ready_for_review',JSON.stringify(result.web));
 assert.deepEqual(calls.map(x=>x.stage),['plan','plan','author','finish']);
 assert.equal(result.web.autoRepairs,1);assert.equal(result.web.owner,null);
},(request,count)=>{
 if(request.stage==='plan')return count===1?plan('凭空编造'):plan();
 if(request.stage==='finish')return {schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:['P1-U1'],replacements:[],revisionNotes:[],unresolved:[]};
 return {schemaVersion:VERSION,units:[{id:'P1-U1',title:'不甘',intent:{subject:'甲',change:'受压仍坚持',landing:'抬头',retain:['严肃']},scene:'城墙',props:[],participants:['甲'],lighting:'冷光',initialState:'低头',exitState:'抬头',shots:[{id:'P1-S1',duration:4,camera:'近景',picture:'甲抬头咬牙说出原话。',lighting:'冷光',sound:'现场人声',dialogueParts:[{lineId:request.source.dialogue[0].id,text:'我还没输！',presentation:'画内',delivery:'咬牙',voiceStart:0,voiceEnd:2}],transition:'切',sourceRefs:['now']}]}],fantasyRealization:[]};
}));

test('automatic plan repair respects the remaining call budget and does not spend a retry when no call was admitted',async()=>fixture(async({c,d,calls})=>{
 await c.setBudget(d.id,{maxCalls:1,maxTokens:300000});
 await c.start(d.id,{mode:'all'});await c.wait(d.id);
 const result=await c.read(d.id);
 assert.equal(calls.length,1);assert.equal(result.web.progress,'budget_stop');assert.equal(result.web.autoRepairs,0);
},plan('凭空编造')));

test('failed replan with an older valid plan is repaired by planner, never an empty-package finisher',async()=>fixture(async({c,d,calls})=>{
 await c.start(d.id,{mode:'next'});await c.wait(d.id);
 await c.replan(d.id);await c.wait(d.id);
 assert.ok((await c.read(d.id)).plan,'keep last valid plan while failed replan awaits repair');
 await c.start(d.id,{mode:'next'});await c.wait(d.id);
 const after=await c.read(d.id);
 assert.equal(after.web.progress,'planned');assert.deepEqual(calls.map(x=>x.stage),['plan','plan','plan']);
 assert.match(after.operations[2].previousDraft.rawText,/凭空编造/);
 assert.equal(after.web.autoRepairs,1);
},(_r,count)=>count===2?plan('凭空编造'):plan()));
