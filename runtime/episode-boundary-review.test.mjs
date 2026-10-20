import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import * as boundary from './episode-boundary.mjs';
import {createUnversionedProductionEngine as createEngine} from './storyboard-v4/core/legacy-test-fixtures.mjs';
import {createStore} from './storyboard-v4/core/store.mjs';
import {tailFixture,tailDraft} from './storyboard-v4/core/author-call-group-test-fixtures.mjs';
import {digest} from './storyboard-v4/core/shared.mjs';

const source={key:'fixture',sourceRows:[{id:'s1',text:'桌边被啃出缺口。',kind:'action'}],contextRows:[],dialogue:[],entryFacts:[],assets:[]};
const state=(key,value,authority='SOURCE')=>({key,value,authority,sourceRefs:authority==='SOURCE'?['s1']:[]});
function fixture(){
 const evidence={episode:1,text:'桌边被啃出缺口。',sourceRange:{start:0,end:8},sourceTextHash:'previous-hash',sourceLength:8,nodes:[]};
 const seed={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'v',fromEpisode:1,toEpisode:2,adjacentEpisode:true,previousSource:evidence,currentOpening:{...evidence,episode:2,sourceTextHash:'opening-hash'}};
 const selected={runId:'previous',episode:1,sourceVersion:'v',selectionRevision:1};
 const actual={...selected,version:'actual-v1',validated:true,unit:{id:'tail',scene:'靠墙木桌上的玻璃缸，桌腿连接墙角地面。'},states:[state('table/edge','桌边被啃出缺口。')]};
 const context=boundary.makeBoundaryContext({seed,selected,actual});
 const feedback={relation:'DIRECT',entry:[state('table/edge','桌边已有被啃掉一块的缺口。'),state('glass/空间基准','玻璃缸在靠墙木桌，桌腿通向地面。','DESIGN')],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]};
 return {context,feedback};
}
function reviewFor(context,feedback){
 return {version:'boundary-review-v1',checkSignature:boundary.reconcileBoundary({context,feedback}).signature,contextVersion:context.versionId,actualVersion:context.actual.version,
  sourceHashes:{previous:context.seed.previousSource.sourceTextHash,current:context.seed.currentOpening.sourceTextHash},
  equivalences:[{key:'table/edge',entryValue:feedback.entry[0].value,actualValue:context.actual.states[0].value,sourceRefs:['s1'],reason:'完整原文说明同一个桌缘缺口；未发生修复。'}],
  supplementalStates:[{key:'glass/空间基准',entryValue:feedback.entry[1].value,value:context.actual.unit.scene,authority:'DESIGN',sourcePath:'actual.unit.scene',reason:'实际采用尾单元的scene明示同一桌缸关系。'}]};
}

function claimFixture(){
 const {context}=fixture();
 const claimSource={...source,sourceRows:[...source.sourceRows,{id:'claim',kind:'dialogue',text:'系统：敏捷达到当前形态上限。'},{id:'fact',kind:'action',text:'继续加点后，敏捷提升并成功侧身。'}]};
 const feedback={relation:'DIRECT',entry:[state('table/edge',context.actual.states[0].value)],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[{key:'turtle/agility-reading',problem:'系统说达到上限，但后续动作继续提升；保留原话和动作，不补造机制。',sourceRefs:['claim','fact']}]};
 const review={version:'boundary-review-v2',checkSignature:boundary.reconcileBoundary({context,feedback}).signature,contextVersion:context.versionId,actualVersion:context.actual.version,sourceHashes:{previous:context.seed.previousSource.sourceTextHash,current:context.seed.currentOpening.sourceTextHash},equivalences:[],supplementalStates:[],sourceHash:boundarySourceHash(claimSource),sourceClaimReviews:[{key:'turtle/agility-reading',claimRefs:['claim'],factRefs:['fact'],reason:'这是一处说法与后续表现的疑点，可以保留原话与动作拍摄；不得补造上限重置或提前进化。'}]};
 return {context,feedback,source:claimSource,review};
}
function boundarySourceHash(s){return digest(s.sourceRows);}

