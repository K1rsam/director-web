import {createHash} from 'node:crypto';
export const SEASON_SCOPE_VERSION='series-season-scope-v1';
export const SEASON_HANDOFF_VERSION='series-season-handoff-v1';
const fail=(code,message)=>{throw Object.assign(new Error(message),{code,status:409,requestOutcome:'NOT_SENT'});};
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
export const seasonHash=v=>createHash('sha256').update(JSON.stringify(canonical(v))).digest('hex');
const text=v=>typeof v==='string'&&v.trim().length>0;
const listEqual=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export function seasonEstimate(timeline){
 if(!Array.isArray(timeline)||!timeline.length)fail('SEASON_ESTIMATE','需逐自然段的原声／动作共同时间线估时依据。');
 let minSeconds=0,maxSeconds=0;
 for(const t of timeline){
  for(const key of ['speech','action','overlap','transition'])if(!t[key]||![t[key].min,t[key].max].every(n=>Number.isFinite(n)&&n>=0)||t[key].min>t[key].max)fail('SEASON_ESTIMATE','估时必须是有效秒数区间。');
  if(!text(t.basis)||!Number.isSafeInteger(t.episode)||!Number.isSafeInteger(t.startLine)||!Number.isSafeInteger(t.endLine)||t.startLine<1||t.endLine<t.startLine||t.overlap.max>Math.min(t.speech.max,t.action.max)||t.overlap.min>Math.min(t.speech.min,t.action.min))fail('SEASON_ESTIMATE','估时需源行依据，重叠不能超过同期原声或动作。');
  minSeconds+=Math.max(t.speech.min,t.action.min,t.speech.min+t.action.min-t.overlap.max)+t.transition.min;
  maxSeconds+=t.speech.max+t.action.max-t.overlap.min+t.transition.max;
 }
 if(!Number.isFinite(minSeconds)||!Number.isFinite(maxSeconds))fail('SEASON_ESTIMATE','累计时间线溢出；需核对实际秒数。');
 return {minSeconds,maxSeconds};
}
export function seasonDurationException(scope){
 const exception=scope?.durationException;if(exception===undefined)return false;
 if(!exception||!text(exception.basis)||!['user','delegated'].includes(exception.confirmation?.kind)||!text(exception.confirmation?.basis)||!text(exception.confirmation?.actorId)||!Number.isFinite(Date.parse(exception.confirmation?.at)))fail('SEASON_CONFIRMATION','时长例外需要明确范围内的真实授权依据；空字段或自填确认不创造授权。');
 return true;
}
export function validateSeasonScope(scope,basis,{production=false}={}){
 if(!scope||scope.version!==SEASON_SCOPE_VERSION||!['proposed','locked'].includes(scope.status)||!text(scope.id)||!Number.isSafeInteger(scope.revision)||scope.revision<1||!Number.isSafeInteger(scope.seasonNumber)||scope.seasonNumber<1)fail('SEASON_SCOPE','季范围格式无效。');
 if(scope.sourceVersion!==basis.sourceVersion||scope.sourceHash!==basis.sourceHash||!listEqual(scope.readingEpisodes,basis.episodes.map(e=>e.number)))fail('SEASON_SOURCE','季范围与完整原文版本／原件hash不符；保留旧范围，新源另建修订。');
 const start=scope.seasonNumber===1?0:basis.episodes.findIndex(e=>e.number===scope.continuation?.nextEpisode);
 const expected=basis.episodes.slice(start,start+(scope.episodeNumbers?.length??0)).map(e=>e.number);
 if(start<0||!scope.episodeNumbers?.length||!listEqual(scope.episodeNumbers,expected))fail('SEASON_BOUNDARY','只能选择源序连续完整原集；首季从第一原集开始。');
 const last=basis.episodes.find(e=>e.number===scope.episodeNumbers.at(-1));
 if(!last||scope.ending?.episode!==last.number||scope.ending?.sceneKey!==last.sceneKeys.at(-1)||scope.ending?.endLine!==last.lineCount)fail('SEASON_BOUNDARY','首版仅允许完整原集最后原场结束，不自动扩大场内／半集范围。');
 if(scope.target?.minSeconds!==7200||scope.target?.maxSeconds!==9000||scope.target?.planningSeconds!==8100)fail('SEASON_TARGET','本季目标固定为120–150分钟、135分钟规划中心。');
 const ending=scope.ending;
 if(!text(ending.closure)||!text(ending.hook)||!Array.isArray(ending.sourceRefs)||!ending.sourceRefs.some(r=>r.episode===last.number&&r.endLine===last.lineCount))fail('SEASON_ENDING','季终回报与原生钩子必须包含当前完整原集尾源锚。');
 for(const r of ending.sourceRefs){const e=basis.episodes.find(e=>e.number===r.episode);if(!e||!scope.episodeNumbers.includes(r.episode)||!Number.isSafeInteger(r.startLine)||!Number.isSafeInteger(r.endLine)||r.startLine<1||r.endLine<r.startLine||r.endLine>e.lineCount)fail('SEASON_ENDING','季终源锚越界。');}
 seasonEstimate(ending.timeline);
 // Each source line is accounted for exactly once; overlap is declared within its segment.
 for(const n of scope.episodeNumbers){const e=basis.episodes.find(e=>e.number===n),parts=ending.timeline.filter(t=>t.episode===n);let next=1;for(const t of parts){if(t.startLine!==next||t.endLine>e.lineCount)fail('SEASON_ESTIMATE','估时须覆盖全部所选原文，不能按平均集长或漏段。');next=t.endLine+1;}if(next!==e.lineCount+1)fail('SEASON_ESTIMATE','估时缺少本季原文段落。');}
 if(ending.timeline.some(t=>!scope.episodeNumbers.includes(t.episode)))fail('SEASON_ESTIMATE','估时混入未来集。');
 for(const key of ['characters','locations','costumes','forms','props'])if(!Array.isArray(ending.assetBurden?.[key])||!ending.assetBurden[key].every(text))fail('SEASON_ASSET_BURDEN','需列出相较前一候选新增的资产负担，没有则填空数组。');
 if(scope.status==='locked'&&(!['user','delegated'].includes(scope.confirmation?.kind)||!text(scope.confirmation?.basis)||!text(scope.confirmation?.actorId)||!Number.isFinite(Date.parse(scope.confirmation?.at))))fail('SEASON_CONFIRMATION','锁定需要真实选择或明确委托记录，字段不创造授权。');
 if(scope.seasonNumber>1&&(!scope.continuation?.closedId||!scope.continuation?.previousScopeHash))fail('SEASON_CONTINUATION','续季须验证上季实际closed包，不能用计划包或自填hash开工。');
 seasonDurationException(scope);
 if(production&&scope.status!=='locked')fail('SEASON_NOT_LOCKED','请先选择并锁定本季原集尾，再投入详细资产和分镜。');
 return scope;
}
export function assertSeasonEpisodes(scope,numbers,consumer='production'){
 if(!scope)return;
 seasonDurationException(scope);
 if(scope.status!=='locked')fail('SEASON_NOT_LOCKED','本季范围尚未锁定，未发送生产请求。');
 if(!Array.isArray(numbers)||!numbers.length||numbers.some(n=>!scope.episodeNumbers.includes(n)))fail('SEASON_SCOPE',`${consumer} 请求越出已锁定季范围。`);
}
export function assertSeasonBinding(scope,binding,numbers){
 assertSeasonEpisodes(scope,numbers);
 if(scope)seasonDurationException(scope);
 if(scope&&(!binding||binding.scopeHash!==seasonHash(scope)))fail('SEASON_CHANGED','任务冻结的季范围与当前范围不符；旧任务不升级。');
 if(!scope&&binding)fail('SEASON_CHANGED','已冻结季范围不能降级为无季模式。');
}
export function seasonAssetAllowed(scope,asset,basis){
 if(!scope)return true;
 if(scope.status!=='locked'||!basis)return false;
 return Array.isArray(asset.sceneRefs)&&asset.sceneRefs.some(r=>scope.episodeNumbers.includes(r.episode)&&basis.episodes.find(e=>e.number===r.episode)?.sceneKeys.includes(r.sceneKey));
}
export function seasonDelivery(scope,basis,runs,mode='preview'){
 if(!scope)return null;
 validateSeasonScope(scope,basis,{production:true});
 if(!['preview','final'].includes(mode))fail('SEASON_DELIVERY','交付必须明确preview或final。');
 assertSeasonEpisodes(scope,runs.map(r=>r.web.binding.episodeNumber),'export');
 const order=runs.map(r=>r.web.binding.episodeNumber),expected=scope.episodeNumbers.filter(n=>order.includes(n));
 if(!listEqual(order,expected))fail('SEASON_COVERAGE','采用集顺序须与锁定季源序一致，不能以范围覆盖替代实际季终。');
 const covered=new Set(),seenEpisodes=new Set(),shots=[],byEpisode=[];
 let actualTailScene=null;
 for(const run of runs){
  const n=run.web.binding.episodeNumber;if(seenEpisodes.has(n))fail('SEASON_COVERAGE','采用集重复。');seenEpisodes.add(n);
  const episode=basis.episodes.find(e=>e.number===n),rows=run.source?.sourceRows??[],units=run.assembly?.draft?.units;
  if(!Array.isArray(units)||!units.length)fail('SEASON_COVERAGE','需采用稿真实逐镜结构与秒数，不能拿容器时长代替。');
  let seconds=0;
  for(const u of units)for(const s of u.shots??[]){if(!Number.isFinite(s.duration)||s.duration<=0)fail('SEASON_DURATION','镜头秒数必须为正数。');
   seconds+=s.duration;shots.push({episode:n,unitId:u.id,shotId:s.id,duration:s.duration,exitState:u.exitState});
   const sourceScenes=[...new Set((s.sourceRefs??[]).flatMap(id=>{const r=rows.find(r=>r.id===id);return r?.seasonSceneKey||r?.sceneKey?[r.seasonSceneKey??r.sceneKey]:run.source?.seasonSceneMap?.[id]?[run.source.seasonSceneMap[id]]:[];}))];
   for(const k of sourceScenes)if(!episode.sceneKeys.includes(k))fail('SEASON_SCOPE','采用镜头引用了季范围外场次。');
   // Unit/event location is the staging authority; old same-scene refs remain legal.
   const event=run.plan?.events?.find(e=>e.id===u.eventId),declared=episode.sceneKeys.includes(u.scene)?u.scene:event?.sceneKey;
   actualTailScene=declared&&episode.sceneKeys.includes(declared)?declared:sourceScenes.length===1?sourceScenes[0]:null;
   if(actualTailScene)covered.add(`${n}:${actualTailScene}`);
  }
  byEpisode.push({episode:n,seconds});
 }
 const complete=scope.episodeNumbers.every(n=>seenEpisodes.has(n)&&basis.episodes.find(e=>e.number===n).sceneKeys.every(k=>covered.has(`${n}:${k}`)));
 const actualSeconds=byEpisode.reduce((s,e)=>s+e.seconds,0);
 if(!Number.isFinite(actualSeconds))fail('SEASON_DURATION','实际镜长累计溢出。');
 const inTarget=actualSeconds>=7200&&actualSeconds<=9000;
 const authorized=seasonDurationException(scope);
 if(mode==='final'&&(!complete||order.at(-1)!==scope.ending.episode||actualTailScene!==scope.ending.sceneKey))fail('SEASON_COVERAGE','最终交付须覆盖已锁定本季全部原集场，且每场有真实正时长镜头。');
 if(mode==='final'&&!inTarget&&!authorized)fail('SEASON_DURATION','实际逐镜总时长越出120–150分钟；先明确裁决，不能静默扩季或凑秒数。');
 return {version:SEASON_SCOPE_VERSION,mode,scopeHash:seasonHash(scope),complete,actualSeconds,byEpisode,estimate:seasonEstimate(scope.ending.timeline),durationStatus:inTarget?'in-target':authorized?'exception-authorized':'preview-outside-target',tail:shots.length?{...shots.at(-1),sceneKey:actualTailScene}:null,screenQuality:'text-only; not finished video or user acceptance'};
}
/** Freeze an exact row→original-scene map; never infer scene ownership from numeric names. */
export function bindSeasonSource(source,episode){
 const map={};
 for(const row of source.sourceRows??[]){
  const parts=row.standard?.regroup?.originalSourceParts?.body,scenes=episode.scenes??[];
  const matched=Number.isSafeInteger(row.line)?scenes.filter(s=>s.startLine<=row.line&&s.endLine>=row.line):Array.isArray(parts)&&parts.length?scenes.filter(s=>parts.every(p=>p.start>=s.start&&p.end<=s.end)):[];
  if(matched.length===1)map[row.id]=matched[0].sceneKey;
 }
 return {...source,seasonSceneMap:map};
}
export function seasonCalibration(scope,basis,runs){
 if(!scope||!runs.length)return null;
 const preview=seasonDelivery(scope,basis,runs,'preview'),completedEpisodes=runs.map(r=>r.web.binding.episodeNumber);
 const remaining=scope.ending.timeline.filter(t=>!completedEpisodes.includes(t.episode)),remainingEstimate=remaining.length?seasonEstimate(remaining):{minSeconds:0,maxSeconds:0};
 const projected={minSeconds:preview.actualSeconds+remainingEstimate.minSeconds,maxSeconds:preview.actualSeconds+remainingEstimate.maxSeconds};
 return {version:SEASON_SCOPE_VERSION,scopeHash:seasonHash(scope),completedEpisodes,actualSeconds:preview.actualSeconds,remainingEstimate,projected,requiresReview:projected.maxSeconds<7200||projected.minSeconds>9000,basis:'已完成采用稿逐镜秒数替换相应计划估时；剩余仍为估计，不是成片时长。'};
}
