import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules} from './core.mjs';
import {tailFixture,tailDraft} from './author-call-group-test-fixtures.mjs';
import {fixture,seeded,draftForRequest} from './execution-batch-test-fixtures.mjs';

const version='accepted-tail-v1';
const independent=()=>{const f=tailFixture();for(const w of f.plan.workPackages)w.dependsOn=[];return f;};
const author=(engine,id)=>engine.execute('batch',{stage:'author',packageId:id,attemptId:`author-${id}`});
const finish=(engine,ids,attemptId='finish')=>engine.execute('batch',{stage:'finish',packageIds:ids,attemptId});
const sourceIds=request=>request.source.sourceRows.map(r=>r.id);
const requestFor=(d,packageId,extra={})=>buildRequest({stage:'author',source:d.source,settings:d.settings,plan:d.plan,choice:d.choice,packageId,rulesSnapshot:d.rulesSnapshot,...extra});

test('new snapshots hand adjacent authors one adopted complete tail, linked fantasy and explicit scene boundary',async t=>{
 const f=independent();f.settings.fantasyMode=f.choice.mode='all';
 f.plan.fantasyCandidates=[{id:'f1',anchorRefs:['s3'],subject:'甲',emotionPurpose:'决定行动',recommended:true,proposal:'肩上的小化身推了一把',screenSecondsRange:[1,2],extraSecondsRange:[0,1]}];
 const {engine,requests}=await seeded(t,async r=>{const draft=tailDraft(r);if(r.packageId==='p1'){const unit=draft.units.at(-1);draft.fantasyRealization=[{candidateId:'f1',unitIds:[unit.id],shotIds:[unit.shots[0].id],screenSeconds:1,entry:'小化身出现',exit:'小化身隐去',domain:'主观',preservedFunction:'决定行动',status:'realized'}];}return {output:draft};},f);
 const first=await author(engine,'p1');await author(engine,'p2');
 assert.equal(first.rulesSnapshot.acceptedContinuityVersion,version);
 assert.equal(requests[0].plan.acceptedContinuity,undefined);
 const context=requests[1].plan.acceptedContinuity,adopted=first.adopted[0].draft;
 assert.ok(context,'ordinary adjacent packages need explicit adopted continuity even without dependsOn');
 assert.equal(context.version,version);assert.equal(context.packageId,'p1');
 assert.deepEqual(context.unit,adopted.units.at(-1));assert.deepEqual(context.sourceRefs,['s3']);
 assert.deepEqual(context.fantasyRealization,adopted.fantasyRealization);
 assert.deepEqual(context.boundaryBefore,f.plan.events[1].boundaryBefore);
 assert.deepEqual(sourceIds(requests[1]),['s4','s5']);assert.deepEqual(requests[1].selection.selectedIds,[]);
 assert.equal(context.candidateId,undefined);assert.equal(context.units,undefined);
 assert.equal(requests[1].source.entryFacts.length,0,'prior creative output must not become source facts');
});

test('only the source-adjacent adopted package is used, never a failed candidate or the latest completed package',async t=>{
 const {engine,store,requests}=await seeded(t,async r=>({output:tailDraft(r)}),independent());
 await author(engine,'p1');
 await store.update('batch',d=>{d.plan.workPackages.reverse();d.candidates.push({id:'failed-neighbor',packageIds:['p2'],stage:'author',status:'needs_repair',draft:{units:[{id:'not-adopted'}]}});return d;});
 await author(engine,'p3');assert.equal(requests[1].plan.acceptedContinuity,undefined);
 await author(engine,'p2');
 assert.equal(requests[2].plan.acceptedContinuity?.packageId,'p1');
 assert.equal(requests[2].plan.acceptedContinuity?.unit.id,'p1-pu1-3');
});

test('grouped author and local finish use the external predecessor only; whole-episode finish has none and assembles stably',async t=>{
 const {engine,requests}=await seeded(t,async r=>({output:tailDraft(r)}),tailFixture());
 await author(engine,'p1');
 await engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:'group'});
 assert.equal(requests[1].plan.acceptedContinuity?.packageId,'p1');
 await finish(engine,['p2','p3'],'local-finish');
 assert.equal(requests[2].plan.acceptedContinuity?.packageId,'p1');
 await finish(engine,['p1','p2','p3'],'full-finish');
 assert.equal(requests[3].plan.acceptedContinuity,undefined);
 assert.deepEqual(requests[3].plan.dependencyExits,{});
 assert.equal((await engine.assemble('batch')).status,'text_ready_for_review');
});

test('a late response is stale after its adopted predecessor picture changes without changing exitState',async t=>{
 let release,ready;const started=new Promise(resolve=>{ready=resolve;});
 const {engine}=await seeded(t,async r=>{const draft=tailDraft(r);if(r.packageId==='p2'){ready();await new Promise(resolve=>{release=resolve;});}if(r.stage==='finish')draft.units.at(-1).shots[0].picture='甲将目光移向窗外。';return {output:draft};},independent());
 await author(engine,'p1');const pending=author(engine,'p2');await started;
 await finish(engine,['p1'],'changed-predecessor');release();
 const d=await pending;assert.equal(d.candidates.at(-1).status,'stale');
 assert.deepEqual(d.adopted.map(a=>a.packageIds),[['p1']]);
});

