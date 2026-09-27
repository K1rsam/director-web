import {parseScript,normalizeSource} from './core/source.mjs';
import {STYLE} from './core/core.mjs';
import {digest,fail} from './core/shared.mjs';
import {resolveSelection} from './core/selection.mjs';
import {validateEpisodeSourceContext} from './source-context.mjs';

export function makeEpisodeInput({episode,project,handoff=null,notes='',independentSource=null}){
 if(!episode?.id||!episode.content?.trim()||episode.projectId!==project?.id)fail('SOURCE_EMPTY','本集没有可用原文或项目归属不符');
 if(typeof notes!=='string'||notes.length>4000)fail('NOTES_LIMIT','导演要求最多4000字');
 const independent=independentSource?validateEpisodeSourceContext(independentSource,episode):null;
 const warnings=independent?['独立局部原剧本：前情单独提供；不继承本项目相邻集或旧资产，不含样稿分镜答案。']:[...(handoff?.reasons||[])];
 let packet=independent?{scenes:[{heading:independent.scene}]}:handoff?.packet;
 if(packet?.sourceText!==undefined&&packet.sourceText!==episode.content){warnings.push('交接资料与当前原文不一致，本次不沿用其中的旧资产与前情。');packet=null;}
 const previous=packet?.boundaryContext?.previousSource;
 const contextRows=independent?independent.contextRows:previous?.text?previous.text.split(/\r\n|\n|\r/).map((text,i)=>({id:`previous-${previous.episode}:excerpt-${i+1}`,text,kind:'context'})):[];
 const assets=packet?.assets||[];
 const continuity={previousSource:previous?{...previous,text:undefined}:null,priorStates:packet?.boundaryContext?.priorStates||[],gaps:packet?.boundaryContext?.gaps||[],rule:'前情与资产是有来源的线索，不无条件继承状态；以本集原文的最新变化为准。'};
 const context={projectStyle:project.style||null,aspectRatio:project.aspectRatio||'16:9',directorNotes:notes,scenes:packet?.scenes||[],continuity,followUps:packet?.followUps||[],sourceWarnings:[...new Set(warnings)],materialDependencies:packet?.materialDependencies||[],...(independent?{independentFragment:true,sourceOrigin:independent.origin,creationScope:'仅本集sourceRows是当前制作正文；contextRows只是此前已发生的原文依据，不补拍前情，不接续测试项目的相邻集。'}:{})};
 const parsed=parseScript(episode.content,{key:episode.id,title:episode.title||`第${episode.number}集`,context,contextRows});
 const source=independent?normalizeSource({...parsed,entryFacts:independent.entryFacts}):parsed;
 source.assets=assets;
 const sourceVersion=digest({content:episode.content,style:project.style,aspectRatio:project.aspectRatio,assets,contextRows,scenes:context.scenes,continuity,followUps:context.followUps,...(independent?{independentSource:independent}:{})});
 const visualStyle=project.style?.trim()?`项目风格：${project.style}；画幅${project.aspectRatio||'16:9'}。角色身份、衣发与道具保持一致。表演、声画和纵深服务本段情绪；无额外字幕、水印、logo、BGM，源剧情必要屏幕信息保留。`:STYLE;
 return {source,sourceVersion,visualStyle,warnings:[...new Set(warnings)],readiness:independent?'INDEPENDENT_FRAGMENT':handoff?.readiness||'SOURCE_ONLY'};
}

