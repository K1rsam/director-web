import {readSeasonState,requireSeasonProduction} from './season-scope-service';
/** Current-version reads and deterministic episode supply. No model calls or publication. */
import crypto from "node:crypto";
import { readFidelityReviewCandidates } from './fidelity-store';
import {collectPhysicalEvidenceIssues} from './foundation-physical-evidence';
import type { Prisma, SceneSnapshot, PipelineRun } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { FOUNDATION_CLI_INSTRUCTION_PROFILE } from "@/lib/codex-cli";
import {readCurrentResolvedPlans} from './script-resolution-service';
import { foundationChoiceCondition, loadFoundationChoices } from "@/lib/foundation-choice-store";
import { collectProductionRepairIssues, isProductionCatalog, PRODUCTION_CATALOG_FORMAT, type Preparation, type ProductionCatalog, type ProductionVariant } from "@/lib/foundation-production-contracts";
import { loadFoundationSourceContext, type FoundationSourceContext } from "@/lib/foundation-source";
import { PRODUCTION_F2_PROTOCOL_VERSION, PRODUCTION_TASK_CONTRACT, PRODUCTION_OUTPUT_SCHEMAS } from "@/lib/foundation-production-prompts";
import {
  assembleSelections, buildSourceIndex, extractEpisodeSource, hashFoundationPrompt,
  loadFoundationSystemPrompt, PROJECT_FOUNDATION_STAGES, FoundationContractError, FOUNDATION_TASK_CONTRACT,
  collectF2DataIssues, F2_PROTOCOL_VERSION,
  type F1Output, type F2Output, type Q1Output, type FoundationIssue, type FoundationStageCode, type SourceIndex
} from "@/lib/project-foundation-contracts";

export type FoundationDb = Prisma.TransactionClient;
export type F2RecoveryPreview = {
  replayRunId: string | null; replayChunkCount: number;
  resumeRunId: string | null; resumeChunkCount: number; totalChunks: number;
  unknownRetryRunId?: string | null; unknownRetryChunkCount?: number;
};
export type FoundationRecoveries = Record<FoundationStageCode, F2RecoveryPreview | null>;
export type FoundationCandidate<T = F1Output | F2Output | Q1Output> = {
  schema: "FOUNDATION_CANDIDATE_V1";
  id: string;
  createdAt: string;
  stageCode: FoundationStageCode;
  sourceVersion: string;
  inputVersion: string;
  methodVersion?: string;
  runId: string;
  batchToken: string;
  upstreamSnapshotIds: { f1?: string; f2?: string };
  scope: number[];
  output: T;
  mechanicalIssues: FoundationIssue[];
  protocolVersion?: string;
  workflow?: string;
  finalOutput?: { f1: F1Output; f2: ProductionCatalog };
  publicationBlockers?: FoundationIssue[];
  episodePackets?: EpisodeFoundationDraft[];
};
export type EpisodeFoundationDraft = {
  schema: "EPISODE_FOUNDATION_V1";
  episode: number;
  title: string | null;
  sourceVersion: string;
  inputVersion: string;
  f1SnapshotId: string;
  f2SnapshotId: string;
  source: ReturnType<typeof extractEpisodeSource>;
  sourceSelections: ReturnType<typeof assembleSelections>;
  f1Context: string;
  f2Context: string;
  assetKeys: string[];
  backgroundRefs?: F2Output["episodes"][number]["backgroundRefs"];
  identities: Array<Pick<F2Output["assets"][number], "key" | "name" | "type" | "aliases" | "appearances"> & {
    nameBasis?: "SOURCE_WORDING" | "WORKING_LABEL" | "REGISTERED_IDENTITY";
    variants?: ProductionVariant[];
    preparation?: Preparation;
  }>;
};
export type ApprovedEpisodeFoundation = Omit<EpisodeFoundationDraft, "identities"> & {
  assetCodes: string[];
  identities: Array<EpisodeFoundationDraft["identities"][number] & { code: string; variants?: Array<ProductionVariant & { code: string }> }>;
};
export type FoundationApproval = {
  schema: "FOUNDATION_APPROVED_V1";
  id: string;
  sourceVersion: string;
  inputVersion: string;
  f1SnapshotId: string;
  f2SnapshotId: string;
  q1SnapshotId: string;
  runIds: { f1: string; f2: string; q1: string };
  episodePackets: Array<{ episode: number; snapshotId: string }>;
  assets: Array<{ key: string; id: string; code: string }>;
  publicationIssues: FoundationIssue[];
};

