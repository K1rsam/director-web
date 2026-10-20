import test from 'node:test';
import assert from 'node:assert/strict';
import {baseDraftHash,applyDelta,DELTA_VERSION} from './delta.mjs';
import {digest} from './shared.mjs';
import {LEGACY_FEEDBACK_RESULT_VERSION,FEEDBACK_RESULT_VERSION,freezeFeedbackBasis,projectResultFeedback,effectiveProductionFeedback,feedbackMaterialConsumers,feedbackResultSchema} from './production-feedback-result.mjs';

const state=(key,value)=>({key,value,authority:'SOURCE',sourceRefs:['s1']});
const feedback=(exit=[],usedMaterialIds=[])=>({relation:'DIRECT',entry:[],exit,sharedChoices:[],usedMaterialIds,needs:[],conflicts:[]});
const unit=(id,picture)=>({id,initialState:'仍握住钥匙',exitState:'仍握住钥匙',shots:[{id:`${id}-s1`,picture,lighting:'手掌遮影保持',sourceRefs:['s1']}]});
const draft={schemaVersion:'performance-core-v4',units:[unit('u1','乙守在门口'),unit('u2','甲继续按住颈侧')],fantasyRealization:[]};
function fixture(){
 const base={id:'base',attemptId:'a1',stage:'finish',packageIds:['p1'],status:'adopted',draft:structuredClone(draft),productionFeedback:feedback([state('bridge/weight','仍承重'),state('army/location','仍在近岸')],['asset:bridge','source:previous'])};
 const run={adopted:[{candidateId:'base',packageIds:['p1'],draft:structuredClone(draft)}],candidates:[base],operations:[{attemptId:'a1',productionSnapshot:{touchesEnding:true,materials:[{id:'asset:bridge',version:'v1'},{id:'source:previous',version:'v1'}]}}]};
 const basis=freezeFeedbackBasis(run,draft,['p1'],{touchesEnding:true,version:LEGACY_FEEDBACK_RESULT_VERSION});
 const previousDraft={...structuredClone(draft),feedbackBasis:basis};
 const output={schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(draft),retainedUnitIds:['u1'],replacements:[{replaces:['u2'],units:[unit('u2','甲手掌保持不动，按住颈侧干血')],fantasyRealization:[]}]};
 const next=applyDelta(previousDraft,output);
 const request={stage:'finish',finishMode:'delta',previousDraft,productionSnapshot:{feedbackResultVersion:LEGACY_FEEDBACK_RESULT_VERSION,touchesEnding:true}};
 const raw={...feedback([state('hand/neck','保持按住')]),resultRevision:{baseSignature:basis.signature,exitDecisions:basis.exit.map(s=>({key:s.key,decision:'KEEP',replacementKey:'',reason:'尾镜仍保持，局部只改手掌动作',evidence:[{unitId:'u2',shotId:'u2-s1',field:'picture',quote:'按住颈侧干血'}]})),materialDecisions:basis.materialIds.map(id=>({id,decision:'KEEP',reason:'保留正文仍由原材料支持'}))},entryEvidence:[]};
 return {run,basis,previousDraft,output,next,request,raw};
}
const project=f=>projectResultFeedback({request:f.request,feedback:f.raw,draft:f.next,delta:f.output,candidateId:'repair',attemptId:'a2',packageIds:['p1'],factRefs:f.factRefs});

