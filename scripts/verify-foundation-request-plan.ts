import assert from 'node:assert/strict';
import { planFoundationRequestScope } from '../lib/foundation-request-plan';
const pending=Array.from({length:70},(_,i)=>i+1);
assert.deepEqual(planFoundationRequestScope(pending,scope=>40000+scope.length*1000),pending,'whole drama fits after compaction; no per-episode requests');
const covered:number[]=[];const batches:number[][]=[];
while(covered.length<pending.length){
 const next=planFoundationRequestScope(pending.slice(covered.length),scope=>80000+scope.length*3000);
 assert(80000+next.length*3000+24000<=200000);batches.push(next);covered.push(...next);
}
assert.deepEqual(covered,pending);assert.equal(batches.length,3);
assert.deepEqual(planFoundationRequestScope([7],()=>250000),[7],'indivisible source retained for explicit preflight failure');
assert.deepEqual(planFoundationRequestScope([],()=>{throw Error('empty plan must not measure')}),[]);
console.log('PASS exact request scope planning: whole-scope fit, complete ordered coverage, no discarded oversized episode');
