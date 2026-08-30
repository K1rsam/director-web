import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

const sourceDb = process.env.DIRECTOR_SOURCE_DB || "/Users/yue/Documents/CL/prisma/dev.db";

test("local import snapshot contains the complete original database", async (t) => {
  if (!existsSync(sourceDb)) {
    t.skip("DIRECTOR_SOURCE_DB 未提供，跳过需要本地源数据库的迁移回归。");
    return;
  }
  const importScript = await import("../scripts/import-original-database.mjs").catch(() => null);
  assert.ok(importScript, "database import script should exist");

  const snapshot = importScript.readLocalSnapshot(sourceDb);
  assert.equal(snapshot.length, 21);
  assert.equal(snapshot.reduce((total, item) => total + item.rows.length, 0), 4568);
  assert.deepEqual(snapshot.map((item) => item.table), importScript.IMPORT_TABLE_ORDER);
});

test("asset parents are emitted before descendants", async () => {
  const importScript = await import("../scripts/import-original-database.mjs").catch(() => null);
  assert.ok(importScript, "database import script should exist");

  const ordered = importScript.orderAssetRows([
    { id: "grandchild", parentId: "child" },
    { id: "child", parentId: "root" },
    { id: "root", parentId: null },
  ]);
  assert.deepEqual(ordered.map((row) => row.id), ["root", "child", "grandchild"]);
});

test("curl import responses separate JSON from the HTTP status", async () => {
  const importScript = await import("../scripts/import-original-database.mjs");
  assert.deepEqual(importScript.parseCurlJsonResponse('{"table":"User","inserted":1}\n200'), {
    table: "User",
    inserted: 1,
  });
  assert.throws(() => importScript.parseCurlJsonResponse("blocked\n403"), /HTTP 403/);
});

test("orphaned legacy rows receive one hidden compatibility project", async () => {
  const importScript = await import("../scripts/import-original-database.mjs");
  const snapshot = [
    { table: "Project", rows: [{ id: "existing", title: "已有项目" }] },
    { table: "Episode", rows: [{ id: "e1", projectId: "deleted-project" }] },
    { table: "Asset", rows: [{ id: "a1", projectId: "deleted-project" }] },
  ];
  const prepared = importScript.addCompatibilityProjectRows(snapshot);
  const sourceProjects = snapshot.find((item) => item.table === "Project").rows;
  const preparedProjects = prepared.find((item) => item.table === "Project").rows;

  assert.equal(sourceProjects.length, 1);
  assert.equal(preparedProjects.length, 2);
  assert.equal(preparedProjects.some((project) => project.id === "deleted-project"), true);
  assert.equal(preparedProjects.find((project) => project.id === "deleted-project").archivedAt !== null, true);
});
