"use client";
import {useRef} from 'react';
import {actionLabel,type WorkflowSnapshot} from './types';
import styles from './workspace.module.css';

export function ProductionProgressPanel({snapshot}:{snapshot:WorkflowSnapshot}){
 const progress=snapshot.readiness.progress;
 const baseline=useRef<{key:string;text:number;strict:number}|null>(null);
 if(!progress)return <p className={styles.fine}>分阶段计数尚未返回；保留已有状态，不推算完成数。</p>;
 if(baseline.current?.key!==progress.scopeKey)baseline.current={key:progress.scopeKey,text:progress.textAdopted,strict:progress.strictComplete};
 const delta=(n:number)=>`${n>=0?'+':''}${n}`;
 const ratio=(n:number|null,total:number)=>n===null?'未记录可核验数量':`${n} / ${total}`;
 const action=snapshot.workflow.activeAction?.kind??snapshot.nextAction.proposedAction?.kind??snapshot.nextAction.kind;
 const phase=!snapshot.readiness.stage1.ready||action==='STAGE1'?'第一阶段 · 基础资料':snapshot.readiness.direction.status!=='CONFIRMED'||action==='DIRECTION'?'第一阶段 · 方向确认':snapshot.readiness.assets.busy||['ASSETS','WAIT_ASSETS','WAIT_ASSET_REPAIR','WAIT_DESIGN_CONFIRM','WAIT_MATERIAL_REQUEST_STALE'].includes(action)?'第二阶段 · 所选资产':'第三阶段 · 文字制作与核对';
 return <section className={styles.panel} aria-label="分阶段真实进度" aria-live="polite">
  <h3>分阶段真实进度 · 本轮 {progress.scopeTotal} 集</h3><p>当前阶段：{phase}</p>
  <dl className={styles.budget}>
   <div><dt>读源资料登记</dt><dd>{ratio(progress.sourceRead,progress.scopeTotal)} 集</dd></div>
   <div><dt>基础资料复核</dt><dd>{ratio(progress.foundationReviewed,progress.scopeTotal)}{progress.foundationReviewed===null?'':' 集'}</dd></div>
   <div><dt>完整叙事导航复核</dt><dd>{ratio(progress.navigationReviewed,progress.scopeTotal)}</dd></div>
   <div><dt>文字采用（含整集整编）</dt><dd>{progress.textAdopted} / {progress.scopeTotal} 集</dd></div>
   <div><dt>文字及实际承接就绪</dt><dd>{progress.strictComplete} / {progress.scopeTotal} 集</dd></div>
   <div><dt>当前稿独审闭环</dt><dd>{ratio(progress.independentReviewed,progress.scopeTotal)}</dd></div>
   <div><dt>当前稿实际质量记录（非独审）</dt><dd>{progress.currentQualityRecords} / {progress.scopeTotal} 集</dd></div>
  </dl>
  <p className={styles.fine}>本页自首次读取的变化：文字采用 {delta(progress.textAdopted-baseline.current.text)}，承接就绪 {delta(progress.strictComplete-baseline.current.strict)}；换范围、源版本或重新打开页面后重新建立增量基线，累计成果不重置。</p>
  <p>{progress.assets?progress.assets.total?`本轮所选资产：文字齐稿 ${progress.assets.ready} / ${progress.assets.total} 项；复核采用 ${progress.assets.adopted} / ${progress.assets.total} 项。`:'本轮未指定额外资产设计；0项不表示全库已完成。':'所选资产计数待基础资料就绪后核验。'}</p>
  <p>在制：{progress.inProduction.length?progress.inProduction.map(run=>`第${run.episodeNumber}集 · ${({plan:'情绪统筹',author:'完整主创',finish:'统一整编'} as Record<string,string>)[run.stage??'']??'核对准备'}${run.queued?'（排队）':run.inFlight?'（在途）':'（准备）'}`).join('；'):'暂无已核验的在制分镜'}。局部阻塞／待承接：{progress.blockedEpisodes.length?progress.blockedEpisodes.map(n=>`第${n}集`).join('、'):'无已登记分集阻塞'}。</p>
  <p>下一步：{actionLabel(snapshot.nextAction)}{snapshot.nextAction.message?` · ${snapshot.nextAction.message}`:''}。</p>
  <p className={styles.fine}>ETA待估：未建立足够同阶段近期墙钟吞吐样本，不把原生耗时相加或按总集数推算。读源登记来自当前F2覆盖，基础复核来自Q1覆盖，均不自证完整叙事导航独审；当前没有可核验的逐集独审身份与当前稿绑定记录，不以首集勾选、状态名或程序通过补数。浏览与现有5秒刷新不新增制作调用。</p>
 </section>;
}
