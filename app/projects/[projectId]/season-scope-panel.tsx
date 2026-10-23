'use client';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
type Row=Record<string,any>;
const minutes=(seconds:number)=>`${(seconds/60).toFixed(1)}分`;
function estimateRange(timeline:Row[]){let min=0,max=0;for(const t of timeline){min+=Math.max(t.speech.min,t.action.min,t.speech.min+t.action.min-t.overlap.max)+t.transition.min;max+=t.speech.max+t.action.max-t.overlap.min+t.transition.max;}return {min,max};}
function estimate(timeline:Row[]){const {min,max}=estimateRange(timeline);return `${minutes(min)}–${minutes(max)}`;}
function offTarget(t:Row[]){const {min,max}=estimateRange(t);return max<7200||min>9000;}
export function SeasonScopePanel({projectId,initial}:{projectId:string;initial:Row}){
 const [state,setState]=useState(initial),[pending,setPending]=useState(false),[error,setError]=useState(''),[cost,setCost]=useState(false),[previousProjectId,setPreviousProjectId]=useState(''),[previousClosedId,setPreviousClosedId]=useState('');const router=useRouter();
 useEffect(()=>{if(!pending)setState((current:Row)=>initial.revision>=current.revision?initial:current);},[initial,pending]);
 async function act(action:string,extra:Row={}){setPending(true);setError('');try{const response=await fetch(`/projects/${encodeURIComponent(projectId)}/season-scope`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action,expectedRevision:state.revision,...extra})});const result=await response.json();if(!response.ok)throw new Error(result.error??'操作未完成');setState(result);router.refresh();}catch(e){setError((e as Error).message);}finally{setPending(false);}}
 async function refresh(){try{const response=await fetch(`/projects/${encodeURIComponent(projectId)}/season-scope`,{cache:'no-store'}),result=await response.json();if(!response.ok)throw new Error(result.error);setState(result);}catch(e){setError((e as Error).message);}}
 return <section className="bibleSection" aria-label="首季范围"><div className="bibleSectionHead"><h3>先定首季，再投入制作</h3></div><div className="bibleBody">
  <p>目标120–150分钟，135分钟作为规划中心。先轻量读全稿，再选择完整原集尾；后半部保留阅读导航，资产、分镜和图片仅制作锁定本季。</p>
  {state.mode==='legacy'?<><p>当前沿用全剧范围。新项目可在详细资产制作前启用分季；已有生产稿的项目需另建本季项目。</p><details><summary>另行启动续季（须上季实际closed记录）</summary><label>上季项目ID<input value={previousProjectId} onChange={e=>setPreviousProjectId(e.target.value)}/></label><label>上季closed记录ID<input value={previousClosedId} onChange={e=>setPreviousClosedId(e.target.value)}/></label><p>服务器核验上季实际采用末稿，从下一未制作原集接起；追加稿不自动跨源迁移。旧设计/图片复用须保留稳定ID与版本映射。</p></details><button className="studioButton" data-variant="secondary" disabled={pending||Boolean(previousProjectId)!==Boolean(previousClosedId)} onClick={()=>act('enable',previousClosedId?{previousProjectId,previousClosedId}:{})}>{pending?'保存中…':'本项目按首季目标规划'}</button></>:<>
   <p role="status">{state.status==='locked'?`已锁定：原集${state.scope.episodeNumbers.join('、')}；季终 ${state.scope.ending.sceneKey}`:state.status==='reading'?'正在轻量通读全稿，已保存回执会继续保留。':'本季尚未锁定，详细资产与分镜暂不派发。'}</p>
   {state.readProgress?<p>已读批次 {state.readProgress.completed} / {state.readProgress.total}</p>:null}<button className="quietButton" onClick={refresh}>刷新阅读状态（不发模型）</button>
   {state.blocker?<p>{state.blocker} <a href={`/projects/${encodeURIComponent(projectId)}/source`}>查看原文</a>。请先使用第一阶段整理入口完成P1；系统会在详细资产前等待选季。</p>:null}
   {state.sourceStale?<p role="alert">原文版本已变化，旧范围和候选保留；不能沿用旧范围生产。</p>:null}
   {state.status!=='locked'&&!state.blocker&&!state.sourceStale?<><label><input type="checkbox" checked={cost} disabled={pending} onChange={e=>setCost(e.target.checked)}/>明确发起轻量全读与季终选点。预计最多{state.estimatedCalls}次（阅读批次加1次选点），优先复用同源已返回回执；费用未知，不自动重试未知请求。</label><div className="workbenchActionGroup"><button className="studioButton" data-variant="primary" disabled={pending||!cost||state.status==='reading'} onClick={()=>act('generate',{costAcknowledged:true})}>{pending?'处理中…':'读取全稿并提出季终候选'}</button><button className="studioButton" data-variant="secondary" disabled={pending||state.status==='reading'} onClick={()=>act('recover')}>重验已返回结果（零模型）</button></div></>:null}
   {state.insufficientReason?<p>合适候选不足：{state.insufficientReason}</p>:null}
   {(state.candidates??[]).map((candidate:Row)=><article className="bibleSection" key={candidate.id}><h4>原集{candidate.ending.episode}尾 · {candidate.ending.sceneKey}</h4><p>估时{estimate(candidate.ending.timeline)}，属于计划估计；实际按采用分镜逐镜秒数校准。</p>{offTarget(candidate.ending.timeline)?<p role="alert">此候选与120–150分钟完全不相交，尚不能投入制作；需另选原生终点或明确新的范围裁决。</p>:null}<p>阶段回报：{candidate.ending.closure}</p><p>原生钩子：{candidate.ending.hook}</p><p>依据：{candidate.ending.sourceRefs.map((r:Row)=>`原集${r.episode}行${r.startLine}–${r.endLine}`).join('；')}</p><p>新增资产负担：{Object.entries(candidate.ending.assetBurden).map(([k,v])=>`${({characters:'人物',locations:'场景',costumes:'服装',forms:'形态',props:'道具'} as Row)[k]} ${Array.isArray(v)&&v.length?v.join('、'):'无'}`).join('；')}</p><details><summary>共同时间线估时依据</summary>{candidate.ending.timeline.map((t:Row,i:number)=><p key={i}>原集{t.episode}行{t.startLine}–{t.endLine}：{t.basis}</p>)}</details>{state.status==='proposed'?<button className="studioButton" data-variant="primary" disabled={pending||offTarget(candidate.ending.timeline)} onClick={()=>act('lock',{candidateId:candidate.id,confirmed:true})}>选定此原集尾并锁定本季</button>:null}</article>)}
   {state.scope?<p><a href={`/projects/${encodeURIComponent(projectId)}/season-scope/handoff`}>下载本季计划与续季对接</a>。后续须以实际采用末稿建立closed记录；另行启动下一季。</p>:null}
  </>}
  {error?<p className="roleRunError" role="alert">{error}</p>:null}
 </div></section>;
}
