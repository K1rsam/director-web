import assert from "node:assert/strict";
import { extractScriptScenes } from "@/lib/scene-structure";

const scenes = extractScriptScenes(
  8,
  `第八集
8-1
大考秘境·森林空地 日 外 薄雾
场景：大考秘境·森林空地
人物：赵清雅、苏远
道具：长剑
赵清雅回头。

8-2
山洞 夜 内 闪回
场景：山洞
人物：苏远（少年状态）
道具：无
苏远抬头。`
);

assert.equal(scenes.length, 2);
assert.deepEqual(
  scenes.map((scene) => [scene.sceneKey, scene.location, scene.timeOfDay, scene.interiorExterior, scene.timeLayer]),
  [
    ["8-1", "大考秘境·森林空地", "日", "外", "现实"],
    ["8-2", "山洞", "夜", "内", "闪回"]
  ]
);
assert.match(scenes[0].sourceText, /赵清雅回头/);

const fallback = extractScriptScenes(1, "没有分镜编号的单集正文");
assert.equal(fallback[0].sceneKey, "1-1");

// 扁平化导入格式：无编号场头，按「场景 X」标记行拆分（冒号可省略）
const flat = extractScriptScenes(
  2,
  `场景 姑苏高中觉醒大厅
赵清雅（深吸一口气，怒色）：不可理喻！
△ 说完，赵清雅转身离开。
场景 觉醒大厅外
△苏远刚离开觉醒大厅，赵天明迎面走来。
场景：三号独立觉醒室
△ 室内空空如也。`
);

assert.deepEqual(
  flat.map((scene) => [scene.sceneKey, scene.heading, scene.location, scene.timeLayer]),
  [
    ["2-1", "2-1", "姑苏高中觉醒大厅", "现实"],
    ["2-2", "2-2", "觉醒大厅外", "现实"],
    ["2-3", "2-3", "三号独立觉醒室", "现实"]
  ]
);
assert.equal(flat[0].sourceText.includes("赵清雅"), true);
assert.equal(flat[1].sourceText.includes("赵天明"), true);
assert.equal(flat[2].sourceText.includes("三号独立觉醒室"), true);

// 无任何标记时仍回退单场
const flatFallback = extractScriptScenes(3, "只有一段正文，没有场景标记。");
assert.deepEqual(
  flatFallback.map((scene) => [scene.sceneKey, scene.heading]),
  [["3-1", "只有一段正文，没有场景标记。"]]
);

console.log("scene structure verification passed");
