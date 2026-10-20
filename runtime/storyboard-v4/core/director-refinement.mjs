import {digest,fail} from './shared.mjs';
import {baseDraftHash} from './delta.mjs';
import {refinementScope} from './refinement-scope.mjs';
import {refinementProductionFeedback} from './refinement-source-resolution.mjs';

export const DIRECTOR_REFINEMENT_PURPOSE='director_refinement';
export const DIRECTOR_REFINEMENT_VERSION='director-refinement-v3';
export const DIRECTOR_REFINEMENT_VERSIONS=['director-refinement-v1','director-refinement-v2',DIRECTOR_REFINEMENT_VERSION];
export const targetedDirectorRefinement=version=>['director-refinement-v2',DIRECTOR_REFINEMENT_VERSION].includes(version);
export const DIRECTOR_REFINEMENT_SKILL='skills/director-refinement/SKILL.md';
export const isDirectorRefinement=value=>value?.purpose===DIRECTOR_REFINEMENT_PURPOSE;
// The schema carries field shapes. This is the execution meaning, not another generation role stack.
export const DIRECTOR_REFINEMENT_OUTPUT_HINT='交付performance-core-v4-delta：baseDraftHash原样返回，未修改旧单元只列retainedUnitIds；replacements每组替换连续完整旧单元，交完整新units及其fantasyRealization。原话逐字、说者/声道和来源不变；不能把表演提示念出。dialogueParts的lineId取dialogue.id，sourceRefs取sourceRows.id。整句声轨按人物语气核对，voiceStart/voiceEnd在镜内；speechTrackId跨镜连续时保持同一声轨，切镜不额外停顿。unitDirection写实际观看进程，不复述镜表。幻想按本次schema的screenSpans或旧时间协议，单元/镜号引用与实际入出相符；visualSubjects仅列实际展示的主观/未来形体。保留事件源顺序、边界和锁定约定，前集材料只供承接，不增演前情。productionFeedback（若schema要求）沿用有效采用事实，按实际消费填usedMaterialIds；新增需求与冲突带给定证据坐标。只记录实改的revisionNotes（坐标、sourceRefs、change、preservedFunction），unresolved只列真实不能安全完成的问题。不另交评分、复述、全剧摘要或保留理由清单。';
export const refinementAssemblyHash=d=>digest({assembly:d.assembly,adopted:d.adopted});
const productionBasis=d=>digest({boundary:d.production?.boundary??null,materials:d.production?.materials??[],outgoingAgreements:d.production?.outgoingAgreements??[]});

export function refinementAdoptionBlock(d,candidate=null){
 if(d.web?.binding?.productionChain?.mode==='CHAIN'||d.production?.boundary?.selected||(d.production?.outgoingAgreements||[]).length)
  return {code:'REFINEMENT_PREVIEW_ONLY',message:'精修候选已保存供对照；当前跨集实际承接或锁定约定尚未验证精修传播，未改变已采用尾态，继续使用基稿。'};
 const feedback=refinementProductionFeedback(d,candidate);
 if(feedback?.conflicts?.length||feedback?.needs?.some(n=>n.blocking))
  return {code:'REFINEMENT_PREVIEW_ONLY',message:'精修候选提出生产材料缺口或硬约束冲突；已保留预览与基稿，尚未改变采用稿或实际尾态。'};
 return null;
}

