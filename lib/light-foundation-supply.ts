import {readSeasonState,requireSeasonProduction} from './season-scope-service';
import { readApplicationScope, scopeApplies } from './foundation-application-scope';
import { loadFoundationChoices } from './foundation-choice-store';
import { selectFoundationFacts } from './foundation-facts';
/** Deterministic source/scene/asset supply. No synopsis generation or provider call. */
import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { cachedFoundationFacts } from './foundation-fact-cache';
import type { loadFoundationInputs } from './foundation-state';
import { foundationJson } from './foundation-state';
import { loadFoundationSourceContext } from './foundation-source';
import { assertSourceVersion, buildNumberedSource, buildSourceIndex, FoundationContractError, type SourceIndex, type FoundationIssue } from './project-foundation-contracts';
import { projectProductionCatalog, assertUnresolvedSourceScopes, type ProductionCatalog, type SceneFieldPatch, type Preparation, unresolvedOwner, unresolvedEpisodeScope } from './foundation-production-contracts';
import type { FoundationDocument } from './foundation-document';
import { knownScriptSpeakers, prepareEpisodeReception, type ScriptInputProtocol,type ScriptPerformanceOptions } from './standard-script-reception';
import { buildEpisodeBoundarySeed, type EpisodeBoundarySeed } from './episode-boundary-seed';

type Db = Prisma.TransactionClient;
class LightSceneSourceError extends Error {}
export async function loadLightScenes(projectId: string, db: Db, scope?: number[]) {
  const seasonal=await readSeasonState(projectId,db,{fastLegacy:true});
  if(seasonal.mode==='season'&&seasonal.status==='locked'&&!seasonal.sourceStale){const locked=await requireSeasonProduction(projectId,scope,'assets',db);scope=scope??locked!.scope.episodeNumbers;}
  const rows = await db.scriptScene.findMany({ where: { episode: { projectId, ...(scope ? { number: { in: scope } } : {}) } }, include: { episode: { select: { number: true, content: true } } }, orderBy: [{ episode: { number: 'asc' } }, { sortOrder: 'asc' }] });
  const cursors = new Map<number, number>();
  const scenes = rows.map(row => {
    const start = row.episode.content.indexOf(row.sourceText, cursors.get(row.episode.number) ?? 0), end = start + row.sourceText.length;
    if (start < 0 || row.episode.content.slice(cursors.get(row.episode.number) ?? 0, start).trim()) throw new LightSceneSourceError(`第${row.episode.number}集场次${row.sceneKey}的原文定位待重建，不能漏掉前面的正文。`);
    cursors.set(row.episode.number, end);
    const meta = foundationJson(row.metadata);
    return { episode: row.episode.number, sceneKey: row.sceneKey, heading: row.heading, location: row.location, timeOfDay: row.timeOfDay,
      interiorExterior: row.interiorExterior, weather: row.weather, timeLayer: row.timeLayer,
      characters: Array.isArray(meta.characters) ? meta.characters.filter((item): item is string => typeof item === 'string') : [], sourceRange: { start, end } };
  });
  for (const [number, end] of cursors) if (rows.find(row => row.episode.number === number)!.episode.content.slice(end).trim()) {
    throw new LightSceneSourceError(`第${number}集末尾原文尚未定位到场次，完整正文仍保留。`);
  }
  return scenes;
}
export type LightScene = Awaited<ReturnType<typeof loadLightScenes>>[number];

