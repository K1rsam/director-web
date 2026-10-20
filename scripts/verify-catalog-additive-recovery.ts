import assert from 'node:assert/strict';
import {buildSourceIndex} from '../lib/project-foundation-contracts';
import {requireProductionCatalogAuthor as accept, requireProductionCatalog} from '../lib/foundation-production-contracts';
import {runFoundationDeliveryCall, type DeliveryAttempt} from '../lib/foundation-delivery-call';

async function main(){
 const index=buildSourceIndex([1,2,3].map(number=>({id:`e${number}`,number,title:null,content:`第${number}集\n${number}-1 日 外 城门\n人物：守军\n△守军经过城门。\n${number}-2 日 外 营地\n△守军在营地列队。\n`})));
 const prior=accept({format:'ASSET_CATALOG_V2',coverage:[1],assets:[{name:'守军',type:'GROUP',episodes:[1],preparation:{mode:'REFERENCE'}}]},index,[1]).assets;
 const key=prior[0].key;
 const rows=[{key,name:'守军',type:'GROUP',episodes:[2,3],sceneRefs:[{episode:2,sceneKey:'2-1'},{episode:3,sceneKey:'3-1'}],relationNote:'第二集守城，第三集随军。',variants:[{name:'行军',episodes:[3],note:'原有行军说明。'}]},
  {key,name:'守军',type:'GROUP',episodes:[3],sceneRefs:[{episode:3,sceneKey:'3-2'}],relationNote:'第三集营地补充，不是新增身份。',variants:[{name:'行军',episodes:[3],note:'营地仍用行军状态。'}]}];
 const value={format:'ASSET_CATALOG_V2',coverage:[2,3],assets:rows},before=structuredClone(value);
 const validate=(data:unknown)=>accept(data,index,[2,3],prior);
 const output=validate(value),asset=output.assets[0];
 assert.equal(output.assets.length,1);assert.equal(asset.key,key);assert.deepEqual(asset.usageEpisodes,[2,3]);
 assert.deepEqual(asset.sceneRefs,[{episode:2,sceneKey:'2-1'},{episode:3,sceneKey:'3-1'},{episode:3,sceneKey:'3-2'}]);
 for(const row of rows)assert(asset.relationNote?.includes(row.relationNote));
 for(const variant of rows.flatMap(row=>row.variants))assert(asset.variants[0].note.includes(variant.note));
 assert.deepEqual(value,before,'original response is immutable');assert.deepEqual(requireProductionCatalog(output,index,[2,3]),output);
 let calls=0;
 const response={data:value,rawOutput:JSON.stringify(value),stdout:'saved native usage',stderr:'',sessionId:null};
 const saved:DeliveryAttempt={sequence:1,kind:'INITIAL',scope:[2,3],systemPrompt:'original rules',taskPrompt:'original source',provider:'CLI',model:'offline',reasoningEffort:'medium',startedAt:new Date(0).toISOString(),status:'FAILED',requestOutcome:'RESPONDED',providerCallCount:1,response,issues:[{severity:'BLOCKER',owner:'PROGRAM',coordinate:'assets.key',problem:'不得重复',sourceRefs:[]}]};
 const replay=await runFoundationDeliveryCall({stage:'F2',prompt:'original source',context:{projectId:'offline',provider:'CLI',role:{code:'F2',skill:'',systemPrompt:'original rules',model:'offline',reasoningEffort:'medium'},sessionMode:'ephemeral',runId:'saved',batchToken:'original-task',sourceVersion:index.version,inputVersion:'input',chunkIndex:1,scope:[2,3]},resumeFrom:saved,validate,runner:async()=>{calls++;throw Error('No new provider calls');}});
 assert.equal(calls,0);assert.deepEqual(replay.attempts,[]);assert.deepEqual(replay.output,output);assert.deepEqual(saved.response,response);
 for(const [field,changed] of [['name','另一个守军'],['type','CH'],['role','反派'],['preparation',{mode:'INLINE'}]] as const){
  const bad={...value,assets:[rows[0],{...rows[1],[field]:changed}]};
  assert.throws(()=>validate(bad),new RegExp(`assets\\.1\\.${field}`),'conflicts retain an exact repair coordinate');
 }
 assert.throws(()=>accept({...value,assets:[{...rows[0],key:'unknown'},rows[1]]},index,[2,3],prior),/未知已有身份/);
 assert.throws(()=>validate({...value,assets:[rows[0],{...rows[1],episodes:[1]}]}),/episodes/);
 const unnamed=rows.map(({key:_key,...row})=>row);assert.equal(validate({...value,assets:unnamed}).assets.length,2,'same name alone never proves same identity');
 console.log('PASS additive known-identity catalog reception and free saved reply recovery; conflicts/source/identity guards retained');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
