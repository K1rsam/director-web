const CLAUSE_BOUNDARY = /[\r\n，,。！？!?；;]+/u;
const AUDIENCE_PREFIX = /(?:对着|朝着|冲着|面对|转向|对|向|朝)\s*$/u;
const SPEECH_CUE = /(?:说话声|说话|在说话|正说着|开口(?:说话|说道|说)?|说道|喊道|问道|答道|说着|说完|说出|发言|回答|回应|低语|耳语|的声音)/u;
const OFFSCREEN_MARKER = "(?:画面外|镜头外|画外|未入镜)";
const ACTION_WORD_SOURCE = "(?:走上|进入|走入|取出|拿出|拿起|抽出|放下|递出|递给|交给|填写|写下|写完|填完|盖下|盖章|按下|抬起|抬头|低头|转身|走出|跑出|起身|坐下|站起|推开|拉开|打开|关闭|举起|握住|松开|看向|望向|点头|摇头|开口|说完|弹出|汇聚|踏出|现身)";
const ACTION_WORD = new RegExp(ACTION_WORD_SOURCE, "u");
const EXECUTED_PREACTION = /(?:走上|进入|走入|按下|拿起|取出|拿出|抽出|放下|递出|递给|交给|弹出|汇聚|踏出|现身|走出|跑出|起身|坐下|站起|推开|拉开|打开|关闭)/u;

export type VisibleTextDeclaration = {
  kind: "DIEGETIC_PROP" | "DIEGETIC_UI";
  carrier: string;
  content: string;
  source_node_id?: string;
};

export type TickRange = { startTick: number; endTick: number };

export type DialogueScheduleEntry = {
  speaker: string;
  text: string;
  type: string;
  startTick: number;
  endTick: number;
};

export type VisibleTextDeclarationValidation =
  | { valid: true; declaration: VisibleTextDeclaration }
  | { valid: false; reason: string };

const VISIBLE_TEXT_FORBIDDEN_CARRIER = /字幕|叠字|人名条|姓名条|地点条|时间条|水印|logo|bgm|歌词|标题条|角标/iu;
const VISIBLE_TEXT_PROMPT_INJECTION = /忽略|指令|提示词|prompt|system|assistant|生成|允许|禁止/iu;
const CONTROL_OR_LINE_BREAK = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;

/** 把十进制秒一次性量化为 0.1 秒 tick，之后只做整数累加，消除浮点漂移。 */
export function buildTickRanges(durations: readonly number[], globalStartTick = 0): TickRange[] {
  let cursor = Math.max(0, Math.round(globalStartTick));
  return durations.map((duration) => {
    const startTick = cursor;
    const ticks = Math.max(0, Math.round((Number.isFinite(duration) ? duration : 0) * 10));
    cursor += ticks;
    return { startTick, endTick: cursor };
  });
}

/**
 * 只依据台词类型与字数排镜内时段；旧 entry.duration 明确不参与计算。
 * 目标字速用于正常排期，6 字/秒是压缩下限；硬下限总量仍超镜长时返回空排期，交 validator 阻断。
 */
export function buildDialogueSchedule(
  entries: ReadonlyArray<{ speaker?: unknown; text?: unknown; type?: unknown; duration?: unknown }>,
  shotTicks: number
): DialogueScheduleEntry[] {
  const normalized = entries.map((entry) => ({
    speaker: String(entry.speaker ?? ""),
    text: String(entry.text ?? ""),
    type: String(entry.type ?? "对白")
  }));
  const capacity = Math.max(0, Math.floor(shotTicks));
  if (!normalized.length || capacity <= 0) return [];

  const minimums = normalized.map((entry) => Math.max(1, Math.ceil((spokenCharacterCount(entry.text) / 6) * 10)));
  const minimumTotal = minimums.reduce((sum, value) => sum + value, 0);
  if (minimumTotal > capacity) return [];
  const targets = normalized.map((entry, index) => Math.max(minimums[index], Math.ceil((spokenCharacterCount(entry.text) / targetSpeechRate(entry.type)) * 10)));
  let durations = [...targets];
  const targetTotal = durations.reduce((sum, value) => sum + value, 0);
  if (targetTotal > capacity) {
    durations = [...minimums];
    let remaining = Math.max(0, capacity - durations.reduce((sum, value) => sum + value, 0));
    while (remaining > 0) {
      let bestIndex = -1;
      let bestNeed = 0;
      for (let index = 0; index < durations.length; index += 1) {
        const need = targets[index] - durations[index];
        if (need > bestNeed) {
          bestNeed = need;
          bestIndex = index;
        }
      }
      if (bestIndex < 0) break;
      durations[bestIndex] += 1;
      remaining -= 1;
    }
  }

  const speechTotal = durations.reduce((sum, value) => sum + value, 0);
  let spare = Math.max(0, capacity - speechTotal);
  const gaps = normalized.map((entry, index) => index === 0 || entry.speaker !== normalized[index - 1].speaker ? 2 : 0);
  for (let index = 0; index < gaps.length; index += 1) {
    if (gaps[index] > spare) gaps[index] = 0;
    else spare -= gaps[index];
  }

  let cursor = 0;
  return normalized.map((entry, index) => {
    cursor += gaps[index];
    const startTick = cursor;
    const endTick = Math.min(capacity, startTick + durations[index]);
    cursor = endTick;
    return { ...entry, startTick, endTick };
  });
}

