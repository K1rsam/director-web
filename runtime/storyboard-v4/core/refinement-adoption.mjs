import {digest,fail} from './shared.mjs';
import {DELTA_VERSION,baseDraftHash,applyDelta} from './delta.mjs';
import {getRefinementBase} from './refinement-comparison.mjs';

export const REFINEMENT_SELECTION_VERSION='refinement-group-selection-v1';
const metadataMessage='该候选有整包承接或资料变化，无法可靠对应到局部修改组；不能仅采用部分组，基稿与完整候选保留供人工审看。';
const coordinates=units=>units.flatMap(u=>[u.id,...(u.shots||[]).map(s=>s.id)]);
const effectiveDelta=candidate=>candidate.refinementDelta||candidate.output;

function acceptanceGroups(d,candidate){
 const base=getRefinementBase(d,candidate)?.draft,delta=candidate&&effectiveDelta(candidate);
 if(!base||delta?.schemaVersion!==DELTA_VERSION||delta.baseDraftHash!==baseDraftHash(base)||!Array.isArray(delta.replacements)||!Array.isArray(candidate.draft?.units))return [];
 const replacements=delta.replacements;
 if(replacements.some(g=>!Array.isArray(g?.replaces)||!g.replaces.length||!Array.isArray(g.units)||!g.units.length||!Array.isArray(g.fantasyRealization)))return [];
 const parent=replacements.map((_,i)=>i),reasons=replacements.map(()=>new Set(['完整替换组中的单元必须一起采用。']));
 const root=i=>{while(parent[i]!==i)i=parent[i];return i;};
 const link=(indices,reason)=>{const unique=[...new Set(indices)];for(const i of unique){reasons[i].add(reason);parent[root(i)]=root(unique[0]);}};
 const oldOwner=new Map(replacements.flatMap((g,i)=>g.replaces.map(id=>[id,i]))),newOwner=new Map(replacements.flatMap((g,i)=>g.units.map(u=>[u.id,i])));
 const rawShotOwner=new Map(replacements.flatMap((g,i)=>g.units.flatMap(u=>(u.shots||[]).map(s=>[s.id,i]))));
 for(const u of candidate.draft.units){
  const indices=[newOwner.get(u.id),...(u.shots||[]).map(s=>rawShotOwner.get(s.id))].filter(i=>i!==undefined);
  if(new Set(indices).size>1)link(indices,'完整候选归一化已将这些替换合成同一单元，必须一起采用。');
 }
 const oldShots=new Map(base.units.flatMap(u=>(u.shots||[]).map(s=>[s.id,u.id]))),newShots=new Map(candidate.draft.units.flatMap(u=>(u.shots||[]).map(s=>[s.id,u.id])));
 const fantasyById=new Map();
 for(const [records,owner,shots] of [[base.fantasyRealization||[],oldOwner,oldShots],[candidate.draft.fantasyRealization||[],newOwner,newShots]])for(const f of records){
  const indices=[...(f.unitIds||[]),...(f.shotIds||[]).map(id=>shots.get(id))].map(id=>owner.get(id)).filter(i=>i!==undefined);
  const previous=fantasyById.get(f.candidateId)||[];fantasyById.set(f.candidateId,[...previous,...indices]);
 }
 // The same fantasy may move from one replacement to another. Its old and new
 // realization are one relation even when neither record alone spans both.
 for(const [id,indices] of fantasyById)if(indices.length)link(indices,`幻想 ${id} 的旧、新归属及入出必须一起采用。`);
 const lineOwners=new Map();
 for(const [units,owner] of [[base.units,oldOwner],[candidate.draft.units,newOwner]])for(const u of units){
  const index=owner.get(u.id);if(index===undefined)continue;
  for(const s of u.shots||[])for(const p of s.dialogueParts||[])if(typeof p?.lineId==='string')lineOwners.set(p.lineId,[...(lineOwners.get(p.lineId)||[]),index]);
 }
 // A complete original line remains atomic across both ownership versions,
 // including a line moved out of one replacement and into another.
 for(const [id,indices] of lineOwners)if(new Set(indices).size>1)link(indices,`原句 ${id} 跨旧、新替换组的发声与演法必须一起采用。`);
 for(const decision of delta.reviewDecisions||[])if(decision?.disposition==='changed'&&Array.isArray(decision.unitIds)){
  const indices=decision.unitIds.map(id=>oldOwner.get(id)).filter(i=>i!==undefined);
  if(new Set(indices).size>1)link(indices,'同一工作单问题组的关联改动必须一起采用。');
 }
 const grouped=new Map();for(const [i] of replacements.entries()){const key=root(i);grouped.set(key,[...(grouped.get(key)||[]),i]);}
 return [...grouped.values()].map(indices=>{
  const old=new Set(indices.flatMap(i=>replacements[i].replaces)),proposed=new Set(indices.flatMap(i=>replacements[i].units.map(u=>u.id)));
  const replacedUnitIds=base.units.filter(u=>old.has(u.id)).map(u=>u.id),proposedUnitIds=candidate.draft.units.filter(u=>proposed.has(u.id)).map(u=>u.id);
  return {id:'rg-'+digest({version:REFINEMENT_SELECTION_VERSION,candidateId:candidate.id,replacedUnitIds,proposedUnitIds}).slice(0,24),replacedUnitIds,proposedUnitIds,reasons:[...new Set(indices.flatMap(i=>[...reasons[i]]))],indices};
 });
}

