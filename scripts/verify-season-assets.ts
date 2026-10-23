/** Real services and temporary SQLite; synthetic runner/images only, no provider or worker process. */
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
const repository=process.cwd();let directory:string,db:any,season:any,prompts:any,facts:any,jobs:any,adoptions:any,automation:any,foundation:any,documents:any,actor:any;
const digest=(v:any)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
before(async()=>{
 directory=mkdtempSync(path.join(tmpdir(),'season-assets-'));const file=path.join(directory,'test.db'),sql=new DatabaseSync(file);
 for(const x of readdirSync(path.join(repository,'prisma/migrations')).sort())if(/^\d/.test(x))sql.exec(readFileSync(path.join(repository,'prisma/migrations',x,'migration.sql'),'utf8'));sql.close();
 process.env.DATABASE_URL=`file:${file}`;process.env.DIRECTOR_ASSET_REFERENCE_DIR=path.join(directory,'references');process.env.CODEX_CLI_PATH='/__offline_no_production__';process.env.DEEPSEEK_API_KEY='';
 db=(await import('../lib/prisma')).prisma;season=await import('../lib/season-scope-service');prompts=await import(process.env.SEASON_ASSET_PROMPT_TEST_MODULE??'../lib/asset-prompt-service');facts=await import('../lib/asset-visual-facts-service');jobs=await import('../lib/asset-image-job-service');adoptions=await import('../lib/asset-design-adoption');automation=await import('../lib/asset-prompt-automation');foundation=await import('../lib/foundation-state');documents=await import('../lib/foundation-document');
 symlinkSync(path.join(repository,'prompts'),path.join(directory,'prompts'),'dir');process.chdir(directory);
 actor=await db.user.create({data:{username:'season-assets',email:'season-assets@synthetic.invalid',passwordHash:'offline'}});
});
after(async()=>{await db?.$disconnect();process.chdir(repository);if(directory)rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
async function fixture(mode:'locked'|'draft'|'legacy'='locked'){
 const p=await db.project.create({data:{title:'isolated season assets',roles:{create:{userId:actor.id,role:'ADMIN'}},episodes:{create:[{number:5,content:'5-1 房间 日 内\n甲穿白衣，握着铁钥匙。'},{number:2,content:'2-1 门厅 夜 内\n甲换蓝衣，开门见乙。'},{number:9,content:'9-1 未来高台 夜 外\n甲穿未来王冠服装，未来父形态出现。'}]}}});
 const eps=await db.episode.findMany({where:{projectId:p.id}});let offset=0;
 for(const n of [5,2,9]){const ep=eps.find((e:any)=>e.number===n);await db.scriptScene.create({data:{episodeId:ep.id,sceneKey:`${n}-1`,sortOrder:1,sourceText:ep.content}});}
 const ordered=[5,2,9].map(n=>eps.find((e:any)=>e.number===n));
 await db.sceneSnapshot.create({data:{projectId:p.id,sceneKey:'SOURCE_IMPORT',metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'}),content:JSON.stringify({sourceText:ordered.map(e=>e.content).join(''),originalFile:{encoding:'base64',base64:Buffer.from('synthetic-full-source').toString('base64')},sourceStructure:{version:'SOURCE_STRUCTURE_V1',sections:ordered.map(e=>{const start=offset;offset+=e.content.length;return {key:`ep${e.number}`,kind:'EPISODE',episodeNumber:e.number,start,end:offset};}),issues:[]}})}});
 let locked:any;
 if(mode!=='legacy'){
  const {basis}=await season.seasonSourceBasis(p.id);locked={version:'series-season-scope-v1',id:'S01',revision:1,seasonNumber:1,status:'locked',sourceVersion:basis.sourceVersion,sourceHash:basis.sourceHash,readingEpisodes:[5,2,9],episodeNumbers:[5,2],target:{minSeconds:7200,maxSeconds:9000,planningSeconds:8100},ending:{episode:2,sceneKey:'2-1',endLine:2,closure:'本季冲突兑现',hook:'原生追问',sourceRefs:[{episode:2,startLine:1,endLine:2}],timeline:[5,2].map(episode=>({episode,startLine:1,endLine:2,speech:{min:3600,max:3800},action:{min:100,max:200},overlap:{min:100,max:100},transition:{min:0,max:0},basis:'合成逐句与同期动作'})),assetBurden:{characters:[],locations:[],costumes:[],forms:[],props:[]}},confirmation:{kind:'delegated',basis:'synthetic fixture only',actorId:actor.id,at:'2026-10-23T00:00:00Z'}};
  await db.sceneSnapshot.create({data:{id:`production-season-${p.id}`,projectId:p.id,sceneKey:'PRODUCTION_SEASON_SCOPE_V1',content:JSON.stringify({mode:'season',revision:1,status:mode,basis,scope:mode==='locked'?locked:null})}});
 }
 const input=await foundation.loadFoundationInputs(p.id),doc=documents.createEmptyDocument(input),ref=(episode:number)=>[{episode,sceneKey:`${episode}-1`}];
 doc.workflow='LIGHT_STAGE1_V1';doc.editorialCoverage=mode==='locked'?[5,2]:[5,2,9];
 doc.f2={format:'ASSET_CATALOG_V1',coverage:doc.editorialCoverage,issues:[],assets:[{key:'hero',name:'甲',type:'CH',aliases:[],description:'',sourceRefs:[],appearances:[],usageEpisodes:[5,2],sceneRefs:ref(5),preparation:{mode:'REFERENCE'},variants:[{key:'future-form',name:'未来王冠服装',episodes:[5,9],sceneRefs:ref(9),note:'',preparation:{mode:'DERIVE',fromKey:'hero'}}]},{key:'future-parent',name:'未来父形态',type:'CH',aliases:[],description:'',sourceRefs:[],appearances:[],usageEpisodes:[9],sceneRefs:ref(9),preparation:{mode:'REFERENCE'},variants:[]}],episodes:[{number:5,context:'',assetKeys:['hero']},{number:2,context:'',assetKeys:['hero']},{number:9,context:'',assetKeys:['future-form','future-parent']}]};
 const row=await db.sceneSnapshot.create({data:{projectId:p.id,sceneKey:'FOUNDATION_DOCUMENT',content:JSON.stringify(doc)}});
 return {p:p.id,locked,doc,row,input};
}
async function createJob(p:string){await prompts.saveAssetPrompt(p,'hero',0,'甲穿白衣，黑发，完整体态。');const w=await prompts.loadAssetPromptWorkspace(p);assert.ok(w.assets.find((a:any)=>a.key==='hero')?.eligible,JSON.stringify(w.assets.map((a:any)=>[a.key,a.reasons])));return jobs.createImageJob(p,actor.id,{key:'hero',expectedPromptRevision:1,expectedStyleRevision:w.styleRevision,expectedOptionsRevision:0,episodeNumbers:[5]},'CHROME');}
async function changeJob(id:string,change:(job:any)=>void){const row=await db.sceneSnapshot.findUniqueOrThrow({where:{id}}),job=JSON.parse(row.content);change(job);await db.sceneSnapshot.update({where:{id},data:{content:JSON.stringify(job)}});return job;}
async function image(){const bytes=await sharp({create:{width:2,height:2,channels:4,background:'#fafafa'}}).png().toBuffer();return new File([new Uint8Array(bytes)],'synthetic.png',{type:'image/png'});}

test('draft blocks raw writes, facts and automation before any row or worker is created',async()=>{
 const {p}=await fixture('draft');let calls=0,spawns=0;
 for(const action of [()=>prompts.saveAssetStyle(p,'new style',0),()=>prompts.saveAssetPrompt(p,'hero',0,'manual'),()=>prompts.generateAssetPrompt(p,'hero',0,async()=>{calls++;throw new Error('must not call');}),()=>facts.ensureAssetVisualFacts(p,async()=>{calls++;throw new Error('must not call');}),()=>adoptions.adoptAssetDesign(p,actor.id,{assetKey:'hero',expectedRevision:0,expectedMaterialToken:'unknown',brief:'draft',referenceIds:[]}),()=>automation.launchAssetPromptAutomation(p,'source',{db,spawnWorker:()=>{spawns++;return {once(){}};}})])await assert.rejects(action,{code:'SEASON_NOT_LOCKED'});
 assert.equal(calls,0);assert.equal(spawns,0);assert.equal(await db.sceneSnapshot.count({where:{projectId:p,sceneKey:{in:['ASSET_PROMPT_AUTOMATION_V1','ASSET_PROMPT_V1','ASSET_DESIGN_ADOPTION_V1']}}}),0);
});
test('a missing season pointer with retained history cannot downgrade new asset writes to legacy',async()=>{
 const {p}=await fixture();await db.sceneSnapshot.create({data:{projectId:p,sceneKey:'PRODUCTION_SEASON_SCOPE_HISTORY_V1',content:JSON.stringify({mode:'season'})}});await db.sceneSnapshot.delete({where:{id:`production-season-${p}`}});
 await assert.rejects(()=>prompts.saveAssetPrompt(p,'hero',0,'must not become legacy'),/指针|降级|恢复|范围/);
 await assert.rejects(()=>jobs.createImageJob(p,actor.id,{key:'hero',expectedPromptRevision:0,expectedStyleRevision:0,expectedOptionsRevision:0,episodeNumbers:[5]}),/指针|降级|恢复|范围/);
 assert.equal(await db.sceneSnapshot.count({where:{projectId:p,sceneKey:{in:['ASSET_PROMPT_V1','ASSET_IMAGE_JOB_V1']}}}),0);
});
test('omitted facts scope still excludes future form with a misleading current episode number',async()=>{
 const {p}=await fixture(),sent:any[]=[];
 const result=await facts.ensureAssetVisualFacts(p,async(input:any)=>{const v=JSON.parse(input.prompt);sent.push(v);const data={batches:v.chunks.map((c:any)=>({coveredChunkId:c.id,facts:[],issues:[]}))};return {data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null};});
 assert.ok(sent.length);assert.ok(sent.every(v=>v.chunks.every((c:any)=>c.domain!=='EPISODE'||[5,2].includes(c.episode))));
 assert.ok(!JSON.stringify(sent).includes('未来王冠服装'),'future form sceneRefs, not episodes/name, control permission');assert.ok(!JSON.stringify(sent).includes('未来父形态'));assert.equal(result.complete,true);
});
test('facts checks the frozen scope after an awaited continuation callback',async()=>{
 const {p}=await fixture();let calls=0,checks=0;
 await assert.rejects(()=>facts.ensureAssetVisualFacts(p,async(input:any)=>{calls++;const v=JSON.parse(input.prompt);return {data:{batches:v.chunks.map((c:any)=>({coveredChunkId:c.id,facts:[],issues:[]}))},stdout:'',stderr:'',sessionId:null};},{shouldContinue:async()=>{if(++checks===2){const row=await db.sceneSnapshot.findUniqueOrThrow({where:{id:`production-season-${p}`}}),value=JSON.parse(row.content);value.scope=null;value.status='draft';await db.sceneSnapshot.update({where:{id:row.id},data:{content:JSON.stringify(value)}});}return true;}}),/尚未选定|锁定|未锁/);
 assert.equal(calls,0,'a continuation callback may yield while the scope changes; no runner dispatch afterward');
});
test('a returned prompt stays as a failed original-scope receipt when scope changes in flight',async()=>{
 const {p}=await fixture(),original=await season.requireSeasonProduction(p,[5],'assets');
 await facts.ensureAssetVisualFacts(p,async(input:any)=>{const v=JSON.parse(input.prompt);return {data:{batches:v.chunks.map((c:any)=>({coveredChunkId:c.id,facts:[],issues:[]}))},stdout:'',stderr:'',sessionId:null};});
 const marker='RETURNED_RAW_REVIEW_ONLY_'+randomUUID();let calls=0;
 const response=await prompts.generateAssetPrompt(p,'hero',0,async()=>{calls++;const row=await db.sceneSnapshot.findUniqueOrThrow({where:{id:`production-season-${p}`}}),v=JSON.parse(row.content);v.scope=null;v.status='draft';await db.sceneSnapshot.update({where:{id:row.id},data:{content:JSON.stringify(v)}});return {data:{key:'hero',body:'合法回包保留，不能自动采用。',suggestions:''},rawOutput:marker,stdout:'',stderr:'',sessionId:null,usage:{inputTokens:1,outputTokens:1,totalTokens:2}};}).catch((error:any)=>({error}));
 const rows=await db.sceneSnapshot.findMany({where:{projectId:p}});assert.equal(calls,1);assert.ok(rows.some((row:any)=>row.content.includes(marker)),'returned raw must survive a failed current-scope production check');
 const record=JSON.parse(rows.find((row:any)=>row.sceneKey==='ASSET_PROMPT_V1'&&row.title==='hero').content);assert.equal(record.status,'FAILED');assert.equal(record.body,'');assert.equal(record.rawOutput,marker);assert.equal(response.status,'FAILED');
 const receipt=JSON.parse(rows.find((row:any)=>row.sceneKey==='ASSET_PROMPT_ATTEMPT_V1').content);assert.equal(receipt.scopeHash,original.scopeHash);assert.equal(receipt.requestOutcome,'RESPONDED');assert.equal(receipt.adopted,false);assert.equal(receipt.usage.totalTokens,2);assert.equal(receipt.rawOutput,marker);
});
for(const boundary of ['read','write'])test(`automation rechecks scope at the ${boundary} boundary before spawning`,async()=>{
 const {p}=await fixture();let spawns=0,changed=false;
 const invalidate=async()=>{const row=await db.sceneSnapshot.findUniqueOrThrow({where:{id:`production-season-${p}`}}),v=JSON.parse(row.content);v.scope=null;v.status='draft';await db.sceneSnapshot.update({where:{id:row.id},data:{content:JSON.stringify(v)}});};
 const snapshots=new Proxy(db.sceneSnapshot,{get(target,key){if(key==='findUnique')return async(args:any)=>{const value=await db.sceneSnapshot.findUnique(args);if(boundary==='read'&&!changed&&String(args.where.id).startsWith('apjob_')){changed=true;await invalidate();}return value;};if(key==='create')return async(args:any)=>{const value=await db.sceneSnapshot.create(args);if(boundary==='write'&&!changed&&args.data.sceneKey==='ASSET_PROMPT_AUTOMATION_V1'){changed=true;await invalidate();}return value;};return Reflect.get(target,key);}});
 const proxy=new Proxy(db,{get(target,key){return key==='sceneSnapshot'?snapshots:Reflect.get(target,key);}});
 await assert.rejects(()=>automation.launchAssetPromptAutomation(p,'synthetic-source',{db:proxy,spawnWorker:()=>{spawns++;return {once(){}};}}),{code:'SEASON_NOT_LOCKED'});
 assert.equal(spawns,0);const row=await db.sceneSnapshot.findFirst({where:{projectId:p,sceneKey:'ASSET_PROMPT_AUTOMATION_V1'}});assert.equal(row?JSON.parse(row.content).status:null,boundary==='read'?null:'FAILED');
});
test('current production workspace and adoption list exclude historical future records',async()=>{
 const {p}=await fixture();
 await db.sceneSnapshot.create({data:{id:'ap15_'+digest([p,'future-form']).slice(0,40),projectId:p,sceneKey:'ASSET_PROMPT_V1',content:JSON.stringify({schema:'ASSET_PROMPT_V1',key:'future-form',revision:1,status:'READY',body:'historical future',facts:'',suggestions:'',origin:'MANUAL',fingerprint:'old'})}});
 await db.sceneSnapshot.create({data:{id:'adopt_'+digest([p,'future-form']).slice(0,40),projectId:p,sceneKey:'ASSET_DESIGN_CURRENT_V1',content:JSON.stringify({schema:'ASSET_DESIGN_CURRENT_V1',assetKey:'future-form',revision:1,currentVersion:null})}});
 const w=await prompts.loadAssetPromptWorkspace(p);assert.deepEqual(w.assets.map((a:any)=>a.key),['hero']);assert.equal(w.records['future-form'],undefined);
 assert.equal((await adoptions.readAssetDesignAdoptions(p,actor.id)).assets['future-form'],undefined);
 await assert.rejects(()=>prompts.saveAssetPrompt(p,'future-form',1,'new future'));await assert.rejects(()=>prompts.generateAssetPrompt(p,'future-form',1,async()=>{throw new Error('must not call');}));
});
test('old queues cannot omit episode fields or frozen scope when claimed, imported or handed off',async()=>{
 const {p}=await fixture();const job=await createJob(p);await changeJob(job.id,j=>delete j.episodeNumbers);
 await assert.rejects(()=>jobs.claimImageJob(p,actor.id,job.id,job.revision),/季|范围|集数/);
 await changeJob(job.id,j=>{j.episodeNumbers=[5];delete j.seasonScopeHash;});
 await assert.rejects(()=>jobs.readImageHandoff(p,actor.id,job.id),/季|范围/);
 const png=await image();await assert.rejects(()=>jobs.importImageJob(p,actor.id,job.id,job.revision,[png]),/季|范围/);
 assert.equal(JSON.parse((await db.sceneSnapshot.findUniqueOrThrow({where:{id:job.id}})).content).status,'WAITING_EXECUTOR');
});
test('production job and executor lists exclude future-only or stale frozen historical queues',async()=>{
 const {p}=await fixture();const job=await createJob(p),row=await db.sceneSnapshot.findUniqueOrThrow({where:{id:job.id}}),historical=JSON.parse(row.content);historical.id=randomUUID();historical.key='future-form';historical.keys=['future-form'];historical.episodeNumbers=[9];
 await db.sceneSnapshot.create({data:{id:historical.id,projectId:p,sceneKey:'ASSET_IMAGE_JOB_V1',title:historical.key,content:JSON.stringify(historical)}});
 assert.deepEqual((await jobs.listImageJobs(p,actor.id)).jobs.map((j:any)=>j.id),[job.id]);assert.deepEqual((await jobs.listExecutorImageJobs()).filter((j:any)=>j.projectId===p).map((j:any)=>j.id),[job.id]);
 await changeJob(job.id,j=>j.seasonScopeHash='b'.repeat(64));assert.deepEqual((await jobs.listImageJobs(p,actor.id)).jobs,[]);
});
test('repeated image creation cannot reuse an active row whose frozen scope was removed',async()=>{
 const {p}=await fixture();const job=await createJob(p);await changeJob(job.id,j=>delete j.seasonScopeHash);
 await assert.rejects(()=>jobs.createImageJob(p,actor.id,{key:'hero',expectedPromptRevision:1,expectedStyleRevision:0,expectedOptionsRevision:0,episodeNumbers:[5]},'CHROME'),/季|范围/);
 assert.equal(await db.sceneSnapshot.count({where:{projectId:p,sceneKey:'ASSET_IMAGE_JOB_V1'}}),1);
});
test('valid manual import remains available, but adoption rejects later scope drift',async()=>{
 const {p}=await fixture();const job=await createJob(p),review=await jobs.importImageJob(p,actor.id,job.id,job.revision,[await image()]);assert.equal(review.status,'REVIEW');
 await changeJob(job.id,j=>j.seasonScopeHash='b'.repeat(64));
 await assert.rejects(()=>jobs.useImageJobResult(p,actor.id,job.id,review.images[0].id,review.revision,0),/季|范围/);
 assert.equal(JSON.parse((await db.sceneSnapshot.findUniqueOrThrow({where:{id:job.id}})).content).usedImageIds.length,0);
});
test('an in-season job can claim, hand off, import and adopt through the real services',async()=>{
 const {p}=await fixture();const job=await createJob(p),claim=await jobs.claimImageJob(p,actor.id,job.id,job.revision);
 const handoff=await jobs.readImageHandoff(p,actor.id,job.id);assert.deepEqual(handoff.episodeNumbers,[5]);assert.equal(handoff.key,'hero');
 const review=await jobs.importImageJob(p,actor.id,job.id,claim.job.revision,[await image()],claim.claimToken);
 const used=await jobs.useImageJobResult(p,actor.id,job.id,review.images[0].id,review.revision,0);assert.deepEqual(used.usedImageIds,[review.images[0].id]);
});
test('a selected variant cannot dispatch a future-only parent via dependency expansion',async()=>{
 const f=await fixture();f.doc.f2.assets[0].preparation={mode:'DERIVE',fromKey:'future-parent'};
 await db.sceneSnapshot.update({where:{id:f.row.id},data:{content:JSON.stringify(f.doc)}});
 await assert.rejects(()=>prompts.planEpisodeAssetProduction(f.p,[5]),/来源|本季|范围/);
});
test('scoped material automation rechecks the season before entering its candidate executor',async()=>{
 const {p}=await fixture();let calls=0;
 await assert.rejects(()=>prompts.generateAssetPromptsForEpisodes(p,[5],{assetKeys:['hero'],materialNeeds:[],runner:async()=>{calls++;throw new Error('must not dispatch');},shouldContinue:async()=>{const row=await db.sceneSnapshot.findUniqueOrThrow({where:{id:`production-season-${p}`}}),value=JSON.parse(row.content);value.scope=null;value.status='draft';await db.sceneSnapshot.update({where:{id:row.id},data:{content:JSON.stringify(value)}});return true;}}),{code:'SEASON_NOT_LOCKED'});
 assert.equal(calls,0);assert.equal(await db.sceneSnapshot.count({where:{projectId:p,sceneKey:'ASSET_MATERIAL_CANDIDATE_V1'}}),0);
});
test('legacy projects still save manual design and obtain unscoped production workspace',async()=>{
 const {p}=await fixture('legacy');await prompts.saveAssetStyle(p,'legacy style',0);const saved=await prompts.saveAssetPrompt(p,'hero',0,'legacy manual');assert.equal(saved.status,'READY');assert.ok((await prompts.loadAssetPromptWorkspace(p)).assets.some((a:any)=>a.key==='future-form'));
});
