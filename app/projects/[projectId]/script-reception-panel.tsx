'use client';

import {useCallback,useEffect,useRef,useState} from 'react';
import type {ScriptReceptionView,ScriptResolutionSuggestion,SavedScriptResolution} from '@/lib/script-resolution-service';
import type {ResolutionType,ScriptResolutionChoice} from '@/lib/script-resolution-plan';
import type {Channel} from '@/lib/standard-script';
import {compactSourceDisplay} from '@/lib/source-display';
import styles from './script-reception-panel.module.css';
import {SourceRegroupPanel} from './source-regroup-panel';

const labels:Record<ResolutionType,string>={ACTION:'正文动作',DIALOGUE:'对白或连续对白',CONTINUITY:'辅助 · 连续性备注',EMOTION_CLUE:'辅助 · 情绪线索',RELATIONSHIP_CONTEXT:'辅助 · 人物关系',KNOWLEDGE_REVEAL:'辅助 · 知情与揭示',SPACE_CONSTRAINT:'辅助 · 空间约束',CREATIVE_GUIDANCE:'辅助 · 创作处理'};
const resolutionLabel=(type:ScriptResolutionChoice['type'])=>type==='SOURCE_REGROUP'?'来源对白／动作重组':labels[type];
const channels:Record<Channel,string>={SPEECH:'现场对白',OS:'OS · 内心声音',VO:'VO · 画外声音',NARRATION:'旁白',SYSTEM:'系统音'};
const compositeDiagnostic=(code:string)=>['MULTIPLE_SPEAKERS_ON_LINE','MIXED_DIALOGUE_ONSCREEN_TEXT'].includes(code);
type Editor={id?:string;startLine:number;endLine:number;type:ResolutionType|'';speaker:string;channel:Channel};
const editorFor=(selected:ScriptReceptionView['selected'],line:number):Editor=>{
 const item=selected?.lines.find(item=>item.line===line),saved=selected?.decisions.find(decision=>decision.startLine<=line&&decision.endLine>=line);
 const group=item?.entryId?selected?.lines.filter(other=>other.entryId===item.entryId):[];
 return saved&&saved.type!=='SOURCE_REGROUP'?{...saved,type:saved.type,speaker:saved.speaker??'',channel:saved.channel??'SPEECH'}:{startLine:group?.[0]?.line??line,endLine:group?.at(-1)?.line??line,type:'',speaker:item?.speaker??/^[\s\uFEFF]*([^：:()（）\r\n]+)(?:[（(][^）)\r\n]*[）)])?\s*[:：]/.exec(item?.text??'')?.[1]?.trim()??'',channel:item?.channel??'SPEECH'};
};
const savedAssistance=(view?:ScriptReceptionView)=>view?.selected?.assistance?.find(item=>item.status!=='STALE'&&item.sourceVersion===view.selected!.sourceVersion&&item.expectedRevision===view.selected!.revision)??null;
const firstEditor=(view?:ScriptReceptionView)=>{const saved=savedAssistance(view),start=saved?.startLine??saved?.choice?.startLine,end=saved?.endLine??saved?.choice?.endLine;return start&&end?{...editorFor(view!.selected,start),startLine:start,endLine:end}:view?.selected?.diagnostics[0]?editorFor(view.selected,view.selected.diagnostics[0].line):null;};
const assistLabels:Record<ScriptResolutionSuggestion['status'],string>={RUNNING:'已有判断进行中',CANDIDATE:'待你采用的候选',NO_SUGGESTION:'没有明确建议，仍待人工核对',UNKNOWN:'调用结果未知',NOT_SENT:'请求未发送',STALE:'记录已过期',ERROR:'辅助判断未完成'};
function usageLabel(value:unknown){const usage=value&&typeof value==='object'?value as Record<string,unknown>:{};const parts=[['inputTokens','输入'],['outputTokens','输出'],['totalTokens','合计']].flatMap(([key,label])=>typeof usage[key]==='number'?[`${label} ${usage[key]}`]:[]);return parts.length?`该次已知用量：${parts.join(' · ')} tokens；费用未返回。`:'该次用量与费用未知，不按0计算。';}

