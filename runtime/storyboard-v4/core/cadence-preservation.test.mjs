import test from 'node:test';
import assert from 'node:assert/strict';
import {capacityBrief} from './creative-brief.mjs';
import {buildRequest,captureRules} from './core.mjs';
import {normalizeSource} from './source.mjs';
import {PLAN_VERSION} from './shared.mjs';
import {RHYTHM_CONTRACT_VERSION} from './rhythm-brief.mjs';

const version=RHYTHM_CONTRACT_VERSION;
const settings={maxUnitSeconds:30,maxUnits:null,fantasyMode:'off'};
const unit=(id,seconds,{eventId='e1',scene='日 外 门前',boundary='capacity',parts=[]}={})=>({id,eventId,scene,boundaryBefore:{kind:boundary,reason:'既有合法接点'},shots:[{id:id+'-s',duration:seconds,dialogueParts:parts}]});
const brief=(draft,source={dialogue:[]},plan)=>capacityBrief({settings,source,previousDraft:draft,plan,rhythmContractVersion:version}).rhythm;

test('near-capacity cuts preserve a natural 30/30/7 tail, not uniform units or padding',()=>{
 const draft={units:[unit('u1',30,{boundary:'episode_start'}),unit('u2',30),unit('u3',7)]},saved=structuredClone(draft),rhythm=brief(draft);
 assert.equal(rhythm?.version,version);
 assert.equal(rhythm.cutPolicy.preferNearCapacity,true);
 assert.equal(rhythm.cutPolicy.uniformDistribution,false);
 assert.equal(rhythm.cutPolicy.naturalSourceTailExempt,true);
 assert.equal(rhythm.cutPolicy.batchEndIsSourceEnd,false);
 assert.deepEqual(rhythm.audit.continuousRuns[0].unitSeconds,[30,30,7]);
 assert.equal(rhythm.audit.continuousRuns[0].seconds,67);
 assert.deepEqual(rhythm.audit.unitEndings,[]);
 assert.deepEqual(draft,saved);
});

test('real boundaries and unknown continuity are not automatically joined',()=>{
 const draft={units:[unit('u1',25,{boundary:'episode_start'}),unit('u2',20,{boundary:'time_space_jump'}),unit('u3',7,{scene:'次日 内 房间'})]};
 assert.deepEqual(brief(draft).audit.continuousRuns.map(r=>r.unitIds),[['u1'],['u2'],['u3']]);
 const unknown={units:[unit('u1',20,{boundary:'episode_start'}),unit('u2',20)]};delete unknown.units[1].eventId;
 assert.equal(brief(unknown).audit.continuousRuns.length,2);
});

test('integer unit endings are cut-point suggestions, not blind retiming or whole-second shots',()=>{
 const draft={units:[unit('u1',28.7,{boundary:'episode_start'}),unit('u2',29.6),unit('u3',7.7)]},saved=structuredClone(draft),rhythm=brief(draft);
 assert.equal(rhythm.cutPolicy.integerUnitEnd,true);
 assert.equal(rhythm.cutPolicy.fractionalShotSeconds,true);
 assert.equal(rhythm.cutPolicy.automaticRetiming,false);
 assert.deepEqual(rhythm.audit.unitEndings.map(e=>[e.unitId,e.seconds,e.nearbyIntegerEnds]),[['u1',28.7,[28,29]],['u2',29.6,[29,30]],['u3',7.7,[7,8]]]);
 assert.deepEqual(draft,saved);
 assert.equal(Object.hasOwn(rhythm.audit,'errors'),false);
});

test('one natural utterance stays natural across cuts; a slow tail cannot hide behind a good average',()=>{
 const quote='我早就想清楚了，既然你们这么说，那就看着我的背影吧。',source={dialogue:[{id:'q',quote}]};
 const first=quote.slice(0,-8),last=quote.slice(-8);
 const draft={units:[{id:'u',shots:[{id:'a',duration:4,dialogueParts:[{lineId:'q',text:first,voiceStart:0,voiceEnd:3}]},{id:'b',duration:4,dialogueParts:[{lineId:'q',text:last,voiceStart:0,voiceEnd:3.8}]}]}]};
 const skew=brief(draft,source)?.audit.speech.fragmentSkews;
 assert.ok(skew?.some(s=>s.lineId==='q'&&s.fragments.some(p=>p.shotId==='b'&&p.plannedCharactersPerSecond<3.5)));
 const natural={units:[{id:'u',shots:[{id:'a',duration:3.5,dialogueParts:[{lineId:'q',text:first,voiceStart:0,voiceEnd:3.5}]},{id:'b',duration:2,dialogueParts:[{lineId:'q',text:last,voiceStart:0,voiceEnd:1.5}]}]}]};
 assert.deepEqual(brief(natural,source).audit.speech.fragmentSkews,[]);
});

