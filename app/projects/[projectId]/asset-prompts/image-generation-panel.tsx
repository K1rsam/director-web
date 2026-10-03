'use client';
import {useEffect, useRef, useState} from 'react';
import type {PromptWorkspace} from '@/lib/asset-prompt-contract';
import {promptNeedsReview} from '@/lib/asset-prompt-contract';
import type {ImageJob} from '@/lib/asset-image-job-contract';
import styles from './image-generation-panel.module.css';

const statusNames = {WAITING_EXECUTOR: '等待网页执行器', RUNNING: '执行器已接单', REVIEW: '已有候选原图 · 待核对', FAILED: '任务未完成', CANCELLED: '已取消'};
const browserStatusNames = {UNCONFIGURED: '尚未配置', OFFLINE: '连接离线', READY: '连接就绪', RUNNING: '正在执行', PAUSED: '已暂停接单', ERROR: '连接需检查'};
type BrowserExecutor = {configured: boolean; status: keyof typeof browserStatusNames; message: string; enabled: boolean; available: boolean};
function readableError(value: unknown) {
  const message = value instanceof Error ? value.message : '操作未完成，请刷新任务记录核对。';
  return /[A-Za-z]:[\\/]|(?:\/Users\/|\/home\/)|(?:api[_-]?key|bearer\s)/i.test(message) ? '操作未完成，请检查任务记录或联系执行者；详细信息未在页面展示。' : message;
}
function readBrowserExecutor(value: unknown): BrowserExecutor {
  if (!value || typeof value !== 'object') throw new Error('暂时无法核对 Chrome 执行器状态。');
  const row = value as Record<string, unknown>;
  if (typeof row.configured !== 'boolean' || typeof row.enabled !== 'boolean' || typeof row.message !== 'string'
    || typeof row.status !== 'string' || !Object.hasOwn(browserStatusNames, row.status)) throw new Error('暂时无法核对 Chrome 执行器状态。');
  // Keep the public projection only; connection paths and credentials never enter UI state.
  const message = /token|cookie|credential|secret|(?:^|\s)\/[^\s/]+\//i.test(row.message) ? '连接信息需检查，请打开本地设置页。' : readableError(new Error(row.message));
  return {configured: row.configured, enabled: row.enabled, available: row.available === true, status: row.status as BrowserExecutor['status'], message};
}
function ChromeImageExecutor({projectId,onState}: {projectId: string;onState:(state:BrowserExecutor|null)=>void}) {
  const [executor, setExecutor] = useState<BrowserExecutor | null>(null), [pending, setPending] = useState(''), [error, setError] = useState('');
  const mounted = useRef(false), submitting = useRef(false), sequence = useRef(0);
  const endpoint = `/projects/${encodeURIComponent(projectId)}/asset-prompts/image-browser`;
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    let inFlight = false;
    const read = async () => {
      if (inFlight || submitting.current || document.hidden) return;
      inFlight = true;
      const id = ++sequence.current;
      try {
        const response = await fetch(endpoint, {cache: 'no-store', signal: controller.signal});
        if (!response.ok) throw new Error('暂时无法连接 Chrome 执行器，请完成本地设置后刷新。');
        const next = readBrowserExecutor(await response.json());
        if (mounted.current && id === sequence.current) {setExecutor(next); setError('');}
      } catch (reason) {
        if (!controller.signal.aborted && mounted.current && id === sequence.current) {setExecutor(null); setError(readableError(reason));}
      } finally {inFlight = false;}
    };
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    return () => {mounted.current = false; sequence.current++; controller.abort(); window.clearInterval(timer);};
  }, [endpoint]);
  useEffect(()=>{onState(executor);},[executor,onState]);
  async function act(action: 'enable' | 'pause' | 'refresh') {
    if (submitting.current || (action === 'enable' && (!executor?.configured || executor.status === 'UNCONFIGURED' || executor.enabled))) return;
    submitting.current = true;
    const id = ++sequence.current;
    setPending(action); setError('');
    try {
      const response = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action})});
      if (!response.ok) throw new Error('Chrome 执行器操作未确认，请刷新状态核对；未自动重试。');
      const next = readBrowserExecutor(await response.json());
      if (mounted.current && id === sequence.current) setExecutor(next);
    } catch (reason) {
      if (mounted.current && id === sequence.current) {setExecutor(null); setError(readableError(reason));}
    } finally {submitting.current = false; if (mounted.current) setPending('');}
  }
  return <div className={styles.executor} aria-label="Chrome 网页连接" aria-busy={!!pending}>
    <div className={styles.heading}><span className={styles.connection} data-ready={executor?.available===true}>{executor?.status==='RUNNING'?'正在生图':executor?.available?'Chrome 已就绪':error?'连接待核对':executor?browserStatusNames[executor.status]:'连接检查中'}</span>
     <details className={styles.connectionSettings}><summary>连接设置</summary><div className={styles.connectionBody}>
      <p className={styles.hint}>{executor?.message||'首次使用请连接 Chrome，并登录 ChatGPT。'}</p>
      <div className={styles.actions}><a href="http://127.0.0.1:53179/setup" target="_blank" rel="noreferrer">打开连接设置</a><button disabled={!!pending} onClick={()=>void act('refresh')}>检查连接</button>{executor?.enabled&&<button disabled={!!pending} onClick={()=>void act('pause')}>暂停接新任务</button>}</div>
      <p className={styles.hint}>连接一次后会保留。已发送的生成请到 ChatGPT 页面核对，工作台不会自动重发。</p>
     </div></details>
    </div>
    {!executor?.available&&executor&&<p className={styles.hint}>{executor.status==='PAUSED'?'Chrome 尚未就绪，请在连接设置中检查。':executor.message}</p>}
    {error&&<p className={styles.warning} role="alert">{error}</p>}
  </div>;
}

