import assert from "node:assert/strict";
import * as foundation from "@/lib/project-foundation-contracts";
import type { SourceIndex } from "@/lib/project-foundation-contracts";

// Synthetic shape only: 27 has exactly 71 lines; no saved user response is loaded or rewritten.
const referenceIndex = foundation.buildSourceIndex([
  { number: 27, title: "前集", content: Array.from({ length: 71 }, (_, i) => `前集原行${i + 1}`).join("\n") },
  ...Array.from({ length: 26 }, (_, i) => ({ number: i + 28, title: null, content: `第${i + 28}集本集原文。\n` }))
]);
const scope = Array.from({ length: 26 }, (_, i) => i + 28);
const range = { episode: 27, startLine: 59, endLine: 71, purpose: "解释直接前因" };
const draft = (sourceSelections: unknown = []) => ({ coverage: [28], overview: "本范围理解。", episodes: [{ number: 28, summary: "本集摘要。", context: "本集资料。", sourceSelections }], issues: [] });
const noSelectionDraft = () => ({ coverage: [28], overview: "本范围理解。", episodes: [{ number: 28, summary: "本集摘要。", context: "本集资料。" }], issues: [] });
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
function numbered(index: SourceIndex, selected: readonly number[]) {
  assert.equal(typeof foundation.buildNumberedSource, "function", "须导出纯编号原文装配接口");
  return foundation.buildNumberedSource(index, selected);
}

check("twenty-five omitted optional selection fields normalize without changing the declared range", () => {
  const raw = { coverage: scope, overview: "本批理解。", episodes: scope.map((number) => ({ number, summary: "当集摘要。", context: "当集资料。", ...(number === 28 ? { sourceSelections: [range] } : {}) })), issues: [] };
  const before = JSON.stringify(raw);
  assert.deepEqual(foundation.validateF1Output(raw, referenceIndex, scope), []);
  const result = foundation.requireF1Output(raw, referenceIndex, scope);
  assert.deepEqual(result.episodes[0].sourceSelections, [range]);
  assert.equal(result.episodes.slice(1).filter((episode) => episode.sourceSelections.length === 0).length, 25);
  assert.equal(JSON.stringify(raw), before);
});

check("missing, undefined, null and empty optional selection values become canonical empty arrays", () => {
  const explicitlyUndefined = draft(); explicitlyUndefined.episodes[0].sourceSelections = undefined;
  for (const raw of [noSelectionDraft(), explicitlyUndefined, draft(null), draft([])]) {
    const parsed = foundation.requireF1Output(raw, referenceIndex, [28]);
    assert.deepEqual(parsed.episodes[0].sourceSelections, []);
    assert.equal(parsed.episodes[0].summary, "本集摘要。"); assert.equal(parsed.episodes[0].context, "本集资料。");
  }
});

check("bad optional-selection types remain rejected instead of silently becoming empty", () => {
  for (const sourceSelections of ["[]", "", {}, 0, 1, true, false]) assert.throws(() => foundation.requireF1Output(draft(sourceSelections), referenceIndex, [28]), foundation.FoundationContractError);
});

check("core arrays stay required while auxiliary issue lists can be unreported", () => {
  for (const field of ["coverage", "episodes"]) for (const value of [undefined, null, "[]", {}]) {
    assert.throws(() => foundation.requireF1Output({ ...draft(), [field]: value }, referenceIndex, [28]), foundation.FoundationContractError);
  }
  for (const issues of [undefined, null]) assert.deepEqual(foundation.requireQ1Output({ coverage: [28], verdict: "READY", summary: "资料核对", issues }, referenceIndex, [28]).issues, []);
  const f2 = { coverage: [28], assets: [], episodes: [{ number: 28, context: "本集", uses: [] }], issues: [] };
  for (const field of ["coverage", "episodes"]) for (const value of [undefined, null]) {
    assert.throws(() => foundation.requireF2AuthorOutput({ ...f2, [field]: value }, referenceIndex, [28]), foundation.FoundationContractError);
  }
  for (const uses of [undefined, null]) assert.throws(() => foundation.requireF2AuthorOutput({ ...f2, episodes: [{ ...f2.episodes[0], uses }] }, referenceIndex, [28]), foundation.FoundationContractError);
});

