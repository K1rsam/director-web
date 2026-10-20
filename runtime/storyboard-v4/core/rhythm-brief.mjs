export const RHYTHM_CONTRACT_VERSION='screen-rhythm-v5';
export const RHYTHM_CONTRACT_VERSIONS=['screen-rhythm-v1','screen-rhythm-v2','screen-rhythm-v3','screen-rhythm-v4',RHYTHM_CONTRACT_VERSION];
const round=n=>Math.round(n*1000)/1000;
const positive=n=>Number.isFinite(n)&&n>0;
const list=v=>Array.isArray(v)?v:[];
// Count the canonical spoken projection, not raw rows or performance cues.
// These are character proxies, not phonemes, performed speed or a pass/fail test.
const characters=text=>(typeof text==='string'?text.match(/[\p{L}\p{N}]/gu):null)?.length||0;
const nonverbal=new Set(['roar','scream','vocalization']);

// A timeline is known within one completely timed unit. Across units it needs
// an explicit continuous boundary, the same event and the same scene.
function timelinePositions(units){
 let prior=null,runId=null,runSeconds=0;
 return units.map((unit,index)=>{
  const shots=list(unit?.shots);
  if(!shots.length||shots.some(s=>!positive(s?.duration))){prior=null;return null;}
  const join=prior&&typeof unit?.eventId==='string'&&!!unit.eventId&&typeof unit?.scene==='string'&&!!unit.scene.trim()
   &&prior.eventId===unit.eventId&&prior.scene===unit.scene&&['continuous','capacity'].includes(unit?.boundaryBefore?.kind);
  if(!join){runId=index;runSeconds=0;}
  let unitSeconds=0;
  const positions=shots.map(shot=>{
   const result={runId,runStart:runSeconds+unitSeconds,unitStart:unitSeconds,unitId:unit?.id??null,shotId:shot?.id??null};
   unitSeconds+=shot.duration;return result;
  });
  runSeconds+=unitSeconds;prior=unit;return positions;
 });
}

function speechContinuity(lineId,count,entries,seconds){
 const times=entries.map(p=>p.timeline);
 if(times.some(t=>!t)||times.some(t=>t.runId!==times[0].runId))return null;
 const gaps=[];
 for(let i=1;i<times.length;i++){
  const before=times[i-1],after=times[i],gap=after.start-before.end;
  if(gap<-1e-6)return null;
  if(round(gap)>0)gaps.push({
   from:{unitId:before.unitId,shotId:before.shotId,unitTime:round(before.unitEnd)},
   to:{unitId:after.unitId,shotId:after.shotId,unitTime:round(after.unitStart)},seconds:round(gap)
  });
 }
 if(!gaps.length)return null;
 const elapsed=times.at(-1).end-times[0].start;
 return {lineId,characters:count,windowSeconds:round(seconds),elapsedSeconds:round(elapsed),plannedCharactersPerSecond:round(count/seconds),elapsedCharactersPerSecond:round(count/elapsed),gaps};
}

