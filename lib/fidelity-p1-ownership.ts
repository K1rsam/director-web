import {normalize} from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import type {FidelityDecision,FidelityResult} from './fidelity-import';
import {isDeepStrictEqual} from 'node:util';
import {parseEpisodeNumber} from './episode-presentation';
export type P1OwnershipCorrection={start:number;end:number;episodeNumber:number;reason:'REDUNDANT_EPISODE_ASSIGNMENT_PRESERVED_SOURCE_STRUCTURE'|'P1_PREAMBLE_FORMATTING_PROJECTION';sourceVersion:string;proofSnapshotId?:string;originalDecision?:FidelityDecision;preservedFormatting?:Array<{start:number;end:number}>};
const numberValue=(value:string|null):number=>value===null?NaN:parseEpisodeNumber(value)??NaN;
/** P1 assigns ownership, not rendering kinds. Drop only whole assignments that
 * independently add no episode/scene ownership and would turn known formatting
 * into unscened body. Never alter a genuine boundary/context/scene decision. */
export function reconcileP1OwnershipDecisions(text:string,decisions:readonly FidelityDecision[],options:{ownershipDecisions?:readonly FidelityDecision[];protectedRanges?:readonly {start:number;end:number}[];proofSnapshotId?:string}={}):{decisions:FidelityDecision[];corrections:P1OwnershipCorrection[]} {
 const baseline=normalize(text) as FidelityResult,corrections:P1OwnershipCorrection[]=[];
 if(!baseline.validation.ok)return {decisions:structuredClone([...decisions]),corrections};
 const selected=decisions.flatMap(decision=>{
  // Only receiver-validated P1 proposals are ownership, not arbitrary adopted
  // body classifications. External/manual decisions never acquire this basis.
  if(!options.ownershipDecisions?.some(owned=>isDeepStrictEqual(owned,decision))||options.protectedRanges?.some(range=>range.start<decision.end&&decision.start<range.end)
   ||decision.kind!=='body'||decision.sceneNumber!==undefined||!Number.isInteger(decision.episodeNumber)||decision.episodeNumber!<=0)return [decision];
  const rows=baseline.segments.filter(row=>row.start<decision.end&&row.end>decision.start);
  if(!rows.length||rows[0].start!==decision.start||rows.at(-1)!.end!==decision.end)return [decision];
  const redundant=!baseline.validation.issues.some(issue=>issue.start<decision.end&&issue.end>decision.start)
   &&rows.some(row=>row.kind==='body'&&row.sceneId)&&rows.some(row=>row.kind==='format'&&!row.sceneId&&row.text.trim())
   &&!rows.some(row=>numberValue(row.sourceNumber)!==decision.episodeNumber||!row.episodeId||!['body','format'].includes(row.kind)
   ||row.kind==='body'&&!row.sceneId
   ||row.reason==='explicit_episode_heading'&&!/^(?:#{1,6}\s*)?第\s*[零〇一二两三四五六七八九十百千\d]+\s*集\s*$/.test(row.text.trim())
   ||row.kind==='format'&&row.text.trim()&&(!['explicit_episode_heading','explicit_scene_heading','continued_scene_metadata'].includes(row.reason)||row.speakerLabels.length>0||/[△▲。！？!?“”「」]/.test(row.text)));
  if(redundant){corrections.push({start:decision.start,end:decision.end,episodeNumber:decision.episodeNumber!,reason:'REDUNDANT_EPISODE_ASSIGNMENT_PRESERVED_SOURCE_STRUCTURE',sourceVersion:baseline.source.sourceVersion,...(options.proofSnapshotId?{proofSnapshotId:options.proofSnapshotId}:{})});return [];}
  const formatting=rows.filter(row=>row.kind==='format'&&!row.sceneId&&!!row.episodeId&&numberValue(row.sourceNumber)===decision.episodeNumber
   &&['explicit_episode_metadata','source_whitespace'].includes(row.reason)||row.kind==='format'&&!row.sceneId&&numberValue(row.sourceNumber)===decision.episodeNumber
   &&row.reason==='explicit_episode_heading'&&/^(?:#{1,6}\s*)?第\s*[零〇一二两三四五六七八九十百千\d]+\s*集\s*$/.test(row.text.trim()));
  if(!formatting.length)return [decision];
  const omitted=new Set(formatting.map(row=>row.start)),parts:FidelityDecision[]=[];
  for(const row of rows){if(omitted.has(row.start))continue;const last=parts.at(-1);if(last?.end===row.start)last.end=row.end;else parts.push({...decision,start:row.start,end:row.end});}
  corrections.push({start:decision.start,end:decision.end,episodeNumber:decision.episodeNumber!,reason:'P1_PREAMBLE_FORMATTING_PROJECTION',sourceVersion:baseline.source.sourceVersion,originalDecision:structuredClone(decision),preservedFormatting:formatting.map(({start,end})=>({start,end})),...(options.proofSnapshotId?{proofSnapshotId:options.proofSnapshotId}:{})});
  return parts;
 });
 return {decisions:structuredClone(selected),corrections};
}
