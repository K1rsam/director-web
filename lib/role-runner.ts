/**
 * 岗位执行器（共享）：CLI（本机 Codex）/ API（DeepSeek）两种执行方式的统一入口。
 *
 * E1–E5 与 P1/P2 共用同一套 provider 解析、模型解析和会话/调用逻辑；
 * 岗位差异只体现在 RoleConfig（skill / model / reasoningEffort / apiReasoner）。
 *
 * 环境变量（CLI 侧）：
 *   CLI_MODEL_<岗位> > CLI_MODEL > 配置默认
 *   CLI_REASONING_<岗位> > CLI_REASONING_EFFORT > 配置默认
 * 环境变量（API 侧）：
 *   DEEPSEEK_API_MODEL / DEEPSEEK_API_MODEL_REASONER / DEEPSEEK_API_REASONER_STAGES / DEEPSEEK_API_MAX_TOKENS
 */
import { runCodexJson } from "@/lib/codex-cli";
import { isFlashModel, resolveApiOutputCap, runDeepSeekJson } from "@/lib/deepseek-api";
import { loadStageSkillText } from "@/lib/pipeline-skills";
import { getProjectDeepSeekCredential } from "@/lib/provider-credentials";
import { prisma } from "@/lib/prisma";
import { recordLocalDiagnosticLog } from "@/lib/local-diagnostic-log";

export type PipelineProvider = "CLI" | "API";
export type RoleSessionMode = "fresh" | "resume" | "ephemeral";

export type RoleConfig = {
  code: string;
  skill: string;
  /** CLI 默认模型（如 gpt-5.6-terra） */
  model: string;
  /** CLI 默认推理强度 */
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  /** API 侧是否用 reasoner 模型（整集大输出岗位） */
  apiReasoner?: boolean;
};

export type RoleRunResult = {
  data: Record<string, unknown>;
  sessionId: string | null;
  stdout: string;
  stderr: string;
};

const MAX_SESSION_INPUT_CHARS = 260_000;
const CLI_SESSION_STALE_MS = 30 * 60_000;
const DEFAULT_REASONER_STAGES: string[] = [];

/**
 * 生产流水线允许的 CLI 模型。gpt-5.6-luna 等快速/轻量模型只用于显式冒烟测试，
 * 不能通过 CLI_MODEL 或 CLI_MODEL_<岗位> 覆盖生产 E0–E5/P1–P2。
 */
export const PRODUCTION_CLI_MODELS = ["gpt-5.6-terra", "gpt-5.6-sol"] as const;
const PRODUCTION_CLI_MODEL_SET = new Set<string>(PRODUCTION_CLI_MODELS);

export function isProductionCliModel(model: string) {
  return PRODUCTION_CLI_MODEL_SET.has(model.trim());
}

/** 按项目 executionMode 解析执行方式；任何非 "API" 值都回退到 CLI。 */
export function resolveProvider(executionMode: string | null | undefined): PipelineProvider {
  return String(executionMode ?? "").toUpperCase() === "API" ? "API" : "CLI";
}

export function resolveCliModel(roleCode: string, fallback: string): string {
  const safeFallback = isProductionCliModel(fallback) ? fallback.trim() : "gpt-5.6-terra";
  const configured = (process.env[`CLI_MODEL_${roleCode}`] ?? process.env.CLI_MODEL)?.trim();
  return configured && isProductionCliModel(configured) ? configured : safeFallback;
}

const CLI_REASONING_OPTIONS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

