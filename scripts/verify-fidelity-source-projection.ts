import assert from 'node:assert/strict';
import {prepareFidelityImport,type FidelityResult} from '../lib/fidelity-import';
import {projectPinnedFidelitySource} from '../lib/fidelity-source-projection';
import {normalize as normalizeV2} from '../lib/fidelity-v2.mjs';
import {normalize as normalizeV1} from '../lib/fidelity-legacy.mjs';

async function main(){
 const raw='第1集\r\n1-1 日 外 门口\r\n甲乙：保留 😀。\r\n';
 const prepared=await prepareFidelityImport('projection.txt',Buffer.from(raw),'fidelity');
 const {episodes,...compact}=prepared.imported;
 for(const result of [prepared.receipt.result,normalizeV2(raw) as FidelityResult,normalizeV1(raw) as FidelityResult]){
  const receipt={...prepared.receipt,result};
  assert.deepEqual(projectPinnedFidelitySource(compact,receipt),prepared.imported);
  assert.deepEqual(projectPinnedFidelitySource(prepared.imported,receipt),prepared.imported);
 }
 assert.equal('episodes' in compact,false,'hydrate never mutates compact evidence');
 const skipped=await prepareFidelityImport('skipped.txt',Buffer.from('第5集\n5-1 日 外 门口\n甲：先来。\n第7集\n7-1 夜 内 房间\n乙：后来。\n'),'fidelity');
 assert.equal(skipped.receipt.episodeNumbering,'SOURCE_NUMBER_V1');
 const {episodes:sourceEpisodes,...sourceCompact}=skipped.imported;
 assert.deepEqual(projectPinnedFidelitySource(sourceCompact,skipped.receipt),skipped.imported,'source-number projection must not be matched against internal ordinals');
 const oldReceipt=structuredClone(skipped.receipt);delete oldReceipt.episodeNumbering;
 const sourceToOrdinal=new Map(oldReceipt.result.episodes.filter(e=>e.productionEligible).map(e=>[Number(e.sourceNumber),e.number]));
 const oldImported={...skipped.imported,episodes:sourceEpisodes.map(e=>({...e,number:sourceToOrdinal.get(e.number)!})),sourceStructure:{...skipped.imported.sourceStructure,sections:skipped.imported.sourceStructure.sections.map(s=>s.kind==='EPISODE'?{...s,episodeNumber:sourceToOrdinal.get(s.episodeNumber!)!}:s)}};
 assert.deepEqual(projectPinnedFidelitySource(oldImported,oldReceipt),oldImported,'untagged old evidence keeps its original ordinal projection');
 assert.throws(()=>projectPinnedFidelitySource(oldImported,skipped.receipt),'source tag cannot silently accept ordinal projection');
 const crossed=await prepareFidelityImport('crossed.txt',Buffer.from('第10集\n10-1 日 外 门口\n甲：十。\n第1集\n1-1 夜 内 房间\n乙：一。\n'),'fidelity');
 assert.deepEqual(projectPinnedFidelitySource(crossed.imported,crossed.receipt),crossed.imported,'source 1 must not select internal ordinal 1 belonging to episode10');
 assert.throws(()=>projectPinnedFidelitySource(compact,{...prepared.receipt,episodeNumbering:'UNKNOWN' as never}));
 const malformed=[
  {...compact,sourceText:raw+'改'},
  {...compact,sourceStructure:{...compact.sourceStructure,sections:[]}},
  {...compact,sourceStructure:{...compact.sourceStructure,sections:[null]}},
  {...compact,sourceStructure:{...compact.sourceStructure,sections:[{start:0.5,end:raw.length,kind:'EPISODE',episodeNumber:1}]}},
  {...compact,sourceStructure:{...compact.sourceStructure,sections:[{start:0,end:raw.length,kind:'UNKNOWN'}]}},
  {...compact,sourceStructure:{...compact.sourceStructure,sections:compact.sourceStructure.sections.map(s=>({...s,start:s.start+1}))}},
  {...compact,episodes:[]},
  {...compact,episodes:episodes.map(e=>({...e,title:'人工标题'}))},
 ];
 for(const value of malformed)assert.throws(()=>projectPinnedFidelitySource(value,prepared.receipt));
 for(const changed of [[],[...prepared.receipt.result.episodes,...prepared.receipt.result.episodes],prepared.receipt.result.episodes.map(e=>({...e,content:e.content+'改'}))]){
  assert.throws(()=>projectPinnedFidelitySource(compact,{...prepared.receipt,result:{...prepared.receipt.result,episodes:changed}}));
 }
 const invalidReceipt=structuredClone(prepared.receipt);
 Reflect.set(invalidReceipt.result,'episodes',[null]);
 assert.throws(()=>projectPinnedFidelitySource(compact,invalidReceipt),/旧来源快照缺少一致/);
 console.log('PASS pinned compact/full projection across v1/v2/v3; malformed, missing, duplicate and changed evidence rejected; no mutation or AI');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
