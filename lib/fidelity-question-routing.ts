import { normalize } from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import type { FidelityResult, FidelitySegment } from './fidelity-import';
import type { P1ReviewState } from './fidelity-p1-review';

type QuestionRouting = { kind: 'QUESTION'; basis: 'EXPLICIT_SOURCE_OWNERSHIP'; sourceVersion: string };
type Unresolved = NonNullable<P1ReviewState['unresolved']>[number] & { routing?: QuestionRouting };
const episodeHeading = /^(?:#{1,6}\s*)?第\s*(?:[0-9]+|[零〇一二两三四五六七八九十百千万]+)\s*集(?:\s+(.*))?$/;
const pureEpisodeHeading = (text: string) => {
  const match = text.trim().match(episodeHeading);
  if (!match) return false;
  const title = (match[1] ?? '').trim();
  return title.length <= 60 && !/[：:△▲。！？!?“”「」\r\n]/.test(title)
    && !/(?:场\s*\d|第\s*[零〇一二两三四五六七八九十百千万\d]+\s*场|\d+\s*[-－.．]\s*\d+)/.test(title);
};
const overlap = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;
const containsBodyText = (segment: FidelitySegment) => segment.speakerLabels.length > 0 || /[△▲。！？!?“”「」]/.test(segment.text);

/** Route informational questions only when the original text independently proves
 * ownership. AI boundary decisions are deliberately excluded from this baseline.
 * This is a local annotation: question wording, kind and source ranges never change. */
export function routeFidelityQuestions(state: P1ReviewState, result: FidelityResult): P1ReviewState {
  if (!state.unresolved?.length) return state;
  let baseline: FidelityResult | null = null;
  try {
    if (result.validation.ok) baseline = normalize(result.source) as FidelityResult;
  } catch { /* Unverifiable source never turns a structural blocker into a question. */ }
  const bounds = new Set(baseline?.segments.flatMap(segment => [segment.start, segment.end]) ?? []);
  const adopted = new Map(result.segments.map(segment => [`${segment.start}:${segment.end}`, segment]));
  const independentlyOwnedEpisodes = new Set(baseline?.segments.filter(segment => segment.text.trim() && segment.episodeId && segment.sceneId && (segment.kind === 'body' || segment.kind === 'format' && !containsBodyText(segment)) && !baseline!.validation.issues.some(issue => overlap(issue, segment))).map(segment => segment.episodeId) ?? []);
  const canRoute = (question: Unresolved) => {
    if (!baseline?.validation.ok || question.kind === 'semantic' || !Number.isInteger(question.start) || !Number.isInteger(question.end) || question.start < 0 || question.end <= question.start || question.end > baseline.source.length || !bounds.has(question.start) || !bounds.has(question.end)) return false;
    if (baseline.validation.issues.some(issue => overlap(issue, question)) || result.validation.issues.some(issue => overlap(issue, question))) return false;
    const rows = baseline.segments.filter(segment => overlap(segment, question));
    if (!rows.some(segment => segment.text.trim()) || rows[0]?.start !== question.start || rows.at(-1)?.end !== question.end) return false;
    if (result.segments.filter(segment => overlap(segment, question)).length !== rows.length) return false;
    return rows.every(segment => {
      const actual = adopted.get(`${segment.start}:${segment.end}`);
      if (!actual || actual.text !== segment.text || actual.episodeId !== segment.episodeId || actual.sceneId !== segment.sceneId) return false;
      const promotedSceneFormat = segment.kind === 'format' && actual.kind === 'body' && !!segment.episodeId && !!segment.sceneId;
      if (actual.kind !== segment.kind && !promotedSceneFormat) return false;
      if (segment.kind === 'body' && actual.productionEligible !== segment.productionEligible) return false;
      if (!segment.text.trim()) return true;
      if (!['body', 'format'].includes(segment.kind) || !segment.episodeId) return false;
      // A standalone episode heading may precede the independently recognized
      // scene. A narrative-bearing header cannot use this exception.
      if (!segment.sceneId) return segment.kind === 'format' && segment.reason === 'explicit_episode_heading' && pureEpisodeHeading(segment.text) && independentlyOwnedEpisodes.has(segment.episodeId);
      // An adopted body preserves all text of an independently owned scene row.
      // The narrative check is only needed when that row remains formatting.
      if (segment.kind === 'format' && !promotedSceneFormat && containsBodyText(segment)) return false;
      return true;
    });
  };
  const unresolved = (state.unresolved as Unresolved[]).map(question => {
    const { routing: _oldRouting, ...original } = question;
    return canRoute(question) ? { ...original, routing: { kind: 'QUESTION' as const, basis: 'EXPLICIT_SOURCE_OWNERSHIP' as const, sourceVersion: baseline!.source.sourceVersion } } : original;
  });
  return { ...state, unresolved };
}
