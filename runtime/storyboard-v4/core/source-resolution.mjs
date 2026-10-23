import {digest,fail} from './shared.mjs';
import {createStore} from './store.mjs';
import {makeBoundaryContext,predecessorFactRefs} from '../../episode-boundary.mjs';

export const SOURCE_RESOLUTION_VERSION='production-source-resolution-v1';
const text=x=>typeof x==='string'&&Boolean(x.trim())&&!x.includes('\0');
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).every(k=>keys.includes(k));
const basis=source=>digest({sourceRows:source.sourceRows,dialogue:source.dialogue});
const payload=r=>({version:r.version,sourceHash:r.sourceHash,kind:r.kind,sourceRefs:r.sourceRefs,instruction:r.instruction,conflicts:r.conflicts,...(r.speaker?{speaker:r.speaker}:{}),...(r.boundaryBinding?{boundaryBinding:r.boundaryBinding}:{}),...(r.assetBinding?{assetBinding:r.assetBinding}:{}),approval:r.approval});
const recapBinding=(d,c)=>({contextHash:digest(d.production.boundary),contextRowsHash:digest(d.source.contextRows),planHash:digest(d.plan),feedbackHash:digest(c.productionFeedback)});

function assertAssetQuantitySource(source,value,bad){
 const b=value.assetBinding,keys=['assetKey','assetHash','sourceQuantity','catalogueQuantity','planHash','feedbackHash'];
 if(!exact(b,keys)||!keys.every(k=>text(b[k]))||['assetHash','planHash','feedbackHash'].some(k=>!/^[a-f0-9]{64}$/.test(b[k]))
  ||b.assetKey.length>150||b.sourceQuantity.length>60||b.catalogueQuantity.length>60||b.sourceQuantity===b.catalogueQuantity)bad('资产装载量裁决须绑定原资产、原计划回执及两个不同的精确数量原句。');
 const assets=source.assets?.filter(a=>a.key===b.assetKey)||[],rows=value.sourceRefs.map(id=>source.sourceRows.find(r=>r.id===id));
 if(assets.length!==1||digest(assets[0])!==b.assetHash||!rows.length||rows.some(r=>!r||r.evidenceRole==='guidance'||!r.text.includes(b.sourceQuantity))
  ||![assets[0].relationNote,assets[0].preparation?.note].some(s=>typeof s==='string'&&s.includes(b.catalogueQuantity)))bad('本集原文数量或原资产目录证据已变化，不能套用旧装载量裁决。');
}
function assertAssetQuantity(d,value,bad){
 assertAssetQuantitySource(d.source,value,bad);
 const item=value.conflicts?.[0],candidate=d.candidates?.find(c=>c.id===item?.candidateId),feedback=candidate?.productionFeedback;
 const conflict=feedback?.conflicts?.find(c=>digest(c)===item.conflictHash),b=value.assetBinding;
 if(value.conflicts?.length!==1||candidate?.stage!=='plan'||candidate.status!=='adopted'||d.candidates.findLast(c=>c.stage==='plan'&&c.status==='adopted')?.id!==candidate.id
  ||!conflict||conflict.key!==b.assetKey+'/本集装载量'||digest(d.plan)!==b.planHash||digest(feedback)!==b.feedbackHash
  ||conflict.sourceRefs.length!==value.sourceRefs.length||conflict.sourceRefs.some(id=>!value.sourceRefs.includes(id)))bad('装载量解释仅可解决当前本集采用计划中的单个精确资产数量冲突。');
 if(!Array.isArray(item.needHashes)||item.needHashes.some(hash=>feedback.needs.find(n=>digest(n)===hash)?.target!==conflict.key))bad('装载量裁决不能核销无关资产或设计需求。');
}

