import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseSceneBatch, parseSourceText, SCENE_PARSER_VERSION } from "@/lib/source-parser";
import type { SceneParserVersion, SceneResult, SceneSplitPlan } from "@/lib/source-parser";

function rebuild(text: string, sections: { start: number; end: number }[]) {
  return sections.map((section) => text.slice(section.start, section.end)).join("");
}

const crlfEmoji = "前言🙂\r\n第0集 人物设定\r\n人物：苏远\r\n第1集\r\n第一集\r\n1-1 客厅 夜 内\r\n人物：苏远、赵清雅\r\n苏远：回来。\r\n";
const parsed = parseSourceText(crlfEmoji);
assert.equal(rebuild(crlfEmoji, parsed.sourceStructure.sections), crlfEmoji, "sections use JS UTF-16 coordinates and preserve CRLF exactly");
assert.deepEqual(parsed.episodes.map((episode) => episode.number), [1]);
assert.equal(parsed.sourceStructure.sections[0]?.kind, "BACKGROUND");
assert.equal(parsed.episodes[0]?.content, "第1集\r\n第一集\r\n1-1 客厅 夜 内\r\n人物：苏远、赵清雅\r\n苏远：回来。\r\n");

const ambiguous = "第1集\n甲稿\n第2集\n明确稿\n第1集\n乙稿\n";
const unresolved = parseSourceText(ambiguous);
assert.equal(unresolved.episodes.length, 1, "same-number drafts remain unresolved by default");
const firstUnresolved = unresolved.sourceStructure.sections.find((section) => section.kind === "UNRESOLVED");
assert.ok(firstUnresolved);
const assigned = parseSourceText(ambiguous, [], { assignments: [{ sectionKey: firstUnresolved!.key, kind: "EPISODE", episodeNumber: 1 }] });
assert.deepEqual(assigned.episodes.map((episode) => episode.number), [1, 2], "a bounded assignment materializes only its selected range");
const unresolvedKeys = unresolved.sourceStructure.sections.filter((section) => section.kind === "UNRESOLVED").map((section) => section.key);
const continued = parseSourceText(ambiguous, [], { assignments: unresolvedKeys.map((sectionKey) => ({ sectionKey, kind: "EPISODE" as const, episodeNumber: 1 })) });
assert.equal(continued.episodes.find((episode) => episode.number === 1)?.content, "第1集\n甲稿\n第1集\n乙稿\n", "explicit same-episode continuations concatenate their exact source slices");
assert.throws(() => parseSourceText(ambiguous, [], { assignments: [{ sectionKey: "EPISODE-2", kind: "EPISODE", episodeNumber: 2 }] }), /unresolved/i);
assert.throws(() => parseSourceText(ambiguous, [], { boundaries: [{ start: 1, kind: "EPISODE", episodeNumber: 9 }] }), /(line boundary|boundaries)/i);
assert.throws(() => parseSourceText(ambiguous, [], { boundaries: [{ start: 0, kind: "EPISODE", episodeNumber: 1 }, { start: ambiguous.indexOf("第2集"), kind: "EPISODE", episodeNumber: 2 }] }), /boundaries/i, "an ambiguous portion beside clear episodes cannot authorize a whole-source rewrite");
const noHeading = "资料🙂\n正剧开始\n";
const manual = parseSourceText(noHeading, [], { boundaries: [{ start: 0, kind: "BACKGROUND" }, { start: "资料🙂\n".length, kind: "EPISODE", episodeNumber: 1 }] });
assert.equal(rebuild(noHeading, manual.sourceStructure.sections), noHeading, "validated manual boundaries remain JS UTF-16 based and complete");
assert.equal(manual.episodes[0]?.content, "正剧开始\n");

