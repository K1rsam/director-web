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
import type { GenerationRunStatus } from "@prisma/client";
import { assertCodexCliReady } from "@/lib/codex-cli";
import { resolveProvider, runRoleByProvider, type PipelineProvider, type RoleConfig } from "@/lib/role-runner";
import { prisma } from "@/lib/prisma";
import {
  buildFoundationChunks,
  FOUNDATION_ASSET_KINDS,
  buildFoundationInput,
  buildFoundationPrompt,
  compactP1Prior,
  compactP2Prior,
  loadFoundationContext,
  mergeP1Outputs,
  mergeP2Outputs,
  PROJECT_FOUNDATION_STAGES,
  requireP1,
  requireP2,
  validateFoundationP1,
  validateFoundationP2,
  type FoundationIssue,
  type FoundationStageCode,
  type P1Output,
  type P2Output
} from "@/lib/project-foundation-contracts";

export type FoundationStageRunner = (
  stageCode: FoundationStageCode,
  prompt: string
) => Promise<{ data: Record<string, unknown>; sessionId: string | null; stdout: string; stderr: string }>;

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
    select: { category: true, userAnswer: true },
    orderBy: { createdAt: "asc" }
  });
  const context = loadFoundationContext(
    project,
    project.episodes,
    project.assets.map((asset) => ({ code: asset.code, type: asset.type, name: asset.name, status: asset.status })),
    contracts.map((contract) => ({ category: contract.category, user_answer: contract.userAnswer ?? "" }))
  );
  return { project, context };
}

async function assertIdle(projectId: string) {
  const active = await prisma.pipelineRun.findFirst({
    where: { projectId, status: { in: ["QUEUED", "RUNNING"] } }
  });
  if (active) throw new Error("项目已有岗位正在执行（当前为单并发模式），请等待当前流程完成后重试。");
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
      inputSummary: JSON.stringify({ batchToken, provider, foundation: true, singleStage: true })
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
    await prisma.pipelineRun.update({ where: { id: run.id }, data: { status: "RUNNING", startedAt, error: null } });
    try {
      const outcome = stage.code === "P1"
        ? await executeP1(context, provider, projectId, options.stageRunner)
        : await executeP2(context, provider, projectId, options.stageRunner);
      const finishedAt = new Date();
      await prisma.pipelineRun.update({
        where: { id: run.id },
        data: {
          status: "SUCCEEDED",
          finishedAt,
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          inputSummary: JSON.stringify({ batchToken, provider, foundation: true, chunks: outcome.chunkCount, inputChars: outcome.inputChars }),
          outputSummary: JSON.stringify(outcome.summary, null, 2),
          log: JSON.stringify({ stderr: outcome.stderr.slice(-12_000), events: outcome.stdout.slice(-24_000) })
        }
      });
    } catch (error) {
      const finishedAt = new Date();
      const message = error instanceof Error ? error.message : String(error);
      await prisma.pipelineRun.update({
        where: { id: run.id },
        data: { status: "FAILED", finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime(), error: message }
      });
      await cancelQueuedFoundation(projectId, batchToken, `因${stage.code}失败停止：${message}`);
      throw error;
    }
  }
}

type StageOutcome = {
  chunkCount: number;
  inputChars: number;
  stdout: string;
  stderr: string;
  summary: Record<string, unknown>;
};

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

  for (const chunk of chunks) {
    const input = buildFoundationInput(context, chunk.episodes, "P1", prior);
    const prompt = buildFoundationPrompt("P1", input);
    inputChars += prompt.length;
    const result = stageRunner
      ? await stageRunner("P1", prompt)
      : await runRoleByProvider({
          provider,
          projectId,
          role: roleFor("P1"),
          prompt,
          sessionMode: outputs.length > 0 ? "resume" : "fresh"
        });
    stdout += result.stdout;
    stderr += result.stderr;
    const output = requireP1(result.data);
    outputs.push(output);
    prior = compactP1Prior(mergeP1Outputs(outputs));
  }

  const merged = mergeP1Outputs(outputs);
  const issues = validateFoundationP1(merged, context);
  raiseOnBlockers("P1", issues);
  await persistP1(context, merged);

  return {
    chunkCount: chunks.length,
    inputChars,
    stdout,
    stderr,
    summary: {
      schema: merged.schema,
      chunks: chunks.length,
      episodes: merged.episodes.length,
      relationships: merged.relationships.length,
      secrets: merged.secrets.length,
      foreshadowing: merged.foreshadowing.length,
      boundaries: merged.boundaries.length,
      issues
    }
  };
}

