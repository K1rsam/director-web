import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {buildRequest} from '../runtime/storyboard-v4/core/core.mjs';
import {restoreModelCoordinates} from '../runtime/storyboard-v4/core/model-coordinates.mjs';
import {digest} from '../runtime/storyboard-v4/core/shared.mjs';

// Reads saved requests only; never imports a provider or opens the production database.
const root=process.cwd(),data=path.join(root,'.storyboard-stage3-v2'),ids=['ad4a98e7-b693-45e3-b31d-d5c34066636e','5f68388b-f423-4522-b332-7d8e772da294'];
const read=file=>readFile(file,'utf8').then(JSON.parse);
const model=r=>JSON.parse(r.prompt.split('【生效设置与本次完整资料】\n')[1].split('\n')[0]);
function expand(r){
 const input=model(r),aliases=r.modelCoordinates?.aliases??{};
 const get=p=>p.slice(2).split('/').reduce((v,k)=>v[k.replaceAll('~1','/').replaceAll('~0','~')],input);
 const visit=v=>{
  if(typeof v==='string')return aliases[v]??v;
  if(!v||typeof v!=='object')return v;
  if(v.$same)return visit(get(v.$same));
  if(v.$rowIds)return v.$rowIds.flatMap(([k,a,b])=>input.source[k].slice(a,b+1).map(r=>visit(r.id)));
  if(v.$joinRows){const [k,a,b,s]=v.$joinRows;return input.source[k].slice(a,b+1).map(r=>r.text).join(s);}
  if(v.$boundaryNodes)return v.$boundaryNodes.rows.map(row=>Object.fromEntries(v.$boundaryNodes.columns.map((k,i)=>[k,visit(row[i])])));
  if(v.$jsonOf)return JSON.stringify(visit(get(v.$jsonOf)));
  return Array.isArray(v)?v.map(visit):Object.fromEntries(Object.entries(v).map(([k,x])=>[k,visit(x)]));
 };
 const value=visit(input);
 if(value.previousDraft?.previousPlan&&typeof value.previousDraft.rawText==='string')value.previousDraft.rawText=JSON.parse(value.previousDraft.rawText);
 return value;
}
// Independent schema traversal: simulate the exact aliases in enum/$ref leaves,
// plus protocol ID-shaped free strings. Do not copy the decoder's field allowlist.
function modelOutput(output,mapping,schema){
 const aliases=new Map(Object.entries(mapping?.aliases??{}).map(([a,b])=>[b,a]));
 const resolve=s=>s?.$ref?s.$ref.slice(2).split('/').reduce((v,k)=>v[k],schema):s;
 const variants=items=>items.flatMap(item=>{const s=resolve(item);return s?.anyOf?variants(s.anyOf):s?.allOf?variants(s.allOf):s?[s]:[];});
 const visit=(v,k,schemas)=>{
  const shapes=variants(schemas);
  if(typeof v==='string'){
   const alias=aliases.get(v),referenced=alias&&shapes.some(s=>s.enum?.includes(alias)||s.const===alias);
   return alias&&(referenced||k==='id'||/Ids?$/.test(k??'')||/Refs?$/.test(k??'')||['replaces','dependsOn','target','coordinate'].includes(k))?alias:v;
  }
  if(!v||typeof v!=='object')return v;
  return Array.isArray(v)?v.map(x=>visit(x,k,shapes.flatMap(s=>s.items?[s.items]:[]))):Object.fromEntries(Object.entries(v).map(([key,x])=>[key,visit(x,key,shapes.flatMap(s=>s.properties?.[key]?[s.properties[key]]:[]))]));
 };return visit(output,undefined,[schema]);
}
const results=[];
for(const id of ids){
 const documentFile=path.join(data,'documents',id+'.json'),d=await read(documentFile),protectedKeys=['source','settings','plan','operations','candidates','adopted','assembly'];
 const protectedHashes=Object.fromEntries(protectedKeys.map(k=>[k,digest(d[k])]));
 for(const op of d.operations){
  const attempt=path.join(data,'attempts',op.attemptId),r=await read(path.join(attempt,'request.json')),receipt=await read(path.join(attempt,'receipt.json'));
  const raw=await readFile(path.join(attempt,'raw.txt'),'utf8'),paid=JSON.parse(raw);
  const payload={stage:op.stage,source:d.source,settings:d.settings,plan:d.plan,choice:d.choice,packageIds:op.packageIds,previousDraft:op.previousDraft,voiceReference:d.voiceReference,rulesSnapshot:d.rulesSnapshot,
   dependencyExits:r.plan?.dependencyExits??{},acceptedContinuity:r.plan?.acceptedContinuity,issues:op.issues,finishMode:op.finishMode,executionBatch:r.executionBatch,productionSnapshot:r.productionSnapshot};
  const old=buildRequest(payload),next=buildRequest({...payload,productionSnapshot:{...r.productionSnapshot,transportVersion:'production-compact-v2'}});
  assert.equal(old.promptHash,r.promptHash);assert.equal(old.inputHash,r.inputHash);assert.equal(old.schemaHash,r.schemaHash);
  assert.deepEqual(expand(next),expand(old),`${op.attemptId}: all model semantic materials must round trip`);
  assert.deepEqual(next.source,old.source);assert.deepEqual(next.settings,old.settings);assert.deepEqual(next.loadedFiles,old.loadedFiles);assert.deepEqual(next.snapshot,old.snapshot);
  // New paid replies may already use their saved request's short namespace.
  // Restore that immutable namespace before simulating a different transport;
  // never treat the same short token in two requests as the same coordinate.
  const canonicalPaid=restoreModelCoordinates(paid,r.modelCoordinates);
  const shortOutput=modelOutput(canonicalPaid,next.modelCoordinates,next.schema);
  assert.deepEqual(restoreModelCoordinates(shortOutput,next.modelCoordinates),canonicalPaid,'entire real paid output must restore including schema-derived material and relationship links');
  assert.equal(await readFile(path.join(attempt,'raw.txt'),'utf8'),raw);
  assert.deepEqual(await read(path.join(attempt,'request.json')),r);
  const chars=q=>q.prompt.length+q.instructions.length+JSON.stringify(q.schema).length;
  results.push({episode:d.web.binding.episodeNumber,stage:op.stage,packages:op.packageIds,attemptId:op.attemptId,knownTokens:receipt.usage.totalTokens,
   beforeChars:chars(old),afterChars:chars(next),reductionPercent:Number((100*(chars(old)-chars(next))/chars(old)).toFixed(2)),
   sourceFactsHistoryCardsProseAndMethodsPreserved:true,paidBodyAndOldFingerprintPreserved:true,coordinateCount:Object.keys(next.modelCoordinates?.aliases??{}).length,
   duplicatePlanJSON:!!model(next).previousDraft?.rawText?.$jsonOf,
   materialLinksShortened:(shortOutput.productionFeedback?.usedMaterialIds??[]).filter(id=>/^R\d{4}$/.test(id)).length});
 }
 const current=await read(documentFile);for(const k of protectedKeys)assert.equal(digest(current[k]),protectedHashes[k],`live ${k} remains unchanged`);
}
const episodes=[1,2].map(episode=>{
 const selected=results.filter(r=>r.episode===episode),beforeChars=selected.reduce((n,r)=>n+r.beforeChars,0),afterChars=selected.reduce((n,r)=>n+r.afterChars,0);
 return {episode,requests:selected.length,beforeChars,afterChars,reductionPercent:Number((100*(beforeChars-afterChars)/beforeChars).toFixed(2))};
});
const report={schema:'STAGE3_LOSSLESS_INPUT_AUDIT_V1',at:new Date().toISOString(),providerCalls:0,originalWrites:0,measure:'UTF16 characters of actual prompt + instructions + schema; not measured Token savings',episodes,results};
const directory=await mkdtemp(path.join(root,'runtime-3008/stage3-input-audit-'));
await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({directory,providerCalls:0,episodes,requests:results.map(({episode,stage,beforeChars,afterChars,reductionPercent,duplicatePlanJSON})=>({episode,stage,beforeChars,afterChars,reductionPercent,duplicatePlanJSON}))},null,2));
