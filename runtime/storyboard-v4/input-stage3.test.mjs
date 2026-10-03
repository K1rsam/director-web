import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {makeEpisodeInput,publicRun} from './input.mjs';
import {digest,PLAN_VERSION} from './core/shared.mjs';
import {createEngine} from './core/pipeline.mjs';
import {createEngine as createLegacyEngine} from './core/legacy-test-fixtures.mjs';

const episode={id:'ep1',projectId:'p1',number:2,title:'硬顶',content:'2-1 日 外 城墙\n苏炎：（怒吼）我还没输！\n△苏炎撑住，没有跪下。'};
const project={id:'p1',style:'3D国漫',aspectRatio:'16:9'};
const packet=()=>({sourceText:episode.content,sourceContextVersion:'context-v1',documentRevision:7,
 facts:{schema:'FOUNDATION_FACTS_V1',sourceContextVersion:'context-v1',current:[{id:'current',claim:'CHARACTER_CLAIM',validity:{status:'UNKNOWN'}}],background:[{id:'background',statement:'火焰需要蓄力',evidence:{domain:'CONTEXT',sectionKey:'background-1',start:0,end:7}}],historicalStates:[],rules:'仅作检索依据，不自动继承历史状态'},
 decisions:[{id:'decision-1',revision:2,answer:'镜头只展示主角',applicationScope:{mode:'SCENES',scenes:[{episode:2,sceneKey:'2-1'}]}}],
 scenes:[{sceneKey:'2-1',heading:'日 外 城墙',decisions:[{id:'scene-decision'}],followUps:[{note:'仅本场核对衣袖'}],assetKeys:['asset-1']}],
 assets:[{key:'asset-1',name:'苏炎',sceneRefs:[{episode:2,sceneKey:'2-1'}]}],
 materialDependencies:[{key:'material-1',name:'衣袖参考',use:'MATERIAL_SOURCE_ONLY'}],followUps:[{note:'本集确认道具'}],warnings:['作者资料只提供到本集']});

test('3008 input retains sourced retrieval evidence and scoped decisions without promoting entry facts',()=>{
 const p=packet(),result=makeEpisodeInput({episode,project,handoff:{packet:p}}),context=result.source.context;
 assert.deepEqual(context.retrievalFacts,p.facts);
 assert.deepEqual(context.confirmedDecisions,p.decisions);
 assert.equal(context.sourceContextVersion,p.sourceContextVersion);assert.equal(context.documentRevision,p.documentRevision);
 assert.deepEqual(context.materialDependencies,p.materialDependencies);
 assert.deepEqual(context.scenes,p.scenes);assert.deepEqual(result.source.assets,p.assets);
 assert.deepEqual(result.source.entryFacts,[]);assert.equal(result.source.dialogue[0].quote,'我还没输！');
 assert.ok(result.warnings.includes('作者资料只提供到本集'));
});

test('3008 source fingerprint binds all retained evidence and versions, but not per-run director notes',()=>{
 const p=packet(),base=makeEpisodeInput({episode,project,handoff:{packet:p}});
 for(const [name,change] of [
  ['retrieval facts',x=>{x.facts.background[0].statement='火焰不需要蓄力';}],
  ['confirmed decisions',x=>{x.decisions[0].answer='本场展示两人';}],
  ['context version',x=>{x.sourceContextVersion='context-v2';}],
  ['document revision',x=>{x.documentRevision++;}],
  ['material dependencies',x=>{x.materialDependencies[0].name='新版衣袖参考';}],
  ['scene scope',x=>{x.scenes[0].decisions[0].id='another-decision';}]
 ]){const changed=structuredClone(p);change(changed);assert.notEqual(makeEpisodeInput({episode,project,handoff:{packet:changed}}).sourceVersion,base.sourceVersion,name);}
 assert.equal(makeEpisodeInput({episode,project,handoff:{packet:p},notes:'只属于这次任务的导演要求'}).sourceVersion,base.sourceVersion);
});