const scenes = parseSceneBatch([{ number: 1, content: "第1集\n1-1 地点 夜 内\n人物：苏远、赵清雅\n苏远：回来。\n1-2 天台 日 外\n场景：天台\n" }]);
assert.equal(scenes[0]?.scenes.length, 2);
assert.deepEqual(scenes[0]?.scenes[0] && [scenes[0].scenes[0].sceneKey, scenes[0].scenes[0].location, scenes[0].scenes[0].interiorExterior, scenes[0].scenes[0].timeOfDay, scenes[0].scenes[0].metadata.characters], ["1-1", "地点", "内", "夜", ["苏远", "赵清雅"]]);
assert.match(scenes[0]!.scenes[0]!.sourceText, /^第1集\n/, "the opening material belongs to the first scene");
const inlineHeading = parseSceneBatch([{ number: 1, content: "第1集\n1-1地点 夜 内\n人物：苏远\n" }])[0]!.scenes[0]!;
assert.deepEqual([inlineHeading.sceneKey, inlineHeading.location, inlineHeading.timeOfDay, inlineHeading.interiorExterior], ["1-1", "地点", "夜", "内"], "inline scene heading text remains a usable fixed scene heading");
const twoInline = parseSceneBatch([{ number: 1, content: "第1集\n1-1客厅 夜 内\n甲：回来。\n1-2天台 日 外\n乙：走吧。\n" }])[0]!.scenes;
assert.deepEqual(twoInline.map((scene) => [scene.sceneKey, scene.location]), [["1-1", "客厅"], ["1-2", "天台"]], "two Chinese-adjacent scene headings split into two non-overlapping scenes");
const repeatedPageHeader = parseSceneBatch([{ number: 1, content: "第1集\n1-1 客厅 夜 内\n苏远：上半段。\n1-1 客厅 夜 内\n苏远：下半段。\n" }])[0]!.scenes;
assert.equal(repeatedPageHeader.length, 1);
assert.match(repeatedPageHeader[0]!.sourceText, /上半段[\s\S]*下半段/, "identical repeated page headers merge without dropping source text");
const conflictingNumber = parseSceneBatch([{ number: 1, content: "第1集\n1-1 客厅 夜 内\n苏远：上半段。\n1-1 天台 日 外\n苏远：下半段。\n" }])[0]!.scenes;
assert.deepEqual(conflictingNumber.map((scene) => scene.sceneKey), ["1-1", "1-1__2"]);
assert.ok(conflictingNumber.every((scene) => scene.sourceText.includes("上半段") || scene.sourceText.includes("下半段")), "conflicting duplicate scene numbers retain both source segments");
assert.equal(conflictingNumber[1]!.metadata.sceneKeyAmbiguous, true);
const fieldMetadata = parseSceneBatch([{ number: 1, content: "1-1\n场景：大厅\n时间：夜\n内外：内\n天气：雨\n时间层：闪回\n" }])[0]!.scenes[0]!;
assert.deepEqual([fieldMetadata.location, fieldMetadata.timeOfDay, fieldMetadata.interiorExterior, fieldMetadata.weather, fieldMetadata.timeLayer], ["大厅", "夜", "内", "雨", "闪回"], "explicit ordinary scene metadata is retained without inference");

const dotRaw = "第1集\r\n1.1 日，内，道观  \r\n人物：沈青、玄真\r\n沈青：回来🙂。 \r\n1.2日，外，江北路\r\n玄真：走吧。  \r\n";
const dotScenes = parseSceneBatch([{ number: 1, content: dotRaw }])[0]!.scenes;
assert.equal(dotScenes.length, 2, "dot-numbered comma-separated headings must form two source scenes");
assert.deepEqual(dotScenes.map(scene => [scene.sceneKey, scene.location, scene.timeOfDay, scene.interiorExterior, scene.weather]), [
  ["1-1", "道观", "日", "内", null], ["1-2", "江北路", "日", "外", null]
]);
assert.deepEqual(dotScenes.map(scene => scene.heading), ["日，内，道观", "日，外，江北路"], "heading punctuation is retained while metadata is normalized");
assert.equal(dotScenes.map(scene => scene.sourceText).join(""), dotRaw, "dot scene parsing preserves CRLF, emoji, trailing spaces and opening material exactly");

for (const quantity of ["1.5 小时后，黄昏", "1.5小时后，黄昏"]) {
  const raw = `第1集\n1.1 日，内，道观\n甲乙：等待。\n${quantity}\n甲乙：继续等。\n1.2 夜，外，江北路\n`;
  const parsed = parseSceneBatch([{ number: 1, content: raw }])[0]!.scenes;
  assert.deepEqual(parsed.map(scene => scene.sceneKey), ["1-1", "1-2"], "a trailing time word cannot turn a decimal quantity into a scene heading");
  assert.equal(parsed.map(scene => scene.sourceText).join(""), raw);
}
const locationFirstDot = parseSceneBatch([{ number: 1, content: "1.1 道观 夜 内\n甲乙：来。\n1．2 江北路，外，日\n" }])[0]!.scenes;
assert.deepEqual(locationFirstDot.map(scene => [scene.sceneKey, scene.location, scene.timeOfDay, scene.interiorExterior]), [["1-1", "道观", "夜", "内"], ["1-2", "江北路", "日", "外"]], "location-first headings retain their explicit time and interior/exterior fields in either order");

