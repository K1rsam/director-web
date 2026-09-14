import { readApplicationScope, scopeEpisodes } from './foundation-application-scope';
import type { FoundationChoiceView } from './foundation-choice-store';
import type { FoundationDocument } from './foundation-document';
import type { FoundationIssue } from './project-foundation-contracts';

/** Preparation has no decision-id link. Hold only unresolved preparation objects in
 * overlapping declared choice scopes; never infer an answer or an object from prose.
 * Keep diagnostics in the document/state: this filters automatic repair only. */
export function actionableFoundationIssues(doc: Pick<FoundationDocument, 'f2'>, issues: readonly FoundationIssue[], required: readonly Pick<FoundationChoiceView, 'applicationScope' | 'episodes'>[]): FoundationIssue[] {
  if (!required.length) return [...issues];
  const waiting = required.map(choice => readApplicationScope(choice.applicationScope, choice.episodes));
  const entries = doc.f2?.assets.flatMap(asset => [asset, ...asset.variants]) ?? [];
  return issues.filter(issue => {
    const item = entries.find(item => issue.coordinate === `assets.${item.key}.preparation`);
    if (!item || item.preparation && item.preparation.mode !== 'UNRESOLVED') return true;
    const episodes = 'usageEpisodes' in item ? item.usageEpisodes : item.episodes;
    return !waiting.some(scope => {
      if (scope.kind === 'GLOBAL') return true;
      if (scope.kind === 'UNRESOLVED') return false;
      if (!scopeEpisodes(scope).some(n => episodes.includes(n))) return false;
      // Complete declared scene references can prove same-episode independence.
      const refs = item.sceneRefs ?? [];
      if (scope.kind === 'SCENES' && episodes.every(n => refs.some(ref => ref.episode === n)))
        return scope.scenes.some(scene => refs.some(ref => ref.episode === scene.episode && ref.sceneKey === scene.sceneKey));
      return true;
    });
  });
}
