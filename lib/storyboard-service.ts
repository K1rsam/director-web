import "server-only";
import { createRequire } from "node:module";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from 'node:crypto';
import { currentProductionBudget, productionBudgetRoot, productionBudgetStore, withProductionBudgetContext, budgetedProductionCall } from './production-budget';
import { prisma } from "@/lib/prisma";
import { readLightEpisodeFoundation } from "@/lib/light-foundation-reader";
import { readProductionEpisodeHandoff } from './episode-upstream-material';
import { UPSTREAM_MATERIAL_PROTOCOL } from './standard-script-reception';
import { resolveCodexExecutable } from "@/lib/codex-cli";
import { episodePresentation } from "@/lib/episode-presentation";
import { isProductionEpisodeNumber, readProductionScope } from "@/lib/production-episodes";
import type { ScriptInputProtocol } from './standard-script-reception';

// Native Node owns the ESM engine and its rule files; do not bundle a second copy into React.
const nativeRequire = createRequire(path.join(process.cwd(), "package.json"));
const runtimePath = path.join(process.cwd(), "runtime/storyboard-v4");
const input = nativeRequire(path.join(runtimePath, "input.mjs"));
const STANDARD_EPISODE_PROTOCOL: 'standard-episode-v1' = input.STANDARD_EPISODE_PROTOCOL;
const sourceContext = nativeRequire(path.join(runtimePath, "source-context.mjs"));
const execution = nativeRequire(path.join(runtimePath, "core/runner.mjs"));
export const storyboardHttp = nativeRequire(path.join(runtimePath, "http.mjs"));
const executable = process.env.DIRECTOR_CODEX_CLI || resolveCodexExecutable();
// Runtime user data is deliberately outside the build tracing graph.
export const storyboardDataRoot = path.resolve(/*turbopackIgnore: true*/ process.env.DIRECTOR_STORYBOARD_DATA_DIR || path.join(process.cwd(), ".storyboard-stage3-v2"));
const storyboardArchiveRoot = path.resolve(/*turbopackIgnore: true*/ process.env.DIRECTOR_STORYBOARD_ARCHIVE_DIR || path.join(process.cwd(), '.storyboard-stage3'));
const { splitProductionMaterials, sourceEvidenceCompatible } = nativeRequire(path.join(process.cwd(), 'runtime/production-materials.mjs'));
const { withStoryboardArchive } = nativeRequire(path.join(process.cwd(), 'runtime/storyboard-archive.mjs'));
const { makeBoundaryContext, selectedActualTail } = nativeRequire(path.join(process.cwd(), 'runtime/episode-boundary.mjs'));
const { digest } = nativeRequire(path.join(runtimePath, 'core/shared.mjs'));
const { createAgreementStore, agreementSourceBasis } = nativeRequire(path.join(process.cwd(), 'runtime/production-agreements.mjs'));
const agreementStore = createAgreementStore(path.join(process.env.DIRECTOR_PRODUCTION_WORKFLOW_DIR || path.join(process.cwd(), '.production-workflows'), 'agreements'));
type RecordValue = Record<string, any>;
type Service = ReturnType<typeof makeService>;
type RunnerStatus = { ready: boolean; message: string; configurationError?: boolean; timeoutPolicy?: { plan: number; author: number; finish: number } };
const state = globalThis as unknown as { storyboardIntegratedV1?: Service; storyboardV4Status?: { at: number; value: Promise<RunnerStatus> } };

export function storyboardSourceCompatible(binding:RecordValue,prepared:RecordValue){
  return binding.sourceBasisVersion ? prepared.sourceBasisVersion===binding.sourceBasisVersion&&sourceEvidenceCompatible(binding.contextEvidence,prepared.contextEvidence) : prepared.sourceVersion===binding.sourceVersion;
}

