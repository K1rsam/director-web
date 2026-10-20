import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Dynamic loading keeps the initial regression failure about the missing guard explicit.
const load=()=>import('./production-budget.mjs');
async function fixture(t,limits={maxCalls:2,maxTokens:100}) {
 const directory=await mkdtemp(path.join(tmpdir(),'director-budget-'));
 t.after(()=>rm(directory,{recursive:true,force:true}));
 const module=await load(), ledger=module.createProductionBudgetStore(directory);
 await ledger.create('shared',{projectIds:['a','b'],...limits});
 return {...module,ledger,directory};
}
test('an explicit CAS limit revision keeps the original ledger and all unknown receipts',async t=>{
 const {ledger}=await fixture(t),consent=await unknownConsent(ledger),before=await ledger.read('shared');
 assert.equal(typeof ledger.reviseLimits,'function','缺少留存授权和旧停止线的预算修订');
 const command={projectId:'a',actorId:'u',costAcknowledged:true,expectedLimits:{maxCalls:2,maxTokens:100},maxCalls:800,maxTokens:60000000,note:'仅本轮完整80集测试授权'};
 await ledger.reviseLimits('shared',command);
 const after=await ledger.read('shared');
 assert.equal(after.id,before.id);assert.deepEqual(after.attempts,before.attempts);assert.deepEqual(after.summary,before.summary);
 assert.deepEqual(after.limitRevisions[0].before,command.expectedLimits);
 assert.deepEqual(after.limitRevisions[0].after,{maxCalls:800,maxTokens:60000000});
 assert.equal(after.limitRevisions[0].actorId,'u');assert.equal(after.limitRevisions[0].projectId,'a');
 await assert.rejects(ledger.reserve('shared',{projectId:'a',stage:'finish',provider:'CLI'}),{code:'PRODUCTION_USAGE_UNKNOWN'});
 await assert.rejects(ledger.reviseLimits('shared',command),{code:'PRODUCTION_LIMITS_STALE'});
 assert.equal((await ledger.read('shared')).limitRevisions.length,1);
 assert.equal(consent.acceptUnknownUsage,true);
});
test('limit revision requires consent, current limits and project scope and never unpauses',async t=>{
 const {ledger}=await fixture(t);assert.equal(typeof ledger.reviseLimits,'function');
 const command={projectId:'a',actorId:'u',costAcknowledged:true,expectedLimits:{maxCalls:2,maxTokens:100},maxCalls:8,maxTokens:1000,note:'明确测试授权'};
 for(const patch of [{costAcknowledged:false},{actorId:''},{note:''},{maxTokens:Infinity},{maxCalls:-1}])await assert.rejects(ledger.reviseLimits('shared',{...command,...patch}),{code:'PRODUCTION_LIMITS_CONSENT'});
 await assert.rejects(ledger.reviseLimits('shared',{...command,projectId:'foreign'}),{code:'PRODUCTION_BUDGET_SCOPE'});
 await ledger.pause('shared');await ledger.reviseLimits('shared',command);
 assert.equal((await ledger.read('shared')).paused,true);
 await assert.rejects(ledger.reserve('shared',{projectId:'a',stage:'finish',provider:'CLI'}),{code:'PRODUCTION_BUDGET_PAUSED'});
});
test('one persisted budget covers upstream and both variants, no call after limit',async t=>{
 const {ledger,directory,withProductionBudget}=await fixture(t);let calls=0;
 const invoke=(projectId)=>withProductionBudget({directory,id:'shared',projectId,stage:'test',provider:'CLI'},async()=>{calls++;return {usage:{inputTokens:10,outputTokens:5,totalTokens:15}};});
 await invoke('a');await invoke('b');await assert.rejects(invoke('a'),{code:'PRODUCTION_BUDGET_LIMIT',requestOutcome:'NOT_SENT'});
 assert.equal(calls,2);assert.equal((await ledger.read('shared')).summary.knownTokens,30);
});
test('unknown usage is retained and blocks new dispatch without inventing zero',async t=>{
 const {ledger,directory,withProductionBudget}=await fixture(t);
 const context={directory,id:'shared',projectId:'a',stage:'author',provider:'CLI'};
 await withProductionBudget(context,async()=>({raw:'saved draft'}));
 const row=await ledger.read('shared');assert.equal(row.attempts[0].totalTokens,null);assert.equal(row.summary.unknownAttempts,1);
 await assert.rejects(withProductionBudget(context,async()=>assert.fail('must not dispatch')),{code:'PRODUCTION_USAGE_UNKNOWN'});
});
test('concurrent reservations cannot overspend call limit',async t=>{
 const {ledger}=await fixture(t,{maxCalls:1,maxTokens:100});
 const results=await Promise.allSettled(['first','second'].map(attemptId=>ledger.reserve('shared',{attemptId,projectId:'a',stage:'plan',provider:'CLI'})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await ledger.read('shared')).attempts.length,1);
});
test('known token stop counts in-flight completions and does not erase overage',async t=>{
 const {ledger}=await fixture(t,{maxCalls:5,maxTokens:100});
 for(const attemptId of ['one','two'])await ledger.reserve('shared',{attemptId,projectId:'a',stage:'author',provider:'CLI'});
 await ledger.settle('shared','one',{usage:{totalTokens:80},outcome:'RESPONDED'});
 await ledger.settle('shared','two',{usage:{totalTokens:70},outcome:'RESPONDED'});
 assert.equal((await ledger.read('shared')).summary.knownTokens,150);
 await assert.rejects(ledger.reserve('shared',{attemptId:'three',projectId:'b',stage:'finish',provider:'CLI'}),{code:'PRODUCTION_BUDGET_LIMIT'});
});
test('settlement is idempotent and conflicting receipts cannot overwrite history',async t=>{
 const {ledger}=await fixture(t);await ledger.reserve('shared',{attemptId:'one',projectId:'a',stage:'plan',provider:'CLI'});
 await ledger.settle('shared','one',{usage:{totalTokens:22},outcome:'RESPONDED'});
 await ledger.settle('shared','one',{usage:{totalTokens:22},outcome:'RESPONDED'});
 await assert.rejects(ledger.settle('shared','one',{usage:{totalTokens:0},outcome:'RESPONDED'}),{code:'PRODUCTION_RECEIPT_CONFLICT'});
 assert.equal((await ledger.read('shared')).summary.knownTokens,22);
});
test('not-sent failure is zero usage; unknown failure is not; project scope is enforced',async t=>{
 const {ledger,directory,withProductionBudget}=await fixture(t,{maxCalls:5,maxTokens:100});
 const context={directory,id:'shared',projectId:'a',stage:'plan',provider:'CLI'};
 await assert.rejects(withProductionBudget(context,async()=>{throw Object.assign(new Error('local'),{requestOutcome:'NOT_SENT'});}));
 assert.equal((await ledger.read('shared')).summary.unknownAttempts,0);
 await assert.rejects(withProductionBudget({...context,projectId:'foreign'},async()=>assert.fail()),{code:'PRODUCTION_BUDGET_SCOPE'});
 await assert.rejects(withProductionBudget(context,async()=>{throw new Error('lost response');}));
 assert.equal((await ledger.read('shared')).summary.unknownAttempts,1);
});
test('CLI receipt parsing never trusts API model text as usage',async()=>{
 const {productionUsage}=await load();
 const stdout=JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:4}});
 assert.equal(productionUsage('CLI',{stdout}).totalTokens,24);
 assert.equal(productionUsage('API',{stdout}).totalTokens,null);
 assert.equal(productionUsage('API',{usage:{inputTokens:20,outputTokens:4,totalTokens:24}}).totalTokens,24);
 assert.equal(productionUsage('CLI',{stdout:stdout+'\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}})}).totalTokens,null);
});
test('verified recovered usage appends reconciliation without overwriting unknown history',async t=>{
 const {ledger}=await fixture(t,{maxCalls:3,maxTokens:100});
 await ledger.reserve('shared',{attemptId:'lost',projectId:'a',stage:'author',provider:'CLI'});
 await ledger.settle('shared','lost',{outcome:'UNKNOWN'});
 await assert.rejects(ledger.reserve('shared',{attemptId:'next',projectId:'a',stage:'finish',provider:'CLI'}),{code:'PRODUCTION_USAGE_UNKNOWN'});
 await ledger.reconcile('shared','lost',{totalTokens:25,evidenceHash:'verified-native-receipt'});
 const recovered=await ledger.read('shared');assert.equal(recovered.attempts[0].totalTokens,null);assert.equal(recovered.attempts[0].status,'UNKNOWN');
 assert.equal(recovered.summary.knownTokens,25);assert.equal(recovered.summary.unknownAttempts,0);
 await ledger.reconcile('shared','lost',{totalTokens:25,evidenceHash:'verified-native-receipt'});
 assert.equal((await ledger.read('shared')).reconciliations.length,1);
 await assert.rejects(ledger.reconcile('shared','lost',{totalTokens:1,evidenceHash:'different'}),{code:'PRODUCTION_RECEIPT_CONFLICT'});
 await ledger.reserve('shared',{attemptId:'next',projectId:'a',stage:'finish',provider:'CLI'});
});
test('malformed native components cannot make contradictory totals look known',async()=>{
 const {productionUsage}=await load();
 for(const usage of [
  {totalTokens:0,inputTokens:12},
  {totalTokens:15,inputTokens:-5,outputTokens:20},
  {totalTokens:15,inputTokens:'10',outputTokens:5},
  {total_tokens:15,prompt_tokens:10,completion_tokens:5.5},
 ])assert.equal(productionUsage('API',{usage}).totalTokens,null,JSON.stringify(usage));
 assert.equal(productionUsage('API',{usage:{totalTokens:15}}).totalTokens,15,'total-only native receipts stay supported');
 assert.equal(productionUsage('API',{usage:{totalTokens:15,inputTokens:10}}).totalTokens,15,'valid partial components do not invalidate a reliable total');
 assert.equal(productionUsage('API',{usage:{total_tokens:15,prompt_tokens:10,completion_tokens:5}}).totalTokens,15);
});
test('a malformed native receipt blocks further spend instead of settling false zero',async t=>{
 const {ledger,directory,withProductionBudget}=await fixture(t);
 const context={directory,id:'shared',projectId:'a',stage:'author',provider:'API'};
 const result=await withProductionBudget(context,async()=>({data:{text:'已保存结果'},usage:{totalTokens:0,inputTokens:12}}));
 assert.equal(result.data.text,'已保存结果');assert.equal((await ledger.read('shared')).summary.unknownAttempts,1);
 await assert.rejects(withProductionBudget(context,async()=>assert.fail('No automatic redispatch')),{code:'PRODUCTION_USAGE_UNKNOWN'});
});
test('an explicit unknown total is not reconstructed or replaced by another receipt',async()=>{
 const {productionUsage}=await load();
 for(const usage of [
  {inputTokens:7,outputTokens:3,totalTokens:null},
  {prompt_tokens:7,completion_tokens:3,total_tokens:null},
  {inputTokens:7,outputTokens:3,totalTokens:null,total_tokens:10},
 ]){
  assert.equal(productionUsage('API',{usage}).totalTokens,null);
  const stdout=JSON.stringify({type:'turn.completed',usage:{input_tokens:7,output_tokens:3}});
  assert.equal(productionUsage('CLI',{usage,stdout}).totalTokens,null);
 }
 assert.equal(productionUsage('API',{usage:{inputTokens:7,outputTokens:3}}).totalTokens,10,'a genuinely absent total can still derive from reliable native components');
});

const attemptHash=attempt=>createHash('sha256').update(JSON.stringify(attempt)).digest('hex');
async function unknownConsent(ledger,attemptId='lost',projectId='a'){
 await ledger.reserve('shared',{attemptId,projectId,runId:`run-${attemptId}`,stage:'author',provider:'CLI'});
 await ledger.settle('shared',attemptId,{outcome:'UNKNOWN',errorCode:'CLI_FAILED'});
 const attempt=(await ledger.read('shared')).attempts.find(a=>a.id===attemptId);
 return {projectId,runId:attempt.runId,actorId:'verified-member',acceptUnknownUsage:true,expectedAttemptHash:attemptHash(attempt),evidenceHash:'a'.repeat(64),note:'用户明确接受这一条未知费用风险；不改变原始用量。'};
}
test('explicit single-attempt risk consent permits continuation but preserves unknown usage and original stop lines',async t=>{
 const {ledger}=await fixture(t,{maxCalls:3,maxTokens:100});
 const consent=await unknownConsent(ledger),before=await ledger.read('shared');
 await ledger.acknowledgeUnknown('shared','lost',consent);
 const after=await ledger.read('shared');
 assert.deepEqual(after.attempts,before.attempts,'not a zero-usage receipt or a reconciliation');
 assert.equal(after.summary.unknownAttempts,1);assert.equal(after.summary.acknowledgedUnknownAttempts,1);assert.equal(after.summary.blockingUnknownAttempts,0);assert.equal(after.summary.complete,false);
 assert.equal(after.summary.knownTokens,0);assert.equal(after.maxCalls,3);assert.equal(after.maxTokens,100);assert.equal(after.reconciliations,undefined);
 await ledger.reserve('shared',{attemptId:'next',projectId:'a',stage:'finish',provider:'CLI'});
});
test('acknowledgement is idempotent and bound to exact scope, immutable attempt and consent evidence',async t=>{
 const {ledger}=await fixture(t,{maxCalls:8,maxTokens:100}),consent=await unknownConsent(ledger);
 await ledger.acknowledgeUnknown('shared','lost',consent);await ledger.acknowledgeUnknown('shared','lost',consent);
 assert.equal((await ledger.read('shared')).unknownUsageAcknowledgements.length,1);
 await assert.rejects(ledger.acknowledgeUnknown('shared','lost',{...consent,evidenceHash:'b'.repeat(64)}),{code:'PRODUCTION_ACK_CONFLICT'});
 await assert.rejects(ledger.acknowledgeUnknown('shared','lost',{...consent,actorId:'different-member'}),{code:'PRODUCTION_ACK_CONFLICT'});
});
test('missing consent, stale attempt, foreign project or run cannot acknowledge unknown cost',async t=>{
 const {ledger}=await fixture(t),consent=await unknownConsent(ledger);
 for(const patch of [{acceptUnknownUsage:false},{actorId:''},{note:''},{evidenceHash:'not-a-hash'},{expectedAttemptHash:'not-a-hash'}])await assert.rejects(ledger.acknowledgeUnknown('shared','lost',{...consent,...patch}),{code:'PRODUCTION_UNKNOWN_CONSENT'});
 await assert.rejects(ledger.acknowledgeUnknown('shared','lost',{...consent,expectedAttemptHash:'b'.repeat(64)}),{code:'PRODUCTION_ACK_STALE'});
 await assert.rejects(ledger.acknowledgeUnknown('shared','lost',{...consent,projectId:'b'}),{code:'PRODUCTION_BUDGET_SCOPE'});
 await assert.rejects(ledger.acknowledgeUnknown('shared','lost',{...consent,runId:'other-run'}),{code:'PRODUCTION_BUDGET_SCOPE'});
 assert.equal((await ledger.read('shared')).summary.blockingUnknownAttempts,1);
});
test('approval of one unknown never approves a subsequent unknown or an in-flight attempt',async t=>{
 const {ledger}=await fixture(t,{maxCalls:8,maxTokens:100}),consent=await unknownConsent(ledger);
 await ledger.acknowledgeUnknown('shared','lost',consent);
 await ledger.reserve('shared',{attemptId:'next',projectId:'a',runId:'run-next',stage:'finish',provider:'CLI'});
 const active=(await ledger.read('shared')).attempts.at(-1);
 await assert.rejects(ledger.acknowledgeUnknown('shared','next',{...consent,runId:'run-next',expectedAttemptHash:attemptHash(active)}),{code:'PRODUCTION_ACK_STATE'});
 await ledger.settle('shared','next',{outcome:'UNKNOWN'});
 const view=await ledger.read('shared');assert.equal(view.summary.unknownAttempts,2);assert.equal(view.summary.acknowledgedUnknownAttempts,1);assert.equal(view.summary.blockingUnknownAttempts,1);
 await assert.rejects(ledger.reserve('shared',{attemptId:'third',projectId:'a',stage:'finish',provider:'CLI'}),{code:'PRODUCTION_USAGE_UNKNOWN'});
});
test('unknown consent cannot unpause a ledger or expand calls and known-token limits',async t=>{
 for(const limits of [{maxCalls:1,maxTokens:100},{maxCalls:4,maxTokens:0}]){
  const nested=await fixture(t,{maxCalls:4,maxTokens:100}),{ledger,directory}=nested;
  const consent=await unknownConsent(ledger);await ledger.acknowledgeUnknown('shared','lost',consent);
  const {createStore}=await import('./storyboard-v4/core/store.mjs');
  await createStore(directory).update('shared',d=>({...d,...limits}));
  await assert.rejects(ledger.reserve('shared',{attemptId:'next',projectId:'a',stage:'finish',provider:'CLI'}),{code:'PRODUCTION_BUDGET_LIMIT'});
 }
 const {ledger}=await fixture(t),consent=await unknownConsent(ledger);await ledger.pause('shared');await ledger.acknowledgeUnknown('shared','lost',consent);
 assert.equal((await ledger.read('shared')).paused,true);
 await assert.rejects(ledger.reserve('shared',{attemptId:'next',projectId:'a',stage:'finish',provider:'CLI'}),{code:'PRODUCTION_BUDGET_PAUSED'});
});
test('native reconciliation still replaces effective unknown after a risk acknowledgement without rewriting either history',async t=>{
 const {ledger}=await fixture(t),consent=await unknownConsent(ledger);
 await ledger.acknowledgeUnknown('shared','lost',consent);const before=await ledger.read('shared');
 await ledger.reconcile('shared','lost',{totalTokens:55,evidenceHash:'native-final-receipt'});
 const after=await ledger.read('shared');assert.deepEqual(after.attempts,before.attempts);assert.deepEqual(after.unknownUsageAcknowledgements,before.unknownUsageAcknowledgements);
 assert.equal(after.summary.knownTokens,55);assert.equal(after.summary.unknownAttempts,0);assert.equal(after.summary.blockingUnknownAttempts,0);assert.equal(after.summary.acknowledgedUnknownAttempts,0);assert.equal(after.summary.complete,true);
});
