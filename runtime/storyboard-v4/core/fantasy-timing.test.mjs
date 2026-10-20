import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDraft,validateDraft} from './quality.mjs';
import {buildOutputSchema} from './output-schema.mjs';
import {buildRequest,captureRules} from './core.mjs';
import {normalizeSource} from './source.mjs';
import {PLAN_VERSION} from './shared.mjs';
import {createCoordinator} from '../coordinator.mjs';
import {createEngine} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {applyDelta,baseDraftHash,DELTA_VERSION} from './delta.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const timing='fantasy-spans-v1';
const source={key:'fantasy-time',sourceRows:[{id:'r',kind:'action',text:'甲抬手。'}],contextRows:[],dialogue:[],entryFacts:[]};
const settings={maxUnitSeconds:30,maxUnits:null,fantasyMode:'all'};
const plan={fantasyCandidates:[{id:'f',anchorRefs:['r']}]},selection={selectedIds:['f']};
function fixture(){
 return {schemaVersion:'performance-core-v4',units:[{id:'u',title:'主动占场',scene:'日 内 大厅',props:[],participants:['甲'],lighting:'现场顶光',initialState:'甲抬眼',exitState:'甲落脚站稳',intent:{subject:'甲',change:'取得底气',landing:'主动占场',retain:['原动作']},shots:[3,23,4].map((duration,i)=>({id:'s'+(i+1),duration,camera:'按同一动作接力',picture:'甲的主观Q形象主动前跨。',lighting:'顶光随身体变化',sound:'现场底声延续',dialogueParts:[],transition:'接同一次前跨',sourceRefs:['r']}))}],fantasyRealization:[{candidateId:'f',unitIds:['u'],screenSpans:[{shotId:'s1',range:null},{shotId:'s2',range:null},{shotId:'s3',range:[0,3.8]}],entry:'抬眼时Q化',exit:'最后镜3.8秒回接真人落脚',domain:'主观',preservedFunction:'主动取得观看位置',status:'realized'}]};
}
const normalize=raw=>normalizeDraft(raw,source,{fantasyTimingVersion:timing});
const check=draft=>validateDraft({draft,source,settings,plan,selection});

test('actual shot ranges derive 29.8 seconds without asking AI to calculate a redundant total',()=>{
 const raw=fixture(),saved=structuredClone(raw),{draft,changes}=normalize(raw);
 assert.equal(draft.fantasyRealization[0].screenSeconds,29.8);
 assert.deepEqual(draft.fantasyRealization[0].shotIds,['s1','s2','s3']);
 assert.equal(draft.fantasyRealization[0].timingVersion,timing);
 assert.deepEqual(check(draft).errors,[]);
 assert.ok(changes.some(c=>c.field==='screenSeconds'&&c.action==='derive'));
 assert.deepEqual(raw,saved);
 assert.deepEqual(draft.units,saved.units);
 assert.deepEqual(normalize(draft).draft,draft);
 assert.deepEqual(normalize(draft).changes,[]);
});

test('an obsolete 30.5 aggregate is replaced from proven spans, not clamped to 30',()=>{
 const raw=fixture();raw.fantasyRealization[0].screenSeconds=30.5;raw.fantasyRealization[0].shotIds=['s1','s2','s3'];
 const {draft,changes}=normalize(raw);
 assert.equal(draft.fantasyRealization[0].screenSeconds,29.8);
 assert.ok(!check(draft).errors.some(e=>e.code==='FANTASY_DURATION'));
 assert.ok(changes.some(c=>c.from===30.5&&c.to===29.8));
});

test('invalid, unknown, duplicate, unordered or out-of-scope spans remain real problems',()=>{
 for(const mutate of [f=>f.screenSpans[2].range=[0,4.5],f=>f.screenSpans[2].range=[3,2],f=>f.screenSpans[2].range=[-1,2],f=>f.screenSpans[2].range=[0,0],f=>f.screenSpans[2].shotId='unknown',f=>f.screenSpans[2].shotId='s1',f=>f.screenSpans.reverse(),f=>f.unitIds=['other'],f=>f.screenSpans[2]=null,f=>f.screenSpans={}]){
  const raw=fixture();mutate(raw.fantasyRealization[0]);const {draft,changes}=normalize(raw);
  assert.ok(check(draft).errors.some(e=>e.code==='FANTASY_SPAN'));
  assert.ok(!changes.some(c=>c.field==='screenSeconds'));
  assert.equal(draft.fantasyRealization[0].screenSeconds,undefined);
  assert.deepEqual(draft.units,raw.units);
 }
});

test('floating arithmetic is stable; full-shot references do not duplicate shot duration',()=>{
 const raw=fixture();raw.units[0].shots.forEach((s,i)=>s.duration=[0.1,0.2,0.3][i]);raw.fantasyRealization[0].screenSpans.forEach(s=>s.range=null);
 assert.equal(normalize(raw).draft.fantasyRealization[0].screenSeconds,0.6);
});

