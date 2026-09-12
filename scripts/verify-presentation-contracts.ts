import assert from "node:assert/strict";
import {
  buildFoundationInput,
  mergeP1Outputs,
  type FoundationContext,
  type P1Output
} from "../lib/legacy-project-foundation-contracts";
import {
  contractAppliesToAnyEpisode,
  contractAppliesToEpisode,
  presentationDecisionKey,
  resolvePresentationContractScope
} from "../lib/presentation-contracts";

const formalEpisodes = [1, 10, 20];

assert.deepEqual(
  resolvePresentationContractScope({ scope_mode: "SOURCE_EPISODES", target_episode_numbers: [10, 1] }, formalEpisodes),
  { mode: "SOURCE_EPISODES", episodeNumbers: [1, 10] }
);
assert.deepEqual(
  resolvePresentationContractScope({ scope_mode: "SELECTED_EPISODES", target_episode_numbers: "1、20" }, formalEpisodes),
  { mode: "SELECTED_EPISODES", episodeNumbers: [1, 20] }
);
assert.deepEqual(
  resolvePresentationContractScope({ scope_mode: "SELECTED_EPISODES", target_episode_numbers: [] }, formalEpisodes),
  { mode: "SELECTED_EPISODES", episodeNumbers: [] }
);
assert.deepEqual(
  resolvePresentationContractScope({ scope_mode: "ALL_EPISODES" }, formalEpisodes),
  { mode: "ALL_EPISODES", episodeNumbers: formalEpisodes }
);
assert.deepEqual(
  resolvePresentationContractScope({ source_episode_number: 10 }, formalEpisodes),
  { mode: "SOURCE_EPISODES", episodeNumbers: [10] },
  "旧记录有 episodeId 时应只沿用原集"
);
assert.deepEqual(
  resolvePresentationContractScope({}, formalEpisodes),
  { mode: "ALL_EPISODES", episodeNumbers: formalEpisodes },
  "旧的项目级记录应保持全剧语义"
);
assert.equal(contractAppliesToEpisode({ scope_mode: "SOURCE_EPISODES", target_episode_numbers: [1, 10] }, 10, formalEpisodes), true);
assert.equal(contractAppliesToEpisode({ scope_mode: "SELECTED_EPISODES", target_episode_numbers: [1, 10] }, 20, formalEpisodes), false);
assert.equal(contractAppliesToAnyEpisode({ scope_mode: "SELECTED_EPISODES", target_episode_numbers: [1, 10] }, [20, 10], formalEpisodes), true);

const foundationOutput = (decision: NonNullable<P1Output["presentation_decisions_needed"]>[number]): P1Output => ({
  schema: "PROJECT_MEMORY_V2",
  story_contract: { genre: "", perspective: "", core_desire: "", immutable_facts: [] },
  episodes: [],
  relationships: [],
  secrets: [],
  foreshadowing: [],
  boundaries: [],
  issues: [],
  presentation_decisions_needed: [decision]
});

const firstDecision = {
  category: "system",
  question: "系统在画面中如何呈现？",
  options: ["A. 面板", "B. 声音"],
  evidence: "系统提示出现",
  episode_number: 1,
  episode_numbers: [1],
  rule_key: "system-presentation",
  source_node_refs: ["N1"]
};
const repeatedDecision = {
  ...firstDecision,
  episode_number: 10,
  episode_numbers: [10],
  evidence: "系统提示再次出现",
  source_node_refs: ["N10"]
};
const merged = mergeP1Outputs([foundationOutput(firstDecision), foundationOutput(repeatedDecision)]);
assert.equal(merged.presentation_decisions_needed?.length, 1, "同一 rule_key 跨集只能生成一张确认卡");
assert.deepEqual(merged.presentation_decisions_needed?.[0].episode_numbers, [1, 10]);
assert.deepEqual(merged.presentation_decisions_needed?.[0].source_node_refs, ["N1"], "主证据集节点不能混入其它集");

const fallbackMerged = mergeP1Outputs([
  foundationOutput({ ...firstDecision, rule_key: undefined }),
  foundationOutput({ ...repeatedDecision, rule_key: undefined })
]);
assert.equal(fallbackMerged.presentation_decisions_needed?.length, 1, "旧模型漏填 rule_key 时应按类别+问题合并");
assert.notEqual(
  presentationDecisionKey({ category: "system", question: "系统在画面中如何呈现？", rule_key: "a" }),
  presentationDecisionKey({ category: "system", question: "系统在画面中如何呈现？", rule_key: "b" })
);

const context = {
  project: { title: "测试项目", style: "真人", aspectRatio: "9:16" },
  episodes: formalEpisodes.map((number) => ({ number, title: `第${number}集` })),
  preludeEpisodes: [],
  episodeScenes: new Map(),
  contracts: [
    { category: "system", user_answer: "A", scope_mode: "SOURCE_EPISODES", target_episode_numbers: [1, 10] },
    { category: "flashback", user_answer: "B", scope_mode: "SELECTED_EPISODES", target_episode_numbers: [20] }
  ]
} as unknown as FoundationContext;
const firstChunk = buildFoundationInput(context, [1], "P2", "");
const tenthChunk = buildFoundationInput(context, [10], "P2", "");
const twentiethChunk = buildFoundationInput(context, [20], "P2", "");
const contractsOf = (input: unknown) => (input as { presentation_contracts?: unknown }).presentation_contracts;
assert.deepEqual(contractsOf(firstChunk), [{ category: "system", user_answer: "A" }]);
assert.deepEqual(contractsOf(tenthChunk), [{ category: "system", user_answer: "A" }]);
assert.deepEqual(contractsOf(twentiethChunk), [{ category: "flashback", user_answer: "B" }]);

console.log("presentation contract scope and merge verification passed");
