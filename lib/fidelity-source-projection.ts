import {isDeepStrictEqual} from 'node:util';
import {assertFidelityMaterialization,type FidelityReceipt} from './fidelity-import';
import type {ImportedScript} from './import-script';
import {parseEpisodeNumber} from './import-script';
import {removeBlankScriptLines} from './source-cleaning';

/** Hydrate only the old pinned projection; never reparse with today's rules. */
export function projectPinnedFidelitySource(value:unknown,receipt:FidelityReceipt):ImportedScript {
 const source=value as ImportedScript;
 const fail=()=>{throw new Error('旧来源快照缺少一致的分集投影证据，未自动重建或归档。');};
 if(!source||typeof source.sourceText!=='string'||!Array.isArray(source.sourceStructure?.sections)||!Array.isArray(receipt.result?.episodes))return fail();
 if(source.sourceStructure.sections.some(s=>!s||typeof s!=='object'||!Number.isInteger(s.start)||!Number.isInteger(s.end)||s.start<0||s.end<s.start||s.end>source.sourceText.length||!['EPISODE','BACKGROUND','UNRESOLVED'].includes(s.kind)||s.kind==='EPISODE'&&!Number.isInteger(s.episodeNumber)))return fail();
 if(receipt.result.episodes.some(e=>!e||typeof e!=='object'||!Number.isInteger(e.number)||typeof e.title!=='string'||typeof e.content!=='string'||typeof e.productionEligible!=='boolean'))return fail();
 const numbering=receipt.episodeNumbering??'PRODUCTION_ORDER_V1';
 if(!['SOURCE_NUMBER_V1','PRODUCTION_ORDER_V1'].includes(numbering))return fail();
 const pending=receipt.result.validation.issues.filter(issue=>['ZERO_EPISODE_UNCONFIRMED','DUPLICATE_EPISODE_NUMBER'].includes(issue.code));
 const protectedRanges=receipt.sourceEpisodeBranches?.flatMap(branch=>branch.candidates)??[];
 const candidates=receipt.result.episodes.filter(episode=>episode.productionEligible&&!protectedRanges.some(range=>episode.start<range.end&&episode.end>range.start)&&!pending.some(issue=>issue.start>=episode.start&&issue.start<episode.end));
 const materializedNumber=(episode:FidelityReceipt['result']['episodes'][number])=>numbering==='PRODUCTION_ORDER_V1'?episode.number:typeof episode.sourceNumber==='string'&&episode.sourceNumber.trim()?parseEpisodeNumber(episode.sourceNumber):null;
 const numbers=[...new Set(source.sourceStructure.sections.filter(s=>s.kind==='EPISODE').map(s=>s.episodeNumber))];
 const episodes=numbers.map(number=>{
  const matches=candidates.filter(e=>materializedNumber(e)===number);
  if(!Number.isInteger(number)||matches.length!==1)return fail();
  const episode=matches[0];
  const content=source.sourceStructure.sections.filter(s=>s.kind==='EPISODE'&&s.episodeNumber===number).map(s=>source.sourceText.slice(s.start,s.end)).join('');
  if(!episode.productionEligible||typeof episode.title!=='string'||episode.content!==content)return fail();
  return {number:number!,title:episode.title,content:receipt.reader.blankLineCleanup?removeBlankScriptLines(content):content};
 });
 if(source.episodes!==undefined&&(!Array.isArray(source.episodes)||!isDeepStrictEqual(source.episodes,episodes)))return fail();
 const projected={...source,episodes};
 assertFidelityMaterialization(projected,receipt);
 return projected;
}
