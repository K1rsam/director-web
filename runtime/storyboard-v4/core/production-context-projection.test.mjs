import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildRequest,captureRules as currentRules} from './core.mjs';
import {standardPackageSource} from './standard-source.mjs';
import {normalizeSource} from './source.mjs';
import {PLAN_VERSION,VERSION,digest} from './shared.mjs';
import {projectProductionSource} from './production-context-projection.mjs';
import {validateProductionFeedback} from '../../episode-boundary.mjs';

const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/production-projection-source.json',import.meta.url),'utf8'));
// These assertions isolate the frozen v2/v3 lossless projection, not the new
// opt-in selection contract (covered by production-scoped-supply.test.mjs).
function captureRules(){const rules=currentRules();rules.modelProjectionVersion='production-context-v3';delete rules.productionSupplyVersion;delete rules.opportunityCoverageVersion;return rules;}
const newVersion='production-context-v3';
const frozenSettings={model:'gpt-6-sol',reasoning:'medium',visualStyle:'3D三渲二国漫横屏16:9；C4D/Octane风格精细渲染，赛璐璐光影结合PBR材质。角色身份、衣发与道具一致；人物表演的强弱与幅度服从本段情绪和策略，摄影、声光、动作共同组织，空间可读、有纵深。无额外字幕、水印、logo、BGM；源剧情必要屏幕信息保留。'};
const fact=(id,evidence,statement,extra={})=>({id,evidence,subjects:['甲'],kind:'STATE',claim:'SOURCE',applicability:'SUBJECT',validity:{status:'UNKNOWN'},...(statement===undefined?{}:{statement}),...extra});
function payload(){
 const current=fact('current-index',{domain:'EPISODE',episode:2,start:0,end:fixture.text.indexOf('\n')+1});
 const background=fact('background-index',{domain:'CONTEXT',sectionKey:'bio',start:0,end:7},'甲不能负重。\n',{contextRef:'background'});
 const history=fact('history-index',{domain:'EPISODE',episode:1,start:0,end:8},'△甲昨天受伤。\n',{contextRef:'missing-history'});
 const context={documentRevision:'audit-only',sourceContextVersion:'audit-version',directorNotes:'保留克制、喘息与停顿',followUps:[],modelDesigns:[{assetKey:'hero',adoptionVersion:8,brief:'灰衣，袖口收紧',materialAvailability:'TEXT_ONLY',references:[]}],seriesDirection:{brief:'克制但不削弱情绪'},retrievalFacts:{schema:'FOUNDATION_FACTS_V1',sourceVersion:'episode-global',current:[current],sourceFactIndex:[current],background:[background],historicalStates:[history],backgroundCandidates:[],unlinkedBackground:[],rules:'历史不自动继承。'}};
 const source=normalizeSource(standardPackageSource(fixture.package,{key:'projection',title:'证据瘦身',sourceText:fixture.text,context,contextRows:[{id:'background',text:'甲不能负重。\n',kind:'guidance',evidenceRole:'guidance'},{id:'history',text:'△甲昨天受伤。',kind:'context'},{id:'empty-context',text:' \n',kind:'context'}]}));
 source.assets=[{key:'hero',name:'甲',variants:[]}];
 source.entryFacts=[{id:'known',subject:'甲',statement:'前场受伤',sourceRefs:['history'],evidence:'昨天受伤'}];
 const sourceRefs=source.sourceRows.map(row=>row.id),emotionContract={subject:'甲',contextTone:'克制',audienceEffect:'担心',change:'忍痛坚持',landing:'绷带',retain:['完整原话','有力表演']};
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'忍痛坚持',entryFacts:[],fantasyCandidates:[],events:[{id:'e1',sourceRefs,sceneKey:'屋内',boundaryBefore:{kind:'episode_start',reason:'本集开始'},emotionContract}],workPackages:[{id:'p1',eventId:'e1',sourceRefs,emotionContract,entryFactIds:['known'],contextRefs:['history'],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'u1',packageId:'p1',sourceRefs,secondsRange:[2,5]}]};
 return {source,plan,packageId:'p1',settings:{...frozenSettings,maxUnits:null,fantasyMode:'off'},voiceReference:{scope:'只作平读容量参照',rows:[{id:source.dialogue[0].id,quote:source.dialogue[0].quote,seconds:1.5}]}};
}
function request(stage='plan',p=payload(),rulesSnapshot=captureRules()){return buildRequest({...p,stage:stage==='delta'?'finish':stage,finishMode:stage==='delta'?'delta':'full',...(stage==='finish'||stage==='delta'?{previousDraft:{schemaVersion:VERSION,units:[{id:'p1-u1',shots:[]}],fantasyRealization:[]}}:{}),rulesSnapshot});}
const model=r=>JSON.parse(r.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n')[0]);
function factsOf(value){
 const f=value.source.context.retrievalFacts;if(!f)return [];
 if(!f.rows)return ['current','sourceFactIndex','background','backgroundCandidates','historicalStates','unlinkedBackground'].flatMap(k=>f[k]||[]);
 return f.rows.map(row=>{const fact={};for(const [i,column] of f.columns.entries()){const key=column.replace(/\?$/,'');if(key==='extra')Object.assign(fact,row[i]);else if(row[i]!==undefined&&!(key==='statement'&&row[i]===null))fact[key]=row[i];}return fact;});
}
function splitPayload(){
 const p=payload(),groups=[p.source.sourceRows.slice(0,2),p.source.sourceRows.slice(2)].map(rows=>rows.map(row=>row.id)),emotionContract=p.plan.events[0].emotionContract;
 p.plan.events=groups.map((sourceRefs,i)=>({id:`e${i+1}`,sourceRefs,sceneKey:'屋内',boundaryBefore:{kind:i?'new_event':'episode_start',reason:i?'下一完整事件':'本集开始'},emotionContract}));
 p.plan.workPackages=groups.map((sourceRefs,i)=>({...p.plan.workPackages[0],id:`p${i+1}`,eventId:`e${i+1}`,sourceRefs}));
 p.plan.provisionalUnits=groups.map((sourceRefs,i)=>({id:`u${i+1}`,packageId:`p${i+1}`,sourceRefs,secondsRange:[2,5]}));
 const last=fixture.package.evidence.at(-1),later=fact('later-index',{domain:'EPISODE',episode:2,start:last.start,end:last.end});
 p.source.context.retrievalFacts.current.push(later);p.source.context.retrievalFacts.sourceFactIndex.push(later);
 return p;
}

function withHistorical(p=payload(),empty=false){
 const f=p.source.context.retrievalFacts;
 f.historicalEvidenceCandidates=empty?[]:[{...structuredClone(f.historicalStates[0]),candidateUse:'HISTORICAL_EVIDENCE_ONLY',currentApplicability:'UNKNOWN',retrieval:{mode:'SUBJECT_MENTION',anchorFactIds:['history-index']}}];
 f.historicalEvidenceRejected=0;
 return p;
}

test('new historical root fields no longer disable proven mechanical-index deduplication',()=>{
 for(const empty of [true,false])for(const stage of ['plan','author','finish','delta']){
  const p=withHistorical(payload(),empty),before=structuredClone(p),r=request(stage,p),actual=model(r),f=actual.source.context.retrievalFacts;
  assert.equal(factsOf(actual).some(f=>f.evidence?.domain==='EPISODE'&&f.evidence.episode===2),false,`${stage}, empty=${empty}`);
  assert.deepEqual(f.historicalEvidenceCandidates,before.source.context.retrievalFacts.historicalEvidenceCandidates);
  assert.equal(f.historicalEvidenceRejected,0);
  assert.deepEqual(p,before);assert.deepEqual(r.source.context.retrievalFacts,before.source.context.retrievalFacts);
  assert.deepEqual(actual.source.dialogue.map(({quote,cue,channel})=>({quote,cue,channel})),p.source.dialogue.map(({quote,cue,channel})=>({quote,cue,channel})));
  assert.deepEqual(actual.source.entryFacts,r.source.entryFacts);assert.deepEqual(actual.source.assets,p.source.assets);
 }
});

test('historical claims, releases, retrieval links and their referenced fact ids are retained',()=>{
 const p=withHistorical(),f=p.source.context.retrievalFacts;
 f.historicalEvidenceCandidates.push({...structuredClone(f.historicalEvidenceCandidates[0]),id:'release',kind:'UTTERANCE',claim:'CHARACTER_CLAIM',statement:'甲：伤已经好了，但不能说出去。',retrieval:{mode:'SOURCE_NEIGHBOUR',anchorFactIds:['history-index','current-index']}});
 f.historicalEvidenceRejected=3;
 const before=structuredClone(p),actual=model(request('plan',p)),projected=actual.source.context.retrievalFacts;
 assert.deepEqual(projected.historicalEvidenceCandidates,f.historicalEvidenceCandidates);
 assert.equal(projected.historicalEvidenceRejected,3);
 assert.ok(factsOf(actual).some(f=>f.id==='history-index'));
 assert.ok(factsOf(actual).some(f=>f.id==='current-index'),'a referenced mechanical index must stay addressable');
 assert.deepEqual(p,before);
});

test('unknown historical extensions, malformed links and metadata use the complete lossless fallback',()=>{
 for(const mutate of [
  f=>f.historicalEvidenceCandidates[0].extension={factId:'current-index'},
  f=>f.historicalEvidenceCandidates[0].retrieval.extra={factId:'current-index'},
  f=>f.historicalEvidenceCandidates[0].retrieval.anchorFactIds=[{factId:'current-index'}],
  f=>f.historicalEvidenceCandidates[0].retrieval.mode='FUTURE_RETRIEVAL',
  f=>f.historicalEvidenceCandidates[0].currentApplicability='CONFIRMED',
  f=>f.historicalEvidenceCandidates[0].evidence.end={factId:'current-index'},
  f=>f.historicalEvidenceCandidates={future:['current-index']},
  f=>f.historicalEvidenceRejected={factId:'current-index'},
  f=>f.historicalEvidenceRejected=-1,
 ]){
  const p=withHistorical();mutate(p.source.context.retrievalFacts);const before=structuredClone(p.source.context.retrievalFacts),actual=model(request('plan',p));
  assert.deepEqual(actual.source.context.retrievalFacts.historicalEvidenceCandidates,before.historicalEvidenceCandidates);
  assert.deepEqual(actual.source.context.retrievalFacts.historicalEvidenceRejected,before.historicalEvidenceRejected);
  assert.ok(factsOf(actual).some(f=>f.id==='current-index'));
  assert.deepEqual(p.source.context.retrievalFacts,before);
 }
});

test('partial requests with historical candidates retain unsent source facts and all historical evidence',()=>{
 for(const stage of ['author','finish','delta']){
  const p=withHistorical(splitPayload()),actual=model(request(stage,p)),later=fixture.package.evidence.at(-1);
  assert.equal(actual.source.sourceRows.some(row=>row.text===later.text),false);
  assert.ok(factsOf(actual).some(f=>f.evidence?.start===later.start&&f.evidence?.end===later.end));
  assert.equal(factsOf(actual).some(f=>f.evidence?.domain==='EPISODE'&&f.evidence.episode===2&&f.evidence.start===0),false);
  assert.deepEqual(actual.source.context.retrievalFacts.historicalEvidenceCandidates,p.source.context.retrievalFacts.historicalEvidenceCandidates);
 }
});

test('frozen production-context-v2 requests retain their exact prompt, input and schema bytes',()=>{
 const rules=captureRules();Object.assign(rules,{modelProjectionVersion:'production-context-v2',instructions:'固定指令',planHint:'固定计划',draftHint:'固定主创',deltaHint:'固定差异'});rules.files=Object.fromEntries(Object.keys(rules.files).map(p=>[p,'固定方法 '+p]));
 // The saved v2 snapshot predates the opt-in screen rhythm contract.
 rules.creativeRevision='expressive-cadence-v1';
 delete rules.rhythmContractVersion;
 delete rules.fantasyTimingVersion;
 delete rules.visualSubjectsVersion;
 delete rules.generationTextVersion;
 const observed=[];
 for(const historical of [false,true])for(const stage of ['plan','author','finish','delta']){
  const r=request(stage,historical?withHistorical():payload(),rules);observed.push([historical,stage,r.promptHash,r.inputHash,r.prompt.length,JSON.stringify(r.schema).length]);
 }
 assert.deepEqual(observed,[
  [false,'plan','0987df37f85b3a846bf9909a19485f9dcf70a43910ab9fde1f09ace111c6aed5','7e67e30a20662ea84b4778346deb28c1050d65b5118e8fda9539e96525235d96',2961,4042],
  [false,'author','0fd9554efd4ea26dd3351df052fc1b5005c126802105bcfb5f912d5faf6b72e5','9e8255ff703376ca7cfb818427998a10c63ea129517adaf260b742322fcf38c3',4261,2953],
  [false,'finish','9e99c6f15febcb56817581bf836ff93290b226a2d5839547a421907dc51d8830','3e19fd8f1ebfe820963ae6e7ccd61b173602a005bc68ac4b353f0ad508812de5',4856,3549],
  [false,'delta','6a71bffe637871a6528a47264ecc0a407fb10dd53c3a9fb5635b503aa0b5559b','1b2fe4004f67fdc2b7255d0f7fc38279476fde496bf357101710aacb432dd90f',4914,3989],
  [true,'plan','8a5162e797aa51ea0cba9f426f4270b4dc4e4114b49708836c20425389d745c5','e38f5b91cd00c59e6d439d21e0b0ee3b4238a13310c7a0bf08c6745729b41eb9',3864,4042],
  [true,'author','5c9809c0986db464749e690875f0e28589d89634aa94ba2bd92f01c64428a65a','6c1de2c50d31700f398de69466c92eb8df58e0dcee856c0e2304add2ac24644d',5164,2953],
  [true,'finish','1e931c7838759242bdc568a2de03e57999bba7d954bd860488781ed2d2f5e8c8','f5341022bf4628dedf2d46f1a94cd4f8789ad31fa8589efb99d0a90859a76509',5759,3549],
  [true,'delta','ff8ecaf1a0cfffb74aa4d31f776886c6eb9b9b068d9fc62f265927a8424186a9','f474b2f7c052e277d0619e73cfd2de95e5d1029ef061b2a161dbdd44b14445f6',5817,3989]
 ]);
});

test('new snapshot projects mechanical indexes and blanks, without changing canonical source or dialogue',()=>{
 assert.equal(captureRules().modelProjectionVersion,newVersion);
 for(const stage of ['plan','author','finish','delta']){
  const p=payload(),before=structuredClone(p),r=request(stage,p),actual=model(r);
  assert.deepEqual(p,before);assert.deepEqual(r.source.context.retrievalFacts,p.source.context.retrievalFacts);
  assert.equal(factsOf(actual).some(f=>f.evidence?.domain==='EPISODE'&&f.evidence.episode===2),false,stage);
  assert.equal(actual.source.sourceRows.some(row=>!row.text.trim()),false,stage);
  assert.equal(actual.source.contextRows.some(row=>!row.text.trim()),false,stage);
  assert.equal(JSON.stringify(r.schema).includes('empty-context'),false,stage);
  assert.deepEqual(actual.source.dialogue.map(({quote,cue,channel})=>({quote,cue,channel})),p.source.dialogue.map(({quote,cue,channel})=>({quote,cue,channel})));
  assert.deepEqual(actual.source.entryFacts,r.source.entryFacts);
  assert.deepEqual(actual.voiceReference.rows,[{id:p.source.dialogue[0].id,seconds:1.5}]);
  assert.equal(Object.hasOwn(actual.source.context,'documentRevision'),false);
  assert.equal(actual.source.context.directorNotes,'保留克制、喘息与停顿');
 }
});

test('background statement is omitted only for exact present context text; missing or inexact refs retain it',()=>{
 const actual=model(request()),facts=factsOf(actual);
 assert.ok(!facts.some(f=>f.statement==='甲不能负重。\n'));
 assert.ok(JSON.stringify(facts).includes('background'));
 assert.ok(facts.some(f=>f.statement==='△甲昨天受伤。\n'));
 for(const mutate of [p=>p.source.contextRows=p.source.contextRows.filter(r=>r.id!=='background'),p=>p.source.contextRows.find(r=>r.id==='background').text='甲可以负重。\n']){
  const p=payload();mutate(p);assert.ok(factsOf(model(request('author',p))).some(f=>f.statement==='甲不能负重。\n'));
 }
});

test('partial author and finishing requests retain indexes for source rows not actually sent',()=>{
 for(const stage of ['author','finish','delta']){
  const p=splitPayload(),actual=model(request(stage,p)),later=fixture.package.evidence.at(-1);
  assert.equal(actual.source.sourceRows.some(row=>row.text===later.text),false,stage);
  assert.ok(factsOf(actual).some(f=>f.evidence?.start===later.start&&f.evidence?.end===later.end),stage);
  assert.equal(factsOf(actual).some(f=>f.evidence?.domain==='EPISODE'&&f.evidence.episode===2&&f.evidence.start===0),false,stage);
 }
});

test('unverified standard-package metadata on a legacy source is not a mechanical index proof',()=>{
 const p=payload();delete p.source.sourceProtocol;delete p.source.dialogue;
 p.source.sourceRows=p.source.sourceRows.map(({id,line,text})=>({id,line,text:text.trimEnd()}));
 assert.ok(factsOf(model(request('plan',p))).some(f=>f.evidence?.domain==='EPISODE'&&f.evidence.episode===2));
});

test('voice quote removal requires an exact current dialogue duplicate and preserves extra reference information',()=>{
 for(const stage of ['plan','author','finish','delta']){
  const p=payload();p.voiceReference.rows[0].quote='不同的参照原句';p.voiceReference.rows[0].delivery='须保留气息和停顿';p.voiceReference.sourceNote='保留参照说明';
  const actual=model(request(stage,p));
  assert.equal(actual.voiceReference.rows[0].quote,'不同的参照原句',stage);
  assert.equal(actual.voiceReference.rows[0].delivery,'须保留气息和停顿',stage);
  assert.equal(actual.voiceReference.sourceNote,'保留参照说明',stage);
 }
});

test('conflicting or missing context references cannot justify statement omission',()=>{
 for(const refs of [{contextRefs:['missing']},{contextRefs:[]},{contextRef:42,contextRefs:['background']}]){
  const p=payload();Object.assign(p.source.context.retrievalFacts.background[0],refs);
  assert.ok(factsOf(model(request('plan',p))).some(f=>f.statement==='甲不能负重。\n'));
 }
});

test('blank rows referenced by entry facts remain available without rewriting the fact',()=>{
 const p=payload();p.source.entryFacts[0].sourceRefs.push('empty-context');
 for(const stage of ['plan','author','finish','delta']){
  const actual=model(request(stage,p));
  assert.ok(actual.source.contextRows.some(row=>row.id==='empty-context'),stage);
  assert.deepEqual(actual.source.entryFacts,p.source.entryFacts,stage);
 }
});

test('model plan removes omitted blank references from nested beat contracts without changing emotion content',()=>{
 const p=payload(),blankId=p.source.sourceRows.find(row=>!row.text.trim()).id,r=request('author',p),actual=model(r);
 assert.equal(actual.plan.workPackages[0].beatContracts[0].sourceRefs.includes(blankId),false);
 assert.deepEqual(actual.plan.workPackages[0].beatContracts[0].emotionContract,r.plan.workPackages[0].beatContracts[0].emotionContract);
 assert.ok(r.plan.workPackages[0].beatContracts[0].sourceRefs.includes(blankId));
});

test('unknown metadata and evidence extensions remain visible; unproven current records are not dropped',()=>{
 for(const mutate of [f=>f.extension={why:'未知有用事实'},f=>f.evidence.extra='未知坐标',f=>f.validity={status:'EXPLICIT',basis:'实际核验'},f=>f.evidence.end=9999,f=>f.evidence.episode=9,f=>f.kind='FUTURE_KIND']){
  const p=payload();mutate(p.source.context.retrievalFacts.current[0]);const before=structuredClone(p.source.context.retrievalFacts.current[0]);
  const actual=model(request('plan',p));
  assert.ok(factsOf(actual).some(f=>JSON.stringify(f.evidence)===JSON.stringify(before.evidence)&&JSON.stringify(f.validity)===JSON.stringify(before.validity)&&f.kind===before.kind));
  if(before.extension)assert.ok(JSON.stringify(actual).includes('未知有用事实'));
  assert.deepEqual(p.source.context.retrievalFacts.current[0],before);
 }
 const p=payload();p.source.context.retrievalFacts.extension={references:['current-index'],note:'未知顶层资料'};
 assert.ok(JSON.stringify(model(request('plan',p))).includes('未知顶层资料'));
 assert.ok(JSON.stringify(model(request('plan',p))).includes('current-index'));
 p.source.context.retrievalFacts={schema:'FUTURE_FACTS',anything:{raw:'保留未来资料'}};
 assert.deepEqual(model(request('plan',p)).source.context.retrievalFacts,p.source.context.retrievalFacts);
});

test('unknown nested evidence or validity shapes retain their fact ids and full data',()=>{
 const reference={origin:{domain:'EPISODE',episode:1,start:0,end:8},offsetUnit:'UTF16',verifiedAgainst:'PREVIOUS_EXCERPT',excerptRange:{start:0,end:8},coordinateRule:'原文片段坐标'};
 for(const mutate of [
  f=>f.validity.start={factId:f.id},
  f=>f.validity.end={factId:f.id},
  f=>f.evidence.start={factId:f.id},
  f=>f.evidence.episode={factId:f.id},
  f=>f.contextEvidence={...reference,excerptRange:{...reference.excerptRange,factId:f.id}},
  f=>f.contextEvidence={...reference,excerptRange:{start:{factId:f.id},end:8}},
  f=>f.contextEvidence={...reference,origin:{...reference.origin,start:{factId:f.id}}},
  f=>f.contextEvidence={...reference,coordinateRule:{factId:f.id}},
  f=>f.contextEvidence={...reference,verifiedAgainst:{factId:f.id}},
 ]){
  const p=payload(),original=p.source.context.retrievalFacts.current[0];mutate(original);
  const before=structuredClone(original),actual=model(request('plan',p));
  assert.deepEqual(factsOf(actual).find(f=>f.id===before.id),before,'unknown nested semantics must use the lossless projection');
  assert.deepEqual(original,before,'canonical evidence remains unchanged');
 }
});

test('unknown values inside nominally known root metadata retain the original fact links',()=>{
 for(const key of ['sourceVersion','sourceContextVersion','backgroundCandidatesOmitted','unlinkedBackgroundCount','rules']){
  const p=payload();p.source.context.retrievalFacts[key]={factId:'current-index'};
  const actual=model(request('plan',p));
  assert.deepEqual(actual.source.context.retrievalFacts[key],{factId:'current-index'},key);
  assert.ok(factsOf(actual).some(f=>f.id==='current-index'),key);
 }
});

test('retrieval-facts-v1 frozen snapshot keeps the four stage prompt and input bytes',()=>{
 const rules=captureRules();Object.assign(rules,{modelProjectionVersion:'retrieval-facts-v1',instructions:'固定指令',planHint:'固定计划',draftHint:'固定主创',deltaHint:'固定差异'});rules.files=Object.fromEntries(Object.keys(rules.files).map(p=>[p,'固定方法 '+p]));
 // This fixture models a saved old snapshot, not today's newly captured rules/defaults.
 rules.creativeRevision='expressive-cadence-v1';
 for(const key of ['unitDirectionVersion','seedanceExportVersion','sourceProjection','inputProjectionVersion','sourceExpressionMethodsVersion','authorCallGroupingVersion','schemaProjectionVersion','acceptedContinuityVersion','rhythmContractVersion','fantasyTimingVersion','visualSubjectsVersion','generationTextVersion'])delete rules[key];
 const observed=['plan','author','finish','delta'].map(stage=>{const r=request(stage,payload(),rules);return [stage,r.promptHash,r.inputHash,r.prompt.length,JSON.stringify(r.schema).length];});
 assert.deepEqual(observed,[
  ['plan','8c0617d110290588778962b61bc8aa987164d9902d69338f0fc4a268a940f29b','2c474c7a2cc2ac238c2eee1287ad40609687143221b3c84e1d0c8147f4c228fc',3517,4194],
  ['author','b80b6fc2286188cdf272651b731961ea13305ce3ac65b17044d4f984b5dd2d27','f06324e1ec2e3d107b8944675e0bad71da53e1fe4261b4e3405d84afb451902b',4868,2959],
  ['finish','51d9e7b91e0323550616cfa2d75d7738726adcadf1981912ad3dc3cfc2d75501','4bbb5385a8c3ed3608080f8c3c1ebc7e58bebdac50832799dc963d860f5272fe',5442,3575],
  ['delta','c6f4919e6fc2b88ec3e810bb95d8ec3685e7d0ccb1d4247eabc918fc3983ba63','c8637ceb99ba9a4b8b70d0087e6565566da867e07252bec15fcf3568a400108f',5500,4015]
 ]);
});

function evidenceRoleSource(){
 return normalizeSource({key:'row-evidence',sourceRows:[{id:'source-action',text:'△甲关门。',evidenceRole:'source'},{id:'source-guide',text:'△甲保持神态。',evidenceRole:'guidance'}],contextRows:[{id:'guide-speech',kind:'dialogue',text:'甲：我无所不能。',evidenceRole:'guidance'},{id:'guide-action',kind:'action',text:'建议甲显得强大。',evidenceRole:'guidance'},{id:'true-action',kind:'action',text:'△甲放下钥匙。',evidenceRole:'source'},{id:'untyped',kind:'context',text:'未评级的原上下文'}],entryFacts:[],assets:[]});
}

test('v5 preserves evidence roles in source and context rows for standard and fast inputs without inferring missing roles',()=>{
 const fast=evidenceRoleSource(),standard=payload().source;
 standard.contextRows.push(...fast.contextRows.map(row=>structuredClone(row)));
 for(const source of [fast,standard]){
  const before=structuredClone(source),projected=projectProductionSource(source,'production-context-v5');
  for(const table of ['sourceRows','contextRows'])for(const row of projected[table]){
   const original=source[table].find(r=>r.id===row.id);
   assert.equal(row.evidenceRole,original.evidenceRole,`${source.sourceProtocol??'fast'} ${row.id}`);
   assert.equal(Object.hasOwn(row,'evidenceRole'),Object.hasOwn(original,'evidenceRole'));
   assert.equal(row.text,original.text);assert.equal(row.kind,original.kind);
  }
  assert.deepEqual(projected.dialogue.map(({quote,cue,channel})=>({quote,cue,channel})),source.dialogue.map(({quote,cue,channel})=>({quote,cue,channel})));
  assert.deepEqual(source,before);
  for(const ref of ['guide-speech','guide-action']){
   assert.throws(()=>normalizeSource({...source,entryFacts:[{id:'forbidden',subject:'甲',statement:'甲无所不能',sourceRefs:[ref],evidenceMode:'source_rows'}]}),{code:'ENTRY_FACT_GUIDANCE'});
   assert.throws(()=>validateProductionFeedback({relation:'DIRECT',entry:[{key:'power',value:'甲无所不能',authority:'SOURCE',sourceRefs:[ref]}],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]},{source}),{code:'PRODUCTION_FEEDBACK'});
  }
 }
});

test('v2 v3 v4 row projections preserve their original bytes and v4 historical table behavior',()=>{
 const source=evidenceRoleSource();
 for(const version of ['production-context-v2','production-context-v3','production-context-v4']){
  const projected=projectProductionSource(source,version);
  assert.equal(digest(projected),'2f6674a47840300bdf56d92cc025f1b05ee4e01d022b9fa439c923d77e7fb83a',version);
  assert.ok([...projected.sourceRows,...projected.contextRows].every(row=>!Object.hasOwn(row,'evidenceRole')),version);
 }
 const historical=withHistorical().source;
 const old=projectProductionSource(historical,'production-context-v4'),next=projectProductionSource(historical,'production-context-v5');
 assert.deepEqual(next.context,old.context,'v5 changes row evidence visibility only, retaining v4 historical projection');
});
