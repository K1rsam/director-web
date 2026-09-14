"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireEpisodeAccess, requireProjectAccess, requireSessionUser } from "@/lib/auth";
import { readProjectSubmission, resolveProjectDestination } from "@/lib/project-entry";
import { terminateWorkerProcessTree } from "@/lib/process-control";
import type { CodexCliStatus } from "@/lib/codex-cli";
import {
  PRESENTATION_SCOPE_MODES,
  parsePresentationEpisodeNumbers,
  resolvePresentationContractScope,
  type PresentationContractScopeMode
} from "@/lib/presentation-contracts";
import { confirmFoundationChoice, FoundationChoiceError } from "@/lib/foundation-choice-store";

export type ProjectCreationState = { error: string };

export type ProviderConnectionState = {
  ok: boolean;
  message: string;
  provider?: "DEEPSEEK" | "CLI";
  models?: string[];
  cliStatus?: CodexCliStatus;
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
    const { readCodexCliStatus } = await import("@/lib/codex-cli");
    const cliStatus = await readCodexCliStatus();
    return {
      ok: true,
      provider: "CLI",
      cliStatus,
      message: cliStatus.warnings.length
        ? `检测通过：已读取本机 Codex /status；${cliStatus.warnings.join(" ")}`
        : "检测通过：已读取本机 Codex /status，页面显示的是最新账号、额度和用量摘要。"
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const message = /not logged in|尚未完成登录|尚未登录/i.test(detail)
      ? "检测未通过：本机 Codex CLI 尚未完成登录，请在本机终端运行 codex 并按提示完成登录后重试。"
      : /找不到 Codex CLI|ENOENT|不可用/i.test(detail)
        ? "检测未通过：未找到可用的 Codex CLI，请在本机终端确认 codex --version 可用。"
        : /超时|timeout/i.test(detail)
          ? "检测未通过：Codex CLI 响应超时，请确认本机 CLI 没有被其他任务占用。"
          : "检测未通过：本机 Codex CLI 当前不可用，请在本机终端确认 CLI 已安装并完成登录后重试。";
    return {
      ok: false,
      provider: "CLI",
      message
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
    const { prepareFidelityImport } = await import("@/lib/fidelity-import");
    const mode = formData.get("cleaningMode") === "direct" ? "direct" : "fidelity";
    if (formData.get("cleaningMode") === "optimize") throw new Error("内容优化尚未开放；请选择保真清洗或直接导入。");
    const bytes = submission.mode === "upload" ? submission.buffer : Buffer.from(submission.sourceText,"utf8");
    const original = formData.get("originalScript");
    if (bytes.length > 20 * 1024 * 1024 || original instanceof File && original.size > 20 * 1024 * 1024) throw new Error("剧本或配对原稿超过20MB。");
    const prepared = await prepareFidelityImport(submission.sourceName,bytes,mode,[],formData.get("trustExternalDecisions")==="1",original instanceof File && original.size ? {name:original.name,bytes:Buffer.from(await original.arrayBuffer())}:undefined);
    if (formData.get("previewSourceVersion") !== prepared.receipt.readingHash || formData.get("previewOriginalHash") !== prepared.receipt.originalHash) throw new Error("稿件或预览已变化，请重新预览后创建。");
    if (prepared.receipt.mode === "fidelity") prepared.receipt.p1Review = { status: "PENDING" };
    const result = await workflow.importParsedProject({ownerUserId:currentUser.id,title:submission.title,style:submission.style,aspectRatio:submission.aspectRatio,executionMode:submission.executionMode,sourceName:submission.sourceName,fidelityReceipt:prepared.receipt},prepared.imported,(await import("@/lib/prisma")).prisma);
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
    return "导入失败：分集编号发生冲突，常见原因是剧本页眉重复或同一集标题重复。第0集可以作为前置资料保留，请检查重复的“第X集”标题后重试。";
  }
  if (/database is locked|SQLITE_BUSY|P2034/i.test(message)) {
    return "本地数据库正在被其他任务占用，请停止正在运行的任务后重试。";
  }
  if (/Unsupported script file type/i.test(message)) {
    return "剧本格式不受支持，请上传 TXT、MD 或 DOCX 文件。";
  }
  if (/Promise\.all|invocation in|[A-Za-z]:\\|node_modules[\\/]|\.next[\\/]/i.test(message)) {
    return "项目创建失败：导入剧本时发生内部错误。请检查分集标题是否唯一；剧名前的人物小传/剧情梗概和第0集会作为前置资料保留。如果仍然失败，请保留剧本和此提示交给管理员。";
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
    const { assertNoActiveFoundationDelivery } = await import('@/lib/foundation-choice-store');
    await assertNoActiveFoundationDelivery(prisma, projectId);
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
  const { assertStageOneTestScope } = await import("@/lib/episode-pipeline");
  assertStageOneTestScope();
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

/** 页面按钮启动批量剧集监控：按质量门自动补入正式剧集，最多三集并发。 */
export async function startEpisodeBatchMonitorAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const { queueEpisodeBatchMonitor } = await import("@/lib/episode-batch-monitor");
  await queueEpisodeBatchMonitor(projectId, { requireNoMajors: true });
  revalidatePath(`/projects/${projectId}`);
}

/** 页面停止批量监控；只停止调度器，不强制中断已经启动的剧集 worker。 */
export async function stopEpisodeBatchMonitorAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const { stopEpisodeBatchMonitor } = await import("@/lib/episode-batch-monitor");
  await stopEpisodeBatchMonitor(projectId);
  revalidatePath(`/projects/${projectId}`);
}

export async function repairOpenIssuesAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireProjectAccess(projectId);
  await requireEpisodeAccess(projectId, episodeId);
  const includeSuggestions = formData.get("includeSuggestions") === "1";
  const { queueRepairPipeline } = await import("@/lib/episode-pipeline");
  await queueRepairPipeline(projectId, episodeId, { includeSuggestions });
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
    await terminateWorkerProcessTree(workerPid);
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

/** 人工确认返修回滚结果：只解除系统审计卡，不修改任何分镜内容。 */
export async function acknowledgeRepairRegressionAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  const episodeId = String(formData.get("episodeId") ?? "");
  await requireProjectAccess(projectId);
  await requireEpisodeAccess(projectId, episodeId);
  const issueId = String(formData.get("issueId") ?? "");
  const { prisma } = await import("@/lib/prisma");
  const active = await prisma.pipelineRun.findFirst({
    where: { projectId, episodeId, status: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true }
  });
  if (active) throw new Error("本集仍有岗位正在执行，请等待执行结束后再确认回滚结果。 ");
  const issue = await prisma.workflowIssue.findFirst({
    where: { id: issueId, projectId, episodeId, code: "REPAIR_REGRESSION", status: "OPEN" }
  });
  if (!issue) throw new Error("没有找到待确认的返修回归卡。 ");
  await prisma.workflowIssue.update({
    where: { id: issue.id },
    data: {
      status: "RESOLVED",
      evidence: `${issue.evidence}；人工确认：接受本轮回滚后的安全状态。`,
      requestedEffect: "系统审计卡已确认；下一轮返修仍须按当前 OPEN 问题卡定向执行。"
    }
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
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/");
}

export async function startProjectFoundationAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const { queueProjectFoundation } = await import("@/lib/project-foundation");
  try { await queueProjectFoundation(projectId); }
  catch (error) {
    if (!(error instanceof FoundationChoiceError)) throw error;
    redirect(`/projects/${encodeURIComponent(projectId)}?foundationNotice=${error.notice}#presentation-contracts`);
  }
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/");
}

/** Normal product entry: one persistent delivery, not a choice of backstage roles. */
export async function startFoundationDeliveryAction(formData: FormData) {
  const projectId = String(formData.get('projectId') ?? '');
  await requireProjectAccess(projectId);
  const expectedState = String(formData.get('expectedState') ?? '');
  const { queueFoundationDelivery, launchFoundationDelivery } = await import('@/lib/foundation-delivery');
  let notice = '';
  try {
    if (!expectedState) throw new Error('资料任务状态已变化');
    const task = await queueFoundationDelivery(projectId, { expectedState, allowUnknownRetry: formData.get('allowUnknownRetry') === 'yes',
      ...(formData.get('assetPromptOptionPresent') === 'yes' ? { autoAssetPrompts: formData.get('autoAssetPrompts') === 'yes' } : {}) });
    await launchFoundationDelivery(task);
  } catch (error) {
    notice = error instanceof Error && /未知|重复计费|重发/.test(error.message) ? 'call-unknown' : error instanceof Error && /状态已变化|正在处理中/.test(error.message) ? 'state-changed' : 'delivery-unavailable';
  }
  revalidatePath(`/projects/${projectId}`); revalidatePath('/');
  redirect(`/projects/${encodeURIComponent(projectId)}${notice ? `?foundationNotice=${notice}` : ''}`);
}

export async function stopFoundationDeliveryAction(formData: FormData) {
  const projectId = String(formData.get('projectId') ?? '');
  await requireProjectAccess(projectId);
  const { stopFoundationDelivery } = await import('@/lib/foundation-delivery');
  let notice = '';
  try { await stopFoundationDelivery(projectId, String(formData.get('taskId') ?? '')); }
  catch (error) { notice = error instanceof Error && /状态已变化/.test(error.message) ? 'state-changed' : 'delivery-unavailable'; }
  revalidatePath(`/projects/${projectId}`); revalidatePath('/');
  redirect(`/projects/${encodeURIComponent(projectId)}${notice ? `?foundationNotice=${notice}` : ''}`);
}

export async function confirmFoundationDeliveryChoiceAction(formData: FormData) {
  const projectId = String(formData.get('projectId') ?? '');
  await requireProjectAccess(projectId);
  const { prisma } = await import('@/lib/prisma');
  const { confirmAndContinueFoundationDelivery, launchFoundationDelivery } = await import('@/lib/foundation-delivery');
  let notice = 'decision-continued';
  try {
    const task = await confirmAndContinueFoundationDelivery(prisma, { projectId, contractId: String(formData.get('contractId') ?? ''), revision: String(formData.get('revision') ?? ''), expectedTaskId: String(formData.get('expectedTaskId') ?? ''),
      ...(formData.has('optionIndex') ? { optionIndex: String(formData.get('optionIndex')) } : {}), ...(formData.has('customAnswer') ? { customAnswer: String(formData.get('customAnswer')) } : {}) });
    if (task) await launchFoundationDelivery(task);
    else notice = 'decision-collected';
  } catch (error) { notice = error instanceof FoundationChoiceError ? error.notice : error instanceof Error && /状态已变化/.test(error.message) ? 'state-changed' : 'delivery-unavailable'; }
  revalidatePath(`/projects/${projectId}`); revalidatePath('/');
  redirect(`/projects/${encodeURIComponent(projectId)}?foundationNotice=${notice}#presentation-contracts`);
}

export async function continueProjectFoundationAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const expectedState = String(formData.get("expectedState") ?? "");
  const { queueProjectFoundationContinuation, reconcileAbandonedFoundationRuns, FoundationContinuationStateChangedError, FoundationUnknownCallError } = await import("@/lib/project-foundation");
  let stateChanged = false;
  let storageUnknown = false;
  let callUnknown = false;
  let decisionNotice: string | undefined;
  try {
    const recovery = await reconcileAbandonedFoundationRuns(projectId);
    storageUnknown = recovery.errors.length > 0;
    stateChanged = recovery.updated > 0;
    if (!stateChanged && !storageUnknown) await queueProjectFoundationContinuation(projectId, undefined, expectedState);
  }
  catch (error) {
    if (error instanceof FoundationChoiceError) decisionNotice = error.notice;
    else if (error instanceof FoundationUnknownCallError) callUnknown = true;
    else if (error instanceof FoundationContinuationStateChangedError) stateChanged = true;
    else throw error;
  }
  const projectPath = `/projects/${encodeURIComponent(projectId)}`;
  revalidatePath(projectPath);
  revalidatePath("/");
  redirect(decisionNotice ? `${projectPath}?foundationNotice=${decisionNotice}#presentation-contracts` : callUnknown ? `${projectPath}?foundationNotice=call-unknown` : storageUnknown ? `${projectPath}?foundationNotice=worker-unknown` : stateChanged ? `${projectPath}?foundationNotice=state-changed` : projectPath);
}

