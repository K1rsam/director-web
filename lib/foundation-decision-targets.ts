import {readApplicationScope, scopeApplies, scopeEpisodes} from './foundation-application-scope';
import type {FoundationChoiceView} from './foundation-choice-store';
import type {FoundationDocument} from './foundation-document';
import type {ProductionOptimization} from './foundation-production-contracts';
/** Only explicit scene scopes authorize scene restriction. Legacy episode/global decisions keep their declared scope. */
export function decisionSceneKeys(choices: Pick<FoundationChoiceView,'applicationScope'|'episodes'>[], episodes: number[]): string[] | undefined {
 const scopes=choices.map(choice=>readApplicationScope(choice.applicationScope,choice.episodes));
 if(!scopes.length||scopes.some(scope=>scope.kind!=='SCENES'))return undefined;
 return [...new Set(scopes.flatMap(scope=>scope.kind==='SCENES'?scope.scenes.filter(scene=>episodes.includes(scene.episode)).map(scene=>scene.sceneKey):[]))];
}

/** Narrow only from explicit machine-readable consent, never from names/question prose. */
export function decisionAssetKeys(choices: FoundationChoiceView[]): string[] | undefined {
 if (!choices.length || choices.some(c=>!c.changeTargets)) return undefined;
 return [...new Set(choices.flatMap(c=>c.changeTargets!.assetKeys))];
}

/** Validate the resulting document as well as patches, so omitted/copied fields cannot bypass permission. */
export function assertDecisionChanges(choices: FoundationChoiceView[], scope: number[], output: ProductionOptimization, before: FoundationDocument, after: FoundationDocument): void {
 if (!choices.some(c=>c.changeTargets)) return; // Legacy consent retains its declared scope; never guess object bindings.
 const fail=(at:string):never=>{throw new Error(`确认事项的局部修订越出授权对象或字段：${at}；原资料保留。`)};
 const covers=(c:FoundationChoiceView,episodes:number[])=>episodes.every(n=>scopeApplies(readApplicationScope(c.applicationScope,c.episodes),n));
 const owns=(c:FoundationChoiceView,key:string,field:string)=>!c.changeTargets || c.changeTargets.assetKeys.includes(key)&&c.changeTargets.assetFields.some(f=>f===field);
 const coversRefs=(c:FoundationChoiceView,episodes:number[],refs:{episode:number;sceneKey:string}[]=[])=>{
  const s=readApplicationScope(c.applicationScope,c.episodes);
  return (episodes.length>0||s.kind==='GLOBAL')&&covers(c,episodes)&&(s.kind!=='SCENES'||episodes.every(n=>refs.some(r=>r.episode===n))&&refs.every(r=>scopeApplies(s,r.episode,r.sceneKey)));
 };
 const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
 const allExplicit=choices.every(c=>c.changeTargets);
 if(allExplicit && (output.changes.removeAssetKeys?.length||output.changes.mergeAssets?.length||output.changes.sceneSplits?.length))fail('删除、归并或重新拆场未获授权');
 const keys=new Set([...(before.f2?.assets??[]),...(after.f2?.assets??[])].map(a=>a.key));
 for(const key of keys) {
  const old=before.f2?.assets.find(a=>a.key===key),next=after.f2?.assets.find(a=>a.key===key);
  if(equal(old,next))continue;
  if(!old||!next)fail(`assets.${key}.createOrDelete`);
  const fields=new Set([...Object.keys(old!),...Object.keys(next!)]);
  for(const field of fields) {
   if(['variants','sceneRefs'].includes(field)||equal((old as unknown as Record<string,unknown>)[field],(next as unknown as Record<string,unknown>)[field]))continue;
   if(!choices.some(c=>owns(c,key,field)&&coversRefs(c,old!.usageEpisodes,old!.sceneRefs)&&coversRefs(c,next!.usageEpisodes,next!.sceneRefs)))fail(`assets.${key}.${field}`);
  }
  if(!equal(old!.sceneRefs,next!.sceneRefs)) {
   const changed=[...(old!.sceneRefs??[]).filter(r=>!(next!.sceneRefs??[]).some(n=>equal(r,n))),...(next!.sceneRefs??[]).filter(r=>!(old!.sceneRefs??[]).some(n=>equal(r,n)))];
   if(!changed.length||changed.some(ref=>!choices.some(c=>owns(c,key,'sceneRefs')&&scopeApplies(readApplicationScope(c.applicationScope,c.episodes),ref.episode,ref.sceneKey))))fail(`assets.${key}.sceneRefs`);
  }
  // A local decision cannot rewrite a shared variant that also serves another scene.
  for(const variantKey of new Set([...old!.variants,...next!.variants].map(v=>v.key))) {
   const variant=old!.variants.find(v=>v.key===variantKey),replacement=next!.variants.find(v=>v.key===variantKey);
   if(equal(variant,replacement))continue;
   if(!choices.some(c=>owns(c,key,'variants')&&(!variant||coversRefs(c,variant.episodes,variant.sceneRefs))&&(!replacement||coversRefs(c,replacement.episodes,replacement.sceneRefs))))fail(`assets.${key}.variants.${variantKey}`);
  }
 }
 for(const patch of output.changes.scenes??[]) for(const field of Object.keys(patch).filter(k=>!['episode','sceneKey'].includes(k))) {
  const allowed=choices.some(c=>scopeApplies(readApplicationScope(c.applicationScope,c.episodes),patch.episode,patch.sceneKey)&&(!c.changeTargets||c.changeTargets.sceneFields.some(f=>f===field)));
  if(!allowed)fail(`scenes.${patch.sceneKey}.${field}`);
 }
 if(scope.some(n=>!choices.some(c=>scopeEpisodes(readApplicationScope(c.applicationScope,c.episodes),scope).includes(n))))fail('coverage');
}
