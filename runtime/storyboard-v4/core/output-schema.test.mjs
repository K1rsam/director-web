import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildRequest,captureRules,SCENARIO_KEYS} from './core.mjs';
import {normalizeSource} from './source.mjs';
import {VERSION,PLAN_VERSION,digest} from './shared.mjs';
import {DELTA_VERSION,baseDraftHash} from './delta.mjs';
import {runModel} from './runner.mjs';

function fixture(){
 const source=normalizeSource({key:'schema-test',title:'继续前进',contextRows:[{id:'c1',line:1,text:'△甲收起护罩。'}],sourceRows:[{id:'s1',line:2,text:'甲：走。'},{id:'s2',line:3,text:'△乙停住。'}],entryFacts:[{id:'known-fact',subject:'甲',statement:'护罩已收起',sourceRefs:['c1'],evidence:'甲收起护罩'}]});
 const emotionContract={subject:'甲',contextTone:'克制',audienceEffect:'感到决心',change:'犹豫转决定',landing:'先行一步',retain:['原话']};
 const plan={schemaVersion:PLAN_VERSION,emotionArc:'从犹豫到行动',entryFacts:[],workPackages:[{id:'p1',sourceRefs:['s1'],emotionContract,entryFactIds:['known-fact'],contextRefs:['c1'],dependsOn:[],scenarioKeys:[]},{id:'p2',sourceRefs:['s2'],emotionContract:{...emotionContract,subject:'乙'},entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'u1',packageId:'p1',sourceRefs:['s1'],secondsRange:[2,5]},{id:'u2',packageId:'p2',sourceRefs:['s2'],secondsRange:[2,5]}],fantasyCandidates:[]};
 const previousDraft={schemaVersion:VERSION,units:[{id:'p1-u1',shots:[]}],fantasyRealization:[]};
 return {source,plan,previousDraft,packageId:'p1',settings:{maxUnits:null,fantasyMode:'off'}};
}
function request(kind,extra={}){
 const data=fixture();
 if(kind==='plan'||kind==='author')delete data.previousDraft;
 const payload={...data,stage:kind==='delta'?'finish':kind,finishMode:kind==='delta'?'delta':'full',rulesSnapshot:captureRules(),...extra};
 if(kind!=='plan'&&payload.rulesSnapshot.outputSchemaVersion==='structured-v2'){
  payload.plan=structuredClone(payload.plan);payload.plan.unitPackingPolicy='event-first-v1';
  payload.plan.events=payload.plan.workPackages.map((w,i)=>{w.eventId='e'+(i+1);return {id:w.eventId,sourceRefs:[...w.sourceRefs],sceneKey:'场景'+(i+1),boundaryBefore:{kind:i?'new_event':'episode_start',reason:i?'前一动作已收束，另起独立事件':'本集事件入口'},emotionContract:structuredClone(w.emotionContract)};});
 }
 return buildRequest(payload);
}
function strict(schema){
 assert.ok(schema&&typeof schema==='object','model request must contain an output schema');
 if(schema.type==='object'){
  assert.equal(schema.additionalProperties,false);
  assert.deepEqual([...schema.required].sort(),Object.keys(schema.properties).sort());
  for(const property of Object.values(schema.properties))strict(property);
 }
 if(schema.items)strict(schema.items);
 if(schema.enum)assert.ok(schema.enum.length,'empty enums are not a valid provider contract');
}
function shot(schema){return schema.properties.units.items.properties.shots.items;}

test('new rules request a closed plan schema with source-row evidence and supplied references',()=>{
 const rules=captureRules(),r=request('plan',{rulesSnapshot:rules});
 assert.equal(rules.outputSchemaVersion,'structured-v2');
 strict(r.schema);
 const p=r.schema.properties;
 assert.deepEqual(p.schemaVersion.enum,[PLAN_VERSION]);
 assert.deepEqual(p.entryFacts.items.required,['id','subject','statement','sourceRefs','evidenceMode']);
 assert.deepEqual(p.entryFacts.items.properties.evidenceMode.enum,['source_rows']);
 assert.deepEqual(p.entryFacts.items.properties.sourceRefs.items.enum,['s1','s2','c1']);
 assert.equal(p.entryFacts.items.properties.evidence,undefined);
 assert.deepEqual(p.workPackages.items.properties.sourceRefs.items.enum,['s1','s2']);
 assert.deepEqual(p.workPackages.items.properties.contextRefs.items.enum,['s1','s2','c1']);
 assert.deepEqual(p.workPackages.items.properties.scenarioKeys.items.enum,SCENARIO_KEYS);
 assert.match(r.prompt,/source_rows/);assert.match(r.prompt,/entryFactIds[^。]*引用/);
});

