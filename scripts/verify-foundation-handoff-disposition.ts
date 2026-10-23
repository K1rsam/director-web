/** Explicit free maintenance keeps current dispositions and historical Q1 opinions distinct. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PrismaClient} from '@prisma/client';
import type {RoleRunResult} from '../lib/role-runner';

async function main(){
 const dir=mkdtempSync(path.join(tmpdir(),'foundation-handoff-disposition-')),url=`file:${dir}/test.db`;
 process.env.DATABASE_URL=url;process.env.CODEX_CLI_PATH='/disabled/offline';process.env.DEEPSEEK_API_KEY='';
 copyFileSync('prisma/schema.prisma',`${dir}/schema.prisma`);
 execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${dir}/schema.prisma`,'--skip-generate'],{env:{...process.env,RUST_LOG:'info'},stdio:'pipe',timeout:30000});
 const db=new PrismaClient({datasourceUrl:url});
 try{
  const {queueFoundationDelivery,executeFoundationDelivery,getFoundationDeliveryState,previewFoundationProgramRepair,applyFoundationProgramRepair}=await import('../lib/foundation-delivery');
  const {saveFoundationDocument}=await import('../lib/foundation-document');
  const {buildLightEpisodePackets}=await import('../lib/light-foundation-supply');
  const project=await db.project.create({data:{title:'offline independent material handoff',episodes:{create:[1,2].map(number=>({number,content:`第${number}集\n${number}-1 日 内 船舱\n人物：林岚\n林岚：到了。\n`}))}}});
  const task=await queueFoundationDelivery(project.id,{},db);let calls=0;
  await executeFoundationDelivery(project.id,task.id,{db,stageRunner:async(stage,prompt)=>{
   calls++;const input=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
   const data=stage==='F2'?{format:'ASSET_CATALOG_V2',coverage:input.scope,assets:[]}:{format:'FOUNDATION_OPTIMIZATION_V2',coverage:input.scope,changes:{}};
   return {data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null} as RoleRunResult;
  }});
  const before=await getFoundationDeliveryState(project.id,db),oldNote='原素材关系未证实，历史意见保留UNRESOLVED，不猜fromKey。';
  let stored=await saveFoundationDocument(db,project.id,before.document.revision,{...before.document,editorialTodos:[{id:'source-relation-unknown',owner:'Q1',episodes:[1,2],note:oldNote,applicationScope:{kind:'EPISODES',episodes:[1,2]}}]},'offline test fixture');
  const runs=await db.pipelineRun.findMany({where:{projectId:project.id},orderBy:{id:'asc'}}),source=await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}});
  const note='已按明确选择独立准备素材；历史剧情关系仍未知，不要求猜填旧素材来源。';
  const correction=(value:unknown,scope=[1,2])=>({expectedRevision:stored.revision,scope,output:{format:'FOUNDATION_OPTIMIZATION_V2',coverage:scope,changes:{}},defer:[{id:'source-relation-unknown',episodes:[1,2],note:value}]} as any);
  for(const applicationScope of [{kind:'SCENES',scenes:[{episode:1,sceneKey:'1-1'},{episode:2,sceneKey:'2-1'}]},{kind:'UNRESOLVED'}]){
   stored=await saveFoundationDocument(db,project.id,stored.revision,{...stored,editorialTodos:[{...stored.editorialTodos[0],episodes:[1],applicationScope}] as any},'offline mismatched legacy scope fixture');
   const partial=correction(note,[1]);partial.defer[0].episodes=[1];
   await assert.rejects(previewFoundationProgramRepair(project.id,partial,db),/范围|覆盖/,'authoritative scope cannot be hidden by narrower legacy episodes');
  }
  stored=await saveFoundationDocument(db,project.id,stored.revision,{...stored,editorialTodos:[{...stored.editorialTodos[0],episodes:[1,2],applicationScope:{kind:'EPISODES',episodes:[1,2]}}]},'offline test fixture restored');
  for(const bad of ['', '   ', null, false, 3])await assert.rejects(previewFoundationProgramRepair(project.id,correction(bad),db),/处置|说明|文本/);
  await assert.rejects(previewFoundationProgramRepair(project.id,correction(note,[1]),db),/范围|覆盖/);
  const taskRow=await db.sceneSnapshot.findFirstOrThrow({where:{projectId:project.id,id:{startsWith:'foundation-delivery-'}}});
  const stoppedContent=JSON.stringify({...JSON.parse(taskRow.content),status:'STOPPED',message:'User paused; do not override.'});
  await db.sceneSnapshot.update({where:{id:taskRow.id},data:{content:stoppedContent}});
  const stoppedCount=await db.sceneSnapshot.count({where:{projectId:project.id}});
  for(const operation of [previewFoundationProgramRepair,applyFoundationProgramRepair])await assert.rejects(operation(project.id,correction(note),db),/手动|停止|暂停/,'free maintenance must not override a manual stop');
  assert.equal((await db.sceneSnapshot.findUniqueOrThrow({where:{id:taskRow.id}})).content,stoppedContent);
  assert.equal(await db.sceneSnapshot.count({where:{projectId:project.id}}),stoppedCount,'stopped preview and application make zero writes');
  await db.sceneSnapshot.update({where:{id:taskRow.id},data:{content:taskRow.content}});
  const preview=await previewFoundationProgramRepair(project.id,correction(note),db),next=preview.document.editorialTodos[0];
  assert.equal(next.owner,'STAGE2');assert.ok(next.note.startsWith(`本次交接处置：${note}`));
  assert.ok(next.note.includes(`历史Q1意见（保留，不作为当前阻断）：${oldNote}`));
  assert.equal((await getFoundationDeliveryState(project.id,db)).document.revision,stored.revision,'preview is read-only');
  const after=await applyFoundationProgramRepair(project.id,correction(note),db);
  assert.equal(after.complete,true);assert.equal(calls,2);
  const packets=await buildLightEpisodePackets(project.id,after.document,db);
  assert.ok(packets.every(packet=>packet.followUps[0].note===next.note),'per-item disposition reaches actual handoff');
  assert.deepEqual(await db.pipelineRun.findMany({where:{projectId:project.id},orderBy:{id:'asc'}}),runs);
  assert.deepEqual(await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}}),source);
  const old=await db.sceneSnapshot.findFirstOrThrow({where:{projectId:project.id,sceneKey:'FOUNDATION_DOCUMENT',content:{contains:stored.revision}}});
  assert.equal(JSON.parse(old.content).editorialTodos[0].note,oldNote);
  await assert.rejects(applyFoundationProgramRepair(project.id,correction(note),db),/revision/);
  console.log('PASS explicit handoff disposition, unchanged historical note/source/paid runs, scoped preview/apply and actual supply');
 }finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true});}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
