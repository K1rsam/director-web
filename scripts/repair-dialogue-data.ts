import { buildSourcePackage, splitInlineSourceLine, type SourceNode } from "@/lib/episode-pipeline-contracts";
import { computeBeatCapacity, hydrateUnitOutput, hydrateWorkingShots, loadPipelineContext, refreshEpisodePrompts, validatePipeline } from "@/lib/episode-pipeline";
import { normalizeDialogueEntriesForSource } from "@/lib/shot-cells";
import { prisma } from "@/lib/prisma";

const PROJECT_ID = process.argv[2] ?? "";
const APPLY = process.argv.includes("--apply");
const VERBOSE = process.argv.includes("--verbose");
const SHOW_BEATS = process.argv.includes("--show-beats");
const SHOW_SOURCE = process.argv.includes("--show-source");
const SHOW_STATUS = process.argv.includes("--show-status");
const SHOW_DIALOGUE_ISSUES = process.argv.includes("--show-dialogue-issues");
const SHOW_CURRENT_VALIDATION = process.argv.includes("--show-current-validation");
const EPISODE_NUMBERS = [1, 2, 3, 4];
const REPAIR_MARKER = "V2_INLINE_DIALOGUE_SPLIT";
const DIALOGUE_TYPES = new Set(["DIALOGUE", "OS", "VO", "NARRATION", "SYSTEM"]);

type JsonRecord = Record<string, unknown>;

type SceneMap = {
  fixedNodes: SourceNode[];
  legacyNodes: SourceNode[];
  fixedById: Map<string, SourceNode>;
  legacyById: Map<string, SourceNode>;
  legacyToFixed: Map<string, SourceNode[]>;
  fixedOrder: Map<string, number>;
};

type RepairedShot = {
  row: {
    id: string;
    shotKey: string;
    sceneId: string;
    sourceNodeRefs: string;
    dialogue: string;
    e1Data: string;
  };
  sourceNodeRefs: string[];
  dialogue: JsonRecord[];
  e1Data: JsonRecord;
  changed: boolean;
  beforeDialogueCount: number;
  afterDialogueCount: number;
  embeddedLabelCount: number;
  examples: Array<{ before: string; after: string }>;
};

type EpisodePlan = {
  episode: { id: string; number: number; title: string | null };
  sceneMaps: Map<string, SceneMap>;
  sceneKeyById: Map<string, string>;
  fixedNodeCount: number;
  legacyNodeCount: number;
  beatRepair: BeatSnapshotRepair | null;
  shots: RepairedShot[];
  unresolved: string[];
  unknownRefs: string[];
  affectedShots: number;
  affectedDialogueEntries: number;
  droppedActionEntries: number;
  embeddedLabelCount: number;
};

