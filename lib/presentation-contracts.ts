/**
 * 表现规范的适用范围。
 *
 * P1 负责判断“哪里确实出现了需要拍板的非常规表现”，用户确认时再决定
 * 这条规则只落到发现的集、指定的集，还是明确扩大到全部正式集。下游岗位
 * 只接收当前任务范围内命中的规则，避免把全剧规则重复灌进每一集。
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
  /** 兼容旧记录：PresentationContract 只有一个 episodeId。 */
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
    .map((value) => typeof value === "number" ? value : Number(String(value).trim()))
    .filter((value) => Number.isInteger(value) && value >= 1))]
    .sort((a, b) => a - b);
}

export function normalizePresentationScopeMode(value: unknown): PresentationContractScopeMode {
  return PRESENTATION_SCOPE_MODES.includes(value as PresentationContractScopeMode)
    ? value as PresentationContractScopeMode
    : "SOURCE_EPISODES";
}

/**
 * P1 可能在不同分片、不同集里重复发现同一条表现规则。
 * 有 rule_key 时优先使用它；旧/漏填时退回“类别 + 问题”的稳定键，
 * 这样同一规则只生成一张确认卡，不会因为换了主证据集而重复询问。
 */
export function presentationDecisionKey(input: {
  category?: unknown;
  question?: unknown;
  rule_key?: unknown;
}): string {
  const normalize = (value: unknown) => String(value ?? "")
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
  const category = normalize(input.category);
  const ruleKey = normalize(input.rule_key);
  const question = normalize(input.question);
  return `${category}|${ruleKey ? `rule:${ruleKey}` : `question:${question}`}`;
}

/**
 * 把数据库/旧快照中的范围解析成可用于页面和流水线的正式集号。
 * 旧记录有 episodeId 时沿用原集；只有明确 ALL_EPISODES 才是全剧。
 * 缺少范围和锚点时不向任何集供给。
 */
export function resolvePresentationContractScope(
  input: PresentationContractScopeInput,
  formalEpisodeNumbers: readonly number[]
): ResolvedPresentationContractScope {
  const formal = parsePresentationEpisodeNumbers(formalEpisodeNumbers);
  const mode = normalizePresentationScopeMode(input.scope_mode);
  if (mode === "ALL_EPISODES") return { mode, episodeNumbers: formal };

  const stored = parsePresentationEpisodeNumbers(input.target_episode_numbers);
  if (stored.length) {
    return { mode, episodeNumbers: stored.filter((number) => formal.includes(number)) };
  }

  if (Number.isInteger(input.source_episode_number) && Number(input.source_episode_number) >= 1) {
    const source = Number(input.source_episode_number);
    return { mode, episodeNumbers: formal.includes(source) ? [source] : [] };
  }

  // 缺少锚点不代表用户授权全剧。
  return { mode, episodeNumbers: [] };
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
  return sorted.length ? sorted.map((number) => `第${number}集`).join("、") : "未指定正式集";
}

export function formatPresentationContractScope(
  input: PresentationContractScopeInput,
  formalEpisodeNumbers: readonly number[]
): string {
  const scope = resolvePresentationContractScope(input, formalEpisodeNumbers);
  if (scope.mode === "ALL_EPISODES") return `全部${formalEpisodeNumbers.length}集`;
  return formatPresentationEpisodeNumbers(scope.episodeNumbers);
}
