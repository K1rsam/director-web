import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {productionUsage} from '../runtime/production-budget.mjs';
import {digest} from '../runtime/storyboard-v4/core/shared.mjs';

export const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
export const fail=(code,message)=>{throw Object.assign(new Error(message),{code,requestOutcome:'NOT_SENT'});};
const steps=new Set(['upstream','3007-ep1','3008-ep1','3007-ep2','3008-ep2']);

export function parseComparisonArgs(args){
 const result={mode:'prepare',directory:null,step:null,reviewFile:null};let selected=false;
 for(let i=0;i<args.length;i++){
  const flag=args[i],value=()=>{const next=args[++i];if(!next||next.startsWith('--'))fail('COMPARE_ARGS',`${flag} 缺少值`);return next;};
  if(flag==='--directory'){if(result.directory)fail('COMPARE_ARGS','directory不能重复');result.directory=value();continue;}
  if(!['--prepare-only','--status','--live-step','--record-review','--recover','--replay-upstream'].includes(flag))fail('COMPARE_ARGS',`不支持参数 ${flag}；没有 --live 或自动循环模式。`);
  if(selected)fail('COMPARE_ARGS','操作模式互斥，一次只能选择一个动作。');selected=true;
  result.mode=({'--prepare-only':'prepare','--status':'status','--live-step':'live','--record-review':'review','--recover':'recover','--replay-upstream':'replay'})[flag];
  if(flag==='--replay-upstream')result.step='upstream';
  if(flag==='--live-step'){result.step=value();if(!steps.has(result.step))fail('COMPARE_ARGS','live-step动作无效。');}
  if(flag==='--record-review')result.reviewFile=value();
 }
 if(result.mode!=='prepare'&&!result.directory)fail('COMPARE_ARGS','续接必须显式给出已有 --directory，不自动挑选最新目录。');
 return result;
}

