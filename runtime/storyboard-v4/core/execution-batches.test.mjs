import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest} from './core.mjs';
import {digest} from './shared.mjs';
import {DELTA_VERSION} from './delta.mjs';
import {buildExecutionBatches} from './execution-batches.mjs';
import {executionState,hasExecutionDrafts} from './pipeline.mjs';
import {fixture,draftForRequest as draftFor,seeded,v3Fixture} from './execution-batch-test-fixtures.mjs';

test('oversized event authoring stages five complete provisional units, then adopts the whole parent only after the second request',async t=>{
 const {engine,requests}=await seeded(t);
 let d=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'batch1'});
 assert.equal(requests[0].source.dialogue.length,5,'one request must not author the entire nine-unit event');
 assert.equal(d.adopted.length,0,'partial event must not unlock dependents or finishing');
 assert.equal(d.executionBatches.p1.batches.length,2);
 assert.equal(Object.keys(d.executionBatches.p1.accepted).length,1);
 d=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'batch2'});
 assert.equal(requests[1].source.dialogue.length,4);
 assert.equal(requests[1].executionBatch.predecessor.unit.exitState,requests[0].source.dialogue.at(-1).id.replace(/^/,'已说完'));
 assert.equal(d.adopted.length,1);assert.equal(d.adopted[0].draft.units.length,9);
 assert.equal(d.adopted[0].stage,'author');assert.equal(d.adopted[0].candidateIds.length,2);
 assert.equal(new Set(d.adopted[0].draft.units.map(u=>u.id)).size,9);
 assert.deepEqual(requests[0].snapshot,requests[1].snapshot,'creative rules are not reduced between batches');
 assert.deepEqual(requests[1].plan.events,requests[0].plan.events);
 assert.ok(requests[1].source.contextRows.some(r=>r.id==='s1'));
});

test('a completed batch survives an unknown second request and only the missing batch is retried after explicit acknowledgement',async t=>{
 let count=0;const {engine,store,requests}=await seeded(t,async r=>{if(++count===2)throw Object.assign(new Error('timeout'),{code:'TIMEOUT',requestOutcome:'UNKNOWN'});return {output:draftFor(r)};});
 await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'first'});
 await assert.rejects(engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'unknown'}),e=>e.code==='TIMEOUT');
 await assert.rejects(engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'blocked'}),e=>e.code==='SCOPE_BUSY');
 await store.update('batch',d=>{d.operations.at(-1).cancelAcknowledgement={acceptUnknownUsage:true};return d;});
 const d=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'continued'});
 assert.deepEqual(requests.map(r=>r.source.dialogue.length),[5,4,4]);
 assert.equal(d.operations.find(o=>o.attemptId==='unknown').status,'unknown');assert.equal(d.adopted.length,1);
});

test('v3 synthetic fixture respects cross-unit fantasy ownership without modifying its original plan',async t=>{
 const f=await v3Fixture();
 const before=structuredClone(f.plan),{engine,requests}=await seeded(t,async r=>({output:draftFor(r)}),f);
 await engine.execute('batch',{stage:'author',packageId:'WP01',attemptId:'v3'});
 assert.deepEqual(requests[0].plan.provisionalUnits.map(u=>u.id),['U01','U02','U03','U04','U05']);
 assert.equal(requests[0].source.dialogue.length,20);
 assert.deepEqual(requests[0].selection.selectedIds,['FC01','FC02','FC03']);
 assert.equal((await engine.read('batch')).plan.workPackages.length,1);
 assert.deepEqual(f.plan,before);
});

test('small work packages keep the old request shape and never acquire a batch ledger',async t=>{
 const {engine,requests}=await seeded(t,undefined,fixture(2)),before=await engine.read('batch');
 const old=buildRequest({stage:'author',source:before.source,settings:before.settings,plan:before.plan,choice:before.choice,packageIds:['p1'],rulesSnapshot:before.rulesSnapshot,dependencyExits:{},issues:[],finishMode:'full'});
 const d=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'small'});
 assert.equal(d.executionBatches,undefined);assert.equal(d.operations[0].executionProjectionVersion,undefined);
 assert.equal(requests[0].prompt,old.prompt);assert.equal(requests[0].inputHash,old.inputHash);
 assert.equal(d.operations[0].fingerprint,digest([old.promptHash,old.instructionHash,old.inputHash]));
});

const previousIds=request=>{
 const item=request.schema.properties.retainedUnitIds.items;
 return item.$ref?request.schema.$defs[item.$ref.split('/').at(-1)].enum:item.enum;
};
const retainAll=request=>({schemaVersion:DELTA_VERSION,baseDraftHash:request.baseDraftHash,retainedUnitIds:previousIds(request),replacements:[],revisionNotes:[],unresolved:[]});