export function storyboardChainComplete(run:RecordValue){
  const chain=run.web?.binding?.productionChain,seed=run.production?.boundary?.seed;
  const requiresActual=chain?.mode==='CHAIN'&&seed?.fromEpisode!==null&&seed?.adjacentEpisode===true&&(!chain.episodeNumbers||chain.episodeNumbers.includes(seed.fromEpisode));
  return !run.production?.blocking&&!run.production?.pendingRepair&&(!requiresActual||['NO_PREDECESSOR','NOT_CONTINUOUS','NOT_CONSUMED','MATCHED'].includes(run.production?.boundaryCheck?.status));
}

export async function loadStoryboardInput(episode: RecordValue, notes = "", protocol: ScriptInputProtocol = UPSTREAM_MATERIAL_PROTOCOL, productionScope?:{workflowId:string;runId:string},inlinePerformance=true) {
  if (!['legacy',STANDARD_EPISODE_PROTOCOL,UPSTREAM_MATERIAL_PROTOCOL].includes(protocol)) throw Object.assign(new Error('未知正文接收协议，旧任务保留。'), {code: 'SOURCE_PROTOCOL'});
  if (!isProductionEpisodeNumber(episode.number, await readProductionScope(episode.projectId))) throw Object.assign(new Error("此条目尚未归入可制作正文，不能仅按数字把作者资料或待核对范围当作正剧。请先核对来源分区；已有记录仍保留。"), { status: 409, code: "EPISODE_NOT_PRODUCTION" });
  const independentSource = await sourceContext.readEpisodeSourceContext(storyboardDataRoot, episode);
  if (independentSource) return splitProductionMaterials(input.makeEpisodeInput({ episode, project: episode.project, notes, independentSource }));
  let handoff;
  try { handoff = protocol === UPSTREAM_MATERIAL_PROTOCOL ? await readProductionEpisodeHandoff(episode.projectId, episode.number, productionScope,{inlinePerformance}) : await readLightEpisodeFoundation(episode.projectId, episode.number, prisma, {protocol,inlinePerformance}); }
  catch (error) {
    if ((error as {code?:string})?.code === 'UPSTREAM_CHANGED') throw error;
    throw Object.assign(new Error("前情资料暂无法读取，已有任务和付费稿保留，请稍后重试或先检查全剧资料。"), { status: 503, code: "CONTEXT_UNAVAILABLE" });
  }
  const prepared = splitProductionMaterials(input.makeEpisodeInput({ episode, project: episode.project, handoff, notes, inputProtocol:protocol }));
  return {...prepared, episodeBoundarySeed: handoff?.packet?.episodeBoundary ?? null};
}

export async function prepareStoryboardView(episode: RecordValue, protocol: ScriptInputProtocol = UPSTREAM_MATERIAL_PROTOCOL,inlinePerformance=true) {
  try {
    const prepared = await loadStoryboardInput(episode, '', protocol,undefined,inlinePerformance);
    if (prepared.source.diagnostics?.length) throw Object.assign(new Error(prepared.source.diagnostics.map((d: RecordValue) => d.reason).join('；')), {code: 'SOURCE_DIAGNOSTICS'});
    return { protocol,inlinePerformance, preparation: { ready: true }, sourceVersion: prepared.sourceVersion, sourceBasisVersion: prepared.sourceBasisVersion, contextEvidence:prepared.contextEvidence, sourceWarnings: prepared.warnings };
  } catch (error) {
    const { body } = storyboardFailure(error);
    return { protocol,inlinePerformance, preparation: { ready: false, ...body }, sourceVersion: null, sourceBasisVersion: null, sourceWarnings: [body.error] };
  }
}

