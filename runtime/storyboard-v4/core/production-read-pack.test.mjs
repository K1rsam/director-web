import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {buildRequest,captureRules} from './core.mjs';
import {standardPackageSource} from './standard-source.mjs';
import {normalizeSource,parseScript} from './source.mjs';
import {PLAN_VERSION,VERSION} from './shared.mjs';
import {projectProductionTransport} from '../../production-transport.mjs';
import {projectProductionReadPack} from '../../production-read-pack.mjs';
import {createEngine} from './pipeline.mjs';
import {createStore} from './store.mjs';

const version='production-lean-v4',oldVersion='production-compact-v3';
const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/production-projection-source.json',import.meta.url),'utf8'));
function payload(){
 const source=normalizeSource(standardPackageSource(fixture.package,{key:'read-pack',sourceText:fixture.text,context:{seriesDirection:{brief:'反差与爽感不能削弱'},directorNotes:'保留人物气口与有效幻想'}}));
 source.assets=[{key:'hero',name:'甲',variants:[]}];
 const sourceFacts=fixture.package.script.entries.map((node,i)=>{const u=fixture.package.evidence.find(u=>u.id===node.sourceUnitIds[0]);return {id:`index-${i}`,claim:node.kind==='ACTION'?'SOURCE':'CHARACTER_CLAIM',quote:u.text,association:node.kind==='ACTION'?'SCENE_ACTION':'ASSET_NAME',evidence:{domain:'EPISODE',episode:2,start:u.start,end:u.end}};});
 const material={id:'asset:hero',kind:'ASSET_PRODUCTION_CARD',version:'frozen-material',value:{schema:'ASSET_PRODUCTION_CARD_V1',assetKey:'hero',name:'甲',sourceFacts,applicable:{episode:2,sceneKeys:[]},adoptedDesign:{brief:'灰衣与绷带'},openSpace:'表演幅度自主组织',references:[],materialAvailability:'TEXT_ONLY'}};
 const nodes=fixture.package.script.entries.map(node=>{const units=node.sourceUnitIds.map(id=>fixture.package.evidence.find(u=>u.id===id));return {id:node.id,target:node.target,kind:node.kind,sourceUnitIds:[...node.sourceUnitIds],sourceRange:{start:units[0].start,end:units.at(-1).end},startLine:fixture.package.evidence.indexOf(units[0])+1,endLine:fixture.package.evidence.indexOf(units.at(-1))+1};});
 const opening={episode:2,sceneKey:null,location:null,timeOfDay:null,interiorExterior:null,selectionKind:'FULL_OPENING',sourceRange:{start:0,end:fixture.text.length},startLine:1,endLine:3,text:fixture.text,sourceTextHash:'source-hash',sourceLength:fixture.text.length,nodes,clipped:false,budgetExceeded:false,diagnostics:[]};
 const boundary={version:'episode-boundary-v1',versionId:'boundary-version',seed:{schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:fixture.package.binding.sourceVersion,fromEpisode:null,toEpisode:2,adjacentEpisode:false,previousSource:null,currentOpening:opening,evidence:[{role:'CURRENT_OPENING',episode:2,start:0,end:fixture.text.length,startLine:1,endLine:3,nodeIds:nodes.map(n=>n.id)}],story:{timeLayer:'UNKNOWN',realityDomain:'UNKNOWN'},unknowns:['没有前集成稿'],policy:'未知不当成既定事实'},selected:null,actual:null,agreements:[],mode:'PRELIMINARY',chainMode:'SINGLE'};
 const sourceRefs=source.sourceRows.map(r=>r.id),emotionContract={subject:'甲',contextTone:'紧迫',audienceEffect:'担心',change:'忍痛坚持',landing:'绷带',retain:['完整台词','有力表演']};
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'忍痛坚持',entryFacts:[],fantasyCandidates:[],events:[{id:'e1',sourceRefs,sceneKey:'屋内',boundaryBefore:{kind:'episode_start',reason:'本集开始'},emotionContract}],workPackages:[{id:'p1',eventId:'e1',sourceRefs,emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'u1',packageId:'p1',sourceRefs,secondsRange:[2,5]}]};
 // Transport comparisons predate complete-result feedback; do not invent resultRevision for them.
 const rulesSnapshot={...captureRules(),productionFeedbackResultVersion:'production-feedback-result-v1'};
 return {source,plan,packageId:'p1',settings:{model:'gpt-6.1-sol',reasoning:'medium',maxUnits:null,maxUnitSeconds:30,fantasyMode:'off'},rulesSnapshot,productionSnapshot:{version:'production-feedback-v1',transportVersion:version,touchesOpening:true,touchesEnding:false,materials:[material],episodeBoundary:boundary}};
}
function request(p,stage='plan'){
 return buildRequest({...p,stage,...(stage==='finish'?{previousDraft:{schemaVersion:VERSION,units:[{id:'p1-u1',shots:[]}],fantasyRealization:[]}}:{})});
}
const wire=r=>JSON.parse(r.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n')[0]);
function expand(r){
 const input=wire(r),aliases=r.modelCoordinates?.aliases??{};
 const at=p=>p.slice(2).split('/').reduce((v,k)=>v[k.replaceAll('~1','/').replaceAll('~0','~')],input);
 const visit=v=>typeof v==='string'?aliases[v]??v:!v||typeof v!=='object'?v:v.$same?visit(at(v.$same)):v.$joinRows?input.source[v.$joinRows[0]].slice(v.$joinRows[1],v.$joinRows[2]+1).map(r=>r.text).join(v.$joinRows[3]):v.$rowIds?v.$rowIds.flatMap(([k,a,b])=>input.source[k].slice(a,b+1).map(r=>visit(r.id))):v.$boundaryNodes?v.$boundaryNodes.rows.map(row=>Object.fromEntries(v.$boundaryNodes.columns.map((k,i)=>[k,visit(row[i])]))):v.$jsonOf?JSON.stringify(visit(at(v.$jsonOf))):Array.isArray(v)?v.map(visit):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x)]));
 return visit(input);
}
const legacy=p=>({...p,productionSnapshot:{...p.productionSnapshot,transportVersion:oldVersion}});

