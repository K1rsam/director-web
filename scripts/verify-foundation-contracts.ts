import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as foundation from "@/lib/project-foundation-contracts";

let checks = 0;
function check(name: string, run: () => void) {
  run();
  checks += 1;
  console.log(`PASS ${name}`);
}

check("raw source index replaces normalized scene-node input", () => {
  assert.equal(typeof foundation.buildSourceIndex, "function");
});

const source = [
  { number: 1, title: "甲", content: "  第一行\r\n\r\n甲OS：钥匙在乙处。\n末行  \n" },
  { number: 2, title: null, content: "乙：找什么？\n同号行但不同集" }
];
const index = foundation.buildSourceIndex(source);
check("existing episode zero retains its source identity", () => {
  const zero = foundation.buildSourceIndex([{ number: 0, title: "人物资料", content: "甲：资料区设定" }]);
  assert.equal(foundation.extractEpisodeSource(zero, 0).content, "甲：资料区设定");
  assert.equal(foundation.requireQ1Output({ coverage: [0], verdict: "READY", summary: "已审资料区。", issues: [] }, zero, [0]).coverage[0], 0);
});
const ref = { episode: 1, startLine: 3, endLine: 3 };
const selection = { ...ref, purpose: "甲的主观判断，不代表乙已知" };
const f1 = {
  coverage: [1], overview: "甲认为钥匙在乙处，乙未表明知情。",
  episodes: [{ number: 1, summary: "甲寻找钥匙。", context: "只确认甲如此想。", sourceSelections: [selection] }],
  issues: []
};
const f2 = {
  coverage: [1],
  assets: [{ key: "person-jia", name: "甲", type: "CH", aliases: [], description: "甲为发声主体。", sourceRefs: [ref],
    appearances: [{ episode: 1, presence: "ONSTAGE", state: "以OS表达想法。", sourceRefs: [ref] }] }],
  episodes: [{ number: 1, context: "甲以原称谓出现。", assetKeys: ["person-jia"] }], issues: []
};
const q1 = { coverage: [1], verdict: "READY", summary: "本范围资料可供下一岗；未验证生成效果。", issues: [] };

check("model integer strings normalize at the contract boundary without rewriting original output", () => {
  const raw = { ...f1, coverage: ["1"], episodes: [{ ...f1.episodes[0], number: "1", sourceSelections: [{ ...selection, episode: "1", startLine: "3", endLine: "3" }] }] };
  const before = JSON.stringify(raw);
  assert.deepEqual(foundation.requireF1Output(raw, index, [1]), f1);
  assert.equal(JSON.stringify(raw), before, "原始模型data及raw证据不得被就地改写");
  assert.deepEqual(foundation.validateF1Output(raw, index, [1]), []);
  const rawRef = { episode: "1", startLine: "3", endLine: "3" };
  const rawF2 = { ...f2, coverage: ["1"], assets: [{ ...f2.assets[0], sourceRefs: [rawRef], appearances: [{ ...f2.assets[0].appearances[0], episode: "1", sourceRefs: [rawRef] }] }], episodes: [{ ...f2.episodes[0], number: "1" }] };
  assert.deepEqual(foundation.requireF2Output(rawF2, index, [1]), f2);
  assert.deepEqual(foundation.requireQ1Output({ ...q1, coverage: ["1"] }, index, [1]), q1);
  const zero = foundation.buildSourceIndex([{ number: 0, title: null, content: "原第0集" }]);
  assert.deepEqual(foundation.requireQ1Output({ ...q1, coverage: ["0"] }, zero, [0]).coverage, [0]);
});

check("integer-string compatibility keeps invalid values and source bounds blocked", () => {
  for (const value of ["", " ", " 1", "1 ", "+1", "-1", "1.0", "1.5", "1e0", "0x1", "01", "１", "第1集", "9007199254740992", null, false, [], {}, undefined]) {
    assert.throws(() => foundation.requireF1Output({ ...f1, coverage: [value], episodes: [{ ...f1.episodes[0], number: value }] }, index, [1]), foundation.FoundationContractError);
  }
  assert.throws(() => foundation.requireF1Output({ ...f1, coverage: [1, "1"] }, index, [1]), /重复|范围/);
  assert.throws(() => foundation.requireF1Output({ ...f1, episodes: [{ ...f1.episodes[0], sourceSelections: [{ ...selection, startLine: "0" }] }] }, index, [1]));
  assert.throws(() => foundation.requireF1Output({ ...f1, episodes: [{ ...f1.episodes[0], sourceSelections: [{ ...selection, endLine: "6" }] }] }, index, [1]), /越界/);
});

