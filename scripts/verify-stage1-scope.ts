import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scratch = mkdtempSync(path.join(tmpdir(), "director-stage1-scope-"));
process.env.DATABASE_URL = `file:${path.join(scratch, "test.db")}`;
process.env.DEEPSEEK_API_KEY = "";
process.env.DEEPSEEK_API_BASE = "https://offline-regression.invalid";
process.env.CODEX_CLI_PATH = "/__offline_only__/no-real-codex";

async function main() {
  copyFileSync(path.resolve("prisma/schema.prisma"), path.join(scratch, "schema.prisma"));
  execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", path.join(scratch, "schema.prisma"), "--skip-generate"], {
    cwd: scratch, env: { ...process.env, RUST_LOG: "info" }, stdio: "pipe"
  });
  const { prisma: db } = await import("@/lib/prisma");
  try {
    const { queueEpisodePipeline, queueSingleStagePipeline, queueRepairPipeline, executeEpisodePipeline } = await import("@/lib/episode-pipeline");
    const blocked = /\[STAGE1_SCOPE_ONLY\].*v0\.2.*后续阶段尚未启用/;
    for (const executionMode of ["CLI", "API"]) {
      const project = await db.project.create({ data: {
        title: "第一阶段隔离测试", executionMode,
        episodes: { create: { number: 1, content: "第1集\n1-1\n客厅 日 内\n甲：原句。" } }
      }, include: { episodes: true } });
      const episodeId = project.episodes[0]!.id;
      for (const [name, run] of [
        ["整集队列", () => queueEpisodePipeline(project.id, episodeId)],
        ["单岗队列", () => queueSingleStagePipeline(project.id, episodeId, "E1")],
        ["修补队列", () => queueRepairPipeline(project.id, episodeId, { includeSuggestions: true, force: true })],
        ["worker直接执行", () => executeEpisodePipeline(project.id, episodeId, "offline-batch")],
        ["worker单岗", () => executeEpisodePipeline(project.id, episodeId, "offline-batch", { singleStage: "E1" })],
        ["worker修补", () => executeEpisodePipeline(project.id, episodeId, "offline-batch", { stages: ["E1", "E5"] })]
      ] as const) {
        await assert.rejects(run, blocked, `${executionMode} ${name}必须在准备资料、探测provider或排队前拒绝旧E生产`);
      }
      assert.equal(await db.pipelineRun.count({ where: { projectId: project.id } }), 0);
      assert.equal(await db.taskPackage.count({ where: { projectId: project.id } }), 0);
      assert.equal(await db.sceneSnapshot.count({ where: { projectId: project.id } }), 0);
    }
    const actions = readFileSync("app/actions.ts", "utf8");
    const prepare = actions.slice(actions.indexOf("export async function prepareEpisodeAction"), actions.indexOf("export async function startEpisodePipelineAction"));
    assert.ok(prepare.includes("assertStageOneTestScope"), "旧TASK_SCHEMA_V4准备action必须受同一守卫约束");
    assert.ok(prepare.indexOf("assertStageOneTestScope();") < prepare.indexOf("await prepareEpisodeProduction"));
    console.log("stage1 scope gates passed (isolated SQLite; no provider calls)");
  } finally { await db.$disconnect(); }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => { try { rmSync(scratch, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { console.warn("Windows retains the isolated test directory:", scratch); } });
