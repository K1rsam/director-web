'use client';
import {useEffect,useMemo,useState} from 'react';
import type {ScriptReceptionView} from '@/lib/script-resolution-service';
import type {ScriptResolutionChoice} from '@/lib/script-resolution-plan';
import type {SourcePart,Channel} from '@/lib/standard-script';
import type {SourceInterpretationRequest} from '@/lib/source-interpretation-adoption';
import {selectSourceRegroupLineParts,selectSourceRegroupParts} from '../../../runtime/source-regroup.mjs';

type Field='speaker'|'dialogue'|'action'|'cue'|'channelSource';
const empty=():Record<Field,SourcePart[]>=>({speaker:[],dialogue:[],action:[],cue:[],channelSource:[]});
const labels:Record<Field,string>={speaker:'说者',dialogue:'台词',action:'动作',cue:'原表演提示',channelSource:'原声道标记'};
type Preview={previewDigest:string;approval:{origin:string;ref:string;explanation:string};before:{catalogCoverage:number[];editorialCoverage:number[]};after:{effectiveEditorialCoverage:number[];reviewedEpisodes:number[]};episodes:{episode:number;action:string;sourceText:string;beforeReadingText:string|null;afterReadingText:string|null;diagnostics:{message:string}[]}[]};
export function SourceRegroupPanel({projectId,selected,canConfirm,onAdopt,className}:{projectId:string;selected:NonNullable<ScriptReceptionView['selected']>;canConfirm:boolean;onAdopt:(view:ScriptReceptionView)=>void;className?:string}){
 const [startLine,setStart]=useState(selected.diagnostics[0]?.line??1),[endLine,setEnd]=useState(selected.diagnostics[0]?.line??1),[fields,setFields]=useState(empty),[selection,setSelection]=useState<{unitId:string;start:number;end:number}|null>(null);
 const [mode,setMode]=useState<'SOURCE_REGROUP'|'DIALOGUE'>('SOURCE_REGROUP'),[channel,setChannel]=useState<Channel>('SPEECH'),[batch,setBatch]=useState<SourceInterpretationRequest['changes']>([]),[baseRevision,setBase]=useState(''),[explanation,setExplanation]=useState(''),[preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const index=useMemo(()=>{let edge=0;return {text:selected.sourceText,units:selected.lines.map(line=>{const start=edge;edge+=line.text.length;return {id:line.unitId,text:line.text,start,end:edge};})};},[selected.sourceText,selected.lines]);
 useEffect(()=>{setFields(empty());setSelection(null);setStart(selected.diagnostics[0]?.line??1);setEnd(selected.diagnostics[0]?.line??1);setPreview(null);},[selected.number,selected.sourceVersion,selected.revision]);
 const copy=(parts:SourcePart[])=>parts.map(part=>selected.sourceText.slice(part.start,part.end)).join('');
 const disabled=busy||!canConfirm;
 function add(field:Field){try{
  if(!selection)throw new Error('先在一行原文中选中片段，再加入对应字段。');
  const pieces=selectSourceRegroupLineParts(index,selection.unitId,selection.start,selection.end),next=[...fields[field],...pieces].sort((a,b)=>a.start-b.start);
  if(next.some((part,i)=>i>0&&part.start<next[i-1].end))throw new Error('同一字段不能重复选取片段。');
  setFields({...fields,[field]:next});setPreview(null);setError('');
 }catch(cause){setError(cause instanceof Error?cause.message:'选段无效。');}}
 function stage(choice?:ScriptResolutionChoice,decisionId?:string){
  if(!selected.documentRevision){setError('当前没有可保留的已付目录工作稿。');return;}
  if(baseRevision&&baseRevision!==selected.documentRevision){setError('工作稿已变化，请清空本批后重新选段。');return;}
  setBase(selected.documentRevision);setBatch([...batch.filter(item=>item.episode!==selected.number),{episode:selected.number,sourceVersion:selected.sourceVersion,expectedRevision:selected.revision,...(choice?{choice}:{decisionId})}]);setPreview(null);setError('');
 }
 function stageFields(){try{
  if(!Number.isSafeInteger(startLine)||!Number.isSafeInteger(endLine)||startLine<1||endLine<startLine||endLine>index.units.length)throw new Error('请选择实际原文行范围。');
  if(!fields.speaker.length)throw new Error('请从原文选择明示说者。');
  if(mode==='DIALOGUE'){stage({type:'DIALOGUE',startLine,endLine,speaker:copy(fields.speaker),channel});return;}
  if(!fields.dialogue.length||!fields.action.length)throw new Error('请分别选择完整台词和动作；可跨行多次加入同一字段。');
  const from=index.units[startLine-1].start,to=index.units[endLine-1].end,used=Object.values(fields).flat().sort((a,b)=>a.start-b.start),layout:SourcePart[]=[];let edge=from;
  for(const part of used){if(part.start<edge||part.start<from||part.end>to)throw new Error('字段有重叠或超出本次原文范围，请移除后重新选择。');if(edge<part.start)layout.push(...selectSourceRegroupParts(index,edge,part.start));edge=part.end;}
  if(edge<to)layout.push(...selectSourceRegroupParts(index,edge,to));
  stage({type:'SOURCE_REGROUP',version:'source-regroup-v1',startLine,endLine,layout,children:[{id:'dialogue-1',kind:'DIALOGUE',parts:fields.dialogue,layout:[],speaker:fields.speaker,channel,cue:fields.cue.length?fields.cue:null,channelSource:fields.channelSource.length?fields.channelSource:null},{id:'action-1',kind:'ACTION',parts:fields.action,layout:[]}]});
 }catch(cause){setError(cause instanceof Error?cause.message:'选段尚未完整。');}}
 async function send(adopt=false){setBusy(true);setError('');try{
  const body={expectedDocumentRevision:baseRevision,explanation,changes:batch,...(adopt?{previewDigest:preview?.previewDigest}:{})};
  const response=await fetch(`/projects/${encodeURIComponent(projectId)}/script-reception`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:adopt?'adopt-source':'preview-source',...body})}),result=await response.json();
  if(!response.ok)throw new Error(result.error??'本次操作未完成。');
  if(adopt){setBatch([]);setBase('');setPreview(null);onAdopt(result.reception);}else setPreview(result);
 }catch(cause){setError(cause instanceof Error?cause.message:'结果未知；请刷新核对已保存记录，没有自动重试。');}finally{setBusy(false);}}
 return <details className={className} open={selected.diagnostics.length>0}>
  <summary>原文选段与免费解释复核</summary>
  <p>在每一行原文中选段，再分别加入说者、台词或动作。可多次加入同一字段；原件、读取文本、旧解释与已付目录均保留。</p>
  <p>批准来源由服务端记录：网页明确采用记为 SESSION，授权维护记为 AUTHORIZED_MAINTENANCE 并保留原批准引用；客户端不能填写身份或通过状态。预览与采用均为零模型。</p>
  <p>当前已付目录范围：{selected.paidCatalogCoverage?.join('、')||'无'}。原 Q1 与免费来源复核分别记录；来源、目录、条件或解释变化及撤销会使相应免费证据失效。</p>
  <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><label>操作<select disabled={disabled} value={mode} onChange={event=>{setMode(event.target.value as typeof mode);setPreview(null);}}><option value="SOURCE_REGROUP">分开交错对白与动作</option><option value="DIALOGUE">整行明示说者核对</option></select></label><label>开始行<input aria-label="重组开始行" type="number" min={1} max={index.units.length} value={startLine} disabled={disabled} onChange={event=>{setStart(Number(event.target.value));setFields(empty());setPreview(null);}}/></label><label>结束行<input aria-label="重组结束行" type="number" min={startLine} max={index.units.length} value={endLine} disabled={disabled} onChange={event=>{setEnd(Number(event.target.value));setFields(empty());setPreview(null);}}/></label></div>
  {index.units.slice(startLine-1,endLine).map((unit,i)=><label key={unit.id} style={{display:'block'}}>原文第{startLine+i}行<textarea readOnly rows={2} aria-label={`选取原文第${startLine+i}行片段`} style={{width:'100%',resize:'vertical'}} value={unit.text.replace(/(?:\r\n|\r|\n)$/u,'')} onSelect={event=>setSelection({unitId:unit.id,start:event.currentTarget.selectionStart,end:event.currentTarget.selectionEnd})}/></label>)}
  <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>{(Object.keys(labels) as Field[]).map(field=><button key={field} type="button" disabled={disabled||!selection} onClick={()=>add(field)}>加入{labels[field]}</button>)}</div>
  {(Object.keys(labels) as Field[]).map(field=><div key={field}><strong>{labels[field]}：</strong><span style={{whiteSpace:'pre-wrap'}}>{copy(fields[field])||'尚未选择'}</span>{fields[field].length?<button type="button" disabled={disabled} onClick={()=>{setFields({...fields,[field]:[]});setPreview(null);}}>移除此字段</button>:null}</div>)}
  <label>声道<select value={channel} disabled={disabled} onChange={event=>{setChannel(event.target.value as Channel);setPreview(null);}}>{['SPEECH','OS','VO','NARRATION','SYSTEM'].map(value=><option key={value} value={value}>{value==='SPEECH'?'现场对白':value}</option>)}</select></label>
  <button type="button" className="studioButton" data-variant="secondary" disabled={disabled} onClick={stageFields}>加入本批核对</button>
  {selected.decisions.filter(item=>item.approval||item.type==='SOURCE_REGROUP').map(item=><div key={item.id}>当前第{item.startLine}–{item.endLine}行解释 · {item.approval?.origin} · {item.approval?.ref}<button type="button" disabled={disabled} onClick={()=>stage(undefined,item.id)}>加入本批撤销</button></div>)}
  <p>本批：{batch.map(item=>`第${item.episode}集${item.decisionId?'撤销':'解释'}`).join('、')||'尚未添加'} <button type="button" disabled={disabled} onClick={()=>{setBatch([]);setBase('');setPreview(null);}}>清空本批</button></p>
  <label>本次明确解释<input style={{width:'100%'}} value={explanation} maxLength={2000} disabled={disabled} placeholder="说明你认可的对白、动作与保留范围" onChange={event=>{setExplanation(event.target.value);setPreview(null);}}/></label>
  <button type="button" className="studioButton" data-variant="secondary" disabled={disabled||!batch.length||!explanation.trim()} onClick={()=>void send()}>免费预览</button>
  {preview?<section aria-label="采用前后对照"><p>批准来源：{preview.approval.origin} · {preview.approval.ref}</p><p>保留目录{preview.before.catalogCoverage.length}集；原 Q1 {preview.before.editorialCoverage.length}集；采用后有效编辑{preview.after.effectiveEditorialCoverage.length}集。此次免费复核：{preview.after.reviewedEpisodes.join('、')||'撤销后不追加覆盖'}。</p>{preview.episodes.map(episode=><article key={episode.episode}><h4>第{episode.episode}集 · {episode.action==='REVOKE'?'撤销':'解释'}</h4><details><summary>原件读取文本</summary><pre style={{whiteSpace:'pre-wrap'}}>{episode.sourceText}</pre></details><details><summary>采用前解释</summary><pre style={{whiteSpace:'pre-wrap'}}>{episode.beforeReadingText??'原解释尚有未决内容，原文完整保留。'}</pre></details><p>采用后对白／动作对照</p><pre style={{whiteSpace:'pre-wrap'}}>{episode.afterReadingText??episode.diagnostics.map(item=>item.message).join('\n')}</pre></article>)}<button type="button" className="studioButton" data-variant="primary" disabled={disabled} onClick={()=>void send(true)}>认可此解释，保留原件与对照并明确采用本批</button></section>:null}
  {error?<p role="alert">{error}</p>:null}
 </details>;
}
