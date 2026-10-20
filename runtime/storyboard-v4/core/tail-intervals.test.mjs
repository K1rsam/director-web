import test from 'node:test';
import assert from 'node:assert/strict';
import {rhythmBrief,RHYTHM_CONTRACT_VERSION,RHYTHM_CONTRACT_VERSIONS} from './rhythm-brief.mjs';

const source={dialogue:[
 {id:'q1',quote:'你敢动我儿子一下试试！'},
 {id:'q2',quote:'我已经听清楚了。'},
 {id:'roar',quote:'嗷呜！',kind:'roar'},
]};
const voice=(lineId='q1',voiceStart=0,voiceEnd=2,text=source.dialogue.find(q=>q.id===lineId)?.quote)=>({lineId,text,voiceStart,voiceEnd});
const shot=(id,duration,dialogueParts=[])=>({id,duration,dialogueParts});
const unit=(id,shots,kind='episode_start',extra={})=>({id,eventId:'e',scene:'大厅',boundaryBefore:{kind},shots,...extra});
const inspect=(units,src=source,version='screen-rhythm-v5')=>rhythmBrief({source:src,previousDraft:{units},maxUnitSeconds:30,version});
const tail=(fromUnit,fromShot,fromTime,toUnit,toShot,toTime,seconds,lineId='q1')=>({
 from:{lineId,unitId:fromUnit,shotId:fromShot,unitTime:fromTime},
 to:{unitId:toUnit,shotId:toShot,unitTime:toTime},seconds,
});

test('v5 reports a four-second post-utterance range without claiming idle time or changing the draft',()=>{
 const units=[unit('u',[shot('speech',3.5,[voice('q1',0,2.5)]),shot('hold',3)])],saved=structuredClone(units);
 const brief=inspect(units);
 assert.equal(RHYTHM_CONTRACT_VERSION,'screen-rhythm-v5');
 assert.deepEqual(RHYTHM_CONTRACT_VERSIONS,['screen-rhythm-v1','screen-rhythm-v2','screen-rhythm-v3','screen-rhythm-v4','screen-rhythm-v5']);
 assert.deepEqual(brief.audit.speech.tailIntervals,[tail('u','speech',2.5,'u','hold',6.5,4)]);
 assert.deepEqual(units,saved);
 assert.equal(brief.audit.errors,undefined);
 assert.equal(brief.shotSeconds.automaticRetiming,false);
 assert.equal(brief.audit.viewingReview.advisoryOnly,true);
 assert.ok(!JSON.stringify(brief.audit.speech.tailIntervals).includes(source.dialogue[0].quote));
 assert.match(brief.caveat,/语气.*停顿/);
 assert.match(brief.caveat,/声后时间不等于.*空白/);
 assert.match(brief.caveat,/范围末尾.*不.*片尾/);
});

test('one tail spans known continuous and capacity units after the final complete utterance fragment',()=>{
 const quote=source.dialogue[0].quote;
 const units=[
  unit('u1',[shot('s1',3,[voice('q1',0,3,quote.slice(0,5))])]),
  unit('u2',[shot('s2',2,[voice('q1',0,1.5,quote.slice(5))])],'continuous'),
  unit('u3',[shot('s3',2)],'capacity'),
 ];
 assert.deepEqual(inspect(units).audit.speech.tailIntervals,[tail('u2','s2',1.5,'u3','s3',2,2.5)]);
});

test('a following utterance remains a turn gap, not an additional tail for the preceding utterance',()=>{
 const units=[unit('u',[shot('s1',3.5,[voice('q1',0,2.5)]),shot('s2',3),shot('s3',1,[voice('q2',0,1)])])];
 const speech=inspect(units).audit.speech;
 assert.equal(speech.turnGaps?.length,1);
 assert.equal(speech.turnGaps[0].seconds,4);
 assert.deepEqual(speech.tailIntervals,[]);
});

test('tails do not cross changed scenes, events, or unknown unit boundaries',()=>{
 const starts=()=>unit('u1',[shot('s1',3,[voice()])]);
 const cases=[
  unit('u2',[shot('s2',4)],'new_event'),
  unit('u2',[shot('s2',4)],'time_space_jump'),
  unit('u2',[shot('s2',4)],'unknown'),
  unit('u2',[shot('s2',4)],'continuous',{boundaryBefore:undefined}),
  unit('u2',[shot('s2',4)],'continuous',{eventId:'other'}),
  unit('u2',[shot('s2',4)],'continuous',{scene:'室外'}),
  unit('u2',[shot('s2',4)],'continuous',{eventId:null}),
  unit('u2',[shot('s2',4)],'continuous',{scene:''}),
 ];
 for(const next of cases)assert.deepEqual(inspect([starts(),next]).audit.speech.tailIntervals,[tail('u1','s1',2,'u1','s1',3,1)]);
});

