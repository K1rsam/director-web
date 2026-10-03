import {digest,fail} from './storyboard-v4/core/shared.mjs';
import {PRODUCTION_SUPPLY_VERSION} from './production-supply.mjs';

export const EPISODE_BOUNDARY_VERSION='episode-boundary-v1';
export const PRODUCTION_FEEDBACK_VERSION='production-feedback-v1';
export const PRODUCTION_FEEDBACK_CONTRACT_VERSION='production-feedback-design-v2';
export const PRODUCTION_FEEDBACK_VALIDATION_VERSION='production-feedback-coordinate-v2';
const text=x=>typeof x==='string'&&x.trim().length>0;
const relations=['DIRECT','TIME_JUMP','LOCATION_CHANGE','FLASHBACK','FANTASY','INDEPENDENT','UNKNOWN'];
const authorities=['SOURCE','DESIGN','CHARACTER_CLAIM','INTERPRETATION'];
const stateKey=s=>s.key;
const unique=a=>new Set(a).size===a.length;
const copy=x=>structuredClone(x);

// An actual tail is eligible only through the explicitly selected production chain.
// Neither most-recent-file nor episode number alone is an adoption decision.
export function makeBoundaryContext({seed,selected=null,actual=null,agreements=[],chainMode='SINGLE'}){
 if(seed?.schema!=='EPISODE_BOUNDARY_SEED_V1'||!seed.currentOpening?.text?.trim())fail('EPISODE_BOUNDARY_SOURCE','缺少可读取的跨集来源底稿。');
 const compatible=Boolean(actual&&selected&&actual.validated===true&&seed.adjacentEpisode===true
  &&actual.runId===selected.runId&&actual.episode===seed.fromEpisode&&actual.episode===selected.episode
  &&actual.sourceVersion===selected.sourceVersion&&actual.sourceVersion===seed.sourceVersion
  &&actual.selectionRevision===selected.selectionRevision);
 const context={version:EPISODE_BOUNDARY_VERSION,seed:copy(seed),selected:copy(selected),actual:compatible?copy(actual):null,
  agreements:copy(agreements),chainMode,mode:compatible?'ACTUAL':'PRELIMINARY'};
 context.versionId=digest(context);return context;
}
export function selectBoundaryForRequest(context,stage,touchesOpening){
 if(!context||stage!=='plan'&&!touchesOpening)return null;
 return copy(context);
}
export function boundaryEvidenceRows(context,{factHeadings=false}={}){
 const rows=[];
 for(const evidence of [context?.seed?.previousSource,context?.seed?.currentOpening]){
  if(!evidence||typeof evidence.text!=='string')continue;
  for(const node of evidence.nodes||[]){
   const start=node.sourceRange?.start-evidence.sourceRange?.start,end=node.sourceRange?.end-evidence.sourceRange?.start;
   if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>evidence.text.length)continue;
   const action=node.target==='BODY'&&node.kind==='ACTION',heading=factHeadings&&node.target==='STRUCTURE'&&node.kind==='SCENE_HEADING';
   rows.push({id:`boundary:${evidence.episode}:${node.id}`,text:evidence.text.slice(start,end),kind:action?'action':heading?'metadata':'guidance',evidenceRole:action||heading?'source':'guidance'});
  }
 }
 return rows;
}

// The final assembled unit and its currently adopted owner are one inseparable receipt.
// A later local entrance repair must never overwrite the episode's exit with its own report.
export function selectedActualTail(run){
 const unit=run.assembly?.draft?.units?.at(-1);
 if(!unit||run.assembly.validation?.errors?.length||run.production?.pendingRepair||run.production?.blocking)return null;
 const owner=run.adopted?.find(a=>a.draft?.units?.some(u=>u.id===unit.id));
 const ids=new Set([owner?.candidateId,...(owner?.candidateIds||[])]);
 const receipt=run.candidates?.findLast(c=>ids.has(c.id)&&c.productionFeedback?.exit?.length
  &&run.operations?.find(o=>o.attemptId===c.attemptId)?.productionSnapshot?.touchesEnding===true)?.productionFeedback;
 return {unit:copy(unit),states:copy((receipt?.exit||[]).filter(s=>['SOURCE','DESIGN'].includes(s.authority)))};
}

