import {digest,fail} from './shared.mjs';
import {baseDraftHash} from './delta.mjs';
import {validateDraftEvidence,effectiveProductionFeedback} from './production-feedback-result.mjs';

export const ENTRY_REVIEW_VERSION='boundary-entry-review-v3';
export const ENTRY_CONTEXT_VERSION='adopted-entry-context-v1';
export const ENTRY_BASIS_VERSION='production-entry-basis-v1';
const copy=x=>structuredClone(x),text=x=>typeof x==='string'&&Boolean(x.trim());
const seal=body=>({...body,signature:digest(body)});
const unique=xs=>new Set(xs).size===xs.length;
const bad=message=>fail('PRODUCTION_ENTRY_EVIDENCE',`${message}；保留已付稿与原生回执，不付费重试或猜补入口。`);
const stringsIn=v=>typeof v==='string'?[v]:v&&typeof v==='object'?Object.values(v).flatMap(stringsIn):[];
const evidence=(proofs,draft)=>{
 if(!Array.isArray(proofs)||!proofs.length)bad('缺少逐字正证');
 for(const proof of proofs){
  if(['props','participants'].includes(proof?.field)&&!proof.shotId){
   const unit=draft?.units?.find(u=>u.id===proof.unitId);
   if(!unit||!text(proof.quote)||!stringsIn(unit[proof.field]).some(s=>s.includes(proof.quote)))bad('入口资产证据坐标或逐字引文不匹配');
  }else try{validateDraftEvidence([proof],draft);}catch(error){bad(error.message);}
 }return true;
};
function unseal(value,version){
 if(value?.version!==version)bad('入口证据版本缺失');
 const {signature,...body}=value;if(signature!==digest(body))bad('入口证据身份已变化');return body;
}

// Full adopted text is evidence, not a manufactured actual.states inventory.
export function makeEntryEvidenceContext(previous,context){
 if(!context?.actual?.validated||previous?.id!==context.selected?.runId||previous.web?.sourceStale
  ||!previous.assembly?.draft?.units?.length||previous.assembly.validation?.errors?.length
  ||previous.production?.blocking||previous.production?.pendingRepair)return null;
 const draft=previous.assembly.draft;
 if(digest(draft.units.at(-1))!==digest(context.actual.unit))return null;
 return seal({version:ENTRY_CONTEXT_VERSION,selected:copy(context.selected),actualVersion:context.actual.version,
  sourceTextHash:context.seed.previousSource?.sourceTextHash,sourceHash:digest(previous.source),draftHash:digest(draft),
  lineageHash:digest(previous.adopted),draft:copy(draft)});
}
function validateContext(value,context){
 unseal(value,ENTRY_CONTEXT_VERSION);
 if(!context?.actual?.validated||digest(value.selected)!==digest(context.selected)||value.actualVersion!==context.actual.version
  ||value.sourceTextHash!==context.seed.previousSource?.sourceTextHash||value.draftHash!==digest(value.draft)
  ||!text(value.sourceHash)||!text(value.lineageHash)||digest(value.draft?.units?.at(-1))!==digest(context.actual.unit))bad('完整前稿与当前选版、来源或actual尾单元不匹配');
 return value;
}

// Include the latest saved attempt before the current adoption: a full fallback
// must not erase a dependency merely because its earlier receipt was unresolved.
export function freezeEntryBasis(run,draft,packageIds,{candidateId=null}={}){
 const claims=new Map();
 const end=candidateId?run.candidates.findIndex(c=>c.id===candidateId):run.candidates.length;
 for(const c of run.candidates.slice(0,end<0?0:end)){
  const op=run.operations.find(o=>o.attemptId===c.attemptId);
  if(!c.productionFeedback||c.stage==='plan'||!c.packageIds?.some(id=>packageIds.includes(id))||op?.productionSnapshot?.touchesOpening!==true)continue;
  if(c.entryProjection&&c.status==='adopted'){
   const projected=effectiveProductionFeedback(c).entry,old=op.previousDraft?.entryBasis?.claims||[];
   for(const claim of old)if(!projected.some(s=>s.key===claim.entry.key))claims.delete(claim.entry.key);
  }
  for(const entry of (c.entryProjection&&c.status==='adopted'?effectiveProductionFeedback(c):c.productionFeedback).entry||[])if(['SOURCE','DESIGN'].includes(entry.authority))claims.set(entry.key,{candidateId:c.id,attemptId:c.attemptId,entry:copy(entry)});
 }
 return seal({version:ENTRY_BASIS_VERSION,draftHash:baseDraftHash(draft),claims:[...claims.values()]});
}

