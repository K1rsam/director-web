/** Real HTTP transport and worker recovery against a synthetic browser, isolated SQLite, no account calls. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtempSync,readdirSync,readFileSync,mkdirSync,writeFileSync,symlinkSync,existsSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import sharp from 'sharp';
import {pathToFileURL} from 'node:url';
import {BridgeClient,generatedTurnImages,verifyNativeImageResult,type BridgeTurn} from '../lib/image-browser-client';

async function main(){
 const repository=process.cwd(),directory=mkdtempSync(path.join(tmpdir(),'director-image-browser-'));
 process.env.DATABASE_URL=`file:${path.join(directory,'test.db')}`;process.env.DIRECTOR_ASSET_REFERENCE_DIR=path.join(directory,'references');
 const sql=new DatabaseSync(path.join(directory,'test.db'));for(const name of readdirSync(path.join(repository,'prisma/migrations')).sort())if(/^\d/.test(name))sql.exec(readFileSync(path.join(repository,'prisma/migrations',name,'migration.sql'),'utf8'));sql.close();
 for(const folder of ['prompts','runtime'])symlinkSync(path.join(repository,folder),path.join(directory,folder),process.platform==='win32'?'junction':'dir');
 const {prisma}=await import('../lib/prisma'),prompts=await import('../lib/asset-prompt-service'),jobs=await import('../lib/asset-image-job-service'),browser=await import('../lib/image-browser-service');
 const {createEmptyDocument}=await import('../lib/foundation-document'),{loadFoundationInputs}=await import('../lib/foundation-state');
 process.chdir(directory);
 const png=await sharp({create:{width:1200,height:800,channels:3,background:'#238baa'}}).png().toBuffer(),sha=createHash('sha256').update(png).digest('hex');
 const turns=new Map<string,BridgeTurn>(),posts=new Map<string,number>(),tabs=new Map<string,{id:string;launchToken:string;ready:boolean}>();let mode:'completed'|'lost-response'|'queued'='completed',worker:ChildProcess|undefined,workerError='';
 let quarantineAll=false;
 const apiToken='test_fixture_token_'.repeat(4),runtime=path.join(directory,'runtime-3008/image-browser');mkdirSync(runtime,{recursive:true});
 // Match the actual canonical HTTP projection, which omits DOM-only flags.
 const complete=(id:string):BridgeTurn=>({id,status:'completed',output:{response:{requestId:id,turnKey:`reply-${id}`,session:{id:'fixture-conversation'},sourceClientId:`fixture-browser-${id}`,url:'https://chatgpt.com/c/fixture-conversation'},artifacts:[{id:`original-${id}`,mime:'image/png',size:png.length,blockTestId:'generated-image-preview',kind:'image',phase:'READY',downloadable:true,requestId:id,sourceTurnKey:`reply-${id}`,sourceClientId:`fixture-browser-${id}`} ]}});
 const server=createServer(async(req,res)=>{
  if(req.headers.authorization!==`Bearer ${apiToken}`){res.writeHead(401).end();return;}
  const json=(value:unknown,status=200)=>{res.writeHead(status,{'Content-Type':'application/json'}).end(JSON.stringify(value));};
  if(req.url==='/health'){json({ok:false,clients:2,needsSelection:true,pendingRequests:0,activeRequests:[]});return;}
  if(req.url==='/browser/clients'){json({ok:true,clients:[{id:'fixture-opener',ready:true,selected:true},...tabs.values()].map(client=>({...client,quarantined:quarantineAll}))});return;}
  if(req.url==='/browser/recover-latest'){
   let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);
   assert.equal(input.reconcileConversation.mode,'image_preflight');assert.ok([...tabs.values()].some(t=>t.id===input.sourceClientId));
   json({ok:true,result:{url:'https://chatgpt.com/',sourceClientId:input.sourceClientId,reconciliation:{source:'browser-empty-preflight',version:1,proofVersion:2,status:'matched_empty'}}});return;
  }
  if(req.url==='/browser/tabs/open'){
   let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);assert.equal(input.select,false);assert.equal(input.active,true);assert.equal(input.url,'https://chatgpt.com/');assert.equal(input.allowSystemFallback,false);
   assert.equal(input.sourceClientId,'fixture-opener');assert.ok(!tabs.has(input.launchToken),'A task opens its owned tab only once');const client={id:`fixture-browser-${input.launchToken.slice('director3008-'.length)}`,launchToken:input.launchToken,ready:true};tabs.set(input.launchToken,client);json({ok:true,launchToken:input.launchToken,client},201);return;
  }
  if(req.url==='/turns'&&req.method==='POST'){
   let raw='';for await(const chunk of req)raw+=chunk;const input=JSON.parse(raw);
   assert.equal(req.headers['idempotency-key'],`director3008:${input.id}`);assert.equal(input.newSession,false);assert.equal(input.sourceClientId,`fixture-browser-${input.id}`);assert.ok(input.message.includes('灰色石拱桥'));assert.deepEqual(input.attachments,[]);
   posts.set(input.id,(posts.get(input.id)??0)+1);const turn=mode==='queued'?{id:input.id,status:'running'}:complete(input.id);turns.set(input.id,turn);
   if(mode==='lost-response'){req.socket.destroy();return;}json({ok:true,turn},202);return;
  }
  if(req.url?.startsWith('/turns/')){const id=decodeURIComponent(req.url.slice(7)),turn=turns.get(id);json(turn?{ok:true,turn}:{ok:false},turn?200:404);return;}
  if(req.url?.startsWith('/artifacts/')){res.writeHead(200,{'Content-Type':'image/png','Content-Length':png.length}).end(png);return;}
  json({ok:false},404);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as {port:number}).port;
 writeFileSync(path.join(runtime,'bridge.env'),`PORT=${port}\nAPI_TOKEN=${apiToken}\n`);
 const start=()=>{workerError='';worker=spawn(process.execPath,['--import',pathToFileURL(path.join(repository,'node_modules/tsx/dist/loader.mjs')).href,path.join(repository,'scripts/asset-image-browser-worker.ts')],{cwd:directory,env:{...process.env,TSX_TSCONFIG_PATH:path.join(repository,'tsconfig.json')},stdio:['ignore','ignore','pipe'],windowsHide:true});worker.stderr?.on('data',chunk=>{workerError+=chunk.toString();});};
 const stop=async()=>{if(!worker)return;const child=worker;worker=undefined;if(child.exitCode!==null)return;const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;};
 const wait=async(check:()=>Promise<boolean>,label:string)=>{const until=Date.now()+35000;while(Date.now()<until){if(await check())return;if(worker&&worker.exitCode!==null)throw Error(`worker failed: ${workerError}`);await new Promise(resolve=>setTimeout(resolve,200));}throw Error(`Timed out: ${label}, ${workerError}`);};
 try{
  const project=await prisma.project.create({data:{title:'synthetic bridge fixture',episodes:{create:{number:1,content:'1-1 河岸 日 外\n灰色石拱桥在河上。'}}}}),actor=await prisma.user.create({data:{username:'bridge-test',email:'bridge@example.invalid',passwordHash:'fixture'}});
  await prisma.projectRole.create({data:{projectId:project.id,userId:actor.id,role:'ADMIN'}});
  const episode=(await prisma.episode.findFirst({where:{projectId:project.id}}))!;
  await prisma.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'}),content:JSON.stringify({sourceText:episode.content,sourceStructure:{version:'SOURCE_STRUCTURE_V1',sections:[{key:'ep1',kind:'EPISODE',episodeNumber:1,start:0,end:episode.content.length}],issues:[]}})}});
  const document=createEmptyDocument(await loadFoundationInputs(project.id));document.workflow='LIGHT_STAGE1_V1';document.editorialCoverage=[1];document.f2={format:'ASSET_CATALOG_V1',coverage:[1],assets:[{key:'bridge',name:'石桥',type:'LOC',aliases:[],description:'',sourceRefs:[],appearances:[],usageEpisodes:[1],preparation:{mode:'REFERENCE'},variants:[]}],episodes:[{number:1,context:'',assetKeys:['bridge']}],issues:[]};
  await prisma.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FOUNDATION_DOCUMENT',content:JSON.stringify(document)}});await prompts.saveAssetPrompt(project.id,'bridge',0,'灰色石拱桥，无人。');
  const create=async()=>{const workspace=await prompts.loadAssetPromptWorkspace(project.id);return jobs.createImageJob(project.id,actor.id,{key:'bridge',expectedPromptRevision:workspace.records.bridge.revision,expectedStyleRevision:workspace.styleRevision,expectedOptionsRevision:workspace.imageOptions?.bridge?.revision??0,episodeNumbers:[1]},'CHROME');};
  const state=()=>jobs.listImageJobs(project.id,actor.id);const ready=async(id:string)=>{const item=(await state()).jobs.find(job=>job.id===id);assert.notEqual(item?.status,'FAILED',item?.error??'Image job failed');return item?.status==='REVIEW';};
  await browser.changeImageBrowserState(project.id,actor.id,'enable');
  const normal=await create();start();await wait(()=>ready(normal.id),'ordinary original import');
  const imported=(await state()).jobs.find(job=>job.id===normal.id)!;assert.equal(posts.get(normal.id),1);assert.equal(imported.resultOrigin,'WEB_EXECUTOR');assert.equal(imported.images[0].sha256,sha);assert.deepEqual((await jobs.readImageJobImage(project.id,actor.id,normal.id,imported.images[0].id)).bytes,png);
  const preview=await jobs.readImageJobPreview(project.id,actor.id,normal.id,imported.images[0].id);assert.equal((await sharp(preview.bytes).metadata()).width,640);assert.equal(createHash('sha256').update((await jobs.readImageJobImage(project.id,actor.id,normal.id,imported.images[0].id)).bytes).digest('hex'),sha);
  mode='lost-response';const lost=await create();await wait(()=>ready(lost.id),'lost POST response GET-only recovery');assert.equal(posts.get(lost.id),1);
  mode='queued';const restarted=await create();await wait(async()=>turns.has(restarted.id),'turn sent once before restart');await stop();turns.set(restarted.id,complete(restarted.id));start();await wait(()=>ready(restarted.id),'worker restart resumes existing turn');assert.equal(posts.get(restarted.id),1);
  await browser.changeImageBrowserState(project.id,actor.id,'pause');const paused=await create();await new Promise(resolve=>setTimeout(resolve,4200));assert.equal((await state()).jobs.find(job=>job.id===paused.id)?.status,'WAITING_EXECUTOR');assert.equal(posts.has(paused.id),false);
  await jobs.cancelImageJob(project.id,actor.id,paused.id,paused.revision);
  await browser.changeImageBrowserState(project.id,actor.id,'enable');mode='queued';const missing=await create();await wait(async()=>turns.has(missing.id),'accepted turn before missing-state restart');await stop();turns.delete(missing.id);start();await wait(async()=>(await state()).jobs.find(job=>job.id===missing.id)?.status==='FAILED','missing upstream turn fails without resending');assert.equal(posts.get(missing.id),1);
  const selection=complete(normal.id);for(const field of ['requestId','sourceTurnKey','sessionId','sourceClientId','phase','downloadable','generatedImage'] as const){const foreign=structuredClone(selection);(foreign.output!.artifacts![0] as unknown as Record<string,unknown>)[field]=field==='generatedImage'||field==='downloadable'?false:'foreign';assert.throws(()=>generatedTurnImages(foreign,normal.id,1));}
  assert.throws(()=>generatedTurnImages(selection,normal.id,2));assert.throws(()=>new BridgeClient({baseUrl:'https://evil.invalid',apiToken}));
  const canonical=structuredClone(selection);const canonicalImage=canonical.output!.artifacts![0];delete canonicalImage.generatedImage;delete canonicalImage.sessionId;canonicalImage.blockTestId='generated-image-preview';assert.equal(generatedTurnImages(canonical,normal.id,1).artifacts.length,1);
  const ordinary=structuredClone(canonical);ordinary.output!.artifacts![0].blockTestId='ordinary-image';assert.throws(()=>generatedTurnImages(ordinary,normal.id,1));
  const explicitRejected=structuredClone(canonical);explicitRejected.output!.artifacts![0].generatedImage=false;assert.throws(()=>generatedTurnImages(explicitRejected,normal.id,1));
  const proven=structuredClone(canonical);proven.output!.artifacts![0].url='https://chatgpt.com/backend-api/estuary/content?id=file_fixture';
  const proof={status:'matched_complete',requestId:normal.id,conversationId:'fixture-conversation',assistantMessageId:`reply-${normal.id}`,promptSha256:sha,bindings:[{imageFileId:'file_fixture',bytesSha256:sha}]};verifyNativeImageResult(proven,proof,sha);
  for(const field of ['requestId','conversationId','assistantMessageId','promptSha256'] as const)assert.throws(()=>verifyNativeImageResult(proven,{...proof,[field]:'wrong'},sha));
  assert.throws(()=>verifyNativeImageResult(proven,{...proof,bindings:[{imageFileId:'other',bytesSha256:sha}]},sha));
  assert.throws(()=>verifyNativeImageResult(proven,{...proof,bindings:[{imageFileId:'file_fixture'}]},sha));
  assert.throws(()=>generatedTurnImages(selection,normal.id,1,'other-project-client'));
  const client=new BridgeClient({baseUrl:`http://127.0.0.1:${port}`,apiToken});await assert.rejects(()=>client.turn('missing'),/不存在/);
  assert.ok(existsSync(path.join(runtime,'receipts',`${restarted.id}.json`)));assert.ok(!readFileSync(path.join(runtime,'receipts',`${restarted.id}.json`),'utf8').includes('"token"'));
  await stop();quarantineAll=true;
  const unavailable=await client.browserAvailability();assert.equal(unavailable.quarantined,true);assert.equal(unavailable.opener,undefined);
  const tabCount=tabs.size;await assert.rejects(()=>client.taskBrowser('quarantined-fixture',true),/没有可执行/);assert.equal(tabs.size,tabCount);
  const blocked=await create();start();await wait(async()=>existsSync(path.join(runtime,'heartbeat.json'))&&JSON.parse(readFileSync(path.join(runtime,'heartbeat.json'),'utf8')).error==='BROWSER_QUARANTINED','quarantine blocks claiming');
  assert.equal((await state()).jobs.find(job=>job.id===blocked.id)?.status,'WAITING_EXECUTOR');assert.equal(posts.has(blocked.id),false);assert.equal((await browser.readImageBrowserStatus(project.id,actor.id)).status,'ERROR');
  console.log('PASS synthetic HTTP + real isolated SQLite/worker: raw original SHA/preview, strict reply binding/count, one POST despite lost reply and restart, missing upstream turn no resend, paused project no send, receipt without claim token; real ChatGPT calls 0.');
 }finally{await stop();await prisma.$disconnect();await new Promise<void>(resolve=>server.close(()=>resolve()));process.chdir(repository);}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