for(const packedAuthor of [false,true])test(`temporary ${packedAuthor?'packed':'unpacked'} batch units do not consume the final whole-event unit count`,async t=>{
 const f=fixture();f.settings.maxUnits=3;
 const {engine,requests}=await seeded(t,async r=>{
  const draft=draftFor(r);
  if(r.stage==='finish')return {output:{schemaVersion:DELTA_VERSION,baseDraftHash:r.baseDraftHash,retainedUnitIds:[],replacements:[{replaces:previousIds(r),units:draft.units,fantasyRealization:draft.fantasyRealization}],revisionNotes:[],unresolved:[]}};
  if(packedAuthor){const units=[];for(let i=0;i<draft.units.length;i+=3){const group=draft.units.slice(i,i+3);units.push({...group[0],exitState:group.at(-1).exitState,shots:group.flatMap(u=>u.shots)});}draft.units=units;}
  return {output:draft};
 },f);
 const first=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'count1'});
 assert.equal(executionState(first,'p1').completed,1,'local staging is not final unit packing');
 const both=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'count2'});
 assert.equal(both.adopted.length,1,'temporary cross-batch boundaries must not block whole-event finishing');
 assert.equal(both.adopted[0].draft.units.length,packedAuthor?4:9);assert.equal(both.settings.maxUnits,3);
 await engine.execute('batch',{stage:'finish',packageId:'p1',attemptId:'count-finish',finishMode:'delta'});
 const final=await engine.assemble('batch');assert.equal(final.status,'text_ready_for_review');
 assert.equal(final.assembly.validation.stats.units,3);assert.equal(final.assembly.validation.stats.seconds,90);
 assert.ok(requests.every(r=>r.settings.maxUnits===3),'the paid request keeps the user final budget');
});

test('batch staging defers only maxUnits while final finishing still enforces the requested count',async t=>{
 const f=fixture();f.settings.maxUnits=2;const {engine}=await seeded(t,undefined,f);
 await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'limit1'});
 const both=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'limit2'});assert.equal(both.adopted.length,1);
 const finished=await engine.execute('batch',{stage:'finish',packageId:'p1',attemptId:'limit-finish'});
 assert.equal(finished.candidates.at(-1).status,'needs_repair');assert.ok(finished.candidates.at(-1).validation.errors.some(e=>e.code==='MAX_UNITS'));
 await assert.rejects(engine.assemble('batch'),e=>e.code==='FINISH_REQUIRED');
});

for(const code of ['UNIT_DURATION','DIALOGUE_CONTENT'])test(`batch staging retains fatal ${code} validation despite deferring final maxUnits`,async t=>{
 const f=fixture();f.settings.maxUnits=2;const {engine}=await seeded(t,async r=>{const output=draftFor(r);if(code==='UNIT_DURATION')output.units[0].shots[0].duration=31;else output.units[0].shots[0].dialogueParts[0].text='错字';return {output};},f);
 const d=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'invalid-count'});
 assert.equal(executionState(d,'p1').completed,0);assert.equal(d.candidates.at(-1).status,'needs_repair');
 assert.ok(d.candidates.at(-1).validation.errors.some(e=>e.code===code));
 assert.ok(!d.candidates.at(-1).validation.errors.some(e=>e.code==='MAX_UNITS'));
});

test('rechecking unchanged earlier batch content preserves the predecessor identity and completed output',async t=>{
 const {engine}=await seeded(t,async r=>({output:r.stage==='finish'?retainAll(r):draftFor(r)}));
 const first=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'stable1'}),original=first.candidates.at(-1);
 const both=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'stable2'}),accepted=both.executionBatches.p1.accepted['p1-B01'];
 const checked=await engine.recheckCandidate('batch',original.id);
 assert.equal(checked.executionBatches.p1.accepted['p1-B01'],accepted);assert.deepEqual(checked.adopted,both.adopted);
 assert.equal(checked.candidates.at(-1).equivalentTo,accepted);
 await engine.execute('batch',{stage:'finish',packageId:'p1',attemptId:'stable-finish',finishMode:'delta'});
 const ready=await engine.assemble('batch'),again=await engine.recheckCandidate('batch',original.id);
 assert.deepEqual(again.adopted,ready.adopted);assert.deepEqual(again.assembly,ready.assembly);assert.equal(again.status,ready.status);
});

test('rechecking genuinely changed earlier batch content cannot replace a predecessor already used downstream',async t=>{
 const {engine,store}=await seeded(t);
 const first=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'changed1'}),original=first.candidates.at(-1);
 const both=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'changed2'});
 await store.update('batch',d=>{d.candidates.find(c=>c.id===original.id).output.units.at(-1).exitState='已经离开屋内';return d;});
 const checked=await engine.recheckCandidate('batch',original.id);
 assert.equal(checked.candidates.at(-1).status,'stale');assert.equal(checked.candidates.at(-1).errors[0].code,'EXECUTION_STALE');
 assert.equal(checked.executionBatches.p1.accepted['p1-B01'],original.id);assert.deepEqual(checked.adopted,both.adopted);
});

