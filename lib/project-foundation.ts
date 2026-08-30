/**
 * P1/P2 第一阶段岗位化 — 流水线编排
 *
 * 结构对齐 E0–E5：queue（建 PipelineRun 记录）→ 分离 worker → execute（逐岗位执行、失败即停）。
 * P0（拆集/场次/源节点）保持 Python；P1/P2 走 CLI/API 岗位；P3（校验）Python 确定性执行。
 * 支持整批（P1→P2）与单步骤（P1 或 P2 单独跑）。
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GenerationRunStatus } from "@prisma/client";
import { assertCodexCliReady } from "@/lib/codex-cli";
import { resolveProvider, runRoleByProvider, type PipelineProvider, type RoleConfig, type RoleSessionMode } from "@/lib/role-runner";
import { prisma } from "@/lib/prisma";
import { parsePresentationEpisodeNumbers, presentationDecisionKey, resolvePresentationContractScope } from "@/lib/presentation-contracts";
import {
  buildFoundationChunks,
  FOUNDATION_ASSET_KINDS,
  buildFoundationInput,
  buildFoundationPrompt,
  compactP1Prior,
  compactP2Prior,
  inspectP1ChunkCoverage,
  loadFoundationContext,
  mergeP1Outputs,
  mergeP2Outputs,
  normalizeP2SystemSemantics,
  PROJECT_FOUNDATION_STAGES,
  requireP1,
  requireP2,
  reanchorP1PresentationDecisions,
  stripPreludeP1Episodes,
  validateFoundationP1,
  validateFoundationP2,
  type FoundationIssue,
  type FoundationStageCode,
  type P2Asset,
  type P1Output,
  type P2Output
} from "@/lib/project-foundation-contracts";

export type FoundationStageRunner = (
  stageCode: FoundationStageCode,
  prompt: string
) => Promise<{ data: Record<string, unknown>; sessionId: string | null; stdout: string; stderr: string }>;

type P1PresentationDecision = NonNullable<P1Output["presentation_decisions_needed"]>[number];

type P1PresentationRepair = {
  action: "keep" | "drop";
  decision?: P1PresentationDecision;
  reason?: string;
};

type FoundationUsageSummary = {
  source: "codex-cli" | "deepseek-api" | "unknown";
  calls: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
};

type FoundationStageDiagnostics = {
  stageCode: FoundationStageCode;
  chunks: number;
  completedChunks: number;
  resumedChunks: number;
  calls: number;
  inputChars: number;
  usage: FoundationUsageSummary;
  stdout: string;
  stderr: string;
  validationIssues?: FoundationIssue[];
};

type FoundationStageError = Error & {
  foundationDiagnostics?: FoundationStageDiagnostics;
};

const P2_CHECKPOINT_SCENE_KEY = "P2_CHECKPOINT";
const P2_CHECKPOINT_VERSION = 1;

function roleFor(stageCode: FoundationStageCode): RoleConfig {
  const stage = PROJECT_FOUNDATION_STAGES.find((item) => item.code === stageCode);
  if (!stage) throw new Error(`未知第一阶段岗位：${stageCode}`);
  return {
    code: stage.code,
    skill: stage.skill,
    model: stage.model,
    reasoningEffort: stage.reasoningEffort,
    apiReasoner: stage.apiReasoner
  };
}

async function loadProjectContext(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    include: {
      episodes: { include: { scriptScenes: { orderBy: { sortOrder: "asc" } } }, orderBy: { number: "asc" } },
      assets: true
    }
  });
  if (!project) throw new Error("没有找到项目。");
  const contracts = await prisma.presentationContract.findMany({
    where: { projectId, status: "CONFIRMED" },
    select: { category: true, userAnswer: true, episodeId: true, scopeMode: true, targetEpisodeNumbers: true },
    orderBy: { createdAt: "asc" }
  });
  const episodeNumberById = new Map(project.episodes.map((episode) => [episode.id, episode.number]));
  const formalEpisodeNumbers = project.episodes
    .map((episode) => episode.number)
    .filter((number) => number >= 1);
  const context = loadFoundationContext(
    project,
    project.episodes,
    project.assets.map((asset) => ({ code: asset.code, type: asset.type, name: asset.name, status: asset.status })),
    contracts.map((contract) => ({
      category: contract.category,
      user_answer: contract.userAnswer ?? "",
      ...(() => {
        const scope = resolvePresentationContractScope({
          scope_mode: contract.scopeMode,
          target_episode_numbers: contract.targetEpisodeNumbers,
          source_episode_number: contract.episodeId ? episodeNumberById.get(contract.episodeId) ?? null : null
        }, formalEpisodeNumbers);
        return { scope_mode: scope.mode, target_episode_numbers: scope.episodeNumbers };
      })()
    }))
  );
  return { project, context };
}

async function assertIdle(projectId: string) {
  const active = await prisma.pipelineRun.findFirst({
    where: { projectId, status: { in: ["QUEUED", "RUNNING"] } }
  });
  if (active) throw new Error("项目已有岗位正在执行（当前为单并发模式），请等待当前流程完成后重试。");
}

async function findLatestSuccessfulFoundationRun(projectId: string, stageCode: FoundationStageCode) {
  return prisma.pipelineRun.findFirst({
    where: {
      projectId,
      episodeId: null,
      stageCode,
      status: "SUCCEEDED",
      outputSummary: { not: null }
    },
    orderBy: [{ finishedAt: "desc" }, { createdAt: "desc" }],
    select: { inputSummary: true, outputSummary: true, finishedAt: true, createdAt: true }
  });
}

export async function queueProjectFoundation(projectId: string) {
  await assertIdle(projectId);
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("没有找到项目。");
  const provider = resolveProvider(project.executionMode);
  if (provider === "CLI") await assertCodexCliReady();
  const batchToken = crypto.randomUUID();
  await prisma.$transaction(
    PROJECT_FOUNDATION_STAGES.map((stage) =>
      prisma.pipelineRun.create({
        data: {
          projectId,
          episodeId: null,
          stageCode: stage.code,
          roleName: stage.name,
          provider: provider === "API" ? "DeepSeek API" : "Codex CLI",
          model: provider === "API" ? undefined : stage.model,
          status: "QUEUED",
          inputSummary: JSON.stringify({ batchToken, provider, foundation: true })
        }
      })
    )
  );
  await launchFoundationWorker(projectId, batchToken);
  return { batchToken };
}

export async function queueSingleFoundationStage(projectId: string, stageCode: string) {
  if (stageCode !== "P1" && stageCode !== "P2") throw new Error("无效的第一阶段岗位。");
  await assertIdle(projectId);
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  if (!project) throw new Error("没有找到项目。");
  const provider = resolveProvider(project.executionMode);
  if (provider === "CLI") await assertCodexCliReady();
  const stage = PROJECT_FOUNDATION_STAGES.find((item) => item.code === stageCode);
  const oppositeStage = stageCode === "P1" ? "P2" : "P1";
  const baseRun = await findLatestSuccessfulFoundationRun(projectId, oppositeStage);
  const baseSummary = safeJson(baseRun?.inputSummary);
  const batchToken = crypto.randomUUID();
  await prisma.pipelineRun.create({
    data: {
      projectId,
      episodeId: null,
      stageCode,
      roleName: stage?.name ?? stageCode,
      provider: provider === "API" ? "DeepSeek API" : "Codex CLI",
      model: provider === "API" ? undefined : stage?.model,
      status: "QUEUED",
      inputSummary: JSON.stringify({
        batchToken,
        provider,
        foundation: true,
        singleStage: true,
        baseStageCode: oppositeStage,
        baseFoundationBatchToken: typeof baseSummary.batchToken === "string" ? baseSummary.batchToken : null
      })
    }
  });
  await launchFoundationWorker(projectId, batchToken, stageCode);
  return { batchToken };
}

async function resolveFoundationBatchProvider(
  projectId: string,
  batchToken: string,
  fallbackExecutionMode: string | null | undefined
): Promise<PipelineProvider> {
  const run = await prisma.pipelineRun.findFirst({
    where: { projectId, inputSummary: { contains: batchToken } },
    orderBy: { createdAt: "asc" },
    select: { inputSummary: true }
  });
  let pinned: unknown;
  try {
    pinned = JSON.parse(run?.inputSummary ?? "{}").provider;
  } catch {
    pinned = null;
  }
  return pinned === "API" || pinned === "CLI"
    ? pinned
    : resolveProvider(fallbackExecutionMode);
}

export async function executeProjectFoundation(
  projectId: string,
  batchToken: string,
  options: { stageRunner?: FoundationStageRunner; singleStage?: FoundationStageCode } = {}
) {
  const { project, context } = await loadProjectContext(projectId);
  const provider = await resolveFoundationBatchProvider(projectId, batchToken, project.executionMode);
  const stages = options.singleStage
    ? PROJECT_FOUNDATION_STAGES.filter((stage) => stage.code === options.singleStage)
    : PROJECT_FOUNDATION_STAGES;

  for (const stage of stages) {
    const run = await prisma.pipelineRun.findFirst({
      where: { projectId, stageCode: stage.code, inputSummary: { contains: batchToken } },
      orderBy: { createdAt: "desc" }
    });
    if (!run) throw new Error(`缺少${stage.code}执行记录。`);
    const startedAt = new Date();
    const initialInput = safeJson(run.inputSummary);
    await prisma.pipelineRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt, error: null } });
    try {
      const outcome = stage.code === "P1"
        ? await executeP1(context, provider, projectId, options.stageRunner)
        : await executeP2(context, provider, projectId, options.stageRunner, batchToken);
      const finishedAt = new Date();
      const execution = {
        chunks: outcome.chunkCount,
        completedChunks: outcome.completedChunks,
        resumedChunks: outcome.resumedChunks,
        calls: outcome.callCount,
        inputChars: outcome.inputChars,
        usage: outcome.usage
      };
      await prisma.pipelineRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCEEDED",
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          inputSummary: JSON.stringify({
            ...initialInput,
            batchToken,
            provider,
            foundation: true,
            ...execution
          }),
          outputSummary: JSON.stringify({ ...outcome.summary, execution }, null, 2),
          log: JSON.stringify({ stderr: outcome.stderr.slice(-12_000), events: outcome.stdout.slice(-24_000) })
        }
      });
    } catch (error) {
      const finishedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      const diagnostics = foundationDiagnosticsOf(error, stage.code, provider);
      await prisma.pipelineRun.update({
        where: { id: run.id },
        data: {
          status: "FAILED",
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          inputSummary: JSON.stringify({
            ...initialInput,
            batchToken,
            provider,
            foundation: true,
            chunks: diagnostics.chunks,
            completedChunks: diagnostics.completedChunks,
            resumedChunks: diagnostics.resumedChunks,
            calls: diagnostics.calls,
            inputChars: diagnostics.inputChars,
            usage: diagnostics.usage
          }),
          outputSummary: JSON.stringify({
            status: "FAILED",
            stage: stage.code,
            chunks: diagnostics.chunks,
            completedChunks: diagnostics.completedChunks,
            resumedChunks: diagnostics.resumedChunks,
            calls: diagnostics.calls,
            inputChars: diagnostics.inputChars,
            usage: diagnostics.usage,
            validationIssues: diagnostics.validationIssues ?? []
          }, null, 2),
          log: JSON.stringify({
            stderr: diagnostics.stderr.slice(-12_000),
            events: diagnostics.stdout.slice(-24_000),
            validationIssues: diagnostics.validationIssues ?? []
          }),
          error: message
        }
      });
      await cancelQueuedFoundation(projectId, batchToken, `因${stage.code}失败停止：${message}`);
      throw error;
    }
  }
}

type StageOutcome = {
  chunkCount: number;
  completedChunks: number;
  resumedChunks: number;
  callCount: number;
  inputChars: number;
  stdout: string;
  stderr: string;
  usage: FoundationUsageSummary;
  summary: Record<string, unknown>;
};

function numberFrom(value: unknown) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function emptyFoundationUsage(source: FoundationUsageSummary["source"], calls = 0): FoundationUsageSummary {
  return {
    source,
    calls,
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens: null
  };
}

/** 从 Codex JSONL / DeepSeek stderr 提取本阶段的调用用量，失败时也写入流水线记录。 */
function summarizeFoundationUsage(
  provider: PipelineProvider,
  stdout: string,
  stderr: string,
  attemptedCalls = 0
): FoundationUsageSummary {
  const source: FoundationUsageSummary["source"] = provider === "CLI"
    ? "codex-cli"
    : provider === "API"
      ? "deepseek-api"
      : "unknown";
  const codexUsage: Array<Record<string, unknown>> = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event: unknown = JSON.parse(line);
      if (!isObjectRecord(event) || event.type !== "turn.completed" || !isObjectRecord(event.usage)) continue;
      codexUsage.push(event.usage);
    } catch {
      // stdout 中还可能包含普通文本或被截断的 JSON，忽略即可。
    }
  }
  if (codexUsage.length) {
    const totals = {
      input: 0,
      cached: 0,
      output: 0,
      reasoning: 0,
      total: 0
    };
    let hasInput = false;
    let hasCached = false;
    let hasOutput = false;
    let hasReasoning = false;
    let hasTotal = false;
    for (const usage of codexUsage) {
      const input = numberFrom(usage.input_tokens);
      const cached = numberFrom(usage.cached_input_tokens ?? usage.cache_read_input_tokens);
      const output = numberFrom(usage.output_tokens);
      const reasoning = numberFrom(usage.reasoning_output_tokens ?? usage.reasoning_tokens);
      const total = numberFrom(usage.total_tokens);
      if (input !== null) { totals.input += input; hasInput = true; }
      if (cached !== null) { totals.cached += cached; hasCached = true; }
      if (output !== null) { totals.output += output; hasOutput = true; }
      if (reasoning !== null) { totals.reasoning += reasoning; hasReasoning = true; }
      if (total !== null) { totals.total += total; hasTotal = true; }
    }
    return {
      source,
      calls: attemptedCalls || codexUsage.length,
      inputTokens: hasInput ? totals.input : null,
      cachedInputTokens: hasCached ? totals.cached : null,
      outputTokens: hasOutput ? totals.output : null,
      reasoningTokens: hasReasoning ? totals.reasoning : null,
      totalTokens: hasTotal ? totals.total : null
    };
  }

  const deepSeekUsage = /prompt=(\d+)\s+completion=(\d+)\s+total=(\d+)(?:\s+cache_hit=(\d+))?(?:\s+cache_miss=(\d+))?/g;
  const text = `${stdout}\n${stderr}`;
  let match: RegExpExecArray | null;
  let calls = 0;
  let inputTokens = 0;
  let cachedInputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let hasCache = false;
  while ((match = deepSeekUsage.exec(text)) !== null) {
    calls += 1;
    inputTokens += Number(match[1]);
    outputTokens += Number(match[2]);
    totalTokens += Number(match[3]);
    if (match[4]) {
      cachedInputTokens += Number(match[4]);
      hasCache = true;
    }
  }
  if (calls) {
    return {
      source,
      calls: attemptedCalls || calls,
      inputTokens,
      cachedInputTokens: hasCache ? cachedInputTokens : null,
      outputTokens,
      reasoningTokens: null,
      totalTokens
    };
  }
  return emptyFoundationUsage(source, attemptedCalls);
}

