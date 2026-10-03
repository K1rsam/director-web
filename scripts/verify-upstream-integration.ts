import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';

async function main(){
 const directory=mkdtempSync(path.join(tmpdir(),'upstream-integration-')),file=path.join(directory,'test.db');
 const sql=new DatabaseSync(file);
 for(const migration of readdirSync('prisma/migrations').sort())if(/^\d/.test(migration))sql.exec(readFileSync(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();process.env.DATABASE_URL=`file:${file}`;
 const {prisma}=await import('../lib/prisma');
 const {loadFoundationInputs}=await import('../lib/foundation-state');
 const {createEmptyDocument}=await import('../lib/foundation-document');
 const {loadAssetPromptWorkspace,saveAssetPrompt}=await import('../lib/asset-prompt-service');
 const {readAssetDesignAdoptions,adoptAssetDesign}=await import('../lib/asset-design-adoption');
 const {getSeriesDirectionWorkspace,mutateSeriesDirection}=await import('../lib/series-direction-service');
 const {readProductionEpisodeHandoff}=await import('../lib/episode-upstream-material');
 const {makeEpisodeInput}=createRequire(import.meta.url)('../runtime/storyboard-v4/input.mjs');
 try{
  const user=await prisma.user.create({data:{username:'upstream-test',email:'upstream@synthetic.invalid',passwordHash:'not-a-real-login'}});
  const project=await prisma.project.create({data:{title:'隔离两集整合样本',roles:{create:{userId:user.id,role:'ADMIN'}},episodes:{create:[{number:1,content:'第一集\n1-1 屋内 日 内\n人物：甲\n△甲穿着白衣。\n甲：我会等你。'},{number:2,content:'第二集\n2-1 石桥 夜 外\n△石桥上空无一人。'}]}}});
  const episodes=await prisma.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}}),raw=episodes.map(e=>e.content);
  const doc=createEmptyDocument(await loadFoundationInputs(project.id));
  doc.f2={format:'ASSET_CATALOG_V1',coverage:[1,2],issues:[],assets:[
   {key:'hero',name:'甲',type:'CH',aliases:[],description:'',sourceRefs:[],appearances:[],usageEpisodes:[1],variants:[]},
   {key:'bridge',name:'石桥',type:'LOC',aliases:[],description:'',sourceRefs:[],appearances:[],usageEpisodes:[2],variants:[]}
  ],episodes:[{number:1,context:'',assetKeys:['hero']},{number:2,context:'',assetKeys:['bridge']}]};
  await prisma.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FOUNDATION_DOCUMENT',content:JSON.stringify(doc)}});
  await saveAssetPrompt(project.id,'hero',0,'白衣黑发。完整提示词只保存在第二阶段。');
  await saveAssetPrompt(project.id,'bridge',0,'灰色石拱桥。');
  const adopt=async(key:string,brief:string)=>{const state=(await readAssetDesignAdoptions(project.id,user.id)).assets[key];return adoptAssetDesign(project.id,user.id,{assetKey:key,expectedRevision:state.revision,expectedMaterialToken:state.materialToken,brief,referenceIds:[]});};
  await adopt('hero','白衣黑发，神情克制。');
  let h1=await readProductionEpisodeHandoff(project.id,1);
  assert.equal(h1.packet.upstream.seriesDirection.status,'UNCONFIRMED');
  assert.equal(h1.packet.upstream.modelDesigns[0].assetKey,'hero');
  assert(!JSON.stringify(h1).includes('完整提示词只保存在第二阶段'));
  let direction=await getSeriesDirectionWorkspace(project.id,user.id);
  const content={settingTags:[],mechanismTags:[],arcTags:['关系成长'],primaryTone:'克制温情',secondaryTones:[],audiencePromise:'等待与信任。',expressionRules:['情感通过行动与反应呈现。'],avoidances:[],episodeFlexibility:'事实和揭示时点优先。'};
  direction=await mutateSeriesDirection(project.id,user.id,{action:'save',stateToken:direction.stateToken,sourceVersion:direction.source.sourceVersion,content,coverageAcknowledged:true});
  assert.equal((await loadAssetPromptWorkspace(project.id)).seriesDirection!.status,'UNCONFIRMED');
  direction=await mutateSeriesDirection(project.id,user.id,{action:'confirm',stateToken:direction.stateToken,sourceVersion:direction.source.sourceVersion,draftHash:direction.draft!.hash,coverageAcknowledged:true});
  const current=await loadAssetPromptWorkspace(project.id);
  assert.equal(current.seriesDirection!.brief,direction.brief);
  assert.equal((await readAssetDesignAdoptions(project.id,user.id)).assets.hero.status,'STALE','new confirmed direction requires review, never auto-regenerates');
  assert.equal((await readProductionEpisodeHandoff(project.id,1)).packet.upstream.modelDesigns.length,0);
  await saveAssetPrompt(project.id,'hero',current.records.hero.revision,current.records.hero.body);
  await adopt('hero','白衣黑发，神情克制。');
  h1=await readProductionEpisodeHandoff(project.id,1);
  const h2=await readProductionEpisodeHandoff(project.id,2);
  assert.equal(h1.packet.upstream.seriesDirection.projection!.brief,h2.packet.upstream.seriesDirection.projection!.brief);
  assert(!h2.packet.upstream.modelDesigns.some(d=>d.assetKey==='hero'));
  const prepare=(handoff:typeof h1)=>makeEpisodeInput({episode:{...episodes[0],project},project,handoff,inputProtocol:'upstream-material-v2'});
  const first=prepare(h1);
  assert.equal(first.source.diagnostics.length,0);
  assert.equal(first.source.context.seriesDirection.brief,direction.brief);
  assert.equal(first.source.context.modelDesigns[0].brief,'白衣黑发，神情克制。');
  await saveAssetPrompt(project.id,'bridge',1,'灰色石拱桥，栏杆略有风化。');
  await adopt('bridge','灰色石拱桥，栏杆略有风化。');
  assert.equal(prepare(await readProductionEpisodeHandoff(project.id,1)).sourceVersion,first.sourceVersion,'unrelated adopted asset cannot stale this episode');
  direction=await mutateSeriesDirection(project.id,user.id,{action:'save',stateToken:direction.stateToken,sourceVersion:direction.source.sourceVersion,content:{...content,primaryTone:'未确认的新主调'},coverageAcknowledged:true});
  assert.equal(prepare(await readProductionEpisodeHandoff(project.id,1)).sourceVersion,first.sourceVersion,'a new draft is not the adopted series direction');
  await adopt('hero','白衣黑发，衣袖为窄袖。');
  const changed=await readProductionEpisodeHandoff(project.id,1);
  assert.notEqual(changed.materialVersion,h1.materialVersion);
  assert.notEqual(prepare(changed).sourceVersion,first.sourceVersion,'actual adopted material changes bind new production work');
  assert.deepEqual((await prisma.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}})).map(e=>e.content),raw);
  assert.equal(await prisma.pipelineRun.count({where:{projectId:project.id}}),0,'reads and human decisions never call a model');
  console.log('PASS isolated two-episode integration: canonical text unchanged, confirmed direction -> design stale/review/adopt -> scoped handoff -> native stage3 input; draft/unrelated asset stable; relevant adoption invalidates; model calls 0');
 }finally{await prisma.$disconnect();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
