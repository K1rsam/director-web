import { ensureControlPlaneSchema } from "@/db/ensure-schema";
import { getD1 } from "@/db";
import { allRows, firstRow } from "@/lib/d1-query";
import {
  parseDiagnosticEnvelope,
  type DiagnosticEnvelope,
  type DiagnosticEvent,
  type DiagnosticReportBody,
} from "@/lib/diagnostic-log";
import type { RunnerIdentity } from "@/lib/runner-ownership";

const DIAGNOSTIC_RETENTION_MS = 90 * 24 * 60 * 60_000;
const UPLOAD_REQUEST_TTL_MS = 30 * 60_000;

type DiagnosticRow = {
  id: string;
  event_id: string;
  runner_token_id: string;
  device_id: string;
  scope: "minimal" | "detailed";
  kind: string;
  code: string;
  operation: string;
  severity: "warning" | "error";
  job_id: string | null;
  task_kind: string | null;
  occurred_at: number;
  received_at: number;
  event_json: string;
  device_name: string;
};

export type RunnerDiagnosticLogView = {
  id: string;
  eventId: string;
  runnerTokenId: string;
  deviceId: string;
  deviceName: string;
  scope: "minimal" | "detailed";
  kind: string;
  code: string;
  operation: string;
  severity: "warning" | "error";
  jobId: string | null;
  taskKind: string | null;
  occurredAt: string;
  receivedAt: string;
  event: DiagnosticEvent;
};

export type RunnerDiagnosticUploadRequestView = {
  id: string;
  runnerTokenId: string;
  deviceName: string;
  status: "requested" | "uploaded" | "expired";
  createdAt: string;
  completedAt: string | null;
};

export async function recordRunnerDiagnostics(identity: RunnerIdentity, body: DiagnosticReportBody): Promise<number> {
  await ensureControlPlaneSchema();
  const d1 = getD1();
  const now = Date.now();
  let envelopes: DiagnosticEnvelope[];
  let requestId: string | null = null;

  if (body.scope === "minimal") {
    envelopes = [body];
  } else {
    if (!("requestId" in body) || !("events" in body)) throw new Error("详细诊断上传请求格式无效。");
    requestId = body.requestId;
    const request = await firstRow<{ id: string }>(d1, `
      SELECT id FROM runner_diagnostic_upload_requests
      WHERE id = ? AND runner_token_id = ? AND owner_user_id = ? AND status = 'requested'
      LIMIT 1
    `, [requestId, identity.tokenId, identity.ownerUserId]);
    if (!request) throw new Error("详细诊断上传请求已过期或不存在。");
    envelopes = body.events;
  }

  const statements = envelopes.map((envelope) => diagnosticInsertStatement(d1, identity, envelope, now));
  statements.push(
    d1.prepare("DELETE FROM runner_diagnostic_logs WHERE owner_user_id = ? AND received_at < ?")
      .bind(identity.ownerUserId, now - DIAGNOSTIC_RETENTION_MS),
  );
  if (requestId) {
    statements.push(
      d1.prepare(`UPDATE runner_diagnostic_upload_requests
        SET status = 'uploaded', completed_at = ?
        WHERE id = ? AND runner_token_id = ? AND owner_user_id = ? AND status = 'requested'`)
        .bind(now, requestId, identity.tokenId, identity.ownerUserId),
    );
  }
  await d1.batch(statements);
  return envelopes.length;
}

export async function claimPendingDiagnosticUpload(identity: RunnerIdentity): Promise<string | null> {
  await ensureControlPlaneSchema();
  const d1 = getD1();
  const cutoff = Date.now() - UPLOAD_REQUEST_TTL_MS;
  await d1.prepare(`UPDATE runner_diagnostic_upload_requests
    SET status = 'expired'
    WHERE runner_token_id = ? AND owner_user_id = ? AND status = 'requested' AND created_at < ?`)
    .bind(identity.tokenId, identity.ownerUserId, cutoff)
    .run();
  const row = await firstRow<{ id: string }>(d1, `
    SELECT id FROM runner_diagnostic_upload_requests
    WHERE runner_token_id = ? AND owner_user_id = ? AND status = 'requested'
    ORDER BY created_at ASC LIMIT 1
  `, [identity.tokenId, identity.ownerUserId]);
  return row?.id ?? null;
}

