import type { PrismaClient } from "@prisma/client";
import { extractEpisodeAssetCandidates, type DirectorAsset } from "@/lib/assets";
import { parseScriptBuffer, parseScriptContent, type ImportedScript } from "@/lib/import-script";
import { prisma } from "@/lib/prisma";
import { preprocessProject } from "@/lib/project-preprocess";
import { buildSceneSnapshot, buildTaskSchemaV4Payload, validateTaskSchemaV4Payload } from "@/lib/task-package";
import { formatAssetIndex } from "@/lib/assets";

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

type ImportProjectMetadata = Omit<ImportProjectInput, "sourceText">;

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
  const imported = parseScriptContent(input.sourceName, input.sourceText);

  return importParsedProject(input, imported, db);
}

async function importParsedProject(input: ImportProjectMetadata, imported: ImportedScript, db: Db) {

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

    return { project, episodes };
  });
  await preprocessProject(result.project.id, db);
  return result;
}

export async function importProjectFromFile(input: ImportProjectFileInput, db: Db = prisma) {
  const imported = await parseScriptBuffer(input.sourceName, input.buffer);
  return importParsedProject(input, imported, db);
}

export async function prepareEpisodeProduction(projectId: string, episodeId: string, db: Db = prisma) {
  await ensureProjectPreprocessed(projectId, db);
  const episode = await db.episode.findUnique({
    where: { id: episodeId },
    include: {
      project: { include: { assets: true } }
    }
  });

  if (!episode) {
    throw new Error("Episode not found.");
  }

  const existingAssets: DirectorAsset[] = episode.project.assets.map((asset) => ({
    id: asset.code,
    type: asset.type,
    name: asset.name,
    status: asset.status === "confirmed" ? "confirmed" : "needs_confirmation",
    sourceText: asset.sourceText ?? undefined,
    notes: asset.notes ?? undefined
  }));
  const candidates = extractEpisodeAssetCandidates(episode.content, existingAssets);
  // 快照里的 人物/道具/场景 一律用正式资产（P2 产出，ID 与资产表一致）；
  // 项目刚建、P2 还没跑时用候选兜底，保证快照不空
  const sceneAssets = existingAssets.length ? existingAssets : candidates.all;
  const newAssets = candidates.all.filter((asset) => !existingAssets.some((existing) => existing.id === asset.id));
  const projectMemory = await db.sceneSnapshot.findFirst({
    where: { projectId, sceneKey: "PROJECT_MEMORY" },
    orderBy: { createdAt: "desc" }
  });
  const episodeContext = await db.sceneSnapshot.findFirst({
    where: { projectId, episodeId, sceneKey: { contains: "CONTEXT" } },
    orderBy: { createdAt: "desc" }
  });
  const snapshot = buildSceneSnapshot({ sceneText: episode.content, assets: sceneAssets });
  const payload = await buildTaskSchemaV4Payload({
    projectName: episode.project.title,
    episodeNumber: episode.number,
    episodeTitle: episode.title ?? undefined,
    episodeText: episode.content,
    existingAssets,
    projectMemory: projectMemory?.content,
    episodeContext: episodeContext?.content,
    projectProfile: { style: episode.project.style ?? undefined }
  });
  const validation = validateTaskSchemaV4Payload(payload);
  if (!validation.ok) {
    throw new Error(`TASK_SCHEMA_V4 invalid: ${validation.errors.join("; ")}`);
  }

  // 资产表只归 P2（资产拆解师）所有：信息包/剧本预处理不再自动粗提资产，
  // 避免每次更新信息包或跑 E1 都冒出一批裸名 CH/PROP 垃圾（如"电话""赵清雅"）
  return db.$transaction(async (tx) => {
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


    // 用正式资产（P2 产出）刷新本集上下文快照里的人物/地点/道具与场次快照，
    // 旧候选假 ID（CH-023 赵清雅）会随快照进 E1/P1/P2 提示词，必须覆盖
    if (episodeContext) {
      let parsed: Record<string, unknown> = {};
      try {
        const value: unknown = JSON.parse(episodeContext.content ?? "{}");
        if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      const content: Record<string, unknown> = {
        ...parsed,
        knownCharacters: formatAssetIndex(sceneAssets.filter((asset) => asset.type === "CH")),
        knownLocations: formatAssetIndex(sceneAssets.filter((asset) => asset.type === "LOC")),
        knownProps: formatAssetIndex(sceneAssets.filter((asset) => asset.type === "PROP")),
        sceneSnapshot: buildSceneSnapshot({ sceneText: episode.content, assets: sceneAssets })
      };
      await tx.sceneSnapshot.update({
        where: { id: episodeContext.id },
        data: { content: JSON.stringify(content, null, 2) }
      });
    }
    return { assets: newAssets, sceneSnapshot, taskPackage, payload };
  });
}



export async function preprocessProjectProduction(projectId: string, db: Db = prisma) {
  return preprocessProject(projectId, db);
}

async function ensureProjectPreprocessed(projectId: string, db: Db) {
  const memory = await db.sceneSnapshot.findFirst({ where: { projectId, sceneKey: "PROJECT_MEMORY" } });
  if (!memory) {
    await preprocessProject(projectId, db);
  }
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

