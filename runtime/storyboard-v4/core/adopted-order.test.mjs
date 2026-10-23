import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createEngine} from './legacy-test-fixtures.mjs';
import {createStore} from './store.mjs';
import {rebuildFrozenRequest} from './pipeline.mjs';
import {VERSION,PLAN_VERSION,digest} from './shared.mjs';
import {DELTA_VERSION,baseDraftHash} from './delta.mjs';

const source={key:'order',sourceRows:[{id:'s0',line:1,text:'△人站在门旁。'},{id:'s1',line:2,text:'甲：走。'},{id:'s2',line:3,text:'甲：三号矿坑，石头硬。'},{id:'s3',line:4,text:'△人离开门旁。'}],contextRows:[],entryFacts:[],assets:[]};
const emotion={subject:'人物',contextTone:'紧张',audienceEffect:'期待',change:'决定',landing:'离开',retain:['原话']};
const plan={schemaVersion:PLAN_VERSION,emotionArc:'决定离开',entryFacts:[],workPackages:[{id:'p1',sourceRefs:['s0','s1','s2','s3'],emotionContract:emotion,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'provisional',packageId:'p1',sourceRefs:['s0','s1','s2','s3'],secondsRange:[5,15]}],fantasyCandidates:[]};
const unit=(id,refs,lineId,text)=>({id,title:'行动',intent:{subject:'人物',change:'决定',landing:'离开',retain:['原话']},scene:'门旁',props:[],participants:['甲'],lighting:'日光',initialState:'站立',exitState:'迈步',shots:[{id:id+'-shot',duration:3,camera:'固定中景',picture:'甲站在门旁说话。',lighting:'日光',sound:'人声',dialogueParts:[{lineId,text,presentation:'画内',delivery:'清楚',voiceStart:0,voiceEnd:1.5}],transition:'切',sourceRefs:refs}]});
const draft={schemaVersion:VERSION,units:[unit('u1',['s1'],'s1:D1','走。'),unit('u2',['s2'],'s2:D2','三号矿坑，'),unit('u3',['s0','s2','s3'],'s2:D2','石头硬。')],fantasyRealization:[]};
const response=output=>({output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'});
async function seeded(finish){
 const directory=await mkdtemp(path.join(tmpdir(),'adopted-order-'));
 const engine=createEngine({directory,modelRunner:async req=>req.stage==='plan'?response(plan):req.stage==='finish'&&finish?finish(req):response(draft)});
 await engine.create({id:'order',source,settings:{maxUnits:null,fantasyMode:'off'}});
 await engine.execute('order',{stage:'plan',attemptId:'plan'});
 await engine.execute('order',{stage:'author',packageId:'p1',attemptId:'author'});
 assert.equal((await engine.read('order')).candidates.at(-1).status,'adopted');
 return {directory,engine};
}

test('assembly preserves adopted unit order when a late unit cites earlier source context',async()=>{
 const {directory,engine}=await seeded();
 try{
  await engine.execute('order',{stage:'finish',packageId:'p1',attemptId:'finish'});
  const before=await engine.read('order'),after=await engine.assemble('order');
  assert.deepEqual(after.assembly.draft.units.map(u=>u.id),['u1','u2','u3']);
  assert.deepEqual(after.assembly.validation.errors,[]);assert.equal(after.status,'text_ready_for_review');
  assert.deepEqual(after.operations,before.operations);assert.deepEqual(after.candidates,before.candidates);
  assert.deepEqual(after.adopted,before.adopted);
 }finally{await rm(directory,{recursive:true,force:true});}
});

for(const mode of ['full','delta'])test(`new ${mode} finish baseline preserves the accepted group's authored order`,async()=>{
 let seen;
 const {directory,engine}=await seeded(req=>{seen=req;return response(mode==='delta'?{schemaVersion:DELTA_VERSION,baseDraftHash:req.baseDraftHash,retainedUnitIds:['u1','u2','u3'],replacements:[]}:draft);});
 try{
  await engine.execute('order',{stage:'finish',finishMode:mode,packageId:'p1',attemptId:'finish'});
  const d=await engine.read('order'),op=d.operations.at(-1);
  assert.deepEqual(op.previousDraft.units.map(u=>u.id),['u1','u2','u3']);
  assert.equal(op.previousDraftOrderVersion,'adopted-group-order-v1');
  assert.equal(d.candidates.at(-1).status,'adopted');
  assert.equal(digest([seen.promptHash,seen.instructionHash,seen.inputHash]),op.fingerprint);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('an unversioned in-flight delta retains its legacy frozen baseline and guards',async()=>{
 let release,started;const ready=new Promise(r=>started=r),pending=new Promise(r=>release=r);
 const {directory,engine}=await seeded(()=>{started();return pending;});
 try{
  const execution=engine.execute('order',{stage:'finish',finishMode:'delta',packageId:'p1',attemptId:'legacy'});await ready;
  await createStore(directory).update('order',d=>{
   const op=d.operations.at(-1);delete op.previousDraftOrderVersion;
   op.previousDraft.units=[op.previousDraft.units.find(u=>u.id==='u3'),op.previousDraft.units.find(u=>u.id==='u1'),op.previousDraft.units.find(u=>u.id==='u2')];
   op.baseDraftHash=baseDraftHash(op.previousDraft);
   const request=rebuildFrozenRequest(d,op);op.fingerprint=digest([request.promptHash,request.instructionHash,request.inputHash]);return d;
  });
  const before=await engine.read('order'),op=before.operations.at(-1),hashes=rebuildFrozenRequest(before,op);
  release(response({schemaVersion:DELTA_VERSION,baseDraftHash:op.baseDraftHash,retainedUnitIds:[],replacements:[{replaces:op.previousDraft.units.map(u=>u.id),units:draft.units,fantasyRealization:[]}]}));await execution;
  const after=await engine.read('order'),frozen=rebuildFrozenRequest(after,after.operations.at(-1));
  assert.equal(after.candidates.at(-1).status,'adopted');
  assert.equal(after.operations.at(-1).previousDraftOrderVersion,undefined);
  assert.deepEqual(after.operations.at(-1).previousDraft,op.previousDraft);
  assert.deepEqual([frozen.promptHash,frozen.instructionHash,frozen.inputHash],[hashes.promptHash,hashes.instructionHash,hashes.inputHash]);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('independent groups follow source package order despite reverse completion, without sorting inside a group',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'adopted-order-groups-'));
 const extendedSource={...source,sourceRows:[...source.sourceRows,{id:'s4',line:5,text:'乙：好。'}]};
 const second={id:'p2',sourceRefs:['s4'],emotionContract:emotion,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]};
 const extendedPlan={...plan,workPackages:[second,...plan.workPackages],provisionalUnits:[...plan.provisionalUnits,{id:'other-provisional',packageId:'p2',sourceRefs:['s4'],secondsRange:[2,5]}]};
 const other={schemaVersion:VERSION,units:[unit('v1',['s4'],'s4:D3','好。')],fantasyRealization:[]};
 const engine=createEngine({directory,modelRunner:async req=>response(req.stage==='plan'?extendedPlan:req.packageId==='p2'?other:draft)});
 try{
  await engine.create({id:'groups',source:extendedSource,settings:{maxUnits:null,fantasyMode:'off'}});
  await engine.execute('groups',{stage:'plan',attemptId:'plan'});
  for(const stage of ['author','finish'])for(const packageId of ['p2','p1']){
   const d=await engine.execute('groups',{stage,packageId,attemptId:stage+packageId});assert.equal(d.candidates.at(-1).status,'adopted');
  }
  const d=await engine.assemble('groups');
  assert.deepEqual(d.assembly.draft.units.map(u=>u.id),['u1','u2','u3','v1']);
  assert.deepEqual(d.assembly.validation.errors,[]);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a verified joint finish preserves interleaving across non-adjacent adopted groups',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'adopted-order-interleaved-'));let seen;
 const input={...source,sourceRows:[{id:'s1',line:1,text:'甲：走。'},{id:'s2',line:2,text:'乙：好。'},{id:'s3',line:3,text:'丙：来。'}]};
 const packages=[1,2,3].map(n=>({...plan.workPackages[0],id:'p'+n,sourceRefs:['s'+n]}));
 const p={...plan,workPackages:packages,provisionalUnits:packages.map((w,i)=>({id:'provisional'+i,packageId:w.id,sourceRefs:w.sourceRefs,secondsRange:[2,5]}))};
 const units=[unit('a',['s1'],'s1:D1','走。'),unit('b',['s2'],'s2:D2','好。'),unit('c',['s3'],'s3:D3','来。')];
 const joint={schemaVersion:VERSION,units:[{...units[0],shots:[{...units[0].shots[0],sourceRefs:['s1','s3']}]},units[1],units[2]],fantasyRealization:[]};
 const engine=createEngine({directory,modelRunner:async req=>{
  if(req.stage==='plan')return response(p);
  if(req.stage==='author')return response({schemaVersion:VERSION,units:[units[Number(req.packageId.slice(1))-1]],fantasyRealization:[]});
  seen=req;return response(req.finishMode==='delta'?{schemaVersion:DELTA_VERSION,baseDraftHash:req.baseDraftHash,retainedUnitIds:['a','b','c'],replacements:[]}:joint);
 }});
 try{
  await engine.create({id:'interleave',source:input,settings:{maxUnits:null,fantasyMode:'off'}});
  await engine.execute('interleave',{stage:'plan',attemptId:'plan'});
  for(const w of packages)await engine.execute('interleave',{stage:'author',packageId:w.id,attemptId:'author'+w.id});
  let d=await engine.execute('interleave',{stage:'finish',packageIds:packages.map(w=>w.id),attemptId:'joint'});
  assert.equal(d.candidates.at(-1).status,'adopted');assert.deepEqual(d.candidates.at(-1).validation.errors,[]);
  assert.deepEqual(d.adopted.map(a=>a.packageIds),[['p1','p3'],['p2']]);
  d=await engine.assemble('interleave');assert.deepEqual(d.assembly.draft.units.map(u=>u.id),['a','b','c']);assert.deepEqual(d.assembly.validation.errors,[]);
  d=await engine.execute('interleave',{stage:'finish',finishMode:'delta',packageIds:packages.map(w=>w.id),attemptId:'delta'});
  assert.equal(d.candidates.at(-1).status,'adopted');
  assert.deepEqual(d.operations.at(-1).previousDraft.units.map(u=>u.id),['a','b','c']);assert.equal(seen.finishMode,'delta');
 }finally{await rm(directory,{recursive:true,force:true});}
});

for(const kind of ['duplicate','conflicting'])test(`${kind} adopted order evidence fails closed without changing the saved assembly`,async()=>{
 const {directory,engine}=await seeded();
 try{
  await engine.execute('order',{stage:'finish',packageId:'p1',attemptId:'finish'});await engine.assemble('order');
  await createStore(directory).update('order',d=>{
   const units=d.adopted[0].draft.units;
   if(kind==='duplicate')units.push(structuredClone(units[0]));else units.reverse();return d;
  });
  const before=await engine.read('order');
  await assert.rejects(engine.assemble('order'),{code:'ADOPTED_UNIT_ORDER'});
  assert.deepEqual(await engine.read('order'),before);
 }finally{await rm(directory,{recursive:true,force:true});}
});
