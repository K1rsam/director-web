import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createRequire} from 'node:module';

async function main(){
 const file=path.join(mkdtempSync(path.join(tmpdir(),'asset-need-candidates-')),'test.db'),db=new DatabaseSync(file);
 for(const migration of readdirSync('prisma/migrations').sort())if(/^\d/.test(migration))db.exec(readFileSync(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));db.close();process.env.DATABASE_URL=`file:${file}`;
 const {prisma}=await import('../lib/prisma'),{loadFoundationInputs}=await import('../lib/foundation-state'),{createEmptyDocument}=await import('../lib/foundation-document'),prompts=await import('../lib/asset-prompt-service'),handoffs=await import('../lib/episode-upstream-material'),adoptions=await import('../lib/asset-design-adoption'),candidates=await import('../lib/asset-material-candidates');
 try{
  const user=await prisma.user.create({data:{username:'candidate-tester',email:'candidate@synthetic.invalid',passwordHash:'fixture'}});
  const project=await prisma.project.create({data:{title:'局部材料合成样本',roles:{create:{userId:user.id,role:'ADMIN'}},episodes:{create:[{number:1,content:'1-1 仓库 日 内\n△仓库铁门反锁，固定货架后留出通路。'},{number:2,content:'2-1 宫殿 夜 外\n△未来秘密宫殿出现。'}]}}});
  const doc=createEmptyDocument(await loadFoundationInputs(project.id));doc.f2={format:'ASSET_CATALOG_V1',coverage:[1,2],issues:[],assets:[{key:'warehouse',name:'仓库',type:'LOC',aliases:[],description:'',sourceRefs:[],appearances:[],usageEpisodes:[1],variants:[],preparation:{mode:'REFERENCE'}},{key:'palace',name:'未来秘密宫殿',type:'LOC',aliases:[],description:'',sourceRefs:[],appearances:[],usageEpisodes:[2],variants:[],preparation:{mode:'REFERENCE'}}],episodes:[{number:1,context:'',assetKeys:['warehouse']},{number:2,context:'',assetKeys:['palace']}]};
  await prisma.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FOUNDATION_DOCUMENT',content:JSON.stringify(doc)}});
  await prompts.saveAssetPrompt(project.id,'warehouse',0,'人工已锁定：灰墙铁门，固定货架。');
  const state=(await adoptions.readAssetDesignAdoptions(project.id,user.id)).assets.warehouse;
  await adoptions.adoptAssetDesign(project.id,user.id,{assetKey:'warehouse',expectedRevision:state.revision,expectedMaterialToken:state.materialToken,brief:'灰墙铁门，固定货架。',referenceIds:[]});
  const episode=await prisma.episode.findFirstOrThrow({where:{projectId:project.id,number:1}}),base=await handoffs.readProductionEpisodeHandoff(project.id,1),entry=base.packet.standardScript!.script.entries.find(e=>e.target==='BODY')!;
  const need={workflowId:'flow-1',requestId:'request-1',needRef:'request-1:0',runId:'run-1',episodeNumber:1,sourceVersion:(await loadFoundationInputs(project.id)).sourceVersion,target:'warehouse',purpose:'补充门和通路对动作的功能说明',sourceRefs:[`${episode.id}:${entry.id}`],packageIds:['P1'],blocking:true};
  let calls=0;const runner=async(input:any)=>{calls++;const sent=JSON.parse(input.prompt);assert.ok(!input.prompt.includes('未来秘密宫殿'),'future sources never enter a local material request');assert.deepEqual(sent.materialNeeds.map((n:any)=>n.needRef),['request-1:0']);assert.ok(sent.sourceEvidence.some((e:any)=>e.text.includes('铁门反锁')));const data={assetKey:'warehouse',brief:'沿用灰墙铁门和固定货架。原文铁门反锁，货架后留通路；不新增出口或推定门开启。',answeredNeedRefs:['request-1:0'],limitations:['门开启方向原文未说明。']};return {data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null};};
  const result=await prompts.generateAssetPromptsForEpisodes(project.id,[1],{assetKeys:['warehouse'],materialNeeds:[need],runner} as any);
  assert.equal(calls,1,'one focused request even when an existing READY prompt exists');assert.equal(result.results[0]?.status,'READY');
  assert.equal((await prompts.loadAssetPromptWorkspace(project.id)).records.warehouse.body,'人工已锁定：灰墙铁门，固定货架。');assert.equal((await adoptions.readAssetDesignAdoptions(project.id,user.id)).assets.warehouse.status,'TEXT_ADOPTED','scoped candidates never invalidate global adoption');
  const scoped=await (handoffs.readProductionEpisodeHandoff as any)(project.id,1,{workflowId:'flow-1',runId:'run-1'}),card=scoped.packet.upstream.assetProductionCards.find((c:any)=>c.assetKey==='warehouse');
  assert.equal(card.candidateDesigns?.[0].provenance,'CANDIDATE_ONLY');assert.equal(card.candidateDesigns[0].scope.runId,'run-1');assert.equal(card.adoptedDesign.brief,'灰墙铁门，固定货架。');assert.ok(card.candidateDesigns[0].needs[0].packageIds.includes('P1'));assert.equal(card.use,'ACTUAL_APPEARANCE');
  const {makeEpisodeInput}=createRequire(import.meta.url)('../runtime/storyboard-v4/input.mjs');const input=makeEpisodeInput({episode,project,handoff:scoped,inputProtocol:'upstream-material-v2'});assert.equal(input.source.context.assetProductionCards[0].candidateDesigns[0].scope.runId,'run-1','real standard-source input retains the scoped candidate');
  for(const scope of [undefined,{workflowId:'other',runId:'run-1'},{workflowId:'flow-1',runId:'other'}])assert.ok(!(await (handoffs.readProductionEpisodeHandoff as any)(project.id,1,scope)).packet.upstream.assetProductionCards.some((c:any)=>c.candidateDesign||c.candidateDesigns?.length));
  await prompts.generateAssetPromptsForEpisodes(project.id,[1],{assetKeys:['warehouse'],materialNeeds:[need],runner} as any);assert.equal(calls,1,'the same need reuses its saved candidate, never pays twice');
  for(const change of [{target:'palace'},{episodeNumber:2},{sourceVersion:'old-source'},{sourceRefs:['unbound-node']}])await assert.rejects(()=>prompts.generateAssetPromptsForEpisodes(project.id,[1],{assetKeys:['warehouse'],materialNeeds:[{...need,...change}],runner} as any));
  assert.equal(calls,1,'scope/provenance failures stop before calling the model');
  const receipts=await candidates.readScopedMaterialCandidateReceipt(project.id,'flow-1',['request-1']);assert.equal(receipts[0].status,'READY');assert.deepEqual(receipts[0].needRefs,['request-1:0']);assert.deepEqual(await candidates.readScopedMaterialCandidateReceipt(project.id,'other',['request-1']),[]);
  assert.deepEqual(await candidates.readScopedAssetMaterialCandidates(project.id,{workflowId:'flow-1',runId:'run-1',episodeNumber:0,sourceVersion:need.sourceVersion},[],await prompts.loadAssetPromptWorkspace(project.id)),[],'a real source-scoped zero episode is not rejected by the material reader');
  const longNeed={...need,requestId:'request-long',needRef:'request-long:0'},longBrief='门'.repeat(601);
  const tooLong=await prompts.generateAssetPromptsForEpisodes(project.id,[1],{assetKeys:['warehouse'],materialNeeds:[longNeed],runner:async()=>{const data={assetKey:'warehouse',brief:longBrief,answeredNeedRefs:[longNeed.needRef],limitations:[]};return {data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null};}} as any);
  assert.equal(tooLong.results[0].status,'FAILED');assert.ok(tooLong.results[0].rawOutput?.includes(longBrief),'oversized useful response is retained, never mechanically truncated');
  assert.equal((await candidates.readScopedMaterialCandidateReceipt(project.id,'flow-1',['request-long']))[0].status,'FAILED');
  await prisma.episode.update({where:{id:episode.id},data:{content:episode.content+'\n△货架的位置已经变化。'}});
  assert.ok(!(await (handoffs.readProductionEpisodeHandoff as any)(project.id,1,{workflowId:'flow-1',runId:'run-1'})).packet.upstream.assetProductionCards.some((c:any)=>c.candidateDesign||c.candidateDesigns?.length),'changed source excludes old scoped candidates');
  console.log('PASS scoped material candidate: exact needs/evidence, one fake call/cache, no global or manual overwrite/adoption change, current run only, no future/old scope, source change withheld');
 }finally{await prisma.$disconnect();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