/** This is a model's interpretation receipt, never promoted to source evidence by itself. */
export function validateProductionFeedback(raw,request){
 const bad=(coordinate='productionFeedback',reason='字段或类型不完整')=>{const error=Object.assign(new Error(`${coordinate}：${reason}；已有正文保留，只修生产回执。`),{code:'PRODUCTION_FEEDBACK',coordinate});throw error;};
 if(!raw||!relations.includes(raw.relation)||!['entry','exit','sharedChoices','usedMaterialIds','needs','conflicts'].every(k=>Array.isArray(raw[k])))bad();
 const evidence=[...(request.source?.sourceRows||[]),...(request.source?.contextRows||[]),...boundaryEvidenceRows(request.episodeBoundary,{factHeadings:request.productionSnapshot?.supplyVersion===PRODUCTION_SUPPLY_VERSION})];
 const refs=new Set(evidence.map(r=>r.id));
 const currentRefs=new Set((request.source?.sourceRows||[]).map(r=>r.id));
 const spoken=new Set((request.source?.dialogue||[]).flatMap(q=>q.sourceIds||[q.rowId]));
 const sourceRefs=new Set(evidence.filter(r=>r.kind!=='guidance'&&r.evidenceRole!=='guidance'&&r.kind!=='dialogue'&&!spoken.has(r.id)).map(r=>r.id));
 const packages=new Set((request.plan?.workPackages||[]).map(w=>w.id));
 const materials=new Set(request.materialIds||[]);
 for(const name of ['entry','exit','sharedChoices']){
  const list=raw[name];
  if(list.some(s=>!s||typeof s!=='object')||!unique(list.map(stateKey)))bad(`productionFeedback.${name}`,'状态标识重复或类型错误');
  for(const [i,s] of list.entries()){
   const at=`productionFeedback.${name}[${i}]`;
   if(!text(s.key)||!text(s.value)||!authorities.includes(s.authority)||!Array.isArray(s.sourceRefs))bad(at,'状态字段不完整');
   for(const [j,ref] of s.sourceRefs.entries())if(!refs.has(ref)||s.authority==='SOURCE'&&!sourceRefs.has(ref))bad(`${at}.sourceRefs[${j}]`,`${ref}不是本次可用的${s.authority==='SOURCE'?'事实':'来源'}坐标`);
   if(s.authority==='SOURCE'&&!s.sourceRefs.length)bad(`${at}.sourceRefs`,'SOURCE缺少原文证据');
  }
 }
 for(const [i,s] of raw.sharedChoices.entries())if(s.authority!=='DESIGN')bad(`productionFeedback.sharedChoices[${i}].authority`,'跨集制作约定只能使用DESIGN；解释推断不能冒充已锁定的制作选择');
 if(request.productionSnapshot?.touchesEnding===false&&raw.exit.length)bad();
 if(request.productionSnapshot?.touchesEnding===true)for(const locked of request.productionSnapshot.outgoingAgreements||[]){
  if(!raw.exit.some(s=>s.key===locked.key&&s.value===locked.value)&&!raw.conflicts.some(c=>c.key===locked.key))bad();
 }
 if(!unique(raw.usedMaterialIds))bad('productionFeedback.usedMaterialIds','材料ID重复');
 for(const [i,id] of raw.usedMaterialIds.entries())if(!materials.has(id))bad(`productionFeedback.usedMaterialIds[${i}]`,`${id}不是本次已发送材料`);
 for(const [i,n] of raw.needs.entries()){
  const at=`productionFeedback.needs[${i}]`;
  if(!n||![1,2,3].includes(n.stage)||!text(n.target)||!text(n.purpose)||typeof n.blocking!=='boolean'||!Array.isArray(n.packageIds)||!Array.isArray(n.sourceRefs)||!n.sourceRefs.length)bad(at,'需求字段不完整');
  for(const [j,id] of n.packageIds.entries())if(!packages.has(id))bad(`${at}.packageIds[${j}]`,`${id}不在本次工作包范围`);
  for(const [j,id] of n.sourceRefs.entries())if(!(n.stage===2?currentRefs:refs).has(id))bad(`${at}.sourceRefs[${j}]`,`${id}不在本次${n.stage===2?'制作原文':'可读来源'}范围`);
 }
 for(const [i,n] of raw.conflicts.entries())if(!n||!text(n.key)||!text(n.problem)||!Array.isArray(n.sourceRefs)||!n.sourceRefs.length||n.sourceRefs.some(id=>!refs.has(id)))bad(`productionFeedback.conflicts[${i}]`,'冲突缺少合法原文坐标');
 return copy(raw);
}

