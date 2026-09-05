export type PipelineStageCode = "E0" | "E1" | "E2" | "E3" | "E4" | "E5";

export type StageModelConfig = {
  code: PipelineStageCode;
  name: string;
  skill: string;
  model: "gpt-5.6-terra" | "gpt-5.6-sol";
  reasoningEffort: "medium" | "high" | "max";
};

/** 六岗流水线：E0 叙事节奏 → E1 拆镜执行 → E2 表演 → E3 单元视听（先切单元）→ E4 单元级摄影光影 → E5 审查。
 *  E3/E4 职责对调（用户决策，岗位编号与执行顺序一致）：E3 先按 Python 划分单元并写单元创作字段，
 *  E4 再为每个单元写**单元级光影/摄影策略**（合并单元格，而非逐镜写）——现实制片灯光按场/单元布光，
 *  单元级写 17 次比逐镜写 57 次更可能认真且专业；编译层把单元级 + 镜级差异合并进 Seedance 提示词。
 *  E0 只跑首轮全量（queueEpisodePipeline），返修轮不重切 Beat。 */
export const PIPELINE_STAGE_CONFIGS: readonly StageModelConfig[] = [
  { code: "E0", name: "叙事节奏", skill: "e0-narrative-rhythm-director", model: "gpt-5.6-terra", reasoningEffort: "high" },
  { code: "E1", name: "结构导演", skill: "e1-structure-director", model: "gpt-5.6-terra", reasoningEffort: "high" },
  { code: "E2", name: "表演调度", skill: "e2-performance-blocking-director", model: "gpt-5.6-terra", reasoningEffort: "high" },
  { code: "E3", name: "单元视听", skill: "e3-unit-audiovisual-director", model: "gpt-5.6-terra", reasoningEffort: "high" },
  { code: "E4", name: "摄影光影", skill: "e4-cinematography-light-director", model: "gpt-5.6-terra", reasoningEffort: "high" },
  { code: "E5", name: "审查总控", skill: "e5-review-controller", model: "gpt-5.6-sol", reasoningEffort: "high" }
] as const;

export type SourceNode = {
  source_node_id: string;
  scene_id: string;
  type: "ACTION" | "DIALOGUE" | "OS" | "VO" | "NARRATION" | "SUBTITLE" | "SYSTEM";
  speaker: string | null;
  /** 说话人标签中附着的可拍动作/表演提示；raw 始终保留原始行。 */
  performance_cue?: string;
  text: string;
  raw: string;
};

type SceneSource = {
  sceneKey: string;
  heading: string | null;
  location: string | null;
  interiorExterior: string | null;
  timeOfDay: string | null;
  weather: string | null;
  timeLayer: string;
  sourceText: string;
};

export type SourcePackageBuildOptions = {
  /** P2 资产名/别名等已知人物名；旧调用不传时仍按场次「人物」栏解析。 */
  knownCharacterNames?: readonly string[];
  /** 仅供历史数据迁移：保留旧版“一行一个源节点”的切分方式。 */
  splitInlineDialogue?: boolean;
};

export function readStageModel(code: PipelineStageCode): StageModelConfig {
  const stage = PIPELINE_STAGE_CONFIGS.find((item) => item.code === code);
  if (!stage) throw new Error(`未知岗位：${code}`);
  return stage;
}

/**
 * 源文行清洗（零 Token）：
 * - 去掉空白行；
 * - 对话被换行截断时接回上一行（下一行以句末标点/引号开头，如 "！" "？" "。”" "」"），
 *   避免"不要缠着我\n！"被拆成两个源节点；
 * - 去掉场次头部行（场景：/人物：/道具：/「场景 X」无编号标记）与标题行。
 */
