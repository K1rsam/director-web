import test from 'node:test';
import assert from 'node:assert/strict';
import {buildOutputSchema} from './output-schema.mjs';
import {normalizeDraft,validateDraft,renderDraft} from './quality.mjs';
import {captureRules,buildRequest} from './core.mjs';
import {normalizeSource} from './source.mjs';
import {VERSION,PLAN_VERSION} from './shared.mjs';

const version='visual-subjects-v1';
const source={key:'subjects',sourceRows:[{id:'r',kind:'action',text:'甲在门前看向未来的兽形。'}],contextRows:[],dialogue:[],entryFacts:[]};
const intent={subject:'甲',change:'取得底气',landing:'主动占场',retain:['未来图示仍不是真实觉醒']};
const emotionContract={...intent,contextTone:'痛快',audienceEffect:'反差期待'};
const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'反差期待',entryFacts:[],events:[{id:'e',sourceRefs:['r'],sceneKey:'门前',boundaryBefore:{kind:'episode_start',reason:'源开头'},emotionContract}],workPackages:[{id:'p',eventId:'e',sourceRefs:['r'],emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'pu',packageId:'p',sourceRefs:['r'],secondsRange:[20,30]}],fantasyCandidates:[]};
function fixture(){
 return {schemaVersion:VERSION,units:[{id:'p-u',eventId:'e',boundaryBefore:{kind:'episode_start',reason:'源开头'},title:'看向未来',unitDirection:'未来兽形只在主观图示出现',scene:'日 外 门前',props:[],participants:['甲'],visualSubjects:[{name:'未来兽形',domain:'prospective'}],intent,lighting:'日光',initialState:'甲抬眼',exitState:'甲眼神落定',shots:[{id:'p-s',duration:12,camera:'近眼接主观图示',picture:'未来兽形在主观图示中展开，回到甲的眼睛。',lighting:'图示冷光接日光',sound:'现场底声保持',dialogueParts:[],transition:'同一次抬眼',sourceRefs:['r'],contextRefs:[]}]}],fantasyRealization:[]};
}
const settings={maxUnitSeconds:30,maxUnits:null,fantasyMode:'off'};

test('only new schemas require the independent visual-subject manifest',()=>{
 const args={stage:'author',source,settings,selection:{selectedIds:[]},plan,outputSchemaVersion:'structured-v2'};
 const fresh=buildOutputSchema({...args,visualSubjectsVersion:version}).properties.units.items;
 assert.ok(fresh.required.includes('visualSubjects'));
 assert.deepEqual(fresh.properties.visualSubjects.items.properties.domain.enum,['subjective','prospective']);
 assert.equal(buildOutputSchema(args).properties.units.items.properties.visualSubjects,undefined);
 const rules=captureRules();assert.equal(rules.visualSubjectsVersion,version);
 const request=buildRequest({stage:'author',source:normalizeSource(source),settings,plan,packageId:'p',rulesSnapshot:rules});
 assert.match(request.prompt,/visualSubjects/);
 assert.throws(()=>buildRequest({stage:'author',source,settings,plan,packageId:'p',rulesSnapshot:{...rules,visualSubjectsVersion:'unknown'}}),e=>e.code==='RULE_SNAPSHOT');
});

test('export distinguishes actual participants from future and subjective visual subjects',()=>{
 const draft=fixture();draft.units[0].visualSubjects.push({name:'甲的Q版形象',domain:'subjective'});
 const text=renderDraft({draft,source,settings,seedanceExportVersion:'seedance-execution-v3'});
 assert.match(text,/\[本单元出场人物\] 甲\n/);
 assert.match(text,/\[主观视觉主体\] 甲的Q版形象/);
 assert.match(text,/\[未来图示主体\] 未来兽形/);
 assert.equal(validateDraft({draft,source,settings,plan,selection:{selectedIds:[]}}).errors.length,0);
 const legacy=fixture();delete legacy.units[0].visualSubjects;
 const oldText=renderDraft({draft:legacy,source,settings,seedanceExportVersion:'seedance-execution-v3'});
 assert.doesNotMatch(oldText,/视觉主体|图示主体/);
 assert.equal(text.replace('[主观视觉主体] 甲的Q版形象\n','').replace('[未来图示主体] 未来兽形\n',''),oldText);
});

test('packing preserves both manifests without changing shots or factual participants',()=>{
 const draft=fixture(),next=structuredClone(draft.units[0]);
 next.id='p-u2';next.shots[0].id='p-s2';next.boundaryBefore={kind:'continuous',reason:'同一事件接续'};
 next.visualSubjects=[{name:'未来兽形',domain:'prospective'},{name:'甲的Q版形象',domain:'subjective'}];
 draft.units.push(next);const saved=structuredClone(draft);
 const packed=normalizeDraft(draft,source,{stage:'finish',settings,plan,unitPackingPolicy:'event-first-v1'}).draft;
 assert.equal(packed.units.length,1);
 assert.deepEqual(packed.units[0].visualSubjects,next.visualSubjects);
 assert.deepEqual(packed.units[0].participants,['甲']);
 assert.deepEqual(packed.units[0].shots,saved.units.flatMap(u=>u.shots));
 assert.deepEqual(draft,saved);
 assert.equal(validateDraft({draft:packed,source,settings,plan,selection:{selectedIds:[]}}).errors.length,0);
});

test('bad manifests are neither guessed nor discarded during packing',()=>{
 for(const value of [null,{},['未来兽形'],[{name:'',domain:'prospective'}],[{name:'未来兽形',domain:'real'}],[{name:'兽形',domain:'subjective',unknownEvidence:'不能丢'}],[{name:'兽形',domain:'subjective'},{name:'兽形',domain:'subjective'}]]){
  const draft=fixture(),next=structuredClone(draft.units[0]);next.id='p-u2';next.shots[0].id='p-s2';next.boundaryBefore={kind:'continuous',reason:'同一事件'};next.visualSubjects=value;draft.units.push(next);
  const result=normalizeDraft(draft,source,{stage:'finish',settings,plan,unitPackingPolicy:'event-first-v1'}).draft;
  assert.equal(result.units.length,2);
  assert.deepEqual(result.units[1].visualSubjects,value);
  assert.ok(validateDraft({draft:result,source,settings,plan,selection:{selectedIds:[]}}).errors.some(e=>e.code==='VISUAL_SUBJECTS'));
 }
});
