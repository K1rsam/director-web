import { readApplicationScope, scopeEpisodes } from './foundation-application-scope';
import { planFoundationIssueDispatch } from './foundation-issue-dispatch';
import type { FoundationDocument } from './foundation-document';
import type { FoundationChoiceView } from './foundation-choice-store';
import type { LightScene } from './light-foundation-supply';
import type { FoundationIssue, SourceIndex } from './project-foundation-contracts';

export type FoundationPendingProgress = { units: string[] };
/** Count structured unresolved objects in their exact episode/scene scopes.
 * Explanatory prose, generated ids on todos and choice revisions are not progress.
 * Multiplicity is retained: two diagnostics at one coordinate are not one issue. */
export function snapshotFoundationPendingProgress(input: {
  doc: FoundationDocument; scenes: readonly LightScene[]; index: SourceIndex;
  issues: readonly FoundationIssue[]; suggestions: readonly FoundationChoiceView[]; decisions: readonly FoundationChoiceView[];
}): FoundationPendingProgress {
  const dispatch = planFoundationIssueDispatch(input);
  const occurrences = new Map<string, number>();
  const units: string[] = [];
  const add = (identity: unknown, scopes: unknown[]) => {
    for (const scope of scopes.length ? scopes : ['UNRESOLVED']) {
      const basis = JSON.stringify([identity, scope]);
      const occurrence = occurrences.get(basis) ?? 0;
      occurrences.set(basis, occurrence + 1);
      units.push(JSON.stringify([basis, occurrence]));
    }
  };
  const items = [...dispatch.targets.flatMap(target => target.items), ...dispatch.backendItems];
  const episodeScopes = (episode: number) => {
    const keys = [...new Set(input.scenes.filter(scene => scene.episode === episode).map(scene => scene.sceneKey))].sort();
    return keys.length ? keys.map(key => [episode, key]) : [[episode, '*']];
  };
  for (const item of items) {
    const identity = [item.todoId ? 'todo' : 'issue', item.owner, item.coordinate, [...item.keys].sort(), [...item.allowedFields].sort()];
    const scopes = item.episodes.flatMap(episode => {
      const scenes = item.scenes.filter(scene => scene.episode === episode);
      return scenes.length ? scenes.map(scene => [episode, scene.sceneKey]) : episodeScopes(episode);
    });
    add(identity, scopes);
  }
  const all = input.index.episodes.map(episode => episode.number);
  for (const [kind, choices] of [['suggestionCoverage', input.suggestions], ['decisionCoverage', input.decisions]] as const) {
    for (const choice of choices) {
      const scope = readApplicationScope(choice.applicationScope, choice.episodes);
      const recorded = input.doc[kind]?.[choice.id];
      const done = recorded?.revision === choice.revision ? recorded.episodes : [];
      const episodes = scopeEpisodes(scope, all).filter(episode => !done.includes(episode));
      if (!episodes.length && scope.kind !== 'UNRESOLVED') continue;
      const scopes = episodes.flatMap(episode => scope.kind === 'SCENES' ? scope.scenes.filter(scene => scene.episode === episode).map(scene => [episode, scene.sceneKey]) : episodeScopes(episode));
      add([kind, choice.id], scopes);
    }
  }
  return { units: units.sort() };
}

/** A strict subset is evidence of progress. Renaming, replacing or adding an
 * unresolved target cannot make another automatic repair look productive. */
export function foundationPendingProgress(before: FoundationPendingProgress, after: FoundationPendingProgress) {
  const previous = new Set(before.units), remaining = new Set(after.units);
  const resolved = before.units.filter(unit => !remaining.has(unit));
  const added = after.units.filter(unit => !previous.has(unit));
  return { progressed: resolved.length > 0 && added.length === 0, resolved: resolved.length, added: added.length, remaining: after.units.length };
}
