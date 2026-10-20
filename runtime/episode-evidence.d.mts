export const EPISODE_EVIDENCE_VERSION: 'episode-evidence-v1';
type Evidence = {domain?: string; episode?: number; start: number; end: number};
type Fact = {id: string; subjects: string[]; kind: string; claim?: string; statement?: string; evidence: Evidence; validity?: {status: string}};
export function selectEpisodeEvidence<T extends Fact>(facts: readonly T[], options: {
  scope: number[]; relevant?: (fact: T) => boolean; requestedEvidence?: Evidence[];
}): {anchors: Set<string>; neighbours: Map<string, string[]>; kept: Set<string>};
export function historicalSourceRequest(target: string, currentEpisode: number): {episode: number; start: number | null; end: number | null} | null;
export function buildHistoricalSourceMaterial(target: string, episode: {number: number; content: string} | null, currentEpisode: number): {
  id: string; kind: 'SOURCE_EVIDENCE'; version: string;
  value: {schema: 'HISTORICAL_SOURCE_V1'; target: string; episode: number; sourceVersion: string; offsetUnit: 'UTF16'; sourceRange: {start: number; end: number}; text: string; selectionKind: string; applicability: string; authorityRule: string};
};
