import test from 'node:test';
import assert from 'node:assert/strict';
import {projectModelCoordinates,restoreModelCoordinates} from './model-coordinates.mjs';
import {captureRules,buildRequest} from './core.mjs';
import {digest} from './shared.mjs';
import {freezeFeedbackBasis,feedbackResultSchema,projectResultFeedback} from './production-feedback-result.mjs';

const version='model-coordinates-repair-v3';
const legacy='model-coordinates-collision-v2';
const id='upstream-evidence:'+ 'a'.repeat(64);
const schema={type:'object',properties:{sourceRefs:{type:'array',items:{enum:[id]}}}};
const inputOf=previousDraft=>({source:{sourceRows:Array.from({length:60},()=>({id,text:'原句与空白  不改。',kind:'action'}))},previousDraft});
// Independent reader for transport markers; no production decoding helper is reused.
function expand(projected){
 const root=projected.input,aliases=projected.coordinates?.aliases??{};
 const read=p=>p.slice(2).split('/').reduce((v,k)=>v[k.replaceAll('~1','/').replaceAll('~0','~')],root);
 const walk=v=>{
  if(typeof v==='string')return aliases[v]??v;
  if(!v||typeof v!=='object')return v;
  if(v.$jsonOf)return JSON.stringify(walk(read(v.$jsonOf)));
  if(v.$jsonJoinOf)return v.$jsonJoinOf[0].map(p=>JSON.stringify(walk(read(p)))).join(v.$jsonJoinOf[1]);
  const output=Array.isArray(v)?v.map(walk):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,walk(x)]));
  if(!Array.isArray(output))delete output.parsedRawOutput;
  return output;
 };
 return walk(root);
}

test('parsed paid repair JSON no longer disables all coordinate compression; canonical raw and prose survive',()=>{
 const output={units:[{id:'u',shots:[{id:'s',picture:'反差与爽感保持；原句  和换行\n不改。',sourceRefs:[id]}]}],futureMetadata:{unknown:'照留'}};
 const input=inputOf({rawText:JSON.stringify(output)}),before=structuredClone(input);
 assert.equal(projectModelCoordinates(input,schema,{coordinateVersion:legacy}).coordinates,null);
 const next=projectModelCoordinates(input,schema,{coordinateVersion:version});
 assert.ok(next.coordinates,'a canonical parsed repair must not force the whole source/history/schema back to long IDs');
 assert.equal(next.coordinates.version,version);
 assert.deepEqual(expand(next),input);
 assert.deepEqual(input,before);
 assert.ok(JSON.stringify(next.input).length+JSON.stringify(next.schema).length+next.hint.length<JSON.stringify(input).length+JSON.stringify(schema).length);
 assert.deepEqual(restoreModelCoordinates({sourceRefs:next.schema.properties.sourceRefs.items.enum,text:'R0001是原台词'},next.coordinates),{sourceRefs:[id],text:'R0001是原台词'});
});

test('multiple paid candidates use bound JSON references once, including the aggregate repair copy',()=>{
 const first={units:[{id:'u1',shots:[{picture:'前包幻想  不删',sourceRefs:[id]}]}]},second={units:[{id:'u2',shots:[{picture:'后包表演不降档',sourceRefs:[id]}]}]};
 const input=inputOf({rawText:[JSON.stringify(first),JSON.stringify(second)].join('\n\n'),supplementalCandidates:[{packageIds:['p1'],status:'needs_repair',rawText:JSON.stringify(first)},{packageIds:['p2'],status:'needs_repair',draft:second}]});
 const next=projectModelCoordinates(input,schema,{coordinateVersion:version});
 assert.ok(next.coordinates);
 assert.ok(next.input.previousDraft.rawText.$jsonJoinOf);
 assert.deepEqual(expand(next),input);
 assert.equal(next.input.previousDraft.supplementalCandidates[1].draft.units[0].shots[0].picture,second.units[0].shots[0].picture);
});

test('opaque, ambiguous, alternate or explicitly bound old raw cannot be silently reinterpreted',()=>{
 for(const previous of [
  {rawText:'not JSON'},
  {rawText:'{"sourceRefs":["R0001"]}',rawCoordinateBindings:{R0001:id}},
  {rawText:'{"a":1,"a":2}'},
  {rawText:'{"quote":"\\u7532"}'},
  {rawText:'{"__proto__":{"sourceRefs":[]}}'},
  {rawText:'{"$jsonJoinOf":[["#/source"],"\\n"]}'},
  {rawText:'{"sourceRefs":[]}',parsedRawOutput:{sourceRefs:[id]}},
  {rawText:'{"sourceRefs":[]}',previousPlan:{sourceRefs:[id]}},
  {rawText:'{"sourceRefs":[]}',supplementalCandidates:{length:1}},
  {rawText:'{"sourceRefs":[]}',supplementalCandidates:[null]},
  {rawText:'different joined text',supplementalCandidates:[{draft:{sourceRefs:[id]}}]}
 ]){
  const input=inputOf(previous),next=projectModelCoordinates(input,schema,{coordinateVersion:version});
  assert.equal(next.coordinates,null);
  assert.strictEqual(next.input,input);
 }
});