check("source content, whitespace and CRLF are preserved byte-for-byte", () => {
  assert.equal(index.schema, "RAW_SOURCE_INDEX_V1");
  assert.equal(index.episodes[0].content, source[0].content);
  assert.equal(index.episodes[0].lineCount, 5);
  assert.equal(foundation.extractEpisodeSource(index, 1).content, source[0].content);
  assert.equal(foundation.assembleSelections(index, [{ episode: 1, startLine: 1, endLine: 5, purpose: "完整原文" }])[0].content, source[0].content);
  assert.equal(foundation.assembleSelections(index, [selection])[0].content, "甲OS：钥匙在乙处。\n");
});

check("version covers ordered numbers, titles and exact text", () => {
  assert.match(index.version, /^[a-f0-9]{64}$/);
  assert.equal(index.version, foundation.buildSourceIndex(source).version);
  assert.notEqual(index.version, foundation.buildSourceIndex(source.map((e) => ({ ...e, content: e.content.trim() }))).version);
  assert.notEqual(index.version, foundation.buildSourceIndex([{ ...source[0], title: "改名" }, source[1]]).version);
  assert.notEqual(index.version, foundation.buildSourceIndex([{ ...source[0], number: 3 }, source[1]]).version);
  assert.equal(index.version, foundation.buildSourceIndex([...source].reverse()).version, "集号排序后版本应稳定");
  assert.throws(() => foundation.extractEpisodeSource(index, 1, "stale-version"), /version|版本/);
  assert.throws(() => foundation.assembleSelections(index, [selection], "stale-version"), /version|版本/);
});

check("cross-episode references are unambiguous; invalid ranges are rejected", () => {
  const assembled = foundation.assembleSelections(index, [selection, { episode: 2, startLine: 1, endLine: 1, purpose: "后接判断" }]);
  assert.equal(assembled[1].content, "乙：找什么？\n");
  for (const invalid of [
    { ...selection, episode: 3 }, { ...selection, startLine: 0 }, { ...selection, endLine: 6 },
    { ...selection, startLine: 4, endLine: 3 }, { ...selection, startLine: 1.5 }, { ...selection, purpose: " " }
  ]) assert.throws(() => foundation.assembleSelections(index, [invalid]));
  assert.throws(() => foundation.assembleSelections(index, [selection, selection]), /重复|重叠/);
  assert.throws(() => foundation.assembleSelections(index, [selection, { ...selection, endLine: 4, purpose: "不同目的也不静默覆盖" }]), /重复|重叠/);
  assert.throws(() => foundation.buildSourceIndex([source[0], source[0]]));
});

check("chunks respect episode boundaries and explicitly flag oversized episodes", () => {
  const chunkIndex = foundation.buildSourceIndex([{ number: 1, title: null, content: "a".repeat(24_001) }, { number: 2, title: null, content: "b" }]);
  assert.deepEqual(foundation.buildFoundationChunks(chunkIndex), [
    { episodes: [1], chars: 24_001, oversized: true }, { episodes: [2], chars: 1, oversized: false }
  ]);
  assert.equal(foundation.extractEpisodeSource(chunkIndex, 1).content.length, 24_001);
});

check("F1 accepts complete scoped output and rejects missing, duplicated or fake coverage", () => {
  assert.deepEqual(foundation.requireF1Output(f1, index, [1]), f1);
  for (const field of ["coverage", "overview", "episodes"]) {
    const invalid: Record<string, unknown> = { ...f1 };
    delete invalid[field];
    assert.throws(() => foundation.requireF1Output(invalid, index, [1]), foundation.FoundationContractError);
  }
  for (const coverage of [[], [2], [1, 1], [1, 2]]) assert.throws(() => foundation.requireF1Output({ ...f1, coverage }, index, [1]));
  assert.throws(() => foundation.requireF1Output({ ...f1, episodes: [...f1.episodes, ...f1.episodes] }, index, [1]));
  assert.equal(foundation.requireF1Output({ ...f1, episodes: [{ number: 1, summary: "甲" }] }, index, [1]).episodes[0].context, "", "额外前情可省略，不强制重复摘要");
  assert.throws(() => foundation.requireF1Output({ ...f1, episodes: [{ number: 1, summary: "甲", context: [] }] }, index, [1]), "已提供的坏context类型仍拒绝");
  assert.throws(() => foundation.requireF1Output({ ...f1, episodes: [{ ...f1.episodes[0], sourceSelections: [{ ...selection, episode: 9 }] }] }, index, [1]));
  assert.ok(foundation.validateF1Output({ ...f1, overview: "" }, index, [1]).some((issue) => issue.owner === "PROGRAM"));
});

