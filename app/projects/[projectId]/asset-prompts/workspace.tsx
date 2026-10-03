'use client';
import {AssetDesignAdoptionPanel} from './adoption-panel';
import {AssetPreparationPanel} from './preparation-panel';
import {useEffect,useRef,useState} from 'react';
import {emptyPrompt,promptNeedsReview,type PromptRecord,type PromptWorkspace} from '@/lib/asset-prompt-contract';
import {compileImagePrompt,emptyImageOptions,type AssetImageOptions} from '@/lib/asset-image-options';
import {mergePromptWorkspace,clearSavedPromptDraft} from '@/lib/asset-prompt-client-state';
import {planAssetPromptQueue} from '@/lib/asset-prompt-queue';
import {ImageOptionsPanel} from './image-options-panel';
import {AssetImageGenerationPanel} from './image-generation-panel';
import {useProjectImageJobs} from './use-image-jobs';
import type {AssetDesignAdoptionWorkspace} from '@/lib/asset-design-adoption';
import styles from './workspace.module.css';
const tabs=[['ALL','全部'],['CH','人物'],['LOC','场景'],['PROP','道具']] as const;
const typeNames={CH:'人物',GROUP:'群像',BEAST:'非人角色',LOC:'场景',PROP:'道具'};
export function AssetPromptWorkspace({initial,productionEpisodes}:{initial:PromptWorkspace;productionEpisodes?:number[]}) {
 const [data,setData]=useState(initial),[selected,setSelected]=useState(initial.assets[0]?.key??''),[tab,setTab]=useState('ALL'),[query,setQuery]=useState(''),[onlyQueue,setOnlyQueue]=useState(false);
 const [drafts,setDrafts]=useState<Record<string,string>>({}),[prefix,setPrefix]=useState(initial.stylePrefix),[notice,setNotice]=useState(''),[pending,setPending]=useState(false),[progress,setProgress]=useState('');
 const [optionDrafts,setOptionDrafts]=useState<Record<string,AssetImageOptions>>({});
 const [adoptions,setAdoptions]=useState<AssetDesignAdoptionWorkspace>();
 const [adoptionRefresh,setAdoptionRefresh]=useState(0);
 const imageReadVersion=JSON.stringify([adoptionRefresh,data.styleRevision,data.assets.map(a=>[a.key,a.fingerprint]),Object.values(data.records).map(r=>[r.key,r.revision]),data.imageOptions]);
 const imageState=useProjectImageJobs(data.projectId,imageReadVersion),imageJobs=imageState.jobs;
 const asset=data.assets.find(a=>a.key===selected),record=data.records[selected]??emptyPrompt(selected);
 const productionRange=(episodes:number[])=>episodes.filter(n=>Number.isSafeInteger(n)&&n>=1&&(!productionEpisodes||productionEpisodes.includes(n)));
 const selectedEpisodes=productionRange(asset?.episodes??[]);
 const validSelection=selectedEpisodes.length>0;
 const savedPrefix=useRef(data.stylePrefix);
 useEffect(()=>{const old=savedPrefix.current;setPrefix(value=>value===old?data.stylePrefix:value);savedPrefix.current=data.stylePrefix;},[data.stylePrefix]);
 const stop=useRef(false), latest=useRef(data);latest.current=data;
 const endpoint=`/projects/${data.projectId}/asset-prompts/api`;
 const scopedEndpoint=validSelection?`${endpoint}?episodes=${selectedEpisodes.join(',')}`:endpoint;
 const outOfScope=Boolean(asset&&!validSelection);
 const body=drafts[selected]??record.body, dirty=body!==record.body, styleDirty=prefix!==data.stylePrefix;
 const needsReview=asset?promptNeedsReview(asset,data.records,data.assets):false;
 const options=optionDrafts[selected]??data.imageOptions?.[selected]??emptyImageOptions();
 const optionDirty=Boolean(optionDrafts[selected]);
 const fullPrompt=compileImagePrompt(prefix,body,options);
 const factsStatus=data.visualFactsStatus??'MISSING';
 const factsRunning=data.automation?.mode==='FACTS'&&data.automation.status==='RUNNING';
 const selectedFactIssues=(asset?.visualIssues??(data.visualFactIssues??[]).filter(issue=>!issue.subjectKey||issue.subjectKey===selected||issue.subjectKey===asset?.baseKey)).filter(issue=>issue.blocking!==false);
 const directoryNotes=(data.visualFactIssues??[]).filter(issue=>issue.blocking===false&&issue.subjectKey===asset?.baseKey);
 function acceptOptions(key:string,next:AssetImageOptions){setData(d=>mergePromptWorkspace(d,{...d,imageOptions:{...d.imageOptions,[key]:next}}));setOptionDrafts(d=>{const n={...d},draft=n[key];if(!draft)return n;const same=draft.templateId===next.templateId&&draft.templateText===next.templateText&&(draft.quality??'1K')===(next.quality??'1K')&&(draft.aspectRatio??'16:9')===(next.aspectRatio??'16:9')&&(draft.count??1)===(next.count??1);if(same)delete n[key];else n[key]={...draft,revision:Math.max(draft.revision,next.revision),references:next.references};return n;});}
 const scopedAssets=data.assets;
 const filtered=scopedAssets.filter(a=>(tab==='ALL'||(tab==='CH'?['CH','GROUP','BEAST'].includes(a.type):a.type===tab))&&(!onlyQueue||a.eligible)&&`${a.baseName} ${a.name}`.includes(query.trim()));
 const ready=scopedAssets.filter(a=>data.records[a.key]?.body).length;
 async function call(payload:unknown){const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok)throw new Error(result.error||'请求失败');return result;}
 function accept(key:string,result:PromptRecord){latest.current={...latest.current,records:{...latest.current.records,[key]:result}};setData(d=>mergePromptWorkspace(d,latest.current));}
 useEffect(()=>{if(data.automation?.status!=='RUNNING'&&!(data.automation?.status==='STOPPED'&&data.automation.workerPid)&&!Object.values(data.records).some(r=>r.status==='RUNNING'))return;let cancelled=false,inFlight=false;const id=setInterval(async()=>{if(inFlight)return;inFlight=true;try{const r=await fetch(scopedEndpoint);if(r.ok){const next:PromptWorkspace=await r.json();if(!cancelled)setData(d=>mergePromptWorkspace(d,next));}}catch{}finally{inFlight=false;}},4000);return()=>{cancelled=true;clearInterval(id);};},[data.records,data.automation?.status,data.automation?.workerPid,scopedEndpoint]);
 useEffect(()=>{const handler=(e:BeforeUnloadEvent)=>{if(Object.keys(drafts).some(k=>drafts[k]!== (latest.current.records[k]?.body??''))||styleDirty||Object.keys(optionDrafts).length){e.preventDefault();}};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[drafts,styleDirty,optionDrafts]);
 async function save(){if(!asset||outOfScope)return;setPending(true);try{const result=await call({action:'save',key:selected,body,revision:record.revision});accept(selected,result);setDrafts(d=>clearSavedPromptDraft(d,selected,body));setNotice('此资产的提示词已保存。');}catch(e){setNotice((e as Error).message);}finally{setPending(false);}}
 async function saveStyle(){setPending(true);try{const result=await call({action:'style',prefix,revision:data.styleRevision});setData(d=>({...d,stylePrefix:result.prefix,styleRevision:result.revision}));setNotice('项目通用画风已保存，所有资产的完整提示词已同步更新。');}catch(e){setNotice((e as Error).message);}finally{setPending(false);}}
 async function prepareFacts(){if(!validSelection)throw new Error('此资产尚无有效的原文出场范围，请先完善第一阶段资料。');const next:PromptWorkspace=await call({action:'prepare-facts',revision:0,episodeNumbers:selectedEpisodes});latest.current=mergePromptWorkspace(latest.current,next);setData(latest.current);setNotice(`已开始整理第${selectedEpisodes.join('、')}集所需事实与材料依赖；不扫描生产全剧资产，不自动生成美术提示词。`);}
 async function requestFacts(){setPending(true);try{await prepareFacts();}catch(e){setNotice((e as Error).message);}finally{setPending(false);}}
 async function generate(keys:string[]){setPending(true);stop.current=false;setNotice('');let done=0,failed=0,lastError="";try{keys=keys.filter(key=>productionRange(data.assets.find(a=>a.key===key)?.episodes??[]).length>0);const generationEpisodes=[...new Set(keys.flatMap(key=>productionRange(data.assets.find(a=>a.key===key)?.episodes??[])))];if(!generationEpisodes.length)throw new Error('所选资产尚无有效的原文出场范围。');const response=await fetch(endpoint+'?episodes='+generationEpisodes.join(','));if(!response.ok)throw new Error("无法读取所选集的最新资料，请核对范围。");const fresh:PromptWorkspace=await response.json();latest.current=mergePromptWorkspace(latest.current,fresh);setData(latest.current);keys=keys.filter(key=>latest.current.assets.find(a=>a.key===key)?.episodes.some(n=>generationEpisodes.includes(n)));if(!keys.length)throw new Error('所选资产的出场范围已变化，请刷新后核对。');if((latest.current.visualFactsStatus??'MISSING')==='MISSING'){const next:PromptWorkspace=await call({action:'prepare-facts',revision:0,episodeNumbers:generationEpisodes});latest.current=mergePromptWorkspace(latest.current,next);setData(latest.current);setNotice('正在核对所选资产的原文依据，完成后可生成提示词。');return;}if(latest.current.automation?.mode==='FACTS'&&latest.current.automation.status==='RUNNING'){setNotice('所选集的剧本事实正在整理，完成后请再点击生成提示词。');return;}keys=planAssetPromptQueue(latest.current,keys,Object.keys(drafts).filter(k=>drafts[k]!==(fresh.records[k]?.body??'')));for(const key of keys){if(stop.current)break;const current=latest.current.records[key]??emptyPrompt(key);setProgress(`正在生成 ${done+failed+1} / ${keys.length} · ${latest.current.assets.find(a=>a.key===key)?.name}`);try{const result=await call({action:'generate',key,revision:current.revision,episodeNumbers:generationEpisodes});accept(key,result);if(result.status==='READY')done++;else{failed++;lastError=result.error;setNotice(result.error);}}catch(e){failed++;lastError=(e as Error).message;setNotice(lastError);}}setNotice(`本轮完成 ${done} 项${failed?`，${failed} 项未完成，已保留其他结果`:''}${stop.current?'；后续队列已停止':''}。${lastError?`最近错误：${lastError}`:''}`);}catch(e){setNotice((e as Error).message);}finally{setPending(false);setProgress('');}}
 async function copy(){try{await navigator.clipboard.writeText(fullPrompt);setNotice('完整提示词已复制，包含当前视图模板。');}catch{setNotice('复制失败，请在下方完整提示词中手动选择复制。');}}
 async function recover(){setPending(true);try{const result=await call({action:'recover',key:selected,revision:record.revision});accept(selected,result);setNotice(result.error);}catch(e){setNotice((e as Error).message);}finally{setPending(false);}}
 async function refreshImageMaterials(){const response=await fetch(scopedEndpoint,{cache:'no-store'});const result=await response.json();if(!response.ok)throw new Error(result.error||'参考图已保存，但工作区刷新未完成，请刷新后核对。');latest.current=mergePromptWorkspace(latest.current,result);setData(d=>mergePromptWorkspace(d,result));setAdoptionRefresh(value=>value+1);}
 function download(){const exported={format:'ASSET_IMAGE_PROMPTS_V1',project:data.title,stylePrefix:data.stylePrefix,assets:data.assets.map(a=>({key:a.key,baseKey:a.baseKey,name:a.name,type:a.type,episodes:a.episodes,mode:a.mode,prompt:compileImagePrompt(data.stylePrefix,data.records[a.key]?.body??'',data.imageOptions?.[a.key]??emptyImageOptions()),imageOptions:data.imageOptions?.[a.key]??emptyImageOptions(),facts:data.records[a.key]?.facts??'',suggestions:data.records[a.key]?.suggestions??'',status:data.records[a.key]?.status??'EMPTY',sourceChanged:promptNeedsReview(a,data.records,data.assets)}))};const url=URL.createObjectURL(new Blob([JSON.stringify(exported,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`${data.title}-资产生图提示词.json`;link.click();URL.revokeObjectURL(url);setNotice('已导出保存过的提示词，未保存的编辑不包含在内。');}
 const missing=filtered.filter(a=>a.eligible&&productionRange(a.episodes).length>0&&!data.records[a.key]?.body&&data.records[a.key]?.status!=='RUNNING'&&(drafts[a.key]===undefined||drafts[a.key]===(data.records[a.key]?.body??''))).sort((a,b)=>Number(a.variant)-Number(b.variant)).map(a=>a.key);

 return <div className={styles.workspace}>
  <div className={styles.workspaceBar}>
   <nav className={styles.steps} aria-label="制作阶段"><a href={`/projects/${data.projectId}/preparation`}>第一阶段 · 剧本与方向</a><strong>第二阶段 · 资产形象</strong><a href={`/projects/${data.projectId}/production`}>第三阶段 · 连续制作</a></nav>
   <details className={styles.projectTools}><summary>项目画风与资料</summary><div className={styles.projectToolsBody}>
    <strong>全剧方向 · {data.seriesDirection?.status==='CONFIRMED'?'已定稿':data.seriesDirection?.status==='STALE'?'来源需核对':'尚未定稿'}</strong><p className={styles.prose}>{data.seriesDirection?.brief??'可以先设计资产形象。'}</p><a href={`/projects/${data.projectId}/preparation#series-direction`}>查看全剧方向</a>
    <label className={styles.bodyLabel}>项目通用画风<textarea aria-label="项目通用画风" rows={3} value={prefix} onChange={e=>setPrefix(e.target.value)}/></label><button disabled={!styleDirty||pending} onClick={saveStyle}>保存项目画风</button>
    <AssetPreparationPanel projectId={data.projectId} episodeNumbers={selectedEpisodes}/>
    <div className={styles.actions}><button disabled={!validSelection||pending||data.busy||factsRunning} onClick={requestFacts}>{factsRunning?'整理依据中…':'核对所选资产的原文依据'}</button></div>
   </div></details>
  </div>
  {(progress||notice||data.busy)&&<div role="status" className={styles.notice}>{progress||notice||'资料正在整理，可浏览已保存内容。'}<button aria-label="关闭提示" onClick={()=>setNotice('')}>×</button></div>}
  {data.automation&&['RUNNING','FAILED','STOPPED'].includes(data.automation.status)&&<div className={styles.batch} role="status"><span>{data.automation.mode==='FACTS'?'整理原文依据':'生成资产提示词'} · {data.automation.done} / {data.automation.total}{data.automation.error?` · ${data.automation.error}`:''}</span>{data.automation.status==='RUNNING'?<button onClick={async()=>{try{setData(await call({action:'stop-automation',revision:0}));}catch(e){setNotice((e as Error).message);}}}>停止后续任务</button>:<button disabled={data.busy} onClick={async()=>{try{setData(await call({action:'resume-automation',revision:0}));}catch(e){setNotice((e as Error).message);}}}>继续未完成项</button>}</div>}
  <div className={styles.layout}>
   <section className={styles.library} aria-label="资产设定库">
    <div className={styles.toolbar}><div className={styles.libraryIdentity}><h3>资产设定库 <small>{scopedAssets.length} 项 · {ready} 项已有提示词</small></h3></div><div className={styles.toolbarActions}>
     {pending&&progress?<button className="studioButton" data-variant="caution" onClick={()=>{stop.current=true;setNotice('当前请求完成后停止后续队列。');}}>停止后续队列</button>:<details className={styles.batchActions}><summary>批量补提示词</summary><button disabled={pending||!missing.length||data.busy||styleDirty||factsRunning} onClick={()=>generate(missing)}>补充当前筛选中 {missing.length} 项</button></details>}<button onClick={download}>导出</button>
    </div></div>
    <div className={styles.compactTools}><div className={styles.tabs}>{tabs.map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label} <small>{scopedAssets.filter(a=>id==='ALL'||(id==='CH'?['CH','GROUP','BEAST'].includes(a.type):a.type===id)).length}</small></button>)}</div><div className={styles.filters}><input aria-label="搜索资产" placeholder="搜索资产名称" value={query} onChange={e=>setQuery(e.target.value)}/><label title="只显示需要单独设计图片的资产"><input type="checkbox" checked={onlyQueue} onChange={e=>setOnlyQueue(e.target.checked)}/>制图资产</label></div></div>
    <div className={styles.grid}>{filtered.map(a=>{const r=data.records[a.key],adoption=adoptions?.assets[a.key],reference=data.imageOptions?.[a.key]?.references[0];const candidate=imageJobs.find(j=>j.key===a.key&&j.status==='REVIEW'&&!j.stale&&j.images.length&&!j.usedImageIds.includes(j.images[0].id));const active=imageJobs.find(j=>j.key===a.key&&['WAITING_EXECUTOR','RUNNING'].includes(j.status));const src=candidate?`/projects/${data.projectId}/asset-prompts/images?jobId=${candidate.id}&imageId=${candidate.images[0].id}&view=preview`:reference?`${endpoint}?key=${encodeURIComponent(a.key)}&reference=${encodeURIComponent(reference.id)}&view=reference-preview`:null;const label=a.variant?`${a.baseName} · ${a.name}`:a.name;const status=active?(active.status==='RUNNING'?'生图中':'等待执行'):src?(candidate?'候选待选择':'已有参考图'):r?.body?'已有提示词':'未生成';return <button key={a.key} className={`${styles.card} ${a.key===selected?styles.selected:''}`} aria-label={`资产 · ${label} · ${status}`} aria-pressed={a.key===selected} onClick={()=>setSelected(a.key)}>
     <div className={styles.cardVisual}>{src?<img className={styles.cardReference} alt={label} loading="lazy" src={src}/>:<div className={styles.imagePlaceholder}><svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/></svg><span>{active?'正在准备图片':'待生成形象'}</span></div>}<small className={styles.cardKind}>{typeNames[a.type]}{a.variant?' · 子形象':''}</small></div>
     <div className={styles.cardText}><strong title={label}>{label}</strong><span>{drafts[a.key]!==undefined&&drafts[a.key]!==(r?.body??'')?'有未保存编辑':status}<small>{adoption?.status==='REFERENCE_ADOPTED'||adoption?.status==='TEXT_ADOPTED'?' · 已采用':adoption?.status==='STALE'?' · 采用待核对':''}</small></span></div>
    </button>;})}</div>
    {!filtered.length&&<div className={styles.empty}>{data.assets.length?'没有匹配的资产。':'第一阶段还没有资产目录。请先完成素材提取。'}</div>}
    <footer className={styles.libraryFooter}>选择资产，编辑提示词后生成图片。候选图片经你选择后才会用于后续制作。</footer>
   </section>
   <aside className={styles.editor} aria-label="资产提示词编辑器">
    <div className={styles.editorTitle}><small>{asset?typeNames[asset.type]:'资产形象设计'}{asset?.variant?' · 子形象':''}</small><h3>{asset?(asset.variant?`${asset.baseName} · ${asset.name}`:asset.name):'选择一个资产'}</h3></div>
    <div className={styles.editorScroll} tabIndex={0} role="region" aria-label="资产设计，可滚动">
    {asset?<>
     <label className={styles.bodyLabel}>提示词 <small>{body.length} 字 {dirty?'· 未保存':''}</small><textarea aria-label="资产外观提示词" placeholder="描述资产形象，或生成初版提示词。" value={body} onChange={e=>setDrafts(d=>({...d,[selected]:e.target.value}))}/></label>
     <div className={styles.actions}><button disabled={pending||outOfScope||record.status==='RUNNING'||(!dirty&&!needsReview)} onClick={save}>{needsReview?'保存并确认':'保存提示词'}</button><button disabled={!validSelection||pending||outOfScope||data.busy||!asset.eligible||dirty||styleDirty||factsRunning||record.status==='RUNNING'} onClick={()=>generate([selected])}>{record.body?'重写初版':'生成初版'}</button><button disabled={!body.trim()} onClick={copy}>复制</button></div>
     <ImageOptionsPanel key={`options-${selected}`} asset={asset} options={options} dirty={optionDirty} disabled={outOfScope||pending} endpoint={endpoint} onEdit={next=>setOptionDrafts(d=>({...d,[selected]:next}))} onSaved={next=>acceptOptions(selected,next)} onNotice={setNotice}/>
     <AssetImageGenerationPanel key={`images-${selected}`} workspace={data} assetKey={selected} episodeNumbers={selectedEpisodes} jobs={imageJobs.filter(j=>j.key===selected)} jobsLoading={imageState.loading} jobsError={imageState.error} refreshJobs={imageState.refresh} disabled={pending||outOfScope||dirty||styleDirty||optionDirty} onChanged={refreshImageMaterials}/>
     {Boolean(outOfScope||asset.reasons.length||!asset.eligible||needsReview||selectedFactIssues.length)&&<details className={styles.assetAttention}><summary>此资产有待核对资料</summary>     {outOfScope&&<p className={styles.warning}>此资产尚无可制作的原文出场范围，请先完善第一阶段资料。</p>}
     {asset.reasons.length>0&&<p className={styles.warning}>{asset.reasons.join('；')}</p>}
     {!asset.eligible&&!asset.reasons.length&&<p className={styles.warning}>该项随场生成，无需独立制图。</p>}
     {needsReview&&<p className={styles.warning}>来源或基础形象已更新，请复核提示词并保存确认。</p>}
     {selectedFactIssues.length>0&&<div className={styles.warning}><strong>原文依据待核对</strong>{selectedFactIssues.map((issue,index)=><p key={index}>{issue.message}</p>)}</div>}
</details>}
     <details><summary>设计采用与历史</summary><AssetDesignAdoptionPanel key={`${selected}-${adoptionRefresh}`} projectId={data.projectId} assetKey={selected} workspace={data} disabled={pending||outOfScope||dirty||styleDirty||optionDirty} onStateChange={setAdoptions}/></details>
     <details><summary>完整提示词 · 含项目画风和视图模板</summary><label className={styles.fullPrompt}><textarea aria-label="完整生图提示词" readOnly rows={8} value={fullPrompt}/></label></details>
     {record.status==='RUNNING'&&!pending&&<button onClick={recover}>检查提示词执行状态</button>}
     {record.error&&<p className={styles.warning}>{record.error}</p>}
     <details><summary>原文依据与设计补足</summary>{directoryNotes.map((issue,i)=><p key={i} className={styles.optionHint}>{issue.message}</p>)}<p className={styles.prose}>{record.facts||'暂无已保存的提示词依据。'}</p><h4>设计补足／待确认</h4><p className={styles.prose}>{record.suggestions||'暂无记录。'}</p>{asset.evidence.map((e,i)=><div key={i}><small>{e.label}</small><p className={styles.prose}>{e.text}</p></div>)}</details>
     {Boolean(record.previousDesignAudit?.length)&&<details><summary>提示词修改历史</summary>{record.previousDesignAudit!.map((old,i)=><details key={i}><summary>版本 {old.revision}</summary><p className={styles.prose}>{old.body}</p><p className={styles.prose}>{[old.facts,old.suggestions].filter(Boolean).join('\n')}</p></details>)}</details>}
     {record.rawOutput&&record.status==='FAILED'&&<details><summary>保留的生成结果</summary><pre className={styles.prose}>{record.rawOutput}</pre></details>}
    </>:<div className={styles.empty}>从左侧选择一个资产。</div>}
    </div>
   </aside>
  </div>
 </div>;
}
