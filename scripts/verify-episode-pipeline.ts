import assert from "node:assert/strict";
import {
  buildSourcePackage,
  mergeShotPatches,
  PIPELINE_STAGE_CONFIGS,
  readStageModel,
  type WorkingShot
} from "@/lib/episode-pipeline-contracts";
import { formatDialogueEntries, normalizeDialogueEntriesForSource } from "@/lib/shot-cells";
import { maxShortUnitExceptions, parseShortUnitException } from "@/lib/episode-pipeline-quality";
import { isProductionCliModel, resolveCliModel } from "@/lib/role-runner";
import { compileSeedancePrompts, compactProjectMemoryForEpisode, computeUnitPartition, filterPythonDuplicateReviewIssues, hasOverLimitContinuityRun, executeEpisodePipeline, newRegressionBlockerKeys, newRegressionIssueKeys, planRepairPipeline, repairOwnerForIssue, repairRollbackScope, repairRunPolicy, shouldRollbackRepairRegression, sourceNodeCarrierChanged, validatePipeline, visualStepPartsForShots, workflowIssueKey, type PipelineStageRunner } from "@/lib/episode-pipeline";
import { prisma } from "@/lib/prisma";
import { seedApprovedFoundationFixture } from "./fixtures/approved-foundation";

let lastE5Prompt = "";

const source = buildSourcePackage([
  {
    sceneKey: "1-1",
    heading: "客厅 日 内",
    location: "客厅",
    interiorExterior: "内",
    timeOfDay: "日",
    weather: null,
    timeLayer: "现实",
    sourceText: "1-1\n客厅 日 内\n场景：客厅\n人物：苏远、赵清雅\n道具：手机\n苏远拿起手机。\n苏远：你看。\n赵清雅OS：果然是他。"
  }
]);

assert.equal(source.scenes[0].source_nodes.length, 3);
assert.deepEqual(source.scenes[0].source_nodes.map((node) => node.type), ["ACTION", "DIALOGUE", "OS"]);
assert.equal(source.scenes[0].source_nodes[1].speaker, "苏远");

const flattenedDialogueSource = buildSourcePackage([{
  sceneKey: "3-1",
  heading: "工具间 夜/内",
  location: "工具间",
  interiorExterior: "内",
  timeOfDay: "夜",
  weather: null,
  timeLayer: "现实",
  sourceText: "3-1工具间 夜/内人物：姜恋、时烬、崔健△时烬倚在门口，神色轻松。崔健：你去哪儿了？时烬：去五楼看住处，环境不错。△姜恋（低头）：先吃饭。"
}]);
const flattenedNodes = flattenedDialogueSource.scenes[0].source_nodes;
assert.deepEqual(
  flattenedNodes.map((node) => [node.type, node.speaker, node.text]),
  [
    ["ACTION", null, "时烬倚在门口，神色轻松。"],
    ["DIALOGUE", "崔健", "你去哪儿了？"],
    ["DIALOGUE", "时烬", "去五楼看住处，环境不错。"],
    ["DIALOGUE", "姜恋", "先吃饭。"]
  ],
  "扁平化同一行的多人物台词必须按人物拆成独立源节点"
);
const repairedDialogue = normalizeDialogueEntriesForSource([{
  source_node_id: "N0001",
  speaker: "时烬",
  type: "对白",
  text: "你去哪儿了？时烬：去五楼看住处，环境不错。"
}], flattenedNodes);
assert.deepEqual(
  repairedDialogue.map((entry) => [entry.speaker, entry.text]),
  [["崔健", "你去哪儿了？"], ["时烬", "去五楼看住处，环境不错。"]],
  "旧数据中合并的台词应按源节点恢复真实说话人"
);
assert.equal(
  formatDialogueEntries(repairedDialogue),
  "崔健：“你去哪儿了？”\n时烬：“去五楼看住处，环境不错。”",
  "台词展示应逐条换行"
);

const actionTailSource = buildSourcePackage([{
  sceneKey: "4-2",
  heading: "前台 日/内",
  location: "前台",
  interiorExterior: "内",
  timeOfDay: "日",
  weather: null,
  timeLayer: "现实",
  sourceText: "人物：时烬、姜恋\n时烬：偷东西？姜恋猛回头。"
}]);
assert.deepEqual(
  actionTailSource.scenes[0].source_nodes.map((node) => [node.type, node.speaker, node.text]),
  [["DIALOGUE", "时烬", "偷东西？"], ["ACTION", null, "姜恋猛回头。"]],
  "对白后的无冒号动作必须独立成 ACTION 源节点"
);
const repairedActionTail = normalizeDialogueEntriesForSource([{
  source_node_id: "N0001",
  speaker: "时烬",
  type: "对白",
  text: "偷东西？姜恋猛回头。"
}], actionTailSource.scenes[0].source_nodes);
assert.deepEqual(
  repairedActionTail.map((entry) => [entry.speaker, entry.text]),
  [["时烬", "偷东西？"]],
  "历史台词残片中的尾部动作不能继续进入台词格"
);
const actionColonSource = buildSourcePackage([{
  sceneKey: "4-2",
  heading: "前台 日/内",
  location: "前台",
  interiorExterior: "内",
  timeOfDay: "日",
  weather: null,
  timeLayer: "现实",
  sourceText: "人物：姜恋\n她展开纸团，上面写着：夜间十二点后，不要给任何客人开门。"
}]);
assert.equal(
  actionColonSource.scenes[0].source_nodes[0].type,
  "ACTION",
  "动作描述中的冒号不能伪造说话人"
);

const shots = mergeShotPatches(
  [{ shot_id: "1-1-S001", e1: { visual_goal: "展示证据" }, e2: {}, e3: {}, e4: {} }],
  [{ shot_id: "1-1-S001", action: "set", fields: { action_chain: "苏远拿起手机" } }],
  "e2"
);
assert.equal((shots[0].e2 as Record<string, unknown>).action_chain, "苏远拿起手机");

assert.equal(readStageModel("E5").model, "gpt-6.1-sol");
assert.equal(PIPELINE_STAGE_CONFIGS.length, 6, "E0-E5 六岗流水线");
assert.equal(PIPELINE_STAGE_CONFIGS.every((stage) => isProductionCliModel(stage.model) && stage.reasoningEffort === "medium"), true, "生产岗位统一使用6.1 Sol中档");
const savedCliModel = process.env.CLI_MODEL;
const savedCliModelE0 = process.env.CLI_MODEL_E0;
process.env.CLI_MODEL = "gpt-5.6-luna";
process.env.CLI_MODEL_E0 = "gpt-5.6-luna";
try {
  assert.equal(resolveCliModel("E0", "gpt-5.6-terra"), "gpt-6.1-sol", "旧模型或环境变量不得覆盖当前生产模型");
} finally {
  if (savedCliModel === undefined) delete process.env.CLI_MODEL;
  else process.env.CLI_MODEL = savedCliModel;
  if (savedCliModelE0 === undefined) delete process.env.CLI_MODEL_E0;
  else process.env.CLI_MODEL_E0 = savedCliModelE0;
}

const scopedMemory = compactProjectMemoryForEpisode({
  schema: "P1_MEMORY_V2",
  episodes: [1, 2, 3, 4].map((number) => ({ number, one_line_progress: `第${number}集` })),
  boundaries: [
    { from_episode: 1, to_episode: 2, carry_over: "1→2", source_node_refs: ["N0001"] },
    { from_episode: 3, to_episode: 4, carry_over: "3→4", source_node_refs: ["N0002"] }
  ],
  relationships: [{ a: "甲", b: "乙", stages: [
    { episode_range: "1-2", state: "当前关系", source_node_refs: ["N0003"] },
    { episode_range: "7-9", state: "未来关系", source_node_refs: ["N0004"] }
  ] }],
  secrets: [
    { secret: "已公开", revealed_to_audience_at: "第1集", source_node_refs: ["N0005"] },
    { secret: "未来秘密", revealed_to_audience_at: "第8集", source_node_refs: ["N0006"] }
  ],
  story_contract: { immutable_facts: [{ fact: "稳定事实", source_node_refs: ["N0007"] }] },
  foreshadowing: [{ setup: "伏笔", payoff: "回收", source_node_refs: ["N0008"] }]
}, 2) as Record<string, any>;
assert.deepEqual(scopedMemory.episodes.map((item: Record<string, unknown>) => item.number), [1, 2, 3], "E0/E1 只携带当前集前后邻集摘要");
assert.deepEqual(scopedMemory.boundaries.map((item: Record<string, unknown>) => item.carry_over), ["1→2"], "只携带当前集相邻边界");
assert.equal(scopedMemory.relationships[0].stages.length, 1, "只携带当前集有效的关系阶段");
assert.deepEqual(scopedMemory.secrets.map((item: Record<string, unknown>) => item.secret), ["已公开"], "不得把未来秘密带入当前集");
assert.equal(JSON.stringify(scopedMemory).includes("source_node_refs"), false, "记忆快照不得重复携带源节点引用");