test('two real fantasy intervals in one continuous shot preserve the intervening reality',()=>{
 const raw=fixture();raw.fantasyRealization[0].screenSpans.splice(0,1,{shotId:'s1',range:[0,1]},{shotId:'s1',range:[2,2.5]});
 const {draft}=normalize(raw);assert.equal(draft.fantasyRealization[0].screenSeconds,28.3);
 assert.deepEqual(draft.fantasyRealization[0].shotIds,['s1','s2','s3']);
 assert.deepEqual(draft.units,raw.units);assert.deepEqual(check(draft).errors,[]);
 for(const ranges of [[[0,2],[1.5,2.5]],[[2,2.5],[0,1]],[null,[2,2.5]]]){
  const invalid=fixture();invalid.fantasyRealization[0].screenSpans.splice(0,1,...ranges.map(range=>({shotId:'s1',range})));
  const result=normalize(invalid).draft;assert.equal(result.fantasyRealization[0].screenSeconds,undefined);
  assert.ok(check(result).errors.some(e=>e.code==='FANTASY_SPAN'));
 }
});

test('legacy numeric records and snapshots keep their original acceptance behavior',()=>{
 const raw=fixture(),f=raw.fantasyRealization[0];delete f.screenSpans;f.shotIds=['s1','s2','s3'];f.screenSeconds=29.8;
 assert.deepEqual(normalizeDraft(raw,source).draft,raw);
 assert.deepEqual(normalize(raw).draft,raw);
 assert.deepEqual(check(raw).errors,[]);
 const noVersion=fixture();assert.deepEqual(normalizeDraft(noVersion,source).draft,noVersion);
});

test('new schemas ask for ranges only; frozen schemas still ask for the old numeric record',()=>{
 const args={stage:'author',source,settings,selection,plan,outputSchemaVersion:'structured-v2'},newSchema=buildOutputSchema({...args,fantasyTimingVersion:timing}),oldSchema=buildOutputSchema(args);
 const fresh=newSchema.properties.fantasyRealization.items.properties,old=oldSchema.properties.fantasyRealization.items.properties;
 assert.ok(fresh.screenSpans);
 assert.equal(fresh.screenSeconds,undefined);assert.equal(fresh.shotIds,undefined);
 assert.ok(old.screenSeconds);assert.ok(old.shotIds);assert.equal(old.screenSpans,undefined);
 const delta=buildOutputSchema({...args,stage:'finish',finishMode:'delta',previousDraft:fixture(),baseDraftHash:'base',fantasyTimingVersion:timing});
 assert.ok(delta.properties.replacements.items.properties.fantasyRealization.items.properties.screenSpans);
});

test('only new frozen requests enable span derivation; the hint and schema agree',()=>{
 const src=normalizeSource(source),emotionContract={subject:'甲',contextTone:'痛快',audienceEffect:'取得底气',change:'主动前跨',landing:'站稳',retain:['原动作']};
 const p={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'取得底气',entryFacts:[],events:[{id:'e',sourceRefs:['r'],sceneKey:'大厅',boundaryBefore:{kind:'episode_start',reason:'源范围开头'},emotionContract}],workPackages:[{id:'p',eventId:'e',sourceRefs:['r'],emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'pu',packageId:'p',sourceRefs:['r'],secondsRange:[25,30]}],fantasyCandidates:[{id:'f',anchorRefs:['r'],subject:'甲',emotionPurpose:'取得主动',recommended:true,proposal:'主观前跨',screenSecondsRange:[20,30],extraSecondsRange:[0,0]}]},rules=captureRules();
 assert.equal(rules.fantasyTimingVersion,timing);
 const request=buildRequest({stage:'author',source:src,plan:p,packageId:'p',settings,rulesSnapshot:rules});
 assert.match(request.prompt,/screenSpans/);assert.ok(request.schema.properties.fantasyRealization.items.properties.screenSpans);
 const old={...rules};delete old.fantasyTimingVersion;
 const legacy=buildRequest({stage:'author',source:src,plan:p,packageId:'p',settings,rulesSnapshot:old});
 assert.equal(legacy.schema.properties.fantasyRealization.items.properties.screenSpans,undefined);
 assert.throws(()=>buildRequest({stage:'author',source:src,plan:p,packageId:'p',settings,rulesSnapshot:{...rules,fantasyTimingVersion:'unknown'}}),e=>e.code==='RULE_SNAPSHOT');
});

function eventPlan(){
 const emotionContract={subject:'甲',contextTone:'痛快',audienceEffect:'取得底气',change:'主动前跨',landing:'站稳',retain:['原动作']};
 return {schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'取得底气',entryFacts:[],events:[{id:'e',sourceRefs:['r'],sceneKey:'大厅',boundaryBefore:{kind:'episode_start',reason:'源开头'},emotionContract}],workPackages:[{id:'p',eventId:'e',sourceRefs:['r'],emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'pu',packageId:'p',sourceRefs:['r'],secondsRange:[25,30]}],fantasyCandidates:[{id:'f',anchorRefs:['r'],subject:'甲',emotionPurpose:'取得主动',recommended:true,proposal:'主观前跨',screenSecondsRange:[20,30],extraSecondsRange:[0,0]}]};
}

