/** Client-safe choices; a candidate is not permission to execute extra fantasy. */
export const SERIES_EXPRESSION_OPTIONS = {
  emotion: { NATURAL: '自然有层次', STRONG: '强烈鲜明', HEIGHTENED: '高幅夸张' },
  camera: { BALANCED: '动静有别', DYNAMIC_FAST: '快速有冲击' },
  fantasy: { RESTRAINED: '少量精准', BALANCED: '适度择优', RICH: '丰富大胆' },
} as const;
export type SeriesExpressionPreferences = {
  [K in keyof typeof SERIES_EXPRESSION_OPTIONS]: keyof typeof SERIES_EXPRESSION_OPTIONS[K] | null;
} & { rationale: string | null };

export function readSeriesExpressionPreferences(value: unknown): SeriesExpressionPreferences {
  const fail = (): never => { throw Object.assign(new Error('DIRECTION_EXPRESSION'), { code: 'DIRECTION_EXPRESSION' }); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== 4 || Object.keys(row).some(key => !['emotion', 'camera', 'fantasy', 'rationale'].includes(key))) return fail();
  for (const key of ['emotion', 'camera', 'fantasy'] as const) {
    if (row[key] !== null && (typeof row[key] !== 'string' || !Object.hasOwn(SERIES_EXPRESSION_OPTIONS[key], row[key]))) return fail();
  }
  if (row.rationale !== null && (typeof row.rationale !== 'string' || !row.rationale.trim() || row.rationale !== row.rationale.trim() || /[\r\n\u0000-\u001f]/.test(row.rationale) || [...row.rationale].length > 140)) return fail();
  return { emotion: row.emotion, camera: row.camera, fantasy: row.fantasy, rationale: row.rationale } as SeriesExpressionPreferences;
}

export function seriesExpressionBrief(value: SeriesExpressionPreferences): string {
  const terms: string[] = [];
  if (value.emotion) terms.push(`情绪=${SERIES_EXPRESSION_OPTIONS.emotion[value.emotion]}`);
  if (value.camera) terms.push(`镜头=${SERIES_EXPRESSION_OPTIONS.camera[value.camera]}`);
  if (value.fantasy) terms.push(`幻想=${SERIES_EXPRESSION_OPTIONS.fantasy[value.fantasy]}`);
  return terms.length ? `表达选择：${terms.join('；')}` : '';
}