function attachFoundationDiagnostics(error: unknown, diagnostics: FoundationStageDiagnostics): FoundationStageError {
  const failure = error instanceof Error ? error as FoundationStageError : new Error(String(error)) as FoundationStageError;
  failure.foundationDiagnostics = diagnostics;
  return failure;
}

function foundationDiagnosticsOf(
  error: unknown,
  stageCode: FoundationStageCode,
  provider: PipelineProvider
): FoundationStageDiagnostics {
  const attached = error instanceof Error ? (error as FoundationStageError).foundationDiagnostics : undefined;
  if (attached) return attached;
  const detail = error instanceof Error ? error.message : String(error);
  return {
    stageCode,
    chunks: 0,
    completedChunks: 0,
    resumedChunks: 0,
    calls: 0,
    inputChars: 0,
    usage: emptyFoundationUsage(provider === "CLI" ? "codex-cli" : provider === "API" ? "deepseek-api" : "unknown"),
    stdout: "",
    stderr: detail
  };
}

async function executeP1(
  context: ReturnType<typeof loadFoundationContext>,
  provider: PipelineProvider,
  projectId: string,
  stageRunner?: FoundationStageRunner
): Promise<StageOutcome> {
  const contentLengths = new Map(context.episodes.map((episode) => [episode.number, episode.content.length]));
  const chunks = buildFoundationChunks(context, contentLengths);
  const outputs: P1Output[] = [];
  let prior = "";
  let inputChars = 0;
  let stdout = "";
  let stderr = "";
  let repairCount = 0;
  let presentationRepairCount = 0;
  let callCount = 0;

  const runP1Stage = (callPrompt: string, sessionMode: RoleSessionMode) => {
    callCount += 1;
    return stageRunner
      ? stageRunner("P1", callPrompt)
      : runRoleByProvider({
          provider,
          projectId,
          role: roleFor("P1"),
          prompt: callPrompt,
          sessionMode
        });
  };

  for (const chunk of chunks) {
    const input = buildFoundationInput(context, chunk.episodes, "P1", prior);
    const scopeLine = `本次 P1 分片只处理第 ${formatEpisodeNumbers(chunk.episodes)} 集；episodes 必须逐一覆盖这些集号，不得漏集、重复或输出其它集。presentation_decisions_needed 只输出本分片原文有证据的规则；如果此前规则在本分片再次出现，复用同一个不含集号的 rule_key 并给出本分片证据，不要只回显 prior 中未在本分片出现的规则。`;
    const prompt = buildFoundationPrompt("P1", input, scopeLine);
    inputChars += prompt.length;
    let result = await runP1Stage(prompt, "ephemeral");
    stdout += result.stdout;
    stderr += result.stderr;
    let output = stripPreludeP1Episodes(requireP1(result.data));
    let coverage = inspectP1ChunkCoverage(output, chunk.episodes);

    // 模型偶尔会漏掉分片最后一集。只补缺失集，避免重新消耗整片上下文；
    // 修复结果再与原分片合并，最终仍由全剧门禁做确定性校验。
    if (coverage.missing.length || coverage.duplicates.length || coverage.invalid) {
      repairCount += 1;
      const repairInput = buildFoundationInput(context, coverage.missing.length ? coverage.missing : chunk.episodes, "P1", prior);
      const repairScope = [
        `这是 P1 分片完整性修复。原分片要求覆盖第 ${formatEpisodeNumbers(chunk.episodes)} 集。`,
        coverage.missing.length ? `当前已返回的集号中缺少第 ${formatEpisodeNumbers(coverage.missing)} 集，请只补齐这些集。` : "请重新返回这一整片的完整 episodes 数组。",
        "不要遗漏、重复或输出不在原分片范围内的集号；返回前先逐一核对集号。"
      ].join(" ");
      const repairPrompt = buildFoundationPrompt("P1", repairInput, repairScope);
      inputChars += repairPrompt.length;
      const repairResult = await runP1Stage(repairPrompt, "ephemeral");
      stdout += repairResult.stdout;
      stderr += repairResult.stderr;
      const repairOutput = stripPreludeP1Episodes(requireP1(repairResult.data));
      const repairCoverage = inspectP1ChunkCoverage(repairOutput, chunk.episodes);
      const repairNumbers = new Set(repairCoverage.actual);
      const stillMissing = coverage.missing.filter((number) => !repairNumbers.has(number));
      if (repairCoverage.invalid || repairCoverage.unexpected.length || repairCoverage.duplicates.length || stillMissing.length) {
        throw new Error(
          `P1 第 ${formatEpisodeNumbers(chunk.episodes)} 集分片返回不完整：${formatP1CoverageProblem({
            ...repairCoverage,
            missing: stillMissing
          })}。系统已尝试自动补齐，但仍无法形成完整分片。`
        );
      }
      output = mergeP1Outputs([output, repairOutput]);
      coverage = inspectP1ChunkCoverage(output, chunk.episodes);
    }

    if (coverage.missing.length || coverage.duplicates.length || coverage.invalid) {
      throw new Error(`P1 第 ${formatEpisodeNumbers(chunk.episodes)} 集分片返回不完整：${formatP1CoverageProblem(coverage)}。`);
    }
    // 分片模型偶尔会把 prior 中的旧集一起回显；丢弃越界 episode，避免覆盖其它分片的结果。
    if (coverage.unexpected.length) {
      const expected = new Set(chunk.episodes);
      output = { ...output, episodes: output.episodes.filter((episode) => expected.has(episode.number)) };
    }
    output = reanchorP1PresentationDecisions(output, context);
    outputs.push(output);
    prior = compactP1Prior(mergeP1Outputs(outputs));
  }

  let merged = reanchorP1PresentationDecisions(mergeP1Outputs(outputs), context);
  let issues = validateFoundationP1(merged, context);
  if (issues.some((issue) => issue.code === "PRESENTATION_DECISION_UNGROUNDED" && issue.severity === "BLOCKER")) {
    const repaired = await repairP1PresentationDecisions(merged, context, issues, runP1Stage);
    merged = reanchorP1PresentationDecisions(repaired.output, context);
    issues = validateFoundationP1(merged, context);
    inputChars += repaired.inputChars;
    stdout += repaired.stdout;
    stderr += repaired.stderr;
    presentationRepairCount = 1;
  }
  raiseOnBlockers("P1", issues);
  await persistP1(context, merged);

  return {
    chunkCount: chunks.length,
    completedChunks: chunks.length,
    resumedChunks: 0,
    callCount,
    inputChars,
    stdout,
    stderr,
    usage: summarizeFoundationUsage(provider, stdout, stderr),
    summary: {
      schema: merged.schema,
      chunks: chunks.length,
      episodes: merged.episodes.length,
      relationships: merged.relationships.length,
      secrets: merged.secrets.length,
      foreshadowing: merged.foreshadowing.length,
      boundaries: merged.boundaries.length,
      repairs: repairCount,
      presentation_repairs: presentationRepairCount,
      issues
    }
  };
}

