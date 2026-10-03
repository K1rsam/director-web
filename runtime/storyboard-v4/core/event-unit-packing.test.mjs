import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizePlan,buildRequest,captureRules} from './core.mjs';
import {normalizeDraft,validateDraft,renderDraft} from './quality.mjs';
import {normalizeSource} from './source.mjs';
import {VERSION,PLAN_VERSION,digest} from './shared.mjs';
import {createEngine} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const policy='event-first-v1';
const emotion=(subject,landing)=>({subject,contextTone:'险境转身份反差',audienceEffect:'看见完整救援及认知翻转',change:'濒死获救后认出救命者',landing,retain:['真实救援','完整原话']});
function fixture(){
 const source=normalizeSource({key:'rescue',sourceRows:[{id:'s1',text:'△甲一击烧掉咬向乙的狼。'},{id:'s2',text:'乙：是你！'}]});
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:policy,emotionArc:'救援到认人',entryFacts:[],events:[{id:'e1',sourceRefs:['s1','s2'],sceneKey:'防线-日外',boundaryBefore:{kind:'episode_start',reason:'本集延续同一次救援'},emotionContract:emotion('乙与甲','认出救命者，旧判断崩塌')}],workPackages:[{id:'p1',eventId:'e1',sourceRefs:['s1'],emotionContract:emotion('乙','威胁解除'),entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]},{id:'p2',eventId:'e1',sourceRefs:['s2'],emotionContract:emotion('乙与甲','认出救命者'),entryFactIds:[],contextRefs:[],dependsOn:['p1'],scenarioKeys:[]}],provisionalUnits:[{id:'pu1',packageId:'p1',sourceRefs:['s1'],secondsRange:[8,12]},{id:'pu2',packageId:'p2',sourceRefs:['s2'],secondsRange:[10,15]}],fantasyCandidates:[]};
 const unit=(id,ref,duration,initialState,exitState)=>({id,eventId:'e1',boundaryBefore:{kind:id==='u1'?'episode_start':'continuous',reason:id==='u1'?'事件入口':'接同一次救援的认人反应'},title:id,unitDirection:id==='u1'?'乙缩肩闭眼，冲击后慢慢松开呼吸，以金火回落承接睁眼。':'乙的目光先认出脸，再带动肩背抬起；给认人反应留下停顿。',intent:{subject:'乙',change:'恐惧转认出',landing:exitState,retain:['完整救援']},scene:'日 外 防线',props:id==='u1'?['飞剑']:['飞剑','废墟'],participants:id==='u1'?['甲','乙','狼']:['甲','乙','丙'],lighting:id==='u1'?'天光，金火爆发后收束':'天光，身周金火持续，废墟反光',initialState,exitState,shots:[{id:id+'-s1',duration,camera:'侧向中景',picture:id==='u1'?'甲击溃狼，挡在乙前。':'乙看清甲的脸。',lighting:'承接本段光位',sound:'现场声',dialogueParts:id==='u1'?[]:[{lineId:'s2:D1',text:'是你！',presentation:'画内',delivery:'惊愕认出',voiceStart:1,voiceEnd:2}],transition:id==='u1'?'承接睁眼，切入下一单元。':'保持目光结束。',sourceRefs:[ref],contextRefs:[]}]});
 const draft={schemaVersion:VERSION,units:[unit('u1','s1',9.9,'狼正咬向乙','狼消失，乙正在睁眼'),unit('u2','s2',13.6,'狼已消失，乙正在睁眼','乙认出甲，丙在远处目击')],fantasyRealization:[{candidateId:'f1',unitIds:['u1','u2'],shotIds:['u1-s1','u2-s1'],screenSeconds:2,entry:'恐惧暗形入画',exit:'随认出消退',domain:'主观',preservedFunction:'恐惧转认知翻转',status:'realized'}]};
 return {source,plan,draft,settings:{maxUnits:null,maxUnitSeconds:30,fantasyMode:'off'}};
}
const normalize=f=>normalizeDraft(f.draft,f.source,{plan:f.plan,settings:f.settings,unitPackingPolicy:policy});