test('R1 local delta keeps complete effective exits and original material consumers, never rewrites native receipt',()=>{
 const f=fixture(),before=structuredClone(f),projection=project(f);
 const c={id:'repair',attemptId:'a2',packageIds:['p1'],productionFeedback:f.raw,draft:f.next,feedbackProjection:projection};
 assert.deepEqual(effectiveProductionFeedback(c).exit.map(s=>s.key),['bridge/weight','army/location','hand/neck']);
 assert.deepEqual(f.raw.usedMaterialIds,[]);
 assert.deepEqual(feedbackMaterialConsumers(c),[{candidateId:'base',attemptId:'a1',packageIds:['p1'],unitIds:['u1','u2'],materialIds:['asset:bridge','source:previous'],supportUnitIds:['u1','u2']}]);
 assert.deepEqual(f,before);assert.deepEqual(project(f),projection,'recovery/recheck is deterministic');
});
test('explicit alias replacement retires old exit, but missing decisions and wrong basis fail closed',()=>{
 const f=fixture();f.raw.resultRevision.exitDecisions[0]={...f.raw.resultRevision.exitDecisions[0],decision:'REPLACE',replacementKey:'hand/neck'};
 assert.deepEqual(project(f).exit.map(s=>s.key),['hand/neck','army/location']);
 f.raw.exit.push(state('bridge/weight','已失效'));assert.throws(()=>project(f),{code:'PRODUCTION_FEEDBACK_RESULT'});
 const missing=fixture();missing.raw.resultRevision.exitDecisions.pop();assert.throws(()=>project(missing),{code:'PRODUCTION_FEEDBACK_RESULT'});
 const wrong=fixture();wrong.request.previousDraft.feedbackBasis.draftHash='old';assert.throws(()=>project(wrong),{code:'PRODUCTION_FEEDBACK_RESULT'});
 const stale=fixture();stale.raw.resultRevision.baseSignature='different';assert.throws(()=>project(stale),{code:'PRODUCTION_FEEDBACK_RESULT'});
 const fake=fixture();fake.raw.resultRevision.exitDecisions[0].evidence[0].quote='已松开';assert.throws(()=>project(fake),{code:'PRODUCTION_FEEDBACK_RESULT'});
});
test('material removal needs an explicit decision and cannot discard consumers of an unchanged unit',()=>{
 const f=fixture();f.raw.resultRevision.materialDecisions[0].decision='REMOVE';assert.throws(()=>project(f),{code:'PRODUCTION_FEEDBACK_RESULT'});
 f.next.units=f.next.units.map(u=>({...u,exitState:'已经离场'}));
 assert.deepEqual(project(f).materialConsumers[0].materialIds,['source:previous']);
});
test('legacy receipts stay native; unknown lineage and raw hash drift never invent a generic projection',()=>{
 const f=fixture(),legacy={productionFeedback:f.raw,draft:f.next};assert.equal(effectiveProductionFeedback(legacy),f.raw);
 const c={...legacy,feedbackProjection:project(f)};c.productionFeedback={...c.productionFeedback,exit:[]};
 assert.throws(()=>effectiveProductionFeedback(c),{code:'PRODUCTION_FEEDBACK_RESULT'});
 f.run.adopted[0].draft.units[0].exitState='changed';assert.throws(()=>freezeFeedbackBasis(f.run,draft,['p1']),{code:'PRODUCTION_FEEDBACK_RESULT'});
 assert.equal(digest(f.raw),digest(f.raw));
});
test('local opening scope must not inherit the episode tail merely because transport candidate IDs are shared',()=>{
 const f=fixture(),shared=f.run.candidates[0];
 f.run.adopted=[{candidateId:shared.id,packageIds:['p1'],draft:{...draft,units:[draft.units[0]]}},{candidateId:shared.id,packageIds:['p2'],draft:{...draft,units:[draft.units[1]]}}];
 const local={...draft,units:[draft.units[0]]};
 assert.deepEqual(freezeFeedbackBasis(f.run,local,['p1'],{touchesEnding:false}).exit,[]);
});
test('explicit material REPLACE retires the old consumer generation and binds the same ID to the new snapshot',()=>{
 const f=fixture();f.raw.usedMaterialIds=['asset:bridge'];f.raw.resultRevision.materialDecisions[0].decision='REPLACE';
 const p=project(f);
 assert.deepEqual(p.materialConsumers.filter(c=>c.materialIds.includes('asset:bridge')).map(c=>c.attemptId),['a2']);
 assert.deepEqual(p.materialConsumers.find(c=>c.attemptId==='a1').materialIds,['source:previous']);
});
test('renaming units cannot make the next unchanged delta forget a still-supported material',()=>{
 const f=fixture();f.output.retainedUnitIds=[];f.output.replacements=[{replaces:['u1','u2'],units:[unit('u1-new','乙守在门口'),unit('u2-new','甲继续按住颈侧干血')],fantasyRealization:[]}];f.next=applyDelta(f.previousDraft,f.output);
 for(const decision of f.raw.resultRevision.exitDecisions)decision.evidence=[{unitId:'u2-new',shotId:'u2-new-s1',field:'picture',quote:'按住颈侧干血'}];
 const first={id:'repair',attemptId:'a2',status:'adopted',stage:'finish',packageIds:['p1'],draft:f.next,productionFeedback:f.raw,feedbackProjection:project(f)};
 const run={...f.run,adopted:[{candidateId:first.id,packageIds:['p1'],draft:f.next}],candidates:[...f.run.candidates,first],operations:[...f.run.operations,{attemptId:'a2',productionSnapshot:{touchesEnding:true,materials:[]}}]};
 const basis=freezeFeedbackBasis(run,f.next,['p1'],{touchesEnding:true,version:LEGACY_FEEDBACK_RESULT_VERSION});
 const nextRaw={...feedback(),resultRevision:{baseSignature:basis.signature,exitDecisions:basis.exit.map(s=>({key:s.key,decision:'KEEP',replacementKey:'',reason:'正文完全未改',evidence:[{unitId:'u2-new',shotId:'u2-new-s1',field:'picture',quote:'按住颈侧干血'}]})),materialDecisions:basis.materialIds.map(id=>({id,decision:id==='asset:bridge'?'REMOVE':'KEEP',reason:'不得因改名漏掉依赖'}))},entryEvidence:[]};
 const request={...f.request,previousDraft:{...f.next,feedbackBasis:basis}};
 const delta={schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(f.next),retainedUnitIds:f.next.units.map(u=>u.id),replacements:[]};
 assert.throws(()=>projectResultFeedback({request,feedback:nextRaw,draft:f.next,delta,candidateId:'again',attemptId:'a3',packageIds:['p1']}),{code:'PRODUCTION_FEEDBACK_RESULT'});
});
test('split adopted scopes sharing one original consumer cannot overwrite each other material support',()=>{
 const f=fixture(),old=f.run.candidates[0];old.packageIds=['p1','p2'];
 f.run.adopted=[{candidateId:old.id,packageIds:['p1'],draft:{...draft,units:[draft.units[0]]}},{candidateId:old.id,packageIds:['p2'],draft:{...draft,units:[draft.units[1]]}}];
 const localBase={...draft,units:[draft.units[0]]},basis=freezeFeedbackBasis(f.run,localBase,['p1']);
 const local={...draft,units:[unit('u1-new','改动后的本包正文')]};
 const raw={...feedback(),entryEvidence:[],resultRevision:{baseSignature:basis.signature,exitDecisions:[],materialDecisions:basis.materialIds.map(id=>({id,decision:id==='source:previous'?'REMOVE':'KEEP',reason:'本包已不使用前源，另一包仍使用'}))}};
 const current={id:'local',attemptId:'a2',stage:'finish',packageIds:['p1'],status:'adopted',draft:local,productionFeedback:raw};
 current.feedbackProjection=projectResultFeedback({request:{stage:'finish',finishMode:'full',previousDraft:{...localBase,feedbackBasis:basis},productionSnapshot:{feedbackResultVersion:FEEDBACK_RESULT_VERSION}},feedback:raw,draft:local,candidateId:'local',attemptId:'a2',packageIds:['p1']});
 f.run.candidates.push(current);f.run.operations.push({attemptId:'a2',productionSnapshot:{touchesEnding:false,materials:[]}});
 f.run.adopted=[f.run.adopted[1],{candidateId:'local',packageIds:['p1'],draft:local}];
 const whole={...draft,units:[...local.units,draft.units[1]]},next=freezeFeedbackBasis(f.run,whole,['p1','p2'],{touchesEnding:true});
 assert.deepEqual(new Set(next.materialIds),new Set(['asset:bridge','source:previous']));
 assert.deepEqual(next.materialConsumers.find(c=>c.materialIds.includes('source:previous')).supportUnitIds,['u2']);
});
test('renaming a supported unit back to its original ID cannot leave stale intermediate support',()=>{
 const f=fixture();
 // Build real sealed bases rather than modifying a signed historical record.
 const base={schemaVersion:draft.schemaVersion,units:[unit('u1','原稿')],fantasyRealization:[]};
 f.run.adopted[0].draft=base;f.run.candidates[0].draft=base;f.run.candidates[0].productionFeedback=feedback([],['asset:bridge']);
 let run=f.run,previous=base;
 for(const [i,id] of ['u1-new','u1'].entries()){
  const basis=freezeFeedbackBasis(run,previous,['p1']),next={...base,units:[unit(id,`第${i+1}次改稿`)]};
  const raw={...feedback(),entryEvidence:[],resultRevision:{baseSignature:basis.signature,exitDecisions:[],materialDecisions:[{id:'asset:bridge',decision:'KEEP',reason:'仍然使用'}]}};
  const c={id:`c${i}`,attemptId:`r${i}`,stage:'finish',packageIds:['p1'],status:'adopted',draft:next,productionFeedback:raw};
  c.feedbackProjection=projectResultFeedback({request:{stage:'finish',finishMode:'full',previousDraft:{...previous,feedbackBasis:basis},productionSnapshot:{feedbackResultVersion:FEEDBACK_RESULT_VERSION}},feedback:raw,draft:next,candidateId:c.id,attemptId:c.attemptId,packageIds:['p1']});
  run={...run,candidates:[...run.candidates,c],operations:[...run.operations,{attemptId:c.attemptId,productionSnapshot:{materials:[]}}],adopted:[{candidateId:c.id,packageIds:['p1'],draft:next}]};previous=next;
 }
 assert.deepEqual(freezeFeedbackBasis(run,previous,['p1']).materialIds,['asset:bridge']);
});

