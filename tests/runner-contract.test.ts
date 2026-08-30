import assert from "node:assert/strict";
import test from "node:test";

import {
  parseClaimBody,
  parseHeartbeatBody,
  parseReportBody,
} from "../lib/runner-contract.ts";

test("claim requires a short device id", () => {
  assert.deepEqual(parseClaimBody({ deviceId: " mac-studio " }), { deviceId: "mac-studio" });
  assert.equal(parseClaimBody({ deviceId: "" }), null);
  assert.equal(parseClaimBody({ deviceId: "x".repeat(121) }), null);
  assert.equal(parseClaimBody(null), null);
});

test("heartbeat requires job and lease tokens", () => {
  assert.deepEqual(parseHeartbeatBody({ jobId: "job-1", leaseToken: "lease-1" }), {
    jobId: "job-1",
    leaseToken: "lease-1",
  });
  assert.equal(parseHeartbeatBody({ jobId: "job-1" }), null);
});

test("report accepts final states and rejects oversized output", () => {
  assert.deepEqual(
    parseReportBody({ jobId: "job-1", leaseToken: "lease-1", status: "succeeded", result: { ok: true } }),
    { jobId: "job-1", leaseToken: "lease-1", status: "succeeded", result: "{\"ok\":true}", error: null },
  );
  assert.equal(parseReportBody({ jobId: "job-1", leaseToken: "lease-1", status: "running" }), null);
  assert.equal(
    parseReportBody({
      jobId: "job-1",
      leaseToken: "lease-1",
      status: "failed",
      error: "x".repeat(20_001),
    }),
    null,
  );
});
