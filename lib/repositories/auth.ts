import {
  createSessionToken,
  hashSessionToken,
  normalizeUsername,
  SESSION_DURATION_MS,
  verifyPassword,
} from "../auth-crypto.ts";

const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;
const DUMMY_PASSWORD_HASH =
  "pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

export type SessionUser = { id: string; username: string; name: string | null };

type UserCredentialRow = SessionUser & {
  passwordHash: string;
  failedLoginCount: number;
  lockedUntil: number | null;
};

type SessionRow = SessionUser & { sessionId: string; expiresAt: number };

export async function authenticateCredentials(
  db: D1Database,
  username: string,
  password: string,
  now = new Date(),
): Promise<SessionUser | null> {
  const user = await db
    .prepare(
      `SELECT "id", "username", "name", "passwordHash", "failedLoginCount", "lockedUntil"
       FROM "User" WHERE "username" = ? LIMIT 1`,
    )
    .bind(normalizeUsername(username))
    .first<UserCredentialRow>();
  const usableHash = user?.passwordHash.startsWith("pbkdf2-sha256$600000$")
    ? user.passwordHash
    : DUMMY_PASSWORD_HASH;
  const passwordMatches = await verifyPassword(password, usableHash);

  if (!user || (user.lockedUntil != null && Number(user.lockedUntil) > now.getTime())) return null;

  if (!passwordMatches) {
    const previousFailures = user.lockedUntil != null && Number(user.lockedUntil) <= now.getTime()
      ? 0
      : Number(user.failedLoginCount);
    const failedLoginCount = Math.min(previousFailures + 1, LOGIN_FAILURE_LIMIT);
    const lockedUntil = failedLoginCount >= LOGIN_FAILURE_LIMIT
      ? now.getTime() + LOGIN_LOCK_DURATION_MS
      : null;
    await updateLoginState(db, user.id, failedLoginCount, lockedUntil, now.getTime());
    return null;
  }

  await updateLoginState(db, user.id, 0, null, now.getTime());
  return { id: user.id, username: user.username, name: user.name };
}

export async function createSession(
  db: D1Database,
  userId: string,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = createSessionToken();
  const tokenHash = await hashSessionToken(token);
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
  await db
    .prepare(
      `INSERT INTO "Session" ("id", "userId", "tokenHash", "createdAt", "expiresAt")
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), userId, tokenHash, now.getTime(), expiresAt.getTime())
    .run();
  return { token, expiresAt };
}

export async function resolveSessionUser(
  db: D1Database,
  token: string,
  now = new Date(),
): Promise<SessionUser | null> {
  const tokenHash = await hashSessionToken(token);
  const session = await db
    .prepare(
      `SELECT s."id" AS "sessionId", s."expiresAt", u."id", u."username", u."name"
       FROM "Session" AS s
       INNER JOIN "User" AS u ON u."id" = s."userId"
       WHERE s."tokenHash" = ? LIMIT 1`,
    )
    .bind(tokenHash)
    .first<SessionRow>();
  if (!session) return null;

  if (Number(session.expiresAt) <= now.getTime()) {
    await db.prepare(`DELETE FROM "Session" WHERE "id" = ?`).bind(session.sessionId).run();
    return null;
  }
  return { id: session.id, username: session.username, name: session.name };
}

export async function revokeSession(db: D1Database, token: string): Promise<void> {
  const tokenHash = await hashSessionToken(token);
  await db.prepare(`DELETE FROM "Session" WHERE "tokenHash" = ?`).bind(tokenHash).run();
}

export async function userHasProjectAccess(db: D1Database, userId: string, projectId: string): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS "allowed" FROM "ProjectRole" WHERE "userId" = ? AND "projectId" = ? LIMIT 1`)
    .bind(userId, projectId)
    .first<{ allowed: number }>();
  return Boolean(row);
}

export async function userHasEpisodeAccess(
  db: D1Database,
  userId: string,
  projectId: string,
  episodeId: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS "allowed"
       FROM "Episode" AS e
       INNER JOIN "ProjectRole" AS pr ON pr."projectId" = e."projectId"
       WHERE pr."userId" = ? AND e."projectId" = ? AND e."id" = ? LIMIT 1`,
    )
    .bind(userId, projectId, episodeId)
    .first<{ allowed: number }>();
  return Boolean(row);
}

async function updateLoginState(
  db: D1Database,
  userId: string,
  failedLoginCount: number,
  lockedUntil: number | null,
  updatedAt: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE "User" SET "failedLoginCount" = ?, "lockedUntil" = ?, "updatedAt" = ? WHERE "id" = ?`,
    )
    .bind(failedLoginCount, lockedUntil, updatedAt, userId)
    .run();
}
