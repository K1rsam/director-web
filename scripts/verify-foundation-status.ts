import assert from "node:assert/strict";
import { summarizeFoundationRuns, type FoundationRunLike } from "@/lib/project-foundation-status";
import { prisma } from "@/lib/prisma";

function run(stageCode: "P1" | "P2", status: string, batchToken: string, createdAt: string, outputSummary?: string | null): FoundationRunLike {
  return {
    stageCode,
    status,
    inputSummary: JSON.stringify({ batchToken }),
    outputSummary: outputSummary ?? null,
    error: status === "FAILED" ? "用户手动停止" : null,
    createdAt: new Date(createdAt),
    startedAt: null,
    finishedAt: status === "QUEUED" || status === "RUNNING" ? null : new Date(createdAt),
    durationMs: null,
    model: null,
    provider: null,
    roleName: null
  };
}

function singleStageRun(stageCode: "P1" | "P2", status: string, batchToken: string, createdAt: string, baseToken: string | null, outputSummary?: string | null) {
  const item = run(stageCode, status, batchToken, createdAt, outputSummary);
  item.inputSummary = JSON.stringify({ batchToken, singleStage: true, baseStageCode: stageCode === "P1" ? "P2" : "P1", baseFoundationBatchToken: baseToken });
  return item;
}

const completedThenStopped = [
  run("P1", "SUCCEEDED", "good", "2026-08-27T02:40:49.000Z", "{}"),
  run("P2", "SUCCEEDED", "good", "2026-08-27T03:07:25.000Z", "{}"),
  run("P1", "FAILED", "stopped", "2026-08-28T00:57:13.000Z"),
  run("P2", "FAILED", "stopped", "2026-08-28T00:57:14.000Z")
];
const preserved = summarizeFoundationRuns(completedThenStopped);
assert.equal(preserved.ready, true, "没有产生新基础资料的失败重跑不应覆盖旧成功批次");
assert.equal(preserved.runs.every((item) => item.status === "SUCCEEDED"), true, "页面应显示仍可用的成功 P1/P2");

const mixedBatches = [
  run("P1", "SUCCEEDED", "batch-a", "2026-08-27T00:00:00.000Z", "{}"),
  run("P2", "SUCCEEDED", "batch-b", "2026-08-27T00:01:00.000Z", "{}")
];
assert.equal(summarizeFoundationRuns(mixedBatches).ready, false, "不同批次的 P1/P2 不能拼成已完成");

const p1SucceededThenP2Retry = [
  run("P1", "SUCCEEDED", "base", "2026-08-27T00:00:00.000Z", "{}"),
  singleStageRun("P2", "RUNNING", "p2-retry", "2026-08-29T00:00:00.000Z", "base")
];
const activeRetry = summarizeFoundationRuns(p1SucceededThenP2Retry);
assert.equal(activeRetry.active, true, "单独重跑 P2 时应保持活动状态");
assert.deepEqual(activeRetry.runs.map((item) => `${item.stageCode}:${item.status}`), ["P1:SUCCEEDED", "P2:RUNNING"], "P2 重跑期间 P1 不得回退为未开始");

const p2RetryFinished = [
  run("P1", "SUCCEEDED", "base", "2026-08-27T00:00:00.000Z", "{}"),
  singleStageRun("P2", "SUCCEEDED", "p2-retry", "2026-08-29T00:10:00.000Z", "base", "{}")
];
const finishedRetry = summarizeFoundationRuns(p2RetryFinished);
assert.equal(finishedRetry.ready, true, "单独重跑 P2 成功后应与基准 P1 组成可用基础工程");
assert.deepEqual(finishedRetry.runs.map((item) => `${item.stageCode}:${item.status}`), ["P1:SUCCEEDED", "P2:SUCCEEDED"], "成功重跑后页面应显示两个已完成岗位");

const p2RetryFailed = [
  run("P1", "SUCCEEDED", "base", "2026-08-27T00:00:00.000Z", "{}"),
  singleStageRun("P2", "FAILED", "p2-retry", "2026-08-29T00:10:00.000Z", null)
];
const failedRetry = summarizeFoundationRuns(p2RetryFailed);
assert.equal(failedRetry.ready, false, "P2 单独重跑失败后不能显示全剧基础工程已完成");
assert.deepEqual(failedRetry.runs.map((item) => `${item.stageCode}:${item.status}`), ["P1:SUCCEEDED", "P2:FAILED"], "P2 失败时仍应保留 P1 已完成状态");

void (async () => {
  const projectId = process.argv[2];
  if (projectId) {
    const records = await prisma.pipelineRun.findMany({
      where: { projectId, episodeId: null, stageCode: { in: ["P1", "P2"] } },
      orderBy: { createdAt: "asc" },
      select: {
        stageCode: true,
        status: true,
        inputSummary: true,
        outputSummary: true,
        error: true,
        createdAt: true,
        startedAt: true,
        finishedAt: true,
        durationMs: true,
        model: true,
        provider: true,
        roleName: true
      }
    });
    const actual = summarizeFoundationRuns(records);
    assert.equal(actual.ready, true, `项目 ${projectId} 应识别为 P1/P2 已完成`);
    assert.equal(actual.runs.filter((item) => item.status === "已完成" || item.status === "SUCCEEDED").length, 2);
    console.log(`foundation status: ready=true, displayed=${actual.runs.map((item) => `${item.stageCode}:${item.status}`).join(",")}`);
  }

  await prisma.$disconnect();
  console.log("foundation status verification passed");
})().catch(async (error) => {
  await prisma.$disconnect();
  throw error;
});