test('author and full finish schemas preserve every creative field and close every object',()=>{
 for(const kind of ['author','finish']){
  const r=request(kind);strict(r.schema);
  assert.deepEqual(r.schema.properties.schemaVersion.enum,[VERSION]);
  const unit=r.schema.properties.units.items,frame=shot(r.schema),part=frame.properties.dialogueParts.items;
  assert.deepEqual(unit.required,['id','eventId','boundaryBefore','title','unitDirection','intent','scene','props','participants','visualSubjects','lighting','initialState','exitState','shots']);
  assert.deepEqual(frame.required,['id','duration','camera','picture','lighting','sound','dialogueParts','transition','sourceRefs','contextRefs']);
  assert.deepEqual(part.required,['lineId','text','presentation','delivery','voiceStart','voiceEnd']);
  for(const field of ['camera','picture','lighting','sound','transition'])assert.deepEqual(frame.properties[field],{type:'string'});
  assert.deepEqual(part.properties.text,{type:'string'});assert.deepEqual(part.properties.delivery,{type:'string'});
  assert.equal(Object.hasOwn(r.schema.properties,'revisionNotes'),kind==='finish');
  assert.equal(Object.hasOwn(r.schema.properties,'unresolved'),kind==='finish');
 }
});

test('author schema allows only scoped sources, dialogue ids and selected fantasy ids',()=>{
 const data=fixture();data.plan.fantasyCandidates=[{id:'f1',anchorRefs:['s1'],subject:'甲',emotionPurpose:'决心',recommended:true,proposal:'影子先行',screenSecondsRange:[1,2],extraSecondsRange:[0,1]}];
 const r=request('author',{...data,settings:{maxUnits:null,fantasyMode:'recommended'},choice:{mode:'recommended',overrides:{f1:true},unitOverrides:{},confirmedFingerprint:null}});strict(r.schema);
 const frame=shot(r.schema);
 assert.deepEqual(frame.properties.sourceRefs.items.enum,['s1']);
 assert.deepEqual(frame.properties.contextRefs.items.enum,['s1','c1']);
 assert.deepEqual(frame.properties.dialogueParts.items.properties.lineId.enum,['s1:D1']);
 assert.deepEqual(frame.properties.dialogueParts.items.properties.presentation.enum,['画内','画外','VO','OS','系统音','画外转画内','画内转画外']);
 assert.deepEqual(r.schema.properties.fantasyRealization.items.properties.candidateId.enum,['f1']);
});

test('no dialogue or selected fantasy uses empty arrays without empty enum schemas',()=>{
 const data=fixture();data.source.sourceRows[0].text='△甲迈步。';data.source.dialogue=[];
 const r=request('author',data);strict(r.schema);
 assert.equal(shot(r.schema).properties.dialogueParts.maxItems,0);
 assert.equal(r.schema.properties.fantasyRealization.maxItems,0);
 assert.equal(request('plan').schema.properties.fantasyCandidates.maxItems,0);
});

test('delta schema pins the exact base and old ids while retaining complete replacement bodies',()=>{
 const r=request('delta');strict(r.schema);
 const p=r.schema.properties;
 assert.deepEqual(p.schemaVersion.enum,[DELTA_VERSION]);
 assert.deepEqual(p.baseDraftHash.enum,[baseDraftHash(fixture().previousDraft)]);
 assert.deepEqual(p.retainedUnitIds.items.enum,['p1-u1']);
 assert.deepEqual(p.replacements.items.properties.replaces.items.enum,['p1-u1']);
 assert.deepEqual(p.replacements.items.properties.units,request('finish').schema.properties.units);
 assert.ok(p.revisionNotes);assert.ok(p.unresolved);
 const fallback=request('delta',{previousDraft:{rawText:'已保存未通过的原文'}});
 assert.equal(fallback.finishMode,'full');assert.deepEqual(fallback.schema.properties.schemaVersion.enum,[VERSION]);
});

test('frozen v1 schema identity changes input hash without leaking hash metadata into model prose',()=>{
 const current={...captureRules(),outputSchemaVersion:'structured-v1'};delete current.unitDirectionVersion;delete current.unitPackingPolicy;const legacy={...current};delete legacy.outputSchemaVersion;
 const a=request('author',{rulesSnapshot:legacy}),b=request('author',{rulesSnapshot:current});
 assert.equal(a.schema,undefined);assert.ok(b.schema);
 assert.equal(b.schemaHash,digest(b.schema));
 assert.notEqual(a.inputHash,b.inputHash);assert.equal(a.promptHash,b.promptHash);
 assert.equal(a.instructionHash,b.instructionHash);assert.ok(!b.prompt.includes(b.schemaHash));
});

