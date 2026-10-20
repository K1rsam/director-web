// Explicit v1 fixtures keep transport/state-machine tests independent of new creative protocols.
import {captureRules} from './core.mjs';
import {createStore} from './store.mjs';
import {createEngine as currentEngine} from './pipeline.mjs';
import {createCoordinator as currentCoordinator} from '../coordinator.mjs';
export function legacyRules(){
 const rules={...captureRules(),outputSchemaVersion:'structured-v1'};
 for(const key of ['opportunityCoverageVersion','unitDirectionVersion','seedanceExportVersion','unitPackingPolicy','creativeRevision','sourceExpressionMethodsVersion','acceptedContinuityVersion','planHint','draftHint','deltaHint'])delete rules[key];
 return rules;
}
function pinLegacy(instance,directory){
 const create=instance.create;
 instance.create=async input=>{const d=await create(input);return createStore(directory).update(d.id,x=>{x.rulesSnapshot=legacyRules();return x;});};
 return instance;
}
export const createEngine=options=>pinLegacy(currentEngine(options),options.directory);
export const createCoordinator=options=>pinLegacy(currentCoordinator(options),options.dataRoot);

// Boundary/material-loop fixtures predate the result contract. Keep current
// creative rules but freeze both result markers absent; dedicated native-v2
// regressions continue to exercise the strict paired-marker gate.
function pinUnversionedProduction(instance,directory){
 const create=instance.create;
 instance.create=async input=>{const d=await create(input);return createStore(directory).update(d.id,x=>{
  delete x.rulesSnapshot.productionFeedbackResultVersion;
  if(x.production)delete x.production.feedbackResultVersion;
  return x;
 });};
 return instance;
}
export const createUnversionedProductionEngine=options=>pinUnversionedProduction(currentEngine(options),options.directory);
export const createUnversionedProductionCoordinator=options=>pinUnversionedProduction(currentCoordinator(options),options.dataRoot);
