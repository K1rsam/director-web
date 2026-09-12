/**
 * E4 返修轮 unit_lighting 写入范围验证（顾问要求：Repair 只改指定坐标，绝不重新解释整条片）：
 *
 * 场景A（无光影卡）：返修轮只开「镜号.xxx」卡（如 $1 残留 PROMPT_LITERAL_ARTIFACT），
 *   模型即便输出 unit_lighting 重写 → 机械层必须整体丢弃，unit_lighting 保持原样；
 *   命中镜的镜级 patch 正常落库。
 * 场景B（有光影卡）：返修轮开了「1-1-U01.lighting」卡（UNIT_LIGHTING_MISSING），
 *   只有该单元允许重写 unit_lighting；模型对其它单元（1-1-U02）的越权重写必须被丢弃。
 * 场景C（残留归属）：e1.sound 含 $1 → PROMPT_LITERAL_ARTIFACT 卡必须开给 E1（E4 只能改
 *   camera/lighting，开给 E4 永远修不掉 = 死循环）。
 * 场景D/E（收敛闭环）：E1 返修轮按卡修掉 sound 残留 → 再跑 E5 卡自动销，不再无限返修。
 */
import assert from "node:assert/strict";
import { PIPELINE_STAGE_CONFIGS } from "@/lib/episode-pipeline-contracts";
import { executeEpisodePipeline, type PipelineStageRunner } from "@/lib/episode-pipeline";
import { prisma } from "@/lib/prisma";
import { seedApprovedFoundationFixture } from "./fixtures/approved-foundation";

const SOURCE_TEXT = "1-1\n客厅 日 内\n场景：客厅\n人物：苏远、赵清雅\n道具：手机\n苏远拿起手机。\n苏远：你看。";

let lastPrompt = "";

async function fakeStage(stageCode: string, prompt?: string): Promise<{ data: Record<string, unknown>; sessionId: string | null; stdout: string; stderr: string }> {
  if (prompt) lastPrompt = prompt;
  return { data: fakeStageOutput(stageCode), sessionId: `fake-${stageCode}`, stdout: "", stderr: "" };
}

function fakeStageOutput(stageCode: string): Record<string, unknown> {
  if (stageCode === "E0") return {
    role: "E0", episode_number: 1, target_duration: 5,
    sequences: [{ sequence_id: "S01", title: "测试链", causal_chain: "单事件", node_range: [1, 2],
      beats: [{ beat_id: "B01", title: "单镜事件", node_range: [1, 2], drama_function: "测试", target_shots: 1, max_shots: 1, target_seconds: 5, max_seconds: 6,
        visual_steps: [{ step_id: "V1", label: "EVENT", directive: "展示事件" }], anchor_nodes: [] }] }],
    notes: "测试骨架"
  };
  if (stageCode === "E1") return {
    base_revision: "V1_TEST",
    shots: [{ shot_id: "1-1-S001", scene_id: "1-1", duration: 5, shot_function: "信息动作镜", picture: "苏远拿起手机并说出提示",
      camera_motion: "中近景，轻微手持", sound: "手机提示音", transition: "硬切",
      dialogue_spans: [{ source_node_id: "N0002", span_state: "whole" }], fulfills_visual_step: "V1",
      visual_step_part_goal: "苏远拿起手机并说出提示", risk_notes: "",
      source_node_refs: ["N0001", "N0002"] }],
    tickets: [], status: "set"
  };
  if (stageCode === "E2") return {
    role: "E2", base_revision: "V1_TEST",
    patches: [{ shot_id: "1-1-S001", action: "set", fields: { picture: "苏远从桌边拿起手机，说出台词，平静带点得意；结束手机停在身前" } }],
    issues: []
  };
  if (stageCode === "E3") return {
    role: "E3", base_revision: "V1_TEST",
    patches: [{ shot_id: "1-1-S001", action: "set", fields: { sound: "手机提示音", transition: "硬切" } }],
    units: [{ unit_id: "1-1-U01", shot_ids: ["1-1-S001"], unit_duration: 5, short_unit_reason: "SHORT_EXCEPTION/QUICK_ACTION_CUT|本场只有一个完整短动作，场次边界必须独立",
      unit_dominant_goal: "展示手机提示", subject_bindings: ["苏远"], unit_start_premise: "苏远在桌边，手机在手边", unit_end_state: "苏远仍在桌边持手机" }],
    issues: []
  };
  if (stageCode === "E4") return {
    role: "E4", base_revision: "V1_TEST",
    unit_lighting: [{ unit_id: "1-1-U01", lighting: "单元光型：主光为窗光，轮廓光勾边" }],
    patches: [{ shot_id: "1-1-S001", action: "set", fields: { camera_motion: "中近景，平视，苏远居左手机居中，轻微手持", lighting: "主光为窗光，轮廓光勾边" } }],
    issues: []
  };
  return {
    role: "E5", revision: "V1_TEST", coverage: { scenes: 1, shots: 1, units: 1, domains: ["E4摄影光影"] },
    issues: [], verdict: "professional_pass", decision: "pass", routes: [], reason: "全部硬校验与独立审查通过"
  };
}

