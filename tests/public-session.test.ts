import assert from "node:assert/strict";
import test from "node:test";

test("public visitors receive an isolated reusable device session without ChatGPT", async () => {
  const module = await import("../lib/public-session.ts").catch(() => null);
  assert.ok(module, "public session support should exist");

  const first = module.resolvePublicSession(null);
  assert.equal(first.created, true);
  assert.match(first.sessionId, /^[0-9a-f-]{36}$/);

  const returning = module.resolvePublicSession(first.sessionId);
  assert.deepEqual(returning, { sessionId: first.sessionId, created: false });
});

test("public session return paths stay on this site", async () => {
  const module = await import("../lib/public-session.ts").catch(() => null);
  assert.ok(module, "public session support should exist");

  assert.equal(module.sanitizeReturnTo("/runner?tab=device"), "/runner?tab=device");
  assert.equal(module.sanitizeReturnTo("https://example.com"), "/");
  assert.equal(module.sanitizeReturnTo("//example.com"), "/");
  assert.equal(module.sanitizeReturnTo("/\\example.com"), "/");
  assert.equal(module.sanitizeReturnTo("/session/start"), "/");
});
