import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';

async function main(){
 const file=path.join(mkdtempSync(path.join(tmpdir(),'asset-candidate-retention-')),'test.db'),db=new DatabaseSync(file);
 for(const migration of readdirSync('prisma/migrations').sort())if(/^\d/.test(migration))db.exec(readFileSync(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));db.close();process.env.DATABASE_URL=`file:${file}`;
 const {prisma}=await import('../lib/prisma'),{loadFoundationInputs}=await import('../lib/foundation-state'),{createEmptyDocument}=await import('../lib/foundation-document'),prompts=await import('../lib/asset-prompt-service'),handoffs=await import('../lib/episode-upstream-material'),adoptions=await import('../lib/asset-design-adoption'),candidates=await import('../lib/asset-material-candidates');
 const require=createRequire(import.meta.url),{makeEpisodeInput}=require('../runtime/storyboard-v4/input.mjs'),{splitProductionMaterials,selectProductionMaterials,changedConsumedMaterials}=require('../runtime/production-materials.mjs');
 try{
  const user=await prisma.user.create({data:{username:'retention',email:'retention@synthetic.invalid',passwordHash:'fixture'}}),project=await prisma.project.create({data:{title:'同资产独立补料合成样本',roles:{create:{userId:user.id,role:'ADMIN'}},episodes:{create:[{number:1,content:'1-1 仓库 日 内\n△甲抬手，袖口的绣线磨损。他踢开纸箱，鞋底留下泥痕。'}]}}});
  const doc=createEmptyDocument(await loadFoundationInputs(project.id));doc.f2={format:'ASSET_CATALOG_V1',coverage:[1],issues:[],assets:[{key:'CH01',name:'甲',type:'CH',aliases:[],description:'',sourceRefs:[],appearances:[],usageEpisodes:[1],variants:[],preparation:{mode:'REFERENCE'}}],episodes:[{number:1,context:'',assetKeys:['CH01']}]};
  await prisma.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FOUNDATION_DOCUMENT',content:JSON.stringify(doc)}});await prompts.saveAssetPrompt(project.id,'CH01',0,'人工已锁定：灰衣、布鞋。');
  const state=(await adoptions.readAssetDesignAdoptions(project.id,user.id)).assets.CH01;await adoptions.adoptAssetDesign(project.id,user.id,{assetKey:'CH01',expectedRevision:state.revision,expectedMaterialToken:state.materialToken,brief:'灰衣、布鞋。',referenceIds:[]});
  const episode=await prisma.episode.findFirstOrThrow({where:{projectId:project.id,number:1}}),scope={workflowId:'flow',runId:'run'},base=await handoffs.readProductionEpisodeHandoff(project.id,1),entry=base.packet.standardScript!.script.entries.find(e=>e.target==='BODY')!,sourceVersion=(await loadFoundationInputs(project.id)).sourceVersion;
  const need=(requestId:string,packageId:string,purpose:string)=>({...scope,requestId,needRef:`${requestId}:0`,episodeNumber:1,sourceVersion,target:'CH01',purpose,sourceRefs:[`${episode.id}:${entry.id}`],packageIds:[packageId],blocking:true});
  const a=need('request-a','p1','补袖口磨损外观'),b=need('request-b','p3','补鞋底泥痕外观');let calls=0;
  const runner=async(request:any)=>{calls++;const sent=JSON.parse(request.prompt),n=sent.materialNeeds[0],data={assetKey:'CH01',brief:n.needRef===a.needRef?'灰衣袖口沿用锁定造型，仅按原文保留磨损绣线。':'布鞋沿用锁定造型，仅按原文保留鞋底泥痕。',answeredNeedRefs:[n.needRef],limitations:[]};return {data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null};};
  const prepared=async()=>splitProductionMaterials(makeEpisodeInput({episode,project,handoff:await handoffs.readProductionEpisodeHandoff(project.id,1,scope),inputProtocol:'upstream-material-v2'}));
  await prompts.generateAssetPromptsForEpisodes(project.id,[1],{assetKeys:['CH01'],materialNeeds:[a],runner} as any);const first=await prepared(),plan={productionFeedback:{usedMaterialIds:['asset:CH01'],needs:[]}},firstP1=selectProductionMaterials(first.materials,'author',plan,['p1']),candidateA=firstP1.find((m:any)=>m.kind==='ASSET_MATERIAL_CANDIDATE');assert.ok(candidateA);
  await prompts.generateAssetPromptsForEpisodes(project.id,[1],{assetKeys:['CH01'],materialNeeds:[b],runner} as any);
  const kept=await candidates.readScopedAssetMaterialCandidates(project.id,{...scope,episodeNumber:1,sourceVersion},['CH01'],await prompts.loadAssetPromptWorkspace(project.id));
  assert.deepEqual(kept.flatMap(c=>c.needs.map(n=>n.needRef)).sort(),[a.needRef,b.needRef],'a later p3 candidate must not remove the already-consumed p1 candidate');
  const second=await prepared();assert.equal(first.sourceBasisVersion,second.sourceBasisVersion);assert.deepEqual(selectProductionMaterials(second.materials,'author',plan,['p1']),firstP1,'unrelated p3 material leaves p1 payload and versions byte-identical');assert.deepEqual(changedConsumedMaterials(firstP1,second.materials,firstP1.map((m:any)=>m.id)),[]);
  const p3=selectProductionMaterials(second.materials,'author',plan,['p3']);assert.equal(p3.filter((m:any)=>m.kind==='ASSET_MATERIAL_CANDIDATE').length,1);assert.equal(p3[1].value.needs[0].needRef,b.needRef);assert.deepEqual(selectProductionMaterials(second.materials,'author',plan,['p2']).map((m:any)=>m.id),['asset:CH01']);
  const card=(await handoffs.readProductionEpisodeHandoff(project.id,1,scope)).packet.upstream.assetProductionCards[0] as any;assert.equal(card.candidateDesigns.length,2);assert.equal(card.candidateDesign,undefined,'new cards do not duplicate the legacy singleton');assert.equal(card.adoptedDesign.brief,'灰衣、布鞋。');
  const row=await prisma.sceneSnapshot.findUniqueOrThrow({where:{id:candidateA.value.version}}),old=JSON.parse(row.content),replacement={...old,id:'candidate-a-v2',brief:'灰衣袖口仅修正绣线磨损方向。',createdAt:'2026-10-01T01:00:01Z'};
  await prisma.sceneSnapshot.create({data:{id:replacement.id,projectId:project.id,sceneKey:'ASSET_MATERIAL_CANDIDATE_V1',title:'CH01',content:JSON.stringify(replacement),createdAt:new Date(Date.now()+1000)}});
  const third=await prepared(),nextP1=selectProductionMaterials(third.materials,'author',plan,['p1']);assert.equal(nextP1[1].id,candidateA.id,'same need keeps a stable dependency ID');assert.deepEqual(changedConsumedMaterials(firstP1,third.materials,firstP1.map((m:any)=>m.id)),[candidateA.id]);assert.deepEqual(selectProductionMaterials(third.materials,'author',plan,['p3']),p3,'a genuine p1 replacement does not invalidate p3');assert.ok(await prisma.sceneSnapshot.findUnique({where:{id:old.id}}),'old saved candidate history is not deleted');
  assert.equal(calls,2,'two explicit needs use only their injected fake calls; no merge call');assert.equal((await prompts.loadAssetPromptWorkspace(project.id)).records.CH01.body,'人工已锁定：灰衣、布鞋。');assert.equal((await adoptions.readAssetDesignAdoptions(project.id,user.id)).assets.CH01.status,'TEXT_ADOPTED');
  console.log('PASS isolated real-function A:p1 -> B:p3 retention, independent package payload/version, same-need replacement only, old history and adopted/manual design retained; real model calls 0');
 }finally{await prisma.$disconnect();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
