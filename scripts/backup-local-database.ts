import { mkdir, access } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url?.startsWith("file:")) throw new Error("DATABASE_URL 必须指向本地 SQLite 文件。");
  const rawPath = decodeURIComponent(url.slice(5).split("?")[0]);
  if (!rawPath || rawPath === ":memory:") throw new Error("不能备份空路径或内存数据库。");
  // 与 Prisma schema.prisma 中的相对 SQLite 路径保持一致。
  const databasePath = isAbsolute(rawPath) ? rawPath : resolve("prisma", rawPath);
  await access(databasePath); // 路径错误时停止，不能悄悄新建空库。
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = resolve("local-backups", `director-${timestamp}.db`);
  await mkdir(dirname(backupPath), { recursive: true });
  const db = new PrismaClient({ datasourceUrl: `file:${databasePath.replace(/\\/g, "/")}` });
  try {
    await db.$executeRawUnsafe(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    console.log(`数据库一致性备份已保存：${backupPath}`);
    console.log("通过私人渠道携带此文件及原 DIRECTOR_CREDENTIAL_KEY；它们不应提交到 GitHub。");
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
