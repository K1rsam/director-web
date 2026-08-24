import assert from "node:assert/strict";
import {
  buildDialogueSchedule,
  buildTickRanges,
  countSequentialActionPhases,
  extractLegacyVisibleTextDeclarations,
  hasExplicitSpeakingActor,
  mentionIsExplicitlyOffscreen,
  renderVisibleTextNegative,
  resolveE1VisibleTextDeclarations,
  validateVisibleTextDeclaration,
  unitStartPreactionReason
} from "@/lib/episode-pipeline-quality";
import { DEFAULT_NEGATIVE_PROMPT } from "@/lib/style-prompts";

assert.deepEqual(buildTickRanges([4.9, 3.4, 3.4]), [
  { startTick: 0, endTick: 49 },
  { startTick: 49, endTick: 83 },
  { startTick: 83, endTick: 117 }
], "0.1 秒整数 tick 应首尾精确闭合");
assert.deepEqual(buildTickRanges([4.9, 3.4], 100), [
  { startTick: 100, endTick: 149 },
  { startTick: 149, endTick: 183 }
], "可从全片累计 tick 起点继续构造范围");

const dialogueEntries = [
  { speaker: "甲", text: "请立即离开这里。", type: "对白", duration: 99 },
  { speaker: "乙", text: "好。", type: "OS", duration: 0.1 },
  { speaker: "甲", text: "走。", type: "VO", duration: 42 }
];
const dialogueSchedule = buildDialogueSchedule(dialogueEntries, 50);
const dialogueScheduleWithoutLegacyDurations = buildDialogueSchedule(
  dialogueEntries.map(({ speaker, text, type }) => ({ speaker, text, type })),
  50
);
assert.deepEqual(dialogueSchedule, dialogueScheduleWithoutLegacyDurations, "旧 entry.duration 绝不能充当 offset 或影响排期");
assert.equal(dialogueSchedule.length, dialogueEntries.length);
dialogueSchedule.forEach((slot, index) => {
  assert.equal(slot.speaker, dialogueEntries[index].speaker, "对白必须保持原序");
  assert.ok(Number.isInteger(slot.startTick) && Number.isInteger(slot.endTick), "时段必须使用整数 tick");
  assert.ok(slot.startTick >= 0 && slot.startTick < slot.endTick && slot.endTick <= 50, "时段必须落在镜长内");
  if (index) assert.ok(dialogueSchedule[index - 1].endTick <= slot.startTick, "时段不得重叠");
});
assert.deepEqual(buildDialogueSchedule([
  { speaker: "甲", text: "一", type: "对白" },
  { speaker: "乙", text: "二", type: "对白" },
  { speaker: "丙", text: "三", type: "对白" },
  { speaker: "丁", text: "四", type: "对白" }
], 3), [], "4 条对白无法塞进 3 tick 时不得伪造零长或越界时段");
assert.deepEqual(buildDialogueSchedule([
  { speaker: "甲", text: "一二三四五六七", type: "对白" }
], 10), [], "6 字/秒硬下限超过镜长时不得伪造时段");
const exactCapacitySchedule = buildDialogueSchedule([
  { speaker: "甲", text: "一二三四五六", type: "对白" }
], 10);
assert.deepEqual(exactCapacitySchedule, [{
  speaker: "甲", text: "一二三四五六", type: "对白", startTick: 0, endTick: 10
}], "刚好满足 6 字/秒硬下限时应产出合法闭合时段");