async function repairP1PresentationDecisions(
  output: P1Output,
  context: ReturnType<typeof loadFoundationContext>,
  issues: FoundationIssue[],
    runP1Stage: (prompt: string, sessionMode: RoleSessionMode) => Promise<{ data: Record<string, unknown>; sessionId: string | null; stdout: string; stderr: string }>
) {
  const decisions = output.presentation_decisions_needed ?? [];
  const targetIndexes = [...new Set(
    issues
      .filter((issue) => issue.code === "PRESENTATION_DECISION_UNGROUNDED" && issue.severity === "BLOCKER")
      .map((issue) => Number(issue.coordinate.split(".").pop()))
      .filter((index) => Number.isInteger(index) && index >= 0 && index < decisions.length)
  )].sort((a, b) => a - b);

  if (!targetIndexes.length) return { output, inputChars: 0, stdout: "", stderr: "" };

  const targets = targetIndexes.map((index) => {
    const decision = decisions[index];
    if (!decision) throw new Error("P1 表现规范证据回修找不到原始待确认项。");
    const sourceEpisode = typeof decision.episode_number === "number"
      ? context.episodeScenes.get(decision.episode_number)
      : undefined;
    return {
      target_index: index,
      decision,
      source_nodes: sourceEpisode?.scenes.flatMap((scene) => scene.source_nodes.map((node) => ({
        source_node_id: node.source_node_id,
        scene_id: node.scene_id,
        speaker: node.speaker,
        text: node.text,
        raw: node.raw
      }))) ?? []
    };
  });
  const repairInput = {
    project: {
      title: context.project.title,
      style: context.project.style ?? "未选择",
      aspect_ratio: context.project.aspectRatio
    },
    target_decisions: targets.map(({ target_index, decision }) => ({ target_index, ...decision })),
    source_candidates: targets.map(({ target_index, decision, source_nodes }) => ({
      target_index,
      episode_number: decision.episode_number ?? null,
      source_nodes
    }))
  };
  const repairPrompt = [
    "使用 $p1-project-planner 完成表现规范证据回修。你仍是 P1，必须自己重新确认语义；Python 不替你判断，也不根据关键词自动通过。",
    "只修复 target_decisions 中的表现规范项，不重新规划其它项目内容。每一个 target_index 必须返回一条 repair。",
    "如果原文确实存在且确实需要用户拍板，action 返回 keep，并在 decision 中保留完整字段：category、question、options、evidence、episode_number、episode_numbers、rule_key、source_node_refs、suggested_default、round。episode_numbers 列出同一规则涉及的正式集，episode_number 是当前证据所在主集；相同语义规则使用同一个不含集号的 rule_key；evidence 必须从对应 source_nodes 逐字摘录，source_node_refs 只能使用对应源节点 ID。",
    "如果原文无法确认、证据无法逐字锚定，或只是普通语境中的关键词，action 返回 drop，并在 reason 中说明；不要猜测，不要用关键词替代原文证据。",
    "只返回一个合法 JSON 对象，格式为 {\"repairs\":[{\"target_index\":0,\"action\":\"keep\",\"decision\":{...}} 或 {\"target_index\":0,\"action\":\"drop\",\"reason\":\"...\"}],\"issues\":[]}，必须逐一覆盖所有 target_index，不要输出 Markdown、分析过程或其它字段。",
    "INPUT_JSON:",
    JSON.stringify(repairInput)
  ].join("\n\n");
  // 回修输入已经包含目标项与原文证据，不需要把整段 P1 历史会话再带回来。
  // 使用独立短会话，避免无关历史膨胀输入并污染回修判断。
  const result = await runP1Stage(repairPrompt, "ephemeral");
  const repairs = parseP1PresentationRepairs(result.data, targets);
  const replacementByIndex = new Map<number, P1PresentationDecision | null>();
  for (const target of targets) {
    const repair = repairs.get(target.target_index);
    if (!repair) {
      throw new Error("P1 表现规范证据回修未返回第 " + (target.target_index + 1) + " 条修复结果。");
    }
    if (repair.action === "keep") {
      if (!repair.decision) throw new Error("P1 表现规范证据回修第 " + (target.target_index + 1) + " 条缺少修正内容。");
      replacementByIndex.set(target.target_index, repair.decision);
    } else {
      replacementByIndex.set(target.target_index, null);
    }
  }
  const repairedDecisions = decisions.flatMap((decision, index) => {
    if (!replacementByIndex.has(index)) return [decision];
    const replacement = replacementByIndex.get(index);
    return replacement ? [replacement] : [];
  });
  return {
    output: {
      ...output,
      presentation_decisions_needed: repairedDecisions
    },
    inputChars: repairPrompt.length,
    stdout: result.stdout,
    stderr: result.stderr
  };
}