/** 有声明时只放宽明确剧情内载体，其余媒体文字永禁；空声明保持调用方的全局禁令原文。 */
export function renderVisibleTextNegative(base: string, declarations: readonly unknown[]): string {
  const normalized = normalizeVisibleTextDeclarations(declarations);
  if (!normalized.length) return base;
  const allowed = normalized.map((item) => `剧情内${item.carrier}逐字显示「${item.content}」`).join("、");
  const qualitySuffix = base.includes("；") ? base.slice(base.indexOf("；") + 1).trim() : "";
  const mediaBan = "除此之外无其他可辨识文字；无字幕、无屏幕叠字、无人名条、无地点条、无时间条、无水印、无Logo、无BGM文字";
  return `仅允许${allowed}；${mediaBan}${qualitySuffix ? `；${qualitySuffix}` : ""}`;
}

/** 旧数据兼容：同一画面短距内必须同时出现实体载体与中/英文双引号内容。 */
export function extractLegacyVisibleTextDeclarations(picture: string): VisibleTextDeclaration[] {
  const declarations: VisibleTextDeclaration[] = [];
  const quotePattern = /“([^”\r\n]{1,80})”|"([^"\r\n]{1,80})"/gu;
  const carrierPattern = /(系统UI|系统面板|UI面板|系统界面|屏幕|公告牌|通知牌|告示|表单|牌匾|门牌|路牌|招牌|卷轴|信件|纸条|考牌)/gu;
  const relationPattern = /写着|写有|显示|标注|内容为|上书|印着|刻着|题着|标有|写明|载明|出现(?:文字|字样)?/u;
  const speechBridge = /(?:开口|说道|说|问|喊|答|回应|低语|耳语)\s*[：:]?\s*$/u;
  for (const quote of picture.matchAll(quotePattern)) {
    if (quote.index === undefined) continue;
    const prefix = picture.slice(Math.max(0, quote.index - 48), quote.index).split(/[。！？!?；;\r\n]/u).pop() ?? "";
    const carriers = [...prefix.matchAll(carrierPattern)];
    const carrierMatch = [...carriers].reverse().find((match) => {
      const bridge = prefix.slice((match.index ?? 0) + match[0].length);
      return relationPattern.test(bridge) && !speechBridge.test(bridge);
    });
    const carrier = carrierMatch?.[1]?.trim() ?? "";
    const content = String(quote[1] ?? quote[2] ?? "");
    if (!carrier || !content.trim()) continue;
    declarations.push({
      kind: /系统|UI|界面|屏幕/u.test(carrier) ? "DIEGETIC_UI" : "DIEGETIC_PROP",
      carrier,
      content
    });
  }
  return normalizeVisibleTextDeclarations(declarations);
}

/** 新字段即使为空或含未知 kind 也代表已迁移，只有字段缺失的旧行才读 picture。 */
export function resolveE1VisibleTextDeclarations(e1: Record<string, unknown>): VisibleTextDeclaration[] {
  if (Object.prototype.hasOwnProperty.call(e1, "visible_text")) {
    return normalizeVisibleTextDeclarations(Array.isArray(e1.visible_text) ? e1.visible_text : []);
  }
  return extractLegacyVisibleTextDeclarations(typeof e1.picture === "string" ? e1.picture : "");
}