check("F1 keeps optional identity-check notes separate from current summary and context", () => {
  const notes = "后续称谓与跨岗身份核对线索，仅供F2后台核对。";
  const raw = { ...f1, episodes: [{ ...f1.episodes[0], f2Notes: notes }] };
  const result = foundation.requireF1Output(raw, index, [1]);
  assert.equal(result.episodes[0].f2Notes, notes);
  assert.equal(result.episodes[0].summary, f1.episodes[0].summary); assert.equal(result.episodes[0].context, f1.episodes[0].context);
  assert.equal(foundation.mergeF1Outputs([result], index, [1]).episodes[0].f2Notes, notes);
  for (const f2Notes of [null, "", " \n "]) assert.ok(!("f2Notes" in foundation.requireF1Output({ ...raw, episodes: [{ ...raw.episodes[0], f2Notes }] }, index, [1]).episodes[0]));
  for (const f2Notes of [1, [], {}]) assert.throws(() => foundation.requireF1Output({ ...raw, episodes: [{ ...raw.episodes[0], f2Notes }] }, index, [1]), foundation.FoundationContractError);
  assert.deepEqual(foundation.requireF1Output(f1, index, [1]), f1, "旧F1兼容");
});

check("F1 brief places future identity notes in backend f2Notes and forbids VO projection conflation", () => {
  const brief = foundation.FOUNDATION_TASK_CONTRACT.roles.F1.deliveryLevel;
  assert.match(brief, /summary.*context|summary\/context/);
  assert.match(brief, /f2Notes/); assert.match(brief, /旁观.*VO|VO.*旁观/); assert.match(brief, /投影/);
  assert.ok("f2Notes" in foundation.FOUNDATION_OUTPUT_SCHEMAS.F1.episodes[0]);
});

check("F2 enforces keys, evidence, appearance episode scope and consumer key references", () => {
  assert.deepEqual(foundation.requireF2Output(f2, index, [1]), f2);
  for (const field of ["coverage", "episodes"]) {
    const invalid: Record<string, unknown> = { ...f2 };
    delete invalid[field];
    assert.throws(() => foundation.requireF2Output(invalid, index, [1]));
  }
  assert.throws(() => foundation.requireF2Output({ ...f2, assets: [...f2.assets, ...f2.assets] }, index, [1]));
  assert.throws(() => foundation.requireF2Output({ ...f2, assets: [{ ...f2.assets[0], description: undefined }] }, index, [1]));
  assert.throws(() => foundation.requireF2Output({ ...f2, assets: [{ ...f2.assets[0], sourceRefs: [] }] }, index, [1]));
  assert.throws(() => foundation.requireF2Output({ ...f2, coverage: [1, 2] }, index, [1]));
  assert.throws(() => foundation.requireF2Output({ ...f2, assets: [{ ...f2.assets[0], appearances: [{ ...f2.assets[0].appearances[0], episode: 2 }] }] }, index, [1]));
  assert.throws(() => foundation.requireF2Output({ ...f2, episodes: [{ ...f2.episodes[0], assetKeys: ["missing"] }] }, index, [1]));
  assert.throws(() => foundation.requireF2Output({ ...f2, episodes: [...f2.episodes, ...f2.episodes] }, index, [1]));
  assert.throws(() => foundation.requireF2Output({ ...f2, assets: [{ ...f2.assets[0], appearances: [{ ...f2.assets[0].appearances[0], presence: "UNKNOWN" }] }] }, index, [1]));
});

check("Q1 rejects contradictory verdicts and requires actionable non-ready issues", () => {
  assert.deepEqual(foundation.requireQ1Output(q1, index, [1]), q1);
  const major = { severity: "MAJOR", owner: "F2", coordinate: "assets.person-jia", problem: "将甲说法写成事实，需保留主观限定。", sourceRefs: [ref] };
  assert.throws(() => foundation.requireQ1Output({ ...q1, issues: [major] }, index, [1]));
  assert.throws(() => foundation.requireQ1Output({ ...q1, verdict: "REPAIR" }, index, [1]));
  assert.throws(() => foundation.requireQ1Output({ ...q1, verdict: "BLOCKED", summary: " " }, index, [1]));
  assert.throws(() => foundation.requireQ1Output({ ...q1, coverage: [2] }, index, [1]));
  assert.equal(foundation.requireQ1Output({ ...q1, verdict: "REPAIR", issues: [major] }, index, [1]).verdict, "REPAIR");
});

