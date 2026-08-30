import assert from "node:assert/strict";
import {
  countInitialBatchAttempts,
  findLatestBatchCapacityFailure,
  hasCompleteInitialBatch,
  shouldRetryInitialBatch,
  shouldSkipInitialBatch,
  summarizeEpisodePipeline
} from "@/lib/episode-batch";

const stages = ["E0", "E1", "E2", "E3", "E4", "E5"];
const start = new Date("2026-08-27T00:00:00.000Z").getTime();

function run(stageCode: string, status = "SUCCEEDED", offset = Number(stageCode.slice(1)) * 1_000, outputSummary?: string) {
  return {
    stageCode,
    status,
    createdAt: new Date(start + offset),
    finishedAt: new Date(start + offset + 500),
    outputSummary: outputSummary ?? null
  };
}

const complete = stages.map((stage) => run(stage));
assert.equal(summarizeEpisodePipeline(complete, []).state, "READY", "完整且无开放问题的 E0–E5 应放行");

const withBlocker = summarizeEpisodePipeline(complete, [{ status: "OPEN", severity: "BLOCKER" }]);
assert.equal(withBlocker.state, "BLOCKED", "有 BLOCKER 时不得放行或启动下一集");
assert.equal(withBlocker.ready, false);
assert.equal(withBlocker.initialComplete, true, "初稿阶段不应因质量问题阻塞后续剧集排队");

const withMajor = summarizeEpisodePipeline(complete, [{ status: "OPEN", severity: "MAJOR" }]);
assert.equal(withMajor.state, "READY", "默认只把 BLOCKER 作为硬门槛");
assert.equal(summarizeEpisodePipeline(complete, [{ status: "OPEN", severity: "MAJOR" }], { requireNoMajors: true }).state, "BLOCKED", "严格模式应拦截 MAJOR");

const repairedAfterE4 = summarizeEpisodePipeline(
  [...complete, run("E4", "SUCCEEDED", 10_000), run("E5", "SUCCEEDED", 11_000)],
  []
);
assert.equal(repairedAfterE4.state, "READY", "E4 返修后重新完成 E5 应放行");

const staleReview = summarizeEpisodePipeline(
  [...complete, run("E4", "SUCCEEDED", 10_000)],
  []
);
assert.equal(staleReview.state, "BLOCKED", "E4 更新后旧 E5 不得被当作最新放行结果");

const withAdminAttention = summarizeEpisodePipeline(
  complete.map((item) => item.stageCode === "E5" ? { ...item, outputSummary: JSON.stringify({ decision: "admin_attention" }) } : item),
  []
);
assert.equal(withAdminAttention.state, "BLOCKED", "E5 要求人工确认时不得自动推进");

assert.equal(summarizeEpisodePipeline([], []).state, "NOT_STARTED");
assert.equal(summarizeEpisodePipeline([run("E0"), run("E1", "FAILED")], []).state, "FAILED");
assert.equal(summarizeEpisodePipeline([run("E0"), run("E1", "QUEUED")], []).state, "QUEUED");
assert.equal(summarizeEpisodePipeline([run("E0"), run("E1", "QUEUED")], []).initialComplete, false);

const monitorToken = "monitor-test";
const firstAttempt = stages.map((stage) => ({
  ...run(stage),
  inputSummary: JSON.stringify({ batchToken: "batch-1", batchMonitorToken: monitorToken })
}));
const secondAttempt = stages.map((stage) => ({
  ...run(stage, "FAILED", 20_000),
  inputSummary: JSON.stringify({ batchToken: "batch-2", batchMonitorToken: monitorToken })
}));
assert.equal(countInitialBatchAttempts(firstAttempt, monitorToken), 1, "同一整集批次的六个岗位只能算一次尝试");
assert.equal(countInitialBatchAttempts([...firstAttempt, ...secondAttempt], monitorToken), 2, "第二次整集重做应被持久化计数");
assert.equal(shouldRetryInitialBatch(0), true, "首次未启动时应允许执行");
assert.equal(shouldRetryInitialBatch(1), true, "第一次失败后应允许整集重做");
assert.equal(shouldRetryInitialBatch(2), false, "第二次失败后不得再次重做");
assert.equal(shouldSkipInitialBatch(2), true, "第二次失败后应进入自动跳过终态");
assert.equal(hasCompleteInitialBatch([
  ...firstAttempt,
  ...stages.map((stage) => ({
    ...run(stage, "FAILED", 30_000),
    inputSummary: JSON.stringify({ batchToken: "repair-1", repairPipeline: true })
  }))
]), true, "返修失败不能抹掉已经存在的完整初稿");

const oldQuotaFailure = {
  ...run("E0", "FAILED", 40_000),
  inputSummary: JSON.stringify({ batchToken: "old-batch", batchMonitorToken: "old-monitor" }),
  error: "CLI执行失败：Codex CLI 额度不足"
};
assert.equal(
  findLatestBatchCapacityFailure([oldQuotaFailure], "new-monitor"),
  null,
  "新一轮继续执行不能被上一轮额度失败拦截"
);
assert.equal(
  findLatestBatchCapacityFailure([oldQuotaFailure], "old-monitor")?.error,
  oldQuotaFailure.error,
  "当前批次的额度失败应触发暂停"
);
const repairedAfterQuota = {
  ...oldQuotaFailure,
  status: "SUCCEEDED",
  createdAt: new Date(start + 41_000),
  finishedAt: new Date(start + 41_500),
  inputSummary: JSON.stringify({ batchToken: "old-batch-2", batchMonitorToken: "old-monitor" })
};
assert.equal(
  findLatestBatchCapacityFailure([oldQuotaFailure, repairedAfterQuota], "old-monitor"),
  null,
  "同一监控器后续成功结果应覆盖早先的额度失败"
);
const repairQuotaFailure = {
  ...oldQuotaFailure,
  inputSummary: JSON.stringify({ batchToken: "repair-batch", repairPipeline: true }),
  createdAt: new Date(start + 42_000)
};
assert.equal(
  findLatestBatchCapacityFailure([repairQuotaFailure]),
  null,
  "单集返修额度失败不能被误判为初稿批量额度失败"
);

console.log("episode batch monitor verification passed");
