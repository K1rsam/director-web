import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {mkdtemp,writeFile,readFile,mkdir,rename} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import {PrismaClient} from '@prisma/client';
import {chromium,type Browser} from 'playwright';
import {migrateDatabase} from '@/lib/database-migration';
import {createSessionToken,hashSessionToken,hashPassword} from '@/lib/auth-crypto';

async function main(){
const root=process.cwd(),scratch=await mkdtemp(path.join(tmpdir(),'storyboard-web-verify-'));
const databaseUrl=`file:${path.join(scratch,'verify.db')}`,dataRoot=path.join(scratch,'jobs');
const cookieName='director_storyboard_verify_session';
const db=new PrismaClient({datasourceUrl:databaseUrl});
let server:ChildProcess|undefined,browser:Browser|undefined,logs='';
const req=createRequire(path.join(root,'package.json'));
async function port(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const p=(s.address() as {port:number}).port;await new Promise<void>(r=>s.close(()=>r()));return p;}
try{
 await migrateDatabase({databaseUrl,schemaPath:path.join(root,'prisma/schema.prisma'),quiet:true});
 const user=await db.user.create({data:{username:'storyboard-isolated',email:'storyboard-isolated@localhost.invalid',passwordHash:await hashPassword(createSessionToken())}});
 const project=await db.project.create({data:{title:'分镜隔离验收（零模型）',style:'3D国漫',roles:{create:{userId:user.id,role:'OPERATOR'}},episodes:{create:[{number:1,title:'坚持',content:'第1集\n1-1 日 外 城墙\n甲：（咬牙）我还没输！\n△甲握紧拳头，仍站着。'},{number:2,title:'隔离',content:'第2集\n乙：别过来。'}]}},include:{episodes:true}});
 const episode=project.episodes.find(e=>e.number===1)!,other=project.episodes.find(e=>e.number===2)!;
 const token=createSessionToken();await db.session.create({data:{userId:user.id,tokenHash:await hashSessionToken(token),expiresAt:new Date(Date.now()+3600000)}});
 const fake=path.join(scratch,'codex-preflight-only');
 const controlFile=path.join(scratch,'fake-model-control.json'),enteredFile=path.join(scratch,'fake-model-entered.json');
 const control=async(value:unknown)=>{await writeFile(controlFile+'.tmp',JSON.stringify(value));await rename(controlFile+'.tmp',controlFile);};
 const waitEntered=async(sequence:number)=>{for(let i=0;i<200;i++){const value=await readFile(enteredFile,'utf8').then(JSON.parse).catch(()=>null);if(value?.sequence===sequence)return;await new Promise(r=>setTimeout(r,25));}assert.fail('isolated fake CLI did not start');};
 await writeFile(fake,`#!${process.execPath}
const fs=require('node:fs');
if(process.argv[2]!=='exec'){process.stdout.write('isolated CLI preflight only\\n');process.exit(0);}
const control=${JSON.stringify(controlFile)},entered=${JSON.stringify(enteredFile)};
if(!fs.existsSync(control)){fs.writeFileSync(${JSON.stringify(path.join(scratch,'forbidden-model-call'))},'blocked');process.exit(88);}
const config=JSON.parse(fs.readFileSync(control,'utf8')),output=process.argv[process.argv.indexOf('-o')+1];
process.stdin.resume();process.stdin.on('end',()=>{fs.writeFileSync(entered,JSON.stringify({sequence:config.sequence,output}));const timer=setInterval(()=>{const latest=JSON.parse(fs.readFileSync(control,'utf8'));if(latest.sequence!==config.sequence||!latest.release)return;clearInterval(timer);const text=JSON.stringify(config.output);fs.writeFileSync(output,text);process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\\n'+JSON.stringify({type:'turn.completed',usage:{input_tokens:8,output_tokens:2,cached_input_tokens:0}})+'\\n');process.exit(0);},25);});
`,{mode:0o700});
 const selectedPort=await port(),base=`http://127.0.0.1:${selectedPort}`;
 server=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(selectedPort)],{cwd:root,env:{...process.env,DATABASE_URL:databaseUrl,DIRECTOR_SESSION_COOKIE_NAME:cookieName,DIRECTOR_STORYBOARD_DATA_DIR:dataRoot,DIRECTOR_CODEX_CLI:fake},stdio:['ignore','pipe','pipe']});
 for(const stream of [server.stdout,server.stderr])stream?.on('data',chunk=>{logs=(logs+chunk.toString()).slice(-50000)});
 let ready=false;for(let i=0;i<120;i++){if(server.exitCode!==null)throw new Error('隔离站点退出');try{if((await fetch(base+'/login')).status===200){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,250));}assert.ok(ready,'隔离站点须启动');
 const endpoint=base+`/api/episodes/${episode.id}/storyboard`;
 const headers={cookie:`${cookieName}=${token}`};
 const post=async(body:unknown,extra:Record<string,string>={})=>fetch(endpoint,{method:'POST',headers:{...headers,'content-type':'application/json','x-storyboard-action':'1',...extra},body:JSON.stringify(body)});
 assert.equal((await fetch(endpoint)).status,401);
 assert.equal((await post({action:'create'},{origin:'https://outside.invalid'})).status,403);
 let response=await fetch(endpoint,{headers});assert.equal(response.status,200);const index=await response.json();assert.equal(index.model,'gpt-6-sol');assert.equal(index.runner.ready,true);
 response=await post({action:'create',settings:{maxUnitSeconds:30,fantasyMode:'review'},maxCalls:0,maxTokens:0});
 assert.equal(response.status,201,await response.clone().text());let run=(await response.json()).run;assert.equal(run.operations.length,0);
 response=await fetch(base+`/api/episodes/${other.id}/storyboard?runId=${run.id}`,{headers});assert.equal(response.status,404);
 const {digest}=req('./runtime/storyboard-v4/core/shared.mjs');
 await mkdir(path.join(dataRoot,'source-contexts'),{recursive:true});
 await writeFile(path.join(dataRoot,'source-contexts',other.id+'.json'),JSON.stringify({schemaVersion:'independent-source-context-v1',projectId:project.id,episodeId:other.id,contentHash:digest(other.content),title:'独立片段测试',scene:'日 外 测试场',origin:{sampleKey:'isolated-check'},contextRows:[{id:'context:prior',text:'△此前的门已经关上。'}],entryFacts:[]}));
 const otherEndpoint=base+`/api/episodes/${other.id}/storyboard`;
 response=await fetch(otherEndpoint,{headers});assert.equal(response.status,200);assert.ok((await response.json()).sourceWarnings.some((w:string)=>w.includes('独立局部原剧本')));
 response=await fetch(otherEndpoint,{method:'POST',headers:{...headers,'content-type':'application/json','x-storyboard-action':'1'},body:JSON.stringify({action:'create',maxCalls:0,maxTokens:0})});assert.equal(response.status,201);
 const independentRun=(await response.json()).run;
 const independentSaved=await (await fetch(`${otherEndpoint}?runId=${independentRun.id}&format=json`,{headers})).json();assert.equal(independentSaved.source.contextRows[0].text,'△此前的门已经关上。');assert.deepEqual(independentSaved.source.assets,[]);
 response=await post({action:'start',runId:run.id,mode:'all'});assert.equal(response.status,202);await new Promise(r=>setTimeout(r,150));
 response=await fetch(`${endpoint}?runId=${run.id}`,{headers});run=(await response.json()).run;assert.equal(run.operations.length,0);assert.equal(run.status,'budget_stop');
 assert.equal((await fetch(`${endpoint}?runId=${run.id}&format=md`,{headers})).status,409);
 assert.equal((await fetch(`${endpoint}?runId=${run.id}&format=json`,{headers})).status,200);

 // Validated synthetic plan only, in isolated storage, to exercise real selection APIs without buying a plan.
 const {createStore}=req('./runtime/storyboard-v4/core/store.mjs'),{normalizePlan}=req('./runtime/storyboard-v4/core/core.mjs');
 const store=createStore(dataRoot),saved=await store.read(run.id),refs=saved.source.sourceRows.filter((r:any)=>r.kind!=='metadata'&&r.text.trim()).map((r:any)=>r.id);
 const emotion={subject:'甲',contextTone:'严肃',audienceEffect:'感到抵抗',change:'承压仍坚持',landing:'仍站立',retain:['不搞笑']};
 const rawPlan={schemaVersion:'performance-core-v4-plan',unitPackingPolicy:'event-first-v1',emotionArc:'严肃不甘',events:[{id:'E1',sourceRefs:refs,sceneKey:'日外城墙',boundaryBefore:{kind:'episode_start',reason:'本次制作原文开始'},emotionContract:emotion}],entryFacts:[],workPackages:[{id:'P1',eventId:'E1',sourceRefs:refs,emotionContract:emotion,entryFactIds:[],contextRefs:[],dependsOn:[],scenarioKeys:[]}],provisionalUnits:[{id:'U1',packageId:'P1',sourceRefs:refs,secondsRange:[4,10]}],fantasyCandidates:[{id:'F1',anchorRefs:refs,subject:'甲',emotionPurpose:'抵抗',recommended:true,proposal:'主观压力',screenSecondsRange:[1,2],extraSecondsRange:[0,1]}]};
 const plan=normalizePlan(rawPlan,saved.source,{unitPackingPolicy:'event-first-v1'});
 await store.update(run.id,(d:any)=>{d.plan=plan;d.status='planned';d.web.progress='planned';return d});
 const executablePath=existsSync(chromium.executablePath())?undefined:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 assert.ok(!executablePath||existsSync(executablePath),'需要本机Chrome做浏览器验收');
 browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addCookies([{name:cookieName,value:token,url:base,httpOnly:true,sameSite:'Lax'}]);
 const page=await context.newPage(),pageErrors:string[]=[];page.on('pageerror',e=>pageErrors.push(e.message));
 await page.goto(`${base}/projects/${project.id}/episodes/${episode.id}/storyboard?runId=${run.id}`);
 await page.getByRole('heading',{name:'幻想段落选择'}).waitFor();
 await page.evaluate(()=>{const debug=window as typeof window & {scrollTrace:unknown[]};debug.scrollTrace=[];document.addEventListener('wheel',e=>{debug.scrollTrace.push({deltaY:e.deltaY,target:(e.target as Element)?.outerHTML?.slice(0,300),scrollY:window.scrollY})},{passive:true});});
 // Real wheel input: locator.click() scrolls programmatically, even inside overflow:hidden.
 const scrollEvidence=[];
 for(const viewport of [{width:1440,height:1000},{width:390,height:844}]){
  await page.setViewportSize(viewport);
  const checkboxSizes=await page.locator('section[aria-label="分镜制作工作台"] input[type="checkbox"]').evaluateAll(elements=>elements.map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height})));
  assert.ok(checkboxSizes.length>0&&checkboxSizes.every(s=>s.width<=24&&s.height<=24),'复选框不得继承整行文本框尺寸，挤掉选择说明');
  await page.mouse.move(viewport.width-60,320);
  // Wheel dispatch is asynchronous. Do not enqueue an upward wheel at an
  // already-reached top and immediately merge it with the downward test.
  if(await page.evaluate(()=>window.scrollY>=2)){
   await page.mouse.wheel(0,-20000);
   await page.waitForFunction(()=>window.scrollY<2);
  }
  const top=await page.locator('section[aria-label="分镜制作工作台"]').evaluate(e=>e.getBoundingClientRect().top);
  await page.mouse.wheel(0,650);
  await page.waitForFunction(before=>document.querySelector('section[aria-label="分镜制作工作台"]')!.getBoundingClientRect().top<before-100,top,{timeout:2000});
  await page.mouse.wheel(0,20000);
  await page.waitForFunction(()=>document.querySelector('section[aria-label="完整分镜"]')!.getBoundingClientRect().bottom<=window.innerHeight+10,null,{timeout:2000});
  const bottomY=await page.evaluate(()=>window.scrollY);
  await page.mouse.wheel(0,-20000);
  await page.waitForFunction(()=>window.scrollY<2,null,{timeout:2000});
  scrollEvidence.push({viewport,bottomY,returnedToTop:true});
 }
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('button',{name:'确认幻想选择',exact:true}).click();
 await page.getByRole('status').filter({hasText:'操作已保存'}).waitFor();
 await page.getByRole('button',{name:'不加幻想',exact:true}).click();
 await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='不加幻想'&&b.getAttribute('aria-pressed')==='true'));
 await page.getByRole('button',{name:'全部加入',exact:true}).click();
 await page.getByRole('status').filter({hasText:'操作已保存'}).waitFor();
 await page.getByRole('button',{name:'只加推荐',exact:true}).click();
 await page.getByRole('status').filter({hasText:'操作已保存'}).waitFor();
 await page.reload();await page.getByRole('heading',{name:'幻想段落选择'}).waitFor();
 assert.equal(await page.getByRole('button',{name:'只加推荐',exact:true}).getAttribute('aria-pressed'),'true');
 assert.equal(await page.getByLabel('最多调用次数',{exact:true}).isVisible(),false);
 assert.equal(await page.getByLabel('创作备注',{exact:true}).isVisible(),false);
 assert.equal(await page.getByLabel('调用次数停止线',{exact:true}).isVisible(),false);
 await page.getByText('高级设置（可选）',{exact:true}).click();
 await page.getByLabel('最多调用次数',{exact:true}).fill('7');
 await page.getByLabel('计划 Token 停止线',{exact:true}).fill('12000');
 await page.getByLabel('创作备注',{exact:true}).fill('隔离界面测试备注');
 const createdResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===endpoint&&r.request().postDataJSON()?.action==='create');
 await page.getByRole('button',{name:'新建任务（仅准备）',exact:true}).click();
 const created=(await (await createdResponse).json()).run;assert.equal(created.budget.maxCalls,7);assert.equal(created.budget.maxTokens,12000);
 const createdSaved=await (await fetch(`${endpoint}?runId=${created.id}&format=json`,{headers})).json();assert.equal(createdSaved.source.context.directorNotes,'隔离界面测试备注');assert.equal(createdSaved.operations.length,0);
 // Reproduce a legacy rejected-but-verifiable paid plan in isolated storage.
 // The response below is supplied by a local function, never a production model.
 response=await post({action:'create',settings:{maxUnitSeconds:30,fantasyMode:'recommended'},maxCalls:0,maxTokens:0});assert.equal(response.status,201);
 const failedRun=(await response.json()).run,oldFact={id:'EF-browser',subject:'甲',statement:'甲喊出原话仍站着',sourceRefs:refs,evidence:refs.map((id:string)=>saved.source.sourceRows.find((r:any)=>r.id===id).text).join('／')};
 const returnedPlan={...rawPlan,entryFacts:[oldFact],workPackages:rawPlan.workPackages.map((w:any)=>({...w,entryFactIds:['EF-browser']}))};
 const {createEngine}=req('./runtime/storyboard-v4/core/pipeline.mjs');
 const replayEngine=createEngine({directory:dataRoot,modelRunner:async()=>({output:returnedPlan,raw:JSON.stringify(returnedPlan),requestOutcome:'RESPONDED',usage:{inputTokens:8,outputTokens:2,cachedInputTokens:0,totalTokens:10}})});
 await replayEngine.execute(failedRun.id,{stage:'plan',attemptId:'isolated-browser-plan'});
 await store.update(failedRun.id,(d:any)=>{d.plan=null;d.status='needs_repair';d.web.progress='needs_repair';d.candidates[0].status='needs_repair';d.candidates[0].errors=[{code:'ENTRY_FACT_EVIDENCE',message:'前情事实EF-browser依据无法在原文定位',requestOutcome:'RESPONDED'}];delete d.candidates[0].validatorVersion;return d;});
 await page.goto(`${base}/projects/${project.id}/episodes/${episode.id}/storyboard?runId=${failedRun.id}`);
 const feedback=page.locator('[aria-label="操作反馈"]');
 await feedback.getByText('分析已返回，规划校验未通过，结果已保存。',{exact:true}).waitFor();
 assert.match(await feedback.getByRole('alert').innerText(),/ENTRY_FACT_EVIDENCE/);
 assert.match(await feedback.innerText(),/调用记录 1 次.*已返回 1 次/);
 assert.equal(await page.getByRole('button',{name:'修复规划/继续',exact:true}).isDisabled(),true,'zero budget still prohibits paid repair');
 await page.screenshot({path:path.join(scratch,'failed-plan-feedback.png'),fullPage:true,animations:'disabled'});
 const freeCheck=page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===endpoint&&r.request().postDataJSON()?.action==='recheck');
 await feedback.getByRole('button',{name:'重新核查候选（不调用模型）',exact:true}).click();
 assert.equal((await freeCheck).status(),200);
 await feedback.getByText('规划已返回并通过校验，可以审看幻想选择后继续。',{exact:true}).waitFor();
 assert.equal(await feedback.getByRole('alert').count(),0);
 const recovered=await (await fetch(`${endpoint}?runId=${failedRun.id}&format=json`,{headers})).json();
 assert.equal(recovered.operations.length,1);assert.equal(recovered.candidates[0].raw,JSON.stringify(returnedPlan));assert.ok(recovered.plan);
 await page.reload();await page.getByRole('heading',{name:'幻想段落选择'}).waitFor();
 assert.match(await feedback.innerText(),/调用记录 1 次.*已返回 1 次/);
 // Exercise actual browser actions with a gated local fake process, never a provider.
 await control({sequence:1,release:false,output:rawPlan});
 response=await post({action:'create',settings:{maxUnitSeconds:30,fantasyMode:'recommended'},maxCalls:4,maxTokens:100000});assert.equal(response.status,201);
 const pauseRun=(await response.json()).run;
 await page.goto(`${base}/projects/${project.id}/episodes/${episode.id}/storyboard?runId=${pauseRun.id}`);
 await page.getByRole('button',{name:'先分析',exact:true}).click();await waitEntered(1);
 await page.getByRole('button',{name:'暂停（保留回包）',exact:true}).click();
 await feedback.getByText(/正在暂停：不再派新请求/).waitFor();
 await control({sequence:1,release:true,output:rawPlan});
 await feedback.getByText(/已暂停，完成的步骤与回包已保存/).waitFor();
 const paused=await (await fetch(`${endpoint}?runId=${pauseRun.id}&format=json`,{headers})).json();
 assert.ok(paused.plan);assert.equal(paused.operations.length,1);assert.equal(paused.operations[0].status,'completed');
 assert.equal(await page.getByRole('button',{name:'从已保存步骤继续',exact:true}).isEnabled(),true);
 await page.screenshot({path:path.join(scratch,'paused-with-saved-plan.png'),fullPage:true,animations:'disabled'});

 await control({sequence:2,release:false,output:rawPlan});
 response=await post({action:'create',settings:{maxUnitSeconds:30,fantasyMode:'recommended'},maxCalls:4,maxTokens:100000});assert.equal(response.status,201);
 const abortRun=(await response.json()).run;
 await page.goto(`${base}/projects/${project.id}/episodes/${episode.id}/storyboard?runId=${abortRun.id}`);
 await page.getByRole('button',{name:'先分析',exact:true}).click();await waitEntered(2);
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'立即中断',exact:true}).click();
 const recovery=page.locator('[aria-label="回包恢复"]');
 await recovery.getByRole('button',{name:'确认中断风险，允许继续',exact:true}).waitFor();
 assert.match(await recovery.innerText(),/用量未知/);
 const acknowledgeResponse=page.waitForResponse(r=>r.request().method()==='POST'&&r.url()===endpoint&&r.request().postDataJSON()?.action==='acknowledge_cancel');
 page.once('dialog',dialog=>dialog.accept());await recovery.getByRole('button',{name:'确认中断风险，允许继续',exact:true}).click();
 assert.equal((await acknowledgeResponse).status(),200);
 await feedback.getByText(/已暂停，完成的步骤与回包已保存/).waitFor();
 const acknowledged=await (await fetch(`${endpoint}?runId=${abortRun.id}&format=json`,{headers})).json();
 assert.equal(acknowledged.operations.length,1);assert.equal(acknowledged.operations[0].status,'unknown');assert.equal(acknowledged.operations[0].cancelAcknowledgement.acceptUnknownUsage,true);
 const acknowledgedView=(await (await fetch(`${endpoint}?runId=${abortRun.id}`,{headers})).json()).run;
 assert.equal(acknowledgedView.usage.complete,false);assert.equal(acknowledgedView.usage.acknowledgedUnknownAttempts,1);
 assert.equal(await page.getByRole('button',{name:'从已保存步骤继续',exact:true}).isEnabled(),true,'acknowledgement permits later explicit retry but does not send it');
 await page.goto(`${base}/projects/${project.id}/episodes/${episode.id}/storyboard?runId=${run.id}`);await page.getByRole('heading',{name:'幻想段落选择'}).waitFor();
 await page.screenshot({path:path.join(scratch,'workbench.png'),fullPage:true,animations:'disabled'});assert.deepEqual(pageErrors,[]);
 assert.equal(existsSync(path.join(scratch,'forbidden-model-call')),false,'所有浏览器/接口测试必须零模型调用');
 await writeFile(path.join(scratch,'evidence.json'),JSON.stringify({scope:'隔离数据库/预置规划与本地假CLI回包，非真实模型质量验收',http:'auth,origin,binding,create,budget,export,independent-source-context',browser:'four modes,confirmation,reload,advanced-controls,visible-failure,free-recheck,pause-keeps-plan,explicit-abort-acknowledgement,no client error',scrollEvidence,paidModelCalls:0,fakeCliCalls:2,screenshot:path.join(scratch,'workbench.png')},null,2));
 console.log(JSON.stringify({passed:true,paidModelCalls:0,evidenceDirectory:scratch}));
}catch(e){await writeFile(path.join(scratch,'server.log'),logs);const failedPage=browser?.contexts()[0]?.pages()[0];if(failedPage){await writeFile(path.join(scratch,'page.txt'),await failedPage.locator('body').innerText().catch(()=>''));await writeFile(path.join(scratch,'layout.json'),JSON.stringify(await failedPage.evaluate(()=>({viewport:{width:innerWidth,height:innerHeight},scrollY,scrollHeight:document.documentElement.scrollHeight,trace:(window as typeof window & {scrollTrace?:unknown[]}).scrollTrace,ancestors:[document.body,document.documentElement,...document.querySelectorAll('main,section[aria-label="分镜制作工作台"]')].map(e=>({tag:e.tagName,class:e.className,top:e.getBoundingClientRect().top,height:e.getBoundingClientRect().height,overflow:getComputedStyle(e).overflow,heightStyle:getComputedStyle(e).height}))})),null,2));await failedPage.screenshot({path:path.join(scratch,'failure.png'),fullPage:true}).catch(()=>{});}console.error((e as Error).stack);console.error(`隔离证据保留：${scratch}`);process.exitCode=1;}
finally{await browser?.close();if(server?.pid&&server.exitCode===null){server.kill('SIGTERM');await Promise.race([new Promise(r=>server!.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);if(server.exitCode===null)server.kill('SIGKILL');}await db.$disconnect();}
}
main().catch(e=>{console.error(e instanceof Error?e.message:String(e));process.exitCode=1});
