import test from 'node:test';
import assert from 'node:assert/strict';
import {scopeProductionSource} from './production-supply.mjs';
import {tailFixture,tailDraft} from './storyboard-v4/core/author-call-group-test-fixtures.mjs';
import {normalizeSource} from './storyboard-v4/core/source.mjs';
import * as evidence from './episode-evidence.mjs';
import {selectProductionMaterials,changedConsumedMaterials} from './production-materials.mjs';
import {createCoordinator} from './storyboard-v4/coordinator.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {validateProductionFeedback} from './episode-boundary.mjs';
import {projectProductionSource} from './storyboard-v4/core/production-context-projection.mjs';

const feedback=()=>({relation:'INDEPENDENT',entry:[],exit:[],sharedChoices:[],usedMaterialIds:[],needs:[],conflicts:[]});

test('new model projection reads an exactly bound historical quote once, with legacy and unknown evidence left intact', () => {
 const f=tailFixture(),statement='甲：我不知道钥匙去了哪里。',origin={domain:'EPISODE',episode:2,start:8,end:8+statement.length};
 const fact={id:'history-id',subjects:['甲'],kind:'UTTERANCE',claim:'CHARACTER_CLAIM',applicability:'SUBJECT',statement,
  validity:{status:'UNKNOWN'},evidence:origin,contextRef:'historical-quote',candidateUse:'HISTORICAL_EVIDENCE_ONLY',currentApplicability:'UNKNOWN',retrieval:{mode:'SUBJECT_MENTION',anchorFactIds:['history-id']}};
 f.source.contextRows=[{id:'historical-quote',text:statement,kind:'guidance',provenance:{offsetUnit:'UTF16',origin}}];
 f.source.context={episodeNumber:79,episodeEvidenceVersion:'episode-evidence-v1',retrievalFacts:{schema:'FOUNDATION_FACTS_V1',historicalEvidenceCandidates:[fact]}};
 const source=normalizeSource(f.source),before=structuredClone(source),needle=JSON.stringify(statement).slice(1,-1);
 const occurrences=x=>JSON.stringify(x).split(needle).length-1;
 assert.equal(occurrences(projectProductionSource(source)),1,'候选和可读源行不重复携带相同正文');
 const legacy=structuredClone(source);delete legacy.context.episodeEvidenceVersion;
 assert.equal(occurrences(projectProductionSource(legacy)),2,'旧任务不重写保存的读取协议');
 const unproven=structuredClone(source);delete unproven.contextRows[0].provenance;
 assert.equal(occurrences(projectProductionSource(unproven)),2,'无精确来源绑定时不冒称冗余');
 const wrongOrigin=structuredClone(source);wrongOrigin.contextRows[0].provenance.origin={...origin,episode:3};
 assert.equal(occurrences(projectProductionSource(wrongOrigin)),2,'不同集的相同台词不能替代引用');
 const unsent=structuredClone(source);unsent.contextRows=[];
 assert.equal(occurrences(projectProductionSource(unsent)),1,'未发送可读源行时仍保留候选原文');
 const split=structuredClone(source),cut=5;
 split.contextRows=[{...split.contextRows[0],text:statement.slice(0,cut),provenance:{offsetUnit:'UTF16',origin:{...origin,end:origin.start+cut}}},
  {id:'historical-rest',text:statement.slice(cut),kind:'guidance',provenance:{offsetUnit:'UTF16',origin:{...origin,start:origin.start+cut}}}];
 const splitFact=split.context.retrievalFacts.historicalEvidenceCandidates[0];delete splitFact.contextRef;splitFact.contextRefs=['historical-quote','historical-rest'];
 assert.ok(!JSON.stringify(projectProductionSource(split).context.retrievalFacts).includes(needle),'多源行必须逐字及连续坐标都匹配才省略重抄');
 assert.deepEqual(source,before);
});