check("explicit wholeEpisode true becomes exact canonical current-index lines without keeping another request shape", () => {
  const raw = freeze(draft([{ episode: 27, wholeEpisode: true, purpose: "需完整前集理解直接前因" }]));
  const before = JSON.stringify(raw);
  const selected = foundation.requireF1Output(raw, referenceIndex, [28]).episodes[0].sourceSelections;
  assert.deepEqual(selected, [{ episode: 27, startLine: 1, endLine: 71, purpose: "需完整前集理解直接前因" }]);
  assert.ok(!("wholeEpisode" in selected[0]));
  assert.equal(foundation.assembleSelections(referenceIndex, selected)[0].content, referenceIndex.episodes[0].content);
  assert.equal(JSON.stringify(raw), before);
});

check("the observed 59 to 79 out-of-bounds shape is rejected, never clamped to line 71", () => {
  const raw = freeze(draft([{ ...range, endLine: 79 }])); const before = JSON.stringify(raw);
  assert.throws(() => foundation.requireF1Output(raw, referenceIndex, [28]), /越界|范围/);
  assert.ok(foundation.validateF1Output(raw, referenceIndex, [28]).some((issue) => /越界/.test(issue.problem)));
  assert.equal(JSON.stringify(raw), before);
  assert.equal((raw.episodes[0].sourceSelections as Array<{ endLine: number }>)[0].endLine, 79);
});

check("wholeEpisode cannot hide mixed range fields or false and nonboolean markers", () => {
  for (const extra of [{ startLine: 59, endLine: 79 }, { startLine: 1 }, { endLine: 71 }, { startLine: undefined }]) {
    assert.throws(() => foundation.requireF1Output(draft([{ episode: 27, wholeEpisode: true, purpose: "整集用途", ...extra }]), referenceIndex, [28]), /混|wholeEpisode|同时/);
  }
  for (const wholeEpisode of [false, "true", 1, null]) {
    assert.throws(() => foundation.requireF1Output(draft([{ ...range, wholeEpisode }]), referenceIndex, [28]), /wholeEpisode|true|整集/);
  }
});

check("wholeEpisode still rejects unknown episodes, missing purpose and overlapping selections", () => {
  for (const request of [{ episode: 999, wholeEpisode: true, purpose: "用途" }, { episode: 27, wholeEpisode: true }, { episode: 27, wholeEpisode: true, purpose: " " }]) {
    assert.throws(() => foundation.requireF1Output(draft([request]), referenceIndex, [28]), foundation.FoundationContractError);
  }
  assert.throws(() => foundation.requireF1Output(draft([{ episode: 27, wholeEpisode: true, purpose: "整集前因" }, range]), referenceIndex, [28]), /重叠|重复/);
});

const lineIndex = foundation.buildSourceIndex([
  { number: 0, title: "空正文", content: "" },
  { number: 1, title: "CRLF", content: "A\r\n\r\nB\r\n" },
  { number: 2, title: "LF", content: "A\nB\n" },
  { number: 3, title: "CR", content: "A\rB\r" },
  { number: 4, title: "Unicode", content: "  全角　汉字🙂e\u0301\t\r\n尾 \n" },
  { number: 5, title: null, content: "无尾换行文本" },
  { number: 6, title: "空行", content: "\n\n" },
  { number: 7, title: "空白", content: " \t " }
]);

check("numbered tuples preserve every original character and newline without a second content copy", () => {
  const result = numbered(lineIndex, lineIndex.episodes.map((episode) => episode.number));
  assert.equal(result.schema, "NUMBERED_SOURCE_V1"); assert.equal(result.version, lineIndex.version);
  for (const episode of result.episodes) {
    const raw = lineIndex.episodes.find((item) => item.number === episode.number)!;
    assert.equal(episode.title, raw.title); assert.equal(episode.lineCount, raw.lineCount);
    assert.equal(episode.lines.length, raw.lineCount);
    assert.deepEqual(episode.lines.map(([number]) => number), Array.from({ length: raw.lineCount }, (_, index) => index + 1));
    assert.equal(episode.lines.map(([, text]) => text).join(""), raw.content);
    assert.deepEqual(Object.keys(episode).sort(), ["lineCount", "lines", "number", "title"]);
  }
  assert.deepEqual(result.episodes.find((episode) => episode.number === 1)!.lines, [[1, "A\r\n"], [2, "\r\n"], [3, "B\r\n"], [4, ""]]);
  assert.deepEqual(result.episodes[0].lines, [[1, ""]]);
});

