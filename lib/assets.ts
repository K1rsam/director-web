export const DIRECTOR_ASSET_TYPES = ["CH", "LOOK", "GROUP", "BEAST", "LOC", "PROP", "STYLE", "NEG"] as const;

export type DirectorAssetType = (typeof DIRECTOR_ASSET_TYPES)[number];
export type AssetConfirmationStatus = "confirmed" | "needs_confirmation";

export type DirectorAsset = {
  id: string;
  type: DirectorAssetType;
  name: string;
  status: AssetConfirmationStatus;
  sourceText?: string;
  notes?: string;
};

export type EpisodeAssetCandidates = {
  characters: DirectorAsset[];
  looks: DirectorAsset[];
  locations: DirectorAsset[];
  props: DirectorAsset[];
  styles: DirectorAsset[];
  negatives: DirectorAsset[];
  all: DirectorAsset[];
};

const GENERIC_SPEAKERS = new Set(["旁白", "画外音", "字幕", "电话", "系统", "系统窗口", "场景", "人物", "道具"]);
const PROP_WORDS = ["手机", "钥匙", "车钥匙", "药", "药瓶", "针管", "酒杯", "茶杯", "合同", "文件", "照片", "戒指", "项链", "玉佩", "银行卡", "现金", "钱包", "包", "伞", "刀", "剑", "枪", "报名表", "登记册"];

export function generateAssetId(type: DirectorAssetType, existing: Array<Pick<DirectorAsset, "id">> = []): string {
  const prefix = `${type}-`;
  const max = existing.reduce((currentMax, asset) => {
    if (!asset.id.startsWith(prefix)) return currentMax;
    const numeric = Number(asset.id.slice(prefix.length));
    return Number.isFinite(numeric) ? Math.max(currentMax, numeric) : currentMax;
  }, 0);

  return `${type}-${String(max + 1).padStart(3, "0")}`;
}

export function extractEpisodeAssetCandidates(
  episodeText: string,
  existingAssets: DirectorAsset[] = []
): EpisodeAssetCandidates {
  const normalized = episodeText.replace(/\r\n?/g, "\n");
  const pending = [...existingAssets];

  const characters = createAssets("CH", extractCharacterNames(normalized), pending, "从台词说话人粗提，需主控确认人物身份。");
  pending.push(...characters);

  const locations = createAssets("LOC", extractLocationNames(normalized), pending, "从场景标题或地点词粗提，需确认具体空间。");
  pending.push(...locations);

  const props = createAssets("PROP", extractPropNames(normalized), pending, "从动作或道具词粗提，需确认是否为功能道具。");
  pending.push(...props);

  const looks = createAssets("LOOK", extractLookNames(normalized, characters), pending, "从服装/身体状态粗提，缺造型细节。");
  pending.push(...looks);

  const styles = createAssets("STYLE", ["项目写实短剧风格"], pending, "默认风格资产，待项目口径确认。");
  pending.push(...styles);

  const negatives = createAssets("NEG", ["通用负面约束"], pending, "默认负面约束，待项目口径确认。");
  const all = [...characters, ...looks, ...locations, ...props, ...styles, ...negatives];

  return { characters, looks, locations, props, styles, negatives, all };
}

export function formatAssetIndex(assets: DirectorAsset[]): string {
  return assets.map((asset) => `${asset.id} ${asset.name}`).join("；");
}

function createAssets(type: DirectorAssetType, names: string[], existing: DirectorAsset[], notes: string): DirectorAsset[] {
  const assets: DirectorAsset[] = [];
  // CH 按"基础人名"去重（P2 资产名是 人物｜服装，粗提的裸名必须命中）；凶兽名也占用 CH 名额（凶兽不建 CH）
  const seen = new Set<string>();
  for (const asset of existing) {
    if (asset.type === type) seen.add(type === "CH" ? asset.name.split("｜")[0] : asset.name);
    if (type === "CH" && asset.type === "BEAST") seen.add(asset.name);
  }

  for (const name of unique(names)) {
    const key = type === "CH" ? name.split("｜")[0] : name;
    if (seen.has(key)) continue;
    assets.push({
      id: generateAssetId(type, [...existing, ...assets]),
      type,
      name,
      status: "needs_confirmation",
      notes
    });
    seen.add(key);
  }

  return assets;
}

function extractCharacterNames(text: string): string[] {
  const declared = extractMetadataItems(text, "人物");
  if (declared.length) {
    return declared.map(characterBaseName).filter(Boolean);
  }
  return [...text.matchAll(/(?:^|\n)\s*([^\n：:]{1,20})(?:（[^）]*）)?\s*[：:]/g)]
    .map((match) => normalizeSpeakerName(match[1] ?? ""))
    .filter((name) => name.length >= 2 && !GENERIC_SPEAKERS.has(name));
}

