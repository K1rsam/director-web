import assert from "node:assert/strict";
import { bindQ1ReviewEvidence, resolveReviewTarget } from "@/lib/foundation-review-evidence";
import { buildNumberedSource, buildSourceIndex } from "@/lib/project-foundation-contracts";

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
const index = buildSourceIndex([
  { number: 0, title: null, content: "  synthetic profile\r\nuncertain claim\r\n\r\n" },
  { number: 28, title: null, content: "synthetic previous\n" },
  { number: 29, title: null, content: "  synthetic event\r\n\r\nuncertain voice\r\n" }
]);
const sourceRef = (episode: number, startLine = 1, endLine = startLine) => ({ episode, startLine, endLine });
const event = (episode: number, presence: string, state: string) => ({ episode, presence, state, sourceName: "uncertain label", sourceNameMatch: "FORGED_FLAG", sourceRefs: [sourceRef(episode)] });
const asset = (key: string) => ({ key, name: "same name", type: "BEAST", aliases: ["later-name"], description: "  alleged identity?\r\n", descriptionVariants: [{ text: "unverified description", sourceRefs: [sourceRef(0)] }], sourceRefs: [sourceRef(0)], appearances: [event(28, "MENTIONED", "alleged account"), event(29, "ONSTAGE", "uncertain state"), event(29, "MENTIONED", "separate account")] });
function fixture() {
  return {
    sourceVersion: index.version, inputVersion: "synthetic-input", scope: [29, 28], source: buildNumberedSource(index, [29, 28]),
    referenceSource: [{ ...sourceRef(0, 1, 4), sourceVersion: index.version, content: index.episodes[0].content, usedBy: ["synthetic reference"] }],
    candidates: {
      f1: { snapshotId: "f1-snapshot", projection: "SCOPE_PROJECTION", output: { overview: "  author overview\r\n\r\n", episodes: [{ number: 28, summary: "prior summary", context: "prior context", sourceSelections: [] }, { number: 29, summary: "uncertain summary?", context: "  unverified context\r\n", f2Notes: "alleged identity only", sourceSelections: [] }] } },
      f2: { snapshotId: "f2-snapshot", projection: "SCOPE_PROJECTION", output: { assets: [asset("beast-other"), asset("beast")], episodes: [{ number: 28, context: "prior asset context", assetKeys: [] }, { number: 29, context: "alleged asset context", assetKeys: ["beast"], backgroundRefs: [] }] } }
    },
    episodePackets: [28, 29].map((episode) => ({ schema: "EPISODE_FOUNDATION_V1", episode, sourceVersion: index.version, inputVersion: "synthetic-input", f1SnapshotId: "f1-snapshot", f2SnapshotId: "f2-snapshot", source: { number: episode, sourceVersion: index.version }, f1Context: `packet F1 ${episode}`, f2Context: `packet F2 ${episode}`, assetKeys: ["beast"], identities: [{ key: "beast", name: "uncertain label", nameBasis: "FORGED_BASIS", type: "BEAST", aliases: [], appearances: [event(episode, "ONSTAGE", "unconfirmed state")] }], backgroundRefs: [], sourceSelections: [] }))
  };
}
const target = (area: string, field: string, extra = {}) => ({ area, field, ...extra });
const backend = target("F2", "aliases", { assetKey: "beast" });
const packet = target("PACKET", "aliases", { episode: 29, assetKey: "beast" });
const issue = (extra = {}) => ({ severity: "MAJOR", owner: "F2", coordinate: "  keep original.coordinate\r\n", problem: "unresolved claim?", targets: [backend, packet], sourceRefs: [sourceRef(29, 1, 4)], ...extra });
const response = (issues: unknown[] = [issue()]) => ({ verdict: "REPAIR", coverage: [29, 28], summary: "  do not approve\r\n", issues });