/** Saved content is readable before freshness checks, but cannot authorize mutation or formal delivery. */
export async function storyboardSavedRunView(run:RecordValue,episode:RecordValue){
  storyboardHttp.assertEpisodeBinding(run,episode);
  const service=storyboardService(),legacy=run.web?.legacyReadOnly===true;
  const view=input.publicRun(run,{active:!legacy&&service.active(run.id),sourceStale:Boolean(run.web?.sourceStale),
    executions:legacy?[]:await service.executionStatus(run.id),scheduling:legacy?undefined:service.scheduling(run.id),
    preparation:legacy?{ready:true}:{ready:false,checking:true}});
  view.legacyReadOnly=legacy;view.sourceCheckPending=!legacy;view.blocked=true;
  view.production={boundary:run.production?.boundaryCheck??null,materialNeeds:run.production?.needs??[],pendingRepair:run.production?.pendingRepair??null,
    blocking:run.production?.blocking??false,chainMode:run.web.binding.productionChain?.mode??'SINGLE',chainComplete:storyboardChainComplete(run),sharedBudget:null};
  return view;
}

/** Reconcile only the requested run. The same immutable current input also supplies its public freshness view. */
export async function refreshStoryboardRun(run:RecordValue,episode:RecordValue){
  const protocol:ScriptInputProtocol=run.web.binding.inputProtocol??'legacy',inlinePerformance=run.web.binding.inlinePerformanceVersion==='inline-performance-v1';
  let current;
  try{
    current=await loadStoryboardInput(episode,'',protocol,run.web.binding.productionChain?.id?{workflowId:run.web.binding.productionChain.id,runId:run.id}:undefined,inlinePerformance);
    if(current.source.diagnostics?.length)throw Object.assign(new Error(current.source.diagnostics.map((d:RecordValue)=>d.reason).join('；')),{code:'SOURCE_DIAGNOSTICS'});
  }catch(error){
    const {body}=storyboardFailure(error);
    return {run,prepared:{protocol,inlinePerformance,preparation:{ready:false,...body},sourceVersion:null,sourceBasisVersion:null,sourceWarnings:[body.error]}};
  }
  const prepared={protocol,inlinePerformance,preparation:{ready:true},sourceVersion:current.sourceVersion,sourceBasisVersion:current.sourceBasisVersion,contextEvidence:current.contextEvidence,sourceWarnings:current.warnings};
  const service=storyboardService();
  if(run.production&&storyboardSourceCompatible(run.web.binding,current)){
    await reconcileProductionBudget(run);
    const context=await loadProductionContext(run.web.binding,run,service,current);
    // No new dependency evidence: do not rewrite or revalidate the same paid drafts on every poll.
    const scope=(v:RecordValue)=>({predecessorRevision:v.predecessorRevision??0,boundary:v.boundary??null,outgoingAgreements:v.outgoingAgreements??[],materials:v.materials??[]});
    if(digest(scope(run.production))!==digest(scope(context)))await service.refreshProduction(run.id,context);
  }
  return {run:await service.read(run.id),prepared};
}

function makeService() {
  const { createCoordinator } = nativeRequire(path.join(runtimePath, "coordinator.mjs"));
  const coordinator = createCoordinator({ dataRoot: storyboardDataRoot, executable, maxConcurrent: 4,
    loadProductionContext: async (binding:RecordValue, run:RecordValue) => loadProductionContext(binding,run,coordinator),
    beforeAuthorAdmission:sealOutgoingProductionAgreements,
    onSettled: async (run:RecordValue) => refreshProductionChain(run.web.binding.projectId),
    modelRunner: async (request: RecordValue, options: RecordValue) => {
      const run = await coordinator.read(options.runId), binding = run.web.binding;
      const call = () => budgetedProductionCall({projectId: binding.projectId, stage: `stage3:${request.stage}`, provider: 'CLI', model: request.settings.model, runId: options.runId, attemptId: options.attemptId}, () => execution.runModel(request, options));
      return binding.productionBudget ? withProductionBudgetContext(binding.productionBudget, call) : call();
    },
    beforeExecute: async (binding: RecordValue) => {
      const episode = await prisma.episode.findFirst({ where: { id: binding.episodeId, projectId: binding.projectId }, include: { project: true } });
      if (!episode) return false;
      const prepared = await loadStoryboardInput(episode, '', binding.inputProtocol ?? 'legacy',undefined,binding.inlinePerformanceVersion==='inline-performance-v1');
      return storyboardSourceCompatible(binding,prepared);
    }
  });
  const service = withStoryboardArchive(coordinator, storyboardArchiveRoot);
  // One free reconciliation pass on service recovery, including completed documents.
  // It never resumes a model call or installs a recurring background worker.
  Promise.resolve().then(async()=>{
    const runs = await coordinator.list();
    for(const projectId of new Set<string>(runs.filter((r:RecordValue)=>r.production).map((r:RecordValue)=>r.web.binding.projectId))) await refreshProductionChain(projectId);
  }).catch(()=>{});
  return service;
}
export function storyboardService() { return state.storyboardIntegratedV1 ??= makeService(); }

