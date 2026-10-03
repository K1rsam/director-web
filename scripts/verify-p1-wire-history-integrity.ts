/** Real source/delivery paths, synthetic text and a disposable SQLite only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {PrismaClient} from '@prisma/client';
import {prepareFidelityImport} from '../lib/fidelity-import';
import {prepareFidelitySourceAssisted} from '../lib/fidelity-source-assist';
import {projectP1ReviewRequest,projectP1ReviewEvidenceRequest,type P1ReviewRequest} from '../lib/fidelity-p1-review';
import {compactP1WireV2,expandP1WireEvidence} from '../lib/fidelity-p1-wire';

type Row=Record<string,unknown>;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const badMode=(value:Row,mode?:string)=>{if(mode===undefined)delete value.reviewMode;else value.reviewMode=mode;};

test('compact encoding cannot pose as legacy or unknown wire evidence',()=>{
 const legacy={reviewMode:'FULL_STRUCTURE_BLOCKS_V1',futureMetadata:{untouched:true}};
 assert.equal(expandP1WireEvidence(legacy),legacy,'ordinary old V1 is unchanged, including unknown legacy metadata');
 for(const mode of ['FULL_STRUCTURE_BLOCKS_V1','FULL_STRUCTURE_BLOCKS_V3',undefined]){
  assert.throws(()=>expandP1WireEvidence({...(mode?{reviewMode:mode}:{}),wireEncoding:null}),/P1_WIRE_INVALID/);
  assert.throws(()=>expandP1WireEvidence({...(mode?{reviewMode:mode}:{}),issues:[{code:'X',message:'原引用',sectionKeyRuns:[]}]}),/P1_WIRE_INVALID/);
 }
 assert.throws(()=>expandP1WireEvidence({reviewMode:'FULL_STRUCTURE_BLOCKS_V3'}),/P1_WIRE_INVALID/,'unknown block protocols cannot create a new paid identity');
});

test('damaged saved P1 wire never repurchases F1 or rewrites the original paid receipt',async t=>{
 const directory=await mkdtemp(path.join(tmpdir(),'p1-wire-history-')),file=path.join(directory,'test.db');
 const sql=new DatabaseSync(file);
 for(const migration of(await readdir('prisma/migrations')).sort())if(/^\d/.test(migration))sql.exec(await readFile(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();const db=new PrismaClient({datasourceUrl:`file:${file}`});
 t.after(async()=>{await db.$disconnect();await rm(directory,{recursive:true,force:true});});
 const {queueFoundationDelivery,executeFoundationDelivery}=await import('../lib/foundation-delivery');
 const cases:Array<{name:string;legacy?:boolean;mutate?:(wire:Row)=>void}>=[
  {name:'original V1',legacy:true},{name:'valid V2'},
  {name:'V2 mislabeled V1',mutate:wire=>badMode(wire,'FULL_STRUCTURE_BLOCKS_V1')},
  {name:'V2 unknown V3',mutate:wire=>badMode(wire,'FULL_STRUCTURE_BLOCKS_V3')},
  {name:'V2 missing mode',mutate:wire=>badMode(wire)},
  {name:'range encoding without V2 marker',mutate:wire=>{badMode(wire,'FULL_STRUCTURE_BLOCKS_V1');delete wire.wireEncoding;wire.issues=[{code:'X',message:'原引用',sectionKeyRuns:['B000001']}];}},
  {name:'unknown block mode without encoding',mutate:wire=>{badMode(wire,'FULL_STRUCTURE_BLOCKS_V3');delete wire.wireEncoding;}},
  {name:'V2 bad checksum',mutate:wire=>{wire.wireEncoding={...(wire.wireEncoding as Row),expandedJsonHash:'0'.repeat(64)};}},
 ];
 for(const fixture of cases)await t.test(fixture.name,async()=>{
  const text=Array.from({length:100},(_,i)=>`甲（OS）：第${i}句，原文不改。\n\n`).join('');
  const prepared=await prepareFidelityImport('wire-history.txt',Buffer.from(text),'fidelity');prepared.receipt.p1Review={status:'PENDING'};
  const project=await db.project.create({data:{title:`P1历史合成测试 ${fixture.name}`,episodes:{create:prepared.imported.episodes}}});
  const snapshot=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(prepared.imported),metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'})}});
  prepared.receipt.sourceImportId=snapshot.id;
  await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify(prepared.receipt)}});
  let request:P1ReviewRequest|undefined;
  await assert.rejects(prepareFidelitySourceAssisted(project.id,db,{checkCurrent:async()=>{},checkAfterCommit:async()=>{},assist:async input=>{
   request=structuredClone(input) as P1ReviewRequest;throw new Error('CAPTURE_ONLY_NO_PROVIDER');
  }}),/CAPTURE_ONLY_NO_PROVIDER/);
  assert.ok(request);
  const v1=projectP1ReviewRequest(request),workFingerprint=hash({receiver:'FIDELITY_SOURCE_ACCEPT_V2',request:projectP1ReviewEvidenceRequest(v1)});
  const wire:Row=structuredClone(fixture.legacy?v1:compactP1WireV2(v1));
  if(!fixture.legacy)assert.equal(wire.reviewMode,'FULL_STRUCTURE_BLOCKS_V2');
  fixture.mutate?.(wire);
  const response={data:{sourceVersion:request.sourceVersion,reviewed:{firstBlock:request.batch.firstBlock,lastBlock:request.batch.lastBlock},assignments:[{firstBlock:request.batch.firstBlock,lastBlock:request.batch.lastBlock,kind:'body',episodeNumber:1,sceneNumber:1,note:'合成夹具：整批为一场'}],unresolved:[],aliases:[]},sessionId:null,stdout:'',stderr:''};
  const inputSummary=JSON.stringify({foundation:true,workflow:'LIGHT_STAGE1_V1',deliveryTaskId:'saved-fixture',phase:'PREPARE_SOURCE',sourceInputVersion:request.sourceVersion,sourceTextFingerprint:hash(text),workFingerprint,receiverVersion:'FIDELITY_SOURCE_ACCEPT_V2'});
  // Simulate a crash after the successful provider receipt, before source acceptance.
  const log=JSON.stringify({schema:'FOUNDATION_RUN_EVIDENCE_V1',calls:[{sequence:1,kind:'INITIAL',scope:[],systemPrompt:'历史规则',taskPrompt:`INPUT_JSON:\n${JSON.stringify(wire)}`,provider:'CLI',model:'fake',reasoningEffort:'medium',startedAt:new Date().toISOString(),status:'SUCCEEDED',requestOutcome:'RESPONDED',providerCallCount:1,response}]});
  const old=await db.pipelineRun.create({data:{projectId:project.id,stageCode:'F1',roleName:'已付费证据夹具',provider:'CLI',status:'SUCCEEDED',inputSummary,log}});
  const reached:string[]=[];let error:unknown;
  try{
   const task=await queueFoundationDelivery(project.id,{autoAssetPrompts:false},db);
   await executeFoundationDelivery(project.id,task.id,{db,stageRunner:async(stage)=>{
    reached.push(stage);throw Object.assign(new Error('FAKE_NO_PROVIDER'),{requestOutcome:'NOT_SENT'});
   }});
  }catch(value){error=value;}
  const saved=await db.pipelineRun.findUniqueOrThrow({where:{id:old.id}});
  assert.equal(saved.log,log,'never rewrite the paid request or response');
  assert.equal(saved.inputSummary,inputSummary,'the original work fingerprint remains immutable');
  assert.equal(reached.filter(stage=>stage==='F1').length,0,'saved wire corruption must not reach a new F1 provider invocation');
  const rechecks=await db.pipelineRun.count({where:{projectId:project.id,roleName:'来源响应本地重验'}});
  if(fixture.mutate){
   assert.match(String(error),/P1_WIRE_INVALID/);
   assert.deepEqual(reached,[],'damaged evidence stops before any stage invocation');assert.equal(rechecks,0);
  }else{
   assert.equal(error,undefined);assert.equal(rechecks,1,'valid V1 and V2 reuse the same saved response for free');
   const recheck=await db.pipelineRun.findFirstOrThrow({where:{projectId:project.id,roleName:'来源响应本地重验'}});
   assert.equal(JSON.parse(recheck.inputSummary!).workFingerprint,workFingerprint);
  }
 });
});