// Only the saved delta proves atomic replacements. Historical display text is
// not enough evidence to invent selectable units.
export function getRefinementAcceptanceGroups(d,candidate){
 try{return acceptanceGroups(d,candidate).map(({indices,...group})=>group);}catch{return [];}
}

function partialAdoptionBlock(d,candidate){
 const groups=acceptanceGroups(d,candidate);if(groups.length<2)return null;
 const base=getRefinementBase(d,candidate)?.draft,delta=effectiveDelta(candidate);
 const supported=new Set([...coordinates(base?.units||[]),...coordinates(candidate.draft.units),...coordinates(delta.replacements.flatMap(g=>g.units)),...[...(base?.fantasyRealization||[]),...(candidate.draft.fantasyRealization||[])].map(f=>f.candidateId)]);
 if([...(delta.revisionNotes||[]),...(delta.unresolved||[])].some(n=>!n||!supported.has(n.coordinate)))return {code:'REFINEMENT_PREVIEW_ONLY',message:metadataMessage};
 if(candidate.productionFeedback){
  const baseIds=new Set((d.adopted||[]).flatMap(a=>[a.candidateId,...(a.candidateIds||[])]));
  const baseFeedback=(d.candidates||[]).filter(c=>baseIds.has(c.id)&&c.productionFeedback).map(c=>c.productionFeedback);
  if(!baseFeedback.length||baseFeedback.some(f=>digest(f)!==digest(candidate.productionFeedback)))return {code:'REFINEMENT_PREVIEW_ONLY',message:metadataMessage};
 }
 return null;
}
export function getRefinementPartialAdoptionBlock(d,candidate){
 try{return partialAdoptionBlock(d,candidate);}catch{return {code:'REFINEMENT_PREVIEW_ONLY',message:'候选关联或元数据无法完整核验，基稿与原始候选保留供人工审看。'};}
}

export function selectRefinementGroups(d,candidate,groupIds){
 const base=getRefinementBase(d,candidate)?.draft,groups=acceptanceGroups(d,candidate);
 if(!Array.isArray(groupIds)||!groupIds.length||new Set(groupIds).size!==groupIds.length||groupIds.some(id=>typeof id!=='string'||!groups.some(g=>g.id===id)))fail('REFINEMENT_GROUP_SELECTION','请选择至少一个已保存的完整修改组；组编号不能重复或不存在。');
 const selected=groups.filter(g=>groupIds.includes(g.id)),indices=new Set(selected.flatMap(g=>g.indices)),partial=selected.length!==groups.length;
 if(partial){const blocked=getRefinementPartialAdoptionBlock(d,candidate);if(blocked)fail(blocked.code,blocked.message);}
 const savedDelta=effectiveDelta(candidate),replacements=savedDelta.replacements.filter((_,i)=>indices.has(i)),replaced=new Set(replacements.flatMap(g=>g.replaces)),retainedUnitIds=base.units.filter(u=>!replaced.has(u.id)).map(u=>u.id);
 const selectedCoordinates=new Set([...coordinates(base.units.filter(u=>replaced.has(u.id))),...coordinates(replacements.flatMap(g=>g.units)),...(base.fantasyRealization||[]).filter(f=>(f.unitIds||[]).some(id=>replaced.has(id))).map(f=>f.candidateId),...replacements.flatMap(g=>g.fantasyRealization).map(f=>f.candidateId)]);
 const metadata=field=>[
  ...(base[field]||[]).filter(n=>!selectedCoordinates.has(n.coordinate)),
  ...(savedDelta[field]||[]).filter(n=>selectedCoordinates.has(n.coordinate)),
 ];
 const delta={schemaVersion:DELTA_VERSION,baseDraftHash:baseDraftHash(base),retainedUnitIds,replacements:structuredClone(replacements),revisionNotes:metadata('revisionNotes'),unresolved:metadata('unresolved')};
 assertSpeechSeams(base,applyDelta(base,delta),retainedUnitIds);
 return {groupIds:selected.map(g=>g.id),partial,retainedUnitIds,delta};
}

