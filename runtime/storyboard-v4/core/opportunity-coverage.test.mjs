import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {buildRequest,captureRules} from './core.mjs';
import {createEngine,rebuildFrozenRequest} from './pipeline.mjs';
import {createStore} from './store.mjs';
import {PLAN_VERSION,VERSION,digest} from './shared.mjs';
import {DELTA_VERSION} from './delta.mjs';
import {OPPORTUNITY_COVERAGE_VERSION,automaticOpportunities,opportunityPolicy,opportunityInputBasis,proposeOpportunityAppend} from './opportunity-coverage.mjs';
import {fixture as executionFixture,seeded as executionSeeded,draftForRequest} from './execution-batch-test-fixtures.mjs';
import {runModel} from './runner.mjs';
import {projectModelCoordinates,restoreModelCoordinates,MATERIAL_COORDINATE_VERSION} from './model-coordinates.mjs';

const source={key:'ordinary',sourceRows:[{id:'r1',text:'△甲望着门口，欲言又止。'},{id:'r2',text:'△乙会错意，抬手示意甲先坐。'}]};
const emotion={subject:'甲乙',contextTone:'试探',audienceEffect:'会心一笑',change:'等待被误读',landing:'关系里的尴尬',retain:['源动作与双方知情']};
const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'试探与误会',entryFacts:[],events:[{id:'e',sourceRefs:['r1','r2'],sceneKey:'屋内',boundaryBefore:{kind:'episode_start',reason:'本段开始'},emotionContract:emotion}],workPackages:[{id:'p',eventId:'e',sourceRefs:['r1','r2'],contextRefs:[],entryFactIds:[],dependsOn:[],scenarioKeys:[],emotionContract:emotion}],provisionalUnits:[{id:'u',packageId:'p',sourceRefs:['r1','r2'],secondsRange:[3,5]}],fantasyCandidates:[]};
const supplement={id:'f-wait',anchorRefs:['r1'],subject:'甲',emotionPurpose:'等待的尴尬与乙的误读形成反差',recommended:true,proposal:'甲的主观期待像细线绷紧，乙抬手时骤然松垮；不改变真实门口和人物知情',screenSecondsRange:[.5,1],extraSecondsRange:[0,0]};
function draft(){return {schemaVersion:VERSION,units:[{id:'p-u',eventId:'e',boundaryBefore:{kind:'episode_start',reason:'本段开始'},title:'等待',unitDirection:'欲言又止被坐下手势打断，观看随两人的关系转移',intent:{subject:'甲乙',change:'试探变成误会',landing:'甲收回期待',retain:['门口位置与源动作']},scene:'屋内',props:[],participants:['甲','乙'],visualSubjects:[],lighting:'窗光',initialState:'甲望门口，乙在旁',exitState:'乙示意，甲仍在门内',shots:[{id:'p-s',duration:4,camera:'从甲近脸短促推进，随乙抬手快速侧移并落稳两人错开的视线',picture:'甲望门口，嘴唇将启又止；乙误会后抬手示意坐下。',lighting:'窗光不变',sound:'衣袖擦动与室内底声',dialogueParts:[],transition:'动作自然收束',sourceRefs:['r1','r2'],contextRefs:[]}]}],fantasyRealization:[],fantasySupplements:[]};}
function withFantasy(){const x=draft();x.units[0].shots[0].picture+='主观细线由甲的期待拉紧，随乙手势一松而垂下，画面接回原现实相位。';x.fantasySupplements=[structuredClone(supplement)];x.fantasyRealization=[{candidateId:supplement.id,unitIds:['p-u'],screenSpans:[{shotId:'p-s',range:[1,1.7]}],entry:'甲抿唇时细线绷紧',exit:'随手势松垮后接回',domain:'甲的主观比喻，不是现实能力',preservedFunction:'等待被误读，无新剧情',status:'realized'}];return x;}
const payload=(mode='recommended',choice)=>({stage:'author',source,settings:{maxUnits:null,fantasyMode:mode},plan,packageId:'p',...(choice?{choice}:{})});
const fingerprint=r=>digest([r.promptHash,r.instructionHash,r.inputHash]);
async function fixture(fn,mode='recommended'){const directory=await mkdtemp(path.join(os.tmpdir(),'opportunity-'));let calls=0;const engine=createEngine({directory,modelRunner:async req=>{calls++;const output=req.stage==='plan'?plan:await fn(req);return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};}});await engine.create({id:'x',source,settings:{maxUnits:null,fantasyMode:mode}});await engine.execute('x',{stage:'plan',attemptId:'plan'});return {engine,directory,calls:()=>calls};}

