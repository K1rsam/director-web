import { readFile } from "node:fs/promises";
import path from "node:path";
import mammoth from "mammoth";

export type ImportedEpisode = {
  number: number;
  title: string;
  content: string;
};

export type ImportedScript = {
  sourceName: string;
  episodes: ImportedEpisode[];
};

const EPISODE_HEADING = /(?:^|\n)\s*第\s*([0-9零〇一二两三四五六七八九十百]+)\s*集[^\n\r]*/g;

export async function parseScriptFile(filePath: string): Promise<ImportedScript> {
  const ext = path.extname(filePath).toLowerCase();
  const sourceName = path.basename(filePath);
  const text = await readScriptText(filePath, ext);

  return parseScriptContent(sourceName, text);
}

export async function parseScriptBuffer(sourceName: string, buffer: Buffer): Promise<ImportedScript> {
  const ext = path.extname(sourceName).toLowerCase();
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer });
    return parseScriptContent(sourceName, result.value);
  }

  if (ext === ".txt" || ext === ".md") {
    return parseScriptContent(sourceName, buffer.toString("utf8"));
  }

  throw new Error(`Unsupported script file type: ${ext || "unknown"}`);
}

export function parseScriptContent(sourceName: string, text: string): ImportedScript {
  return {
    sourceName,
    episodes: splitEpisodes(text)
  };
}

export async function readScriptText(filePath: string, ext = path.extname(filePath).toLowerCase()) {
  if (ext === ".txt" || ext === ".md") {
    return readFile(filePath, "utf8");
  }

  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }

  throw new Error(`Unsupported script file type: ${ext || "unknown"}`);
}

export function splitEpisodes(text: string): ImportedEpisode[] {
  const normalized = text.replace(/\r\n?/g, "\n").trim();

  if (!normalized) {
    return [
      {
        number: 1,
        title: "第1集",
        content: ""
      }
    ];
  }

  const matches = [...normalized.matchAll(EPISODE_HEADING)];
  if (matches.length === 0) {
    return [
      {
        number: 1,
        title: "第1集",
        content: normalized
      }
    ];
  }

  const episodes = matches.map((match, index) => {
    const headingStart = match.index ?? 0;
    const contentStart = headingStart + match[0].length;
    const nextStart = matches[index + 1]?.index ?? normalized.length;
    const rawTitle = match[0].trim();
    const numberText = match[1] ?? `${index + 1}`;
    const parsedNumber = parseEpisodeNumber(numberText) ?? index + 1;

    return {
      number: parsedNumber,
      title: rawTitle,
      content: normalized.slice(contentStart, nextStart).trim()
    };
  });

  // 第一条「第X集」之前的剧名、人物小传、剧情梗概等属于前置资料：保留为第0集，
  // 供 P1/P2 理解编剧意图，但不能吞掉或改写后续正式集号。
  const prefix = normalized.slice(0, matches[0]?.index ?? 0).trim();
  if (prefix) {
    const first = episodes[0];
    if (first?.number === 0) {
      episodes[0] = {
        ...first,
        content: [prefix, first.content].filter(Boolean).join("\n\n")
      };
    } else {
      episodes.unshift({
        number: 0,
        title: "前置资料（第0集）",
        content: prefix
      });
    }
  }

  return normalizeEpisodeNumbers(episodes);
}

/**
 * Word/Markdown 导入经常会把页眉里的「第 N 集」重复带入正文，或者用户会把
 * 多段素材暂时标成同一个集号。Episode.projectId_number 是硬唯一约束，因此在落库前
 * 把重复/非法集号稳定地整理成未占用的集号，避免整个项目事务回滚。第0集是合法的
 * 前置资料编号，必须保持为0；已经合法且唯一的显式集号保持不变，只有冲突的后续段落才会顺延。
 */
export function normalizeEpisodeNumbers(episodes: ImportedEpisode[]): ImportedEpisode[] {
  const used = new Set<number>();
  let nextAvailable = 1;
  const normalized: ImportedEpisode[] = [];

  for (const episode of episodes) {
    const candidate = Number.isInteger(episode.number) && episode.number >= 0 ? episode.number : null;

    // 第0集是前置资料，不应因页眉重复而被分配成正式第1集；合并重复的 0，
    // 让正式集号从原稿的第1集继续保持不变。
    if (candidate === 0 && used.has(0)) {
      const existing = normalized.find((item) => item.number === 0);
      if (existing) {
        existing.content = [existing.content, episode.content].filter(Boolean).join("\n\n");
        if (episode.title && !existing.title.includes(episode.title)) {
          existing.title = `${existing.title} / ${episode.title}`;
        }
      }
      continue;
    }

    let number = candidate;
    if (number === null || used.has(number)) {
      while (used.has(nextAvailable)) nextAvailable += 1;
      number = nextAvailable;
    }
    used.add(number);
    nextAvailable = Math.max(nextAvailable, number + 1);

    if (candidate === number) {
      normalized.push({ ...episode });
      continue;
    }

    const adjustmentReason = candidate === null
      ? `原集号${Number.isFinite(episode.number) ? `为第${episode.number}集` : "无效"}，不是有效集号`
      : "原集号与前文重复";

    normalized.push({
      ...episode,
      number,
      title: `${episode.title}（${adjustmentReason}，已自动整理为第${number}集）`
    });
  }

  return normalized;
}

const EPISODE_NORMALIZATION_NOTE = /（原集号(?:为第[^）]*?集，不是有效集号|与前文重复)，已自动整理为第\d+集）/g;
const GENERIC_EPISODE_TITLE = /^第\s*(?:\d+|[零〇一二两三四五六七八九十百]+)\s*集(?:\s*(?:页眉|标题|正文))?$/;

/** 仅清理界面标题中的系统规范化说明，保留数据库里的原始导入信息。 */
export function cleanEpisodeTitle(title: string | null | undefined, fallbackNumber?: number) {
  const cleaned = (title ?? "").replace(EPISODE_NORMALIZATION_NOTE, "").replace(/\s{2,}/g, " ").trim();
  // 标题只展示数据库中保留的正式集号；第0集可以作为前置资料正常显示。
  if (fallbackNumber !== undefined && GENERIC_EPISODE_TITLE.test(cleaned)) return `第${fallbackNumber}集`;
  return cleaned || (fallbackNumber !== undefined ? `第${fallbackNumber}集` : "未命名集");
}

export function parseEpisodeNumber(value: string): number | null {
  const compact = value.trim();
  if (/^\d+$/.test(compact)) {
    return Number(compact);
  }

  return parseChineseNumber(compact);
}

function parseChineseNumber(value: string): number | null {
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };

  if ([...value].every((char) => char in digits)) {
    return Number([...value].map((char) => digits[char]).join(""));
  }

  const tenIndex = value.indexOf("十");
  if (tenIndex >= 0) {
    const before = value.slice(0, tenIndex);
    const after = value.slice(tenIndex + 1);
    const tens = before ? digits[before] : 1;
    const ones = after ? digits[after] : 0;

    if (tens === undefined || ones === undefined) {
      return null;
    }

    return tens * 10 + ones;
  }

  const hundredIndex = value.indexOf("百");
  if (hundredIndex >= 0) {
    const before = value.slice(0, hundredIndex);
    const after = value.slice(hundredIndex + 1);
    const hundreds = before ? digits[before] : 1;
    const rest = after ? parseChineseNumber(after) : 0;

    if (hundreds === undefined || rest === null) {
      return null;
    }

    return hundreds * 100 + rest;
  }

  return null;
}
