import { getProjectDeepSeekCredential, normalizeDeepSeekBase } from "@/lib/provider-credentials";

/**
 * DeepSeek API 适配器（API 执行模式）
 *
 * 形状与 lib/codex-cli.ts 的 runCodexJson 对齐，供 episode-pipeline 的
 * PipelineStageRunner 使用；CLI / API 两种执行方式在流水线内可互换。
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY             必填；DeepSeek 开放平台 API Key
 *   DEEPSEEK_API_BASE            默认 https://api.deepseek.com
 *   DEEPSEEK_API_MODEL           默认 deepseek-chat（支持 JSON 模式）
 *   DEEPSEEK_API_MODEL_REASONER  默认 deepseek-reasoner（强推理，正文解析 JSON）
 *   DEEPSEEK_API_MAX_TOKENS      覆盖输出上限（flash 默认 384000 / reasoner 默认 32768；chat 硬顶 8192）
 *   DEEPSEEK_API_TIMEOUT_MS      覆盖单次调用超时（默认 15 分钟）
 *
 * 模型选型（见 episode-pipeline.resolveApiModel）：
 *   - deepseek-v4-flash：官方输出上限 384K tokens、上下文 1M，支持 JSON 模式，适合整集大输出（E1/E5）。
 *   - deepseek-chat：支持 response_format=json_object，输出上限 8K tokens，适合 E2–E4 的
 *     小范围补丁输出。
 *   - deepseek-reasoner：不支持 json_object / temperature，但输出上限更高（32K，env 可覆盖），
 *     适合 E1 结构大输出与 E5 审查总控；要求"只输出 JSON"，正文防御性解析。
 *
 * 参考：https://api-docs.deepseek.com/ ｜ JSON 模式：https://api-docs.deepseek.com/guides/json_mode
 */
export type DeepSeekJsonRequest = {
  prompt: string;
  system?: string | null;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  /** 完整 messages（会话续接用）：提供时直接使用，忽略 system/prompt 拼装 */
  messages?: Array<{ role: string; content: string }>;
  /** 思考模式覆盖（flash）：请求级 > DEEPSEEK_API_THINKING > 默认 disabled */
  thinking?: "enabled" | "disabled";
  /** 思考程度（flash）：low | high | max；请求级 > DEEPSEEK_API_REASONING_EFFORT > 默认 high */
  reasoningEffort?: "low" | "high" | "max";
  /** 请求级凭证覆盖；未提供时按 projectId 对应项目管理员的账号凭证解析。 */
  apiKey?: string;
  apiBase?: string;
  projectId?: string;
};

export type DeepSeekJsonResult<T> = {
  data: T;
  sessionId: null;
  stdout: string;
  stderr: string;
};

const DEFAULT_TIMEOUT_MS = 15 * 60_000;

/** flash 家族（deepseek-v4-flash 等）：官方输出上限 384K tokens、上下文 1M。 */
export function isFlashModel(model: string): boolean {
  return /flash/i.test(model);
}

/**
 * 模型输出上限（max_tokens）：
 *   - flash 家族：384_000（官方上限，env DEEPSEEK_API_MAX_TOKENS 可覆盖）
 *   - reasoner：32_768（env 可覆盖）
 *   - chat：8_192 硬顶（chat 官方上限就是 8192，传更大值 API 直接报错）
 */
export function resolveApiOutputCap(model: string): number {
  const configured = Number(process.env.DEEPSEEK_API_MAX_TOKENS ?? "");
  const overridden = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : null;
  if (isFlashModel(model)) return overridden ?? 384_000;
  if (model.includes("reasoner")) return overridden ?? 32_768;
  return 8_192;
}

export async function runDeepSeekJson<T>(request: DeepSeekJsonRequest): Promise<DeepSeekJsonResult<T>> {
  // flash 思考模式偶发把全部输出放进 reasoning_content 导致 content 为空串（completion 却非零）：
  // 空内容解析失败时自动重试，且**第 2 次起降级为无思考重试**（思考后 content 空是 thinking 的
  // 已知行为，无思考输出稳定非空）。
  // 非截断的 JSON 非法（模型随机转义失误，如未转义引号/换行）也重试——重试大概率输出正常。
  // 只有 finish_reason=length 的截断不重试（模型写不完，重试大概率仍截断）。
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await runDeepSeekJsonOnce<T>(request);
    } catch (error) {
      lastError = error;
      // 错误消息为全角括号（原文前 400 字：）——半角正则永不匹配，重试/降级曾完全失效
      const message = error instanceof Error ? error.message : String(error);
      const emptyContent = /原文前 400 字：[）)]/.test(message);
      const lengthTruncated = /finish_reason=length/.test(message);
      if (attempt === 3) throw error;
      if (lengthTruncated && !emptyContent) throw error;
      // 降级策略：思考模式空 content 后，后续重试关思考（request 同引用，直接改）
      if (emptyContent && attempt >= 1 && request.thinking === undefined) {
        request.thinking = "disabled";
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw lastError;
}

