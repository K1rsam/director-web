import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { CONTRACT_VERSION } from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import { readFidelityReceipt } from './fidelity-store';
import { prepareFidelityReading, type FidelityDecision } from './fidelity-import';
import type { ImportedScript } from './import-script';
import { assertNoActiveFoundationDelivery } from './foundation-choice-store';
import { preprocessProject } from './project-preprocess';
import type { P1ReviewState } from './fidelity-p1-review';
import {parseSceneBatch} from './source-parser';
import {readSceneParserVersions} from './scene-parser-version';
import {isDeepStrictEqual} from 'node:util';
const hash = (text:string) => createHash('sha256').update(text).digest('hex');
/** Rebuild only the derived reading structure; source bytes and accepted decisions stay pinned. */
export async function refreshFidelitySource(projectId:string, db:PrismaClient, options:{expectedReceiptId?:string;expectedSourceId?:string;checkAfterCommit?:(tx:Prisma.TransactionClient)=>Promise<void>;checkCurrent?:(tx:Prisma.TransactionClient)=>Promise<void>;decisions?:FidelityDecision[];p1Review?:P1ReviewState}={}) {
 const current=await readFidelityReceipt(projectId,db);
 if(!current){if(options.expectedReceiptId||options.expectedSourceId)throw new Error('来源凭据已变化，未保存旧判断。');return {changed:false};}
 if(options.expectedReceiptId&&current.snapshot.id!==options.expectedReceiptId||options.expectedSourceId&&current.sourceSnapshot?.id!==options.expectedSourceId)throw new Error('来源或决定已变化，未保存旧判断。');
 if(!current.sourceSnapshot || current.receipt.sourceImportId && current.receipt.sourceImportId!==current.sourceSnapshot.id)throw new Error('保真来源与凭据版本不一致，未覆盖原文。');
 // Finish a checkpointed review against its pinned input before upgrading the
 // parser. Rebuilding here would change pending paid-response fingerprints.
 if(!options.decisions&&!options.p1Review&&current.receipt.p1Review?.status==='PENDING'&&current.receipt.p1Review.completedRanges?.length)return {changed:false};
 const retryLeadingBoundary=current.receipt.result.validation.issues.some(issue=>issue.code==='BOUNDARY_UNCONFIRMED'&&issue.start===0);
 if(current.receipt.result.contractVersion===CONTRACT_VERSION&&!options.decisions&&!options.p1Review&&!retryLeadingBoundary)return {changed:false};
 const original=JSON.parse(current.sourceSnapshot.content) as ImportedScript;
 if(original.sourceText!==current.receipt.result.source.text||hash(original.sourceText)!==current.receipt.readingHash)throw new Error('保真来源校验失败，未覆盖原文。');
 const decisions=options.decisions??current.receipt.decisions;
 const prepared=prepareFidelityReading({...original,readingView:current.receipt.reader},current.receipt.mode,decisions,current.receipt.originalHash);
 if(!prepared.receipt.result.validation.ok||prepared.receipt.result.source.text!==original.sourceText||prepared.receipt.result.segments.map(segment=>segment.text).join('')!==original.sourceText)throw new Error('新来源结构未能逐字覆盖完整原文，未更新派生集。');
 if(!options.decisions&&!options.p1Review&&JSON.stringify(prepared.receipt.result)===JSON.stringify(current.receipt.result))return {changed:false};
 prepared.receipt={...current.receipt,...prepared.receipt,...(options.p1Review?{p1Review:options.p1Review}:{})};
 prepared.receipt.guarantee=current.receipt.guarantee;prepared.receipt.externalPackage=current.receipt.externalPackage;
 if(isDeepStrictEqual(prepared.receipt.result,current.receipt.result)&&isDeepStrictEqual(prepared.receipt.decisions,current.receipt.decisions)&&isDeepStrictEqual(prepared.receipt.p1Review,current.receipt.p1Review)&&isDeepStrictEqual(prepared.imported.episodes,original.episodes))return {changed:false};
 const pinned=(latest:Awaited<ReturnType<typeof readFidelityReceipt>>)=>latest?.snapshot.id===current.snapshot.id&&latest.sourceSnapshot?.id===current.sourceSnapshot!.id&&latest.receipt.readingHash===current.receipt.readingHash&&latest.receipt.result.plan.decisionVersion===current.receipt.result.plan.decisionVersion;
 const committed=await db.$transaction(async tx=>{
  if(options.checkCurrent)await options.checkCurrent(tx);else await assertNoActiveFoundationDelivery(tx,projectId);
  if(!pinned(await readFidelityReceipt(projectId,tx)))throw new Error('来源或决定已变化，未保存过期解析。');
  const existing=await tx.episode.findMany({where:{projectId},include:{_count:{select:{taskPackages:true,reviewRounds:true,finalScripts:true,storyboardShots:true,seedanceUnits:true,pipelineRuns:true,workflowIssues:true}}}});
  const used=new Set<string>();
  const assignments=prepared.imported.episodes.map(episode=>{
   const exact=existing.filter(old=>!used.has(old.id)&&old.content===episode.content);
   const old=exact.find(old=>old.number===episode.number)??(exact.length===1?exact[0]:undefined)??existing.find(old=>!used.has(old.id)&&old.number===episode.number);
   if(old)used.add(old.id);return {episode,old};
  });
  const retired=existing.filter(old=>!used.has(old.id));
  const affected=assignments.filter(({episode,old})=>old&&(episode.number!==old.number||episode.content!==old.content||(episode.title??null)!==old.title));
  const touched=[...affected.map(item=>item.old!),...retired];
  if(touched.length){
   const ids=touched.map(old=>old.id);
   // Current Episode rows must still be exact projections of the pinned old
   // source snapshot. A manual title/content edit is not disposable parser data.
   if(touched.some(old=>!original.episodes.some(episode=>episode.number===old.number&&episode.content===old.content&&(episode.title??null)===old.title)))throw new Error('已有集与旧来源派生内容不一致，可能含人工修改；未自动重建或归档。');
   const scenes=await tx.scriptScene.findMany({where:{episodeId:{in:ids}}});
   const versions=await readSceneParserVersions(projectId,tx,existing);
   const parsed=new Map(parseSceneBatch(touched,[],{versions}).map(row=>[row.episodeNumber,row.scenes]));
   const manualScene=scenes.some(scene=>{try{
    const meta=JSON.parse(scene.metadata),old=touched.find(episode=>episode.id===scene.episodeId)!;
    const expected=parsed.get(old.number)?.find(row=>row.sceneKey===scene.sceneKey);
    if(!expected||scene.revision!=='V1'||meta.sourceHash!==hash(scene.sourceText)||Object.keys(meta).some(key=>!['characters','props','sourceHash','sourceSceneKey','sceneKeyAmbiguous'].includes(key)))return true;
    if(!isDeepStrictEqual(meta,{...expected.metadata,sourceHash:hash(expected.sourceText)}))return true;
    return (['sceneKey','sortOrder','heading','location','interiorExterior','timeOfDay','weather','timeLayer','sourceText'] as const).some(field=>scene[field]!==expected[field]);
   }catch{return true;}});
   const snapshots=await tx.sceneSnapshot.findMany({where:{projectId}});
   const derivedHistory=(snapshot:typeof snapshots[number])=>{
    if(!snapshot.sceneKey?.startsWith('RETIRED_P0_SCENE-'))return false;
    try{const meta=JSON.parse(snapshot.metadata??'{}'),detail=meta.metadata;
     return meta.schema==='RETIRED_P0_SCENE_V1'&&detail&&typeof detail==='object'&&!Array.isArray(detail)&&Object.keys(detail).every(key=>['characters','props','sourceHash','sourceSceneKey','sceneKeyAmbiguous'].includes(key))
      &&(!detail.sourceHash||detail.sourceHash===hash(snapshot.content))&&snapshot.content.length>0&&original.sourceText.includes(snapshot.content);
    }catch{return false;}
   };
   const allowed=(key:string)=>['SOURCE_IMPORT','FIDELITY_IMPORT','FOUNDATION_SOURCE','FOUNDATION_DELIVERY_TASK','SOURCE_STRUCTURE_RESOLUTION'].includes(key)||key.startsWith('RETIRED_P0_SCENE-')||key.startsWith('RETIRED_FIDELITY_EPISODE-');
   const dependent=await Promise.all([
    tx.asset.count({where:{projectId}}),tx.pipelineRun.count({where:{projectId,...(options.checkCurrent?{stageCode:{not:'F1'}}:{})}}),
    tx.taskPackage.count({where:{projectId,OR:[{episodeId:null},{episodeId:{in:ids}}]}}),tx.reviewRound.count({where:{projectId,OR:[{episodeId:null},{episodeId:{in:ids}}]}}),tx.finalScript.count({where:{projectId,OR:[{episodeId:null},{episodeId:{in:ids}}]}}),
    tx.presentationContract.count({where:{projectId,OR:[{episodeId:null},{episodeId:{in:ids}}]}}),tx.cliRoleSession.count({where:{projectId,episodeId:{in:ids}}}),tx.apiRoleSession.count({where:{projectId,episodeId:{in:ids}}}),
   ]);
   if(manualScene||snapshots.some(s=>!allowed(s.sceneKey??'')||s.episodeId!==null&&ids.includes(s.episodeId)&&!derivedHistory(s))||dependent.some(count=>count>0)||touched.some(old=>Object.values(old._count).some(n=>n>0)))throw new Error('已有资产、模型运行或人工制作资料，本次来源结构变更需要系统进行版本迁移；原文与历史保留，未覆盖已有制作内容。');
   for(const old of touched){
    const {_count,...episode}=old;
    await tx.sceneSnapshot.create({data:{projectId,sceneKey:`RETIRED_FIDELITY_EPISODE-${old.id}`,title:`第${old.number}集旧来源派生结构归档`,content:JSON.stringify({schema:'RETIRED_FIDELITY_EPISODE_V1',action:used.has(old.id)?'REBUILT':'RETIRED',episode,scenes:scenes.filter(scene=>scene.episodeId===old.id),derivedHistory:snapshots.filter(snapshot=>snapshot.episodeId===old.id&&derivedHistory(snapshot)),sourceId:current.sourceSnapshot!.id,receiptId:current.snapshot.id,readingHash:current.receipt.readingHash}),metadata:JSON.stringify({schema:'RETIRED_FIDELITY_EPISODE_V1',sourceVersion:current.receipt.readingHash})}});
   }
   // Preserve retired P0 history content/metadata/id. Only release its old FK,
   // whose exact association is retained in the immutable episode archive above.
   for(const snapshot of snapshots.filter(row=>row.episodeId&&retired.some(episode=>episode.id===row.episodeId)&&derivedHistory(row))){
    const updated=await tx.sceneSnapshot.updateMany({where:{id:snapshot.id,episodeId:snapshot.episodeId,content:snapshot.content,metadata:snapshot.metadata},data:{episodeId:null}});
    if(updated.count!==1)throw new Error('派生历史已变化，未解除旧集关联。');
   }
  }
  // Exact content matching preserves episode ids when an old parser shifted numbering.
  let temporary=Math.min(0,...existing.map(e=>e.number))-assignments.length-1;
  for(const {old,episode} of assignments)if(old&&old.number!==episode.number)await tx.episode.update({where:{id:old.id},data:{number:temporary--}});
  if(retired.length)await tx.episode.deleteMany({where:{projectId,id:{in:retired.map(old=>old.id)}}});
  for(const {old,episode} of assignments)if(old)await tx.episode.update({where:{id:old.id},data:episode});else await tx.episode.create({data:{projectId,...episode}});
  const source=await tx.sceneSnapshot.create({data:{projectId,sceneKey:'SOURCE_IMPORT',title:'保真来源结构更新',content:JSON.stringify(prepared.imported),metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2',originalFileStoredForRecovery:Boolean(prepared.imported.originalFile)})}});
  prepared.receipt.sourceImportId=source.id;
  const receipt=await tx.sceneSnapshot.create({data:{projectId,sceneKey:'FIDELITY_IMPORT',title:'保真来源结构更新',content:JSON.stringify(prepared.receipt),metadata:JSON.stringify({schema:'FIDELITY_RECEIPT_V1',sourceVersion:prepared.receipt.readingHash})}});
  return {changed:true,sourceId:source.id,receiptId:receipt.id};
 },{timeout:20000});
 await preprocessProject(projectId,db,{checkCurrent:async tx=>{if(options.checkAfterCommit)await options.checkAfterCommit(tx);const latest=await readFidelityReceipt(projectId,tx);if(latest?.snapshot.id!==committed.receiptId||latest.sourceSnapshot?.id!==committed.sourceId)throw new Error('来源已变化，未写入旧场次。');}});
 return committed;
}
