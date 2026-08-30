/**
 * 表现规范的适用范围。
 *
 * P1 只负责发现需要拍板的非常规表现；用户确认时再决定规则落到发现集、
 * 指定集，还是全部正式集。这样下游任务不会无差别携带整套全剧规则。
 */
export const PRESENTATION_SCOPE_MODES = [
  "SOURCE_EPISODES",
  "SELECTED_EPISODES",
  "ALL_EPISODES"
] as const;

export type PresentationContractScopeMode = (typeof PRESENTATION_SCOPE_MODES)[number];

export type PresentationContractScopeInput = {
  scope_mode?: string | null;
  target_episode_numbers?: number[] | string | null;
  source_episode_number?: number | null;
};

export type ResolvedPresentationContractScope = {
  mode: PresentationContractScopeMode;
  episodeNumbers: number[];
};

export function parsePresentationEpisodeNumbers(value: unknown): number[] {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? (() => {
          const text = value.trim();
          if (!text) return [];
          try {
            const parsed: unknown = JSON.parse(text);
            return Array.isArray(parsed) ? parsed : text.split(/[、,，\s]+/);
          } catch {
            return text.split(/[、,，\s]+/);
          }
        })()
      : [];
  return [...new Set(values
    .map((item) => typeof item === "number" ? item : Number(String(item).trim()))
    .filter((item) => Number.isInteger(item) && item >= 1))]
    .sort((left, right) => left - right);
}

export function normalizePresentationScopeMode(value: unknown): PresentationContractScopeMode {
  return PRESENTATION_SCOPE_MODES.includes(value as PresentationContractScopeMode)
    ? value as PresentationContractScopeMode
    : "SOURCE_EPISODES";
}

export function resolvePresentationContractScope(
  input: PresentationContractScopeInput,
  formalEpisodeNumbers: readonly number[]
): ResolvedPresentationContractScope {
  const formal = parsePresentationEpisodeNumbers(formalEpisodeNumbers);
  const mode = normalizePresentationScopeMode(input.scope_mode);
  if (mode === "ALL_EPISODES") return { mode, episodeNumbers: formal };

  const stored = parsePresentationEpisodeNumbers(input.target_episode_numbers);
  if (stored.length) return { mode, episodeNumbers: stored.filter((number) => formal.includes(number)) };

  if (Number.isInteger(input.source_episode_number) && Number(input.source_episode_number) >= 1) {
    const source = Number(input.source_episode_number);
    return { mode, episodeNumbers: formal.includes(source) ? [source] : [] };
  }

  // 兼容旧数据：没有 episodeId 的项目级规则保持全剧适用，避免历史结果悄悄改变。
  return mode === "SELECTED_EPISODES"
    ? { mode, episodeNumbers: [] }
    : { mode: "ALL_EPISODES", episodeNumbers: formal };
}

export function contractAppliesToEpisode(
  input: PresentationContractScopeInput,
  episodeNumber: number,
  formalEpisodeNumbers: readonly number[] = [episodeNumber]
): boolean {
  const scope = resolvePresentationContractScope(input, formalEpisodeNumbers);
  return scope.mode === "ALL_EPISODES" || scope.episodeNumbers.includes(episodeNumber);
}

export function contractAppliesToAnyEpisode(
  input: PresentationContractScopeInput,
  episodeNumbers: readonly number[],
  formalEpisodeNumbers: readonly number[] = episodeNumbers
): boolean {
  return episodeNumbers.some((number) => contractAppliesToEpisode(input, number, formalEpisodeNumbers));
}

export function formatPresentationEpisodeNumbers(numbers: readonly number[]): string {
  const sorted = parsePresentationEpisodeNumbers(numbers);
  return sorted.length ? sorted.map((number) => "第" + number + "集").join("、") : "未指定正式集";
}

export function formatPresentationContractScope(
  input: PresentationContractScopeInput,
  formalEpisodeNumbers: readonly number[]
): string {
  const scope = resolvePresentationContractScope(input, formalEpisodeNumbers);
  return scope.mode === "ALL_EPISODES"
    ? "全部" + formalEpisodeNumbers.length + "集"
    : formatPresentationEpisodeNumbers(scope.episodeNumbers);
}
