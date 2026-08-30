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

export function parseScriptContent(sourceName: string, text: string): ImportedScript {
  return {
    sourceName,
    episodes: splitEpisodes(text)
  };
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

  return matches.map((match, index) => {
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
}

export function parseEpisodeNumber(value: string): number | null {
  const compact = value.trim();
  if (/^\d+$/.test(compact)) {
    return Number(compact);
  }

  return parseChineseNumber(compact);
}

const EPISODE_NORMALIZATION_NOTE = /（原集号(?:为第[^）]*?集，不是有效集号|与前文重复)，已自动整理为第\d+集）/g;
const GENERIC_EPISODE_TITLE = /^第\s*(?:\d+|[零〇一二两三四五六七八九十百]+)\s*集(?:\s*(?:页眉|标题|正文))?$/;

/** 仅清理界面标题中的系统规范化说明，保留数据库里的原始导入信息。 */
export function cleanEpisodeTitle(title: string | null | undefined, fallbackNumber?: number) {
  const cleaned = (title ?? "").replace(EPISODE_NORMALIZATION_NOTE, "").replace(/\s{2,}/g, " ").trim();
  // 原稿的“第0集”或重复“第1集”只代表页眉，不应覆盖已经整理后的正式集号。
  if (fallbackNumber && GENERIC_EPISODE_TITLE.test(cleaned)) return `第${fallbackNumber}集`;
  return cleaned || (fallbackNumber ? `第${fallbackNumber}集` : "未命名集");
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
