import assert from "node:assert/strict";
import * as f from "@/lib/project-foundation-contracts";

// Synthetic source shapes only; no user database or saved model output is read.
const episode = (number: number, count: number, textAt: Record<number, string>) => ({ number, title: null, content: Array.from({ length: count }, (_, i) => textAt[i + 1] ?? `原行${i + 1}`).join("\n") });
const index = f.buildSourceIndex([
  episode(1, 40, { 9: "林研秋说明守则。" }),
  episode(7, 70, { 55: "一道黑色的影子正在移动。", 63: "它有猩红的眼睛。" }),
  episode(11, 60, { 51: "沙哑（VO）：来吧……" })
]);
const ref = (episode: number, startLine = 9, endLine = startLine) => ({ episode, startLine, endLine });
const def = (patch: Record<string, unknown> = {}) => ({ key: "known", name: "林研秋", type: "CH", aliases: ["原已登记称谓"], description: "原有身份说明。", sourceRefs: [ref(1)], ...patch });
const use = (episode = 1, patch: Record<string, unknown> = {}) => ({ key: "known", presence: "ONSTAGE", state: "本集有据状态。", sourceRefs: [ref(episode, episode === 1 ? 9 : 55)], ...patch });
const wire = (episode = 1, assets: unknown = [def()], uses: unknown = [use(episode)], patch: Record<string, unknown> = {}) => ({ coverage: [episode], assets, episodes: [{ number: episode, context: "当前资料。", uses }], issues: [], ...patch });
const f1 = { coverage: [1], overview: "概述", episodes: [{ number: 1, summary: "摘要", context: "当前资料", sourceSelections: [] }], issues: [] };
const q1 = { coverage: [1], verdict: "READY", summary: "独立结论。", issues: [] };
const prior = f.requireF2AuthorOutput(wire(), index, [1]);
let checks = 0;
const failures: string[] = [];
function check(name: string, test: () => void) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  try { test(); checks++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

check("three real-shaped nonliteral labels and omitted issues remain intact as reviewable candidates", () => {
  const cases = [
    { number: 1, label: "林管理", from: 9, to: 31 },
    { number: 7, label: "黑色影子", from: 55, to: 63 },
    { number: 11, label: "沙哑VO", from: 51, to: 55 }
  ];
  for (const item of cases) {
    const sourceRefs = [ref(item.number, item.from, item.to)];
    const raw = freeze(wire(item.number, [def({ sourceRefs })], [use(item.number, { sourceRefs, sourceName: item.label })], { issues: undefined }));
    const before = JSON.stringify(raw);
    assert.deepEqual(f.validateF2AuthorOutput(raw, index, [item.number]), []);
    const output = f.requireF2AuthorOutput(raw, index, [item.number]);
    assert.equal(output.assets[0].appearances[0].sourceName, item.label);
    assert.equal(output.assets[0].appearances[0].sourceNameMatch, "NON_LITERAL");
    assert.deepEqual(output.assets[0].appearances[0].sourceRefs, sourceRefs);
    assert.deepEqual(output.issues, []); assert.deepEqual(output.dataIssues ?? [], []);
    assert.ok(!("verdict" in output)); assert.equal(JSON.stringify(raw), before);
  }
});

check("literal matching is recomputed in both directions and is not an identity approval", () => {
  for (const [sourceName, claim, expected] of [["林研秋", "NON_LITERAL", "LITERAL"], [" 林管理 ", "LITERAL", "NON_LITERAL"]]) {
    const output = f.requireF2AuthorOutput(wire(1, [def({ name: "另一待核身份" })], [use(1, { sourceName, sourceNameMatch: claim })]), index, [1]);
    assert.equal(output.assets[0].appearances[0].sourceName, sourceName);
    assert.equal(output.assets[0].appearances[0].sourceNameMatch, expected);
    assert.equal(output.assets[0].name, "另一待核身份", "字面匹配不得自动改身份归并");
    assert.ok(!("approved" in output)); assert.deepEqual(output.issues, []);
  }
});

check("background label matching uses only its explicit source excerpts and preserves the label", () => {
  const output = f.requireF2AuthorOutput(wire(7, null, [{ key: "known", presence: "BACKGROUND", purpose: "前接身份依据", sourceRefs: [ref(1, 10)], sourceName: "林研秋", sourceNameMatch: "LITERAL", state: null }]), index, [7], prior.assets);
  assert.deepEqual(output.assets[0].appearances, []);
  assert.equal(output.episodes[0].backgroundRefs?.[0].sourceName, "林研秋");
  assert.equal(output.episodes[0].backgroundRefs?.[0].sourceNameMatch, "NON_LITERAL", "名字虽在该集第9行，未在本项第10行摘录");
  assert.deepEqual(output.dataIssues ?? [], []);
});

check("background literal matching cannot fabricate a label by joining discontinuous excerpts", () => {
  const source = "甲\n中间原文不能跳掉。\n乙";
  const localIndex = f.buildSourceIndex([{ number: 1, title: null, content: source }]);
  const evaluate = (sourceName: string, sourceRefs: ReturnType<typeof ref>[], sourceNameMatch: string) => f.requireF2AuthorOutput(wire(1, [def({ name: "甲", sourceRefs: [ref(1, 1)] })], [{
    key: "known", presence: "BACKGROUND", purpose: "本集背景依据", sourceRefs, sourceName, sourceNameMatch
  }]), localIndex, [1]);
  const label = "甲\n\n乙";
  assert.equal(source.includes(label), false);
  const discontinuous = evaluate(label, [ref(1, 1), ref(1, 3)], "LITERAL");
  assert.equal(discontinuous.episodes[0].backgroundRefs?.[0].sourceName, label);
  assert.equal(discontinuous.episodes[0].backgroundRefs?.[0].sourceNameMatch, "NON_LITERAL");
  assert.deepEqual(discontinuous.issues, []); assert.deepEqual(discontinuous.dataIssues ?? [], []);
  const continuous = evaluate(source, [ref(1, 1, 3)], "NON_LITERAL");
  assert.equal(continuous.episodes[0].backgroundRefs?.[0].sourceName, source);
  assert.equal(continuous.episodes[0].backgroundRefs?.[0].sourceNameMatch, "LITERAL");
});

check("all roles accept nil issue lists but nonready Q1 still requires an actionable issue", () => {
  for (const issues of [undefined, null, []]) {
    assert.deepEqual(f.requireF1Output({ ...f1, issues }, index, [1]).issues, []);
    assert.deepEqual(f.requireF2AuthorOutput({ ...wire(), issues }, index, [1]).issues, []);
    assert.deepEqual(f.requireQ1Output({ ...q1, issues }, index, [1]).issues, []);
    for (const verdict of ["REPAIR", "BLOCKED"]) assert.throws(() => f.requireQ1Output({ ...q1, verdict, issues }, index, [1]), f.FoundationContractError);
  }
  for (const severity of ["MAJOR", "BLOCKER"]) assert.throws(() => f.requireQ1Output({ ...q1, issues: [{ severity, owner: "F2", coordinate: "身份", problem: "真实待修问题", sourceRefs: [] }] }, index, [1]), /READY/);
});

check("issues without source anchors retain their full original problem and remain unlocated", () => {
  for (const sourceRefs of [undefined, null, []]) {
    const issue = { severity: "MAJOR", owner: "F2", coordinate: "待定位", problem: "原问题全文不能丢。", sourceRefs };
    const output = f.requireQ1Output({ ...q1, verdict: "REPAIR", issues: [issue] }, index, [1]);
    assert.deepEqual(output.issues, [{ ...issue, sourceRefs: [] }]);
  }
  for (const issue of [null, {}, { severity: "MAJOR", owner: "F2", coordinate: "位置", problem: "问题", sourceRefs: [null] }]) assert.throws(() => f.requireQ1Output({ ...q1, verdict: "REPAIR", issues: [issue] }, index, [1]), f.FoundationContractError);
});

check("known identity all-nil increments retain prior facts and only the explicitly supplied current state", () => {
  const raw = wire(7, [{ key: "known", name: null, type: null, description: null, aliases: null, sourceRefs: null, descriptionVariants: null, appearances: null }], [use(7, { purpose: null, sourceName: null, sourceNameMatch: "LITERAL" })], {
    episodes: [{ number: 7, context: "当集", uses: [use(7, { purpose: null, sourceName: null, sourceNameMatch: "LITERAL" })], assetKeys: null, backgroundRefs: null }], issues: null
  });
  const result = f.requireF2AuthorOutput(raw, index, [7], prior.assets);
  assert.equal(result.assets[0].name, prior.assets[0].name); assert.equal(result.assets[0].type, prior.assets[0].type);
  assert.equal(result.assets[0].description, prior.assets[0].description); assert.deepEqual(result.assets[0].aliases, prior.assets[0].aliases);
  assert.deepEqual(result.assets[0].sourceRefs, prior.assets[0].sourceRefs);
  assert.deepEqual(result.assets[0].appearances, [{ episode: 7, presence: "ONSTAGE", state: "本集有据状态。", sourceRefs: [ref(7, 55)] }]);
  assert.deepEqual(result.dataIssues ?? [], []);
});

check("nil assets mean no new definitions only when all uses resolve to the verified registry", () => {
  for (const assets of [undefined, null, []]) {
    const raw = { ...wire(7), assets };
    assert.deepEqual(f.requireF2AuthorOutput(raw, index, [7], prior.assets).episodes[0].assetKeys, ["known"]);
    assert.throws(() => f.requireF2AuthorOutput(raw, index, [7]), /key|身份/);
  }
});

check("nil or empty aliases and variants are no increments and cannot erase prior content", () => {
  const enriched = f.requireF2AuthorOutput(wire(7, [{ key: "known", aliases: ["另一称谓"], description: "新增描述。", sourceRefs: [ref(7, 55)] }]), index, [7], prior.assets);
  for (const value of [undefined, null, []]) {
    const next = f.requireF2AuthorOutput(wire(11, [{ key: "known", aliases: value, descriptionVariants: value, sourceRefs: [] }], [use(11, { sourceRefs: [ref(11, 51)] })]), index, [11], enriched.assets);
    assert.deepEqual(next.assets[0].aliases, enriched.assets[0].aliases);
    assert.deepEqual(next.assets[0].descriptionVariants, enriched.assets[0].descriptionVariants);
  }
});

check("known blank name and description mean no update but nonnil type and genuine conflicts remain strict", () => {
  for (const value of [undefined, null, "", " \n"]) {
    const next = f.requireF2AuthorOutput(wire(7, [{ key: "known", name: value, description: value, sourceRefs: [] }]), index, [7], prior.assets);
    assert.equal(next.assets[0].name, prior.assets[0].name); assert.equal(next.assets[0].description, prior.assets[0].description);
  }
  for (const patch of [{ type: "" }, { type: "PROP" }, { name: "无桥改名" }, { name: "临时名", aliases: ["林研秋"] }]) assert.throws(() => f.requireF2AuthorOutput(wire(7, [{ key: "known", ...patch }]), index, [7], prior.assets), f.FoundationContractError);
});

check("auxiliary text nil and whitespace are omitted while meaningful text is exact and bad types reject", () => {
  for (const value of [undefined, null, "", " \n\t"]) {
    const result = f.requireF2AuthorOutput(wire(1, [def()], [use(1, { sourceName: value, sourceNameMatch: "LITERAL" })]), index, [1]);
    assert.ok(!("sourceName" in result.assets[0].appearances[0])); assert.ok(!("sourceNameMatch" in result.assets[0].appearances[0]));
    assert.ok(!("f2Notes" in f.requireF1Output({ ...f1, episodes: [{ ...f1.episodes[0], f2Notes: value }] }, index, [1]).episodes[0]));
  }
  const note = "  原后台线索\n保留格式。  ";
  assert.equal(f.requireF1Output({ ...f1, episodes: [{ ...f1.episodes[0], f2Notes: note }] }, index, [1]).episodes[0].f2Notes, note);
  for (const value of [1, false, {}, []]) {
    assert.throws(() => f.requireF2AuthorOutput(wire(1, [def()], [use(1, { sourceName: value })]), index, [1]), f.FoundationContractError);
    assert.throws(() => f.requireF1Output({ ...f1, episodes: [{ ...f1.episodes[0], f2Notes: value }] }, index, [1]), f.FoundationContractError);
  }
});

check("legacy nil state and background increments never refill a current episode from old appearances", () => {
  for (const value of [undefined, null, []]) {
    const output = f.requireF2Output({ coverage: [7], assets: [{ key: "known", appearances: value }], episodes: [{ number: 7, context: "本集", assetKeys: ["known"], backgroundRefs: value }], issues: null }, index, [7], prior.assets);
    assert.deepEqual(output.assets[0].appearances, []); assert.equal(output.dataIssues?.length, 1);
  }
});

check("new-wire nil shadow fields are unfilled but every nonnil shadow declaration remains rejected", () => {
  for (const value of [undefined, null]) {
    const result = f.requireF2AuthorOutput(wire(1, [{ ...def(), appearances: value }], [], { episodes: [{ number: 1, context: "本集", uses: [use(1, { purpose: value })], assetKeys: value, backgroundRefs: value }] }), index, [1]);
    assert.deepEqual(result.dataIssues ?? [], []);
  }
  for (const value of [[], {}, "", false]) {
    assert.throws(() => f.requireF2AuthorOutput(wire(1, [{ ...def(), appearances: value }]), index, [1]), /双重|uses/);
    assert.throws(() => f.requireF2AuthorOutput(wire(1, [def()], [use(1, { purpose: value })]), index, [1]), /purpose/);
    assert.throws(() => f.requireF2AuthorOutput(wire(1, [def()], [{ key: "known", presence: "BACKGROUND", purpose: "背景", sourceRefs: [ref(1)], state: value }]), index, [1]), /state/);
  }
});

check("core arrays and fact-bearing fields still reject nil, empty facts and malformed elements", () => {
  for (const field of ["coverage", "episodes"]) for (const value of [undefined, null]) assert.throws(() => f.requireF2AuthorOutput({ ...wire(), [field]: value }, index, [1]), f.FoundationContractError);
  for (const uses of [undefined, null]) assert.throws(() => f.requireF2AuthorOutput({ ...wire(), episodes: [{ number: 1, context: "当集", uses }] }, index, [1]), f.FoundationContractError);
  for (const patch of [{ state: null }, { state: " " }, { sourceRefs: null }, { sourceRefs: [] }, { sourceRefs: [null] }, { sourceRefs: [ref(7, 55)] }, { sourceRefs: [ref(1, 99)] }, { key: "unknown" }]) assert.throws(() => f.requireF2AuthorOutput(wire(1, [def()], [use(1, patch)]), index, [1]), f.FoundationContractError);
  for (const patch of [{ name: null }, { description: null }, { type: null }, { sourceRefs: null }, { sourceRefs: [] }]) assert.throws(() => f.requireF2AuthorOutput(wire(1, [def(patch)]), index, [1]), f.FoundationContractError);
  for (const field of ["assets", "issues"]) for (const value of ["[]", {}, 0, false]) assert.throws(() => f.requireF2AuthorOutput({ ...wire(), [field]: value }, index, [1]), f.FoundationContractError);
  for (const patch of [{ aliases: [null] }, { descriptionVariants: [null] }, { aliases: "name" }, { descriptionVariants: "text" }]) assert.throws(() => f.requireF2AuthorOutput(wire(1, [def(patch)]), index, [1]), f.FoundationContractError);
});

check("new text and variant evidence remain required while absent identity-only evidence can be empty", () => {
  for (const sourceRefs of [undefined, null, []]) {
    assert.throws(() => f.requireF2AuthorOutput(wire(7, [{ key: "known", description: "新描述", sourceRefs }]), index, [7], prior.assets), f.FoundationContractError);
    assert.throws(() => f.requireF2AuthorOutput(wire(7, [{ key: "known", descriptionVariants: [{ text: "新变体", sourceRefs }] }]), index, [7], prior.assets), f.FoundationContractError);
    assert.throws(() => f.requireF2AuthorOutput(wire(7, null, [{ key: "known", presence: "BACKGROUND", purpose: "背景", sourceRefs }]), index, [7], prior.assets), f.FoundationContractError);
  }
});

check("canonical revalidation and frozen inputs keep labels and recompute flags without mutation", () => {
  const raw = freeze(wire(7, null, [use(7, { sourceName: "黑色影子", sourceNameMatch: "LITERAL" })], { issues: null }));
  const frozenPrior = freeze(structuredClone(prior.assets)); const before = JSON.stringify({ raw, frozenPrior });
  const parsed = f.requireF2AuthorOutput(raw, index, [7], frozenPrior);
  assert.deepEqual(f.requireF2Output(parsed, index, [7], frozenPrior), parsed);
  const merged = f.mergeF2Outputs([prior, parsed], index, [1, 7]);
  assert.equal(merged.assets[0].appearances.at(-1)?.sourceNameMatch, "NON_LITERAL");
  assert.equal(JSON.stringify({ raw, frozenPrior }), before);
});

if (failures.length) { console.error(`optional fields and label verification failed (${failures.length} failed, ${checks} passed)`); process.exitCode = 1; }
else console.log(`optional fields and label verification passed (${checks} checks; synthetic only; no database or provider)`);