async function executeP2(
  context: ReturnType<typeof loadFoundationContext>,
  provider: PipelineProvider,
  projectId: string,
  stageRunner?: FoundationStageRunner
): Promise<StageOutcome> {
  const contentLengths = new Map(context.episodes.map((episode) => [episode.number, episode.content.length]));
  const chunks = buildFoundationChunks(context, contentLengths);
  const outputs: P2Output[] = [];
  let inputChars = 0;
  let stdout = "";
  let stderr = "";
  let callCount = 0;

  // 按集分片、每片一次调用输出全部类型资产：
  // 旧版按 characters/scenes/props 三个 kind 各跑一遍全剧源文 = 同一份剧本重复发 3 次（约 3 倍 token），
  // 且跨 kind 的家族编号（主资产-1、分资产-2/-3）无法在单 kind 输出内闭环，是编号乱象的根源之一
  for (const chunk of chunks) {
    const prior = compactP2Prior(outputs);
    const input = buildFoundationInput(context, chunk.episodes, "P2", prior);
    const scopeLine = "本次任务范围：输出本批全部类型的资产（CH 人物主/分资产、GROUP 群像、BEAST 非人、LOC 场景、PROP 道具），逐类给出主资产与分资产；禁止漏类型、禁止为了凑数拆分变体。";
    const prompt = buildFoundationPrompt("P2", input, scopeLine);
    inputChars += prompt.length;
    const result = stageRunner
      ? await stageRunner("P2", prompt)
      : await runRoleByProvider({
          provider,
          projectId,
          role: roleFor("P2"),
          prompt,
          sessionMode: callCount > 0 ? "resume" : "fresh"
        });
    stdout += result.stdout;
    stderr += result.stderr;
    outputs.push(requireP2(result.data));
    callCount += 1;
  }

  const merged = mergeP2Outputs(outputs);
  const issues = validateFoundationP2(merged, context);
  raiseOnBlockers("P2", issues);
  await persistP2(context, merged);

  return {
    chunkCount: callCount,
    inputChars,
    stdout,
    stderr,
    summary: {
      calls: callCount,
      assets: merged.assets.length,
      mainAssets: merged.assets.filter((asset) => !asset.parent_name).length,
      subAssets: merged.assets.filter((asset) => Boolean(asset.parent_name)).length,
      sceneLinks: merged.scene_asset_links.length,
      issues
    }
  };
}

function raiseOnBlockers(stage: string, issues: FoundationIssue[]) {
  const blockers = issues.filter((issue) => issue.severity === "BLOCKER");
  if (blockers.length) {
    throw new Error(`${stage} 基础库门禁失败：${blockers.map((item) => `${item.code}@${item.coordinate}`).join("、")}`);
  }
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
    context.episodes.map((episode) => [episode.number, episode.id])
  );
  const decisionKeys = new Set(
    decisions.map((decision) => `${decisionEpisodeIds.get(decision.episode_number ?? -1) ?? ""}|${decision.category}`)
  );
  const pendingContracts = await prisma.presentationContract.findMany({
    where: { projectId: context.projectId, status: "PENDING" },
    select: { id: true, episodeId: true, category: true }
  });
  const stalePendingIds = pendingContracts
    .filter((contract) => !decisionKeys.has(`${contract.episodeId ?? ""}|${contract.category}`))
    .map((contract) => contract.id);
  if (stalePendingIds.length) {
    await prisma.presentationContract.updateMany({
      where: { projectId: context.projectId, id: { in: stalePendingIds } },
      data: { status: "SKIPPED", note: "P1 本轮未确认该表现元素，已撤下旧待确认项。", decidedAt: new Date() }
    });
  }
  const pendingByKey = new Map<string, string>();
  for (const existing of pendingContracts.filter((contract) => !stalePendingIds.includes(contract.id))) {
    pendingByKey.set(`${existing.episodeId ?? ""}|${existing.category}`, existing.id);
  }
  for (const decision of decisions) {
    const episodeId = decisionEpisodeIds.get(decision.episode_number ?? -1) ?? null;
    const key = `${episodeId ?? ""}|${decision.category}`;
    const existingId = pendingByKey.get(key);
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
  // Windows 下 node_modules/.bin/tsx 是 Unix shell 包装脚本，直接 spawn 会以 ENOENT 静默失败。
  // 直接用当前 Node 启动 tsx CLI，Windows、macOS、Linux 的行为一致。
  const executable = process.execPath;
  const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.join(process.cwd(), "scripts", "run-project-foundation.ts");
  const args = [tsxCli, script, projectId, batchToken];
  if (singleStage) args.push(singleStage);
  const child = spawn(executable, args, {
    cwd: process.cwd(),
    env: process.env,
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
    if (code !== 0) markLaunchFailure(`exit=${code ?? "null"}, signal=${signal ?? "null"}`);
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