function parseP1PresentationRepairs(
  value: Record<string, unknown>,
  targets: Array<{ target_index: number; decision: P1PresentationDecision; source_nodes: unknown[] }>
): Map<number, P1PresentationRepair> {
  const result = new Map<number, P1PresentationRepair>();
  const rawRepairs = Array.isArray(value.repairs) ? value.repairs : null;
  if (rawRepairs) {
    for (const raw of rawRepairs) {
      if (!isObjectRecord(raw)) continue;
      const targetIndex = Number(raw.target_index);
      if (!Number.isInteger(targetIndex)) continue;
      const action = String(raw.action ?? "").toLowerCase();
      if (["drop", "remove", "delete", "删除", "撤回"].includes(action)) {
        result.set(targetIndex, { action: "drop", reason: typeof raw.reason === "string" ? raw.reason : undefined });
        continue;
      }
      const rawDecision = isObjectRecord(raw.decision) ? raw.decision : raw;
      if (["keep", "replace", "修正", "保留"].includes(action) && isObjectRecord(rawDecision)) {
        result.set(targetIndex, { action: "keep", decision: normalizeP1PresentationDecision(rawDecision) });
      }
    }
    return result;
  }

  // 某些 CLI 会优先遵守 P1 原始 Output Contract，返回完整 P1 对象；兼容这种合法回修结果。
  if (Object.prototype.hasOwnProperty.call(value, "presentation_decisions_needed")) {
    const returned = Array.isArray(value.presentation_decisions_needed)
      ? value.presentation_decisions_needed.filter(isObjectRecord)
      : [];
    const used = new Set<number>();
    for (const target of targets) {
      const match = returned.findIndex((candidate, index) => !used.has(index)
        && candidate.category === target.decision.category
        && Number(candidate.episode_number) === target.decision.episode_number);
      if (match >= 0) {
        used.add(match);
        result.set(target.target_index, { action: "keep", decision: normalizeP1PresentationDecision(returned[match]) });
      } else {
        result.set(target.target_index, { action: "drop", reason: "回修结果未保留该项，视为 P1 判断无需继续确认。" });
      }
    }
  }
  return result;
}

function normalizeP1PresentationDecision(value: Record<string, unknown>): P1PresentationDecision {
  const normalized = { ...value };
  if (typeof normalized.episode_number === "string" && /^\d+$/.test(normalized.episode_number)) {
    normalized.episode_number = Number(normalized.episode_number);
  }
  if (Array.isArray(normalized.source_node_refs)) {
    normalized.source_node_refs = normalized.source_node_refs.map(String);
  }
  if (Array.isArray(normalized.episode_numbers)) {
    normalized.episode_numbers = normalized.episode_numbers
      .map((item) => Number(item))
      .filter((item) => Number.isInteger(item) && item >= 1);
  }
  if (Array.isArray(normalized.options)) {
    normalized.options = normalized.options.map(String);
  }
  if (typeof normalized.rule_key === "string") {
    normalized.rule_key = normalized.rule_key.trim();
  }
  return normalized as P1PresentationDecision;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type P2CheckpointChunk = {
  index: number;
  episodeNumbers: number[];
  output: P2Output;
};

type P2Checkpoint = {
  sourceFingerprint: string;
  chunks: P2CheckpointChunk[];
  merged: P2Output | null;
};

function foundationSourceFingerprint(context: ReturnType<typeof loadFoundationContext>) {
  const source = {
    project: {
      id: context.project.id,
      title: context.project.title,
      style: context.project.style,
      aspectRatio: context.project.aspectRatio,
      ruleVersion: context.project.ruleVersion,
      updatedAt: context.project.updatedAt.toISOString()
    },
    episodes: context.episodes.map((episode) => ({
      id: episode.id,
      number: episode.number,
      title: episode.title,
      updatedAt: episode.updatedAt.toISOString(),
      scenes: episode.scriptScenes.map((scene) => ({
        id: scene.id,
        sceneKey: scene.sceneKey,
        updatedAt: scene.updatedAt.toISOString()
      }))
    })),
    prelude: context.preludeEpisodes.map((episode) => ({
      id: episode.id,
      number: episode.number,
      updatedAt: episode.updatedAt.toISOString()
    })),
    contracts: context.contracts
  };
  return crypto.createHash("sha256").update(JSON.stringify(source)).digest("hex");
}

function parseCheckpointP2(value: unknown): P2Output | null {
  if (!isObjectRecord(value) || !Array.isArray(value.assets)) return null;
  try {
    return requireP2(value);
  } catch {
    return null;
  }
}

async function loadP2Checkpoint(projectId: string, sourceFingerprint: string): Promise<P2Checkpoint | null> {
  const snapshot = await prisma.sceneSnapshot.findFirst({
    where: { projectId, episodeId: null, sceneKey: P2_CHECKPOINT_SCENE_KEY },
    orderBy: { createdAt: "desc" }
  });
  if (!snapshot) return null;
  const metadata = safeJson(snapshot.metadata);
  if (metadata.version !== P2_CHECKPOINT_VERSION || metadata.sourceFingerprint !== sourceFingerprint) return null;
  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(snapshot.content);
    if (!isObjectRecord(parsed)) return null;
    body = parsed;
  } catch {
    return null;
  }
  const chunks = Array.isArray(body.chunks)
    ? body.chunks.flatMap((value): P2CheckpointChunk[] => {
        if (!isObjectRecord(value)) return [];
        const index = Number(value.index);
        const output = parseCheckpointP2(value.output);
        if (!Number.isInteger(index) || index < 0 || !output) return [];
        const episodeNumbers = Array.isArray(value.episodeNumbers)
          ? value.episodeNumbers.map(Number).filter((number) => Number.isInteger(number))
          : [];
        return [{ index, episodeNumbers, output }];
      })
    : [];
  return {
    sourceFingerprint,
    chunks,
    merged: parseCheckpointP2(body.merged)
  };
}

