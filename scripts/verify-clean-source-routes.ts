import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import * as fidelity from '../lib/fidelity-import';
import * as cleaning from '../lib/source-cleaning';
import * as external from '../lib/fidelity-external';
import * as localRequest from '../lib/local-json-request';

async function main() {
 const raw='\r\n第一集\r\n \t\r\n1-1 屋内 日 内\r\n\r\n出场人物：林岚\r\n林岚：（轻声）原话不变。\r\n\r\n';
 const prepared=await fidelity.prepareFidelityImport('source.txt',Buffer.from(raw),'fidelity');
 const expected=cleaning.removeBlankScriptLines(raw),before=JSON.stringify(prepared);
 let signedIn=true,authorizedProject='fixture',authCalls=0,originalReads=0;
 const imports:Record<string,unknown>={
  '@/lib/auth':{requireSessionUser:async()=>{authCalls++;if(!signedIn)throw new Error('NO_SESSION');},requireProjectAccess:async(projectId:string)=>{authCalls++;if(projectId!==authorizedProject)throw new Error('NO_ACCESS');}},
  '@/lib/fidelity-import':fidelity,'@/lib/source-cleaning':cleaning,'@/lib/fidelity-external':external,
  '@/lib/local-json-request':localRequest,
  '@/lib/fidelity-store':{readFidelityReceipt:async()=>({snapshot:{id:'revision-1'},receipt:prepared.receipt})},
  '@/lib/prisma':{prisma:{sceneSnapshot:{findFirst:async()=>{originalReads++;return{content:JSON.stringify(prepared.imported)};}}}},
 };
 function load(file:string){
  const compiled=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const module={exports:{} as Record<string,Function>};
  new Function('require','module','exports',compiled)((name:string)=>{assert.ok(Object.hasOwn(imports,name),`unexpected route dependency ${name}`);return imports[name];},module,module.exports);
  return module.exports;
 }
 const preview=load('app/api/fidelity/preview/route.ts').POST;
 const form=new FormData();form.set('scriptText',raw);
 const response=await preview(new Request('http://offline.invalid/api/fidelity/preview',{method:'POST',body:form}));
 assert.equal(response.status,200);const view=await response.json();
 assert.equal(view.preview,expected,'new-project preview must show clean work text, not raw blank lines or a second generated reading');
 assert.equal(view.sourceVersion,prepared.receipt.readingHash,'cleaning cannot change the audit source hash');
 assert.equal(view.previewTruncated,false);assert.equal(view.productionEpisodeCount,1);
 signedIn=false;await assert.rejects(()=>preview(new Request('http://offline.invalid/api/fidelity/preview',{method:'POST',body:form})),/NO_SESSION/);signedIn=true;
 const download=load('app/projects/[projectId]/source/download/route.ts').GET;
 const get=(query:string,projectId='fixture')=>download(new Request(`http://offline.invalid/source/download?${query}`),{params:Promise.resolve({projectId})}) as Promise<Response>;
 const clean=await get('format=md&revision=revision-1');assert.equal(await clean.text(),expected);assert.match(clean.headers.get('content-disposition')??'',/screenplay-cleaned/);
 const original=await get('format=original');assert.equal(await original.text(),raw);assert.equal(originalReads,1);
 const backup=await get('');assert.equal((await backup.json()).source.text,raw,'backup remains a faithful raw-source package');
 assert.equal((await get('format=md&revision=old')).status,409);
 await assert.rejects(()=>get('format=md','other'),/NO_ACCESS/);
 assert.equal(JSON.stringify(prepared),before,'read routes do not rewrite receipts or original attachments');assert.equal(authCalls,7);
 console.log('PASS clean source routes: preview/download remove only blank lines; original/backup, source hash, auth and revision conflict preserved; DB writes/model calls 0.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
