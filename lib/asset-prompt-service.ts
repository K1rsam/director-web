import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {readAssetVisualFacts} from './asset-visual-facts-service';
import {selectAssetVisualFacts} from './asset-visual-facts-selection';
import {effectiveAutomationState} from './asset-prompt-automation';
import {normalizeImageOptions,type AssetImageOptions} from './asset-image-options';
import { prisma } from './prisma';
import { loadFoundationInputs } from './foundation-state';
import { loadFoundationDocument } from './foundation-document';
import { getFoundationDeliveryState } from './foundation-delivery';
import { workingReadiness } from './foundation-delivery-assets';
import { runRoleByProvider, resolveProvider } from './role-runner';
import { defaultStylePrefix, emptyPrompt, validatePromptOutput, promptNeedsReview, selectAssetPromptDecisions, type PromptAsset, type PromptRecord, type PromptWorkspace } from './asset-prompt-contract';

const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const rowId = (projectId: string, key: string) => `ap15_${digest([projectId, key]).slice(0, 40)}`;
const rowKey = 'ASSET_PROMPT_V1';
type Setting = { prefix: string; revision: number };
function auditDesign(record:PromptRecord):NonNullable<PromptRecord['previousDesignAudit']>{
  const history=record.previousDesignAudit??[];
  if(!record.body&&!record.facts&&!record.suggestions&&!record.rawOutput)return history;
  const entry={revision:record.revision,body:record.body,facts:record.facts,suggestions:record.suggestions,rawOutput:record.rawOutput,origin:record.origin,updatedAt:record.updatedAt};
  return history.some(item=>JSON.stringify(item)===JSON.stringify(entry))?history:[...history,entry];
}
function currentPrompt(record:PromptRecord):PromptRecord{
  if(record.origin!=='MANUAL')return record;
  const legacyProvenance=Boolean(record.facts||record.suggestions||(['READY','EMPTY'].includes(record.status)&&record.rawOutput));
  return {...record,...(legacyProvenance?{previousDesignAudit:auditDesign(record)}:{}),facts:'',suggestions:'',...(['READY','EMPTY'].includes(record.status)?{rawOutput:undefined}:{})};
}

export async function loadAssetPromptWorkspace(projectId: string): Promise<PromptWorkspace> {
  const input = await loadFoundationInputs(projectId);
  const [{ document, needsContextEdit }, delivery, rows] = await Promise.all([
    loadFoundationDocument(prisma, projectId, input), getFoundationDeliveryState(projectId),
    prisma.sceneSnapshot.findMany({ where: { projectId, sceneKey: {in:[rowKey,'ASSET_IMAGE_OPTIONS_V1','ASSET_PROMPT_AUTOMATION_V1']} },orderBy:{createdAt:'asc'} })
  ]);
  const records: Record<string, PromptRecord> = {};
  const imageOptions:Record<string,AssetImageOptions>={};
  let settings: Setting | undefined;let automation:PromptWorkspace["automation"];
  for (const row of rows) { const value = JSON.parse(row.content); if(row.sceneKey==='ASSET_PROMPT_AUTOMATION_V1')automation=value;else if(row.sceneKey==='ASSET_IMAGE_OPTIONS_V1'&&row.title)imageOptions[row.title]=normalizeImageOptions(value);else if (row.id === rowId(projectId, '$style')) settings = value; else if (value.schema === rowKey) records[value.key] = currentPrompt(value); }
  const readiness = document.f2 ? workingReadiness(document, delivery.requiredChoices, !input.sourceContext.complete || needsContextEdit) : new Map();
  const assets: PromptAsset[] = [];
  const visual=await readAssetVisualFacts(projectId,true);
  const designSkills=await Promise.all(['asset-image-design-v1.md','asset-image-derive-v1.md'].map(name=>readFile(path.join(process.cwd(),'prompts',name),'utf8')));
  for (const base of document.f2?.assets ?? []) {
    for (const item of [base, ...base.variants]) {
      const variant = item.key !== base.key;
      const episodes = 'episodes' in item ? item.episodes : base.usageEpisodes;
      const versions=[{key:base.key,fromKey:base.preparation?.fromKey},...base.variants.map(v=>({key:v.key,fromKey:v.preparation?.fromKey??base.key}))];
      let selected:ReturnType<typeof selectAssetVisualFacts>={facts:[],issues:[]};
      try{selected=selectAssetVisualFacts(base.key,item.key,visual?.facts??[],versions);}catch(error){selected.issues.push({subjectKey:base.key,message:(error as Error).message});}
      const visualIssues=[...(visual?.issues??[]).filter(i=>i.subjectKey===base.key),...selected.issues];
      const evidence=selected.facts.map(f=>({label:f.sourceLabel??f.chunkId,text:f.attribute+'：'+f.value+'\n原文：'+f.quote}));
      const entry: PromptAsset = {key:item.key,baseKey:base.key,name:item.name,baseName:base.name,type:base.type,variant,episodes,
        mode:item.preparation?.mode ?? 'UNRESOLVED',fromKey:item.preparation?.fromKey ?? (variant && item.preparation?.mode==='DERIVE'?base.key:undefined),
        description:base.description,note:[base.relationNote,variant&&'note' in item?item.note:'',item.preparation?.note,!variant&&base.variants.length?`以下状态另有子形象，不要混入基础形象：${base.variants.map(v=>v.name).join('、')}`:''].filter(Boolean).join('\n'),
        visualFacts:selected.facts,visualIssues,evidence,reasons:readiness.get(item.key)?.pendingReasons ?? ['尚未完成资产资料'],eligible:readiness.get(item.key)?.readyForImages ?? false,fingerprint:'',sceneRefs:item.sceneRefs};
      const {sceneRefs: _refs,...designEntry}=entry;
      entry.fingerprint=digest({entry:designEntry,visualProtocol:'AB-v1',designSkill:digest(designSkills[variant?1:0]),factsReady:Boolean(visual),decisions:selectAssetPromptDecisions(input.presentationConditions,entry)});
      assets.push(entry);
    }
  }
  return {projectId,title:input.project.title,style:input.project.style??'',stylePrefix:settings?.prefix??defaultStylePrefix(input.project.style??''),styleRevision:settings?.revision??0,visualFactsStatus:visual?.complete===false?'MISSING':visual?.status??'MISSING',visualFactIssues:visual?.issues??[],assets,records,busy:delivery.busy,imageOptions,automation:automation?effectiveAutomationState(automation):undefined};
}

