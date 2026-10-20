// Calibrated against the 80-episode 6.1 Sol/medium/recommended-fantasy text run.
// New admissions only: never rewrite a saved budget, request or adopted draft.
export const PRODUCTION_LIMIT_POLICY='production-limits-20261015-v1';
export const DEFAULT_EPISODE_BUDGET=Object.freeze({maxCalls:8,maxTokens:600000});
export const EPISODE_TOKEN_WARNING=500000;
// Explicit new-run opt-in. Missing selection keeps legacy requests under their old policy.
export const PRODUCTION_MODELS=Object.freeze(['gpt-6.1-sol','gpt-6-sol','gpt-6-astra']);
export const PRODUCTION_REASONING=Object.freeze(['low','medium','high','xhigh','max','ultra']);
export const DEFAULT_PRODUCTION_MODEL_SELECTION=Object.freeze({version:'production-model-selection-v1',model:'gpt-6.1-sol',reasoning:'medium'});
export function productionModelSelection(value=DEFAULT_PRODUCTION_MODEL_SELECTION){
 if(!value||Array.isArray(value)||Object.keys(value).length!==3||value.version!==DEFAULT_PRODUCTION_MODEL_SELECTION.version||!PRODUCTION_MODELS.includes(value.model)||!PRODUCTION_REASONING.includes(value.reasoning))
  throw Object.assign(new Error('模型或推理档位无效，未改变已保存任务。'),{code:'WORKFLOW_MODEL_SELECTION',requestOutcome:'NOT_SENT',providerCalls:0});
 return {version:value.version,model:value.model,reasoning:value.reasoning};
}
export function recommendedWorkflowBudget(episodeCount){
 if(!Number.isSafeInteger(episodeCount)||episodeCount<1||episodeCount>500)throw new RangeError('Invalid production episode count');
 return {maxCalls:Math.max(40,6*episodeCount),maxTokens:Math.max(2000000,450000*episodeCount)};
}
