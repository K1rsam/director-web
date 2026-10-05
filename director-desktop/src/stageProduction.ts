import type { Job, SourceRef, Workspace } from './types';

export function record(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function records(value: unknown): Record<string, unknown>[] { return Array.isArray(value) ? value.map(record) : []; }
export function words(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function sourceIds(refs: SourceRef[] | unknown): string[] { return Array.isArray(refs) ? refs.flatMap(ref => typeof ref === 'string' ? [ref] : words(record(ref).lineId) ? [words(record(ref).lineId)] : []) : []; }
export function sourceEvidence(workspace: Workspace, refs: unknown) {
  const ids = new Set(sourceIds(refs));
  return (workspace.source?.rows || []).filter(row => ids.has(row.id));
}
export function matchesStage(value: unknown, stage: 'foundation' | 'storyboard'): boolean { const action = words(value); return action.startsWith(stage) || stage === 'storyboard' && action === 'units.regenerate'; }
export function stageJobs(workspace: Workspace, stage: 'foundation' | 'storyboard'): Job[] {
  return workspace.jobs.filter(job => job.kind === 'workflow' && (matchesStage(record(job.snapshot).stage, stage) || matchesStage(job.entityId, stage) || matchesStage(job.stage, stage)));
}
export function productionDirection(workspace: Workspace): string { return words(workspace.foundation?.productionDirection); }
export function sourceEpisodes(workspace: Workspace) {
  return (workspace.source?.episodes || []).flatMap((episode, index) => episode.id ? [{ ...episode, id: episode.id, title: episode.title || `第 ${episode.number || index + 1} 集` }] : []);
}
