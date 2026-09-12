/** Read saved response data only. This is neither protocol validation nor recovery eligibility. */
type DraftRun = { id: string; status: string; log: unknown };
type DraftCandidate = { runId: string; id: string } | null;
type DraftState = {
  sourceVersion: string; inputVersion: string;
  planningReady: boolean; assetsReady: boolean; draftComplete?: boolean;
  candidates: { f1: DraftCandidate; f2: DraftCandidate }; review: DraftCandidate;
  latestRuns: { f1: DraftRun | null; f2: DraftRun | null; q1: DraftRun | null };
};
export type FoundationDraftChunk = {
  sequence: number; scope: number[]; status: string;
  data?: unknown; rawOutput?: string;
};
export type FoundationDraft = {
  stageCode: "F1" | "F2" | "Q1"; runId: string; status: string; current: boolean;
  chunks: FoundationDraftChunk[];
};
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const episodeNumber = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function readFoundationDrafts(state: DraftState): FoundationDraft[] {
  const drafts: FoundationDraft[] = [];
  for (const key of ["f1", "f2", "q1"] as const) {
    const run = state.latestRuns[key];
    const candidate = key === "q1" ? state.review : state.candidates[key];
    const candidateCurrent = key === "f1" ? state.planningReady : key === "f2" ? state.assetsReady : state.draftComplete;
    if (!run || !["FAILED", "CANCELED", "RUNNING", "QUEUED"].includes(run.status) || (candidateCurrent && candidate?.runId === run.id)) continue;
    let log: unknown;
    try { log = typeof run.log === "string" ? JSON.parse(run.log) : run.log; } catch { continue; }
    if (!record(log) || log.schema !== "FOUNDATION_RUN_EVIDENCE_V1" || log.runId !== run.id || log.stageCode !== key.toUpperCase() || !Array.isArray(log.calls)) continue;
    const chunks: FoundationDraftChunk[] = [];
    for (const [index, call] of log.calls.entries()) {
      if (!record(call) || !record(call.response)) continue;
      // Keep a separate JSON copy; never return the response envelope or its transport output.
      let data: unknown;
      if (Object.hasOwn(call.response, "data")) {
        try { data = JSON.parse(JSON.stringify(call.response.data)); } catch { /* Non-JSON data is not a saved structured response. */ }
      }
      const rawOutput = typeof call.response.rawOutput === "string" ? call.response.rawOutput : undefined;
      if (data === undefined && !rawOutput) continue;
      chunks.push({
        sequence: typeof call.sequence === "number" && Number.isSafeInteger(call.sequence) && call.sequence > 0 ? call.sequence : index + 1,
        scope: Array.isArray(call.scope) ? call.scope.filter(episodeNumber) : [],
        status: typeof call.status === "string" && ["RUNNING", "SUCCEEDED", "FAILED"].includes(call.status) ? call.status : "UNKNOWN",
        ...(data !== undefined ? { data } : {}), ...(rawOutput !== undefined ? { rawOutput } : {})
      });
    }
    if (!chunks.length) continue;
    const upstream = record(log.upstreamSnapshotIds) ? log.upstreamSnapshotIds : {};
    const current = log.sourceVersion === state.sourceVersion && log.inputVersion === state.inputVersion
      && (key === "f1" || (state.planningReady && upstream.f1 === state.candidates.f1?.id))
      && (key !== "q1" || (state.assetsReady && upstream.f2 === state.candidates.f2?.id));
    drafts.push({ stageCode: key === "f1" ? "F1" : key === "f2" ? "F2" : "Q1", runId: run.id, status: run.status, current, chunks });
  }
  return drafts;
}
