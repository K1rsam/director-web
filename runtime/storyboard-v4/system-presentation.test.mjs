import test from 'node:test';
import assert from 'node:assert/strict';
import {makeEpisodeInput} from './input.mjs';
import {buildRequest,captureRules} from './core/core.mjs';
import {PLAN_VERSION,VERSION} from './core/shared.mjs';

const episode={id:'system-ep',projectId:'system-project',number:2,title:'收到提示',content:'系统音：任务开始。\n△甲抬眼。'};
const project={id:episode.projectId,style:'3D国漫',aspectRatio:'16:9'};
const choice=(id='main',mode='SPRITE')=>({id,identity:'任务系统'+id,mode,carrierNotes:'在源提示出现时以小光团探头，主角反应仍按源，不新增人物互动',sourceEvidence:[{evidenceId:'episode:'+episode.id,quote:'任务开始。',episodeId:episode.id,timing:'CURRENT_EPISODE_EVIDENCE'}],sourceCarrier:null,visibility:'AUDIENCE_ONLY',audibility:'SOURCE_ONLY',contact:'NO_ADDED_CONTACT',originalVoice:'PRESERVE_SOURCE',screenText:'NO_ADDED_TEXT'});
function packet(){return {sourceText:episode.content,assets:[],scenes:[],upstream:{version:'EPISODE_UPSTREAM_V1',modelDesigns:[],seriesDirection:{status:'CONFIRMED',projection:{id:'direction',revision:2,sourceVersion:'source2',cardHash:'a'.repeat(64),brief:'主动表现，保留源事实',systemPresentation:{schemaVersion:'SYSTEM_PRESENTATION_V1',systems:[choice()],policy:'源事实及声道优先，不新增能力'}}}}};}
const build=p=>makeEpisodeInput({episode,project,handoff:{packet:p},inputProtocol:'upstream-material-v2'});
function requests(input){
 const refs=input.source.sourceRows.map(r=>r.id),emotionContract={subject:'甲',contextTone:'期待',audienceEffect:'会心',change:'收到提示',landing:'抬眼',retain:['系统原声']};
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'收到提示',entryFacts:[],fantasyCandidates:[],events:[{id:'e',sourceRefs:refs,sceneKey:'屋内',boundaryBefore:{kind:'episode_start',reason:'源事件入口'},emotionContract}],workPackages:[{id:'p',eventId:'e',sourceRefs:refs,contextRefs:[],entryFactIds:[],dependsOn:[],scenarioKeys:[],emotionContract}],provisionalUnits:[{id:'u',packageId:'p',sourceRefs:refs,secondsRange:[3,6]}]};
 return ['plan','author','full','delta'].map(kind=>buildRequest({stage:kind==='full'||kind==='delta'?'finish':kind,source:input.source,settings:{maxUnits:null,fantasyMode:'off'},plan,packageId:'p',finishMode:kind==='delta'?'delta':'full',...(kind==='full'||kind==='delta'?{previousDraft:{schemaVersion:VERSION,units:[{id:'p-u',shots:[]}],fantasyRealization:[]}}:{})}));
}
test('confirmed per-system carrier reaches actual plan/author/full/delta input independently of fantasy off',()=>{
 const p=packet();p.upstream.seriesDirection.projection.systemPresentation.systems.push(choice('other','VOICE_ONLY'));
 const before=structuredClone(p),input=build(p),s=input.source.context.seriesDirection.systemPresentation;
 assert.ok(s,'confirmed system decision must not be discarded by the native adapter');assert.equal(s.systems.length,2);assert.equal(s.systems[0].mode,'SPRITE');assert.equal(s.systems[1].mode,'VOICE_ONLY');assert.equal(s.decision.cardHash,'a'.repeat(64));
 for(const r of requests(input)){assert.equal(r.settings.fantasyEnabled,false);assert.match(r.prompt,/SYSTEM_PRESENTATION_V1/);assert.match(r.prompt,/AUDIENCE_ONLY/);assert.match(r.prompt,/系统音.*画内.*嘴/);assert.match(r.prompt,/必要提示.*off/);}
 assert.deepEqual(p,before);
});
test('draft/stale choices are not supplied and absent legacy choice keeps the original source identity',()=>{
 const p=packet();delete p.upstream.seriesDirection.projection.systemPresentation;const before=build(p);
 for(const state of ['DRAFT','STALE','UNCONFIRMED']){const next=packet();next.upstream.seriesDirection.status=state;assert.equal(build(next).source.context.seriesDirection,null);}
 assert.equal(Object.hasOwn(before.source.context.seriesDirection,'systemPresentation'),false);
 assert.ok(requests(before).every(r=>!r.prompt.includes('SYSTEM_PRESENTATION_V1')));
});
test('explicit source carrier retains the same evidence label across the native adapter',()=>{
 const p=packet(),s=p.upstream.seriesDirection.projection.systemPresentation.systems[0];
 s.sourceCarrier={...s.sourceEvidence[0],mode:s.mode};
 const projected=build(p).source.context.seriesDirection.systemPresentation.systems[0];
 assert.equal(projected.sourceCarrierStatus,'EXPLICIT_SOURCE_QUOTE');assert.equal(projected.sourceCarrier.quote,'任务开始。');
});
for(const [label,change] of [
 ['unknown protocol',s=>s.schemaVersion='future'],['duplicate identity',s=>s.systems.push(structuredClone(s.systems[0]))],
 ['new voice authority',s=>s.systems[0].originalVoice='SPRITE_LIP_DIALOGUE'],['unbound quote',s=>s.systems[0].sourceEvidence[0].quote='不在源文'],
 ['false current timing',s=>s.systems[0].sourceEvidence[0].episodeId='future-episode'],['wrong source carrier',s=>s.systems[0].sourceCarrier={...s.systems[0].sourceEvidence[0],mode:'HUD'}],
 ['background treated as current entity',s=>s.systems[0].sourceEvidence[0].timing='AUTHOR_BACKGROUND']
])test(`system projection transport fails closed: ${label}`,()=>{const p=packet();change(p.upstream.seriesDirection.projection.systemPresentation);assert.throws(()=>build(p),e=>e.code==='UPSTREAM_SYSTEM_PRESENTATION');});
test('new choices bind source identity while already built requests retain their own decision',()=>{
 const p=packet(),oldInput=build(p),old=requests(oldInput).map(r=>r.inputHash);p.upstream.seriesDirection.projection.systemPresentation.systems[0].mode='HUD';p.upstream.seriesDirection.projection.cardHash='b'.repeat(64);
 assert.notEqual(build(p).sourceVersion,oldInput.sourceVersion);assert.deepEqual(requests(oldInput).map(r=>r.inputHash),old);
 const rules=captureRules();rules.systemPresentationVersion='future';assert.throws(()=>buildRequest({stage:'plan',source:oldInput.source,settings:{maxUnits:null},rulesSnapshot:rules}),e=>e.code==='RULE_SNAPSHOT');
});
