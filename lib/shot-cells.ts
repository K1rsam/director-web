/**
 * 6 格合并规则（唯一事实源）：画面/机位运镜/声音/转场 各岗位在同一批格子上接力。
 * 页面显示（lib/studio.ts）与 Seedance 编译（lib/episode-pipeline.ts）共用本模块，
 * 保证"分镜表上看到什么，编译出来的提示词就是什么"。
 *
 * 岗位字段存储（E3/E4 职责对调后）：
 *   e3 = 单元视听（sound/transition 定稿）
 *   e4 = 摄影光影（camera_motion/lighting 定稿）
 */

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
    .replace(/（[^）]*）$/, "")
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
