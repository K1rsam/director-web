import assert from "node:assert/strict";
import test from "node:test";

import { hashRunnerToken, parseBearerToken } from "../lib/runner-auth.ts";

test("parseBearerToken only accepts one non-empty Bearer token", () => {
  assert.equal(parseBearerToken("Bearer runner-secret"), "runner-secret");
  assert.equal(parseBearerToken("bearer runner-secret"), "runner-secret");
  assert.equal(parseBearerToken("Basic runner-secret"), null);
  assert.equal(parseBearerToken("Bearer"), null);
  assert.equal(parseBearerToken("Bearer one two"), null);
  assert.equal(parseBearerToken(null), null);
});

test("hashRunnerToken is deterministic and does not return plaintext", async () => {
  const first = await hashRunnerToken("runner-secret");
  const second = await hashRunnerToken("runner-secret");

  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(first, "runner-secret");
});
