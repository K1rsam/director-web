/** Real project/auth/route reads against a disposable SQLite DB; no paid advance. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createRequire,registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';

async function main(){
 const directory=await mkdtemp(path.join(tmpdir(),'production-workflow-service-'));
 process.env.DATABASE_URL=`file:${path.join(directory,'test.db')}`;
 process.env.DIRECTOR_PRODUCTION_WORKFLOW_DIR=path.join(directory,'workflows');
 process.env.DIRECTOR_PRODUCTION_BUDGET_DIR=path.join(directory,'budgets');
 process.env.DIRECTOR_STORYBOARD_DATA_DIR=path.join(directory,'storyboards');
 const sql=new DatabaseSync(path.join(directory,'test.db'));
 for(const migration of (await readdir('prisma/migrations')).sort())if(/^\d/.test(migration))sql.exec(await readFile(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();
 const require=createRequire(import.meta.url),authPath=require.resolve('../lib/auth');
 const originalAuth=require.cache[authPath],fetchBefore=globalThis.fetch;
 // server-only is a bundler boundary; this test process executes the server modules directly.
 const hooks=registerHooks({resolve(specifier,context,nextResolve){return nextResolve(specifier==='server-only'?'next/dist/compiled/server-only/empty.js':specifier,context);}});
 let actor:string|null=null;
 require.cache[authPath]={id:authPath,filename:authPath,loaded:true,exports:{getCurrentUser:async()=>actor?{id:actor}:null}} as NodeModule;
 globalThis.fetch=async()=>{throw new Error('NETWORK_FORBIDDEN_IN_FREE_WORKFLOW_TEST');};
 const {prisma}=await import('../lib/prisma');
 try{
  const [user,outsider]=await Promise.all(['member','outsider'].map(username=>prisma.user.create({data:{username,email:`${username}@synthetic.invalid`,passwordHash:'offline-test-only'}})));
  const text='第一集\n1-1 日 内 房间\n人物：甲\n△甲抬手。\n甲：我知道了。\n';
  const project=await prisma.project.create({data:{title:'生产流程只读合成测试',roles:{create:{userId:user.id,role:'ADMIN'}},episodes:{create:{number:1,content:text}}}});
  await prisma.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SOURCE_IMPORT',metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'}),content:JSON.stringify({sourceText:text,sourceStructure:{version:'SOURCE_STRUCTURE_V1',issues:[],sections:[{key:'ep1',kind:'EPISODE',episodeNumber:1,start:0,end:text.length}]}})}});
  const service=await import('../lib/production-workflow');
  const route=await import('../app/api/projects/[projectId]/production-workflow/route');
  const origin='http://localhost:3008',url=`${origin}/api/projects/${project.id}/production-workflow`,context={params:Promise.resolve({projectId:project.id})};
  const post=(body:unknown,headers:Record<string,string>={origin,'content-type':'application/json'})=>route.POST(new Request(url,{method:'POST',headers,body:JSON.stringify(body)}),context);
  assert.equal((await route.GET(new Request(url),context)).status,401);
  actor=outsider.id;assert.equal((await route.GET(new Request(url),context)).status,403);
  actor=user.id;
  assert.equal((await post({action:'create'}, {origin:'https://other.invalid','content-type':'application/json'})).status,403);
  assert.equal((await post({action:'create'}, {origin,'content-type':'text/plain'})).status,415);
  const counts=async()=>[await prisma.sceneSnapshot.count(),await prisma.pipelineRun.count(),await prisma.episode.count()];const before=await counts();
  const created=await post({action:'create',episodeNumbers:[1],maxCalls:2,maxTokens:100,actorId:outsider.id,projectId:'spoofed'});assert.equal(created.status,201);
  let view=await created.json();const id=view.workflow.id;assert.equal(view.workflow.actorId,user.id);assert.equal(view.workflow.projectId,project.id);assert.equal(view.nextAction.kind,'WAIT_COST_CONFIRM');
  assert.equal(view.keyDesignGate,'NOT_SPECIFIED');assert.equal(view.budget.maxCalls,2);assert.equal(view.budget.maxTokens,100);
  const get=await route.GET(new Request(`${url}?workflowId=${id}`),context);assert.equal(get.status,200);
  view=await (await post({action:'advance',workflowId:id,expectedRevision:view.workflow.revision})).json();assert.equal(view.nextAction.kind,'WAIT_COST_CONFIRM');assert.equal(view.budget.summary.calls,0);
  view=await (await post({action:'pause',workflowId:id,expectedRevision:view.workflow.revision})).json();assert.equal(view.nextAction.kind,'WAIT_PAUSED');
  assert.equal((await post({action:'resume',workflowId:id,expectedRevision:0})).status,409);
  view=await (await post({action:'resume',workflowId:id,expectedRevision:view.workflow.revision})).json();assert.equal(view.nextAction.kind,'WAIT_COST_CONFIRM');
  assert.deepEqual(await counts(),before,'creation/read/blocked advance/pause/resume must not write source, snapshots or model runs');
  assert.deepEqual(await service.getProductionChain(id,project.id),{id,mode:'CHAIN',selectionRevision:0,selectedRuns:{},episodeNumbers:[1]});
  await assert.rejects(()=>service.getProductionChain(id,'foreign'));
  let release!:()=>void,entered!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),inside=new Promise<void>(resolve=>{entered=resolve;}),order:string[]=[];
  const locked=service.withChainSelection(id,project.id,async chain=>{assert.equal(chain.id,id);order.push('selected-read');entered();await gate;order.push('agreement-write');return chain.selectionRevision;});
  await inside;
  const queued=post({action:'pause',workflowId:id,expectedRevision:view.workflow.revision}).then(response=>{order.push('workflow-write');return response;});
  release();await locked;view=await (await queued).json();
  assert.deepEqual(order,['selected-read','agreement-write','workflow-write'],'the real service uses the same selection/update store gate');
  assert.equal(view.nextAction.kind,'WAIT_PAUSED');
  view=await (await post({action:'resume',workflowId:id,expectedRevision:view.workflow.revision})).json();
  await assert.rejects(service.withChainSelection(id,'foreign',async()=>assert.fail('foreign chain callback must not run')));
  actor=outsider.id;assert.equal((await route.GET(new Request(`${url}?workflowId=${id}`),context)).status,403);
  actor=user.id;const listed=await (await route.GET(new Request(url),context)).json();assert.equal(listed.workflows.length,1);
  const unmaterialized=await prisma.project.create({data:{title:'只有完整原稿尚未切集',roles:{create:{userId:user.id,role:'ADMIN'}}}});
  const raw='第 1 集\n第一集\n1-1 日 内 房间\n△甲抬手。\n';
  await prisma.sceneSnapshot.create({data:{projectId:unmaterialized.id,sceneKey:'SOURCE_IMPORT',metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'}),content:JSON.stringify({sourceText:raw,sourceStructure:{version:'SOURCE_STRUCTURE_V1',issues:[{code:'DUPLICATE_EPISODE_NUMBER',message:'两种标题尚未核对',sectionKeys:['raw']}],sections:[{key:'raw',kind:'UNRESOLVED',start:0,end:raw.length}]}})}});
  const zero=await service.mutateProductionWorkflow(unmaterialized.id,user.id,{action:'create',episodeNumbers:[1],costAcknowledged:true});
  assert.equal(zero.nextAction.kind,'STAGE1','未物化正文应允许P1核对完整原稿，不伪造分集、不把待解析重复标题直接认定真实冲突');
  assert.equal(await prisma.episode.count({where:{projectId:unmaterialized.id}}),0);assert.equal(zero.budget.summary.calls,0);
  const ep0Text='第0集\n0-1 日 内 房间\n人物：甲\n△甲放下纸张。\n甲：开始吧。\n';
  const episodeZero=await prisma.project.create({data:{title:'合法第0集来源范围',roles:{create:{userId:user.id,role:'ADMIN'}},episodes:{create:{number:0,content:ep0Text}}}});
  const unscopedZero=await service.mutateProductionWorkflow(episodeZero.id,user.id,{action:'create',episodeNumbers:[0]});
  assert.equal(unscopedZero.readiness.standard.ready,false,'仅有数据库数字0不能冒充制作身份；只能保留待P1核对的选集意图');
  assert.equal(unscopedZero.nextAction.proposedAction.kind,'STAGE1');assert.equal(unscopedZero.budget.summary.calls,0);
  await prisma.sceneSnapshot.create({data:{projectId:episodeZero.id,sceneKey:'SOURCE_IMPORT',metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'}),content:JSON.stringify({sourceText:ep0Text,sourceStructure:{version:'SOURCE_STRUCTURE_V1',issues:[],sections:[{key:'ep0',kind:'EPISODE',episodeNumber:0,start:0,end:ep0Text.length}]}})}});
  const explicitZero=await service.mutateProductionWorkflow(episodeZero.id,user.id,{action:'create',episodeNumbers:[0]});
  assert.deepEqual(explicitZero.workflow.episodeNumbers,[0]);assert.equal(explicitZero.budget.summary.calls,0);assert.equal(explicitZero.nextAction.kind,'WAIT_COST_CONFIRM');
  console.log('PASS production workflow service/API: real temporary DB membership, CSRF, server-owned identity, immutable smaller budget, read-only GET, blocked advance, CAS pause/resume, read-only chain; zero real model/network/production DB writes');
 }finally{
  await prisma.$disconnect();globalThis.fetch=fetchBefore;
  hooks.deregister();if(originalAuth)require.cache[authPath]=originalAuth;else delete require.cache[authPath];
  await rm(directory,{recursive:true,force:true});
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
