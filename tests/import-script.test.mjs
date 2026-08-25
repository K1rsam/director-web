import assert from "node:assert/strict";
import test from "node:test";

const sourceDb = "/Users/yue/Documents/CL/prisma/dev.db";

test("local import snapshot contains the complete original database", async () => {
  const module = await import("../scripts/import-original-database.mjs").catch(() => null);
  assert.ok(module, "database import script should exist");

  const snapshot = module.readLocalSnapshot(sourceDb);
  assert.equal(snapshot.length, 21);
  assert.equal(snapshot.reduce((total, item) => total + item.rows.length, 0), 4568);
  assert.deepEqual(snapshot.map((item) => item.table), module.IMPORT_TABLE_ORDER);
});

test("asset parents are emitted before descendants", async () => {
  const module = await import("../scripts/import-original-database.mjs").catch(() => null);
  assert.ok(module, "database import script should exist");

  const ordered = module.orderAssetRows([
    { id: "grandchild", parentId: "child" },
    { id: "child", parentId: "root" },
    { id: "root", parentId: null },
  ]);
  assert.deepEqual(ordered.map((row) => row.id), ["root", "child", "grandchild"]);
});
