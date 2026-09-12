import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {createFidelityExternalMaterial,parseFidelityExternalResult} from '../lib/fidelity-external';
import {prepareFidelityImport} from '../lib/fidelity-import';
import {GET} from '../app/api/fidelity/skill/route';
const source='第一集\n1-1 客厅 日 内\n甲：aaa😀\nEND\n|原文\n甲：aaa😀';
const material=createFidelityExternalMaterial(source);
const response=`FIDELITY-TEXT/1\nSOURCE ${material.sourceVersion}\nBODY B000001 B000006 1 1\nEND`;
const original={name:'original.txt',bytes:Buffer.from(source)};
async function docx(text:string){const z=new JSZip();z.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');z.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');z.file('word/document.xml',`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.split('\n').map(t=>`<w:p><w:r><w:t xml:space="preserve">${t.replaceAll('&','&amp;').replaceAll('<','&lt;')}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`);return z.generateAsync({type:'nodebuffer'});}
async function main(){
 assert.equal(material.blocks.map(b=>b.text).join(''),source);assert.equal(material.blocks.at(-1)!.end,source.length);
 for(const ext of ['txt','md','docx']){
  const result=await prepareFidelityImport(`reply.${ext}`,ext==='docx'?await docx(response):Buffer.from(response),'direct',[],false,original);
  assert.equal(result.imported.sourceText,source);assert.equal(result.imported.episodes[0].content,source);assert.equal(result.receipt.externalReview?.protocol,'FIDELITY-TEXT/1');assert.equal(result.receipt.result.validation.ok,true);
 }
 const draft='FIDELITY-DRAFT/1\nSOURCE -\nBODY 1 1\n'+source.split('\n').map(t=>'|'+t).join('\n')+'\nTEXT-END NONE\nEND';
 const paired=await prepareFidelityImport('draft.txt',Buffer.from(draft),'direct',[],false,original);assert.equal(paired.imported.episodes[0].content,source);
 for(const bad of [draft.replace('aaa','aba'),draft.replace('|甲：aaa😀\n',''),draft.replace('|END','|END\n|END'),draft.replace('|甲：aaa😀','|乙：aaa😀')])await assert.rejects(prepareFidelityImport('bad.txt',Buffer.from(bad),'direct',[],false,original),/不一致/);
 for(const bad of [response.replace(material.sourceVersion,'old'),response.replace('B000001','B000002'),response.replace('B000006','B000005'),response.replace('END','BODY B000001 B000006 1 2\nEND'),response.replace('\nEND',''),response+'\nextra'])await assert.rejects(parseFidelityExternalResult(source,bad));
 await assert.rejects(prepareFidelityImport('plan.txt',Buffer.from(response),'direct'),/原稿/);
 const noOriginal=await prepareFidelityImport('plain.txt',Buffer.from(source),'direct');assert.match(noOriginal.receipt.guarantee,/未提供原稿/);
 const candidate=response.replace('\nEND','\nALIAS {"names":["甲","aaa"],"evidence":["B000003"]}\nEND');assert.equal((await parseFidelityExternalResult(source,candidate)).metadata.aliases.length,1);
 await assert.rejects(parseFidelityExternalResult(source,candidate.replace('aaa','老甲')),/原文块/);
 await assert.rejects(parseFidelityExternalResult(source,candidate.replace('B000003','B999999')));
 const unknown='第一集\r甲：aaa😀\r尾句';const unknownMaterial=createFidelityExternalMaterial(unknown);
 assert.equal(unknownMaterial.blocks.length,3);
 const unknownPlan=`FIDELITY-TEXT/1\nSOURCE ${unknownMaterial.sourceVersion}\nBODY B000001 B000003 1 -\nEND`;
 const unknownResult=await prepareFidelityImport('unknown.txt',Buffer.from(unknownPlan),'direct',[],false,{name:'original.txt',bytes:Buffer.from(unknown)});
 assert.equal(unknownResult.receipt.decisions[0].sceneNumber,undefined);assert.ok(unknownResult.receipt.result.validation.issues.some(i=>i.code==='SCENE_BOUNDARY_UNCONFIRMED'));
 const zipResponse=await GET(new Request('http://localhost/api/fidelity/skill'));assert.match(zipResponse.headers.get('Content-Disposition')??'',/screenplay-fidelity-text-v1.zip/);
 const zip=await JSZip.loadAsync(await zipResponse.arrayBuffer());assert.ok(zip.file('screenplay-fidelity/scripts/external_protocol.py'));assert.ok(zip.file('screenplay-fidelity/references/external-text.md'));assert.match(await zip.file('screenplay-fidelity/SKILL.md')!.async('string'),/FIDELITY-SOURCE/);
 for(const [ending,separator] of [['CRLF','\r\n'],['CR','\r']] as const){
  const crSource='第一集'+separator+'甲：aaa'+separator;
  const crDraft=`FIDELITY-DRAFT/1\nSOURCE -\nBODY 1 1\n|第一集\n|甲：aaa\nTEXT-END ${ending}\nEND`;
  for(const ext of ['txt','md','docx'])assert.equal((await prepareFidelityImport('draft.'+ext,ext==='docx'?await docx(crDraft):Buffer.from(crDraft),'direct',[],false,{name:'source.txt',bytes:Buffer.from(crSource)})).imported.sourceText,crSource);
 }
 assert.equal((await parseFidelityExternalResult(source,' \n'+response)).decisions.length,1);
 const zero='第0集\n0-1 门外 日 外\n甲：序章剧情。';const zeroPlan=`FIDELITY-TEXT/1\nSOURCE ${createFidelityExternalMaterial(zero).sourceVersion}\nBODY B000001 B000003 0 1\nEND`;
 const zeroResult=await prepareFidelityImport('zero.txt',Buffer.from(zeroPlan),'direct',[],false,{name:'original.txt',bytes:Buffer.from(zero)});assert.equal(zeroResult.receipt.decisions[0].episodeNumber,0);assert.equal(zeroResult.imported.episodes[0].content,zero);assert.equal(zeroResult.receipt.result.episodes[0].sourceNumber,'0');
 console.log('PASS external protocol: TXT/MD/DOCX; immutable body; paired marked draft; Unicode/marker collisions; changed dialogue/speaker/drop/repeat/stale/order/coverage; unpaired guarantee');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
