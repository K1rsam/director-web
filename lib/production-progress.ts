/** Read-only evidence projection. No state names, dispatch counts or highest episode number imply adoption. */
import {effectiveEditorialCoverage} from './source-interpretation-adoption-proof';
type Row = Record<string, any>;
export function productionProgress(workflow: Row, foundation: Row, runs: Record<string, Row>, assets: { total: number; ready: number; adopted: number } | null) {
  const scope: number[] = [...new Set<number>(workflow.episodeNumbers)];
  const selected = scope.flatMap(number => {
    const id = workflow.selectedRuns[number], run = runs[id];
    return run && run.id === id && run.episodeNumber === number ? [run] : [];
  });
  const text = selected.filter(run => run.textAdopted === true);
  const quality = new Set((workflow.qualityReviews ?? []).filter((review: Row) => text.some(run => run.id === review.runId && run.episodeNumber === review.episodeNumber
    && run.fingerprint && review.fingerprint === run.fingerprint) && review.authorReviewed === true && review.assemblyReviewed === true && review.majorIssuesResolved === true).map((review: Row) => review.episodeNumber));
  const coverage = (rows: unknown) => Array.isArray(rows) ? scope.filter(number => rows.includes(number)).length : 0;
  return {
    version: 'production-visible-progress-v1' as const,
    scopeKey: JSON.stringify([workflow.id, workflow.sourceVersion, scope]), scopeTotal: scope.length,
    sourceRead: coverage(foundation.document?.f2?.coverage),
    foundationReviewed: foundation.needsContextEdit ? null : coverage(foundation.effectiveEditorialCoverage??effectiveEditorialCoverage(foundation.document)),
    // Q1 catalogue editing is not evidence of full narrative-navigation or per-episode independent review.
    navigationReviewed: null, independentReviewed: null,
    assets, textAdopted: text.length, strictComplete: text.filter(run => run.complete === true).length,
    currentQualityRecords: quality.size,
    inProduction: selected.filter(run => run.busy === true).map(run => ({ episodeNumber: run.episodeNumber as number, stage: run.stage as string | null, inFlight: run.inFlight as number, queued: run.queued as number })),
    blockedEpisodes: selected.filter(run => run.blocked === true || run.sourceStale === true || run.continuityPending === true).map(run => run.episodeNumber as number),
    eta: null,
  };
}
export type ProductionProgress = ReturnType<typeof productionProgress>;
