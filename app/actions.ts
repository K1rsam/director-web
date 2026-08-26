"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireEpisodeAccess, requireProjectAccess, requireSessionUser } from "@/lib/auth";
import { readProjectSubmission, resolveProjectDestination } from "@/lib/project-entry";

export type ProjectCreationState = { error: string };

export type ProviderConnectionState = {
  ok: boolean;
  message: string;
  provider?: "DEEPSEEK" | "CLI";
  models?: string[];
  version?: string;
};

export async function saveDeepSeekCredentialAction(
  _previousState: ProviderConnectionState,
  formData: FormData
): Promise<ProviderConnectionState> {
  const currentUser = await requireSessionUser("/runner");
  const apiKey = String(formData.get("apiKey") ?? "");
  const apiBase = String(formData.get("apiBase") ?? "");
  const model = String(formData.get("model") ?? "");
  try {
    const credentials = await import("@/lib/provider-credentials");
    const tested = await credentials.testDeepSeekConnection({ apiKey, apiBase, model });
    await credentials.saveDeepSeekCredential(currentUser.id, { apiKey, apiBase, model }, tested);
    revalidatePath("/runner");
    return {
      ok: true,
      provider: "DEEPSEEK",
      models: tested.models,
      message: tested.models.length
        ? `连接成功，已发现 ${tested.models.length} 个可用模型。`
        : "连接成功，但服务端没有返回模型列表。"
    };
  } catch (error) {
    return {
      ok: false,
      provider: "DEEPSEEK",
      message: error instanceof Error ? error.message : "DeepSeek 连接失败，请检查配置。"
    };
  }
}

export async function removeDeepSeekCredentialAction(
  _previousState: ProviderConnectionState,
  _formData: FormData
): Promise<ProviderConnectionState> {
  const currentUser = await requireSessionUser("/runner");
  try {
    const credentials = await import("@/lib/provider-credentials");
    await credentials.deleteDeepSeekCredential(currentUser.id);
    revalidatePath("/runner");
    return { ok: true, provider: "DEEPSEEK", message: "已删除当前账号保存的 DeepSeek Key。" };
  } catch (error) {
    return {
      ok: false,
      provider: "DEEPSEEK",
      message: error instanceof Error ? error.message : "删除失败，请重试。"
    };
  }
}

export async function checkCodexCliAction(
  _previousState: ProviderConnectionState,
  _formData: FormData
): Promise<ProviderConnectionState> {
  await requireSessionUser("/runner");
  try {
    const { assertCodexCliReady } = await import("@/lib/codex-cli");
    const readiness = await assertCodexCliReady();
    return {
      ok: true,
      provider: "CLI",
      version: readiness.version,
      message: "本机 Codex CLI 已安装并处于登录状态，可以执行 CLI 项目。"
    };
  } catch (error) {
    return {
      ok: false,
      provider: "CLI",
      message: error instanceof Error ? error.message : "无法确认本机 Codex CLI 状态。"
    };
  }
}

export async function archiveProjectAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const { prisma } = await import("@/lib/prisma");
  await prisma.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
  revalidatePath("/");
}

export async function restoreProjectAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const { prisma } = await import("@/lib/prisma");
  await prisma.project.update({ where: { id: projectId }, data: { archivedAt: null } });
  revalidatePath("/");
}

export async function deleteProjectAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const { prisma } = await import("@/lib/prisma");
  // 所有子表（分集/资产/任务包/快照/流水线/问题卡/会话/契约等）均配置了 Cascade，删除项目即整体清理
  await prisma.project.delete({ where: { id: projectId } });
  revalidatePath("/");
}

export async function importProjectAction(
  _previousState: ProjectCreationState,
  formData: FormData
): Promise<ProjectCreationState> {
  const currentUser = await requireSessionUser("/projects/new");
  let projectId = "";
  try {
    const submission = await readProjectSubmission(formData);
    const workflow = await import("@/lib/workflow");
    const result = submission.mode === "upload"
      ? await workflow.importProjectFromFile({
          ownerUserId: currentUser.id,
          title: submission.title,
          style: submission.style,
          aspectRatio: submission.aspectRatio,
          executionMode: submission.executionMode,
          sourceName: submission.sourceName,
          buffer: submission.buffer
        })
      : await workflow.importProjectFromText({
          ownerUserId: currentUser.id,
          title: submission.title,
          style: submission.style,
          aspectRatio: submission.aspectRatio,
          executionMode: submission.executionMode,
          sourceName: submission.sourceName,
          sourceText: submission.sourceText
        });
    projectId = result.project.id;
  } catch (error) {
    return { error: formatProjectCreationError(error) };
  }

  revalidatePath("/");
  redirect(resolveProjectDestination(projectId));
}

function formatProjectCreationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Unique constraint failed.*projectId.*number/i.test(message)) {
    return "导入失败：分集编号发生冲突，常见原因是剧本页眉重复，或出现“第0集”等无效集号。请检查每个“第X集”标题后重试。";
  }
  if (/database is locked|SQLITE_BUSY|P2034/i.test(message)) {
    return "本地数据库正在被其他任务占用，请停止正在运行的任务后重试。";
  }
  if (/Unsupported script file type/i.test(message)) {
    return "剧本格式不受支持，请上传 TXT、MD 或 DOCX 文件。";
  }
  if (/Promise\.all|invocation in|[A-Za-z]:\\|node_modules[\\/]|\.next[\\/]/i.test(message)) {
    return "项目创建失败：导入剧本时发生内部错误。请检查分集标题是否从“第1集”开始且集号唯一；如果仍然失败，请保留剧本和此提示交给管理员。";
  }
  return message.length <= 240 ? message : "项目创建失败，请检查剧本内容后重试。";
}

export async function setProjectExecutionModeAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const executionMode = String(formData.get("executionMode") ?? "CLI");
  if (executionMode !== "CLI" && executionMode !== "API") throw new Error("无效的执行方式。");
  const { prisma } = await import("@/lib/prisma");
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { executionMode: true }
  });
  if (!project) throw new Error("没有找到项目。");
  if (project.executionMode !== executionMode) {
    const active = await prisma.pipelineRun.findFirst({
      where: { projectId, status: { in: ["QUEUED", "RUNNING"] } },
      select: { id: true }
    });
    if (active) throw new Error("项目有岗位正在执行，请在当前批次结束或停止后再切换执行方式。");
  }
  await prisma.project.update({ where: { id: projectId }, data: { executionMode } });
  revalidatePath(`/projects/${projectId}`);
  revalidatePath(`/projects/${projectId}/episodes/[episodeId]`);
}

export async function prepareEpisodeAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireProjectAccess(projectId);
  await requireEpisodeAccess(projectId, episodeId);
  const { prepareEpisodeProduction } = await import("@/lib/workflow");
  await prepareEpisodeProduction(projectId, episodeId);
  revalidatePath("/");
}

export async function startEpisodePipelineAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireProjectAccess(projectId);
  await requireEpisodeAccess(projectId, episodeId);
  const { queueEpisodePipeline } = await import("@/lib/episode-pipeline");
  await queueEpisodePipeline(projectId, episodeId);
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

export async function repairOpenIssuesAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireProjectAccess(projectId);
  await requireEpisodeAccess(projectId, episodeId);
  const includeSuggestions = formData.get("includeSuggestions") === "1";
  // 强制重跑：绕过收敛门禁（上一轮 BLOCKER 未减少时），供人工确认卡状态后使用
  const force = formData.get("force") === "1";
  const { queueRepairPipeline } = await import("@/lib/episode-pipeline");
  await queueRepairPipeline(projectId, episodeId, { includeSuggestions, force });
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

/** 停止本集正在执行的流水线（worker 进程 + 批次状态）：页面「停止」按钮调用。 */
export async function stopPipelineAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireProjectAccess(projectId);
  await requireEpisodeAccess(projectId, episodeId);
  const { prisma } = await import("@/lib/prisma");
  const runs = await prisma.pipelineRun.findMany({
    where: { projectId, episodeId, status: { in: ["QUEUED", "RUNNING"] } },
    select: { inputSummary: true }
  });
  if (!runs.length) throw new Error("本集没有正在执行的岗位。");
  // 取批次 token 与 worker PID（launchWorker 写入 inputSummary.workerPid，进程组组长）
  let batchToken = "";
  let workerPid = 0;
  for (const run of runs) {
    const parsed = JSON.parse(run.inputSummary || "{}") as Record<string, unknown>;
    if (typeof parsed.batchToken === "string" && parsed.batchToken) batchToken = parsed.batchToken;
    const pid = Number(parsed.workerPid ?? 0);
    if (Number.isInteger(pid) && pid > 0) workerPid = pid;
  }
  if (!batchToken) throw new Error("缺少批次信息，无法停止（可联系人工从命令行终止）。");
  const { failActiveBatch } = await import("@/lib/episode-pipeline");
  // 先落状态：UI 立即显示停止，worker 后续覆盖也不影响（它已被终止）
  await failActiveBatch(projectId, episodeId, batchToken, "用户手动停止");
  if (workerPid > 0) {
    try {
      // detached 进程组：负 PID 杀组内全部（tsx wrapper + node 实际进程）；先 SIGTERM 再 SIGKILL 兜底
      process.kill(-workerPid, "SIGTERM");
    } catch {
      // 进程已退出，忽略
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      process.kill(-workerPid, "SIGKILL");
    } catch {
      // 已退出，忽略
    }
  }
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

