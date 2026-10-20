import {createHash} from 'node:crypto';
import {mkdir,readFile,readdir,lstat,open,rename} from 'node:fs/promises';
import path from 'node:path';
import {digest,fail} from './storyboard-v4/core/shared.mjs';
import {acquireRuntimeLease} from './storyboard-v4/runtime-lease.mjs';
import {isVerifiedUnsent} from './storyboard-v4/core/pre-dispatch-evidence.mjs';

const integer=n=>Number.isSafeInteger(n)&&n>=0;
const sha=value=>createHash('sha256').update(value).digest('hex');
const json=value=>JSON.stringify(value,null,2)+'\n';
const safeId=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
const finalBoundaries=new Set(['NO_PREDECESSOR','NOT_CONTINUOUS','NOT_CONSUMED','MATCHED']);
const usageKnown=u=>u&&integer(u.inputTokens)&&integer(u.outputTokens)&&integer(u.totalTokens)&&u.totalTokens===u.inputTokens+u.outputTokens
 &&(u.cachedInputTokens==null||integer(u.cachedInputTokens)&&u.cachedInputTokens<=u.inputTokens);
export const productionDeliveryFingerprint=(workflow,views)=>digest({sourceVersion:workflow.sourceVersion,selectionRevision:workflow.selectionRevision,selectedRuns:workflow.selectedRuns,runs:workflow.episodeNumbers.map(n=>[workflow.selectedRuns[n],views[workflow.selectedRuns[n]]?.fingerprint??null])});

