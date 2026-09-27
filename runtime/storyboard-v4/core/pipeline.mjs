import {randomUUID} from 'node:crypto';
import {VERSION,digest,fail} from './shared.mjs';
import {normalizeSource} from './source.mjs';
import {normalizeSettings,normalizePlan,defaultChoice,captureRules,buildRequest} from './core.mjs';
import {confirmSelection,resolveSelection,rebaseSelection} from './selection.mjs';
import {normalizeDraft,validateDraft,renderDraft} from './quality.mjs';
import {createStore} from './store.mjs';
import {runModel,readCompletedAttempt} from './runner.mjs';
import {applyDelta,baseDraftHash} from './delta.mjs';

const identity=r=>digest([r.promptHash,r.instructionHash,r.inputHash]);
const validAttempt=id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
const ids=(d,o)=>o.stage==='plan'?[]:(o.packageIds||[o.packageId]);
const overlap=(a,b)=>a.some(x=>b.includes(x));
const errorRecord=(e,outcome=e.requestOutcome||'UNKNOWN')=>({code:e.code||'RUNNER_ERROR',message:e.message,requestOutcome:outcome});
export const PLAN_VALIDATION_VERSION='plan-citations-v1';
const invalidate=(d,status)=>{d.assembly=null;d.status=status;};
export const isUnresolvedOperation=o=>o.status==='running'||(o.status==='unknown'&&o.cancelAcknowledgement?.acceptUnknownUsage!==true);
const attentionStatus=d=>d.operations.some(o=>o.epoch===d.epoch&&o.status==='running')?'running':d.operations.some(o=>o.status==='unknown'&&isUnresolvedOperation(o))?'unknown':null;
const requestOf=(d,stage,packageIds,previousDraft,issues=[],format='continuity-v1',finishMode='full')=>{
 const external=new Set(packageIds.flatMap(id=>d.plan?.workPackages.find(w=>w.id===id)?.dependsOn||[]).filter(id=>!packageIds.includes(id)));
 const rank=new Map(d.source.sourceRows.map((row,i)=>[row.id,i]));
 const dependencyExits=format==='legacy'?Object.fromEntries(d.adopted.filter(a=>a.packageIds.some(id=>external.has(id))).map(a=>[a.packageIds.join('+'),a.draft.units.map(u=>u.exitState)])):Object.fromEntries([...external].map(id=>{
  const refs=new Set(d.plan.workPackages.find(w=>w.id===id).sourceRefs),adopted=d.adopted.find(a=>a.packageIds.includes(id));
  const relevant=adopted?.draft.units.filter(u=>u.shots.some(s=>s.sourceRefs.some(ref=>refs.has(ref))))||[];
  const last=relevant.sort((a,b)=>Math.max(...a.shots.flatMap(s=>s.sourceRefs.filter(ref=>refs.has(ref)).map(ref=>rank.get(ref)??-1)))-Math.max(...b.shots.flatMap(s=>s.sourceRefs.filter(ref=>refs.has(ref)).map(ref=>rank.get(ref)??-1)))).at(-1);
  if(!last)fail('DEPENDENCY_EXIT',`依赖工作包${id}缺少可定位的出口单元`);
  return [id,{unitId:last.id,scene:last.scene,lighting:last.lighting,props:last.props,participants:last.participants,exitState:last.exitState}];
 }));
 return buildRequest({stage,source:d.source,settings:d.settings,plan:d.plan,choice:d.choice,packageId:packageIds[0],packageIds,previousDraft,voiceReference:d.voiceReference,rulesSnapshot:d.rulesSnapshot,dependencyExits,issues,finishMode});
};
const currentRequest=(d,op)=>requestOf(d,op.stage,op.packageIds,op.previousDraft,op.issues,op.dependencyFormat||'legacy',op.finishMode||'full');
function assertGroupScope(d,packageIds){
 if(d.adopted.some(a=>overlap(a.packageIds,packageIds)&&a.packageIds.some(id=>!packageIds.includes(id))))fail('GROUP_SCOPE','已采用关联组须一起重写');
 if(d.candidates.some(c=>c.status==='needs_dependency_repair'&&!c.resolvedBy&&overlap(c.requiredPackageIds,packageIds)&&c.requiredPackageIds.some(id=>!packageIds.includes(id))))fail('GROUP_SCOPE','依赖返修须包含完整扩大范围');
}
function scopeCheck(d,stage,packageIds){
 if(stage==='plan'){if(d.operations.some(isUnresolvedOperation))fail('SCOPE_BUSY','整集计划仍有未结操作');return;}
 if(d.operations.some(o=>o.stage==='plan'&&isUnresolvedOperation(o)))fail('SCOPE_BUSY','整集计划仍有未结操作');
 if(!d.plan)fail('PLAN_REQUIRED','请先完成整集计划');
 if(!packageIds.length||new Set(packageIds).size!==packageIds.length||packageIds.some(id=>!d.plan.workPackages.some(w=>w.id===id)))fail('PACKAGE','工作包不存在或重复');
 assertGroupScope(d,packageIds);
 for(const id of packageIds){const w=d.plan.workPackages.find(x=>x.id===id);for(const dep of w.dependsOn)if(!d.adopted.some(a=>a.packageIds.includes(dep)))fail('DEPENDENCY_NOT_READY',`依赖工作包${dep}尚未成稿`);}
 if(d.operations.some(o=>o.stage!=='plan'&&isUnresolvedOperation(o)&&overlap(o.packageIds,packageIds)))fail('SCOPE_BUSY','同范围仍有未结作业');
 if(stage==='finish'&&packageIds.some(id=>!d.adopted.some(a=>a.packageIds.includes(id))&&!d.candidates.some(c=>c.packageIds.includes(id)&&c.status==='needs_repair'&&c.raw)))fail('AUTHOR_REQUIRED','请先形成工作包初稿或待修候选');
}
function previousOf(d,packageIds){
 const entries=d.adopted.filter(a=>overlap(a.packageIds,packageIds));
 if(entries.some(a=>a.packageIds.some(id=>!packageIds.includes(id))))fail('GROUP_SCOPE','关联组须一起返修');
 const rank=new Map(d.source.sourceRows.map((row,i)=>[row.id,i]));
 const units=entries.flatMap(a=>a.draft.units).sort((a,b)=>Math.min(...a.shots.flatMap(s=>s.sourceRefs.map(ref=>rank.get(ref)??Infinity)))-Math.min(...b.shots.flatMap(s=>s.sourceRefs.map(ref=>rank.get(ref)??Infinity))));
 const seen=new Set(),supplementalCandidates=[];
 for(const c of d.candidates.toReversed())if(['needs_repair','needs_dependency_repair'].includes(c.status)&&!c.resolvedBy&&overlap(c.packageIds,packageIds)&&c.packageIds.some(id=>packageIds.includes(id)&&!seen.has(id))){for(const id of c.packageIds)seen.add(id);supplementalCandidates.push({packageIds:c.packageIds,status:c.status,...(c.draft?{draft:c.draft}:{rawText:c.raw})});}
 supplementalCandidates.reverse();
 if(entries.length)return {schemaVersion:VERSION,units,fantasyRealization:entries.flatMap(a=>a.draft.fantasyRealization),...(supplementalCandidates.length?{supplementalCandidates}:{})};
 if(supplementalCandidates.length)return {rawText:supplementalCandidates.map(c=>c.rawText||JSON.stringify(c.draft)).join('\n\n'),supplementalCandidates};
 fail('AUTHOR_REQUIRED','缺少待修初稿');
}
function groups(d,packageIds,draft){
 const owners=new Map(d.plan.workPackages.flatMap(w=>w.sourceRefs.map(ref=>[ref,w.id]))),parent=new Map(packageIds.map(id=>[id,id]));
 const root=id=>{while(parent.get(id)!==id)id=parent.get(id);return id;};
 for(const u of draft.units){const touched=[...new Set(u.shots.flatMap(s=>s.sourceRefs||[]).map(ref=>owners.get(ref)).filter(Boolean))];if(!touched.length||touched.some(id=>!parent.has(id)))fail('GROUP_SCOPE','候选单元缺少本次范围源或引用范围外源');for(const id of touched.slice(1))parent.set(root(id),root(touched[0]));}
 const result=new Map();for(const id of packageIds){const key=root(id);result.set(key,[...(result.get(key)||[]),id]);}
 return [...result.values()].map(group=>{const refs=new Set(group.flatMap(id=>d.plan.workPackages.find(w=>w.id===id).sourceRefs));const units=draft.units.filter(u=>u.shots.some(s=>s.sourceRefs.some(ref=>refs.has(ref))));const unitIds=new Set(units.map(u=>u.id));return {packageIds:group,draft:{schemaVersion:VERSION,units,fantasyRealization:draft.fantasyRealization.filter(f=>f.unitIds?.some(id=>unitIds.has(id)))}};});
}
function adopt(d,candidate,{recovery=false}={}){
 const op=d.operations.find(o=>o.attemptId===candidate.attemptId);
 if(op.epoch!==d.epoch&&!recovery){candidate.status='cancelled_late';return;}
 try{if(op.stage!=='plan')assertGroupScope(d,op.packageIds);}catch(e){candidate.status='stale';candidate.errors=[errorRecord(e)];return;}
 let actual;try{actual=currentRequest(d,op);}catch(e){candidate.status='stale';candidate.errors=[errorRecord(e)];return;}
 if(identity(actual)!==op.fingerprint){candidate.status='stale';return;}
 if(op.stage==='plan'){
  candidate.validatorVersion=PLAN_VALIDATION_VERSION;
  try{const next=normalizePlan(candidate.output,d.source,{unitPackingPolicy:d.rulesSnapshot.unitPackingPolicy});
   candidate.normalizations=next.entryFacts.flatMap((f,i)=>JSON.stringify(f.evidence)===JSON.stringify(candidate.output.entryFacts[i].evidence)?[]:[{coordinate:f.id,field:'evidence',from:candidate.output.entryFacts[i].evidence??null,to:f.evidence,action:f.evidenceMode==='source_rows'?'extract_source':'verified_segments'}]);
   d.choice=d.plan?rebaseSelection(d.plan,next,d.choice):d.choice;d.plan=next;d.adopted=[];candidate.status='adopted';for(const prior of d.candidates)if(prior!==candidate&&prior.stage==='plan'&&prior.status==='needs_repair'&&!prior.resolvedBy)prior.resolvedBy=candidate.id;invalidate(d,'planned');}catch(e){candidate.status='needs_repair';candidate.errors=[errorRecord(e,'RESPONDED')];}
  return;
 }
 try{
  if(op.finishMode==='delta'&&baseDraftHash(previousOf(d,op.packageIds))!==op.baseDraftHash){candidate.status='stale';return;}
  const output=op.finishMode==='delta'?applyDelta(op.previousDraft,candidate.output):candidate.output;
  const {draft,changes}=normalizeDraft(output,actual.source,{plan:actual.plan,settings:actual.settings,unitPackingPolicy:d.rulesSnapshot.unitPackingPolicy,stage:op.stage});candidate.draft=draft;candidate.normalizations=changes;
  const check=validateDraft({draft,source:actual.source,settings:d.settings,selection:actual.selection,plan:d.plan});candidate.validation=check;
  if(check.errors.length){candidate.status='needs_repair';return;}
  const next=groups(d,op.packageIds,draft);
  const outside=d.plan.workPackages.filter(w=>!op.packageIds.includes(w.id)&&w.dependsOn.some(id=>op.packageIds.includes(id))&&d.adopted.some(a=>a.packageIds.includes(w.id)));
  const old=d.adopted.filter(a=>overlap(a.packageIds,op.packageIds));
  const changed=old.some(a=>a.draft.units.some(u=>{const revised=next.flatMap(n=>n.draft.units).find(v=>v.id===u.id);return revised?.exitState!==u.exitState||revised?.initialState!==u.initialState;}));
  if(changed&&outside.length){candidate.status='needs_dependency_repair';candidate.requiredPackageIds=[...new Set([...op.packageIds,...outside.map(w=>w.id)])];return;}
  d.adopted=d.adopted.filter(a=>!overlap(a.packageIds,op.packageIds));
  d.adopted.push(...next.map(n=>({...n,candidateId:candidate.id,stage:op.stage})));
  for(const prior of d.candidates)if(prior!==candidate&&!prior.resolvedBy&&((prior.status==='needs_dependency_repair'&&prior.requiredPackageIds.every(id=>op.packageIds.includes(id)))||(prior.status==='needs_repair'&&prior.packageIds.every(id=>op.packageIds.includes(id)))))prior.resolvedBy=candidate.id;
  candidate.status='adopted';d.status='drafting';
 }catch(e){candidate.status='needs_repair';candidate.errors=[errorRecord(e,'RESPONDED')];}
}