test('same complete event is assigned to one author while source-anchored beat contracts survive',()=>{
 const f=fixture(),original=structuredClone(f.plan),p=normalizePlan(f.plan,f.source);
 assert.equal(p.workPackages.length,1);
 assert.deepEqual(p.workPackages[0].sourceRefs,['s1','s2']);
 assert.deepEqual(p.provisionalUnits.map(u=>u.packageId),['p1','p1']);
 assert.deepEqual(p.workPackages[0].dependsOn,[]);
 assert.deepEqual(p.workPackages[0].beatContracts.map(b=>[b.sourceRefs,b.emotionContract.landing]),[[['s1'],'威胁解除'],[['s2'],'认出救命者']]);
 assert.equal(p.workPackages[0].emotionContract.landing,'认出救命者，旧判断崩塌');
 assert.deepEqual(normalizePlan(p,f.source),p);assert.deepEqual(f.plan,original);
});

test('23.5 seconds of one continuous event becomes one unit without changing any shot or speech',()=>{
 const f=fixture(),before=structuredClone(f.draft),{draft,changes}=normalize(f);
 assert.equal(draft.units.length,1);
 const expectedShots=before.units.flatMap(u=>structuredClone(u.shots));expectedShots[0].transition='承接睁眼，切入下一段。';
 assert.deepEqual(draft.units[0].shots,expectedShots);
 assert.ok(changes.some(c=>c.reason==='merged_internal_boundary'&&c.from==='承接睁眼，切入下一单元。'&&c.to==='承接睁眼，切入下一段。'));
 assert.equal(draft.units[0].shots.reduce((n,s)=>n+s.duration,0),23.5);
 assert.ok(draft.units[0].initialState.startsWith(before.units[0].initialState));assert.equal(draft.units[0].exitState,before.units[1].exitState);
 assert.match(draft.units[0].lighting,/u2-s1.*身周金火持续/);assert.match(draft.units[0].initialState,/u2-s1.*狼已消失，乙正在睁眼/);
 assert.deepEqual(draft.units[0].participants,['甲','乙','狼','丙']);assert.deepEqual(draft.units[0].props,['飞剑','废墟']);
 assert.deepEqual(draft.units[0].segments.map(s=>s.lighting),before.units.map(u=>u.lighting));
 assert.deepEqual(draft.fantasyRealization[0].unitIds,['u1']);assert.deepEqual(draft.fantasyRealization[0].shotIds,['u1-s1','u2-s1']);
 assert.ok(changes.some(c=>c.action==='merge'&&c.reason==='continuous_event_within_capacity'));
 const rendered=renderDraft({draft,source:f.source,settings:f.settings});
 assert.match(rendered,/身周金火持续，废墟反光/);assert.match(rendered,/狼已消失，乙正在睁眼/);
 assert.ok(rendered.indexOf('身周金火持续，废墟反光')<rendered.indexOf('分镜2｜'));
 assert.deepEqual(f.draft,before);assert.deepEqual(normalizeDraft(draft,f.source,{plan:f.plan,settings:f.settings,unitPackingPolicy:policy}).draft,draft);
 const withoutTrace=structuredClone(draft);delete withoutTrace.units[0].segments;
 const laterFull=renderDraft({draft:withoutTrace,source:f.source,settings:f.settings});assert.match(laterFull,/身周金火持续，废墟反光/);assert.match(laterFull,/分镜2.*狼已消失，乙正在睁眼/);assert.ok(!laterFull.includes('u2-s1'));
});

test('31.3 seconds, a 15-second setting, scene changes and hard event boundaries retain needed units',()=>{
 for(const [reason,mutate] of [
  ['capacity_exceeded',f=>{f.draft.units[0].shots[0].duration=12.4;f.draft.units[1].shots[0].duration=18.9;}],
  ['capacity_exceeded',f=>{f.settings.maxUnitSeconds=15;}],
  ['scene_changed_or_unconfirmed',f=>{f.draft.units[1].scene='夜 内 仓库';}],
  ['explicit_boundary',f=>{f.draft.units[1].boundaryBefore={kind:'time_space_jump',reason:'次日回到仓库'};}],
  ['different_event',f=>{f.plan.events.push({...structuredClone(f.plan.events[0]),id:'e2',sourceRefs:['s2'],boundaryBefore:{kind:'new_event',reason:'救援已落定，另起审问'}});f.plan.events[0].sourceRefs=['s1'];f.draft.units[1].eventId='e2';}]
 ]){const f=fixture();mutate(f);const before=structuredClone(f.draft),result=normalize(f);assert.deepEqual(result.draft,before,reason);assert.ok(result.changes.some(c=>c.action==='retain'&&c.reason===reason),reason);}
});

