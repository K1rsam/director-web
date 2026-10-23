import type { Prisma } from "@prisma/client";
import { types } from "node:util";
import { prisma } from "@/lib/prisma";
import { foundationJson, getFoundationState,loadFoundationInputs } from "@/lib/foundation-state";
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
      { sceneKey: { in: ["SOURCE_IMPORT", "FIDELITY_IMPORT", "PROJECT_MEMORY","SOURCE_READING_CONFIRMATION","SCRIPT_RESOLUTION_CURRENT_V1","SCRIPT_RESOLUTION_HISTORY_V1"] } },
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
  const effectiveEdited=deliveryState.effectiveEditorialCoverage??workingDocument.editorialCoverage;
  const packetInput=workingDocument.workflow==='LIGHT_STAGE1_V1'?await loadFoundationInputs(projectId,db):undefined;
  return {
    archivePurpose:"SOURCE_AND_HISTORY_EVIDENCE_ONLY_NOT_SEASON_PRODUCTION_DELIVERY" as const,
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
      ,"q1EditorialCoverage保留原模型编辑记录；freeSourceReviewedEpisodes仅为有来源和明确批准的免费解释复核，来源、目录或制作条件变化会失效，不代表新Q1调用或用户视听验收。"
    ],
    currentState: { ...legacyCurrentState, documentRevision: workingDocument.revision, completedEpisodes: [...effectiveEdited],q1EditorialCoverage:[...workingDocument.editorialCoverage],freeSourceReviewedEpisodes:effectiveEdited.filter(number=>!workingDocument.editorialCoverage.includes(number)),
      complete: deliveryState.complete, deliveryStatus: deliveryState.task?.status ?? (usesWorkingDocument ? "WORKING" : "LEGACY"),
      ...(usesWorkingDocument ? { planningReady: Boolean(workingDocument.f1), assetsReady: Boolean(workingDocument.f2),
        dataReady: deliveryState.complete,
        dataIssues: deliveryState.issues, reviewReady: deliveryState.complete, ready: false, approvalId: null,
        draftComplete: allEdited && deliveryState.availableEpisodes === deliveryState.totalEpisodes,
        message: deliveryState.task?.message ?? (deliveryState.complete ? "工作稿资料已整理完成，未生成审批包。" : "工作稿已保存，局部资料仍待完善。"),
        sourceVersion: workingDocument.sourceVersion } : {}) },
    workingDocument, deliveryState, legacyCurrentState,
    episodePackets: workingDocument.workflow === 'LIGHT_STAGE1_V1' ? await buildLightEpisodePackets(projectId, workingDocument, db,undefined,packetInput) : [],
    sourceInterpretations:[...byKey('SCRIPT_RESOLUTION_CURRENT_V1'),...byKey('SCRIPT_RESOLUTION_HISTORY_V1')],sourceReadingConfirmations:byKey('SOURCE_READING_CONFIRMATION'),
    sourceContext: state.sourceContext,
    sourceImports: byKey("SOURCE_IMPORT"), fidelityReceipts: byKey("FIDELITY_IMPORT"), sourceVersions: byKey("FOUNDATION_SOURCE"), candidates,
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

/** Same V1 JSON bytes as the synchronous serializer, without allocating one export-sized string. */
export function* foundationExportChunks(value: unknown, knownApiKeys: Array<string | undefined> = []): Generator<string, void> {
  const keys = knownApiKeys.filter((key): key is string => Boolean(key));
  const ancestors = new Set<object>();
  const omitted = (item: unknown) => item === undefined || typeof item === "function" || typeof item === "symbol";
  function prepare(item: unknown, name: string): unknown {
    if (item !== null && (typeof item === "object" || typeof item === "function" || typeof item === "bigint")) {
      const toJSON = (item as { toJSON?: unknown }).toJSON;
      if (typeof toJSON === "function") item = toJSON.call(item, name);
    }
    if (typeof item === "string") return keys.reduce((text, key) => text.replaceAll(key, "[REDACTED_API_KEY]"), item);
    // Match JSON.stringify's unboxing after its replacer has seen the original value.
    if (types.isNumberObject(item)) item = Number(item);
    else if (types.isStringObject(item)) item = String(item);
    else if (types.isBooleanObject(item)) item = Boolean.prototype.valueOf.call(item);
    if (typeof item === "bigint" || types.isBigIntObject(item)) {
      throw new TypeError("Do not know how to serialize a BigInt");
    }
    return item;
  }
  function* tokens(item: unknown, depth: number): Generator<string, void> {
    if (item === null || typeof item !== "object") {
      yield JSON.stringify(item)!;
      return;
    }
    if (ancestors.has(item)) throw new TypeError("Converting circular structure to JSON");
    ancestors.add(item);
    const indent = "  ".repeat(depth);
    try {
      if (Array.isArray(item)) {
        yield "[";
        const length = item.length;
        for (let index = 0; index < length; index++) {
          yield `${index ? ",\n" : "\n"}${indent}  `;
          const child = prepare(item[index], String(index));
          if (omitted(child)) yield "null";
          else yield* tokens(child, depth + 1);
        }
        if (length) yield `\n${indent}`;
        yield "]";
      } else {
        yield "{";
        let first = true;
        for (const name of Object.keys(item)) {
          const child = prepare((item as Record<string, unknown>)[name], name);
          if (omitted(child)) continue;
          yield `${first ? "\n" : ",\n"}${indent}  ${JSON.stringify(name)}: `;
          first = false;
          yield* tokens(child, depth + 1);
        }
        if (!first) yield `\n${indent}`;
        yield "}";
      }
    } finally { ancestors.delete(item); }
  }
  const root = prepare(value, "");
  if (omitted(root)) return;
  const chunkSize = 64 * 1024;
  let pending = "";
  for (const token of tokens(root, 0)) {
    let offset = 0;
    while (offset < token.length) {
      let end = Math.min(token.length, offset + chunkSize - pending.length);
      // TextEncoder must never receive separate halves of a UTF-16 surrogate pair.
      if (end < token.length && token.charCodeAt(end - 1) >= 0xD800 && token.charCodeAt(end - 1) <= 0xDBFF
        && token.charCodeAt(end) >= 0xDC00 && token.charCodeAt(end) <= 0xDFFF) end++;
      pending += token.slice(offset, end);
      offset = end;
      if (pending.length >= chunkSize) { yield pending; pending = ""; }
    }
  }
  if (pending) yield pending;
}

export function foundationExportStream(value: unknown, knownApiKeys: Array<string | undefined> = []): ReadableStream<Uint8Array> {
  const iterator = foundationExportChunks(value, knownApiKeys);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      try {
        const next = iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        iterator.return(undefined);
        controller.error(error);
      }
    },
    cancel() { iterator.return(undefined); }
  }, { highWaterMark: 0 });
}
