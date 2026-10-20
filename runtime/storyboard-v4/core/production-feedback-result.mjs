import {digest,fail} from './shared.mjs';
import {baseDraftHash} from './delta.mjs';

export const LEGACY_FEEDBACK_RESULT_VERSION='production-feedback-result-v1';
export const FEEDBACK_RESULT_VERSION='production-feedback-result-v2';
export const isFeedbackResultVersion=version=>[LEGACY_FEEDBACK_RESULT_VERSION,FEEDBACK_RESULT_VERSION].includes(version);
export const feedbackMaterialHint='materialDecisions另支持REPLACE：本次确实读取并重新核对同ID的新素材版本时，将旧消费世代退休，并在usedMaterialIds明确报告该ID，由本次consumer和冻结snapshot接替；不必强改已符合新材料的正文。KEEP仍保留原consumer，不可借换单元ID偷偷丢依赖；REMOVE仅表示整稿确已不用。原consumer出处与其当前支持单元范围分开追踪。';
const copy=x=>structuredClone(x);
const text=x=>typeof x==='string'&&Boolean(x.trim());
const bad=reason=>fail('PRODUCTION_FEEDBACK_RESULT',`${reason}；保留原生回包，不猜补状态或消费记录。`);
const unique=xs=>new Set(xs).size===xs.length;
const contentHash=d=>baseDraftHash(d);
const seal=body=>({...body,signature:digest(body)});
function verifySeal(value,version=null){
 if(!value||!isFeedbackResultVersion(value.version)||version!==null&&value.version!==version)bad('完整结果回执版本缺失');
 const {signature,...body}=value;if(signature!==digest(body))bad('完整结果回执身份已变化');
 return value;
}

// The projection is derived evidence, not an edit to the paid model's receipt.
// Entry/needs/conflicts are deliberately NEVER inherited from an older draft.
export function effectiveProductionFeedback(candidate){
 const raw=candidate.productionFeedback,projection=candidate.feedbackProjection;
 let result=raw;
 if(projection){
  verifySeal(projection);
  if(projection.nativeFeedbackHash!==digest(raw)||projection.draftHash!==contentHash(candidate.draft))bad('派生回执与当前原生回执或正文不匹配');
  result={...result,exit:copy(projection.exit)};
 }
 const entry=candidate.entryProjection;
 if(entry){
  const {signature,...body}=entry;
  if(entry.version!=='boundary-entry-review-v3'||signature!==digest(body)||entry.nativeFeedbackHash!==digest(raw)||entry.draftHash!==contentHash(candidate.draft))bad('入口派生回执与当前原生回执或正文不匹配');
  result={...result,entry:copy(entry.entry)};
 }
 return result;
}
export function feedbackMaterialConsumers(candidate){
 if(candidate.feedbackProjection){effectiveProductionFeedback(candidate);return copy(candidate.feedbackProjection.materialConsumers);}
 const ids=candidate.productionFeedback?.usedMaterialIds||[];
 return ids.length?[{candidateId:candidate.id,attemptId:candidate.attemptId,packageIds:copy(candidate.packageIds||[]),unitIds:(candidate.draft?.units||[]).map(u=>u.id),materialIds:copy(ids)}]:[];
}

