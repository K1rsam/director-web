import assert from "node:assert/strict";
import test from "node:test";

class FakeStatement {
  values: unknown[] = [];
  readonly db: FakeD1;
  readonly sql: string;

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async all<T>() {
    this.db.reads.push({ sql: this.sql, values: this.values });
    if (this.sql.includes('FROM "Project" AS p')) return { results: this.db.projectRows as T[] };
    if (this.sql.includes('FROM "Episode" AS e')) return { results: this.db.episodeRows as T[] };
    return { results: [] as T[] };
  }

  async first<T>() {
    return null as T | null;
  }

  async run() {
    return { success: true };
  }
}

class FakeD1 {
  reads: Array<{ sql: string; values: unknown[] }> = [];
  batches: FakeStatement[][] = [];
  projectRows: unknown[] = [];
  episodeRows: unknown[] = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    this.batches.push(statements);
    return statements.map(() => ({ success: true, results: [] }));
  }
}

test("project library is role-scoped with active/archive and original count shape", async () => {
  const repository = await import("../lib/repositories/projects.ts").catch(() => null);
  assert.ok(repository, "project repository should exist");

  const db = new FakeD1();
  db.projectRows = [
    {
      id: "p1", title: "项目一", description: null, style: "真人电影写实", aspectRatio: "16:9",
      updatedAt: 1000, archivedAt: null, episodeCount: 1, assetCount: 2, snapshotCount: 3,
    },
    {
      id: "p2", title: "归档项目", description: "说明", style: null, aspectRatio: "9:16",
      updatedAt: 900, archivedAt: 950, episodeCount: 1, assetCount: 0, snapshotCount: 0,
    },
  ];
  db.episodeRows = [
    { id: "e1", projectId: "p1", number: 1, title: "第1集", unitCount: 2 },
    { id: "e2", projectId: "p2", number: 1, title: null, unitCount: 0 },
  ];

  const result = await repository.listProjectLibrary("u1", db);
  assert.equal(result.projects.length, 1);
  assert.equal(result.archivedProjects.length, 1);
  assert.deepEqual(result.projects[0]._count, { episodes: 1, assets: 2, sceneSnapshots: 3 });
  assert.deepEqual(result.projects[0].episodes[0]._count, { seedanceUnits: 2 });
  assert.ok(result.projects[0].updatedAt instanceof Date);
  assert.ok(db.reads.every((read) => read.sql.includes('"ProjectRole"')));
  assert.ok(db.reads.every((read) => read.values.includes("u1")));
});

test("text project creation batches Project, ProjectRole, Episode, and ScriptScene", async () => {
  const repository = await import("../lib/repositories/projects.ts").catch(() => null);
  assert.ok(repository, "project repository should exist");

  const db = new FakeD1();
  const result = await repository.createProjectFromText(
    {
      ownerUserId: "u1",
      title: "新项目",
      style: "真人电影写实",
      aspectRatio: "16:9",
      executionMode: "API",
      sourceName: "demo.txt",
      sourceText: "第1集\n1-1\n客厅 日 内\n人物：甲\n1-2\n街道 夜 外\n人物：乙",
    },
    db,
    new Date("2026-08-25T00:00:00.000Z"),
  );

  assert.equal(db.batches.length, 1);
  const sql = db.batches[0].map((statement) => statement.sql).join("\n");
  for (const table of ["Project", "ProjectRole", "Episode", "ScriptScene"]) {
    assert.match(sql, new RegExp(`INSERT INTO "${table}"`));
  }
  assert.equal(result.episodes.length, 1);
  assert.equal(result.destination, `/projects/${encodeURIComponent(result.project.id)}`);
});
