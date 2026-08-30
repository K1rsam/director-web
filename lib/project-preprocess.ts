import type { AssetType, PrismaClient } from "@prisma/client";
import {
  DIRECTOR_ASSET_TYPES,
  extractEpisodeAssetCandidates,
  formatAssetIndex,
  type DirectorAsset,
  type DirectorAssetType
} from "@/lib/assets";
import { prisma } from "@/lib/prisma";
import { extractScriptScenes } from "@/lib/scene-structure";
import { buildSceneSnapshot } from "@/lib/task-package";

type Db = PrismaClient;

export type EpisodeContextSnapshot = {
  schema: "EPISODE_CONTEXT_SNAPSHOT_V1";
  episodeNumber: number;
  episodeTitle: string;
  episodeSummary: string;
  previousStory: string;
  knownCharacters: string;
  knownRelationships: string;
  knownLocations: string;
  knownProps: string;
  continuity: string;
  sceneSnapshot: ReturnType<typeof buildSceneSnapshot>;
};

export type ProjectMemorySnapshot = {
  schema: "PROJECT_MEMORY_V1";
  projectTitle: string;
  totalEpisodes: number;
  assetIndex: string;
  characterHints: string[];
  relationshipHints: string[];
  episodeTimeline: Array<{
    episodeNumber: number;
    episodeTitle: string;
    summary: string;
  }>;
  preludeContext: Array<{
    episodeNumber: number;
    episodeTitle: string;
    summary: string;
  }>;
};

