import { readApplicationScope, scopeApplies } from './foundation-application-scope';
/** Filter only explicit applicability; do not infer consent from names or evidence locations. */
export function selectRequestChoices<T extends { episodes?: readonly number[]; applicationScope?: unknown }>(choices: readonly T[], episodes: readonly number[], scenes?: readonly {episode:number;sceneKey:string}[]): T[] {
 return choices.filter(choice => {
  const scope=readApplicationScope(choice.applicationScope,choice.episodes??[]);
  return episodes.some(episode=>scopeApplies(scope,episode)) && (scope.kind!=='SCENES'||!scenes||scenes.some(scene=>scopeApplies(scope,scene.episode,scene.sceneKey)));
 });
}
/** Located issues stay local; unlocated issues remain visible until their dependency is known. */
export function selectRequestIssues<T extends {sourceRefs: {episode:number}[];coordinate:string}>(issues: readonly T[], episodes: readonly number[], owners: readonly {key:string;episodes:readonly number[]}[]): T[] {
 return issues.filter(issue=>{
  if(issue.sourceRefs.length)return issue.sourceRefs.some(ref=>episodes.includes(ref.episode));
  const owner=owners.filter(owner=>issue.coordinate==='assets.'+owner.key||issue.coordinate.startsWith('assets.'+owner.key+'.')).sort((a,b)=>b.key.length-a.key.length)[0];
  return !owner||owner.episodes.some(n=>episodes.includes(n));
 });
}