/** 确认保留建议卡：把 OPEN 的 MAJOR/MINOR 卡豁免（EXCEPTED），不再显示为待处理。 */
export async function acknowledgeIssueAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireProjectAccess(projectId);
  await requireEpisodeAccess(projectId, episodeId);
  const issueId = String(formData.get("issueId") ?? "");
  const { prisma } = await import("@/lib/prisma");
  const issue = await prisma.workflowIssue.findFirst({ where: { id: issueId, episodeId, status: "OPEN" } });
  if (!issue) throw new Error("没有找到该问题卡。");
  if (issue.severity === "BLOCKER") throw new Error("严重问题（BLOCKER）不能确认保留，必须修复。");
  await prisma.workflowIssue.update({
    where: { id: issueId },
    data: { status: "EXCEPTED", updatedAt: new Date() }
  });
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

/** 全部确认保留：本集所有 OPEN 的建议卡（MAJOR/MINOR）一次性豁免。 */
export async function acknowledgeAllSuggestionsAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireProjectAccess(projectId);
  await requireEpisodeAccess(projectId, episodeId);
  const { prisma } = await import("@/lib/prisma");
  await prisma.workflowIssue.updateMany({
    where: { episodeId, status: "OPEN", severity: { in: ["MAJOR", "MINOR"] } },
    data: { status: "EXCEPTED" }
  });
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

export async function runSingleStageAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireProjectAccess(projectId);
  await requireEpisodeAccess(projectId, episodeId);
  const stageCode = String(formData.get("stageCode") ?? "");
  if (!/^E[0-5]$/.test(stageCode)) throw new Error("无效的岗位编号。");
  const { queueSingleStagePipeline } = await import("@/lib/episode-pipeline");
  await queueSingleStagePipeline(projectId, episodeId, stageCode);
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

export async function resetEpisodeShotsAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireProjectAccess(projectId);
  await requireEpisodeAccess(projectId, episodeId);
  const { prisma } = await import("@/lib/prisma");
  await prisma.workflowIssue.deleteMany({ where: { episodeId } });
  await prisma.compiledPromptVersion.deleteMany({ where: { unit: { episodeId } } });
  await prisma.seedanceUnitShot.deleteMany({ where: { unit: { episodeId } } });
  await prisma.seedanceUnit.deleteMany({ where: { episodeId } });
  await prisma.storyboardShot.deleteMany({ where: { episodeId } });
  // 重置时清掉 E0 骨架快照与岗位会话历史：新首轮从零开始，旧上下文不污染新剧本
  await prisma.sceneSnapshot.deleteMany({ where: { episodeId, sceneKey: { contains: "BEATS" } } });
  await prisma.apiRoleSession.deleteMany({ where: { episodeId } });
  await prisma.cliRoleSession.deleteMany({ where: { episodeId } });
  // 清掉执行记录：岗位条回到"未开始"、执行日志区清空——整集恢复未运行状态
  await prisma.pipelineRun.deleteMany({ where: { episodeId } });
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

/** #14 提示词版本：恢复历史版本为当前显示（selectedAt 置顶，不做内容修改）。 */
export async function restorePromptVersionAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireProjectAccess(projectId);
  await requireEpisodeAccess(projectId, episodeId);
  const versionId = String(formData.get("versionId") ?? "");
  const { prisma } = await import("@/lib/prisma");
  const version = await prisma.compiledPromptVersion.findFirst({
    where: { id: versionId, unit: { episodeId } },
    include: { unit: true }
  });
  if (!version) throw new Error("没有找到该提示词版本。");
  await prisma.compiledPromptVersion.update({
    where: { id: versionId },
    data: { selectedAt: new Date() }
  });
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