assert.deepEqual(
  planRepairPipeline([{ ownerRole: "E1", severity: "BLOCKER", code: "MULTI_SPEAKER_SHOT" }]),
  { stages: ["E1", "E2", "E3", "E4", "E5"], structuralRebuild: true },
  "E1 拆镜结构卡必须全链重建，不能走单元格 patch"
);
assert.deepEqual(
  planRepairPipeline([{ ownerRole: "E2", severity: "BLOCKER", code: "EMOTION_ABSTRACT" }]),
  { stages: ["E2", "E5"], structuralRebuild: false },
  "普通 E2 卡仍只路由 E2+E5"
);
assert.deepEqual(
  planRepairPipeline([{ ownerRole: "E1", severity: "MAJOR", code: "ACTION_PHASE_OVERLOAD" }]),
  { stages: [], structuralRebuild: false },
  "ACTION_PHASE_OVERLOAD 未勾选建议时不进入返修"
);
assert.deepEqual(
  planRepairPipeline([{ ownerRole: "E1", severity: "MAJOR", code: "ACTION_PHASE_OVERLOAD" }], { includeSuggestions: true }),
  { stages: ["E1", "E5"], structuralRebuild: false },
  "带建议返修时 ACTION_PHASE_OVERLOAD 只走 E1 局部 patch，不得全链重建"
);
assert.deepEqual(
  planRepairPipeline([{ ownerRole: "E1", severity: "BLOCKER", code: "SOURCE_ORDER_MONOTONIC" }]),
  { stages: ["E1", "E5"], structuralRebuild: false },
  "镜间源节点顺序问题只修命中镜，不得因单个顺序卡清空 E2-E4 后全链重建"
);
assert.deepEqual(
  planRepairPipeline([{ ownerRole: "E1", severity: "BLOCKER", code: "INTRA_SHOT_SOURCE_ORDER" }]),
  { stages: ["E1", "E5"], structuralRebuild: false },
  "镜内源节点顺序问题只走 E1 局部 patch"
);
assert.deepEqual(
  planRepairPipeline([{ ownerRole: "E3", severity: "MAJOR", code: "ASSET_PREPARATION" }], { includeSuggestions: true }),
  { stages: [], structuralRebuild: false },
  "资产准备需要人工确认，不得因连建议一起修而自动绑定或创建资产"
);
assert.equal(
  repairOwnerForIssue({ coordinate: "1-1-S029-p0.picture", code: "TEMPORAL_DUPLICATION", ownerRole: "E4" }),
  "E2",
  "画面重复即使历史 ownerRole 错写为 E4，也必须路由到 E2"
);
assert.equal(
  repairOwnerForIssue({ coordinate: "1-1-S026.picture", code: "LIGHTING_ACTION_CONFLICT", ownerRole: "E4" }),
  "E4",
  "光影冲突即使坐标写在 picture，也必须路由到 E4"
);
assert.equal(
  repairOwnerForIssue({ coordinate: "1-1-S029.picture", code: "CAMERA_PICTURE_MISMATCH", ownerRole: "E4" }),
  "E2",
  "机位与画面主体不一致时，picture 修正必须路由到 E2"
);
assert.equal(
  repairOwnerForIssue({ coordinate: "1-1-S026.camera_motion", code: "CAMERA_PICTURE_MISMATCH", ownerRole: "E2" }),
  "E4",
  "机位与画面主体不一致时，camera_motion 修正必须路由到 E4"
);
assert.equal(
  repairRollbackScope({ coordinate: "1-1-S029.source_node_refs", code: "SOURCE_NODE_DUPLICATED", ownerRole: "E1" }),
  "field",
  "重复源节点引用只允许回滚 source_node_refs 字段"
);
assert.equal(
  repairOwnerForIssue({ coordinate: "1-1-U06.subject_bindings", code: "UNSUPPORTED_ASSET_BINDING", ownerRole: "E3" }),
  "E3",
  "单元绑定问题必须路由到 E3"
);
assert.equal(
  repairOwnerForIssue({ coordinate: "1-1-U06.short_unit_reason", code: "SHORT_UNIT_EXCEPTION_INVALID", ownerRole: "E3" }),
  "E1",
  "短单元时长问题必须路由到 E1 重新拆镜/重排"
);
assert.deepEqual(
  planRepairPipeline([{ ownerRole: "E3", severity: "BLOCKER", code: "SHORT_UNIT_EXCEPTION_LIMIT" }]),
  { stages: ["E1", "E2", "E3", "E4", "E5"], structuralRebuild: true },
  "短单元例外超量必须触发 E1→E5 结构重建"
);
assert.deepEqual(
  repairRunPolicy(true),
  { e1Revision: false, e24Revision: false, e3Revision: false, enforceScopeGate: false },
  "结构重建必须禁用各岗 patch 模式，并豁免局部 scope gate"
);
assert.deepEqual(
  filterPythonDuplicateReviewIssues(
    [{ coordinate: "1-1-S001.picture", code: "ACTION_PHASE_OVERLOAD", severity: "MAJOR" }],
    [
      { coordinate: "1-1-S001.picture", code: "ACTION_PHASE_OVERLOAD", severity: "MAJOR" },
      { coordinate: "1-1-S001.picture", code: "TEMPORAL_GROUNDING", severity: "BLOCKER" }
    ]
  ),
  [{ coordinate: "1-1-S001.picture", code: "TEMPORAL_GROUNDING", severity: "BLOCKER" }],
  "E5 只去重同 coordinate+code 的 Python 卡，必须保留同坐标语义 BLOCKER"
);
assert.deepEqual(
  newRegressionBlockerKeys({
    beforeKeys: ["1-1-S001.picture\u001fCODE_A"],
    beforeCoordinates: [],
    current: [{ coordinate: "1-1-S001.picture", code: "CODE_A" }, { coordinate: "1-1-S001.picture", code: "CODE_B" }]
  }),
  ["1-1-S001.picture\u001fCODE_B"],
  "同坐标新增 CODE_B 必须被回归门识别"
);
assert.deepEqual(
  newRegressionBlockerKeys({
    // 原 MAJOR 也在修复前基线中：严重度升级不应被当成新坐标
    beforeKeys: ["1-1-S001.picture\u001fACTION_PHASE_OVERLOAD"],
    beforeCoordinates: [],
    current: [{ coordinate: "1-1-S001.picture", code: "ACTION_PHASE_OVERLOAD" }]
  }),
  [],
  "原有 MAJOR 升级为 BLOCKER 不得被当成新增问题"
);
assert.deepEqual(
  newRegressionIssueKeys({
    beforeKeys: ["1-1-S001.picture\u001fCODE_A"],
    beforeCoordinates: [],
    current: [
      { coordinate: "1-1-S001.picture", code: "CODE_A" },
      { coordinate: "1-1-S001.picture", code: "CODE_B" }
    ]
  }),
  ["1-1-S001.picture\u001fCODE_B"],
  "返修回归门应拦截由本轮改动引入的新增 MAJOR/MINOR，不只拦 BLOCKER"
);
assert.equal(
  repairRollbackScope({ coordinate: "1-1-S001.picture", code: "TEMPORAL_GROUNDING", ownerRole: "E2" }),
  "field",
  "普通镜头字段问题只恢复对应字段"
);
assert.equal(
  repairRollbackScope({ coordinate: "1-1-S001.e1.sound", code: "PROMPT_LITERAL_ARTIFACT", ownerRole: "E1" }),
  "field",
  "带岗位前缀的镜头字段也只恢复对应字段"
);
assert.equal(
  repairRollbackScope({ coordinate: "1-1-S001.duration", code: "DURATION_OVER_LIMIT", ownerRole: "E1" }),
  "field",
  "镜头时长问题只恢复 duration，不回滚其它岗位字段"
);
assert.equal(
  repairRollbackScope({ coordinate: "1-1-U03.premise", code: "PREMISE_FUTURE_ENTITY", ownerRole: "E3" }),
  "unit",
  "单元字段问题只恢复对应单元"
);
assert.equal(
  repairRollbackScope({ coordinate: "1-1-S027.speaker", code: "MULTI_SPEAKER_SHOT", ownerRole: "E1" }),
  "shot",
  "单镜结构问题只恢复对应镜头"
);
assert.equal(
  repairRollbackScope({ coordinate: "source_node.N0001", code: "SOURCE_NODE_UNCOVERED", ownerRole: "E1" }),
  "full",
  "源节点承载问题仍保留整链安全保护"
);
assert.equal(
  shouldRollbackRepairRegression({ structuralRebuild: false, genuineNewBlockerKeys: [], scopeViolations: ["1-1-S002"] }),
  true,
  "普通返修没有新 BLOCKER 也必须因未命中镜改动回滚"
);
assert.equal(
  shouldRollbackRepairRegression({ structuralRebuild: true, genuineNewBlockerKeys: [], scopeViolations: ["1-1-S002"] }),
  false,
  "结构重建豁免 scope gate"
);
assert.equal(
  shouldRollbackRepairRegression({ structuralRebuild: true, genuineNewBlockerKeys: ["1-1-S002.picture\u001fTEMPORAL_GROUNDING"], scopeViolations: [] }),
  true,
  "结构重建仍必须回滚真实新增 BLOCKER"
);
assert.equal(
  sourceNodeCarrierChanged("N0001", [{ shotKey: "1-1-S001", sourceNodeRefs: "[\"N0001\"]", dialogue: "[]" }], []),
  true,
  "修复后丢失原本承载的 N0001 必须视为真实 source_node 回归"
);
assert.equal(
  sourceNodeCarrierChanged("N0001", [{ shotKey: "1-1-S001", sourceNodeRefs: "[]", dialogue: "[]" }], [{ shotKey: "1-1-S001", sourceNodeRefs: "[]", dialogue: "[]" }]),
  false,
  "前后都未覆盖的 source_node 卡只是存量暴露，不应回滚"
);
assert.equal(
  shouldRollbackRepairRegression({ structuralRebuild: true, genuineNewBlockerKeys: sourceNodeCarrierChanged("N0001", [{ shotKey: "1-1-S001", sourceNodeRefs: "[\"N0001\"]", dialogue: "[]" }], []) ? ["source_node.N0001\u001fSOURCE_NODE_UNCOVERED"] : [], scopeViolations: [] }),
  true,
  "结构重建的真实 source_node 承载变化仍必须进入回滚策略"
);

