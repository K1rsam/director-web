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
  episodes: Array<Episode & { scriptScenes: ScriptScene[] }>;
  /** episodeNumber → 该集解析出的场次与源节点（含每集内稳定 ID） */
  episodeScenes: Map<number, FoundationEpisode>;
  /** episodeNumber → 源节点 ID 全集（用于校验） */
  episodeNodeIds: Map<number, Set<string>>;
  existingAssets: Array<{ code: string; type: string; name: string; status: string }>;
  /** 用户已确认的表现规范（P1 提出 → UI 确认），P2 按它建资产、门禁按它放行 */
  contracts: Array<{ category: string; user_answer: string }>;
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
    source_node_refs?: string[];
    suggested_default?: string;
    /** 轮次：P1 每次重跑输出清单的轮次（同类别已有契约则 +1），供 UI 按轮分组 */
    round?: number;
  }>;
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
  contracts: Array<{ category: string; user_answer: string }> = []
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
  return { projectId: project.id, project, episodes, episodeScenes, episodeNodeIds, existingAssets, contracts, scriptContainsQVersion };
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
    }))
  };
  if (kind === "P1") {
    return {
      ...base,
      prior_summary: prior,
      is_first_chunk: !prior,
      total_episode_count: context.episodes.length
    };
  }
  const contracts = context.contracts.filter((contract) => contract.user_answer);
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
    ...(stageCode === "P1" ? [
      "表现规范由 P1 直接做语义判断：只有当原文明确存在需要定义视觉/听觉呈现方式的剧情内非常规元素时，才输出 presentation_decisions_needed。普通语境中的“系统”或“面板”等词（例如平台推荐算法、系统管理、系统自动处理）不得生成 system 确认项；不能仅凭关键词推断。每条确认项必须带 episode_number、真实存在的 source_node_refs，以及可在这些源节点中逐字找到的 evidence；无法判断或无法锚定原文时，不要输出确认项，改在 issues 中说明。"
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

/** P2 已确认资产名（作为下一分片的 prior_assets，避免重名）。 */
export function compactP2Prior(outputs: P2Output[]): string {
  const names = new Set<string>();
  for (const output of outputs) {
    for (const asset of output.assets) names.add(asset.name);
  }
  return JSON.stringify([...names].map((name) => ({ name })));
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
      const existing = presentationDecisions.get(decision.category);
      if (!existing) {
        presentationDecisions.set(decision.category, {
          ...decision,
          source_node_refs: [...new Set(decision.source_node_refs ?? [])]
        });
        continue;
      }
      existing.source_node_refs = [...new Set([...(existing.source_node_refs ?? []), ...(decision.source_node_refs ?? [])])];
      if (!existing.evidence && decision.evidence) existing.evidence = decision.evidence;
      if (!existing.episode_number && decision.episode_number) existing.episode_number = decision.episode_number;
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
    const refs = decision.source_node_refs ?? [];
    const sourceEpisode = typeof episodeNumber === "number" ? context.episodeScenes.get(episodeNumber) : undefined;
    const sourceNodes = sourceEpisode?.scenes.flatMap((scene) => scene.source_nodes) ?? [];
    const referencedNodes = sourceNodes.filter((node) => refs.includes(node.source_node_id));
    const evidence = normalizePresentationEvidence(decision.evidence ?? "");
    const evidenceGrounded = evidence.length >= 4 && referencedNodes.some((node) => {
      const source = normalizePresentationEvidence(`${node.speaker ?? ""}：${node.text}`);
      return source.includes(evidence);
    });
    if (!decision.category || !decision.question || !Array.isArray(decision.options) || decision.options.length < 2 ||
      !Number.isInteger(episodeNumber) || !sourceEpisode || !refs.length || refs.length !== referencedNodes.length || !evidenceGrounded) {
      issues.push({
        coordinate: `P1.presentation_decisions_needed.${index}`,
        code: "PRESENTATION_DECISION_UNGROUNDED",
        severity: "BLOCKER",
        owner: "P1",
        expected: "表现规范必须由 P1 语义判断，并绑定集号、真实源节点和原文证据",
        evidence: `${decision.category || "未命名类别"} 未能通过原文锚定校验`
      });
    }
  }
  return issues;
}

function normalizePresentationEvidence(value: string) {
  return value
    .replace(/[\s,，。.!！？?：:；;、"“”‘’（）()【】[\]]/g, "")
    .trim();
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

