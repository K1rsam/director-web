import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildRequest,captureRules} from './core.mjs';
import * as outputSchema from './output-schema.mjs';
import {normalizeSource} from './source.mjs';
import {VERSION,PLAN_VERSION,digest} from './shared.mjs';
import {DELTA_VERSION} from './delta.mjs';
import {createEngine} from './pipeline.mjs';
import {createStore} from './store.mjs';

const directionVersion='unit-direction-v1';
const direction='甲的迟疑收进攥拳与转身，摄影从停住的中景缓推至决断落点；门口天光保持方向，脚步声接住情绪，不另加幻想。';
const rulesFiles=['references/common-contract.md','skills/episode-emotion-planner/SKILL.md','skills/episode-finishing-editor/SKILL.md','skills/unit-performance-director/SKILL.md','skills/source-context-preparer/SKILL.md','skills/acting-blocking-methods/SKILL.md','skills/camera-emotion-methods/SKILL.md','skills/sound-rhythm-methods/SKILL.md','skills/lighting-space-methods/SKILL.md','references/cards/editing-integrity.md','references/cards/camera-path-repair.md'];
// A saved pre-upgrade snapshot: never reconstructed from the currently installed rules.
const frozenRules=()=>({version:VERSION,outputSchemaVersion:'structured-v2',unitPackingPolicy:'event-first-v1',creativeRevision:'expressive-cadence-v1',sourceProjection:'nonblank-v1',instructions:'测试冻结指令',files:Object.fromEntries(rulesFiles.map(p=>[p,'测试冻结规则 '+p]))});
function fixture(){
 const source=normalizeSource({key:'unit-direction',title:'迈步',sourceRows:[{id:'s1',text:'△甲攥紧拳头，转身走向门口。'}]});
 const emotionContract={subject:'甲',contextTone:'克制决断',audienceEffect:'看见迟疑变成决定',change:'迟疑转决断',landing:'走向门口',retain:['不改原动作']};
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'从迟疑到行动',entryFacts:[],events:[{id:'e1',sourceRefs:['s1'],sceneKey:'门厅-日内',boundaryBefore:{kind:'episode_start',reason:'本集行动入口'},emotionContract}],workPackages:[{id:'p1',eventId:'e1',sourceRefs:['s1'],emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'p1-u1',packageId:'p1',sourceRefs:['s1'],secondsRange:[4,8]}],fantasyCandidates:[]};
 const draft={schemaVersion:VERSION,units:[{id:'p1-u1',eventId:'e1',boundaryBefore:{kind:'episode_start',reason:'本集行动入口'},title:'迈步',intent:{subject:'甲',change:'迟疑转决断',landing:'走向门口',retain:['不改原动作']},scene:'日 内 门厅',props:[],participants:['甲'],lighting:'门口天光侧照，保持方向',initialState:'甲站在门厅，迟疑未动',exitState:'甲转身走向门口',shots:[{id:'p1-s1',duration:6,camera:'中景缓慢推进',picture:'甲攥紧拳头，转身走向门口。',lighting:'门口天光保持侧照',sound:'拳头握紧衣料摩擦，随后脚步落地',dialogueParts:[],transition:'随脚步结束',sourceRefs:['s1'],contextRefs:[]}]}],fantasyRealization:[]};
 // Match persisted tasks: their normalized model and reasoning are frozen along with the style.
 return {source,plan,draft,settings:{model:'gpt-6-sol',reasoning:'medium',maxUnits:null,maxUnitSeconds:30,fantasyMode:'off',visualStyle:'已保存画风，不随软件升级改变'}};
}
function request(kind,rulesSnapshot){
 const {source,plan,draft,settings}=fixture();
 return buildRequest({stage:kind==='delta'?'finish':kind,finishMode:kind==='delta'?'delta':'full',source,plan,packageId:'p1',settings,rulesSnapshot,...(['finish','delta'].includes(kind)?{previousDraft:draft}:{})});
}

test('new snapshots explicitly opt into unit-direction while plan output shape stays unchanged',()=>{
 assert.equal(outputSchema.UNIT_DIRECTION_VERSION,directionVersion);
 assert.equal(captureRules().unitDirectionVersion,directionVersion);
 const legacy=request('plan',frozenRules()),current=request('plan',{...frozenRules(),unitDirectionVersion:directionVersion});
 assert.deepEqual(current.schema,legacy.schema);
 assert.notEqual(current.inputHash,legacy.inputHash);
});

