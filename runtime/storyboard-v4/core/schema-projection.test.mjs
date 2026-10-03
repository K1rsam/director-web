import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules} from './core.mjs';
import {digest} from './shared.mjs';
import {seeded} from './execution-batch-test-fixtures.mjs';

function fixture(){
 return {stage:'plan',settings:{maxUnits:null,fantasyMode:'off'},source:{key:'schema-projection',sourceRows:Array.from({length:20},(_,i)=>({id:`schema-projection-long-reference-L${String(i).padStart(4,'0')}`,text:`△甲走过第${i+1}道门。`})),contextRows:[]}};
}
const expanded=schema=>{
 const visit=value=>{
  if(!value||typeof value!=='object')return value;
  if(value.$ref)return structuredClone(schema.$defs[value.$ref.split('/').at(-1)]);
  return Array.isArray(value)?value.map(visit):Object.fromEntries(Object.entries(value).filter(([key])=>key!=='$defs').map(([key,item])=>[key,visit(item)]));
 };
 return visit(schema);
};

test('only new snapshots project schemas; model prose and professional rules remain byte-identical',()=>{
 const rules=captureRules();assert.equal(rules.schemaProjectionVersion,'shared-enums-v1');
 const frozen=structuredClone(rules);delete frozen.schemaProjectionVersion;
 const old=buildRequest({...fixture(),rulesSnapshot:frozen}),current=buildRequest({...fixture(),rulesSnapshot:rules});
 assert.ok(current.schema.$defs);assert.equal(old.schema.$defs,undefined);
 assert.deepEqual(expanded(current.schema),old.schema);
 assert.equal(current.prompt,old.prompt);assert.equal(current.promptHash,old.promptHash);
 assert.equal(current.instructions,old.instructions);assert.deepEqual(current.loadedFiles,old.loadedFiles);
 assert.deepEqual(current.snapshot,old.snapshot);assert.equal(current.schemaHash,digest(current.schema));
 assert.notEqual(current.inputHash,old.inputHash);assert.notEqual(current.schemaHash,old.schemaHash);
 assert.equal(buildRequest({...fixture(),rulesSnapshot:structuredClone(frozen)}).inputHash,old.inputHash);
 assert.ok(!current.prompt.includes('schemaProjectionVersion'));
});

test('unknown schema projection versions fail explicitly rather than silently altering saved requests',()=>{
 assert.throws(()=>buildRequest({...fixture(),rulesSnapshot:{...captureRules(),schemaProjectionVersion:'future-version'}}),error=>error.code==='RULE_SNAPSHOT');
});

test('refresh cannot silently change an existing plan to a different schema projection',async t=>{
 const {engine,store}=await seeded(t);
 await store.update('batch',d=>{delete d.rulesSnapshot.schemaProjectionVersion;return d;});
 const before=await engine.read('batch');
 await assert.rejects(engine.refreshRules('batch'),{code:'RULES_PROTOCOL_CHANGE'});
 assert.deepEqual(await engine.read('batch'),before);
});
