import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules} from './core.mjs';
import {digest} from './shared.mjs';
import {seeded} from './execution-batch-test-fixtures.mjs';
import {groupingVersion,tailFixture,tailDraft} from './author-call-group-test-fixtures.mjs';
import {readyAuthorCallGroups} from './author-call-groups.mjs';

const payload=(f=tailFixture())=>({...f,stage:'author',packageIds:['p2','p3'],rulesSnapshot:{...captureRules(),authorCallGroupingVersion:groupingVersion}});

test('new author call keeps adjacent parent and short tail as distinct packages, events and provisional units',()=>{
 const input=payload(),before=structuredClone(input.plan),request=buildRequest(input);
 assert.deepEqual(request.packageIds,['p2','p3']);assert.equal(request.packageId,null);
 assert.deepEqual(request.plan.workPackages.map(w=>w.id),['p2','p3']);assert.deepEqual(request.plan.events.map(e=>e.id),['e2','e3']);
 assert.deepEqual(request.plan.provisionalUnits.map(u=>u.id),['pu2-1','pu2-2','pu3-1']);
 assert.deepEqual(request.source.sourceRows.map(r=>r.id),['s4','s5','s6']);
 assert.deepEqual(input.plan,before);assert.equal(request.executionBatch,undefined);
 assert.match(request.prompt,/顺序.*工作包|工作包.*顺序/);assert.match(request.prompt,/不.*合并.*事件/);
 assert.notDeepEqual(request.plan.workPackages[0].emotionContract,request.plan.workPackages[1].emotionContract);
});

test('single-package request hashes remain byte identical with or without the new grouping flag',()=>{
 const current={...payload(),packageIds:['p2']},legacy=structuredClone(current);delete legacy.rulesSnapshot.authorCallGroupingVersion;
 const a=buildRequest(current),b=buildRequest(legacy);
 assert.equal(a.prompt,b.prompt);assert.equal(a.inputHash,b.inputHash);assert.equal(a.promptHash,b.promptHash);
 assert.deepEqual(a.loadedFiles,b.loadedFiles);assert.deepEqual(a.schema,b.schema);
});

test('legacy snapshots cannot request grouped authors and unknown grouping versions are rejected',()=>{
 const old=payload();delete old.rulesSnapshot.authorCallGroupingVersion;
 assert.throws(()=>buildRequest(old),{code:'PACKAGE'});
 const future={...payload(),packageIds:['p2']};future.rulesSnapshot.authorCallGroupingVersion='future';
 assert.throws(()=>buildRequest(future),{code:'RULE_SNAPSHOT'});
});

for(const variant of ['reverse','unrelated','too-many','large-tail','oversized-parent','multi-tail-unit'])test(`invalid author group ${variant} is rejected before any call`,()=>{
 const input=payload();
 if(variant==='reverse')input.packageIds.reverse();
 if(variant==='unrelated')input.plan.workPackages[2].dependsOn=[];
 if(variant==='too-many')input.packageIds=['p1','p2','p3'];
 if(variant==='large-tail')input.plan.provisionalUnits.at(-1).secondsRange=[8,12];
 if(variant==='oversized-parent')input.plan.provisionalUnits.find(u=>u.packageId==='p2').secondsRange=[151,180];
 if(variant==='multi-tail-unit')input.plan.provisionalUnits.push({...input.plan.provisionalUnits.at(-1),id:'extra-tail-unit'});
 assert.throws(()=>buildRequest(input),{code:'PACKAGE'});
});

test('group adoption distributes source-scoped output to the original package ids and free recheck remains stable',async t=>{
 const f=tailFixture(),{engine,requests}=await seeded(t,async r=>({output:tailDraft(r)}),f);
 const first=await engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:'group'});
 assert.equal(requests.length,1);assert.deepEqual(first.adopted.map(a=>a.packageIds),[['p2'],['p3']]);
 assert.deepEqual(first.adopted.map(a=>a.draft.units.map(u=>u.eventId)),[['e2','e2'],['e3']]);
 const fingerprint=first.operations[0].fingerprint,checked=await engine.recheckCandidate('batch',first.candidates[0].id);
 assert.equal(requests.length,1);assert.equal(checked.candidates.at(-1).status,'adopted');assert.equal(checked.operations[0].fingerprint,fingerprint);
 assert.deepEqual(checked.adopted.map(a=>a.draft),first.adopted.map(a=>a.draft));
 assert.equal(fingerprint,digest([requests[0].promptHash,requests[0].instructionHash,requests[0].inputHash]));
});