export function freezeDirectorRefinement(d,packageIds,eventIds,{unitIds,reviewNotes='',preserveNotes=''}={}){
 if(d.status!=='text_ready_for_review'||!d.assembly?.draft?.units?.length||d.assembly?.validation?.errors?.length!==0||d.web?.sourceStale||d.production?.blocking||d.production?.pendingRepair)
  fail('REFINEMENT_BASE_REQUIRED','先完成当前版本的稳定整编与承接核对，再执行一次可选导演精修。');
 if(d.operations.some(o=>o.status==='running'||o.status==='unknown'&&o.cancelAcknowledgement?.acceptUnknownUsage!==true))fail('REFINEMENT_BUSY','仍有未结请求，先恢复已有回包。');
 if(d.operations.some(o=>isDirectorRefinement(o)&&o.receipt?.requestOutcome!=='NOT_SENT'&&o.error?.requestOutcome!=='NOT_SENT'))fail('REFINEMENT_LIMIT','本任务已执行一次导演精修；候选与基稿保留，不重复发送。');
 const all=d.plan.workPackages.map(w=>w.id);
 if(packageIds.length!==all.length||new Set(packageIds).size!==all.length||packageIds.some(id=>!all.includes(id)))fail('REFINEMENT_SCOPE','精修输入须绑定本集完整成稿；替换范围另由连续事件限定。');
 const version=d.rulesSnapshot.directorRefinementVersion,improving=version===DIRECTOR_REFINEMENT_VERSION;
 const events=d.plan.events||[],selected=eventIds??(improving?events:events.slice(0,Math.min(2,events.length))).map(e=>e.id);
 const scopeMessage=improving?'请选择按本集顺序连续的完整事件；默认检查整集。':'请选择按本集顺序连续的1至2个完整事件。';
 if(!Array.isArray(selected)||!selected.length||selected.length>(improving?500:2)||new Set(selected).size!==selected.length)fail('REFINEMENT_SCOPE',scopeMessage);
 const positions=selected.map(id=>events.findIndex(e=>e.id===id));
 if(positions.some((n,i)=>n<0||i>0&&n!==positions[i-1]+1))fail('REFINEMENT_SCOPE',scopeMessage);
 const body=d.rulesSnapshot.files?.[DIRECTOR_REFINEMENT_SKILL];
 if(!DIRECTOR_REFINEMENT_VERSIONS.includes(version)||typeof body!=='string'||!body.trim())fail('REFINEMENT_RULES','本任务没有冻结的导演精修规则；请保留旧稿，用新任务启用该能力。');
 const targeted=targetedDirectorRefinement(version);
 if(!targeted&&(unitIds!==undefined||reviewNotes||preserveNotes))fail('REFINEMENT_RULES','旧任务仍沿用冻结的事件级精修规则；不能临时接入新版工作单，请保留现稿。');
 let scope,workOrder;
 if(targeted){
  for(const note of [reviewNotes,preserveNotes])if(typeof note!=='string'||note.length>1200||note.includes('\0'))fail('REFINEMENT_REVIEW','工作单须为1200字以内文本；不截断问题或保全要求。');
  const eligible=d.assembly.draft.units.filter(u=>selected.includes(u.eventId)),chosen=unitIds??eligible.map(u=>u.id);
  if(!Array.isArray(chosen)||!chosen.length||new Set(chosen).size!==chosen.length)fail('REFINEMENT_SCOPE','请选择至少一个连续完整单元。');
  const indices=chosen.map(id=>d.assembly.draft.units.findIndex(u=>u.id===id&&selected.includes(u.eventId)));
  if(indices.some((n,i)=>n<0||i>0&&n!==indices[i-1]+1))fail('REFINEMENT_SCOPE','单元必须在所选事件内，按当前稿顺序连续排列。');
  for(const f of d.assembly.draft.fantasyRealization||[])if((f.unitIds||[]).some(id=>chosen.includes(id))&&(f.unitIds||[]).some(id=>!chosen.includes(id)))fail('REFINEMENT_SCOPE','所选单元包含跨单元幻想；请明确选入它关联的完整单元，不拆断或自动扩大范围。');
  scope=refinementScope(d,{eventIds:selected,unitIds:chosen});unitIds=[...chosen];
  workOrder={version:'refinement-work-order-v1',reviewNotes:reviewNotes.trim(),preserveNotes:preserveNotes.trim()};
 }
 return {version,baseAssemblyHash:refinementAssemblyHash(d),baseDraftHash:baseDraftHash(d.assembly.draft),productionBasisHash:productionBasis(d),eventIds:[...selected],
  ...(targeted?{unitIds,scope,workOrder}:{}),
  skill:{path:DIRECTOR_REFINEMENT_SKILL,body,hash:digest(body)}};
}

