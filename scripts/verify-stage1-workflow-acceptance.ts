/** Real delivery-call adapter; deterministic offline providers only, no DB or user source. */
import assert from 'node:assert/strict';
import { FoundationContractError, type FoundationIssue } from '../lib/project-foundation-contracts';
import { runFoundationDeliveryCall as run, validateSavedDeliveryAttempt, hasSafeDeliveryFormatRepair, DeliveryCallError, type DeliveryAttempt, type DeliveryRepairPlanner } from '../lib/foundation-delivery-call';
import type { FoundationCallContext } from '../lib/project-foundation';
import type { RoleRunResult } from '../lib/role-runner';

const context: FoundationCallContext = {provider:'CLI',role:{code:'F2',skill:'',systemPrompt:'完整F2岗位规则',model:'offline',reasoningEffort:'low'},sessionMode:'ephemeral',runId:'offline',batchToken:'offline',sourceVersion:'source-1',inputVersion:'input-1',chunkIndex:1,scope:[1]};
const original={format:'ASSET_CATALOG_V2',coverage:[1],assets:[{key:'bad',name:'需纠正',sceneRefs:[{episode:1,sceneKey:'missing'}]},{key:'good',name:'原样保留',sceneRefs:[{episode:1,sceneKey:'1-2'}]}],notes:['不可改动正文\n第二行']};
const repaired={...original.assets[0],sceneRefs:[{episode:1,sceneKey:'1-1'}]};
const issues: FoundationIssue[]=[{severity:'BLOCKER',owner:'PROGRAM',coordinate:'assets.0',problem:'对象引用无有效场次',sourceRefs:[]}];
const response=(data:unknown):RoleRunResult=>({data:data as Record<string,unknown>,rawOutput:JSON.stringify(data),stdout:'原始用量',stderr:'',sessionId:null});
const patch=(paths=[{path:'assets.0',value:repaired}])=>response({format:'FIELD_REPAIR_V1',patches:paths});
const planner:DeliveryRepairPlanner=({stage,candidate,issues:diagnostics})=>{assert.equal(stage,'F2');assert.deepEqual(candidate,original);assert.deepEqual(diagnostics,issues);return {paths:['assets.0'],systemPrompt:'只修本对象，保留其身份',prompt:'INPUT_JSON:\n'+JSON.stringify({repairRequest:{fields:[{path:'assets.0',value:original.assets[0]}],validScenes:['1-1'],source:'第一场合法定位依据'}}),evidence:{sourceVersion:'source-1',scenes:['1-1'],objectKey:'bad'}};};
function validate(data:unknown) {const value=data as typeof original;if(value.assets[0]?.sceneRefs[0]?.sceneKey!=='1-1')throw new FoundationContractError('引用错误',issues);assert.deepEqual(value.assets[1],original.assets[1]);assert.deepEqual(value.notes,original.notes);assert.deepEqual(value.coverage,original.coverage);return value;}
const saved=(extra:Partial<DeliveryAttempt>={}):DeliveryAttempt=>({sequence:1,kind:'INITIAL',scope:[1],systemPrompt:context.role.systemPrompt!,taskPrompt:'原始整包任务',provider:'CLI',model:'offline',reasoningEffort:'low',startedAt:new Date(0).toISOString(),status:'FAILED',requestOutcome:'RESPONDED',providerCallCount:1,response:response(original),issues,...extra});
let checks=0;
async function check(name:string,fn:()=>Promise<void>) {await fn();checks++;console.log('PASS '+name);}
async function main() {
 const before=JSON.stringify(original);
 let successful:DeliveryAttempt;
 await check('聚合对象局部修复只买一次补丁，正确对象与原始响应保留',async()=>{
  let calls=0,budgets=0;
  const result=await run({stage:'F2',prompt:'原始整包任务',context,validate,repairPlan:planner,takeRepairBudget:async()=>{budgets++;return true;},runner:async(_stage,prompt,ctx)=>{calls++;if(calls===1)return response(original);assert.equal(ctx.role.systemPrompt,'只修本对象，保留其身份');assert.ok(!prompt.includes('原样保留'));return patch();}});
  assert.equal(calls,2);assert.equal(budgets,1);assert.deepEqual(result.output.assets[0],repaired);assert.deepEqual(result.attempts.map(a=>a.kind),['INITIAL','FORMAT_REPAIR']);
  successful=result.attempts[1];assert.equal(successful.repairBase?.mode,'LOCAL_OBJECT');assert.deepEqual(successful.repairBase?.response,response(original));assert.deepEqual(result.attempts[0].response,response(original));assert.equal(JSON.stringify(original),before);
 });
 await check('已保存局部补丁中断后本地恢复，无新请求',async()=>{
  const persisted=structuredClone(successful!);delete persisted.normalization;persisted.status='FAILED';
  const result=await run({stage:'F2',prompt:'不得调用',context,validate,resumeFrom:persisted,runner:async()=>assert.fail('No repurchase'),takeRepairBudget:async()=>assert.fail('No budget')});
  assert.deepEqual(result.output.assets[0],repaired);assert.deepEqual(result.attempts,[]);assert.deepEqual(validateSavedDeliveryAttempt(persisted,validate),result.output);
 });
 await check('历史无效已付费包仅补一次局部对象，不重发INITIAL',async()=>{
  assert.equal(hasSafeDeliveryFormatRepair(saved(),'F2'),false);assert.equal(hasSafeDeliveryFormatRepair(saved(),'F2',planner),true);
  let calls=0;const result=await run({stage:'F2',prompt:'原始包',context,validate,resumeFrom:saved(),repairPlan:planner,takeRepairBudget:async()=>true,runner:async()=>{calls++;return patch();}});assert.equal(calls,1);assert.equal(result.attempts[0].kind,'FORMAT_REPAIR');
 });
 for(const invalid of ['unrelated','full','no-progress','duplicate'] as const) await check('拒绝越权或无效局部补丁：'+invalid,async()=>{
  let calls=0;const returned=invalid==='full'?response({...original,assets:[repaired,original.assets[1]]}):invalid==='unrelated'?patch([{path:'assets.1',value:repaired}]):invalid==='duplicate'?patch([{path:'assets.0',value:repaired},{path:'assets.0',value:repaired}]):patch([{path:'assets.0',value:original.assets[0]}]);
  await assert.rejects(run({stage:'F2',prompt:'原包',context,validate,repairPlan:planner,takeRepairBudget:async()=>true,maxRepairAttempts:99,runner:async()=>++calls===1?response(original):returned}),DeliveryCallError);assert.equal(calls,2);assert.equal(JSON.stringify(original),before);
 });
 await check('拒绝whole-array或prototype路径且不消耗新请求',async()=>{
  for(const paths of [['assets'],['assets.0','assets.0.name'],['assets.0.__proto__']]) {let calls=0;const malicious:DeliveryRepairPlanner=input=>({...planner(input)!,paths});await assert.rejects(run({stage:'F2',prompt:'原包',context,validate,resumeFrom:saved(),repairPlan:malicious,takeRepairBudget:async()=>true,runner:async()=>{calls++;return patch();}}));assert.equal(calls,0);}
 });
 await check('诊断/计划证据或版本变化不得本地假恢复',async()=>{
  for(const field of ['paths','evidence','version'] as const) {const corrupted=structuredClone(successful!);if(field==='paths')corrupted.repairBase!.paths=['assets.1'];else if(field==='evidence')corrupted.repairBase!.localPlan!.evidence={source:'tampered'};else corrupted.repairBase!.sourceVersion='other';await assert.rejects(run({stage:'F2',prompt:'原包',context,validate,resumeFrom:corrupted,repairPlan:planner,takeRepairBudget:async()=>true,runner:async()=>assert.fail('No repurchase')}));}
 });
 await check('局部修复失败后不再购买第二次局部修复',async()=>{
  const failed=structuredClone(successful!);failed.response=patch([{path:'assets.0',value:original.assets[0]}]);delete failed.normalization;
  assert.equal(hasSafeDeliveryFormatRepair(failed,'F2',planner),false);await assert.rejects(run({stage:'F2',prompt:'原包',context,validate,resumeFrom:failed,repairPlan:planner,takeRepairBudget:async()=>true,runner:async()=>assert.fail('Second local repair forbidden')}));
 });
 await check('Q1局部对象路径可修，完整包无关场和说明不变',async()=>{
  const candidate={format:'FOUNDATION_OPTIMIZATION_V2',coverage:[1],changes:{assets:[original.assets[0]],scenes:[{episode:1,sceneKey:'1-2',weather:'晴'}]},notes:['完整导演说明']};
  const diagnostic:FoundationIssue[]=[{...issues[0],coordinate:'changes.assets.0'}];
  const q1plan:DeliveryRepairPlanner=()=>({paths:['changes.assets.0'],systemPrompt:'只修Q1目标对象',prompt:'局部对象+合法场1-1',evidence:{sceneKey:'1-1'}});
  let calls=0;const result=await run({stage:'Q1',prompt:'整包Q1',context:{...context,role:{...context.role,code:'Q1'}},repairPlan:q1plan,takeRepairBudget:async()=>true,validate(data){const value=data as typeof candidate;if(value.changes.assets[0].sceneRefs[0].sceneKey!=='1-1')throw new FoundationContractError('目标引用错误',diagnostic);return value;},runner:async()=>++calls===1?response(candidate):patch([{path:'changes.assets.0',value:repaired}])});
  assert.equal(calls,2);assert.deepEqual(result.output.changes.scenes,candidate.changes.scenes);assert.deepEqual(result.output.notes,candidate.notes);assert.deepEqual(result.output.coverage,candidate.coverage);
 });
 await check('UNKNOWN与预算拒绝不发局部请求，不制造创作等待',async()=>{
  for(const unknown of [false,true]){let calls=0;await assert.rejects(run({stage:'F2',prompt:'原包',context,validate,resumeFrom:saved({requestOutcome:unknown?'UNKNOWN':'RESPONDED'}),repairPlan:planner,takeRepairBudget:async()=>false,runner:async()=>{calls++;return patch();}}),DeliveryCallError);assert.equal(calls,0);}
 });
 console.log(`PASS ${checks} local-object repair acceptance checks (offline adapter; not full controller or real AI acceptance)`);
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
