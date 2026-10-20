import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createUnversionedProductionEngine as createEngine,createUnversionedProductionCoordinator as createCoordinator} from './storyboard-v4/core/legacy-test-fixtures.mjs';
import {tailFixture,tailDraft} from './storyboard-v4/core/author-call-group-test-fixtures.mjs';
import {makeBoundaryContext} from './episode-boundary.mjs';
import {digest} from './storyboard-v4/core/shared.mjs';
import {DELTA_VERSION} from './storyboard-v4/core/delta.mjs';

const seed={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:'all-source',fromEpisode:1,toEpisode:2,adjacentEpisode:true,
 previousSource:{episode:1,text:'甲接住钥匙。',nodes:[],sourceRange:{start:0,end:6}},currentOpening:{episode:2,text:'甲：第一句。',nodes:[],sourceRange:{start:0,end:7}},story:{timeLayer:'UNKNOWN',realityDomain:'UNKNOWN'},unknowns:[]};
const selected={runId:'e1',episode:1,sourceVersion:'all-source',selectionRevision:1};
const receipt=()=>({relation:'DIRECT',entry:[{key:'PR01/holder',value:'甲',authority:'DESIGN',sourceRefs:[]}],exit:[],sharedChoices:[],usedMaterialIds:['asset:CH01'],needs:[],conflicts:[]});
const initial=()=>({version:'production-feedback-v1',boundary:makeBoundaryContext({seed,selected}),materials:[{id:'asset:CH01',version:'v1',value:{assetKey:'CH01',design:'黑衣'}}]});

test('real engine request consumes source seed/design; late supplements do not mutate in-flight fingerprints',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'production-loop-'));let release,arrived;
 const gate=new Promise(r=>release=r),started=new Promise(r=>arrived=r),requests=[];
 const f=tailFixture();
 const engine=createEngine({directory,modelRunner:async request=>{
  requests.push(request);if(request.stage==='author'){arrived();await gate;}
  return {output:request.stage==='plan'?{...f.plan,productionFeedback:receipt()}:{...tailDraft(request),productionFeedback:receipt()},usage:{totalTokens:1}};
 }});
 try{
  await engine.create({id:'e2',source:f.source,settings:f.settings,production:initial()});
  await engine.execute('e2',{stage:'plan'});
  assert.ok(requests[0].prompt.includes('甲接住钥匙'),'readable boundary evidence must reach actual prompt');assert.ok(requests[0].prompt.includes('黑衣'),'design must reach actual prompt');
  const work=engine.execute('e2',{stage:'author',packageIds:['p1']});await started;
  const before=await engine.read('e2'),fingerprint=before.operations.at(-1).fingerprint;
  const next=initial();next.materials.push({id:'asset:CH99',version:'new',value:{design:'无关人物'}});
  next.boundary=makeBoundaryContext({seed,selected,actual:{...selected,version:'tail-v1',validated:true,states:receipt().entry,unit:{id:'u1',exitState:'甲接住钥匙。'}}});
  await engine.refreshProduction('e2',next);release();await work;
  const after=await engine.read('e2');assert.equal(after.operations.at(-1).fingerprint,fingerprint);
  assert.equal(after.candidates.at(-1).status,'adopted');assert.equal(after.production.boundaryCheck.status,'MATCHED');
  assert.equal(requests.length,2,'late compatible material does not rerun');
  assert.equal(after.operations.at(-1).productionSnapshot.episodeBoundary.mode,'PRELIMINARY');
  const saved=JSON.stringify(after.operations);await engine.refreshProduction('e2',next);assert.equal(JSON.stringify((await engine.read('e2')).operations),saved);
 }finally{release();await rm(directory,{recursive:true,force:true});}
});

