/** Browser-safe presentation only: no source text, database identity or numbering is changed. */
const DIGITS: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 };
const halfWidth = (value: string) => value.replace(/[０-９Ａ-Ｚａ-ｚ]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xfee0));
const safeNumber = (value: number) => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function parseEpisodeNumber(value: string): number | null {
  const compact = halfWidth(value).trim();
  if (!compact) return null;
  if (/^\d+$/.test(compact)) return safeNumber(Number(compact));
  const repeated = /^([零〇一二两三四五六七八九十百千]+)(\d+)$/.exec(compact);
  if (repeated) {
    const chinese = parseEpisodeNumber(repeated[1]), arabic = safeNumber(Number(repeated[2]));
    return chinese !== null && chinese === arabic ? chinese : null;
  }
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(compact)) return null;
  if ([...compact].every(character => character in DIGITS)) return safeNumber(Number([...compact].map(character => DIGITS[character]).join("")));
  let total = 0, previousUnit = 10000, digit: number | null = null;
  for (const character of compact) {
    if (character in DIGITS) {
      if (digit !== null && digit !== 0) return null;
      digit = DIGITS[character];
    } else {
      const unit = UNITS[character];
      if (unit >= previousUnit || digit === 0) return null;
      total += (digit ?? 1) * unit;
      previousUnit = unit;
      digit = null;
    }
  }
  return safeNumber(total + (digit ?? 0));
}

const NORMALIZATION_NOTE = /（原集号(?:为第[^）]*?集，不是有效集号|与前文重复)，已自动整理为第\d+集）/g;
const DIVIDERS = /^[\s:：·・•.．、—–－\-|｜]+/u;
const HEADER = /^(?:第\s*([0-9零〇一二两三四五六七八九十百千]+)\s*集|EP(?:ISODE)?\s*([0-9]+))(?=$|[\s:：·・•.．、—–－\-|｜])/iu;
const cleanText = (title: string | null | undefined) => (title ?? "").replace(NORMALIZATION_NOTE, "").replace(/\s+/g, " ").trim();

function titleHeader(title: string) {
  // Width folding is one character to one character, so slicing preserves the actual subtitle.
  const match = HEADER.exec(halfWidth(title));
  if (!match) return null;
  const number = parseEpisodeNumber(match[1] ?? match[2]);
  return number === null ? null : { number, rest: title.slice(match[0].length).replace(DIVIDERS, "").trim() };
}

/** Compatibility cleanup for existing callers, without concealing a different title number. */
export function cleanEpisodeTitle(title: string | null | undefined, fallbackNumber?: number): string {
  const cleaned = cleanText(title), header = titleHeader(cleaned);
  if (fallbackNumber !== undefined && header?.number === fallbackNumber && /^(?:页眉|标题|正文)?$/.test(header.rest)) return `第${fallbackNumber}集`;
  return cleaned || (fallbackNumber === undefined ? "未命名集" : `第${fallbackNumber}集`);
}

export type EpisodePresentation = {
  numberLabel: string;
  subtitle: string;
  fullTitle: string;
  navigationTitle: string;
  conflict: boolean;
  sourceNumber: number | null;
};

// Only hide an unambiguous numbered scene heading, never an ordinary story title.
const SCENE_HEADING = /^(?:(?:场\s*)?\d+(?:\s*[.\-]\s*\d+)?|第\s*[0-9零〇一二两三四五六七八九十百千]+\s*场)\s*[:：、,，]?\s*(?:日|夜|清晨|早晨|上午|中午|下午|傍晚|黄昏|晚上|深夜|凌晨)\s*[,，、/／|｜\-—:：\s]\s*(?:内外|外内|内|外)(?=$|[,，、/／|｜\-—:：\s])/u;

export function episodePresentation(number: number, title: string | null | undefined, options?: { sceneCount?: number | null }): EpisodePresentation {
  const numberLabel = `第${number}集`, cleaned = cleanText(title), header = titleHeader(cleaned);
  const sourceNumber = header?.number ?? null, conflict = sourceNumber !== null && sourceNumber !== number;
  const candidate = header && !conflict ? header.rest : DIVIDERS.test(cleaned) && !cleaned.replace(DIVIDERS, "") ? "" : cleaned;
  const subtitle = options && !conflict && SCENE_HEADING.test(halfWidth(candidate).replace(/．/g, ".").replace(/－/g, "-")) ? "" : candidate;
  const navigationTitle = subtitle ? `${subtitle}${conflict ? "（集号冲突）" : ""}` : numberLabel;
  const count = options?.sceneCount;
  const entryLabel = options ? `${numberLabel} · ${typeof count === "number" && Number.isSafeInteger(count) && count > 0 ? `${count}场` : "场次待识别"}` : numberLabel;
  return { numberLabel, subtitle, fullTitle: subtitle ? `${entryLabel} · ${navigationTitle}` : entryLabel, navigationTitle, conflict, sourceNumber };
}
