import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import {require as tsxRequire} from 'tsx/cjs/api';
import {makeEpisodeInput} from './input.mjs';
import {canRecheckCandidate,createEngine} from './core/pipeline.mjs';
import {createStore} from './core/store.mjs';
import {buildRequest,captureRules} from './core/core.mjs';
import {digest} from './core/shared.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const require=createRequire(import.meta.url);
const productionReadGuard=tsxRequire(path.join(root,'lib/production-read-guard.ts'),import.meta.url);
const episode={id:'ep1',projectId:'p1',number:1,title:'历史',content:'1-1 日 外 城墙\n甲：我还没输！',project:{id:'p1',style:'3D国漫',aspectRatio:'16:9'}};
const prepared=makeEpisodeInput({episode,project:episode.project});
const saved={id:'saved-run',status:'drafting',source:prepared.source,settings:{},operations:[{attemptId:'a1',stage:'plan',status:'running'}],candidates:[],adopted:[],web:{title:'已保存任务',createdAt:'2026-09-26T00:00:00Z',progress:'running',binding:{episodeId:episode.id,projectId:episode.projectId,sourceVersion:prepared.sourceVersion}}};

function loadTs(file,imports,context={}){
 const module={exports:{}};
 const output=ts.transpileModule(readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText;
 const fileRequire=createRequire(path.join(root,file));
 vm.runInNewContext(output,{module,exports:module.exports,require:name=>Object.hasOwn(imports,name)?imports[name]:fileRequire(name),process,Response,Request,URL,Buffer,...context},{filename:file});
 return module.exports;
}

function fixture({sourceError=null,active=false,run=structuredClone(saved),env={},coordinatorOverrides={},sourcePartition=null,episodeNumber=1,diagnostics=null,diagnosticsError=null,policyError=null,localPhase=null,budgetAttempts=[],nativeRecovery=null,chain=null,lockedChain=null,boundaryHelpers=null,handoff=null,runtimeGlobal=null,kernelRules=null,nativeInputVersion='adopted-design-text-v1',cliState={error:null}}={}){
 const stats={sourceLoads:0,sourceProtocols:[],sourceReaders:[],inlinePerformanceModes:[],inlinePerformanceVersions:[],episodeEvidenceVersions:[],productionRefreshes:[],voiceMeasurements:0,cliChecks:0,resolverCalls:0,dispatches:[],coordinatorOptions:null,diagnosticReads:[],executionReads:[],budgetReconciliations:[]};
 const readSource=(protocol,reader,inlinePerformance,version,evidenceVersion)=>{stats.sourceLoads++;stats.sourceProtocols.push(protocol);stats.sourceReaders.push(reader);stats.inlinePerformanceModes.push(inlinePerformance);stats.inlinePerformanceVersions.push(version);stats.episodeEvidenceVersions.push(evidenceVersion);if(sourceError)throw sourceError;return null;};
 const current={...structuredClone(episode),number:episodeNumber};
 const coordinator={
  read:async()=>structuredClone(run),list:async()=>[structuredClone(run)],active:()=>active,cancellationStatus:async()=>[],executionState:()=>localPhase,executionStatus:async id=>{stats.executionReads.push(id);return [];},scheduling:()=>({maxConcurrent:4,maxPerEpisode:1,inFlight:active?1:0,queued:localPhase==='queued'?1:0}),refreshProduction:async id=>{stats.productionRefreshes.push(id);return structuredClone(run);},
  withPreparation:callback=>callback(),create:async()=>assert.fail('invalid source must not create a run'),
  ...Object.fromEntries(['start','repair','replan','recheck','pause'].map(action=>[action,async()=>{stats.dispatches.push(action);return structuredClone(run);}])),
  ...coordinatorOverrides
 };
 const db={episode:{findFirst:async()=>current},sceneSnapshot:{findFirst:async()=>sourcePartition?{content:JSON.stringify(sourcePartition)}:null}};
 const presentation=loadTs('lib/episode-presentation.ts',{});
 const productionScope=loadTs('lib/production-episodes.ts',{'./prisma':{prisma:db}});
 const listDocuments=coordinator.list.bind(coordinator);
 const service=loadTs('lib/storyboard-service.ts',{
  './asset-design-adoption':{ADOPTED_DESIGN_TEXT_VERSION:'adopted-design-text-v1'},
  'server-only':{},'@/lib/prisma':{prisma:db},
  '@/lib/episode-presentation':presentation,'@/lib/production-episodes':productionScope,
  '@/lib/light-foundation-reader':{readLightEpisodeFoundation:async(_project,_episode,_db,options)=>readSource(options?.protocol,'light',options?.inlinePerformance,options?.inlinePerformanceVersion,options?.episodeEvidenceVersion)},
  './episode-upstream-material':{readProductionEpisodeHandoff:async(_project,_episode,_db,options)=>{
   if(typeof handoff==='function'){readSource('upstream-material-v2','production',options?.inlinePerformance,options?.inlinePerformanceVersion,options?.episodeEvidenceVersion);return handoff(options);}
   return handoff??readSource('upstream-material-v2','production',options?.inlinePerformance,options?.inlinePerformanceVersion,options?.episodeEvidenceVersion);
  }},
  './production-workflow':{getProductionChain:async()=>chain,withChainSelection:async(_id,_project,action)=>action(lockedChain??chain)},
  './episode-boundary-seed':boundaryHelpers,
  './production-read-guard':productionReadGuard,
  './storyboard-read-catalog':{createStoryboardReadCatalog:()=>listDocuments},
  './standard-script-reception':{UPSTREAM_MATERIAL_PROTOCOL:'upstream-material-v2'},
  './production-budget':{currentProductionBudget:()=>null,productionBudgetRoot:'/fixture-only-budget',productionBudgetStore:()=>({create:async()=>null,read:async()=>({projectIds:['p1'],maxCalls:40,maxTokens:2000000,summary:{},attempts:budgetAttempts}),reconcile:async(id,attemptId,receipt)=>{stats.budgetReconciliations.push({id,attemptId,...receipt});}}),withProductionBudgetContext:(_budget,action)=>action(),budgetedProductionCall:(_metadata,action)=>action()},
  '@/lib/codex-cli':{resolveCodexExecutable:()=>{stats.resolverCalls++;return env.CODEX_CLI_PATH||'/resolved/codex';}},
  'node:child_process':{execFile:(_file,_args,_options,callback)=>{stats.cliChecks++;callback(cliState.error,'fixture','');}},
  'node:module':{createRequire:()=>name=>{
   if(name.endsWith('/input.mjs'))return {...require(name),ADOPTED_DESIGN_TEXT_VERSION:nativeInputVersion};
   if(name.endsWith('/core/core.mjs')&&kernelRules)return {captureRules:()=>kernelRules};
   if(name.endsWith('/source-context.mjs'))return {readEpisodeSourceContext:async()=>null};
   if(name.endsWith('/storyboard-archive.mjs'))return {withStoryboardArchive:current=>current};
   if(name.endsWith('/voice.mjs'))return {measureVoiceReference:async()=>{stats.voiceMeasurements++;return {warnings:[],rows:[]};}};
   if(name.endsWith('/core/runner.mjs'))return {
    readCompletedAttempt:async()=>{if(!nativeRecovery)throw Object.assign(new Error('no native receipt'),{code:'ATTEMPT_UNRESOLVED'});return nativeRecovery;},
    readTimeoutPolicy:()=>{if(policyError)throw policyError;return {plan:900000,author:1800000,finish:1200000};},
    readAttemptDiagnostics:async options=>{stats.diagnosticReads.push(options);if(diagnosticsError)throw diagnosticsError;return diagnostics;}
   };
   if(name.endsWith('/coordinator.mjs'))return {createCoordinator:options=>{stats.coordinatorOptions=options;return coordinator;}};
   return require(name);
  }}
 },{process:{env,cwd:()=>root},...(runtimeGlobal?{globalThis:runtimeGlobal}:{})});
 const route=loadTs('app/api/episodes/[episodeId]/storyboard/route.ts',{
  '@/lib/auth':{getCurrentUser:async()=>({id:'owner'})},'@/lib/prisma':{prisma:db},'@/lib/storyboard-service':service,'@/lib/standard-script-reception':{UPSTREAM_MATERIAL_PROTOCOL:'upstream-material-v2'}
 });
 const url='http://localhost:3008/api/episodes/ep1/storyboard';
 const context={params:Promise.resolve({episodeId:episode.id})};
 return {service,stats,current,run,
  get:query=>route.GET(new Request(url+(query||'')),context),
  post:command=>route.POST(new Request(url,{method:'POST',headers:{'content-type':'application/json','x-storyboard-action':'1','origin':'http://localhost:3008'},body:JSON.stringify(command)}),context)
 };
}

test('new tasks reject a partially reloaded native kernel before source preparation or creation',async()=>{
 const versions=captureRules();
 for(const [key,value] of [...['rhythmContractVersion','fantasyTimingVersion','visualSubjectsVersion','opportunityCoverageVersion','systemPresentationVersion','seedanceExportVersion','editingHandoffVersion'].map(key=>[key,undefined]),['seedanceExportVersion','seedance-execution-v3'],['editingHandoffVersion','future']]){
  let created=0;const f=fixture({kernelRules:{...versions,[key]:value},coordinatorOverrides:{create:async()=>{created++;return {id:'should-not-create'};}}});
  await assert.rejects(f.service.createStoryboardRun(f.current,{}),error=>error.code==='RUNTIME_RELOAD_REQUIRED'&&error.requestOutcome==='NOT_SENT'&&error.status===503);
  assert.equal(created,0);assert.equal(f.stats.sourceLoads,0);assert.equal(f.stats.voiceMeasurements,0);assert.deepEqual(f.stats.dispatches,[]);
 }
});

test('a current native kernel permits creating a new task without dispatching a model',async()=>{
 let created;const f=fixture({kernelRules:captureRules(),coordinatorOverrides:{create:async value=>{created=value;return {id:'new-kernel'};}}});
 const result=await f.service.createStoryboardRun(f.current,{});
 assert.equal(result.id,'new-kernel');assert.equal(created.binding.inlinePerformanceVersion,'inline-performance-v2');
 assert.equal(created.binding.episodeEvidenceVersion,'episode-evidence-v1');
 assert.equal(created.binding.adoptedDesignTextVersion,'adopted-design-text-v1');
 assert.equal(created.settings.model,'gpt-6.1-sol');assert.equal(created.settings.reasoning,'medium');assert.deepEqual(f.stats.dispatches,[]);
});
test('an old cached native input reader cannot silently drop full adopted text on new creation',async()=>{
 const f=fixture({kernelRules:captureRules(),nativeInputVersion:null});
 await assert.rejects(f.service.createStoryboardRun(f.current,{}),error=>error.code==='RUNTIME_RELOAD_REQUIRED'&&error.requestOutcome==='NOT_SENT');
 assert.equal(f.stats.sourceLoads,0);assert.deepEqual(f.stats.dispatches,[]);
});

test('an obsolete native kernel does not block reading frozen historical drafts',async()=>{
 const f=fixture({kernelRules:{}}),snapshot=await f.service.storyboardPageSnapshot(f.current,saved.id);
 assert.equal(snapshot.run.id,saved.id);assert.equal(f.stats.sourceLoads,0);assert.equal(f.stats.cliChecks,0);assert.deepEqual(f.stats.dispatches,[]);
});

test('a retained coordinator uses the current source reader after service hot reload',async()=>{
 const runtimeGlobal={},old=fixture({runtimeGlobal,sourceError:new Error('old grammar rejected source role labels')});
 const coordinator=old.service.storyboardService();await new Promise(resolve=>setImmediate(resolve));
 const current=fixture({runtimeGlobal});
 assert.equal(current.service.storyboardService(),coordinator,'Hot reload must not replace the coordinator, queues or live attempts.');
 assert.equal(await old.stats.coordinatorOptions.beforeExecute(saved.web.binding),true,'Execution preflight must use the same updated reader as the checked page.');
 assert.equal(old.stats.sourceLoads,0);assert.equal(current.stats.sourceLoads,1);
 assert.deepEqual(old.stats.dispatches,[]);assert.deepEqual(current.stats.dispatches,[]);
});

test('a retained coordinator uses current production inputs but keeps the saved protocol after reload',async()=>{
 const runtimeGlobal={},old=fixture({runtimeGlobal,sourceError:new Error('old production reader')});
 const coordinator=old.service.storyboardService();await new Promise(resolve=>setImmediate(resolve));
 const current=fixture({runtimeGlobal});current.service.storyboardService();
 const run=structuredClone(saved);run.web.binding.inputProtocol='legacy';
 await old.stats.coordinatorOptions.loadProductionContext(run.web.binding,run);
 assert.equal(old.stats.sourceLoads,0);assert.equal(current.stats.sourceLoads,1);
 assert.deepEqual(current.stats.sourceProtocols,['legacy']);assert.deepEqual(current.stats.inlinePerformanceModes,[false]);
 assert.equal(current.service.storyboardService(),coordinator);assert.deepEqual(old.stats.dispatches,[]);
});

test('current source changes still block the retained coordinator after reload',async()=>{
 const runtimeGlobal={},old=fixture({runtimeGlobal});old.service.storyboardService();
 await new Promise(resolve=>setImmediate(resolve));
 const current=fixture({runtimeGlobal});current.current.content='1-1 日 外 城墙\n甲：原文真的变了。';
 current.service.storyboardService();
 assert.equal(await old.stats.coordinatorOptions.beforeExecute(saved.web.binding),false);
 assert.deepEqual(old.stats.dispatches,[]);assert.deepEqual(current.stats.dispatches,[]);
});

test('opening and refreshing a page never probes the CLI connection',async()=>{
 const f=fixture();
 await f.get('');await f.get('?runId=saved-run&includeIndex=1');
 assert.equal(f.stats.cliChecks,0,'Read endpoints must not invoke executable/login checks.');
 assert.deepEqual(f.stats.dispatches,[]);
});

test('execution checks the current CLI even when a prior login check succeeded',async()=>{
 const cliState={error:null},f=fixture({cliState});
 assert.equal((await f.service.storyboardRunnerStatus()).ready,true);const before=f.stats.cliChecks;
 cliState.error=new Error('login no longer available');
 const response=await f.post({action:'start',runId:saved.id,mode:'all'});
 assert.equal(response.status,503);assert.equal((await response.json()).code,'CLI_NOT_READY');
 assert.ok(f.stats.cliChecks>before);assert.deepEqual(f.stats.dispatches,[],'Cached readiness cannot authorize a new paid attempt.');
});

test('reading a page does not turn a deferred check into an unavailable-source error',async()=>{
 const f=fixture({sourceError:new Error('source unavailable during reading')});
 const snapshot=await f.service.storyboardPageSnapshot(f.current,saved.id);
 assert.equal(snapshot.run.preparation.deferred,true);assert.equal(snapshot.run.sourceCheckPending,false);
 assert.equal(snapshot.index.runner.checked,false);assert.equal(snapshot.index.preparation.checking,undefined);
 assert.equal(f.stats.sourceLoads,0);assert.equal(f.stats.cliChecks,0);
 const response=await f.post({action:'start',runId:saved.id,mode:'all'});
 assert.equal(response.status,503);assert.equal((await response.json()).code,'CONTEXT_UNAVAILABLE');
 assert.deepEqual(f.stats.dispatches,[],'Deferred read-only checks cannot bypass execution source verification.');
});

test('deferred reading cannot authorize choice or confirmation against changed source',async()=>{
 for(const command of [{action:'choice',mode:'off'},{action:'confirm',selectedIds:[],expectedFingerprint:'fixture-version'}]){
  const f=fixture();await f.get('?runId=saved-run&view=saved');
  f.current.content='1-1 日 外 城墙\n甲：剧本来源已经修改。';
  const response=await f.post({...command,runId:saved.id});
  assert.equal(response.status,409);assert.equal((await response.json()).code,'SOURCE_STALE');
  assert.equal(f.stats.cliChecks,0);assert.deepEqual(f.stats.dispatches,[]);
 }
});

test('saved index and detail remain immediate without source, runner or production checks',async()=>{
 const f=fixture({sourceError:new Error('slow or unavailable source')});
 const index=await (await f.get('?view=saved')).json();
 assert.equal(f.stats.sourceLoads,0);assert.equal(f.stats.cliChecks,0);
 assert.equal(index.preparation.deferred,true);assert.equal(index.runner.checked,false);assert.equal(index.runs[0].id,saved.id);
 assert.deepEqual(f.stats.executionReads,[],'a selector list must not load each historical execution');
 const detail=await (await f.get('?runId=saved-run&view=saved')).json();
 assert.equal(f.stats.sourceLoads,0);assert.equal(detail.run.sourceCheckPending,false);
 assert.equal(detail.run.blocked,false);assert.equal(detail.run.preparation.deferred,true);
 assert.equal(detail.run.sourceStale,false,'pending checks are not proof of changed source');
 assert.notEqual(detail.run.error?.code,'CONTEXT_UNAVAILABLE');
 assert.deepEqual(detail.run.sourceRows,saved.source.sourceRows);assert.deepEqual(f.stats.productionRefreshes,[]);
});

test('server page snapshot supplies saved content without upstream or model checks',async()=>{
 const f=fixture({sourceError:new Error('unavailable upstream')});
 const before=JSON.stringify(f.run),snapshot=await f.service.storyboardPageSnapshot(f.current,saved.id);
 assert.equal(snapshot.episodeId,episode.id);assert.equal(snapshot.run.id,saved.id);
 assert.equal(snapshot.run.sourceCheckPending,false);assert.equal(snapshot.run.blocked,false);
 assert.deepEqual(snapshot.run.sourceRows,saved.source.sourceRows);
 assert.equal(f.stats.sourceLoads,0);assert.equal(f.stats.cliChecks,0);assert.deepEqual(f.stats.diagnosticReads,[]);
 assert.equal(JSON.stringify(f.run),before);assert.deepEqual(f.stats.dispatches,[]);
});

test('saved snapshot does not misreport a bound shared budget as unbound',async()=>{
 const run=structuredClone(saved);run.web.binding.productionBudget={id:'bound-budget',directory:'/fixture-only-budget'};
 const f=fixture({run,sourceError:new Error('upstream is still checking')});
 const snapshot=await f.service.storyboardPageSnapshot(f.current,run.id);
 assert.equal(snapshot.run.production.sharedBudget.maxCalls,40);
 assert.equal(snapshot.run.production.sharedBudget.maxTokens,2000000);
 assert.equal(snapshot.run.preparation.deferred,true);assert.equal(f.stats.sourceLoads,0);assert.deepEqual(f.stats.dispatches,[]);
});

test('selector index validates new-task preparation once, not every old grammar or receipt',async()=>{
 const older=structuredClone(saved);older.id='prior';older.web.binding.inputProtocol='standard-episode-v1';
 const current=structuredClone(saved);current.web.binding.inputProtocol='upstream-material-v2';
 const f=fixture({coordinatorOverrides:{list:async()=>[structuredClone(current),structuredClone(older)]}});
 const index=await(await f.get('')).json();
 assert.equal(index.runs.length,2);assert.equal(f.stats.sourceLoads,1);
 assert.deepEqual(f.stats.sourceProtocols,['upstream-material-v2']);
 assert.deepEqual(f.stats.executionReads,[]);assert.deepEqual(f.stats.diagnosticReads,[]);assert.deepEqual(f.stats.dispatches,[]);
});

test('combined page check shares current input and keeps legacy protocol validation separate',async()=>{
 for(const [protocol,version,evidenceVersion] of [['upstream-material-v2','inline-performance-v1'],['upstream-material-v2','inline-performance-v2'],['upstream-material-v2','inline-performance-v2','episode-evidence-v1'],['legacy','inline-performance-v1']]){
  const run=structuredClone(saved);Object.assign(run.web.binding,{inputProtocol:protocol,inlinePerformanceVersion:version});
  if(evidenceVersion)run.web.binding.episodeEvidenceVersion=evidenceVersion;
  const f=fixture({run}),response=await f.get('?runId=saved-run&includeIndex=1');
  assert.equal(response.status,200);const result=await response.json();
  assert.equal(result.run.id,saved.id);assert.equal(result.run.sourceCheckPending,false);
  assert.equal(result.index.preparation.ready,true);assert.equal(result.index.runner.checked,false);assert.equal(f.stats.cliChecks,0);
  assert.equal(f.stats.sourceLoads,evidenceVersion==='episode-evidence-v1'?1:2,'相同表演语法的旧/新版资料准备不可混用');
  assert.equal(f.stats.inlinePerformanceVersions[0],version);assert.equal(f.stats.inlinePerformanceVersions.at(-1),'inline-performance-v2');
  assert.equal(f.stats.episodeEvidenceVersions[0],evidenceVersion??null);assert.equal(f.stats.episodeEvidenceVersions.at(-1),'episode-evidence-v1');
  assert.equal(f.stats.sourceProtocols[0],protocol);assert.deepEqual(f.stats.dispatches,[]);
 }
});

test('saved page snapshot cannot expose a task from a different episode or project',async()=>{
 const f=fixture(),foreign={...f.current,id:'another-episode'};
 const snapshot=await f.service.storyboardPageSnapshot(foreign,saved.id);
 assert.equal(snapshot.run,null);assert.equal(snapshot.index,null);assert.match(snapshot.error,/任务不存在/);
 assert.deepEqual(f.stats.dispatches,[]);
});

test('checked detail reuses one scoped input and never refreshes unrelated project tasks',async()=>{
 const run=structuredClone(saved);run.production={boundary:null,materials:[],needs:[]};
 const f=fixture({run});
 f.service.storyboardService();await new Promise(resolve=>setImmediate(resolve));
 f.stats.sourceLoads=0;f.stats.productionRefreshes=[];
 const response=await f.get('?runId=saved-run');assert.equal(response.status,200);
 assert.equal(f.stats.sourceLoads,1,'one current input serves reconciliation and freshness display');
 assert.ok(f.stats.productionRefreshes.every(id=>id===saved.id));
 assert.equal((await response.json()).run.sourceCheckPending,false);
});

test('polling identical dependencies is a no-op; a material change still reconciles the requested run',async()=>{
 for(const changed of [false,true]){
  const run=structuredClone(saved);run.production={boundary:null,materials:changed?[{id:'asset:old',version:'prior'}]:[],needs:[]};
  const before=JSON.stringify(run),f=fixture({run});
  f.service.storyboardService();await new Promise(resolve=>setImmediate(resolve));f.stats.sourceLoads=0;f.stats.productionRefreshes=[];
  const checked=await f.service.refreshStoryboardRun(run,f.current);
  assert.deepEqual(f.stats.productionRefreshes,changed?[run.id]:[]);
  assert.equal(f.stats.sourceLoads,1);assert.equal(checked.prepared.preparation.ready,true);
  assert.equal(JSON.stringify(run),before,'refresh input and saved creative content are never mutated in-place');
  assert.deepEqual(f.stats.dispatches,[]);
 }
});

test('selected actual tail validates the predecessor using its own frozen grammar, not new-task defaults',async()=>{
 const seed={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'index',fromEpisode:1,toEpisode:2,adjacentEpisode:true,
  previousSource:{text:'甲站稳。'},currentOpening:{text:'甲继续站稳。'}};
 for(const [protocol,inlinePerformance] of [['legacy',false],['upstream-material-v2',false],['upstream-material-v2',true]]){
  const f=fixture({boundaryHelpers:{retainExpandedEpisodeBoundarySeed:s=>s}}),previous=structuredClone(saved);
  const input=await f.service.loadStoryboardInput(f.current,'',protocol,undefined,inlinePerformance);
  Object.assign(previous.web.binding,{episodeNumber:1,inputProtocol:protocol,sourceVersion:input.sourceVersion});
  if(inlinePerformance)previous.web.binding.inlinePerformanceVersion='inline-performance-v1';
  previous.assembly={draft:{units:[{id:'last',exitState:'甲站稳。'}]},validation:{errors:[]}};
  const before=JSON.stringify(previous);f.stats.sourceLoads=0;f.stats.sourceProtocols=[];f.stats.inlinePerformanceModes=[];
  const context=await f.service.productionContextFromPrepared({projectId:'p1',episodeNumber:2,productionChain:{mode:'CHAIN',selectedRuns:{'1':previous.id},selectionRevision:1}},
    {episodeBoundarySeed:seed,materials:[]},null,{read:async()=>previous});
  assert.deepEqual(f.stats.sourceProtocols,[protocol]);assert.deepEqual(f.stats.inlinePerformanceModes,[inlinePerformance]);
  assert.equal(context.boundary.mode,'ACTUAL');assert.equal(context.boundary.actual.unit.exitState,'甲站稳。');
  assert.equal(JSON.stringify(previous),before);assert.deepEqual(f.stats.dispatches,[]);
 }
});

test('saved display cannot bypass Markdown source checks or raw JSON permissions',async()=>{
 const f=fixture({sourceError:new Error('missing source')});
 assert.equal((await f.get('?runId=saved-run&view=saved&format=md')).status,503);
 const before=f.stats.sourceLoads;
 assert.equal((await f.get('?runId=saved-run&view=saved&format=json')).status,200);
 assert.equal(f.stats.sourceLoads,before);
});

test('a future selected-chain predecessor needs no created run to receive a stable source-bound minimal agreement',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'service-agreement-'));
 const seed={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'index-1',fromEpisode:1,toEpisode:2,adjacentEpisode:true,
  previousSource:{episode:1,sourceTextHash:'previous-full',sourceLength:6000,text:'完整尾段',nodes:[],sourceRange:{start:5900,end:6000}},
  currentOpening:{episode:2,sourceTextHash:'current-full',sourceLength:1000,text:'甲接住钥匙。',nodes:[],sourceRange:{start:0,end:6}}};
 const choice={key:'PR01/receiver',value:'甲',authority:'DESIGN',sourceRefs:[]};
 const run={id:'ep2-plan',plan:{productionFeedback:{relation:'DIRECT',sharedChoices:[choice]}},production:{needs:[]}};
 const chain={id:'chain-one',mode:'CHAIN',episodeNumbers:[1,2],selectedRuns:{'2':'ep2-plan'},selectionRevision:1};
 try{
  const f=fixture({env:{DIRECTOR_PRODUCTION_WORKFLOW_DIR:directory},chain,handoff:{packet:{episodeBoundary:seed}},boundaryHelpers:{retainExpandedEpisodeBoundarySeed:s=>s}});
  const prepared={episodeBoundarySeed:seed,materials:[]};
  const old=await f.service.productionContextFromPrepared({projectId:'p1',episodeNumber:2,productionChain:chain},prepared,{...run,id:'old-unselected'},{});
  assert.deepEqual(old.boundary.agreements,[],'unselected history must not publish shared choices');
  const unbound=await f.service.productionContextFromPrepared({projectId:'p1',episodeNumber:2,productionChain:chain},prepared,{...run,id:'new-not-yet-bound'},{});
  assert.deepEqual(unbound.boundary.agreements,[],'a new run is read-only until the workflow binds it');
  const incoming=await f.service.productionContextFromPrepared({projectId:'p1',episodeNumber:2,productionChain:chain},prepared,run,{});
  assert.equal(incoming.boundary.agreements[0].value,'甲');
  const expanded={...seed,previousSource:{...seed.previousSource,text:'完整上集原文视图',selectionKind:'FULL_EPISODE_EXPANSION'}};
  const reread=await f.service.productionContextFromPrepared({projectId:'p1',episodeNumber:2,productionChain:chain},{...prepared,episodeBoundarySeed:expanded},run,{});
  assert.deepEqual(reread.boundary.agreements,incoming.boundary.agreements);
  const outgoing=await f.service.productionContextFromPrepared({projectId:'p1',episodeNumber:1,productionChain:chain},{...prepared,episodeBoundarySeed:{...seed,fromEpisode:null,toEpisode:1,previousSource:null}},null,{});
  assert.deepEqual(outgoing.outgoingAgreements,incoming.boundary.agreements);
  const changed={...chain,selectedRuns:{'1':'first-run','2':'new-selected'},selectionRevision:2};
  const raced=fixture({env:{DIRECTOR_PRODUCTION_WORKFLOW_DIR:directory},chain,lockedChain:changed,handoff:{packet:{episodeBoundary:seed}},boundaryHelpers:{retainExpandedEpisodeBoundarySeed:s=>s}});
  await assert.rejects(raced.service.productionContextFromPrepared({projectId:'p1',episodeNumber:2,productionChain:chain},prepared,run,{}),{code:'PRODUCTION_SELECTION_CHANGED'});
  const ownerChanged=fixture({env:{DIRECTOR_PRODUCTION_WORKFLOW_DIR:directory},chain,lockedChain:{...changed,selectedRuns:{'2':'new-selected'}},handoff:{packet:{episodeBoundary:seed}},boundaryHelpers:{retainExpandedEpisodeBoundarySeed:s=>s}});
  const ignored=await ownerChanged.service.productionContextFromPrepared({projectId:'p1',episodeNumber:2,productionChain:chain},prepared,run,{});
  assert.deepEqual(ignored.boundary.agreements,[],'a stale outer chain read cannot republish an unselected proposal');
  const admitted=fixture({env:{DIRECTOR_PRODUCTION_WORKFLOW_DIR:directory},chain:changed,handoff:{packet:{episodeBoundary:seed}}});
  await assert.rejects(admitted.service.sealOutgoingProductionAgreements({projectId:'p1',episodeNumber:1,productionChain:changed},{id:'old-first-run'}),{code:'PRODUCTION_SELECTION_CHANGED',requestOutcome:'NOT_SENT'});
  const switched=fixture({env:{DIRECTOR_PRODUCTION_WORKFLOW_DIR:directory},chain:changed,lockedChain:{...changed,selectedRuns:{...changed.selectedRuns,'1':'replacement-first-run'}},handoff:{packet:{episodeBoundary:seed}}});
  await assert.rejects(switched.service.sealOutgoingProductionAgreements({projectId:'p1',episodeNumber:1,productionChain:changed},{id:'first-run'}),{code:'PRODUCTION_SELECTION_CHANGED',requestOutcome:'NOT_SENT'});
  await admitted.service.sealOutgoingProductionAgreements({projectId:'p1',episodeNumber:1,productionChain:changed},{id:'first-run'});
  const afterAdmission=await f.service.productionContextFromPrepared({projectId:'p1',episodeNumber:2,productionChain:chain},prepared,run,{});
  assert.deepEqual(afterAdmission.boundary.agreements,[],'admission discards an unselected open proposal and late old predictions cannot reopen it');
  assert.deepEqual(f.stats.dispatches,[]);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('production context retains already supplied expansion after the need resolves',async()=>{
 const seed={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'index',fromEpisode:1,toEpisode:2,adjacentEpisode:true,
  previousSource:{text:'tail',clipped:true},currentOpening:{text:'甲接住钥匙。'}};
 const expanded={...seed,previousSource:{text:'full previous episode',selectionKind:'FULL_EPISODE_EXPANSION',clipped:false}};
 let retained=0;
 const f=fixture({boundaryHelpers:{retainExpandedEpisodeBoundarySeed:(now,prior)=>{assert.equal(now,seed);assert.equal(prior,expanded);retained++;return expanded;}}});
 const context=await f.service.productionContextFromPrepared({projectId:'p1',episodeNumber:2},{episodeBoundarySeed:seed,materials:[]},{production:{boundary:{seed:expanded},needs:[{stage:1,target:'PREVIOUS_SOURCE',resolved:true}]},plan:{productionFeedback:{relation:'DIRECT'}}},{});
 assert.equal(retained,1);assert.equal(context.boundary.seed.previousSource.text,'full previous episode');
});

test('known recovered native usage resolves shared unknown without trusting the original missing usage',async()=>{
 const {splitProductionMaterials}=await import('../production-materials.mjs');
 for(const fingerprint of ['saved-fingerprint','another-request']){
  const run=structuredClone(saved);run.operations=[{attemptId:'a1',stage:'plan',status:'completed',fingerprint:'saved-fingerprint',receipt:{usage:null},recovery:{candidateId:'c1'}}];
  Object.assign(run.web.binding,{inputProtocol:'legacy',...Object.fromEntries(Object.entries(splitProductionMaterials(prepared)).filter(([k])=>['sourceBasisVersion','contextEvidence'].includes(k))),productionBudget:{id:'shared',directory:'/fixture-only-budget'}});
  run.production={boundary:null,materials:[]};
  const f=fixture({run,budgetAttempts:[{id:'a1',totalTokens:null}],nativeRecovery:{usage:{totalTokens:321},requestFingerprint:fingerprint}});
  await f.service.refreshProductionChain('p1');
  assert.equal(f.stats.budgetReconciliations.length>0,fingerprint==='saved-fingerprint');
  assert.ok(f.stats.budgetReconciliations.every(r=>r.totalTokens===321&&r.attemptId==='a1'));
 }
});
test('continuous delivery waits only for selected predecessor, while a standalone source-backed draft stays deliverable',()=>{
 const f=fixture(),run=structuredClone(saved);
 run.production={boundary:{seed:{fromEpisode:4,adjacentEpisode:true}},boundaryCheck:{status:'PRELIMINARY'}};
 run.web.binding.productionChain={mode:'CHAIN',episodeNumbers:[5,6]};assert.equal(f.service.storyboardChainComplete(run),true);
 run.web.binding.productionChain.episodeNumbers=[4,5];assert.equal(f.service.storyboardChainComplete(run),false);
 run.production.boundaryCheck.status='MATCHED';assert.equal(f.service.storyboardChainComplete(run),true);
 run.production.pendingRepair={packageIds:['p1']};assert.equal(f.service.storyboardChainComplete(run),false);
});

test('live queue projection distinguishes waiting from execution without changing saved running status',async()=>{
 for(const localPhase of ['queued','executing','preparing',null]){
  const f=fixture({active:true,localPhase});
  const run=(await (await f.get('?runId=saved-run')).json()).run;
  assert.equal(run.operations[0].localPhase,localPhase);
  assert.equal(run.operations[0].status,'running');
  assert.equal(f.run.operations[0].localPhase,undefined);
  assert.deepEqual(f.stats.dispatches,[]);
 }
});

test('saved first paint retains actual queue/worker phase without loading upstream or CLI',async()=>{
 for(const localPhase of ['queued','executing','preparing']){
  const f=fixture({active:true,localPhase}),view=(await(await f.get('?runId=saved-run&view=saved')).json()).run;
  assert.equal(view.operations[0].localPhase,localPhase,'The reading view must not turn a real worker into generic waiting.');
  assert.equal(f.stats.sourceLoads,0);assert.equal(f.stats.cliChecks,0);assert.deepEqual(f.stats.diagnosticReads,[]);
  assert.equal(f.run.operations[0].localPhase,undefined);assert.deepEqual(f.stats.dispatches,[]);
 }
});

test('diagnostics projection is read-only, scoped, and omits private or unexpected fields',async()=>{
 const diagnostics={version:1,attemptId:'a1',stage:'plan',timeoutMs:900000,startedAt:'2026-09-27T00:00:00Z',endedAt:null,lastActivityAt:'2026-09-27T00:01:00Z',eventCount:3,eventCounts:{'turn.started':1},stdoutBytes:120,stderrBytes:0,failureCategory:null,eventTail:[],raw:'must not be returned',prompt:'must not be returned'};
 const f=fixture({active:true,diagnostics});
 const response=await f.get('?runId=saved-run');assert.equal(response.status,200);
 const detail=await response.json(), observed=detail.run.operations[0].diagnostics;
 assert.equal(observed?.timeoutMs,900000,'saved per-attempt timeout is returned, not invented from current defaults');
 assert.equal(observed.lastActivityAt,diagnostics.lastActivityAt);assert.equal(observed.stdoutBytes,120);
 assert.equal(Object.hasOwn(observed,'prompt'),false);assert.equal(Object.hasOwn(observed,'raw'),false);
 assert.equal(f.stats.diagnosticReads.length,1);
 assert.equal(f.stats.diagnosticReads[0].directory,f.service.storyboardDataRoot);
 assert.equal(f.stats.diagnosticReads[0].attemptId,'a1');
 assert.deepEqual(f.stats.dispatches,[]);assert.equal(f.run.operations[0].diagnostics,undefined,'view must not mutate the stored document');
});

test('missing or corrupt diagnostics cannot hide history or turn unknown work into success',async()=>{
 for(const diagnosticsError of [null,Object.assign(new Error('private location'),{code:'DIAGNOSTICS_CORRUPT'})]){
  const f=fixture({diagnosticsError});
  const response=await f.get('?runId=saved-run');assert.equal(response.status,200);
  const run=(await response.json()).run;
  assert.equal(run.operations[0].diagnostics,null);assert.equal(run.operations[0].diagnosticsUnavailable,Boolean(diagnosticsError));
  assert.equal(run.status,'interrupted');assert.deepEqual(f.stats.dispatches,[]);
  assert.equal(JSON.stringify(run).includes('private location'),false);
 }
});

test('timeout policy is visible for new requests while invalid configuration preserves reads',async()=>{
 const normal=fixture(); const index=await (await normal.get()).json();
 assert.deepEqual(index.runner.timeoutPolicy,{plan:900000,author:1800000,finish:1200000});
 const invalid=fixture({policyError:new Error('invalid timeouts')});
 const response=await invalid.get();assert.equal(response.status,200);
 const history=await response.json();assert.equal(history.runs.length,1);assert.equal(history.runner.ready,false);assert.equal(history.runner.configurationError,true);
 assert.equal((await invalid.post({action:'start',runId:saved.id,mode:'all'})).status,503);assert.deepEqual(invalid.stats.dispatches,[]);
});

test('source partition, not a positive ordinal, gates direct stage3 preparation',async()=>{
 const background=fixture({episodeNumber:1,sourcePartition:{sourceStructure:{sections:[{kind:'BACKGROUND',start:0,end:9}]}}});
 const index=await (await background.get()).json();
 assert.equal(index.preparation.ready,false);
 assert.equal(index.preparation.code,'EPISODE_NOT_PRODUCTION');
 assert.equal(index.runs.length,1,'history is still readable');
 assert.equal((await background.post({action:'create'})).status,409);
 assert.equal((await background.post({action:'start',runId:saved.id,mode:'all'})).status,409);
 assert.equal(background.stats.dispatches.length,0);
 const zero=fixture({episodeNumber:0,sourcePartition:{sourceStructure:{sections:[{kind:'EPISODE',episodeNumber:0,start:0,end:9}]}}});
 assert.equal((await zero.service.prepareStoryboardView(zero.current)).preparation.ready,true,'source-confirmed zero can be prepared');
});

test('stage3 data and CLI resolution stay isolated while explicit overrides win',()=>{
 for(const env of [{},{CODEX_CLI_PATH:'/configured/codex'},{DIRECTOR_CODEX_CLI:'/direct/codex',CODEX_CLI_PATH:'/configured/codex',DIRECTOR_STORYBOARD_DATA_DIR:'.isolated-storyboard'}]){
  const {service,stats}=fixture({env});service.storyboardService();
  assert.equal(service.storyboardDataRoot,path.join(root,env.DIRECTOR_STORYBOARD_DATA_DIR||'.storyboard-stage3-v2'));
  assert.equal(stats.coordinatorOptions.executable,env.DIRECTOR_CODEX_CLI||env.CODEX_CLI_PATH||'/resolved/codex');
  assert.equal(stats.coordinatorOptions.maxConcurrent,4);
  assert.equal(stats.resolverCalls,env.DIRECTOR_CODEX_CLI?0:1);
  assert.equal(stats.cliChecks,0);
 }
});

test('index keeps public task state; frozen grammar is checked when its detail is opened',async()=>{
 for(const active of [false,true]){
  const f=fixture({active});
  const indexResponse=await f.get();assert.equal(indexResponse.status,200);
  const index=await indexResponse.json();
  assert.equal(f.stats.sourceLoads,1,'selector checks new-create preparation only, not every historical source');
  const detail=await (await f.get('?runId=saved-run')).json();
  assert.equal(f.stats.sourceLoads,2,'selected frozen legacy grammar is still checked separately');
  assert.deepEqual(f.stats.sourceProtocols,['upstream-material-v2','legacy']);
  assert.deepEqual(f.stats.sourceReaders,['production','light']);
  assert.deepEqual(f.stats.inlinePerformanceModes,[true,false]);
  assert.equal(detail.run.status,active?'drafting':'interrupted');
  assert.equal(index.runs[0].status,detail.run.status);
  assert.equal(index.runs[0].active,active);
  assert.equal(index.preparation.ready,true);
  assert.equal(detail.run.preparation.ready,true);
 }
});

test('frozen and new delivery grammars sharing a protocol are prepared separately and reused',async()=>{
 for(const inlinePerformanceVersion of [undefined,'inline-performance-v1']){
  const run=structuredClone(saved);run.web.binding.inputProtocol='upstream-material-v2';
  if(inlinePerformanceVersion)run.web.binding.inlinePerformanceVersion=inlinePerformanceVersion;
  const f=fixture({run});
  assert.equal((await f.get()).status,200);
  assert.deepEqual(f.stats.inlinePerformanceModes,[true],'selector must not load old inline grammar');
  const before=f.stats.sourceLoads;
  assert.equal((await f.get('?runId=saved-run')).status,200);
  assert.equal(f.stats.sourceLoads,before+1);
  assert.equal(f.stats.inlinePerformanceModes.at(-1),!!inlinePerformanceVersion);
 }
});

test('new task bindings freeze v2 and saved v1 or absent bindings keep their original delivery version',async()=>{
 for(const version of [undefined,'inline-performance-v1','inline-performance-v2']){
  const run=structuredClone(saved);run.web.binding.inputProtocol='upstream-material-v2';if(version)run.web.binding.inlinePerformanceVersion=version;
  const before=JSON.stringify(run),f=fixture({run});
  assert.equal((await f.get()).status,200);assert.equal(f.stats.inlinePerformanceVersions[0],'inline-performance-v2');
  assert.equal((await f.get('?runId=saved-run')).status,200);
  assert.equal(f.stats.inlinePerformanceVersions.at(-1),version??'inline-performance-v1');
  assert.equal(f.stats.episodeEvidenceVersions[0],'episode-evidence-v1');assert.equal(f.stats.episodeEvidenceVersions.at(-1),null);
  assert.equal(f.stats.inlinePerformanceModes.at(-1),!!version);assert.equal(JSON.stringify(run),before);assert.deepEqual(f.stats.dispatches,[]);
 }
 let created;
 const f=fixture({coordinatorOverrides:{create:async input=>{created=input;return {id:'new'};}}});
 await f.service.createStoryboardRun(f.current,{productionBudget:{id:'fixture-budget'}});
 assert.equal(created.binding.inlinePerformanceVersion,'inline-performance-v2');assert.equal(f.stats.inlinePerformanceVersions[0],'inline-performance-v2');
 const unknown=structuredClone(saved);unknown.web.binding.inlinePerformanceVersion='inline-performance-v99';
 const bad=fixture({run:unknown}),detail=await (await bad.get('?runId=saved-run')).json();
 assert.equal(detail.run.preparation.ready,false);assert.equal(detail.run.preparation.code,'SOURCE_PROTOCOL');assert.equal(bad.stats.sourceLoads,0);
});

test('service reload preserves frozen source versions and full request hashes with real standard packages and facts',async()=>{
 const {prepareEpisodeReception}=tsxRequire('../../lib/standard-script-reception.ts',import.meta.url);
 const {buildSourceIndex}=tsxRequire('../../lib/project-foundation-contracts.ts',import.meta.url);
 const {cachedFoundationFacts}=tsxRequire('../../lib/foundation-fact-cache.ts',import.meta.url);
 const {selectFoundationFacts}=tsxRequire('../../lib/foundation-facts.ts',import.meta.url);
 const {splitProductionMaterials}=require('../production-materials.mjs');
 const text='人物：苏远\n苏远抬头os：是这里。',current={...episode,content:text};
 const index=buildSourceIndex([{number:1,title:current.title,content:text}]),context={version:'frozen-context',background:[]};
 const handoff=options=>({readiness:'READY',reasons:[],packet:{sourceText:text,
  ...prepareEpisodeReception(current,null,undefined,options),facts:selectFoundationFacts(cachedFoundationFacts(index,context,null,{standard:true,...options}),index,[1])}});
 const original=handoff({inlinePerformanceVersion:'inline-performance-v1'});
 assert.equal(original.packet.standardScript.packageId,'standard:ed326bb9f57231459e44dcf8619abe0d86f28a742e0b10841cdad8dcfe34f811');
 const baseline=splitProductionMaterials(makeEpisodeInput({episode:current,project:current.project,handoff:original,inputProtocol:'upstream-material-v2'}));
 const rules=structuredClone(require('./core/core.mjs').captureRules());for(const flag of ['modelProjectionVersion','fantasyTimingVersion','visualSubjectsVersion'])delete rules[flag];
 const requestHash=source=>digest(buildRequest({stage:'plan',source,settings:{maxUnits:null},rulesSnapshot:rules}));
 const beforeHash=requestHash(baseline.source);
 for(const version of [undefined,'inline-performance-v1']){
  const run=structuredClone(saved);Object.assign(run.web.binding,{inputProtocol:'upstream-material-v2',sourceVersion:baseline.sourceVersion,sourceBasisVersion:baseline.sourceBasisVersion,contextEvidence:baseline.contextEvidence});
  if(version)run.web.binding.inlinePerformanceVersion=version;run.source=structuredClone(baseline.source);
  const before=JSON.stringify(run),f=fixture({run,handoff});f.current.content=text;
  const result=await f.service.refreshStoryboardRun(run,f.current);
  assert.equal(result.prepared.sourceVersion,baseline.sourceVersion);assert.equal(result.prepared.sourceBasisVersion,baseline.sourceBasisVersion);
  const frozen=await f.service.loadStoryboardInput(f.current,'','upstream-material-v2',undefined,version??false);
  assert.equal(requestHash(frozen.source),beforeHash);assert.equal(frozen.source.standardPackage.packageId,baseline.source.standardPackage.packageId);
  const fresh=await f.service.loadStoryboardInput(f.current);
  assert.equal(fresh.source.dialogue[0].speaker,'苏远');assert.equal(fresh.source.standardPackage.schemaVersion,'DIRECTOR_STANDARD_SCRIPT_SLICE_V5');
  assert.notEqual(fresh.sourceVersion,baseline.sourceVersion);assert.notEqual(fresh.sourceBasisVersion,baseline.sourceBasisVersion);
  assert.equal(JSON.stringify(run),before);assert.deepEqual(f.stats.dispatches,[]);assert.equal(f.stats.cliChecks,0);
 }
});

test('service reload keeps frozen boundary source, context evidence and full request hashes with real packets',async()=>{
 const {prepareStandardEpisode}=tsxRequire('../../lib/standard-script-plan.ts',import.meta.url);
 const {buildSourceIndex}=tsxRequire('../../lib/project-foundation-contracts.ts',import.meta.url);
 const {buildLightEpisodePackets}=tsxRequire('../../lib/light-foundation-supply.ts',import.meta.url);
 const {splitProductionMaterials}=require('../production-materials.mjs');
 const current={...episode,number:2,title:'第2集',content:'人物：苏远\n苏远抬头os：是这里。'};
 const episodes=[{id:'prior',projectId:current.projectId,number:1,title:'第1集',content:'导演备注抬头os：先看表情。'},current];
 const index=buildSourceIndex(episodes),context={version:'service-frozen-boundary',background:[],notices:[]};
 const document={revision:'fixture',sourceVersion:index.version,f2:null,editorialTodos:[]};
 const db={episode:{findMany:async()=>episodes},presentationContract:{findMany:async()=>[]},scriptScene:{findMany:async()=>[]}};
 const input={project:{...current.project,episodes},sourceIndex:index,sourceContext:context};
 const packet=async(options,saved)=>{const [packet]=await buildLightEpisodePackets(current.projectId,document,db,[2],{...input,scriptResolutions:saved},options);return {readiness:'READY',reasons:[],packet};};
 const rules=structuredClone(require('./core/core.mjs').captureRules());for(const flag of ['modelProjectionVersion','fantasyTimingVersion','visualSubjectsVersion','episodeEvidenceVersion'])delete rules[flag];
 const hash=source=>digest(buildRequest({stage:'plan',source,settings:{maxUnits:null},rulesSnapshot:rules}));
 for(const version of [undefined,'inline-performance-v1','inline-performance-v2']){
  const grammar=version??'inline-performance-v1',resolutions=Object.fromEntries(episodes.map(ep=>[ep.number,prepareStandardEpisode(ep.content,`episode-${ep.number}`,{inlinePerformanceVersion:grammar})]));
  const original=await packet({inlinePerformanceVersion:grammar},resolutions),baseline=splitProductionMaterials(makeEpisodeInput({episode:current,project:current.project,handoff:original,inputProtocol:'upstream-material-v2'}));
  const run=structuredClone(saved);Object.assign(run.web.binding,{episodeNumber:2,inputProtocol:'upstream-material-v2',sourceVersion:baseline.sourceVersion,sourceBasisVersion:baseline.sourceBasisVersion,contextEvidence:baseline.contextEvidence});
  if(version)run.web.binding.inlinePerformanceVersion=version;run.source=structuredClone(baseline.source);
  const before=JSON.stringify(run),f=fixture({run,episodeNumber:2,handoff:options=>packet(options)});Object.assign(f.current,current);
  const result=await f.service.refreshStoryboardRun(run,f.current);
  assert.equal(result.prepared.preparation.ready,true);assert.equal(result.prepared.sourceVersion,baseline.sourceVersion);assert.deepEqual(result.prepared.contextEvidence,baseline.contextEvidence);
  const frozen=await f.service.loadStoryboardInput(f.current,'','upstream-material-v2',undefined,version??false,f.service.storyboardEvidenceVersion(run.web.binding));
  assert.equal(frozen.source.context.episodeEvidenceVersion,undefined,'旧v2表演语法不代表新版按集历史供给');
  assert.deepEqual(frozen.source,baseline.source);assert.equal(hash(frozen.source),hash(baseline.source));assert.equal(JSON.stringify(run),before);
  assert.deepEqual(f.stats.dispatches,[]);assert.equal(f.stats.cliChecks,0);
 }
});

test('production boundary expansion and retention use each binding frozen grammar',async()=>{
 const helpers=tsxRequire('../../lib/episode-boundary-seed.ts',import.meta.url),{buildSourceIndex}=tsxRequire('../../lib/project-foundation-contracts.ts',import.meta.url);
 const previous='导演备注抬头os：先看表情。',index=buildSourceIndex([{number:1,title:null,content:previous},{number:2,title:null,content:'苏远：走。'}]);
 for(const version of [undefined,'inline-performance-v1','inline-performance-v2']){
  const options={inlinePerformance:!!version,inlinePerformanceVersion:version??'inline-performance-v1',syntax:'current'},seed=helpers.buildEpisodeBoundarySeed(index,[],2,options);
  const expected=helpers.expandEpisodeBoundarySeed(seed,previous,options),calls=[];
  const f=fixture({boundaryHelpers:{retainExpandedEpisodeBoundarySeed:(now,prior,actual)=>{calls.push(actual);return helpers.retainExpandedEpisodeBoundarySeed(now,prior,actual);},expandEpisodeBoundarySeed:(now,text,actual)=>{calls.push(actual);return helpers.expandEpisodeBoundarySeed(now,text,actual);}}});
  f.current.content=previous;
  const binding={projectId:episode.projectId,episodeNumber:2,inputProtocol:'upstream-material-v2',...(version?{inlinePerformanceVersion:version}:{})};
  const run={production:{needs:[{stage:1,target:'PREVIOUS_SOURCE'}]}};
  const current=await f.service.productionContextFromPrepared(binding,{episodeBoundarySeed:seed,materials:[]},run,f.service);
  assert.deepEqual(current.boundary.seed,expected);assert.deepEqual(structuredClone(calls),[options,options]);
  calls.length=0;
  const retained=await f.service.productionContextFromPrepared(binding,{episodeBoundarySeed:seed,materials:[]},{production:{boundary:{seed:expected}}},f.service);
  assert.deepEqual(retained.boundary.seed,expected);assert.deepEqual(structuredClone(calls),[options]);assert.deepEqual(f.stats.dispatches,[]);assert.equal(f.stats.cliChecks,0);
 }
});

test('preparation failure keeps saved index, detail, operations and raw JSON readable',async()=>{
 const f=fixture({sourceError:new Error('fixture unavailable')});
 const indexResponse=await f.get();assert.equal(indexResponse.status,200);
 const index=await indexResponse.json();
 assert.equal(index.runs[0].id,saved.id);
 assert.equal(index.preparation.ready,false);
 assert.equal(index.preparation.code,'CONTEXT_UNAVAILABLE');
 assert.equal('sourceStale' in index.runs[0],false,'selector cannot invent a frozen-task source diagnosis');
 assert.equal('blocked' in index.runs[0],false,'readiness belongs to preparation and the checked detail');
 assert.ok(index.sourceWarnings.length);
 const detailResponse=await f.get('?runId=saved-run');assert.equal(detailResponse.status,200);
 const detail=(await detailResponse.json()).run;
 assert.equal(detail.preparation.ready,false);
 assert.equal(detail.sourceStale,false,'a failed read does not prove that frozen source changed');
 assert.equal(detail.sourceCheckPending,true,'current source remains unverified and cannot authorize execution');
 assert.equal(detail.blocked,true);
 assert.equal(detail.operations[0].attemptId,'a1');
 assert.deepEqual(detail.sourceRows,saved.source.sourceRows);
 assert.equal(detail.error.code,'CONTEXT_UNAVAILABLE');
 const beforeExport=f.stats.sourceLoads;
 const raw=await f.get('?runId=saved-run&format=json');assert.equal(raw.status,200);
 assert.deepEqual(await raw.json(),saved);
 assert.equal(f.stats.sourceLoads,beforeExport);
 assert.equal((await f.get('?runId=saved-run&format=md')).status,503);
 assert.equal((await f.post({action:'pause',runId:saved.id})).status,200);
 assert.deepEqual(f.stats.dispatches,['pause']);
});

test('strict creation rejects unavailable source before persisting or measuring voice',async()=>{
 const f=fixture({sourceError:new Error('fixture unavailable')});
 const response=await f.post({action:'create'});
 assert.equal(response.status,503);
 assert.equal((await response.json()).code,'CONTEXT_UNAVAILABLE');
 assert.equal(f.stats.cliChecks,0);
 assert.equal(f.stats.voiceMeasurements,0);
});

test('wrapping a proven read outage preserves only its safe reconnect marker',async()=>{
 const f=fixture({sourceError:Object.assign(new Error('database is locked'),{code:'SQLITE_BUSY'})});
 await assert.rejects(f.service.loadStoryboardInput(f.current),e=>e.code==='CONTEXT_UNAVAILABLE'&&e.requestOutcome==='NOT_SENT'&&e.retryableRead===true);
 assert.equal(f.stats.voiceMeasurements,0);assert.deepEqual(f.stats.dispatches,[]);
 const unknown=fixture({sourceError:new Error('unproven read failure')});
 await assert.rejects(unknown.service.loadStoryboardInput(unknown.current),e=>e.code==='CONTEXT_UNAVAILABLE'&&e.retryableRead!==true);
});

test('default new input uses production material reader while saved standard/legacy keep their old reader',async()=>{
 const f=fixture();
 const current=await f.service.loadStoryboardInput(f.current);
 const standard=await f.service.loadStoryboardInput(f.current,'','standard-episode-v1');
 const legacy=await f.service.loadStoryboardInput(f.current,'','legacy');
 assert.deepEqual(f.stats.sourceProtocols,['upstream-material-v2','standard-episode-v1','legacy']);
 assert.deepEqual(f.stats.sourceReaders,['production','light','light']);
 assert.equal(current.source.context.seriesDirection,null);
 assert.equal(Object.hasOwn(standard.source.context,'seriesDirection'),false);
 assert.equal(Object.hasOwn(legacy.source.context,'seriesDirection'),false);
 assert.equal(standard.sourceVersion,prepared.sourceVersion);assert.equal(legacy.sourceVersion,prepared.sourceVersion);
 assert.deepEqual(f.stats.dispatches,[]);assert.equal(f.stats.cliChecks,0);
 for(const protocol of ['upstream-material-v2','standard-episode-v1','legacy']){
  const unavailable=fixture({sourceError:new Error('fixture unavailable')});
  await assert.rejects(unavailable.service.loadStoryboardInput(unavailable.current,'',protocol),e=>e.code==='CONTEXT_UNAVAILABLE');
  assert.deepEqual(unavailable.stats.sourceProtocols,[protocol]);assert.deepEqual(unavailable.stats.dispatches,[]);
 }
});

test('new run binding explicitly persists upstream-material-v2 without invoking a generation model',async()=>{
 let created=null;
 const f=fixture({coordinatorOverrides:{create:async value=>{created=value;return value;}}});
 await f.service.createStoryboardRun(f.current,{settings:{fantasyMode:'off'}});
 assert.equal(created.binding.inputProtocol,'upstream-material-v2');
 assert.equal(created.settings.model,'gpt-6.1-sol');assert.equal(created.settings.reasoning,'medium');
 assert.equal(created.source.context.seriesDirection,null);
 assert.deepEqual(f.stats.sourceReaders,['production']);assert.equal(f.stats.voiceMeasurements,1);
 assert.deepEqual(f.stats.dispatches,[]);assert.equal(f.stats.cliChecks,0);
});

test('paid starts and candidate rechecks reject missing or changed source before dispatch',async()=>{
 const commands=[{action:'start',mode:'all'},{action:'repair',packageIds:['P1'],notes:'局部返修'},{action:'replan'},{action:'recheck',candidateId:'c1'}];
 for(const sourceMissing of [true,false])for(const command of commands){
  const f=fixture({sourceError:sourceMissing?new Error('fixture unavailable'):null});
  if(!sourceMissing)f.current.content+='\n△甲后退。';
  const response=await f.post({...command,runId:saved.id});
  assert.equal(response.status,sourceMissing?503:409,`${command.action} sourceMissing=${sourceMissing}`);
  assert.equal((await response.json()).code,sourceMissing?'CONTEXT_UNAVAILABLE':'SOURCE_STALE');
  assert.deepEqual(f.stats.dispatches,[]);
  assert.equal(f.stats.cliChecks,0);
 }
});

test('current source permits explicit starts, but stored stale state still rejects',async()=>{
 const f=fixture();
 assert.equal((await f.post({action:'start',runId:saved.id,mode:'next'})).status,202);
 assert.deepEqual(f.stats.dispatches,['start']);
 f.run.web.sourceStale=true;
 const response=await f.post({action:'start',runId:saved.id,mode:'next'});
 assert.equal(response.status,409);
 assert.equal((await response.json()).code,'SOURCE_STALE');
 assert.deepEqual(f.stats.dispatches,['start']);
});

for(const state of ['adopted','resolved'])test(`direct POST cannot recheck ${state} candidate or change saved output`,async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'storyboard-post-recheck-'));
 try{
  const engine=createEngine({directory,modelRunner:async()=>assert.fail('recheck must never invoke a model')});
  const store=createStore(directory);
  await engine.create({id:saved.id,source:prepared.source,settings:{fantasyMode:'off',maxUnits:null}});
  await store.update(saved.id,d=>{
   const request=buildRequest({stage:'plan',source:d.source,settings:d.settings,choice:d.choice,rulesSnapshot:d.rulesSnapshot,voiceReference:d.voiceReference,packageIds:[],dependencyExits:{}});
   d.epoch=7;
   d.web={...structuredClone(saved.web),progress:'text_ready_for_review'};
   d.status='text_ready_for_review';
   d.operations=[{attemptId:'saved-attempt',stage:'plan',packageIds:[],epoch:d.epoch,status:'completed',previousDraft:null,issues:[],dependencyFormat:'continuity-v1',finishMode:'full',fingerprint:digest([request.promptHash,request.instructionHash,request.inputHash])}];
   d.candidates=[{id:'saved-candidate',attemptId:'saved-attempt',stage:'plan',packageIds:[],output:{savedResponse:true},raw:'{"savedResponse":true}',status:state==='adopted'?'adopted':'needs_repair',...(state==='resolved'?{resolvedBy:'newer-candidate'}:{})}];
   d.assembly={text:'已完成整编原稿，禁止重核历史时清空。',validation:{errors:[]},draft:{units:[]}};
   return d;
  });
  const file=path.join(directory,'documents',`${saved.id}.json`),before=await readFile(file,'utf8');
  const document=JSON.parse(before);
  assert.equal(canRecheckCandidate(document,{...document.candidates[0],status:'needs_repair',resolvedBy:undefined}),true,'the saved response must otherwise satisfy current scope, epoch and request identity');
  const f=fixture({coordinatorOverrides:{read:engine.read,recheck:engine.recheckCandidate}});
  const response=await f.post({action:'recheck',runId:saved.id,candidateId:'saved-candidate'});
  const body=await response.json(),after=await readFile(file,'utf8');
  assert.equal(response.status,409,`${state} must be rejected before writing; saved document changed=${before!==after}`);
  assert.equal(body.code,'RECHECK_INELIGIBLE');
  assert.equal(after,before,'the entire stored document, assembly, candidates and epoch must stay byte-identical');
  assert.equal(f.stats.cliChecks,0);
 }finally{await rm(directory,{recursive:true,force:true});}
});
