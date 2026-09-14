
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readdirSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {PrismaClient} from '@prisma/client';
async function main(){
 const folder=path.resolve('runtime-3008/audit-0914/orphan-'+Date.now());mkdirSync(folder,{recursive:true});
 const file=path.join(folder,'test.db'),sql=new DatabaseSync(file);for(const n of readdirSync('prisma/migrations').sort())if(/^\d/.test(n))sql.exec(readFileSync(path.join('prisma/migrations',n,'migration.sql'),'utf8'));sql.close();
 process.env.DATABASE_URL='file:'+file.replaceAll('\\','/');const db=new PrismaClient({datasourceUrl:process.env.DATABASE_URL});
 const api=await import('../lib/foundation-delivery');
 try{const p=await db.project.create({data:{title:'synthetic orphan',episodes:{create:[{number:1,title:'test',content:'第1集\n1-1 室内 日\n甲：你好。'}]}}});
 const task=await api.queueFoundationDelivery(p.id,{},db);const row=await db.sceneSnapshot.findFirstOrThrow({where:{projectId:p.id,sceneKey:'FOUNDATION_DELIVERY_TASK'}});let saved=JSON.parse(row.content);saved.updatedAt='2000-01-01T00:00:00.000Z';saved.createdAt=saved.updatedAt;await db.sceneSnapshot.update({where:{id:row.id},data:{content:JSON.stringify(saved)}});
 const queued=await api.getFoundationDeliveryState(p.id,db);let error='';try{await api.queueFoundationDelivery(p.id,{},db)}catch(e){error=String(e)};
 assert.equal(queued.busy,false);assert.equal(queued.task?.status,'INTERRUPTED');assert.equal(error,'');saved={...saved,status:'RUNNING',workerPid:process.pid};await db.sceneSnapshot.update({where:{id:row.id},data:{content:JSON.stringify(saved)}});const reused=await api.getFoundationDeliveryState(p.id,db);assert.equal(reused.busy,true);
 const report={noModelCalls:true,orphanQueued:{status:queued.task?.status,pid:queued.task?.workerPid,busy:queued.busy,requeueError:error},unrelatedLivePid:{busy:reused.busy,status:reused.task?.status}};writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));console.log('PASS orphan queued task becomes resumable without provider calls; active inline runner stays alive');
 }finally{await db.$disconnect()}
}
main().catch(e=>{console.error(e);process.exitCode=1});
