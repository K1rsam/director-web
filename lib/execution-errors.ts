export type ExecutionErrorSource = "cli" | "api" | "unknown";

export type ExecutionErrorKind =
  | "quota"
  | "rate_limit"
  | "auth"
  | "network"
  | "permission"
  | "timeout"
  | "unknown";

/** 把执行器的技术错误归类，供页面和批量监控使用同一套用户提示。 */
export function classifyExecutionError(value: unknown): ExecutionErrorKind {
  const text = normalizeErrorText(value);
  if (!text) return "unknown";

  // Codex CLI 的 "You've hit your usage limit"、API 的余额/配额错误都归到同一类。
  if (
    /usage\s*limit|quota|out\s+of\s+credits?|insufficient\s+(?:credits?|balance|funds?)|credit\s+(?:balance|limit)|payment\s+required|billing|exceed(?:ed)?\s+(?:your\s+)?(?:monthly\s+)?limit|limit\s+reached|http\s*402|status\s*=?\s*402|额度不足|额度已(?:用完|耗尽)|配额不足|余额不足|账户欠费|调用次数已达上限/i.test(text)
  ) {
    return "quota";
  }
  if (/http\s*429|status\s*=?\s*429|rate\s*limit|too\s+many\s+requests|请求过于频繁|访问频率过高|触发限流/i.test(text)) {
    return "rate_limit";
  }
  if (/not\s+logged\s+in|login\s+required|unauthori[sz]ed|authentication|未登录|登录已失效|登录状态/i.test(text)) {
    return "auth";
  }
  if (/econnreset|econnrefused|etimedout|enetunreach|eai_again|fetch\s+failed|network|网络连接|网络请求/i.test(text)) {
    return "network";
  }
  if (/permission\s+denied|access\s+is\s+denied|forbidden|权限不足|没有权限/i.test(text)) {
    return "permission";
  }
  if (/timed?\s*out|timeout|执行超过\d+分钟|请求超时/i.test(text)) {
    return "timeout";
  }
  return "unknown";
}

export function isQuotaError(value: unknown) {
  return classifyExecutionError(value) === "quota";
}

/**
 * 将执行器错误压缩成页面可直接展示的提示。
 * 原始错误不在这里删除：调用方仍可把它写入技术日志，供排查使用。
 */
export function formatExecutionErrorForUser(
  value: unknown,
  options: { source?: ExecutionErrorSource } = {}
) {
  const raw = normalizeErrorText(value);
  const source = options.source ?? "unknown";
  const kind = classifyExecutionError(raw);

  if (kind === "quota") {
    const subject = source === "cli" ? "Codex CLI 额度不足" : source === "api" ? "API 额度不足" : "模型调用额度不足";
    const action = source === "cli"
      ? "请等待 Codex CLI 额度恢复，或切换到 API 执行方式后重试。"
      : source === "api"
        ? "请检查 API 账户余额或限额，或切换到 Codex CLI 执行方式后重试。"
        : "请等待额度恢复、检查账户余额或限额，或切换执行方式后重试。";
    const retryAt = extractRetryAt(raw);
    return `${subject}，当前无法继续调用模型。${action}${retryAt ? `预计可再次尝试时间：${retryAt}。` : ""}`;
  }

  if (kind === "rate_limit") {
    return "模型调用暂时受到频率限制，请稍后重试；批量任务遇到该情况会暂停，不会继续启动新的任务。";
  }
  if (kind === "auth") {
    return source === "cli"
      ? "Codex CLI 未登录或登录已失效，请在本机终端运行 codex 并按提示完成登录后再重试。"
      : "执行器登录状态已失效，请重新完成登录或连接配置后再重试。";
  }
  if (kind === "network") return "模型服务连接失败，请检查网络后重试。";
  if (kind === "permission") return "执行器没有访问当前环境的权限，请检查权限后重试。";
  if (kind === "timeout") return "模型调用超时，本次任务没有完成，请稍后重试。";

  if (!raw) return "任务执行失败，请稍后重试。";
  if (/SUB_TYPE_MISMATCH|分资产与主资产类型不一致/i.test(raw)) {
    const detail = raw
      .split(/基础资料校验未通过[:：]?/i)[1]
      ?.trim()
      .slice(0, 420);
    return `P2 资产归类校验未通过${detail ? `：${detail}` : ""}。已保留已完成的分片，下一次只修复这些资产，不会从头重跑整套 P2。`;
  }
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "").trim())
    .find((line) => line && !/^at\s+/i.test(line)) ?? raw;
  const detail = firstLine.replace(/^Error:\s*/i, "").slice(0, 360);
  return `任务执行失败：${detail}${firstLine.length > 360 ? "…" : ""}`;
}

export function executionErrorSource(provider: string | null | undefined): ExecutionErrorSource {
  const value = String(provider ?? "").toLowerCase();
  if (value.includes("cli")) return "cli";
  if (value.includes("api") || value.includes("deepseek")) return "api";
  return "unknown";
}

function normalizeErrorText(value: unknown) {
  const raw = value instanceof Error ? value.message : String(value ?? "");
  return raw.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "").trim();
}

function extractRetryAt(text: string) {
  const englishMatch = text.match(/try\s+again\s+at\s+([^,.;\r\n]+)/i);
  if (englishMatch?.[1]?.trim()) return englishMatch[1].trim();
  const chineseMatch = text.match(/预计可再次尝试时间[:：]\s*([^。\r\n]+)/i);
  return chineseMatch?.[1]?.trim() || null;
}
