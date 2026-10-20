import test from 'node:test';
import assert from 'node:assert/strict';
import {projectProductionSource,projectHistoricalCandidates,PRODUCTION_CONTEXT_VERSION} from './production-context-projection.mjs';

const candidate=(i,extra={})=>({id:`history-${i}`,subjects:['甲'],kind:i%2?'UTTERANCE':'STATE',claim:i%2?'CHARACTER_CLAIM':'SOURCE',applicability:'SUBJECT',statement:`第${i}处原文：甲说伤好了。`,evidence:{domain:'EPISODE',episode:1,start:i*20,end:i*20+18},validity:{status:'UNKNOWN'},candidateUse:'HISTORICAL_EVIDENCE_ONLY',currentApplicability:'UNKNOWN',retrieval:{mode:i%2?'SUBJECT_MENTION':'SOURCE_NEIGHBOUR',anchorFactIds:[`anchor-${i}`]},...extra});
const source=()=>({key:'e2',title:'测试',sourceRows:[{id:'s1',text:'甲：出发。',kind:'dialogue'}],contextRows:[],dialogue:[{id:'l1',rowId:'s1',speaker:'甲',quote:'出发。',kind:'dialogue',channel:'onscreen'}],entryFacts:[],assets:[],context:{retrievalFacts:{schema:'FOUNDATION_FACTS_V1',current:[],historicalEvidenceCandidates:Array.from({length:20},(_,i)=>candidate(i)),historicalEvidenceRejected:0,rules:'历史不是当下事实。'}}});
function decode(table){
 return table.rows.map(row=>Object.fromEntries([...Object.entries(table.shared),...table.columns.flatMap((key,i)=>row[i]===null?[]:[[key,row[i]]])]));
}

test('v4 history transport is exactly reversible including claims, validity, anchors and optional fields',()=>{
 const input=source().context.retrievalFacts;input.historicalEvidenceCandidates[1].contextRef='previous-line';
 const before=structuredClone(input),projected=projectHistoricalCandidates(input),table=projected.historicalEvidenceCandidates;
 assert.equal(table.format,'HISTORICAL_EVIDENCE_TABLE_V4');
 assert.deepEqual(decode(table),input.historicalEvidenceCandidates);
 assert.equal(table.shared.currentApplicability,'UNKNOWN');assert.equal(table.shared.candidateUse,'HISTORICAL_EVIDENCE_ONLY');
 assert.ok(JSON.stringify(projected).length<JSON.stringify(input).length*0.75);
 assert.deepEqual(input,before);
});

test('unsupported records and small tables retain the complete original representation',()=>{
 for(const mutate of [f=>f.extension={note:'不能丢'},f=>f.retrieval.extra='未来语义',f=>f.currentApplicability='CONFIRMED',f=>f.statement=null]){
  const input=source().context.retrievalFacts;mutate(input.historicalEvidenceCandidates[1]);assert.deepEqual(projectHistoricalCandidates(input),input);
 }
 const extended=source().context.retrievalFacts;extended.extension={rule:'未知根元数据'};assert.deepEqual(projectHistoricalCandidates(extended),extended);
 const input={historicalEvidenceCandidates:[candidate(0)]};assert.deepEqual(projectHistoricalCandidates(input),input);
});

test('frozen v4 history transport stays readable under the current v5 receiver without changing canonical source',()=>{
 const input=source(),before=structuredClone(input);
 assert.equal(PRODUCTION_CONTEXT_VERSION,'production-context-v5');
 const v2=projectProductionSource(input,'production-context-v2'),v3=projectProductionSource(input,'production-context-v3'),v4=projectProductionSource(input,'production-context-v4');
 assert.ok(Array.isArray(v2.context.retrievalFacts.historicalEvidenceCandidates));assert.ok(Array.isArray(v3.context.retrievalFacts.historicalEvidenceCandidates));
 assert.deepEqual(decode(v4.context.retrievalFacts.historicalEvidenceCandidates),v3.context.retrievalFacts.historicalEvidenceCandidates);
 for(const key of ['sourceRows','contextRows','dialogue','entryFacts','assets'])assert.deepEqual(v4[key],v3[key]);
 assert.deepEqual(input,before);
});
