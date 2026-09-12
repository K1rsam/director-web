import assert from "node:assert/strict";
import * as foundation from "@/lib/project-foundation-contracts";
import type { SourceRef } from "@/lib/project-foundation-contracts";

const index = foundation.buildSourceIndex([
  { number: 0, title: "背景", content: "蜃又名蜃龙。\n甲持有旧伞。\n仅背景称谓。" },
  { number: 1, title: "开场", content: "甲走进雨中。\n他接过伞。\n乙在旁说话。\n蜃龙被提及。" },
  { number: 2, title: "接续", content: "甲把伞交给乙。\n蜃龙现身。\n他转身离去。" }
]);
const ref = (episode: number, line = 1): SourceRef => ({ episode, startLine: line, endLine: line });
const definition = (episode = 1, patch: Record<string, unknown> = {}) => ({ key: "jia", name: "甲", type: "CH", aliases: [], description: "有据人物身份。", sourceRefs: [ref(episode)], ...patch });
const use = (episode = 1, patch: Record<string, unknown> = {}) => ({ key: "jia", presence: "ONSTAGE", state: "按本集原文行动。", sourceRefs: [ref(episode)], sourceName: "甲", ...patch });
const wire = (episode = 1, assets: unknown[] = [definition(episode)], uses: unknown[] = [use(episode)], extra: Record<string, unknown> = {}) => ({
  coverage: [episode], assets, episodes: [{ number: episode, context: "当集必要资料。", uses }], issues: [], ...extra
});
const legacy = () => ({ coverage: [1], assets: [{ ...definition(), appearances: [{ episode: 1, presence: "ONSTAGE", state: "走进雨中。", sourceRefs: [ref(1)] }] }], episodes: [{ number: 1, context: "当集必要资料。", assetKeys: ["jia"] }], issues: [] });
const failures: string[] = [];
let checks = 0;
function check(name: string, test: () => void) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  try { test(); checks++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

check("new uses wire deterministically derives both canonical views without retaining another uses source", () => {
  const result = foundation.requireF2Output(wire(), index, [1]);
  assert.deepEqual(result.episodes[0].assetKeys, ["jia"]);
  assert.deepEqual(result.assets[0].appearances, [{ episode: 1, presence: "ONSTAGE", state: "按本集原文行动。", sourceRefs: [ref(1)], sourceName: "甲", sourceNameMatch: "LITERAL" }]);
  assert.ok(!("uses" in result.episodes[0])); assert.deepEqual(result.dataIssues ?? [], []);
  assert.deepEqual(foundation.requireF2Output(result, index, [1]), result, "派生canonical须可再次校验");
});

check("author boundary requires uses in every episode while generic reads still accept old canonical", () => {
  assert.equal(typeof foundation.requireF2AuthorOutput, "function", "正常生成必须有独立author入口");
  assert.equal(typeof foundation.validateF2AuthorOutput, "function");
  assert.deepEqual(foundation.requireF2AuthorOutput(wire(), index, [1]), foundation.requireF2Output(wire(), index, [1]));
  assert.deepEqual(foundation.validateF2AuthorOutput(wire(), index, [1]), []);
  assert.throws(() => foundation.requireF2AuthorOutput(legacy(), index, [1]), foundation.FoundationContractError);
  assert.ok(foundation.validateF2AuthorOutput(legacy(), index, [1]).some((issue) => issue.coordinate.includes("uses")));
  assert.deepEqual(foundation.requireF2Output(legacy(), index, [1]).episodes[0].assetKeys, ["jia"]);
  const partial = wire(1, [definition()], [], { coverage: [1, 2], episodes: [{ number: 1, context: "第一集", uses: [use()] }, { number: 2, context: "第二集", assetKeys: ["jia"] }] });
  assert.throws(() => foundation.requireF2AuthorOutput(partial, index, [1, 2]), /uses|双重|混/);
});

check("known uses need no repeated definition and never inherit a previous episode state", () => {
  const prior = foundation.requireF2Output(legacy(), index, [1]);
  const next = foundation.requireF2Output(wire(2, [], [use(2, { state: "把伞交给乙。" })]), index, [2], prior.assets);
  assert.equal(next.assets[0].name, "甲"); assert.deepEqual(next.episodes[0].assetKeys, ["jia"]);
  assert.deepEqual(next.assets[0].appearances.map((entry) => entry.episode), [2]);
  assert.equal(next.assets[0].appearances[0].state, "把伞交给乙。");
  assert.deepEqual(next.dataIssues ?? [], []);
});

check("missing states, missing sources, wrong episode refs and unknown keys stay structural failures", () => {
  for (const patch of [{ state: undefined }, { state: " " }, { sourceRefs: undefined }, { sourceRefs: [] }, { sourceRefs: [ref(2)] }, { sourceRefs: [ref(1, 99)] }, { key: "unknown" }, { presence: "UNKNOWN" }]) {
    assert.throws(() => foundation.requireF2Output(wire(1, [definition()], [use(1, patch)]), index, [1]), foundation.FoundationContractError);
  }
  const unused = foundation.requireF2Output(wire(1, [definition()], []), index, [1]);
  assert.deepEqual(unused.assets, [{ ...definition(), appearances: [] }]);
  assert.deepEqual(unused.episodes[0].assetKeys, []);
  for (const patch of [{ name: undefined }, { type: "INVALID" }, { description: " " }, { sourceRefs: [] }]) {
    assert.throws(() => foundation.requireF2Output(wire(1, [definition(1, patch)]), index, [1]), foundation.FoundationContractError);
  }
});

check("background-only new identities keep sourced purposes without fabricating appearances", () => {
  const raw = wire(1, [definition(0)], [{ key: "jia", presence: "BACKGROUND", purpose: "理解前史持伞关系，不声明本集出现。", sourceRefs: [ref(0, 2)], sourceName: "甲" }]);
  const result = foundation.requireF2Output(raw, index, [1]);
  assert.deepEqual(result.assets[0].appearances, []);
  assert.deepEqual(result.episodes[0].assetKeys, ["jia"]);
  assert.deepEqual(result.episodes[0].backgroundRefs, [{ key: "jia", purpose: "理解前史持伞关系，不声明本集出现。", sourceRefs: [ref(0, 2)], sourceName: "甲", sourceNameMatch: "LITERAL" }]);
  assert.deepEqual(result.dataIssues ?? [], []);
  assert.deepEqual(foundation.requireF2Output(result, index, [1]), result, "BACKGROUND-only新身份canonical仍须可复验");
});

check("background requires its own valid purpose and refs, not an invented state", () => {
  for (const patch of [{ purpose: " " }, { sourceRefs: [] }, { sourceRefs: [ref(0, 99)] }, { state: "擅自补出在场状态。" }]) {
    const background = { key: "jia", presence: "BACKGROUND", purpose: "前史依据", sourceRefs: [ref(0, 2)], ...patch };
    assert.throws(() => foundation.requireF2Output(wire(1, [definition(0)], [background]), index, [1]), foundation.FoundationContractError);
  }
});

check("ordinary state uses reject background purpose instead of silently ignoring it", () => {
  for (const presence of ["ONSTAGE", "MENTIONED", "PROFILE"]) {
    const raw = wire(1, [definition()], [use(1, { presence, purpose: "不能被静默吞掉的背景用途。" })]);
    assert.ok(foundation.validateF2Output(raw, index, [1]).some((issue) => issue.coordinate.endsWith(".purpose")), `${presence}混入purpose须明确拒绝`);
    assert.throws(() => foundation.requireF2AuthorOutput(raw, index, [1]), /purpose|二选一|混/);
  }
});

check("multiple events for one key stay intact while assetKeys retain first-use order without duplicates", () => {
  const raw = wire(1, [definition(), definition(1, { key: "yi", name: "乙", sourceRefs: [ref(1, 3)] })], [
    use(1, { key: "yi", state: "在旁说话。", sourceRefs: [ref(1, 3)], sourceName: "乙" }),
    use(1, { state: "走进雨中。" }),
    use(1, { state: "接过伞。", sourceRefs: [ref(1, 2)], sourceName: "他" })
  ]);
  const result = foundation.requireF2Output(raw, index, [1]);
  assert.deepEqual(result.episodes[0].assetKeys, ["yi", "jia"]);
  assert.deepEqual(result.assets.find((asset) => asset.key === "jia")!.appearances.map((appearance) => appearance.state), ["走进雨中。", "接过伞。"]);
  const merged = foundation.mergeF2Outputs([result], index, [1]);
  assert.equal(merged.assets.find((asset) => asset.key === "jia")!.appearances.length, 2);
});

check("multi-episode uses cannot produce either direction of key versus state registration drift", () => {
  const raw = wire(1, [definition(), definition(1, { key: "yi", name: "乙", sourceRefs: [ref(1, 3)] })], [], {
    coverage: [1, 2], episodes: [
      { number: 1, context: "甲与乙当集出现。", uses: [use(), use(1, { key: "yi", sourceName: "乙", sourceRefs: [ref(1, 3)] })] },
      { number: 2, context: "甲交伞，乙仅作背景交代。", uses: [use(2), { key: "yi", presence: "BACKGROUND", purpose: "解释上集在旁说话者", sourceRefs: [ref(1, 3)], sourceName: "乙" }] }
    ]
  });
  const normalized = foundation.requireF2AuthorOutput(raw, index, [1, 2]);
  const declared = normalized.episodes.flatMap((episode) => episode.assetKeys.map((key) => `${episode.number}:${key}`));
  const represented = normalized.assets.flatMap((asset) => asset.appearances.map((appearance) => `${appearance.episode}:${asset.key}`));
  represented.push(...normalized.episodes.flatMap((episode) => (episode.backgroundRefs ?? []).map((entry) => `${episode.number}:${entry.key}`)));
  assert.deepEqual(new Set(declared), new Set(represented));
  assert.deepEqual(normalized.dataIssues ?? [], []);
  assert.deepEqual(foundation.mergeF2Outputs([normalized], index, [1, 2]), normalized);
});

check("mixed uses and legacy tables reject conflicting state instead of silently dropping either table", () => {
  const raw = legacy();
  (raw.episodes[0] as Record<string, unknown>).uses = [use(1, { state: "另一条不能被静默吞掉的状态。" })];
  assert.throws(() => foundation.requireF2Output(raw, index, [1]), /uses|混|双重/);
});

check("mixed new-wire assets or episode legacy fields are clearly rejected even when redundant", () => {
  for (const raw of [
    wire(1, [{ ...definition(), appearances: [] }]),
    wire(1, [definition()], [use()], { episodes: [{ number: 1, context: "本集", uses: [use()], assetKeys: ["jia"] }] }),
    wire(1, [definition()], [use()], { episodes: [{ number: 1, context: "本集", uses: [use()], backgroundRefs: [] }] })
  ]) assert.throws(() => foundation.requireF2Output(raw, index, [1]), /uses|混|双重/);
});

check("sourceName only found in AI context or a future episode is retained but marked NON_LITERAL", () => {
  const canonical = legacy();
  (canonical.assets[0].appearances[0] as Record<string, unknown>).sourceName = "AI_ONLY_ALIAS";
  canonical.episodes[0].context = "AI_ONLY_ALIAS出现在AI写的解释里。";
  const parsed = foundation.requireF2Output(canonical, index, [1]);
  assert.equal(parsed.assets[0].appearances[0].sourceName, "AI_ONLY_ALIAS");
  assert.equal(parsed.assets[0].appearances[0].sourceNameMatch, "NON_LITERAL", "不能用AI context自证字面命中，仍保标签供独审");
  for (const sourceName of ["AI_ONLY_ALIAS", "仅背景称谓"]) {
    const output = foundation.requireF2Output(wire(1, [definition()], [use(1, { sourceName })]), index, [1]);
    assert.equal(output.assets[0].appearances[0].sourceName, sourceName);
    assert.equal(output.assets[0].appearances[0].sourceNameMatch, "NON_LITERAL");
  }
  assert.ok(!("sourceName" in foundation.requireF2Output(wire(1, [definition()], [use(1, { sourceName: "" })]), index, [1]).assets[0].appearances[0]));
  assert.throws(() => foundation.requireF2Output(wire(1, [definition()], [use(1, { sourceName: 5 })]), index, [1]), foundation.FoundationContractError);
});

check("sourceName uses actual current source and backgrounds only use their explicit referenced excerpts", () => {
  const current = foundation.requireF2Output(wire(1, [definition()], [use(1, { sourceRefs: [ref(1, 2)] })]), index, [1]);
  assert.equal(current.assets[0].appearances[0].sourceName, "甲", "普通状态称谓可见于本集全文，不靠AI补文");
  assert.equal(current.assets[0].appearances[0].sourceNameMatch, "LITERAL");
  const background = { key: "jia", presence: "BACKGROUND", purpose: "前史", sourceRefs: [ref(0, 3)], sourceName: "甲" };
  const backgroundOutput = foundation.requireF2Output(wire(1, [definition(0)], [background]), index, [1]);
  assert.equal(backgroundOutput.episodes[0].backgroundRefs?.[0].sourceName, "甲");
  assert.equal(backgroundOutput.episodes[0].backgroundRefs?.[0].sourceNameMatch, "NON_LITERAL", "背景标签只对明确摘录计算，不用其他原文或AI解释冒充命中");
  const withoutName = use(); delete (withoutName as Record<string, unknown>).sourceName;
  assert.ok(!("sourceName" in foundation.requireF2Output(wire(1, [definition()], [withoutName]), index, [1]).assets[0].appearances[0]));
});

check("sourceName survives canonical parsing and distinct source-name events are not collapsed", () => {
  const canonical = legacy();
  const namedAppearances = [
    { ...canonical.assets[0].appearances[0], sourceName: "甲" },
    { ...canonical.assets[0].appearances[0], sourceName: "他" }
  ];
  canonical.assets[0].appearances = namedAppearances;
  const parsed = foundation.requireF2Output(canonical, index, [1]);
  assert.deepEqual(parsed.assets[0].appearances.map((item) => item.sourceName), ["甲", "他"]);
  assert.equal(foundation.mergeF2Outputs([parsed], index, [1]).assets[0].appearances.length, 2);
});

check("new-wire description variants retain original sources and alias bridges without changing identity", () => {
  const first = foundation.requireF2Output(wire(0, [definition(0, { key: "shen", name: "蜃", type: "BEAST", aliases: ["蜃龙"], description: "旧来源身份描述。" })], [use(0, { key: "shen", presence: "PROFILE", sourceName: "蜃" })]), index, [0]);
  const second = foundation.requireF2Output(wire(2, [{ key: "shen", name: "蜃龙", description: "新来源描述。", sourceRefs: [ref(2, 2)] }], [use(2, { key: "shen", sourceRefs: [ref(2, 2)], sourceName: "蜃龙" })]), index, [2], first.assets);
  const merged = foundation.mergeF2Outputs([first, second], index, [0, 2]);
  assert.equal(merged.assets[0].name, "蜃");
  assert.deepEqual(merged.assets[0].descriptionVariants, [{ text: "旧来源身份描述。", sourceRefs: [ref(0)] }, { text: "新来源描述。", sourceRefs: [ref(2, 2)] }]);
  for (const patch of [{ name: "另一对象" }, { type: "PROP" }, { name: "临时名", aliases: ["蜃"] }]) {
    assert.throws(() => foundation.requireF2Output(wire(2, [{ key: "shen", ...patch }], [use(2, { key: "shen", sourceName: "蜃龙" })]), index, [2], first.assets), foundation.FoundationContractError);
  }
});

check("legacy known-ref data gaps are retained instead of deleting keys or filling old states", () => {
  const prior = foundation.requireF2Output(legacy(), index, [1]);
  const old = { coverage: [2], assets: [], episodes: [{ number: 2, context: "旧响应资料", assetKeys: ["jia"] }], issues: [], dataIssues: [] };
  const parsed = foundation.requireF2Output(old, index, [2], prior.assets);
  assert.deepEqual(parsed.episodes[0].assetKeys, ["jia"]); assert.deepEqual(parsed.assets[0].appearances, []);
  assert.equal(parsed.dataIssues?.length, 1);
});

check("deep-frozen new wire and prior stay unchanged during author parsing and canonical merging", () => {
  const prior = freeze(foundation.requireF2Output(legacy(), index, [1]));
  const raw = freeze(wire(2, [], [use(2)])); const before = JSON.stringify({ prior, raw });
  assert.equal(typeof foundation.requireF2AuthorOutput, "function");
  const next = freeze(foundation.requireF2AuthorOutput(raw, index, [2], prior.assets));
  foundation.mergeF2Outputs([prior, next], index, [1, 2]);
  assert.equal(JSON.stringify({ prior, raw }), before);
});

check("normal F2 prompt declares single uses source and no hand-authored canonical duplicate fields", () => {
  const question = foundation.FOUNDATION_TASK_CONTRACT.roles.F2.consumerQuestions[2];
  assert.match(question, /uses|身份使用条目/); assert.doesNotMatch(question, /assetKeys/);
  const schema = foundation.FOUNDATION_OUTPUT_SCHEMAS.F2;
  assert.ok("uses" in schema.episodes[0]); assert.ok(!("assetKeys" in schema.episodes[0]));
  assert.ok(!("appearances" in schema.assets[0])); assert.ok(!("backgroundRefs" in schema.episodes[0]));
  const prompt = foundation.buildFoundationPrompt("F2", { scope: [1] });
  for (const name of ["uses", "BACKGROUND", "sourceName", "sourceRefs"]) assert.ok(prompt.includes(name));
  assert.match(foundation.F2_PROTOCOL_RULES, /不.*手写|不得.*同时|禁止.*重复/);
  assert.ok(prompt.includes(foundation.F2_PROTOCOL_VERSION));
});

if (failures.length) { console.error(`F2 normal output verification failed (${failures.length} failed, ${checks} passed)`); process.exitCode = 1; }
else console.log(`F2 normal output verification passed (${checks} checks; deterministic only)`);
