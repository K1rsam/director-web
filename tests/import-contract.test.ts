import assert from "node:assert/strict";
import test from "node:test";

test("import batches accept only bounded business-table scalar rows", async () => {
  const module = await import("../lib/import-contract.ts").catch(() => null);
  assert.ok(module, "import contract should exist");

  assert.deepEqual(
    module.parseImportBatch({ table: "Project", rows: [{ id: "p1", title: "A", archivedAt: null }] }),
    { table: "Project", rows: [{ id: "p1", title: "A", archivedAt: null }] },
  );
  assert.throws(() => module.parseImportBatch({ table: "runner_tokens", rows: [] }), /不允许导入/);
  assert.throws(
    () => module.parseImportBatch({ table: "Project", rows: Array.from({ length: 51 }, (_, i) => ({ id: `p${i}` })) }),
    /最多 50/,
  );
  assert.throws(() => module.parseImportBatch({ table: "Project", rows: [{ id: { nested: true } }] }), /标量/);
  assert.throws(() => module.parseImportBatch({ table: "Project", rows: [{ id: ["p1"] }] }), /标量/);
});

test("import bearer verification is exact and never returns the secret", async () => {
  const module = await import("../lib/import-contract.ts").catch(() => null);
  assert.ok(module, "import contract should exist");

  assert.equal(await module.verifyImportBearer("Bearer one-time-secret", "one-time-secret"), true);
  assert.equal(await module.verifyImportBearer("Bearer wrong-secret", "one-time-secret"), false);
  assert.equal(await module.verifyImportBearer(null, "one-time-secret"), false);
  assert.equal(await module.verifyImportBearer("Basic one-time-secret", "one-time-secret"), false);
});

test("SQL identifiers are always double-quoted", async () => {
  const module = await import("../lib/import-contract.ts");
  assert.equal(module.quoteSqlIdentifier("Project"), '"Project"');
  assert.equal(module.quoteSqlIdentifier('odd"name'), '"odd""name"');
});