async function saveP2Checkpoint(input: {
  projectId: string;
  batchToken: string;
  sourceFingerprint: string;
  chunks: P2CheckpointChunk[];
  merged?: P2Output | null;
}) {
  const content = JSON.stringify({
    version: P2_CHECKPOINT_VERSION,
    sourceFingerprint: input.sourceFingerprint,
    batchToken: input.batchToken,
    chunks: input.chunks,
    merged: input.merged ?? null
  });
  const metadata = JSON.stringify({
    version: P2_CHECKPOINT_VERSION,
    sourceFingerprint: input.sourceFingerprint,
    batchToken: input.batchToken,
    completedChunks: input.chunks.length
  });
  const existing = await prisma.sceneSnapshot.findFirst({
    where: { projectId: input.projectId, episodeId: null, sceneKey: P2_CHECKPOINT_SCENE_KEY },
    orderBy: { createdAt: "desc" }
  });
  if (existing) {
    await prisma.sceneSnapshot.update({ where: { id: existing.id }, data: { content, metadata, title: "P2 资产拆解检查点" } });
  } else {
    await prisma.sceneSnapshot.create({
      data: {
        projectId: input.projectId,
        episodeId: null,
        sceneKey: P2_CHECKPOINT_SCENE_KEY,
        title: "P2 资产拆解检查点",
        content,
        metadata
      }
    });
  }
}

async function clearP2Checkpoint(projectId: string) {
  await prisma.sceneSnapshot.deleteMany({ where: { projectId, episodeId: null, sceneKey: P2_CHECKPOINT_SCENE_KEY } });
}

type P2RepairResult = {
  output: P2Output;
  inputChars: number;
  stdout: string;
  stderr: string;
  repairCount: number;
};

type P2Repair = {
  targetName: string;
  action: "replace" | "drop" | "keep";
  asset?: P2Asset;
  reason?: string;
};

function issueAssetName(issue: FoundationIssue) {
  const prefix = "P2.asset.";
  return issue.coordinate.startsWith(prefix) ? issue.coordinate.slice(prefix.length).trim() : null;
}

function normalizeP2Asset(value: Record<string, unknown>, fallback?: P2Asset, forceDetachParent = false): P2Asset | null {
  const name = String(value.name ?? fallback?.name ?? "").trim();
  const typeValue = String(value.type ?? fallback?.type ?? "").trim().toUpperCase();
  const allowed = new Set(["CH", "GROUP", "BEAST", "LOC", "PROP"]);
  if (!name || !allowed.has(typeValue)) return null;
  const arrayValue = (key: string, defaultValue: string[]) => Array.isArray(value[key])
    ? value[key].map(String).map((item) => item.trim()).filter(Boolean)
    : defaultValue;
  const parentValue = forceDetachParent
    ? null
    : Object.prototype.hasOwnProperty.call(value, "parent_name")
      ? (value.parent_name === null || value.parent_name === "" ? null : String(value.parent_name).trim())
      : fallback?.parent_name ?? null;
  return {
    name,
    type: typeValue as P2Asset["type"],
    role: value.role === null || value.role === undefined ? fallback?.role ?? null : String(value.role) as P2Asset["role"],
    parent_name: parentValue,
    first_seen_node: Object.prototype.hasOwnProperty.call(value, "first_seen_node")
      ? (value.first_seen_node === null || value.first_seen_node === "" ? null : String(value.first_seen_node))
      : fallback?.first_seen_node ?? null,
    scene_refs: arrayValue("scene_refs", fallback?.scene_refs ?? []),
    aliases: arrayValue("aliases", fallback?.aliases ?? []),
    evidence: String(value.evidence ?? fallback?.evidence ?? "").trim()
  };
}

function parseP2Repairs(value: Record<string, unknown>, targets: P2Asset[]): Map<string, P2Repair> {
  const repairs = new Map<string, P2Repair>();
  const rawRepairs = Array.isArray(value.repairs) ? value.repairs : [];
  for (const raw of rawRepairs) {
    if (!isObjectRecord(raw)) continue;
    const targetName = String(raw.target_name ?? raw.asset_name ?? raw.original_name ?? "").trim();
    if (!targetName) continue;
    const actionValue = String(raw.action ?? "replace").trim().toLowerCase();
    if (["drop", "delete", "删除"].includes(actionValue)) {
      repairs.set(targetName, { targetName, action: "drop", reason: typeof raw.reason === "string" ? raw.reason : undefined });
      continue;
    }
    if (["keep", "保留"].includes(actionValue)) {
      repairs.set(targetName, { targetName, action: "keep" });
      continue;
    }
    const rawAsset = isObjectRecord(raw.asset)
      ? raw.asset
      : isObjectRecord(raw.replacement)
        ? raw.replacement
        : raw;
    const forceDetachParent = ["detach_parent", "unlink_parent", "解除主资产", "脱离主资产"].includes(actionValue);
    const original = targets.find((asset) => asset.name === targetName);
    const asset = normalizeP2Asset(rawAsset, original, forceDetachParent);
    if (asset) repairs.set(targetName, { targetName, action: "replace", asset });
  }

  // 兼容模型遵循 P2 原始契约而返回完整 assets 数组的情况；只取目标资产，
  // 其它资产绝不以模型回传值覆盖。
  if (!repairs.size && Array.isArray(value.assets)) {
    for (const target of targets) {
      const returned = value.assets.find((item) => isObjectRecord(item) && String(item.name ?? "").trim() === target.name);
      if (isObjectRecord(returned)) {
        const asset = normalizeP2Asset(returned, target);
        if (asset) repairs.set(target.name, { targetName: target.name, action: "replace", asset });
      }
    }
  }
  return repairs;
}

function applyP2Repairs(output: P2Output, repairs: Map<string, P2Repair>) {
  const removed = new Set<string>();
  const renamed = new Map<string, string>();
  const assets = output.assets.flatMap((asset) => {
    const repair = repairs.get(asset.name);
    if (!repair || repair.action === "keep") return [asset];
    if (repair.action === "drop") {
      removed.add(asset.name);
      return [];
    }
    if (!repair.asset) return [asset];
    if (repair.asset.name !== asset.name) renamed.set(asset.name, repair.asset.name);
    return [repair.asset];
  });
  const scene_asset_links = output.scene_asset_links.map((link) => ({
    ...link,
    asset_names: link.asset_names
      .filter((name) => !removed.has(name))
      .map((name) => renamed.get(name) ?? name)
  }));
  return { ...output, assets, scene_asset_links };
}

