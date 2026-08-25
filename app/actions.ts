"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getD1, getDb } from "@/db";
import { ensureControlPlaneSchema } from "@/db/ensure-schema";
import { runnerTokens } from "@/db/schema";
import { requireProjectAccess, requireSessionUser } from "@/lib/auth";
import { readProjectSubmission } from "@/lib/project-entry";
import {
  archiveProject,
  createProjectFromText,
  deleteProject,
  restoreProject,
  setProjectExecutionMode,
} from "@/lib/repositories/projects";
import { createRunnerToken, hashRunnerToken } from "@/lib/runner-auth";

export type ProjectCreationState = { error: string };
export type RunnerTokenState = { token: string | null; error: string | null };

export async function archiveProjectAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  await archiveProject(getD1(), projectId);
  revalidatePath("/");
}

export async function restoreProjectAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  await restoreProject(getD1(), projectId);
  revalidatePath("/");
}

export async function deleteProjectAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  await deleteProject(getD1(), projectId);
  revalidatePath("/");
}

export async function importProjectAction(
  _previousState: ProjectCreationState,
  formData: FormData,
): Promise<ProjectCreationState> {
  const currentUser = await requireSessionUser("/projects/new");
  let destination = "";
  try {
    const submission = await readProjectSubmission(formData);
    const result = await createProjectFromText(
      {
        ownerUserId: currentUser.id,
        title: submission.title,
        style: submission.style,
        aspectRatio: submission.aspectRatio,
        executionMode: submission.executionMode,
        sourceName: submission.sourceName,
        sourceText: submission.sourceText,
      },
      getD1(),
    );
    destination = result.destination;
  } catch (error) {
    return { error: error instanceof Error ? error.message : "项目创建失败，请重试。" };
  }

  revalidatePath("/");
  redirect(destination);
}

export async function setProjectExecutionModeAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const value = String(formData.get("executionMode") ?? "CLI");
  if (value !== "CLI" && value !== "API") throw new Error("无效的执行方式。");
  await setProjectExecutionMode(getD1(), projectId, value);
  revalidatePath(`/projects/${projectId}`);
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
