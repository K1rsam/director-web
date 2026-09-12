/** Numeric-only projection; raw provider evidence never crosses this boundary. */
export type FoundationRunUsage = {
  inputTokens: number | null; cachedInputTokens: number | null; uncachedInputTokens: number | null;
  outputTokens: number | null; reasoningOutputTokens: number | null; totalTokens: number | null;
  recordedCalls: number | null; newRequests: number | null; reusedCalls: number | null; unknownCalls: number;
};
function unknownUsage(): FoundationRunUsage {
  return { inputTokens: null, cachedInputTokens: null, uncachedInputTokens: null, outputTokens: null,
    reasoningOutputTokens: null, totalTokens: null, recordedCalls: null, newRequests: null, reusedCalls: null, unknownCalls: 1 };
}
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const zero = (): FoundationRunUsage => ({ inputTokens: 0, cachedInputTokens: 0, uncachedInputTokens: 0, outputTokens: 0,
  reasoningOutputTokens: 0, totalTokens: 0, recordedCalls: 0, newRequests: 0, reusedCalls: 0, unknownCalls: 0 });

function completedUsage(stdout: unknown): FoundationRunUsage | null {
  if (typeof stdout !== "string") return null;
  let result: FoundationRunUsage | null = null;
  let completion: string | null = null;
  for (const line of stdout.split(/\r?\n/)) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!object(event) || event.type !== "turn.completed") continue;
    const value = event.usage;
    if (!object(value) || !integer(value.input_tokens) || !integer(value.output_tokens)) return null;
    const input = value.input_tokens, output = value.output_tokens;
    const cache = value.cached_input_tokens, reasoning = value.reasoning_output_tokens;
    if ((cache !== undefined && (!integer(cache) || cache > input))
      || (reasoning !== undefined && (!integer(reasoning) || reasoning > output)) || !integer(input + output)) return null;
    const next = { ...zero(), inputTokens: input, outputTokens: output, totalTokens: input + output,
      cachedInputTokens: cache === undefined ? null : cache as number,
      uncachedInputTokens: cache === undefined ? null : input - (cache as number),
      reasoningOutputTokens: reasoning === undefined ? null : reasoning as number };
    // Only an identical full completion may repeat, not another turn with equal token counts.
    const serialized = JSON.stringify(event);
    if (completion !== null && completion !== serialized) return null;
    completion = serialized;
    result = next;
  }
  return result;
}

export function summarizeFoundationRunUsage(log: unknown): FoundationRunUsage {
  let evidence = log;
  if (typeof log === "string") { try { evidence = JSON.parse(log); } catch { return unknownUsage(); } }
  if (!object(evidence) || evidence.schema !== "FOUNDATION_RUN_EVIDENCE_V1" || !Array.isArray(evidence.calls)) return unknownUsage();
  if (!evidence.calls.length) return zero(); // Only zero recorded calls, not a claim of perfect storage.
  return aggregateFoundationUsage(evidence.calls.map((call: unknown) => {
    if (!object(call)) return unknownUsage();
    const count = call.providerCallCount === 0 || call.providerCallCount === 1 ? call.providerCallCount : null;
    const reused = count === 0 && object(call.reusedFrom) && typeof call.reusedFrom.runId === "string"
      && call.reusedFrom.runId.length > 0 && integer(call.reusedFrom.sequence) && call.reusedFrom.sequence > 0;
    const local = call.requestOutcome === "NOT_SENT";
    const tokens = reused || local ? zero() : count === 1 && !call.reusedFrom && call.provider === "CLI" && object(call.response)
      ? completedUsage(call.response.stdout) ?? unknownUsage() : unknownUsage();
    return { ...tokens, recordedCalls: 1, newRequests: count, reusedCalls: reused ? 1 : 0 };
  }));
}

export function aggregateFoundationUsage(rows: FoundationRunUsage[]): FoundationRunUsage {
  if (!rows.length) return unknownUsage();
  const known = rows.filter(row => row.totalTokens !== null);
  const sum = (values: Array<number | null>) => {
    if (!values.length || values.some(value => value === null)) return null;
    const total = (values as number[]).reduce((a, b) => a + b, 0);
    return integer(total) ? total : null;
  };
  const totalTokens = sum(known.map(row => row.totalTokens));
  return { inputTokens: sum(known.map(row => row.inputTokens)), cachedInputTokens: sum(known.map(row => row.cachedInputTokens)),
    uncachedInputTokens: sum(known.map(row => row.uncachedInputTokens)), outputTokens: sum(known.map(row => row.outputTokens)),
    reasoningOutputTokens: sum(known.map(row => row.reasoningOutputTokens)), totalTokens,
    recordedCalls: sum(rows.map(row => row.recordedCalls)), newRequests: sum(rows.map(row => row.newRequests)),
    reusedCalls: sum(rows.map(row => row.reusedCalls)),
    unknownCalls: rows.reduce((sum, row) => sum + row.unknownCalls, 0) + (known.length && totalTokens === null ? 1 : 0) };
}