test('ordinary requests with a parsed draft gain no repair-only fields or extra repair instructions',()=>{
 const input=inputOf({units:[{id:'u',shots:[{sourceRefs:[id]}]}]});
 const before=projectModelCoordinates(input,schema,{coordinateVersion:legacy});
 const next=projectModelCoordinates(input,schema,{coordinateVersion:version});
 assert.deepEqual(next.input,before.input);assert.deepEqual(next.schema,before.schema);assert.equal(next.hint,before.hint);
});

test('JSON whitespace is the only discarded syntax; string whitespace and preexisting short names stay literal',()=>{
 const output={quote:'甲  ：原文R0001\nR0002。',sourceRefs:[id]},input=inputOf({rawText:JSON.stringify(output,null,2)});
 const next=projectModelCoordinates(input,schema,{coordinateVersion:version});
 assert.ok(next.coordinates);
 assert.ok(!Object.hasOwn(next.coordinates.aliases,'R0001')&&!Object.hasOwn(next.coordinates.aliases,'R0002'));
 assert.deepEqual(JSON.parse(expand(next).previousDraft.rawText),output);
 assert.equal(input.previousDraft.rawText,JSON.stringify(output,null,2));
});

test('only newly captured rules enable parsed repair transport; frozen V2 requests stay identical',()=>{
 const rules=captureRules(),frozen={...rules,modelCoordinateVersion:legacy};
 const source={key:'parsed-repair-synthetic',sourceRows:[{id,text:'△甲接住钥匙。',kind:'action'}],contextRows:[],dialogue:[],entryFacts:[],assets:[]};
 const payload={stage:'plan',source,settings:{model:'gpt-6.1-sol',reasoning:'medium',maxUnits:null,maxUnitSeconds:30,fantasyMode:'off'},productionSnapshot:{version:'production-feedback-v1',transportVersion:rules.productionTransportVersion,materials:[],touchesOpening:false,touchesEnding:false}};
 const before=buildRequest({...payload,rulesSnapshot:frozen});
 assert.equal(rules.modelCoordinateVersion,'model-coordinates-v4');
 const next=buildRequest({...payload,rulesSnapshot:rules});
 assert.equal(digest(buildRequest({...payload,rulesSnapshot:frozen})),digest(before));
 assert.deepEqual(next.source,before.source);
 assert.deepEqual(next.snapshot,before.snapshot,'creative Skills are not modified by a transport optimization');
});

