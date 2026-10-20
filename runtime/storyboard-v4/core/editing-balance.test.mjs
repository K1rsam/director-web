import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {rhythmBrief} from './rhythm-brief.mjs';
import {captureRules,buildRequest} from './core.mjs';
import {normalizeSource} from './source.mjs';

const quote='同一句话连续说完，画面按作用交接。';
const source={dialogue:[{id:'q',quote}]};
const draft=()=>({units:[{id:'u',eventId:'e',scene:'大厅',boundaryBefore:{kind:'episode_start'},shots:[
 {id:'long',duration:12,dialogueParts:[{lineId:'q',text:quote.slice(0,9),voiceStart:9,voiceEnd:11.5}]},
 {id:'next',duration:9,dialogueParts:[{lineId:'q',text:quote.slice(9),voiceStart:0,voiceEnd:2}]}
]}]});
const inspect=(previousDraft,version)=>rhythmBrief({source,previousDraft,maxUnitSeconds:30,...(version?{version}:{})});

test('new edition restores editing references without imposing a shot length or a shot quota',()=>{
 const brief=inspect(null);
 assert.equal(brief.version,'screen-rhythm-v5');
 assert.deepEqual(brief.shotSeconds.preferred,[2,5]);
 assert.equal(brief.shotSeconds.isHardLimit,false);
 assert.equal(brief.shotSeconds.ordinaryMinimumExclusive,undefined);
 assert.equal(brief.shotSeconds.automaticRetiming,false);
 assert.deepEqual(brief.shotDensityPer30,{reference:[8,12],isQuota:false});
 assert.equal(brief.audit,null);
});

test('long-view review and voice continuity coexist without a pause, retime, or automatic fault',()=>{
 const input=draft(),saved=structuredClone(input),brief=inspect(input);
 assert.equal(brief.audit.viewingReview.advisoryOnly,true);
 assert.deepEqual(brief.audit.viewingReview.longShots.map(s=>s.shotId),['long','next']);
 assert.equal(brief.audit.viewingReview.sparseUnits[0].unitId,'u');
 assert.equal(brief.audit.speech.continuityGaps[0].gaps[0].seconds,0.5);
 assert.equal(brief.audit.errors,undefined);
 assert.equal(brief.audit.shortShots,undefined);
 assert.equal(brief.cutPolicy.naturalSourceTailExempt,true);
 assert.equal(brief.cutPolicy.integerUnitEnd,true);
 assert.deepEqual(input,saved);
 const short=draft();short.units[0].shots=[{id:'impact',duration:0.8,dialogueParts:[]}];
 assert.deepEqual(inspect(short).audit.viewingReview.longShots,[]);
 assert.deepEqual(inspect(short).audit.viewingReview.sparseUnits,[]);
});

test('v1-v4 advisory inputs stay byte-identical after new defaults are introduced',()=>{
 const hashes={
  'screen-rhythm-v1':'c2d91368c7a677c69c74cd4f643b43dcd0357cc3ec90cc85f62dabd38c5d55fd',
  'screen-rhythm-v2':'8d35aabf1d94e60221e89a867ba8185daf7584b342dabff49e7cc6e912903075',
  'screen-rhythm-v3':'479bc44ca3bc0926c8df36c4b8dfb3b4286aa0c1b3f06f1769d80ab03e0e912d',
  'screen-rhythm-v4':'f5714ced34c8da2294e6e4795dafc2c49529c31eb791635a6aa7a42a70e0d9b8',
 };
 for(const [version,hash] of Object.entries(hashes))assert.equal(createHash('sha256').update(JSON.stringify(inspect(draft(),version))).digest('hex'),hash,version);
});

test('v2, frozen v3 and current v4 retain flat-read projection and source content',()=>{
 const input=request=>JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以各工作包')[0]);
 const src=normalizeSource({key:'editing-balance',sourceRows:[{id:'r',text:'甲：'+quote}]}),current=captureRules();
 assert.equal(current.creativeRevision,'expressive-cadence-v4');
 for(const revision of ['expressive-cadence-v2','expressive-cadence-v3','expressive-cadence-v4']){
  const rulesSnapshot={...current,creativeRevision:revision,rhythmContractVersion:revision.endsWith('v2')?'screen-rhythm-v3':'screen-rhythm-v4'};
  const data=input(buildRequest({stage:'plan',source:src,rulesSnapshot,settings:{maxUnits:null,maxUnitSeconds:30,fantasyMode:'off'},voiceReference:{scope:'Tingting rate200本机平读，仅语言容量参照非演员实配',rows:[{id:src.dialogue[0].id,seconds:8}]}}));
  assert.equal(data.creativeRevision,revision);
  assert.equal(data.voiceReference.measurementsOmitted,true);
  assert.deepEqual(data.voiceReference.rows,[]);
  assert.equal(data.capacityBrief.voiceReference.seconds,undefined);
  assert.ok(JSON.stringify(data).includes(quote));
 }
});