async function runDeepSeekJsonOnce<T>(request: DeepSeekJsonRequest): Promise<DeepSeekJsonResult<T>> {
  const projectCredential = !request.apiKey && request.projectId
    ? await getProjectDeepSeekCredential(request.projectId)
    : null;
  const apiKey = request.apiKey ?? projectCredential?.apiKey ?? process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    throw new Error("没有可用的 DeepSeek API Key：请在“API 与 CLI”中连接当前账号的 Key，或在本机 .env 配置 DEEPSEEK_API_KEY。");
  }
  const apiBase = normalizeDeepSeekBase(
    request.apiBase ?? projectCredential?.apiBase ?? process.env.DEEPSEEK_API_BASE
  );

  const startedAt = Date.now();
  const isReasoner = request.model.includes("reasoner");
  // 会话续接：外部传入完整 messages 时直接用；否则 system + 单条 user prompt
  const messages: Array<Record<string, string>> = request.messages?.length
    ? request.messages.map((item) => ({ role: item.role, content: item.content }))
    : [];
  if (!messages.length) {
    if (request.system) messages.push({ role: "system", content: request.system });
    messages.push({ role: "user", content: request.prompt });
  }

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: false,
    max_tokens: request.maxTokens ?? resolveApiOutputCap(request.model)
  };
  // deepseek-reasoner 不支持 temperature / response_format，按模型区分携带
  if (!isReasoner) {
    body.temperature = 0.3;
    // JSON Output（response_format=json_object）有官方已知 bug：API 有概率返回空 content
    // （官方文档原文），思考模式下概率更高（实测连续 3 次全空）。我们不需要它——
    // prompt 已强制"只返回合法JSON对象"，正文防御解析（parseApiJson 取 {} 区间）兜底。
    // 需要恢复 json_object 时设 DEEPSEEK_API_JSON_MODE=1。
    if (process.env.DEEPSEEK_API_JSON_MODE === "1") {
      body.response_format = { type: "json_object" };
    }
    // flash 家族思考模式（effort=high）：按 DEEPSEEK_API_THINKING 控制（默认关）。
    // 去掉 json_object 后 content 稳定非空（实测），思考质量收益可用。
    // 参考：https://api-docs.deepseek.com/guides/thinking_mode/
    const thinkingMode = request.thinking ?? process.env.DEEPSEEK_API_THINKING;
    if (isFlashModel(request.model) && thinkingMode !== "enabled") {
      body.thinking = { type: "disabled" };
      const effort = request.reasoningEffort ?? (process.env.DEEPSEEK_API_REASONING_EFFORT ?? "high") as "low" | "high" | "max";
      if (["low", "high", "max"].includes(effort)) body.reasoning_effort = effort;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`DeepSeek API 请求失败（HTTP ${response.status}）：${detail.slice(-800) || response.statusText}`);
    }

    const payload = (await response.json()) as {
      id?: string;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
        prompt_cache_hit_tokens?: number;
        prompt_cache_miss_tokens?: number;
      };
      choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? "";
    const finishReason = payload.choices?.[0]?.finish_reason ?? "";
    let data: T;
    try {
      data = parseApiJson<T>(content);
    } catch (error) {
      // 输出为空/截断/非法时，把 finish_reason 与 usage 一并给出，便于定位（空内容多为 reasoner 推理耗尽输出预算）
      const usageText = payload.usage
        ? `prompt=${payload.usage.prompt_tokens ?? "?"} completion=${payload.usage.completion_tokens ?? "?"} total=${payload.usage.total_tokens ?? "?"}`
        : "usage 无";
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}（finish_reason=${finishReason || "?"}；${usageText}；模型=${request.model}）`
      );
    }
    const usage = payload.usage
      ? [
          `prompt=${payload.usage.prompt_tokens ?? "?"}`,
          `completion=${payload.usage.completion_tokens ?? "?"}`,
          `total=${payload.usage.total_tokens ?? "?"}`,
          `cache_hit=${payload.usage.prompt_cache_hit_tokens ?? 0}`,
          `cache_miss=${payload.usage.prompt_cache_miss_tokens ?? 0}`
        ].join(" ")
      : "usage 未返回";
    return {
      data,
      sessionId: null,
      stdout: "",
      stderr: `[DeepSeek ${request.model} ${Date.now() - startedAt}ms ${usage} finish=${finishReason} request=${payload.id ?? "?"}]`
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`DeepSeek API 调用超过${Math.round((request.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 60_000)}分钟，已停止本岗位。`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型正文中解析 JSON：去掉代码围栏与前后缀文字（reasoner 模式必需，chat 模式兜底）。 */
export function parseApiJson<T>(content: string): T {
  let normalized = content.trim();
  normalized = normalized.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = normalized.indexOf("{");
  const end = normalized.lastIndexOf("}");
  if (start >= 0 && end > start) normalized = normalized.slice(start, end + 1);
  try {
    return JSON.parse(normalized) as T;
  } catch (error) {
    throw new Error(`DeepSeek 返回内容不是合法JSON：${error instanceof Error ? error.message : String(error)}（原文前 400 字：${content.slice(0, 400)}）`);
  }
}

