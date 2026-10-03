import assert from 'node:assert/strict';
import {attachEpisodeMaterials} from '../lib/episode-upstream-material';
const base:any={readiness:'READY',reasons:[],packet:{assets:[{key:'a',variants:[]}],materialDependencies:[]}};
const direction:any={status:'CONFIRMED',projection:{brief:'克制暧昧，不改原话。',cardHash:'direction-v1'}};
const designs:any[]=[{assetKey:'a',status:'TEXT_ADOPTED',adoptionVersion:1,brief:'灰衣与蓝钥匙扣',materialAvailability:'TEXT_ONLY',references:[]},
 {assetKey:'other',status:'TEXT_ADOPTED',brief:'不属于本集的长稿',materialAvailability:'TEXT_ONLY',references:[]},
 {assetKey:'old',status:'STALE',brief:'旧设计不应生效',materialAvailability:'TEXT_ONLY',references:[]}];
const result=attachEpisodeMaterials(base,direction,designs);
assert.equal(result.packet.upstream.modelDesigns.length,1);
assert.equal(result.packet.upstream.modelDesigns[0].assetKey,'a');
assert(!JSON.stringify(result).includes('不属于本集'));
assert.equal((base.packet as any).upstream,undefined);
assert.throws(()=>attachEpisodeMaterials(base,{status:'CONFIRMED',projection:null} as any,designs));
assert.throws(()=>attachEpisodeMaterials(base,direction,[designs[0],designs[0]]));
assert.deepEqual(attachEpisodeMaterials(base,{status:'UNCONFIRMED',projection:null},[]).packet.upstream.modelDesigns,[]);
console.log('PASS episode-scoped adopted material projection: no full prompt, no unrelated assets, no fake confirmation');
