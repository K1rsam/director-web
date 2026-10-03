import type {VisualChunk} from './asset-visual-facts-contract';
export const VISUAL_FACT_PLANNER_VERSION='SINGLE_EXTRACT_V4';
type Identity={key:string;name:string;aliases:string[];usageEpisodes?:number[];variants:{key:string;name:string;episodes?:number[]}[]};
export type AssetProductionScope={episodeNumbers:number[];assetKeys?:string[]};
export function normalizeAssetProductionScope(scope:AssetProductionScope,availableEpisodes:number[]):AssetProductionScope{
 if(!scope||!Array.isArray(scope.episodeNumbers)||!scope.episodeNumbers.length||scope.episodeNumbers.some(n=>!Number.isSafeInteger(n)||!availableEpisodes.includes(n)))throw new Error('请明确选择存在的制作集数；选集范围不能为空。');
 if(scope.assetKeys!==undefined&&(!Array.isArray(scope.assetKeys)||!scope.assetKeys.length||scope.assetKeys.some(key=>typeof key!=='string'||!key.trim())))throw new Error('资产范围不能为空或包含无效身份。');
 return {episodeNumbers:[...new Set(scope.episodeNumbers)].sort((a,b)=>a-b),...(scope.assetKeys?{assetKeys:[...new Set(scope.assetKeys)].sort()}: {})};
}
/** Program index only. A scoped request never falls back to the entire series catalogue. */
export function scopedVisualIdentities<T extends Identity>(identities:T[],scope:AssetProductionScope):T[]{
 return identities.filter(item=>(!scope.assetKeys||scope.assetKeys.includes(item.key)||item.variants.some(v=>scope.assetKeys!.includes(v.key)))&&(item.usageEpisodes?.some(n=>scope.episodeNumbers.includes(n))||item.variants.some(v=>v.episodes?.some(n=>scope.episodeNumbers.includes(n)))||Boolean(scope.assetKeys?.includes(item.key))))
  .map(item=>({...item,variants:item.variants.filter(v=>v.episodes?.some(n=>scope.episodeNumbers.includes(n))||scope.assetKeys?.includes(v.key))}));
}
function names(identity:Identity){
 return [...new Set([identity.name,...identity.aliases,...identity.variants.map(v=>v.name)].flatMap(name=>[name.trim(),name.split(/[|｜]/)[0].trim()]).filter(name=>name.length>=1))];
}
/** P3 scope and text mentions are candidate routing only, never appearance evidence. */
export function selectVisualIdentities<T extends Identity>(chunk:VisualChunk,identities:T[]):T[]{
 if(chunk.domain==='AUTHOR')return identities;
 const text=[chunk.contextBefore??'',...chunk.lines.map(l=>l.text)].join('\n');
 const selected=identities.filter(identity=>identity.usageEpisodes?.includes(chunk.episode!)||identity.variants.some(v=>v.episodes?.includes(chunk.episode!))||names(identity).some(name=>text.includes(name)));
 // Unrecognised naming or a faulty P3 scope must not result in an empty routing table.
 return selected.length?selected:identities;
}
/** Keep immutable chunk IDs/line coordinates and individual caches; only group transport. */
export function groupVisualFactBatches<T extends {chunk:VisualChunk}>(items:T[]):T[][]{
 const groups:T[][]=[];let group:T[]=[],chars=0;
 for(const item of [...items].sort((a,b)=>Number(a.chunk.domain==='AUTHOR')-Number(b.chunk.domain==='AUTHOR'))){const size=item.chunk.lines.reduce((sum,line)=>sum+line.text.length+1,0)+(item.chunk.contextBefore?.length??0);
  if(group.length&&(chars+size>24000||group.length>=40||item.chunk.domain==='AUTHOR'||group[0].chunk.domain==='AUTHOR')){groups.push(group);group=[];chars=0;}
  group.push(item);chars+=size;
 }
 if(group.length)groups.push(group);return groups;
}
