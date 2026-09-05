import { DirectorAsset, extractEpisodeAssetCandidates, formatAssetIndex } from "@/lib/assets";
import { buildDirectorRuleContextSummary, TASK_SCHEMA_V4_REQUIRED_FIELDS, type DirectorRuleContextSummary } from "@/lib/director-rules";

export type SceneSnapshotV4 = {
  "场次ID": string;
  "时间/内外/地点": string;
  "场景ID": string;
  "出场人物ID": string;
  "相关道具ID": string;
  "人物入场状态": string;
  "人物离场状态": string;
  "服装/妆造状态": string;
  "受伤/醉酒/虚弱等身体状态": string;
  "上一场连续性": string;
  "本场剧情目标": string;
  "本场情绪曲线": string;
  "必须保留的关键台词": string;
  "必须保留的关键动作": string;
  "疑似问题": string;
};

export type TaskSchemaV4Payload = {
  schema: "TASK_SCHEMA_V4";
  versions: ["TASK_SCHEMA_V4", "SCRIPT_CLEAN_V1", "BIBLE_V1", "ASSET_V1", "STYLE_V1"];
  "任务范围": Record<string, unknown>;
  "成熟度/复杂度": Record<string, unknown>;
  "项目口径": Record<string, unknown>;
  "本集摘要": Record<string, unknown>;
  "本场原文": Record<string, unknown>;
  "场次快照": SceneSnapshotV4;
  "导演表现层": Record<string, unknown>;
  "Seedance预算": Record<string, unknown>;
  "稳定性锁": Record<string, unknown>;
  "镜头语言": Record<string, unknown>;
  "六项证据卡": Record<string, unknown>;
  "单元六项锁": Record<string, unknown>;
  "剧情覆盖": Record<string, unknown>;
  "降尺度": Record<string, unknown>;
  "资产索引": Record<string, unknown>;
  "全剧记忆快照": Record<string, unknown>;
  "本集上下文快照": Record<string, unknown>;
  "时长和台词容量": Record<string, unknown>;
  "输出要求": Record<string, unknown>;
  "知识库上下文摘要": DirectorRuleContextSummary;
};

export type BuildTaskPackageInput = {
  projectName: string;
  episodeNumber: number;
  episodeTitle?: string;
  episodeText: string;
  sceneText?: string;
  sceneId?: string;
  existingAssets?: DirectorAsset[];
  maturity?: "结构成熟" | "质量成熟" | "大规模成熟";
  complexity?: "A类简单集" | "B类中等集" | "C类复杂集";
  projectProfile?: Partial<{
    genre: string;
    era: string;
    style: string;
    texture: string;
    performanceScale: string;
    forbiddenStyle: string;
    negativePrompt: string;
  }>;
  projectMemory?: string | null;
  episodeContext?: string | null;
};

export type ValidationResult = {
  ok: boolean;
  errors: string[];
};

const UNKNOWN = "待确认";
const NONE = "无";

