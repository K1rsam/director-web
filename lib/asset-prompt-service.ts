import { createHash, randomUUID } from 'node:crypto';
import { PRODUCTION_CLI_MODEL, PRODUCTION_CLI_REASONING } from './production-model';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {readAssetVisualFacts,ensureAssetVisualFacts} from './asset-visual-facts-service';
import {normalizeAssetProductionScope,type AssetProductionScope} from './asset-visual-facts-planner';
import {readProductionScope,isProductionEpisodeNumber} from './production-episodes';
import {planAssetPromptQueue} from './asset-prompt-queue';
import {selectAssetVisualFacts} from './asset-visual-facts-selection';
import {effectiveAutomationState} from './asset-prompt-automation';
import {normalizeImageOptions,type AssetImageOptions} from './asset-image-options';
import { prisma } from './prisma';
import {projectAssetDesignFacts} from './asset-design-model-input';
import {generateScopedAssetMaterialCandidates,type AssetMaterialNeed} from './asset-material-candidates';
import {readProjectSeriesDirectionProjection} from './series-direction-service';
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

export async function loadAssetPromptWorkspace(projectId: string,scope?:AssetProductionScope): Promise<PromptWorkspace> {
  const input = await loadFoundationInputs(projectId);
  const [{ document, needsContextEdit }, delivery, rows, direction] = await Promise.all([
    loadFoundationDocument(prisma, projectId, input), getFoundationDeliveryState(projectId),
    prisma.sceneSnapshot.findMany({ where: { projectId, sceneKey: {in:[rowKey,'ASSET_IMAGE_OPTIONS_V1','ASSET_PROMPT_AUTOMATION_V1']} },orderBy:{createdAt:'asc'} }),
    readProjectSeriesDirectionProjection(projectId)
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
      entry.fingerprint=digest({entry:designEntry,visualProtocol:'AB-v1',designSkill:digest(designSkills[variant?1:0]),factsReady:Boolean(visual),decisions:selectAssetPromptDecisions(input.presentationConditions,entry),...(direction.projection?{seriesDirection:direction.projection.cardHash}:{})});
      assets.push(entry);
    }
  }
  const scoped=scope?await readAssetVisualFacts(projectId,true,scope):visual;
  return {projectId,title:input.project.title,style:input.project.style??'',stylePrefix:settings?.prefix??defaultStylePrefix(input.project.style??''),styleRevision:settings?.revision??0,seriesDirection:{status:direction.status,brief:direction.projection?.brief??null,...(direction.projection?{cardHash:direction.projection.cardHash}:{})},visualFactsStatus:scoped?.complete===false?'MISSING':scoped?.status??'MISSING',visualFactIssues:scoped?.issues??[],assets,records,busy:delivery.busy,imageOptions,automation:automation?effectiveAutomationState(automation):undefined};
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

export async function generateAssetPrompt(projectId:string,key:string,revision:number,runner=runRoleByProvider,scope?:AssetProductionScope) {
  const workspace=await loadAssetPromptWorkspace(projectId);
  let asset=workspace.assets.find(a=>a.key===key);
  const scopedFacts=scope?await readAssetVisualFacts(projectId,false,scope):null;
  if(scope){const plan=await planEpisodeAssetProduction(projectId,scope.episodeNumbers);if(!plan.assetKeys.includes(key))throw new Error('此资产不在明确选集或必需来源形象范围内。');}
  if(workspace.busy)throw new Error('第一阶段仍在整理，请完成后再生成提示词。');
  if(!asset||!asset.eligible)throw new Error(asset?.reasons.join('；')||'当前资产无需独立制图。');
  if(scope?!scopedFacts?.complete:workspace.visualFactsStatus==='MISSING')throw new Error('请先整理所选范围的剧本视觉事实，完成后再生成初版提示词。');
  if(scopedFacts){const versions=workspace.assets.filter(a=>a.baseKey===asset!.baseKey).map(a=>({key:a.key,fromKey:a.fromKey})),selected=selectAssetVisualFacts(asset.baseKey,asset.key,scopedFacts.facts,versions);asset={...asset,visualFacts:selected.facts,visualIssues:[...scopedFacts.issues.filter(i=>!i.subjectKey||i.subjectKey===asset!.baseKey),...selected.issues],evidence:selected.facts.map(f=>({label:f.sourceLabel??f.chunkId,text:f.attribute+'：'+f.value+'\n原文：'+f.quote}))};}
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
    const result=await runner({projectId,provider:resolveProvider(project.executionMode),role:{code:asset.variant?'A15_D':'A15',skill:'',systemPrompt,model:PRODUCTION_CLI_MODEL,reasoningEffort:PRODUCTION_CLI_REASONING},sessionMode:'ephemeral',
      prompt:JSON.stringify({asset:{key:asset.key,name:asset.name,type:asset.type,variant:asset.variant},...projectAssetDesignFacts(asset.visualFacts??[]),style:workspace.stylePrefix,...(workspace.seriesDirection?.status==='CONFIRMED'?{seriesDirection:workspace.seriesDirection.brief}:{}),decisions,referenceDesign:reference?{key:dependencyKey,body:reference.body}:null,evidencePolicy:'原文引用是事实依据，提取记录不是用户确认；资产名称只是目录标识。全剧方向仅约束表达气质，不是外貌或剧情事实。基础设计只补未限定的美术细节；变体仅依来源形象与明确版本事实写变化，不重新设计五官。未提取到外观不代表原文绝对没有；冲突留待核对，设计补足不得冒充剧本事实。'})});
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

/** Explicit scope entry. The full catalogue is read only as an index; only these keys enter generation. */
export async function planEpisodeAssetProduction(projectId:string,episodeNumbers:number[],requestedAssetKeys?:string[]){
 const [workspace,input,production]=await Promise.all([loadAssetPromptWorkspace(projectId),loadFoundationInputs(projectId),readProductionScope(projectId)]);
 const scope=normalizeAssetProductionScope({episodeNumbers},input.sourceIndex.episodes.filter(e=>isProductionEpisodeNumber(e.number,production)).map(e=>e.number));
 const actual=workspace.assets.filter(asset=>asset.episodes.some(n=>scope.episodeNumbers.includes(n))).map(asset=>asset.key);
 let keys=new Set(actual);const visiting=new Set<string>();
 const visit=(key:string)=>{if(visiting.has(key))throw new Error('资产来源存在循环，请先核对。');const asset=workspace.assets.find(a=>a.key===key);if(!asset)throw new Error('来源资产不存在，请先核对。');const parent=asset.fromKey??(asset.variant?asset.baseKey:undefined);if(!parent)return;visiting.add(key);if(!keys.has(parent)){keys.add(parent);visit(parent);}else if(visiting.has(parent))throw new Error('资产来源存在循环，请先核对。');visiting.delete(key);};
 actual.forEach(visit);
 if(requestedAssetKeys!==undefined){if(!Array.isArray(requestedAssetKeys)||requestedAssetKeys.some(key=>typeof key!=='string'||!keys.has(key)))throw new Error('请求资产越出明确选集及必要来源范围。');keys=new Set(requestedAssetKeys);requestedAssetKeys.forEach(visit);}
 return {scope:{...scope,assetKeys:[...keys]},assetKeys:[...keys],actualAssetKeys:actual.filter(key=>keys.has(key)),materialSourceOnlyKeys:[...keys].filter(key=>!actual.includes(key)),eligibleKeys:[...keys].filter(key=>workspace.assets.find(a=>a.key===key)?.eligible),sourceVersion:input.sourceVersion};
}

/** Called only by an explicitly authorized production action; never by a read or preview. */
export async function generateAssetPromptsForEpisodes(projectId:string,episodeNumbers:number[],options:{assetKeys?:string[];materialNeeds?:AssetMaterialNeed[];runner?:typeof runRoleByProvider;shouldContinue?:()=>Promise<boolean>}={}){
 const plan=await planEpisodeAssetProduction(projectId,episodeNumbers,options.assetKeys),runner=options.runner??runRoleByProvider;
 const check=async()=>{if(options.shouldContinue&&!await options.shouldContinue())throw new Error('所选范围的后续资产任务已停止。');if((await loadFoundationInputs(projectId)).sourceVersion!==plan.sourceVersion)throw new Error('原文已更新，未继续后续资产任务。');};
 await check();
 if(options.materialNeeds!==undefined){
  if(options.assetKeys===undefined)throw new Error('局部材料需求必须明确限定资产键，不默认扫描全库。');
  return {...plan,results:await generateScopedAssetMaterialCandidates(projectId,plan,await loadAssetPromptWorkspace(projectId),options.materialNeeds,runner,check)};
 }
 if(!plan.eligibleKeys.length)return {...plan,results:[] as PromptRecord[]};
 const before=await loadAssetPromptWorkspace(projectId),needed=plan.eligibleKeys.filter(key=>{const asset=before.assets.find(a=>a.key===key)!,record=before.records[key];return !record?.body||record.status!=='READY'||promptNeedsReview(asset,before.records,before.assets);});
 if(!needed.length)return {...plan,results:[] as PromptRecord[]};
 if(needed.some(key=>before.records[key]?.origin==='MANUAL'&&before.records[key].body))throw new Error('人工提示词已保留，请先核对来源并保存，不自动覆盖。');
 await ensureAssetVisualFacts(projectId,runner,{scope:plan.scope,shouldContinue:async()=>{await check();return true;}});
 const workspace=await loadAssetPromptWorkspace(projectId),requested=plan.eligibleKeys.filter(key=>{const asset=workspace.assets.find(a=>a.key===key)!;const record=workspace.records[key];return !record?.body||record.status!=='READY'||promptNeedsReview(asset,workspace.records,workspace.assets);});
 const keys=planAssetPromptQueue(workspace,requested),results:PromptRecord[]=[];
 for(const key of keys){await check();const current=(await loadAssetPromptWorkspace(projectId)).records[key];if(current?.origin==='MANUAL'&&current.body)throw new Error('人工提示词已保留，请先核对来源并保存，不自动覆盖。');const result=await generateAssetPrompt(projectId,key,current?.revision??0,runner,plan.scope);results.push(result);if(result.status!=='READY')break;}
 return {...plan,results};
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