export function assertDirectorRefinementBase(d,refinement){
 if(!DIRECTOR_REFINEMENT_VERSIONS.includes(refinement?.version)||!d.assembly||refinementAssemblyHash(d)!==refinement.baseAssemblyHash||productionBasis(d)!==refinement.productionBasisHash||d.web?.sourceStale||d.production?.blocking||d.production?.pendingRepair)
  fail('REFINEMENT_STALE','基稿、来源或生产材料已变化；精修候选保留，不能覆盖当前版本。');
}

export function decorateDirectorRefinementRequest(request,refinement){
 if(request.stage!=='finish'||request.finishMode!=='delta'||request.baseDraftHash!==refinement.baseDraftHash||!DIRECTOR_REFINEMENT_VERSIONS.includes(refinement.version)||digest(refinement.skill?.body)!==refinement.skill?.hash)
  fail('REFINEMENT_REQUEST','导演精修必须重放冻结规则及稳定基稿的差量请求。');
 const aliases=new Map(Object.entries(request.modelCoordinates?.aliases||{}).map(([short,full])=>[full,short]));
 const targeted=targetedDirectorRefinement(refinement.version),improving=refinement.version===DIRECTOR_REFINEMENT_VERSION;
 const contract={purpose:DIRECTOR_REFINEMENT_PURPOSE,version:refinement.version,baseAssemblyHash:refinement.baseAssemblyHash,eventIds:refinement.eventIds.map(id=>aliases.get(id)||id),skillHash:refinement.skill.hash,
  ...(targeted?{unitIds:refinement.unitIds.map(id=>aliases.get(id)||id),workOrder:refinement.workOrder,scopeSummary:{unitCount:refinement.scope.unitCount,shotCount:refinement.scope.shotCount,wholeEpisode:refinement.scope.wholeEpisode}}:{})};
 const editorPath='skills/episode-finishing-editor/SKILL.md',editor=request.snapshot?.find(s=>s.path===editorPath);
 const withoutEditor=editor?request.prompt.replace('【'+editorPath+'】\n'+editor.body+'\n\n',''):request.prompt;
 if(improving&&(request.snapshot?.length!==1||request.snapshot[0].path!==refinement.skill.path||digest(request.snapshot[0].body)!==refinement.skill.hash))fail('REFINEMENT_REQUEST','新版精修须使用独立冻结改稿规则，不能复用普通整编整套规则。');
 let prompt=improving?request.prompt+'\n【本次精修边界】\n'+JSON.stringify(contract)+'\n默认检查整集，实际只改发现薄弱点及其必要依赖；范围外和无须改动单元原样retained。完成找问题→局部改稿→保护项复查后才交候选。':withoutEditor+'\n\n【可选导演精修规则】\n'+refinement.skill.body+'\n【本次精修边界】\n'+JSON.stringify(contract)+'\n只替换选定事件内的连续完整单元组；其他事件及retainedUnitIds逐项原样保留。只有一轮候选，不返回评分、不自动放行。';
 let schema;
 if(targeted){
  schema=structuredClone(request.schema||{type:'object',properties:{},required:[]});
  schema.properties.reviewDecisions={type:'array',minItems:improving?0:1,maxItems:refinement.unitIds.length,items:{type:'object',additionalProperties:false,properties:{
   unitIds:{type:'array',minItems:1,items:{type:'string',enum:contract.unitIds}},disposition:{type:'string',enum:improving?['changed','unresolved']:['changed','retained','unresolved']},reason:{type:'string',minLength:1,maxLength:1200},preservedFunction:{type:'string',minLength:1,maxLength:600}},required:['unitIds','disposition','reason','preservedFunction']}};
  schema.required.push('reviewDecisions');
  prompt+=improving?'\nreviewDecisions只记实改问题组changed或真实未解决unresolved；reason简述具体缺口→实际改法，preservedFunction写保住的效果。不为未改单元写retained理由。每个被替换旧单元由一个问题组登记；changed须有实改replacements，未解决须有坐标unresolved。确认无需修改可交空数组，但将明确记为未产生改善，不视为精修成功。':'\n本次只可改unitIds列出的完整单元，范围外逐项retained，不扩大到整个事件。reviewDecisions用一个或多个单元组成的问题组，每个选中旧单元恰好登记一次changed/retained/unresolved及简短具体reason、preservedFunction；不改也要说明此工作单的保留依据，不用空数组或自评代替处理。changed须有对应replacements，未解决须写unresolved。';
 }
 return {...request,purpose:DIRECTOR_REFINEMENT_PURPOSE,prompt,promptHash:digest(prompt),inputHash:digest([request.inputHash,contract]),
  ...(schema?{schema,schemaHash:digest(schema)}:{}),snapshot:improving?request.snapshot:[...(request.snapshot||[]).filter(s=>s.path!==editorPath),{path:refinement.skill.path,body:refinement.skill.body}],
  loadedFiles:improving?request.loadedFiles:[...(request.loadedFiles||[]).filter(s=>s.path!==editorPath),{path:refinement.skill.path,hash:refinement.skill.hash,chars:refinement.skill.body.length}]};
}

