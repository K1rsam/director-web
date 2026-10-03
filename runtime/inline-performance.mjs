// This is a conservative syntax view, not rewriting or an AI judgement.
// Uncertain/explanatory/nested/quoted parentheses remain protected speech.
export const INLINE_PERFORMANCE_VERSION='inline-performance-v1';
const acting=/^(?:低声|轻声|小声|大声|压低声音|提高声音|压住颤音|哽咽|哭腔|带哭腔|气喘|喘息|咬牙|大笑|苦笑|冷笑|轻笑|笑着|哭着|怒视|皱眉|挑眉|点头|摇头|抬头|低头|转头|转身|起身|蹲下|抬手|摆手|挥手|握拳|攥拳|摊手|耸肩|抿嘴|闭眼|睁眼|深吸一口气|叹气|掐着(?:手指|指头))$/u;
const clearCue=value=>value.trim().split(/[,，、;；]/u).every(x=>acting.test(x.trim()));
const literalMention=(text,start,end)=>/(?:叫|名为|称作|写着|写成|写的是|读作|读成|念作|念成|字样[：:]?)\s*$/u.test(text.slice(0,start))
 || /^\s*(?:这(?:个|两个|几个)?字|这些字|这个词|这个字样|一词|二字|两个字|三个字)/u.test(text.slice(end));

/** All slices refer to the original source, not a new rewritten script. */
export function inlinePerformanceProjection(source,parts){
 if(!Array.isArray(parts)||!parts.length)return null;
 let size=0;
 const mapped=parts.map(part=>{const from=size;size+=part.end-part.start;return {part,from,to:size};});
 const text=parts.map(p=>source.slice(p.start,p.end)).join('');
 const slice=(start,end)=>mapped.flatMap(({part,from,to})=>{
  const a=Math.max(from,start),b=Math.min(to,end);
  return a<b?[{...part,start:part.start+a-from,end:part.start+b-from}]:[];
 });
 const markers=[],stack=[],pairs={'“':'”','‘':'’','「':'」','『':'』','"':'"',"'":"'",'【':'】','[':']'};
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==='\\'){i++;continue;}
  if((c==="'"||c==='’')&&/[A-Za-z0-9]/.test(text[i-1]??'')&&/[A-Za-z0-9]/.test(text[i+1]??''))continue;
  if(stack.at(-1)===c){stack.pop();continue;}
  if(c==="'"&&!stack.includes("'")&&/[sS]/.test(text[i-1]??'')&&/\s/.test(text[i+1]??''))continue;
  if(pairs[c]){stack.push(pairs[c]);continue;}
  if(stack.length||!/[（(]/u.test(c))continue;
  // Balance the whole group first: do not discover inner cues inside an uncertain outer group.
  const brackets=[c==='（'?'）':')'];let end=i+1;
  for(;end<text.length&&brackets.length;end++){
   if(/[（(]/u.test(text[end]))brackets.push(text[end]==='（'?'）':')');
   else if(/[）)]/u.test(text[end])){if(brackets.at(-1)!==text[end])break;brackets.pop();}
  }
  if(brackets.length){i=text.length;continue;}
  const value=text.slice(i+1,end-1),markerParts=slice(i,end);
  const contiguous=markerParts.every((p,j)=>!j||markerParts[j-1].end===p.start);
  if(contiguous&&clearCue(value)&&!literalMention(text,i,end))markers.push({start:i,end,value,markerParts});
  i=end-1;
 }
 if(!markers.length)return null;
 const spokenParts=[],cues=[];let cursor=0,spokenOffset=0;
 for(const marker of markers){
  spokenParts.push(...slice(cursor,marker.start));spokenOffset+=marker.start-cursor;
  const start=marker.start+1+marker.value.length-marker.value.trimStart().length,end=marker.end-1-(marker.value.length-marker.value.trimEnd().length);
  cues.push({text:marker.value.trim(),parts:slice(start,end),markerParts:marker.markerParts,spokenOffset});cursor=marker.end;
 }
 spokenParts.push(...slice(cursor,text.length));
 const spoken=spokenParts.map(p=>source.slice(p.start,p.end)).join('');
 if(!spoken.trim())return null;
 return {version:INLINE_PERFORMANCE_VERSION,spoken:{text:spoken,parts:spokenParts},cues};
}