export async function buildTaskSchemaV4Payload(input: BuildTaskPackageInput): Promise<TaskSchemaV4Payload> {
  const sceneText = input.sceneText?.trim() || firstSceneText(input.episodeText);
  // 资产一律用正式资产（P2 产出）：候选粗提的假 ID（CH-023 赵清雅）会跟着快照进 E1/P1/P2 提示词，
  // 既费 token 又与正式资产索引打架；仅 P2 未跑、正式资产为空时用候选兜底
  const baseAssets = input.existingAssets ?? [];
  const assets = baseAssets.length ? baseAssets : extractEpisodeAssetCandidates(input.episodeText, []).all;
  const snapshot = buildSceneSnapshot({
    sceneText,
    sceneId: input.sceneId,
    assets
  });

  return {
    schema: "TASK_SCHEMA_V4",
    versions: ["TASK_SCHEMA_V4", "SCRIPT_CLEAN_V1", "BIBLE_V1", "ASSET_V1", "STYLE_V1"],
    "任务范围": {
      "项目名": input.projectName,
      "集数": input.episodeNumber,
      "场次": snapshot["场次ID"],
      "本任务只处理": "本任务包指定场次/剧集切片",
      "禁止处理": "不得改共享资产库、不得扩读全量剧本、不得新增改变原剧本因果的设定"
    },
    "成熟度/复杂度": {
      "阶段成熟度": input.maturity ?? "结构成熟",
      "本集复杂度": input.complexity ?? "B类中等集",
      "允许拆分方式": "按场拆或一集一个subagent，C类复杂集最后1-2个单元由主控复核定稿",
      "主控保留定稿范围": input.complexity === "C类复杂集" ? "本集最后1-2个单元" : "无",
      "暂停点": "六项证据卡、单元六项锁、剧情覆盖、降尺度或台词容量任一缺项"
    },
    "项目口径": {
      "题材": input.projectProfile?.genre ?? UNKNOWN,
      "时代": input.projectProfile?.era ?? UNKNOWN,
      "核心风格": input.projectProfile?.style ?? "真人竖屏短剧写实风格",
      "画面质感": input.projectProfile?.texture ?? "photorealistic，低AI感，9:16竖屏",
      "表演尺度": input.projectProfile?.performanceScale ?? "克制自然，动作符合真人短剧尺度",
      "禁止风格": input.projectProfile?.forbiddenStyle ?? "AI绘画感、夸张特效、远景长对白、复杂长镜头",
      "通用负面约束": input.projectProfile?.negativePrompt ?? "无字幕、无水印、无logo、无BGM；避免手部异常、脸部漂移、肢体僵硬、动作失重"
    },
    "本集摘要": summarizeEpisode(input.episodeText),
    "本场原文": {
      "场次ID": snapshot["场次ID"],
      "时间/内外/地点": snapshot["时间/内外/地点"],
      "人物栏": snapshot["出场人物ID"],
      "道具栏": snapshot["相关道具ID"],
      "原文正文": sceneText || UNKNOWN
    },
    "场次快照": snapshot,
    "导演表现层": buildDirectorLayer(snapshot),
    "Seedance预算": buildSeedanceBudget(sceneText, assets),
    "稳定性锁": buildStabilityLocks(),
    "镜头语言": buildShotLanguageRules(),
    "六项证据卡": buildEvidenceCardRules(),
    "单元六项锁": buildUnitLocks(),
    "剧情覆盖": {
      "关键事件": UNKNOWN,
      "关键台词信息": snapshot["必须保留的关键台词"],
      "关系转折": UNKNOWN,
      "伏笔/回收": UNKNOWN,
      "离场状态或集尾方向": snapshot["人物离场状态"],
      "承载方式": "台词、画面、道具、站位、OS/VO或转场中择一写明"
    },
    "降尺度": {
      "适用范围": "血腥、怪异、实验、伤口、变异、强暴力、平台高风险表达",
      "替代表达": "纱布、暗色痕迹、针管托盘、实验床束带、样本瓶、人物恐惧反应、后果台词、遮挡动作",
      "本场风险": detectScaleRisks(sceneText)
    },
    "资产索引": {
      "内部资产索引": formatAssetIndex(assets),
      "资产明细": assets,
      "使用规则": "最终Seedance正文只引用ID和简短名称，不重复展开外貌；缺信息标待确认"
    },
    "全剧记忆快照": parseSnapshotBlock(input.projectMemory, "PROJECT_MEMORY_V1"),
    "本集上下文快照": parseSnapshotBlock(input.episodeContext, "EPISODE_CONTEXT_SNAPSHOT_V1"),
    "时长和台词容量": {
      "常规单元": "13-15秒优先",
      "短单元": "低于10秒默认退回；只有规范例外且未超过每集稀有上限才可使用，格式为SHORT_EXCEPTION/<CODE>|<具体不可合并事实>",
      "普通对白": "4-5字/秒估算，目标不超过4.5字/秒，最终不得超过5.0字/秒",
      "情绪台词": "3-4字/秒估算，并预留听者反应、道具变化或空间压力",
      "长句": "22字以上先按语义节点拆，再写正文",
      "台词容量预判": estimateDialogueCapacity(sceneText)
    },
    "输出要求": {
      "最终正文": "每个生成分镜单元整体就是一条Seedance提示词",
      "必须字段": "[通用提示词]、[场景]、[本单元出场人物]、[人物状态与站位前提]、机位/运动、画面、声音、台词、转场节拍",
      "标题格式": "### 生成分镜单元N（A-Bs｜总时长Xs）",
      "证据包": "分镜单元后另附V4证据包，主控合并时剥离",
      "硬退回": "六项证据卡、单元六项锁、剧情覆盖、降尺度、动作词库、声场库、转场库或台词容量任一无法完成，不得写最终正文"
    },
    "知识库上下文摘要": await buildDirectorRuleContextSummary()
  };
}

