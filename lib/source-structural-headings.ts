import {parseEpisodeNumber,type SourceStructure} from './import-script';

function headingNumber(text:string):number|null {
 const compact=text.trim();
 const match=/^(?:第\s*([0-9零〇一二两三四五六七八九十百千]+)\s*[集话話]|EP(?:ISODE)?\s*([0-9]+))\s*[:：]?$/i.exec(compact);
 const number=match?parseEpisodeNumber(match[1]??match[2]):null;
 return number!==null&&Number.isSafeInteger(number)&&number>=0?number:null;
}

/** Only an otherwise-unassigned duplicate heading directly before a verified
 * episode with the same explicit heading is structural. No body text is moved. */
export function duplicateSourceHeadingKeys(text:string,structure:SourceStructure):Set<string> {
 const result=new Set<string>();
 for(let i=0;i<structure.sections.length-1;i++) {
  const section=structure.sections[i],next=structure.sections[i+1];
  if(section.kind!=='UNRESOLVED'||next.kind!=='EPISODE'||section.end!==next.start)continue;
  const number=headingNumber(text.slice(section.start,section.end));
  const nextHeading=text.slice(next.start,next.end).trimStart().split(/\r\n|\r|\n/,1)[0];
  if(number!==null&&number===next.episodeNumber&&number===headingNumber(nextHeading)
    &&!structure.issues.some(issue=>issue.sectionKeys.includes(section.key)))result.add(section.key);
 }
 return result;
}
