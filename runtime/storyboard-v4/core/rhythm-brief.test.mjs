import test from 'node:test';
import assert from 'node:assert/strict';
import {capacityBrief} from './creative-brief.mjs';
import {buildRequest,captureRules} from './core.mjs';
import {normalizeSource} from './source.mjs';
import {PLAN_VERSION} from './shared.mjs';
import {RHYTHM_CONTRACT_VERSION} from './rhythm-brief.mjs';

const version='screen-rhythm-v1';
const settings={maxUnitSeconds:30,maxUnits:null,fantasyMode:'off'};
const quote='今天我们已经看清事实，你再躲也没有用。';
const source={dialogue:[{id:'q1',quote,channel:'现场对白'}]};
const shot=(id,duration,text=quote,voiceStart=0,voiceEnd=duration)=>({id,duration,dialogueParts:[{lineId:'q1',text,voiceStart,voiceEnd}]});
const brief=draft=>capacityBrief({settings,source,previousDraft:draft,rhythmContractVersion:version});

test('new rhythm briefing exposes the project cadence without making shot density a quota',()=>{
 const rhythm=brief(null).rhythm;
 assert.equal(rhythm?.version,version);
 assert.deepEqual(rhythm.shotSeconds.preferred,[2,5]);
 assert.equal(rhythm.shotSeconds.ordinaryMinimumExclusive,1.5);
 assert.equal(rhythm.shotSeconds.splitReviewOver,6);
 assert.deepEqual(rhythm.shotDensityPer30.reference,[8,12]);
 assert.equal(rhythm.shotDensityPer30.isQuota,false);
 assert.deepEqual(rhythm.speechCharactersPerSecond.baseline,[5,6]);
 assert.deepEqual(rhythm.speechCharactersPerSecond.expressiveRange,[4,7]);
 assert.equal(rhythm.audit,null);
});

test('finishing sees long shots and sparse units at actual coordinates without modifying the draft',()=>{
 const draft={units:[{id:'u1',shots:[shot('s1',10),{id:'s2',duration:10,dialogueParts:[]},{id:'s3',duration:9.5,dialogueParts:[]}]}]};
 const saved=structuredClone(draft),audit=brief(draft).rhythm?.audit;
 assert.equal(audit?.screenSeconds,29.5);
 assert.equal(audit.shotCount,3);
 assert.equal(audit.shotsPer30Seconds,3.051);
 assert.deepEqual(audit.longShots.map(s=>s.shotId),['s1','s2','s3']);
 assert.equal(audit.sparseUnits[0].unitId,'u1');
 assert.equal(audit.speech.outliers[0].lineId,'q1');
 assert.deepEqual(draft,saved);
});

test('speech estimates aggregate an intact utterance across cuts, not tiny fragments',()=>{
 const draft={units:[{id:'u1',shots:[shot('s1',3,quote.slice(0,12),0,2.4),shot('s2',2,quote.slice(12),0,1)]}]};
 const speech=brief(draft).rhythm?.audit.speech;
 assert.equal(speech?.measuredLines,1);
 assert.equal(speech.measuredCharacters,17);
 assert.equal(speech.measuredWindowSeconds,3.4);
 assert.equal(speech.plannedCharactersPerSecond,5);
 assert.deepEqual(speech.outliers,[]);
});

test('punctuation is not spoken length; protected parenthetical speech is not blindly stripped',()=>{
 const q='我说的是（甲方）两个字，不是提示。',src={dialogue:[{id:'q1',quote:q,channel:'OS',performanceCues:[{text:'冷笑',quoteOffset:0}]}]};
 const draft={units:[{id:'u1',shots:[shot('s1',4,q,0,3)]}]};
 const speech=capacityBrief({settings,source:src,previousDraft:draft,rhythmContractVersion:version}).rhythm?.audit.speech;
 assert.equal(speech?.measuredCharacters,13);
});

