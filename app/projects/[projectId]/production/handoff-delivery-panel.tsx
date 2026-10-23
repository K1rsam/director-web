"use client";
import {useState} from 'react';
import {SeasonClosingForm} from './season-closing-form';
import type {WorkflowSnapshot} from './types';
import styles from './workspace.module.css';

type Props={snapshot:WorkflowSnapshot;endpoint:string;busy:boolean;onAction:(action:string,payload?:Record<string,unknown>)=>Promise<any>};
export function HandoffDeliveryPanel({snapshot,endpoint,busy,onAction}:Props){
 const {workflow}=snapshot;
 const [runId,setRunId]=useState(''),[evidence,setEvidence]=useState<{runId:string;evidenceHash:string}|null>(null),[body,setBody]=useState(''),[note,setNote]=useState(''),[checked,setChecked]=useState(false),[error,setError]=useState('');
 const [savingDelivery,setSavingDelivery]=useState<boolean|null>(null);
 const toggleDelivery=async(enabled:boolean)=>{setSavingDelivery(enabled);try{await onAction('configure-delivery',{enabled});}finally{setSavingDelivery(null);}};
 const target=runId||snapshot.nextAction.runId||Object.values(workflow.selectedRuns).at(-1)||'';
 const download=(value:unknown)=>{const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=document.createElement('a');a.href=url;a.download='boundary-evidence.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 const requestEvidence=async()=>{setEvidence(null);setChecked(false);setError('');const value=await onAction('boundary-evidence',{runId:target});if(value?.boundaryEvidence){setEvidence(value.boundaryEvidence);download(value.boundaryEvidence);}};
 const submit=async()=>{setError('');try{const command=JSON.parse(body);if(!command||typeof command!=='object'||Array.isArray(command)||Object.keys(command).some(k=>!['review','sourceResolution','approval'].includes(k)))throw new Error('只接受 review，或 sourceResolution 与独立 approval；不接受模型输出自动放行。');await onAction('boundary-review',{...command,runId:evidence!.runId,evidenceHash:evidence!.evidenceHash,reviewedFullSources:true,reviewedActualShots:true,note});}catch(reason){setError((reason as Error).message);}};
 const fileUrl=(name:string)=>`${endpoint}?workflowId=${encodeURIComponent(workflow.id)}&deliveryFile=${encodeURIComponent(name)}`;
 return <section className={styles.panel} aria-label="承接复核与文字导出"><h3>承接复核与文字导出</h3>
  <p className={styles.fine}>免费核对和导出，不调用模型。复核保留 SOURCE、锁约定、原回执和真实尾态；结构检查不等于文字、视听或用户验收。</p>
  {workflow.season?<><p className={styles.fine}>本季原集：{workflow.season.scope.episodeNumbers.join('、')}；当前为{workflow.delivery?.seasonDelivery==='final'?'final整季最终声明':'preview部分预览'}，按真实逐镜秒数校验。</p>{snapshot.readiness.seasonTiming?<p className={styles.fine}>已采用镜头 {(snapshot.readiness.seasonTiming.actualSeconds/60).toFixed(2)} 分钟，加剩余估时后 {(snapshot.readiness.seasonTiming.projected.minSeconds/60).toFixed(1)}–{(snapshot.readiness.seasonTiming.projected.maxSeconds/60).toFixed(1)} 分钟。{snapshot.readiness.seasonTiming.requiresReview?'已停在未派发边界。':'此为文字分镜校准，尚非成片时长。'}</p>:null}<div className={styles.actions}><button className="quietButton" disabled={busy} onClick={()=>void onAction('configure-delivery',{enabled:workflow.delivery?.enabled??true,seasonDelivery:'preview'})}>部分预览</button><button className="quietButton" disabled={busy} onClick={()=>void onAction('configure-delivery',{enabled:workflow.delivery?.enabled??true,seasonDelivery:'final'})}>声明整季最终导出</button>{workflow.delivery?.result?<a className="quietButton" href={fileUrl('season-summary.json')}>本季范围与实际秒数</a>:null}</div></>:null}
  <label className={styles.check}><input type="checkbox" checked={savingDelivery??workflow.delivery?.enabled===true} disabled={busy||savingDelivery!==null} onChange={e=>void toggleDelivery(e.target.checked)}/>必要承接及首集核对完成后，自动导出采用稿并对账{savingDelivery!==null?'（正在保存）':''}</label>
  <div className={styles.actions}><button className="quietButton" type="button" disabled={busy||snapshot.nextAction.kind!=='COMPLETE'} onClick={()=>void onAction('export-delivery')}>导出并核对 · 不重创作</button>
   {workflow.delivery?.result?<><a className="quietButton" href={fileUrl('complete.md')}>下载合订文字稿</a><a className="quietButton" href={fileUrl('manifest.json')}>下载逐集哈希清单</a><a className="quietButton" href={fileUrl('usage.json')}>下载逐请求用量对账</a><a className="quietButton" href={fileUrl('report.md')}>下载报告</a></>:null}</div>
  {workflow.delivery?.result?<p className={styles.fine} style={{overflowWrap:'anywhere'}}>逐集文件保存在本机交付目录：{workflow.delivery.result.directory}。文件改动、来源或选版漂移会阻断当前下载，历史文件不覆盖。</p>:null}
  <details className={styles.disclosure}><summary>执行者有源承接复核 · 非批量放行</summary>
   <label className={styles.field}>待核对版本<select value={target} disabled={busy} onChange={e=>{setRunId(e.target.value);setEvidence(null);setChecked(false);}}>{workflow.episodeNumbers.filter(n=>workflow.selectedRuns[n]).map(n=><option key={n} value={workflow.selectedRuns[n]}>第{n}集 · 明确采用版</option>)}</select></label>
   <button className="quietButton" type="button" disabled={busy||!target} onClick={()=>void requestEvidence()}>下载完整双源及当前实际尾首稿证据包</button>
   {evidence?<><p className={styles.fine}>已绑定当前证据 {evidence.evidenceHash.slice(0,12)}。缺前集实际稿、来源或签名变动须重新核对，不猜补。</p>
    <label className={styles.check}><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>已完整阅读双源和实际尾首镜，不以摘要或关键词代审</label>
    <label className={styles.field}>坐标化核对结论<textarea value={note} maxLength={4000} rows={3} onChange={e=>setNote(e.target.value)}/></label>
    <label className={styles.field}>结构化复核 JSON（review；源文取舍须另有 sourceResolution / approval）<textarea value={body} rows={5} onChange={e=>setBody(e.target.value)}/></label>
    <button className="quietButton" type="button" disabled={busy||!checked||!note.trim()||!body.trim()} onClick={()=>void submit()}>登记这一次免费复核</button></>:null}
   {error?<p className={styles.error} role="alert">{error}</p>:null}
  </details>
  {workflow.season?<SeasonClosingForm key={workflow.id} projectId={workflow.projectId} workflowId={workflow.id} disabled={busy}/>:null}
 </section>;
}
