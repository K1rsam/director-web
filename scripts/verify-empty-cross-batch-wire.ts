import assert from 'node:assert/strict';
import {projectFoundationModelInput} from '../lib/foundation-model-input';
const source={episodes:[{number:1,lines:[[1,'台词 aaa\r\n']]}]};
const input={source,crossBatchVariants:[{assetKey:'a',variants:[]},{assetKey:'b',variants:[{key:'v',name:'原名'}]},{assetKey:'c',variants:[],note:'额外语义不能删'}]};
const original=structuredClone(input);
const wire=projectFoundationModelInput(input) as typeof input;
assert.deepEqual(input,original);assert.deepEqual(wire.source,source);
assert.deepEqual(wire.crossBatchVariants,input.crossBatchVariants.slice(1));
assert.deepEqual(projectFoundationModelInput(wire),wire);
// Restore the documented empty-list default for known candidate keys, with exact nonempty content.
assert.deepEqual(input.crossBatchVariants.map(row=>wire.crossBatchVariants.find(r=>r.assetKey===row.assetKey)??{assetKey:row.assetKey,variants:[]}),input.crossBatchVariants);
console.log('PASS empty batch lists omitted with exact default reconstruction; nonempty/unknown metadata and source unchanged');
