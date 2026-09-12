import type { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  DIRECTOR_ASSET_TYPES,
  formatAssetIndex,
  type DirectorAsset,
  type DirectorAssetType
} from "@/lib/assets";
import { prisma } from "@/lib/prisma";
import { buildSourceIndex } from "@/lib/project-foundation-contracts";
import { parseSceneBatch } from "@/lib/source-parser";
import { readSceneSplitPlans } from "@/lib/scene-split-plan";
import { readSceneParserVersions } from "@/lib/scene-parser-version";
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
};

export type PreprocessOptions = { checkCurrent?: (tx: PrismaClient) => Promise<void> };

export async function preprocessProject(projectId: string, db: Db = prisma, options: PreprocessOptions = {}) {
  const project = await db.project.findUnique({
    where: { id: projectId },
    include: { episodes: { orderBy: { number: "asc" } } }
  });
  if (!project) {
    throw new Error("Project not found.");
  }

  if (project.episodes.length === 0) {
    const imported = await db.sceneSnapshot.findFirst({ where: { projectId, sceneKey: "SOURCE_IMPORT" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
    const sourceVersion = crypto.createHash("sha256").update(imported?.content ?? "NO_SOURCE_IMPORT", "utf8").digest("hex");
    const source = {
      schema: "FOUNDATION_SOURCE_IMPORT_ONLY_V1",
      sourceVersion,
      message: "未识别到可安全建立的正剧分集；P0 已保留读取原文与来源分区，待人工划分后再进入分集处理。",
      sourceImportSnapshotId: imported?.id ?? null
    };
    await db.$transaction(async (tx) => {
      if (options.checkCurrent) await options.checkCurrent(tx as unknown as PrismaClient);
      const currentImport = await tx.sceneSnapshot.findFirst({ where: { projectId, sceneKey: "SOURCE_IMPORT" }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
      if (await tx.episode.count({ where: { projectId } }) || currentImport?.id !== imported?.id
        || crypto.createHash("sha256").update(currentImport?.content ?? "NO_SOURCE_IMPORT", "utf8").digest("hex") !== sourceVersion) throw new Error("导入原文已变化，请重新读取后重试预处理。");
      const previous = await tx.sceneSnapshot.findFirst({ where: { projectId, sceneKey: "FOUNDATION_SOURCE" }, orderBy: { createdAt: "desc" } });
      const data = { projectId, episodeId: null, sceneKey: "FOUNDATION_SOURCE", title: "导入原文待人工划分", content: JSON.stringify(source, null, 2), metadata: JSON.stringify({ schema: source.schema, sourceVersion: source.sourceVersion }) };
      if (previous) await tx.sceneSnapshot.update({ where: { id: previous.id }, data });
      else await tx.sceneSnapshot.create({ data });
    });
    return { source, episodeScenes: [] };
  }

  // SOURCE 的边界是数据库内 Episode.content，不是导入前的 docx 文件字节。
  const sourceIndex = buildSourceIndex(project.episodes);
  const sceneParserVersions = await readSceneParserVersions(projectId, db, project.episodes);
  const source = {
    schema: "FOUNDATION_SOURCE_V1",
    sourceVersion: sourceIndex.version,
    sourceIndex,
    sceneParserVersions,
    sourceRefs: sourceIndex.episodes.map((episode) => ({
      episode: episode.number,
      startLine: 1,
      endLine: episode.lineCount
    }))
  };
  const splitPlans = await readSceneSplitPlans(projectId, db);
  const splitEpisodes = new Set(splitPlans.map(plan => plan.episode));
  const parsedScenes = new Map(parseSceneBatch(project.episodes.map((episode) => ({ number: episode.number, content: episode.content })), splitPlans, { versions: sceneParserVersions }).map((entry) => [entry.episodeNumber, entry.scenes]));
  const episodeScenes = project.episodes.map((episode) => ({ episodeId: episode.id, episodeContent: episode.content, scenes: parsedScenes.get(episode.number) ?? [] }));

  await db.$transaction(async (tx) => {
    if (options.checkCurrent) await options.checkCurrent(tx as unknown as PrismaClient);
    // Parsing happened before this transaction; reject a stale source or split-plan snapshot before any write.
    const currentEpisodes = await tx.episode.findMany({ where: { projectId }, orderBy: { number: "asc" } });
    if (!currentEpisodes.length || buildSourceIndex(currentEpisodes).version !== sourceIndex.version) throw new Error("分集原文已变化，请重新读取后重试预处理。");
    const currentPlans = await readSceneSplitPlans(projectId, tx);
    if (currentPlans.length !== splitPlans.length || splitPlans.some(plan => !currentPlans.some(current => isDeepStrictEqual(current, plan)))) throw new Error("拆场计划已变化，请重新读取后重试预处理。");
    if (!isDeepStrictEqual(await readSceneParserVersions(projectId, tx, currentEpisodes), sceneParserVersions)) throw new Error("场次解析版本已变化，请重新读取后重试预处理。");
    const previousSource = await tx.sceneSnapshot.findFirst({
      where: { projectId, sceneKey: "FOUNDATION_SOURCE" },
      orderBy: { createdAt: "desc" }
    });
    const sourceData = {
      projectId,
      episodeId: null,
      sceneKey: "FOUNDATION_SOURCE",
      title: "分集原文与行导航",
      content: JSON.stringify(source, null, 2),
      metadata: JSON.stringify({ schema: source.schema, sourceVersion: source.sourceVersion })
    };
    const previousVersion = previousSource ? JSON.parse(previousSource.metadata ?? "{}")?.sourceVersion : null;
    if (previousSource && previousVersion === source.sourceVersion) {
      await tx.sceneSnapshot.update({ where: { id: previousSource.id }, data: sourceData });
    } else {
      await tx.sceneSnapshot.create({ data: sourceData });
    }

    for (const entry of episodeScenes) {
      const existingScenes = new Map((await tx.scriptScene.findMany({
        where: { episodeId: entry.episodeId },
        select: { id: true, sceneKey: true, sortOrder: true, sourceText: true, metadata: true, shots: { select: { id: true } }, units: { select: { id: true } } }
      })).map((scene) => [scene.sceneKey, scene]));
      const activeKeys = new Set(entry.scenes.map((scene) => scene.sceneKey));
      for (const [sceneKey, existing] of existingScenes) {
        if (activeKeys.has(sceneKey)) continue;
        const metadata = parseMetadata(existing.metadata);
        if (isRetirableProgramScene(existing, metadata)) {
          await tx.sceneSnapshot.create({ data: { projectId, episodeId: entry.episodeId, sceneKey: `RETIRED_P0_SCENE-${sceneKey}`, title: `${sceneKey} 旧 P0 场次快照`, content: existing.sourceText, metadata: JSON.stringify({ schema: "RETIRED_P0_SCENE_V1", sceneKey, metadata }) } });
          await tx.scriptScene.delete({ where: { id: existing.id } });
          continue;
        }
        const noticeKey = `P0_SCENE_RETENTION-${sceneKey}`;
        const noticed = await tx.sceneSnapshot.findFirst({ where: { projectId, episodeId: entry.episodeId, sceneKey: noticeKey } });
        if (!noticed) await tx.sceneSnapshot.create({ data: { projectId, episodeId: entry.episodeId, sceneKey: noticeKey, title: `${sceneKey} 场次保留说明`, content: JSON.stringify({ code: "P0_SCENE_RETENTION_BLOCKED", message: "当前场次已不在固定来源解析结果中，但含人工标注、补丁或下游材料，P0 未删除。", sceneKey }) } });
      }
      for (const scene of entry.scenes) {
        const existing = existingScenes.get(scene.sceneKey);
        const sourceHash = crypto.createHash("sha256").update(scene.sourceText, "utf8").digest("hex");
        const previousMetadata = parseMetadata(existing?.metadata ?? "{}");
        // A row without our exact source hash is human/legacy material.  P0 may add
        // missing scenes, but must not overwrite or erase that material.
        const legacyProgramRow = Boolean(existing) && isLegacyProgramScene(existing!, entry.episodeContent, previousMetadata);
        if (existing && !legacyProgramRow && (previousMetadata.sourceHash !== crypto.createHash("sha256").update(existing.sourceText, "utf8").digest("hex") || previousMetadata.sourceHash === sourceHash)) {
          if (splitEpisodes.has(project.episodes.find(episode => episode.id === entry.episodeId)!.number) && previousMetadata.sourceHash === sourceHash
            && existing.sourceText === scene.sourceText && existing.sortOrder !== scene.sortOrder) await tx.scriptScene.update({ where: { id: existing.id }, data: { sortOrder: scene.sortOrder } });
          continue;
        }
        const metadata = JSON.stringify({ ...previousMetadata, ...scene.metadata, sourceHash });
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
            metadata
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
            metadata
          }
        });
      }
    }
  });

  return { source, episodeScenes };
}

/** Old P0 had only parser-owned characters/props metadata and no provenance hash.
 * This deliberately narrow proof allows a one-time column repair without treating
 * manually annotated legacy scenes as safe to rewrite. */
function isLegacyProgramScene(
  scene: { sourceText: string; shots: { id: string }[]; units: { id: string }[] },
  episodeContent: string,
  metadata: Record<string, unknown>
) {
  const keys = Object.keys(metadata);
  return keys.length > 0
    && keys.every((key) => key === "characters" || key === "props")
    && scene.shots.length === 0
    && scene.units.length === 0
    && normalizeSourceText(scene.sourceText).length > 0
    && normalizeSourceText(episodeContent).includes(normalizeSourceText(scene.sourceText));
}

function isRetirableProgramScene(scene: { sourceText: string; metadata: string; shots: { id: string }[]; units: { id: string }[] }, metadata: Record<string, unknown>) {
  const keys = Object.keys(metadata);
  const pureLegacy = keys.length > 0 && keys.every((key) => key === "characters" || key === "props");
  const generated = metadata.sourceFieldPatch === undefined
    && metadata.sourceHash === crypto.createHash("sha256").update(scene.sourceText, "utf8").digest("hex")
    && keys.every((key) => ["characters", "props", "sourceHash", "sourceSceneKey", "sceneKeyAmbiguous"].includes(key));
  return (pureLegacy || generated) && scene.shots.length === 0 && scene.units.length === 0;
}

function parseMetadata(value: string) {
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}; } catch { return {}; }
}

function normalizeSourceText(value: string) {
  return value.replace(/\r\n?/g, "\n").trim();
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
  return {
    schema: "PROJECT_MEMORY_V1",
    projectTitle,
    totalEpisodes: episodes.length,
    assetIndex: formatAssetIndex(assets),
    characterHints: assets.filter((asset) => asset.type === "CH").map((asset) => `${asset.id} ${asset.name}：${asset.notes ?? "身份待确认"}`),
    relationshipHints: inferRelationships(episodes.map((episode) => episode.content).join("\n")),
    episodeTimeline: episodes.map((episode) => ({
      episodeNumber: episode.number,
      episodeTitle: episode.title ?? `第${episode.number}集`,
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
    .map((item) => `第${item.number}集：${summarizeText(item.content, 120)}`)
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
  return previous ? `承接第${previous.number}集结果；${currentRisk}` : currentRisk;
}
