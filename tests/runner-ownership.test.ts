import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("runner bearer identity must resolve to the original User row", async () => {
  const ownership = await import("../lib/runner-ownership.ts").catch(() => null);
  assert.ok(ownership, "runner ownership helpers should exist");

  assert.deepEqual(
    ownership.runnerIdentityFromRow({ tokenId: "t1", ownerUserId: "u1", userId: "u1" }),
    { tokenId: "t1", ownerUserId: "u1" },
  );
  assert.equal(
    ownership.runnerIdentityFromRow({ tokenId: "t1", ownerUserId: "prototype-user", userId: null }),
    null,
  );
});

test("runner can claim only jobs owned by a matching ProjectRole user", async () => {
  const ownership = await import("../lib/runner-ownership.ts").catch(() => null);
  assert.ok(ownership, "runner ownership helpers should exist");
  const identity = { tokenId: "t1", ownerUserId: "u1" };

  assert.equal(ownership.canClaimRunnerJob(identity, { ownerUserId: "u1", projectRoleUserId: "u1" }), true);
  assert.equal(ownership.canClaimRunnerJob(identity, { ownerUserId: "u2", projectRoleUserId: "u1" }), false);
  assert.equal(ownership.canClaimRunnerJob(identity, { ownerUserId: "u1", projectRoleUserId: "u2" }), false);
  assert.equal(ownership.canClaimRunnerJob(identity, { ownerUserId: "u1", projectRoleUserId: null }), false);
});

test("runner query and schema use User, ProjectRole, and original Project", () => {
  const api = readFileSync("lib/runner-api.ts", "utf8");
  const schema = readFileSync("db/schema.ts", "utf8");
  assert.match(api, /projectRoles/);
  assert.match(api, /users/);
  assert.match(schema, /sqliteTable\(\s*"Project"/);
  assert.match(schema, /sqliteTable\(\s*"ProjectRole"/);
  assert.match(schema, /sqliteTable\(\s*"User"/);
  assert.doesNotMatch(schema, /sqliteTable\(\s*"projects"/);
});
