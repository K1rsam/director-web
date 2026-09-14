import {isFoundationSourceFormatLine} from './foundation-facts';
export type FactSourceEvidence = {key:string;text:string};
/** Only exact original source-backed format rows may disappear from semantic
 * paid-work comparison. Missing/mismatched evidence always retains the row. */
export function comparableFoundationFactRows(rows: unknown[], sources: readonly FactSourceEvidence[]): unknown[] {
 const sourceByKey=new Map(sources.map(source=>[source.key,source.text]));
 return rows.filter(row=>{
  if(!Array.isArray(row)||!Array.isArray(row[0])||row[0].length!==4||row[0][0]!=='CONTEXT'||typeof row[0][1]!=='string'||typeof row[5]!=='string')return true;
  const [,key,start,end]=row[0],text=sourceByKey.get(key);
  if(text===undefined||typeof start!=='number'||typeof end!=='number'||text.slice(start,end)!==row[5])return true;
  // Confirmed validity or character claims are semantic evidence, not a format upgrade.
  if(row[3]!=='SOURCE'||row.length>6)return true;
  return !isFoundationSourceFormatLine(text,start,end);
 });
}
