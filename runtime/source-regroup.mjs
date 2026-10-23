import {inlinePerformanceProjection,sourceSplitCueRanges,sourceUtteranceProperty} from './inline-performance.mjs';

export const SOURCE_REGROUP_VERSION='source-regroup-v1';
const reject=(code,path)=>{throw Object.assign(new Error(`SOURCE_REGROUP_${code}: ${path}`),{code:`SOURCE_REGROUP_${code}`,fieldPath:path});};
const record=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const shape=(value,keys,required,path)=>{if(!record(value)||Object.keys(value).some(key=>!keys.includes(key))||required.some(key=>!Object.hasOwn(value,key)))reject('SHAPE',path);};
const splitPair=(text,at)=>at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1])&&/[\uDC00-\uDFFF]/.test(text[at]);
const structure=text=>/^\s*(?:(?:#{1,6}\s*)?(?:第\s*[0-9０-９零〇一二两三四五六七八九十百千]+\s*集|(?:episode|ep\.?)[ \t]+\S+)(?:\s|[:：]|$)|(?:场\s*)?[0-9０-９]+\s*[-—–－.．]\s*[0-9０-９]+(?:\s|[:：]|$)|(?:人物|角色|出场人物|场景|地点|时间层|时间|天气|内外|道具|集名)\s*[:：]|\[.*\]|【.*】)/iu.test(text)
 ||/^\s*(?:日|夜|晨|午|黄昏|内|外)[ \t]+(?:内|外|日|夜|晨|午|黄昏)[ \t]+\S/u.test(text);

/** Browser selections and both receivers use the same original UTF16 coordinates. */
export function selectSourceRegroupParts(index,start,end){
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=end||end>index.text.length||splitPair(index.text,start)||splitPair(index.text,end))reject('RANGE','selection');
 return index.units.flatMap(unit=>{const a=Math.max(start,unit.start),b=Math.min(end,unit.end);return a<b?[{kind:/^[\t \r\n]+$/.test(index.text.slice(a,b))?'SOURCE_SEPARATOR':'SOURCE_SLICE',unitId:unit.id,start:a,end:b}]:[];});
}
/** A textarea contains one physical line without its EOL, so DOM newline normalization cannot move offsets. */
export function selectSourceRegroupLineParts(index,unitId,start,end){
 const unit=index.units.find(unit=>unit.id===unitId),display=unit?.text.replace(/(?:\r\n|\r|\n)$/u,'');
 if(!unit||!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||start>=end||end>display.length)reject('RANGE','lineSelection');
 return selectSourceRegroupParts(index,unit.start+start,unit.start+end);
}
function dialogueText(text,speaker,cue){
 const stack=[],pairs={'“':'”','‘':'’','「':'」','『':'』','"':'"',"'":"'",'【':'】','[':']'};
 for(let i=0;i<text.length;i++){
  const c=text[i];if(c==='\\'){i++;continue;}
  if((c==="'"||c==='’')&&/[A-Za-z0-9]/.test(text[i-1]??'')&&/[A-Za-z0-9]/.test(text[i+1]??''))continue;
  if(stack.at(-1)===c){stack.pop();continue;}if(pairs[c]){stack.push(pairs[c]);continue;}
  if(/[”’」』]/u.test(c))reject('DIALOGUE','orphan closing quotation');
  if(!stack.length&&/[△▲]/u.test(c))reject('DIALOGUE','body contains an action marker');
  if(!stack.length&&/[:：]/u.test(c)){
   const label=/(?:^|[。.!！？?;；,， \t\r\n])([^。.!！？?;；,，:：()（） \t\r\n]+(?:[（(][^()（）]*[）)])?)[ \t]*$/u.exec(text.slice(0,i))?.[1]?.trim();
   if(label&&!sourceUtteranceProperty(speaker,label,cue)&&!/^(?:时间层|时间|地点|场景|天气|内外|道具)$/u.test(label)&&!(/[说问道答喊叫]$/u.test(label)&&/^[“‘「『"']/u.test(text.slice(i+1).trimStart())))reject('DIALOGUE','nested source header');
  }
 }
 if(stack.length)reject('DIALOGUE','unclosed quotation');
}
function sourceBoundaries(text,start,end,children){
 const stack=[],pairs={'“':'”','‘':'’','「':'」','『':'』','"':'"',"'":"'",'【':'】','[':']'};
 for(let i=start;i<end;i++){
  const c=text[i];if(c==='\\'){i++;continue;}
  if((c==="'"||c==='’')&&/[A-Za-z0-9]/.test(text[i-1]??'')&&/[A-Za-z0-9]/.test(text[i+1]??''))continue;
  if(stack.at(-1)===c){stack.pop();continue;}
  if(!stack.length){
   if(/^[【\[]?(?:字幕|弹幕|屏幕字幕|屏幕文字|SUBTITLE)[ \t]*[:：]/iu.test(text.slice(i,end)))reject('CAPTION','explicit onscreen source needs its original typed protocol');
   if(i===start||/[。.!！？?;；,，… \t\r\n△▲”’」』"']/u.test(text[i-1])){
    const head=/^[\t \uFEFF]*([\p{L}\p{N}·・ _.-]+?)(?:[（(][^()（）\r\n]*[）)])?[\t ]*[:：]/u.exec(text.slice(i,end));
    if(head){
     const at=i+head[0].indexOf(head[1]),label=head[1].trim(),owner=children.find(child=>child.kind==='DIALOGUE'&&child.textAssembly.parts.some(part=>at>=part.start&&at<part.end));
     const speaker=children.some(child=>child.kind==='DIALOGUE'&&at>=child.speaker.parts[0].start&&at<child.speaker.parts.at(-1).end);
     if(!speaker&&!sourceUtteranceProperty(owner?.speaker.text??'',label,owner?.cue?.text??'')&&!/^(?:时间层|时间|地点|场景|天气|内外|道具)$/u.test(label)&&!(/[说问道答喊叫]$/u.test(label)&&/^[“‘「『"']/u.test(text.slice(i+head[0].length,end).trimStart())))reject('HEAD','an explicit original speaker needs its own dialogue child');
    }
   }
  }
  if(pairs[c])stack.push(pairs[c]);else if(/[”’」』]/u.test(c))reject('DIALOGUE','orphan closing source quotation');
 }
 if(stack.length)reject('DIALOGUE','unclosed source quotation');
}
/** Mechanical source proof only. The authenticated service owns approval authority. */
export function compileSourceRegroup(index,entry,path='sourceRegroup'){
 shape(entry,['id','target','kind','unitIds','parts','layout','children','sourceRegroupVersion','approval'],['id','target','kind','unitIds','parts','layout','children','sourceRegroupVersion','approval'],path);
 if(entry.target!=='BODY'||entry.kind!=='SOURCE_REGROUP'||entry.sourceRegroupVersion!==SOURCE_REGROUP_VERSION||typeof entry.id!=='string'||!entry.id)reject('VERSION',path);
 shape(entry.approval,['origin','ref','explanation','actorId','approvedAt'],['origin','ref','explanation','actorId','approvedAt'],`${path}.approval`);
 if(!['SESSION','AUTHORIZED_MAINTENANCE'].includes(entry.approval.origin)||['ref','explanation','actorId'].some(key=>typeof entry.approval[key]!=='string'||!entry.approval[key].trim())||typeof entry.approval.approvedAt!=='string'||!Number.isFinite(Date.parse(entry.approval.approvedAt)))reject('APPROVAL',path);
 if(!Array.isArray(entry.unitIds)||!entry.unitIds.length||new Set(entry.unitIds).size!==entry.unitIds.length)reject('OWNERSHIP',path);
 const byId=new Map(index.units.map(unit=>[unit.id,unit])),selected=entry.unitIds.map(id=>byId.get(id));
 if(selected.some((unit,i)=>!unit||index.text.slice(unit.start,unit.end)!==unit.text||i&&selected[i-1].end!==unit.start))reject('OWNERSHIP',path);
 if(selected.some(unit=>structure(unit.text)))reject('STRUCTURE',path);
 const start=selected[0].start,end=selected.at(-1).end,consumed=[],headerRanges=[];
 function copy(raw,field,{empty=false,gaps=true,sink=consumed}={}){
  if(!Array.isArray(raw)||!empty&&!raw.length)reject('PARTS',`${path}.${field}`);
  let edge=-1;
  const parts=raw.map((part,i)=>{
   shape(part,['kind','unitId','start','end'],['kind','unitId','start','end'],`${path}.${field}[${i}]`);
   const unit=byId.get(part.unitId);
   if(!unit||!entry.unitIds.includes(part.unitId)||!['SOURCE_SLICE','SOURCE_SEPARATOR'].includes(part.kind)||!Number.isSafeInteger(part.start)||!Number.isSafeInteger(part.end)||part.start<unit.start||part.end>unit.end||part.start>=part.end||part.start<edge||!gaps&&edge>=0&&part.start!==edge)reject('RANGE',`${path}.${field}`);
   if(splitPair(index.text,part.start)||splitPair(index.text,part.end))reject('UNICODE',`${path}.${field}`);
   if(part.kind==='SOURCE_SEPARATOR'&&!/^[\t \r\n]+$/.test(index.text.slice(part.start,part.end)))reject('SEPARATOR',`${path}.${field}`);
   edge=part.end;sink.push({start:part.start,end:part.end,unitId:part.unitId,field});return {...part};
  });
  return {text:parts.map(part=>index.text.slice(part.start,part.end)).join(''),parts};
 }
 const parent=copy(entry.parts,'parts',{gaps:false,sink:[]});
 if(parent.parts[0].start!==start||parent.parts.at(-1).end!==end)reject('OWNERSHIP',path);
 if(!Array.isArray(entry.children)||entry.children.length<2||!entry.children.some(child=>child?.kind==='DIALOGUE')||!entry.children.some(child=>child?.kind==='ACTION'))reject('CHILDREN',path);
 const childIds=new Set();let childAnchor=-1;
 const children=entry.children.map((child,i)=>{
  const field=`children[${i}]`,dialogue=child?.kind==='DIALOGUE',keys=dialogue?['id','kind','parts','layout','speaker','channel','cue','channelSource']:['id','kind','parts','layout'];
  shape(child,keys,dialogue?['id','kind','parts','layout','speaker','channel']:keys,`${path}.${field}`);
  if(!['ACTION','DIALOGUE'].includes(child.kind)||typeof child.id!=='string'||!child.id||childIds.has(child.id))reject('CHILDREN',`${path}.${field}`);childIds.add(child.id);
  const body=copy(child.parts,`${field}.body`),layout=copy(child.layout,`${field}.layout`,{empty:true});
  if(!body.text.trim())reject('EMPTY',`${path}.${field}`);
  const anchor=Math.min(body.parts[0].start,dialogue?child.speaker?.[0]?.start??Number.POSITIVE_INFINITY:Number.POSITIVE_INFINITY);
  if(anchor<=childAnchor)reject('ORDER',`${path}.${field}`);childAnchor=anchor;
  const output={id:child.id,kind:child.kind,text:body.text,textAssembly:{parts:body.parts},layout:layout.parts};
  if(!dialogue)return output;
  const speaker=copy(child.speaker,`${field}.speaker`,{gaps:false}),cue=child.cue==null?null:copy(child.cue,`${field}.cue`),channelSource=child.channelSource==null?null:copy(child.channelSource,`${field}.channelSource`,{gaps:false});
  const from=speaker.parts[0].start,to=body.parts[0].start,head=/^([\p{L}\p{N}·・ _.-]+?)(?:（([^()（）\r\n]*)）|\(([^()（）\r\n]*)\))?[\t ]*[:：][\t ]*(?:（([^()（）\r\n]*)）|\(([^()（）\r\n]*)\))?[\t ]*$/du.exec(index.text.slice(from,to));
  if(!head||speaker.text!==head[1].trim()||speaker.parts.at(-1).end!==from+head[1].trimEnd().length||!speaker.text.trim()||/^\d+$/u.test(speaker.text))reject('SPEAKER',`${path}.${field}`);
  const tokens=[2,3,4,5].flatMap(slot=>head[slot]===undefined?[]:[...head[slot].matchAll(/[^,， \t]+/g)].map(token=>({slot,text:token[0],start:from+head.indices[slot][0]+token.index,end:from+head.indices[slot][0]+token.index+token[0].length})));
  const channels=tokens.filter(token=>/^(OS|VO)$/iu.test(token.text)),cues=tokens.filter(token=>!channels.includes(token));
  if(channels.length>1||new Set(cues.map(token=>token.slot)).size>1||cues.some(token=>/\b(?:OS|VO)\b|O\.S\.?|V\.O\.?|旁白|画外音|内心独白|系统音|[:：△▲“”「」]/iu.test(token.text)))reject('CHANNEL',`${path}.${field}`);
  const expected=channels[0]?.text.toUpperCase()??({旁白:'NARRATION',画外音:'VO',系统音:'SYSTEM'})[speaker.text]??'SPEECH';
  const exact=(field,ranges)=>ranges.length?Boolean(field&&field.parts.length===ranges.length&&field.parts.every((part,j)=>part.start===ranges[j].start&&part.end===ranges[j].end)):field===null;
  const cueRanges=channels.length&&sourceSplitCueRanges(index.text,channels[0])||(cues.length?[{start:cues[0].start,end:cues.at(-1).end}]:[]);
  if(child.channel!==expected||!exact(channelSource,channels)||!exact(cue,cueRanges))reject('CHANNEL',`${path}.${field}`);
  headerRanges.push({start:from,end:to});dialogueText(body.text,speaker.text,cue?.text??'');
  const performance=inlinePerformanceProjection(index.text,body.parts,'inline-performance-v2');
  return {...output,speaker,channel:child.channel,cue,channelSource,...(performance?{performance}:{})};
 });
 sourceBoundaries(index.text,start,end,children);
 const layout=copy(entry.layout,'layout',{empty:true});
 for(const part of consumed.filter(part=>part.field.endsWith('.layout')||part.field==='layout')){
  const raw=index.text.slice(part.start,part.end),unit=byId.get(part.unitId),header=headerRanges.some(range=>part.start>=range.start&&part.end<=range.end);
  if(header?!/^[\s:：()（）,，]+$/u.test(raw):!/^\s+$/u.test(raw)||!(/^[\t \r\n]*$/u.test(index.text.slice(unit.start,part.end))||/^[\t \r\n]*$/u.test(index.text.slice(part.start,unit.end))))reject('LAYOUT',`${path}.${part.field}`);
 }
 consumed.sort((a,b)=>a.start-b.start);let edge=start;
 for(const span of consumed){if(span.start!==edge)reject('COVERAGE',`${path}.${span.field}`);edge=span.end;}
 if(edge!==end)reject('COVERAGE',path);
 return {id:entry.id,target:'BODY',kind:'SOURCE_REGROUP',sourceUnitIds:[...entry.unitIds],text:parent.text,textAssembly:{parts:parent.parts},layout:layout.parts,children,sourceRegroupVersion:SOURCE_REGROUP_VERSION,approval:{...entry.approval}};
}
/** Rebuild a plan from a delivered package, then rerun the same source validator. */
export function sourceRegroupPlanFromCompiled(entry){
 shape(entry,['id','target','kind','sourceUnitIds','text','textAssembly','layout','children','sourceRegroupVersion','approval'],['id','target','kind','sourceUnitIds','text','textAssembly','layout','children','sourceRegroupVersion','approval'],'compiledRegroup');
 shape(entry.textAssembly,['parts'],['parts'],'compiledRegroup.textAssembly');
 if(!Array.isArray(entry.children))reject('CHILDREN','compiledRegroup');
 const children=entry.children.map(child=>{
  const dialogue=child?.kind==='DIALOGUE',keys=['id','kind','text','textAssembly','layout',...(dialogue?['speaker','channel','cue','channelSource','performance']:[])];
  shape(child,keys,keys.filter(key=>!['performance','cue','channelSource'].includes(key)),'compiledRegroup.child');shape(child.textAssembly,['parts'],['parts'],'compiledRegroup.child.textAssembly');
  for(const name of dialogue?['speaker','cue','channelSource']:[])if(child[name]!=null)shape(child[name],['text','parts'],['text','parts'],`compiledRegroup.child.${name}`);
  return {id:child.id,kind:child.kind,parts:structuredClone(child.textAssembly.parts),layout:structuredClone(child.layout),...(dialogue?{speaker:structuredClone(child.speaker.parts),channel:child.channel,cue:child.cue==null?null:structuredClone(child.cue.parts),channelSource:child.channelSource==null?null:structuredClone(child.channelSource.parts)}:{})};
 });
 return {id:entry.id,target:entry.target,kind:entry.kind,unitIds:[...entry.sourceUnitIds],parts:structuredClone(entry.textAssembly.parts),layout:structuredClone(entry.layout),children,sourceRegroupVersion:entry.sourceRegroupVersion,approval:structuredClone(entry.approval)};
}
