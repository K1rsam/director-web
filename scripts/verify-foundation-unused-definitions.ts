import assert from "node:assert/strict";
import * as f from "@/lib/project-foundation-contracts";
import { buildQ1ScopedSupply } from "@/lib/foundation-review-input";
import { buildEpisodeFoundationPackets, type FoundationCandidate } from "@/lib/foundation-state";
import type { F1Output, F2Asset, F2Output, SourceRef } from "@/lib/project-foundation-contracts";

// Synthetic source only. Packet assembly is pure; no model, database or saved run is called.
const index = f.buildSourceIndex([
  { number: 0, title: "设定", content: "收容所是由大厅与走廊组成的机构。\r\n创办人甲。\r\n夜班队。\r\n守门兽。\r\n封印章。\r\n信使。\r\n旧站。" },
  { number: 1, title: "场内", content: "大厅灯光亮起。\r\n走廊的门打开。\r\n" },
  { number: 2, title: "接续", content: "收容所旧址在山边。\n信使抵达。\n旧站仅作为前因。" },
  { number: 3, title: "远处", content: "雨停了。" }
]);
const ref = (episode: number, startLine = 1, endLine = startLine): SourceRef => ({ episode, startLine, endLine });
const definition = (key: string, name: string, type: F2Asset["type"], sourceRefs: SourceRef[], patch: Record<string, unknown> = {}) => ({
  key, name, type, aliases: [], description: `${name}的原文身份定义。`, sourceRefs, ...patch
});
const shelter = definition("shelter", "收容所", "LOC", [ref(0), ref(2)], {
  aliases: ["收容机构"], description: "收容所是由大厅与走廊组成的机构。",
  descriptionVariants: [
    { text: "收容所是由大厅与走廊组成的机构。", sourceRefs: [ref(0)] },
    { text: "收容所旧址在山边。", sourceRefs: [ref(2)] }
  ]
});
const unused = [shelter,
  definition("founder", "创办人甲", "CH", [ref(0, 2)]),
  definition("night-team", "夜班队", "GROUP", [ref(0, 3)]),
  definition("guardian", "守门兽", "BEAST", [ref(0, 4)]),
  definition("seal", "封印章", "PROP", [ref(0, 5)])
];
const locations = [definition("lobby", "大厅", "LOC", [ref(1)]), definition("corridor", "走廊", "LOC", [ref(1, 2)])];
const uses = [
  { key: "lobby", presence: "ONSTAGE", state: "灯光亮起。", sourceRefs: [ref(1)], sourceName: "大厅" },
  { key: "corridor", presence: "ONSTAGE", state: "门打开。", sourceRefs: [ref(1, 2)], sourceName: " 走廊工作标签 " }
];
const wire = (assets: unknown = [...unused, ...locations], localUses: unknown = uses) => ({
  coverage: [0, 1], assets, episodes: [{ number: 0, context: "后台设定。", uses: [] }, { number: 1, context: "大厅与走廊状态。", uses: localUses }], issues: []
});
const canonicalFirst: F2Output = {
  coverage: [0, 1], assets: [
    ...unused.map((asset) => ({ ...asset, appearances: [] }) as F2Asset),
    ...locations.map((asset, position) => ({ ...asset, appearances: [{ episode: 1, ...uses[position], presence: "ONSTAGE", sourceNameMatch: position ? "NON_LITERAL" : "LITERAL" }] }) as F2Asset)
  ],
  episodes: [{ number: 0, context: "后台设定。", assetKeys: [] }, { number: 1, context: "大厅与走廊状态。", assetKeys: ["lobby", "corridor"] }], issues: []
};
// The canonical appearance has no use.key transport field.
canonicalFirst.assets.forEach((asset) => asset.appearances.forEach((appearance) => { delete (appearance as unknown as Record<string, unknown>).key; }));
const scope = [0, 1, 2, 3];
const authorChunks = [[0, 1], [2], [3]].map((scope) => ({ scope, overview: `原作者范围${scope.join("、")}。`,
  sourceChars: index.episodes.filter((episode) => scope.includes(episode.number)).reduce((sum, episode) => sum + episode.content.length, 0), oversized: false }));