export function freezeFeedbackBasis(run,draft,packageIds,{touchesEnding=false,version=FEEDBACK_RESULT_VERSION}={}){
 if(!isFeedbackResultVersion(version))bad('完整结果回执版本缺失或不匹配');
 const owners=run.adopted.filter(a=>a.packageIds.some(id=>packageIds.includes(id)));
 if(!owners.length)return null;
 const expected=owners.flatMap(a=>a.draft.units),actual=new Map(draft.units.map(u=>[u.id,u]));
 if(expected.length!==actual.size||expected.some(u=>digest(u)!==digest(actual.get(u.id))))bad('返修基稿与实际采用组不一致');
 const ids=new Set(owners.flatMap(a=>[a.candidateId,...(a.candidateIds||[])]));
 const candidates=run.candidates.filter(c=>ids.has(c.id)&&c.status==='adopted'&&c.productionFeedback);
 if([...ids].some(id=>!candidates.some(c=>c.id===id)))bad('返修基稿缺少唯一采用回执谱系');
 const last=draft.units.at(-1),tailOwner=owners.find(a=>a.draft.units.some(u=>u.id===last?.id));
 const tailIds=new Set([tailOwner?.candidateId,...(tailOwner?.candidateIds||[])]);
 const tail=touchesEnding&&candidates.findLast(c=>tailIds.has(c.id)&&run.operations.find(o=>o.attemptId===c.attemptId)?.productionSnapshot?.touchesEnding===true);
 const exit=tail?copy(effectiveProductionFeedback(tail).exit):[];
 const consumers=new Map();
 for(const c of candidates)for(const consumer of feedbackMaterialConsumers(c)){
  const support=(consumer.supportUnitIds??consumer.unitIds).filter(id=>actual.has(id));
  if(!support.length)continue;
  const op=run.operations.find(o=>o.attemptId===consumer.attemptId);
  if(!op||consumer.materialIds.some(id=>!op.productionSnapshot?.materials?.some(m=>m.id===id)))bad('原素材consumer缺少冻结供给证据');
  const scoped={...consumer,supportUnitIds:support};
  consumers.set(digest(scoped),scoped); // One origin may support different material subsets in different current scopes.
 }
 return seal({version,draftHash:contentHash(draft),candidateIds:[...ids],exit,
  materialIds:[...new Set([...consumers.values()].flatMap(c=>c.materialIds))],materialConsumers:[...consumers.values()]});
}

const unitFields=['initialState','exitState','scene','lighting','unitDirection','title'];
const shotFields=['picture','lighting','camera','sound','transition'];
export function validateDraftEvidence(proofs,draft,{lastOnly=false}={}){
 if(!Array.isArray(proofs)||!proofs.length)bad('缺少完成稿逐字证据');
 for(const proof of proofs){
  const unit=draft?.units?.find(u=>u.id===proof?.unitId),shot=unit?.shots?.find(s=>s.id===proof?.shotId);
  const allowed=proof?.shotId?shotFields:unitFields,body=proof?.shotId?shot:unit;
  if(!unit||lastOnly&&unit.id!==draft.units.at(-1).id||!allowed.includes(proof?.field)||!text(proof?.quote)
    ||typeof body?.[proof.field]!=='string'||!body[proof.field].includes(proof.quote))bad('完成稿证据坐标、范围或逐字引文不匹配');
 }
 return true;
}

function validateKeepState(old,next,request,factRefs){
 const {sourceRefs:before,...oldState}=old,{sourceRefs:after,...nextState}=next;
 if(digest(oldState)!==digest(nextState))bad('保留尾态不能暗中改值或authority；有变化须显式替换');
 if(!Array.isArray(before)||!Array.isArray(after)||!unique(before)||!unique(after)||before.some(id=>!after.includes(id)))bad('保留尾态只允许增补来源，不能删除、替换或重复原证据');
 const added=after.filter(id=>!before.includes(id));
 if(!added.length)return;
 // The pipeline supplies its canonical fact set, including verified boundary rows.
 // ponytail: standalone calls prove only source/context rows; pass the canonical set for boundary facts.
 const spoken=new Set((request.source?.dialogue||[]).flatMap(q=>q.sourceIds||[q.rowId]));
 const available=factRefs??new Set([...(request.source?.sourceRows||[]),...(request.source?.contextRows||[])].filter(r=>r.kind!=='guidance'&&r.evidenceRole!=='guidance'&&r.kind!=='dialogue'&&!spoken.has(r.id)).map(r=>r.id));
 if(!(available instanceof Set)||added.some(id=>!available.has(id)))bad('保留尾态增补的来源不是本次可用的事实坐标');
}

