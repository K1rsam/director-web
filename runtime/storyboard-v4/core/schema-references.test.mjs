import test from 'node:test';
import assert from 'node:assert/strict';
import {projectOutputSchema} from './schema-references.mjs';
import {buildOutputSchema} from './output-schema.mjs';

const object=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const ids=Array.from({length:16},(_,i)=>`source-long-coordinate-L${String(i).padStart(4,'0')}`);
const enumeration=values=>({type:'string',enum:values});
const refs=values=>({type:'array',items:enumeration(values)});

// Independent expansion checks every original constraint, not merely valid-looking output.
function expand(schema){
 const visit=value=>{
  if(!value||typeof value!=='object')return value;
  if(Object.hasOwn(value,'$ref')){
   assert.deepEqual(Object.keys(value),['$ref']);
   assert.match(value.$ref,/^#\/\$defs\/enum\d+$/);
   const target=schema.$defs[value.$ref.split('/').at(-1)];
   assert.ok(target);assert.ok(!target.$ref);
   return structuredClone(target);
  }
  return Array.isArray(value)?value.map(visit):Object.fromEntries(Object.entries(value).filter(([key])=>key!=='$defs').map(([key,item])=>[key,visit(item)]));
 };
 return visit(schema);
}

test('identical long enums share one definition and preserve all constraints exactly',()=>{
 const schema=object({first:refs(ids),second:refs(ids),short:enumeration(['yes','no']),different:refs([...ids].reverse()),empty:{type:'array',items:{type:'string'},maxItems:0}});
 const before=structuredClone(schema),result=projectOutputSchema(schema);
 assert.ok(result.$defs);
 assert.equal(Object.keys(result.$defs).length,1);
 assert.deepEqual(expand(result),schema);
 assert.deepEqual(schema,before);
 assert.deepEqual(result.properties.different,schema.properties.different);
 assert.ok(JSON.stringify(result).length<JSON.stringify(schema).length);
 assert.deepEqual(result,projectOutputSchema(structuredClone(schema)));
});

test('small or single-use enums and extra constraints are not replaced',()=>{
 const schema=object({a:enumeration(['a']),b:enumeration(['a']),once:refs(ids),guarded:{type:'string',enum:ids,description:'此约束属于独有字段'},alsoGuarded:{type:'string',enum:ids,description:'此约束属于另一字段'}});
 assert.deepEqual(projectOutputSchema(schema),schema);
});

test('existing definitions and references are preserved without reinterpreting or nesting',()=>{
 const schema={...object({a:refs(ids),b:refs(ids)}),$defs:{existing:enumeration(ids)}};
 assert.equal(projectOutputSchema(schema),schema);
 const refSchema=object({a:refs(ids),b:refs(ids),prior:{$ref:'#'}});
 assert.equal(projectOutputSchema(refSchema),refSchema);
 const projected=projectOutputSchema(object({a:refs(ids),b:refs(ids)}));
 assert.equal(projectOutputSchema(projected),projected);
});

test('real plan, author, full and delta schemas expand to the exact original contracts',()=>{
 const source={sourceRows:ids.map(id=>({id})),contextRows:[{id:'prior-context-coordinate-0001'}],dialogue:ids.map(id=>({id:`${id}:D1`}))};
 const base={source,settings:{fantasyEnabled:true},selection:{selectedIds:['selected-fantasy']},previousDraft:{units:ids.map(id=>({id:`unit-${id}`}))},baseDraftHash:'hash-for-this-test',scenarioKeys:['danger-rescue'],plan:{events:[{id:'event-one'}]},outputSchemaVersion:'structured-v2',unitDirectionVersion:'unit-direction-v1'};
 for(const [stage,finishMode] of [['plan','full'],['author','full'],['finish','full'],['finish','delta']]){
  const schema=buildOutputSchema({...base,stage,finishMode}),projected=projectOutputSchema(schema);
  if(stage!=='author')assert.ok(projected.$defs,`${stage}/${finishMode} shares repeated source or unit IDs`);
  else assert.equal(projected,schema,'a scoped author schema with no duplicate catalog stays unchanged');
  assert.deepEqual(expand(projected),schema);
  assert.ok(JSON.stringify(projected).length<=JSON.stringify(schema).length);
 }
});