export async function storyboardRunnerStatus() {
  if (!state.storyboardV4Status || Date.now() - state.storyboardV4Status.at > 60000) {
    const value = (async () => {
      let timeoutPolicy;
      try { timeoutPolicy = execution.readTimeoutPolicy(process.env); }
      catch { return { ready: false, configurationError: true, message: "分阶段运行时限配置无效，请检查本项目的超时设置；历史记录仍可查看，未发送生成请求。" }; }
      try {
        await promisify(execFile)(executable, ["--version"], { timeout: 10000, maxBuffer: 32768 });
        await promisify(execFile)(executable, ["login", "status"], { timeout: 10000, maxBuffer: 32768 });
        return { ready: true, timeoutPolicy, message: "本机CLI已登录；新分镜使用GPT-6.1 Sol中档。登录检测不代表模型已完成真实调用。" };
      } catch { return { ready: false, timeoutPolicy, message: "本机Codex CLI未就绪，请先在终端安装并登录；未调用生成模型。" }; }
    })();
    state.storyboardV4Status = { at: Date.now(), value };
  }
  return state.storyboardV4Status.value;
}

export async function createStoryboardRun(episode: RecordValue, command: RecordValue) {
  return storyboardService().withPreparation(async () => {
  const prepared = await loadStoryboardInput(episode, command.notes || "");
  let productionBudget = command.productionBudget ?? currentProductionBudget();
  if (!productionBudget) {
    productionBudget = {id: randomUUID(), directory: productionBudgetRoot};
    await productionBudgetStore().create(productionBudget.id, {projectIds:[episode.projectId], maxCalls:40, maxTokens:2000000});
  }
  const shared = await productionBudgetStore(productionBudget.directory).read(productionBudget.id);
  if (!shared.projectIds.includes(episode.projectId)) throw Object.assign(new Error('项目不在共享预算范围内。'),{code:'PRODUCTION_BUDGET_SCOPE'});
  const { measureVoiceReference } = nativeRequire(path.join(runtimePath, "voice.mjs"));
  const voiceReference = await measureVoiceReference(prepared.source, { cacheRoot: path.join(storyboardDataRoot, "voice-cache") });
  prepared.source.context.sourceWarnings.push(...voiceReference.warnings);
  const binding = { projectId: episode.projectId, episodeId: episode.id, episodeNumber: episode.number, sourceVersion: prepared.sourceVersion, sourceBasisVersion: prepared.sourceBasisVersion, inputProtocol: UPSTREAM_MATERIAL_PROTOCOL,
    inlinePerformanceVersion:'inline-performance-v1',
    contextEvidence:prepared.contextEvidence,productionBudget, productionChain: command.productionChain ?? null };
  const production = await productionContextFromPrepared(binding,prepared,null,storyboardService());
  return storyboardService().create({ source: prepared.source, title: episodePresentation(episode.number, episode.title).fullTitle, voiceReference, binding, production,
    settings: { model: "gpt-6.1-sol", reasoning: "medium", maxUnitSeconds: command.settings?.maxUnitSeconds ?? 30, maxUnits: null,
      fantasyMode: command.settings?.fantasyMode ?? "recommended", visualStyle: prepared.visualStyle },
    budget: { maxCalls: command.maxCalls ?? 32, maxTokens: command.maxTokens ?? 300000 }
  });
  });
}

