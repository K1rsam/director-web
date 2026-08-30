import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export const DIAGNOSTIC_SCHEMA_VERSION = 1;
const MAX_MESSAGE_CHARS = 600;
const MAX_DETAIL_CHARS = 12_000;
const DIAGNOSTIC_KINDS = new Set([
  "runner_start_failed",
  "runner_connection_failed",
  "task_failed",
  "task_timeout",
  "launcher_download_failed",
]);

export function createDiagnosticEvent(input = {}) {
  const event = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    eventId: clean(input.eventId, 120) || randomUUID(),
    occurredAt: validIso(input.occurredAt) || new Date().toISOString(),
    severity: input.severity === "warning" ? "warning" : "error",
    kind: DIAGNOSTIC_KINDS.has(input.kind) ? input.kind : "runner_connection_failed",
    code: clean(input.code, 120) || "UNKNOWN",
    operation: clean(input.operation, 120) || "unknown",
    message: sanitize(input.message || errorMessage(input.error) || "诊断事件未提供错误信息。", MAX_MESSAGE_CHARS),
  };
  for (const key of ["deviceId", "jobId", "taskKind", "runnerVersion"]) {
    const value = clean(input[key], 120);
    if (value) event[key] = value;
  }
  for (const key of ["nodeVersion", "platform"]) {
    const value = clean(input[key], 80);
    if (value) event[key] = value;
  }
  if (Number.isFinite(input.attempt)) event.attempt = Math.max(0, Math.min(9999, Math.trunc(input.attempt)));
  if (Number.isFinite(input.durationMs)) event.durationMs = Math.max(0, Math.min(86_400_000, Math.trunc(input.durationMs)));
  if (Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599) event.httpStatus = input.httpStatus;
  const details = input.details || input.error?.diagnosticDetails || {};
  const sanitizedDetails = sanitizeDetails({
    stack: input.error?.stack || details.stack,
    stdoutTail: details.stdoutTail,
    stderrTail: details.stderrTail,
  });
  if (sanitizedDetails) event.details = sanitizedDetails;
  return event;
}

export function toDiagnosticEnvelope(event, scope = "minimal") {
  const minimalEvent = { ...event };
  delete minimalEvent.details;
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    scope,
    event: scope === "detailed" ? { ...event, details: sanitizeDetails(event.details) } : minimalEvent,
  };
}

export async function saveLocalDiagnosticEvent(event) {
  try {
    const directory = localDiagnosticLogDirectory();
    await mkdir(directory, { recursive: true });
    const file = join(directory, `diagnostics-${event.occurredAt.slice(0, 10)}.jsonl`);
    await appendFile(file, `${JSON.stringify(toDiagnosticEnvelope(event, "detailed"))}\n`, "utf8");
  } catch {
    // 诊断日志不能让 Runner 本身退出。
  }
}

export async function readLocalDiagnosticEvents(limit = 100) {
  try {
    const directory = localDiagnosticLogDirectory();
    const files = (await readdir(directory)).filter((file) => /^diagnostics-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file)).sort().reverse();
    const events = [];
    for (const file of files) {
      const lines = (await readFile(join(directory, file), "utf8")).split(/\r?\n/).reverse();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const envelope = JSON.parse(line);
          if (envelope?.scope === "detailed" && envelope?.event) events.push(envelope.event);
        } catch {
          // 忽略损坏的单行日志，继续读取其他记录。
        }
        if (events.length >= limit) return events;
      }
    }
    return events;
  } catch {
    return [];
  }
}

function localDiagnosticLogDirectory() {
  if (process.env.DIRECTOR_LOG_DIR?.trim()) return process.env.DIRECTOR_LOG_DIR.trim();
  if (platform() === "win32") return join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "DirectorWorkbench", "logs");
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "director-workbench", "logs");
}

function sanitizeDetails(value) {
  if (!value || typeof value !== "object") return undefined;
  const details = {};
  for (const key of ["stack", "stdoutTail", "stderrTail"]) {
    if (typeof value[key] === "string" && value[key].trim()) details[key] = sanitize(value[key], MAX_DETAIL_CHARS);
  }
  return Object.keys(details).length ? details : undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : error && typeof error.message === "string" ? error.message : error == null ? "" : String(error);
}

function clean(value, maxLength) {
  if (typeof value !== "string" || !value.trim()) return "";
  return sanitize(value, maxLength) || "";
}

function validIso(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : "";
}

function sanitize(value, maxLength) {
  const text = String(value ?? "")
    .replace(/\x1B\[[0-?]*[ -\/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/Bearer\s+[A-Za-z0-9._~+\/=\-]+/gi, "Bearer <redacted>")
    .replace(/\b(?:sk|rk)-[A-Za-z0-9_-]{10,}\b/g, "<redacted-key>")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)\b\s*[:=]\s*["']?[^"'&\s,;]+/gi, "$1=<redacted>")
    .replace(/(https?:\/\/[^\s?]+)\?[^\s)]+/gi, "$1?<redacted-query>")
    .replace(/([A-Za-z]:[\\/](?:Users|home)[\\/])[^\\/\s]+/gi, "$1<redacted>")
    .replace(/(\/(?:Users|home)\/)[^\/\s]+/gi, "$1<redacted>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<redacted-email>")
    .trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}
