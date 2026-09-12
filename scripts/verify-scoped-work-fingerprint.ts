import assert from 'node:assert/strict';
import { costFingerprint } from '../lib/foundation-delivery';
const base={scope:[1],source:{episodes:[]}};
const choice={decisionKey:'key-transfer',status:'CONFIRMED',answer:'甲持有钥匙',episodes:[1]};
const fingerprint=(applicationScope?:unknown)=>costFingerprint('Q1',{...base,humanChoiceRegistry:[{...choice,...(applicationScope?{applicationScope}:{})}]});
assert.equal(fingerprint(),fingerprint({kind:'EPISODES',episodes:[1]}),'legacy explicit episode work stays reusable');
assert.notEqual(fingerprint({kind:'SCENES',scenes:[{episode:1,sceneKey:'1-1'}]}),fingerprint({kind:'SCENES',scenes:[{episode:1,sceneKey:'1-2'}]}),'same answer applied to another scene is different work');
assert.notEqual(fingerprint(),fingerprint({kind:'UNRESOLVED'}),'unresolved scope cannot reuse an applied whole episode answer');
console.log('PASS scoped paid-work fingerprint: old episode compatibility, scene change invalidation, unresolved scope isolation');
