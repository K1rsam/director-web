/** Synthetic, offline source contract tests. No user database or provider. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,copyFileSync,rmSync,mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {PrismaClient} from '@prisma/client';
import {normalize,validatePlan,CONTRACT_VERSION} from '../.agents/skills/screenplay-fidelity/scripts/fidelity.mjs';
import {normalize as frozenV5,validatePlan as validateV5} from '../lib/fidelity-v5.mjs';
import {prepareFidelityImport,type FidelityResult,type FidelityDecision} from '../lib/fidelity-import';
import {planP1ReviewBatches} from '../lib/fidelity-p1-review';
import {reconcileP1OwnershipDecisions} from '../lib/fidelity-p1-ownership';
import JSZip from 'jszip';
import {GET as downloadSkill} from '../app/api/fidelity/skill/route';

const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const source='第7集\n\n第七集\n\n集名：门外的星河😀\n\n7-1 日 外 山门\n人物：甲、乙\n甲：逐字保留。\n';
const result=(text:string,decisions:FidelityDecision[]=[])=>normalize(text,{decisions}) as FidelityResult;

test('explicit episode preamble metadata stays formatted, fully bound, and is not a speaker',()=>{
 assert.equal(CONTRACT_VERSION,'fidelity/6');
 for(const text of [source,source.replaceAll('\n','\r\n'),source.replace('集名：','集名: ')]){
  const r=result(text),metadata=r.segments.find(s=>s.text.startsWith('集名'))!;
  assert.equal(metadata.kind,'format');assert.equal(metadata.reason,'explicit_episode_metadata');
  assert.equal(metadata.productionEligible,false);assert.deepEqual(metadata.speakerLabels,[]);
  assert.ok(metadata.episodeId);assert.equal(metadata.sceneId,null);
  assert.equal(r.validation.issues.filter(i=>i.code==='SCENE_BOUNDARY_UNCONFIRMED').length,0);
  assert.equal(r.source.text,text);assert.equal(r.source.sourceVersion,hash(text));
  assert.equal(r.segments.map(s=>s.text).join(''),text);
  for(const s of r.segments)assert.equal(text.slice(s.start,s.end),s.text);
 }
});

test('metadata-looking narrative, in-scene dialogue and context are never promoted into episode formatting',()=>{
 for(const text of [
  '第1集\n1-1 日 外 门口\n集名：我说的是我的名字。\n',
  '第1集\n甲：故事已经开始。\n集名：我也是角色。\n',
  '第1集\n集名：标题 △甲开门。\n',
  '第1集\n集名：甲：来了。\n',
  '第1集\n集名：\n',
  '第1集\n集名：'+ '甲'.repeat(161)+'\n',
 ]){
  const r=result(text),row=r.segments.find(s=>s.text.startsWith('集名'))!;
  assert.equal(row.kind,'body',text);assert.notEqual(row.reason,'explicit_episode_metadata');
 }
 const context=result('背景资料\n集名：某段资料名\n');
 assert.equal(context.segments.find(s=>s.text.startsWith('集名'))!.kind,'context');
});

test('only proven P1 ownership is projected away from pre-scene source formatting',()=>{
 const end=source.indexOf('7-1'),decisions:FidelityDecision[]=[{start:source.indexOf('第七集'),end,kind:'body',episodeNumber:7,note:'同集归属，未声明新增场界。'}];
 const before=structuredClone(decisions),projected=reconcileP1OwnershipDecisions(source,decisions,{ownershipDecisions:decisions});
 assert.deepEqual(projected.decisions,[]);assert.ok(projected.corrections.length);
 const r=result(source,projected.decisions);assert.deepEqual(r.validation.issues,[]);
 for(const row of r.segments.filter(s=>s.start>=decisions[0].start&&s.end<=end))assert.equal(row.kind,'format');
 assert.deepEqual(decisions,before);assert.equal(r.segments.map(s=>s.text).join(''),source);
 assert.deepEqual(reconcileP1OwnershipDecisions(source,decisions).decisions,decisions,'no provenance is not permission');
 assert.deepEqual(reconcileP1OwnershipDecisions(source,decisions,{ownershipDecisions:decisions,protectedRanges:decisions}).decisions,decisions,'user range wins even over matching P1 evidence');
});

test('digit-by-digit Chinese source numbers share the receiver interpretation in formatting and scene ownership',()=>{
 for(const [label,number]of [['二一',21],['二零二六',2026]] as const){
  for(const scene of ['场景：山门',`场${number}-1 日 外 山门`]){
   const text=`第${label}集\n集名：星河\n${scene}\n甲：原文不变。\n`,end=text.indexOf(scene);
   const decision:FidelityDecision={start:0,end,kind:'body',episodeNumber:number,note:'同源集前归属，不是新场景。'};
   const before=structuredClone(decision),projected=reconcileP1OwnershipDecisions(text,[decision],{ownershipDecisions:[decision]});
   assert.deepEqual(projected.decisions,[],`${label}: proven formatting must not become unscened body`);
   const r=result(text,projected.decisions);
   assert.deepEqual(r.validation.issues,[],`${label}: scene number must agree with the source label`);
   assert.equal(r.segments.map(s=>s.text).join(''),text);assert.deepEqual(decision,before);
   assert.ok(r.segments.find(s=>s.text.startsWith('甲：'))?.sceneId);
  }
 }
});

test('the downloaded standalone skill includes and executes its shared numbering module',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'fidelity-skill-download-'));
 try{
  const response=await downloadSkill(new Request('http://localhost/api/fidelity/skill'));
  const zip=await JSZip.loadAsync(await response.arrayBuffer());
  const scripts=path.join(directory,'scripts');mkdirSync(scripts);
  for(const name of ['cli.mjs','fidelity.mjs','episode-number.mjs']){
   const file=zip.file(`screenplay-fidelity/scripts/${name}`);assert.ok(file,`download missing ${name}`);
   writeFileSync(path.join(scripts,name),await file.async('nodebuffer'),{flag:'wx'});
  }
  const text='第二一集\n集名：星河\n场21-1 日 外 山门\n甲：不改原文。\n';
  writeFileSync(path.join(directory,'source.txt'),text,{flag:'wx'});
  execFileSync(process.execPath,[path.join(scripts,'cli.mjs'),path.join(directory,'source.txt'),path.join(directory,'out')],{cwd:directory,stdio:'pipe'});
  const packet=JSON.parse(readFileSync(path.join(directory,'out','fidelity-import.json'),'utf8')) as FidelityResult;
  assert.equal(packet.contractVersion,'fidelity/6');assert.deepEqual(packet.validation.issues,[]);
  assert.equal(packet.source.text,text);assert.equal(packet.segments.map(s=>s.text).join(''),text);
 }finally{rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
});

test('explicitly adopted legacy body without a scene remains body and keeps its unresolved boundary',async()=>{
 const text='第1集\n集名：我叫集名，这句话是台词。\n1-1 日 外 山门\n甲：保持原样。\n';
 const start=text.indexOf('集名'),end=text.indexOf('1-1'),decisions:FidelityDecision[]=[{start,end,kind:'body',episodeNumber:1,note:'明确采用为正文，场界尚未确认。'}];
 const old=frozenV5(text,{decisions}) as FidelityResult;
 const upgraded=await prepareFidelityImport('adopted-v5.json',Buffer.from(JSON.stringify({source:old.source,plan:old.plan})),'direct',[],true);
 const row=upgraded.receipt.result.segments.find(s=>s.start===start)!;
 assert.equal(row.kind,'body');assert.equal(row.productionEligible,true);assert.deepEqual(row.speakerLabels,['集名']);
 assert.ok(upgraded.receipt.result.validation.issues.some(i=>i.code==='SCENE_BOUNDARY_UNCONFIRMED'));
 assert.deepEqual(upgraded.receipt.decisions,decisions);
});

test('explicit scene, context and conflicting episode decisions retain their own meaning',()=>{
 const start=source.indexOf('集名'),end=source.indexOf('7-1');
 const base={start,end,note:'合成明确决定。'};
 const scene=result(source,[{...base,kind:'body',episodeNumber:7,sceneNumber:2}]);
 assert.equal(scene.segments.find(s=>s.start===start)!.kind,'body');assert.ok(scene.segments.find(s=>s.start===start)!.sceneId);
 const context=result(source,[{...base,kind:'context'}]);assert.equal(context.segments.find(s=>s.start===start)!.kind,'context');
 const conflict=result(source,[{...base,kind:'body',episodeNumber:8}]);
 assert.equal(conflict.segments.find(s=>s.start===start)!.kind,'body');
 assert.ok(conflict.validation.issues.some(i=>i.code==='SCENE_BOUNDARY_UNCONFIRMED'));
});

test('frozen v5 packet is verified before v6 upgrade, without changing raw bytes or UTF16 source',async()=>{
 const old=frozenV5(source) as FidelityResult,packet={source:old.source,plan:old.plan};
 const bytes=Buffer.from(JSON.stringify(packet)),before=Buffer.from(bytes),pristine=structuredClone(packet);
 assert.ok(old.validation.issues.length);assert.equal(validateV5(old.source,old.plan).ok,true);
 assert.equal(validatePlan(old.source,old.plan).ok,false);
 const upgraded=await prepareFidelityImport('old-v5.json',bytes,'direct');
 assert.equal(upgraded.receipt.result.contractVersion,'fidelity/6');assert.deepEqual(upgraded.receipt.result.validation.issues,[]);
 assert.equal(upgraded.receipt.readingHash,hash(source));assert.equal(upgraded.receipt.originalHash,hash(bytes));
 assert.deepEqual(upgraded.receipt.result.segments.map(s=>[s.start,s.end,s.text]),old.segments.map(s=>[s.start,s.end,s.text]));
 assert.deepEqual(Buffer.from(upgraded.imported.originalFile!.base64,'base64'),before);
 assert.deepEqual(bytes,before);assert.deepEqual(packet,pristine);
});

test('old issue deletion, source changes, changed kinds, or version relabeling cannot pass legacy upgrade',async()=>{
 const old=frozenV5(source) as FidelityResult;
 for(const mutate of [
  (p:{source:FidelityResult['source'];plan:Record<string,unknown>})=>{p.plan.issues=[];},
  (p:{source:FidelityResult['source'];plan:Record<string,unknown>})=>{p.source.text+='改';},
  (p:{source:FidelityResult['source'];plan:Record<string,unknown>})=>{(p.plan.segments as Array<{kind:string}>)[0].kind='body';},
  (p:{source:FidelityResult['source'];plan:Record<string,unknown>})=>{p.plan.contractVersion='fidelity/6';},
 ]){
  const packet=structuredClone({source:old.source,plan:old.plan});mutate(packet);
  await assert.rejects(prepareFidelityImport('bad-v5.json',Buffer.from(JSON.stringify(packet)),'direct'),/被修改|保真|来源文本/);
 }
 const current=result(source),disguised=structuredClone(current.plan);disguised.contractVersion='fidelity/5';
 assert.equal(validateV5(current.source,disguised).ok,false);
});

test('completed P1 ownership checkpoints finish locally with zero new review and unchanged old evidence',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'p1-metadata-')),url=`file:${dir}/test.db`;
 copyFileSync('prisma/schema.prisma',`${dir}/schema.prisma`);
 const db=new PrismaClient({datasourceUrl:url});
 try{
  execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${dir}/schema.prisma`,'--skip-generate'],{env:{...process.env,DATABASE_URL:url,RUST_LOG:'info'},stdio:'pipe'});
  const {prepareFidelitySourceAssisted}=await import('../lib/fidelity-source-assist');
  const {readFidelityReceipt}=await import('../lib/fidelity-store');
  const end=source.indexOf('7-1'),decision:FidelityDecision={start:source.indexOf('第七集'),end,kind:'body',episodeNumber:7,note:'同源集前格式归属，不是新增场景。'};
  const prepared=await prepareFidelityImport('metadata.txt',Buffer.from(source),'fidelity',[decision]);
  prepared.receipt.p1Review={status:'PENDING',reviewedSourceVersion:hash(source),completedRanges:planP1ReviewBatches(source).map(b=>({start:b[0].start,end:b.at(-1)!.end})),runIds:['synthetic-saved-paid-review'],pendingDecisions:[decision],unresolved:[],aliases:[]};
  const project=await db.project.create({data:{title:'synthetic P1 metadata',episodes:{create:prepared.imported.episodes}}});
  const savedSource=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(prepared.imported)}});
  prepared.receipt.sourceImportId=savedSource.id;
  const saved=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify(prepared.receipt)}});
  let attempted=0;const options={checkCurrent:async()=>{},assist:async()=>{attempted++;throw new Error('No new review allowed');}};
  const after=await prepareFidelitySourceAssisted(project.id,db,options);
  assert.equal(attempted,0);assert.equal(after.backendPending,undefined);
  const receipt=(await readFidelityReceipt(project.id,db))!.receipt;
  assert.equal(receipt.p1Review!.status,'COMPLETE');assert.deepEqual(receipt.p1Review!.runIds,prepared.receipt.p1Review.runIds);
  assert.deepEqual(receipt.result.validation.issues,[]);assert.equal(receipt.result.source.text,source);
  assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:saved.id}}),saved);
  assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:savedSource.id}}),savedSource);
  assert.equal(await db.pipelineRun.count(),0);
  assert.equal((await prepareFidelitySourceAssisted(project.id,db,options)).assisted,false);assert.equal(attempted,0);
 }finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
});

test('an already attempted first P1 batch stays pinned even before its first completed checkpoint',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'p1-first-paid-')),url=`file:${dir}/test.db`;
 copyFileSync('prisma/schema.prisma',`${dir}/schema.prisma`);
 const db=new PrismaClient({datasourceUrl:url});
 try{
  execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${dir}/schema.prisma`,'--skip-generate'],{env:{...process.env,DATABASE_URL:url,RUST_LOG:'info'},stdio:'pipe'});
  const {refreshFidelitySource}=await import('../lib/fidelity-refresh');
  const {readFidelityReceipt}=await import('../lib/fidelity-store');
  const prepared=await prepareFidelityImport('first-paid.txt',Buffer.from(source),'fidelity');
  prepared.receipt.result=frozenV5(source) as FidelityResult;
  prepared.receipt.p1Review={status:'PENDING',reviewedSourceVersion:hash(source),completedRanges:[],pendingDecisions:[],runIds:[]};
  const project=await db.project.create({data:{title:'synthetic first paid P1',episodes:{create:prepared.imported.episodes}}});
  const savedSource=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(prepared.imported)}});
  prepared.receipt.sourceImportId=savedSource.id;
  const saved=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify(prepared.receipt)}});
  const paid=await db.pipelineRun.create({data:{projectId:project.id,stageCode:'F1',roleName:'synthetic paid response',provider:'CLI',status:'FAILED',log:JSON.stringify({calls:[{kind:'INITIAL',requestOutcome:'RESPONDED',providerCallCount:1,response:{data:{assignments:[]}}}]})}});
  assert.deepEqual(await refreshFidelitySource(project.id,db),{changed:false});
  const unchanged=(await readFidelityReceipt(project.id,db))!;
  assert.equal(unchanged.snapshot.id,saved.id);assert.equal(unchanged.sourceSnapshot!.id,savedSource.id);
  assert.equal(unchanged.receipt.result.contractVersion,'fidelity/5');assert.equal(await db.sceneSnapshot.count(),2);
  assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({where:{id:paid.id}}),paid);assert.equal(await db.pipelineRun.count(),1);
 }finally{await db.$disconnect();rmSync(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100});}
});