test('historical source reads expand to whole lines and cannot expose future source or files', () => {
 assert.equal(typeof evidence.buildHistoricalSourceMaterial,'function');
 const episode={number:2,title:'往事',content:'2-1 房间 日 内\r\n林岚：钥匙交给你。\r\n△她松开右手。\r\n'};
 const start=episode.content.indexOf('钥匙'),end=start+2;
 const m=evidence.buildHistoricalSourceMaterial(`HISTORY_SOURCE:2:${start}:${end}`,episode,79);
 assert.equal(m.kind,'SOURCE_EVIDENCE');
 assert.equal(m.value.text,'林岚：钥匙交给你。\r\n');
 assert.equal(episode.content.slice(m.value.sourceRange.start,m.value.sourceRange.end),m.value.text);
 assert.equal(m.value.applicability,'UNVERIFIED_HISTORY');
 assert.match(m.value.authorityRule,/角色主张/);
 assert.deepEqual(evidence.buildHistoricalSourceMaterial('HISTORY_SOURCE:2',episode,79).value.text,episode.content);
 assert.throws(()=>evidence.buildHistoricalSourceMaterial('HISTORY_SOURCE:80',{...episode,number:80},79),/历史/);
 assert.throws(()=>evidence.buildHistoricalSourceMaterial('HISTORY_SOURCE:2:999:1000',episode,79),/范围/);
 assert.throws(()=>evidence.buildHistoricalSourceMaterial('HISTORY_SOURCE:/etc/passwd',episode,79),/历史/);
 assert.throws(()=>evidence.buildHistoricalSourceMaterial('HISTORY_SOURCE:2',{...episode,number:3},79),/历史/);
 assert.equal(m.version,evidence.buildHistoricalSourceMaterial(m.value.target,episode,79).version,'相同补读版本稳定');
 const appended={...episode,content:episode.content+'△别处新增无关原文。\r\n'};
 assert.equal(m.version,evidence.buildHistoricalSourceMaterial(m.value.target,appended,79).version,'未消费的历史变化不触发整包返修');
 assert.notEqual(evidence.buildHistoricalSourceMaterial('HISTORY_SOURCE:2',episode,79).version,evidence.buildHistoricalSourceMaterial('HISTORY_SOURCE:2',appended,79).version,'读了整集时仍严格识别原文变化');
});

test('historical material goes to its dependent package only; unknown/unread data does not invalidate other work', () => {
 const make=target=>({id:`history:${target}`,kind:'SOURCE_EVIDENCE',version:target,packageIds:['p1'],value:{target}});
 const wanted=make('HISTORY_SOURCE:2'),other=make('HISTORY_SOURCE:3');
 const need={stage:1,target:'HISTORY_SOURCE:2',packageIds:['p1'],resolved:false};
 const source={context:{episodeEvidenceVersion:'episode-evidence-v1'},sourceRows:[],contextRows:[]};
 const plan={productionFeedback:{usedMaterialIds:[],needs:[need]}};
 assert.deepEqual(selectProductionMaterials([wanted,other],'author',plan,['p1'],[need],source,'production-supply-v1'),[wanted]);
 assert.deepEqual(selectProductionMaterials([wanted,other],'author',plan,['p2'],[need],source,'production-supply-v1'),[]);
 const used={productionFeedback:{usedMaterialIds:[wanted.id],needs:[need]}};
 assert.deepEqual(selectProductionMaterials([wanted],'author',used,['p2'],[need],source,'production-supply-v1'),[], '统筹读过不等于所有主创都需要重复读');
 assert.deepEqual(changedConsumedMaterials([wanted],[wanted,other],[wanted.id]),[]);
 assert.deepEqual(changedConsumedMaterials([wanted],[{...wanted,version:'changed'},other],[wanted.id]),[wanted.id]);
});

test('material loading is targeted, deduplicated and no-op for frozen legacy tasks', async () => {
 const needs=[{stage:1,target:'HISTORY_SOURCE:2',packageIds:['p1']},{stage:1,target:'HISTORY_SOURCE:2',packageIds:['p1']},
  {stage:1,target:'HISTORY_SOURCE:2:4:9',packageIds:['p2']},{stage:2,target:'person',packageIds:['p1']}];
 let reads=0;
 const readEpisode=async number=>{reads++;assert.equal(number,2);return {number,content:'△林岚交出钥匙。\n林岚：保管好。\n'};};
 const loaded=await evidence.loadHistoricalSourceMaterials({version:'episode-evidence-v1',currentEpisode:79,needs,readEpisode});
 assert.equal(reads,1);assert.equal(loaded.length,2);assert.deepEqual(loaded[0].packageIds,['p1']);
 const repeated=await evidence.loadHistoricalSourceMaterials({version:'episode-evidence-v1',currentEpisode:79,needs,existing:loaded,readEpisode});
 assert.deepEqual(repeated,loaded,'反复刷新不会形成新版本或追加重复材料');
 const legacy=await evidence.loadHistoricalSourceMaterials({version:null,currentEpisode:79,needs,materials:loaded,readEpisode});
 assert.strictEqual(legacy,loaded);assert.equal(reads,2,'旧规则未触发新补读');
});