const v1='production-feedback-result-v1',v2='production-feedback-result-v2';
function versionedFixture(version=v2){
 const f=fixture();
 f.basis=freezeFeedbackBasis(f.run,draft,['p1'],{touchesEnding:true,version});
 f.previousDraft.feedbackBasis=f.basis;f.request.productionSnapshot.feedbackResultVersion=version;
 f.request.source={sourceRows:[{id:'s1',kind:'action',text:'桥面仍承重。'},{id:'s2',kind:'action',text:'桥面保持稳定。'},{id:'spoken',kind:'dialogue',text:'桥面稳定。'},{id:'note',kind:'guidance',evidenceRole:'guidance',text:'只作参考。'}],contextRows:[],dialogue:[{sourceIds:['spoken']}]};
 f.raw.resultRevision.baseSignature=f.basis.signature;
 if(version===v2){
  f.next.units.at(-1).exitState='桥面仍承重；军队仍在近岸。';
  for(const row of f.raw.resultRevision.exitDecisions){row.continuation=[];row.evidence=[{unitId:'u2',shotId:'',field:'exitState',quote:f.basis.exit.find(s=>s.key===row.key).value}];}
 }
 return f;
}
function continuedFixture(){
 const f=versionedFixture();
 for(const base of [f.run.adopted[0].draft,f.run.candidates[0].draft,f.previousDraft])base.units[0].shots[0].picture='桥面仍承重，乙守在门口。';
 f.run.candidates[0].productionFeedback.exit=f.run.candidates[0].productionFeedback.exit.slice(0,1);
 f.basis=freezeFeedbackBasis(f.run,f.previousDraft,['p1'],{touchesEnding:true,version:v2});
 f.previousDraft.feedbackBasis=f.basis;f.raw.resultRevision.baseSignature=f.basis.signature;
 f.output.baseDraftHash=baseDraftHash(f.previousDraft);
 f.raw.resultRevision.exitDecisions=f.raw.resultRevision.exitDecisions.slice(0,1);
 const second={...unit('u2','甲手掌保持不动，按住颈侧干血'),exitState:'桥面仍承重。'};
 const third={...unit('u3','众人从桥头转向门口'),exitState:'桥面仍承重。'};
 f.output.replacements[0].units=[second,third];f.next=applyDelta(f.previousDraft,f.output);
 for(const row of f.raw.resultRevision.exitDecisions)row.evidence=[{unitId:'u3',shotId:'',field:'exitState',quote:'桥面仍承重'}];
 const row=f.raw.resultRevision.exitDecisions[0];
 row.evidence=[{unitId:'u1',shotId:'u1-s1',field:'picture',quote:'桥面仍承重'}];
 row.continuation=['u2','u3'].map(unitId=>({unitId,key:'bridge/weight',value:'仍承重',authority:'SOURCE',verdict:'CONTINUES',reason:'本单元的离开状态明确保持同一桥面承重状态。',evidence:[{unitId,shotId:'',field:'exitState',quote:'桥面仍承重'}]}));
 return f;
}