export function resolveCliReasoning(
  roleCode: string,
  fallback: "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
): "low" | "medium" | "high" | "xhigh" | "max" | "ultra" {
  const override = process.env[`CLI_REASONING_${roleCode}`] ?? process.env.CLI_REASONING_EFFORT;
  if (override && CLI_REASONING_OPTIONS.has(override.toLowerCase())) {
    return override.toLowerCase() as "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  }
  return fallback;
}

export function resolveApiModel(roleCode: string, apiReasoner: boolean): string {
  if (!apiReasoner) return process.env.DEEPSEEK_API_MODEL ?? "deepseek-chat";
  const reasonerStages = new Set(
    (process.env.DEEPSEEK_API_REASONER_STAGES ?? DEFAULT_REASONER_STAGES.join(","))
      .split(",")
      .map((item) => item.trim().toUpperCase())
      .filter(Boolean)
  );
  return reasonerStages.has(roleCode)
    ? process.env.DEEPSEEK_API_MODEL_REASONER ?? "deepseek-reasoner"
    : process.env.DEEPSEEK_API_MODEL ?? "deepseek-chat";
}

function resolveApiMaxTokens(model: string): number {
  // 统一出口在 deepseek-api.resolveApiOutputCap（flash 384K / reasoner 32K / chat 8K 硬顶）
  return resolveApiOutputCap(model);
}

export { isFlashModel };

/**
 * CLI 岗位调用：会话边界由 sessionMode 显式控制。
 * fresh=全量重跑时新建并替换指针；resume=仅用于确实需要沿用同集上下文的返修；
 * ephemeral=分片、全剧基础工程和一次性岗位都不持久化。不同集/岗位仍各自隔离。
 */
export async function runCliRoleJson(input: {
  projectId: string;
  episodeId?: string | null;
  role: RoleConfig;
  prompt: string;
  sessionMode?: RoleSessionMode;
}): Promise<RoleRunResult> {
  const { projectId, episodeId: rawEpisodeId = "", role, prompt } = input;
  const episodeId = rawEpisodeId ?? "";
  const sessionMode = input.sessionMode ?? "fresh";
  const model = resolveCliModel(role.code, role.model);
  const reasoningEffort = resolveCliReasoning(role.code, role.reasoningEffort);
  const stored = sessionMode === "ephemeral"
    ? null
    : await prisma.cliRoleSession.findUnique({
        where: { projectId_episodeId_stageCode: { projectId, episodeId, stageCode: role.code } }
      });
  const canResume = Boolean(
    sessionMode === "resume" &&
    stored &&
    stored.model === model &&
    stored.reasoningEffort === reasoningEffort &&
    Date.now() - stored.updatedAt.getTime() <= CLI_SESSION_STALE_MS &&
    stored.inputChars + prompt.length <= MAX_SESSION_INPUT_CHARS
  );
  let result: Awaited<ReturnType<typeof runCodexJson<Record<string, unknown>>>>;
  try {
    result = await runCodexJson<Record<string, unknown>>({
      prompt,
      // Codex 严格 schema 不允许通用 additionalProperties；岗位契约字段各异，
      // 由岗位提示词强制 JSON，再由适配器防御性提取首尾对象。
      schema: null,
      model,
      reasoningEffort,
      cwd: process.cwd(),
      sessionId: canResume ? stored?.sessionId : null,
      ephemeral: sessionMode === "ephemeral"
    });
  } catch (error) {
    // 会话内某轮失败（模型故障/超时/JSON 截断）：丢弃该会话，下一轮从全新会话开始，避免坏会话反复投毒
    if (canResume) {
      await prisma.cliRoleSession.deleteMany({
        where: { projectId, episodeId, stageCode: role.code }
      });
    }
    throw error;
  }
  if (sessionMode !== "ephemeral" && result.sessionId) {
    const turnChars = prompt.length + JSON.stringify(result.data).length;
    await prisma.cliRoleSession.upsert({
      where: { projectId_episodeId_stageCode: { projectId, episodeId, stageCode: role.code } },
      create: {
        projectId,
        episodeId,
        stageCode: role.code,
        sessionId: result.sessionId,
        model,
        reasoningEffort,
        turnCount: 1,
        inputChars: turnChars
      },
      update: {
        sessionId: result.sessionId,
        model,
        reasoningEffort,
        turnCount: canResume ? { increment: 1 } : 1,
        inputChars: canResume ? { increment: turnChars } : turnChars
      }
    });
  } else if (sessionMode !== "ephemeral") {
    // 新会话没有返回可续接 ID 时，不能让后续返修误续旧指针。
    await prisma.cliRoleSession.deleteMany({
      where: { projectId, episodeId, stageCode: role.code }
    });
  }
  return { data: result.data, sessionId: result.sessionId, stdout: result.stdout, stderr: result.stderr };
}

/** API 模式岗位会话的上下文预算（字符）：超过后重开会话（不再携带历史）。
 *  校准依据（官方定价 flash：缓存命中 0.05元/M vs 未命中 1.5元/M，1:30）：
 *  - 携带历史的边际成本 = 历史token × 命中价，200K token 历史每轮仅多花 ~0.01 元，远低于一次返修（0.1~0.2 元）——在质量阈值内携带历史稳赚；
 *  - 超过 ~200K token 后模型注意力稀释（记得但不重视早期内容），且要留出 1M 窗口给本轮输入；
 *  - 中文混合 JSON 约 0.6~0.8 token/字符，300K 字符 ≈ 200~240K token，即重开阈值。 */
const API_SESSION_MAX_INPUT_CHARS = 300_000;

/** API 岗位调用：把 Skill 制度稿作为 system 提示，任务输入作为 user 提示。
 *  会话（useSession=true，修复轮）：同集同岗位的历史 turns 续接（messages 数组），
 *  模型记得自己上一轮拆过什么——不再"失忆重拆"；system + 历史前缀天然命中 DeepSeek prompt cache，省钱。
 *  首轮全量不读历史（新剧本新会话），但成功后会写入历史供后续修复轮续接。
 *  maxTokens 可覆盖（修复轮传小上限防模型重写全片烧钱）。 */
export async function runApiRoleJson(input: {
  role: RoleConfig;
  prompt: string;
  maxTokens?: number;
  projectId?: string;
  episodeId?: string;
  useSession?: boolean;
  noSession?: boolean;
}): Promise<RoleRunResult> {
  const { role, prompt } = input;
  const system = await loadStageSkillText(role.skill);
  const projectCredential = input.projectId
    ? await getProjectDeepSeekCredential(input.projectId)
    : null;
  const model = projectCredential?.model ?? resolveApiModel(role.code, role.apiReasoner ?? false);
  const sessionKey = input.projectId && input.episodeId && !input.noSession
    ? { projectId: input.projectId, episodeId: input.episodeId, stageCode: role.code }
    : null;

  // 读取既有历史（仅修复轮续接；首轮不读）。重开条件：超 token 预算 或 超 30 分钟未续接——
  // DeepSeek 缓存命中要求同前缀在缓存有效期内重复请求，隔太久历史全 miss（200K token × 1.5元/M ≈ 0.3 元/轮），
  // 重开反而划算；且模型对陈旧上下文的记忆已无价值
  let history: Array<{ role: "user" | "assistant"; content: string }> = [];
  let stored = sessionKey
    ? await prisma.apiRoleSession.findUnique({ where: { projectId_episodeId_stageCode: sessionKey } })
    : null;
  const SESSION_STALE_MS = 30 * 60_000;
  if (input.useSession && stored && stored.model === model) {
    const stale = Date.now() - stored.updatedAt.getTime() > SESSION_STALE_MS;
    try {
      const parsed = JSON.parse(stored.messages) as Array<{ role: "user" | "assistant"; content: string }>;
      if (Array.isArray(parsed) && stored.inputChars <= API_SESSION_MAX_INPUT_CHARS && !stale) {
        history = parsed;
      }
    } catch {
      history = [];
    }
  }

  // 完整 messages：system + 历史 turns + 本次 prompt（历史部分命中 prompt cache）
  const messages: Array<{ role: string; content: string }> = [];
  if (system) messages.push({ role: "system", content: system });
  for (const turn of history) messages.push({ role: turn.role, content: turn.content });
  const hasHistory = history.length > 0;
  const sentPrompt = hasHistory
    ? `### 你之前的输出（同一岗位的连续工作记录，保持一致性；本次任务以最后指令为准）\n\n${prompt}`
    : prompt;
  messages.push({ role: "user", content: sentPrompt });

  const result = await runDeepSeekJson<Record<string, unknown>>({
    prompt: sentPrompt,
    messages,
    system: null,
    model,
    maxTokens: input.maxTokens ?? resolveApiMaxTokens(model),
    apiKey: projectCredential?.apiKey,
    apiBase: projectCredential?.apiBase,
    projectId: input.projectId
  });

  // 写入/续写会话历史（首轮也写，供修复轮续接）
  if (sessionKey) {
    const nextHistory = [...history, { role: "user" as const, content: sentPrompt }, { role: "assistant" as const, content: JSON.stringify(result.data) }];
    const continuingSession = history.length > 0;
    const nextChars = continuingSession ? stored?.inputChars ?? 0 : 0;
    const turnChars = sentPrompt.length + nextHistory[nextHistory.length - 1].content.length;
    await prisma.apiRoleSession.upsert({
      where: { projectId_episodeId_stageCode: sessionKey },
      create: {
        projectId: sessionKey.projectId,
        episodeId: sessionKey.episodeId,
        stageCode: sessionKey.stageCode,
        model,
        messages: JSON.stringify(nextHistory),
        turnCount: 1,
        inputChars: turnChars
      },
      update: {
        model,
        messages: JSON.stringify(nextHistory),
        turnCount: continuingSession ? { increment: 1 } : 1,
        inputChars: nextChars + turnChars
      }
    });
  }
  return { data: result.data, sessionId: null, stdout: result.stdout, stderr: result.stderr };
}

/** 按 provider 分发岗位调用。 */
export async function runRoleByProvider(input: {
  provider: PipelineProvider;
  projectId: string;
  episodeId?: string | null;
  role: RoleConfig;
  prompt: string;
  sessionMode?: RoleSessionMode;
}): Promise<RoleRunResult> {
  try {
    return input.provider === "API"
      ? await runApiRoleJson({
          role: input.role,
          prompt: input.prompt,
          projectId: input.projectId,
          episodeId: input.episodeId ?? undefined,
          useSession: input.sessionMode === "resume",
          noSession: input.sessionMode === "ephemeral"
        })
      : await runCliRoleJson({
          projectId: input.projectId,
          episodeId: input.episodeId ?? null,
          role: input.role,
          prompt: input.prompt,
          sessionMode: input.sessionMode ?? "fresh"
        });
  } catch (error) {
    const raw = error && typeof error === "object" ? error as { rawDetail?: unknown } : {};
    await recordLocalDiagnosticLog({
      kind: "task_failed",
      code: input.provider === "API" ? "MODEL_API_FAILED" : "MODEL_CLI_FAILED",
      operation: "model_call",
      error,
      taskKind: input.role.code,
      details: {
        stderrTail: typeof raw.rawDetail === "string" ? raw.rawDetail : undefined,
      },
    });
    throw error;
  }
}
