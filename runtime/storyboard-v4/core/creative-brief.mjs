export const CREATIVE_REVISION='expressive-cadence-v1';
const rounded=n=>Math.round(n*1000)/1000;
const positive=n=>Number.isFinite(n)&&n>0;

function unitTiming(unit){
 const shots=unit?.shots;
 let seconds=null,speechWindowSeconds=null;
 if(Array.isArray(shots)&&shots.length&&shots.every(s=>positive(s?.duration))){
  seconds=rounded(shots.reduce((sum,s)=>sum+s.duration,0));
  let speech=0,complete=true;
  for(const shot of shots){
   if(!Array.isArray(shot.dialogueParts)){complete=false;continue;}
   const windows=shot.dialogueParts.map(p=>[p?.voiceStart,p?.voiceEnd]);
   if(windows.some(([a,b])=>!Number.isFinite(a)||!Number.isFinite(b)||a<0||b<=a||b>shot.duration)){complete=false;continue;}
   // Overlapping speech occupies the union of windows, not additional screen time.
   let end=0;for(const [a,b] of windows.sort((x,y)=>x[0]-y[0])){speech+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b);}
  }
  if(complete)speechWindowSeconds=rounded(speech);
 }
 return {id:unit?.id??null,...(unit?.eventId?{eventId:unit.eventId}:{}),seconds,speechWindowSeconds,withoutSpeechWindowSeconds:seconds!==null&&speechWindowSeconds!==null?rounded(seconds-speechWindowSeconds):null};
}

export function capacityBrief({settings,source,previousDraft,voiceReference}){
 const units=Array.isArray(previousDraft?.units)&&previousDraft.units.length?previousDraft.units.map(unitTiming):null;
 const referenceRows=new Map((voiceReference?.rows||[]).filter(r=>positive(r.seconds)).map(r=>[r.id,r.seconds]));
 return {
  maxUnitSeconds:settings.maxUnitSeconds,
  preferredRange:settings.maxUnitSeconds===30?[26,30]:[13,15],hardMinimum:false,
  timingCaveat:'导演声窗与平读都不是演员实配或不可压缩下限；声窗外时间不等于空等，可能承载动作、反应或幻想。先重排可共时声画与合法切点，再判断容量；不催读、删有效表演或加空白凑档。',
  currentDraft:units?{unitCount:units.length,totalSeconds:units.every(u=>u.seconds!==null)?rounded(units.reduce((n,u)=>n+u.seconds,0)):null,units}:null,
  voiceReference:voiceReference?{coveredLines:referenceRows.size,totalLines:source.dialogue.length,seconds:referenceRows.size?rounded([...referenceRows.values()].reduce((n,s)=>n+s,0)):null,isPerformedMinimum:false}:null
 };
}
