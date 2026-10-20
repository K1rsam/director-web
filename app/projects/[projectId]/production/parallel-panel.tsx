"use client";

import {useEffect,useState} from 'react';
import {WorkflowGlassRail,WorkflowGlassCard,workflowGlassStyles as glass,type WorkflowGlassState} from '@/app/ui/workflow-glass';
import {actionLabel,productionBudgetStopped,type WorkflowSnapshot} from './types';
import styles from './workspace.module.css';
import {DEFAULT_EPISODE_BUDGET,EPISODE_TOKEN_WARNING,DEFAULT_PRODUCTION_MODEL_SELECTION,PRODUCTION_MODELS,PRODUCTION_REASONING,type ProductionModelSelection} from '@/runtime/production-policy.mjs';

const modelLabel=(id:string)=>({'gpt-6.1-sol':'GPT-6.1 Sol','gpt-6-sol':'GPT-6 Sol','gpt-6-astra':'GPT-6 Astra'} as Record<string,string>)[id]??id;
const reasoningLabel=(id:string)=>({low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高',ultra:'极高'} as Record<string,string>)[id]??id;

export function ParallelPanel({snapshot,busy,pausePending=false,onAction,episodeLink}:{snapshot:WorkflowSnapshot;busy:boolean;pausePending?:boolean;onAction:(action:string,payload?:Record<string,unknown>)=>Promise<void>;episodeLink:(number:number,runId?:string)=>string}){
 const [consent,setConsent]=useState(false),p=snapshot.parallel,w=snapshot.workflow,b=snapshot.budget;
 const savedSelection=p?.modelSelection??w.parallel?.modelSelection??DEFAULT_PRODUCTION_MODEL_SELECTION;
 const [selection,setSelection]=useState<ProductionModelSelection>(savedSelection),[fast,setFast]=useState(p?.executionTier==='fast');
 useEffect(()=>{setSelection(savedSelection);setFast(p?.executionTier==='fast');setConsent(false);},[savedSelection.model,savedSelection.reasoning,p?.executionTier,p?.enabled]);
 const resume=Boolean(w.paused&&w.parallel?.authorizedAt&&w.costAcknowledged),locked=busy||Boolean(p?.enabled)||resume;
 const settings={modelSelection:selection,executionTier:fast?'fast':'standard'};
 const stopped=productionBudgetStopped(b);
 const runBudget=w.parallel?.runBudget??w.budgetPolicy?.episode??DEFAULT_EPISODE_BUDGET;
 return <section className={styles.panel} aria-label="四路连续制作"><div className={styles.toolbar}><div><h3>四路连续制作</h3><p>{w.paused?p?.activeEpisodes?`后续派单已暂停；仍有${p.activeEpisodes}集在途，等待回包保存。`:'四路已暂停；可联网后继续原队列。':p?`正在制作 ${p.activeEpisodes} 集 / 最多4集`:'四组分别按集顺序接续，共用本轮预算和跨集承接资料。'}</p></div>{!p?<button className="studioButton" data-variant="secondary" type="button" disabled={busy||Boolean(w.activeAction)} onClick={()=>void onAction('configure-parallel',settings)}>保存四路安排 · 不调用AI</button>:null}</div>
  <div className={styles.fields}><label className={styles.field}>新分镜模型<select aria-label="四路新任务模型" disabled={locked} value={selection.model} onChange={e=>{setSelection({...selection,model:e.target.value as ProductionModelSelection['model']});setConsent(false);}}>{PRODUCTION_MODELS.map(id=><option key={id} value={id}>{modelLabel(id)}</option>)}</select></label><label className={styles.field}>推理档位<select aria-label="四路推理档位" disabled={locked} value={selection.reasoning} onChange={e=>{setSelection({...selection,reasoning:e.target.value as ProductionModelSelection['reasoning']});setConsent(false);}}>{PRODUCTION_REASONING.map(id=><option key={id} value={id}>{reasoningLabel(id)}</option>)}</select></label><label className={styles.check}><input aria-label="Fast 加速" type="checkbox" disabled={locked} checked={fast} onChange={e=>{setFast(e.target.checked);setConsent(false);}}/>Fast 加速（默认关闭）</label></div>
  <p className={styles.fine}>仅影响新建分镜任务；已创建任务继续其冻结模型、推理与速度，不重做旧稿。模型可用性仍受本机CLI账号权限限制，不自动换模型。</p>
  <p className={styles.fine}>新单集停止线：{runBudget.maxCalls}条请求记录 / {runBudget.maxTokens.toLocaleString('zh-CN')}已知Token；{EPISODE_TOKEN_WARNING.toLocaleString('zh-CN')}提示留意。共享停止线：{b.maxCalls.toLocaleString('zh-CN')}条记录 / {b.maxTokens.toLocaleString('zh-CN')}已知Token，四组共同累计。旧任务不调限；在途回包可能越过停止线，非账单硬封顶。长稿、全部幻想及另行精修需单独核对预算。</p>
  {p?<>
   <p>文字稿与承接已就绪 {p.completedEpisodes} / {w.episodeNumbers.length} 集 · 初步承接待实际核对 {p.provisionalEpisodes} 集</p>
   <WorkflowGlassRail label="四组制作队列" columns={4}>{p.lanes.map(lane=>{
    const op=lane.run,kind=lane.nextAction.kind,stage=({plan:'情绪统筹',author:'完整主创',finish:'统一整编'} as Record<string,string>)[op?.stage??'']??'本集制作';
    const holding=Boolean(op?.busy&&op.inFlight>0&&op.executionPhase==='waiting'),running=Boolean(op?.busy&&op.inFlight>0&&!holding);
    const state:WorkflowGlassState=running?'running':holding||op?.busy?'waiting':kind==='COMPLETE'&&!lane.provisionalEpisodes?'complete':kind==='COMPLETE'?'waiting':kind.startsWith('WAIT_')||kind==='NEED_UPSTREAM'?'attention':'idle';
    const label=op?.busy?op.queued?'等待本机执行位':op.inFlight?`${stage} · ${holding?'等待本机输出':'执行中'}`:'核对资料 / 准备派单':kind==='COMPLETE'?lane.provisionalEpisodes?'文字稿已生成 · 承接待核对':'本组文字稿已完成':actionLabel(lane.nextAction);
    return <WorkflowGlassCard key={lane.index} index={lane.index} state={state} activity={holding?'waiting':'none'} data-production-lane={lane.index}><span className={glass.number}>{String(lane.index+1).padStart(2,'0')}</span><div className={glass.heading}><h3 className={glass.title}>第{lane.from}–{lane.to}集</h3><span className={glass.status}>{lane.episodeNumber!==null?`第${lane.episodeNumber}集`:''}</span></div><p className={glass.detail}>{label}</p><p className={styles.fine}>已核对 {lane.completedEpisodes} / {lane.to-lane.from+1} 集</p>{lane.nextAction.message&&!op?.busy?<p className={styles.fine}>{lane.nextAction.message}</p>:null}{lane.episodeNumber!==null?<a className="quietButton" href={episodeLink(lane.episodeNumber,lane.nextAction.runId)}>查看本集任务</a>:null}</WorkflowGlassCard>;
   })}</WorkflowGlassRail>
   {p.qualityReviewPending?<p className={styles.fine}>首集质量复核尚未记录；不会伪造通过，也不会因此重复制作或阻塞其他组的文字稿。</p>:null}
   {p.lanes.filter(lane=>(lane.run?.knownTokens??0)>=EPISODE_TOKEN_WARNING).map(lane=><p key={lane.index} role="status" className={styles.fine}>第{lane.episodeNumber}集已知用量达到{lane.run!.knownTokens!.toLocaleString('zh-CN')}Token，已超过50万提醒线；继续受本集和共享停止线保护，不自动扩额或重做。</p>)}
   {p.worker?.error?<p role={['RECONNECTING','WAIT_CONNECTION'].includes(p.worker.status)?'status':'alert'} className={['RECONNECTING','WAIT_CONNECTION'].includes(p.worker.status)?styles.fine:styles.error}>{p.worker.error.message}</p>:null}
   {b.summary.unknownAttempts>0?<p className={styles.fine}>未知用量仍保留 {b.summary.unknownAttempts} 项；{typeof b.summary.acknowledgedUnknownAttempts==='number'?`共享账本已授权 ${b.summary.acknowledgedUnknownAttempts} 项费用风险；`:''}仍阻断派单 {b.summary.blockingUnknownAttempts??b.summary.unknownAttempts} 项。单任务确认不替代共享账本授权；已授权仍为未知费用。</p>:null}
   {!p.enabled?<>{!resume?<label className={styles.check}><input type="checkbox" checked={consent} disabled={busy} onChange={e=>setConsent(e.target.checked)}/>{fast?'允许四路制作及Fast额度消耗':'允许本轮四路制作的模型调用'}</label>:null}<p className={styles.fine}>新任务使用{modelLabel(selection.model)} · {reasoningLabel(selection.reasoning)}档 · {fast?'Fast':'普通速度（不用Fast）'}；旧任务保持冻结档位。{fast?'Fast会更快消耗订阅额度，不减少Token。':''}达到共享停止线或出现尚未获共享授权的未知用量就停止新派单，不自动增预算。</p><button className="studioButton" data-variant="primary" type="button" disabled={busy||!resume&&!consent||stopped} onClick={()=>void onAction('start-parallel',{costAcknowledged:true,...settings,...(fast?{fastAcknowledged:true}:{})})}>{resume?'继续原四路制作':'一键四路连续制作'}</button>{stopped?<p role="status">{actionLabel({kind:'WAIT_BUDGET'})}；四组不会各自重置预算。</p>:null}</>:<div className={styles.actions}><button className="studioButton" data-variant="caution" type="button" disabled={pausePending} onClick={()=>void onAction('pause')}>统一暂停 · 保留在途回包</button>{p.worker?.status==='WAIT_CONNECTION'?<button className="quietButton" type="button" disabled={busy} onClick={()=>void onAction('reconnect-parallel',{expectedAuthorization:w.parallel?.authorizedAt})}>重连原四路 · 不重发</button>:null}</div>}
   <p className={styles.fine}>合盖前先暂停，等“在途”归零再合盖更稳妥。未主动暂停时，开盖联网会核对并重连原四路；主动暂停须点继续。费用未知的请求不会自动补发。</p>
  </>:null}
 </section>;
}
