/** Offline orchestration adapter verification. No production DB, process or provider invocation. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {currentProductionBudget,productionBudgetStore,budgetedProductionCall} from '../lib/production-budget';

async function main(){
 const adapterModule=await import('../lib/production-workflow').catch((error:any)=>error.code==='MODULE_NOT_FOUND'||error.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(error)) as any;
 assert.equal(typeof adapterModule.createProductionWorkflowAdapters,'function','缺少真实服务可注入的工作流适配器');
 assert.equal(typeof adapterModule.productionWorkflowSourceVersion,'function');
 const basis={sourceVersion:'body',sourceContext:{version:'metadata-1',background:[{key:'x',text:'原文背景'}],unresolved:[]},scriptInterpretationVersions:{1:'meaning'}};
 const sourceHash=adapterModule.productionWorkflowSourceVersion(basis);
 assert.equal(sourceHash,adapterModule.productionWorkflowSourceVersion({...basis,sourceContext:{...basis.sourceContext,version:'metadata-2'}}),'元数据刷新不是源变更');
 assert.notEqual(sourceHash,adapterModule.productionWorkflowSourceVersion({...basis,sourceContext:{...basis.sourceContext,background:[{key:'x',text:'背景已改'}]}}),'背景真源变更必须识别');
 const directory=await mkdtemp(path.join(tmpdir(),'production-workflow-adapter-'));
 try{
  const budgetDirectory=path.join(directory,'budget'),events:string[]=[],runs:Record<string,any>={};let complete=false,directionStatus='UNCONFIRMED',draft:any=null;
  const episode={id:'ep1',projectId:'p',number:1,title:'第一集',content:'第一集\n1-1 日 内 房间\n人物：甲\n△甲抬手。\n甲：我知道了。\n',project:{id:'p'}};
  const bill=async(stage:string)=>{assert.ok(currentProductionBudget(),'所有真实阶段需继承同一预算上下文');events.push(stage);return budgetedProductionCall({projectId:'p',provider:'API',stage},async()=>({usage:{totalTokens:8}}));};
  const services:any={
   readInputs:async()=>({sourceVersion:'s1',sourceContext:{complete:true,issues:[],unresolved:[],notices:[]},sourceIndex:{episodes:[episode]},project:{episodes:[episode]}}),
   readStage1:async()=>({complete,busy:false,action:complete?'NONE':'START',document:{f2:null},requiredChoices:[],issues:[],expectedState:'stage1-state'}),
   readDirection:async()=>({source:{sourceVersion:'direction-s1',episodes:[episode],blocker:null},stateToken:'direction-state',status:directionStatus,draft,generation:null,generationPlan:{allowed:true}}),
   readScope:async()=>({sourceKnown:true,episodeNumbers:[1]}),
   readAssets:async()=>({assets:[],records:{},busy:false}),
   planAssets:async(_p:string,n:number[],k:string[])=>{assert.deepEqual(n,[1]);assert.deepEqual(k,[]);return {assetKeys:[],eligibleKeys:[]};},
   readAdoptions:async()=>({assets:{}}),
   queueStage1:async(_p:string,options:any)=>{assert.equal(options.autoAssetPrompts,false);assert.equal(options.expectedState,'stage1-state');events.push('queue');return {id:'stage1-task',workerToken:'token'};},
   executeStage1:async()=>{await bill('stage1');complete=true;return {id:'stage1-task',status:'COMPLETE'};},
   generateDirection:async(_p:string,_a:string,command:any)=>{assert.equal(command.costAcknowledged,true);assert.equal(command.stateToken,'direction-state');await bill('direction');draft={hash:'draft'};return {};},
   generateAssets:async()=>{throw new Error('未选择材料时不得全库生成');},
   episode:async()=>episode,
   createStoryboard:async(_e:any,command:any)=>{assert.equal(command.productionBudget.id,currentProductionBudget()?.id);assert.equal(command.productionChain.mode,'CHAIN');assert.deepEqual(command.productionChain.episodeNumbers,[1]);events.push('create');runs.r={id:'r',web:{binding:{projectId:'p',episodeId:'ep1',episodeNumber:1,productionBudget:command.productionBudget,productionChain:command.productionChain}},status:'created',operations:[]};return runs.r;},
   readStoryboard:async(id:string)=>runs[id],
   storyboardView:async(run:any)=>({id:run.id,status:run.status,active:false,sourceStale:false,blocked:false,error:null,production:{chainComplete:run.production?.chainComplete??true},assembly:run.assembly?{text:'稿',errors:[]}:null}),
   startStoryboard:async(id:string)=>{await bill('storyboard');runs[id].status='text_ready_for_review';runs[id].assembly={text:'完整整编稿',validation:{errors:[]}};return runs[id];},
   pauseStoryboard:async()=>{},refreshChain:async()=>{events.push('refresh');},
  };
  const require=createRequire(import.meta.url),runtime=require('../runtime/production-workflow.mjs');
  const adapters=adapterModule.createProductionWorkflowAdapters('u',services);
  const service=runtime.createProductionWorkflowService({directory:path.join(directory,'workflow'),budgetDirectory,adapters});
  let view=await service.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});const id=view.workflow.id;
  await service.inspect(id);assert.deepEqual(events,[],'只读检查没有任何派单或写入');
  const partialAdapters=adapterModule.createProductionWorkflowAdapters('u',{...services,queueStage1:async()=>({id:'partial-task',workerToken:'token'}),executeStage1:async()=>({status:'PARTIAL',message:'首批回包保留',error:'P1接收未通过'})});
  const partial=await partialAdapters.run({kind:'STAGE1'},view.workflow,{bind:async()=>{},budget:{id:view.workflow.budgetId,directory:budgetDirectory},isPaused:async()=>false});
  assert.deepEqual(partial,{taskId:'partial-task',status:'PARTIAL',message:'首批回包保留',error:'P1接收未通过'},'真实适配器不能隐藏PARTIAL的接收错误或宣称source完成');
  view=await service.advance(id,{expectedRevision:view.workflow.revision,actorId:'u'});
  assert.deepEqual(events,['queue','stage1']);assert.equal(view.workflow.receipts[0].taskId,'stage1-task');
  view=await service.advance(id,{expectedRevision:view.workflow.revision,actorId:'u'});assert.equal(view.nextAction.kind,'WAIT_DIRECTION_CONFIRM');
  directionStatus='CONFIRMED';view=await service.inspect(id);assert.equal(view.nextAction.kind,'STORYBOARD_CREATE');
  view=await service.advance(id,{expectedRevision:view.workflow.revision,actorId:'u'});assert.equal(view.nextAction.kind,'QUALITY_CHECK');
  assert.deepEqual(events,['queue','stage1','direction','create','refresh','storyboard']);
  const ledger=await productionBudgetStore(budgetDirectory).read(view.workflow.budgetId);assert.equal(ledger.summary.calls,3);assert.equal(ledger.summary.knownTokens,24);
  assert.deepEqual((await service.getProductionChain(id,'p')).selectedRuns,{'1':'r'});
  await assert.rejects(()=>service.getProductionChain(id,'other'));
  for(const status of ['PRELIMINARY','UNRESOLVED']){
   runs.r.production={chainComplete:false,boundaryCheck:{status},needs:[]};
   const run=await adapters.readRun('r',view.workflow);assert.equal(run.complete,false,`${status}链稿不能冒充可交付成稿`);
   view=await service.inspect(id);assert.equal(view.nextAction.kind,'WAIT_CONTINUITY');
   const before:number=events.length;view=await service.advance(id,{expectedRevision:view.workflow.revision,actorId:'u'});assert.equal(events.length,before,'承接缺失不触发无效start循环');
  }
  const pending={versionId:'repair-v1',packageIds:['p1'],reason:'CONSUMED_MATERIAL',changedKeys:[]};
  runs.r.production={chainComplete:false,boundaryCheck:{status:'MATCHED'},pendingRepair:pending,blocking:false,needs:[{resolved:true,blocking:true}]};
  assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,true,'已解决历史需求不阻断已定位的局部增量修复');
  assert.equal((await service.inspect(id)).nextAction.kind,'STORYBOARD_CONTINUE');
  const beforeScoped:any=runs.r.production;
  runs.r.plan={workPackages:[{id:'p1'},{id:'p2'},{id:'p3'}]};
  runs.r.production={...beforeScoped,blocking:true,globalBlocking:false,pendingRepair:{...pending,packageIds:['p1','p2']},needs:[{blocking:true,resolved:false,packageIds:['p3']}]};
  const scopedRun:any=await adapters.readRun('r',view.workflow);
  assert.equal(scopedRun.blocked,true,'整集缺料门保持，不冒充整集可用');
  assert.equal(scopedRun.canAutoRepair,true,'p3缺料不能阻止调度器已允许的p1/p2局部增量修复');
  assert.equal((await service.inspect(id)).nextAction.kind,'STORYBOARD_CONTINUE');
  runs.r.production.pendingRepair.packageIds.push('p3');
  assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,false,'修复触及缺料p3必须等候');
  runs.r.production.pendingRepair.packageIds=['p1','p2'];runs.r.production.globalBlocking=true;
  assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,false,'全局硬冲突不得按局部范围绕过');
  runs.r.production.globalBlocking=false;runs.r.production.pendingRepair=null;
  assert.equal((await service.inspect(id)).nextAction.kind,'NEED_UPSTREAM','没有已定位pendingRepair时仍禁止普通启动');
  runs.r.production=beforeScoped;delete runs.r.plan;
  for(const patch of [{blocking:true},{boundaryCheck:{status:'CONSTRAINT_CONFLICT'}},{needs:[{blocking:true,resolved:false,supplyUpdated:false}]}]){
   const saved=runs.r.production;runs.r.production={...saved,...patch};assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,false);runs.r.production=saved;
  }
  for(const status of ['unknown','usage_review','interrupted','failed','stopped','budget_stop','awaiting_confirmation','needs_design']){
   runs.r.status=status;assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,false,`${status}不能被pendingRepair绕过`);
  }
  runs.r.status='text_ready_for_review';runs.r.operations=[{status:'completed',issues:[{productionVersion:'repair-v1'}]}];
  assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,false,'同版本修复无进展不得重复派单');
  runs.r.operations=[{status:'unknown'}];assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,false,'表面状态已就绪也不能掩盖未知作业');
  const missingRepair=runs.r.production.pendingRepair;runs.r.production.pendingRepair=null;runs.r.production.chainComplete=true;
  assert.equal((await adapters.readRun('r',view.workflow)).complete,false,'未知回执也不能冒充已完成稿');
  runs.r.production.pendingRepair=missingRepair;runs.r.production.chainComplete=false;
  runs.r.operations=[];runs.r.production.needs=[{blocking:false,resolved:false,supplyUpdated:true}];
  assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,true,'材料已补给后由已有delta消费，无需额外人工审批');
  const start=services.startStoryboard;services.startStoryboard=async(runId:string)=>{assert.equal(runId,'r');await bill('repair');runs.r.production={chainComplete:true,boundaryCheck:{status:'MATCHED'},needs:[]};return runs.r;};
  view=await service.advance(id,{expectedRevision:view.workflow.revision,actorId:'u'});
  assert.equal(view.nextAction.kind,'QUALITY_CHECK');assert.equal(events.at(-1),'repair');services.startStoryboard=start;
  const need={stage:2,target:'door',purpose:'只补本镜反锁铁门的开向',packageIds:['p1'],sourceRefs:['L4'],blocking:true};
  runs.r.status='waiting_dependencies';runs.r.production={blocking:true,needs:[need]};
  services.planAssets=async(_p:string,n:number[],k:string[])=>({assetKeys:k,eligibleKeys:k,scope:{episodeNumbers:n}});
  services.generateAssets=async(_p:string,n:number[],options:any)=>{
   assert.deepEqual(n,[1]);assert.deepEqual(options.assetKeys,['door']);assert.equal(options.materialNeeds.length,1);
   const received=options.materialNeeds[0];assert.equal(received.workflowId,id);assert.equal(received.runId,'r');assert.equal(received.episodeNumber,1);assert.equal(received.sourceVersion,'s1');
   assert.ok(received.needRef.startsWith(received.requestId+':'));assert.deepEqual(received.sourceRefs,['L4']);assert.deepEqual(received.packageIds,['p1']);
   await bill('material');return {assetKeys:['door'],results:[{key:'door',status:'READY'}]};
  };
  view=await service.requestMaterials(id,{expectedRevision:view.workflow.revision,actorId:'u',needs:[{runId:'r',target:'door',sourceRefs:['L4'],packageIds:['p1']}]});
  const materialAction=view.nextAction;
  assert.equal((await productionBudgetStore(budgetDirectory).read(view.workflow.budgetId)).summary.calls,4,'registration is free');
  view=await service.advance(id,{expectedRevision:view.workflow.revision,actorId:'u'});assert.equal(view.workflow.materialRequests[0].status,'CANDIDATES_SAVED');
  assert.equal((await productionBudgetStore(budgetDirectory).read(view.workflow.budgetId)).summary.calls,5);
  services.readMaterialReceipts=async()=>[{status:'READY',key:'door',scope:{workflowId:id,runId:'r',episodeNumber:1,sourceVersion:'s1'},needRefs:materialAction.materialNeeds.map((n:any)=>n.needRef)}];
  assert.equal(await adapters.recoverAction(view.workflow,materialAction),true,'真实已落库的精确候选回执可免费恢复');
  services.readMaterialReceipts=async()=>[{status:'READY',key:'door',scope:{workflowId:'foreign',runId:'r',episodeNumber:1,sourceVersion:'s1'},needRefs:materialAction.materialNeeds.map((n:any)=>n.needRef)}];
  assert.equal(await adapters.recoverAction(view.workflow,materialAction),false,'不能借用其它流程候选解除恢复门');
  services.generateAssets=async(_p:string,_n:number[],options:any)=>{assert.equal('materialNeeds' in options,false,'普通明确资产请求不能携空needs误入局部反馈路径');return {assetKeys:['door'],results:[]};};
  await adapters.withBudget({id:view.workflow.budgetId,directory:budgetDirectory},()=>adapters.run({kind:'ASSETS',assetKeys:['door']},view.workflow,{budget:{id:view.workflow.budgetId,directory:budgetDirectory},bind:async()=>{},isPaused:async()=>false}));
  console.log('PASS production workflow real adapters: stage order, receipts, shared ALS budget, zero default generation, read-only inspect, chain and exact scoped material need binding; all providers/services synthetic');
 }finally{await rm(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
