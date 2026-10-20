import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {requestMetrics,summarizeRun,inspectProductionUsage} from './inspect-production-usage.mjs';
import {sealUnsentProof} from '../runtime/storyboard-v4/core/pre-dispatch-evidence.mjs';

test('read-only audit exposes candidate reception errors and their resolution without inventing calls or cost',()=>{
 const run={id:'run',operations:[{attemptId:'paid',stage:'finish',status:'completed'}],candidates:[
  {id:'rejected',attemptId:'paid',stage:'finish',status:'needs_repair',resolvedBy:'replacement',errors:[{code:'PRODUCTION_FEEDBACK',message:'private source text'}],validation:{errors:[{code:'SOURCE_REFS'}]}},
  {id:'replacement',attemptId:'other',stage:'finish',status:'adopted'},
  {id:'unbound',attemptId:'missing',stage:'author',status:'needs_repair',errors:[{code:'GROUP_SCOPE'}]}
 ]};
 const before=JSON.stringify(run),result=summarizeRun(run,new Map());
 assert.deepEqual(result.candidateErrors,[
  {candidateId:'rejected',attemptId:'paid',stage:'finish',status:'needs_repair',resolvedBy:'replacement',errorCodes:['PRODUCTION_FEEDBACK'],validationErrorCodes:['SOURCE_REFS']},
  {candidateId:'unbound',attemptId:'missing',stage:'author',status:'needs_repair',resolvedBy:null,errorCodes:['GROUP_SCOPE'],validationErrorCodes:[]}
 ]);
 assert.equal(result.attemptCount,1);assert.equal(result.totalTokens,null);assert.equal(result.dispatchedAttempts,0);
 assert.equal(JSON.stringify(run),before);assert.equal(JSON.stringify(result).includes('private source text'),false);
});

test('additive pre-dispatch absence overrides a local placeholder, never an actual native request or receipt',()=>{
 const op={attemptId:'loader',status:'completed',localSettledAt:'2026-10-18T18:36:20Z',error:{code:'ERR_REQUIRE_ESM_RACE_CONDITION',requestOutcome:'UNKNOWN'},receipt:{requestOutcome:'RESPONDED',usage:null}};
 op.localDispatchProof=sealUnsentProof(op,{scope:'BOUND_MODEL_ADAPTER',nativeDirectoryAbsent:true,ledgerAttemptAbsent:true,candidateAbsent:true});
 const r=summarizeRun({operations:[op]},new Map());assert.equal(r.calls[0].notSent,true);assert.equal(r.dispatchedAttempts,0);assert.equal(r.calls[0].usage,null);assert.equal(r.calls[0].durationMs,null);assert.equal(r.unknownAttempts,0);assert.equal(op.error.requestOutcome,'UNKNOWN');
 for(const evidence of [{request:{prompt:'actual'}},{receipt:{state:'SUBMITTING',requestOutcome:'UNKNOWN'}}])assert.equal(summarizeRun({operations:[op]},new Map([['loader',evidence]])).calls[0].notSent,false);
});

test('native execution duration is deduplicated and remains distinct from wall time including pauses',()=>{
 const a={attemptId:'a',stage:'plan',status:'completed',createdAt:'2026-10-14T00:00:00Z',receipt:{durationMs:2000,execution:{startedAt:'2026-10-14T00:00:01Z',terminalAt:'2026-10-14T00:00:03Z'},usage:{inputTokens:8,outputTokens:2,totalTokens:10}}};
 const b={attemptId:'b',stage:'finish',status:'completed',createdAt:'2026-10-14T01:00:00Z',receipt:{durationMs:3000,execution:{startedAt:'2026-10-14T01:00:01Z',terminalAt:'2026-10-14T01:00:04Z'},usage:{inputTokens:8,outputTokens:2,totalTokens:10}}};
 const result=summarizeRun({id:'run',operations:[a,a,b]},new Map());
 assert.equal(result.modelDurationMs,5000);assert.equal(result.elapsedMs,3604000);
 assert.equal(result.calls[0].durationMs,2000);assert.equal(result.dispatchedAttempts,2);
 const missing=summarizeRun({operations:[a,{...b,receipt:{...b.receipt,durationMs:undefined}}]},new Map());
 assert.equal(missing.modelDurationMs,null);assert.equal(missing.knownModelDurationMs,2000,'缺少耗时不猜0');
});

