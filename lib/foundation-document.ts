import type { FoundationFragment } from './foundation-fragments';
/** Independent, immutable working revisions. Reading/importing never writes old evidence or calls a model. */
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { loadFoundationInputs } from './foundation-state';
import { loadFoundationSourceContext } from './foundation-source';
import { loadFoundationChoices } from './foundation-choice-store';
import { mergeHumanChoices } from './foundation-human-choices';
import { buildNumberedSource, buildSourceIndex, isRecord, requireF1Output, type F1Output, type F2Asset, type SourceIndex } from './project-foundation-contracts';
import { applyProductionOptimizations, isProductionCatalog, mergeProductionCatalogs, projectProductionCatalog, requireProductionCatalog, requireProductionCatalogAuthor, requireProductionOptimization, type ProductionCatalog, type ProductionOptimization, type SceneFieldPatch, type Unresolved } from './foundation-production-contracts';
import type {SourceInterpretationAdoption} from './source-interpretation-adoption-proof';

export type FoundationDocument = {
  schema: 'FOUNDATION_DOCUMENT_V1'; revision: string; sourceVersion: string; sourceContextVersion: string;
  sourceHashes: Record<string, string>; settingsFingerprint: string; f1: F1Output | null; f2: ProductionCatalog | null;
  overviewParts: { coverage: number[]; overview: string }[]; editorialCoverage: number[]; notes: string[];
  editorialTodos: (Unresolved & { id: string })[];
  appliedDecisions: Record<string, string>; reviewedSuggestions: Record<string, string>; requiredDecisionIds: string[];
  decisionCoverage?: Record<string, { revision: string; episodes: number[]; notes: string[] }>;
  suggestionCoverage?: Record<string, { revision: string; episodes: number[]; notes: string[] }>;
  contextCoverage?: { fingerprint: string; episodes: number[] };
  identityHistory?: { sourceVersion: string; assets: (F2Asset & { role?: string; relationNote?: string; variants?: { key: string; name: string }[] })[] }[];
  workflow?: 'LIGHT_STAGE1_V1'; assetMethodVersion?: string; scenePatches?: SceneFieldPatch[];
  fragmentProgress?: { sourceVersion: string; q1Basis?: string; q1Dependencies?:Record<string,string>; f2: { fragment: FoundationFragment; output: ProductionCatalog; runId: string }[]; q1: string[] };
  sourceInterpretationAdoptions?:SourceInterpretationAdoption[];sourceInterpretationConditionsFingerprint?:string;
  origins: { stage: 'F1' | 'F2' | 'Q1'; runId: string; snapshotId?: string; scope: number[]; kind: 'snapshot' | 'response' | 'delivery' }[];
};
type Input = Pick<Awaited<ReturnType<typeof loadFoundationInputs>>, 'sourceVersion' | 'sourceIndex' | 'sourceContext' | 'projectConditions' | 'scriptInterpretationVersions' | 'interpretationAware'>;
type Db = Pick<Prisma.TransactionClient, 'sceneSnapshot' | 'pipelineRun' | 'presentationContract' | 'episode'>;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const union = (...parts: readonly number[][]) => [...new Set(parts.flat())].sort((a, b) => a - b);
const same = (a: number[], b: number[]) => isDeepStrictEqual(union(a), union(b));
const scopeList = (value: unknown): value is number[] => Array.isArray(value) && value.every(n => Number.isSafeInteger(n) && n >= 0) && new Set(value).size === value.length;
const json = (value: string | null) => { try { const body: unknown = JSON.parse(value ?? 'null'); return isRecord(body) ? body : {}; } catch { return {}; } };
const attempt = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };
const seed = (doc: FoundationDocument) => ({ ...doc, revision: `import-${digest({ ...doc, revision: '' })}` });

