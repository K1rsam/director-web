import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine} from './core/legacy-test-fixtures.mjs';
import {createStore} from './core/store.mjs';
import {PLAN_VERSION,VERSION} from './core/shared.mjs';

const source={key:'recheck',sourceRows:[{id:'r1',text:'甲：走。'}]};
const emotionContract={subject:'甲',contextTone:'紧张',audienceEffect:'期待',change:'决定',landing:'迈步',retain:['原话']};
const plan={schemaVersion:PLAN_VERSION,emotionArc:'犹豫到行动',entryFacts:[],workPackages:[{id:'p1',sourceRefs:['r1'],emotionContract,dependsOn:[]}],provisionalUnits:[{id:'u1',packageId:'p1',sourceRefs:['r1'],secondsRange:[2,5]}],fantasyCandidates:[]};
const draft={schemaVersion:VERSION,units:[{id:'p1-u1',title:'行动',intent:{subject:'甲',change:'下定决心',landing:'迈步',retain:['原话']},scene:'室内',props:[],participants:['甲'],lighting:'室内暖光',initialState:'站立',exitState:'转身',shots:[{id:'p1-s1',duration:3,camera:'中景固定',picture:'甲开口后转身。',lighting:'暖光',sound:'人声',dialogueParts:[{lineId:'r1:D1',text:'走。',presentation:'画内',delivery:'短促',voiceStart:0,voiceEnd:1}],transition:'切下一镜',sourceRefs:['r1']}]}],fantasyRealization:[]};

async function fixture(fn){
 const directory=await mkdtemp(path.join(tmpdir(),'stage3-recheck-write-'));let calls=0;
 const engine=createEngine({directory,modelRunner:async request=>{calls++;const output=calls===1?{invalidPlan:true}:request.stage==='plan'?plan:draft;return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};}});
 try{
  await engine.create({id:'run',source,settings:{fantasyMode:'off',maxUnits:null}});
  await engine.execute('run',{stage:'plan',attemptId:'bad-plan'});
  await engine.execute('run',{stage:'plan',attemptId:'good-plan'});
  await engine.execute('run',{stage:'author',packageId:'p1',attemptId:'author'});
  await engine.execute('run',{stage:'finish',packageId:'p1',attemptId:'finish'});
  const ready=await engine.assemble('run');assert.equal(ready.status,'text_ready_for_review');
  await fn({engine,store:createStore(directory),ready,calls:()=>calls,file:path.join(directory,'documents/run.json')});
 }finally{await rm(directory,{recursive:true,force:true});}
}

test('direct recheck of adopted or resolved candidates cannot erase a completed assembly',async()=>fixture(async({engine,ready,calls,file})=>{
 const bytes=await readFile(file,'utf8');
 assert.ok(ready.candidates.some(candidate=>candidate.resolvedBy));
 for(const candidate of ready.candidates){
  await assert.rejects(engine.recheckCandidate('run',candidate.id),{code:'RECHECK_INELIGIBLE'});
  assert.deepEqual(await engine.read('run'),ready);
  assert.equal(await readFile(file,'utf8'),bytes);
 }
 assert.equal(calls(),4);
}));

test('stale status, stale source and old epoch reject atomically without changing saved work',async()=>fixture(async({engine,store,ready,calls,file})=>{
 for(const [name,change] of [
  ['stale candidate',(d,c)=>{c.status='stale';}],
  ['old epoch',d=>{d.epoch++;}],
  ['changed source',d=>{d.source.sourceRows[0].text='甲：别走。';}],
  ['source marked stale',d=>{d.web={sourceStale:true};}]
 ]){
  const candidateId=ready.candidates.find(candidate=>candidate.stage==='author').id;
  const before=await store.update('run',()=>{const d=structuredClone(ready),candidate=d.candidates.find(c=>c.id===candidateId);candidate.status='needs_repair';change(d,candidate);return d;});
  const bytes=await readFile(file,'utf8');
  await assert.rejects(engine.recheckCandidate('run',candidateId),{code:'RECHECK_INELIGIBLE'},name);
  assert.deepEqual(await engine.read('run'),before,name);assert.equal(await readFile(file,'utf8'),bytes,name);
 }
 assert.equal(calls(),4);
}));

test('queued duplicate rechecks revalidate the latest candidate state inside the atomic update',async()=>fixture(async({engine,store,ready,calls})=>{
 const candidateId=ready.candidates.find(candidate=>candidate.stage==='author').id;
 const before=await store.update('run',d=>{d.candidates.find(c=>c.id===candidateId).status='needs_repair';d.adopted=[];d.assembly=null;d.status='needs_repair';return d;});
 const results=await Promise.allSettled([engine.recheckCandidate('run',candidateId),engine.recheckCandidate('run',candidateId)]);
 assert.equal(results[0].status,'fulfilled');assert.equal(results[1].status,'rejected');assert.equal(results[1].reason.code,'RECHECK_INELIGIBLE');
 const after=await engine.read('run');assert.equal(after.candidates.length,before.candidates.length+1);assert.equal(after.epoch,before.epoch);assert.equal(calls(),4);
}));