test('uncategorized wound/release signals are retrieved as candidates without making them persistent facts', () => {
 const fact=(id,statement,subjects,kind='SETTING',claim='SOURCE')=>({id,statement,subjects,kind,claim,evidence:{domain:'EPISODE',episode:2,start:Number(id)*50,end:Number(id)*50+statement.length},validity:{status:'UNKNOWN'}});
 const all=[fact('1','△林岚把白纱绕在左手上。',['林岚']),fact('2','△他拆掉了石膏。',[]),fact('3','林岚：红色真好看。',['林岚'],'UTTERANCE','CHARACTER_CLAIM'),fact('4','△林岚说完就转身。',['林岚'])];
 // A distant previous episode exists: these are not retained just because episode 2 is last.
 all.push({...fact('5','程野：门开了。',['程野'],'UTTERANCE','CHARACTER_CLAIM'),evidence:{domain:'EPISODE',episode:78,start:0,end:8}});
 const selected=evidence.selectEpisodeEvidence(all,{scope:[79],relevant:f=>f.subjects.includes('林岚')});
 assert.ok(selected.anchors.has('1'),'白纱这样的未分类伤势线索仍可召回');
 assert.ok(selected.anchors.has('2'),'无明确名字的解除原句仍须保留为待判候选');
 assert.ok(!selected.anchors.has('3'),'普通旧对白不是事实状态');
});

test('new planner scope excludes distant chatter but keeps states, release and selected source', () => {
 const f=tailFixture(),history=[];
 for(let episode=1;episode<79;episode++)for(let line=0;line<12;line++){
  const id=`e${episode}l${line}`,statement=`甲：第${episode}次闲聊的第${line}句话。\n`;
  history.push({id,subjects:['甲'],kind:'UTTERANCE',statement,claim:'CHARACTER_CLAIM',applicability:'SUBJECT',validity:{status:'UNKNOWN'},
   evidence:{domain:'EPISODE',episode,start:line*50,end:line*50+statement.length},contextRef:id,
   candidateUse:'HISTORICAL_EVIDENCE_ONLY',currentApplicability:'UNKNOWN',retrieval:{mode:'SUBJECT_MENTION',anchorFactIds:[id]}});
 }
 for(const [id,episode,statement] of [['wound',2,'△甲右臂骨折。'],['release',10,'△甲已痊愈。']])history.push({
  ...structuredClone(history[0]),id,kind:'STATE',claim:'SOURCE',statement,contextRef:id,
  evidence:{domain:'EPISODE',episode,start:1000,end:1000+statement.length},retrieval:{mode:'SUBJECT_MENTION',anchorFactIds:[id]}});
 f.source.contextRows=history.map(h=>({id:h.id,text:h.statement,kind:'guidance',evidenceRole:'guidance',provenance:{origin:h.evidence,offsetUnit:'UTF16'}}));
 f.source.context={episodeNumber:79,retrievalFacts:{schema:'FOUNDATION_FACTS_V1',historicalEvidenceCandidates:history}};
 const source=normalizeSource(f.source),before=structuredClone(source);
 const old=scopeProductionSource(source,{stage:'plan'});
 assert.equal(old.context.retrievalFacts.historicalEvidenceCandidates.length,history.length,'冻结v1仍按旧语义读取');
 const selected=scopeProductionSource(source,{stage:'plan',episodeEvidenceVersion:'episode-evidence-v1'});
 assert.ok(selected.context.retrievalFacts.historicalEvidenceCandidates.length<history.length/5,'新版统筹不重读全部历史对白');
 for(const id of ['wound','release']){
  assert.ok(selected.context.retrievalFacts.historicalEvidenceCandidates.some(h=>h.id===id));
  assert.ok(selected.contextRows.some(row=>row.id===id));
 }
 assert.ok(!selected.contextRows.some(row=>row.id==='e1l0'));
 assert.deepEqual(source,before);assert.deepEqual(selected.sourceRows,source.sourceRows);
});