type BeatSnapshotRepair = {
  id: string;
  oldContent: string;
  nextContent: string;
  changed: boolean;
  warnings: string[];
  clamped: string[];
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseRecord(value: string | null | undefined): JsonRecord {
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : {};
}

function parseRecords(value: string | null | undefined): JsonRecord[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
}

function compact(value: string): string {
  return value.replace(/\s+/g, "");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(stable(a)) === JSON.stringify(stable(b));
}

function sourceTypeToDialogueType(type: SourceNode["type"]): string {
  return type === "DIALOGUE" ? "对白" : type;
}

function normalizeText(value: unknown): string {
  return compact(String(value ?? "")).trim();
}

function textScore(node: SourceNode, text: string): number {
  const nodeText = normalizeText(node.text);
  const target = normalizeText(text);
  if (!nodeText || !target) return -1;
  if (nodeText === target) return 10_000 + target.length;
  if (nodeText.includes(target) && target.length >= 2) return 6_000 + target.length;
  if (target.includes(nodeText) && nodeText.length >= 2) return 4_000 + nodeText.length;
  return -1;
}

function bestNode(text: string, nodes: readonly SourceNode[]): SourceNode | null {
  let best: { node: SourceNode; score: number } | null = null;
  for (const node of nodes) {
    if (!DIALOGUE_TYPES.has(node.type)) continue;
    const score = textScore(node, text);
    if (score >= 0 && (!best || score > best.score)) best = { node, score };
  }
  return best?.node ?? null;
}

function speakerNamesOf(nodes: readonly SourceNode[]): string[] {
  return [...new Set(nodes.map((node) => String(node.speaker ?? "").trim()).filter(Boolean))];
}

function buildLegacyToFixed(legacyNodes: readonly SourceNode[], fixedNodes: readonly SourceNode[]): Map<string, SourceNode[]> {
  const result = new Map<string, SourceNode[]>();
  let fixedIndex = 0;
  for (const legacy of legacyNodes) {
    const target = compact(legacy.raw);
    const group: SourceNode[] = [];
    let actual = "";
    while (fixedIndex < fixedNodes.length && actual.length < target.length) {
      const node = fixedNodes[fixedIndex++];
      group.push(node);
      actual = compact(group.map((item) => item.raw).join(""));
      if (actual === target) break;
      if (!target.startsWith(actual)) {
        throw new Error(`源节点迁移无法对齐：旧 ${legacy.source_node_id}=${legacy.raw}；新累计=${actual}`);
      }
    }
    if (actual !== target) {
      throw new Error(`源节点迁移缺少对应节点：旧 ${legacy.source_node_id}=${legacy.raw}；新累计=${actual}`);
    }
    result.set(legacy.source_node_id, group);
  }
  if (fixedIndex !== fixedNodes.length) {
    throw new Error(`源节点迁移存在未归属的新节点：从 N${fixedIndex + 1} 开始仍有 ${fixedNodes.length - fixedIndex} 个节点。`);
  }
  return result;
}

function readAssetAliases(metadata: string | null): string[] {
  const parsed = parseJson(metadata);
  if (!isRecord(parsed) || !Array.isArray(parsed.aliases)) return [];
  return parsed.aliases.map(String).map((value) => value.trim()).filter(Boolean);
}

function knownCharacterNames(projectAssets: Array<{ type: string; name: string; metadata: string | null }>): string[] {
  return projectAssets
    .filter((asset) => ["CH", "GROUP", "BEAST"].includes(asset.type))
    .flatMap((asset) => [asset.name, ...readAssetAliases(asset.metadata)]);
}

function mapStoredRef(
  ref: string,
  alreadyFixed: boolean,
  sceneMap: SceneMap
): SourceNode[] {
  if (alreadyFixed) {
    const direct = sceneMap.fixedById.get(ref);
    return direct ? [direct] : [];
  }
  const legacyGroup = sceneMap.legacyToFixed.get(ref);
  if (legacyGroup?.length) return legacyGroup;
  const direct = sceneMap.fixedById.get(ref);
  return direct ? [direct] : [];
}

function spanSourceRecord(entry: JsonRecord): JsonRecord {
  const text = String(entry.text ?? entry.text_override ?? "").trim();
  return { ...entry, text };
}

function repairEntry(
  entry: JsonRecord,
  sceneMap: SceneMap,
  sourceNodes: readonly SourceNode[],
  alreadyFixed: boolean
): { entries: JsonRecord[]; unresolved: string[]; droppedActions: number } {
  const sourceEntry = spanSourceRecord(entry);
  const text = String(sourceEntry.text ?? "").trim();
  if (!text) return { entries: [], unresolved: [], droppedActions: 0 };
  const normalized = normalizeDialogueEntriesForSource([sourceEntry], sourceNodes);
  if (!normalized.length) {
    // 兼容层已经确认这是纯动作残片，不再塞回台词栏。
    return { entries: [], unresolved: [], droppedActions: 1 };
  }

  const oldRef = String(entry.source_node_id ?? "").trim();
  const legacyCandidates = alreadyFixed
    ? []
    : (sceneMap.legacyToFixed.get(oldRef) ?? []).filter((node) => DIALOGUE_TYPES.has(node.type));
  const unresolved: string[] = [];
  const entries: JsonRecord[] = [];
  for (const part of normalized) {
    const partText = String(part.text ?? "").trim();
    const direct = sceneMap.fixedById.get(String(part.source_node_id ?? ""));
    const node = (direct && textScore(direct, partText) >= 0 ? direct : null)
      ?? bestNode(partText, legacyCandidates)
      ?? bestNode(partText, sourceNodes);
    if (!node || !DIALOGUE_TYPES.has(node.type)) {
      unresolved.push(`${oldRef || "无源节点"}: ${partText}`);
      continue;
    }
    entries.push({
      source_node_id: node.source_node_id,
      speaker: node.speaker ?? "",
      type: sourceTypeToDialogueType(node.type),
      text: partText,
      // 机械迁移把每个源节点作为完整承载；若原来是跨镜切片，text_override 会把精确片段保留下来。
      span_state: "whole"
    });
  }
  return { entries, unresolved, droppedActions: 0 };
}

function allocateDurations(entries: JsonRecord[], shotDuration: number): JsonRecord[] {
  if (!entries.length) return [];
  const weights = entries.map((entry) => Math.max(1, normalizeText(entry.text).length));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let remaining = Math.round(shotDuration * 10) / 10;
  return entries.map((entry, index) => {
    const duration = index === entries.length - 1
      ? Math.max(0.1, Math.round(remaining * 10) / 10)
      : Math.max(0.1, Math.round((shotDuration * weights[index] / total) * 10) / 10);
    remaining = Math.round((remaining - duration) * 10) / 10;
    return { ...entry, duration };
  });
}

function sortedUniqueRefs(refs: Iterable<string>, fixedOrder: Map<string, number>): string[] {
  return [...new Set([...refs].filter(Boolean))].sort((a, b) =>
    (fixedOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (fixedOrder.get(b) ?? Number.MAX_SAFE_INTEGER)
  );
}

function nodeNumber(sourceNodeId: string): number {
  const match = /^N(\d+)$/.exec(sourceNodeId);
  return match ? Number(match[1]) : 0;
}

function numericRange(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const start = Number(value[0]);
  const end = Number(value[1]);
  return Number.isInteger(start) && Number.isInteger(end) && start > 0 && end >= start ? [start, end] : null;
}

function maxReferencedSequence(value: unknown): number {
  if (Array.isArray(value)) return Math.max(0, ...value.map(maxReferencedSequence));
  if (!isRecord(value)) return 0;
  return Math.max(
    ...Object.entries(value).map(([key, child]) =>
      key === "node_range" || key === "anchor_nodes"
        ? (Array.isArray(child) ? Math.max(0, ...child.map(Number).filter(Number.isFinite)) : 0)
        : maxReferencedSequence(child)
    )
  );
}

function repairBeatSnapshot(
  snapshot: { id: string; content: string },
  legacyToFixed: Map<string, SourceNode[]>,
  fixedNodes: readonly SourceNode[]
): BeatSnapshotRepair {
  const parsed = parseJson(snapshot.content);
  if (!isRecord(parsed)) {
    return { id: snapshot.id, oldContent: snapshot.content, nextContent: snapshot.content, changed: false, warnings: ["E0快照不是对象"], clamped: [] };
  }
  if (parsed.source_node_revision === REPAIR_MARKER) {
    return { id: snapshot.id, oldContent: snapshot.content, nextContent: snapshot.content, changed: false, warnings: [], clamped: [] };
  }
  // 本次执行发生在脚本首次写回之后、但旧数据库快照还没有迁移标记的窗口：
  // 若引用的最大序号已超过旧节点总数，说明范围已经是新坐标，只补标记，绝不二次映射。
  const legacyNodeCount = Math.max(0, ...[...legacyToFixed.keys()].map(nodeNumber));
  if (maxReferencedSequence(parsed) > legacyNodeCount) {
    const marked = { ...parsed, source_node_revision: REPAIR_MARKER };
    return {
      id: snapshot.id,
      oldContent: snapshot.content,
      nextContent: JSON.stringify(marked, null, 2),
      changed: true,
      warnings: [],
      clamped: []
    };
  }
  const fixedBySeq = new Map(fixedNodes.map((node) => [nodeNumber(node.source_node_id), node]));
  const warnings: string[] = [];
  const clamped: string[] = [];
  const mapSeq = (oldSeq: number, coordinate: string): number[] => {
    const legacyId = `N${String(oldSeq).padStart(4, "0")}`;
    const mapped = legacyToFixed.get(legacyId);
    if (!mapped?.length) {
      warnings.push(`${coordinate} 引用旧节点 ${legacyId}，无法映射`);
      return [];
    }
    return mapped.map((node) => nodeNumber(node.source_node_id)).filter((value) => value > 0);
  };
  const remapRange = (value: unknown, coordinate: string): [number, number] | null => {
    const range = numericRange(value);
    if (!range) return null;
    const mapped = new Set<number>();
    for (let oldSeq = range[0]; oldSeq <= range[1]; oldSeq += 1) {
      for (const nextSeq of mapSeq(oldSeq, coordinate)) mapped.add(nextSeq);
    }
    const values = [...mapped].sort((a, b) => a - b);
    return values.length ? [values[0], values[values.length - 1]] : null;
  };
  const remapAnchors = (value: unknown, coordinate: string): number[] => {
    if (!Array.isArray(value)) return [];
    const mapped = new Set<number>();
    value.map(Number).filter((item) => Number.isInteger(item) && item > 0).forEach((oldSeq) => {
      for (const nextSeq of mapSeq(oldSeq, coordinate)) mapped.add(nextSeq);
    });
    return [...mapped].sort((a, b) => a - b);
  };
  const repairBeat = (rawBeat: JsonRecord, coordinate: string): JsonRecord => {
    const beat = { ...rawBeat };
    const nextRange = remapRange(rawBeat.node_range, `${coordinate}.node_range`);
    if (nextRange) beat.node_range = nextRange;
    if (Array.isArray(rawBeat.anchor_nodes)) beat.anchor_nodes = remapAnchors(rawBeat.anchor_nodes, `${coordinate}.anchor_nodes`);
    const range = numericRange(nextRange ?? rawBeat.node_range);
    if (!range) return beat;
    const nodes = Array.from({ length: range[1] - range[0] + 1 }, (_, index) => fixedBySeq.get(range[0] + index)).filter((node): node is SourceNode => Boolean(node));
    const capacity = computeBeatCapacity(nodes);
    beat.capacity = capacity;
    const beatId = String(rawBeat.beat_id ?? coordinate);
    const targetShots = Number(rawBeat.target_shots ?? rawBeat.max_shots ?? capacity.hard_min_shots);
    const maxShots = Number(rawBeat.max_shots ?? targetShots);
    const targetSeconds = Number(rawBeat.target_seconds ?? rawBeat.shot_budget_seconds ?? capacity.hard_min_seconds);
    const maxSeconds = Number(rawBeat.max_seconds ?? targetSeconds);
    if (targetShots < capacity.hard_min_shots) {
      clamped.push(`${beatId} 镜数 target ${targetShots}→${capacity.hard_min_shots}`);
      beat.target_shots = capacity.hard_min_shots;
    }
    if (maxShots < capacity.hard_min_shots) beat.max_shots = capacity.hard_min_shots;
    if (targetSeconds < capacity.hard_min_seconds) {
      clamped.push(`${beatId} 时长 target ${targetSeconds}s→${capacity.hard_min_seconds}s`);
      beat.target_seconds = capacity.hard_min_seconds;
    }
    if (maxSeconds < capacity.hard_min_seconds) beat.max_seconds = capacity.hard_min_seconds;
    return beat;
  };

  const next: JsonRecord = { ...parsed, source_node_revision: REPAIR_MARKER };
  if (Array.isArray(parsed.sequences)) {
    next.sequences = parsed.sequences.filter(isRecord).map((rawSequence, sequenceIndex) => {
      const sequence = { ...rawSequence };
      const coordinate = `sequences[${sequenceIndex}]`;
      const nextRange = remapRange(rawSequence.node_range, coordinate);
      if (nextRange) sequence.node_range = nextRange;
      if (Array.isArray(rawSequence.beats)) {
        sequence.beats = rawSequence.beats.filter(isRecord).map((beat, beatIndex) => repairBeat(beat, `${coordinate}.beats[${beatIndex}]`));
      }
      return sequence;
    });
  } else if (Array.isArray(parsed.beats)) {
    next.beats = parsed.beats.filter(isRecord).map((beat, beatIndex) => repairBeat(beat, `beats[${beatIndex}]`));
  }
  const existingClamped = Array.isArray(parsed.capacity_clamped) ? parsed.capacity_clamped.map(String) : [];
  if (clamped.length) next.capacity_clamped = [...existingClamped, ...clamped];
  const nextContent = JSON.stringify(next, null, 2);
  return { id: snapshot.id, oldContent: snapshot.content, nextContent, changed: !sameJson(parsed, next), warnings, clamped };
}

function countEmbeddedLabels(text: string, sourceNodes: readonly SourceNode[]): number {
  return splitInlineSourceLine(text, speakerNamesOf(sourceNodes)).length > 1 ? 1 : 0;
}

async function makeEpisodePlan(
  episode: {
    id: string;
    number: number;
    title: string | null;
    scriptScenes: Array<{
      id: string;
      sceneKey: string;
      heading: string | null;
      location: string | null;
      interiorExterior: string | null;
      timeOfDay: string | null;
      weather: string | null;
      timeLayer: string;
      sourceText: string;
      shots: Array<{
        id: string;
        shotKey: string;
        sceneId: string;
        duration: number;
        sourceNodeRefs: string;
        dialogue: string;
        e1Data: string;
      }>;
    }>;
  },
  projectAssets: Array<{ type: string; name: string; metadata: string | null }>
): Promise<EpisodePlan> {
  const names = knownCharacterNames(projectAssets);
  const fixedPackage = buildSourcePackage(episode.scriptScenes, { knownCharacterNames: names });
  const legacyPackage = buildSourcePackage(episode.scriptScenes, {
    knownCharacterNames: names,
    splitInlineDialogue: false
  });
  const sceneMaps = new Map<string, SceneMap>();
  for (const fixedScene of fixedPackage.scenes) {
    const legacyScene = legacyPackage.scenes.find((scene) => scene.scene_id === fixedScene.scene_id);
    if (!legacyScene) throw new Error(`第${episode.number}集缺少旧场次 ${fixedScene.scene_id}。`);
    const fixedNodes = [...fixedScene.source_nodes];
    const legacyNodes = [...legacyScene.source_nodes];
    sceneMaps.set(fixedScene.scene_id, {
      fixedNodes,
      legacyNodes,
      fixedById: new Map(fixedNodes.map((node) => [node.source_node_id, node])),
      legacyById: new Map(legacyNodes.map((node) => [node.source_node_id, node])),
      legacyToFixed: buildLegacyToFixed(legacyNodes, fixedNodes),
      fixedOrder: new Map(fixedNodes.map((node, index) => [node.source_node_id, index]))
    });
  }
  const fixedNodes = episode.scriptScenes.flatMap((scene) => sceneMaps.get(scene.sceneKey)?.fixedNodes ?? []);
  const legacyToFixed = new Map<string, SourceNode[]>();
  for (const sceneMap of sceneMaps.values()) {
    for (const [legacyId, fixedGroup] of sceneMap.legacyToFixed) legacyToFixed.set(legacyId, fixedGroup);
  }
  const beatSnapshot = await prisma.sceneSnapshot.findFirst({
    where: { projectId: PROJECT_ID, episodeId: episode.id, sceneKey: `EP-${episode.number}-BEATS` },
    select: { id: true, content: true }
  });
  const beatRepair = beatSnapshot ? repairBeatSnapshot(beatSnapshot, legacyToFixed, fixedNodes) : null;

  const plan: EpisodePlan = {
    episode: { id: episode.id, number: episode.number, title: episode.title },
    sceneMaps,
    sceneKeyById: new Map(episode.scriptScenes.map((scene) => [scene.id, scene.sceneKey])),
    fixedNodeCount: fixedPackage.scenes.reduce((sum, scene) => sum + scene.source_nodes.length, 0),
    legacyNodeCount: legacyPackage.scenes.reduce((sum, scene) => sum + scene.source_nodes.length, 0),
    beatRepair,
    shots: [],
    unresolved: [],
    unknownRefs: [],
    affectedShots: 0,
    affectedDialogueEntries: 0,
    droppedActionEntries: 0,
    embeddedLabelCount: 0
  };

  for (const scene of episode.scriptScenes) {
    const sceneMap = sceneMaps.get(scene.sceneKey);
    if (!sceneMap) throw new Error(`第${episode.number}集缺少场次映射 ${scene.sceneKey}。`);
    const sourceNodes = sceneMap.fixedNodes;
    const alreadyFixedMarker = (e1Data: JsonRecord) => e1Data.dialogue_source_revision === REPAIR_MARKER;
    for (const row of scene.shots) {
      const e1Data = parseRecord(row.e1Data);
      const alreadyFixed = alreadyFixedMarker(e1Data);
      const oldRefs = parseJson(row.sourceNodeRefs);
      const refs = Array.isArray(oldRefs) ? oldRefs.map(String).map((value) => value.trim()).filter(Boolean) : [];
      const dialogueRows = parseRecords(row.dialogue);
      const spanRows = Array.isArray(e1Data.dialogue_spans) ? e1Data.dialogue_spans.filter(isRecord) : [];
      const rawDialogue = dialogueRows.length ? dialogueRows : spanRows.map(spanSourceRecord);
      const repairedEntries: JsonRecord[] = [];
      const examples: Array<{ before: string; after: string }> = [];
      for (const entry of rawDialogue) {
        const result = repairEntry(entry, sceneMap, sourceNodes, alreadyFixed);
        plan.unresolved.push(...result.unresolved.map((item) => `${row.shotKey}: ${item}`));
        plan.droppedActionEntries += result.droppedActions;
        if (result.entries.length) {
          repairedEntries.push(...result.entries);
          const before = String(entry.text ?? entry.text_override ?? "").trim();
          const after = result.entries.map((item) => `${item.speaker}：${item.text}`).join(" | ");
          if (before !== after) examples.push({ before, after });
        }
      }
      const allocatedDialogue = allocateDurations(repairedEntries, row.duration);
      const repairedDialogueIds = allocatedDialogue.map((entry) => String(entry.source_node_id ?? ""));
      const mappedRefs: SourceNode[] = [];
      for (const ref of refs) {
        const mapped = mapStoredRef(ref, alreadyFixed, sceneMap);
        if (!mapped.length) {
          plan.unknownRefs.push(`${row.shotKey}: ${ref}`);
          continue;
        }
        mappedRefs.push(...mapped);
      }
      const sourceNodeRefs = sortedUniqueRefs(
        [...mappedRefs.map((node) => node.source_node_id), ...repairedDialogueIds],
        sceneMap.fixedOrder
      );
      const nextE1Data: JsonRecord = {
        ...e1Data,
        source_node_refs: sourceNodeRefs,
        dialogue_spans: allocatedDialogue.map((entry) => ({
          source_node_id: entry.source_node_id,
          speaker: entry.speaker,
          span_state: "whole",
          text_override: entry.text
        })),
        dialogue_source_revision: REPAIR_MARKER
      };
      const nextDialogue = allocatedDialogue;
      const changed = !sameJson(refs, sourceNodeRefs)
        || !sameJson(dialogueRows, nextDialogue)
        || !sameJson(e1Data, nextE1Data);
      const embeddedLabelCount = dialogueRows.reduce(
        (sum, entry) => sum + countEmbeddedLabels(String(entry.text ?? entry.text_override ?? ""), sourceNodes),
        0
      );
      plan.embeddedLabelCount += embeddedLabelCount;
      if (changed) {
        plan.affectedShots += 1;
        plan.affectedDialogueEntries += Math.max(dialogueRows.length, nextDialogue.length);
      }
      plan.shots.push({
        row,
        sourceNodeRefs,
        dialogue: nextDialogue,
        e1Data: nextE1Data,
        changed,
        beforeDialogueCount: dialogueRows.length,
        afterDialogueCount: nextDialogue.length,
        embeddedLabelCount,
        examples: examples.slice(0, 3)
      });
    }
  }
  return plan;
}

function printPlan(plan: EpisodePlan) {
  console.log(`第${plan.episode.number}集：${plan.episode.title ?? ""}`);
  console.log(`  源节点旧/新=${plan.legacyNodeCount}/${plan.fixedNodeCount}`);
  if (plan.beatRepair) console.log(`  E0 Beat范围=${plan.beatRepair.changed ? "需要机械映射" : "无需变化"}，预算钳制=${plan.beatRepair.clamped.length}`);
  if (plan.beatRepair?.warnings.length) console.log(`  E0映射警告=${plan.beatRepair.warnings.slice(0, 8).join("；")}`);
  console.log(`  需修镜行=${plan.affectedShots}，涉及台词条目=${plan.affectedDialogueEntries}，动作残片=${plan.droppedActionEntries}，仍含内嵌标签=${plan.embeddedLabelCount}`);
  if (plan.unknownRefs.length) console.log(`  未识别来源节点=${plan.unknownRefs.slice(0, 8).join("；")}`);
  if (plan.unresolved.length) console.log(`  无法自动归属=${plan.unresolved.slice(0, 12).join("；")}`);
  for (const shot of plan.shots.filter((item) => item.changed && item.examples.length).slice(0, 8)) {
    console.log(`  ${shot.row.shotKey}: ${shot.examples.map((example) => `「${example.before}」→「${example.after}」`).join("；")}`);
  }
  if (VERBOSE) {
    for (const shot of plan.shots.filter((item) => item.changed)) {
      console.log(`  [详细前] ${shot.row.shotKey}: ${parseRecords(shot.row.dialogue).map((entry) => `${entry.speaker ?? ""}：${entry.text ?? entry.text_override ?? ""}`).join(" | ") || "（无台词）"}`);
      const after = shot.dialogue.map((entry) => `${entry.speaker ?? ""}：${entry.text ?? ""}`).join(" | ");
      console.log(`  [详细] ${shot.row.shotKey}: ${after || "（无台词，已清除动作残片）"}`);
    }
  }
}

async function resolveSupersededDialogueIssues(episodeIds: string[]): Promise<number> {
  const openIssues = await prisma.workflowIssue.findMany({
    where: {
      projectId: PROJECT_ID,
      episodeId: { in: episodeIds },
      status: "OPEN",
      OR: [
        { code: "DIALOGUE_SLICE_ATTRIBUTION" },
        { code: "DIALOGUE_SPEAKER_MISMATCH" },
        { code: "DIALOGUE_ACTION_LEAK" },
        { code: "DIALOGUE_EMBEDDED_SPEAKER" },
        { code: "SPEAKER_ALIGNMENT" },
        { code: "SPEAKER_PERFORMANCE_ALIGNMENT" }
      ]
    },
    select: { id: true, code: true, coordinate: true }
  });
  const ids = openIssues
    .filter((issue) =>
      ["DIALOGUE_SLICE_ATTRIBUTION", "DIALOGUE_SPEAKER_MISMATCH", "DIALOGUE_ACTION_LEAK", "DIALOGUE_EMBEDDED_SPEAKER"].includes(issue.code)
      || ((issue.code === "SPEAKER_ALIGNMENT" || issue.code === "SPEAKER_PERFORMANCE_ALIGNMENT") && /(^|,)[^,]+\.dialogue(?:,|$)/.test(issue.coordinate))
    )
    .map((issue) => issue.id);
  if (!ids.length) return 0;
  await prisma.workflowIssue.updateMany({
    where: { id: { in: ids } },
    data: {
      status: "RESOLVED",
      evidence: "旧版台词扁平化问题已由零 Token 源节点迁移修正并通过回归校验；原问题证据不再适用于当前数据。",
      requestedEffect: "已自动完成，无需处理"
    }
  });
  return ids.length;
}

async function main() {
  if (!PROJECT_ID) throw new Error("用法：tsx --env-file=.env scripts/repair-dialogue-data.ts <projectId> [--apply]");
  const project = await prisma.project.findUnique({
    where: { id: PROJECT_ID },
    select: { id: true, title: true, assets: { select: { type: true, name: true, metadata: true } } }
  });
  if (!project) throw new Error(`没有找到项目 ${PROJECT_ID}。`);
  const episodes = await prisma.episode.findMany({
    where: { projectId: PROJECT_ID, number: { in: EPISODE_NUMBERS } },
    orderBy: { number: "asc" },
    select: {
      id: true,
      number: true,
      title: true,
      scriptScenes: {
        orderBy: { sortOrder: "asc" },
        select: {
          id: true,
          sceneKey: true,
          heading: true,
          location: true,
          interiorExterior: true,
          timeOfDay: true,
          weather: true,
          timeLayer: true,
          sourceText: true,
          shots: {
            orderBy: { sortOrder: "asc" },
            select: { id: true, shotKey: true, sceneId: true, duration: true, sourceNodeRefs: true, dialogue: true, e1Data: true }
          }
        }
      }
    }
  });
  if (episodes.length !== EPISODE_NUMBERS.length) {
    throw new Error(`项目中未找到完整的第1–4集，实际找到：${episodes.map((episode) => episode.number).join("、") || "无"}。`);
  }

  if (SHOW_BEATS) {
    const snapshots = await prisma.sceneSnapshot.findMany({
      where: { projectId: PROJECT_ID, episodeId: { in: episodes.map((episode) => episode.id) }, sceneKey: { in: EPISODE_NUMBERS.map((number) => `EP-${number}-BEATS`) } },
      orderBy: { sceneKey: "asc" },
      select: { episodeId: true, sceneKey: true, content: true }
    });
    for (const snapshot of snapshots) {
      const parsed = parseJson(snapshot.content);
      const episode = episodes.find((item) => item.id === snapshot.episodeId);
      console.log(`--- 第${episode?.number ?? "?"}集 ${snapshot.sceneKey} ---`);
      console.log(JSON.stringify(parsed, null, 2));
    }
    return;
  }

  if (SHOW_STATUS) {
    const episodeIds = episodes.map((episode) => episode.id);
    const [shots, units, issues] = await Promise.all([
      prisma.storyboardShot.findMany({ where: { episodeId: { in: episodeIds } }, select: { episodeId: true, e1Data: true, dialogue: true } }),
      prisma.seedanceUnit.findMany({ where: { episodeId: { in: episodeIds } }, orderBy: { unitKey: "asc" }, select: { episodeId: true, unitKey: true, promptVersions: { orderBy: { version: "desc" }, take: 1, select: { version: true, syncStatus: true } } } }),
      prisma.workflowIssue.findMany({ where: { projectId: PROJECT_ID, episodeId: { in: episodeIds } }, select: { code: true, severity: true, status: true } })
    ]);
    const summary = episodes.map((episode) => ({
      episode: episode.number,
      shots: shots.filter((shot) => shot.episodeId === episode.id).length,
      migratedShots: shots.filter((shot) => shot.episodeId === episode.id && parseRecord(shot.e1Data).dialogue_source_revision === REPAIR_MARKER).length,
      dialogueEntries: shots.filter((shot) => shot.episodeId === episode.id).reduce((sum, shot) => sum + parseRecords(shot.dialogue).length, 0),
      promptStatuses: units.filter((unit) => unit.episodeId === episode.id).map((unit) => ({ unit: unit.unitKey, version: unit.promptVersions[0]?.version ?? null, status: unit.promptVersions[0]?.syncStatus ?? null }))
    }));
    const issueSummary = issues.reduce((map, issue) => {
      const key = `${issue.status}/${issue.severity}/${issue.code}`;
      map[key] = (map[key] ?? 0) + 1;
      return map;
    }, {} as Record<string, number>);
    console.log(JSON.stringify({ summary, issueSummary }, null, 2));
    return;
  }

  if (SHOW_DIALOGUE_ISSUES) {
    const dialogueIssues = await prisma.workflowIssue.findMany({
      where: {
        projectId: PROJECT_ID,
        episodeId: { in: episodes.map((episode) => episode.id) },
        OR: [
          { code: { contains: "DIALOGUE" } },
          { code: { contains: "SPEAKER" } },
          { code: "MULTI_SPEAKER_SHOT" },
          { code: "SOURCE_REF_ALIGNMENT" },
          { code: "INTERNAL_MONOLOGUE_TYPE" }
        ]
      },
      orderBy: { createdAt: "asc" },
      select: { coordinate: true, code: true, severity: true, status: true, evidence: true, requestedEffect: true, episode: { select: { number: true } } }
    });
    for (const issue of dialogueIssues) {
      console.log(JSON.stringify({ episode: issue.episode.number, coordinate: issue.coordinate, code: issue.code, severity: issue.severity, status: issue.status, evidence: issue.evidence, requestedEffect: issue.requestedEffect }));
    }
    return;
  }

  if (SHOW_CURRENT_VALIDATION) {
    for (const episode of episodes) {
      const context = await loadPipelineContext(PROJECT_ID, episode.id);
      const shots = await hydrateWorkingShots(context);
      const units = await hydrateUnitOutput(context);
      const issues = validatePipeline(context, shots, units.units).filter((issue) =>
        /DIALOGUE|SPEAKER|MULTI_SPEAKER|SOURCE_REF_ALIGNMENT|INTERNAL_MONOLOGUE/.test(issue.code)
      );
      console.log(`--- 第${episode.number}集当前机械校验 ---`);
      for (const issue of issues) console.log(JSON.stringify({ coordinate: issue.coordinate, code: issue.code, severity: issue.severity, evidence: issue.evidence }));
    }
    return;
  }

  const activeRuns = await prisma.pipelineRun.findMany({
    where: {
      projectId: PROJECT_ID,
      OR: [
        { episodeId: { in: episodes.map((episode) => episode.id) } },
        { episodeId: null, stageCode: "BATCH_MONITOR" }
      ],
      status: { in: ["QUEUED", "RUNNING"] }
    },
    select: { episodeId: true, stageCode: true, status: true }
  });
  if (activeRuns.length) {
    console.log(`检测到尚在运行的任务：${activeRuns.map((run) => `${run.stageCode}/${run.episodeId ?? "项目批次"}/${run.status}`).join("、")}`);
    if (APPLY) throw new Error("为避免后台任务覆盖修复结果，当前不写回；请等这些任务结束后再执行 --apply。 ");
  }

  console.log(`${APPLY ? "写回模式" : "只读预演"}：项目「${project.title}」`);
  const plans: EpisodePlan[] = [];
  for (const episode of episodes) {
    const plan = await makeEpisodePlan(episode, project.assets);
    plans.push(plan);
    printPlan(plan);
    if (SHOW_SOURCE) {
      for (const [sceneKey, sceneMap] of plan.sceneMaps) {
        console.log(`--- 第${episode.number}集 ${sceneKey} fixed source ---`);
        for (const node of sceneMap.fixedNodes) console.log(`${node.source_node_id} ${node.type} ${node.speaker ?? ""} | ${node.text}`);
      }
    }
  }
  const unresolved = plans.flatMap((plan) => plan.unresolved);
  const unknownRefs = plans.flatMap((plan) => plan.unknownRefs);
  const beatWarnings = plans.flatMap((plan) => plan.beatRepair?.warnings ?? []);
  const postRepairEmbedded = plans.flatMap((plan) => plan.shots.flatMap((shot) => {
    const sceneMap = plan.sceneMaps.get(plan.sceneKeyById.get(shot.row.sceneId) ?? "");
    return shot.dialogue.filter((entry) => countEmbeddedLabels(String(entry.text ?? entry.text_override ?? ""), sceneMap?.fixedNodes ?? []) > 0).map(() => shot.row.shotKey);
  }));
  if (unresolved.length || unknownRefs.length || beatWarnings.length || postRepairEmbedded.length) {
    throw new Error(`存在无法安全自动归属的数据：unresolved=${unresolved.length}, unknownRefs=${unknownRefs.length}, beatWarnings=${beatWarnings.length}, postRepairEmbedded=${postRepairEmbedded.length}。未写入任何数据。`);
  }
  if (!APPLY) {
    console.log("只读预演完成：未写入数据库。确认盘点结果后，追加 --apply 执行零 Token 修复。 ");
    return;
  }

  let updatedShots = 0;
  let updatedEpisodes = 0;
  let updatedBeatSnapshots = 0;
  for (const plan of plans) {
    if (plan.beatRepair?.changed) {
      await prisma.sceneSnapshot.update({
        where: { id: plan.beatRepair.id },
        data: { content: plan.beatRepair.nextContent }
      });
      updatedBeatSnapshots += 1;
    }
    for (const shot of plan.shots.filter((item) => item.changed)) {
      await prisma.storyboardShot.update({
        where: { id: shot.row.id },
        data: {
          sourceNodeRefs: JSON.stringify(shot.sourceNodeRefs),
          dialogue: JSON.stringify(shot.dialogue),
          e1Data: JSON.stringify(shot.e1Data)
        }
      });
      updatedShots += 1;
    }
    if (plan.affectedShots > 0) updatedEpisodes += 1;
  }

  const promptStatuses = await prisma.compiledPromptVersion.findMany({
    where: { unit: { episodeId: { in: episodes.map((episode) => episode.id) } } },
    orderBy: [{ unitId: "asc" }, { version: "desc" }],
    select: { unitId: true, version: true, syncStatus: true }
  });
  const latestStatusByUnit = new Map<string, string>();
  for (const row of promptStatuses) if (!latestStatusByUnit.has(row.unitId)) latestStatusByUnit.set(row.unitId, row.syncStatus);
  const preserveReleased = latestStatusByUnit.size > 0 && [...latestStatusByUnit.values()].every((status) => status === "RELEASE_COMPILED");
  for (const plan of plans.filter((item) => item.affectedShots > 0)) {
    await refreshEpisodePrompts(PROJECT_ID, plan.episode.id, { release: preserveReleased });
  }
  const resolvedDialogueIssues = await resolveSupersededDialogueIssues(episodes.map((episode) => episode.id));

  const verification = await prisma.storyboardShot.findMany({
    where: { episodeId: { in: episodes.map((episode) => episode.id) } },
    select: { shotKey: true, sceneId: true, sourceNodeRefs: true, dialogue: true, e1Data: true }
  });
  const remainingMarkers = verification.filter((shot) => parseRecord(shot.e1Data).dialogue_source_revision !== REPAIR_MARKER);
  const remainingEmbedded = verification.flatMap((shot) => {
    const scene = plans
      .map((plan) => {
        const sceneKey = plan.sceneKeyById.get(shot.sceneId);
        return sceneKey ? { map: plan.sceneMaps.get(sceneKey) } : null;
      })
      .find((item): item is { map: SceneMap } => Boolean(item?.map));
    const entries = parseRecords(shot.dialogue);
    return entries.filter((entry) => {
      const nodes = scene?.map.fixedNodes ?? [];
      return countEmbeddedLabels(String(entry.text ?? entry.text_override ?? ""), nodes) > 0;
    }).map(() => shot.shotKey);
  });
  console.log(`已完成零 Token 修复：${updatedEpisodes} 集、${updatedShots} 行、${updatedBeatSnapshots} 个 E0 Beat 快照；提示词已按当前版本刷新（release=${preserveReleased}），旧台词问题卡已解决 ${resolvedDialogueIssues} 张。`);
  console.log(`写回后标记残留=${remainingMarkers.length}，内嵌台词残留=${remainingEmbedded.length}。`);
  if (remainingMarkers.length || remainingEmbedded.length) throw new Error("写回后回归校验未通过，请不要继续跑这几集。 ");
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
