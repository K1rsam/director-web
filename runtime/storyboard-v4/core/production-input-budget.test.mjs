import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {buildRequest,captureRules} from './core.mjs';
import {parseScript} from './source.mjs';
import {runModel,readCompletedAttempt,resolveRunnerLimits} from './runner.mjs';
import {createEngine} from './pipeline.mjs';
import {projectModelCoordinates,restoreModelCoordinates} from './model-coordinates.mjs';
import {productionFeedbackSchema,validateProductionFeedback} from '../../episode-boundary.mjs';
import {applyDelta,baseDraftHash,DELTA_VERSION} from './delta.mjs';
import {VERSION} from './shared.mjs';

const compactVersion='production-compact-v2';
function fixture(){
 const contextRows=Array.from({length:32},(_,i)=>({id:`upstream-evidence:${String(i).padStart(64,'0')}`,text:`人物${i}的完整背景、关系及其适用边界。`,kind:'guidance'}));
 const source=parseScript('△甲接住钥匙。\n乙：（笑）这回别再弄丢了。',{key:'episode-with-a-long-stable-machine-key',contextRows});
 source.context={retrievalFacts:{rows:contextRows.map((r,i)=>({id:`local-fact:${String(i).padStart(64,'0')}`,contextRef:r.id,evidence:{sectionKey:'section:'+('b'.repeat(64)),start:i,end:i+1},claim:'CHARACTER_CLAIM',validity:{status:'UNKNOWN'}}))}};
 const text='甲将钥匙递给乙。';
 const previousSource={episode:0,text,sourceRange:{start:0,end:text.length},nodes:Array.from({length:12},(_,i)=>({id:`tail-node-${i}`,target:'BODY',kind:'ACTION',sourceUnitIds:['evidence:'+String(i).padStart(64,'0')],sourceRange:{start:0,end:text.length},startLine:i+1,endLine:i+1}))};
 const productionSnapshot={version:'production-feedback-v1',transportVersion:compactVersion,touchesOpening:true,touchesEnding:false,materials:[],episodeBoundary:{seed:{previousSource,currentOpening:null}}};
 return {stage:'plan',source,settings:{model:'gpt-6.1-sol',reasoning:'medium',fantasyMode:'off',maxUnits:null,maxUnitSeconds:30},rulesSnapshot:captureRules(),productionSnapshot};
}
const inputOf=request=>JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n')[0]);
// Independent expansion, not the implementation's decoder: all semantic values must survive.
function expand(request){
 const input=inputOf(request),aliases=request.modelCoordinates?.aliases??{};
 const pointer=p=>p.slice(2).split('/').reduce((v,k)=>v[k.replaceAll('~1','/').replaceAll('~0','~')],input);
 const visit=v=>{
  if(typeof v==='string')return aliases[v]??v;
  if(!v||typeof v!=='object')return v;
  if(v.$same)return visit(pointer(v.$same));
  if(v.$rowIds)return v.$rowIds.flatMap(([table,start,end])=>input.source[table].slice(start,end+1).map(r=>visit(r.id)));
  if(v.$joinRows){const [table,start,end,separator]=v.$joinRows;return input.source[table].slice(start,end+1).map(r=>r.text).join(separator);}
  if(v.$jsonOf)return JSON.stringify(visit(pointer(v.$jsonOf)));
  if(v.$boundaryNodes)return v.$boundaryNodes.rows.map(row=>Object.fromEntries(v.$boundaryNodes.columns.map((key,i)=>[key,visit(row[i])])));
  return Array.isArray(v)?v.map(visit):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x)]));
 };
 return visit(input);
}

test('new production requests shorten opaque coordinates and boundary records without removing facts or prose',()=>{
 const payload=fixture(),before=structuredClone(payload),legacy=buildRequest({...payload,productionSnapshot:{...payload.productionSnapshot,transportVersion:'production-text-reuse-v1'}}),next=buildRequest(payload);
 assert.ok(next.modelCoordinates,'new dispatch must record reversible coordinate bindings');
 assert.deepEqual(expand(next),expand(legacy));
 assert.deepEqual(payload,before);
 assert.ok(next.prompt.length+JSON.stringify(next.schema).length<legacy.prompt.length+JSON.stringify(legacy.schema).length);
 assert.deepEqual(inputOf(next).source.sourceRows.map(r=>r.text),inputOf(legacy).source.sourceRows.map(r=>r.text));
 assert.equal(legacy.modelCoordinates,undefined,'frozen v1 keeps original model IDs');
});

