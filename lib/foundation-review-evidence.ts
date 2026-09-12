/** Pure observations from the actual Q1 INPUT_JSON; never a semantic verdict. */
import { assembleSelections, buildNumberedSource, buildSourceIndex, isRecord } from "@/lib/project-foundation-contracts";

export type ReviewTarget = { area: "F1" | "F2" | "PACKET"; episode?: number; assetKey?: string; field: string };
export type ReviewTargetEvidence = { status: "BOUND" | "ABSENT" | "UNRESOLVED"; target: unknown; value?: unknown; reason?: string; availableKeys?: string[] };
export type ReviewSourceEvidence = { status: "BOUND" | "UNRESOLVED"; sourceRef: unknown; sourceVersion?: string; content?: string; reason?: string };
export type Q1ReviewEvidence = {
  response: unknown;
  binding: { sourceVersion: unknown; inputVersion: unknown; f1SnapshotId: unknown; f2SnapshotId: unknown };
  issueEvidence: Array<{ issueIndex: number; targets: ReviewTargetEvidence[]; sourceRefs: ReviewSourceEvidence[] }>;
  reason?: string;
};

const own = (value: Record<string, unknown>, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function scopeValid(input: Record<string, unknown>): boolean {
  return text(input.sourceVersion) && text(input.inputVersion) && Array.isArray(input.scope) && input.scope.length > 0
    && input.scope.every(integer) && new Set(input.scope).size === input.scope.length;
}
function candidate(input: Record<string, unknown>, key: "f1" | "f2") {
  return isRecord(input.candidates) && own(input.candidates, key) && isRecord(input.candidates[key]) ? input.candidates[key] : undefined;
}

export function resolveReviewTarget(input: unknown, target: unknown): ReviewTargetEvidence {
  const unresolved = (reason: string): ReviewTargetEvidence => ({ status: "UNRESOLVED", target: structuredClone(target), reason });
  const absent = (availableKeys: string[]): ReviewTargetEvidence => ({ status: "ABSENT", target: structuredClone(target), reason: "Not present in this supplied parent; another key may cover it.", availableKeys });
  if (!isRecord(target) || ![Object.prototype, null].includes(Object.getPrototypeOf(target))
    || Object.keys(target).some((key) => !["area", "episode", "assetKey", "field"].includes(key))
    || !own(target, "area") || !own(target, "field") || !text(target.field)
    || (own(target, "episode") && !integer(target.episode))
    || (own(target, "assetKey") && (!text(target.assetKey) || forbidden.has(target.assetKey)))) return unresolved("Invalid target selector.");
  if (!isRecord(input) || !scopeValid(input)) return unresolved("Invalid supplied input versions or scope.");
  const { area, episode, assetKey, field } = target;
  if (episode !== undefined && !(input.scope as number[]).includes(episode as number)) return unresolved("Episode outside supplied scope.");
  const fields = area === "F1" ? (assetKey !== undefined ? [] : episode === undefined ? ["overview"] : ["summary", "context", "f2Notes", "sourceSelections"])
    : area === "F2" ? (assetKey !== undefined ? (episode === undefined ? ["name", "type", "aliases", "description", "descriptionVariants", "sourceRefs", "appearances"] : ["appearances"]) : episode === undefined ? [] : ["context", "assetKeys", "backgroundRefs"])
      : area === "PACKET" && episode !== undefined ? (assetKey !== undefined ? ["name", "nameBasis", "type", "aliases", "appearances"] : ["f1Context", "f2Context", "assetKeys", "identities", "backgroundRefs", "sourceSelections"]) : [];
  if (!fields.includes(field)) return unresolved("Field or selector combination is not allowed.");
  let failure: ReviewTargetEvidence | undefined;
  function select(rows: unknown, key: "number" | "episode" | "key", value: unknown): Record<string, unknown> | undefined {
    if (!Array.isArray(rows) || rows.some((row) => !isRecord(row) || !own(row, key) || (key === "key" ? !text(row[key]) : !integer(row[key])))) {
      failure = unresolved("Invalid supplied parent collection."); return;
    }
    const matches = rows.filter((row) => row[key] === value);
    if (matches.length !== 1) {
      failure = matches.length ? unresolved("Duplicate selector is ambiguous.") : absent(rows.map((row) => String(row[key]))); return;
    }
    return matches[0];
  }
  let parent: unknown;
  if (area === "PACKET") {
    const packet = select(input.episodePackets, "episode", episode);
    if (!packet) return failure!;
    const f1 = candidate(input, "f1"); const f2 = candidate(input, "f2");
    if (packet.schema !== "EPISODE_FOUNDATION_V1" || packet.sourceVersion !== input.sourceVersion || packet.inputVersion !== input.inputVersion
      || !text(f1?.snapshotId) || !text(f2?.snapshotId) || packet.f1SnapshotId !== f1.snapshotId || packet.f2SnapshotId !== f2.snapshotId
      || !isRecord(packet.source) || packet.source.number !== episode || packet.source.sourceVersion !== input.sourceVersion) return unresolved("Packet versions or candidate snapshot bindings do not match supplied input.");
    parent = assetKey === undefined ? packet : select(packet.identities, "key", assetKey);
  } else {
    const output = candidate(input, area === "F1" ? "f1" : "f2")?.output;
    if (!isRecord(output)) return unresolved("Invalid supplied candidate output.");
    parent = area === "F1" ? (episode === undefined ? output : select(output.episodes, "number", episode))
      : assetKey === undefined ? select(output.episodes, "number", episode) : select(output.assets, "key", assetKey);
  }
  if (failure) return failure;
  if (!isRecord(parent)) return unresolved("Invalid supplied field parent.");
  if (!own(parent, field)) return absent(Object.keys(parent));
  let value = parent[field];
  if (area === "F2" && assetKey !== undefined && episode !== undefined && field === "appearances") {
    if (!Array.isArray(value) || value.some((entry) => !isRecord(entry) || !own(entry, "episode") || !integer(entry.episode))) return unresolved("Invalid supplied appearances.");
    value = value.filter((entry) => entry.episode === episode);
  }
  return { status: "BOUND", target: structuredClone(target), value: structuredClone(value) };
}

function resolveSourceRef(input: unknown, sourceRef: unknown): ReviewSourceEvidence {
  const unresolved = (reason: string): ReviewSourceEvidence => ({ status: "UNRESOLVED", sourceRef: structuredClone(sourceRef), reason });
  if (!isRecord(input) || !scopeValid(input) || !isRecord(sourceRef) || !integer(sourceRef.episode)
    || !integer(sourceRef.startLine) || sourceRef.startLine < 1 || !integer(sourceRef.endLine) || sourceRef.endLine < sourceRef.startLine) return unresolved("Invalid source reference or supplied input.");
  if ((own(sourceRef, "sourceVersion") && sourceRef.sourceVersion !== input.sourceVersion)
    || (own(sourceRef, "inputVersion") && sourceRef.inputVersion !== input.inputVersion)) return unresolved("Reference versions do not match supplied input.");
  const { episode, startLine, endLine } = sourceRef;
  const bound = (content: string): ReviewSourceEvidence => ({ status: "BOUND", sourceRef: structuredClone(sourceRef), sourceVersion: input.sourceVersion as string, content });
  const source = input.source;
  if (!isRecord(source) || source.schema !== "NUMBERED_SOURCE_V1" || source.version !== input.sourceVersion || !Array.isArray(source.episodes)) return unresolved("Invalid or version-mismatched numbered source.");
  if (source.episodes.some((entry) => !isRecord(entry) || !integer(entry.number))) return unresolved("Invalid numbered source episodes.");
  const numbered = source.episodes.filter((entry) => entry.number === episode);
  if (numbered.length > 1) return unresolved("Duplicate numbered source episode.");
  if (numbered.length) {
    const entry = numbered[0]; const lines: unknown = entry.lines;
    if (!integer(entry.lineCount) || entry.lineCount < 1 || endLine > entry.lineCount || !Array.isArray(lines)
      || lines.length !== entry.lineCount || lines.some((line, position) => !Array.isArray(line) || line.length !== 2 || line[0] !== position + 1 || typeof line[1] !== "string")) return unresolved("Missing, duplicated, or invalid numbered lines.");
    const local = buildSourceIndex([{ number: episode, title: null, content: lines.map((line) => line[1]).join("") }]);
    const checked = buildNumberedSource(local, [episode]).episodes[0].lines;
    if (checked.length !== lines.length || checked.some((line, position) => line[1] !== lines[position][1])) return unresolved("Numbered tuples do not follow the supplied text's actual line boundaries.");
    return bound(lines.slice(startLine - 1, endLine).map((line) => line[1]).join(""));
  }
  if (!Array.isArray(input.referenceSource) || input.referenceSource.some((entry) => !isRecord(entry) || !integer(entry.episode))) return unresolved("No valid supplied reference excerpts.");
  const excerpts = input.referenceSource.filter((entry) => entry.episode === episode && entry.startLine <= startLine && entry.endLine >= endLine);
  if (excerpts.length !== 1) return unresolved(excerpts.length ? "Overlapping supplied excerpts are ambiguous." : "Reference not contained in one supplied excerpt; gaps are never joined.");
  const excerpt = excerpts[0];
  if (excerpt.sourceVersion !== input.sourceVersion || !integer(excerpt.startLine) || excerpt.startLine < 1 || !integer(excerpt.endLine)
    || excerpt.endLine < excerpt.startLine || typeof excerpt.content !== "string") return unresolved("Invalid or version-mismatched supplied excerpt.");
  const local = buildSourceIndex([{ number: episode, title: null, content: excerpt.content }]);
  const span = excerpt.endLine - excerpt.startLine + 1; const lines = local.episodes[0].lineCount;
  if (lines !== span && !(lines === span + 1 && /(?:\r\n|\n|\r)$/.test(excerpt.content))) return unresolved("Supplied excerpt text does not match its line span.");
  return bound(assembleSelections(local, [{ episode, startLine: startLine - excerpt.startLine + 1, endLine: endLine - excerpt.startLine + 1, purpose: "Q1 supplied evidence" }])[0].content);
}

export function bindQ1ReviewEvidence(input: unknown, response: unknown): Q1ReviewEvidence {
  const data = isRecord(input) ? input : {};
  const result: Q1ReviewEvidence = { response: structuredClone(response), binding: structuredClone({ sourceVersion: data.sourceVersion, inputVersion: data.inputVersion,
    f1SnapshotId: candidate(data, "f1")?.snapshotId, f2SnapshotId: candidate(data, "f2")?.snapshotId }), issueEvidence: [] };
  if (!isRecord(response) || !Array.isArray(response.issues)) return { ...result, reason: "No valid supplied issues array; the response is retained unchanged." };
  result.issueEvidence = response.issues.map((issue, issueIndex) => {
    const row = isRecord(issue) ? issue : {};
    const targets = Array.isArray(row.targets) && row.targets.length ? row.targets : [row.targets];
    const refs = Array.isArray(row.sourceRefs) && row.sourceRefs.length ? row.sourceRefs : [row.sourceRefs];
    return { issueIndex, targets: targets.map((target) => resolveReviewTarget(input, target)), sourceRefs: refs.map((ref) => resolveSourceRef(input, ref)) };
  });
  return result;
}
