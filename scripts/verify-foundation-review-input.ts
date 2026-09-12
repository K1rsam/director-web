import assert from "node:assert/strict";
import * as contracts from "@/lib/project-foundation-contracts";
import { buildQ1ScopedSupply, requireBoundF1AuthorChunks } from "@/lib/foundation-review-input";
import type { PipelineRun } from "@prisma/client";
import type { EpisodeFoundationDraft, FoundationCandidate } from "@/lib/foundation-state";
import type { F1Output, F2Output, FoundationIssue, SourceRef } from "@/lib/project-foundation-contracts";

let checks = 0;
const failures: string[] = [];
function check(name: string, run: () => void) {
  if (process.argv[2] && !name.includes(process.argv[2])) return;
  try { run(); checks++; console.log(`PASS ${name}`); }
  catch (error) { failures.push(name); console.error(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`); }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
const index = contracts.buildSourceIndex([
  { number: 0, title: "合成资料", content: "甲原名。\r\n同一身份依据。\r\n" },
  { number: 1, title: "合成第一段", content: "甲站在门口。\r\n\r\n甲：开始。\r\n" },
  { number: 2, title: "合成第二段", content: "乙递给甲信物。\n别名是小甲。\n背景末行。" },
  { number: 3, title: "合成第三段", content: "甲离場。\n未来独有信息。\n" }
]);
const ref = (episode: number, startLine = 1, endLine = startLine): SourceRef => ({ episode, startLine, endLine });
const issue = (coordinate: string, sourceRefs: SourceRef[], severity: FoundationIssue["severity"] = "MAJOR"): FoundationIssue => ({ severity, owner: "F1", coordinate, problem: `合成问题：${coordinate}`, sourceRefs });
const episode = (number: number): F1Output["episodes"][number] => ({
  number, summary: `本段${number}摘要`, context: `本段${number}消费者解释`,
  sourceSelections: number === 1 ? [{ ...ref(2, 2), purpose: "核对来信使用的称谓" }] : []
});
const authorParts: F1Output[] = [
  { coverage: [0, 1], overview: "作者首段原字。\n\n内部空行必须保留。", episodes: [episode(0), Object.assign(episode(1), { f2Notes: "后台身份核对线索，不属于消费者包。" })], issues: [issue("f1-local", [ref(1)]), issue("f1-unanchored", [], "MINOR")] },
  { coverage: [2], overview: "作者中段。\n\n仍是同一原作者分片。", episodes: [episode(2)], issues: [] },
  { coverage: [3], overview: "作者末段原字。", episodes: [episode(3)], issues: [issue("f1-future", [ref(3)])] }
];
const f1Output: F1Output = {
  coverage: [0, 1, 2, 3], overview: authorParts.map((part) => part.overview).join("\n\n"),
  episodes: authorParts.flatMap((part) => part.episodes), issues: authorParts.flatMap((part) => part.issues)
};
const f1: FoundationCandidate<F1Output> = {
  schema: "FOUNDATION_CANDIDATE_V1", id: "f1-snapshot", createdAt: "2026-01-01T00:00:00.000Z", stageCode: "F1",
  sourceVersion: index.version, inputVersion: "common-input", runId: "f1-run", batchToken: "batch", upstreamSnapshotIds: {},
  scope: [0, 1, 2, 3], output: f1Output,
  mechanicalIssues: [issue("f1-mechanical-local", [ref(1), ref(2, 2)]), issue("f1-mechanical-unanchored", [], "MINOR")]
};
const state = (number: number, text = "本段在场。"): F2Output["assets"][number]["appearances"][number] => Object.assign({ episode: number, presence: "ONSTAGE" as const, state: text, sourceRefs: [ref(number)] }, { sourceName: "甲" });
const f2: FoundationCandidate<F2Output> = {
  ...f1, id: "f2-snapshot", stageCode: "F2", runId: "f2-run", upstreamSnapshotIds: { f1: f1.id },
  mechanicalIssues: [issue("f2-mechanical-future", [ref(3)]), issue("f2-mechanical-unanchored", [], "MINOR")],
  output: {
    coverage: [0, 1, 2, 3],
    assets: [
      { key: "person-a", name: "甲", type: "CH", aliases: ["小甲", "未来别名"], description: "身份原述。", sourceRefs: [ref(0, 1, 2), ref(2, 1, 2)], descriptionVariants: [{ text: "身份原述。", sourceRefs: [ref(0, 1, 2)] }, { text: "第二段身份记录。", sourceRefs: [ref(2, 1, 2)] }], appearances: [state(1), state(2)] },
      { key: "prop-letter", name: "信物", type: "PROP", aliases: [], description: "第二段出现的信物。", sourceRefs: [ref(2)], appearances: [state(2, "被递出。")] },
      { key: "loc-background", name: "背景地点", type: "LOC", aliases: [], description: "作为来信背景引用。", sourceRefs: [ref(2, 2, 3)], appearances: [state(3)] },
      { key: "unlisted-current", name: "本段候选", type: "BEAST", aliases: [], description: "本段有状态但未被assetKeys选中。", sourceRefs: [ref(1)], appearances: [state(1)] },
      { key: "future-only", name: "未来对象", type: "CH", aliases: [], description: "不属于第一批。", sourceRefs: [ref(3)], appearances: [state(3)] }
    ],
    episodes: [
      { number: 0, context: "合成资料", assetKeys: [] },
      { number: 1, context: "当批资料。", assetKeys: ["person-a", "prop-letter", "loc-background"], backgroundRefs: [{ key: "loc-background", purpose: "核对来信所述背景，非本段在场", sourceRefs: [ref(2, 2, 3)] }] },
      { number: 2, context: "第二段资料。", assetKeys: ["person-a", "prop-letter"] },
      { number: 3, context: "第三段资料。", assetKeys: ["future-only", "loc-background"] }
    ],
    issues: [issue("f2-local-cross-ref", [ref(1), ref(2)]), issue("f2-future", [ref(3)]), issue("f2-unanchored", [], "MINOR")],
    dataIssues: []
  }
};
const run: Pick<PipelineRun, "id" | "projectId" | "stageCode" | "status" | "log" | "inputSummary"> = {
  id: f1.runId, projectId: "project", stageCode: "F1", status: "SUCCEEDED",
  inputSummary: JSON.stringify({ batchToken: f1.batchToken, sourceVersion: index.version, inputVersion: f1.inputVersion }),
  log: JSON.stringify({ schema: "FOUNDATION_RUN_EVIDENCE_V1", runId: f1.runId, stageCode: "F1", batchToken: f1.batchToken, sourceVersion: index.version, inputVersion: f1.inputVersion,
    calls: authorParts.map((part, position) => ({ sequence: position + 1, scope: part.coverage, status: "SUCCEEDED", sourceVersion: index.version, inputVersion: f1.inputVersion,
      sourceChars: index.episodes.filter((entry) => part.coverage.includes(entry.number)).reduce((sum, entry) => sum + entry.content.length, 0), oversized: false, response: { data: part } })) })
};
const packets: EpisodeFoundationDraft[] = f1.output.episodes.map((entry) => {
  const identity = f2.output.episodes.find((part) => part.number === entry.number)!;
  return {
    schema: "EPISODE_FOUNDATION_V1", episode: entry.number, title: index.episodes.find((source) => source.number === entry.number)!.title,
    sourceVersion: index.version, inputVersion: f1.inputVersion, f1SnapshotId: f1.id, f2SnapshotId: f2.id,
    source: contracts.extractEpisodeSource(index, entry.number), sourceSelections: contracts.assembleSelections(index, entry.sourceSelections),
    f1Context: entry.context, f2Context: identity.context, assetKeys: identity.assetKeys,
    identities: identity.assetKeys.map((key) => {
      const asset = f2.output.assets.find((part) => part.key === key)!;
      return { key, name: asset.name, type: asset.type, aliases: [], appearances: asset.appearances.filter((appearance) => appearance.episode === entry.number) };
    }), ...(identity.backgroundRefs ? { backgroundRefs: identity.backgroundRefs } : {})
  };
});
const bind = (overrides: Partial<Parameters<typeof requireBoundF1AuthorChunks>[0]> = {}) => requireBoundF1AuthorChunks({ projectId: "project", index, candidate: f1, run, ...overrides });
const supply = (overrides: Partial<Parameters<typeof buildQ1ScopedSupply>[0]> = {}) => buildQ1ScopedSupply({ index, scope: [0, 1], f1, f2, authorChunks: bind(), packets, ...overrides });

check("binding returns complete original author chunks without splitting internal blank lines", () => {
  const chunks = bind();
  assert.deepEqual(chunks.map((chunk) => chunk.scope), [[0, 1], [2], [3]]);
  assert.deepEqual(chunks.map((chunk) => chunk.overview), authorParts.map((part) => part.overview));
  assert.equal(chunks.map((chunk) => chunk.overview).join("\n\n"), f1.output.overview);
  assert.equal(chunks[0].sourceChars, index.episodes.slice(0, 2).reduce((sum, source) => sum + source.content.length, 0));
  assert.equal(chunks[0].oversized, false);
});

check("the original oversized author episode remains whole with its exact character count", () => {
  const largeIndex = contracts.buildSourceIndex([{ number: 9, title: null, content: "甲".repeat(24_001) }]);
  const output: F1Output = { coverage: [9], overview: "原作者大段。\n\n内部空行。", episodes: [episode(9)], issues: [] };
  const candidate: FoundationCandidate<F1Output> = { ...f1, sourceVersion: largeIndex.version, scope: [9], output };
  const log = JSON.parse(run.log!); log.sourceVersion = largeIndex.version;
  log.calls = [{ ...log.calls[0], scope: [9], sourceVersion: largeIndex.version, sourceChars: 24_001, oversized: true, response: { data: output } }];
  const summary = JSON.parse(run.inputSummary!); summary.sourceVersion = largeIndex.version;
  const chunks = requireBoundF1AuthorChunks({ projectId: "project", index: largeIndex, candidate, run: { ...run, log: JSON.stringify(log), inputSummary: JSON.stringify(summary) } });
  assert.deepEqual(chunks, [{ scope: [9], overview: output.overview, sourceChars: 24_001, oversized: true }]);
});

check("binding rejects a wrong project, run, stage, status, version or candidate output", () => {
  for (const patch of [{ projectId: "other" }, { id: "other" }, { stageCode: "F2" }, { status: "FAILED" as const }, { log: "not-json" }]) {
    assert.throws(() => bind({ run: { ...run, ...patch } }), /F1|绑定|原作者/);
  }
  for (const patch of [{ runId: "other" }, { sourceVersion: "stale" }, { inputVersion: "stale" }, { output: { ...f1.output, overview: "改写作者原文" } }]) {
    assert.throws(() => bind({ candidate: { ...f1, ...patch } }), /F1|绑定|原作者/);
  }
  const summary = JSON.parse(run.inputSummary!); summary.inputVersion = "stale";
  assert.throws(() => bind({ run: { ...run, inputSummary: JSON.stringify(summary) } }), /F1|绑定|版本/);
});

check("binding rejects incomplete, repeated, failed or changed call evidence", () => {
  for (const mutate of [
    (log: Record<string, any>) => { log.calls.pop(); },
    (log: Record<string, any>) => { log.calls[1] = log.calls[0]; },
    (log: Record<string, any>) => { log.calls[0].status = "FAILED"; },
    (log: Record<string, any>) => { log.calls[0].sourceVersion = "stale"; },
    (log: Record<string, any>) => { log.calls[0].inputVersion = "stale"; },
    (log: Record<string, any>) => { log.calls[0].response.data.episodes[0].summary = "未保存到候选的不同摘要"; },
    (log: Record<string, any>) => { delete log.calls[0].response.data; },
    (log: Record<string, any>) => { log.calls[0].sourceChars++; },
    (log: Record<string, any>) => { log.calls[0].oversized = "false"; }
  ]) {
    const log = JSON.parse(run.log!); mutate(log);
    assert.throws(() => bind({ run: { ...run, log: JSON.stringify(log) } }), /F1|绑定|分片|coverage|范围/);
  }
});

check("scoped candidate views contain only current coverage, episodes and appearances", () => {
  const view = supply();
  assert.equal(view.candidates.f1.projection, "SCOPE_PROJECTION"); assert.equal(view.candidates.f1.snapshotId, f1.id);
  assert.equal(view.candidates.f2.projection, "SCOPE_PROJECTION"); assert.equal(view.candidates.f2.snapshotId, f2.id);
  assert.deepEqual(view.candidates.f1.output.coverage, [0, 1]); assert.deepEqual(view.candidates.f2.output.coverage, [0, 1]);
  assert.deepEqual(view.candidates.f1.output.episodes.map((part) => part.number), [0, 1]);
  assert.deepEqual(view.candidates.f2.output.episodes.map((part) => part.number), [0, 1]);
  assert.equal(view.candidates.f1.output.overview, authorParts[0].overview);
  assert.deepEqual(view.candidates.f2.output.assets.map((asset) => asset.key), ["person-a", "prop-letter", "loc-background", "unlisted-current"]);
  assert.ok(view.candidates.f2.output.assets.every((asset) => asset.appearances.every((appearance) => [0, 1].includes(appearance.episode))));
  assert.equal((view.candidates.f2.output.assets[0].appearances[0] as { sourceName?: string }).sourceName, "甲");
  assert.deepEqual(view.episodePackets.map((packet) => packet.episode), [0, 1]);
  assert.deepEqual(view.episodePackets, packets.slice(0, 2), "真实消费者包只能筛选，不得被后台审查资料扩写");
  assert.equal((view.candidates.f1.output.episodes[1] as { f2Notes?: string }).f2Notes, "后台身份核对线索，不属于消费者包。");
  assert.ok(!("f2Notes" in view.episodePackets[1]));
  assert.deepEqual(view.candidates.f2.output.assets[0].descriptionVariants, f2.output.assets[0].descriptionVariants);
});

check("partial author overview overlap is refused rather than truncated or omitted", () => {
  assert.throws(() => supply({ scope: [1] }), /overview|概述|作者|分片|部分/);
  const combined = supply({ scope: [0, 1, 2] });
  assert.equal(combined.candidates.f1.output.overview, authorParts.slice(0, 2).map((part) => part.overview).join("\n\n"));
  const altered = bind(); altered[0].overview = "擅改作者概述";
  assert.throws(() => supply({ authorChunks: altered }), /overview|概述|作者|绑定/);
  assert.throws(() => supply({ authorChunks: bind().slice(0, 2) }), /overview|概述|作者|覆盖/);
});

check("cross-scope evidence is exact source with combined ranges and preserved uses, not full coverage", () => {
  const view = supply();
  assert.equal(view.referenceSource.length, 1);
  const evidence = view.referenceSource[0];
  assert.deepEqual({ episode: evidence.episode, startLine: evidence.startLine, endLine: evidence.endLine }, ref(2, 1, 3));
  assert.equal(evidence.sourceVersion, index.version);
  assert.equal(evidence.content, index.episodes[2].content);
  assert.ok(evidence.usedBy.some((use) => use.includes("descriptionVariants")));
  assert.ok(evidence.usedBy.some((use) => use.includes("sourceSelections")));
  assert.ok(evidence.usedBy.some((use) => use.includes("backgroundRefs")));
  assert.ok(evidence.usedBy.some((use) => use.includes("authorIssues")));
  assert.equal(new Set(evidence.usedBy).size, evidence.usedBy.length);
  assert.deepEqual(view.candidates.f1.output.coverage, [0, 1]);
  assert.match(view.reviewScopeNote, /摘录/); assert.match(view.reviewScopeNote, /不.*完整|不.*覆盖/);
  assert.ok(view.episodePackets.every((packet) => !("referenceSource" in packet)));
});

check("reference excerpts preserve CRLF and do not rewrite original source characters", () => {
  const view = supply({ scope: [2] });
  const evidence = view.referenceSource.find((entry) => entry.episode === 0)!;
  assert.equal(evidence.content, index.episodes[0].content);
  assert.ok(evidence.content.includes("\r\n"));
  assert.deepEqual(view.candidates.f1.output.coverage, [2]);
  assert.equal(supply({ scope: [3] }).episodePackets[0].source.content, "甲离場。\n未来独有信息。\n");
});

check("scoped issues are recomputed and unanchored originals remain visible without severity inflation", () => {
  const view = supply();
  assert.deepEqual(view.authorIssues.map((entry) => entry.coordinate), ["f1-local", "f2-local-cross-ref"]);
  assert.deepEqual(view.mechanicalIssues.map((entry) => entry.coordinate), ["f1-mechanical-local"]);
  assert.equal(view.dataIssues.length, 1); assert.match(view.dataIssues[0].coordinate, /episodes\.1.*prop-letter/);
  assert.deepEqual(view.candidates.f2.output.dataIssues, view.dataIssues);
  assert.deepEqual(view.candidates.f2.output.assets.find((asset) => asset.key === "prop-letter")!.appearances, []);
  assert.deepEqual(view.unscopedIssues.map((entry) => entry.coordinate).sort(), ["f1-unanchored", "f2-unanchored", "f1-mechanical-unanchored", "f2-mechanical-unanchored"].sort());
  assert.ok(view.unscopedIssues.every((entry) => entry.severity === "MINOR" && entry.scopeReason === "NO_SOURCE_REFS" && entry.origin));
  for (const entry of view.unscopedIssues) {
    const { origin, scopeReason, ...original } = entry;
    assert.ok(origin); assert.equal(scopeReason, "NO_SOURCE_REFS");
    assert.deepEqual(original, [...f1.output.issues, ...f2.output.issues, ...f1.mechanicalIssues, ...f2.mechanicalIssues].find((candidate) => candidate.coordinate === entry.coordinate));
  }
});

check("bad source references, cross-version candidates and missing or mismatched packets are rejected", () => {
  const bad = structuredClone(f2); bad.output.assets[0].descriptionVariants![1].sourceRefs = [ref(2, 99)];
  assert.throws(() => supply({ f2: bad }), /来源|引用|越界|source|范围/);
  assert.throws(() => supply({ f2: { ...f2, inputVersion: "stale" } }), /版本|输入/);
  assert.throws(() => supply({ f2: { ...f2, upstreamSnapshotIds: { f1: "different" } } }), /F1|绑定|上游/);
  assert.throws(() => supply({ packets: packets.slice(1) }), /包|供给|覆盖|缺/);
  const wrongPackets = structuredClone(packets); wrongPackets[1].f2SnapshotId = "wrong";
  assert.throws(() => supply({ packets: wrongPackets }), /包|版本|绑定|F2/);
});

check("frozen source, author evidence, candidates and packets are not changed", () => {
  const values = freeze(structuredClone({ index, candidate: f1, run, f2, packets }));
  const before = JSON.stringify(values);
  const authorChunks = requireBoundF1AuthorChunks({ projectId: "project", index: values.index, candidate: values.candidate, run: values.run });
  buildQ1ScopedSupply({ index: values.index, scope: [0, 1], f1: values.candidate, f2: values.f2, authorChunks: freeze(authorChunks), packets: values.packets });
  assert.equal(JSON.stringify(values), before);
});

// Match flags and name bases are already computed upstream. This suite only checks Q1 transport and guidance.
function labelReviewFixture(): Parameters<typeof buildQ1ScopedSupply>[0] {
  const sourceIndex = contracts.buildSourceIndex([
    { number: 0, title: "合成前史", content: "旧声源记录。\r\n沙哑（VO）：来吧。\r\n" },
    { number: 1, title: "合成当前段", content: "一道黑色的影子掠过墙面。\n旁白提到“未来名”，尚未确认是谁。\n地上有一封来信。\n" },
    { number: 2, title: "合成后段", content: "未来名在后段才被确认。\n" }
  ]);
  const authorChunks = sourceIndex.episodes.map((source) => ({ scope: [source.number], overview: `原作者第${source.number}段概述。`, sourceChars: source.content.length, oversized: false }));
  const first: FoundationCandidate<F1Output> = { ...f1, sourceVersion: sourceIndex.version, scope: [0, 1, 2], mechanicalIssues: [],
    output: { coverage: [0, 1, 2], overview: authorChunks.map((chunk) => chunk.overview).join("\n\n"), episodes: [0, 1, 2].map((number) => ({ number, summary: "当段摘要。", context: "当段解释。", sourceSelections: [] })), issues: [] } };
  const shadow = Object.assign(state(1, "影子掠过墙面。"), { sourceName: "黑色影子", sourceNameMatch: "NON_LITERAL" as const });
  const named = Object.assign(state(1, "以未来名身份行动。"), { sourceRefs: [ref(1, 2)], sourceName: "未来名", sourceNameMatch: "LITERAL" as const });
  const letter = { episode: 1, presence: "ONSTAGE" as const, state: "来信在地上。", sourceRefs: [ref(1, 3)] };
  const background = Object.assign({ key: "voice", purpose: "解释前段声音，不声明本段有实体道具。", sourceRefs: [ref(0, 2)], sourceName: "沙哑VO" }, { sourceNameMatch: "NON_LITERAL" as const });
  const semanticIssue: FoundationIssue = { severity: "MAJOR", owner: "F2", coordinate: "literal-key-binding", problem: "本段虽有未来名字样，仍未确认它对应此key或本段身份。", sourceRefs: [ref(1, 2), ref(2)] };
  const second: FoundationCandidate<F2Output> = { ...f2, sourceVersion: sourceIndex.version, scope: [0, 1, 2], mechanicalIssues: [],
    output: { coverage: [0, 1, 2], assets: [
      { key: "shadow", name: "后台影子身份", type: "BEAST", aliases: [], description: "影子记录。", sourceRefs: [ref(1)], appearances: [shadow] },
      { key: "voice", name: "未知声源", type: "PROP", aliases: [], description: "只有声音的候选，类型仍待专业审核。", sourceRefs: [ref(0, 2)], appearances: [] },
      { key: "unconfirmed-person", name: "后续人物", type: "CH", aliases: [], description: "后段身份记录。", sourceRefs: [ref(2)], appearances: [named] },
      { key: "letter", name: "来信", type: "PROP", aliases: [], description: "来信记录。", sourceRefs: [ref(1, 3)], appearances: [letter] }
    ], episodes: [
      { number: 0, context: "前史。", assetKeys: [] },
      { number: 1, context: "标签与字面匹配均不等于身份已被确认。", assetKeys: ["shadow", "voice", "unconfirmed-person", "letter"], backgroundRefs: [background] },
      { number: 2, context: "后段。", assetKeys: [] }
    ], issues: [semanticIssue], dataIssues: [] } };
  const packet: EpisodeFoundationDraft = {
    schema: "EPISODE_FOUNDATION_V1", episode: 1, title: sourceIndex.episodes[1].title,
    sourceVersion: sourceIndex.version, inputVersion: first.inputVersion, f1SnapshotId: first.id, f2SnapshotId: second.id,
    source: contracts.extractEpisodeSource(sourceIndex, 1), sourceSelections: [], f1Context: "当段解释。", f2Context: "原作者状态不应被helper改写。",
    assetKeys: [...second.output.episodes[1].assetKeys], backgroundRefs: [background], identities: [
      Object.assign({ key: "shadow", name: "黑色影子", type: "BEAST" as const, aliases: [], appearances: [shadow] }, { nameBasis: "WORKING_LABEL" as const }),
      Object.assign({ key: "voice", name: "沙哑VO", type: "PROP" as const, aliases: [], appearances: [] }, { nameBasis: "WORKING_LABEL" as const }),
      Object.assign({ key: "unconfirmed-person", name: "未来名", type: "CH" as const, aliases: [], appearances: [named] }, { nameBasis: "SOURCE_WORDING" as const }),
      Object.assign({ key: "letter", name: "来信", type: "PROP" as const, aliases: [], appearances: [letter] }, { nameBasis: "REGISTERED_IDENTITY" as const })
    ]
  };
  return { index: sourceIndex, scope: [1], f1: first, f2: second, authorChunks, packets: [packet] };
}

check("Q1 guidance distinguishes literal matching, label basis and semantic correctness without automatic verdicts", () => {
  const note = buildQ1ScopedSupply(labelReviewFixture()).reviewScopeNote;
  for (const field of ["sourceNameMatch", "LITERAL", "NON_LITERAL", "SOURCE_WORDING", "WORKING_LABEL", "REGISTERED_IDENTITY"]) assert.ok(note.includes(field), field);
  assert.match(note, /\bLITERAL\b[^。]*不[^。]*身份/);
  assert.match(note, /NON_LITERAL[^。]*不[^。]*REPAIR/);
  for (const phrase of ["工作标签", "知情", "未来名", "错绑定", "state", "职务", "声源", "实体道具"]) assert.ok(note.includes(phrase), phrase);
  assert.match(note, /issues[^。]*未申报[^。]*不等于[^。]*自检/);
});

check("Q1 views preserve sourceNameMatch, all nameBasis values and exact ordinary and background evidence", () => {
  const args = labelReviewFixture(); const view = buildQ1ScopedSupply(args);
  assert.deepEqual(view.episodePackets, args.packets, "不得通过更名或删除作者标签隐藏待审问题");
  const shadow = view.candidates.f2.output.assets.find((asset) => asset.key === "shadow")!.appearances[0];
  assert.equal(shadow.sourceName, "黑色影子"); assert.equal(Reflect.get(shadow, "sourceNameMatch"), "NON_LITERAL");
  assert.deepEqual(shadow.sourceRefs, [ref(1)]);
  assert.equal(view.episodePackets[0].source.content, args.index.episodes[1].content);
  assert.ok(view.episodePackets[0].source.content.includes("黑色的影子"));
  const voice = view.candidates.f2.output.episodes[0].backgroundRefs![0];
  assert.equal(voice.sourceName, "沙哑VO"); assert.equal(Reflect.get(voice, "sourceNameMatch"), "NON_LITERAL");
  assert.deepEqual(voice.sourceRefs, [ref(0, 2)]);
  assert.deepEqual(view.episodePackets[0].backgroundRefs, args.packets[0].backgroundRefs);
  assert.deepEqual(view.episodePackets[0].identities.map((identity) => Reflect.get(identity, "nameBasis")), ["WORKING_LABEL", "WORKING_LABEL", "SOURCE_WORDING", "REGISTERED_IDENTITY"]);
  const excerpt = view.referenceSource.find((entry) => entry.episode === 0)!;
  assert.deepEqual({ episode: excerpt.episode, startLine: excerpt.startLine, endLine: excerpt.endLine }, ref(0, 2));
  assert.equal(excerpt.content, "沙哑（VO）：来吧。\r\n"); assert.equal(excerpt.sourceVersion, args.index.version);
  assert.ok(excerpt.usedBy.some((use) => use.includes("backgroundRefs")));
  assert.deepEqual(view.candidates.f2.output.coverage, [1]);
  const literal = view.candidates.f2.output.assets.find((asset) => asset.key === "unconfirmed-person")!;
  assert.equal(Reflect.get(literal.appearances[0], "sourceNameMatch"), "LITERAL");
  assert.equal(literal.key, "unconfirmed-person"); assert.equal(literal.appearances[0].state, "以未来名身份行动。");
  assert.ok(view.referenceSource.some((entry) => entry.episode === 2 && entry.content === args.index.episodes[2].content));
});

check("name diagnostics do not become mechanical or data issues, clear semantic findings, or change shared rules", () => {
  const args = freeze(labelReviewFixture()); const before = JSON.stringify(args);
  const shared = JSON.stringify(contracts.FOUNDATION_TASK_CONTRACT);
  const schemas = JSON.stringify({ f1: contracts.FOUNDATION_OUTPUT_SCHEMAS.F1, q1: contracts.FOUNDATION_OUTPUT_SCHEMAS.Q1 });
  const view = buildQ1ScopedSupply(args);
  assert.deepEqual(view.mechanicalIssues, []); assert.deepEqual(view.dataIssues, []);
  assert.deepEqual(view.authorIssues, args.f2.output.issues);
  assert.equal(view.authorIssues[0].severity, "MAJOR", "LITERAL不能把真实错绑定问题自动清掉或降级");
  assert.equal(view.candidates.f2.output.assets.find((asset) => asset.key === "voice")!.type, "PROP", "helper不代Q1更改待审的声源物理类型");
  assert.ok(!("verdict" in view));
  assert.equal(JSON.stringify(args), before);
  assert.equal(JSON.stringify(contracts.FOUNDATION_TASK_CONTRACT), shared);
  assert.equal(JSON.stringify({ f1: contracts.FOUNDATION_OUTPUT_SCHEMAS.F1, q1: contracts.FOUNDATION_OUTPUT_SCHEMAS.Q1 }), schemas);
});

if (failures.length) { console.error(`foundation review input verification failed (${failures.length} failed, ${checks} passed)`); process.exitCode = 1; }
else console.log(`foundation review input verification passed (${checks} checks; synthetic source only; no database or provider)`);
