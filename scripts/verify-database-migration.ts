import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { migrateDatabase } from "@/lib/database-migration";

const BASELINE_MIGRATIONS = [
  "20260626000000_init",
  "20260814053618_structured_storyboard_v1",
  "20260814103841_asset_parent_columns",
  "20260814162000_cli_role_sessions"
];
const SCHEMA_SYNC_MIGRATION = "20260823000000_existing_schema_sync";
const AUTH_MIGRATION = "20260824000000_minimal_account_isolation";

function runPrisma(args: string[], databaseUrl: string) {
  execFileSync(process.execPath, [require.resolve("prisma/build/index.js"), ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl, RUST_LOG: "info" },
    stdio: "pipe"
  });
}

function createBaselineDatabase(temporaryDirectory: string) {
  const temporaryPrismaDirectory = join(temporaryDirectory, "prisma");
  const temporaryMigrationsDirectory = join(temporaryPrismaDirectory, "migrations");
  mkdirSync(temporaryMigrationsDirectory, { recursive: true });
  cpSync("prisma/schema.prisma", join(temporaryPrismaDirectory, "schema.prisma"));
  cpSync(
    "prisma/migrations/migration_lock.toml",
    join(temporaryMigrationsDirectory, "migration_lock.toml")
  );
  for (const migration of BASELINE_MIGRATIONS) {
    cpSync(
      join("prisma/migrations", migration),
      join(temporaryMigrationsDirectory, migration),
      { recursive: true }
    );
  }

  const databasePath = join(temporaryDirectory, "legacy.db");
  const databaseUrl = `file:${databasePath}`;
  runPrisma(
    ["migrate", "deploy", "--schema", join(temporaryPrismaDirectory, "schema.prisma")],
    databaseUrl
  );
  runPrisma(
    [
      "db",
      "execute",
      "--file",
      join(process.cwd(), "prisma/migrations", SCHEMA_SYNC_MIGRATION, "migration.sql"),
      "--url",
      databaseUrl
    ],
    databaseUrl
  );
  return databaseUrl;
}

async function verifyLegacyDatabaseUpgrade(temporaryDirectory: string) {
  const databaseUrl = createBaselineDatabase(temporaryDirectory);
  const legacyDb = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    await legacyDb.$executeRawUnsafe(`
      INSERT INTO "User" ("id", "email", "name", "createdAt", "updatedAt")
      VALUES ('legacy-user', 'legacy@example.invalid', '旧用户', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await legacyDb.$executeRawUnsafe(`
      INSERT INTO "Project" ("id", "title", "createdAt", "updatedAt")
      VALUES ('legacy-project', '旧项目', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `);
    await legacyDb.$executeRawUnsafe(`
      INSERT INTO "ProjectRole" ("id", "userId", "projectId", "role", "createdAt")
      VALUES ('legacy-role', 'legacy-user', 'legacy-project', 'ADMIN', CURRENT_TIMESTAMP)
    `);
  } finally {
    await legacyDb.$disconnect();
  }

  assert.equal(
    await migrateDatabase({
      databaseUrl,
      schemaPath: join(process.cwd(), "prisma/schema.prisma"),
      quiet: true
    }),
    "baseline-resolved"
  );

  const upgradedDb = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    const user = await upgradedDb.user.findUniqueOrThrow({
      where: { id: "legacy-user" }
    });
    assert.equal(user.username, "legacy-legacy-user");
    assert.equal(user.passwordHash, "");
    assert.equal(
      await upgradedDb.projectRole.count({
        where: { userId: "legacy-user", projectId: "legacy-project" }
      }),
      1
    );
    await upgradedDb.session.create({
      data: {
        userId: user.id,
        tokenHash: "migration-verification-token",
        expiresAt: new Date("2026-09-24T00:00:00.000Z")
      }
    });
    const migrations = await upgradedDb.$queryRawUnsafe<Array<{ migration_name: string }>>(
      `SELECT "migration_name" FROM "_prisma_migrations"
       WHERE "migration_name" IN ('${SCHEMA_SYNC_MIGRATION}', '${AUTH_MIGRATION}')`
    );
    assert.deepEqual(
      migrations.map((migration) => migration.migration_name).sort(),
      [AUTH_MIGRATION, SCHEMA_SYNC_MIGRATION].sort()
    );
  } finally {
    await upgradedDb.$disconnect();
  }
}

async function verifyFreshDatabase(temporaryDirectory: string) {
  const databaseUrl = `file:${join(temporaryDirectory, "fresh.db")}`;
  assert.equal(
    await migrateDatabase({
      databaseUrl,
      schemaPath: join(process.cwd(), "prisma/schema.prisma"),
      quiet: true
    }),
    "migrated"
  );
  const db = new PrismaClient({ datasourceUrl: databaseUrl });
  try {
    assert.equal(
      await db.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" = 'Session'`
      ).then((rows) => rows.length),
      1
    );
  } finally {
    await db.$disconnect();
  }
}

async function main() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "director-database-migration-"));
  try {
    await verifyLegacyDatabaseUpgrade(join(temporaryDirectory, "legacy"));
    mkdirSync(join(temporaryDirectory, "fresh"), { recursive: true });
    await verifyFreshDatabase(join(temporaryDirectory, "fresh"));
    console.log("database migration verification passed");
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