function validateExitEvidence(row,draft,state,feedback,version){
 if(version===LEGACY_FEEDBACK_RESULT_VERSION)return validateDraftEvidence(row.evidence,draft,{lastOnly:true});
 validateDraftEvidence(row.evidence,draft);
 const continuation=row.continuation;
 if(!Array.isArray(continuation))bad('尾态持续证明类型不完整');
 const last=draft.units.at(-1)?.id;
 if(row.evidence.every(p=>p.unitId===last)&&!continuation.length){
  if(row.decision==='KEEP'&&!row.evidence.some(p=>p.shotId===''&&p.field==='exitState'&&p.quote.includes(state.value)))bad('保留尾态须含末单元同值状态的逐字期末正证');
  return;
 }
 if(row.decision!=='KEEP'||feedback.conflicts.some(c=>c.key===row.key))bad('较早尾态正证仅能用于无冲突的同值保留');
 const first=Math.min(...row.evidence.map(p=>draft.units.findIndex(u=>u.id===p.unitId))),suffix=draft.units.slice(first+1);
 if(!continuation.length||continuation.length!==suffix.length)bad('较早尾态正证须逐项覆盖全部后续单元及末单元');
 for(const [i,item] of continuation.entries()){
  if(item?.unitId!==suffix[i].id||item.key!==state.key||item.value!==state.value||item.authority!==state.authority||item.verdict!=='CONTINUES'||!text(item.reason))bad('尾态持续证明的顺序、同键同值或持续结论不匹配');
  validateDraftEvidence(item.evidence,draft);
  if(item.evidence.some(p=>p.unitId!==item.unitId)||!item.evidence.some(p=>p.shotId===''&&p.field==='exitState'&&p.quote.includes(state.value)))bad('尾态持续证明须含本单元同值状态的逐字期末正证');
 }
}