test('current full-result rules still reject a finishing payload missing its production marker',()=>{
 const p=payload();p.rulesSnapshot.productionFeedbackResultVersion='production-feedback-result-v2';
 assert.throws(()=>request(p,'finish'),{code:'RULE_SNAPSHOT'});
});

test('v5 request and coordinate projection expand to the exact v4 historical evidence, with all statements and counterevidence intact',()=>{
 const p=payload();p.productionSnapshot.transportVersion='production-shared-v5';
 const proof=episode=>({origin:{domain:'EPISODE',episode,start:0,end:500},offsetUnit:'UTF16',verifiedAgainst:'PREVIOUS_EXCERPT',excerptRange:{start:0,end:500},coordinateRule:'精确对照完整原文，不把历史状态或角色主张当作当前事实。'.repeat(30)});
 p.source.context.retrievalFacts={schema:'FOUNDATION_FACTS_V1',historicalEvidenceCandidates:Array.from({length:10},(_,i)=>({id:`historical-proof-${i}`,evidence:{domain:'EPISODE',episode:1,start:i*10,end:i*10+5},subjects:['甲'],kind:i%2?'UTTERANCE':'STATE',claim:i%2?'CHARACTER_CLAIM':'SOURCE',applicability:'SUBJECT',validity:{status:'UNKNOWN'},statement:`历史原句与反证${i}`,contextEvidence:proof(i%2+1),candidateUse:'HISTORICAL_EVIDENCE_ONLY',currentApplicability:'UNKNOWN',retrieval:{mode:'SUBJECT_MENTION',anchorFactIds:[`historical-proof-${i}`]}}))};
 const before=structuredClone(p);
 for(const stage of ['plan','author','finish']){
  const current=request(p,stage),old=request({...p,productionSnapshot:{...p.productionSnapshot,transportVersion:version}},stage);
  assert.deepEqual(expand(current),expand(old),stage);assert.ok(current.prompt.length<old.prompt.length,`${stage}: actual sent character size falls after coordinate projection`);
  assert.deepEqual(current.schema,old.schema);assert.deepEqual(current.source,old.source,'canonical stage projection is unchanged');assert.deepEqual(p,before,'frozen input is not rewritten');
 }
});

