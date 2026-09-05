import assert from "node:assert/strict";
import { executeProjectFoundation, type FoundationStageRunner } from "@/lib/project-foundation";
import {
  inspectP1ChunkCoverage,
  mergeP1Outputs,
  normalizeP2SystemSemantics,
  PROJECT_FOUNDATION_STAGES,
  buildFoundationPrompt,
  reanchorP1PresentationDecisions,
  validateFoundationP1,
  validateFoundationP2,
  type FoundationContext
} from "@/lib/project-foundation-contracts";
import { prisma } from "@/lib/prisma";

const EP1 = "1-1\n客厅 日 内\n场景：客厅\n人物：苏远、赵清雅\n道具：手机\n系统提示：任务完成\n苏远拿起手机。\n苏远：你看。\n赵清雅OS：果然是他。";
const EP1_ORDINARY_SYSTEM = "1-1\n客厅 日 内\n场景：客厅\n人物：苏远、赵清雅\n道具：手机\n玄机子：现在通了，系统自己就推你了。\n苏远拿起手机。\n苏远：你看。\n赵清雅OS：果然是他。";
const EP2 = "2-1\n教室 日 内\n场景：教室\n人物：苏远、王老师\n苏远走进教室。\n王老师：迟到三次，站到后面。";

async function createScratchProject(title: string, episodeOneText = EP1) {
  return prisma.project.create({
    data: {
      title,
      style: "真人电影写实",
      aspectRatio: "16:9",
      episodes: {
        create: [
          {
            number: 1,
            title: "第一集",
            content: episodeOneText,
            scriptScenes: {
              create: {
                sceneKey: "1-1",
                sortOrder: 1,
                heading: "客厅 日 内",
                location: "客厅",
                interiorExterior: "内",
                timeOfDay: "日",
                timeLayer: "现实",
                sourceText: episodeOneText,
                metadata: "{}"
              }
            }
          },
          {
            number: 2,
            title: "第二集",
            content: EP2,
            scriptScenes: {
              create: {
                sceneKey: "2-1",
                sortOrder: 1,
                heading: "教室 日 内",
                location: "教室",
                interiorExterior: "内",
                timeOfDay: "日",
                timeLayer: "现实",
                sourceText: EP2,
                metadata: "{}"
              }
            }
          }
        ]
      }
    },
    include: { episodes: true }
  });
}

const fakeP1 = {
  schema: "PROJECT_MEMORY_V2",
  story_contract: {
    genre: "都市日常",
    perspective: "苏远",
    core_desire: "摆脱迟到困境",
    immutable_facts: [{ fact: "苏远向赵清雅展示手机", source_node_refs: ["N0001", "N0002"] }]
  },
  episodes: [
    { number: 1, one_line_progress: "苏远拿出手机给赵清雅看", start_state: "客厅", end_state: "赵清雅看到内容", key_changes: ["展示手机"], source_node_refs: ["N0001"] },
    { number: 2, one_line_progress: "苏远迟到被罚站", start_state: "走进教室", end_state: "站到后面", key_changes: ["第三次迟到"], source_node_refs: ["N0002"] }
  ],
  relationships: [{ a: "苏远", b: "赵清雅", stages: [{ episode_range: "1", state: "日常交流", knowledge: "赵清雅看到手机内容", source_node_refs: ["N0002"] }] }],
  secrets: [],
  foreshadowing: [],
  boundaries: [{ from_episode: 1, to_episode: 2, carry_over: "赵清雅已看过手机内容", source_node_refs: ["N0001"] }],
  presentation_decisions_needed: [{
    category: "system",
    question: "系统提示应以什么形态出现？",
    options: ["A. 半透明面板", "B. 仅文字浮现"],
    evidence: "系统提示：任务完成",
    episode_number: 1,
    source_node_refs: ["N0001"],
    suggested_default: "B. 仅文字浮现",
    round: 1
  }],
  issues: []
};