test('unknown or malformed windows never create fractional-end instructions or speed accusations',()=>{
 const draft={units:[null,{id:'u',shots:[{id:'s',duration:null,dialogueParts:[{lineId:'q',text:'原话',voiceStart:0,voiceEnd:4}]}]}]};
 const rhythm=brief(draft,{dialogue:[{id:'q',quote:'原话'}]});
 assert.equal(rhythm.audit.screenSeconds,null);
 assert.deepEqual(rhythm.audit.unitEndings,[]);
 assert.deepEqual(rhythm.audit.speech.fragmentSkews,[]);
});

test('frozen rhythm v1 remains on its previous data contract',()=>{
 const draft={units:[unit('u',28.7)]},old=capacityBrief({settings,source:{dialogue:[]},previousDraft:draft,rhythmContractVersion:'screen-rhythm-v1'}).rhythm;
 assert.equal(old?.version,'screen-rhythm-v1');
 assert.equal(old.cutPolicy,undefined);
 assert.equal(old.audit.unitEndings,undefined);
 assert.equal(old.audit.speech.fragmentSkews,undefined);
});

test('new plan/author/full/delta requests carry current cadence once; frozen v1 and absent versions remain usable',()=>{
 const source=normalizeSource({key:'cadence',sourceRows:[{id:'r',text:'甲：我已经想清楚了。'}]}),emotionContract={subject:'甲',contextTone:'从容',audienceEffect:'夺回主动',change:'拒绝原安排',landing:'主动离开',retain:['原话','主体与对象']};
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'夺回主动',entryFacts:[],events:[{id:'e1',sourceRefs:['r'],sceneKey:'门前',boundaryBefore:{kind:'episode_start',reason:'本集开头'},emotionContract}],workPackages:[{id:'p',eventId:'e1',sourceRefs:['r'],emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'pu',packageId:'p',sourceRefs:['r'],secondsRange:[2,3]}],fantasyCandidates:[]};
 const previousDraft={schemaVersion:'performance-core-v4',units:[unit('u',28.7,{boundary:'episode_start'})],fantasyRealization:[]},current=captureRules();
 assert.equal(current.rhythmContractVersion,version);
 const input=request=>JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以各工作包')[0]);
 for(const mode of [{stage:'plan'},{stage:'author'},{stage:'finish'},{stage:'finish',finishMode:'delta'}]){
  const payload={source,settings,plan,previousDraft,packageId:'p',rulesSnapshot:current,...mode},request=buildRequest(payload);
  assert.equal(input(request).capacityBrief.rhythm.version,version);
  const review=input(request).capacityBrief.rhythm.audit.viewingReview;
  assert.equal(review.advisoryOnly,true);
  assert.deepEqual(review.longShots.map(s=>s.seconds),[28.7]);
  assert.equal(review.sparseUnits.length,1);
  const frozenV3=buildRequest({...payload,rulesSnapshot:{...current,rhythmContractVersion:'screen-rhythm-v3'}});
  assert.equal(input(frozenV3).capacityBrief.rhythm.audit.viewingReview,undefined);
  assert.equal(request.schemaHash,frozenV3.schemaHash);
  assert.equal((request.prompt.match(/"cutPolicy":/g)||[]).length,1);
  const old=buildRequest({...payload,rulesSnapshot:{...current,rhythmContractVersion:'screen-rhythm-v1'}});
  assert.equal(input(old).capacityBrief.rhythm.cutPolicy,undefined);
  const noVersion={...current};delete noVersion.rhythmContractVersion;
  assert.equal(input(buildRequest({...payload,rulesSnapshot:noVersion})).capacityBrief.rhythm,undefined);
 }
});