export function publicRun(d,{active=false,sourceStale=false,cancellations=[]}={}){
 const operations=d.operations||[],candidates=d.candidates||[];
 const usage={inputTokens:0,outputTokens:0,cachedInputTokens:0,totalTokens:0,complete:true};
 const perAttempt=new Map();
 for(const c of candidates)if(c.receipt?.usage)perAttempt.set(c.attemptId,c.receipt.usage);
 for(const op of operations)if(!perAttempt.has(op.attemptId)&&op.receipt?.usage)perAttempt.set(op.attemptId,op.receipt.usage);
 for(const op of operations){const u=perAttempt.get(op.attemptId);if(!u){if(op.error?.requestOutcome!=='NOT_SENT')usage.complete=false;continue;}for(const key of Object.keys(usage).filter(k=>k!=='complete'))if(Number.isFinite(u[key]))usage[key]+=u[key];else usage.complete=false;}
 usage.knownTokens=usage.totalTokens;
 usage.unknownAttempts=operations.filter(op=>op.error?.requestOutcome!=='NOT_SENT'&&!Number.isFinite(perAttempt.get(op.attemptId)?.totalTokens)).length;
 usage.acknowledgedUnknownAttempts=operations.filter(op=>op.cancelAcknowledgement?.acceptUnknownUsage===true&&!Number.isFinite(perAttempt.get(op.attemptId)?.totalTokens)).length;
 let selection=null,selectionError=null;
 if(d.plan)try{selection=resolveSelection(d.plan,d.choice);}catch(e){selectionError={code:e.code,message:e.message};}
 const plan=d.plan?Object.fromEntries(Object.entries(d.plan).filter(([k])=>k!=='sourceFingerprints')):null;
 const lastFailure=candidates.findLast(c=>['needs_repair','needs_dependency_repair','stale'].includes(c.status)&&!c.resolvedBy);
 const problems=[...(lastFailure?.errors||[]),...(lastFailure?.validation?.errors||[])];
 const problemMessages=[...new Set(problems.map(problem=>typeof problem==='string'?problem:[problem?.at,problem?.message,typeof problem?.detail==='object'?JSON.stringify(problem.detail):problem?.detail].filter(Boolean).join('：')||problem?.code||'候选校验未通过'))];
 const candidateError=lastFailure?{code:problems[0]?.code||'CANDIDATE_VALIDATION',message:problemMessages.slice(0,3).map(message=>message.slice(0,600)).join('；')||'已保存的候选未通过校验，请查看候选历史。'}:null;
 const interrupted=!active&&operations.some(o=>o.status==='running');
 const visibleProgress=['awaiting_confirmation','needs_design','budget_stop','source_stale','waiting_dependencies','failed','unknown','pausing','paused','stopped'].includes(d.web?.progress)?d.web.progress:d.status;
 const attentionError=interrupted?{code:'INTERRUPTED',message:'上次服务中断或另一进程仍持有作业，请先核对已保存回执；不自动重发。'}:sourceStale||visibleProgress==='source_stale'?{code:'SOURCE_STALE',message:'原文或前情资料已更新，请新建任务使用最新资料；旧结果仍已保存。'}:visibleProgress==='unknown'||operations.some(o=>o.status==='unknown'&&!o.cancelAcknowledgement?.acceptUnknownUsage)?{code:'UNKNOWN',message:'有未完成的调用待处理：先检查已有回包；明确中断且没有回包时，可在下方确认风险后继续。'}:null;
 return {id:d.id,title:d.web?.title||d.source?.title||d.id,status:interrupted?'interrupted':visibleProgress,createdAt:d.web?.createdAt,settings:d.settings,active,sourceStale,
  error:d.web?.error||selectionError||attentionError||candidateError,sourceRows:d.source?.sourceRows||[],sourceWarnings:d.source?.context?.sourceWarnings||[],plan,choice:d.choice,selection,
  adopted:(d.adopted||[]).map(a=>({packageIds:a.packageIds,stage:a.stage,unitCount:a.draft.units.length,shotCount:a.draft.units.reduce((n,u)=>n+u.shots.length,0),seconds:a.draft.units.flatMap(u=>u.shots).reduce((n,s)=>n+s.duration,0)})),
  operations:operations.map(({attemptId,stage,packageIds,status,finishMode,createdAt,error,cancelAcknowledgement,recovery})=>({attemptId,stage,packageIds,status,finishMode,createdAt,error,cancelAcknowledgement,canRecoverSaved:recovery?.epoch!==d.epoch&&candidates.some(c=>c.attemptId===attemptId&&c.status==='cancelled_late'),usage:perAttempt.get(attemptId)||null})),
  candidates:candidates.map(({id,attemptId,stage,packageIds,status,errors,validation,requiredPackageIds,resolvedBy})=>({id,attemptId,stage,packageIds,status,errors,validation,requiredPackageIds,resolvedBy})),
  assembly:d.assembly?{text:d.assembly.text,...d.assembly.validation}:null,usage,cancellations,budget:{...d.web?.budget,maxRepairs:2},phase:d.web?.progress||null,lastCandidateId:lastFailure?.id||null};
}
