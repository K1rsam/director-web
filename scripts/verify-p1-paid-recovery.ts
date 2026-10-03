/** Disposable DB and synthetic provider receipts only; never opens a campaign for writing. */
import test, {type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PrismaClient} from '@prisma/client';
import {planP1ReviewBatches,projectP1ReviewRequest,projectP1ReviewEvidenceRequest,restoreP1ReviewRequest,validateP1ReviewPlan,type P1ReviewRequest} from '../lib/fidelity-p1-review';

const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const output=(data:Record<string,unknown>)=>({data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null});
const response=(request:P1ReviewRequest,episodeNumber:unknown=2,sceneNumber:unknown=1)=>({sourceVersion:request.sourceVersion,reviewed:{firstBlock:request.batch.firstBlock,lastBlock:request.batch.lastBlock},assignments:[{firstBlock:request.batch.firstBlock,lastBlock:request.batch.lastBlock,kind:'body',episodeNumber,sceneNumber,note:'合成测试的明确归属'}],unresolved:[],aliases:[]});
const requestFor=(text:string,sourceVersion='synthetic-source',index=0):P1ReviewRequest=>{
 const batches=planP1ReviewBatches(text),blocks=batches[index];
 return {reviewMode:'FULL_STRUCTURE_V1',sourceVersion,sourceLength:text.length,batch:{firstBlock:blocks[0].id,lastBlock:blocks.at(-1)!.id,index:index+1,total:batches.length},sections:blocks.map(b=>({key:b.id,start:b.start,end:b.end,text:b.text})),issues:[],baseline:[]};
};

test('P1 accepts only exact decimal safe-integer field normalization and retains the source response',()=>{
 const request=requestFor('甲：原话不改。\n'),raw=response(request,'0','1'),before=structuredClone(raw);
 assert.equal(validateP1ReviewPlan(raw,request).decisions[0].episodeNumber,0);
 assert.equal(validateP1ReviewPlan(raw,request).decisions[0].sceneNumber,1);assert.deepEqual(raw,before);
 for(const number of [' 2','02','2.0','2e0','+2','-1','0x2','','9007199254740992',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>validateP1ReviewPlan(response(request,number),request),/集场/);
 for(const number of ['0',0,' 1','1.0','01','9007199254740992'])assert.throws(()=>validateP1ReviewPlan(response(request,2,number),request),/集场/);
});
test('context source-number hints never become episode/scene routing and never change the saved response',()=>{
 const text='第25集\n第25集\n25.1 日 内 房间\n甲：原文。\n',request=requestFor(text);
 for(const numbers of [{episodeNumber:'25'},{episodeNumber:25},{episodeNumber:'25',sceneNumber:'1'},{episodeNumber:0,sceneNumber:1},{sceneNumber:'2'},{}]){
  const raw={...response(request),assignments:[{firstBlock:'B000001',lastBlock:'B000002',kind:'context',...numbers,note:'重复集标题，属资料上下文。'}]},before=structuredClone(raw);
  const decision=validateP1ReviewPlan(raw,request).decisions[0];
  assert.deepEqual(decision,{start:0,end:'第25集\n第25集\n'.length,kind:'context',note:'重复集标题，属资料上下文。'},'context优先；合法数字仅在原回包留证，不得变body或路由号');
  assert.deepEqual(raw,before,'不得就地删除原回包中的提示信息');
 }
 for(const [field,values] of Object.entries({episodeNumber:[' 25','025','25.0','2.5e1','+25','-1',-1,'',null,true,[],{},'9007199254740992',Number.MAX_SAFE_INTEGER+1],sceneNumber:['0',0,' 1','1.0','01','-1',false,'9007199254740992']}))for(const value of values){
  const raw={...response(request),assignments:[{firstBlock:'B000001',lastBlock:'B000002',kind:'context',[field]:value,note:'元数据不能绕过严格类型校验'}]};
  assert.throws(()=>validateP1ReviewPlan(raw,request),/集场/);
 }
 const missingBody={...response(request),assignments:[{firstBlock:'B000003',lastBlock:'B000004',kind:'body',sceneNumber:'1',note:'正文仍须明确集号'}]};
 assert.throws(()=>validateP1ReviewPlan(missingBody,request),/集场/);
});
test('saved compact requests recover only exact current source blocks and keep the evidence envelope unchanged',()=>{
 const text='甲：原话不改。\n乙：仍然保留。\n',request=requestFor(text),wire=projectP1ReviewRequest(request),before=structuredClone(wire);
 assert.deepEqual(restoreP1ReviewRequest(wire as unknown as Record<string,unknown>,text).sections,request.sections);
 assert.deepEqual(wire,before);
 assert.throws(()=>restoreP1ReviewRequest(wire as unknown as Record<string,unknown>,text.replace('原话','新话')),/不一致/);
 assert.throws(()=>restoreP1ReviewRequest({...wire,blocks:[...wire.blocks].reverse()},text),/不一致/);
 assert.throws(()=>restoreP1ReviewRequest({...wire,batch:{...wire.batch,lastBlock:'B999999'}},text),/批次/);
});

async function fixture(t:TestContext){
 const directory=await mkdtemp(path.join(tmpdir(),'p1-paid-recovery-')),file=path.join(directory,'test.db'),url=`file:${file}`;
 const sql=new DatabaseSync(file);
 for(const migration of (await readdir('prisma/migrations')).sort())if(/^\d/.test(migration))sql.exec(await readFile(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();const db=new PrismaClient({datasourceUrl:url});t.after(async()=>{await db.$disconnect();await rm(directory,{recursive:true,force:true});});
 const api=await import('../lib/foundation-delivery'),fidelity=await import('../lib/fidelity-import'),store=await import('../lib/fidelity-store'),source=await import('../lib/source-preparation');
 const create=async(text:string)=>{
  const prepared=await fidelity.prepareFidelityImport('synthetic.txt',Buffer.from(text),'fidelity');prepared.receipt.p1Review={status:'PENDING'};
  const project=await db.project.create({data:{title:'离线历史P1回执恢复',episodes:{create:prepared.imported.episodes}}});
  const snapshot=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(prepared.imported),metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'})}});
  prepared.receipt.sourceImportId=snapshot.id;
  await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify(prepared.receipt)}});
  return project;
 };
 return {db,api,create,store,source};
}

