import { readApplicationScope, scopeEpisodes, scopeApplies } from './foundation-application-scope';
/** The preview and later consumers share this read path. It never invokes a model. */
import type { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { loadFoundationInputs, collectFoundationPublicationIssues } from './foundation-state';
import { createEmptyDocument, loadFoundationDocument } from './foundation-document';
import { loadFoundationChoices, type FoundationChoiceView } from './foundation-choice-store';
import { workingReadiness } from './foundation-delivery-assets';
import { unresolvedOwner, unresolvedEpisodeScope } from './foundation-production-contracts';
import { buildLightEpisodePackets, collectLightSceneIssues, resolveLightAsset } from './light-foundation-supply';
import type { ScriptInputProtocol } from './standard-script-reception';

export async function readLightEpisodeFoundation(projectId: string, episodeNumber: number, db: Prisma.TransactionClient = prisma, options: {protocol?: ScriptInputProtocol;inlinePerformance?:boolean} = {}) {
  if (!Number.isSafeInteger(episodeNumber) || episodeNumber < 0) throw new Error('无效的交接集号。');
  const episode = await db.episode.findFirst({ where: { projectId, number: episodeNumber }, select: { id: true } });
  if (!episode) throw new Error('交接集号不存在。');
  const input = await loadFoundationInputs(projectId, db, {includeResolutions: options.protocol === undefined || options.protocol === 'upstream-material-v2'});
  const { document, needsContextEdit } = await loadFoundationDocument(db, projectId, input);
  const [packet] = await buildLightEpisodePackets(projectId, document, db, [episodeNumber], input, options);
  const choices = await loadFoundationChoices(db, projectId, input.sourceVersion, true);
  const currentContext = !needsContextEdit || document.contextCoverage?.fingerprint === createEmptyDocument(input).settingsFingerprint && document.contextCoverage.episodes.includes(episodeNumber);
  const contextPending = !input.sourceContext.complete || !currentContext;
  const remaining = (choice: FoundationChoiceView, field: 'decisionCoverage' | 'suggestionCoverage') => {
    const receipt = document[field]?.[choice.id];
    return { ...choice, episodes: scopeEpisodes(readApplicationScope(choice.applicationScope, choice.episodes), input.sourceIndex.episodes.map(episode => episode.number))
      .filter(number => receipt?.revision !== choice.revision || !receipt.episodes.includes(number)) };
  };
  const outstanding = [
    ...choices.pending.filter(choice => document.requiredDecisionIds.includes(choice.id) || document.reviewedSuggestions[choice.id] !== choice.revision).map(choice => remaining(choice, 'suggestionCoverage')),
    ...choices.confirmed.filter(choice => document.appliedDecisions[choice.id] !== choice.revision).map(choice => remaining(choice, 'decisionCoverage'))
  ].filter(choice => choice.episodes.length);
  const reasons = [
    ...packet.gaps,
    ...(packet.scriptReception?.diagnostics ?? []).map(d => `第${d.line}行：${d.message}`),
    // Unlinked background stays in packet evidence; only actual source gaps or
    // scoped production decisions below affect this episode's readiness.
    // A bounded excerpt is intentional; missing or nonadjacent source is a real handoff gap.
    ...(packet.boundaryContext && (!packet.boundaryContext.previousSource.sceneKey || !packet.boundaryContext.previousSource.adjacentEpisode) ? packet.boundaryContext.gaps : []),
    ...(!document.f2?.coverage.includes(episodeNumber) ? ['本集资产尚未编目。'] : []),
    ...(!document.editorialCoverage.includes(episodeNumber) ? ['本集尚未完成资料编辑。'] : []),
    ...(document.workflow !== 'LIGHT_STAGE1_V1' ? ['旧版工作稿尚未完成当前资料整理。'] : []),
    ...(contextPending ? ['来源或制作条件仍有待处理内容。'] : []),
    ...outstanding.filter(choice => choice.episodes.includes(episodeNumber)).map(choice => `尚未采用或处理：${choice.question}`),
    ...document.editorialTodos.filter(todo => { const scope = readApplicationScope(todo.applicationScope, unresolvedEpisodeScope(todo)); return unresolvedOwner(todo) !== 'STAGE2' && scopeApplies(scope, episodeNumber); }).map(todo => todo.note),
    ...(document.f2 ? collectFoundationPublicationIssues(document.f2,input.sourceContext,input.sourceIndex).filter(issue => {
      if (!['BLOCKER','MAJOR'].includes(issue.severity)) return false;
      if (issue.sourceRefs.length) return issue.sourceRefs.some(ref=>ref.episode===episodeNumber);
      // Unlocated asset issues follow the actual identity/variant scope, not the whole project.
      const entries=document.f2!.assets.flatMap(asset=>[{key:asset.key,episodes:asset.usageEpisodes},...asset.variants.map(variant=>({key:variant.key,episodes:variant.episodes}))]);
      const owner=entries.find(entry=>issue.coordinate===('assets.'+entry.key)||issue.coordinate.startsWith('assets.'+entry.key+'.'));
      if(owner) return owner.episodes.includes(episodeNumber)||packet.materialDependencies.some(item=>item.key===owner.key);
      return true;
    }).map(issue=>issue.problem) : []),
    ...(document.f2 ? collectLightSceneIssues(document.f2, packet.scenes, [episodeNumber]).map(issue => issue.problem) : [])
  ];
  if (document.f2) {
    const readiness = workingReadiness(document, outstanding, contextPending, [episodeNumber]);
    for (const key of [...packet.assets.flatMap(asset => [asset.key!, ...asset.variants.map(variant => variant.key!)]), ...packet.materialDependencies.map(item => item.key)]) {
      for (const reason of readiness.get(key)?.pendingReasons ?? []) reasons.push(`${resolveLightAsset(packet, key)?.name ?? key}：${reason}`);
    }
  }
  for (const scene of packet.scenes) if (scene.assetKeys.some(key => !resolveLightAsset(packet, key))) reasons.push(`场次${scene.sceneKey}仍有未解析资产引用。`);
  return { packet, readiness: reasons.length ? 'PARTIAL' as const : 'READY' as const, reasons: [...new Set(reasons)] };
}
