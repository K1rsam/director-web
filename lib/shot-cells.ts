/**
 * 6 格合并规则（唯一事实源）：画面/机位运镜/声音/转场 各岗位在同一批格子上接力。
 * 页面显示（lib/studio.ts）与 Seedance 编译（lib/episode-pipeline.ts）共用本模块，
 * 保证"分镜表上看到什么，编译出来的提示词就是什么"。
 *
 * 岗位字段存储（E3/E4 职责对调后）：
 *   e3 = 单元视听（sound/transition 定稿）
 *   e4 = 摄影光影（camera_motion/lighting 定稿）
 */

import { splitInlineSourceLine, type SourceNode } from "@/lib/episode-pipeline-contracts";

type CellRecord = Record<string, unknown>;

function firstText(record: CellRecord | undefined, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      // 模型偶尔在字符串里带换行：压成一句，避免表格单元竖排/编译稿断裂
      return value.replace(/\s*\n\s*/g, "；").replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

/** 画面格子：E2 表演画面 → E1 画面/画面目标 为基础，E4 光影追加（不覆盖基础画面）。
 *  unitLighting（单元级光影，E4 在 E3 后按单元写）：镜级 e4.lighting 优先，无则用单元级兜底。 */
export function composePicture(e1: CellRecord, e2: CellRecord, e4: CellRecord, unitLighting?: string | null): string {
  const base = firstText(e2, ["picture"]) ?? firstText(e1, ["picture", "visual_goal"]) ?? "待补充";
  const lighting = firstText(e4, ["lighting"]) ?? unitLighting ?? null;
  if (lighting && !base.includes("光影")) return `${base}；光影：${lighting}`;
  return base;
}

/** 机位运镜格子：E4 正式版覆盖 E1 的 camera_motion / rough_camera 粗稿。 */
export function composeCamera(e1: CellRecord, e4: CellRecord): string {
  return firstText(e4, ["camera_motion"]) ?? firstText(e1, ["camera_motion", "rough_camera"]) ?? "待补充";
}

/** 声音格子：E3 覆盖 E1 的粗稿。 */
export function composeSound(e1: CellRecord, e3: CellRecord): string {
  return firstText(e3, ["sound"]) ?? firstText(e1, ["sound"]) ?? "无";
}

/** 转场格子：E3 覆盖 E1 的粗稿。 */
export function composeTransition(e1: CellRecord, e3: CellRecord): string {
  return firstText(e3, ["transition"]) ?? firstText(e1, ["transition"]) ?? "硬切";
}

/** 说话人显示清洗：去尾部（情绪/备注）、去"内心"口头标记（OS 承载者）。 */
export function cleanSpeakerLabel(speaker: string): string {
  return String(speaker ?? "")
    .replace(/[（(][^）)]*[）)]$/, "")
    .replace(/内心$/, "")
    .trim();
}

/**
 * 台词列统一格式（唯一事实源）：
 * - 对白（角色开口说话）：`说话人：“内容”`（带中文引号）；
 * - OS（内心独白）：`说话人（内心）：内容`（不带引号）；
 * - VO（画外音）：`说话人（画外）：内容`（不带引号）；
 * - 旁白：`旁白：内容`；
 * - 字幕/系统等其余类型保持原文。
 */
export function formatDialogueEntry(entry: CellRecord): string {
  const speaker = cleanSpeakerLabel(String(entry.speaker ?? ""));
  const text = String(entry.text ?? "");
  const type = String(entry.type ?? "对白");
  if (type === "对白") return `${speaker}：“${text}”`;
  if (type === "OS") return `${speaker}（内心）：${text}`;
  if (type === "VO") return `${speaker}（画外）：${text}`;
  if (type === "旁白") return `旁白：${text}`;
  return `${speaker}：${text}`;
}

/** 表格展示台词时逐条换行，避免多个人物挤成一条难以辨认的长句。 */
export function formatDialogueEntries(entries: ReadonlyArray<CellRecord>): string {
  return entries.map(formatDialogueEntry).filter(Boolean).join("\n");
}

const DIALOGUE_SOURCE_TYPES = new Set(["DIALOGUE", "OS", "VO", "NARRATION", "SYSTEM"]);

