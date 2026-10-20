/** Existing confirmation and handoff, disposable SQLite only; never invoke a provider. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {PrismaClient} from '@prisma/client';
import {prepareEpisodeReception} from '../lib/standard-script-reception';
import {readChoiceChangeTargets,changeTargetsIdentity} from '../lib/foundation-choice-change-targets';
import {readHumanChoices,mergeHumanChoices} from '../lib/foundation-human-choices';
import {assertDecisionChanges} from '../lib/foundation-decision-targets';
import {projectDecisionChanges} from '../lib/foundation-decision-patch';
import {buildLightFoundationPrompt,buildProductionFoundationPrompt} from '../lib/foundation-production-prompts';

const legacy={assetKeys:[],assetFields:[],sceneFields:['weather']};
assert.equal(changeTargetsIdentity(legacy),JSON.stringify(legacy),'old permission identity must be byte-compatible');
const permissions={assetKeys:[],assetFields:[],sceneFields:[],presentationFields:['timeCards']};
let parsedPermissions:unknown;
assert.doesNotThrow(()=>{parsedPermissions=readChoiceChangeTargets(permissions);},'presentation-only consent must not require fake asset or scene permissions');
assert.deepEqual(parsedPermissions,permissions);
for(const bad of [
 {...permissions,presentationFields:[]}, {...permissions,presentationFields:['sourceText']},
 {...permissions,sceneFields:['weather']}, {...permissions,assetKeys:['asset'],assetFields:['name']},
 {...permissions,removeAssetKeys:['asset']}, {...permissions,presentationFields:null}
])assert.throws(()=>readChoiceChangeTargets(bad),/changeTargets/);
const question={decisionKey:'overlay-text/time-cards',kind:'PRODUCTION_CHOICE',question:'是否在分镜中加入额外时间字卡？',
 reason:'原文的后期叠字只是制作提示，不代表用户选择将它写入生成画面。',options:['不加入额外时间字卡','加入时间字卡，分镜写清位置、占比/字号、样式及入出场'],
 recommended:'不加入额外时间字卡',recommendationReason:'尚未得到叠字许可，保留时间事实而非默认烧录。',evidence:'后期添加字卡“十余年后。”',episodes:[1],applicationScope:{kind:'SCENES',scenes:[{episode:1,sceneKey:'1-1'}]},
 receivingUses:['后续分镜的时间字卡呈现，不修改源文时间事实'],changeTargets:permissions};
const parsed=readHumanChoices([question],[1])[0];
assert.deepEqual(parsed.changeTargets,permissions);
assert.equal(mergeHumanChoices([[parsed,parsed]]).length,1);
const identity=readHumanChoices([{...question,decisionKey:'overlay-text/identity-captions',changeTargets:{...permissions,presentationFields:['identityCaptions']}}],[1])[0];
assert.equal(mergeHumanChoices([[parsed,identity]]).length,2,'time card consent does not authorize names/ranks');
const choice={...parsed,id:'choice',category:'PRODUCTION_CHOICE',sourceStages:['Q1'],userAnswer:question.options[0],revision:'r1',round:1,decidedAt:new Date()} as any;
const before={f2:{assets:[{key:'asset',name:'甲',type:'CH',usageEpisodes:[1],aliases:[],variants:[],sceneRefs:[{episode:1,sceneKey:'1-1'}]}]}} as any;
const output={format:'FOUNDATION_OPTIMIZATION_V2',coverage:[1],changes:{},appliedDecisions:[{id:'choice',note:'作为后续呈现约束传递；不改原文或资产。'}]} as any;
assert.doesNotThrow(()=>assertDecisionChanges([choice],[1],output,before,structuredClone(before)));
const changed=structuredClone(before);changed.f2.assets[0].name='无授权新名';
assert.throws(()=>assertDecisionChanges([choice],[1],output,before,changed),/越出授权/);
assert.throws(()=>assertDecisionChanges([choice],[1],{...output,changes:{scenes:[{episode:1,sceneKey:'1-1',weather:'雨'}]}},before,before),/越出授权/);
assert.throws(()=>projectDecisionChanges({choices:[choice],scope:[1],output:{...output,changes:{overview:'无授权改概述'}},before,after:before,validateAndApply:()=>{throw Error('must reject before applying');}}),/不授权/);
for(const stage of ['F2','Q1'] as const){
 const prompt=buildLightFoundationPrompt(stage,{scope:[1]});
 for(const concept of ['额外时间字卡','人物姓名','等级','presentationFields','墙上','系统面板','原文写了不等于用户已同意'])assert.ok(prompt.includes(concept),`${stage}: ${concept}`);
}
assert.ok(buildProductionFoundationPrompt('Q1',{}).includes('presentationFields'),'legacy entry must receive the same confirmation boundary');
const require=createRequire(import.meta.url);
const {buildRequest,captureRules}=require('../runtime/storyboard-v4/core/core.mjs');
const {makeEpisodeInput}=require('../runtime/storyboard-v4/input.mjs');
const {PLAN_VERSION,VERSION}=require('../runtime/storyboard-v4/core/shared.mjs');
const content='第1集\n1-1 日 内 房间\n字幕：十余年后。\n△甲走进房间，墙上写着“禁入”。\n';
const episode={id:'ep',projectId:'project',number:1,content};
const reception=prepareEpisodeReception(episode,null);
for(const answer of [undefined,...question.options]){
 const decisions=answer===undefined?[]:[{...choice,userAnswer:answer}];
 const source=makeEpisodeInput({episode,project:{id:'project'},handoff:{packet:{sourceText:content,...reception,decisions}}}).source;
 assert.equal(source.onscreenTexts[0].text,'十余年后。','a rendering answer cannot erase source evidence');
 assert.deepEqual(source.context.confirmedDecisions,decisions);
 const sourceRefs=source.sourceRows.map((row:{id:string})=>row.id);
 const emotionContract={subject:'甲',contextTone:'平静',audienceEffect:'读清时间变化',change:'进入',landing:'走入房间',retain:['源时间跨度与墙字']};
 const plan={schemaVersion:PLAN_VERSION,unitPackingPolicy:'event-first-v1',emotionArc:'平静进入',entryFacts:[],events:[{id:'e1',sceneKey:'房间',sourceRefs,boundaryBefore:{kind:'episode_start',reason:'源开始'},emotionContract}],workPackages:[{id:'p1',eventId:'e1',sourceRefs,emotionContract,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'u1',packageId:'p1',sourceRefs,secondsRange:[2,6]}],fantasyCandidates:[]};
 for(const stage of ['plan','author','finish','delta']){
  const payload={stage:stage==='delta'?'finish':stage,source,plan,packageId:'p1',settings:{fantasyMode:'off',maxUnits:null},...(stage==='finish'?{previousDraft:{rawText:'离线待修响应'}}:{}),...(stage==='delta'?{finishMode:'delta',previousDraft:{schemaVersion:VERSION,units:[{id:'p1-u1',shots:[]}],fantasyRealization:[]}}:{})};
  const request=buildRequest(payload);
  assert.equal(request.prompt.includes('各项按源位置上屏一次'),false,`${stage}: source onscreen evidence must not override include/omit consent`);
  assert.ok(request.prompt.includes('不是一律上屏许可'));
  assert.equal(captureRules().screenTextConsentVersion,'screen-text-consent-v1');
  const legacy=captureRules();delete legacy.screenTextConsentVersion;
  const historical=buildRequest({...payload,rulesSnapshot:legacy});
  assert.ok(historical.prompt.includes('各项按源位置上屏一次'),'saved snapshots retain the original contract');
  assert.throws(()=>buildRequest({...payload,rulesSnapshot:{...legacy,screenTextConsentVersion:'future'}}),(e:{code?:string})=>e.code==='RULE_SNAPSHOT');
 }
}

async function main(){
 const dir=mkdtempSync(path.join(tmpdir(),'screen-overlay-consent-')),url=`file:${dir}/test.db`;
 process.env.DATABASE_URL=url;process.env.CODEX_CLI_PATH='/__offline_only__/no-codex';process.env.DEEPSEEK_API_KEY='';
 const sqlite=new DatabaseSync(path.join(dir,'test.db'));
 for(const name of readdirSync('prisma/migrations').sort())if(/^\d/.test(name))sqlite.exec(readFileSync(path.join('prisma/migrations',name,'migration.sql'),'utf8'));sqlite.close();
 const db=new PrismaClient({datasourceUrl:url});
 try{
  const store=await import('../lib/foundation-choice-store');
  const {preprocessProject}=await import('../lib/project-preprocess');
  const {loadFoundationInputs}=await import('../lib/foundation-state');
  const {createEmptyDocument,mergeDocumentF2,saveFoundationDocument}=await import('../lib/foundation-document');
  const {requireProductionCatalogAuthor}=await import('../lib/foundation-production-contracts');
  const {LIGHT_ASSET_METHOD_VERSION}=await import('../lib/foundation-production-prompts');
  const {buildLightEpisodePackets}=await import('../lib/light-foundation-supply');
  const {readLightEpisodeFoundation}=await import('../lib/light-foundation-reader');
  const project=await db.project.create({data:{title:'叠字取舍不是源文改写',episodes:{create:[
   {number:1,content:'第1集\n1-1 日 内 房间\n△后期添加字卡“十余年后。”\n△墙上写着“禁入”。\n'},
   {number:2,content:'第2集\n2-1 日 内 房间\n△系统面板显示“等级：三重”。\n'}
  ]}}});
  await preprocessProject(project.id,db);
  const input=await loadFoundationInputs(project.id,db),empty=createEmptyDocument(input);
  const catalog=requireProductionCatalogAuthor({format:'ASSET_CATALOG_V2',coverage:[1,2],assets:[]},input.sourceIndex,[1,2]);
  let doc=mergeDocumentF2({...empty,workflow:'LIGHT_STAGE1_V1',assetMethodVersion:LIGHT_ASSET_METHOD_VERSION},catalog,input.sourceIndex);doc.editorialCoverage=[1,2];
  await store.syncFoundationChoices(db,project.id,input.sourceVersion,'Q1',[parsed]);
  let choices=await store.loadFoundationChoices(db,project.id,input.sourceVersion);
  assert.equal(choices.pending.length,1);assert.equal(choices.confirmed.length,0,'recommendation is not consent');
  doc.requiredDecisionIds=[choices.pending[0].id];
  doc=await saveFoundationDocument(db,project.id,empty.revision,doc,'offline overlay decision fixture');
  const pending=await readLightEpisodeFoundation(project.id,1,db);
  assert.ok(pending.reasons.some(r=>r.includes(question.question)),'pending scoped decision must block the consumer');
  let packets=await buildLightEpisodePackets(project.id,doc,db,[1,2],input);
  assert.equal(packets[0].decisions.length,0,'unconfirmed cards cannot enter creative input');
  const row=choices.pending[0];
  const originalEpisodes=await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}});
  await assert.rejects(store.confirmFoundationChoice(db,{projectId:project.id,contractId:row.id,revision:'stale',optionIndex:'0'}));
  await store.confirmFoundationChoice(db,{projectId:project.id,contractId:row.id,revision:row.revision,optionIndex:'0'});
  await store.syncFoundationChoices(db,project.id,input.sourceVersion,'Q1',[parsed]);
  choices=await store.loadFoundationChoices(db,project.id,input.sourceVersion);
  assert.equal(choices.pending.length,0);assert.equal(choices.confirmed.length,1);
  assert.deepEqual(choices.confirmed[0].changeTargets,permissions);
  packets=await buildLightEpisodePackets(project.id,doc,db,[1,2],input);
  assert.equal(packets[0].decisions[0].userAnswer,question.options[0]);
  assert.deepEqual(packets[0].decisions[0].changeTargets,permissions);
  assert.equal(packets[1].decisions.length,0,'limited consent cannot spread to another episode/system panel');
  assert.deepEqual(packets[0].scenes[0].decisions[0].changeTargets,permissions);
  assert.equal((await db.presentationContract.findMany({where:{projectId:project.id}})).length,1);
  assert.deepEqual(await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}}),originalEpisodes,'original wall/panel/time facts are immutable');
  assert.equal(await db.pipelineRun.count(),0,'no provider or fake zero receipt');
  // Both answers must survive the real WAITING_USER -> APPLY_DECISION -> ready
  // controller path. Injected responses are fixtures, never a model dispatch.
  const api=await import('../lib/foundation-delivery');
  const response=(data:Record<string,unknown>)=>({data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null});
  for(const optionIndex of ['0','1']){
   const source=originalEpisodes[0].content;
   const fixture=await db.project.create({data:{title:`overlay controller ${optionIndex}`,episodes:{create:{number:1,content:source}}}});
   await db.sceneSnapshot.create({data:{projectId:fixture.id,sceneKey:'SOURCE_IMPORT',metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'}),content:JSON.stringify({sourceText:source,sourceStructure:{version:'SOURCE_STRUCTURE_V1',issues:[],sections:[{key:'ep-1',kind:'EPISODE',episodeNumber:1,start:0,end:source.length}]}})}});
   let calls=0;
   const task=await api.queueFoundationDelivery(fixture.id,{},db);
   await api.executeFoundationDelivery(fixture.id,task.id,{db,stageRunner:async(stage,prompt)=>{
    calls++;const request=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
    return response(stage==='F2'?{format:'ASSET_CATALOG_V2',coverage:request.scope,assets:[]}:
     {format:'FOUNDATION_OPTIMIZATION_V2',coverage:request.scope,changes:{},humanChoices:[question]});
   }});
   const waiting=await api.getFoundationDeliveryState(fixture.id,db);
   assert.equal(waiting.task?.status,'WAITING_USER',waiting.task?.error??'must wait for overlay consent');
   assert.equal(waiting.complete,false);assert.equal(waiting.requiredChoices.length,1);
   const required=waiting.requiredChoices[0],beforeCalls=calls;
   const continuation=await api.confirmAndContinueFoundationDelivery(db,{projectId:fixture.id,contractId:required.id,revision:required.revision,optionIndex});
   assert.ok(continuation);assert.equal(calls,beforeCalls,'answering a card itself cannot dispatch a model');
   await api.executeFoundationDelivery(fixture.id,continuation.id,{db,stageRunner:async(_stage,prompt)=>{
    calls++;const request=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
    assert.equal(request.delivery.mode,'APPLY_DECISION');
    assert.deepEqual(request.confirmedDecisions[0].changeTargets,permissions);
    assert.equal(request.confirmedDecisions[0].userAnswer,question.options[Number(optionIndex)]);
    return response({format:'FOUNDATION_OPTIMIZATION_V2',coverage:request.scope,changes:{},appliedDecisions:[{id:required.id,note:'已按确认答案向后续分镜交接呈现约束，源文与目录无需改动。'}]});
   }});
   const done=await api.getFoundationDeliveryState(fixture.id,db);
   assert.equal(done.complete,true,done.task?.error??'presentation-only no-op must close the apply gate');
   assert.equal(calls,beforeCalls+1,'one injected apply response closes the decision without repair retries');
   const confirmed=done.confirmedChoices.find(item=>item.id===required.id)!;
   assert.equal(done.document.appliedDecisions[required.id],confirmed.revision,'receipt binds the answered row, not its older pending revision');
   assert.deepEqual(done.document.f2,waiting.document.f2,'presentation answers cannot mutate the asset catalogue');
   assert.equal((await db.episode.findFirstOrThrow({where:{projectId:fixture.id}})).content,source);
   const ready=await readLightEpisodeFoundation(fixture.id,1,db);assert.equal(ready.readiness,'READY',ready.reasons.join(';'));
   const handed=await buildLightEpisodePackets(fixture.id,done.document,db,[1]);
   assert.equal(handed[0].decisions[0].userAnswer,question.options[Number(optionIndex)]);
  }
  console.log('PASS overlay consent: presentation-only permissions; real required-card/confirmation/apply/ready/scoped handoff for include and omit; no asset/scene/source authority; offline injected responses, 0 provider calls');
 }finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
