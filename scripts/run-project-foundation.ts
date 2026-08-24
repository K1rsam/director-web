import { executeProjectFoundation } from "@/lib/project-foundation";
import type { FoundationStageCode } from "@/lib/project-foundation-contracts";
import { ensureSqlitePragmas, isSqliteBusyError, prisma } from "@/lib/prisma";

void (async () => {
  const [, , projectId, batchToken, singleStage] = process.argv;
  if (!projectId || !batchToken) throw new Error("缺少项目或批次参数。");
  const options = singleStage ? { singleStage: singleStage as FoundationStageCode } : undefined;
  await ensureSqlitePragmas();
  const maxAttempts = 3;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
      await executeProjectFoundation(projectId, batchToken, options);
      break;
    } catch (error) {
      if (isSqliteBusyError(error) && attempt < maxAttempts) {
        const delayMs = 1200 * attempt;
        console.error(`[worker] SQLite busy（第${attempt}次），${delayMs}ms 后重试：${error instanceof Error ? error.message : String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        continue;
      }
        process.exitCode = 1;
        break;
      }
    }
  } finally {
    await prisma.$disconnect();
  }
})();