export async function requestDetailedDiagnostics(userId: string, runnerTokenId: string): Promise<{ id: string; status: "requested" } | null> {
  await ensureControlPlaneSchema();
  const d1 = getD1();
  const token = await firstRow<{ id: string }>(d1, `
    SELECT id FROM runner_tokens
    WHERE id = ? AND owner_user_id = ? AND revoked_at IS NULL
    LIMIT 1
  `, [runnerTokenId, userId]);
  if (!token) return null;

  const now = Date.now();
  const existing = await firstRow<{ id: string }>(d1, `
    SELECT id FROM runner_diagnostic_upload_requests
    WHERE runner_token_id = ? AND owner_user_id = ? AND status = 'requested' AND created_at >= ?
    ORDER BY created_at DESC LIMIT 1
  `, [runnerTokenId, userId, now - UPLOAD_REQUEST_TTL_MS]);
  if (existing) return { id: existing.id, status: "requested" };

  const id = `diag-request-${crypto.randomUUID()}`;
  await d1.prepare(`INSERT INTO runner_diagnostic_upload_requests
    (id, owner_user_id, runner_token_id, status, created_at, completed_at)
    VALUES (?, ?, ?, 'requested', ?, NULL)`)
    .bind(id, userId, runnerTokenId, now)
    .run();
  return { id, status: "requested" };
}

export async function listRunnerDiagnostics(userId: string): Promise<{
  logs: RunnerDiagnosticLogView[];
  requests: RunnerDiagnosticUploadRequestView[];
}> {
  await ensureControlPlaneSchema();
  const d1 = getD1();
  const rows = await allRows<DiagnosticRow>(d1, `
    SELECT l.*, t.name AS device_name
    FROM runner_diagnostic_logs l
    INNER JOIN runner_tokens t ON t.id = l.runner_token_id
    WHERE l.owner_user_id = ?
    ORDER BY l.received_at DESC
    LIMIT 100
  `, [userId]);
  const logs = rows.flatMap((row) => {
    try {
      const envelope = parseDiagnosticEnvelope(JSON.parse(row.event_json), row.scope);
      return envelope ? [
        {
          id: row.id,
          eventId: row.event_id,
          runnerTokenId: row.runner_token_id,
          deviceId: row.device_id,
          deviceName: row.device_name,
          scope: row.scope,
          kind: row.kind,
          code: row.code,
          operation: row.operation,
          severity: row.severity,
          jobId: row.job_id,
          taskKind: row.task_kind,
          occurredAt: new Date(row.occurred_at).toISOString(),
          receivedAt: new Date(row.received_at).toISOString(),
          event: envelope.event,
        },
      ] : [];
    } catch {
      return [];
    }
  });

  const requestRows = await allRows<{
    id: string;
    runner_token_id: string;
    device_name: string;
    status: "requested" | "uploaded" | "expired";
    created_at: number;
    completed_at: number | null;
  }>(d1, `
    SELECT r.*, t.name AS device_name
    FROM runner_diagnostic_upload_requests r
    INNER JOIN runner_tokens t ON t.id = r.runner_token_id
    WHERE r.owner_user_id = ?
    ORDER BY r.created_at DESC
    LIMIT 30
  `, [userId]);
  const requests = requestRows.map((row) => ({
    id: row.id,
    runnerTokenId: row.runner_token_id,
    deviceName: row.device_name,
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
  }));
  return { logs, requests };
}

function diagnosticInsertStatement(
  d1: D1Database,
  identity: RunnerIdentity,
  envelope: DiagnosticEnvelope,
  receivedAt: number,
) {
  const event = envelope.event;
  return d1.prepare(`INSERT INTO runner_diagnostic_logs
    (id, owner_user_id, runner_token_id, device_id, event_id, scope, kind, code, operation, severity, job_id, task_kind, occurred_at, received_at, event_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(runner_token_id, event_id) DO UPDATE SET
      device_id = excluded.device_id,
      scope = excluded.scope,
      kind = excluded.kind,
      code = excluded.code,
      operation = excluded.operation,
      severity = excluded.severity,
      job_id = excluded.job_id,
      task_kind = excluded.task_kind,
      occurred_at = excluded.occurred_at,
      received_at = excluded.received_at,
      event_json = excluded.event_json
    WHERE excluded.scope = 'detailed' AND runner_diagnostic_logs.scope = 'minimal'`)
    .bind(
      `diag-${crypto.randomUUID()}`,
      identity.ownerUserId,
      identity.tokenId,
      event.deviceId ?? "unknown-device",
      event.eventId,
      envelope.scope,
      event.kind,
      event.code,
      event.operation,
      event.severity,
      event.jobId ?? null,
      event.taskKind ?? null,
      Date.parse(event.occurredAt),
      receivedAt,
      JSON.stringify(envelope),
    );
}