/** Explicit user check only: no provider call, no timeout-based cancellation of a live worker. */
export async function inspectFoundationWorkerAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const { reconcileAbandonedFoundationRuns } = await import("@/lib/project-foundation");
  const result = await reconcileAbandonedFoundationRuns(projectId);
  const projectPath = `/projects/${encodeURIComponent(projectId)}`;
  revalidatePath(projectPath);
  redirect(`${projectPath}?foundationNotice=${result.errors.length ? "worker-unknown" : result.updated ? "state-changed" : "worker-unchanged"}`);
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
  if (formData.has("revision")) {
  const { prisma } = await import("@/lib/prisma");
  let notice = "decision-saved";
  try { await confirmFoundationChoice(prisma, { projectId, contractId, revision: String(formData.get("revision") ?? ""),
    ...(formData.has("optionIndex") ? { optionIndex: String(formData.get("optionIndex")) } : {}),
    ...(formData.has("customAnswer") ? { customAnswer: String(formData.get("customAnswer")) } : {}) }); }
  catch (error) { if (!(error instanceof FoundationChoiceError)) throw error; notice = error.notice; }
  revalidatePath(`/projects/${projectId}`);
  redirect(`/projects/${encodeURIComponent(projectId)}?foundationNotice=${notice}#presentation-contracts`);

    return;
  }
  const useCustom = String(formData.get("useCustom") ?? "") === "1";
  const customAnswer = String(formData.get("customAnswer") ?? "").trim();
  const answer = (useCustom ? customAnswer : String(formData.get("answer") ?? "")).trim();
  if (!contractId || !answer) throw new Error("缺少确认信息。");
  const { prisma } = await import("@/lib/prisma");
  const contract = await prisma.presentationContract.findFirst({ where: { id: contractId, projectId } });
  if (!contract) throw new Error("表现规范不存在。");

  const scopeValue = String(formData.get("scopeMode") ?? "SOURCE_EPISODES");
  if (!PRESENTATION_SCOPE_MODES.includes(scopeValue as PresentationContractScopeMode)) {
    throw new Error("表现规范适用范围无效，请重新选择相关集、指定集或全部正式集。");
  }
  const projectEpisodes = await prisma.episode.findMany({
    where: { projectId, number: { gte: 1 } },
    select: { id: true, number: true },
    orderBy: { number: "asc" }
  });
  const sourceEpisodeNumber = contract.episodeId
    ? projectEpisodes.find((episode) => episode.id === contract.episodeId)?.number ?? null
    : null;
  const typedTargets = formData.getAll("targetEpisodeNumber").map(String);
  const textTargets = String(formData.get("targetEpisodeNumbers") ?? "").trim();
  const storedTargets = contract.targetEpisodeNumbers ?? "";
  const hasExplicitScopeTargets = String(formData.get("targetEpisodeSelectionPresent") ?? "") === "1";
  const requestedTargets = hasExplicitScopeTargets
    ? [...typedTargets, textTargets].filter(Boolean).join("、")
    : storedTargets;
  const resolvedScope = resolvePresentationContractScope({
    scope_mode: scopeValue,
    target_episode_numbers: requestedTargets,
    source_episode_number: sourceEpisodeNumber
  }, projectEpisodes.map((episode) => episode.number));
  if (scopeValue === "SELECTED_EPISODES" && !resolvedScope.episodeNumbers.length) {
    throw new Error("请至少填写一个正式集号，例如：1、10、20。");
  }
  if (scopeValue !== "ALL_EPISODES" && !resolvedScope.episodeNumbers.length) {
    throw new Error("没有找到可应用的正式集，请检查剧集是否已完成拆分。");
  }
  const invalidTargets = parsePresentationEpisodeNumbers(requestedTargets)
    .filter((number) => !projectEpisodes.some((episode) => episode.number === number));
  if (scopeValue !== "ALL_EPISODES" && invalidTargets.length) {
    throw new Error(`指定的第${invalidTargets.join("、")}集不存在，请只填写项目中的正式集号。`);
  }
  await prisma.presentationContract.update({
    where: { id: contract.id },
    data: {
      userAnswer: answer,
      status: "CONFIRMED",
      scopeMode: resolvedScope.mode,
      targetEpisodeNumbers: resolvedScope.mode === "ALL_EPISODES" ? null : JSON.stringify(resolvedScope.episodeNumbers),
      decidedAt: new Date()
    }
  });
  revalidatePath(`/projects/${projectId}`);
  for (const episode of projectEpisodes.filter((item) => resolvedScope.mode === "ALL_EPISODES" || resolvedScope.episodeNumbers.includes(item.number))) {
    revalidatePath(`/projects/${projectId}/episodes/${episode.id}`);
  }
}

