export type ScriptBlankLineCleanup = {
  version: 'SCRIPT_BLANK_LINES_V1';
  /** Half-open UTF16 ranges in the unchanged reading text; adjacent removals coalesce. */
  removedRanges: {start: number; end: number}[];
};

/** Remove whole blank lines only. Nonblank text and its original line ending stay exact. */
export function cleanupScriptText(text: string) {
  const kept: string[] = [], removedRanges: ScriptBlankLineCleanup['removedRanges'] = [];
  for (const match of text.matchAll(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g)) {
    if (match[0].trim()) { kept.push(match[0]); continue; }
    const start = match.index!, end = start + match[0].length, previous = removedRanges.at(-1);
    if (previous?.end === start) previous.end = end;
    else removedRanges.push({start, end});
  }
  return {text: kept.join(''), removedRanges};
}

export function removeBlankScriptLines(text: string): string {
  return cleanupScriptText(text).text;
}