test('external dependencies still require adopted output, but internal dependency is satisfied in the call',async t=>{
 const f=tailFixture();f.plan.workPackages[2].dependsOn.push('p1');
 const {engine,requests}=await seeded(t,async r=>({output:tailDraft(r)}),f);
 await assert.rejects(engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:'early'}),{code:'DEPENDENCY_NOT_READY'});
 await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'parent'});
 const d=await engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:'ready'});
 assert.deepEqual(Object.keys(requests[1].plan.dependencyExits),['p1']);assert.equal(d.adopted.length,3);
});

for(const kind of ['adopted','live','saved','repair','partial-batch'])test(`fresh group request cannot absorb ${kind} parent or child`,async t=>{
 for(const id of ['p2','p3']){
  const {engine,store,requests}=await seeded(t,async r=>({output:tailDraft(r)}),tailFixture());
  await store.update('batch',d=>{
   if(kind==='adopted')d.adopted.push({packageIds:[id],draft:{units:[],fantasyRealization:[]}});
   if(kind==='live')d.operations.push({attemptId:'prior',stage:'author',packageIds:[id],status:'running',epoch:d.epoch});
   if(kind==='saved'||kind==='repair')d.candidates.push({id:'prior',stage:'author',packageIds:[id],status:kind==='saved'?'cancelled_late':'needs_repair',raw:'saved paid response'});
   if(kind==='partial-batch')d.executionBatches={[id]:{accepted:{batch:'candidate'}}};
   return d;
  });
  await assert.rejects(engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:'new'}));assert.equal(requests.length,0);
 }
});

test('a failed grouped response repairs only that pair without rewriting the independent package',async t=>{
 let broken=true;const {engine,requests}=await seeded(t,async r=>{if(r.packageIds.length===2&&broken){broken=false;throw Object.assign(new Error('bad JSON'),{code:'INVALID_JSON',requestOutcome:'RESPONDED',raw:'{bad group'});}return {output:tailDraft(r)};},tailFixture());
 await engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'independent'});
 await assert.rejects(engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:'broken'}),{code:'INVALID_JSON'});
 const prior=(await engine.read('batch')).adopted[0];
 const repaired=await engine.execute('batch',{stage:'finish',packageIds:['p2','p3'],attemptId:'repair'});
 assert.deepEqual(requests.map(r=>r.packageIds),[['p1'],['p2','p3'],['p2','p3']]);
 assert.deepEqual(repaired.adopted.find(a=>a.packageIds.includes('p1')),prior);
 assert.equal(repaired.candidates.at(-1).status,'adopted');assert.ok(repaired.candidates.find(c=>c.attemptId==='broken').resolvedBy);
});

test('fresh scheduler grouping excludes reserved child ids and unready external dependencies',async t=>{
 const {engine,store}=await seeded(t,async r=>({output:tailDraft(r)}),tailFixture()),d=await engine.read('batch');
 assert.deepEqual(readyAuthorCallGroups(d),[['p1'],['p2','p3']]);
 assert.deepEqual(readyAuthorCallGroups(d,['p3']),[['p1'],['p2']]);
 await store.update('batch',x=>{x.plan.workPackages[2].dependsOn.push('p1');return x;});
 assert.deepEqual(readyAuthorCallGroups(await engine.read('batch')),[['p1'],['p2']]);
});

test('grouped input retains selected fantasy atoms and identical creative rule files',()=>{
 const f=tailFixture();f.settings.fantasyMode=f.choice.mode='all';f.plan.fantasyCandidates=[{id:'f1',anchorRefs:['s4','s5'],subject:'甲',emotionPurpose:'完整犹豫到决定的主观过程',recommended:true,proposal:'肩上的两个小化身争执后合力推开门',screenSecondsRange:[2,4],extraSecondsRange:[0,2]}];
 const input=payload(f),group=buildRequest(input),parent=buildRequest({...input,packageIds:['p2']});
 assert.deepEqual(group.selection.selectedIds,['f1']);assert.deepEqual(group.plan.fantasyCandidates,parent.plan.fantasyCandidates);
 assert.deepEqual(group.snapshot,parent.snapshot);assert.deepEqual(group.loadedFiles,parent.loadedFiles);
});

