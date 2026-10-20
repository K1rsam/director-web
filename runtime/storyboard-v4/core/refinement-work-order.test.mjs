import test from 'node:test';
import assert from 'node:assert/strict';
import {freezeDirectorRefinement,decorateDirectorRefinementRequest,assertDirectorRefinementDelta} from './director-refinement.mjs';
import {digest} from './shared.mjs';
import {DELTA_VERSION,baseDraftHash} from './delta.mjs';

const fixture=()=>({status:'text_ready_for_review',operations:[],adopted:[],source:{sourceRows:[{id:'r1',text:'父母接纳。'},{id:'r2',text:'反问未停。'},{id:'r3',text:'哦处揭开撑壳。'}]},
 plan:{events:[{id:'e1'}],workPackages:[{id:'p1'}]},rulesSnapshot:{directorRefinementVersion:'director-refinement-v2',files:{'skills/director-refinement/SKILL.md':'冻结精修规则'}},
 assembly:{validation:{errors:[]},text:'完整正文',draft:{schemaVersion:'performance-core-v4',fantasyRealization:[],units:['u1','u2','u3'].map((id,i)=>({id,eventId:'e1',title:id,shots:[{id:`s${i+1}`,sourceRefs:[`r${i+1}`],picture:'不变画面'}]}))}}});
const freeze=(d,options={})=>freezeDirectorRefinement(d,['p1'],['e1'],options);
const unchanged=d=>({schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(d.assembly.draft),retainedUnitIds:['u1','u2','u3'],replacements:[],revisionNotes:[],unresolved:[]});

test('a v2 work order freezes continuous complete units and short source anchors without changing the accepted draft',()=>{
 const d=fixture(),before=structuredClone(d),r=freeze(d,{unitIds:['u2','u3'],reviewNotes:'反问摊慢；揭示缺少观看发现',preserveNotes:'保留听者反应与真实威胁'});
 assert.deepEqual(r.unitIds,['u2','u3']);assert.equal(r.workOrder.reviewNotes,'反问摊慢；揭示缺少观看发现');
 assert.equal(r.scope.wholeEpisode,false);assert.equal(r.scope.unitCount,2);assert.equal(r.scope.sourceStart.id,'r2');assert.equal(r.scope.sourceEnd.id,'r3');assert.deepEqual(d,before);
});
test('whole-episode selection is honestly labelled rather than advertised as a small local range',()=>{
 const r=freeze(fixture());assert.equal(r.scope.wholeEpisode,true);assert.equal(r.scope.shotCount,3);assert.deepEqual(r.unitIds,['u1','u2','u3']);
});
test('noncontinuous, missing, duplicate or empty unit selection is rejected before any request',()=>{
 for(const unitIds of [['u1','u3'],['missing'],['u2','u2'],[]])assert.throws(()=>freeze(fixture(),{unitIds}),e=>e.code==='REFINEMENT_SCOPE');
});
test('a cross-unit fantasy cannot be silently cut or expanded beyond the user selection',()=>{
 const d=fixture();d.assembly.draft.fantasyRealization=[{candidateId:'f',unitIds:['u2','u3']}];
 assert.throws(()=>freeze(d,{unitIds:['u2']}),e=>e.code==='REFINEMENT_SCOPE');
 assert.deepEqual(freeze(d,{unitIds:['u2','u3']}).unitIds,['u2','u3']);
});
test('v2 explicitly accounts for kept, changed or unresolved decisions; empty all-retained is not an explained refinement',()=>{
 const d=fixture(),r=freeze(d,{unitIds:['u2','u3']}),delta=unchanged(d);
 assert.throws(()=>assertDirectorRefinementDelta(d.assembly.draft,delta,r),e=>e.code==='REFINEMENT_REVIEW');
 delta.reviewDecisions=[{unitIds:['u2','u3'],disposition:'retained',reason:'两者的慢说与揭示用于真实压迫，尚无更强且守源方案',preservedFunction:'保留听者反应和现实威胁'}];
 assert.doesNotThrow(()=>assertDirectorRefinementDelta(d.assembly.draft,delta,r));
 delta.reviewDecisions[0].reason='';assert.throws(()=>assertDirectorRefinementDelta(d.assembly.draft,delta,r),e=>e.code==='REFINEMENT_REVIEW');
});
test('outside-unit replacement and claiming change while retaining the unit both fail closed',()=>{
 const d=fixture(),r=freeze(d,{unitIds:['u2']}),delta=unchanged(d);
 delta.retainedUnitIds=['u2','u3'];delta.replacements=[{replaces:['u1'],units:[structuredClone(d.assembly.draft.units[0])],fantasyRealization:[]}];
 assert.throws(()=>assertDirectorRefinementDelta(d.assembly.draft,delta,r),e=>e.code==='REFINEMENT_SCOPE');
 const kept=unchanged(d);kept.reviewDecisions=[{unitIds:['u2'],disposition:'changed',reason:'假称已增强',preservedFunction:'原话'}];
 assert.throws(()=>assertDirectorRefinementDelta(d.assembly.draft,kept,r),e=>e.code==='REFINEMENT_REVIEW');
});
test('the work order uses the same compact coordinates and does not duplicate source or old draft text',()=>{
 const d=fixture(),r=freeze(d,{unitIds:['u2'],reviewNotes:'收紧反问',preserveNotes:'保留切听者'});
 const request={stage:'finish',finishMode:'delta',baseDraftHash:r.baseDraftHash,prompt:'existing input',inputHash:'input',snapshot:[],loadedFiles:[],modelCoordinates:{aliases:{R001:'e1',R002:'u2'}}};
 const result=decorateDirectorRefinementRequest(request,r);
 assert.match(result.prompt,/reviewDecisions/);assert.ok(result.schema.required.includes('reviewDecisions'));
 const contract=JSON.parse(result.prompt.split('【本次精修边界】\n')[1].split('\n')[0]);
 assert.deepEqual(contract.unitIds,['R002']);assert.equal(contract.workOrder.reviewNotes,'收紧反问');assert.doesNotMatch(JSON.stringify(contract),/反问未停。/);
 assert.equal(result.schemaHash,digest(result.schema));
});
test('legacy v1 keeps the frozen request protocol and cannot acquire new work-order rules during recovery',()=>{
 const d=fixture();d.rulesSnapshot.directorRefinementVersion='director-refinement-v1';const r=freeze(d);
 assert.equal(r.version,'director-refinement-v1');assert.equal(r.unitIds,undefined);assert.equal(r.workOrder,undefined);
 assert.doesNotThrow(()=>assertDirectorRefinementDelta(d.assembly.draft,unchanged(d),r));
 assert.throws(()=>freeze(d,{unitIds:['u2']}),e=>e.code==='REFINEMENT_RULES');
});