async function repairP2Assets(
  output: P2Output,
  context: ReturnType<typeof loadFoundationContext>,
  issues: FoundationIssue[],
  runP2Stage: (prompt: string, sessionMode: RoleSessionMode) => Promise<{ data: Record<string, unknown>; sessionId: string | null; stdout: string; stderr: string }>
): Promise<P2RepairResult> {
  const repairableCodes = new Set(["SUB_TYPE_MISMATCH", "PARENT_MISSING", "ASSET_TYPE_INVALID", "SYSTEM_NON_HUMAN_TYPE_MISMATCH", "SYSTEM_UI_TYPE_MISMATCH"]);
  const targetNames = [...new Set(
    issues
      .filter((issue) => issue.severity === "BLOCKER" && repairableCodes.has(issue.code))
      .map(issueAssetName)
      .filter((name): name is string => Boolean(name))
  )];
  if (!targetNames.length) return { output, inputChars: 0, stdout: "", stderr: "", repairCount: 0 };

  const targets = output.assets.filter((asset) => targetNames.includes(asset.name));
  if (targets.length !== targetNames.length) {
    throw new Error(`P2 定点修复找不到目标资产：${targetNames.filter((name) => !targets.some((asset) => asset.name === name)).join("、")}`);
  }
  const relatedNames = new Set(targetNames);
  for (const asset of targets) if (asset.parent_name) relatedNames.add(asset.parent_name);
  for (const asset of output.assets) if (asset.parent_name && targetNames.includes(asset.parent_name)) relatedNames.add(asset.name);
  const relatedAssets = output.assets.filter((asset) => relatedNames.has(asset.name));
  const repairInput = {
    project: { title: context.project.title, style: context.project.style ?? "未选择", aspect_ratio: context.project.aspectRatio },
    target_assets: targets,
    related_assets: relatedAssets,
    issues: issues.filter((issue) => targetNames.includes(issueAssetName(issue) ?? "")),
    invariants: [
      "type 只能是 CH、GROUP、BEAST、LOC、PROP。",
      "parent_name 非空时必须精确指向 related_assets 中的主资产。",
      "分资产的 type 必须与主资产完全一致；人物服装/状态仍然是 CH，不得改成 BEAST、LOC 或 PROP。",
      "已确认的 system UI 规范下，系统音/系统提示/系统面板/系统界面只能是 PROP；原文明确行动的系统伪人/系统残核只能是 BEAST，不得归为 CH。",
      "只有在原 parent_name 明确挂错且目标本身应独立存在时，才可以解除 parent_name；不要为了过校验随意改名或删除资产。"
    ]
  };
  const repairPrompt = [
    "使用 $p2-asset-disassembler 完成 P2 资产类型定点修复。",
    "这不是重新拆解全剧：只处理 target_assets 与 issues 中列出的资产，related_assets 仅用于核对主资产关系。",
    "逐项返回 repairs；不要返回全量资产库，不要改动未列入 target_assets 的资产。每项 action 只能是 replace、detach_parent、drop 或 keep。replace 必须返回完整 asset 字段；detach_parent 必须保留资产其它字段并将 parent_name 设为 null；只有原文证明不是资产时才 drop。",
    "特别注意：parent_name 非空时，子资产 type 必须和主资产 type 完全相同。类型判断必须依据原文，不要为了让校验通过把人物、场景、道具互相改类。",
    "只返回一个合法 JSON 对象：{\"repairs\":[{\"target_name\":\"…\",\"action\":\"replace\",\"asset\":{…},\"reason\":\"…\"}],\"issues\":[]}。",
    "INPUT_JSON:",
    JSON.stringify(repairInput)
  ].join("\n\n");
  const result = await runP2Stage(repairPrompt, "ephemeral");
  const repairs = parseP2Repairs(result.data, targets);
  const missing = targetNames.filter((name) => !repairs.has(name));
  if (missing.length) throw new Error(`P2 定点修复未逐项返回：${missing.join("、")}`);
  return {
    output: applyP2Repairs(output, repairs),
    inputChars: repairPrompt.length,
    stdout: result.stdout,
    stderr: result.stderr,
    repairCount: repairs.size
  };
}

async function executeP2(
  context: ReturnType<typeof loadFoundationContext>,
  provider: PipelineProvider,
  projectId: string,
  stageRunner?: FoundationStageRunner,
  batchToken = ""
): Promise<StageOutcome> {
  const contentLengths = new Map(context.episodes.map((episode) => [episode.number, episode.content.length]));
  const chunks = buildFoundationChunks(context, contentLengths);
  const sourceFingerprint = foundationSourceFingerprint(context);
  const checkpoint = await loadP2Checkpoint(projectId, sourceFingerprint);
  const validCheckpointChunks = checkpoint?.chunks.filter((chunk) => chunk.index >= 0 && chunk.index < chunks.length) ?? [];
  const outputByChunk = new Map<number, P2Output>(validCheckpointChunks.map((chunk) => [
    chunk.index,
    normalizeP2SystemSemantics(chunk.output, context)
  ]));
  const orderedOutputs = () => chunks.flatMap((_chunk, index) => {
    const output = outputByChunk.get(index);
    return output ? [output] : [];
  });
  let inputChars = 0;
  let stdout = "";
  let stderr = "";
  let callCount = 0;
  let completedChunks = outputByChunk.size;
  const resumedChunks = outputByChunk.size;
  let validationIssues: FoundationIssue[] = [];
  let mergedFromCheckpoint = checkpoint?.merged ?? null;

  const runP2Stage = (callPrompt: string, sessionMode: RoleSessionMode) => {
    callCount += 1;
    return stageRunner
      ? stageRunner("P2", callPrompt)
      : runRoleByProvider({
          provider,
          projectId,
          role: roleFor("P2"),
          prompt: callPrompt,
          // P2 的跨片信息已经由 prior_assets 明确传递；不要续接上一片的整段
          // Codex 历史，否则输入会从 7 万一路膨胀到 19 万 tokens。
          sessionMode
        });
  };

  try {
    // 按自然集分片、每片一次调用输出全部类型资产。已经写入检查点的分片不再调用模型。
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (outputByChunk.has(index)) continue;
      const prior = compactP2Prior(orderedOutputs());
      const input = buildFoundationInput(context, chunk.episodes, "P2", prior);
      const scopeLine = [
        `本次任务范围：只处理第 ${formatEpisodeNumbers(chunk.episodes)} 集，输出本批全部类型的资产（CH 人物主/分资产、GROUP 群像、BEAST 非人、LOC 场景、PROP 道具）。`,
        "返回前必须逐条执行类型关系检查：parent_name 必须是原文中真实存在的主资产名；只要 parent_name 非空，分资产 type 必须与主资产 type 完全一致；人物服装/状态仍是 CH，场景状态不能挂到 PROP，道具不能挂到 LOC，不要为了凑数拆分变体。",
        "prior_assets 中的类型是已完成分片的事实，只能复用，不能改类；不要输出不属于本分片且不在 prior_assets 中的新资产。"
      ].join(" ");
      const prompt = buildFoundationPrompt("P2", input, scopeLine);
      inputChars += prompt.length;
      const result = await runP2Stage(prompt, "ephemeral");
      stdout += result.stdout;
      stderr += result.stderr;
      outputByChunk.set(index, normalizeP2SystemSemantics(requireP2(result.data), context));
      completedChunks += 1;
      mergedFromCheckpoint = null;
      await saveP2Checkpoint({
        projectId,
        batchToken,
        sourceFingerprint,
        chunks: [...outputByChunk.entries()].sort(([a], [b]) => a - b).map(([chunkIndex, output]) => ({
          index: chunkIndex,
          episodeNumbers: chunks[chunkIndex]?.episodes ?? [],
          output
        }))
      });
    }

    let merged = normalizeP2SystemSemantics(mergedFromCheckpoint ?? mergeP2Outputs(orderedOutputs()), context);
    validationIssues = validateFoundationP2(merged, context);
    const repair = await repairP2Assets(merged, context, validationIssues, runP2Stage);
    if (repair.repairCount) {
      inputChars += repair.inputChars;
      stdout += repair.stdout;
      stderr += repair.stderr;
      merged = normalizeP2SystemSemantics(repair.output, context);
      validationIssues = validateFoundationP2(merged, context);
      await saveP2Checkpoint({
        projectId,
        batchToken,
        sourceFingerprint,
        chunks: [...outputByChunk.entries()].sort(([a], [b]) => a - b).map(([chunkIndex, output]) => ({
          index: chunkIndex,
          episodeNumbers: chunks[chunkIndex]?.episodes ?? [],
          output
        })),
        merged
      });
    }
    // 不是所有门禁都适合复用旧输出（例如脏名、重复资产需要重新判断）。
    // 定点修复未命中时清掉检查点，避免下一次重试被同一份坏输出永久卡住。
    if (!repair.repairCount && validationIssues.some((issue) => issue.severity === "BLOCKER")) {
      await clearP2Checkpoint(projectId);
    }
    raiseOnBlockers("P2", validationIssues);
    await persistP2(context, merged);
    await clearP2Checkpoint(projectId);

    return {
      chunkCount: chunks.length,
      completedChunks,
      resumedChunks,
      callCount,
      inputChars,
      stdout,
      stderr,
      usage: summarizeFoundationUsage(provider, stdout, stderr, callCount),
      summary: {
        calls: callCount,
        assets: merged.assets.length,
        mainAssets: merged.assets.filter((asset) => !asset.parent_name).length,
        subAssets: merged.assets.filter((asset) => Boolean(asset.parent_name)).length,
        sceneLinks: merged.scene_asset_links.length,
        resumed_chunks: resumedChunks,
        completed_chunks: completedChunks,
        targeted_repairs: callCount > chunks.length ? callCount - chunks.length : 0,
        issues: validationIssues
      }
    };
  } catch (error) {
    throw attachFoundationDiagnostics(error, {
      stageCode: "P2",
      chunks: chunks.length,
      completedChunks,
      resumedChunks,
      calls: callCount,
      inputChars,
      usage: summarizeFoundationUsage(provider, stdout, stderr, callCount),
      stdout,
      stderr,
      validationIssues
    });
  }
}

