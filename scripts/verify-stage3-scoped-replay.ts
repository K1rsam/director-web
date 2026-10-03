import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildFoundationFacts} from '../lib/foundation-facts';
import {loadFoundationSourceContext} from '../lib/foundation-source';
import {prisma} from '../lib/prisma';
// Native ESM runtime has no TypeScript declarations; this read-only audit uses
// its public functions and verifies the complete saved request at runtime.
const loadRuntime=(file:string)=>import(file);

// Fixed paid samples; no engine/coordinator/provider imports or production writes.
const protectedFiles=new Map<string,string>();
const hash=(x:string)=>createHash('sha256').update(x).digest('hex');
async function read(file:string){const text=await readFile(file,'utf8');protectedFiles.set(file,hash(text));return text;}
const json=async(file:string)=>JSON.parse(await read(file));
const base='.storyboard-stage3-v2';
async function main(){
const [{buildRequest,captureRules},{selectProductionMaterials,changedConsumedMaterials},{validateProductionFeedback},{PRODUCTION_SUPPLY_VERSION},{restoreModelCoordinates}]=await Promise.all([
 loadRuntime('../runtime/storyboard-v4/core/core.mjs'),loadRuntime('../runtime/production-materials.mjs'),loadRuntime('../runtime/episode-boundary.mjs'),loadRuntime('../runtime/production-supply.mjs'),loadRuntime('../runtime/storyboard-v4/core/model-coordinates.mjs')]);
const context=await loadFoundationSourceContext('cmupfto5w0001l4m4vle7bmfi');
const metadata=buildFoundationFacts({version:'offline-outline',episodes:[]} as any,context,null).facts;
const refs=new Map(metadata.filter(f=>f.contextUse).map(f=>[JSON.stringify(f.evidence),f.contextUse]));
const rows:any[]=[];
for(const id of ['ad4a98e7-b693-45e3-b31d-d5c34066636e','5f68388b-f423-4522-b332-7d8e772da294']){
 const d=await json(`${base}/documents/${id}.json`),source=structuredClone(d.source);
 for(const group of Object.values(source.context.retrievalFacts) as any[])if(Array.isArray(group))for(const fact of group){const role=refs.get(JSON.stringify(fact.evidence));if(role)fact.contextUse=structuredClone(role);}
 const operations=d.operations.filter((o:any)=>!['29d669c6-ddb1-4e66-94b8-ba1c572c92d2','486afe26-6f8b-4d0e-89dd-bc1af87b405b'].includes(o.attemptId));
 for(const op of operations){
  const saved=await json(`${base}/attempts/${op.attemptId}/request.json`);
  const payload={stage:op.stage,source:d.source,settings:d.settings,plan:d.plan,choice:d.choice,packageIds:op.packageIds,previousDraft:op.previousDraft,issues:op.issues,finishMode:op.finishMode,voiceReference:d.voiceReference,rulesSnapshot:d.rulesSnapshot,dependencyExits:saved.plan?.dependencyExits??{},acceptedContinuity:saved.plan?.acceptedContinuity,productionSnapshot:op.productionSnapshot};
  const old=buildRequest(payload);
  assert.equal(old.promptHash,saved.promptHash,`old prompt is immutable: ${op.attemptId}`);
  assert.equal(old.inputHash,saved.inputHash,`old input is immutable: ${op.attemptId}`);
  const snapshot={...structuredClone(op.productionSnapshot),supplyVersion:PRODUCTION_SUPPLY_VERSION};
  const proposed={...payload,source,rulesSnapshot:captureRules(),productionSnapshot:snapshot};
  const probe=buildRequest(proposed);
  snapshot.materials=selectProductionMaterials(snapshot.materials,op.stage,d.plan,op.packageIds,d.production.needs??[],probe.source,PRODUCTION_SUPPLY_VERSION);
  const next=buildRequest(proposed);
  assert.deepEqual(next.source.sourceRows,saved.source.sourceRows,'all current production rows survive unchanged');
  assert.deepEqual(next.source.dialogue,saved.source.dialogue,'speaker, cue, channel and exact quote survive');
  for(const w of next.plan?.workPackages??[])for(const ref of [...w.contextRefs,...next.source.entryFacts.flatMap((f:any)=>f.sourceRefs)])assert.ok([...next.source.sourceRows,...next.source.contextRows].some((r:any)=>r.id===ref),`readable planned evidence: ${ref}`);
  assert.ok(!(next.source.context.retrievalFacts.background??[]).some((f:any)=>f.contextUse?.episode!==undefined&&f.contextUse.episode!==d.web.binding.episodeNumber));
  const measures={attemptId:op.attemptId,stage:op.stage,packages:op.packageIds,oldChars:saved.prompt.length,newChars:next.prompt.length,oldContextRows:saved.source.contextRows.length,newContextRows:next.source.contextRows.length,oldCards:saved.productionSnapshot.materials.length,newCards:next.productionSnapshot.materials.length};
  rows.push(measures);
  if(op.attemptId==='ba875dc5-9de2-4d61-aa35-1928d87d3077'){
   const raw=await read(`${base}/attempts/${op.attemptId}/raw.txt`),output=restoreModelCoordinates(JSON.parse(raw),saved.modelCoordinates);
   validateProductionFeedback(output.productionFeedback,{...saved,plan:output,productionSnapshot:snapshot});
  }
  if(['63d06917-3fdd-46de-89e8-7b01fe1d72a9','84457f51-744e-407b-a98f-105dfd41240a'].includes(op.attemptId)){
   const current=await json(`${base}/attempts/486afe26-6f8b-4d0e-89dd-bc1af87b405b/request.json`);
   const original=d.candidates.find((c:any)=>c.attemptId===op.attemptId);
   const used=original.productionFeedback.usedMaterialIds.filter((key:string)=>snapshot.materials.some((m:any)=>m.id===key));
   assert.deepEqual(changedConsumedMaterials(snapshot.materials,current.productionSnapshot.materials,used,next.source,PRODUCTION_SUPPLY_VERSION),[],'pure off-scope index assembly buys no repair');
  }
 }
}
for(const [file,before] of protectedFiles)assert.equal(hash(await readFile(file,'utf8')),before,`protected paid file: ${file}`);
await prisma.$disconnect();
const output=await mkdtemp(path.resolve('runtime-3008/stage3-scoped-replay-'));
const report={schema:'STAGE3_SCOPED_REPLAY_V1',providerCalls:0,productionWrites:0,protectedFilesChecked:protectedFiles.size,measure:'UTF16_PROMPT_CHARACTERS_NOT_TOKEN_SAVINGS',rows};
await writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));
process.stdout.write(JSON.stringify({output,...report})+'\n');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>prisma.$disconnect());
