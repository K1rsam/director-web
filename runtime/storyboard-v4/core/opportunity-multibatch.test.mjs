import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,seeded,draftForRequest} from './execution-batch-test-fixtures.mjs';
import {createEngine,rebuildFrozenRequest} from './pipeline.mjs';
import {DELTA_VERSION} from './delta.mjs';
import {digest} from './shared.mjs';

const fingerprint=r=>digest([r.promptHash,r.instructionHash,r.inputHash]);
function data(){const f=fixture(6);f.settings.fantasyMode=f.choice.mode='recommended';return f;}
function sibling(f){
 f.source.sourceRows.push({id:'small',text:'△乙在门口等候。'});
 f.plan.events.push({...structuredClone(f.plan.events[0]),id:'e2',sourceRefs:['small'],sceneKey:'门口',boundaryBefore:{kind:'new_event',reason:'独立等候'}});
 f.plan.workPackages.push({...structuredClone(f.plan.workPackages[0]),id:'p2',eventId:'e2',sourceRefs:['small']});
 f.plan.provisionalUnits.push({id:'pu-small',packageId:'p2',sourceRefs:['small'],secondsRange:[2,4]});return f;
}
function supplemented(r){
 const out=draftForRequest(r),unit=out.units[0],shot=unit.shots[0],id='extra-'+(r.executionBatch?.id??r.packageId);
 const point={id,anchorRefs:[shot.sourceRefs[0]],subject:'甲',emotionPurpose:'等待与误会的主观反差',recommended:true,proposal:'主观期待光圈骤亮后缩回现实，不改变人物知情与位置',screenSecondsRange:[.5,1],extraSecondsRange:[0,0]};
 shot.picture+='甲主观期待的光圈骤亮后缩回现实。';
 out.fantasySupplements=[point];out.fantasyRealization.push({candidateId:id,unitIds:[unit.id],screenSpans:[{shotId:shot.id,range:[1,1.7]}],entry:'随期待骤亮',exit:'回到原现实相位',domain:'主观比喻而非现实能力',preservedFunction:point.emotionPurpose,status:'realized'});return out;
}
function retained(r){const item=r.schema.properties.retainedUnitIds.items;return {schemaVersion:DELTA_VERSION,baseDraftHash:r.baseDraftHash,retainedUnitIds:item.$ref?r.schema.$defs[item.$ref.split('/').at(-1)].enum:item.enum,replacements:[],fantasySupplements:[],revisionNotes:[],unresolved:[]};}

test('new multi-batch author may append in each batch and finish/assemble without changing paid requests',async t=>{
 const x=await seeded(t,async r=>({output:r.stage==='finish'?retained(r):supplemented(r)}),data());
 const first=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'first'});
 assert.equal(x.requests[0].opportunityPolicy.allowSupplements,true);
 assert.equal(first.candidates.at(-1).status,'adopted');assert.equal(first.plan.fantasyCandidates.length,1);
 const manifest=structuredClone(first.executionBatches.p1),op=structuredClone(first.operations[0]);
 const second=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'second'});
 assert.equal(second.candidates.at(-1).status,'adopted');assert.equal(second.plan.fantasyCandidates.length,2);
 assert.equal(second.executionBatches.p1.hash,manifest.hash);assert.equal(second.executionBatches.p1.baseHash,manifest.baseHash);
 assert.equal(fingerprint(rebuildFrozenRequest(second,op)),op.fingerprint);
 await x.engine.execute('batch',{stage:'finish',packageId:'p1',attemptId:'finish',finishMode:'delta'});
 const final=await x.engine.assemble('batch');assert.equal(final.status,'text_ready_for_review');assert.equal(final.assembly.validation.stats.realizedFantasy,2);assert.equal(x.requests.length,3);
});

test('a sibling append cannot invalidate the paid manifest or its later batch',async t=>{
 const x=await seeded(t,async r=>({output:r.packageId==='p2'?supplemented(r):draftForRequest(r)}),sibling(data()));
 const first=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'large-first'}),original=structuredClone(first.executionBatches.p1),paid=structuredClone(first.operations[0]);
 const small=await x.engine.execute('batch',{stage:'author',packageId:'p2',attemptId:'small'});
 assert.equal(small.candidates.at(-1).status,'adopted');assert.equal(small.plan.fantasyCandidates.length,1);
 const final=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'large-second'});
 assert.equal(final.candidates.at(-1).status,'adopted');assert.equal(Object.keys(final.executionBatches.p1.accepted).length,2);
 assert.equal(final.executionBatches.p1.hash,original.hash);assert.equal(fingerprint(rebuildFrozenRequest(final,paid)),paid.fingerprint);
});

