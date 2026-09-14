import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { CONTRACT_VERSION } from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import { readFidelityReceipt } from './fidelity-store';
import { prepareFidelityReading, type FidelityDecision } from './fidelity-import';
import type { ImportedScript } from './import-script';
import { assertNoActiveFoundationDelivery } from './foundation-choice-store';
import { preprocessProject } from './project-preprocess';
import type { P1ReviewState } from './fidelity-p1-review';
const hash = (text:string) => createHash('sha256').update(text).digest('hex');
/** Rebuild only the derived reading structure; source bytes and accepted decisions stay pinned. */
export async function refreshFidelitySource(projectId:string, db:PrismaClient, options:{expectedReceiptId?:string;expectedSourceId?:string;checkAfterCommit?:(tx:Prisma.TransactionClient)=>Promise<void>;checkCurrent?:(tx:Prisma.TransactionClient)=>Promise<void>;decisions?:FidelityDecision[];p1Review?:P1ReviewState}={}) {
 const current=await readFidelityReceipt(projectId,db);
 if(!current){if(options.expectedReceiptId||options.expectedSourceId)throw new Error('来源凭据已变化，未保存旧判断。');return {changed:false};}
 if(options.expectedReceiptId&&current.snapshot.id!==options.expectedReceiptId||options.expectedSourceId&&current.sourceSnapshot?.id!==options.expectedSourceId)throw new Error('来源或决定已变化，未保存旧判断。');
 if(!current.sourceSnapshot || current.receipt.sourceImportId && current.receipt.sourceImportId!==current.sourceSnapshot.id)throw new Error('保真来源与凭据版本不一致，未覆盖原文。');
 const retryLeadingBoundary=current.receipt.result.validation.issues.some(issue=>issue.code==='BOUNDARY_UNCONFIRMED'&&issue.start===0);
 if(current.receipt.result.contractVersion===CONTRACT_VERSION&&!options.decisions&&!options.p1Review&&!retryLeadingBoundary)return {changed:false};
 const original=JSON.parse(current.sourceSnapshot.content) as ImportedScript;
 if(original.sourceText!==current.receipt.result.source.text||hash(original.sourceText)!==current.receipt.readingHash)throw new Error('保真来源校验失败，未覆盖原文。');
 const decisions=options.decisions??current.receipt.decisions;
 const prepared=prepareFidelityReading({...original,readingView:current.receipt.reader},current.receipt.mode,decisions,current.receipt.originalHash);
 if(!options.decisions&&!options.p1Review&&JSON.stringify(prepared.receipt.result)===JSON.stringify(current.receipt.result))return {changed:false};
 prepared.receipt={...current.receipt,...prepared.receipt,...(options.p1Review?{p1Review:options.p1Review}:{})};
 prepared.receipt.guarantee=current.receipt.guarantee;prepared.receipt.externalPackage=current.receipt.externalPackage;
 const pinned=(latest:Awaited<ReturnType<typeof readFidelityReceipt>>)=>latest?.snapshot.id===current.snapshot.id&&latest.sourceSnapshot?.id===current.sourceSnapshot!.id&&latest.receipt.readingHash===current.receipt.readingHash&&latest.receipt.result.plan.decisionVersion===current.receipt.result.plan.decisionVersion;
 const committed=await db.$transaction(async tx=>{
  if(options.checkCurrent)await options.checkCurrent(tx);else await assertNoActiveFoundationDelivery(tx,projectId);
  if(!pinned(await readFidelityReceipt(projectId,tx)))throw new Error('来源或决定已变化，未保存过期解析。');
  const existing=await tx.episode.findMany({where:{projectId},include:{_count:{select:{taskPackages:true,reviewRounds:true,finalScripts:true,storyboardShots:true,seedanceUnits:true,pipelineRuns:true}}}});
  const used=new Set<string>();
  const assignments=prepared.imported.episodes.map(episode=>{
   const exact=existing.filter(old=>!used.has(old.id)&&old.content===episode.content);
   const old=exact.find(old=>old.number===episode.number)??(exact.length===1?exact[0]:undefined)??existing.find(old=>!used.has(old.id)&&old.number===episode.number);
   if(old)used.add(old.id);return {episode,old};
  });
  if(existing.some(old=>!used.has(old.id)))throw new Error('重新识别会移除已有集，已保留旧集与历史；请在来源页面明确范围。');
  const affected=assignments.filter(({episode,old})=>old&&(episode.number!==old.number||episode.content!==old.content));
  if(affected.length){
   const scenes=await tx.scriptScene.findMany({where:{episodeId:{in:affected.map(a=>a.old!.id)}},select:{metadata:true,sourceText:true}});
   const manualScene=scenes.some(scene=>{try{const meta=JSON.parse(scene.metadata);return Object.keys(meta).some(k=>!['characters','props','sourceHash','sourceSceneKey','sceneKeyAmbiguous'].includes(k))||meta.sourceHash&&meta.sourceHash!==hash(scene.sourceText);}catch{return true;}});
   const snapshots=await tx.sceneSnapshot.findMany({where:{projectId},select:{sceneKey:true}});
   const allowed=(key:string)=>['SOURCE_IMPORT','FIDELITY_IMPORT','FOUNDATION_SOURCE','FOUNDATION_DELIVERY_TASK','SOURCE_STRUCTURE_RESOLUTION'].includes(key)||key.startsWith('RETIRED_P0_SCENE-');
   if(manualScene||snapshots.some(s=>!allowed(s.sceneKey??''))||await tx.asset.count({where:{projectId}})||await tx.pipelineRun.count({where:{projectId,...(options.checkCurrent?{stageCode:{not:'F1'}}:{})}})||affected.some(({old})=>Object.values(old!._count).some(n=>n>0)))throw new Error('已有资产、模型运行或人工制作资料，未自动更改集号或正文；原文与历史保留，请先核对来源。');
  }
  // Exact content matching preserves episode ids when an old parser shifted numbering.
  let temporary=Math.min(0,...existing.map(e=>e.number))-assignments.length-1;
  for(const {old,episode} of assignments)if(old&&old.number!==episode.number)await tx.episode.update({where:{id:old.id},data:{number:temporary--}});
  for(const {old,episode} of assignments)if(old)await tx.episode.update({where:{id:old.id},data:episode});else await tx.episode.create({data:{projectId,...episode}});
  const source=await tx.sceneSnapshot.create({data:{projectId,sceneKey:'SOURCE_IMPORT',title:'保真来源结构更新',content:JSON.stringify(prepared.imported),metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2',originalFileStoredForRecovery:Boolean(prepared.imported.originalFile)})}});
  prepared.receipt.sourceImportId=source.id;
  const receipt=await tx.sceneSnapshot.create({data:{projectId,sceneKey:'FIDELITY_IMPORT',title:'保真来源结构更新',content:JSON.stringify(prepared.receipt),metadata:JSON.stringify({schema:'FIDELITY_RECEIPT_V1',sourceVersion:prepared.receipt.readingHash})}});
  return {changed:true,sourceId:source.id,receiptId:receipt.id};
 },{timeout:20000});
 await preprocessProject(projectId,db,{checkCurrent:async tx=>{if(options.checkAfterCommit)await options.checkAfterCommit(tx);const latest=await readFidelityReceipt(projectId,tx);if(latest?.snapshot.id!==committed.receiptId||latest.sourceSnapshot?.id!==committed.sourceId)throw new Error('来源已变化，未写入旧场次。');}});
 return committed;
}
