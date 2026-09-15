import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {loadLightScenes} from './light-foundation-supply';
import {effectiveAutomationState} from './asset-prompt-automation';
import {buildAppearanceEvidenceIndex} from './asset-appearance-evidence';
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
const appearanceIndexes=new Map<string,ReturnType<typeof buildAppearanceEvidenceIndex>>();
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
  const scenes=await loadLightScenes(projectId,prisma).catch(()=>[]);
  const indexKey=digest([input.sourceVersion,input.sourceContext.version,(document.f2?.assets??[]).map(a=>[a.key,a.name,a.aliases]),scenes]);
  let evidenceIndex=appearanceIndexes.get(indexKey);
  if(!evidenceIndex){evidenceIndex=buildAppearanceEvidenceIndex(document.f2?.assets??[],input.sourceContext.background,input.sourceIndex.episodes,scenes);if(appearanceIndexes.size>=8)appearanceIndexes.delete(appearanceIndexes.keys().next().value!);appearanceIndexes.set(indexKey,evidenceIndex);}
  for (const base of document.f2?.assets ?? []) {
    for (const item of [base, ...base.variants]) {
      const variant = item.key !== base.key;
      const episodes = 'episodes' in item ? item.episodes : base.usageEpisodes;
      const evidence=evidenceIndex.forAsset(base.name,episodes,item.key!==base.key,item.sceneRefs,item.key===base.key?base.variants.flatMap(v=>v.sceneRefs??[]):[]);
      const entry: PromptAsset = {key:item.key,baseKey:base.key,name:item.name,baseName:base.name,type:base.type,variant,episodes,
        mode:item.preparation?.mode ?? 'UNRESOLVED',fromKey:item.preparation?.fromKey ?? (variant && item.preparation?.mode==='DERIVE'?base.key:undefined),
        description:base.description,note:[base.relationNote,variant&&'note' in item?item.note:'',item.preparation?.note,!variant&&base.variants.length?`以下状态另有子形象，不要混入基础形象：${base.variants.map(v=>v.name).join('、')}`:''].filter(Boolean).join('\n'),
        evidence,reasons:readiness.get(item.key)?.pendingReasons ?? ['尚未完成资产资料'],eligible:readiness.get(item.key)?.readyForImages ?? false,fingerprint:'',sceneRefs:item.sceneRefs};
      const {sceneRefs: _refs,...designEntry}=entry;
      entry.fingerprint=digest({entry:designEntry,sourceVersion:input.sourceVersion,decisions:selectAssetPromptDecisions(input.presentationConditions,entry)});
      assets.push(entry);
    }
  }
  return {projectId,title:input.project.title,style:input.project.style??'',stylePrefix:settings?.prefix??defaultStylePrefix(input.project.style??''),styleRevision:settings?.revision??0,assets,records,busy:delivery.busy,imageOptions,automation:automation?effectiveAutomationState(automation):undefined};
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
    const [project,systemPrompt,input]=await Promise.all([prisma.project.findUniqueOrThrow({where:{id:projectId}}),readFile(path.join(process.cwd(),'prompts/asset-image-design-v1.md'),'utf8'),loadFoundationInputs(projectId)]);
    const decisions=selectAssetPromptDecisions(input.presentationConditions,asset);
    const result=await runner({projectId,provider:resolveProvider(project.executionMode),role:{code:'A15',skill:'',systemPrompt,model:'gpt-6-astra',reasoningEffort:'low'},sessionMode:'ephemeral',
      prompt:JSON.stringify({asset,style:workspace.stylePrefix,decisions,referenceDesign:reference?{key:dependencyKey,body:reference.body,facts:reference.facts}:null,evidencePolicy:'提供的是已筛选归属的外观节选，不是全文。无节选表示当前没有可引用的外观事实，不代表原文没有。可以依据已确认资产名称与类型作可编辑初版，所有未明示的年龄、五官、服装细节必须列入suggestions，facts不得编造出处；物种、身份等关键不确定项不得猜测。不要为了填满facts而使用剧情关系、他人外貌或后期状态。'})});
    rawOutput=result.rawOutput??JSON.stringify(result.data);
    const content=validatePromptOutput(result.data,key);
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