test('an explicit source-bound relation review resolves UNKNOWN without rewriting the paid receipt or inheriting across a time jump',()=>{
 const {context}=fixture();
 context.seed.previousSource.nodes=[{id:'previous-fact',target:'BODY',kind:'ACTION',sourceRange:{start:0,end:8}}];
 context.versionId=digest(context);
 const s={...source,sourceRows:[{id:'s1',kind:'action',text:'△一连数日，沿支流狩猎。'}],contextRows:[{id:'previous-1:excerpt-1',kind:'action',evidenceRole:'source',text:context.seed.previousSource.text,provenance:{verifiedAgainst:'STANDARD_BOUNDARY_NODE',origin:{domain:'EPISODE',episode:1,start:0,end:8},nodeId:'previous-fact'}}]};
 const feedback={relation:'UNKNOWN',entry:[state('table/edge',context.actual.states[0].value)],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]};
 const raw={version:'boundary-review-v2',checkSignature:digest({version:context.versionId,feedback}),contextVersion:context.versionId,actualVersion:context.actual.version,sourceHashes:{previous:context.seed.previousSource.sourceTextHash,current:context.seed.currentOpening.sourceTextHash},sourceHash:digest(s.sourceRows),contextHash:digest(s.contextRows),equivalences:[],supplementalStates:[],sourceClaimReviews:[],relationReview:{relation:'TIME_JUMP',sourceRefs:['previous-1:excerpt-1','s1'],reason:'完整前源给出此前状态，本集明确一连数日的阶段性活动，不按同一瞬时动作无条件继承；保留全部原话与正文。'}};
 const before=structuredClone({context,feedback,source:s});
 assert.equal(boundary.reconcileBoundary(before).status,'UNRESOLVED');
 const review=boundary.validateBoundaryReview(raw,{context,feedback,source:s});
 const check=boundary.reconcileBoundary({context,feedback,source:s,review});
 assert.equal(check.status,'NOT_CONTINUOUS');assert.equal(check.reviewedRelation,'TIME_JUMP');assert.equal(check.inherit,false);
 const sent=boundary.selectBoundaryForRequest(context,'author',true,[review],s);
 assert.equal(sent.sourceObservations[0].value,'TIME_JUMP');assert.equal(sent.sourceObservations[0].authority,'INTERPRETATION');
 const changed=structuredClone(s);changed.sourceRows[0].text='不同的本集动作';
 assert.equal(boundary.selectBoundaryForRequest(context,'author',true,[review],changed).sourceObservations,undefined);
 assert.deepEqual({context,feedback,source:s},before);
 for(const mutate of [f=>f.feedback.relation='DIRECT',f=>f.source.sourceRows[0].kind='dialogue',f=>f.context.seed.previousSource.sourceTextHash='changed',f=>f.feedback.conflicts.push({key:'table/edge',problem:'真正硬冲突',sourceRefs:['s1']}),f=>f.context.agreements.push(state('table/edge','另一锁定值','DESIGN'))]){
  const f=structuredClone(before);mutate(f);
  assert.throws(()=>boundary.validateBoundaryReview(raw,f),e=>['BOUNDARY_REVIEW','BOUNDARY_REVIEW_STALE'].includes(e.code));
 }
 assert.throws(()=>boundary.validateBoundaryReview({...raw,relationReview:{...raw.relationReview,sourceRefs:['s1']}},before),{code:'BOUNDARY_REVIEW'});
 assert.throws(()=>boundary.validateBoundaryReview({...raw,relationReview:{...raw.relationReview,relation:'UNKNOWN'}},before),{code:'BOUNDARY_REVIEW'});
});

test('explicit source-claim review keeps both statements and raw conflicts without blocking producible source',()=>{
 const f=claimFixture(),before=structuredClone(f);
 assert.equal(boundary.reconcileBoundary({context:f.context,feedback:f.feedback,source:f.source}).status,'CONSTRAINT_CONFLICT');
 const reviewed=boundary.validateBoundaryReview(f.review,f);
 assert.equal(boundary.reconcileBoundary({...f,review:reviewed}).status,'MATCHED');
 assert.deepEqual(f,before,'original source, conflict and actual state remain unchanged');
 const sent=boundary.selectBoundaryForRequest(f.context,'author',true,[reviewed],f.source);
 assert.equal(sent.sourceObservations[0].key,'turtle/agility-reading');
 assert.deepEqual(sent.sourceObservations[0].sourceRefs,['claim','fact']);
 for(const change of [x=>x.source.sourceRows[2].text='原文已改',x=>x.context.agreements.push(state('turtle/agility-reading','不可再提升','DESIGN')),x=>x.context.actual.states.push(state('turtle/agility-reading','不得再提升'))]){
  const changed=structuredClone(f);change(changed);
  assert.throws(()=>boundary.validateBoundaryReview(changed.review,changed),e=>['BOUNDARY_REVIEW','BOUNDARY_REVIEW_STALE'].includes(e.code));
 }
 const actionsOnly=structuredClone(f);actionsOnly.source.sourceRows[1].kind='action';actionsOnly.review.sourceHash=boundarySourceHash(actionsOnly.source);
 assert.throws(()=>boundary.validateBoundaryReview(actionsOnly.review,actionsOnly),{code:'BOUNDARY_REVIEW'});
 const missing=structuredClone(f);missing.review.sourceClaimReviews[0].factRefs=[];
 assert.throws(()=>boundary.validateBoundaryReview(missing.review,missing),{code:'BOUNDARY_REVIEW'});
});

