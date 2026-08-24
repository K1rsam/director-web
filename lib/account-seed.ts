import type { PrismaClient } from "@prisma/client";
import { hashPassword, normalizeUsername } from "@/lib/auth-crypto";

export const TEST_USERNAMES = [
  "tester01",
  "tester02",
  "tester03",
  "tester04",
  "tester05"
] as const;

export async function seedTestAccounts(
  db: PrismaClient,
  password: string,
  rotateUsername?: string
): Promise<{ created: number; assignedProjects: number }> {
  if (!password) {
    throw new Error("缺少测试账号初始密码");
  }

  const normalizedRotation = rotateUsername ? normalizeUsername(rotateUsername) : undefined;
  if (
    normalizedRotation &&
    !TEST_USERNAMES.includes(normalizedRotation as (typeof TEST_USERNAMES)[number])
  ) {
    throw new Error(`未知测试账号：${rotateUsername}`);
  }

  let created = 0;
  for (const [index, username] of TEST_USERNAMES.entries()) {
    const existing = await db.user.findUnique({ where: { username } });
    if (!existing) {
      await db.user.create({
        data: {
          username,
          email: `${username}@local.invalid`,
          name: `测试账号 ${String(index + 1).padStart(2, "0")}`,
          passwordHash: await hashPassword(password)
        }
      });
      created += 1;
      continue;
    }

    if (normalizedRotation === username) {
      const passwordHash = await hashPassword(password);
      await db.$transaction([
        db.user.update({
          where: { id: existing.id },
          data: {
            passwordHash,
            failedLoginCount: 0,
            lockedUntil: null
          }
        }),
        db.session.deleteMany({ where: { userId: existing.id } })
      ]);
    }
  }

  const tester01 = await db.user.findUniqueOrThrow({ where: { username: "tester01" } });
  const orphanProjects = await db.project.findMany({
    where: { roles: { none: {} } },
    select: { id: true }
  });
  if (orphanProjects.length > 0) {
    await db.$transaction(
      orphanProjects.map((project) =>
        db.projectRole.create({
          data: { projectId: project.id, userId: tester01.id, role: "ADMIN" }
        })
      )
    );
  }

  return { created, assignedProjects: orphanProjects.length };
}
