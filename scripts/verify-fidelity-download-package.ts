import { GET } from '../app/api/fidelity/skill/route';
import { parseScriptBuffer } from '../lib/import-script';
import { prepareFidelityImport } from '../lib/fidelity-import';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
async function main(){
 process.loadEnvFile('.env'); const input=process.argv[2];if(!input)throw new Error('Provide a source DOCX path');
 const out=path.resolve('runtime-3008','skill-package-qa-'+Date.now());await mkdir(out,{recursive:true});
 const response=await GET(new Request('http://localhost/api/fidelity/skill'));
 assert.equal(response.status,200);assert(response.headers.get('Content-Disposition')?.includes('screenplay-fidelity-v2.zip'));
 const bytes=Buffer.from(await response.arrayBuffer());await writeFile(path.join(out,'screenplay-fidelity-v2.zip'),bytes);
 const zip=await JSZip.loadAsync(bytes);const unpack=path.join(out,'unpacked');
 for(const entry of Object.values(zip.files)){if(entry.dir)continue;const target=path.resolve(unpack,entry.name);assert(target.startsWith(unpack+path.sep),'archive escapes QA directory');await mkdir(path.dirname(target),{recursive:true});await writeFile(target,await entry.async('nodebuffer'));}
 const skill=path.join(unpack,'screenplay-fidelity');const guide=await readFile(path.join(skill,'SKILL.md'),'utf8');assert(guide.includes('node scripts/cli.mjs'));
 const original=await readFile(input);const sourceHash=createHash('sha256').update(original).digest('hex');const read=await parseScriptBuffer(path.basename(input),original);
 const baseline=path.join(out,'reading-baseline.txt');await writeFile(baseline,read.sourceText,'utf8');await writeFile(path.join(out,'reader.json'),JSON.stringify({sourceHash,reader:read.readingView},null,2));
 const resultDir=path.join(out,'result');const cli=execFileSync(process.execPath,['scripts/cli.mjs',baseline,resultDir],{cwd:skill,encoding:'utf8',windowsHide:true});const status=JSON.parse(cli);assert(status.ok);
 assert.equal(await readFile(path.join(resultDir,'cleaned.txt'),'utf8'),read.sourceText);
 assert.deepEqual(await readFile(path.join(resultDir,'original-upload.txt')),await readFile(baseline));
 const payload=await readFile(path.join(resultDir,'fidelity-import.json'));
 const result=await prepareFidelityImport('fidelity-import.json',payload,'direct',[],false,{name:path.basename(input),bytes:original});
 assert.equal(result.imported.episodes.length,70);assert.equal(result.receipt.result.episodes.filter(e=>e.productionEligible).reduce((n,e)=>n+e.scenes.length,0),107);assert.equal(result.imported.sourceStructure.issues.length,0);assert.equal(result.receipt.result.validation.issues.length,0);
 assert.equal(createHash('sha256').update(await readFile(input)).digest('hex'),sourceHash);
 const report={ok:true,packageName:'screenplay-fidelity-v2.zip',output:out,cli:status,productionEpisodes:70,scenes:107,issues:0,cleanedTextEqual:true,originalUnchanged:true,reader:read.readingView,guarantee:result.receipt.guarantee};await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}
main().catch(e=>{console.error(e);process.exitCode=1});