/** #14 提示词版本：手动编辑当前单元提示词并存为新版本（标记为手动稿，不覆盖编译产物）。 */
export async function saveManualPromptVersionAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireProjectAccess(projectId);
  await requireEpisodeAccess(projectId, episodeId);
  const unitId = String(formData.get("unitId") ?? "");
  const content = String(formData.get("content") ?? "").trim();
  if (!content) throw new Error("提示词内容不能为空。");
  const { prisma } = await import("@/lib/prisma");
  const unit = await prisma.seedanceUnit.findFirst({ where: { id: unitId, episodeId } });
  if (!unit) throw new Error("没有找到该单元。");
  const latest = await prisma.compiledPromptVersion.findFirst({
    where: { unitId },
    orderBy: { version: "desc" }
  });
  await prisma.compiledPromptVersion.create({
    data: {
      unitId,
      version: (latest?.version ?? 0) + 1,
      content,
      syncStatus: "DRAFT_COMPILED",
      selectedAt: new Date()
    }
  });
  revalidatePath(`/projects/${projectId}/episodes/${episodeId}`);
}

export async function preprocessProjectAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const { preprocessProjectProduction } = await import("@/lib/workflow");
  await preprocessProjectProduction(projectId);
  revalidatePath("/");
}

export async function startProjectFoundationAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const { queueProjectFoundation } = await import("@/lib/project-foundation");
  await queueProjectFoundation(projectId);
  revalidatePath(`/projects/${projectId}`);
}

export async function confirmAllAssetsAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const { prisma } = await import("@/lib/prisma");
  await prisma.asset.updateMany({ where: { projectId, status: "needs_confirmation" }, data: { status: "confirmed" } });
  revalidatePath(`/projects/${projectId}`);
}

export async function decidePresentationContractAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const contractId = String(formData.get("contractId") ?? "");
  const answer = String(formData.get("answer") ?? "").trim();
  if (!contractId || !answer) throw new Error("缺少确认信息。");
  const { prisma } = await import("@/lib/prisma");
  const contract = await prisma.presentationContract.findFirst({ where: { id: contractId, projectId } });
  if (!contract) throw new Error("表现规范不存在。");
  await prisma.presentationContract.update({
    where: { id: contract.id },
    data: { userAnswer: answer, status: "CONFIRMED", decidedAt: new Date() }
  });
  revalidatePath(`/projects/${projectId}`);
}

export async function skipPresentationContractAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const contractId = String(formData.get("contractId") ?? "");
  const { prisma } = await import("@/lib/prisma");
  await prisma.presentationContract.updateMany({
    where: { id: contractId, projectId },
    data: { status: "SKIPPED", decidedAt: new Date() }
  });
  revalidatePath(`/projects/${projectId}`);
}

export async function runFoundationStageAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const stageCode = String(formData.get("stageCode") ?? "");
  if (stageCode !== "P1" && stageCode !== "P2") throw new Error("无效的第一阶段岗位。");
  const { queueSingleFoundationStage } = await import("@/lib/project-foundation");
  await queueSingleFoundationStage(projectId, stageCode);
  revalidatePath(`/projects/${projectId}`);
}

/** 停止全剧基础工程（P1/P2 worker 进程组 + 当前批次状态）。 */
export async function stopProjectFoundationAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const { prisma } = await import("@/lib/prisma");
  const runs = await prisma.pipelineRun.findMany({
    where: {
      projectId,
      episodeId: null,
      stageCode: { in: ["P1", "P2"] },
      status: { in: ["QUEUED", "RUNNING"] }
    },
    select: { id: true, inputSummary: true }
  });
  if (!runs.length) throw new Error("全剧基础工程当前没有正在执行的岗位。");

  let batchToken = "";
  let workerPid = 0;
  for (const run of runs) {
    try {
      const parsed = JSON.parse(run.inputSummary || "{}") as Record<string, unknown>;
      if (typeof parsed.batchToken === "string" && parsed.batchToken) batchToken = parsed.batchToken;
      const pid = Number(parsed.workerPid ?? 0);
      if (Number.isInteger(pid) && pid > 0) workerPid = pid;
    } catch {
      // 继续读取同批次的其他记录。
    }
  }
  if (!batchToken) throw new Error("缺少基础工程批次信息，无法从页面停止。");

  await prisma.pipelineRun.updateMany({
    where: { id: { in: runs.map((run) => run.id) } },
    data: { status: "FAILED", finishedAt: new Date(), error: "用户手动停止" }
  });
  if (workerPid > 0) {
    try {
      process.kill(-workerPid, "SIGTERM");
    } catch {
      // 进程已经结束。
    }
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      process.kill(-workerPid, "SIGKILL");
    } catch {
      // 进程已经结束。
    }
  }
  revalidatePath(`/projects/${projectId}`);
}

