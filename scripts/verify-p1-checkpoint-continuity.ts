/** Offline current receiver/checkpoint integration; temporary synthetic DB only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PrismaClient} from '@prisma/client';
import {prepareFidelityImport} from '../lib/fidelity-import';
import {planP1ReviewBatches} from '../lib/fidelity-p1-review';
import {prepareFidelitySourceAssisted} from '../lib/fidelity-source-assist';
import {readFidelityReceipt} from '../lib/fidelity-store';

test('completed P1 batches resume through one source-anchored continuity correction without a provider call',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'p1-checkpoint-continuity-')),file=path.join(directory,'test.db');
 const sql=new DatabaseSync(file);
 for(const migration of (await readdir('prisma/migrations')).sort())if(/^\d/.test(migration))sql.exec(await readFile(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();const db=new PrismaClient({datasourceUrl:`file:${file}`});t.after(async()=>{await db.$disconnect();await rm(directory,{recursive:true,force:true});});
 const text='第24集\r\n24.1 日，内，客厅\r\n甲：'+ '原'.repeat(23700)+'。\r\n24.3 夜，内，浴室\r\n'+('甲（OS）：保留原话😀。\r\n').repeat(50),batches=planP1ReviewBatches(text);
 assert.equal(batches.length,2);const anchor=text.indexOf('24.3'),cut=batches[1][0].start;
 assert(anchor<cut&&cut<text.length);
 const prepared=await prepareFidelityImport('synthetic.txt',Buffer.from(text),'fidelity');
 const pending=[{start:anchor,end:cut,kind:'body' as const,episodeNumber:24,sceneNumber:4,note:'上一批已接受的内部索引'},
  {start:cut,end:text.length,kind:'body' as const,episodeNumber:24,sceneNumber:3,note:'下批按源24.3给了不同内部索引'}];
 prepared.receipt.p1Review={status:'PENDING',reviewedSourceVersion:prepared.receipt.readingHash,completedRanges:batches.map(b=>({start:b[0].start,end:b.at(-1)!.end})),pendingDecisions:pending,runIds:['saved-batch-one','saved-batch-two']};
 const project=await db.project.create({data:{title:'synthetic checkpoint continuity',episodes:{create:prepared.imported.episodes}}});
 const source=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(prepared.imported),metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'})}});
 prepared.receipt.sourceImportId=source.id;
 const receipt=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify(prepared.receipt)}});
 const immutable=await Promise.all(pending.map((response,i)=>db.pipelineRun.create({data:{projectId:project.id,stageCode:'F1',roleName:'synthetic',provider:'CLI',status:'SUCCEEDED',outputSummary:JSON.stringify(response),log:JSON.stringify({rawResponse:response}),id:`saved-batch-${i?'two':'one'}`}})));
 let calls=0;
 await prepareFidelitySourceAssisted(project.id,db,{checkCurrent:async()=>{},assist:async()=>{calls++;throw new Error('No provider calls in completed checkpoint recovery');}});
 const current=(await readFidelityReceipt(project.id,db))!.receipt;
 assert.equal(current.result.episodes[0].scenes.length,2,'a source scene split only by transport batching is not a new scene');
 assert.equal(calls,0);assert.equal(current.p1Review?.status,'COMPLETE');
 assert.equal(current.p1Review?.batchContinuityCorrections?.length,1);
 assert.deepEqual(current.p1Review?.batchContinuityCorrections?.map(c=>[c.cut,c.sourceAnchor.start,c.fromSceneNumber,c.toSceneNumber]),[[cut,anchor,3,4]]);
 assert.equal(current.result.source.text,text);assert.equal(current.readingHash,prepared.receipt.readingHash);
 assert.deepEqual(current.p1Review?.runIds,prepared.receipt.p1Review.runIds);
 assert.deepEqual(await db.sceneSnapshot.findUnique({where:{id:source.id}}),source);
 assert.deepEqual(await db.sceneSnapshot.findUnique({where:{id:receipt.id}}),receipt);
 for(const row of immutable)assert.deepEqual(await db.pipelineRun.findUnique({where:{id:row.id}}),row,'never rewrite either original accepted response');
});

test('a reviewed true duplicate body branch asks for source ownership, never a paid backend repair',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'p1-source-branch-')),file=path.join(directory,'test.db'),sql=new DatabaseSync(file);
 for(const migration of (await readdir('prisma/migrations')).sort())if(/^\d/.test(migration))sql.exec(await readFile(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();const db=new PrismaClient({datasourceUrl:`file:${file}`});t.after(async()=>{await db.$disconnect();await rm(directory,{recursive:true,force:true});});
 const text='第1集\n1.1 日，内，门厅\n甲：之前。\n第16集\n16.1 夜，内，走廊\n甲：前段。\n第16集\n16.1 日，外，医院\n甲：后段。\n第17集\n17.1 日，外，街道\n甲：其后。\n';
 const prepared=await prepareFidelityImport('synthetic.txt',Buffer.from(text),'fidelity');
 prepared.receipt.p1Review={status:'PENDING',reviewedSourceVersion:prepared.receipt.readingHash,completedRanges:[{start:0,end:text.length}],pendingDecisions:[],runIds:['already-reviewed']};
 const project=await db.project.create({data:{title:'synthetic real duplicate source',episodes:{create:prepared.imported.episodes}}});
 const source=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(prepared.imported),metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'})}});
 prepared.receipt.sourceImportId=source.id;
 await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify(prepared.receipt)}});
 let calls=0;
 const result=await prepareFidelitySourceAssisted(project.id,db,{checkCurrent:async()=>{},assist:async()=>{calls++;throw new Error('No paid repair for a source choice');}});
 assert.equal(calls,0);assert.equal(result.backendPending,undefined);assert.deepEqual(result.unresolved,['DUPLICATE_EPISODE_NUMBER']);
 const receipt=(await readFidelityReceipt(project.id,db))!.receipt;
 assert.equal(receipt.sourceEpisodeBranches?.[0].episodeNumber,16);
 assert.equal(receipt.p1Review?.status,'COMPLETE','full reading finished; the separately exposed source ownership choice did not');
 assert.deepEqual((await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}})).map(e=>e.number),[1,17]);
 assert.equal(await db.pipelineRun.count({where:{projectId:project.id}}),0);
 const resumed=await prepareFidelitySourceAssisted(project.id,db,{checkCurrent:async()=>{},assist:async()=>{throw new Error('No repeat repair while waiting for source decision');}});
 assert.equal(resumed.backendPending,undefined);assert.deepEqual(resumed.unresolved,['DUPLICATE_EPISODE_NUMBER']);
});

for(const afterRepair of [false,true])test(`uncertain cross-batch continuity ${afterRepair?'introduced by bounded repair':'in completed batches'} stays pending without promotion or rebuying`,async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'p1-continuity-pending-')),file=path.join(directory,'test.db'),sql=new DatabaseSync(file);
 for(const migration of (await readdir('prisma/migrations')).sort())if(/^\d/.test(migration))sql.exec(await readFile(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();const db=new PrismaClient({datasourceUrl:`file:${file}`});t.after(async()=>{await db.$disconnect();await rm(directory,{recursive:true,force:true});});
 const head='第24集\n24.3 夜 内 浴室\n甲：',text=head+'a'.repeat(24000-head.length-1)+'\n'+(afterRepair?'场25-1 夜 内 未决地点\n':'▲甲在机场候机厅排队。\n')+'甲：继续。\n',batches=planP1ReviewBatches(text),cut=batches[1][0].start;
 assert.equal(cut,24000);
 const prepared=await prepareFidelityImport('synthetic.txt',Buffer.from(text),'fidelity');
 const pending=[{start:text.indexOf('24.3'),end:cut,kind:'body' as const,episodeNumber:24,sceneNumber:4,note:'前批内部索引'},
  {start:cut,end:text.length,kind:'body' as const,episodeNumber:24,sceneNumber:3,note:'后批内部索引不同，存在未确认换场'}];
 prepared.receipt.p1Review={status:'PENDING',reviewedSourceVersion:prepared.receipt.readingHash,completedRanges:batches.map(b=>({start:b[0].start,end:b.at(-1)!.end})),pendingDecisions:afterRepair?[pending[0]]:pending,runIds:['saved-first','saved-second']};
 const project=await db.project.create({data:{title:'synthetic uncertain continuity',episodes:{create:prepared.imported.episodes}}});
 const source=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(prepared.imported),metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'})}});
 prepared.receipt.sourceImportId=source.id;
 await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify(prepared.receipt)}});
 let calls=0;
 const options:Parameters<typeof prepareFidelitySourceAssisted>[2]={checkCurrent:async()=>{},assist:async(request,validate)=>{
  assert(afterRepair&&calls++===0,'No extra model call for mechanical continuity uncertainty');
  const batch=(request as import('../lib/fidelity-p1-review').P1ReviewRequest).batch;
  const raw={sourceVersion:request.sourceVersion,reviewed:{firstBlock:batch.firstBlock,lastBlock:batch.lastBlock},assignments:[{firstBlock:batch.firstBlock,lastBlock:batch.lastBlock,kind:'body',episodeNumber:24,sceneNumber:3,note:pending[1].note}],unresolved:[],aliases:[]};
  return {plan:validate(raw),runId:'synthetic-bounded-response'};
 }};
 for(let attempt=0;attempt<2;attempt++){
  const result=await prepareFidelitySourceAssisted(project.id,db,options);
  assert(result.backendPending?.codes.includes('P1_BATCH_CONTINUITY_UNRESOLVED'),'technical stop must survive a retry');
  const current=(await readFidelityReceipt(project.id,db))!;
  assert.equal(current.receipt.p1Review?.status,'PENDING');assert.deepEqual(current.receipt.p1Review?.pendingDecisions,pending);
  assert.deepEqual(current.receipt.decisions,[],'unreconciled internal indices are not promoted into adopted structure');
  assert.equal(current.sourceSnapshot?.id,source.id,'uncertain materialization cannot replace the pinned source');
 }
 assert.equal(await db.pipelineRun.count({where:{projectId:project.id}}),0);
 assert.equal(calls,afterRepair?1:0);
});