check("model issues survive contract failure beside mechanical issues", () => {
  const modelIssue = { severity: "MAJOR", owner: "F1", coordinate: "episodes.1", problem: "乙是否知情需要补核。", sourceRefs: [ref] };
  assert.throws(() => foundation.requireF1Output({ ...f1, overview: "", issues: [modelIssue] }, index, [1]), (error: unknown) => {
    assert.ok(error instanceof foundation.FoundationContractError);
    assert.ok(error.issues.some((issue) => issue.owner === "F1" && issue.problem === modelIssue.problem));
    assert.ok(error.issues.some((issue) => issue.owner === "PROGRAM"));
    return true;
  });
});

check("full merges reject incomplete coverage, duplicate episodes and asset identity conflicts", () => {
  const first = foundation.requireF1Output(f1, index, [1]);
  const second = foundation.requireF1Output({ ...f1, coverage: [2], overview: "乙询问甲。", episodes: [{ ...f1.episodes[0], number: 2, sourceSelections: [] }] }, index, [2]);
  assert.deepEqual(foundation.mergeF1Outputs([first, second], index, [1, 2]).coverage, [1, 2]);
  assert.throws(() => foundation.mergeF1Outputs([first], index, [1, 2]));
  assert.throws(() => foundation.mergeF1Outputs([first, first], index, [1]));
  const a = foundation.requireF2Output(f2, index, [1]);
  const otherRef = { episode: 2, startLine: 1, endLine: 1 };
  const next = foundation.requireF2Output({ ...f2, coverage: [2], assets: [{ ...f2.assets[0], sourceRefs: [otherRef], appearances: [{ episode: 2, presence: "MENTIONED", state: "乙向甲提问。", sourceRefs: [otherRef] }] }], episodes: [{ number: 2, context: "甲被乙询问。", assetKeys: ["person-jia"] }] }, index, [2]);
  const merged = foundation.mergeF2Outputs([a, next], index, [1, 2]);
  assert.equal(merged.assets.length, 1);
  assert.equal(merged.assets[0].appearances.length, 2);
  assert.throws(() => foundation.mergeF2Outputs([a, { ...next, assets: [{ ...next.assets[0], name: "不是同一人" }] }], index, [1, 2]));
  const described = foundation.mergeF2Outputs([a, { ...next, assets: [{ ...next.assets[0], description: "后片提供的另一段有据描述" }] }], index, [1, 2]);
  assert.equal(described.assets[0].description, a.assets[0].description, "首次描述不被覆盖");
  assert.deepEqual(described.assets[0].descriptionVariants, [
    { text: a.assets[0].description, sourceRefs: [ref] },
    { text: "后片提供的另一段有据描述", sourceRefs: [otherRef] }
  ]);
});

check("plain system loader preserves current explicit prompt bytes and role configs do not invoke skills", () => {
  const currentPrompts = path.resolve(process.cwd(), "prompts/foundation");
  assert.deepEqual(foundation.PROJECT_FOUNDATION_STAGES.map((stage) => stage.code), ["F1", "F2", "Q1"]);
  assert.deepEqual(foundation.PROJECT_FOUNDATION_STAGES.map((stage) => stage.uiStage), ["P1", "P2", "P3"]);
  for (const stage of foundation.PROJECT_FOUNDATION_STAGES) {
    assert.equal(stage.skill, "");
    const actual = foundation.loadFoundationSystemPrompt(stage.code);
    assert.equal(actual, readFileSync(path.join(currentPrompts, `${stage.code}.md`), "utf8"));
    assert.match(foundation.hashFoundationPrompt(actual), /^[a-f0-9]{64}$/);
    assert.notEqual(foundation.hashFoundationPrompt(actual), foundation.hashFoundationPrompt(`${actual}\n`));
  }
});

check("task envelope carries exact INPUT_JSON without changing system text", () => {
  const input = { sourceVersion: index.version, scope: [1], prior: null, source: source[0], purpose: "单集资料" };
  const prompt = foundation.buildFoundationPrompt("F1", input, "只处理第1集。");
  assert.ok(prompt.includes("只处理第1集。"));
  assert.ok(!prompt.includes("使用 $"));
  assert.deepEqual(JSON.parse(prompt.split("INPUT_JSON:\n")[1]), input);
  assert.ok(prompt.includes("sourceSelections"));
  assert.ok(prompt.includes("JSON整数") && prompt.includes("不要给数字加引号"), "数字字段类型须明确，不能只给字符串占位说明");
  assert.ok(!prompt.includes(foundation.loadFoundationSystemPrompt("F1")));
});

console.log(`foundation contracts verification passed (${checks} checks; deterministic only)`);
