import test from 'node:test';
import assert from 'node:assert/strict';
import {splitProductionMaterials,selectProductionMaterials,changedConsumedMaterials,sourceEvidenceCompatible,materialChangeCoordinates} from './production-materials.mjs';
test('source and direction stay guarded; supplements use per-consumer versions',()=>{
 const prepared={source:{key:'e1',sourceRows:[{id:'s1',text:'甲持钥匙。'}],dialogue:[],context:{seriesDirection:{brief:'喜剧'},assetProductionCards:[{assetKey:'CH01',design:'黑衣'},{assetKey:'PR01',design:'铜钥匙'}]}},visualStyle:'国漫'};
 const first=splitProductionMaterials(prepared),next=structuredClone(prepared);next.source.context.assetProductionCards[1].design='银钥匙';
 const second=splitProductionMaterials(next);assert.equal(first.sourceBasisVersion,second.sourceBasisVersion);
 assert.deepEqual(changedConsumedMaterials(first.materials,second.materials,['asset:CH01']),[]);
 assert.deepEqual(changedConsumedMaterials(first.materials,second.materials,['asset:PR01']),['asset:PR01']);
 next.source.sourceRows[0].text='甲放下钥匙。';assert.notEqual(splitProductionMaterials(next).sourceBasisVersion,first.sourceBasisVersion);
 next.source=structuredClone(prepared.source);next.source.context.seriesDirection.brief='惊悚';assert.notEqual(splitProductionMaterials(next).sourceBasisVersion,first.sourceBasisVersion);
 assert.equal(first.source.context.assetProductionCards,undefined);assert.equal(prepared.source.context.assetProductionCards.length,2);
 assert.deepEqual(selectProductionMaterials(first.materials,'author',{productionFeedback:{usedMaterialIds:['asset:CH01'],needs:[]}},['p1']).map(m=>m.id),['asset:CH01']);
});
test('material repairs identify changed fields without resending the whole old catalog',()=>{
 const before=[{id:'asset:SC02',kind:'ADOPTED_DESIGN',version:'v1',value:{wall:'白墙',doors:['东侧门'],functional:{exit:'东侧'}}}],after=structuredClone(before);
 after[0].version='v2';after[0].value.wall='灰墙';after[0].value.functional.exit='西侧';
 assert.deepEqual(materialChangeCoordinates(before,after,['asset:SC02']),['asset:SC02/value.wall','asset:SC02/value.functional.exit']);
 assert.deepEqual(materialChangeCoordinates(before,after,[]),[]);
});
test('changed source evidence and knowledge are guarded; new unrelated rows are not stale',()=>{
 const prepared={source:{key:'e1',sourceRows:[{id:'s1',text:'甲站着。'}],dialogue:[],contextRows:[{id:'ctx-1',text:'乙已知道秘密。',kind:'action'}],context:{seriesKnowledge:[{key:'secret',value:'known'}]}}};
 const first=splitProductionMaterials(prepared),next=structuredClone(prepared);
 next.source.contextRows.push({id:'ctx-2',text:'新增可选背景。',kind:'action'});
 const added=splitProductionMaterials(next);assert.equal(first.sourceBasisVersion,added.sourceBasisVersion);assert.equal(sourceEvidenceCompatible(first.contextEvidence,added.contextEvidence),true);
 next.source.contextRows[0].text='乙尚不知道秘密。';assert.equal(sourceEvidenceCompatible(first.contextEvidence,splitProductionMaterials(next).contextEvidence),false);
 next.source.context.seriesKnowledge[0].value='unknown';assert.notEqual(first.sourceBasisVersion,splitProductionMaterials(next).sourceBasisVersion);
});
test('a need first discovered by the author reaches later local work even if absent from plan use',()=>{
 const cards=[{id:'asset:PR01',version:'v2'}],plan={productionFeedback:{usedMaterialIds:[],needs:[]}};
 const needs=[{stage:2,target:'PR01',packageIds:['p2'],resolved:false}];
 assert.deepEqual(selectProductionMaterials(cards,'finish',plan,['p2'],needs),cards);
 assert.deepEqual(selectProductionMaterials(cards,'finish',plan,['p1'],needs),[]);
});
test('a p1-only material candidate never changes p2 supplied data or its consumed base version',()=>{
 const prepared={source:{key:'e1',sourceRows:[{id:'s1',text:'甲开门。'}],dialogue:[],context:{assetProductionCards:[{assetKey:'SC01',adoptedDesign:{brief:'已锁定场景'}}]}}};
 const before=splitProductionMaterials(prepared),next=structuredClone(prepared);
 next.source.context.assetProductionCards[0].candidateDesign={provenance:'CANDIDATE_ONLY',version:'v2',scope:{workflowId:'flow',runId:'run',episodeNumber:1},needs:[{needRef:'need:1',packageIds:['p1']}],brief:'只为p1补门锁功能'};
 const after=splitProductionMaterials(next),plan={productionFeedback:{usedMaterialIds:['asset:SC01'],needs:[]}};
 const oldP2=selectProductionMaterials(before.materials,'author',plan,['p2']),newP2=selectProductionMaterials(after.materials,'author',plan,['p2']);
 assert.deepEqual(newP2,oldP2);assert.deepEqual(changedConsumedMaterials(oldP2,after.materials,['asset:SC01']),[]);
 const p1=selectProductionMaterials(after.materials,'author',plan,['p1']);assert.equal(p1.length,2);assert.equal(p1[1].value.provenance,'CANDIDATE_ONLY');
 assert.equal(p1[0].value.candidateDesign,undefined);
});
test('multiple needs on one asset retain stable scoped candidates and do not enter unmatched jobs',()=>{
 const a={provenance:'CANDIDATE_ONLY',version:'a',scope:{workflowId:'flow',runId:'run',episodeNumber:1},needs:[{needRef:'a:0',packageIds:['p1']}],brief:'袖口'},b={...a,version:'b',needs:[{needRef:'b:0',packageIds:['p3']}],brief:'鞋底'};
 const source=candidates=>({source:{key:'e1',sourceRows:[],dialogue:[],context:{assetProductionCards:[{assetKey:'CH01',adoptedDesign:{brief:'灰衣'},candidateDesigns:candidates}]}}});
 const first=splitProductionMaterials(source([a])),second=splitProductionMaterials(source([a,b])),plan={productionFeedback:{usedMaterialIds:['asset:CH01'],needs:[]}};
 const oldP1=selectProductionMaterials(first.materials,'author',plan,['p1']);assert.equal(oldP1.length,2);
 assert.deepEqual(selectProductionMaterials(second.materials,'author',plan,['p1']),oldP1);assert.deepEqual(changedConsumedMaterials(oldP1,second.materials,oldP1.map(m=>m.id)),[]);
 assert.deepEqual(selectProductionMaterials(second.materials,'plan',null,[]).map(m=>m.id),['asset:CH01']);
 assert.deepEqual(selectProductionMaterials(second.materials,'author',null,['p2']).map(m=>m.id),['asset:CH01']);
 const both=source([a,b]);both.source.context.assetProductionCards[0].candidateDesign=a;assert.deepEqual(splitProductionMaterials(both).materials,second.materials,'array takes precedence without double supply');
 const legacy=source([]);delete legacy.source.context.assetProductionCards[0].candidateDesigns;legacy.source.context.assetProductionCards[0].candidateDesign=a;assert.deepEqual(splitProductionMaterials(legacy).materials,first.materials,'old singleton material IDs and versions remain readable');
});