test('whole-event delta finishing still merges across execution batches and produces a fully validated assembly',async t=>{
 const {engine,requests}=await seeded(t,async r=>({output:r.stage==='finish'?retainAll(r):draftFor(r)}));
 await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'a1'});
 await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'a2'});
 await engine.execute('batch',{stage:'finish',packageId:'p1',attemptId:'f',finishMode:'delta'});
 const d=await engine.assemble('batch');
 assert.equal(requests[2].executionBatch,undefined);assert.equal(requests[2].source.dialogue.length,9);
 assert.equal(d.status,'text_ready_for_review');assert.deepEqual(d.assembly.validation.errors,[]);
 assert.equal(d.assembly.validation.stats.dialogueParts,9);
 assert.ok(d.assembly.draft.units.some(u=>u.segments?.some(s=>s.id.startsWith('p1-B01'))&&u.segments?.some(s=>s.id.startsWith('p1-B02'))));
});

test('v3 synthetic fixture completes both batches and final delta with all 34 quotes and five selected fantasies',async t=>{
 const f=await v3Fixture(),{engine,requests}=await seeded(t,async r=>({output:r.stage==='finish'?retainAll(r):draftFor(r)}),f);
 for(const [stage,attemptId] of [['author','v3a1'],['author','v3a2'],['finish','v3finish']])await engine.execute('batch',{stage,packageId:'WP01',attemptId,finishMode:'delta'});
 const d=await engine.assemble('batch');
 assert.deepEqual(requests.slice(0,2).map(r=>r.source.dialogue.length),[20,14]);
 assert.equal(d.status,'text_ready_for_review');assert.deepEqual(d.assembly.validation.errors,[]);
 assert.equal(d.assembly.validation.stats.dialogueParts,34);assert.equal(d.assembly.validation.stats.realizedFantasy,5);
 assert.deepEqual(requests[0].loadedFiles,requests[1].loadedFiles);
});

test('a malformed partial batch is repaired only in its own scope before later authoring continues',async t=>{
 let calls=0;const {engine,requests}=await seeded(t,async r=>{if(++calls===1)throw Object.assign(new Error('bad JSON'),{code:'INVALID_JSON',requestOutcome:'RESPONDED',raw:'{bad'});return {output:draftFor(r)};});
 await assert.rejects(engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'bad'}));
 let d=await engine.read('batch');assert.equal(hasExecutionDrafts(d),true);
 d=await engine.execute('batch',{stage:'finish',packageId:'p1',attemptId:'repair',finishMode:'delta'});
 assert.equal(requests[1].source.dialogue.length,5);assert.equal(requests[1].finishMode,'full');
 assert.equal(d.adopted.length,0);assert.equal(executionState(d,'p1').completed,1);
 assert.equal(d.candidates.find(c=>c.attemptId==='bad').resolvedBy,d.candidates.at(-1).id);
 d=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'next'});
 assert.equal(requests[2].source.dialogue.length,4);assert.equal(d.adopted[0].stage,'author');
});

test('a structured-invalid batch uses a local delta repair without editing earlier or future batches',async t=>{
 let calls=0;const {engine,requests}=await seeded(t,async r=>{const good=draftFor(r);if(++calls===1){good.units[0].shots[0].dialogueParts[0].text='漏字';return {output:good};}if(r.stage==='finish')return {output:{schemaVersion:DELTA_VERSION,baseDraftHash:r.baseDraftHash,retainedUnitIds:[],replacements:[{replaces:previousIds(r),units:good.units,fantasyRealization:good.fantasyRealization}],revisionNotes:[],unresolved:[]}};return {output:good};});
 await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'bad'});
 const d=await engine.execute('batch',{stage:'finish',packageId:'p1',attemptId:'repair',finishMode:'delta'});
 assert.equal(requests[1].finishMode,'delta');assert.equal(requests[1].source.dialogue.length,5);
 assert.equal(d.candidates.at(-1).status,'adopted');assert.equal(d.adopted.length,0);
});

test('a long OS spanning source rows is never split across execution requests',async t=>{
 const f=fixture();f.source.sourceRows[4].text='甲OS：'+ '这段内心独白必须原样连续保留。'.repeat(8);f.source.sourceRows[5].text='！';
 const {engine,requests}=await seeded(t,undefined,f);
 await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'a1'});
 await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'a2'});
 assert.deepEqual(requests.map(r=>r.plan.provisionalUnits.length),[4,5]);
 const os=requests[1].source.dialogue.find(q=>q.channel==='OS');assert.deepEqual(os.sourceIds,['s5','s6']);
 assert.ok(os.quote.endsWith('！'));assert.ok(!requests[0].source.dialogue.some(q=>q.id===os.id));
});