export function foundationJson(value: string | null | undefined): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

export async function loadFoundationInputs(projectId: string, db: FoundationDb = prisma, options: {includeResolutions?:boolean} = {}) {
  let project = await db.project.findUnique({ where: { id: projectId }, include: { episodes: { orderBy: { number: "asc" } } } });
  if (!project) throw new Error("没有找到项目。");
  const sourceContext = await loadFoundationSourceContext(projectId, db);
  const seasonState=await readSeasonState(projectId,db,{fastLegacy:true});
  const season=seasonState.mode==='season'&&seasonState.status==='locked'&&!seasonState.sourceStale?await requireSeasonProduction(projectId,undefined,'foundation',db):null;
  if(season)project={...project,episodes:season.scope.episodeNumbers.map((n:number)=>project!.episodes.find(e=>e.number===n)!)};
  const sourceIndex = buildSourceIndex(project.episodes);
  if(season){sourceIndex.episodes=project.episodes.map(e=>sourceIndex.episodes.find(r=>r.number===e.number)!);sourceIndex.version=hashFoundationPrompt(JSON.stringify(sourceIndex.episodes.map(({number,title,content})=>({number,title,content}))));}
  const resolved = options.includeResolutions === false ? new Map() : await readCurrentResolvedPlans(projectId, project.episodes, db);
  const scriptResolutions = Object.fromEntries([...resolved].map(([number, value]) => [number, value.prepared]));
  const scriptInterpretationVersions = Object.fromEntries([...resolved].map(([number, value]) => [number, value.hash]));
  const sourceReviewCandidates=await readFidelityReviewCandidates(projectId,db);
  const choices = await loadFoundationChoices(db, projectId, sourceIndex.version);
  const confirmed = await db.presentationContract.findMany({ where: { projectId, status: "CONFIRMED" }, orderBy: [{ category: "asc" }, { id: "asc" }] });
  const presentationScopeVersions = confirmed.map(entry => ({ id: entry.id, answer: entry.userAnswer, episodeId: entry.episodeId, scopeMode: entry.scopeMode, targetEpisodeNumbers: entry.targetEpisodeNumbers, ruleKey: entry.ruleKey, condition: foundationChoiceCondition(entry, project.episodes) }));
  const presentationConditions = confirmed.filter(entry => foundationChoiceCondition(entry, project.episodes).scopeResolved).map((entry) => ({
    episode: foundationChoiceCondition(entry, project.episodes).scopeMode === "ALL_EPISODES" ? null : project.episodes.find((episode) => episode.id === entry.episodeId)?.number ?? null,
    category: entry.category, question: entry.question, answer: entry.userAnswer ?? "", ...foundationChoiceCondition(entry, project.episodes)
  }));
  const projectConditions = {
    title: project.title, style: project.style ?? "未选择", aspectRatio: project.aspectRatio,
    unitMode: "未选择；本轮只整理文字资料，不排时", ruleVersion: project.ruleVersion
  };
  const systemPrompts = Object.fromEntries(PROJECT_FOUNDATION_STAGES.map((stage) => [stage.code, loadFoundationSystemPrompt(stage.code)])) as Record<FoundationStageCode, string>;
  const promptHashes = Object.fromEntries(PROJECT_FOUNDATION_STAGES.map((stage) => [stage.code, hashFoundationPrompt(systemPrompts[stage.code])]));
  const taskContract = FOUNDATION_TASK_CONTRACT;
  const sharedProductionContract = { version: PRODUCTION_TASK_CONTRACT.version, purpose: PRODUCTION_TASK_CONTRACT.purpose };
  const inputVersion = crypto.createHash("sha256").update(JSON.stringify({ sourceVersion: sourceIndex.version, ...(season?{seasonScopeHash:season.scopeHash}:{}), projectConditions, presentationConditions, presentationScopeVersions, taskContract,
    productionContract: sharedProductionContract, sourceContextVersion: sourceContext.version, ...(sourceReviewCandidates.length?{sourceReviewCandidates}:{}),
    ...(resolved.size ? {scriptInterpretationVersions} : {}) })).digest("hex");
  const methodVersions = Object.fromEntries(PROJECT_FOUNDATION_STAGES.map(({ code }) => [code, hashFoundationPrompt(JSON.stringify({
    systemPrompt: promptHashes[code], task: PRODUCTION_TASK_CONTRACT[code], schema: PRODUCTION_OUTPUT_SCHEMAS[code],
    cliInstructionProfile: FOUNDATION_CLI_INSTRUCTION_PROFILE
  }))])) as Record<FoundationStageCode, string>;
  return { project, sourceIndex, sourceContext, seasonMode:seasonState.mode, ...(season?{season}:{}), sourceVersion: sourceIndex.version, inputVersion, methodVersions, projectConditions, presentationConditions, choiceRegistry: choices.registry, systemPrompts, promptHashes, taskContract, sourceReviewCandidates,
    ...(resolved.size ? {scriptResolutions,scriptInterpretationVersions} : {}), ...(options.includeResolutions === false ? {interpretationAware:false as const} : {}) };
}