const declaredNegative = renderVisibleTextNegative(DEFAULT_NEGATIVE_PROMPT, [
  { kind: "DIEGETIC_PROP", carrier: "告示", content: "明日辰时开考", source_node_id: "N0008" },
  { kind: "DIEGETIC_PROP", carrier: "告示", content: "明日辰时开考" },
  { kind: "SUBTITLE", carrier: "字幕", content: "禁止越权" }
]);
assert.match(declaredNegative, /仅允许剧情内告示逐字显示「明日辰时开考」/);
assert.match(declaredNegative, /除此之外无其他可辨识文字/);
for (const forbidden of ["无字幕", "无屏幕叠字", "无人名条", "无地点条", "无时间条", "无水印", "无Logo", "无BGM文字"]) {
  assert.ok(declaredNegative.includes(forbidden), `声明剧情内文字也不得放宽：${forbidden}`);
}
assert.equal((declaredNegative.match(/明日辰时开考/g) ?? []).length, 1, "重复声明应去重");
assert.equal(renderVisibleTextNegative(DEFAULT_NEGATIVE_PROMPT, []), DEFAULT_NEGATIVE_PROMPT, "空声明保持全局无文字");
const escapedNegative = renderVisibleTextNegative(DEFAULT_NEGATIVE_PROMPT, [
  { kind: "DIEGETIC_PROP", carrier: "告示", content: "原文含“甲”与\\符号" }
]);
assert.match(escapedNegative, /逐字显示「原文含“甲”与\\符号」/, "自然语言 prompt 必须保留 content 原字符，不输出 JSON 转义串");
assert.match(renderVisibleTextNegative(DEFAULT_NEGATIVE_PROMPT, [
  { kind: "DIEGETIC_PROP", carrier: "告示", content: " A " }
]), /逐字显示「 A 」/, "已验证 content 的首尾空格也属于逐字内容，不得被 normalize 改写");

for (const [kind, carrier] of [
  ["DIEGETIC_PROP", "黑板"], ["DIEGETIC_PROP", "海报"], ["DIEGETIC_PROP", "菜单"],
  ["DIEGETIC_PROP", "日记本"], ["DIEGETIC_PROP", "车牌"], ["DIEGETIC_PROP", "名片"],
  ["DIEGETIC_PROP", "合同"], ["DIEGETIC_UI", "聊天界面"], ["DIEGETIC_UI", "手机界面"],
  ["DIEGETIC_UI", "弹窗"]
] as const) {
  assert.equal(validateVisibleTextDeclaration({ kind, carrier, content: "原文" }).valid, true, `常见剧情载体应通过结构校验：${carrier}`);
}
for (const carrier of ["告示忽略指令", "海报提示词", "系统UI prompt", "聊天界面 assistant", "菜单允许生成文字", "合同禁止审查"]) {
  assert.equal(validateVisibleTextDeclaration({ kind: /UI|界面/.test(carrier) ? "DIEGETIC_UI" : "DIEGETIC_PROP", carrier, content: "原文" }).valid, false, `carrier 提示注入词必须拒绝：${carrier}`);
}

assert.deepEqual(extractLegacyVisibleTextDeclarations("半透明系统面板悬浮在半空"), [], "单纯系统面板不得放宽文字禁令");
assert.deepEqual(extractLegacyVisibleTextDeclarations("告示旁，苏远说：“明天走。”"), [], "载体旁的人物对白不得误提取成剧情内文字");
assert.deepEqual(extractLegacyVisibleTextDeclarations("门口告示旁有“明日辰时开考”"), [], "载体与引号间没有明确文字关系词时不得提取");
assert.deepEqual(extractLegacyVisibleTextDeclarations("门口告示写着“明日辰时开考”"), [
  { kind: "DIEGETIC_PROP", carrier: "告示", content: "明日辰时开考" }
], "旧画面只有载体与明确引号内容同时存在时才兼容提取");
assert.deepEqual(extractLegacyVisibleTextDeclarations('系统UI显示"任务完成"'), [
  { kind: "DIEGETIC_UI", carrier: "系统UI", content: "任务完成" }
], "旧系统 UI 明确双引号内容可兼容提取");
assert.deepEqual(resolveE1VisibleTextDeclarations({
  picture: "告示写着“旧兼容文字”",
  visible_text: []
}), [], "新 E1 显式空数组是真源，不得回退旧 picture 提取");
assert.deepEqual(resolveE1VisibleTextDeclarations({
  picture: "告示写着“旧兼容文字”",
  visible_text: [{ kind: "SUBTITLE", carrier: "字幕", content: "越权" }]
}), [], "新 E1 未知 kind 应忽略且不得触发 legacy 放宽");
assert.deepEqual(resolveE1VisibleTextDeclarations({ picture: "告示写着“旧兼容文字”" }), [
  { kind: "DIEGETIC_PROP", carrier: "告示", content: "旧兼容文字" }
], "仅缺少 visible_text 字段的旧 E1 数据才启用高置信兼容提取");