type ValidatorBoundaryCase = {
  picture?: string;
  camera?: string;
  sound?: string;
  premise?: string;
  endState?: string;
  bindings?: string[];
  previousEndState?: string;
  visibleText?: unknown;
  duration?: number;
  shortUnitReason?: string;
  dialogue?: Array<Record<string, unknown>>;
  contracts?: Array<Record<string, unknown>>;
};

function validatorBoundaryIssues(input: ValidatorBoundaryCase = {}) {
  const sourceNodes = new Map([
    ["N0001", { source_node_id: "N0001", scene_id: "1-1", type: "DIALOGUE", speaker: "林砚秋", text: "请进。", raw: "林砚秋：请进。" }],
    ["N0002", { source_node_id: "N0002", scene_id: "1-1", type: "DIALOGUE", speaker: "书吏", text: "是。", raw: "书吏：是。" }],
    ["N0003", { source_node_id: "N0003", scene_id: "1-1", type: "ACTION", speaker: null, text: "门口告示写着“明日辰时开考”", raw: "门口告示写着“明日辰时开考”" }],
    ["N0004", { source_node_id: "N0004", scene_id: "1-1", type: "ACTION", speaker: null, text: "备用告示写着“合同文字”", raw: "备用告示写着“合同文字”" }]
  ]);
  const assets = [
    { id: "asset-lin", code: "CH-001", type: "CH", name: "林砚秋", metadata: null },
    { id: "asset-clerk-official", code: "CH-005-3", type: "CH", name: "书吏｜官服", metadata: null },
    { id: "asset-clerk", code: "CH-005", type: "CH", name: "书吏", metadata: null },
    { id: "asset-clerk-default", code: "CH-005-1", type: "CH", name: "书吏｜默认", metadata: null },
    { id: "asset-clerk-rain", code: "CH-005-2", type: "CH", name: "书吏｜雨衣", metadata: null },
    { id: "asset-wolf", code: "BEAST-002", type: "BEAST", name: "狼王", metadata: null },
    { id: "asset-crowd", code: "GROUP-003", type: "GROUP", name: "县学众人", metadata: null },
    { id: "asset-system", code: "PROP-010", type: "PROP", name: "系统面板", metadata: null }
  ];
  const shot: WorkingShot = {
    shot_id: "1-1-S001",
    scene_id: "1-1",
    time_layer: "现实",
    duration: input.duration ?? 5,
    source_node_refs: ["N0001", "N0002", "N0003"],
    dialogue: input.dialogue ?? [{ source_node_id: "N0001", type: "对白", speaker: "林砚秋", text: "请进。", duration: 2 }],
    e1: {
      picture: input.picture ?? "林砚秋站在县学堂中",
      transition: "硬切",
      ...(input.visibleText !== undefined ? { visible_text: input.visibleText } : {})
    },
    e2: {},
    e3: { sound: input.sound ?? "县学堂内低噪", transition: "硬切" },
    e4: { camera_motion: input.camera ?? "中景锁定林砚秋", lighting: "窗光为主光，室内暖色辅光" }
  };
  const unit = {
    unit_id: "1-1-U01",
    shot_ids: [shot.shot_id],
    unit_duration: input.duration ?? 5,
    short_unit_reason: input.shortUnitReason ?? "SHORT_EXCEPTION/SCENE_BOUNDARY|本场只有一个完整动作，镜头边界无法与相邻场次合并",
    unit_dominant_goal: "林砚秋确认来人",
    subject_bindings: input.bindings ?? ["林砚秋@CH-001"],
    unit_start_premise: input.premise ?? "林砚秋静立在县学堂中，面向门口",
    unit_end_state: input.endState ?? "林砚秋仍在堂中",
    unit_lighting: "窗光为主光，室内暖色辅光"
  };
  if (input.previousEndState === undefined) {
    return validatePipeline({ sourceNodes, project: { assets }, contracts: input.contracts ?? [], sequences: [], beats: [] } as never, [shot], [unit]);
  }
  const previousShot: WorkingShot = {
    shot_id: "1-1-S000",
    scene_id: "1-1",
    time_layer: "现实",
    duration: 5,
    source_node_refs: [],
    dialogue: [],
    e1: { picture: "林砚秋静立堂中", transition: "硬切" },
    e2: {},
    e3: { sound: "县学堂内低噪", transition: "硬切" },
    e4: { camera_motion: "中景锁定林砚秋", lighting: "窗光为主光，室内暖色辅光" }
  };
  const previousUnit = {
    ...unit,
    unit_id: "1-1-U00",
    shot_ids: [previousShot.shot_id],
    subject_bindings: ["林砚秋@CH-001"],
    unit_start_premise: "林砚秋静立在县学堂中，面向门口",
    unit_end_state: input.previousEndState
  };
  return validatePipeline({ sourceNodes, project: { assets }, sequences: [], beats: [] } as never, [previousShot, shot], [previousUnit, unit]);
}

const hasValidatorIssue = (code: string, input: ValidatorBoundaryCase) =>
  validatorBoundaryIssues(input).some((item) => item.code === code);

assert.deepEqual(
  parseShortUnitException("SHORT_EXCEPTION/SCENE_BOUNDARY|本场只有一个完整动作，镜头边界无法与相邻场次合并"),
  { code: "SCENE_BOUNDARY", detail: "本场只有一个完整动作，镜头边界无法与相邻场次合并" },
  "短单元例外必须使用规范代码和具体不可合并事实"
);
assert.equal(parseShortUnitException("场次边界余数"), null, "泛化场次余数理由不得作为短单元例外");
assert.equal(maxShortUnitExceptions(10), 1, "10个单元的剧集最多允许1个短单元例外");
assert.equal(maxShortUnitExceptions(30), 2, "短单元例外每集最多2个");
assert.equal(hasValidatorIssue("SHORT_UNIT_EXCEPTION_REQUIRED", { duration: 9.5, shortUnitReason: "" }), true, "低于10秒且无例外必须阻断");
assert.equal(hasValidatorIssue("SHORT_UNIT_EXCEPTION_INVALID", { duration: 9.5, shortUnitReason: "场次边界余数" }), true, "泛化短单元理由必须阻断");
assert.equal(hasValidatorIssue("SHORT_UNIT_BELOW_ABSOLUTE_MIN", { duration: 3.5 }), true, "低于4秒必须阻断");
assert.equal(hasValidatorIssue("SHORT_UNIT_EXCEPTION_REQUIRED", { duration: 10 }), false, "10秒整不属于短单元例外范围");

assert.equal(hasValidatorIssue("SPEAKER_PERFORMANCE_ALIGNMENT", { picture: "林砚秋抬眼对着书吏说话" }), false, "受话宾语不得误判为说话人");
assert.equal(hasValidatorIssue("SPEAKER_PERFORMANCE_ALIGNMENT", { picture: "书吏开口说话，林砚秋侧耳听着" }), true, "明确开口的错位人物仍应拦截");
const soundSpeakerIssues = validatorBoundaryIssues({ sound: "书吏开口说话" })
  .filter((item) => item.code === "SPEAKER_ALIGNMENT" || item.code === "SPEAKER_PERFORMANCE_ALIGNMENT");
assert.deepEqual(soundSpeakerIssues.map(({ code, coordinate, ownerRole }) => ({ code, coordinate, ownerRole })), [
  { code: "SPEAKER_ALIGNMENT", coordinate: "1-1-S001.sound", ownerRole: "E3" }
], "声音错位只开一张 E3 sound 卡");
const pictureSpeakerIssues = validatorBoundaryIssues({ picture: "书吏开口说话，林砚秋侧耳听着" })
  .filter((item) => item.code === "SPEAKER_ALIGNMENT" || item.code === "SPEAKER_PERFORMANCE_ALIGNMENT");
assert.deepEqual(pictureSpeakerIssues.map(({ code, coordinate, ownerRole }) => ({ code, coordinate, ownerRole })), [
  { code: "SPEAKER_PERFORMANCE_ALIGNMENT", coordinate: "1-1-S001.picture", ownerRole: "E2" }
], "画面表演错位只开一张 E2 picture 卡");