test('a changed accepted tail requires transitive repair of every adopted downstream consumer',async t=>{
 const {engine}=await seeded(t,async r=>{const draft=tailDraft(r);if(r.stage==='finish'&&r.packageIds.length===1)draft.units.at(-1).shots[0].picture='甲转头看向窗外，手停在门把上。';return {output:draft};},independent());
 await author(engine,'p1');await author(engine,'p2');const before=await author(engine,'p3');
 const d=await finish(engine,['p1']);
 assert.equal(d.candidates.at(-1).status,'needs_dependency_repair');
 assert.deepEqual(d.candidates.at(-1).requiredPackageIds,['p1','p2','p3']);
 assert.deepEqual(d.adopted,before.adopted);
 const repaired=await finish(engine,['p1','p2','p3'],'joint');
 assert.equal(repaired.candidates.at(-1).status,'adopted');
 assert.equal((await engine.assemble('batch')).status,'text_ready_for_review');
});

test('whole-episode finishing preserves adopted neighbor dependencies for a later tail-only repair',async t=>{
 const {engine,requests}=await seeded(t,async r=>{const draft=tailDraft(r);if(r.stage==='finish'&&r.packageIds.length===1)draft.units.at(-1).shots[0].picture='甲背对门口，转头看向窗外。';return {output:draft};},independent());
 await author(engine,'p1');await author(engine,'p2');await author(engine,'p3');
 const before=await finish(engine,['p1','p2','p3'],'whole-finish');
 assert.equal(requests.at(-1).plan.acceptedContinuity,undefined);
 assert.equal((await engine.assemble('batch')).status,'text_ready_for_review');
 const d=await finish(engine,['p1'],'local-tail-repair');
 assert.equal(d.candidates.at(-1).status,'needs_dependency_repair');
 assert.deepEqual(d.candidates.at(-1).requiredPackageIds,['p1','p2','p3']);
 assert.deepEqual(d.adopted,before.adopted);
 await assert.rejects(engine.assemble('batch'),{code:'ASSEMBLY_BUSY'});
});

test('whole-episode finishing does not force joint repair for an earlier non-tail unit change',async t=>{
 const {engine}=await seeded(t,async r=>{const draft=tailDraft(r);if(r.stage==='finish'&&r.packageIds.length===1)draft.units[0].shots[0].picture='甲先抬左手，随后说话。';return {output:draft};},independent());
 await author(engine,'p1');await author(engine,'p2');await author(engine,'p3');
 const before=await finish(engine,['p1','p2','p3'],'whole-finish');
 const d=await finish(engine,['p1'],'local-earlier-repair');
 assert.equal(d.candidates.at(-1).status,'adopted');
 assert.deepEqual(d.adopted.filter(a=>!a.packageIds.includes('p1')),before.adopted.filter(a=>!a.packageIds.includes('p1')));
 assert.equal((await engine.assemble('batch')).status,'text_ready_for_review');
});

test('an unchanged tail remains fresh after earlier-unit repair and no-op recheck changes candidate identity',async t=>{
 const {engine}=await seeded(t,async r=>{const draft=tailDraft(r);if(r.stage==='finish')draft.units[0].shots[0].picture='甲先抬左手，随后说话。';return {output:draft};},independent());
 const first=await author(engine,'p1');const second=await author(engine,'p2');
 const checked=await engine.recheckCandidate('batch',first.candidates[0].id);
 assert.equal(checked.candidates.at(-1).status,'adopted');
 const d=await finish(engine,['p1']);assert.equal(d.candidates.at(-1).status,'adopted');
 const again=await engine.recheckCandidate('batch',second.candidates.at(-1).id);
 assert.equal(again.candidates.at(-1).status,'adopted');
});

test('older snapshots and operations omit the new context and retain the original request fingerprint',async t=>{
 const {engine,store,requests}=await seeded(t,async r=>({output:tailDraft(r)}),independent());
 await store.update('batch',d=>{delete d.rulesSnapshot.acceptedContinuityVersion;return d;});
 await author(engine,'p1');const legacy=await author(engine,'p2');
 assert.equal(requests[1].plan.acceptedContinuity,undefined);
 assert.equal(legacy.operations[1].acceptedContinuityVersion,undefined);
 await store.update('batch',d=>{d.rulesSnapshot.acceptedContinuityVersion=version;return d;});
 const checked=await engine.recheckCandidate('batch',legacy.candidates.at(-1).id);
 assert.equal(checked.candidates.at(-1).status,'adopted');
 assert.equal(checked.operations[1].fingerprint,legacy.operations[1].fingerprint);
 const d=await engine.read('batch'),input={unit:{id:'ignored'}};
 delete d.rulesSnapshot.acceptedContinuityVersion;
 assert.equal(requestFor(d,'p2',{acceptedContinuity:input}).prompt,requestFor(d,'p2').prompt);
});