/** Free accounting over saved evidence. No coordinator, DB, provider or source writes. */
export async function buildProductionDelivery({workflow,runs,views,ledger,readAttempt}){
 const bad=message=>fail('WORKFLOW_DELIVERY_NOT_READY',message);
 if(!safeId(workflow.id)||workflow.activeAction||!workflow.episodeNumbers?.length||ledger.summary?.inFlight)bad('先等待原队列落定并核对当前源与采用版本。');
 const unique=new Set(),calls=[],episodes=[],files={};
 for(const n of workflow.episodeNumbers){
  const run=runs.find(r=>r.id===workflow.selectedRuns[n]),view=run&&views[run.id],b=run?.web?.binding;
  if(!run||!view?.complete||view.freshness!=='CHECKED'||view.sourceCheckPending||view.busy||view.blocked||view.sourceStale
   ||b.projectId!==workflow.projectId||b.episodeNumber!==n||b.productionChain?.id!==workflow.id
   ||run.status!=='text_ready_for_review'||!run.assembly?.text||run.assembly.validation?.errors?.length!==0
   ||run.production?.blocking||run.production?.pendingRepair||run.production?.needs?.some(x=>x.blocking&&!x.resolved)
   ||workflow.mode==='CHAIN'&&!finalBoundaries.has(run.production?.boundaryCheck?.status))bad(`第${n}集尚未完成当前来源、实际承接及采用稿核验。`);
  if(n===workflow.episodeNumbers[0]&&!workflow.qualityReviews?.some(r=>r.runId===run.id&&r.fingerprint===view.fingerprint&&r.episodeNumber===n))bad('首集实际文字质量核对尚未绑定当前采用稿。');
  const file=`episodes/episode-${String(n).padStart(4,'0')}.md`;files[file]=run.assembly.text;
  const ids=run.adopted.flatMap(a=>[a.candidateId,...(a.candidateIds??[])]);
  episodes.push({number:n,runId:run.id,file,sourceHash:digest(run.source),assemblyHash:sha(run.assembly.text),adoptedCandidateIds:[...new Set(ids)],boundaryStatus:run.production?.boundaryCheck?.status??null});
  for(const op of run.operations??[]){
   if(!safeId(op.attemptId)||unique.has(op.attemptId))fail('WORKFLOW_DELIVERY_DUPLICATE','attempt 编号重复或无效，不能重复计费或猜测归属。');unique.add(op.attemptId);
   if(['running','queued'].includes(op.status)||op.status==='unknown'&&!op.cancelAcknowledgement?.acceptUnknownUsage)bad('尚有在途或未明确接受风险的未知回执。');
   const saved=await readAttempt(op.attemptId),native=saved.receipt??null,request=saved.request??null;
   const record=ledger.attempts?.find(a=>a.id===op.attemptId),reconciled=ledger.reconciliations?.findLast(r=>r.attemptId===op.attemptId),ledgerTokens=reconciled?.totalTokens??record?.totalTokens;
   const created=Date.parse(op.createdAt),closed=Date.parse(op.localSettledAt),proof=op.localDispatchProof;
   const localUnsent=Boolean(proof&&isVerifiedUnsent(op)&&proof.evidence?.scope==='BOUND_MODEL_ADAPTER'
    &&proof.evidence.workflowId===workflow.id&&safeId(workflow.budgetId)&&proof.evidence.budgetId===workflow.budgetId&&ledger.id===workflow.budgetId
    &&!native&&!request&&!Object.values(saved.hashes??{}).some(h=>h!=null)&&!record&&!reconciled&&!run.candidates?.some(c=>c.attemptId===op.attemptId)
    &&['completed','failed'].includes(op.status)&&Number.isFinite(created)&&Number.isFinite(closed)&&closed>=created&&closed<=Date.now());
   if(proof&&!localUnsent)fail('WORKFLOW_DELIVERY_RECEIPT','本地零派发证明与当前范围或原生、账本、候选证据冲突，保留原记录，未发布交付。');
   const notSent=localUnsent||!native&&!request&&op.status==='failed'&&op.error?.requestOutcome==='NOT_SENT';
   if(request&&digest([request.promptHash,request.instructionHash,request.inputHash])!==op.fingerprint)fail('WORKFLOW_DELIVERY_RECEIPT','保存的 request 不属于原 attempt 指纹。');
   const final=native?.state==='FINAL',known=final&&native.requestOutcome==='RESPONDED'&&usageKnown(native.usage);
   if(!record&&!notSent||record?.runId&&record.runId!==run.id||known&&ledgerTokens!==native.usage.totalTokens)fail('WORKFLOW_DELIVERY_LEDGER','原生回执与共享账本缺项或不一致，未发布交付。');
   const a=op.cancelAcknowledgement;
   const localClosedAt=op.status==='unknown'&&a?.kind==='orphan'&&a.acceptUnknownUsage===true&&a.at===op.localSettledAt&&Number.isFinite(created)&&closed>=created&&closed<=Date.now()?op.localSettledAt:null;
   calls.push({episodeNumber:n,runId:run.id,attemptId:op.attemptId,stage:op.stage,packageIds:op.packageIds??[],localStatus:op.status,
    hasNativeRequest:Boolean(request),dispatchCount:notSent||final&&native.requestOutcome==='NOT_SENT'?0:native?.requestOutcome==='RESPONDED'||native?.execution?.modelActivityObserved===true?1:null,nativeState:native?.state??null,requestOutcome:native?.requestOutcome??null,
    nativeUsage:known?native.usage:null,nativeDurationMs:final&&integer(native.durationMs)?native.durationMs:null,
    ...(localUnsent?{localVerifiedOutcome:'NOT_SENT',localDispatchProof:{version:proof.version,identity:proof.identity}}:{}),
    createdAt:op.createdAt??null,finishedAt:final?native.execution?.terminalAt??null:null,localClosedAt,
    hashes:saved.hashes??{request:request?digest(request):null,receipt:native?digest(native):null},ledgerPresent:Boolean(record),ledgerTokens:ledgerTokens??null,
    issueCodes:op.issues?.map(i=>i.code)??[],unknownUsageAcknowledged:a?.acceptUnknownUsage===true});
  }
 }
 const native=calls.filter(c=>c.dispatchCount!==0),known=native.filter(c=>c.nativeUsage),timed=native.filter(c=>c.nativeDurationMs!==null);
 const sum=(list,fn)=>list.reduce((n,c)=>n+fn(c),0),knownTokens=sum(known,c=>c.nativeUsage.totalTokens),knownNativeDurationMs=sum(timed,c=>c.nativeDurationMs);
 const times=calls.flatMap(c=>[c.createdAt,c.finishedAt??c.localClosedAt]).map(Date.parse).filter(Number.isFinite);
 const summary={localRecords:calls.length,nativeRequests:calls.filter(c=>c.hasNativeRequest).length,zeroDispatch:calls.filter(c=>c.dispatchCount===0).length,
  missingDispatchEvidence:calls.filter(c=>c.dispatchCount===null).length,unknownUsage:native.length-known.length,
  knownInputTokens:sum(known,c=>c.nativeUsage.inputTokens),knownCachedInputTokens:sum(known,c=>c.nativeUsage.cachedInputTokens??0),knownOutputTokens:sum(known,c=>c.nativeUsage.outputTokens),knownTokens,
  totalTokens:known.length===native.length?knownTokens:null,knownNativeDurationMs,nativeDurationMs:timed.length===native.length?knownNativeDurationMs:null,
  observedWallMs:times.length?Math.max(...times)-Math.min(...times):null,wallComplete:calls.every(c=>c.dispatchCount===0||c.createdAt&&(c.finishedAt||c.localClosedAt)),
  currencyCost:null,stages:Object.fromEntries([...new Set(calls.map(c=>c.stage))].map(stage=>[stage,{records:calls.filter(c=>c.stage===stage).length,knownTokens:sum(known.filter(c=>c.stage===stage),c=>c.nativeUsage.totalTokens)}]))};
 const episodeUsage=episodes.map(e=>{const rows=calls.filter(c=>c.runId===e.runId),paid=rows.filter(c=>c.dispatchCount!==0),known=paid.filter(c=>c.nativeUsage),timed=paid.filter(c=>c.nativeDurationMs!==null),times=rows.flatMap(c=>[c.createdAt,c.finishedAt??c.localClosedAt]).map(Date.parse).filter(Number.isFinite);return {number:e.number,runId:e.runId,localRecords:rows.length,knownInputTokens:sum(known,c=>c.nativeUsage.inputTokens),knownCachedInputTokens:sum(known,c=>c.nativeUsage.cachedInputTokens??0),knownOutputTokens:sum(known,c=>c.nativeUsage.outputTokens),knownTokens:sum(known,c=>c.nativeUsage.totalTokens),totalTokens:known.length===paid.length?sum(known,c=>c.nativeUsage.totalTokens):null,knownNativeDurationMs:sum(timed,c=>c.nativeDurationMs),nativeDurationMs:timed.length===paid.length?sum(timed,c=>c.nativeDurationMs):null,observedWallMs:times.length?Math.max(...times)-Math.min(...times):null,unknownUsage:paid.length-known.length};});
 const usage={version:'production-delivery-usage-v1',summary,episodes:episodeUsage,attempts:calls,sharedBudget:{id:ledger.id,summary:ledger.summary??null,attempts:ledger.attempts??[],reconciliations:ledger.reconciliations??[]},
  accounting:'唯一 attempt 计数。cache 已含在 input，reasoning 已含在 output。仅原生 FINAL 提供最终用量/时长；NOT_SENT 只证明零派发，不补造回执。共享账本单列，不能与上述 stage3 相加。未知、历史缺失和非 FINAL 均保留 null。墙钟含并行、暂停、读取与调度等待，不能相减当纯推理或精确睡眠。'};
 files['complete.md']=episodes.map(e=>`# 第${e.number}集\n\n${files[e.file]}`).join('\n\n---\n\n');
 files['usage.json']=json(usage);
 files['report.md']=`# 连续制作文字交付与用量对账\n\n${episodes.length} 集采用稿，逐集正文与 assembly.text 逐字一致。文字交付不是视听成片或用户验收。\n\n- 本地记录 ${summary.localRecords}；有原生请求 ${summary.nativeRequests}；零派发 ${summary.zeroDispatch}。\n- 已知 Token ${knownTokens}；完整总量 ${summary.totalTokens??'未知'}；未知用量 ${summary.unknownUsage}。\n- 已知原生 FINAL 执行时长合计 ${knownNativeDurationMs} ms；完整合计 ${summary.nativeDurationMs??'未知'}。这是并行调用之和，不是项目墙钟。\n- 观察墙钟跨度 ${summary.observedWallMs??'未知'} ms（完整边界：${summary.wallComplete}），含暂停与准备。未单独采集的睡眠/原因不推断。\n\n${usage.accounting}\n\n按岗位的原生用量、逐 attempt 的等待起终点及证据哈希见 usage.json。输入/历史检索、正常分包和整编是主要必要支出；可逆去重、准备读取共用与保存正文恢复可优化。不得删必要来源或反证、合并不同包为重试、降低幻想/表演/保真要求；字符减少不等于实测 Token 节省。\n`;
 const manifest={version:'production-delivery-v1',workflowId:workflow.id,projectId:workflow.projectId,sourceVersion:workflow.sourceVersion,selectionRevision:workflow.selectionRevision,completionFingerprint:productionDeliveryFingerprint(workflow,views),selectedRuns:workflow.selectedRuns,qualityReviews:workflow.qualityReviews,episodes,
  files:Object.fromEntries(Object.entries(files).map(([name,body])=>[name,{bytes:Buffer.byteLength(body),sha256:sha(body)}]))};
 const identity=digest(manifest);files['manifest.json']=json({...manifest,identity});return {identity,manifest,files,usage};
}

