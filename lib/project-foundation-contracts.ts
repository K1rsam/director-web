/**
 * P1/P2 第一阶段岗位化 — 契约层
 *
 * P0（Python）：拆集/拆场次/源节点/锁源 —— 保持确定性，不调用模型。
 * P1 全剧基础策划师：输出可查询的结构化项目圣经（PROJECT_MEMORY_V2）。
 * P2 全剧资产拆解师：全量分析输出主/分资产简表与场次关联。
 * P3（Python）：覆盖/重名/孤儿/字段/来源校验，BLOCKER 即停。
 *
 * 分片：按自然集边界分组（不在集中间截断），每片源文 ≤ FOUNDATION_CHUNK_MAX_CHARS；
 * 同岗位连续处理，只带压缩的 prior 状态，最后 Python 合并。
 */
import type { Project, Episode, ScriptScene } from "@prisma/client";
import { buildSourcePackage, type SourceNode } from "@/lib/episode-pipeline-contracts";
import { contractAppliesToAnyEpisode, parsePresentationEpisodeNumbers, presentationDecisionKey } from "@/lib/presentation-contracts";

export type FoundationStageCode = "P1" | "P2";

export const PROJECT_FOUNDATION_STAGES: ReadonlyArray<{
  code: FoundationStageCode;
  name: string;
  skill: string;
  model: string;
  reasoningEffort: "high" | "max";
  apiReasoner: boolean;
}> = [
  { code: "P1", name: "全剧基础策划", skill: "p1-project-planner", model: "gpt-5.6-terra", reasoningEffort: "high", apiReasoner: false },
  { code: "P2", name: "全剧资产拆解", skill: "p2-asset-disassembler", model: "gpt-5.6-terra", reasoningEffort: "high", apiReasoner: true }
] as const;

export const FOUNDATION_CHUNK_MAX_CHARS = 24_000;

/** P2 按类别分批（SHUO 式：每次只拆一类，输出小、稳定）。 */
export const FOUNDATION_ASSET_KINDS: ReadonlyArray<{
  key: "characters" | "scenes" | "props";
  label: string;
  types: string[];
}> = [
  { key: "characters", label: "人物·群像·非人", types: ["CH", "GROUP", "BEAST"] },
  { key: "scenes", label: "场景", types: ["LOC"] },
  { key: "props", label: "道具", types: ["PROP"] }
] as const;

export type FoundationScene = {
  scene_id: string;
  heading: string | null;
  location: string | null;
  interior_exterior: string | null;
  time_of_day: string | null;
  weather: string | null;
  time_layer: string;
  source_nodes: SourceNode[];
};

export type FoundationEpisode = {
  number: number;
  title: string | null;
  scenes: FoundationScene[];
};

export type FoundationContext = {
  projectId: string;
  project: Project;
  /** 正式生产集（第1集起）；P1/P2 的 episodes 只允许覆盖这些集。 */
  episodes: Array<Episode & { scriptScenes: ScriptScene[] }>;
  /** 第0集或第1集以前的辅助资料，只进入 P1/P2 上下文，不进入单集生产。 */
  preludeEpisodes: Array<Episode & { scriptScenes: ScriptScene[] }>;
  /** episodeNumber → 该集解析出的场次与源节点（含每集内稳定 ID） */
  episodeScenes: Map<number, FoundationEpisode>;
  /** episodeNumber → 源节点 ID 全集（用于校验） */
  episodeNodeIds: Map<number, Set<string>>;
  existingAssets: Array<{ code: string; type: string; name: string; status: string }>;
  /** 用户已确认的表现规范（P1 提出 → UI 确认），只在命中的 P2 分片中使用。 */
  contracts: Array<{
    category: string;
    user_answer: string;
    scope_mode?: string;
    target_episode_numbers?: number[];
  }>;
  /** 剧本原文是否出现 Q版 元素（机械判定，用于门禁兜底与自动契约） */
  scriptContainsQVersion: boolean;
};

export type P1Fact = {
  fact: string;
  source_node_refs: string[];
};

export type P1Output = {
  schema: string;
  story_contract: {
    genre: string;
    perspective: string;
    core_desire: string;
    immutable_facts: P1Fact[];
  };
  episodes: Array<{
    number: number;
    one_line_progress: string;
    start_state: string;
    end_state: string;
    key_changes: string[];
    source_node_refs: string[];
    /** 每场的时间/内外/地点（合格值，禁止待确认；compile 直接用它，不再输出"待定"） */
    scenes?: Array<{
      scene_id: string;
      time_of_day: string;
      interior_exterior: string;
      location: string;
    }>;
  }>;
  relationships: Array<{
    a: string;
    b: string;
    stages: Array<{ episode_range: string; state: string; knowledge: string; source_node_refs: string[] }>;
  }>;
  secrets: Array<{
    secret: string;
    known_to: string[];
    revealed_to_audience_at: string;
    revealed_to_character_at: string;
    source_node_refs: string[];
  }>;
  foreshadowing: Array<{ setup: string; payoff: string; source_node_refs: string[] }>;
  boundaries: Array<{ from_episode: number; to_episode: number; carry_over: string; source_node_refs: string[] }>;
  issues: FoundationIssue[];
  /** 表现规范待确认清单：通读全剧本后发现的需要用户拍板的非常规表现元素（系统/Q版/血腥/闪回/HUD…）。
   *  每项给出问题、可选方案（A/B/C…）、出现位置证据；用户确认后锁定并注入 P2 与 E1-E5。 */
  presentation_decisions_needed?: Array<{
    category: string;
    question: string;
    options: string[];
    evidence: string;
    /** P1 判断该项确实属于需要定义表现方式的剧情元素时，必须给出可定位证据。 */
    episode_number?: number;
    /** 同一表现规则覆盖的全部正式集；episode_number 是主证据所在集。 */
    episode_numbers?: number[];
    /** 同一语义规则跨分片/跨集重复出现时复用的稳定键，不要包含集号。 */
    rule_key?: string;
    source_node_refs?: string[];
    suggested_default?: string;
    /** 轮次：P1 每次重跑输出清单的轮次（同类别已有契约则 +1），供 UI 按轮分组 */
    round?: number;
  }>;
};

