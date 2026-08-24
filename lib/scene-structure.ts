export type ScriptSceneDraft = {
  sceneKey: string;
  sortOrder: number;
  heading: string;
  location: string | null;
  interiorExterior: string | null;
  timeOfDay: string | null;
  weather: string | null;
  timeLayer: string;
  sourceText: string;
  metadata: Record<string, unknown>;
};

const FIELD_LINE = /^(?:场景|人物|道具)[:：]/;

/** 无编号场头：一行独立的「场景 X」标记（可选冒号），X 为短地点名（不含冒号、≤30 字）。
 *  兼容扁平化导入（丢失 "2-1" 编号场头、冒号被转空格）的剧本，如「场景 觉醒大厅外」。 */
const SCENE_MARKER_LINE = /^场景\s*[:：]?\s*([^\n：:]{1,30})$/;

function isSceneMarkerLine(line: string): boolean {
  return SCENE_MARKER_LINE.test(line.trim());
}

export function extractScriptScenes(episodeNumber: number, raw: string): ScriptSceneDraft[] {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  const matches = [...text.matchAll(/^(\d+)-(\d+)\s*$/gm)];
  if (matches.length) {
    // 编号场头优先（老格式）：2-1 / 2-2 …
    return matches.map((match, index) => {
      const start = match.index ?? 0;
      const end = matches[index + 1]?.index ?? text.length;
      return buildScene(match[0].trim(), index + 1, text.slice(start, end).trim());
    });
  }
  // 新格式（扁平化导入）：按「场景 X」标记行拆分
  const markers = [...text.matchAll(/^场景\s*[:：]?\s*[^\n：:]{1,30}$/gm)];
  if (markers.length) {
    return markers.map((match, index) => {
      const start = match.index ?? 0;
      const end = markers[index + 1]?.index ?? text.length;
      const sceneKey = `${episodeNumber}-${index + 1}`;
      const locationName = (match[0].replace(/^场景\s*[:：]?\s*/, "").trim()) || null;
      return buildScene(sceneKey, index + 1, text.slice(start, end).trim(), locationName);
    });
  }
  return [buildScene(`${episodeNumber}-1`, 1, text)];
}

function buildScene(sceneKey: string, sortOrder: number, sourceText: string, markerLocation: string | null = null): ScriptSceneDraft {
  const lines = sourceText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const contentLines = lines[0] === sceneKey ? lines.slice(1) : lines;
  const firstLine = contentLines[0] ?? sceneKey;
  // 新格式首行即「场景 X」标记：heading 落回场次编号，地点取标记名
  const heading = FIELD_LINE.test(firstLine) || isSceneMarkerLine(firstLine) ? sceneKey : firstLine;
  const location = markerLocation ?? fieldValue(contentLines, "场景") ?? inferLocation(heading);
  const characters = fieldValue(contentLines, "人物");
  const props = fieldValue(contentLines, "道具");

  return {
    sceneKey,
    sortOrder,
    heading,
    location,
    interiorExterior: token(heading, ["内", "外"]),
    timeOfDay: token(heading, ["日", "夜", "晨", "午", "黄昏"]),
    weather: token(heading, ["暴雨", "雨", "大雪", "雪", "薄雾", "雾", "晴", "阴", "大风", "风"]),
    timeLayer: token(heading, ["闪回", "梦境", "想象"]) ?? "现实",
    sourceText,
    metadata: {
      characters: splitNames(characters),
      props: props === "无" ? [] : splitNames(props)
    }
  };
}

function fieldValue(lines: string[], name: string): string | null {
  const line = lines.find((item) => item.startsWith(`${name}：`) || item.startsWith(`${name}:`));
  return line ? line.replace(new RegExp(`^${name}[:：]`), "").trim() || null : null;
}

function token(text: string, values: string[]): string | null {
  return values.find((value) => new RegExp(`(?:^|\\s)${value}(?:\\s|$)`).test(text)) ?? null;
}

function inferLocation(heading: string): string | null {
  const cleaned = heading
    .replace(/(?:^|\s)(?:日|夜|晨|午|黄昏|内|外|闪回|梦境|想象|暴雨|雨|大雪|雪|薄雾|雾|晴|阴|大风|风)(?=\s|$)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function splitNames(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(/[、，,；;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