test('the fresh continuous coordinator derives timing and finishes in exactly three mock calls',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'v4-fantasy-timing-')),calls=[];
 const raw=fixture();Object.assign(raw.units[0],{eventId:'e',boundaryBefore:{kind:'episode_start',reason:'源开头'},unitDirection:'三拍主动占场，保留30秒主观发展',visualSubjects:[{name:'甲的Q版形象',domain:'subjective'}]});
 const coordinator=createCoordinator({dataRoot:directory,modelRunner:async (request,options)=>{
  calls.push(request);
  const current=await coordinator.read(options.runId);
  const output=request.stage==='plan'?eventPlan():request.finishMode==='delta'?{schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:current.adopted.flatMap(a=>a.draft.units.map(u=>u.id)),replacements:[],revisionNotes:[],unresolved:[]}:{...structuredClone(raw),...(request.stage==='finish'?{revisionNotes:[],unresolved:[]}:{})};
  return {output,raw:JSON.stringify(output),usage:{totalTokens:100},requestOutcome:'RESPONDED'};
 }});
 t.after(async()=>{await coordinator.shutdown();await rm(directory,{recursive:true,force:true});});
 const created=await coordinator.create({source,settings,binding:{projectId:'mock-p',episodeId:'mock-e',sourceVersion:'mock-v1'}});
 await coordinator.start(created.id);const done=await coordinator.wait(created.id);
 assert.equal(done.status,'text_ready_for_review',JSON.stringify({web:done.web.error,candidates:done.candidates.map(c=>({stage:c.stage,status:c.status,errors:c.errors})),calls:calls.map(c=>c.stage)}));assert.deepEqual(done.assembly.validation.errors,[]);
 assert.deepEqual(calls.map(r=>r.stage),['plan','author','finish']);
 assert.equal(done.web.autoRepairs,0);
 assert.equal(done.assembly.draft.fantasyRealization[0].screenSeconds,29.8);
 assert.deepEqual(done.assembly.draft.units[0].shots,raw.units[0].shots);
 const author=done.candidates.find(c=>c.stage==='author');
 assert.equal(author.output.fantasyRealization[0].screenSeconds,undefined,'raw provider reply is immutable');
 assert.ok(author.normalizations.some(n=>n.field==='screenSeconds'&&n.reason==='verified_shot_ranges'));
 assert.match(done.assembly.text,/\[主观视觉主体\] 甲的Q版形象/);
 await coordinator.start(created.id);await coordinator.wait(created.id);assert.equal(calls.length,3,'opening a completed task does not dispatch again');
});

test('a delta retains a legacy numeric fantasy and only derives the replaced new group',()=>{
 const old=fixture();delete old.fantasyRealization[0].screenSpans;Object.assign(old.fantasyRealization[0],{shotIds:['s1','s2','s3'],screenSeconds:29.8});
 const next=structuredClone(old.units[0]);next.id='next';next.shots.forEach((s,i)=>s.id='next-'+i);old.units.push(next);
 const replacement=structuredClone(next);replacement.shots[0].picture+=' 取得新的观看重音。';
 const delta={schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(old),retainedUnitIds:['u'],replacements:[{replaces:['next'],units:[replacement],fantasyRealization:[{candidateId:'other',unitIds:['next'],screenSpans:replacement.shots.map(s=>({shotId:s.id,range:null})),entry:'同一次前跨进入',exit:'落脚回现实',domain:'主观',preservedFunction:'取得底气',status:'realized'}]}],revisionNotes:[],unresolved:[]};
 const result=normalize(applyDelta(old,delta)).draft;
 assert.deepEqual(result.units[0],old.units[0]);assert.deepEqual(result.fantasyRealization[0],old.fantasyRealization[0]);
 assert.equal(result.fantasyRealization[1].screenSeconds,30);
 assert.deepEqual(result.units[1],replacement);
});

test('an old planned task cannot silently refresh into a different timing or manifest protocol',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'v4-frozen-protocol-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const engine=createEngine({directory,modelRunner:async()=>({output:eventPlan(),raw:JSON.stringify(eventPlan()),requestOutcome:'RESPONDED'})});
 await engine.create({id:'old',source,settings});
 await createStore(directory).update('old',d=>{delete d.rulesSnapshot.fantasyTimingVersion;delete d.rulesSnapshot.visualSubjectsVersion;return d;});
 await engine.execute('old',{stage:'plan',attemptId:'old-plan'});
 const before=await engine.read('old');
 await assert.rejects(()=>engine.refreshRules('old'),e=>e.code==='RULES_PROTOCOL_CHANGE');
 assert.deepEqual(await engine.read('old'),before);
});
