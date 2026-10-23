import assert from 'node:assert/strict';
import {normalize} from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import {normalize as normalizeV5} from '../lib/fidelity-v5.mjs';
import {reconcileP1OwnershipDecisions} from '../lib/fidelity-p1-ownership';
import {routeFidelityQuestions} from '../lib/fidelity-question-routing';
import {planP1ReviewBatches,type P1ReviewState} from '../lib/fidelity-p1-review';
import type {FidelityDecision,FidelityResult} from '../lib/fidelity-import';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PrismaClient} from '@prisma/client';
const text='第 21 集\r\n\r\n第二十一集\r\n\r\n21-1 日 外 广场\r\n甲乙：来了。😀\r\n21-3 夜 内 房间\r\n甲乙：走吧。\r\n';
const decision:FidelityDecision={start:0,end:text.length,kind:'body',episodeNumber:21,note:'相邻双标题属于同一集，保留已有场界。'};
const old=normalizeV5(text,{decisions:[decision]}) as FidelityResult;
assert(old.validation.issues.some(issue=>issue.code==='SCENE_BOUNDARY_UNCONFIRMED'));
const reconciled=reconcileP1OwnershipDecisions(text,[decision],{ownershipDecisions:[decision]});
assert.deepEqual(reconciled.decisions,[]);assert.equal(reconciled.corrections.length,1);
const after=normalize(text,{decisions:reconciled.decisions}) as FidelityResult;
assert.equal(after.validation.issues.length,0);assert.equal(after.source.text,text);
assert.deepEqual(after.segments.filter(s=>s.kind==='body').map(s=>[s.start,s.end,s.sceneId]),old.segments.filter(s=>s.speakerLabels.length).map(s=>[s.start,s.end,s.sceneId]));
const review:P1ReviewState={status:'PENDING',reviewedSourceVersion:after.source.sourceVersion,unresolved:[{start:text.indexOf('21-1'),end:text.length,kind:'structure',note:'缺21-2是否为跳场号，保留原文不补场。'}]};
assert.equal(routeFidelityQuestions(review,after).unresolved![0].routing?.kind,'QUESTION');
for(const [raw,extra] of [
 ['第21集\n甲乙：没有场界。\n',{}],
 ['第21集\n21-1 日 外 广场\n甲乙：来了。\n',{episodeNumber:22}],
 ['第21集\n21-1 日 外 广场\n甲乙：来了。\n',{sceneNumber:1}],
 ['第21集 甲乙走进村庄\n21-1 日 外 广场\n甲乙：来了。\n',{}],
 ['第21集\n21-1 日 外 广场\n甲乙：来了。\n',{kind:'context',episodeNumber:undefined}],
] as const){const d={...decision,end:raw.length,...extra} as FidelityDecision;assert.deepEqual(reconcileP1OwnershipDecisions(raw,[d]).decisions,[d]);}
const originalDecision=structuredClone(decision);reconcileP1OwnershipDecisions(text,[decision]);assert.deepEqual(decision,originalDecision);

async function persisted(){
 const dir=mkdtempSync(path.join(tmpdir(),'p1-ownership-')),url=`file:${dir}/test.db`;process.env.DATABASE_URL=url;
 copyFileSync('prisma/schema.prisma',`${dir}/schema.prisma`);execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${dir}/schema.prisma`,'--skip-generate'],{env:{...process.env,RUST_LOG:'info'},stdio:'pipe'});
 const db=new PrismaClient({datasourceUrl:url});
 try{
  const {prepareFidelityImport}=await import('../lib/fidelity-import');const {readFidelityReceipt}=await import('../lib/fidelity-store');const {prepareFidelitySourceAssisted}=await import('../lib/fidelity-source-assist');
  const prepared=await prepareFidelityImport('ownership.txt',Buffer.from(text),'fidelity',[decision]);
  const state:P1ReviewState={...review,completedRanges:planP1ReviewBatches(text).map(blocks=>({start:blocks[0].start,end:blocks.at(-1)!.end})),runIds:['saved-paid-full-review'],pendingDecisions:[decision]};
  prepared.receipt.p1Review=state;
  const project=await db.project.create({data:{title:'offline ownership merge',episodes:{create:prepared.imported.episodes}}});
  const source=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(prepared.imported),metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'})}});
  prepared.receipt.sourceImportId=source.id;
  const snapshot=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify(prepared.receipt)}});
  let calls=0;
  const result=await prepareFidelitySourceAssisted(project.id,db,{checkCurrent:async()=>{},assist:async()=>{calls++;throw new Error('No new AI purchase allowed');}});
  assert.equal(calls,0);assert.equal(result.backendPending,undefined);
  const saved=(await readFidelityReceipt(project.id,db))!;const savedState=saved.receipt.p1Review as P1ReviewState;
  assert.equal(savedState.status,'COMPLETE');assert.deepEqual(savedState.completedRanges,state.completedRanges);assert.deepEqual(savedState.runIds,state.runIds);assert.equal(savedState.ownershipCorrections?.length,1);
  assert.deepEqual(saved.receipt.decisions,[]);assert.equal(saved.receipt.result.source.text,text);assert.equal(saved.receipt.originalHash,prepared.receipt.originalHash);
  assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:snapshot.id}}),snapshot,'old paid receipt is immutable');
  assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:source.id}}),source,'old source evidence is immutable');
  assert.equal(await db.pipelineRun.count(),0);
  assert.equal((await prepareFidelitySourceAssisted(project.id,db,{checkCurrent:async()=>{},assist:async()=>{calls++;throw new Error('no duplicate');}})).assisted,false);
  console.log('PASS redundant P1 episode assignments preserve explicit headers/scenes; paid checkpoints recover locally, immutable source/old receipts, zero AI and repeated work');
 }finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:200});}
}
persisted().catch(error=>{console.error(error);process.exitCode=1;});
