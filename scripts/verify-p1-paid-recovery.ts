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
import {FoundationContractError,PROJECT_FOUNDATION_STAGES} from '../lib/project-foundation-contracts';
import {DeliveryCallError,hasSafeDeliveryFormatRepair,runFoundationDeliveryCall} from '../lib/foundation-delivery-call';

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
test('P1 input labels and returned canonical Chinese indices share lossless numeric meaning without changing paid evidence',()=>{
 const request=requestFor('第十九集\n19-1 日 外 城门\n甲：原话不改。\n');
 request.baseline=[{episodeNumber:'十九',start:0,end:request.sourceLength}];
 const wire=projectP1ReviewRequest(request),before=structuredClone(wire),fingerprint=hash(projectP1ReviewEvidenceRequest(wire as unknown as Record<string,unknown>));
 assert.equal(wire.baseline[0].episodeNumber,'十九','原始标签保留，不偷换旧请求/工作指纹');
 for(const [episode,scene,number,sceneNumber]of [['十九','一',19,1],['二十','两',20,2],['一百零二','十一',102,11],['二零二六','三',2026,3],['零','一',0,1]] as const){
  const raw=response(request,episode,scene),saved=structuredClone(raw),decision=validateP1ReviewPlan(raw,request).decisions[0];
  assert.equal(decision.episodeNumber,number);assert.equal(decision.sceneNumber,sceneNumber);assert.deepEqual(raw,saved);
 }
 assert.deepEqual(wire,before);assert.equal(hash(projectP1ReviewEvidenceRequest(wire as unknown as Record<string,unknown>)),fingerprint);
 for(const number of ['一百二','十十','零十九','第十九集','１９','二十x','零一','一两','两三','三两','两十','二十两'])assert.throws(()=>validateP1ReviewPlan(response(request,number),request),/集场/);
 assert.throws(()=>validateP1ReviewPlan(response(request,'十九','零'),request),/集场/);
});
test('P1 blockers identify the exact field and never authorize paid guessing',()=>{
 const request=requestFor('甲：原话不改。\n');
 const cases:Array<[string,(raw:ReturnType<typeof response>)=>void]>=[
  ['response',raw=>{(raw as Record<string,unknown>)['']='unexpected';}],
  ['sourceVersion',raw=>{raw.sourceVersion='stale';}],
  ['reviewed.lastBlock',raw=>{raw.reviewed.lastBlock='B999999';}],
  ['assignments.0.episodeNumber',raw=>{raw.assignments[0].episodeNumber='二十x';}],
  ['assignments.0.sceneNumber',raw=>{raw.assignments[0].sceneNumber=0;}],
  ['assignments.0.firstBlock',raw=>{raw.assignments[0].firstBlock='B999999';}],
  ['assignments.0.note',raw=>{raw.assignments[0].note='';}]
 ];
 for(const [coordinate,change]of cases){const raw=response(request);change(raw);
  assert.throws(()=>validateP1ReviewPlan(raw,request),error=>error instanceof FoundationContractError&&error.issues[0].coordinate===coordinate&&(error as FoundationContractError&{recoveryPolicy?:string}).recoveryPolicy==='LOCAL_ONLY');
 }
});
test('P1 field diagnostics persist through the real call controller without purchasing a fallback',async()=>{
 const request=requestFor('甲：原话不改。\n'),raw=response(request,'二十x');let calls=0,budgetChecks=0;
 await assert.rejects(runFoundationDeliveryCall({stage:'F1',prompt:'offline fixture',context:{projectId:'offline-only',provider:'CLI',role:{...PROJECT_FOUNDATION_STAGES[0],systemPrompt:'offline only'},sessionMode:'ephemeral',runId:'offline',batchToken:'offline',sourceVersion:'synthetic-source',inputVersion:'synthetic-source',chunkIndex:1,scope:[]},
  validate:value=>validateP1ReviewPlan(value,request),runner:async()=>{calls++;return output(raw);},takeRepairBudget:async()=>{budgetChecks++;return true;}}),error=>{
   assert.ok(error instanceof DeliveryCallError);assert.equal(error.issues[0].coordinate,'assignments.0.episodeNumber');assert.equal(error.attempts.length,1);
   assert.equal(hasSafeDeliveryFormatRepair(error.attempts[0],'F1'),false);assert.deepEqual(error.attempts[0].response?.data,raw);return true;
  });
 assert.equal(calls,1);assert.equal(budgetChecks,0);
});
test('a saved LOCAL_ONLY prohibition survives a later validator policy change while free revalidation remains allowed',async()=>{
 const request=requestFor('甲：原话不改。\n'),raw=response(request,'二十x');let calls=0,budgetChecks=0;
 const context={projectId:'offline-only',provider:'CLI' as const,role:{...PROJECT_FOUNDATION_STAGES[0],systemPrompt:'offline only'},sessionMode:'ephemeral' as const,runId:'offline',batchToken:'offline',sourceVersion:'synthetic-source',inputVersion:'synthetic-source',chunkIndex:1,scope:[]};
 const saved={sequence:1,kind:'INITIAL' as const,scope:[],systemPrompt:'offline only',taskPrompt:'offline fixture',provider:'CLI' as const,model:'synthetic',reasoningEffort:'low',startedAt:new Date().toISOString(),status:'FAILED' as const,requestOutcome:'RESPONDED' as const,providerCallCount:1,response:output(raw),recoveryPolicy:'LOCAL_ONLY' as const,issues:[{severity:'BLOCKER' as const,owner:'PROGRAM' as const,coordinate:'assignments.0.episodeNumber',problem:'不安全数字',sourceRefs:[]}]};
 const common={stage:'F1' as const,prompt:'offline fixture',context,resumeFrom:saved,runner:async()=>{calls++;return output(response(request,20));},takeRepairBudget:async()=>{budgetChecks++;return true;}};
 await assert.rejects(runFoundationDeliveryCall({...common,validate:()=>{throw new FoundationContractError('new receiver still rejects field',saved.issues);}}),DeliveryCallError);
 assert.equal(calls,0);assert.equal(budgetChecks,0);
 const recovered=await runFoundationDeliveryCall({...common,validate:()=>({accepted:true})});assert.deepEqual(recovered.output,{accepted:true});assert.deepEqual(recovered.attempts,[]);assert.equal(calls,0);
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

for(const [savedKind,savedNumber]of [['body','2'],['context','2'],['body','二'],['context','二']] as const)test(`a historical ${savedKind} ${savedNumber} receipt is revalidated for free, recorded separately, then resumes the next batch`,async t=>{
 const {db,api,create,store,source}=await fixture(t),text=('甲：'+ '原'.repeat(900)+'。\n').repeat(32),project=await create(text);
 const task=await api.queueFoundationDelivery(project.id,{autoAssetPrompts:false},db),input=await source.readSourcePreparation(project.id,db);
 const savedRequest=requestFor(text,input.sourceInputVersion),current=(await store.readFidelityReceipt(project.id,db))!,bounds={start:savedRequest.sections[0].start,end:savedRequest.sections.at(-1)!.end};
 savedRequest.sections[0].before='';
 savedRequest.issues=current.receipt.result.validation.issues.filter(i=>i.start<bounds.end&&i.end>bounds.start).map(i=>({code:i.code,message:i.message,sectionKeys:savedRequest.sections.filter(b=>b.start<i.end&&b.end>i.start).map(b=>b.key)}));
 savedRequest.baseline=current.receipt.result.episodes.filter(e=>e.start<bounds.end&&e.end>bounds.start).map(e=>({episodeNumber:e.sourceNumber,start:e.start,end:e.end}));
 const wire=projectP1ReviewRequest(savedRequest),data=response(savedRequest,savedNumber,savedNumber==='二'?'一':'1');data.assignments[0].kind=savedKind;
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

test('the product saved-only recovery accepts Chinese-number evidence once and stops before any unfinished request',async t=>{
 const {db,api,create,store,source}=await fixture(t),text=('甲：'+ '原'.repeat(900)+'。\n').repeat(32),project=await create(text);
 const task=await api.queueFoundationDelivery(project.id,{autoAssetPrompts:false},db),input=await source.readSourcePreparation(project.id,db),current=(await store.readFidelityReceipt(project.id,db))!;
 const request=requestFor(text,input.sourceInputVersion),bounds={start:request.sections[0].start,end:request.sections.at(-1)!.end};
 request.issues=current.receipt.result.validation.issues.filter(i=>i.start<bounds.end&&i.end>bounds.start).map(i=>({code:i.code,message:i.message,sectionKeys:request.sections.filter(b=>b.start<i.end&&b.end>i.start).map(b=>b.key)}));
 request.baseline=current.receipt.result.episodes.filter(e=>e.start<bounds.end&&e.end>bounds.start).map(e=>({episodeNumber:e.sourceNumber,start:e.start,end:e.end}));
 const wire=projectP1ReviewRequest(request),data=response(request,'二','一'),workFingerprint=hash({receiver:'FIDELITY_SOURCE_ACCEPT_V2',request:projectP1ReviewEvidenceRequest(wire as unknown as Record<string,unknown>)});
 const old=await db.pipelineRun.create({data:{projectId:project.id,stageCode:'F1',roleName:'历史P1回包',provider:'CLI',status:'FAILED',error:'P1集场归属无效。',inputSummary:JSON.stringify({deliveryTaskId:task.id,workerToken:task.workerToken,phase:'PREPARE_SOURCE',sourceInputVersion:input.sourceInputVersion,sourceTextFingerprint:hash(text),workFingerprint,receiverVersion:'FIDELITY_SOURCE_ACCEPT_V2'}),log:JSON.stringify({calls:[{sequence:1,kind:'INITIAL',scope:[],systemPrompt:'synthetic',taskPrompt:`INPUT_JSON:\n${JSON.stringify(wire)}`,provider:'CLI',model:'synthetic',reasoningEffort:'low',startedAt:new Date().toISOString(),status:'FAILED',requestOutcome:'RESPONDED',providerCallCount:1,response:output(data),error:'P1集场归属无效。',issues:[]}]})}});
 const row=await db.sceneSnapshot.findUniqueOrThrow({where:{id:`foundation-delivery-${project.id}`}});
 await db.sceneSnapshot.update({where:{id:row.id},data:{content:JSON.stringify({...JSON.parse(row.content),status:'PARTIAL',workerPid:null,error:'P1集场归属无效。'})}});
 const before=await api.getFoundationDeliveryState(project.id,db),after=await api.recoverSavedFoundationDelivery(project.id,before.expectedState,db);
 assert.equal(after.task?.status,'PARTIAL');assert.equal(after.task?.error,null);assert.match(after.task!.message,/未发起新请求/);
 const all=await db.pipelineRun.findMany({where:{projectId:project.id}});assert.equal(all.length,2,'只有原回包及一份零模型派生证明，没有下一批NOT_SENT占位或模型请求');
 assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({where:{id:old.id}}),old);
 const proof=all.find(r=>r.id!==old.id)!,evidence=JSON.parse(proof.log!);
 assert.equal(evidence.revalidation.acceptanceVersion,'P1_ASSIGNMENT_TRANSPORT_V3');assert.equal(evidence.revalidation.providerCallCount,0);assert.deepEqual(evidence.calls,[]);
 assert.equal(JSON.parse(proof.outputSummary!).normalizedDecisions[0].episodeNumber,2);
 assert.equal((await store.readFidelityReceipt(project.id,db))!.receipt.p1Review!.completedRanges!.length,1);
 await api.recoverSavedFoundationDelivery(project.id,after.expectedState,db);
 assert.equal(await db.pipelineRun.count({where:{projectId:project.id}}),2,'重复零模型恢复不重验已采用批次、不增加证明');
});