test('a live plan cannot silently refresh into the continuity protocol and unknown versions fail closed',async t=>{
 const {engine,store}=await seeded(t,undefined,independent());
 await store.update('batch',d=>{delete d.rulesSnapshot.acceptedContinuityVersion;return d;});
 await assert.rejects(engine.refreshRules('batch'),{code:'RULES_PROTOCOL_CHANGE'});
 const d=await engine.read('batch');d.rulesSnapshot.acceptedContinuityVersion='future';
 assert.throws(()=>requestFor(d,'p2'),{code:'RULE_SNAPSHOT'});
 assert.equal(captureRules().acceptedContinuityVersion,version);
});

function withPredecessor(){
 const f=fixture();f.source.sourceRows.unshift({id:'s0',text:'△甲来到走廊。'});
 f.plan.events[0].boundaryBefore={kind:'new_event',reason:'另一段完整事件开始'};
 const emotion=structuredClone(f.plan.events[0].emotionContract);
 f.plan.events.unshift({id:'e0',sourceRefs:['s0'],sceneKey:'走廊',boundaryBefore:{kind:'episode_start',reason:'本集开始'},emotionContract:emotion});
 f.plan.workPackages.unshift({id:'p0',eventId:'e0',sourceRefs:['s0'],emotionContract:emotion,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]});
 f.plan.provisionalUnits.unshift({id:'pu0',packageId:'p0',sourceRefs:['s0'],secondsRange:[2,4]});return f;
}
const batchDraft=request=>{const draft=draftForRequest(request);if(!request.executionBatch?.index)draft.units[0].boundaryBefore=request.plan.events[0].boundaryBefore;return draft;};

test('execution first batch gets external accepted continuity, while later batches use only their predecessor',async t=>{
 const {engine,requests}=await seeded(t,async r=>({output:batchDraft(r)}),withPredecessor());
 await author(engine,'p0');await author(engine,'p1');
 await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'batch-2'});
 assert.equal(requests[1].plan.acceptedContinuity?.packageId,'p0');
 assert.ok(requests[2].executionBatch.predecessor.unit);
 assert.equal(requests[2].plan.acceptedContinuity,undefined);
});

test('changed external continuity makes a partial execution manifest stale before another paid call',async t=>{
 const {engine,requests}=await seeded(t,async r=>{const draft=batchDraft(r);if(r.stage==='finish')draft.units.at(-1).shots[0].picture='甲回望走廊。';return {output:draft};},withPredecessor());
 await author(engine,'p0');await author(engine,'p1');await finish(engine,['p0']);
 await assert.rejects(engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'batch-2'}),{code:'EXECUTION_STALE'});
 assert.equal(requests.length,3);
});

test('a completed execution group retains its first-batch external continuity dependency',async t=>{
 const {engine}=await seeded(t,async r=>{const draft=batchDraft(r);if(r.stage==='finish')draft.units.at(-1).shots[0].picture='甲回望走廊。';return {output:draft};},withPredecessor());
 await author(engine,'p0');await author(engine,'p1');await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'batch-2'});
 const d=await finish(engine,['p0']);assert.equal(d.candidates.at(-1).status,'needs_dependency_repair');
 assert.deepEqual(d.candidates.at(-1).requiredPackageIds,['p0','p1']);
});

test('a superseded execution manifest cannot block local finishing of the currently adopted finished draft',async t=>{
 const inputOf=r=>JSON.parse(r.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n')[0]);
 const {engine,requests}=await seeded(t,async r=>{
  const draft=r.stage==='finish'?inputOf(r).previousDraft:batchDraft(r);
  if(r.stage==='finish'&&r.packageIds.includes('p0'))draft.units.flatMap(u=>u.shots).find(s=>s.sourceRefs.includes('s0')).picture='甲背对门口，转头看向窗外。';
  return {output:draft};
 },withPredecessor());
 await author(engine,'p0');await author(engine,'p1');await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'batch-2'});
 const whole=await finish(engine,['p0','p1'],'whole-finish');
 assert.ok(whole.adopted.every(a=>a.stage==='finish'&&!a.executionManifestHash));
 assert.equal((await engine.assemble('batch')).status,'text_ready_for_review');
 const oldManifest=structuredClone(whole.executionBatches),oldOperations=structuredClone(whole.operations);
 await assert.doesNotReject(()=>finish(engine,['p1'],'local-finish'),'an archived source of an older author draft must not block the current finished draft');
 const d=await engine.read('batch');
 assert.equal(requests.length,5);assert.equal(requests.at(-1).executionBatch,undefined);
 assert.deepEqual(inputOf(requests.at(-1)).previousDraft,whole.adopted.find(a=>a.packageIds.includes('p1')).draft);
 assert.equal(d.candidates.at(-1).status,'adopted');
 assert.deepEqual(d.executionBatches,oldManifest);assert.deepEqual(d.operations.slice(0,oldOperations.length),oldOperations);
 assert.equal((await engine.assemble('batch')).status,'text_ready_for_review');
});
