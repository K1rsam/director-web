/** Read-only existing-receipt validation. No Prisma client, model runner or writes. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {restoreP1ReviewRequest,projectP1ReviewEvidenceRequest,validateP1ReviewPlan,planP1ReviewBatches} from '../lib/fidelity-p1-review';
import {isFidelitySourceBranchIssue,prepareFidelityReading,type FidelityReceipt} from '../lib/fidelity-import';
import {coalesceFidelityDecisions} from '../lib/fidelity-decision-ranges';
import {reconcileP1OwnershipDecisions} from '../lib/fidelity-p1-ownership';
import {reconcileP1BatchContinuityDecisions} from '../lib/fidelity-p1-batch-continuity';
import type {ImportedScript} from '../lib/import-script';

const [databasePath,runId]=process.argv.slice(2);
if(!databasePath||!runId)throw new Error('用法：node --import tsx scripts/inspect-p1-saved-response.ts <隔离DB绝对路径> <已保存F1 runId>');
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type NormalizedField={assignment:number;field:string;from:unknown;action:'RAW_HINT_ONLY'|'EXACT_DECIMAL';to:number|null};
const db=new DatabaseSync(databasePath,{readOnly:true});
try{
 const run=db.prepare('SELECT * FROM PipelineRun WHERE id=? AND stageCode=?').get(runId,'F1') as {projectId:string;inputSummary:string;log:string;status:string}|undefined;
 assert.ok(run,'没有找到指定F1回执');
 const source=db.prepare('SELECT id,content,metadata FROM SceneSnapshot WHERE projectId=? AND sceneKey=? ORDER BY createdAt DESC,id DESC LIMIT 1').get(run.projectId,'SOURCE_IMPORT') as {id:string;content:string;metadata:string|null};
 const receiptRow=db.prepare('SELECT content FROM SceneSnapshot WHERE projectId=? AND sceneKey=? ORDER BY createdAt DESC,id DESC LIMIT 1').get(run.projectId,'FIDELITY_IMPORT') as {content:string};
 assert.ok(source&&receiptRow,'缺少源稿或保真收据');
 const original=JSON.parse(source.content) as ImportedScript,receipt=JSON.parse(receiptRow.content) as FidelityReceipt,queued=JSON.parse(run.inputSummary);
 assert.equal(queued.receiverVersion,'FIDELITY_SOURCE_ACCEPT_V2');
 assert.equal(queued.sourceTextFingerprint,hash(original.sourceText),'已付费回包不属于当前原文');
 if(receipt.sourceImportId)assert.equal(receipt.sourceImportId,source.id,'保真收据与当前原文不匹配');
 if(receipt.p1Review?.reviewedSourceVersion)assert.equal(receipt.p1Review.reviewedSourceVersion,receipt.readingHash,'P1进度属于旧读取版本');
 const project=db.prepare('SELECT title,style,aspectRatio,executionMode,ruleVersion,archivedAt FROM Project WHERE id=?').get(run.projectId) as {title:string;style:string;aspectRatio:string;executionMode:string;ruleVersion:string;archivedAt:number|null};
 const episodes=db.prepare('SELECT number,title,content FROM Episode WHERE projectId=? ORDER BY number ASC').all(run.projectId);
 const sourceInputVersion=hash({project:{...project,archivedAt:project.archivedAt===null?null:new Date(project.archivedAt).toISOString()},sourceImport:source,episodes});
 assert.equal(queued.sourceInputVersion,sourceInputVersion,'项目/来源/已物化集版本已变；旧回包不自动套入新版本');
 const calls=JSON.parse(run.log).calls as Array<{kind:string;sequence:number;taskPrompt:string;requestOutcome:string;response?:{data?:Record<string,unknown>;rawOutput?:string}}>;
 const saved=[...calls].reverse().find(call=>call.requestOutcome==='RESPONDED'&&call.response);
 assert.ok(saved,'没有可免费重验的已返回响应');
 assert.equal(saved.kind,'INITIAL','格式修复回包须由完整接收器处理，本只读工具不推测repairBase');
 const marker=[...saved.taskPrompt.matchAll(/^INPUT_JSON:\s*/gm)].at(-1);assert.ok(marker,'历史请求缺少输入封包');
 const wire=JSON.parse(saved.taskPrompt.slice(marker.index!+marker[0].length));
 assert.equal(hash({receiver:'FIDELITY_SOURCE_ACCEPT_V2',request:projectP1ReviewEvidenceRequest(wire)}),queued.workFingerprint,'请求指纹与历史回执不一致');
 const request=restoreP1ReviewRequest(wire,original.sourceText);assert.equal(request.sourceVersion,sourceInputVersion);
 const value=saved.response!.data??JSON.parse(saved.response!.rawOutput??'null'),before=JSON.stringify(value),proposal=validateP1ReviewPlan(value,request);
 const continuity=reconcileP1BatchContinuityDecisions(original.sourceText,{manualDecisions:receipt.decisions,pendingDecisions:[...(receipt.p1Review?.pendingDecisions??[]),...proposal.decisions],completedRanges:receipt.p1Review?.completedRanges??[],...(!request.repairAttempt?{currentBatch:{start:request.sections[0].start,end:request.sections.at(-1)!.end}}:{})});
 const decisions=reconcileP1OwnershipDecisions(original.sourceText,coalesceFidelityDecisions(original.sourceText,[...receipt.decisions,...continuity.decisions])).decisions;
 const checked=prepareFidelityReading(original,receipt.mode,decisions,receipt.originalHash,undefined,receipt.sourceBranchDecisions??[]);
 assert.equal(checked.receipt.result.source.text,original.sourceText);assert.equal(checked.receipt.readingHash,receipt.readingHash);assert.equal(JSON.stringify(value),before,'不得修改历史模型响应');
 const normalizedFields=(value.assignments as Array<Record<string,unknown>>).flatMap((row,index)=>['episodeNumber','sceneNumber'].flatMap<NormalizedField>(field=>row.kind==='context'&&row[field]!==undefined?[{assignment:index,field,from:row[field],action:'RAW_HINT_ONLY',to:null}]:typeof row[field]==='string'?[{assignment:index,field,from:row[field],action:'EXACT_DECIMAL',to:Number(row[field])}]:[]));
 console.log(JSON.stringify({readOnly:true,providerCalls:0,runId,originalRunStatus:run.status,sourceInputVersion,reviewed:request.batch,normalizedFields,
  acceptance:'VALID_UNCOMMITTED',sourcePreserved:true,programIssues:checked.receipt.result.validation.issues.length,technicalIssues:checked.receipt.result.validation.issues.filter(i=>!isFidelitySourceBranchIssue(i)),sourceOwnershipChoices:checked.receipt.sourceEpisodeBranches??[],
  episodeNumbering:checked.receipt.episodeNumbering,materializedEpisodeNumbers:checked.imported.episodes.map(e=>e.number),batchContinuityCorrections:continuity.corrections,batchContinuityUnresolved:continuity.diagnostics.filter(i=>i.status==='UNRESOLVED'),
  remainingFullBatches:planP1ReviewBatches(original.sourceText).filter(blocks=>!receipt.p1Review?.completedRanges?.some(range=>range.start===blocks[0].start&&range.end===blocks.at(-1)!.end)&&(request.repairAttempt||blocks[0].id!==request.batch.firstBlock||blocks.at(-1)!.id!==request.batch.lastBlock)).length,
  note:'只证明现接收器可接收该已存回包；未写进度、未确认源文取舍、未开始下一批。'},null,2));
}finally{db.close();}