export function lightSceneInput(index: SourceIndex, scenes: LightScene[], scope: number[]) {
  const source = buildNumberedSource(index, scope);
  return scenes.filter(scene => scope.includes(scene.episode)).map(({ sourceRange, ...scene }) => {
    const lines = source.episodes.find(episode => episode.number === scene.episode)!.lines;
    let offset = 0, startLine = 1, endLine = 1;
    for (const [line, text] of lines) {
      if (offset <= sourceRange.start) startLine = line;
      if (offset <= Math.max(sourceRange.start, sourceRange.end - 1)) endLine = line;
      offset += text.length;
    }
    return { ...scene, sourceLines: { startLine, endLine } };
  });
}
export function collectLightSceneIssues(catalog: ProductionCatalog, scenes: LightScene[], scope?: number[]): FoundationIssue[] {
  const known = new Set(scenes.map(scene => `${scene.episode}:${scene.sceneKey}`));
  return catalog.assets.flatMap(asset => [asset, ...asset.variants].flatMap(item => {
    const episodes = ('usageEpisodes' in item ? item.usageEpisodes : item.episodes).filter(number => !scope || scope.includes(number));
    const refs = (item.sceneRefs ?? []).filter(ref => !scope || scope.includes(ref.episode)), missing = episodes.filter(episode => !refs.some(ref => ref.episode === episode));
    const invalid = refs.some(ref => !known.has(`${ref.episode}:${ref.sceneKey}`));
    return missing.length || invalid ? [{ severity: 'MAJOR' as const, owner: 'PROGRAM' as const, coordinate: `assets.${item.key}.sceneRefs`,
      problem: invalid ? '场次引用不存在，须指向本集实际场次。' : `第${missing.join('、')}集的实际使用尚未定位到场次。`, sourceRefs: [] }] : [];
  }));
}
export function assertLightScenePatches(patches: SceneFieldPatch[], scenes: Pick<LightScene, 'episode' | 'sceneKey'>[], scope: number[]) {
  for (const [index, patch] of patches.entries()) if (!scope.includes(patch.episode) || !scenes.some(scene => scene.episode === patch.episode && scene.sceneKey === patch.sceneKey)) {
    throw new FoundationContractError('场次修正必须指向本次原文中的实际场次。', [{ severity: 'BLOCKER', owner: 'PROGRAM', coordinate: `changes.scenes.${index}.sceneKey`, problem: '未知或越出本批的场次', sourceRefs: [] }]);
  }
}
export async function applyLightScenePatches(projectId: string, db: Db, patches: SceneFieldPatch[], expected: LightScene[]) {
  assertLightScenePatches(patches, expected, [...new Set(expected.map(scene => scene.episode))]);
  for (const patch of patches) {
    const row = await db.scriptScene.findFirstOrThrow({ where: { sceneKey: patch.sceneKey, episode: { projectId, number: patch.episode } } });
    const meta = foundationJson(row.metadata), previous = foundationJson(JSON.stringify(meta.sourceFieldPatch ?? {}));
    const { episode: _episode, sceneKey: _sceneKey, characters, ...fields } = patch;
    const values = { ...foundationJson(JSON.stringify(previous.fields ?? {})), ...fields, ...(characters === undefined ? {} : { characters }) };
    await db.scriptScene.update({ where: { id: row.id }, data: { ...fields, metadata: JSON.stringify({ ...meta, ...(characters === undefined ? {} : { characters }),
      sourceFieldPatch: { sourceHash: createHash('sha256').update(row.sourceText).digest('hex'), fields: values } }) } });
  }
}

