/** Real card builder + read-only review + production material consumer. No provider or DB. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import * as upstream from '../lib/episode-upstream-material';
const require=createRequire(import.meta.url);
const {splitProductionMaterials,selectProductionMaterials}=require('../runtime/production-materials.mjs');
const text='1-1 仓库 日 内\n△甲反锁铁门，躲进固定货架后。\n甲：这扇门永远打不开。\n';
const start=text.indexOf('△'),end=text.indexOf('甲：');
const base={packet:{episode:1,sourceVersion:'source-v1',sourceText:text,assets:[{key:'warehouse',name:'仓库',type:'LOC',aliases:[],episodes:[1],sceneRefs:[{episode:1,sceneKey:'1-1'}],variants:[]}],materialDependencies:[],scenes:[{episode:1,sceneKey:'1-1',sourceRange:{start:0,end:text.length},assetKeys:['warehouse']}],facts:{sourceFactIndex:[{id:'action',kind:'STATE',subjects:['甲'],claim:'SOURCE',evidence:{domain:'EPISODE',episode:1,start,end}},{id:'claim',kind:'UTTERANCE',subjects:['甲'],claim:'CHARACTER_CLAIM',evidence:{domain:'EPISODE',episode:1,start:end,end:text.length}}]}},readiness:'READY',reasons:[]} as unknown as Parameters<typeof upstream.attachEpisodeMaterials>[0];
const handoff=upstream.attachEpisodeMaterials(base,{status:'UNCONFIRMED',projection:null} as Parameters<typeof upstream.attachEpisodeMaterials>[1],[{assetKey:'warehouse',status:'UNADOPTED',materialAvailability:'TEXT_ONLY',references:[]},{assetKey:'future',status:'TEXT_ADOPTED',brief:'未来宫殿秘密出口',materialAvailability:'TEXT_ONLY',references:[]}]);
async function main(){
 const readReview=(upstream as any).readAssetPreparationReview;
 assert.equal(typeof readReview,'function','Stage 2 must expose the actual source-grounded cards without generating prompts');
 const before=structuredClone(handoff),readNumbers:number[]=[];
 const review=await readReview('fixture',[1,1],async(project:string,n:number)=>{assert.equal(project,'fixture');readNumbers.push(n);return handoff;});
 assert.deepEqual(readNumbers,[1],'Read exactly the selected episode once, not the catalogue/all episodes');
 assert.equal(review.schema,'ASSET_PREPARATION_REVIEW_V1');
 assert.deepEqual(review.episodes[0].cards,handoff.packet.upstream.assetProductionCards,'Review displays the same cards as production, not a separately generated summary');
 assert.equal(review.episodes[0].directionStatus,'UNCONFIRMED');
 assert.equal(review.episodes[0].cards[0].adoptedDesign,null);
 assert.equal(review.episodes[0].cards[0].imageEvidence,'NO_PIXELS_READ');
 assert.doesNotMatch(JSON.stringify(review),/未来宫殿/);
 assert.deepEqual(handoff,before);
 const source={key:'fixture',sourceRows:[],dialogue:[],context:{assetProductionCards:review.episodes[0].cards,modelDesigns:[]}};
 const prepared=splitProductionMaterials({source,visualStyle:'3D'});
 const plan=selectProductionMaterials(prepared.materials,'plan',null);
 assert.equal(plan.length,1,'An unadopted text card is actually delivered to planning');
 assert.deepEqual(plan[0].value.sourceFacts,review.episodes[0].cards[0].sourceFacts);
 assert.ok(plan[0].value.sourceFacts.some((f:any)=>f.quote.includes('反锁铁门')));
 assert.ok(!plan[0].value.sourceFacts.some((f:any)=>f.quote.includes('永远打不开')&&f.claim==='SOURCE'));
 assert.equal(selectProductionMaterials(prepared.materials,'author',{productionFeedback:{usedMaterialIds:[],needs:[]}},['p1']).length,0,'Unused cards are not sent repeatedly to authoring');
 assert.equal(selectProductionMaterials(prepared.materials,'author',{productionFeedback:{usedMaterialIds:['asset:warehouse'],needs:[]}},['p1']).length,1);
 for(const numbers of [[],[NaN],[-1],[1.2],Array.from({length:1001},(_,n)=>n)])await assert.rejects(readReview('fixture',numbers,()=>{throw new Error('Invalid selection must fail before reading');}),/制作集数/);
 await assert.rejects(readReview('fixture',[2],async()=>handoff),/本集/,'Never relabel another episode card as the requested one');
 await assert.rejects(readReview('fixture',[1,2],async(_p:string,n:number)=>n===1?handoff:{...handoff,packet:{...handoff.packet,episode:2,sourceVersion:'changed'}}),/来源/,'Do not present a mixed source version');
 console.log('PASS Stage 2 preparation: existing unadopted cards reach planner unchanged; no repeated unused materials, no future/character-claim laundering, exact scope, no mixed source; model/DB calls 0');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
