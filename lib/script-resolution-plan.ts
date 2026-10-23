import {compileStandardScript, createSourceIndex, StandardScriptError, standardScriptPlanVersion} from './standard-script';
import type {Channel, SourceIndex, SourcePart, StandardScriptEntry} from './standard-script';
import {prepareStandardEpisode, type PreparedStandardEpisode} from './standard-script-plan';
import {compileSourceRegroup,SOURCE_REGROUP_VERSION,type SourceRegroupApproval,type SourceRegroupChild} from '../runtime/source-regroup.mjs';

export const RESOLUTION_TYPES=['ACTION','DIALOGUE','CONTINUITY','EMOTION_CLUE','RELATIONSHIP_CONTEXT','KNOWLEDGE_REVEAL','SPACE_CONSTRAINT','CREATIVE_GUIDANCE'] as const;
export type ResolutionType=typeof RESOLUTION_TYPES[number];
export type WholeLineResolutionChoice={id?:string;startLine:number;endLine:number;type:ResolutionType;speaker?:string;channel?:Channel};
export type SourceRegroupChoice={id?:string;startLine:number;endLine:number;type:'SOURCE_REGROUP';version:typeof SOURCE_REGROUP_VERSION;children:SourceRegroupChild[];layout:SourcePart[];speaker?:never;channel?:never};
export type ScriptResolutionChoice=WholeLineResolutionChoice|SourceRegroupChoice;
export function resolutionError(code:string,message:string,status=409):never{throw Object.assign(new Error(message),{code,status});}
export function readResolutionChoice(value:unknown):ScriptResolutionChoice{
 if(!value||typeof value!=='object'||Array.isArray(value))resolutionError('CHOICE','请选择核对类型。',400);
 const choice=value as ScriptResolutionChoice;
 const regroup=choice.type==='SOURCE_REGROUP';
 if(Object.keys(choice).some(key=>!(regroup?['id','startLine','endLine','type','version','children','layout']:['id','startLine','endLine','type','speaker','channel']).includes(key)))resolutionError('CHOICE_FIELDS','解析决定含未知字段；不能提交改写正文或批准身份。',400);
 if(!Number.isSafeInteger(choice.startLine)||!Number.isSafeInteger(choice.endLine)||choice.startLine<1||choice.endLine<choice.startLine||choice.endLine-choice.startLine>100)resolutionError('RANGE','请选择1至101行的有效连续范围。',400);
 if(!regroup&&!RESOLUTION_TYPES.includes(choice.type))resolutionError('CHOICE_TYPE','不支持的核对类型；正文不能标为空白或删除。',400);
 if(choice.id!==undefined&&(typeof choice.id!=='string'||!choice.id||choice.id.length>100))resolutionError('CHOICE_ID','核对记录标识无效。',400);
 if(regroup){
  if(choice.version!==SOURCE_REGROUP_VERSION||!Array.isArray(choice.children)||choice.children.length<2||!Array.isArray(choice.layout))resolutionError('SOURCE_REGROUP_CHOICE','请选择独立对白和动作原片段。',400);
  return structuredClone(choice);
 }
 if(choice.type==='DIALOGUE'){
  if(typeof choice.speaker!=='string'||!choice.speaker.trim()||choice.speaker!==choice.speaker.trim()||choice.speaker.length>80)resolutionError('SPEAKER','请选择原文头中已有的说者。',400);
  if(!['SPEECH','OS','VO','NARRATION','SYSTEM'].includes(choice.channel??''))resolutionError('CHANNEL','请选择明确声道。',400);
 }else if(choice.speaker!==undefined||choice.channel!==undefined)resolutionError('CHOICE_FIELDS','动作或辅助资料不能附带对白说者。',400);
 return {...choice};
}
function parts(index:SourceIndex,start:number,end:number):SourcePart[]{
 return index.units.flatMap(unit=>{const a=Math.max(start,unit.start),b=Math.min(end,unit.end);return a<b?[{kind:/^[\t \r\n]+$/.test(index.text.slice(a,b))?'SOURCE_SEPARATOR' as const:'SOURCE_SLICE' as const,unitId:unit.id,start:a,end:b}]:[];});
}
function localEntry(text:string,choice:WholeLineResolutionChoice,knownSpeakers:string[]):{index:SourceIndex;entry:StandardScriptEntry}{
 const index=createSourceIndex(text,'selected-source'),start=/^[\s\uFEFF]*/.exec(text)![0].length,end=text.length-/[\t \r\n]*$/.exec(text)![0].length;
 if(start>=end)resolutionError('EMPTY_RANGE','所选范围没有可核对正文。');
 // Detection only: source header labels are not promoted to known character identities.
 const labels=[...text.matchAll(/(?:^|[\r\n])\s*([\p{L}\p{N}· _.-]+)(?:[（(][^）)\r\n]*[）)])?\s*[:：]/gu)].map(match=>match[1].trim());
 const detection=prepareStandardEpisode(text,'selected-source',{knownSpeakers:[...knownSpeakers,...labels]});
 if(detection.plan.entries.some(entry=>entry.target==='BODY'&&entry.kind==='BODY_GROUP')||detection.diagnostics.some(d=>d.code==='MIXED_DIALOGUE_ONSCREEN_TEXT'))resolutionError('UNSUPPORTED_MIXED_BODY','明确字幕与对白必须分别保留；不支持的混合边界仍阻断，不能用单类型决定绕过。');
 if(detection.plan.entries.some(entry=>entry.target==='BODY'&&entry.kind==='DIALOGUE_GROUP')||detection.diagnostics.some(d=>d.code==='MULTIPLE_SPEAKERS_ON_LINE'))resolutionError('UNSUPPORTED_MULTIPLE_SPEAKERS','同一物理行含多个说者；明确对白组必须保留，未知边界仍待核对，不能改成动作或辅助资料绕过。');
 let bodyStart=start,fields:SourcePart[][]=[],dialogue:Extract<StandardScriptEntry,{kind:'DIALOGUE'}>|undefined;
 if(choice.type==='DIALOGUE'){
  const parsed=prepareStandardEpisode(text,'selected-source',{knownSpeakers:[...knownSpeakers,choice.speaker!]});
  const first=parsed.plan.entries[0];
  if(!first||first.target!=='BODY'||first.kind!=='DIALOGUE'||first.unitIds[0]!==index.units[0].id||first.speaker.map(p=>text.slice(p.start,p.end)).join('')!==choice.speaker)resolutionError('SPEAKER_SOURCE','所选第一行必须含原文明示的说者头；缺说者或不受支持的头格式不能补造。');
  if(parsed.plan.entries.slice(1).some(entry=>entry.target==='STRUCTURE'||entry.target==='ANNOTATION'||entry.target==='BODY'&&['DIALOGUE','DIALOGUE_GROUP','BODY_GROUP'].includes(entry.kind))||text.split(/\r\n|\r|\n/).slice(1).some(line=>/^\s*[△▲]/.test(line))||parsed.diagnostics.some(d=>!['AMBIGUOUS_CONTINUATION'].includes(d.code)))resolutionError('DIALOGUE_RANGE','对白范围不能跨过其他明确说者、动作标记、结构或仍未识别的说者头。');
  if((first.channelSource?.length||first.channel!=='SPEECH')&&first.channel!==choice.channel)resolutionError('CHANNEL_SOURCE','声道与原文明示标记或保留音轨角色不符，不能静默改写。');
  dialogue=first;bodyStart=first.parts[0].start;fields=[first.speaker,...(first.cue?[first.cue]:[]),...(first.channelSource?[first.channelSource]:[])];
 }else if(choice.type==='ACTION')bodyStart+=/^[△▲][\t ]*/.exec(text.slice(start))?.[0].length??0;
 if(bodyStart>=end)resolutionError('EMPTY_BODY','所选范围没有可保留的正文。');
 const ranges=[...fields.map(field=>({start:field[0].start,end:field.at(-1)!.end})),{start:bodyStart,end}].sort((a,b)=>a.start-b.start),layout:SourcePart[]=[];
 let cursor=0;for(const range of ranges){if(cursor<range.start)layout.push(...parts(index,cursor,range.start));cursor=range.end;}if(cursor<text.length)layout.push(...parts(index,cursor,text.length));
 const base={id:choice.id??`resolved-${choice.startLine}-${choice.endLine}`,unitIds:index.units.map(unit=>unit.id),parts:parts(index,bodyStart,end),layout};
 const entry:StandardScriptEntry=dialogue?{...base,target:'BODY',kind:'DIALOGUE',speaker:dialogue.speaker,channel:choice.channel!,cue:dialogue.cue??null,channelSource:dialogue.channelSource??null}:choice.type==='ACTION'?{...base,target:'BODY',kind:'ACTION'}:{...base,target:'ANNOTATION',kind:choice.type as Exclude<ResolutionType,'ACTION'|'DIALOGUE'>};
 try{compileStandardScript(index,{schemaVersion:standardScriptPlanVersion(index,[entry]),sourceId:index.sourceId,sourceVersion:index.sourceVersion,entries:[entry]});}
 catch(error){if(!(error instanceof StandardScriptError))throw error;resolutionError('UNSUPPORTED_LAYOUT',`该范围暂不能保真编译（${error.code}）；原句仍保留，未把正文放进排版字段。`);}
 return {index,entry};
}

