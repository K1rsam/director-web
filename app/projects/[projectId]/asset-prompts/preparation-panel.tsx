'use client';
import {useEffect,useRef,useState} from 'react';
import type {AssetPreparationReview} from '@/lib/episode-upstream-material';
import styles from './workspace.module.css';

export function AssetPreparationPanel({projectId,episodeNumbers}:{projectId:string;episodeNumbers:number[]}){
 const valid=episodeNumbers.length>0&&episodeNumbers.every(n=>Number.isSafeInteger(n)&&n>=0);
 const scopeKey=valid?[...new Set(episodeNumbers)].sort((a,b)=>a-b).join(','):'';
 const [state,setState]=useState<{scopeKey:string;review?:AssetPreparationReview;error?:string;loading?:boolean}>({scopeKey:''});
 const active=useRef<AbortController|null>(null);
 useEffect(()=>{active.current?.abort();setState({scopeKey});return()=>active.current?.abort();},[scopeKey,projectId]);
 async function readCards(){
  if(!scopeKey)return;
  active.current?.abort();const controller=new AbortController();active.current=controller;
  setState({scopeKey,loading:true});
  try{
   const response=await fetch(`/projects/${encodeURIComponent(projectId)}/asset-prompts/api?view=production-cards&episodes=${scopeKey}`,{cache:'no-store',signal:controller.signal}),review=await response.json();
   if(!response.ok)throw new Error(review.error??'文字生产卡暂未读取，请刷新后重试。');
   if(review.schema!=='ASSET_PREPARATION_REVIEW_V1'||review.projectId!==projectId||!Array.isArray(review.episodes)||review.episodes.map((e:{episodeNumber:number})=>e.episodeNumber).join(',')!==scopeKey)throw new Error('材料范围已变化，请重新查看；未展示错集生产卡。');
   if(!controller.signal.aborted)setState({scopeKey,review});
  }catch(error){if(!controller.signal.aborted)setState({scopeKey,error:(error as Error).message});}
 }
 const current=state.scopeKey===scopeKey?state:null;
 return <section className={styles.preparation} aria-label="第二阶段按需准备">
  <div className={styles.preparationHeading}><div><strong>按需准备 · 先用已有文字卡</strong><p>第三阶段自动读取本集原文、文字生产卡与已采用设计。仅在缺人物形象、道具功能或空间条件时补充；生图不是文字分镜的前置条件。</p></div>
   <button type="button" disabled={!valid||current?.loading} onClick={readCards}>{current?.loading?'正在读取文字卡':'查看本集文字生产卡'}</button></div>
  {current?.error&&<p role="alert">{current.error}</p>}
  {current?.review&&<div className={styles.preparationCards} aria-live="polite">
   <p className={styles.optionHint}>以下是实际交接的基础卡，不另调 AI、不生成摘要。特定任务的局部补料随任务记录提供；有原文依据不等于所有创作设计已经定稿。</p>
   {current.review.episodes.map(episode=><details key={episode.episodeNumber} open={current.review!.episodes.length===1}>
    <summary>第{episode.episodeNumber}集 · {episode.cards.length}张文字卡 · {episode.cards.filter(c=>c.adoptedDesign).length}项已采用设计</summary>
    {episode.reasons.length>0&&<p className={styles.warning}>资料提示：{episode.reasons.join('；')}</p>}
    {episode.directionStatus!=='CONFIRMED'&&<p className={styles.optionHint}>全剧方向{episode.directionStatus==='STALE'?'来源已变化，需核对':'尚未确认'}；候选不冒充已采用方向。</p>}
    {!episode.cards.length&&<p>当前没有关联资产卡；先核对第一阶段目录，不自动生成全库设计。</p>}
    {episode.cards.map(card=><details key={card.assetKey} className={styles.preparationCard}>
     <summary>{card.name} · {card.use==='MATERIAL_SOURCE_ONLY'?'仅供素材派生':card.adoptedDesign?'已有采用设计':'随本集原文使用'} · {card.sourceFacts.length}条原文依据</summary>
     <p className={styles.optionHint}>范围：第{card.applicable.episode}集{card.applicable.sceneKeys.length?` · ${card.applicable.sceneKeys.join('、')}`:''}。{card.materialAvailability==='REFERENCE_AVAILABLE'?'有参考说明，未读取图片像素。':'仅文字；缺图不阻断文字创作。'}</p>
     {card.sourceFacts.map(fact=><div key={fact.id}><small>{fact.claim==='CHARACTER_CLAIM'?'角色说法，不是世界规则':'原文事实'} · {fact.association==='SCENE_ACTION'?'场内空间与动作依据':fact.association==='VISUAL_FACT'?'原文外观依据':'资产关联依据'}</small><p className={styles.prose}>{fact.quote}</p></div>)}
     {!card.sourceFacts.length&&<p className={styles.optionHint}>没有已关联的本集原文引用；不据名称补造功能，需要时按原文坐标回查。</p>}
     {card.adoptedDesign&&<><strong>采用设计 · 版本{card.adoptedDesign.version??'未编号'}</strong><p className={styles.prose}>{card.adoptedDesign.brief}</p><small>设计选择，不冒充源文事实。</small></>}
     <p className={styles.prose}>开放设计边界：{card.freeDesignScope}</p>
    </details>)}
   </details>)}
  </div>}
 </section>;
}
