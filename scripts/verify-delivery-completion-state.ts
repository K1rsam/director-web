import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PrismaClient} from '@prisma/client';
import {prepareFidelityImport} from '../lib/fidelity-import';
import {planP1ReviewBatches,type P1ReviewState} from '../lib/fidelity-p1-review';

async function main(){
 const dir=mkdtempSync(path.join(tmpdir(),'background-handoff-')),url=`file:${dir}/test.db`;process.env.DATABASE_URL=url;
 copyFileSync('prisma/schema.prisma',`${dir}/schema.prisma`);execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${dir}/schema.prisma`,'--skip-generate'],{env:{...process.env,RUST_LOG:'info'},stdio:'pipe'});
 const db=new PrismaClient({datasourceUrl:url});
 try{
  const {importParsedProject}=await import('../lib/workflow');const {prepareFidelitySourceAssisted}=await import('../lib/fidelity-source-assist');const {readFidelityReceipt}=await import('../lib/fidelity-store');
  const {loadFoundationInputs}=await import('../lib/foundation-state');const {createEmptyDocument,mergeDocumentF2,applyDocumentEdit,saveFoundationDocument}=await import('../lib/foundation-document');
  const {requireProductionCatalogAuthor,requireProductionOptimization}=await import('../lib/foundation-production-contracts');const {LIGHT_ASSET_METHOD_VERSION}=await import('../lib/foundation-production-prompts');
  const {getFoundationDeliveryState,queueFoundationDelivery,executeFoundationDelivery}=await import('../lib/foundation-delivery');const {readLightEpisodeFoundation}=await import('../lib/light-foundation-reader');
  const user=await db.user.create({data:{username:'background-test',email:'background@example.test',passwordHash:'offline'}});
  const raw='作者资料\r\n蓝色笔记。😀\r\n第1集\r\n1-1 日 内 客厅\r\n甲：窗帘颜色暂未确定。\r\n第2集\r\n2-1 日 外 广场\r\n甲：到了。\r\n';
  const prepared=await prepareFidelityImport('background.txt',Buffer.from(raw),'fidelity');
  const p1:P1ReviewState={status:'PENDING',reviewedSourceVersion:prepared.receipt.readingHash,completedRanges:planP1ReviewBatches(raw).map(b=>({start:b[0].start,end:b.at(-1)!.end})),runIds:['paid-background-review'],pendingDecisions:[],unresolved:[]};prepared.receipt.p1Review=p1;
  const {project}=await importParsedProject({ownerUserId:user.id,title:'Background routing fixture',sourceName:'background.txt',fidelityReceipt:prepared.receipt},prepared.imported,db);
  const old=(await readFidelityReceipt(project.id,db))!;assert(!Object.hasOwn(JSON.parse(old.sourceSnapshot!.content),'episodes'));
  let calls=0;await prepareFidelitySourceAssisted(project.id,db,{checkCurrent:async()=>{},assist:async()=>{calls++;throw Error('No new model calls');}});
  const input=await loadFoundationInputs(project.id,db);assert(input.sourceContext.complete);assert.equal(input.sourceContext.unresolved.length,0);
  const empty=createEmptyDocument(input),scope=[1,2];
  const catalog=requireProductionCatalogAuthor({format:'ASSET_CATALOG_V2',coverage:scope,assets:[{name:'甲',type:'CH',episodes:scope,sceneRefs:[{episode:1,sceneKey:'1-1'},{episode:2,sceneKey:'2-1'}],preparation:{mode:'REFERENCE'}}]},input.sourceIndex,scope);
  let doc=mergeDocumentF2({...empty,workflow:'LIGHT_STAGE1_V1',assetMethodVersion:LIGHT_ASSET_METHOD_VERSION},catalog,input.sourceIndex);
  // A historical derived warning is re-evaluated from current source in both readers.
  doc.f2!.issues.push({severity:'BLOCKER',owner:'PROGRAM',coordinate:`assets.${doc.f2!.assets[0].key}.preparation`,problem:'旧版本明确实体交互诊断',sourceRefs:[{episode:1,startLine:1,endLine:1}]});
  doc=applyDocumentEdit(doc,requireProductionOptimization({format:'FOUNDATION_OPTIMIZATION_V2',coverage:scope,changes:{}},input.sourceIndex,scope,doc.f2!.assets),input.sourceIndex);
  doc=await saveFoundationDocument(db,project.id,empty.revision,doc,'offline accepted catalog and editor');
  const {registerFoundationDocumentAssets}=await import('../lib/foundation-delivery-assets');
  assert.equal((await getFoundationDeliveryState(project.id,db)).complete,false,'unregistered current identities are not complete');
  const queued=await queueFoundationDelivery(project.id,{},db);
  await executeFoundationDelivery(project.id,queued.id,{db,stageRunner:async()=>{calls++;throw Error('Ready document requires only local registry completion');}});
  assert.equal(calls,0);
  const finished=await getFoundationDeliveryState(project.id,db);assert.equal(finished.task?.status,'COMPLETE');assert.equal(finished.complete,true);
  const taskId='foundation-delivery-'+project.id;
  const stored=await db.sceneSnapshot.findUniqueOrThrow({where:{id:taskId}}),base=JSON.parse(stored.content);
  for(const status of ['PARTIAL','STOPPED','WAITING_USER','INTERRUPTED','COMPLETE']){
   await db.sceneSnapshot.update({where:{id:taskId},data:{content:JSON.stringify({...base,status,repairHalt:{fingerprint:'old',reason:'old stop'}})}});
   const before=await db.sceneSnapshot.findUniqueOrThrow({where:{id:taskId}});
   const state=await getFoundationDeliveryState(project.id,db);assert.equal(state.complete,true,status);assert.equal(state.action,'NONE');assert.equal(state.continuationBlocker,null);
   assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:taskId}}),before,'read preserves historical task');
  }
  for(const status of ['QUEUED','RUNNING']){
   await db.sceneSnapshot.update({where:{id:taskId},data:{content:JSON.stringify({...base,status,workerPid:process.pid,updatedAt:new Date().toISOString()})}});
   const state=await getFoundationDeliveryState(project.id,db);assert.equal(state.busy,true);assert.equal(state.complete,false);assert.equal(state.action,'NONE');
  }
  await db.sceneSnapshot.update({where:{id:taskId},data:{content:JSON.stringify({...base,status:'PARTIAL',unknownOutcome:true})}});
  const unknown=await getFoundationDeliveryState(project.id,db);assert.equal(unknown.complete,false);assert.equal(unknown.action,'UNKNOWN_CONFIRM');
  await db.sceneSnapshot.update({where:{id:taskId},data:{content:JSON.stringify({...base,status:'PARTIAL'})}});
  doc=(await getFoundationDeliveryState(project.id,db)).document;
  const asset=await db.asset.findFirstOrThrow({where:{projectId:project.id}}),meta=JSON.parse(asset.metadata!);
  await db.asset.update({where:{id:asset.id},data:{metadata:JSON.stringify({...meta,foundation:{...meta.foundation,documentRevision:'stale'}})}});
  assert.equal((await getFoundationDeliveryState(project.id,db)).complete,false);
  await registerFoundationDocumentAssets(db,project.id,doc,[]);
  assert.equal((await getFoundationDeliveryState(project.id,db)).complete,true);
  // A real editor finding has explicit production scope and remains blocking.
  const changed=applyDocumentEdit(doc,requireProductionOptimization({format:'FOUNDATION_OPTIMIZATION_V2',coverage:scope,changes:{},unresolved:[{owner:'Q1',episodes:[1],applicationScope:{kind:'EPISODES',episodes:[1]},evidenceRefs:[{sourceVersion:input.sourceVersion,episode:1,sceneKey:'1-1'}],note:'第1集窗帘颜色影响制作，需明确。'}]},input.sourceIndex,scope,doc.f2!.assets),input.sourceIndex);
  await saveFoundationDocument(db,project.id,doc.revision,changed,'offline scoped editor finding');
  assert.equal((await getFoundationDeliveryState(project.id,db)).documentReady,false);
  const one=await readLightEpisodeFoundation(project.id,1,db),two=await readLightEpisodeFoundation(project.id,2,db);
  assert.equal(one.readiness,'PARTIAL');assert(one.reasons.some(r=>r.includes('窗帘颜色')));assert.equal(two.readiness,'READY');assert(!two.reasons.some(r=>r.includes('窗帘颜色')));
  const saved=(await readFidelityReceipt(project.id,db))!;assert.equal(saved.receipt.p1Review?.status,'COMPLETE');assert.equal(saved.receipt.result.source.text,raw);assert.deepEqual(saved.receipt.p1Review?.runIds,p1.runIds);
  assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:old.sourceSnapshot!.id}}),old.sourceSnapshot);assert.equal(calls,0);assert.equal(await db.pipelineRun.count(),0);
  // A validly covered but genuinely unassigned source section remains blocking.
  const sourceRow=saved.sourceSnapshot!,unassigned=JSON.parse(sourceRow.content);
  const background=unassigned.sourceStructure.sections.find((s:{kind:string})=>s.kind==='BACKGROUND');assert(background);background.kind='UNRESOLVED';
  await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(unassigned),metadata:sourceRow.metadata}});
  const unresolvedInput=await loadFoundationInputs(project.id,db);assert(unresolvedInput.sourceContext.unresolved.length>0);assert.equal(unresolvedInput.sourceContext.complete,false);
  assert.equal((await getFoundationDeliveryState(project.id,db)).documentReady,false);
  assert.equal((await readLightEpisodeFoundation(project.id,2,db)).readiness,'PARTIAL');
  console.log('PASS completion independent of historical task; registry required, local executor closes with zero calls, active/unknown/scoped todo/source gap remain incomplete');
 }finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:200});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
