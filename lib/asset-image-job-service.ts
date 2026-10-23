import {requireSeasonProduction} from './season-scope-service';
import {assertSeasonEpisodes,seasonAssetAllowed} from '../runtime/season-scope.mjs';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {mkdir,readFile,writeFile,lstat,realpath,open} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {Prisma} from '@prisma/client';
import {prisma} from './prisma';
import {loadAssetPromptWorkspace,planEpisodeAssetProduction} from './asset-prompt-service';
import {promptNeedsReview} from './asset-prompt-contract';
import {readAssetDesignAdoptions} from './asset-design-adoption';
import {readAssetReference,attachGeneratedAssetReference} from './asset-image-options-service';
import {compileImagePrompt,emptyImageOptions} from './asset-image-options';
import type {ImageJob,ImageJobImage,ImageJobReference} from './asset-image-job-contract';

const JOB_KEY='ASSET_IMAGE_JOB_V1', uuid=/^[a-f0-9-]{36}$/;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const refRoot=()=>path.resolve(/*turbopackIgnore: true*/ process.env.DIRECTOR_ASSET_REFERENCE_DIR||'outputs/asset-references');
export const imageJobExportRoot=()=>path.resolve(/*turbopackIgnore: true*/ 'runtime-3008/chatgpt-images');
async function safeExportDirectory(id:string,leaf:'references'|'originals'){
 identity(id);const project=await realpath(/*turbopackIgnore: true*/ process.cwd());
 let directory=project;
 for(const segment of ['runtime-3008','chatgpt-images',id,leaf]){
  directory=path.join(/*turbopackIgnore: true*/ directory,segment);await mkdir(/*turbopackIgnore: true*/ directory,{recursive:true});
  const info=await lstat(/*turbopackIgnore: true*/ directory),resolved=await realpath(/*turbopackIgnore: true*/ directory);
  if(info.isSymbolicLink()||!info.isDirectory()||path.relative(/*turbopackIgnore: true*/ project,resolved).startsWith('..')||path.resolve(/*turbopackIgnore: true*/ resolved).toLowerCase()!==path.resolve(/*turbopackIgnore: true*/ directory).toLowerCase())throw new Error('任务原图目录不能使用符号链接或目录联接。');
 }
 return directory;
}
async function verifyBoundImages(job:StoredJob){for(const ref of job.references){const source=await readAssetReference(job.projectId,ref.assetKey,ref.id);if(!source||bytesHash(source.bytes)!==ref.sha256)throw new Error('绑定的参考图片已变化，请取消旧任务。');}}
export async function listExecutorImageJobs(){
 const rows=await prisma.$queryRaw<Array<{content:string}>>`SELECT content FROM SceneSnapshot
  WHERE sceneKey=${JOB_KEY} AND CASE WHEN json_valid(content) THEN
   EXISTS(SELECT 1 FROM json_each(content) WHERE key IN ('status','dispatchMode') GROUP BY key HAVING COUNT(*)>1) OR
   json_extract(content,'$.status')='RUNNING' OR
   (json_extract(content,'$.status')='WAITING_EXECUTOR' AND json_extract(content,'$.dispatchMode')='CHROME')
   ELSE 1 END ORDER BY createdAt ASC,id ASC`;
 const candidates=rows.map(row=>JSON.parse(row.content) as StoredJob).filter(job=>job.status==='RUNNING'||job.status==='WAITING_EXECUTOR'&&job.dispatchMode==='CHROME');
 return (await currentSeasonJobs(candidates)).map(job=>({id:job.id,projectId:job.projectId,key:job.key,name:job.name,status:job.status,revision:job.revision}));
}
export async function imageJobExecutorIdentity(id:string){identity(id);const row=await prisma.sceneSnapshot.findFirst({where:{id,sceneKey:JOB_KEY}});if(!row)throw new Error('任务不存在。');const job=JSON.parse(row.content) as StoredJob;return {projectId:job.projectId,actorId:job.actorId};}
type StoredJob=Omit<ImageJob,'stale'|'leaseExpired'> & {
  schema:typeof JOB_KEY;projectId:string;actorId:string;keys:string[];binding:string;
  claimToken?:string;leaseUntil?:string;episodeNumbers:number[];seasonScopeHash?:string;
};
async function requireJobSeason(job:StoredJob,db:Prisma.TransactionClient=prisma){
  const season=await requireSeasonProduction(job.projectId,job.episodeNumbers,'images',db);
  if((season?.scopeHash??undefined)!==job.seasonScopeHash)throw Object.assign(new Error('图片任务冻结季范围已变化，旧任务只能保留历史，不能继续生产。'),{code:'SEASON_CHANGED',requestOutcome:'NOT_SENT'});
  if(!season)return null;
  assertSeasonEpisodes(season.scope,job.episodeNumbers,'images');
  const row=await db.sceneSnapshot.findFirst({where:{projectId:job.projectId,sceneKey:'FOUNDATION_DOCUMENT'},orderBy:{createdAt:'desc'}});
  const catalog=row?JSON.parse(row.content).f2?.assets??[]:[],assets=catalog.flatMap((base:any)=>[base,...(base.variants??[])]);
  if(!Array.isArray(job.keys)||!job.keys.includes(job.key)||job.keys.some(key=>!assets.some((asset:any)=>asset.key===key&&seasonAssetAllowed(season.scope,asset,season.basis)))||!assets.some((asset:any)=>asset.key===job.key&&seasonAssetAllowed({...season.scope,episodeNumbers:job.episodeNumbers},asset,season.basis)))throw Object.assign(new Error('图片任务形象或父依赖缺少当前选季实际集场用途。'),{code:'SEASON_SCOPE',requestOutcome:'NOT_SENT'});
  return season;
}
async function currentSeasonJobs(jobs:StoredJob[]){
  const current:StoredJob[]=[];
  for(const job of jobs){try{await requireJobSeason(job);current.push(job);}catch(error){if(!String((error as {code?:string}).code??'').startsWith('SEASON_'))throw error;}}
  return current;
}
function identity(id:string){if(typeof id!=='string'||!uuid.test(id))throw new Error('图片任务编号无效。');}
function revision(value:number){if(!Number.isSafeInteger(value)||value<0)throw new Error('图片任务版本无效。');}
async function permission(projectId:string,actorId:string,db:Prisma.TransactionClient=prisma){
  const member=await db.projectRole.findFirst({where:{projectId,userId:actorId}});
  if(!member)throw new Error('无权访问此项目。');
}
// Capture exact persisted source and dependent material, without job history or unrelated asset edits.
async function bindings(projectId:string,keySets:string[][],db:Prisma.TransactionClient=prisma){
  const sets=keySets.map(keys=>new Set([...keys.flatMap(key=>['ap15_','ai15_','adopt_'].map(prefix=>prefix+hash([projectId,key]).slice(0,40))), 'ap15_'+hash([projectId,'$style']).slice(0,40)]));
  const ids=[...new Set(sets.flatMap(set=>[...set]))];
  const [project,rows,contracts,runs]=await Promise.all([
    db.project.findUnique({where:{id:projectId},select:{style:true,aspectRatio:true,ruleVersion:true,episodes:{orderBy:{number:'asc'},select:{number:true,content:true}}}}),
    // substr is case-sensitive and treats '_' literally, matching the original
    // JavaScript startsWith predicate even for null, mixed case and legacy keys.
    db.$queryRaw<Array<{id:string;sceneKey:string|null;content:string;metadata:string|null}>>(Prisma.sql`
      SELECT id,sceneKey,content,metadata FROM SceneSnapshot WHERE projectId=${projectId}
      AND (sceneKey IS NULL OR substr(sceneKey,1,6)<>'ASSET_' OR id IN (${Prisma.join(ids)})) ORDER BY id ASC`),
    db.presentationContract.findMany({where:{projectId,status:'CONFIRMED'},orderBy:{id:'asc'}}),
    db.pipelineRun.findMany({where:{projectId,status:'RUNNING'},select:{id:true}}),
  ]);
  if(!project)throw new Error('项目不存在。');
  return sets.map(ids=>hash([project,rows.filter(row=>ids.has(row.id)||!row.sceneKey?.startsWith('ASSET_')),contracts,runs]));
}
async function binding(projectId:string,keys:string[],db:Prisma.TransactionClient=prisma){return (await bindings(projectId,[keys],db))[0];}
async function stored(projectId:string,id:string){identity(id);const row=await prisma.sceneSnapshot.findFirst({where:{id,projectId,sceneKey:JOB_KEY}});if(!row)throw new Error('图片任务不存在。');return {row,job:JSON.parse(row.content) as StoredJob};}
async function view(job:StoredJob,currentBinding?:string):Promise<ImageJob>{
  const {schema:_,projectId:__,actorId:___,keys:____,binding:_____,claimToken:______,leaseUntil,episodeNumbers:_______,...publicJob}=job;
  return {...publicJob,stale:job.binding!==(currentBinding??await binding(job.projectId,job.keys)),leaseExpired:job.status==='RUNNING'&&Date.parse(leaseUntil??'')<Date.now()};
}
async function mutate(projectId:string,id:string,expected:number,change:(job:StoredJob,db:Prisma.TransactionClient)=>Promise<StoredJob>){
  identity(id);revision(expected);
  return prisma.$transaction(async db=>{
    const row=await db.sceneSnapshot.findFirst({where:{id,projectId,sceneKey:JOB_KEY}});if(!row)throw new Error('图片任务不存在。');
    const current=JSON.parse(row.content) as StoredJob;if(current.revision!==expected)throw new Error('图片任务已更新，请刷新。');
    const next=await change(current,db);next.revision=current.revision+1;
    if((await db.sceneSnapshot.updateMany({where:{id,projectId,content:row.content},data:{content:JSON.stringify(next)}})).count!==1)throw new Error('图片任务刚被更新，请刷新。');
    return next;
  },{timeout:20000});
}
export async function listImageJobs(projectId:string,actorId:string,key?:string){
  await permission(projectId,actorId);
  const rows=await prisma.sceneSnapshot.findMany({where:{projectId,sceneKey:JOB_KEY,...(key?{title:key}:{})},orderBy:{createdAt:'desc'}});
  const jobs=await currentSeasonJobs(rows.map(row=>JSON.parse(row.content) as StoredJob));
  if(!jobs.length)return {jobs:[]};
  const signatures=[...new Map(jobs.map(job=>[JSON.stringify([...job.keys].sort()),job.keys])).entries()];
  const values=await bindings(projectId,signatures.map(([,keys])=>keys));
  const current=new Map(signatures.map(([signature],i)=>[signature,values[i]]));
  return {jobs:await Promise.all(jobs.map(job=>view(job,current.get(JSON.stringify([...job.keys].sort())))))};
}
export async function createImageJob(projectId:string,actorId:string,input:{key:string;expectedPromptRevision:number;expectedStyleRevision:number;expectedOptionsRevision:number;episodeNumbers:number[]},dispatchMode:'CHROME'|'MANUAL'='MANUAL'){
  const season=await requireSeasonProduction(projectId,input.episodeNumbers,'images');
  await permission(projectId,actorId);if(typeof input.key!=='string'||input.key.length>200)throw new Error('请选择有效资产。');
  [input.expectedPromptRevision,input.expectedStyleRevision,input.expectedOptionsRevision].forEach(revision);
  if(!Array.isArray(input.episodeNumbers)||!input.episodeNumbers.length||input.episodeNumbers.some(n=>!Number.isSafeInteger(n)||n<1))throw new Error('请明确选择制作集数。');
  const plan=await planEpisodeAssetProduction(projectId,input.episodeNumbers),scope=plan.scope;
  if(!plan.assetKeys.includes(input.key))throw new Error('此资产不在所选集的制作范围内，未创建图片任务。');
  const sourceBefore=await binding(projectId,[]);
  const workspace=await loadAssetPromptWorkspace(projectId,scope),asset=workspace.assets.find(a=>a.key===input.key),record=workspace.records[input.key];
  if(workspace.busy||!asset?.eligible||record?.status!=='READY'||!record.body.trim()||promptNeedsReview(asset,workspace.records,workspace.assets))throw new Error('请先核对并保存当前形象提示词；来源更新或整理中时不能生图。');
  const options=workspace.imageOptions?.[asset.key]??emptyImageOptions();
  if(record.revision!==input.expectedPromptRevision||workspace.styleRevision!==input.expectedStyleRevision||options.revision!==input.expectedOptionsRevision)throw new Error('提示词、画风或图片设置已更新，请刷新。');
  if(dispatchMode==='CHROME'&&(options.count??1)!==1)throw new Error('Chrome 网页当前每次生成1张，请将数量改为1张。');
  const keys=[asset.key];let source=asset;const seen=new Set(keys);
  while(source.fromKey||(source.variant&&source.baseKey!==source.key)){
    const next=source.fromKey??source.baseKey;if(seen.has(next))throw new Error('来源形象存在循环，请先修复。');seen.add(next);keys.push(next);
    const found=workspace.assets.find(a=>a.key===next);if(!found)throw new Error('来源形象不存在。');source=found;
  }
  const before=await binding(projectId,keys);
  // Tie the decoded workspace to the exact persisted rows captured above.
  const fresh=await loadAssetPromptWorkspace(projectId,scope);
  if(sourceBefore!==await binding(projectId,[])||hash([keys.map(key=>[fresh.assets.find(a=>a.key===key),fresh.records[key],fresh.imageOptions?.[key]]),fresh.style,fresh.stylePrefix,fresh.styleRevision])!==hash([keys.map(key=>[workspace.assets.find(a=>a.key===key),workspace.records[key],workspace.imageOptions?.[key]]),workspace.style,workspace.stylePrefix,workspace.styleRevision])||before!==await binding(projectId,keys))throw new Error('来源或提示词刚被更新，未创建任务，请刷新。');
  const references:ImageJobReference[]=[];
  const direct=keys[1];
  if(direct){
    const adopted=(await readAssetDesignAdoptions(projectId,actorId,workspace)).assets[direct];
    if(adopted?.status!=='REFERENCE_ADOPTED'||!adopted.current?.references.length)throw new Error('派生形象必须先采用直接来源形象的图片；文字差异不能独立文生图。');
    for(const ref of adopted.current.references){const file=await readAssetReference(projectId,direct,ref.id);if(!file)throw new Error('来源参考图已移除，请重新核对采用。');references.push({...ref,assetKey:direct,role:'SOURCE',sha256:bytesHash(file.bytes)});}
  }
  for(const ref of options.references){const file=await readAssetReference(projectId,asset.key,ref.id);if(!file)throw new Error('补充参考图已移除。');references.push({...ref,assetKey:asset.key,role:'SUPPLEMENT',sha256:bytesHash(file.bytes)});}
  const id=randomUUID();
  const prompt=[direct?'这是基于所附直接来源图片的派生形象编辑任务。保持主体身份和未要求变化的设计；第一组图片是直接来源，其余是补充参考。以下外观文字只描述变化，不可当作独立文生图提示词。':'生成以下单个资产的形象设计。',compileImagePrompt(workspace.stylePrefix,record.body,options),`生成 ${options.count??1} 张独立原图，目标比例 ${options.aspectRatio??'16:9'}，期望画质 ${options.quality??'1K'}；实际尺寸以原图为准。不要用网页截图代替原图。`].join('\n\n');
  const job:StoredJob={schema:JOB_KEY,id,projectId,actorId,keys,binding:before,key:asset.key,name:asset.variant?`${asset.baseName} · ${asset.name}`:asset.name,revision:0,status:'WAITING_EXECUTOR',provider:'CHATGPT_WEB',dispatchMode,prompt,createdAt:new Date().toISOString(),error:'',expectedCount:options.count??1,quality:options.quality??'1K',aspectRatio:options.aspectRatio??'16:9',references,images:[],usedImageIds:[],episodeNumbers:[...new Set(input.episodeNumbers)],...(season?{seasonScopeHash:season.scopeHash}:{})};
  const result=await prisma.$transaction(async db=>{
    await permission(projectId,actorId,db);
    await requireJobSeason(job,db);
    if(before!==await binding(projectId,keys,db))throw new Error('来源刚被更新，未创建任务，请刷新。');
    const existing=await db.sceneSnapshot.findMany({where:{projectId,sceneKey:JOB_KEY,title:asset.key}});
    const active=existing.map(r=>JSON.parse(r.content) as StoredJob).find(j=>['WAITING_EXECUTOR','RUNNING'].includes(j.status));
    if(active){await requireJobSeason(active,db);if(active.binding===before){if(dispatchMode==='CHROME'&&active.dispatchMode!=='CHROME')throw new Error('此资产已有手动等待任务，请在历史中完成或取消后再生成。');return active;}throw new Error('此形象已有未结束任务，请先取消旧任务。');}
    await db.sceneSnapshot.create({data:{id,projectId,sceneKey:JOB_KEY,title:asset.key,content:JSON.stringify(job)}});return job;
  },{timeout:20000});
  return view(result);
}
export async function cancelImageJob(projectId:string,actorId:string,id:string,expected:number){await permission(projectId,actorId);return view(await mutate(projectId,id,expected,async job=>{if(!['WAITING_EXECUTOR','RUNNING'].includes(job.status))throw new Error('此任务已经结束。');return {...job,status:'CANCELLED',claimToken:undefined,error:'已停止接收本任务结果；已发送的网页生成需在网页中核对，不会自动重发。'};}));}
export async function claimImageJob(projectId:string,actorId:string,id:string,expected:number){
  await permission(projectId,actorId);const token=randomUUID();
  const next=await mutate(projectId,id,expected,async(job,db)=>{
    await requireJobSeason(job,db);
    if(job.status!=='WAITING_EXECUTOR')throw new Error('任务已被领取或已结束；不会自动重复提交网页。');
    if(job.binding!==await binding(projectId,job.keys,db))throw new Error('来源已变，禁止发送旧任务。');
    await verifyBoundImages(job);
    const active=await db.$queryRaw<Array<{content:string}>>`SELECT content FROM SceneSnapshot WHERE sceneKey=${JOB_KEY}
      AND CASE WHEN json_valid(content) THEN
        (SELECT COUNT(*)>1 FROM json_each(content) WHERE key='status') OR json_extract(content,'$.status')='RUNNING' ELSE 1 END`;
    if(active.some(row=>(JSON.parse(row.content) as StoredJob).status==='RUNNING'))throw new Error('已有网页任务执行中，请先处理或取消该任务，避免混用对话。');
    return {...job,status:'RUNNING',claimToken:token,leaseUntil:new Date(Date.now()+15*60*1000).toISOString()};
  });return {job:await view(next),claimToken:token};
}
function claimMatches(job:StoredJob,token?:string){return typeof token==='string'&&typeof job.claimToken==='string'&&token.length===job.claimToken.length&&timingSafeEqual(Buffer.from(token),Buffer.from(job.claimToken));}
export async function failImageJob(projectId:string,actorId:string,id:string,expected:number,token:string,error:string){await permission(projectId,actorId);if(typeof error!=='string')throw new Error('错误说明无效。');return view(await mutate(projectId,id,expected,async job=>{if(job.status!=='RUNNING'||!claimMatches(job,token))throw new Error('任务执行身份已失效。');return {...job,status:'FAILED',error:error.slice(0,1000),claimToken:undefined};}));}
export async function readImageHandoff(projectId:string,actorId:string,id:string){
  await permission(projectId,actorId);const {job}=await stored(projectId,id),publicJob=await view(job);
  await requireJobSeason(job);
  if(publicJob.stale||['FAILED','CANCELLED'].includes(job.status))throw new Error('任务来源已变或已结束，不可继续生成。');
  const directory=await safeExportDirectory(job.id,'references');
  const references=[];
  for(let i=0;i<job.references.length;i++){
    const ref=job.references[i],source=await readAssetReference(projectId,ref.assetKey,ref.id);if(!source||bytesHash(source.bytes)!==ref.sha256)throw new Error('绑定的参考图片已变化，请取消旧任务。');
    const target=path.join(/*turbopackIgnore: true*/ directory,`${String(i+1).padStart(2,'0')}-${ref.id}.${ref.mime.split('/')[1]}`);
    try{await writeFile(/*turbopackIgnore: true*/ target,source.bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;if(!(await lstat(/*turbopackIgnore: true*/ target)).isFile()||(await lstat(/*turbopackIgnore: true*/ target)).isSymbolicLink()||bytesHash(await readFile(/*turbopackIgnore: true*/ target))!==ref.sha256)throw new Error('交接文件冲突，请核对本地文件。');}
    references.push({...ref,path:target});
  }
  // Local executor transport; HTTP callers receive URLs, never these private disk paths.
  return {...publicJob,projectId,episodeNumbers:job.episodeNumbers,references,outputDirectory:await safeExportDirectory(job.id,'originals')};
}
async function inspectImage(file:File):Promise<{image:ImageJobImage;bytes:Buffer}>{
  if(!file.size||file.size>20*1024*1024)throw new Error('原图须为20 MB以内的静态PNG、JPEG或WebP。');
  const bytes=Buffer.from(await file.arrayBuffer());let meta;
  try{meta=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();if(!['png','jpeg','webp'].includes(meta.format??'')||!meta.width||!meta.height||(meta.pages??1)>1)throw new Error();await sharp(bytes,{limitInputPixels:40_000_000}).stats();}catch{throw new Error('无法读取原图，请使用有效静态PNG、JPEG或WebP。');}
  return {bytes,image:{id:randomUUID(),name:file.name.slice(0,160),mime:`image/${meta.format}`,size:bytes.length,width:meta.width!,height:meta.height!,sha256:bytesHash(bytes)}};
}
export async function importImageJob(projectId:string,actorId:string,id:string,expected:number,files:File[],claimToken?:string,executionUrl?:string){
  await permission(projectId,actorId);const {job}=await stored(projectId,id);revision(expected);
  await requireJobSeason(job);
  if(job.revision!==expected)throw new Error('图片任务已更新，请刷新。');
  if(job.status==='RUNNING'&&!claimMatches(job,claimToken)||!['WAITING_EXECUTOR','RUNNING'].includes(job.status))throw new Error('任务已结束或执行身份无效，迟到图片不会覆盖当前形象。');
  if(files.length!==job.expectedCount)throw new Error(`本任务要求${job.expectedCount}张原图，请一次导入对应数量。`);
  if(executionUrl!==undefined&&!/^https:\/\/chatgpt\.com\/c\/[a-zA-Z0-9-]+$/.test(executionUrl))throw new Error('请提供有效的ChatGPT生成会话地址。');
  const inspected=await Promise.all(files.map(inspectImage));if(new Set(inspected.map(i=>i.image.sha256)).size!==files.length)throw new Error('不能把同一张原图重复计为多张结果。');
  await mkdir(/*turbopackIgnore: true*/ refRoot(),{recursive:true});for(const item of inspected)await writeFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ refRoot(),item.image.id),item.bytes,{flag:'wx'});
  return view(await mutate(projectId,id,expected,async(current,db)=>{
    await requireJobSeason(current,db);
    if(current.status==='RUNNING'&&!claimMatches(current,claimToken)||!['WAITING_EXECUTOR','RUNNING'].includes(current.status))throw new Error('任务已取消或执行身份失效，结果仅保留在磁盘，不会回写。');
    // Stale results are retained for review; promotion independently checks the current binding.
    return {...current,status:'REVIEW',images:inspected.map(i=>i.image),resultOrigin:current.status==='RUNNING'?'WEB_EXECUTOR':'MANUAL_IMPORT',claimToken:undefined,executionUrl,error:''};
  }));
}
export async function importImageJobPaths(projectId:string,actorId:string,id:string,expected:number,paths:string[],token:string,url?:string){
  identity(id);if(!Array.isArray(paths)||paths.length>4)throw new Error('原图路径无效。');
  await permission(projectId,actorId);await requireJobSeason((await stored(projectId,id)).job);
  const directory=await safeExportDirectory(id,'originals');const allowed=await realpath(/*turbopackIgnore: true*/ directory),files:File[]=[];
  for(const name of paths){if(typeof name!=='string'||!path.isAbsolute(name))throw new Error('必须使用原图的绝对路径。');const item=await lstat(/*turbopackIgnore: true*/ name),resolved=await realpath(/*turbopackIgnore: true*/ name),relative=path.relative(/*turbopackIgnore: true*/ allowed,resolved);if(item.isSymbolicLink()||!item.isFile()||relative.startsWith('..')||path.isAbsolute(relative)||item.size>20*1024*1024)throw new Error('原图必须位于此任务专用originals目录内，不能使用链接或其他项目文件。');files.push(new File([new Uint8Array(await readFile(/*turbopackIgnore: true*/ resolved))],path.basename(resolved)));}
  return importImageJob(projectId,actorId,id,expected,files,token,url);
}
export async function readImageJobImage(projectId:string,actorId:string,id:string,imageId:string){
  await permission(projectId,actorId);identity(imageId);const {job}=await stored(projectId,id),image=job.images.find(i=>i.id===imageId);if(!image)throw new Error('候选原图不存在。');const bytes=await readFile(/*turbopackIgnore: true*/ path.join(/*turbopackIgnore: true*/ refRoot(),image.id));if(bytesHash(bytes)!==image.sha256)throw new Error('原图校验失败。');return {image,bytes};
}
async function imagePreviewDirectory(){
  const root=await realpath(/*turbopackIgnore: true*/ process.cwd());
  let directory=root;
  for(const segment of ['runtime-3008','image-previews']){
    directory=path.join(/*turbopackIgnore: true*/ directory,segment);
    try{await mkdir(/*turbopackIgnore: true*/ directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    const info=await lstat(/*turbopackIgnore: true*/ directory),resolved=await realpath(/*turbopackIgnore: true*/ directory);
    if(info.isSymbolicLink()||!info.isDirectory()||path.resolve(/*turbopackIgnore: true*/ resolved).toLowerCase()!==path.resolve(/*turbopackIgnore: true*/ directory).toLowerCase())throw new Error('图片预览缓存不能使用符号链接或目录联接。');
  }
  return directory;
}
async function readCachedImagePreview(file:string){
  const info=await lstat(/*turbopackIgnore: true*/ file),resolved=await realpath(/*turbopackIgnore: true*/ file);
  if(info.isSymbolicLink()||!info.isFile()||info.size>2*1024*1024||path.resolve(/*turbopackIgnore: true*/ resolved).toLowerCase()!==path.resolve(/*turbopackIgnore: true*/ file).toLowerCase())throw new Error('图片预览缓存文件无效。');
  const handle=await open(/*turbopackIgnore: true*/ file,fsConstants.O_RDONLY|(process.platform==='win32'?0:fsConstants.O_NOFOLLOW));
  try{
    const actual=await handle.stat();
    if(!actual.isFile()||actual.ino!==info.ino||actual.dev!==info.dev||actual.size!==info.size)throw new Error('图片预览缓存已变化，请重试。');
    const bytes=await handle.readFile();
    const metadata=await sharp(bytes,{limitInputPixels:40_000_000}).metadata();
    if(metadata.format!=='webp'||!metadata.width||!metadata.height||metadata.width>640||metadata.height>640||(metadata.pages??1)!==1)throw new Error('图片预览缓存损坏。');
    await sharp(bytes,{limitInputPixels:40_000_000}).raw().toBuffer();
    return bytes;
  }catch(error){if(error instanceof Error&&/图片预览/.test(error.message))throw error;throw new Error('图片预览缓存损坏。');}finally{await handle.close();}
}
export async function readImageJobPreview(projectId:string,actorId:string,id:string,imageId:string){
  // Read the authorized, hash-verified original on every request, including cache hits.
  const original=await readImageJobImage(projectId,actorId,id,imageId);
  if(!/^[a-f0-9]{64}$/.test(original.image.sha256))throw new Error('原图摘要无效。');
  const directory=await imagePreviewDirectory(),file=path.join(/*turbopackIgnore: true*/ directory,`${original.image.sha256}.webp`);
  try{return {bytes:await readCachedImagePreview(file),mime:'image/webp' as const};}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const bytes=await sharp(original.bytes,{limitInputPixels:40_000_000}).resize({width:640,height:640,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toBuffer();
  // Exclusive creation never follows or replaces an existing cache entry.
  try{await writeFile(/*turbopackIgnore: true*/ file,bytes,{flag:'wx'});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;return {bytes:await readCachedImagePreview(file),mime:'image/webp' as const};}
  return {bytes,mime:'image/webp' as const};
}
export async function useImageJobResult(projectId:string,actorId:string,id:string,imageId:string,expected:number,expectedOptionsRevision:number){
  await permission(projectId,actorId);identity(imageId);revision(expectedOptionsRevision);
  const {job}=await stored(projectId,id);if(job.revision!==expected||job.status!=='REVIEW')throw new Error('请刷新后选择待审看原图。');
  await requireJobSeason(job);
  const result=await readImageJobImage(projectId,actorId,id,imageId);
  await verifyBoundImages(job);
  if(job.usedImageIds.includes(imageId))return view(job);
  const next=await mutate(projectId,id,expected,async(current,db)=>{
    await requireJobSeason(current,db);
    if(current.status!=='REVIEW'||current.binding!==await binding(projectId,current.keys,db))throw new Error('来源、提示词、画风或参考图已变化；保留历史原图，请重新生成。');
    await attachGeneratedAssetReference(projectId,current.key,expectedOptionsRevision,{...result.image,source:current.resultOrigin==='WEB_EXECUTOR'?'CHATGPT_WEB_GENERATED':'TASK_IMAGE_IMPORT',generationJobId:id},db);
    // The newly attached reference is an intentional material change; rebind this completed job only.
    return {...current,usedImageIds:[...current.usedImageIds,imageId],binding:await binding(projectId,current.keys,db)};
  });return view(next);
}
