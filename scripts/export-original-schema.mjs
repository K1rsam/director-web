import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

const sourceDb = path.resolve(process.argv[2] ?? "/Users/yue/Documents/CL/prisma/dev.db");
const outputPath = path.resolve(process.argv[3] ?? "drizzle/0001_original_business_schema.sql");

const rows = JSON.parse(
  execFileSync(
    "sqlite3",
    [
      "-readonly",
      "-json",
      sourceDb,
      `SELECT type, name, sql
       FROM sqlite_master
       WHERE type IN ('table', 'index')
         AND name <> '_prisma_migrations'
         AND name NOT LIKE 'sqlite_%'
         AND sql IS NOT NULL
       ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`,
    ],
    { encoding: "utf8" },
  ),
);

const statements = rows.map(({ type, sql }) => {
  let normalized = String(sql).trim().replace(/;$/, "");
  if (type === "table" && !/^CREATE TABLE IF NOT EXISTS/i.test(normalized)) {
    normalized = normalized.replace(/^CREATE TABLE/i, "CREATE TABLE IF NOT EXISTS");
  }
  if (type === "index" && !/^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS/i.test(normalized)) {
    normalized = normalized.replace(/^CREATE (UNIQUE )?INDEX/i, (_, unique = "") => `CREATE ${unique}INDEX IF NOT EXISTS`);
  }
  return `${normalized};`;
});

writeFileSync(outputPath, `${statements.join("\n--> statement-breakpoint\n")}\n`, "utf8");
console.log(`wrote ${statements.length} schema statements to ${outputPath}`);
