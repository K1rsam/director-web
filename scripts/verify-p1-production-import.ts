import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PrismaClient} from '@prisma/client';
import {prepareFidelityImport,type FidelityDecision} from '../lib/fidelity-import';
import {planP1ReviewBatches,type P1ReviewState} from '../lib/fidelity-p1-review';

async function main(){
 const directory=mkdtempSync(path.join(tmpdir(),'p1-production-import-')),url=`file:${directory}/test.db`;
 process.env.DATABASE_URL=url;
 copyFileSync('prisma/schema.prisma',`${directory}/schema.prisma`);
 execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${directory}/schema.prisma`,'--skip-generate'],{env:{...process.env,RUST_LOG:'info'},stdio:'pipe'});
 const db=new PrismaClient({datasourceUrl:url});
 try{
  const {importParsedProject}=await import('../lib/workflow');
  const {readFidelityReceipt}=await import('../lib/fidelity-store');
  const {prepareFidelitySourceAssisted}=await import('../lib/fidelity-source-assist');
  const {loadFoundationInputs}=await import('../lib/foundation-state');
  const user=await db.user.create({data:{email:'p1-import@example.test',username:'p1-import',passwordHash:'isolated-test'}});
  const raw='第1集\r\n1-1 日 外 广场\r\n甲：信在这里。😀\r\n第2集\r\n2-1 夜 内 客厅\r\n乙：我收到了。\r\n';
  const cases:Array<{name:string;decisions:FidelityDecision[];count:number}>=[
   {name:'merge',decisions:[{start:0,end:raw.length,kind:'body',episodeNumber:1,sceneNumber:1,note:'合成已保存归属决定'}],count:1},
   {name:'context',decisions:[{start:raw.indexOf('第2集'),end:raw.length,kind:'context',note:'合成资料归属决定'}],count:1},
   {name:'unchanged',decisions:[],count:2}
  ];
  for(const entry of cases){
   const prepared=await prepareFidelityImport('production.txt',Buffer.from(raw),'fidelity');
   const review:P1ReviewState={status:'PENDING',reviewedSourceVersion:prepared.receipt.readingHash,
    completedRanges:planP1ReviewBatches(raw).map(blocks=>({start:blocks[0].start,end:blocks.at(-1)!.end})),
    runIds:['saved-provider-response'],pendingDecisions:entry.decisions,unresolved:[]};
   prepared.receipt.p1Review=review;
   const {project}=await importParsedProject({ownerUserId:user.id,title:`formal ${entry.name}`,sourceName:'production.txt',fidelityReceipt:prepared.receipt},prepared.imported,db);
   const before=(await readFidelityReceipt(project.id,db))!;
   assert.equal(Object.hasOwn(JSON.parse(before.sourceSnapshot!.content),'episodes'),false,'exercise actual compact writer');
   let calls=0;
   const resume=()=>prepareFidelitySourceAssisted(project.id,db,{checkCurrent:async()=>{},assist:async()=>{calls++;throw new Error('Saved P1 must not be repurchased');}});
   const result=await resume();
   assert.equal(result.backendPending,undefined);assert.equal(result.episodeCount,entry.count);assert.equal(calls,0);
   const saved=(await readFidelityReceipt(project.id,db))!;
   assert.equal(saved.receipt.p1Review?.status,'COMPLETE');assert.equal(saved.receipt.result.source.text,raw);
   assert.deepEqual(saved.receipt.p1Review?.completedRanges,review.completedRanges);
   assert.deepEqual(saved.receipt.p1Review?.runIds,review.runIds);
   assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:before.sourceSnapshot!.id}}),before.sourceSnapshot);
   assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:before.snapshot.id}}),before.snapshot);
   const next=await loadFoundationInputs(project.id,db);assert.equal(next.sourceIndex.episodes.length,entry.count);
   const count=await db.sceneSnapshot.count({where:{projectId:project.id}});
   assert.equal((await resume()).assisted,false);assert.equal(calls,0);
   assert.equal(await db.sceneSnapshot.count({where:{projectId:project.id}}),count);
  }
  assert.equal(await db.pipelineRun.count(),0);
  console.log('PASS production import writer -> saved P1 -> index migration -> next role reader: merge/context/unchanged, original and paid evidence preserved, zero model calls');
 }finally{await db.$disconnect();const resolved=path.resolve(directory);assert(resolved.startsWith(path.resolve(tmpdir())+path.sep));rmSync(resolved,{recursive:true,force:true,maxRetries:8,retryDelay:200});}
}
main().catch(error=>{console.error(error);process.exitCode=1});