export async function sealOutgoingProductionAgreements(binding:RecordValue,run:RecordValue){
  if(!binding.productionChain?.id)return;
  const {getProductionChain,withChainSelection}=await import('./production-workflow'),chain=await getProductionChain(binding.productionChain.id,binding.projectId);
  const selected=chain.selectedRuns[String(binding.episodeNumber)];
  const unselected=()=>Object.assign(new Error('该任务已不是制作闭环选定版本，请刷新并明确选择后再开写。'),{code:'PRODUCTION_SELECTION_CHANGED',requestOutcome:'NOT_SENT'});
  if(selected!==run.id)throw unselected();
  if(!chain.episodeNumbers?.includes(binding.episodeNumber+1))return;
  const next=await readProductionEpisodeHandoff(binding.projectId,binding.episodeNumber+1),seed=next?.packet?.episodeBoundary;
  if(!seed||seed.fromEpisode!==binding.episodeNumber||seed.adjacentEpisode!==true)throw Object.assign(new Error('无法核对主创开工前的相邻集来源，未派单。'),{code:'AGREEMENT_SOURCE_UNVERIFIED',requestOutcome:'NOT_SENT'});
  const sourceBasis=agreementSourceBasis(seed);
  await withChainSelection(chain.id,binding.projectId,async selected=>{
    if(selected.selectedRuns[String(binding.episodeNumber)]!==run.id)throw unselected();
    await agreementStore.seal({chainId:chain.id,fromEpisode:binding.episodeNumber,toEpisode:binding.episodeNumber+1},{sourceBasis,predecessorRunId:run.id,selectedSuccessorRunId:selected.selectedRuns[String(binding.episodeNumber+1)]??null});
  });
}