assert.equal(hasValidatorIssue("MULTI_SPEAKER_SHOT", {
  dialogue: [
    { source_node_id: "N0001", type: "DIALOGUE", speaker: "林砚秋", text: "请进。" },
    { source_node_id: "N0002", type: "DIALOGUE", speaker: "书吏", text: "是。" }
  ]
}), true, "同镜两个非画外说话人必须阻断");
assert.equal(hasValidatorIssue("MULTI_SPEAKER_SHOT", {
  dialogue: [
    { source_node_id: "N0001", type: "DIALOGUE", speaker: "众人", text: "是！" },
    { source_node_id: "N0002", type: "OS", speaker: "书吏", text: "是。" }
  ]
}), false, "群体合声与 OS 不应误报多说话人");
assert.equal(hasValidatorIssue("DIALOGUE_EMBEDDED_SPEAKER", {
  dialogue: [{ source_node_id: "N0001", type: "对白", speaker: "林砚秋", text: "请进。书吏：是。" }]
}), true, "对白条目内再次嵌入说话人标签必须被拦截");
assert.equal(hasValidatorIssue("ACTION_PHASE_OVERLOAD", {
  picture: "林砚秋先取出考牌，再填写姓名，然后盖下印章"
}), true, "同镜至少三段明确连续动作必须开卡");

const visualContractContext = {
  sourcePackage: { scenes: [{ source_nodes: [{ source_node_id: "N0001" }] }] },
  sourceNodes: new Map([["N0001", { source_node_id: "N0001", scene_id: "1-1", type: "ACTION", text: "考牌流程" }]]),
  project: { assets: [] }, contracts: [], sequences: [],
  beats: [{ beat_id: "B04", sequence_id: "S01", node_range: [1, 1], max_shots: 4, visual_steps: [{ step_id: "V1", label: "EXAM_CARD", directive: "完成考牌流程" }] }]
};
const visualContractShots = ["取出并压平考牌", "填写姓名、考号、场次", "印章落下并显印"].map((visual_step_part_goal, index) => ({
  shot_id: `1-1-S00${index + 6}`, scene_id: "1-1", time_layer: "现实", duration: 4, source_node_refs: ["N0001"], dialogue: [],
  e1: { fulfills_visual_step: "B04.V1", visual_step_part_goal }, e2: {}, e3: {}, e4: {}
}));
assert.deepEqual(visualStepPartsForShots(visualContractContext as never, visualContractShots as never).map((part) => ({
  part_goal: part.part_goal, part_index: part.part_index, part_count: part.part_count
})), [
  { part_goal: "取出并压平考牌", part_index: 1, part_count: 3 },
  { part_goal: "填写姓名、考号、场次", part_index: 2, part_count: 3 },
  { part_goal: "印章落下并显印", part_index: 3, part_count: 3 }
], "同一视觉步骤跨三镜时必须按最终镜序分配独立目标");
assert.ok(validatePipeline(visualContractContext as never, [{ ...visualContractShots[0], e1: { fulfills_visual_step: "B04.V1" } }] as never, []).some((item) => item.code === "VISUAL_STEP_PART_GOAL_MISSING"), "声明视觉步骤但缺 part_goal 必须阻断");

const continuityShots = [
  { ...visualContractShots[0], duration: 8, e1: { continuity_id: "card-handoff" } },
  { ...visualContractShots[1], duration: 8, e1: { continuity_id: "card-handoff" } },
  { ...visualContractShots[2], duration: 3, e1: {} }
];
assert.deepEqual(computeUnitPartition({ scenes: [] } as never, continuityShots as never).map((unit) => unit.shotIds), [["1-1-S006", "1-1-S007"], ["1-1-S008"]], "相邻同 continuity_id 的镜必须作为不可切原子组");
assert.deepEqual(computeUnitPartition({ scenes: [] } as never, [
  { ...continuityShots[0], e1: { continuity_id: "card-a" } },
  { ...continuityShots[1], e1: { continuity_id: "card-b" } },
  continuityShots[2]
] as never).map((unit) => unit.shotIds), [["1-1-S006"], ["1-1-S007", "1-1-S008"]], "不同 continuity_id 可以在 15 秒边界切开");
assert.ok(validatePipeline(visualContractContext as never, continuityShots as never, []).some((item) => item.code === "CONTINUITY_GROUP_OVER_LIMIT"), ">15 秒连续组必须开 E1 BLOCKER");
assert.equal(hasOverLimitContinuityRun(continuityShots as never, new Set(["1-1-S006", "1-1-S007"])), true, "自动裁时必须识别超限连续原子组并跳过该单元");

for (const binding of ["县学书吏@书吏｜默认", "县学书吏@CH-005-1"]) {
  assert.equal(hasValidatorIssue("BINDING_MISSING", { picture: "书吏站在案后，林砚秋站在堂中", bindings: ["林砚秋@CH-001", binding] }), false, `${binding} 应按解析后的资产家族匹配书吏`);
}
assert.equal(hasValidatorIssue("BINDING_MISSING", { picture: "书吏站在案后", bindings: ["林砚秋@CH-001", "书吏@CH-005-3"] }), false, "裸主名允许同家族任一变体绑定");
assert.equal(hasValidatorIssue("BINDING_MISSING", { picture: "书吏｜雨衣站在案后", bindings: ["林砚秋@CH-001", "书吏@CH-005-3"] }), true, "明确雨衣变体不得由官服变体冒充");
assert.equal(hasValidatorIssue("BINDING_MISSING", { picture: "书吏站在案后；书吏｜雨衣走到门边", bindings: ["林砚秋@CH-001", "书吏@CH-005-3"] }), true, "完整扫描后明确雨衣变体应优先于前一分句裸主名");
assert.equal(hasValidatorIssue("BINDING_MISSING", { picture: "书吏｜雨衣站在案后", bindings: ["林砚秋@CH-001", "书吏@CH-005-2"] }), false, "明确雨衣变体绑定正确 code 应通过");
assert.equal(hasValidatorIssue("BINDING_MISSING", { camera: "镜头锁定 CH-005-2", bindings: ["林砚秋@CH-001", "书吏@CH-005-1"] }), true, "机位明确资产 code 时必须 exact code");
assert.equal(hasValidatorIssue("BINDING_MISSING", { picture: "书吏｜官服切换为书吏｜雨衣", bindings: ["林砚秋@CH-001", "书吏@CH-005-3"] }), true, "同句双变体只绑定官服时应缺雨衣");
assert.equal(hasValidatorIssue("BINDING_MISSING", { picture: "书吏｜官服切换为书吏｜雨衣", bindings: ["林砚秋@CH-001", "书吏@CH-005-2"] }), true, "同句双变体只绑定雨衣时应缺官服");
assert.equal(hasValidatorIssue("BINDING_MISSING", { picture: "书吏｜官服切换为书吏｜雨衣", bindings: ["林砚秋@CH-001", "书吏@CH-005-3", "书吏@CH-005-2"] }), false, "同句双变体均精确绑定应通过");
assert.equal(hasValidatorIssue("BINDING_MISSING", { picture: "书吏站在案后，林砚秋站在堂中" }), true, "picture 中可见书吏但未绑定应拦截");
assert.equal(hasValidatorIssue("BINDING_MISSING", {
  picture: "林砚秋站在堂中",
  sound: "书吏脚步声从远处传来",
  premise: "林砚秋站在堂中；书吏站在门外",
  endState: "书吏已经离开"
}), false, "premise/end_state/sound 不参与 BINDING_MISSING");
assert.equal(hasValidatorIssue("BINDING_MISSING", { picture: "画外的书吏继续说话；林砚秋站在堂中" }), false, "同分句明确画外的人物不算可见");
assert.equal(hasValidatorIssue("BINDING_MISSING", { picture: "画外的书吏继续说话；书吏站在案后" }), true, "另一分句重新入画时仍须绑定");

assert.equal(hasValidatorIssue("PREMISE_BINDING_CONFLICT", { premise: "林砚秋站在堂中；书吏站在门边" }), true, "premise 中可见未绑定人物应单独拦截");
assert.equal(hasValidatorIssue("PREMISE_BINDING_CONFLICT", { premise: "林砚秋站在堂中；画外的书吏继续说话" }), false, "premise 同分句明确画外允许不绑定");
for (const premise of ["狼王伏在门边", "县学众人站在堂下", "系统面板悬浮在半空"]) {
  assert.equal(hasValidatorIssue("PREMISE_BINDING_CONFLICT", { premise }), true, `premise 中未绑定可见资产应拦截：${premise}`);
}
assert.equal(hasValidatorIssue("PREMISE_BINDING_CONFLICT", { endState: "书吏站在门边" }), false, "end_state 不参与当前单元 premise 绑定");
assert.equal(hasValidatorIssue("UNIT_START_PREACTION", { premise: "书吏随后转身", bindings: ["林砚秋@CH-001", "书吏@CH-005"] }), true, "premise 不得提前完成首镜动作");
assert.equal(hasValidatorIssue("PREMISE_FUTURE_ENTITY", {
  picture: "系统面板弹出在半空，林砚秋抬眼",
  premise: "系统面板悬浮在林砚秋面前",
  bindings: ["林砚秋@CH-001", "系统面板@PROP-010"]
}), true, "首镜弹出/出现只是在 T0 后入场，不能证明 premise 的 T0 已在场");
assert.equal(hasValidatorIssue("PREMISE_FUTURE_ENTITY", {
  picture: "系统面板弹出；随后系统面板悬浮在半空",
  premise: "系统面板悬浮在林砚秋面前",
  bindings: ["林砚秋@CH-001", "系统面板@PROP-010"]
}), true, "首镜任一相关分句含入场动作时，后续悬浮状态不能倒推 T0 已在场");
assert.equal(hasValidatorIssue("PREMISE_FUTURE_ENTITY", {
  picture: "系统面板弹出；随后系统面板悬浮在半空",
  premise: "系统面板仍悬浮在林砚秋面前",
  previousEndState: "系统面板仍悬浮在林砚秋面前",
  bindings: ["林砚秋@CH-001", "系统面板@PROP-010"]
}), false, "上一单元 end_state 已在场时仍可作为 T0 依据");

