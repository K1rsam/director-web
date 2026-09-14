import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { planP1ReviewBatches,validateP1ReviewPlan,p1RepairSections,projectP1ReviewRequest,type P1ReviewRequest } from '../lib/fidelity-p1-review';
import { cachedFoundationFacts } from '../lib/foundation-fact-cache';

async function main(){
 const directory=mkdtempSync(path.join(tmpdir(),'p1-review-')),url=`file:${directory.replaceAll('\\','/')}/test.db`;
 process.env.DATABASE_URL=url;process.env.PYTHONUTF8='1';
 copyFileSync('prisma/schema.prisma',`${directory}/schema.prisma`);
 execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${directory}/schema.prisma`,'--skip-generate'],{env:{...process.env,RUST_LOG:'info'},stdio:'pipe'});
 const db=new PrismaClient({datasourceUrl:url});
 const {prepareFidelityImport}=await import('../lib/fidelity-import');
 const {prepareFidelitySourceAssisted}=await import('../lib/fidelity-source-assist');
 const {readFidelityReceipt}=await import('../lib/fidelity-store');
 const {applyFidelityDecision}=await import('../lib/fidelity-store');
 const {fidelityReviewCandidates,selectSourceReviewCandidates}=await import('../lib/fidelity-review-candidates');
 const {loadFoundationInputs}=await import('../lib/foundation-state');
 const {buildDeliveryInput,queueFoundationDelivery,executeFoundationDelivery,getFoundationDeliveryState}=await import('../lib/foundation-delivery');
 const {createEmptyDocument}=await import('../lib/foundation-document');
 const create=async(text:string,mode:'fidelity'|'direct'='fidelity',pending=true)=>{
  const prepared=await prepareFidelityImport('test.txt',Buffer.from(text),mode);
  if(pending)prepared.receipt.p1Review={status:'PENDING'};
  const project=await db.project.create({data:{title:'P1隔离测试',episodes:{create:prepared.imported.episodes}}});
  const source=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',title:'source',content:JSON.stringify(prepared.imported),metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'})}});
  prepared.receipt.sourceImportId=source.id;
  await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',title:'receipt',content:JSON.stringify(prepared.receipt)}});
  return project;
 };
 const answer=(request:P1ReviewRequest)=>({sourceVersion:request.sourceVersion,reviewed:{firstBlock:request.batch.firstBlock,lastBlock:request.batch.lastBlock},assignments:[],unresolved:[],aliases:[]});
 let calls=0;
 const options={checkCurrent:async()=>{},checkAfterCommit:async()=>{},assist:async(request:any,validate:any)=>{calls++;const plan=answer(request);validate(plan);return {plan,runId:`mock-${calls}`};}};
 try{
  const source='第1集\n1-1 客厅 日 内\n甲：我是小甲。\n小甲：出发。\n';
  const raw=await create(source);
  assert.equal((await readFidelityReceipt(raw.id,db))!.receipt.result.validation.issues.length,0);
  await prepareFidelitySourceAssisted(raw.id,db,options);assert.equal(calls,1,'zero parser issues still triggers raw AI');
  const receipt=(await readFidelityReceipt(raw.id,db))!.receipt;
  assert.equal(receipt.p1Review?.status,'COMPLETE');assert.equal(receipt.result.source.text,source);
  await prepareFidelitySourceAssisted(raw.id,db,options);assert.equal(calls,1,'complete review must not repeat');
  const direct=await create(source,'direct');await prepareFidelitySourceAssisted(direct.id,db,options);assert.equal(calls,1,'external direct never calls AI');
  const directPending=await create('甲：没有集场标题。\n','direct');
  const directOut=await prepareFidelitySourceAssisted(directPending.id,db,options);
  assert.equal(calls,1);assert.equal(directOut.backendPending?.reason,'DIRECT_STRUCTURE_PENDING');
  const legacy=await create(source,'fidelity',false);await prepareFidelitySourceAssisted(legacy.id,db,options);assert.equal(calls,1,'old clean project not automatically reviewed');
  const longText='第1集\n1-1 客厅 日 内\n'+'甲：原样保留😀。\n'.repeat(7000),long=await create(longText);
  let seen:string[]=[];let fail=true;
  const longOptions={...options,assist:async(request:any,validate:any)=>{
   seen.push(request.batch.firstBlock);if(request.batch.index===2&&fail)throw new Error('模拟中断');
   const plan=answer(request);validate(plan);return {plan,runId:`batch-${request.batch.index}`};
  }};
  await assert.rejects(prepareFidelitySourceAssisted(long.id,db,longOptions),/模拟中断/);
  assert.equal((await readFidelityReceipt(long.id,db))!.receipt.p1Review?.completedRanges?.length,1);
  fail=false;await prepareFidelitySourceAssisted(long.id,db,longOptions);
  assert.equal(seen.filter(k=>k==='B000001').length,1,'accepted first batch is not repurchased');
  assert.equal((await readFidelityReceipt(long.id,db))!.receipt.result.source.text,longText);
  assert.equal(planP1ReviewBatches('字'.repeat(100000))[0][0].text.length,100000,'long line is never silently truncated');
  const blocks=planP1ReviewBatches(source)[0],request:P1ReviewRequest={reviewMode:'FULL_STRUCTURE_V1',sourceVersion:'v',sourceLength:source.length,batch:{firstBlock:blocks[0].id,lastBlock:blocks.at(-1)!.id,index:1,total:1},sections:blocks.map(b=>({...b,key:b.id})),issues:[],baseline:[]};
  assert.throws(()=>validateP1ReviewPlan({...answer(request),replacementText:'aba'},request),/禁止/);
  assert.throws(()=>validateP1ReviewPlan({...answer(request),reviewed:{firstBlock:'B000002',lastBlock:request.batch.lastBlock}},request),/完整阅读/);
  assert.throws(()=>validateP1ReviewPlan({...answer(request),assignments:[{firstBlock:'B999999',lastBlock:'B999999',kind:'body',episodeNumber:1,note:'wrong'}]},request),/本批以外/);
  const stopped=await create(source);
  await assert.rejects(prepareFidelitySourceAssisted(stopped.id,db,{...options,checkCurrent:async()=>{throw new Error('已停止');}}),/已停止/);
  assert.equal((await readFidelityReceipt(stopped.id,db))!.receipt.p1Review?.completedRanges,undefined);
  // Writer-format variations remain source faithful; ambiguous structure is backend pending.
  for(const text of ['第0集\n第0集\n甲：到了。\n','甲：到了。\n乙：请进。\n','作者：某编剧\n第一集\n甲：到了。\n','第一集\n甲：到了。\n','第0集 序章\n0-1 门口 夜 外\n甲：回来了。\n']){
   const project=await create(text);let localCalls=0;
   const out=await prepareFidelitySourceAssisted(project.id,db,{...options,assist:async(request:any,validate:any)=>{localCalls++;const plan=answer(request);validate(plan);return {plan,runId:`variation-${localCalls}`};}});
   assert.equal((await readFidelityReceipt(project.id,db))!.receipt.result.source.text,text);
   if(out.unresolved.length){assert.equal(out.backendPending?.kind,'BACKEND_STRUCTURE_PENDING');assert.equal((await readFidelityReceipt(project.id,db))!.receipt.p1Review?.status,'PENDING');}
   await prepareFidelitySourceAssisted(project.id,db,{...options,assist:async()=>{throw new Error('已读全文和已完成局部补漏不可重复购买');}});
   assert(localCalls<=2);
  }
  const missedTitle=await create('未命名剧本\n第1集\n1-1 客厅 日 内\n甲：到了。\n');let repairCalls=0;
  const repaired=await prepareFidelitySourceAssisted(missedTitle.id,db,{...options,assist:async(request:any,validate:any)=>{
   repairCalls++;assert(request.issues.length,'full and repair requests expose unresolved structural evidence');
   const plan={...answer(request),assignments:request.repairAttempt?[{firstBlock:request.sections[0].key,lastBlock:request.sections[0].key,kind:'context',note:'独立作品标题，后接明确第一集'}]:[]};
   return {plan:validate(plan),runId:`title-${repairCalls}`};
  }});
  assert.equal(repairCalls,2);assert.equal(repaired.unresolved.length,0);assert.equal((await readFidelityReceipt(missedTitle.id,db))!.receipt.p1Review?.status,'COMPLETE');
  await prepareFidelitySourceAssisted(missedTitle.id,db,{...options,assist:async()=>{throw new Error('不得重复全文');}});
  const tinyText='字\n'.repeat(6000),tinyBlocks=planP1ReviewBatches(tinyText).flat();
  const tinySections=p1RepairSections(tinyText,tinyBlocks);
  assert(tinySections.filter(s=>s.before!==undefined||s.after!==undefined).length<=2,'continuous tiny blocks share context edges');
  const sparse=p1RepairSections(tinyText,[tinyBlocks[1000],tinyBlocks[3000]]);
  assert(sparse.every(s=>s.before?.length===400&&s.after?.length===400),'discrete ranges keep both neighbors');
  const oversized=await create(tinyText);let oversizedCalls=0;
  const oversizedOut=await prepareFidelitySourceAssisted(oversized.id,db,{...options,assist:async(request:any,validate:any)=>{oversizedCalls++;assert(!request.repairAttempt,'serialized request budget prevents thousands of issue rows overflowing repair');const plan=answer(request);return {plan:validate(plan),runId:'tiny'};}});
  assert.equal(oversizedCalls,1);assert(oversizedOut.backendPending);
  for(const resolved of [false,true]){
   const semanticStructure=await create(source);let structureCalls=0;
   const out=await prepareFidelitySourceAssisted(semanticStructure.id,db,{...options,assist:async(request:any,validate:any)=>{
    structureCalls++;const plan={...answer(request),unresolved:request.repairAttempt&&resolved?[]:[{firstBlock:request.batch.firstBlock,lastBlock:request.batch.lastBlock,kind:'structure',note:'当前集场关系存在结构疑点'}]};
    if(request.repairAttempt)assert(JSON.stringify(projectP1ReviewRequest(request)).length<=24000);
    return {plan:validate(plan),runId:`structure-${structureCalls}`};
   }});
   assert.equal(structureCalls,1,'independent complete source ownership avoids redundant structural review');assert.equal(Boolean(out.backendPending),false);
   const latest=(await readFidelityReceipt(semanticStructure.id,db))!.receipt;
   assert.equal(latest.result.validation.issues.length,0);
   assert.equal(latest.p1Review?.status,'COMPLETE');
   assert.equal(latest.p1Review?.unresolved?.length,1,'ownership verification does not erase the original question');
   assert(fidelityReviewCandidates(latest).some(row=>row.kind==='QUESTION'&&row.detail.question==='当前集场关系存在结构疑点'&&row.detail.questionStatus==='OPEN'),'the unresolved question is handed downstream with its original scope');
  }
  // Actual controller starts even when deterministic import cannot identify any episode.
  const unstructured=await create('甲：我到了。\n乙：进来。\n');
  const state=await getFoundationDeliveryState(unstructured.id,db);assert.equal(state.action,'START');
  const task=await queueFoundationDelivery(unstructured.id,{},db);let modelCalls=0;
  await executeFoundationDelivery(unstructured.id,task.id,{db,stageRunner:async(stage,prompt)=>{
   assert.equal(stage,'F1');modelCalls++;const input=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
   const data={...answer(input),unresolved:[{firstBlock:input.batch.firstBlock,lastBlock:input.batch.lastBlock,note:'原文未提供集号，请确认归属'}]};
   return {data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null};
  }});
  assert.equal(modelCalls,2);assert.equal((await getFoundationDeliveryState(unstructured.id,db)).task?.status,'PARTIAL');
  // The paid F1 response is reusable when a later receipt commit fails.
  const recovery=await create('甲：我到了。\n乙：进来。\n');
  const recoveryTask=await queueFoundationDelivery(recovery.id,{},db);let recoveryCalls=0;let rejectCheckpoint=true;
  const failingDb=db.$extends({query:{sceneSnapshot:{create:async({args,query})=>{
   if(args.data.projectId===recovery.id&&args.data.title==='P1原稿结构检查进度'&&rejectCheckpoint){rejectCheckpoint=false;throw new Error('模拟检查点保存失败');}
   return query(args);
  }}}}) as unknown as PrismaClient;
  const recoveryRunner=async(stage:string,prompt:string)=>{assert.equal(stage,'F1');recoveryCalls++;const input=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);const data=answer(input);return {data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null};};
  await executeFoundationDelivery(recovery.id,recoveryTask.id,{db:failingDb,stageRunner:recoveryRunner});
  assert.equal(recoveryCalls,1);
  const retry=await queueFoundationDelivery(recovery.id,{},db);
  await executeFoundationDelivery(recovery.id,retry.id,{db,stageRunner:recoveryRunner});
  assert.equal(recoveryCalls,2,'paid full response recovered without repurchase; only one new local repair request');
  // Receipt candidates are consumed by actual P2 request assembly, without changing source labels.
  const alias=await create(source);
  const aliasResult=await prepareFidelitySourceAssisted(alias.id,db,{...options,assist:async(request:any,validate:any)=>{
   const plan={...answer(request),unresolved:[{firstBlock:request.batch.firstBlock,lastBlock:request.batch.lastBlock,kind:'semantic',note:'称呼关系待下阶段核对'}],aliases:[{alias:'小甲',canonicalCandidate:'甲',firstBlock:request.batch.firstBlock,lastBlock:request.batch.lastBlock,note:'原文自称候选'}]};validate(plan);return {plan,runId:'alias'};
  }});
  assert.equal(aliasResult.unresolved.length,0,'semantic candidates do not block structurally readable source');
  const input=await loadFoundationInputs(alias.id,db),doc=createEmptyDocument(input);
  const payload=buildDeliveryInput('F2','GENERATE_F2',input,doc,[1],[],[],[],[]);
  assert.equal(payload.sourceReviewCandidates?.length,2);
  const manual=await readFidelityReceipt(alias.id,db);
  await applyFidelityDecision({projectId:alias.id,revision:manual!.snapshot.id,sourceRevision:manual!.sourceSnapshot!.id,sourceVersion:manual!.receipt.readingHash,decisionVersion:String(manual!.receipt.result.plan.decisionVersion),firstLine:3,lastLine:3,kind:'body',episodeNumber:1,sceneNumber:1},db);
  const afterManual=(await readFidelityReceipt(alias.id,db))!;
  assert.equal(afterManual.receipt.p1Review?.status,'COMPLETE');
  assert.equal(fidelityReviewCandidates(afterManual.receipt).length,2,'manual confirmation preserves completed review candidates');
  const pending=await create(source),pendingReceipt=(await readFidelityReceipt(pending.id,db))!;
  const start=source.indexOf('甲：'),end=source.indexOf('小甲：');
  const savedPending={...pendingReceipt.receipt,p1Review:{status:'PENDING',reviewedSourceVersion:pendingReceipt.receipt.readingHash,completedRanges:[{start:0,end:source.length}],runIds:['accepted-original-batch'],pendingDecisions:[{start,end,kind:'context',note:'旧AI提议'}]},externalReview:{protocol:'FIDELITY-TEXT/1',sourceVersion:pendingReceipt.receipt.readingHash,aliases:[],questions:[],contextTypes:[]}};
  await db.sceneSnapshot.create({data:{projectId:pending.id,sceneKey:'FIDELITY_IMPORT',title:'pending checkpoint',content:JSON.stringify(savedPending)}});
  const beforeConfirm=(await readFidelityReceipt(pending.id,db))!;
  await applyFidelityDecision({projectId:pending.id,revision:beforeConfirm.snapshot.id,sourceRevision:beforeConfirm.sourceSnapshot!.id,sourceVersion:beforeConfirm.receipt.readingHash,decisionVersion:String(beforeConfirm.receipt.result.plan.decisionVersion),firstLine:3,lastLine:3,kind:'body',episodeNumber:1,sceneNumber:1},db);
  const pendingAfter=(await readFidelityReceipt(pending.id,db))!;
  assert.equal(pendingAfter.receipt.p1Review?.status,'PENDING');assert.equal(pendingAfter.receipt.p1Review?.completedRanges?.length,1);
  assert.equal(pendingAfter.receipt.p1Review?.pendingDecisions?.length,0,'explicit user range overrides only conflicting AI proposal');
  assert(pendingAfter.receipt.externalReview,'external review metadata remains');
  let repeatedCalls=0;
  await prepareFidelitySourceAssisted(pending.id,db,{...options,assist:async()=>{repeatedCalls++;throw new Error('不可重购完整已读批次');}});
  assert.equal(repeatedCalls,0);assert.equal((await readFidelityReceipt(pending.id,db))!.receipt.p1Review?.status,'COMPLETE');
  const spaced=await create('第1集\n1-1 房间 日 内\n甲：一。\n第2集\n2-1 房间 日 内\n乙：二。\n第3集\n3-1 房间 日 内\n丙：三。\n','direct');
  const spacedReceipt=(await readFidelityReceipt(spaced.id,db))!.receipt;
  spacedReceipt.externalReview={protocol:'FIDELITY-TEXT/1',sourceVersion:spacedReceipt.readingHash,aliases:[],contextTypes:[],questions:[{question:'首尾证据',evidence:['B000003','B000009']}]};
  const candidates=fidelityReviewCandidates(spacedReceipt);
  assert.deepEqual(candidates[0].episodes,[1,3]);assert.equal(candidates[0].ranges.length,2);
  assert(!('start' in candidates[0]),'discrete evidence has no misleading envelope start/end');
  assert.equal(selectSourceReviewCandidates(candidates,[2],'乙：二。').length,0,'middle episode never receives disjoint evidence candidate');
  const facts=cachedFoundationFacts(input.sourceIndex,input.sourceContext,null);
  assert.equal(cachedFoundationFacts(input.sourceIndex,input.sourceContext,null),facts,'same dependencies reuse facts');
  const renamed={assets:[{name:'新称呼',aliases:[]}]} as any;
  assert.notEqual(cachedFoundationFacts(input.sourceIndex,input.sourceContext,renamed),facts,'identity changes invalidate facts');
  console.log('PASS P1 complete raw review, direct zero calls, old import compatibility, batch checkpoint, stop, zero-episode controller, strict blocks, real candidate consumer, fact dependency cache');
 }finally{await db.$disconnect();const resolved=path.resolve(directory);if(!resolved.startsWith(path.resolve(tmpdir())+path.sep))throw new Error('temp boundary');rmSync(resolved,{recursive:true,force:true});}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