test('a restarted engine rebuilds the same frozen request after an automatic append',async t=>{
 const x=await seeded(t,async r=>({output:supplemented(r)}),data());const first=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'first'});
 assert.equal(first.candidates.at(-1).status,'adopted');
 const engine=createEngine({directory:x.directory,modelRunner:async r=>({output:supplemented(r),requestOutcome:'RESPONDED'})});
 const next=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'after-restart'});
 assert.equal(next.candidates.at(-1).status,'adopted');assert.equal(next.plan.fantasyCandidates.length,2);
 assert.equal(fingerprint(rebuildFrozenRequest(next,first.operations[0])),first.operations[0].fingerprint);
});

test('ordinary whole-package finishing can realize a new opportunity across earlier execution boundaries',async t=>{
 const x=await seeded(t,async r=>{
  if(r.stage==='author')return {output:draftForRequest(r)};
  const output=draftForRequest(r),first=output.units[0],last=output.units.at(-1),id='cross-boundary';
  const point={id,anchorRefs:['s1','s6'],subject:'甲',emotionPurpose:'多次犹豫落到最终决定',recommended:true,proposal:'首尾以同一主观光圈呼应，末拍落回现实，不改变原台词与因果',screenSecondsRange:[.5,1],extraSecondsRange:[0,0]};
  const f={candidateId:id,unitIds:[first.id,last.id],screenSpans:[{shotId:first.shots[0].id,range:[1,1.4]},{shotId:last.shots[0].id,range:[1,1.4]}],entry:'随源第一拍期待出现',exit:'末拍落回原现实',domain:'主观比喻',preservedFunction:point.emotionPurpose,status:'realized'};
  for(const unit of [first,last])unit.shots[0].picture+='主观期待光圈按前后呼应亮起又落回现实。';
  const prior=retained(r).retainedUnitIds;
  return {output:{schemaVersion:DELTA_VERSION,baseDraftHash:r.baseDraftHash,retainedUnitIds:[],replacements:[{replaces:prior,units:output.units,fantasyRealization:[f]}],fantasySupplements:[point],revisionNotes:[],unresolved:[]}};
 },data());
 await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'first'});const second=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'second'}),original=structuredClone(second.executionBatches.p1);
 const finished=await x.engine.execute('batch',{stage:'finish',packageId:'p1',attemptId:'finish',finishMode:'delta'});
 assert.equal(finished.candidates.at(-1).status,'adopted');assert.equal(finished.plan.fantasyCandidates[0].id,'cross-boundary');assert.deepEqual(finished.executionBatches.p1,original);
 const ready=await x.engine.assemble('batch');assert.equal(ready.status,'text_ready_for_review');assert.equal(ready.assembly.validation.stats.realizedFantasy,1);assert.equal(x.requests.length,3);
});

test('concurrent independent package responses append atomically and original batch keeps progressing',async t=>{
 const releases={},started={};const gates=['p1','p2'].map(id=>new Promise(resolve=>started[id]=resolve));
 const x=await seeded(t,async r=>{if(!r.executionBatch?.index&&r.stage==='author'){started[r.packageId]();await new Promise(resolve=>releases[r.packageId]=resolve);}return {output:r.stage==='finish'?retained(r):supplemented(r)};},sibling(data()));
 const a=x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'large'}),b=x.engine.execute('batch',{stage:'author',packageId:'p2',attemptId:'small'});await Promise.all(gates);
 releases.p2();await b;releases.p1();await a;
 const before=await x.engine.read('batch');assert.equal(before.plan.fantasyCandidates.length,2);assert.ok(before.candidates.every(c=>c.status==='adopted'));
 for(const op of before.operations)assert.equal(fingerprint(rebuildFrozenRequest(before,op)),op.fingerprint);
 await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'large-next'});
 await x.engine.execute('batch',{stage:'finish',packageIds:['p1','p2'],attemptId:'final',finishMode:'delta'});
 const final=await x.engine.assemble('batch');assert.equal(final.status,'text_ready_for_review');assert.equal(final.plan.fantasyCandidates.length,3);assert.equal(x.requests.length,4);
});

