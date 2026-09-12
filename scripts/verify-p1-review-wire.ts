import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { planP1ReviewBatches,projectP1ReviewRequest,projectP1ReviewEvidenceRequest,validateP1ReviewPlan,type P1ReviewRequest } from '../lib/fidelity-p1-review';
import { prepareFidelityImport } from '../lib/fidelity-import';
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function inspect(sourceText:string,baseline:Array<{episodeNumber:unknown;start:number;end:number}>){
 const batches=planP1ReviewBatches(sourceText),rows=[];let joined='';
 for(const [i,blocks] of batches.entries()){
  const start=blocks[0].start,end=blocks.at(-1)!.end;
  const request:P1ReviewRequest={reviewMode:'FULL_STRUCTURE_V1',sourceVersion:digest(sourceText),sourceLength:sourceText.length,batch:{firstBlock:blocks[0].id,lastBlock:blocks.at(-1)!.id,index:i+1,total:batches.length},sections:blocks.map((b,j)=>({key:b.id,start:b.start,end:b.end,text:b.text,...(j===0?{before:sourceText.slice(Math.max(0,b.start-600),b.start)}:{})})),issues:[],baseline:baseline.filter(e=>e.start<end&&e.end>start)};
  const original=JSON.stringify(request),wire=projectP1ReviewRequest(request);
  assert.equal(JSON.stringify(request),original,'projection must not mutate the local source request');
  const body=wire.blocks.map(b=>b[1]).join('');joined+=body;
  assert.equal(body,sourceText.slice(start,end));assert(!('sections' in wire));assert(!('sourceLength' in wire));
  assert.equal(wire.before,sourceText.slice(Math.max(0,start-600),start));
  const oldEvidence=projectP1ReviewEvidenceRequest(JSON.parse(original)),newEvidence=projectP1ReviewEvidenceRequest(JSON.parse(JSON.stringify(wire)));
  assert.equal(digest({receiver:'FIDELITY_SOURCE_ACCEPT_V2',request:oldEvidence}),digest({receiver:'FIDELITY_SOURCE_ACCEPT_V2',request:newEvidence}),'old paid request and compact log must share fingerprint');
  const response={sourceVersion:wire.sourceVersion,reviewed:{firstBlock:wire.batch.firstBlock,lastBlock:wire.batch.lastBlock},assignments:[],unresolved:[],aliases:[]};
  assert.deepEqual(validateP1ReviewPlan(response,request),{decisions:[],unresolved:[],aliases:[]});
  rows.push({batch:i+1,blocks:blocks.length,sourceChars:body.length,beforeChars:wire.before.length,fullRequestChars:original.length,wireChars:JSON.stringify(wire).length});
 }
 assert.equal(joined,sourceText,'all blocks reconstruct exact source once');
 return rows;
}
async function main(){
 await inspect('第1集\r\n甲：😀aaa。\r乙：aba。\n'+'原文。\n'.repeat(8000),[{episodeNumber:'1',start:0,end:100000}]);
 await inspect('字'.repeat(100000),[{episodeNumber:'1',start:0,end:100000}]);
 console.log('PASS compact P1: complete original blocks once, only bounded preceding context duplicated, immutable local request, old/new paid evidence fingerprint parity, validator compatibility, unbroken huge line');
 if(process.argv.includes('--shenshou')){
  const file=process.env.QA_SOURCE_FILE; if(!file)throw new Error('Set QA_SOURCE_FILE to your own original screenplay path for this optional audit.');
  const prepared=await prepareFidelityImport(file,readFileSync(file),'fidelity');
  const rows=await inspect(prepared.imported.sourceText,prepared.receipt.result.episodes.map(e=>({episodeNumber:e.sourceNumber,start:e.start,end:e.end})));
  const totals=rows.reduce((sum,row)=>({sourceChars:sum.sourceChars+row.sourceChars,beforeChars:sum.beforeChars+row.beforeChars,fullRequestChars:sum.fullRequestChars+row.fullRequestChars,wireChars:sum.wireChars+row.wireChars}),{sourceChars:0,beforeChars:0,fullRequestChars:0,wireChars:0});
  console.log(JSON.stringify({unit:'UTF16 characters, local request projection only, no model calls or measured token claim',rows,totals,reductionPercent:Math.round((1-totals.wireChars/totals.fullRequestChars)*10000)/100},null,2));
 }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