/** Structural readiness only; semantic omissions still need the independent editor. */
export function collectFoundationPublicationIssues(output: F2Output, sourceContext?: FoundationSourceContext, sourceIndex?: SourceIndex): FoundationIssue[] {
  // Derived diagnostics are not immutable author facts. Re-evaluate them against
  // current source/rules rather than demanding AI rewrite correct prose to clear history.
  if(sourceIndex&&isProductionCatalog(output))output={...output,issues:[...output.issues.filter(issue=>!issue.problem.includes('明确实体交互')),...collectPhysicalEvidenceIssues(output.assets,sourceIndex)]};
  const issues = collectF2DataIssues(output);
  if (isProductionCatalog(output) && output.format === PRODUCTION_CATALOG_FORMAT) {
    issues.push(...collectProductionRepairIssues(output));
    for (const asset of output.assets) for (const item of [asset, ...asset.variants]) {
      if (!item.preparation || item.preparation.mode === "UNRESOLVED") issues.push({ severity: "MAJOR", owner: "PROGRAM", coordinate: `assets.${item.key}.preparation`,
        problem: `${asset.name}${item === asset ? "" : ` · ${item.name}`}：${item.preparation?.note || "制作方式尚待决定"}`, sourceRefs: [] });
    }
  }
  for (const issue of sourceContext?.issues ?? []) issues.push({ severity: "MAJOR", owner: "PROGRAM", coordinate: `source.${issue.code}`, problem: issue.message, sourceRefs: [] });
  for (const notice of sourceContext?.notices ?? []) if (notice.code === "CURRENT_SOURCE_IMPORT_METADATA_UNREADABLE") issues.push({ severity: "MAJOR", owner: "PROGRAM", coordinate: `source.${notice.code}`, problem: notice.message, sourceRefs: [] });
  return issues;
}

function candidate<T>(row: SceneSnapshot | undefined): FoundationCandidate<T> | null {
  if (!row) return null;
  const body = foundationJson(row.content);
  if (body.schema !== "FOUNDATION_CANDIDATE_V1") return null;
  return { ...body, id: row.id, createdAt: row.createdAt.toISOString() } as FoundationCandidate<T>;
}

