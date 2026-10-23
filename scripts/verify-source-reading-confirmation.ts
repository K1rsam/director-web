/** Synthetic DOCX, temporary database, no production provider or user files. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PrismaClient} from '@prisma/client';
import JSZip from 'jszip';
import {prepareFidelityImport} from '../lib/fidelity-import';
import {readSourceReadingState,confirmSourceReading,bindSourceReadingToDisplayedReceipt} from '../lib/source-reading-confirmation';

let directory:string,db:PrismaClient,userId:string;
before(async()=>{
 directory=mkdtempSync(path.join(tmpdir(),'source-reading-confirmation-'));
 const file=path.join(directory,'test.db'),sql=new DatabaseSync(file);
 for(const migration of readdirSync('prisma/migrations').sort())if(/^\d/.test(migration))sql.exec(readFileSync(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();process.env.DATABASE_URL=`file:${file}`;process.env.CODEX_CLI_PATH='/__forbidden_offline__/no-codex';process.env.DEEPSEEK_API_KEY='';
 db=new PrismaClient({datasourceUrl:process.env.DATABASE_URL});
 userId=(await db.user.create({data:{username:'reading',email:'reading@synthetic.invalid',passwordHash:'offline'}})).id;
});
after(async()=>{await db?.$disconnect();if(directory)rmSync(directory,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
async function fixture(extraIssue=false){
 const zip=new JSZip();
 zip.file('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
 zip.file('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
 zip.file('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>第1集</w:t></w:r></w:p><w:p><w:r><w:t>1-1 山门 日 外</w:t></w:r></w:p><w:p><w:r><w:t>甲：</w:t></w:r><w:del><w:r><w:delText>旧句</w:delText></w:r></w:del><w:ins><w:r><w:t>新句。</w:t></w:r></w:ins></w:p></w:body></w:document>');
 const prepared=await prepareFidelityImport('tracked.docx',await zip.generateAsync({type:'nodebuffer'}),'fidelity');
 if(extraIssue)prepared.imported.sourceStructure.issues.push({code:'DOCX_UNSUPPORTED_OBJECT',message:'仍有独立对象缺口',sectionKeys:[]});
 const {importParsedProject}=await import('../lib/workflow');
 const {project}=await importParsedProject({ownerUserId:userId,title:'reading confirmation',sourceName:'tracked.docx',fidelityReceipt:prepared.receipt},prepared.imported,db);
 const original=await db.sceneSnapshot.findFirstOrThrow({where:{projectId:project.id,sceneKey:'SOURCE_IMPORT'},orderBy:[{createdAt:'desc'},{id:'desc'}]});
 const state=await readSourceReadingState(project.id,db);assert.equal(state.required,true);assert.equal(state.confirmed,false);assert.ok(state.binding);
 return {projectId:project.id,original,request:{projectId:project.id,userId,...state.binding!,choice:'USE_CURRENT_READING' as const,confirmed:true}};
}

test('explicit reading confirmation is immutable, source-bound, idempotent and zero-model',async()=>{
 const f=await fixture(),{loadFoundationSourceContext}=await import('../lib/foundation-source'),{readSourcePreparation}=await import('../lib/source-preparation');
 const before=await db.sceneSnapshot.findMany({where:{projectId:f.projectId},orderBy:{id:'asc'}}),episodes=await db.episode.findMany({where:{projectId:f.projectId},orderBy:{id:'asc'}});
 const pin=(await readSourcePreparation(f.projectId,db)).sourceInputVersion;
 assert.ok((await loadFoundationSourceContext(f.projectId,db)).issues.some(i=>i.code==='DOCX_REVISION_VIEW_UNRESOLVED'));
 const saved=await confirmSourceReading(f.request,db),state=await readSourceReadingState(f.projectId,db);
 assert.equal(state.confirmed,true);assert.equal(state.confirmationId,saved.id);
 const context=await loadFoundationSourceContext(f.projectId,db);
 assert.equal(context.issues.some(i=>i.code==='DOCX_REVISION_VIEW_UNRESOLVED'),false);
 assert.ok(context.notices.some(i=>i.code==='DOCX_READER_WARNING'&&i.message.includes('修订')));
 assert.ok(context.notices.some(i=>i.code==='SOURCE_READING_USER_CONFIRMED'));
 const input=await readSourcePreparation(f.projectId,db);
 assert.equal(input.sourceInputVersion,pin,'paid source fingerprint stays pinned');
 assert.equal(input.readIssues.some(i=>i.code==='DOCX_REVISION_VIEW_UNRESOLVED'),false);
 for(const row of before)assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:row.id}}),row);
 assert.deepEqual(await db.episode.findMany({where:{projectId:f.projectId},orderBy:{id:'asc'}}),episodes);
 assert.equal(await db.pipelineRun.count({where:{projectId:f.projectId}}),0);
 const count=await db.sceneSnapshot.count({where:{projectId:f.projectId}});
 assert.equal((await confirmSourceReading(f.request,db)).id,saved.id);assert.equal(await db.sceneSnapshot.count({where:{projectId:f.projectId}}),count);
});

test('a reading choice cannot clear other DOCX failures or source-ownership gaps',async()=>{
 const f=await fixture(true);await confirmSourceReading(f.request,db);
 const {loadFoundationSourceContext}=await import('../lib/foundation-source'),{readSourcePreparation}=await import('../lib/source-preparation');
 assert.deepEqual((await loadFoundationSourceContext(f.projectId,db)).issues.map(i=>i.code),['DOCX_UNSUPPORTED_OBJECT']);
 assert.deepEqual((await readSourcePreparation(f.projectId,db)).readIssues.map(i=>i.code),['DOCX_UNSUPPORTED_OBJECT']);
});

test('unconfirmed choice, missing access, stale hashes and active work reject without a receipt',async()=>{
 const f=await fixture();
 for(const patch of [{confirmed:false},{choice:'ACCEPT_ALL_REVISIONS'},{sourceImportId:'stale'},{readingHash:'stale'},{originalHash:'stale'},{readerFingerprint:'stale'},{userId:'not-authorized'}]){
  await assert.rejects(confirmSourceReading({...f.request,...patch} as typeof f.request,db));
 }
 const operator=await db.user.create({data:{username:'operator',email:'operator@synthetic.invalid',passwordHash:'offline'}});
 await db.projectRole.create({data:{projectId:f.projectId,userId:operator.id,role:'OPERATOR'}});
 await assert.rejects(confirmSourceReading({...f.request,userId:operator.id},db),/管理员或审阅者/);
 const run=await db.pipelineRun.create({data:{projectId:f.projectId,stageCode:'F1',roleName:'synthetic active',provider:'CLI',status:'RUNNING'}});
 await assert.rejects(confirmSourceReading(f.request,db),/正在|在途/);
 await db.pipelineRun.update({where:{id:run.id},data:{status:'SUCCEEDED'}});
 await db.sceneSnapshot.create({data:{id:`foundation-delivery-${f.projectId}`,projectId:f.projectId,sceneKey:'FOUNDATION_DELIVERY_TASK',content:JSON.stringify({schema:'FOUNDATION_DELIVERY_TASK_V1',status:'RUNNING'})}});
 await assert.rejects(confirmSourceReading(f.request,db),/正在/);
 assert.equal(await db.sceneSnapshot.count({where:{projectId:f.projectId,sceneKey:'SOURCE_READING_CONFIRMATION'}}),0);
});

test('source replacement or in-place text/reader/original changes invalidate prior consent',async()=>{
 for(const mutation of ['replacement','text','reader','original'] as const){
  const f=await fixture();await confirmSourceReading(f.request,db);
  if(mutation==='replacement')await db.sceneSnapshot.create({data:{projectId:f.projectId,sceneKey:'SOURCE_IMPORT',content:f.original.content,metadata:f.original.metadata}});
  else{
   const body=JSON.parse(f.original.content);
   if(mutation==='text')body.sourceText+='新原文';
   if(mutation==='reader')body.readingView.view='DIFFERENT_READER';
   if(mutation==='original')body.originalFile.base64=Buffer.from('different original').toString('base64');
   await db.sceneSnapshot.update({where:{id:f.original.id},data:{content:JSON.stringify(body)}});
  }
  assert.equal((await readSourceReadingState(f.projectId,db)).confirmed,false);
  await assert.rejects(confirmSourceReading(f.request,db),/来源|读取|版本/);
  const {loadFoundationSourceContext}=await import('../lib/foundation-source');
  const context=await loadFoundationSourceContext(f.projectId,db);
  assert.equal(context.complete,false);assert.ok(context.issues.some(i=>['DOCX_REVISION_VIEW_UNRESOLVED','INVALID_SOURCE_IMPORT_STRUCTURE'].includes(i.code)));
  assert.equal(context.notices.some(i=>i.code==='SOURCE_READING_USER_CONFIRMED'),false);
 }
});

test('a page cannot display receipt A while confirming a concurrently replaced source B',async()=>{
 const f=await fixture(),{readFidelityReceipt}=await import('../lib/fidelity-store');
 const captured=(await readFidelityReceipt(f.projectId,db))!;
 const body=JSON.parse(f.original.content);body.sourceText=body.sourceText.replace('新句','新词');
 await db.sceneSnapshot.create({data:{projectId:f.projectId,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(body),metadata:f.original.metadata}});
 const latest=await readSourceReadingState(f.projectId,db);assert.ok(latest.binding);
 assert.equal(bindSourceReadingToDisplayedReceipt(latest,captured.receipt).binding,null,'mismatched receipt and source disable the form');
 const displayed=bindSourceReadingToDisplayedReceipt(await readSourceReadingState(f.projectId,db,captured.sourceSnapshot!),captured.receipt);
 assert.ok(displayed.binding);assert.equal(displayed.binding.sourceImportId,captured.sourceSnapshot!.id);
 await assert.rejects(confirmSourceReading({...f.request,...displayed.binding},db),/来源|版本/,'stale displayed source cannot confirm the newer source');
 for(const receipt of [{...captured.receipt,readingHash:'bad'},{...captured.receipt,originalHash:'bad'},{...captured.receipt,reader:{...captured.receipt.reader,view:'bad'}}]){
  assert.equal(bindSourceReadingToDisplayedReceipt(displayed,receipt).binding,null);
 }
});