export type P1ChunkCoverage = {
  expected: number[];
  actual: number[];
  missing: number[];
  unexpected: number[];
  duplicates: number[];
  invalid: number;
};

export type P2Asset = {
  name: string;
  /** CH 人物（主人物与服装/状态分资产同为 CH，靠 parent_name 区分）｜GROUP 群像｜BEAST 非人｜LOC 场景｜PROP 道具 */
  type: "CH" | "GROUP" | "BEAST" | "LOC" | "PROP";
  /** 人物角色定位（仅 CH 主资产）：主角 / 配角 / 反派 / 路人 */
  role?: "主角" | "配角" | "反派" | "路人" | null;
  parent_name: string | null;
  first_seen_node: string | null;
  scene_refs: string[];
  aliases: string[];
  evidence: string;
};

export type P2Output = {
  assets: P2Asset[];
  scene_asset_links: Array<{ scene_id: string; asset_names: string[] }>;
  issues: FoundationIssue[];
};

export type FoundationIssue = {
  coordinate: string;
  code: string;
  severity: "BLOCKER" | "MAJOR" | "MINOR";
  owner: "P1" | "P2" | "P3";
  expected: string;
  evidence: string;
};

export function loadFoundationContext(
  project: Project,
  episodes: Array<Episode & { scriptScenes: ScriptScene[] }>,
  existingAssets: Array<{ code: string; type: string; name: string; status: string }>,
  contracts: Array<{
    category: string;
    user_answer: string;
    scope_mode?: string;
    target_episode_numbers?: number[];
  }> = []
): FoundationContext {
  const episodeScenes = new Map<number, FoundationEpisode>();
  const episodeNodeIds = new Map<number, Set<string>>();
  for (const episode of episodes) {
    const scenes = buildSourcePackage(
      episode.scriptScenes.map((scene) => ({
        sceneKey: scene.sceneKey,
        heading: scene.heading,
        location: scene.location,
        interiorExterior: scene.interiorExterior,
        timeOfDay: scene.timeOfDay,
        weather: scene.weather,
        timeLayer: scene.timeLayer,
        sourceText: scene.sourceText
      }))
    ).scenes;
    const nodeIds = new Set<string>();
    episodeScenes.set(episode.number, {
      number: episode.number,
      title: episode.title,
      scenes: scenes.map((scene) => {
        for (const node of scene.source_nodes) nodeIds.add(node.source_node_id);
        return {
          scene_id: scene.scene_id,
          heading: scene.heading,
          location: scene.location,
          interior_exterior: scene.interior_exterior,
          time_of_day: scene.time_of_day,
          weather: scene.weather,
          time_layer: scene.time_layer,
          source_nodes: scene.source_nodes
        };
      })
    });
    episodeNodeIds.set(episode.number, nodeIds);
  }
  // Q版 常出现在说话人栏（"苏远Q版：…"），检测要把 speaker 与正文合起来看
  const scriptContainsQVersion = [...episodeScenes.values()].some((episode) =>
    episode.scenes.some((scene) =>
      scene.source_nodes.some((node) => /Q版|Q\s*版|萌版|q版/.test(`${node.speaker ?? ""} ${node.text}`))
    )
  );
  return {
    projectId: project.id,
    project,
    episodes: episodes.filter((episode) => episode.number >= 1),
    preludeEpisodes: episodes.filter((episode) => episode.number < 1),
    episodeScenes,
    episodeNodeIds,
    existingAssets,
    contracts,
    scriptContainsQVersion
  };
}

type PresentationContractSemantic = {
  category?: string | null;
  user_answer?: string | null;
  scope_mode?: string | null;
  target_episode_numbers?: number[] | string | null;
};

/** 已确认的 system 规范明确把信息载体定为 UI 时，P2 需要遵守的语义边界。 */
export function isSystemUiPresentationContract(contract: PresentationContractSemantic): boolean {
  const category = String(contract.category ?? "").trim().toLocaleLowerCase();
  const answer = String(contract.user_answer ?? "");
  return category === "system" && /系统面板|系统界面|系统窗口|UI|面板|界面|屏幕|窗口/i.test(answer);
}

