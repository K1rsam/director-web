import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {registerHooks} from 'node:module';
const hooks=registerHooks({resolve(s,c,next){return next(s==='server-only'?'next/dist/compiled/server-only/empty.js':s,c);}});
import {DatabaseSync} from 'node:sqlite';
import {PrismaClient} from '@prisma/client';
let db:PrismaClient,directory:string,userId:string;
let m:any;
before(async()=>{directory=mkdtempSync(path.join(tmpdir(),'season-service-'));const file=path.join(directory,'test.db'),sql=new DatabaseSync(file);for(const x of readdirSync('prisma/migrations').sort())if(/^\d/.test(x))sql.exec(readFileSync(path.join('prisma/migrations',x,'migration.sql'),'utf8'));sql.close();process.env.DATABASE_URL=`file:${file}`;process.env.CODEX_CLI_PATH='/__offline_no_production__';process.env.DEEPSEEK_API_KEY='';db=new PrismaClient({datasourceUrl:process.env.DATABASE_URL});userId=(await db.user.create({data:{username:'season-test',email:'season@synthetic.invalid',passwordHash:'offline'}})).id;m=await import('../lib/season-scope-service').catch(()=>({}));});
after(async()=>{hooks.deregister();await db?.$disconnect();if(directory)rmSync(directory,{recursive:true,force:true,maxRetries:6,retryDelay:100});});
async function fixture(){const project=await db.project.create({data:{title:'synthetic season',roles:{create:{userId,role:'ADMIN'}},episodes:{create:[{number:5,content:'5-1 门外\n甲：原话。'},{number:2,content:'2-1 室内\n乙：原句。'},{number:9,content:'9-1 后山\n未来服装。'}]}}});for(const n of [5,2,9]){const ep=await db.episode.findFirstOrThrow({where:{projectId:project.id,number:n}});await db.scriptScene.create({data:{episodeId:ep.id,sceneKey:`${n}-1`,sortOrder:1,sourceText:ep.content}});}await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',content:JSON.stringify({sourceText:'完整原稿包含三集',originalFile:{encoding:'base64',base64:Buffer.from('synthetic-original').toString('base64')},sourceStructure:{sections:[5,2,9].map(episodeNumber=>({kind:'EPISODE',episodeNumber}))}})}});return project.id;}
const timeline=(n:number)=>({episode:n,startLine:1,endLine:2,speech:{min:3600,max:3800},action:{min:100,max:200},overlap:{min:100,max:100},transition:{min:0,max:0},basis:'逐句原声和同期动作共同时间线；合成fixture秒数'});
const burden={characters:[],locations:[],costumes:[],forms:[],props:[]};
test('opt in is explicit, CAS source-bound and old no-mode projects retain full scope',async()=>{assert.equal(typeof m.mutateSeasonScope,'function','season service is absent');const p=await fixture();assert.equal((await m.readSeasonState(p,db)).mode,'legacy');let s=await m.mutateSeasonScope(p,userId,{action:'enable',expectedRevision:0},db);assert.equal(s.mode,'season');assert.deepEqual(s.basis.episodes.map((e:any)=>e.number),[5,2,9]);await assert.rejects(m.mutateSeasonScope(p,userId,{action:'enable',expectedRevision:0},db),/更新|变化/);await assert.rejects(m.mutateSeasonScope(p,'unknown',{action:'enable',expectedRevision:s.revision},db),/无权|需要/);});
test('light full read proposes candidates before assets and user locks server-owned candidate',async()=>{assert.equal(typeof m.generateSeasonCandidates,'function','season candidate entry is absent');const p=await fixture();let s=await m.mutateSeasonScope(p,userId,{action:'enable',expectedRevision:0},db),calls:any[]=[];const runner=async(r:any)=>{const input=JSON.parse(r.prompt.slice(r.prompt.indexOf('INPUT_JSON:')+11));calls.push(input);return {data:input.phase==='read'?{segments:input.parts.flatMap((p:any)=>[timeline(p.episode)]),notes:'全读源稿三集，先回报后留后续钩子'}:{candidates:[2,9].map(episode=>({episode,closure:'本段阶段目标兑现',hook:'后续原生追问',sourceRefs:[{episode,startLine:1,endLine:2}],assetBurden:burden})),insufficientReason:null},rawOutput:'synthetic',usage:{totalTokens:0}};};s=await m.generateSeasonCandidates(p,userId,{expectedRevision:s.revision,costAcknowledged:true},db,runner);assert.equal(calls[0].phase,'read');assert.deepEqual(calls[0].parts.map((p:any)=>p.episode),[5,2,9]);assert.equal(s.candidates.length,2);assert.equal(await db.asset.count({where:{projectId:p}}),0);const locked=await m.mutateSeasonScope(p,userId,{action:'lock',expectedRevision:s.revision,candidateId:s.candidates[0].id,confirmed:true},db);assert.equal(locked.scope.status,'locked');assert.deepEqual(locked.scope.episodeNumbers,[5,2]);assert.equal(locked.scope.confirmation.actorId,userId);assert.equal(locked.scope.confirmation.kind,'user');await assert.rejects(m.mutateSeasonScope(p,userId,{action:'lock',expectedRevision:locked.revision,candidateId:'arbitrary',confirmed:true},db));const source=await db.sceneSnapshot.findFirstOrThrow({where:{projectId:p,sceneKey:'SOURCE_IMPORT'}});const body=JSON.parse(source.content);body.sourceText+='追加新版本';await db.sceneSnapshot.update({where:{id:source.id},data:{content:JSON.stringify(body)}});await assert.rejects(m.requireSeasonProduction(p,[5],'assets',db),/版本|hash|原文/);});
test('unknown dispatch cannot be repeated; responded invalid data is recovered without a second model call',async()=>{
 const p=await fixture();let s=await m.mutateSeasonScope(p,userId,{action:'enable',expectedRevision:0},db),calls=0;
 await assert.rejects(m.generateSeasonCandidates(p,userId,{expectedRevision:s.revision,costAcknowledged:true},db,async()=>{calls++;throw Object.assign(new Error('sent but outcome unknown'),{requestOutcome:'UNKNOWN'});}));
 s=await m.readSeasonState(p,db);await assert.rejects(m.generateSeasonCandidates(p,userId,{expectedRevision:s.revision,costAcknowledged:true},db,async()=>{calls++;throw new Error('must not dispatch');}));assert.equal(calls,1);
 const p2=await fixture();s=await m.mutateSeasonScope(p2,userId,{action:'enable',expectedRevision:0},db);let responded=0;
 const invalid=async()=>{responded++;return {data:{segments:[],notes:'保存但格式需核'},rawOutput:'saved invalid response',usage:{totalTokens:1}};};
 await assert.rejects(m.generateSeasonCandidates(p2,userId,{expectedRevision:s.revision,costAcknowledged:true},db,invalid));s=await m.readSeasonState(p2,db);
 await assert.rejects(m.generateSeasonCandidates(p2,userId,{expectedRevision:s.revision,costAcknowledged:true},db,invalid));assert.equal(responded,1,'saved returned output must not be charged again');
});
test('draft season blocks actual asset/picture/storyboard consumers before any dispatch',async()=>{
 const p=await fixture();await m.mutateSeasonScope(p,userId,{action:'enable',expectedRevision:0},db);
 const {generateAssetPrompt}=await import('../lib/asset-prompt-service'),{createImageJob}=await import('../lib/asset-image-job-service'),{readProductionScope}=await import('../lib/production-episodes');
 let calls=0;await assert.rejects(generateAssetPrompt(p,'future',0,async()=>{calls++;throw new Error('must not dispatch');}),{code:'SEASON_NOT_LOCKED'});
 await assert.rejects(createImageJob(p,userId,{key:'future',expectedPromptRevision:0,expectedStyleRevision:0,expectedOptionsRevision:0,episodeNumbers:[9]}),{code:'SEASON_NOT_LOCKED'});
 assert.deepEqual((await readProductionScope(p,db)).episodeNumbers,[]);assert.equal(calls,0);
});
test('existing shot/unit or frozen native document prevents opting legacy project into season',async()=>{
 for(const type of ['shot','unit','native']){const p=await fixture(),ep=await db.episode.findFirstOrThrow({where:{projectId:p}}),scene=await db.scriptScene.findFirstOrThrow({where:{episodeId:ep.id}});if(type==='shot')await db.storyboardShot.create({data:{episodeId:ep.id,sceneId:scene.id,shotKey:'S1',sortOrder:1,duration:1}} as any);if(type==='unit')await db.seedanceUnit.create({data:{episodeId:ep.id,sceneId:scene.id,unitKey:'U1',sortOrder:1,duration:1,startPremise:'起点',endState:'尾态'}} as any);
  if(type==='native'){const {mkdirSync,writeFileSync}=await import('node:fs');const root=path.join(directory,'native'),folder=path.join(root,'documents');mkdirSync(folder,{recursive:true});process.env.DIRECTOR_STORYBOARD_DATA_DIR=root;writeFileSync(path.join(folder,`${p}.json`),JSON.stringify({web:{binding:{projectId:p}},operations:[]}));}
  await assert.rejects(m.mutateSeasonScope(p,userId,{action:'enable',expectedRevision:0},db),/已有详细生产|冻结|旧项目/);
 }
});
test('RESPONDED raw JSON survives receiver error and revalidates locally; NOT_SENT permits explicit retry',async()=>{
 const p=await fixture();let s=await m.mutateSeasonScope(p,userId,{action:'enable',expectedRevision:0},db),calls=0;
 await assert.rejects(m.generateSeasonCandidates(p,userId,{expectedRevision:s.revision,costAcknowledged:true},db,async()=>{calls++;throw Object.assign(new Error('CLI返回内容不是合法JSON：old receiver'),{requestOutcome:'RESPONDED',rawOutput:JSON.stringify({segments:[5,2,9].map(timeline),notes:'原生完整回包已保存'}),usage:{totalTokens:1}});}));
 const run=await db.pipelineRun.findFirstOrThrow({where:{projectId:p,stageCode:'SEASON_READ'}});assert.equal(JSON.parse(run.log!).requestOutcome,'RESPONDED');s=await m.readSeasonState(p,db);
 await assert.rejects(m.generateSeasonCandidates(p,userId,{expectedRevision:s.revision,recoverOnly:true},db,async()=>{calls++;throw new Error('no dispatch');}),{code:'SEASON_NO_SAVED_RESPONSE'});s=await m.readSeasonState(p,db);assert.equal(s.readings.length,1);assert.equal(calls,1);
 const p2=await fixture();s=await m.mutateSeasonScope(p2,userId,{action:'enable',expectedRevision:0},db);let attempts=0;
 for(let i=0;i<2;i++){await assert.rejects(m.generateSeasonCandidates(p2,userId,{expectedRevision:s.revision,costAcknowledged:true},db,async()=>{attempts++;throw Object.assign(new Error('not sent'),{requestOutcome:'NOT_SENT'});}));s=await m.readSeasonState(p2,db);}assert.equal(attempts,2);
});
test('actual text import reaches season lock before F2 and reads preserved non-episode background',async()=>{
 const {parseScriptBuffer}=await import('../lib/import-script'),{importParsedProject}=await import('../lib/workflow'),{queueFoundationDelivery}=await import('../lib/foundation-delivery'),{loadFoundationInputs}=await import('../lib/foundation-state');
 const text='前情：甲已知旧约。\n第1集\n1-1 山门 日 外\n甲：原话。\n第2集\n2-1 大殿 日 内\n乙：旧约已兑现。\n第3集\n3-1 山后 日 外\n甲：那封信是谁送的？';
 const imported=await parseScriptBuffer('synthetic.txt',Buffer.from(text)),{project}=await importParsedProject({ownerUserId:userId,title:'actual import season',sourceName:'synthetic.txt'},imported,db),p=project.id;
 let s=await m.mutateSeasonScope(p,userId,{action:'enable',expectedRevision:0},db);assert.equal(s.status,'draft');assert.ok(!s.blocker);assert.ok(s.basis.background.length);
 await assert.rejects(queueFoundationDelivery(p,{},db),{code:'SEASON_NOT_LOCKED'});assert.equal(await db.pipelineRun.count({where:{projectId:p}}),0);
 const readCalls:any[]=[];s=await m.generateSeasonCandidates(p,userId,{expectedRevision:s.revision,costAcknowledged:true},db,async(r:any)=>{const input=JSON.parse(r.prompt.slice(11));readCalls.push(input);return {data:input.phase==='read'?{segments:input.parts.filter((p:any)=>p.domain!=='BACKGROUND').map((p:any)=>({...timeline(p.episode),startLine:p.startLine,endLine:p.endLine})),notes:'已读前情及所有原集；旧约回报后原生信件悬念',backgroundCoverage:input.parts.filter((p:any)=>p.domain==='BACKGROUND').map((p:any)=>({sectionKey:p.sectionKey,startLine:p.startLine,endLine:p.endLine,notes:'前情只读，未计生产时长'}))}:{candidates:[2,3].map(n=>({episode:n,closure:'旧约兑现',hook:'信件来源未明',sourceRefs:[{episode:n,startLine:1,endLine:s.basis.episodes.find((e:any)=>e.number===n).lineCount}],assetBurden:burden})),insufficientReason:null},rawOutput:'synthetic'};});
 assert.ok(readCalls[0].parts.some((p:any)=>p.domain==='BACKGROUND'&&p.lines.some((l:any)=>l[1].includes('甲已知旧约'))));assert.equal(readCalls[1].readings,undefined,'SELECT must not repeat detailed timeline JSON');
 s=await m.mutateSeasonScope(p,userId,{action:'lock',expectedRevision:s.revision,candidateId:s.candidates[0].id,confirmed:true},db);assert.ok(s.plannedHandoffId);const input=await loadFoundationInputs(p,db);assert.deepEqual(input.sourceIndex.episodes.map(e=>e.number),[1,2]);assert.deepEqual(input.project.episodes.map(e=>e.number),[1,2]);assert.equal(await db.asset.count({where:{projectId:p}}),0);
 const task=await queueFoundationDelivery(p,{},db);assert.equal(task.status,'QUEUED');
});
test('old cached native kernel rejects seasonal create before native preparation or runner',async()=>{
 const p=await fixture();let s=await m.mutateSeasonScope(p,userId,{action:'enable',expectedRevision:0},db);
 const runner=async(r:any)=>{const input=JSON.parse(r.prompt.slice(11));return {data:input.phase==='read'?{segments:input.parts.filter((p:any)=>p.domain!=='BACKGROUND').map((p:any)=>({...timeline(p.episode),startLine:p.startLine,endLine:p.endLine})),notes:'同源轻读'}:{candidates:[2,9].map(episode=>({episode,closure:'阶段兑现',hook:'后续追问',sourceRefs:[{episode,startLine:1,endLine:2}],assetBurden:burden})),insufficientReason:null},rawOutput:'synthetic'};};
 s=await m.generateSeasonCandidates(p,userId,{expectedRevision:s.revision,costAcknowledged:true},db,runner);s=await m.mutateSeasonScope(p,userId,{action:'lock',expectedRevision:s.revision,candidateId:s.candidates[0].id,confirmed:true},db);
 const global=globalThis as any,previous=global.storyboardIntegratedV1;let preparations=0,creates=0;
 global.storyboardIntegratedV1={runtimeIdentity:()=>({maintenanceVersion:'runtime-maintenance-v1'}),withPreparation:async(fn:any)=>{preparations++;return fn();},create:async()=>{creates++;}};
 try{const {createStoryboardRun}=await import('../lib/storyboard-service'),episode=await db.episode.findFirstOrThrow({where:{projectId:p,number:5},include:{project:true}});await assert.rejects(createStoryboardRun(episode,{}),{code:'SEASON_KERNEL_RELOAD_REQUIRED'});assert.equal(preparations,0);assert.equal(creates,0);}finally{if(previous)global.storyboardIntegratedV1=previous;else delete global.storyboardIntegratedV1;}
});
test('missing current season pointer cannot downgrade a previously opted-in project to legacy',async()=>{
 const p=await fixture();await m.mutateSeasonScope(p,userId,{action:'enable',expectedRevision:0},db);await db.sceneSnapshot.delete({where:{id:`production-season-${p}`}});
 await assert.rejects(m.requireSeasonProduction(p,[5],'assets',db),{code:'SEASON_SCOPE'});assert.equal((await m.readSeasonState(p,db)).mode,'season');
 await assert.rejects(m.mutateSeasonScope(p,userId,{action:'enable',expectedRevision:0},db));
});
