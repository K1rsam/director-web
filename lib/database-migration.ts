import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

const SCHEMA_SYNC_MIGRATION = "20260823000000_existing_schema_sync";

type MigrationResult = "migrated" | "baseline-resolved";

type MigrationOptions = {
  databaseUrl?: string;
  schemaPath?: string;
  cwd?: string;
  quiet?: boolean;
};

type SqliteColumn = { name: string };
type SqliteObject = { name: string };

function resolveSqliteDatabase(databaseUrl: string, schemaPath: string) {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("当前升级工具仅支持项目使用的 SQLite 数据库（DATABASE_URL 必须以 file: 开头）。");
  }

  const value = databaseUrl.slice("file:".length);
  const queryIndex = value.indexOf("?");
  const rawPath = queryIndex === -1 ? value : value.slice(0, queryIndex);
  const query = queryIndex === -1 ? "" : value.slice(queryIndex);
  if (!rawPath || rawPath === ":memory:") {
    return { databaseUrl, databasePath: null };
  }

  const decodedPath = decodeURIComponent(rawPath);
  const databasePath = isAbsolute(decodedPath)
    ? decodedPath
    : resolve(dirname(schemaPath), decodedPath);
  return { databaseUrl: `file:${databasePath}${query}`, databasePath };
}

async function tableExists(db: PrismaClient, tableName: string) {
  const rows = await db.$queryRawUnsafe<SqliteObject[]>(
    `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = ? LIMIT 1`,
    tableName
  );
  return rows.length === 1;
}

async function tableHasColumn(db: PrismaClient, tableName: string, columnName: string) {
  if (!(await tableExists(db, tableName))) {
    return false;
  }
  const columns = await db.$queryRawUnsafe<SqliteColumn[]>(
    `PRAGMA table_info("${tableName}")`
  );
  return columns.some((column) => column.name === columnName);
}

async function migrationWasApplied(db: PrismaClient, migrationName: string) {
  if (!(await tableExists(db, "_prisma_migrations"))) {
    return false;
  }
  const rows = await db.$queryRawUnsafe<Array<{ migration_name: string }>>(
    `SELECT "migration_name" FROM "_prisma_migrations"
     WHERE "migration_name" = ?
       AND "finished_at" IS NOT NULL
       AND "rolled_back_at" IS NULL
     LIMIT 1`,
    migrationName
  );
  return rows.length === 1;
}

async function hasApplicationData(db: PrismaClient) {
  const rows = await db.$queryRawUnsafe<SqliteObject[]>(
    `SELECT "name" FROM "sqlite_master"
     WHERE "type" = 'table'
       AND "name" NOT LIKE 'sqlite_%'
       AND "name" != '_prisma_migrations'
     LIMIT 1`
  );
  return rows.length === 1;
}

function createBackupPath(databasePath: string) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${databasePath}.backup-${timestamp}`;
}

async function createConsistentBackup(db: PrismaClient, databasePath: string, quiet: boolean) {
  const backupPath = createBackupPath(databasePath);
  const escapedBackupPath = backupPath.replaceAll("'", "''");
  await db.$executeRawUnsafe(`VACUUM INTO '${escapedBackupPath}'`);
  if (!quiet) {
    console.log(`数据库备份已创建：${backupPath}`);
  }
}

function runPrisma(
  args: string[],
  options: { cwd: string; databaseUrl: string; quiet: boolean }
) {
  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      DATABASE_URL: options.databaseUrl,
      RUST_LOG: process.env.RUST_LOG || "info"
    },
    stdio: options.quiet ? "pipe" : "inherit"
  });
}

export async function migrateDatabase(
  options: MigrationOptions = {}
): Promise<MigrationResult> {
  const cwd = options.cwd ?? process.cwd();
  const schemaPath = resolve(cwd, options.schemaPath ?? "prisma/schema.prisma");
  const configuredDatabaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const quiet = options.quiet ?? false;
  if (!configuredDatabaseUrl) {
    throw new Error("缺少 DATABASE_URL，无法确定要升级的数据库。");
  }

  const resolvedDatabase = resolveSqliteDatabase(configuredDatabaseUrl, schemaPath);
  const databaseAlreadyExists =
    resolvedDatabase.databasePath !== null && existsSync(resolvedDatabase.databasePath);
  const db = new PrismaClient({ datasourceUrl: resolvedDatabase.databaseUrl });
  let shouldResolveBaseline = false;

  try {
    const baselineChecks = [
      await tableHasColumn(db, "Project", "archivedAt"),
      await tableExists(db, "PresentationContract"),
      await tableExists(db, "ApiRoleSession"),
      await tableHasColumn(db, "CliRoleSession", "episodeId")
    ];
    const baselineApplied = await migrationWasApplied(db, SCHEMA_SYNC_MIGRATION);
    const completeBaseline = baselineChecks.every(Boolean);
    const partialBaseline = baselineChecks.some(Boolean) && !completeBaseline;

    if (baselineApplied && !completeBaseline) {
      throw new Error(
        "数据库记录显示旧结构同步已完成，但实际结构不完整。请保留数据库并人工检查后再升级。"
      );
    }
    if (!baselineApplied && partialBaseline) {
      throw new Error(
        "检测到旧数据库只完成了部分结构变更。为避免数据损坏，已停止升级，请使用备份进行人工检查。"
      );
    }

    shouldResolveBaseline = !baselineApplied && completeBaseline;
    if (
      databaseAlreadyExists &&
      resolvedDatabase.databasePath &&
      (await hasApplicationData(db))
    ) {
      await createConsistentBackup(db, resolvedDatabase.databasePath, quiet);
    }
  } finally {
    await db.$disconnect();
  }

  if (shouldResolveBaseline) {
    runPrisma(
      [
        "migrate",
        "resolve",
        "--applied",
        SCHEMA_SYNC_MIGRATION,
        "--schema",
        schemaPath
      ],
      { cwd, databaseUrl: resolvedDatabase.databaseUrl, quiet }
    );
  }

  runPrisma(["migrate", "deploy", "--schema", schemaPath], {
    cwd,
    databaseUrl: resolvedDatabase.databaseUrl,
    quiet
  });
  return shouldResolveBaseline ? "baseline-resolved" : "migrated";
}
