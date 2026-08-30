"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { getD1, getDb } from "@/db";
import { ensureControlPlaneSchema } from "@/db/ensure-schema";
import { runnerTokens } from "@/db/schema";
import { requireEpisodeAccess, requireProjectAccess, requireSessionUser } from "@/lib/auth";
import { normalizePresentationScopeMode, parsePresentationEpisodeNumbers } from "@/lib/presentation-contracts";
import { readProjectSubmission } from "@/lib/project-entry";
import {
  archiveProject,
  createProjectFromText,
  deleteProject,
  restoreProject,
  setProjectExecutionMode,
} from "@/lib/repositories/projects";
import {
  acknowledgeAllSuggestions,
  acknowledgeIssue,
  resetEpisodeData,
  restorePromptVersion,
  saveManualPromptVersion,
} from "@/lib/repositories/episode-studio";
import {
  confirmAllAssets,
  decidePresentationContract,
  skipPresentationContract,
} from "@/lib/repositories/project-studio";
import { createRunnerToken, hashRunnerToken } from "@/lib/runner-auth";
import { enqueueEpisodePipeline, enqueueProjectFoundation } from "@/lib/runner-pipeline";

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

export async function confirmAllAssetsAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  await confirmAllAssets(getD1(), projectId);
  revalidatePath(`/projects/${projectId}`);
}

export async function decidePresentationContractAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const contractId = String(formData.get("contractId") ?? "");
  const useCustom = String(formData.get("useCustom") ?? "") === "1";
  const answer = (useCustom ? String(formData.get("customAnswer") ?? "") : String(formData.get("answer") ?? "")).trim();
  if (!contractId || !answer) throw new Error("缺少确认信息。");
  const scopeMode = normalizePresentationScopeMode(formData.get("scopeMode"));
  const selected = formData.getAll("targetEpisodeNumber").map((value) => Number(String(value))).filter(Number.isInteger);
  const typed = parsePresentationEpisodeNumbers(formData.get("targetEpisodeNumbers"));
  const targetEpisodeNumbers = [...new Set([...selected, ...typed])].sort((left, right) => left - right);
  if (scopeMode === "SELECTED_EPISODES" && !targetEpisodeNumbers.length) {
    throw new Error("请选择至少一个适用集，或改为“只应用到发现的相关集”。");
  }
  await decidePresentationContract(getD1(), projectId, contractId, answer, { scopeMode, targetEpisodeNumbers });
  revalidatePath(`/projects/${projectId}`);
}

export async function skipPresentationContractAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const contractId = String(formData.get("contractId") ?? "");
  await skipPresentationContract(getD1(), projectId, contractId);
  revalidatePath(`/projects/${projectId}`);
}

export async function acknowledgeIssueAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireEpisodeAccess(projectId, episodeId);
  await acknowledgeIssue(getD1(), projectId, episodeId, String(formData.get("issueId") ?? ""));
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

export async function acknowledgeAllSuggestionsAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireEpisodeAccess(projectId, episodeId);
  await acknowledgeAllSuggestions(getD1(), projectId, episodeId);
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

export async function restorePromptVersionAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireEpisodeAccess(projectId, episodeId);
  await restorePromptVersion(getD1(), projectId, episodeId, String(formData.get("versionId") ?? ""));
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

export async function saveManualPromptVersionAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireEpisodeAccess(projectId, episodeId);
  await saveManualPromptVersion(
    getD1(),
    projectId,
    episodeId,
    String(formData.get("unitId") ?? ""),
    String(formData.get("content") ?? ""),
  );
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

export async function resetEpisodeShotsAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireEpisodeAccess(projectId, episodeId);
  await resetEpisodeData(getD1(), projectId, episodeId);
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

/** 线上只创建 D1 任务和流水线记录；实际 P1/P2 由已连接的个人 Runner 执行。 */
export async function startProjectFoundationAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const stageValue = String(formData.get("stageCode") ?? "").trim();
  const user = await requireProjectAccess(projectId);
  const stage = stageValue === "P1" || stageValue === "P2" ? stageValue : undefined;
  await enqueueProjectFoundation(projectId, user.id, stage);
  revalidatePath(`/projects/${projectId}`);
}

/** 线上只创建 D1 单集任务；本地 Runner 使用任务快照执行 E0–E5 并回写结果。 */
export async function startEpisodePipelineAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  const stageValue = String(formData.get("stageCode") ?? "").trim();
  const user = await requireEpisodeAccess(projectId, episodeId);
  const stage = ["E0", "E1", "E2", "E3", "E4", "E5"].includes(stageValue)
    ? stageValue as "E0" | "E1" | "E2" | "E3" | "E4" | "E5"
    : undefined;
  await enqueueEpisodePipeline(projectId, episodeId, user.id, stage ? { stage } : {});
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
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