export function buildSceneSnapshot(input: { sceneText: string; sceneId?: string; assets?: DirectorAsset[] }): SceneSnapshotV4 {
  const assets = input.assets ?? extractEpisodeAssetCandidates(input.sceneText).all;
  const locations = assets.filter((asset) => asset.type === "LOC");
  const characters = assets.filter((asset) => asset.type === "CH");
  const props = assets.filter((asset) => asset.type === "PROP");
  const looks = assets.filter((asset) => asset.type === "LOOK");
  const problemHints = [];

  if (characters.length === 0) problemHints.push("缺出场人物");
  if (locations.length === 0) problemHints.push("缺明确地点");
  if (props.length === 0) problemHints.push("缺功能道具");
  if (looks.length === 0) problemHints.push("缺服装/妆造状态");

  return {
    "场次ID": input.sceneId ?? detectSceneId(input.sceneText),
    "时间/内外/地点": detectTimeLocation(input.sceneText),
    "场景ID": locations[0] ? `${locations[0].id} ${locations[0].name}` : UNKNOWN,
    "出场人物ID": characters.length ? formatAssetIndex(characters) : UNKNOWN,
    "相关道具ID": props.length ? formatAssetIndex(props) : NONE,
    "人物入场状态": UNKNOWN,
    "人物离场状态": UNKNOWN,
    "服装/妆造状态": looks.length ? formatAssetIndex(looks) : UNKNOWN,
    "受伤/醉酒/虚弱等身体状态": /受伤|血迹|纱布|虚弱|醉酒|发烧/.test(input.sceneText) ? "原文疑似存在身体状态，待确认" : NONE,
    "上一场连续性": UNKNOWN,
    "本场剧情目标": summarizeGoal(input.sceneText),
    "本场情绪曲线": summarizeEmotion(input.sceneText),
    "必须保留的关键台词": extractKeyDialogue(input.sceneText),
    "必须保留的关键动作": extractKeyActions(input.sceneText),
    "疑似问题": problemHints.length ? problemHints.join("；") : NONE
  };
}

export function validateTaskSchemaV4Payload(payload: unknown): ValidationResult {
  const errors: string[] = [];

  if (!payload || typeof payload !== "object") {
    return { ok: false, errors: ["payload 必须是对象"] };
  }

  const value = payload as Record<string, unknown>;
  if (value.schema !== "TASK_SCHEMA_V4") errors.push("缺 TASK_SCHEMA_V4");

  for (const field of TASK_SCHEMA_V4_REQUIRED_FIELDS) {
    if (!(field in value)) errors.push(`缺关键字段：${field}`);
  }

  const versions = value.versions;
  if (!Array.isArray(versions) || !versions.includes("TASK_SCHEMA_V4")) {
    errors.push("versions 缺 TASK_SCHEMA_V4");
  }

  return { ok: errors.length === 0, errors };
}

function buildDirectorLayer(snapshot: SceneSnapshotV4): Record<string, unknown> {
  return {
    "本场戏剧功能": snapshot["本场剧情目标"],
    "观众视角": "先确认空间和人物关系，再跟随主要冲突人物进入近景",
    "权力关系": UNKNOWN,
    "情绪节拍": snapshot["本场情绪曲线"],
    "景别曲线": "中景建立空间 -> 过肩/侧面中近景对峙 -> 功能道具或反应近景",
    "镜头运动策略": "轻微手持呼吸，必要时 slow push-in；避免复杂长镜头",
    "构图/空间策略": "先建立站位，关键道具放竖屏中央安全区",
    "光线/质感策略": "真实环境光，人物脸部不过曝也不过黑",
    "功能道具/空间锚点": snapshot["相关道具ID"] === NONE ? UNKNOWN : snapshot["相关道具ID"],
    "人物动作库": UNKNOWN,
    "场景声场": UNKNOWN,
    "剪辑落点": "用具体动作声、道具位置或人物动作结果作落点",
    "Seedance稳定性限制": "一个分镜一个主说话人；多人分组；动作写起点、过程、结果",
    "禁止使用的表现方式": "远景长对白、复杂运镜叠加、抽象情绪代替动作"
  };
}

