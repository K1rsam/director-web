import {applyDelta} from './delta.mjs';

// A paid refinement may preserve one half of an existing cross-unit fantasy.
// Carry that exact baseline unit into the atomic receipt, not into a new model
// request. The raw reply and its actual creative-change decisions stay intact.
export function normalizeRefinementLinkedUnits(base,delta,refinement){
 let originalError;
 try{applyDelta(base,delta);return {delta,changes:[]};}
 catch(error){
  if(error.code!=='DELTA_FANTASY_GROUP'||refinement?.version!=='director-refinement-v3')throw error;
  originalError=error;
 }
 const next=structuredClone(delta),oldIds=base.units.map(u=>u.id),positions=new Map(oldIds.map((id,i)=>[id,i]));
 const retained=new Set(next.retainedUnitIds),allowed=new Set(refinement.unitIds||[]),carried=new Set(),changes=[];
 let expanded;
 do{
  expanded=false;
  const owners=new Map(next.replacements.flatMap(g=>g.replaces.map(id=>[id,g])));
  for(const fantasy of base.fantasyRealization||[]){
   const touched=[...new Set((fantasy.unitIds||[]).map(id=>owners.get(id)).filter(Boolean))];
   if(touched.length>1)throw originalError;
   if(touched.length!==1)continue;
   const group=touched[0],missing=(fantasy.unitIds||[]).filter(id=>!group.replaces.includes(id));
   if(!missing.length)continue;
   if(missing.some(id=>!positions.has(id)))throw originalError;
   const start=positions.get(group.replaces[0]),end=positions.get(group.replaces.at(-1));
   const first=Math.min(start,...missing.map(id=>positions.get(id))),last=Math.max(end,...missing.map(id=>positions.get(id)));
   const ids=oldIds.slice(first,last+1),added=ids.filter(id=>!group.replaces.includes(id));
   if(added.some(id=>!retained.has(id)||!allowed.has(id)||owners.has(id)))throw originalError;
   const before=base.units.slice(first,start),after=base.units.slice(end+1,last+1);
   group.units=[...structuredClone(before),...group.units,...structuredClone(after)];group.replaces=ids;
   for(const id of added){
    retained.delete(id);carried.add(id);
    changes.push({action:'retain_linked_unit',coordinate:id,change:'将原样保留的关联单元纳入完整幻想接收组；正文及创作决定未改。'});
   }
   expanded=true;
   break;
  }
 }while(expanded);
 next.retainedUnitIds=oldIds.filter(id=>retained.has(id));
 for(const group of next.replacements)for(const fantasy of base.fantasyRealization||[]){
  const ids=fantasy.unitIds||[];
  if(ids.length&&ids.every(id=>carried.has(id)&&group.replaces.includes(id))&&!group.fantasyRealization.some(f=>f.candidateId===fantasy.candidateId))
   group.fantasyRealization.push(structuredClone(fantasy));
 }
 // Still reject stale partitions, foreign units, split creative groups and any
 // unproved new fantasy relation. Ordinary delta application remains strict.
 applyDelta(base,next);
 return {delta:next,changes};
}
