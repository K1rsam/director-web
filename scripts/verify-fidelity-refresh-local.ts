import assert from 'node:assert/strict';
import { PrismaClient } from '@prisma/client';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
async function main(){
 const directory=mkdtempSync(path.join(tmpdir(),'fidelity-refresh-'));
 const file=path.join(directory,'test.db').replaceAll('\\','/');
 const sourceDb=new PrismaClient();
 await sourceDb.$executeRawUnsafe(`VACUUM INTO '${file.replaceAll("'","''")}'`);await sourceDb.$disconnect();
 const db=new PrismaClient({datasourceUrl:`file:${file}`});
 try{
  const {queueFoundationDelivery,executeFoundationDelivery,getFoundationDeliveryState}=await import('../lib/foundation-delivery');
  const project=await db.project.findFirstOrThrow({where:{title:'神兽1'}});
  const before=await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}});
  const {refreshFidelitySource}=await import('../lib/fidelity-refresh');
  await refreshFidelitySource(project.id,db);
  const taskRow=await db.sceneSnapshot.findUniqueOrThrow({where:{id:'foundation-delivery-'+project.id}});
  const history=JSON.parse(taskRow.content);
  const oldMessage='保真来源仍有待确认边界或读取问题，请在来源与清洗页面明确范围后继续；不会让旧F1自动重分原稿。';
  history.status='WAITING_USER';history.message=oldMessage;history.unknownOutcome=false;
  await db.sceneSnapshot.update({where:{id:taskRow.id},data:{content:JSON.stringify(history)}});
  const shown=await getFoundationDeliveryState(project.id,db);
  assert.equal(shown.action,'START');assert.equal(shown.busy,false);assert(shown.task?.message.includes('来源已重新识别'));
  assert.equal(JSON.parse((await db.sceneSnapshot.findUniqueOrThrow({where:{id:taskRow.id}})).content).message,oldMessage,'read display must not overwrite historical stop evidence');
  history.message='已尝试判断来源，仍有 1 项缺少依据，请在来源页面一次确认对应范围。';
  await db.sceneSnapshot.update({where:{id:taskRow.id},data:{content:JSON.stringify(history)}});
  assert.equal((await getFoundationDeliveryState(project.id,db)).task?.message,history.message,'genuine current source decisions must not be relabeled');
  history.message=oldMessage;await db.sceneSnapshot.update({where:{id:taskRow.id},data:{content:JSON.stringify(history)}});
  const task=await queueFoundationDelivery(project.id,{},db);
  const after=await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}});
  assert.equal(after.length,before.length);assert.deepEqual(after.map(e=>e.id).sort(),before.map(e=>e.id).sort());
  let first='';
  await executeFoundationDelivery(project.id,task.id,{db,stageRunner:async(stage)=>{
   first=stage;
   const probe=execFileSync(process.execPath,['-e',"process.stdout.write(JSON.stringify({pid:process.pid,stage:process.argv[1]}))",stage],{encoding:'utf8'});
   const evidence=JSON.parse(probe);assert(evidence.pid>0);assert.equal(evidence.stage,stage);
   throw Object.assign(new Error('有界测试已抵达真实子进程，停止后续模型请求'),{requestOutcome:'NOT_SENT'});
  }});
  const state=await getFoundationDeliveryState(project.id,db);
  assert.equal(first,'F2',state.task?.error??state.task?.message??'首调用未到达');
  console.log(JSON.stringify({pass:true,episodes:after.length,firstStage:first,numberRange:[after[0].number,after.at(-1)!.number],idsPreserved:true,realProviderCalls:0}));
 }finally{await db.$disconnect();rmSync(directory,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
