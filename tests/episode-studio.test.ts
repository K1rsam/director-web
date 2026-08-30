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

  async first<T>() {
    if (this.sql.includes('FROM "Episode" AS e')) return this.db.episode as T | null;
    if (this.sql.includes('MAX("version")')) return { version: 1 } as T;
    return null;
  }

  async all<T>() {
    const key = this.sql.includes('FROM "Episode" AS nav') ? "nav"
      : this.sql.includes('FROM "PipelineRun"') ? "runs"
        : this.sql.includes('FROM "ScriptScene"') ? "scenes"
          : this.sql.includes('FROM "StoryboardShot"') ? "shots"
            : this.sql.includes('FROM "SeedanceUnitShot"') ? "links"
              : this.sql.includes('FROM "SeedanceUnit"') ? "units"
                : this.sql.includes('FROM "CompiledPromptVersion"') ? "versions"
                  : this.sql.includes('FROM "WorkflowIssue"') ? "issues"
                    : this.sql.includes('FROM "Asset"') ? "assets"
                      : this.sql.includes('FROM "TaskPackage"') ? "packages"
                        : "unknown";
    return { results: this.db.rows[key] as T[] };
  }

  async run() {
    this.db.runs.push(this);
    return { success: true, meta: { changes: 1 } };
  }
}

class FakeD1 {
  episode: unknown = null;
  rows: Record<string, unknown[]> = {
    nav: [], runs: [], scenes: [], shots: [], units: [], links: [], versions: [], issues: [], assets: [], packages: [], unknown: [],
  };
  runs: FakeStatement[] = [];
  batches: FakeStatement[][] = [];

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async batch(statements: FakeStatement[]) {
    this.batches.push(statements);
    return statements.map(() => ({ success: true, meta: { changes: 1 }, results: [] }));
  }
}

test("episode studio contains navigation, shots, units, versions, issues, runs, assets, and info package", async () => {
  const repository = await import("../lib/repositories/episode-studio.ts").catch(() => null);
  assert.ok(repository, "episode studio repository should exist");

  const db = new FakeD1();
  db.episode = {
    id: "e1", projectId: "p1", number: 1, title: "第一集", content: "正文",
    projectTitle: "项目", style: "真人电影写实", aspectRatio: "16:9", executionMode: "API",
  };
  db.rows.nav = [{ id: "e1", number: 1, title: "第一集", shotCount: 1, unitCount: 1 }];
  db.rows.runs = [{
    id: "r1", episodeId: "e1", stageCode: "E0", roleName: "叙事节奏", provider: "CLI", model: "codex",
    status: "SUCCEEDED", inputSummary: "in", outputSummary: "out", log: "log", error: null,
    startedAt: 100, finishedAt: 200, durationMs: 100, createdAt: 100,
  }];
  db.rows.scenes = [{
    id: "s1", sceneKey: "1-1", sortOrder: 1, heading: "客厅 日 内", location: "客厅",
    interiorExterior: "内", timeOfDay: "日", weather: null, timeLayer: "现实", sourceText: "正文",
  }];
  db.rows.shots = [{
    id: "sh1", sceneId: "s1", shotKey: "1-1-1", sortOrder: 1, duration: 2.5, sourceNodeRefs: "[]",
    dialogue: '[{"speaker":"甲","text":"你好","type":"对白"}]', e1Data: '{"picture":"甲入画"}', e2Data: "{}",
    e3Data: '{"sound":"脚步声"}', e4Data: '{"camera_motion":"推进"}', revision: "V1_E4",
  }];
  db.rows.units = [{
    id: "u1", sceneId: "s1", unitKey: "1-1-U01", sortOrder: 1, duration: 2.5, dominantGoal: "进场",
    startPremise: "门外", endState: "入内", data: '{"unit_lighting":"暖光"}', revision: "V1",
  }];
  db.rows.links = [{ unitId: "u1", shotId: "sh1", shotKey: "1-1-1", sortOrder: 1 }];
  db.rows.versions = [{ id: "v1", unitId: "u1", version: 1, content: "提示词", syncStatus: "RELEASE_COMPILED", selectedAt: 300 }];
  db.rows.issues = [{ id: "i1", shotId: "sh1", unitId: "u1", coordinate: "1-1-1.picture", code: "X", severity: "BLOCKER", status: "OPEN", ownerRole: "E2", evidence: "证据", requestedEffect: "修复", createdAt: 400 }];
  db.rows.assets = [{ code: "CH-001", type: "CH", name: "甲", status: "confirmed", episodeId: null, metadata: '{"scene_refs":["1-1"]}' }];
  db.rows.packages = [{ payload: '{"schema":"TASK_SCHEMA_V4"}', createdAt: 500 }];

  const studio = await repository.getEpisodeStudio("p1", "e1", "user1", db);
  assert.ok(studio);
  assert.equal(studio.episodeNav.length, 1);
  assert.equal(studio.scenes[0].shots[0].picture, "甲入画");
  assert.equal(studio.scenes[0].shots[0].cameraMotion, "推进");
  assert.equal(studio.units[0].versions[0].content, "提示词");
  assert.equal(studio.units[0].openIssueCount, 1);
  assert.equal(studio.issues.length, 1);
  assert.equal(studio.runs.length, 1);
  assert.equal(studio.assets[0].code, "CH-001");
  assert.equal(studio.episode.infoPackage, '{"schema":"TASK_SCHEMA_V4"}');
});

test("ordinary episode edits are ownership-scoped and reset in one D1 batch", async () => {
  const repository = await import("../lib/repositories/episode-studio.ts").catch(() => null);
  assert.ok(repository, "episode studio repository should exist");

  const db = new FakeD1();
  await repository.acknowledgeIssue(db, "p1", "e1", "i1", new Date(1000));
  assert.match(db.runs[0].sql, /UPDATE "WorkflowIssue"/);
  assert.deepEqual(db.runs[0].values.slice(-3), ["i1", "p1", "e1"]);

  await repository.saveManualPromptVersion(db, "p1", "e1", "u1", "手动提示词", new Date(2000));
  assert.match(db.runs.at(-1).sql, /INSERT INTO "CompiledPromptVersion"/);

  await repository.resetEpisodeData(db, "p1", "e1");
  assert.equal(db.batches.length, 1);
  const resetSql = db.batches[0].map((statement) => statement.sql).join("\n");
  for (const table of ["WorkflowIssue", "CompiledPromptVersion", "SeedanceUnitShot", "SeedanceUnit", "StoryboardShot", "PipelineRun"]) {
    assert.match(resetSql, new RegExp(`DELETE FROM "${table}"`));
  }
});
