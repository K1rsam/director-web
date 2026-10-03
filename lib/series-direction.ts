import { createHash } from "node:crypto";

export const SERIES_DIRECTION_VERSION = "DIRECTOR_SERIES_DIRECTION_V1";
export const SERIES_BRIEF_MAX_CHARACTERS = 600;

/** Source-backed retrieval entries, not episode summaries or permanent current states. */
export type SeriesKnowledgeItem = {
  id: string; kind: 'RELATIONSHIP' | 'REVEAL' | 'CHANGE'; claim: 'SOURCE' | 'CHARACTER_CLAIM';
  statement: string; subjects: string[];
  source: { evidenceId: string; episodeId: string | null; quote: string; start: number; end: number };
};

export type SeriesDirectionContent = {
  settingTags: string[];
  mechanismTags: string[];
  arcTags: string[];
  primaryTone: string | null;
  secondaryTones: string[];
  audiencePromise: string | null;
  expressionRules: string[];
  avoidances: string[];
  episodeFlexibility: string | null;
};
export type SeriesSourceContext = {
  projectId: string;
  sourceVersion: string;
  episodeIds: string[];
  evidenceIds: string[];
};
export type SeriesDirectionInput = {
  id: string;
  revision: number;
  sourceVersion: string;
  reviewedEpisodeIds: string[];
  evidenceRefs: string[];
  content: SeriesDirectionContent;
  knowledgeIndex?: SeriesKnowledgeItem[];
};
export type DirectionApproval = {
  id: string;
  projectId: string;
  sourceVersion: string;
  draftHash: string;
  actorId: string;
  confirmedAt: string;
};
export type SeriesDirectionCard = SeriesDirectionInput & {
  schemaVersion: typeof SERIES_DIRECTION_VERSION;
  projectId: string;
  sourceManifestHash: string;
  hash: string;
  status: "DRAFT" | "CONFIRMED";
  confirmation: DirectionApproval | null;
  knowledgeEpisodeOrder?: string[];
};

