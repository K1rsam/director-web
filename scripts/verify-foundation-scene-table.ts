import assert from 'node:assert/strict';
import { compactFoundationSceneTable as compact, expandFoundationSceneTable as expand, projectFoundationModelInput as project } from '../lib/foundation-model-input';
import { costFingerprint } from '../lib/foundation-delivery';
import { stageRepairPlanner } from '../lib/foundation-stage-repair';
import { buildLightFoundationPrompt } from '../lib/foundation-production-prompts';
import { runFoundationDeliveryCall, type DeliveryAttempt } from '../lib/foundation-delivery-call';
import { FoundationContractError, type FoundationIssue } from '../lib/project-foundation-contracts';

const input={scope:[1],source:{version:'stable-source',episodes:[{number:1,lineCount:1,lines:[[1,'  甲：原文。\r\n']]}]},scenes:Array.from({length:12},(_,i)=>({episode:1,sceneKey:`1-${i+1}`,heading:'场标题',location:'客厅',timeOfDay:'日',interiorExterior:'内',weather:null,timeLayer:'现实',characters:['甲','乙'],sourceLines:{startLine:1,endLine:1},extra:{keep:[null,'x']}})),project:{style:'3D',aspectRatio:'16:9'},registry:[{key:'a',name:'甲',aliases:[],variants:[]}],candidates:{f2:{format:'ASSET_CATALOG_V2',coverage:[1],assets:[]}}};
const original=structuredClone(input),wire=project(input) as typeof input & {scenes:any};
assert.equal(wire.scenes.format,'SCENE_TABLE_V1');assert.ok(JSON.stringify(wire.scenes).length<JSON.stringify(input.scenes).length);
assert.deepEqual(expand(JSON.parse(JSON.stringify(wire.scenes))),input.scenes);assert.deepEqual(wire.source,input.source);assert.deepEqual(input,original);
assert.deepEqual(project(wire),wire);assert.deepEqual(compact(wire.scenes),wire.scenes);
for(const value of [[],[input.scenes[0]],[{a:1},{a:2}],[{a:null},{b:null}],[{a:undefined},{a:null}],[{a:new Date(0)},{a:new Date(1)}],[{a:[,1]},{a:[null,1]}]])assert.deepEqual(compact(value),value,'No shape widening, missing-to-null conversion, or negative savings');
const unknown=input.scenes.map(s=>({...s,unrecognized:{sceneRefs:[{episode:1,sceneKey:'keep'}],literal:'  正文\r\n\n😀  '}}));assert.deepEqual(expand(compact(unknown)),unknown,'Unknown fields, nested sceneRefs, whitespace and order stay exact');
const broken=structuredClone(wire.scenes);broken.rows[0].pop();assert.throws(()=>expand(broken));
assert.throws(()=>expand({...wire.scenes,extra:'do not silently drop'}));
for(const stage of ['F2','Q1'] as const){
 const baseline=stage==='F2'?'3f4c14cfa772b2ddab86d3f51aa565de423f302f4da7262538085212af5a5be0':'87ccf9a46553bdc241c6fc944003426d56f65373e2be5a866337eb41eedbb4eb';
 assert.equal(costFingerprint(stage,input),baseline,'Absolute paid hash recorded before scene transport change must not drift');
 assert.equal(costFingerprint(stage,wire),baseline);assert.equal(costFingerprint(stage,JSON.parse(JSON.stringify(wire))),baseline);
 const prompt=buildLightFoundationPrompt(stage,input),parsed=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);assert.equal(parsed.scenes.format,'SCENE_TABLE_V1');assert.deepEqual(expand(parsed.scenes),input.scenes);assert.equal(costFingerprint(stage,parsed),baseline);
 const changed=structuredClone(wire);changed.scenes.rows[0][changed.scenes.columns.indexOf('characters')]=['乙','甲'];assert.notEqual(costFingerprint(stage,changed),baseline,'Semantic scene changes must still invalidate paid work');
}
const candidate={format:'FOUNDATION_OPTIMIZATION_V2',coverage:[1],changes:{scenes:[{episode:1,sceneKey:'unknown',weather:'雨'}]}};
const issues:FoundationIssue[]=[{severity:'BLOCKER',owner:'PROGRAM',coordinate:'changes.scenes.0.sceneKey',problem:'未知场次',sourceRefs:[]}];
const oldPlan=stageRepairPlanner(input,'same-skill')({stage:'Q1',candidate,issues}),newPlan=stageRepairPlanner(wire,'same-skill')({stage:'Q1',candidate,issues});assert.ok(newPlan);assert.deepEqual(newPlan,oldPlan,'Saved old/new requests supply exactly the same repair evidence');
async function main(){
 const context={provider:'CLI' as const,role:{code:'Q1',skill:'',systemPrompt:'same-skill',model:'offline',reasoningEffort:'low' as const},sessionMode:'ephemeral' as const,runId:'offline',batchToken:'offline',sourceVersion:'source',inputVersion:'input',chunkIndex:1,scope:[1]};
 const saved:DeliveryAttempt={sequence:1,kind:'INITIAL',scope:[1],systemPrompt:'same-skill',taskPrompt:buildLightFoundationPrompt('Q1',input),provider:'CLI',model:'offline',reasoningEffort:'low',startedAt:new Date(0).toISOString(),status:'FAILED',requestOutcome:'RESPONDED',providerCallCount:1,response:{data:candidate,rawOutput:JSON.stringify(candidate)},issues};
 let calls=0;const validate=(data:unknown)=>{const x=data as typeof candidate;if(x.changes.scenes[0].sceneKey!=='1-1')throw new FoundationContractError('unknown',issues);return x;};
 const repaired=await runFoundationDeliveryCall({stage:'Q1',prompt:'unchanged',context,resumeFrom:saved,validate,repairPlan:stageRepairPlanner(wire,'same-skill'),takeRepairBudget:async()=>true,runner:async(_stage,prompt)=>{calls++;const packet=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);assert.deepEqual(packet.scenes,input.scenes);return {data:{format:'FIELD_REPAIR_V1',patches:[{path:'changes.scenes.0.sceneKey',value:'1-1'}]},stdout:'',stderr:'',sessionId:null};}});
 assert.equal(calls,1);assert.deepEqual(repaired.output.changes.scenes[0],{episode:1,sceneKey:'1-1',weather:'雨'});
 const recovered=await runFoundationDeliveryCall({stage:'Q1',prompt:'unchanged',context,resumeFrom:repaired.attempts[0],validate,repairPlan:stageRepairPlanner(wire,'same-skill'),runner:async()=>assert.fail('No duplicate paid request')});assert.deepEqual(recovered.output,repaired.output);
 console.log(JSON.stringify({status:'PASS',checks:'scene transport roundtrip/null/missing/extra/ordering/idempotence, exact old paid hashes, semantic invalidation, old+new repair evidence and paid replay',unit:'UTF-16 characters',before:JSON.stringify(input.scenes).length,after:JSON.stringify(wire.scenes).length}));
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