export function AssetImageGenerationPanel({workspace, assetKey, episodeNumbers, jobs, jobsLoading, jobsError, refreshJobs, disabled = false, onChanged}: {
  workspace: PromptWorkspace; assetKey: string; episodeNumbers: number[]; jobs:ImageJob[];jobsLoading:boolean;jobsError:string;refreshJobs:()=>Promise<ImageJob[]>;disabled?: boolean; onChanged?: () => Promise<void> | void;
}) {
  const [refreshing, setRefreshing] = useState(false), [pending, setPending] = useState(false);
  const loading=jobsLoading||refreshing;
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [browser,setBrowser]=useState<BrowserExecutor|null>(null),[creationUncertain,setCreationUncertain]=useState(false);
  const creationBaseline=useRef<Set<string>|null>(null);
  const mounted = useRef(false), submitting = useRef(false), changed = useRef(onChanged);
  changed.current = onChanged;
  const endpoint = `/projects/${workspace.projectId}/asset-prompts/images`;
  const asset = workspace.assets.find(item => item.key === assetKey), record = workspace.records[assetKey], options = workspace.imageOptions?.[assetKey];
  const validScope = episodeNumbers.length > 0 && episodeNumbers.every(n => Number.isSafeInteger(n) && n >= 1);
  const outOfScope = !asset || !asset.episodes.some(n => episodeNumbers.includes(n));
  const sourceChanged = asset ? promptNeedsReview(asset, workspace.records, workspace.assets) : true;
  const blocked = disabled || pending || workspace.busy;
  const createBlocked = blocked || loading || creationUncertain || (options?.count??1)!==1 || jobs.some(j=>['WAITING_EXECUTOR','RUNNING'].includes(j.status)) || !browser?.available || !validScope || outOfScope || !asset?.eligible || record?.status !== 'READY' || !record.body.trim() || sourceChanged;
  const imageUrl = (jobId: string, imageId: string) => `${endpoint}?jobId=${encodeURIComponent(jobId)}&imageId=${encodeURIComponent(imageId)}`;
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;};
  }, [endpoint,assetKey]);
  useEffect(()=>{if(creationBaseline.current&&jobs.some(job=>!creationBaseline.current!.has(job.id))){creationBaseline.current=null;setCreationUncertain(false);}},[jobs]);
  async function refresh(){await refreshJobs();}
  async function mutate(body: Record<string, unknown> | FormData, success: string, refreshWorkspace = false) {
    if (submitting.current) return;
    submitting.current = true; setPending(true); setError(''); setNotice('');
    try {
      const form = body instanceof FormData;
      const response = await fetch(endpoint, {method: 'POST', ...(form ? {} : {headers: {'Content-Type': 'application/json'}}), body: form ? body : JSON.stringify(body)});
      const result = await response.json();
      if (!response.ok) {if(response.status<500&&!(body instanceof FormData)&&body.action==='generate'){creationBaseline.current=null;setCreationUncertain(false);}throw new Error(result.error || '操作未完成，请刷新任务记录核对。');}
      if (mounted.current) {setNotice(success);if(!(body instanceof FormData)&&body.action==='generate'){creationBaseline.current=null;setCreationUncertain(false);}}
      await refresh();
      if (refreshWorkspace) await changed.current?.();
    } catch (reason) {
      if (mounted.current) setError(`${readableError(reason)} 未自动重发，请先刷新核对已保存结果。`);
    } finally {submitting.current = false; if (mounted.current) setPending(false);}
  }
  function create() {
    if (createBlocked || !record) return;
    creationBaseline.current=new Set(jobs.map(job=>job.id));setCreationUncertain(true);
    void mutate({action: 'generate', key: assetKey, expectedPromptRevision: record.revision, expectedStyleRevision: workspace.styleRevision, expectedOptionsRevision: options?.revision ?? 0, episodeNumbers}, '图片已排队，完成后会自动显示在资产库，供你选择。');
  }
  function importImages(job: ImageJob, files: FileList | null) {
    if (!files?.length || blocked || job.stale || job.status !== 'WAITING_EXECUTOR') return;
    const form = new FormData(); form.set('jobId', job.id); form.set('revision', String(job.revision));
    Array.from(files).forEach(file => form.append('files', file));
    void mutate(form, '原图已绑定到此任务，作为候选保留；未覆盖旧图，也未自动采用设计。');
  }
  async function manualRefresh() {
    if (loading || pending) return;
    setRefreshing(true); setError('');
    try {await refresh();} catch (reason) {if (mounted.current) setError(readableError(reason));}
    finally {if (mounted.current) setRefreshing(false);}
  }
  return <section className={styles.panel} aria-label="图片生成" aria-busy={pending || loading}>
    <label className={styles.provider}>出图方式<select aria-label="出图方式" value="CHATGPT_WEB" onChange={()=>{}}><option value="CHATGPT_WEB">Chrome · ChatGPT 网页</option><option disabled>API · 待接入</option><option disabled>CLI · 待接入</option></select></label>
    <ChromeImageExecutor key={workspace.projectId} projectId={workspace.projectId} onState={setBrowser}/>
    <button className={styles.generateButton} disabled={createBlocked} onClick={create}>{pending?'正在提交…':jobs.some(j=>['WAITING_EXECUTOR','RUNNING'].includes(j.status))?'已排队 · 查看任务':'生成图片'}</button>
    {(options?.count??1)!==1&&<p className={styles.warning}>Chrome 网页当前每次生成1张，请将数量改为1张。</p>}
    {disabled&&record?.body?<p className={styles.warning}>请先保存提示词或图片设置的修改。</p>:!validScope?<p className={styles.warning}>此资产还没有可制作的原文出场范围。</p>:!record?.body||record.status!=='READY'?<p className={styles.hint}>填写并保存提示词后即可生图。</p>:sourceChanged?<p className={styles.warning}>来源已有更新，请复核提示词并保存。</p>:null}
    {error&&<p className={styles.error} role="alert">{error}</p>}
    {jobsError&&<p className={styles.error} role="alert">{jobsError}</p>}
    {notice&&<p className={styles.hint} role="status">{notice}</p>}
    {creationUncertain&&<div className={styles.warning}>上次提交结果待核对，已锁定重复生成。<button disabled={loading||pending} onClick={manualRefresh}>核对任务记录</button></div>}
    <details className={styles.taskHistory} open={jobs.some(j=>['WAITING_EXECUTOR','RUNNING'].includes(j.status))}><summary>候选与任务历史 · {jobs.length}<button disabled={loading||pending} onClick={event=>{event.preventDefault();void manualRefresh();}}>刷新</button></summary>
    <div className={styles.history}>{jobs.map(job => {
      const importBlocked = blocked || job.stale || job.status !== 'WAITING_EXECUTOR';
      const useBlocked = blocked || job.stale || job.status !== 'REVIEW';
      return <article key={job.id} className={styles.job} aria-label={`${job.name} · ${statusNames[job.status]}`} aria-busy={job.status === 'RUNNING'}>
        <div className={styles.heading}><strong>{job.name}</strong><span className={styles.badge} data-state={job.status}>{statusNames[job.status]}</span></div>
        <p className={styles.meta}>{new Date(job.createdAt).toLocaleString('zh-CN')} · 已接收 {job.images.length} / 预计 {job.expectedCount} 张</p>
        {job.stale && <p className={styles.warning}>来源已更新，旧任务与候选原图仍保留；不能设为当前参考图，请按当前资料创建新任务。</p>}
        {job.status === 'WAITING_EXECUTOR' && <p className={styles.hint}>等待网页执行器接单。Chrome 连接就绪且本项目已启用后可自动执行；也可用 Codex 桌面执行包，将原图导入下方。</p>}
        {job.leaseExpired && <p className={styles.warning}>执行器尚未回传结果，请先核对 ChatGPT 网页，再决定是否取消任务；不会自动重发生图。</p>}
        {job.error && <p className={styles.error}>{readableError(new Error(job.error))}</p>}
        <details className={styles.details}><summary>查看任务提示词与参考来源</summary><p className={styles.prompt}>{job.prompt}</p>{job.references.length ? <ul>{job.references.map((reference, index) => <li key={`${reference.assetKey}-${reference.id}-${index}`}>{reference.role === 'SOURCE' ? '来源形象' : '补充参考'} · {reference.name}（{reference.width} × {reference.height}）</li>)}</ul> : <p className={styles.hint}>此任务没有绑定参考图片。</p>}</details>
        <details className={styles.details}><summary>任务操作与手动回传</summary><div className={styles.actions}><a className="studioButton" data-variant="secondary" href={`${endpoint}?jobId=${encodeURIComponent(job.id)}&view=handoff`} target="_blank" rel="noreferrer">查看网页执行包</a>{['WAITING_EXECUTOR', 'RUNNING'].includes(job.status) && <button className="studioButton" data-variant="caution" disabled={blocked} onClick={() => void mutate({action: 'cancel', jobId: job.id, revision: job.revision}, '已取消此任务；原有图片与任务历史均保留。')}>取消任务</button>}</div>
        <label className={styles.upload}>导入此任务的原图 · 备用<input aria-label={`导入${job.name}任务原图`} type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={importBlocked} onChange={event => {importImages(job, event.currentTarget.files); event.currentTarget.value = '';}}/></label>
        <p className={styles.hint}>手动导入只保存候选。图片经你选择后才会作为当前参考。</p></details>
        {!!job.images.length && <div className={styles.images}>{job.images.map(image => <figure className={styles.image} key={image.id}><a href={imageUrl(job.id, image.id)} target="_blank" rel="noreferrer"><img src={`${imageUrl(job.id, image.id)}&view=preview`} alt={`${job.name}候选：${image.name}`} loading="lazy"/></a><figcaption>{image.name}<small>{image.width} × {image.height} · {(image.size / 1024 / 1024).toFixed(2)} MB</small></figcaption><div className={styles.actions}><a href={imageUrl(job.id, image.id)} download={image.name}>下载原图</a><button className="studioButton" data-variant="secondary" disabled={useBlocked || job.usedImageIds.includes(image.id)} onClick={() => void mutate({action: 'use', jobId: job.id, imageId: image.id, revision: job.revision, expectedOptionsRevision: options?.revision ?? 0}, '已挂为此资产的参考图；请在设计采用面板核对并人工采用。', true)}>{job.usedImageIds.includes(image.id) ? '已设为参考图' : '设为参考图'}</button></div></figure>)}</div>}
      </article>;
    })}</div>
    </details>
  </section>;
}