test('nonverbal events and incomplete or invalid voice windows do not become a false speed measurement',()=>{
 const src={dialogue:[...source.dialogue,{id:'roar',quote:'吼',kind:'roar'}]};
 const draft={units:[{id:'u1',shots:[shot('s1',3,quote,0,8),{id:'s2',duration:2,dialogueParts:[{lineId:'roar',text:'吼',voiceStart:0,voiceEnd:2}]}]}]};
 const speech=capacityBrief({settings,source:src,previousDraft:draft,rhythmContractVersion:version}).rhythm?.audit.speech;
 assert.equal(speech?.measuredLines,0);
 assert.equal(speech.plannedCharactersPerSecond,null);
 assert.deepEqual(speech.unmeasuredLineIds,['q1']);
 assert.deepEqual(speech.outliers,[]);
 const partial=brief({units:[{id:'u1',shots:[shot('s1',3,quote.slice(0,4))]}]}).rhythm.audit.speech;
 assert.equal(partial.plannedCharactersPerSecond,null);
});

test('malformed repair drafts remain usable and unknown durations stay unknown',()=>{
 for(const units of [[null],[{id:'u1',shots:[null]}],[{id:'u1',shots:[{id:'s1',duration:4,dialogueParts:[null]}]}]]){
  assert.doesNotThrow(()=>brief({units}));
  const audit=brief({units}).rhythm?.audit;
  assert.equal(audit?.speech.plannedCharactersPerSecond,null);
 }
 assert.equal(brief({units:[{id:'u1',shots:[null]}]}).rhythm.audit.screenSeconds,null);
});

function fixture(){
 const source=normalizeSource({key:'rhythm',sourceRows:[{id:'r1',text:'甲：'+quote}]});
 const emotionContract={subject:'甲',contextTone:'痛快',audienceEffect:'反问击中对方',change:'平静顶回',landing:'对方失态',retain:['原话','公开释放']};
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'顶回',entryFacts:[],events:[{id:'e1',sourceRefs:['r1'],sceneKey:'大厅',boundaryBefore:{kind:'episode_start',reason:'本集开始'},emotionContract}],workPackages:[{id:'p1',eventId:'e1',sourceRefs:['r1'],emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'pu1',packageId:'p1',sourceRefs:['r1'],secondsRange:[3,5]}],fantasyCandidates:[]};
 const previousDraft={units:[{id:'u1',shots:[{...shot('s1',9),dialogueParts:[{lineId:source.dialogue[0].id,text:source.dialogue[0].quote,voiceStart:0,voiceEnd:9}]}]}]};
 return {source,settings,plan,previousDraft,packageId:'p1'};
}
function input(request){return JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以各工作包')[0]);}

test('only new frozen snapshots send rhythm data, including delta repair, without changing output schema',()=>{
 const f=fixture(),current=captureRules(),legacy=structuredClone(current);delete legacy.rhythmContractVersion;
 assert.equal(current.rhythmContractVersion,RHYTHM_CONTRACT_VERSION);
 for(const stage of ['plan','author','finish']){
  const payload={...f,stage,rulesSnapshot:current},a=buildRequest(payload),b=buildRequest({...payload,rulesSnapshot:legacy});
  assert.equal(input(a).capacityBrief.rhythm.version,RHYTHM_CONTRACT_VERSION);
  assert.equal(input(b).capacityBrief.rhythm,undefined);
  assert.equal(a.schemaHash,b.schemaHash);
  assert.notEqual(a.inputHash,b.inputHash);
 }
 const delta=buildRequest({...f,stage:'finish',finishMode:'delta',rulesSnapshot:current});
 assert.equal(delta.finishMode,'delta');
 assert.equal(input(delta).capacityBrief.rhythm.audit.averageShotSeconds,9);
 assert.equal(input(delta).capacityBrief.rhythm.audit.longShots,undefined);
 assert.throws(()=>buildRequest({...f,stage:'author',rulesSnapshot:{...current,rhythmContractVersion:'unknown'}}),e=>e.code==='RULE_SNAPSHOT');
});

test('legacy capacity data and paused repair input do not acquire the new rhythmic defaults',()=>{
 const legacy=capacityBrief({settings,source,previousDraft:{units:[{id:'u1',shots:[shot('s1',12)]}]}});
 assert.equal(legacy.rhythm,undefined);
 assert.equal(legacy.currentDraft.totalSeconds,12);
});