const mixedRaw = "第1集\n1．1 夜,内,道观,雨,闪回\n沈青：醒来。\n1.2日，外，江北路\n1.5米长的绳子。\n1.6 公里外是村庄。\n1.7日后回来。\n1.2.3 日，内，列表条目\n1．2．4 夜,外,列表条目\n1.2. 日，内，带尾点列表\n1－3客厅 夜 内\n沈青：这里。\n场1—4 天台 日 外\n玄真：好。\n1-5无提示字段仍是旧场号\n";
const mixedScenes = parseSceneBatch([{ number: 1, content: mixedRaw }])[0]!.scenes;
assert.deepEqual(mixedScenes.map(scene => scene.sceneKey), ["1-1", "1-2", "1-3", "1-4", "1-5"], "ASCII/fullwidth dots and commas coexist with all legacy hyphens; quantities and multi-dot lists are not headers");
assert.deepEqual([mixedScenes[0]!.location, mixedScenes[0]!.weather, mixedScenes[0]!.timeLayer], ["道观", "雨", "闪回"]);
assert.equal(mixedScenes[4]!.location, "无提示字段仍是旧场号", "the new cue guard must not narrow hyphen headings");
assert.equal(mixedScenes.map(scene => scene.sourceText).join(""), mixedRaw);
const uncued = "第1集\n1.1 无提示编号条目\n1.2 另一个编号条目\n";
assert.equal(parseSceneBatch([{ number: 1, content: uncued }])[0]!.scenes.length, 1, "a dot number alone is not a scene-heading cue");
const explicitDot = parseSceneBatch([{ number: 1, content: "场1.1 道观\n甲乙：来。\n场 1．2 江北路\n" }])[0]!.scenes;
assert.deepEqual(explicitDot.map(scene => [scene.sceneKey, scene.location]), [["1-1", "道观"], ["1-2", "江北路"]], "an explicit scene prefix is also a clear heading cue");
const dotRepeated = parseSceneBatch([{ number: 1, content: "1.1 日，内，道观\n沈青：上半段。\n1.1 日，内，道观\n沈青：下半段。\n1.1 夜，外，江北路\n" }])[0]!.scenes;
assert.deepEqual(dotRepeated.map(scene => scene.sceneKey), ["1-1", "1-1__2"]);
assert.equal(dotRepeated[1]!.metadata.sceneKeyAmbiguous, true);

function rawSceneRequest(episodes: { number: number; content: string }[], sceneParserVersions?: Record<number, string>) {
  const child = spawnSync(process.env.PYTHON ?? "python3", [path.join(process.cwd(), "scripts/source_parser.py")], {
    input: JSON.stringify({ operation: "parse_scenes", episodes, ...(sceneParserVersions === undefined ? {} : { sceneParserVersions }) }), encoding: "utf8"
  });
  assert.ifError(child.error);
  return JSON.parse(child.stdout) as { ok: boolean; value: SceneResult[]; error?: { message: string } };
}
const rawLegacy = rawSceneRequest([{ number: 1, content: dotRaw }]);
assert.equal(rawLegacy.ok, true);
assert.equal(rawLegacy.value[0]!.scenes.length, 1, "old Python callers without version metadata stay on V1");
const rawUnknown = rawSceneRequest([{ number: 1, content: dotRaw }], { 1: "SCENE_PARSER_V9" });
assert.equal(rawUnknown.ok, false, "unknown parser versions must be rejected instead of silently changing semantics");
assert.match(rawUnknown.error!.message, /version/i);