test('v2 KEEP accepts only additive factual provenance and preserves the paid receipt and old basis',()=>{
 const f=versionedFixture();f.raw.exit.push({...f.basis.exit[0],sourceRefs:['s1','s2']});
 const before=structuredClone(f),projection=project(f);
 assert.ok(projection,'new v2 result projection must be produced');
 assert.deepEqual(projection.exit.find(s=>s.key==='bridge/weight').sourceRefs,['s1','s2']);
 assert.deepEqual(f,before,'derived evidence must never edit a native receipt or a signed basis');
 assert.equal(effectiveProductionFeedback({productionFeedback:f.raw,draft:f.next,feedbackProjection:projection}).exit[0].value,'仍承重');
});

test('v2 KEEP rejects semantic changes, provenance removal, duplicate and nonfactual additions',()=>{
 const changes=[
  s=>{s.value='已经坍塌';},s=>{s.authority='DESIGN';},s=>{s.extra='new meaning';},
  s=>{s.sourceRefs=['s2'];},s=>{s.sourceRefs=['s1','s2','s2'];},
  s=>{s.sourceRefs=['s1','missing'];},s=>{s.sourceRefs=['s1','spoken'];},s=>{s.sourceRefs=['s1','note'];}
 ];
 for(const change of changes){const f=versionedFixture(),next={...f.basis.exit[0],sourceRefs:['s1','s2']};change(next);f.raw.exit.push(next);assert.throws(()=>project(f),{code:'PRODUCTION_FEEDBACK_RESULT'});}
});