const fakeP2 = {
  assets: [
    { name: "苏远", type: "CH", parent_name: null, first_seen_node: "N0001", scene_refs: ["1-1", "2-1"], aliases: ["远哥"], evidence: "两集均出场" },
    { name: "苏远｜校服·受伤", type: "CH", parent_name: "苏远", first_seen_node: "N0001", scene_refs: ["2-1"], aliases: [], evidence: "受伤状态" },
    { name: "赵清雅", type: "CH", parent_name: null, first_seen_node: "N0001", scene_refs: ["1-1"], aliases: [], evidence: "第1集出场" },
    { name: "王老师", type: "CH", parent_name: null, first_seen_node: "N0002", scene_refs: ["2-1"], aliases: [], evidence: "第2集出场" },
    { name: "客厅", type: "LOC", parent_name: null, first_seen_node: "N0001", scene_refs: ["1-1"], aliases: [], evidence: "场景头" },
    { name: "手机", type: "PROP", parent_name: null, first_seen_node: "N0001", scene_refs: ["1-1"], aliases: [], evidence: "关键道具" }
  ],
  scene_asset_links: [
    { scene_id: "1-1", asset_names: ["苏远", "赵清雅", "客厅", "手机"] },
    { scene_id: "2-1", asset_names: ["苏远", "王老师", "苏远｜校服·受伤"] }
  ],
  issues: []
};

const fakeBadP2 = {
  assets: [{ name: "苏远os", type: "CH", parent_name: null, first_seen_node: "N0001", scene_refs: ["1-1"], aliases: [], evidence: "脏名" }],
  scene_asset_links: [],
  issues: []
};

// 分片回归：同一类别但语义不同的表现问题必须保留为两条，不得互相拼接引用。
const p1ChunkOne = { ...fakeP1, episodes: [fakeP1.episodes[0]], presentation_decisions_needed: [fakeP1.presentation_decisions_needed![0]] };
const p1ChunkTwo = {
  ...fakeP1,
  episodes: [fakeP1.episodes[1]],
  presentation_decisions_needed: [{ ...fakeP1.presentation_decisions_needed![0], question: "迟到的表现应如何呈现？", rule_key: "late-arrival-presentation", episode_number: 2, evidence: "王老师：迟到三次，站到后面。", source_node_refs: ["N0001"] }]
};
const mergedChunkOutput = mergeP1Outputs([p1ChunkOne, p1ChunkTwo]);
assert.deepEqual(mergedChunkOutput.presentation_decisions_needed?.map((item) => item.episode_number), [1, 2], "不同语义的表现规范必须保持独立");
assert.deepEqual(inspectP1ChunkCoverage(p1ChunkOne, [1, 2]), {
  expected: [1, 2],
  actual: [1],
  missing: [2],
  unexpected: [],
  duplicates: [],
  invalid: 0
}, "P1 分片完整性检查应识别漏集");

// 证据回归：一条表现规范可以由多个被引用源节点按原文顺序组成，但不能靠关键词虚构通过。
const evidenceContext = {
  episodes: [{ number: 1 }],
  episodeScenes: new Map([
    [1, {
      number: 1,
      title: "第一集",
      scenes: [{
        scene_id: "1-1",
        heading: "客厅 日 内",
        location: "客厅",
        interior_exterior: "内",
        time_of_day: "日",
        weather: null,
        time_layer: "现实",
        source_nodes: [
          { source_node_id: "N0001", speaker: null, text: "一道金光出现。" },
          { source_node_id: "N0002", speaker: null, text: "门锁掉落。" }
        ]
      }]
    }]
  ]),
  episodeNodeIds: new Map([[1, new Set(["N0001", "N0002"])]]),
  existingAssets: [],
  contracts: [],
  scriptContainsQVersion: false
} as unknown as FoundationContext;
const multiNodeEvidence = {
  ...fakeP1,
  episodes: [{ ...fakeP1.episodes[0], source_node_refs: ["N0001"] }],
  presentation_decisions_needed: [{
    category: "power",
    question: "灵力如何呈现？",
    options: ["A", "B"],
    evidence: "一道金光出现。门锁掉落。",
    episode_number: 1,
    source_node_refs: ["N0001", "N0002"]
  }]
};
assert.equal(validateFoundationP1(multiNodeEvidence, evidenceContext).length, 0, "跨多个源节点的连续证据应通过门禁");
assert.ok(validateFoundationP1({ ...multiNodeEvidence, presentation_decisions_needed: [{ ...multiNodeEvidence.presentation_decisions_needed![0], evidence: "原文不存在" }] }, evidenceContext).some((issue) => issue.code === "PRESENTATION_DECISION_UNGROUNDED"), "无原文证据仍应被门禁拦截");
assert.deepEqual(
  reanchorP1PresentationDecisions({ ...multiNodeEvidence, presentation_decisions_needed: [{ ...multiNodeEvidence.presentation_decisions_needed![0], source_node_refs: ["N9999"] }] }, evidenceContext).presentation_decisions_needed?.[0]?.source_node_refs,
  ["N0001", "N0002"],
  "原文证据存在时应自动修正错位的源节点引用"
);