export function reconcileBoundary({context,feedback,previousCheck=null}){
 if(!context)return null;
 const signature=digest({version:context.versionId,feedback});
 if(previousCheck?.signature===signature)return previousCheck;
 const base={signature,version:context.versionId,actualVersion:context.actual?.version??null,changedKeys:[],inherit:false,repairTarget:null};
 if(context.seed.fromEpisode===null)return {...base,status:'NO_PREDECESSOR'};
 if(!feedback||feedback.relation==='UNKNOWN')return {...base,status:'UNRESOLVED',reason:'尚未判明原文时间/现实域关系，不能自动继承。'};
 if(feedback.relation!=='DIRECT')return {...base,status:'NOT_CONTINUOUS'};
 const agreements=new Map(context.agreements.map(s=>[s.key,s]));
 const entryConflict=feedback.entry.filter(s=>agreements.has(s.key)&&s.value!==agreements.get(s.key).value);
 if(entryConflict.length)return {...base,status:'CONSTRAINT_CONFLICT',changedKeys:entryConflict.map(stateKey),repairTarget:'CURRENT_CONSTRAINT'};
 const actualConflict=(context.actual?.states||[]).filter(s=>agreements.has(s.key)&&s.value!==agreements.get(s.key).value);
 if(actualConflict.length)return {...base,status:'CONSTRAINT_CONFLICT',changedKeys:actualConflict.map(stateKey),repairTarget:'PREDECESSOR_OR_SOURCE_REVIEW'};
 if(!context.actual)return {...base,status:'PRELIMINARY',reason:'按原文底稿制作；未与上集实际分镜核对。'};
 const actual=new Map(context.actual.states.map(s=>[s.key,s]));
 const states=feedback.entry.filter(s=>['SOURCE','DESIGN'].includes(s.authority));
 const compared=states.filter(s=>actual.has(s.key));
 const missing=states.filter(s=>!actual.has(s.key)).map(s=>s.key);
 const changes=compared.filter(s=>s.value!==actual.get(s.key).value);
 // Hard source/locked-production constraints stay hard. This identifies a conflict for
 // evidence review; it does not prove that the model-labelled SOURCE value is true.
 const hard=changes.filter(s=>s.authority==='SOURCE'||agreements.has(s.key));
 if(hard.length)return {...base,status:'CONSTRAINT_CONFLICT',changedKeys:hard.map(stateKey),repairTarget:'PREDECESSOR_OR_SOURCE_REVIEW'};
 if(changes.length)return {...base,status:'REPAIR_REQUIRED',inherit:true,changedKeys:changes.map(stateKey),repairTarget:'CURRENT_DEPENDENCIES'};
 if(missing.length)return {...base,status:'UNRESOLVED',missingKeys:missing,reason:'上集采用尾稿未回填所消费的状态，不能自动称为一致。'};
 return {...base,status:compared.length?'MATCHED':'NOT_CONSUMED',inherit:compared.length>0};
}

// Follow explicit dependencies and inseparable adopted groups; do not invalidate all episodes.
export function dependencyScope(d,initial){
 const scope=new Set(initial);let size;
 do{size=scope.size;for(const w of d.plan?.workPackages||[])if(w.dependsOn?.some(id=>scope.has(id)))scope.add(w.id);
  for(const group of d.adopted||[])if(group.packageIds.some(id=>scope.has(id)))for(const id of group.packageIds)scope.add(id);
 }while(scope.size!==size);
 return (d.plan?.workPackages||[]).filter(w=>scope.has(w.id)).map(w=>w.id);
}

