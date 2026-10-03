import { prisma } from '@/lib/prisma';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prepareFidelityReading, type FidelityReceipt, type FidelityDecision } from './fidelity-import';
import type { ImportedScript } from './import-script';
import { preprocessProject } from './project-preprocess';
import { assertNoActiveFoundationDelivery } from './foundation-choice-store';
import { fidelityReviewCandidates, type FidelityCandidateMaterial } from './fidelity-review-candidates';
type ReadDb = Pick<Prisma.TransactionClient, 'sceneSnapshot'>;
/** Read only the source-bound candidate evidence, not the multi-megabyte import
 * package, duplicate source branches, diagnostics and original-file base64.
 * Full receipts remain the authority for source downloads and all mutations. */
export async function readFidelityReviewCandidates(projectId:string,db:ReadDb & Partial<Pick<Prisma.TransactionClient,'$queryRaw'>>=prisma){
 if(!db.$queryRaw){const full=await readFidelityReceipt(projectId,db);return full?fidelityReviewCandidates(full.receipt):[];}
 const rows=await db.$queryRaw<Array<{material:string;fullReceipt:string|null}>>`
  SELECT CASE WHEN json_valid(content) THEN json_object(
   'schema',json_extract(content,'$.schema'),
   'sourceVersion',json_extract(content,'$.result.source.sourceVersion'),
   'readingHash',json_extract(content,'$.readingHash'),
   'p1Review',json_object('status',json_extract(content,'$.p1Review.status'),
     'reviewedSourceVersion',json_extract(content,'$.p1Review.reviewedSourceVersion'),
     'aliases',json_extract(content,'$.p1Review.aliases'),
     'unresolved',json_extract(content,'$.p1Review.unresolved')),
   'externalReview',json_extract(content,'$.externalReview'),
   'result',json_object('source',json_object('text',json_extract(content,'$.result.source.text')),
     'episodes',json((SELECT json_group_array(json_object(
       'number',json_extract(value,'$.number'),'productionEligible',json_extract(value,'$.productionEligible'),
       'start',json_extract(value,'$.start'),'end',json_extract(value,'$.end')))
       FROM json_each(content,'$.result.episodes') WHERE type='object')))
  ) ELSE '{}' END AS material,
  CASE WHEN json_valid(content) THEN CASE WHEN
    (SELECT COUNT(key)>COUNT(DISTINCT key) FROM json_each(content)) OR
    (SELECT COUNT(key)>COUNT(DISTINCT key) FROM json_each(content,'$.result')) OR
    (SELECT COUNT(key)>COUNT(DISTINCT key) FROM json_each(content,'$.result.source')) OR
    (SELECT COUNT(key)>COUNT(DISTINCT key) FROM json_each(content,'$.p1Review')) OR
    json_type(content,'$.result.episodes') IS NOT 'array' OR
    EXISTS(SELECT 1 FROM json_each(content,'$.result.episodes') e WHERE e.type IS NOT 'object'
      OR CASE WHEN e.type='object' THEN (SELECT COUNT(key)>COUNT(DISTINCT key) FROM json_each(e.value)) ELSE 0 END)
    THEN content END END AS fullReceipt FROM SceneSnapshot
  WHERE projectId=${projectId} AND sceneKey='FIDELITY_IMPORT'
  ORDER BY createdAt DESC,id DESC LIMIT 1`;
 if(!rows.length)return [];
 if(rows[0].fullReceipt){
  const full=JSON.parse(rows[0].fullReceipt) as FidelityReceipt;
  if(full.schema!=='FIDELITY_RECEIPT_V1'||!full.result?.source?.sourceVersion)throw new Error('保真记录不可读，请保留原件并重新导入。');
  return fidelityReviewCandidates(full);
 }
 const material=JSON.parse(rows[0].material) as FidelityCandidateMaterial & {schema?:string;sourceVersion?:string};
 if(material.schema!=='FIDELITY_RECEIPT_V1'||!material.sourceVersion)throw new Error('保真记录不可读，请保留原件并重新导入。');
 return fidelityReviewCandidates(material);
}
export async function readFidelityReceipt(projectId:string,db:ReadDb=prisma){
 const [snapshot,sourceSnapshot]=await Promise.all([
  db.sceneSnapshot.findFirst({where:{projectId,sceneKey:'FIDELITY_IMPORT'},orderBy:[{createdAt:'desc'},{id:'desc'}]}),
  db.sceneSnapshot.findFirst({where:{projectId,sceneKey:'SOURCE_IMPORT'},orderBy:[{createdAt:'desc'},{id:'desc'}]})]);
 if(!snapshot)return null;
 const receipt=JSON.parse(snapshot.content) as FidelityReceipt;
 if(receipt.schema!=='FIDELITY_RECEIPT_V1'||!receipt.result?.source?.sourceVersion)throw new Error('保真记录不可读，请保留原件并重新导入。');
 return {snapshot,receipt,sourceSnapshot};
}
export type FidelityDecisionRequest={projectId:string;revision:string;sourceRevision:string;sourceVersion:string;decisionVersion:string;firstLine:number;lastLine:number;kind:'body'|'context';episodeNumber?:number;sceneNumber?:number};
/** A newer explicit user range replaces only its intersection, preserving unrelated accepted work. */
function outsideDecisionRange(decisions:FidelityDecision[],range:{start:number;end:number}){
 return decisions.flatMap(d=>d.end<=range.start||d.start>=range.end?[d]:[
  ...(d.start<range.start?[{...d,end:range.start}]:[]),...(d.end>range.end?[{...d,start:range.end}]:[])
 ]);
}
/** Source and decision CAS; this endpoint never deletes an episode. */
export async function applyFidelityDecision(request:FidelityDecisionRequest,db:PrismaClient=prisma){
 const current=await readFidelityReceipt(request.projectId,db);
 const matches=(value:Awaited<ReturnType<typeof readFidelityReceipt>>)=>value?.snapshot.id===request.revision&&value.sourceSnapshot?.id===request.sourceRevision&&value.receipt.readingHash===request.sourceVersion&&value.receipt.result.plan.decisionVersion===request.decisionVersion;
 if(!current||!matches(current))throw new Error('来源或边界决定版本已变化，请刷新后再确认。');
 if(current.receipt.sourceImportId&&current.receipt.sourceImportId!==current.sourceSnapshot?.id)throw new Error('来源与清洗凭据不属于同一修订。');
 const original=JSON.parse(current.sourceSnapshot!.content) as ImportedScript;
 if(original.sourceText!==current.receipt.result.source.text)throw new Error('最新来源已改变，旧页面不能覆盖。');
 const rows=[...original.sourceText.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)];
 const {firstLine:first,lastLine:last,kind}=request;
 if(!Number.isInteger(first)||!Number.isInteger(last)||first<1||last<first||last>rows.length)throw new Error('请选择有效的完整行范围。');
 if(!['body','context'].includes(kind))throw new Error('无效的来源用途。');
 if(kind==='body'&&(!Number.isSafeInteger(request.episodeNumber)||request.episodeNumber!<0))throw new Error('正文集号须为非负整数；真实第0集剧情可保留。');
 if(request.sceneNumber!==undefined&&(!Number.isSafeInteger(request.sceneNumber)||request.sceneNumber<1))throw new Error('场号须为正整数。');
 const decision:FidelityDecision={start:rows[first-1].index!,end:rows[last-1].index!+rows[last-1][0].length,kind,note:'用户在来源预览中明确确认',...(kind==='body'?{episodeNumber:request.episodeNumber,sceneNumber:request.sceneNumber??1}:{})};
 const decisions=[...outsideDecisionRange(current.receipt.decisions,decision),decision].sort((a,b)=>a.start-b.start);
 const sourceBranchDecisions=[...outsideDecisionRange(current.receipt.sourceBranchDecisions??[],decision),decision].sort((a,b)=>a.start-b.start);
 const prepared=prepareFidelityReading({...original,readingView:current.receipt.reader},current.receipt.mode,decisions,current.receipt.originalHash,undefined,sourceBranchDecisions);
 prepared.receipt={...current.receipt,...prepared.receipt,guarantee:current.receipt.guarantee};
 // Reading evidence stays valid: this operation changes no source characters. The user wins over
 // pending AI proposals only where their ranges overlap; completed batches are not repurchased.
 if(current.receipt.p1Review?.status==='PENDING')prepared.receipt.p1Review={...current.receipt.p1Review,
  pendingDecisions:outsideDecisionRange(current.receipt.p1Review.pendingDecisions??[],decision)};
 const committed=await db.$transaction(async tx=>{
  if(!matches(await readFidelityReceipt(request.projectId,tx)))throw new Error('另一窗口已保存新来源或决定，请刷新。');
  await assertNoActiveFoundationDelivery(tx,request.projectId);
  if(await tx.pipelineRun.findFirst({where:{projectId:request.projectId,status:{in:['RUNNING','QUEUED']}}}))throw new Error('请先停止正在执行的任务。');
  const existing=await tx.episode.findMany({where:{projectId:request.projectId},include:{_count:{select:{snapshots:true,taskPackages:true,reviewRounds:true,finalScripts:true,storyboardShots:true,seedanceUnits:true,pipelineRuns:true,workflowIssues:true}}}});
  const affected=existing.filter(old=>!prepared.imported.episodes.some(e=>e.number===old.number&&e.content===old.content));
  if(existing.some(old=>!prepared.imported.episodes.some(e=>e.number===old.number)))throw new Error('边界确认不能移除已有集及其历史资料；请新建项目导入调整后的分类。');
  if(affected.length){
   const downstream=await tx.sceneSnapshot.findFirst({where:{projectId:request.projectId,sceneKey:{notIn:['SOURCE_IMPORT','FIDELITY_IMPORT','FOUNDATION_SOURCE','FOUNDATION_DELIVERY_TASK']}}});
   if(downstream||await tx.asset.count({where:{projectId:request.projectId}})||affected.some(e=>Object.values(e._count).some(n=>n>0)))throw new Error('受影响集已有下游或历史资料，未修改原文；请新建项目导入。');
  }
  for(const episode of prepared.imported.episodes){const old=existing.find(e=>e.number===episode.number);if(old)await tx.episode.update({where:{id:old.id},data:{title:episode.title,content:episode.content}});else await tx.episode.create({data:{projectId:request.projectId,...episode}});}
  const source=await tx.sceneSnapshot.create({data:{projectId:request.projectId,sceneKey:'SOURCE_IMPORT',title:'用户确认后的来源分区',content:JSON.stringify(prepared.imported),metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2',originalFileStoredForRecovery:Boolean(prepared.imported.originalFile)})}});
  prepared.receipt.sourceImportId=source.id;
  const receipt=await tx.sceneSnapshot.create({data:{projectId:request.projectId,sceneKey:'FIDELITY_IMPORT',title:'用户确认边界的清洗版本',content:JSON.stringify(prepared.receipt),metadata:JSON.stringify({schema:'FIDELITY_RECEIPT_V1',sourceVersion:prepared.receipt.readingHash})}});
  return {sourceId:source.id,receiptId:receipt.id};
 });
 await preprocessProject(request.projectId,db,{checkCurrent:async tx=>{const latest=await readFidelityReceipt(request.projectId,tx);if(latest?.snapshot.id!==committed.receiptId||latest.sourceSnapshot?.id!==committed.sourceId)throw new Error('来源已被另一窗口更新，未写入迟到的解析结果。');}});
 return committed;
}
