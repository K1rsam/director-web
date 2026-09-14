import {normalize} from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import type {FidelityDecision,FidelityResult} from './fidelity-import';
export type P1OwnershipCorrection={start:number;end:number;episodeNumber:number;reason:'REDUNDANT_EPISODE_ASSIGNMENT_PRESERVED_SOURCE_STRUCTURE';sourceVersion:string};
const numberValue=(value:string|null):number=>{
 if(value===null)return NaN;if(/^\d+$/.test(value))return Number(value);
 let total=0,digit=0;
 for(const char of value){const n='零一二三四五六七八九'.indexOf(char);if(n>=0)digit=n;else if(char==='〇')digit=0;else if(char==='两')digit=2;else if('十百千'.includes(char)){total+=(digit||1)*({十:10,百:100,千:1000}[char as '十'|'百'|'千']);digit=0;}else return NaN;}
 return total+digit;
};
/** P1 assigns ownership, not rendering kinds. Drop only whole assignments that
 * independently add no episode/scene ownership and would turn known formatting
 * into unscened body. Never alter a genuine boundary/context/scene decision. */
export function reconcileP1OwnershipDecisions(text:string,decisions:readonly FidelityDecision[]):{decisions:FidelityDecision[];corrections:P1OwnershipCorrection[]} {
 const baseline=normalize(text) as FidelityResult,corrections:P1OwnershipCorrection[]=[];
 if(!baseline.validation.ok)return {decisions:structuredClone([...decisions]),corrections};
 const selected=decisions.filter(decision=>{
  if(decision.kind!=='body'||decision.sceneNumber!==undefined||!Number.isInteger(decision.episodeNumber)||decision.episodeNumber!<=0)return true;
  const rows=baseline.segments.filter(row=>row.start<decision.end&&row.end>decision.start);
  if(!rows.length||rows[0].start!==decision.start||rows.at(-1)!.end!==decision.end||baseline.validation.issues.some(issue=>issue.start<decision.end&&issue.end>decision.start))return true;
  if(!rows.some(row=>row.kind==='body'&&row.sceneId)||!rows.some(row=>row.kind==='format'&&!row.sceneId&&row.text.trim()))return true;
  if(rows.some(row=>numberValue(row.sourceNumber)!==decision.episodeNumber||!row.episodeId||!['body','format'].includes(row.kind)
   ||row.kind==='body'&&!row.sceneId
   ||row.reason==='explicit_episode_heading'&&!/^(?:#{1,6}\s*)?第\s*[零〇一二两三四五六七八九十百千\d]+\s*集\s*$/.test(row.text.trim())
   ||row.kind==='format'&&row.text.trim()&&(!['explicit_episode_heading','explicit_scene_heading','continued_scene_metadata'].includes(row.reason)||row.speakerLabels.length>0||/[△▲。！？!?“”「」]/.test(row.text))))return true;
  corrections.push({start:decision.start,end:decision.end,episodeNumber:decision.episodeNumber!,reason:'REDUNDANT_EPISODE_ASSIGNMENT_PRESERVED_SOURCE_STRUCTURE',sourceVersion:baseline.source.sourceVersion});return false;
 });
 return {decisions:structuredClone(selected),corrections};
}