export async function preprocessProject(projectId: string, db: Db = prisma) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { episodes: { orderBy: { number: "asc" } }, assets: true }
  });
  if (!project) {
    throw new Error("Project not found.");
  }

  const mergedAssets = mergeProjectAssets(
    project.assets.map((asset) => ({
      id: asset.code,
      type: asset.type as DirectorAssetType,
      name: asset.name,
      status: asset.status === "confirmed" ? "confirmed" : "needs_confirmation",
      sourceText: asset.sourceText ?? undefined,
      notes: asset.notes ?? undefined
    })),
    project.episodes.flatMap((episode) => extractEpisodeAssetCandidates(episode.content).all)
  );
  const assets = mergedAssets.map((asset) => asset.type === "STYLE"
    ? { ...asset, name: project.style ?? "未选择画面风格", notes: "项目创建时选择的固定母风格。" }
    : asset.type === "NEG"
      ? { ...asset, name: "通用负面约束", notes: "由最终Python编译阶段统一加入每个Seedance单元。" }
      : asset);
  const memory = buildProjectMemory(project.title, project.episodes, assets);
  const productionEpisodes = project.episodes.filter((episode) => episode.number >= 1);
  const snapshots = productionEpisodes.map((episode) =>
    buildEpisodeContextSnapshot({
      episode,
      // 第0集/无编号前置资料参与上下文，但不生成自己的单集生产快照。
      previousEpisodes: project.episodes.filter((previous) => previous.number < episode.number),
      assets,
      memory
    })
  );
  const episodeScenes = project.episodes.map((episode) => ({
    episodeId: episode.id,
    scenes: extractScriptScenes(episode.number, episode.content)
  }));

  await db.$transaction(async (tx) => {
    for (const asset of assets) {
      await tx.asset.upsert({
        where: { projectId_code: { projectId, code: asset.id } },
        create: {
          projectId,
          episodeId: null,
          code: asset.id,
          type: asset.type as AssetType,
          name: asset.name,
          status: asset.status,
          sourceText: asset.sourceText,
          notes: asset.notes,
          metadata: JSON.stringify(asset, null, 2)
        },
        update: {
          name: asset.name,
          status: asset.status,
          sourceText: asset.sourceText,
          notes: asset.notes,
          metadata: JSON.stringify(asset, null, 2)
        }
      });
    }

    await tx.sceneSnapshot.deleteMany({
      where: {
        projectId,
        sceneKey: {
          in: [
            "PROJECT_MEMORY",
            ...project.episodes.map((episode) => `EP-${episode.number}-CONTEXT`)
          ]
        }
      }
    });

    await tx.sceneSnapshot.create({
      data: {
        projectId,
        episodeId: null,
        sceneKey: "PROJECT_MEMORY",
        title: "全剧记忆快照",
        content: JSON.stringify(memory, null, 2),
        metadata: JSON.stringify({ schema: memory.schema })
      }
    });

    for (const snapshot of snapshots) {
      const episode = project.episodes.find((item) => item.number === snapshot.episodeNumber);
      await tx.sceneSnapshot.create({
        data: {
          projectId,
          episodeId: episode?.id,
          sceneKey: `EP-${snapshot.episodeNumber}-CONTEXT`,
          title: `第${snapshot.episodeNumber}集上下文快照`,
          content: JSON.stringify(snapshot, null, 2),
          metadata: JSON.stringify({ schema: snapshot.schema })
        }
      });
    }

    for (const entry of episodeScenes) {
      const sceneKeys = entry.scenes.map((scene) => scene.sceneKey);
      await tx.scriptScene.deleteMany({
        where: {
          episodeId: entry.episodeId,
          sceneKey: { notIn: sceneKeys },
          shots: { none: {} },
          units: { none: {} }
        }
      });
      for (const scene of entry.scenes) {
        await tx.scriptScene.upsert({
          where: { episodeId_sceneKey: { episodeId: entry.episodeId, sceneKey: scene.sceneKey } },
          create: {
            episodeId: entry.episodeId,
            sceneKey: scene.sceneKey,
            sortOrder: scene.sortOrder,
            heading: scene.heading,
            location: scene.location,
            interiorExterior: scene.interiorExterior,
            timeOfDay: scene.timeOfDay,
            weather: scene.weather,
            timeLayer: scene.timeLayer,
            sourceText: scene.sourceText,
            metadata: JSON.stringify(scene.metadata)
          },
          update: {
            sortOrder: scene.sortOrder,
            heading: scene.heading,
            location: scene.location,
            interiorExterior: scene.interiorExterior,
            timeOfDay: scene.timeOfDay,
            weather: scene.weather,
            timeLayer: scene.timeLayer,
            sourceText: scene.sourceText,
            metadata: JSON.stringify(scene.metadata)
          }
        });
      }
    }
  });

  return { assets, memory, snapshots, episodeScenes };
}

export function mergeProjectAssets(existing: DirectorAsset[], incoming: DirectorAsset[]) {
  const merged: DirectorAsset[] = [...existing];
  const byTypeName = new Set(merged.map((asset) => `${asset.type}:${asset.name}`));

  for (const type of DIRECTOR_ASSET_TYPES) {
    const typeAssets = incoming.filter((asset) => asset.type === type);
    for (const asset of typeAssets) {
      const key = `${asset.type}:${asset.name}`;
      if (byTypeName.has(key)) continue;
      const sameTypeExisting = merged.filter((item) => item.type === type);
      merged.push({
        ...asset,
        id: nextAssetId(type, sameTypeExisting),
        status: asset.status ?? "needs_confirmation"
      });
      byTypeName.add(key);
    }
  }

  return merged;
}

