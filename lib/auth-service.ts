import type { PrismaClient } from "@prisma/client";
import {
  createSessionToken,
  hashSessionToken,
  normalizeUsername,
  SESSION_DURATION_MS,
  verifyPassword
} from "@/lib/auth-crypto";

const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_DURATION_MS = 15 * 60 * 1000;
const DUMMY_PASSWORD_HASH = [
  "pbkdf2-sha256",
  "600000",
  Buffer.alloc(16).toString("base64url"),
  Buffer.alloc(32).toString("base64url")
].join("$");

export type SessionUser = {
  id: string;
  username: string;
  name: string | null;
};

const sessionUserSelect = {
  id: true,
  username: true,
  name: true
} as const;

export async function authenticateCredentials(
  db: PrismaClient,
  username: string,
  password: string,
  now = new Date()
): Promise<SessionUser | null> {
  const user = await db.user.findUnique({
    where: { username: normalizeUsername(username) }
  });
  const usableStoredHash = user?.passwordHash.startsWith("pbkdf2-sha256$600000$")
    ? user.passwordHash
    : DUMMY_PASSWORD_HASH;
  const passwordMatches = await verifyPassword(password, usableStoredHash);

  if (!user) {
    return null;
  }

  if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
    return null;
  }

  if (!passwordMatches) {
    const lockedUntil = new Date(now.getTime() + LOGIN_LOCK_DURATION_MS);
    await db.$executeRaw`
      UPDATE "User"
      SET
        "failedLoginCount" = CASE
          WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" > ${now}
            THEN "failedLoginCount"
          WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now}
            THEN 1
          WHEN "failedLoginCount" >= ${LOGIN_FAILURE_LIMIT}
            THEN ${LOGIN_FAILURE_LIMIT}
          ELSE "failedLoginCount" + 1
        END,
        "lockedUntil" = CASE
          WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" > ${now}
            THEN "lockedUntil"
          WHEN (
            CASE
              WHEN "lockedUntil" IS NOT NULL AND "lockedUntil" <= ${now}
                THEN 1
              WHEN "failedLoginCount" >= ${LOGIN_FAILURE_LIMIT}
                THEN ${LOGIN_FAILURE_LIMIT}
              ELSE "failedLoginCount" + 1
            END
          ) >= ${LOGIN_FAILURE_LIMIT}
            THEN ${lockedUntil}
          ELSE NULL
        END,
        "updatedAt" = ${now}
      WHERE "id" = ${user.id}
    `;
    return null;
  }

  return db.user.update({
    where: { id: user.id },
    data: { failedLoginCount: 0, lockedUntil: null },
    select: sessionUserSelect
  });
}

export async function createSession(
  db: PrismaClient,
  userId: string,
  now = new Date()
): Promise<{ token: string; expiresAt: Date }> {
  const token = createSessionToken();
  const tokenHash = await hashSessionToken(token);
  const expiresAt = new Date(now.getTime() + SESSION_DURATION_MS);
  await db.session.create({
    data: { userId, tokenHash, expiresAt }
  });
  return { token, expiresAt };
}

export async function resolveSessionUser(
  db: PrismaClient,
  token: string,
  now = new Date()
): Promise<SessionUser | null> {
  const tokenHash = await hashSessionToken(token);
  const session = await db.session.findUnique({
    where: { tokenHash },
    include: { user: { select: sessionUserSelect } }
  });
  if (!session) {
    return null;
  }

  if (session.expiresAt.getTime() <= now.getTime()) {
    await db.session.deleteMany({ where: { id: session.id } });
    return null;
  }

  return session.user;
}

export async function revokeSession(db: PrismaClient, token: string): Promise<void> {
  const tokenHash = await hashSessionToken(token);
  await db.session.deleteMany({ where: { tokenHash } });
}

export async function userHasProjectAccess(
  db: PrismaClient,
  userId: string,
  projectId: string
): Promise<boolean> {
  return (
    (await db.projectRole.count({
      where: { userId, projectId }
    })) > 0
  );
}

export async function userHasEpisodeAccess(
  db: PrismaClient,
  userId: string,
  projectId: string,
  episodeId: string
): Promise<boolean> {
  return (
    (await db.episode.count({
      where: {
        id: episodeId,
        projectId,
        project: { roles: { some: { userId } } }
      }
    })) > 0
  );
}