for(const defect of ['context-only anchor','invalid timing','unrealized','duplicate'])test(`invalid multi-batch supplement is saved without changing manifest, choice or plan: ${defect}`,async t=>{
 const x=await seeded(t,async r=>{const output=supplemented(r);if(defect==='context-only anchor')output.fantasySupplements[0].anchorRefs=['s6'];if(defect==='invalid timing')output.fantasyRealization[0].screenSpans[0].range=[1,99];if(defect==='unrealized')output.fantasyRealization[0].status='not_realized';if(defect==='duplicate')output.fantasySupplements.push(structuredClone(output.fantasySupplements[0]));return {output};},data());
 const before=await x.engine.read('batch'),d=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'bad'});
 assert.equal(d.candidates.at(-1).status,'needs_repair');assert.deepEqual(d.plan,before.plan);assert.deepEqual(d.choice,before.choice);assert.deepEqual(d.adopted,[]);assert.deepEqual(d.executionBatches.p1.accepted,{});assert.equal(d.candidates.at(-1).output.fantasySupplements.length,defect==='duplicate'?2:1);assert.equal(x.requests.length,1);
});

test('whole-package validation failure leaves the new final-batch append and acceptance uncommitted',async t=>{
 const x=await seeded(t,async r=>({output:supplemented(r)}),data());const first=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'first'});
 await x.store.update('batch',d=>{d.candidates.find(c=>c.attemptId==='first').draft.fantasyRealization=[];return d;});
 const d=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'second'});
 assert.equal(d.candidates.at(-1).status,'needs_repair');assert.deepEqual(d.plan,first.plan);assert.deepEqual(d.executionBatches.p1.accepted,first.executionBatches.p1.accepted);assert.deepEqual(d.adopted,[]);
});

test('cancelled late batch cannot append; partial paid work still refuses a choice change',async t=>{
 let started,release;const gate=new Promise(r=>started=r);const x=await seeded(t,async r=>{started();await new Promise(r=>release=r);return {output:supplemented(r)};},data());
 const call=x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'late'});await gate;await x.engine.cancel('batch');release();await call;
 const d=await x.engine.read('batch');assert.equal(d.candidates.at(-1).status,'cancelled_late');assert.deepEqual(d.plan.fantasyCandidates,[]);assert.deepEqual(d.executionBatches.p1.accepted,{});
 await assert.rejects(x.engine.setFantasyMode('batch','off'),{code:'RESET_DRAFTS_REQUIRED'});assert.equal(x.requests.length,1);
});

test('unchanged batch free recheck is append-idempotent, with original raw and manifest identity retained',async t=>{
 const x=await seeded(t,async r=>({output:supplemented(r)}),data());const first=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'first'}),original=first.candidates.at(-1);
 const second=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'second'});
 const checked=await x.engine.recheckCandidate('batch',original.id);
 assert.deepEqual(checked.plan,second.plan);assert.equal(checked.executionBatches.p1.hash,second.executionBatches.p1.hash);assert.deepEqual(checked.adopted,second.adopted);assert.equal(checked.candidates.find(c=>c.id===original.id).raw,original.raw);assert.equal(x.requests.length,2);
});

for(const change of ['choice','definition','source','skeleton','unknown version'])test(`frozen batch fails closed for real ${change} drift instead of filtering it away`,async t=>{
 const x=await seeded(t,async r=>({output:supplemented(r)}),data());const first=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'first'});
 await x.store.update('batch',d=>{if(change==='choice')d.choice.mode='off';if(change==='definition')d.plan.fantasyCandidates[0].proposal+='changed';if(change==='source')d.source.sourceRows[0].text+='changed';if(change==='skeleton')d.plan.provisionalUnits[0].secondsRange=[27,30];if(change==='unknown version')d.executionBatches.p1.version='future';return d;});
 await assert.rejects(x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'must-not-dispatch'}));
 const d=await x.engine.read('batch');assert.equal(d.operations.length,first.operations.length);assert.equal(x.requests.length,1);
});
