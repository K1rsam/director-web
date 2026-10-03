/** Reading view only. Never use this result for storage, source offsets, hashes or handoff. */
export function compactSourceDisplay(text: string): string {
  return text.split(/\r\n|\r|\n/).filter(line => line.trim().length > 0).join("\n");
}