function raiseOnBlockers(stage: string, issues: FoundationIssue[]) {
  const blockers = issues.filter((issue) => issue.severity === "BLOCKER");
  if (!blockers.length) return;
  const details = blockers.map((item) => {
    if (item.code === "EPISODE_MISSING") return `${item.evidence}（缺少该集的策划条目）`;
    if (item.code === "PRESENTATION_DECISION_UNGROUNDED") return item.evidence || item.coordinate;
    return `${item.evidence || item.coordinate}（${item.code}）`;
  });
  throw new Error(`${stage} 基础资料校验未通过：${details.join("；")}`);
}

function formatEpisodeNumbers(numbers: number[]) {
  return numbers.length ? numbers.join("、") : "无";
}

function formatP1CoverageProblem(coverage: ReturnType<typeof inspectP1ChunkCoverage>) {
  const problems: string[] = [];
  if (coverage.missing.length) problems.push(`缺少第 ${formatEpisodeNumbers(coverage.missing)} 集`);
  if (coverage.duplicates.length) problems.push(`第 ${formatEpisodeNumbers(coverage.duplicates)} 集重复`);
  if (coverage.invalid) problems.push(`${coverage.invalid} 条集号无效`);
  if (coverage.unexpected.length) problems.push(`多出第 ${formatEpisodeNumbers(coverage.unexpected)} 集`);
  return problems.join("；") || "集号覆盖异常";
}

function presentationDecisionMatchKeys(input: {
  category?: unknown;
  question?: unknown;
  rule_key?: unknown;
}) {
  return [...new Set([
    presentationDecisionKey(input),
    // 兼容旧数据库中还没有 ruleKey 的待确认卡。
    presentationDecisionKey({ category: input.category, question: input.question })
  ])];
}

/** P1 落库：替换 PROJECT_MEMORY 为结构化项目圣经 V2。 */
async function persistP1(context: ReturnType<typeof loadFoundationContext>, output: P1Output) {
  await prisma.sceneSnapshot.deleteMany({ where: { projectId: context.projectId, sceneKey: "PROJECT_MEMORY" } });
  await prisma.sceneSnapshot.create({
    data: {
      projectId: context.projectId,
      episodeId: null,
      sceneKey: "PROJECT_MEMORY",
      title: "全剧记忆快照（P1 结构化）",
      content: JSON.stringify(output, null, 2),
      metadata: JSON.stringify({ schema: output.schema, source: "P1" })
    }
  });
  // 表现规范待确认清单只由 P1 产生：每次 P1 重跑撤下本轮未再确认的旧待处理项，已确认的保留。
  const decisions = Array.isArray(output.presentation_decisions_needed) ? output.presentation_decisions_needed : [];
  const decisionEpisodeIds = new Map(
    [...context.episodes, ...(context.preludeEpisodes ?? [])].map((episode) => [episode.number, episode.id])
  );
  const decisionKeys = new Set(
    decisions.flatMap((decision) => presentationDecisionMatchKeys(decision))
  );
  const pendingContracts = await prisma.presentationContract.findMany({
    where: { projectId: context.projectId, status: "PENDING" },
    select: { id: true, category: true, question: true, ruleKey: true }
  });
  const pendingKeyById = new Map(
    pendingContracts.map((contract) => [contract.id, presentationDecisionKey({
      category: contract.category,
      question: contract.question,
      rule_key: contract.ruleKey
    })])
  );
  const pendingIdByKey = new Map<string, string>();
  const duplicatePendingIds: string[] = [];
  for (const contract of pendingContracts) {
    const keys = presentationDecisionMatchKeys({
      category: contract.category,
      question: contract.question,
      rule_key: contract.ruleKey
    });
    let hasCollision = false;
    for (const key of keys) {
      const existingId = pendingIdByKey.get(key);
      if (existingId && existingId !== contract.id) hasCollision = true;
      else if (!existingId) pendingIdByKey.set(key, contract.id);
    }
    if (hasCollision) duplicatePendingIds.push(contract.id);
  }
  const stalePendingIds = pendingContracts
    .filter((contract) => !decisionKeys.has(pendingKeyById.get(contract.id) ?? "") || duplicatePendingIds.includes(contract.id))
    .map((contract) => contract.id);
  if (stalePendingIds.length) {
    await prisma.presentationContract.updateMany({
      where: { projectId: context.projectId, id: { in: stalePendingIds } },
      data: { status: "SKIPPED", note: "P1 本轮未确认该表现元素，已撤下旧待确认项。", decidedAt: new Date() }
    });
  }
  const pendingByKey = new Map<string, string>();
  for (const [key, id] of pendingIdByKey) {
    if (!stalePendingIds.includes(id) && !pendingByKey.has(key)) pendingByKey.set(key, id);
  }
  for (const decision of decisions) {
    const episodeId = decisionEpisodeIds.get(decision.episode_number ?? -1) ?? null;
    const key = presentationDecisionKey(decision);
    const existingId = presentationDecisionMatchKeys(decision)
      .map((matchKey) => pendingByKey.get(matchKey))
      .find((id): id is string => Boolean(id));
    // 轮次：同类别已确认/历史契约的最大轮次 +1（或 P1 显式给出的 round）
    const round = decision.round ?? 1;
    const data = {
      projectId: context.projectId,
      episodeId,
      category: decision.category,
      question: decision.question,
      options: JSON.stringify(decision.options ?? []),
      evidence: decision.evidence ?? null,
      userAnswer: null,
      status: "PENDING" as const,
      round,
      note: null,
      ruleKey: decision.rule_key ?? null,
      scopeMode: "SOURCE_EPISODES",
      targetEpisodeNumbers: JSON.stringify(
        parsePresentationEpisodeNumbers(decision.episode_numbers).filter((number) => number >= 1)
          .length
          ? parsePresentationEpisodeNumbers(decision.episode_numbers).filter((number) => number >= 1)
          : typeof decision.episode_number === "number" && decision.episode_number >= 1
            ? [decision.episode_number]
            : []
      ),
      decidedAt: null
    };
    if (existingId) {
      await prisma.presentationContract.update({ where: { id: existingId }, data: { ...data, userAnswer: undefined, decidedAt: undefined } });
    } else {
      await prisma.presentationContract.create({ data });
    }
  }

  // P1 场次时间/内外/地点回写 ScriptScene（compile 直接使用，不再输出"待定"）
  for (const ep of output.episodes ?? []) {
    const dbEpisode = await prisma.episode.findFirst({ where: { projectId: context.projectId, number: ep.number } });
    if (!dbEpisode) continue;
    const scenes = await prisma.scriptScene.findMany({ where: { episodeId: dbEpisode.id }, orderBy: { sortOrder: "asc" } });
    const sceneInfos = Array.isArray(ep.scenes) ? ep.scenes : [];
    for (const [index, info] of sceneInfos.entries()) {
      const match = scenes.find((scene) => scene.sceneKey === info.scene_id) ?? scenes[index];
      if (!match) continue;
      const data: Record<string, string> = {};
      const clean = (value: unknown) => {
        const text = String(value ?? "").trim();
        return ["待确认", "待定", "待补充", "未知"].includes(text) ? "" : text;
      };
      const timeOfDay = clean(info.time_of_day);
      const interiorExterior = clean(info.interior_exterior);
      const location = clean(info.location);
      if (timeOfDay) data.timeOfDay = timeOfDay;
      if (interiorExterior) data.interiorExterior = interiorExterior;
      if (location) data.location = location;
      if (Object.keys(data).length) {
        await prisma.scriptScene.update({ where: { id: match.id }, data });
      }
    }
  }
}

/** P2 落库：重写人物/群像/非人/场景/道具资产（保留 STYLE/NEG 与已确认状态），并回写场次-资产关联。
 *  人物按「家族编号」：主形象 = CH-xxx-1，分资产（服装/状态） = CH-xxx-2、-3…（同一张脸的基础）；
 *  其余类型主资产 = TYPE-nnn，分资产 = 主资产code-N。 */
