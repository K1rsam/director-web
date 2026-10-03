import {digest,fail} from './shared.mjs';
import {resolveSelection} from './selection.mjs';

export const EXECUTION_PROJECTION_VERSION='execution-batches-v1';
const intersects=(a,b)=>a.some(id=>b.has(id));
export const executionBaseHash=({source,plan,choice,settings,rulesSnapshot,voiceReference=null})=>digest({source,plan,choice,settings,rulesSnapshot,voiceReference});

// Execution targets are not creative limits: indivisible spans may exceed either target.
export function buildExecutionBatches(input){
 const {source,plan,choice,packageId}=input,owner=plan.workPackages.find(w=>w.id===packageId);
 if(!owner)fail('PACKAGE','执行批次缺少原工作包');
 const owned=new Set(owner.sourceRefs),refs=source.sourceRows.filter(r=>owned.has(r.id)).map(r=>r.id),rank=new Map(refs.map((id,i)=>[id,i]));
 const units=plan.provisionalUnits.filter(u=>u.packageId===packageId),selected=new Set(resolveSelection(plan,choice).selectedIds);
 const candidates=plan.fantasyCandidates.filter(c=>selected.has(c.id)&&intersects(c.anchorRefs,owned));
 const blocked=new Set();
 const protect=values=>{const positions=values.filter(id=>rank.has(id)).map(id=>rank.get(id));if(!positions.length)return;for(let i=Math.min(...positions);i<Math.max(...positions);i++)blocked.add(i);};
 for(const u of units)protect(u.sourceRefs);
 for(const q of source.dialogue)protect(q.sourceIds);
 for(const c of candidates)protect(c.anchorRefs);
 const atoms=[];let start=0;
 for(let i=0;i<refs.length;i++)if(i===refs.length-1||!blocked.has(i)){const sourceRefs=refs.slice(start,i+1),set=new Set(sourceRefs),rough=units.filter(u=>intersects(u.sourceRefs,set));atoms.push({sourceRefs,provisionalUnitIds:rough.map(u=>u.id),estimatedSeconds:rough.reduce((n,u)=>n+u.secondsRange[1],0)});start=i+1;}
 const chunks=[];let chunk=null;
 for(const atom of atoms){
  if(chunk&&(chunk.provisionalUnitIds.length+atom.provisionalUnitIds.length>5||chunk.estimatedSeconds+atom.estimatedSeconds>150)){chunks.push(chunk);chunk=null;}
  if(!chunk)chunk={sourceRefs:[],provisionalUnitIds:[],estimatedSeconds:0};
  chunk.sourceRefs.push(...atom.sourceRefs);chunk.provisionalUnitIds.push(...atom.provisionalUnitIds);chunk.estimatedSeconds+=atom.estimatedSeconds;
 }
 if(chunk)chunks.push(chunk);
 const batches=chunks.map((item,index)=>({id:`${packageId}-B${String(index+1).padStart(2,'0')}`,packageId,index,...(owner.eventId?{eventId:owner.eventId}:{}),...item,selectedFantasyIds:candidates.filter(c=>intersects(c.anchorRefs,new Set(item.sourceRefs))).map(c=>c.id),exceedsSoftTarget:item.provisionalUnitIds.length>5||item.estimatedSeconds>150}));
 const manifest={version:EXECUTION_PROJECTION_VERSION,generation:input.generation??null,packageId,baseHash:executionBaseHash(input),batches};
 return {...manifest,hash:digest(manifest),accepted:{}};
}

export function validateExecutionProjection(input,projection){
 if(projection?.version!==EXECUTION_PROJECTION_VERSION)fail('EXECUTION_VERSION','未知执行批次版本');
 const manifest=buildExecutionBatches({...input,packageId:projection.packageId,generation:projection.generation}),batch=manifest.batches.find(b=>b.id===projection.id);
 if(!batch||projection.manifestHash!==manifest.hash||digest(projection.batch)!==digest(batch))fail('EXECUTION_STALE','执行批次与原资料、计划或选择不一致');
 return batch;
}

export function executionState(d,packageId){
 const manifest=d.executionBatches?.[packageId];
 if(!manifest)return {version:null,packageId,total:0,completed:0,nextBatchId:null,complete:false,partial:false};
 const completed=manifest.batches.filter(b=>manifest.accepted[b.id]).length;
 return {version:manifest.version,packageId,total:manifest.batches.length,completed,nextBatchId:manifest.batches.find(b=>!manifest.accepted[b.id])?.id??null,complete:completed===manifest.batches.length,partial:completed>0&&completed<manifest.batches.length};
}

// Only active manifests count. Explicit archival removes them without deleting paid candidates.
export function hasExecutionDrafts(d){
 return Object.values(d.executionBatches||{}).some(m=>Object.keys(m.accepted||{}).length||d.candidates.some(c=>c.executionManifestHash===m.hash&&c.resolvedBy!=='selection_reset'&&(c.raw?.trim()||c.output!=null||c.draft!=null)));
}

export function executionProjection(d,manifest,batch){
 if(manifest.version!==EXECUTION_PROJECTION_VERSION||manifest.baseHash!==executionBaseHash(d))fail('EXECUTION_STALE','已保存执行批次的原资料、计划或选择已变化，请保留现稿');
 let predecessor=null;
 if(batch.index){
  const previous=manifest.batches[batch.index-1],candidateId=manifest.accepted[previous.id],candidate=d.candidates.find(c=>c.id===candidateId);
  if(!candidate?.draft?.units?.length)fail('DEPENDENCY_NOT_READY','前一执行批次尚无完整已采用稿');
  predecessor={batchId:previous.id,candidateId,draftHash:digest(candidate.draft),unit:structuredClone(candidate.draft.units.at(-1))};
 }
 return {version:EXECUTION_PROJECTION_VERSION,generation:manifest.generation,manifestHash:manifest.hash,id:batch.id,packageId:manifest.packageId,index:batch.index,total:manifest.batches.length,batch:structuredClone(batch),predecessor};
}

export function savedExecutionProjection(d,op){
 if(!op.executionProjectionVersion)return null;
 if(op.executionProjectionVersion!==EXECUTION_PROJECTION_VERSION)fail('EXECUTION_VERSION','未知已付执行批次版本');
 const manifest=d.executionBatches?.[op.packageIds[0]],batch=manifest?.batches.find(b=>b.id===op.executionBatchId);
 if(!batch||manifest.hash!==op.executionManifestHash)fail('EXECUTION_STALE','原执行批次已归档或变更，不能替换当前稿');
 const current=executionProjection(d,manifest,batch);
 if(digest(current)!==digest(op.executionBatch))fail('EXECUTION_STALE','前序批次或本次执行范围已变化');
 return structuredClone(op.executionBatch);
}

export function combinedExecutionDraft(d,manifest,extra){
 const drafts=manifest.batches.map(b=>extra?.batchId===b.id?extra.draft:d.candidates.find(c=>c.id===manifest.accepted[b.id])?.draft);
 if(drafts.some(x=>!x))return null;
 return {schemaVersion:d.version,units:drafts.flatMap(x=>x.units),fantasyRealization:drafts.flatMap(x=>x.fantasyRealization)};
}
