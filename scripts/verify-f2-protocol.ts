import assert from "node:assert/strict";
import * as foundation from "@/lib/project-foundation-contracts";
import type { F2Asset, F2Output, SourceRef } from "@/lib/project-foundation-contracts";

let checks = 0;
const failures: string[] = [];
function check(name: string, run: () => void) {
  try { run(); checks += 1; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const index = foundation.buildSourceIndex([26, 27, 28].map((number) => ({ number, title: null, content: "甲出现。\n蜃又名蜃龙。\n人物被提及。\n背景信息。" })));
const ref = (episode: number, line = 1): SourceRef => ({ episode, startLine: line, endLine: line });
const appearance = (episode: number, state = "有据源状态。", line = 1): F2Asset["appearances"][number] => ({ episode, presence: "ONSTAGE", state, sourceRefs: [ref(episode, line)] });
const asset = (episode: number, patch: Partial<F2Asset> = {}): F2Asset => ({ key: "ch_luchen", name: "陆沉", type: "CH", aliases: [], description: "陆沉是有据身份，长描述。", sourceRefs: [ref(episode)], appearances: [appearance(episode)], ...patch });
const part = (episode: number, assets: unknown[], assetKeys = ["ch_luchen"], extra: Record<string, unknown> = {}) => ({ coverage: [episode], assets, episodes: [{ number: episode, context: "当前集身份资料。", assetKeys }], issues: [], ...extra });
const first = foundation.requireF2Output(part(26, [asset(26)]), index, [26]);

check("description shortening and new facts coexist with their own sources", () => {
  const second = part(27, [asset(27, { description: "陆沉，身份短述。" })]);
  const third = part(28, [asset(28, { description: "新增有据事实。" })]);
  const merged = foundation.mergeF2Outputs([first, second as F2Output, third as F2Output], index, [26, 27, 28]);
  assert.equal(merged.assets[0].description, first.assets[0].description);
  assert.deepEqual(merged.assets[0].descriptionVariants, [
    { text: first.assets[0].description, sourceRefs: [ref(26)] },
    { text: "陆沉，身份短述。", sourceRefs: [ref(27)] },
    { text: "新增有据事实。", sourceRefs: [ref(28)] }
  ]);
  assert.equal(merged.assets[0].appearances.length, 3);
  assert.deepEqual(foundation.requireF2Output(merged, index, [26, 27, 28]), merged, "规范化后重复校验须幂等，不能污染描述来源");
});

check("same description unions source references without duplicating text", () => {
  const merged = foundation.mergeF2Outputs([first, part(27, [asset(27)]) as F2Output], index, [26, 27]);
  assert.deepEqual(merged.assets[0].sourceRefs, [ref(26), ref(27)]);
  assert.equal(new Set(merged.assets[0].descriptionVariants?.map((entry) => entry.text)).size <= 1, true);
});

check("repeated variant text unions only that text's sources", () => {
  const merged = foundation.mergeF2Outputs([first, part(27, [asset(27, { description: "片段另一描述。" })]) as F2Output, part(28, [asset(28)]) as F2Output], index, [26, 27, 28]);
  assert.deepEqual(merged.assets[0].descriptionVariants, [
    { text: first.assets[0].description, sourceRefs: [ref(26), ref(28)] },
    { text: "片段另一描述。", sourceRefs: [ref(27)] }
  ]);
});

check("identity-only added evidence is not relabeled as evidence for the prior description", () => {
  const second = foundation.requireF2Output(part(27, [{ key: "ch_luchen", aliases: ["阿沉"], sourceRefs: [ref(27)], appearances: [appearance(27)] }]), index, [27], first.assets);
  const merged = foundation.mergeF2Outputs([first, second, part(28, [asset(28, { description: "后段新描述。" })]) as F2Output], index, [26, 27, 28]);
  assert.deepEqual(merged.assets[0].sourceRefs, [ref(26), ref(27), ref(28)]);
  assert.deepEqual(merged.assets[0].descriptionVariants, [
    { text: first.assets[0].description, sourceRefs: [ref(26)] },
    { text: "后段新描述。", sourceRefs: [ref(28)] }
  ]);
});

check("four previously registered keys can be referenced without new definitions", () => {
  const prior = foundation.requireF2Output(part(26, ["ch_luchen", "prop_key", "loc_room", "ch_friend"].map((key) => asset(26, { key })), ["ch_luchen", "prop_key", "loc_room", "ch_friend"]), index, [26]);
  const raw = freeze(part(28, [], prior.assets.map((item) => item.key)));
  const before = JSON.stringify(raw);
  assert.deepEqual(foundation.validateF2Output(raw, index, [28], prior.assets), []);
  const next = foundation.requireF2Output(raw, index, [28], prior.assets);
  assert.deepEqual(next.assets.map((item) => item.key), prior.assets.map((item) => item.key));
  assert.ok(next.assets.every((item) => item.appearances.length === 0), "不得把26/27集状态复制到28集");
  assert.equal(next.dataIssues?.length, 4);
  for (const issue of next.dataIssues ?? []) {
    assert.equal(issue.owner, "F2"); assert.equal(issue.severity, "BLOCKER");
    assert.ok(issue.coordinate.includes("28") && prior.assets.some((item) => issue.coordinate.includes(item.key)));
    assert.match(issue.problem, /本集.*状态|背景.*用途/);
    assert.deepEqual(issue.sourceRefs, [], "缺源状态不得伪造当前集依据");
  }
  assert.equal(JSON.stringify(raw), before);
});

check("known-key deltas reuse stable identity and only carry newly supplied states", () => {
  const next = foundation.requireF2Output(part(27, [{ key: "ch_luchen", aliases: ["阿沉"], appearances: [appearance(27)] }]), index, [27], first.assets);
  assert.equal(next.assets[0].name, "陆沉"); assert.equal(next.assets[0].type, "CH");
  assert.equal(next.assets[0].description, first.assets[0].description);
  assert.deepEqual(next.assets[0].appearances, [appearance(27)]);
  assert.deepEqual(next.assets[0].aliases, ["阿沉"]);
  assert.deepEqual(next.dataIssues ?? [], []);
  const third = foundation.requireF2Output(part(28, []), index, [28], foundation.mergeF2Outputs([first, next], index, [26, 27]).assets);
  assert.deepEqual(third.assets[0].appearances, []);
});

check("unknown keys and incomplete new identities are still rejected", () => {
  assert.throws(() => foundation.requireF2Output(part(28, [], ["unknown"]), index, [28], first.assets), foundation.FoundationContractError);
  assert.throws(() => foundation.requireF2Output(part(28, [{ key: "unknown" }], ["unknown"]), index, [28], first.assets), foundation.FoundationContractError);
  assert.throws(() => foundation.requireF2Output(part(28, [asset(28, { key: "unknown", appearances: [] })], ["unknown"]), index, [28], first.assets), foundation.FoundationContractError);
});

check("type conflicts and names without an already registered alias bridge are rejected", () => {
  for (const patch of [{ type: "PROP" }, { name: "另一人" }, { name: "另一人", aliases: ["陆沉"] }]) {
    assert.throws(() => foundation.requireF2Output(part(27, [{ ...asset(27), ...patch }]), index, [27], first.assets), foundation.FoundationContractError);
  }
});

check("a prior alias bridge preserves the first registered canonical name", () => {
  const prior = foundation.requireF2Output(part(26, [asset(26, { key: "beast_shen", name: "蜃", type: "BEAST", aliases: ["蜃龙"] })], ["beast_shen"]), index, [26]);
  const raw = part(27, [asset(27, { key: "beast_shen", name: "蜃龙", type: "BEAST", description: "蜃龙的本片新描述。" })], ["beast_shen"]);
  const next = foundation.requireF2Output(raw, index, [27], prior.assets);
  assert.equal(next.assets[0].name, "蜃"); assert.ok(next.assets[0].aliases.includes("蜃龙"));
  assert.equal(foundation.mergeF2Outputs([prior, raw as F2Output], index, [26, 27]).assets[0].name, "蜃");
});

check("raw batch merging matches incremental validation as the registry gains aliases", () => {
  const secondRaw = part(27, [{ key: "ch_luchen", aliases: ["阿沉"], appearances: [appearance(27)] }]);
  const thirdRaw = part(28, [{ key: "ch_luchen", name: "阿沉", description: "新片事实。", sourceRefs: [ref(28)], appearances: [appearance(28)] }]);
  const second = foundation.requireF2Output(secondRaw, index, [27], first.assets);
  const registered = foundation.mergeF2Outputs([first, second], index, [26, 27]);
  const third = foundation.requireF2Output(thirdRaw, index, [28], registered.assets);
  const sequential = foundation.mergeF2Outputs([first, second, third], index, [26, 27, 28]);
  const batched = foundation.mergeF2Outputs([first, secondRaw as F2Output, thirdRaw as F2Output], index, [26, 27, 28]);
  assert.deepEqual(batched, sequential); assert.equal(batched.assets[0].name, "陆沉");
  assert.ok(batched.assets[0].aliases.includes("阿沉"));
});

check("new descriptions require their own record evidence and preserve variants", () => {
  assert.throws(() => foundation.requireF2Output(part(27, [{ key: "ch_luchen", description: "新的身份依据。", appearances: [appearance(27)] }]), index, [27], first.assets), foundation.FoundationContractError);
  const next = foundation.requireF2Output(part(27, [{ key: "ch_luchen", description: "新的身份依据。", sourceRefs: [ref(27)], appearances: [appearance(27)] }]), index, [27], first.assets);
  assert.deepEqual(next.assets[0].descriptionVariants, [{ text: first.assets[0].description, sourceRefs: [ref(26)] }, { text: "新的身份依据。", sourceRefs: [ref(27)] }]);
});

check("explicit sourced background use does not invent an appearance", () => {
  const next = foundation.requireF2Output(part(28, [], ["ch_luchen"], { episodes: [{ number: 28, context: "理解往事所需身份。", assetKeys: ["ch_luchen"], backgroundRefs: [{ key: "ch_luchen", purpose: "说明本集回忆所涉身份，不声称在场。", sourceRefs: [ref(26)] }] }], dataIssues: [{ forged: true }] }), index, [28], first.assets);
  assert.deepEqual(next.assets[0].appearances, []);
  assert.deepEqual(next.dataIssues ?? [], []);
  assert.deepEqual(foundation.collectF2DataIssues(next), []);
  const missing = foundation.requireF2Output(part(28, [], ["ch_luchen"], { dataIssues: [] }), index, [28], first.assets);
  assert.equal(missing.dataIssues?.length, 1, "模型不得自行清空程序数据问题");
});

check("invalid background keys, empty purpose and invalid sources remain structural failures", () => {
  for (const background of [
    { key: "unknown", purpose: "用途", sourceRefs: [ref(26)] },
    { key: "ch_luchen", purpose: " ", sourceRefs: [ref(26)] },
    { key: "ch_luchen", purpose: "用途", sourceRefs: [] },
    { key: "ch_luchen", purpose: "用途", sourceRefs: [ref(28, 99)] }
  ]) assert.throws(() => foundation.requireF2Output(part(28, [], ["ch_luchen"], { episodes: [{ number: 28, context: "背景。", assetKeys: ["ch_luchen"], backgroundRefs: [background] }] }), index, [28], first.assets), foundation.FoundationContractError);
  assert.throws(() => foundation.requireF2Output(part(28, [], [], { episodes: [{ number: 28, context: "背景。", assetKeys: [], backgroundRefs: [{ key: "ch_luchen", purpose: "用途", sourceRefs: [ref(26)] }] }] }), index, [28], first.assets), foundation.FoundationContractError);
  for (const patch of [
    { description: "新文字", sourceRefs: [ref(27, 9)] },
    { descriptionVariants: [{ text: "新文字", sourceRefs: [ref(99)] }] },
    { appearances: [{ ...appearance(27), sourceRefs: [ref(26)] }] }
  ]) assert.throws(() => foundation.requireF2Output(part(27, [{ key: "ch_luchen", ...patch }]), index, [27], first.assets), foundation.FoundationContractError);
});

check("full merge accepts normalized reference-only parts and recomputes current-use issues", () => {
  const next = foundation.requireF2Output(part(27, [{ key: "ch_luchen", appearances: [appearance(27)] }]), index, [27], first.assets);
  const third = foundation.requireF2Output(part(28, []), index, [28], first.assets);
  const merged = foundation.mergeF2Outputs([first, next, third], index, [26, 27, 28]);
  assert.deepEqual(merged.assets[0].appearances.map((entry) => entry.episode), [26, 27]);
  assert.equal(merged.dataIssues?.length, 1); assert.ok(merged.dataIssues?.[0].coordinate.includes("28"));
  assert.deepEqual(merged.dataIssues, foundation.collectF2DataIssues(merged));
});

check("distinct event evidence is not silently lost and identical records may deduplicate", () => {
  const next = foundation.requireF2Output(part(27, [{ key: "ch_luchen", appearances: [appearance(27), appearance(27, "有据源状态。", 2), appearance(27)] }]), index, [27], first.assets);
  const merged = foundation.mergeF2Outputs([first, next], index, [26, 27]);
  const current = merged.assets[0].appearances.filter((entry) => entry.episode === 27);
  assert.equal(current.length, 2); assert.deepEqual(current.map((entry) => entry.sourceRefs[0].startLine), [1, 2]);
});

check("formatting shows every description and evidence but preserves legacy text", () => {
  assert.equal(foundation.formatF2AssetDescription(first.assets[0]), first.assets[0].description);
  const enriched: F2Asset = { ...first.assets[0], descriptionVariants: [{ text: "先登记文本。", sourceRefs: [ref(26)] }, { text: "后续文本。", sourceRefs: [ref(28, 2)] }] };
  const text = foundation.formatF2AssetDescription(enriched);
  for (const expected of ["先登记文本。", "后续文本。", "第26集", "第28集", "L1", "L2"]) assert.ok(text.includes(expected), expected);
});

check("F2 transport has a separate content-hashed protocol and leaves shared F1/Q1 text alone", () => {
  assert.match(foundation.F2_PROTOCOL_VERSION, /^F2_BATCH_V4:[a-f0-9]{64}$/);
  const expected = `F2_BATCH_V4:${foundation.hashFoundationPrompt(JSON.stringify({ rules: foundation.F2_PROTOCOL_RULES, schema: foundation.FOUNDATION_OUTPUT_SCHEMAS.F2 }))}`;
  assert.equal(foundation.F2_PROTOCOL_VERSION, expected);
  const prompt = foundation.buildFoundationPrompt("F2", { scope: [28] });
  assert.ok(prompt.includes(foundation.F2_PROTOCOL_VERSION));
  assert.ok(prompt.includes(foundation.F2_PROTOCOL_RULES));
  for (const field of ["descriptionVariants", "backgroundRefs", "sourceRefs"]) assert.ok(prompt.includes(field));
  assert.ok(!foundation.buildFoundationPrompt("F1", {}).includes(foundation.F2_PROTOCOL_VERSION));
  assert.ok(!foundation.buildFoundationPrompt("Q1", {}).includes(foundation.F2_PROTOCOL_VERSION));
});

check("deep-frozen raw and prior records are never mutated during normalization or merge", () => {
  const rawFirst = freeze(part(26, [asset(26)]));
  const rawSecond = freeze(part(27, [{ key: "ch_luchen", description: "片段缩写。", sourceRefs: [ref(27)], appearances: [appearance(27)] }]));
  const before = JSON.stringify([rawFirst, rawSecond]);
  const prior = freeze(foundation.requireF2Output(rawFirst, index, [26]));
  const priorBefore = JSON.stringify(prior);
  const next = foundation.requireF2Output(rawSecond, index, [27], prior.assets);
  foundation.mergeF2Outputs([prior, freeze(next)], index, [26, 27]);
  assert.equal(JSON.stringify([rawFirst, rawSecond]), before);
  assert.equal(JSON.stringify(prior), priorBefore);
});

if (failures.length) { console.error(`F2 protocol verification failed (${failures.length} failed, ${checks} passed)`); process.exitCode = 1; }
else console.log(`F2 protocol verification passed (${checks} checks; deterministic contract tests only)`);
