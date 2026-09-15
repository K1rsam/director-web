import type {VisualChunk} from './asset-visual-facts-contract';
export const VISUAL_FACT_PLANNER_VERSION='GROUPED_AB_V2';
type Identity={key:string;name:string;aliases:string[];usageEpisodes?:number[];variants:{key:string;name:string;episodes?:number[]}[]};
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
  if(group.length&&(chars+size>6500||group.length>=8||item.chunk.domain==='AUTHOR'||group[0].chunk.domain==='AUTHOR')){groups.push(group);group=[];chars=0;}
  group.push(item);chars+=size;
 }
 if(group.length)groups.push(group);return groups;
}