test('legacy drafts and snapshots never opt into event packing merely because the code is newer',()=>{
 const f=fixture();assert.deepEqual(normalizeDraft(f.draft,f.source).draft,f.draft);
 assert.deepEqual(normalizeDraft(f.draft,f.source,{plan:f.plan,settings:f.settings}).draft,f.draft);
 const old=structuredClone(f.plan);delete old.unitPackingPolicy;delete old.events;for(const w of old.workPackages)delete w.eventId;
 assert.equal(normalizePlan(old,f.source).workPackages.length,2);
 assert.throws(()=>normalizePlan(old,f.source,{unitPackingPolicy:policy}),e=>e.code==='PLAN_EVENT_POLICY');
 const missing=structuredClone(f.draft);delete missing.units[0].eventId;
 assert.throws(()=>normalizeDraft(missing,f.source,{plan:f.plan,settings:f.settings,unitPackingPolicy:policy}),e=>e.code==='DRAFT_EVENT_METADATA');
 assert.throws(()=>buildRequest({stage:'author',plan:old,source:f.source,packageId:'p1',settings:f.settings}),e=>e.code==='PLAN_EVENT_POLICY');
});

test('merged lighting returns to an earlier setup at the correct later shot boundary',()=>{
 const f=fixture();f.draft.units[0].shots[0].duration=5;f.draft.units[1].shots[0].duration=5;
 const third=structuredClone(f.draft.units[0]);third.id='u3';third.shots[0].id='u3-s1';third.shots[0].sourceRefs=['s2'];third.boundaryBefore={kind:'continuous',reason:'同一认人反应的余势'};third.initialState='乙已认出甲';third.exitState='甲转身确认安全';f.draft.units.push(third);
 const {draft}=normalize(f);assert.equal(draft.units.length,1);
 const rendered=renderDraft({draft,source:f.source,settings:f.settings});
 assert.match(rendered,/光影承接｜分镜3—3\] 天光，金火爆发后收束/);
});

test('event ownership cannot silently authorize source rows from another event',()=>{
 const f=fixture();f.draft.fantasyRealization=[];f.plan.events[0].sourceRefs=['s1'];
 const result=validateDraft({draft:f.draft,source:f.source,settings:f.settings,selection:{selectedIds:[]},plan:f.plan});
 assert.ok(result.errors.some(e=>e.code==='EVENT_SOURCE'&&e.coordinate==='u2-s1'));
});

test('explicit continuous event fragments share one author and retain both emotional functions',()=>{
 const f=fixture(),first=f.plan.events[0];first.sourceRefs=['s1'];first.emotionContract=emotion('乙','威胁解除');
 f.plan.events.push({...structuredClone(first),id:'e2',sourceRefs:['s2'],boundaryBefore:{kind:'continuous',reason:'同场立刻认出救命者'},emotionContract:emotion('甲与乙','旧判断崩塌')});f.plan.workPackages[1].eventId='e2';
 const p=normalizePlan(f.plan,f.source);assert.equal(p.workPackages.length,1);assert.equal(p.events.length,1);assert.equal(p.events[0].eventSegments.length,2);
 assert.match(p.workPackages[0].emotionContract.landing,/威胁解除.*旧判断崩塌/);assert.deepEqual(normalizePlan(p,f.source),p);
});

test('event source partitions reject gaps, overlaps and a claimed continuous scene jump',()=>{
 for(const mutate of [f=>f.plan.events[0].sourceRefs=['s1'],f=>f.plan.events.push({...structuredClone(f.plan.events[0]),id:'e2',boundaryBefore:{kind:'new_event',reason:'另起事件'}}),f=>{f.plan.events[0].sourceRefs=['s1'];f.plan.events.push({...structuredClone(f.plan.events[0]),id:'e2',sourceRefs:['s2'],sceneKey:'仓库',boundaryBefore:{kind:'continuous',reason:'转到另一场景'}});}]){const f=fixture();mutate(f);assert.throws(()=>normalizePlan(f.plan,f.source),e=>e.code.startsWith('PLAN_EVENT'));}
});

test('new request schema requires event ownership and boundaries while frozen structured-v1 remains unchanged',()=>{
 const f=fixture(),rules=captureRules(),current=buildRequest({stage:'plan',source:f.source,settings:f.settings,rulesSnapshot:rules});
 assert.equal(rules.outputSchemaVersion,'structured-v2');assert.equal(rules.unitPackingPolicy,policy);
 assert.ok(current.schema.properties.events);assert.deepEqual(current.schema.properties.unitPackingPolicy.enum,[policy]);
 const legacy={...rules,outputSchemaVersion:'structured-v1'};delete legacy.unitPackingPolicy;delete legacy.unitDirectionVersion;
 const old=buildRequest({stage:'plan',source:f.source,settings:f.settings,rulesSnapshot:legacy});
 assert.equal(old.schema.properties.events,undefined);assert.equal(old.schema.properties.unitPackingPolicy,undefined);
 const author=buildRequest({stage:'author',source:f.source,plan:f.plan,packageId:'p1',settings:f.settings,rulesSnapshot:rules});
 assert.deepEqual(author.schema.properties.units.items.properties.eventId.enum,['e1']);
 assert.ok(author.schema.properties.units.items.properties.boundaryBefore);
 assert.equal(author.plan.workPackages.length,1);assert.equal(author.plan.events.length,1);
 assert.notEqual(current.schemaHash,digest(old.schema));
});

