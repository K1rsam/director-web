import assert from "node:assert/strict";
import { isProductionEpisodeNumber, productionScopeFromSource, readProductionScope } from "../lib/production-episodes";

const scope = productionScopeFromSource({ sourceStructure: { sections: [
  { kind: "BACKGROUND", episodeNumber: 3 }, { kind: "EPISODE", episodeNumber: 0 }, { kind: "EPISODE", episodeNumber: 5 }, { kind: "UNRESOLVED", episodeNumber: 7 }
] } });
assert.equal(isProductionEpisodeNumber(0, scope), true, "A source-confirmed real episode zero is not background by its number");
assert.equal(isProductionEpisodeNumber(3, scope), false, "A positively numbered background row is not a production episode");
assert.equal(isProductionEpisodeNumber(7, scope), false, "An unresolved source range is not silently production-ready");
assert.equal(isProductionEpisodeNumber(5, scope), true);
assert.equal(isProductionEpisodeNumber(1, scope), false);
const legacy = productionScopeFromSource(null);
assert.equal(isProductionEpisodeNumber(1, legacy), true, "No-source legacy records preserve the existing positive-number fallback");
assert.equal(isProductionEpisodeNumber(0, legacy), false, "Unknown zero is not guessed to be production");
assert.equal(isProductionEpisodeNumber(-1, scope), false);
async function verifyStoredScope() {
  const database = (content: string | null) => ({ sceneSnapshot: { findFirst: async () => content === null ? null : { content } } }) as unknown as NonNullable<Parameters<typeof readProductionScope>[1]>;
  const absent = await readProductionScope("synthetic-project", database(null));
  assert.deepEqual(absent, { sourceKnown: false, episodeNumbers: [] });
  assert.equal(isProductionEpisodeNumber(3, absent), true, "Only a genuinely absent source retains positive-number legacy compatibility");
  for (const [label, content] of [
    ["broken JSON", "{broken"],
    ["missing structure", JSON.stringify({ sourceText: "stored source still exists" })],
    ["missing sections", JSON.stringify({ sourceStructure: {} })],
    ["invalid sections", JSON.stringify({ sourceStructure: { sections: "not an array" } })],
    ["unusable sections", JSON.stringify({ sourceStructure: { sections: [{ kind: "EPISODE", episodeNumber: "3" }] } })],
    ["JSON null", "null"]
  ]) {
    const blocked = await readProductionScope("synthetic-project", database(content));
    assert.deepEqual(blocked, { sourceKnown: true, episodeNumbers: [] }, label);
    assert.equal(isProductionEpisodeNumber(3, blocked), false, `${label} must not make a positive background row eligible`);
    assert.equal(isProductionEpisodeNumber(0, blocked), false, `${label} must not guess episode zero`);
  }
  const verified = await readProductionScope("synthetic-project", database(JSON.stringify({ sourceStructure: { sections: [{ kind: "EPISODE", episodeNumber: 0 }, { kind: "BACKGROUND", episodeNumber: 3 }] } })));
  assert.equal(isProductionEpisodeNumber(0, verified), true);
  assert.equal(isProductionEpisodeNumber(3, verified), false);
  console.log("PASS source-based episode eligibility: real zero, positive background, unresolved, gaps, absent-source legacy fallback and unreadable-source fail-closed; no database or model calls");
}
verifyStoredScope().catch(error => { console.error(error); process.exitCode = 1; });
