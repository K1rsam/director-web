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

/** A field and its complete before/after usage must belong to one same choice. */
export function decisionAssetFieldAllowed(choices: FoundationChoiceView[], key:string, field:string, old:NonNullable<FoundationDocument['f2']>['assets'][number], next:NonNullable<FoundationDocument['f2']>['assets'][number]):boolean {
 const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
 const owns=(choice:FoundationChoiceView)=>!choice.changeTargets||choice.changeTargets.assetKeys.includes(key)&&choice.changeTargets.assetFields.some(allowed=>allowed===field);
 const covers=(choice:FoundationChoiceView,episodes:number[],refs:{episode:number;sceneKey:string}[]=[])=>{
  const scope=readApplicationScope(choice.applicationScope,choice.episodes);
  return (episodes.length>0||scope.kind==='GLOBAL')&&episodes.every(episode=>scopeApplies(scope,episode))&&(scope.kind!=='SCENES'||episodes.every(episode=>refs.some(ref=>ref.episode===episode))&&refs.every(ref=>scopeApplies(scope,ref.episode,ref.sceneKey)));
 };
 if(field==='sceneRefs'){
  const changed=[...(old.sceneRefs??[]).filter(ref=>!(next.sceneRefs??[]).some(row=>equal(ref,row))),...(next.sceneRefs??[]).filter(ref=>!(old.sceneRefs??[]).some(row=>equal(ref,row)))];
  return changed.length>0&&changed.every(ref=>choices.some(choice=>owns(choice)&&scopeApplies(readApplicationScope(choice.applicationScope,choice.episodes),ref.episode,ref.sceneKey)));
 }
 if(field==='variants')return [...new Set([...old.variants,...next.variants].map(variant=>variant.key))].every(key=>{
  const previous=old.variants.find(variant=>variant.key===key),replacement=next.variants.find(variant=>variant.key===key);
  return equal(previous,replacement)||choices.some(choice=>owns(choice)&&(!previous||covers(choice,previous.episodes,previous.sceneRefs))&&(!replacement||covers(choice,replacement.episodes,replacement.sceneRefs)));
 });
 return choices.some(choice=>owns(choice)&&covers(choice,old.usageEpisodes,old.sceneRefs)&&covers(choice,next.usageEpisodes,next.sceneRefs));
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
   if(!decisionAssetFieldAllowed(choices,key,field,old!,next!))fail(`assets.${key}.${field}`);
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

/** Only aliases are independently reversible. Every other permission failure is
 * still fatal, and validation must run again on the complete corrected output. */
export function restoreUnauthorizedDecisionAliases(choices: FoundationChoiceView[], scope: number[], output: ProductionOptimization, before: FoundationDocument, after: FoundationDocument): { output: ProductionOptimization; correctedFields: string[] } {
 const unchanged={output,correctedFields:[] as string[]};
 if(!choices.length||choices.some(c=>!c.changeTargets)||!before.f2||!after.f2)return unchanged;
 if(output.changes.removeAssetKeys?.length||output.changes.mergeAssets?.length||output.changes.sceneSplits?.length)return unchanged;
 const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
 // Identity changes/new entities can depend on aliases. Never filter these.
 if(after.f2.assets.length!==before.f2.assets.length||after.f2.assets.some(asset=>{
  const old=before.f2!.assets.find(a=>a.key===asset.key);
  return !old||old.name!==asset.name||old.type!==asset.type;
 }))return unchanged;
 const corrected=structuredClone(output),fields:string[]=[];
 for(const asset of after.f2.assets){
  const old=before.f2.assets.find(a=>a.key===asset.key)!;
  if(equal(old.aliases,asset.aliases))continue;
  const aliasOnly=structuredClone(before);
  aliasOnly.f2!.assets.find(a=>a.key===asset.key)!.aliases=structuredClone(asset.aliases);
  try { assertDecisionChanges(choices,scope,{...output,changes:{}} as ProductionOptimization,before,aliasOnly); continue; } catch { /* This alias edit is not authorized. */ }
  const patch=corrected.changes.assets?.find(a=>a.key===asset.key);
  if(!patch||patch.aliases===undefined)return unchanged;
  const added=asset.aliases.filter(alias=>!old.aliases.includes(alias));
  const otherChanges=structuredClone(output.changes);
  // Ignore only the candidate alias field itself. References anywhere else,
  // including other aliases, are conservatively treated as dependencies.
  const samePatch=otherChanges.assets?.find(a=>a.key===asset.key);
  if(samePatch)delete samePatch.aliases;
  const mentions=(value:unknown):boolean=>typeof value==='string'?added.some(alias=>alias.length>0&&value.includes(alias)):Array.isArray(value)?value.some(mentions):!!value&&typeof value==='object'&&Object.values(value).some(mentions);
  if(mentions(otherChanges))return unchanged;
  patch.aliases=structuredClone(old.aliases);
  fields.push(`assets.${asset.key}.aliases`);
 }
 if(fields.length){
  const remaining=structuredClone(after.f2.assets);
  for(const asset of remaining)if(fields.includes(`assets.${asset.key}.aliases`))asset.aliases=structuredClone(before.f2.assets.find(a=>a.key===asset.key)!.aliases);
  // Do not turn an entirely unauthorized answer into a successful no-op receipt.
  if(equal(remaining,before.f2.assets))return unchanged;
 }
 return fields.length?{output:corrected,correctedFields:fields}:unchanged;
}
