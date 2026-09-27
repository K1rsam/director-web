import test from 'node:test';
import assert from 'node:assert/strict';
import {digest,fail,VERSION} from './shared.mjs';

test('fingerprints ignore object key order but preserve meaningful array order',()=>{
  assert.equal(digest({a:1,b:[2,3]}),digest({b:[2,3],a:1}));
  assert.notEqual(digest({a:1,b:[2,3]}),digest({a:1,b:[3,2]}));
  assert.equal(VERSION,'performance-core-v4');
});
test('coded failures preserve a user-readable cause',()=>{
  assert.throws(()=>fail('STALE_INPUT','依据已变化'),e=>e.code==='STALE_INPUT'&&e.message==='依据已变化');
});
