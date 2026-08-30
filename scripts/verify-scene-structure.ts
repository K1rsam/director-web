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

// 同一基础场次编号下的内嵌地点头：必须拆成稳定子场次，不能把公园和饭馆合成一个单元。
const inline = extractScriptScenes(
  2,
  `2-1 市人民公园 日 外
人物：常见青 常望川
△常见青抬脚。

2-1 某饭馆 日 内
人物：常见青 常望川
△圆桌上摆满饭菜。`
);
assert.deepEqual(
  inline.map((scene) => [scene.sceneKey, scene.heading, scene.location]),
  [
    ["2-1", "市人民公园 日 外", "市人民公园"],
    ["2-1-2", "某饭馆 日 内", "某饭馆"]
  ]
);

// Word 导入有时会把场头、人物栏和正文压在同一行，且编号后没有空格。
// 这种格式必须仍按正式场次拆分，不能把后续场次并入 1-1。
const attached = extractScriptScenes(
  1,
  `1-1电梯 夜/内人物：姜恋△狭窄电梯里灯光惨白。△姜恋按亮所有楼层键。

1-2迷雾空地 夜/外人物：姜恋、时烬△系统音响起。`
);
assert.deepEqual(
  attached.map((scene) => [scene.sceneKey, scene.location, scene.timeOfDay, scene.interiorExterior]),
  [
    ["1-1", "电梯", "夜", "内"],
    ["1-2", "迷雾空地", "夜", "外"]
  ]
);
assert.equal(attached[0].metadata.characters instanceof Array, true);
assert.deepEqual(attached[0].metadata.characters, ["姜恋"]);

// 无任何标记时仍回退单场
const flatFallback = extractScriptScenes(3, "只有一段正文，没有场景标记。");
assert.deepEqual(
  flatFallback.map((scene) => [scene.sceneKey, scene.heading]),
  [["3-1", "只有一段正文，没有场景标记。"]]
);

console.log("scene structure verification passed");
