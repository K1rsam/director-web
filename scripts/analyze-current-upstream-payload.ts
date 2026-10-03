/** Offline synthetic payload audit. Reads current production builders; no DB/model/network calls. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildSourceIndex} from '../lib/project-foundation-contracts';
import {buildFoundationFacts,selectFoundationFacts} from '../lib/foundation-facts';
import {prepareEpisodeReception} from '../lib/standard-script-reception';
import {projectProductionCatalog} from '../lib/foundation-production-contracts';
import {buildLightBoundaryContext} from '../lib/light-foundation-supply';
import {attachEpisodeMaterials} from '../lib/episode-upstream-material';

const require=createRequire(import.meta.url);
const {makeEpisodeInput}=require('../runtime/storyboard-v4/input.mjs');
const {buildRequest,captureRules}=require('../runtime/storyboard-v4/core/core.mjs');
const {PLAN_VERSION,VERSION}=require('../runtime/storyboard-v4/core/shared.mjs');
const size=(value:unknown)=>JSON.stringify(value)?.length??0;
const project={id:'payload-audit-project',style:'3D国漫',aspectRatio:'16:9'};
const episodes=[
 {id:'audit-e1',projectId:project.id,number:1,title:'借来的钥匙',content:'第一集：借来的钥匙\n1-1 剧场后台 日 内\n出场人物：林岚、程野\n△林岚穿着浅灰外套，把蓝色钥匙扣的铜钥匙放进右口袋。\n程野：明天再还我。\n'},
 {id:'audit-e2',projectId:project.id,number:2,title:'约定',content:'第二集：约定\n2-1 剧场后台 日 内\n出场人物：林岚、程野\n△林岚从右口袋取出铜钥匙，放进程野右手。\n陈叔（VO，对讲机声）：后台的门谁来锁？\n程野：我来锁。\n\n2-2 剧场走廊 日 内\n出场人物：林岚、程野\n△林岚停在走廊，望向程野。\n林岚：午饭等你一起。\n程野：好。\n'}
];
const refs=[{episode:1,sceneKey:'1-1'},{episode:2,sceneKey:'2-1'},{episode:2,sceneKey:'2-2'}];
const asset=(key:string,name:string,type:string,sceneRefs=refs)=>({key,name,type,aliases:[],description:'',sourceRefs:[],appearances:[],usageEpisodes:[...new Set(sceneRefs.map(r=>r.episode))],sceneRefs,variants:[],preparation:{mode:'REFERENCE'}});
const catalog:any={format:'ASSET_CATALOG_V2',coverage:[1,2],issues:[],assets:[asset('lin','林岚｜浅灰外套','CH'),asset('cheng','程野｜默认','CH'),asset('key','铜钥匙（蓝色钥匙扣）','PROP',refs.slice(0,2)),asset('back','剧场后台','LOC',refs.slice(0,2)),asset('hall','剧场走廊','LOC',[refs[2]])],episodes:[{number:1,context:'',assetKeys:['lin','cheng','key','back']},{number:2,context:'',assetKeys:['lin','cheng','key','back','hall']}]};
const sourceIndex=buildSourceIndex(episodes);
const sourceContext:any={version:'synthetic-context-version',background:[{key:'background:synthetic',text:'林岚，女，28岁，剧场场务。程野，男，30岁，舞台管理员。\n陈叔只有对讲机声音，没有实体出场。\n整体保持克制暧昧，不把真实承诺变成恶意捉弄。\n'}],unresolved:[],issues:[],complete:true,notices:[],coverage:[]};
const facts=selectFoundationFacts(buildFoundationFacts(sourceIndex,sourceContext,catalog,{standard:true}),sourceIndex,[2]);
const reception=prepareEpisodeReception(episodes[1],catalog);
assert.equal(reception.scriptReception.ready,true,'synthetic source must pass current standard reception');
const makeScene=(e:number,key:string,location:string,start:number,end:number)=>({episode:e,sceneKey:key,heading:`${location} 日 内`,location,timeOfDay:'日',interiorExterior:'内',weather:null,timeLayer:'现实',characters:['林岚','程野'],sourceRange:{start,end}});
const cut=episodes[1].content.indexOf('2-2');
const allScenes=[makeScene(1,'1-1','剧场后台',0,episodes[0].content.length),makeScene(2,'2-1','剧场后台',0,cut),makeScene(2,'2-2','剧场走廊',cut,episodes[1].content.length)];
const decision={id:'choice-voice',decisionKey:'low-voice',revision:'revision-1',status:'CONFIRMED',question:'音量',answer:'克制，不喊叫',episodes:[2],applicationScope:{kind:'SCENES',scenes:[{episode:2,sceneKey:'2-2'}]}};
const assets=projectProductionCatalog(catalog,[2]).assets;
const packet:any={schema:'LIGHT_EPISODE_SUPPLY_V2',documentRevision:'document-9',sourceVersion:sourceIndex.version,sourceContextVersion:sourceContext.version,episode:2,title:episodes[1].title,sourceText:episodes[1].content,...reception,facts,assets,
 scenes:allScenes.filter(s=>s.episode===2).map(s=>({...s,decisions:s.sceneKey==='2-2'?[decision]:[],followUps:[],assetKeys:assets.filter(a=>a.sceneRefs?.some(r=>r.sceneKey===s.sceneKey)).map(a=>a.key)})),materialDependencies:[],gaps:[],warnings:[],boundaryContext:buildLightBoundaryContext(sourceIndex,catalog,allScenes as any,[2]),decisions:[decision],followUps:[]};
const handoff=attachEpisodeMaterials({packet,readiness:'READY',reasons:[]} as any,{status:'CONFIRMED',projection:{brief:'都市轻喜，克制暧昧；用微小行动兑现信任，不改原话和揭示时点。'}} as any,[{assetKey:'lin',status:'TEXT_ADOPTED',adoptionVersion:2,brief:'浅灰外套，利落束发；神情克制，以眼神和手部停顿表现试探。',materialAvailability:'TEXT_ONLY',references:[{id:'reference-lin',description:'文字设计已采用，没有读取图像像素。',available:false}]}] as any);
const prepared=makeEpisodeInput({episode:episodes[1],project,handoff,inputProtocol:'upstream-material-v2'});
const source=prepared.source,rulesSnapshot=captureRules(),settings={fantasyMode:'off',maxUnits:null,visualStyle:prepared.visualStyle};
const split=source.sourceRows.findIndex((r:any)=>r.text.startsWith('2-2'));
const groups=[source.sourceRows.slice(0,split),source.sourceRows.slice(split)].map(rows=>rows.map((r:any)=>r.id));
const emotion=(n:number)=>({subject:'林岚、程野',contextTone:'克制暧昧',audienceEffect:'期待',change:n===1?'还钥匙兑现约定':'邀约被接受',landing:n===1?'钥匙合入掌心':'短答之后停顿',retain:['源台词逐字保留','只声不露脸的陈叔','克制的行动试探']});
const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'约定兑现后再次邀约',entryFacts:[],fantasyCandidates:[],events:groups.map((sourceRefs,n)=>({id:`event-${n+1}`,sourceRefs,sceneKey:`2-${n+1}`,boundaryBefore:{kind:n?'time_space_jump':'episode_start',reason:n?'原文明示走廊换场':'本集开始'},emotionContract:emotion(n+1)})),workPackages:groups.map((sourceRefs,n)=>({id:`p${n+1}`,eventId:`event-${n+1}`,sourceRefs,emotionContract:emotion(n+1),entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]})),provisionalUnits:groups.map((sourceRefs,n)=>({id:`u${n+1}`,packageId:`p${n+1}`,sourceRefs,secondsRange:[3,8]}))};
const inputOf=(r:any)=>JSON.parse(r.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n\n')[0]);
const factRecords=(value:any)=>Array.isArray(value?.rows)&&Array.isArray(value.columns)?value.rows.map((row:any[])=>Object.fromEntries(value.columns.flatMap((column:string,i:number)=>column==='extra?'?Object.entries(row[i]||{}):row[i]===undefined||column==='statement?'&&row[i]===null?[]:[[column.replace(/\?$/,''),row[i]]]))):['current','background','backgroundCandidates','historicalStates','unlinkedBackground','sourceFactIndex'].flatMap(key=>value?.[key]||[]);
const originals=structuredClone({source,plan});
const metrics=[];
for(const stage of ['plan','author','finish','delta']){
 const payload={stage:stage==='delta'?'finish':stage,source,settings,rulesSnapshot,plan,packageIds:stage==='author'?['p2']:['p1','p2'],finishMode:stage==='delta'?'delta':'full',...(stage==='finish'||stage==='delta'?{previousDraft:{schemaVersion:VERSION,units:[{id:'p1-u1',shots:[]},{id:'p2-u1',shots:[]}],fantasyRealization:[]}}:{})};
 const request=buildRequest(payload),legacy=buildRequest({...payload,rulesSnapshot:{...rulesSnapshot,modelProjectionVersion:'retrieval-facts-v1'}}),legacyInput=inputOf(legacy);
 const actual=inputOf(request),ctx=actual.source.context,rf=ctx.retrievalFacts;
 assert.deepEqual(actual.source.dialogue,legacyInput.source.dialogue,`${stage}: complete dialogue, cues and channels`);
 assert.deepEqual(actual.source.entryFacts,legacyInput.source.entryFacts,`${stage}: entry facts`);
 assert.deepEqual(actual.source.assets,legacyInput.source.assets,`${stage}: assets`);
 for(const key of ['scenes','continuity','confirmedDecisions','seriesDirection'])assert.deepEqual(ctx[key],legacyInput.source.context[key],`${stage}: ${key}`);
 assert.deepEqual(ctx.modelDesigns,legacyInput.source.context.modelDesigns.map(({adoptionVersion:_version,...design}:any)=>design),`${stage}: adopted creative materials`);
 for(const key of ['sourceRows','contextRows'])assert.deepEqual(actual.source[key],legacyInput.source[key].filter((row:any)=>row.text.trim()),`${stage}: nonblank source text`);
 if(actual.plan){assert.equal(actual.plan.emotionArc,legacyInput.plan.emotionArc);assert.deepEqual(actual.plan.workPackages.map((p:any)=>p.emotionContract),legacyInput.plan.workPackages.map((p:any)=>p.emotionContract));}
 const dispatchChars=request.prompt.length+request.instructions.length+size(request.schema),legacyDispatchChars=legacy.prompt.length+legacy.instructions.length+size(legacy.schema);
 metrics.push({stage,promptChars:request.prompt.length,instructionsChars:request.instructions.length,schemaChars:size(request.schema),dispatchChars,legacyDispatchChars,savedChars:legacyDispatchChars-dispatchChars,inputChars:size(actual),sourceChars:size(actual.source),sourceRowsChars:size(actual.source.sourceRows),contextRowsChars:size(actual.source.contextRows),dialogueChars:size(actual.source.dialogue),assetsChars:size(actual.source.assets),standardPackageSent:Object.hasOwn(actual.source,'standardPackage')||request.prompt.includes(reception.standardScript!.packageId),contextFields:Object.fromEntries(Object.entries(ctx).map(([k,v])=>[k,size(v)])),factRows:rf.rows?.length,factGroups:rf.groups,sourceRows:actual.source.sourceRows.length,contextRows:actual.source.contextRows.length,statementDuplicatesInContextRows:factRecords(rf).filter((f:any)=>typeof f.statement==='string'&&actual.source.contextRows.some((r:any)=>r.text===f.statement)).length,rules:request.loadedFiles.map((r:any)=>({path:r.path,chars:r.chars})),hash:request.promptHash,legacyHash:legacy.promptHash});
}
assert.deepEqual({source,plan},originals,'model projection does not mutate canonical input');
const files=['runtime/storyboard-v4/input.mjs','runtime/storyboard-v4/core/core.mjs','runtime/storyboard-v4/core/fact-projection.mjs','runtime/storyboard-v4/core/production-context-projection.mjs','lib/standard-script-plan.ts','lib/foundation-facts.ts'];
console.log(JSON.stringify({unit:'UTF16 characters; prompt + instructions + serialized output schema; current real buildRequest; no model call or tokens; synthetic catalog/plan/draft',inputProtocol:'upstream-material-v2',modelProjectionVersion:rulesSnapshot.modelProjectionVersion,retentionChecks:'dialogue/cues/channels, entryFacts, assets, creative context, emotion contracts, nonblank source and canonical immutability passed',files:Object.fromEntries(files.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')])),sourceChars:episodes[1].content.length,standardScriptChars:size(reception.standardScript),canonicalFactsChars:size(facts),metrics},null,2));
