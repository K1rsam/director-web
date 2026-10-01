import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules} from './core.mjs';
import {parseScript} from './source.mjs';
import {PLAN_VERSION} from './shared.mjs';

const source=()=>parseScript('第一集\n\n1-1 日 内 房间\n甲：别走\n\n！\n▲甲伸手。',{key:'projection',contextRows:[{id:'prior-empty',text:'　',kind:'context'},{id:'prior-action',text:'△甲已放下杯子。',kind:'context'}]});
const request=(rules=captureRules())=>buildRequest({stage:'plan',source:source(),settings:{maxUnits:null,fantasyMode:'recommended'},rulesSnapshot:rules});
const modelInput=r=>JSON.parse(r.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以')[0]);

test('new model projection omits only blank rows and schema refs while keeping full stored source',()=>{
 const s=source(),before=structuredClone(s),r=buildRequest({stage:'plan',source:s,settings:{maxUnits:null},rulesSnapshot:captureRules()}),input=modelInput(r);
 assert.equal(captureRules().sourceProjection,'nonblank-v1');
 assert.ok(input.source.sourceRows.every(row=>row.text.trim()));
 assert.deepEqual(input.source.contextRows.map(row=>row.id),['prior-action']);
 assert.ok(!JSON.stringify(r.schema).includes('prior-empty'));
 for(const id of ['projection:L0002','projection:L0005'])assert.ok(!JSON.stringify(r.schema).includes(id));
 assert.ok(input.source.sourceRows.some(row=>row.text==='！'));
 assert.ok(input.source.sourceRows.some(row=>row.kind==='metadata'&&row.text.includes('房间')));
 assert.equal(input.source.dialogue[0].quote,'别走！');
 assert.deepEqual(r.source.sourceRows,s.sourceRows);
 assert.deepEqual(s,before);
});

test('saved pre-projection rule snapshots retain blank rows and their original output enums',()=>{
 const rules=captureRules();delete rules.sourceProjection;
 const r=request(rules),input=modelInput(r);
 assert.deepEqual(input.source.sourceRows.map(row=>row.id),source().sourceRows.map(row=>row.id));
 assert.deepEqual(input.source.contextRows.map(row=>row.id),['prior-empty','prior-action']);
 assert.ok(JSON.stringify(r.schema).includes('projection:L0002'));
 assert.ok(JSON.stringify(r.schema).includes('prior-empty'));
 assert.notEqual(r.inputHash,request().inputHash);
});

test('unknown projection versions cannot silently reinterpret a saved request',()=>{
 const rules=captureRules();rules.sourceProjection='unexpected';
 assert.throws(()=>request(rules),error=>error.code==='RULE_SNAPSHOT');
});

test('authors and finishers preserve owned source IDs and quotes while projecting away blank layout rows',()=>{
 const s=source(),refs=s.sourceRows.map(r=>r.id),rules=captureRules();
 rules.outputSchemaVersion='structured-v1';delete rules.unitPackingPolicy;delete rules.creativeRevision;
 const plan={schemaVersion:PLAN_VERSION,emotionArc:'挽留转为行动',entryFacts:[],workPackages:[{id:'p1',sourceRefs:refs,contextRefs:['prior-empty','prior-action'],emotionContract:{subject:'甲',contextTone:'急切',audienceEffect:'关心是否留下',change:'从呼喊到伸手',landing:'伸手挽留',retain:['原话与动作']},entryFactIds:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'u1',packageId:'p1',sourceRefs:refs,secondsRange:[3,8]}],fantasyCandidates:[]};
 for(const stage of ['author','finish']){
  const r=buildRequest({stage,source:s,plan,packageIds:['p1'],settings:{maxUnits:null,fantasyMode:'off'},rulesSnapshot:rules,...(stage==='finish'?{previousDraft:{units:[{id:'u1'}]}}:{})});
  const input=modelInput(r);
  assert.deepEqual(input.source.sourceRows.map(row=>row.id),s.sourceRows.filter(row=>row.text.trim()).map(row=>row.id));
  assert.deepEqual(input.source.dialogue.map(d=>[d.id,d.quote]),s.dialogue.map(d=>[d.id,d.quote]));
  assert.ok(!JSON.stringify(r.schema).includes('prior-empty'));
  assert.equal(r.source.sourceRows.length,s.sourceRows.length);
  assert.deepEqual(r.plan.workPackages[0].sourceRefs,refs);
 }
});
