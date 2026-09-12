import { hashFoundationPrompt, type SourceIndex, buildNumberedSource } from './project-foundation-contracts';
export type FoundationFragment = { id: string; episode: number; start: number; end: number; sourceVersion: string };
/** UTF-16 half-open offsets; source line numbers always remain global within the episode. */
export function buildFoundationFragments(index: SourceIndex, maxChars = 18000): FoundationFragment[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 2) throw new Error('分片预算至少为2个UTF-16单元。');
  return index.episodes.flatMap(episode => {
    const result: FoundationFragment[] = [];
    let start = 0;
    do {
      let end = Math.min(start + maxChars, episode.content.length);
      if (end < episode.content.length) {
        const newline = episode.content.lastIndexOf('\n', end - 1);
        if (newline >= start + Math.floor(maxChars / 2)) end = newline + 1;
        if (/[\uD800-\uDBFF]/.test(episode.content[end - 1]) && /[\uDC00-\uDFFF]/.test(episode.content[end])) end--;
        if (episode.content[end - 1] === '\r' && episode.content[end] === '\n') end--;
      }
      result.push({ id: hashFoundationPrompt(JSON.stringify([index.version, episode.number, start, end])), sourceVersion: index.version, episode: episode.number, start, end });
      start = end;
    } while (start < episode.content.length);
    return result;
  });
}
export function fragmentSource(index: SourceIndex, fragment: FoundationFragment) {
  if (fragment.sourceVersion !== index.version) throw new Error('分片来源版本过期。');
  const source = buildNumberedSource(index, [fragment.episode]);
  let offset = 0;
  source.episodes[0].lines = source.episodes[0].lines.flatMap(([line, text]): [number, string][] => {
    const start = offset; offset += text.length;
    const from = Math.max(start, fragment.start), to = Math.min(offset, fragment.end);
    return to > from ? [[line, text.slice(from - start, to - start)]] : [];
  });
  return source;
}
export function fragmentsComplete(index: SourceIndex, expected: FoundationFragment[], completed: readonly string[]) {
  const ids = new Set(completed);
  return index.episodes.filter(episode => {
    const parts = expected.filter(p => p.episode === episode.number).sort((a,b) => a.start-b.start);
    let end = 0;
    for (const part of parts) {
      if (part.sourceVersion !== index.version || part.start !== end || !ids.has(part.id)) return false;
      end = part.end;
    }
    return parts.length > 0 && end === episode.content.length;
  }).map(e => e.number);
}