function extractLocationNames(text: string): string[] {
  const declared = extractMetadataItems(text, "场景").filter((name) => name !== "无");
  if (declared.length) return declared;
  const headings = [...text.matchAll(/(?:^|\n)\s*(?:第?\s*[0-9一二三四五六七八九十百]+\s*[场幕]|场景)\s*[：:、\-\s]*(.+)/g)]
    .map((match) => cleanSceneHeading(match[1] ?? ""))
    .filter(Boolean);
  // 场景标记行已足够定位地点（扁平化剧本的「场景 X」行）：命中即返回，避免正文后缀词乱抓（如"觉醒仪式大厅内"）
  if (headings.length) return headings;
  const suffixLocations = [...text.matchAll(/([\u4e00-\u9fa5A-Za-z0-9·]{2,14}(?:卧室|客厅|餐厅|厨房|走廊|电梯|天台|办公室|会议室|病房|医院|学校|公司|酒店|包厢|停车场|院子|门口|街口|车内|车旁|房间|大厅|院|厅|室|房|门|街|路|桥|店|馆|局|府|山|殿|场))/g)].map((match) => cleanName(match[1] ?? ""));

  return suffixLocations;
}

function extractPropNames(text: string): string[] {
  const declared = extractMetadataItems(text, "道具").filter((name) => name !== "无");
  if (declared.length) return declared;
  const directProps = PROP_WORDS.filter((word) => text.includes(word));
  return directProps;
}

function extractLookNames(text: string, characters: DirectorAsset[]): string[] {
  const declaredLooks = extractMetadataItems(text, "人物")
    .map((value) => {
      const match = value.match(/^(.+?)[（(]([^）)]+)[）)]$/);
      if (!match) return "";
      return `${cleanName(match[1])}｜${match[2].trim()}`;
    })
    .filter(Boolean);
  if (declaredLooks.length) return declaredLooks;
  const status = [];
  if (/受伤|血迹|纱布|虚弱|醉酒|发烧/.test(text)) status.push("受伤/虚弱状态");
  if (/婚纱|西装|校服|病号服|工装|睡衣|礼服|布衣/.test(text)) status.push("本集服装状态");

  return characters.length > 0 ? status.map((item) => `${characters[0]?.name}${item}`) : status;
}

function cleanName(value: string): string {
  return value.replace(/[“”"'‘’（）()，。！？、；;：:\s]/g, "").trim();
}

function extractMetadataItems(text: string, field: "场景" | "人物" | "道具"): string[] {
  return [...text.matchAll(new RegExp(`(?:^|\\n)\\s*${field}[:：]\\s*([^\\n]+)`, "g"))]
    .flatMap((match) => String(match[1] ?? "").split(/[、，,；;]/))
    .map((value) => value.trim())
    .filter(Boolean);
}

function characterBaseName(value: string): string {
  return cleanName(value.replace(/[（(][^）)]*[）)]$/, ""));
}

function normalizeSpeakerName(value: string): string {
  return cleanName(
    value
      .replace(/[（(][^）)]*[）)]$/, "") // 去尾部（情绪/动作）备注，如 同学甲（激动地）→ 同学甲
      .replace(/^[△▲]+/, "") // 去动作符
      .replace(/^【[^】]*/, "") // 去【字幕 等标记头
  )
    .replace(/(?:内心)?(?:OS|VO)$/i, "")
    .replace(/^Q版?/, "")
    .replace(/Q版$/, "");
}

function cleanSceneHeading(value: string): string {
  return value
    .split(/\s+/)[0]
    .replace(/[，。！？；;].*$/, "")
    .replace(/^(内|外|日|夜|晨|昏)[、，\s-]*/, "")
    .trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}


/** 资产 metadata 里的 scene_refs（唯一实现，页面与流水线共用同一口径）。 */
export function assetSceneRefsOf(metadata: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(metadata ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const refs = (parsed as Record<string, unknown>).scene_refs;
      if (Array.isArray(refs)) return refs.map(String).filter(Boolean);
    }
  } catch {
    // 忽略坏 JSON
  }
  return [];
}


/** 资产 metadata 里的 aliases（剧本别称/昵称，解析绑定用）。 */
export function assetAliasesOf(metadata: string | null | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(metadata ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const aliases = (parsed as Record<string, unknown>).aliases;
      if (Array.isArray(aliases)) return aliases.map(String).filter(Boolean);
    }
  } catch {
    // 忽略坏 JSON
  }
  return [];
}