test('an unresolved native heartbeat cannot prove final execution duration after local unknown recovery',()=>{
 const op={attemptId:'orphan',stage:'author',status:'unknown',createdAt:'2026-10-14T00:00:00Z',localSettledAt:'2026-10-14T00:00:04Z',receipt:{state:'FINAL',durationMs:4000}};
 const result=summarizeRun({operations:[op]},new Map([['orphan',{receipt:{state:'SUBMITTING',durationMs:1500,requestOutcome:'UNKNOWN',execution:{startedAt:'2026-10-14T00:00:01Z'}}}]]));
 assert.equal(result.calls[0].durationMs,null);
 assert.equal(result.modelDurationMs,null);assert.equal(result.timingComplete,false);
 assert.equal(result.knownModelDurationMs,0);assert.equal(result.elapsedMs,null);
 const localUnknown=summarizeRun({operations:[{...op,receipt:{durationMs:4000}}]},new Map());
 assert.equal(localUnknown.modelDurationMs,null,'local unknown settlement is not a completed model receipt');
});

test('explicit orphan closure supplies wall time only, never native execution time or usage',()=>{
 const closedAt='2026-10-14T00:00:04Z';
 const orphan={attemptId:'orphan',stage:'author',status:'unknown',createdAt:'2026-10-14T00:00:00Z',localSettledAt:closedAt,cancelAcknowledgement:{kind:'orphan',acceptUnknownUsage:true,at:closedAt}};
 const finish={attemptId:'finish',stage:'finish',status:'completed',createdAt:'2026-10-14T01:00:00Z'};
 const attempts=new Map([
  ['orphan',{receipt:{state:'SUBMITTING',requestOutcome:'UNKNOWN',durationMs:1500,usage:null}}],
  ['finish',{receipt:{state:'FINAL',requestOutcome:'RESPONDED',durationMs:2000,execution:{terminalAt:'2026-10-14T01:00:04Z'},usage:{inputTokens:8,cachedInputTokens:0,outputTokens:2,totalTokens:10}}}]
 ]);
 const r=summarizeRun({status:'text_ready_for_review',operations:[orphan,finish]},attempts);
 assert.equal(r.elapsedMs,3604000);assert.equal(r.modelDurationMs,null);assert.equal(r.knownModelDurationMs,2000);
 assert.equal(r.calls[0].durationMs,null);assert.equal(r.calls[0].finishedAt,null);assert.equal(r.calls[0].localClosedAt,closedAt);
 assert.equal(r.totalTokens,null);assert.equal(r.knownTokens,10);assert.equal(r.unknownAttempts,1);
 for(const change of [{cancelAcknowledgement:undefined},{cancelAcknowledgement:{kind:'orphan',acceptUnknownUsage:false,at:closedAt}},
  {cancelAcknowledgement:{kind:'timeout',acceptUnknownUsage:true,at:closedAt}},{localSettledAt:'bad'},
  {localSettledAt:'2026-10-13T23:00:00Z',cancelAcknowledgement:{kind:'orphan',acceptUnknownUsage:true,at:'2026-10-13T23:00:00Z'}},
  {cancelAcknowledgement:{kind:'orphan',acceptUnknownUsage:true,at:'2026-10-14T00:00:05Z'}}]){
  const invalid=summarizeRun({operations:[{...orphan,...change},finish]},attempts);
  assert.equal(invalid.elapsedMs,null,'unbound or unaccepted local closure cannot invent wall time');
  assert.equal(invalid.modelDurationMs,null);assert.equal(invalid.totalTokens,null);
 }
});

