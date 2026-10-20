import test from 'node:test';
import assert from 'node:assert/strict';
import {projectModelCoordinates,restoreModelCoordinates} from './storyboard-v4/core/model-coordinates.mjs';
import {captureRules,buildRequest} from './storyboard-v4/core/core.mjs';
import {digest} from './storyboard-v4/core/shared.mjs';

const safeVersion='model-coordinates-collision-v2';

test('collision-safe opt-in keeps prose literal and allocates disjoint lossless machine aliases',()=>{
 const id='history:'+ 'a'.repeat(64),ref='upstream-evidence:'+ 'b'.repeat(64);
 const quote='原文标签R0001与R0002不改，旧说明仍保留R0105。';
 const input={source:{sourceRows:Array.from({length:24},()=>({id:ref,text:quote,kind:'action'}))},plan:{emotionContract:{change:'R0105的被动变主动。'},sourceRefs:Array(20).fill(ref)},materials:Array(20).fill({id,sourceRefs:[ref]})};
 const schema={type:'object',properties:{sourceRefs:{type:'array',items:{type:'string',enum:[ref]}},usedMaterialIds:{type:'array',items:{type:'string',enum:[id]}}}};
 const before=structuredClone({input,schema}),legacy=projectModelCoordinates(input,schema);
 assert.equal(legacy.coordinates,null,'frozen v1 collision fallback stays byte-compatible');
 const next=projectModelCoordinates(input,schema,{coordinateVersion:safeVersion});
 assert.ok(next.coordinates,'an old prose Rxxxx marker must not disable all new ID compression');
 assert.equal(next.coordinates.version,safeVersion);
 for(const alias of Object.keys(next.coordinates.aliases))assert.ok(!quote.includes(alias)&&!input.plan.emotionContract.change.includes(alias));
 assert.equal(next.input.source.sourceRows[0].text,quote);assert.equal(next.input.plan.emotionContract.change,input.plan.emotionContract.change);
 const wire={sourceRefs:next.input.plan.sourceRefs,usedMaterialIds:[next.input.materials[0].id],text:quote,emotion:'R0105仍是说明文字'};
 assert.deepEqual(restoreModelCoordinates(wire,next.coordinates),{sourceRefs:input.plan.sourceRefs,usedMaterialIds:[id],text:quote,emotion:'R0105仍是说明文字'});
 assert.ok(JSON.stringify(next.input).length+JSON.stringify(next.schema).length+next.hint.length<JSON.stringify(input).length+JSON.stringify(schema).length);
 assert.deepEqual({input,schema},before);
 const invalid={...next.coordinates,aliases:{...next.coordinates.aliases,R9999:'foreign-source-id-with-enough-length'}};
 assert.throws(()=>restoreModelCoordinates(wire,invalid),{code:'MODEL_COORDINATES'});
});

test('collision-safe policy keeps opaque raw namespaces and unsupported versions conservative',()=>{
 const id='history:'+ 'c'.repeat(64),input={sourceRefs:Array(40).fill(id)},schema={enum:[id]};
 assert.equal(projectModelCoordinates({...input,previousDraft:{rawText:'{"sourceRefs":["R0001"]}'}},schema,{coordinateVersion:safeVersion}).coordinates,null);
 assert.equal(projectModelCoordinates(input,schema,{coordinateVersion:'unknown'}).coordinates,null);
});

test('new rules capture collision-safe spelling while a frozen snapshot keeps its old request identity',()=>{
 const rules=captureRules();assert.equal(rules.modelCoordinateVersion,'model-coordinates-v4');
 const frozen={...rules};delete frozen.modelCoordinateVersion;
 const source={key:'long-source-key-'.repeat(4),sourceRows:[{id:'source-row-'.repeat(5),text:'甲：原文中的R0001必须保留。',kind:'dialogue'}],contextRows:[],entryFacts:[],dialogue:[{id:'dialogue-'.repeat(5),rowId:'source-row-'.repeat(5),speaker:'甲',quote:'原文中的R0001必须保留。',cue:'',kind:'speech'}],assets:[]};
 const settings={model:'gpt-6.1-sol',reasoning:'medium',maxUnitSeconds:30,maxUnits:null,fantasyMode:'recommended',visualStyle:'3D国漫'};
 const productionSnapshot={version:'production-feedback-v1',transportVersion:'compact-v4',materials:[],touchesOpening:true,touchesEnding:false};
 // Use the runtime's frozen transport identity, not a provider call.
 productionSnapshot.transportVersion=rules.productionTransportVersion;
 const prior=buildRequest({stage:'plan',source,settings,rulesSnapshot:frozen,productionSnapshot}),next=buildRequest({stage:'plan',source,settings,rulesSnapshot:rules,productionSnapshot});
 assert.equal(prior.modelCoordinates,undefined);assert.equal(next.modelCoordinates?.version,rules.modelCoordinateVersion);
 assert.equal(digest(buildRequest({stage:'plan',source,settings,rulesSnapshot:frozen,productionSnapshot})),digest(prior));
 assert.equal(prior.source.sourceRows[0].text,next.source.sourceRows[0].text);assert.equal(prior.source.dialogue[0].quote,next.source.dialogue[0].quote);
 assert.throws(()=>buildRequest({stage:'plan',source,settings,rulesSnapshot:{...rules,modelCoordinateVersion:'unknown'},productionSnapshot}),{code:'RULE_SNAPSHOT'});
});

test('opt-in historical table coordinates shorten only machine columns and preserve dialogue literally',()=>{
 const id='history:'+ 'a'.repeat(64),ref='upstream-evidence:'+ 'b'.repeat(64),quote='甲：原话里也写着'+id+'。';
 const table={format:'HISTORICAL_EVIDENCE_TABLE_V4',columns:['id','statement','contextRef','retrieval'],shared:{candidateUse:'HISTORICAL_EVIDENCE_ONLY'},rows:Array.from({length:16},()=>[id,quote,ref,{mode:'SUBJECT_MENTION',anchorFactIds:[id]}])};
 const input={source:{context:{retrievalFacts:{historicalEvidenceCandidates:table}}}},schema={type:'object',properties:{contextRefs:{type:'array',items:{type:'string',enum:[ref]}}}};
 const legacy=projectModelCoordinates(input,schema),next=projectModelCoordinates(input,schema,{includeHistoricalTables:true});
 assert.equal(legacy.input.source.context.retrievalFacts.historicalEvidenceCandidates.rows[0][2],ref);
 const row=next.input.source.context.retrievalFacts.historicalEvidenceCandidates.rows[0];
 assert.match(row[2],/^R\d{4}$/);assert.equal(row[1],quote);
 assert.deepEqual(restoreModelCoordinates({contextRefs:[row[2]],text:quote},next.coordinates),{contextRefs:[ref],text:quote});
 assert.deepEqual(input.source.context.retrievalFacts.historicalEvidenceCandidates.rows[0],[id,quote,ref,{mode:'SUBJECT_MENTION',anchorFactIds:[id]}]);
});