/** A user decision changes interpretation only; every character still comes from its original source range. */
export function applyScriptResolutions(text:string,sourceId:string,decisions:ScriptResolutionChoice[],knownSpeakers:string[]=[],options:{approvals?:Record<string,SourceRegroupApproval>}={}):PreparedStandardEpisode{
 const prepared=prepareStandardEpisode(text,sourceId,{knownSpeakers});
 if(!decisions.length)return prepared;
 const choices=decisions.map(readResolutionChoice).sort((a,b)=>a.startLine-b.startLine),{index}=prepared;
 const speakerDecisions:NonNullable<PreparedStandardEpisode['speakerDecisions']>={version:'script-speaker-decisions-v1',sourceVersion:index.sourceVersion,entries:[]};
 let entries=[...prepared.plan.entries];
 for(const [position,choice] of choices.entries()){
  if(choice.endLine>index.units.length||position>0&&choices[position-1].endLine>=choice.startLine)resolutionError('RANGE_OVERLAP','核对范围越界或与另一项重叠；请修改已有核对项。');
  const selected=index.units.slice(choice.startLine-1,choice.endLine),ids=new Set(selected.map(unit=>unit.id));
  if(entries.some(entry=>entry.unitIds.some(id=>ids.has(id))&&!entry.unitIds.every(id=>ids.has(id))))resolutionError('PARTIAL_ENTRY','所选范围切开了已识别的完整对白或资料；请包含该段完整行范围。');
  if(choice.type==='SOURCE_REGROUP'){
   const id=choice.id??`resolved-${choice.startLine}-${choice.endLine}`,approval=options.approvals?.[id];
   if(!approval)resolutionError('SOURCE_REGROUP_APPROVAL','来源重组须经明确批准，由服务端记录批准来源与身份。');
   const entry:StandardScriptEntry={id,target:'BODY',kind:'SOURCE_REGROUP',sourceRegroupVersion:choice.version,unitIds:selected.map(unit=>unit.id),parts:parts(index,selected[0].start,selected.at(-1)!.end),layout:structuredClone(choice.layout),children:structuredClone(choice.children),approval:structuredClone(approval)};
   compileSourceRegroup(index,entry);entries=[...entries.filter(entry=>!entry.unitIds.some(id=>ids.has(id))),entry];continue;
  }
  const local=localEntry(selected.map(unit=>unit.text).join(''),choice,knownSpeakers),offset=selected[0].start;
  const shift=(part:SourcePart):SourcePart=>({...part,unitId:selected[local.index.units.findIndex(unit=>unit.id===part.unitId)].id,start:part.start+offset,end:part.end+offset});
  const original=local.entry,entry:StandardScriptEntry=original.target==='EXCLUDE'?original:{...original,unitIds:selected.map(unit=>unit.id),parts:original.parts.map(shift),layout:original.layout.map(shift),...(original.target==='BODY'&&original.kind==='DIALOGUE'?{speaker:original.speaker.map(shift),cue:original.cue?.map(shift)??null,channelSource:original.channelSource?.map(shift)??null}:{})};
  if(choice.type==='DIALOGUE'&&entry.target==='BODY'&&entry.kind==='DIALOGUE')speakerDecisions.entries.push({entryId:entry.id,speaker:structuredClone(entry.speaker),channel:entry.channel});
  entries=[...entries.filter(entry=>!entry.unitIds.some(id=>ids.has(id))),entry];
 }
 entries.sort((a,b)=>index.units.findIndex(unit=>unit.id===a.unitIds[0])-index.units.findIndex(unit=>unit.id===b.unitIds[0]));
 const plan={...prepared.plan,schemaVersion:standardScriptPlanVersion(index,entries),entries},diagnostics=prepared.diagnostics.filter(d=>!choices.some(choice=>d.line>=choice.startLine&&d.line<=choice.endLine));
 let compiled:PreparedStandardEpisode['compiled']=null;
 if(!diagnostics.length){
  try{compiled=compileStandardScript(index,plan);}catch(error){if(!(error instanceof StandardScriptError))throw error;resolutionError('COMPILE',`核对方案未通过全原文覆盖检查（${error.code}），未保存。`);}
 }
 return {index,plan,compiled,diagnostics,...(speakerDecisions.entries.length?{speakerDecisions}:{})};
}