test('legacy snapshots keep exact plan, author, full and delta hashes without schema',()=>{
 const rules={version:VERSION,instructions:'测试固定指令',files:Object.fromEntries(Object.keys(captureRules().files).map(p=>[p,'测试固定规则 '+p]))};
 // Saved tasks contain their normalized model, reasoning and style; today's defaults must not rewrite them.
 const settings={...fixture().settings,model:'gpt-6-sol',reasoning:'medium',visualStyle:'3D三渲二国漫横屏16:9；C4D/Octane风格精细渲染，赛璐璐光影结合PBR材质。角色身份、衣发与道具一致；人物表演的强弱与幅度服从本段情绪和策略，摄影、声光、动作共同组织，空间可读、有纵深。无额外字幕、水印、logo、BGM；源剧情必要屏幕信息保留。'};
 const expected={
  plan:['6ab79d7a0a04daa55112c117fb064059b4479fdab38362be1152142229e79269','5ddcedb27e13345b56f6a5b782d5e167054652a526225d2701ee159a105adc27'],
  author:['f8a8aa95e99b87bf1424a3f01e84708c40605279cf3d1f6b978b610b7d5c5c2b','71c950657e67aab1a31b0642bbfdd3cee6fa867b9381c976078ab58d129e9e00'],
  finish:['cc063822b689d364dabbd0adfae1cef9d04d28f4d4273abaa15a75ade1586beb','7fa84fee667fa7043f0df2c6fb50b80f15575b24e44e7b8ee3847c03328ef486'],
  delta:['37e6069d70d80241703be08304669dc21e24bc5acc39ab1d4ca1c781b24672b6','e435dfba05a09e256e1db9bb46bf64488ab2bd4936d8aab9875209e37e933294']
 };
 for(const [kind,hashes] of Object.entries(expected)){
  const r=request(kind,{rulesSnapshot:rules,settings});
  assert.deepEqual([r.inputHash,r.promptHash],hashes,kind);
  assert.equal(r.instructionHash,'c785a430e45b1ec5dd546c1c2499d37d95c27ffaf7eb3713e7df8efda2125659');
  assert.equal(Object.hasOwn(r,'schema'),false);assert.equal(Object.hasOwn(r,'schemaHash'),false);
 }
 assert.equal(Object.hasOwn(rules,'outputSchemaVersion'),false);
});

test('unknown output schema versions are refused rather than silently falling back',()=>{
 assert.throws(()=>request('plan',{rulesSnapshot:{...captureRules(),outputSchemaVersion:'structured-future'}}),e=>e.code==='RULE_SNAPSHOT');
});

test('plan repair targets the paid prior response without adding repair text to ordinary planning',()=>{
 const r=request('plan',{previousDraft:{rawText:'已付规划原文',previousPlan:fixture().plan},issues:[{code:'ENTRY_FACT_EVIDENCE'}]});
 assert.match(r.prompt,/定向修复/);assert.match(r.prompt,/不从零重想/);assert.match(r.prompt,/已付规划原文/);
 assert.doesNotMatch(request('plan').prompt,/定向修复/);
});

test('built requests deliver each schema to the CLI argument file and saved request without paid calls',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'v4-schema-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const fake="import {readFile,writeFile} from 'node:fs/promises';const args=process.argv.slice(1),value=flag=>args[args.indexOf(flag)+1];if(!args.includes('--output-schema'))throw Error('missing schema flag');for await(const _ of process.stdin){}const schema=JSON.parse(await readFile(value('--output-schema'),'utf8'));await writeFile(value('-o'),JSON.stringify({schema}));";
 for(const kind of ['plan','author','finish','delta']){
  const r=request(kind);assert.ok(r.schema,'production request must supply a schema');
  const result=await runModel(r,{directory,attemptId:kind,executable:process.execPath,executableArgs:['--input-type=module','-e',fake,'--']});
  assert.deepEqual(result.output.schema,r.schema);
  const saved=JSON.parse(await readFile(path.join(directory,'attempts',kind,'request.json'),'utf8'));
  assert.deepEqual(saved.schema,r.schema);assert.equal(saved.schemaHash,digest(r.schema));
 }
});
