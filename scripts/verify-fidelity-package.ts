import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import {prepareFidelityImport} from '../lib/fidelity-import';
import {parseScriptBuffer} from '../lib/import-script';
import {CONTRACT_VERSION,createSource,proposePlan} from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import {proposePlan as legacyPlan} from '../lib/fidelity-legacy.mjs';
const hash=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
const text='山海图鉴：收容所开局\n第零集\n故事大纲：\n背景\n第一集\n1-1收容所 夜 内\n张三：  é😀\n第二集\n2-1日 内 走廊\n李四：来。\n';
const bytes=Buffer.from(text);
const bundle=(value=text,legacy=false)=>{const source=createSource(value);return {source,plan:(legacy?legacyPlan:proposePlan)(source)};};
async function archive(entries:Record<string,string|Buffer>){const zip=new JSZip();for(const [name,data] of Object.entries(entries))zip.file(name,data);return zip.generateAsync({type:'nodebuffer'});}
function check(result:Awaited<ReturnType<typeof prepareFidelityImport>>,original:Buffer,episodes=2,scenes=2){assert.equal(result.imported.episodes.length,episodes);assert.deepEqual(result.imported.episodes.map(e=>e.number),Array.from({length:episodes},(_,i)=>i+1));assert.equal(result.receipt.result.episodes.reduce((n,e)=>n+e.scenes.length,0),scenes);assert.equal(result.receipt.result.validation.issues.length,0);assert.equal(result.receipt.originalHash,hash(original));assert.equal(hash(Buffer.from(result.imported.originalFile!.base64,'base64')),hash(original));assert.equal(result.receipt.result.segments.map(s=>s.text).join(''),result.imported.sourceText);assert.equal(result.receipt.result.contractVersion,CONTRACT_VERSION);}
async function main(){
 for(const ext of ['txt','md'])check(await prepareFidelityImport(`clean.${ext}`,bytes,'direct'),bytes);
 const external=Buffer.from(JSON.stringify(bundle()));
 check(await prepareFidelityImport('clean.json',external,'direct',[],false,{name:'original.txt',bytes}),bytes);
 const old=Buffer.from(JSON.stringify(bundle(text,true)));
 const upgraded=await prepareFidelityImport('old.json',old,'direct');check(upgraded,old);assert.ok(upgraded.receipt.reader.warnings.some(w=>w.includes('新版')));
 for(const legacy of [false,true]){const p=bundle(text,legacy);(p.plan.segments as {speakerLabels:string[]}[])[6].speakerLabels=['错人'];await assert.rejects(prepareFidelityImport('bad.json',Buffer.from(JSON.stringify(p)),'direct'));const q=bundle(text,legacy);q.source={...q.source,text:q.source.text+'偷改'};await assert.rejects(prepareFidelityImport('bad.json',Buffer.from(JSON.stringify(q)),'direct'));}
 await assert.rejects(prepareFidelityImport('clean.json',external,'direct',[],false,{name:'wrong.txt',bytes:Buffer.from(text+'差异')}),/不一致/);
 await assert.rejects(prepareFidelityImport('clean.txt',bytes,'direct',[],false,{name:'wrong.txt',bytes:Buffer.from(text.replace('  ',' '))}),/不一致/);
 const zip=await archive({'show/output/reimport-source-plan.json':old,'show/original/original.txt':bytes,'show/scripts/run.mjs':'globalThis.__fidelityPackageScriptExecuted=true; throw new Error("must not run")','show/run.cmd':'exit /b 1'});
 check(await prepareFidelityImport('clean.zip',zip,'direct'),bytes);assert.equal((globalThis as Record<string,unknown>).__fidelityPackageScriptExecuted,undefined);
 await assert.rejects(prepareFidelityImport('many.zip',await archive({'a/reimport-source-plan.json':external,'b/fidelity-import.json':external}),'direct'),/多份/);
 await assert.rejects(prepareFidelityImport('wrong.zip',await archive({'output/reimport-source-plan.json':external,'original/source.txt':Buffer.from('错误')}),'direct'),/不一致/);
 check(await prepareFidelityImport('plain.zip',await archive({'clean.txt':bytes,'README.md':'instructions'}),'direct'),bytes);
 check(await prepareFidelityImport('plain-with-original.zip',await archive({'clean.txt':bytes,'original-upload.txt':bytes}),'direct'),bytes);
 await assert.rejects(prepareFidelityImport('many-originals.zip',await archive({'output/reimport-source-plan.json':external,'original/one.txt':bytes,'original/two.txt':bytes}),'direct'),/多份原稿/);
 await assert.rejects(prepareFidelityImport('plain-wrong.zip',await archive({'clean.txt':bytes,'original-upload.txt':Buffer.from('不同原稿')}),'direct'),/不一致/);
 // Minimal DOCX fixture, with each original paragraph preserved as an actual Word paragraph.
 const docx=await archive({'[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>','_rels/.rels':'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>','word/document.xml':`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${text.trimEnd().split('\n').map(t=>`<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`).join('')}</w:body></w:document>`});
 check(await prepareFidelityImport('clean.docx',docx,'direct'),docx);
 const reading=await parseScriptBuffer('original.docx',docx,{docxParagraphSeparator:'\n'});
 const docxPackage=Buffer.from(JSON.stringify(bundle(reading.sourceText)));
 const paired=await prepareFidelityImport('clean.json',docxPackage,'direct',[],false,{name:'original.docx',bytes:docx});check(paired,docx);assert.equal(paired.receipt.reader.view,'MAMMOTH_PARAGRAPH_LF_V1');
 await assert.rejects(prepareFidelityImport('clean.json',Buffer.from(JSON.stringify(bundle(reading.sourceText.replace('  ',' ')))),'direct',[],false,{name:'original.docx',bytes:docx}),/不一致/);
 for(const env of ['FIDELITY_REAL_DOCX','FIDELITY_REAL_ZIP']){const filename=process.env[env];if(!filename)continue;const original=await readFile(filename);const before=hash(original);const result=await prepareFidelityImport(path.basename(filename),original,'direct');const retained=env==='FIDELITY_REAL_DOCX'?original:Buffer.from(result.imported.originalFile!.base64,'base64');check(result,retained,70,107);assert.equal(hash(await readFile(filename)),before);console.log(`${env}: 70集 / 107场 / 0疑点 / 原字节未变`);}
 console.log('fidelity-package: synthetic direct/ZIP/v1/tamper/pairing/DOCX/script-data checks passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