export function assertNoUnknownUsage(ledger){
 if(ledger.summary.unknownAttempts)fail('COMPARE_USAGE_UNKNOWN','共享预算存在未知用量；先恢复已保存回执，不重试。');
 if(ledger.summary.inFlight)fail('COMPARE_IN_FLIGHT','共享预算存在在途请求；先核对其结果，不新派单。');
}
export function canCloseRecoveredStep({ledger,workflow,runs}){
 return !workflow.activeAction&&!ledger.summary.unknownAttempts&&!ledger.summary.inFlight&&runs.every(run=>!(run.operations??[]).some(op=>['running','unknown'].includes(op.status)));
}
export function isComparisonRunComplete(run,{chainComplete=true}={}){
 return Boolean(run&&chainComplete&&run.status==='text_ready_for_review'&&run.assembly?.text&&run.assembly?.validation?.errors?.length===0&&!run.production?.blocking&&!run.production?.pendingRepair&&!['unknown','usage_review','failed','stopped','source_stale','budget_stop'].includes(run.web?.progress));
}
const count=n=>Number.isSafeInteger(n)&&n>=0;
const timestamp=value=>typeof value==='string'?Date.parse(value):NaN;
export function upstreamRequestFingerprint(id,request){return hash({id,at:request.at,actionId:request.actionId,payload:request.payload});}
/** Only the CLI transport event is evidence. Never parse data/rawOutput as usage. */
export function captureUpstreamNativeUsage(result){
 const usage=productionUsage('CLI',{stdout:result?.stdout});
 if(usage.totalTokens===null)return {usage,nativeUsage:null};
 const event=result.stdout.split(/\r?\n/).map(line=>{try{return JSON.parse(line);}catch{return null;}}).findLast(value=>value?.type==='turn.completed');
 return {usage,nativeUsage:{schema:'CODEX_TURN_COMPLETED_USAGE_V1',eventHash:hash(event),usage:{input_tokens:event.usage.input_tokens,output_tokens:event.usage.output_tokens,...(event.usage.cached_input_tokens===undefined?{}:{cached_input_tokens:event.usage.cached_input_tokens})}}};
}
/** Produce a free, fully checked reconciliation plan before writing any ledger entry. */
export function planUpstreamUsageRecovery({records,ledger,projectId,actionIds}){
 const entries=[],skipped=[],seenRecords=new Map(),boundAttempts=new Map();
 for(const record of records){
  const {id,request,response}=record,recordHash=hash(record);
  if(seenRecords.has(id)){
   if(seenRecords.get(id)!==recordHash)fail('COMPARE_USAGE_CONFLICT','同一上游回执出现冲突版本，未追加任何用量。');
   continue;
  }
  seenRecords.set(id,recordHash);
  const skip=reason=>skipped.push({id,reason});
  if(typeof id!=='string'||!/^upstream-[A-Za-z0-9_-]+$/.test(id)||!request?.payload||!response||!actionIds.includes(request.actionId)){skip('REQUEST_BINDING_UNVERIFIED');continue;}
  const ids=response.ledgerAttemptIds;
  if(!Array.isArray(ids)||ids.length!==1||typeof ids[0]!=='string'){skip('AMBIGUOUS_ATTEMPTS');continue;}
  const matches=ledger.attempts.filter(attempt=>attempt.id===ids[0]),attempt=matches[0],payload=request.payload;
  if(matches.length!==1||attempt.projectId!==projectId||payload.projectId!==projectId||payload.provider!=='CLI'||attempt.provider!=='CLI'||attempt.runId!=null||attempt.stage!==payload.stage||attempt.model!==payload.model){skip('ATTEMPT_BINDING_UNVERIFIED');continue;}
  const start=timestamp(request.at),sent=timestamp(attempt.startedAt),end=timestamp(response.finishedAt);
  if(!Number.isFinite(start)||!Number.isFinite(sent)||!Number.isFinite(end)||sent<start||sent>end||!['RESPONDED','UNKNOWN'].includes(response.status)){skip('RECEIPT_OUTCOME_UNVERIFIED');continue;}
  // Legacy outer usage was written by productionUsage(CLI, roleResult), not by the model.
  // It remains recoverable only with this unique request/attempt/metadata/time-window binding.
  const totalTokens=response.usage?.totalTokens;
  if(!count(totalTokens)){skip('NATIVE_USAGE_UNKNOWN');continue;}
  const fingerprint=upstreamRequestFingerprint(id,request);
  if(response.schema!==undefined){
   if(response.schema!=='THREE_STAGE_UPSTREAM_RESPONSE_V1'||response.budgetId!==ledger.id||request.requestFingerprint!==fingerprint||response.requestFingerprint!==fingerprint||response.usageProvenance!=='ROLE_RUNNER_NATIVE_SUMMARY_V1'){skip('REQUEST_FINGERPRINT_UNVERIFIED');continue;}
   const native=response.nativeUsage,u=native?.usage;
   if(native?.schema!=='CODEX_TURN_COMPLETED_USAGE_V1'||!/^[a-f0-9]{64}$/.test(native.eventHash??'')||!count(u?.input_tokens)||!count(u?.output_tokens)||!count(u.input_tokens+u.output_tokens)||u.input_tokens+u.output_tokens!==totalTokens||u.cached_input_tokens!==undefined&&(!count(u.cached_input_tokens)||u.cached_input_tokens>u.input_tokens)){skip('NATIVE_USAGE_UNVERIFIED');continue;}
  }else if(request.requestFingerprint!==undefined||response.requestFingerprint!==undefined||response.nativeUsage!==undefined){skip('RECEIPT_VERSION_UNVERIFIED');continue;}
  const previous=ledger.reconciliations?.findLast(row=>row.attemptId===attempt.id),known=previous?.totalTokens??attempt.totalTokens;
  if(count(known)&&known!==totalTokens)fail('COMPARE_USAGE_CONFLICT','上游原生用量与账本已有值冲突，历史未覆盖。');
  if(boundAttempts.has(attempt.id)&&boundAttempts.get(attempt.id)!==fingerprint)fail('COMPARE_USAGE_CONFLICT','多个上游请求指向同一预算派单，不能重复记账。');
  boundAttempts.set(attempt.id,fingerprint);
  entries.push({attemptId:attempt.id,totalTokens,evidenceHash:hash({id,request,response,requestFingerprint:fingerprint}),requestFingerprint:fingerprint,provenance:response.schema?'NATIVE_EVENT_WITH_REQUEST_FINGERPRINT':'LEGACY_HARNESS_NATIVE_SUMMARY'});
 }
 return {entries,skipped};
}
/** A receipt path alone is not proof: bind it to the stored run operation and exact request. */
export function storyboardUsageRecoveryEntry({attempt,request,receipt,run}){
 if(!run||attempt.runId!==run.id||attempt.projectId!==run.web?.binding?.projectId||attempt.provider!=='CLI'||attempt.model!==request?.settings?.model||receipt?.state!=='FINAL'||receipt.requestOutcome!=='RESPONDED'||typeof request?.prompt!=='string'||typeof request?.instructions!=='string')return null;
 const operations=(run.operations??[]).filter(op=>op.attemptId===attempt.id),op=operations[0];
 if(operations.length!==1||op.stage!==request.stage||![`3007:${request.stage}`,`stage3:${request.stage}`].includes(attempt.stage)||request.promptHash!==digest(request.prompt)||request.instructionHash!==digest(request.instructions)||op.fingerprint!==digest([request.promptHash,request.instructionHash,request.inputHash]))return null;
 const totalTokens=productionUsage('CLI',{usage:receipt.usage}).totalTokens;
 if(!count(totalTokens))return null;
 return {attemptId:attempt.id,totalTokens,evidenceHash:hash({request,receipt,operationFingerprint:op.fingerprint,runId:run.id})};
}
export function assertCampaignBinding(current,requested){
 if(current&&requested&&current!==requested)fail('COMPARE_CAMPAIGN_EXISTS','同一对照已绑定一个隔离目录/共享预算；不能另开目录重置40次停止线。');
 return current??requested;
}
export function suppressGeneratedPrismaEnv(source){
 const shape=/"relativeEnvPaths"\s*:\s*\{[^}]*\}/g;
 if([...source.matchAll(shape)].length!==1)fail('COMPARE_PRISMA_ENV','无法安全识别Prisma生成客户端的环境文件路径，停止而不读取凭据。');
 return source.replace(shape,'"relativeEnvPaths":{"rootEnvPath":null,"schemaEnvPath":null}');
}

