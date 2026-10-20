import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createUnversionedProductionCoordinator as createCoordinator} from './storyboard-v4/core/legacy-test-fixtures.mjs';
import {createStore} from './storyboard-v4/core/store.mjs';
import {tailFixture,tailDraft} from './storyboard-v4/core/author-call-group-test-fixtures.mjs';
import {DELTA_VERSION} from './storyboard-v4/core/delta.mjs';
import {makeBoundaryContext,validateProductionFeedback,productionFeedbackSchema} from './episode-boundary.mjs';
import {mergeFeedbackRepair,buildFeedbackRepairRequest,repairControl} from './feedback-repair.mjs';
import {publicRun} from './storyboard-v4/input.mjs';
import {buildRequest} from './storyboard-v4/core/core.mjs';

const feedback=()=>({relation:'DIRECT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]});
const usage={inputTokens:80,outputTokens:20,totalTokens:100,cachedInputTokens:0};
const production=()=>({materials:[],boundary:null});
async function fixture(fn,reply){
 const directory=await mkdtemp(path.join(tmpdir(),'production-local-repair-')),seen=[],f=tailFixture();
 const c=createCoordinator({dataRoot:directory,modelRunner:async r=>{seen.push(r);const output=reply(r,seen.length,f);return {output,raw:JSON.stringify(output),usage,requestOutcome:'RESPONDED'};}});
 try{const d=await c.create({source:f.source,settings:f.settings,production:production(),binding:{projectId:'test',episodeId:'e',sourceVersion:'v1'}});await fn({c,d,seen,f,store:createStore(directory)});}finally{await c.shutdown();await rm(directory,{recursive:true,force:true});}
}
const planReply=(r,_n,f)=>({...f.plan,productionFeedback:{...feedback(),entry:[{key:'place',value:'走廊',authority:'SOURCE',sourceRefs:['missing']}]}});
test('one invalid array item cannot authorize overwriting valid neighbouring receipts or material use',()=>{
 const original={productionFeedback:{...feedback(),entry:[{key:'bad',value:'待定位',authority:'INTERPRETATION',sourceRefs:[]},{key:'valid',value:'甲',authority:'DESIGN',sourceRefs:[]}],usedMaterialIds:['missing','asset:CH01']}};
 const removed={productionFeedback:structuredClone(original.productionFeedback)};removed.productionFeedback.usedMaterialIds=[];
 assert.throws(()=>mergeFeedbackRepair(removed,original,[{coordinate:'productionFeedback.usedMaterialIds[0]'}]),{code:'FEEDBACK_REPAIR_SCOPE'});
 const neighbour={productionFeedback:structuredClone(original.productionFeedback)};neighbour.productionFeedback.entry[1].value='乙';
 assert.throws(()=>mergeFeedbackRepair(neighbour,original,[{coordinate:'productionFeedback.entry[0]'}]),{code:'FEEDBACK_REPAIR_SCOPE'});
 const valid={productionFeedback:structuredClone(original.productionFeedback)};valid.productionFeedback.usedMaterialIds=['asset:CH01'];
 assert.deepEqual(mergeFeedbackRepair(valid,original,[{coordinate:'productionFeedback.usedMaterialIds[0]'}]).productionFeedback.usedMaterialIds,['asset:CH01']);
});
test('SOURCE receipt errors identify the exact field and illegal coordinate',()=>{
 assert.throws(()=>validateProductionFeedback(planReply(null,1,tailFixture()).productionFeedback,{source:tailFixture().source,materialIds:[]}),e=>e.code==='PRODUCTION_FEEDBACK'&&e.coordinate==='productionFeedback.entry[0].sourceRefs[0]'&&e.message.includes('missing'));
});
test('shared choice classification errors point to the authority, not the whole receipt',()=>{
 const raw={...feedback(),sharedChoices:[{key:'clothing',value:'本集沿用离场时服装状态',authority:'INTERPRETATION',sourceRefs:[]}]};
 assert.throws(()=>validateProductionFeedback(raw,{source:tailFixture().source,materialIds:[]}),e=>e.code==='PRODUCTION_FEEDBACK'&&e.coordinate==='productionFeedback.sharedChoices[0].authority'&&e.message.includes('DESIGN'));
});
test('repair admission stays stopped after free recheck of the same precise error or exhausted retries',()=>{
 const errors=[{code:'PRODUCTION_FEEDBACK',coordinate:'productionFeedback.sharedChoices[0].authority',message:'必须DESIGN'}];
 const d={candidates:[{id:'c',attemptId:'a',status:'needs_repair',output:{},errors,productionFeedbackValidationVersion:'production-feedback-coordinate-v2'}],operations:[{attemptId:'a',issues:errors}],web:{autoRepairs:1}};
 assert.deepEqual(repairControl(d),{blocked:true,needsRecheck:false,reason:'NO_PROGRESS'});
 delete d.candidates[0].productionFeedbackValidationVersion;
 assert.deepEqual(repairControl(d),{blocked:false,needsRecheck:true,reason:null});
 d.web.autoRepairs=2;assert.deepEqual(repairControl(d),{blocked:true,needsRecheck:true,reason:'LIMIT'});
});
test('new shared-choice schema accepts design only while the historical schema remains unchanged',()=>{
 const input={source:tailFixture().source,strictAuthorities:true};
 const legacy=productionFeedbackSchema(input),current=productionFeedbackSchema({...input,designOnlySharedChoices:true});
 assert.deepEqual(current.properties.sharedChoices.items.properties.authority.enum,['DESIGN']);
 assert.deepEqual(current.properties.entry,legacy.properties.entry);
 assert.deepEqual(legacy.properties.sharedChoices.items,legacy.properties.entry.items,'historical frozen requests must still reconstruct');
});
test('new production requests freeze the design contract; old snapshots keep the historical output shape',async()=>fixture(async({c,d,seen,f})=>{
 await c.start(d.id,{mode:'next'});await c.wait(d.id);const saved=await c.read(d.id),r=seen[0];
 const resolve=(schema,node)=>node?.$ref?resolve(schema,node.$ref.slice(2).split('/').reduce((v,k)=>v[k],schema)):node;
 const choices=schema=>resolve(schema,resolve(schema,schema.properties.productionFeedback).properties.sharedChoices.items);
 assert.equal(r.productionSnapshot.feedbackContractVersion,'production-feedback-design-v2');
 assert.deepEqual(choices(r.schema).properties.authority.enum,['DESIGN']);
 const legacy=structuredClone(r.productionSnapshot);delete legacy.feedbackContractVersion;
 const old=buildRequest({stage:'plan',source:f.source,settings:saved.settings,rulesSnapshot:saved.rulesSnapshot,productionSnapshot:legacy});
 assert.ok(choices(old.schema).anyOf,'legacy frozen requests must not acquire a new output constraint');
},planReply));
test('new receipt repair clarifies shared choices without changing the legacy request',async()=>fixture(async({c,d,seen})=>{
 await c.start(d.id,{mode:'next'});await c.wait(d.id);const candidate=(await c.read(d.id)).candidates[0],base=seen[0],issues=candidate.errors;
 const old=buildFeedbackRepairRequest(base,candidate,issues),v1=buildFeedbackRepairRequest(base,candidate,issues,{version:'production-feedback-repair-v1'});
 assert.deepEqual(old,v1);
 const v2=buildFeedbackRepairRequest(base,candidate,issues,{version:'production-feedback-repair-v2'});
 assert.equal(v2.feedbackRepair.version,'production-feedback-repair-v2');
 assert.deepEqual(v2.schema.properties.productionFeedback.properties.sharedChoices.items.properties.authority.enum,['DESIGN']);
 assert.ok(v2.prompt.includes('sharedChoices')&&v2.prompt.includes('不能仅为通过校验'));
},planReply));
test('one continuous start repairs a local receipt with v3 and completes without another click',async()=>fixture(async({c,d,seen})=>{
 await c.start(d.id,{mode:'all'});await c.wait(d.id);const saved=await c.read(d.id);
 assert.equal(saved.status,'text_ready_for_review',JSON.stringify(saved.web));
 const repairs=seen.filter(r=>r.feedbackRepair);assert.equal(repairs.length,1);
 assert.equal(repairs[0].feedbackRepair.version,'production-feedback-repair-v3');
 assert.ok(seen.filter(r=>!r.feedbackRepair).every(r=>r.productionSnapshot.transportVersion===d.rulesSnapshot.productionTransportVersion),'正文请求沿用任务冻结的传输版本，回执v3不把新版正文回退到旧传输');
 assert.deepEqual(seen.map(r=>r.feedbackRepair?'receipt':r.stage),['plan','receipt','author','author','finish']);
 assert.equal(saved.web.autoRepairs,1);
},(r,n,f)=>{
 const sharedChoices=[{key:'clothing',value:'沿用既有服装',authority:n===1?'INTERPRETATION':'DESIGN',sourceRefs:[]}];
 if(r.feedbackRepair)return {productionFeedback:{...feedback(),sharedChoices}};
 if(r.stage==='plan')return {...f.plan,productionFeedback:{...feedback(),sharedChoices}};
 if(r.finishMode==='delta'){
  const input=JSON.parse(r.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n')[0]);
  return {schemaVersion:DELTA_VERSION,baseDraftHash:r.baseDraftHash,retainedUnitIds:input.previousDraft.units.map(u=>u.id),replacements:[],revisionNotes:[],unresolved:[],productionFeedback:feedback()};
 }
 return {...tailDraft(r),productionFeedback:feedback()};
}));
test('old generic receipt diagnostics are rechecked for free before a precise local repair',async()=>fixture(async({c,d,seen,store,f})=>{
 await c.start(d.id,{mode:'next'});await c.wait(d.id);
 await store.update(d.id,x=>{const candidate=x.candidates.at(-1);candidate.errors=[{code:'PRODUCTION_FEEDBACK',coordinate:'productionFeedback',message:'字段或类型不完整'}];delete candidate.productionFeedbackValidationVersion;return x;});
 const before=await c.read(d.id);await c.start(d.id,{mode:'next'});await c.wait(d.id);const after=await c.read(d.id);
 assert.equal(seen.length,2);assert.equal(after.operations.length,2,'recheck has no model operation');
 assert.ok(after.candidates.some(x=>x.derivedFrom===before.candidates[0].id&&!x.feedbackMerged),'a free derived diagnostic retains the old candidate');
 assert.equal(after.operations.at(-1).issues[0].coordinate,'productionFeedback.sharedChoices[0].authority');
 assert.equal(after.candidates.at(-1).status,'adopted');
 assert.deepEqual(after.candidates[0].output,before.candidates[0].output);assert.equal(after.operations[0].fingerprint,before.operations[0].fingerprint);
 const {productionFeedback:_a,...a}=after.candidates.at(-1).output,{productionFeedback:_b,...b}=f.plan;assert.deepEqual(a,b);
 assert.equal(after.web.autoRepairs,1);assert.deepEqual(after.web.budget,before.web.budget);
},(r,n,f)=>{const sharedChoices=[{key:'clothing',value:'本集沿用离场时服装状态',authority:n===1?'INTERPRETATION':'DESIGN',sourceRefs:[]}];return n===1?{...f.plan,productionFeedback:{...feedback(),sharedChoices}}:{productionFeedback:{...feedback(),sharedChoices}};}));
test('typed scene headings are time/place evidence, but annotations and character claims are not',()=>{
 const text='日 外 江北路\n导演处理：保持暧昧。';
 const seed={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'v',fromEpisode:1,toEpisode:2,adjacentEpisode:true,previousSource:{episode:1,text,sourceRange:{start:0,end:text.length},nodes:[{id:'head',kind:'SCENE_HEADING',target:'STRUCTURE',sourceRange:{start:0,end:8}},{id:'note',kind:'NOTE',target:'ANNOTATION',sourceRange:{start:8,end:text.length}}]},currentOpening:{text:'甲站着。',nodes:[],sourceRange:{start:0,end:5}}};
 const request={source:{sourceRows:[],contextRows:[],dialogue:[]},materialIds:[],episodeBoundary:makeBoundaryContext({seed}),productionSnapshot:{supplyVersion:'production-supply-v1'}};
 const value={...feedback(),entry:[{key:'place',value:'江北路',authority:'SOURCE',sourceRefs:['boundary:1:head']}]};
 assert.deepEqual(validateProductionFeedback(value,request),value);
 value.entry[0].sourceRefs=['boundary:1:note'];assert.throws(()=>validateProductionFeedback(value,request),{code:'PRODUCTION_FEEDBACK'});
});
test('one receipt error repairs receipt only; creative plan, paid raw and fingerprint stay intact',async()=>fixture(async({c,d,seen,f})=>{
 await c.start(d.id,{mode:'next'});await c.wait(d.id);const before=await c.read(d.id);
 assert.equal(before.candidates[0].status,'needs_repair');
 await c.start(d.id,{mode:'next'});await c.wait(d.id);const after=await c.read(d.id);
 assert.equal(after.candidates.at(-1).status,'adopted',JSON.stringify(after.candidates.at(-1).errors));
 assert.equal(seen.length,2);assert.equal(seen[1].feedbackRepair?.candidateId,before.candidates[0].id);
 assert.deepEqual(Object.keys(seen[1].schema.properties),['productionFeedback']);
 assert.ok(!seen[1].prompt.includes('provisionalUnits'),'no full previous plan is resent');
 assert.ok(!seen[1].prompt.includes('acting-blocking-methods'),'no creative re-production methods');
 for(const key of ['emotionArc','events','workPackages','provisionalUnits','entryFacts','fantasyCandidates'])assert.deepEqual(after.candidates.at(-1).output[key],f.plan[key]);
 assert.equal(after.candidates[0].raw,before.candidates[0].raw);assert.equal(after.operations[0].fingerprint,before.operations[0].fingerprint);
 assert.equal(after.candidates[0].resolvedBy,after.candidates.at(-1).id);assert.equal(after.operations.length,2);assert.equal(after.web.budget.maxTokens,before.web.budget.maxTokens);
 const visible=publicRun(after);assert.equal(visible.operations.at(-1).feedbackRepair,true);assert.equal(visible.operations[0].feedbackRepair,undefined,'normal creation is never labelled as a metadata-only repair');
},(r,n,f)=>n===1?planReply(r,n,f):{productionFeedback:{...feedback(),entry:[{key:'place',value:'走廊',authority:'INTERPRETATION',sourceRefs:[]}]}}));
test('feedback-only response cannot smuggle replacements into the saved plan',async()=>fixture(async({c,d,seen})=>{
 await c.start(d.id,{mode:'next'});await c.wait(d.id);await c.start(d.id,{mode:'next'});await c.wait(d.id);
 const after=await c.read(d.id);assert.equal(after.plan,null);assert.equal(after.candidates.at(-1).status,'needs_repair');
 assert.ok(after.candidates.at(-1).errors.some(e=>e.code==='FEEDBACK_REPAIR_SCOPE'));assert.equal(seen.length,2);
 await c.start(d.id,{mode:'all'});await c.wait(d.id);assert.equal(seen.length,2,'a patch scope violation never escalates to full-plan regeneration');
},(r,n,f)=>n===1?planReply(r,n,f):{productionFeedback:feedback(),emotionArc:'偷偷重写'}));
test('receipt-only recovery applies to author and final delta without replaying valid units',async()=>fixture(async({c,d,seen})=>{
 await c.start(d.id,{mode:'all'});await c.wait(d.id);const after=await c.read(d.id);
 assert.equal(after.status,'text_ready_for_review',JSON.stringify(after.web));
 const patches=after.operations.filter(o=>o.feedbackRepair);assert.equal(patches.length,2);
 assert.deepEqual(patches.map(o=>o.stage),['author','finish']);
 for(const patch of patches){const original=after.candidates.find(x=>x.id===patch.feedbackRepair.candidateId),merged=after.candidates.find(x=>x.attemptId===patch.attemptId);const {productionFeedback:_a,...a}=original.output,{productionFeedback:_b,...b}=merged.output;assert.deepEqual(a,b);}
 assert.ok(seen.filter(r=>r.feedbackRepair).every(r=>Object.keys(r.schema.properties).length===1));
},(r,n,f)=>{
 if(r.feedbackRepair)return {productionFeedback:feedback()};
 if(r.stage==='plan')return {...f.plan,productionFeedback:feedback()};
 const output=r.finishMode==='delta'?{schemaVersion:DELTA_VERSION,baseDraftHash:r.baseDraftHash,retainedUnitIds:r.repairBaseUnits??[],replacements:[],revisionNotes:[],unresolved:[]}:tailDraft(r);
 if(r.finishMode==='delta')output.retainedUnitIds=JSON.parse(r.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以')[0]).previousDraft.units.map(u=>u.id);
 return {...output,productionFeedback:r.stage==='finish'||r.packageIds.includes('p1')?{...feedback(),usedMaterialIds:['missing']}:feedback()};
}));
test('free recheck of a merged receipt retains its local scope and original creative data',async()=>fixture(async({c,d,seen})=>{
 await c.start(d.id,{mode:'next'});await c.wait(d.id);await c.start(d.id,{mode:'next'});await c.wait(d.id);
 const before=await c.read(d.id),candidate=before.candidates.at(-1);assert.equal(candidate.errors[0].code,'PRODUCTION_FEEDBACK');
 await c.recheck(d.id,candidate.id);const after=await c.read(d.id);
 assert.equal(after.candidates.at(-1).errors[0].code,'PRODUCTION_FEEDBACK','free recheck must not misread merged plan as a smuggled replacement');
 assert.deepEqual(after.candidates.at(-1).output,candidate.output);assert.equal(seen.length,2);
},(r,n,f)=>n===1?planReply(r,n,f):{productionFeedback:planReply(r,n,f).productionFeedback}));
test('receipt patch cannot remove a valid blocking need and zero budget admits no retry',async()=>fixture(async({c,d,seen,store})=>{
 await c.start(d.id,{mode:'next'});await c.wait(d.id);
 await c.setBudget(d.id,{maxCalls:1,maxTokens:300000});await c.start(d.id,{mode:'next'});await c.wait(d.id);assert.equal(seen.length,1);
 await c.setBudget(d.id,{maxCalls:3,maxTokens:300000});await c.start(d.id,{mode:'next'});await c.wait(d.id);
 const after=await c.read(d.id);assert.equal(after.candidates.at(-1).errors[0].code,'FEEDBACK_REPAIR_SCOPE');assert.equal(after.candidates[0].output.productionFeedback.needs.length,1);
},(r,n,f)=>n===1?{...planReply(r,n,f),productionFeedback:{...planReply(r,n,f).productionFeedback,needs:[{stage:2,target:'door',purpose:'明确门的开闭',packageIds:['p1'],sourceRefs:['s1'],blocking:true}]}}:{productionFeedback:{...feedback(),entry:[{key:'place',value:'走廊',authority:'INTERPRETATION',sourceRefs:[]}]}}));
