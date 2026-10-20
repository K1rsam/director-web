// Reading/display coordinates are derived from the frozen draft, not a new summary.
export function refinementScope(d,{eventIds,unitIds,draft=d.assembly?.draft}={}){
 const all=draft?.units||[],events=d.plan?.events||[],rows=d.source?.sourceRows||[];
 const selectedEvents=new Set(eventIds||events.map(e=>e.id)),selectedUnits=unitIds&&new Set(unitIds);
 const units=all.filter(u=>selectedEvents.has(u.eventId)&&(!selectedUnits||selectedUnits.has(u.id)));
 const describe=list=>{
  const sourceRefs=new Set(list.flatMap(u=>(u.shots||[]).flatMap(s=>s.sourceRefs||[]))),source=rows.filter(r=>sourceRefs.has(r.id));
  const anchor=row=>row?{id:row.id,text:String(row.text||'').slice(0,80),...(Number.isSafeInteger(row.lineNo)?{lineNo:row.lineNo}:{})}:null;
  return {unitIds:list.map(u=>u.id),shotIds:list.flatMap(u=>(u.shots||[]).map(s=>s.id)),unitCount:list.length,shotCount:list.reduce((n,u)=>n+(u.shots||[]).length,0),wholeEpisode:all.length>0&&list.length===all.length,sourceStart:anchor(source[0]),sourceEnd:anchor(source.at(-1))};
 };
 return {...describe(units),events:events.filter(e=>selectedEvents.has(e.id)).map(e=>({id:e.id,title:e.title||'',...describe(units.filter(u=>u.eventId===e.id))})),
  units:units.map(u=>({id:u.id,eventId:u.eventId,title:u.title||'',...describe([u])}))};
}
