import type { PrismaClient } from "@prisma/client";
import type { DirectorAsset } from "@/lib/assets";
import { parseScriptBuffer, parseScriptContent } from "@/lib/import-script";
import { prisma } from "@/lib/prisma";
import { preprocessProject } from "@/lib/project-preprocess";
import { buildSceneSnapshot, buildTaskSchemaV4Payload, validateTaskSchemaV4Payload } from "@/lib/task-package";
import { readApprovedEpisodeFoundation, requireApprovedFoundation, type ApprovedEpisodeFoundation } from "@/lib/foundation-state";

type Db = PrismaClient;

export type ImportProjectInput = {
  ownerUserId: string;
  title: string;
  description?: string;
  style?: string;
  aspectRatio?: string;
  executionMode?: string;
  sourceName: string;
  sourceText: string;
};

export type ImportProjectFileInput = Omit<ImportProjectInput, "sourceText"> & {
  buffer: Buffer;
};

export type OneClickProductionOptions = {
  projectId: string;
  episodeId: string;
  useChatGpt?: boolean;
  generator?: (prompt: string, existingConversationUrl?: string) => Promise<GenerationOutcome>;
};

export type GenerationOutcome = {
  ok: boolean;
  output: string;
  conversationUrl?: string;
  error?: string;
};

export async function importProjectFromText(input: ImportProjectInput, db: Db = prisma) {
  return importProjectFromParsedScript(input, parseScriptContent(input.sourceName, input.sourceText), db);
}

async function importProjectFromParsedScript(input: Omit<ImportProjectInput, "sourceText">, imported: ReturnType<typeof parseScriptContent>, db: Db) {

  const result = await db.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: {
        title: input.title,
        description: input.description ?? `由 ${input.sourceName} 导入`,
        style: input.style ?? "真人竖屏短剧写实风格",
        aspectRatio: input.aspectRatio ?? "16:9",
        executionMode: input.executionMode ?? "CLI",
        ruleVersion: "TASK_SCHEMA_V4",
        roles: {
          create: { userId: input.ownerUserId, role: "ADMIN" }
        }
      }
    });

    const episodes = await Promise.all(
      imported.episodes.map((episode) =>
        tx.episode.create({
          data: {
            projectId: project.id,
            number: episode.number,
            title: episode.title,
            content: episode.content
          }
        })
      )
    );

    await tx.sceneSnapshot.create({
      data: {
        projectId: project.id,
        sceneKey: "SOURCE_IMPORT",
        title: `导入原文：${imported.sourceName}`,
        content: JSON.stringify({
          sourceName: imported.sourceName,
          sourceText: imported.sourceText,
          sourceStructure: imported.sourceStructure,
          readingView: imported.readingView,
          ...(imported.originalFile ? { originalFile: imported.originalFile } : {})
        }),
        metadata: JSON.stringify({
          schema: "IMPORTED_SOURCE_TEXT_V2",
          textOrigin: imported.readingView.kind === "DOCX" ? "DOCX_MAMMOTH_VIEW" : "TEXT_DECODED",
          readingView: imported.readingView.view,
          encoding: imported.readingView.encoding ?? null,
          prefacePolicy: "PRESERVED_AS_BACKGROUND_SECTION",
          noEpisodePolicy: "PRESERVED_WITHOUT_SYNTHETIC_EPISODE",
          originalFileStoredForRecovery: Boolean(imported.originalFile)
        })
      }
    });

    return { project, episodes };
  });
  await preprocessProject(result.project.id, db);
  return result;
}

export async function importProjectFromFile(input: ImportProjectFileInput, db: Db = prisma) {
  const imported = await parseScriptBuffer(input.sourceName, input.buffer);
  return importProjectFromParsedScript({
    ownerUserId: input.ownerUserId,
    title: input.title,
    description: input.description,
    style: input.style,
    aspectRatio: input.aspectRatio,
    executionMode: input.executionMode,
    sourceName: imported.sourceName
  }, imported, db);
}

