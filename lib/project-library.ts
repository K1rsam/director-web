import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const projectLibrarySelect = {
  id: true,
  title: true,
  description: true,
  style: true,
  aspectRatio: true,
  updatedAt: true,
  archivedAt: true,
  _count: {
    select: {
      episodes: true,
      assets: true,
      sceneSnapshots: true
    }
  },
  episodes: {
    orderBy: { number: "asc" },
    select: {
      id: true,
      number: true,
      title: true,
      _count: { select: { seedanceUnits: true } }
    }
  }
} satisfies Prisma.ProjectSelect;

export async function getProjectLibrary(userId: string, db: PrismaClient = prisma) {
  const [projects, archivedProjects] = await Promise.all([
    db.project.findMany({
      where: { roles: { some: { userId } }, archivedAt: null },
      orderBy: { updatedAt: "desc" },
      select: projectLibrarySelect
    }),
    db.project.findMany({
      where: { roles: { some: { userId } }, archivedAt: { not: null } },
      orderBy: { archivedAt: "desc" },
      select: projectLibrarySelect
    })
  ]);

  return { projects, archivedProjects };
}
