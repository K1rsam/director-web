import { parseScriptContent } from "../import-script.ts";
import { resolveProjectDestination } from "../project-entry.ts";
import { extractScriptScenes } from "../scene-structure.ts";

type ProjectRow = {
  id: string;
  title: string;
  description: string | null;
  style: string | null;
  aspectRatio: string;
  executionMode: string;
  updatedAt: number;
  archivedAt: number | null;
  episodeCount: number;
  assetCount: number;
  snapshotCount: number;
};

type EpisodeRow = {
  id: string;
  projectId: string;
  number: number;
  title: string | null;
  unitCount: number;
};

export type CreateProjectInput = {
  ownerUserId: string;
  title: string;
  description?: string;
  style?: string;
  aspectRatio?: string;
  executionMode?: string;
  sourceName: string;
  sourceText: string;
};

export async function listProjectLibrary(userId: string, db: D1Database) {
  const [projectResult, episodeResult] = await Promise.all([
    db
      .prepare(
        `SELECT p."id", p."title", p."description", p."style", p."aspectRatio", p."executionMode",
                p."updatedAt", p."archivedAt",
                (SELECT COUNT(*) FROM "Episode" e WHERE e."projectId" = p."id") AS "episodeCount",
                (SELECT COUNT(*) FROM "Asset" a WHERE a."projectId" = p."id") AS "assetCount",
                (SELECT COUNT(*) FROM "SceneSnapshot" s WHERE s."projectId" = p."id") AS "snapshotCount"
         FROM "Project" AS p
         WHERE EXISTS (
           SELECT 1 FROM "ProjectRole" pr WHERE pr."projectId" = p."id" AND pr."userId" = ?
         )
         ORDER BY CASE WHEN p."archivedAt" IS NULL THEN 0 ELSE 1 END,
                  COALESCE(p."archivedAt", p."updatedAt") DESC`,
      )
      .bind(userId)
      .all<ProjectRow>(),
    db
      .prepare(
        `SELECT e."id", e."projectId", e."number", e."title", COUNT(su."id") AS "unitCount"
         FROM "Episode" AS e
         LEFT JOIN "SeedanceUnit" AS su ON su."episodeId" = e."id"
         WHERE EXISTS (
           SELECT 1 FROM "ProjectRole" pr WHERE pr."projectId" = e."projectId" AND pr."userId" = ?
         )
         GROUP BY e."id", e."projectId", e."number", e."title"
         ORDER BY e."number" ASC`,
      )
      .bind(userId)
      .all<EpisodeRow>(),
  ]);

  const episodesByProject = new Map<string, ReturnType<typeof mapEpisode>[]>();
  for (const row of episodeResult.results) {
    const episodes = episodesByProject.get(row.projectId) ?? [];
    episodes.push(mapEpisode(row));
    episodesByProject.set(row.projectId, episodes);
  }

  const projects = projectResult.results.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    style: row.style,
    aspectRatio: row.aspectRatio,
    executionMode: row.executionMode,
    updatedAt: new Date(Number(row.updatedAt)),
    archivedAt: row.archivedAt == null ? null : new Date(Number(row.archivedAt)),
    _count: {
      episodes: Number(row.episodeCount),
      assets: Number(row.assetCount),
      sceneSnapshots: Number(row.snapshotCount),
    },
    episodes: episodesByProject.get(row.id) ?? [],
  }));

  return {
    projects: projects.filter((project) => project.archivedAt === null),
    archivedProjects: projects.filter((project) => project.archivedAt !== null),
  };
}