test('independent fragment and stale handoff cannot inherit 3008 evidence or versions',()=>{
 const independentSource={schemaVersion:'independent-source-context-v1',projectId:project.id,episodeId:episode.id,contentHash:digest(episode.content),title:'独立片段',scene:'日 外 城墙',origin:{episode:'原第18集'},contextRows:[{id:'prior-1',text:'△苏炎收起火焰。'}],entryFacts:[{id:'fire-stowed',subject:'苏炎',statement:'苏炎已收起火焰',sourceRefs:['prior-1'],evidence:'收起火焰'}]};
 const p=packet(),result=makeEpisodeInput({episode,project,independentSource,handoff:{packet:p}});
 assert.deepEqual(result.source.context.confirmedDecisions,[]);assert.equal(result.source.context.retrievalFacts,null);
 assert.equal(result.source.context.sourceContextVersion,null);assert.equal(result.source.context.documentRevision,null);
 assert.deepEqual(result.source.context.materialDependencies,[]);assert.equal(result.source.entryFacts[0].id,'fire-stowed');
 assert.equal(result.sourceVersion,makeEpisodeInput({episode,project,independentSource}).sourceVersion);
 assert.ok(!JSON.stringify(result.source).includes('衣袖参考'));
 const stale=makeEpisodeInput({episode,project,handoff:{packet:{...p,sourceText:'不属于当前集的旧正文'}}});
 assert.equal(stale.source.context.retrievalFacts,null);assert.deepEqual(stale.source.context.confirmedDecisions,[]);assert.deepEqual(stale.source.entryFacts,[]);
});

const savedRun=()=>({id:'r1',epoch:0,status:'text_ready_for_review',source:{sourceRows:[{id:'r1',text:'原文'}],context:{directorNotes:'保留角色的不甘与喘息',sourceWarnings:['已保存提醒']}},settings:{fantasyMode:'off'},plan:null,choice:{mode:'off'},adopted:[],operations:[],candidates:[],assembly:{text:'整编正文',validation:{errors:[],warnings:['待用户审看']},draft:{schemaVersion:'actual-draft',units:[{id:'actual-unit',shots:[{id:'actual-shot',picture:'真实整编画面'}]}],fantasyRealization:[{candidateId:'fantasy-1',status:'realized'}],privateResponse:'do-not-return'}},web:{createdAt:'2026-09-27T00:00:00Z',progress:'text_ready_for_review',budget:{maxCalls:32,maxTokens:300000}}});

test('public projection returns actual assembled units and saved director notes without candidate payloads',()=>{
 const d=savedRun();d.candidates=[{id:'c1',attemptId:'a1',status:'adopted',raw:'private raw response',output:{units:[{id:'not-assembly'}],secret:'private output'}}];
 const before=structuredClone(d),view=publicRun(d);
 assert.equal(view.directorNotes,d.source.context.directorNotes);
 assert.deepEqual(view.assembly.draft,{units:d.assembly.draft.units,fantasyRealization:d.assembly.draft.fantasyRealization});
 assert.equal(view.assembly.text,'整编正文');assert.deepEqual(view.assembly.errors,[]);
 assert.ok(!/private raw response|private output|do-not-return|not-assembly/.test(JSON.stringify(view)));
 assert.deepEqual(d,before);
 delete d.assembly.draft;assert.equal(publicRun(d).assembly.draft,null);
});