test('ordinary source receives honest proactive default and a real same-response supplementation contract',()=>{
 const r=buildRequest(payload());
 assert.equal(captureRules().opportunityCoverageVersion,'opportunity-coverage-v2');
 assert.equal(r.opportunityPolicy.defaultOrigin,'project_policy_not_item_confirmation');
 assert.equal(r.opportunityPolicy.allowSupplements,true);
 assert.ok(r.schema.properties.fantasySupplements);
 assert.deepEqual(r.opportunityBasis.candidateIds,[]);
});

test('same ordinary author response appends, selects and realizes an omitted opportunity with no extra dispatch',async()=>{
 const x=await fixture(req=>{const out=withFantasy();if(req.stage==='finish')out.fantasySupplements=[];return out;});try{
  await x.engine.execute('x',{stage:'author',packageId:'p',attemptId:'author'});let d=await x.engine.read('x');
  assert.equal(d.candidates.at(-1).status,'adopted');assert.equal(d.plan.fantasyCandidates.length,1);
  assert.equal(d.plan.fantasyCandidates[0].opportunityOrigin.origin,'automatic_recommendation');
  assert.deepEqual(d.choice.overrides,{});assert.equal(x.calls(),2);
  const op=d.operations.at(-1);assert.equal(fingerprint(rebuildFrozenRequest(d,op)),op.fingerprint);
  await x.engine.execute('x',{stage:'finish',packageId:'p',attemptId:'finish'});d=await x.engine.assemble('x');
  assert.equal(d.status,'text_ready_for_review');assert.equal(d.assembly.validation.errors.length,0);assert.equal(x.calls(),3);
 }finally{await rm(x.directory,{recursive:true,force:true});}
});

test('invalid supplementation leaves plan, choice and adopted draft unchanged while preserving paid output',async()=>{
 const output=withFantasy();output.fantasySupplements[0].anchorRefs=['unprovided'];const x=await fixture(()=>output);try{
  const before=await x.engine.read('x');await x.engine.execute('x',{stage:'author',packageId:'p',attemptId:'invalid'});const d=await x.engine.read('x');
  assert.equal(d.candidates.at(-1).status,'needs_repair');assert.deepEqual(d.plan,before.plan);assert.deepEqual(d.choice,before.choice);assert.deepEqual(d.adopted,before.adopted);
  assert.deepEqual(d.candidates.at(-1).output,output);assert.equal(x.calls(),2);
 }finally{await rm(x.directory,{recursive:true,force:true});}
});

for(const choice of [{mode:'off'},{mode:'review'},{mode:'recommended',overrides:{old:false}},{mode:'all',unitOverrides:{u:false}},{mode:'all',confirmedFingerprint:'confirmed'},{mode:'recommended',reviewRequiredIds:['old']}])test(`saved limits cannot automatically expand: ${JSON.stringify(choice)}`,()=>{
 assert.equal(automaticOpportunities(choice),false);assert.equal(opportunityPolicy({stage:'author',choice}).allowSupplements,false);
});
for(const mode of ['recommended','all'])test(`${mode} does not impose a candidate count and is not per-item confirmation`,()=>{
 const choice={mode,overrides:{},unitOverrides:{},confirmedFingerprint:null};assert.equal(automaticOpportunities(choice),true);
 assert.equal(opportunityPolicy({stage:'finish',choice}).selectionAuthority,'automatic_mode_not_item_confirmation');
 assert.equal(opportunityPolicy({stage:'finish',choice,executionBatch:{}}).allowSupplements,true);
 assert.equal(opportunityPolicy({stage:'finish',choice,refining:true}).allowSupplements,false);
 assert.equal(opportunityPolicy({stage:'finish',choice,executionBatch:{},version:'opportunity-coverage-v1'}).allowSupplements,false);
});

test('delta finishing can repair a missed ordinary opportunity in its actual replacement, leaving old operation identity intact',async()=>{
 const x=await fixture(req=>req.stage==='author'?draft():{schemaVersion:DELTA_VERSION,baseDraftHash:req.baseDraftHash,retainedUnitIds:[],replacements:[{replaces:['p-u'],units:withFantasy().units,fantasyRealization:withFantasy().fantasyRealization}],fantasySupplements:[supplement],revisionNotes:[],unresolved:[]});try{
  await x.engine.execute('x',{stage:'author',packageId:'p',attemptId:'a'});const old=(await x.engine.read('x')).operations.at(-1);
  await x.engine.execute('x',{stage:'finish',finishMode:'delta',packageId:'p',attemptId:'f'});const d=await x.engine.assemble('x');
  assert.equal(d.candidates.at(-1).status,'adopted');assert.equal(d.status,'text_ready_for_review');assert.equal(x.calls(),3);
  assert.equal(fingerprint(rebuildFrozenRequest(d,old)),old.fingerprint);
 }finally{await rm(x.directory,{recursive:true,force:true});}
});