test('unrecoverable fidelity response is visible before queueing; a successful earlier batch cannot hide it',async t=>{
 const {db,api,create}=await fixture(t),text=('甲：'+ '原'.repeat(900)+'。\n').repeat(32),project=await create(text);
 assert.equal(await db.episode.count({where:{projectId:project.id}}),0);
 const queued=await api.queueFoundationDelivery(project.id,{autoAssetPrompts:false},db);let calls=0;
 await api.executeFoundationDelivery(project.id,queued.id,{db,stageRunner:async(stage,prompt)=>{
  assert.equal(stage,'F1');calls++;const request=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
  return output(request.batch.index===1?{...response(request),assignments:[]}:response(request,'2x'));
 }});
 assert.equal(calls,2);const state=await api.getFoundationDeliveryState(project.id,db);
 assert.equal(state.task?.status,'PARTIAL');assert.equal(state.action,'BLOCKED');assert.match(state.continuationBlocker!,/已付费|接收/);
 const before=await db.pipelineRun.count({where:{projectId:project.id}});
 await assert.rejects(()=>api.queueFoundationDelivery(project.id,{expectedState:state.expectedState},db),/已付费|接收/);
 assert.equal(await db.pipelineRun.count({where:{projectId:project.id}}),before);
});

for(const savedKind of ['body','context'] as const)test(`a historical ${savedKind} string-number receipt is revalidated for free, recorded separately, then resumes the next batch`,async t=>{
 const {db,api,create,store,source}=await fixture(t),text=('甲：'+ '原'.repeat(900)+'。\n').repeat(32),project=await create(text);
 const task=await api.queueFoundationDelivery(project.id,{autoAssetPrompts:false},db),input=await source.readSourcePreparation(project.id,db);
 const savedRequest=requestFor(text,input.sourceInputVersion),current=(await store.readFidelityReceipt(project.id,db))!,bounds={start:savedRequest.sections[0].start,end:savedRequest.sections.at(-1)!.end};
 savedRequest.sections[0].before='';
 savedRequest.issues=current.receipt.result.validation.issues.filter(i=>i.start<bounds.end&&i.end>bounds.start).map(i=>({code:i.code,message:i.message,sectionKeys:savedRequest.sections.filter(b=>b.start<i.end&&b.end>i.start).map(b=>b.key)}));
 savedRequest.baseline=current.receipt.result.episodes.filter(e=>e.start<bounds.end&&e.end>bounds.start).map(e=>({episodeNumber:e.sourceNumber,start:e.start,end:e.end}));
 const wire=projectP1ReviewRequest(savedRequest),data=response(savedRequest,'2','1');data.assignments[0].kind=savedKind;
 const workFingerprint=hash({receiver:'FIDELITY_SOURCE_ACCEPT_V2',request:projectP1ReviewEvidenceRequest(wire as unknown as Record<string,unknown>)});
 // Fixture for the persisted pre-fix failure: no live request is made to manufacture it.
 const old=await db.pipelineRun.create({data:{projectId:project.id,stageCode:'F1',roleName:'来源疑点整理',provider:'CLI',status:'FAILED',error:'P1集场归属无效。',
  inputSummary:JSON.stringify({deliveryTaskId:task.id,workerToken:task.workerToken,phase:'PREPARE_SOURCE',sourceInputVersion:input.sourceInputVersion,sourceTextFingerprint:hash(text),receiverVersion:'FIDELITY_SOURCE_ACCEPT_V2',workFingerprint}),
  log:JSON.stringify({calls:[{sequence:1,kind:'INITIAL',scope:[],systemPrompt:'synthetic',taskPrompt:`INPUT_JSON:\n${JSON.stringify(wire)}`,provider:'CLI',model:'synthetic',reasoningEffort:'low',startedAt:new Date().toISOString(),status:'FAILED',requestOutcome:'RESPONDED',providerCallCount:1,response:output(data),error:'P1集场归属无效。',issues:[]}]})}});
 const taskRow=await db.sceneSnapshot.findUniqueOrThrow({where:{id:`foundation-delivery-${project.id}`}});
 await db.sceneSnapshot.update({where:{id:taskRow.id},data:{content:JSON.stringify({...JSON.parse(taskRow.content),status:'PARTIAL',workerPid:null,error:'P1集场归属无效。'})}});
 const state=await api.getFoundationDeliveryState(project.id,db);assert.equal(state.continuationBlocker,null,'合法历史响应可以走免费重验，不能被旧失败状态永久卡死');
 const resumed=await api.queueFoundationDelivery(project.id,{expectedState:state.expectedState,autoAssetPrompts:false},db);let attempted=0;
 await api.executeFoundationDelivery(project.id,resumed.id,{db,stageRunner:async(_stage,prompt)=>{
  const request=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);attempted++;assert.equal(request.batch.index,2,'不得重购已经保存的第一批');
  throw Object.assign(new Error('离线测试到达下一批，未发送'),{requestOutcome:'NOT_SENT'});
 }});
 assert.equal(attempted,1);assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({where:{id:old.id}}),old,'原FAILED回包逐字段保持不变');
 const receipt=(await store.readFidelityReceipt(project.id,db))!;assert.equal(receipt.receipt.p1Review?.completedRanges?.length,1);
 const accepted=receipt.receipt.p1Review!.pendingDecisions![0];assert.equal(accepted.kind,savedKind);
 if(savedKind==='context'){assert.equal(Object.hasOwn(accepted,'episodeNumber'),false);assert.equal(Object.hasOwn(accepted,'sceneNumber'),false);}
 const revalidated=await db.pipelineRun.findUniqueOrThrow({where:{id:receipt.receipt.p1Review!.runIds![0]}});
 assert.notEqual(revalidated.id,old.id);const evidence=JSON.parse(revalidated.log!);
 assert.equal(evidence.revalidation.fromRunId,old.id);assert.equal(evidence.revalidation.providerCallCount,0);assert.deepEqual(evidence.calls,[]);
 assert.equal((await api.getFoundationDeliveryState(project.id,db)).task?.addedCalls,1,'本地重验不是新增模型调用');
});
