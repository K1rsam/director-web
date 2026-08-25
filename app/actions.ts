"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { ensureControlPlaneSchema } from "@/db/ensure-schema";
import { getDb } from "@/db";
import { projects, runnerJobs, runnerTokens } from "@/db/schema";
import { requireSessionUser } from "@/lib/auth";
import { createRunnerToken, hashRunnerToken } from "@/lib/runner-auth";

export type RunnerTokenState = { token: string | null; error: string | null };

export async function createProjectAction(formData: FormData): Promise<void> {
  const user = await requireSessionUser("/");
  const title = String(formData.get("title") ?? "").trim();
  const description = String(formData.get("description") ?? "").trim();
  if (!title || title.length > 120 || description.length > 500) return;

  await ensureControlPlaneSchema();
  const now = new Date();
  await getDb().insert(projects).values({
    id: crypto.randomUUID(),
    ownerUserId: user.id,
    title,
    description: description || null,
    createdAt: now,
    updatedAt: now,
  });
  revalidatePath("/");
}

export async function enqueueSmokeAction(projectId: string): Promise<void> {
  const user = await requireSessionUser("/");
  await ensureControlPlaneSchema();
  const db = getDb();
  const [project] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerUserId, user.id)))
    .limit(1);
  if (!project) return;

  const now = new Date();
  await db.insert(runnerJobs).values({
    id: crypto.randomUUID(),
    projectId,
    ownerUserId: user.id,
    kind: "smoke",
    payload: JSON.stringify({ message: "Sites 与本地 Runner 已连通" }),
    status: "queued",
    createdAt: now,
    updatedAt: now,
  });
  revalidatePath("/");
}

export async function createRunnerTokenAction(
  _state: RunnerTokenState,
  formData: FormData,
): Promise<RunnerTokenState> {
  const user = await requireSessionUser("/runner");
  const name = String(formData.get("name") ?? "").trim();
  if (!name || name.length > 60) return { token: null, error: "请输入 1–60 个字符的设备名称。" };

  await ensureControlPlaneSchema();
  const token = createRunnerToken();
  await getDb().insert(runnerTokens).values({
    id: crypto.randomUUID(),
    ownerUserId: user.id,
    name,
    tokenHash: await hashRunnerToken(token),
    createdAt: new Date(),
  });
  revalidatePath("/runner");
  return { token, error: null };
}

export async function revokeRunnerTokenAction(tokenId: string): Promise<void> {
  const user = await requireSessionUser("/runner");
  await ensureControlPlaneSchema();
  await getDb()
    .update(runnerTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(runnerTokens.id, tokenId), eq(runnerTokens.ownerUserId, user.id)));
  revalidatePath("/runner");
}
