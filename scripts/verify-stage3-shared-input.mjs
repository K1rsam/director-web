import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {buildRequest} from '../runtime/storyboard-v4/core/core.mjs';
import {buildFeedbackRepairRequest,CURRENT_FEEDBACK_REPAIR_VERSION} from '../runtime/feedback-repair.mjs';
import {SHARED_PRODUCTION_TRANSPORT_VERSION} from '../runtime/production-transport.mjs';
import {restoreModelCoordinates} from '../runtime/storyboard-v4/core/model-coordinates.mjs';
import {resolveRunnerLimits} from '../runtime/storyboard-v4/core/runner.mjs';
import {digest} from '../runtime/storyboard-v4/core/shared.mjs';

// No provider import, production writes or full private material output.
const groups=[['previous','ad4a98e7-b693-45e3-b31d-d5c34066636e','5f68388b-f423-4522-b332-7d8e772da294'],['current','092593f0-a94c-48cb-9965-5798273cb37f','386cb58c-6f57-4181-9121-229011dbb40e']];
const root=path.resolve('.storyboard-stage3-v2'),protectedFiles=new Map(),rows=[];
async function protectedRead(file){const bytes=await readFile(file);protectedFiles.set(file,createHash('sha256').update(bytes).digest('hex'));return bytes;}
const read=file=>protectedRead(file).then(bytes=>JSON.parse(bytes.toString('utf8')));
const inputOf=r=>JSON.parse(r.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n')[0]);
function expandInput(r){
 const input=inputOf(r),aliases=r.modelCoordinates?.aliases??{};
 const at=p=>p.slice(2).split('/').reduce((v,k)=>v[k.replaceAll('~1','/').replaceAll('~0','~')],input);
 const visit=v=>{
  if(typeof v==='string')return aliases[v]??v;
  if(!v||typeof v!=='object')return v;
  if(v.$same)return visit(at(v.$same));
  if(v.$rowIds)return v.$rowIds.flatMap(([k,a,b])=>input.source[k].slice(a,b+1).map(r=>visit(r.id)));
  if(v.$joinRows){const [k,a,b,s]=v.$joinRows;return input.source[k].slice(a,b+1).map(r=>r.text).join(s);}
  if(v.$boundaryNodes)return v.$boundaryNodes.rows.map(row=>Object.fromEntries(v.$boundaryNodes.columns.map((k,i)=>[k,visit(row[i])])));
  if(v.$jsonOf)return JSON.stringify(visit(at(v.$jsonOf)));
  return Array.isArray(v)?v.map(visit):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x)]));
 };const result=visit(input);
 if(result.previousDraft?.previousPlan&&typeof result.previousDraft.rawText==='string')result.previousDraft.rawText=JSON.parse(result.previousDraft.rawText);
 return result;
}
function expandSchema(r){
 const aliases=r.modelCoordinates?.aliases??{},schema=r.schema;
 const visit=v=>typeof v==='string'?aliases[v]??v:!v||typeof v!=='object'?v:v.$ref?visit(v.$ref.slice(2).split('/').reduce((s,k)=>s[k],schema)):Array.isArray(v)?v.map(visit):Object.fromEntries(Object.entries(v).filter(([k])=>k!=='$defs').map(([k,x])=>[k,visit(x)]));
 return visit(schema);
}
function reAlias(output,mapping){
 const aliases=new Map(Object.entries(mapping?.aliases??{}).map(([a,b])=>[b,a]));
 // Independent response coordinate detection, not the restoration implementation.
 const visit=(v,k)=>{
  const coordinate=k==='id'||/Ids?$/.test(k??'')||/Refs?$/.test(k??'')||['replaces','dependsOn','target','coordinate','rowId','contextRef','sectionKey','sourceTextHash','sourceVersion','sourceContextVersion','versionId','baseDraftHash'].includes(k);
  if(typeof v==='string')return coordinate?aliases.get(v)??v:v;
  return !v||typeof v!=='object'?v:Array.isArray(v)?v.map(x=>visit(x,k)):Object.fromEntries(Object.entries(v).map(([key,x])=>[key,visit(x,key)]));
 };return visit(output);
}
const chars=r=>r.prompt.length+r.instructions.length+JSON.stringify(r.schema).length;
for(const [group,...ids] of groups)for(const id of ids){
 const d=await read(path.join(root,'documents',id+'.json')),requests=new Map();
 for(const op of d.operations){
  const directory=path.join(root,'attempts',op.attemptId),request=await read(path.join(directory,'request.json'));
  requests.set(op.attemptId,request);await read(path.join(directory,'receipt.json'));await protectedRead(path.join(directory,'raw.txt'));
 }
 const rebuild=op=>{
  const r=requests.get(op.attemptId);
  if(op.feedbackRepair){
   const candidate=d.candidates.find(c=>c.id===op.feedbackRepair.candidateId),baseOp=d.operations.find(o=>o.attemptId===candidate.attemptId);
   return buildFeedbackRepairRequest(rebuild(baseOp),candidate,op.issues,{version:op.feedbackRepair.version});
  }
  return buildRequest({stage:op.stage,source:d.source,settings:d.settings,plan:d.plan,choice:d.choice,packageIds:op.packageIds,previousDraft:op.previousDraft,voiceReference:d.voiceReference,rulesSnapshot:d.rulesSnapshot,
   dependencyExits:r.plan?.dependencyExits??{},acceptedContinuity:r.plan?.acceptedContinuity,issues:op.issues,finishMode:op.finishMode,executionBatch:r.executionBatch,productionSnapshot:r.productionSnapshot});
 };
 for(const op of d.operations){
  const saved=requests.get(op.attemptId),old=rebuild(op);
  for(const key of ['promptHash','inputHash','instructionHash','schemaHash'])assert.equal(old[key],saved[key],`${op.attemptId}: historical ${key}`);
  assert.equal(digest([old.promptHash,old.instructionHash,old.inputHash]),op.fingerprint,'old operation fingerprint');
  let next,baseline=old;
  if(op.feedbackRepair){
   const candidate=d.candidates.find(c=>c.id===op.feedbackRepair.candidateId),base=rebuild(d.operations.find(o=>o.attemptId===candidate.attemptId));
   baseline=buildFeedbackRepairRequest(base,candidate,op.issues,{version:'production-feedback-repair-v2'});
   next=buildFeedbackRepairRequest(base,candidate,op.issues,{version:CURRENT_FEEDBACK_REPAIR_VERSION});
   assert.equal(next.prompt,baseline.prompt);assert.equal(next.instructions,baseline.instructions);
  }else{
   const r=saved;
   next=buildRequest({stage:op.stage,source:d.source,settings:d.settings,plan:d.plan,choice:d.choice,packageIds:op.packageIds,previousDraft:op.previousDraft,voiceReference:d.voiceReference,rulesSnapshot:d.rulesSnapshot,
    dependencyExits:r.plan?.dependencyExits??{},acceptedContinuity:r.plan?.acceptedContinuity,issues:op.issues,finishMode:op.finishMode,executionBatch:r.executionBatch,productionSnapshot:{...r.productionSnapshot,transportVersion:SHARED_PRODUCTION_TRANSPORT_VERSION}});
   assert.equal(digest(expandInput(next)),digest(expandInput(old)),`${op.attemptId}: every source, design and creative material`);
   assert.deepEqual(next.snapshot,old.snapshot);assert.deepEqual(next.loadedFiles,old.loadedFiles);
   assert.ok(resolveRunnerLimits(next).totalMs>=resolveRunnerLimits(old).totalMs,'formatting does not reduce execution time');
   baseline=buildRequest({stage:op.stage,source:d.source,settings:d.settings,plan:d.plan,choice:d.choice,packageIds:op.packageIds,previousDraft:op.previousDraft,voiceReference:d.voiceReference,rulesSnapshot:d.rulesSnapshot,
    dependencyExits:r.plan?.dependencyExits??{},acceptedContinuity:r.plan?.acceptedContinuity,issues:op.issues,finishMode:op.finishMode,executionBatch:r.executionBatch,productionSnapshot:{...r.productionSnapshot,transportVersion:'production-compact-v2'}});
  }
  assert.equal(digest(expandSchema(next)),digest(expandSchema(baseline)),`${op.attemptId}: same complete v2 output constraints`);
  const paid=d.candidates.find(c=>c.attemptId===op.attemptId&&!c.derivedFrom&&!c.feedbackMerged);
  if(paid?.output&&!op.feedbackRepair){
   const raw=await protectedRead(path.join(root,'attempts',op.attemptId,'raw.txt'));
   assert.equal(digest(restoreModelCoordinates(JSON.parse(raw),saved.modelCoordinates)),digest(paid.output),'saved candidate equals its immutable paid response');
   assert.equal(digest(restoreModelCoordinates(reAlias(paid.output,next.modelCoordinates),next.modelCoordinates)),digest(paid.output),'all paid output coordinates and prose preserved');
  }
  rows.push({group,episode:d.web.binding.episodeNumber,stage:op.feedbackRepair?'receipt':op.stage,attemptId:op.attemptId,beforeChars:chars(old),afterChars:chars(next),reductionPercent:Number((100*(chars(old)-chars(next))/chars(old)).toFixed(2)),historicalRequestPreserved:true,materialsEquivalent:true});
 }
}
for(const name of await readdir('.production-ledgers/documents'))if(name.endsWith('.json'))await protectedRead(path.resolve('.production-ledgers/documents',name));
for(const [file,hash] of protectedFiles)assert.equal(createHash('sha256').update(await readFile(file)).digest('hex'),hash,'production file unchanged');
const totals=groups.map(([group])=>{const selected=rows.filter(r=>r.group===group),beforeChars=selected.reduce((n,r)=>n+r.beforeChars,0),afterChars=selected.reduce((n,r)=>n+r.afterChars,0);return {group,requests:selected.length,beforeChars,afterChars,reductionPercent:Number((100*(beforeChars-afterChars)/beforeChars).toFixed(2))};});
console.log(JSON.stringify({providerCalls:0,productionWrites:0,protectedFiles:protectedFiles.size,measure:'Actual prompt + instructions + schema UTF16 characters, not measured Token savings',totals,rows},null,2));
