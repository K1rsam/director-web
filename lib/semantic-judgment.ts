import { createHash } from "node:crypto";

// Server-side boundary only: no environment reads, credential storage or inference at import time.
export type SemanticJson = null | boolean | number | string | SemanticJson[] | { [key: string]: SemanticJson };
export type SemanticDescription = string | SemanticJson[] | { [key: string]: SemanticJson };
export type SemanticScope = { accountId: string; projectId: string; sourceVersion: string; questionVersion: string };
export type SemanticQuestion = { instructions: SemanticDescription } & (
  | { type: "choice"; criteria: Record<string, SemanticDescription | null>; candidateCoverage?: "complete-set" }
  | { type: "noul"; criteria?: { true: SemanticDescription; false: SemanticDescription } }
  | { type: "score"; criteria: SemanticDescription[] }
);
export type SemanticJudgmentRequest = {
  scope: SemanticScope;
  state: SemanticDescription;
  /** Independent questions only; ids are routing keys, not model-visible instructions. */
  questions: Record<string, SemanticQuestion>;
};
export type SemanticAnswer =
  | { type: "choice"; choice: string; probabilities: Record<string, number> | null; confidence: number | null }
  | { type: "noul"; noul: number | null; decision: boolean | null }
  | { type: "score"; score: number; probabilities: Record<string, number> | null; confidence: number | null; legend: Record<string, SemanticDescription> | null };
export type SemanticProbabilityKind = "jev-distribution" | "self-reported" | "none";
export type SemanticReason = "disabled" | "missing_api_key" | "invalid_config" | "invalid_request" | "invalid_response" | "response_too_large" | "http_error" | "network_error" | "timeout" | "uncalibrated" | "unresolved_choice" | "policy_mismatch" | "invalid_policy" | "threshold_not_met" | "calibrated_policy";
export type SemanticJudgmentResult = {
  /** complete means the explicit gate passed, never that a model's answer is true. */
  status: "complete" | "review" | "unavailable" | "failed";
  reason: SemanticReason;
  scope: SemanticScope | null;
  requestFingerprint: string | null;
  providerId: string;
  probabilityKind: SemanticProbabilityKind;
  model: string | null;
  answers: Record<string, SemanticAnswer> | null;
  usage: { inputTokens: number | null; outputTokens: number | null };
  httpStatus: number | null;
  policyVersion: string | null;
};
export interface SemanticProvider { evaluate(request: SemanticJudgmentRequest): Promise<SemanticJudgmentResult> }
export type SemanticGateThreshold =
  | { type: "choice"; minProbability: number; minConfidence: number }
  | { type: "noul"; noAtMost: number; yesAtLeast: number }
  | { type: "score"; minConfidence: number };
export type SemanticGatePolicy = {
  policyVersion: string; calibrationId: string; providerId: string; modelVersion: string; questionVersion: string;
  thresholds: Record<string, SemanticGateThreshold>;
};

