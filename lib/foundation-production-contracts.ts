import { readApplicationScope, readChoiceEvidence, scopeEpisodes, type ApplicationScope, type ChoiceEvidenceRef } from './foundation-application-scope';
import { buildFoundationFragments, fragmentsComplete, type FoundationFragment } from './foundation-fragments';
/** Compact production transport. Empty legacy fields are compatibility only, never invented evidence. */
import { assertSourceVersion, FoundationContractError, hashFoundationPrompt, isRecord, type F1Output, type F2Asset, type F2Output, type Q1Output, type SourceIndex, type FoundationIssue } from './project-foundation-contracts';
import { readHumanChoices, mergeHumanChoices, type HumanChoice } from './foundation-human-choices';
import type { SceneSplitPlan } from './source-parser';
import { collectPhysicalEvidenceIssues } from './foundation-physical-evidence';

export const PRODUCTION_CATALOG_FORMAT = 'ASSET_CATALOG_V2' as const;
export const PRODUCTION_OPTIMIZATION_FORMAT = 'FOUNDATION_OPTIMIZATION_V2' as const;
export type Preparation = { mode: 'REFERENCE' | 'DERIVE' | 'INLINE' | 'AUDIO' | 'UNRESOLVED'; fromKey?: string; note?: string };
export type Unresolved = { applicationScope?: ApplicationScope; evidenceRefs?: ChoiceEvidenceRef[]; receivingUses?: string[]; key?: string; episodes?: number[]; note: string; owner?: 'Q1' | 'PROGRAM' | 'STAGE2' };
/** Scene existence is checked against the controller's actual (including newly split) scene set. */
export function assertUnresolvedSourceScopes(output: { unresolved?: Unresolved[] }, index: SourceIndex, allowed: readonly number[], scenes?: readonly {episode:number;sceneKey:string}[]) {
  for (const [i,item] of (output.unresolved ?? []).entries()) {
    const at = `unresolved.${i}`, scope = readApplicationScope(item.applicationScope,item.episodes ?? []);
    if (scopeEpisodes(scope).some(n=>!allowed.includes(n) || !index.episodes.some(e=>e.number===n))) fail(`${at}.applicationScope`,'待办范围须属于本批真实来源');
    if (scope.kind === 'SCENES' && scenes) for (const ref of scope.scenes) if (!scenes.some(s=>s.episode===ref.episode&&s.sceneKey===ref.sceneKey)) fail(`${at}.applicationScope`,'待办场次不存在，不能交接到虚构场次');
    for (const ref of readChoiceEvidence(item.evidenceRefs,index.version)) {
      const episode=index.episodes.find(e=>e.number===ref.episode);
      if (!episode || !allowed.includes(ref.episode) || ref.endLine !== undefined && (ref.startLine === undefined || ref.endLine>episode.lineCount)) fail(`${at}.evidenceRefs`,'证据须指向本批真实原文行号');
      if (ref.nodeId) fail(`${at}.evidenceRefs`,'未核实的节点编号不能作为证据，请使用实际场号与行号');
      if (ref.sceneKey && scenes && !scenes.some(s=>s.episode===ref.episode&&s.sceneKey===ref.sceneKey)) fail(`${at}.evidenceRefs`,'证据场次不存在');
    }
  }
}
/** Legacy prose can stop a paid retry, never authorize a source mutation or close an issue. */
export function unresolvedOwner(item: Unresolved): NonNullable<Unresolved['owner']> {
  if (item.owner) return item.owner;
  return /拆场|拆分场次|独立子场|新增.{0,8}场次/.test(item.note)
    || /(?:sceneKey|timeOfDay|单值|现有场次|字段权限)/.test(item.note) && /不能|无法|须拆|需拆/.test(item.note) ? 'PROGRAM' : 'Q1';
}
/** Compatibility for saved notes that explicitly named episode numbers but omitted the field. */
export function unresolvedEpisodeScope(item: Unresolved): number[] {
  if (item.episodes?.length) return [...item.episodes];
  return [...new Set([...item.note.matchAll(/第(\d+(?:[、,，]\d+)*)集/g)].flatMap(match => match[1].split(/[、,，]/).map(Number)))].sort((a, b) => a - b);
}
export type CatalogRepairItem = { id: string; code: 'VARIANT_SCOPE'; assetKey: string; variantKey: string; episodes: number[]; assetEpisodes: number[]; variantEpisodes: number[] };
export type SceneAssetRef = { episode: number; sceneKey: string };
export type CatalogAssetWire = { key?: string; name: string; type: F2Asset['type']; role?: string; relationNote?: string; aliases?: string[]; episodes: number[]; sceneRefs?: SceneAssetRef[]; preparation?: Preparation; variants?: { name: string; episodes: number[]; sceneRefs?: SceneAssetRef[]; note?: string; preparation?: Preparation }[] };
export type CatalogWire = { format: 'ASSET_CATALOG_V1' | 'ASSET_CATALOG_V2'; coverage: number[]; assets: CatalogAssetWire[]; humanChoices?: HumanChoice[]; repairItems?: CatalogRepairItem[] };
/** Program-supplied keys are read-only references, not author-assigned variant identities. */
export type CatalogMaterialCandidate = {
  key: string; baseKey: string; baseName?: string; name: string; type: F2Asset['type']; kind: 'BASE' | 'VARIANT'; episodes: number[];
  use: 'CANDIDATE_ONLY'; reason: 'UNLOCATED_USAGE'; preparation?: Preparation; note?: string;
  [field: string]: unknown;
};
export type CatalogProjection = Omit<CatalogWire, 'assets'> & { assets: (Omit<CatalogAssetWire, 'variants'> & { variants: (NonNullable<CatalogAssetWire['variants']>[number] & { readonly key?: string })[] })[]; materialCandidates?: CatalogMaterialCandidate[] };
export type ProductionVariant = { key: string; name: string; episodes: number[]; sceneRefs?: SceneAssetRef[]; note: string; preparation?: Preparation };
export interface ProductionAsset extends F2Asset { role?: string; relationNote?: string; usageEpisodes: number[]; sceneRefs?: SceneAssetRef[]; variants: ProductionVariant[]; preparation?: Preparation }
export interface ProductionCatalog extends F2Output { format: CatalogWire['format']; assets: ProductionAsset[]; repairItems?: CatalogRepairItem[] }
export type SceneFieldPatch = { episode: number; sceneKey: string; location?: string; timeOfDay?: string; interiorExterior?: string; timeLayer?: string; weather?: string; characters?: string[] };
export type Q1Wire = { format: 'FOUNDATION_OPTIMIZATION_V1' | 'FOUNDATION_OPTIMIZATION_V2'; coverage: number[]; summary?: string; changes: { episodes?: { number: number; summary: string; context?: string }[]; assets?: CatalogAssetWire[]; removeAssetKeys?: string[]; mergeAssets?: { keepKey: string; removeKeys: string[] }[]; overview?: string; scenes?: SceneFieldPatch[]; sceneSplits?: SceneSplitPlan[] }; notes?: string[]; unresolved?: Unresolved[]; resolvedUnresolved?: string[]; resolvedCatalogIssues?: string[] };
export type EditorialReceipt = { id: string; note: string };
export type ProductionOptimization = Q1Output & { format: Q1Wire['format']; changes: Q1Wire['changes']; notes: string[]; unresolved?: Unresolved[]; resolvedUnresolved?: string[]; resolvedCatalogIssues?: string[]; resolvedSuggestions?: EditorialReceipt[]; appliedDecisions?: EditorialReceipt[]; issues: [] };

