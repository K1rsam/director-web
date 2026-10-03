/** Synthetic source, disposable SQLite and a fake stage runner only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PrismaClient} from '@prisma/client';
import {prepareFidelityImport} from '../lib/fidelity-import';
import {projectP1ReviewEvidenceRequest,restoreP1ReviewRequest} from '../lib/fidelity-p1-review';
import {P1_WIRE_V2_MODEL_NOTE} from '../lib/fidelity-p1-wire';

test('actual F1 delivery sends V2, receives canonical coordinates and preserves the legacy work identity',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'p1-wire-delivery-')),file=path.join(directory,'test.db');
 const sql=new DatabaseSync(file);
 for(const migration of (await readdir('prisma/migrations')).sort())if(/^\d/.test(migration))sql.exec(await readFile(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();const db=new PrismaClient({datasourceUrl:`file:${file}`});
 t.after(async()=>{await db.$disconnect();await rm(directory,{recursive:true,force:true});});
 const text=Array.from({length:100},(_,i)=>`甲（OS）：第${i}句，原文不改。\n\n`).join('');
 const prepared=await prepareFidelityImport('wire-synthetic.txt',Buffer.from(text),'fidelity');prepared.receipt.p1Review={status:'PENDING'};
 const project=await db.project.create({data:{title:'P1传输集成合成测试',episodes:{create:prepared.imported.episodes}}});
 const snapshot=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(prepared.imported),metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'})}});
 prepared.receipt.sourceImportId=snapshot.id;
 await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify(prepared.receipt)}});
 const {queueFoundationDelivery,executeFoundationDelivery}=await import('../lib/foundation-delivery');
 const task=await queueFoundationDelivery(project.id,{autoAssetPrompts:false},db);let f1=0;let sent:Record<string,unknown>|undefined;
 await executeFoundationDelivery(project.id,task.id,{db,stageRunner:async(stage,prompt)=>{
  if(stage!=='F1')throw Object.assign(new Error('Stop before any downstream provider work'),{requestOutcome:'NOT_SENT'});
  f1++;const input=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);sent=input;
  assert.equal(input.reviewMode,'FULL_STRUCTURE_BLOCKS_V2');assert.equal(prompt.split(P1_WIRE_V2_MODEL_NOTE).length,2);
  assert.ok(input.blocks.every(([,line]:[string,string])=>line.trim()));assert.notEqual(input.blocks.at(-1)[0],input.batch.lastBlock);
  const restored=restoreP1ReviewRequest(input,text);assert.equal(restored.sections.map(s=>s.text).join(''),text);
  const data={sourceVersion:input.sourceVersion,reviewed:{firstBlock:input.batch.firstBlock,lastBlock:input.batch.lastBlock},assignments:[{firstBlock:input.batch.firstBlock,lastBlock:input.batch.lastBlock,kind:'body',episodeNumber:1,sceneNumber:1,note:'合成夹具明确整批为同一场'}],unresolved:[],aliases:[]};
  return {data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null};
 }});
 const receipt=JSON.parse((await db.sceneSnapshot.findUniqueOrThrow({where:{id:`foundation-delivery-${project.id}`}})).content);
 assert.equal(f1,1,receipt.error??receipt.message);assert.ok(sent);
 const run=await db.pipelineRun.findFirstOrThrow({where:{projectId:project.id,stageCode:'F1'}});assert.equal(run.status,'SUCCEEDED');
 const inputSummary=JSON.parse(run.inputSummary!);const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
 assert.equal(inputSummary.workFingerprint,hash({receiver:'FIDELITY_SOURCE_ACCEPT_V2',request:projectP1ReviewEvidenceRequest(sent)}));
 const persisted=JSON.parse(run.log!);assert.ok(persisted.calls.some((call:{taskPrompt?:string})=>call.taskPrompt?.includes('FULL_STRUCTURE_BLOCKS_V2')),'save the actual sent wire, not a reconstructed display');
 const ep=await db.episode.findFirstOrThrow({where:{projectId:project.id}});assert.equal(ep.content.trim().split(/\r?\n/).filter(line=>!line.trim()).length,0);
 console.log('PASS actual delivery V2 sender/receiver/fingerprint/history, 1 fake F1 / 0 real provider calls');
});
