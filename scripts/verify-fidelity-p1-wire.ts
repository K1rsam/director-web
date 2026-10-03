/** Pure projection/evidence checks. Optional campaign reads never write or dispatch. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync} from 'node:fs';
import path from 'node:path';

const json=(value:unknown)=>JSON.stringify(value),hash=(value:unknown)=>createHash('sha256').update(json(value)).digest('hex');
async function main(){
 const moduleUrl=new URL('../lib/fidelity-p1-wire.ts',import.meta.url);assert.ok(existsSync(moduleUrl),'The lossless P1 wire projection must be implemented');
 const {compactP1WireV2,expandP1WireEvidence,P1_WIRE_V2_MODEL_NOTE}=await import(moduleUrl.href);
 const blocks=Array.from({length:360},(_,i)=>[`B${String(i+1).padStart(6,'0')}`,i===0?'1-1 仓库 日 内\r\n':i%2===0?`甲（OS）：第${i}句，不能删去提示与标点。\r\n`:i%10===1?'\u00a0\r\n':'\n']);
 const v1={reviewMode:'FULL_STRUCTURE_BLOCKS_V1',sourceVersion:'source-1',batch:{firstBlock:'B000001',lastBlock:'B000360',index:1,total:2},issues:[{code:'SCENE_BOUNDARY_UNCONFIRMED',message:'待核对场界',sectionKeys:blocks.filter((_,i)=>i%2===0).map(b=>b[0])}],blocks,before:'前批尾声（对白提示原样保留）。\n',baseline:[{episodeNumber:'1',firstBlock:'B000001',lastBlock:'B000360'}]};
 const before=json(v1),v2=compactP1WireV2(v1);
 assert.equal(v2.reviewMode,'FULL_STRUCTURE_BLOCKS_V2');assert.ok(json(v2).length+P1_WIRE_V2_MODEL_NOTE.length+1<before.length,'count the actual extra model explanation before enabling V2');
 assert.equal(json(expandP1WireEvidence(v2)),before,'V2 expands byte-for-byte to the original V1 JSON including key order, blank variants and cues');assert.equal(json(v1),before,'projection does not mutate the original');assert.deepEqual(v2.batch,v1.batch);assert.equal(v2.blocks.at(-1)[0],'B000359');assert.equal(v2.blocks.length,180);assert.ok(v2.issues[0].sectionKeyRuns);assert.match(P1_WIRE_V2_MODEL_NOTE,/空白/);assert.match(P1_WIRE_V2_MODEL_NOTE,/batch/);assert.match(P1_WIRE_V2_MODEL_NOTE,/不.*还原|无需.*还原/);
 assert.equal(expandP1WireEvidence(v1),v1,'old paid V1 evidence is not rewritten');
 const reordered={before:v1.before,blocks:v1.blocks,baseline:v1.baseline,issues:[{sectionKeys:v1.issues[0].sectionKeys,message:'待核对场界',code:'SCENE_BOUNDARY_UNCONFIRMED'}],batch:{total:2,lastBlock:'B000360',firstBlock:'B000001',index:1},sourceVersion:v1.sourceVersion,reviewMode:v1.reviewMode};assert.equal(json(expandP1WireEvidence(compactP1WireV2(reordered))),json(reordered),'property ordering must not change paid-work bytes');
 for(const mutate of [
  (v:any)=>{v.futureMetadata={preserve:'unknown'};},(v:any)=>{v.batch.extra=true;},(v:any)=>{v.issues[0].severity='future';},(v:any)=>{v.baseline[0].sourceRefs=['future'];},
  (v:any)=>{v.blocks.splice(1,1);},(v:any)=>{v.blocks[1][0]='UNUSUAL';},(v:any)=>{v.blocks[1].push('future');},(v:any)=>{v.repairAttempt=1;v.context=[];},(v:any)=>{v.batch.lastBlock='B000359';},
 ]){const changed=structuredClone(v1);mutate(changed);assert.equal(compactP1WireV2(changed),changed,'unknown, repair, non-contiguous or mismatched inputs fall back intact');}
 const tiny={...v1,batch:{firstBlock:'B000001',lastBlock:'B000002',index:1,total:1},blocks:[['B000001','△甲站住。\n'],['B000002','\n']],issues:[],baseline:[]};assert.equal(compactP1WireV2(tiny),tiny,'larger wire must fall back');
 const reorderedRefs=structuredClone(v1);reorderedRefs.issues[0].sectionKeys=['B000005','B000001','B000005'];const kept=compactP1WireV2(reorderedRefs);assert.deepEqual(kept.issues[0].sectionKeys,reorderedRefs.issues[0].sectionKeys);assert.equal(json(expandP1WireEvidence(kept)),json(reorderedRefs),'non-monotone or repeated references are never sorted/deduplicated');
 for(const mutate of [
  (v:any)=>{v.wireEncoding.defaultBlankText='删掉了正文';},(v:any)=>{v.wireEncoding.defaultBlankText=' ';},(v:any)=>{v.wireEncoding.blankExceptions.push(['B000001','\n']);},(v:any)=>{v.wireEncoding.blankExceptions.push(v.wireEncoding.blankExceptions[0]);},
  (v:any)=>{v.blocks.splice(1,1);},(v:any)=>{v.blocks[0][1]+='改文';},(v:any)=>{v.batch.lastBlock='B999999';},(v:any)=>{v.wireEncoding.expandedJsonHash='0'.repeat(64);},(v:any)=>{v.wireEncoding.future=true;},(v:any)=>{v.issues[0].sectionKeyRuns[0]=['B000001','B000360'];},(v:any)=>{v.issues[0].sectionKeyRuns.push(v.issues[0].sectionKeyRuns[0]);},
  (v:any)=>{delete v.blocks[1];},(v:any)=>{delete v.wireEncoding.blankExceptions[0];},(v:any)=>{delete v.issues[0].sectionKeyRuns[0];},
 ]){const bad=structuredClone(v2);mutate(bad);assert.throws(()=>expandP1WireEvidence(bad),/P1_WIRE_INVALID/,'bad V2 encoding must fail closed, not guess missing text');}
 const guardFailures:string[]=[];
 const guard=(name:string,check:()=>void)=>{try{check();}catch(error){guardFailures.push(`${name}: ${(error as Error).message.slice(0,160)}`);}};
 for(const [name,mutate]of Object.entries({blocks:(v:any)=>{delete v.blocks[1];},baseline:(v:any)=>{delete v.baseline[0];},issues:(v:any)=>{delete v.issues[0];},sectionKeys:(v:any)=>{delete v.issues[0].sectionKeys[1];}})){
  guard(`sparse ${name} retains original V1`,()=>{const sparse=structuredClone(v1);mutate(sparse);assert.ok(compactP1WireV2(sparse)===sparse);});
 }
 // Valid checksums make these genuine expansion bombs, not ordinary hash failures.
 // Keep each reproduction around 20M characters; never allocate an unbounded case.
 const checkExpansionLimit=(name:string,original:any,wireBlocks:string[][],wireIssues:any[],defaultBlankText:string)=>{
  const compact={...original,reviewMode:'FULL_STRUCTURE_BLOCKS_V2',blocks:wireBlocks,issues:wireIssues,wireEncoding:{scheme:'BLANK_DEFAULT_VISIBLE_RUNS_V2',defaultBlankText,blankExceptions:[],expandedJsonHash:hash(original)}};
  guard(`${name} compactor falls back`,()=>assert.ok(compactP1WireV2(original)===original,'over-budget V1 must remain the original object, never truncate'));
  guard(`${name} decoder rejects`,()=>assert.throws(()=>expandP1WireEvidence(compact),/P1_WIRE_INVALID/,'reject aggregate expansion before reconstructing blocks or references'));
 };
 const longBlank=' '.repeat(40_000)+'\n',blankRows=Array.from({length:500},(_,i)=>[`B${String(i+1).padStart(6,'0')}`,longBlank]);
 checkExpansionLimit('default blank amplification',{...v1,batch:{firstBlock:'B000001',lastBlock:'B000500',index:1,total:1},blocks:blankRows,issues:[],baseline:[]},[],[],longBlank);
 const visibleRows=Array.from({length:2000},(_,i)=>[`B${String(i+1).padStart(6,'0')}`,'甲。\n']),visibleKeys=visibleRows.map(([id])=>id);
 const refsIssues=Array.from({length:1300},()=>({code:'X',message:'原样引用',sectionKeys:visibleKeys})),runsIssues=refsIssues.map(({code,message})=>({code,message,sectionKeyRuns:[['B000001','B002000']]}));
 checkExpansionLimit('cumulative issue references',{...v1,batch:{firstBlock:'B000001',lastBlock:'B002000',index:1,total:1},blocks:visibleRows,issues:refsIssues,baseline:[]},visibleRows,runsIssues,'\n');
 const combinedBlank=' '.repeat(24_000)+'\n',combinedRows=[...visibleRows,...Array.from({length:500},(_,i)=>[`B${String(i+2001).padStart(6,'0')}`,combinedBlank])];
 checkExpansionLimit('combined text and references',{...v1,batch:{firstBlock:'B000001',lastBlock:'B002500',index:1,total:1},blocks:combinedRows,issues:refsIssues.slice(0,500),baseline:[]},visibleRows,runsIssues.slice(0,500),combinedBlank);
 assert.deepEqual(guardFailures,[],'sparse inputs and aggregate expansion limits must fail safely');
 const boundaryBlank='\t'.repeat(31_000)+'\n',boundaryRows=Array.from({length:256},(_,i)=>[`B${String(i+1).padStart(6,'0')}`,i?boundaryBlank:'甲（OS）：\\"\u0000\ud800😀\r\n']);
 const atLimit={...v1,batch:{firstBlock:'B000001',lastBlock:'B000256',index:1,total:1},blocks:boundaryRows,issues:[],baseline:[]};
 boundaryRows.at(-1)![1]+=' '.repeat(16_000_000-json(atLimit).length);
 assert.equal(json(atLimit).length,16_000_000);const boundedWire=compactP1WireV2(atLimit);
 assert.equal(boundedWire.reviewMode,'FULL_STRUCTURE_BLOCKS_V2','the exact limit is accepted, including escaped controls, paired and lone surrogates');
 assert.equal(hash(expandP1WireEvidence(boundedWire)),hash(atLimit),'the boundary case retains every escaped UTF-16 code unit');
 const overLimit={...atLimit,before:atLimit.before+' '};assert.ok(compactP1WireV2(overLimit)===overLimit,'one encoded UTF-16 character beyond the cap falls back');
 const oversizedWire={...boundedWire,before:boundedWire.before+' ',wireEncoding:{...boundedWire.wireEncoding,expandedJsonHash:hash(overLimit)}};
 assert.throws(()=>expandP1WireEvidence(oversizedWire),/P1_WIRE_INVALID/,'one character beyond the cap is rejected even with the correct hash');
 console.log('PASS lossless blanks/ranges, original order/hash, sparse/unknown/repair/size fallback, aggregate 16M expansion guard and exact-limit/escape boundaries; DB/model calls 0');

 const {projectP1ReviewEvidenceRequest,restoreP1ReviewRequest,validateP1ReviewPlan}=await import('../lib/fidelity-p1-review');
 assert.equal(json(projectP1ReviewEvidenceRequest(v2)),json(projectP1ReviewEvidenceRequest(v1)),'the real evidence entrypoint must expand V2 before hashing, not rely on callers doing it');
 const syntheticSource=blocks.map(([,text])=>text).join('');
 assert.deepEqual(restoreP1ReviewRequest(v2,syntheticSource),restoreP1ReviewRequest(v1,syntheticSource),'the actual history receiver accepts V2 against the exact original source');

 const campaign=process.argv[2];if(!campaign)return;
 const requests=readdirSync(path.join(campaign,'requests')).sort().map(file=>({file,saved:JSON.parse(readFileSync(path.join(campaign,'requests',file),'utf8'))})).filter(({saved})=>saved.payload?.stage==='F1').map(({file,saved})=>({file,saved,v1:JSON.parse(saved.payload.taskPrompt.split('INPUT_JSON:\n').at(-1))})).filter(row=>row.v1.reviewMode==='FULL_STRUCTURE_BLOCKS_V1').sort((a,b)=>a.v1.batch.index-b.v1.batch.index);
 assert.ok(requests.length>=2,'campaign first and second requests are required');const source=requests.slice(0,2).flatMap(row=>row.v1.blocks.map((b:[string,string])=>b[1])).join('');
 for(const row of requests.slice(0,2)){
  const compact=compactP1WireV2(row.v1),expanded=expandP1WireEvidence(compact);assert.equal(compact.reviewMode,'FULL_STRUCTURE_BLOCKS_V2');assert.equal(json(expanded),json(row.v1));
  const work=(request:any)=>hash({receiver:'FIDELITY_SOURCE_ACCEPT_V2',request:projectP1ReviewEvidenceRequest(request)});assert.equal(work(compact),work(row.v1),'the existing paid-work fingerprint is unchanged through the actual entrypoint');
  const restored=restoreP1ReviewRequest(compact,source),oldRestored=restoreP1ReviewRequest(row.v1,source);assert.equal(json(restored),json(oldRestored));
  const responseFile=path.join(campaign,'responses',row.file);let receiptSummary={};
  if(existsSync(responseFile)){const response=JSON.parse(readFileSync(responseFile,'utf8')),data=response.data;assert.equal(response.requestFingerprint,row.saved.requestFingerprint);assert.deepEqual(data.reviewed,{firstBlock:row.v1.batch.firstBlock,lastBlock:row.v1.batch.lastBlock});const lookup=new Map(expanded.blocks);for(const assignment of data.assignments){assert.ok(lookup.has(assignment.firstBlock)&&lookup.has(assignment.lastBlock));}
   const evaluate=(request:any)=>{try{return {result:validateP1ReviewPlan(data,request)};}catch(error){return {error:(error as Error).message};}};const originalResult=evaluate(oldRestored),expandedResult=evaluate(restored);assert.deepEqual(expandedResult,originalResult,'old response validation is unchanged, not silently upgraded');receiptSummary={assignments:data.assignments.length,blankEndAssignments:data.assignments.filter((a:any)=>!String(lookup.get(a.lastBlock)).trim()).length,validation:'error'in expandedResult?'same-existing-error':'same-accepted-result'};
  }
  const delta=json(row.v1).length-json(compact).length-P1_WIRE_V2_MODEL_NOTE.length-1;console.log(JSON.stringify({file:row.file,batch:row.v1.batch.index,originalSentChars:row.saved.payload.sentPrompt.length,v2SentCharsWithNote:row.saved.payload.sentPrompt.length-delta,savedChars:delta,unit:'UTF16_CHARS_NOT_TOKENS',originalBlockCount:row.v1.blocks.length,wireBlockCount:compact.blocks.length,byteIdenticalV1:true,paidWorkFingerprintEqual:true,receipt:receiptSummary,modelCalls:0}));
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