for (const visibleText of [
  [{ kind: "SUBTITLE", carrier: "告示", content: "明日辰时开考" }],
  [{ kind: "DIEGETIC_PROP", carrier: "字幕", content: "明日辰时开考" }],
  [{ kind: "DIEGETIC_PROP", carrier: "告示", content: "明日\n辰时开考" }]
]) {
  assert.equal(hasValidatorIssue("VISIBLE_TEXT_DECLARATION_INVALID", { visibleText }), true, `非法 visible_text 声明必须阻断：${JSON.stringify(visibleText)}`);
}
assert.equal(hasValidatorIssue("VISIBLE_TEXT_SOURCE_UNVERIFIED", {
  visibleText: [{ kind: "DIEGETIC_PROP", carrier: "告示", content: "伪造通知" }]
}), true, "未命中本镜源节点或确认合同的文字必须阻断");
assert.equal(hasValidatorIssue("VISIBLE_TEXT_SOURCE_UNVERIFIED", {
  visibleText: [{ kind: "DIEGETIC_PROP", carrier: "告示", content: "明日辰时开考", source_node_id: "N0002" }]
}), true, "source_node_id 指向不含声明文字的节点必须阻断");
assert.equal(hasValidatorIssue("VISIBLE_TEXT_SOURCE_UNVERIFIED", {
  visibleText: [{ kind: "DIEGETIC_PROP", carrier: "告示", content: "请进。", source_node_id: "N0001" }]
}), true, "对白节点中的同文不得被转成剧情内文字");
assert.equal(hasValidatorIssue("VISIBLE_TEXT_SOURCE_UNVERIFIED", {
  visibleText: [{ kind: "DIEGETIC_PROP", carrier: "告示", content: "合同文字", source_node_id: "N0004" }],
  contracts: [{ category: "text", user_answer: "合同文字", status: "CONFIRMED" }]
}), true, "显式 source_node_id 不属于本镜 refs 时，即使合同同文也必须阻断");
assert.equal(hasValidatorIssue("VISIBLE_TEXT_SOURCE_UNVERIFIED", {
  visibleText: [{ kind: "DIEGETIC_PROP", carrier: "告示", content: "明日辰时开考", source_node_id: "N0003" }]
}), false, "声明逐字命中本镜 ACTION 源节点时应通过");
assert.equal(hasValidatorIssue("VISIBLE_TEXT_SOURCE_UNVERIFIED", {
  visibleText: [{ kind: "DIEGETIC_PROP", carrier: "告示", content: "明日辰时开考" }]
}), false, "无 source_node_id 时命中本镜任一锁定源节点应通过");
assert.equal(hasValidatorIssue("VISIBLE_TEXT_SOURCE_UNVERIFIED", {
  visibleText: [{ kind: "DIEGETIC_UI", carrier: "系统UI", content: "任务完成" }],
  contracts: [{ category: "system", user_answer: "系统UI显示“任务完成”", status: "CONFIRMED" }]
}), false, "已确认表现合同中的逐字内容应通过");

assert.equal(hasValidatorIssue("DIALOGUE_TIMING_CAPACITY", {
  duration: 0.3,
  dialogue: ["一", "二", "三", "四"].map((text) => ({ source_node_id: "N0001", type: "对白", speaker: "林砚秋", text, duration: 0.1 }))
}), true, "对白条目数超过 tick 容量必须开 E1 BLOCKER");
assert.equal(hasValidatorIssue("DIALOGUE_TIMING_CAPACITY", {
  duration: 1,
  dialogue: [{ source_node_id: "N0001", type: "对白", speaker: "林砚秋", text: "一二三四五六七", duration: 1 }]
}), true, "6 字/秒最小时长超过镜长必须开 E1 BLOCKER");
assert.equal(hasValidatorIssue("DIALOGUE_TIMING_CAPACITY", {
  duration: 1,
  dialogue: [{ source_node_id: "N0001", type: "对白", speaker: "林砚秋", text: "一二三四五六", duration: 1 }]
}), false, "刚好满足硬容量时不得误报");

const capacityPrompt = compileSeedancePrompts({
  scenes: [{ sceneKey: "1-1", heading: "客厅 日 内", location: "客厅", interiorExterior: "内", timeOfDay: "日", sourceText: "", metadata: null }],
  project: { style: "真人电影写实", aspectRatio: "16:9", assets: [] },
  episode: { content: "" },
  episodeId: "capacity-test"
} as never, [{
  shot_id: "1-1-S001",
  scene_id: "1-1",
  duration: 0.3,
  source_node_refs: [],
  dialogue: ["一", "二", "三", "四"].map((text) => ({ type: "对白", speaker: "甲", text, duration: 99 })),
  e1: { picture: "甲站在客厅中", camera_motion: "中景", sound: "室内底噪", transition: "硬切", visible_text: [] },
  e2: {}, e3: {}, e4: {}
}], [{
  unit_id: "1-1-U01",
  shot_ids: ["1-1-S001"],
  unit_duration: 0.3,
  unit_start_premise: "甲站在客厅中"
}]);
assert.doesNotMatch(capacityPrompt["1-1-U01"], /- 对白时段:|时间范围:/, "内部对白排期与时间范围不得进入最终 Seedance 提示词");
assert.match(capacityPrompt["1-1-U01"], /- 台词: 甲：“一”；甲：“二”；甲：“三”；甲：“四”;/, "容量不足仍须保留原文台词总行");