test('source-claim review releases only derived production gate with no model or paid-plan rewrite',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'claim-review-'));
 try{
  const f=claimFixture(),plan={workPackages:[{id:'p1',sourceRefs:['s1','claim','fact'],contextRefs:[],entryFactIds:[],dependsOn:[]}],productionFeedback:f.feedback};
  const original={id:'claim-review',source:f.source,plan,adopted:[],candidates:[{id:'paid-plan',attemptId:'paid',stage:'plan',packageIds:[],status:'adopted',raw:'original-paid-raw',output:plan,productionFeedback:f.feedback}],operations:[{attemptId:'paid',stage:'plan',status:'completed',fingerprint:'original-fingerprint',receipt:{usage:{totalTokens:123}}}],rulesSnapshot:{},status:'planned',production:{boundary:f.context,materials:[],boundaryCheck:boundary.reconcileBoundary({context:f.context,feedback:f.feedback,source:f.source}),blocking:true,globalBlocking:true},web:{budget:{maxTokens:1000}},assembly:null};
  const store=createStore(directory);await store.create('claim-review',original);
  const engine=createEngine({directory,modelRunner:async()=>{throw Error('free review must not call a model');}});
  const after=await engine.reviewBoundary('claim-review',f.review);
  assert.equal(after.production.globalBlocking,false);assert.equal(after.production.blocking,false);
  assert.equal(after.production.boundaryCheck.status,'MATCHED');
  for(const key of ['source','plan','candidates','operations','web','assembly','status'])assert.deepEqual(after[key],original[key],key);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('source observations work without a predecessor draft and never travel across changed source or actual',()=>{
 const f=claimFixture();
 f.context.actual=null;f.context.mode='PRELIMINARY';f.context.versionId=digest(f.context);f.feedback.relation='TIME_JUMP';
 f.review.contextVersion=f.context.versionId;f.review.actualVersion=null;f.review.checkSignature=digest({version:f.context.versionId,feedback:f.feedback});
 const review=boundary.validateBoundaryReview(f.review,f);
 assert.equal(boundary.reconcileBoundary({...f,review}).status,'NOT_CONTINUOUS');
 assert.equal(boundary.selectBoundaryForRequest(f.context,'plan',true,[review],f.source).sourceObservations.length,1);
 const changed=structuredClone(f.source);changed.sourceRows[2].text='新动作';
 assert.equal(boundary.selectBoundaryForRequest(f.context,'plan',true,[review],changed).sourceObservations,undefined);
 const actual=structuredClone(f.context);actual.actual={validated:true,version:'new-tail',states:[]};
 assert.equal(boundary.selectBoundaryForRequest(actual,'plan',true,[review],f.source).sourceObservations,undefined);
});

test('a reviewed paid-plan observation does not reblock later author or finish and requests actually carry it',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'claim-travel-'));
 try{
  const f=tailFixture(),claim=claimFixture(),seen=[];
  const feedback=structuredClone(claim.feedback);feedback.entry=[];
  claim.context.actual.states=[];
  const engine=createEngine({directory,modelRunner:async request=>{seen.push(request);const output=request.stage==='plan'?{...f.plan,productionFeedback:feedback}:{...tailDraft(request),productionFeedback:{...feedback,conflicts:[]}};return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};}}),store=createStore(directory);
  f.source.sourceRows[0].kind='dialogue';
  f.source.sourceRows[1]={...f.source.sourceRows[1],kind:'action',text:'△甲继续行动。'};
  await engine.create({id:'travel',source:f.source,settings:f.settings,production:{boundary:claim.context,materials:[]}});
  await store.update('travel',d=>{delete d.rulesSnapshot.productionFeedbackInheritanceVersion;return d;});
  // Use the normalized real source ids, including its spoken/action roles.
  const saved=await engine.read('travel');
  feedback.conflicts[0].sourceRefs=[saved.source.sourceRows[0].id,saved.source.sourceRows[1].id];
  await engine.execute('travel',{stage:'plan',attemptId:'paid-plan'});
  const paid=await engine.read('travel'),review={...claim.review,sourceHash:digest(paid.source.sourceRows),checkSignature:digest({version:claim.context.versionId,feedback}),sourceClaimReviews:[{...claim.review.sourceClaimReviews[0],claimRefs:[saved.source.sourceRows[0].id],factRefs:[saved.source.sourceRows[1].id]}]};
  await engine.reviewBoundary('travel',review);
  await engine.execute('travel',{stage:'author',packageId:'p1',attemptId:'author'});
  await engine.execute('travel',{stage:'finish',packageId:'p1',attemptId:'finish'});
  const after=await engine.read('travel');
  assert.equal(after.production.globalBlocking,false);assert.equal(after.production.blocking,false);
  for(const request of seen.slice(1))assert.equal(request.productionSnapshot.episodeBoundary.sourceObservations.length,1);
  assert.deepEqual(after.candidates[0],paid.candidates[0]);assert.deepEqual(after.operations[0],paid.operations[0]);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('opt-in inheritance schema constrains known entry values while preserving unknown keys and old authority gates',()=>{
 const {context}=fixture(),input={source,episodeBoundary:context,strictAuthorities:true};
 const old=boundary.productionFeedbackSchema(input),schema=boundary.productionFeedbackSchema({...input,inheritanceVersion:'production-feedback-inheritance-v1'});
 assert.notDeepEqual(schema.properties.entry,old.properties.entry);
 const variants=schema.properties.entry.items.anyOf;
 const known=variants.filter(v=>v.properties.key.enum?.includes('table/edge'));
 assert.equal(known.length,2,'SOURCE and non-SOURCE authority branches remain separate');
 for(const v of known)assert.deepEqual(v.properties.value.enum,['桌边被啃出缺口。']);
 assert.equal(known.find(v=>v.properties.authority.enum.includes('SOURCE')).properties.sourceRefs.minItems,1);
 const fresh=variants.filter(v=>v.properties.key.pattern);
 assert.equal(fresh.length,2);assert.ok(fresh.every(v=>!new RegExp(v.properties.key.pattern).test('table/edge')&&new RegExp(v.properties.key.pattern).test('rat/position')));
 assert.deepEqual(schema.properties.exit,old.properties.exit,'the next episode exit may legitimately change');
 assert.deepEqual(boundary.productionFeedbackSchema({...input,inheritanceVersion:'unknown'}),old);
});

