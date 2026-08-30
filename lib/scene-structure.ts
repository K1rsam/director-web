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
  const matches = [...text.matchAll(/^(\d+)-(\d+)[ \t]*$/gm)];
  const inlineNumbered = [...text.matchAll(/^(\d+)-(\d+)(?:[ \t]+([^\n]+)|(?=[^\s-])([^\n]+))$/gm)]
    .filter((match) => {
      const heading = (match[3] ?? match[4] ?? "").split(/(?:人物|角色|道具)[:：]|△/)[0].trim();
      // 优先识别标准场头；短且没有中文标点的地点行作为宽松兼容，避免把对白误当场头。
      return /(?:日|夜|晨|午|黄昏|内|外|场景|人物|道具)/.test(heading)
        || (heading.length <= 40 && !/[：:，。！？!?]/.test(heading));
    });
  const numberedHeadings = [
    ...matches.map((match) => ({ match, start: match.index ?? 0, baseKey: `${match[1]}-${match[2]}` })),
    ...inlineNumbered.map((match) => ({ match, start: match.index ?? 0, baseKey: `${match[1]}-${match[2]}` }))
  ].sort((a, b) => a.start - b.start);
  // 先处理带地点的场头，兼容“编号独占一行”和“编号+地点同一行”混用的 docx。
  // 同一基础编号重复出现时追加稳定子序号，不改变正式集数，也不让后续集数顺延。
  if (numberedHeadings.length) {
    const occurrences = new Map<string, number>();
    return numberedHeadings.map((entry, index) => {
      const { match, start, baseKey } = entry;
      const end = numberedHeadings[index + 1]?.start ?? text.length;
      const occurrence = (occurrences.get(baseKey) ?? 0) + 1;
      occurrences.set(baseKey, occurrence);
      const sceneKey = occurrence === 1 ? baseKey : `${baseKey}-${occurrence}`;
      return buildScene(sceneKey, index + 1, text.slice(start, end).trim());
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
  const numberedHeader = lines[0]?.match(/^(\d+-\d+)(?:[ \t]+(.+)|(?=[^\s-])([^\n]+))?$/);
  const inlineHeader = numberedHeader ? parseInlineHeader(numberedHeader[2] ?? numberedHeader[3] ?? "") : null;
  const contentLines = numberedHeader
    ? [
        ...(inlineHeader?.metadataLines ?? []),
        ...(inlineHeader?.bodyText ? [inlineHeader.bodyText] : []),
        ...lines.slice(1)
      ]
    : lines;
  const firstLine = inlineHeader?.heading || contentLines[0] || sceneKey;
  // 新格式首行即「场景 X」标记：heading 落回场次编号，地点取标记名
  const heading = FIELD_LINE.test(firstLine) || isSceneMarkerLine(firstLine)
    ? sceneKey
    : firstLine;
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

function parseInlineHeader(headerText: string): { heading: string; metadataLines: string[]; bodyText: string } {
  const clean = headerText.trim();
  const bodyIndex = clean.indexOf("△");
  const beforeBody = bodyIndex >= 0 ? clean.slice(0, bodyIndex) : clean;
  const metadataStart = beforeBody.search(/(?:人物|角色|道具)[:：]/);
  const heading = (metadataStart >= 0 ? beforeBody.slice(0, metadataStart) : beforeBody).trim();
  const metadataText = metadataStart >= 0 ? beforeBody.slice(metadataStart) : "";
  const metadataLines = [...metadataText.matchAll(/(人物|角色|道具)[:：]\s*(.*?)(?=(?:人物|角色|道具)[:：]|$)/g)]
    .map((match) => `${match[1]}：${match[2].trim()}`)
    .filter((line) => !line.endsWith("："));
  return {
    heading,
    metadataLines,
    bodyText: bodyIndex >= 0 ? clean.slice(bodyIndex + 1).trim() : ""
  };
}

function fieldValue(lines: string[], name: string): string | null {
  const line = lines.find((item) => item.startsWith(`${name}：`) || item.startsWith(`${name}:`));
  return line ? line.replace(new RegExp(`^${name}[:：]`), "").trim() || null : null;
}

function token(text: string, values: string[]): string | null {
  return values.find((value) => new RegExp(`(?:^|[\\s/／])${value}(?=$|[\\s/／])`).test(text)) ?? null;
}

function inferLocation(heading: string): string | null {
  const cleaned = heading
    .replace(/(?:^|[\s/／])(?:日|夜|晨|午|黄昏|内|外|闪回|梦境|想象|暴雨|雨|大雪|雪|薄雾|雾|晴|阴|大风|风)(?=[\s/／]|$)/g, " ")
    .replace(/[\/／]/g, " ")
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