function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function digest(value: unknown) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function line(value: unknown, max: number, code = "DIRECTION_TEXT"): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || /[\r\n\u0000-\u001f]/.test(value) || Array.from(value).length > max) fail(code);
  return value;
}
function list(value: unknown, count: number, width: number, code: string): string[] {
  if (!Array.isArray(value) || value.length > count) fail(code);
  const values = Array.from(value, item => line(item, width, code));
  if (new Set(values).size !== values.length) fail(code);
  return values;
}
function readSource(source: SeriesSourceContext): SeriesSourceContext {
  if (!source || typeof source !== "object") fail("DIRECTION_SOURCE");
  return {
    projectId: line(source.projectId, 200, "DIRECTION_SOURCE"),
    sourceVersion: line(source.sourceVersion, 200, "DIRECTION_SOURCE"),
    episodeIds: list(source.episodeIds, 10000, 200, "DIRECTION_COVERAGE"),
    evidenceIds: list(source.evidenceIds, 100000, 200, "DIRECTION_EVIDENCE"),
  };
}
function manifestHash(source: SeriesSourceContext) {
  return digest({ projectId: source.projectId, sourceVersion: source.sourceVersion, episodeIds: [...source.episodeIds].sort(), evidenceIds: [...source.evidenceIds].sort() });
}
function readContent(content: SeriesDirectionContent): SeriesDirectionContent {
  if (!content || typeof content !== "object") fail("DIRECTION_TEXT");
  const optional = (text: unknown, size: number) => text === null ? null : line(text, size);
  return {
    settingTags: list(content.settingTags, 3, 24, "DIRECTION_TEXT"),
    mechanismTags: list(content.mechanismTags, 3, 24, "DIRECTION_TEXT"),
    arcTags: list(content.arcTags, 3, 24, "DIRECTION_TEXT"),
    primaryTone: optional(content.primaryTone, 30),
    secondaryTones: list(content.secondaryTones, 2, 24, "DIRECTION_TEXT"),
    audiencePromise: optional(content.audiencePromise, 100),
    expressionRules: list(content.expressionRules, 3, 70, "DIRECTION_TEXT"),
    avoidances: list(content.avoidances, 3, 50, "DIRECTION_TEXT"),
    episodeFlexibility: optional(content.episodeFlexibility, 100),
  };
}
function readKnowledge(items: SeriesKnowledgeItem[], source: SeriesSourceContext): SeriesKnowledgeItem[] {
  if (!Array.isArray(items) || items.length > 2000) fail('DIRECTION_EVIDENCE');
  const result = Array.from(items, item => {
    if (!item || !['RELATIONSHIP', 'REVEAL', 'CHANGE'].includes(item.kind) || !['SOURCE', 'CHARACTER_CLAIM'].includes(item.claim)) fail('DIRECTION_EVIDENCE');
    const ref = item.source;
    if (!ref || !source.evidenceIds.includes(ref.evidenceId) || ref.episodeId !== null && !source.episodeIds.includes(ref.episodeId)
      || !Number.isSafeInteger(ref.start) || !Number.isSafeInteger(ref.end) || ref.start < 0 || ref.end <= ref.start) fail('DIRECTION_EVIDENCE');
    if (typeof ref.quote !== 'string' || !ref.quote.trim() || [...ref.quote].length > 240) fail('DIRECTION_EVIDENCE');
    return { id: line(item.id, 200, 'DIRECTION_EVIDENCE'), kind: item.kind, claim: item.claim,
      statement: line(item.statement, 240, 'DIRECTION_EVIDENCE'), subjects: list(item.subjects, 8, 80, 'DIRECTION_EVIDENCE'),
      source: { evidenceId: ref.evidenceId, episodeId: ref.episodeId, quote: ref.quote, start: ref.start, end: ref.end } };
  });
  if (new Set(result.map(item => item.id)).size !== result.length) fail('DIRECTION_EVIDENCE');
  return result;
}
function payload(input: SeriesDirectionInput, source: SeriesSourceContext): Omit<SeriesDirectionCard, "hash" | "status" | "confirmation"> {
  if (!input || !Number.isSafeInteger(input.revision) || input.revision < 1) fail("DIRECTION_REVISION");
  if (input.sourceVersion !== source.sourceVersion) fail("DIRECTION_STALE");
  const reviewedEpisodeIds = list(input.reviewedEpisodeIds, 10000, 200, "DIRECTION_COVERAGE");
  const evidenceRefs = list(input.evidenceRefs, 10000, 200, "DIRECTION_EVIDENCE");
  const episodes = new Set(source.episodeIds), evidence = new Set(source.evidenceIds);
  if (reviewedEpisodeIds.some(id => !episodes.has(id))) fail("DIRECTION_COVERAGE");
  if (evidenceRefs.some(id => !evidence.has(id))) fail("DIRECTION_EVIDENCE");
  return {
    schemaVersion: SERIES_DIRECTION_VERSION,
    id: line(input.id, 200, "DIRECTION_SOURCE"), projectId: source.projectId,
    revision: input.revision, sourceVersion: source.sourceVersion, sourceManifestHash: manifestHash(source),
    reviewedEpisodeIds: [...reviewedEpisodeIds].sort(), evidenceRefs: [...evidenceRefs].sort(), content: readContent(input.content),
    ...(input.knowledgeIndex === undefined ? {} : { knowledgeIndex: readKnowledge(input.knowledgeIndex, source), knowledgeEpisodeOrder: [...source.episodeIds] }),
  };
}
function assertCard(card: SeriesDirectionCard, source: SeriesSourceContext) {
  if (!card || card.projectId !== source.projectId || card.sourceVersion !== source.sourceVersion || card.sourceManifestHash !== manifestHash(source)) fail("DIRECTION_STALE");
  if (card.schemaVersion !== SERIES_DIRECTION_VERSION || card.hash !== digest(payload(card, source))) fail("DIRECTION_INTEGRITY");
}
function readApproval(approval: DirectionApproval | null, card: SeriesDirectionCard): DirectionApproval {
  if (!approval || approval.projectId !== card.projectId || approval.sourceVersion !== card.sourceVersion || approval.draftHash !== card.hash) fail("DIRECTION_APPROVAL");
  const confirmedAt = line(approval.confirmedAt, 40, "DIRECTION_APPROVAL");
  if (!Number.isFinite(Date.parse(confirmedAt)) || new Date(confirmedAt).toISOString() !== confirmedAt) fail("DIRECTION_APPROVAL");
  return { id: line(approval.id, 200, "DIRECTION_APPROVAL"), projectId: card.projectId, sourceVersion: card.sourceVersion,
    draftHash: card.hash, actorId: line(approval.actorId, 200, "DIRECTION_APPROVAL"), confirmedAt };
}
function brief(card: SeriesDirectionCard): string {
  const c = card.content;
  const lines = [
    `全剧方向 v${card.revision}`,
    c.settingTags.length ? `背景：${c.settingTags.join("、")}` : "",
    c.mechanismTags.length ? `机制：${c.mechanismTags.join("、")}` : "",
    c.arcTags.length ? `主线：${c.arcTags.join("、")}` : "",
    `主调：${c.primaryTone}`, c.secondaryTones.length ? `副调：${c.secondaryTones.join("、")}` : "",
    `观众体验：${c.audiencePromise}`,
    c.expressionRules.length ? `表现：${c.expressionRules.join("；")}` : "",
    c.avoidances.length ? `避免：${c.avoidances.join("；")}` : "",
    `单集弹性：${c.episodeFlexibility}`,
    "原文事实、台词与揭示时点优先；局部情绪不改全剧定位。",
  ].filter(Boolean);
  const text = lines.join("\n");
  if (Array.from(text).length > SERIES_BRIEF_MAX_CHARACTERS) fail("DIRECTION_BUDGET");
  return text;
}

