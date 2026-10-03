import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules} from './storyboard-v4/core/core.mjs';
import {tailFixture} from './storyboard-v4/core/author-call-group-test-fixtures.mjs';
import {selectProductionMaterials} from './production-materials.mjs';
import {scopeProductionSource} from './production-supply.mjs';
import {normalizeSource} from './storyboard-v4/core/source.mjs';

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
