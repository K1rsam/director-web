/** Exercise actual HTTP handlers. Only auth/storage/dispatch boundaries are replaced; no DB/model/background job. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
function stub(name:string,exports:unknown){const resolved=require.resolve(name);require.cache[resolved]={id:resolved,filename:resolved,loaded:true,exports} as NodeModule;}
let dispatches=0;const planned:any[]=[];
const workspace={projectId:'fixture',busy:false,assets:[],records:{},automation:{scope:undefined}};
stub('../lib/auth',{getCurrentUser:async()=>({id:'actor'}),requireProjectAccess:async()=>{}});
stub('../lib/asset-prompt-service',{
 loadAssetPromptWorkspace:async(_p:string,scope:any)=>{assert.ok(!scope||scope.assetKeys===undefined||scope.assetKeys.length>0,'A facts workspace cannot receive an empty asset-key scope');return workspace;},
 planEpisodeAssetProduction:async(_p:string,episodeNumbers:number[],keys?:string[])=>{assert.ok(Array.isArray(episodeNumbers)&&episodeNumbers.length&&episodeNumbers.every(n=>n===1),'invalid scope');planned.push({episodeNumbers,keys});return {scope:{episodeNumbers:[1],...(keys?{assetKeys:keys}:{})}};},
 generateAssetPrompt:async()=>{dispatches++;return {status:'READY'};},saveAssetPrompt:async()=>({status:'READY'})
});
stub('../lib/asset-prompt-automation',{launchAssetPromptAutomation:async()=>{dispatches++;},stopAssetPromptAutomation:async()=>{}});
stub('../lib/foundation-state',{loadFoundationInputs:async()=>({sourceVersion:'source'})});
stub('../lib/episode-upstream-material',{readAssetPreparationReview:async()=>({schema:'ASSET_PREPARATION_REVIEW_V1',projectId:'fixture',episodes:[]})});
const {POST,GET}=require('../app/projects/[projectId]/asset-prompts/api/route'),context={params:Promise.resolve({projectId:'fixture'})};
const post=(input:any)=>POST(new Request('http://fixture.test/projects/fixture/asset-prompts/api',{method:'POST',headers:{'Content-Type':'application/json',origin:'http://fixture.test',host:'fixture.test'},body:JSON.stringify({revision:0,...input})}),context);
async function main(){
 for(const action of ['prepare-facts','resume-automation','generate-episodes','generate']){
  const result=await post({action,key:'warehouse'});
  assert.equal(result.status,409,`${action} without an explicit/restorable episode scope must fail before dispatch`);
 }
 assert.equal(dispatches,0);
 for(const action of ['prepare-facts','generate'])assert.equal((await post({action,key:'warehouse',episodeNumbers:[]})).status,409);
 assert.equal(dispatches,0);
 assert.equal((await post({action:'generate',key:'warehouse',episodeNumbers:[1]})).status,200);assert.equal(dispatches,1);
 const before=dispatches;
 assert.equal((await post({action:'save',key:'warehouse',body:'手工文字设计'})).status,200);assert.equal(dispatches,before,'Manual save needs no model/episode generation scope');
 assert.equal((await GET(new Request('http://fixture.test/projects/fixture/asset-prompts/api?view=production-cards'),context)).status,409);
 assert.equal((await GET(new Request('http://fixture.test/projects/fixture/asset-prompts/api?view=production-cards&episodes=1'),context)).status,200);
 assert.deepEqual(planned.at(-1).keys,[],'Card review requests no asset production keys');
 assert.equal((await GET(new Request('http://fixture.test/projects/fixture/asset-prompts/api?episodes=1'),context)).status,200);
 assert.equal(planned.at(-1).keys,undefined,'Regular scoped facts preview keeps a valid nonempty asset scope');
 assert.equal(dispatches,before,'All GET handlers remain free of AI dispatch');
 console.log('PASS asset HTTP scope: no implicit whole-series facts/resume/generation; manual editing remains free; read-only review and normal facts preview are distinct; DB/model calls 0');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