// Range ends are not episode ends. Unknown voice data invalidates only its
// known-time range; a later nonverbal utterance cannot be called silence.
function speechTailIntervals(units,positions,source,parts,measuredIds){
 const intervals=[],quotes=new Map(list(source?.dialogue).filter(q=>typeof q?.id==='string').map(q=>[q.id,q]));
 let run=null;
 const close=()=>{
  if(!run?.last||run.unknown)return;
  const seconds=round(run.end.time-run.last.time);
  if(seconds>0)intervals.push({from:run.last.coordinate,to:run.end.coordinate,seconds});
 };
 for(const [unitIndex,unit] of units.entries()){
  const times=positions?.[unitIndex];
  if(!times){close();run=null;continue;}
  for(const [shotIndex,shot] of list(unit?.shots).entries()){
   const position=times[shotIndex];
   if(!run||run.id!==position.runId){close();run={id:position.runId,last:null,unknown:false};}
   run.end={time:position.runStart+shot.duration,coordinate:{unitId:position.unitId,shotId:position.shotId,unitTime:round(position.unitStart+shot.duration)}};
   if(!Array.isArray(shot.dialogueParts)||typeof unit.id!=='string'||!unit.id.trim()||typeof shot.id!=='string'||!shot.id.trim()){run.unknown=true;continue;}
   let end=0;
   for(const part of shot.dialogueParts){
    const quote=quotes.get(part?.lineId),valid=typeof part?.text==='string'&&!!part.text.trim()&&Number.isFinite(part.voiceStart)&&Number.isFinite(part.voiceEnd)
     &&part.voiceStart>=end&&part.voiceEnd>part.voiceStart&&part.voiceEnd<=shot.duration+1e-6;
    if(!quote||!valid){run.unknown=true;continue;}
    end=part.voiceEnd;
    const entries=parts.get(quote.id)||[];
    if(entries.map(p=>p.text).join('')!==quote.quote||entries.some(p=>!p.timeline||p.timeline.runId!==run.id)){run.unknown=true;continue;}
    if(nonverbal.has(quote.kind)){run.last=null;continue;}
    if(!measuredIds.has(quote.id)){run.unknown=true;continue;}
    run.last={time:position.runStart+part.voiceEnd,coordinate:{lineId:quote.id,unitId:position.unitId,shotId:position.shotId,unitTime:round(position.unitStart+part.voiceEnd)}};
   }
  }
 }
 close();return intervals;
}

