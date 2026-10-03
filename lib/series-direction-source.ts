import { createHash } from 'node:crypto';

/** Canonical source records remain unchanged; this module prepares transport only. */
export type DirectionSourceUnit = {
  id: string; evidenceId: string; kind: string; title: string; text: string; production: boolean;
  [key: string]: unknown;
};
export type DirectionSourcePart<T extends DirectionSourceUnit = DirectionSourceUnit> = T & { sourceOffset: number };
export type DirectionProgramRecord = {
  unitId: string; evidenceId: string; text: string; textHash: string; sourceOffset: number;
  reason: 'WHITESPACE_ONLY' | 'EPISODE_HEADER_ONLY';
};
export type DirectionSourceOptions = {
  /** Exact old part IDs, only after the caller has validated their accepted evidence. */
  alreadyCovered?: readonly string[];
  /** Authoritative production episode numbers; otherwise inferred from episode titles. */
  episodeNumbers?: readonly number[];
};
export type DirectionSourcePreparation<T extends DirectionSourceUnit = DirectionSourceUnit> = {
  batches: DirectionSourcePart<T>[][];
  programRecords: DirectionProgramRecord[];
  allParts: DirectionSourcePart<T>[];
};
const PART_CODEPOINTS = 24_000;
const BATCH_UTF16_CHARS = 24_000;
const mechanicalFields = new Set(['id', 'evidenceId', 'kind', 'title', 'text', 'production', 'sourceOffset']);
function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code, status: 409 });
}
function episodeNumbers(units: readonly DirectionSourceUnit[], explicit?: readonly number[]) {
  if (explicit !== undefined) {
    if (!Array.isArray(explicit) || explicit.some(number => !Number.isSafeInteger(number) || number < 0) || new Set(explicit).size !== explicit.length) {
      fail('DIRECTION_SOURCE_INPUT', '真实集号须为不重复的非负整数。');
    }
    return new Set(explicit);
  }
  const numbers = units.filter(unit => unit.kind === 'EPISODE' && unit.production).flatMap(unit => {
    const match = /^第[ \t\u00a0\u3000]*(\d+)[ \t\u00a0\u3000]*集(?:$|[ \t\u00a0\u3000]*·)/u.exec(unit.title);
    const number = match ? Number(match[1]) : NaN;
    return Number.isSafeInteger(number) ? [number] : [];
  });
  return new Set(numbers);
}
function programReason(part: DirectionSourcePart, numbers: ReadonlySet<number>): DirectionProgramRecord['reason'] | null {
  if (part.kind !== 'BACKGROUND' || part.production !== false || Object.keys(part).some(key => !mechanicalFields.has(key))) return null;
  if (/^\s*$/u.test(part.text)) return 'WHITESPACE_ONLY';
  const lines = part.text.split(/\r\n|\n|\r/).map(line => line.trim()).filter(Boolean);
  return lines.length && lines.every(line => {
    const match = /^第[ \t\u00a0\u3000]*(\d+)[ \t\u00a0\u3000]*集$/u.exec(line);
    return match !== null && numbers.has(Number(match[1]));
  }) ? 'EPISODE_HEADER_ONLY' : null;
}

/**
 * allParts preserves the legacy codepoint split, part IDs and UTF16 source offsets.
 * Model batches, PROGRAM receipts and alreadyCovered form disjoint complete coverage.
 * No receipt is model evidence, and unknown content or metadata is never omitted.
 */
export function prepareDirectionSource<T extends DirectionSourceUnit>(
  units: readonly T[], options: DirectionSourceOptions = {},
): DirectionSourcePreparation<T> {
  if (!Array.isArray(units)) fail('DIRECTION_SOURCE_INPUT', '来源须为单元数组。');
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['alreadyCovered', 'episodeNumbers'].includes(key))) {
    fail('DIRECTION_SOURCE_INPUT', '来源准备选项无效。');
  }
  const ids = new Set<string>();
  for (const unit of units) {
    if (!unit || typeof unit !== 'object' || Array.isArray(unit) || typeof unit.id !== 'string' || !unit.id.trim()
      || typeof unit.evidenceId !== 'string' || !unit.evidenceId.trim() || typeof unit.text !== 'string'
      || typeof unit.title !== 'string' || typeof unit.kind !== 'string' || typeof unit.production !== 'boolean' || ids.has(unit.id)) {
      fail('DIRECTION_SOURCE_INPUT', '来源形状无效或单元编号重复；未丢弃来源。');
    }
    ids.add(unit.id);
  }
  const numbers = episodeNumbers(units, options.episodeNumbers);
  const allParts: DirectionSourcePart<T>[] = units.flatMap(unit => {
    const chars = Array.from(unit.text), count = Math.max(1, Math.ceil(chars.length / PART_CODEPOINTS));
    return Array.from({ length: count }, (_, index) => ({ ...structuredClone(unit), id: `${unit.id}/part-${index + 1}-of-${count}`,
      sourceOffset: chars.slice(0, index * PART_CODEPOINTS).join('').length,
      text: chars.slice(index * PART_CODEPOINTS, (index + 1) * PART_CODEPOINTS).join('') }));
  });
  const known = new Set(allParts.map(part => part.id)), covered = new Set<string>();
  if (known.size !== allParts.length) fail('DIRECTION_SOURCE_INPUT', '分片编号重复，无法证明完整覆盖。');
  if (options.alreadyCovered !== undefined && !Array.isArray(options.alreadyCovered)) fail('DIRECTION_SOURCE_COVERAGE', '已接收覆盖须为精确分片编号数组。');
  for (const id of options.alreadyCovered ?? []) {
    if (typeof id !== 'string' || !known.has(id) || covered.has(id)) fail('DIRECTION_SOURCE_COVERAGE', '已接收覆盖含未知或重复分片；未跳过任何来源。');
    covered.add(id);
  }
  const batches: DirectionSourcePart<T>[][] = [], programRecords: DirectionProgramRecord[] = [];
  let batchChars = 0;
  for (const part of allParts) {
    if (covered.has(part.id)) continue;
    const reason = programReason(part, numbers);
    if (reason) {
      programRecords.push({ unitId: part.id, evidenceId: part.evidenceId, text: part.text,
        textHash: createHash('sha256').update(part.text, 'utf8').digest('hex'), sourceOffset: part.sourceOffset, reason });
      continue;
    }
    if (part.text.length > BATCH_UTF16_CHARS) fail('DIRECTION_SOURCE_PART_BUDGET', '旧分片超过UTF16发送预算；原文保留，未重切编号、截断或提高上限。');
    if (!batches.length || batchChars + part.text.length > BATCH_UTF16_CHARS) {
      batches.push([part]); batchChars = part.text.length;
    } else { batches[batches.length - 1].push(part); batchChars += part.text.length; }
  }
  return { batches, programRecords, allParts };
}