export async function prepareEpisodeProduction(projectId: string, episodeId: string, db: Db = prisma) {
  const episode = await db.episode.findFirst({
    where: { id: episodeId, projectId },
    include: {
      project: { include: { assets: true } }
    }
  });

  if (!episode) {
    throw new Error("Episode not found.");
  }

  const packet = await readApprovedEpisodeFoundation(projectId, episode.number, db);
  const approved = await requireApprovedFoundation(projectId, db);
  const assetByCode = new Map(episode.project.assets.map((asset) => [asset.code, asset]));
  const existingAssets: DirectorAsset[] = packet.identities.map((identity) => {
    const asset = assetByCode.get(identity.code);
    if (!asset) throw new Error(`批准身份不存在：${identity.code}`);
    // Full identity descriptions and notes are backstage knowledge, not episode supply.
    return { id: identity.code, type: identity.type, name: identity.name, status: asset.status === "confirmed" ? "confirmed" : "needs_confirmation" };
  });
  const handoff = buildApprovedFoundationContext(packet);
  const snapshot = buildSceneSnapshot({ sceneText: packet.source.content, assets: existingAssets });
  const payload = await buildTaskSchemaV4Payload({
    projectName: episode.project.title,
    episodeNumber: episode.number,
    episodeTitle: episode.title ?? undefined,
    episodeText: packet.source.content,
    existingAssets,
    projectMemory: JSON.stringify(handoff["全剧记忆快照"]),
    episodeContext: JSON.stringify(handoff["本集上下文快照"]),
    projectProfile: { style: episode.project.style ?? undefined }
  });
  const validation = validateTaskSchemaV4Payload(payload);
  if (!validation.ok) {
    throw new Error(`TASK_SCHEMA_V4 invalid: ${validation.errors.join("; ")}`);
  }

  // 资产表只归 P2（资产拆解师）所有：信息包/剧本预处理不再自动粗提资产，
  // 避免每次更新信息包或跑 E1 都冒出一批裸名 CH/PROP 垃圾（如"电话""赵清雅"）
  return db.$transaction(async (tx) => {
    if ((await requireApprovedFoundation(projectId, tx)).id !== approved.id) throw new Error("第一阶段批准版本已变更，请重新准备信息包。");
    await tx.sceneSnapshot.deleteMany({
      where: {
        projectId,
        episodeId,
        sceneKey: snapshot["场次ID"]
      }
    });

    const sceneSnapshot = await tx.sceneSnapshot.create({
      data: {
        projectId,
        episodeId,
        sceneKey: snapshot["场次ID"],
        title: `${episode.title ?? `第${episode.number}集`} ${snapshot["场次ID"]}`,
        content: JSON.stringify(snapshot, null, 2),
        metadata: JSON.stringify({ schema: "SCENE_SNAPSHOT_V1" })
      }
    });

    const existingTaskPackage = await tx.taskPackage.findFirst({
      where: { projectId, episodeId },
      orderBy: { createdAt: "desc" }
    });
    const taskPackageData = {
      title: `${episode.title ?? `第${episode.number}集`} TASK_SCHEMA_V4`,
      brief: "单集分镜生成任务包",
      status: "READY" as const,
      payload: JSON.stringify(payload, null, 2)
    };
    const taskPackage = existingTaskPackage
      ? await tx.taskPackage.update({
          where: { id: existingTaskPackage.id },
          data: taskPackageData
        })
      : await tx.taskPackage.create({
          data: {
            projectId,
            episodeId,
            ...taskPackageData
          }
        });


    return { assets: [] as DirectorAsset[], sceneSnapshot, taskPackage, payload };
  });
}

/** Old consumers receive the approved episode view, never the full backstage bible. */
export function buildApprovedFoundationContext(packet: ApprovedEpisodeFoundation) {
  return {
    "全剧记忆快照": {
      schema: "FOUNDATION_HANDOFF_V1", sourceVersion: packet.sourceVersion, inputVersion: packet.inputVersion,
      f1SnapshotId: packet.f1SnapshotId, f2SnapshotId: packet.f2SnapshotId,
      scope: `仅第${packet.episode}集；必要前接与揭示边界见本集上下文`
    },
    "本集上下文快照": packet
  };
}



export async function preprocessProjectProduction(projectId: string, db: Db = prisma) {
  const { assertNoActiveFoundationDelivery } = await import('@/lib/foundation-choice-store');
  const checkIdle = async (tx: PrismaClient) => {
    await assertNoActiveFoundationDelivery(tx, projectId);
    if (await tx.pipelineRun.findFirst({ where: { projectId, status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } })) throw new Error('资料正在运行，不能同时重建原文场次。');
  };
  await checkIdle(db);
  return preprocessProject(projectId, db, { checkCurrent: checkIdle });
}

export function buildChatGptPrompt(payload: unknown) {
  return [
    "你是导演项目的分镜制作员，不是自由编剧。",
    "你必须先阅读下方 TASK_SCHEMA_V4 里的全剧记忆快照、本集上下文快照、资产索引、本集源文、导演知识库摘要，再生成单集 Seedance-ready 真人竖屏短剧分镜脚本。",
    "执行顺序：1. 锁源文和资产；2. 用全剧记忆理解人物身份、关系、前情和连续性；3. 用本集上下文快照确认本集开场状态、关键人物、地点、道具和前情；4. 按导演知识库摘要执行分镜写作规则；5. 输出 V4 证据包；6. 输出 FINAL_SCRIPT_START/FINAL_SCRIPT_END 包裹的最终正文。",
    "硬规则：不得新增改变原剧本因果的道具、线索、交易、行动结果或人物关系；不得跳过台词容量、单元六项锁、Seedance稳定性和镜头语言检查。",
    "如果信息不足，不要编造，必须在 V4 证据包里标明待确认项。",
    JSON.stringify(payload, null, 2)
  ].join("\n\n");
}