test('unknown boundary fields remain complete and literal markers cannot become references in either version',()=>{
 const payload=fixture();payload.productionSnapshot.episodeBoundary.seed.previousSource.nodes[0].unknown='重要扩展信息';
 let request=buildRequest(payload);assert.deepEqual(expand(request),expand(buildRequest({...payload,productionSnapshot:{...payload.productionSnapshot,transportVersion:'production-text-reuse-v1'}})));
 assert.ok(!inputOf(request).episodeBoundary.seed.previousSource.nodes.$boundaryNodes);
 payload.source.context.literal='R0001';
 request=buildRequest({...payload,rulesSnapshot:{...payload.rulesSnapshot,modelCoordinateVersion:'model-coordinates-v1'}});
 assert.equal(request.modelCoordinates,undefined,'literal transport names must never become references');
 assert.equal(inputOf(request).source.context.literal,'R0001');
 request=buildRequest(payload);assert.equal(inputOf(request).source.context.literal,'R0001');
 assert.equal(Object.hasOwn(request.modelCoordinates.aliases,'R0001'),false,'v2 reserves every existing spelling instead of changing the literal');
 assert.deepEqual(expand(request),expand(buildRequest({...payload,productionSnapshot:{...payload.productionSnapshot,transportVersion:'production-text-reuse-v1'}})));
});

test('SOURCE feedback schema excludes dialogue and guidance at generation time, not only after payment',()=>{
 const source={sourceRows:[{id:'a',text:'甲接住钥匙。',kind:'action'},{id:'d',text:'甲：我就是主人。',kind:'dialogue'}],contextRows:[{id:'g',text:'角色声称的旧资料',kind:'guidance',evidenceRole:'guidance'}],dialogue:[{rowId:'d'}]};
 const request={source,materialIds:[],productionSnapshot:{touchesEnding:false}};
 const schema=productionFeedbackSchema({...request,strictAuthorities:true});
 const branches=schema.properties.entry.items.anyOf;
 assert.ok(branches,'generation schema must express authority-specific coordinate sets');
 const hard=branches.find(b=>b.properties.authority.enum.includes('SOURCE'));
 assert.deepEqual(hard.properties.sourceRefs.items.enum,['a']);
 assert.equal(hard.properties.sourceRefs.minItems,1);
 const soft=branches.find(b=>b!==hard);assert.ok(!soft.properties.authority.enum.includes('SOURCE'));
 const feedback={relation:'UNKNOWN',entry:[{key:'holder',value:'甲',authority:'SOURCE',sourceRefs:['a']}],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]};
 assert.deepEqual(validateProductionFeedback(feedback,request),feedback);
 assert.throws(()=>validateProductionFeedback({...feedback,entry:[{...feedback.entry[0],sourceRefs:['g']}]},request),{code:'PRODUCTION_FEEDBACK'});
});

