/**
 * Runner 与线下执行器共用的诊断日志协议。
 *
 * 默认只发送不含堆栈和命令输出的 minimal 事件；详细事件只能由明确的
 * upload request 触发。所有进入本协议的文本都会先做脱敏和长度限制。
 */

export const DIAGNOSTIC_SCHEMA_VERSION = 1;
export const MAX_DIAGNOSTIC_MESSAGE_CHARS = 600;
export const MAX_DIAGNOSTIC_DETAIL_CHARS = 12_000;
export const MAX_DIAGNOSTIC_EVENTS_PER_UPLOAD = 50;
export const MAX_DIAGNOSTIC_UPLOAD_CHARS = 400_000;

export const DIAGNOSTIC_KINDS = [
  "runner_start_failed",
  "runner_connection_failed",
  "task_failed",
  "task_timeout",
  "launcher_download_failed",
] as const;

export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];
export type DiagnosticScope = "minimal" | "detailed";
export type DiagnosticSeverity = "warning" | "error";

export type DiagnosticDetails = {
  stack?: string;
  stdoutTail?: string;
  stderrTail?: string;
};

export type DiagnosticEvent = {
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
  eventId: string;
  occurredAt: string;
  severity: DiagnosticSeverity;
  kind: DiagnosticKind;
  code: string;
  operation: string;
  message: string;
  deviceId?: string;
  jobId?: string;
  taskKind?: string;
  attempt?: number;
  durationMs?: number;
  runnerVersion?: string;
  nodeVersion?: string;
  platform?: string;
  httpStatus?: number;
  details?: DiagnosticDetails;
};

export type DiagnosticEnvelope = {
  schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
  scope: DiagnosticScope;
  event: DiagnosticEvent;
};

export type DiagnosticInput = {
  kind: DiagnosticKind;
  code: string;
  operation: string;
  message?: string;
  error?: unknown;
  severity?: DiagnosticSeverity;
  eventId?: string;
  occurredAt?: string;
  deviceId?: string;
  jobId?: string;
  taskKind?: string;
  attempt?: number;
  durationMs?: number;
  runnerVersion?: string;
  nodeVersion?: string;
  platform?: string;
  httpStatus?: number;
  details?: DiagnosticDetails;
};

export type DiagnosticReportBody =
  | DiagnosticEnvelope
  | {
      schemaVersion: typeof DIAGNOSTIC_SCHEMA_VERSION;
      scope: "detailed";
      requestId: string;
      events: DiagnosticEnvelope[];
    };

type RecordValue = Record<string, unknown>;

export function createDiagnosticEvent(input: DiagnosticInput): DiagnosticEvent {
  const errorText = errorMessage(input.error);
  const occurredAt = validIso(input.occurredAt) ?? new Date().toISOString();
  const event: DiagnosticEvent = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    eventId: cleanString(input.eventId, 120) ?? createId(),
    occurredAt,
    severity: input.severity ?? "error",
    kind: input.kind,
    code: cleanString(input.code, 120) ?? "UNKNOWN",
    operation: cleanString(input.operation, 120) ?? "unknown",
    message: sanitizeDiagnosticText(input.message ?? errorText ?? "诊断事件未提供错误信息。", MAX_DIAGNOSTIC_MESSAGE_CHARS),
  };

  assignOptional(event, "deviceId", input.deviceId, 120);
  assignOptional(event, "jobId", input.jobId, 120);
  assignOptional(event, "taskKind", input.taskKind, 120);
  assignOptional(event, "runnerVersion", input.runnerVersion, 120);
  assignOptional(event, "nodeVersion", input.nodeVersion, 80);
  assignOptional(event, "platform", input.platform, 80);
  if (Number.isFinite(input.attempt)) event.attempt = Math.max(0, Math.min(9999, Math.trunc(input.attempt!)));
  if (Number.isFinite(input.durationMs)) event.durationMs = Math.max(0, Math.min(86_400_000, Math.trunc(input.durationMs!)));
  if (Number.isInteger(input.httpStatus) && input.httpStatus! >= 100 && input.httpStatus! <= 599) {
    event.httpStatus = input.httpStatus;
  }

  const details = input.details ?? errorDetails(input.error);
  const sanitizedDetails = sanitizeDetails(details);
  if (sanitizedDetails) event.details = sanitizedDetails;
  return event;
}

export function toDiagnosticEnvelope(event: DiagnosticEvent, scope: DiagnosticScope): DiagnosticEnvelope {
  const minimalEvent: DiagnosticEvent = { ...event };
  delete minimalEvent.details;
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    scope,
    event: scope === "detailed" ? { ...event, details: sanitizeDetails(event.details) ?? undefined } : minimalEvent,
  };
}

export function parseDiagnosticEnvelope(value: unknown, expectedScope?: DiagnosticScope): DiagnosticEnvelope | null {
  const body = record(value);
  if (body?.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION) return null;
  if (body.scope !== "minimal" && body.scope !== "detailed") return null;
  if (expectedScope && body.scope !== expectedScope) return null;

  const event = parseEvent(body.event, body.scope);
  return event ? { schemaVersion: DIAGNOSTIC_SCHEMA_VERSION, scope: body.scope, event } : null;
}