export function projectResultFeedback({request,feedback,draft,candidateId,attemptId,packageIds,delta=null,factRefs=null}){
 const version=request.productionSnapshot?.feedbackResultVersion;
 if(request.stage!=='finish'||!isFeedbackResultVersion(version))return null;
 const revision=feedback.resultRevision,basis=request.previousDraft?.feedbackBasis;
 if(!revision||!Array.isArray(revision.exitDecisions)||!Array.isArray(revision.materialDecisions))bad('整编须报告完整结果回执的保留/替换/退役');
 if(!basis){
  if(revision.baseSignature!==''||revision.exitDecisions.length||revision.materialDecisions.length)bad('无可靠采用基稿时不能臆造继承');
 }else{
  verifySeal(basis,version);
  if(basis.draftHash!==contentHash(request.previousDraft)||revision.baseSignature!==basis.signature)bad('整编回执引用的基稿已过期');
 }
 const decisions=revision.exitDecisions,materials=revision.materialDecisions;
 const exitKeys=(basis?.exit||[]).map(s=>s.key),materialIds=basis?.materialIds||[];
 for(const [rows,keys,label] of [[decisions,exitKeys,'尾态'],[materials,materialIds,'素材']]){
  const actual=rows.map(r=>label==='尾态'?r?.key:r?.id);
  if(!unique(actual)||actual.length!==keys.length||actual.some(id=>!keys.includes(id)))bad(`${label}保留/退役决策须精确覆盖基稿，不能遗漏或夹带`);
 }
 const nativeExit=new Map(feedback.exit.map(s=>[s.key,s])),projected=new Map();
 for(const row of decisions){
  if(!['KEEP','REPLACE','REMOVE'].includes(row.decision)||!text(row.reason))bad('尾态决策不完整');
  const old=basis.exit.find(s=>s.key===row.key);
  validateExitEvidence(row,draft,old,feedback,version);
  if(row.decision==='KEEP'){
   if(row.replacementKey!=='')bad('保留尾态不能暗中改值；有变化须显式替换');
   if(nativeExit.has(row.key)){
    if(version===LEGACY_FEEDBACK_RESULT_VERSION){if(digest(nativeExit.get(row.key))!==digest(old))bad('保留尾态不能暗中改值；有变化须显式替换');}
    else validateKeepState(old,nativeExit.get(row.key),request,factRefs);
   }
   projected.set(row.key,copy(old));
  }else if(row.decision==='REPLACE'){
   if(!text(row.replacementKey)||!nativeExit.has(row.replacementKey))bad('替换尾态须绑定本次明确报告的新状态');
   if(row.replacementKey!==row.key&&nativeExit.has(row.key))bad('改用新稳定键时不能同时复活旧键');
   projected.set(row.replacementKey,copy(nativeExit.get(row.replacementKey)));
  }else if(row.replacementKey!==''||nativeExit.has(row.key))bad('退役尾态不能同时重新报告同键');
 }
 for(const row of feedback.exit)projected.set(row.key,copy(row));
 const unchanged=new Set((request.previousDraft?.units||[]).filter(u=>draft.units.some(v=>digest(u)===digest(v))).map(u=>u.id));
 for(const row of materials){
  if(!['KEEP','REPLACE','REMOVE'].includes(row.decision)||!text(row.reason))bad('素材保留/替换/退役决策不完整');
  if(row.decision==='REPLACE'&&!feedback.usedMaterialIds.includes(row.id))bad('替换素材消费世代须由本次明确消费同ID的新快照');
  if(row.decision==='REMOVE'&&(basis.materialConsumers.some(c=>c.materialIds.includes(row.id)&&(c.supportUnitIds??c.unitIds).some(id=>unchanged.has(id)))||feedback.usedMaterialIds.includes(row.id)))bad('仍有未改单元或本次消费时，不能退役原素材consumer');
 }
 const kept=new Set(materials.filter(r=>r.decision==='KEEP').map(r=>r.id));
 const mapSupport=consumer=>{
  const ids=new Set(),current=new Set(draft.units.map(u=>u.id));
  for(const id of consumer.supportUnitIds??consumer.unitIds){
   const group=delta?.replacements?.find(g=>g.replaces.includes(id));
   if(group)for(const u of group.units){if(!current.has(u.id))bad('素材支持范围与已采用delta不符');ids.add(u.id);}
   else if(current.has(id))ids.add(id);
   else for(const u of draft.units)ids.add(u.id); // Unknown full rewrite: conservative, never forget by renaming.
  }
  return [...ids];
 };
 const materialConsumers=(basis?.materialConsumers||[]).map(c=>{
  return {...copy(c),materialIds:c.materialIds.filter(id=>kept.has(id)),supportUnitIds:mapSupport(c)};
 }).filter(c=>c.materialIds.length);
 if(feedback.usedMaterialIds.length)materialConsumers.push({candidateId,attemptId,packageIds:copy(packageIds),unitIds:draft.units.map(u=>u.id),materialIds:copy(feedback.usedMaterialIds)});
 return seal({version,nativeFeedbackHash:digest(feedback),draftHash:contentHash(draft),basisSignature:basis?.signature??null,
  exit:[...projected.values()],materialConsumers});
}

export function feedbackResultSchema({basis=null,version=FEEDBACK_RESULT_VERSION}={}){
 if(!isFeedbackResultVersion(version))bad('完整结果回执版本缺失或不匹配');
 const str={type:'string'},array=items=>({type:'array',items}),obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
 const choice=values=>({type:'string',enum:values});
 const decisions=(items,count)=>({...array(items),minItems:count,maxItems:count});
 const keys=values=>values.length?choice(values):str;
 const evidence=array(obj({unitId:str,shotId:str,field:choice([...unitFields,...shotFields]),quote:str}));
 const continuation=version===FEEDBACK_RESULT_VERSION?{continuation:array(obj({unitId:str,key:str,value:str,authority:choice(['SOURCE','DESIGN','CHARACTER_CLAIM','INTERPRETATION']),verdict:choice(['CONTINUES','CHANGED','UNKNOWN']),reason:str,evidence}))}:{};
 return {resultRevision:obj({baseSignature:choice([basis?.signature??'']),exitDecisions:decisions(obj({key:keys((basis?.exit||[]).map(s=>s.key)),decision:choice(['KEEP','REPLACE','REMOVE']),replacementKey:str,reason:str,evidence,...continuation}),(basis?.exit||[]).length),materialDecisions:decisions(obj({id:keys(basis?.materialIds||[]),decision:choice(['KEEP','REPLACE','REMOVE']),reason:str}),(basis?.materialIds||[]).length)}),
  entryEvidence:array(obj({key:str,verdict:choice(['CONSISTENT','CONFLICT','UNRESOLVED']),reason:str,priorEvidence:evidence,currentEvidence:evidence}))};
}