test('an indivisible fantasy may exceed soft execution targets without being cut or assigned a creative unit limit',async t=>{
 const f=fixture();f.settings.fantasyMode=f.choice.mode='all';f.plan.fantasyCandidates=[{id:'f1',anchorRefs:['s1','s9'],subject:'甲',emotionPurpose:'完整内心变化',recommended:true,proposal:'完整主观变化',screenSecondsRange:[10,20],extraSecondsRange:[0,5]}];
 const {engine}=await seeded(t,undefined,f),d=await engine.read('batch'),m=buildExecutionBatches({...d,packageId:'p1'});
 assert.equal(m.batches.length,1);assert.equal(m.batches[0].exceedsSoftTarget,true);assert.equal(d.settings.maxUnits,null);
});

test('partial paid work blocks plan, choice and rule changes until explicit archival removes the active manifest',async t=>{
 const {engine,store}=await seeded(t);await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'first'});
 const before=await engine.read('batch');assert.equal(hasExecutionDrafts(before),true);
 for(const act of [()=>engine.execute('batch',{stage:'plan',attemptId:'plan'}),()=>engine.setChoice('batch',before.choice),()=>engine.setFantasyMode('batch','all'),()=>engine.confirmChoice('batch',[],null),()=>engine.refreshRules('batch')])await assert.rejects(act(),e=>e.code==='RESET_DRAFTS_REQUIRED');
 assert.deepEqual(await engine.read('batch'),before);
 await store.update('batch',d=>{delete d.executionBatches;for(const c of d.candidates)c.resolvedBy='selection_reset';return d;});
 assert.equal(hasExecutionDrafts(await engine.read('batch')),false);
 const reset=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'after-reset'});
 assert.ok(reset.executionBatches,'old archived candidates must not prevent a fresh execution manifest');
 assert.equal(reset.executionBatches.p1.batches.length,2,'an explicit reset must not disable batching because old paid candidates remain in history');
 assert.equal(executionState(reset,'p1').completed,1);
});

test('full finishing refuses staged drafts whose predecessor changed after the following batch was authored',async t=>{
 const {engine,store}=await seeded(t,async r=>({output:r.stage==='finish'?retainAll(r):draftFor(r)}));
 await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'a1'});await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'a2'});
 await store.update('batch',d=>{const first=d.candidates.find(c=>c.attemptId==='a1');first.draft.units.at(-1).exitState='前批出口已经改变';return d;});
 await assert.rejects(engine.execute('batch',{stage:'finish',packageId:'p1',attemptId:'stale',finishMode:'delta'}),e=>e.code==='EXECUTION_STALE'||e.code==='STALE_ADOPTION');
});

test('a retired batch generation cannot replace new work after explicit reset even when plan and choice are identical',async t=>{
 const {engine,store}=await seeded(t);
 const first=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'old'}),old=first.candidates.at(-1);
 await store.update('batch',d=>{delete d.executionBatches;for(const c of d.candidates)c.resolvedBy='selection_reset';return d;});
 const current=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'current'}),accepted=current.executionBatches.p1.accepted['p1-B01'];
 const checked=await engine.recheckCandidate('batch',old.id);
 assert.equal(checked.candidates.at(-1).status,'stale');
 assert.equal(checked.executionBatches.p1.accepted['p1-B01'],accepted);
});

test('an archived late batch body does not disable a fresh execution manifest',async t=>{
 const {engine,store,requests}=await seeded(t);await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'old-late'});
 await store.update('batch',d=>{d.candidates.at(-1).status='cancelled_late';delete d.executionBatches;return d;});
 const current=await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'fresh-batch'});
 assert.equal(requests.at(-1).source.dialogue.length,5);assert.equal(executionState(current,'p1').completed,1);
 assert.equal(current.candidates[0].status,'cancelled_late');assert.equal(current.candidates[0].resolvedBy,undefined);
});

test('an unused manifest from a definitely unsent request can be replaced after an allowed choice change',async t=>{
 let calls=0;const {engine,requests}=await seeded(t,async r=>{if(++calls===1)throw Object.assign(new Error('not started'),{code:'CLI_FAILED',requestOutcome:'NOT_SENT'});return {output:draftFor(r)};});
 await assert.rejects(engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'not-sent'}));
 assert.equal(hasExecutionDrafts(await engine.read('batch')),false);
 await engine.setFantasyMode('batch','all');
 await assert.doesNotReject(engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'after-choice'}));
 assert.equal(requests.at(-1).source.dialogue.length,5);
 assert.equal(executionState(await engine.read('batch'),'p1').completed,1);
});
