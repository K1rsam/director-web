import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import type {FidelityDecision} from '../lib/fidelity-import';
import {planP1ReviewBatches,type P1ReviewState} from '../lib/fidelity-p1-review';
const raw='第1集\r\n1-1 日 外 广场\r\n甲乙：交出信封。😀\r\n第2集\r\n2-1 夜 内 客厅\r\n甲乙：收到信封。\r\n';
const merge:FidelityDecision[]=[{start:0,end:raw.length,kind:'body',episodeNumber:1,sceneNumber:1,note:'离线声明合并范围'}];
const context:FidelityDecision[]=[{start:raw.indexOf('第2集'),end:raw.length,kind:'context',note:'离线声明为资料，原文完整保留'}];
async function main(){
 const dir=mkdtempSync(path.join(tmpdir(),'derived-episode-refresh-')),url=`file:${dir}/test.db`;process.env.DATABASE_URL=url;
 copyFileSync('prisma/schema.prisma',`${dir}/schema.prisma`);execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${dir}/schema.prisma`,'--skip-generate'],{env:{...process.env,RUST_LOG:'info'},stdio:'pipe'});
 const db=new PrismaClient({datasourceUrl:url});
 const {prepareFidelityImport}=await import('../lib/fidelity-import');const {refreshFidelitySource}=await import('../lib/fidelity-refresh');const {readFidelityReceipt}=await import('../lib/fidelity-store');const {preprocessProject}=await import('../lib/project-preprocess');
 const setup=async(title:string,decisions:FidelityDecision[]=[])=>{
  const prepared=await prepareFidelityImport('derived.txt',Buffer.from(raw),'fidelity',decisions);
  const project=await db.project.create({data:{title,episodes:{create:prepared.imported.episodes}}});
  const source=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(prepared.imported),metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'})}});
  prepared.receipt.sourceImportId=source.id;
  const receipt=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify(prepared.receipt)}});
  await preprocessProject(project.id,db);
  return {project,source,receipt,episodes:await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}})};
 };
 const refresh=(id:string,decisions:FidelityDecision[])=>refreshFidelitySource(id,db,{decisions,checkCurrent:async()=>{}});
 try{
  // Exercise the actual paid-checkpoint receiver, not only its refresh helper.
  const paid=await setup('paid P1 checkpoint materializes fewer episodes');
  const paidReceipt=JSON.parse(paid.receipt.content);
  const paidState:P1ReviewState={status:'PENDING',reviewedSourceVersion:paidReceipt.readingHash,
   completedRanges:planP1ReviewBatches(raw).map(blocks=>({start:blocks[0].start,end:blocks.at(-1)!.end})),
   runIds:['already-paid-full-review'],pendingDecisions:context,unresolved:[]};
  const checkpoint=await db.sceneSnapshot.create({data:{projectId:paid.project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify({...paidReceipt,p1Review:paidState})}});
  const {prepareFidelitySourceAssisted}=await import('../lib/fidelity-source-assist');
  const {loadFoundationInputs}=await import('../lib/foundation-state');
  let calls=0;
  const resume=()=>prepareFidelitySourceAssisted(paid.project.id,db,{checkCurrent:async()=>{},assist:async()=>{calls++;throw new Error('Completed paid review must not be repurchased');}});
  const received=await resume();assert.equal(received.backendPending,undefined);assert.equal(received.episodeCount,1);assert.equal(calls,0);
  const receivedReceipt=(await readFidelityReceipt(paid.project.id,db))!;
  assert.equal(receivedReceipt.receipt.p1Review?.status,'COMPLETE');
  assert.deepEqual(receivedReceipt.receipt.p1Review?.runIds,paidState.runIds);
  assert.deepEqual(receivedReceipt.receipt.p1Review?.completedRanges,paidState.completedRanges);
  assert.deepEqual(receivedReceipt.receipt.p1Review?.pendingDecisions,[]);
  assert.equal(receivedReceipt.receipt.result.source.text,raw);
  assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:checkpoint.id}}),checkpoint);
  assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:paid.source.id}}),paid.source);
  const inputs=await loadFoundationInputs(paid.project.id,db);
  assert.equal(inputs.project.episodes.length,1);assert.equal(inputs.sourceIndex.episodes.length,1);
  assert.equal(inputs.project.episodes[0].id,paid.episodes[0].id);
  assert.equal(inputs.project.episodes[0].content,paid.episodes[0].content);
  assert.equal(await db.episode.count({where:{id:paid.episodes[1].id}}),0);
  const paidSnapshotCount=await db.sceneSnapshot.count({where:{projectId:paid.project.id}});
  assert.equal((await resume()).assisted,false);assert.equal(calls,0);
  assert.deepEqual(await refreshFidelitySource(paid.project.id,db,{decisions:receivedReceipt.receipt.decisions,p1Review:receivedReceipt.receipt.p1Review,checkCurrent:async()=>{}}),{changed:false});
  assert.equal(await db.sceneSnapshot.count({where:{projectId:paid.project.id}}),paidSnapshotCount);
  for(const [name,oldDecisions,newDecisions,expected] of [['merge',[],merge,1],['split',merge,[],2],['body-to-context',[],context,1]] as const){
   const fixture=await setup(name,[...oldDecisions]);
   assert.equal((await refresh(fixture.project.id,[...newDecisions])).changed,true);
   assert.equal(await db.episode.count({where:{projectId:fixture.project.id}}),expected);
   const current=(await readFidelityReceipt(fixture.project.id,db))!;
   assert.equal(current.receipt.result.source.text,raw);assert.equal(current.receipt.result.segments.map(row=>row.text).join(''),raw);
   assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:fixture.source.id}}),fixture.source);
   assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:fixture.receipt.id}}),fixture.receipt);
   const archives=await db.sceneSnapshot.findMany({where:{projectId:fixture.project.id,sceneKey:{startsWith:'RETIRED_FIDELITY_EPISODE-'}}});
   assert(archives.length>0);assert(archives.every(row=>row.episodeId===null));
   const count=await db.sceneSnapshot.count({where:{projectId:fixture.project.id}});
   assert.deepEqual(await refresh(fixture.project.id,[...newDecisions]),{changed:false});
   assert.equal(await db.sceneSnapshot.count({where:{projectId:fixture.project.id}}),count);
  }
  const historical=await setup('linked derived scene history');
  const old=historical.episodes[1],scene=await db.scriptScene.findFirstOrThrow({where:{episodeId:old.id}});
  const retiredScene=await db.sceneSnapshot.create({data:{projectId:historical.project.id,episodeId:old.id,sceneKey:'RETIRED_P0_SCENE-old-key',content:scene.sourceText,metadata:JSON.stringify({schema:'RETIRED_P0_SCENE_V1',sceneKey:'old-key',metadata:{sourceHash:createHash('sha256').update(scene.sourceText).digest('hex'),characters:[],props:[]}})}});
  await refresh(historical.project.id,context);
  assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:retiredScene.id}}),{...retiredScene,episodeId:null});
  const archive=await db.sceneSnapshot.findFirstOrThrow({where:{projectId:historical.project.id,sceneKey:`RETIRED_FIDELITY_EPISODE-${old.id}`}});
  assert.deepEqual(JSON.parse(archive.content).derivedHistory.map((row:{id:string;episodeId:string})=>[row.id,row.episodeId]),[[retiredScene.id,old.id]]);
  await refresh(historical.project.id,[]); // Reintroduce body from the same pinned original.
  assert.equal(await db.episode.count({where:{projectId:historical.project.id}}),2);
  assert.deepEqual(await refresh(historical.project.id,[]),{changed:false});
  for(const kind of ['manual-content','manual-title','manual-weather','task','workflow','linked-snapshot','session'] as const){
   const fixture=await setup(`protect ${kind}`),old=fixture.episodes[1];
   if(kind==='manual-content')await db.episode.update({where:{id:old.id},data:{content:old.content+'人工补充'}});
   if(kind==='manual-title')await db.episode.update({where:{id:old.id},data:{title:'人工标题'}});
   if(kind==='manual-weather')await db.scriptScene.updateMany({where:{episodeId:old.id},data:{weather:'人工雨景'}});
   if(kind==='task')await db.taskPackage.create({data:{projectId:fixture.project.id,episodeId:old.id,title:'已有制作包'}});
   if(kind==='workflow')await db.workflowIssue.create({data:{projectId:fixture.project.id,episodeId:old.id,coordinate:'scene',code:'TEST',severity:'MAJOR',ownerRole:'Q1',expected:'保留',evidence:'已有数据',requestedEffect:'保留',revision:'1'}});
   if(kind==='linked-snapshot')await db.sceneSnapshot.create({data:{projectId:fixture.project.id,episodeId:old.id,sceneKey:'MANUAL',content:'人工快照'}});
   if(kind==='session')await db.cliRoleSession.create({data:{projectId:fixture.project.id,episodeId:old.id,stageCode:'Q1',sessionId:'offline',model:'offline',reasoningEffort:'low'}});
   const beforeEpisodes=await db.episode.findMany({where:{projectId:fixture.project.id}}),beforeScenes=await db.scriptScene.findMany({where:{episode:{projectId:fixture.project.id}}}),beforeSnapshots=await db.sceneSnapshot.findMany({where:{projectId:fixture.project.id}});
   await assert.rejects(refresh(fixture.project.id,context),/人工|制作/);
   assert.deepEqual(await db.episode.findMany({where:{projectId:fixture.project.id}}),beforeEpisodes);assert.deepEqual(await db.scriptScene.findMany({where:{episode:{projectId:fixture.project.id}}}),beforeScenes);assert.deepEqual(await db.sceneSnapshot.findMany({where:{projectId:fixture.project.id}}),beforeSnapshots);
  }
  assert.equal(await db.pipelineRun.count(),0);
  console.log('PASS derived merge/split/context retirement and repeat refresh; archived P0 history survives FK retirement; manual fields and downstream dependencies reject atomically; zero AI');
 }finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:200});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