export async function productionContextFromPrepared(binding:RecordValue,prepared:RecordValue,run:RecordValue|null,service:RecordValue) {
  let chain = binding.productionChain;
  if(chain?.id){
    const workflow = await import('./production-workflow');
    chain = await workflow.getProductionChain(chain.id,binding.projectId);
  }
  let seed = prepared.episodeBoundarySeed;
  if(!seed)return {version:'production-feedback-v1',boundary:null,materials:prepared.materials};
  const {expandEpisodeBoundarySeed,retainExpandedEpisodeBoundarySeed}=await import('./episode-boundary-seed');
  seed=retainExpandedEpisodeBoundarySeed(seed,run?.production?.boundary?.seed);
  const needs=run?.production?.needs??[],feedback=run?.plan?.productionFeedback;
  const needsPrevious=needs.some((n:RecordValue)=>n.stage===1&&['PREVIOUS_SOURCE','BOUNDARY_SOURCE'].includes(n.target)&&!n.resolved);
  if(seed.previousSource&&(needsPrevious||feedback?.relation==='UNKNOWN'&&seed.previousSource.clipped)){
    const previous=await prisma.episode.findFirst({where:{projectId:binding.projectId,number:seed.fromEpisode},select:{content:true}});
    if(previous)seed=expandEpisodeBoundarySeed(seed,previous.content);
  }
  const selectedId = chain?.selectedRuns?.[String(seed.fromEpisode)] ?? null;
  let selected=null,actual=null,previousRun:RecordValue|null=null;
  if(selectedId){
    const previous = await service.read(typeof selectedId==='string'?selectedId:selectedId.runId);
    previousRun=previous;
    if(previous.web?.legacyReadOnly||previous.web?.binding?.projectId!==binding.projectId||previous.web.binding.episodeNumber!==seed.fromEpisode)
      throw Object.assign(new Error('选定前集与本次生产链不匹配。'),{code:'PRODUCTION_CHAIN_BINDING'});
    const priorEpisode = await prisma.episode.findFirst({where:{id:previous.web.binding.episodeId,projectId:binding.projectId},include:{project:true}});
    const priorInput = priorEpisode ? await loadStoryboardInput(priorEpisode,'',previous.web.binding.inputProtocol??'legacy',undefined,previous.web.binding.inlinePerformanceVersion==='inline-performance-v1') : null;
    const compatible = priorInput&&storyboardSourceCompatible(previous.web.binding,priorInput);
    // Revalidate the scoped source in today's index instead of expiring an unrelated
    // episode merely because another episode changed the whole-series index hash.
    selected={runId:previous.id,episode:seed.fromEpisode,sourceVersion:seed.sourceVersion,selectionRevision:chain.selectionRevision};
    const tail=compatible?selectedActualTail(previous):null;
    if(tail){
      actual={...selected,version:digest(tail),...tail,sourceBasisVersion:previous.web.binding.sourceBasisVersion,validated:true};
    }
  }
  let agreements=run?.production?.boundary?.agreements??[],outgoingAgreements:RecordValue[]=[];
  if(chain?.id&&seed.fromEpisode!==null&&seed.adjacentEpisode&&chain.episodeNumbers?.includes(seed.fromEpisode)){
    const key={chainId:chain.id,fromEpisode:seed.fromEpisode,toEpisode:seed.toEpisode};
    const sourceBasis=agreementSourceBasis(seed);
    const feedback=run?.plan?.productionFeedback;
    const {withChainSelection}=await import('./production-workflow');
    const stored=await withChainSelection(chain.id,binding.projectId,async selected=>{
      if(selected.selectedRuns[String(seed.fromEpisode)]!==(typeof selectedId==='string'?selectedId:selectedId?.runId??undefined))
        throw Object.assign(new Error('前集选定版本已变化，请免费刷新承接资料后继续。'),{code:'PRODUCTION_SELECTION_CHANGED',requestOutcome:'NOT_SENT'});
      const selectedCurrent=selected.selectedRuns[String(seed.toEpisode)];
      const currentOwnsBoundary=Boolean(run&&selectedCurrent===run.id);
      const record=currentOwnsBoundary&&feedback?.relation==='DIRECT'&&feedback.sharedChoices?.length
        ?await agreementStore.publish(key,{sourceBasis,choices:feedback.sharedChoices,producerRunId:run!.id,predecessorUnstarted:!previousRun?.operations.some((o:RecordValue)=>o.stage==='author')})
        :await agreementStore.read(key);
      return record?.sealed||record?.producerRunId===selectedCurrent?record:null;
    });
    agreements=[];
    if(stored){
      if(stored.sourceBasis!==sourceBasis)throw Object.assign(new Error('跨集制作约定的原文依据已变化，请核对该边界。'),{code:'SOURCE_STALE'});
      agreements=stored.choices;
    }
  }
  if(chain?.id&&chain.episodeNumbers?.includes(binding.episodeNumber+1)){
    const {withChainSelection}=await import('./production-workflow');
    const outgoing=await withChainSelection(chain.id,binding.projectId,async selected=>{
      const record=await agreementStore.read({chainId:chain.id,fromEpisode:binding.episodeNumber,toEpisode:binding.episodeNumber+1});
      return record?.sealed||record?.producerRunId===selected.selectedRuns[String(binding.episodeNumber+1)]?record:null;
    });
    if(outgoing){
      const next=await readProductionEpisodeHandoff(binding.projectId,binding.episodeNumber+1),nextSeed=next?.packet?.episodeBoundary;
      if(!nextSeed||outgoing.sourceBasis!==agreementSourceBasis(nextSeed))throw Object.assign(new Error('出集制作约定的原文依据已变化，请核对该边界。'),{code:'SOURCE_STALE'});
      outgoingAgreements=outgoing.choices;
    }
  }
  return {version:'production-feedback-v1',predecessorRevision:previousRun?.documentRevision??0,boundary:makeBoundaryContext({seed,selected,actual,agreements,chainMode:chain?.mode??'SINGLE'}),outgoingAgreements,materials:prepared.materials};
}