test('a new task snapshot cannot be silently applied to an existing legacy plan',async t=>{
 const {engine,store}=await seeded(t,undefined,tailFixture());await store.update('batch',d=>{delete d.rulesSnapshot.authorCallGroupingVersion;return d;});
 const before=await engine.read('batch');await assert.rejects(engine.refreshRules('batch'),{code:'RULES_PROTOCOL_CHANGE'});
 assert.deepEqual(await engine.read('batch'),before);
});

test('valid unique output ids are adopted by source ownership without a new naming repair gate',async t=>{
 const {engine}=await seeded(t,async r=>{const output=tailDraft(r);output.units[0].id='invented-unit';output.units[0].shots[0].id='invented-shot';return {output};},tailFixture());
 const d=await engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:'wrong-owner'});
 assert.equal(d.candidates.at(-1).status,'adopted');assert.deepEqual(d.adopted.map(a=>a.packageIds),[['p2'],['p3']]);
 assert.equal(d.adopted[0].draft.units[0].id,'invented-unit');assert.equal(d.adopted[0].draft.units[0].shots[0].id,'invented-shot');
});

test('a grouped author still cannot mix child source into a parent event unit',async t=>{
 const {engine}=await seeded(t,async r=>{const output=tailDraft(r);output.units[0].shots.push(...output.units.pop().shots);return {output};},tailFixture());
 const d=await engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:'mixed-events'});
 assert.equal(d.candidates.at(-1).status,'needs_repair');assert.equal(d.adopted.length,0);
 assert.ok(d.candidates.at(-1).validation.errors.some(e=>e.code==='EVENT_SOURCE'));
});

const moveTailDialogue=draft=>{
 const child=draft.units.at(-1),parent=draft.units.at(-2),part=child.shots[0].dialogueParts.pop();
 parent.shots[0].dialogueParts.push({...part,voiceStart:27,voiceEnd:28});return draft;
};

test('grouped author preserves original dialogue ownership after source-based package adoption',async t=>{
 const f=tailFixture();f.source.sourceRows.at(-1).text='乙：我到了。';
 const {engine}=await seeded(t,async r=>({output:moveTailDialogue(tailDraft(r))}),f);
 const d=await engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:'moved-dialogue'});
 assert.equal(d.candidates.at(-1).status,'needs_repair');assert.equal(d.adopted.length,0);
 assert.ok(d.candidates.at(-1).validation.errors.some(e=>e.code==='DIALOGUE_REF'));
 assert.ok(d.candidates.at(-1).validation.errors.some(e=>e.code==='DIALOGUE_CONTENT'));
});

test('multi-package finish cannot reintroduce cross-package dialogue migration after a valid grouped author',async t=>{
 const f=tailFixture();f.source.sourceRows.at(-1).text='乙：我到了。';
 const {engine}=await seeded(t,async r=>({output:r.stage==='finish'?moveTailDialogue(tailDraft(r)):tailDraft(r)}),f);
 const authored=await engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:'valid-dialogue'});
 const finished=await engine.execute('batch',{stage:'finish',packageIds:['p2','p3'],attemptId:'moved-finish-dialogue'});
 assert.equal(finished.candidates.at(-1).status,'needs_repair');assert.deepEqual(finished.adopted,authored.adopted);
 assert.ok(finished.candidates.at(-1).validation.errors.some(e=>e.code==='DIALOGUE_REF'));
});

