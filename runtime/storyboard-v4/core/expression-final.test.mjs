import test from 'node:test';
import assert from 'node:assert/strict';
import {rhythmBrief,RHYTHM_CONTRACT_VERSION} from './rhythm-brief.mjs';
import {buildRequest,captureRules} from './core.mjs';
import {normalizeSource} from './source.mjs';

const ttsScope='Tingting rate200本机平读，仅语言容量参照非演员实配';
const text='我只是一个普通学生。哪怕我觉醒失败了，现在我也只是学生。赵执政官来我面前耀武扬威，是为了什么？';
const parts=[text.slice(0,12),text.slice(12,28),text.slice(28)];
const makeDraft=()=>({units:[{id:'u',eventId:'e',scene:'门前',boundaryBefore:{kind:'episode_start'},shots:[
 {id:'a',duration:6.5,dialogueParts:[{lineId:'q',text:parts[0],voiceStart:3.5,voiceEnd:5.95}]},
 {id:'b',duration:3.5,dialogueParts:[{lineId:'q',text:parts[1],voiceStart:0,voiceEnd:2.85}]},
 {id:'c',duration:4,dialogueParts:[{lineId:'q',text:parts[2],voiceStart:0,voiceEnd:3.5}]}
]}]});
const inspect=(draft,version=RHYTHM_CONTRACT_VERSION)=>rhythmBrief({previousDraft:draft,source:{dialogue:[{id:'q',quote:text}]},maxUnitSeconds:30,version});
const input=request=>JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以各工作包')[0]);

test('frozen v3 cadence does not acquire later editing references',()=>{
 const rhythm=inspect(makeDraft(),'screen-rhythm-v3');
 assert.equal(rhythm.version,'screen-rhythm-v3');
 assert.equal(rhythm.shotSeconds.preferred,undefined);
 assert.equal(rhythm.shotSeconds.splitReviewOver,undefined);
 assert.equal(rhythm.shotDensityPer30,undefined);
 assert.equal(rhythm.shotSeconds.durationIsCreativeChoice,true);
 assert.deepEqual(rhythm.speechCharactersPerMinute.baseline,[300,360]);
 assert.equal(rhythm.audit.longShots,undefined);
 assert.equal(rhythm.audit.shortShots,undefined);
 assert.equal(rhythm.audit.sparseUnits,undefined);
 assert.equal(rhythm.cutPolicy.naturalSourceTailExempt,true);
 assert.equal(rhythm.cutPolicy.integerUnitEnd,true);
});

test('split speech reports actual cross-cut gaps and elapsed delivery, without altering text or timing',()=>{
 const draft=makeDraft(),saved=structuredClone(draft),speech=inspect(draft).audit.speech;
 const span=speech.continuityGaps[0];
 assert.equal(span.lineId,'q');
 assert.equal(span.windowSeconds,8.8);
 assert.equal(span.elapsedSeconds,10);
 assert.deepEqual(span.gaps.map(g=>g.seconds),[0.55,0.65]);
 assert.deepEqual(span.gaps[0].from,{unitId:'u',shotId:'a',unitTime:5.95});
 assert.deepEqual(span.gaps[0].to,{unitId:'u',shotId:'b',unitTime:6.5});
 assert.ok(span.elapsedCharactersPerSecond<span.plannedCharactersPerSecond);
 assert.equal(JSON.stringify(span).includes(text),false);
 assert.equal(inspect(draft).audit.errors,undefined);
 assert.deepEqual(draft,saved);
});

test('continuous unit boundaries can carry speech; time/space jumps and unknown durations cannot',()=>{
 const draft=makeDraft(),shots=draft.units[0].shots;
 draft.units=[{...draft.units[0],shots:shots.slice(0,1)},{id:'u2',eventId:'e',scene:'门前',boundaryBefore:{kind:'capacity'},shots:shots.slice(1)}];
 assert.equal(inspect(draft).audit.speech.continuityGaps[0].gaps[0].to.unitTime,0);
 draft.units[1].boundaryBefore.kind='time_space_jump';
 assert.deepEqual(inspect(draft).audit.speech.continuityGaps,[]);
 draft.units[1].boundaryBefore.kind='capacity';draft.units[0].shots[0].duration=null;
 assert.deepEqual(inspect(draft).audit.speech.continuityGaps,[]);
});

test('zero gaps, invalid windows, partial quotes and different scenes do not produce a continuity accusation',()=>{
 const natural=makeDraft();natural.units[0].shots[0].duration=5.95;natural.units[0].shots[1].duration=2.85;
 assert.deepEqual(inspect(natural).audit.speech.continuityGaps,[]);
 const invalid=makeDraft();invalid.units[0].shots[1].dialogueParts[0].voiceEnd=8;
 assert.deepEqual(inspect(invalid).audit.speech.continuityGaps,[]);
 const partial=makeDraft();partial.units[0].shots.pop();
 assert.deepEqual(inspect(partial).audit.speech.continuityGaps,[]);
 const different=makeDraft(),last=different.units[0].shots.pop();
 different.units.push({id:'u2',eventId:'e',scene:'房内',boundaryBefore:{kind:'capacity'},shots:[last]});
 assert.deepEqual(inspect(different).audit.speech.continuityGaps,[]);
});

