import { createHash } from 'node:crypto';
import type { SeriesKnowledgeItem } from './series-direction';

/** Structurally compatible with the service's complete or split source units. */
export type SeriesDirectionSourceUnit = {
  id: string; evidenceId: string; kind: 'EPISODE' | 'BACKGROUND' | 'UNRESOLVED'; title: string;
  text: string; production: boolean; episodeId?: string; sourceOffset?: number;
  dialogueRanges?: Array<{ start: number; end: number }>;
  interpretations?: Array<{ line: number; target: string; kind: string; speaker?: string; speakers?: string[] }>;
};
export type EvidenceBatch = {
  coverage: string[]; summary: string;
  evidence: Array<{ unitId: string; quote: string; signal: string }>;
  knowledge?: SeriesKnowledgeItem[];
};
export type EvidenceCoordinateCorrection = {
  knowledgeIndex: number; unitId: string;
  originalStart: { supplied: false } | { supplied: true; value: unknown };
  resolvedStart: number; absoluteStart: number; absoluteEnd: number;
  reason: 'UNIQUE_EXACT_QUOTE';
};
export type EvidenceReadResult = { batch: EvidenceBatch; coordinateCorrections: EvidenceCoordinateCorrection[] };

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// Keep the existing item key order and digest: correctly located legacy evidence retains its ID.
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(code: string, message: string): never { throw Object.assign(new Error(message), { code, status: 409 }); }

function quoteStart(unit: SeriesDirectionSourceUnit, quote: string, hint: unknown): number {
  const first = unit.text.indexOf(quote);
  if (first < 0) fail('DIRECTION_MODEL_EVIDENCE', '关系／揭示引用不是当前分片的唯一原文定位。');
  // Only a unique verbatim match in the explicitly named unit permits mechanical correction.
  // This determines coordinates, not meaning; there is no quote rewriting or cross-unit search.
  if (unit.text.indexOf(quote, first + 1) === -1) return first;
  // Count overlapping matches as ambiguous too. A precise legacy hint may disambiguate them.
  if (Number.isSafeInteger(hint) && (hint as number) >= 0
    && unit.text.slice(hint as number, (hint as number) + quote.length) === quote) return hint as number;
  return fail('DIRECTION_MODEL_EVIDENCE', '关系／揭示引用不是当前分片的唯一原文定位。');
}

/** Pure validation and source binding. Receipts stay outside the legacy EvidenceBatch/card payload. */
export function readSeriesDirectionEvidence(data: unknown, units: readonly SeriesDirectionSourceUnit[]): EvidenceReadResult {
  if (!record(data) || !Array.isArray(data.coverage) || !Array.isArray(data.evidence) || typeof data.summary !== 'string'
    || Array.from(data.summary).length > 900 || !data.summary.trim())
    fail('DIRECTION_MODEL_OUTPUT', '该批候选缺少完整覆盖或精简证据，已保存返回内容，未自动重试。');
  const expected = units.map(unit => unit.id).sort();
  if (JSON.stringify([...data.coverage].sort()) !== JSON.stringify(expected) || data.evidence.length !== units.length)
    fail('DIRECTION_MODEL_COVERAGE', '该批返回的覆盖清单与实际来源不一致，已保留输出，未冒充全剧完成。');
  const seen = new Set<string>();
  for (const evidence of data.evidence) {
    if (!record(evidence) || typeof evidence.unitId !== 'string' || typeof evidence.quote !== 'string' || typeof evidence.signal !== 'string')
      fail('DIRECTION_MODEL_OUTPUT', '候选证据格式无效。');
    const unit = units.find(unit => unit.id === evidence.unitId);
    if (!unit || seen.has(unit.id) || !evidence.quote || !unit.text.includes(evidence.quote) || Array.from(evidence.quote).length > 120
      || !evidence.signal.trim() || Array.from(evidence.signal).length > 100)
      fail('DIRECTION_MODEL_EVIDENCE', '候选引用不是该分片中的有效短原文，输出已保留供核对。');
    seen.add(unit.id);
  }
  const knowledge: SeriesKnowledgeItem[] = [], coordinateCorrections: EvidenceCoordinateCorrection[] = [];
  if (data.knowledge !== undefined) {
    if (!Array.isArray(data.knowledge) || data.knowledge.length > 48)
      fail('DIRECTION_MODEL_EVIDENCE', '关键关系、揭示与变化索引过大或结构无效；未丢弃、未自动重试。');
    for (const [knowledgeIndex, value] of data.knowledge.entries()) {
      if (!record(value) || typeof value.unitId !== 'string' || typeof value.quote !== 'string' || !value.quote.trim() || [...value.quote].length > 240
        || !['RELATIONSHIP', 'REVEAL', 'CHANGE'].includes(String(value.kind)) || !['SOURCE', 'CHARACTER_CLAIM'].includes(String(value.claim))
        || typeof value.statement !== 'string' || !value.statement.trim() || [...value.statement].length > 240
        || !Array.isArray(value.subjects) || value.subjects.length > 8
        || value.subjects.some(subject => typeof subject !== 'string' || !subject.trim() || [...subject].length > 80))
        fail('DIRECTION_MODEL_EVIDENCE', '关系／揭示索引缺少有效依据。');
      const unit = units.find(unit => unit.id === value.unitId);
      if (!unit) fail('DIRECTION_MODEL_EVIDENCE', '关系／揭示引用不是当前分片的唯一原文定位。');
      const start = quoteStart(unit, value.quote, value.start), absoluteStart = (unit.sourceOffset ?? 0) + start, end = absoluteStart + value.quote.length;
      if (value.start !== start) coordinateCorrections.push({
        knowledgeIndex, unitId: unit.id,
        originalStart: Object.hasOwn(value, 'start') ? { supplied: true, value: value.start } : { supplied: false },
        resolvedStart: start, absoluteStart, absoluteEnd: end, reason: 'UNIQUE_EXACT_QUOTE',
      });
      // Preserve the existing conservative attribution, evaluated at the resolved absolute range.
      // Dialogue (including OS/VO) cannot become objective SOURCE truth through a model claim.
      const claim = value.claim === 'CHARACTER_CLAIM' || unit.dialogueRanges?.some(range => absoluteStart < range.end && end > range.start)
        ? 'CHARACTER_CLAIM' : 'SOURCE';
      const item = {
        kind: value.kind as SeriesKnowledgeItem['kind'], claim: claim as SeriesKnowledgeItem['claim'],
        statement: value.statement.trim(), subjects: [...new Set(value.subjects as string[])],
        source: { evidenceId: unit.evidenceId, episodeId: unit.production ? unit.episodeId ?? null : null, quote: value.quote, start: absoluteStart, end },
      };
      knowledge.push({ id: digest(item), ...item });
    }
  }
  return {
    batch: { coverage: data.coverage as string[], summary: data.summary, evidence: data.evidence as EvidenceBatch['evidence'],
      ...(data.knowledge === undefined ? {} : { knowledge: [...new Map(knowledge.map(item => [item.id, item])).values()] }) },
    coordinateCorrections,
  };
}