test('public dialogue projection maps source ids to saved speaker and voice metadata without response content',()=>{
 const d=savedRun();d.source.dialogue=[
  {id:'r1:D1',speaker:'甲',channel:'OS',cue:'压低声音',kind:'dialogue',quote:'private quote',raw:'private raw',request:{prompt:'private request'}},
  {id:'r2:D2',speaker:'乙',channel:'画外',cue:'急促',kind:'dialogue'},
  {id:'r3:D3',channel:'系统音',kind:'system'}
 ];
 const before=structuredClone(d),view=publicRun(d);
 assert.deepEqual(view.dialogue,[
  {id:'r1:D1',speaker:'甲',channel:'OS',cue:'压低声音',kind:'dialogue'},
  {id:'r2:D2',speaker:'乙',channel:'画外',cue:'急促',kind:'dialogue'},
  {id:'r3:D3',speaker:undefined,channel:'系统音',cue:undefined,kind:'system'}
 ]);
 assert.ok(!/private quote|private raw|private request/.test(JSON.stringify(view)));
 assert.deepEqual(d,before);
 delete d.source.dialogue;assert.deepEqual(publicRun(d).dialogue,[]);
 delete d.source;assert.deepEqual(publicRun(d).dialogue,[]);
});

test('operation projection uses persisted outcomes and timestamps, never completed as responded',()=>{
 const d=savedRun();d.operations=[
  {attemptId:'not-sent',status:'completed',createdAt:'2026-09-27T00:00:00Z',localSettledAt:'2026-09-27T00:00:01Z',error:{code:'CLI_FAILED',requestOutcome:'NOT_SENT'}},
  {attemptId:'recovered',status:'completed',receipt:{requestOutcome:'UNKNOWN'},cancelRequestedAt:'2026-09-27T00:00:02Z',recovery:{at:'2026-09-27T00:00:05Z',epoch:0}},
  {attemptId:'duration',status:'completed',receipt:{requestOutcome:'RESPONDED',durationMs:4321}},
  {attemptId:'legacy',status:'completed'}
 ];d.candidates=[{id:'recovered-candidate',attemptId:'recovered',status:'adopted',receipt:{requestOutcome:'RESPONDED'}}];
 const [notSent,recovered,duration,legacy]=publicRun(d).operations;
 assert.equal(notSent.requestOutcome,'NOT_SENT');assert.equal(notSent.localSettledAt,d.operations[0].localSettledAt);
 assert.equal(recovered.requestOutcome,'RESPONDED');assert.equal(recovered.cancelRequestedAt,d.operations[1].cancelRequestedAt);assert.equal(recovered.recoveryAt,d.operations[1].recovery.at);
 assert.equal(duration.durationMs,4321);assert.equal(legacy.requestOutcome,null);
 for(const op of [notSent,recovered,legacy])assert.ok(!Object.hasOwn(op,'durationMs'));
});

test('a partial candidate receipt does not hide persisted operation outcome or duration',()=>{
 const d=savedRun();d.operations=[{attemptId:'a1',status:'completed',receipt:{requestOutcome:'RESPONDED',durationMs:10}}];
 d.candidates=[{id:'c1',attemptId:'a1',receipt:{usage:{totalTokens:20}}}];
 const op=publicRun(d).operations[0];assert.equal(op.requestOutcome,'RESPONDED');assert.equal(op.durationMs,10);
});

test('unavailable source preparation blocks execution projection while retaining saved history and assembly',()=>{
 const d=savedRun(),before=structuredClone(d),preparation={ready:false,code:'CONTEXT_UNAVAILABLE',error:'前情资料暂无法读取'};
 d.operations=[{attemptId:'paid',status:'completed',receipt:{requestOutcome:'RESPONDED',usage:{inputTokens:10,outputTokens:20,cachedInputTokens:0,totalTokens:30}}}];
 const view=publicRun(d,{preparation});
 assert.equal(view.sourceStale,true);assert.equal(view.blocked,true);assert.deepEqual(view.preparation,preparation);
 assert.equal(view.error.code,'CONTEXT_UNAVAILABLE');assert.equal(view.assembly.text,before.assembly.text);assert.equal(view.operations.length,1);assert.equal(view.usage.knownTokens,30);
 assert.deepEqual(view.sourceRows,before.source.sourceRows);assert.deepEqual(d.assembly,before.assembly);
});

