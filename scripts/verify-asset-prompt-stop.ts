import assert from 'node:assert/strict';
import {stopAssetPromptAutomation,type AssetPromptAutomation} from '../lib/asset-prompt-automation';
async function main(){
 let writes=0,reads=0;let state:AssetPromptAutomation={id:'run-1',sourceVersion:'s',status:'RUNNING',done:0,failed:0,total:3,error:'',updatedAt:new Date().toISOString()};
 const db:any={sceneSnapshot:{findFirst:async()=>{reads++;return{id:'row',content:JSON.stringify(state)};},updateMany:async(input:any)=>{writes++;if(writes===1){state={...state,done:1};return{count:0};}assert.equal(JSON.parse(input.where.content).done,1);state=JSON.parse(input.data.content);return{count:1};}}};
 await stopAssetPromptAutomation('p',db);assert.equal(writes,2);assert.equal(reads,2);assert.equal(state.status,'STOPPED');assert.equal(state.done,1);
 writes=0;await stopAssetPromptAutomation('p',db);assert.equal(writes,0);
 state={...state,status:'RUNNING'};writes=0;db.sceneSnapshot.updateMany=async()=>{writes++;state={...state,status:'COMPLETE'};return{count:0};};await stopAssetPromptAutomation('p',db);assert.equal(writes,1);assert.equal(state.status,'COMPLETE');
 state={...state,status:'RUNNING'};writes=0;db.sceneSnapshot.updateMany=async()=>{writes++;return{count:0};};await assert.rejects(()=>stopAssetPromptAutomation('p',db),/停止尚未生效/);assert.equal(writes,5);
 writes=0;db.sceneSnapshot.updateMany=async()=>{writes++;state={...state,id:'run-2'};return{count:0};};await assert.rejects(()=>stopAssetPromptAutomation('p',db),/任务已切换/);assert.equal(writes,1);
 console.log('PASS: stop retries after progress race, preserves counters, terminal states return, exhausted retries report failure, replacement execution protected; isolated injected DB; model calls 0');
}main().catch(e=>{console.error(e);process.exitCode=1;});