const object = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const count = (v: unknown): number | null => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
const sameKeys = (v: unknown, keys: string[]) => object(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
function json(v: unknown, seen = new Set<unknown>()): boolean {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if ((!Array.isArray(v) && !object(v)) || seen.has(v) || seen.size > 64) return false;
  seen.add(v);
  const valid = (Array.isArray(v) ? Array.from(v) : Object.values(v)).every(item => json(item, seen));
  seen.delete(v);
  return valid;
}
const description = (v: unknown) => text(v) || ((Array.isArray(v) || object(v)) && Object.keys(v).length > 0 && json(v));
const canonical = (v: unknown): string => JSON.stringify(v, (_key, item) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(k => [k, item[k]])) : item);
const digest = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex");
const scopeKeys = ["accountId", "projectId", "sourceVersion", "questionVersion"];
function requestData(r: SemanticJudgmentRequest): SemanticJudgmentRequest {
  return { scope: { ...r.scope }, state: r.state, questions: Object.fromEntries(Object.entries(r.questions).map(([id, q]) => [id, {
    type: q.type, instructions: q.instructions, ...(q.criteria === undefined ? {} : { criteria: q.criteria }),
    ...(q.type === "choice" && q.candidateCoverage ? { candidateCoverage: q.candidateCoverage } : {})
  }])) as Record<string, SemanticQuestion> };
}
function validRequest(r: SemanticJudgmentRequest): boolean {
  if (!object(r) || !sameKeys(r.scope, scopeKeys) || !scopeKeys.every(k => text(r.scope[k as keyof SemanticScope])) || !description(r.state) || !object(r.questions) || !Object.keys(r.questions).length) return false;
  return Object.entries(r.questions).every(([id, q]) => {
    if (!text(id) || !object(q) || !description(q.instructions)) return false;
    if (q.type === "noul") return q.criteria === undefined || (sameKeys(q.criteria, ["true", "false"]) && Object.values(q.criteria!).every(description));
    if (q.type === "score") return Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10 && Array.from(q.criteria).every(description);
    if (q.type !== "choice" || !object(q.criteria)) return false;
    const keys = Object.keys(q.criteria);
    return keys.length > 0 && keys.length <= 255 && keys.every(text) && Object.values(q.criteria).every(v => v === null || description(v))
      && (q.candidateCoverage === undefined || q.candidateCoverage === "complete-set")
      && (q.candidateCoverage === "complete-set" || keys.some(k => /^(none|unknown)$/i.test(k)));
  });
}
/** Custom providers use this binding instead of duplicating request normalization; invalid requests return null. */
export function semanticRequestFingerprint(request: SemanticJudgmentRequest): string | null {
  return validRequest(request) ? digest(requestData(request)) : null;
}
function base(r: SemanticJudgmentRequest, providerId: string, probabilityKind: SemanticProbabilityKind): SemanticJudgmentResult {
  const requestFingerprint = semanticRequestFingerprint(r);
  return { status: "review", reason: "uncalibrated", scope: requestFingerprint ? { ...r.scope } : null, requestFingerprint,
    providerId, probabilityKind, model: null, answers: null, usage: { inputTokens: null, outputTokens: null }, httpStatus: null, policyVersion: null };
}
const failed = (result: SemanticJudgmentResult, reason: SemanticReason, httpStatus: number | null = null): SemanticJudgmentResult => ({ ...result, status: "failed", reason, answers: null, policyVersion: null, httpStatus });
function distribution(v: unknown, keys: string[]): v is Record<string, number> {
  return sameKeys(v, keys) && Object.values(v as Record<string, number>).every(probability)
    && Math.abs(Object.values(v as Record<string, number>).reduce((sum, p) => sum + p, 0) - 1) <= 1e-6;
}
function matchesLevel(expected: SemanticDescription, actual: unknown): boolean {
  if (typeof expected === "string") return actual === expected;
  // Structured levels must be the same JSON value (or its JSON-encoded string), never a free-text summary.
  if (typeof actual === "string") {
    try { actual = JSON.parse(actual); } catch { return false; }
  }
  return description(actual) && canonical(actual) === canonical(expected);
}
function answerFor(q: SemanticQuestion, value: unknown, kind: SemanticProbabilityKind): SemanticAnswer | null {
  if (!object(value) || value.type !== q.type) return null;
  const jev = kind === "jev-distribution";
  if (q.type === "noul") {
    if (jev ? !probability(value.noul) || value.decision !== null :
      (value.noul !== null && !probability(value.noul)) || (value.decision !== null && typeof value.decision !== "boolean") || (value.noul === null && value.decision === null)) return null;
    if (kind === "none" && value.noul !== null) return null;
    return { type: "noul", noul: value.noul, decision: value.decision };
  }
  const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
  if ((jev || value.probabilities !== null) && !distribution(value.probabilities, keys)) return null;
  if ((jev || value.confidence !== null) && !probability(value.confidence)) return null;
  if (kind === "none" && (value.probabilities !== null || value.confidence !== null)) return null;
  if (q.type === "choice") {
    if (typeof value.choice !== "string" || !keys.includes(value.choice)) return null;
    if (value.probabilities && Object.values<number>(value.probabilities).some(p => p > value.probabilities[value.choice] + 1e-6)) return null;
    return { type: "choice", choice: value.choice, probabilities: value.probabilities ? { ...value.probabilities } : null, confidence: value.confidence };
  }
  if (typeof value.score !== "number" || !Number.isFinite(value.score) || value.score < 0 || value.score > keys.length - 1) return null;
  if ((jev || value.legend !== null) && (!sameKeys(value.legend, keys) || !q.criteria.every((level, i) => matchesLevel(level, value.legend[String(i)])))) return null;
  if (value.probabilities && Math.abs(keys.reduce((sum, k) => sum + Number(k) * value.probabilities[k], 0) - value.score) > 1e-6) return null;
  return { type: "score", score: value.score, probabilities: value.probabilities ? { ...value.probabilities } : null, confidence: value.confidence,
    legend: value.legend ? Object.fromEntries(q.criteria.map((level, i) => [String(i), structuredClone(level)])) : null };
}