export async function skipPresentationContractAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  redirect(`/projects/${encodeURIComponent(projectId)}?foundationNotice=decision-required#presentation-contracts`);
}

export async function runFoundationStageAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const stageCode = String(formData.get("stageCode") ?? "");
  if (stageCode !== "F1" && stageCode !== "F2" && stageCode !== "Q1") throw new Error("无效的第一阶段岗位。");
  const resumeFromRunId = String(formData.get("resumeFromRunId") ?? "").trim();
  const replayOnly = formData.get("replayOnly") === "1";
  const allowUnknownRetry = formData.get("allowUnknownRetry") === "1";
  const { queueSingleFoundationStage, FoundationUnknownCallError } = await import("@/lib/project-foundation");
  try { await queueSingleFoundationStage(projectId, stageCode, resumeFromRunId || replayOnly || allowUnknownRetry ? { resumeFromRunId, replayOnly, ...(allowUnknownRetry ? { allowUnknownRetry } : {}) } : undefined); }
  catch (error) {
    if (error instanceof FoundationChoiceError) redirect(`/projects/${encodeURIComponent(projectId)}?foundationNotice=${error.notice}#presentation-contracts`);
    if (!(error instanceof FoundationUnknownCallError)) throw error;
    revalidatePath(`/projects/${projectId}`);
    redirect(`/projects/${encodeURIComponent(projectId)}?foundationNotice=call-unknown`);
  }
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/");
}

/** 停止全剧基础工程（F1/F2/Q1 worker 进程组 + 当前批次状态）。 */
export async function stopProjectFoundationAction(formData: FormData) {
  const projectId = String(formData.get("projectId") ?? "");
  await requireProjectAccess(projectId);
  const { prisma } = await import("@/lib/prisma");
  const runs = await prisma.pipelineRun.findMany({
    where: {
      projectId,
      episodeId: null,
      stageCode: { in: ["F1", "F2", "Q1"] },
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

  const canceled = await prisma.pipelineRun.updateMany({
    where: { id: { in: runs.map((run) => run.id) }, status: { in: ["QUEUED", "RUNNING"] } },
    data: { status: "CANCELED", finishedAt: new Date(), error: "用户手动停止" }
  });
  if (canceled.count > 0 && workerPid > 0) {
    await terminateWorkerProcessTree(workerPid);
  }
  revalidatePath(`/projects/${projectId}`);
  revalidatePath("/");
}