test('opt-in native gate rejects paraphrases of an actual key and still permits explicit conflicts',()=>{
 const {context,feedback}=fixture(),request={source,episodeBoundary:context,productionSnapshot:{feedbackInheritanceVersion:'production-feedback-inheritance-v1'},materialIds:[]};
 assert.throws(()=>boundary.validateProductionFeedback(feedback,request),e=>e.code==='PRODUCTION_FEEDBACK'&&e.coordinate==='productionFeedback.entry[0].value');
 const canonical=structuredClone(feedback);canonical.entry[0].value=context.actual.states[0].value;
 canonical.conflicts=[{key:'table/edge',problem:'本集原文若说明桌边完整，应保留硬冲突。',sourceRefs:['s1']}];
 assert.deepEqual(boundary.validateProductionFeedback(canonical,request),canonical);
 assert.equal(boundary.reconcileBoundary({context,feedback:canonical}).status,'CONSTRAINT_CONFLICT');
 assert.deepEqual(boundary.validateProductionFeedback(feedback,{...request,productionSnapshot:{}}),feedback,'historical validation remains unchanged');
});

test('non-continuous v2 feedback does not force an unrelated predecessor value into a current source fact',()=>{
 const {context,feedback}=fixture(),request={source,episodeBoundary:context,productionSnapshot:{feedbackInheritanceVersion:'production-feedback-inheritance-v2'},materialIds:[]};
 for(const relation of ['TIME_JUMP','LOCATION_CHANGE','FLASHBACK','FANTASY','INDEPENDENT']){
  const next={...feedback,relation};
  assert.deepEqual(boundary.validateProductionFeedback(next,request),next);
  assert.equal(boundary.reconcileBoundary({context,feedback:next,source}).status,'NOT_CONTINUOUS');
 }
 assert.throws(()=>boundary.validateProductionFeedback(feedback,request),{code:'PRODUCTION_FEEDBACK'});
 assert.throws(()=>boundary.validateProductionFeedback({...feedback,relation:'LOCATION_CHANGE'},{...request,productionSnapshot:{feedbackInheritanceVersion:'production-feedback-inheritance-v1'}}),{code:'PRODUCTION_FEEDBACK'},'frozen v1 validation stays unchanged');
});