function auditDraft(draft,source,cap,extended=false,timeline=false,editing=false,tails=false){
 const units=list(draft.units),parts=new Map(),longShots=[],shortShots=[],sparseUnits=[];
 const unitEndings=[],continuousRuns=[],fragmentSkews=[],continuityGaps=[],voices=[],measuredIds=new Set(),positions=timeline?timelinePositions(units):null;
 let screenSeconds=0,shotCount=0,complete=units.length>0;
 for(const [unitIndex,unit] of units.entries()){
  const shots=list(unit?.shots);let seconds=0,known=shots.length>0;
  for(const [shotIndex,shot] of shots.entries()){
   shotCount++;
   if(!positive(shot?.duration)){known=false;continue;}
   seconds+=shot.duration;
   const coordinate={unitId:unit?.id??null,shotId:shot.id??null,seconds:shot.duration};
   if(shot.duration>5)longShots.push(coordinate);
   if(shot.duration<=1.5)shortShots.push(coordinate);
   let end=0;
   for(const part of list(shot.dialogueParts)){
    if(typeof part?.lineId!=='string'){if(timeline)voices.push(null);continue;}
    const valid=typeof part.text==='string'&&Number.isFinite(part.voiceStart)&&Number.isFinite(part.voiceEnd)
     &&part.voiceStart>=end&&part.voiceEnd>part.voiceStart&&part.voiceEnd<=shot.duration+1e-6;
    const entries=parts.get(part.lineId)||[];
    const position=valid&&positions?.[unitIndex]?.[shotIndex];
    const entry={text:part.text,seconds:valid?part.voiceEnd-part.voiceStart:null,shotId:shot.id??null,
     ...(timeline?{timeline:position?{...position,start:position.runStart+part.voiceStart,end:position.runStart+part.voiceEnd,unitStart:position.unitStart+part.voiceStart,unitEnd:position.unitStart+part.voiceEnd}:null}:{})};
    entries.push(entry);if(timeline)voices.push({lineId:part.lineId,...entry});
    parts.set(part.lineId,entries);end=part.voiceEnd;
   }
  }
  complete&&=known;screenSeconds+=seconds;
  if(known&&seconds>=cap*2/3&&shots.length/seconds*30<8)sparseUnits.push({unitId:unit?.id??null,seconds:round(seconds),shots:shots.length});
  if(extended&&known){
   const timed=round(seconds),prior=continuousRuns.at(-1);
   const sameRun=typeof unit?.eventId==='string'&&!!unit.eventId&&typeof unit?.scene==='string'&&!!unit.scene.trim()
    &&prior?.eventId===unit.eventId&&prior.scene===unit.scene&&['continuous','capacity'].includes(unit?.boundaryBefore?.kind);
   if(sameRun){prior.unitIds.push(unit.id??null);prior.unitSeconds.push(timed);prior.seconds=round(prior.seconds+timed);}
   else continuousRuns.push({eventId:unit?.eventId??null,scene:unit?.scene??null,unitIds:[unit?.id??null],unitSeconds:[timed],seconds:timed});
   if(timed<=cap&&Math.abs(timed-Math.round(timed))>1e-6)unitEndings.push({unitId:unit?.id??null,seconds:timed,nearbyIntegerEnds:[Math.floor(timed),Math.ceil(timed)].filter(n=>n>0&&n<=cap)});
  }else if(extended){
   // Unknown timing breaks a run; never join the units on either side of it.
   continuousRuns.push({eventId:null,scene:null,unitIds:[unit?.id??null],unitSeconds:[null],seconds:null});
  }
 }
 let measuredLines=0,measuredCharacters=0,measuredWindowSeconds=0;
 const outliers=[],unmeasuredLineIds=[];
 for(const quote of list(source?.dialogue)){
  if(nonverbal.has(quote?.kind))continue;
  const entries=parts.get(quote?.id)||[],count=characters(quote?.quote);
  if(!count||!entries.length||entries.some(p=>!positive(p.seconds))||entries.map(p=>p.text).join('')!==quote.quote){unmeasuredLineIds.push(quote?.id??null);continue;}
  const seconds=entries.reduce((n,p)=>n+p.seconds,0),rate=count/seconds;
  measuredLines++;measuredCharacters+=count;measuredWindowSeconds+=seconds;measuredIds.add(quote.id);
  // Do not flag a tiny utterance/fragment as slow just because it needs a breath.
  if(count>=12&&(rate<5-1e-6||rate>7+1e-6))outliers.push({lineId:quote.id,shotIds:[...new Set(entries.map(p=>p.shotId))],characters:count,windowSeconds:round(seconds),plannedCharactersPerSecond:round(rate)});
  if(extended&&entries.length>1){
   const fragments=entries.map(p=>({shotId:p.shotId,characters:characters(p.text),windowSeconds:round(p.seconds),plannedCharactersPerSecond:round(characters(p.text)/p.seconds)})).filter(p=>p.characters>=4);
   const rates=fragments.map(p=>p.plannedCharactersPerSecond);
   if(fragments.length>1&&Math.max(...rates)-Math.min(...rates)>=2&&rates.some(r=>r<3.5||r>7.5))fragmentSkews.push({lineId:quote.id,fragments});
  }
  if(timeline&&entries.length>1){const span=speechContinuity(quote.id,count,entries,seconds);if(span)continuityGaps.push(span);}
 }
 const turnGaps=[];
 if(timeline)for(let i=1;i<voices.length;i++){
  const before=voices[i-1],after=voices[i],a=before?.timeline,b=after?.timeline;
  if(before?.lineId===after?.lineId||!measuredIds.has(before?.lineId)||!measuredIds.has(after?.lineId)||!a||!b||a.runId!==b.runId)continue;
  const gap=round(b.start-a.end);
  if(gap>0)turnGaps.push({from:{lineId:before.lineId,unitId:a.unitId,shotId:a.shotId,unitTime:round(a.unitEnd)},to:{lineId:after.lineId,unitId:b.unitId,shotId:b.shotId,unitTime:round(b.unitStart)},seconds:gap});
 }
 return {
  screenSeconds:complete?round(screenSeconds):null,shotCount,
  averageShotSeconds:complete&&shotCount?round(screenSeconds/shotCount):null,
  shotsPer30Seconds:complete&&screenSeconds?round(shotCount/screenSeconds*30):null,
  ...(!timeline?{longShots,shortShots,sparseUnits}:{}),
  ...(editing?{viewingReview:{advisoryOnly:true,longShots:longShots.filter(s=>s.seconds>6),sparseUnits}}:{}),
  speech:{measuredLines,measuredCharacters,measuredWindowSeconds:round(measuredWindowSeconds),plannedCharactersPerSecond:measuredWindowSeconds?round(measuredCharacters/measuredWindowSeconds):null,unmeasuredLineIds,outliers,...(extended?{fragmentSkews}:{}),...(timeline?{continuityGaps,turnGaps}:{}),...(tails?{tailIntervals:speechTailIntervals(units,positions,source,parts,measuredIds)}:{})},
  ...(extended?{unitEndings,continuousRuns}:{})
 };
}

