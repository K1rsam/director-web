import { createHash } from 'node:crypto';
import { readApplicationScope, scopeApplies } from './foundation-application-scope';
import { buildFoundationFragments, type FoundationFragment } from './foundation-fragments';
import type { SourceIndex } from './project-foundation-contracts';
import type { FoundationChoiceRegistry } from './foundation-choice-store';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** A long episode never changes the scheduling mode of another episode. */
export function partitionFoundationSource(index:SourceIndex,threshold=24000) {
 const longEpisodes=new Set(index.episodes.filter(e=>e.content.length>threshold).map(e=>e.number));
 const orderedGroups:number[][]=[];
 for(const episode of index.episodes){const previous=orderedGroups.at(-1);if(!longEpisodes.has(episode.number)&&previous&&!longEpisodes.has(previous[0]))previous.push(episode.number);else orderedGroups.push([episode.number]);}
 return {longEpisodes,orderedGroups,shortEpisodes:index.episodes.filter(e=>!longEpisodes.has(e.number)).map(e=>e.number),fragments:buildFoundationFragments(index).filter(f=>longEpisodes.has(f.episode))};
}
type Scene={episode:number;sceneKey:string;sourceRange:{start:number;end:number}};
type Identity={key:string;name:string;type:string;aliases?:string[];usageEpisodes?:number[];episodes?:number[];sceneRefs?:{episode:number;sceneKey:string}[]};
/** Cache dependency uses exact local text and explicit choice scope, never whole-project source version. */
export function fragmentDependency(fragment:FoundationFragment,index:SourceIndex,choices:FoundationChoiceRegistry,scenes:readonly Scene[],identities:readonly Identity[],settings:unknown) {
 const localScenes=scenes.filter(s=>s.episode===fragment.episode&&s.sourceRange.start<fragment.end&&s.sourceRange.end>fragment.start);
 const relevant=choices.filter(choice=>{
  const scope=readApplicationScope(choice.applicationScope,choice.episodes);
  return scope.kind==='SCENES'?localScenes.some(s=>scopeApplies(scope,s.episode,s.sceneKey)):scopeApplies(scope,fragment.episode);
 });
 // Keep every identity used in this episode, including dependencies outside the slice.
 const identity=identities.filter(a=>(a.usageEpisodes??a.episodes??[]).includes(fragment.episode)||a.sceneRefs?.some(s=>s.episode===fragment.episode)).map(a=>({key:a.key,name:a.name,type:a.type,aliases:[...(a.aliases??[])].sort()})).sort((a,b)=>a.key.localeCompare(b.key));
 return hash({text:index.episodes.find(e=>e.number===fragment.episode)!.content.slice(fragment.start,fragment.end),settings,scenes:localScenes,identity,choices:relevant.map(c=>({...c})).sort((a,b)=>a.decisionKey.localeCompare(b.decisionKey))});
}
/** Unknown historical dependency is retained for the controller's paid-evidence check, never silently discarded. */
export function changedFragmentIds(completed:readonly string[],previous:Record<string,string>|undefined,current:Record<string,string>) {
 return completed.filter(id=>previous?.[id]!==undefined&&previous[id]!==current[id]);
}