export function normalizeVisibleTextDeclarations(values: readonly unknown[]): VisibleTextDeclaration[] {
  const seen = new Set<string>();
  const result: VisibleTextDeclaration[] = [];
  for (const value of values) {
    const validation = validateVisibleTextDeclaration(value);
    if (!validation.valid) continue;
    const { kind, carrier, content, source_node_id } = validation.declaration;
    const key = `${kind}\u0000${carrier}\u0000${content}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind, carrier, content, ...(source_node_id ? { source_node_id } : {}) });
  }
  return result;
}

export function validateVisibleTextDeclaration(value: unknown): VisibleTextDeclarationValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, reason: "声明必须是对象" };
  const raw = value as Record<string, unknown>;
  const kind = raw.kind;
  if (kind !== "DIEGETIC_PROP" && kind !== "DIEGETIC_UI") return { valid: false, reason: "kind 仅允许 DIEGETIC_PROP 或 DIEGETIC_UI" };
  const carrier = String(raw.carrier ?? "").trim();
  const content = String(raw.content ?? "");
  if (!carrier || !content.trim()) return { valid: false, reason: "carrier/content 不能为空" };
  if (CONTROL_OR_LINE_BREAK.test(carrier) || CONTROL_OR_LINE_BREAK.test(content)) return { valid: false, reason: "carrier/content 不得含控制符或换行" };
  if (VISIBLE_TEXT_FORBIDDEN_CARRIER.test(carrier)) return { valid: false, reason: "carrier 属于永禁媒体文字" };
  if (VISIBLE_TEXT_PROMPT_INJECTION.test(carrier)) return { valid: false, reason: "carrier 含提示注入词" };
  if (!/^[\p{L}\p{N}·｜|（）() _-]{1,40}$/u.test(carrier)) return { valid: false, reason: "carrier 必须是简短剧情内载体名" };
  const sourceNodeId = raw.source_node_id === undefined ? "" : String(raw.source_node_id).trim();
  if (raw.source_node_id !== undefined && (!sourceNodeId || CONTROL_OR_LINE_BREAK.test(sourceNodeId))) return { valid: false, reason: "source_node_id 非法" };
  return { valid: true, declaration: { kind, carrier, content, ...(sourceNodeId ? { source_node_id: sourceNodeId } : {}) } };
}

export function dialogueMinimumTicks(entries: ReadonlyArray<{ text?: unknown }>): number {
  return entries.reduce((sum, entry) => sum + Math.max(1, Math.ceil((spokenCharacterCount(String(entry.text ?? "")) / 6) * 10)), 0);
}

function targetSpeechRate(type: string): number {
  if (/SYSTEM|系统/u.test(type)) return 5.5;
  if (/OS|VO|NARRATION|旁白/u.test(type)) return 4.8;
  return 5.2;
}

function spokenCharacterCount(value: string): number {
  return value.replace(/[\s，。！？、；：,.!?;:‘’“”"'（）()《》【】—…-]/gu, "").length;
}

export function hasExplicitSpeakingActor(text: string, name: string): boolean {
  const actor = name.trim();
  if (!actor) return false;

  for (const clause of splitClauses(text)) {
    let cursor = 0;
    while (cursor < clause.length) {
      const index = clause.indexOf(actor, cursor);
      if (index < 0) break;
      cursor = index + actor.length;
      if (AUDIENCE_PREFIX.test(clause.slice(0, index))) continue;

      const suffix = clause.slice(cursor);
      let speechCursor = 0;
      while (speechCursor < suffix.length) {
        const speech = SPEECH_CUE.exec(suffix.slice(speechCursor));
        if (speech?.index === undefined) break;
        const speechIndex = speechCursor + speech.index;
        if (speechIndex > 24) break;
        const bridge = suffix.slice(0, speechIndex);
        if (!isObservedSpeakerBridge(bridge)) return true;
        speechCursor = speechIndex + speech[0].length;
      }
    }
  }
  return false;
}

export function mentionIsExplicitlyOffscreen(text: string, name: string): boolean {
  const actor = name.trim();
  if (!actor) return false;

  const markerBefore = new RegExp(`${OFFSCREEN_MARKER}(?:\\s|的|传来|响起|出现|[）)】\\]])*$`, "u");
  const markerAfter = new RegExp(
    `^(?:的(?:声音|话音))?(?:\\s|[（(【\\[])*(?:仍在|还在|尚在|在|位于|处于|来自|从|保持在)?\\s*${OFFSCREEN_MARKER}`,
    "u"
  );
  const occurrences: boolean[] = [];
  for (const clause of splitClauses(text)) {
    let cursor = 0;
    while (cursor < clause.length) {
      const index = clause.indexOf(actor, cursor);
      if (index < 0) break;
      occurrences.push(markerBefore.test(clause.slice(0, index)) || markerAfter.test(clause.slice(index + actor.length)));
      cursor = index + actor.length;
    }
  }
  return occurrences.length > 0 && occurrences.every(Boolean);
}

export function unitStartPreactionReason(premise: string): string | null {
  const text = premise.trim();
  if (!text) return null;

  const temporal = text.match(/话音落下(?:之后|以后|后)?|随后|随即|然后/u)?.[0];
  if (temporal) return `包含前置时序词「${temporal}」`;
  if (/先(?!生)[^\r\n。！？!?；;]{1,40}?(?:，|,)?再/u.test(text)) return "包含前置时序「先…再…」";
  const executed = text.match(EXECUTED_PREACTION)?.[0];
  if (executed) return `包含已执行动作「${executed}」`;

  const phases = countSequentialActionPhases(text);
  return phases >= 2 ? `包含 ${phases} 段显式连续动作` : null;
}

export function countSequentialActionPhases(text: string): number {
  const value = text.trim();
  if (!value) return 0;

  const arrowPhases = value
    .split(/(?:→|⇒|➜|⟶|->)/u)
    .map((part) => part.replace(/^[\s，,。；;！？!?]+|[\s，,。；;！？!?]+$/gu, ""))
    .filter(Boolean);
  if (arrowPhases.length >= 2) return arrowPhases.length;

  const boundaries: number[] = [];
  for (const match of value.matchAll(/随后|随即|然后|接着|继而|最后|再/gu)) {
    if (match.index === undefined) continue;
    if (match[0] === "再") {
      const before = value[match.index - 1] ?? "";
      const after = value[match.index + 1] ?? "";
      if (/[不勿莫]/u.test(before) || /[次度也现]/u.test(after)) continue;
    }
    boundaries.push(match.index);
  }

  for (const match of value.matchAll(/(?:话音落下|说完|写完|填完|完成|结束|取出[^\r\n，,。；;！？!?]{0,12}|拿出[^\r\n，,。；;！？!?]{0,12}|放下[^\r\n，,。；;！？!?]{0,12}|盖下[^\r\n，,。；;！？!?]{0,12}|按下[^\r\n，,。；;！？!?]{0,12}|抬起[^\r\n，,。；;！？!?]{0,12}|转身[^\r\n，,。；;！？!?]{0,8})后/gu)) {
    if (match.index !== undefined) boundaries.push(match.index + match[0].length - 1);
  }

  const ordered = [...new Set(boundaries)].sort((a, b) => a - b);
  if (!ordered.length) return Math.max(1, value.match(new RegExp(ACTION_WORD_SOURCE, "gu"))?.length ?? 0);
  const merged = ordered.filter((position, index) =>
    index === 0 || !/^后\s*[，,]?\s*再$/u.test(value.slice(ordered[index - 1], position + 1))
  );
  const prefix = value.slice(0, merged[0]);
  const hasInitialAction = ACTION_WORD.test(prefix) || merged.some((position) => value[position] === "后");
  return merged.length + (hasInitialAction ? 1 : 0);
}

function splitClauses(text: string): string[] {
  return text.split(CLAUSE_BOUNDARY).map((part) => part.trim()).filter(Boolean);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isObservedSpeakerBridge(bridge: string): boolean {
  const observesAnother = /^(?:正|正在|仔细|侧耳)?(?:听见|听到|听|观察|看见|看到|注视|目睹)[^\r\n，,。；;！？!?]{0,20}$/u.test(bridge);
  return observesAnother && !/(?:后|之后|以后|后又|后再|后便|后才)\s*$/u.test(bridge);
}