for(const [name,change] of [
 ['not realized',o=>o.fantasyRealization[0].status='not_realized'],
 ['unknown extra candidate',o=>o.fantasyRealization[0].candidateId='not-declared'],
 ['duplicate candidate ID',o=>o.fantasySupplements.push(structuredClone(supplement))],
 ['same source function under another ID',o=>o.fantasySupplements.push({...supplement,id:'f-other'})],
 ['unknown authority field',o=>o.fantasySupplements[0].userLockedProposal='pretend user approved'],
 ['invalid timing',o=>o.fantasyRealization[0].screenSpans[0].range=[1,99]],
 ['source anchor not realized',o=>o.fantasyRealization[0].screenSpans[0].shotId='absent'],
 ['not recommended',o=>o.fantasySupplements[0].recommended=false],
])test(`bad output is preserved without paid retry or plan mutation: ${name}`,async()=>{
 const output=withFantasy();change(output);const x=await fixture(()=>output);try{
  const before=await x.engine.read('x');await x.engine.execute('x',{stage:'author',packageId:'p',attemptId:'bad'});const d=await x.engine.read('x');
  assert.equal(d.candidates.at(-1).status,'needs_repair');assert.deepEqual(d.plan,before.plan);assert.deepEqual(d.choice,before.choice);assert.deepEqual(d.adopted,[]);assert.deepEqual(d.candidates.at(-1).output,output);assert.equal(x.calls(),2);
 }finally{await rm(x.directory,{recursive:true,force:true});}
});

test('new opportunity cannot claim a delta-retained unit',async()=>{
 const x=await fixture(req=>req.stage==='author'?draft():{schemaVersion:DELTA_VERSION,baseDraftHash:req.baseDraftHash,retainedUnitIds:['p-u'],replacements:[],fantasySupplements:[supplement],revisionNotes:[],unresolved:[]});try{
  await x.engine.execute('x',{stage:'author',packageId:'p',attemptId:'a'});const before=await x.engine.read('x');await x.engine.execute('x',{stage:'finish',finishMode:'delta',packageId:'p',attemptId:'f'});const d=await x.engine.read('x');assert.equal(d.candidates.at(-1).status,'needs_repair');assert.deepEqual(d.plan,before.plan);assert.deepEqual(d.adopted,before.adopted);
 }finally{await rm(x.directory,{recursive:true,force:true});}
});

test('live cancellation of a unit after dispatch rejects the old automatic authority',async()=>{
 let entered,release;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);const x=await fixture(async()=>{entered();return wait;});try{
  const pending=x.engine.execute('x',{stage:'author',packageId:'p',attemptId:'a'});await started;const d=await x.engine.read('x');await x.engine.setChoice('x',{...d.choice,unitOverrides:{u:false}});release(withFantasy());await pending;
  const after=await x.engine.read('x');assert.equal(after.candidates.at(-1).status,'stale');assert.deepEqual(after.plan.fantasyCandidates,[]);assert.deepEqual(after.choice.unitOverrides,{u:false});assert.equal(x.calls(),2);
 }finally{await rm(x.directory,{recursive:true,force:true});}
});

test('epoch cancellation archives a late supplement and never adopts it',async()=>{
 let entered,release;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);const x=await fixture(async()=>{entered();return wait;});try{
  const pending=x.engine.execute('x',{stage:'author',packageId:'p',attemptId:'a'});await started;await x.engine.cancel('x');release(withFantasy());await pending;const d=await x.engine.read('x');assert.equal(d.candidates.at(-1).status,'cancelled_late');assert.deepEqual(d.plan.fantasyCandidates,[]);assert.deepEqual(d.adopted,[]);
 }finally{await rm(x.directory,{recursive:true,force:true});}
});