// 引号回归：多句证据以“第一句。”“第二句！”书写时，切分不得产生
// 空分句或把引号残片误绑定到前后无关的源节点。
const quotedEvidenceContext = {
  ...evidenceContext,
  episodes: [{ number: 2 }],
  episodeScenes: new Map([
    [2, {
      number: 2,
      title: "第二集",
      scenes: [{
        scene_id: "2-1",
        heading: "收容所走廊 夜 内",
        location: "收容所走廊",
        interior_exterior: "内",
        time_of_day: "夜",
        weather: null,
        time_layer: "现实",
        source_nodes: [
          { source_node_id: "N0001", speaker: null, text: "陆沉在前面奔跑，气喘吁吁。" },
          { source_node_id: "N0017", speaker: null, text: "【闪回】" },
          { source_node_id: "N0027", speaker: null, text: "气刃打在陆沉身上，剧烈的冲击力将他推向身后的墙壁。" },
          { source_node_id: "N0028", speaker: null, text: "轰隆！墙壁坍塌，陆沉倒在地上，嘴角溢出鲜血。" },
          { source_node_id: "N0034", speaker: null, text: "陆沉身前，亮起蓝色的系统面板。" },
          { source_node_id: "N0035", speaker: "系统", text: "神兽图鉴已激活，请宿主抽卡！" }
        ]
      }]
    }]
  ]),
  episodeNodeIds: new Map([[2, new Set(["N0001", "N0017", "N0027", "N0028", "N0034", "N0035"])]]),
  existingAssets: [],
  contracts: [],
  scriptContainsQVersion: false
} as unknown as FoundationContext;
const quotedEvidenceOutput = {
  ...multiNodeEvidence,
  episodes: [{ ...fakeP1.episodes[1], number: 2, source_node_refs: ["N0001"] }],
  presentation_decisions_needed: [{
    category: "system",
    question: "系统如何呈现？",
    options: ["A", "B"],
    evidence: "“陆沉身前，亮起蓝色的系统面板。”“神兽图鉴已激活，请宿主抽卡！”",
    episode_number: 2,
    episode_numbers: [2],
    source_node_refs: ["N0034", "N0035", "N0001"]
  }]
};
const anchoredQuotedEvidence = reanchorP1PresentationDecisions(quotedEvidenceOutput, quotedEvidenceContext);
assert.deepEqual(
  anchoredQuotedEvidence.presentation_decisions_needed?.[0]?.source_node_refs,
  ["N0034", "N0035"],
  "带引号的多句证据应只绑定真实承载证据的节点"
);
assert.equal(
  validateFoundationP1(anchoredQuotedEvidence, quotedEvidenceContext).length,
  0,
  "带引号的多句系统证据应通过 P1 原文锚定门禁"
);
const quotedBloodEvidence = {
  ...quotedEvidenceOutput,
  presentation_decisions_needed: [{
    category: "blood",
    question: "受伤效果如何呈现？",
    options: ["A", "B"],
    evidence: "“气刃打在陆沉身上，剧烈的冲击力将他推向身后的墙壁。”“陆沉倒在地上，嘴角溢出鲜血。”",
    episode_number: 2,
    episode_numbers: [2],
    source_node_refs: ["N0027", "N0028", "N0001"]
  }]
};
const anchoredQuotedBloodEvidence = reanchorP1PresentationDecisions(quotedBloodEvidence, quotedEvidenceContext);
assert.deepEqual(
  anchoredQuotedBloodEvidence.presentation_decisions_needed?.[0]?.source_node_refs,
  ["N0027", "N0028"],
  "带引号的多句受伤证据应只绑定真实承载证据的节点"
);
assert.equal(
  validateFoundationP1(anchoredQuotedBloodEvidence, quotedEvidenceContext).length,
  0,
  "带引号的多句受伤证据应通过 P1 原文锚定门禁"
);
const markerEvidence = {
  ...quotedEvidenceOutput,
  presentation_decisions_needed: [{
    category: "flashback",
    question: "闪回如何呈现？",
    options: ["A", "B"],
    evidence: "【闪回】",
    episode_number: 2,
    episode_numbers: [2],
    source_node_refs: ["N0017"]
  }]
};
const anchoredMarkerEvidence = reanchorP1PresentationDecisions(markerEvidence, quotedEvidenceContext);
assert.deepEqual(
  anchoredMarkerEvidence.presentation_decisions_needed?.[0]?.source_node_refs,
  ["N0017"],
  "完整场记标记应绑定真实源节点"
);
assert.equal(
  validateFoundationP1(anchoredMarkerEvidence, quotedEvidenceContext).length,
  0,
  "可逐字定位的完整场记标记应通过 P1 原文锚定门禁"
);
assert.ok(
  validateFoundationP1({
    ...markerEvidence,
    presentation_decisions_needed: [{ ...markerEvidence.presentation_decisions_needed![0], evidence: "闪回" }]
  }, quotedEvidenceContext).some((issue) => issue.code === "PRESENTATION_DECISION_UNGROUNDED"),
  "脱离场记括号的普通短词仍应被 P1 原文锚定门禁拦截"
);