async function directoryOnly(folder){await mkdir(folder,{recursive:true,mode:0o700});if(!(await lstat(folder)).isDirectory()||(await lstat(folder)).isSymbolicLink())fail('WORKFLOW_DELIVERY_CONFLICT','交付路径不是普通目录。');}
async function verify(folder,files){
 const rootStat=await lstat(folder);if(!rootStat.isDirectory()||rootStat.isSymbolicLink())fail('WORKFLOW_DELIVERY_CONFLICT','已有交付不是普通目录，未跟随或覆盖。');
 for(const [name,body] of Object.entries(files)){const file=path.join(folder,name),stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||sha(await readFile(file))!==sha(body))fail('WORKFLOW_DELIVERY_CONFLICT','已有交付字节与当前证据不符，保留文件，未覆盖。');}
 const expected=new Set(Object.keys(files));
 async function inventory(relative=''){for(const item of await readdir(path.join(folder,relative),{withFileTypes:true})){const name=relative?`${relative}/${item.name}`:item.name;if(item.isDirectory())await inventory(name);else if(!expected.has(name))fail('WORKFLOW_DELIVERY_CONFLICT','交付目录有未登记文件，未覆盖或删除。');}}
 await inventory();
}
export async function writeProductionDelivery({root,bundle,revalidate}){
 if(!safeId(bundle.manifest.workflowId)||!/^[a-f0-9]{64}$/.test(bundle.identity)||typeof revalidate!=='function')fail('WORKFLOW_DELIVERY_INPUT','交付身份或提交前核验缺失。');
 await directoryOnly(root);const lease=await acquireRuntimeLease(path.join(root,'.leases',bundle.manifest.workflowId));
 const target=path.join(root,bundle.identity),staging=path.join(root,`${bundle.identity}.partial`);
 try{
  if(await revalidate()!==bundle.identity)fail('WORKFLOW_DELIVERY_STALE','交付前来源、采用稿或回执已变化，未发布。');
  const exists=await lstat(target).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  if(exists){try{await verify(target,bundle.files);}catch(error){if(error.code==='ENOENT')fail('WORKFLOW_DELIVERY_CONFLICT','已有正式目录缺文件，保留现场，未用新目录覆盖。');throw error;}return {identity:bundle.identity,directory:target,reused:true};}
  await directoryOnly(staging);
  for(const [name,body] of Object.entries(bundle.files)){
   const file=path.join(staging,name);await directoryOnly(path.dirname(file));let handle;
   try{handle=await open(file,'wx',0o600);await handle.writeFile(body);await handle.sync();}
   catch(error){if(error.code!=='EEXIST')throw error;const stat=await lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||sha(await readFile(file))!==sha(body))fail('WORKFLOW_DELIVERY_CONFLICT','暂存文件不匹配，保留现场，未覆盖。');}
   finally{await handle?.close();}
  }
  await verify(staging,bundle.files);
  if(await revalidate()!==bundle.identity)fail('WORKFLOW_DELIVERY_STALE','落盘期间来源、采用稿或回执变化，暂存保留但未发布。');
  await rename(staging,target);await verify(target,bundle.files);return {identity:bundle.identity,directory:target,reused:false};
 }finally{await lease.release();}
}
