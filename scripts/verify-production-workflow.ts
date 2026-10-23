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
  const inspectionBase={...services,readStage1:async(p:string)=>({...await services.readStage1(p),complete:true}),readDirection:async(p:string,a:string)=>({...await services.readDirection(p,a),status:'CONFIRMED'})};
  const beforeInspectionEvents=[...events];
  for(const slot of ['readInputs','readStage1','readScope','readDirection','readAssets','planAssets','readAdoptions'] as const){
   const counts:Record<string,number>={};const oneFailure:any={...inspectionBase};
   for(const key of ['readInputs','readStage1','readScope','readDirection','readAssets','planAssets','readAdoptions'] as const){const original:any=inspectionBase[key];oneFailure[key]=async(...args:any[])=>{counts[key]=(counts[key]??0)+1;if(key===slot&&counts[key]===1)throw Object.assign(new Error('合成只读锁超时'),{code:'P1008'});return original(...args);};}
   const isolated=adapterModule.createProductionWorkflowAdapters('u',oneFailure);
   const seen=await isolated.inspect({...view.workflow,criticalAssetKeys:['synthetic-critical']});
   assert.equal(seen.sourceVersion,view.workflow.sourceVersion);assert.equal(counts[slot],2,`${slot}只重做完整读取，不派生产调用`);
   assert.ok(counts.readInputs>=2,'不同读槽失败后必须重新装配整份快照');
  }
  let persistentReads=0;const persistent=adapterModule.createProductionWorkflowAdapters('u',{...inspectionBase,readInputs:async()=>{persistentReads++;throw Object.assign(new Error('合成持久锁超时'),{code:'P1008'});}});
  await assert.rejects(()=>persistent.inspect(view.workflow),(e:any)=>e.code==='P1008');assert.equal(persistentReads,3,'至多原读加两次，不无限重试');
  for(const code of ['SOURCE_STALE','WORKFLOW_FORBIDDEN','DIRECTION_CONFLICT']){let reads=0;const hard=adapterModule.createProductionWorkflowAdapters('u',{...inspectionBase,readInputs:async()=>{reads++;throw Object.assign(new Error('明确源或权限冲突'),{code});}});await assert.rejects(()=>hard.inspect(view.workflow),(e:any)=>e.code===code);assert.equal(reads,1);}
  assert.deepEqual(events,beforeInspectionEvents,'只读恢复不能触发队列、写入、模型或补料');
  const supplementAdapters=adapterModule.createProductionWorkflowAdapters('u',{...services,readStage1:async()=>({...await services.readStage1(),complete:true}),readDirection:async()=>({...await services.readDirection(),foundationPreparation:{status:'NEEDS_SUPPLEMENT'}})});
  const supplementService=runtime.createProductionWorkflowService({directory:path.join(directory,'missing-direction'),budgetDirectory,adapters:supplementAdapters});
  let supplement=await supplementService.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
  assert.equal(supplement.nextAction.kind,'WAIT_DIRECTION_REPAIR','A missing optional side result must not silently buy another whole-script read.');
  supplement=await supplementService.advance(supplement.workflow.id,{expectedRevision:supplement.workflow.revision,actorId:'u'});
  assert.equal(supplement.nextAction.kind,'WAIT_DIRECTION_REPAIR');assert.deepEqual(events,[]);
  assert.equal((await productionBudgetStore(budgetDirectory).read(supplement.workflow.budgetId)).summary.calls,0);
  const sharedAdapters=adapterModule.createProductionWorkflowAdapters('u',{...services,readStage1:async()=>({...await services.readStage1(),complete:true}),readDirection:async()=>({...await services.readDirection(),draft:{sourceVersion:'direction-s1'},foundationPreparation:{status:'CANDIDATE_READY'},generationPlan:{allowed:false,reason:'独立补充分析超限'}})});
  const sharedService=runtime.createProductionWorkflowService({directory:path.join(directory,'shared-direction'),budgetDirectory,adapters:sharedAdapters});
  const shared=await sharedService.create({projectId:'p',actorId:'u',episodeNumbers:[1],costAcknowledged:true});
  assert.equal(shared.nextAction.kind,'WAIT_DIRECTION_CONFIRM','An extra-analysis budget must not block a candidate already generated by the shared read.');assert.deepEqual(events,[]);
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
  // Bound-empty admission is evidence for recovery only, not permission to skip a new source/material check.
  const beforeEmptyRun=structuredClone(runs.r),beforeEmptyView=services.storyboardView;
  const emptyRun={...structuredClone(runs.r),status:'created',plan:null,assembly:null,operations:[],candidates:[],adopted:[],
   web:{...structuredClone(runs.r.web),owner:null,reserved:0,reservedAttemptIds:[],stopped:false,pauseRequested:false,sourceStale:false},
   production:{needs:[],blocking:false,boundaryCheck:{status:'NO_PREDECESSOR'}}};
  const emptyView={status:'created',active:false,sourceStale:false,blocked:false,legacyReadOnly:false,preparation:{ready:true},usage:{unknownAttempts:0,acknowledgedUnknownAttempts:0,knownTokens:0},production:{chainComplete:false}};
  runs.r=structuredClone(emptyRun);services.storyboardView=async()=>structuredClone(emptyView);
  assert.equal((await adapters.readRun('r',view.workflow)).emptyAdmission,true,'已绑定、无请求/候选/预留且源版本当前的空任务应提供可恢复证明');
  for(const change of [
   (r:any)=>r.operations.push({status:'completed'}),(r:any)=>r.candidates.push({status:'received'}),(r:any)=>r.adopted.push('old'),
   (r:any)=>r.plan={},(r:any)=>r.assembly={text:'paid'},(r:any)=>r.web.owner={pid:1},(r:any)=>r.web.reserved=1,
   (r:any)=>r.web.reservedAttemptIds.push('reserved'),(r:any)=>r.web.stopped=true,(r:any)=>r.web.pauseRequested=true,(r:any)=>r.web.sourceStale=true,
   (r:any)=>r.production.blocking=true,(r:any)=>r.production.boundaryCheck.status='CONSTRAINT_CONFLICT',
   (r:any)=>r.web.binding.productionChain.id='foreign',(r:any)=>r.web.binding.productionBudget.id='foreign',
   (r:any)=>r.web.budget={maxCalls:0,maxTokens:600000}
  ]){runs.r=structuredClone(emptyRun);change(runs.r);assert.equal((await adapters.readRun('r',view.workflow)).emptyAdmission,false);}
  runs.r=structuredClone(emptyRun);
  for(const patch of [{active:true},{sourceStale:true},{blocked:true},{legacyReadOnly:true},{status:'needs_design'},{preparation:{ready:false}},{usage:{unknownAttempts:1,knownTokens:0}},{usage:{unknownAttempts:0,knownTokens:1}}]){
   services.storyboardView=async()=>({...structuredClone(emptyView),...patch});assert.equal((await adapters.readRun('r',view.workflow)).emptyAdmission,false);
  }
  services.storyboardView=async()=>structuredClone(emptyView);
  const beforeEmptyInputs=services.readInputs;services.readInputs=async()=>({...await beforeEmptyInputs(),sourceVersion:'changed'});
  assert.equal((await adapters.readRun('r',view.workflow)).emptyAdmission,false,'真实源版本漂移不能借空任务恢复越过');
  services.readInputs=beforeEmptyInputs;services.storyboardView=beforeEmptyView;runs.r=beforeEmptyRun;
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
  const beforeRiskRun=structuredClone(runs.r),beforeRiskView=services.storyboardView;
  runs.r.status='unknown';runs.r.web.progress='paused';runs.r.production={chainComplete:false,boundaryCheck:{status:'MATCHED'},needs:[],blocking:false};
  runs.r.operations=[{status:'unknown',localSettledAt:new Date().toISOString(),cancelAcknowledgement:{acceptUnknownUsage:true},error:{requestOutcome:'UNKNOWN'}}];
  services.storyboardView=async()=>({status:'paused',active:false,sourceStale:false,blocked:false,preparation:{ready:true},usage:{unknownAttempts:1,acknowledgedUnknownAttempts:1},production:{blocking:false,chainComplete:false}});
  assert.equal((await adapters.readRun('r',view.workflow)).blocked,false,'单次未知费用已明确确认后可续未完成步骤；用量仍未知且共享账本另有门禁');
  runs.r.status='failed';runs.r.web.progress='failed';runs.r.web.error={code:'WORKFLOW_PAUSED'};runs.r.assembly=null;
  runs.r.web.localReadRecovery={attempts:2,afterAttemptCount:1};
  runs.r.operations.push({status:'completed',receipt:{requestOutcome:'RESPONDED',usage:{totalTokens:30}}},{status:'completed',error:{requestOutcome:'NOT_SENT'}});
  services.storyboardView=async()=>({status:'failed',active:false,sourceStale:false,blocked:false,preparation:{ready:true},usage:{unknownAttempts:1,acknowledgedUnknownAttempts:1,knownTokens:30},production:{blocking:false,chainComplete:false}});
  assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,true,'已核对结束的历史未知不应阻止新已知成果后的免费准备恢复，共享费用仍另查');
  delete runs.r.operations[0].localSettledAt;
  assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,false,'仅有风险字样而无本地结算证据不能自动恢复');
  delete runs.r.operations[0].cancelAcknowledgement;assert.equal((await adapters.readRun('r',view.workflow)).blocked,true,'表面paused不能替代费用同意');
  services.storyboardView=beforeRiskView;runs.r=beforeRiskRun;
  // A paused queue may reject a pending scoped finish before it reaches the provider.
  // Keeping its paid author candidate must not strand that existing repair forever.
  const beforeRejectedRepair=structuredClone(runs.r),beforeRejectedView=services.storyboardView;
  runs.r={...structuredClone(runs.r),status:'failed',assembly:null,
   web:{...structuredClone(runs.r.web),progress:'failed',error:{code:'WORKFLOW_PAUSED'}},
   production:{chainComplete:false,boundaryCheck:{status:'MATCHED'},needs:[],blocking:false},
   candidates:[{id:'paid-author',stage:'author',status:'needs_repair',packageIds:['p1']}],
   operations:[{status:'completed',receipt:{requestOutcome:'RESPONDED',usage:{totalTokens:30}}},{stage:'finish',packageIds:['p1'],status:'completed',error:{requestOutcome:'NOT_SENT'}}]};
  services.storyboardView=async()=>({status:'failed',active:false,sourceStale:false,blocked:false,preparation:{ready:true},usage:{unknownAttempts:0,acknowledgedUnknownAttempts:0,knownTokens:30},production:{blocking:false,chainComplete:false}});
  assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,true,'队列暂停前未派出的局部整编须复用待修付费候选自动续作');
  assert.equal((await service.inspect(id)).nextAction.kind,'STORYBOARD_CONTINUE');
  for(const status of ['stale','needs_dependency_repair']){
   runs.r.candidates[0].status=status;assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,false,'未派出恢复不能替代源或依赖修复');
  }
  runs.r.candidates[0].status='needs_repair';runs.r.candidates[0].packageIds=['other'];
  assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,false,'不得借本包未派出恢复不相关候选');
  runs.r.candidates[0].packageIds=['p1'];runs.r.operations.at(-1).error.requestOutcome='UNKNOWN';
  assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,false,'费用未知不能走未派出自动恢复');
  runs.r.operations.at(-1).error.requestOutcome='NOT_SENT';runs.r.web.localReadRecovery={attempts:2,afterAttemptCount:2};
  assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,false,'无新结果的NOT_SENT不能重置两次免费恢复上限');
  delete runs.r.web.localReadRecovery;runs.r.web.error.code='CONTEXT_UNAVAILABLE';
  assert.equal((await adapters.readRun('r',view.workflow)).canAutoRepair,false,'此次修复不扩大一般读取错误的待修候选权限');
  services.storyboardView=beforeRejectedView;runs.r=beforeRejectedRepair;
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
  const savedRun=structuredClone(runs.r);runs.r.status='created';runs.r.production={needs:[]};
  let pauseLanded=false,startedAfterPause=false;const startBeforePauseTest=services.startStoryboard;
  services.startStoryboard=async()=>{startedAfterPause=true;throw new Error('PAUSED_TASK_MUST_NOT_START');};
  await assert.rejects(()=>adapters.run({kind:'STORYBOARD_CONTINUE',runId:'r'},view.workflow,{budget:{id:view.workflow.budgetId,directory:budgetDirectory},bind:async()=>{pauseLanded=true;},isPaused:async()=>pauseLanded}),(error:any)=>error.code==='WORKFLOW_PAUSED');
  assert.equal(startedAfterPause,false);services.startStoryboard=startBeforePauseTest;runs.r=savedRun;
  const oldBinding=structuredClone(runs.r.web.binding);assert.equal(oldBinding.executionTier,undefined);
  const createStandard=services.createStoryboard;let frozen:any;
  const chosenModel={version:'production-model-selection-v1',model:'gpt-6-astra',reasoning:'high'};
  services.createStoryboard=async(e:any,command:any)=>{frozen=structuredClone(command);assert.deepEqual(command.modelSelection,chosenModel);assert.equal(command.executionTier,'fast');assert.equal(command.maxCalls,32);assert.equal(command.maxTokens,2000000,'实际建稿边界须收到本轮明确配置，而非默认30万');return createStandard(e,command);};
  let parallel=await service.create({projectId:'p',actorId:'u',episodeNumbers:[1]});
  parallel=await service.configureParallel(parallel.workflow.id,{expectedRevision:parallel.workflow.revision,actorId:'u',executionTier:'fast',modelSelection:chosenModel,runBudget:{maxCalls:32,maxTokens:2000000}});
  assert.equal(frozen,undefined,'免费配置不建AI任务');
  parallel=await service.startParallel(parallel.workflow.id,{expectedRevision:parallel.workflow.revision,actorId:'u',costAcknowledged:true,fastAcknowledged:true});
  await service.pumpParallel(parallel.workflow.id);
  const generated=frozen as {productionChain:{selectionProtocol:string};productionBudget:{id:string}}|undefined;assert.ok(generated);
  assert.equal(generated.productionChain.selectionProtocol,'per-episode-selection-v1');
  assert.equal(generated.productionBudget.id,parallel.workflow.budgetId);assert.equal(runs.r.web.binding.productionChain.id,parallel.workflow.id);
  assert.equal(oldBinding.productionChain.selectionProtocol,undefined,'旧制作链的冻结协议不自动更换');
  const head:any={id:'head',source:{sourceRows:[{id:'s',text:'甲（OS）原话',kind:'action'}],contextRows:[],dialogue:[]},plan:null,adopted:[],candidates:[{id:'old',stage:'finish',status:'needs_repair'}],operations:[],production:{boundary:{seed:{fromEpisode:null,previousSource:null},actual:null},boundaryCheck:{status:'NO_PREDECESSOR'}},web:{binding:{projectId:'p',episodeId:episode.id,episodeNumber:1,productionChain:{id}}}};
  const headWorkflow={...view.workflow,selectedRuns:{1:'head'}},reviews:any[]=[];
  const headServices={...services,readStoryboard:async()=>structuredClone(head),storyboardView:async()=>({sourceStale:false,active:false,legacyReadOnly:false,preparation:{ready:true}}),resolveStoryboardSource:async(...args:any[])=>{reviews.push(args);return head;}};
  const sourceAdapters=adapterModule.createProductionWorkflowAdapters('u',headServices),packet=await sourceAdapters.boundaryPacket(headWorkflow,'head');
  assert.equal(packet.version,'production-source-evidence-v1');assert.equal(packet.previous,null);assert.equal(packet.sources.current,episode.content);assert.equal(packet.provesCrossEpisodeContinuity,false);
  await sourceAdapters.reviewBoundary(headWorkflow,{runId:'head',evidenceHash:packet.evidenceHash,sourceResolution:{kind:'CANDIDATE_DIALOGUE_MAPPING'},approval:{actorId:'untrusted',reference:'human/ref',answer:'原句映射免费恢复'}});
  assert.equal(reviews.length,1);assert.equal(reviews[0][2].actorId,'u','批准身份须由服务端确定');
  for(const sourceResolution of [undefined,{kind:'BOUNDARY_ACTION_RECAP'},{kind:'ASSET_QUANTITY_SOURCE_PRIORITY'}])await assert.rejects(()=>sourceAdapters.reviewBoundary(headWorkflow,{runId:'head',evidenceHash:packet.evidenceHash,sourceResolution,approval:{reference:'r',answer:'a'}}),(e:any)=>e.code==='WORKFLOW_SOURCE_REVIEW_SCOPE');
  head.candidates[0].status='changed';await assert.rejects(()=>sourceAdapters.reviewBoundary(headWorkflow,{runId:'head',evidenceHash:packet.evidenceHash,sourceResolution:{kind:'CANDIDATE_DIALOGUE_MAPPING'},approval:{reference:'r',answer:'a'}}),(e:any)=>e.code==='WORKFLOW_BOUNDARY_STALE');assert.equal(reviews.length,1);
  console.log('PASS production workflow real adapters including source-only head evidence, bound actor, stale/scope rejection; all providers/services synthetic');
 }finally{await rm(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