export const legacyFeedbackResultHint='完整结果回执production-feedback-result-v1：本次仍只有一次原整编调用，不另设审稿岗位。previousDraft.feedbackBasis是已采用基稿的真实尾态及原素材consumer，不是新原文。resultRevision.baseSignature逐字复用其signature，无basis则空串且两个决策数组为空。exitDecisions必须逐键覆盖basis.exit：KEEP明确复核整编后仍有效，REPLACE在productionFeedback.exit给出新状态并填replacementKey（允许新稳定键），REMOVE仅用于正文确已撤除且非锁定约定；KEEP/REMOVE的replacementKey为空串。每项给原因及本次完整结果末单元的逐字evidence[{unitId,shotId,field,quote}]，单元级证据shotId为空串。不能因只改两格就把整稿依赖回执缩成两格回执，不能复活被改动推翻的旧状态。materialDecisions逐项覆盖basis.materialIds；KEEP保留原consumer/原快照出处，不声称本次新消费；REMOVE须确认整稿已不用且原消费单元没有未改正文。原entry/needs/conflicts不继承。entryEvidence仅用于DIRECT且已有真实actual时，逐项复核SOURCE入口中引用前集事实但actual漏键的事项：以完整前尾和本次完成稿各自逐字证据报告CONSISTENT/CONFLICT/UNRESOLVED及原因。CONSISTENT是有来源的入口复核，不是补造actual或一致性验收；有真实矛盾必须同时保留conflicts，证据不足用UNRESOLVED，不按未出现推断不存在。不得把对白、解释、锁定冲突或DESIGN漏键借此放行。';
export const feedbackResultHint=legacyFeedbackResultHint.replace(LEGACY_FEEDBACK_RESULT_VERSION,FEEDBACK_RESULT_VERSION).replace('每项给原因及本次完整结果末单元的逐字evidence[{unitId,shotId,field,quote}]，单元级证据shotId为空串。','每项给原因及逐字evidence[{unitId,shotId,field,quote}]，单元级证据shotId为空串，并显式给continuation数组，不得缺省或null。默认全部引文属于末单元，continuation=[]；KEEP须至少含末单元exitState内包含旧value原文的逐字期末正证。KEEP只可在key/value/authority及其他状态字段完全相同的前提下增补合法事实sourceRefs，不得删改原引用、重复引用或引用对白/guidance。仅KEEP允许较早正证：continuation须按正文顺序逐项覆盖最早证据之后全部后续单元直到末单元，每项{unitId,key,value,authority,verdict:"CONTINUES"|"CHANGED"|"UNKNOWN",reason,evidence}；仅有明确持续正证时报告CONTINUES，同key/value/authority须逐字复用旧状态，并至少提供该单元exitState内包含旧value原文的逐字期末引文。没有出现、未描写或只有无关引文不能证明持续；有改变或不确定分别报告CHANGED/UNKNOWN并保留冲突，不能猜补。REPLACE/REMOVE的全部引文仍须属于末单元且continuation=[]。逐字引文合法只证明出处，不保证语义结论正确。');
export function feedbackResultHintForVersion(version){
 if(!isFeedbackResultVersion(version))bad('完整结果回执版本缺失或不匹配');
 return version===LEGACY_FEEDBACK_RESULT_VERSION?legacyFeedbackResultHint:feedbackResultHint;
}