test('pure quote-index additions already read by this consumer need no paid repair',()=>{
 const quote='甲拿起钥匙。\n';
 const fact={id:'f1',quote,claim:'SOURCE',association:'ASSET_NAME',evidence:{domain:'EPISODE',episode:1,start:0,end:quote.length}};
 const card={schema:'ASSET_PRODUCTION_CARD_V1',assetKey:'CH01',applicable:{episode:1,sceneKeys:['1-1']},sourceFacts:[],adoptedDesign:null};
 const old=[{id:'asset:CH01',kind:'ASSET_PRODUCTION_CARD',value:card,version:'old'}];
 const next=[{...old[0],value:{...card,sourceFacts:[fact]},version:'new'}];
 const readSource={sourceRows:[{id:'s1',text:fact.quote,kind:'action'}],contextRows:[]};
 const saved=JSON.stringify(old);
 assert.deepEqual(changedConsumedMaterials(old,next,['asset:CH01'],readSource),[]);
 assert.equal(JSON.stringify(old),saved,'paid snapshot is immutable');
 assert.deepEqual(changedConsumedMaterials(old,next,['asset:CH01']),['asset:CH01'],'unproven legacy changes remain strict');
 assert.deepEqual(changedConsumedMaterials(old,next,['asset:CH01'],{sourceRows:[],contextRows:readSource.sourceRows}),['asset:CH01'],'unscoped context is not current script evidence');
 for(const mutate of [
  m=>{m.value.adoptedDesign={brief:'红衣'};},
  m=>{m.value.sourceFacts[0].claim='CHARACTER_CLAIM';},
  m=>{m.value.sourceFacts[0].evidence.episode=2;},
  m=>{m.value.sourceFacts[0].association='VISUAL_FACT';},
  m=>{m.value.sourceFacts[0].quote='甲放下钥匙。\n';},
  m=>{m.value.sourceFacts[0].unknownConstraint='新约束';},
 ]){
  const changed=structuredClone(next);mutate(changed[0]);
  assert.deepEqual(changedConsumedMaterials(old,changed,['asset:CH01'],readSource),['asset:CH01']);
 }
 const claimQuote='甲：这是我的钥匙。\n';
 const addedClaim={...fact,id:'f2',quote:claimQuote,claim:'CHARACTER_CLAIM',evidence:{...fact.evidence,start:quote.length,end:quote.length+claimQuote.length}};
 next[0].value.sourceFacts.push(addedClaim);readSource.sourceRows.push({id:'s2',text:addedClaim.quote,kind:'dialogue'});
 assert.deepEqual(changedConsumedMaterials(old,next,['asset:CH01'],readSource),[],'speaker claims stay claims, not hard source facts');
 const modified=structuredClone(next);modified[0].version='modified';modified[0].value.sourceFacts[0].quote='甲放下钥匙。\n';
 assert.deepEqual(changedConsumedMaterials(next,modified,['asset:CH01'],readSource),['asset:CH01'],'old fact edits cannot pass as index additions');
});
