import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

type UserRow = {
  id: string;
  username: string;
  name: string | null;
  passwordHash: string;
  failedLoginCount: number;
  lockedUntil: number | null;
};

class FakeStatement {
  private values: unknown[] = [];
  private readonly db: FakeD1;
  private readonly sql: string;

  constructor(db: FakeD1, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  bind(...values: unknown[]) {
    this.values = values;
    return this;
  }

  first<T>() {
    return this.db.first(this.sql, this.values) as Promise<T | null>;
  }

  run() {
    return this.db.run(this.sql, this.values);
  }
}

class FakeD1 {
  users = new Map<string, UserRow>();
  sessions = new Map<string, { id: string; userId: string; tokenHash: string; expiresAt: number }>();
  projectRoles = new Set<string>();
  episodes = new Map<string, string>();

  prepare(sql: string) {
    return new FakeStatement(this, sql);
  }

  async first(sql: string, values: unknown[]) {
    if (sql.includes('FROM "User"') && sql.includes('"username" = ?')) {
      return [...this.users.values()].find((user) => user.username === values[0]) ?? null;
    }
    if (sql.includes('FROM "Session" AS s')) {
      const session = [...this.sessions.values()].find((item) => item.tokenHash === values[0]);
      const user = session ? this.users.get(session.userId) : null;
      return session && user
        ? { sessionId: session.id, expiresAt: session.expiresAt, id: user.id, username: user.username, name: user.name }
        : null;
    }
    if (sql.includes('FROM "ProjectRole"')) {
      return this.projectRoles.has(`${values[0]}:${values[1]}`) ? { allowed: 1 } : null;
    }
    if (sql.includes('FROM "Episode" AS e')) {
      const [userId, projectId, episodeId] = values;
      return this.episodes.get(String(episodeId)) === projectId && this.projectRoles.has(`${userId}:${projectId}`)
        ? { allowed: 1 }
        : null;
    }
    throw new Error(`Unexpected first query: ${sql}`);
  }

  async run(sql: string, values: unknown[]) {
    if (sql.includes('UPDATE "User"')) {
      const [failedLoginCount, lockedUntil, _updatedAt, id] = values;
      const user = this.users.get(String(id));
      if (user) {
        user.failedLoginCount = Number(failedLoginCount);
        user.lockedUntil = lockedUntil == null ? null : Number(lockedUntil);
      }
      return { success: true };
    }
    if (sql.includes('INSERT INTO "Session"')) {
      const [id, userId, tokenHash, _createdAt, expiresAt] = values;
      this.sessions.set(String(id), {
        id: String(id),
        userId: String(userId),
        tokenHash: String(tokenHash),
        expiresAt: Number(expiresAt),
      });
      return { success: true };
    }
    if (sql.includes('DELETE FROM "Session"') && sql.includes('"id" = ?')) {
      this.sessions.delete(String(values[0]));
      return { success: true };
    }
    if (sql.includes('DELETE FROM "Session"') && sql.includes('"tokenHash" = ?')) {
      for (const [id, session] of this.sessions) {
        if (session.tokenHash === values[0]) this.sessions.delete(id);
      }
      return { success: true };
    }
    throw new Error(`Unexpected run query: ${sql}`);
  }
}

test("legacy 600k password hashes use the Workers-compatible Node crypto path", () => {
  const source = readFileSync("lib/auth-crypto.ts", "utf8");
  assert.match(source, /from "node:crypto"/);
  assert.match(source, /pbkdf2\(/);
});

test("existing PBKDF2 accounts use normalized usernames and lock after five failures", async () => {
  const authCrypto = await import("../lib/auth-crypto.ts").catch(() => null);
  const repository = await import("../lib/repositories/auth.ts").catch(() => null);
  assert.ok(authCrypto, "auth crypto should exist");
  assert.ok(repository, "D1 auth repository should exist");

  const db = new FakeD1();
  db.users.set("u1", {
    id: "u1",
    username: "tester01",
    name: "测试员",
    passwordHash: await authCrypto.hashPassword("correct-password"),
    failedLoginCount: 0,
    lockedUntil: null,
  });
  const now = new Date("2026-08-25T00:00:00.000Z");

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    assert.equal(await repository.authenticateCredentials(db, "  Tester01  ", "wrong", now), null);
    assert.equal(db.users.get("u1")?.failedLoginCount, attempt);
  }
  assert.equal(db.users.get("u1")?.lockedUntil, now.getTime() + 15 * 60 * 1000);
  assert.equal(
    await repository.authenticateCredentials(db, "tester01", "correct-password", new Date(now.getTime() + 60_000)),
    null,
  );

  const user = await repository.authenticateCredentials(
    db,
    "TESTER01",
    "correct-password",
    new Date(now.getTime() + 16 * 60_000),
  );
  assert.deepEqual(user, { id: "u1", username: "tester01", name: "测试员" });
  assert.equal(db.users.get("u1")?.failedLoginCount, 0);
  assert.equal(db.users.get("u1")?.lockedUntil, null);
});

test("session tokens are hashed, resolve before expiry, and are deleted after expiry", async () => {
  const authCrypto = await import("../lib/auth-crypto.ts").catch(() => null);
  const repository = await import("../lib/repositories/auth.ts").catch(() => null);
  assert.ok(authCrypto, "auth crypto should exist");
  assert.ok(repository, "D1 auth repository should exist");

  const db = new FakeD1();
  db.users.set("u1", {
    id: "u1",
    username: "tester01",
    name: null,
    passwordHash: "unused",
    failedLoginCount: 0,
    lockedUntil: null,
  });
  const now = new Date("2026-08-25T00:00:00.000Z");
  const session = await repository.createSession(db, "u1", now);
  const stored = [...db.sessions.values()][0];
  assert.notEqual(stored.tokenHash, session.token);
  assert.equal(stored.tokenHash, await authCrypto.hashSessionToken(session.token));
  assert.deepEqual(await repository.resolveSessionUser(db, session.token, now), {
    id: "u1",
    username: "tester01",
    name: null,
  });

  assert.equal(await repository.resolveSessionUser(db, session.token, session.expiresAt), null);
  assert.equal(db.sessions.size, 0);
});

test("project and episode access require ProjectRole membership", async () => {
  const repository = await import("../lib/repositories/auth.ts").catch(() => null);
  assert.ok(repository, "D1 auth repository should exist");

  const db = new FakeD1();
  db.episodes.set("e1", "p1");
  assert.equal(await repository.userHasProjectAccess(db, "u1", "p1"), false);
  assert.equal(await repository.userHasEpisodeAccess(db, "u1", "p1", "e1"), false);

  db.projectRoles.add("u1:p1");
  assert.equal(await repository.userHasProjectAccess(db, "u1", "p1"), true);
  assert.equal(await repository.userHasEpisodeAccess(db, "u1", "p1", "e1"), true);
  assert.equal(await repository.userHasEpisodeAccess(db, "u1", "p1", "other"), false);
});
