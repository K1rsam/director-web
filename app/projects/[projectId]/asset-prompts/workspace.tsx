'use client';
import {useEffect,useRef,useState} from 'react';
import {emptyPrompt,promptNeedsReview,type PromptRecord,type PromptWorkspace} from '@/lib/asset-prompt-contract';
import {compileImagePrompt,emptyImageOptions,type AssetImageOptions} from '@/lib/asset-image-options';
import {planAssetPromptQueue} from '@/lib/asset-prompt-queue';
import {ImageOptionsPanel} from './image-options-panel';
import styles from './workspace.module.css';
const tabs=[['ALL','全部'],['CH','人物'],['LOC','场景'],['PROP','道具']] as const;
const typeNames={CH:'人物',GROUP:'群像',BEAST:'非人角色',LOC:'场景',PROP:'道具'};
export function AssetPromptWorkspace({initial}:{initial:PromptWorkspace}) {
 const [data,setData]=useState(initial),[selected,setSelected]=useState(initial.assets[0]?.key??''),[tab,setTab]=useState('ALL'),[query,setQuery]=useState(''),[onlyQueue,setOnlyQueue]=useState(false);
 const [drafts,setDrafts]=useState<Record<string,string>>({}),[prefix,setPrefix]=useState(initial.stylePrefix),[notice,setNotice]=useState(''),[pending,setPending]=useState(false),[progress,setProgress]=useState('');
 const [optionDrafts,setOptionDrafts]=useState<Record<string,AssetImageOptions>>({});
 const stop=useRef(false), latest=useRef(data);latest.current=data;
 const endpoint=`/projects/${data.projectId}/asset-prompts/api`;
 const asset=data.assets.find(a=>a.key===selected),record=data.records[selected]??emptyPrompt(selected);
 const body=drafts[selected]??record.body, dirty=body!==record.body, styleDirty=prefix!==data.stylePrefix;
 const needsReview=asset?promptNeedsReview(asset,data.records,data.assets):false;
 const options=optionDrafts[selected]??data.imageOptions?.[selected]??emptyImageOptions();
 const optionDirty=Boolean(optionDrafts[selected]);
 const fullPrompt=compileImagePrompt(prefix,body,options);
 function acceptOptions(key:string,next:AssetImageOptions){setData(d=>({...d,imageOptions:{...d.imageOptions,[key]:next}}));setOptionDrafts(d=>{const n={...d};delete n[key];return n;});}
 const filtered=data.assets.filter(a=>(tab==='ALL'||(tab==='CH'?['CH','GROUP','BEAST'].includes(a.type):a.type===tab))&&(!onlyQueue||a.eligible)&&`${a.baseName} ${a.name}`.includes(query.trim()));
 const ready=data.assets.filter(a=>data.records[a.key]?.body).length;
 async function call(payload:unknown){const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok)throw new Error(result.error||'请求失败');return result;}
 function accept(key:string,result:PromptRecord){setData(d=>({...d,records:{...d.records,[key]:result}}));}
 useEffect(()=>{if(data.automation?.status!=='RUNNING'&&!Object.values(data.records).some(r=>r.status==='RUNNING'))return;const id=setInterval(async()=>{try{const r=await fetch(endpoint);if(r.ok){const next:PromptWorkspace=await r.json();setData(next);}}catch{}},4000);return()=>clearInterval(id);},[data.records,data.automation?.status,endpoint]);
 useEffect(()=>{const handler=(e:BeforeUnloadEvent)=>{if(Object.keys(drafts).some(k=>drafts[k]!==latest.current.records[k]?.body)||styleDirty||Object.keys(optionDrafts).length){e.preventDefault();}};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[drafts,styleDirty,optionDrafts]);
 async function save(){if(!asset)return;setPending(true);try{const result=await call({action:'save',key:selected,body,revision:record.revision});accept(selected,result);setDrafts(d=>{const n={...d};delete n[selected];return n;});setNotice('此资产的提示词已保存。');}catch(e){setNotice((e as Error).message);}finally{setPending(false);}}
 async function saveStyle(){setPending(true);try{const result=await call({action:'style',prefix,revision:data.styleRevision});setData(d=>({...d,stylePrefix:result.prefix,styleRevision:result.revision}));setNotice('项目通用画风已保存，所有资产的完整提示词已同步更新。');}catch(e){setNotice((e as Error).message);}finally{setPending(false);}}
 async function generate(keys:string[]){setPending(true);stop.current=false;setNotice('');let done=0,failed=0,lastError="";try{const response=await fetch(endpoint);if(!response.ok)throw new Error("无法读取最新资产，请刷新后重试。");const fresh:PromptWorkspace=await response.json();latest.current=fresh;setData(fresh);keys=planAssetPromptQueue(fresh,keys,Object.keys(drafts).filter(k=>drafts[k]!==fresh.records[k]?.body));for(const key of keys){if(stop.current)break;const current=latest.current.records[key]??emptyPrompt(key);setProgress(`正在生成 ${done+failed+1} / ${keys.length} · ${latest.current.assets.find(a=>a.key===key)?.name}`);try{const result=await call({action:'generate',key,revision:current.revision});accept(key,result);if(result.status==='READY')done++;else{failed++;lastError=result.error;setNotice(result.error);}}catch(e){failed++;lastError=(e as Error).message;setNotice(lastError);}}setNotice(`本轮完成 ${done} 项${failed?`，${failed} 项未完成，已保留其他结果`:''}${stop.current?'；后续队列已停止':''}。${lastError?`最近错误：${lastError}`:''}`);}catch(e){setNotice((e as Error).message);}finally{setPending(false);setProgress('');}}
 async function copy(){try{await navigator.clipboard.writeText(fullPrompt);setNotice('完整提示词已复制，包含当前视图模板。');}catch{setNotice('复制失败，请在下方完整提示词中手动选择复制。');}}
 async function recover(){setPending(true);try{const result=await call({action:'recover',key:selected,revision:record.revision});accept(selected,result);setNotice(result.error);}catch(e){setNotice((e as Error).message);}finally{setPending(false);}}
 function download(){const exported={format:'ASSET_IMAGE_PROMPTS_V1',project:data.title,stylePrefix:data.stylePrefix,assets:data.assets.map(a=>({key:a.key,baseKey:a.baseKey,name:a.name,type:a.type,episodes:a.episodes,mode:a.mode,prompt:compileImagePrompt(data.stylePrefix,data.records[a.key]?.body??'',data.imageOptions?.[a.key]??emptyImageOptions()),imageOptions:data.imageOptions?.[a.key]??emptyImageOptions(),facts:data.records[a.key]?.facts??'',suggestions:data.records[a.key]?.suggestions??'',status:data.records[a.key]?.status??'EMPTY',sourceChanged:promptNeedsReview(a,data.records,data.assets)}))};const url=URL.createObjectURL(new Blob([JSON.stringify(exported,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`${data.title}-资产生图提示词.json`;link.click();URL.revokeObjectURL(url);setNotice('已导出保存过的提示词，未保存的编辑不包含在内。');}
 const missing=filtered.filter(a=>a.eligible&&!data.records[a.key]?.body&&data.records[a.key]?.status!=='RUNNING'&&drafts[a.key]===undefined).sort((a,b)=>Number(a.variant)-Number(b.variant)).map(a=>a.key);
 return <div className={styles.workspace}>
  <nav className={styles.steps} aria-label="制作阶段"><a href={`/projects/${data.projectId}`}>01 · 剧本与资产目录</a><strong>1.5 · 资产形象设计</strong><a href={`/projects/${data.projectId}/foundation/handoff`}>02 · 分镜交接资料 →</a></nav>
  {(progress||notice||data.busy)&&<div role="status" className={styles.notice}>{progress||notice||"第一阶段正在整理，可浏览已保存内容。"}</div>}
  {data.automation&&<div className={styles.batch} role="status"><span>自动准备人物提示词：{({RUNNING:'进行中',COMPLETE:'已完成',STOPPED:'已停止',FAILED:'部分未完成'})[data.automation.status]} · 完成 {data.automation.done} / {data.automation.total}{data.automation.error?` · ${data.automation.error}`:''}</span>{data.automation.status==='RUNNING'&&<button onClick={async()=>{try{setData(await call({action:'stop-automation',revision:0}));}catch(e){setNotice((e as Error).message);}}}>停止后续任务</button>}{["FAILED","STOPPED"].includes(data.automation.status)&&<button disabled={data.busy} onClick={async()=>{try{setData(await call({action:"resume-automation",revision:0}));}catch(e){setNotice((e as Error).message);}}}>继续未完成项</button>}</div>}
  <div className={styles.layout}>
   <section className={styles.library} aria-label="资产设定库">
    <div className={styles.toolbar}><div className={styles.libraryIdentity}><h3>资产设定库</h3><small>{ready} / {data.assets.length} 项已有提示词</small></div><div className={styles.toolbarActions}>{pending&&progress?<button onClick={()=>{stop.current=true;setNotice('当前请求完成后停止后续队列。');}}>停止后续队列</button>:<button disabled={pending||!missing.length||data.busy||styleDirty} onClick={()=>generate(missing)}>补齐提示词 · {missing.length}</button>}<button onClick={download}>导出</button></div></div>
    <div className={styles.compactTools}>
    <div className={styles.tabs}>{tabs.map(([id,label])=><button key={id} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label} <small>{data.assets.filter(a=>id==='ALL'||(id==='CH'?['CH','GROUP','BEAST'].includes(a.type):a.type===id)).length}</small></button>)}</div>
    <div className={styles.filters}><input aria-label="搜索资产" placeholder="搜索资产名称" value={query} onChange={e=>setQuery(e.target.value)}/><label><input type="checkbox" checked={onlyQueue} onChange={e=>setOnlyQueue(e.target.checked)}/>仅独立制图资产</label></div>

    </div>
    <div className={styles.grid}>{filtered.map(a=>{const r=data.records[a.key];const status=r?.status==='RUNNING'?'生成中':r?.status==='FAILED'?'生成未完成':r?.body?promptNeedsReview(a,data.records,data.assets)?'来源有更新':'已有提示词':a.eligible?'待生成':'无需独立出图／待完善';return <button key={a.key} className={`${styles.card} ${a.key===selected?styles.selected:''}`} aria-pressed={a.key===selected} onClick={()=>setSelected(a.key)}><div className={styles.art} data-type={a.type}><span>{a.type==='LOC'?'▥':a.type==='PROP'?'◇':'♙'}</span><small>{typeNames[a.type]} · {a.variant?'子形象':'基础形象'}</small></div><div className={styles.cardText}><strong>{a.variant?`${a.baseName} · ${a.name}`:a.name}</strong><span>{drafts[a.key]!==undefined&&drafts[a.key]!==r?.body?'有未保存编辑':status}</span><small>{a.episodes.length?`第 ${a.episodes.join('、')} 集`:'适用范围待完善'}</small></div></button>;})}</div>
    {!filtered.length&&<div className={styles.empty}>{data.assets.length?'没有匹配的资产。':'第一阶段还没有资产目录。请先完成素材提取，再进入本阶段。'}</div>}
   </section>
   <aside className={styles.editor} aria-label="资产提示词编辑器">
    <h3 className={styles.panelHeading}>资产生图</h3>
    <div className={styles.editorScroll} tabIndex={0} role="region" aria-label="生图设置，可滚动">
    <label className={styles.modelChoice}>生图模型<select disabled><option>待接入图片 API</option></select></label>
    <details className={styles.style}><summary>项目通用画风 · {data.style||'自定义'}</summary><textarea aria-label="项目通用画风" rows={4} value={prefix} onChange={e=>setPrefix(e.target.value)}/><button disabled={!styleDirty||pending} onClick={saveStyle}>保存全项目画风</button><p>修改画风不重新调用 AI 拆解外观。</p></details>
    {asset?<><div className={styles.editorTitle}><small>{typeNames[asset.type]} · {asset.variant?'子形象':'基础形象'}</small><h3>{asset.variant?`${asset.baseName} · ${asset.name}`:asset.name}</h3></div>
     {asset.reasons.length>0&&<p className={styles.warning}>{asset.reasons.join('；')}</p>}
     {!asset.eligible&&!asset.reasons.length&&<p className={styles.warning}>该项为随场生成或声音资产，不进入独立制图队列。</p>}
     {needsReview&&<p className={styles.warning}>来源资料或基础形象已更新，请复核此提示词并保存确认。</p>}
     <label className={styles.bodyLabel}>资产外观提示词 <small>{body.length} 字 {dirty?'· 未保存':''}</small><textarea aria-label="资产外观提示词" placeholder="点击生成初版提示词，或直接填写资产外观。" value={body} onChange={e=>setDrafts(d=>({...d,[selected]:e.target.value}))}/></label>
     <div className={styles.actions}><button disabled={pending||record.status==='RUNNING'||(!dirty&&!needsReview)} onClick={save}>{needsReview?'保存并确认此资产':'保存此资产'}</button><button disabled={pending||data.busy||!asset.eligible||dirty||styleDirty||record.status==='RUNNING'} onClick={()=>generate([selected])}>{record.body?'重新生成提示词':'生成初版提示词'}</button><button disabled={!body.trim()} onClick={copy}>复制完整提示词</button></div>
     <ImageOptionsPanel key={selected} asset={asset} options={options} dirty={optionDirty} endpoint={endpoint} onEdit={next=>setOptionDrafts(d=>({...d,[selected]:next}))} onSaved={next=>acceptOptions(selected,next)} onNotice={setNotice}/>
     <details><summary>查看完整生图提示词</summary><label className={styles.fullPrompt}>完整生图提示词<textarea aria-label="完整生图提示词" readOnly rows={8} value={fullPrompt} placeholder="填写资产外观后，自动组合通用画风与选中的视图模板。"/></label></details>
     {record.status==='RUNNING'&&!pending&&<button onClick={recover}>检查执行状态／恢复中断</button>}
     {record.error&&<p className={styles.warning}>{record.error}</p>}
     <details open={Boolean(record.suggestions)}><summary>原文依据与设计补足</summary><h4>原文明示</h4><p className={styles.prose}>{record.facts||'生成后展示原文明示的外观信息。'}</p><h4>设计补足／待确认</h4><p className={styles.prose}>{record.suggestions||'暂无记录。'}</p></details>
     <details><summary>第一阶段资料与原文节选</summary><p className={styles.optionHint}>以下为当前生成使用的资料，供核对归属与适用形象；第一阶段备注不等于已核实的外貌事实。</p><h4>第一阶段整理</h4><p className={styles.prose}>{[asset.description,asset.note].filter(Boolean).join('\n')||'暂无整理备注。'}</p><h4>原文外观节选</h4>{asset.evidence.length?asset.evidence.map((e,i)=><div key={`${e.label}-${i}`}><small>{e.label}</small><p className={styles.prose}>{e.text}</p></div>):<p className={styles.optionHint}>当前未筛选到归属明确的外观节选，不代表原文没有描述。</p>}</details>
     {record.rawOutput&&record.status==='FAILED'&&<details><summary>保留的生成结果</summary><pre className={styles.prose}>{record.rawOutput}</pre></details>}
    </>:<div className={styles.empty}>从左侧选择一个资产。</div>}
    <section className={styles.history}><h4>生成历史</h4><p>暂无生成记录</p><small>接入图片 API 后，在这里查看当前资产的生成结果并选用图片。</small></section>
    </div>
    <div className={styles.apiPlaceholder}><button disabled>生成资产图片 · API 待接入</button></div>
   </aside>
  </div>
 </div>;
}
