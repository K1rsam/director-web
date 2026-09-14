/** Actual controller + fresh temporary SQLite. Provider output is injected; never calls AI or user data. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PrismaClient} from '@prisma/client';
import type {RoleRunResult} from '../lib/role-runner';

async function main() {
 const directory=mkdtempSync(path.join(tmpdir(),'stage1-controller-acceptance-')),url=`file:${directory}/test.db`;
 process.env.DATABASE_URL=url;process.env.CODEX_CLI_PATH='/__offline_only__/no-codex';process.env.DEEPSEEK_API_KEY='';
 copyFileSync('prisma/schema.prisma',`${directory}/schema.prisma`);
 execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${directory}/schema.prisma`,'--skip-generate'],{env:{...process.env,RUST_LOG:'info'},stdio:'pipe'});
 const client=new PrismaClient({datasourceUrl:url});
 let interruptAfterResponse=false,localRepairReturned=false,interruptions=0;
 const db=client.$extends({query:{pipelineRun:{async update({args,query}) {
  if(interruptAfterResponse&&localRepairReturned&&args.data.status==='SUCCEEDED'){interruptAfterResponse=false;interruptions++;throw new Error('OFFLINE_CHECKPOINT_AFTER_PAID_PATCH');}
  return query(args);
 }}}}) as unknown as PrismaClient;
 const {queueFoundationDelivery,executeFoundationDelivery,getFoundationDeliveryState}=await import('../lib/foundation-delivery');
 const result=(data:unknown):RoleRunResult=>({data:data as Record<string,unknown>,rawOutput:JSON.stringify(data),stdout:'offline-controller-fixture',stderr:'',sessionId:null});
 const modes=['f2-type','f2-key','q1-scene','q1-field','f2-replay','f2-bad-patch'] as const;
 try {
  for(const mode of modes) {
   const first=(mode==='f2-key'?'第1集\r\n1-1 日 内 大厅\r\n人物：甲\r\n甲（轻声）：雨停了吗？\r\n△窗外下雨。\r\n1-2 夜 内 走廊\r\n甲：这段原文与正确场保持不变。\r\n':'第1集\n1-1 日 内 大厅\n人物：甲\n甲：雨停了吗？\n△窗外下雨。\n1-2 夜 内 走廊\n甲：这段原文与正确场保持不变。\n');
   const second='第2集\n2-1 夜 内 厨房\n人物：乙\n乙：第二集唯一原文，不应出现在第一集的局部修复包里。\n';
   const project=await db.project.create({data:{title:`隔离控制器验收-${mode}`,episodes:{create:[{number:1,content:first},{number:2,content:second}]}}});
   const originalRows=await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}});
   const goodAsset={name:'乙',type:'CH',role:'配角',aliases:['小乙'],episodes:[2],sceneRefs:[{episode:2,sceneKey:'2-1'}],preparation:{mode:'REFERENCE'}};
   const targetAsset={name:'甲',type:'CH',role:'主角',aliases:['阿甲'],episodes:[1],sceneRefs:[{episode:1,sceneKey:'1-1'},{episode:1,sceneKey:'1-2'}],preparation:{mode:'REFERENCE'}};
   const calls:{stage:string;local:boolean;system:string;prompt:string}[]=[];
   let q1Initial=0;
   let originalSceneRows:unknown;
   let firstRaw:unknown;
   let firstSystem:string|undefined;
   localRepairReturned=false;interruptAfterResponse=mode==='f2-replay';
   const stageRunner:NonNullable<Parameters<typeof executeFoundationDelivery>[2]>['stageRunner']=async(stage,prompt,ctx)=>{
    const input=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);const local=Array.isArray(input.objects);
    calls.push({stage,local,system:ctx.role.systemPrompt??'',prompt});
    assert.notEqual(stage,'F1','Structured source should not restart source inference');
    if(local) {
     assert.equal(ctx.role.systemPrompt,firstSystem,'Local correction retains this role skill, not generic JSON-only role');
     assert.ok(ctx.role.systemPrompt?.length);
     assert.deepEqual(input.scope,[1]);assert.deepEqual(input.source.map((e:any)=>e.number),[1]);
     assert.ok(prompt.includes('雨停了吗'));assert.ok(!prompt.includes('第二集唯一原文'));
     assert.ok(input.scenes.some((s:any)=>s.sceneKey==='1-1'));
     assert.equal(input.objects.length,1,'Only invalid object sent for revision');
     assert.equal(stage,mode.startsWith('f2')?'F2':'Q1','Failure stays in responsible role');
     const value=mode.startsWith('f2')?targetAsset:{episode:1,sceneKey:'1-1',weather:'雨'};
     assert.equal(input.objects[0].path,mode.startsWith('f2')?'assets.0':'changes.scenes.0');
     const expectedPath=mode==='f2-key'?'assets.0.key':mode.startsWith('f2')?'assets.0.type':mode==='q1-scene'?'changes.scenes.0.sceneKey':'changes.scenes.0';
     assert.deepEqual(input.allowedPaths,[expectedPath]);
     const patches=input.allowedPaths.map((allowed:string)=>({path:allowed,value:allowed.endsWith('.key')?null:allowed===input.objects[0].path?value:allowed.slice(input.objects[0].path.length+1).split('.').reduce((v:any,k:string)=>v[k],value)}));
     if(mode==='f2-bad-patch')patches.push({path:'assets.0.name',value:'擅自改同对象正确名字'});
     localRepairReturned=true;return result({format:'FIELD_REPAIR_V1',patches});
    }
    if(stage==='F2') {
     const broken=mode==='f2-type'||mode==='f2-replay'||mode==='f2-bad-patch'?{...targetAsset,type:'invalid-kind'}:mode==='f2-key'?{...targetAsset,key:'invented-existing-key'}:targetAsset;
     const data={format:'ASSET_CATALOG_V2',coverage:input.scope,assets:[broken,goodAsset]};
     firstRaw=data;firstSystem=ctx.role.systemPrompt;return result(data);
    }
    q1Initial++;
    assert.equal(q1Initial,1,'Q1 receives completed F2 once');
    const target=input.candidates.f2.assets.find((a:any)=>a.name==='甲');assert.equal(target?.type,'CH');assert.equal(target?.role,'主角');assert.deepEqual(target?.aliases,['阿甲']);assert.deepEqual(target?.sceneRefs?.map((ref:any)=>Array.isArray(ref)?{episode:ref[0],sceneKey:ref[1]}:ref),targetAsset.sceneRefs);
    const good=input.candidates.f2.assets.find((a:any)=>a.name==='乙');assert.equal(good?.role,'配角');assert.deepEqual(good?.aliases,['小乙']);assert.deepEqual(good?.sceneRefs?.map((ref:any)=>Array.isArray(ref)?{episode:ref[0],sceneKey:ref[1]}:ref),goodAsset.sceneRefs);
    originalSceneRows=await db.scriptScene.findMany({where:{episode:{projectId:project.id}},orderBy:{id:'asc'}});
    firstSystem=ctx.role.systemPrompt;
    if(mode==='q1-scene'||mode==='q1-field')return result({format:'FOUNDATION_OPTIMIZATION_V2',coverage:input.scope,changes:{scenes:[mode==='q1-scene'?{episode:1,sceneKey:'missing-scene',weather:'雨'}:{episode:1,sceneKey:'1-1',weather:'雨',accidentalField:'invalid'}]},notes:['本次只完善第一场天气，其他资料原样保留。']});
    return result({format:'FOUNDATION_OPTIMIZATION_V2',coverage:input.scope,changes:{},notes:['核对完成，已有资料无需改动。']});
   };
   let task=await queueFoundationDelivery(project.id,{},db);await executeFoundationDelivery(project.id,task.id,{db,stageRunner});
   if(mode==='f2-replay') {
    const paused=await getFoundationDeliveryState(project.id,db);assert.equal(paused.complete,false);assert.ok(paused.task?.error?.includes('OFFLINE_CHECKPOINT_AFTER_PAID_PATCH'));
    assert.equal(calls.length,2);task=await queueFoundationDelivery(project.id,{},db);await executeFoundationDelivery(project.id,task.id,{db,stageRunner});
   }
   const state=await getFoundationDeliveryState(project.id,db);
   if(mode==='f2-bad-patch') {
    assert.equal(state.complete,false);assert.ok(state.task?.error?.includes('未授权'));assert.equal(state.requiredChoices.length,0);
    assert.equal(calls.length,2);assert.equal(q1Initial,0);assert.equal(state.document.f2,null,'Rejected patch never publishes renamed or partial catalog');
    assert.deepEqual(await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}}),originalRows);
    const runs=await db.pipelineRun.findMany({where:{projectId:project.id}});const attempts=runs.flatMap(r=>JSON.parse(r.log??'{}').calls??[]);
    assert.ok(attempts.some((a:any)=>a.kind==='INITIAL'&&JSON.stringify(a.response?.data)===JSON.stringify(firstRaw)));
    assert.ok(attempts.some((a:any)=>a.repairBase?.data?.assets?.[0]?.name==='甲'));
    await assert.rejects(queueFoundationDelivery(project.id,{},db));assert.equal(calls.length,2);
    console.log('PASS f2-bad-patch: same-object correct name cannot be altered while repairing type');continue;
   }
   assert.equal(state.complete,true,JSON.stringify({mode,error:state.task?.error,message:state.task?.message,issues:state.issues,todos:state.document.editorialTodos}));
   assert.equal(state.task?.error,null);assert.equal(state.requiredChoices.length,0,'Technical error is not a creative question');
   assert.equal(calls.length,3,mode+': original F2 + original Q1 + one same-role local patch');
   assert.equal(calls.filter(c=>c.stage==='F2'&&!c.local).length,1);assert.equal(calls.filter(c=>c.stage==='Q1'&&!c.local).length,1);assert.equal(calls.filter(c=>c.local).length,1);
   assert.deepEqual(await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}}),originalRows,'Original text and episode rows untouched');
   const finalScenes=await db.scriptScene.findMany({where:{episode:{projectId:project.id}},orderBy:{id:'asc'}});
   if(mode.startsWith('q1')){assert.deepEqual(finalScenes.filter(s=>s.sceneKey!=='1-1'),(originalSceneRows as typeof finalScenes).filter(s=>s.sceneKey!=='1-1'),'Unrelated scene fields/metadata/timestamps untouched');assert.equal(finalScenes.find(s=>s.sceneKey==='1-1')?.weather,'雨');assert.deepEqual(state.document.notes,['本次只完善第一场天气，其他资料原样保留。']);}
   else assert.deepEqual(finalScenes,originalSceneRows,'No-op Q1 never rewrites scene rows');
   const runs=await db.pipelineRun.findMany({where:{projectId:project.id},orderBy:{createdAt:'asc'}});
   const f2Evidence=runs.filter(r=>r.stageCode==='F2').flatMap(r=>JSON.parse(r.log??'{}').calls??[]);
   assert.ok(f2Evidence.some((call:any)=>call.kind==='INITIAL'&&JSON.stringify(call.response?.data)===JSON.stringify(firstRaw)),'Initial paid response retained unmodified');
   const allAttempts=runs.flatMap(r=>JSON.parse(r.log??'{}').calls??[]);assert.equal(allAttempts.filter((a:any)=>a.repairBase?.mode==='LOCAL_OBJECT').length,1,'Only one paid local repair persisted across recovery');
   const callCount=calls.length,runCount=runs.length;
   await assert.rejects(queueFoundationDelivery(project.id,{},db),/已整理完成/);
   await assert.rejects(executeFoundationDelivery(project.id,task.id,{db,stageRunner}),/已执行|状态已变化/);
   assert.equal(calls.length,callCount);assert.equal(await db.pipelineRun.count({where:{projectId:project.id}}),runCount,'Completed task cannot buy or queue redundant work');
   console.log('PASS '+mode+' controller same-role local patch, source+skill supply, preservation, completion and no repurchase');
  }
  assert.equal(interruptions,1);console.log('PASS 5 recovery scenarios + 1 unauthorized same-object patch rejection; no user DB, no real model, no publication acceptance');
 } finally {await db.$disconnect();const root=path.resolve(tmpdir()),target=path.resolve(directory);assert.ok(target.startsWith(root+path.sep)&&path.basename(target).startsWith('stage1-controller-acceptance-'));rmSync(target,{recursive:true,force:true});}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