test('new planner, author and editor omit only proven already-readable quote indices and preserve creative inputs',()=>{
 for(const stage of ['plan','author','finish']){
  const p=payload(),before=structuredClone(p),r=request(p,stage),old=request(legacy(p),stage),next=expand(r),previous=expand(old);
  assert.deepEqual(next.productionMaterials[0].value.sourceFacts,[],stage);
  const {sourceFacts:_,...card}=next.productionMaterials[0].value,{sourceFacts:__,...oldCard}=previous.productionMaterials[0].value;
  assert.deepEqual(card,oldCard);assert.deepEqual(next.source,previous.source);
  assert.deepEqual(next.plan,previous.plan);assert.deepEqual(next.settings,previous.settings);
  assert.deepEqual(r.snapshot,old.snapshot);assert.equal(r.instructions,old.instructions);
  assert.deepEqual(r.productionSnapshot,before.productionSnapshot);assert.deepEqual(p,before);
  assert.ok(r.prompt.length+JSON.stringify(r.schema).length<old.prompt.length+JSON.stringify(old.schema).length);
 }
});
test('no predecessor removes a fully readable opening replica and its invisible schema coordinates, not the boundary policy',()=>{
 const p=payload(),r=request(p),next=expand(r),old=expand(request(legacy(p)));
 assert.equal(next.episodeBoundary.seed.currentOpening,null);
 assert.deepEqual(next.episodeBoundary.seed.evidence,[]);
 for(const k of ['story','unknowns','policy','fromEpisode','toEpisode'])assert.deepEqual(next.episodeBoundary.seed[k],old.episodeBoundary.seed[k]);
 const schema=JSON.stringify(r.schema);assert.ok(!schema.includes('boundary:2:line-1'));assert.ok(!Object.values(r.modelCoordinates?.aliases??{}).includes('boundary:2:line-1'));
 assert.deepEqual(r.episodeBoundary,p.productionSnapshot.episodeBoundary,'immutable audit retains full original evidence');
});
test('actual predecessor, shared design choices, partial opening, unknown extensions and stale opening are retained',()=>{
 for(const mutate of [
  p=>{const b=p.productionSnapshot.episodeBoundary;b.seed.fromEpisode=1;b.seed.previousSource={episode:1,text:'甲尚未接住钥匙。',nodes:[]};},
  p=>{p.productionSnapshot.episodeBoundary.actual={exitState:'甲握住钥匙'};},
  p=>{p.productionSnapshot.episodeBoundary.agreements=[{key:'钥匙',value:'甲已接住'}];},
  p=>{p.productionSnapshot.episodeBoundary.seed.currentOpening.extension='这个开场额外说明必须保留';},
  p=>{p.productionSnapshot.episodeBoundary.seed.currentOpening.text='不是本次原文';},
  p=>{p.productionSnapshot.episodeBoundary.seed.currentOpening.nodes[0].sourceRange.end++;},
  p=>{p.productionSnapshot.episodeBoundary.seed.extension={purpose:'额外入口解释'};},
  p=>{p.productionSnapshot.episodeBoundary.seed.currentOpening.sourceRange.end++;},
 ]){
  const p=payload();mutate(p);
  assert.deepEqual(expand(request(p)).episodeBoundary,expand(request(legacy(p))).episodeBoundary);
 }
 const p=payload(),last=p.source.sourceRows.at(-1).id,refs=[p.source.sourceRows.slice(0,2).map(r=>r.id),[last]],emotionContract=p.plan.events[0].emotionContract;
 p.plan.events=refs.map((sourceRefs,i)=>({id:`e${i+1}`,sourceRefs,sceneKey:'屋内',boundaryBefore:{kind:i?'new_event':'episode_start',reason:'原文顺序'},emotionContract}));
 p.plan.workPackages=refs.map((sourceRefs,i)=>({...p.plan.workPackages[0],id:`p${i+1}`,eventId:`e${i+1}`,sourceRefs}));
 p.plan.provisionalUnits=refs.map((sourceRefs,i)=>({id:`u${i+1}`,packageId:`p${i+1}`,sourceRefs,secondsRange:[2,5]}));
 assert.ok(!expand(request(p,'author')).source.sourceRows.some(r=>r.id===last));
 assert.ok(expand(request(p,'author')).episodeBoundary.seed.currentOpening);
});
test('linked facts, independent facts, partial quotes, wrong authority, unknown fields, stale evidence and nonstandard source remain',()=>{
 for(const mutate of [
  p=>{p.source.context.requiredFactId='index-0';},
  p=>{p.productionSnapshot.materials[0].value.sourceFacts[0].association='VISUAL_FACT';},
  p=>{p.productionSnapshot.materials[0].value.sourceFacts[0].evidence.episode=1;},
  p=>{p.productionSnapshot.materials[0].value.sourceFacts[0].quote='甲：变过的台词';},
  p=>{p.productionSnapshot.materials[0].value.sourceFacts[0].claim='SOURCE';},
  p=>{p.productionSnapshot.materials[0].value.sourceFacts[0].extension={use:'表演设计依据'};},
  p=>{p.productionSnapshot.materials[0].value.sourceFacts[0].evidence.extension='需要保留';},
  p=>{p.source=parseScript('甲：我还在。\n△甲握紧绷带。',{key:'legacy'});},
 ]){
  const p=payload();mutate(p);
  assert.deepEqual(expand(request(p)).productionMaterials[0].value.sourceFacts[0],p.productionSnapshot.materials[0].value.sourceFacts[0]);
 }
});
test('v4 joins exact physical rows with empty separator, while frozen v3 keeps its old bytes',()=>{
 const rows=[{id:'a',text:'第一句完整台词。'.repeat(12)+'\n'},{id:'b',text:'第二句完整台词。'.repeat(12)+'\n'}],opening={text:rows.map(r=>r.text).join('')};
 const raw={source:{sourceRows:rows,contextRows:[]},episodeBoundary:{seed:{currentOpening:opening}}},before=structuredClone(raw);
 const old=projectProductionTransport(raw,{version:oldVersion}),next=projectProductionTransport(raw,{version});
 assert.deepEqual(old.input.episodeBoundary.seed.currentOpening,opening);
 assert.deepEqual(next.input.episodeBoundary.seed.currentOpening.text,{$joinRows:['sourceRows',0,1,'']});
 assert.deepEqual(raw,before);
});
test('new task rules explicitly record the lean transport; changing transport never rewrites an old saved payload',()=>{
 assert.equal(captureRules().productionTransportVersion,'production-shared-v5');
 const p=legacy(payload()),before=structuredClone(p),first=request(p),second=request(p);
 assert.equal(first.promptHash,second.promptHash);assert.equal(first.inputHash,second.inputHash);
 assert.equal(expand(first).productionMaterials[0].value.sourceFacts.length,2);assert.ok(expand(first).episodeBoundary.seed.currentOpening);assert.deepEqual(p,before);
});
test('a multiline readable row proves all exact physical units, but a missing continuation does not',()=>{
 const p=payload(),s=structuredClone(p.source),pkg=s.standardPackage,u=pkg.evidence;
 // Pure projection fixture: the already-validated receiver can combine a
 // separator into a logical dialogue row. No compiler or model is called here.
 s.sourceRows[0].text+=u[1].text;s.sourceRows.splice(1,1);
 pkg.fidelity.assignments.find(a=>a.unitId===u[1].id).target='BODY';
 pkg.fidelity.assignments.find(a=>a.unitId===u[1].id).targetId='line-1';
 const b=p.productionSnapshot.episodeBoundary,n=b.seed.currentOpening.nodes[0];
 n.sourceUnitIds.push(u[1].id);n.sourceRange.end=u[1].end;n.endLine=2;
 const sent={sourceRows:s.sourceRows.map(({id,text,kind})=>({id,text,kind})),contextRows:[],context:{}};
 assert.equal(projectProductionReadPack(p.productionSnapshot,s,sent).omittedOpening,true);
 const missing=structuredClone(sent);missing.sourceRows[0].text=u[0].text;
 assert.equal(projectProductionReadPack(p.productionSnapshot,s,missing).omittedOpening,false);
});
test('partial/unsent material evidence and consumer fact links never disappear from the lean read pack',()=>{
 const p=payload(),sent={sourceRows:[{...p.source.sourceRows[0],text:'不是完整原文'}],contextRows:[],context:{}};
 const x=projectProductionReadPack(p.productionSnapshot,p.source,sent);
 assert.deepEqual(x.snapshot.materials,p.productionSnapshot.materials);assert.equal(x.omittedOpening,false);
 const exact={sourceRows:p.source.sourceRows,contextRows:[],context:{}};
 const linked=projectProductionReadPack(p.productionSnapshot,p.source,exact,{priorDraft:{factRefs:['index-0']}});
 assert.deepEqual(linked.snapshot.materials[0].value.sourceFacts,[p.productionSnapshot.materials[0].value.sourceFacts[0]]);
 const outOfScope=structuredClone(p.productionSnapshot);outOfScope.materials[0].value.sourceFacts[0].evidence.start++;
 assert.ok(projectProductionReadPack(outOfScope,p.source,exact).snapshot.materials[0].value.sourceFacts.some(f=>f.id==='index-0'));
});
test('real engine dispatch uses new task opt-in and frozen tasks retain the v3 fallback, without invoking AI',async t=>{
 const directory=fs.mkdtempSync(path.join(tmpdir(),'stage3-lean-read-pack-'));
 t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const seen=[],engine=createEngine({directory,modelRunner:async r=>{seen.push(r);throw Object.assign(new Error('offline capture only'),{code:'OFFLINE_CAPTURE',requestOutcome:'NOT_SENT'});}}),store=createStore(directory);
 for(const old of [false,true]){
  const p=payload(),id=old?'frozen':'new';
  const d=await engine.create({id,source:p.source,settings:p.settings,production:{version:'production-feedback-v1',materials:p.productionSnapshot.materials,boundary:p.productionSnapshot.episodeBoundary}});
  if(old)await store.update(id,doc=>{delete doc.rulesSnapshot.productionTransportVersion;return doc;});
  await assert.rejects(engine.execute(id,{stage:'plan',attemptId:id}),{code:'OFFLINE_CAPTURE'});
  const r=seen.at(-1),saved=await engine.read(id),o=saved.operations[0];
  assert.equal(r.productionSnapshot.transportVersion,old?oldVersion:'production-shared-v5');
  assert.equal(o.productionSnapshot.transportVersion,r.productionSnapshot.transportVersion);
  assert.equal(expand(r).productionMaterials[0].value.sourceFacts.length,old?2:0);
  assert.deepEqual(saved.source,d.source);assert.deepEqual(saved.production,d.production);
  assert.equal(o.receipt.requestOutcome,'NOT_SENT');assert.equal(o.receipt.usage,null);
 }
});
