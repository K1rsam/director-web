import { executeProjectFoundation, finalizeFoundationWorkerFailure } from "@/lib/project-foundation";
import type { FoundationStageCode } from "@/lib/project-foundation-contracts";
import { ensureSqlitePragmas, prisma } from "@/lib/prisma";

void (async () => {
  const [, , projectId, batchToken, singleStage] = process.argv;
  try {
    if (!projectId || !batchToken) throw new Error("缺少项目或批次参数。");
    if (singleStage && !["F1", "F2", "Q1"].includes(singleStage)) throw new Error("无效第一阶段岗位。");
    const options = singleStage ? { singleStage: singleStage as FoundationStageCode } : undefined;
    await ensureSqlitePragmas();
    // A database write failure must not replay successful model calls from the beginning.
    await executeProjectFoundation(projectId, batchToken, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (projectId && batchToken) {
      const terminal = await finalizeFoundationWorkerFailure(projectId, batchToken, `后台顶层异常：${error instanceof Error ? error.message : String(error)}`);
      if (terminal.errors.length) console.error("异常终态未能完整保存，状态未知：", terminal.errors.join("；"));
    }
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})().catch((error) => { console.error("后台收尾异常，状态未知：", error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