function fail(coordinate: string, problem: string): never {
  throw new FoundationContractError(`${coordinate}: ${problem}`, [{ severity: 'BLOCKER', owner: 'PROGRAM', coordinate, problem, sourceRefs: [] }]);
}
function record(value: unknown, at: string) { if (!isRecord(value)) fail(at, '须为对象'); return value; }
function humanChoices(value: unknown, scope: readonly number[]) {
  try { const choices = readHumanChoices(value, scope); return choices.length ? { humanChoices: choices } : {}; }
  catch (error) { fail('humanChoices', error instanceof Error ? error.message : '无效的人工选择'); }
}
function list(value: unknown, at: string): unknown[] { if (!Array.isArray(value)) fail(at, '须为数组'); return value; }
function string(value: unknown, at: string, empty = false): string { if (typeof value !== 'string' || (!empty && !value.trim())) fail(at, '须为文本'); return value.trim(); }
function unique<T>(items: T[], at: string): T[] { if (new Set(items).size !== items.length) fail(at, '不得重复'); return items; }
function strings(value: unknown, at: string) { return [...new Set(list(value, at).map((item, i) => string(item, `${at}.${i}`)))]; }
function numbers(value: unknown, at: string, normalizeSet = false): number[] {
  const result = list(value, at).map((item, i) => {
    const n = typeof item === 'string' && /^(0|[1-9]\d*)$/.test(item) ? Number(item) : item;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) fail(`${at}.${i}`, '须为非负安全整数');
    return n;
  });
  return (normalizeSet ? [...new Set(result)] : unique(result, at)).sort((a, b) => a - b);
}
function same(a: readonly number[], b: readonly number[]) { return a.length === b.length && a.every(n => b.includes(n)); }
function coverage(value: unknown, index: SourceIndex, scope: readonly number[], normalizeSet = false) {
  assertSourceVersion(index, index.version);
  if (!Array.isArray(scope) || !scope.length || new Set(scope).size !== scope.length || scope.some(n => !Number.isSafeInteger(n) || !index.episodes.some(e => e.number === n))) fail('scope', '须为索引内不重复的集号');
  const result = numbers(value, 'coverage', normalizeSet);
  if (!same(result, scope)) fail('coverage', '须精确匹配本次范围');
  return result;
}
function scopedNumbers(value: unknown, scope: readonly number[], at: string, allowEmpty = false) {
  const result = numbers(value, at, true);
  if ((!allowEmpty && !result.length) || result.some(n => !scope.includes(n))) fail(at, '须包含本范围内实际使用集号');
  return result;
}
const types = ['CH', 'GROUP', 'BEAST', 'LOC', 'PROP'] as const;
const assetKey = (type: string, name: string) => `${type}_${hashFoundationPrompt(`${type}\0${name}`).slice(0, 16)}`;
const variantKey = (key: string, name: string) => `${key}_V_${hashFoundationPrompt(name).slice(0, 16)}`;
function readPreparation(value: unknown, at: string): Preparation {
  const raw = record(value, at);
  if (!['REFERENCE', 'DERIVE', 'INLINE', 'AUDIO', 'UNRESOLVED'].includes(raw.mode as string)) fail(`${at}.mode`, '无效制作方式');
  return { mode: raw.mode as Preparation['mode'], ...(raw.fromKey == null ? {} : { fromKey: string(raw.fromKey, `${at}.fromKey`) }), ...(raw.note == null ? {} : { note: string(raw.note, `${at}.note`, true) }) };
}
function readSceneRefs(value: unknown, scope: readonly number[], usageEpisodes: readonly number[], at: string): SceneAssetRef[] {
  const refs = list(value, at).map((item, i) => {
    const raw = record(item, `${at}.${i}`);
    if (Object.keys(raw).some(key => !['episode', 'sceneKey'].includes(key))) fail(`${at}.${i}`, '包含未知场景定位字段');
    const [episode] = scopedNumbers([raw.episode], scope, `${at}.${i}.episode`);
    if (!usageEpisodes.includes(episode)) fail(`${at}.${i}.episode`, '须属于该资产或变体的使用集');
    return { episode, sceneKey: string(raw.sceneKey, `${at}.${i}.sceneKey`) };
  });
  unique(refs.map(ref => `${ref.episode}\0${ref.sceneKey}`), at);
  return refs;
}
function readAsset(value: unknown, scope: readonly number[], at: string, v2 = false): CatalogAssetWire {
  const raw = record(value, at), name = string(raw.name, `${at}.name`);
  const spelling = v2 && typeof raw.type === 'string' ? raw.type.trim().toUpperCase() : raw.type;
  const type = v2 && spelling === 'CHARACTER' ? 'CH' : v2 && spelling === 'LOCATION' ? 'LOC' : spelling;
  if (!types.includes(type as F2Asset['type'])) fail(`${at}.type`, '无效资产类型');
  const episodes = scopedNumbers(raw.episodes, scope, `${at}.episodes`, true);
  const aliases = raw.aliases == null ? [] : strings(raw.aliases, `${at}.aliases`);
  const variants = raw.variants == null ? [] : list(raw.variants, `${at}.variants`).map((value, i) => {
    const atVariant = `${at}.variants.${i}`, raw = record(value, atVariant);
    const variantEpisodes = scopedNumbers(raw.episodes, v2 ? scope : episodes, `${atVariant}.episodes`, true);
    return { name: string(raw.name, `${atVariant}.name`), episodes: variantEpisodes, ...(raw.sceneRefs == null ? {} : { sceneRefs: readSceneRefs(raw.sceneRefs, scope, variantEpisodes, `${atVariant}.sceneRefs`) }), note: raw.note == null ? '' : string(raw.note, `${atVariant}.note`, true), ...(v2 && raw.preparation !== undefined ? { preparation: readPreparation(raw.preparation, `${atVariant}.preparation`) } : {}) };
  });
  unique(variants.map(v => v.name), `${at}.variants`);
  return { ...(raw.key == null ? {} : { key: string(raw.key, `${at}.key`) }), name, type: type as F2Asset['type'], ...(v2 ? readClassification(raw, at) : {}), ...(raw.aliases == null ? {} : { aliases }), episodes, ...(raw.sceneRefs == null ? {} : { sceneRefs: readSceneRefs(raw.sceneRefs, scope, episodes, `${at}.sceneRefs`) }), ...(raw.variants == null ? {} : { variants }), ...(v2 && raw.preparation !== undefined ? { preparation: readPreparation(raw.preparation, `${at}.preparation`) } : {}) };
}
function readClassification(raw: { role?: unknown; relationNote?: unknown }, at: string) {
  return { ...(raw.role == null ? {} : { role: string(raw.role, `${at}.role`, true) }), ...(raw.relationNote == null ? {} : { relationNote: string(raw.relationNote, `${at}.relationNote`, true) }) };
}
function readScenePatch(value: unknown, scope: readonly number[], at: string): SceneFieldPatch {
  const raw = record(value, at), allowed = ['episode', 'sceneKey', 'location', 'timeOfDay', 'interiorExterior', 'timeLayer', 'weather', 'characters'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) fail(at, '包含未知场景字段');
  const [episode] = scopedNumbers([raw.episode], scope, `${at}.episode`);
  const sceneKey = string(raw.sceneKey, `${at}.sceneKey`);
  const scalar = (field: 'location' | 'timeOfDay' | 'interiorExterior' | 'timeLayer' | 'weather') => raw[field] == null ? {} : { [field]: string(raw[field], `${at}.${field}`, true) };
  const characters = raw.characters == null ? {} : { characters: strings(raw.characters, `${at}.characters`) };
  const patch = { episode, sceneKey, ...scalar('location'), ...scalar('timeOfDay'), ...scalar('interiorExterior'), ...scalar('timeLayer'), ...scalar('weather'), ...characters };
  if (Object.keys(patch).length === 2) fail(at, '至少须修改一个场景字段');
  return patch;
}
function findPriorAsset<T extends F2Asset>(asset: CatalogAssetWire, priorAssets: readonly T[], at: string): T | undefined {
  if (asset.key !== undefined) return priorAssets.find(p => p.key === asset.key);
  const names = new Set([asset.name, ...(asset.aliases ?? [])]);
  const matches = priorAssets.filter(p => p.type === asset.type && [p.name, ...p.aliases].some(n => names.has(n)));
  if (matches.length > 1) fail(at, '同名或别名对应多个身份，须显式指定key');
  return matches[0];
}
function canonical(asset: CatalogAssetWire, key: string, name = asset.name, aliases = asset.aliases ?? []): ProductionAsset {
  return { key, name, type: asset.type, aliases, description: '', sourceRefs: [], appearances: [], usageEpisodes: [...asset.episodes], ...(asset.sceneRefs === undefined ? {} : { sceneRefs: structuredClone(asset.sceneRefs) }), variants: (asset.variants ?? []).map(v => ({ key: variantKey(key, v.name), name: v.name, episodes: [...v.episodes], ...(v.sceneRefs === undefined ? {} : { sceneRefs: structuredClone(v.sceneRefs) }), note: v.note ?? '' })) };
}
function candidateAliases(prior: Pick<F2Asset, 'name' | 'aliases'> | undefined, asset: { name: string; aliases?: string[] }): string[] {
  return [...new Set([...(prior?.aliases ?? []), ...(asset.aliases ?? []), ...(prior && prior.name !== asset.name ? [asset.name] : [])])];
}
function build(coverage: number[], assets: ProductionAsset[], format: CatalogWire['format'] = 'ASSET_CATALOG_V1'): ProductionCatalog {
  return { format, coverage, assets, episodes: coverage.map(number => ({ number, context: '', assetKeys: assets.filter(a => a.usageEpisodes.includes(number)).map(a => a.key) })), issues: [] };
}
function repairFields(items: readonly CatalogRepairItem[]) {
  return items.length ? { repairItems: structuredClone([...items]) } : {};
}
function assetRepairs(asset: CatalogAssetWire, key: string): CatalogRepairItem[] {
  return (asset.variants ?? []).flatMap(variant => {
    const episodes = variant.episodes.filter(number => !asset.episodes.includes(number));
    if (!episodes.length) return [];
    const childKey = variantKey(key, variant.name);
    return [{ id: `catalog-variant-scope-${hashFoundationPrompt(JSON.stringify([key, childKey, asset.episodes, variant.episodes])).slice(0, 24)}`,
      code: 'VARIANT_SCOPE' as const, assetKey: key, variantKey: childKey, episodes, assetEpisodes: [...asset.episodes], variantEpisodes: [...variant.episodes] }];
  });
}
function uniqueRepairs(parts: readonly (readonly CatalogRepairItem[])[]): CatalogRepairItem[] {
  const items = new Map<string, CatalogRepairItem>();
  for (const part of parts) for (const item of part) {
    const previous = items.get(item.id);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item)) fail(`repairItems.${item.id}`, '相同问题标识对应不同声明');
    items.set(item.id, structuredClone(item));
  }
  return [...items.values()];
}
/** Saved program evidence is validated, not trusted as an author's declaration of clearance. */
function savedRepairs(value: unknown, assets: readonly ProductionAsset[], all: readonly number[] | undefined, scope: readonly number[]): CatalogRepairItem[] {
  if (value == null) return [];
  const range = (value: unknown, at: string) => all ? scopedNumbers(value, all, at, true) : numbers(value, at, true);
  const items = list(value, 'repairItems').map((value, i): CatalogRepairItem => {
    const at = `repairItems.${i}`, raw = record(value, at), id = string(raw.id, `${at}.id`);
    if (!/^catalog-variant-scope-[a-f0-9]{24}$/.test(id) || raw.code !== 'VARIANT_SCOPE') fail(at, '无效的程序问题标识或类型');
    const assetKey = string(raw.assetKey, `${at}.assetKey`), variantKey = string(raw.variantKey, `${at}.variantKey`);
    const assetEpisodes = range(raw.assetEpisodes, `${at}.assetEpisodes`), variantEpisodes = range(raw.variantEpisodes, `${at}.variantEpisodes`);
    const episodes = range(raw.episodes, `${at}.episodes`);
    if (!episodes.length || !same(episodes, variantEpisodes.filter(number => !assetEpisodes.includes(number)))) fail(at, '问题范围须等于原子声明与父声明的非空差集');
    const asset = assets.find(asset => asset.key === assetKey), variant = asset?.variants.find(variant => variant.key === variantKey);
    if (!asset || !variant || [...assetEpisodes, ...variantEpisodes].some(number => scope.includes(number) && !asset.usageEpisodes.includes(number))
      || variantEpisodes.some(number => scope.includes(number) && !variant.episodes.includes(number))) fail(at, '待核问题的原范围或对应状态已丢失');
    return { id, code: 'VARIANT_SCOPE', assetKey, variantKey, episodes, assetEpisodes, variantEpisodes };
  });
  unique(items.map(item => item.id), 'repairItems.id');
  return items;
}
export function collectProductionRepairIssues(catalog: ProductionCatalog): FoundationIssue[] {
  return [...catalog.issues.filter(issue => issue.problem.includes('明确实体交互')), ...(catalog.repairItems ?? []).map(item => ({ severity: 'MAJOR' as const, owner: 'PROGRAM' as const, coordinate: `assets.${item.assetKey}.variants.${item.variantKey}.episodes`,
    problem: `父资产原声明[${item.assetEpisodes.join(',')}]，子状态原声明[${item.variantEpisodes.join(',')}]，需核对[${item.episodes.join(',')}]；暂存范围仅保留资料，待核不等于新增出场。`, sourceRefs: [] }))];
}
export function isProductionCatalog(value: unknown): value is ProductionCatalog {
  if (isRecord(value) && value.format === PRODUCTION_CATALOG_FORMAT) {
    const validPreparation = (v: unknown) => { try { readPreparation(v, 'preparation'); return true; } catch { return false; } };
    const validRepairs = () => { try { savedRepairs(value.repairItems, value.assets as ProductionAsset[], undefined, value.coverage as number[]); return true; } catch { return false; } };
    return isProductionCatalog({ ...value, format: 'ASSET_CATALOG_V1' }) && (value.assets as ProductionAsset[]).every(a => (a.role == null || typeof a.role === 'string') && (a.relationNote == null || typeof a.relationNote === 'string') && validPreparation(a.preparation) && a.variants.every(v => validPreparation(v.preparation))) && validRepairs();
  }
  const ints = (v: unknown): v is number[] => Array.isArray(v) && v.every(n => Number.isSafeInteger(n) && n >= 0) && new Set(v).size === v.length;
  const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every(s => typeof s === 'string');
  const refs = (v: unknown, episodes: readonly number[]) => v === undefined || (Array.isArray(v) && v.every(ref => isRecord(ref) && Number.isSafeInteger(ref.episode) && episodes.includes(ref.episode as number) && typeof ref.sceneKey === 'string') && new Set(v.map(ref => `${(ref as SceneAssetRef).episode}\0${(ref as SceneAssetRef).sceneKey}`)).size === v.length);
  return isRecord(value) && value.format === 'ASSET_CATALOG_V1' && ints(value.coverage) && Array.isArray(value.episodes) && value.episodes.every(e => isRecord(e) && Number.isSafeInteger(e.number) && typeof e.context === 'string' && texts(e.assetKeys)) && Array.isArray(value.issues) && value.issues.every(issue => isRecord(issue) && issue.severity === 'BLOCKER' && issue.owner === 'PROGRAM' && typeof issue.coordinate === 'string' && typeof issue.problem === 'string' && issue.problem.includes('明确实体交互') && Array.isArray(issue.sourceRefs)) && Array.isArray(value.assets) && value.assets.every(a => isRecord(a) && typeof a.key === 'string' && typeof a.name === 'string' && types.includes(a.type as F2Asset['type']) && texts(a.aliases) && a.description === '' && Array.isArray(a.sourceRefs) && a.sourceRefs.length === 0 && Array.isArray(a.appearances) && a.appearances.length === 0 && ints(a.usageEpisodes) && refs(a.sceneRefs, a.usageEpisodes as number[]) && Array.isArray(a.variants) && a.variants.every(v => isRecord(v) && typeof v.key === 'string' && typeof v.name === 'string' && ints(v.episodes) && refs(v.sceneRefs, v.episodes as number[]) && typeof v.note === 'string'));
}
export function projectProductionCatalog(output: ProductionCatalog, scope: readonly number[]): CatalogProjection {
  if (new Set(scope).size !== scope.length || scope.some(n => !output.coverage.includes(n))) fail('scope', '投影超出目录覆盖范围');
  // Empty usage means not located, never all episodes. Keep full definitions separately,
  // including unknown metadata and derivation links, without claiming an appearance.
  const materialCandidates: CatalogMaterialCandidate[] = output.assets.flatMap(a => [
    ...(!a.usageEpisodes.length ? [{ ...structuredClone(a), baseKey: a.key, kind: 'BASE' as const, episodes: [], use: 'CANDIDATE_ONLY' as const, reason: 'UNLOCATED_USAGE' as const }] : []),
    ...a.variants.filter(v => !v.episodes.length).map(v => ({ ...structuredClone(v), baseKey: a.key, baseName: a.name, type: a.type, kind: 'VARIANT' as const, use: 'CANDIDATE_ONLY' as const, reason: 'UNLOCATED_USAGE' as const }))
  ]);
  const candidates = materialCandidates.length ? { materialCandidates } : {};
  if (output.format === PRODUCTION_CATALOG_FORMAT) return { format: output.format, coverage: [...scope], ...candidates, assets: output.assets.filter(a => a.usageEpisodes.some(n => scope.includes(n))).map(a => ({ key: a.key, name: a.name, type: a.type, ...readClassification(a, 'asset'), aliases: [...a.aliases], episodes: a.usageEpisodes.filter(n => scope.includes(n)), ...(a.sceneRefs === undefined ? {} : { sceneRefs: a.sceneRefs.filter(ref => scope.includes(ref.episode)) }), preparation: structuredClone(a.preparation), variants: a.variants.filter(v => v.episodes.some(n => scope.includes(n))).map(v => ({ key: v.key, name: v.name, episodes: v.episodes.filter(n => scope.includes(n)), ...(v.sceneRefs === undefined ? {} : { sceneRefs: v.sceneRefs.filter(ref => scope.includes(ref.episode)) }), note: v.note, preparation: structuredClone(v.preparation) })) })),
    ...repairFields((output.repairItems ?? []).filter(item => item.episodes.some(number => scope.includes(number)))) };
  return { format: 'ASSET_CATALOG_V1', coverage: [...scope], ...candidates, assets: output.assets.filter(a => a.usageEpisodes.some(n => scope.includes(n))).map(a => ({ key: a.key, name: a.name, type: a.type, aliases: [...a.aliases], episodes: a.usageEpisodes.filter(n => scope.includes(n)), variants: a.variants.filter(v => v.episodes.some(n => scope.includes(n))).map(v => ({ name: v.name, episodes: v.episodes.filter(n => scope.includes(n)), note: v.note })) })) };
}
/** Provider/author boundary: canonical-looking extra fields never grant trusted identity. */
export function requireProductionCatalogAuthor(value: unknown, index: SourceIndex, scope: readonly number[], priorAssets: readonly F2Asset[] = []): ProductionCatalog {
  return readProductionCatalog(value, index, scope, priorAssets, false);
}
/** Saved canonical snapshots and internal merge/read compatibility; never use on V2 provider responses. */
export function requireProductionCatalog(value: unknown, index: SourceIndex, scope: readonly number[], priorAssets: readonly F2Asset[] = []): ProductionCatalog {
  return readProductionCatalog(value, index, scope, priorAssets, true);
}
function readProductionCatalog(value: unknown, index: SourceIndex, scope: readonly number[], priorAssets: readonly F2Asset[], trustedCanonical: boolean): ProductionCatalog {
  const raw = record(value, 'catalog');
  if (raw.format === PRODUCTION_CATALOG_FORMAT) {
    // Recognize the canonical envelope independently so malformed V2 fields report their real coordinates.
    const covered = coverage(raw.coverage, index, scope, true), isCanonical = trustedCanonical && isProductionCatalog({ ...raw, format: 'ASSET_CATALOG_V1' });
    const rawAssets = isCanonical ? (raw.assets as ProductionAsset[]).map(a => ({ ...a, episodes: a.usageEpisodes })) : list(raw.assets, 'assets');
    const repairs: CatalogRepairItem[] = [];
    const assets = rawAssets.map((value, i) => {
      const asset = readAsset(value, covered, `assets.${i}`, true);
      const prior = asset.key ? priorAssets.find(p => p.key === asset.key) as ProductionAsset | undefined : undefined;
      if (asset.key && !prior && !isCanonical) fail(`assets.${i}.key`, `未知已有身份 ${asset.key}；新候选须省略key`);
      const key = asset.key ?? scopedKey(covered, i, priorAssets, asset, index.version);
      repairs.push(...assetRepairs(asset, key));
      return canonicalV2(asset, key, prior);
    });
    unique(assets.map(a => a.key), 'assets.key');
    if (!isCanonical) resolvePreparations(assets, [...priorAssets, ...assets]);
    const existing = trustedCanonical ? savedRepairs(raw.repairItems, assets, index.episodes.map(episode => episode.number), covered) : [];
    return { ...build(covered, assets, PRODUCTION_CATALOG_FORMAT), issues: collectPhysicalEvidenceIssues(assets,index), ...humanChoices(raw.humanChoices, covered), ...repairFields(uniqueRepairs([existing, repairs])) };
  }
  if (raw.format !== 'ASSET_CATALOG_V1') fail('format', '须为ASSET_CATALOG_V1');
  const covered = coverage(raw.coverage, index, scope, true);
  const rawAssets = isProductionCatalog(value) ? value.assets.map(a => ({ ...a, episodes: a.usageEpisodes })) : list(raw.assets, 'assets');
  const assets = rawAssets.map((value, i) => {
    const asset = readAsset(value, scope, `assets.${i}`);
    const prior = findPriorAsset(asset, priorAssets, `assets.${i}.key`);
    const key = asset.key ?? prior?.key ?? assetKey(asset.type, asset.name);
    // A stable key identifies the candidate; names and classification can evolve before Q1 finalizes them.
    // Keep the first display name and every later name, without changing already valid earlier registries.
    return canonical(asset, key, prior?.name ?? asset.name, candidateAliases(prior, asset));
  });
  unique(assets.map(a => a.key), 'assets.key');
  return build(covered, assets);
}
function union(a: number[], b: number[]) { return [...new Set([...a, ...b])].sort((x, y) => x - y); }
function unionSceneRefs(a: readonly SceneAssetRef[] | undefined, b: readonly SceneAssetRef[] | undefined): SceneAssetRef[] | undefined {
  if (a === undefined && b === undefined) return undefined;
  return [...new Map([...(a ?? []), ...(b ?? [])].map(ref => [`${ref.episode}\0${ref.sceneKey}`, structuredClone(ref)])).values()]
    .sort((left, right) => left.episode - right.episode || left.sceneKey.localeCompare(right.sceneKey));
}
// New candidates are numbered within the program-bound scope, never inferred from appearance/name.
function scopedKey(scope: readonly number[], entry: number, prior: readonly F2Asset[], asset: CatalogAssetWire, sourceVersion: string): string {
  const base = `C_${hashFoundationPrompt(JSON.stringify({ sourceVersion, scope: [...scope].sort((a, b) => a - b), entry, name: asset.name, type: asset.type, episodes: asset.episodes })).slice(0, 16)}`;
  let key = base, suffix = 1;
  while (prior.some(a => a.key === key)) key = `${base}_${++suffix}`;
  return key;
}
function canonicalV2(asset: CatalogAssetWire, key: string, prior?: ProductionAsset): ProductionAsset {
  const result = canonical(asset, key, asset.name, aliasesV2(prior, asset));
  // The envelope prevents lost variants; assetRepairs separately retains the unverified original declarations.
  result.usageEpisodes = union(result.usageEpisodes, result.variants.flatMap(variant => variant.episodes));
  Object.assign(result, readClassification({ role: asset.role ?? prior?.role, relationNote: asset.relationNote ?? prior?.relationNote }, 'asset'));
  result.preparation = reusePreparation(asset.preparation, prior?.preparation, key, Boolean(prior && prior.key === key));
  result.variants = result.variants.map((v, i) => {
    const previous = prior?.variants?.find(p => p.key === v.key);
    return { ...v, ...(asset.variants?.[i].sceneRefs === undefined && previous?.sceneRefs !== undefined ? { sceneRefs: structuredClone(previous.sceneRefs.filter(ref => v.episodes.includes(ref.episode))) } : {}), preparation: reusePreparation(asset.variants?.[i].preparation, previous?.preparation, v.key, Boolean(previous)) };
  });
  if (asset.sceneRefs === undefined && prior?.sceneRefs !== undefined) result.sceneRefs = structuredClone(prior.sceneRefs.filter(ref => result.usageEpisodes.includes(ref.episode)));
  return result;
}
function reusePreparation(proposed: Preparation | undefined, prior: Preparation | undefined, key: string, registered: boolean): Preparation {
  if (registered && proposed?.mode === 'DERIVE' && proposed.fromKey === key) {
    const inherited = structuredClone(prior ?? { mode: 'UNRESOLVED' as const }), note = joinNotes(inherited.note, proposed.note);
    return { ...inherited, ...(note ? { note } : {}) };
  }
  return structuredClone(proposed ?? prior ?? { mode: 'UNRESOLVED' });
}
function aliasesV2(prior: Pick<F2Asset, 'name' | 'aliases'> | undefined, asset: { name: string; aliases?: string[] }): string[] {
  return [...new Set([...(prior?.aliases ?? []), ...(asset.aliases ?? []), ...(prior ? [prior.name] : [])])].filter(n => n !== asset.name);
}
function resolvePreparations(assets: ProductionAsset[], knownAssets: readonly F2Asset[]) {
  const nodes = new Map<string, { preparation?: Preparation; parentKey?: string }>();
  for (const asset of knownAssets) {
    nodes.set(asset.key, { preparation: (asset as ProductionAsset).preparation });
    for (const variant of (asset as ProductionAsset).variants ?? []) nodes.set(variant.key, { preparation: variant.preparation, parentKey: asset.key });
  }
  const source = (key: string) => { const n = nodes.get(key); return n?.preparation?.fromKey ?? (n?.preparation?.mode === 'DERIVE' ? n.parentKey : undefined); };
  // Functional graph: iterative traversal is bounded by registered nodes, including all downstream dependents.
  const cyclic = new Map<string, boolean>();
  for (const start of nodes.keys()) {
    if (cyclic.has(start)) continue;
    const path = new Set<string>(); let key: string | undefined = start;
    while (key && nodes.has(key) && !cyclic.has(key) && !path.has(key)) { path.add(key); key = source(key); }
    const affected = !!key && (path.has(key) || cyclic.get(key) === true);
    for (const visited of path) cyclic.set(visited, affected);
  }
  const pending = new Map<string, boolean>();
  for (const [key, node] of nodes) {
    const fromKey = source(key);
    if (node.preparation?.mode === 'UNRESOLVED' || cyclic.get(key) || (fromKey && !nodes.has(fromKey)) || (!fromKey && node.preparation?.mode === 'DERIVE')) pending.set(key, true);
  }
  for (const start of nodes.keys()) {
    if (pending.has(start)) continue;
    const path: string[] = []; let key: string | undefined = start;
    // Cycles were seeded above, so no recursive traversal or unbounded loop is possible.
    while (key && nodes.has(key) && !pending.has(key)) { path.push(key); key = source(key); }
    for (const visited of path) pending.set(visited, !!key && pending.get(key) === true);
  }
  for (const asset of assets) for (const target of [asset, ...asset.variants]) {
    const p = target.preparation;
    if (!p) continue;
    const fromKey = p.fromKey ?? (p.mode === 'DERIVE' && target !== asset ? asset.key : undefined);
    const problem = cyclic.get(target.key) ? '制作来源存在循环依赖或依赖循环，待确认' : (fromKey && !nodes.has(fromKey)) || (!fromKey && p.mode === 'DERIVE') ? '制作来源缺失或未知，待确认' : fromKey && pending.get(fromKey) ? '制作来源或其上游仍待定，待确认' : undefined;
    target.preparation = { ...p, ...(fromKey ? { fromKey } : {}), ...(problem ? { mode: 'UNRESOLVED', note: joinNotes(p.note, problem) } : {}) };
  }
}
function joinNotes(...notes: (string | undefined)[]): string {
  return [...new Set(notes.flatMap(n => n?.split('\n').filter(Boolean) ?? []))].join('\n');
}
function mergePreparation(a?: Preparation, b?: Preparation): Preparation | undefined {
  if (!a || !b) return structuredClone(a ?? b);
  const conflict = '制作方式冲突：';
  const alreadyConflicted = [a, b].some(p => p.mode === 'UNRESOLVED' && p.note?.includes(conflict));
  const different = a.mode !== 'UNRESOLVED' && b.mode !== 'UNRESOLVED' && (a.mode !== b.mode || (!!a.fromKey && !!b.fromKey && a.fromKey !== b.fromKey));
  const describe = (p: Preparation) => `${p.mode}${p.fromKey ? ` 来源=${p.fromKey}` : ''}`;
  if (alreadyConflicted || different) return { mode: 'UNRESOLVED', note: joinNotes(conflict, describe(a), a.note, describe(b), b.note) };
  const preferred = a.mode !== 'UNRESOLVED' ? a : b;
  const other = preferred === a ? b : a;
  const fromKey = preferred.fromKey ?? (preferred.mode === other.mode ? other.fromKey : undefined);
  const note = joinNotes(a.note, b.note, other.fromKey && other.fromKey !== fromKey ? `保留待定关联：${describe(other)}` : undefined);
  return { ...preferred, ...(fromKey ? { fromKey } : {}), ...(note ? { note } : {}) };
}
function unionVariants(a: ProductionVariant[], b: ProductionVariant[], preserveInfo = false): ProductionVariant[] {
  const result = new Map(a.map(v => [v.key, structuredClone(v)]));
  for (const v of b) {
    const prior = result.get(v.key);
    result.set(v.key, prior ? { ...prior, episodes: union(prior.episodes, v.episodes), ...(unionSceneRefs(prior.sceneRefs, v.sceneRefs) === undefined ? {} : { sceneRefs: unionSceneRefs(prior.sceneRefs, v.sceneRefs) }), note: preserveInfo ? joinNotes(prior.note, v.note) : v.note || prior.note, ...(preserveInfo ? { preparation: mergePreparation(prior.preparation, v.preparation) } : v.preparation ? { preparation: structuredClone(v.preparation) } : {}) } : structuredClone(v));
  }
  return [...result.values()];
}
export function mergeProductionCatalogs(parts: readonly ProductionCatalog[], index: SourceIndex, scope: readonly number[], verifiedFragments?: readonly FoundationFragment[]): ProductionCatalog {
  const checked = parts.map(p => requireProductionCatalog(p, index, p.coverage));
  if (verifiedFragments) {
    const expected = buildFoundationFragments(index).filter(fragment => scope.includes(fragment.episode));
    if (verifiedFragments.length !== parts.length || new Set(verifiedFragments.map(f => f.id)).size !== verifiedFragments.length
      || verifiedFragments.some((fragment,i) => !expected.some(e => e.id===fragment.id&&e.start===fragment.start&&e.end===fragment.end&&e.sourceVersion===fragment.sourceVersion&&e.episode===fragment.episode) || parts[i].coverage.length!==1 || parts[i].coverage[0]!==fragment.episode)
      || !scope.every(episode => fragmentsComplete(index,expected,verifiedFragments.map(f=>f.id)).includes(episode))) fail('fragments','只有当前源完整覆盖且位置不重复的分片可合并同一集');
  }
  const covered = coverage(checked.flatMap(p => p.coverage), index, scope, Boolean(verifiedFragments));
  const assets = new Map<string, ProductionAsset>();
  for (const part of checked) for (const asset of part.assets) {
    const prior = assets.get(asset.key);
    const v2 = part.format === PRODUCTION_CATALOG_FORMAT;
    assets.set(asset.key, prior ? { ...prior, ...(v2 ? { name: asset.name, ...readClassification(asset, 'asset'), preparation: mergePreparation(prior.preparation, asset.preparation) } : {}), type: asset.type, aliases: v2 ? aliasesV2(prior, asset) : candidateAliases(prior, asset), usageEpisodes: union(prior.usageEpisodes, asset.usageEpisodes), ...(unionSceneRefs(prior.sceneRefs, asset.sceneRefs) === undefined ? {} : { sceneRefs: unionSceneRefs(prior.sceneRefs, asset.sceneRefs) }), variants: unionVariants(prior.variants, asset.variants, v2) } : asset);
  }
  const v2 = checked.some(p => p.format === PRODUCTION_CATALOG_FORMAT);
  if (v2) for (const a of assets.values()) { a.preparation ??= { mode: 'UNRESOLVED' }; for (const v of a.variants) v.preparation ??= { mode: 'UNRESOLVED' }; }
  if (v2) resolvePreparations([...assets.values()], [...assets.values()]);
  return { ...build(covered, [...assets.values()], v2 ? PRODUCTION_CATALOG_FORMAT : 'ASSET_CATALOG_V1'), ...humanChoices(mergeHumanChoices(checked.map(part => part.humanChoices ?? [])), covered),
    ...(v2 ? { ...repairFields(uniqueRepairs(checked.map(part => part.repairItems ?? []))), issues: collectPhysicalEvidenceIssues([...assets.values()], index) } : {}) };
}
export function requireProductionOptimization(value: unknown, index: SourceIndex, scope: readonly number[], priorAssets: readonly ProductionAsset[] = []): ProductionOptimization {
  const raw = record(value, 'optimization');
  const v2 = raw.format === PRODUCTION_OPTIMIZATION_FORMAT;
  if (!v2 && raw.format !== 'FOUNDATION_OPTIMIZATION_V1') fail('format', '须为FOUNDATION_OPTIMIZATION_V1或V2');
  const covered = coverage(raw.coverage, index, scope, true), edit = record(raw.changes, 'changes');
  if (Object.keys(edit).some(k => !['episodes', 'assets', 'removeAssetKeys', 'overview', ...(v2 ? ['mergeAssets', 'scenes', 'sceneSplits'] : [])].includes(k))) fail('changes', '包含未知修改目标');
  const changes: Q1Wire['changes'] = {};
  if (edit.episodes != null) {
    changes.episodes = list(edit.episodes, 'changes.episodes').map((value, i) => {
      const raw = record(value, `changes.episodes.${i}`), [number] = scopedNumbers([raw.number], covered, `changes.episodes.${i}.number`);
      return { number, summary: string(raw.summary, `changes.episodes.${i}.summary`), ...(raw.context == null ? {} : { context: string(raw.context, `changes.episodes.${i}.context`, true) }) };
    });
    unique(changes.episodes.map(e => e.number), 'changes.episodes');
  }
  if (edit.assets != null) {
    changes.assets = list(edit.assets, 'changes.assets').map((a, i) => {
      const rawAsset = record(a, `changes.assets.${i}`), prior = v2 && typeof rawAsset.key === 'string' ? priorAssets.find(asset => asset.key === rawAsset.key) : undefined;
      // An explicit existing identity makes omitted patch fields unambiguous; do not ask the model to copy them again.
      const expanded = prior ? { ...rawAsset, name: rawAsset.name ?? prior.name, type: rawAsset.type ?? prior.type, episodes: rawAsset.episodes ?? prior.usageEpisodes.filter(number => covered.includes(number)) } : rawAsset;
      return readAsset(expanded, covered, `changes.assets.${i}`, v2);
    });
    unique(changes.assets.map((a, i) => a.key ?? (v2 ? `new:${i}` : assetKey(a.type, a.name))), 'changes.assets');
  }
  if (edit.removeAssetKeys != null) changes.removeAssetKeys = strings(edit.removeAssetKeys, 'changes.removeAssetKeys');
  if (changes.assets?.some(a => a.key && changes.removeAssetKeys?.includes(a.key))) fail('changes', '同一key不可同时修改与移除');
  if (edit.overview != null) changes.overview = string(edit.overview, 'changes.overview', true);
  if (v2) {
    if (edit.sceneSplits != null) {
      changes.sceneSplits = list(edit.sceneSplits, 'changes.sceneSplits').map((value, i) => {
        const at = `changes.sceneSplits.${i}`, raw = record(value, at);
        if (Object.keys(raw).some(key => !['episode', 'sourceHash', 'sceneKey', 'cuts'].includes(key))) fail(at, '包含未知拆场字段');
        const [episode] = scopedNumbers([raw.episode], covered, `${at}.episode`);
        const source = index.episodes.find(item => item.number === episode)!, sourceHash = hashFoundationPrompt(source.content);
        if (raw.sourceHash !== undefined && raw.sourceHash !== sourceHash) fail(`${at}.sourceHash`, '原文已变化，拆场计划不能用于其它版本');
        const lines = source.content.split(/\r\n|\n|\r/);
        const cuts = list(raw.cuts, `${at}.cuts`).map((value, j) => {
          const cutAt = `${at}.cuts.${j}`, cut = record(value, cutAt);
          if (Object.keys(cut).some(key => !['startLine', 'anchor', 'location', 'interiorExterior', 'timeOfDay', 'timeLayer'].includes(key))) fail(cutAt, '包含未知拆场字段');
          if (!Number.isSafeInteger(cut.startLine) || Number(cut.startLine) < 1) fail(`${cutAt}.startLine`, '须为原文正整数行号');
          // Numbered source includes line endings; accept one, never trim or repair the line body.
          const anchor = typeof cut.anchor === 'string' ? cut.anchor.replace(/(?:\r\n|\n|\r)$/, '') : '';
          if (!anchor.trim() || /[\r\n]/.test(anchor) || anchor !== lines[Number(cut.startLine) - 1]) fail(`${cutAt}.anchor`, '须逐字匹配对应行完整原文，不含行尾换行');
          return { startLine: Number(cut.startLine), anchor, ...Object.fromEntries(['location', 'interiorExterior', 'timeOfDay', 'timeLayer'].filter(key => cut[key] != null).map(key => [key, string(cut[key], `${cutAt}.${key}`)])) };
        });
        if (!cuts.length) fail(`${at}.cuts`, '须有实际拆场位置');
        return { episode, sourceHash, sceneKey: string(raw.sceneKey, `${at}.sceneKey`), cuts };
      });
      unique(changes.sceneSplits.map(plan => `${plan.episode}\0${plan.sceneKey}`), 'changes.sceneSplits');
    }
    if (edit.scenes != null) {
      changes.scenes = list(edit.scenes, 'changes.scenes').map((scene, i) => readScenePatch(scene, covered, `changes.scenes.${i}`));
      unique(changes.scenes.map(scene => `${scene.episode}\0${scene.sceneKey}`), 'changes.scenes');
    }
    if (edit.mergeAssets != null) {
      changes.mergeAssets = list(edit.mergeAssets, 'changes.mergeAssets').map((v, i) => {
        const at = `changes.mergeAssets.${i}`, raw = record(v, at);
        const keepKey = string(raw.keepKey, `${at}.keepKey`), removeKeys = strings(raw.removeKeys, `${at}.removeKeys`);
        if (!removeKeys.length || removeKeys.includes(keepKey)) fail(at, '须有非自身的被归并身份');
        return { keepKey, removeKeys };
      });
      // Disjoint merge groups make the survivor deterministic; chains/cycles must be one explicit group.
      unique(changes.mergeAssets.flatMap(m => [m.keepKey, ...m.removeKeys]), 'changes.mergeAssets');
      const involved = changes.mergeAssets.flatMap(m => [m.keepKey, ...m.removeKeys]);
      if (changes.removeAssetKeys?.some(k => involved.includes(k)) || changes.assets?.some(a => a.key && changes.mergeAssets!.some(m => m.removeKeys.includes(a.key!)))) fail('changes', '归并与修改/局部移除冲突');
    }
    const unresolved = raw.unresolved == null ? [] : list(raw.unresolved, 'unresolved').map((v, i): Unresolved => {
      const at = `unresolved.${i}`, raw = record(v, at);
      if (raw.owner != null && !['Q1', 'PROGRAM', 'STAGE2'].includes(raw.owner as string)) fail(`${at}.owner`, '须明确为Q1、PROGRAM或STAGE2');
      return { ...(raw.applicationScope == null ? {} : { applicationScope: readApplicationScope(raw.applicationScope) }), ...(raw.evidenceRefs == null ? {} : { evidenceRefs: readChoiceEvidence(raw.evidenceRefs) }), ...(Array.isArray(raw.receivingUses) ? { receivingUses: strings(raw.receivingUses, `${at}.receivingUses`) } : {}), note: string(raw.note, `${at}.note`), ...(raw.key == null ? {} : { key: string(raw.key, `${at}.key`) }), ...(raw.episodes == null ? {} : { episodes: scopedNumbers(raw.episodes, covered, `${at}.episodes`, true) }), ...(raw.owner == null ? {} : { owner: raw.owner as Unresolved['owner'] }) };
    });
    assertUnresolvedSourceScopes({unresolved},index,covered);
    const resolvedUnresolved = raw.resolvedUnresolved == null ? [] : strings(raw.resolvedUnresolved, 'resolvedUnresolved');
    const resolvedCatalogIssues = raw.resolvedCatalogIssues == null ? [] : strings(raw.resolvedCatalogIssues, 'resolvedCatalogIssues');
    const receipts = (field: 'resolvedSuggestions' | 'appliedDecisions'): EditorialReceipt[] => raw[field] == null ? [] : list(raw[field], field).map((item, i) => {
      const receipt = record(item, `${field}.${i}`);
      return { id: string(receipt.id, `${field}.${i}.id`), note: string(receipt.note, `${field}.${i}.note`) };
    });
    const resolvedSuggestions = receipts('resolvedSuggestions'), appliedDecisions = receipts('appliedDecisions');
    unique(resolvedSuggestions.map(item => item.id), 'resolvedSuggestions'); unique(appliedDecisions.map(item => item.id), 'appliedDecisions');
    return { format: PRODUCTION_OPTIMIZATION_FORMAT, coverage: covered, summary: raw.summary == null ? '' : string(raw.summary, 'summary', true), changes, notes: raw.notes == null ? [] : strings(raw.notes, 'notes'), unresolved, resolvedUnresolved,
      ...(resolvedSuggestions.length ? { resolvedSuggestions } : {}), ...(appliedDecisions.length ? { appliedDecisions } : {}),
      ...(resolvedCatalogIssues.length ? { resolvedCatalogIssues } : {}), verdict: unresolved.length ? 'REPAIR' : 'READY', issues: [], ...humanChoices(raw.humanChoices, covered) };
  }
  return { format: 'FOUNDATION_OPTIMIZATION_V1', coverage: covered, summary: raw.summary == null ? '' : string(raw.summary, 'summary', true), changes, notes: raw.notes == null ? [] : strings(raw.notes, 'notes'), verdict: 'READY', issues: [] };
}
function explicitlyRepairs(item: CatalogRepairItem, edit: ProductionOptimization): boolean {
  if (!edit.resolvedCatalogIssues?.includes(item.id) || !item.episodes.every(number => edit.coverage.includes(number))) return false;
  if (edit.changes.removeAssetKeys?.includes(item.assetKey)) return true;
  const asset = edit.changes.assets?.find(asset => asset.key === item.assetKey);
  if (!asset || asset.variants?.some(variant => variant.episodes.some(number => !asset.episodes.includes(number)))) return false;
  // Expanding the declared parent requires the marker; the receiver's envelope is never evidence of consent.
  if (item.episodes.every(number => asset.episodes.includes(number))) return true;
  // An explicit complete local variant list can correct or remove the affected version. Omission cannot.
  return asset.variants !== undefined;
}
function repairTookEffect(item: CatalogRepairItem, edit: ProductionOptimization, assets: ReadonlyMap<string, ProductionAsset>): boolean {
  const actual = assets.get(item.assetKey);
  if (edit.changes.removeAssetKeys?.includes(item.assetKey)) return !actual || item.episodes.every(number => !actual.usageEpisodes.includes(number));
  const proposed = edit.changes.assets?.find(asset => asset.key === item.assetKey);
  if (!actual || !proposed) return false;
  if (item.episodes.every(number => proposed.episodes.includes(number))) return item.episodes.every(number => actual.usageEpisodes.includes(number));
  const expected = proposed.variants?.find(variant => variantKey(item.assetKey, variant.name) === item.variantKey)?.episodes ?? [];
  const retained = actual.variants.find(variant => variant.key === item.variantKey)?.episodes.filter(number => edit.coverage.includes(number)) ?? [];
  return same(expected, retained);
}
export function applyProductionOptimizations(f1: F1Output, f2: ProductionCatalog, outputs: readonly ProductionOptimization[], index: SourceIndex, overviewParts?: readonly { coverage: number[]; overview: string }[]): { f1: F1Output; f2: ProductionCatalog };
export function applyProductionOptimizations(f1: null, f2: ProductionCatalog, outputs: readonly ProductionOptimization[], index: SourceIndex): { f1: null; f2: ProductionCatalog };
export function applyProductionOptimizations(f1: F1Output | null, f2: ProductionCatalog, outputs: readonly ProductionOptimization[], index: SourceIndex, overviewParts?: readonly { coverage: number[]; overview: string }[]): { f1: F1Output | null; f2: ProductionCatalog } {
  const scope = f1 ? coverage(f1.coverage, index, f2.coverage) : coverage(f2.coverage, index, f2.coverage);
  const nextF1 = f1 && structuredClone(f1), parts = f1 && overviewParts && structuredClone(overviewParts);
  if (nextF1 && !same(numbers(nextF1.episodes.map(e => e.number), 'f1.episodes'), scope)) fail('f1.episodes', '须精确覆盖目录范围');
  let nextF2 = requireProductionCatalog(f2, index, scope);
  for (const output of outputs) {
    const checked = requireProductionOptimization(output, index, output.coverage, nextF2.assets), { changes, coverage: changedScope } = checked;
    if (changedScope.some(n => !scope.includes(n))) fail('optimization.coverage', '修正越出候选范围');
    if (!nextF1 && changes.episodes?.length) fail('changes.episodes', '轻量目录没有F1，不能修改导航');
    if (!nextF1 && changes.overview !== undefined) fail('changes.overview', '轻量目录没有F1，不能修改概述');
    for (const update of changes.episodes ?? []) {
      const episode = nextF1!.episodes.find(e => e.number === update.number)!;
      episode.summary = update.summary;
      if (update.context !== undefined) episode.context = update.context;
    }
    if (changes.overview !== undefined) {
      if (!parts) fail('changes.overview', '缺少程序绑定的F1分片概述，不能替换全局概述');
      coverage(parts.flatMap(p => p.coverage), index, scope);
      const matching = parts.filter(p => same(p.coverage, changedScope));
      if (matching.length !== 1) fail('changes.overview', '须精确对应一份F1分片');
      matching[0].overview = changes.overview;
      nextF1!.overview = parts.map(p => p.overview).join('\n\n');
    }
    const assets = new Map(nextF2.assets.map(a => [a.key, a]));
    const protectedStates = (nextF2.repairItems ?? []).map(item => {
      const asset = nextF2.assets.find(asset => asset.key === item.assetKey)!;
      return { item: structuredClone(item), asset: structuredClone(asset), variant: structuredClone(asset.variants.find(variant => variant.key === item.variantKey)!) };
    });
    const newRepairs: CatalogRepairItem[] = [];
    const redirects = new Map<string, string>();
    const v2 = checked.format === PRODUCTION_OPTIMIZATION_FORMAT;
    if (v2) {
      for (const operation of changes.mergeAssets ?? []) {
        if (!assets.has(operation.keepKey)) fail('changes.mergeAssets.keepKey', `未知key ${operation.keepKey}`);
        for (const key of operation.removeKeys) {
          const removed = assets.get(key);
          if (!removed) fail('changes.mergeAssets.removeKeys', `未知key ${key}`);
          redirects.set(key, operation.keepKey);
          for (const variant of removed.variants) redirects.set(variant.key, variantKey(operation.keepKey, variant.name));
        }
      }
      // Normalize equivalent sources before comparing preparations, including sibling merge groups.
      for (const a of assets.values()) for (const target of [a, ...a.variants]) if (target.preparation?.fromKey && redirects.has(target.preparation.fromKey)) target.preparation = { ...target.preparation, fromKey: redirects.get(target.preparation.fromKey)! };
      for (const operation of changes.mergeAssets ?? []) {
        const keep = assets.get(operation.keepKey)!;
        for (const key of operation.removeKeys) {
          const removed = assets.get(key)!;
          keep.usageEpisodes = union(keep.usageEpisodes, removed.usageEpisodes);
          const mergedSceneRefs = unionSceneRefs(keep.sceneRefs, removed.sceneRefs);
          if (mergedSceneRefs !== undefined) keep.sceneRefs = mergedSceneRefs;
          keep.aliases = [...new Set([...keep.aliases, removed.name, ...removed.aliases])].filter(n => n !== keep.name);
          keep.preparation = mergePreparation(keep.preparation, removed.preparation);
          if (keep.role == null && removed.role != null) keep.role = removed.role;
          if (keep.relationNote == null) {
            if (removed.relationNote != null) keep.relationNote = removed.relationNote;
          } else if (keep.relationNote !== '') keep.relationNote = joinNotes(keep.relationNote, removed.relationNote);
          keep.variants = unionVariants(keep.variants, removed.variants.map(v => ({ ...v, key: variantKey(keep.key, v.name) })), true);
          assets.delete(key);
        }
      }
      // Retarget explicit edits too; old source keys remain legitimate within this merge operation.
      for (const a of changes.assets ?? []) for (const target of [a, ...(a.variants ?? [])]) if (target.preparation?.fromKey && redirects.has(target.preparation.fromKey)) target.preparation = { ...target.preparation, fromKey: redirects.get(target.preparation.fromKey)! };
    }
    const resolved = (changes.assets ?? []).map((asset, i) => {
      const prior = v2 ? (asset.key ? assets.get(asset.key) : undefined) : findPriorAsset(asset, nextF2.assets, `changes.assets.${i}.key`);
      if (v2 && asset.key && !prior) fail(`changes.assets.${i}.key`, `未知已有身份 ${asset.key}`);
      const key = asset.key ?? prior?.key ?? (v2 ? scopedKey(changedScope, i, [...assets.values()], asset, index.version) : assetKey(asset.type, asset.name));
      const name = asset.key === undefined ? prior?.name ?? asset.name : asset.name;
      const updated = v2 ? canonicalV2(asset, key, prior) : canonical(asset, key, name, asset.aliases ?? prior?.aliases ?? []);
      // An optimization patch that omits aliases preserves that field, including
      // during an authorized rename. Historical names remain in document history.
      if (v2 && prior && asset.aliases === undefined) updated.aliases = [...prior.aliases];
      const keepVisualBasis = (previous: Preparation | undefined, proposed: Preparation | undefined, episodes: number[]) => {
        if (proposed?.mode !== 'AUDIO' || !previous || !['REFERENCE', 'DERIVE'].includes(previous.mode) || !episodes.some(episode => !changedScope.includes(episode))) return proposed;
        return { ...previous, note: joinNotes(previous.note, '本批声音出现不撤销其它集的可视备图基线；仅完整适用范围核对后可改为纯声音。') };
      };
      if (v2 && prior) {
        updated.preparation = keepVisualBasis(prior.preparation, updated.preparation, prior.usageEpisodes);
        for (const variant of updated.variants) {
          const previous = prior.variants.find(item => item.key === variant.key);
          if (previous) variant.preparation = keepVisualBasis(previous.preparation, variant.preparation, previous.episodes);
        }
      }
      if (v2) newRepairs.push(...assetRepairs(asset, key));
      // Omission preserves variants only where this replacement still declares asset usage.
      if (asset.variants === undefined && prior) updated.variants = prior.variants.map(v => ({ ...v, episodes: v.episodes.filter(n => asset.episodes.includes(n)), ...(v.sceneRefs === undefined ? {} : { sceneRefs: v.sceneRefs.filter(ref => asset.episodes.includes(ref.episode)) }) })).filter(v => v.episodes.length);
      return updated;
    });
    unique(resolved.map(a => a.key), 'changes.assets');
    if (resolved.some(a => changes.removeAssetKeys?.includes(a.key))) fail('changes', '同一身份不可同时修改与移除');
    // Unlocated variants have no scoped use to remove; retain their definitions.
    const outside = (asset: ProductionAsset): ProductionAsset => ({ ...asset, usageEpisodes: asset.usageEpisodes.filter(n => !changedScope.includes(n)), ...(asset.sceneRefs === undefined ? {} : { sceneRefs: asset.sceneRefs.filter(ref => !changedScope.includes(ref.episode)) }), variants: asset.variants.filter(v => !v.episodes.length || v.episodes.some(n => !changedScope.includes(n))).map(v => ({ ...v, episodes: v.episodes.filter(n => !changedScope.includes(n)), ...(v.sceneRefs === undefined ? {} : { sceneRefs: v.sceneRefs.filter(ref => !changedScope.includes(ref.episode)) }) })) });
    for (const key of changes.removeAssetKeys ?? []) {
      const asset = assets.get(key);
      if (!asset) fail('changes.removeAssetKeys', `未知key ${key}`);
      const kept = outside(asset);
      if (kept.usageEpisodes.length) assets.set(key, kept); else assets.delete(key);
    }
    for (const update of resolved) {
      const prior = assets.get(update.key), kept = prior && outside(prior);
      const mergedSceneRefs = kept && unionSceneRefs(kept.sceneRefs, update.sceneRefs);
      assets.set(update.key, kept ? { ...update, usageEpisodes: union(kept.usageEpisodes, update.usageEpisodes), ...(mergedSceneRefs === undefined ? {} : { sceneRefs: mergedSceneRefs }), variants: unionVariants(kept.variants, update.variants) } : update);
    }
    const retainedRepairs: CatalogRepairItem[] = [];
    let proposedClosures: typeof protectedStates = [];
    const retargetPreparation = (preparation: Preparation | undefined) => preparation?.fromKey && redirects.has(preparation.fromKey)
      ? { ...preparation, fromKey: redirects.get(preparation.fromKey)! } : preparation;
    const restore = (protectedState: typeof protectedStates[number]) => {
      const { item } = protectedState;
      retainedRepairs.push(item);
      // Partial/removal/rename edits cannot erase the evidence merely because the old parent omitted a child episode.
      const previous = protectedState.asset;
      const asset = assets.get(item.assetKey) ?? { ...previous, key: item.assetKey, preparation: retargetPreparation(previous.preparation), usageEpisodes: [], variants: [] };
      asset.usageEpisodes = union(asset.usageEpisodes, [...item.assetEpisodes, ...item.variantEpisodes].filter(number => scope.includes(number)));
      asset.variants = unionVariants(asset.variants, [{ ...protectedState.variant, key: item.variantKey, episodes: item.variantEpisodes.filter(number => scope.includes(number)),
        preparation: retargetPreparation(protectedState.variant.preparation) }], true);
      assets.set(item.assetKey, asset);
    };
    for (const protectedState of protectedStates) {
      const item = { ...protectedState.item, assetKey: redirects.get(protectedState.item.assetKey) ?? protectedState.item.assetKey,
        variantKey: redirects.get(protectedState.item.variantKey) ?? protectedState.item.variantKey };
      const mapped = { ...protectedState, item };
      if (v2 && explicitlyRepairs(item, checked)) proposedClosures.push(mapped);
      else restore(mapped);
    }
    // Restoring one unresolved version may undo another claimed deletion; this loop restores at least one claim per pass.
    while (proposedClosures.length) {
      const ineffective = proposedClosures.filter(state => !repairTookEffect(state.item, checked, assets));
      if (!ineffective.length) break;
      for (const state of ineffective) restore(state);
      const ids = new Set(ineffective.map(state => state.item.id));
      proposedClosures = proposedClosures.filter(state => !ids.has(state.item.id));
    }
    if (v2) for (const a of assets.values()) { a.preparation ??= { mode: 'UNRESOLVED' }; for (const variant of a.variants) variant.preparation ??= { mode: 'UNRESOLVED' }; }
    if (v2) resolvePreparations([...assets.values()], [...assets.values()]);
    nextF2 = requireProductionCatalog({ ...build([...scope], [...assets.values()], v2 ? PRODUCTION_CATALOG_FORMAT : nextF2.format), ...repairFields(uniqueRepairs([retainedRepairs, newRepairs])) }, index, scope);
  }
  return { f1: nextF1, f2: nextF2 };
}
