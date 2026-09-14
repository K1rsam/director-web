/** Pure saved-response replay: no database, network, or model calls. */
import assert from 'node:assert/strict';
import { planP1ReviewBatches, validateP1ReviewPlan, type P1ReviewRequest } from '../lib/fidelity-p1-review';
import { runFoundationDeliveryCall, type DeliveryAttempt } from '../lib/foundation-delivery-call';
import type { FoundationCallContext, FoundationStageRunner } from '../lib/project-foundation';

async function main() {
 const source='第1集\n场1-1 日 内 大厅\n甲：我是小甲。\n';
 const blocks=planP1ReviewBatches(source)[0];
 const request:P1ReviewRequest={reviewMode:'FULL_STRUCTURE_V1',sourceVersion:'offline-source',sourceLength:source.length,batch:{firstBlock:blocks[0].id,lastBlock:blocks.at(-1)!.id,index:1,total:1},sections:blocks.map(b=>({key:b.id,start:b.start,end:b.end,text:b.text})),issues:[],baseline:[]};
 const raw={sourceVersion:request.sourceVersion,reviewed:{firstBlock:request.batch.firstBlock,lastBlock:request.batch.lastBlock},assignments:[],unresolved:[],aliases:[{alias:'小甲',canonicalCandidate:'甲',firstBlock:blocks[2].id,lastBlock:blocks[2].id,note:'称呼候选'},{alias:'缺失名字',canonicalCandidate:'甲',firstBlock:blocks[2].id,lastBlock:blocks[2].id,note:'不可采用'}]};
 const context:FoundationCallContext={provider:'CLI',role:{code:'F1',skill:'',systemPrompt:'offline',model:'offline-model',reasoningEffort:'low'},sessionMode:'ephemeral',runId:'offline-run',batchToken:'offline-batch',sourceVersion:'offline-source',inputVersion:'offline-input',chunkIndex:1,scope:[1]};
 let calls=0;
 const runner:FoundationStageRunner=async()=>{calls++;throw new Error('unexpected provider call');};
 const saved=(data:unknown):DeliveryAttempt=>({sequence:1,kind:'INITIAL',scope:[1],systemPrompt:'offline',taskPrompt:'offline',provider:'CLI',model:'offline-model',reasoningEffort:'low',startedAt:new Date(0).toISOString(),status:'FAILED',requestOutcome:'RESPONDED',providerCallCount:1,response:{rawOutput:JSON.stringify(data)}});
 const evidence=saved(raw),before=structuredClone(evidence);
 const replay=await runFoundationDeliveryCall({stage:'F1',prompt:'offline',context,runner,resumeFrom:evidence,maxRepairAttempts:0,validate:value=>{validateP1ReviewPlan(value,request);return value;},beforeRequest:async()=>assert.fail('replay cannot reserve paid work'),onAttempt:async()=>assert.fail('replay cannot append paid attempt')});
 assert.deepEqual(replay.output,raw,'full raw response remains available for the checkpoint validator');
 assert.deepEqual(evidence,before,'saved paid evidence is never rewritten');
 assert.deepEqual(replay.attempts,[]);
 const proposal=validateP1ReviewPlan(replay.output,request);
 assert.equal(proposal.aliases.length,1);assert.equal(proposal.candidateWarnings!.length,1);
 for(const change of [{sourceVersion:'stale'}, {reviewed:{firstBlock:'B999999',lastBlock:request.batch.lastBlock}}, {assignments:[{firstBlock:'B999999',lastBlock:'B999999',kind:'body',note:'forged'}]}, {replacementText:'rewrite'}]) {
  await assert.rejects(()=>runFoundationDeliveryCall({stage:'F1',prompt:'offline',context,runner,resumeFrom:saved({...raw,...change}),maxRepairAttempts:0,validate:value=>validateP1ReviewPlan(value,request)}));
 }
 assert.equal(calls,0,'neither valid alias isolation nor core rejection calls a provider');
 console.log('PASS P1 paid raw replay: valid structure retained, invalid alias isolated, core errors rejected, zero provider calls');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