test('focused history does not grow with recurring genre words, while retaining exact state, release and requested evidence',()=>{
 const rows=[];
 for(let episode=1;episode<79;episode++)for(let line=0;line<5;line++)rows.push({
  id:`e${episode}-${line}`,subjects:['甲'],kind:'UTTERANCE',claim:'CHARACTER_CLAIM',statement:'甲：这些觉醒者已经发现了，不能错过，获得奖励后继续进化。',
  evidence:{domain:'EPISODE',episode,start:line*100,end:line*100+29},validity:{status:'UNKNOWN'}});
 const wound={...rows[0],id:'wound',kind:'STATE',claim:'SOURCE',statement:'△甲左手骨折。'};
 const release={...rows[0],id:'release',claim:'SOURCE',kind:'SETTING',statement:'△他拆掉石膏，伤口已痊愈。',evidence:{domain:'EPISODE',episode:10,start:1000,end:1016}};
 const requested={...rows[0],id:'requested',statement:'甲：旧约定是三点碰面。',evidence:{domain:'EPISODE',episode:12,start:1000,end:1012}};
 rows.push(wound,release,requested);
 const old=evidence.selectEpisodeEvidence(rows,{scope:[79]});
 const current=evidence.selectEpisodeEvidence(rows,{scope:[79],historyPolicy:'episode-history-focused-v2',requestedEvidence:[requested.evidence]});
 assert.ok(old.kept.size>300);
 assert.ok(current.kept.size<25,'类型标签和普遍谓词不能扩成全剧历史阅读');
 for(const id of ['wound','release','requested','e78-0'])assert.ok(current.kept.has(id));
 assert.ok(!current.kept.has('e20-2'));
});

test('the actual coordinator supplies a requested past episode without extra planner or judge calls', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'episode-evidence-supply-')),f=tailFixture(),seen=[];
 f.source.context={episodeNumber:79,episodeEvidenceVersion:'episode-evidence-v1',historicalSourceDirectory:[[2,'往事',16]]};
 const need={stage:1,target:'HISTORY_SOURCE:2',purpose:'核对钥匙交接对象',packageIds:['p1'],sourceRefs:['s1'],blocking:true};
 let reads=0;
 const coordinator=createCoordinator({dataRoot:directory,
  loadProductionContext:async(_binding,run)=>({boundary:null,materials:await evidence.loadHistoricalSourceMaterials({
   version:run.rulesSnapshot.episodeEvidenceVersion,currentEpisode:79,needs:run.production.needs,existing:run.production.materials,
   readEpisode:async number=>{reads++;return {number,content:'△甲将钥匙交给乙。\n甲：保管好。\n'};}})}),
  modelRunner:async request=>{
   seen.push(request);
   const receipt=feedback();
   let output;
   if(request.stage==='plan')output={...structuredClone(f.plan),productionFeedback:{...receipt,needs:[need]}};
   else{output={...tailDraft(request),productionFeedback:receipt};
    if(request.plan.workPackages.some(w=>w.id==='p1')){
     const m=request.productionSnapshot.materials.find(m=>m.id==='history:HISTORY_SOURCE:2');
     assert.ok(m,'不是只在文档中宣称补料：实际请求必须读到原文');
     assert.equal(m.value.text,'△甲将钥匙交给乙。\n甲：保管好。\n');
     receipt.usedMaterialIds=[m.id];
    }
   }
   return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{inputTokens:80,outputTokens:20,totalTokens:100,cachedInputTokens:0}};
  }});
 try{
  const d=await coordinator.create({source:f.source,settings:f.settings,production:{boundary:null,materials:[]},binding:{projectId:'offline',episodeId:'ep79',sourceVersion:'offline'}});
  await coordinator.start(d.id,{mode:'all'});await coordinator.wait(d.id);
  const complete=await coordinator.read(d.id);
  assert.equal(complete.status,'text_ready_for_review',JSON.stringify({status:complete.status,web:complete.web.error,needs:complete.production.needs}));
  assert.deepEqual(complete.assembly.validation.errors,[]);
  assert.equal(seen.filter(r=>r.stage==='plan').length,1);
  assert.ok(reads>0);assert.equal(complete.production.needs[0].resolved,true);
  assert.ok(complete.production.needs[0].resolvedBy);
  assert.ok(!seen.some(r=>['judge','review'].includes(r.stage)));
  assert.equal(complete.operations[0].productionSnapshot.materials.length,0,'补料不能篡改旧请求');
  for(const request of seen.filter(r=>r.stage==='author'&&!r.plan.workPackages.some(w=>w.id==='p1')))
   assert.ok(!request.productionSnapshot.materials.some(m=>m.kind==='SOURCE_EVIDENCE'),'无关包不携带历史全文');
 }finally{await coordinator.shutdown();await rm(directory,{recursive:true,force:true});}
});

