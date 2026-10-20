/** Real controller, disposable SQLite; no model/network or user database. */
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PrismaClient} from '@prisma/client';

async function main(){
 const dir=mkdtempSync(path.join(tmpdir(),'foundation-saved-only-')),url=`file:${dir}/test.db`;
 process.env.DATABASE_URL=url;process.env.CODEX_CLI_PATH='/__offline_only__/no-codex';process.env.DEEPSEEK_API_KEY='';
 const sql=new DatabaseSync(path.join(dir,'test.db'));
 for(const migration of readdirSync('prisma/migrations').sort())if(/^\d/.test(migration))sql.exec(readFileSync(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));sql.close();
 const client=new PrismaClient({datasourceUrl:url});let checkpoint=true;
 const db=client.$extends({query:{pipelineRun:{async update({args,query}){
  if(checkpoint&&args.data.status==='SUCCEEDED'){checkpoint=false;throw Error('OFFLINE_SAVED_CHECKPOINT');}return query(args);
 }}}}) as unknown as PrismaClient;
 try{
  const api=await import('../lib/foundation-delivery');
  const {loadFoundationInputs}=await import('../lib/foundation-state');
  const {createEmptyDocument,mergeDocumentF2,saveFoundationDocument}=await import('../lib/foundation-document');
  const {requireProductionCatalogAuthor}=await import('../lib/foundation-production-contracts');
  const {LIGHT_ASSET_METHOD_VERSION}=await import('../lib/foundation-production-prompts');
  const project=await db.project.create({data:{title:'已付资产回包恢复',episodes:{create:[1,2,3].map(number=>({number,content:`第${number}集\n${number}-1 日 外 城门\n人物：守军\n△守军守在城门。\n${number}-2 日 外 营地\n△守军列队。\n`}))}}});
  const original=await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}});
  const input=await loadFoundationInputs(project.id,db),empty=createEmptyDocument(input);
  const catalog=requireProductionCatalogAuthor({format:'ASSET_CATALOG_V2',coverage:[1],assets:[{name:'守军',type:'GROUP',episodes:[1],preparation:{mode:'REFERENCE'}}]},input.sourceIndex,[1]);
  await saveFoundationDocument(db,project.id,empty.revision,mergeDocumentF2({...empty,workflow:'LIGHT_STAGE1_V1',assetMethodVersion:LIGHT_ASSET_METHOD_VERSION},catalog,input.sourceIndex),'offline prior batch');
  const task=await api.queueFoundationDelivery(project.id,{},db);let calls=0;
  await api.executeFoundationDelivery(project.id,task.id,{db,stageRunner:async(stage,prompt)=>{
   calls++;assert.equal(stage,'F2');const req=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
   const key=req.registry.find((a:any)=>a.name==='守军').key;
   const data={format:'ASSET_CATALOG_V2',coverage:req.scope,assets:[{key,name:'守军',type:'GROUP',episodes:req.scope,sceneRefs:req.scope.map((episode:number)=>[episode,`${episode}-1`]),relationNote:'城门使用'},
    {key,name:'守军',type:'GROUP',episodes:[3],sceneRefs:[[3,'3-2']],relationNote:'营地补充'}]};
   return {data,rawOutput:JSON.stringify(data),stdout:'offline usage',stderr:'',sessionId:null};
  }});
  const failed=await api.getFoundationDeliveryState(project.id,db);assert.equal(calls,1);assert.equal(failed.task?.status,'PARTIAL');assert.deepEqual(failed.document.f2?.coverage,[1]);
  const evidence=await db.pipelineRun.findMany({where:{projectId:project.id},orderBy:{id:'asc'}});
  const resumed=await api.queueFoundationDelivery(project.id,{},db);
  await api.executeFoundationDelivery(project.id,resumed.id,{db,savedResponsesOnly:true,stageRunner:async()=>{calls++;throw Error('Saved-only must never invoke any provider');}} as Parameters<typeof api.executeFoundationDelivery>[2]);
  const recovered=await api.getFoundationDeliveryState(project.id,db);
  assert.equal(calls,1,'recovery stops before the first unfinished Q1 request');
  assert.deepEqual(recovered.document.f2?.coverage,[1,2,3]);assert.equal(recovered.editedEpisodes,0);assert.equal(recovered.complete,false);
  assert.equal(recovered.task?.error,null);assert.match(recovered.task!.message,/未发起新请求/);assert.equal(recovered.action,'CONTINUE');
  assert.deepEqual(await db.pipelineRun.findMany({where:{projectId:project.id},orderBy:{id:'asc'}}),evidence,'no new NOT_SENT run or rewritten original evidence');
  assert.deepEqual(await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}}),original);
  const snapshotCount=await db.sceneSnapshot.count({where:{projectId:project.id,sceneKey:'FOUNDATION_DOCUMENT'}});
  await assert.rejects(api.recoverSavedFoundationDelivery(project.id,'stale-state',db),/状态已变化/);
  await api.recoverSavedFoundationDelivery(project.id,recovered.expectedState,db);
  assert.equal(calls,1);assert.equal(await db.sceneSnapshot.count({where:{projectId:project.id,sceneKey:'FOUNDATION_DOCUMENT'}}),snapshotCount,'repeated free recovery cannot duplicate adopted revisions');
  const row=await db.sceneSnapshot.findUniqueOrThrow({where:{id:'foundation-delivery-'+project.id}}),base=JSON.parse(row.content);
  for(const status of ['STOPPED','COMPLETE','QUEUED','RUNNING']){
   await db.sceneSnapshot.update({where:{id:row.id},data:{content:JSON.stringify({...base,status,workerPid:status==='RUNNING'?process.pid:null})}});
   const state=await api.getFoundationDeliveryState(project.id,db);
   await assert.rejects(api.recoverSavedFoundationDelivery(project.id,state.expectedState,db));
  }
  await db.sceneSnapshot.update({where:{id:row.id},data:{content:JSON.stringify({...base,status:'INTERRUPTED',unknownOutcome:true})}});
  const unknown=await api.getFoundationDeliveryState(project.id,db);await assert.rejects(api.recoverSavedFoundationDelivery(project.id,unknown.expectedState,db));
  console.log('PASS real saved-only controller: old reply adopted, same task, immutable source/native evidence, no new request, no false Q1 completion');
 }finally{await client.$disconnect();rmSync(dir,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