test('native total includes cached input and reasoning only once, and deduplicates attempts',()=>{
 const op={attemptId:'a',stage:'author',status:'completed',receipt:{usage:{inputTokens:100,cachedInputTokens:80,outputTokens:20,reasoningOutputTokens:10,totalTokens:120}}};
 const result=summarizeRun({id:'run',status:'text_ready_for_review',source:{sourceRows:[{text:'甲：开始。'}]},operations:[op,op]},new Map());
 assert.equal(result.knownTokens,120);assert.equal(result.inputTokens,100);assert.equal(result.outputTokens,20);assert.equal(result.cachedInputTokens,80);assert.equal(result.attemptCount,1);
 assert.deepEqual(result.duplicateAttempts,['a']);
});
test('running and unknown calls cannot be reported as a complete zero-cost episode',()=>{
 const result=summarizeRun({id:'run',status:'running',operations:[{attemptId:'a',status:'running'},{attemptId:'b',status:'unknown'}]},new Map());
 assert.equal(result.inFlight,1);assert.equal(result.unknownAttempts,1);assert.equal(result.totalTokens,null);
 assert.equal(result.usageComplete,false);
});
test('inconsistent usage is unknown, not a reconstructed total',()=>{
 const result=summarizeRun({operations:[{attemptId:'a',status:'completed',receipt:{usage:{inputTokens:100,outputTokens:20,totalTokens:90}}}]},new Map());
 assert.equal(result.unknownAttempts,1);assert.equal(result.totalTokens,null);
});
test('known total with missing cache detail does not invent zero cached input',()=>{
 const operations=[
  {attemptId:'a',status:'completed',receipt:{usage:{inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:80}}},
  {attemptId:'b',status:'completed',receipt:{usage:{inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:null}}}
 ];
 const result=summarizeRun({operations},new Map());
 assert.equal(result.totalTokens,240);assert.equal(result.usageComplete,true);
 assert.equal(result.cachedInputTokens,null);assert.equal(result.cachedUsageComplete,false);assert.equal(result.knownCachedInputTokens,80);
});
test('a verified NOT_SENT gate failure is zero dispatch, while an unknown CLI rejection stays unknown',()=>{
 const result=summarizeRun({operations:[
  {attemptId:'not-sent',status:'failed',error:{code:'WORKFLOW_PAUSED',requestOutcome:'NOT_SENT'}},
  {attemptId:'cli-unknown',status:'unknown',error:{code:'CLI_FAILED',requestOutcome:'UNKNOWN'}}
 ]},new Map());
 assert.equal(result.calls[0].notSent,true);assert.equal(result.calls[0].usageKnown,true);assert.equal(result.calls[0].usage,null,'no fabricated native token receipt');
 assert.equal(result.calls[1].usageKnown,false);assert.equal(result.unknownAttempts,1);assert.equal(result.totalTokens,null);
});
test('a completed local gate operation is not a model call, but a contradictory positive receipt cannot be hidden',()=>{
 const op={attemptId:'local-gate',status:'completed',localSettledAt:'2026-10-14T00:00:00Z',receipt:{requestOutcome:'NOT_SENT',usage:null},error:{code:'WORKFLOW_PAUSED',requestOutcome:'NOT_SENT'}};
 const free=summarizeRun({operations:[op]},new Map());
 assert.equal(free.calls[0].notSent,true);assert.equal(free.unknownAttempts,0);assert.equal(free.totalTokens,0);assert.equal(free.calls[0].usage,null);
 const positive=summarizeRun({operations:[{...op,receipt:{state:'FINAL',requestOutcome:'NOT_SENT',usage:{inputTokens:10,outputTokens:5,totalTokens:15,cachedInputTokens:0}}}]},new Map());
 assert.equal(positive.calls[0].notSent,false);assert.equal(positive.knownTokens,15,'positive native evidence is not erased by the gate label');
 const activeNative=summarizeRun({operations:[op]},new Map([['local-gate',{receipt:{state:'DISPATCHING',requestOutcome:'UNKNOWN',usage:null}}]]));
 assert.equal(activeNative.calls[0].notSent,false);assert.equal(activeNative.unknownAttempts,1,'native unresolved evidence overrides a local not-sent label');
});
test('metrics measure actual sent prompt body, not unsent snapshot fields or invented field tokens',()=>{
 const body={source:{sourceRows:[{text:'甲：好。'}],context:{seriesDirection:'喜剧',retrievalFacts:{rows:[['历史证据']]}}},productionMaterials:[{id:'CH01'}],episodeBoundary:{opening:'入场'}};
 const request={stage:'plan',prompt:'规则\n【生效设置与本次完整资料】\n'+JSON.stringify(body)+'\n结尾',instructions:'系统',schema:{type:'object'},source:{sourceRows:[{text:'这份快照未直接送出'}]}};
 const metrics=requestMetrics(request);
 assert.equal(metrics.contextChars,JSON.stringify(body.source.context).length);
 assert.equal(metrics.retrievalChars,JSON.stringify(body.source.context.retrievalFacts).length);
 assert.equal(metrics.rulePrefixChars,3);assert.equal(metrics.sourceRowCount,1);
 assert.equal(metrics.sentChars,request.prompt.length+request.instructions.length+JSON.stringify(request.schema).length);
 assert.equal(metrics.fieldTokens,undefined);
});
test('read-only audit tolerates a missing in-flight request and does not mutate workflow',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'production-usage-'));
 try{
  await mkdir(path.join(dir,'runs','documents'),{recursive:true});
  const workflow=JSON.stringify({id:'flow',revision:1,selectedRuns:{1:'one'},parallel:{executionTier:'standard',lanes:[[1]]}});
  const file=path.join(dir,'workflow.json');await writeFile(file,workflow);
  await writeFile(path.join(dir,'runs','documents','one.json'),JSON.stringify({id:'one',status:'running',settings:{model:'gpt-6.1-sol',reasoning:'medium'},operations:[{attemptId:'pending',stage:'plan',status:'running'}]}));
  const report=await inspectProductionUsage({workflowFile:file,runDirectory:path.join(dir,'runs')});
  assert.equal(report.episodes[0].inFlight,1);assert.equal(report.episodes[0].totalTokens,null);
  assert.equal(report.episodes[0].calls[0].requestMissing,true);
  assert.equal(report.executionTier,'standard');
  const {readFile}=await import('node:fs/promises');assert.equal(await readFile(file,'utf8'),workflow);
 }finally{await rm(dir,{recursive:true,force:true});}
});
