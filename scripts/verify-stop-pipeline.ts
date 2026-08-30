/**
 * 页面「停止」机制验证：launchWorker 记录 workerPid（进程组组长）→ stopPipelineAction 的
 * 核心逻辑（failActiveBatch 标记 + kill 负 PID 进程组）能真正终止 detached worker。
 * 只读 + 临时项目，不触发真实 API。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { failActiveBatch } from "@/lib/episode-pipeline";
import { prisma } from "@/lib/prisma";
import { terminateWorkerProcessTree } from "@/lib/process-control";

void (async () => {
  const project = await prisma.project.create({
    data: {
      title: "__stop_pipeline_verify__",
      style: "真人电影写实",
      aspectRatio: "16:9",
      episodes: { create: { number: 1, title: "测试", content: "1-1\n客厅 日 内\n苏远拿起手机。" } }
    },
    include: { episodes: true }
  });
  const episode = project.episodes[0];
  const batchToken = "stop-verify-batch";
  try {
    // 模拟 queueRepairPipeline：建两个 run（E1 RUNNING + E5 QUEUED）
    await prisma.pipelineRun.createMany({
      data: [
        { projectId: project.id, episodeId: episode.id, stageCode: "E1", roleName: "结构导演", provider: "test", model: "test", status: "RUNNING", inputSummary: JSON.stringify({ batchToken }) },
        { projectId: project.id, episodeId: episode.id, stageCode: "E5", roleName: "审查总控", provider: "test", model: "test", status: "QUEUED", inputSummary: JSON.stringify({ batchToken }) }
      ]
    });
    // 模拟 launchWorker：用 Node 自己保持 60 秒，Windows/Linux 均可运行。
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      detached: true,
      windowsHide: true,
      stdio: "ignore"
    });
    child.unref();
    const workerPid = child.pid!;
    assert.ok(workerPid > 0, "worker 进程应已启动");
    // worker 存活探测
    const aliveBefore = (() => { try { process.kill(workerPid, 0); return true; } catch { return false; } })();
    assert.equal(aliveBefore, true, "启动后进程组应存活");
    // launchWorker 会把 workerPid 写进 inputSummary（模拟其逻辑）
    const runs = await prisma.pipelineRun.findMany({ where: { projectId: project.id, episodeId: episode.id } });
    for (const run of runs) {
      const parsed = JSON.parse(run.inputSummary ?? "{}");
      await prisma.pipelineRun.update({ where: { id: run.id }, data: { inputSummary: JSON.stringify({ ...parsed, workerPid }) } });
    }

    // ===== stopPipelineAction 核心逻辑 =====
    // 1) 先落状态
    await failActiveBatch(project.id, episode.id, batchToken, "用户手动停止");
    // 2) 跨平台终止 worker 及其子进程
    await terminateWorkerProcessTree(workerPid);

    // 断言：worker 已死
    const aliveAfter = (() => { try { process.kill(workerPid, 0); return true; } catch { return false; } })();
    assert.equal(aliveAfter, false, "停止后进程组应已终止");
    // 断言：批次状态已标记
    const after = await prisma.pipelineRun.findMany({ where: { projectId: project.id, episodeId: episode.id } });
    assert.equal(after.filter((r) => r.status === "FAILED").length, 2, "两个 run 都应标记 FAILED");
    assert.ok(after.every((r) => String(r.error ?? "").includes("用户手动停止")), "错误原因应为用户手动停止");
  } finally {
    await prisma.project.delete({ where: { id: project.id } });
    await prisma.$disconnect();
  }
  console.log("stop pipeline mechanism verification passed");
})();
