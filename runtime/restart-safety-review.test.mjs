import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';

const leaseURL=new URL('./storyboard-v4/runtime-lease.mjs',import.meta.url).href;
const storeURL=new URL('./storyboard-v4/core/store.mjs',import.meta.url).href;
const workerURL=new URL('./production-parallel.mjs',import.meta.url).href;
const child=script=>JSON.parse(execFileSync(process.execPath,['--experimental-test-module-mocks','--input-type=module','-e',script],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}));

for(const phase of ['boot-proof','final-metadata'])test(`restart review: a recovery lease lost during ${phase} cannot archive the document lock`,()=>{
 const actual=child(`
import {mock} from 'node:test';
import {hostname} from 'node:os';
const phase=${JSON.stringify(phase)};
let held=true,renames=0,signals=0,stats=0;
process.kill=(_pid,signal)=>{if(signal!==0)throw Error('real signalling is forbidden');signals++;return true;};
const owner=JSON.stringify({pid:1234,host:hostname(),token:'review-only-owner'}),time=Date.now()-10000;
const stat={isFile:()=>true,isSymbolicLink:()=>false,dev:1,ino:1,size:owner.length,birthtimeMs:time,mtimeMs:time,ctimeMs:time};
mock.module('node:fs/promises',{namedExports:{mkdir:async()=>{},readFile:async()=>owner,open:async()=>{},rename:async()=>{renames++;},rm:async()=>{},unlink:async()=>{},lstat:async()=>{if(++stats===3&&phase==='final-metadata')held=false;return stat;}}});
mock.module(${JSON.stringify(leaseURL)},{namedExports:{acquireRuntimeLease:async()=>({assertHeld(){if(!held)throw Object.assign(new Error('lost'),{code:'LEASE_LOST'});},release:async()=>{}})}});
const {createStore}=await import(${JSON.stringify(storeURL)});
let error=null;
try{await createStore('/review-only',{hostBootTime:async()=>{if(phase==='boot-proof')held=false;return time+5000;}}).recoverStaleLock('review');}catch(e){error=e.code??e.name;}
console.log(JSON.stringify({error,renames,signals}));
`);
 assert.equal(actual.error,'LEASE_LOST','lost ownership must fail before stale-lock mutation');
 assert.equal(actual.renames,0,'CAS evidence cannot replace a currently held kernel lease');
 assert.equal(actual.signals,1,'the only liveness check is simulated signal zero');
});

function workerScenario(scenario){
 return child(`
import {mock} from 'node:test';
const scenario=${JSON.stringify(scenario)};
let recoveryChecks=0,pumps=0,records=0,released=0,reads=0,held=true;
let workflow={paused:false,parallel:{enabled:true,authorizedBy:'actor',authorizedAt:'original-authorization',worker:{}}};
if(scenario==='missing-auth-empty-worker'||scenario==='missing-auth-no-worker')delete workflow.parallel.authorizedAt;
if(scenario==='missing-auth-no-worker')delete workflow.parallel.worker;
process.kill=()=>{throw Error('no real process signalling in the worker review');};
mock.module(${JSON.stringify(leaseURL)},{namedExports:{acquireRuntimeLease:async()=>{
 await new Promise(resolve=>setImmediate(resolve));
 if(scenario==='paused-while-waiting')workflow={...workflow,paused:true,parallel:{...workflow.parallel,enabled:false}};
 if(scenario==='authorization-changed-while-waiting')workflow={...workflow,parallel:{...workflow.parallel,authorizedAt:'replacement-authorization'}};
 if(scenario==='actor-changed-while-waiting')workflow={...workflow,parallel:{...workflow.parallel,authorizedBy:'replacement-actor'}};
 return {assertHeld(){if(!held)throw Object.assign(new Error('lost'),{code:'LEASE_LOST'});},release:async()=>{released++;}};
}}});
mock.module(${JSON.stringify(storeURL)},{namedExports:{createStore:()=>({recoverStaleLock:async()=>{
 recoveryChecks++;
 if(scenario==='paused-during-recovery')workflow={...workflow,paused:true,parallel:{...workflow.parallel,enabled:false}};
 if(scenario==='authorization-changed-during-recovery')workflow={...workflow,parallel:{...workflow.parallel,authorizedAt:'replacement-authorization'}};
 if(scenario==='actor-changed-during-recovery')workflow={...workflow,parallel:{...workflow.parallel,authorizedBy:'replacement-actor'}};
 if(scenario==='lease-lost-during-recovery')held=false;
}})}});
const {createParallelProductionWorker}=await import(${JSON.stringify(workerURL)});
const service={
 read:async()=>{reads++;if(scenario==='lease-lost-while-reading-controls'&&reads===2)held=false;return structuredClone(workflow);},
 recordParallelWorker:async()=>{records++;},
 pumpParallel:async()=>{pumps++;return {parallel:{enabled:false,status:'PAUSED'},workflow:{paused:true}};}
};
const worker=createParallelProductionWorker({directory:'/review-only-worker',makeService:async()=>service,intervalMs:20});
let error=null;
try{await worker.start('review');await new Promise(resolve=>setTimeout(resolve,20));}catch(e){error=e.code??e.name;}
finally{await worker.stop('review');}
console.log(JSON.stringify({error,recoveryChecks,pumps,records,released,reads}));
`);
}

for(const shape of ['empty-worker','no-worker'])test(`restart review: missing original authorization with ${shape} cannot recover or pump`,()=>{
 const actual=workerScenario('missing-auth-'+shape);
 assert.equal(actual.error,'WORKFLOW_PARALLEL_OWNER','a missing authorization must be explicitly rejected');
 assert.equal(actual.recoveryChecks,0);
 assert.equal(actual.pumps,0);
 assert.equal(actual.records,0);
});

for(const scenario of ['paused-while-waiting','authorization-changed-while-waiting','actor-changed-while-waiting','lease-lost-while-reading-controls'])test(`restart review: ${scenario} cannot recover or pump after acquiring the lease`,()=>{
 const actual=workerScenario(scenario);
 assert.equal(actual.recoveryChecks,0,'re-read current authorization and pause controls before stale recovery');
 assert.equal(actual.pumps,0);
 assert.equal(actual.records,0);
 assert.equal(actual.released,1,'the rejected start must release its acquired lease');
 if(scenario==='lease-lost-while-reading-controls')assert.equal(actual.error,'LEASE_LOST');
 if(scenario==='actor-changed-while-waiting')assert.equal(actual.error,'WORKFLOW_PARALLEL_OWNER');
});

for(const scenario of ['paused-during-recovery','authorization-changed-during-recovery','actor-changed-during-recovery','lease-lost-during-recovery'])test(`restart review: ${scenario} cannot record or pump after stale-lock recovery`,()=>{
 const actual=workerScenario(scenario);
 assert.equal(actual.recoveryChecks,1,'the original valid admission reached the recovery boundary');
 assert.equal(actual.pumps,0);
 assert.equal(actual.records,0);
 assert.equal(actual.released,1);
 if(scenario==='lease-lost-during-recovery')assert.equal(actual.error,'LEASE_LOST');
 if(scenario.startsWith('authorization-')||scenario.startsWith('actor-'))assert.equal(actual.error,'WORKFLOW_PARALLEL_OWNER');
});