const materialVersion='model-coordinates-v4';
const materialId='asset:C_0123456789abcdef_V_fedcba9876543210';
function materialInput(){
 const prose='原文 R0001 与素材 '+materialId+' 不改。';
 const draft={schemaVersion:'performance-core-v4',units:[{id:'u',shots:[{id:'s',sourceRefs:[id],picture:prose}]}],fantasyRealization:[]};
 const native={relation:'DIRECT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[materialId],needs:[],conflicts:[]};
 const adopted={id:'adopted',attemptId:'original',status:'adopted',packageIds:['p'],draft,productionFeedback:native};
 const run={adopted:[{candidateId:adopted.id,packageIds:['p'],draft}],candidates:[adopted],operations:[{attemptId:'original',productionSnapshot:{materials:[{id:materialId,version:'old'}]}}]};
 const basis=freezeFeedbackBasis(run,draft,['p'],{version:'production-feedback-result-v1'});
 const input={...inputOf({...draft,feedbackBasis:basis}),productionMaterials:[{id:materialId}]};
 return {input,basis,draft,native,prose,schema:{type:'object',properties:feedbackResultSchema({basis,version:'production-feedback-result-v1'})}};
}

test('v4 feedback basis and actual material decision schema share one reversible namespace without resealing the basis',()=>{
 const f=materialInput(),before=structuredClone(f),next=projectModelCoordinates(f.input,f.schema,{coordinateVersion:materialVersion});
 assert.ok(next.coordinates,'material-aware projection must allocate a saved coordinate map');
 const wireBasis=next.input.previousDraft.feedbackBasis,enumIds=next.schema.properties.resultRevision.properties.materialDecisions.items.properties.id.enum;
 assert.deepEqual(wireBasis.materialIds,enumIds,'basis IDs must be directly usable in the actual output schema');
 assert.deepEqual(wireBasis.materialConsumers[0].materialIds,enumIds,'original material consumers use the same namespace');
 assert.notEqual(wireBasis.materialIds[0],materialId);
 const retired=projectModelCoordinates({...f.input,productionMaterials:[]},f.schema,{coordinateVersion:materialVersion});
 assert.notEqual(retired.input.previousDraft.feedbackBasis.materialIds[0],materialId,'a basis-only retired ID is still collected and encoded');
 assert.equal(wireBasis.signature,f.basis.signature,'a model-only spelling projection cannot replace the canonical seal');
 assert.equal(next.input.previousDraft.units[0].shots[0].picture,f.prose);
 assert.ok(!Object.hasOwn(next.coordinates.aliases,'R0001'),'literal prose aliases are reserved');
 const output={...f.native,usedMaterialIds:[],resultRevision:{baseSignature:f.basis.signature,exitDecisions:[],materialDecisions:[{id:enumIds[0],decision:'KEEP',reason:f.prose}]},entryEvidence:[]};
 const restored=restoreModelCoordinates(output,next.coordinates);
 assert.equal(restored.resultRevision.materialDecisions[0].id,materialId);
 assert.equal(restored.resultRevision.materialDecisions[0].reason,f.prose);
 assert.deepEqual(restoreModelCoordinates({materialIds:wireBasis.materialIds},next.coordinates),{materialIds:[materialId]});
 const projection=projectResultFeedback({request:{stage:'finish',previousDraft:f.input.previousDraft,productionSnapshot:{feedbackResultVersion:'production-feedback-result-v1'}},feedback:restored,draft:f.draft,candidateId:'new',attemptId:'new-attempt',packageIds:['p']});
 assert.deepEqual(projection.materialConsumers[0].materialIds,[materialId]);
 assert.equal(projection.materialConsumers[0].attemptId,'original');
 assert.deepEqual(f,before,'canonical source, basis, consumers and paid feedback stay unchanged');
 assert.throws(()=>restoreModelCoordinates(output,{...next.coordinates,hash:'changed'}),{code:'MODEL_COORDINATES'});
});

test('v4 retains parsed repair transport and refuses opaque raw namespaces',()=>{
 const output={sourceRefs:[id],materialIds:[materialId],quote:'旧编号R0001与原文不改。'};
 const input={...inputOf({rawText:JSON.stringify(output)}),productionMaterials:[{id:materialId}]};
 const next=projectModelCoordinates(input,schema,{coordinateVersion:materialVersion});
 assert.ok(next.coordinates);assert.ok(next.input.previousDraft.rawText.$jsonOf);
 assert.deepEqual(expand(next),input);
 for(const previousDraft of [{rawText:'not JSON'},{rawText:'{"sourceRefs":["R0001"]}',rawCoordinateBindings:{R0001:id}},{rawText:'{"id":1,"id":2}'}]){
  const raw=inputOf(previousDraft),result=projectModelCoordinates(raw,schema,{coordinateVersion:materialVersion});
  assert.equal(result.coordinates,null);assert.strictEqual(result.input,raw);
 }
});

test('frozen coordinate V1 V2 V3 keep their bytes and alias mapping hashes after v4 adds materialIds',()=>{
 const input={...inputOf({units:[{id:'u',shots:[{id:'s',sourceRefs:[id],picture:'原文 R0001 与素材 '+materialId+' 不改。'}]}],feedbackBasis:{signature:'unchanged-basis-signature',materialIds:[materialId],materialConsumers:[{materialIds:[materialId]}]}}),productionMaterials:[{id:materialId}]};
 const frozenSchema={type:'object',properties:{sourceRefs:{type:'array',items:{enum:[id]}},materialDecisions:{type:'array',items:{properties:{id:{enum:[materialId]}}}}}};
 const expected={
  'model-coordinates-v1':['22b8c4e80cdac79fdcb69155a0495725112d442a71c6ca047f4fda7fd013705b',null],
  'model-coordinates-collision-v2':['3b8541c0d644e09c1b1a07fdd6e7664cfb81a231853a2ad8175a1cf94de7c487','45854c2e0fe3ae47e303cf871beb0c44c42fc0cb1183c3bd46461f6481382b4f'],
  'model-coordinates-repair-v3':['b46b8425845e0e0303591892b0d1c197844e80760bbc2d7432ad99a5f621a87e','7165331c7342e3baff127877e4fa74d250a45f05d4c13be1d01b47e3d79327b6']
 };
 for(const [coordinateVersion,[bytes,mappingHash]] of Object.entries(expected)){
  const result=projectModelCoordinates(input,frozenSchema,{coordinateVersion});
  assert.equal(digest(result),bytes,coordinateVersion);assert.equal(result.coordinates?.hash??null,mappingHash,coordinateVersion);
  assert.deepEqual(result.input.previousDraft.feedbackBasis.materialIds,[materialId]);
  if(result.coordinates)assert.deepEqual(restoreModelCoordinates({materialIds:['R0003']},result.coordinates),{materialIds:['R0003']},'legacy decoder must not acquire the new materialIds field');
 }
});