test('v2 earlier KEEP proof needs an ordered same-state continuation through every later unit',()=>{
 const f=continuedFixture(),before=structuredClone(f),projection=project(f);
 assert.ok(projection,'complete continuation permits an earlier exact quote');
 assert.deepEqual(projection.exit.find(s=>s.key==='bridge/weight'),f.basis.exit[0]);assert.deepEqual(f,before);
});

test('v2 continuation fails closed on changed, unknown, missing, foreign or contradictory evidence',()=>{
 const changes=[
  f=>{f.raw.resultRevision.exitDecisions[0].continuation[0].verdict='CHANGED';},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation[0].verdict='UNKNOWN';},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation.pop();},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation.shift();},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation.reverse();},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation[0].unitId='missing';},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation[0].key='army/location';},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation[0].value='已经坍塌';},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation[0].authority='DESIGN';},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation[0].evidence[0].unitId='u3';},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation[0].evidence[0].quote='没有展示所以必然保持';},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation[0].evidence=[{unitId:'u2',shotId:'u2-s1',field:'picture',quote:'按住颈侧干血'}];},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation[0].evidence[0].quote='桥面';},
  f=>{f.raw.resultRevision.exitDecisions[0].continuation[0].evidence=[];},
  f=>{delete f.raw.resultRevision.exitDecisions[0].continuation;},
  f=>{f.raw.conflicts.push({key:'bridge/weight',problem:'桥面真实断裂',sourceRefs:['s2']});},
  f=>{f.raw.resultRevision.exitDecisions[0].decision='REMOVE';},
  f=>{f.raw.resultRevision.exitDecisions[0].decision='REPLACE';f.raw.resultRevision.exitDecisions[0].replacementKey='hand/neck';}
 ];
 for(const change of changes){const f=continuedFixture();change(f);assert.throws(()=>project(f),{code:'PRODUCTION_FEEDBACK_RESULT'});}
});