const f1: FoundationCandidate<F1Output> = {
  schema: "FOUNDATION_CANDIDATE_V1", id: "synthetic-f1", createdAt: "2026-01-01T00:00:00.000Z", stageCode: "F1", sourceVersion: index.version,
  inputVersion: "synthetic-input", runId: "synthetic-f1-run", batchToken: "synthetic-batch", upstreamSnapshotIds: {}, scope, mechanicalIssues: [],
  output: { coverage: scope, overview: authorChunks.map((chunk) => chunk.overview).join("\n\n"),
    episodes: scope.map((number) => ({ number, summary: `本集${number}摘要。`, context: `本集${number}解释。`, sourceSelections: [] })), issues: [] }
};
const f2: FoundationCandidate<F2Output> = {
  ...f1, id: "synthetic-f2", runId: "synthetic-f2-run", stageCode: "F2", upstreamSnapshotIds: { f1: f1.id },
  output: { ...canonicalFirst, coverage: scope, assets: [...canonicalFirst.assets,
    { ...definition("messenger", "信使", "CH", [ref(0, 6)]), appearances: [{ episode: 2, presence: "ONSTAGE", state: "抵达。", sourceRefs: [ref(2, 2)] }] } as F2Asset,
    { ...definition("old-station", "旧站", "LOC", [ref(0, 7)]), appearances: [] } as F2Asset
  ], episodes: [...canonicalFirst.episodes,
    { number: 2, context: "来使及前因。", assetKeys: ["messenger", "old-station"], backgroundRefs: [{ key: "old-station", purpose: "前因地点。", sourceRefs: [ref(0, 7)] }] },
    { number: 3, context: "雨停。", assetKeys: [] }
  ] }
};
const packets = buildEpisodeFoundationPackets(index, f1.inputVersion, f1, f2);
function review(requestedScope = [0, 1], candidate = f2) {
  return buildQ1ScopedSupply({ index, scope: requestedScope, f1, f2: candidate, authorChunks, packets });
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const failures: string[] = [];
let checks = 0;
function check(name: string, run: () => void) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  try { run(); checks++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}

check("sourced unused definitions survive author and canonical validation without invented uses", () => {
  const raw = freeze(wire());
  assert.deepEqual(f.validateF2AuthorOutput(raw, index, [0, 1]), [], "完整未使用定义不应再被assets.shelter.uses挡住");
  const output = f.requireF2AuthorOutput(raw, index, [0, 1]);
  assert.deepEqual(output, canonicalFirst);
  assert.deepEqual(f.requireF2Output(raw, index, [0, 1]), output);
  assert.deepEqual(f.requireF2Output(output, index, [0, 1]), output);
  for (const asset of unused) assert.deepEqual(output.assets.find((item) => item.key === asset.key), { ...asset, appearances: [] });
  assert.deepEqual(output.episodes.map((episode) => episode.assetKeys), [[], ["lobby", "corridor"]]);
  assert.deepEqual(output.dataIssues ?? [], []);
});

check("unused definitions remain complete across empty later chunks and later real usage", () => {
  const first = freeze(f.requireF2AuthorOutput(wire(), index, [0, 1]));
  const next = f.requireF2AuthorOutput({ coverage: [2, 3], assets: null, issues: null, episodes: [
    { number: 2, context: "源文提到旧址。", uses: [{ key: "shelter", presence: "MENTIONED", state: "旧址在山边。", sourceRefs: [ref(2)], sourceName: null }] },
    { number: 3, context: "未使用任何身份。", uses: [] }
  ] }, index, [2, 3], first.assets);
  const merged = f.mergeF2Outputs([first, freeze(next)], index, scope);
  assert.deepEqual(merged.assets.map((asset) => asset.key), [...unused, ...locations].map((asset) => asset.key));
  assert.equal(merged.assets.find((asset) => asset.key === "shelter")!.appearances.length, 1);
  assert.equal(merged.assets.find((asset) => asset.key === "shelter")!.appearances[0].episode, 2);
  assert.deepEqual(merged.assets.find((asset) => asset.key === "seal")!.appearances, []);
  assert.deepEqual(merged.episodes[3].assetKeys, []);
});

check("unused allowance still rejects incomplete definitions and invalid source anchors", () => {
  for (const patch of [{ name: null }, { name: " " }, { type: null }, { type: "UNKNOWN" }, { description: null }, { description: " " },
    { sourceRefs: null }, { sourceRefs: [] }, { sourceRefs: [null] }, { sourceRefs: [ref(99)] }, { sourceRefs: [ref(0, 99)] },
    { descriptionVariants: [{ text: "无源变体。", sourceRefs: [] }] }]) {
    for (const parse of [f.requireF2AuthorOutput, f.requireF2Output]) assert.throws(() => parse(wire([{ ...shelter, ...patch }], []), index, [0, 1]), f.FoundationContractError);
  }
  assert.throws(() => f.requireF2AuthorOutput(wire([shelter, shelter], []), index, [0, 1]), /唯一|key/);
});

check("used identities still require state and known keys cannot change their identity", () => {
  for (const patch of [{ state: null }, { state: " " }, { sourceRefs: null }, { sourceRefs: [] }, { sourceRefs: [ref(0)] }, { key: "unknown" }]) {
    assert.throws(() => f.requireF2AuthorOutput(wire(locations, [{ ...uses[0], ...patch }]), index, [0, 1]), f.FoundationContractError);
  }
  const prior = f.requireF2AuthorOutput(wire(locations), index, [0, 1]);
  for (const patch of [{ type: "PROP" }, { name: "不是大厅" }]) {
    assert.throws(() => f.requireF2AuthorOutput(wire([{ ...locations[0], ...patch }], []), index, [0, 1], prior.assets), f.FoundationContractError);
  }
  const incompleteUse = structuredClone(canonicalFirst);
  incompleteUse.episodes[0].assetKeys = ["shelter"];
  assert.throws(() => f.requireF2Output(incompleteUse, index, [0, 1]), /使用|状态|uses/);
});

check("Q1 reviews globally unused definitions in their source scope with real cross-scope text", () => {
  const view = review();
  assert.deepEqual(view.candidates.f2.output.assets.map((asset) => asset.key), [...unused, ...locations].map((asset) => asset.key));
  assert.deepEqual(view.candidates.f2.output.assets.find((asset) => asset.key === "shelter"), { ...shelter, appearances: [] });
  const source = view.referenceSource.find((entry) => entry.episode === 2)!;
  assert.ok(source, "未使用定义的跨scope身份依据必须送审");
  assert.deepEqual({ episode: source.episode, startLine: source.startLine, endLine: source.endLine }, ref(2));
  assert.equal(source.content, "收容所旧址在山边。\n");
  assert.equal(source.sourceVersion, index.version);
  assert.ok(source.usedBy.some((entry) => entry.includes("assets[shelter].sourceRefs")));
  assert.ok(source.usedBy.some((entry) => entry.includes("descriptionVariants")));
  assert.deepEqual(view.dataIssues, []);
  assert.match(view.reviewScopeNote, /未使用.*后台|后台.*未使用/);
});

check("source-scoped unused review does not leak whole registry or identities used only elsewhere", () => {
  assert.deepEqual(review([3]).candidates.f2.output.assets, []);
  const local = review().candidates.f2.output.assets.map((asset) => asset.key);
  assert.ok(!local.includes("messenger"), "全剧其它集有appearance时不能按静态来源扩大进当前scope");
  assert.ok(!local.includes("old-station"), "全剧其它集assetKeys/BACKGROUND引用也不能算未使用");
  const second = review([2]).candidates.f2.output.assets.map((asset) => asset.key);
  assert.deepEqual(second, ["shelter", "messenger", "old-station"]);
  const noEpisodeKey = structuredClone(f2);
  noEpisodeKey.output.episodes[2].assetKeys = ["old-station"];
  assert.ok(!review([0, 1], noEpisodeKey).candidates.f2.output.assets.some((asset) => asset.key === "messenger"), "仅appearance也足以证明并非全剧未使用");
});

check("pure packet assembly never turns unused background definitions into consumer identities", () => {
  for (const packet of packets) {
    assert.ok(packet.identities.every((identity) => !unused.some((asset) => asset.key === identity.key)));
    assert.ok(packet.assetKeys.every((key) => !unused.some((asset) => asset.key === key)));
  }
  const view = review();
  assert.deepEqual(view.episodePackets, packets.slice(0, 2));
  assert.deepEqual(view.episodePackets[1].identities.map((identity) => identity.key), ["lobby", "corridor"]);
  assert.equal(view.episodePackets[1].identities[1].name, " 走廊工作标签 ");
  assert.equal(view.episodePackets[1].identities[1].nameBasis, "WORKING_LABEL");
});

check("deep-frozen raw source candidates and packets remain unchanged in parsing and scoped review", () => {
  const raw = freeze(wire());
  const values = freeze({ index, raw, f1, f2, authorChunks, packets });
  const before = JSON.stringify(values);
  const normalized = f.requireF2AuthorOutput(raw, index, [0, 1]);
  f.requireF2Output(freeze(normalized), index, [0, 1]);
  review(); review([2]); review([3]);
  assert.equal(JSON.stringify(values), before);
});

check("F2 V4 separately declares unused definitions and only the exact prior protocol is compatible", () => {
  assert.match(f.F2_PROTOCOL_VERSION, /^F2_BATCH_V4:[a-f0-9]{64}$/);
  assert.equal(f.F2_PROTOCOL_VERSION, `F2_BATCH_V4:${f.hashFoundationPrompt(JSON.stringify({ rules: f.F2_PROTOCOL_RULES, schema: f.FOUNDATION_OUTPUT_SCHEMAS.F2 }))}`);
  assert.deepEqual(f.F2_PARTIAL_REUSE_COMPATIBLE_PROTOCOLS, ["F2_BATCH_V3:d3a940ff21737ff3d7ffd4b9de094df7d90c7b08bbf7e1d470e2d4768513a51d"]);
  assert.match(f.F2_PROTOCOL_RULES, /未使用|无.*use/);
  assert.ok(!f.buildFoundationPrompt("F1", {}).includes(f.F2_PROTOCOL_VERSION));
  assert.ok(!f.buildFoundationPrompt("Q1", {}).includes(f.F2_PROTOCOL_VERSION));
});

if (failures.length) { console.error(`Unused definition verification failed (${failures.length} failed, ${checks} passed)`); process.exitCode = 1; }
else console.log(`Unused definition verification passed (${checks} checks; synthetic pure contracts and packets only)`);