test('fresh v2 engine carries the complete event through plan, author, finish and a 23.5-second one-unit assembly',async t=>{
 const f=fixture();f.draft.fantasyRealization=[];
 const directory=await mkdtemp(path.join(tmpdir(),'v4-event-flow-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const requests=[],engine=createEngine({directory,modelRunner:async request=>{
  requests.push(request);
  const output=request.stage==='plan'?f.plan:{...structuredClone(f.draft),...(request.stage==='finish'?{revisionNotes:[],unresolved:[]}:{})};
  return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};
 }});
 const created=await engine.create({id:'event-flow',source:f.source,settings:f.settings});assert.equal(created.rulesSnapshot.outputSchemaVersion,'structured-v2');
 let d=await engine.execute('event-flow',{stage:'plan',attemptId:'plan'});assert.equal(d.plan.workPackages.length,1);assert.equal(d.candidates.at(-1).status,'adopted');
 d=await engine.execute('event-flow',{stage:'author',packageId:'p1',attemptId:'author'});assert.equal(d.adopted[0].draft.units.length,2,'automatic packing runs only after normal finishing');
 d=await engine.execute('event-flow',{stage:'finish',packageId:'p1',attemptId:'finish'});assert.ok(d.candidates.at(-1).normalizations.some(c=>c.action==='merge'));
 d=await engine.assemble('event-flow');assert.equal(d.status,'text_ready_for_review');assert.deepEqual(d.assembly.validation.errors,[]);
 assert.equal(d.assembly.draft.units.length,1);assert.equal(d.assembly.validation.stats.seconds,23.5);assert.equal(d.assembly.draft.units[0].shots[1].dialogueParts[0].text,'是你！');
 assert.deepEqual(requests.map(r=>r.stage),['plan','author','finish']);
 for(const request of requests.slice(1)){assert.equal(request.plan.unitPackingPolicy,policy);assert.equal(request.plan.workPackages.length,1);assert.deepEqual(request.schema.properties.units.items.properties.eventId.enum,['e1']);assert.equal(request.source.sourceRows.length,2);}
 assert.equal(d.candidates.find(c=>c.stage==='author').output.units.length,2,'raw model output stays intact');
 const saved=await createStore(directory).update('event-flow',doc=>{doc.rulesSnapshot.instructions+=' 同协议旧指令';return doc;});
 const refreshed=await engine.refreshRules('event-flow');assert.equal(refreshed.rulesSnapshot.outputSchemaVersion,'structured-v2');assert.equal(refreshed.rulesSnapshot.unitPackingPolicy,policy);
 assert.equal(refreshed.rulesHistory.at(-1).oldHash,digest(saved.rulesSnapshot));assert.equal(refreshed.rulesHistory.at(-1).newHash,digest(captureRules()));
 assert.deepEqual(refreshed.plan,saved.plan);assert.deepEqual(refreshed.candidates,saved.candidates);assert.deepEqual(refreshed.operations,saved.operations);assert.equal(requests.length,3,'same-protocol rules refresh makes no model call');
});

test('fresh v2 engine refuses a metadata-free plan even if the fake provider ignores the schema',async t=>{
 const f=fixture(),old=structuredClone(f.plan);delete old.unitPackingPolicy;delete old.events;for(const w of old.workPackages)delete w.eventId;
 const directory=await mkdtemp(path.join(tmpdir(),'v4-event-required-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const engine=createEngine({directory,modelRunner:async()=>({output:old,raw:JSON.stringify(old),requestOutcome:'RESPONDED'})});
 await engine.create({id:'required',source:f.source,settings:f.settings});const d=await engine.execute('required',{stage:'plan',attemptId:'plan'});
 assert.equal(d.plan,null);assert.equal(d.candidates.at(-1).status,'needs_repair');assert.equal(d.candidates.at(-1).errors[0].code,'PLAN_EVENT_POLICY');
});
