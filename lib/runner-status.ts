const MAX_VERSION_CHARS = 120;
const MAX_ACCOUNT_CHARS = 320;
const MAX_LIMITS = 8;
const MAX_WARNINGS = 10;
const MAX_WARNING_CHARS = 500;
const MAX_LABEL_CHARS = 160;

export type RunnerStatusWindow = {
  usedPercent: number | null;
  remainingPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

export type RunnerStatusCredits = {
  balance: string | null;
  hasCredits: boolean;
  unlimited: boolean;
};

export type RunnerStatusIndividualLimit = {
  limit: string;
  used: string;
  remainingPercent: number;
  resetsAt: number | null;
};

export type RunnerStatusLimit = {
  id: string;
  name: string | null;
  planType: string | null;
  primary: RunnerStatusWindow | null;
  secondary: RunnerStatusWindow | null;
  credits: RunnerStatusCredits | null;
  individualLimit: RunnerStatusIndividualLimit | null;
  rateLimitReachedType: string | null;
};

export type RunnerStatusSnapshot = {
  version: string;
  account: {
    type: string;
    email: string | null;
    planType: string | null;
  };
  limits: RunnerStatusLimit[];
  usage: {
    lifetimeTokens: number | null;
    peakDailyTokens: number | null;
    currentStreakDays: number | null;
    longestStreakDays: number | null;
    latestDailyUsage: { date: string; tokens: number } | null;
  };
  checkedAt: string;
  warnings: string[];
};

type RecordValue = Record<string, unknown>;

/**
 * Runner 只允许回传固定形状的状态摘要。
 * 这里是边界层：不把 CLI 原始输出、令牌或未知字段写入线上数据库。
 */
export function normalizeRunnerStatus(value: unknown): RunnerStatusSnapshot | null {
  const body = record(value);
  if (!body) return null;

  const checkedAt = normalizeDate(body.checkedAt);
  const account = record(body.account);
  if (!checkedAt || !account) return null;

  const version = boundedString(body.version, MAX_VERSION_CHARS) ?? "Codex CLI";
  const limits = Array.isArray(body.limits)
    ? body.limits
      .slice(0, MAX_LIMITS)
      .map(normalizeLimit)
      .filter((item): item is RunnerStatusLimit => Boolean(item))
    : [];

  const warnings = Array.isArray(body.warnings)
    ? body.warnings
      .map((item) => boundedString(item, MAX_WARNING_CHARS))
      .filter((item): item is string => Boolean(item))
      .slice(0, MAX_WARNINGS)
    : [];

  return {
    version,
    account: {
      type: boundedString(account.type, MAX_LABEL_CHARS) ?? "unknown",
      email: boundedString(account.email, MAX_ACCOUNT_CHARS),
      planType: boundedString(account.planType, MAX_LABEL_CHARS),
    },
    limits,
    usage: normalizeUsage(body.usage),
    checkedAt,
    warnings,
  };
}

export function parseStoredRunnerStatus(value: string | null | undefined): RunnerStatusSnapshot | null {
  if (!value) return null;
  try {
    return normalizeRunnerStatus(JSON.parse(value));
  } catch {
    return null;
  }
}

function normalizeLimit(value: unknown): RunnerStatusLimit | null {
  const item = record(value);
  const id = boundedString(item?.id, MAX_LABEL_CHARS);
  if (!item || !id) return null;
  return {
    id,
    name: boundedString(item.name, MAX_LABEL_CHARS),
    planType: boundedString(item.planType, MAX_LABEL_CHARS),
    primary: normalizeWindow(item.primary),
    secondary: normalizeWindow(item.secondary),
    credits: normalizeCredits(item.credits),
    individualLimit: normalizeIndividualLimit(item.individualLimit),
    rateLimitReachedType: boundedString(item.rateLimitReachedType, MAX_LABEL_CHARS),
  };
}

function normalizeWindow(value: unknown): RunnerStatusWindow | null {
  const item = record(value);
  if (!item) return null;
  return {
    usedPercent: percent(item.usedPercent),
    remainingPercent: percent(item.remainingPercent),
    windowDurationMins: boundedNumber(item.windowDurationMins, 0, 10_000_000),
    resetsAt: timestamp(item.resetsAt),
  };
}

function normalizeCredits(value: unknown): RunnerStatusCredits | null {
  const item = record(value);
  if (!item) return null;
  return {
    balance: boundedString(item.balance, MAX_LABEL_CHARS),
    hasCredits: typeof item.hasCredits === "boolean" ? item.hasCredits : false,
    unlimited: typeof item.unlimited === "boolean" ? item.unlimited : false,
  };
}

function normalizeIndividualLimit(value: unknown): RunnerStatusIndividualLimit | null {
  const item = record(value);
  if (!item) return null;
  return {
    limit: boundedString(item.limit, MAX_LABEL_CHARS) ?? "",
    used: boundedString(item.used, MAX_LABEL_CHARS) ?? "",
    remainingPercent: percent(item.remainingPercent) ?? 0,
    resetsAt: timestamp(item.resetsAt),
  };
}

function normalizeUsage(value: unknown): RunnerStatusSnapshot["usage"] {
  const item = record(value);
  const latest = record(item?.latestDailyUsage);
  const latestDate = boundedString(latest?.date, 40);
  const latestTokens = boundedNumber(latest?.tokens, 0, Number.MAX_SAFE_INTEGER);
  return {
    lifetimeTokens: boundedNumber(item?.lifetimeTokens, 0, Number.MAX_SAFE_INTEGER),
    peakDailyTokens: boundedNumber(item?.peakDailyTokens, 0, Number.MAX_SAFE_INTEGER),
    currentStreakDays: integer(item?.currentStreakDays, 0, 10_000),
    longestStreakDays: integer(item?.longestStreakDays, 0, 10_000),
    latestDailyUsage: latestDate && latestTokens !== null ? { date: latestDate, tokens: latestTokens } : null,
  };
}

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue
    : null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const result = value.trim();
  return result && result.length <= maxLength ? result : null;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number | null {
  const numberValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : NaN;
  if (!Number.isFinite(numberValue)) return null;
  return Math.max(minimum, Math.min(maximum, numberValue));
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  const numberValue = boundedNumber(value, minimum, maximum);
  return numberValue === null ? null : Math.floor(numberValue);
}

function percent(value: unknown): number | null {
  return boundedNumber(value, 0, 100);
}

function timestamp(value: unknown): number | null {
  const numberValue = boundedNumber(value, 0, Number.MAX_SAFE_INTEGER);
  return numberValue === null ? null : Math.floor(numberValue);
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