test('a reviewed predecessor source fact fills a missing receipt key without inventing an actual tail state',()=>{
 const {context,feedback}=fixture();
 context.seed.previousSource.nodes=[{id:'previous-fact',target:'BODY',kind:'ACTION',sourceRange:{start:0,end:8}}];
 context.versionId=digest(context);
 const previousRef='previous-1:excerpt-1',s={...source,contextRows:[{id:previousRef,kind:'action',evidenceRole:'source',text:context.seed.previousSource.text,provenance:{verifiedAgainst:'STANDARD_BOUNDARY_NODE',origin:{domain:'EPISODE',episode:1,start:0,end:8},nodeId:'previous-fact'}}]};
 const next={...feedback,entry:[state('table/edge',context.actual.states[0].value),{...state('table/unrepaired','此前缺口仍可见。'),sourceRefs:[previousRef,'s1']}]};
 next.entry.push(state('current/new','本集原文新增的事实，不要求上集重复登记。'));
 const raw={version:'boundary-review-v2',checkSignature:digest({version:context.versionId,feedback:next}),contextVersion:context.versionId,actualVersion:context.actual.version,sourceHashes:{previous:context.seed.previousSource.sourceTextHash,current:context.seed.currentOpening.sourceTextHash},equivalences:[],supplementalStates:[],sourceClaimReviews:[],sourceHash:digest(s.sourceRows),contextHash:digest(s.contextRows),sourceEntryReviews:[{key:'table/unrepaired',entryValue:next.entry[1].value,sourceRefs:[previousRef,'s1'],reason:'上一集完整原文已明示缺口，本集仍显示同一缺口；不要求前集末镜重复登记全部历史事实。'}]};
 assert.equal(boundary.reconcileBoundary({context,feedback:next,source:s}).status,'UNRESOLVED');
 const review=boundary.validateBoundaryReview(raw,{context,feedback:next,source:s}),before=structuredClone({context,feedback:next,source:s});
 const check=boundary.reconcileBoundary({context,feedback:next,source:s,review});
 assert.equal(check.status,'MATCHED');assert.deepEqual(check.sourceReviewedKeys,['table/unrepaired']);
 assert.deepEqual({context,feedback:next,source:s},before);
 assert.equal(context.actual.states.some(x=>x.key==='table/unrepaired'),false);
 for(const mutate of [f=>f.source.contextRows[0].text='已经修好了',f=>f.feedback.entry[1].value='完全不同',f=>f.context.actual.states.push(state('table/unrepaired','明确相反'))]){
  const f=structuredClone({context,feedback:next,source:s});mutate(f);
  assert.throws(()=>boundary.validateBoundaryReview(raw,f),e=>['BOUNDARY_REVIEW','BOUNDARY_REVIEW_STALE'].includes(e.code));
 }
 const unknown={...raw,sourceEntryReviews:[{...raw.sourceEntryReviews[0],sourceRefs:['unknown']}]};
 assert.throws(()=>boundary.validateBoundaryReview(unknown,{context,feedback:next,source:s}),{code:'BOUNDARY_REVIEW'});
});

