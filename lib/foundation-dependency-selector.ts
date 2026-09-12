/** Retrieval relevance is not identity confirmation. Ambiguous names keep every matching key. */
export type DependencyIdentity = {
 key:string;name:string;aliases:string[];usageEpisodes?:number[];episodes?:number[];
 appearances?:Array<{episode:number}>;sceneRefs?:Array<{episode:number;sceneKey:string}>;
 preparation?:{fromKey?:string};relationNote?:string;
 variants?:Array<{key:string;name:string;episodes?:number[];preparation?:{fromKey?:string}}>;
};
export function dependencyIdentityKeys(assets:readonly DependencyIdentity[],scope:readonly number[],text:string,explicitKeys:readonly string[]=[]){
 const selected=new Set(explicitKeys),byKey=new Map(assets.map(a=>[a.key,a]));
 const variantOwners=new Map(assets.flatMap(a=>(a.variants??[]).map(v=>[v.key,a.key] as const)));
 const names=(a:DependencyIdentity)=>[a.name,...a.aliases,...(a.variants??[]).map(v=>v.name)].filter(Boolean);
 for(const a of assets)if(names(a).some(n=>text.includes(n))||[...(a.usageEpisodes??[]),...(a.episodes??[]),...(a.appearances??[]).map(r=>r.episode),...(a.sceneRefs??[]).map(r=>r.episode),...(a.variants??[]).flatMap(v=>v.episodes??[])].some(n=>scope.includes(n)))selected.add(a.key);
 let changed=true;
 while(changed){
  changed=false;const add=(key:string)=>{const owner=variantOwners.get(key)??key;if(!selected.has(owner)){selected.add(owner);changed=true;}};
  const selectedAssets=[...selected].flatMap(k=>byKey.has(k)?[byKey.get(k)!]:[]),knownNames=new Set(selectedAssets.flatMap(names));
  for(const a of assets){
   if(names(a).some(n=>knownNames.has(n)))add(a.key);
   if(selected.has(a.key)){
    for(const key of [a.preparation?.fromKey,...(a.variants??[]).map(v=>v.preparation?.fromKey)])if(key)add(key);
    for(const other of assets)if(names(other).some(n=>a.relationNote?.includes(n)))add(other.key);
   }
  }
 }
 return [...selected];
}
/**
 * Registry already is the minimum global key/name/alias/variant lookup, not full asset detail.
 * Missing episode/name evidence does not prove irrelevance (pronouns, delayed identities, flashbacks).
 * Until a provider retrieval contract exists retain this lookup, including unknown dependencies.
 */
export function selectDependencySafeRegistry<T extends {key:string}>(registry:readonly T[],_assets:readonly DependencyIdentity[],_scope:readonly number[],_text:string):T[]{
 return [...registry];
}
export function expandRelevantNames(initial:Iterable<string>,groups:readonly string[][]){
 const names=new Set(initial);let changed=true;
 while(changed){changed=false;for(const group of groups)if(group.some(n=>names.has(n)))for(const name of group)if(!names.has(name)){names.add(name);changed=true;}}
 return names;
}
