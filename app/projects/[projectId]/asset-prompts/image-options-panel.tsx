'use client';
import {useState} from 'react';
import {imageTemplatesFor,IMAGE_QUALITIES,IMAGE_RATIOS,type AssetImageOptions} from '@/lib/asset-image-options';
import type {PromptAsset} from '@/lib/asset-prompt-contract';
import styles from './workspace.module.css';
export function ImageOptionsPanel({asset,options,dirty,disabled=false,endpoint,onEdit,onSaved,onNotice}:{asset:PromptAsset;options:AssetImageOptions;dirty:boolean;disabled?:boolean;endpoint:string;onEdit:(next:AssetImageOptions)=>void;onSaved:(next:AssetImageOptions)=>void;onNotice:(text:string)=>void}){
 const [saving,setWorking]=useState(false);const working=saving||disabled;
 async function post(body:unknown){const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const next=await response.json();if(!response.ok)throw new Error(next.error);return next as AssetImageOptions;}
 async function persist(next:AssetImageOptions){setWorking(true);try{const saved=await post({action:'image-template',key:asset.key,revision:next.revision,templateId:next.templateId,templateText:next.templateText,count:next.count??1,quality:next.quality??'1K',aspectRatio:next.aspectRatio??'16:9'});onSaved(saved);onNotice('生图设置已保存。');}catch(e){onNotice((e as Error).message);}finally{setWorking(false);}}
 async function upload(files:FileList|null){if(!files?.length)return;setWorking(true);let current=options;try{for(const file of Array.from(files)){const form=new FormData();form.set('key',asset.key);form.set('revision',String(current.revision));form.set('file',file);const response=await fetch(endpoint,{method:'POST',body:form});const next=await response.json();if(!response.ok)throw new Error(next.error);current=next;onSaved(current);}onNotice('参考图已保存到此资产；图片API接入后可随提示词提交。');}catch(e){onNotice((e as Error).message);}finally{setWorking(false);}}
 async function remove(id:string){setWorking(true);try{onSaved(await post({action:'remove-reference',key:asset.key,revision:options.revision,id}));onNotice('已从此资产移除参考图。');}catch(e){onNotice((e as Error).message);}finally{setWorking(false);}}
 return <section className={styles.imageOptions} aria-label="视图模板与参考图">
  <label>视图模板<select aria-label="视图模板" value={options.templateId} disabled={working} onChange={e=>{const template=imageTemplatesFor(asset.type).find(t=>t.id===e.target.value)!;const next={...options,templateId:template.id,templateText:template.text};onEdit(next);void persist(next);}}>{imageTemplatesFor(asset.type).map(t=><option key={t.id} value={t.id}>{t.label}</option>)}</select></label>
  {options.templateId!=='none'&&<label>模板追加内容<textarea aria-label="模板追加内容" rows={5} value={options.templateText} disabled={working} onChange={e=>onEdit({...options,templateText:e.target.value})}/></label>}
  {dirty&&<button disabled={working} onClick={()=>persist(options)}>保存设置修改</button>}
  <p className={styles.optionHint}>选择后自动追加到下方完整提示词；切换会替换这一段，选“无”会移除。模板不改写资产外观正文。</p>
  <div className={styles.referenceHeading}><strong>参考图片</strong><span>{options.references.length} / 6</span></div>
  <div className={styles.referenceGrid}>{options.references.map(ref=><div key={ref.id} className={styles.referenceCard}><a href={`${endpoint}?key=${encodeURIComponent(asset.key)}&reference=${ref.id}`} target="_blank" rel="noreferrer"><img alt={ref.name} src={`${endpoint}?key=${encodeURIComponent(asset.key)}&reference=${ref.id}`}/></a><span title={ref.name}>{ref.name}</span><button disabled={working||dirty} onClick={()=>remove(ref.id)}>移除</button></div>)}</div>
  <label className={styles.uploadLabel}>上传参考图<input aria-label="上传参考图" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={working||dirty||options.references.length>=6} onChange={e=>{void upload(e.target.files);e.target.value='';}}/></label>
  <p className={styles.optionHint}>{dirty?'请先保存模板修改，再上传或移除图片。':'支持PNG、JPEG、WebP，单张不超过10 MB；上传后按资产分别保存。'}参考图目前不参与文字提示词生成。</p>
  <details><summary>外部图片参数 · 尚未接入生成接口</summary>
  <fieldset className={styles.imageParameters} disabled={working}><legend>画质</legend><div className={styles.qualityChoices}>{IMAGE_QUALITIES.map(quality=><button type="button" key={quality} aria-pressed={(options.quality??'1K')===quality} onClick={()=>{const next={...options,quality};onEdit(next);void persist(next);}}>{quality}</button>)}</div></fieldset>
  <fieldset className={styles.imageParameters} disabled={working}><legend>比例</legend><div className={styles.ratioChoices}>{IMAGE_RATIOS.map(aspectRatio=>{const [w,h]=aspectRatio==='auto'?[1,1]:aspectRatio.split(':').map(Number);return <button type="button" key={aspectRatio} aria-label={`比例：${aspectRatio==='auto'?'自适应':aspectRatio}`} aria-pressed={(options.aspectRatio??'16:9')===aspectRatio} onClick={()=>{const next={...options,aspectRatio};onEdit(next);void persist(next);}}><span className={styles.ratioIcon} style={{width:24*w/Math.max(w,h),height:24*h/Math.max(w,h)}} aria-hidden="true"/>{aspectRatio==='auto'?'自适应':aspectRatio}</button>;})}</div></fieldset>
  <p className={styles.optionHint}>当前：{options.quality??'1K'} · {(options.aspectRatio??'16:9')==='auto'?'自适应':options.aspectRatio??'16:9'}。选择后自动保存到当前资产；自适应由后续图片接口决定。可用画质和比例以接入模型的支持范围为准。</p>
  <label>生成数量<select aria-label="生成数量" value={options.count??1} disabled={working} onChange={e=>{const next={...options,count:Number(e.target.value)};onEdit(next);void persist(next);}}>{[1,2,3,4].map(n=><option key={n} value={n}>{n} 张</option>)}</select></label>
  </details>
 </section>;
}