export function assertReview(review,runs){
 if(review?.schema!=='THREE_STAGE_QUALITY_REVIEW_V1'||review.episodeNumber!==1||typeof review.reviewer!=='string'||!review.reviewer.trim()||typeof review.note!=='string'||!review.note.trim()||review.note.length>4000||review.authorReviewed!==true||review.assemblyReviewed!==true||review.majorIssuesResolved!==true)fail('COMPARE_QUALITY_REVIEW','须提供真实代理复核记录，包含主创、整编、主要问题已解决及非空说明。');
 for(const side of ['3007','3008'])if(!runs[side]?.complete||!runs[side].fingerprint||review.fingerprints?.[side]!==runs[side].fingerprint)fail('COMPARE_REVIEW_STALE','双侧首集版本与质量复核不匹配。');
}
export function assertEpisodeGate(episode,runs,review){
 if(episode!==2)return;
 if(!['3007','3008'].every(side=>runs[side]?.complete))fail('COMPARE_EP1_REQUIRED','第二集须等两侧第一集都完成，不能跳过。');
 assertReview(review,runs);
}
export function chooseComparisonAction(step,nextAction,{costAcknowledged=false}={}){
 if(nextAction.kind==='WAIT_COST_CONFIRM'&&costAcknowledged)return chooseComparisonAction(step,nextAction.proposedAction);
 if(nextAction.kind.startsWith('WAIT_')||['QUALITY_CHECK','NEED_UPSTREAM','COMPLETE'].includes(nextAction.kind))return nextAction;
 if(step==='upstream'&&['STAGE1','DIRECTION','ASSETS'].includes(nextAction.kind))return nextAction;
 const match=/^3008-ep([12])$/.exec(step);
 if(match&&nextAction.episodeNumber===Number(match[1])&&['STORYBOARD_CREATE','STORYBOARD_CONTINUE'].includes(nextAction.kind))return nextAction;
 fail('COMPARE_ACTION_SCOPE',`所请求动作 ${step} 与工作流下一步 ${nextAction.kind}/EP${nextAction.episodeNumber??'-'} 不匹配。`);
}
export function assertSharedSettings(actual,expected){
 for(const key of ['model','reasoning','maxUnitSeconds','maxUnits','fantasyMode','visualStyle'])if(!isDeepStrictEqual(actual?.[key],expected[key]))fail('COMPARE_SETTINGS',`共同设置 ${key} 不一致，未派单。`);
}

