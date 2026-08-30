const MAX_ID_CHARS = 120;
const MAX_LEASE_TOKEN_CHARS = 512;
// P1/P2 的资产表可能包含上千条带 metadata 的记录；结果仍然是有范围的 JSON，
// 但 200K 会在正常项目上被误判为超限。上限与单次 Runner 任务范围、40 条一批回写配套。
const MAX_RESULT_CHARS = 8_000_000;
const MAX_ERROR_CHARS = 20_000;

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : null;
}

function shortString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : null;
}

export function parseClaimBody(value: unknown): { deviceId: string } | null {
  const body = record(value);
  const deviceId = shortString(body?.deviceId, MAX_ID_CHARS);
  return deviceId ? { deviceId } : null;
}

export function parseHeartbeatBody(
  value: unknown,
): { jobId: string; leaseToken: string } | null {
  const body = record(value);
  const jobId = shortString(body?.jobId, MAX_ID_CHARS);
  const leaseToken = shortString(body?.leaseToken, MAX_LEASE_TOKEN_CHARS);
  return jobId && leaseToken ? { jobId, leaseToken } : null;
}

export function parseJobInputBody(
  value: unknown,
): { jobId: string; leaseToken: string } | null {
  return parseHeartbeatBody(value);
}

export function parseReportBody(value: unknown): {
  jobId: string;
  leaseToken: string;
  status: "succeeded" | "failed";
  result: string | null;
  error: string | null;
} | null {
  const body = record(value);
  const lease = parseHeartbeatBody(body);
  if (!lease || (body?.status !== "succeeded" && body?.status !== "failed")) return null;

  let result: string | null = null;
  try {
    if (body.result !== undefined) result = JSON.stringify(body.result);
  } catch {
    return null;
  }
  if (result !== null && result.length > MAX_RESULT_CHARS) return null;

  const error = body.error === undefined || body.error === null ? null : shortString(body.error, MAX_ERROR_CHARS);
  if (body.error !== undefined && body.error !== null && error === null) return null;

  return { ...lease, status: body.status, result, error };
}
