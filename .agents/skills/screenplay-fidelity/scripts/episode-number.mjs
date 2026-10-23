/** Browser-safe source-label parser. Does not rewrite source text or identifiers. */
const DIGITS = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const UNITS = { 十: 10, 百: 100, 千: 1000 };
const halfWidth = value => value.replace(/[０-９Ａ-Ｚａ-ｚ]/g, character => String.fromCharCode(character.charCodeAt(0) - 0xfee0));
const safeNumber = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function parseEpisodeNumber(value) {
  const compact = halfWidth(value).trim();
  if (!compact) return null;
  if (/^\d+$/.test(compact)) return safeNumber(Number(compact));
  const repeated = /^([零〇一二两三四五六七八九十百千]+)(\d+)$/.exec(compact);
  if (repeated) {
    const chinese = parseEpisodeNumber(repeated[1]), arabic = safeNumber(Number(repeated[2]));
    return chinese !== null && chinese === arabic ? chinese : null;
  }
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(compact)) return null;
  if ([...compact].every(character => character in DIGITS)) return safeNumber(Number([...compact].map(character => DIGITS[character]).join('')));
  let total = 0, previousUnit = 10000, digit = null;
  for (const character of compact) {
    if (character in DIGITS) {
      if (digit !== null && digit !== 0) return null;
      digit = DIGITS[character];
    } else {
      const unit = UNITS[character];
      if (unit >= previousUnit || digit === 0) return null;
      total += (digit ?? 1) * unit;
      previousUnit = unit;
      digit = null;
    }
  }
  return safeNumber(total + (digit ?? 0));
}
