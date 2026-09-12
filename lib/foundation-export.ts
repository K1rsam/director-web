import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { foundationJson, getFoundationState } from "@/lib/foundation-state";
import { FOUNDATION_TASK_CONTRACT } from "@/lib/project-foundation-contracts";
import { summarizeFoundationRunUsage } from "@/lib/foundation-run-usage";
import { getFoundationDeliveryState } from "@/lib/foundation-delivery";
import { buildLightEpisodePackets } from '@/lib/light-foundation-supply';

/** Auth belongs to the route; the injected database keeps verification off the user's database. */
export async function buildFoundationExport(projectId: string, db: Prisma.TransactionClient = prisma) {
  const [project, snapshots, pipelineRuns, presentationConditions, state, deliveryState] = await Promise.all([
    db.project.findUniqueOrThrow({ where: { id: projectId }, select: {
      id: true, title: true, description: true, style: true, aspectRatio: true, executionMode: true,
      ruleVersion: true, createdAt: true, updatedAt: true,
      episodes: { orderBy: { number: "asc" }, select: { id: true, number: true, title: true, content: true } }
    } }),
    db.sceneSnapshot.findMany({ where: { projectId, OR: [
      { sceneKey: { in: ["SOURCE_IMPORT", "PROJECT_MEMORY"] } },
      { sceneKey: { startsWith: "FOUNDATION_" } }, { sceneKey: { startsWith: "EP-", endsWith: "-CONTEXT" } }
    ] }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.pipelineRun.findMany({ where: { projectId, episodeId: null, stageCode: { in: ["P0", "P1", "P2", "P3", "F1", "F2", "Q1"] } }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    db.presentationContract.findMany({ where: { projectId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] }),
    getFoundationState(projectId, db), getFoundationDeliveryState(projectId, db)
  ]);
  const byKey = (key: string) => snapshots.filter((snapshot) => snapshot.sceneKey === key);
  const approvedEpisodePackets = snapshots.filter((snapshot) => foundationJson(snapshot.content).schema === "EPISODE_FOUNDATION_V1");
  const candidates = { f1: byKey("FOUNDATION_F1"), f2: byKey("FOUNDATION_F2"), q1: byKey("FOUNDATION_Q1") };
  const mainKeys = new Set(["SOURCE_IMPORT", "FOUNDATION_SOURCE", "FOUNDATION_F1", "FOUNDATION_F2", "FOUNDATION_Q1", "FOUNDATION_APPROVED"]);
  const workingDocument = deliveryState.document;
  const usesWorkingDocument = Boolean(deliveryState.task || byKey("FOUNDATION_DOCUMENT").length);
  const legacyCurrentState = { preprocessReady: state.preprocessReady, planningReady: state.planningReady, assetsReady: state.assetsReady,
    dataReady: state.dataReady, dataIssues: state.dataIssues, reviewReady: state.reviewReady, ready: state.ready, draftComplete: state.draftComplete,
    message: state.message, sourceVersion: state.sourceVersion, inputVersion: state.inputVersion,
    approvalId: state.ready ? state.approved?.id ?? null : null, recoveries: state.recoveries };
  const allEdited = deliveryState.totalEpisodes > 0 && deliveryState.editedEpisodes === deliveryState.totalEpisodes;
  return {
    schema: "PROJECT_FOUNDATION_EXPORT_V1" as const, exportedAt: new Date().toISOString(), project,
    targetArchitecture: FOUNDATION_TASK_CONTRACT.targetArchitecture,
    currentTestScope: FOUNDATION_TASK_CONTRACT.currentTestScope,
    notes: [
      "仅导出已保存资料与调用证据，不生成新的 AI 总结。候选、历史批准与当前批准必须按版本区分。",
      "workingDocument 是持续保存的工作稿，不是审批或 FOUNDATION_APPROVED 批准包；deliveryState 表示本次资料任务、实际范围、待完善项与必要选择。legacyCurrentState、finalOutput 与旧批准证据继续保留，不能代替当前工作稿状态。",
      "普通资料任务的 currentState.ready 始终不冒充已批准；complete 仅是当前文字资料整理完成，completedEpisodes 为实际完成编辑的集号，不代表真实图像/视频生成或用户认可。调用结果 UNKNOWN 时保留原始日志和工作稿，不能由导出动作确认成功或自动重发。",
      "新版SOURCE_IMPORT保留读取文本、来源分区及原上传文件的恢复副本；旧版可能只有提取文本，不将其冒充原文件字节。",
      "快照 content / metadata 与 pipelineRuns 的 inputSummary / outputSummary / log / error 保持完整字符串；JSON 字符串可继续解析。",
      "calls.providerCallCount 是该记录新增的模型调用尝试次数，不是计费统计；reusedFrom 标明原运行与分片；revalidatedUnder 保存本次复验协议和任务。原 taskPrompt、input、response 及历史调用耗时不会归零或改写；缺少计数字段的旧日志不可据此推断零成本。",
      "recordedRunUsage 仅回算各记录的顶层 CLI turn.completed.usage，不是账户账单。unknownCalls 大于 0 时仅含已知小计；null 为未返回或证据不足。缓存包含在输入、推理包含在输出中；复用不重计原请求，已记录零不保证存储没有遗漏。",
      "dataIssues 是程序重算的资料缺口，与模型 issues 分开；assetsReady 仅表示候选存在，dataReady 才表示这些缺口已清。复验成功不等于 Q1 批准。",
      "draftComplete 表示当前三岗已形成完整初稿及审查结论，允许REPAIR/BLOCKED；ready另行表示当前资料已批准，不以未批准否定已形成的初稿。",
      "本轮只测试v0.2目标下的第一阶段资料；后续专业未实施，旧E链不是新版消费者。本导出不代表后续阶段、成片、真实生成稳定性或用户认可。"
    ],
    currentState: { ...legacyCurrentState, documentRevision: workingDocument.revision, completedEpisodes: [...workingDocument.editorialCoverage],
      complete: deliveryState.complete, deliveryStatus: deliveryState.task?.status ?? (usesWorkingDocument ? "WORKING" : "LEGACY"),
      ...(usesWorkingDocument ? { planningReady: Boolean(workingDocument.f1), assetsReady: Boolean(workingDocument.f2),
        dataReady: deliveryState.complete,
        dataIssues: deliveryState.issues, reviewReady: deliveryState.complete, ready: false, approvalId: null,
        draftComplete: allEdited && deliveryState.availableEpisodes === deliveryState.totalEpisodes,
        message: deliveryState.task?.message ?? (deliveryState.complete ? "工作稿资料已整理完成，未生成审批包。" : "工作稿已保存，局部资料仍待完善。"),
        sourceVersion: workingDocument.sourceVersion } : {}) },
    workingDocument, deliveryState, legacyCurrentState,
    episodePackets: workingDocument.workflow === 'LIGHT_STAGE1_V1' ? await buildLightEpisodePackets(projectId, workingDocument, db) : [],
    sourceContext: state.sourceContext,
    sourceImports: byKey("SOURCE_IMPORT"), sourceVersions: byKey("FOUNDATION_SOURCE"), candidates,
    finalOutput: state.finalOutput,
    approvals: byKey("FOUNDATION_APPROVED"), approvedEpisodePackets,
    historicalSnapshots: snapshots.filter((snapshot) => !mainKeys.has(snapshot.sceneKey ?? "") && !approvedEpisodePackets.includes(snapshot)),
    presentationConditions, pipelineRuns,
    recordedRunUsage: pipelineRuns.filter(run => ["F1", "F2", "Q1"].includes(run.stageCode)).map(run => ({
      runId: run.id, stageCode: run.stageCode, durationMs: run.durationMs, usage: summarizeFoundationRunUsage(run.log)
    }))
  };
}

export function foundationExportFilename(projectId: string) {
  return `foundation-${encodeURIComponent(projectId)}.json`;
}

/** Redact only exact configured keys; never erase unknown source or model text by a generic key pattern. */
export function serializeFoundationExport(value: unknown, knownApiKeys: Array<string | undefined> = []) {
  const keys = knownApiKeys.filter((key): key is string => Boolean(key));
  return JSON.stringify(value, (_name, item) => typeof item === "string"
    ? keys.reduce((text, key) => text.replaceAll(key, "[REDACTED_API_KEY]"), item) : item, 2);
}