test('completed task receives local needs after actual arrival; superseded revision cannot win',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'production-late-')),f=tailFixture(),seen=[];
 const engine=createEngine({directory,modelRunner:async request=>{seen.push(request);return {output:request.stage==='plan'?{...f.plan,productionFeedback:receipt()}:{...tailDraft(request),productionFeedback:receipt()},usage:{totalTokens:1}};}});
 try{
  await engine.create({id:'e2',source:f.source,settings:f.settings,production:initial()});await engine.execute('e2',{stage:'plan'});
  for(const packageId of ['p1','p2','p3'])await engine.execute('e2',{stage:'author',packageIds:[packageId]});
  await engine.execute('e2',{stage:'finish',packageIds:['p1','p2','p3']});await engine.assemble('e2');
  assert.equal((await engine.read('e2')).status,'text_ready_for_review');const calls=seen.length;
  const next=initial();next.boundary=makeBoundaryContext({seed,selected,actual:{...selected,version:'tail-v2',validated:true,states:[{...receipt().entry[0],value:'乙'}],unit:{id:'u1',exitState:'乙握钥匙。'}}});
  await engine.refreshProduction('e2',next);const d=await engine.read('e2');
  assert.equal(d.production.boundaryCheck.status,'REPAIR_REQUIRED');assert.deepEqual(d.production.pendingRepair.packageIds,['p1']);assert.equal(seen.length,calls);
  const old=initial();old.boundary.selected.selectionRevision=0;
  await assert.rejects(engine.refreshProduction('e2',old),{code:'PRODUCTION_REVISION'});
  assert.equal(digest((await engine.read('e2')).operations),digest(d.operations));
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('supplying requested material unlocks local work without erasing the original need',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'production-need-')),f=tailFixture();
 const need={stage:2,target:'CH01',purpose:'明确连续动作可用的袖口',packageIds:['p1'],sourceRefs:['s1'],blocking:true};
 const engine=createEngine({directory,modelRunner:async request=>({output:request.stage==='plan'?{...f.plan,productionFeedback:{...receipt(),needs:[need]}}:{...tailDraft(request),productionFeedback:receipt()},usage:{totalTokens:1}})});
 try{
  await engine.create({id:'e2',source:f.source,settings:f.settings,production:initial()});await engine.execute('e2',{stage:'plan'});
  assert.equal((await engine.read('e2')).production.blocking,true);
  const next=initial();next.materials[0]={id:'asset:CH01',version:'v2',value:{assetKey:'CH01',design:'黑衣，宽袖口'}};
  await engine.refreshProduction('e2',next);assert.equal((await engine.read('e2')).production.blocking,false);
  await engine.execute('e2',{stage:'author',packageIds:['p1']});const done=await engine.read('e2');
  assert.equal(done.production.needs[0].resolved,true);assert.equal(done.candidates[0].productionFeedback.needs[0].blocking,true);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('consumer-projected V1 card resolves its supplied need by semantic scope, not catalog hash',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'production-projected-need-')),f=tailFixture();
 const need={stage:2,target:'CH01',purpose:'确定采用袖口',packageIds:['p1'],sourceRefs:['s1'],blocking:true};
 const engine=createEngine({directory,modelRunner:async r=>({output:r.stage==='plan'?{...f.plan,productionFeedback:{...receipt(),needs:[need]}}:{...tailDraft(r),productionFeedback:receipt()},usage:{totalTokens:1}})});
 try{
  const context=initial();context.materials[0].kind='ASSET_PRODUCTION_CARD';context.materials[0].value={schema:'ASSET_PRODUCTION_CARD_V1',assetKey:'CH01',name:'甲',type:'CH',applicable:{episode:2,sceneKeys:[]},sourceFacts:[],adoptedDesign:null};
  await engine.create({id:'e2',source:f.source,settings:f.settings,production:context});await engine.execute('e2',{stage:'plan'});
  const next=structuredClone(context);next.materials[0].version='catalog-v2';next.materials[0].value.adoptedDesign={brief:'宽袖口',provenance:'ADOPTED_DESIGN_NOT_SOURCE_FACT',version:1};
  await engine.refreshProduction('e2',next);await engine.execute('e2',{stage:'author',packageIds:['p1']});
  assert.equal((await engine.read('e2')).production.needs[0].resolved,true);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('free quote-index refresh never repurchases consumed creation or unlocks an unfilled design need',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'production-index-refresh-')),f=tailFixture(),seen=[];
 const need={stage:2,target:'CH01',purpose:'确定采用袖口',packageIds:['p1'],sourceRefs:['s1'],blocking:true};
 const engine=createEngine({directory,modelRunner:async r=>{seen.push(r);return {output:r.stage==='plan'?{...f.plan,productionFeedback:{...receipt(),needs:r.source.key==='blocked'?[need]:[]}}:{...tailDraft(r),productionFeedback:receipt()},usage:{totalTokens:1}};}});
 try{
  const context=initial();context.materials[0].kind='ASSET_PRODUCTION_CARD';context.materials[0].value={schema:'ASSET_PRODUCTION_CARD_V1',assetKey:'CH01',name:'甲',type:'CH',applicable:{episode:2,sceneKeys:[]},sourceFacts:[],adoptedDesign:null};
  await engine.create({id:'e2',source:f.source,settings:f.settings,production:context});await engine.execute('e2',{stage:'plan'});await engine.execute('e2',{stage:'author',packageIds:['p1']});
  const before=await engine.read('e2'),quote=f.source.sourceRows[0].text;
  const next=structuredClone(context);next.materials[0].version='reindexed';next.materials[0].value.sourceFacts=[{id:'f1',quote,claim:'CHARACTER_CLAIM',association:'ASSET_NAME',evidence:{domain:'EPISODE',episode:2,start:0,end:quote.length}}];
  await engine.refreshProduction('e2',next);const after=await engine.read('e2');
  assert.equal(after.production.pendingRepair,null);assert.equal(seen.length,2);assert.deepEqual(after.operations,before.operations);assert.deepEqual(after.candidates,before.candidates);
  const design=structuredClone(next);design.materials[0].version='adopted-new';design.materials[0].value.adoptedDesign={brief:'宽袖口',provenance:'ADOPTED_DESIGN_NOT_SOURCE_FACT',version:1};
  await engine.refreshProduction('e2',design);assert.deepEqual((await engine.read('e2')).production.pendingRepair.packageIds,['p1']);assert.equal(seen.length,2,'real design changes wait for scoped repair, not automatic repurchase');
  await engine.create({id:'blocked',source:{...f.source,key:'blocked'},settings:f.settings,production:context});await engine.execute('blocked',{stage:'plan'});
  await engine.refreshProduction('blocked',next);const blocked=await engine.read('blocked');
  assert.equal(blocked.production.needs[0].supplyUpdated,false);assert.equal(blocked.production.needs[0].blocking,true,'index duplication is not the requested design supplement');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('one consumer material change repairs that package first; unchanged tail never repurchases its dependent',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'production-direct-consumer-')),f=tailFixture(),seen=[];
 const engine=createEngine({directory,modelRunner:async r=>{
  seen.push({stage:r.stage,ids:r.packageIds});
  const feedback={...receipt(),usedMaterialIds:r.stage==='plan'||r.packageIds.includes('p2')?['asset:SC02']:[]};
  if(r.stage==='plan')return {output:{...f.plan,productionFeedback:feedback},usage:{totalTokens:1}};
  let output=tailDraft(r);
  if(r.finishMode==='delta'){
   const base=JSON.parse(r.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以')[0]).previousDraft;
   const unit=structuredClone(base.units[0]);unit.shots[0].lighting='同一窗光在已采用的墙面形成柔和反射';
   output={schemaVersion:DELTA_VERSION,baseDraftHash:r.baseDraftHash,retainedUnitIds:base.units.slice(1).map(u=>u.id),replacements:[{replaces:[unit.id],units:[unit],fantasyRealization:[]}],revisionNotes:[],unresolved:[]};
  }
  return {output:{...output,productionFeedback:feedback},usage:{totalTokens:1}};
 }});
 try{
  const context=initial();context.materials=[{id:'asset:SC02',version:'v1',value:{assetKey:'SC02',wall:'白墙'}}];
  await engine.create({id:'e2',source:f.source,settings:f.settings,production:context});await engine.execute('e2',{stage:'plan'});
  for(const packageId of ['p1','p2','p3'])await engine.execute('e2',{stage:'author',packageIds:[packageId]});
  const before=await engine.read('e2'),dependent=structuredClone(before.adopted.find(a=>a.packageIds.includes('p3')));
  const next=structuredClone(context);next.materials[0]={id:'asset:SC02',version:'v2',value:{assetKey:'SC02',wall:'浅灰墙'}};
  await engine.refreshProduction('e2',next);const pending=(await engine.read('e2')).production.pendingRepair;
  assert.deepEqual(pending.packageIds,['p2'],'do not predict that the still-identical exit will require p3');assert.deepEqual(pending.changedKeys,['asset:SC02/value.wall']);
  await engine.execute('e2',{stage:'finish',packageIds:['p2'],finishMode:'delta'});const done=await engine.read('e2');
  assert.equal(done.candidates.at(-1).status,'adopted',JSON.stringify(done.candidates.at(-1).errors));assert.equal(done.production.pendingRepair,null);
  assert.deepEqual(done.adopted.find(a=>a.packageIds.includes('p3')),dependent);assert.deepEqual(seen.at(-1),{stage:'finish',ids:['p2']});assert.equal(seen.length,5);
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('same selected run late older result cannot replace its newer tail, including a newer withdrawal',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'production-order-')),f=tailFixture();
 const engine=createEngine({directory,modelRunner:async()=>assert.fail('no model needed')});
 try{
  const created=await engine.create({id:'e2',source:f.source,settings:f.settings,production:initial()});
  assert.equal(created.documentRevision,1);
  const old={...initial(),predecessorRevision:8};old.boundary=makeBoundaryContext({seed,selected,actual:{...selected,version:'old',validated:true,states:receipt().entry,unit:{id:'old'}}});
  const newer={...old,predecessorRevision:9,boundary:makeBoundaryContext({seed,selected,actual:{...selected,version:'new',validated:true,states:receipt().entry,unit:{id:'new'}}})};
  await engine.refreshProduction('e2',newer);
  await assert.rejects(engine.refreshProduction('e2',old),{code:'PRODUCTION_REVISION'});
  assert.equal((await engine.read('e2')).production.boundary.actual.version,'new');
  await engine.refreshProduction('e2',{...initial(),predecessorRevision:10});
  await assert.rejects(engine.refreshProduction('e2',newer),{code:'PRODUCTION_REVISION'});
  assert.equal((await engine.read('e2')).production.boundary.actual,null);
  assert.equal((await engine.read('e2')).documentRevision,3,'failed old writes must not advance document revision');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('shared outgoing agreement reaches plan and last author only, with immutable responsibility',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'production-agreement-scope-')),f=tailFixture(),seen=[];
 const engine=createEngine({directory,modelRunner:async request=>{seen.push(request);return {output:request.stage==='plan'?{...f.plan,productionFeedback:receipt()}:{...tailDraft(request),productionFeedback:{...receipt(),exit:request.productionSnapshot.touchesEnding?request.productionSnapshot.outgoingAgreements:[]}},usage:{totalTokens:1}};}});
 try{
  const production=initial();production.outgoingAgreements=[{key:'PR01/receiver',value:'乙',authority:'DESIGN',sourceRefs:[]}];
  await engine.create({id:'e2',source:f.source,settings:f.settings,production});await engine.execute('e2',{stage:'plan'});
  for(const packageId of ['p1','p2','p3'])await engine.execute('e2',{stage:'author',packageIds:[packageId]});
  assert.equal(seen[0].productionSnapshot.outgoingAgreements.length,1);
  assert.equal(seen[1].productionSnapshot.outgoingAgreements.length,0);assert.equal(seen[1].productionSnapshot.touchesEnding,false);
  assert.equal(seen[3].productionSnapshot.outgoingAgreements.length,1);assert.equal(seen[3].productionSnapshot.touchesEnding,true);
  assert.ok(seen[3].prompt.includes('outgoingAgreements'));assert.equal((await engine.read('e2')).candidates.at(-1).status,'adopted');
 }finally{await rm(directory,{recursive:true,force:true});}
});
test('local cross-episode repair expands an actually changed in-episode continuation, then stops at completion',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'production-linked-repair-')),f=tailFixture(),calls=[];
 let context=initial();
 const coordinator=createCoordinator({dataRoot:directory,loadProductionContext:async()=>context,modelRunner:async request=>{
  calls.push({stage:request.stage,ids:request.packageIds,actual:Boolean(request.episodeBoundary?.actual)});
  const feedback=receipt();if(request.episodeBoundary?.actual)feedback.entry[0].value='乙';
  let output=request.stage==='plan'?f.plan:tailDraft(request);
  if(request.finishMode==='delta'){
   const units=structuredClone(request.productionSnapshot?JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n请以')[0]).previousDraft.units:[]);
   const replace=request.episodeBoundary?.actual?units.findLast(u=>u.id.startsWith('p1-')):null;
   if(replace)replace.exitState='乙持钥匙，已完成本段动作。';
   output={schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:units.filter(u=>u.id!==replace?.id).map(u=>u.id),replacements:replace?[{replaces:[replace.id],units:[replace],fantasyRealization:[]}]:[],revisionNotes:[],unresolved:[]};
  }
  return {output:{...output,productionFeedback:feedback},usage:{totalTokens:1}};
 }});
 try{
  const run=await coordinator.create({source:f.source,settings:f.settings,production:context,binding:{projectId:'test',episodeId:'ep2',episodeNumber:2,sourceVersion:'s'}});
  await coordinator.start(run.id);await coordinator.wait(run.id);assert.equal((await coordinator.read(run.id)).status,'text_ready_for_review');const before=calls.length;
  context={...context,boundary:makeBoundaryContext({seed,selected,actual:{...selected,version:'late-tail',validated:true,states:[{...receipt().entry[0],value:'乙'}],unit:{id:'e1-tail',exitState:'乙持钥匙。'}}})};
  await coordinator.start(run.id);await coordinator.wait(run.id);
  const final=await coordinator.read(run.id);
  assert.equal(final.status,'text_ready_for_review',JSON.stringify({status:final.status,progress:final.web.progress,pending:final.production.pendingRepair,candidates:final.candidates.map(c=>({status:c.status,ids:c.packageIds,required:c.requiredPackageIds,errors:c.errors}))}));
  assert.deepEqual(calls.slice(before).map(c=>c.ids),[['p1'],['p1','p2','p3']]);
  assert.equal(final.production.pendingRepair,null);assert.equal(final.production.boundaryCheck.status,'MATCHED');
  const count=calls.length;await coordinator.start(run.id);await coordinator.wait(run.id);assert.equal(calls.length,count);
 }finally{await coordinator.shutdown();await rm(directory,{recursive:true,force:true});}
});
test('archiving an adopted predecessor advances its revision so a late former tail cannot return',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'production-withdrawal-')),f=tailFixture();
 const coordinator=createCoordinator({dataRoot:directory,modelRunner:async request=>({output:request.stage==='plan'?{...f.plan,productionFeedback:receipt()}:{...tailDraft(request),productionFeedback:receipt()},usage:{totalTokens:1}})});
 try{
  const run=await coordinator.create({source:f.source,settings:f.settings,production:initial(),binding:{projectId:'test',episodeId:'e2',episodeNumber:2,sourceVersion:'s'}});
  await coordinator.start(run.id);await coordinator.wait(run.id);const adopted=await coordinator.read(run.id);
  assert.equal(adopted.status,'text_ready_for_review');assert.ok(adopted.assembly);
  const reset=await coordinator.choose(run.id,{mode:adopted.choice.mode,resetDrafts:true});
  assert.equal(reset.assembly,null);assert.ok(reset.documentRevision>adopted.documentRevision,'withdrawing a tail is a newer source-run result');
 }finally{await coordinator.shutdown();await rm(directory,{recursive:true,force:true});}
});
