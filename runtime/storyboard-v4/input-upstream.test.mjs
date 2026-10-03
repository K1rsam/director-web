import test from 'node:test';
import assert from 'node:assert/strict';
import {makeEpisodeInput} from './input.mjs';
import {normalizeSource} from './core/source.mjs';
import {buildRequest,captureRules} from './core/core.mjs';
import {digest,PLAN_VERSION,VERSION} from './core/shared.mjs';

const protocol='upstream-material-v2';
const episode={id:'ep-upstream',projectId:'p-upstream',number:2,title:'门外',content:'甲：还没结束。\n△甲扶住门框。'};
const project={id:'p-upstream',style:'3D国漫',aspectRatio:'16:9'};
const previousText='△甲左手受伤。\n△甲走到门口。';
const fact=(id,statement,evidence,kind='STATE')=>({id,subjects:['甲'],kind,statement,evidence,claim:'SOURCE',applicability:'SUBJECT',validity:{status:'UNKNOWN'}});
function packet(){
 const background=fact('global-bg-id','甲不能负重。',{domain:'CONTEXT',sectionKey:'bio-甲',start:12,end:18},'CONTEXT');
 return {sourceText:episode.content,documentRevision:7,sourceVersion:'global-script-1',sourceContextVersion:'global-context-1',
  assets:[{key:'hero',name:'甲',variants:[]}],scenes:[{sceneKey:'2-1',heading:'门外',decisions:[{id:'d',revision:'all-1',sourceVersion:'global-script-1',userAnswer:'保持低声'}]}],
  decisions:[{id:'d',revision:'all-1',sourceVersion:'global-script-1',decidedAt:'2026-01-01',userAnswer:'保持低声'}],followUps:[{note:'衣袖需连续',sourceVersion:'global-script-1'}],
  boundaryContext:{previousSource:{episode:1,text:previousText,startLine:4,endLine:5,clipped:true},priorStates:[],gaps:['仅前场末段']},
  facts:{schema:'FOUNDATION_FACTS_V1',sourceVersion:'global-script-1',sourceContextVersion:'global-context-1',
   current:[],sourceFactIndex:[],background:[background],backgroundCandidates:[background],historicalStates:[
    fact('global-history-id','△甲左手受伤。\n',{domain:'EPISODE',episode:1,start:120,end:128}),
    fact('unavailable-history','△甲以前穿着红衣。',{domain:'EPISODE',episode:0,start:0,end:9})
   ],rules:'原文是检索证据，历史状态并非当前状态。'},
  upstream:{version:'EPISODE_UPSTREAM_V1',seriesDirection:{status:'CONFIRMED',projection:{schemaVersion:'DIRECTOR_SERIES_DIRECTION_V1',id:'dir',revision:1,sourceVersion:'global-script-1',cardHash:'direction-hash',brief:'整体克制，局部可以爆发。'}},
   assetDesigns:[{assetKey:'hero',status:'TEXT_ADOPTED',history:['do-not-send-history'],fullPrompt:'do-not-send-fullprompt'}],
   modelDesigns:[{assetKey:'hero',adoptionVersion:1,brief:'灰衣、蓝色钥匙扣。',materialAvailability:'TEXT_ONLY',references:[{id:'ref-1',description:'用户参考说明；没有读取像素',available:false,path:'do-not-send-path'}],fullPrompt:'do-not-send-fullprompt'}],policy:'do-not-send-arbitrary-policy'}
 };
}
const build=(p=packet(),extra={})=>makeEpisodeInput({episode,project,handoff:{packet:p},inputProtocol:protocol,...extra});
const modelInput=result=>JSON.parse(buildRequest({stage:'plan',source:result.source,settings:{fantasyMode:'off',maxUnits:null}}).prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n')[0]);

function productionCard(assetKey='hero',use='ACTUAL_APPEARANCE'){
 const quote='△甲扶住门框。',start=episode.content.indexOf(quote);
 return {schema:'ASSET_PRODUCTION_CARD_V1',assetKey,name:'甲',type:'CHAR',use,applicable:{episode:2,sceneKeys:['2-1']},
  sourceFacts:use==='ACTUAL_APPEARANCE'?[{id:'fact-card',claim:'SOURCE',quote,association:'ASSET_NAME',evidence:{domain:'EPISODE',episode:2,start,end:start+quote.length}}]:[],
  adoptedDesign:null,freeDesignScope:'仅非剧情美术补足，不新增门与能力。',materialAvailability:'TEXT_ONLY',imageEvidence:'NO_PIXELS_READ',references:[],
  materialNeeds:[{kind:'REFERENCE_IMAGE',required:false,detail:'不阻断文字制作。'}]};
}
function knowledge(timing='CURRENT_EPISODE_EVENT'){
 const quote='还没结束。',start=episode.content.indexOf(quote);
 return {id:'knowledge-1',kind:'REVEAL',claim:'CHARACTER_CLAIM',statement:'甲声称还没结束。',subjects:['甲'],source:{evidenceId:'source-1',episodeId:timing==='CURRENT_EPISODE_EVENT'?episode.id:'prior-episode',quote,start,end:start+quote.length},timing};
}
test('unadopted production cards and source-timed series evidence reach every model request without invented state or pixels',()=>{
 const p=packet();p.upstream.modelDesigns=[];p.upstream.assetProductionCards=[productionCard()];p.upstream.seriesKnowledge=[knowledge()];
 const before=structuredClone(p),result=build(p),actual=modelInput(result).source.context;
 assert.deepEqual(actual.assetProductionCards,p.upstream.assetProductionCards);assert.deepEqual(actual.seriesKnowledge,p.upstream.seriesKnowledge);
 assert.deepEqual(result.source.entryFacts,[]);assert.equal(actual.assetProductionCards[0].adoptedDesign,null);assert.equal(actual.assetProductionCards[0].imageEvidence,'NO_PIXELS_READ');
 assert.equal(actual.seriesKnowledge[0].claim,'CHARACTER_CLAIM');assert.match(actual.productionEvidenceRule,/引用位置/);assert.match(actual.productionEvidenceRule,/不等于.*永久/);
 const sourceRefs=result.source.sourceRows.map(row=>row.id),emotionContract={subject:'甲',contextTone:'紧张',audienceEffect:'担心',change:'停住',landing:'门框',retain:['原文动作']};
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'停住',entryFacts:[],fantasyCandidates:[],
  events:[{id:'e1',sourceRefs,sceneKey:'门外',boundaryBefore:{kind:'episode_start',reason:'本集开始'},emotionContract}],
  workPackages:[{id:'p1',eventId:'e1',sourceRefs,emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],
  provisionalUnits:[{id:'u1',packageId:'p1',sourceRefs,secondsRange:[2,5]}]};
 for(const mode of ['author','finish','delta']){
  const request=buildRequest({stage:mode==='author'?'author':'finish',source:result.source,settings:{fantasyMode:'off',maxUnits:null},plan,packageId:'p1',finishMode:mode==='delta'?'delta':'full',
   ...(mode!=='author'?{previousDraft:{schemaVersion:VERSION,units:[{id:'p1-u1',shots:[]}],fantasyRealization:[]}}:{})});
  const context=JSON.parse(request.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n')[0]).source.context;
  assert.deepEqual(context.assetProductionCards,p.upstream.assetProductionCards,mode);assert.deepEqual(context.seriesKnowledge,p.upstream.seriesKnowledge,mode);
 }
 assert.deepEqual(p,before);
});
test('material-only cards remain separate from actual appearance and reference paths are not sent',()=>{
 const p=packet();p.materialDependencies=[{key:'material-only',name:'参考门',type:'LOC'}];
 const card=productionCard('material-only','MATERIAL_SOURCE_ONLY');card.references=[{id:'reference',description:'参考文字，没有读像素',available:true,path:'private-reference-path'}];
 p.upstream.assetProductionCards=[card];p.upstream.seriesKnowledge=[knowledge('PRIOR_EVIDENCE')];
 const actual=modelInput(build(p)).source;
 assert.equal(actual.context.assetProductionCards[0].use,'MATERIAL_SOURCE_ONLY');assert.equal(actual.context.seriesKnowledge[0].timing,'PRIOR_EVIDENCE');
 assert.equal(actual.assets.some(asset=>asset.key==='material-only'),false);assert.ok(!JSON.stringify(actual).includes('private-reference-path'));
});
test('need-scoped candidate is supplementary, never adopted or an entry fact; mismatched scope fails closed',()=>{
 const p=packet();p.upstream.assetProductionCards=[productionCard()];
 const scope={workflowId:'flow-1',runId:'run-1',episodeNumber:2,sourceVersion:p.sourceVersion};
 p.upstream.materialCandidateScope=structuredClone(scope);
 const candidate={provenance:'CANDIDATE_ONLY',version:'candidate-1',brief:'沿用已锁定灰衣；门框只按原文扶握，不新增能力。',scope,needs:[{needRef:'request-1:0',target:'hero',purpose:'说明门框与手的接触范围',packageIds:['p1'],sourceRefs:[`${episode.id}:L0002`]}],limitations:['未给出手套细节。']};
 p.upstream.assetProductionCards[0].candidateDesign=candidate;
 p.upstream.assetProductionCards[0].adoptedDesign={version:1,brief:'灰衣，袖口收紧。',provenance:'ADOPTED_DESIGN_NOT_SOURCE_FACT'};
 const result=build(p),context=modelInput(result).source.context;
 assert.deepEqual(context.assetProductionCards[0].candidateDesign,candidate);
 assert.equal(context.assetProductionCards[0].adoptedDesign.brief,'灰衣，袖口收紧。');assert.deepEqual(result.source.entryFacts,[]);
 assert.match(context.productionEvidenceRule,/候选/);assert.match(context.productionEvidenceRule,/采用设计优先/);
 for(const mutate of [
  c=>{c.scope.runId='other';},c=>{c.scope.workflowId='other';},c=>{c.scope.episodeNumber=9;},c=>{c.scope.sourceVersion='old';},
  c=>{c.provenance='ADOPTED';},c=>{c.needs[0].target='unknown';},c=>{c.needs[0].sourceRefs=['unbound-ref'];},c=>{c.needs[0].packageIds=[];},c=>{c.brief='字'.repeat(601);}
 ]){const bad=structuredClone(p);mutate(bad.upstream.assetProductionCards[0].candidateDesign);assert.throws(()=>build(bad),e=>e.code==='UPSTREAM_MATERIAL_CANDIDATE');}
 const unscoped=structuredClone(p);delete unscoped.upstream.materialCandidateScope;assert.throws(()=>build(unscoped),e=>e.code==='UPSTREAM_MATERIAL_CANDIDATE');
});
test('production-card and series-evidence adapters fail closed on identity, scope, claim, or false timing',()=>{
 for(const mutate of [
  p=>{p.upstream.assetProductionCards[0].assetKey='unknown';},
  p=>{p.upstream.assetProductionCards[0].use='MATERIAL_SOURCE_ONLY';},
  p=>{p.upstream.assetProductionCards[0].applicable.episode=9;},
  p=>{p.upstream.assetProductionCards[0].sourceFacts[0].claim='INFERRED_SOURCE';},
  p=>{p.upstream.assetProductionCards[0].imageEvidence='PIXELS_READ';},
  p=>{p.upstream.seriesKnowledge[0].source.episodeId='prior-episode';},
  p=>{p.upstream.seriesKnowledge[0].source.quote='不在原文';},
  p=>{p.upstream.seriesKnowledge[0].timing='PERMANENT_STATE';}
 ]){const p=packet();p.upstream.assetProductionCards=[productionCard()];p.upstream.seriesKnowledge=[knowledge()];mutate(p);assert.throws(()=>build(p),e=>e.code?.startsWith('UPSTREAM_'));}
});
test('multiple candidate needs retain separate scope, ignore the legacy alias, and reject ambiguous duplicate needs',()=>{
 const p=packet(),scope={workflowId:'flow',runId:'run',episodeNumber:2,sourceVersion:p.sourceVersion};p.upstream.materialCandidateScope=structuredClone(scope);
 const a={provenance:'CANDIDATE_ONLY',version:'a',brief:'袖口材料',scope,needs:[{needRef:'a:0',target:'hero',purpose:'袖口',sourceRefs:[`${episode.id}:L0002`],packageIds:['p1']}],limitations:[]};
 const b={...structuredClone(a),version:'b',brief:'鞋底材料',needs:[{...structuredClone(a.needs[0]),needRef:'b:0',purpose:'鞋底',packageIds:['p3']}]};
 p.upstream.assetProductionCards=[{...productionCard(),candidateDesign:a,candidateDesigns:[a,b]}];
 const card=build(p).source.context.assetProductionCards[0];assert.deepEqual(card.candidateDesigns,[a,b]);assert.equal(card.candidateDesign,undefined,'legacy alias is never supplied twice');
 for(const mutate of [c=>{c[1].scope.runId='other';},c=>{c[1].needs[0].sourceRefs=['foreign'];},c=>{c[1].needs[0].needRef='a:0';}]){const bad=structuredClone(p);mutate(bad.upstream.assetProductionCards[0].candidateDesigns);assert.throws(()=>build(bad),e=>e.code==='UPSTREAM_MATERIAL_CANDIDATE');}
 const bad=structuredClone(p);bad.upstream.assetProductionCards[0].candidateDesigns={a};assert.throws(()=>build(bad),e=>e.code==='UPSTREAM_MATERIAL_CANDIDATE');
});

test('V2 sends only confirmed direction and adopted material summaries, never histories or pixels',()=>{
 const p=packet(),before=structuredClone(p),result=build(p),context=result.source.context,actual=modelInput(result).source.context;
 assert.deepEqual(context.seriesDirection,{brief:'整体克制，局部可以爆发。'});
 assert.deepEqual(context.modelDesigns,[{assetKey:'hero',adoptionVersion:1,brief:'灰衣、蓝色钥匙扣。',materialAvailability:'TEXT_ONLY',references:[{id:'ref-1',description:'用户参考说明；没有读取像素',available:false}]}]);
 assert.deepEqual(actual.seriesDirection,context.seriesDirection);assert.deepEqual(actual.modelDesigns,context.modelDesigns.map(({adoptionVersion,...design})=>design));
 assert.match(context.upstreamMaterialRule,/不是剧情证据/);assert.match(context.upstreamMaterialRule,/未读取.*像素/);
 assert.ok(!JSON.stringify(actual).includes('do-not-send'));
 assert.equal(Object.hasOwn(context,'documentRevision'),false);assert.equal(Object.hasOwn(context,'sourceContextVersion'),false);
 assert.deepEqual(result.source.entryFacts,[]);assert.deepEqual(p,before);
});

test('unconfirmed/stale direction and all UI-only asset statuses cannot reach the new model context',()=>{
 for(const status of ['UNCONFIRMED','STALE','DRAFT']){
  const p=packet();p.upstream.seriesDirection.status=status;p.upstream.modelDesigns=[];
  const first=build(p);assert.equal(first.source.context.seriesDirection,null);assert.deepEqual(first.source.context.modelDesigns,[]);
  p.upstream.seriesDirection.projection.brief='未确认的完全不同方向';p.upstream.assetDesigns[0].fullPrompt='另一个未采用整稿';
  assert.equal(build(p).sourceVersion,first.sourceVersion);
 }
});

test('V2 stays stable for global document/fact versions, derived ids, other-episode decisions and UI history',()=>{
 const p=packet(),base=build(p),baseInput=modelInput(base);
 for(const mutate of [
  x=>{x.documentRevision++;x.sourceVersion='global-script-2';x.sourceContextVersion='global-context-2';},
  x=>{x.facts.sourceVersion='global-script-2';x.facts.sourceContextVersion='global-context-2';for(const group of ['background','backgroundCandidates','historicalStates'])for(const f of x.facts[group])f.id+='-regenerated';},
  x=>{x.decisions[0].revision='all-2';x.decisions[0].sourceVersion='global-script-2';x.decisions[0].decidedAt='2026-03-04';x.scenes[0].decisions[0].revision='all-2';x.followUps[0].sourceVersion='global-script-2';},
  x=>{Object.assign(x.upstream.seriesDirection.projection,{id:'new-dir-record',revision:99,sourceVersion:'global-script-2',cardHash:'other-record-hash'});},
  x=>{x.upstream.assetDesigns[0].status='new-ui-history';x.upstream.assetDesigns[0].history.push('other-episode');x.otherEpisodeResolutions={9:{revision:50}};}
 ]){const changed=structuredClone(p);mutate(changed);const next=build(changed);assert.equal(next.sourceVersion,base.sourceVersion);assert.deepEqual(modelInput(next),baseInput);}
 assert.equal(build(p,{notes:'仅本次导演要求'}).sourceVersion,base.sourceVersion);
});

test('V2 invalidates on effective direction, designs, references, facts and local semantic decisions',()=>{
 const p=packet(),base=build(p);
 for(const mutate of [
  x=>{x.upstream.seriesDirection.projection.brief='整体喜剧，动作夸张。';},
  x=>{x.upstream.seriesDirection.status='STALE';},
  x=>{x.upstream.modelDesigns[0].brief='改为蓝衣。';},
  x=>{x.upstream.modelDesigns[0].adoptionVersion++;},
  x=>{x.upstream.modelDesigns[0].references[0].description='另一张参考说明';},
  x=>{x.upstream.modelDesigns[0].references[0].available=true;x.upstream.modelDesigns[0].materialAvailability='REFERENCE_AVAILABLE';},
  x=>{x.upstream.modelDesigns=[];},
  x=>{x.facts.background[0].statement='甲可以负重。';},
  x=>{x.facts.historicalStates[0].validity.status='EXPLICIT';},
  x=>{x.decisions[0].userAnswer='大声喊出';},
  x=>{x.boundaryContext.previousSource.text='△甲左手已恢复。';}
 ]){const changed=structuredClone(p);mutate(changed);assert.notEqual(build(changed).sourceVersion,base.sourceVersion);}
});

test('canonical statements become stable deduplicated rows with exact provenance and conservative evidence roles',()=>{
 const p=packet(),previous=p.boundaryContext.previousSource;
 previous.sourceRange={start:120,end:120+previous.text.length};
 p.episodeBoundary={schema:'EPISODE_BOUNDARY_SEED_V1',sourceVersion:p.sourceVersion,fromEpisode:1,toEpisode:2,
  previousSource:{...previous,nodes:[{id:'prior-action-1',target:'BODY',kind:'ACTION',sourceRange:{start:120,end:128}},
   {id:'prior-action-2',target:'BODY',kind:'ACTION',sourceRange:{start:128,end:120+previous.text.length}}]}};
 const result=build(p),rows=result.source.contextRows,background=rows.filter(row=>row.text==='甲不能负重。');
 assert.equal(background.length,1,'same exact origin in background/candidates is supplied once');
 assert.equal(background[0].evidenceRole,'guidance');assert.equal(background[0].kind,'guidance');
 assert.deepEqual(background[0].provenance.origin,{domain:'CONTEXT',sectionKey:'bio-甲',start:12,end:18});
 assert.equal(background[0].provenance.offsetUnit,'UTF16');assert.equal(background[0].provenance.verifiedAgainst,null);
 const historical=rows.find(row=>row.id==='previous-1:excerpt-1'),fact=result.source.context.retrievalFacts.historicalStates[0];
 assert.equal(fact.contextRef,historical.id);assert.equal(fact.contextEvidence.verifiedAgainst,'PREVIOUS_EXCERPT');
 assert.deepEqual(fact.contextEvidence.excerptRange,{start:0,end:8});
 const unavailable=rows.find(row=>row.text==='△甲以前穿着红衣。');assert.equal(unavailable.evidenceRole,'guidance');
 assert.deepEqual(result.source.entryFacts,[]);
 assert.throws(()=>normalizeSource({...result.source,entryFacts:[{id:'unsafe',subject:'甲',statement:'不能负重',sourceRefs:[background[0].id],evidenceMode:'source_rows'}]}),e=>e.code==='ENTRY_FACT_GUIDANCE');
 const verified=normalizeSource({...result.source,entryFacts:[{id:'history',subject:'甲',statement:'前场曾受伤，非自动继承',sourceRefs:[historical.id],evidenceMode:'source_rows'}]});
 assert.deepEqual(verified.entryFacts[0].evidence,['△甲左手受伤。']);
 assert.equal(fact.statement,'△甲左手受伤。\n','canonical statement keeps the original terminator');
 assert.ok(modelInput(result).source.contextRows.some(row=>row.id===background[0].id&&row.kind==='guidance'));
});

test('current source facts do not copy body into contextRows; invalid source coordinates cannot self-prove',()=>{
 const p=packet(),statement='△甲扶住门框。',start=episode.content.indexOf(statement);
 p.facts.current=[fact('current-local',statement,{domain:'EPISODE',episode:2,start,end:start+statement.length})];
 p.facts.backgroundCandidates.push(fact('bad-coordinate','写得很炫',{domain:'CONTEXT',sectionKey:'guide',start:0,end:1},'CONTEXT'));
 const result=build(p);
 assert.ok(!result.source.contextRows.some(r=>r.text===statement));
 assert.ok(!result.source.contextRows.some(r=>r.text==='写得很炫'));
 assert.ok(result.source.sourceRows.some(r=>r.text===statement));
 assert.match(result.source.context.contextEvidenceRule,/sourceRows.*sourceRefs/);
});

test('current/sourceFactIndex-only packets never add a second current-episode transcript',()=>{
 const p=packet();p.boundaryContext=null;
 const statement='△甲扶住门框。',start=episode.content.indexOf(statement),row=fact('current-id',statement,{domain:'EPISODE',episode:2,start,end:start+statement.length});
 p.facts={schema:'FOUNDATION_FACTS_V1',sourceVersion:'all-1',current:[row],sourceFactIndex:[row],background:[],backgroundCandidates:[],historicalStates:[]};
 const result=build(p);assert.equal(result.source.contextRows.length,0);
 assert.deepEqual(result.source.sourceRows.map(r=>r.text),episode.content.split('\n'));
});

test('historical evidence already inside previousSource reuses context ids without a duplicate quote',()=>{
 const p=packet();p.facts.background=[];p.facts.backgroundCandidates=[];p.facts.historicalStates=p.facts.historicalStates.slice(0,1);
 const result=build(p);
 assert.equal(result.source.contextRows.length,2);
 assert.deepEqual(result.source.contextRows.map(r=>r.id),['previous-1:excerpt-1','previous-1:excerpt-2']);
 assert.equal(result.source.context.retrievalFacts.historicalStates[0].contextRef,'previous-1:excerpt-1');
});

test('unknown protocols and invalid active material projections fail closed',()=>{
 assert.throws(()=>build(packet(),{inputProtocol:'upstream-material-v99'}),e=>e.code==='SOURCE_PROTOCOL');
 for(const mutate of [
  x=>{x.upstream.version='EPISODE_UPSTREAM_V99';},
  x=>{x.upstream.seriesDirection.projection.brief='';},
  x=>{x.upstream.modelDesigns[0].assetKey='not-this-episode';},
  x=>{x.upstream.modelDesigns.push(structuredClone(x.upstream.modelDesigns[0]));},
  x=>{delete x.upstream.modelDesigns[0].references[0].available;}
 ]){const p=packet();mutate(p);assert.throws(()=>build(p),e=>e.code?.startsWith('UPSTREAM_'));}
});

test('independent fragments and stale nonstandard packets cannot inherit upstream context',()=>{
 const profile={schemaVersion:'independent-source-context-v1',projectId:project.id,episodeId:episode.id,contentHash:digest(episode.content),title:'独立',scene:'门外',origin:{episode:'原8集'},contextRows:[{id:'independent',text:'此前原句'}],entryFacts:[]};
 const legacy=makeEpisodeInput({episode,project,independentSource:profile}),next=build(packet(),{independentSource:profile});
 assert.deepEqual(next,legacy);
 const p=packet();p.sourceText='过期原文';const stale=build(p);
 assert.equal(stale.source.context.seriesDirection,null);assert.deepEqual(stale.source.context.modelDesigns,[]);
 assert.equal(stale.sourceVersion,makeEpisodeInput({episode,project,inputProtocol:protocol}).sourceVersion);
});

// Frozen synthetic compiler output: this fixture is not regenerated by the new adapter.
function standardFixture(){
 const version='src:bacc2eb886ba2cbcb795bf55e52b7455c6b1d8848c2d68b221d68a97966e71b3',unitId=version+':u1';
 const binding={sourceId:'episode-2',sourceVersion:version,indexerVersion:'physical-lines-v1',sourceIndexDigest:'d40d295465dadf731fa21abba0930a608d5ddf76ece6607243a6efada3e26b76',planDigest:'38c825c7645cd0fc664f86580aa03c8a83f995b4a3b459483ff025046cfebe5f'};
 const part=(kind,start,end)=>({kind,unitId,start,end});
 return {schemaVersion:'DIRECTOR_STANDARD_SCRIPT_SLICE_V1',assemblerVersion:'standard-script-compiler-v1',binding,
  script:{entries:[{id:'line-1',target:'BODY',kind:'ACTION',sourceUnitIds:[unitId],text:'甲停下。',textAssembly:{parts:[part('SOURCE_SLICE',1,5)]},layout:[part('SOURCE_SLICE',0,1),part('SOURCE_SEPARATOR',5,6)]}]},annotations:[],exclusions:[],
  evidence:[{id:unitId,start:0,end:6,text:'△甲停下。\n',sourceVersion:version,offsetUnit:'UTF16'}],fidelity:{assignments:[{unitId,target:'BODY',targetId:'line-1',fieldPath:'script.entries[0]'}],
   receipt:{schemaVersion:'STANDARD_SCRIPT_MECHANICAL_RECEIPT_V1',status:'MECHANICALLY_VERIFIED',...binding,packageDigest:'13c9ab9c53adbf10d9d0767a7827f77704242b81d23c8b78f7b0a3f33ce0dc0b',readingTextDigest:'1cf58ea9ae5c19141082c26b3ba3d4751c37715738db085a5187ef448ba1362d',assemblerVersion:'standard-script-compiler-v1',checks:{unitCoverage:'VERIFIED',sourceOrder:'VERIFIED',sourceSlices:'VERIFIED',fieldBoundaries:'VERIFIED',exclusionShape:'VERIFIED',noTextPatches:'VERIFIED'},semantic:'NOT_RUN',acceptedForDispatch:false}},
  readiness:{mechanical:'VERIFIED',semantic:'NOT_RUN',acceptedForDispatch:false,blockers:['SEMANTIC_REVIEW_NOT_RUN','PRODUCTION_INTEGRATION_NOT_IMPLEMENTED']},packageId:'standard:13c9ab9c53adbf10d9d0767a7827f77704242b81d23c8b78f7b0a3f33ce0dc0b'};
}
test('legacy and standard-episode-v1 fixed hashes and receipts stay byte-for-byte compatible',()=>{
 const legacyPacket={sourceText:episode.content,documentRevision:7,sourceContextVersion:'global-context-1',assets:[],scenes:[],followUps:[],decisions:[],facts:null};
 for(const inputProtocol of [undefined,'legacy'])assert.equal(makeEpisodeInput({episode,project,handoff:{packet:legacyPacket},inputProtocol}).sourceVersion,'5842d470d27f6c431127bd092dc2f8f0515d9ac4f12b86933f41832421f1a91f');
 const standardScript=standardFixture(),before=structuredClone(standardScript),standardEpisode={...episode,content:'△甲停下。\n'};
 const standardPacket={...legacyPacket,sourceText:standardEpisode.content,scriptReception:{version:'standard-episode-v1',ready:true},standardScript};
 for(const inputProtocol of [undefined,'standard-episode-v1']){
  const result=makeEpisodeInput({episode:standardEpisode,project,handoff:{packet:standardPacket},inputProtocol});
  assert.equal(result.sourceVersion,'857aa616870b8131b654cae809f0834012f4213b81a807e5ed7afea5f15218ee');
  assert.deepEqual(result.source.standardPackage,before);assert.deepEqual(result.source.sourceRows.map(row=>row.id),['ep-upstream:line-1']);
 }
});

test('measure complete dispatch content for all four request forms, with no duplicated current/previous transcript',()=>{
 const e={...episode,content:'△甲停下。\n'},p=packet();
 Object.assign(p,{sourceText:e.content,scriptReception:{version:'standard-episode-v1',ready:true},standardScript:standardFixture()});
 // Real canonical fact ids are hashes rather than the readable labels used by other unit tests.
 for(const group of ['background','backgroundCandidates','historicalStates'])for(const fact of p.facts[group])fact.id=digest(fact.id);
 const versions=['standard-episode-v1',protocol].map(inputProtocol=>makeEpisodeInput({episode:e,project,handoff:{packet:p},inputProtocol}));
 const rulesSnapshot=captureRules(),settings={fantasyMode:'off',maxUnits:null},metrics=[];
 const emotionContract={subject:'甲',contextTone:'克制',audienceEffect:'担心',change:'停住',landing:'门框',retain:['源动作']};
 const dispatch=(source,stage)=>{
  const sourceRefs=source.sourceRows.map(row=>row.id);
  const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'停住',entryFacts:[],fantasyCandidates:[],
   events:[{id:'e1',sourceRefs,sceneKey:'门外',boundaryBefore:{kind:'episode_start',reason:'本集开始'},emotionContract}],
   workPackages:[{id:'p1',eventId:'e1',sourceRefs,emotionContract,entryFactIds:[],contextRefs:source.contextRows.map(row=>row.id),dependsOn:[],scenarioKeys:[]}],
   provisionalUnits:[{id:'u1',packageId:'p1',sourceRefs,secondsRange:[2,5]}]};
  return buildRequest({stage:stage==='delta'?'finish':stage,source,settings,rulesSnapshot,plan,packageId:'p1',finishMode:stage==='delta'?'delta':'full',
   ...(stage==='finish'||stage==='delta'?{previousDraft:{schemaVersion:VERSION,units:[{id:'p1-u1',shots:[]}],fantasyRealization:[]}}:{})});
 };
 const size=request=>({promptChars:request.prompt.length,dispatchChars:request.prompt.length+request.instructions.length+JSON.stringify(request.schema??null).length});
 for(const stage of ['plan','author','finish','delta']){
  const [oldRequest,newRequest]=versions.map(value=>dispatch(value.source,stage));
  const actual=JSON.parse(newRequest.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n')[0]).source;
  assert.equal(actual.context.seriesDirection.brief,p.upstream.seriesDirection.projection.brief);
  assert.equal(actual.contextRows.filter(row=>row.text==='甲不能负重。').length,1);
  assert.equal(actual.contextRows.filter(row=>row.text===e.content).length,0);
  assert.equal(actual.contextRows.filter(row=>row.text.startsWith('△甲左手受伤。')).length,1);
  const v1=size(oldRequest),v2=size(newRequest);metrics.push({stage,v1,v2,deltaChars:v2.dispatchChars-v1.dispatchChars});
 }
 console.log('UPSTREAM_REQUEST_SIZE '+JSON.stringify({unit:'UTF16 characters; prompt + instructions + JSON schema; no dispatch/token measurement',metrics,
  addedMaterialChars:JSON.stringify({seriesDirection:versions[1].source.context.seriesDirection,modelDesigns:versions[1].source.context.modelDesigns}).length,
  addedContextTextChars:versions[1].source.contextRows.filter(row=>row.id.startsWith('upstream-evidence:')).reduce((sum,row)=>sum+row.text.length,0),duplicatedCurrentOrPreviousRows:0}));
});