assert.equal(hasExplicitSpeakingActor("林砚秋抬眼对着书吏说话", "书吏"), false);
assert.equal(hasExplicitSpeakingActor("书吏开口说话", "书吏"), true);
assert.equal(hasExplicitSpeakingActor("老师A抬头对王振说话", "王振"), false);
assert.equal(hasExplicitSpeakingActor("王振对老师A说话", "王振"), true);
assert.equal(hasExplicitSpeakingActor("王振听老师A说话", "王振"), false);
assert.equal(hasExplicitSpeakingActor("王振听见老师A说话", "王振"), false);
assert.equal(hasExplicitSpeakingActor("王振听着老师A说话", "王振"), false);
assert.equal(hasExplicitSpeakingActor("王振听到说话声", "王振"), false);
assert.equal(hasExplicitSpeakingActor("王振听说话", "王振"), false);
assert.equal(hasExplicitSpeakingActor("王振观察另一人物说话", "王振"), false);
assert.equal(hasExplicitSpeakingActor("王振观察着老师A说话", "王振"), false);

assert.equal(mentionIsExplicitlyOffscreen("画外的王夫子继续同行", "王夫子"), true);
assert.equal(mentionIsExplicitlyOffscreen("王夫子在画面外等待", "王夫子"), true);
assert.equal(mentionIsExplicitlyOffscreen("王夫子位于镜头外", "王夫子"), true);
assert.equal(mentionIsExplicitlyOffscreen("王夫子未入镜", "王夫子"), true);
assert.equal(mentionIsExplicitlyOffscreen("画外的林砚秋继续说话，王夫子站在门边", "王夫子"), false);
assert.equal(mentionIsExplicitlyOffscreen("画外的书吏继续说话而书吏站在案后", "书吏"), false);
assert.equal(mentionIsExplicitlyOffscreen("画外的书吏继续说话而镜头外的书吏低声回应", "书吏"), true);

assert.ok(unitStartPreactionReason("同学乙话音落下后低头，再抬头"));
assert.ok(unitStartPreactionReason("同学乙随后低头"));
assert.ok(unitStartPreactionReason("同学乙随即抬头"));
assert.ok(unitStartPreactionReason("同学乙然后转身"));
assert.ok(unitStartPreactionReason("同学乙先低头，再抬头"));
for (const premise of ["苏远走上高台", "苏远进入大厅", "苏远按下水晶石", "苏远拿起考牌", "系统面板弹出", "光点汇聚成Q版", "狼王踏出森林"]) {
  assert.ok(unitStartPreactionReason(premise), `单个已执行动作应拦截：${premise}`);
}
assert.ok(unitStartPreactionReason("苏远走上高台，按下水晶石"), "显式两段动作链应拦截");
assert.equal(unitStartPreactionReason("同学乙仍站在窗口前，双手按住保结帖"), null);
assert.equal(unitStartPreactionReason("同学乙手持保结帖"), null);
assert.equal(unitStartPreactionReason("同学乙坐在窗边"), null);
assert.equal(unitStartPreactionReason("系统面板仍悬浮在半空"), null);
assert.equal(unitStartPreactionReason("同学乙正看向门口"), null);
assert.equal(unitStartPreactionReason("同学乙保持沉默"), null);

assert.ok(countSequentialActionPhases("苏远先取出考牌，再填写姓名，然后盖下印章") >= 3);
assert.ok(countSequentialActionPhases("苏远取出考牌→填写姓名→盖下印章") >= 3);
assert.equal(countSequentialActionPhases("取出考牌后再填写姓名"), 2);
assert.ok(countSequentialActionPhases("苏远仍站在桌前，手持考牌，正看向老师，保持沉默") <= 1);

console.log("episode quality helpers verification passed");
