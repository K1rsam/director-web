'use client';
import {useState} from 'react';
import {imageTemplatesFor,IMAGE_QUALITIES,IMAGE_RATIOS,type AssetImageOptions} from '@/lib/asset-image-options';
import type {PromptAsset} from '@/lib/asset-prompt-contract';
import styles from './workspace.module.css';
export function ImageOptionsPanel({asset,options,dirty,disabled=false,endpoint,onEdit,onSaved,onNotice}:{asset:PromptAsset;options:AssetImageOptions;dirty:boolean;disabled?:boolean;endpoint:string;onEdit:(next:AssetImageOptions)=>void;onSaved:(next:AssetImageOptions)=>void;onNotice:(text:string)=>void}){
 const [saving,setWorking]=useState(false);const working=saving||disabled;
 async function post(body:unknown){const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const next=await response.json();if(!response.ok)throw new Error(next.error);return next as AssetImageOptions;}
 async function persist(next:AssetImageOptions){setWorking(true);try{const saved=await post({action:'image-template',key:asset.key,revision:next.revision,templateId:next.templateId,templateText:next.templateText,count:next.count??1,quality:next.quality??'1K',aspectRatio:next.aspectRatio??'16:9'});onSaved(saved);onNotice('生图设置已保存。');}catch(e){onNotice((e as Error).message);}finally{setWorking(false);}}
  async function upload(files:FileList|null){if(!files?.length)return;setWorking(true);let current=options;try{for(const file of Array.from(files)){const form=new FormData();form.set('key',asset.key);form.set('revision',String(current.revision));form.set('file',file);const response=await fetch(endpoint,{method:'POST',body:form});const next=await response.json();if(!response.ok)throw new Error(next.error);current=next;onSaved(current);}onNotice('参考图已保存到此资产；新建网页生图任务时会保存参考图快照。');}catch(e){onNotice((e as Error).message);}finally{setWorking(false);}}
 async function remove(id:string){setWorking(true);try{onSaved(await post({action:'remove-reference',key:asset.key,revision:options.revision,id}));onNotice('已从此资产移除参考图。');}catch(e){onNotice((e as Error).message);}finally{setWorking(false);}}

 return <section className={styles.imageOptions} aria-label="图片设置">
  <div className={styles.optionRow}>
   <label>比例<select aria-label="图片比例" value={options.aspectRatio??'16:9'} disabled={working} onChange={e=>{const next={...options,aspectRatio:e.target.value as AssetImageOptions['aspectRatio']};onEdit(next);void persist(next);}}>{IMAGE_RATIOS.map(r=><option key={r} value={r}>{r==='auto'?'自适应':r}</option>)}</select></label>
   <label>画质<select aria-label="图片画质" value={options.quality??'1K'} disabled={working} onChange={e=>{const next={...options,quality:e.target.value as AssetImageOptions['quality']};onEdit(next);void persist(next);}}>{IMAGE_QUALITIES.map(q=><option key={q} value={q}>{q}</option>)}</select></label>
   <label>数量<select aria-label="生成数量" value={options.count??1} disabled={working} onChange={e=>{const next={...options,count:Number(e.target.value)};onEdit(next);void persist(next);}}>{[1,2,3,4].map(n=><option key={n} value={n} disabled={n!==1}>{n} 张{n!==1?' · 待接入':''}</option>)}</select></label>
  </div>
  <details><summary>参考图与视图模板 {options.references.length>0?`· ${options.references.length} 张参考`:''}{options.templateId!=='none'?' · 已选模板':''}</summary>
   <label>视图模板<select aria-label="视图模板" value={options.templateId} disabled={working} onChange={e=>{const template=imageTemplatesFor(asset.type).find(t=>t.id===e.target.value)!;const next={...options,templateId:template.id,templateText:template.text};onEdit(next);void persist(next);}}>{imageTemplatesFor(asset.type).map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
   {options.templateId!=='none'&&<label>模板追加内容<textarea aria-label="模板追加内容" rows={4} value={options.templateText} disabled={working} onChange={e=>onEdit({...options,templateText:e.target.value})}/></label>}
   {dirty&&<button disabled={working} onClick={()=>persist(options)}>保存设置修改</button>}
   <div className={styles.referenceHeading}><strong>参考图片</strong><span>{options.references.length} / 6</span></div>
   <div className={styles.referenceGrid}>{options.references.map(ref=><div key={ref.id} className={styles.referenceCard}><a href={`${endpoint}?key=${encodeURIComponent(asset.key)}&reference=${ref.id}`} target="_blank" rel="noreferrer"><img alt={ref.name} src={`${endpoint}?key=${encodeURIComponent(asset.key)}&reference=${ref.id}&view=reference-preview`}/></a><span title={ref.name}>{ref.name}</span><button disabled={working||dirty} onClick={()=>remove(ref.id)}>移除</button></div>)}</div>
   <label className={styles.uploadLabel}>上传参考图<input aria-label="上传参考图" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={working||dirty||options.references.length>=6} onChange={e=>{void upload(e.target.files);e.target.value='';}}/></label>
   <p className={styles.optionHint}>支持 PNG、JPEG、WebP，每张不超过 10 MB。参考图随新图片任务提交；派生形象会同时绑定已采用的来源图片。</p>
  </details>
 </section>;
}