function fantasyFixture(owner='p2'){
 const f=tailFixture();f.settings.fantasyMode=f.choice.mode='all';
 f.plan.fantasyCandidates=[{id:'f1',anchorRefs:owner==='p2'?['s4','s5']:['s6'],subject:'甲',emotionPurpose:'本包犹豫到决定',recommended:true,proposal:'肩上两个小化身争执后合力推开门',screenSecondsRange:[2,4],extraSecondsRange:[0,2]}];return f;
}
const fantasyRecord=units=>({candidateId:'f1',unitIds:units.map(u=>u.id),shotIds:units.map(u=>u.shots[0].id),screenSeconds:1,entry:'主观化身出现',exit:'主观化身消失',domain:'主观',preservedFunction:'本包犹豫到决定',status:'realized'});

for(const where of ['parent-to-child','child-to-parent','cross-groups'])test(`selected fantasy cannot migrate ownership during grouped adoption: ${where}`,async t=>{
 const f=fantasyFixture(where==='child-to-parent'?'p3':'p2');
 const {engine}=await seeded(t,async r=>{const output=tailDraft(r),units=where==='parent-to-child'?[output.units.at(-1)]:where==='child-to-parent'?[output.units[0]]:[output.units[0],output.units.at(-1)];output.fantasyRealization=[fantasyRecord(units)];return {output};},f);
 const d=await engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:`moved-${where}`});
 assert.equal(d.candidates.at(-1).status,'needs_repair');assert.equal(d.adopted.length,0);
 assert.ok(d.candidates.at(-1).validation.errors.some(e=>e.code==='FANTASY_UNSELECTED'));
 assert.ok(d.candidates.at(-1).validation.errors.some(e=>['FANTASY_MISSING','FANTASY_UNIT'].includes(e.code)));
});

test('multi-package finish preserves selected fantasy ownership and retains the adopted author on failure',async t=>{
 const {engine}=await seeded(t,async r=>{const output=tailDraft(r);output.fantasyRealization=[fantasyRecord([r.stage==='finish'?output.units.at(-1):output.units[0]])];return {output};},fantasyFixture());
 const authored=await engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:'valid-fantasy'});
 assert.equal(authored.candidates.at(-1).status,'adopted');
 const finished=await engine.execute('batch',{stage:'finish',packageIds:['p2','p3'],attemptId:'moved-finish-fantasy'});
 assert.equal(finished.candidates.at(-1).status,'needs_repair');assert.deepEqual(finished.adopted,authored.adopted);
 assert.ok(finished.candidates.at(-1).validation.errors.some(e=>e.code==='FANTASY_UNSELECTED'));
});

test('same-package long OS can span source-different units while fantasy develops beyond its anchor shot',async t=>{
 const f=fantasyFixture();f.source.sourceRows[3].text='甲OS：我还要继续走下去，所有人都在等着我回去。';f.plan.fantasyCandidates[0].anchorRefs=['s4'];
 const {engine}=await seeded(t,async r=>{
  const output=tailDraft(r),[first,second]=output.units,quote=r.source.dialogue.find(q=>q.rowId==='s4'),text=quote.quote,split=Math.floor(text.length/2),part=first.shots[0].dialogueParts[0];
  first.shots[0].dialogueParts=[{...part,text:text.slice(0,split),presentation:'OS',voiceStart:0,voiceEnd:8}];
  second.shots[0].dialogueParts=[{...part,text:text.slice(split),presentation:'OS',voiceStart:0,voiceEnd:8},...second.shots[0].dialogueParts.map(p=>({...p,voiceStart:9,voiceEnd:27}))];
  output.fantasyRealization=[fantasyRecord([second])];return {output};
 },f);
 const d=await engine.execute('batch',{stage:'author',packageIds:['p2','p3'],attemptId:'same-package-os'});
 assert.equal(d.candidates.at(-1).status,'adopted');assert.deepEqual(d.candidates.at(-1).validation.errors,[]);
 assert.deepEqual(d.adopted.map(a=>[a.packageIds,a.draft.fantasyRealization.map(f=>f.candidateId)]),[[['p2'],['f1']],[['p3'],[]]]);
 const q=d.source.dialogue.find(q=>q.rowId==='s4'),parts=d.adopted[0].draft.units.flatMap(u=>u.shots.flatMap(s=>s.dialogueParts)).filter(p=>p.lineId===q.id);
 assert.equal(parts.length,2);assert.equal(parts.map(p=>p.text).join(''),q.quote);
});
