import assert from "node:assert/strict";
import test from "node:test";

test("import batches accept only bounded business-table scalar rows", async () => {
  const importContract = await import("../lib/import-contract.ts").catch(() => null);
  assert.ok(importContract, "import contract should exist");

  assert.deepEqual(
    importContract.parseImportBatch({ table: "Project", rows: [{ id: "p1", title: "A", archivedAt: null }] }),
    { table: "Project", rows: [{ id: "p1", title: "A", archivedAt: null }] },
  );
  assert.throws(() => importContract.parseImportBatch({ table: "runner_tokens", rows: [] }), /不允许导入/);
  assert.throws(
    () => importContract.parseImportBatch({ table: "Project", rows: Array.from({ length: 51 }, (_, i) => ({ id: `p${i}` })) }),
    /最多 50/,
  );
  assert.throws(() => importContract.parseImportBatch({ table: "Project", rows: [{ id: { nested: true } }] }), /标量/);
  assert.throws(() => importContract.parseImportBatch({ table: "Project", rows: [{ id: ["p1"] }] }), /标量/);
});

test("import bearer verification is exact and never returns the secret", async () => {
  const importContract = await import("../lib/import-contract.ts").catch(() => null);
  assert.ok(importContract, "import contract should exist");

  assert.equal(await importContract.verifyImportBearer("Bearer one-time-secret", "one-time-secret"), true);
  assert.equal(await importContract.verifyImportBearer("Bearer wrong-secret", "one-time-secret"), false);
  assert.equal(await importContract.verifyImportBearer(null, "one-time-secret"), false);
  assert.equal(await importContract.verifyImportBearer("Basic one-time-secret", "one-time-secret"), false);
});

test("SQL identifiers are always double-quoted", async () => {
  const importContract = await import("../lib/import-contract.ts");
  assert.equal(importContract.quoteSqlIdentifier("Project"), '"Project"');
  assert.equal(importContract.quoteSqlIdentifier('odd"name'), '"odd""name"');
});