function buildSeedanceBudget(text: string, assets: DirectorAsset[]): Record<string, unknown> {
  return {
    "主动主体数": assets.filter((asset) => asset.type === "CH").length || UNKNOWN,
    "清晰道具数": assets.filter((asset) => asset.type === "PROP").length || UNKNOWN,
    "主动作数": estimateMainActionCount(text),
    "场景数量": assets.filter((asset) => asset.type === "LOC").length || 1,
    "是否跨时间/闪回/梦境": /闪回|梦境|回忆|多年后|与此同时/.test(text) ? "是，需降维" : "否",
    "最可能漂移点": "人物站位、道具位置、服装/伤势连续性",
    "降维方案": "少元素、强关系、清动作；多人分组，远景只作短建立镜"
  };
}

function buildStabilityLocks(): Record<string, unknown> {
  return {
    "机位-画面可见范围": "每镜画面必须匹配机位可见范围；近景不得写镜外人物完整反应",
    "视线目标": "看向/盯着/扫过的目标必须同框可见，镜外目标改为声音或拆镜",
    "单元载人量": "4人以上逐镜分组；8人以上默认重拆",
    "跨单元站位继承": "上一单元延续的站位、手中道具、伤势、距离必须在下一单元重写",
    "插入镜比例": "手部、肢体、道具近景只作功能插入",
    "尾气口": "单元尾气口写进最后一镜画面、声音和时长"
  };
}

function buildShotLanguageRules(): Record<string, unknown> {
  return {
    "默认景别": "中近景/近景为主，远景/全景只作短建立镜",
    "角度变化": "优先过肩近景、侧面近景、前景遮挡、反应近景和焦点转移",
    "固定机位": "证据、医疗手部、钱、关键道具、空间稳定可用，但不可过密",
    "运镜冲击": "快速推近、甩向、声音桥接只用于强压迫或证据暴露",
    "禁止": "远景长对白、连续大脸特写、三人以上正面排队式构图、复杂运镜叠加"
  };
}

function buildEvidenceCardRules(): Record<string, unknown> {
  return {
    "剧情覆盖表": "写正文前完成，返回结果末尾给主控短表",
    "单元导演小纲": "写正文前完成，不进入最终Seedance正文",
    "专属动作词库": "来自本场道具、空间、人物职业和冲突方式",
    "场景声场库": "按地点列可用环境声和道具声",
    "转场库": "每个单元必须有具体画面或声音落点",
    "降尺度替代表达表": "高风险信息保留剧情功能，替换为真人短剧尺度表达"
  };
}

function buildUnitLocks(): Record<string, unknown> {
  return {
    "剧情结果": "谁做了什么导致状态变化",
    "冲突点": "阻力必须具体",
    "功能锚点": "必须进入画面字段并改变剧情状态",
    "动作链": "起点 -> 过程 -> 结果",
    "反应升级": "带来新信息、行动改变、关系压力或下一步风险",
    "剪辑落点": "能直接写进转场节拍"
  };
}

function parseSnapshotBlock(value: string | null | undefined, fallbackSchema: string): Record<string, unknown> {
  if (!value) {
    return {
      schema: fallbackSchema,
      状态: "缺失",
      处理方式: "生成前必须先执行全剧资产与快照预处理"
    };
  }

  try {
    const parsed = JSON.parse(value);
    return typeof parsed === "object" && parsed ? (parsed as Record<string, unknown>) : { raw: value };
  } catch {
    return { raw: value };
  }
}

function summarizeEpisode(text: string): Record<string, unknown> {
  const firstLines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 6).join(" / ");
  return {
    "本集剧情目标": firstLines || UNKNOWN,
    "本集开场状态": UNKNOWN,
    "本集结尾状态": UNKNOWN,
    "本集关键反转": /反转|发现|揭穿|真相|原来/.test(text) ? "原文疑似包含反转，待确认" : UNKNOWN,
    "本集不能遗漏的信息": UNKNOWN,
    "本集集尾下一步可见动作/路线": UNKNOWN
  };
}