export function parseDiagnosticReportBody(value: unknown): DiagnosticReportBody | null {
  const body = record(value);
  if (body?.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION) return null;
  try {
    if (JSON.stringify(value).length > MAX_DIAGNOSTIC_UPLOAD_CHARS) return null;
  } catch {
    return null;
  }

  if (body.scope === "minimal") {
    return parseDiagnosticEnvelope(body, "minimal");
  }

  if (body.scope !== "detailed") return null;
  const requestId = cleanString(body.requestId, 120);
  if (!requestId || !Array.isArray(body.events) || body.events.length === 0 || body.events.length > MAX_DIAGNOSTIC_EVENTS_PER_UPLOAD) {
    return null;
  }
  const events = body.events
    .map((item) => parseDiagnosticEnvelope(item, "detailed"))
    .filter((item): item is DiagnosticEnvelope => Boolean(item));
  return events.length === body.events.length
    ? { schemaVersion: DIAGNOSTIC_SCHEMA_VERSION, scope: "detailed", requestId, events }
    : null;
}

export function parseDiagnosticUploadRequestBody(value: unknown): { runnerTokenId: string } | null {
  const body = record(value);
  const runnerTokenId = cleanString(body?.runnerTokenId, 120);
  return runnerTokenId ? { runnerTokenId } : null;
}

export function sanitizeDiagnosticText(value: unknown, maxLength = MAX_DIAGNOSTIC_DETAIL_CHARS): string {
  let text = typeof value === "string" ? value : String(value ?? "");
  text = text.replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  text = text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=\-]+/gi, "Bearer <redacted>")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{10,}\b/g, "<redacted-key>")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^"'&\s,;]+/gi, "$1=<redacted>")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s)]+/gi, "$1?<redacted-query>")
    .replace(/([A-Za-z]:[\\/](?:Users|home)[\\/])[^\\/\s]+/gi, "$1<redacted>")
    .replace(/(\/(?:Users|home)\/)[^\/\s]+/gi, "$1<redacted>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>");
  const trimmed = text.trim();
  return trimmed.length > maxLength ? `${trimmed.slice(0, Math.max(0, maxLength - 1))}…` : trimmed;
}

function parseEvent(value: unknown, scope: DiagnosticScope): DiagnosticEvent | null {
  const raw = record(value);
  if (raw?.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION) return null;
  const kind = cleanString(raw.kind, 120);
  if (!kind || !(DIAGNOSTIC_KINDS as readonly string[]).includes(kind)) return null;
  const eventId = cleanString(raw.eventId, 120);
  const occurredAt = validIso(raw.occurredAt);
  const code = cleanString(raw.code, 120);
  const operation = cleanString(raw.operation, 120);
  const message = sanitizeDiagnosticText(raw.message, MAX_DIAGNOSTIC_MESSAGE_CHARS);
  if (!eventId || !occurredAt || !code || !operation || !message) return null;
  if (raw.severity !== "warning" && raw.severity !== "error") return null;

  const event: DiagnosticEvent = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    eventId,
    occurredAt,
    severity: raw.severity,
    kind: kind as DiagnosticKind,
    code,
    operation,
    message,
  };
  for (const key of ["deviceId", "jobId", "taskKind", "runnerVersion", "nodeVersion", "platform"] as const) {
    assignOptional(event, key, raw[key], key === "platform" || key === "nodeVersion" ? 80 : 120);
  }
  if (Number.isInteger(raw.attempt) && Number(raw.attempt) >= 0 && Number(raw.attempt) <= 9999) event.attempt = Number(raw.attempt);
  if (Number.isInteger(raw.durationMs) && Number(raw.durationMs) >= 0 && Number(raw.durationMs) <= 86_400_000) event.durationMs = Number(raw.durationMs);
  if (Number.isInteger(raw.httpStatus) && Number(raw.httpStatus) >= 100 && Number(raw.httpStatus) <= 599) event.httpStatus = Number(raw.httpStatus);
  if (scope === "detailed") {
    const details = sanitizeDetails(raw.details);
    if (details) event.details = details;
  }
  return event;
}

function sanitizeDetails(value: unknown): DiagnosticDetails | undefined {
  const raw = record(value);
  if (!raw) return undefined;
  const details: DiagnosticDetails = {};
  for (const key of ["stack", "stdoutTail", "stderrTail"] as const) {
    const value = raw[key];
    if (typeof value === "string" && value.trim()) details[key] = sanitizeDiagnosticText(value, MAX_DIAGNOSTIC_DETAIL_CHARS);
  }
  return Object.keys(details).length ? details : undefined;
}

function errorMessage(value: unknown): string | null {
  if (value instanceof Error) return value.message || null;
  const raw = record(value);
  return typeof raw?.message === "string" ? raw.message : value === undefined || value === null ? null : String(value);
}

function errorDetails(value: unknown): DiagnosticDetails | undefined {
  const raw = record(value);
  const details = record(raw?.diagnosticDetails);
  const stack = value instanceof Error ? value.stack : typeof raw?.stack === "string" ? raw.stack : undefined;
  return sanitizeDetails({
    stack,
    stdoutTail: details?.stdoutTail,
    stderrTail: details?.stderrTail,
  });
}

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function cleanString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return sanitizeDiagnosticText(value, maxLength) || null;
}

function assignOptional<T extends keyof DiagnosticEvent>(event: DiagnosticEvent, key: T, value: unknown, maxLength: number): void {
  const cleaned = cleanString(value, maxLength);
  if (cleaned) event[key] = cleaned as DiagnosticEvent[T];
}

function validIso(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function createId(): string {
  const cryptoValue = globalThis.crypto as Crypto & { randomUUID?: () => string } | undefined;
  return cryptoValue?.randomUUID?.() ?? `diag-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
