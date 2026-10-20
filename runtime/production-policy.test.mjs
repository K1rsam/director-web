import test from 'node:test';
import assert from 'node:assert/strict';
const policy=await import('./production-policy.mjs').catch(e=>e.code==='ERR_MODULE_NOT_FOUND'?{}:Promise.reject(e));

test('the calibrated episode and selection defaults have one browser-safe authority',()=>{
 assert.deepEqual(policy.DEFAULT_EPISODE_BUDGET,{maxCalls:8,maxTokens:600000});
 assert.equal(policy.EPISODE_TOKEN_WARNING,500000);
 assert.deepEqual(policy.recommendedWorkflowBudget(80),{maxCalls:480,maxTokens:36000000});
 assert.deepEqual(policy.recommendedWorkflowBudget(2),{maxCalls:40,maxTokens:2000000});
 for(const n of [0,-1,1.5,501,NaN])assert.throws(()=>policy.recommendedWorkflowBudget(n));
});
test('model selection is explicit and browser-safe; invalid profiles never silently default',()=>{
 assert.deepEqual(policy.productionModelSelection(),{version:'production-model-selection-v1',model:'gpt-6.1-sol',reasoning:'medium'});
 for(const model of policy.PRODUCTION_MODELS)for(const reasoning of policy.PRODUCTION_REASONING){
  const selection={version:'production-model-selection-v1',model,reasoning};assert.deepEqual(policy.productionModelSelection(selection),selection);
 }
 for(const invalid of [null,[],{},'gpt-6-sol',{...policy.DEFAULT_PRODUCTION_MODEL_SELECTION,version:'invented'}])assert.throws(()=>policy.productionModelSelection(invalid),{code:'WORKFLOW_MODEL_SELECTION'});
});
