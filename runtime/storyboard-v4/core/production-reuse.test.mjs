import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules} from './core.mjs';
import {parseScript} from './source.mjs';
import {projectModelCoordinates} from './model-coordinates.mjs';
import {projectProductionTransport} from '../../production-transport.mjs';
import {buildFeedbackRepairRequest,mergeFeedbackRepair} from '../../feedback-repair.mjs';
import {resolveRunnerLimits} from './runner.mjs';

const version='production-compact-v3';
const nodes=()=>Array.from({length:16},(_,i)=>({id:`node-${i}`,target:'BODY',kind:'ACTION',sourceUnitIds:[`source-unit:${String(i).padStart(64,'0')}`],sourceRange:{start:i*8,end:i*8+8},startLine:i+1,endLine:i+1}));
const materialFacts=()=>[{id:'fact:'+('f'.repeat(64)),authority:'SOURCE',quote:'原文动作、持物与状态必须保留。'.repeat(80),sourceRefs:['s1'],applicability:{episodes:[2]},extension:{meaning:'未知字段不删除'}}];
const wire=()=>({source:{sourceRows:[{id:'s1',text:'甲接住钥匙。'}],contextRows:[],context:{continuity:{previousSource:{episode:1,nodes:nodes(),adjacentEpisode:true}}}},
 episodeBoundary:{seed:{previousSource:{episode:1,text:'甲递出钥匙。',nodes:nodes()}},actual:{unit:{exitState:'真实末态不变'}}},
 productionMaterials:[{id:'asset:base',version:'v1',value:{sourceFacts:materialFacts(),adoptedDesign:'采用白T恤',applicability:{episodes:[2]}}},{id:'asset:variant',version:'v2',value:{sourceFacts:materialFacts(),adoptedDesign:'撕破状态',applicability:{episodes:[3]}}}]});

