import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDelta, baseDraftHash, DELTA_VERSION} from './delta.mjs';
import {normalizeRefinementLinkedUnits} from './refinement-linked-units.mjs';

const unit = id => ({id, eventId:'e1', shots:[{id:`${id}-s`, picture:'原有表演'}]});
function fixture() {
 const base={schemaVersion:'performance-core-v4', units:['a','b','c'].map(unit), fantasyRealization:[{candidateId:'f',unitIds:['a','b'],shotIds:['a-s','b-s'],status:'realized'}]};
 const changed=structuredClone(base.units[1]);changed.shots[0].picture='实际改进的表演';
 const delta={schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(base),retainedUnitIds:['a','c'],replacements:[{replaces:['b'],units:[changed],fantasyRealization:[structuredClone(base.fantasyRealization[0])]}]};
 return {base,delta,refinement:{version:'director-refinement-v3',unitIds:['a','b','c']}};
}
test('a retained linked neighbor is copied unchanged into the complete atomic group, without rewriting the paid reply',()=>{
 const {base,delta,refinement}=fixture(),before=structuredClone(delta);
 assert.throws(()=>applyDelta(base,delta),e=>e.code==='DELTA_FANTASY_GROUP');
 const normalized=normalizeRefinementLinkedUnits(base,delta,refinement),draft=applyDelta(base,normalized.delta);
 assert.deepEqual(delta,before);assert.deepEqual(normalized.delta.replacements[0].replaces,['a','b']);
 assert.deepEqual(normalized.delta.retainedUnitIds,['c']);assert.deepEqual(draft.units[0],base.units[0]);assert.equal(draft.units[1].shots[0].picture,'实际改进的表演');
 assert.deepEqual(draft.units[2],base.units[2]);assert.deepEqual(normalized.changes.map(c=>c.coordinate),['a']);
});
test('retained-only fantasies are preserved exactly when their unchanged unit is carried into a group',()=>{
 const {base,delta,refinement}=fixture(),f={candidateId:'solo',unitIds:['a'],shotIds:['a-s'],status:'realized'};base.fantasyRealization.push(f);delta.baseDraftHash=baseDraftHash(base);
 const {delta:next}=normalizeRefinementLinkedUnits(base,delta,refinement);assert.deepEqual(applyDelta(base,next).fantasyRealization.find(v=>v.candidateId==='solo'),f);
});
test('normalization never expands the authorized range or invents a missing replacement unit',()=>{
 const {base,delta,refinement}=fixture();refinement.unitIds=['b'];
 assert.throws(()=>normalizeRefinementLinkedUnits(base,delta,refinement),e=>e.code==='DELTA_FANTASY_GROUP');
 delta.retainedUnitIds=['c'];assert.throws(()=>normalizeRefinementLinkedUnits(base,delta,{...refinement,unitIds:['a','b','c']}),e=>e.code==='DELTA_PARTITION');
});
test('separate paid creative groups are not silently merged, and legacy v2 stays strict',()=>{
 const {base,delta,refinement}=fixture();
 assert.throws(()=>normalizeRefinementLinkedUnits(base,delta,{...refinement,version:'director-refinement-v2'}),e=>e.code==='DELTA_FANTASY_GROUP');
 delta.retainedUnitIds=['c'];delta.replacements.unshift({replaces:['a'],units:[unit('a')],fantasyRealization:[]});
 assert.throws(()=>normalizeRefinementLinkedUnits(base,delta,refinement),e=>e.code==='DELTA_FANTASY_GROUP');
});
test('already complete deltas and non-fantasy errors are not rewritten',()=>{
 const {base,delta,refinement}=fixture();delta.retainedUnitIds=['a','b','c'];delta.replacements=[];
 const result=normalizeRefinementLinkedUnits(base,delta,refinement);assert.equal(result.delta,delta);assert.deepEqual(result.changes,[]);
 delta.baseDraftHash='stale';assert.throws(()=>normalizeRefinementLinkedUnits(base,delta,refinement),e=>e.code==='DELTA_STALE');
});