check("backend aliases and empty packet aliases remain different BOUND values", () => {
  assert.deepEqual(resolveReviewTarget(fixture(), backend), { status: "BOUND", target: backend, value: ["later-name"] });
  assert.deepEqual(resolveReviewTarget(fixture(), packet), { status: "BOUND", target: packet, value: [] });
});
check("F1 fields use episode numbers, preserve text, and expose overview only without episode", () => {
  const input = fixture();
  for (const field of ["summary", "context", "f2Notes", "sourceSelections"]) {
    const result = resolveReviewTarget(input, target("F1", field, { episode: 29 }));
    assert.equal(result.status, "BOUND");
    assert.deepEqual(result.value, Reflect.get(input.candidates.f1.output.episodes[1], field));
  }
  assert.equal(resolveReviewTarget(input, target("F1", "overview")).value, input.candidates.f1.output.overview);
});
check("fixed F2 and packet field allowlists read all original values", () => {
  const input = fixture();
  for (const field of ["name", "type", "aliases", "description", "descriptionVariants", "sourceRefs", "appearances"]) {
    assert.deepEqual(resolveReviewTarget(input, target("F2", field, { assetKey: "beast" })).value, Reflect.get(input.candidates.f2.output.assets[1], field));
  }
  for (const field of ["context", "assetKeys", "backgroundRefs"]) assert.deepEqual(resolveReviewTarget(input, target("F2", field, { episode: 29 })).value, Reflect.get(input.candidates.f2.output.episodes[1], field));
  for (const field of ["f1Context", "f2Context", "assetKeys", "identities", "backgroundRefs", "sourceSelections"]) assert.deepEqual(resolveReviewTarget(input, target("PACKET", field, { episode: 29 })).value, Reflect.get(input.episodePackets[1], field));
  for (const field of ["name", "nameBasis", "type", "aliases", "appearances"]) assert.deepEqual(resolveReviewTarget(input, target("PACKET", field, { episode: 29, assetKey: "beast" })).value, Reflect.get(input.episodePackets[1].identities[0], field));
});
check("forged flags and uncertainty text remain observations, never semantic approval", () => {
  const input = fixture();
  const found = resolveReviewTarget(input, target("F2", "appearances", { assetKey: "beast" }));
  assert.deepEqual(found.value, input.candidates.f2.output.assets[1].appearances);
  assert.equal(resolveReviewTarget(input, target("PACKET", "nameBasis", { episode: 29, assetKey: "beast" })).value, "FORGED_BASIS");
  assert.equal(resolveReviewTarget(input, target("F2", "description", { assetKey: "beast" })).value, "  alleged identity?\r\n");
  assert.equal(Reflect.get(found, "verdict"), undefined);
});
check("invalid targets, arbitrary paths, prototype keys and selector types are UNRESOLVED", () => {
  const bad: unknown[] = [null, [], "F2.aliases", 0, {}, target("F3", "name"), target("F1", "context"), target("F1", "overview", { episode: 29 }), target("F1", "context", { episode: 29, assetKey: "beast" }), target("F2", "name"), target("PACKET", "identities"), target("F2", "aliases", { assetKey: null }), target("F2", "aliases", { assetKey: 0 }), target("F2", "aliases", { assetKey: [] }), target("F2", "aliases", { assetKey: "" }), target("F2", "aliases", { assetKey: "beast", episode: "29" }), target("F1", "context", { episode: null }), target("F1", "context", { episode: 29.5 }), target("F1", "context", { episode: -1 }), target("F2", "aliases", { assetKey: "__proto__" }), target("F2", "__proto__", { assetKey: "beast" }), target("F2", "constructor", { assetKey: "beast" }), target("F2", "output.assets[1].aliases", { assetKey: "beast" }), target("F2", "aliases", { assetKey: "beast", path: "name" }), JSON.parse('{"area":"F2","field":"aliases","assetKey":"beast","__proto__":{}}')];
  for (const locator of bad) assert.equal(resolveReviewTarget(fixture(), locator).status, "UNRESOLVED", JSON.stringify(locator));
});
check("every episode selector must be in the provided scope", () => {
  for (const locator of [target("F1", "context", { episode: 99 }), target("F2", "appearances", { episode: 99, assetKey: "beast" }), target("F2", "context", { episode: 99 }), target("PACKET", "identities", { episode: 99 })]) assert.equal(resolveReviewTarget(fixture(), locator).status, "UNRESOLVED");
});
check("missing asset key is ABSENT with visible keys, not covered by another key", () => {
  const result = resolveReviewTarget(fixture(), { ...backend, assetKey: "missing" });
  assert.equal(result.status, "ABSENT"); assert.deepEqual(result.availableKeys, ["beast-other", "beast"]); assert.equal(result.value, undefined);
  assert.equal(resolveReviewTarget(fixture(), { ...packet, assetKey: "missing" }).status, "ABSENT");
});
check("same names with different keys never merge or guess", () => {
  const input = fixture(); input.candidates.f2.output.assets[0].aliases = ["other alias"];
  assert.deepEqual(resolveReviewTarget(input, { ...backend, assetKey: "beast-other" }).value, ["other alias"]);
  assert.deepEqual(resolveReviewTarget(input, backend).value, ["later-name"]);
  assert.equal(resolveReviewTarget(input, { ...backend, assetKey: "same name" }).status, "ABSENT");
});
check("a visible parent missing the selected episode or field is ABSENT", () => {
  const input = fixture();
  assert.equal(resolveReviewTarget(input, target("F1", "f2Notes", { episode: 28 })).status, "ABSENT");
  assert.equal(resolveReviewTarget(input, target("F2", "backgroundRefs", { episode: 28 })).status, "ABSENT");
  input.candidates.f1.output.episodes.pop(); input.candidates.f2.output.episodes.pop(); input.episodePackets.pop();
  for (const locator of [target("F1", "context", { episode: 29 }), target("F2", "context", { episode: 29 }), packet]) assert.equal(resolveReviewTarget(input, locator).status, "ABSENT");
});
check("duplicate keys or episode selectors are UNRESOLVED", () => {
  const input = fixture();
  input.candidates.f2.output.assets.push(asset("beast")); input.candidates.f1.output.episodes.push(input.candidates.f1.output.episodes[1]); input.candidates.f2.output.episodes.push(input.candidates.f2.output.episodes[1]); input.episodePackets[1].identities.push(input.episodePackets[1].identities[0]);
  for (const locator of [backend, target("F1", "context", { episode: 29 }), target("F2", "context", { episode: 29 }), packet]) assert.equal(resolveReviewTarget(input, locator).status, "UNRESOLVED");
  input.episodePackets.push(input.episodePackets[1]);
  assert.equal(resolveReviewTarget(input, target("PACKET", "f1Context", { episode: 29 })).status, "UNRESOLVED");
});
check("invalid input and parent shapes cannot establish absence", () => {
  for (const input of [null, [], {}, { ...fixture(), scope: [29, 29] }, { ...fixture(), scope: ["29"] }, { ...fixture(), sourceVersion: null }]) assert.equal(resolveReviewTarget(input, backend).status, "UNRESOLVED");
  for (const bad of [undefined, null, {}, "assets", [null], [{ key: 4 }]]) {
    const input = fixture(); Reflect.set(input.candidates.f2.output, "assets", bad);
    assert.equal(resolveReviewTarget(input, backend).status, "UNRESOLVED");
  }
});
check("F2 episode filters appearances only, preserving multiple events and metadata", () => {
  const input = fixture();
  const result = resolveReviewTarget(input, target("F2", "appearances", { assetKey: "beast", episode: 29 }));
  assert.deepEqual(result.value, input.candidates.f2.output.assets[1].appearances.slice(1));
  for (const field of ["name", "type", "aliases", "description", "descriptionVariants", "sourceRefs"]) assert.equal(resolveReviewTarget(input, target("F2", field, { assetKey: "beast", episode: 29 })).status, "UNRESOLVED");
  input.candidates.f2.output.assets[1].appearances = [];
  assert.deepEqual(resolveReviewTarget(input, target("F2", "appearances", { assetKey: "beast", episode: 29 })).value, []);
  Reflect.set(input.candidates.f2.output.assets[1], "appearances", [null]);
  assert.equal(resolveReviewTarget(input, target("F2", "appearances", { assetKey: "beast", episode: 29 })).status, "UNRESOLVED");
});
check("packet source, common input, schema, and candidate snapshot bindings must match", () => {
  for (const [field, value] of [["sourceVersion", "old"], ["inputVersion", "old"], ["f1SnapshotId", "other"], ["f2SnapshotId", "other"], ["schema", "OTHER"]]) {
    const input = fixture(); Reflect.set(input.episodePackets[1], field, value);
    assert.equal(resolveReviewTarget(input, packet).status, "UNRESOLVED", field);
  }
  const input = fixture(); input.episodePackets[1].source.sourceVersion = "old";
  assert.equal(resolveReviewTarget(input, packet).status, "UNRESOLVED");
});
check("binding preserves REPAIR and every original issue without certifying flags", () => {
  const input = freeze(fixture()); const original = freeze(response());
  const result = bindQ1ReviewEvidence(input, original);
  assert.deepEqual(result.response, original);
  assert.deepEqual(result.binding, { sourceVersion: input.sourceVersion, inputVersion: input.inputVersion, f1SnapshotId: "f1-snapshot", f2SnapshotId: "f2-snapshot" });
  assert.equal(result.issueEvidence.length, 1); assert.equal(result.issueEvidence[0].issueIndex, 0);
  assert.deepEqual(result.issueEvidence[0].targets.map((entry) => entry.value), [["later-name"], []]);
  assert.equal(Reflect.get(result, "verdict"), undefined);
});
check("missing null empty and invalid locators preserve MAJOR issues and unresolved annotations", () => {
  const original = response([issue({ targets: undefined, sourceRefs: undefined }), issue({ targets: null, sourceRefs: null }), issue({ targets: [], sourceRefs: [] }), issue({ targets: [null, backend], sourceRefs: [null, sourceRef(29)] }), issue({ targets: "bad", sourceRefs: "bad" }), null]);
  const result = bindQ1ReviewEvidence(fixture(), original);
  assert.deepEqual(result.response, original); assert.equal(result.issueEvidence.length, original.issues.length);
  for (const annotation of result.issueEvidence) {
    assert.equal(annotation.targets[0].status, "UNRESOLVED"); assert.equal(annotation.sourceRefs[0].status, "UNRESOLVED");
  }
  assert.equal(result.issueEvidence[3].targets[1].status, "BOUND"); assert.equal(result.issueEvidence[3].sourceRefs[1].status, "BOUND");
});
check("invalid response shapes are retained without claiming a review or throwing", () => {
  for (const original of [null, [], "bad", {}, { issues: null }]) {
    const result = bindQ1ReviewEvidence(fixture(), original);
    assert.deepEqual(result.response, original); assert.deepEqual(result.issueEvidence, []); assert.ok(result.reason);
  }
});
check("numbered source keeps CRLF whitespace and the final empty line exactly", () => {
  const result = bindQ1ReviewEvidence(fixture(), response([issue({ sourceRefs: [sourceRef(29, 1, 4), sourceRef(29, 2), sourceRef(29, 4)] })]));
  assert.deepEqual(result.issueEvidence[0].sourceRefs.map((entry) => entry.content), [index.episodes[2].content, "\r\n", ""]);
  assert.ok(result.issueEvidence[0].sourceRefs.every((entry) => entry.status === "BOUND" && entry.sourceVersion === index.version));
  assert.deepEqual(result.issueEvidence[0].sourceRefs[0].sourceRef, sourceRef(29, 1, 4));
});
check("explicit reference excerpts use original absolute coordinates and exact relative slicing", () => {
  const input = fixture(); input.referenceSource = [{ ...sourceRef(0, 2, 4), sourceVersion: index.version, content: "uncertain claim\r\n\r\n", usedBy: ["synthetic reference"] }];
  const result = bindQ1ReviewEvidence(input, response([issue({ sourceRefs: [sourceRef(0, 2, 4), sourceRef(0, 3), sourceRef(0, 4)] })]));
  assert.deepEqual(result.issueEvidence[0].sourceRefs.map((entry) => entry.content), ["uncertain claim\r\n\r\n", "\r\n", ""]);
  assert.deepEqual(result.issueEvidence[0].sourceRefs[0].sourceRef, sourceRef(0, 2, 4));
});
check("unprovided invalid or out of bounds source refs never invent content", () => {
  const refs = [sourceRef(99), sourceRef(29, 0), sourceRef(29, 5), sourceRef(29, 3, 2), { episode: "29", startLine: 1, endLine: 1 }, { ...sourceRef(29), sourceVersion: "old" }, { ...sourceRef(29), inputVersion: "old" }, {}];
  const result = bindQ1ReviewEvidence(fixture(), response([issue({ sourceRefs: refs })]));
  for (const entry of result.issueEvidence[0].sourceRefs) { assert.equal(entry.status, "UNRESOLVED"); assert.equal(entry.content, undefined); }
});
check("disjoint or adjacent reference excerpts cannot be joined to manufacture a larger excerpt", () => {
  for (const start of [2, 3]) {
    const input = fixture(); input.referenceSource = [1, start].map((line) => ({ ...sourceRef(0, line), sourceVersion: index.version, content: `synthetic ${line}\r\n`, usedBy: [] }));
    const result = bindQ1ReviewEvidence(input, response([issue({ sourceRefs: [sourceRef(0, 1, start), sourceRef(0, start)] })]));
    assert.equal(result.issueEvidence[0].sourceRefs[0].status, "UNRESOLVED"); assert.equal(result.issueEvidence[0].sourceRefs[0].content, undefined);
    assert.equal(result.issueEvidence[0].sourceRefs[1].content, `synthetic ${start}\r\n`);
  }
});
check("duplicate numbered episodes, lines, and covering excerpts are unresolved", () => {
  const input = fixture(); input.source.episodes.push(input.source.episodes[0]);
  assert.equal(bindQ1ReviewEvidence(input, response()).issueEvidence[0].sourceRefs[0].status, "UNRESOLVED");
  const duplicateLine = fixture(); duplicateLine.source.episodes[0].lines[1] = duplicateLine.source.episodes[0].lines[0];
  assert.equal(bindQ1ReviewEvidence(duplicateLine, response()).issueEvidence[0].sourceRefs[0].status, "UNRESOLVED");
  const excerpts = fixture(); excerpts.referenceSource.push(excerpts.referenceSource[0]);
  assert.equal(bindQ1ReviewEvidence(excerpts, response([issue({ sourceRefs: [sourceRef(0)] })])).issueEvidence[0].sourceRefs[0].status, "UNRESOLVED");
});
check("malformed and version-mismatched supplied source remains unresolved", () => {
  for (const change of [(input: ReturnType<typeof fixture>) => { input.source.version = "old"; }, (input: ReturnType<typeof fixture>) => { Reflect.set(input.source.episodes[0], "lines", [null]); }, (input: ReturnType<typeof fixture>) => { input.source.episodes[0].lineCount = 1; }]) {
    const input = fixture(); change(input);
    assert.equal(bindQ1ReviewEvidence(input, response()).issueEvidence[0].sourceRefs[0].status, "UNRESOLVED");
  }
  for (const change of [(input: ReturnType<typeof fixture>) => { input.referenceSource[0].sourceVersion = "old"; }, (input: ReturnType<typeof fixture>) => { input.referenceSource[0].content = "too few lines"; }]) {
    const input = fixture(); change(input);
    assert.equal(bindQ1ReviewEvidence(input, response([issue({ sourceRefs: [sourceRef(0)] })])).issueEvidence[0].sourceRefs[0].status, "UNRESOLVED");
  }
});
check("numbered tuples cannot label multiple source lines as one line", () => {
  const input = fixture();
  input.source.episodes[0].lineCount = 1;
  input.source.episodes[0].lines = [[1, "synthetic line one\nsynthetic line two"]];
  const found = bindQ1ReviewEvidence(input, response([issue({ sourceRefs: [sourceRef(29)] })])).issueEvidence[0].sourceRefs[0];
  assert.equal(found.status, "UNRESOLVED"); assert.equal(found.content, undefined);
});
check("deep frozen inputs remain untouched when any returned evidence is mutated", () => {
  const input = freeze(fixture()); const original = freeze(response()); const locator = freeze({ ...backend });
  const before = structuredClone({ input, original, locator });
  const found = resolveReviewTarget(input, locator); (found.value as string[]).push("changed"); Reflect.set(found.target as object, "assetKey", "changed");
  const result = bindQ1ReviewEvidence(input, original);
  Reflect.set(result.response as object, "verdict", "changed");
  ((result.issueEvidence[0].targets[0].value) as string[]).push("changed");
  Reflect.set(result.issueEvidence[0].sourceRefs[0].sourceRef as object, "episode", 999);
  assert.deepEqual({ input, original, locator }, before);
});

console.log(`${checks} passed; ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
