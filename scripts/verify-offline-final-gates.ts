/** Offline final gate: reuse saved provider responses; never invoke an execution adapter. */
import assert from 'node:assert/strict';
import {readFileSync,copyFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
async function main(){
 // This is a negative regression fixture: a newer correct response cannot exercise rejection.
 const evidence=path.resolve('scripts/fixtures/offline-physical-vo-rejection.json');
 const fixture=JSON.parse(readFileSync(evidence,'utf8'));
 const source=fixture.source as string,f2=fixture.f2,q1=fixture.q1;
 assert(source.includes('他把铜钥匙交给李四。') && source.includes('李四VO：'), 'fixture retains physical and VO evidence');
 assert(JSON.stringify(f2.data).includes('本次不安排实体入镜'), 'fixture must retain the deliberately rejected physical omission');
 assert.deepEqual(JSON.parse(f2.rawOutput),f2.data);assert.deepEqual(JSON.parse(q1.rawOutput),q1.data);
 const directory=mkdtempSync(path.join(tmpdir(),'offline-final-gates-')),url=`file:${directory}/test.db`;process.env.DATABASE_URL=url;process.env.PYTHONUTF8='1';
 copyFileSync('prisma/schema.prisma',`${directory}/schema.prisma`);execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${directory}/schema.prisma`,'--skip-generate'],{env:{...process.env,RUST_LOG:'info'},stdio:'pipe'});
 const db=new PrismaClient({datasourceUrl:url});const results:Record<string,unknown>={evidence,fixtureHash:createHash('sha256').update(readFileSync(evidence)).digest('hex'),originalEvidence:fixture.provenance};const failures:string[]=[];
 try{
  const {prepareFidelityImport}=await import('../lib/fidelity-import');const {importParsedProject}=await import('../lib/workflow');const {loadFoundationInputs}=await import('../lib/foundation-state');
  const {createEmptyDocument,mergeDocumentF2,applyDocumentEdit,saveFoundationDocument}=await import('../lib/foundation-document');const {requireProductionCatalogAuthor,requireProductionOptimization}=await import('../lib/foundation-production-contracts');
  const {LIGHT_ASSET_METHOD_VERSION}=await import('../lib/foundation-production-prompts');const {readLightEpisodeFoundation}=await import('../lib/light-foundation-reader');const {getFoundationDeliveryState}=await import('../lib/foundation-delivery');
  const user=await db.user.create({data:{username:'offline-final',email:'offline-final@example.test',passwordHash:'isolated-no-login'}});
  async function prepare(text:string,title:string,real:boolean){const prepared=await prepareFidelityImport('source.txt',Buffer.from(text),'fidelity');const {project}=await importParsedProject({ownerUserId:user.id,title,sourceName:'source.txt',fidelityReceipt:prepared.receipt},prepared.imported,db);const input=await loadFoundationInputs(project.id,db),empty=createEmptyDocument(input);const scope=input.sourceIndex.episodes.map(e=>e.number);
   const catalog=requireProductionCatalogAuthor(real?f2.data:{format:'ASSET_CATALOG_V2',coverage:scope,assets:[{name:text.includes('张三：')?'张三':'甲',type:'CH',episodes:scope,sceneRefs:[{episode:1,sceneKey:'1-1'}],preparation:{mode:'REFERENCE'}}]},input.sourceIndex,scope);
   let document=mergeDocumentF2({...empty,workflow:'LIGHT_STAGE1_V1',assetMethodVersion:LIGHT_ASSET_METHOD_VERSION},catalog,input.sourceIndex);
   document=applyDocumentEdit(document,requireProductionOptimization(real?q1.data:{format:'FOUNDATION_OPTIMIZATION_V2',coverage:scope,changes:{}},input.sourceIndex,scope,document.f2!.assets),input.sourceIndex);
   await saveFoundationDocument(db,project.id,empty.revision,document,'offline saved-response gate test');return project.id;
  }
  const real=await prepare(source,'真实响应离线复验',true);const state=await getFoundationDeliveryState(real,db),handoff=await readLightEpisodeFoundation(real,1,db);
  results.physical={complete:state.complete,documentReady:state.documentReady,issues:state.issues,readiness:handoff.readiness,reasons:handoff.reasons,catalogIssues:state.document.f2?.issues};
  if(state.complete)failures.push('physical BLOCKER failed to stop overall complete');if(handoff.readiness==='READY')failures.push('physical BLOCKER failed to stop episode handoff READY');if(!state.issues.some(i=>i.severity==='BLOCKER'&&i.problem.includes('实体交互')))failures.push('physical evidence absent from state issues');
  const second=await readLightEpisodeFoundation(real,2,db);results.physicalOtherEpisode={readiness:second.readiness,reasons:second.reasons};if(second.reasons.some(r=>r.includes('第1集第3行')))failures.push('episode1 physical blocker leaked into unrelated episode2');
  const known=await prepare('作者资料\n张三是李四的哥哥。\n王五：远方的商人。\n第1集\n1-1 客厅 日 内\n张三：你好。\n','格式标题和别对象资料不阻断',false);const knownPacket=await readLightEpisodeFoundation(known,1,db);const knownState=await getFoundationDeliveryState(known,db);results.knownBackground={complete:knownState.complete,documentReady:knownState.documentReady,readiness:knownPacket.readiness,reasons:knownPacket.reasons,background:knownPacket.packet.facts.background};if(!knownState.complete||!knownState.documentReady)failures.push('format heading or unrelated SUBJECT blocked overall completion');if(knownPacket.readiness!=='READY'||!knownPacket.packet.facts.background.some(f=>f.statement.includes('哥哥')))failures.push('format heading or unrelated SUBJECT blocked ready');
  const global=await prepare('世界观设定\n规则：所有人午夜后不得说谎。\n第1集\n1-1 客厅 日 内\n甲：你好。\n','GLOBAL供给',false);const globalPacket=await readLightEpisodeFoundation(global,1,db);results.global={readiness:globalPacket.readiness,background:globalPacket.packet.facts.background,reasons:globalPacket.reasons};
  if(!globalPacket.packet.facts.background.some(f=>f.applicability==='GLOBAL'&&f.statement.includes('不得说谎')))failures.push('unnamed GLOBAL fact missing from actual handoff');
  const unknown=await prepare('作者资料\n蓝色笔记。\n第1集\n1-1 客厅 日 内\n甲：你好。\n','无关联资料保留不阻断',false);const unknownPacket=await readLightEpisodeFoundation(unknown,1,db);const unknownState=await getFoundationDeliveryState(unknown,db);results.unknown={complete:unknownState.complete,documentReady:unknownState.documentReady,issues:unknownState.issues,readiness:unknownPacket.readiness,reasons:unknownPacket.reasons,unlinked:unknownPacket.packet.facts.unlinkedBackground};if(!unknownState.complete||!unknownState.documentReady||unknownPacket.readiness!=='READY')failures.push('retrieval-only unlinked background incorrectly blocks handoff');if(!unknownPacket.packet.facts.backgroundCandidates.some(f=>f.statement.includes('蓝色笔记'))||!unknownPacket.packet.facts.unlinkedBackgroundCount)failures.push('unlinked background evidence was lost');
  const sourceRow=await db.sceneSnapshot.findFirstOrThrow({where:{projectId:global,sceneKey:'SOURCE_IMPORT'},orderBy:{createdAt:'desc'}}),bad=JSON.parse(sourceRow.content);bad.sourceStructure.sections=bad.sourceStructure.sections.filter((s:{kind:string})=>s.kind!=='BACKGROUND');await db.sceneSnapshot.create({data:{projectId:global,sceneKey:'SOURCE_IMPORT',content:JSON.stringify(bad),metadata:sourceRow.metadata,title:'模拟缺失GLOBAL源区'}});
  const missing=await readLightEpisodeFoundation(global,1,db);results.missingGlobal={readiness:missing.readiness,reasons:missing.reasons};if(missing.readiness==='READY'||!missing.reasons.some(r=>r.includes('来源')||r.includes('原文')))failures.push('missing GLOBAL source coverage did not block readiness');
  assert.equal(await db.pipelineRun.count(),0,'zero provider runs');results.providerRuns=0;results.failures=failures;
  const report=path.resolve('runtime-3008/offline-final-gates.json');writeFileSync(report,JSON.stringify(results,null,2));console.log(JSON.stringify({report,...results},null,2));assert.deepEqual(failures,[]);
 }finally{await db.$disconnect();const resolved=path.resolve(directory);if(!resolved.startsWith(path.resolve(tmpdir())+path.sep))throw Error('cleanup');rmSync(resolved,{recursive:true,force:true});}
}
void main().catch(e=>{console.error(e);process.exitCode=1;});