test('only a genuinely revised predecessor DESIGN can close an old design conflict and its scoped repair need',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'changed-design-review-'));
 try{
  const {context:originalContext}=fixture(),key='turtle/rise-position';
  originalContext.actual.states.push(state(key,'桌下升腾','DESIGN'));originalContext.versionId=digest(originalContext);
  const context=structuredClone(originalContext);context.actual.version='repaired-tail';context.actual.unit.exitState='玻璃缸内黑光升腾';context.actual.states.at(-1).value='玻璃缸内升腾';context.versionId=digest(context);
  const s={...source,sourceRows:[{id:'s1',kind:'action',text:'△黑色能量包裹玻璃缸。'}]};
  const feedback={relation:'DIRECT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[{stage:3,target:key,packageIds:['p1'],sourceRefs:['s1'],purpose:'修复前集自由位置以接上缸内原文。',blocking:true}],conflicts:[{key,sourceRefs:['s1'],problem:'前集实际设计桌下，本集源文缸内。'}]};
  const raw={version:'boundary-review-v2',checkSignature:digest({version:context.versionId,feedback}),contextVersion:context.versionId,actualVersion:context.actual.version,sourceHashes:{previous:context.seed.previousSource.sourceTextHash,current:context.seed.currentOpening.sourceTextHash},sourceHash:digest(s.sourceRows),contextHash:digest(s.contextRows),equivalences:[],supplementalStates:[],sourceClaimReviews:[],resolvedDesignConflicts:[{key,originalContextVersion:originalContext.versionId,originalActualVersion:originalContext.actual.version,oldActualValue:'桌下升腾',newActualValue:'玻璃缸内升腾',sourceRefs:['s1'],reason:'前集只修自由调度且已实际采用缸内结尾，原文和当前集没有被改写。'}]};
  const review=boundary.validateBoundaryReview(raw,{context,feedback,source:s,originalContext});
  assert.equal(boundary.reconcileBoundary({context,feedback,source:s,originalContext,review}).status,'NOT_CONSUMED');
  for(const mutate of [f=>f.originalContext.actual.states.at(-1).authority='SOURCE',f=>f.context.actual.unit=structuredClone(originalContext.actual.unit),f=>f.context.agreements.push(state(key,'锁定位置','DESIGN')),f=>f.originalContext.actual.version='another-version']){
   const f=structuredClone({context,feedback,source:s,originalContext});mutate(f);
   assert.throws(()=>boundary.validateBoundaryReview(raw,f),e=>['BOUNDARY_REVIEW','BOUNDARY_REVIEW_STALE'].includes(e.code));
  }
  const plan={workPackages:[{id:'p1',sourceRefs:['s1'],contextRefs:[],entryFactIds:[],dependsOn:[]}],productionFeedback:feedback};
  const document={id:'changed-design',source:s,plan,adopted:[],candidates:[{id:'paid-plan',attemptId:'paid',stage:'plan',packageIds:[],status:'adopted',raw:'paid-raw',output:plan,productionFeedback:feedback}],operations:[{attemptId:'paid',stage:'plan',status:'completed',fingerprint:'paid-fingerprint',productionSnapshot:{episodeBoundary:originalContext}}],rulesSnapshot:{},status:'planned',production:{boundary:context,materials:[],blocking:true,globalBlocking:true},web:{},assembly:null};
  const store=createStore(directory);await store.create(document.id,document);
  const engine=createEngine({directory,modelRunner:async()=>{throw Error('source review is free');}}),after=await engine.reviewBoundary(document.id,raw);
  assert.equal(after.production.blocking,false);assert.equal(after.production.needs[0].resolved,true);
  assert.equal(after.production.needs[0].resolvedBy,`boundaryReview:${review.id}`);
  for(const field of ['source','plan','candidates','operations','web','assembly','status'])assert.deepEqual(after[field],document[field]);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('inheritance v2 uses supported schema branches and keeps native exact-value validation without rewriting frozen v1',()=>{
 const {context,feedback}=fixture(),input={source,episodeBoundary:context,strictAuthorities:true};
 const old=boundary.productionFeedbackSchema({...input,inheritanceVersion:'production-feedback-inheritance-v1'});
 const current=boundary.productionFeedbackSchema({...input,inheritanceVersion:'production-feedback-inheritance-v2'});
 const known=current.properties.entry.items.anyOf.filter(v=>v.properties.key.enum?.includes('table/edge'));
 assert.equal(known.length,2,'the new protocol still supplies exact known-key/value branches');
 for(const v of known)assert.deepEqual(v.properties.value.enum,['桌边被啃出缺口。']);
 assert.ok(JSON.stringify(old).includes('(?!'),'v1 stays byte-compatible for the saved rejected request');
 assert.ok(!JSON.stringify(current).includes('(?!'),'provider regex lookaround is not supported');
 const request={source,episodeBoundary:context,productionSnapshot:{feedbackInheritanceVersion:'production-feedback-inheritance-v2'},materialIds:[]};
 assert.throws(()=>boundary.validateProductionFeedback(feedback,request),e=>e.code==='PRODUCTION_FEEDBACK'&&e.coordinate==='productionFeedback.entry[0].value');
 const exact=structuredClone(feedback);exact.entry[0].value=context.actual.states[0].value;
 assert.deepEqual(boundary.validateProductionFeedback(exact,request),exact);
});

test('a source-bound review resolves only the named equivalence and exact actual scene path without rewriting receipts',()=>{
 const {context,feedback}=fixture(),before=structuredClone({context,feedback});
 assert.equal(boundary.reconcileBoundary({context,feedback}).status,'CONSTRAINT_CONFLICT');
 assert.equal(typeof boundary.validateBoundaryReview,'function');
 const review=boundary.validateBoundaryReview(reviewFor(context,feedback),{context,feedback,source});
 const check=boundary.reconcileBoundary({context,feedback,review,source});
 assert.equal(check.status,'MATCHED');assert.equal(check.reviewId,review.id);
 assert.equal(check.signature,boundary.reconcileBoundary({context,feedback}).signature);
 assert.deepEqual({context,feedback},before);
});

test('review rejects stale binding, unlocked fiction, SOURCE supplementation, explicit conflicts and locked choices',()=>{
 assert.equal(typeof boundary.validateBoundaryReview,'function');
 const {context,feedback}=fixture(),good=reviewFor(context,feedback);
 for(const field of ['checkSignature','contextVersion','actualVersion'])assert.throws(()=>boundary.validateBoundaryReview({...good,[field]:'stale'},{context,feedback,source}),{code:'BOUNDARY_REVIEW_STALE'});
 assert.throws(()=>boundary.validateBoundaryReview({...good,sourceHashes:{...good.sourceHashes,previous:'stale'}},{context,feedback,source}),{code:'BOUNDARY_REVIEW_STALE'});
 const fiction=structuredClone(good);fiction.supplementalStates[0].value='桌边已自动复原。';
 assert.throws(()=>boundary.validateBoundaryReview(fiction,{context,feedback,source}),{code:'BOUNDARY_REVIEW'});
 const badPath=structuredClone(good);badPath.supplementalStates[0].sourcePath='actual.unit.exitState';
 assert.throws(()=>boundary.validateBoundaryReview(badPath,{context,feedback,source}),{code:'BOUNDARY_REVIEW'});
 const wrongAuthority=structuredClone(feedback);wrongAuthority.entry[1].authority='SOURCE';wrongAuthority.entry[1].sourceRefs=['s1'];
 assert.throws(()=>boundary.validateBoundaryReview(reviewFor(context,wrongAuthority),{context,feedback:wrongAuthority,source}),{code:'BOUNDARY_REVIEW'});
 const explicit={...feedback,conflicts:[{key:'table/edge',problem:'原文明确相反。',sourceRefs:['s1']}]};
 assert.throws(()=>boundary.validateBoundaryReview(reviewFor(context,explicit),{context,feedback:explicit,source}),{code:'BOUNDARY_REVIEW'});
 const locked=boundary.makeBoundaryContext({...context,agreements:[state('table/edge','必须保持完整。','DESIGN')]});
 assert.throws(()=>boundary.validateBoundaryReview(reviewFor(locked,feedback),{context:locked,feedback,source}),{code:'BOUNDARY_REVIEW'});
 const unrelated=structuredClone(good);unrelated.equivalences[0].sourceRefs=['unread'];
 assert.throws(()=>boundary.validateBoundaryReview(unrelated,{context,feedback,source}),{code:'BOUNDARY_REVIEW'});
});

test('the reviewed scene travels as DESIGN evidence to new requests and feedback, never as reused equivalence',()=>{
 const {context,feedback}=fixture(),original=structuredClone({context,feedback});
 const review=boundary.validateBoundaryReview(reviewFor(context,feedback),{context,feedback,source});
 const oldSnapshot=boundary.selectBoundaryForRequest(context,'author',true);
 const view=boundary.selectBoundaryForRequest(context,'author',true,[review]);
 const carried=view.actual.states.find(s=>s.key==='glass/空间基准');
 assert.ok(carried,'reviewed scene must be present in the next readable actual state view');
 assert.equal(carried.value,context.actual.unit.scene);assert.equal(carried.authority,'DESIGN');
 assert.equal(carried.reviewId,review.id);assert.equal(carried.sourcePath,'actual.unit.scene');
 assert.deepEqual(oldSnapshot,context);assert.deepEqual({context,feedback},original);
 const next=structuredClone(feedback);next.entry[0].value=context.actual.states[0].value;next.entry[1].value=context.actual.unit.scene;
 assert.equal(boundary.reconcileBoundary({context,feedback:next}).status,'UNRESOLVED');
 const check=boundary.reconcileBoundary({context,feedback:next,reviews:[review],source});
 assert.equal(check.status,'MATCHED');assert.notEqual(check.signature,review.checkSignature);
 assert.equal(check.reviewId,undefined,'old equivalence approval never carries to a new feedback signature');
 assert.deepEqual(check.supplementalReviewIds,[review.id]);
 next.entry[0].value='桌边完整无缺口。';
 assert.equal(boundary.reconcileBoundary({context,feedback:next,reviews:[review],source}).status,'CONSTRAINT_CONFLICT');
 const schema=boundary.productionFeedbackSchema({source,episodeBoundary:view,inheritanceVersion:'production-feedback-inheritance-v1'});
 assert.ok(schema.properties.entry.items.anyOf.some(v=>v.properties.key.enum?.includes('glass/空间基准')&&v.properties.value.enum?.includes(context.actual.unit.scene)));
});

test('carried DESIGN evidence expires with any bound context, actual, source or source path change',()=>{
 const {context,feedback}=fixture(),review=boundary.validateBoundaryReview(reviewFor(context,feedback),{context,feedback,source});
 for(const change of [c=>c.versionId='new-context',c=>c.actual.version='new-actual',c=>c.seed.previousSource.sourceTextHash='new-previous',c=>c.seed.currentOpening.sourceTextHash='new-opening',c=>c.actual.unit.scene='不同空间']){
  const changed=structuredClone(context);change(changed);
  assert.equal(boundary.selectBoundaryForRequest(changed,'finish',true,[review]).actual.states.length,context.actual.states.length);
 }
 const invented=structuredClone(review);invented.supplementalStates[0].authority='SOURCE';
 assert.equal(boundary.selectBoundaryForRequest(context,'author',true,[invented]).actual.states.length,context.actual.states.length);
});

test('future author and finish snapshots carry approved scene state while the paid plan snapshot stays frozen',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'boundary-view-'));
 try{
  const f=tailFixture(),{context,feedback}=fixture(),seen=[];
  f.source.sourceRows[0].text='△桌边被啃出缺口。';
  const next=structuredClone(feedback);next.entry[0].value=context.actual.states[0].value;next.entry[1].value=context.actual.unit.scene;
  const engine=createEngine({directory,modelRunner:async request=>{seen.push(request);const output=request.stage==='plan'?{...f.plan,productionFeedback:feedback}:{...tailDraft(request),productionFeedback:next};return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};}}),store=createStore(directory);
  await engine.create({id:'view',source:f.source,settings:f.settings,production:{boundary:context,materials:[]}});
  await store.update('view',d=>{delete d.rulesSnapshot.productionFeedbackInheritanceVersion;return d;});
  await engine.execute('view',{stage:'plan',attemptId:'paid-plan'});
  const paid=await engine.read('view');assert.equal(paid.candidates[0].status,'adopted');
  await engine.reviewBoundary('view',reviewFor(context,feedback));
  await store.update('view',d=>{d.web={inputPolicy:{feedbackInheritanceVersion:'production-feedback-inheritance-v2'}};return d;});
  await engine.execute('view',{stage:'author',packageId:'p1',attemptId:'author'});
  await engine.execute('view',{stage:'finish',packageId:'p1',attemptId:'finish'});
  const saved=await engine.read('view');
  assert.equal(saved.candidates.at(-1).status,'adopted',JSON.stringify(saved.candidates.at(-1).errors));
  assert.equal(saved.production.boundaryCheck.status,'MATCHED');
  for(const request of seen.slice(1)){
   const carried=request.productionSnapshot.episodeBoundary.actual.states.find(s=>s.key==='glass/空间基准');
   assert.equal(carried?.value,context.actual.unit.scene);assert.ok(carried.reviewId);assert.equal(carried.sourcePath,'actual.unit.scene');
   assert.equal(request.productionSnapshot.feedbackInheritanceVersion,'production-feedback-inheritance-v2');
   assert.ok(JSON.stringify(request.schema).includes('glass/空间基准'),'the schema uses the exact new readable state');
  }
  assert.deepEqual(saved.operations[0],paid.operations[0]);assert.deepEqual(saved.candidates[0],paid.candidates[0]);assert.deepEqual(saved.production.boundary.actual,context.actual);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('engine appends review for a paid plan without new operations, raw changes, budget changes or stale reuse',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'boundary-review-'));
 try{
  const {context,feedback}=fixture(),plan={workPackages:[{id:'p1',sourceRefs:['s1'],contextRefs:[],entryFactIds:[],dependsOn:[]}],productionFeedback:feedback};
  const document={id:'review',source,plan,adopted:[],candidates:[{id:'paid-plan',attemptId:'paid',stage:'plan',packageIds:[],status:'adopted',raw:'original-paid-raw',output:plan,productionFeedback:feedback}],operations:[{attemptId:'paid',stage:'plan',status:'completed',fingerprint:'original-fingerprint',receipt:{usage:{totalTokens:123}}}],rulesSnapshot:{},status:'planned',production:{boundary:context,materials:[],boundaryCheck:boundary.reconcileBoundary({context,feedback})},web:{budget:{maxTokens:1000},reserved:{paid:123}},assembly:null};
  const store=createStore(directory);await store.create('review',document);
  let calls=0;const engine=createEngine({directory,modelRunner:async()=>{calls++;throw Error('review must never call a model');}});
  assert.equal(typeof engine.reviewBoundary,'function');
  const after=await engine.reviewBoundary('review',reviewFor(context,feedback));
  assert.equal(after.production.boundaryCheck.status,'MATCHED');assert.equal(after.production.boundaryReviews.length,1);assert.equal(calls,0);
  assert.equal(after.production.checkHistory?.at(-1)?.reviewId,after.production.boundaryReviews[0].id,'applied review outcome is append-only check history');
  for(const key of ['source','plan','candidates','operations','web','assembly','status'])assert.deepEqual(after[key],document[key],key);
  const again=await engine.reviewBoundary('review',reviewFor(context,feedback));assert.equal(again.production.boundaryReviews.length,1,'idempotent approval');
  const next=structuredClone(feedback);next.entry[0].value=context.actual.states[0].value;next.entry[1].value=context.actual.unit.scene;
  await store.update('review',d=>{d.candidates.push({id:'new-author',attemptId:'new-author',stage:'author',packageIds:['p1'],status:'adopted',productionFeedback:next});d.adopted.push({packageIds:['p1'],candidateId:'new-author'});d.operations.push({attemptId:'new-author',stage:'author',status:'completed',productionSnapshot:{episodeBoundary:context,materials:[]}});return d;});
  const continued=await engine.refreshProduction('review',{boundary:context,materials:[],predecessorRevision:0});
  assert.equal(continued.production.boundaryCheck.status,'MATCHED','new author consumes the same reviewed scene without another approval');
  assert.equal(continued.production.boundaryCheck.reviewId,undefined);assert.deepEqual(continued.production.boundary.actual,context.actual);
  assert.deepEqual(continued.candidates[0],document.candidates[0]);assert.deepEqual(continued.operations[0],document.operations[0]);
  await store.update('review',d=>{d.production.boundary.actual.version='actual-v2';d.production.boundary.versionId='context-v2';return d;});
  const stale=await engine.refreshProduction('review',{boundary:(await store.read('review')).production.boundary,materials:[],predecessorRevision:0});
  assert.equal(stale.production.boundaryCheck.status,'UNRESOLVED');assert.equal(stale.production.boundaryReviews.length,1,'past review remains append-only history');
  await assert.rejects(engine.reviewBoundary('review',reviewFor(context,feedback)),{code:'BOUNDARY_REVIEW_STALE'});
 }finally{await rm(directory,{recursive:true,force:true});}
});
