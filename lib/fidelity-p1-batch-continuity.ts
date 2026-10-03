import {normalize} from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import {parseEpisodeNumber} from './import-script';
import type {FidelityDecision,FidelityResult,FidelitySegment} from './fidelity-import';

type Range={start:number;end:number};
export type P1BatchContinuityInput={
 manualDecisions:readonly FidelityDecision[];
 /** Validated P1 decisions before coalescing, including the current response. */
 pendingDecisions:readonly FidelityDecision[];
 completedRanges:readonly Range[];
 /** A verified full-reading batch, never the bounding box of sparse repairs. */
 currentBatch?:Range;
};
export type P1BatchContinuityCorrection={
 reason:'SAME_SOURCE_SCENE_ACROSS_P1_BATCHES';sourceVersion:string;
 decisionIndex:number;previousDecisionIndex:number;start:number;end:number;cut:number;
 episodeNumber:number;fromSceneNumber:number;toSceneNumber:number;
 sourceAnchor:Range&{sceneId:string;episodeId:string};
 previousBatch:Range;nextBatch:Range&{status:'CURRENT'|'COMPLETED'};
};
type ContinuityReason='SOURCE_UNVERIFIABLE'|'INVALID_DECISION_RANGE'|'EPISODE_OR_CONTEXT_CHANGE'|'NONADJACENT_DECISIONS'
 |'BATCH_BOUNDARY_UNPROVEN'|'MANUAL_BOUNDARY_PRESENT'|'NEW_SOURCE_EPISODE'|'NEW_SOURCE_SCENE'
 |'SOURCE_ANCHOR_UNCONFIRMED'|'SOURCE_RANGE_CROSSES_SCENE'|'SOURCE_OWNERSHIP_UNCONFIRMED'
 |'POSSIBLE_IMPLICIT_BOUNDARY'|'CONTINUATION_FORM_UNCONFIRMED'|'PREVIOUS_SCENE_NOT_ANCHORED';
/** SKIPPED is informational; UNRESOLVED has proved cross-batch conflict evidence. */
export type P1BatchContinuityDiagnostic={status:'SKIPPED'|'UNRESOLVED';reason:ContinuityReason;start:number;end:number;cut:number|null};
export type P1BatchContinuityResult={decisions:FidelityDecision[];corrections:P1BatchContinuityCorrection[];diagnostics:P1BatchContinuityDiagnostic[]};
const overlaps=(a:Range,b:Range)=>a.start<b.end&&b.start<a.end;

/** This is only a conservative veto, not a second scene parser. Unrecognized
 * prose/stage directions and possible movement/time/transition cues need review;
 * their absence cannot create an anchor that normalize did not already prove. */
function mayHideBoundary(row:FidelitySegment){
 const text=row.text.trim();
 if(!text||row.reason==='continued_scene_metadata')return false;
 if(/【|\[|镜头(?:切|转)|画面(?:切|转)|转场|切至|切到|闪回|回忆|梦境|翌日|次日|次晨|第二天|[零〇一二两三四五六七八九十百千万\d]+(?:年|个月|天|小时)后|与此同时|另一边|蒙太奇|淡入|淡出|黑场|(?:走|跑|冲|踏|迈)(?:进|出|入)|来到|抵达|离开|进入/.test(text))return true;
 return !row.speakerLabels.length&&!/^[△▲]/.test(text)&&!/^(?:人物|出场人物)\s*[:：]/.test(text);
}

/** A parser-inherited scene id is not positive continuity evidence. Limit the
 * mechanical fix to dialogue led by an already explicitly listed/speaking actor.
 * Subsequent non-dialogue must have that same explicit actor subject and a small
 * physical-reaction form; opaque action/location/time narration stays pending.
 * This is a conservative transport repair, not a universal semantic scene test. */
function hasBoundedContinuation(prior:FidelitySegment[],next:FidelitySegment[]){
 const actor=(label:string)=>label.replace(/[（(][^）)]*[）)]$/,'').replace(/(?:os|vo)$/i,'');
 const known=new Set(prior.flatMap(row=>[
  ...row.speakerLabels.map(actor),
  ...(/^(?:人物|出场人物)\s*[:：]\s*(.+)$/.exec(row.text.trim())?.[1].split(/[\s,，、]+/).filter(name=>/^[\p{L}·・]{1,24}$/u.test(name))??[]),
 ]).filter(Boolean));
 // Match the entire physical node, never just "actor + reaction" with an
 // arbitrary narrative suffix that may actually establish a different scene.
 const physical=/^(?:(?:低头|抬头|闭眼|睁眼|点头|摇头|皱眉|叹气|微笑|握拳|攥紧)|(?:低头|抬头)?看着(?:自己的)?(?:胸膛|胸口|手臂|手背|腿|脸|肌肤|皮肤)(?:上)?的(?:伤疤|伤口|血迹)(?:[，,](?:水流|水珠|汗水)(?:划过|滑过|流过)(?:肌肤|皮肤|脸颊|手背))?)[。.!！]?$/;
 const rows=next.filter(row=>row.text.trim());
 if(!rows[0]?.speakerLabels.length)return false;
 return rows.every(row=>{
  if(row.speakerLabels.length)return row.speakerLabels.every(label=>known.has(actor(label)));
  const action=/^[△▲]\s*(.+)$/.exec(row.text.trim())?.[1];
  return action!==undefined&&[...known].some(name=>action.startsWith(name)&&physical.test(action.slice(name.length)));
 });
}