export async function createProjectFromText(
  input: CreateProjectInput,
  db: D1Database,
  now = new Date(),
) {
  const imported = parseScriptContent(input.sourceName, input.sourceText);
  const timestamp = now.getTime();
  const project = {
    id: crypto.randomUUID(),
    title: input.title,
    description: input.description ?? `由 ${input.sourceName} 导入`,
    style: input.style ?? "真人竖屏短剧写实风格",
    aspectRatio: input.aspectRatio ?? "16:9",
    executionMode: input.executionMode === "API" ? "API" : "CLI",
  };
  const episodes = imported.episodes.map((episode) => ({ ...episode, id: crypto.randomUUID() }));
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO "Project"
         ("id", "title", "description", "style", "aspectRatio", "executionMode", "ruleVersion", "createdAt", "updatedAt")
         VALUES (?, ?, ?, ?, ?, ?, 'TASK_SCHEMA_V4', ?, ?)`,
      )
      .bind(
        project.id,
        project.title,
        project.description,
        project.style,
        project.aspectRatio,
        project.executionMode,
        timestamp,
        timestamp,
      ),
    db
      .prepare(
        `INSERT INTO "ProjectRole" ("id", "userId", "projectId", "role", "createdAt")
         VALUES (?, ?, ?, 'ADMIN', ?)`,
      )
      .bind(crypto.randomUUID(), input.ownerUserId, project.id, timestamp),
  ];

  for (const episode of episodes) {
    statements.push(
      db
        .prepare(
          `INSERT INTO "Episode" ("id", "projectId", "number", "title", "content", "createdAt", "updatedAt")
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(episode.id, project.id, episode.number, episode.title, episode.content, timestamp, timestamp),
    );
    for (const scene of extractScriptScenes(episode.number, episode.content)) {
      statements.push(
        db
          .prepare(
            `INSERT INTO "ScriptScene"
             ("id", "episodeId", "sceneKey", "sortOrder", "heading", "location", "interiorExterior",
              "timeOfDay", "weather", "timeLayer", "sourceText", "metadata", "revision", "createdAt", "updatedAt")
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'V1', ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            episode.id,
            scene.sceneKey,
            scene.sortOrder,
            scene.heading,
            scene.location,
            scene.interiorExterior,
            scene.timeOfDay,
            scene.weather,
            scene.timeLayer,
            scene.sourceText,
            JSON.stringify(scene.metadata),
            timestamp,
            timestamp,
          ),
      );
    }
  }

  await db.batch(statements);
  return { project, episodes, destination: resolveProjectDestination(project.id) };
}

export async function archiveProject(db: D1Database, projectId: string, now = new Date()): Promise<void> {
  await db
    .prepare(`UPDATE "Project" SET "archivedAt" = ?, "updatedAt" = ? WHERE "id" = ?`)
    .bind(now.getTime(), now.getTime(), projectId)
    .run();
}

export async function restoreProject(db: D1Database, projectId: string, now = new Date()): Promise<void> {
  await db
    .prepare(`UPDATE "Project" SET "archivedAt" = NULL, "updatedAt" = ? WHERE "id" = ?`)
    .bind(now.getTime(), projectId)
    .run();
}

export async function deleteProject(db: D1Database, projectId: string): Promise<void> {
  await db.prepare(`DELETE FROM "Project" WHERE "id" = ?`).bind(projectId).run();
}

export async function setProjectExecutionMode(
  db: D1Database,
  projectId: string,
  executionMode: "CLI" | "API",
  now = new Date(),
): Promise<void> {
  const project = await db
    .prepare(`SELECT "executionMode" FROM "Project" WHERE "id" = ? LIMIT 1`)
    .bind(projectId)
    .first<{ executionMode: string }>();
  if (!project) throw new Error("没有找到项目。");
  if (project.executionMode !== executionMode) {
    const active = await db
      .prepare(
        `SELECT "id" FROM "PipelineRun"
         WHERE "projectId" = ? AND "status" IN ('QUEUED', 'RUNNING') LIMIT 1`,
      )
      .bind(projectId)
      .first<{ id: string }>();
    if (active) throw new Error("项目有岗位正在执行，请在当前批次结束或停止后再切换执行方式。");
  }
  await db
    .prepare(`UPDATE "Project" SET "executionMode" = ?, "updatedAt" = ? WHERE "id" = ?`)
    .bind(executionMode, now.getTime(), projectId)
    .run();
}

function mapEpisode(row: EpisodeRow) {
  return {
    id: row.id,
    number: Number(row.number),
    title: row.title,
    _count: { seedanceUnits: Number(row.unitCount) },
  };
}