test('free recheck of the same saved attempt is append-idempotent and preserves original raw',async()=>{
 const x=await fixture(()=>withFantasy());try{
  await x.engine.execute('x',{stage:'author',packageId:'p',attemptId:'a'});const before=await x.engine.read('x'),old=before.candidates.at(-1);
  await createStore(x.directory).update('x',d=>{d.candidates.at(-1).status='needs_repair';d.adopted=[];return d;});await x.engine.recheckCandidate('x',old.id);const d=await x.engine.read('x');
  assert.equal(d.candidates.at(-1).status,'adopted');assert.equal(d.plan.fantasyCandidates.length,1);assert.deepEqual(d.plan,before.plan);assert.equal(d.candidates.find(c=>c.id===old.id).raw,old.raw);assert.equal(x.calls(),2);
 }finally{await rm(x.directory,{recursive:true,force:true});}
});

test('candidate basis cannot hide source-choice changes or arbitrary manual plan additions',()=>{
 const choice={mode:'recommended',overrides:{},unitOverrides:{},confirmedFingerprint:null},frozen=opportunityInputBasis(plan,choice).basis;
 assert.throws(()=>opportunityInputBasis({...plan,fantasyCandidates:[supplement]},choice,frozen),{code:'OPPORTUNITY_BASIS'});
 assert.throws(()=>opportunityInputBasis(plan,{...choice,mode:'off'},frozen),{code:'OPPORTUNITY_BASIS'});
});

test('old frozen rules have no new policy, schema or input basis, and unknown marker fails closed',()=>{
 const rules=captureRules();delete rules.opportunityCoverageVersion;const old=buildRequest({...payload(),rulesSnapshot:rules});
 assert.equal(old.opportunityPolicy,undefined);assert.equal(old.opportunityBasis,undefined);assert.equal(old.schema.properties.fantasySupplements,undefined);
 assert.throws(()=>buildRequest({...payload(),rulesSnapshot:{...rules,opportunityCoverageVersion:'future'}}),{code:'RULE_SNAPSHOT'});
 assert.equal(OPPORTUNITY_COVERAGE_VERSION,'opportunity-coverage-v2');
});

test('a legacy v1 multi-batch document keeps its original closed supplementation contract and paid large batches',async t=>{
 const f=executionFixture(6);f.settings.fantasyMode='recommended';f.choice.mode='recommended';
 f.source.sourceRows.push({id:'small',text:'△乙等在门口。'});
 f.plan.events.push({...structuredClone(f.plan.events[0]),id:'e2',sourceRefs:['small'],sceneKey:'门口',boundaryBefore:{kind:'new_event',reason:'独立等候事件'}});
 f.plan.workPackages.push({...structuredClone(f.plan.workPackages[0]),id:'p2',eventId:'e2',sourceRefs:['small']});
 f.plan.provisionalUnits.push({id:'small-u',packageId:'p2',sourceRefs:['small'],secondsRange:[2,4]});
 const x=await executionSeeded(t,async r=>({output:{...draftForRequest(r),fantasySupplements:[]}}),f);
 await x.store.update('batch',d=>{d.rulesSnapshot.opportunityCoverageVersion='opportunity-coverage-v1';return d;});
 await x.engine.execute('batch',{stage:'author',packageId:'p2',attemptId:'small-first'});
 assert.equal(x.requests[0].opportunityPolicy.allowSupplements,false,'must be closed before any large manifest exists');
 await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'large-1'});const before=await x.engine.read('batch');
 await x.engine.execute('batch',{stage:'author',packageId:'p2',attemptId:'small-again'});
 const d=await x.engine.execute('batch',{stage:'author',packageId:'p1',attemptId:'large-2'});
 assert.deepEqual(d.plan,before.plan);assert.equal(Object.keys(d.executionBatches.p1.accepted).length,2);assert.equal(x.requests.length,4);
 const firstLarge=before.operations.find(o=>o.attemptId==='large-1');assert.equal(fingerprint(rebuildFrozenRequest(d,firstLarge)),firstLarge.fingerprint);
});

test('new nested candidate anchors survive real machine-coordinate projection and restoration without widening the source scope',()=>{
 const refs=['ordinary-production-source-row-00000000000001','ordinary-production-source-row-00000000000002'];
 const p=JSON.parse(JSON.stringify(payload()).replaceAll('r1',refs[0]).replaceAll('r2',refs[1]));const r=buildRequest(p);
 const input={opportunityPolicy:r.opportunityPolicy,source:r.source,plan:r.plan},before=structuredClone(input);
 const projection=projectModelCoordinates(input,r.schema,{coordinateVersion:MATERIAL_COORDINATE_VERSION});
 assert.ok(projection.coordinates);assert.deepEqual(input,before);assert.deepEqual(projection.input.opportunityPolicy,r.opportunityPolicy);
 const alias=Object.entries(projection.coordinates.aliases).find(([,full])=>full===refs[0])[0];
 const output={fantasySupplements:[{...supplement,anchorRefs:[alias]}]};assert.deepEqual(restoreModelCoordinates(output,projection.coordinates).fantasySupplements[0].anchorRefs,[refs[0]]);
});