export function ScriptReceptionPanel({projectId,initialEpisode,initial}:{projectId:string;initialEpisode?:number;initial?:ScriptReceptionView}){
 const endpoint=`/projects/${encodeURIComponent(projectId)}/script-reception`;
 const [data,setData]=useState(initial),[correcting,setCorrecting]=useState(false),[editor,setEditor]=useState<Editor|null>(()=>firstEditor(initial));
 const [readingMode,setReadingMode]=useState<'standard'|'source'>('standard');
 const [busy,setBusy]=useState<'load'|'save'|'revoke'|'assist'|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState(''),[suggestion,setSuggestion]=useState<ScriptResolutionSuggestion|null>(()=>savedAssistance(initial));
 const [judgmentProvider,setJudgmentProvider]=useState<'PROJECT'|'JEV'>(()=>savedAssistance(initial)?.provider==='JEV'?'JEV':'PROJECT'),[externalConsent,setExternalConsent]=useState(false),[riskConfirmed,setRiskConfirmed]=useState(false);
 const sequence=useRef(0);
 const receive=useCallback((next:ScriptReceptionView)=>{const saved=savedAssistance(next);setData(next);setEditor(firstEditor(next));setSuggestion(saved);setJudgmentProvider(saved?.provider==='JEV'?'JEV':'PROJECT');setExternalConsent(false);setRiskConfirmed(false);setCorrecting(false);setError('');},[]);
 const load=useCallback(async(episode?:number)=>{
  const id=++sequence.current;setBusy('load');setError('');setNotice('');setSuggestion(null);
  try{const response=await fetch(endpoint+(episode===undefined?'':`?episode=${episode}`),{cache:'no-store'}),value=await response.json();if(!response.ok)throw new Error(value.error??'原文暂不能读取。');if(id===sequence.current)receive(value);}
  catch(cause){if(id===sequence.current)setError(cause instanceof Error?cause.message:'读取失败，请手动重试。');}
  finally{if(id===sequence.current)setBusy(null);}
 },[endpoint,receive]);
 useEffect(()=>{if(initial?.projectId===projectId)receive(initial);else void load(initialEpisode);return()=>{sequence.current++;};},[initial,initialEpisode,projectId,load,receive]);
 const selected=data?.selected,disabled=Boolean(busy),canConfirm=Boolean(data?.canConfirm);
 async function post(action:'confirm'|'revoke'|'assist',extra:Record<string,unknown>){
  if(!selected||disabled)return;
  const id=++sequence.current;setBusy(action==='confirm'?'save':action);setError('');setNotice('');
  try{
   const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,episode:selected.number,sourceVersion:selected.sourceVersion,expectedRevision:selected.revision,...(action==='assist'?{judgmentProvider,explicitExternalConsent:judgmentProvider==='JEV'&&externalConsent}:{}),...extra})}),value=await response.json();
   if(!response.ok){if(id===sequence.current&&value.assistance){setSuggestion(value.assistance);setRiskConfirmed(false);}throw new Error(value.error??'操作未完成，请核对当前记录后再决定是否重试。');}
   if(id!==sequence.current)return;
   if(action==='assist'){setSuggestion(value);setRiskConfirmed(false);if(value.cached)setNotice('已读取保存的判断，没有发起新的模型调用。');}else{receive(value);setNotice(action==='revoke'?'已撤销当前解释，旧版本仍保留。':'解析核对已保存；没有改写原文，也不代表作品内容已经验收。');}
  }catch(cause){if(id===sequence.current)setError(cause instanceof Error?cause.message:'操作结果未知；未自动重试，请先刷新核对已保存记录。');}
  finally{if(id===sequence.current)setBusy(null);}
 }
 const choice=():ScriptResolutionChoice|null=>editor?.type?{...(editor.id?{id:editor.id}:{}),startLine:editor.startLine,endLine:editor.endLine,type:editor.type,...(editor.type==='DIALOGUE'?{speaker:editor.speaker,channel:editor.channel}:{})}:null;
 const unsupported=Boolean(editor&&(selected?.diagnostics.some(item=>compositeDiagnostic(item.code)&&item.line>=editor.startLine&&item.line<=editor.endLine)||selected?.lines.some(item=>['DIALOGUE_GROUP','BODY_GROUP','SOURCE_REGROUP'].includes(item.kind)&&item.line>=editor.startLine&&item.line<=editor.endLine)));
 const matches=(item:ScriptResolutionSuggestion)=>selected&&editor&&item.sourceVersion===selected.sourceVersion&&item.expectedRevision===selected.revision&&(item.startLine??item.choice?.startLine)===editor.startLine&&(item.endLine??item.choice?.endLine)===editor.endLine&&(judgmentProvider==='JEV'?item.provider==='JEV':item.provider!=='JEV'&&(!item.provider||!data?.assistProviders||item.provider===data.assistProviders.project));
 const activeSuggestion=suggestion&&matches(suggestion)?suggestion:selected?.assistance?.find(matches)??null;
 const retryNeeded=Boolean(activeSuggestion&&['UNKNOWN','ERROR','NOT_SENT'].includes(activeSuggestion.status)),alreadyJudged=Boolean(activeSuggestion&&['CANDIDATE','NO_SUGGESTION'].includes(activeSuggestion.status));
 const externalBlocked=judgmentProvider==='JEV'&&(!externalConsent||data?.assistProviders?.jevConfigured!==true);
 useEffect(()=>{setExternalConsent(false);setRiskConfirmed(false);},[editor?.startLine,editor?.endLine,judgmentProvider,selected?.sourceVersion,selected?.revision,activeSuggestion?.id]);
 const rangeText=editor?selected?.lines.filter(line=>line.line>=editor.startLine&&line.line<=editor.endLine).map(line=>line.text).join(''):'';
 const revise=(decision:SavedScriptResolution)=>{if(decision.type==='SOURCE_REGROUP')return;setEditor({...decision,speaker:decision.speaker??'',channel:decision.channel??'SPEECH'});setSuggestion(null);setNotice('');};
 return <section className={styles.panel} id="script-reception" aria-labelledby="script-reception-title" aria-busy={Boolean(busy)}>
  <header className={styles.header}><div><span className={styles.eyebrow}>程序清洗 · 原句可追溯</span><h2 id="script-reception-title">剧本标准阅读</h2><p>空行已去除，明确的说话者、表演提示和台词自动识别，无需逐行确认。原文与历史仍保留。</p></div><div className={styles.tools}>
   <label>选择集数<select aria-label="选择待核对剧集" value={selected?.number??''} disabled={disabled||!data?.episodes.length} onChange={event=>void load(Number(event.target.value))}>{data?.episodes.map(episode=><option value={episode.number} key={episode.number}>第{episode.number}集{episode.title?` · ${episode.title}`:''}</option>)}</select></label>
   <button type="button" className="studioButton" data-variant="ghost" disabled={disabled} onClick={()=>void load(selected?.number??initialEpisode)}>刷新记录</button>
  </div></header>
  {busy?<p role="status" aria-live="polite" className={styles.notice}>{({load:'正在读取本集原文…',save:'正在保存本次核对…',revoke:'正在撤销当前解释…',assist:'正在判断所选片段；尚未采用任何候选…'})[busy]}</p>:null}
  {error?<p role="alert" className={styles.error}>{error}</p>:null}{notice?<p role="status" className={styles.notice}>{notice}</p>:null}
  {!selected?<p className={styles.notice}>{data?'当前没有可读取的分集原文。':'尚未读取原文；不会自动调用模型。'}</p>:<>
   <SourceRegroupPanel projectId={projectId} selected={selected} canConfirm={canConfirm} className={styles.editor} onAdopt={view=>{setData(view);setEditor(null);setNotice('本批来源解释与已付目录已保存，原件及旧记录保留。');}}/>
   <div className={styles.summary}><span>{selected.ready?'已自动识别，可供后续使用':'有少量位置需要确认含义'} · 第{selected.number}集</span>{selected.diagnostics.length||selected.decisions.length?<span>{selected.diagnostics.length?`${selected.diagnostics.length}处待核对`:''}{selected.decisions.length?` · ${selected.decisions.length}项已保存修正`:''}</span>:null}</div>
   {selected.status==='STALE'?<p role="status" className={styles.warning}>本集原文已变化，旧核对不再生效；旧版本仍保留，请按当前原句重新核对。</p>:null}
   {!canConfirm?<p className={styles.notice}>你可以阅读原文与标准稿；确认、修改或撤销需要管理员或审阅者权限。</p>:null}
   <div className={styles.switcher} role="group" aria-label="剧本阅读方式"><button type="button" aria-pressed={readingMode==='standard'} onClick={()=>setReadingMode('standard')}>标准稿</button><button type="button" aria-pressed={readingMode==='source'} onClick={()=>setReadingMode('source')}>接收原文</button></div>
   <div className={styles.tools}><p className={styles.caption}>{readingMode==='standard'?'沿用来源行号，便于定位；第三阶段读取结构包，不从展示文本猜冒号。':'接收原句仅去除空白整行；原件、来源映射和历史仍保留。'} <a href={`/projects/${encodeURIComponent(projectId)}/source`}>原件与导入记录</a></p>{canConfirm?<label className={styles.check}><input type="checkbox" checked={correcting} disabled={readingMode==='source'} onChange={event=>setCorrecting(event.target.checked)}/>手动修正解析</label>:null}</div>
   <div className={styles.reading} tabIndex={0} role="region" aria-label={readingMode==='standard'?'清洗正文':'接收原文'}>
    {readingMode==='source'?<pre>{compactSourceDisplay(selected.sourceText)}</pre>:selected.lines.filter(line=>line.text.trim()).map(line=><div className={styles.line} key={line.unitId} id={`script-line-${line.line}`} data-unresolved={line.target==='UNRESOLVED'}><span className={styles.lineNumber}>{line.line}</span><pre title={line.speaker?`说话者：${line.speaker}`:undefined}>{line.text.replace(/(?:\r\n|\r|\n)$/,'')}</pre>{canConfirm&&(correcting||line.target==='UNRESOLVED')?<button type="button" disabled={disabled} aria-label={`核对第${line.line}行`} onClick={()=>{setEditor(editorFor(selected,line.line));setSuggestion(null);}}>修正</button>:null}</div>)}
   </div>
   {selected.diagnostics.length?<div className={styles.diagnostics}><h3>这些原句需要核对</h3>{selected.diagnostics.map((item,index)=><article key={`${item.line}-${item.code}-${index}`}><strong>第{item.line}行</strong><p>{item.message}</p><pre>{selected.lines.find(line=>line.line===item.line)?.text??'当前没有对应原句'}</pre>{compositeDiagnostic(item.code)?<p className={styles.warning}>暂不支持将此处复合正文合并解释：多个说者、对白与字幕须各自保留，不能改标动作或辅助资料绕过。</p>:canConfirm?<button type="button" className="studioButton" data-variant="secondary" disabled={disabled} onClick={()=>{setEditor(editorFor(selected,item.line));setSuggestion(null);}}>核对此处</button>:null}</article>)}</div>:null}
   {canConfirm&&editor?<div className={styles.editor}><h3>{editor.id?'修改已有解析核对':'确认这一段的含义'}</h3><p className={styles.caption}>连续对白范围从原有说者头开始，包含全部续句；不跨其他明确说者或动作标记。所有字句仍从原文提取。</p>
    <div className={styles.fields}><label>开始行<input type="number" min={1} max={selected.lines.length} value={editor.startLine} disabled={disabled} onChange={event=>{setEditor({...editor,startLine:Number(event.target.value)});setSuggestion(null);}}/></label><label>结束行<input type="number" min={editor.startLine} max={selected.lines.length} value={editor.endLine} disabled={disabled} onChange={event=>{setEditor({...editor,endLine:Number(event.target.value)});setSuggestion(null);}}/></label><label className={styles.wide}>解析为<select value={editor.type} disabled={disabled} onChange={event=>{setEditor({...editor,type:event.target.value as ResolutionType|''});setSuggestion(null);}}><option value="">请选择明确类型</option>{Object.entries(labels).map(([type,label])=><option key={type} value={type}>{label}</option>)}</select></label></div>
    <pre className={styles.excerpt}>{rangeText}</pre>
    {editor.type==='DIALOGUE'?<div className={styles.fields}><label className={styles.wide}>原文明示的说者<input value={editor.speaker} maxLength={80} disabled={disabled} placeholder="必须与所选第一行说者头一致" onChange={event=>setEditor({...editor,speaker:event.target.value})}/></label><label className={styles.wide}>声道<select value={editor.channel} disabled={disabled} onChange={event=>setEditor({...editor,channel:event.target.value as Channel})}>{Object.entries(channels).map(([key,label])=><option value={key} key={key}>{label}</option>)}</select></label></div>:null}
    {unsupported?<p className={styles.warning}>多说者对白组及对白／字幕混合正文须保留各自类型；暂不支持用单一类型或旧候选覆盖，不能改标动作或辅助资料绕过保真检查。</p>:null}
    <div className={styles.assistSettings}><label>辅助判断服务<select aria-label="辅助判断服务" value={judgmentProvider} disabled={disabled} onChange={event=>{setJudgmentProvider(event.target.value as 'PROJECT'|'JEV');setSuggestion(null);}}><option value="PROJECT">项目CLI/API（默认）{data?.assistProviders?` · ${data.assistProviders.project}`:''}</option><option value="JEV">Jev仅类型建议</option></select></label>
     {judgmentProvider==='JEV'?<><p className={styles.caption}>{data?.assistProviders?.jevConfigured?'服务端已配置；只给类型建议，不判断剧情、身份或制作是否通过。':'服务端未配置Jev，当前不会发送请求，也不会自动回退到项目模型。'}</p><label className={styles.check}><input type="checkbox" checked={externalConsent} disabled={disabled} onChange={event=>setExternalConsent(event.target.checked)}/>同意把所选及相邻的必要原句发送至第三方TypeSafe/Jev服务。</label></>:null}
    </div>
    <div className={styles.actions}><button type="button" className="studioButton" data-variant="primary" disabled={disabled||unsupported||!editor.type} onClick={()=>{const value=choice();if(value)void post('confirm',{choice:value});}}>确认此项</button><button type="button" className="studioButton" data-variant="secondary" disabled={disabled||unsupported||Boolean(editor.id)||externalBlocked||alreadyJudged||retryNeeded||activeSuggestion?.status==='RUNNING'||activeSuggestion?.status==='STALE'} onClick={()=>void post('assist',{startLine:editor.startLine,endLine:editor.endLine})}>{alreadyJudged?'已有判断，不重复调用':activeSuggestion?.status==='RUNNING'?'判断进行中，请刷新结果':'辅助判断此处（可能消耗）'}</button><button type="button" className="studioButton" data-variant="ghost" disabled={disabled} onClick={()=>{setEditor(null);setSuggestion(null);}}>收起</button></div>
    <p className={styles.caption}>只有明确点击才可能调用模型；同范围候选复用，进行中不重复发送。用量与费用可能未知。刷新只读取记录；超时不等于请求已停止，错误不会自动重试。</p>
    {activeSuggestion?<div className={styles.candidate} role="status"><strong>{assistLabels[activeSuggestion.status]}</strong><p>{activeSuggestion.note}</p>{activeSuggestion.error?<p className={styles.error}>{activeSuggestion.error}</p>:null}{activeSuggestion.choice?<p>第{activeSuggestion.choice.startLine}–{activeSuggestion.choice.endLine}行 · {resolutionLabel(activeSuggestion.choice.type)}{activeSuggestion.choice.speaker?` · ${activeSuggestion.choice.speaker} · ${channels[activeSuggestion.choice.channel!]}`:''}</p>:null}<p className={styles.caption}>{activeSuggestion.provider?`来源 ${activeSuggestion.provider} · `:''}{usageLabel(activeSuggestion.usage)}</p>{activeSuggestion.status==='CANDIDATE'&&activeSuggestion.choice?<button type="button" className="studioButton" data-variant="primary" disabled={disabled||unsupported} onClick={()=>void post('confirm',{choice:activeSuggestion.choice})}>采用并保存核对</button>:null}
     {retryNeeded?<><label className={styles.check}><input type="checkbox" checked={riskConfirmed} disabled={disabled} onChange={event=>setRiskConfirmed(event.target.checked)}/>我已核对上次记录，理解新尝试可能与旧请求重复消耗；明确要求重新发起。</label><button type="button" className="studioButton" data-variant="caution" disabled={disabled||unsupported||externalBlocked||!riskConfirmed} onClick={()=>void post('assist',{startLine:editor.startLine,endLine:editor.endLine,retryAttemptId:activeSuggestion.id,acknowledgeRisk:true})}>确认风险后重新判断（可能消耗）</button></>:null}
    </div>:null}
   </div>:null}
   {selected.decisions.length?<div className={styles.saved}><h3>当前有效核对</h3>{selected.decisions.map(decision=><div key={decision.id}><span>第{decision.startLine}–{decision.endLine}行 · {resolutionLabel(decision.type)}{decision.speaker?` · ${decision.speaker}`:''}</span>{canConfirm&&!decision.approval&&decision.type!=='SOURCE_REGROUP'?<div className={styles.actions}><button type="button" disabled={disabled} onClick={()=>revise(decision)}>修改</button><button type="button" disabled={disabled} onClick={()=>void post('revoke',{decisionId:decision.id})}>撤销</button></div>:null}</div>)}</div>:null}
   {selected.assistance?.length?<details className={styles.history}><summary>已保存的辅助判断 · 刷新不会重新调用</summary>{selected.assistance.map(item=><div className={styles.assistRecord} key={item.id}><strong>{assistLabels[item.status]} · 第{item.startLine??item.choice?.startLine??'未知'}–{item.endLine??item.choice?.endLine??'未知'}行{item.provider?` · ${item.provider}`:''}</strong><p>{item.note}</p><p className={styles.caption}>{usageLabel(item.usage)}</p></div>)}</details>:null}
   {selected.history.length?<details className={styles.history}><summary>最近核对历史 · 旧版本始终保留</summary><ul>{selected.history.map(item=><li key={item.revision}>版本{item.revision} · {item.action==='REVOKE'?'撤销':'确认或修改'} · {item.decisionCount}项{item.stale?' · 旧原文，已不生效':''} · {new Date(item.createdAt).toLocaleString('zh-CN')}</li>)}</ul></details>:null}
  </>}
 </section>;
}
