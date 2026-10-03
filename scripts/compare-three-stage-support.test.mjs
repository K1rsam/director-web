import test from 'node:test';
import assert from 'node:assert/strict';
import {parseComparisonArgs,assertEpisodeGate,assertNoUnknownUsage,assertSharedSettings,inspectPayload,inspectWireRequest,sourceDifference,chooseComparisonAction,assertCampaignBinding,suppressGeneratedPrismaEnv,canCloseRecoveredStep,assertReview,hash} from './compare-three-stage-support.mjs';
import * as support from './compare-three-stage-support.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createProductionBudgetStore} from '../runtime/production-budget.mjs';
import {digest} from '../runtime/storyboard-v4/core/shared.mjs';

test('default is prepare-only; paid execution requires one exact step and existing directory',()=>{
 assert.deepEqual(parseComparisonArgs([]),{mode:'prepare',directory:null,step:null,reviewFile:null});
 assert.throws(()=>parseComparisonArgs(['--live']),/不支持/);
 assert.throws(()=>parseComparisonArgs(['--live-step','upstream']),/directory/);
 assert.throws(()=>parseComparisonArgs(['--directory','x','--live-step','upstream','--prepare-only']),/互斥/);
 assert.equal(parseComparisonArgs(['--directory','x','--live-step','3007-ep1']).step,'3007-ep1');
 assert.throws(()=>parseComparisonArgs(['--directory','x','--live-step','all']),/动作/);
});
test('unknown usage and surviving dispatch stop the whole comparison',()=>{
 assert.throws(()=>assertNoUnknownUsage({summary:{unknownAttempts:1,inFlight:0}}),/未知/);
 assert.throws(()=>assertNoUnknownUsage({summary:{unknownAttempts:0,inFlight:1}}),/在途/);
 assertNoUnknownUsage({summary:{unknownAttempts:0,inFlight:0}});
});
test('source replay is an explicit non-live mode and cannot be combined with a paid step',()=>{
 assert.deepEqual(parseComparisonArgs(['--directory','existing','--replay-upstream']),{mode:'replay',directory:'existing',step:'upstream',reviewFile:null});
 assert.throws(()=>parseComparisonArgs(['--replay-upstream']),/directory/);
 assert.throws(()=>parseComparisonArgs(['--directory','existing','--replay-upstream','--live-step','upstream']),/互斥/);
});
test('known usage alone cannot close recovery while a native operation remains unresolved',()=>{
 const ledger={summary:{unknownAttempts:0,inFlight:0}};
 assert.equal(canCloseRecoveredStep({ledger,workflow:{activeAction:null},runs:[{operations:[{status:'unknown'}]}]}),false);
 assert.equal(canCloseRecoveredStep({ledger,workflow:{activeAction:null},runs:[{operations:[{status:'completed'}]}]}),true);
});
test('one campaign cannot silently create another ledger by choosing a new preparation directory',()=>{
 assert.equal(assertCampaignBinding('/same','/same'),'/same');
 assert.equal(assertCampaignBinding('/same',null),'/same');
 assert.throws(()=>assertCampaignBinding('/original','/fresh-budget'),/同一/);
});
test('isolated Prisma loading disables generated env-file discovery without changing files',()=>{
 const source='const config={"relativeEnvPaths":{"rootEnvPath":null,"schemaEnvPath":"../../../.env"},"other":1};';
 assert.equal(suppressGeneratedPrismaEnv(source),'const config={"relativeEnvPaths":{"rootEnvPath":null,"schemaEnvPath":null},"other":1};');
 assert.throws(()=>suppressGeneratedPrismaEnv('unknown generated shape'),/Prisma/);
});
const complete=fingerprint=>({complete:true,fingerprint,runId:fingerprint});
const runs={'3007':complete('old1'),'3008':complete('new1')};
test('EP2 requires both complete EP1 outputs and matching independent review, not just new workflow approval',()=>{
 assertEpisodeGate(1,{},null);
 assert.throws(()=>assertEpisodeGate(2,{'3008':runs['3008']},null),/两侧/);
 assert.throws(()=>assertEpisodeGate(2,runs,null),/复核/);
 const review={schema:'THREE_STAGE_QUALITY_REVIEW_V1',episodeNumber:1,reviewer:'agent-review',note:'逐镜核对来源、表演、特写、幻想和六栏；主要问题已解决。',authorReviewed:true,assemblyReviewed:true,majorIssuesResolved:true,fingerprints:{'3007':'old1','3008':'new1'}};
 assertEpisodeGate(2,runs,review);
 assert.throws(()=>assertEpisodeGate(2,{'3007':complete('changed'),'3008':runs['3008']},review),/版本/);
 assert.throws(()=>assertReview({...review,note:''},runs),/复核/);
});
test('requested single action cannot drift into a different episode or upstream generation',()=>{
 assert.equal(chooseComparisonAction('upstream',{kind:'STAGE1'}).kind,'STAGE1');
 assert.throws(()=>chooseComparisonAction('upstream',{kind:'STORYBOARD_CREATE',episodeNumber:1}),/不匹配/);
 assert.throws(()=>chooseComparisonAction('3008-ep1',{kind:'STORYBOARD_CREATE',episodeNumber:2}),/不匹配/);
 assert.equal(chooseComparisonAction('3008-ep1',{kind:'WAIT_DIRECTION_CONFIRM'}).kind,'WAIT_DIRECTION_CONFIRM');
 const cost={kind:'WAIT_COST_CONFIRM',proposedAction:{kind:'STAGE1'}};
 assert.equal(chooseComparisonAction('upstream',cost).kind,'WAIT_COST_CONFIRM');
 assert.equal(chooseComparisonAction('upstream',cost,{costAcknowledged:true}).kind,'STAGE1');
 assert.throws(()=>chooseComparisonAction('3008-ep1',cost,{costAcknowledged:true}),/不匹配/);
});
test('shared creative settings are exact, not inferred from model defaults',()=>{
 const common={model:'gpt-6.1-sol',reasoning:'medium',maxUnitSeconds:30,maxUnits:null,fantasyMode:'recommended',visualStyle:{style:'3D国漫',aspectRatio:'16:9'}};
 assertSharedSettings(common,common);
 assert.throws(()=>assertSharedSettings({...common,model:'gpt-6-sol'},common),/model/);
 assert.throws(()=>assertSharedSettings({...common,reasoning:'high'},common),/reasoning/);
 assert.throws(()=>assertSharedSettings({...common,maxUnitSeconds:25},common),/maxUnitSeconds/);
});
test('input size and exact duplication report locatable JSON fields without claiming token savings',()=>{
 const text='这是一段至少二十四个字符的原文证据，用来定位发送内容中的重复。';
 const report=inspectPayload({source:{text},context:{quote:text},empty:''});
 assert.equal(report.unit,'UTF16_CHARS_NOT_TOKENS');
 assert.deepEqual(report.exactDuplicateStrings[0].paths,['$.source.text','$.context.quote']);
 assert.equal(report.exactDuplicateStrings[0].hash,hash(text));
 assert.ok(report.fields.some(row=>row.path==='$.source'&&row.serializedChars>text.length));
});
test('raw differences retain hashes and line ranges; blank-line-only is not content equality',()=>{
 const report=sourceDifference('甲\n\n乙\n','甲\n乙\n');
 assert.equal(report.exactEqual,false);assert.equal(report.nonBlankLinesEqual,true);
 assert.equal(report.originalHash,hash('甲\n\n乙\n'));assert.ok(report.firstDifference.originalLine>=1);
});
test('wire accounting excludes diagnostic source copies and locates only the actual model input',()=>{
 const text='这是一段至少二十四个字符的真实原文，不是日志中的副本。';
 const input={source:{sourceRows:[{text}]},context:{quote:text}};
 const prompt=`规则\n\n【生效设置与本次完整资料】\n${JSON.stringify(input)}\n\n尾部任务`;
 const report=inspectWireRequest({prompt,instructions:'真实系统规则',schema:{type:'object'},source:{notSent:'x'.repeat(5000)}});
 assert.equal(report.parts.prompt.chars,prompt.length);
 assert.equal(report.actualInput.serializedHash,hash(JSON.stringify(input)));
 assert.deepEqual(report.actualInput.exactDuplicateStrings[0].paths,['$.source.sourceRows[0].text','$.context.quote']);
 assert.equal(report.parts.source,undefined);
});