const v1: SceneParserVersion = "SCENE_PARSER_V1", v2: SceneParserVersion = "SCENE_PARSER_V2";
assert.equal(SCENE_PARSER_VERSION, v2, "new wrapper calls explicitly default to the current scene parser version");
const versioned = parseSceneBatch([{ number: 1, content: dotRaw }, { number: 2, content: dotRaw }], [], { versions: { 1: v1 } });
assert.deepEqual(versioned[0]!.scenes, rawLegacy.value[0]!.scenes, "an explicit V1 episode must reproduce the old Python output");
assert.equal(versioned[1]!.scenes.length, 2, "the wrapper explicitly selects V2 for episodes omitted from its version map");
assert.equal(rawSceneRequest([{ number: 1, content: dotRaw }], { 1: v2 }).value[0]!.scenes.length, 2, "the raw protocol accepts explicit V2");
assert.throws(() => parseSceneBatch([{ number: 1, content: dotRaw }], [], { versions: { 1: "SCENE_PARSER_V9" as SceneParserVersion } }), /version/i);

const legacyCommaRaw = "第1集\r\n1-1 日，内，道观  \r\n沈青：抬头🙂。 \r\n△天空，云层散开。  \r\n1-2 夜 外 江北路\r\n";
const legacyPlan: SceneSplitPlan = { episode: 1, sourceHash: createHash("sha256").update(legacyCommaRaw, "utf8").digest("hex"), sceneKey: "1-1", cuts: [{ startLine: 4, anchor: "△天空，云层散开。  ", location: "天空", interiorExterior: "外" }] };
const legacySplit = parseSceneBatch([{ number: 1, content: legacyCommaRaw }], [legacyPlan], { versions: { 1: v1 } })[0]!.scenes;
assert.deepEqual([legacySplit[0]!.heading, legacySplit[0]!.location, legacySplit[0]!.timeOfDay, legacySplit[0]!.interiorExterior, legacySplit[0]!.weather], ["日，内，道观", "日，内，道观", null, null, null], "V1 split make_scene must preserve its old comma metadata semantics");
assert.deepEqual((legacySplit[0]!.metadata.sourceSplit as { fields: { location: string } }).fields.location, "日，内，道观");
for (const version of [v1, v2]) {
  const input = [{ number: 1, content: legacyCommaRaw }], options = { versions: { 1: version } };
  const split = parseSceneBatch(input, [legacyPlan], options)[0]!.scenes;
  assert.deepEqual(split.map(scene => scene.sceneKey), ["1-1", "1-1__L4", "1-2"]);
  assert.equal(split.map(scene => scene.sourceText).join(""), legacyCommaRaw, `${version} split replay retains the exact original source`);
  const cut = legacyPlan.cuts[0]!;
  for (const invalid of [
    { ...legacyPlan, sourceHash: "0".repeat(64) },
    { ...legacyPlan, cuts: [{ ...cut, anchor: cut.anchor.trim() }] },
    { ...legacyPlan, cuts: [cut, cut] },
    { ...legacyPlan, cuts: [{ ...cut, startLine: 1 }] },
    { ...legacyPlan, cuts: [{ ...cut, startLine: 5, anchor: "1-2 夜 外 江北路" }] }
  ]) assert.throws(() => parseSceneBatch(input, [invalid], options), /sourceHash|anchor|line/i, `${version} rejects stale hashes, non-exact anchors and invalid interior cuts`);
}
const dotPlan = { ...legacyPlan, sourceHash: createHash("sha256").update(dotRaw, "utf8").digest("hex"), cuts: [{ startLine: 4, anchor: "沈青：回来🙂。 ", location: "道观" }] };
const dotSplit = parseSceneBatch([{ number: 1, content: dotRaw }], [dotPlan])[0]!.scenes;
assert.deepEqual(dotSplit.map(scene => scene.sceneKey), ["1-1", "1-1__L4", "1-2"]);
assert.deepEqual([dotSplit[0]!.location, dotSplit[0]!.timeOfDay, dotSplit[0]!.interiorExterior], ["道观", "日", "内"], "V2 split make_scene uses the same metadata semantics as initial parsing");
assert.equal(dotSplit.map(scene => scene.sourceText).join(""), dotRaw);

const sourceWithDotCandidate = "第1集\n1-1 日 内 道观\n2.1 日，外，江北路\n第3集\n3-1 夜 内 天台\n";
assert.deepEqual(parseSourceText(sourceWithDotCandidate).episodes.map(episode => episode.number), [1, 3], "new dot recognition must not change parse_source or saved F1 episode boundaries");
assert.equal(parseSourceText("1.1 日，内，道观\n1.2日，外，江北路\n").episodes.length, 0, "dot-only source remains unresolved at the independent episode-boundary stage");

console.log("source parser verification passed");