test('author, full finish and delta replacement schemas require an executable unit direction only with the flag',()=>{
 for(const kind of ['author','finish','delta']){
  const old=request(kind,frozenRules()),current=request(kind,{...frozenRules(),unitDirectionVersion:directionVersion});
  const unit=r=>kind==='delta'?r.schema.properties.replacements.items.properties.units.items:r.schema.properties.units.items;
  assert.equal(Object.hasOwn(unit(old).properties,'unitDirection'),false,kind);
  assert.deepEqual(unit(current).properties.unitDirection,{type:'string'},kind);
  assert.ok(unit(current).required.includes('unitDirection'),kind);
  assert.match(current.prompt,/unitDirection/);
  assert.match(current.prompt,/情绪表演/);assert.match(current.prompt,/摄影节奏/);assert.match(current.prompt,/声光/);assert.match(current.prompt,/幻想边界/);
  assert.match(current.prompt,/不是.*全局.*梗概.*评价/);assert.match(current.prompt,/shots.*不能矛盾/);
  assert.notEqual(current.schemaHash,old.schemaHash);assert.notEqual(current.inputHash,old.inputHash);assert.notEqual(current.promptHash,old.promptHash);
 }
});

test('unknown direction versions never silently become an old request',()=>{
 for(const unitDirectionVersion of ['unit-direction-future',null,undefined])assert.throws(()=>request('plan',{...frozenRules(),unitDirectionVersion}),e=>e.code==='RULE_SNAPSHOT');
});

test('new direction contracts are captured in saved hints and never appended over a frozen hint',()=>{
 const rules=captureRules();assert.match(rules.draftHint,/unitDirection/);assert.match(rules.deltaHint,/unitDirection/);
 const saved={...frozenRules(),unitDirectionVersion:directionVersion,draftHint:'冻结版完整单元 unitDirection 指令',deltaHint:'冻结版差量单元 unitDirection 指令'};
 for(const kind of ['author','delta']){
  const r=request(kind,saved),contract=r.prompt.split('【输出契约】\n')[1].split('\nlineId填')[0];
  assert.equal(contract,kind==='delta'?saved.deltaHint:saved.draftHint);
 }
});

test('absent unit-direction flag preserves saved v2 plan, author, full and delta fingerprints',()=>{
 const actual=Object.fromEntries(['plan','author','finish','delta'].map(kind=>{const r=request(kind,frozenRules());return [kind,[r.inputHash,r.promptHash,r.schemaHash]];}));
 assert.deepEqual(actual,{
  plan:['ba9e0ad29905896745483b4cf243eb8a91285e1e9a08e1155088e85b7b5e6416','db293226f976ff79943aa06b8567b72bd3c9a7b03bc17a3b516f63e4a0f9641c','cf9d9245e02717b66ad994a8eea67d764ffc508803e9b803c665aab014121d69'],
  author:['0cdd156323bd0a1ab40fea754456a216f44aa8ae8eab99433cb392dde4c73376','3ba5d67f444f4f5489da1d2c5646313ad8050c0c3257af40e667213cab9ef152','7c0e9d04e75ee8e7148490b8c99bdb191ac16fa40272171e7e49b902f66ae7b7'],
  finish:['e7658415eb04c3d292589f4143de5862af5f831f7bf027e69b9aece03ecefad7','b9545a5badb424983ffe4c742fc8a3270049c9fa7d62f6a18214a1b69db2f4a0','afba5283e3914d5da7853676d49c05e04287a98d6d2d5b51d04f3b64228894d4'],
  delta:['50d22c50c771130df3ec8916a13b261f15f6965f9ab4edfd0dbe2aa1335b42f6','e69ff72010626c08396b1420678860e710428f84d053d619b8f3cbd1712af32e','674e88f889ab8f27a77115e605cce62990c387412a9dcaef266db48bc567506b']
 });
});

