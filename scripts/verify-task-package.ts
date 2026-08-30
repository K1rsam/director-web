import assert from "node:assert/strict";
import { extractEpisodeAssetCandidates, generateAssetId } from "@/lib/assets";
import { buildDirectorRuleContextSummary } from "@/lib/director-rules";
import { buildSceneSnapshot, buildTaskSchemaV4Payload, validateTaskSchemaV4Payload } from "@/lib/task-package";

async function main() {
  assert.equal(generateAssetId("CH"), "CH-001");
  assert.equal(generateAssetId("CH", [{ id: "CH-001" }, { id: "CH-009" }]), "CH-010");
  assert.equal(generateAssetId("NEG"), "NEG-001");

  const episodeText = `第一场 夜 内 医院病房
叶风：你把合同拿出来。
林月握着手机，退到病床边。
王腾：这枚玉佩怎么在你手里？`;

  const assets = extractEpisodeAssetCandidates(episodeText);
  assert.ok(assets.characters.some((asset) => asset.id === "CH-001" && asset.name === "叶风"));
  assert.ok(assets.locations.some((asset) => asset.id.startsWith("LOC-")));
  assert.ok(assets.props.some((asset) => asset.name === "手机"));
  assert.ok(assets.all.every((asset) => asset.status === "needs_confirmation"));

  const standardized = extractEpisodeAssetCandidates(`1-1
场景：学校礼堂
人物：苏远（校服受伤状态）、赵清雅、众人
道具：手机、水晶石
苏远os：声音不建立人物资产。
系统窗口：声音也不建立人物资产。`);
  assert.deepEqual(standardized.characters.map((asset) => asset.name), ["苏远", "赵清雅", "众人"]);
  assert.ok(!standardized.characters.some((asset) => /系统伪人|系统面板/.test(asset.name)), "系统 UI 或系统伪人不得从粗提结果进入 CH 人物");
  assert.deepEqual(standardized.looks.map((asset) => asset.name), ["苏远｜校服受伤状态"]);
  assert.deepEqual(standardized.locations.map((asset) => asset.name), ["学校礼堂"]);
  assert.deepEqual(standardized.props.map((asset) => asset.name), ["手机", "水晶石"]);

  const snapshot = buildSceneSnapshot({ sceneText: episodeText, assets: assets.all });
  assert.equal(snapshot["场次ID"], "SC-一");
  assert.match(snapshot["出场人物ID"], /CH-001/);
  assert.notEqual(snapshot["必须保留的关键台词"], "无");

  const rules = await buildDirectorRuleContextSummary();
  assert.ok(rules.sources.some((source) => source.summary.some((line) => line.includes("TASK_SCHEMA_V4"))));
  assert.ok(rules.sources.some((source) => source.title === "场次快照模板"));

  const payload = await buildTaskSchemaV4Payload({
    projectName: "验证项目",
    episodeNumber: 1,
    episodeText
  });

  const validation = validateTaskSchemaV4Payload(payload);
  assert.equal(validation.ok, true, validation.errors.join("\n"));

  const broken = validateTaskSchemaV4Payload({ schema: "TASK_SCHEMA_V3" });
  assert.equal(broken.ok, false);
  assert.ok(broken.errors.some((error) => error.includes("缺 TASK_SCHEMA_V4")));
  assert.ok(broken.errors.some((error) => error.includes("缺关键字段")));

  console.log("task package verification passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