test('live and saved-response paths restore coordinates, while raw paid response and creative text remain unchanged',async t=>{
 const request=buildRequest(fixture());assert.ok(request.modelCoordinates);
 const [alias,canonical]=Object.entries(request.modelCoordinates.aliases)[0];
 const output={entryFacts:[{id:'new-fact',sourceRefs:[alias]}],units:[{shots:[{sourceRefs:[alias],dialogueParts:[{lineId:alias,text:alias}]}]}],productionFeedback:{entry:[{sourceRefs:[alias]}]}};
 const directory=await mkdtemp(path.join(tmpdir(),'stage3-compact-response-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const script=path.join(directory,'fake-cli.mjs');
 await writeFile(script,`process.stdin.resume();await new Promise(r=>process.stdin.on('end',r));process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(JSON.stringify(output))}}})+'\\n');process.stdout.write(JSON.stringify({type:'turn.completed',usage:{input_tokens:3,output_tokens:2}})+'\\n');`);
 const result=await runModel(request,{directory,attemptId:'compact',executable:process.execPath,executableArgs:[script]});
 assert.deepEqual(result.output.entryFacts[0].sourceRefs,[canonical]);
 assert.equal(result.output.units[0].shots[0].dialogueParts[0].text,alias,'creative text is never decoded as a machine reference');
 assert.equal(result.raw,JSON.stringify(output));
 assert.deepEqual((await readCompletedAttempt({directory,attemptId:'compact'})).output,result.output);
 assert.equal(await readFile(path.join(directory,'attempts/compact/raw.txt'),'utf8'),JSON.stringify(output));
});

test('plan repair sends one complete parsed plan instead of the identical raw JSON a second time',()=>{
 const payload=fixture(),previousPlan={emotionArc:'完整情绪保持。'.repeat(80),entryFacts:[{id:'existing',sourceRefs:[payload.source.sourceRows[0].id],statement:'含冒号：和换行\n原句保持。'}],events:[]};
 payload.previousDraft={rawText:JSON.stringify(previousPlan,null,2),previousPlan};payload.issues=[{code:'PRODUCTION_FEEDBACK',message:'只修错误来源引用'}];
 const next=buildRequest(payload),old=buildRequest({...payload,productionSnapshot:{...payload.productionSnapshot,transportVersion:'production-text-reuse-v1'}});
 assert.ok(inputOf(next).previousDraft.rawText.$jsonOf,'duplicate plan JSON must be referenced, not summarized');
 const actual=expand(next),expected=expand(old);
 assert.deepEqual(JSON.parse(actual.previousDraft.rawText),JSON.parse(expected.previousDraft.rawText));
 actual.previousDraft.rawText=JSON.parse(actual.previousDraft.rawText);expected.previousDraft.rawText=JSON.parse(expected.previousDraft.rawText);
 assert.deepEqual(actual,expected);
 assert.equal(payload.previousDraft.rawText,JSON.stringify(previousPlan,null,2));
 for(const rawText of ['not JSON',JSON.stringify({...previousPlan,emotionArc:'不同的原始情绪'}),'{"emotionArc":"旧值",'+JSON.stringify(previousPlan).slice(1)]){
  payload.previousDraft.rawText=rawText;
  assert.equal(inputOf(buildRequest(payload)).previousDraft.rawText,rawText,'invalid, different or duplicate-key JSON is not discarded');
 }
});

test('a later repair never reads paid short coordinates under a different request namespace',async t=>{
 for(const malformed of [false,true]){
  const directory=await mkdtemp(path.join(tmpdir(),'stage3-coordinate-repair-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const f=fixture(),seen=[],paid=[];
  const engine=createEngine({directory,modelRunner:async request=>{
   seen.push(request);
   const canonical=request.source.sourceRows[0].id,alias=Object.entries(request.modelCoordinates?.aliases??{}).find(([,v])=>v===canonical)?.[0];
   const output={sourceRefs:[canonical],comment:'结构未通过，但原始内容保留。'},raw=JSON.stringify({...output,sourceRefs:[alias??canonical]});paid.push(raw);
   if(malformed&&seen.length===1)throw Object.assign(new Error('bad JSON'),{code:'INVALID_JSON',requestOutcome:'RESPONDED',usage:{totalTokens:1},raw:raw.slice(0,-1)});
   return {output,raw,usage:{totalTokens:1}};
  }});
  await engine.create({id:'repair',source:f.source,settings:f.settings,production:{version:'production-feedback-v1',materials:[],boundary:f.productionSnapshot.episodeBoundary}});
  try{await engine.execute('repair',{stage:'plan'});}catch(error){assert.equal(error.code,'INVALID_JSON');}
  const before=await engine.read('repair');
  await engine.execute('repair',{stage:'plan',issues:[{code:'PLAN_SCHEMA',message:'恢复结构'}]});
  const previous=inputOf(seen[1]).previousDraft;
  if(malformed){
   assert.ok(previous.rawCoordinateBindings,'unparsed paid raw needs its original coordinate binding');
   assert.equal(previous.rawText,paid[0].slice(0,-1));
  }else{
   assert.ok(previous.rawText.$jsonOf,'parsed paid output must be used once in canonical form');
   assert.deepEqual(JSON.parse(expand(seen[1]).previousDraft.rawText),before.candidates[0].output);
  }
  const after=await engine.read('repair');assert.equal(after.candidates[0].raw,before.candidates[0].raw);
  assert.deepEqual(after.operations[0],before.operations[0]);
 }
});

test('transport compression cannot shorten the timeout of the same creative workload',()=>{
 const payload=fixture();payload.source.context.moreEvidence=Array.from({length:240},(_,i)=>({id:'extra-source:'+String(i).padStart(64,'0'),contextRef:payload.source.contextRows[i%32].id,claim:'CHARACTER_CLAIM',statement:'这条历史依据的内容保持。'}));
 const next=buildRequest(payload),old=buildRequest({...payload,productionSnapshot:{...payload.productionSnapshot,transportVersion:'production-text-reuse-v1'}});
 assert.ok(next.prompt.length<old.prompt.length);
 assert.ok(resolveRunnerLimits(next).totalMs>=resolveRunnerLimits(old).totalMs,'formatting savings must not become a premature timeout');
});

test('unmapped reference names and corrupted mapping remain safe instead of resolving object prototypes',()=>{
 const request=buildRequest(fixture()),coordinates=request.modelCoordinates;
 const [alias,canonical]=Object.entries(coordinates.aliases)[0],output={sourceRefs:['toString','constructor','__proto__',alias],text:alias};
 assert.deepEqual(restoreModelCoordinates(output,coordinates),{sourceRefs:['toString','constructor','__proto__',canonical],text:alias});
 assert.throws(()=>restoreModelCoordinates(output,{...coordinates,hash:'tampered'}),{code:'MODEL_COORDINATES'});
});

test('delta and fantasy links restore long unit, shot and candidate identities as well as source coordinates',()=>{
 const payload=fixture(),original='WP1-long-execution-batch-unit-identity-0123456789';
 payload.previousDraft={units:[{id:original,unitDirection:'完整表演摄影指令不改。',shots:[]}]};
 const coordinates=buildRequest(payload).modelCoordinates,alias=Object.entries(coordinates.aliases).find(([,v])=>v===original)[0];
 const actual={retainedUnitIds:[alias],replacements:[{replaces:[alias]}],units:[{id:alias,eventId:alias}],fantasyRealization:[{candidateId:alias,unitIds:[alias],shotIds:[alias]}],workPackages:[{id:alias,packageId:alias,dependsOn:[alias]}],productionFeedback:{usedMaterialIds:[alias],needs:[{target:alias,packageIds:[alias]}]},revisionNotes:[{coordinate:alias,change:alias}],unresolved:[{coordinate:alias,problem:alias}],text:alias};
 assert.deepEqual(restoreModelCoordinates(actual,coordinates),{retainedUnitIds:[original],replacements:[{replaces:[original]}],units:[{id:original,eventId:original}],fantasyRealization:[{candidateId:original,unitIds:[original],shotIds:[original]}],workPackages:[{id:original,packageId:original,dependsOn:[original]}],productionFeedback:{usedMaterialIds:[original],needs:[{target:original,packageIds:[original]}]},revisionNotes:[{coordinate:original,change:alias}],unresolved:[{coordinate:original,problem:alias}],text:alias});
 const draft={schemaVersion:VERSION,units:payload.previousDraft.units,fantasyRealization:[]};
 const delta={schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(draft),retainedUnitIds:[alias],replacements:[]};
 assert.equal(applyDelta(draft,restoreModelCoordinates(delta,coordinates)).units[0],draft.units[0],'actual delta consumer retains the unchanged unit, not just its spelling');
 const feedback={relation:'UNKNOWN',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[alias],needs:[],conflicts:[]};
 const restored=restoreModelCoordinates(feedback,coordinates);
 assert.deepEqual(validateProductionFeedback(restored,{source:payload.source,materialIds:[original]}),restored,'actual material validator accepts restored long material identity');
});

test('buildRequest SOURCE authority keeps original evidence roles after model row projection',()=>{
 const payload=fixture();payload.source.contextRows.push({id:'guidance-action',text:'仅制作建议，不是剧情事实。',kind:'action',evidenceRole:'guidance'});
 const request=buildRequest(payload),branches=request.schema.properties.productionFeedback.properties.entry.items.anyOf;
 const resolve=s=>s.$ref?request.schema.$defs[s.$ref.split('/').at(-1)]:s;
 const hard=branches.find(b=>b.properties.authority.enum.includes('SOURCE'));
 const ids=resolve(hard.properties.sourceRefs.items).enum??[];
 assert.ok(!ids.includes('guidance-action'),'model schema must not elevate action-shaped guidance to SOURCE');
 assert.throws(()=>validateProductionFeedback({relation:'UNKNOWN',entry:[{key:'holder',value:'甲',authority:'SOURCE',sourceRefs:['guidance-action']}],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]},request),{code:'PRODUCTION_FEEDBACK'});
});

test('table prose and unknown string fields never become machine aliases',()=>{
 const original='CHARACTER_ACCOUNT_ID_'+('1'.repeat(48)),columns=['id','evidence','subjects','kind','claim','applicability','validity','statement?','extra?'];
 const input={facts:{format:'STORYBOARD_FACT_TABLE_V1',columns,rows:Array.from({length:12},(_,i)=>[original,{sectionKey:'evidence-'+('a'.repeat(64)),start:i,end:i+1},[],'IDENTITY','SOURCE','GLOBAL',{status:'UNKNOWN'},original,{customText:original}])}};
 const result=projectModelCoordinates(input,{type:'object'});
 assert.equal(result.input.facts.rows[0][7],original,'statement column is prose even when identical to a machine ID');
 assert.equal(result.input.facts.rows[0][8].customText,original,'unknown text extension is never substituted');
 const other='coordinate-'+('x'.repeat(64)),projected=projectModelCoordinates({sourceRows:Array.from({length:12},()=>({id:other,text:'原句不变。'})),unknownText:other},{type:'object'});
 assert.ok(projected.coordinates);assert.equal(projected.input.unknownText,other);
});

test('long package and batch prefixes stay canonical for newly created unit and shot identities',()=>{
 const id='WP-long-stable-package-identity-0123456789',batch=id+'-B01';
 const input={plan:{workPackages:[{id,sourceRefs:[]}],provisionalUnits:[{id:'PU01',packageId:id}]},executionBatch:{id:batch,batch:{id:batch,packageId:id}},sourceRows:Array.from({length:20},(_,i)=>({id:'source-'+String(i).padStart(64,'0'),text:'完整原句不变。'}))};
 const result=projectModelCoordinates(input,{type:'object'});
 assert.ok(result.coordinates);assert.equal(result.input.plan.workPackages[0].id,id);assert.equal(result.input.executionBatch.id,batch);assert.equal(result.input.plan.provisionalUnits[0].packageId,id);
});

test('frozen V2 unaddressable raw repair JSON keeps one canonical namespace instead of guessing short IDs',()=>{
 const payload=fixture(),raw=JSON.stringify({units:[{id:'existing-unit',shots:[{sourceRefs:[payload.source.sourceRows[0].id],picture:'已付费正文完整保留。'}]}]});
 payload.rulesSnapshot.modelCoordinateVersion='model-coordinates-collision-v2';
 payload.previousDraft={rawText:raw};
 let request=buildRequest(payload);assert.equal(request.modelCoordinates,undefined,'raw-only paid repair falls back to canonical coordinates');
 assert.equal(inputOf(request).source.sourceRows[0].id,payload.source.sourceRows[0].id);assert.equal(inputOf(request).previousDraft.rawText,raw);
 payload.previousDraft={units:[{id:'accepted'}],supplementalCandidates:[{rawText:raw}]};
 request=buildRequest(payload);assert.equal(request.modelCoordinates,undefined,'nested supplemental raw uses the same safe fallback');
 assert.equal(inputOf(request).previousDraft.supplementalCandidates[0].rawText,raw);
});

test('repair issue coordinates use the same namespace while the issue description stays literal',()=>{
 const payload=fixture(),coordinate=payload.source.sourceRows[0].id;payload.issues=[{coordinate,detail:coordinate}];
 const request=buildRequest(payload),short=Object.entries(request.modelCoordinates.aliases).find(([,value])=>value===coordinate)[0];
 assert.equal(inputOf(request).issues[0].coordinate,short);assert.equal(inputOf(request).issues[0].detail,coordinate);
});
