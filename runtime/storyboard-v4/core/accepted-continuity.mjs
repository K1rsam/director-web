export const ACCEPTED_CONTINUITY_VERSION='accepted-tail-v1';

export const acceptsContinuity=(d,version=d.rulesSnapshot?.acceptedContinuityVersion)=>
 version===ACCEPTED_CONTINUITY_VERSION&&d.rulesSnapshot?.acceptedContinuityVersion===version&&d.rulesSnapshot?.unitPackingPolicy==='event-first-v1';

export function sourceOrderedPackages(d){
 const rank=new Map(d.source.sourceRows.map((row,i)=>[row.id,i]));
 return [...d.plan.workPackages].sort((a,b)=>Math.min(...a.sourceRefs.map(ref=>rank.get(ref)??Infinity))-Math.min(...b.sourceRefs.map(ref=>rank.get(ref)??Infinity)));
}

// One external boundary per call: internal packages are authored/finished together.
// No candidate, neighboring episode or runner conversation is a continuity source.
export function acceptedContinuity(d,packageIds,executionBatch=null,version=d.rulesSnapshot?.acceptedContinuityVersion){
 if(!acceptsContinuity(d,version)||!packageIds.length||executionBatch?.predecessor)return null;
 const ordered=sourceOrderedPackages(d),index=ordered.findIndex(w=>packageIds.includes(w.id));
 if(index<=0)return null;
 const previous=ordered[index-1],target=ordered[index],adopted=d.adopted.find(a=>a.packageIds.includes(previous.id));
 if(!adopted)return null;
 const owned=new Set(previous.sourceRefs),rank=new Map(d.source.sourceRows.map((row,i)=>[row.id,i]));
 const touched=u=>u.shots?.flatMap(s=>s.sourceRefs||[]).filter(ref=>owned.has(ref))||[];
 const unit=adopted.draft.units.filter(u=>touched(u).length).sort((a,b)=>Math.max(...touched(a).map(ref=>rank.get(ref)??-1))-Math.max(...touched(b).map(ref=>rank.get(ref)??-1))).at(-1);
 if(!unit)return null;
 const shotIds=new Set(unit.shots.map(s=>s.id));
 return structuredClone({version:ACCEPTED_CONTINUITY_VERSION,packageId:previous.id,sourceRefs:[...new Set(unit.shots.flatMap(s=>s.sourceRefs))].sort((a,b)=>(rank.get(a)??Infinity)-(rank.get(b)??Infinity)),unit,fantasyRealization:(adopted.draft.fantasyRealization||[]).filter(f=>f.unitIds?.includes(unit.id)||f.shotIds?.some(id=>shotIds.has(id))),boundaryBefore:d.plan.events?.find(e=>e.id===target.eventId)?.boundaryBefore??null});
}