test('frozen v2 cadence retains its old numeric contract and has no new diagnostics',()=>{
 const old=inspect(makeDraft(),'screen-rhythm-v2');
 assert.deepEqual(old.shotSeconds,{preferred:[2,5],ordinaryMinimumExclusive:1.5,splitReviewOver:6});
 assert.deepEqual(old.shotDensityPer30,{reference:[8,12],isQuota:false});
 assert.equal(old.speechCharactersPerMinute,undefined);
 assert.equal(old.audit.longShots[0].shotId,'a');
 assert.equal(old.audit.speech.continuityGaps,undefined);
 assert.equal(old.cutPolicy.integerUnitEnd,true);
});

test('adjacent turns expose a real 1.1s wait without declaring it empty or changing the draft',()=>{
 const source={dialogue:[{id:'q1',quote:'清雅。'},{id:'q2',quote:'你听我说。'}]};
 const draft={units:[{id:'u',shots:[{id:'a',duration:26,dialogueParts:[{lineId:'q1',text:'清雅。',voiceStart:24,voiceEnd:24.9}]},{id:'b',duration:3,dialogueParts:[{lineId:'q2',text:'你听我说。',voiceStart:0,voiceEnd:1}]}]}]};
 const saved=structuredClone(draft),speech=rhythmBrief({previousDraft:draft,source,maxUnitSeconds:30}).audit.speech;
 assert.equal(speech.turnGaps[0].seconds,1.1);
 assert.equal(speech.turnGaps[0].from.lineId,'q1');
 assert.equal(speech.turnGaps[0].to.lineId,'q2');
 assert.deepEqual(draft,saved);
 draft.units[0].shots[0].dialogueParts[0].voiceEnd=30;
 assert.deepEqual(rhythmBrief({previousDraft:draft,source,maxUnitSeconds:30}).audit.speech.turnGaps,[]);
});

test('new requests do not anchor to default slow Mac TTS; raw measurements and custom reference stay intact',()=>{
 const source=normalizeSource({key:'flat-read',sourceRows:[{id:'r',text:'甲：这是连续说完的同一句原话。'}]});
 const voiceReference={scope:ttsScope,rows:[{id:source.dialogue[0].id,quote:source.dialogue[0].quote,seconds:8.123},{id:'out-of-scope',seconds:60}],warnings:['缓存已测读']},saved=structuredClone(voiceReference);
 const payload={stage:'plan',source,voiceReference,settings:{maxUnitSeconds:30,maxUnits:null,fantasyMode:'off'}},current=captureRules();
 const request=buildRequest({...payload,rulesSnapshot:current}),data=input(request);
 assert.equal(current.creativeRevision,'expressive-cadence-v4');
 assert.equal(data.voiceReference.measurementsOmitted,true);
 assert.equal(data.voiceReference.coveredLines,1);
 assert.deepEqual(data.voiceReference.rows,[]);
 assert.equal(data.capacityBrief.voiceReference.seconds,undefined);
 assert.equal(JSON.stringify(data).includes('8.123'),false);
 assert.deepEqual(voiceReference,saved);
 const legacy=input(buildRequest({...payload,rulesSnapshot:{...current,creativeRevision:'expressive-cadence-v1',rhythmContractVersion:'screen-rhythm-v2'}}));
 assert.equal(legacy.creativeRevision,'expressive-cadence-v1');
 assert.equal(legacy.voiceReference.rows[0].seconds,8.123);
 assert.equal(legacy.capacityBrief.voiceReference.seconds,8.123);
 const custom={...voiceReference,scope:'人工录音容量参考',profile:{preserve:'custom'},rows:[{...voiceReference.rows[0],quality:'approved'}]};
 const customData=input(buildRequest({...payload,voiceReference:custom,rulesSnapshot:current}));
 assert.equal(customData.voiceReference.rows[0].seconds,8.123);
 assert.equal(customData.voiceReference.profile.preserve,'custom');
 assert.equal(customData.voiceReference.rows[0].quality,'approved');
 assert.equal(customData.capacityBrief.voiceReference.seconds,8.123);
 const unknown={...voiceReference,profile:{newContract:'must not be discarded'}};
 assert.equal(input(buildRequest({...payload,voiceReference:unknown})).voiceReference.profile.newContract,'must not be discarded');
});

test('omitting known flat-read measurements must not disable the existing lossless input projection',()=>{
 const row='甲：'+('这是同一次完整发声，不应因切镜而重复等待。'.repeat(30));
 const source=normalizeSource({key:'flat-read-projection',sourceRows:[{id:'long-source-coordinate-for-speaking',text:row}],context:{verbatimSource:row}});
 const payload={stage:'plan',source,settings:{maxUnitSeconds:30,maxUnits:null,fantasyMode:'off'},voiceReference:{scope:ttsScope,rows:[{id:source.dialogue[0].id,quote:source.dialogue[0].quote,seconds:130}]}};
 const request=buildRequest(payload);
 assert.ok(request.prompt.includes('【资料单跳等值引用】'));
 assert.equal(input(request).source.context.verbatimSource.$same,'#/source/sourceRows/0/text');
 assert.deepEqual(input(request).voiceReference.rows,[]);
});
