import assert from 'node:assert/strict';
import {normalize,validatePlan} from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import {normalize as oldNormalize} from '../lib/fidelity-v3.mjs';
import {prepareFidelityImport,type FidelityResult} from '../lib/fidelity-import';
import {routeFidelityQuestions} from '../lib/fidelity-question-routing';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PrismaClient} from '@prisma/client';
import {planP1ReviewBatches} from '../lib/fidelity-p1-review';

async function main(){
 const text='第一集\r\n\r\n场景：大厅\r\n甲：逐字 😀 é。  \r\n场景 街道\r\n△乙停步。\r\n第二集\n场景 各地（快切）\n甲：场景：这只是台词。\n场景 学院各处 -> 走廊\n△甲离开。\n';
 const old=oldNormalize(text) as FidelityResult,next=normalize(text) as FidelityResult;
 assert(old.validation.issues.length>0);assert.equal(next.validation.issues.length,0);
 assert.deepEqual(next.episodes.map(e=>e.scenes.length),[2,2]);
 assert.equal(next.segments.map(s=>s.text).join(''),text);
 assert.deepEqual(next.segments.map(s=>[s.start,s.end,s.text]),old.segments.map(s=>[s.start,s.end,s.text]));
 assert.equal(next.source.sourceVersion,old.source.sourceVersion);
 assert.equal(validatePlan(old.source,old.plan).ok,false);
 const body={source:old.source,plan:old.plan},bytes=Buffer.from(JSON.stringify(body));
 const upgraded=await prepareFidelityImport('v3.json',bytes,'direct');
 assert.equal(upgraded.receipt.result.contractVersion,'fidelity/4');
 assert.equal(upgraded.receipt.readingHash,old.source.sourceVersion);
 assert.equal(upgraded.receipt.result.source.text,text);
 for(const mutate of [(p:any)=>p.issues=[],(p:any)=>p.segments[0].kind='body',(p:any)=>p.contractVersion='fidelity/4']){
  const bad=structuredClone(body);mutate(bad.plan);
  await assert.rejects(prepareFidelityImport('bad.json',Buffer.from(JSON.stringify(bad)),'direct'),/被修改|保真/);
 }
 for(const line of ['场景','场景：','甲：场景：大厅','△场景：大厅','场景：甲：你好。','场景在大厅','场景 甲走进来了。']){
  const result=normalize(`第一集\n${line}\n甲：无确认场界。\n`) as FidelityResult;
  assert.equal(result.episodes[0].scenes.length,0,line);
  assert(result.validation.issues.some(i=>i.code==='SCENE_BOUNDARY_UNCONFIRMED'),line);
 }
 const missing=normalize('第一集\n甲：未定。\n第二集\n场景 大厅\n甲：到了。\n') as FidelityResult;
 assert(missing.validation.issues.length>0);assert.equal(missing.episodes[0].scenes.length,0);
 const note='复合场标题内的切镜是否拆成独立制作场仍需取舍。';
 const routed=routeFidelityQuestions({status:'PENDING',reviewedSourceVersion:next.source.sourceVersion,unresolved:[{start:0,end:text.length,kind:'structure',note}]},next);
 assert.equal(routed.unresolved![0].note,note);assert.equal(routed.unresolved![0].routing?.kind,'QUESTION');
 await persisted(text,old,note);
 console.log('PASS v4 labeled scenes, exact source/hash, strict frozen-v3 package verification, negative boundaries, retained production question');
}
async function persisted(text:string,old:FidelityResult,note:string){
 const dir=mkdtempSync(path.join(tmpdir(),'p1-v4-scenes-')),url=`file:${dir}/test.db`;process.env.DATABASE_URL=url;
 copyFileSync('prisma/schema.prisma',`${dir}/schema.prisma`);
 execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${dir}/schema.prisma`,'--skip-generate'],{env:{...process.env,RUST_LOG:'info'},stdio:'pipe'});
 const db=new PrismaClient({datasourceUrl:url});
 try{
  const {prepareFidelitySourceAssisted}=await import('../lib/fidelity-source-assist');
  const {readFidelityReceipt}=await import('../lib/fidelity-store');
  const {refreshFidelitySource}=await import('../lib/fidelity-refresh');
  const prepared=await prepareFidelityImport('synthetic.txt',Buffer.from(text),'fidelity');
  prepared.receipt.result=old;
  const state={status:'PENDING' as const,reviewedSourceVersion:old.source.sourceVersion,completedRanges:planP1ReviewBatches(text).map(b=>({start:b[0].start,end:b.at(-1)!.end})),runIds:['prior-paid-checkpoint'],pendingDecisions:[],unresolved:[{start:0,end:text.length,kind:'structure' as const,note}]};
  prepared.receipt.p1Review=state;
  const project=await db.project.create({data:{title:'synthetic v3 checkpoint',episodes:{create:prepared.imported.episodes}}});
  const source=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(prepared.imported)}});
  prepared.receipt.sourceImportId=source.id;
  const receipt=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify(prepared.receipt)}});
  assert.deepEqual(await refreshFidelitySource(project.id,db),{changed:false});
  let calls=0;
  const result=await prepareFidelitySourceAssisted(project.id,db,{checkCurrent:async()=>{},assist:async()=>{calls++;throw new Error('No new paid calls');}});
  assert.equal(calls,0);assert.equal(result.backendPending,undefined);
  const saved=(await readFidelityReceipt(project.id,db))!;
  assert.equal(saved.receipt.p1Review!.status,'COMPLETE');
  assert.deepEqual(saved.receipt.p1Review!.runIds,state.runIds);
  assert.deepEqual(saved.receipt.p1Review!.completedRanges,state.completedRanges);
  assert.equal(saved.receipt.result.source.text,text);assert.equal(saved.receipt.originalHash,prepared.receipt.originalHash);
  assert.equal(saved.receipt.readingHash,prepared.receipt.readingHash);
  assert.equal(saved.receipt.p1Review!.unresolved![0].note,note);
  assert.deepEqual(await db.sceneSnapshot.findUnique({where:{id:source.id}}),source);
  assert.deepEqual(await db.sceneSnapshot.findUnique({where:{id:receipt.id}}),receipt);
  assert.equal(await db.pipelineRun.count(),0);
 }finally{await db.$disconnect();assert.equal(path.dirname(path.resolve(dir)),path.resolve(tmpdir()));rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:200});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
