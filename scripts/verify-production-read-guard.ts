/** Synthetic read/admission checks; no production DB, subprocess or model call. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire,registerHooks} from 'node:module';
import {createProductionWorkflowAdapters,productionWorkflowSourceVersion} from '../lib/production-workflow';

const guard=async()=>{
 const value=await import('../lib/production-read-guard').catch((error:any)=>error.code==='MODULE_NOT_FOUND'||error.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(error)) as any;
 assert.equal(typeof value.createInflightRead,'function','缺少只合并在途只读准备的实现');
 return value;
};
const timeout=()=>Object.assign(new Error('synthetic query timed out'),{code:'P1008'});

test('only exact native SQLite busy/locked codes join the read-only retry contract',async()=>{
 const {isTransientDatabaseReadError,retryDatabaseRead}=await guard();
 for(const code of ['SQLITE_BUSY','SQLITE_LOCKED']){
  assert.equal(isTransientDatabaseReadError(Object.assign(new Error('busy'),{code})),true);
  let reads=0;assert.equal(await retryDatabaseRead(async()=>{reads++;if(reads===1)throw Object.assign(new Error('busy'),{code});return 'fresh';}),'fresh');assert.equal(reads,2);
 }
 assert.equal(isTransientDatabaseReadError(Object.assign(new Error('busy'),{code:'SQL_BUSY'})),false,'unknown provider codes are not guessed');
 assert.equal(isTransientDatabaseReadError(Object.assign(new Error('database is locked'),{code:'SOURCE_STALE'})),false,'explicit source failure keeps precedence');
});

test('expired direction read transactions reconnect, but unproven P2028 and writes never do',async()=>{
 const {readSeriesDirectionProjection,readProjectSeriesDirectionProjection,getSeriesDirectionWorkspace,mutateSeriesDirection}=await import('../lib/series-direction-service');
 const {retryDatabaseRead,isTransientDatabaseReadError}=await guard();
 const expired=()=>Object.assign(new Error('Transaction already closed: A query cannot be executed on an expired transaction. The timeout for this transaction was 20000 ms.'),{code:'P2028'});
 assert.equal(isTransientDatabaseReadError(expired()),false,'an unscoped P2028 may be a failed write and must not authorize retry');
 for(const read of [(db:any)=>readSeriesDirectionProjection('p','e',{db}),(db:any)=>readProjectSeriesDirectionProjection('p',{db}),(db:any)=>getSeriesDirectionWorkspace('p','u',{db})]){
  let attempts=0;const db={$transaction:async()=>{attempts++;throw expired();}} as any;
  await assert.rejects(()=>retryDatabaseRead(()=>read(db)),(error:any)=>error.code==='P2028'&&error.retryableRead===true&&isTransientDatabaseReadError(error));
  assert.equal(attempts,3,'only the proven pure-read projection gets the existing bounded free retries');
 }
 let writes=0;const writing={$transaction:async()=>{writes++;throw expired();}} as any;
 await assert.rejects(()=>retryDatabaseRead(()=>mutateSeriesDirection('p','u',{} as any,{db:writing})),(error:any)=>error.code==='DIRECTION_CONFLICT'&&!error.retryableRead);
 assert.equal(writes,1,'expired writes still require explicit recovery and are never retried');
 for(const error of [Object.assign(new Error('Transaction not found'),{code:'P2028'}),Object.assign(new Error('confirmed source changed'),{code:'DIRECTION_CONFLICT'})]){
  let reads=0;const db={$transaction:async()=>{reads++;throw error;}} as any;
  await assert.rejects(()=>retryDatabaseRead(()=>readProjectSeriesDirectionProjection('p',{db})),(value:any)=>value.code==='DIRECTION_CONFLICT'&&!value.retryableRead);
  assert.equal(reads,1,'unknown transaction failures or real source conflicts are not reclassified as a reconnect');
 }
});

test('same full read key shares a complete pair only while in flight',async()=>{
 const {createInflightRead,upstreamReadKey}=await guard(),read=createInflightRead();
 let snapshots=0,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const options={inlinePerformance:true,inlinePerformanceVersion:'inline-performance-v2',episodeEvidenceVersion:'episode-evidence-v1'};
 const key=upstreamReadKey('p',2,{workflowId:'w',runId:'r'},options);
 const pair=async()=>{snapshots++;await gate;snapshots++;return {packet:{nested:{value:1}},materialVersion:'same'};};
 const pending=Array.from({length:4},()=>read(key,pair));await Promise.resolve();release();
 const results=await Promise.all(pending);assert.equal(snapshots,2,'four callers must perform exactly one before/after pair');
 results[0].packet.nested.value=9;assert.equal(results[1].packet.nested.value,1,'callers must not mutate a shared handoff');
 await read(key,pair);assert.equal(snapshots,4,'completed data must not become a TTL cache');
 for(const other of [upstreamReadKey('foreign',2,{workflowId:'w',runId:'r'},options),upstreamReadKey('p',3,{workflowId:'w',runId:'r'},options),upstreamReadKey('p',2,{workflowId:'other',runId:'r'},options),upstreamReadKey('p',2,{workflowId:'w',runId:'other'},options),upstreamReadKey('p',2,undefined,options),upstreamReadKey('p',2,{workflowId:'w',runId:'r'},{...options,episodeEvidenceVersion:null})])assert.notEqual(other,key);
 assert.equal(key,upstreamReadKey('p',2,{workflowId:'w',runId:'r'},{episodeEvidenceVersion:'episode-evidence-v1',inlinePerformanceVersion:'inline-performance-v2',inlinePerformance:true}),'option property order does not alter scope');
 let failures=0;const failed=()=>read('failed',async()=>{failures++;throw timeout();});
 await Promise.allSettled([failed(),failed()]);assert.equal(failures,1);await assert.rejects(failed());assert.equal(failures,2,'failed promises are removed');
});

test('database read retry is bounded and restarts the whole pair',async()=>{
 const {retryDatabaseRead}=await guard();let snapshots=0,round=0;
 const value=await retryDatabaseRead(async()=>{round++;snapshots++;if(round<3)throw timeout();snapshots++;return 'verified pair';});
 assert.equal(value,'verified pair');assert.equal(round,3);assert.equal(snapshots,4);
 let attempts=0;await assert.rejects(()=>retryDatabaseRead(async()=>{attempts++;throw timeout();}),error=>(error as any).code==='P1008'&&(error as any).retryableRead===true);assert.equal(attempts,3,'at most two additional free reads; only exhausted pure reads can request worker reconnection');
 for(const code of ['UPSTREAM_CHANGED','SOURCE_STALE','SOURCE_DIAGNOSTICS','DIRECTION_CONFLICT']){
  attempts=0;await assert.rejects(()=>retryDatabaseRead(async()=>{attempts++;throw Object.assign(new Error('synthetic source conflict'),{code});}));assert.equal(attempts,1,`${code} must not be retried`);
 }
 const controller=new AbortController();controller.abort();attempts=0;
 await assert.rejects(()=>retryDatabaseRead(async()=>{attempts++;return true;},{signal:controller.signal}));assert.equal(attempts,0);
});

test('targeted propagation spans the lane boundary and retains full refresh fallback',async()=>{
 const {productionRefreshTargets}=await guard();
 const make=(id:string,number:number,projectId='p',legacyReadOnly=false)=>({id,production:{},web:{binding:{projectId,episodeNumber:number},legacyReadOnly}});
 const runs=[make('a',19),make('b',20),make('c',21),make('older',20),make('far',41),make('foreign',20,'foreign'),make('legacy',20,'p',true)];
 assert.deepEqual(productionRefreshTargets(runs,'p','b').map((r:any)=>r.id),['a','b','c','older']);
 assert.deepEqual(productionRefreshTargets(runs,'p').map((r:any)=>r.id),['a','b','c','older','far']);
 assert.throws(()=>productionRefreshTargets(runs,'p','foreign'),error=>(error as any).code==='PRODUCTION_CHAIN_BINDING');
});
test('service startup selects unfinished targets only, without touching accepted completed projects',async()=>{
 const {productionStartupRecoveryTargets}=await guard();
 const make=(id:string,patch:any={})=>({id,status:'text_ready_for_review',web:{binding:{projectId:'p'}},operations:[],production:{boundaryCheck:{status:'MATCHED'}},...patch});
 const runs=[make('complete'),make('accepted-unknown',{operations:[{status:'unknown',cancelAcknowledgement:{acceptUnknownUsage:true}}]}),make('pending-tail',{production:{boundaryCheck:{status:'PRELIMINARY'}}}),make('drafting',{status:'drafting'}),make('legacy',{web:{legacyReadOnly:true}}),make('repair',{production:{pendingRepair:{packageIds:['p']}}})];
 assert.deepEqual(productionStartupRecoveryTargets(runs,new Set(runs.map(r=>r.id))).map((r:any)=>r.id),['pending-tail','drafting','repair']);
 assert.deepEqual(productionStartupRecoveryTargets(runs,new Set(['complete','accepted-unknown'])),[],'unselected abandoned versions never reopen a completed project');
});

test('unavailable preparation blocks admission without claiming source changed',async()=>{
 const {preparedSourceState}=await guard();
 assert.deepEqual(preparedSourceState(false,{ready:false},false),{sourceStale:false,sourceCheckPending:true});
 assert.deepEqual(preparedSourceState(false,{ready:true},false),{sourceStale:true,sourceCheckPending:false});
 assert.deepEqual(preparedSourceState(true,{ready:false,deferred:true},true),{sourceStale:true,sourceCheckPending:true});
});

test('queue inspection uses saved views and a single current project input',async()=>{
 const episodes=[1,2].map(number=>({id:`e${number}`,projectId:'p',number,title:null,content:`第${number}集\n${number}-1 日 内 房间\n人物：甲\n△甲抬手。\n甲：知道了。\n`}));
 let currentInput={sourceVersion:'s',sourceContext:{complete:true,issues:[],unresolved:[],notices:[]},sourceIndex:{episodes},project:{id:'p',episodes}};
 const workflow:any={id:'w',projectId:'p',sourceVersion:productionWorkflowSourceVersion(currentInput),mode:'CHAIN',budgetId:'b',episodeNumbers:[1,2],selectedRuns:{1:'r1',2:'r2'},criticalAssetKeys:[],requestedAssetKeys:[]};
 const runs=Object.fromEntries(episodes.map(e=>[`r${e.number}`,{id:`r${e.number}`,status:'text_ready_for_review',web:{binding:{projectId:'p',episodeId:e.id,episodeNumber:e.number,productionChain:{id:'w',mode:'CHAIN'},productionBudget:{id:'b'}}},operations:[],production:{boundaryCheck:{status:'MATCHED'},needs:[]},assembly:{text:'saved result',validation:{errors:[]}}}]));
 let inputReads=0,episodeReads=0,fullViews=0,savedViews=0,paidCalls=0;
 const view=(run:any)=>({id:run.id,status:run.web.progress??run.status,active:false,sourceStale:false,blocked:false,usage:{unknownAttempts:0},operations:[],production:{chainComplete:true},preparation:{ready:true}});
 const services:any={readInputs:async()=>{inputReads++;return currentInput;},readStage1:async()=>({complete:true,busy:false,action:'NONE',document:{f2:null}}),readScope:async()=>({sourceKnown:true,episodeNumbers:[1,2]}),readDirection:async()=>({status:'CONFIRMED',source:{blocker:null},generationPlan:{allowed:true}}),readAssets:async()=>({assets:[],records:{}}),planAssets:async()=>({assetKeys:[],eligibleKeys:[]}),readStoryboard:async(id:string)=>runs[id],episode:async(_p:string,n:number)=>{episodeReads++;return episodes.find(e=>e.number===n);},storyboardView:async(run:any)=>{fullViews++;return view(run);},storyboardSavedView:async(run:any)=>{savedViews++;return {...view(run),preparation:{ready:false,deferred:true},sourceCheckPending:true};},refreshChain:async()=>{},startStoryboard:async()=>{paidCalls++;throw new Error('PAID_CALL_FORBIDDEN');}};
 const adapters=createProductionWorkflowAdapters('u',services);
 const planBase=services.planAssets;
 services.planAssets=async(_p:string,_n:number[],_k:string[],prepared:any)=>{assert.strictEqual(prepared?.input,currentInput,'asset scope planning reuses this inspection input, not another project read');assert.deepEqual(prepared.workspace,{assets:[],records:{}});assert.deepEqual(prepared.production,{sourceKnown:true,episodeNumbers:[1,2]});return planBase();};
 const inspected=await adapters.inspect(workflow);await adapters.inspect(workflow);
 assert.equal(fullViews,0,'status polling must not reconstruct full upstream material for every saved run');assert.equal(savedViews,4);assert.equal(episodeReads,0,'the project snapshot already contains each bound episode');assert.equal(inputReads,2);
 assert.equal(inspected.runs.r1.sourceCheckPending,true);assert.deepEqual(inspected.runs.r1.preparation,{ready:false,deferred:true});assert.equal(inspected.runs.r1.sourceGatePassed,true);assert.equal(inspected.runs.r1.freshness,'DEFERRED');
 const late:any=runs.r1;late.epoch=7;late.operations=[{attemptId:'late-response',epoch:7,status:'completed',error:{code:'TIMEOUT'}}];late.candidates=[{id:'late-candidate',attemptId:'late-response',status:'needs_repair',raw:'saved complete response',output:null}];
 assert.equal((await adapters.inspect(workflow)).runs.r1.recoveryPending,true,'saved late bodies must be offered for free recovery before another paid repair');
 late.operations[0].epoch=6;assert.equal((await adapters.inspect(workflow)).runs.r1.recoveryPending,false,'old epochs are not auto-adopted');
 late.operations=[];late.candidates=[];delete late.epoch;
 await adapters.readRun('r1',workflow);assert.equal(fullViews,1,'an explicit read/admission still checks full source and materials');assert.equal(episodeReads,1);
 currentInput={...currentInput,sourceVersion:'changed'};const changed=await adapters.inspect(workflow);
 assert.notEqual(changed.sourceVersion,workflow.sourceVersion);assert.equal(changed.runs.r1.sourceGatePassed,false);assert.equal(changed.runs.r1.complete,false);assert.equal(paidCalls,0);
 currentInput={...currentInput,sourceVersion:'s'};const technical:any=runs.r1;
 technical.status='planned';technical.assembly=null;technical.plan={workPackages:[{id:'P1'}]};
 technical.web.progress='failed';technical.web.error={code:'CONTEXT_UNAVAILABLE'};
 technical.operations=[{status:'completed',receipt:{requestOutcome:'RESPONDED',usage:{totalTokens:5}}}];
 assert.equal((await adapters.inspect(workflow)).runs.r1.canAutoRepair,true,'a settled technical preflight failure may queue a bounded full source recheck');
 assert.equal((await adapters.inspect(workflow)).runs.r1.technicalReadRecovery.contextSnapshotSame,null,'cached inspection cannot claim full current context matches');
 assert.equal((await adapters.readRun('r1',workflow)).technicalReadRecovery?.contextSnapshotSame,true,'strict current input and the full source view are needed for actual continuation');
 technical.web.localReadRecovery={attempts:2,afterAttemptCount:1};
 assert.equal((await adapters.inspect(workflow)).runs.r1.canAutoRepair,false,'two attempts without real new results exhaust automatic recovery');
 technical.operations.push({status:'failed',error:{requestOutcome:'NOT_SENT'}});
 assert.equal((await adapters.inspect(workflow)).runs.r1.canAutoRepair,false,'a new NOT_SENT operation is not paid progress and cannot reset the cap');
  technical.operations.push({status:'completed',receipt:{requestOutcome:'RESPONDED',usage:{totalTokens:0}}});
  assert.equal((await adapters.inspect(workflow)).runs.r1.canAutoRepair,false,'a zero-token receipt cannot reset technical recovery and create an empty loop');
 technical.operations.push({status:'completed',receipt:{requestOutcome:'RESPONDED',usage:{totalTokens:5}}});
 assert.equal((await adapters.inspect(workflow)).runs.r1.canAutoRepair,true,'a real settled new result establishes a different unfinished step');
 for(const code of ['SOURCE_STALE','USAGE_UNKNOWN','BUDGET_STOP']){technical.web.error={code};assert.equal((await adapters.inspect(workflow)).runs.r1.canAutoRepair,false);}
 technical.web.error={code:'P1008'};technical.operations.push({status:'unknown'});
 assert.equal((await adapters.inspect(workflow)).runs.r1.canAutoRepair,false,'an unknown attempt must not be bypassed by a later technical error');technical.operations.pop();
 const fullView=services.storyboardView;services.storyboardView=async(run:any)=>({...view(run),preparation:{ready:false}});
 const unavailable=await adapters.readRun('r1',workflow);
 assert.equal(unavailable.canAutoRepair,false,'a strict view still unable to read context cannot authorize continuation');assert.equal(unavailable.freshness,'UNAVAILABLE');assert.equal(unavailable.sourceCheckPending,true);services.storyboardView=fullView;
 const savedView=services.storyboardSavedView;services.storyboardSavedView=async(run:any)=>({...await savedView(run),usage:{unknownAttempts:1}});
 assert.equal((await adapters.inspect(workflow)).runs.r1.canAutoRepair,false,'unknown usage cannot be cleared by a technical failure');services.storyboardSavedView=savedView;
 for(const patch of [{stopped:true},{pauseRequested:true},{sourceStale:true},{owner:123},{reservedAttemptIds:['pending']}]){
  Object.assign(technical.web,patch);assert.equal((await adapters.inspect(workflow)).runs.r1.canAutoRepair,false);for(const key of Object.keys(patch))delete technical.web[key];
 }
 technical.status='budget_stop';assert.equal((await adapters.inspect(workflow)).runs.r1.canAutoRepair,false);technical.status='planned';
 technical.web.budget={maxCalls:1,maxTokens:100};assert.equal((await adapters.inspect(workflow)).runs.r1.canAutoRepair,false,'an exhausted local call cap is not bypassed by a technical error');delete technical.web.budget;
 currentInput={...currentInput,sourceVersion:'changed'};assert.equal((await adapters.inspect(workflow)).runs.r1.canAutoRepair,false);
});

test('public upstream reader keeps independent snapshots and retries a failed pair for all callers',async()=>{
 const require=createRequire(import.meta.url),names=['../lib/light-foundation-reader','../lib/series-direction-service','../lib/production-episodes','../lib/prisma','../lib/episode-upstream-material'];
 const paths=names.map(name=>require.resolve(name)),originals=paths.map(file=>require.cache[file]);
 let reads=0,changed=false;const write=()=>assert.fail('READ_ONLY_ASSEMBLY_MUST_NOT_WRITE');
 try{
  const implementations=[
   {readLightEpisodeFoundation:async()=>{reads++;if(reads===2&&!changed)throw timeout();return {readiness:'READY',reasons:[],packet:{episode:1,sourceVersion:changed&&reads%2===0?'new':'s',sourceText:'合成原文',assets:[],materialDependencies:[]}};}},
   {readSeriesDirectionProjection:async()=>({status:'UNCONFIRMED',projection:null})},
   {readProductionScope:async()=>({sourceKnown:true,episodeNumbers:[1]}),isProductionEpisodeNumber:()=>true},
   {prisma:{episode:{findFirstOrThrow:async()=>({id:'e1'}),create:write,update:write,delete:write}}},
  ];
  for(let i=0;i<implementations.length;i++)require.cache[paths[i]]={id:paths[i],filename:paths[i],loaded:true,exports:implementations[i]} as NodeModule;
  delete require.cache[paths.at(-1)!];
  const {readProductionEpisodeHandoff}=require(paths.at(-1)!) as {readProductionEpisodeHandoff:(...args:any[])=>Promise<any>};
  const results=await Promise.all(Array.from({length:4},()=>readProductionEpisodeHandoff('synthetic',1)));
  assert.equal(reads,4,'one failed complete pair plus one successful pair is shared by all callers');assert.equal(results[0].packet.sourceVersion,'s');
  reads=0;changed=true;
  await assert.rejects(()=>readProductionEpisodeHandoff('synthetic',1),(error:any)=>error.code==='UPSTREAM_CHANGED');assert.equal(reads,2,'source changes are not automatically retried into apparent success');
 }finally{for(let i=0;i<paths.length;i++){if(originals[i])require.cache[paths[i]]=originals[i];else delete require.cache[paths[i]];}}
});

test('asset workspace shares only overlapping identical reads, never settled or foreign-scope data',async()=>{
 const require=createRequire(import.meta.url),names=['../lib/foundation-state','../lib/foundation-document','../lib/foundation-delivery','../lib/prisma','../lib/asset-visual-facts-service','../lib/series-direction-service','../lib/asset-prompt-service'];
 const paths=names.map(name=>require.resolve(name)),originals=paths.map(file=>require.cache[file]);
 let reads=0,release!:()=>void,fail=false;const gate=new Promise<void>(resolve=>{release=resolve;});
 try{
  const implementations=[
   {loadFoundationInputs:async(projectId:string)=>{reads++;await gate;if(fail)throw timeout();return {project:{id:projectId,title:projectId},sourceContext:{complete:true},presentationConditions:[]};}},
   {loadFoundationDocument:async()=>({document:{f2:null},needsContextEdit:false})},
   {getFoundationDeliveryState:async()=>({busy:false,requiredChoices:[]})},
   {prisma:{sceneSnapshot:{findMany:async()=>[]}}},
   {readAssetVisualFacts:async()=>null},
   {readProjectSeriesDirectionProjection:async()=>({status:'UNCONFIRMED',projection:null})}
  ];
  for(let i=0;i<implementations.length;i++)require.cache[paths[i]]={id:paths[i],filename:paths[i],loaded:true,exports:implementations[i]} as NodeModule;
  delete require.cache[paths.at(-1)!];const {loadAssetPromptWorkspace}=require(paths.at(-1)!);
  const pending=Array.from({length:4},()=>loadAssetPromptWorkspace('p'));release();const results=await Promise.all(pending);
  assert.equal(reads,1,'four lanes must not construct the same project asset workspace four times');
  results[0].records.local={body:'local'};assert.equal(results[1].records.local,undefined,'each consumer owns its snapshot');
  await loadAssetPromptWorkspace('p');assert.equal(reads,2,'a completed read must be rebuilt, not TTL-cached');
  await Promise.all([loadAssetPromptWorkspace('p'),loadAssetPromptWorkspace('foreign'),loadAssetPromptWorkspace('p',{episodeNumbers:[1]})]);
  assert.equal(reads,5,'project and explicit scope remain isolated');
  fail=true;await Promise.allSettled([loadAssetPromptWorkspace('p'),loadAssetPromptWorkspace('p')]);assert.equal(reads,6);
  fail=false;await loadAssetPromptWorkspace('p');assert.equal(reads,7,'a rejected read must not poison later attempts');
 }finally{for(let i=0;i<paths.length;i++){if(originals[i])require.cache[paths[i]]=originals[i];else delete require.cache[paths[i]];}}
});

test('one handoff snapshot reuses its asset workspace for adopted and scoped candidate design',async()=>{
 const require=createRequire(import.meta.url),names=['../lib/light-foundation-reader','../lib/series-direction-service','../lib/production-episodes','../lib/prisma','../lib/asset-prompt-service','../lib/asset-design-adoption','../lib/asset-material-candidates','../lib/episode-upstream-material'];
 const paths=names.map(name=>require.resolve(name)),originals=paths.map(file=>require.cache[file]);
 let workspaces=0;const seen:unknown[]=[];
 try{
  const implementations=[
   {readLightEpisodeFoundation:async()=>({readiness:'READY',reasons:[],packet:{episode:1,sourceVersion:'s',sourceText:'合成原文',facts:{sourceFactIndex:[]},scenes:[],assets:[{key:'hero',name:'甲',type:'CH',aliases:[],sourceRefs:[],variants:[]}],materialDependencies:[]}})},
   {readSeriesDirectionProjection:async()=>({status:'UNCONFIRMED',projection:null})},
   {readProductionScope:async()=>({sourceKnown:true,episodeNumbers:[1]}),isProductionEpisodeNumber:()=>true},
   {prisma:{episode:{findFirstOrThrow:async()=>({id:'e1'})}}},
   {loadAssetPromptWorkspace:async()=>({projectId:'p',snapshot:++workspaces})},
   {readAssetDesignHandoff:async(_p:string,_keys:string[],workspace:unknown)=>{assert.ok(workspace,'adopted designs must receive the same workspace as scoped candidates');seen.push(workspace);return [];}},
   {readScopedAssetMaterialCandidates:async(_p:string,_scope:unknown,_keys:string[],workspace:unknown)=>{assert.equal(workspace,seen.at(-1));return [];}}
  ];
  for(let i=0;i<implementations.length;i++)require.cache[paths[i]]={id:paths[i],filename:paths[i],loaded:true,exports:implementations[i]} as NodeModule;
  delete require.cache[paths.at(-1)!];const {readProductionEpisodeHandoff}=require(paths.at(-1)!);
  await readProductionEpisodeHandoff('p',1,{workflowId:'w',runId:'r'});
  assert.equal(workspaces,2,'before and after each build once; neither snapshot nor freshness check is omitted');assert.notEqual(seen[0],seen[1]);
 }finally{for(let i=0;i<paths.length;i++){if(originals[i])require.cache[paths[i]]=originals[i];else delete require.cache[paths[i]];}}
});

test('real run view honors frozen evidence version and keeps a private DB cause out of the response',async()=>{
 const require=createRequire(import.meta.url),names=['../lib/production-episodes','../lib/episode-upstream-material','../lib/storyboard-service'];
 const paths=names.map(name=>require.resolve(name)),originals=paths.map(file=>require.cache[file]),globalState=globalThis as any;
 const savedService=globalState.storyboardIntegratedV1,savedHooks=globalState.storyboardRuntimeHooks,savedRoot=process.env.DIRECTOR_STORYBOARD_DATA_DIR;
 const hooks=registerHooks({resolve(specifier,context,next){return next(specifier==='server-only'?'next/dist/compiled/server-only/empty.js':specifier,context);}});
 let evidenceVersion:unknown='not-read';
 try{
  process.env.DIRECTOR_STORYBOARD_DATA_DIR='/tmp/production-read-guard-synthetic-no-data';
  require.cache[paths[0]]={id:paths[0],filename:paths[0],loaded:true,exports:{readProductionScope:async()=>({}),isProductionEpisodeNumber:()=>true}} as NodeModule;
  require.cache[paths[1]]={id:paths[1],filename:paths[1],loaded:true,exports:{readProductionEpisodeHandoff:async(_p:string,_n:number,_s:unknown,options:any)=>{evidenceVersion=options.episodeEvidenceVersion;throw Object.assign(new Error('PRIVATE_QUERY_DETAIL_SHOULD_NOT_LEAVE_SERVER'),{code:'P1008'});}}} as NodeModule;
  globalState.storyboardIntegratedV1={active:()=>false,cancellationStatus:async()=>[],executionStatus:async()=>[],scheduling:()=>({maxConcurrent:4,maxPerEpisode:1,inFlight:0,queued:0})};
  delete require.cache[paths[2]];const {storyboardRunView}=require(paths[2]) as {storyboardRunView:(...args:any[])=>Promise<any>};
  const episode={id:'synthetic-episode',projectId:'synthetic',number:1,content:'第1集\n1-1 日 内 房间\n△甲抬手。\n',project:{id:'synthetic'}};
  const run:any={id:'synthetic-run',status:'created',source:{context:{},sourceRows:[],dialogue:[]},settings:{},operations:[],candidates:[],adopted:[],web:{createdAt:'2026-10-14T00:00:00.000Z',binding:{projectId:'synthetic',episodeId:episode.id,episodeNumber:1,inputProtocol:'upstream-material-v2',inlinePerformanceVersion:'inline-performance-v2',sourceVersion:'saved'}}};
  const prepared:any={protocol:'upstream-material-v2',inlinePerformance:true,inlinePerformanceVersion:'inline-performance-v2',episodeEvidenceVersion:'episode-evidence-v1',preparation:{ready:true},sourceVersion:'saved',sourceBasisVersion:null,sourceWarnings:[]};
  const view=await storyboardRunView(run,episode,prepared,false);
  assert.equal(evidenceVersion,null,'an older binding without evidence version must not inherit the new current version');
  assert.equal(view.preparation.ready,false);assert.equal(view.sourceCheckPending,true);assert.equal(view.sourceStale,false);assert.equal(view.blocked,true);assert.equal(view.error.code,'CONTEXT_UNAVAILABLE');assert.ok(!JSON.stringify(view).includes('PRIVATE_QUERY_DETAIL'));
 }finally{
  hooks.deregister();globalState.storyboardIntegratedV1=savedService;globalState.storyboardRuntimeHooks=savedHooks;
  if(savedRoot===undefined)delete process.env.DIRECTOR_STORYBOARD_DATA_DIR;else process.env.DIRECTOR_STORYBOARD_DATA_DIR=savedRoot;
  for(let i=0;i<paths.length;i++){if(originals[i])require.cache[paths[i]]=originals[i];else delete require.cache[paths[i]];}
 }
});
