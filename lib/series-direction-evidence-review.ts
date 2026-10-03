import { isDeepStrictEqual } from 'node:util';
import { readSeriesDirectionEvidence, type EvidenceBatch, type EvidenceCoordinateCorrection, type SeriesDirectionSourceUnit } from './series-direction-evidence';

export type EvidenceReviewValue = { present: false } | { present: true; value: unknown };
export type SeriesDirectionEvidenceReviewChange = { path: string; before: EvidenceReviewValue; after: EvidenceReviewValue };
export type SeriesDirectionEvidenceReviewResult = {
  data: Record<string, unknown>; batch: EvidenceBatch;
  coordinateCorrections: EvidenceCoordinateCorrection[]; changes: SeriesDirectionEvidenceReviewChange[];
};

const allowed = {
  evidence: new Set(['quote', 'signal']),
  knowledge: new Set(['unitId', 'claim', 'statement', 'subjects', 'quote', 'start']),
};
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}
function fail(message: string): never { throw Object.assign(new Error(message), { code: 'DIRECTION_EVIDENCE_REVIEW', status: 409 }); }
const keys = (before: Record<string, unknown>, after: Record<string, unknown>) => [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
const valueAt = (row: Record<string, unknown>, key: string): EvidenceReviewValue => Object.hasOwn(row, key) ? { present: true, value: row[key] } : { present: false };

/**
 * Pure, explicit review validation; never an approval or semantic-truth assertion.
 * The service must bind raw output/hash, source version, permissions and CAS before saving.
 * Original content may fail source validation; corrected content must pass the full reader.
 */
export function validateSeriesDirectionEvidenceReview(
  original: unknown, corrected: unknown, units: readonly SeriesDirectionSourceUnit[], purpose: string,
): SeriesDirectionEvidenceReviewResult {
  if (typeof purpose !== 'string' || !purpose.trim()) fail('请明确说明此次逐项源定复核的目的与依据。');
  if (!record(original) || !record(corrected)) fail('原回包与修正版必须是完整证据对象。');
  for (const value of [original, corrected]) {
    if (!Array.isArray(value.coverage) || typeof value.summary !== 'string' || !Array.isArray(value.evidence)
      || (Object.hasOwn(value, 'knowledge') && !Array.isArray(value.knowledge))) fail('证据包形状无效；不能增删或转换整个条目集合。');
  }
  for (const key of keys(original, corrected)) {
    if (key !== 'evidence' && key !== 'knowledge' && !isDeepStrictEqual(valueAt(original, key), valueAt(corrected, key)))
      fail(`不允许修改证据包字段 ${key}；覆盖、摘要与未知元数据必须原样保留。`);
  }
  const changes: SeriesDirectionEvidenceReviewChange[] = [];
  for (const collection of ['evidence', 'knowledge'] as const) {
    if (Object.hasOwn(original, collection) !== Object.hasOwn(corrected, collection)) fail(`不能增删 ${collection} 集合。`);
    if (!Object.hasOwn(original, collection)) continue;
    const beforeRows = original[collection] as unknown[], afterRows = corrected[collection] as unknown[];
    if (beforeRows.length !== afterRows.length) fail(`不能增删 ${collection} 条目。`);
    for (let index = 0; index < beforeRows.length; index++) {
      const before = beforeRows[index], after = afterRows[index], prefix = `${collection}[${index}]`;
      if (!record(before) || !record(after)) fail(`${prefix} 必须保留对象形状。`);
      if (collection === 'knowledge' && before.claim === 'CHARACTER_CLAIM' && after.claim === 'SOURCE')
        fail(`${prefix} 不能把角色说法升级为客观来源事实。`);
      for (const key of keys(before, after)) {
        const beforeValue = valueAt(before, key), afterValue = valueAt(after, key);
        if (isDeepStrictEqual(beforeValue, afterValue)) continue;
        if (!allowed[collection].has(key)) fail(`不允许修改 ${prefix}.${key}。`);
        changes.push({ path: `${prefix}.${key}`, before: structuredClone(beforeValue), after: structuredClone(afterValue) });
      }
    }
  }
  // Preserve raw reviewed data and unknown unchanged fields. The existing reader may separately
  // locate a unique quote or conservatively downgrade a claim, without rewriting this data.
  const data = structuredClone(corrected);
  const { batch, coordinateCorrections } = readSeriesDirectionEvidence(data, units);
  return { data, batch, coordinateCorrections, changes };
}