// 系统语义回归：已确认的系统面板只能是 PROP；原文明确行动的系统伪人
// 是 BEAST，不能被模型误写成 CH，也不能因为“系统”关键词被粗暴删除。
const systemSemanticsContext = {
  ...evidenceContext,
  contracts: [{
    category: "system",
    user_answer: "A. 半透明系统面板悬浮：以黑红半透明面板显示副本名与任务。",
    scope_mode: "ALL_EPISODES",
    target_episode_numbers: [1]
  }]
} as unknown as FoundationContext;
const systemP2 = {
  assets: [
    { name: "系统面板", type: "CH" as const, parent_name: null, first_seen_node: "N0001", scene_refs: ["1-1"], aliases: [], evidence: "系统提示以面板显示" },
    { name: "系统伪人", type: "CH" as const, parent_name: null, first_seen_node: "N0001", scene_refs: ["1-1"], aliases: [], evidence: "会攻击并逃逸的伪人实体" },
    { name: "系统伪人｜残核", type: "CH" as const, parent_name: "系统伪人", first_seen_node: "N0001", scene_refs: ["1-1"], aliases: [], evidence: "残核寄生并被消灭" }
  ],
  scene_asset_links: [],
  issues: []
};
const rawSystemIssues = validateFoundationP2(systemP2, systemSemanticsContext);
assert.ok(rawSystemIssues.some((issue) => issue.code === "SYSTEM_UI_TYPE_MISMATCH"), "系统面板误归人物时应被门禁识别");
assert.ok(rawSystemIssues.some((issue) => issue.code === "SYSTEM_NON_HUMAN_TYPE_MISMATCH"), "系统伪人误归人物时应被门禁识别");
const normalizedSystemP2 = normalizeP2SystemSemantics(systemP2, systemSemanticsContext);
assert.equal(normalizedSystemP2.assets.find((asset) => asset.name === "系统面板")?.type, "PROP", "系统面板应确定性归为道具");
assert.equal(normalizedSystemP2.assets.find((asset) => asset.name === "系统伪人")?.type, "BEAST", "系统伪人应确定性归为非人");
assert.equal(normalizedSystemP2.assets.find((asset) => asset.name === "系统伪人｜残核")?.type, "BEAST", "系统伪人分资产应与主资产同为非人");
assert.equal(validateFoundationP2(normalizedSystemP2, systemSemanticsContext).length, 0, "系统语义归类后不应留下门禁问题");
assert.match(buildFoundationPrompt("P2", { presentation_contracts: [{ category: "system", user_answer: "半透明系统面板" }] }), /系统伪人.*BEAST/s, "P2 提示必须明确系统面板与系统伪人的区别");

async function fakeStage(stageCode: string): Promise<{
  data: Record<string, unknown>;
  sessionId: string | null;
  stdout: string;
  stderr: string;
}> {
  return {
    data: stageCode === "P1" ? fakeP1 : fakeP2,
    sessionId: `fake-${stageCode}`,
    stdout: "",
    stderr: ""
  };
}

