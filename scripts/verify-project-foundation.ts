import assert from "node:assert/strict";
import { executeProjectFoundation, type FoundationStageRunner } from "@/lib/project-foundation";
import {
  inspectP1ChunkCoverage,
  mergeP1Outputs,
  PROJECT_FOUNDATION_STAGES,
  reanchorP1PresentationDecisions,
  validateFoundationP1,
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

// 分片回归：同一表现类别在不同集出现时必须保留为两条，不得互相拼接引用。
const p1ChunkOne = { ...fakeP1, episodes: [fakeP1.episodes[0]], presentation_decisions_needed: [fakeP1.presentation_decisions_needed![0]] };
const p1ChunkTwo = {
  ...fakeP1,
  episodes: [fakeP1.episodes[1]],
  presentation_decisions_needed: [{ ...fakeP1.presentation_decisions_needed![0], episode_number: 2, evidence: "王老师：迟到三次，站到后面。", source_node_refs: ["N0001"] }]
};
const mergedChunkOutput = mergeP1Outputs([p1ChunkOne, p1ChunkTwo]);
assert.deepEqual(mergedChunkOutput.presentation_decisions_needed?.map((item) => item.episode_number), [1, 2], "表现规范合并必须按集号隔离");
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

    // 单步骤：P2 单独重跑（重复幂等）
    const singleToken = "verify-foundation-single";
    await prisma.pipelineRun.create({
      data: { projectId, episodeId: null, stageCode: "P2", roleName: "全剧资产拆解", provider: "test", model: "test", inputSummary: JSON.stringify({ batchToken: singleToken }) }
    });
    await executeProjectFoundation(projectId, singleToken, { stageRunner: fakeStage, singleStage: "P2" });
    const assetsAfter = await prisma.asset.count({ where: { projectId, type: { in: ["CH", "GROUP", "BEAST", "LOC", "PROP"] } } });
    assert.equal(assetsAfter, 6, "单步骤 P2 重跑应幂等");
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
  } finally {
    await prisma.project.delete({ where: { id: badProject.id } });
    await prisma.$disconnect();
  }

  console.log("project foundation pipeline verification passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
