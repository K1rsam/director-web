/** Read-only production audit. No database, model, coordinator or dispatch imports. */
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createProductionBudgetStore} from '../runtime/production-budget.mjs';
import {isVerifiedUnsent} from '../runtime/storyboard-v4/core/pre-dispatch-evidence.mjs';
import {candidateResolvedBy} from '../runtime/storyboard-v4/core/reference-role-review.mjs';

const chars=value=>value===undefined?0:JSON.stringify(value).length;
const nonnegative=n=>Number.isSafeInteger(n)&&n>=0;
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const optional=async file=>{try{return await json(file);}catch(e){if(e.code==='ENOENT')return null;throw e;}};
const validId=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);

export function requestMetrics(request){
 const prompt=request.prompt??'',marker='【生效设置与本次完整资料】\n',at=prompt.indexOf(marker);
 let body=null;
 if(at>=0){try{body=JSON.parse(prompt.slice(at+marker.length).split('\n')[0]);}catch{}}
 return {promptChars:prompt.length,instructionsChars:(request.instructions??'').length,schemaChars:chars(request.schema),
  sentChars:prompt.length+(request.instructions??'').length+chars(request.schema),rulePrefixChars:at<0?null:at,
  bodyParsed:Boolean(body),sections:body?Object.fromEntries(Object.entries(body).map(([k,v])=>[k,chars(v)])):null,
  sourceChars:chars(body?.source),sourceRowCount:body?.source?.sourceRows?.length??null,
  contextChars:chars(body?.source?.context),retrievalChars:chars(body?.source?.context?.retrievalFacts),
  contextSections:body?.source?.context?Object.fromEntries(Object.entries(body.source.context).map(([k,v])=>[k,chars(v)])):null,
  boundaryChars:chars(body?.episodeBoundary),materialChars:chars(body?.productionMaterials),previousDraftChars:chars(body?.previousDraft),
  model:request.settings?.model??null,reasoning:request.settings?.reasoning??null};
}
function trustedUsage(usage){
 return Boolean(usage&&nonnegative(usage.inputTokens)&&nonnegative(usage.outputTokens)&&nonnegative(usage.totalTokens)
  &&usage.totalTokens===usage.inputTokens+usage.outputTokens
  &&(usage.cachedInputTokens==null||nonnegative(usage.cachedInputTokens)&&usage.cachedInputTokens<=usage.inputTokens));
}
export function summarizeRun(run,attempts){
 const seen=new Set(),duplicateAttempts=[],calls=[];
 for(const op of run.operations??[]){
  if(seen.has(op.attemptId)){duplicateAttempts.push(op.attemptId);continue;}seen.add(op.attemptId);
  const saved=attempts.get(op.attemptId),nativeReceipt=saved?.receipt,receipt=nativeReceipt??op.receipt;
  const pending=['running','queued'].includes(op.status)&&receipt?.state!=='FINAL';
  const usage=receipt?.usage;
  const localAbsence=!nativeReceipt&&!saved?.request&&isVerifiedUnsent(op);
  const locallyClosed=op.status==='failed'||op.status==='completed'&&Boolean(op.localSettledAt);
  const notSent=!pending&&locallyClosed&&(nativeReceipt
   ?nativeReceipt.state==='FINAL'&&nativeReceipt.requestOutcome==='NOT_SENT'
   :localAbsence||op.error?.requestOutcome==='NOT_SENT'&&(!op.receipt||op.receipt.requestOutcome==='NOT_SENT'))
   &&![usage,op.receipt?.usage].some(u=>Object.values(u??{}).some(n=>typeof n==='number'&&n>0));
  const known=(notSent||trustedUsage(usage))&&!pending;
  const receiptConflict=Boolean(saved?.receipt?.usage&&op.receipt?.usage&&trustedUsage(op.receipt.usage)
   &&op.receipt.usage.totalTokens!==saved.receipt.usage.totalTokens);
  const timingFinal=nativeReceipt?nativeReceipt.state==='FINAL':receipt?.state==='FINAL'
   ||receipt?.state==null&&['failed','completed'].includes(op.status)&&Boolean(receipt?.execution?.terminalAt??op.localSettledAt);
  const localClose=Date.parse(op.localSettledAt),created=Date.parse(op.createdAt);
  // An explicitly observed orphan closure can bound wall time, never model time or cost.
  const localClosedAt=op.status==='unknown'&&op.cancelAcknowledgement?.kind==='orphan'&&op.cancelAcknowledgement.acceptUnknownUsage===true
   &&op.cancelAcknowledgement.at===op.localSettledAt&&Number.isFinite(localClose)&&Number.isFinite(created)&&localClose>=created&&localClose<=Date.now()?op.localSettledAt:null;
  calls.push({attemptId:op.attemptId,stage:op.stage,status:op.status,packageIds:op.packageIds??[],finishMode:op.finishMode??null,
   fingerprint:op.fingerprint??null,createdAt:op.createdAt??null,
   durationMs:timingFinal&&nonnegative(receipt?.durationMs)?receipt.durationMs:null,
   finishedAt:timingFinal?(receipt?.execution?.terminalAt??op.localSettledAt??null):null,
   localClosedAt,
   dispatchObserved:!localAbsence&&(receipt?.requestOutcome==='RESPONDED'||trustedUsage(usage)&&usage.totalTokens>0||receipt?.execution?.modelActivityObserved===true),
   localVerifiedOutcome:localAbsence?'NOT_SENT':null,
   pending,notSent,usageKnown:known&&!receiptConflict,usage:known&&!receiptConflict&&trustedUsage(usage)?usage:null,receiptConflict,
   requestMissing:!saved?.request,request:saved?.request?requestMetrics(saved.request):null,
   requestedServiceTier:receipt?.requestedServiceTier??null,phase:receipt?.execution?.phase??null,
   lastEventAt:receipt?.execution?.lastEventAt??null,startedAt:receipt?.execution?.startedAt??null,
   errorCode:receipt?.errorCode??op.error?.code??null,issueCodes:op.issues?.map(i=>i.code)??[]});
 }
 const known=calls.filter(c=>c.usageKnown),inFlight=calls.filter(c=>c.pending).length;
 const unknownAttempts=calls.filter(c=>!c.pending&&!c.usageKnown).length;
 const totals=Object.fromEntries(['inputTokens','cachedInputTokens','outputTokens','totalTokens'].map(k=>[k,known.reduce((n,c)=>n+(c.usage?.[k]??0),0)]));
 const cachedUsageComplete=!inFlight&&!unknownAttempts&&known.every(c=>c.notSent||c.usage?.cachedInputTokens!=null);
 const timed=calls.filter(c=>!c.notSent),knownModelDurationMs=timed.reduce((n,c)=>n+(c.durationMs??0),0);
 const timingComplete=!inFlight&&timed.every(c=>c.durationMs!==null);
 const starts=calls.map(c=>Date.parse(c.createdAt??c.startedAt)),ends=calls.map(c=>Date.parse(c.finishedAt??c.localClosedAt));
 const elapsedMs=calls.length&&!inFlight&&starts.every(Number.isFinite)&&ends.every(Number.isFinite)&&Math.max(...ends)>=Math.min(...starts)?Math.max(...ends)-Math.min(...starts):null;
 const codes=errors=>(Array.isArray(errors)?errors:[]).map(error=>typeof error?.code==='string'?error.code:null);
 const candidateErrors=(run.candidates??[]).filter(c=>c.errors?.length||c.validation?.errors?.length).map(c=>({
  candidateId:c.id??null,attemptId:c.attemptId??null,stage:c.stage??null,status:c.status??null,resolvedBy:candidateResolvedBy(run,c),
  errorCodes:codes(c.errors),validationErrorCodes:codes(c.validation?.errors)
 }));
 return {runId:run.id,status:run.status,sourceTextChars:run.source?.sourceRows?.reduce((n,r)=>n+(r.text??'').length,0)??null,
  dispatchedAttempts:calls.filter(c=>c.dispatchObserved).length,modelDurationMs:timingComplete?knownModelDurationMs:null,knownModelDurationMs,timingComplete,elapsedMs,
  model:run.settings?.model??null,reasoning:run.settings?.reasoning??null,executionTier:run.web?.binding?.executionTier??'legacy-standard',
  fantasyMode:run.settings?.fantasyMode??null,packageCount:run.plan?.packages?.length??run.plan?.workPackages?.length??null,
  unitCount:run.assembly?.draft?.units?.length??null,attemptCount:calls.length,duplicateAttempts,inFlight,unknownAttempts,
  inputTokens:totals.inputTokens,cachedInputTokens:cachedUsageComplete?totals.cachedInputTokens:null,cachedUsageComplete,knownCachedInputTokens:totals.cachedInputTokens,outputTokens:totals.outputTokens,
  knownTokens:totals.totalTokens,totalTokens:inFlight||unknownAttempts?null:totals.totalTokens,usageComplete:!inFlight&&!unknownAttempts,
  pendingRepair:run.production?.pendingRepair?{packageIds:run.production.pendingRepair.packageIds,versionId:run.production.pendingRepair.versionId}:null,
  boundaryStatus:run.production?.boundaryCheck?.status??null,candidateErrors,calls};
}
export async function inspectProductionUsage({workflowFile,runDirectory,budgetDirectory}){
 const workflow=await json(workflowFile),episodes=[];
 for(const [number,id]of Object.entries(workflow.selectedRuns??{}).sort((a,b)=>Number(a[0])-Number(b[0]))){
  if(!validId(id))throw new Error('Invalid saved run id');
  const run=await optional(path.join(runDirectory,'documents',id+'.json'));
  if(!run){episodes.push({episodeNumber:Number(number),runId:id,missing:true,totalTokens:null});continue;}
  const attempts=new Map();
  for(const op of run.operations??[]){
   if(!validId(op.attemptId)||attempts.has(op.attemptId))continue;
   const folder=path.join(runDirectory,'attempts',op.attemptId);
   const [request,receipt]=await Promise.all([optional(path.join(folder,'request.json')),optional(path.join(folder,'receipt.json'))]);
   attempts.set(op.attemptId,{request,receipt});
  }
  episodes.push({episodeNumber:Number(number),...summarizeRun(run,attempts)});
 }
 const ledger=budgetDirectory&&validId(workflow.budgetId)?await createProductionBudgetStore(budgetDirectory).read(workflow.budgetId):null;
 const budget=ledger?{id:ledger.id,maxCalls:ledger.maxCalls,maxTokens:ledger.maxTokens,paused:ledger.paused,summary:ledger.summary}:null;
 return {schema:'PRODUCTION_USAGE_AUDIT_V1',at:new Date().toISOString(),workflowId:workflow.id,revision:workflow.revision,
  executionTier:workflow.parallel?.executionTier??null,enabled:workflow.parallel?.enabled??false,paused:workflow.paused??false,
  worker:workflow.parallel?.worker??null,lanes:workflow.parallel?.lanes??[],activeAction:workflow.activeAction??null,budget,
  measure:'Native raw Token totals. Cache is included in input, reasoning in output. Section sizes are UTF-16 characters, not Token attribution. Missing usage is unknown, never zero.',
  episodes};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const id=process.argv[2];if(!validId(id))throw new Error('Usage: node scripts/inspect-production-usage.mjs WORKFLOW_ID');
 try{process.loadEnvFile('.env');}catch(e){if(e.code!=='ENOENT')throw e;}
 const report=await inspectProductionUsage({
  workflowFile:path.join(process.env.DIRECTOR_PRODUCTION_WORKFLOW_DIR??'.production-workflows','documents',id+'.json'),
  runDirectory:process.env.DIRECTOR_STORYBOARD_DATA_DIR??'.storyboard-stage3-v2',
  budgetDirectory:process.env.DIRECTOR_PRODUCTION_BUDGET_DIR??'.production-ledgers'});
 console.log(JSON.stringify(report,null,2));
}