/** 这些名称代表系统信息载体，而不是人物或非人角色。 */
export function isSystemUiCarrierAssetName(name: string): boolean {
  return /^(?:系统音|系统提示|系统通知|系统窗口|系统面板|系统界面|游戏系统(?:面板|界面|窗口)?)(?:｜|$)/u.test(name.trim());
}

/** 原文明确写成会行动/攻击/寄生的系统伪人或残核，属于非人叙事资产。 */
export function isSystemNonHumanAssetName(name: string): boolean {
  return /^(?:系统伪人|系统残核|伪人脸(?:残核)?)(?:｜|$)/u.test(name.trim());
}

function assetEpisodeNumbers(asset: P2Asset): number[] {
  return [...new Set((asset.scene_refs ?? []).map((sceneId) => {
    const match = /^\s*(\d+)(?:-|$)/u.exec(sceneId);
    return match ? Number(match[1]) : null;
  }).filter((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1))];
}

function systemUiContractAppliesToAsset(asset: P2Asset, context: FoundationContext): boolean {
  const formalEpisodeNumbers = context.episodes.map((episode) => episode.number);
  const referencedEpisodeNumbers = assetEpisodeNumbers(asset);
  const candidates = referencedEpisodeNumbers.length ? referencedEpisodeNumbers : formalEpisodeNumbers;
  return context.contracts.some((contract) => isSystemUiPresentationContract(contract) && contractAppliesToAnyEpisode(
    contract,
    candidates,
    formalEpisodeNumbers
  ));
}

/**
 * 在 P2 合并/校验前做确定性归类，避免模型偶发把系统信息载体写成 CH，
 * 或把原文明确的系统伪人写成人物。只针对语义明确的名称，不按“系统”关键词
 * 粗暴删除真实剧情实体。
 */
export function normalizeP2SystemSemantics(output: P2Output, context: FoundationContext): P2Output {
  let changed = false;
  const assets = output.assets.map((asset) => {
    if (isSystemNonHumanAssetName(asset.name) && asset.type === "CH") {
      changed = true;
      return { ...asset, type: "BEAST" as const, role: null };
    }
    if (isSystemUiCarrierAssetName(asset.name) && asset.type !== "PROP" && systemUiContractAppliesToAsset(asset, context)) {
      changed = true;
      return { ...asset, type: "PROP" as const, role: null, parent_name: null };
    }
    return asset;
  });
  return changed ? { ...output, assets } : output;
}

/** 按自然集边界分片：单集超长时单独成片，集内不截断。 */
export function buildFoundationChunks(
  context: FoundationContext,
  episodeContentLengths: Map<number, number>
): Array<{ episodes: number[] }> {
  const chunks: Array<{ episodes: number[] }> = [];
  let current: number[] = [];
  let currentChars = 0;
  for (const episode of context.episodes) {
    const length = episodeContentLengths.get(episode.number) ?? 0;
    if (current.length > 0 && currentChars + length > FOUNDATION_CHUNK_MAX_CHARS) {
      chunks.push({ episodes: current });
      current = [];
      currentChars = 0;
    }
    current.push(episode.number);
    currentChars += length;
  }
  if (current.length) chunks.push({ episodes: current });
  return chunks.length ? chunks : [{ episodes: [] }];
}

export function buildFoundationInput(
  context: FoundationContext,
  episodeNumbers: number[],
  kind: "P1" | "P2",
  prior: string,
  assetKind?: "characters" | "scenes" | "props"
) {
  const episodes = episodeNumbers.map((number) => context.episodeScenes.get(number)).filter(Boolean) as FoundationEpisode[];
  const preludeEpisodes = context.preludeEpisodes ?? [];
  const firstFormalEpisodeNumber = context.episodes[0]?.number;
  // 前置资料只在首个正式分片注入一次；后续分片通过 prior_summary / prior_assets
  // 继承已经建立的事实，避免同一份第0集辅助内容随每次调用重复发送。
  const includePrelude = episodeNumbers.includes(firstFormalEpisodeNumber ?? Number.MIN_SAFE_INTEGER);
  const base = {
    project: {
      title: context.project.title,
      style: context.project.style ?? "未选择",
      aspect_ratio: context.project.aspectRatio
    },
    chunk_episodes: episodes.map((episode) => ({
      number: episode.number,
      title: episode.title,
      scenes: episode.scenes
    })),
    ...(includePrelude && preludeEpisodes.length ? {
      prelude_context: preludeEpisodes.map((episode) => ({
        number: episode.number,
        title: episode.title,
        scenes: context.episodeScenes.get(episode.number)?.scenes ?? []
      }))
    } : {})
  };
  if (kind === "P1") {
    return {
      ...base,
      prior_summary: prior,
      is_first_chunk: !prior,
      total_episode_count: context.episodes.length
    };
  }
  const contracts = context.contracts
    .filter((contract) => contract.user_answer && contractAppliesToAnyEpisode(
      {
        scope_mode: contract.scope_mode,
        target_episode_numbers: contract.target_episode_numbers
      },
      episodeNumbers,
      context.episodes.map((episode) => episode.number)
    ))
    // 适用范围已经由编排层裁剪；模型只需要看到当前分片可用的规则本身，
    // 不再把全剧集号列表作为重复元数据带入每个 P2 请求。
    .map(({ category, user_answer }) => ({ category, user_answer }));
  return {
    ...base,
    prior_assets: prior,
    is_first_chunk: !prior,
    asset_kind: assetKind,
    ...(contracts.length ? { presentation_contracts: contracts } : {})
  };
}

export function buildFoundationPrompt(stageCode: FoundationStageCode, input: unknown, scopeLine?: string): string {
  const stage = PROJECT_FOUNDATION_STAGES.find((item) => item.code === stageCode);
  return [
    `使用 $${stage?.skill} 完成当前${stageCode}岗位任务。`,
    ...(scopeLine ? [scopeLine] : []),
    "如果 INPUT_JSON 含 prelude_context，它是第1集以前的剧名、人物小传、剧情梗概或第0集辅助资料，只用于理解编剧意图和建立全剧资产；不得把它写入正式 episodes，不得因此把第1集及后续集号顺延，也不得为它安排 E0–E5 单集生产。",
    ...(stageCode === "P1" ? [
      "表现规范由 P1 直接做语义判断：只有当原文明确存在需要定义视觉/听觉呈现方式的剧情内非常规元素时，才输出 presentation_decisions_needed。普通语境中的“系统”或“面板”等词（例如平台推荐算法、系统管理、系统自动处理）不得生成 system 确认项；不能仅凭关键词推断。每条确认项必须带 episode_number、真实存在的 source_node_refs，以及可在这些源节点中逐字找到的 evidence；无法判断或无法锚定原文时，不要输出确认项，改在 issues 中说明。若同一规则在多个正式集重复出现，episode_numbers 必须列出全部受影响正式集，episode_number 仍表示主证据所在集；不要把前置资料当成正式集。相同语义规则跨分片/跨集重复输出时，使用同一个不含集号的 rule_key；不同规则不要复用 rule_key。"
    ] : []),
    ...(stageCode === "P2" ? [
      "若 INPUT_JSON 含 presentation_contracts，其中的 user_answer 是当前分片的绑定表现规范，必须优先于模型惯性或关键词联想。category=system 且答案明确采用系统面板/UI/界面/窗口作为信息载体时：系统音、系统提示、系统窗口、系统面板只能作为 PROP（剧情内 UI 载体）或场景中的信息表现，不得建立 CH 人物、GROUP 或 BEAST 资产。注意不要把两类对象混为一谈：如果原文明确写出“系统伪人”“系统残核”“伪人脸”等会攻击、寄生、逃逸或被消灭的实体，它是非人叙事角色，type 必须为 BEAST，不能为 CH；其系统提示载体仍按已确认规范作为 PROP。不要仅因资产名含“系统”就删除原文明确存在的实体。"
    ] : []),
    "只处理INPUT_JSON，不修改任何本地文件，不输出分析过程、Markdown或自评分。",
    "严格遵守该Skill的字段所有权和Output Contract，只返回一个合法JSON对象。",
    "遇到真实问题按契约输出issue；不得为了过审谎报完成。",
    "INPUT_JSON:",
    JSON.stringify(input)
  ].join("\n\n");
}

/** P1 压缩摘要（作为下一分片的 prior_summary，只带稳定事实，不带原文）。 */
export function compactP1Prior(output: P1Output): string {
  return JSON.stringify({
    episodes: output.episodes.map((e) => ({ number: e.number, one_line_progress: e.one_line_progress, end_state: e.end_state })),
    relationships: output.relationships,
    secrets: output.secrets,
    story_contract: output.story_contract,
    presentation_decisions_needed: output.presentation_decisions_needed ?? []
  });
}

/** P1 只为正式生产集输出策划条目；模型偶尔回显辅助第0集时，确定性丢弃。 */
export function stripPreludeP1Episodes(output: P1Output): P1Output {
  return {
    ...output,
    episodes: output.episodes.filter((episode) => episode.number >= 1)
  };
}

/** 检查 P1 单个分片是否完整，避免模型漏掉分片末尾的集数后才在全剧门禁阶段失败。 */
export function inspectP1ChunkCoverage(
  output: Pick<P1Output, "episodes">,
  expectedEpisodeNumbers: number[]
): P1ChunkCoverage {
  const expected = [...new Set(expectedEpisodeNumbers.filter((number) => Number.isInteger(number)))].sort((a, b) => a - b);
  const counts = new Map<number, number>();
  let invalid = 0;
  for (const episode of output.episodes ?? []) {
    const number = episode?.number;
    if (!Number.isInteger(number)) {
      invalid += 1;
      continue;
    }
    counts.set(number, (counts.get(number) ?? 0) + 1);
  }
  const actual = [...counts.keys()].sort((a, b) => a - b);
  const expectedSet = new Set(expected);
  return {
    expected,
    actual,
    missing: expected.filter((number) => !counts.has(number)),
    unexpected: actual.filter((number) => !expectedSet.has(number)),
    duplicates: actual.filter((number) => (counts.get(number) ?? 0) > 1),
    invalid
  };
}

/**
 * 用 P1 自己给出的原文证据反查源节点，修正模型偶尔错位的 source_node_refs。
 * 这里只做确定性的文本定位，不替 P1 判断是否需要表现规范。
 */
export function reanchorP1PresentationDecisions(output: P1Output, context: FoundationContext): P1Output {
  const decisions = output.presentation_decisions_needed?.map((decision) => {
    const declaredEpisodeNumbers = parsePresentationEpisodeNumbers(decision.episode_numbers);
    const episodeNumbers = declaredEpisodeNumbers.length
      ? declaredEpisodeNumbers
      : typeof decision.episode_number === "number" && decision.episode_number >= 1
        ? [decision.episode_number]
        : [];
    const normalizedDecision = episodeNumbers.length
      ? { ...decision, episode_numbers: episodeNumbers }
      : decision;
    const episodeNumber = decision.episode_number;
    const sourceEpisode = typeof episodeNumber === "number" ? context.episodeScenes.get(episodeNumber) : undefined;
    if (!sourceEpisode || !decision.evidence?.trim()) return normalizedDecision;
    const sourceNodes = sourceEpisode.scenes.flatMap((scene) => scene.source_nodes);
    const clauses = splitPresentationEvidence(decision.evidence);
    const matchedRefs = clauses
      .map((clause) => sourceNodes.find((node) => normalizePresentationEvidence(`${node.speaker ?? ""}：${node.text}`).includes(normalizePresentationEvidence(clause))))
      .filter((node): node is SourceNode => Boolean(node))
      .map((node) => node.source_node_id);
    if (clauses.length && matchedRefs.length === clauses.length) {
      return { ...normalizedDecision, source_node_refs: [...new Set(matchedRefs)] };
    }
    return normalizedDecision;
  });
  return decisions ? { ...output, presentation_decisions_needed: decisions } : output;
}

/** P2 已确认资产名（作为下一分片的 prior_assets，避免重名）。 */
export function compactP2Prior(outputs: P2Output[]): string {
  const assets = new Map<string, { name: string; type: P2Asset["type"]; parent_name: string | null }>();
  for (const output of outputs) {
    for (const asset of output.assets) {
      if (!assets.has(asset.name)) {
        assets.set(asset.name, {
          name: asset.name,
          type: asset.type,
          parent_name: asset.parent_name ?? null
        });
      }
    }
  }
  // 后续分片不仅需要知道“这个主资产已经存在”，还必须知道其类型；
  // 否则模型在跨分片挂接分资产时容易把 CH/LOC/PROP 混挂，最后才被 P3 拦截。
  return JSON.stringify([...assets.values()]);
}

export function mergeP1Outputs(outputs: P1Output[]): P1Output {
  const episodeByNumber = new Map<number, P1Output["episodes"][number]>();
  const relationships = new Map<string, P1Output["relationships"][number]>();
  const secrets: P1Output["secrets"] = [];
  const foreshadowing: P1Output["foreshadowing"] = [];
  const boundaries: P1Output["boundaries"] = [];
  const immutableFacts: P1Fact[] = [];
  const issues: FoundationIssue[] = [];
  const presentationDecisions = new Map<string, NonNullable<P1Output["presentation_decisions_needed"]>[number]>();
  let storyContract: P1Output["story_contract"] = { genre: "", perspective: "", core_desire: "", immutable_facts: [] };

  for (const output of outputs) {
    if (output.story_contract?.genre || output.story_contract?.perspective || output.story_contract?.core_desire) {
      storyContract = { ...storyContract, ...output.story_contract };
    }
    for (const fact of output.story_contract?.immutable_facts ?? []) {
      if (!immutableFacts.some((item) => item.fact === fact.fact)) immutableFacts.push(fact);
    }
    for (const episode of output.episodes ?? []) episodeByNumber.set(episode.number, episode);
    for (const rel of output.relationships ?? []) {
      const key = `${rel.a}↔${rel.b}`;
      const existing = relationships.get(key);
      if (!existing) relationships.set(key, rel);
      else existing.stages.push(...rel.stages);
    }
    secrets.push(...(output.secrets ?? []));
    foreshadowing.push(...(output.foreshadowing ?? []));
    boundaries.push(...(output.boundaries ?? []));
    issues.push(...(output.issues ?? []));
    for (const decision of output.presentation_decisions_needed ?? []) {
      // 同一语义规则可以在不同集出现；按稳定语义键合并，并把受影响集号并入
      // episode_numbers。源证据仍保留在主证据集，避免把其它集的节点误接到本集。
      const decisionKey = presentationDecisionKey(decision);
      const existing = presentationDecisions.get(decisionKey);
      if (!existing) {
        presentationDecisions.set(decisionKey, {
          ...decision,
          source_node_refs: [...new Set(decision.source_node_refs ?? [])],
          episode_numbers: parsePresentationEpisodeNumbers(decision.episode_numbers).length
            ? parsePresentationEpisodeNumbers(decision.episode_numbers)
            : typeof decision.episode_number === "number" && decision.episode_number >= 1
              ? [decision.episode_number]
              : undefined
        });
        continue;
      }
      if (existing.episode_number === decision.episode_number) {
        existing.source_node_refs = [...new Set([...(existing.source_node_refs ?? []), ...(decision.source_node_refs ?? [])])];
      }
      existing.episode_numbers = parsePresentationEpisodeNumbers([
        ...(existing.episode_numbers ?? []),
        ...(decision.episode_numbers ?? []),
        ...(typeof existing.episode_number === "number" ? [existing.episode_number] : []),
        ...(typeof decision.episode_number === "number" ? [decision.episode_number] : [])
      ]);
      existing.options = [...new Set([...(existing.options ?? []), ...(decision.options ?? [])])];
      if (!existing.evidence && decision.evidence) existing.evidence = decision.evidence;
      if (!existing.episode_number && decision.episode_number) existing.episode_number = decision.episode_number;
      if (!existing.rule_key && decision.rule_key) existing.rule_key = decision.rule_key;
    }
  }
  storyContract.immutable_facts = immutableFacts;
  return {
    schema: "PROJECT_MEMORY_V2",
    story_contract: storyContract,
    episodes: [...episodeByNumber.values()].sort((a, b) => a.number - b.number),
    relationships: [...relationships.values()],
    secrets,
    foreshadowing,
    boundaries,
    presentation_decisions_needed: [...presentationDecisions.values()],
    issues
  };
}

export function mergeP2Outputs(outputs: P2Output[]): P2Output {
  const assetByName = new Map<string, P2Asset>();
  const linksByScene = new Map<string, Set<string>>();
  const issues: FoundationIssue[] = [];
  for (const output of outputs) {
    for (const asset of output.assets ?? []) {
      const existing = assetByName.get(asset.name);
      if (!existing) {
        assetByName.set(asset.name, { ...asset, scene_refs: [...asset.scene_refs] });
        continue;
      }
      existing.scene_refs = [...new Set([...existing.scene_refs, ...asset.scene_refs])];
      existing.aliases = [...new Set([...existing.aliases, ...asset.aliases])];
      if (!existing.first_seen_node && asset.first_seen_node) existing.first_seen_node = asset.first_seen_node;
      if (asset.evidence && !existing.evidence) existing.evidence = asset.evidence;
    }
    for (const link of output.scene_asset_links ?? []) {
      const set = linksByScene.get(link.scene_id) ?? new Set<string>();
      for (const name of link.asset_names ?? []) set.add(name);
      linksByScene.set(link.scene_id, set);
    }
    issues.push(...(output.issues ?? []));
  }
  return {
    assets: [...assetByName.values()],
    scene_asset_links: [...linksByScene.entries()].map(([scene_id, names]) => ({ scene_id, asset_names: [...names] })),
    issues
  };
}

/** P3 基础库门禁（确定性校验）：返回 issue 列表；BLOCKER 会中止。 */
export function validateFoundationP1(output: P1Output, context: FoundationContext): FoundationIssue[] {
  const issues: FoundationIssue[] = [];
  const numbers = new Set(output.episodes.map((e) => e.number));
  for (const episode of context.episodes) {
    if (!numbers.has(episode.number)) {
      issues.push({ coordinate: `P1.episode.${episode.number}`, code: "EPISODE_MISSING", severity: "BLOCKER", owner: "P3", expected: "每集必须有策划条目", evidence: `第${episode.number}集缺失` });
    }
  }
  for (const episode of output.episodes) {
    const nodeIds = context.episodeNodeIds.get(episode.number) ?? new Set<string>();
    for (const ref of episode.source_node_refs ?? []) {
      if (!nodeIds.has(ref)) {
        issues.push({ coordinate: `P1.episode.${episode.number}`, code: "SOURCE_NODE_INVALID", severity: "MAJOR", owner: "P3", expected: "source_node_refs 必须真实存在", evidence: `${ref} 不在第${episode.number}集节点集中` });
      }
    }
  }
  for (const [index, decision] of (output.presentation_decisions_needed ?? []).entries()) {
    const episodeNumber = decision.episode_number;
    const episodeNumbers = parsePresentationEpisodeNumbers(
      decision.episode_numbers?.length ? decision.episode_numbers : [episodeNumber]
    );
    const refs = decision.source_node_refs ?? [];
    const sourceEpisode = typeof episodeNumber === "number" ? context.episodeScenes.get(episodeNumber) : undefined;
    const sourceNodes = sourceEpisode?.scenes.flatMap((scene) => scene.source_nodes) ?? [];
    const referencedNodes = sourceNodes.filter((node) => refs.includes(node.source_node_id));
    const evidence = normalizePresentationEvidence(decision.evidence ?? "");
    const markerEvidence = isExplicitPresentationMarker(decision.evidence ?? "");
    const evidenceInOneNode = referencedNodes.some((node) => {
      const source = normalizePresentationEvidence(`${node.speaker ?? ""}：${node.text}`);
      return source.includes(evidence);
    });
    // 一条证据可以合理地跨越多个相邻源节点（例如动作、音效、结果各占一行）。
    // 仍要求所有引用节点真实存在，并按原文顺序拼接后逐字可定位，避免放松为“关键词命中”。
    const evidenceInReferencedNodes = normalizePresentationEvidence(
      sourceNodes
        .filter((node) => refs.includes(node.source_node_id))
        .map((node) => `${node.speaker ?? ""}：${node.text}`)
        .join("")
    ).includes(evidence);
    const evidenceClausesGrounded = splitPresentationEvidence(decision.evidence ?? "").every((clause) => {
      const normalizedClause = normalizePresentationEvidence(clause);
      return normalizedClause.length >= 2 && referencedNodes.some((node) => {
        const source = normalizePresentationEvidence(`${node.speaker ?? ""}：${node.text}`);
        return source.includes(normalizedClause);
      });
    });
    const evidenceGrounded = (evidence.length >= 4 || markerEvidence) &&
      (evidenceInOneNode || evidenceInReferencedNodes || evidenceClausesGrounded);
    const unknownEpisodeNumbers = episodeNumbers.filter((number) => !context.episodeScenes.has(number));
    if (!decision.category || !decision.question || !Array.isArray(decision.options) || decision.options.length < 2 ||
      !Number.isInteger(episodeNumber) || !sourceEpisode || !episodeNumbers.length || unknownEpisodeNumbers.length ||
      !refs.length || refs.length !== referencedNodes.length || !evidenceGrounded) {
      const invalidRefs = refs.filter((ref) => !sourceNodes.some((node) => node.source_node_id === ref));
      const reasons: string[] = [];
      if (!Number.isInteger(episodeNumber)) reasons.push("集号无效或缺失");
      else if (!sourceEpisode) reasons.push("找不到该集原文");
      if (unknownEpisodeNumbers.length) reasons.push("影响集不存在：" + unknownEpisodeNumbers.join("、"));
      if (!refs.length) reasons.push("没有引用源节点");
      if (invalidRefs.length) reasons.push("引用节点不存在：" + invalidRefs.join("、"));
      if (refs.length !== referencedNodes.length && !invalidRefs.length) reasons.push("引用节点重复或数量不一致");
      if (!decision.question) reasons.push("确认问题为空");
      if (!Array.isArray(decision.options) || decision.options.length < 2) reasons.push("可选方案少于2项");
      if (evidence.length < 4 || !evidenceGrounded) reasons.push("证据未能在引用节点中逐字定位");
      const episodeLabel = Number.isInteger(episodeNumber) ? "第" + episodeNumber + "集" : "集号未知";
      const evidenceLabel = decision.evidence?.trim()
        ? "证据“" + decision.evidence.trim().replace(/\s+/g, " ").slice(0, 120) + "”"
        : "未提供证据";
      const readableEvidence = (decision.category || "未命名类别") + "（" + episodeLabel + "）：" +
        (reasons.join("；") || "未通过原文锚定校验") + "；" + evidenceLabel +
        "；引用节点：" + (refs.length ? refs.join("、") : "无");
      issues.push({
        coordinate: `P1.presentation_decisions_needed.${index}`,
        code: "PRESENTATION_DECISION_UNGROUNDED",
        severity: "BLOCKER",
        owner: "P1",
        expected: "表现规范必须由 P1 语义判断，并绑定集号、真实源节点和原文证据",
        evidence: readableEvidence
      });
    }
  }
  return issues;
}

function normalizePresentationEvidence(value: string) {
  return value
    .replace(/[\s,，。.!！？?：:；;、"“”‘’（）()【】[\]△]/g, "")
    .trim();
}

function isExplicitPresentationMarker(value: string) {
  const marker = value.trim();
  // 场记标记（如“【闪回】”）去掉括号后可能不足 4 个字，
  // 但只要它本身是完整标记且能在真实源节点中定位，就属于有效证据。
  return /^(?:【[^【】\r\n]{2,24}】|\[[^\[\]\r\n]{2,24}\])$/u.test(marker);
}

function splitPresentationEvidence(value: string) {
  return value
    .split(/[。！？!?；;]+/)
    .map((part) => part
      .trim()
      // 证据常写成“第一句。”“第二句！”；按句末标点切分后，
      // 引号会落在相邻分句的边缘。先去掉边缘引号，避免把引号残片
      // 当成独立证据，再被 reanchor 误匹配到无关节点。
      .replace(/^[\s"'“”‘’「」『』【】]+/u, "")
      .replace(/[\s"'“”‘’「」『』【】]+$/u, "")
      .trim())
    .filter(Boolean);
}

const P2_ALLOWED_TYPES = new Set(["CH", "GROUP", "BEAST", "LOC", "PROP"]);
const P2_JUNK_PATTERN = /(?:os|OS)(?:\s|$)|Q版|Q\s*[A-Za-z]|^[「【】】]*[Qq][\u4e00-\u9fa5]{1,3}$/;
/** 过渡性场次标题片段，不是真实单一物理地点（MAJOR 非阻断，落库时过滤） */
const P2_SCENE_FRAGMENT_PATTERN = /->|快切|各处|各地|同时|转场/;

export function validateFoundationP2(output: P2Output, context: FoundationContext): FoundationIssue[] {
  const issues: FoundationIssue[] = [];
  const seenNames = new Set<string>();
  const mainNames = new Set<string>();
  const sceneIds = new Set<string>();
  for (const episode of context.episodeScenes.values()) {
    for (const scene of episode.scenes) sceneIds.add(scene.scene_id);
  }
  const allNodeIds = new Set<string>();
  for (const ids of context.episodeNodeIds.values()) for (const id of ids) allNodeIds.add(id);

  for (const asset of output.assets ?? []) {
    const name = asset.name?.trim();
    if (!name) {
      issues.push({ coordinate: "P2.asset", code: "ASSET_NAME_EMPTY", severity: "BLOCKER", owner: "P3", expected: "资产名非空", evidence: "存在空名称资产" });
      continue;
    }
    if (seenNames.has(name)) {
      issues.push({ coordinate: `P2.asset.${name}`, code: "ASSET_DUPLICATE", severity: "BLOCKER", owner: "P3", expected: "资产名唯一", evidence: `重复资产：${name}` });
    }
    seenNames.add(name);
    const qVersionConfirmed = context.contracts.some((contract) => contract.category === "q_version");
    const qVersionScriptHit = context.scriptContainsQVersion && /Q版/.test(name);
    if (P2_JUNK_PATTERN.test(name) && !((qVersionConfirmed || qVersionScriptHit) && /Q版/.test(name))) {
      issues.push({ coordinate: `P2.asset.${name}`, code: "ASSET_JUNK_NAME", severity: "BLOCKER", owner: "P3", expected: "资产名不得携带说话人标注", evidence: `脏名：${name}` });
    }
    if (asset.type === "LOC" && P2_SCENE_FRAGMENT_PATTERN.test(name)) {
      issues.push({ coordinate: `P2.asset.${name}`, code: "SCENE_NAME_FRAGMENT", severity: "MAJOR", owner: "P3", expected: "场景资产应为单一物理地点，过渡性场次标题不建资产", evidence: `场景名含过渡片段：${name}` });
    }
    if (!P2_ALLOWED_TYPES.has(asset.type)) {
      issues.push({ coordinate: `P2.asset.${name}`, code: "ASSET_TYPE_INVALID", severity: "BLOCKER", owner: "P3", expected: "type ∈ CH/GROUP/BEAST/LOC/PROP", evidence: `非法类型：${asset.type}` });
    }
    if (isSystemNonHumanAssetName(name) && asset.type === "CH") {
      issues.push({ coordinate: `P2.asset.${name}`, code: "SYSTEM_NON_HUMAN_TYPE_MISMATCH", severity: "BLOCKER", owner: "P2", expected: "原文明确行动的系统伪人/系统残核应归为 BEAST，系统 UI 另归 PROP", evidence: `${name} 被归为 CH，但原文名称表示非人叙事实体` });
    }
    if (isSystemUiCarrierAssetName(name) && asset.type !== "PROP" && systemUiContractAppliesToAsset(asset, context)) {
      issues.push({ coordinate: `P2.asset.${name}`, code: "SYSTEM_UI_TYPE_MISMATCH", severity: "BLOCKER", owner: "P2", expected: "已确认的系统 UI 载体只能归为 PROP，不建立人物资产", evidence: `${name} 被归为 ${asset.type}，与已确认的系统面板/UI规范冲突` });
    }
    if (asset.parent_name) mainNames.add(asset.parent_name);
    else mainNames.add(name);
    if (asset.first_seen_node && !allNodeIds.has(asset.first_seen_node)) {
      issues.push({ coordinate: `P2.asset.${name}`, code: "FIRST_SEEN_INVALID", severity: "MAJOR", owner: "P3", expected: "first_seen_node 必须真实存在", evidence: `${asset.first_seen_node} 不在任何集节点集中` });
    }
    for (const sceneId of asset.scene_refs ?? []) {
      if (!sceneIds.has(sceneId)) {
        issues.push({ coordinate: `P2.asset.${name}`, code: "SCENE_REF_INVALID", severity: "MAJOR", owner: "P3", expected: "scene_refs 必须真实存在", evidence: `场次 ${sceneId} 不存在` });
      }
    }
  }
  for (const asset of output.assets ?? []) {
    if (asset.parent_name && !mainNames.has(asset.parent_name)) {
      issues.push({ coordinate: `P2.asset.${asset.name}`, code: "PARENT_MISSING", severity: "BLOCKER", owner: "P3", expected: "分资产的主资产必须存在", evidence: `主资产缺失：${asset.parent_name}` });
    }
  }
  // 分资产与主资产必须同类型（人物状态/服装分资产也是 CH，保证同一模板派生）
  const typeByName = new Map((output.assets ?? []).map((asset) => [asset.name, asset.type]));
  for (const asset of output.assets ?? []) {
    if (!asset.parent_name) continue;
    const parentType = typeByName.get(asset.parent_name);
    if (parentType && parentType !== asset.type) {
      issues.push({ coordinate: `P2.asset.${asset.name}`, code: "SUB_TYPE_MISMATCH", severity: "BLOCKER", owner: "P3", expected: "分资产与主资产类型一致（人物分状态也是 CH）", evidence: `${asset.name} 类型 ${asset.type} ≠ 主资产 ${asset.parent_name} 类型 ${parentType}` });
    }
  }
  for (const link of output.scene_asset_links ?? []) {
    if (!sceneIds.has(link.scene_id)) {
      issues.push({ coordinate: `P2.link.${link.scene_id}`, code: "LINK_SCENE_INVALID", severity: "MAJOR", owner: "P3", expected: "场次关联的 scene_id 必须真实存在", evidence: `场次 ${link.scene_id} 不存在` });
    }
  }
  return issues;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function requireP1(value: Record<string, unknown>): P1Output {
  if (!Array.isArray(value.episodes)) throw new Error("P1返回缺少episodes数组。");
  return value as unknown as P1Output;
}

export function requireP2(value: Record<string, unknown>): P2Output {
  if (!Array.isArray(value.assets)) throw new Error("P2返回缺少assets数组。");
  return value as unknown as P2Output;
}