function knownSpeakersOf(sourceNodes: readonly SourceNode[]): string[] {
  return [...new Set(sourceNodes.map((node) => String(node.speaker ?? "").trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
}

function sourceTypeToDialogueType(type: SourceNode["type"]): string {
  return type === "DIALOGUE" ? "对白" : type;
}

function sourceNodeForText(text: string, sourceNodes: readonly SourceNode[]): SourceNode | null {
  const clean = text.trim();
  if (!clean) return null;
  let best: { node: SourceNode; score: number } | null = null;
  for (const [index, node] of sourceNodes.entries()) {
    const nodeText = node.text.trim();
    if (!nodeText) continue;
    const score = nodeText === clean
      ? 1000 - index
      : nodeText.includes(clean)
        ? 700 - index
        : clean.includes(nodeText)
          ? 500 - index
          : -1;
    if (score >= 0 && (!best || score > best.score)) best = { node, score };
  }
  return best?.node ?? null;
}

function looksLikeUnlabelledAction(text: string): boolean {
  return !/[！？!?“”"「」]/.test(text) && /(?:低头|抬头|沉思|站在|坐在|看向|看着|走向|转身|点头|摇头|皱眉|笑着|哭着|喊道|开口|闭嘴|拿出|掏出|指向|盯着|望向|倚在|轻声|冷声)/.test(text);
}

/** 说话人只在源节点前文出现、动作本身没有“：”时，按 ACTION 源节点后缀切开。 */
function splitByActionSourceNodes(text: string, sourceNodes: readonly SourceNode[]): string[] {
  let current = text.trim();
  const result: string[] = [];
  const actions = sourceNodes
    .filter((node) => node.type === "ACTION" && node.text.trim())
    .sort((a, b) => b.text.trim().length - a.text.trim().length);
  while (current) {
    const action = actions.find((node) => {
      const actionText = node.text.trim();
      const index = current.lastIndexOf(actionText);
      return index > 0 && index + actionText.length === current.length && /[。！？；!?]/.test(current[index - 1]);
    });
    if (!action) {
      result.push(current);
      break;
    }
    const actionText = action.text.trim();
    const index = current.lastIndexOf(actionText);
    const prefix = current.slice(0, index).trim();
    if (prefix) result.push(prefix);
    result.push(actionText);
    current = "";
  }
  return result.length ? result : [text];
}

function parseInlineDialoguePiece(piece: string, knownSpeakers: readonly string[]) {
  const match = piece.match(/^([^：:]{1,60})[:：]\s*([\s\S]*)$/);
  if (!match) return null;
  const rawLabel = match[1].trim();
  const voice = rawLabel.match(/^(.*?)\s*(?:[（(]\s*(OS|VO)\s*[）)]|(OS|VO))\s*$/i);
  const label = (voice?.[1] ?? rawLabel).trim();
  const speaker = knownSpeakers.find((name) => label.startsWith(name));
  // 普通内容里的“任务：/地点：”等冒号不是人物台词标签，必须保留原文，
  // 否则兼容层会把任务说明误删成只有冒号后半句。
  if (!speaker) return null;
  return {
    speaker,
    type: (voice?.[2] ?? voice?.[3])?.toUpperCase() ?? "对白",
    text: match[2].trim()
  };
}

/**
 * 旧版本已经把多个人物台词写进同一条 dialogue 时，页面/编译层做一次零 Token 纠正。
 * 优先用当前场次重新解析出的源节点认领说话人，因此不会继续沿用错误的首个 speaker。
 */
export function normalizeDialogueEntriesForSource(
  entries: ReadonlyArray<CellRecord>,
  sourceNodes: readonly SourceNode[]
): Array<Record<string, unknown>> {
  if (!sourceNodes.length) return entries.map((entry) => ({ ...entry }));
  const knownSpeakers = knownSpeakersOf(sourceNodes);
  return entries.flatMap((entry) => {
    const rawText = String(entry.text ?? "").trim();
    if (!rawText) return [{ ...entry }];
    const pieces = splitInlineSourceLine(rawText, knownSpeakers)
      .flatMap((piece) => splitByActionSourceNodes(piece, sourceNodes));
    return pieces.flatMap((piece) => {
      const parsed = parseInlineDialoguePiece(piece, knownSpeakers);
      const text = parsed?.text ?? piece.trim();
      const matched = sourceNodeForText(text, sourceNodes);
      // 行内拆分产生的前缀可能只是动作（如“姜恋低头沉思。”），不应塞进台词格。
      if (matched?.type === "ACTION") return [];
      if (!matched && !parsed && looksLikeUnlabelledAction(text)) return [];
      if (matched && DIALOGUE_SOURCE_TYPES.has(matched.type)) {
        return [{
          ...entry,
          source_node_id: matched.source_node_id,
          speaker: matched.speaker ?? parsed?.speaker ?? entry.speaker ?? "",
          type: sourceTypeToDialogueType(matched.type),
          text
        }];
      }
      if (parsed) return [{ ...entry, speaker: parsed.speaker, type: parsed.type, text }];
      return [{ ...entry, text }];
    });
  });
}

export interface ShotCellInput {
  e1: CellRecord;
  e2: CellRecord;
  /** 单元视听字段（sound/transition） */
  e3: CellRecord;
  /** 摄影光影字段（camera_motion/lighting） */
  e4: CellRecord;
}

/** 一张镜行的 6 格内容（时长与台词由调用方提供）。unitLighting 为单元级光影兜底（可选）。 */
export function composeShotCells(shot: ShotCellInput, unitLighting?: string | null) {
  return {
    picture: composePicture(shot.e1, shot.e2, shot.e4, unitLighting),
    camera_motion: composeCamera(shot.e1, shot.e4),
    sound: composeSound(shot.e1, shot.e3),
    transition: composeTransition(shot.e1, shot.e3)
  };
}
