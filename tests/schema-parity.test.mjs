import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const sourceDb = "/Users/yue/Documents/CL/prisma/dev.db";
const migrationPath = "drizzle/0001_original_business_schema.sql";

test("D1 migration contains every original business table", () => {
  const source = execFileSync(
    "sqlite3",
    [
      "-readonly",
      sourceDb,
      "SELECT name FROM sqlite_master WHERE type='table' AND name <> '_prisma_migrations' ORDER BY name;",
    ],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");

  assert.equal(source.length, 21);
  assert.ok(existsSync(migrationPath), "D1 business migration should exist");
  const sql = readFileSync(migrationPath, "utf8");
  for (const table of source) {
    assert.ok(sql.includes(`CREATE TABLE IF NOT EXISTS "${table}"`), `missing table ${table}`);
  }
});

test("business migration contains schema only", () => {
  assert.ok(existsSync(migrationPath), "D1 business migration should exist");
  const sql = readFileSync(migrationPath, "utf8");
  assert.doesNotMatch(sql, /INSERT\s+INTO/i);
  assert.doesNotMatch(sql, /passwordHash\s*=/i);
});