/** Returns cloned P1 decisions only; adopted/manual decisions are never changed
 * or returned as new P1 work. The caller owns the source-version guard and must
 * retain raw responses. Batch coordinates are evidence, not scene boundaries. */
export function reconcileP1BatchContinuityDecisions(text:string,input:P1BatchContinuityInput):P1BatchContinuityResult {
 const decisions=structuredClone([...input.pendingDecisions]);
 const corrections:P1BatchContinuityCorrection[]=[],diagnostics:P1BatchContinuityDiagnostic[]=[];
 const result={decisions,corrections,diagnostics};
 if(decisions.length<2)return result;
 let source:FidelityResult;
 try{source=normalize(text) as FidelityResult;}catch{
  diagnostics.push({status:'SKIPPED',reason:'SOURCE_UNVERIFIABLE',start:0,end:text.length,cut:null});return result;
 }
 const bounds=new Set([0,text.length,...source.segments.flatMap(row=>[row.start,row.end])]);
 const validRange=(range:Range)=>Number.isSafeInteger(range.start)&&Number.isSafeInteger(range.end)&&range.start>=0&&range.end>range.start&&range.end<=text.length&&bounds.has(range.start)&&bounds.has(range.end);
 const ordered=decisions.map((decision,index)=>({decision,index})).sort((a,b)=>a.decision.start-b.decision.start);
 // A later partial decision becomes trusted only through an already proved chain
 // rooted at the independent source heading, never merely through its AI number.
 const anchored=new Map<number,string>();
 for(let index=1;index<ordered.length;index++){
  const left=ordered[index-1],right=ordered[index],previous=left.decision,current=right.decision,cut=current.start;
  const differs=previous.sceneNumber!==current.sceneNumber;
  const report=(status:P1BatchContinuityDiagnostic['status'],reason:ContinuityReason)=>{
   if(differs)diagnostics.push({status,reason,start:current.start,end:current.end,cut});
  };
  if(previous.kind!=='body'||current.kind!=='body'||previous.episodeNumber!==current.episodeNumber){report('SKIPPED','EPISODE_OR_CONTEXT_CHANGE');continue;}
  if(!validRange(previous)||!validRange(current)||!Number.isSafeInteger(previous.episodeNumber)||previous.episodeNumber!<0
   ||!Number.isSafeInteger(previous.sceneNumber)||previous.sceneNumber!<1||!Number.isSafeInteger(current.sceneNumber)||current.sceneNumber!<1){report('SKIPPED','INVALID_DECISION_RANGE');continue;}
  if(previous.end!==cut){report('SKIPPED','NONADJACENT_DECISIONS');continue;}
  const previousBatch=input.completedRanges.find(range=>validRange(range)&&range.end===cut&&range.start<=previous.start);
  const nextCurrent=input.currentBatch&&validRange(input.currentBatch)&&input.currentBatch.start===cut&&input.currentBatch.end>=current.end?input.currentBatch:undefined;
  const nextCompleted=input.completedRanges.find(range=>validRange(range)&&range.start===cut&&range.end>=current.end);
  const nextBatch=nextCurrent?{...nextCurrent,status:'CURRENT' as const}:nextCompleted?{...nextCompleted,status:'COMPLETED' as const}:undefined;
  if(!previousBatch||!nextBatch){report('SKIPPED','BATCH_BOUNDARY_UNPROVEN');continue;}
  const affected={start:previous.start,end:current.end};
  if(input.manualDecisions.some(manual=>!validRange(manual)||overlaps(manual,affected)||manual.start===cut||manual.end===cut)){report('SKIPPED','MANUAL_BOUNDARY_PRESENT');continue;}
  const priorRows=source.segments.filter(row=>overlaps(row,previous)),nextRows=source.segments.filter(row=>overlaps(row,current));
  const prior=priorRows.at(-1),next=nextRows[0];
  if(prior?.episodeId&&next?.episodeId&&prior.episodeId!==next.episodeId){report('SKIPPED','NEW_SOURCE_EPISODE');continue;}
  if(prior?.sceneId&&next?.sceneId&&prior.sceneId!==next.sceneId){report('SKIPPED','NEW_SOURCE_SCENE');continue;}
  if(!prior?.sceneId||!prior.episodeId||!next?.sceneId||!next.episodeId){report('UNRESOLVED','SOURCE_ANCHOR_UNCONFIRMED');continue;}
  const anchor=source.segments.find(row=>row.sceneId===prior.sceneId&&['explicit_scene_heading','inline_scene_body'].includes(row.reason));
  if(!anchor||anchor.start>=cut){report('UNRESOLVED','SOURCE_ANCHOR_UNCONFIRMED');continue;}
  if([...priorRows,...nextRows].some(row=>row.episodeId!==prior.episodeId||row.sceneId!==prior.sceneId||!['body','format'].includes(row.kind))){report('UNRESOLVED','SOURCE_RANGE_CROSSES_SCENE');continue;}
  const owned={start:anchor.start,end:current.end};
  if(input.manualDecisions.some(manual=>overlaps(manual,owned))){report('SKIPPED','MANUAL_BOUNDARY_PRESENT');continue;}
  const episode=source.episodes.find(episode=>episode.id===prior.episodeId);
  if(!episode||parseEpisodeNumber(episode.sourceNumber)!==previous.episodeNumber||source.validation.issues.some(issue=>overlaps(issue,owned))){report('UNRESOLVED','SOURCE_OWNERSHIP_UNCONFIRMED');continue;}
  if(source.segments.some(row=>row.start>=anchor.end&&row.end<=current.end&&mayHideBoundary(row))){report('UNRESOLVED','POSSIBLE_IMPLICIT_BOUNDARY');continue;}
  if(!hasBoundedContinuation(source.segments.filter(row=>row.start>=anchor.end&&row.end<=cut),nextRows)){report('UNRESOLVED','CONTINUATION_FORM_UNCONFIRMED');continue;}
  if(previous.start!==anchor.start&&anchored.get(left.index)!==anchor.sceneId){report('UNRESOLVED','PREVIOUS_SCENE_NOT_ANCHORED');continue;}
  anchored.set(right.index,anchor.sceneId!);
  if(!differs)continue;
  corrections.push({reason:'SAME_SOURCE_SCENE_ACROSS_P1_BATCHES',sourceVersion:source.source.sourceVersion,
   decisionIndex:right.index,previousDecisionIndex:left.index,start:current.start,end:current.end,cut,
   episodeNumber:previous.episodeNumber!,fromSceneNumber:current.sceneNumber!,toSceneNumber:previous.sceneNumber!,
   sourceAnchor:{start:anchor.start,end:anchor.end,sceneId:anchor.sceneId!,episodeId:anchor.episodeId!},
   previousBatch:{...previousBatch},nextBatch});
  current.sceneNumber=previous.sceneNumber;
 }
 return result;
}
