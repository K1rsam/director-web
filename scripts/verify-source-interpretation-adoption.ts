import assert from 'node:assert/strict';
import {test} from 'node:test';
import {existsSync,mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {PrismaClient} from '@prisma/client';

test('afterSave failure rolls back the document and all writes in its outer transaction',async()=>{
 const directory=mkdtempSync(path.join(tmpdir(),'source-adoption-atomic-')),database=path.join(directory,'isolated.db'),sql=new DatabaseSync(database);
 for(const migration of readdirSync('prisma/migrations').filter(name=>/^\d/.test(name)).sort())sql.exec(readFileSync(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));sql.close();
 const db=new PrismaClient({datasourceUrl:`file:${database}`});
 try{
  const state=await import('../lib/foundation-state'),documents=await import('../lib/foundation-document');
  const project=await db.project.create({data:{title:'afterSave atomic',episodes:{create:[{number:1,content:'甲：原句。\n'}]}}});
  const input=await state.loadFoundationInputs(project.id,db),doc=documents.createEmptyDocument(input),before=await db.sceneSnapshot.findMany({where:{projectId:project.id}});
  await assert.rejects((documents.saveFoundationDocument as any)(db,project.id,doc.revision,doc,'synthetic atomic test',async(tx:any)=>{await tx.sceneSnapshot.create({data:{id:'synthetic-resolution-atomic',projectId:project.id,sceneKey:'SCRIPT_RESOLUTION_HISTORY_V1',content:'synthetic only'}});},async()=>{throw new Error('synthetic registrar failure');}),/synthetic registrar failure/);
  assert.deepEqual(await db.sceneSnapshot.findMany({where:{projectId:project.id}}),before);
 }finally{await db.$disconnect();rmSync(directory,{recursive:true,force:true});}
});
test('a source interpretation batch atomically retains paid catalog and separately records free editorial adoption',async()=>{
 assert.ok(existsSync('lib/source-interpretation-adoption.ts'),'source interpretation adoption service is required');
 const service:any=await import('../lib/source-interpretation-adoption' as string);
 const state=await import('../lib/foundation-state'),documents=await import('../lib/foundation-document'),contracts=await import('../lib/foundation-production-contracts');
 const standard=await import('../lib/standard-script'),resolutions=await import('../lib/script-resolution-service');
 const directory=mkdtempSync(path.join(tmpdir(),'source-adoption-')),database=path.join(directory,'isolated.db');
 const sql=new DatabaseSync(database);
 for(const migration of readdirSync('prisma/migrations').filter(name=>/^\d/.test(name)).sort())sql.exec(readFileSync(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();const db=new PrismaClient({datasourceUrl:`file:${database}`});
 const savedFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('PROVIDER_FORBIDDEN: no network or model requests in source adoption');};
 try{
  const [actor,operator]=await Promise.all(['reviewer','operator'].map(name=>db.user.create({data:{username:`regroup-${name}`,email:`regroup-${name}@invalid.test`,name,passwordHash:'synthetic-no-login'}})));
  const text1='人物：甲\n陌生使者：由人工明确说者。\n',text2='人物：甲\n甲：先登记。别只拆完△清单推来。便算完成。\n乙抬手。\n';
  const project=await db.project.create({data:{title:'source adoption synthetic',executionMode:'API',roles:{create:[{userId:actor.id,role:'REVIEWER'},{userId:operator.id,role:'OPERATOR'}]},episodes:{create:[{number:1,content:text1},{number:2,content:text2},{number:3,content:'甲：保留原话。\n'}]}}});
  let sourceOffset=0;const originals=[text1,text2,'甲：保留原话。\n'];
  await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'}),content:JSON.stringify({sourceText:originals.join(''),sourceStructure:{version:'SOURCE_STRUCTURE_V1',issues:[],sections:originals.map((text,i)=>{const start=sourceOffset;sourceOffset+=text.length;return {key:`ep-${i+1}`,kind:'EPISODE',episodeNumber:i+1,start,end:sourceOffset};})}})}});
  const input=await state.loadFoundationInputs(project.id,db),base=documents.createEmptyDocument(input);
  base.workflow='LIGHT_STAGE1_V1';base.f2=contracts.requireProductionCatalogAuthor({format:'ASSET_CATALOG_V2',coverage:[1,2,3],assets:[{name:'甲',type:'CH',episodes:[1,2,3],preparation:{mode:'REFERENCE'},variants:[]}]},input.sourceIndex,[1,2,3]);
  base.editorialCoverage=[1,2,3];base.origins=[{stage:'F2',runId:'synthetic-paid-f2',scope:[1,2,3],kind:'delivery'},{stage:'Q1',runId:'synthetic-paid-q1',scope:[1,2,3],kind:'delivery'}];
  const baseline=await documents.saveFoundationDocument(db,project.id,base.revision,base,'synthetic original paid catalog');
  await (await import('../lib/foundation-delivery-assets')).registerFoundationDocumentAssets(db,project.id,baseline,[]);
  const source=standard.createSourceIndex(text2,'episode-2'),selected=source.units.slice(1),a=text2.indexOf('△'),b=text2.indexOf('便算'),bodyStart=text2.indexOf('甲：')+2,tailEnd=selected[1].end-1;
  const parts=(start:number,end:number)=>source.units.flatMap(unit=>{const x=Math.max(start,unit.start),y=Math.min(end,unit.end);return x<y?[{kind:/^[\t \r\n]+$/.test(text2.slice(x,y))?'SOURCE_SEPARATOR':'SOURCE_SLICE',unitId:unit.id,start:x,end:y}]:[];});
  const request:any={expectedDocumentRevision:baseline.revision,explanation:'已逐项核对两处解释，保留原件与前后对照。',changes:[
   {episode:1,sourceVersion:standard.createSourceIndex(text1,'episode-1').sourceVersion,expectedRevision:0,choice:{startLine:2,endLine:2,type:'DIALOGUE',speaker:'陌生使者',channel:'SPEECH'}},
   {episode:2,sourceVersion:source.sourceVersion,expectedRevision:0,choice:{startLine:2,endLine:3,type:'SOURCE_REGROUP',version:'source-regroup-v1',children:[
    {id:'voice',kind:'DIALOGUE',parts:[...parts(bodyStart,a),...parts(b,selected[0].end-1)],layout:[],speaker:parts(selected[0].start,bodyStart-1),channel:'SPEECH',cue:null,channelSource:null},
    {id:'stage',kind:'ACTION',parts:[...parts(a,b),...parts(selected[1].start,tailEnd)],layout:[]}],layout:[...parts(bodyStart-1,bodyStart),...parts(selected[0].end-1,selected[0].end),...parts(tailEnd,selected[1].end)]}}
  ]};
  const counts=async()=>({snapshots:await db.sceneSnapshot.count({where:{projectId:project.id}}),runs:await db.pipelineRun.findMany({where:{projectId:project.id}}),episodes:await db.episode.findMany({where:{projectId:project.id}})});
  const before=await counts(),preview=await service.previewSourceInterpretationAdoption(project.id,actor.id,request,{db});
  assert.deepEqual(await counts(),before,'preview must be read only');assert.equal(preview.cost,'FREE');assert.equal(preview.providerCalls,0);
  assert.deepEqual(preview.after.catalogCoverage,[1,2,3]);assert.deepEqual(preview.after.editorialCoverage,[3]);assert.deepEqual(preview.after.effectiveEditorialCoverage,[1,2,3]);
  for(const bad of [{...request,actorId:'customer'},{...request,approvalOrigin:'SESSION'},{...request,explanation:''}])await assert.rejects(service.previewSourceInterpretationAdoption(project.id,actor.id,bad,{db}));
  for(const bad of [{...request,changes:request.changes.map((item:any,i:number)=>i?item:{...item,sourceVersion:'stale-source'})},{...request,changes:request.changes.map((item:any,i:number)=>i?item:{...item,expectedRevision:1})}])await assert.rejects(service.previewSourceInterpretationAdoption(project.id,actor.id,bad,{db}));
  await db.$executeRaw`UPDATE Episode SET content=${text1+'原文已变。'} WHERE projectId=${project.id} AND number=1`;
  const sourceChanged=await counts();await assert.rejects(service.adoptSourceInterpretationAdoption(project.id,actor.id,{...request,previewDigest:preview.previewDigest},{db}),/原文|来源|修订|revision/);assert.deepEqual(await counts(),sourceChanged,'changed original source rejects with zero adoption writes');
  await db.$executeRaw`UPDATE Episode SET content=${text1} WHERE projectId=${project.id} AND number=1`;
  await assert.rejects(service.adoptSourceInterpretationAdoption(project.id,operator.id,{...request,previewDigest:preview.previewDigest},{db}),/权限|审阅|ROLE/);
  await assert.rejects(service.adoptSourceInterpretationAdoption(project.id,actor.id,{...request,previewDigest:'stale-preview'},{db}),/预览|PREVIEW/);
  assert.deepEqual(await counts(),before,'failed approval and permission checks must perform zero writes');
  const taskId=`foundation-delivery-${project.id}`,now=new Date().toISOString();
  for(const safety of [{status:'RUNNING',unknownOutcome:false},{status:'PARTIAL',unknownOutcome:true},{status:'STOPPED',unknownOutcome:false}]){
   const task={schema:'FOUNDATION_DELIVERY_TASK_V1',id:'synthetic-original-task',revision:0,projectId:project.id,provider:'API',contextFingerprint:'synthetic',sourceVersion:input.sourceVersion,documentRevision:baseline.revision,
    phase:'REPAIR',scope:[],completedEpisodes:[1,2,3],totalEpisodes:3,message:'synthetic safety boundary',createdAt:now,updatedAt:now,workerPid:null,workerToken:'synthetic-worker',addedCalls:40,repairCalls:6,repairRounds:2,maxRepairCalls:6,maxRepairRounds:2,repairBudgetUsed:6,error:null,decisionIds:[],unresolved:[],...safety};
   await db.sceneSnapshot.create({data:{id:taskId,projectId:project.id,sceneKey:'FOUNDATION_DELIVERY_TASK',content:JSON.stringify(task)}});
   const guarded=await counts();await assert.rejects(service.adoptSourceInterpretationAdoption(project.id,actor.id,{...request,previewDigest:preview.previewDigest},{db}),/运行|未知|停止|STOPPED|安全|状态/);
   assert.deepEqual(await counts(),guarded,`${safety.status}/${safety.unknownOutcome} must have zero writes`);
   await db.sceneSnapshot.delete({where:{id:taskId}});
  }
  const idleTask={schema:'FOUNDATION_DELIVERY_TASK_V1',id:'synthetic-original-task',revision:3,projectId:project.id,provider:'API',contextFingerprint:'synthetic',sourceVersion:input.sourceVersion,documentRevision:baseline.revision,
   status:'PARTIAL',phase:'REPAIR',scope:[1,2],completedEpisodes:[1,2,3],totalEpisodes:3,message:'old pause',createdAt:now,updatedAt:now,workerPid:null,workerToken:'synthetic-worker',addedCalls:40,repairCalls:6,repairRounds:2,maxRepairCalls:6,maxRepairRounds:2,repairBudgetUsed:6,repairBudgetKey:'kept-key',unknownOutcome:false,error:'old parse pause',decisionIds:[],unresolved:[]};
  await db.sceneSnapshot.create({data:{id:taskId,projectId:project.id,sceneKey:'FOUNDATION_DELIVERY_TASK',content:JSON.stringify(idleTask)}});
  const idlePreview=await service.previewSourceInterpretationAdoption(project.id,actor.id,request,{db});
  const adopted=await service.adoptSourceInterpretationAdoption(project.id,actor.id,{...request,previewDigest:idlePreview.previewDigest},{db});
  const currentInput=await state.loadFoundationInputs(project.id,db),loaded=await documents.loadFoundationDocument(db,project.id,currentInput),current:any=loaded.document;
  assert.notEqual(current.revision,baseline.revision);assert.equal(loaded.sourceChanged,false);assert.deepEqual(current.f2,baseline.f2);
  assert.deepEqual(current.editorialCoverage,[3]);assert.deepEqual(current.origins,baseline.origins);
  assert.deepEqual(service.effectiveEditorialCoverage(current,documents.createEmptyDocument(currentInput)),[1,2,3]);
  assert.equal(current.sourceInterpretationAdoptions.length,1);assert.deepEqual(current.sourceInterpretationAdoptions[0].episodes,[1,2]);
  assert.equal(current.sourceInterpretationAdoptions[0].approval.actorId,actor.id);assert.equal(current.sourceInterpretationAdoptions[0].approval.origin,'SESSION');
  const savedTask=JSON.parse((await db.sceneSnapshot.findUniqueOrThrow({where:{id:taskId}})).content!);
  assert.equal(savedTask.documentRevision,current.revision,'free adoption must synchronize the original task in the same outer transaction');
  const delivery=await (await import('../lib/foundation-delivery')).getFoundationDeliveryState(project.id,db);
  assert.equal(savedTask.id,idleTask.id);assert.equal(savedTask.status,delivery.complete?'COMPLETE':'PARTIAL');assert.equal(savedTask.phase,'EDIT');assert.deepEqual(savedTask.scope,[]);assert.deepEqual(savedTask.completedEpisodes,[1,2,3]);assert.equal(savedTask.error,null);assert.match(savedTask.message,/免费/);
  for(const key of ['addedCalls','repairCalls','repairRounds','maxRepairCalls','maxRepairRounds','repairBudgetUsed','repairBudgetKey','workerToken','createdAt'])assert.deepEqual(savedTask[key],(idleTask as any)[key],`${key} must remain unchanged`);
  const after=await counts();assert.deepEqual(after.runs,before.runs);assert.deepEqual(after.episodes,before.episodes);
  assert.equal((await resolutions.readScriptReception(project.id,actor.id,2,{db})).selected?.ready,true);
  for(const mutate of [(doc:any)=>{doc.f2.assets[0].description+=' drift';},(doc:any)=>{doc.settingsFingerprint+='-changed';},(doc:any)=>{doc.sourceHashes[2]='changed';},(doc:any)=>{doc.origins[1].runId='other';}]){
   const changed=structuredClone(current);mutate(changed);assert.deepEqual(service.effectiveEditorialCoverage(changed),[3],'proof drift must invalidate free coverage');
  }
  assert.deepEqual(service.effectiveEditorialCoverage(current,{...currentInput,presentationConditions:[...currentInput.presentationConditions,{id:'synthetic-current-condition-drift'}]}),[3],'current production condition drift invalidates free proof');
  await assert.rejects(service.adoptSourceInterpretationAdoption(project.id,actor.id,{...request,previewDigest:preview.previewDigest},{db}),/revision|修订|CONFLICT/);
  assert.deepEqual(await counts(),after,'replaying an old preview must be atomic and have zero writes');
  const reception=await resolutions.readScriptReception(project.id,actor.id,2,{db}),decision=reception.selected!.decisions.find(item=>item.type==='SOURCE_REGROUP')!;
  const revokeRequest={expectedDocumentRevision:current.revision,explanation:'撤销后不冒充来源已核对，旧Q1与目录仍保留。',changes:[{episode:2,sourceVersion:source.sourceVersion,expectedRevision:reception.selected!.revision,decisionId:decision.id}]};
  const revokePreview=await service.previewSourceInterpretationAdoption(project.id,actor.id,revokeRequest,{db});
  await service.adoptSourceInterpretationAdoption(project.id,actor.id,{...revokeRequest,previewDigest:revokePreview.previewDigest},{db});
  const revoked=(await documents.loadFoundationDocument(db,project.id,await state.loadFoundationInputs(project.id,db))).document;
  assert.equal(revoked.sourceInterpretationAdoptions![0].status,'REVOKED');assert.deepEqual(service.effectiveEditorialCoverage(revoked),[3]);assert.deepEqual(revoked.f2,baseline.f2);assert.deepEqual(revoked.origins,baseline.origins);
  const revokedTask=JSON.parse((await db.sceneSnapshot.findUniqueOrThrow({where:{id:taskId}})).content!);assert.equal(revokedTask.status,'PARTIAL');assert.notEqual(revokedTask.documentRevision,savedTask.documentRevision);assert.equal(revokedTask.repairBudgetUsed,idleTask.repairBudgetUsed);
  assert.ok(adopted);
 }finally{globalThis.fetch=savedFetch;await db.$disconnect();rmSync(directory,{recursive:true,force:true});}
});
