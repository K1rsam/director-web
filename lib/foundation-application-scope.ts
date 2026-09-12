/** One fail-closed scope contract for preparation, handoff and production. */
export type ApplicationScope = { kind: 'GLOBAL'; reason: string } | { kind: 'EPISODES'; episodes: number[] } | { kind: 'SCENES'; scenes: { episode: number; sceneKey: string }[] } | { kind: 'UNRESOLVED' };
export type ChoiceEvidenceRef = { sourceVersion: string; episode: number; sceneKey?: string; startLine?: number; endLine?: number; nodeId?: string };
export function readApplicationScope(value: unknown, legacyEpisodes: readonly number[] = []): ApplicationScope {
  if (value == null) return legacyEpisodes.length ? { kind: 'EPISODES', episodes: [...new Set(legacyEpisodes)].sort((a,b)=>a-b) } : { kind: 'UNRESOLVED' };
  const row = value as ApplicationScope;
  if (row.kind === 'UNRESOLVED') return { kind: 'UNRESOLVED' };
  if (row.kind === 'GLOBAL' && typeof row.reason === 'string' && row.reason.trim()) return { kind: 'GLOBAL', reason: row.reason.trim() };
  if (row.kind === 'EPISODES' && Array.isArray(row.episodes) && row.episodes.length && row.episodes.every(n => Number.isSafeInteger(n) && n >= 0)) return { kind: 'EPISODES', episodes: [...new Set(row.episodes)].sort((a,b)=>a-b) };
  if (row.kind === 'SCENES' && Array.isArray(row.scenes) && row.scenes.length && row.scenes.every(s => Number.isSafeInteger(s.episode) && s.episode >= 0 && typeof s.sceneKey === 'string' && s.sceneKey.trim())) return { kind: 'SCENES', scenes: [...new Map(row.scenes.map(s=>[`${s.episode}:${s.sceneKey}`, {episode:s.episode,sceneKey:s.sceneKey}])).values()].sort((a,b)=>a.episode-b.episode || a.sceneKey.localeCompare(b.sceneKey)) };
  throw new Error('适用范围无效；全剧范围须给出理由，场次范围须明确集号和场号。');
}
export function scopeEpisodes(scope: ApplicationScope, all: readonly number[] = []): number[] {
  return scope.kind === 'GLOBAL' ? [...all] : scope.kind === 'EPISODES' ? scope.episodes : scope.kind === 'SCENES' ? [...new Set(scope.scenes.map(s=>s.episode))] : [];
}
export function scopeApplies(scope: ApplicationScope, episode: number, sceneKey?: string): boolean {
  return scope.kind === 'GLOBAL' || scope.kind === 'EPISODES' && scope.episodes.includes(episode) || scope.kind === 'SCENES' && scope.scenes.some(s=>s.episode === episode && (sceneKey === undefined || s.sceneKey === sceneKey));
}
/** Subtract prior consent without converting a scene decision into episode/global consent. */
export function uncoveredApplicationScope(proposed: ApplicationScope, confirmed: readonly ApplicationScope[], allEpisodes: readonly number[] = []): ApplicationScope | null {
  if (proposed.kind === 'UNRESOLVED') return proposed;
  if (confirmed.some(s=>s.kind === 'GLOBAL')) return null;
  if (proposed.kind === 'SCENES') {
    const scenes = proposed.scenes.filter(ref=>!confirmed.some(s=>scopeApplies(s,ref.episode,ref.sceneKey)));
    return scenes.length ? {kind:'SCENES',scenes} : null;
  }
  // Scene-only consent cannot satisfy a request for the entire episode.
  const covered = confirmed.flatMap(s=>s.kind === 'EPISODES' ? s.episodes : []);
  if (!covered.length) return proposed;
  const episodes = scopeEpisodes(proposed,allEpisodes).filter(n=>!covered.includes(n));
  return episodes.length ? {kind:'EPISODES',episodes} : null;
}
export function readChoiceEvidence(value: unknown, sourceVersion?: string): ChoiceEvidenceRef[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('证据位置须为数组。');
  return value.map(item => {
    const r = item as ChoiceEvidenceRef;
    if (!r || typeof r.sourceVersion !== 'string' || !r.sourceVersion || sourceVersion && r.sourceVersion !== sourceVersion || !Number.isSafeInteger(r.episode) || r.episode < 0 || r.sceneKey !== undefined && (typeof r.sceneKey !== 'string' || !r.sceneKey) || r.startLine !== undefined && (!Number.isSafeInteger(r.startLine) || r.startLine < 1 || !Number.isSafeInteger(r.endLine) || r.endLine! < r.startLine)) throw new Error('证据位置或来源版本无效。');
    return structuredClone(r);
  });
}
export function storedApplicationScope(row: { note?: string | null; scopeMode?: string | null; targetEpisodeNumbers?: string | null }, anchor?: number, sourceVersion?: string): ApplicationScope {
  try {
    const meta = JSON.parse(row.note ?? 'null');
    if (meta?.schema === 'FOUNDATION_HUMAN_CHOICE_V1') {
      if (sourceVersion && meta.sourceVersion !== sourceVersion) return { kind: 'UNRESOLVED' };
      if (meta.applicationScope) return readApplicationScope(meta.applicationScope);
      if (row.scopeMode === 'ALL_EPISODES') return { kind: 'GLOBAL', reason: '旧记录明确指定全剧' };
      if (Array.isArray(meta.episodes) && meta.episodes.length) return readApplicationScope(undefined, meta.episodes);
    }
    if (row.scopeMode === 'ALL_EPISODES') return { kind: 'GLOBAL', reason: '旧记录明确指定全剧' };
    const numbers = JSON.parse(row.targetEpisodeNumbers || '[]');
    if (Array.isArray(numbers) && numbers.length) return readApplicationScope({ kind: 'EPISODES', episodes: numbers });
    return readApplicationScope(undefined, anchor === undefined ? [] : [anchor]);
  } catch { return { kind: 'UNRESOLVED' }; }
}