// Independent expansion checks the full values, not the compressor's own claims.
function expand(input,aliases={}){
 const at=p=>p.slice(2).split('/').reduce((v,k)=>v[k.replaceAll('~1','/').replaceAll('~0','~')],input);
 const visit=v=>{
  if(typeof v==='string')return aliases[v]??v;
  if(!v||typeof v!=='object')return v;
  if(v.$same)return visit(at(v.$same));
  if(v.$joinRows){const [k,a,b,s]=v.$joinRows;return input.source[k].slice(a,b+1).map(r=>r.text).join(s);}
  if(v.$rowIds)return v.$rowIds.flatMap(([k,a,b])=>input.source[k].slice(a,b+1).map(r=>visit(r.id)));
  if(v.$boundaryNodes)return v.$boundaryNodes.rows.map(row=>Object.fromEntries(v.$boundaryNodes.columns.map((k,i)=>[k,visit(row[i])])));
  if(v.$jsonOf)return JSON.stringify(visit(at(v.$jsonOf)));
  return Array.isArray(v)?v.map(visit):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x)]));
 };return visit(input);
}
const inputOf=r=>JSON.parse(r.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n')[0]);
const expandedSchema=(s,aliases={})=>{const visit=v=>typeof v==='string'?aliases[v]??v:!v||typeof v!=='object'?v:v.$ref?visit(v.$ref.slice(2).split('/').reduce((n,k)=>n[k],s)):Array.isArray(v)?v.map(visit):Object.fromEntries(Object.entries(v).filter(([k])=>k!=='$defs').map(([k,x])=>[k,visit(x)]));return visit(s);};

test('v3 shares only identical asset facts while each design, ID and applicability stays independent',()=>{
 const raw=wire(),before=structuredClone(raw),legacy=projectProductionTransport(raw),next=projectProductionTransport(raw,{version});
 assert.deepEqual(next.input.productionMaterials[1].value.sourceFacts,{$same:'#/productionMaterials/0/value/sourceFacts'});
 assert.deepEqual(expand(next.input),before);assert.deepEqual(raw,before);
 assert.ok(JSON.stringify(next.input).length+next.hint.length<JSON.stringify(raw).length);
 assert.deepEqual(legacy.input.productionMaterials[1].value.sourceFacts,before.productionMaterials[1].value.sourceFacts,'old transport never gains new notation');
 for(const field of ['authority','quote','sourceRefs','extension']){
  const changed=wire();changed.productionMaterials[1].value.sourceFacts[0][field]=field==='sourceRefs'?['different']:'different';
  assert.ok(Array.isArray(projectProductionTransport(changed,{version}).input.productionMaterials[1].value.sourceFacts));
 }
 const marked=wire();marked.extension={$same:'#/literal-not-an-instruction'};
 assert.deepEqual(projectProductionTransport(marked,{version}),{input:marked,hint:''});
});

test('v3 references the exact prior-node list once and never merges a different boundary',()=>{
 const raw=wire(),next=projectProductionTransport(raw,{version});
 assert.deepEqual(next.input.source.context.continuity.previousSource.nodes,{$same:'#/episodeBoundary/seed/previousSource/nodes'});
 assert.deepEqual(expand(next.input),raw);
 const other=wire();other.episodeBoundary.seed.previousSource.nodes[0].sourceRange.end++;
 assert.ok(Array.isArray(projectProductionTransport(other,{version}).input.source.context.continuity.previousSource.nodes));
});
test('no new duplicate means no extra shared-transport instructions or payload growth',()=>{
 const raw=wire();delete raw.source.context;raw.productionMaterials.pop();
 raw.source.sourceRows[0].text=raw.productionMaterials[0].value.sourceFacts[0].quote;
 assert.deepEqual(projectProductionTransport(raw,{version}),projectProductionTransport(raw,{version:'production-compact-v2'}));
});

test('a local request without boundary still losslessly compacts the standalone previous-node table',()=>{
 const raw=wire();delete raw.episodeBoundary;
 const legacy=projectModelCoordinates(raw,null),next=projectModelCoordinates(raw,null,{includeContinuityNodes:true});
 assert.ok(next.input.source.context.continuity.previousSource.nodes.$boundaryNodes);
 assert.ok(Array.isArray(legacy.input.source.context.continuity.previousSource.nodes));
 assert.deepEqual(expand(next.input,next.coordinates?.aliases),raw);
 const unknown=wire();delete unknown.episodeBoundary;unknown.source.context.continuity.previousSource.nodes[0].futureField='必需保留';
 const safe=projectModelCoordinates(unknown,null,{includeContinuityNodes:true});
 assert.ok(Array.isArray(safe.input.source.context.continuity.previousSource.nodes));assert.deepEqual(expand(safe.input,safe.coordinates?.aliases),unknown);
});

test('actual buildRequest opts into v3, preserves every material and does not shorten workload timeout',()=>{
 const raw=wire(),source=parseScript('△甲接住钥匙。\n乙：（笑）这次别弄丢。',{key:'long-source-key-01234567890123456789'});
 source.context=raw.source.context;
 const payload={stage:'plan',source,settings:{model:'gpt-6.1-sol',reasoning:'medium',fantasyMode:'off',maxUnits:null,maxUnitSeconds:30},rulesSnapshot:captureRules(),productionSnapshot:{version:'production-feedback-v1',transportVersion:version,touchesOpening:true,touchesEnding:false,materials:raw.productionMaterials,episodeBoundary:raw.episodeBoundary}};
 const next=buildRequest(payload),old=buildRequest({...payload,productionSnapshot:{...payload.productionSnapshot,transportVersion:'production-compact-v2'}});
 assert.deepEqual(inputOf(next).productionMaterials[1].value.sourceFacts,{$same:'#/productionMaterials/0/value/sourceFacts'});
 assert.deepEqual(expand(inputOf(next),next.modelCoordinates?.aliases),expand(inputOf(old),old.modelCoordinates?.aliases));
 assert.deepEqual(expandedSchema(next.schema,next.modelCoordinates?.aliases),expandedSchema(old.schema,old.modelCoordinates?.aliases));
 assert.deepEqual(next.source,old.source);assert.deepEqual(next.snapshot,old.snapshot);assert.deepEqual(next.productionSnapshot.materials,old.productionSnapshot.materials);
 assert.ok(next.prompt.length+JSON.stringify(next.schema).length<old.prompt.length+JSON.stringify(old.schema).length);
 assert.ok(resolveRunnerLimits(next).totalMs>=resolveRunnerLimits(old).totalMs);
});

test('receipt repair v3 shares enum definitions, preserving the v2 contract and strict local merge',()=>{
 const source=parseScript(Array.from({length:64},(_,i)=>`△动作${i}。`).join('\n'),{key:'long-source-key-01234567890123456789'});
 const base={stage:'plan',source,productionSnapshot:{materials:[],touchesEnding:false},materialIds:[],promptHash:'p',instructionHash:'i',inputHash:'b'};
 const feedback={relation:'DIRECT',entry:[],exit:[],sharedChoices:[{key:'衣服',value:'沿用服装',authority:'INTERPRETATION',sourceRefs:[]}],usedMaterialIds:[],needs:[],conflicts:[]};
 const candidate={id:'c',output:{emotionArc:'原有情绪不可改',workPackages:[],productionFeedback:feedback}},issues=[{code:'PRODUCTION_FEEDBACK',coordinate:'productionFeedback.sharedChoices[0].authority',message:'只能DESIGN'}];
 const v1=buildFeedbackRepairRequest(base,candidate,issues),v2=buildFeedbackRepairRequest(base,candidate,issues,{version:'production-feedback-repair-v2'}),v3=buildFeedbackRepairRequest(base,candidate,issues,{version:'production-feedback-repair-v3'});
 assert.ok(v3.schema.$defs);assert.deepEqual(expandedSchema(v3.schema),v2.schema);
 assert.equal(v3.prompt,v2.prompt);assert.equal(v3.instructions,v2.instructions);
 assert.ok(JSON.stringify(v3.schema).length<JSON.stringify(v2.schema).length);
 assert.deepEqual(v1,buildFeedbackRepairRequest(base,candidate,issues,{version:'production-feedback-repair-v1'}));
 const repaired={productionFeedback:structuredClone(feedback)};repaired.productionFeedback.sharedChoices[0].authority='DESIGN';
 assert.deepEqual(mergeFeedbackRepair(repaired,candidate.output,issues),{...candidate.output,productionFeedback:repaired.productionFeedback});
 repaired.productionFeedback.sharedChoices[0].value='偷改';assert.throws(()=>mergeFeedbackRepair(repaired,candidate.output,issues),{code:'FEEDBACK_REPAIR_SCOPE'});
});
