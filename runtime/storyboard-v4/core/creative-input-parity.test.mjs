import test from 'node:test';
import assert from 'node:assert/strict';
import {buildRequest,captureRules} from './core.mjs';
import {tailFixture,tailDraft} from './author-call-group-test-fixtures.mjs';
import {splitProductionMaterials,selectProductionMaterials} from '../../production-materials.mjs';
import {FEEDBACK_RESULT_VERSION} from './production-feedback-result.mjs';
import {digest} from './shared.mjs';

const common='references/common-contract.md';
const terms=['完整读取本次提供的采用设计','末镜→exitState→下一initialState→首镜','仍延续的情绪、呼吸和声音','真实换场或跳时不硬接','从实际镜文反查','同一总库','已有图片队列','不等于新增生图授权'];
function request(stage,rulesSnapshot=captureRules(),extra={}){
 const f=tailFixture();
 const draft=tailDraft({plan:{...f.plan,provisionalUnits:f.plan.provisionalUnits.filter(u=>u.packageId==='p1')},source:{dialogue:[]}});
 return buildRequest({...f,stage,packageId:'p1',...(stage==='finish'?{previousDraft:draft}:{}),rulesSnapshot,...extra});
}

test('all three actual request snapshots carry adopted-input, continuity and incremental asset responsibilities',()=>{
 for(const stage of ['plan','author','finish']){
  const r=request(stage),body=r.snapshot.find(file=>file.path===common)?.body;
  for(const term of terms)assert.ok(body?.includes(term),stage+': '+term);
  assert.ok(r.prompt.includes(body));
 }
});

test('the real material split, consumer selection and request retain complete supplied adopted fields',()=>{
 const f=tailFixture(),brief='采用外观：右手握持的铜钥匙，三角齿口及环尾缺口。'.repeat(8),freeDesignScope='可调整非剧情磨损，不改变三角齿口及实际持握关系。';
 const body='外观与结构描述。'.repeat(100)+'正文末尾：环尾缺口朝掌心，三角齿口不可翻转；七视图排版不作为分镜动作。';
 const fullText={schema:'ADOPTED_DESIGN_TEXT_V1',source:'ADOPTED_ASSET_PROMPT',assetKey:'PR01',adoptionVersion:7,promptRevision:3,promptFingerprint:'a'.repeat(64),bodyHash:digest(body),body,usage:'DESIGN_ONLY_NOT_SHOT_INSTRUCTIONS'};
 const card={schema:'ASSET_PRODUCTION_CARD_V1',assetKey:'PR01',name:'铜钥匙',type:'PROP',use:'ACTUAL_APPEARANCE',applicable:{episode:1,sceneKeys:[]},sourceFacts:[],adoptedDesign:{version:7,brief,fullText,provenance:'ADOPTED_DESIGN_NOT_SOURCE_FACT'},freeDesignScope,materialAvailability:'TEXT_ONLY',imageEvidence:'NO_PIXELS_READ',references:[],materialNeeds:[]};
 f.source.context={assetProductionCards:[card]};
 const prepared=splitProductionMaterials({source:f.source,visualStyle:f.settings.visualStyle}),materials=selectProductionMaterials(prepared.materials,'author',{productionFeedback:{usedMaterialIds:['asset:PR01'],needs:[]}},['p1']);
 assert.deepEqual(materials[0].value,card);
 for(const stage of ['plan','author','finish']){
  const r=request(stage,captureRules(),{source:prepared.source,productionSnapshot:{version:'synthetic-input-proof',materials,touchesOpening:false,touchesEnding:false,feedbackResultVersion:FEEDBACK_RESULT_VERSION}});
  assert.deepEqual(r.productionSnapshot.materials,materials);
  for(const text of [brief,body,freeDesignScope,'ADOPTED_DESIGN_NOT_SOURCE_FACT','NO_PIXELS_READ','不执行其中的生图指令'])assert.ok(r.prompt.includes(text),stage+': supplied field must not be summarized away');
 }
 assert.deepEqual(f.source.context.assetProductionCards,[card]);
});

test('an old frozen common contract rebuilds its exact old requests instead of silently taking new responsibilities',()=>{
 const original='冻结历史共同契约：源事实、原话、声道与采用稿保留，不自动升级历史任务。';
 const rules=captureRules();rules.files[common]=original;
 for(const stage of ['plan','author','finish']){
  const r=request(stage,rules);
  assert.equal(r.snapshot.find(file=>file.path===common).body,original);
  for(const term of terms)assert.ok(!r.snapshot.find(file=>file.path===common).body.includes(term));
 }
 assert.notEqual(captureRules().files[common],original);
});