const normalized=s=>typeof s==='string'?s.replace(/[\s\p{P}]/gu,''):'';
const strings=d=>(d?.units||[]).flatMap(stringsIn).filter(text);
function validateActualConsumption(rows,{context,entries,draft,evidenceContext,relation='DIRECT',conflicts=[],allowConflicts=false}){
 const states=(context?.actual?.states||[]).filter(s=>['SOURCE','DESIGN'].includes(s.authority));
 if(!Array.isArray(rows)||!unique(rows.map(r=>r?.key))||rows.length!==states.length||rows.some(r=>!states.some(s=>s.key===r?.key)))bad('须逐项说明全部actual状态是否被开场消费，不能在作者与整编中连续漏报');
 for(const row of rows){
  const actual=states.find(s=>s.key===row.key),entry=entries.find(s=>s.key===row.entryKey);
  if(!text(row.reason)||!['CONSUMED','NOT_CONSUMED','CONFLICT'].includes(row.decision))bad('actual消费结论不完整');
  evidence(row.currentEvidence,draft);
  if(row.currentEvidence.some(p=>p.unitId!==draft.units[0].id))bad('actual消费须核对本稿开场，不拿后续状态代替');
  if(row.decision==='CONSUMED'){
   if(!entry||entry.authority!==actual.authority)bad('已消费actual必须绑定本次同等级入口，不能用漏报或降级掩盖');
   evidence(row.priorEvidence,evidenceContext?.draft);
  }else if(row.decision==='CONFLICT'){
   if(!allowConflicts||!conflicts.some(c=>c.key===row.key))bad('实际承接冲突仍须关门，不能用同义复核解除');
   evidence(row.priorEvidence,evidenceContext?.draft);
  }else if(row.entryKey!==''||relation==='DIRECT'&&normalized(actual.value).length>=2&&strings({units:draft.units.slice(0,1)}).map(normalized).some(s=>s.includes(normalized(actual.value))))bad('开场仍有逐字消费正证，不能把actual声明为未消费');
 }
}
export function projectEntryCoverage({request,feedback,draft}){
 if(request.stage!=='finish'||request.productionSnapshot?.entryReviewVersion!==ENTRY_REVIEW_VERSION||!request.productionSnapshot.touchesOpening)return null;
 const basis=request.previousDraft?.entryBasis,coverage=feedback.entryCoverage;
 if(basis)unseal(basis,ENTRY_BASIS_VERSION);
 const claims=basis?.claims||[],rows=coverage?.decisions,keys=claims.map(c=>c.entry.key);
 if(coverage?.complete!==true||coverage.basisSignature!==(basis?.signature??'')||!Array.isArray(rows)
  ||!unique(rows.map(r=>r?.key))||rows.length!==keys.length||rows.some(r=>!keys.includes(r?.key)))bad('入口消费决策必须完整覆盖已保存基稿，不能静默漏报');
 const native=new Map(feedback.entry.map(s=>[s.key,s])),entry=new Map(),coverageEvidenceSources=[];
 for(const row of rows){
  const old=claims.find(c=>c.entry.key===row.key).entry;
  if(!['KEEP','REPLACE','REMOVE'].includes(row.decision)||!text(row.reason))bad('入口消费决策不完整');
  const shared=row.decision==='KEEP'&&Array.isArray(row.currentEvidence)&&row.currentEvidence.length===0&&Array.isArray(coverage.actualDecisions)
   ?coverage.actualDecisions.find(a=>a?.key===row.key&&a.entryKey===row.key&&a.decision==='CONSUMED'):null;
  evidence(shared?shared.currentEvidence:row.currentEvidence,draft);
  if(shared)coverageEvidenceSources.push({key:row.key,source:'entryCoverage.actualDecisions',actualKey:shared.key});
  if(row.decision==='KEEP'){
   if(row.replacementKey!==''||native.has(row.key)&&(native.get(row.key).value!==old.value||native.get(row.key).authority!==old.authority))bad('保留入口不能暗中改值或证据等级');
   entry.set(row.key,copy(native.get(row.key)??old));
  }else if(row.decision==='REPLACE'){
   if(!text(row.replacementKey)||!native.has(row.replacementKey)||row.replacementKey!==row.key&&native.has(row.key))bad('替换入口须明确报告替代项');
   if(native.get(row.replacementKey).authority!==old.authority)bad('替换入口不能改变原证据等级');
   entry.set(row.replacementKey,copy(native.get(row.replacementKey)));
  }else{
   evidence(row.priorEvidence,request.previousDraft);
   const witnesses=[old.value,...row.priorEvidence.map(p=>p.quote)].map(normalized).filter(s=>s.length>=2),current=strings(draft).map(normalized);
   const oldOpening=request.previousDraft?.units?.[0];
   if(row.replacementKey!==''||native.has(row.key)||oldOpening&&draft.units.some(u=>digest(u)===digest(oldOpening))
    ||witnesses.some(w=>current.some(s=>s.includes(w))))bad('入口正证仍被正文消费，不能以REMOVE隐藏依赖');
  }
 }
 for(const s of feedback.entry)entry.set(s.key,copy(s));
 validateActualConsumption(coverage.actualDecisions,{context:request.episodeBoundary,entries:[...entry.values()],draft,evidenceContext:request.productionSnapshot.entryEvidenceContext,relation:feedback.relation,conflicts:feedback.conflicts,allowConflicts:true});
 return seal({version:ENTRY_REVIEW_VERSION,nativeFeedbackHash:digest(feedback),draftHash:baseDraftHash(draft),basisSignature:basis?.signature??'',entry:[...entry.values()],...(coverageEvidenceSources.length?{coverageEvidenceSources}:{})});
}

