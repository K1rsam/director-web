/** Offline only. Independent decoder verifies the self-contained model-visible protocol. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildSourceIndex, buildNumberedSource } from '../lib/project-foundation-contracts';
import { buildFoundationFacts, selectFoundationFacts } from '../lib/foundation-facts';
import { projectFoundationModelInput } from '../lib/foundation-model-input';
import { buildLightFoundationPrompt } from '../lib/foundation-production-prompts';
import { costFingerprint } from '../lib/foundation-delivery';
import { assertFoundationRequestBudget } from '../lib/project-foundation';
import { runFoundationDeliveryCall, type DeliveryAttempt } from '../lib/foundation-delivery-call';

const episodes = [1,2,3,4].map(number => ({number,title:`第${number}集`,content:`第${number}集\n${number}-1 客厅 日 内\n人物：张三\n`
  + '张三：他转身离开。\n'.repeat(number===2?1500:2)
  + (number===2?'2-2 门外 日 外\n'+'张三：他转身离开。\n'.repeat(1800)+'△张三受伤，右手伤口流血。\n':number===3?'张三：右手还不能动。\n':'')}));
const index=buildSourceIndex(episodes), context:any={version:'offline-context',background:[]};
const facts=selectFoundationFacts(buildFoundationFacts(index,context,null,{standard:true}),index,[3,4]);
const input={source:buildNumberedSource(index,[3,4]),scope:[3,4],facts,registry:[{key:'CH_Z',name:'张三',aliases:[]}],delivery:{mode:'GENERATE_F2'}};
const before=structuredClone(input), raw=facts.historicalEvidenceCandidates;

function expand(table:any):any[] {
  assert.equal(table.format,'HISTORICAL_EVIDENCE_TABLE_V2');
  assert.equal(table.idDerivation.format,'SHA256_JSON_V1');
  return table.rows.map((row:any[], position:number)=>{
    const value:any={...table.shared,...Object.fromEntries(table.columns.map((key:string,i:number)=>[key,
      table.dictionaries[key] ? table.dictionaries[key][row[i]] : row[i]]))};
    const evidence={...table.evidenceShared,...Object.fromEntries(table.evidenceColumns.map((key:string,i:number)=>[key,value.evidence[i]]))};
    const idAt=(at:number)=>{
      const candidate=table.rows[at], e=candidate[table.columns.indexOf('evidence')];
      const origin={...table.evidenceShared,...Object.fromEntries(table.evidenceColumns.map((key:string,i:number)=>[key,e[i]]))};
      return createHash('sha256').update(JSON.stringify([table.idDerivation.sourceVersion,table.idDerivation.sourceContextVersion,origin])).digest('hex');
    };
    const retrieval=value.retrieval===null?{mode:'SUBJECT_MENTION',anchorFactIds:[idAt(position)]}
      :{mode:value.retrieval[0],anchorFactIds:value.retrieval[1].map(idAt)};
    return {...value,id:idAt(position),evidence,retrieval};
  });
}

const wire:any=projectFoundationModelInput(input), table=wire.facts.historicalEvidenceCandidates;
const {sourceVersion:_version,sourceContextVersion:_contextVersion,...legacyFacts}=facts;
const legacy:any=projectFoundationModelInput({...input,facts:legacyFacts});
assert.equal(table.format,'HISTORICAL_EVIDENCE_TABLE_V2','Large source-derived history needs lossless wire compaction, not a larger budget');
assert.deepEqual(expand(table),raw,'Do not merge equal sentences at different positions, or lose releases/claims/anchors');
assert.deepEqual(input,before);
assert.deepEqual(wire.source,input.source);
assert.deepEqual(wire.registry,input.registry);
assert.deepEqual(projectFoundationModelInput(wire),wire,'Saved V2 wire is idempotent');
for(const stage of ['F2','Q1'] as const) {
  assert.equal(costFingerprint(stage,input),costFingerprint(stage,wire));
  assert.equal(costFingerprint(stage,legacy),costFingerprint(stage,wire),'An old full-ID request is the same paid work');
  const prompt=buildLightFoundationPrompt(stage,input);
  assertFoundationRequestBudget('offline system prompt',prompt);
  assert.deepEqual(expand(JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!).facts.historicalEvidenceCandidates),raw);
}

// Explicit validity, multiple subjects and source-neighbour edges all survive the same protocol.
const mixed=structuredClone(facts);
mixed.historicalEvidenceCandidates[0].validity={status:'EXPLICIT',start:1,end:3};
mixed.historicalEvidenceCandidates[0].subjects=['张三','李四'];
mixed.historicalEvidenceCandidates[1].retrieval={mode:'SOURCE_NEIGHBOUR',anchorFactIds:[raw[0].id,raw[2].id]};
assert.deepEqual(expand((projectFoundationModelInput({...input,facts:mixed}) as any).facts.historicalEvidenceCandidates),mixed.historicalEvidenceCandidates);
for(const mutate of [
  (v:any)=>{
    const old=v.historicalEvidenceCandidates[1].id;
    v.historicalEvidenceCandidates[1].id='not-source-derived';
    for(const row of v.historicalEvidenceCandidates) row.retrieval.anchorFactIds=row.retrieval.anchorFactIds.map((id:string)=>id===old?'not-source-derived':id);
  },
  (v:any)=>{delete v.sourceContextVersion;},
  (v:any)=>{v.sourceVersion='wrong-basis';},
  (v:any)=>{v.futureReferences={factIds:[raw[0].id]};},
]) {
  const changed:any=structuredClone(facts);mutate(changed);
  assert.equal((projectFoundationModelInput({...input,facts:changed}) as any).facts.historicalEvidenceCandidates.format,'HISTORICAL_EVIDENCE_TABLE_V1','Unproven ID derivation must retain full IDs');
}
for(const mutate of [
  (v:any)=>{v.historicalEvidenceCandidates[1].futureField={keep:'未知资料'};},
  (v:any)=>{v.historicalEvidenceCandidates[1].retrieval.anchorFactIds=['missing'];},
]) {
  const changed:any=structuredClone(facts);mutate(changed);
  assert.deepEqual((projectFoundationModelInput({...input,facts:changed}) as any).facts.historicalEvidenceCandidates,changed.historicalEvidenceCandidates);
}
async function paidReplay(){
  const output={format:'FOUNDATION_OPTIMIZATION_V2',coverage:[3,4],changes:{}};
  const saved:DeliveryAttempt={sequence:1,kind:'INITIAL',scope:[3,4],systemPrompt:'offline system prompt',taskPrompt:buildLightFoundationPrompt('Q1',legacy),
    provider:'CLI',model:'gpt-6.1-sol',reasoningEffort:'medium',startedAt:new Date(0).toISOString(),status:'SUCCEEDED',requestOutcome:'RESPONDED',providerCallCount:1,
    response:{data:output,rawOutput:JSON.stringify(output),stdout:'',stderr:'',sessionId:null}};
  const original=structuredClone(saved);let calls=0;
  const replay=await runFoundationDeliveryCall({stage:'Q1',prompt:buildLightFoundationPrompt('Q1',input),
    context:{provider:'CLI',role:{code:'Q1',skill:'',systemPrompt:saved.systemPrompt,model:'gpt-6.1-sol',reasoningEffort:'medium'},
      sessionMode:'ephemeral',runId:'offline-paid',batchToken:'offline',sourceVersion:index.version,inputVersion:'offline',chunkIndex:1,scope:[3,4]},
    resumeFrom:saved,validate:value=>{assert.deepEqual(value,output);return value;},runner:async()=>{calls++;assert.fail('Wire compaction cannot repurchase a valid response');}});
  assert.deepEqual(replay.output,output);assert.equal(calls,0);assert.deepEqual(saved,original);
  console.log(JSON.stringify({status:'PASS',historicalRows:raw.length,uniqueSentences:new Set(raw.map(row=>row.statement)).size,
    rawChars:JSON.stringify(raw).length,legacyWireChars:JSON.stringify(legacy.facts.historicalEvidenceCandidates).length,wireChars:JSON.stringify(table).length,
    promptChars:buildLightFoundationPrompt('F2',input).length,unit:'UTF16_CHARS_NOT_TOKENS',exactRoundtrip:true,paidIdentityUnchanged:true,paidReplayCalls:calls,modelCalls:0}));
}
paidReplay().catch(error=>{console.error(error);process.exitCode=1;});