async function loadProductionContext(binding:RecordValue,run:RecordValue,service:RecordValue,currentInput?:RecordValue){
  const episode=await prisma.episode.findFirst({where:{id:binding.episodeId,projectId:binding.projectId},include:{project:true}});
  if(!episode)throw Object.assign(new Error('本集来源不存在，已有记录保留。'),{code:'SOURCE_STALE'});
  const prepared=currentInput??await loadStoryboardInput(episode,'',binding.inputProtocol,binding.productionChain?.id?{workflowId:binding.productionChain.id,runId:run.id}:undefined,binding.inlinePerformanceVersion==='inline-performance-v1');
  if(!storyboardSourceCompatible(binding,prepared))throw Object.assign(new Error('原文或关键约束已变化，不能用旧任务继续。'),{code:'SOURCE_STALE'});
  const usedRefs=new Set<string>([...(run.plan?.entryFacts??[]).flatMap((f:RecordValue)=>f.sourceRefs??[]),...(run.plan?.workPackages??[]).flatMap((w:RecordValue)=>w.contextRefs??[]),...(run.adopted??[]).flatMap((a:RecordValue)=>a.draft.units.flatMap((u:RecordValue)=>u.shots.flatMap((s:RecordValue)=>s.contextRefs??[])))]);
  const currentRows=new Map<string,string>(prepared.source.contextRows.map((r:RecordValue)=>[r.id,r.text]));
  if(run.source.contextRows.some((row:RecordValue)=>usedRefs.has(row.id)&&currentRows.get(row.id)!==row.text))throw Object.assign(new Error('本任务已引用的前情原文发生变化，保留现稿并核对受影响来源。'),{code:'SOURCE_STALE'});
  return productionContextFromPrepared(binding,prepared,run,service);
}

export async function refreshProductionChain(projectId:string){
  const service=storyboardService(),runs=await service.list({projectId});
  for(const run of runs.filter((r:RecordValue)=>r.web?.binding?.projectId===projectId&&r.production&&!r.web?.legacyReadOnly)){
    try{await reconcileProductionBudget(run);await service.refreshProduction(run.id,await loadProductionContext(run.web.binding,run,service));}
    catch(error){
      // Read-only display still checks source freshness. Never launch or discard a paid result here.
      if(!['SOURCE_STALE','UPSTREAM_CHANGED','SOURCE_DIAGNOSTICS','PRODUCTION_REVISION'].includes((error as {code?:string}).code??''))throw error;
    }
  }
}

async function reconcileProductionBudget(run:RecordValue){
  const budget=run.web.binding.productionBudget;if(!budget)return;
  const ledger=productionBudgetStore(budget.directory),saved=await ledger.read(budget.id);
  for(const op of run.operations){
    const attempt=saved.attempts.find((a:RecordValue)=>a.id===op.attemptId);
    if(!attempt||attempt.totalTokens!==null||op.status!=='completed')continue;
    // Only the runner's persisted native receipt can resolve unknown cost; model JSON cannot.
    let restored;
    try{restored=await execution.readCompletedAttempt({directory:storyboardDataRoot,attemptId:op.attemptId});}
    catch(error){if((error as RecordValue).code!=='INVALID_JSON')continue;restored=error as RecordValue;}
    if(restored.requestFingerprint===op.fingerprint&&Number.isSafeInteger(restored.usage?.totalTokens))await ledger.reconcile(budget.id,op.attemptId,{totalTokens:restored.usage.totalTokens,evidenceHash:digest({attemptId:op.attemptId,usage:restored.usage,requestFingerprint:restored.requestFingerprint})});
  }
}