export function entryReviewEntries(feedback,review,basis){
 const entries=copy(feedback.entry),seen=new Set(entries.map(s=>s.key));
 for(const row of review.entryRestorations){
  const claim=basis.claims.find(c=>c.candidateId===row.candidateId&&c.entry.key===row.key);
  if(!claim||seen.has(row.key))bad('恢复入口须指向已付谱系中的遗漏项，不能臆造或覆盖当前项');
  entries.push(copy(claim.entry));seen.add(row.key);
 }
 return entries;
}
function neededEntries(context,entries,source){
 const spoken=new Set((source.dialogue||[]).flatMap(q=>q.sourceIds||[q.rowId]));
 const current=new Set((source.sourceRows||[]).filter(r=>['action','metadata'].includes(r.kind)&&r.evidenceRole!=='guidance'&&!spoken.has(r.id)).map(r=>r.id));
 const actual=new Map(context.actual.states.map(s=>[s.key,s]));
 return entries.filter(s=>['SOURCE','DESIGN'].includes(s.authority)&&(actual.has(s.key)?actual.get(s.key).value!==s.value
  :!(s.authority==='SOURCE'&&s.sourceRefs?.length&&s.sourceRefs.every(id=>current.has(id)))));
}
export function validateEntryReview(raw,{context,feedback,source,draft,evidenceContext,entryBasis,basisDraft=draft,boundaryFacts=[]}){
 if(raw?.version!==ENTRY_REVIEW_VERSION||!context?.actual?.validated||feedback?.relation!=='DIRECT'||!draft?.units?.length)bad('入口复核仅适用于当前真实直连采用稿');
 validateContext(evidenceContext,context);unseal(entryBasis,ENTRY_BASIS_VERSION);
 if(entryBasis.draftHash!==baseDraftHash(basisDraft))bad('入口基稿正文与保存谱系不匹配');
 if(raw.checkSignature!==digest({version:context.versionId,feedback})||raw.contextVersion!==context.versionId||raw.actualVersion!==context.actual.version
  ||raw.sourceHash!==digest(source)||raw.draftHash!==baseDraftHash(draft)||raw.evidenceContextSignature!==evidenceContext.signature||raw.basisSignature!==entryBasis.signature)bad('入口复核与当前来源、正文、谱系或前稿不匹配');
 if(!Array.isArray(raw.entryRestorations)||!Array.isArray(raw.entryRetirements)||!Array.isArray(raw.proofs)||!unique([...raw.entryRestorations,...raw.entryRetirements].map(r=>r?.key))||!unique(raw.proofs.map(r=>r?.key)))bad('入口证据项目缺失或重复');
 if(feedback.conflicts?.length)bad('入口复核不能解除明确硬冲突');
 const entries=entryReviewEntries(feedback,raw,entryBasis),locked=new Map((context.agreements||[]).map(s=>[s.key,s.value]));
 const spoken=new Set((source.dialogue||[]).flatMap(q=>q.sourceIds||[q.rowId]));
 const facts=new Set([...(source.sourceRows||[]),...(source.contextRows||[]),...boundaryFacts].filter(r=>r.kind!=='guidance'&&r.evidenceRole!=='guidance'&&r.kind!=='dialogue'&&!spoken.has(r.id)).map(r=>r.id));
 const actual=new Map(context.actual.states.map(s=>[s.key,s]));
 if(entries.some(s=>s.authority==='SOURCE'&&(!s.sourceRefs?.length||s.sourceRefs.some(id=>!facts.has(id)))||actual.has(s.key)&&actual.get(s.key).authority!==s.authority))bad('入口复核不能改证据等级或复活失效SOURCE坐标');
 if(entries.some(s=>entryBasis.claims.some(c=>c.entry.key===s.key&&c.entry.authority!==s.authority)))bad('旧稿同键入口也不能改变已付谱系的证据等级');
 if([...entries,...context.actual.states].some(s=>locked.has(s.key)&&locked.get(s.key)!==s.value))bad('入口复核不能覆盖锁定约定');
 for(const row of raw.entryRestorations){if(!text(row.reason))bad('遗漏消费恢复缺少原因');evidence(row.currentEvidence,draft);}
 const omitted=entryBasis.claims.filter(c=>!feedback.entry.some(s=>s.key===c.entry.key));
 const addressed=[...raw.entryRestorations,...raw.entryRetirements];
 if(omitted.length!==addressed.length||addressed.some(r=>!omitted.some(c=>c.candidateId===r.candidateId&&c.entry.key===r.key)))bad('历史入口的遗漏也须完整逐项恢复或携证退役，不能只修一个键放过其余');
 for(const row of raw.entryRetirements){
  const claim=omitted.find(c=>c.entry.key===row.key),replacement=entries.find(s=>s.key===row.replacementKey);
  if(!text(row.reason)||!['REPLACE','REMOVE'].includes(row.decision))bad('入口退役决定不完整');
  evidence(row.currentEvidence,draft);
  if(row.decision==='REPLACE'){
   if(!replacement||replacement.authority!==claim.entry.authority)bad('历史入口改键须由明确同等级替代项承接');
  }else{
   evidence(row.priorEvidence,basisDraft);
   const witnesses=[claim.entry.value,...row.priorEvidence.map(p=>p.quote)].map(normalized).filter(s=>s.length>=2);
   if(row.replacementKey!==''||witnesses.some(w=>strings(draft).map(normalized).some(s=>s.includes(w))))bad('正文仍消费的历史入口不能退役');
  }
 }
 validateActualConsumption(raw.actualDecisions,{context,entries,draft,evidenceContext});
 const needed=neededEntries(context,entries,source),reviewable=entries.filter(s=>['SOURCE','DESIGN'].includes(s.authority));
 // Additional native proofs are checked and retained, not mistaken for missing proof.
 if(needed.some(s=>!raw.proofs.some(p=>p?.key===s.key))||raw.proofs.some(p=>!reviewable.some(s=>s.key===p?.key)))bad('入口复核须完整覆盖当前同义差异和SOURCE/DESIGN缺键');
 for(const proof of raw.proofs){
  const entry=reviewable.find(s=>s.key===proof.key);
  if(!text(proof.reason)||!['CONSISTENT','CONFLICT','UNRESOLVED'].includes(proof.verdict)||proof.entryValue!==entry.value)bad('入口结论未绑定原入口值');
  if(proof.verdict==='CONFLICT')bad('真实矛盾必须保留为硬冲突，不能用复核放行');
  if(proof.verdict==='UNRESOLVED'&&!needed.some(s=>s.key===proof.key))bad('额外入口证据仍未确定，不能用同值跳过未决结论');
  if(proof.verdict==='CONSISTENT'){
   evidence(proof.priorEvidence,evidenceContext.draft);evidence(proof.currentEvidence,draft);
   if(proof.currentEvidence.some(p=>p.unitId!==draft.units[0].id))bad('入口证据不能借非开场单元的后续状态代替');
  }
 }
 const body={version:raw.version,checkSignature:raw.checkSignature,contextVersion:raw.contextVersion,actualVersion:raw.actualVersion,sourceHash:raw.sourceHash,draftHash:raw.draftHash,evidenceContextSignature:raw.evidenceContextSignature,basisSignature:raw.basisSignature,entryRestorations:copy(raw.entryRestorations),entryRetirements:copy(raw.entryRetirements),actualDecisions:copy(raw.actualDecisions),proofs:copy(raw.proofs)};
 const id=digest(body);if(raw.id&&raw.id!==id)bad('保存的入口复核身份不符');return {...body,id};
}
export function nativeEntryReview({request,feedback,draft,context=request.episodeBoundary,boundaryFacts=[]}){
 if(request.stage!=='finish'||request.productionSnapshot?.entryReviewVersion!==ENTRY_REVIEW_VERSION||!request.productionSnapshot.touchesOpening
  ||!context?.actual?.validated||feedback.relation!=='DIRECT'||context.versionId!==request.episodeBoundary?.versionId)return null;
 const basis=request.previousDraft?.entryBasis??seal({version:ENTRY_BASIS_VERSION,draftHash:baseDraftHash(draft),claims:[]});
 const entryRetirements=(feedback.entryCoverage?.decisions||[]).filter(r=>r.decision!=='KEEP'&&!feedback.entry.some(s=>s.key===r.key)).map(r=>({...copy(r),candidateId:basis.claims.find(c=>c.entry.key===r.key)?.candidateId}));
 return validateEntryReview({version:ENTRY_REVIEW_VERSION,checkSignature:digest({version:context.versionId,feedback}),contextVersion:context.versionId,actualVersion:context.actual.version,
  sourceHash:digest(request.source),draftHash:baseDraftHash(draft),evidenceContextSignature:request.productionSnapshot.entryEvidenceContext?.signature,basisSignature:basis.signature,entryRestorations:[],entryRetirements,actualDecisions:feedback.entryCoverage.actualDecisions,proofs:feedback.entryEvidence},
  {context,feedback,source:request.source,draft,evidenceContext:request.productionSnapshot.entryEvidenceContext,entryBasis:basis,basisDraft:request.previousDraft??draft,boundaryFacts});
}