async function compareWrite(projectId: string, key: string, expectedRevision: number, value: PromptRecord | Setting) {
  const id=rowId(projectId,key), row=await prisma.sceneSnapshot.findUnique({where:{id}});
  if (!row) {
    if(expectedRevision!==0)throw new Error('内容已经更新，请刷新后重试。');
    try { await prisma.sceneSnapshot.create({data:{id,projectId,sceneKey:rowKey,title:key,content:JSON.stringify(value)}}); }
    catch { throw new Error('另一窗口已开始操作，请刷新后查看。'); }
  } else {
    if(JSON.parse(row.content).revision!==expectedRevision)throw new Error('另一窗口已更新此内容，请刷新后查看；你的编辑仍留在输入框。');
    const result=await prisma.sceneSnapshot.updateMany({where:{id,content:row.content},data:{content:JSON.stringify(value)}});
    if(result.count!==1)throw new Error('此内容刚被更新，请刷新后重试。');
  }
}

export async function saveAssetStyle(projectId:string, prefix:string, revision:number) {
  if(typeof prefix!=='string'||prefix.length>6000)throw new Error('通用画风请控制在6000字以内。');
  await compareWrite(projectId,'$style',revision,{prefix,revision:revision+1});
  return {prefix,revision:revision+1};
}

export async function saveAssetPrompt(projectId:string,key:string,revision:number,body:string) {
  if(typeof body!=='string'||body.length>14000)throw new Error('提示词请控制在14000字以内。');
  const workspace=await loadAssetPromptWorkspace(projectId),asset=workspace.assets.find(a=>a.key===key);
  if(!asset)throw new Error('资产已不在当前目录中，请刷新。');
  const previous=workspace.records[key]??emptyPrompt(key);
  if(previous.status==='RUNNING')throw new Error('当前资产正在生成，请等待结果后再保存。');
  const referenceKey=asset.fromKey??(asset.variant?asset.baseKey:undefined);
  // A manual rewrite has no verified mapping to the previous model's fact list.
  // Keep the design editable without laundering old AI provenance into descendants.
  const next:PromptRecord={...previous,previousDesignAudit:auditDesign(previous),body,facts:'',suggestions:'',rawOutput:undefined,requestId:undefined,workerPid:undefined,status:body.trim()?'READY':'EMPTY',revision:revision+1,origin:'MANUAL',fingerprint:asset.fingerprint,error:'',referenceKey,referenceRevision:referenceKey?workspace.records[referenceKey]?.revision:undefined,updatedAt:new Date().toISOString()};
  await compareWrite(projectId,key,revision,next);return next;
}