/** A short previous-scene receipt, not an AI synopsis or automatic state inheritance. */
export function buildLightBoundaryContext(index: SourceIndex, catalog: ProductionCatalog | null, scenes: LightScene[], scope: number[], options: { legacy?: boolean; episodeBoundary?: EpisodeBoundarySeed } = {}) {
  if (!scope.length) return null;
  const first = Math.min(...scope), current = index.episodes.find(episode => episode.number === first);
  const previous = index.episodes.filter(episode => episode.number < first).at(-1);
  const scene = previous && scenes.filter(scene => scene.episode === previous.number).at(-1);
  if (!current || !previous) return null;
  const seed = options.episodeBoundary ?? buildEpisodeBoundarySeed(index, scenes, first, { knownSpeakers: knownScriptSpeakers(catalog) });
  const previousSource = seed.previousSource!;
  const gaps: string[] = [];
  if (previous.number + 1 !== first) gaps.push(`第${previous.number}集与第${first}集不相邻，中间来源缺失，不推断连续状态。`);
  if (!scene) gaps.push('前一集末场尚未定位到已保存场次；已从标准结构或完整原文节点回退，未将整集冒充前场。');
  if (previousSource.clipped) gaps.push('前场原文过长，仅提供完整尾部节点；可能缺少前文，不是完整前场引述。');
  if (previousSource.budgetExceeded) gaps.push('单个完整源节点超过软预算，保留全文，未按字符硬截。');
  const firstScene = scenes.find(scene => scene.episode === first), firstText = firstScene ? current.content.slice(firstScene.sourceRange.start, firstScene.sourceRange.end) : '';
  if (!firstScene) gaps.push('本集首场尚未定位，不用整集正文推断相关旧状态。');
  const inPreviousScene = (refs?: { episode: number; sceneKey: string }[]) => Boolean(scene && refs?.some(ref => ref.episode === previous.number && ref.sceneKey === scene.sceneKey));
  const inCurrentScene = (refs?: { episode: number; sceneKey: string }[]) => Boolean(firstScene && refs?.some(ref => ref.episode === first && ref.sceneKey === firstScene.sceneKey));
  const priorStates = (catalog?.assets ?? []).filter(asset => {
    if (!(inPreviousScene(asset.sceneRefs) || asset.variants.some(variant => inPreviousScene(variant.sceneRefs)))) return false;
    const nameMatch = [asset.name, asset.name.split(/[|｜]/)[0], ...asset.aliases].some(name => name && (firstScene?.characters.includes(name) || name.length > 1 && firstText.includes(name)));
    if (options.legacy) return asset.type === 'LOC' || nameMatch;
    // Names cannot transfer state between distinct catalog identities. Current refs are mandatory.
    return (inCurrentScene(asset.sceneRefs) || asset.variants.some(variant => inCurrentScene(variant.sceneRefs))) && (asset.type === 'PROP' || asset.type === 'LOC' || nameMatch);
  })
    .map(asset => ({ assetKey: asset.key, name: asset.name, type: asset.type, preparation: asset.preparation,
      variants: asset.variants.filter(variant => inPreviousScene(variant.sceneRefs)).map(variant => ({ key: variant.key, name: variant.name, note: variant.note, preparation: variant.preparation })) }));
  return { previousSource: { ...previousSource, sceneKey: scene ? previousSource.sceneKey : null,
    adjacentEpisode: previous.number + 1 === first }, priorStates, gaps };
}

type LightAssetIdentity = { key: string; baseKey: string; name: string; type: ProductionCatalog['assets'][number]['type']; kind: 'BASE' | 'VARIANT'; preparation?: Preparation };

