import test from 'node:test';
import assert from 'node:assert/strict';
import {makeEpisodeInput, publicRun} from './input.mjs';
const episode={id:'ep1',projectId:'p1',number:2,title:'硬顶',content:'2-1 日 外 城墙\n苏炎：（怒吼）我还没输！\n△苏炎撑住，没有跪下。'};
const project={id:'p1',style:'3D国漫',aspectRatio:'16:9'};
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
test('late completed response remains discoverable until explicitly recovered and receipt-only usage is retained',()=>{
 const d=failedPlan();d.epoch=1;d.candidates=[{id:'late',attemptId:'a1',status:'cancelled_late'}];
 d.operations[0].receipt={requestOutcome:'RESPONDED',usage:{inputTokens:8,outputTokens:2,cachedInputTokens:0,totalTokens:10}};
 assert.equal(publicRun(d).operations[0].canRecoverSaved,true);assert.equal(publicRun(d).usage.knownTokens,10);
 d.operations[0].recovery={epoch:1};assert.equal(publicRun(d).operations[0].canRecoverSaved,false);
});