export async function storyboardRunView(run: RecordValue, episode: RecordValue, prepared?: Awaited<ReturnType<typeof prepareStoryboardView>>, includeDiagnostics = true) {
  storyboardHttp.assertEpisodeBinding(run, episode);
  const protocol = run.web.binding.inputProtocol ?? 'legacy';
  const legacy = run.web?.legacyReadOnly === true;
  const inlinePerformance=run.web.binding.inlinePerformanceVersion==='inline-performance-v1';
  const current = legacy ? {preparation:{ready:true},sourceVersion:run.web.binding.sourceVersion,sourceBasisVersion:run.web.binding.sourceBasisVersion,contextEvidence:run.web.binding.contextEvidence} : prepared && prepared.protocol === protocol&&prepared.inlinePerformance===inlinePerformance ? prepared : await prepareStoryboardView(episode, protocol,inlinePerformance);
  const service = storyboardService();
  const cancellations = legacy ? [] : await service.cancellationStatus(run.id);
  const sourceStale = !current.preparation.ready || (run.web.binding.sourceBasisVersion ? current.sourceBasisVersion !== run.web.binding.sourceBasisVersion||!sourceEvidenceCompatible(run.web.binding.contextEvidence,'contextEvidence' in current?current.contextEvidence:null) : current.sourceVersion !== run.web.binding.sourceVersion) || Boolean(run.web.sourceStale);
  const view = input.publicRun(run, { active: !legacy && service.active(run.id), sourceStale: !legacy && sourceStale, cancellations,
    executions: legacy ? [] : await service.executionStatus(run.id), scheduling: legacy ? undefined : service.scheduling(run.id), preparation: current.preparation });
  view.legacyReadOnly = legacy;
  view.sourceCheckPending = false;
  view.blocked ||= legacy;
  const chainMode=run.web.binding.productionChain?.mode??'SINGLE';
  const chainComplete=storyboardChainComplete(run);
  view.production = {boundary:run.production?.boundaryCheck ?? null,materialNeeds:run.production?.needs ?? [],pendingRepair:run.production?.pendingRepair??null,blocking:run.production?.blocking??false,chainMode,chainComplete,
    sharedBudget:run.web.binding.productionBudget ? await productionBudgetStore(run.web.binding.productionBudget.directory).read(run.web.binding.productionBudget.id).then((d:RecordValue)=>({maxCalls:d.maxCalls,maxTokens:d.maxTokens,...d.summary})).catch(()=>({unavailable:true})) : null};
  view.operations = view.operations.map((operation: RecordValue) => ({ ...operation,
    localPhase: operation.status === "running" ? service.executionState(run.id, operation.attemptId) : null }));
  if (!includeDiagnostics || legacy) return view;
  view.operations = await Promise.all(view.operations.map(async (operation: RecordValue) => {
    try {
      const value = await execution.readAttemptDiagnostics({ directory: storyboardDataRoot, attemptId: operation.attemptId });
      if (value && (value.attemptId !== operation.attemptId || value.stage !== operation.stage)) throw new Error("DIAGNOSTICS_BINDING");
      // Return only useful metadata, never free-form CLI output or reasoning text.
      const diagnostics = value ? { timeoutMs: value.timeoutMs, startedAt: value.startedAt, endedAt: value.endedAt,
        lastActivityAt: value.lastActivityAt, eventCount: value.eventCount, stdoutBytes: value.stdoutBytes,
        stderrBytes: value.stderrBytes, failureCategory: value.failureCategory } : null;
      return { ...operation, diagnostics, diagnosticsUnavailable: false };
    } catch { return { ...operation, diagnostics: null, diagnosticsUnavailable: true }; }
  }));
  return view;
}

export function storyboardFailure(failure: unknown) {
  const e = failure as { code?: string; message?: string; status?: number };
  const status = e.status || (e.code === "ENOENT" ? 404 : ["EACCES", "EPERM", "EIO"].includes(e.code || "") ? 500 : 409);
  return { status, body: { code: e.code || "STORYBOARD_ERROR", error: status === 500 ? "本机保存或运行环境异常，已有原稿保留。" : (e.message || "操作暂不能完成") } };
}
