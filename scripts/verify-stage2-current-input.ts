/** Consistent real-material scratch snapshot; inspect the actual Stage 3 input, never dispatch/alter production. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync,backup} from 'node:sqlite';
const require=createRequire(import.meta.url);
async function main(){
 const projectFlag=process.argv.indexOf('--project'),projectId=projectFlag>=0?process.argv[projectFlag+1]:null;
 if(!projectId)throw new Error('Use --project <local project ID>; this audit never generates material.');
 const scratch=mkdtempSync(path.join(tmpdir(),'3008-stage2-review-'));let db:any;
 try{
  const original=new DatabaseSync(path.resolve('prisma/dev.db'),{readOnly:true});
  try{await backup(original,path.join(scratch,'audit.db'));}finally{original.close();}
  Object.assign(process.env,{DATABASE_URL:'file:'+path.join(scratch,'audit.db'),NODE_ENV:'production'});
  db=require('../lib/prisma').prisma;
  const roles=require('../lib/role-runner'),forbidden=async()=>{throw new Error('Stage 2 audit forbids model dispatch');};
  require.cache[require.resolve('../lib/role-runner')]!.exports={...roles,runRoleByProvider:forbidden,runCliRoleJson:forbidden,runApiRoleJson:forbidden};
  const {readAssetPreparationReview,readProductionEpisodeHandoff}=require('../lib/episode-upstream-material');
  const {makeEpisodeInput}=require('../runtime/storyboard-v4/input.mjs');
  const {splitProductionMaterials,selectProductionMaterials,changedConsumedMaterials}=require('../runtime/production-materials.mjs');
  const snapshotsBefore=await db.sceneSnapshot.findMany({where:{projectId},orderBy:{id:'asc'}}),episodesBefore=await db.episode.findMany({where:{projectId},orderBy:{id:'asc'}});
  const review=await readAssetPreparationReview(projectId,[1,2]),metrics=[];
  for(const view of review.episodes){
   const episode:any=await db.episode.findFirstOrThrow({where:{projectId,number:view.episodeNumber},include:{project:true}});
   const handoff:any=await readProductionEpisodeHandoff(projectId,view.episodeNumber);
   assert.deepEqual(view.cards,handoff.packet.upstream.assetProductionCards);
   const prepared:any=splitProductionMaterials(makeEpisodeInput({episode,project:episode.project,handoff,inputProtocol:'upstream-material-v2'}));
   const materials:any[]=selectProductionMaterials(prepared.materials,'plan',null);
   for(const card of view.cards){
    const sent=materials.find((m:any)=>m.id===`asset:${card.assetKey}`);
    assert.ok(sent,`${card.assetKey} is missing at the real production material consumer`);
    assert.deepEqual(sent.value,card,'No design/evidence content lost between the review and Stage 3 consumption');
    assert.equal(card.applicable.episode,view.episodeNumber);
    for(const fact of card.sourceFacts){
     assert.ok(handoff.packet.sourceText.includes(fact.quote),'No invented quote');
     if(fact.evidence.domain==='EPISODE')assert.equal(fact.evidence.episode,view.episodeNumber);
    }
   }
   assert.equal(materials.length,view.cards.length,'No separately repeated design catalogue');
   const oldUnlinked=structuredClone(handoff);
   const affectedKeys=view.cards.filter((c:any)=>c.type==='CH'&&c.sourceFacts.length).map((c:any)=>c.assetKey);
   for(const card of oldUnlinked.packet.upstream.assetProductionCards)if(affectedKeys.includes(card.assetKey))card.sourceFacts=[];
   const oldPrepared=splitProductionMaterials(makeEpisodeInput({episode,project:episode.project,handoff:oldUnlinked,inputProtocol:'upstream-material-v2'}));
   assert.equal(oldPrepared.sourceBasisVersion,prepared.sourceBasisVersion,'Card evidence supplements must not rewrite the hard script/direction basis');
   assert.deepEqual(changedConsumedMaterials(oldPrepared.materials,prepared.materials,[]),[],'A consumer that never used the affected cards is not invalidated');
   assert.deepEqual(changedConsumedMaterials(oldPrepared.materials,prepared.materials,affectedKeys.map((key:string)=>`asset:${key}`)),affectedKeys.map((key:string)=>`asset:${key}`),'Only consumers of changed card evidence need a material check');
   for(const card of view.cards.filter((c:any)=>c.name.startsWith('苏尘｜'))){
    assert.ok(card.sourceFacts.length,'The real current script must link the catalogue look label to the original character identity');
   }
   const unused=selectProductionMaterials(prepared.materials,'author',{productionFeedback:{usedMaterialIds:[],needs:[]}},['audit-package']);
   assert.deepEqual(unused,[],'Receipt-declared unused cards are not repeatedly sent to authoring');
   metrics.push({episodeNumber:view.episodeNumber,readiness:view.readiness,directionStatus:view.directionStatus,textCards:view.cards.length,
    adoptedDesigns:view.cards.filter((c:any)=>c.adoptedDesign).length,referenceAvailable:view.cards.filter((c:any)=>c.materialAvailability==='REFERENCE_AVAILABLE').length,
    sentToPlannerExactly:true,unusedAuthorCards:unused.length,
    cards:view.cards.map((c:any)=>({key:c.assetKey,name:c.name,type:c.type,use:c.use,sceneKeys:c.applicable.sceneKeys,sourceQuotes:c.sourceFacts.length,
     sourceActionQuotes:c.sourceFacts.filter((f:any)=>f.claim==='SOURCE'&&f.association==='SCENE_ACTION').length,characterClaims:c.sourceFacts.filter((f:any)=>f.claim==='CHARACTER_CLAIM').length,
     adopted:Boolean(c.adoptedDesign),imageRequired:false}))});
  }
  assert.deepEqual(await db.sceneSnapshot.findMany({where:{projectId},orderBy:{id:'asc'}}),snapshotsBefore);
  assert.deepEqual(await db.episode.findMany({where:{projectId},orderBy:{id:'asc'}}),episodesBefore);
  console.log(JSON.stringify({modelCalls:0,backgroundJobs:0,originalDbWrites:0,consumer:'makeEpisodeInput → splitProductionMaterials → selectProductionMaterials',
   scope:'Current first/second episode facts and designs, not real creative generation or a semantic sufficiency verdict',metrics},null,2));
 }finally{if(db)await db.$disconnect();rmSync(scratch,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
