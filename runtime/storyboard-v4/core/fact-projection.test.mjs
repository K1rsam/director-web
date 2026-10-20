import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules} from './core.mjs';
import {VERSION,PLAN_VERSION} from './shared.mjs';

const projectionVersion='retrieval-facts-v1';
const frozenSettings={model:'gpt-6-sol',reasoning:'medium',visualStyle:'3D三渲二国漫横屏16:9；C4D/Octane风格精细渲染，赛璐璐光影结合PBR材质。角色身份、衣发与道具一致；人物表演的强弱与幅度服从本段情绪和策略，摄影、声光、动作共同组织，空间可读、有纵深。无额外字幕、水印、logo、BGM；源剧情必要屏幕信息保留。'};
const withoutStatement=({statement,...fact})=>fact;
function factsFixture(){
 const base={id:'current-fact',subjects:['甲'],kind:'STATE',evidence:{domain:'EPISODE',episode:2,start:0,end:7},claim:'SOURCE',applicability:'SUBJECT',validity:{status:'UNKNOWN'}};
 const bg={...base,id:'background-fact',kind:'CONTEXT',statement:'甲在渡口长大。',evidence:{domain:'CONTEXT',sectionKey:'bio',start:0,end:8}};
 return {schema:'FOUNDATION_FACTS_V1',sourceVersion:'s-v1',sourceContextVersion:'c-v1',current:[base],background:[bg],backgroundCandidates:[bg],historicalStates:[{...base,id:'history-fact',statement:'甲昨天受伤。',evidence:{domain:'EPISODE',episode:0,start:0,end:7},validity:{status:'EXPLICIT',start:0,end:1}}],unlinkedBackground:[withoutStatement(bg)],sourceFactIndex:[base],rules:'历史不自动继承。'};
}
function fixture(facts=factsFixture()){
 const source={key:'projection-test',title:'保持证据',context:{retrievalFacts:facts,directorNotes:'保留停顿'},contextRows:[{id:'c1',text:'△甲昨天受伤。'}],sourceRows:[{id:'s1',text:'甲：我还在。'},{id:'s2',text:'△甲握紧绷带。'}],entryFacts:[{id:'known',subject:'甲',statement:'甲昨天受伤',sourceRefs:['c1'],evidence:'甲昨天受伤'}]};
 const emotionContract={subject:'甲',contextTone:'克制',audienceEffect:'担心',change:'忍痛坚持',landing:'握紧绷带',retain:['原话']};
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'忍痛坚持',entryFacts:[],events:[{id:'e1',sourceRefs:['s1','s2'],sceneKey:'渡口',boundaryBefore:{kind:'episode_start',reason:'本集开始'},emotionContract}],workPackages:[{id:'p1',eventId:'e1',sourceRefs:['s1','s2'],emotionContract,entryFactIds:['known'],contextRefs:['c1'],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'u1',packageId:'p1',sourceRefs:['s1','s2'],secondsRange:[2,5]}],fantasyCandidates:[]};
 return {source,plan,packageId:'p1',settings:{...frozenSettings,maxUnits:null,fantasyMode:'off'}};
}
function request(kind='plan',facts=factsFixture(),rulesSnapshot){
 return buildRequest({...fixture(facts),stage:kind==='delta'?'finish':kind,finishMode:kind==='delta'?'delta':'full',...(kind==='finish'||kind==='delta'?{previousDraft:{schemaVersion:VERSION,units:[{id:'p1-u1',shots:[]}],fantasyRealization:[]}}:{}),rulesSnapshot:rulesSnapshot||{...captureRules(),modelProjectionVersion:projectionVersion}});
}
function modelInput(r){return JSON.parse(r.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n')[0]);}
// Independent decoder verifies that table rows plus group membership retain the full input.
function expand(table){
 const {format,columns,interpretation,rows,groups,...facts}=table;
 assert.equal(format,'STORYBOARD_FACT_TABLE_V1');
 const names=columns.slice(0,7);
 for(const [group,refs] of Object.entries(groups))facts[group]=refs.map(ref=>{
  const row=rows[Array.isArray(ref)?ref[0]:ref],fact={...Object.fromEntries(names.map((key,i)=>[key,row[i]])),...(row[8]||{})};
  if(!Array.isArray(ref)&&typeof row[7]==='string')fact.statement=row[7];
  return fact;
 });
 return facts;
}

test('retrieval-facts-v1 snapshots keep their lossless table projection without changing stored source',()=>{
 for(const stage of ['plan','author','finish','delta']){
  const facts=factsFixture(),before=structuredClone(facts),r=request(stage,facts),table=modelInput(r).source.context.retrievalFacts;
  assert.equal(table.format,'STORYBOARD_FACT_TABLE_V1',stage);
  assert.equal(table.rows.length,3,stage);
  assert.deepEqual(table.groups.current,table.groups.sourceFactIndex);
  assert.deepEqual(table.groups.background,table.groups.backgroundCandidates);
  assert.deepEqual(table.groups.unlinkedBackground,[[table.groups.background[0]]]);
  assert.deepEqual(expand(table),facts,stage);
  assert.deepEqual(r.source.context.retrievalFacts,facts);
  assert.deepEqual(facts,before);
  assert.ok(JSON.stringify(table).length<JSON.stringify(facts).length);
  assert.equal(modelInput(r).modelProjectionVersion,projectionVersion);
 }
});

test('different statements, exact source coordinates, validity and unknown fields survive projection',()=>{
 const facts=factsFixture(),background=facts.background[0];
 facts.backgroundCandidates.push({...background,statement:'甲自述在河口长大。'});
 facts.current[0].extension={confirmed:false,opaque:[null,'原附加值']};
 facts.current[0].evidence.extraCoordinate={line:0};
 facts.historicalStates[0].validity.basis='仅前一时段';
 facts.extra={retrievalOrder:['history-fact','current-fact']};
 facts.backgroundCandidatesOmitted=4;
 const table=modelInput(request('plan',facts)).source.context.retrievalFacts;
 assert.deepEqual(expand(table),facts);
 assert.notEqual(table.groups.backgroundCandidates[0],table.groups.backgroundCandidates[1]);
 // Ambiguous text variants cannot donate a guessed statement to the unlinked record.
 assert.equal(typeof table.groups.unlinkedBackground[0],'number');
 assert.deepEqual(expand(table).historicalStates[0].evidence,{domain:'EPISODE',episode:0,start:0,end:7});
});

test('unknown schemas, reserved metadata and unsupported fact shapes pass through unchanged',()=>{
 for(const facts of [
  {...factsFixture(),schema:'FOUNDATION_FACTS_V2'},
  {...factsFixture(),rows:['unknown original metadata']},
  {...factsFixture(),current:[{id:'partial',statement:'不完整但保留'}]},
  {...factsFixture(),current:[{...factsFixture().current[0],statement:null}]},
  {schema:'unrelated',futureField:{nested:[1,2,3]}},
  null
 ])assert.deepEqual(modelInput(request('plan',facts)).source.context.retrievalFacts,facts);
});

test('frozen snapshots without projection version retain pre-change request bytes and identity',()=>{
 const current=captureRules();
 const rules={version:VERSION,outputSchemaVersion:current.outputSchemaVersion,unitPackingPolicy:current.unitPackingPolicy,creativeRevision:'expressive-cadence-v1',instructions:'固定测试指令',planHint:'固定规划输出',draftHint:'固定主创输出',deltaHint:'固定整编输出',files:Object.fromEntries(Object.keys(current.files).map(p=>[p,'固定规则 '+p]))};
 const expected={
  plan:['cf61f51ef6126e64d86ffde9a572b06517722c2771bc175242932d68b05d5579','db832b89d2440abd84e73623ec1f29e9c3f31ec6b6a4633cf8852ea1a9204836',3301],
  author:['66fd763887ac5c676d00cac82c56edeb66f9aa601c8136a348473adc14d1f2a7','7e479cf588397205ee165df98d148b2a39a8a6dd42bc8a8a87554b4cd56f000b',4426],
  finish:['08a278f413dd829ecd05cdfaa86fe78d947227a225883b48612b9996cb64c603','78bfe835f29b08350ea6bab676c6e9e173040c575b08ef77927e27efc8b7f88a',5000],
  delta:['5292d943d75aea490812629fdd946156ebd9445fc1bc090f779017166e49a324','717df8452f698061a10cedab5e2ce280b1f7a20b61ee481a025d00a45dfa6391',5058]
 };
 for(const [stage,bytes] of Object.entries(expected)){
  const r=request(stage,factsFixture(),rules);
  assert.deepEqual([r.promptHash,r.inputHash,r.prompt.length],bytes,stage);
  assert.deepEqual(modelInput(r).source.context.retrievalFacts,factsFixture());
  assert.equal(Object.hasOwn(modelInput(r),'modelProjectionVersion'),false);
 }
});

test('unknown model projection versions are rejected instead of silently choosing a protocol',()=>{
 assert.throws(()=>request('plan',factsFixture(),{...captureRules(),modelProjectionVersion:'future'}),e=>e.code==='RULE_SNAPSHOT');
});