export async function getFoundationState(projectId: string, db: FoundationDb = prisma) {
  let input: Awaited<ReturnType<typeof loadFoundationInputs>>;
  try { input = await loadFoundationInputs(projectId, db); }
  catch (error) {
    if (!(error instanceof FoundationContractError)) throw error;
    const sourceContext = await loadFoundationSourceContext(projectId, db);
    return { preprocessReady: false, planningReady: false, assetsReady: false, dataReady: false, dataIssues: [] as FoundationIssue[], reviewReady: false, ready: false, draftComplete: false,
      message: `原文资料尚不可用：${error.message}`, sourceVersion: "", inputVersion: "", methodVersions: {} as Record<FoundationStageCode, string>,
      sourceContext, recoveries: { F1: null, F2: null, Q1: null } as FoundationRecoveries,
      candidates: { f1: null, f2: null }, review: null, finalOutput: null as { f1: F1Output; f2: ProductionCatalog } | null, approved: null, latestRuns: { f1: null, f2: null, q1: null }, historyRuns:[] as PipelineRun[], f2Recovery: null as F2RecoveryPreview | null };
  }
  const [snapshots, runs] = await Promise.all([
    db.sceneSnapshot.findMany({ where: { projectId, sceneKey: { in: ["FOUNDATION_SOURCE", "FOUNDATION_F1", "FOUNDATION_F2", "FOUNDATION_Q1", "FOUNDATION_APPROVED"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] }),
    db.pipelineRun.findMany({ where: { projectId, episodeId: null, stageCode: { in: ["F1", "F2", "Q1"] } }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] })
  ]);
  const f1 = candidate<F1Output>(snapshots.find((row) => row.sceneKey === "FOUNDATION_F1"));
  const f2 = candidate<F2Output>(snapshots.find((row) => row.sceneKey === "FOUNDATION_F2"));
  const review = candidate<Q1Output>(snapshots.find((row) => row.sceneKey === "FOUNDATION_Q1"));
  const approvalRow = snapshots.find((row) => row.sceneKey === "FOUNDATION_APPROVED");
  const approvalBody = foundationJson(approvalRow?.content);
  const approved = approvalRow && approvalBody.schema === "FOUNDATION_APPROVED_V1" ? { ...approvalBody, id: approvalRow.id } as FoundationApproval : null;
  const latestRuns = { f1: runs.find((run) => run.stageCode === "F1") ?? null, f2: runs.find((run) => run.stageCode === "F2") ?? null, q1: runs.find((run) => run.stageCode === "Q1") ?? null };
  const isCurrent = (draft: FoundationCandidate<unknown> | null, run: typeof latestRuns.f1) => Boolean(
    draft && run?.id === draft.runId && run.status === "SUCCEEDED" && draft.sourceVersion === input.sourceVersion && draft.inputVersion === input.inputVersion
    && ((draft.methodVersion === input.methodVersions[draft.stageCode]
      && foundationJson(run.inputSummary).methodVersion === draft.methodVersion && foundationJson(run.log).methodVersion === draft.methodVersion)
      // Unsigned records without a production workflow retain legacy read compatibility.
      || (draft.methodVersion === undefined && draft.workflow === undefined
        && foundationJson(run.inputSummary).workflow === undefined && foundationJson(run.log).workflow === undefined
        && foundationJson(run.inputSummary).methodVersion === undefined && foundationJson(run.log).methodVersion === undefined))
  );
  const preprocessReady = input.sourceIndex.episodes.length > 0 && input.sourceIndex.episodes.every((episode) => episode.content.trim().length > 0)
    && snapshots.some((row) => row.sceneKey === "FOUNDATION_SOURCE" && foundationJson(row.content).sourceVersion === input.sourceVersion);
  const planningReady = preprocessReady && isCurrent(f1, latestRuns.f1);
  const assetsReady = planningReady && isCurrent(f2, latestRuns.f2) && f2?.upstreamSnapshotIds.f1 === f1?.id
    && f2?.protocolVersion === (isProductionCatalog(f2?.output) ? PRODUCTION_F2_PROTOCOL_VERSION : F2_PROTOCOL_VERSION);
  const reviewCurrent = assetsReady && isCurrent(review, latestRuns.q1)
    && review?.upstreamSnapshotIds.f1 === f1?.id && review?.upstreamSnapshotIds.f2 === f2?.id;
  const finalOutput = reviewCurrent && review?.finalOutput && isProductionCatalog(review.finalOutput.f2) ? review.finalOutput : null;
  const dataIssues = assetsReady && f2 ? collectFoundationPublicationIssues(finalOutput?.f2 ?? f2.output, input.sourceContext) : [];
  const dataReady = assetsReady && dataIssues.length === 0;
  const hasRequiredChoices = input.choiceRegistry.some(choice => choice.status === "PENDING");
  const reviewReady = !hasRequiredChoices && reviewCurrent && dataReady && review?.output.verdict === "READY" && (!isProductionCatalog(f2?.output) || finalOutput !== null);
  const draftComplete = Boolean(reviewCurrent);
  const ready = Boolean(reviewReady && approved && approved.sourceVersion === input.sourceVersion && approved.inputVersion === input.inputVersion
    && approved.f1SnapshotId === f1?.id && approved.f2SnapshotId === f2?.id && approved.q1SnapshotId === review?.id);
  const message = hasRequiredChoices ? "当前岗位资料已保存，请先完成上方必要确认；确认后由你继续执行，不会自动调用模型。"
    : finalOutput && ready ? "资料已完成最终优化：可查看分集导航、资产与必要变体，并准备图片。原剧本与作者稿已保留；后续分镜阶段尚未启用。"
    : finalOutput ? `资料已整理为可读结果；${dataIssues.length ? `${dataIssues.length}项制作或来源选择` : "Q1列出的具体选择"}仍待决定，未标为全部可制作。无需为查看已形成的内容重跑作者。`
    : !preprocessReady ? "原文尚未完成当前版本P0准备。"
    : !planningReady ? "当前F1理解供给未完成，或源文/制作条件/规则/执行版本已变更。"
    : !assetsReady ? "当前F2身份与状态未完成，或F1版本/F2运输协议不匹配。"
    : !dataReady ? `F2候选已形成，但有${dataIssues.length}项本集资料缺口尚未补齐；${reviewCurrent ? `Q1原结论为${review?.output.verdict}，` : ""}当前不得发布批准包。`
    : !reviewCurrent ? isProductionCatalog(f2?.output) ? "资产目录已整理，下一步由Q1直接完成最后一轮优化。" : "当前候选尚未经Q1独立审核，旧批准仅保留作历史。"
    : !reviewReady ? `Q1审核结论为${review?.output.verdict}，尚未批准。`
    : !ready ? "Q1已完成审核，但当前批准包未发布。" : "当前版本已通过Q1第一阶段资料独审并保存；v0.2后续阶段尚未启用，不代表后续判断、真实生成或用户验收通过。";
  // Lazy loading avoids an initialization cycle; this verifier only uses the supplied input/F1 and read-only DB access.
  const recoveries = await (await import("@/lib/project-foundation")).previewFoundationRecoveries(projectId, input,
    { ...(planningReady && f1 ? { f1 } : {}), ...(assetsReady && f2 ? { f2 } : {}) }, runs, db);
  const f2Recovery = recoveries.F2;
  return { preprocessReady, planningReady, assetsReady, dataReady, dataIssues, reviewReady, ready, draftComplete, message, sourceVersion: input.sourceVersion, inputVersion: input.inputVersion, methodVersions: input.methodVersions, sourceContext: input.sourceContext, recoveries, candidates: { f1, f2 }, review, finalOutput, approved, latestRuns, historyRuns:runs, f2Recovery };
}

export async function requireApprovedFoundation(projectId: string, db: FoundationDb = prisma): Promise<FoundationApproval> {
  const state = await getFoundationState(projectId, db);
  if (!state.ready || !state.approved) throw new Error(`第一阶段未获当前版本批准：${state.message}`);
  return state.approved;
}

/** Build once before Q1. This same value is persisted only when that Q1 approves it. */
export function buildEpisodeFoundationPackets(index: SourceIndex, inputVersion: string, f1: FoundationCandidate<F1Output>, f2: FoundationCandidate<F2Output>): EpisodeFoundationDraft[] {
  const catalog = isProductionCatalog(f2.output) ? f2.output : null;
  return index.episodes.map((episode) => {
    const understanding = f1.output.episodes.find((item) => item.number === episode.number);
    const identity = f2.output.episodes.find((item) => item.number === episode.number);
    if (!understanding || !identity) throw new Error(`第${episode.number}集缺少F1/F2供给。`);
    const sourceSelections = assembleSelections(index, understanding.sourceSelections, index.version);
    const identities = identity.assetKeys.map((key) => {
      const asset = f2.output.assets.find((item) => item.key === key);
      if (!asset) throw new Error(`第${episode.number}集缺少身份key：${key}`);
      const appearances = asset.appearances.filter((item) => item.episode === episode.number);
      const localLabel = appearances.find((item) => item.sourceName)
        ?? identity.backgroundRefs?.find((item) => item.key === key && item.sourceName);
      const name = localLabel?.sourceName ?? asset.name;
      // This records the name's origin, not approval of its identity binding.
      const nameBasis = !localLabel ? "REGISTERED_IDENTITY" as const
        : localLabel.sourceNameMatch === "LITERAL" ? "SOURCE_WORDING" as const : "WORKING_LABEL" as const;
      const aliases = [...new Set(asset.aliases.filter((alias) => episode.content.includes(alias)))].filter((alias) => alias !== name);
      const productionAsset = catalog?.assets.find((item) => item.key === key);
      const variants = productionAsset?.variants.filter((variant) => variant.episodes.includes(episode.number));
      return { key: asset.key, name, nameBasis, type: asset.type, aliases, appearances, ...(variants ? { variants } : {}), ...(productionAsset?.preparation ? { preparation: structuredClone(productionAsset.preparation) } : {}) };
    });
    return {
      schema: "EPISODE_FOUNDATION_V1", episode: episode.number, title: episode.title,
      sourceVersion: index.version, inputVersion, f1SnapshotId: f1.id, f2SnapshotId: f2.id,
      source: extractEpisodeSource(index, episode.number, index.version),
      sourceSelections,
      f1Context: catalog ? [understanding.summary, understanding.context].filter(Boolean).join("\n\n") : understanding.context,
      f2Context: identity.context, assetKeys: identity.assetKeys, identities,
      ...(identity.backgroundRefs ? { backgroundRefs: identity.backgroundRefs } : {})
    };
  });
}

export async function readApprovedEpisodeFoundation(projectId: string, episodeNumber: number, db: FoundationDb = prisma): Promise<ApprovedEpisodeFoundation> {
  const approved = await requireApprovedFoundation(projectId, db);
  const coordinate = approved.episodePackets.find((item) => item.episode === episodeNumber);
  if (!coordinate) throw new Error(`批准版不含第${episodeNumber}集。`);
  const row = await db.sceneSnapshot.findFirst({ where: { id: coordinate.snapshotId, projectId } });
  if (!row) throw new Error(`第${episodeNumber}集批准供给缺失。`);
  const packet = foundationJson(row.content) as unknown as EpisodeFoundationDraft;
  if (packet.schema !== "EPISODE_FOUNDATION_V1" || packet.sourceVersion !== approved.sourceVersion || packet.inputVersion !== approved.inputVersion
    || packet.f1SnapshotId !== approved.f1SnapshotId || packet.f2SnapshotId !== approved.f2SnapshotId || packet.episode !== episodeNumber) throw new Error("单集供给与批准版本不一致。");
  const codes = new Map(approved.assets.map((asset) => [asset.key, asset.code]));
  const codeFor = (key: string) => { const code = codes.get(key); if (!code) throw new Error(`批准身份缺少程序编号：${key}`); return code; };
  return { ...packet, assetCodes: [...packet.assetKeys.map(codeFor), ...packet.identities.flatMap((identity) => identity.variants?.map((variant) => codeFor(variant.key)) ?? [])],
    identities: packet.identities.map(({ variants, ...identity }) => ({ ...identity, code: codeFor(identity.key),
      ...(variants ? { variants: variants.map((variant) => ({ ...variant, code: codeFor(variant.key) })) } : {}) })) };
}
