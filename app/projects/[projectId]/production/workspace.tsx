"use client";

import {useCallback,useEffect,useRef,useState} from 'react';
import type {ProductionWorkflow} from '@/lib/production-workflow';
import {WorkflowGlassRail,WorkflowGlassCard,workflowGlassStyles as glass,type WorkflowGlassState} from '@/app/ui/workflow-glass';
import {episodePresentation} from '@/lib/episode-presentation';
import {actionLabel,paidAction,productionBudgetStopped,type AssetOption,type EpisodeOption,type RunOption,type WorkflowSnapshot} from './types';
import styles from './workspace.module.css';
import {ParallelPanel} from './parallel-panel';
import {HandoffDeliveryPanel} from './handoff-delivery-panel';
import {ProductionProgressPanel} from './progress-panel';
import {recommendedWorkflowBudget} from '@/runtime/production-policy.mjs';

const count=(value:number)=>value.toLocaleString('zh-CN');
const scopeLabel=(numbers:number[])=>numbers.length>2&&numbers.every((n,i)=>!i||n===numbers[i-1]+1)?`第${numbers[0]}–${numbers.at(-1)}集`:`第${numbers.join('、')}集`;
const date=(value:string)=>new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const issueText=(value:unknown):string=>typeof value==='string'?value:value&&typeof value==='object'?String((value as {message?:unknown;problem?:unknown;code?:unknown}).message??(value as {problem?:unknown}).problem??'有一项资料需要核对'):'资料待核对';

