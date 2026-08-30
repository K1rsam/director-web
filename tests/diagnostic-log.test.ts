import assert from "node:assert/strict";
import test from "node:test";

import {
  createDiagnosticEvent,
  parseDiagnosticReportBody,
  sanitizeDiagnosticText,
  toDiagnosticEnvelope,
} from "../lib/diagnostic-log.ts";

test("minimal diagnostics omit stack and command output", () => {
  const event = createDiagnosticEvent({
    kind: "runner_connection_failed",
    code: "RUNNER_HTTP_403",
    operation: "claim",
    error: new Error("Bearer runner-secret 连接失败"),
    details: { stack: "Error: secret stack", stderrTail: "apiKey=secret-value" },
  });
  const minimal = toDiagnosticEnvelope(event, "minimal");
  const detailed = toDiagnosticEnvelope(event, "detailed");

  assert.equal(minimal.scope, "minimal");
  assert.equal(minimal.event.details, undefined);
  assert.equal(detailed.scope, "detailed");
  assert.equal(detailed.event.details?.stderrTail, "apiKey=<redacted>");
  assert.equal(parseDiagnosticReportBody(minimal)?.scope, "minimal");
});

test("diagnostic text redacts credentials, query strings, paths, and emails", () => {
  const value = sanitizeDiagnosticText(
    "Bearer abc123 apiKey=secret https://example.test/run?token=hidden C:\\Users\\EDY\\project EDY@example.test",
  );
  assert.doesNotMatch(value, /abc123|secret|hidden|EDY@example\.test/);
  assert.match(value, /Bearer <redacted>/);
  assert.match(value, /<redacted-query>/);
  assert.match(value, /C:\\Users\\<redacted>/);
});

test("detailed diagnostics require a bounded, valid upload request", () => {
  const event = createDiagnosticEvent({
    kind: "task_failed",
    code: "LOCAL_TASK_FAILED",
    operation: "task",
    message: "task failed",
  });
  const body = {
    schemaVersion: 1 as const,
    scope: "detailed" as const,
    requestId: "diag-request-1",
    events: [toDiagnosticEnvelope(event, "detailed")],
  };
  assert.equal(parseDiagnosticReportBody(body)?.scope, "detailed");
  assert.equal(parseDiagnosticReportBody({ ...body, requestId: "" }), null);
});

test("the standalone Runner uses the same schema version and scope names", async () => {
  const runnerContract = await import("../public/runner/diagnostic-log.mjs");
  assert.equal(runnerContract.DIAGNOSTIC_SCHEMA_VERSION, 1);
  const event = runnerContract.createDiagnosticEvent({
    kind: "task_failed",
    code: "LOCAL_TASK_FAILED",
    operation: "task",
    message: "failed",
  });
  assert.equal(runnerContract.toDiagnosticEnvelope(event, "minimal").scope, "minimal");
  assert.equal(runnerContract.toDiagnosticEnvelope(event, "detailed").scope, "detailed");
});

