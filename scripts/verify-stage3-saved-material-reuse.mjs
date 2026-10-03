import assert from 'node:assert/strict';
import {mkdir,mkdtemp,copyFile,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createEngine} from '../runtime/storyboard-v4/core/pipeline.mjs';
import {digest} from '../runtime/storyboard-v4/core/shared.mjs';

// Free inspection of copies only. This cannot dispatch providers or mutate the
// production directory, budgets, paid response text or historical fingerprints.
const root=process.cwd(),original=path.join(root,'.storyboard-stage3-v2');
const directory=await mkdtemp(path.join(root,'runtime-3008/stage3-material-recheck-'));
await mkdir(path.join(directory,'documents'));
const engine=createEngine({directory,modelRunner:async()=>{throw Error('PROVIDER_FORBIDDEN');}});
const results=[];
for(const id of ['ad4a98e7-b693-45e3-b31d-d5c34066636e','5f68388b-f423-4522-b332-7d8e772da294']){
 const file=path.join(original,'documents',`${id}.json`),bytes=await readFile(file,'utf8');
 await copyFile(file,path.join(directory,'documents',`${id}.json`));
 const before=await engine.read(id),context=structuredClone(before.production);
 await engine.refreshProduction(id,context);
 const after=await engine.read(id);
 for(const key of ['source','settings','plan','operations','candidates','adopted','assembly','web'])assert.equal(digest(after[key]),digest(before[key]),`${key} must be preserved`);
 if(before.web.binding.episodeNumber===1)assert.equal(after.production.pendingRepair,null,'full finish had already read every re-indexed quotation');
 else assert.ok(after.production.pendingRepair,'partial author cannot claim to have read other packages');
 await engine.refreshProduction(id,context);
 const repeated=await engine.read(id);
 assert.deepEqual(repeated.production.pendingRepair,after.production.pendingRepair);
 assert.equal(repeated.operations.length,before.operations.length);
 if(before.web.binding.episodeNumber===1){
  const changed=structuredClone(context);
  changed.materials[0].value.adoptedDesign={version:1,brief:'新的采用形象',provenance:'ADOPTED_DESIGN_NOT_SOURCE_FACT'};
  changed.materials[0].version=digest(changed.materials[0].value);
  await engine.refreshProduction(id,changed);
  assert.ok((await engine.read(id)).production.pendingRepair,'a real adopted-design change still needs checking');
 }
 const live=JSON.parse(await readFile(file,'utf8')),originalValue=JSON.parse(bytes);
 // The open page performs free status reconciliation concurrently, so its audit
 // revision may advance. Compare the protected paid content, not that counter.
 for(const key of ['source','settings','plan','operations','candidates','adopted','assembly'])assert.equal(digest(live[key]),digest(originalValue[key]),`live ${key} remains unchanged`);
 results.push({id,episode:before.web.binding.episodeNumber,status:after.status,progress:after.web.progress,
  beforeRepair:before.production.pendingRepair,afterRepair:after.production.pendingRepair,
  operationsPreserved:true,sourceAndPaidDraftPreserved:true,providerCalls:0});
}
const report={schema:'SAVED_MATERIAL_RECHECK_V1',at:new Date().toISOString(),providerCalls:0,originalWrites:0,results};
await writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({directory,...report},null,2));