export async function generateAssetPrompt(projectId:string,key:string,revision:number,runner=runRoleByProvider) {
  const workspace=await loadAssetPromptWorkspace(projectId),asset=workspace.assets.find(a=>a.key===key);
  if(workspace.busy)throw new Error('第一阶段仍在整理，请完成后再生成提示词。');
  if(!asset||!asset.eligible)throw new Error(asset?.reasons.join('；')||'当前资产无需独立制图。');
  if(workspace.visualFactsStatus==='MISSING')throw new Error('请先整理剧本视觉事实，完成后再生成初版提示词。');
  const blockingIssues=asset.visualIssues?.filter(i=>i.blocking!==false)??[];
  if(blockingIssues.length)throw new Error('该资产的剧本事实仍需核对：'+blockingIssues.map(i=>i.message).join('；'));
  if(asset.variant&&!asset.visualFacts?.some(f=>f.versionKey===asset.key))throw new Error('尚未核对出该子形象的明确差异，请先核对剧本事实或手动编写变化提示词。');
  const previous=workspace.records[key]??emptyPrompt(key);
  if(previous.status==='RUNNING')throw new Error('此资产已有请求正在处理，未重复提交。');
  const dependencyKey=asset.fromKey??(asset.variant?asset.baseKey:undefined);
  const reference=dependencyKey?workspace.records[dependencyKey]:undefined;
  const referenceAsset=dependencyKey?workspace.assets.find(a=>a.key===dependencyKey):undefined;
  if(dependencyKey&&(!reference?.body||reference.status!=='READY'||!referenceAsset||promptNeedsReview(referenceAsset,workspace.records,workspace.assets)))throw new Error('请先生成或保存基础／来源资产的提示词，再生成此变体。');
  const running:PromptRecord={...previous,status:'RUNNING',error:'',revision:revision+1,requestId:randomUUID(),workerPid:process.pid,updatedAt:new Date().toISOString()};
  await compareWrite(projectId,key,revision,running);
  let rawOutput='';
  try {
    const [project,systemPrompt,input]=await Promise.all([prisma.project.findUniqueOrThrow({where:{id:projectId}}),readFile(path.join(process.cwd(),asset.variant?'prompts/asset-image-derive-v1.md':'prompts/asset-image-design-v1.md'),'utf8'),loadFoundationInputs(projectId)]);
    const decisions=selectAssetPromptDecisions(input.presentationConditions,asset);
    const result=await runner({projectId,provider:resolveProvider(project.executionMode),role:{code:asset.variant?'A15_D':'A15',skill:'',systemPrompt,model:'gpt-6-astra',reasoningEffort:'low'},sessionMode:'ephemeral',
      prompt:JSON.stringify({asset:{key:asset.key,name:asset.name,type:asset.type,variant:asset.variant},lockedFacts:[...new Map((asset.visualFacts??[]).map(f=>[JSON.stringify([f.subjectKey,f.attribute,f.value,f.versionKey,f.scope]),f])).values()],style:workspace.stylePrefix,decisions,referenceDesign:reference?{key:dependencyKey,body:reference.body}:null,evidencePolicy:'lockedFacts是唯一已核对剧本事实；资产名称只是目录标识，不能从其补写剧情事实。基础设计只补未限定的美术细节；变体仅依来源图形象与明确的版本事实写变化，不重新设计五官。没有事实表示当前核对未提取到明示外观，不代表原文绝对没有。不得把设计补足写成剧本事实。'})});
    rawOutput=result.rawOutput??JSON.stringify(result.data);
    const content={...validatePromptOutput(result.data,key),facts:asset.evidence.map(e=>e.label+'\n'+e.text).join('\n\n')};
    const current=await loadAssetPromptWorkspace(projectId);
    if(current.styleRevision!==workspace.styleRevision||current.stylePrefix!==workspace.stylePrefix||current.style!==workspace.style)throw new Error('生成期间画风已更新，本次结果已保留，请核对后采用。');
    if(current.assets.find(a=>a.key===key)?.fingerprint!==asset.fingerprint)throw new Error('生成期间来源已更新，本次结果已保留，请核对后采用。');
    if(dependencyKey&&(current.records[dependencyKey]?.revision!==reference?.revision||!current.assets.find(a=>a.key===dependencyKey)||promptNeedsReview(current.assets.find(a=>a.key===dependencyKey)!,current.records,current.assets)))throw new Error('生成期间基础形象已修改或不可用，本次结果已保留，请核对后采用。');
    const next:PromptRecord={...running,...content,status:'READY',origin:'AI',fingerprint:asset.fingerprint,rawOutput,referenceKey:dependencyKey,referenceRevision:reference?.revision,revision:running.revision+1,updatedAt:new Date().toISOString()};
    await compareWrite(projectId,key,running.revision,next);return next;
  } catch(error) {
    const captured=error as Error & {rawOutput?:string};
    const failed:PromptRecord={...running,status:'FAILED',error:captured.message||'生成失败',rawOutput:rawOutput||captured.rawOutput||'',revision:running.revision+1,updatedAt:new Date().toISOString()};
    await compareWrite(projectId,key,running.revision,failed);return failed;
  }
}

export async function recoverAssetPrompt(projectId:string,key:string,revision:number) {
  const row=await prisma.sceneSnapshot.findUnique({where:{id:rowId(projectId,key)}});
  if(!row)throw new Error('未找到待恢复请求。');
  const previous=JSON.parse(row.content) as PromptRecord;
  if(previous.status!=='RUNNING'||!previous.workerPid)throw new Error('当前请求不需要恢复。');
  let alive=true;try{process.kill(previous.workerPid,0);}catch(error){alive=(error as NodeJS.ErrnoException).code!=='ESRCH';}
  if(alive)throw new Error('执行进程仍在，请等待当前请求完成；没有重复提交。');
  const next:PromptRecord={...previous,status:'FAILED',revision:revision+1,error:'执行进程已退出，已保留原有提示词。上次结果未确认；再次点击生成会发起新请求。',updatedAt:new Date().toISOString()};
  await compareWrite(projectId,key,revision,next);return next;
}