test('recheck projection requires structured output and a safe current runtime state without mutating history',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'stage3-recheck-view-'));
 try{
  const engine=createEngine({directory,modelRunner:async()=>({output:{invalidPlan:true},raw:'private model response',requestOutcome:'RESPONDED'})});
  await engine.create({id:'r',source:makeEpisodeInput({episode,project}).source,settings:{fantasyMode:'off',maxUnits:null}});
  const d=await engine.execute('r',{stage:'plan',attemptId:'a'}),before=structuredClone(d);
  assert.equal(publicRun(d).candidates[0].canRecheck,true);assert.deepEqual(d,before);
  assert.equal(publicRun(d,{active:true}).candidates[0].canRecheck,false);
  assert.equal(publicRun(d,{sourceStale:true}).candidates[0].canRecheck,false);
  assert.equal(publicRun(d,{preparation:{ready:false,code:'SOURCE_UNAVAILABLE',error:'资料不可用'}}).candidates[0].canRecheck,false);
  for(const change of [x=>{x.candidates[0].output=null;},x=>{x.candidates[0].output='not structured';},x=>{x.candidates[0].resolvedBy='another';},x=>{x.candidates[0].status='cancelled_late';},x=>{x.operations[0].status='running';},x=>{x.epoch++;},x=>{x.source.sourceRows[0].text='已经修改的原文';}]){
   const unsafe=structuredClone(d);change(unsafe);assert.equal(publicRun(unsafe).candidates[0].canRecheck,false);
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('recheck eligibility remains read-only and rejects dependency and adopted-group conflicts',async()=>{
 const directory=await mkdtemp(path.join(tmpdir(),'stage3-recheck-scope-'));let calls=0;
 const source={key:'scope',sourceRows:[{id:'r1',text:'甲：走。'},{id:'r2',text:'乙：好。'}]};
 const emotionContract={subject:'甲',contextTone:'紧张',audienceEffect:'担忧',change:'决定',landing:'迈步',retain:['原话']};
 const plan={schemaVersion:PLAN_VERSION,emotionArc:'紧张到决定',entryFacts:[],fantasyCandidates:[],workPackages:[1,2].map(n=>({id:`p${n}`,sourceRefs:[`r${n}`],emotionContract,dependsOn:[]})),provisionalUnits:[1,2].map(n=>({id:`u${n}`,packageId:`p${n}`,sourceRefs:[`r${n}`],secondsRange:[2,5]}))};
 try{
  const engine=createLegacyEngine({directory,modelRunner:async request=>{calls++;const output=request.stage==='plan'?plan:{units:[]};return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED'};}});
  await engine.create({id:'r',source,settings:{fantasyMode:'off',maxUnits:null}});await engine.execute('r',{stage:'plan',attemptId:'plan'});
  const d=await engine.execute('r',{stage:'author',packageId:'p1',attemptId:'author'}),before=structuredClone(d);
  assert.equal(publicRun(d).candidates.at(-1).canRecheck,true);
  const grouped=structuredClone(d);grouped.adopted=[{stage:'finish',packageIds:['p1','p2'],draft:{units:[],fantasyRealization:[]}}];
  assert.equal(publicRun(grouped).candidates.at(-1).canRecheck,false);
  const dependent=structuredClone(d);dependent.plan.workPackages[0].dependsOn=['p2'];
  assert.equal(publicRun(dependent).candidates.at(-1).canRecheck,false);
  const unknown=structuredClone(d);unknown.operations.push({attemptId:'other',stage:'author',packageIds:['p2'],status:'unknown'});
  assert.equal(publicRun(unknown).candidates.at(-1).canRecheck,false);
  assert.equal(calls,2);assert.deepEqual(d,before);assert.deepEqual(await engine.read('r'),before);
 }finally{await rm(directory,{recursive:true,force:true});}
});
