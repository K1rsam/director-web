import assert from "node:assert/strict";
import { cleanEpisodeTitle, episodePresentation, parseEpisodeNumber } from "../lib/episode-presentation";

assert.equal(cleanEpisodeTitle("第一集", 2), "第一集", "A stored title-number conflict must remain visible, not be renamed to the database number");

const numbers: Array<[string, number]> = [
  ["0", 0], ["００", 0], ["5", 5], ["007", 7], [" １２３ ", 123],
  ["零", 0], ["〇", 0], ["一", 1], ["两", 2], ["十", 10], ["十二", 12],
  ["二十", 20], ["二十三", 23], ["一百二十三", 123], ["一千", 1000],
  ["一千零一", 1001], ["两千零二十", 2020], ["二〇二六", 2026],
  ["九千九百九十九", 9999], ["一1", 1], ["二十三23", 23],
  [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER]
];
for (const [text, expected] of numbers) assert.equal(parseEpisodeNumber(text), expected, text);
for (const text of ["", "  ", "-1", "+1", "1.5", "1e3", "Infinity", "一2", "十百", "一百百", "第1集", "abc", "9007199254740992", "999999999999999999999"]) {
  assert.equal(parseEpisodeNumber(text), null, `${text || "empty"} must not become a guessed episode number`);
}

const bare = { numberLabel: "第1集", subtitle: "", fullTitle: "第1集", navigationTitle: "第1集", conflict: false, sourceNumber: 1 };
const named = { ...bare, subtitle: "相遇", fullTitle: "第1集 · 相遇", navigationTitle: "相遇" };
for (const heading of ["第1集", "第一集", "第１集", "EP01", "Episode 01", "ｅｐｉｓｏｄｅ　０１"]) {
  for (const separator of ["", "：", " : ", " · ", "　— "]) {
    assert.deepEqual(episodePresentation(1, heading + separator), bare, heading + separator);
  }
  for (const separator of ["：", " : ", " · ", " ", "　— "]) {
    assert.deepEqual(episodePresentation(1, heading + separator + "相遇"), named, heading + separator + "相遇");
  }
}
for (const title of [null, undefined, "", "   ", "： · —"]) {
  assert.deepEqual(episodePresentation(1, title), { ...bare, sourceNumber: null });
}
for (const title of ["第一集团的秘密", "第一集体的秘密", "Episode One", "序章", "前言"]) {
  assert.deepEqual(episodePresentation(5, title), { numberLabel: "第5集", subtitle: title, fullTitle: `第5集 · ${title}`, navigationTitle: title, conflict: false, sourceNumber: null });
}
for (const [number, title] of [[0, "第零集：开端"], [5, "第五集：跳号"], [7, "EP07 · 再会"]] as const) {
  const result = episodePresentation(number, title);
  assert.equal(result.sourceNumber, number);
  assert.equal(result.conflict, false);
  assert.ok(result.fullTitle.startsWith(`第${number}集 · `));
}
for (const title of ["第一集", "第一集：", "第１集：相遇", "Episode 01 · 相遇"]) {
  const result = episodePresentation(2, title);
  assert.equal(result.sourceNumber, 1);
  assert.equal(result.conflict, true);
  assert.equal(result.subtitle, title);
  assert.equal(result.fullTitle, `第2集 · ${title}（集号冲突）`);
  assert.equal(result.navigationTitle, `${title}（集号冲突）`);
  assert.equal(cleanEpisodeTitle(title, 2), title);
}
assert.equal(episodePresentation(1, "第一集：第一集团的秘密").subtitle, "第一集团的秘密");
assert.equal(episodePresentation(1, "第1集：真的相遇！").subtitle, "真的相遇！", "Meaningful title punctuation must survive");
assert.equal(episodePresentation(1, "第9007199254740992集：异常").sourceNumber, null, "Unsafe numbers must not become a rounded header match");
assert.equal(episodePresentation(1, "第9007199254740992集：异常").subtitle, "第9007199254740992集：异常");

assert.equal(cleanEpisodeTitle(" 第一集  相遇（原集号与前文重复，已自动整理为第2集） ", 2), "第一集 相遇");
assert.equal(cleanEpisodeTitle("相遇（原集号为第-1集，不是有效集号，已自动整理为第2集）", 2), "相遇");
assert.equal(cleanEpisodeTitle(null, 0), "第0集");
assert.equal(cleanEpisodeTitle("\t\n", 7), "第7集");
assert.equal(cleanEpisodeTitle(undefined), "未命名集");
assert.equal(cleanEpisodeTitle("第一集", 1), "第1集", "The old same-number generic-title normalization remains compatible");
assert.equal(episodePresentation(1, "1.1 日，内，道观", {sceneCount:2}).fullTitle, "第1集 · 2场", "A first scene heading is not an episode name");
assert.equal(episodePresentation(25, "", {sceneCount:4}).fullTitle, "第25集 · 4场", "Blank names use the same entry format");
assert.equal(episodePresentation(1, "第一集：归来", {sceneCount:2}).fullTitle, "第1集 · 2场 · 归来", "Real episode names remain visible");
assert.equal(episodePresentation(2, "第一集：归来", {sceneCount:3}).fullTitle, "第2集 · 3场 · 第一集：归来（集号冲突）", "An inconsistent source title must not be silently hidden");
for(const title of ["26.1日，内，医院病房", "２６．１ 日，内，医院病房", "26-1 夜 外 医院门口", "场26-1 夜 内 病房", "第1场 日 内 病房", "26 夜，内，医院病房"]){
  assert.equal(episodePresentation(26,title,{sceneCount:1}).fullTitle,"第26集 · 1场",title);
}
for(const title of ["1.1%的机会", "21世纪的归来", "21 夜色里的秘密", "1.1 日记里的答案", "第1集：日夜之间"]){
  assert.ok(episodePresentation(1,title,{sceneCount:2}).fullTitle.endsWith(title.replace(/^第1集：/,"")),`${title} is not an unambiguous scene heading`);
}
for(const sceneCount of [null,undefined,0,-1,1.5,NaN,Infinity]){
  assert.equal(episodePresentation(1,"1.1 日，内，道观",{sceneCount}).fullTitle,"第1集 · 场次待识别","Unknown scene counts are not guessed");
}
assert.equal(episodePresentation(0,"序章",{sceneCount:1}).fullTitle,"第0集 · 1场 · 序章");
assert.equal(episodePresentation(1,"1.1 日，内，道观").fullTitle,"第1集 · 1.1 日，内，道观","Existing frozen task-title callers remain unchanged");
console.log("PASS: pure episode presentation; matching headers, visible conflicts, empty titles, zero/gaps, Chinese/full-width/safe numbers and legacy-note cleanup; no project data or model calls");
