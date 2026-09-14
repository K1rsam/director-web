import {isDeepStrictEqual} from 'node:util';
import {assertFidelityMaterialization,type FidelityReceipt} from './fidelity-import';
import type {ImportedScript} from './import-script';

/** Hydrate only the old pinned projection; never reparse with today's rules. */
export function projectPinnedFidelitySource(value:unknown,receipt:FidelityReceipt):ImportedScript {
 const source=value as ImportedScript;
 const fail=()=>{throw new Error('旧来源快照缺少一致的分集投影证据，未自动重建或归档。');};
 if(!source||typeof source.sourceText!=='string'||!Array.isArray(source.sourceStructure?.sections)||!Array.isArray(receipt.result?.episodes))return fail();
 if(source.sourceStructure.sections.some(s=>!s||typeof s!=='object'||!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start<0||s.end<s.start||s.end>source.sourceText.length||!['EPISODE','BACKGROUND','UNRESOLVED'].includes(s.kind)||s.kind==='EPISODE'&&!Number.isInteger(s.episodeNumber)))return fail();
 if(receipt.result.episodes.some(e=>!e||typeof e!=='object'||!Number.isInteger(e.number)||typeof e.title!=='string'||typeof e.content!=='string'||typeof e.productionEligible!=='boolean'))return fail();
 const numbers=[...new Set(source.sourceStructure.sections.filter(s=>s.kind==='EPISODE').map(s=>s.episodeNumber))];
 const episodes=numbers.map(number=>{
  const matches=receipt.result.episodes.filter(e=>e.number===number);
  if(!Number.isInteger(number)||matches.length!==1)return fail();
  const episode=matches[0];
  const content=source.sourceStructure.sections.filter(s=>s.kind==='EPISODE'&&s.episodeNumber===number).map(s=>source.sourceText.slice(s.start,s.end)).join('');
  if(!episode.productionEligible||typeof episode.title!=='string'||episode.content!==content)return fail();
  return {number:episode.number,title:episode.title,content};
 });
 if(source.episodes!==undefined&&(!Array.isArray(source.episodes)||!isDeepStrictEqual(source.episodes,episodes)))return fail();
 const projected={...source,episodes};
 assertFidelityMaterialization(projected,receipt);
 return projected;
}
