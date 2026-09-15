import type {VisualFact,VisualIssue} from './asset-visual-facts-contract';

/** Only explicit version facts override inherited attributes; no name/substring ownership. */
export function selectAssetVisualFacts(subjectKey:string,key:string,facts:VisualFact[],versions:{key:string;fromKey?:string}[]) {
 const owned=facts.filter(f=>f.subjectKey===subjectKey),chain:string[]=[];
 const seen=new Set<string>();let cursor:string|undefined=key;
 while(cursor){if(seen.has(cursor))throw new Error('资产参考关系存在循环，请先核对目录。');seen.add(cursor);chain.unshift(cursor);cursor=versions.find(v=>v.key===cursor)?.fromKey;}
 let selected=owned.filter(f=>f.scope==='STABLE'&&!f.versionKey);
 for(const version of chain){
  const explicit=owned.filter(f=>f.versionKey===version);
  const attributes=new Set(explicit.map(f=>f.attribute));
  selected=[...selected.filter(f=>!attributes.has(f.attribute)),...explicit];
 }
 const unresolved:VisualIssue[]=owned.filter(f=>f.scope!=='STABLE'&&!f.versionKey).map(f=>({subjectKey,message:`${f.attribute} 的适用形象尚未确定：${f.value}（${f.sourceLabel??f.chunkId}）`}));
 return {facts:[...new Map(selected.map(f=>[f.id,f])).values()],issues:unresolved};
}
