import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const script = process.argv[2];
assert.ok(["scripts/verify-episode-pipeline.ts", "scripts/verify-e4-repair-scope.ts"].includes(script), "Choose an allowed offline regression script.");
const scratch = mkdtempSync(path.join(tmpdir(), "director-isolated-regression-"));
const env = { ...process.env, DATABASE_URL: `file:${path.join(scratch, "test.db")}`, DEEPSEEK_API_KEY: "", DEEPSEEK_API_BASE: "https://offline-regression.invalid", CODEX_CLI_PATH: "/__offline_only__/no-real-codex", RUST_LOG: "info" };
try {
  copyFileSync(path.resolve("prisma/schema.prisma"), path.join(scratch, "schema.prisma"));
  execFileSync(process.execPath, [path.resolve("node_modules/prisma/build/index.js"), "db", "push", "--schema", path.join(scratch, "schema.prisma"), "--skip-generate"], { cwd: scratch, env, stdio: "pipe" });
  execFileSync(path.resolve("node_modules/.bin/tsx"), [script], { cwd: process.cwd(), env, stdio: "inherit" });
} finally { rmSync(scratch, { recursive: true, force: true }); }
