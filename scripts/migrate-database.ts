import { migrateDatabase } from "@/lib/database-migration";

migrateDatabase()
  .then((result) => {
    if (result === "baseline-resolved") {
      console.log("已识别旧数据库结构并安全接续迁移记录，数据库升级完成。");
      return;
    }
    console.log("数据库迁移完成。");
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