function upstreamRecord(attemptId='native-one'){
 const request={at:'2026-10-01T00:00:00.000Z',actionId:'action-one',payload:{projectId:'modern',stage:'F1',provider:'CLI',model:'model',reasoning:'medium',sentPrompt:'只读测试原文'}};
 return {id:'upstream-one',request,response:{status:'RESPONDED',usage:{totalTokens:27},ledgerAttemptIds:[attemptId],finishedAt:'2026-10-01T00:00:02.000Z',durationMs:2000,data:{usage:{totalTokens:99999}},rawOutput:'{"usage":{"totalTokens":99999}}'}};
}
function recoveryLedger(){return {id:'shared',attempts:[{id:'native-one',projectId:'modern',stage:'F1',provider:'CLI',model:'model',runId:null,status:'UNKNOWN',totalTokens:null,startedAt:'2026-10-01T00:00:01.000Z'}]};}
const recoveryScope={projectId:'modern',actionIds:['action-one']};
test('upstream legacy native summary can uniquely reconcile an unknown attempt, preserving history and idempotence',async t=>{
 assert.equal(typeof support.planUpstreamUsageRecovery,'function');
 const record=upstreamRecord(),input={records:[record],ledger:recoveryLedger(),...recoveryScope};
 const plan=support.planUpstreamUsageRecovery(input);
 assert.deepEqual(plan.skipped,[]);assert.equal(plan.entries.length,1);assert.equal(plan.entries[0].totalTokens,27);
 const directory=await mkdtemp(path.join(tmpdir(),'compare-recovery-test-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const store=createProductionBudgetStore(directory);await store.create('shared',{projectIds:['modern'],maxCalls:2,maxTokens:100});
 await store.reserve('shared',{attemptId:'native-one',projectId:'modern',stage:'F1',provider:'CLI',model:'model'});
 await store.settle('shared','native-one',{outcome:'UNKNOWN'});
 for(let pass=0;pass<2;pass++)for(const entry of plan.entries)await store.reconcile('shared',entry.attemptId,entry);
 const actual=await store.read('shared');assert.equal(actual.summary.knownTokens,27);assert.equal(actual.reconciliations.length,1);
 assert.equal(actual.attempts[0].status,'UNKNOWN');assert.equal(actual.attempts[0].totalTokens,null);
});
test('upstream recovery never reads model-body usage and never divides one receipt across multiple attempts',()=>{
 assert.equal(typeof support.planUpstreamUsageRecovery,'function');
 for(const mutate of [r=>{delete r.response.usage;},r=>{r.response.ledgerAttemptIds=['native-one','native-two'];},r=>{r.request.payload.projectId='foreign';},r=>{r.request.payload.model='other';},r=>{r.request.actionId='unknown';},r=>{r.response.finishedAt='2026-09-30T00:00:00.000Z';}]){
  const record=upstreamRecord();mutate(record);
  const plan=support.planUpstreamUsageRecovery({records:[record],ledger:recoveryLedger(),...recoveryScope});
  assert.equal(plan.entries.length,0);assert.equal(plan.skipped.length,1);
 }
});
test('new upstream receipts bind a native summary to the exact saved request and reject conflicting records',()=>{
 assert.equal(typeof support.upstreamRequestFingerprint,'function');
 const record=upstreamRecord();record.request.requestFingerprint=support.upstreamRequestFingerprint(record.id,record.request);
 Object.assign(record.response,{schema:'THREE_STAGE_UPSTREAM_RESPONSE_V1',budgetId:'shared',requestFingerprint:record.request.requestFingerprint,usageProvenance:'ROLE_RUNNER_NATIVE_SUMMARY_V1',nativeUsage:{schema:'CODEX_TURN_COMPLETED_USAGE_V1',eventHash:hash('native event'),usage:{input_tokens:20,output_tokens:7}}});
 assert.equal(support.planUpstreamUsageRecovery({records:[record],ledger:recoveryLedger(),...recoveryScope}).entries.length,1);
 const changed=structuredClone(record);changed.request.payload.sentPrompt='被替换的原文';
 assert.equal(support.planUpstreamUsageRecovery({records:[changed],ledger:recoveryLedger(),...recoveryScope}).entries.length,0);
 const conflict=structuredClone(record);conflict.response.usage.totalTokens=28;
 assert.throws(()=>support.planUpstreamUsageRecovery({records:[record,conflict],ledger:recoveryLedger(),...recoveryScope}),{code:'COMPARE_USAGE_CONFLICT'});
 const known=recoveryLedger();known.attempts[0].totalTokens=28;
 assert.throws(()=>support.planUpstreamUsageRecovery({records:[record],ledger:known,...recoveryScope}),{code:'COMPARE_USAGE_CONFLICT'});
 const other=upstreamRecord();other.id='upstream-other';
 assert.throws(()=>support.planUpstreamUsageRecovery({records:[upstreamRecord(),other],ledger:recoveryLedger(),...recoveryScope}),{code:'COMPARE_USAGE_CONFLICT'});
});
test('captured upstream evidence is only a validated native completion event, with no reasoning/body fallback',()=>{
 assert.equal(typeof support.captureUpstreamNativeUsage,'function');
 const event={type:'turn.completed',usage:{input_tokens:20,cached_input_tokens:4,output_tokens:7}};
 const record=support.captureUpstreamNativeUsage({stdout:JSON.stringify({type:'item.completed',text:'private reasoning'})+'\n'+JSON.stringify(event),data:{usage:{totalTokens:99999}}});
 assert.equal(record.usage.totalTokens,27);assert.equal(record.nativeUsage.eventHash,hash(event));
 assert.equal(JSON.stringify(record).includes('private reasoning'),false);
 assert.deepEqual(support.captureUpstreamNativeUsage({data:{usage:{totalTokens:27}},rawOutput:JSON.stringify(event)}),{usage:{totalTokens:null},nativeUsage:null});
 assert.equal(support.captureUpstreamNativeUsage({stdout:JSON.stringify(event)+'\n'+JSON.stringify({...event,usage:{input_tokens:1,output_tokens:1}})}).nativeUsage,null);
});
test('storyboard recovery binds native receipt to its stored operation fingerprint and never trusts body usage',()=>{
 assert.equal(typeof support.storyboardUsageRecoveryEntry,'function');
 const request={stage:'author',prompt:'原请求',instructions:'原规则',inputHash:digest({original:true}),settings:{model:'model'}};
 Object.assign(request,{promptHash:digest(request.prompt),instructionHash:digest(request.instructions)});
 const attempt={id:'native-one',projectId:'modern',stage:'stage3:author',provider:'CLI',model:'model',runId:'run-one',totalTokens:null};
 const run={id:'run-one',web:{binding:{projectId:'modern'}},operations:[{attemptId:'native-one',stage:'author',fingerprint:digest([request.promptHash,request.instructionHash,request.inputHash])}]};
 const receipt={state:'FINAL',requestOutcome:'RESPONDED',usage:{inputTokens:20,outputTokens:7,totalTokens:27}};
 assert.equal(support.storyboardUsageRecoveryEntry({attempt,request,receipt,run})?.totalTokens,27);
 assert.equal(support.storyboardUsageRecoveryEntry({attempt,request:{...request,prompt:'替换'},receipt,run}),null);
 assert.equal(support.storyboardUsageRecoveryEntry({attempt,request,receipt,run:{...run,operations:[]}}),null);
 assert.equal(support.storyboardUsageRecoveryEntry({attempt,request,receipt:{...receipt,usage:null,data:{usage:{totalTokens:27}}},run}),null);
 assert.equal(support.storyboardUsageRecoveryEntry({attempt,request,receipt:{...receipt,usage:{inputTokens:20,outputTokens:7,totalTokens:28}},run}),null);
});
test('modern mechanical completion cannot bypass unresolved chain continuity; fixed legacy has no new requirement',()=>{
 assert.equal(typeof support.isComparisonRunComplete,'function');
 const run={status:'text_ready_for_review',assembly:{text:'已整编',validation:{errors:[]}},production:{blocking:false,pendingRepair:null}};
 assert.equal(support.isComparisonRunComplete(run,{chainComplete:false}),false);
 assert.equal(support.isComparisonRunComplete(run,{chainComplete:true}),true);
 const legacy={...run};delete legacy.production;
 assert.equal(support.isComparisonRunComplete(legacy),true);
});
