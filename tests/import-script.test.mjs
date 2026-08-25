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

test("curl import responses separate JSON from the HTTP status", async () => {
  const module = await import("../scripts/import-original-database.mjs");
  assert.deepEqual(module.parseCurlJsonResponse('{"table":"User","inserted":1}\n200'), {
    table: "User",
    inserted: 1,
  });
  assert.throws(() => module.parseCurlJsonResponse("blocked\n403"), /HTTP 403/);
});

test("orphaned legacy rows receive one hidden compatibility project", async () => {
  const module = await import("../scripts/import-original-database.mjs");
  const snapshot = [
    { table: "Project", rows: [{ id: "existing", title: "已有项目" }] },
    { table: "Episode", rows: [{ id: "e1", projectId: "deleted-project" }] },
    { table: "Asset", rows: [{ id: "a1", projectId: "deleted-project" }] },
  ];
  const prepared = module.addCompatibilityProjectRows(snapshot);
  const sourceProjects = snapshot.find((item) => item.table === "Project").rows;
  const preparedProjects = prepared.find((item) => item.table === "Project").rows;

  assert.equal(sourceProjects.length, 1);
  assert.equal(preparedProjects.length, 2);
  assert.equal(preparedProjects.some((project) => project.id === "deleted-project"), true);
  assert.equal(preparedProjects.find((project) => project.id === "deleted-project").archivedAt !== null, true);
});