// A recap interprets one repeated action; it never changes an entry, actual tail or lock.
function assertActionRecap(d,value,bad){
 const item=value.conflicts?.[0],candidate=d.candidates?.find(c=>c.id===item?.candidateId),feedback=candidate?.productionFeedback;
 const conflict=feedback?.conflicts?.find(c=>digest(c)===item.conflictHash),context=d.production?.boundary;
 const entry=feedback?.entry?.find(s=>s.key===conflict?.key),actual=context?.actual?.states?.find(s=>s.key===conflict?.key);
 if(value.conflicts?.length!==1||!d.plan||candidate?.stage!=='plan'||candidate.status!=='adopted'
  ||d.candidates.findLast(c=>c.stage==='plan'&&c.status==='adopted')?.id!==candidate.id||!conflict||feedback.relation!=='DIRECT'
  ||!entry||entry.authority!=='SOURCE'||actual?.authority!=='SOURCE'||entry.value!==actual.value
  ||[...(context?.agreements||[]),...(d.production?.outgoingAgreements||[])].some(s=>s.key===conflict.key))bad('承接复述仅可核对当前采用计划中与真实SOURCE尾态完全一致、没有锁定约定的单项开场动作。');
 if(context?.mode!=='ACTUAL'||!context.actual?.validated||!context.actual.unit?.shots?.length
  ||!text(context.seed?.previousSource?.sourceTextHash)||!text(context.seed?.currentOpening?.sourceTextHash)
  ||makeBoundaryContext(context).versionId!==context.versionId)bad('承接复述必须绑定合法选定的相邻前集实际采用尾稿与双源。');
 const keys=['contextHash','contextRowsHash','planHash','feedbackHash'];
 if(!exact(value.boundaryBinding,keys)||!keys.every(k=>/^[a-f0-9]{64}$/.test(value.boundaryBinding[k]||''))
  ||digest(value.boundaryBinding)!==digest(recapBinding(d,candidate)))bad('承接复述的当前双源、上下文、实际尾稿或计划回执已变化。');
 const previous=predecessorFactRefs(context,d.source),spoken=new Set(d.source.dialogue.flatMap(q=>q.sourceIds||[q.rowId]));
 const current=new Set(d.source.sourceRows.filter(r=>r.kind==='action'&&r.evidenceRole!=='guidance'&&!spoken.has(r.id)).map(r=>r.id));
 if(value.sourceRefs.length!==conflict.sourceRefs.length||conflict.sourceRefs.some(id=>!value.sourceRefs.includes(id))
  ||value.sourceRefs.some(id=>!previous.has(id)&&!current.has(id))||!value.sourceRefs.some(id=>previous.has(id))||!value.sourceRefs.some(id=>current.has(id))
  ||!entry.sourceRefs.some(id=>previous.has(id)))bad('承接复述须精确覆盖该冲突的前集验证动作与本集动作，guidance和对白不能自证。');
 const need=feedback.needs.find(n=>digest(n)===item.needHashes?.[0]);
 if(item.needHashes?.length!==1||!need||need.stage!==1||need.target!=='OPENING_CONTINUITY'||need.blocking!==true
  ||need.packageIds.length!==1||need.packageIds[0]!==d.plan.workPackages[0].id
  ||need.sourceRefs.length!==value.sourceRefs.length||need.sourceRefs.some(id=>!value.sourceRefs.includes(id)))bad('承接复述只能解决同一开场包的精确OPENING_CONTINUITY需求。');
}

// Human decisions are an independent trusted input, never a field accepted from model output.
export function recordSourceResolution(d,value,approval){
 const bad=message=>fail('SOURCE_RESOLUTION',message);
 if(d.web?.sourceStale||d.operations.some(o=>o.status==='running'||o.status==='unknown'&&o.cancelAcknowledgement?.acceptUnknownUsage!==true))bad('先核对原文及未结请求，不能在派单中修改制作取舍。');
 if(d.adopted?.length||d.candidates.some(c=>c.stage!=='plan'&&(c.raw?.trim()||c.output!=null)))bad('已有付费正文须先定位局部返修，不能直接改其制作解释。');
 if(!exact(approval,['actorId','reference','answer'])||!['actorId','reference','answer'].every(k=>text(approval[k]))||approval.reference.length>500||approval.answer.length>2000)bad('缺少独立的人类明确决定及可追溯引用。');
 if(!exact(value,['sourceHash','kind','sourceRefs','instruction','conflicts','speaker','boundaryBinding','assetBinding'])||value.sourceHash!==basis(d.source)
  ||!['TIME_LIGHTING_SPLIT','DELAYED_BROADCAST','SPEAKER_CORRECTION','BOUNDARY_ACTION_RECAP','ASSET_QUANTITY_SOURCE_PRIORITY'].includes(value.kind)||!text(value.instruction)||value.instruction.length>1800
  ||!Array.isArray(value.sourceRefs)||!value.sourceRefs.length||new Set(value.sourceRefs).size!==value.sourceRefs.length||!Array.isArray(value.conflicts))bad('制作解释须绑定当前完整原文、明确类型与有限坐标。');
 const recap=value.kind==='BOUNDARY_ACTION_RECAP';
 if(recap){
  if(d.operations.some(o=>o.stage!=='plan'))bad('承接复述须在原作者首次派发前明确，不能覆盖已有正文作业。');
  assertActionRecap(d,value,bad);
 }else if(value.boundaryBinding!==undefined)bad('源内制作解释不能夹带跨集核销权限。');
 const refs=new Set(d.source.sourceRows.map(r=>r.id));
 if(!recap&&value.sourceRefs.some(id=>!refs.has(id)))bad('不能把前情、路径或未知坐标当作本集修改范围。');
 if(value.kind==='ASSET_QUANTITY_SOURCE_PRIORITY'){
  if(d.web?.stopped||d.web?.pauseRequested||d.operations.some(o=>o.stage!=='plan'))bad('装载量裁决只在本集首个作者派发前接收，不能越过停止或人工暂停。');
  assertAssetQuantity(d,value,bad);
 }else if(value.assetBinding!==undefined)bad('非装载量解释不能夹带资产备注裁决。');
 if(value.kind==='SPEAKER_CORRECTION'){
  const q=d.source.dialogue.find(q=>q.id===value.speaker?.lineId);
  if(!exact(value.speaker,['lineId','from','to'])||!q||q.speaker!==value.speaker.from||!text(value.speaker.to)||value.speaker.to.length>60||value.speaker.to===q.speaker||!value.sourceRefs.includes(q.rowId))bad('说话人修正须精确绑定原对白，保留原句、声道和表演提示。');
 }else if(value.speaker!==undefined)bad('非说话人读法不能夹带改说话人。');
 const hard=new Set([...(d.production?.boundary?.agreements||[]),...(d.production?.outgoingAgreements||[]),...(d.production?.boundary?.actual?.states||[])].map(s=>s.key));
 const seen=new Set();
 for(const c of value.conflicts){
  const candidate=d.candidates.find(x=>x.id===c.candidateId),feedback=candidate?.productionFeedback;
  const conflict=feedback?.conflicts?.find(x=>digest(x)===c.conflictHash);
  if(!exact(c,['candidateId','conflictHash','needHashes'])||candidate?.stage!=='plan'||candidate.status!=='adopted'||!conflict||!recap&&hard.has(conflict.key)
   ||conflict.sourceRefs.some(id=>!value.sourceRefs.includes(id))||!Array.isArray(c.needHashes)||new Set(c.needHashes).size!==c.needHashes.length||seen.has(`${c.candidateId}:${c.conflictHash}`))bad('只能解决明确批准的本集源内冲突，不能覆盖实际尾态或锁定约定。');
  seen.add(`${c.candidateId}:${c.conflictHash}`);
  for(const hash of c.needHashes){const need=feedback.needs.find(n=>digest(n)===hash);
   if(!need||![1,3].includes(need.stage)||need.sourceRefs.some(id=>!value.sourceRefs.includes(id))||!need.sourceRefs.some(id=>conflict.sourceRefs.includes(id)))bad('缺料核销必须精确绑定同一原冲突与完整本集坐标。');
  }
 }
 const result={version:SOURCE_RESOLUTION_VERSION,...structuredClone(value),approval:structuredClone(approval)};
 result.id=digest(payload(result));
 return {...result,at:new Date().toISOString()};
}

