import {createHash} from 'node:crypto';
export type VisualChunk={id:string;domain:'AUTHOR'|'EPISODE';episode?:number;lines:{number:number;text:string}[];contextBefore?:string};
export type VisualFact={id:string;subjectKey:string;attribute:string;value:string;versionKey?:string;scope:'STABLE'|'STATE'|'TRANSITION';quote:string;chunkId:string;startLine:number;endLine:number;sourceLabel?:string};
export type VisualIssue={subjectKey?:string;message:string;blocking?:boolean};
export type VisualBatchResult={facts:VisualFact[];issues:VisualIssue[];coveredChunkId:string};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function visualFactSourceLabel(fact:VisualFact,chunks:VisualChunk[]):string{
 const chunk=chunks.find(c=>c.id===fact.chunkId);
 const source=chunk?.domain==='EPISODE'?`EPISODE · 第${chunk.episode}集`:chunk?.domain==='AUTHOR'?'AUTHOR · 作者资料':'未知来源';
 return `${source} · L${fact.startLine}${fact.endLine===fact.startLine?'':`–${fact.endLine}`} · ${fact.chunkId.slice(0,12)}`;
}
/** Candidate conflicts only: no synonym inference, no overwrite, no permanent conflict inferred from STATE changes. */
export function findVisualFactReviewIssues(facts:VisualFact[],chunks:VisualChunk[]):VisualIssue[]{
 const groups=new Map<string,VisualFact[]>();
 for(const fact of facts){if(fact.scope!=='STABLE')continue;const key=JSON.stringify([fact.subjectKey,fact.attribute.trim(),fact.versionKey??fact.subjectKey]);const group=groups.get(key)??[];group.push(fact);groups.set(key,group);}
 const issues:VisualIssue[]=[];
 for(const fact of facts){
  if((fact.scope==='STATE'||fact.scope==='TRANSITION')&&!fact.versionKey)issues.push({subjectKey:fact.subjectKey,message:`${fact.scope==='STATE'?'状态':'变化'}事实“${fact.attribute}”尚未绑定资产版本，需核对适用形象；未自动分配给母资产。${visualFactSourceLabel(fact,chunks)}：引用“${fact.quote.slice(0,300)}”`});
  if(fact.scope==='STABLE'){
   const transition=facts.find(t=>t.subjectKey===fact.subjectKey&&t.attribute.trim()===fact.attribute.trim()&&t.scope==='TRANSITION'&&(!fact.versionKey||!t.versionKey||fact.versionKey===t.versionKey));
   if(transition)issues.push({subjectKey:fact.subjectKey,message:`稳定属性“${fact.attribute}”同时存在变化记录，版本或前后时段尚未区分，需核对稳定范围；未自动覆盖。${visualFactSourceLabel(fact,chunks)}：引用“${fact.quote.slice(0,200)}” / ${visualFactSourceLabel(transition,chunks)}：引用“${transition.quote.slice(0,200)}”`});
  }
 }
 for(const group of groups.values()){
  const values=new Map<string,VisualFact>();for(const fact of group)if(!values.has(fact.value.trim()))values.set(fact.value.trim(),fact);
  if(values.size<2||new Set(group.map(f=>f.chunkId)).size<2)continue;
  const examples=[...values.values()].slice(0,5).map(f=>`${visualFactSourceLabel(f,chunks)}：${f.value.slice(0,180)}；引用“${f.quote.slice(0,180)}”`).join(' / ');
  issues.push({subjectKey:group[0].subjectKey,message:`跨批稳定属性“${group[0].attribute}”存在不同表述，需核对是否同义、时间变化或归属错误；全部事实已保留，未自动取舍。${examples}${values.size>5?` / 另有${values.size-5}种表述，详见事实列表。`:''}`});
 }
 return issues;
}
/** Every source line belongs to one batch. Overlap is context, never extra evidence. */
export function buildVisualChunks(input:{background:{key:string;text:string}[];episodes:{number:number;content:string}[]}):VisualChunk[]{
 const sources=[...input.background.map((s,i)=>({domain:'AUTHOR' as const,episode:undefined,text:s.text,source:i})),...input.episodes.map(s=>({domain:'EPISODE' as const,episode:s.number,text:s.content,source:s.number}))];
 return sources.flatMap(source=>{
  const all=source.text.split(/\r?\n/).map((text,i)=>({number:i+1,text}));const chunks:VisualChunk[]=[];
  for(let start=0;start<all.length;){let end=start,chars=0;while(end<all.length&&(chars+all[end].text.length<=12000||end===start)){chars+=all[end].text.length+1;end++;}
   const lines=all.slice(start,end),contextBefore=all.slice(Math.max(0,start-12),start).map(l=>l.text).join('\n').slice(-1800);
   chunks.push({id:hash([source.domain,source.source,lines]),domain:source.domain,...(source.episode===undefined?{}:{episode:source.episode}),lines,contextBefore});start=end;
  }return chunks;
 });
}
export function validateVisualBatch(value:unknown,chunk:VisualChunk,assets:{key:string;variants:{key:string}[]}[]):VisualBatchResult{
 if(!value||typeof value!=='object')throw new Error('视觉事实返回结构无效');const data=value as Record<string,unknown>;
 if(data.coveredChunkId!==chunk.id||!Array.isArray(data.facts)||!Array.isArray(data.issues))throw new Error('视觉事实缺少当前分片回执');
 const facts=data.facts.map((raw):VisualFact=>{
  if(!raw||typeof raw!=='object')throw new Error('事实结构无效');const r=raw as VisualFact;
  const asset=assets.find(a=>a.key===r.subjectKey);if(!asset)throw new Error('事实归属不在资产目录中');
  if(r.versionKey&&r.versionKey!==asset.key&&!asset.variants.some(v=>v.key===r.versionKey))throw new Error('事实版本不属于该主体');
  if(!['STABLE','STATE','TRANSITION'].includes(r.scope)||typeof r.attribute!=='string'||!r.attribute.trim()||typeof r.value!=='string'||!r.value.trim()||r.value.length>2000)throw new Error('事实属性或适用范围无效');
  if(r.chunkId!==chunk.id||!Number.isSafeInteger(r.startLine)||!Number.isSafeInteger(r.endLine)||r.endLine<r.startLine)throw new Error('事实出处无效');
  const lines=chunk.lines.filter(l=>l.number>=r.startLine&&l.number<=r.endLine);
  if(lines.length!==r.endLine-r.startLine+1||typeof r.quote!=='string'||!r.quote.trim()||!lines.map(l=>l.text).join('\n').includes(r.quote))throw new Error('事实引用未在对应原文中找到');
  const fact={subjectKey:r.subjectKey,attribute:r.attribute.trim(),value:r.value.trim(),...(r.versionKey?{versionKey:r.versionKey}:{}),scope:r.scope,quote:r.quote,chunkId:chunk.id,startLine:r.startLine,endLine:r.endLine};
  return {...fact,id:hash(fact)};
 });
 const issues=data.issues.map((raw):VisualIssue=>{if(!raw||typeof raw!=='object')throw new Error('核对问题结构无效');const r=raw as VisualIssue;if(typeof r.message!=='string'||!r.message.trim()||r.message.length>3000||(r.subjectKey!==undefined&&!assets.some(a=>a.key===r.subjectKey)))throw new Error('核对问题归属无效');if(r.blocking!==undefined&&typeof r.blocking!=='boolean')throw new Error('核对问题阻断标记无效');return {message:r.message,...(r.subjectKey?{subjectKey:r.subjectKey}:{}),...(r.blocking===undefined?{}:{blocking:r.blocking})};});
 return {coveredChunkId:chunk.id,facts:[...new Map(facts.map(f=>[f.id,f])).values()],issues};
}
