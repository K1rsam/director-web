/** Immutable planned/closed season evidence. No model, image generation or automatic next-season work. */
import {randomUUID,createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import path from 'node:path';
import type {Prisma,PrismaClient} from '@prisma/client';
import {prisma} from './prisma';
import {requireSeasonProduction,seasonSourceBasis} from './season-scope-service';
import {seasonHash,seasonDelivery,SEASON_HANDOFF_VERSION} from '../runtime/season-scope.mjs';
type Row=Record<string,any>;type Db=Prisma.TransactionClient;
const KEY='PRODUCTION_SEASON_HANDOFF_V1';
function fail(message:string,code='SEASON_HANDOFF'):never{throw Object.assign(new Error(message),{code,status:409,requestOutcome:'NOT_SENT'});}
const parse=(text:string|null|undefined)=>{try{return JSON.parse(text??'null');}catch{return null;}};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
// Evidence is persisted as JSON: hash those same bytes' values, including Prisma dates.
const jsonSafe=<T>(value:T):T=>JSON.parse(JSON.stringify(value));
const safeId=(id:unknown)=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
const stores=()=>{const req=createRequire(path.join(process.cwd(),'package.json')),{createStore}=req(path.join(process.cwd(),'runtime/storyboard-v4/core/store.mjs'));return {workflows:createStore(path.resolve(process.env.DIRECTOR_PRODUCTION_WORKFLOW_DIR||path.join(process.cwd(),'.production-workflows'))),runs:createStore(path.resolve(process.env.DIRECTOR_STORYBOARD_DATA_DIR||path.join(process.cwd(),'.storyboard-stage3-v2')))};};
export const seasonSourceCompatibility=(basis:Row)=>seasonHash({sourceHash:basis.sourceHash,bodyHash:basis.bodyHash,episodes:basis.episodes.map((e:Row)=>({number:e.number,content:e.content,sceneKeys:e.sceneKeys}))});
async function access(db:Db,p:string,u:string){if(!await db.projectRole.count({where:{projectId:p,userId:u,role:{in:['ADMIN','REVIEWER']}}}))fail('需要本项目管理员或审阅者确认实际收口。','SEASON_PERMISSION');}
function resumeFor(scope:Row,basis:Row,closedId:string|null){const index=basis.episodes.findIndex((e:Row)=>e.number===scope.episodeNumbers.at(-1));return {nextEpisode:basis.episodes[index+1]?.number??null,seasonNumber:scope.seasonNumber+1,previousScopeHash:seasonHash(scope),closedId};}
export async function savePlannedSeasonHandoff(projectId:string,scope:Row,basis:Row,db:Db){
 const source=await db.sceneSnapshot.findFirst({where:{projectId,sceneKey:'SOURCE_IMPORT'},orderBy:[{createdAt:'desc'},{id:'desc'}]});
 const id=randomUUID(),payload={version:SEASON_HANDOFF_VERSION,id,kind:'planned',projectId,productionScope:scope,scopeHash:seasonHash(scope),source:{sourceImportId:basis.sourceImportId,sourceHash:basis.sourceHash,sourceVersion:basis.sourceVersion,bodyHash:basis.bodyHash,compatibility:seasonSourceCompatibility(basis),snapshot:source?parse(source.content):null,readingIndex:basis.episodes},resume:resumeFor(scope,basis,null),createdAt:new Date().toISOString(),limitations:['计划包没有实际末稿/尾态，不能作为闭季或续季生产依据。','源稿追加或修改须新输入版本和兼容核查；本版不自动跨源迁移。']};
 const record={...payload,identity:seasonHash(payload)};await db.sceneSnapshot.create({data:{id,projectId,sceneKey:KEY,title:'首季计划与续季对接（planned）',content:JSON.stringify(record)}});return record;
}
export async function readSeasonHandoff(projectId:string,id:string|undefined,db:Db=prisma){
 const row=id?await db.sceneSnapshot.findFirst({where:{id,projectId,sceneKey:KEY}}):await db.sceneSnapshot.findFirst({where:{projectId,sceneKey:KEY},orderBy:[{createdAt:'desc'},{id:'desc'}]});
 if(!row)fail('尚无本季计划或实际闭季记录。');const record=parse(row.content),{identity,...payload}=record;
 if(record.version!==SEASON_HANDOFF_VERSION||seasonHash(payload)!==identity)fail('交接记录完整性变化，旧包保留，未采用。');return record;
}
async function actualEvidence(projectId:string,actorId:string,workflowId:string,db:Db){
 if(!safeId(workflowId))fail('请选择本项目实际完成并已导出的制作流程。');
 // Reuse the existing authenticated delivery adapter: this checks current source,
 // selected adoption, boundary review, native receipts and exact delivered bytes.
 const {readProductionDeliveryFile}=await import('./production-workflow');
 const [manifestFile,textFile]=await Promise.all([readProductionDeliveryFile(projectId,actorId,workflowId,'manifest.json'),readProductionDeliveryFile(projectId,actorId,workflowId,'complete.md')]);
 const exportManifest=parse(manifestFile.body),store=stores(),workflow=await store.workflows.read(workflowId);
 if(workflow.projectId!==projectId||workflow.activeAction)fail('制作流程归属或在途状态变化，未闭季。');
 const runs=await Promise.all(workflow.episodeNumbers.map((n:number)=>store.runs.read(workflow.selectedRuns[n])));
 const [assets,snapshots]=await Promise.all([db.asset.findMany({where:{projectId},orderBy:{id:'asc'}}),db.sceneSnapshot.findMany({where:{projectId,sceneKey:{in:['ASSET_PROMPT_V1','ASSET_DESIGN_CURRENT_V1','ASSET_DESIGN_ADOPTION_V1','ASSET_IMAGE_JOB_V1']}},orderBy:{id:'asc'}})]);
 return {workflow,runs,exportManifest,adoptedStoryboard:textFile.body,assets,snapshots};
}
function designSnapshot(evidence:Row){
 const rows=evidence.snapshots.map((s:Row)=>parse(s.content)).filter(Boolean);
 const designs=evidence.assets.map((asset:Row)=>{const meta=parse(asset.metadata)??{},assetKey=meta.foundationVariantKey??meta.foundationKey??asset.code,pointer=rows.find((r:Row)=>r.schema==='ASSET_DESIGN_CURRENT_V1'&&r.assetKey===assetKey),adopted=rows.find((r:Row)=>r.schema==='ASSET_DESIGN_ADOPTION_V1'&&r.action==='ADOPT'&&r.assetKey===assetKey&&r.version===pointer?.currentVersion),prompt=rows.find((r:Row)=>r.schema==='ASSET_PROMPT_V1'&&r.key===assetKey);return {stableId:asset.id,code:asset.code,assetKey,designVersion:adopted?.version??0,promptRevision:prompt?.revision??0,adoptedDesign:adopted??null};});
 const images=[...designs.flatMap((d:Row)=>(d.adoptedDesign?.references??[]).map((ref:Row)=>({assetId:d.stableId,assetKey:d.assetKey,designVersion:d.designVersion,state:'adopted',reference:ref,adoption:{actor:d.adoptedDesign.actor,basis:`设计采用记录${d.adoptedDesign.version}明确采用参考图`,at:d.adoptedDesign.createdAt}}))),...rows.filter((r:Row)=>r.schema==='ASSET_IMAGE_JOB_V1').flatMap((job:Row)=>(job.images??[]).map((image:Row)=>({assetKey:job.key,state:'candidate_pending_user',image,jobId:job.id,note:'任务图片与USED状态不自动等于用户设计采用；采用参考图按上方独立记录。'})))];
 return {designs,images};
}
export async function seasonClosingTemplate(projectId:string,actorId:string,workflowId:string,db:Db=prisma){
 await access(db,projectId,actorId);const season=await requireSeasonProduction(projectId,undefined,'export',db);if(!season)fail('本项目未启用季范围。');
 const evidence=await actualEvidence(projectId,actorId,workflowId,db);if(evidence.exportManifest.seasonDelivery?.mode!=='final')fail('先完成final整季导出，再核对实际收口。');
 const actual=seasonDelivery(season.scope,season.basis,evidence.runs,'final'),designs=designSnapshot(evidence).designs,last=evidence.runs.at(-1);
 return {workflowId,scopeHash:season.scopeHash,exportIdentity:evidence.exportManifest.identity,actual,assets:designs.map((d:Row)=>({...d,name:evidence.assets.find((a:Row)=>a.id===d.stableId)?.name,type:evidence.assets.find((a:Row)=>a.id===d.stableId)?.type,adoptedDesign:undefined})),sourceRefs:last.source.sourceRows.map((r:Row)=>({id:r.id,text:r.text??'',sceneKey:r.seasonSceneKey??r.sceneKey??last.source.seasonSceneMap?.[r.id]??null})),template:{states:[],stateBasis:'',openHooks:[{text:'',sourceRefs:[]}],deferred:[],unresolved:[]}};
}
function continuity(value:Row,result:Row,evidence:Row,actorId:string,note:string){
 if(!value||!Array.isArray(value.states)||!Array.isArray(value.openHooks)||!value.openHooks.length||!Array.isArray(value.deferred)||!Array.isArray(value.unresolved)||value.unresolved.length)fail('实际尾态需人物状态、原生未兑现钩子、延后项及无未决冲突；不能以计划包替代。');
 const designs=designSnapshot(evidence).designs;
 const sourceIds=new Set(evidence.runs.flatMap((r:Row)=>r.source.sourceRows.map((s:Row)=>s.id))),assetIds=new Set(evidence.assets.map((a:Row)=>a.id));
 const refs=(list:unknown)=>Array.isArray(list)&&list.length&&list.every((id:unknown)=>typeof id==='string'&&sourceIds.has(id));
 for(const s of value.states)if(!assetIds.has(s.assetId)||!Number.isSafeInteger(s.designVersion)||!designs.some((d:Row)=>d.stableId===s.assetId&&d.designVersion===s.designVersion)||!['position','emotion'].every(k=>typeof s[k]==='string'&&s[k].trim())||!['knowledge','heldProps','injuries'].every(k=>Array.isArray(s[k])&&s[k].every((v:unknown)=>typeof v==='string'))||!s.heldProps.every((id:string)=>evidence.assets.some((a:Row)=>a.id===id&&a.type==='PROP'))||!refs(s.sourceRefs))fail('人物尾态缺实际资产/设计版本、位置、情绪、知情、持物、伤势或有效源锚。');
 if(!value.states.length&&!(typeof value.stateBasis==='string'&&value.stateBasis.trim()))fail('无人末场也须说明已核对的状态依据。');
 for(const h of value.openHooks)if(typeof h.text!=='string'||!h.text.trim()||!refs(h.sourceRefs))fail('实际未兑现钩子必须有采用稿中已有源锚。');
 return {...value,version:'series-season-continuity-v1',scopeHash:result.scopeHash,tail:result.tail,review:{kind:'user',actorId,basis:note,at:new Date().toISOString()}};
}
export async function closeSeasonHandoff(projectId:string,actorId:string,command:Row,db:PrismaClient=prisma,loadEvidence=actualEvidence){
 if(command.confirmed!==true||typeof command.note!=='string'||!command.note.trim())fail('须明确确认已核对完整采用稿及实际季终，并记录采用依据。');
 await access(db,projectId,actorId);const season=await requireSeasonProduction(projectId,undefined,'export',db);if(!season)fail('旧无分季模式项目不自动转换为闭季项目。');
 const evidence=jsonSafe(await loadEvidence(projectId,actorId,command.workflowId,db));
 if(command.expectedExportIdentity!==undefined&&command.expectedExportIdentity!==evidence.exportManifest.identity)fail('核对尾态后实际采用导出已变化，请重新载入证据。');
 if(evidence.exportManifest.seasonDelivery?.mode!=='final')fail('实际closed收口必须先完成原生final整季导出；preview不等于最终采用交付。');
 if(evidence.exportManifest.projectId!==projectId||evidence.workflow.projectId!==projectId||evidence.exportManifest.identity!==evidence.workflow.delivery?.result?.identity||evidence.exportManifest.seasonDelivery?.scopeHash!==season.scopeHash)fail('实际导出/工作流与本季冻结范围不一致。');
 const result=seasonDelivery(season.scope,season.basis,evidence.runs,'final'),actualContinuity=continuity(command.continuity,result,evidence,actorId,command.note);
 const last=evidence.runs.at(-1);if(result.tail.episode!==season.scope.ending.episode||!last.assembly?.text||!last.adopted?.length)fail('尚无实际采用季终末稿，不以计划季终闭季。');
 const id=randomUUID(),adoption={kind:'user',actorId,basis:command.note,at:new Date().toISOString()};
 const payload={version:SEASON_HANDOFF_VERSION,id,kind:'closed',projectId,productionScope:season.scope,scopeHash:season.scopeHash,source:{sourceHash:season.basis.sourceHash,sourceVersion:season.basis.sourceVersion,bodyHash:season.basis.bodyHash,compatibility:seasonSourceCompatibility(season.basis)},actual:result,continuity:actualContinuity,adoption,adoptedStoryboard:evidence.adoptedStoryboard,adoptedStoryboardHash:hash(evidence.adoptedStoryboard),exportManifest:evidence.exportManifest,registry:{assets:evidence.assets,...designSnapshot(evidence),snapshots:evidence.snapshots.map((s:Row)=>({id:s.id,sceneKey:s.sceneKey,content:parse(s.content)}))},resume:resumeFor(season.scope,season.basis,id),evidence:{workflowId:evidence.workflow.id,selectedRuns:evidence.workflow.selectedRuns,runHashes:Object.fromEntries(evidence.runs.map((r:Row)=>[r.id,seasonHash(r)])),assetHashes:Object.fromEntries(evidence.assets.map((a:Row)=>[a.id,seasonHash(a)])),snapshotHashes:Object.fromEntries(evidence.snapshots.map((s:Row)=>[s.id,hash(s.content)]))},createdAt:new Date().toISOString(),limitations:['closed表示实际文字采用与引用通过核验，不代表视频成片或用户图像采用。','设计采用记录与图片任务分别保留；图片候选不能凭文件完整或USED状态自动当作用户采用。','新季须另行明确启动、校验本closed记录并从下一未制作原集开始。','跨源追加稿与旧资产库自动迁移未支持；新源另行接入核对并保留继承映射。']};
 const record={...payload,identity:seasonHash(payload)};
 await verifyCurrentEvidence(record,db,loadEvidence);
 await db.$transaction(async tx=>{await access(tx,projectId,actorId);const current=await requireSeasonProduction(projectId,undefined,'export',tx);if(current?.scopeHash!==season.scopeHash)fail('保存闭季时范围变化。');await tx.sceneSnapshot.create({data:{id,projectId,sceneKey:KEY,title:'实际采用季终与续季对接（closed）',content:JSON.stringify(record)}});},{timeout:20000});
 return record;
}
async function verifyCurrentEvidence(record:Row,db:Db,loadEvidence=actualEvidence){
 const source=await seasonSourceBasis(record.projectId,db);if(source.basis.sourceVersion!==record.source.sourceVersion||seasonSourceCompatibility(source.basis)!==record.source.compatibility)fail('上季闭季后源稿/集场变化，保留旧包，未启动续季。','SEASON_CONTINUATION');
 const store=stores(),workflow=await store.workflows.read(record.evidence.workflowId);if(seasonHash(workflow.selectedRuns)!==seasonHash(record.evidence.selectedRuns)||workflow.delivery?.result?.identity!==record.exportManifest.identity)fail('上季实际采用流程已变化。','SEASON_CONTINUATION');
 for(const [id,digest] of Object.entries(record.evidence.runHashes))if(seasonHash(await store.runs.read(id))!==digest)fail('上季采用末稿/镜头记录已变化，不能凭旧hash续季。','SEASON_CONTINUATION');
 for(const [id,digest] of Object.entries(record.evidence.assetHashes)){const asset=await db.asset.findUnique({where:{id}});if(!asset||seasonHash(jsonSafe(asset))!==digest)fail('上季稳定资产版本已变化。','SEASON_CONTINUATION');}
 for(const [id,digest] of Object.entries(record.evidence.snapshotHashes)){const snapshot=await db.sceneSnapshot.findUnique({where:{id}});if(!snapshot||hash(snapshot.content)!==digest)fail('上季设计/图像记录已变化。','SEASON_CONTINUATION');}
 // Re-read the native export adapter on every continuation. A copied hash or
 // unchanged run does not establish that its referenced delivered bytes survive.
 const current=await loadEvidence(record.projectId,record.adoption.actorId,record.evidence.workflowId,db);
 if(current.exportManifest.seasonDelivery?.mode!=='final'||seasonHash(current.exportManifest)!==seasonHash(record.exportManifest)||hash(current.adoptedStoryboard)!==record.adoptedStoryboardHash)fail('上季实际final导出或引用文件已变化，不能沿用旧closed记录。','SEASON_CONTINUATION');
}
export async function verifyPreviousSeasonHandoff(projectId:string,closedId:string,db:Db=prisma){
 const record=await readSeasonHandoff(projectId,closedId,db);if(record.kind!=='closed'||record.resume.closedId!==record.id||record.resume.nextEpisode===null)fail('续季需要真实closed包与下一未制作原集；planned或源已结束不可启动。','SEASON_CONTINUATION');
 await verifyCurrentEvidence(record,db);return record;
}