test('actual native request/schema files carry new supply for plan, author, full and delta using only a local fake executable',async t=>{
 const directory=await mkdtemp(path.join(os.tmpdir(),'opportunity-native-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const fake="import {readFile,writeFile} from 'node:fs/promises';const a=process.argv.slice(1),v=k=>a[a.indexOf(k)+1];let prompt='';for await(const part of process.stdin)prompt+=part;const schema=JSON.parse(await readFile(v('--output-schema'),'utf8'));if(!prompt.includes('project_policy_not_item_confirmation'))throw Error('missing real default supply');await writeFile(v('-o'),JSON.stringify({schema,hasPolicy:true}));";
 for(const kind of ['plan','author','full','delta']){
  const p=payload(),r=buildRequest({...p,stage:kind==='full'||kind==='delta'?'finish':kind,...(kind==='full'||kind==='delta'?{previousDraft:draft(),finishMode:kind==='delta'?'delta':'full'}:{})});
  const result=await runModel(r,{directory,attemptId:kind,executable:process.execPath,executableArgs:['--input-type=module','-e',fake,'--']});
  const saved=JSON.parse(await readFile(path.join(directory,'attempts',kind,'request.json'),'utf8'));
  assert.equal(result.output.hasPolicy,true);assert.deepEqual(result.output.schema,r.schema);assert.equal(saved.prompt,r.prompt);assert.deepEqual(saved.opportunityPolicy,r.opportunityPolicy);assert.deepEqual(saved.schema,r.schema);
  assert.equal(Boolean(saved.schema.properties.fantasySupplements),kind!=='plan');
 }
});

test('independent single-batch operation bases tolerate each others automatic append without hiding a choice change',()=>{
 // Direct scoped requests isolate append identity from the separate adopted-predecessor continuity contract.
 const p=structuredClone(plan);p.events=[{...p.events[0],sourceRefs:['r1']},{...p.events[0],id:'e2',sourceRefs:['r2'],sceneKey:'门口',boundaryBefore:{kind:'new_event',reason:'另一个独立事件'}}];
 p.workPackages=[{...p.workPackages[0],sourceRefs:['r1']},{...p.workPackages[0],id:'p2',eventId:'e2',sourceRefs:['r2']}];
 p.provisionalUnits=[{id:'u',packageId:'p',sourceRefs:['r1'],secondsRange:[2,3]},{id:'u2',packageId:'p2',sourceRefs:['r2'],secondsRange:[2,3]}];
 const settings={maxUnits:null,fantasyMode:'recommended'},choice={mode:'recommended',overrides:{},unitOverrides:{},confirmedFingerprint:null},rulesSnapshot=captureRules();
 const d={source,settings,choice,plan:p,rulesSnapshot};const requests=['p','p2'].map(packageId=>buildRequest({stage:'author',...d,packageId}));
 for(const [i,request] of requests.entries()){
  const c={...supplement,id:'added-'+i,anchorRefs:[i?'r2':'r1']},out=withFantasy();out.fantasySupplements=[c];out.fantasyRealization[0].candidateId=c.id;out.units[0].shots[0].sourceRefs=c.anchorRefs;
  const candidate={id:'candidate-'+i,output:out},operation={stage:'author',attemptId:'attempt-'+i,opportunityBasis:request.opportunityBasis};
  const proposed=proposeOpportunityAppend({document:d,operation,candidate,request,output:out,normalizePlan:(value)=>value});d.plan=proposed.plan;
 }
 assert.deepEqual(d.plan.fantasyCandidates.map(c=>c.id),['added-0','added-1']);
 for(const [i,old] of requests.entries())assert.equal(fingerprint(buildRequest({stage:'author',...d,packageId:i?'p2':'p',opportunityBasis:old.opportunityBasis})),fingerprint(old));
 assert.throws(()=>buildRequest({stage:'author',...d,packageId:'p',choice:{...choice,unitOverrides:{u:false}},opportunityBasis:requests[0].opportunityBasis}),{code:'OPPORTUNITY_BASIS'});
});