async function setup(t,{legacy=false,missingDirection=false,finishMode='full'}={}){
 const directory=await mkdtemp(path.join(tmpdir(),'v4-unit-direction-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const f=fixture(),requests=[];
 if(!legacy&&!missingDirection)f.draft.units[0].unitDirection=direction;
 const engine=createEngine({directory,modelRunner:async r=>{
  requests.push(r);
  const output=structuredClone(r.stage==='plan'?f.plan:r.finishMode==='delta'?{schemaVersion:DELTA_VERSION,baseDraftHash:r.baseDraftHash,retainedUnitIds:[],replacements:[{replaces:['p1-u1'],units:f.draft.units,fantasyRealization:[]}],revisionNotes:[],unresolved:[]}:r.stage==='finish'?{...f.draft,revisionNotes:[],unresolved:[]}:f.draft);
  return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};
 }});
 await engine.create({id:'flow',source:f.source,settings:f.settings});
 if(legacy)await createStore(directory).update('flow',d=>{d.rulesSnapshot=frozenRules();return d;});
 await engine.execute('flow',{stage:'plan',attemptId:'plan'});
 await engine.execute('flow',{stage:'author',packageId:'p1',attemptId:'author'});
 return {engine,directory,requests,finishMode};
}

for(const finishMode of ['full','delta'])test(`new ${finishMode} plan-author-finish-assemble flow saves the direction through request, adoption and rendering`,async t=>{
 const {engine,requests}=await setup(t,{finishMode});
 await engine.execute('flow',{stage:'finish',finishMode,packageId:'p1',attemptId:'finish'});
 const d=await engine.assemble('flow');
 assert.equal(d.rulesSnapshot.unitDirectionVersion,directionVersion);
 assert.equal(d.status,'text_ready_for_review');assert.deepEqual(d.assembly.validation.errors,[]);
 assert.equal(d.adopted[0].draft.units[0].unitDirection,direction);
 assert.equal(d.assembly.draft.units[0].unitDirection,direction);assert.ok(d.assembly.text.includes(direction));
 assert.match(requests[1].prompt,/unitDirection/);
 assert.equal(d.candidates.at(-1).output.schemaVersion,finishMode==='delta'?DELTA_VERSION:VERSION);
});

test('new-version author response without a direction is preserved as a repair candidate, not adopted',async t=>{
 const {engine}=await setup(t,{missingDirection:true}),d=await engine.read('flow');
 assert.equal(d.adopted.length,0);assert.equal(d.candidates.at(-1).status,'needs_repair');
 assert.ok(d.candidates.at(-1).validation.errors.some(e=>e.code==='UNIT_DIRECTION'));
 assert.ok(d.candidates.at(-1).raw.includes('p1-u1'));
});

test('assembly revalidates the new direction contract instead of accepting a missing adopted field',async t=>{
 const {engine,directory}=await setup(t);
 await engine.execute('flow',{stage:'finish',packageId:'p1',attemptId:'finish'});
 await createStore(directory).update('flow',d=>{delete d.adopted[0].draft.units[0].unitDirection;return d;});
 const d=await engine.assemble('flow');assert.equal(d.status,'needs_repair');
 assert.ok(d.assembly.validation.errors.some(e=>e.code==='UNIT_DIRECTION'));
});

test('refresh refuses to upgrade a paid same-v2 plan solely because the new direction flag differs',async t=>{
 const {engine}=await setup(t,{legacy:true}),before=await engine.read('flow');
 await assert.rejects(engine.refreshRules('flow'),e=>e.code==='RULES_PROTOCOL_CHANGE');
 assert.deepEqual(await engine.read('flow'),before);
});

test('saved unflagged v2 work rechecks and assembles without a direction or any extra model call',async t=>{
 const {engine,directory,requests}=await setup(t,{legacy:true});
 await engine.execute('flow',{stage:'finish',packageId:'p1',attemptId:'finish'});
 const before=await engine.read('flow'),candidateId=before.candidates.at(-1).id,calls=requests.length;
 await createStore(directory).update('flow',d=>{d.candidates.at(-1).status='needs_repair';d.adopted=[];return d;});
 await engine.recheckCandidate('flow',candidateId);
 const d=await engine.assemble('flow');assert.equal(d.status,'text_ready_for_review');
 assert.equal(requests.length,calls);assert.deepEqual(d.assembly.draft.units,before.adopted[0].draft.units);
 assert.equal(Object.hasOwn(d.assembly.draft.units[0],'unitDirection'),false);
 assert.equal(d.operations.at(-1).fingerprint,before.operations.at(-1).fingerprint);
});

test('fresh unplanned runs can adopt the new direction protocol on explicit rule refresh',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'v4-direction-refresh-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const engine=createEngine({directory}),f=fixture();await engine.create({id:'fresh',source:f.source,settings:f.settings});
 await createStore(directory).update('fresh',d=>{d.rulesSnapshot=frozenRules();return d;});
 const d=await engine.refreshRules('fresh');assert.equal(d.rulesSnapshot.unitDirectionVersion,directionVersion);
 assert.equal(d.rulesHistory.at(-1).oldHash,digest(frozenRules()));
});