/** Validate any provider's common result. This checks structure/provenance, not semantic truth. */
export function validateSemanticResult(request: SemanticJudgmentRequest, candidate: unknown): SemanticJudgmentResult {
  const result = base(request, object(candidate) && text(candidate.providerId) ? candidate.providerId : "unknown", "none");
  if (!validRequest(request)) return failed(result, "invalid_request");
  if (!object(candidate) || !sameKeys(candidate.scope, scopeKeys) || !scopeKeys.every(k => text(candidate.scope[k])) || canonical(candidate.scope) !== canonical(request.scope) || candidate.requestFingerprint !== result.requestFingerprint) return failed(result, "invalid_response");
  if (!["jev-distribution", "self-reported", "none"].includes(candidate.probabilityKind) || (candidate.probabilityKind === "jev-distribution" && candidate.providerId !== "jev")) return failed(result, "invalid_response");
  result.probabilityKind = candidate.probabilityKind;
  result.model = text(candidate.model) ? candidate.model : null;
  result.usage = { inputTokens: count(candidate.usage?.inputTokens), outputTokens: count(candidate.usage?.outputTokens) };
  if (candidate.status === "failed" && ["invalid_config", "invalid_request", "invalid_response", "response_too_large", "http_error", "network_error", "timeout"].includes(candidate.reason))
    return failed(result, candidate.reason, Number.isInteger(candidate.httpStatus) && candidate.httpStatus >= 100 && candidate.httpStatus <= 599 ? candidate.httpStatus : null);
  if (candidate.status === "unavailable" && ["disabled", "missing_api_key"].includes(candidate.reason)) return { ...result, status: "unavailable", reason: candidate.reason };
  if (!["complete", "review"].includes(candidate.status) || (result.probabilityKind === "jev-distribution" && !result.model) || !sameKeys(candidate.answers, Object.keys(request.questions))) return failed(result, "invalid_response");
  const answers: Record<string, SemanticAnswer> = {};
  for (const [id, question] of Object.entries(request.questions)) {
    const answer = answerFor(question, candidate.answers[id], result.probabilityKind);
    if (!answer) return failed(result, "invalid_response");
    Object.defineProperty(answers, id, { value: answer, enumerable: true, configurable: true, writable: true });
  }
  const unresolved = Object.values(answers).some(answer => answer.type === "choice" && /^(none|unknown)$/i.test(answer.choice.trim()));
  return { ...result, answers, reason: unresolved ? "unresolved_choice" : "uncalibrated" };
}

/** No default thresholds; a calibration reference is a caller assertion, not proof supplied by this module. */
export function gateSemanticResult(request: SemanticJudgmentRequest, candidate: unknown, policy?: SemanticGatePolicy): SemanticJudgmentResult {
  const result = validateSemanticResult(request, candidate);
  if (result.status !== "review" || result.reason === "unresolved_choice" || !policy) return result;
  if (result.probabilityKind !== "jev-distribution" || result.providerId !== policy.providerId || result.model !== policy.modelVersion || request.scope.questionVersion !== policy.questionVersion)
    return { ...result, reason: "policy_mismatch" };
  if (!text(policy.policyVersion) || !text(policy.calibrationId) || !pinnedModel(policy.providerId, policy.modelVersion) || !sameKeys(policy.thresholds, Object.keys(request.questions))) return { ...result, reason: "invalid_policy" };
  for (const [id, answer] of Object.entries(result.answers!)) {
    const t = policy.thresholds[id];
    if (!object(t) || t.type !== answer.type) return { ...result, reason: "invalid_policy" };
    let accepted = false;
    if (answer.type === "noul" && t.type === "noul") {
      if (!probability(t.noAtMost) || !probability(t.yesAtLeast) || t.noAtMost >= t.yesAtLeast) return { ...result, reason: "invalid_policy" };
      accepted = answer.noul! <= t.noAtMost || answer.noul! >= t.yesAtLeast;
    } else if (answer.type === "choice" && t.type === "choice") {
      if (!probability(t.minConfidence) || !probability(t.minProbability)) return { ...result, reason: "invalid_policy" };
      accepted = answer.confidence! >= t.minConfidence && answer.probabilities![answer.choice] >= t.minProbability;
    } else if (answer.type === "score" && t.type === "score") {
      if (!probability(t.minConfidence)) return { ...result, reason: "invalid_policy" };
      accepted = answer.confidence! >= t.minConfidence;
    }
    if (!accepted) return { ...result, reason: "threshold_not_met", policyVersion: policy.policyVersion };
  }
  return { ...result, status: "complete", reason: "calibrated_policy", policyVersion: policy.policyVersion };
}