function normalizeSourceLines(sourceText: string, sceneKey: string, heading: string | null): string[] {
  const lines = sourceText.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const joined: string[] = [];
  for (const rawLine of lines) {
    // Word 扁平化可能把场头、人物栏和正文压成：
    //「1-1电梯 夜/内人物：姜恋△狭窄电梯里……△姜恋按键」。
    // 去掉场头/元数据前缀，但保留第一个 △ 后的正文，再按 △ 还原源节点。
    const line = stripInlineSceneHeader(rawLine, sceneKey);
    if (!line) continue;
    for (const fragment of line.split("△")) {
      const candidate = fragment.trim();
      if (!candidate) continue;
      const isHeader = (candidate === sceneKey || /^\d+-\d+\s+/.test(candidate)) || candidate === heading || /^(?:场景|人物|道具)[:：]/.test(candidate) || /^场景\s*[:：]?\s*[^\n：:]{1,30}$/.test(candidate);
      if (isHeader) continue;
      // 行首是句末标点/引号闭合：接回上一行（对话换行截断的修复）
      if (joined.length && /^[！？。；：，、…）」』"'”]/.test(candidate)) {
        joined[joined.length - 1] = `${joined[joined.length - 1]}${candidate}`;
        continue;
      }
      joined.push(candidate);
    }
  }
  return joined;
}

function stripInlineSceneHeader(line: string, sceneKey: string): string {
  if (line === sceneKey || line === sceneKey.replace(/-\d+$/, "")) return "";
  const numbered = line.match(/^(\d+-\d+)(.*)$/);
  if (!numbered) return line;
  const rest = numbered[2];
  if (/^\s/.test(rest) || !rest) return "";
  const bodyIndex = rest.indexOf("△");
  return bodyIndex >= 0 ? rest.slice(bodyIndex + 1).trim() : "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把 Word/富文本扁平化后落在同一行的多个人物台词拆回独立源节点。
 * 只认已知人物和系统说话人标签，避免把普通叙述里的冒号误判成对白。
 */
export function splitInlineSourceLine(raw: string, knownCharacterNames: readonly string[] = []): string[] {
  const labels = normalizeKnownCharacterNames([
    ...knownCharacterNames,
    "旁白",
    "画外音",
    "字幕",
    "系统音",
    "系统提示",
    "男声",
    "女声",
    "广播",
    "电话那头",
    "众人",
    "人群",
    "服务生",
    "老人",
    "男人",
    "女人",
    "小孩",
    "孩子"
  ]);
  if (!labels.length) return [raw];
  const labelPattern = labels.map(escapeRegExp).join("|");
  const marker = new RegExp(
    `(?:${labelPattern})(?:声(?:音)?)?(?:\\s*(?:[（(][^）)]{1,24}[）)]|OS|VO))*\\s*[:：]`,
    "giu"
  );
  const matches = [...raw.matchAll(marker)];
  if (!matches.length) return [raw];

  const pieces: string[] = [];
  let cursor = 0;
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index ?? 0;
    if (start > cursor) {
      const prefix = raw.slice(cursor, start).trim();
      if (prefix) pieces.push(prefix);
    }
    const nextStart = matches[index + 1]?.index ?? raw.length;
    // 当前说话人标签归入当前对白，直到下一个说话人标签为止。
    const piece = raw.slice(start, nextStart).trim();
    if (piece) pieces.push(piece);
    cursor = nextStart;
  }
  if (cursor < raw.length) {
    const tail = raw.slice(cursor).trim();
    if (tail) pieces.push(tail);
  }
  return (pieces.length ? pieces : [raw]).flatMap((piece) => splitTrailingAction(piece, labels));
}

/**
 * 某些富文本导出会把“角色台词 + 下一句无冒号动作”压成一行，例如：
 * “宋雨：老人都死了，我们怎么办？姜恋低头沉思。”
 * 这里把动作重新还原成 ACTION 节点，避免动作被误算为上一人的台词。
 */
function splitTrailingAction(piece: string, knownCharacterNames: readonly string[]): string[] {
  const colonIndex = piece.search(/[:：]/);
  const textStart = colonIndex >= 0 ? colonIndex + 1 : 0;
  const text = piece.slice(textStart);
  if (!text.trim()) return [piece];

  const labels = knownCharacterNames.map(escapeRegExp).sort((a, b) => b.length - a.length);
  if (!labels.length) return [piece];
  const actionCue = "低头|抬头|沉思|站在|坐在|看向|看着|走向|转身|点头|摇头|皱眉|笑着|哭着|喊道|开口|闭嘴|拿出|掏出|指向|盯着|望向|倚在|轻声|冷声|猛回头|猛转身|猛抬头|突然回头|忽然回头|猛地|猛然|回头|沉默|愣住|愕然|环顾|握紧|咬牙|深吸|叹气|捂住|靠近|退后|后退|起身|抬眼|垂眸|低声|急声|怒声";
  const boundary = new RegExp(
    `(?<=[。！？；])(?=(?:${labels.join("|")})(?:\\s*[（(][^）)]{1,24}[）)])?(?:${actionCue}))`,
    "giu"
  );
  const match = boundary.exec(text);
  if (!match || match.index <= 0) return [piece];

  const dialogueText = text.slice(0, match.index).trimEnd();
  const actionText = text.slice(match.index).trim();
  if (!dialogueText || !actionText) return [piece];
  return [`${piece.slice(0, textStart)}${dialogueText}`.trim(), actionText];
}

export function buildSourcePackage(scenes: readonly SceneSource[], options: SourcePackageBuildOptions = {}) {
  let nodeNumber = 0;
  const projectCharacterNames = normalizeKnownCharacterNames(options.knownCharacterNames ?? []);
  return {
    scenes: scenes.map((scene) => {
      const knownCharacterNames = normalizeKnownCharacterNames([
        ...projectCharacterNames,
        ...extractSceneCharacterNames(scene.sourceText)
      ]);
      const normalizedLines = normalizeSourceLines(scene.sourceText, scene.sceneKey, scene.heading);
      const sourceLines = options.splitInlineDialogue === false
        ? normalizedLines
        : normalizedLines.flatMap((line) => splitInlineSourceLine(line, knownCharacterNames));
      const sourceNodes = sourceLines
        .map((line) => {
          nodeNumber += 1;
          return parseSourceNode(line, scene.sceneKey, `N${String(nodeNumber).padStart(4, "0")}`, knownCharacterNames);
        });
      return {
        scene_id: scene.sceneKey,
        heading: scene.heading,
        location: scene.location,
        interior_exterior: scene.interiorExterior,
        time_of_day: scene.timeOfDay,
        weather: scene.weather,
        time_layer: scene.timeLayer,
        source_nodes: sourceNodes
      };
    })
  };
}

function normalizeKnownCharacterNames(values: readonly string[]): string[] {
  return [...new Set(values
    .flatMap((value) => {
      const full = String(value).trim();
      const main = full.replace(/[|｜].*$/, "").trim();
      // 显式「人物｜变体」必须优先完整匹配以保留资产身份；同时保留主名供普通剧本说话人匹配。
      return full && full !== main ? [full, main] : [main];
    })
    .filter((value) => value.length >= 2))]
    .sort((a, b) => b.length - a.length);
}

function extractSceneCharacterNames(sourceText: string): string[] {
  return sourceText
    .replace(/\r\n?/g, "\n")
    .split(/[\n△]/)
    .map((line) => line.trim().match(/(?:人物|角色)[:：]\s*([^\n△]*)/)?.[1] ?? "")
    .filter(Boolean)
    .flatMap((value) => value.split(/[、,，；;\/]/).map((name) => name.trim()).filter(Boolean));
}

function normalizeSpeakerLabel(label: string, knownCharacterNames: readonly string[]) {
  const clean = label.trim();
  const speaker = knownCharacterNames.find((name) => clean.startsWith(name));
  if (!speaker) return { speaker: clean, performanceCue: "" };
  const performanceCue = clean.slice(speaker.length).trim().replace(/^声(?:音)?$/, "");
  return { speaker, performanceCue };
}

function splitVoiceMarker(label: string): { label: string; type: "OS" | "VO" } | null {
  // 支持：人物（OS）/人物(OS)/人物 OS/人物OS；VO 同理。
  const match = label.match(/^(.*?)\s*(?:[（(]\s*(OS|VO)\s*[）)]|(OS|VO))\s*$/i);
  const marker = match?.[2] ?? match?.[3];
  if (!match || !marker) return null;
  return { label: match[1].trim(), type: marker.toUpperCase() as "OS" | "VO" };
}

function parseSourceNode(raw: string, sceneId: string, id: string, knownCharacterNames: readonly string[] = []): SourceNode {
  const dialogueMatch = raw.match(/^([^：:]{1,40})[:：]\s*(.*)$/);
  if (dialogueMatch) {
    const rawLabel = dialogueMatch[1].trim();
    const voice = splitVoiceMarker(rawLabel);
    const label = (voice?.label ?? rawLabel).trim();
    if (!isRecognizedSpeakerLabel(label, knownCharacterNames) && !voice) {
      // 动作句里也可能出现冒号（如“她展开纸团，上面写着：……”），
      // 未命中人物/系统标签时必须保留为 ACTION，不能伪造一个说话人。
      return { source_node_id: id, scene_id: sceneId, type: "ACTION", speaker: null, text: raw, raw };
    }
    const normalized = normalizeSpeakerLabel(label, knownCharacterNames);
    const type = voice?.type ?? (/旁白|画外音/.test(normalized.speaker)
      ? "NARRATION"
      : /字幕/.test(normalized.speaker)
        ? "SUBTITLE"
        : /系统提示|系统音/.test(normalized.speaker)
          ? "SYSTEM"
          : "DIALOGUE");
    return {
      source_node_id: id,
      scene_id: sceneId,
      type,
      speaker: normalized.speaker || null,
      ...(normalized.performanceCue ? { performance_cue: normalized.performanceCue } : {}),
      text: dialogueMatch[2],
      raw
    };
  }
  return { source_node_id: id, scene_id: sceneId, type: "ACTION", speaker: null, text: raw, raw };
}

function isRecognizedSpeakerLabel(label: string, knownCharacterNames: readonly string[]): boolean {
  const clean = label.trim().replace(/\s*[（(][^）)]{1,24}[）)]\s*$/, "");
  if (knownCharacterNames.some((name) => clean.startsWith(name))) return true;
  return /^(?:旁白|画外音|字幕|系统音|系统提示|男声|女声|广播|电话那头|众人|人群|服务生|老人|男人|女人|小孩|孩子)$/.test(clean);
}

export type WorkingShot = {
  shot_id: string;
  e1: Record<string, unknown>;
  e2: Record<string, unknown>;
  e3: Record<string, unknown>;
  e4: Record<string, unknown>;
  [key: string]: unknown;
};

export function mergeShotPatches<T extends WorkingShot>(
  shots: readonly T[],
  patches: ReadonlyArray<{ shot_id?: unknown; action?: unknown; fields?: unknown }>,
  field: "e2" | "e3" | "e4"
): T[] {
  const byShot = new Map(patches.map((patch) => [String(patch.shot_id ?? ""), patch]));
  return shots.map((shot) => {
    const patch = byShot.get(shot.shot_id);
    if (!patch || patch.action === "no_change" || !isRecord(patch.fields)) return { ...shot };
    return { ...shot, [field]: { ...shot[field], ...patch.fields } };
  });
}


export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function roundTenth(value: number): number {
  return Math.round(value * 10) / 10;
}