async function persistP2(context: ReturnType<typeof loadFoundationContext>, output: P2Output) {
  const confirmedNames = new Set(
    context.existingAssets
      .filter((asset) => ["CH", "LOOK", "GROUP", "BEAST", "LOC", "PROP"].includes(asset.type) && asset.status === "confirmed")
      .map((asset) => asset.name)
  );

  await prisma.asset.deleteMany({ where: { projectId: context.projectId, type: { in: ["CH", "LOOK", "GROUP", "BEAST", "LOC", "PROP"] } } });

  const counters = new Map<string, number>();
  const nextCode = (type: string) => {
    const next = (counters.get(type) ?? 0) + 1;
    counters.set(type, next);
    return `${type}-${String(next).padStart(3, "0")}`;
  };

  const mainAssets = output.assets.filter((asset) => !asset.parent_name && !isSceneFragment(asset));
  const subAssets = output.assets.filter((asset) => Boolean(asset.parent_name) && !isSceneFragment(asset));
  const idByName = new Map<string, string>();
  /** 人物主资产名 → 家族编号（如 赵清雅 → CH-002） */
  const familyByName = new Map<string, string>();

  const createAsset = async (asset: (typeof output.assets)[number], code: string, parentId: string | null) => {
    const record = await prisma.asset.create({
      data: {
        projectId: context.projectId,
        episodeId: null,
        code,
        type: asset.type,
        name: asset.name,
        status: confirmedNames.has(asset.name) ? "confirmed" : "needs_confirmation",
        firstSeenNode: asset.first_seen_node,
        sourceText: asset.evidence || null,
        notes: asset.parent_name ? `分资产：${asset.parent_name}` : null,
        parentId,
        metadata: JSON.stringify({
          aliases: asset.aliases,
          scene_refs: asset.scene_refs,
          parent_name: asset.parent_name,
          role: asset.role ?? null
        })
      }
    });
    idByName.set(asset.name, record.id);
  };

  // 人物（CH）主形象：家族编号 + "-1"；其余类型主资产：TYPE-nnn
  for (const asset of mainAssets) {
    if (asset.type === "CH") {
      const family = nextCode("CH");
      familyByName.set(asset.name, family);
      await createAsset(asset, `${family}-1`, null);
    } else {
      await createAsset(asset, nextCode(asset.type), null);
    }
  }

  const subCounters = new Map<string, number>();
  for (const asset of subAssets) {
    const parentId = asset.parent_name ? idByName.get(asset.parent_name) ?? null : null;
    const parentCode = asset.parent_name
      ? (await prisma.asset.findUnique({ where: { id: parentId ?? "" }, select: { code: true } }))?.code ?? nextCode(asset.type)
      : nextCode(asset.type);
    if (asset.type === "CH") {
      // 人物分资产：家族编号 -2、-3…
      const family = asset.parent_name ? familyByName.get(asset.parent_name) ?? parentCode.replace(/-1$/, "") : parentCode;
      const index = (subCounters.get(family) ?? 1) + 1;
      subCounters.set(family, index);
      await createAsset(asset, `${family}-${index}`, parentId);
    } else {
      const index = (subCounters.get(parentCode) ?? 0) + 1;
      subCounters.set(parentCode, index);
      await createAsset(asset, `${parentCode}-${index}`, parentId);
    }
  }

  // 场次-资产关联回写 ScriptScene.metadata.assetRefs
  for (const link of output.scene_asset_links) {
    const scene = await prisma.scriptScene.findFirst({
      where: { episode: { projectId: context.projectId }, sceneKey: link.scene_id }
    });
    if (!scene) continue;
    const metadata = safeJson(scene.metadata);
    await prisma.scriptScene.update({
      where: { id: scene.id },
      data: { metadata: JSON.stringify({ ...metadata, assetRefs: link.asset_names }) }
    });
  }
}

async function cancelQueuedFoundation(projectId: string, batchToken: string, reason: string) {
  const runs = await prisma.pipelineRun.findMany({
    where: { projectId, inputSummary: { contains: batchToken }, status: "QUEUED" }
  });
  await prisma.pipelineRun.updateMany({
    where: { id: { in: runs.map((run) => run.id) } },
    data: { status: "CANCELED" as GenerationRunStatus, finishedAt: new Date(), error: reason }
  });
}

async function launchFoundationWorker(projectId: string, batchToken: string, singleStage?: string) {
  // Windows 下不要启动 tsx CLI：tsx CLI 会再派生一个 node.exe，且内层进程
  // 不继承 windowsHide，最终会打开独立的 Windows Terminal。直接让当前 Node
  // 加载 tsx loader，worker 全程只有一个可隐藏的进程。
  const executable = process.execPath;
  const tsxDist = path.join(process.cwd(), "node_modules", "tsx", "dist");
  const tsxLoader = pathToFileURL(path.join(tsxDist, "loader.mjs")).href;
  const script = path.join(process.cwd(), "scripts", "run-project-foundation.ts");
  const args = [
    "--require", path.join(tsxDist, "preflight.cjs"),
    "--import", tsxLoader,
    script, projectId, batchToken
  ];
  if (singleStage) args.push(singleStage);
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    env: process.env,
    windowsHide: true,
    detached: true,
    stdio: "ignore"
  });
  const markLaunchFailure = (detail: unknown) => {
    const raw = detail instanceof Error ? detail.message : String(detail ?? "unknown");
    console.error(`[project-foundation] worker failed to start: ${raw}`);
    void prisma.pipelineRun.updateMany({
      where: {
        projectId,
        episodeId: null,
        inputSummary: { contains: batchToken },
        status: { in: ["QUEUED", "RUNNING"] }
      },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error: "后台执行进程启动失败：本机执行器没有成功启动。请重新运行该岗位；如果仍失败，请检查项目依赖。"
      }
    }).catch((error) => console.error("[project-foundation] failed to persist launch error", error));
  };
  child.once("error", markLaunchFailure);
  child.once("exit", (code, signal) => {
    if (code === 0 || signal) return;
    // worker 自己负责把真实执行结果写入数据库。延迟检查，只有异常退出后仍有
    // QUEUED/RUNNING 记录时才标记为意外结束，避免正常失败或用户停止造成误报。
    setTimeout(() => {
      void (async () => {
        const active = await prisma.pipelineRun.count({
          where: {
            projectId,
            episodeId: null,
            inputSummary: { contains: batchToken },
            status: { in: ["QUEUED", "RUNNING"] }
          }
        });
        if (active > 0) {
          await prisma.pipelineRun.updateMany({
            where: {
              projectId,
              episodeId: null,
              inputSummary: { contains: batchToken },
              status: { in: ["QUEUED", "RUNNING"] }
            },
            data: {
              status: "FAILED",
              finishedAt: new Date(),
              error: `后台执行进程意外结束（exit=${code ?? "null"}）。当前批次已停止，请查看执行日志后重试。`
            }
          });
          console.error(`[project-foundation] worker exited unexpectedly: exit=${code ?? "null"}`);
        }
      })().catch((error) => console.error("[project-foundation] failed to inspect worker exit", error));
    }, 1_500);
  });
  const pid = child.pid;
  if (pid) {
    try {
      const runs = await prisma.pipelineRun.findMany({
        where: { projectId, episodeId: null, inputSummary: { contains: batchToken } },
        select: { id: true, inputSummary: true }
      });
      for (const run of runs) {
        const parsed = safeJson(run.inputSummary);
        await prisma.pipelineRun.update({
          where: { id: run.id },
          data: { inputSummary: JSON.stringify({ ...parsed, workerPid: pid }) }
        });
      }
    } catch {
      // PID 记录失败不影响基础工程执行，只会暂时失去页面停止能力。
    }
  }
  child.unref();
}

function safeJson(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** 过渡性场次标题片段（如 "学院各处 -> 觉醒室走廊"、"各地（快切）"）不是单一物理地点，落库时过滤。 */
function isSceneFragment(asset: { name: string; type: string }): boolean {
  return asset.type === "LOC" && /->|快切|各处|各地|同时|转场/.test(asset.name);
}
