import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const scratch = mkdtempSync(path.join(tmpdir(), "foundation-handoff-"));
const databaseUrl = `file:${path.join(scratch, "test.db")}`;
process.env.DATABASE_URL = databaseUrl;
process.env.DEEPSEEK_API_KEY = "";
process.env.DEEPSEEK_API_BASE = "https://foundation-handoff.invalid";
process.env.CODEX_CLI_PATH = "/__offline_only__/no-real-codex";
copyFileSync(path.resolve("prisma/schema.prisma"), path.join(scratch, "schema.prisma"));
execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", path.join(scratch, "schema.prisma"), "--skip-generate"], {
  cwd: scratch, env: { ...process.env, RUST_LOG: "info" }, stdio: "pipe"
});

async function main() {
  const { prisma: db } = await import("@/lib/prisma");
  try {
    const { preprocessProject } = await import("@/lib/project-preprocess");
    const { prepareEpisodeProduction } = await import("@/lib/workflow");
    const source = [
      { number: 1, title: "第一集", content: "第1集\r\n1-1\r\n客厅 日 内\r\n甲：原句。  \r\n" },
      { number: 2, title: "第二集", content: "第2集\n2-1\n教室 日 内\n乙：后来。" }
    ];
    const p = await db.project.create({ data: { title: "__handoff__", episodes: { create: source } }, include: { episodes: { orderBy: { number: "asc" } } } });
    await preprocessProject(p.id, db);
    await assert.rejects(() => prepareEpisodeProduction(p.id, p.episodes[0]!.id, db), /第一阶段.*批准/, "仅有P0时不得越过Q1启动旧任务包");
    assert.equal(await db.taskPackage.count({ where: { projectId: p.id } }), 0);

    const { executeProjectFoundation } = await import("@/lib/project-foundation");
    const { readApprovedEpisodeFoundation, requireApprovedFoundation, loadFoundationInputs } = await import("@/lib/foundation-state");
    const stages = ["F1", "F2", "Q1"] as const;
    const batchToken = randomUUID();
    const input = await loadFoundationInputs(p.id, db);
    for (const stageCode of stages) await db.pipelineRun.create({ data: { projectId: p.id, stageCode, roleName: stageCode, status: "QUEUED", inputSummary: JSON.stringify({ batchToken, provider: "API", foundation: true, sourceVersion: input.sourceVersion, inputVersion: input.inputVersion, methodVersion: input.methodVersions[stageCode] }) } });
    const ref = (episode: number) => ({ episode, startLine: 1, endLine: 1 });
    await executeProjectFoundation(p.id, batchToken, { db, stageRunner: async (stage, prompt) => {
      const scope: number[] = JSON.parse(prompt.split("INPUT_JSON:").at(-1)!.trim()).scope;
      const data = stage === "F1"
        ? { coverage: scope, overview: "BACKEND_ONLY_OVERVIEW", episodes: scope.map((number) => ({ number, summary: `摘要${number}`, context: `F1-CURRENT-${number}`, sourceSelections: [] })), issues: [] }
        : stage === "F2"
          ? { coverage: scope, assets: scope.map((episode) => ({ key: `person-${episode}`, type: "CH", name: episode === 1 ? "甲" : "乙", aliases: [], description: "BACKEND_ONLY_IDENTITY", sourceRefs: [ref(episode)] })), episodes: scope.map((number) => ({ number, context: `F2-CURRENT-${number}`, uses: [{ key: `person-${number}`, presence: "ONSTAGE", state: `本集${number}状态`, sourceRefs: [ref(number)] }] })), issues: [] }
          : { coverage: scope, verdict: "READY", summary: "供给独审", issues: [] };
      return { data, rawOutput: JSON.stringify(data), stdout: "", stderr: "", sessionId: null };
    } });
    const approval = await requireApprovedFoundation(p.id, db);
    const packet = await readApprovedEpisodeFoundation(p.id, 1, db);
    const storedBefore = await db.sceneSnapshot.findUniqueOrThrow({ where: { id: approval.episodePackets.find((item) => item.episode === 1)!.snapshotId } });
    const result = await prepareEpisodeProduction(p.id, p.episodes[0]!.id, db);
    assert.deepEqual(result.payload["本集上下文快照"], packet, "旧任务包消费确切已审包，不再读整个PROJECT_MEMORY");
    assert.equal(result.payload["本集上下文快照"].source && (result.payload["本集上下文快照"].source as { content: string }).content, source[0]!.content);
    assert.doesNotMatch(JSON.stringify(result.payload), /BACKEND_ONLY_|F1-CURRENT-2|F2-CURRENT-2|本集2状态/);
    assert.deepEqual((result.payload["资产索引"]["资产明细"] as Array<{ id: string }>).map((asset) => asset.id), packet.assetCodes);
    assert.equal((await db.sceneSnapshot.findUniqueOrThrow({ where: { id: storedBefore.id } })).content, storedBefore.content, "准备任务包不得反写Q1审过的正文");

    const { loadPipelineContext, queueEpisodePipeline, queueSingleStagePipeline, queueRepairPipeline, executeEpisodePipeline } = await import("@/lib/episode-pipeline");
    for (const action of [
      () => queueEpisodePipeline(p.id, p.episodes[0]!.id),
      () => queueSingleStagePipeline(p.id, p.episodes[0]!.id, "E1"),
      () => queueRepairPipeline(p.id, p.episodes[0]!.id),
      () => executeEpisodePipeline(p.id, p.episodes[0]!.id, "no-real-worker")
    ]) await assert.rejects(action, /STAGE1_SCOPE_ONLY/, "第一阶段Q1批准不允许进入旧E生产链");
    // An old task package must not be a second source of truth after publication.
    await db.taskPackage.update({ where: { id: result.taskPackage.id }, data: { payload: JSON.stringify({ "全剧记忆快照": { text: "BACKEND_ONLY_OLD_TASK" } }) } });
    const context = await loadPipelineContext(p.id, p.episodes[0]!.id);
    assert.deepEqual(context.project.assets.map((asset) => asset.code), packet.assetCodes);
    assert.deepEqual(context.taskPayload["本集上下文快照"], packet);
    assert.doesNotMatch(JSON.stringify(context.taskPayload), /BACKEND_ONLY_/);
    const other = await db.project.create({ data: { title: "other", episodes: { create: { number: 1, content: "other" } } }, include: { episodes: true } });
    await assert.rejects(() => prepareEpisodeProduction(p.id, other.episodes[0]!.id, db), /Episode not found|没有找到/);
    const eToken = randomUUID();
    const eRun = await db.pipelineRun.create({ data: { projectId: p.id, episodeId: p.episodes[0]!.id, stageCode: "E0", roleName: "fake E0", status: "QUEUED", inputSummary: JSON.stringify({ batchToken: eToken, provider: "API" }) } });
    await assert.rejects(() => executeEpisodePipeline(p.id, p.episodes[0]!.id, eToken, { singleStage: "E0", stageRunner: async () => {
      await db.episode.update({ where: { id: p.episodes[0]!.id }, data: { content: `${source[0]!.content}新增原文` } });
      return { data: { role: "E0", episode_number: 1, sequences: [], notes: "STALE_RESULT" }, stdout: "", stderr: "", sessionId: null };
    } }), /第一阶段.*批准/, "模型返回时批准已失效，不得写入旧结果");
    assert.equal((await db.pipelineRun.findUniqueOrThrow({ where: { id: eRun.id } })).status, "FAILED");
    assert.equal(await db.sceneSnapshot.count({ where: { projectId: p.id, sceneKey: "EP-1-BEATS" } }), 0);
    for (const action of [
      () => prepareEpisodeProduction(p.id, p.episodes[0]!.id, db),
      () => loadPipelineContext(p.id, p.episodes[0]!.id)
    ]) await assert.rejects(action, /第一阶段.*批准/, "源文变更须拦下失效资料消费");
    for (const action of [
      () => queueEpisodePipeline(p.id, p.episodes[0]!.id),
      () => queueSingleStagePipeline(p.id, p.episodes[0]!.id, "E1"),
      () => queueRepairPipeline(p.id, p.episodes[0]!.id)
    ]) await assert.rejects(action, /STAGE1_SCOPE_ONLY/, "本副本不开放旧E真实生产入口");
    assert.equal(await db.pipelineRun.count({ where: { projectId: p.id, episodeId: { not: null } } }), 1, "无新下游岗位被排队");
    console.log("foundation approved handoff and downstream gates passed (isolated SQLite; fake model only)");
  } finally { await db.$disconnect(); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => rmSync(scratch, { recursive: true, force: true }));
