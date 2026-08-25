const MAX_ID_CHARS = 120;
const MAX_LEASE_TOKEN_CHARS = 512;
const MAX_RESULT_CHARS = 200_000;
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
