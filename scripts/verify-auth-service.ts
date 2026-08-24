import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { hashPassword, SESSION_DURATION_MS } from "@/lib/auth-crypto";
import {
  authenticateCredentials,
  createSession,
  resolveSessionUser,
  revokeSession,
  userHasEpisodeAccess,
  userHasProjectAccess
} from "@/lib/auth-service";

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

async function main() {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), "director-auth-service-"));
  const datasourceUrl = `file:${join(temporaryDirectory, "auth.db")}`;
  const prismaCli = require.resolve("prisma/build/index.js");
  execFileSync(process.execPath, [prismaCli, "db", "push", "--skip-generate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: datasourceUrl, RUST_LOG: "info" },
    stdio: "pipe"
  });

  const db = new PrismaClient({ datasourceUrl });
  try {
    const password = "private-test-password";
    const passwordHash = await hashPassword(password);
    const tester = await db.user.create({
      data: {
        username: "tester01",
        email: "tester01@local.invalid",
        name: "测试账号 01",
        passwordHash,
        failedLoginCount: 2
      }
    });
    const other = await db.user.create({
      data: {
        username: "tester02",
        email: "tester02@local.invalid",
        passwordHash
      }
    });

    const now = new Date("2026-08-24T08:00:00.000Z");
    assert.equal(await authenticateCredentials(db, "missing", password, now), null);

    const user = await authenticateCredentials(db, " TESTER01 ", password, now);
    assert.equal(user?.username, "tester01");
    assert.deepEqual(
      await db.user.findUnique({
        where: { id: tester.id },
        select: { failedLoginCount: true, lockedUntil: true }
      }),
      { failedLoginCount: 0, lockedUntil: null }
    );

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal(await authenticateCredentials(db, "tester01", "wrong", now), null);
    }
    const locked = await db.user.findUniqueOrThrow({ where: { id: tester.id } });
    assert.equal(locked.failedLoginCount, 5);
    assert.equal(locked.lockedUntil?.getTime(), now.getTime() + FIFTEEN_MINUTES_MS);
    assert.equal(await authenticateCredentials(db, "tester01", password, now), null);

    const afterLock = new Date(now.getTime() + FIFTEEN_MINUTES_MS + 1);
    assert.equal((await authenticateCredentials(db, "tester01", password, afterLock))?.id, tester.id);

    const session = await createSession(db, tester.id, now);
    assert.equal(session.expiresAt.getTime(), now.getTime() + SESSION_DURATION_MS);
    assert.equal((await resolveSessionUser(db, session.token, now))?.id, tester.id);
    await revokeSession(db, session.token);
    assert.equal(await resolveSessionUser(db, session.token, now), null);

    const expired = await createSession(
      db,
      tester.id,
      new Date(now.getTime() - SESSION_DURATION_MS - 1)
    );
    assert.equal(await resolveSessionUser(db, expired.token, now), null);
    assert.equal(await db.session.count({ where: { userId: tester.id } }), 0);

    const ownedProject = await db.project.create({
      data: {
        title: "我的项目",
        roles: { create: { userId: tester.id, role: "ADMIN" } },
        episodes: { create: { number: 1, content: "正文" } }
      },
      include: { episodes: true }
    });
    const foreignProject = await db.project.create({
      data: {
        title: "其他项目",
        roles: { create: { userId: other.id, role: "ADMIN" } },
        episodes: { create: { number: 1, content: "正文" } }
      },
      include: { episodes: true }
    });

    assert.equal(await userHasProjectAccess(db, tester.id, ownedProject.id), true);
    assert.equal(await userHasProjectAccess(db, tester.id, foreignProject.id), false);
    assert.equal(
      await userHasEpisodeAccess(db, tester.id, ownedProject.id, ownedProject.episodes[0].id),
      true
    );
    assert.equal(
      await userHasEpisodeAccess(db, tester.id, ownedProject.id, foreignProject.episodes[0].id),
      false
    );

    console.log("auth service verification passed");
  } finally {
    await db.$disconnect();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
