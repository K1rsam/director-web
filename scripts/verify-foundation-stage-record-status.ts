/** Read-only execution status projection; no database or provider calls. */
import assert from 'node:assert/strict';
import { buildFoundationStageViews } from '../lib/studio';
type State=Parameters<typeof buildFoundationStageViews>[0];
const run=(stageCode:string,status='SUCCEEDED',inputSummary=JSON.stringify({sourceVersion:'source',inputVersion:'input'}))=>({id:stageCode,stageCode,status,inputSummary,createdAt:new Date(0),log:null,error:null,model:'offline',durationMs:42});
const state={planningReady:false,assetsReady:false,ready:false,reviewReady:false,dataReady:false,sourceVersion:'source',inputVersion:'input',candidates:{f1:null,f2:null},review:null,finalOutput:null,latestRuns:{f1:run('F1'),f2:run('F2'),q1:run('Q1','RUNNING')}} as unknown as State;
const before=JSON.stringify(state);
assert.deepEqual(buildFoundationStageViews(state).map(v=>v.status),['执行成功','执行成功','进行中']);
assert.ok(buildFoundationStageViews(state).every(v=>!v.current));
const approved={...state,planningReady:true,assetsReady:true,ready:true};
assert.deepEqual(buildFoundationStageViews(approved).map(v=>v.status),['执行成功','执行成功','进行中']);
assert.ok(buildFoundationStageViews(approved).every(v=>v.current));
for(const [status,label] of [['SUCCEEDED','执行成功'],['FAILED','失败'],['CANCELED','已停止'],['RUNNING','进行中'],['QUEUED','排队中']]){
 for(const stale of [false,true]){
  const fixture={...state,latestRuns:{...state.latestRuns,q1:run('Q1',status,JSON.stringify({sourceVersion:stale?'previous':'source',inputVersion:'input'}))}} as unknown as State;
  const result=buildFoundationStageViews(fixture)[2];
  assert.equal(result.status,label+(stale&&!['RUNNING','QUEUED'].includes(status)?' · 历史版本':''));
  assert.equal(result.errorHistorical,stale);
  assert.doesNotMatch(result.status,/待重跑|就绪|批准|完成优化/);
 }
}
const absent={...approved,latestRuns:{f1:null,f2:null,q1:null}};
assert.ok(buildFoundationStageViews(absent).every(v=>v.status==='未开始'));
assert.equal(JSON.stringify(state),before);
console.log('PASS execution status independent of approval flags; stale, failure, stop, queue, running and missing records remain truthful');