export function assertDirectorRefinementDelta(base,delta,refinement,draft){
 const selected=new Set(refinement.eventIds),old=new Map(base.units.map(u=>[u.id,u]));
 const allowed=refinement.unitIds&&new Set(refinement.unitIds);
 for(const group of delta.replacements||[]){
  if(group.replaces.some(id=>!selected.has(old.get(id)?.eventId)||allowed&&!allowed.has(id))||group.units.some(u=>!selected.has(u.eventId)))fail('REFINEMENT_SCOPE','替换组越出选定的事件或完整单元，已保存候选并保留基稿。');
 }
 if(targetedDirectorRefinement(refinement.version)){
  const improving=refinement.version===DIRECTOR_REFINEMENT_VERSION;
  const decisions=delta.reviewDecisions,seen=new Set(),changed=new Set((delta.replacements||[]).flatMap(g=>g.replaces));
  if(!Array.isArray(decisions)||!improving&&!decisions.length)fail('REFINEMENT_REVIEW','精修回包缺少工作单处理说明，已保留原稿与回包，不自动重发。');
  for(const decision of decisions){
   if(!Array.isArray(decision.unitIds)||!decision.unitIds.length||!(improving?['changed','unresolved']:['changed','retained','unresolved']).includes(decision.disposition)||typeof decision.reason!=='string'||!decision.reason.trim()||decision.reason.length>1200||typeof decision.preservedFunction!=='string'||!decision.preservedFunction.trim()||decision.preservedFunction.length>600)fail('REFINEMENT_REVIEW','工作单处理说明缺少具体依据或保全功能。');
   for(const id of decision.unitIds){
    if(!allowed.has(id)||seen.has(id)||changed.has(id)!==(decision.disposition==='changed'))fail('REFINEMENT_REVIEW','工作单处理说明与实际替换范围不一致。');
    seen.add(id);
   }
   if(decision.disposition==='unresolved'&&!(delta.unresolved||[]).some(issue=>decision.unitIds.includes(issue.coordinate)&&typeof issue.problem==='string'&&issue.problem.trim()))fail('REFINEMENT_REVIEW','未解决的工作单问题须保留有坐标的unresolved说明。');
  }
  if(improving?[...changed].some(id=>!seen.has(id)):seen.size!==allowed.size)fail('REFINEMENT_REVIEW','实际改动未完整登记问题与保全功能。');
 }
 if(draft)for(const id of delta.retainedUnitIds||[]){
  const retained=draft.units.find(u=>u.id===id);
  if(!retained||digest(old.get(id))!==digest(retained))fail('REFINEMENT_SCOPE','差量归一化改变了明确保留的单元；候选不可采用，基稿保留。');
 }
}