check("tuple line numbers agree exactly with existing range extraction including final empty lines", () => {
  const result = numbered(lineIndex, [1, 2, 3, 4, 5, 6, 7]);
  for (const episode of result.episodes) for (const [line, text] of episode.lines) {
    const selected = foundation.assembleSelections(lineIndex, [{ episode: episode.number, startLine: line, endLine: line, purpose: "核对原行" }]);
    assert.equal(selected[0].content, text);
  }
});

check("numbered scope preserves requested order and permits an explicitly empty preceding source", () => {
  assert.deepEqual(numbered(lineIndex, [4, 0, 2]).episodes.map((episode) => episode.number), [4, 0, 2]);
  assert.deepEqual(numbered(lineIndex, []), { schema: "NUMBERED_SOURCE_V1", version: lineIndex.version, episodes: [] });
});

check("numbered source rejects unknown, duplicate, noninteger and malformed scopes", () => {
  for (const selected of [[999], [1, 1], [-1], [1.5], ["1"], [null], null, {}]) {
    assert.throws(() => numbered(lineIndex, selected as readonly number[]), foundation.FoundationContractError);
  }
});

check("numbered source and whole requests reject version drift instead of relabeling changed text", () => {
  const changed = structuredClone(lineIndex); changed.episodes[0].content = "被改的源字";
  assert.throws(() => numbered(changed, [0]), /版本|version/);
  assert.throws(() => numbered({ ...lineIndex, version: "stale" }, [1]), /版本|version/);
  const changedRefs = structuredClone(referenceIndex); changedRefs.episodes[0].content += "\n多出来一行";
  assert.throws(() => foundation.requireF1Output(draft([{ episode: 27, wholeEpisode: true, purpose: "整集用途" }]), changedRefs, [28]), /版本|version/);
});

check("frozen source, scope and whole request are unchanged and raw consumer extraction still uses content", () => {
  const frozen = freeze(structuredClone(lineIndex)); const selected = freeze([4, 1]); const before = JSON.stringify({ frozen, selected });
  numbered(frozen, selected);
  assert.equal(JSON.stringify({ frozen, selected }), before);
  assert.equal(foundation.extractEpisodeSource(frozen, 4).content, lineIndex.episodes[4].content);
  assert.ok(!("lines" in foundation.extractEpisodeSource(frozen, 4)), "编号格式不能替换原始SourceIndex/消费者接口");
  const requestIndex = freeze(structuredClone(referenceIndex));
  const request = freeze(draft([{ episode: 27, wholeEpisode: true, purpose: "明确整集请求" }]));
  const requestBefore = JSON.stringify({ requestIndex, request });
  foundation.requireF1Output(request, requestIndex, [28]);
  assert.equal(JSON.stringify({ requestIndex, request }), requestBefore);
});

check("task and F1 schema explain numbered source, optional undeclared selections and explicit whole requests", () => {
  const sourceRules = foundation.FOUNDATION_TASK_CONTRACT.permissions.source;
  const brief = foundation.FOUNDATION_TASK_CONTRACT.roles.F1.deliveryLevel;
  for (const text of ["NUMBERED_SOURCE_V1", "编号", "对白", "coverage", "precedingSource"]) assert.ok(`${sourceRules}\n${brief}`.includes(text), text);
  assert.match(brief, /sourceSelections.*(省略|null)/); assert.match(brief, /未申报/); assert.match(brief, /不等于/);
  assert.match(brief, /wholeEpisode/); assert.match(brief, /prior/); assert.match(brief, /大纲|整剧/);
  const schema = JSON.stringify(foundation.FOUNDATION_OUTPUT_SCHEMAS.F1);
  for (const text of ["wholeEpisode", "null", "purpose"]) assert.ok(schema.includes(text), text);
});

if (failures.length) { console.error(`foundation reference verification failed (${failures.length} failed, ${checks} passed)`); process.exitCode = 1; }
else console.log(`foundation reference verification passed (${checks} checks; synthetic input only; no database or provider)`);