test('unknown timing breaks tail ranges rather than borrowing a later known endpoint',()=>{
 const before=unit('u1',[shot('s1',3,[voice()])]),after=unit('u3',[shot('s3',5)],'continuous');
 for(const broken of [null,unit('u2',[],'continuous'),unit('u2',[shot('bad',null)],'continuous'),unit('u2',[null],'continuous')]){
  assert.deepEqual(inspect([before,broken,after]).audit.speech.tailIntervals,[tail('u1','s1',2,'u1','s1',3,1)]);
 }
 assert.deepEqual(inspect([unit('u',[shot('s',3,[voice()]),shot('bad',NaN)])]).audit.speech.tailIntervals,[]);
});

test('unknown or invalid voice data conservatively prevents a tail in that range',()=>{
 const invalid=[null,voice('unknown',0,1,'不明发声'),voice('q2',0,1,'不完整原话'),voice('q2',-1,1),voice('q2',0,5),voice('q2',2,1),voice('q2',NaN,1),voice('q2',0,Infinity),{...voice('q2',0,1),text:null}];
 for(const part of invalid){
  const units=[unit('u',[shot('known',3,[voice()]),shot('bad',4,[part]),shot('hold',2)])];
  assert.deepEqual(inspect(units).audit.speech.tailIntervals,[]);
 }
 assert.deepEqual(inspect([unit('u',[shot('known',3,[voice()]),{id:'bad',duration:4},shot('hold',2)])]).audit.speech.tailIntervals,[]);
 assert.deepEqual(inspect([unit('u',[shot('overlap',4,[voice('q1',0,2),voice('q2',1,3)]),shot('hold',2)])]).audit.speech.tailIntervals,[]);
});

test('a complete source quote split across unrelated timing ranges does not become a measured tail',()=>{
 const quote=source.dialogue[0].quote;
 const units=[unit('u1',[shot('s1',3,[voice('q1',0,2,quote.slice(0,5))])]),unit('u2',[shot('s2',3,[voice('q1',0,2,quote.slice(5))])],'time_space_jump')];
 assert.deepEqual(inspect(units).audit.speech.tailIntervals,[]);
});

test('nonverbal vocalization after speech is not counted as silence or used as a spoken tail anchor',()=>{
 for(const kind of ['roar','scream','vocalization']){
  const src={dialogue:source.dialogue.map(q=>q.id==='roar'?{...q,kind}:q)};
  const units=[unit('u',[shot('spoken',3,[voice()]),shot('vocal',2,[voice('roar',0,1)]),shot('hold',3)])];
  assert.deepEqual(inspect(units,src).audit.speech.tailIntervals,[]);
  const after=[unit('u',[shot('vocal',2,[voice('roar',0,1)]),shot('spoken',3,[voice()])])];
  assert.deepEqual(inspect(after,src).audit.speech.tailIntervals,[tail('u','spoken',4,'u','spoken',5,1)]);
 }
});

test('invalid nonverbal content before a later utterance still prevents a tail estimate',()=>{
 const units=[unit('u',[shot('bad-vocal',2,[voice('roar',0,1,'错误发声')]),shot('spoken',3,[voice()])])];
 assert.deepEqual(inspect(units).audit.speech.tailIntervals,[]);
});

test('an empty speech fragment cannot move the tail anchor even when the joined quote is complete',()=>{
 const units=[unit('u',[shot('s',6,[voice('q1',0,2),voice('q1',4,5,'')])])];
 assert.deepEqual(inspect(units).audit.speech.tailIntervals,[]);
});

test('silent ranges and utterances ending at the range endpoint have no tail candidate',()=>{
 assert.deepEqual(inspect([unit('u',[shot('silent',5)])]).audit.speech.tailIntervals,[]);
 assert.deepEqual(inspect([unit('u',[shot('end',3,[voice('q1',0,3)])])]).audit.speech.tailIntervals,[]);
});

test('v1-v4 do not acquire tail interval fields',()=>{
 for(const version of ['screen-rhythm-v1','screen-rhythm-v2','screen-rhythm-v3','screen-rhythm-v4']){
  assert.equal(inspect([unit('u',[shot('s',3,[voice()])])],source,version).audit.speech.tailIntervals,undefined);
 }
});
