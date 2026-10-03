/** Exact reader comparisons on a fresh synthetic SQLite database. No providers. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PrismaClient} from '@prisma/client';

async function main(){
 const directory=mkdtempSync(path.join(tmpdir(),'director-db-read-'));
 const file=path.join(directory,'test.db'),sql=new DatabaseSync(file);
 for(const migration of readdirSync('prisma/migrations').sort())if(/^\d/.test(migration))sql.exec(readFileSync(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();
 const db=new PrismaClient({datasourceUrl:`file:${file}`});
 const {readFidelityReviewCandidates,readFidelityReceipt}=await import('../lib/fidelity-store');
 const {fidelityReviewCandidates}=await import('../lib/fidelity-review-candidates');
 const {loadFoundationInputs}=await import('../lib/foundation-state');
 const {createEmptyDocument,loadFoundationDocument}=await import('../lib/foundation-document');
 const {loadFoundationSourceContext}=await import('../lib/foundation-source');
 try{
  const project=await db.project.create({data:{title:'reader fixture',episodes:{create:{number:0,content:'😀甲：走。'}}}});
  const receipt={schema:'FIDELITY_RECEIPT_V1',readingHash:'source-v1',result:{source:{sourceVersion:'source-v1',text:'😀甲：走。'},episodes:[{number:0,start:0,end:7,productionEligible:true,sourceText:'unused',body:'unused'}]},
   p1Review:{status:'COMPLETE',reviewedSourceVersion:'source-v1',aliases:[{start:2,end:3,alias:'甲',canonicalCandidate:'甲本人',note:'角色称呼'}],unresolved:[{start:0,end:2,note:'符号含义',kind:'OTHER'}]},originalFile:{base64:'x'.repeat(2_000_000)}};
  const snapshot=await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FIDELITY_IMPORT',content:JSON.stringify(receipt)}});
  const compare=async()=>{
   const full=await readFidelityReceipt(project.id,db);
   assert.deepEqual(await readFidelityReviewCandidates(project.id,db),full?fidelityReviewCandidates(full.receipt):[]);
  };
  await compare();
  let returnedBytes=0;
  const measured=db.$extends({query:{$allOperations:async({args,query})=>{const value=await query(args);returnedBytes+=Buffer.byteLength(JSON.stringify(value));return value;}}});
  await readFidelityReviewCandidates(project.id,measured as unknown as PrismaClient);
  assert.ok(returnedBytes<3000,'normal reads must not transport original-file base64');
  // JSON.parse uses the last duplicate key; SQLite paths use the first.
  const duplicate=JSON.stringify(receipt).replace('"readingHash":"source-v1"','"readingHash":"old","readingHash":"source-v1"');
  await db.sceneSnapshot.update({where:{id:snapshot.id},data:{content:duplicate}});await compare();
  const duplicateEpisode=JSON.stringify(receipt).replace('"number":0','"number":9,"number":0');
  await db.sceneSnapshot.update({where:{id:snapshot.id},data:{content:duplicateEpisode}});await compare();
  const legacyEpisodeShape={...receipt,result:{...receipt.result,episodes:[...receipt.result.episodes,'historical-untyped-row']}};
  await db.sceneSnapshot.update({where:{id:snapshot.id},data:{content:JSON.stringify(legacyEpisodeShape)}});await compare();
  await db.sceneSnapshot.update({where:{id:snapshot.id},data:{content:'{broken'}});
  await assert.rejects(readFidelityReviewCandidates(project.id,db));
  await db.sceneSnapshot.delete({where:{id:snapshot.id}});
  assert.deepEqual(await readFidelityReviewCandidates(project.id,db),[]);
  await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',createdAt:new Date(1),metadata:'{"schema":"IMPORTED_SOURCE_TEXT_V2"}',content:JSON.stringify({sourceText:'😀甲：走。',sourceStructure:{version:'SOURCE_STRUCTURE_V1',sections:[{key:'e0',kind:'EPISODE',episodeNumber:0,start:0,end:'😀甲：走。'.length}],issues:[]}})}});
  const input=await loadFoundationInputs(project.id,db);
  const document=createEmptyDocument(input);
  await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FOUNDATION_DOCUMENT',createdAt:new Date(2),content:JSON.stringify(document)}});
  await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FOUNDATION_DOCUMENT',createdAt:new Date(3),content:'{broken'}});
  await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FOUNDATION_F2',content:'x'.repeat(1_000_000)}});
  const reads:string[]=[];
  const tracked=db.$extends({query:{sceneSnapshot:{findMany:async({args,query})=>{reads.push(JSON.stringify(args.where));return query(args);}}}});
  assert.equal((await loadFoundationDocument(tracked as unknown as PrismaClient,project.id,input)).document.revision,document.revision);
  assert.equal(reads.length,1);assert.ok(reads[0].includes('FOUNDATION_DOCUMENT')&&!reads[0].includes('FOUNDATION_F2'),'readable earlier current document must not load paid history');
  const old=await loadFoundationSourceContext(project.id,db);assert.equal(old.complete,true);
  await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',createdAt:new Date(4),metadata:'{broken',content:'{broken'}});
  const latest=await loadFoundationSourceContext(project.id,db);assert.equal(latest.complete,false);assert.equal(latest.coverage,'UNKNOWN');
  const plans=await db.$queryRawUnsafe<Array<{detail:string}>>("EXPLAIN QUERY PLAN SELECT content FROM SceneSnapshot WHERE projectId=? AND sceneKey=? ORDER BY createdAt DESC,id DESC LIMIT 1",project.id,'SOURCE_IMPORT');
  assert.ok(plans.some(row=>row.detail.includes('SceneSnapshot_projectId_sceneKey_createdAt_id_idx')));
  assert.ok(plans.every(row=>!row.detail.includes('TEMP B-TREE')));
  console.log('PASS: candidate projection/UTF16/duplicate-key fallback, malformed latest source, valid earlier document, history isolation, composite query plan');
 }finally{await db.$disconnect();await (await import('../lib/prisma')).prisma.$disconnect();rmSync(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