export function entryCoverageSchema(basis,actualStates=[]){
 const str={type:'string'},choice=values=>({type:'string',enum:values}),arr=items=>({type:'array',items}),obj=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
 const evidence=arr(obj({unitId:str,shotId:str,field:choice(['initialState','exitState','scene','lighting','unitDirection','title','picture','camera','sound','transition','props','participants']),quote:str}));
 const actualKeys=actualStates.filter(s=>['SOURCE','DESIGN'].includes(s.authority)).map(s=>s.key);
 return {entryCoverage:obj({complete:{type:'boolean',enum:[true]},basisSignature:choice([basis?.signature??'']),decisions:{...arr(obj({key:basis?.claims?.length?choice(basis.claims.map(c=>c.entry.key)):str,decision:choice(['KEEP','REPLACE','REMOVE']),replacementKey:str,reason:str,priorEvidence:evidence,currentEvidence:evidence})),minItems:basis?.claims?.length??0,maxItems:basis?.claims?.length??0},actualDecisions:{...arr(obj({key:actualKeys.length?choice(actualKeys):str,decision:choice(['CONSUMED','NOT_CONSUMED','CONFLICT']),entryKey:str,reason:str,priorEvidence:evidence,currentEvidence:evidence})),minItems:actualKeys.length,maxItems:actualKeys.length}}),
  entryEvidence:arr(obj({key:str,entryValue:str,verdict:choice(['CONSISTENT','CONFLICT','UNRESOLVED']),reason:str,priorEvidence:evidence,currentEvidence:evidence}))};
}
export const entryEvidenceHint='通用入口携证boundary-entry-review-v3：previousDraft.entryBasis列出已付基稿中的入口依赖，entryCoverage.basisSignature逐字复用signature，decisions逐键KEEP/REPLACE/REMOVE，不能因full或delta缩窄回执。KEEP仍消费旧入口（可不重复entry，由程序保留）；REPLACE须在entry明确报告replacementKey；REMOVE仅为正文确已不用，须给旧稿priorEvidence及新稿currentEvidence，未改开场或仍含逐字消费正证时禁止退役。每项给reason，非替换replacementKey为空串。actualDecisions逐键覆盖全部actual.states：CONSUMED绑定同等级entryKey及完整前稿/本稿开场逐字正证；NOT_CONSUMED的entryKey为空且用本稿正证说明本次实际消费，不用未出现推断不存在；CONFLICT须同步保留conflicts，不能借作者和整编均漏报隐藏手部、持物、位置等真实不连续。无actual用[]。完整检查开场正文的实际消费者，新的入口也须报告entry，不以漏报解除门禁。DIRECT已有actual时，entryEvidence逐项覆盖SOURCE/DESIGN缺键与同键异值；每项entryValue绑定本次有效入口，CONSISTENT/CONFLICT/UNRESOLVED和reason、完整已采用前稿entryEvidenceContext.draft及本稿开场的逐字priorEvidence/currentEvidence。较早单元正证必须结合全部后续正文确认仍适用；未出现不等于状态持续或不存在。新设计须有正证说明不冲突，不能据缺键自行造状态。程序只校绑定、坐标与完整性，语义由本次原整编负责。真实矛盾保留conflicts；证据不足UNRESOLVED继续关门，不新增收费复核。不改SOURCE等级、实际尾态或已锁定约定；新协议不伪迁移旧FINAL。';