function firstSceneText(episodeText: string): string {
  const normalized = episodeText.replace(/\r\n?/g, "\n").trim();
  const sceneMatch = normalized.match(/(?:^|\n)\s*(?:第?\s*[0-9一二三四五六七八九十百]+\s*[场幕]|场景)[^\n]*/);
  if (!sceneMatch || sceneMatch.index === undefined) return normalized;
  const start = sceneMatch.index;
  const rest = normalized.slice(start + sceneMatch[0].length);
  const next = rest.search(/\n\s*(?:第?\s*[0-9一二三四五六七八九十百]+\s*[场幕]|场景)[^\n]*/);
  return next >= 0 ? normalized.slice(start, start + sceneMatch[0].length + next).trim() : normalized.slice(start).trim();
}

function detectSceneId(text: string): string {
  const match = text.match(/(?:第?\s*([0-9一二三四五六七八九十百]+)\s*[场幕]|场景\s*([0-9一二三四五六七八九十百]+)?)/);
  return match ? `SC-${match[1] ?? match[2] ?? "001"}` : "SC-001";
}

function detectTimeLocation(text: string): string {
  const firstLine = text.split(/\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine) return UNKNOWN;
  return /场|景|内|外|日|夜|晨|昏|地点/.test(firstLine) ? firstLine : UNKNOWN;
}

function summarizeGoal(text: string): string {
  const dialogue = extractKeyDialogue(text);
  return dialogue !== NONE ? `围绕关键台词推进冲突：${dialogue}` : UNKNOWN;
}

function summarizeEmotion(text: string): string {
  const beats = [];
  if (/怒|吼|急|逼|威胁|质问/.test(text)) beats.push("压迫/争执");
  if (/哭|泪|哽咽|沉默|愣/.test(text)) beats.push("受挫/停顿");
  if (/笑|嘲|轻蔑/.test(text)) beats.push("轻视/反讽");
  if (/发现|真相|揭穿|反转/.test(text)) beats.push("确认/反转");
  return beats.length ? beats.join(" -> ") : UNKNOWN;
}

function extractKeyDialogue(text: string): string {
  const lines = [...text.matchAll(/^\s*([\u4e00-\u9fa5A-Za-z0-9·]{1,8}(?:（[^）]+）)?)\s*[：:]\s*(.+)$/gm)]
    .map((match) => `${match[1]}：${match[2]}`)
    .filter((line) => line.length >= 8)
    .slice(0, 5);
  return lines.length ? lines.join("；") : NONE;
}

function extractKeyActions(text: string): string {
  const actions = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /拿|递|放|推|拉|跪|挡|砸|摔|抓|按|走|退|冲|抱|掏|收|撕|签|打/.test(line) && !/^[\u4e00-\u9fa5A-Za-z0-9·]{1,8}[：:]/.test(line))
    .slice(0, 5);
  return actions.length ? actions.join("；") : NONE;
}

function estimateMainActionCount(text: string): number | string {
  const matches = text.match(/拿|递|放|推|拉|跪|挡|砸|摔|抓|按|走|退|冲|抱|掏|收|撕|签|打/g);
  return matches?.length ?? UNKNOWN;
}

function detectScaleRisks(text: string): string {
  const risks = [];
  if (/血|伤口|割|砍|枪|刀|尸|死/.test(text)) risks.push("暴力/伤口");
  if (/实验|变异|怪物|畸形/.test(text)) risks.push("怪异/实验");
  return risks.length ? risks.join("；") : NONE;
}

function estimateDialogueCapacity(text: string): Array<Record<string, unknown>> {
  return [...text.matchAll(/^\s*([\u4e00-\u9fa5A-Za-z0-9·]{1,8})(?:（[^）]+）)?\s*[：:]\s*(.+)$/gm)]
    .map((match) => {
      const line = (match[2] ?? "").replace(/[“”"'‘’\s，。！？、；;：:]/g, "");
      const words = line.length;
      return {
        "说话人": match[1],
        "正文字数": words,
        "普通对白最低秒数": Math.ceil(words / 4.5 + 1),
        "情绪台词最低秒数": Math.ceil(words / 3.5 + 1),
        "是否长句": words >= 22 ? "是，需按语义节点拆" : "否"
      };
    })
    .slice(0, 12);
}