void (async () => {
  const project = await prisma.project.create({
    data: {
      title: "__pipeline_verification__",
      style: "真人电影写实",
      aspectRatio: "16:9",
      assets: {
        create: [
          { code: "CH-001-3", type: "CH", name: "苏远｜夜行" },
          { code: "CH-001", type: "CH", name: "苏远" },
          { code: "CH-001-1", type: "CH", name: "苏远｜默认" },
          { code: "CH-001-2", type: "CH", name: "苏远｜雨衣" }
        ]
      },
      episodes: {
        create: {
          number: 1,
          title: "第一集",
          content: "1-1\n客厅 日 内\n场景：客厅\n人物：苏远、赵清雅\n道具：手机\n门口告示写着“明日辰时开考”，苏远拿起手机。\n苏远：你看。",
          scriptScenes: {
            create: {
              sceneKey: "1-1",
              sortOrder: 1,
              heading: "客厅 日 内",
              location: "客厅",
              interiorExterior: "内",
              timeOfDay: "日",
              timeLayer: "现实",
              sourceText: "1-1\n客厅 日 内\n场景：客厅\n人物：苏远、赵清雅\n道具：手机\n门口告示写着“明日辰时开考”，苏远拿起手机。\n苏远：你看。",
              metadata: JSON.stringify({ characters: ["苏远", "赵清雅"], props: ["手机"] })
            }
          }
        }
      }
    },
    include: { episodes: true }
  });
  const episode = project.episodes[0];
  const batchToken = "verify-batch";
  try {
    await seedApprovedFoundationFixture(project.id, prisma);
    await prisma.$transaction(PIPELINE_STAGE_CONFIGS.map((stage) => prisma.pipelineRun.create({
      data: {
        projectId: project.id,
        episodeId: episode.id,
        stageCode: stage.code,
        roleName: stage.name,
        provider: "test",
        model: stage.model,
        inputSummary: JSON.stringify({ batchToken })
      }
    })));
    await executeEpisodePipeline(project.id, episode.id, batchToken, { stageRunner: fakeStage });
    const e5Evidence = JSON.parse(lastE5Prompt.split("INPUT_JSON:\n")[1] ?? "{}");
    assert.ok(Array.isArray(e5Evidence.source_nodes) && e5Evidence.source_nodes[0]?.id, "E5 必须一次性收到 source_nodes 证据包");
    assert.ok(Array.isArray(e5Evidence.director_contract?.sequences), "E5 必须一次性收到 Sequence/Beat/visual steps 合同");
    assert.ok(Array.isArray(e5Evidence.asset_index), "E5 必须一次性收到资产索引");
    assert.deepEqual(Object.keys(e5Evidence.shots[0]).sort(), ["dialogue_slices", "duration", "field_trace", "final_cells", "id", "scene", "source_node_refs", "visual_step"].sort(), "E5 每镜必须是紧凑证据行");
    assert.deepEqual(e5Evidence.shots[0].field_trace.E1.visible_text, [{ kind: "DIEGETIC_PROP", carrier: "告示", content: "明日辰时开考", source_node_id: "N0001" }], "E5 必须看到 visible_text 声明");
    assert.deepEqual(e5Evidence.shots[0].final_cells.visible_text, e5Evidence.shots[0].field_trace.E1.visible_text, "E5 final_cells 必须保留 visible_text 声明");
    for (const key of ["rough_camera", "continuity_id", "beat_id"]) {
      assert.ok(key in e5Evidence.shots[0].field_trace.E1, `E5 的 E1 原始证据必须保留 ${key}`);
    }
    assert.equal("compiled_prompt" in e5Evidence, false, "E5 不得接收 compiled prompt");
    const verified = await prisma.episode.findUnique({
      where: { id: episode.id },
      include: {
        storyboardShots: true,
        seedanceUnits: { include: { promptVersions: true } },
        pipelineRuns: true,
        workflowIssues: true
      }
    });
    assert.equal(verified?.storyboardShots.length, 1);
    const shot = verified?.storyboardShots[0];
    assert.ok(shot, "应有 1 个小镜号");
    const e1 = JSON.parse(shot?.e1Data ?? "{}");
    assert.equal(e1.picture, "苏远站在桌边；苏远｜夜行切换为苏远｜雨衣并拿起手机说出提示");
    assert.equal(e1.shot_function, "信息动作镜");
    assert.equal(e1.duration, 5);
    const e2 = JSON.parse(shot?.e2Data ?? "{}");
    assert.ok(e2.picture, "E2 应更新 picture");
    const e3 = JSON.parse(shot?.e3Data ?? "{}");
    assert.ok(e3.sound, "E3（单元视听）应写入 sound");
    const e4 = JSON.parse(shot?.e4Data ?? "{}");
    assert.ok(e4.camera_motion, "E4（摄影光影）应更新 camera_motion");
    assert.equal(verified?.seedanceUnits.length, 1);
    const unitData = JSON.parse(verified?.seedanceUnits[0].data ?? "{}");
    assert.deepEqual(new Set(unitData.subject_bindings), new Set(["苏远@CH-001-3", "苏远@CH-001-2"]), "机械补绑不得丢失同句任一明确变体 code");
    assert.equal(verified?.seedanceUnits[0].promptVersions.length, 1, "E3 先出草稿、E5 放行原地升级，应只有一版提示词");
    assert.equal(verified?.seedanceUnits[0].promptVersions[0].syncStatus, "RELEASE_COMPILED", "E5 放行后应为正式编译版");
    const prompt = verified?.seedanceUnits[0].promptVersions[0].content ?? "";
    assert.match(prompt, /### 生成分镜单元1（0-5s｜总时长5s）/, "编译应为 9 分样稿格式（累计时间码）");
    assert.match(prompt, /\[通用提示词\]/);
    assert.match(prompt, /\[人物状态与站位前提：/);
    assert.match(prompt, /苏远@CH-001-3/, "compiler 不得丢失夜行变体 code");
    assert.match(prompt, /苏远@CH-001-2/, "compiler 不得丢失雨衣变体 code");
    assert.match(prompt, /- 分镜1,5s,/);
    assert.doesNotMatch(prompt, /- 时间范围:|- 对白时段:/, "内部时间轴与对白排期不得进入最终 Seedance 提示词");
    assert.match(prompt, /- 机位\/运动: /);
    assert.match(prompt, /- 画面: 苏远站在桌边；苏远｜夜行切换为苏远｜雨衣并从桌边拿起手机，说出台词，平静带点得意；结束手机停在身前；光影：主光为窗光，轮廓光勾边/, "画面应为 E2 基础画面 + E3 光影追加（光影不覆盖画面）");
    assert.match(prompt, /- 台词: 苏远：“你看。”/, "对白台词统一带中文引号（OS/VO/旁白不带引号）");
    assert.match(prompt, /仅允许剧情内告示逐字显示「明日辰时开考」/, "E1 visible_text 声明应定向放宽剧情内文字");
    assert.match(prompt, /除此之外无其他可辨识文字/);
    assert.ok(!prompt.includes("无任何可辨识文字") && !prompt.includes("无文字"), "允许项不得与全局无文字禁令互斥");
    for (const forbidden of ["无字幕", "无屏幕叠字", "无人名条", "无地点条", "无时间条", "无水印", "无Logo", "无BGM文字"]) {
      assert.ok(prompt.includes(forbidden), `剧情内文字声明不得放宽：${forbidden}`);
    }
    assert.equal(verified?.pipelineRuns.filter((run) => run.status === "SUCCEEDED").length, 6, "E0-E5 六岗全量应全部成功");
    assert.equal(verified?.workflowIssues.filter((item) => item.status === "OPEN").length, 0);

    // 用户确认保留的建议必须传给 E5，且同一坐标+code 不得被重新开成 OPEN。
    const approvedException = await prisma.workflowIssue.create({
      data: {
        projectId: project.id, episodeId: episode.id,
        coordinate: "1-1-S001.picture", code: "ACTION_PHASE_OVERLOAD", severity: "MAJOR", status: "EXCEPTED",
        ownerRole: "E1", expected: "按用户确认保留", evidence: "用户确认无需修改", requestedEffect: "无需处理", revision: "V1_TEST"
      }
    });
    await prisma.pipelineRun.create({ data: { projectId: project.id, episodeId: episode.id, stageCode: "E5", roleName: "审查总控", provider: "test", model: "test", inputSummary: JSON.stringify({ batchToken: "verify-approved-exception-e5" }) } });
    await executeEpisodePipeline(project.id, episode.id, "verify-approved-exception-e5", {
      singleStage: "E5",
      stageRunner: async (stageCode, prompt) => {
        if (stageCode !== "E5") return fakeStage(stageCode, prompt);
        lastE5Prompt = prompt;
        return {
          data: {
            ...fakeStageOutput("E5"),
            issues: [{ coordinate: "1-1-S001.picture", code: "ACTION_PHASE_OVERLOAD", severity: "MAJOR", owner_role: "E1", expected: "按用户确认保留", actual_evidence: "再次出现", requested_effect: "无需处理" }]
          },
          sessionId: null, stdout: "", stderr: ""
        };
      }
    });
    const exceptionInput = JSON.parse(lastE5Prompt.split("INPUT_JSON:\n")[1] ?? "{}");
    assert.ok(exceptionInput.approved_exceptions.some((item: Record<string, unknown>) => item.code === "ACTION_PHASE_OVERLOAD"), "E5 必须收到用户确认的例外卡");
    const reopenedException = await prisma.workflowIssue.findFirst({ where: { episodeId: episode.id, coordinate: "1-1-S001.picture", code: "ACTION_PHASE_OVERLOAD", status: "OPEN" } });
    assert.equal(reopenedException, null, "已确认保留的建议不得被 E5 重新打开");
    await prisma.workflowIssue.delete({ where: { id: approvedException.id } });

    // 单步骤：E2 单独重跑（从数据库回填小镜号）
    await prisma.pipelineRun.create({
      data: {
        projectId: project.id,
        episodeId: episode.id,
        stageCode: "E2",
        roleName: "表演调度",
        provider: "test",
        model: "test",
        inputSummary: JSON.stringify({ batchToken: "verify-single-e2" })
      }
    });
    await executeEpisodePipeline(project.id, episode.id, "verify-single-e2", { stageRunner: fakeStage, singleStage: "E2" });
    const e2Run = await prisma.pipelineRun.findFirst({
      where: { projectId: project.id, episodeId: episode.id, stageCode: "E2", inputSummary: { contains: "verify-single-e2" } }
    });
    assert.equal(e2Run?.status, "SUCCEEDED", "单步骤 E2 应成功");
    const shotAfterE2 = await prisma.storyboardShot.findUnique({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } },
      select: { e2Data: true }
    });
    assert.ok(shotAfterE2?.e2Data.includes("picture"), "单步骤 E2 应更新 picture");

    // 单步骤：E5 审查总控重跑（已有单元，pass 后追加一版提示词）
    await prisma.pipelineRun.create({
      data: {
        projectId: project.id,
        episodeId: episode.id,
        stageCode: "E5",
        roleName: "审查总控",
        provider: "test",
        model: "test",
        inputSummary: JSON.stringify({ batchToken: "verify-single-e5" })
      }
    });
    await executeEpisodePipeline(project.id, episode.id, "verify-single-e5", { stageRunner: fakeStage, singleStage: "E5" });
    const e5Run = await prisma.pipelineRun.findFirst({
      where: { projectId: project.id, episodeId: episode.id, stageCode: "E5", inputSummary: { contains: "verify-single-e5" } }
    });
    assert.equal(e5Run?.status, "SUCCEEDED", "单步骤 E5 应成功");
    const versionsAfterE5 = await prisma.compiledPromptVersion.count({ where: { unit: { episodeId: episode.id } } });
    assert.equal(versionsAfterE5, 1, "单步骤 E5 内容未变时原地覆盖，不刷版本");
    const latestAfterE5 = await prisma.compiledPromptVersion.findFirst({ where: { unit: { episodeId: episode.id } }, orderBy: { version: "desc" } });
    assert.equal(latestAfterE5?.syncStatus, "RELEASE_COMPILED");

    // 旧数据的无效 visual step 不能让单步骤 E5 在构建证据包时崩溃。
    await prisma.storyboardShot.update({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } },
      data: { e1Data: JSON.stringify({ ...e1, fulfills_visual_step: "B01.V999", beat_id: "B01" }) }
    });
    await prisma.pipelineRun.create({ data: { projectId: project.id, episodeId: episode.id, stageCode: "E5", roleName: "审查总控", provider: "test", model: "test", inputSummary: JSON.stringify({ batchToken: "verify-invalid-step-e5" }) } });
    await executeEpisodePipeline(project.id, episode.id, "verify-invalid-step-e5", { stageRunner: fakeStage, singleStage: "E5" });
    const invalidStepRun = await prisma.pipelineRun.findFirst({ where: { projectId: project.id, episodeId: episode.id, stageCode: "E5", inputSummary: { contains: "verify-invalid-step-e5" } } });
    assert.equal(invalidStepRun?.status, "SUCCEEDED", "无效 visual step 的单 E5 只应带证据标记，不得崩溃");
    const invalidStepEvidence = JSON.parse(lastE5Prompt.split("INPUT_JSON:\n")[1] ?? "{}");
    assert.equal(invalidStepEvidence.shots[0].visual_step.invalid, "VISUAL_STEP_INVALID", "E5 必须以紧凑 invalid marker 暴露无效 visual step");
    await prisma.storyboardShot.update({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } },
      data: { e1Data: JSON.stringify(e1) }
    });

    // 同坐标 Python MAJOR 不得吞掉 E5 的语义 Generation BLOCKER。
    await prisma.storyboardShot.update({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } },
      data: { e2Data: JSON.stringify({ picture: "苏远先拿起手机，再翻开屏幕，然后把手机举到眼前" }) }
    });
    await prisma.pipelineRun.create({ data: { projectId: project.id, episodeId: episode.id, stageCode: "E5", roleName: "审查总控", provider: "test", model: "test", inputSummary: JSON.stringify({ batchToken: "verify-semantic-e5" }) } });
    await executeEpisodePipeline(project.id, episode.id, "verify-semantic-e5", {
      singleStage: "E5",
      stageRunner: async (stageCode, prompt) => stageCode === "E5"
        ? { data: { ...fakeStageOutput("E5"), issues: [{ coordinate: "1-1-S001.picture", code: "TEMPORAL_GROUNDING", severity: "BLOCKER", owner_role: "E2", expected: "状态按因果出现", actual_evidence: "手机尚未取得却已在手", requested_effect: "补可见取得动作" }], decision: "targeted_revision", verdict: "issues_found" }, sessionId: null, stdout: "", stderr: "" }
        : fakeStage(stageCode, prompt)
    });
    const semanticIssue = await prisma.workflowIssue.findFirst({ where: { episodeId: episode.id, coordinate: "1-1-S001.picture", code: "TEMPORAL_GROUNDING", status: "OPEN" } });
    const pythonMajor = await prisma.workflowIssue.findFirst({ where: { episodeId: episode.id, coordinate: "1-1-S001.picture", code: "ACTION_PHASE_OVERLOAD", status: "OPEN" } });
    assert.equal(pythonMajor?.severity, "MAJOR", "Python ACTION_PHASE_OVERLOAD 应作为同坐标 MAJOR 保留");
    assert.equal(semanticIssue?.severity, "BLOCKER", "同坐标 Python MAJOR 时语义 BLOCKER 仍必须落库并阻断放行");
    const afterSemantic = await prisma.compiledPromptVersion.findFirst({ where: { unit: { episodeId: episode.id } }, orderBy: { version: "desc" } });
    assert.equal(afterSemantic?.syncStatus, "DRAFT_COMPILED", "语义 BLOCKER 存在时不得 release");
    await prisma.workflowIssue.delete({ where: { id: semanticIssue!.id } });
    await prisma.workflowIssue.delete({ where: { id: pythonMajor!.id } });

    // Python-owned 时长误报没有 hard check 时只能保留为建议，不能阻塞。
    await prisma.storyboardShot.update({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } },
      data: { e2Data: JSON.stringify({ picture: "苏远拿稳手机，抬眼看向门口" }) }
    });
    await prisma.pipelineRun.create({ data: { projectId: project.id, episodeId: episode.id, stageCode: "E5", roleName: "审查总控", provider: "test", model: "test", inputSummary: JSON.stringify({ batchToken: "verify-python-owned-e5" }) } });
    await executeEpisodePipeline(project.id, episode.id, "verify-python-owned-e5", {
      singleStage: "E5",
      stageRunner: async (stageCode, prompt) => stageCode === "E5"
        ? { data: { ...fakeStageOutput("E5"), issues: [{ coordinate: "1-1-S001.duration", code: "DURATION_OVER_LIMIT", severity: "BLOCKER", owner_role: "E1", expected: "≤5秒", actual_evidence: "误读为超时", requested_effect: "缩短" }], decision: "pass" }, sessionId: null, stdout: "", stderr: "" }
        : fakeStage(stageCode, prompt)
    });
    const pythonOwnedIssue = await prisma.workflowIssue.findFirst({ where: { episodeId: episode.id, coordinate: "1-1-S001.duration", code: "DURATION_OVER_LIMIT", status: "OPEN" } });
    assert.equal(pythonOwnedIssue?.severity, "MAJOR", "Python-owned 重复/误报不得阻塞");
    const afterPythonOwned = await prisma.compiledPromptVersion.findFirst({ where: { unit: { episodeId: episode.id } }, orderBy: { version: "desc" } });
    assert.equal(afterPythonOwned?.syncStatus, "RELEASE_COMPILED", "Python-owned 误报不得阻断 release");
    await prisma.workflowIssue.delete({ where: { id: pythonOwnedIssue!.id } });

    // E1 返修轮：注入一个归属 E1 的 BLOCKER 问题，重跑 E1 应带问题卡定向返修且保留 e2/e3/e4
    const issue = await prisma.workflowIssue.create({
      data: {
        projectId: project.id, episodeId: episode.id,
        coordinate: "1-1-S001.duration", code: "DURATION_OVER_LIMIT", severity: "BLOCKER",
        ownerRole: "E1", expected: "每镜≤5秒", evidence: "镜长超限", requestedEffect: "修正时长", revision: "V1_TEST"
      }
    });
    await prisma.pipelineRun.create({
      data: {
        projectId: project.id, episodeId: episode.id, stageCode: "E1", roleName: "结构导演", provider: "test", model: "test",
        inputSummary: JSON.stringify({ batchToken: "verify-rev-e1" })
      }
    });
    await executeEpisodePipeline(project.id, episode.id, "verify-rev-e1", { stageRunner: fakeStage, singleStage: "E1" });
    const revRun = await prisma.pipelineRun.findFirst({
      where: { projectId: project.id, episodeId: episode.id, stageCode: "E1", inputSummary: { contains: "verify-rev-e1" } }
    });
    assert.equal(revRun?.status, "SUCCEEDED", "E1 返修轮应成功");
    const shotAfterRev = await prisma.storyboardShot.findUnique({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } },
      select: { e2Data: true, e3Data: true, e4Data: true }
    });
    assert.ok(shotAfterRev?.e2Data.includes("picture"), "E1 返修轮应保留 e2Data");
    assert.ok(shotAfterRev?.e3Data.includes("sound"), "E1 返修轮应保留 e3Data（单元字段）");
    assert.ok(shotAfterRev?.e4Data.includes("camera_motion"), "E1 返修轮应保留 e4Data（摄影字段）");
    await prisma.workflowIssue.delete({ where: { id: issue.id } });

    // E1 画面 patch 改动基础画面时，必须清掉过期 E2 picture，避免最终编译继续选旧增强层。
    await prisma.storyboardShot.update({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } },
      data: { e2Data: JSON.stringify({ picture: "旧 E2 增强画面", keep: "本轮无关字段" }) }
    });
    const pictureIssue = await prisma.workflowIssue.create({
      data: {
        projectId: project.id, episodeId: episode.id,
        coordinate: "1-1-S001.picture", code: "ACTION_PHASE_OVERLOAD", severity: "MAJOR",
        ownerRole: "E1", expected: "一镜一个动作阶段", evidence: "测试画面卡", requestedEffect: "重写基础画面", revision: "V1_TEST"
      }
    });
    const pictureBatch = "verify-e1-picture-patch";
    await prisma.pipelineRun.create({
      data: {
        projectId: project.id, episodeId: episode.id, stageCode: "E1", roleName: "结构导演", provider: "test", model: "test",
        inputSummary: JSON.stringify({ batchToken: pictureBatch })
      }
    });
    await executeEpisodePipeline(project.id, episode.id, pictureBatch, {
      singleStage: "E1",
      stageRunner: async (stageCode) => stageCode === "E1"
        ? {
            data: {
              base_revision: "V1_TEST",
              patches: [{ shot_id: "1-1-S001", action: "set", fields: { picture: "新的 E1 基础画面" } }],
              tickets: [],
              status: "patch"
            },
            sessionId: null, stdout: "", stderr: ""
          }
        : fakeStage(stageCode)
    });
    const picturePatchedShot = await prisma.storyboardShot.findUnique({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } },
      select: { e1Data: true, e2Data: true }
    });
    const picturePatchedE1 = JSON.parse(picturePatchedShot?.e1Data ?? "{}");
    const picturePatchedE2 = JSON.parse(picturePatchedShot?.e2Data ?? "{}");
    assert.equal(picturePatchedE1.picture, "新的 E1 基础画面", "E1 picture patch 应写入基础画面");
    assert.equal(picturePatchedE2.picture, undefined, "E1 picture patch 应清掉过期 E2 picture");
    assert.equal(picturePatchedE2.keep, "本轮无关字段", "清理过期 E2 picture 不得抹掉同格其它字段");
    const invalidatedIssue = await prisma.workflowIssue.findFirst({
      where: { episodeId: episode.id, code: "DOWNSTREAM_PICTURE_INVALIDATED", status: "RESOLVED" }
    });
    assert.ok(invalidatedIssue, "清除过期 E2 picture 应留下可追溯的机械记录");
    await prisma.workflowIssue.delete({ where: { id: pictureIssue.id } });

    // 回归门：新 BLOCKER 只影响一个 E2 picture 字段时，恢复该字段，保留同一轮其它字段的有效修改。
    await prisma.storyboardShot.update({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } },
      data: { e2Data: JSON.stringify({ picture: "旧画面", keep: "旧字段" }) }
    });
    const selectiveIssue = await prisma.workflowIssue.create({
      data: {
        projectId: project.id, episodeId: episode.id,
        coordinate: "1-1-S001.picture", code: "SELECTIVE_TEST_TARGET", severity: "BLOCKER",
        ownerRole: "E2", expected: "旧画面", evidence: "测试目标卡", requestedEffect: "只修改画面", revision: "V1_TEST"
      }
    });
    const selectiveBatch = "verify-selective-repair";
    const selectiveInput = {
      batchToken: selectiveBatch, repairPipeline: true, structuralRebuild: false,
      openBlockers: 1, openMajors: 0,
      openBlockerCoords: [selectiveIssue.coordinate], openBlockerKeys: [workflowIssueKey(selectiveIssue)],
      openIssueKeys: [workflowIssueKey(selectiveIssue)], openCoords: [selectiveIssue.coordinate]
    };
    await prisma.$transaction(["E2", "E5"].map((stageCode) => prisma.pipelineRun.create({
      data: {
        projectId: project.id, episodeId: episode.id, stageCode,
        roleName: stageCode === "E2" ? "表演调度" : "审查总控", provider: "test", model: "test",
        inputSummary: JSON.stringify(selectiveInput)
      }
    })));
    await executeEpisodePipeline(project.id, episode.id, selectiveBatch, {
      stages: ["E2", "E5"],
      stageRunner: async (stageCode, prompt) => {
        if (stageCode === "E2") return {
          data: {
            role: "E2", base_revision: "V1_TEST",
            patches: [{ shot_id: "1-1-S001", action: "set", fields: { picture: "新画面", keep: "本轮有效字段" } }],
            issues: []
          },
          sessionId: null, stdout: "", stderr: ""
        };
        if (stageCode === "E5") {
          lastE5Prompt = prompt ?? "";
          return {
            data: {
              ...fakeStageOutput("E5"),
              issues: [{ coordinate: "1-1-S001.picture", code: "SELECTIVE_TEST_REGRESSION", severity: "BLOCKER", owner_role: "E2", expected: "无新回归", actual_evidence: "测试回归", requested_effect: "恢复受影响画面" }],
              decision: "targeted_revision", verdict: "issues_found"
            },
            sessionId: null, stdout: "", stderr: ""
          };
        }
        return fakeStage(stageCode, prompt);
      }
    });
    const selectiveShot = await prisma.storyboardShot.findUnique({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } },
      select: { e2Data: true }
    });
    const selectiveData = JSON.parse(selectiveShot?.e2Data ?? "{}");
    assert.equal(selectiveData.picture, "旧画面", "回归只应恢复触发问题的 picture 字段");
    assert.equal(selectiveData.keep, "本轮有效字段", "字段级恢复不得抹掉同一轮其它有效字段");
    const selectiveRun = await prisma.pipelineRun.findFirst({ where: { projectId: project.id, episodeId: episode.id, stageCode: "E5", inputSummary: { contains: selectiveBatch } } });
    const selectiveRegression = JSON.parse(selectiveRun?.outputSummary ?? "{}").regression;
    assert.equal(selectiveRegression?.partiallyRestored, true, "字段级回归应记录为部分恢复，不应宣称整集回滚");
    assert.equal(selectiveRegression?.rolledBack, false, "字段级回归不得整集回滚");
    const selectiveOpen = await prisma.workflowIssue.findFirst({ where: { episodeId: episode.id, coordinate: "1-1-S001.picture", code: "SELECTIVE_TEST_REGRESSION", status: "OPEN" } });
    assert.equal(selectiveOpen, null, "局部恢复后不应保留已回滚临时卡，避免问题数量虚增");
    const selectiveOriginal = await prisma.workflowIssue.findFirst({ where: { episodeId: episode.id, coordinate: "1-1-S001.picture", code: "SELECTIVE_TEST_TARGET", status: "OPEN" } });
    assert.ok(selectiveOriginal, "局部恢复后应恢复返修前的原问题卡，避免数据已回滚但问题卡被误销");
    const regressionCard = await prisma.workflowIssue.findFirst({ where: { episodeId: episode.id, coordinate: "E5.repair_regression", code: "REPAIR_REGRESSION" } });
    assert.equal(regressionCard?.status, "RESOLVED", "局部恢复成功后系统回归卡只作审计记录，不应继续阻塞下一轮");
  } finally {
    await prisma.project.delete({ where: { id: project.id } });
    await prisma.$disconnect();
  }
  console.log("episode pipeline contract and persistence verification passed");
})();