/** Advisory data for the existing author/finisher; no new request or quality gate. */
export function rhythmBrief({previousDraft,source,maxUnitSeconds,version=RHYTHM_CONTRACT_VERSION}){
 const extended=['screen-rhythm-v2','screen-rhythm-v3','screen-rhythm-v4',RHYTHM_CONTRACT_VERSION].includes(version),timeline=['screen-rhythm-v3','screen-rhythm-v4',RHYTHM_CONTRACT_VERSION].includes(version),editing=['screen-rhythm-v4',RHYTHM_CONTRACT_VERSION].includes(version),tails=version===RHYTHM_CONTRACT_VERSION;
 return {
  version,
  ...(editing?{shotSeconds:{preferred:[2,5],isHardLimit:false,durationIsCreativeChoice:true,automaticRetiming:false},shotDensityPer30:{reference:[8,12],isQuota:false}}:timeline?{shotSeconds:{durationIsCreativeChoice:true,automaticRetiming:false}}:{shotSeconds:{preferred:[2,5],ordinaryMinimumExclusive:1.5,splitReviewOver:6},shotDensityPer30:{reference:[8,12],isQuota:false}}),
  speechCharactersPerSecond:{baseline:[5,6],expressiveRange:[4,7]},
  ...(timeline?{speechCharactersPerMinute:{baseline:[300,360],expressiveRange:[240,420],isHardLimit:false}}:{}),
  caveat:editing?'先按落词、作用点、听者变化与结果主动安排有效观看，再定镜长。2–5秒与每30秒8–12镜仅作起排/诊断参考，无硬上下限或配额。viewingReview定位超过6秒及偏疏段：比较连续调度与切镜的具体收益，长台词或幻想持续本身不是合长理由；不能只换相似角度补数。声轨连续与画面切换独立，修气口不合掉有效切点。continuityGaps/turnGaps只定位间隔，不判有收益的气口错误。字数为发声字符代理，非中文按实际发音；不是实配，不自动改时、暂停、触发调用或复制原话。'+(tails?'先核语气与必要停顿是否合适，再参考整句字速；慢说、悬念与情绪落定可有收益，不统一催快。tailIntervals仅给已知连续范围中最后完整原句后的审阅候选，范围末尾不代表片尾，声后时间不等于无用空白；只核具体表演与收束收益，不自动判错、改稿、暂停或新增付费调用。':''):timeline?'镜长按完整演出和观看作用选择，不按秒数或镜头密度自动判错。完整原句的声窗合计与首声到尾声的历时分开：continuityGaps和turnGaps仅定位跨切或接话间隔，不判有收益的气口错误，不自动催读、改时或触发调用。字数取既有发声文本；非中文按实际发音判断。数据不是演员实配，不复制原话或新增审稿岗位。':'长短镜与稀疏段是核对坐标，不是自动判错或催读指令；完整原句跨镜合计声窗，含已排气口，不是演员实配。表演提示以source.dialogue.quote的既有分离结果为准，不删未知括号；非中文读速另按实际发音判断。只提供数值与坐标，不复制原话或新增审稿调用。',
  ...(extended?{cutPolicy:{preferNearCapacity:true,uniformDistribution:false,naturalSourceTailExempt:true,batchEndIsSourceEnd:false,integerUnitEnd:true,fractionalShotSeconds:true,automaticRetiming:false},
   cutCaveat:'先守住源、情绪作用和已成立的声画，再选靠近容量的合法接点。30/30/7自然尾段保留，不均分或补戏；真实边界也可短收。连续范围末项不自动证明源已结束，批次末尾尤其不可冒充片尾。整数终点需有可执行的切点或相位，建议数不是授权催读、拉空白或只改显示。fragmentSkews只定位可能的逐镜摊慢，整句气口与有收益的停顿仍可保留，不按分片字速自动返修。'}:{}),
  audit:Array.isArray(previousDraft?.units)&&previousDraft.units.length?auditDraft(previousDraft,source,maxUnitSeconds,extended,timeline,editing,tails):null
 };
}