export function currentSourceResolutions(source,resolutions=[]){
 for(const r of resolutions){
  if(r.version!==SOURCE_RESOLUTION_VERSION||r.id!==digest(payload(r))||r.sourceHash!==basis(source))fail('SOURCE_RESOLUTION_STALE','已确认制作解释与当前原文或批准记录不匹配，不能静默忽略。');
  if(r.kind==='ASSET_QUANTITY_SOURCE_PRIORITY')assertAssetQuantitySource(source,r,message=>fail('SOURCE_RESOLUTION_STALE',message));
 }
 return resolutions;
}
export function currentDocumentSourceResolutions(d){
 const resolutions=currentSourceResolutions(d.source,d.production?.sourceResolutions);
 for(const r of resolutions){
  if(r.kind==='BOUNDARY_ACTION_RECAP')assertActionRecap(d,r,message=>fail('SOURCE_RESOLUTION_STALE',message));
  if(r.kind==='ASSET_QUANTITY_SOURCE_PRIORITY')assertAssetQuantity(d,r,message=>fail('SOURCE_RESOLUTION_STALE',message));
 }
 return resolutions;
}
export function sourceResolutionFeedback(d,candidate){
 const resolved=new Set(currentDocumentSourceResolutions(d).flatMap(r=>r.conflicts.filter(c=>c.candidateId===candidate.id).map(c=>c.conflictHash)));
 if(!resolved.size)return candidate.productionFeedback;
 return {...candidate.productionFeedback,conflicts:candidate.productionFeedback.conflicts.filter(c=>!resolved.has(digest(c)))};
}
export function sourceResolutionForNeed(d,candidate,need){
 return currentDocumentSourceResolutions(d).find(r=>r.conflicts.some(c=>c.candidateId===candidate.id&&c.needHashes.includes(digest(need))));
}
export function resolvedDialogue(source,resolutions=[]){
 const overrides=currentSourceResolutions(source,resolutions).filter(r=>r.kind==='SPEAKER_CORRECTION');
 return (source.dialogue||[]).map(q=>{const r=overrides.findLast(r=>r.speaker.lineId===q.id);return r?{...q,speaker:r.speaker.to}:q;});
}

// Only pre-authoring human decisions. Registration is immutable; no model or source write.
export function createSourceResolutionRegistry(directory){
 const store=createStore(directory);
 return {
  async register(binding,source,value,approval){
   if(!text(binding?.projectId)||!text(binding.episodeId)||value.conflicts?.length)fail('SOURCE_RESOLUTION','前置登记不核销任何旧任务冲突。');
   const resolution=recordSourceResolution({source,operations:[],candidates:[],adopted:[]},value,approval);
   await store.create(binding.episodeId,{projectId:binding.projectId,episodeId:binding.episodeId,sourceResolutions:[resolution]});return resolution;
  },
  async read(binding,source){
   let record;try{record=await store.read(binding.episodeId);}catch(e){if(e.code==='ENOENT')return [];throw e;}
   if(record.projectId!==binding.projectId||record.episodeId!==binding.episodeId)fail('SOURCE_RESOLUTION_STALE','前置决定不属于当前项目与本集。');
   return currentSourceResolutions(source,record.sourceResolutions);
  }
 };
}