async function fakeStage(stageCode: Parameters<PipelineStageRunner>[0], prompt?: string): Promise<{
  data: Record<string, unknown>;
  sessionId: string | null;
  stdout: string;
  stderr: string;
}> {
  if (stageCode === "E5" && prompt) lastE5Prompt = prompt;
  return {
    data: fakeStageOutput(stageCode),
    sessionId: `fake-${stageCode}`,
    stdout: "",
    stderr: ""
  };
}

function fakeStageOutput(stageCode: string): Record<string, unknown> {
  if (stageCode === "E1") return {
    base_revision: "V1_TEST",
    shots: [{
      shot_id: "1-1-S001",
      scene_id: "1-1",
      duration: 5,
      shot_function: "信息动作镜",
      picture: "苏远站在桌边；苏远｜夜行切换为苏远｜雨衣并拿起手机说出提示",
      camera_motion: "中近景，轻微手持",
      sound: "手机提示音",
      transition: "硬切",
      visible_text: [{ kind: "DIEGETIC_PROP", carrier: "告示", content: "明日辰时开考", source_node_id: "N0001" }],
      rough_camera: "中近景，桌边平视",
      continuity_id: "phone-pickup",
      beat_id: "B01",
      dialogue_spans: [{ source_node_id: "N0002", span_state: "whole" }],
      fulfills_visual_step: "V1",
      visual_step_part_goal: "苏远拿起手机并将提示展示在画面中",
      risk_notes: "",
      source_node_refs: ["N0001", "N0002"]
    }],
    tickets: [],
    status: "set"
  };
  if (stageCode === "E2") return {
    role: "E2",
    base_revision: "V1_TEST",
    patches: [{
      shot_id: "1-1-S001",
      action: "set",
      fields: { picture: "苏远站在桌边；苏远｜夜行切换为苏远｜雨衣并从桌边拿起手机，说出台词，平静带点得意；结束手机停在身前" }
    }],
    issues: []
  };
  if (stageCode === "E3") return {
    role: "E3",
    base_revision: "V1_TEST",
    patches: [{
      shot_id: "1-1-S001",
      action: "set",
      fields: { sound: "手机提示音", transition: "硬切" }
    }],
    units: [{
      unit_id: "1-1-U01",
      shot_ids: ["1-1-S001"],
      unit_duration: 5,
    short_unit_reason: "SHORT_EXCEPTION/SCENE_BOUNDARY|本场只有一个完整动作，镜头边界无法与相邻场次合并",
      unit_dominant_goal: "展示手机提示",
      subject_bindings: [],
      unit_start_premise: "苏远在桌边，手机在手边",
      unit_end_state: "苏远仍在桌边持手机"
    }],
    issues: []
  };
  if (stageCode === "E4") return {
    role: "E4",
    base_revision: "V1_TEST",
    unit_lighting: [{ unit_id: "1-1-U01", lighting: "单元光型：主光为窗光，轮廓光勾边" }],
    patches: [{
      shot_id: "1-1-S001",
      action: "set",
      fields: { camera_motion: "中近景，平视，苏远居左手机居中，轻微手持", lighting: "主光为窗光，轮廓光勾边" }
    }],
    issues: []
  };
  if (stageCode === "E0") return {
    role: "E0",
    episode_number: 1,
    target_duration: 5,
    sequences: [{
      sequence_id: "S01",
      title: "测试链",
      causal_chain: "单事件",
      node_range: [1, 2],
      beats: [{ beat_id: "B01", title: "单镜事件", node_range: [1, 2], drama_function: "测试", target_shots: 1, max_shots: 1, target_seconds: 5, max_seconds: 6, visual_steps: [{ step_id: "V1", label: "EVENT", directive: "展示事件" }], anchor_nodes: [] }]
    }],
    notes: "测试骨架"
  };
  return {
    role: "E5",
    revision: "V1_TEST",
    coverage: { scenes: 1, shots: 1, units: 1, domains: ["E1时长", "E2表演", "E3单元视听", "E4摄影光影"] },
    issues: [],
    verdict: "professional_pass",
    decision: "pass",
    routes: [],
    reason: "全部硬校验与独立审查通过"
  };
}
