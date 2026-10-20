import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {buildRequest,captureRules} from './storyboard-v4/core/core.mjs';
import {tailFixture} from './storyboard-v4/core/author-call-group-test-fixtures.mjs';
import {selectProductionMaterials} from './production-materials.mjs';
import {scopeProductionSource} from './production-supply.mjs';
import {normalizeSource} from './storyboard-v4/core/source.mjs';
import {standardPackageSource} from './storyboard-v4/core/standard-source.mjs';

const fact=(id,statement,extra={})=>({id,subjects:['甲'],kind:'CONTEXT',statement,evidence:{domain:'CONTEXT',sectionKey:'author',start:0,end:statement.length},claim:'SOURCE',applicability:'SUBJECT',validity:{status:'UNKNOWN'},...extra});
function fixture(){
 const f=tailFixture();f.source.contextRows=[{id:'before',text:'甲还不知道乙的身份。',kind:'guidance'},{id:'future',text:'第三十集甲得知真相。',kind:'guidance'},{id:'profile',text:'甲总以玩笑遮掩难堪。',kind:'guidance'}];
 f.source.context={seriesDirection:{brief:'克制喜剧'},retrievalFacts:{schema:'FOUNDATION_FACTS_V1',background:[fact('a',f.source.contextRows[0].text,{contextRef:'before'}),fact('b',f.source.contextRows[1].text,{contextRef:'future',contextUse:{kind:'EPISODE_OUTLINE',episode:30,heading:{quote:'分集概括：',start:0,end:5}}}),fact('c',f.source.contextRows[2].text,{contextRef:'profile'})],current:[],sourceFactIndex:[],historicalStates:[],historicalEvidenceCandidates:[],backgroundCandidates:[],unlinkedBackground:[]},scenes:[{sceneKey:'走廊'},{sceneKey:'楼梯'},{sceneKey:'办公室'}]};
 f.plan.workPackages[0].contextRefs=['before'];f.source.context.episodeNumber=2;
 return f;
}
test('local requests omit unrelated scene records and future outline, retaining exact planned evidence and direction',()=>{
 const f=fixture(),original=structuredClone(f.source),r=buildRequest({...f,stage:'author',packageIds:['p1'],rulesSnapshot:captureRules()});
 assert.ok(!r.source.contextRows.some(row=>row.id==='future'));
 assert.ok(r.source.contextRows.some(row=>row.id==='before'));
 assert.equal(r.source.context.seriesDirection.brief,'克制喜剧');assert.deepEqual(r.source.context.scenes.map(s=>s.sceneKey),['走廊']);
 assert.deepEqual(f.source,original,'canonical evidence remains intact');
 const legacy=captureRules();delete legacy.productionSupplyVersion;
 assert.ok(buildRequest({...f,stage:'author',packageIds:['p1'],rulesSnapshot:legacy}).source.contextRows.some(row=>row.id==='future'),'old request scope stays reproducible');
});
test('scoped standard requests preserve canonical annotations and source proof without keeping unrelated provenance rows',()=>{
 const f=JSON.parse(readFileSync(new URL('./storyboard-v4/core/fixtures/production-standard-note-source.json',import.meta.url),'utf8'));
 const raw=standardPackageSource(f.package,{key:'standard-note',title:'标准注记',sourceText:f.text,
  context:{episodeNumber:41,episodeEvidenceVersion:'episode-evidence-v1',retrievalFacts:{schema:'FOUNDATION_FACTS_V1',historicalEvidenceCandidates:[]}}});
 const note=raw.contextRows[0],unit=f.package.evidence[1];
 note.provenance={offsetUnit:'UTF16',origin:{domain:'EPISODE',episode:41,start:unit.start,end:unit.end}};
 raw.contextRows.push({id:'unrelated-history',text:'甲：以前说过的闲话。',kind:'guidance',evidenceRole:'guidance',
  provenance:{offsetUnit:'UTF16',origin:{domain:'EPISODE',episode:1,start:0,end:12}}});
 const source=normalizeSource(raw),before=structuredClone(source);
 for(const stage of ['plan','author','finish'])for(const episodeEvidenceVersion of ['episode-evidence-v1',null]){
  const scoped=normalizeSource(scopeProductionSource(source,{stage,episodeEvidenceVersion}));
  assert.deepEqual(scoped.contextRows.find(row=>row.id===note.id),note,`${stage}: source-bound note remains complete`);
  assert.deepEqual(scoped.sourceRows,source.sourceRows);assert.deepEqual(scoped.dialogue,source.dialogue);
  assert.deepEqual(scoped.standardPackage,source.standardPackage);assert.deepEqual(scoped.context.annotations,source.context.annotations);
  if(episodeEvidenceVersion)assert.ok(!scoped.contextRows.some(row=>row.id==='unrelated-history'));
 }
 const request=buildRequest({source,settings:tailFixture().settings,stage:'plan',rulesSnapshot:captureRules()});
 assert.deepEqual(request.source.contextRows.find(row=>row.id===note.id),note,'actual planner request retains the exact note');
 assert.deepEqual(source,before,'canonical source remains unchanged');
 assert.throws(()=>normalizeSource({...source,contextRows:source.contextRows.filter(row=>row.id!==note.id)}),{code:'STANDARD_NOTE_COVERAGE'});
 assert.throws(()=>normalizeSource({...source,contextRows:source.contextRows.map(row=>row.id===note.id?{...row,text:'改写注记'}:row)}),{code:'STANDARD_ROW_BINDING'});
});
test('legacy package metadata cannot exempt a historical context row from episode filtering',()=>{
 const raw=tailFixture().source;
 raw.standardPackage={annotations:[{id:'unverified-note'}]};
 raw.context={episodeNumber:41,retrievalFacts:{schema:'FOUNDATION_FACTS_V1',historicalEvidenceCandidates:[]}};
 raw.contextRows=[{id:`${raw.key}:unverified-note`,text:'甲：旧闲话。',kind:'guidance',evidenceRole:'guidance',
  provenance:{offsetUnit:'UTF16',origin:{domain:'EPISODE',episode:1,start:0,end:7}}}];
 const scoped=scopeProductionSource(normalizeSource(raw),{stage:'plan',episodeEvidenceVersion:'episode-evidence-v1'});
 assert.deepEqual(scoped.contextRows,[]);
});
test('history releases and counterclaims retain their whole linked chain regardless of row order',()=>{
 const f=fixture(),historical=(id,subject,mode,anchors,kind='UTTERANCE')=>({...fact(id,`${subject}说明${id}`,{subjects:[subject],kind,contextRef:id}),candidateUse:'HISTORICAL_EVIDENCE_ONLY',currentApplicability:'UNKNOWN',retrieval:{mode,anchorFactIds:anchors}});
 f.source.context.retrievalFacts.historicalEvidenceCandidates=[historical('release','丙','SOURCE_NEIGHBOUR',['counter']),historical('counter','乙','SOURCE_NEIGHBOUR',['state']),historical('state','甲','SUBJECT_MENTION',['current'],'STATE')];
 f.source.contextRows.push(...f.source.context.retrievalFacts.historicalEvidenceCandidates.map(h=>({id:h.id,text:h.statement,kind:'guidance'})));
 const source=normalizeSource(f.source),selected=scopeProductionSource(source,{stage:'author',plan:{...f.plan,events:[f.plan.events[0]],workPackages:[f.plan.workPackages[0]]}});
 assert.deepEqual(selected.context.retrievalFacts.historicalEvidenceCandidates.map(h=>h.id),['release','counter','state']);
 for(const id of ['release','counter','state'])assert.ok(selected.contextRows.some(row=>row.id===id));
 const unknown=structuredClone(source);unknown.context.retrievalFacts.newRelationPolicy={meaning:'unknown'};
 assert.deepEqual(scopeProductionSource(unknown,{stage:'author',plan:f.plan}).context.retrievalFacts,unknown.context.retrievalFacts,'unknown shapes are not guessed away');
});
test('local materials use declared scenes; explicit needs and unknown scope remain available',()=>{
 const card=(id,sceneKeys)=>({id:`asset:${id}`,kind:'ASSET_PRODUCTION_CARD',version:id,value:{schema:'ASSET_PRODUCTION_CARD_V1',assetKey:id,name:id,type:'LOC',applicable:{episode:2,sceneKeys},sourceFacts:[],adoptedDesign:null}});
 const materials=[card('A',['走廊']),card('B',['办公室']),card('C',[])],plan={productionFeedback:{usedMaterialIds:materials.map(m=>m.id),needs:[]}};
 const local={context:{scenes:[{sceneKey:'走廊'}]},sourceRows:[],contextRows:[]};
 const result=selectProductionMaterials(materials,'author',plan,['p1'],[],local,'production-supply-v1');
 assert.deepEqual(result.map(m=>m.id),['asset:A','asset:C']);
 assert.ok(selectProductionMaterials(materials,'author',plan,['p1'],[{stage:2,target:'B',packageIds:['p1']}],local,'production-supply-v1').some(m=>m.id==='asset:B'));
 assert.deepEqual(selectProductionMaterials(materials,'author',plan,['p1']).map(m=>m.id),materials.map(m=>m.id),'legacy selection unchanged');
 const referenced={...local,assets:[{key:'B',name:'B',sceneRefs:[{sceneKey:'办公室'}]}]};
 assert.ok(selectProductionMaterials(materials,'author',plan,['p1'],[],referenced,'production-supply-v1').some(m=>m.id==='asset:B'),'referenced off-screen identity remains readable, not promoted to local appearance');
});