export function createDisabledProvider(): SemanticProvider {
  return { evaluate: async request => ({ ...base(request, "disabled", "none"), status: "unavailable", reason: "disabled" }) };
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export function createJevProvider(options: { apiKey?: string | null; fetch?: typeof fetch; timeoutMs?: number; model?: string }): SemanticProvider {
  return { async evaluate(request) {
    // Rotation applies to the next call only; transport and sanitization share this call's immutable snapshot.
    const { apiKey: rawApiKey, fetch: fetchOverride, timeoutMs: timeoutOverride, model: modelOverride } = options;
    const apiKey = rawApiKey?.trim(), transport = fetchOverride ?? globalThis.fetch;
    const timeoutMs = timeoutOverride ?? 30_000, model = modelOverride ?? "jev-latest";
    const initial = base(request, "jev", "jev-distribution");
    if (!apiKey) return { ...initial, status: "unavailable", reason: "missing_api_key" };
    if (!validRequest(request)) return failed(initial, "invalid_request");
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 || !text(model) || /[\r\n]/.test(rawApiKey ?? "")) return failed(initial, "invalid_config");
    const input = structuredClone(requestData(request)), controller = new AbortController();
    let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    const cancel = () => { void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {}); };
    const deadline = new Promise<SemanticJudgmentResult>(resolve => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); cancel(); resolve(failed(initial, "timeout")); }, timeoutMs);
    });
    try {
      const operation = (async () => {
        const questions = Object.fromEntries(Object.entries(input.questions).map(([id, q]) => [id, {
          type: q.type, instructions: q.instructions, ...(q.criteria === undefined ? {} : { criteria: q.criteria })
        }]));
        response = await transport("https://api.typesafe.ai/v1/systemone", {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ state: input.state, questions, model })
        });
        if (timedOut) { cancel(); return failed(initial, "timeout"); }
        if (!response.ok) { cancel(); return failed(initial, "http_error", response.status); }
        if (!response.body) return failed(initial, "invalid_response");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let body = "", bytes = 0;
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > MAX_RESPONSE_BYTES) { cancel(); controller.abort(); return failed(initial, "response_too_large"); }
          body += decoder.decode(chunk.value, { stream: true });
        }
        const raw: unknown = JSON.parse(body + decoder.decode());
        if (!object(raw)) return failed(initial, "invalid_response");
        const observed = { ...initial, usage: { inputTokens: count(raw.usage?.input_tokens), outputTokens: count(raw.usage?.output_tokens) } };
        if (!text(raw.model) || !/^jev-[a-z0-9][a-z0-9._-]{0,99}$/i.test(raw.model) || raw.model.includes(apiKey)) return failed(observed, "invalid_response");
        const answers = object(raw.answers) ? Object.fromEntries(Object.entries(raw.answers).map(([id, answer]) => [id,
          object(answer) && answer.type === "noul" ? { type: "noul", noul: answer.noul, decision: null } : answer])) : raw.answers;
        const result = validateSemanticResult(input, { ...observed, model: raw.model, answers });
        return JSON.stringify(result).includes(apiKey) ? failed(observed, "invalid_response") : result;
      })();
      return await Promise.race([operation, deadline]);
    } catch {
      return failed(initial, timedOut ? "timeout" : response ? "invalid_response" : "network_error");
    } finally {
      clearTimeout(timer);
      if (reader) { cancel(); reader.releaseLock(); } else if (response && !response.bodyUsed) cancel();
    }
  } };
}

function pinnedModel(providerId: string, version: string | null): version is string {
  return text(version) && !/(^|[^a-z0-9])(latest|default|auto|stable)([^a-z0-9]|$)/i.test(version)
    && (providerId !== "jev" || /^jev-\d+\.\d+\.\d+$/.test(version));
}
/** Caller supplies the actual immutable model revision; never cache an unresolved alias. No storage is performed. */
export function buildSemanticCacheKey(request: SemanticJudgmentRequest, options: { providerId: string; modelVersion: string | null; policyVersion: string }): string | null {
  if (!validRequest(request) || !text(options.providerId) || !text(options.policyVersion) || !pinnedModel(options.providerId, options.modelVersion)) return null;
  return `semantic-judgment:v1:${digest({ request: requestData(request), providerId: options.providerId, modelVersion: options.modelVersion, policyVersion: options.policyVersion })}`;
}
