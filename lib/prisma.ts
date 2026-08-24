import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

/**
 * SQLite 并发韧性（三线路并行防 database is locked）：
 * - WAL 模式：读写不再互相阻塞，允许一写多读并发；
 * - busy_timeout：写锁竞争时等待 5 秒而不是立即报错；
 * - synchronous=NORMAL：WAL 下的安全折中，写入更快。
 * 每个进程启动时执行一次（PRAGMA 对单连接池全局生效）。
 */
let sqlitePragmasReady: Promise<void> | null = null;

export function ensureSqlitePragmas(): Promise<void> {
  sqlitePragmasReady ??= (async () => {
    try {
      await prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;");
      await prisma.$queryRawUnsafe("PRAGMA busy_timeout=5000;");
      await prisma.$queryRawUnsafe("PRAGMA synchronous=NORMAL;");
    } catch {
      // 非 SQLite 数据源时静默跳过
    }
  })();
  return sqlitePragmasReady;
}

/** 判断是否为 SQLite 写锁冲突（P2034 写冲突/死锁、P2028 事务超时、SQLITE_BUSY 文本）。 */
export function isSqliteBusyError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /P2034|P2028|database is locked|SQLITE_BUSY/i.test(message);
}
