/** Explicit human decisions, not a conversion of model/data diagnostics into a questionnaire. */
export type HumanChoice = {
  decisionKey: string;
  kind: 'SOURCE_CONFLICT' | 'PRODUCTION_CHOICE';
  question: string;
  reason: string;
  options: string[];
  recommended: string;
  recommendationReason: string;
  evidence: string;
  episodes: number[];
};

export const normalizeDecisionKey = (key: string) => key.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\/\s*/g, '/');

function text(value: unknown, at: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${at}: 须为非空文本`);
  return value.trim();
}

export function readHumanChoices(value: unknown, scope: readonly number[]): HumanChoice[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error('humanChoices: 须为数组');
  return mergeHumanChoices([value.map((item, i) => {
    const at = `humanChoices.${i}`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${at}: 须为对象`);
    const row = item as Record<string, unknown>;
    const decisionKey = normalizeDecisionKey(text(row.decisionKey, `${at}.decisionKey`));
    if (row.kind !== 'SOURCE_CONFLICT' && row.kind !== 'PRODUCTION_CHOICE') throw new Error(`${at}.kind: 仅限原文取舍或必要制作取舍`);
    if (!Array.isArray(row.options) || row.options.length < 2 || row.options.length > 3) throw new Error(`${at}.options: 提供2–3个可选择方案`);
    const options = row.options.map((option, j) => text(option, `${at}.options.${j}`));
    if (new Set(options).size !== options.length) throw new Error(`${at}.options: 方案不能重复`);
    const recommended = text(row.recommended, `${at}.recommended`);
    if (!options.includes(recommended)) throw new Error(`${at}.recommended: 须匹配一个已有方案，不自动确认`);
    const rawEpisodes = row.episodes == null ? [] : row.episodes;
    if (!Array.isArray(rawEpisodes)) throw new Error(`${at}.episodes: 须为集号数组`);
    const episodes = rawEpisodes.map(n => typeof n === 'string' && /^(0|[1-9]\d*)$/.test(n) ? Number(n) : n);
    if (episodes.some(n => !Number.isSafeInteger(n) || !scope.includes(n))) throw new Error(`${at}.episodes: 须为本批集号；全剧口径可用空数组`);
    return { decisionKey, kind: row.kind, question: text(row.question, `${at}.question`), reason: text(row.reason, `${at}.reason`),
      options, recommended, recommendationReason: text(row.recommendationReason, `${at}.recommendationReason`), evidence: text(row.evidence, `${at}.evidence`),
      episodes: [...new Set(episodes as number[])].sort((a, b) => a - b) };
  })]);
}

/** Keys name a decision and its subject/scope. Similar wording/categories are not identity evidence. */
export function mergeHumanChoices(parts: readonly (readonly HumanChoice[])[]): HumanChoice[] {
  const result = new Map<string, HumanChoice>();
  for (const part of parts) for (const item of part) {
    const key = normalizeDecisionKey(item.decisionKey);
    const previous = result.get(key);
    if (!previous) result.set(key, { ...structuredClone(item), decisionKey: key });
    else {
      // Keep the initial alternatives stable; later occurrences only add coverage and evidence.
      previous.episodes = !previous.episodes.length || !item.episodes.length ? [] : [...new Set([...previous.episodes, ...item.episodes])].sort((a, b) => a - b);
      previous.evidence = [...new Set([...previous.evidence.split('\n'), ...item.evidence.split('\n')].filter(Boolean))].join('\n');
    }
  }
  return [...result.values()];
}
