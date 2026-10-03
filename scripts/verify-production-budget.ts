import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {budgetedProductionCall,productionBudgetStore,withProductionBudgetContext} from '../lib/production-budget';
import {runDeepSeekJson} from '../lib/deepseek-api';

async function main(){
 const directory=await mkdtemp(path.join(tmpdir(),'production-budget-adapter-')),savedFetch=globalThis.fetch;
 try{
  const ledger=productionBudgetStore(directory);
  await ledger.create('compare',{projectIds:['upstream','baseline','integrated'],maxCalls:4,maxTokens:100});
  let sent=0;
  globalThis.fetch=async()=>{sent++;return new Response(JSON.stringify({id:'offline-envelope',choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}));};
  const api=()=>runDeepSeekJson({model:'deepseek-chat',prompt:'synthetic',apiKey:'offline-test-only',retry:false});
  const scoped=<T>(action:()=>Promise<T>)=>withProductionBudgetContext({id:'compare',directory},action);
  const first=await scoped(()=>budgetedProductionCall({projectId:'upstream',stage:'F1',provider:'API'},api));
  assert.equal(first.usage?.totalTokens,10);
  globalThis.fetch=async()=>{sent++;return new Response(JSON.stringify({choices:[{message:{content:'bad json'},finish_reason:'length'}],usage:{prompt_tokens:8,completion_tokens:4,total_tokens:12}}));};
  await assert.rejects(scoped(()=>budgetedProductionCall({projectId:'baseline',stage:'author',provider:'API'},api)));
  assert.equal((await ledger.read('compare')).summary.knownTokens,22,'invalid model JSON still retains native billed usage');
  globalThis.fetch=async()=>{sent++;return new Response(JSON.stringify({choices:[{message:{content:'{"ok":true,"totalTokens":0}'}}]}));};
  await scoped(()=>budgetedProductionCall({projectId:'integrated',stage:'finish',provider:'API'},api));
  assert.equal((await ledger.read('compare')).summary.unknownAttempts,1);
  await assert.rejects(scoped(()=>budgetedProductionCall({projectId:'upstream',stage:'F2',provider:'API'},api)),{code:'PRODUCTION_USAGE_UNKNOWN'});
  assert.equal(sent,3,'shared unknown usage prevents another outbound request');
  await ledger.create('isolated',{projectIds:['upstream'],maxCalls:1,maxTokens:100});
  await withProductionBudgetContext({id:'isolated',directory},()=>budgetedProductionCall({projectId:'upstream',stage:'F2',provider:'CLI'},async()=>({usage:{totalTokens:5}})));
  assert.equal((await ledger.read('compare')).summary.calls,3);assert.equal((await ledger.read('isolated')).summary.calls,1);
  const cases: Array<{name:string;usage:Record<string,unknown>;expected:number|null}>=[
   {name:'contradictory-total',usage:{prompt_tokens:7,completion_tokens:3,total_tokens:0},expected:null},
   {name:'null-total',usage:{prompt_tokens:7,completion_tokens:3,total_tokens:null},expected:null},
   {name:'negative-total',usage:{prompt_tokens:7,completion_tokens:3,total_tokens:-1},expected:null},
   {name:'string-total',usage:{prompt_tokens:7,completion_tokens:3,total_tokens:'10'},expected:null},
   {name:'fraction-total',usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10.5},expected:null},
   {name:'missing-total',usage:{prompt_tokens:7,completion_tokens:3},expected:10},
  ];
  for(const {name,usage,expected} of cases){
   await ledger.create(name,{projectIds:['upstream'],maxCalls:2,maxTokens:100});
   let requests=0;
   globalThis.fetch=async()=>{requests++;return new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage}));};
   const invoke=()=>withProductionBudgetContext({id:name,directory},()=>budgetedProductionCall({projectId:'upstream',stage:'F1',provider:'API'},api));
   const result=await invoke();
   assert.deepEqual(result.data,{ok:true},`${name}: already paid content stays available`);
   assert.equal(result.usage?.totalTokens,expected,`${name}: actual API adapter preserves unknown/known distinction`);
   const row=await ledger.read(name);
   assert.equal(row.summary.knownTokens,expected??0,`${name}: no invented native total`);
   assert.equal(row.summary.unknownAttempts,expected===null?1:0,`${name}: actual adapter-to-budget chain`);
   assert.equal(row.summary.complete,expected!==null,`${name}: unknown usage is not complete`);
   if(expected===null)await assert.rejects(invoke(),{code:'PRODUCTION_USAGE_UNKNOWN'});
   assert.equal(requests,1,`${name}: unknown usage cannot trigger another HTTP request`);
  }
  console.log('PASS production budget adapter: shared upstream/A/B, native usage, invalid response, unknown stop, context isolation, 6 actual-adapter receipt variants; network synthetic only');
 }finally{globalThis.fetch=savedFetch;await rm(directory,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
