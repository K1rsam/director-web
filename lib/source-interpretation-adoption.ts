import type {Prisma,PrismaClient} from '@prisma/client';
import {prisma} from './prisma';
import {createEmptyDocument,loadFoundationDocument,migrateFoundationDocument,saveFoundationDocument} from './foundation-document';
import {loadFoundationInputs} from './foundation-state';
import {getFoundationDeliveryState,synchronizeFreeSourceInterpretationTask} from './foundation-delivery';
import {assertNoActiveFoundationDelivery} from './foundation-choice-store';
import {registerFoundationDocumentAssetsInTransaction} from './foundation-delivery-assets';
import {requireProductionCatalog} from './foundation-production-contracts';
import {prepareScriptResolutionChange,persistScriptResolutionChange,readScriptReception} from './script-resolution-service';
import {readResolutionChoice,resolutionError,type ScriptResolutionChoice} from './script-resolution-plan';
import {sourceInterpretationDigest as hash,sourceInterpretationConditions,effectiveEditorialCoverage,type SourceInterpretationAdoption} from './source-interpretation-adoption-proof';
import type {SourceRegroupApproval} from '../runtime/source-regroup.mjs';
export {effectiveEditorialCoverage} from './source-interpretation-adoption-proof';

type Change={episode:number;sourceVersion:string;expectedRevision:number;choice?:ScriptResolutionChoice;decisionId?:string};
export type SourceInterpretationRequest={expectedDocumentRevision:string;explanation:string;changes:Change[]};
type Options={db?:PrismaClient;approval?:{origin:'AUTHORIZED_MAINTENANCE';ref:string}};
type Db=Prisma.TransactionClient;
const object=(value:unknown,keys:string[])=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))resolutionError('SOURCE_ADOPTION_FIELDS','请求不能带客户身份、批准状态、来源全文或未知字段。',400);
 return value as Record<string,any>;
};
function requestOf(raw:unknown,adopt=false):SourceInterpretationRequest&{previewDigest?:string}{
 const value=object(raw,['expectedDocumentRevision','explanation','changes',...(adopt?['previewDigest']:[])]);
 if(typeof value.expectedDocumentRevision!=='string'||!value.expectedDocumentRevision||typeof value.explanation!=='string'||!value.explanation.trim()||value.explanation.length>2000||!Array.isArray(value.changes)||!value.changes.length||value.changes.length>20)resolutionError('SOURCE_ADOPTION_APPROVAL','请明确说明本次解释，并绑定当前工作稿与所选集。',400);
 const changes:Change[]=value.changes.map(raw=>{
  const item=object(raw,['episode','sourceVersion','expectedRevision','choice','decisionId']);
  if(!Number.isSafeInteger(item.episode)||item.episode<0||typeof item.sourceVersion!=='string'||!item.sourceVersion||!Number.isSafeInteger(item.expectedRevision)||item.expectedRevision<0||Boolean(item.choice)===Boolean(item.decisionId))resolutionError('SOURCE_ADOPTION_CHANGE','来源解释须绑定当前集、原文版本和核对版本。',400);
  if(item.decisionId!==undefined&&(typeof item.decisionId!=='string'||!item.decisionId))resolutionError('SOURCE_ADOPTION_CHANGE','请选择当前要撤销的核对项。',400);
  return {episode:item.episode,sourceVersion:item.sourceVersion,expectedRevision:item.expectedRevision,...(item.choice?{choice:readResolutionChoice(item.choice)}:{decisionId:item.decisionId})};
 });
 if(new Set(changes.map(change=>change.episode)).size!==changes.length)resolutionError('SOURCE_ADOPTION_CHANGE','一个批次的每集只能有一项明确变更。',400);
 if(adopt&&(typeof value.previewDigest!=='string'||!value.previewDigest))resolutionError('SOURCE_ADOPTION_PREVIEW','请先免费预览当前原文、对白、动作和已付目录保留范围。');
 return {expectedDocumentRevision:value.expectedDocumentRevision,explanation:value.explanation.trim(),changes,...(adopt?{previewDigest:value.previewDigest}:{})};
}
async function idle(projectId:string,db:Db,input:Awaited<ReturnType<typeof loadFoundationInputs>>,loaded:Awaited<ReturnType<typeof loadFoundationDocument>>){
 await assertNoActiveFoundationDelivery(db,projectId);
 if(await db.pipelineRun.findFirst({where:{projectId,status:{in:['QUEUED','RUNNING']}},select:{id:true}}))resolutionError('SOURCE_ADOPTION_BUSY','项目仍有运行中或在途请求，未改变解释。');
 const state=await getFoundationDeliveryState(projectId,db,{input,loaded});
 if(state.busy||state.action==='UNKNOWN_CONFIRM'||state.task?.unknownOutcome||state.task?.status==='STOPPED')resolutionError('SOURCE_ADOPTION_IDLE','任务运行中、结果未知或被手动停止，未改变解释或预算。');
 return state;
}
async function draft(projectId:string,actorId:string,request:SourceInterpretationRequest,db:Db,options:Options,approvedAt=new Date().toISOString()){
 if(typeof actorId!=='string'||!actorId||!await db.projectRole.count({where:{projectId,userId:actorId,role:{in:['ADMIN','REVIEWER']}}}))resolutionError('ROLE','需要本项目管理员或审阅者确认权限。',403);
 const input=await loadFoundationInputs(projectId,db),loaded=await loadFoundationDocument(db,projectId,input),before=loaded.document;
 if(before.revision!==request.expectedDocumentRevision||loaded.sourceChanged)resolutionError('CONFLICT','工作稿 revision、来源或解释已改变，请重新核对当前修订。');
 if(before.workflow!=='LIGHT_STAGE1_V1'||!before.f2||loaded.needsContextEdit||!input.sourceContext.complete)resolutionError('SOURCE_ADOPTION_BASIS','需要当前有效的第一阶段目录与制作条件；不能靠来源解释代替其它待核对工作。');
 const state=await idle(projectId,db,input,loaded),approval:SourceRegroupApproval={origin:options.approval?.origin??'SESSION',ref:options.approval?.ref??`script-reception:${hash([projectId,actorId,request]).slice(0,48)}`,explanation:request.explanation,actorId,approvedAt};
 if(!approval.ref.trim())resolutionError('SOURCE_ADOPTION_APPROVAL','授权维护必须保留可对账的批准来源。');
 const changes=[];
 for(const change of request.changes)changes.push(await prepareScriptResolutionChange(projectId,actorId,change,change.choice?'CONFIRM':'REVOKE',change.choice??null,change.decisionId,db,approval));
 const versions={...input.scriptInterpretationVersions},resolutions={...input.scriptResolutions};
 for(const change of changes){
  if(change.interpretationHash){versions[change.episode.number]=change.interpretationHash;resolutions[change.episode.number]=change.prepared;}
  else{delete versions[change.episode.number];delete resolutions[change.episode.number];}
  if(change.revision.action==='CONFIRM'&&(!change.prepared.compiled||change.prepared.diagnostics.length))resolutionError('SOURCE_ADOPTION_RECEPTION','本批解释仍有未决原文，未把未通过的片段记为免费复核完成。');
 }
 const nextInput={...input,scriptInterpretationVersions:versions,scriptResolutions:resolutions},migrated=migrateFoundationDocument(before,nextInput),document={...structuredClone(before),revision:migrated.revision,sourceHashes:createEmptyDocument(nextInput).sourceHashes,editorialCoverage:[...migrated.editorialCoverage]};
 requireProductionCatalog(document.f2!,nextInput.sourceIndex,document.f2!.coverage);
 const catalogDigest=hash(before.f2),originsDigest=hash(before.origins),conditionsFingerprint=sourceInterpretationConditions(input),beforeDigest=hash(before);
 document.sourceInterpretationConditionsFingerprint=conditionsFingerprint;
 const reviewed=effectiveEditorialCoverage(before,input),confirmed=changes.filter(change=>change.revision.action==='CONFIRM');
 for(const change of confirmed)if(!reviewed.includes(change.episode.number)||!['F2','Q1'].every(stage=>before.origins.some(origin=>origin.stage===stage&&origin.runId&&origin.scope.includes(change.episode.number))))resolutionError('SOURCE_ADOPTION_PAID_ORIGIN','免费复核仅保留本集已有且可对账的F2/Q1目录成果，不新造模型编辑来源。');
 const oldInterpretationHashes=Object.fromEntries(changes.map(change=>[change.episode.number,input.scriptInterpretationVersions?.[change.episode.number]??null])),newInterpretationHashes=Object.fromEntries(changes.map(change=>[change.episode.number,change.interpretationHash]));
 if(changes.every(change=>oldInterpretationHashes[change.episode.number]===change.interpretationHash))resolutionError('SOURCE_ADOPTION_UNCHANGED','解析含义没有变化，不重复登记免费复核。');
 if(confirmed.length){
  const episodes=confirmed.map(change=>change.episode.number).sort((a,b)=>a-b),body:Omit<SourceInterpretationAdoption,'proofDigest'>={schema:'SOURCE_INTERPRETATION_ADOPTION_V1',version:'source-interpretation-adoption-v1',id:`source-adoption-${hash([projectId,before.revision,request,approval.origin,approval.ref]).slice(0,40)}`,status:'ACTIVE',episodes,sourceVersion:input.sourceVersion,
   sourceVersions:Object.fromEntries(confirmed.map(change=>[change.episode.number,change.revision.sourceVersion])),sourceHashes:Object.fromEntries(episodes.map(number=>[number,document.sourceHashes[number]])),oldInterpretationHashes,newInterpretationHashes,beforeDocument:{revision:before.revision,digest:beforeDigest,catalogDigest},catalogDigest,settingsFingerprint:before.settingsFingerprint,conditionsFingerprint,originsDigest,originalOrigins:structuredClone(before.origins),approval};
  document.sourceInterpretationAdoptions=[...(document.sourceInterpretationAdoptions??[]),{...body,proofDigest:hash(body)}];
 }
 for(const change of changes.filter(change=>change.revision.action==='REVOKE'))for(const adoption of document.sourceInterpretationAdoptions??[])if(adoption.status==='ACTIVE'&&adoption.episodes.includes(change.episode.number)){
  adoption.status='REVOKED';adoption.revokedAt=approvedAt;adoption.revokedBy=actorId;const {proofDigest:_old,...body}=adoption;adoption.proofDigest=hash(body);
 }
 const assets=await db.asset.findMany({where:{projectId}}),keys=before.f2.assets.flatMap(asset=>[asset.key,...asset.variants.map(variant=>variant.key)]);
 // The original registrar retains adopted metadata. This path may only rebind existing identities.
 for(const key of keys)if(assets.filter(asset=>{try{const meta=JSON.parse(asset.metadata??'{}');return meta.foundationKey===key||meta.foundationVariantKey===key;}catch{return false;}}).length!==1)resolutionError('SOURCE_ADOPTION_REGISTRY','已有目录身份尚未完整登记；本操作不新建或猜配身份。');
 const previewDigest=hash({projectId,actorId,request,approval:{origin:approval.origin,ref:approval.ref,explanation:approval.explanation},beforeDigest,catalogDigest,inputVersion:input.inputVersion,task:state.task,registry:assets,oldInterpretationHashes,newInterpretationHashes,pointers:changes.map(change=>change.state.row?.content??null)});
 const preview={previewDigest,cost:'FREE' as const,providerCalls:0,approval:{origin:approval.origin,ref:approval.ref,explanation:approval.explanation,actorId},
  before:{documentRevision:before.revision,documentDigest:beforeDigest,catalogDigest,catalogCoverage:[...before.f2.coverage],editorialCoverage:[...before.editorialCoverage],effectiveEditorialCoverage:reviewed},
  after:{catalogCoverage:[...document.f2!.coverage],editorialCoverage:[...document.editorialCoverage],effectiveEditorialCoverage:effectiveEditorialCoverage(document,nextInput),reviewedEpisodes:confirmed.map(change=>change.episode.number)},
  episodes:changes.map(change=>({episode:change.episode.number,action:change.revision.action,sourceVersion:change.revision.sourceVersion,oldInterpretationHash:oldInterpretationHashes[change.episode.number],newInterpretationHash:change.interpretationHash,sourceText:change.episode.content,beforeReadingText:input.scriptResolutions?.[change.episode.number]?.compiled?.readingText??null,afterReadingText:change.prepared.compiled?.readingText??null,diagnostics:change.prepared.diagnostics,
   children:change.prepared.compiled?.package.script.entries.flatMap<{kind:string;text:string;speaker?:{text:string};channel?:string}>(entry=>entry.kind==='SOURCE_REGROUP'?entry.children??[]:entry.kind==='DIALOGUE'?[{kind:'DIALOGUE',text:entry.text,speaker:entry.speaker,channel:entry.channel}]:[])??[]}))};
 return {input,nextInput,before,document,migrated,changes,approval,preview};
}
export async function previewSourceInterpretationAdoption(projectId:string,actorId:string,value:unknown,options:Options={}){
 const request=requestOf(value);return (await draft(projectId,actorId,request,options.db??prisma,options)).preview;
}
/** One outer transaction owns source pointers, the full document, and same-key registry revision binding. */
export async function adoptSourceInterpretationAdoption(projectId:string,actorId:string,value:unknown,options:Options={}){
 const checked=requestOf(value,true),{previewDigest,...request}=checked,db=options.db??prisma,prepared=await draft(projectId,actorId,request,db,options);
 if(previewDigest!==prepared.preview.previewDigest)resolutionError('SOURCE_ADOPTION_PREVIEW','预览已变化或不属于当前身份，请重新免费预览后明确采用。');
 const saved=await saveFoundationDocument(db,projectId,prepared.migrated.revision,prepared.document,'明确批准来源解释；保留已付目录与旧Q1记录，另记免费复核证据，不调用模型',async tx=>{
  const current=await draft(projectId,actorId,request,tx,options,prepared.approval.approvedAt);
  if(current.preview.previewDigest!==previewDigest)resolutionError('SOURCE_ADOPTION_CAS','保存前来源、工作稿、目录、解释、身份或任务状态已变化，整批未写入。');
  for(const change of current.changes)await persistScriptResolutionChange(tx,change);
 },async(tx,document)=>{await registerFoundationDocumentAssetsInTransaction(tx,projectId,document,[]);await synchronizeFreeSourceInterpretationTask(tx,projectId,document);});
 return {document:saved,preview:prepared.preview,reception:await readScriptReception(projectId,actorId,request.changes.at(-1)!.episode,{db})};
}