function nextAssetId(type: DirectorAssetType, existing: DirectorAsset[]) {
  const max = existing.reduce((value, asset) => {
    const match = asset.id.match(new RegExp(`^${type}-(\\d+)$`));
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  return `${type}-${String(max + 1).padStart(3, "0")}`;
}

function buildProjectMemory(
  projectTitle: string,
  episodes: Array<{ number: number; title: string | null; content: string }>,
  assets: DirectorAsset[]
): ProjectMemorySnapshot {
  const productionEpisodes = episodes.filter((episode) => episode.number >= 1);
  const preludeEpisodes = episodes.filter((episode) => episode.number < 1);
  return {
    schema: "PROJECT_MEMORY_V1",
    projectTitle,
    totalEpisodes: productionEpisodes.length,
    assetIndex: formatAssetIndex(assets),
    characterHints: assets.filter((asset) => asset.type === "CH").map((asset) => `${asset.id} ${asset.name}：${asset.notes ?? "身份待确认"}`),
    relationshipHints: inferRelationships(episodes.map((episode) => episode.content).join("\n")),
    episodeTimeline: productionEpisodes.map((episode) => ({
      episodeNumber: episode.number,
      episodeTitle: episode.title ?? `第${episode.number}集`,
      summary: summarizeText(episode.content)
    })),
    preludeContext: preludeEpisodes.map((episode) => ({
      episodeNumber: episode.number,
      episodeTitle: episode.title ?? `前置资料（第${episode.number}集）`,
      summary: summarizeText(episode.content)
    }))
  };
}

function buildEpisodeContextSnapshot(input: {
  episode: { number: number; title: string | null; content: string };
  previousEpisodes: Array<{ number: number; title: string | null; content: string }>;
  assets: DirectorAsset[];
  memory: ProjectMemorySnapshot;
}): EpisodeContextSnapshot {
  const { episode, previousEpisodes, assets, memory } = input;
  const previousStory = previousEpisodes
    .slice(-5)
    .map((item) => `${item.number >= 1 ? `第${item.number}集` : `前置资料（第${item.number}集）`}：${summarizeText(item.content, 120)}`)
    .join("\n");
  const sceneSnapshot = buildSceneSnapshot({ sceneText: episode.content, assets });

  return {
    schema: "EPISODE_CONTEXT_SNAPSHOT_V1",
    episodeNumber: episode.number,
    episodeTitle: episode.title ?? `第${episode.number}集`,
    episodeSummary: summarizeText(episode.content, 180),
    previousStory: previousStory || "本集为开篇或暂无前情。",
    knownCharacters: formatAssetIndex(assets.filter((asset) => asset.type === "CH")),
    knownRelationships: memory.relationshipHints.join("；") || "人物关系待确认",
    knownLocations: formatAssetIndex(assets.filter((asset) => asset.type === "LOC")),
    knownProps: formatAssetIndex(assets.filter((asset) => asset.type === "PROP")),
    continuity: buildContinuityHint(previousEpisodes, episode.content),
    sceneSnapshot
  };
}

function summarizeText(text: string, maxLength = 160) {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10)
    .join(" / ");
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized || "待确认";
}

function inferRelationships(text: string) {
  const hints = new Set<string>();
  const patterns = [
    /([\u4e00-\u9fa5]{2,4})的(母亲|父亲|儿子|女儿|妻子|丈夫|师父|师姐|爷爷|奶奶|老板|助理)/g,
    /(母亲|父亲|儿子|女儿|妻子|丈夫|师父|师姐|爷爷|奶奶|老板|助理)([\u4e00-\u9fa5]{2,4})/g,
    /([\u4e00-\u9fa5]{2,4})叫([\u4e00-\u9fa5]{2,4})(妈妈|爸爸|师父|爷爷|奶奶|老婆|老公)/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      hints.add(match[0]);
      if (hints.size >= 20) return [...hints];
    }
  }
  return [...hints];
}

function buildContinuityHint(previousEpisodes: Array<{ number: number; content: string }>, currentText: string) {
  const previous = previousEpisodes.at(-1);
  const currentRisk = /回忆|闪回|与此同时|多年后|第二天|醒来|赶到|回到|继续/.test(currentText)
    ? "本集含时间/地点连续性风险，生成前需锁当前可见状态。"
    : "按本集源文建立当前可见状态。";
  const previousLabel = previous ? previous.number >= 1 ? `第${previous.number}集` : `前置资料（第${previous.number}集）` : "";
  return previous ? `承接${previousLabel}结果；${currentRisk}` : currentRisk;
}