function speechTracks(draft,retained){
 const lines=new Map();let elapsed=0;
 for(const u of draft.units)for(const s of u.shots||[]){
  for(const p of s.dialogueParts||[]){
   let line=lines.get(p.lineId);if(!line){line={retained:false,changed:false,parts:[]};lines.set(p.lineId,line);}
   line[retained.has(u.id)?'retained':'changed']=true;
   line.parts.push({text:p.text,delivery:p.delivery,start:elapsed+p.voiceStart,end:elapsed+p.voiceEnd});
  }
  elapsed+=s.duration;
 }
 return lines;
}
const speechSignature=line=>{
 if(!line?.parts.length)return null;
 const origin=line.parts[0].start,parts=[];
 for(const p of line.parts){
  const start=Number((p.start-origin).toFixed(6)),end=Number((p.end-origin).toFixed(6)),previous=parts.at(-1);
  // Recutting the same continuous voice is safe; shot IDs and visibility do not
  // change its speaker/channel, already bound by lineId and source validation.
  if(previous&&previous.delivery===p.delivery&&Math.abs(previous.end-start)<=1e-6){previous.text+=p.text;previous.end=end;}
  else parts.push({text:p.text,delivery:p.delivery,start,end});
 }
 return parts;
};
function assertSpeechSeams(base,draft,retainedUnitIds){
 const retained=new Set(retainedUnitIds),before=speechTracks(base,retained),after=speechTracks(draft,retained);
 for(const id of new Set([...before.keys(),...after.keys()])){
  const old=before.get(id),next=after.get(id);
  if(![old,next].some(line=>line?.retained&&line.changed))continue;
  // Do not add an untouched neighbor to a paid or adopted scope. Only an exact
  // preserved voice track proves this boundary safe for local group adoption.
  if(digest(speechSignature(old))!==digest(speechSignature(next)))fail('REFINEMENT_PREVIEW_ONLY',`原句 ${id} 跨选中修改组与未改单元，发声或演法接缝无法证明兼容；基稿与候选保留，不自动扩大范围。`);
 }
}

export function assertRefinementRetained(base,draft,retainedUnitIds){
 const retained=new Set(retainedUnitIds),next=new Map(draft.units.map(u=>[u.id,u]));
 for(const u of base.units)if(retained.has(u.id)&&(!next.has(u.id)||digest(u)!==digest(next.get(u.id))))fail('REFINEMENT_SCOPE','混合稿归一化改变了未采用单元；基稿保留，不自动扩大修改组。');
 for(const f of base.fantasyRealization||[])if((f.unitIds||[]).every(id=>retained.has(id))){
  const proposed=draft.fantasyRealization.find(n=>n.candidateId===f.candidateId);
  if(!proposed||digest(f)!==digest(proposed))fail('REFINEMENT_SCOPE','混合稿改变了未采用的幻想记录；基稿保留，不拆开或扩大幻想组。');
 }
}

export function assertRefinementSeams(base,draft,retainedUnitIds){
 const retained=new Set(retainedUnitIds),next=new Map(draft.units.map(u=>[u.id,u]));
 for(let i=1;i<base.units.length;i++){
  const left=base.units[i-1],right=base.units[i];
  if(retained.has(left.id)===retained.has(right.id)||left.eventId!==right.eventId||['new_event','time_space_jump','episode_start'].includes(right.boundaryBefore?.kind))continue;
  const changed=retained.has(left.id)?right:left,proposed=draft.units.filter(u=>u.eventId===changed.eventId&&!retained.has(u.id));
  const neighbor=next.get(retained.has(left.id)?left.id:right.id),neighborIndex=draft.units.indexOf(neighbor),edge=draft.units[neighborIndex+(retained.has(left.id)?1:-1)];
  const field=retained.has(left.id)?'initialState':'exitState';
  if(!edge||!proposed.includes(edge)||edge.scene!==changed.scene||edge[field]!==changed[field])fail('REFINEMENT_PREVIEW_ONLY','选中修改组改变了与保留单元的场景或出入状态，无法证明局部接缝连续；基稿与候选保留供人工审看。');
 }
}