void (async () => {
  const project = await createScratchProject("__foundation_verification__");
  const projectId = project.id;
  const batchToken = "verify-foundation";
  try {
    await prisma.$transaction(PROJECT_FOUNDATION_STAGES.map((stage) => prisma.pipelineRun.create({
      data: {
        projectId,
        episodeId: null,
        stageCode: stage.code,
        roleName: stage.name,
        provider: "test",
        model: stage.model,
        inputSummary: JSON.stringify({ batchToken })
      }
    })));

    await executeProjectFoundation(projectId, batchToken, { stageRunner: fakeStage });

    const memory = await prisma.sceneSnapshot.findFirst({ where: { projectId, sceneKey: "PROJECT_MEMORY" } });
    assert.ok(memory, "P1 应写入 PROJECT_MEMORY");
    assert.match(memory?.metadata ?? "", /PROJECT_MEMORY_V2/);
    const memoryBody = JSON.parse(memory?.content ?? "{}");
    assert.equal(memoryBody.episodes.length, 2, "P1 应覆盖全部集");

    const contracts = await prisma.presentationContract.findMany({ where: { projectId } });
    assert.equal(contracts.length, 1, "表现规范应由 P1 直接产生");
    assert.equal(contracts[0]?.category, "system");
    assert.equal(contracts[0]?.episodeId, project.episodes[0]?.id);
    assert.match(contracts[0]?.evidence ?? "", /系统提示：任务完成/);

    const assets = await prisma.asset.findMany({ where: { projectId, type: { in: ["CH", "GROUP", "BEAST", "LOC", "PROP"] } } });
    assert.equal(assets.length, 6, "P2 应写入 6 个资产");
    const sub = assets.find((asset) => asset.name === "苏远｜校服·受伤");
    const parent = assets.find((asset) => asset.name === "苏远");
    assert.ok(sub?.parentId, "分资产应带 parentId");
    assert.equal(sub?.parentId, parent?.id, "分资产 parentId 应指向主资产");
    assert.equal(sub?.code, parent?.code.replace(/-1$/, "-2"), "分资产 code 应为 主形象-2（家族编号：主形象 -1，分资产 -2+）");
    assert.ok(sub?.firstSeenNode, "分资产应带 firstSeenNode");

    const scene = await prisma.scriptScene.findFirst({ where: { sceneKey: "1-1", episode: { projectId } } });
    const sceneMeta = JSON.parse(scene?.metadata ?? "{}");
    assert.ok(Array.isArray(sceneMeta.assetRefs) && sceneMeta.assetRefs.includes("苏远"), "场次-资产关联应回写 metadata.assetRefs");

    const runs = await prisma.pipelineRun.findMany({ where: { projectId, inputSummary: { contains: batchToken } } });
    assert.equal(runs.filter((run) => run.status === "SUCCEEDED").length, 2, "P1/P2 都应成功");

    // P1 漏集回归：首轮漏掉一个集号时，流水线应自动补齐并继续执行 P2。
    const repairToken = "verify-foundation-p1-repair";
    await prisma.$transaction(PROJECT_FOUNDATION_STAGES.map((stage) => prisma.pipelineRun.create({
      data: {
        projectId,
        episodeId: null,
        stageCode: stage.code,
        roleName: stage.name,
        provider: "test",
        model: stage.model,
        inputSummary: JSON.stringify({ batchToken: repairToken })
      }
    })));
    let repairCalls = 0;
    const repairStage: FoundationStageRunner = async (stageCode) => {
      if (stageCode === "P1") {
        repairCalls += 1;
        return { data: repairCalls === 1 ? { ...fakeP1, episodes: [fakeP1.episodes[0]] } : fakeP1, sessionId: `repair-${repairCalls}`, stdout: "", stderr: "" };
      }
      return { data: fakeP2, sessionId: "repair-p2", stdout: "", stderr: "" };
    };
    await executeProjectFoundation(projectId, repairToken, { stageRunner: repairStage });
    assert.equal(repairCalls, 2, "P1 漏集后应自动发起一次补齐调用");
    const repairedRun = await prisma.pipelineRun.findFirst({ where: { projectId, stageCode: "P1", inputSummary: { contains: repairToken } } });
    assert.match(repairedRun?.outputSummary ?? "", /"repairs": 1/, "P1 应记录自动补齐次数");

    // 表现规范证据回归：P1 给出无法锚定的 HUD 证据时，应回到 P1 修正，而不是直接取消 P2。
    const presentationToken = "verify-foundation-presentation-repair";
    await prisma.$transaction(PROJECT_FOUNDATION_STAGES.map((stage) => prisma.pipelineRun.create({
      data: {
        projectId,
        episodeId: null,
        stageCode: stage.code,
        roleName: stage.name,
        provider: "test",
        model: stage.model,
        inputSummary: JSON.stringify({ batchToken: presentationToken })
      }
    })));
    const brokenHudP1 = {
      ...fakeP1,
      presentation_decisions_needed: [{
        ...fakeP1.presentation_decisions_needed![0],
        category: "hud",
        question: "画面文字应如何呈现？",
        evidence: "这段证据不在原文中",
        source_node_refs: ["N0001"]
      }]
    };
    const repairedHudDecision = {
      ...brokenHudP1.presentation_decisions_needed[0],
      evidence: "系统提示：任务完成",
      source_node_refs: ["N0001"]
    };
    let presentationCalls = 0;
    const presentationRepairStage: FoundationStageRunner = async (stageCode, prompt) => {
      if (stageCode === "P1") {
        presentationCalls += 1;
        if (presentationCalls === 1) {
          return { data: brokenHudP1, sessionId: "presentation-initial", stdout: "", stderr: "" };
        }
        assert.match(prompt, /表现规范证据回修/, "回修调用应明确说明是表现规范证据回修");
        return {
          data: {
            repairs: [{ target_index: 0, action: "keep", decision: repairedHudDecision }],
            issues: []
          },
          sessionId: "presentation-repair",
          stdout: "",
          stderr: ""
        };
      }
      return { data: fakeP2, sessionId: "presentation-p2", stdout: "", stderr: "" };
    };
    await executeProjectFoundation(projectId, presentationToken, { stageRunner: presentationRepairStage });
    assert.equal(presentationCalls, 2, "表现规范证据不合格后应自动回到 P1 修正一次");
    const presentationRun = await prisma.pipelineRun.findFirst({ where: { projectId, stageCode: "P1", inputSummary: { contains: presentationToken } } });
    assert.match(presentationRun?.outputSummary ?? "", /"presentation_repairs": 1/, "P1 应记录表现规范回修次数");
    assert.equal(presentationRun?.status, "SUCCEEDED", "表现规范证据回修成功后 P1 应继续完成");
    const presentationP2Run = await prisma.pipelineRun.findFirst({ where: { projectId, stageCode: "P2", inputSummary: { contains: presentationToken } } });
    assert.equal(presentationP2Run?.status, "SUCCEEDED", "P1 回修成功后 P2 不应被取消");

    // 单步骤：P2 单独重跑（重复幂等）
    const singleToken = "verify-foundation-single";
    await prisma.pipelineRun.create({
      data: { projectId, episodeId: null, stageCode: "P2", roleName: "全剧资产拆解", provider: "test", model: "test", inputSummary: JSON.stringify({ batchToken: singleToken }) }
    });
    await executeProjectFoundation(projectId, singleToken, { stageRunner: fakeStage, singleStage: "P2" });
    const assetsAfter = await prisma.asset.count({ where: { projectId, type: { in: ["CH", "GROUP", "BEAST", "LOC", "PROP"] } } });
    assert.equal(assetsAfter, 6, "单步骤 P2 重跑应幂等");

    // P2 类型关系回归：最终门禁发现分资产错类时，只定点修复该资产，
    // 不得重新调用整片资产拆解；修复成功后才写入正式资产表。
    const mismatchToken = "verify-foundation-p2-targeted-repair";
    await prisma.pipelineRun.create({
      data: { projectId, episodeId: null, stageCode: "P2", roleName: "全剧资产拆解", provider: "test", model: "test", inputSummary: JSON.stringify({ batchToken: mismatchToken }) }
    });
    const mismatchedP2 = {
      ...fakeP2,
      assets: fakeP2.assets.map((asset) => asset.name === "苏远｜校服·受伤" ? { ...asset, type: "LOC" as const } : asset)
    };
    let mismatchCalls = 0;
    await executeProjectFoundation(projectId, mismatchToken, {
      singleStage: "P2",
      stageRunner: (_stageCode, prompt) => {
        mismatchCalls += 1;
        return Promise.resolve({
          data: prompt.includes("定点修复") ? fakeP2 : mismatchedP2,
          sessionId: null,
          stdout: `{"type":"turn.completed","usage":{"input_tokens":100,"cached_input_tokens":50,"output_tokens":20,"reasoning_output_tokens":5,"total_tokens":120}}`,
          stderr: ""
        });
      }
    });
    assert.equal(mismatchCalls, 2, "P2 错类只能再发起一次定点修复调用");
    const targetedRepairRun = await prisma.pipelineRun.findFirst({ where: { projectId, stageCode: "P2", inputSummary: { contains: mismatchToken } } });
    assert.equal(targetedRepairRun?.status, "SUCCEEDED", "P2 定点修复成功后应完成");
    assert.match(targetedRepairRun?.outputSummary ?? "", /"targeted_repairs": 1/, "P2 应记录定点修复次数");
  } finally {
    await prisma.project.delete({ where: { id: projectId } });
    await prisma.$disconnect();
  }

  // P2 不得再通过关键词自动创建表现规范；普通语境中的“系统”不应生成确认卡。
  const ordinarySystemProject = await createScratchProject("__foundation_ordinary_system_verification__", EP1_ORDINARY_SYSTEM);
  try {
    const ordinaryToken = "verify-foundation-ordinary-system";
    await prisma.pipelineRun.create({
      data: { projectId: ordinarySystemProject.id, episodeId: null, stageCode: "P2", roleName: "全剧资产拆解", provider: "test", model: "test", inputSummary: JSON.stringify({ batchToken: ordinaryToken }) }
    });
    await executeProjectFoundation(ordinarySystemProject.id, ordinaryToken, { singleStage: "P2", stageRunner: fakeStage });
    assert.equal(await prisma.presentationContract.count({ where: { projectId: ordinarySystemProject.id } }), 0, "普通语境中的系统不得由 P2 自动创建确认卡");
  } finally {
    await prisma.project.delete({ where: { id: ordinarySystemProject.id } });
    await prisma.$disconnect();
  }

  // 门禁拒收：P2 输出脏名应被 P3 拦截并报错
  const badProject = await createScratchProject("__foundation_gate_verification__");
  try {
    await prisma.pipelineRun.create({
      data: { projectId: badProject.id, episodeId: null, stageCode: "P2", roleName: "全剧资产拆解", provider: "test", model: "test", inputSummary: JSON.stringify({ batchToken: "verify-gate" }) }
    });
    let threw = false;
    try {
      await executeProjectFoundation(badProject.id, "verify-gate", {
        singleStage: "P2",
        stageRunner: () => Promise.resolve({ data: fakeBadP2, sessionId: null, stdout: "", stderr: "" })
      });
    } catch (error) {
      threw = true;
      assert.match(String((error as Error).message), /基础资料校验未通过/, "应报告基础资料校验失败");
    }
    assert.equal(threw, true, "脏名资产应被 P3 拦截");

    // 不可定点修复的脏名不能把坏检查点永久复用；下一次重试应重新判断并正常落库。
    const checkpointRetryToken = "verify-gate-checkpoint-retry";
    await prisma.pipelineRun.create({
      data: { projectId: badProject.id, episodeId: null, stageCode: "P2", roleName: "全剧资产拆解", provider: "test", model: "test", inputSummary: JSON.stringify({ batchToken: checkpointRetryToken }) }
    });
    let checkpointCalls = 0;
    await executeProjectFoundation(badProject.id, checkpointRetryToken, {
      singleStage: "P2",
      stageRunner: () => {
        checkpointCalls += 1;
        return Promise.resolve({ data: fakeP2, sessionId: null, stdout: "", stderr: "" });
      }
    });
    assert.equal(checkpointCalls, 1, "不可定点修复的门禁失败应清理检查点并允许重新判断");
    const checkpointRetryRun = await prisma.pipelineRun.findFirst({ where: { projectId: badProject.id, stageCode: "P2", inputSummary: { contains: checkpointRetryToken } } });
    assert.match(checkpointRetryRun?.outputSummary ?? "", /"resumed_chunks": 0/, "重新判断时不应误报复用旧检查点");
  } finally {
    await prisma.project.delete({ where: { id: badProject.id } });
    await prisma.$disconnect();
  }

  console.log("project foundation pipeline verification passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
