import assert from 'node:assert/strict';
import {decisionSceneKeys} from '../lib/foundation-decision-targets';
const scoped={episodes:[23,24],applicationScope:{kind:'SCENES' as const,scenes:[{episode:23,sceneKey:'23-1'},{episode:24,sceneKey:'24-1'},{episode:24,sceneKey:'24-2'}]}};
assert.deepEqual(decisionSceneKeys([scoped],[23,24]),['23-1','24-1','24-2']);
assert.deepEqual(decisionSceneKeys([scoped],[23]),['23-1']);
assert.equal(decisionSceneKeys([scoped,{episodes:[23],applicationScope:{kind:'EPISODES',episodes:[23]}}],[23]),undefined);
console.log('PASS explicit decision scene targets exclude 23-2; mixed episode authority stays explicit');
