import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { verifyPassword } from "@/lib/auth-crypto";
import { seedTestAccounts } from "@/lib/account-seed";

async function main() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "director-account-seed-"));
  const datasourceUrl = `file:${join(temporaryDirectory, "seed.db")}`;
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: datasourceUrl, RUST_LOG: "info" },
    stdio: "pipe"
  });

  const db = new PrismaClient({ datasourceUrl });
  try {
    const orphan = await db.project.create({ data: { title: "历史项目" } });
    const password = "private-test-password";
    assert.deepEqual(await seedTestAccounts(db, password), {
      created: 5,
      assignedProjects: 1
    });

    const users = await db.user.findMany({ orderBy: { username: "asc" } });
    assert.deepEqual(
      users.map((user) => user.username),
      ["tester01", "tester02", "tester03", "tester04", "tester05"]
    );
    const tester01 = users[0];
    const tester02 = users[1];
    assert.equal(tester01.email, "tester01@accounts.invalid");
    assert.equal(await verifyPassword(password, tester01.passwordHash), true);
    assert.equal(
      await db.projectRole.count({
        where: { projectId: orphan.id, userId: tester01.id, role: "ADMIN" }
      }),
      1
    );

    const tester02Hash = tester02.passwordHash;
    assert.deepEqual(await seedTestAccounts(db, password), {
      created: 0,
      assignedProjects: 0
    });
    assert.equal(await db.user.count(), 5);
    assert.equal(await db.projectRole.count({ where: { projectId: orphan.id } }), 1);
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: tester02.id } })).passwordHash,
      tester02Hash
    );

    const expiresAt = new Date("2026-09-24T00:00:00.000Z");
    await db.session.createMany({
      data: [
        { userId: tester01.id, tokenHash: "session-tester01", expiresAt },
        { userId: tester02.id, tokenHash: "session-tester02", expiresAt }
      ]
    });
    const rotatedPassword = "rotated-private-password";
    await seedTestAccounts(db, rotatedPassword, "tester01");
    const rotatedTester01 = await db.user.findUniqueOrThrow({ where: { id: tester01.id } });
    assert.equal(await verifyPassword(rotatedPassword, rotatedTester01.passwordHash), true);
    assert.equal(await db.session.count({ where: { userId: tester01.id } }), 0);
    assert.equal(await db.session.count({ where: { userId: tester02.id } }), 1);
    assert.equal(
      (await db.user.findUniqueOrThrow({ where: { id: tester02.id } })).passwordHash,
      tester02Hash
    );
    await assert.rejects(
      () => seedTestAccounts(db, rotatedPassword, "unknown"),
      /未知测试账号/
    );

    console.log("account seed verification passed");
  } finally {
    await db.$disconnect();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
