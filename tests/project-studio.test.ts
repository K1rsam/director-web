import assert from "node:assert/strict";
import test from "node:test";

class FakeStatement {
  values: unknown[] = [];
  readonly sql: string;
  readonly db: FakeD1;

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  async first<T>() {
    if (this.sql.includes('FROM "Project" AS p')) return this.db.project as T | null;
    return null;
  }

  async all<T>() {
    const key = this.sql.includes('FROM "Asset"') ? "assets"
      : this.sql.includes('FROM "SceneSnapshot"') ? "snapshots"
        : this.sql.includes('FROM "Episode"') ? "episodes"
          : this.sql.includes('FROM "ScriptScene"') ? "scenes"
            : this.sql.includes('FROM "PipelineRun"') ? "runs"
              : this.sql.includes('FROM "PresentationContract"') ? "contracts"
                : "unknown";
    return { results: this.db.rows[key] as T[] };
  }

  async run() {
    return { success: true };
  }
}

class FakeD1 {
  project: unknown = null;
  rows: Record<string, unknown[]> = {
    assets: [], snapshots: [], episodes: [], scenes: [], runs: [], contracts: [], unknown: [],
  };

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }
}

test("project studio returns the exact original page read model", async () => {
  const repository = await import("../lib/repositories/project-studio.ts").catch(() => null);
  assert.ok(repository, "project studio repository should exist");

  const db = new FakeD1();
  db.project = {
    id: "p1", title: "项目一", description: null, style: "真人电影写实", aspectRatio: "16:9",
    executionMode: "API", updatedAt: 1000,
  };
  db.rows.assets = [
    { id: "a1", code: "CH-001", type: "CH", name: "甲", status: "confirmed", episodeId: null, parentId: null, metadata: '{"role":"主角"}' },
  ];
  db.rows.snapshots = [
    { sceneKey: "PROJECT_MEMORY", content: '{"schema":"PROJECT_MEMORY_V2","episodes":[]}', createdAt: 900 },
  ];
  db.rows.episodes = [
    { id: "e1", number: 1, title: null, content: "第一集正文", shotCount: 2, unitCount: 1, issueCount: 0, taskPackageCount: 1 },
  ];
  db.rows.scenes = [
    { id: "s1", episodeId: "e1", sceneKey: "1-1", sortOrder: 1, heading: "客厅 日 内", location: "客厅", interiorExterior: "内", timeOfDay: "日", weather: null, timeLayer: "现实", sourceText: "正文", metadata: "{}" },
  ];
  db.rows.runs = [
    { id: "r1", episodeId: null, stageCode: "P1", roleName: "全剧基础策划", status: "SUCCEEDED", model: "codex", durationMs: 1200, createdAt: 800, error: null },
    { id: "r2", episodeId: "e1", stageCode: "E0", roleName: "叙事节奏", status: "SUCCEEDED", model: "codex", durationMs: 1000, createdAt: 850, error: null },
  ];

  const studio = await repository.getProjectStudio("p1", "u1", db);
  assert.ok(studio);
  assert.deepEqual(studio.project, {
    id: "p1", title: "项目一", description: "暂无项目简介", style: "真人电影写实",
    aspectRatio: "16:9", executionMode: "API", updatedAt: new Date(1000),
  });
  assert.equal(studio.firstPhase.planningReady, true);
  assert.equal(studio.firstPhase.assetsReady, true);
  assert.equal(studio.firstPhase.sceneCount, 1);
  assert.equal(studio.assets[0].role, "主角");
  assert.equal(studio.episodes[0].scenes[0].sceneKey, "1-1");
  assert.equal(studio.episodes[0].roles[0].code, "E0");
  assert.equal(studio.episodes[0].roles[0].status, "已完成");
  assert.equal(studio.projectRuns[0].stageCode, "P1");
});

test("presentation contracts are separated into pending and confirmed", async () => {
  const repository = await import("../lib/repositories/project-studio.ts").catch(() => null);
  assert.ok(repository, "project studio repository should exist");

  const db = new FakeD1();
  db.rows.contracts = [
    { id: "c1", category: "系统", question: "如何表现", options: '["A","B"]', evidence: null, userAnswer: null, status: "PENDING", round: 1, decidedAt: null },
    { id: "c2", category: "特效", question: "如何表现", options: '["C"]', evidence: null, userAnswer: "C", status: "CONFIRMED", round: 1, decidedAt: 1000 },
  ];
  const contracts = await repository.listPresentationContracts(db, "p1");
  assert.equal(contracts.pending.length, 1);
  assert.equal(contracts.confirmed.length, 1);
  assert.deepEqual(contracts.pending[0].options, ["A", "B"]);
  assert.ok(contracts.confirmed[0].decidedAt instanceof Date);
});