/** Preview only; this does not confer confirmation or authorize downstream use. */
export function previewSeriesDirectionBrief(card: SeriesDirectionCard): string { return brief(card); }
function assertConfirmable(card: SeriesDirectionCard, source: SeriesSourceContext) {
  if (!source.episodeIds.length || card.reviewedEpisodeIds.length !== source.episodeIds.length) fail("DIRECTION_COVERAGE");
  if (!card.evidenceRefs.length) fail("DIRECTION_EVIDENCE");
  if (!card.content.primaryTone || !card.content.audiencePromise || !card.content.episodeFlexibility) fail("DIRECTION_INCOMPLETE");
  brief(card);
}

/** Pure data boundary. Coverage proves enumerated scope, not artistic understanding. */
export function createSeriesDirectionDraft(input: SeriesDirectionInput, sourceContext: SeriesSourceContext): SeriesDirectionCard {
  const source = readSource(sourceContext), value = payload(input, source);
  return freeze({ ...value, hash: digest(value), status: "DRAFT", confirmation: null });
}

/** The caller must fetch a real authorized approval record; this is not authentication. */
export function confirmSeriesDirection(card: SeriesDirectionCard, sourceContext: SeriesSourceContext, approval: DirectionApproval): SeriesDirectionCard {
  const source = readSource(sourceContext);
  assertCard(card, source); assertConfirmable(card, source);
  const accepted = readApproval(approval, card);
  if (card.status !== "DRAFT" && (card.status !== "CONFIRMED" || canonical(card.confirmation) !== canonical(accepted))) fail("DIRECTION_APPROVAL");
  return freeze({ ...payload(card, source), hash: card.hash, status: "CONFIRMED", confirmation: accepted });
}

export function reviseSeriesDirection(previous: SeriesDirectionCard, next: SeriesDirectionInput, sourceContext: SeriesSourceContext): SeriesDirectionCard {
  const source = readSource(sourceContext);
  if (!previous || !next || next.id !== previous.id || next.revision !== previous.revision + 1 || previous.projectId !== source.projectId) fail("DIRECTION_REVISION");
  return createSeriesDirectionDraft(next, source);
}

/** All episodes receive the same brief; there is deliberately no local-tone mutation API. */
export function projectSeriesDirection(card: SeriesDirectionCard, sourceContext: SeriesSourceContext, episodeId: string, approval: DirectionApproval | null) {
  const source = readSource(sourceContext);
  assertCard(card, source);
  if (card.status !== "CONFIRMED" || !card.confirmation) fail("DIRECTION_UNCONFIRMED");
  assertConfirmable(card, source);
  const accepted = readApproval(approval, card);
  if (canonical(card.confirmation) !== canonical(accepted)) fail("DIRECTION_APPROVAL");
  if (!source.episodeIds.includes(episodeId)) fail("DIRECTION_EPISODE");
  const position = source.episodeIds.indexOf(episodeId);
  const seriesKnowledge = (card.knowledgeIndex ?? []).filter(item => item.source.episodeId !== null && source.episodeIds.indexOf(item.source.episodeId) <= position)
    .map(item => ({ ...item, timing: item.source.episodeId === episodeId ? 'CURRENT_EPISODE_EVENT' as const : 'PRIOR_EVIDENCE' as const }));
  return freeze({ schemaVersion: SERIES_DIRECTION_VERSION, id: card.id, revision: card.revision, sourceVersion: card.sourceVersion, cardHash: card.hash, brief: brief(card), seriesKnowledge,
    seriesKnowledgePolicy: '关系、揭示与变化是带来源的检索证据，不是每集摘要；当集事件只从原文引用位置起成立，历史证据不等于状态永久持续；角色主张不等于客观事实。未定揭示时点的作者资料不投递为当前事实。' });
}
