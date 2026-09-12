import { executeFoundationDelivery, finalizeFoundationDeliveryWorker } from '@/lib/foundation-delivery';
import { ensureSqlitePragmas, prisma } from '@/lib/prisma';

void (async () => {
  const [, , projectId, taskId, workerToken] = process.argv;
  try {
    if (!projectId || !taskId || !workerToken) throw new Error('缺少资料任务参数。');
    await ensureSqlitePragmas();
    await executeFoundationDelivery(projectId, taskId, { workerToken });
  } catch (error) {
    if (projectId && taskId && workerToken) await finalizeFoundationDeliveryWorker(projectId, taskId, workerToken, error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally { await prisma.$disconnect(); }
})().catch(() => { process.exitCode = 1; });