export function createEngine({directory,modelRunner=runModel,runnerOptions={}}){
 const store=createStore(directory),controllers=new Map();
 async function settle(id,attemptId,result,error){
  return store.update(id,d=>{const op=d.operations.find(o=>o.attemptId===attemptId);if(!op)fail('ATTEMPT','作业不存在');
   if(op.status==='completed')return d;
   const raw=result?.raw??error?.raw??null;op.status=error?.requestOutcome==='UNKNOWN'?'unknown':'completed';op.error=error?errorRecord(error):null;
   op.localSettledAt=new Date().toISOString();op.receipt={requestOutcome:result?.requestOutcome||error?.requestOutcome||'RESPONDED',usage:result?.usage||error?.usage||null};
   let c;if(result?.output!==undefined||raw){c={id:randomUUID(),attemptId,stage:op.stage,packageIds:op.packageIds,raw,output:result?.output??null,status:'received',receipt:op.receipt};d.candidates.push(c);if(op.epoch!==d.epoch)c.status='cancelled_late';else if(c.output===null){c.status='needs_repair';c.errors=[errorRecord(error||{code:'INVALID_JSON',message:'响应不是合法JSON'})];}else adopt(d,c);}
   if(op.epoch!==d.epoch)return d;
   d.status=attentionStatus(d)||(c?c.status==='adopted'?d.status:c.status:error?'failed':d.status);
   return d;
  });
 }
 return {
  async create({id,source,settings,voiceReference=null}){const normalized=normalizeSource(source),effective=normalizeSettings(settings);if(normalized.diagnostics.length)fail('SOURCE_DIAGNOSTICS','源材料有未处理歧义');return store.create(id,{version:VERSION,id,source:normalized,settings:effective,voiceReference,rulesSnapshot:captureRules(),rulesHistory:[],plan:null,choice:defaultChoice(effective.fantasyMode),operations:[],candidates:[],adopted:[],epoch:0,status:'created'});},
  read:id=>store.read(id),
  async execute(id,{stage,packageId,packageIds,attemptId=randomUUID(),issues=[],finishMode='full'}={}){
   if(!['plan','author','finish'].includes(stage))fail('STAGE','未知作业阶段');
   if(!['full','delta'].includes(finishMode))fail('FINISH_MODE','整编模式无效');
   if(!validAttempt(attemptId))fail('INVALID_ATTEMPT','作业编号无效');
   const chosen=stage==='plan'?[]:packageIds||[packageId];let request;
   if(stage==='author'&&chosen.length!==1)fail('PACKAGE','初稿每次只写一个完整工作包');
   await store.update(id,d=>{if(d.web?.stopped||d.web?.pauseRequested)throw Object.assign(new Error('任务已停止派发'),{code:'RUN_PAUSED',requestOutcome:'NOT_SENT'});if(d.operations.some(o=>o.attemptId===attemptId))fail('ATTEMPT_EXISTS','已有同编号作业');scopeCheck(d,stage,chosen);
    const previousPlan=stage==='plan'&&issues.length?d.candidates.findLast(c=>c.stage==='plan'&&c.status==='needs_repair'&&!c.resolvedBy&&c.raw):null;
    const previousDraft=stage==='finish'?previousOf(d,chosen):previousPlan?{rawText:previousPlan.raw,previousPlan:previousPlan.output}:null;
    request=requestOf(d,stage,chosen,previousDraft,issues,'continuity-v1',finishMode);
    invalidate(d,'running');d.operations.push({attemptId,stage,packageIds:chosen,previousDraft,issues,finishMode:request.finishMode,baseDraftHash:request.baseDraftHash||null,dependencyFormat:'continuity-v1',fingerprint:identity(request),epoch:d.epoch,status:'running',createdAt:new Date().toISOString()});return d;});
   const controller=new AbortController();controllers.set(attemptId,controller);
   try{const result=await modelRunner(request,{directory,attemptId,runId:id,signal:controller.signal,...runnerOptions});return await settle(id,attemptId,result,null);}
   catch(error){await settle(id,attemptId,null,error);throw error;}
   finally{controllers.delete(attemptId);}
  },
  async setChoice(id,choice){return store.update(id,d=>{if(!d.plan)fail('PLAN_REQUIRED','先完成计划');if(choice.mode!==d.settings.fantasyMode)fail('SETTINGS_SELECTION','模式不能被模型或局部选择改写');resolveSelection(d.plan,choice);d.choice=structuredClone(choice);invalidate(d,'planned');return d;});},
  async confirmChoice(id,selectedIds,expectedFingerprint){return store.update(id,d=>{if(!d.plan)fail('PLAN_REQUIRED','先完成计划');d.choice=confirmSelection(d.plan,d.choice,selectedIds,expectedFingerprint);invalidate(d,'planned');return d;});},
  async setFantasyMode(id,mode){return store.update(id,d=>{d.settings=normalizeSettings({...d.settings,fantasyMode:mode});d.choice=defaultChoice(mode);invalidate(d,d.plan?'planned':'created');return d;});},
  async refreshRules(id){return store.update(id,d=>{if(d.operations.some(isUnresolvedOperation))fail('RULES_BUSY','有未结作业时不能刷新规则');const oldHash=digest(d.rulesSnapshot),next=captureRules(),newHash=digest(next);if(d.plan&&(d.rulesSnapshot.outputSchemaVersion!==next.outputSchemaVersion||d.rulesSnapshot.unitPackingPolicy!==next.unitPackingPolicy))fail('RULES_PROTOCOL_CHANGE','已有规划不能直接换用不同输出协议；原稿保留，请用新任务测试新版本。');d.rulesSnapshot=next;d.rulesHistory=[...(d.rulesHistory||[]),{at:new Date().toISOString(),oldHash,newHash}];invalidate(d,d.plan?'planned':'created');return d;});},
  async cancel(id,{reason='cancel'}={}){const d=await store.update(id,d=>{d.epoch++;d.status='cancelled';for(const op of d.operations.filter(o=>o.status==='running')){op.cancelRequestedAt=new Date().toISOString();op.cancelReason=reason;}return d;});for(const o of d.operations.filter(o=>o.status==='running'))controllers.get(o.attemptId)?.abort();return d;},
  async recover(id,attemptId){if(!validAttempt(attemptId))fail('INVALID_ATTEMPT','作业编号无效');const before=await store.read(id),prior=before.operations.find(o=>o.attemptId===attemptId);if(!prior)fail('ATTEMPT','作业不存在');if(controllers.has(attemptId))fail('RUN_ACTIVE','本地作业尚未结束');
   if(prior.recovery?.epoch===before.epoch||(prior.status==='completed'&&!before.candidates.some(c=>c.attemptId===attemptId&&c.status==='cancelled_late')))return before;
   let result,error;
   try{result=await readCompletedAttempt({directory,attemptId});}
   catch(e){if(e.code==='INVALID_JSON')error=e;else if(e.code==='ATTEMPT_UNRESOLVED')return store.update(id,d=>{const op=d.operations.find(o=>o.attemptId===attemptId);if(op.status!=='completed')op.status='unknown';if(op.epoch===d.epoch)d.status=attentionStatus(d)||d.status;return d;});else throw e;}
   return store.update(id,d=>{const op=d.operations.find(o=>o.attemptId===attemptId);if(op.recovery?.epoch===d.epoch)return d;if(d.web?.sourceStale)fail('SOURCE_STALE','源版本已变化');
    if(d.operations.some(o=>o.attemptId!==attemptId&&isUnresolvedOperation(o)&&(op.stage==='plan'||o.stage==='plan'||overlap(op.packageIds,o.packageIds))))fail('RECOVERY_BUSY','同范围仍有其它未结作业，请先核对回执');
    const actual=currentRequest(d,op);if(identity(actual)!==op.fingerprint)fail('STALE_CANDIDATE','保存回包与当前源、规则或依赖不一致');
    const savedFingerprint=result?.requestFingerprint||error?.requestFingerprint;if(savedFingerprint&&savedFingerprint!==op.fingerprint)fail('ATTEMPT_CONFLICT','保存请求与作业指纹不一致');
    const original=d.candidates.findLast(c=>c.attemptId===attemptId),c={id:randomUUID(),attemptId,stage:op.stage,packageIds:op.packageIds,raw:result?.raw??error.raw,output:result?.output??null,status:'received',receipt:{requestOutcome:'RESPONDED',usage:result?.usage||error?.usage||null},recoveredAt:new Date().toISOString(),...(original?{derivedFrom:original.id}:{})};
    d.candidates.push(c);op.recovery={at:c.recoveredAt,epoch:d.epoch,candidateId:c.id,previousStatus:op.status};op.status='completed';
    if(c.output===null){c.status='needs_repair';c.errors=[errorRecord(error,'RESPONDED')];}else adopt(d,c,{recovery:true});
    d.status=attentionStatus(d)||(c.status==='adopted'?d.status:c.status);return d;});
  },
  async recheckCandidate(id,candidateId){return store.update(id,d=>{const original=d.candidates.find(c=>c.id===candidateId);if(!original)fail('CANDIDATE','候选不存在');if(original.output===null||original.output===undefined)fail('RECHECK_INPUT','候选没有可重校的结构化响应');const op=d.operations.find(o=>o.attemptId===original.attemptId);if(!op)fail('ATTEMPT','候选作业不存在');scopeCheck(d,original.stage,original.packageIds);const derived={id:randomUUID(),attemptId:original.attemptId,stage:original.stage,packageIds:original.packageIds,raw:original.raw,output:structuredClone(original.output),status:'received',receipt:original.receipt,derivedFrom:original.id};d.candidates.push(derived);invalidate(d,'rechecking');adopt(d,derived,{recovery:op.recovery?.epoch===d.epoch});if(['needs_repair','needs_dependency_repair'].includes(derived.status))d.status=derived.status;return d;});},
  async assemble(id){return store.update(id,d=>{if(!d.plan)fail('PLAN_REQUIRED','先完成计划');if(d.operations.some(isUnresolvedOperation)||d.candidates.some(c=>c.status==='needs_dependency_repair'&&!c.resolvedBy))fail('ASSEMBLY_BUSY','仍有未结作业或需联修的依赖范围');const all=new Set(d.plan.workPackages.map(w=>w.id)),covered=new Set(d.adopted.filter(a=>a.stage==='finish').flatMap(a=>a.packageIds));if([...all].some(id=>!covered.has(id)))fail('FINISH_REQUIRED','全部工作包完成整编后才能汇总');for(const a of d.adopted){const c=d.candidates.find(x=>x.id===a.candidateId),op=d.operations.find(x=>x.attemptId===c?.attemptId);try{if(!op||identity(currentRequest(d,op))!==op.fingerprint)fail('STALE_ADOPTION','已采用稿依赖的材料或选择已变更');}catch(e){if(e.code==='STALE_ADOPTION')throw e;fail('STALE_ADOPTION','已采用稿依赖的材料或选择已变更');}}const rank=new Map(d.source.sourceRows.map((r,i)=>[r.id,i]));const units=d.adopted.flatMap(a=>a.draft.units).sort((a,b)=>Math.min(...a.shots.flatMap(s=>s.sourceRefs.map(r=>rank.get(r)??Infinity)))-Math.min(...b.shots.flatMap(s=>s.sourceRefs.map(r=>rank.get(r)??Infinity))));const draft={schemaVersion:VERSION,units,fantasyRealization:d.adopted.flatMap(a=>a.draft.fantasyRealization)};const check=validateDraft({draft,source:d.source,settings:d.settings,selection:resolveSelection(d.plan,d.choice),plan:d.plan});d.assembly={draft,validation:check,text:renderDraft({draft,source:d.source,settings:d.settings})};d.status=check.errors.length?'needs_repair':'text_ready_for_review';return d;});}
 };
}