test('new feedback rejects future and malformed historical targets at precise coordinates; legacy stays compatible', () => {
 const f=tailFixture(),source=normalizeSource({...f.source,context:{episodeEvidenceVersion:'episode-evidence-v1',episodeNumber:79,historicalSourceDirectory:[[2,'往事',20]]}});
 const raw={...feedback(),needs:[{stage:1,target:'HISTORY_SOURCE:80',purpose:'不允许预读',packageIds:['p1'],sourceRefs:['s1'],blocking:true}]};
 for(const target of ['HISTORY_SOURCE:80','HISTORY_SOURCE:2:4:100','HISTORY_SOURCE:/tmp/script']){
  raw.needs[0].target=target;
  assert.throws(()=>validateProductionFeedback(raw,{source,plan:f.plan}),e=>e.code==='PRODUCTION_FEEDBACK'&&e.coordinate==='productionFeedback.needs[0].target');
 }
 raw.needs[0].target='HISTORY_SOURCE:2';
 assert.deepEqual(validateProductionFeedback(raw,{source,plan:f.plan}),raw);
 raw.needs[0].target='HISTORY_SOURCE:80';
 assert.deepEqual(validateProductionFeedback(raw,{source:normalizeSource(f.source),plan:f.plan}),raw,'旧冻结回执不套新需求规则');
});

test('a repeated historical need after receiving the same source stops without re-reading paid plans', async () => {
 const directory=await mkdtemp(path.join(tmpdir(),'episode-evidence-repeat-')),f=tailFixture(),seen=[];
 f.source.context={episodeNumber:79,episodeEvidenceVersion:'episode-evidence-v1',historicalSourceDirectory:[[2,'往事',16]]};
 const need={stage:1,target:'HISTORY_SOURCE:2',purpose:'核对钥匙交接对象',packageIds:['p1'],sourceRefs:['s1'],blocking:true};
 const coordinator=createCoordinator({dataRoot:directory,
  loadProductionContext:async(_binding,run)=>({boundary:null,materials:await evidence.loadHistoricalSourceMaterials({
   version:run.rulesSnapshot.episodeEvidenceVersion,currentEpisode:79,needs:run.production.needs,existing:run.production.materials,
   readEpisode:async number=>({number,content:'△甲将钥匙交给乙。\n甲：保管好。\n'})})}),
  modelRunner:async request=>{
   seen.push(request);
   const receipt={...feedback(),needs:request.stage==='plan'||request.plan.workPackages.some(w=>w.id==='p1')?[need]:[]};
   const output=request.stage==='plan'?{...structuredClone(f.plan),productionFeedback:receipt}:{...tailDraft(request),productionFeedback:receipt};
   return {output,raw:JSON.stringify(output),requestOutcome:'RESPONDED',usage:{inputTokens:80,outputTokens:20,totalTokens:100,cachedInputTokens:0}};
  }});
 try{
  const d=await coordinator.create({source:f.source,settings:f.settings,production:{boundary:null,materials:[]},binding:{projectId:'offline',episodeId:'ep79',sourceVersion:'offline'}});
  await coordinator.start(d.id,{mode:'all'});await coordinator.wait(d.id);
  const stopped=await coordinator.read(d.id);
  assert.equal(stopped.web.progress,'upstream_review',JSON.stringify({error:stopped.web.error,needs:stopped.production.needs,candidates:stopped.candidates.map(c=>({status:c.status,errors:c.errors,validation:c.validation})),calls:seen.map(r=>({stage:r.stage,packages:r.plan?.workPackages?.map(w=>w.id)}))}));
  assert.equal(seen.filter(r=>r.stage==='plan').length,1);
  assert.equal(seen.filter(r=>r.stage==='author'&&r.plan.workPackages.some(w=>w.id==='p1')).length,1);
  assert.equal(seen.length,3,'无关包可以推进；原文已给但再次报同一缺口时不自动付费重试');
  assert.ok(stopped.production.needs.some(n=>n.blocking&&!n.resolved&&!n.supplyUpdated));
 }finally{await coordinator.shutdown();await rm(directory,{recursive:true,force:true});}
});