export function productionFeedbackSchema({source,plan,materialIds=[],touchesEnding,episodeBoundary,strictAuthorities=false,authoritySource=source,factHeadings=false,designOnlySharedChoices=false}){
 const string={type:'string'},arr=items=>({type:'array',items}),obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
 const enumOf=values=>values.length?{type:'string',enum:[...new Set(values)]}:string;
 const refs=values=>({...arr(enumOf(values)),...(!values.length?{maxItems:0}:{})});
 const boundaryRows=boundaryEvidenceRows(episodeBoundary,{factHeadings});
 const sourceRefs=refs([...(source.sourceRows||[]),...(source.contextRows||[]),...boundaryRows].map(r=>r.id));
 const need=(stages,coordinates)=>obj({stage:{type:'integer',enum:stages},target:string,purpose:string,packageIds:plan?refs((plan.workPackages||[]).map(w=>w.id)):arr(string),sourceRefs:coordinates,blocking:{type:'boolean'}});
 let state=obj({key:string,value:string,authority:enumOf(authorities),sourceRefs});
 if(strictAuthorities){
  const spoken=new Set((authoritySource.dialogue||[]).flatMap(q=>q.sourceIds||[q.rowId]));
  const visible=new Set([...(source.sourceRows||[]),...(source.contextRows||[]),...boundaryRows].map(r=>r.id));
  const hardRefs=[...(authoritySource.sourceRows||[]),...(authoritySource.contextRows||[]),...boundaryRows]
   .filter(r=>visible.has(r.id)&&r.kind!=='guidance'&&r.evidenceRole!=='guidance'&&r.kind!=='dialogue'&&!spoken.has(r.id)).map(r=>r.id);
  const soft=obj({key:string,value:string,authority:enumOf(authorities.filter(a=>a!=='SOURCE')),sourceRefs});
  state={anyOf:[...(hardRefs.length?[obj({key:string,value:string,authority:enumOf(['SOURCE']),sourceRefs:{...refs(hardRefs),minItems:1}})]:[]),soft]};
 }
 const sharedChoice=designOnlySharedChoices?obj({key:string,value:string,authority:enumOf(['DESIGN']),sourceRefs}):state;
 return obj({relation:enumOf(relations),entry:arr(state),exit:{...arr(state),...(touchesEnding===false?{maxItems:0}:{})},sharedChoices:arr(sharedChoice),usedMaterialIds:refs(materialIds),
  needs:arr({anyOf:[need([2],refs((source.sourceRows||[]).map(r=>r.id))),need([1,3],sourceRefs)]}),
  conflicts:arr(obj({key:string,problem:string,sourceRefs}))});
}

// Opt-in: frozen historical prompts must retain their original bytes and hashes.
export const productionFeedbackDesignHint='sharedChoices只允许authority=DESIGN，且value必须是确需共用的最小制作选择。原文事实、角色说法、解释推断应按各自证据等级写入entry/exit，不放入sharedChoices；无需新增制作约定时用[]。不能仅为通过校验把推断标成DESIGN，也不能把设计标成SOURCE。';

export const productionFeedbackHint=`productionFeedback是本次生产消费回执，不是新增审稿岗位或长摘要。relation只据前集尾段与本集开场判断，DIRECT为同一现实时间内的连续动作；跳时/换场/闪回/幻想/未知不得无条件继承。entry只记录本次真正依赖的本集入口状态（在开场动作变化之前），exit只在productionScope.touchesEnding=true时记录采用稿实际尾态，其他用[]。状态key优先复用已提供actual.states/agreements，使用“资产key/状态项”稳定标识，value简短精确。SOURCE必须有本次可读且非guidance/对白的sourceRefs；角色说法用CHARACTER_CLAIM，解释推断用INTERPRETATION，都不能自证世界规则或硬性继承；未规定的制作选择用DESIGN。sharedChoices只提必须跨集共用的最小制作约定，不预写分镜；未指定手、站位、机位不要无用补全。actual只细化自由选择，不覆盖源文和agreements。outgoingAgreements是本集结尾与后集共享的已锁定最小制作约定，若与原文冲突应回报conflicts而不是强行覆盖。usedMaterialIds只列确实影响本次创作的材料ID。needs只报告有坐标、用途、影响工作包的缺料；stage=2的sourceRefs必须锚定本次sourceRows中的受影响资产或场景，不可用前集/context/boundary编号冒充本集供给坐标，前情关系写入purpose；无法定位本集时先向stage=1/3请求定位。目标已在材料中时target必须填准确assetKey，不用显示名猜ID；真正缺失的新资产保留原文坐标待定位。无图片不阻断文字。conflicts只报硬冲突，普通有依据整理直接完成。没有需求/冲突时用[]。`;