export function createEmptyDocument(input: Input): FoundationDocument {
  return seed({ schema: 'FOUNDATION_DOCUMENT_V1', revision: '', sourceVersion: input.sourceVersion, sourceContextVersion: input.sourceContext.version,
    sourceHashes: Object.fromEntries(input.sourceIndex.episodes.map(({ number, title, content }) => [number, digest({ number, title, content,
      ...(input.scriptInterpretationVersions?.[number] ? {interpretation: input.scriptInterpretationVersions[number]} : {}) })])),
    settingsFingerprint: digest({ schema: 'FOUNDATION_EDIT_DEPENDENCIES_V1', style: input.projectConditions.style, aspectRatio: input.projectConditions.aspectRatio, background: input.sourceContext.background.map(part => part.text) }),
    f1: null, f2: null, overviewParts: [], editorialCoverage: [], editorialTodos: [], notes: [], appliedDecisions: {}, reviewedSuggestions: {}, requiredDecisionIds: [], origins: [] });
}
function choices<T extends { episodes: number[] }>(items: T[] | undefined, scope: number[]): T[] {
  return (items ?? []).filter(item => !item.episodes.length || item.episodes.some(n => scope.includes(n))).map(item => ({ ...structuredClone(item), episodes: item.episodes.filter(n => scope.includes(n)) }));
}
function sliceF1(f1: F1Output, scope: number[]): F1Output {
  return { ...structuredClone(f1), coverage: scope, episodes: structuredClone(f1.episodes.filter(e => scope.includes(e.number))), humanChoices: choices(f1.humanChoices, scope) };
}
function sliceF2(f2: ProductionCatalog, scope: number[]): ProductionCatalog {
  return { ...structuredClone(f2), coverage: scope, episodes: structuredClone(f2.episodes.filter(e => scope.includes(e.number))),
    assets: f2.assets.filter(a => !a.usageEpisodes.length || a.usageEpisodes.some(n => scope.includes(n))).map(a => ({ ...structuredClone(a), usageEpisodes: a.usageEpisodes.filter(n => scope.includes(n)),
      ...(a.sceneRefs === undefined ? {} : { sceneRefs: a.sceneRefs.filter(ref => scope.includes(ref.episode)) }),
      variants: a.variants.filter(v => !v.episodes.length || v.episodes.some(n => scope.includes(n))).map(v => ({ ...structuredClone(v), episodes: v.episodes.filter(n => scope.includes(n)), ...(v.sceneRefs === undefined ? {} : { sceneRefs: v.sceneRefs.filter(ref => scope.includes(ref.episode)) }) })) })),
    humanChoices: choices(f2.humanChoices, scope), repairItems: structuredClone((f2.repairItems ?? []).filter(item => item.episodes.some(n => scope.includes(n)))) };
}
export function mergeDocumentF1(doc: FoundationDocument, part: F1Output, index: SourceIndex): FoundationDocument {
  const next = structuredClone(doc), checked = requireF1Output(part, index, part.coverage), outside = (next.f1?.coverage ?? []).filter(n => !checked.coverage.includes(n));
  next.overviewParts = next.overviewParts.map(p => ({ ...p, coverage: p.coverage.filter(n => !checked.coverage.includes(n)) })).filter(p => p.coverage.length);
  next.overviewParts.push({ coverage: [...checked.coverage], overview: checked.overview });
  next.overviewParts.sort((a, b) => Math.min(...a.coverage) - Math.min(...b.coverage));
  next.f1 = requireF1Output({ ...checked, coverage: union(outside, checked.coverage), overview: next.overviewParts.map(p => p.overview).join('\n\n'),
    episodes: [...(next.f1?.episodes.filter(e => outside.includes(e.number)) ?? []), ...checked.episodes].sort((a, b) => a.number - b.number),
    issues: [...(next.f1?.issues ?? []), ...checked.issues], humanChoices: mergeHumanChoices([choices(next.f1?.humanChoices, outside), checked.humanChoices ?? []]) }, index, union(outside, checked.coverage));
  next.editorialCoverage = next.editorialCoverage.filter(n => !checked.coverage.includes(n));
  return next;
}
export function mergeDocumentF2(doc: FoundationDocument, part: ProductionCatalog, index: SourceIndex): FoundationDocument {
  const next = structuredClone(doc), checked = requireProductionCatalog(part, index, part.coverage), outside = (next.f2?.coverage ?? []).filter(n => !checked.coverage.includes(n));
  next.f2 = mergeProductionCatalogs([...(outside.length && next.f2 ? [sliceF2(next.f2, outside)] : []), checked], index, union(outside, checked.coverage));
  // Only the editor's explicit repair operation clears old evidence; replacing an author slice does not.
  for (const item of doc.f2?.repairItems ?? []) {
    if (next.f2.repairItems?.some(r => r.id === item.id)) continue;
    const old = doc.f2!.assets.find(a => a.key === item.assetKey)!, oldVariant = old.variants.find(v => v.key === item.variantKey)!;
    let asset = next.f2.assets.find(a => a.key === old.key);
    if (!asset) { asset = { ...structuredClone(old), usageEpisodes: [], variants: [] }; next.f2.assets.push(asset); }
    asset.usageEpisodes = union(asset.usageEpisodes, item.assetEpisodes, item.variantEpisodes);
    const variant = asset.variants.find(v => v.key === oldVariant.key);
    if (variant) variant.episodes = union(variant.episodes, item.variantEpisodes); else asset.variants.push(structuredClone(oldVariant));
    (next.f2.repairItems ??= []).push(structuredClone(item));
  }
  next.f2 = requireProductionCatalog(next.f2, index, next.f2.coverage);
  next.editorialCoverage = next.editorialCoverage.filter(n => !checked.coverage.includes(n));
  return next;
}
export function applyDocumentEdit(doc: FoundationDocument, optimization: ProductionOptimization, index: SourceIndex): FoundationDocument {
  if (!doc.f2) throw new Error('工作稿缺少待编辑的资产目录。');
  const edit = requireProductionOptimization(optimization, index, optimization.coverage, doc.f2.assets), next = structuredClone(doc);
  const result = doc.f1
    ? applyProductionOptimizations(doc.f1, doc.f2, [edit], index, doc.overviewParts)
    : applyProductionOptimizations(null, doc.f2, [edit], index);
  next.f1 = result.f1; next.f2 = { ...result.f2, humanChoices: mergeHumanChoices([doc.f2.humanChoices ?? [], edit.humanChoices ?? []]) };
  if (edit.changes.overview !== undefined) next.overviewParts.find(p => same(p.coverage, edit.coverage))!.overview = edit.changes.overview;
  const scenePatches = new Map((next.scenePatches ?? []).map(patch => [`${patch.episode}\0${patch.sceneKey}`, structuredClone(patch)]));
  for (const patch of edit.changes.scenes ?? []) {
    const key = `${patch.episode}\0${patch.sceneKey}`, previous = scenePatches.get(key);
    scenePatches.set(key, { ...(previous ?? { episode: patch.episode, sceneKey: patch.sceneKey }), ...structuredClone(patch) });
  }
  if (scenePatches.size) next.scenePatches = [...scenePatches.values()];
  next.editorialCoverage = union(next.editorialCoverage, edit.coverage);
  next.notes = [...new Set([...next.notes, ...edit.notes])];
  const todos = new Map((next.editorialTodos ?? []).map(item => [item.id, item]));
  for (const id of edit.resolvedUnresolved ?? []) if (!todos.delete(id)) next.notes.push(`未找到可关闭的待定项 ${id}；未删除其它问题。`);
  for (const [ordinal, item] of (edit.unresolved ?? []).entries()) {
    const scoped = { ...structuredClone(item), episodes: item.episodes?.length ? [...item.episodes] : [...edit.coverage] };
    if ([...todos.values()].some(({ id: _id, ...previous }) => isDeepStrictEqual(previous, scoped))) continue;
    const id = `editor-${digest([doc.revision, edit.coverage, ordinal, scoped]).slice(0, 24)}`;
    todos.set(id, { ...scoped, id });
  }
  next.editorialTodos = [...todos.values()];
  return next;
}
function documentBody(value: unknown): FoundationDocument | null {
  const f1Shape = (f1: unknown) => isRecord(f1) && scopeList(f1.coverage) && typeof f1.overview === 'string' && Array.isArray(f1.issues) && Array.isArray(f1.episodes)
    && f1.episodes.every(e => isRecord(e) && Number.isSafeInteger(e.number) && typeof e.summary === 'string' && typeof e.context === 'string' && Array.isArray(e.sourceSelections)
      && e.sourceSelections.every(s => isRecord(s) && Number.isSafeInteger(s.episode) && Number.isSafeInteger(s.startLine) && Number.isSafeInteger(s.endLine) && typeof s.purpose === 'string'))
    && same(f1.coverage, f1.episodes.map(e => e.number as number));
  const scenePatchesShape = (patches: unknown) => patches === undefined || (Array.isArray(patches) && patches.every(patch => isRecord(patch)
    && Number.isSafeInteger(patch.episode) && typeof patch.sceneKey === 'string'
    && ['location', 'timeOfDay', 'interiorExterior', 'weather', 'timeLayer'].every(field => patch[field] === undefined || typeof patch[field] === 'string')
    && (patch.characters === undefined || (Array.isArray(patch.characters) && patch.characters.every(character => typeof character === 'string')))));
  if (!isRecord(value) || value.schema !== 'FOUNDATION_DOCUMENT_V1' || typeof value.revision !== 'string' || typeof value.sourceVersion !== 'string'
    || typeof value.sourceContextVersion !== 'string' || typeof value.settingsFingerprint !== 'string' || !isRecord(value.sourceHashes)
    || !['overviewParts', 'editorialCoverage', 'notes', 'origins', 'requiredDecisionIds'].every(k => Array.isArray(value[k]))
    || !isRecord(value.appliedDecisions) || !isRecord(value.reviewedSuggestions)
    || (value.f1 !== null && !f1Shape(value.f1))
    || (value.f2 !== null && !isProductionCatalog(value.f2))
    || (value.workflow !== undefined && value.workflow !== 'LIGHT_STAGE1_V1')
    || (value.assetMethodVersion !== undefined && typeof value.assetMethodVersion !== 'string')
    || !scenePatchesShape(value.scenePatches)) return null;
  return { ...structuredClone(value), editorialTodos: Array.isArray(value.editorialTodos) ? structuredClone(value.editorialTodos) : [] } as FoundationDocument;
}
export async function loadLatestStoredFoundationDocument(db: Pick<Db, 'sceneSnapshot'>, projectId: string): Promise<FoundationDocument | null> {
  const row = await db.sceneSnapshot.findFirst({ where: { projectId, sceneKey: 'FOUNDATION_DOCUMENT' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  return row ? documentBody(json(row.content)) : null;
}
export function migrateFoundationDocument(previous: FoundationDocument, input: Input): FoundationDocument {
  const next = createEmptyDocument(input), stable = Object.keys(next.sourceHashes).filter(n => next.sourceHashes[n] === previous.sourceHashes[n]).map(Number);
  if (previous.workflow !== undefined) next.workflow = previous.workflow;
  if (previous.assetMethodVersion !== undefined) next.assetMethodVersion = previous.assetMethodVersion;
  // Moving source scopes is not evidence that the editor adopted new style/background conditions.
  next.settingsFingerprint = previous.settingsFingerprint; next.sourceContextVersion = previous.sourceContextVersion;
  next.origins = structuredClone(previous.origins); next.notes = [...previous.notes];
  const handles = new Map<string, { sourceVersion: string; asset: NonNullable<FoundationDocument['identityHistory']>[number]['assets'][number] }>();
  for (const group of [...(previous.identityHistory ?? []), ...(previous.f2 ? [{ sourceVersion: previous.sourceVersion, assets: previous.f2.assets }] : [])]) for (const asset of group.assets) {
    const variants = new Map([...(handles.get(asset.key)?.asset.variants ?? []), ...(asset.variants ?? [])].map(v => [v.key, { key: v.key, name: v.name }]));
    handles.set(asset.key, { sourceVersion: group.sourceVersion, asset: { key: asset.key, name: asset.name, type: asset.type, aliases: [...asset.aliases], description: '', sourceRefs: [], appearances: [],
      ...(asset.role === undefined ? {} : { role: asset.role }), ...(asset.relationNote === undefined ? {} : { relationNote: asset.relationNote }), variants: [...variants.values()] } });
  }
  const history = new Map<string, NonNullable<FoundationDocument['identityHistory']>[number]>();
  for (const { sourceVersion, asset } of handles.values()) { if (!history.has(sourceVersion)) history.set(sourceVersion, { sourceVersion, assets: [] }); history.get(sourceVersion)!.assets.push(asset); }
  if (history.size) next.identityHistory = [...history.values()];
  const current = input.sourceIndex.episodes.map(e => e.number);
  next.editorialTodos = (previous.editorialTodos ?? []).flatMap(item => {
    if (!item.episodes?.length) return [structuredClone(item)];
    const episodes = item.episodes.filter(n => current.includes(n));
    return episodes.length ? [{ ...structuredClone(item), episodes }] : [];
  });
  const f1Scope = previous.f1?.coverage.filter(n => stable.includes(n) && previous.f1!.episodes.find(e => e.number === n)?.sourceSelections.every(s => stable.includes(s.episode))) ?? [];
  const brokenRepairScope = (previous.f2?.repairItems ?? []).filter(item => [...item.assetEpisodes, ...item.variantEpisodes].some(n => !current.includes(n)))
    .flatMap(item => [...item.assetEpisodes, ...item.variantEpisodes]);
  const f2Scope = previous.f2?.coverage.filter(n => stable.includes(n) && !brokenRepairScope.includes(n)) ?? [];
  const retainedPatches = (previous.scenePatches ?? []).filter(patch => stable.includes(patch.episode) && current.includes(patch.episode));
  if (retainedPatches.length) next.scenePatches = structuredClone(retainedPatches);
  if (f1Scope.length && previous.f1) {
    next.f1 = sliceF1(previous.f1, f1Scope); next.f1.issues = next.f1.issues.filter(issue => issue.sourceRefs.every(ref => stable.includes(ref.episode)));
    next.overviewParts = previous.overviewParts.map(p => ({ coverage: p.coverage.filter(n => f1Scope.includes(n)),
      overview: p.coverage.every(n => f1Scope.includes(n)) ? p.overview : '原文变动：此片概述待更新。' })).filter(p => p.coverage.length);
    next.f1.overview = next.overviewParts.map(p => p.overview).join('\n\n') || '原文变动：概述待更新。';
  }
  if (f2Scope.length && previous.f2) next.f2 = sliceF2(previous.f2, f2Scope);
  const stableOverviews = previous.overviewParts.filter(p => p.coverage.every(n => f1Scope.includes(n))).flatMap(p => p.coverage);
  next.editorialCoverage = previous.editorialCoverage.filter(n => next.f2?.coverage.includes(n) && (previous.workflow === 'LIGHT_STAGE1_V1' || f1Scope.includes(n) && stableOverviews.includes(n)));
  next.notes.push(`原文或解析归属已变动；导航待更新集：${input.sourceIndex.episodes.filter(e => !f1Scope.includes(e.number)).map(e => e.number).join(',')}；目录待更新集：${input.sourceIndex.episodes.filter(e => !next.f2?.coverage.includes(e.number)).map(e => e.number).join(',')}。旧修订保留可读。`);
  return seed(next);
}
const migrate=migrateFoundationDocument;

async function readDocument(db: Db, projectId: string, input: Input, includePrevious: boolean): Promise<{ document: FoundationDocument; previousDocument: FoundationDocument | null; sourceChanged: boolean; needsContextEdit: boolean }> {
  // Current working revisions are authoritative; old paid evidence is needed only
  // when no readable working revision exists. A malformed newest revision still
  // falls through to the earlier valid document, exactly as before.
  const documents = await db.sceneSnapshot.findMany({ where: { projectId, sceneKey: 'FOUNDATION_DOCUMENT' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const current = documents.map(r => documentBody(json(r.content))).find(Boolean);
  const empty = createEmptyDocument(input);
  if (current) {
    const sourceChanged = current.sourceVersion !== input.sourceVersion || input.interpretationAware !== false && !isDeepStrictEqual(current.sourceHashes, empty.sourceHashes);
    return { document: sourceChanged ? migrate(current, input) : current, previousDocument: sourceChanged ? current : null, sourceChanged,
      needsContextEdit: current.settingsFingerprint !== empty.settingsFingerprint };
  }
  const rows = await db.sceneSnapshot.findMany({ where: { projectId, sceneKey: { in: ['FOUNDATION_F1', 'FOUNDATION_F2', 'FOUNDATION_Q1'] } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  const runs = await db.pipelineRun.findMany({ where: { projectId, episodeId: null, stageCode: { in: ['F1', 'F2', 'Q1'] } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  const bodies = new Map(rows.map(row => [row.id, json(row.content)]));
  const evidence = (run: typeof runs[number], version = input.sourceVersion) => { const log = json(run.log); return log.schema === 'FOUNDATION_RUN_EVIDENCE_V1' && log.runId === run.id && log.stageCode === run.stageCode && log.sourceVersion === version ? log : null; };
  const valid = (row: typeof rows[number], stage: 'F1' | 'F2' | 'Q1') => {
    const body = bodies.get(row.id)!, run = runs.find(r => r.id === body.runId && r.stageCode === stage);
    return body.schema === 'FOUNDATION_CANDIDATE_V1' && body.stageCode === stage && body.sourceVersion === input.sourceVersion && Array.isArray(body.scope) && run && evidence(run) ? { body, run } : null;
  };
  const callInput = (call: unknown) => {
    if (!isRecord(call) || !Array.isArray(call.scope) || !isRecord(call.input) || !isRecord(call.response) || !isRecord(call.response.data)
      || call.sourceVersion !== input.sourceVersion || !same(call.scope as number[], call.input.scope as number[])) return null;
    const marker = typeof call.taskPrompt === 'string' ? call.taskPrompt.lastIndexOf('INPUT_JSON:\n') : -1;
    if (marker < 0 || !isDeepStrictEqual(json((call.taskPrompt as string).slice(marker + 12)), call.input)
      || !isDeepStrictEqual(call.input.source, buildNumberedSource(input.sourceIndex, call.scope as number[]))) return null;
    return { call, request: call.input, data: call.response.data, scope: call.scope as number[] };
  };
  let doc = empty;
  let acceptedQ1Calls: unknown[] = [];
  const origin = (stage: 'F1' | 'F2' | 'Q1', runId: string, scope: number[], snapshotId?: string) => doc.origins.push({ stage, runId, scope: [...scope], ...(snapshotId ? { snapshotId } : {}), kind: snapshotId ? 'snapshot' : 'response' });
  const chosen: { f1?: string; f2?: string } = {};
  for (const stage of ['F1', 'F2'] as const) for (const row of rows.filter(r => r.sceneKey === `FOUNDATION_${stage}`)) {
    const entry = valid(row, stage); if (!entry) continue;
    const { body, run } = entry;
    if (stage === 'F2') {
      const upstream = isRecord(body.upstreamSnapshotIds) && rows.find(r => r.id === (body.upstreamSnapshotIds as Record<string, unknown>).f1);
      if (!upstream || !valid(upstream, 'F1')) continue;
    }
    const parsed = attempt(() => stage === 'F1' ? requireF1Output(body.output, input.sourceIndex, body.scope as number[]) : isProductionCatalog(body.output) ? requireProductionCatalog(body.output, input.sourceIndex, body.scope as number[]) : null);
    if (!parsed) continue;
    const missing = parsed.coverage.filter(n => !(stage === 'F1' ? doc.f1 : doc.f2)?.coverage.includes(n));
    if (!missing.length) continue;
    if (stage === 'F1') {
      doc = mergeDocumentF1(doc, sliceF1(parsed as F1Output, missing), input.sourceIndex); chosen.f1 ??= row.id;
      const calls = evidence(run)?.calls;
      const parts = Array.isArray(calls) ? calls.map(call => attempt(() => { const bound = callInput(call); return bound && requireF1Output(bound.data, input.sourceIndex, bound.scope); })).filter((p): p is F1Output => !!p) : [];
      if (parts.length && same(parts.flatMap(p => p.coverage), missing) && isDeepStrictEqual(parts.flatMap(p => p.episodes).sort((a, b) => a.number - b.number), (parsed as F1Output).episodes)
        && parts.map(p => p.overview).join('\n\n') === (parsed as F1Output).overview) doc.overviewParts = parts.map(p => ({ coverage: p.coverage, overview: p.overview }));
    } else { doc = mergeDocumentF2(doc, sliceF2(parsed as ProductionCatalog, missing), input.sourceIndex); chosen.f2 ??= row.id; }
    origin(stage, run.id, missing, row.id);
  }
  // Saved responses are received under their actual recorded source/scope/registry, never re-signed as a current-method run.
  for (const run of runs.filter(r => r.stageCode !== 'Q1')) {
    const log = evidence(run); if (!log || !Array.isArray(log.calls) || log.deliveryTaskId || json(run.inputSummary).deliveryTaskId) continue;
    for (const raw of log.calls) {
      const bound = attempt(() => callInput(raw)); if (!bound) continue;
      const missing = bound.scope.filter(n => !(run.stageCode === 'F1' ? doc.f1 : doc.f2)?.coverage.includes(n));
      if (!missing.length) continue;
      const accepted = attempt(() => {
        if (run.stageCode === 'F1') return requireF1Output(bound.data, input.sourceIndex, bound.scope);
        if (!Array.isArray(bound.request.registry) || bound.data.format !== 'ASSET_CATALOG_V2') return null;
        const known = [...bound.request.registry, ...(Array.isArray(bound.request.previousAssetKeys) ? bound.request.previousAssetKeys : [])];
        if (!known.every(a => isRecord(a) && typeof a.key === 'string' && typeof a.name === 'string' && typeof a.type === 'string' && Array.isArray(a.aliases))) return null;
        return requireProductionCatalogAuthor(bound.data, input.sourceIndex, bound.scope, known as ProductionCatalog['assets']);
      });
      if (!accepted) continue;
      doc = run.stageCode === 'F1' ? mergeDocumentF1(doc, sliceF1(accepted as F1Output, missing), input.sourceIndex) : mergeDocumentF2(doc, sliceF2(accepted as ProductionCatalog, missing), input.sourceIndex);
      origin(run.stageCode as 'F1' | 'F2', run.id, missing);
    }
  }
  for (const row of rows.filter(r => r.sceneKey === 'FOUNDATION_Q1')) {
    const entry = valid(row, 'Q1'); if (!entry || !isRecord(entry.body.finalOutput) || !isRecord(entry.body.upstreamSnapshotIds)) continue;
    if (entry.body.upstreamSnapshotIds.f1 !== chosen.f1 || entry.body.upstreamSnapshotIds.f2 !== chosen.f2) continue;
    if (!isProductionCatalog(entry.body.finalOutput.f2)) continue;
    const final = attempt(() => ({ f1: requireF1Output((entry.body.finalOutput as Record<string, unknown>).f1, input.sourceIndex, entry.body.scope as number[]), f2: requireProductionCatalog((entry.body.finalOutput as Record<string, unknown>).f2, input.sourceIndex, entry.body.scope as number[]) }));
    if (!final) continue;
    doc.f1 = final.f1; doc.f2 = final.f2;
    const output = isRecord(entry.body.output) ? entry.body.output : {}, edits = Array.isArray(output.appliedChanges) ? output.appliedChanges : [];
    for (const edit of edits) if (isRecord(edit) && Array.isArray(edit.coverage) && isRecord(edit.changes) && typeof edit.changes.overview === 'string') {
      const part = doc.overviewParts.find(p => same(p.coverage, edit.coverage as number[])); if (part) part.overview = edit.changes.overview;
    }
    if (doc.overviewParts.map(p => p.overview).join('\n\n') !== final.f1.overview) doc.overviewParts = [{ coverage: final.f1.coverage, overview: final.f1.overview }];
    doc.editorialCoverage = [...final.f1.coverage]; doc.notes = Array.isArray(output.notes) ? output.notes.filter((n): n is string => typeof n === 'string') : [];
    doc.editorialTodos = Array.isArray(output.unresolved) ? output.unresolved.filter((item): item is Unresolved & { id?: string } => isRecord(item) && typeof item.note === 'string'
      && (item.episodes === undefined || (Array.isArray(item.episodes) && item.episodes.every(n => final.f1.coverage.includes(n as number)))))
      .map((item, i) => ({ ...structuredClone(item), id: item.id || `legacy-${digest([row.id, i, item]).slice(0, 24)}` })) : [];
    if (output.verdict === 'REPAIR' && !doc.editorialTodos.length && !doc.f2.repairItems?.length && !(Array.isArray(output.humanChoices) && output.humanChoices.length))
      doc.editorialTodos.push({ id: `legacy-review-${row.id}`, episodes: [...final.f1.coverage], note: typeof output.summary === 'string' && output.summary ? output.summary : '旧终编仍标记待修，需继续核对。' });
    origin('Q1', entry.run.id, final.f1.coverage, row.id);
    const calls = evidence(entry.run)?.calls; acceptedQ1Calls = Array.isArray(calls) ? calls : [];
    break;
  }
  // Only a bound old editor prefix may change imported candidates. New delivery attempts have their own CAS replay owner.
  if (doc.f1 && doc.f2 && chosen.f1 && chosen.f2 && !doc.origins.some(o => o.stage === 'Q1')) for (const run of [...runs].reverse().filter(r => r.stageCode === 'Q1')) {
    const log = evidence(run), summary = json(run.inputSummary);
    if (!log || log.deliveryTaskId || summary.deliveryTaskId || !Array.isArray(log.calls) || !isRecord(log.upstreamSnapshotIds)
      || log.upstreamSnapshotIds.f1 !== chosen.f1 || log.upstreamSnapshotIds.f2 !== chosen.f2
      || (summary.sourceVersion !== undefined && summary.sourceVersion !== input.sourceVersion)
      || (isRecord(summary.upstreamSnapshotIds) && (summary.upstreamSnapshotIds.f1 !== chosen.f1 || summary.upstreamSnapshotIds.f2 !== chosen.f2))) continue;
    for (const [i, raw] of log.calls.entries()) {
      const received = attempt(() => {
        const bound = callInput(raw), part = doc.overviewParts[i];
        if (!bound || !part || bound.call.sequence !== i + 1 || !isDeepStrictEqual(bound.scope, part.coverage)) return null;
        const navigation = (e: F1Output['episodes'][number]) => ({ number: e.number, summary: e.summary, ...(e.context ? { context: e.context } : {}) });
        const local = projectProductionCatalog(doc.f2!, bound.scope), localKeys = new Set(local.assets.map(a => a.key));
        const expected = { f1: { overview: part.overview, episodes: doc.f1!.episodes.filter(e => bound.scope.includes(e.number)).map(navigation) }, f2: local };
        const registry = doc.f2!.assets.filter(a => !localKeys.has(a.key)).map(a => ({ key: a.key, name: a.name, type: a.type, aliases: a.aliases,
          ...(a.role === undefined ? {} : { role: a.role }), ...(a.relationNote === undefined ? {} : { relationNote: a.relationNote }), variants: a.variants.map(({ key, name }) => ({ key, name })) }));
        const crossBatchVariants = doc.f2!.assets.filter(a => localKeys.has(a.key)).flatMap(a => {
          const localNames = new Set(local.assets.find(item => item.key === a.key)!.variants.map(v => v.name));
          const variants = a.variants.filter(v => !localNames.has(v.name)).map(({ key, name }) => ({ key, name }));
          return variants.length ? [{ assetKey: a.key, variants }] : [];
        });
        const preceding = doc.f1!.episodes.filter(e => e.number < Math.min(...bound.scope)).at(-1);
        if (!isDeepStrictEqual(bound.request.candidates, expected) || !isDeepStrictEqual(bound.request.registry, registry)
          || !isDeepStrictEqual(bound.request.crossBatchVariants ?? [], crossBatchVariants) || !isDeepStrictEqual(bound.request.precedingContext, preceding ? navigation(preceding) : undefined)
          || !isDeepStrictEqual(bound.request.pendingChoices ?? [], doc.editorialTodos)) return null;
        const edit = requireProductionOptimization(bound.data, input.sourceIndex, bound.scope), next = applyDocumentEdit(doc, edit, input.sourceIndex);
        const pending = new Map(doc.editorialTodos.map(item => [item.id, structuredClone(item)]));
        for (const id of edit.resolvedUnresolved ?? []) pending.delete(id);
        for (const [ordinal, item] of (edit.unresolved ?? []).entries()) { const id = `q${i + 1}-${ordinal + 1}`; pending.set(id, { ...structuredClone(item), id }); }
        next.editorialTodos = [...pending.values()];
        return { next, edit, scope: bound.scope };
      });
      if (!received) break;
      doc = received.next; origin('Q1', run.id, received.scope); acceptedQ1Calls.push(raw);
    }
    if (acceptedQ1Calls.length) break;
  }
  for (const raw of acceptedQ1Calls) {
    const bound = attempt(() => callInput(raw)); if (!bound) continue;
    const edit = attempt(() => requireProductionOptimization(bound.data, input.sourceIndex, bound.scope)); if (!edit) continue;
    for (const [i, choice] of (edit.humanChoices ?? []).entries()) {
      const id = `legacy-choice-${digest([doc.origins.find(o => o.stage === 'Q1')?.runId, bound.call.sequence, i, choice]).slice(0, 24)}`;
      if (!doc.editorialTodos.some(item => item.id === id)) doc.editorialTodos.push({ id, episodes: choice.episodes.length ? choice.episodes : [...bound.scope], note: `旧终编保留的待核选择：${choice.question}；${choice.reason}；备选：${choice.options.join(' / ')}` });
    }
    if (!edit.appliedDecisions?.length || !Array.isArray(bound.request.confirmedDecisions)) continue;
    const confirmed = (await loadFoundationChoices(db as Prisma.TransactionClient, projectId, input.sourceVersion)).confirmed;
    for (const decision of confirmed) {
      const receipt = edit.appliedDecisions.find(item => item.id === decision.id), supplied = bound.request.confirmedDecisions.find(c => isRecord(c) && c.id === decision.id && c.revision === decision.revision
        && c.question === decision.question && c.userAnswer === decision.userAnswer && Array.isArray(c.episodes) && same(c.episodes as number[], decision.episodes));
      if (!receipt || !supplied) continue;
      const expected = decision.episodes.length ? decision.episodes : input.sourceIndex.episodes.map(e => e.number), records = doc.decisionCoverage ??= {};
      records[decision.id] = { revision: decision.revision, episodes: union(records[decision.id]?.episodes ?? [], bound.scope.filter(n => expected.includes(n) && doc.editorialCoverage.includes(n))), notes: [...new Set([...(records[decision.id]?.notes ?? []), receipt.note])] };
      if (expected.every(n => records[decision.id].episodes.includes(n))) doc.appliedDecisions[decision.id] = decision.revision;
    }
  }
  if (includePrevious && !doc.f1 && !doc.f2) {
    const foreign = rows.find(row => {
      const b = bodies.get(row.id)!, run = runs.find(r => r.id === b.runId && `FOUNDATION_${r.stageCode}` === row.sceneKey);
      return b.schema === 'FOUNDATION_CANDIDATE_V1' && typeof b.sourceVersion === 'string' && b.sourceVersion !== input.sourceVersion && run && evidence(run, b.sourceVersion);
    });
    if (foreign) {
      const version = bodies.get(foreign.id)!.sourceVersion as string;
      const sourceIndex = attempt(() => {
        const episodes = new Map<number, { number: number; title: string | null; content: string }>();
        for (const run of runs) for (const call of (evidence(run, version)?.calls as unknown[] ?? [])) {
          if (!isRecord(call) || !isRecord(call.input) || !isRecord(call.input.source) || call.sourceVersion !== version || call.input.source.version !== version) continue;
          const marker = typeof call.taskPrompt === 'string' ? call.taskPrompt.lastIndexOf('INPUT_JSON:\n') : -1;
          if (marker < 0 || !isDeepStrictEqual(json((call.taskPrompt as string).slice(marker + 12)), call.input) || !Array.isArray(call.input.source.episodes)) continue;
          for (const raw of call.input.source.episodes) {
            if (!isRecord(raw) || !Number.isSafeInteger(raw.number) || !Array.isArray(raw.lines) || raw.lineCount !== raw.lines.length
              || !raw.lines.every((line, i) => Array.isArray(line) && line[0] === i + 1 && typeof line[1] === 'string')) continue;
            const episode = { number: raw.number as number, title: raw.title as string | null, content: raw.lines.map(line => line[1]).join('') };
            if (episodes.has(episode.number) && !isDeepStrictEqual(episodes.get(episode.number), episode)) throw new Error('旧原文证据冲突');
            episodes.set(episode.number, episode);
          }
        }
        const index = buildSourceIndex([...episodes.values()]);
        if (index.version !== version) throw new Error('不能复原旧原文完整字节');
        return index;
      });
      let previous: FoundationDocument | null = sourceIndex ? (await readDocument(db, projectId, { ...input, sourceVersion: version, sourceIndex }, false)).document : null;
      if (!previous?.f1 && !previous?.f2) {
        previous = { ...createEmptyDocument(input), sourceVersion: version, sourceHashes: {}, sourceContextVersion: 'legacy-unknown', settingsFingerprint: 'legacy-unknown', notes: ['旧源原文字节无法核验：仅展示历史工作稿，不作为当前源资料复用。'] };
        let f1Id: string | undefined;
        for (const row of rows.filter(r => r.sceneKey === 'FOUNDATION_F1' || r.sceneKey === 'FOUNDATION_F2')) {
          const b = bodies.get(row.id)!, stage = row.sceneKey === 'FOUNDATION_F1' ? 'F1' : 'F2', run = runs.find(r => r.id === b.runId && r.stageCode === stage);
          if (b.schema !== 'FOUNDATION_CANDIDATE_V1' || b.sourceVersion !== version || !run || !evidence(run, version)) continue;
          let accepted = false;
          if (stage === 'F1' && !previous.f1 && documentBody({ ...previous, f1: b.output })) { previous.f1 = structuredClone(b.output) as F1Output; f1Id = row.id; accepted = true; }
          const upstreamId = isRecord(b.upstreamSnapshotIds) ? b.upstreamSnapshotIds.f1 : undefined;
          if (stage === 'F2' && !previous.f2 && isProductionCatalog(b.output) && rows.some(r => r.id === upstreamId && r.sceneKey === 'FOUNDATION_F1' && bodies.get(r.id)?.sourceVersion === version)) { previous.f2 = structuredClone(b.output); accepted = true; }
          if (accepted) previous.origins.push({ stage, runId: run.id, snapshotId: row.id, scope: stage === 'F1' ? previous.f1!.coverage : previous.f2!.coverage, kind: 'snapshot' });
        }
        if (previous.f1) previous.overviewParts = [{ coverage: previous.f1.coverage, overview: previous.f1.overview }];
        if (f1Id || previous.f2) previous = seed(previous);
      }
      if (previous.f1 || previous.f2) return { document: migrate(previous, input), previousDocument: previous, sourceChanged: true, needsContextEdit: previous.settingsFingerprint !== empty.settingsFingerprint };
    }
  }
  const contextOrigins = doc.origins.map(o => ({ ...o, scope: o.stage === 'Q1' ? o.scope : o.scope.filter(n => !doc.editorialCoverage.includes(n)) })).filter(o => o.scope.length);
  const contexts = contextOrigins.map(o => {
    const run = runs.find(r => r.id === o.runId), calls = run && evidence(run)?.calls;
    const bound = Array.isArray(calls) ? calls.map(raw => attempt(() => callInput(raw))).filter(p => p && p.scope.some(n => o.scope.includes(n))) : [];
    return { complete: o.scope.every(n => bound.some(p => p?.scope.includes(n))), inputs: bound.map(p => ({ project: p!.request.project, background: p!.request.backgroundSources ?? [] })) };
  });
  const needsContextEdit = contexts.some(c => !c.complete || c.inputs.some(p => !isRecord(p.project) || p.project.style !== input.projectConditions.style
    || p.project.aspectRatio !== input.projectConditions.aspectRatio || !isDeepStrictEqual(p.background, input.sourceContext.background)));
  if (needsContextEdit) doc.settingsFingerprint = `legacy-${digest(contexts)}`;
  return { document: seed(doc), previousDocument: null, sourceChanged: false, needsContextEdit };
}
export function loadFoundationDocument(db: Db, projectId: string, input: Input) { return readDocument(db, projectId, input, true); }

export async function saveFoundationDocument(db: PrismaClient, projectId: string, expectedRevision: string, document: FoundationDocument, reason: string, beforeSave?: (tx: Prisma.TransactionClient) => Promise<void>,afterSave?: (tx:Prisma.TransactionClient,saved:FoundationDocument)=>Promise<void>): Promise<FoundationDocument> {
  return db.$transaction(async tx => {
    await beforeSave?.(tx);
    const project = await tx.project.findUnique({ where: { id: projectId }, include: { episodes: { orderBy: { number: 'asc' } } } });
    if (!project) throw new Error('没有找到工作稿所属项目。');
    const sourceIndex = buildSourceIndex(project.episodes), sourceContext = await loadFoundationSourceContext(projectId, tx);
    const resolved = await (await import('./script-resolution-service')).readCurrentResolvedPlans(projectId, project.episodes, tx);
    const input = { sourceIndex, sourceVersion: sourceIndex.version, sourceContext,
      scriptInterpretationVersions: Object.fromEntries([...resolved].map(([number, value]) => [number, value.hash])),
      projectConditions: { title: project.title, style: project.style ?? '未选择', aspectRatio: project.aspectRatio, unitMode: '', ruleVersion: project.ruleVersion } };
    if (document.sourceVersion !== input.sourceVersion || !isDeepStrictEqual(document.sourceHashes, createEmptyDocument(input).sourceHashes)) throw new Error('原文 source 或解析归属已变动，拒绝保存旧源工作稿。');
    const head = await loadFoundationDocument(tx, projectId, input);
    if (head.document.revision !== expectedRevision) throw new Error('工作稿 revision 已改变，请读取最新修订。');
    if (document.f1) requireF1Output(document.f1, sourceIndex, document.f1.coverage);
    if (document.f2) requireProductionCatalog(document.f2, sourceIndex, document.f2.coverage);
    const last = await tx.sceneSnapshot.findFirst({ where: { projectId, sceneKey: 'FOUNDATION_DOCUMENT' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
    const saved = { ...structuredClone(document), revision: randomUUID() };
    // The primary key is a unique CAS edge: even concurrent first imports can create only one successor.
    await tx.sceneSnapshot.create({ data: { id: `foundation-document-${digest([projectId, expectedRevision])}`, projectId, sceneKey: 'FOUNDATION_DOCUMENT',
      title: '基础资料工作稿', content: JSON.stringify(saved), metadata: JSON.stringify({ schema: 'FOUNDATION_DOCUMENT_REVISION_V1', expectedRevision, reason }),
      createdAt: new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1)) } });
    await afterSave?.(tx,saved);
    return saved;
  }, { maxWait: 10_000, timeout: 20_000 });
}