/** Diagnostic character accounting, never a tokenizer or a mandate to drop duplicate evidence. */
export function inspectPayload(value){
 const serialized=JSON.stringify(value),total=serialized.length,fields=[],strings=new Map();
 const walk=(current,path,depth)=>{
  if(typeof current==='string'&&current.length>=24){const key=hash(current),entry=strings.get(key)??{hash:key,chars:current.length,paths:[]};entry.paths.push(path);strings.set(key,entry);}
  if(!current||typeof current!=='object')return;
  for(const [key,item] of Object.entries(current)){
   const child=Array.isArray(current)?`${path}[${key}]`:`${path}.${key}`;
   if(depth<2){const chars=JSON.stringify(item)?.length??0;fields.push({path:child,serializedChars:chars,shareOfSerialized:total?Number((chars/total).toFixed(6)):0});}
   walk(item,child,depth+1);
  }
 };
 walk(value,'$',0);
 return {unit:'UTF16_CHARS_NOT_TOKENS',serializedChars:total,serializedHash:hash(serialized),fields,
  exactDuplicateStrings:[...strings.values()].filter(row=>row.paths.length>1).map(row=>({...row,repeatedChars:row.chars*(row.paths.length-1)})),
  note:'字段比重存在父子重叠，不能相加；同字符串重复不等于可删，跨字段的证据用途须单独核对。'};
}
export function inspectWireRequest(request){
 const texts={prompt:request.prompt??'',instructions:request.instructions??'',schema:request.schema?JSON.stringify(request.schema):''};
 const total=Object.values(texts).reduce((n,text)=>n+text.length,0);
 const parts=Object.fromEntries(Object.entries(texts).map(([key,text])=>[key,{chars:text.length,hash:hash(text),shareOfTextChars:total?text.length/total:0}]));
 const marker='【生效设置与本次完整资料】\n',start=texts.prompt.lastIndexOf(marker);let actualInput=null;
 if(start>=0){const offset=start+marker.length,line=texts.prompt.slice(offset).split('\n')[0];try{actualInput={...inspectPayload(JSON.parse(line)),promptCharStart:offset,promptCharEnd:offset+line.length};}catch{/* Unknown prompt form is retained verbatim, never guessed or simplified. */}}
 const repeated=new Map();
 for(const [part,text] of Object.entries(texts)){let offset=0;for(const line of text.split('\n')){if(line.length>=24){const digest=hash(line),entry=repeated.get(digest)??{hash:digest,chars:line.length,locations:[]};entry.locations.push({part,start:offset,end:offset+line.length});repeated.set(digest,entry);}offset+=line.length+1;}}
 return {unit:'UTF16_CHARS_NOT_TOKENS',textChars:total,parts,actualInput,exactDuplicateLines:[...repeated.values()].filter(row=>row.locations.length>1),note:'仅统计实际prompt/instructions/schema，不计request.json中的诊断副本。JSON字段可在给出的prompt区间定位；不代表Token或费用节省。'};
}
export function sourceDifference(original,current){
 const a=original.split(/\r\n|\r|\n/),b=current.split(/\r\n|\r|\n/);let prefix=0;
 while(prefix<a.length&&prefix<b.length&&a[prefix]===b[prefix])prefix++;
 let suffix=0;while(suffix<a.length-prefix&&suffix<b.length-prefix&&a[a.length-1-suffix]===b[b.length-1-suffix])suffix++;
 return {originalHash:hash(original),currentHash:hash(current),originalChars:original.length,currentChars:current.length,exactEqual:original===current,
  nonBlankLinesEqual:isDeepStrictEqual(a.filter(line=>line.trim()),b.filter(line=>line.trim())),
  firstDifference:original===current?null:{originalLine:prefix+1,currentLine:prefix+1,originalEndLine:a.length-suffix,currentEndLine:b.length-suffix},
  note:'差异仅作来源定位；不凭去空白后的相等替代逐字同稿断言。'};
}
