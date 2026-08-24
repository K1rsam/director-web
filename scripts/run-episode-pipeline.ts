import { executeEpisodePipeline, failActiveBatch } from "@/lib/episode-pipeline";
import type { PipelineStageCode } from "@/lib/episode-pipeline-contracts";
import { ensureSqlitePragmas, isSqliteBusyError, prisma } from "@/lib/prisma";

void (async () => {
  const [, , projectId, episodeId, batchToken, singleStage] = process.argv;
  if (!projectId || !episodeId || !batchToken) throw new Error("缺少项目、剧集或批次参数。");
  // 第 5 参：单个岗位（E1）或逗号分隔的岗位序列（E1,E2,E5，一键整批修复用）
  const options = singleStage?.includes(",")
    ? { stages: singleStage.split(",") as PipelineStageCode[] }
    : singleStage
      ? { singleStage: singleStage as PipelineStageCode }
      : undefined;
  await ensureSqlitePragmas();
  // SQLite 写锁重试：三线路并行偶发 database is locked 时退避重跑整段（幂等：持久化全部 upsert 化）
  const maxAttempts = 3;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await executeEpisodePipeline(projectId, episodeId, batchToken, options);
        break;
      } catch (error) {
        if (isSqliteBusyError(error) && attempt < maxAttempts) {
          const delayMs = 1200 * attempt;
          console.error(`[worker] SQLite busy（第${attempt}次），${delayMs}ms 后重试：${error instanceof Error ? error.message : String(error)}`);
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }
        await failActiveBatch(projectId, episodeId, batchToken, error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
        break;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
})();