export function ProductionWorkspace({projectId,episodes,assets}:{projectId:string;episodes:EpisodeOption[];assets:AssetOption[]}){
 const endpoint=`/api/projects/${encodeURIComponent(projectId)}/production-workflow`,base=`/projects/${encodeURIComponent(projectId)}`;
 const [workflows,setWorkflows]=useState<ProductionWorkflow[]>([]),[snapshot,setSnapshot]=useState<WorkflowSnapshot|null>(null),[selectedId,setSelectedId]=useState(''),[loading,setLoading]=useState(true),[pending,setPending]=useState<string[]>([]),[error,setError]=useState(''),[notice,setNotice]=useState(''),[uncertain,setUncertain]=useState(false),[syncedAt,setSyncedAt]=useState('');
 const [mode,setMode]=useState<'SINGLE'|'CHAIN'>('SINGLE'),[from,setFrom]=useState(''),[to,setTo]=useState(''),[critical,setCritical]=useState<string[]>([]),[budgetId,setBudgetId]=useState(''),[costConsent,setCostConsent]=useState(false);
 const [review,setReview]=useState({author:false,assembly:false,resolved:false,note:''}),[runChoices,setRunChoices]=useState<Record<number,RunOption[]>>({}),[runDrafts,setRunDrafts]=useState<Record<number,string>>({});
 const alive=useRef(false),epoch=useRef(0),readSequence=useRef(0),selected=useRef(''),current=useRef<WorkflowSnapshot|null>(null),requests=useRef(new Set<string>());
 const [connection,setConnection]=useState('');
 const read=useCallback(async(url:string,init?:RequestInit)=>{const response=await fetch(url,{cache:'no-store',...init});const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||`请求未完成（${response.status}）`);return data;},[]);
 const apply=useCallback((value:WorkflowSnapshot)=>{
  if(!value.workflow?.id)throw new Error('流程返回不完整；已有记录未覆盖。');
  if(current.current?.workflow.id===value.workflow.id&&current.current.workflow.revision>value.workflow.revision)return;
  current.current=value;setSnapshot(value);setSyncedAt(new Date().toLocaleTimeString('zh-CN',{hour12:false}));
  setWorkflows(previous=>[value.workflow,...previous.filter(item=>item.id!==value.workflow.id)]);
 },[]);
 const load=useCallback(async(id:string)=>{const sequence=++readSequence.current,life=epoch.current;const value=await read(`${endpoint}?workflowId=${encodeURIComponent(id)}`);if(alive.current&&life===epoch.current&&selected.current===id&&sequence===readSequence.current)apply(value);},[read,endpoint,apply]);
 const choose=useCallback(async(id:string)=>{
  if(requests.current.size)return;
  epoch.current++;readSequence.current++;selected.current=id;current.current=null;setSelectedId(id);setSnapshot(null);setError('');setNotice('');setCostConsent(false);setReview({author:false,assembly:false,resolved:false,note:''});setRunChoices({});setRunDrafts({});
  const url=new URL(window.location.href);id?url.searchParams.set('workflowId',id):url.searchParams.delete('workflowId');window.history.replaceState(null,'',url);
  if(!id){setLoading(false);return;}setLoading(true);try{await load(id);}catch(reason){if(alive.current&&selected.current===id)setError((reason as Error).message);}finally{if(alive.current&&selected.current===id)setLoading(false);}
 },[load]);
 useEffect(()=>{alive.current=true;const life=++epoch.current;void read(endpoint).then(async(data:{workflows:ProductionWorkflow[]})=>{
  if(!alive.current||epoch.current!==life)return;setWorkflows(data.workflows);setBudgetId(data.workflows[0]?.budgetId??'');const desired=new URLSearchParams(window.location.search).get('workflowId');const id=data.workflows.find(item=>item.id===desired)?.id??data.workflows[0]?.id;if(id)await choose(id);
 }).catch(reason=>{if(alive.current)setError((reason as Error).message);}).finally(()=>{if(alive.current)setLoading(false);});return()=>{alive.current=false;epoch.current++;readSequence.current++;};},[endpoint,read,choose]);
 const refresh=useCallback(async()=>{setError('');try{if(selected.current)await load(selected.current);else{const data=await read(endpoint);if(alive.current){setWorkflows(data.workflows);setUncertain(false);setNotice('流程列表已核对；创建不会启动模型。');if(data.workflows.length)await choose(data.workflows[0].id);}}}catch(reason){if(alive.current)setError((reason as Error).message);}},[load,read,endpoint,choose]);
 useEffect(()=>{if(!selectedId)return;let closed=false,timer:ReturnType<typeof setTimeout>;const poll=async()=>{if(document.visibilityState!=='hidden')await load(selectedId).catch(reason=>{if(!closed)setError(`状态同步暂未完成：${(reason as Error).message}`);});if(!closed)timer=setTimeout(poll,5000);};timer=setTimeout(poll,5000);return()=>{closed=true;clearTimeout(timer);};},[selectedId,load]);
 useEffect(()=>{
  let lastWake=0;
  const wake=async()=>{
   const before=current.current,life=epoch.current,id=selected.current;
   if(document.visibilityState==='hidden'||navigator.onLine===false||requests.current.size||!before?.parallel?.enabled||before.workflow.paused||!before.workflow.parallel?.authorizedAt||Date.now()-lastWake<1000)return;
   lastWake=Date.now();requests.current.add('reconnect-parallel');setPending([...requests.current]);setConnection('正在重连原四路，核对已保存回包…');
   try{
    const value=await read(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'reconnect-parallel',workflowId:id,expectedAuthorization:before.workflow.parallel.authorizedAt})});
    if(alive.current&&epoch.current===life&&selected.current===id){apply(value);setError('');setConnection(current.current?.workflow.paused?'四路仍保持人工暂停，未自动继续。':'已重新连接原四路；只接续已授权的未完成步骤。');}
   }catch{if(alive.current&&epoch.current===life)setConnection('重连暂未完成；原任务保留，联网后可再次重连，不重复发送已付请求。');}
   finally{requests.current.delete('reconnect-parallel');if(alive.current)setPending([...requests.current]);}
  };
  const offline=()=>setConnection('网络已断开；本页不会补发请求，原任务与回包保留。');
  window.addEventListener('online',wake);window.addEventListener('pageshow',wake);document.addEventListener('visibilitychange',wake);window.addEventListener('offline',offline);
  return()=>{window.removeEventListener('online',wake);window.removeEventListener('pageshow',wake);document.removeEventListener('visibilitychange',wake);window.removeEventListener('offline',offline);};
 },[endpoint,read,apply]);
 useEffect(()=>{if(snapshot?.parallel?.enabled&&snapshot.parallel.worker?.status==='WAIT_CONNECTION')window.dispatchEvent(new Event('pageshow'));},[selectedId,snapshot?.parallel?.enabled]);
 const act=async(action:string,payload:Record<string,unknown>={})=>{
  if(requests.current.has(action)||requests.current.size&&action!=='pause')return;
  if(action!=='create'&&!current.current)return;
  const life=epoch.current,target=selected.current,previous=current.current;
  requests.current.add(action);setPending([...requests.current]);setError('');setNotice('');
  try{
   const value=await read(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,...(action==='create'?{}:{workflowId:previous!.workflow.id,expectedRevision:previous!.workflow.revision}),...(action==='pause'&&previous?.workflow.parallel?.authorizedAt?{expectedAuthorization:previous.workflow.parallel.authorizedAt}:{}),...payload})});
   if(!alive.current||epoch.current!==life||selected.current!==target)return;
   if(action==='create'){selected.current=value.workflow.id;setSelectedId(value.workflow.id);const url=new URL(window.location.href);url.searchParams.set('workflowId',value.workflow.id);window.history.replaceState(null,'',url);}
   apply(value);setConnection('');setUncertain(false);setNotice(action==='configure-parallel'?'四路安排已保存，尚未启动，不调用AI。':action==='start-parallel'?'四路已明确启动；服务端自动补位，切换页面不会停止制作。':action==='pause'?'后续派单已暂停；在途请求会继续保存回包，不取消、不重发。':action==='reconnect-parallel'?'已核对原四路连接；未解除人工暂停、未重发已付请求。':action==='create'?'选集流程已创建；尚未派发模型。':action==='advance'?'本次推进已返回；只依据已保存结果显示下一步。':action==='resume'?'已解除流程暂停；不会自动开始模型调用。':action==='quality-review'?'实际质量核对记录已保存；不代表用户或成片验收。':'操作已保存，没有自动派发新模型。');return value;
  }catch(reason){if(alive.current&&epoch.current===life){setError((reason as Error).message);if(action==='create'){setUncertain(true);setNotice('创建结果待核对；请刷新列表，勿重复创建。');}else await load(target).catch(()=>{});}}
  finally{requests.current.delete(action);if(alive.current)setPending([...requests.current]);}
 };
 const chosen=from?(mode==='SINGLE'?[Number(from)]:to&&Number(to)>=Number(from)?episodes.filter(e=>e.number>=Number(from)&&e.number<=Number(to)).map(e=>e.number):[]):[];
 const scopeValid=chosen.length>0&&chosen.length<=500;
 const proposedBudget=scopeValid?recommendedWorkflowBudget(chosen.length):null;
 const contiguous=mode==='SINGLE'||chosen.every((n,i)=>i===0||n===chosen[i-1]+1);
 const availableAssets=assets.filter(asset=>['REFERENCE','DERIVE'].includes(asset.mode)&&asset.episodes.some(n=>chosen.includes(n)));
 const selectedCritical=critical.filter(key=>availableAssets.some(asset=>asset.key===key));
 const workflow=snapshot?.workflow,next=snapshot?.nextAction,busy=Boolean(pending.length),budget=snapshot?.budget;
 const budgetStopped=!budget||productionBudgetStopped(budget);
 const episodeLink=(number:number,runId?:string)=>{const episode=episodes.find(item=>item.number===number);return episode?`${base}/episodes/${encodeURIComponent(episode.id)}/storyboard${runId?`?runId=${encodeURIComponent(runId)}`:''}`:base;};
 const stages:{title:string;label:string;detail:string;state:WorkflowGlassState;href:string}[]=snapshot?[
  {title:'第一阶段 · 基础与方向',label:snapshot.readiness.stage1.busy||snapshot.readiness.direction.pending?'处理中 · 见实际记录':snapshot.readiness.direction.status==='CONFIRMED'&&snapshot.readiness.standard.ready&&snapshot.readiness.stage1.ready?'已具备':snapshot.readiness.direction.hasCandidate?'方向待确认':'尚有待办',detail:'原文、基础资料及600字以内方向确认卡；实际覆盖核验仍保留。',state:snapshot.readiness.stage1.busy||snapshot.readiness.direction.pending?'waiting':snapshot.readiness.direction.status==='CONFIRMED'&&snapshot.readiness.standard.ready&&snapshot.readiness.stage1.ready?'complete':'attention',href:`${base}/preparation`},
  {title:'第二阶段 · 资产材料',label:snapshot.keyDesignGate==='NOT_SPECIFIED'?'关键设计未指定':snapshot.keyDesignGate==='CONFIRMED'?'指定关键设计已采用':'关键设计待采用',detail:workflow!.requestedAssetKeys.length?`仅处理已选 ${workflow!.requestedAssetKeys.length} 项及必要材料依赖；图片不作为文字制作门槛。`:'未要求额外设计；只向分镜供给有来源的本集材料卡。',state:snapshot.readiness.assets.busy?'waiting':snapshot.keyDesignGate==='CONFIRMED'?'complete':snapshot.keyDesignGate==='NOT_SPECIFIED'?'idle':'attention',href:`${base}/asset-prompts?episodes=${workflow!.episodeNumbers.join(',')}`},
  {title:'第三阶段 · 分镜与闭环',label:next?.kind==='COMPLETE'?'文字交付已完成':next?.kind==='QUALITY_CHECK'?'首集实际质量核对':next?.kind==='NEED_UPSTREAM'||next?.kind==='WAIT_EXECUTOR_REPAIR'?'局部待补':next?.kind==='WAIT_STORYBOARD'||workflow!.activeAction?'待实际执行回执':'按选集推进',detail:'主创、整编、前后集承接与按需补料；保留正确稿和所有历史。',state:next?.kind==='COMPLETE'?'complete':next?.kind==='NEED_UPSTREAM'||next?.kind==='WAIT_EXECUTOR_REPAIR'?'attention':next?.kind?.startsWith('WAIT_')?'waiting':'idle',href:episodeLink(next?.episodeNumber??workflow!.episodeNumbers[0],next?.runId)}
 ]:[];
 return <div className={styles.workspace}>
  <div className={styles.toolbar}><div><h2>连续制作</h2><p>安排单集或连续剧集，共用预算并核对承接；浏览和刷新不调用模型。</p></div><div className={styles.actions}>
   {workflows.length?<label className={styles.field}>流程记录<select aria-label="流程记录" value={selectedId} disabled={busy} onChange={e=>void choose(e.target.value)}><option value="">新建选集流程</option>{workflows.map(item=><option key={item.id} value={item.id}>{scopeLabel(item.episodeNumbers)} · {item.mode==='CHAIN'?'连续链':'单集'} · {date(item.createdAt)}</option>)}</select></label>:null}
   <button className="quietButton" type="button" onClick={()=>void refresh()}>刷新闭环状态</button>{workflow?<button className="studioButton" data-variant="secondary" type="button" disabled={busy} onClick={()=>{setBudgetId(workflow.budgetId);void choose('');}}>新建选集流程</button>:null}
  </div></div>
  <p className={styles.meta}>{snapshot?.parallel?'四组接续 / 同集1路 · 新任务模型与速度见下方':'GPT-6.1 Sol · 中档 · 手动逐次推进 · 四路需明确启用'} <span>{syncedAt?`状态同步于 ${syncedAt}`:''}</span></p>
  {connection?<p className={styles.notice} role="status">{connection}</p>:null}
  {error?<p className={styles.error} role="alert">{error}</p>:null}{notice?<p className={styles.notice} role="status">{notice}</p>:null}
  {loading?<p role="status">正在读取已有记录…</p>:!selectedId?<section className={styles.panel} aria-label="选择制作范围"><h3>先明确这轮要做哪些集</h3><div className={styles.fields}>
   <label className={styles.field}>制作方式<select aria-label="制作方式" value={mode} disabled={busy} onChange={e=>{setMode(e.target.value as 'SINGLE'|'CHAIN');setCritical([]);}}><option value="SINGLE">单集</option><option value="CHAIN">连续链 · 按集承接</option></select></label>
   <label className={styles.field}>{mode==='SINGLE'?'制作集':'开始集'}<select aria-label={mode==='SINGLE'?'制作集':'开始集'} value={from} disabled={busy} onChange={e=>{setFrom(e.target.value);setCritical([]);}}><option value="">请选择</option>{episodes.map(e=><option key={e.id} value={e.number}>{episodePresentation(e.number,e.title).fullTitle}</option>)}</select></label>
   {mode==='CHAIN'?<label className={styles.field}>结束集<select aria-label="结束集" value={to} disabled={busy} onChange={e=>{setTo(e.target.value);setCritical([]);}}><option value="">请选择</option>{episodes.filter(e=>!from||e.number>=Number(from)).map(e=><option key={e.id} value={e.number}>{episodePresentation(e.number,e.title).fullTitle}</option>)}</select></label>:null}
  </div>{!contiguous?<p role="alert">范围内有缺集，不能作为连续链；请缩小范围或改为单集。</p>:null}{chosen.length>500?<p role="alert">一轮最多选择500集，请缩小本轮范围；已保存任务不受影响。</p>:null}
  <details className={styles.disclosure}><summary>指定关键设计（可选）</summary><p>只选择必须先采用的设计；空选表示尚未指定，不表示已确认。必要派生材料自动纳入，但不会当成本集出场。</p><div className={styles.assetChoices}>{availableAssets.map(asset=><label key={asset.key}><input type="checkbox" checked={selectedCritical.includes(asset.key)} disabled={busy} onChange={e=>setCritical(keys=>e.target.checked?[...keys,asset.key]:keys.filter(key=>key!==asset.key))}/>{asset.name}</label>)}</div>{!availableAssets.length?<p>选集后显示其中已登记的可设计资产；未定位的资产不会自动列为本集出场。</p>:null}</details>
  <label className={styles.field}>共享预算<select aria-label="使用共享预算" value={budgetId} disabled={busy} onChange={e=>setBudgetId(e.target.value)}><option value="">新一轮预算 · {proposedBudget?`${count(proposedBudget.maxCalls)}条记录 / ${count(proposedBudget.maxTokens)} Token`:'按选集推荐停止线'}</option>{[...new Map(workflows.map(item=>[item.budgetId,item])).values()].map(item=><option key={item.budgetId} value={item.budgetId}>沿用 {scopeLabel(item.episodeNumbers)} 的共享预算（不清零、不调限）</option>)}</select></label>
  <p className={styles.fine}>沿用预算不会重置计数。新一轮预算需主动选择；未知用量不记为0，也不自动重试。创建只保存范围与检查状态。</p>
  <button type="button" className="studioButton" data-variant="primary" disabled={busy||uncertain||!scopeValid||!contiguous} onClick={()=>void act('create',{episodeNumbers:chosen,mode,criticalAssetKeys:selectedCritical,requestedAssetKeys:selectedCritical,costAcknowledged:false,...(budgetId?{budgetId}:proposedBudget)})}>创建选集流程</button>
  </section>:null}
  {snapshot&&workflow&&next?<>
   <ProductionProgressPanel snapshot={snapshot}/>
   {workflow.mode==='CHAIN'?<ParallelPanel key={workflow.id} snapshot={snapshot} busy={busy} pausePending={pending.includes('pause')} onAction={act} episodeLink={episodeLink}/>:null}
   <HandoffDeliveryPanel key={`handoff-${workflow.id}`} snapshot={snapshot} endpoint={endpoint} busy={busy} onAction={act}/>
   <WorkflowGlassRail label="三阶段制作流程">{stages.map((stage,i)=><WorkflowGlassCard key={stage.title} index={i} state={stage.state}><span className={glass.number}>{String(i+1).padStart(2,'0')}</span><div className={glass.heading}><h3 className={glass.title}>{stage.title}</h3><span className={glass.status}>{stage.label}</span></div><p className={glass.detail}>{stage.detail}</p><a className="quietButton" href={stage.href}>查看阶段工作台</a></WorkflowGlassCard>)}</WorkflowGlassRail>
   <div className={styles.grid}>
    <section className={styles.panel} aria-label="当前下一步"><h3>{snapshot.parallel?.enabled?'四路队列正在接续':actionLabel(next)}</h3><p>{snapshot.parallel?.enabled?'每组只在本组当前集落定后接续下一集；局部待办显示在对应队列卡，不重复手工派单。':next.message||'只推进当前必要动作，不自动扩展到其他集或完整资产库。'}</p>
     {next.kind==='WAIT_DIRECTION_CONFIRM'?<a className="studioButton" data-variant="primary" href={`${base}/preparation#series-direction`}>确认全剧方向</a>:next.kind==='WAIT_DESIGN_CONFIRM'?<a className="studioButton" data-variant="primary" href={`${base}/asset-prompts?episodes=${workflow.episodeNumbers.join(',')}`}>核对并采用指定设计</a>:null}
     {['WAIT_SOURCE_CONFLICT','WAIT_SOURCE_CONFIRM','WAIT_STANDARD_SCRIPT','WAIT_STAGE1_REPAIR','WAIT_DIRECTION_REPAIR','WAIT_SCOPE'].includes(next.kind)?<a className="quietButton" href={`${base}/preparation`}>查看对应原文与待办</a>:null}
     {next.runId&&next.episodeNumber!==undefined?<a className="quietButton" href={episodeLink(next.episodeNumber,next.runId)}>查看第{next.episodeNumber}集当前分镜</a>:null}
     {next.needs?.length?<ul>{next.needs.map((need,i)=><li key={i}>第{need.stage}阶段 · {need.target}：{need.purpose}（{need.blocking?'必要材料':'补充建议'}）{need.stage===2&&next.runId&&need.sourceRefs?.length&&need.packageIds?.length?<div><button className="quietButton" type="button" disabled={busy||Boolean(workflow.activeAction)} onClick={()=>void act('request-materials',{needs:[{runId:next.runId,target:need.target,sourceRefs:need.sourceRefs,packageIds:need.packageIds}]})}>登记局部补料 · 不调用模型</button></div>:<p className={styles.fine}>先由对应执行者核对来源或创作范围，不自动转成资产生成。</p>}</li>)}</ul>:null}
     {!snapshot.parallel?.enabled&&(next.kind==='WAIT_COST_CONFIRM'?<><label className={styles.check}><input type="checkbox" checked={costConsent} onChange={e=>setCostConsent(e.target.checked)}/>允许本轮所选范围的必要模型调用</label><p className={styles.fine}>下一动作：{next.proposedAction?actionLabel(next.proposedAction):'以当前检查为准'}。一次阶段动作可能含多次调用，每次均受共享停止线约束；不生成图片。</p><button className="studioButton" data-variant="primary" type="button" disabled={busy||!costConsent||budgetStopped} onClick={()=>void act('advance',{costAcknowledged:true})}>确认预算并推进下一步</button></>:paidAction(next.kind)?<button className="studioButton" data-variant="primary" type="button" disabled={busy||budgetStopped} onClick={()=>void act('advance')}>{actionLabel(next)} · 推进一次</button>:null)}
     {next.kind==='QUALITY_CHECK'?<details className={styles.disclosure}><summary>执行者质量核对记录</summary><div className={styles.quality}><p>由实际执行者检查首集主创与整编；不是要求用户逐集审批，也不能仅凭程序通过勾选。</p><label className={styles.check}><input type="checkbox" checked={review.author} onChange={e=>setReview({...review,author:e.target.checked})}/>已检查首集主创内容</label><label className={styles.check}><input type="checkbox" checked={review.assembly} onChange={e=>setReview({...review,assembly:e.target.checked})}/>已检查首集整编与承接</label><label className={styles.check}><input type="checkbox" checked={review.resolved} onChange={e=>setReview({...review,resolved:e.target.checked})}/>主要问题已解决</label><label className={styles.field}>质量核对说明<textarea aria-label="质量核对说明" rows={3} maxLength={2000} value={review.note} onChange={e=>setReview({...review,note:e.target.value})}/></label><button className="studioButton" data-variant="primary" type="button" disabled={busy||!review.author||!review.assembly||!review.resolved||!review.note.trim()} onClick={()=>void act('quality-review',{runId:next.runId,fingerprint:next.fingerprint,authorReviewed:true,assemblyReviewed:true,majorIssuesResolved:true,note:review.note.trim()})}>记录实际质量核对</button></div></details>:null}
     <div className={styles.actions}>{!snapshot.parallel&&(workflow.paused?<button type="button" className="quietButton" disabled={busy} onClick={()=>void act('resume')}>解除流程暂停 · 不自动调用</button>:next.kind!=='COMPLETE'?<button type="button" className="quietButton" disabled={pending.includes('pause')} onClick={()=>void act('pause')}>暂停后续派单</button>:null)}{workflow.activeAction?<button type="button" className="quietButton" disabled={busy} onClick={()=>void act('recover')}>核对已登记动作 · 不重发</button>:null}</div>
     {pending.length?<p className={styles.fine} role="status">{pending.includes('advance')?'本次推进请求尚未返回，正在读取真实状态；不重复派单。':'正在保存操作…'}</p>:null}
    </section>
    <section className={styles.panel} aria-label="共享预算"><h3>本轮共享预算</h3><p>{scopeLabel(workflow.episodeNumbers)} · {workflow.mode==='CHAIN'?'连续链':'单集'} · 三阶段合并计数</p><dl className={styles.budget}><div><dt>调用</dt><dd>{count(budget!.summary.calls)} / {count(budget!.maxCalls)}</dd></div><div><dt>已知 Token</dt><dd>{count(budget!.summary.knownTokens)} / {count(budget!.maxTokens)}</dd></div><div><dt>未知用量</dt><dd>{budget!.summary.unknownAttempts} 项</dd></div>{typeof budget!.summary.acknowledgedUnknownAttempts==='number'?<div><dt>共享已授权未知费用</dt><dd>{budget!.summary.acknowledgedUnknownAttempts} 项</dd></div>:null}{typeof budget!.summary.blockingUnknownAttempts==='number'?<div><dt>仍阻断派单</dt><dd>{budget!.summary.blockingUnknownAttempts} 项</dd></div>:null}<div><dt>在途请求</dt><dd>{budget!.summary.inFlight} 项</dd></div></dl><p className={styles.fine}>{budget!.summary.unknownAttempts?'未知用量仍保留。单任务确认不替代共享账本授权；已授权仍为未知费用。':budget!.summary.complete?'现有用量记录完整；不代表作品已验收。':'尚有未完整用量；已知量不代表实际总消耗。'}{budget!.paused?' 共享预算已暂停。':''}</p></section>
   </div>
   <section className={styles.panel} aria-label="制作门检查"><h3>确认与材料边界</h3><p>全剧方向：{snapshot.readiness.direction.status==='CONFIRMED'?'已明确确认':snapshot.readiness.direction.hasCandidate?'已有候选，待用户确认':'尚未确认'}。普通制作授权不等于采用方向或设计。</p><p>{snapshot.keyDesignGate==='NOT_SPECIFIED'?'关键设计尚未指定；可用有来源的文字材料试做，不标记为设计已确认。':snapshot.keyDesignGate==='CONFIRMED'?'指定关键设计已采用；仍按原文和本集时点供给。':`指定关键设计还有 ${snapshot.readiness.assets.missingCriticalKeys.length} 项待采用。图片不阻塞文字制作。`}</p>{snapshot.readiness.sourceConflicts.length||snapshot.readiness.standard.issues.length?<details><summary>查看来源与标准稿待办</summary><ul>{[...snapshot.readiness.sourceConflicts,...snapshot.readiness.standard.issues].map((issue,i)=><li key={i}>{issueText(issue)}</li>)}</ul></details>:null}</section>
   <section className={styles.panel} aria-label="选集与采用的分镜版本"><h3>这轮明确采用哪些分镜版本</h3><p className={styles.fine}>不会自动取同集“最新稿”。切换只更改选用关系；旧稿保留，后续承接重新核对。</p><div className={styles.episodeRows}>{workflow.episodeNumbers.map(number=>{const runId=workflow.selectedRuns[number],choices=runChoices[number];return <div key={number}><a href={episodeLink(number,runId)}>{episodePresentation(number,episodes.find(e=>e.number===number)?.title??'').fullTitle}</a><span>{runId?'已有明确选用版本':'尚未创建或选用'}</span><button type="button" className="quietButton" disabled={busy||Boolean(workflow.activeAction)} onClick={async()=>{const episode=episodes.find(e=>e.number===number);if(!episode)return;try{const data=await read(`/api/episodes/${encodeURIComponent(episode.id)}/storyboard`);setRunChoices(previous=>({...previous,[number]:data.runs}));setRunDrafts(previous=>({...previous,[number]:runId||''}));}catch(reason){setError((reason as Error).message);}}}>选择已有版本</button>{choices?<><select aria-label={`第${number}集选用分镜版本`} value={runDrafts[number]??''} disabled={busy} onChange={e=>setRunDrafts(previous=>({...previous,[number]:e.target.value}))}><option value="">请选择已核对的版本</option>{choices.map(item=><option key={item.id} value={item.id} disabled={item.legacyReadOnly}>{date(item.createdAt)} · {item.legacyReadOnly?'旧版只读':'保存的分镜版本'}</option>)}</select><button className="quietButton" type="button" disabled={busy||!runDrafts[number]||runDrafts[number]===runId} onClick={()=>void act('select-run',{episodeNumber:number,runId:runDrafts[number]})}>保存选用版本 · 不调用模型</button></>:null}</div>;})}</div></section>
   {workflow.receipts.length?<details className={styles.panel}><summary>已保存的阶段记录（{workflow.receipts.length}）</summary><ul>{workflow.receipts.map((receipt,i)=><li key={receipt.id??i}>{actionLabel(receipt as {kind:string;episodeNumber?:number})} · {receipt.status==='SUCCEEDED'?'动作已返回':receipt.status==='RECOVERED'?'已恢复记录':receipt.status==='RUNNING'?'动作已登记，等待回执':'需核对记录'}{receipt.error?.message?`：${receipt.error.message}`:''}</li>)}</ul><p className={styles.fine}>动作返回不代表专业质量或真实视听验收；保留原始任务和版本。</p></details>:null}
  </>:null}
 </div>;
}