test('v1 preserves exact-state KEEP and final-unit-only rejection under the new receiver',()=>{
 const f=versionedFixture(v1),plain=project(f);assert.equal(plain.version,v1);
 const provenance=versionedFixture(v1);provenance.raw.exit.push({...provenance.basis.exit[0],sourceRefs:['s1','s2']});assert.throws(()=>project(provenance),{code:'PRODUCTION_FEEDBACK_RESULT'});
 const earlier=versionedFixture(v1);earlier.raw.resultRevision.exitDecisions[0].evidence=[{unitId:'u1',shotId:'u1-s1',field:'picture',quote:'乙守在门口'}];assert.throws(()=>project(earlier),{code:'PRODUCTION_FEEDBACK_RESULT'});
 assert.deepEqual(effectiveProductionFeedback({productionFeedback:f.raw,draft:f.next,feedbackProjection:plain}).exit,plain.exit);
});

test('v2 schema asks for typed same-state continuation without changing the v1 schema',()=>{
 const current=feedbackResultSchema({version:v2}).resultRevision.properties.exitDecisions.items.properties;
 assert.ok(current.continuation,'new requests must ask the existing finishing call for continuation evidence');
 assert.deepEqual(current.continuation.items.properties.verdict.enum,['CONTINUES','CHANGED','UNKNOWN']);
 assert.equal(feedbackResultSchema({version:v1}).resultRevision.properties.exitDecisions.items.properties.continuation,undefined);
});

test('v2 provenance accepts a canonical boundary fact set but cannot trust an unknown source by default',()=>{
 const f=versionedFixture();f.raw.exit.push({...f.basis.exit[0],sourceRefs:['s1','boundary:1:action-1']});
 assert.throws(()=>project(f),{code:'PRODUCTION_FEEDBACK_RESULT'});
 f.factRefs=new Set(['s1','boundary:1:action-1']);assert.equal(project(f).exit.find(s=>s.key==='bridge/weight').sourceRefs[1],'boundary:1:action-1');
});

test('basis and projection keep their frozen version and signed identities',()=>{
 const legacy=versionedFixture(v1),projection=project(legacy),candidate={productionFeedback:legacy.raw,draft:legacy.next,feedbackProjection:projection};
 const before=digest(candidate);assert.deepEqual(effectiveProductionFeedback(candidate).exit,projection.exit);assert.equal(digest(candidate),before);
 const mismatched=versionedFixture(v2);mismatched.request.productionSnapshot.feedbackResultVersion=v1;assert.throws(()=>project(mismatched),{code:'PRODUCTION_FEEDBACK_RESULT'});
 const changed=structuredClone(candidate);changed.feedbackProjection.version=v2;assert.throws(()=>effectiveProductionFeedback(changed),{code:'PRODUCTION_FEEDBACK_RESULT'});
 assert.throws(()=>freezeFeedbackBasis(legacy.run,draft,['p1'],{version:'future'}),{code:'PRODUCTION_FEEDBACK_RESULT'});
});