export async function buildLightEpisodePackets(projectId: string, document: FoundationDocument, db: Db, scope?: number[], input?: Awaited<ReturnType<typeof loadFoundationInputs>>, options: {protocol?: ScriptInputProtocol; episodeEvidenceVersion?: 'episode-evidence-v1' | null}&ScriptPerformanceOptions = {}) {
  if (input && input.project.id !== projectId) throw new Error('交接输入不属于当前项目。');
  const [episodes, sourceContext] = input ? [input.project.episodes, input.sourceContext] : await Promise.all([db.episode.findMany({ where: { projectId }, orderBy: { number: 'asc' } }), loadFoundationSourceContext(projectId, db)]);
  if (scope?.some(number => !Number.isSafeInteger(number) || !episodes.some(episode => episode.number === number))) throw new Error('交接集号不存在。');
  const index = input?.sourceIndex ?? buildSourceIndex(episodes);
  assertSourceVersion(index, document.sourceVersion);
  const legacy = options.protocol === 'legacy';
  const postColonCue = options.protocol !== 'standard-episode-v1';
  const syntax=options.protocol==='standard-episode-v1'?'legacy':'current';
  const factStore = cachedFoundationFacts(index, sourceContext, document.f2, {standard: !legacy, resolutions: input?.scriptResolutions, postColonCue,syntax,inlinePerformance:options.inlinePerformance,inlinePerformanceVersion:options.inlinePerformanceVersion,sourceRegroupVersion:options.sourceRegroupVersion});
  const choices = await loadFoundationChoices(db, projectId, index.version);
  if (document.editorialTodos.some(todo=>todo.applicationScope || todo.evidenceRefs?.length)) {
    const sceneRefs = await db.scriptScene.findMany({where:{episode:{projectId}},select:{sceneKey:true,episode:{select:{number:true}}}});
    assertUnresolvedSourceScopes({unresolved:document.editorialTodos},index,index.episodes.map(e=>e.number),sceneRefs.map(s=>({episode:s.episode.number,sceneKey:s.sceneKey})));
  }
  const loadedScenes = new Map<number, Promise<{ scenes: LightScene[]; gaps: string[] }>>();
  const readScenes = (number: number) => {
    if (!loadedScenes.has(number)) loadedScenes.set(number, loadLightScenes(projectId, db, [number]).then(scenes => ({ scenes, gaps: scenes.length ? [] : [`第${number}集场次尚未定位，完整原文仍可读取。`] })).catch(error => {
      if (!(error instanceof LightSceneSourceError)) throw error;
      return { scenes: [], gaps: [error.message] };
    }));
    return loadedScenes.get(number)!;
  };
  return Promise.all(episodes.filter(episode => scope === undefined || scope.includes(episode.number)).map(async episode => {
    const previous = episodes.filter(other => other.number < episode.number).at(-1);
    const [currentScenes, previousScenes] = await Promise.all([readScenes(episode.number), previous ? readScenes(previous.number) : Promise.resolve({ scenes: [], gaps: [] })]);
    const boundaryScenes = [...previousScenes.scenes, ...currentScenes.scenes];
    const episodeBoundary = buildEpisodeBoundarySeed(index, boundaryScenes, episode.number, { resolutions: input?.scriptResolutions, knownSpeakers: knownScriptSpeakers(document.f2), syntax,inlinePerformance:options.inlinePerformance,inlinePerformanceVersion:options.inlinePerformanceVersion,sourceRegroupVersion:options.sourceRegroupVersion });
    episodeBoundary.unknowns.push(...previousScenes.gaps, ...currentScenes.gaps);
    const boundaryContext = buildLightBoundaryContext(index, document.f2, boundaryScenes, [episode.number], {legacy, episodeBoundary});
    if (boundaryContext) boundaryContext.gaps.push(...previousScenes.gaps);
    const catalogProjection = document.f2?.coverage.includes(episode.number) ? projectProductionCatalog(document.f2, [episode.number]) : null;
    const assets = catalogProjection?.assets ?? [], materialCandidates = catalogProjection?.materialCandidates ?? [];
    const identities = new Map<string, LightAssetIdentity>((document.f2?.assets ?? []).flatMap(asset => [
      { key: asset.key, baseKey: asset.key, name: asset.name, type: asset.type, kind: 'BASE' as const, preparation: asset.preparation },
      ...asset.variants.map(variant => ({ key: variant.key, baseKey: asset.key, name: `${asset.name} · ${variant.name}`, type: asset.type, kind: 'VARIANT' as const, preparation: variant.preparation }))
    ]).map(item => [item.key, item]));
    const currentKeys = new Set(assets.flatMap(asset => [asset.key!, ...asset.variants.map(variant => variant.key!)]));
    const materialDependencies: (LightAssetIdentity & { use: 'MATERIAL_SOURCE_ONLY' })[] = [], visited = new Set<string>();
    const visit = (key: string) => {
      if (visited.has(key)) return;
      visited.add(key);
      const item = identities.get(key);
      if (!item) return;
      if (!currentKeys.has(key)) materialDependencies.push({ ...structuredClone(item), use: 'MATERIAL_SOURCE_ONLY' });
      if (item.preparation?.mode === 'DERIVE') {
        const source = item.preparation.fromKey ?? (item.kind === 'VARIANT' ? item.baseKey : undefined);
        if (source) visit(source);
      }
    };
    for (const key of currentKeys) visit(key);
    return { schema: 'LIGHT_EPISODE_SUPPLY_V2' as const, documentRevision: document.revision, sourceVersion: document.sourceVersion,
      ...(!legacy ? prepareEpisodeReception(episode, document.f2, input?.scriptResolutions?.[episode.number], {postColonCue,syntax,inlinePerformance:options.inlinePerformance,inlinePerformanceVersion:options.inlinePerformanceVersion,sourceRegroupVersion:options.sourceRegroupVersion}) : {}),
      episode: episode.number, title: episode.title, sourceText: episode.content,
      ...(options.episodeEvidenceVersion ? {episodeEvidenceVersion: options.episodeEvidenceVersion,
        historicalSourceDirectory: index.episodes.filter(e=>e.number<episode.number).map(e=>[e.number,e.title??'',e.content.length])} : {}),
      sourceContextVersion: sourceContext.version, facts: selectFoundationFacts(factStore, index, [episode.number], {historyMode: options.episodeEvidenceVersion ? 'episode' : 'full'}),
      productionEligible: true, materialStatus: 'TEXT_ONLY' as const,
      scenes: currentScenes.scenes.map(scene => {
        const matches = (refs?: { episode: number; sceneKey: string }[]) => refs?.some(ref => ref.episode === episode.number && ref.sceneKey === scene.sceneKey);
        return { ...scene, decisions: choices.confirmed.filter(c=>scopeApplies(readApplicationScope(c.applicationScope, c.episodes), episode.number, scene.sceneKey)), followUps: document.editorialTodos.filter(todo=>unresolvedOwner(todo) === 'STAGE2' && scopeApplies(readApplicationScope(todo.applicationScope, unresolvedEpisodeScope(todo)), episode.number, scene.sceneKey)), assetKeys: assets.flatMap(asset => {
          const variants = asset.variants.filter(variant => matches(variant.sceneRefs));
          return [...(matches(asset.sceneRefs) || variants.length ? [asset.key!] : []), ...variants.map(variant => variant.key!)];
        }) };
      }), assets, materialDependencies, materialCandidates, gaps: currentScenes.gaps, warnings: sourceContext.notices.map(notice => notice.message),
      boundaryContext, episodeBoundary,
      decisions: choices.confirmed.filter(c=>scopeApplies(readApplicationScope(c.applicationScope, c.episodes), episode.number)),
      followUps: document.editorialTodos.filter(todo => unresolvedOwner(todo) === 'STAGE2' && scopeApplies(readApplicationScope(todo.applicationScope, unresolvedEpisodeScope(todo)), episode.number)).map(todo => ({ ...todo, applicationScope: readApplicationScope(todo.applicationScope, unresolvedEpisodeScope(todo)), sourceVersion: document.sourceVersion })) };
  }));
}

export type LightEpisodePacket = Awaited<ReturnType<typeof buildLightEpisodePackets>>[number];
export function resolveLightAsset(packet: LightEpisodePacket, key: string) {
  for (const asset of packet.assets) {
    if (asset.key === key) return { key, baseKey: key, name: asset.name, type: asset.type, kind: 'BASE' as const, preparation: asset.preparation };
    const variant = asset.variants.find(variant => variant.key === key);
    if (variant) return { key, baseKey: asset.key!, name: `${asset.name} · ${variant.name}`, type: asset.type, kind: 'VARIANT' as const, preparation: variant.preparation };
  }
  return packet.materialDependencies.find(item => item.key === key) ?? null;
}
