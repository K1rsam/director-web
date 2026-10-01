import test from 'node:test';
import assert from 'node:assert/strict';
import {makeEpisodeInput, publicRun} from './input.mjs';
const episode={id:'ep1',projectId:'p1',number:2,title:'硬顶',content:'2-1 日 外 城墙\n苏炎：（怒吼）我还没输！\n△苏炎撑住，没有跪下。'};
const project={id:'p1',style:'3D国漫',aspectRatio:'16:9'};
test('legacy public views with no candidate collection still expose unresolved operations',()=>{
 const view=publicRun({id:'legacy',epoch:0,status:'unknown',operations:[{attemptId:'old',status:'unknown',stage:'author'}]});
 assert.equal(view.operations.length,1);assert.equal(view.operations[0].canRecoverSaved,false);
 assert.equal(view.usage.complete,false);assert.equal(view.status,'unknown');
});
test('project style label retains its complete visual basis and actual aspect ratio',()=>{
 const result=makeEpisodeInput({episode,project:{...project,aspectRatio:'9:16'}});
 assert.match(result.visualStyle,/赛璐璐/);assert.match(result.visualStyle,/PBR/);
 assert.match(result.visualStyle,/9:16/);assert.doesNotMatch(result.visualStyle,/16:9/);
 assert.match(result.visualStyle,/惯性/);assert.match(result.visualStyle,/口型/);
});
test('2D, live action and custom choices cannot inherit an incompatible 3D rendering preset',()=>{
 for(const style of ['2D动漫','真人电影写实','古装电影写实','水墨留白，墨色晕染，保持手绘纸纹']){
  const result=makeEpisodeInput({episode,project:{...project,style}});
  assert.ok(result.visualStyle.includes(style));
  assert.doesNotMatch(result.visualStyle,/C4D|Octane|PBR|三渲二/);
 }
});
test('input preserves original, actual previous excerpt and fact-vs-design boundary',()=>{
 const result=makeEpisodeInput({episode,project,notes:'严肃不甘',handoff:{readiness:'PARTIAL',reasons:['资产待完善'],packet:{sourceText:episode.content,assets:[],scenes:[],followUps:[],boundaryContext:{previousSource:{episode:1,text:'△苏炎收起火焰。',clipped:true},priorStates:[],gaps:['只有末段']}}}});
 assert.equal(result.source.dialogue[0].quote,'我还没输！');assert.equal(result.source.contextRows[0].text,'△苏炎收起火焰。');
 assert.equal(result.source.context.directorNotes,'严肃不甘');assert.match(JSON.stringify(result.source.context),/只有末段/);assert.equal(result.warnings[0],'资产待完善');
 assert.notEqual(result.sourceVersion,makeEpisodeInput({episode:{...episode,content:episode.content+'\n△敌人后退。'},project}).sourceVersion);
});
test('stale handoff cannot replace current episode text',()=>{
 const result=makeEpisodeInput({episode,project,handoff:{packet:{sourceText:'旧文',assets:[{name:'旧资产'}]}}});
 assert.equal(result.source.dialogue[0].quote,'我还没输！');assert.deepEqual(result.source.assets,[]);assert.ok(result.warnings.some(s=>s.includes('不一致')));
});
test('public view removes prompt/raw snapshots and counts an attempt only once',()=>{
 const d={id:'r',status:'drafting',settings:{fantasyMode:'off'},source:{sourceRows:[],diagnostics:[]},plan:null,choice:{mode:'off'},operations:[{attemptId:'a',stage:'author',status:'completed',packageIds:['P1']}],candidates:[{id:'c1',attemptId:'a',status:'needs_repair',raw:'private huge',output:{},receipt:{usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,totalTokens:12}}},{id:'c2',attemptId:'a',status:'adopted',raw:'private huge',receipt:{usage:{inputTokens:10,outputTokens:2,cachedInputTokens:0,totalTokens:12}}}],adopted:[],rulesSnapshot:{secret:'do not ship'},web:{binding:{episodeId:'ep1'},budget:{maxCalls:32,maxTokens:300000,maxRepairs:2}}};
 const view=publicRun(d);assert.equal(view.usage.totalTokens,12);assert.equal(view.usage.complete,true);assert.ok(!JSON.stringify(view).includes('private huge'));assert.ok(!JSON.stringify(view).includes('do not ship'));
 d.operations.push({attemptId:'unknown',status:'unknown'});assert.equal(publicRun(d).usage.complete,false);
});
test('public view exposes current-run scheduling only when supplied, without treating queue as active model work',()=>{
 const d={id:'queued',status:'planned',operations:[],candidates:[],adopted:[],web:{progress:'running'}};
 assert.equal(publicRun(d).scheduling,undefined);
 const scheduling={maxConcurrent:4,maxPerEpisode:2,inFlight:0,queued:2,otherRuns:['private-id']};
 const view=publicRun(d,{active:true,scheduling});
 assert.deepEqual(view.scheduling,{maxConcurrent:4,maxPerEpisode:2,inFlight:0,queued:2});
 assert.equal(view.active,true);assert.equal(view.operations.length,0);
 assert.ok(!JSON.stringify(view).includes('private-id'));
});
test('public view matches execution evidence by attempt and exposes only receipt metadata',()=>{
 const d={id:'execution',status:'running',operations:[{attemptId:'old',status:'completed'},{attemptId:'live',status:'running'}],candidates:[],adopted:[],web:{progress:'running'}};
 const execution={phase:'waiting',startedAt:'2026-09-30T00:00:00.000Z',lastEventAt:'2026-09-30T00:00:10.000Z',lastProgressAt:null,eventCount:3,timeoutKind:null,limits:{startupMs:30000,idleMs:60000,totalMs:180000},workload:{stage:'author',promptChars:1200,unitCount:2},lastEventType:'thread.started'};
 assert.equal(publicRun(d).operations[1].execution,undefined,'legacy receipts must not invent execution activity');
 const view=publicRun(d,{active:true,executions:[{attemptId:'live',execution:{...execution,reasoning:'private reasoning',diagnostics:'private stderr',limits:{...execution.limits,secret:'private limit'},workload:{...execution.workload,prompt:'private prompt'}}},{attemptId:'other-run',execution:{phase:'generating'}}]});
 assert.equal(view.operations[0].execution,undefined);assert.deepEqual(view.operations[1].execution,execution);
 assert.doesNotMatch(JSON.stringify(view),/private |other-run/);
 assert.equal(view.operations[1].execution.lastProgressAt,null,'events alone are not generation evidence');
});
test('public execution dates are canonical metadata, never objects or free-form diagnostic text',()=>{
 const d={id:'safe-metadata',operations:[{attemptId:'a',status:'running'}],candidates:[],adopted:[]};
 const execution={phase:'waiting',startedAt:'Wed, 30 Sep 2026 00:00:00 GMT (private reasoning)',lastEventAt:{toString:'private object'},lastProgressAt:'Wed, 30 Sep 2026 00:00:05 GMT (private diagnostic)',eventCount:'private count',timeoutKind:'private timeout',limits:{startupMs:'private limit',idleMs:60000,totalMs:180000},workload:{stage:'private stage',promptChars:{text:'private prompt'},unitCount:2},lastEventType:'private stderr'};
 const view=publicRun(d,{active:true,executions:[{attemptId:'a',execution}]});
 assert.equal(view.operations[0].execution.startedAt,'2026-09-30T00:00:00.000Z');assert.equal(view.operations[0].execution.lastEventAt,null);assert.equal(view.operations[0].execution.lastProgressAt,'2026-09-30T00:00:05.000Z');
 assert.doesNotMatch(JSON.stringify(view),/private/);
 assert.equal(publicRun(d,{executions:[{attemptId:'a',execution:{...execution,startedAt:{toString:'private object'}}}]}).operations[0].execution,undefined);
});
test('timeout attention and acknowledgement preserve unknown usage and original timeout evidence',()=>{
 const d={id:'timeout',status:'failed',operations:[{attemptId:'t',status:'unknown',error:{code:'TIMEOUT',requestOutcome:'UNKNOWN'}}],candidates:[],adopted:[],web:{progress:'unknown'}};
 const cancellation={attemptId:'t',canAcknowledge:true,kind:'timeout',reason:'本机进程已结束，没有正文回包'};
 const execution={phase:'failed',startedAt:'2026-09-30T00:00:00Z',lastEventAt:'2026-09-30T00:00:05Z',lastProgressAt:null,eventCount:1,timeoutKind:'idle',limits:{startupMs:30000,idleMs:60000,totalMs:180000},workload:{stage:'author',promptChars:1200,unitCount:2},lastEventType:'thread.started'};
 const pending=publicRun(d,{cancellations:[cancellation],executions:[{attemptId:'t',execution}]});
 assert.match(pending.error.message,/超时/);assert.equal(pending.operations[0].execution.timeoutKind,'idle');assert.equal(pending.cancellations[0].kind,'timeout');
 d.web.progress='paused';d.web.error={code:'TIMEOUT',message:'本次调用等待超时'};d.operations[0].cancelAcknowledgement={at:'2026-09-30T00:01:00Z',acceptUnknownUsage:true,kind:'timeout'};
 const acknowledged=publicRun(d,{executions:[{attemptId:'t',execution}]});
 assert.equal(acknowledged.usage.complete,false);assert.equal(acknowledged.usage.acknowledgedUnknownAttempts,1);assert.equal(acknowledged.error.code,'TIMEOUT');assert.equal(acknowledged.operations[0].execution.timeoutKind,'idle');
});
const failedPlan=()=>({id:'failed-plan',status:'needs_repair',plan:null,choice:{mode:'off'},operations:[{attemptId:'a1',stage:'plan',status:'completed',packageIds:[]}],candidates:[{id:'c1',attemptId:'a1',stage:'plan',status:'needs_repair',packageIds:[],errors:[{code:'ENTRY_FACT_EVIDENCE',at:'entryFacts.F1',detail:'引用的前情未能支持这个事实'}]}],adopted:[],web:{progress:'running',owner:null,error:null}});
test('public view surfaces saved plan validation failure instead of an empty error',()=>{
 const view=publicRun(failedPlan());
 assert.equal(view.status,'needs_repair');assert.equal(view.active,false);assert.equal(view.plan,null);
 assert.equal(view.error?.code,'ENTRY_FACT_EVIDENCE');assert.match(view.error?.message||'',/entryFacts.F1/);assert.match(view.error?.message||'',/引用的前情未能支持这个事实/);assert.equal(view.lastCandidateId,'c1');
});
test('public view includes validation detail and preserves higher priority errors',()=>{
 const d=failedPlan();d.candidates[0].errors=[];d.candidates[0].validation={errors:[{code:'SOURCE_REF',detail:'原文位置缺失'}]};
 assert.match(publicRun(d).error?.message||'',/原文位置缺失/);
 for(const code of ['UNKNOWN','SOURCE_STALE']){d.web.error={code,message:'必须先处理主错误'};assert.deepEqual(publicRun(d).error,d.web.error);}
 d.web.error=null;d.operations[0].status='running';assert.equal(publicRun(d).error.code,'INTERRUPTED');
});
test('resolved plan history no longer raises an active validation error',()=>{
 const d=failedPlan();d.candidates[0].resolvedBy='c2';d.status='planned';d.web.progress='planned';
 const view=publicRun(d);assert.equal(view.error,null);assert.equal(view.lastCandidateId,null);
});
test('attention states remain primary even without a stored error object',()=>{
 const d=failedPlan();assert.equal(publicRun(d,{sourceStale:true}).error?.code,'SOURCE_STALE');
 d.web.progress='unknown';assert.equal(publicRun(d).error?.code,'UNKNOWN');
});
test('paused stages retain progress and acknowledged unknown usage never becomes zero-cost success',()=>{
 const d=failedPlan();d.candidates=[];d.status='cancelled';d.web.progress='paused';d.web.stopped=true;
 d.operations=[{attemptId:'a1',stage:'author',status:'unknown',packageIds:['P1'],error:{code:'ABORTED',requestOutcome:'UNKNOWN'}}];
 const pending=publicRun(d,{cancellations:[{attemptId:'a1',canAcknowledge:true,reason:'本地已中断，未收到结果，用量未知'}]});
 assert.equal(pending.status,'paused');assert.equal(pending.error.code,'UNKNOWN');assert.equal(pending.cancellations[0].canAcknowledge,true);
 d.operations[0].cancelAcknowledgement={at:'2026-09-25T00:00:00Z',acceptUnknownUsage:true};
 const acknowledged=publicRun(d);
 assert.equal(acknowledged.error,null);assert.equal(acknowledged.usage.complete,false);assert.equal(acknowledged.usage.acknowledgedUnknownAttempts,1);
 assert.equal(acknowledged.usage.knownTokens,0);assert.equal(acknowledged.operations[0].error.requestOutcome,'UNKNOWN');
 assert.equal(acknowledged.operations[0].cancelAcknowledgement.acceptUnknownUsage,true);
 d.operations=[];d.web.progress='pausing';assert.equal(publicRun(d,{active:true}).status,'pausing');
});
test('saved successful response exposes usage review without inventing failure, recovery or zero usage',()=>{
 const d={id:'saved-usage',status:'planned',operations:[{attemptId:'saved',stage:'plan',status:'completed',packageIds:[],receipt:{requestOutcome:'RESPONDED',usage:null}}],candidates:[{id:'accepted',attemptId:'saved',stage:'plan',status:'adopted',receipt:{requestOutcome:'RESPONDED',usage:null}}],adopted:[],web:{progress:'usage_review'}};
 const cancellation={attemptId:'saved',kind:'usage',canAcknowledge:true,reason:'结果已保存，用量未完整返回'};
 const pending=publicRun(d,{cancellations:[cancellation]});
 assert.equal(pending.status,'usage_review');assert.equal(pending.error.code,'USAGE_UNKNOWN');assert.match(pending.error.message,/回包已保存.*用量/);
 assert.equal(pending.operations[0].status,'completed');assert.equal(pending.operations[0].usage,null);assert.equal(pending.operations[0].canRecoverSaved,false);
 assert.equal(pending.usage.complete,false);assert.equal(pending.usage.unknownAttempts,1);assert.equal(pending.usage.acknowledgedUnknownAttempts,0);assert.deepEqual(pending.cancellations,[cancellation]);
 d.operations[0].cancelAcknowledgement={at:'2026-09-30T00:01:00Z',acceptUnknownUsage:true,kind:'usage'};d.web.progress='planned';
 const acknowledged=publicRun(d);
 assert.equal(acknowledged.status,'planned');assert.equal(acknowledged.error,null);assert.equal(acknowledged.operations[0].status,'completed');assert.equal(acknowledged.operations[0].usage,null);
 assert.equal(acknowledged.usage.complete,false);assert.equal(acknowledged.usage.unknownAttempts,1);assert.equal(acknowledged.usage.acknowledgedUnknownAttempts,1);
});
test('late completed response remains discoverable until explicitly recovered and receipt-only usage is retained',()=>{
 const d=failedPlan();d.epoch=1;d.candidates=[{id:'late',attemptId:'a1',status:'cancelled_late'}];
 d.operations[0].receipt={requestOutcome:'RESPONDED',usage:{inputTokens:8,outputTokens:2,cachedInputTokens:0,totalTokens:10}};
 assert.equal(publicRun(d).operations[0].canRecoverSaved,true);assert.equal(publicRun(d).usage.knownTokens,10);
 d.operations[0].recovery={epoch:1};assert.equal(publicRun(d).operations[0].canRecoverSaved,false);
});
test('completed timeout with unparsed saved text remains freely recoverable, not unknown-risk acknowledgement',()=>{
 const d=failedPlan();d.epoch=1;d.web.progress='needs_repair';
 d.operations=[{attemptId:'body',stage:'author',packageIds:['P1'],status:'completed',epoch:1,error:{code:'TIMEOUT',requestOutcome:'RESPONDED'},receipt:{requestOutcome:'RESPONDED',usage:null}}];
 d.candidates=[{id:'raw-body',attemptId:'body',stage:'author',packageIds:['P1'],status:'needs_repair',raw:'{"saved":"body"}',output:null,errors:[{code:'TIMEOUT',requestOutcome:'RESPONDED'}]}];
 const view=publicRun(d);
 assert.equal(view.operations[0].canRecoverSaved,true,'saved text must be offered for free parsing before any new model call');assert.deepEqual(view.cancellations,[]);assert.equal(view.operations[0].status,'completed');
 d.candidates[0].resolvedBy='parsed';assert.equal(publicRun(d).operations[0].canRecoverSaved,false);
});