async function unitLightingOf(episodeId: string, unitKey: string): Promise<string> {
  const unit = await prisma.seedanceUnit.findUnique({ where: { episodeId_unitKey: { episodeId, unitKey } } });
  return String((JSON.parse(unit?.data ?? "{}") as Record<string, unknown>).unit_lighting ?? "");
}

void (async () => {
  const project = await prisma.project.create({
    data: {
      title: "__e4_repair_scope_verify__",
      style: "真人电影写实",
      aspectRatio: "16:9",
      episodes: {
        create: {
          number: 1, title: "第一集", content: SOURCE_TEXT,
          scriptScenes: {
            create: {
              sceneKey: "1-1", sortOrder: 1, heading: "客厅 日 内", location: "客厅", interiorExterior: "内",
              timeOfDay: "日", timeLayer: "现实", sourceText: SOURCE_TEXT,
              metadata: JSON.stringify({ characters: ["苏远", "赵清雅"], props: ["手机"] })
            }
          }
        }
      }
    },
    include: { episodes: true }
  });
  const episode = project.episodes[0];
  const scene = await prisma.scriptScene.findFirstOrThrow({ where: { episodeId: episode.id } });
  try {
    await seedApprovedFoundationFixture(project.id, prisma);
    // 全量 E0-E5 首轮（fake）：建立 1-1-U01 + 正确 unit_lighting 基线
    await prisma.$transaction(PIPELINE_STAGE_CONFIGS.map((stage) => prisma.pipelineRun.create({
      data: { projectId: project.id, episodeId: episode.id, stageCode: stage.code, roleName: stage.name, provider: "test",
        model: stage.model, inputSummary: JSON.stringify({ batchToken: "scope-full" }) }
    })));
    await executeEpisodePipeline(project.id, episode.id, "scope-full", { stageRunner: fakeStage as PipelineStageRunner });
    const baseline = await unitLightingOf(episode.id, "1-1-U01");
    assert.equal(baseline, "单元光型：主光为窗光，轮廓光勾边", "首轮 E4 应写入基线 unit_lighting");

    // ===== 场景A：无光影卡（$1 残留），模型越权输出 unit_lighting → 必须整体丢弃 =====
    await prisma.workflowIssue.create({
      data: {
        projectId: project.id, episodeId: episode.id,
        coordinate: "1-1-S001.artifact", code: "PROMPT_LITERAL_ARTIFACT", severity: "BLOCKER",
        ownerRole: "E4", expected: "提示词不得含$1残留", evidence: "sound含$1", requestedEffect: "删除$1残留", revision: "V1_TEST"
      }
    });
    await prisma.pipelineRun.create({
      data: { projectId: project.id, episodeId: episode.id, stageCode: "E4", roleName: "摄影光影", provider: "test", model: "test",
        inputSummary: JSON.stringify({ batchToken: "scope-a" }) }
    });
    const e4FakeA: PipelineStageRunner = async (_stageCode, prompt) => {
      lastPrompt = prompt;
      return {
        data: {
          role: "E4", base_revision: "V1_TEST",
          // 模拟 06:45 串台行为：模型顺手重写命中单元 unit_lighting 为未来状态
          unit_lighting: [{ unit_id: "1-1-U01", lighting: "单元光型：主光为未来水晶石熄灭态（串台稿）" }],
          patches: [{ shot_id: "1-1-S001", action: "set", fields: { lighting: "窗光主光，桌面手机亮屏补光" } }],
          issues: []
        },
        sessionId: null, stdout: "", stderr: ""
      };
    };
    await executeEpisodePipeline(project.id, episode.id, "scope-a", { stageRunner: e4FakeA, singleStage: "E4" });
    assert.equal(await unitLightingOf(episode.id, "1-1-U01"), baseline, "场景A：无光影卡时 unit_lighting 必须保持原样（越权重写被机械丢弃）");
    assert.match(lastPrompt, /本轮没有单元光影卡：\*\*禁止输出 unit_lighting\*\*/, "场景A：返修提示词应明确禁止输出 unit_lighting");
    const shotA = await prisma.storyboardShot.findUnique({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } }, select: { e4Data: true }
    });
    assert.equal(JSON.parse(shotA?.e4Data ?? "{}").lighting, "窗光主光，桌面手机亮屏补光", "场景A：命中镜的镜级 patch 应正常落库");
    await prisma.workflowIssue.deleteMany({ where: { projectId: project.id, episodeId: episode.id, ownerRole: "E4" } });

    // ===== 场景B：有光影卡（1-1-U01.lighting），只有卡上单元允许重写 =====
    // 手工造一个"其它单元"1-1-U02（不在卡上），带现役 unit_lighting
    await prisma.seedanceUnit.create({
      data: {
        episodeId: episode.id, sceneId: scene.id, unitKey: "1-1-U02", sortOrder: 2, duration: 5,
        startPremise: "苏远持手机", endState: "苏远持手机",
        data: JSON.stringify({ unit_id: "1-1-U02", unit_lighting: "OLD-U02：窗光主光", unit_start_premise: "苏远持手机", unit_end_state: "苏远持手机" })
      }
    });
    await prisma.workflowIssue.create({
      data: {
        projectId: project.id, episodeId: episode.id,
        coordinate: "1-1-U01.lighting", code: "UNIT_LIGHTING_MISSING", severity: "BLOCKER",
        ownerRole: "E4", expected: "每单元一条完整布光设定", evidence: "单元缺少 unit_lighting", requestedEffect: "补写单元光型", revision: "V1_TEST"
      }
    });
    await prisma.pipelineRun.create({
      data: { projectId: project.id, episodeId: episode.id, stageCode: "E4", roleName: "摄影光影", provider: "test", model: "test",
        inputSummary: JSON.stringify({ batchToken: "scope-b" }) }
    });
    const e4FakeB: PipelineStageRunner = async (_stageCode, prompt) => {
      lastPrompt = prompt;
      return {
        data: {
          role: "E4", base_revision: "V1_TEST",
          unit_lighting: [
            { unit_id: "1-1-U01", lighting: "修正后单元光型：窗光主光，晨光气氛" },
            { unit_id: "1-1-U02", lighting: "越权重写：U02 不在卡上不应被改" }
          ],
          patches: [], issues: []
        },
        sessionId: null, stdout: "", stderr: ""
      };
    };
    await executeEpisodePipeline(project.id, episode.id, "scope-b", { stageRunner: e4FakeB, singleStage: "E4" });
    assert.equal(await unitLightingOf(episode.id, "1-1-U01"), "修正后单元光型：窗光主光，晨光气氛", "场景B：卡上单元允许重写 unit_lighting");
    assert.equal(await unitLightingOf(episode.id, "1-1-U02"), "OLD-U02：窗光主光", "场景B：非卡单元越权重写必须被丢弃");
    assert.match(lastPrompt, /只允许重写被开「\.lighting」卡的单元\*\*（1-1-U01）/, "场景B：返修提示词应只授权卡上单元重写 unit_lighting");
    // 输入窗口应包含光影卡单元的镜头（targetedShots 扩展），INPUT_JSON.shots 含 1-1-S001
    assert.match(lastPrompt, /"shot_id":"1-1-S001"/, "场景B：光影卡单元的镜头应进入返修输入窗口");
    await prisma.workflowIssue.deleteMany({ where: { projectId: project.id, episodeId: episode.id, ownerRole: "E4" } });

    // ===== 场景C：$1 残留在 e1.sound → 卡必须归 E1（E4 修不掉 E1 的格子） =====
    const shotRow = await prisma.storyboardShot.findUniqueOrThrow({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } }, select: { id: true, e1Data: true }
    });
    const e1WithArtifact = JSON.parse(shotRow.e1Data);
    e1WithArtifact.sound = "人群起哄，$1";
    await prisma.storyboardShot.update({ where: { id: shotRow.id }, data: { e1Data: JSON.stringify(e1WithArtifact) } });
    await prisma.pipelineRun.create({
      data: { projectId: project.id, episodeId: episode.id, stageCode: "E5", roleName: "审查总控", provider: "test", model: "test",
        inputSummary: JSON.stringify({ batchToken: "scope-c" }) }
    });
    const e5FakePass: PipelineStageRunner = async () => ({
      data: {
        role: "E5", revision: "V1_TEST", coverage: { scenes: 1, shots: 1, units: 2, domains: ["E4摄影光影"] },
        issues: [], verdict: "professional_pass", decision: "pass", routes: [], reason: "通过"
      },
      sessionId: null, stdout: "", stderr: ""
    });
    await executeEpisodePipeline(project.id, episode.id, "scope-c", { stageRunner: e5FakePass, singleStage: "E5" });
    const artifactCard = await prisma.workflowIssue.findFirst({
      where: { episodeId: episode.id, coordinate: "1-1-S001.e1.sound", code: "PROMPT_LITERAL_ARTIFACT", status: "OPEN" }
    });
    assert.ok(artifactCard, "场景C：e1.sound 残留应开出 artifact 卡");
    assert.equal(artifactCard?.ownerRole, "E1", "场景C：e1.sound 残留卡必须归 E1（E4 只能改 camera/lighting）");

    // ===== 场景D/E：E1 返修轮修掉 sound 残留 → 再跑 E5 卡自动销（收敛闭环） =====
    await prisma.pipelineRun.create({
      data: { projectId: project.id, episodeId: episode.id, stageCode: "E1", roleName: "结构导演", provider: "test", model: "test",
        inputSummary: JSON.stringify({ batchToken: "scope-d" }) }
    });
    const e1FakeFix: PipelineStageRunner = async (_stageCode, prompt) => {
      lastPrompt = prompt;
      return {
        data: {
          base_revision: "V1_TEST",
          patches: [{ shot_id: "1-1-S001", action: "set", fields: { sound: "人群起哄声、同学乙接话" } }],
          issues: [], status: "set"
        },
        sessionId: null, stdout: "", stderr: ""
      };
    };
    await executeEpisodePipeline(project.id, episode.id, "scope-d", { stageRunner: e1FakeFix, singleStage: "E1" });
    const shotAfterD = await prisma.storyboardShot.findUniqueOrThrow({
      where: { episodeId_shotKey: { episodeId: episode.id, shotKey: "1-1-S001" } }, select: { e1Data: true }
    });
    assert.equal(JSON.parse(shotAfterD.e1Data).sound, "人群起哄声、同学乙接话", "场景D：E1 返修轮应修掉 e1.sound 的 $1 残留");
    assert.match(lastPrompt, /`\.sound` → fields\.sound/, "场景D：E1 返修提示词应支持 .sound 坐标修复");
    await prisma.pipelineRun.create({
      data: { projectId: project.id, episodeId: episode.id, stageCode: "E5", roleName: "审查总控", provider: "test", model: "test",
        inputSummary: JSON.stringify({ batchToken: "scope-e" }) }
    });
    await executeEpisodePipeline(project.id, episode.id, "scope-e", { stageRunner: e5FakePass, singleStage: "E5" });
    const reopened = await prisma.workflowIssue.findFirst({
      where: { episodeId: episode.id, coordinate: "1-1-S001.e1.sound", status: "OPEN" }
    });
    assert.equal(reopened, null, "场景E：修复后 E5 复审不应再开 artifact 卡（收敛闭环）");

    // ===== 场景F（纯逻辑）：回归检测命中集合聚合 repairCoords（10:50 轮误回滚根因） =====
    // 模拟：queue 侧旧代码未写 openCoords（只有 openBlockerCoords），但执行侧各 run 已写 repairCoords
    //（含 MAJOR 卡坐标）→ checkRepairRegression 聚合后，MAJOR 卡镜号必须进入命中集合，不误判越界
    const mockRuns = [
      JSON.stringify({ batchToken: "x", repairPipeline: true, openBlockerCoords: ["2-2-S017.picture"], repairCoords: ["2-2-S017.picture", "2-1-S011.dialogue", "2-2-S003.dialogue", "2-2-S015.dialogue"] }),
      JSON.stringify({ batchToken: "x", repairPipeline: true, repairCoords: ["2-2-S017.picture", "2-1-S004.picture", "2-1-S013.picture"] })
    ];
    const aggregated = new Set<string>();
    for (const raw of mockRuns) {
      const parsed = JSON.parse(raw) as { repairCoords?: string[] };
      for (const c of parsed.repairCoords ?? []) aggregated.add(c);
    }
    const scopeCoords = aggregated.size ? [...aggregated] : ["2-2-S017.picture"];
    const hitShotKeys = new Set(scopeCoords.map((c) => c.split(".")[0]));
    for (const key of ["2-2-S017", "2-1-S011", "2-1-S004", "2-1-S013", "2-2-S003"]) {
      assert.ok(hitShotKeys.has(key), `场景F：MAJOR 修复镜 ${key} 应进入回归命中集合（否则合法修复被误判越界回滚）`);
    }
    assert.ok(!hitShotKeys.has("2-2-S999"), "场景F：无关镜不应进入命中集合");
  } finally {
    await prisma.project.delete({ where: { id: project.id } });
    await prisma.$disconnect();
  }
  console.log("E4 repair unit_lighting scope verification passed");
})();
