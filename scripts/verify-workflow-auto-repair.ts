/** Real controller + isolated SQLite; every provider response is an offline fixture. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '../lib/role-runner';

async function main() {
  const directory=mkdtempSync(path.join(tmpdir(),'workflow-auto-repair-'));
  const url=`file:${directory}/test.db`;
  process.env.DATABASE_URL=url;
  process.env.CODEX_CLI_PATH='/__offline_only__/no-real-codex';
  process.env.DEEPSEEK_API_KEY='';
  copyFileSync('prisma/schema.prisma',`${directory}/schema.prisma`);
  execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${directory}/schema.prisma`,'--skip-generate'],{env:{...process.env,RUST_LOG:'info'},stdio:'pipe'});
  const client=new PrismaClient({datasourceUrl:url});
  let queueConsumptionChecks=0;
  const db=client.$extends({query:{sceneSnapshot:{async updateMany({args,query}) {
    if(typeof args.where?.id==='string'&&args.where.id.startsWith('foundation-delivery-')&&typeof args.where.content==='string'&&typeof args.data.content==='string') {
      const previous=JSON.parse(args.where.content),next=JSON.parse(args.data.content);
      if(previous.phase==='REPAIR'&&next.repairRounds>previous.repairRounds) {
        const stored=await client.sceneSnapshot.findUniqueOrThrow({where:{id:args.where.id}});
        assert.equal(args.where.content,stored.content,'Consuming a repair queue must not mutate the task JSON used for CAS');
        assert.deepEqual(previous.scope,[1],'Persisted local scope survives consumption of the scheduling queue');
        assert.deepEqual(next.scope,[1]);
        queueConsumptionChecks++;
      }
    }
    return query(args);
  }}}}) as unknown as PrismaClient;
  const {queueFoundationDelivery,executeFoundationDelivery,getFoundationDeliveryState}=await import('../lib/foundation-delivery');
  const response=(data:unknown):RoleRunResult=>({data:data as Record<string,unknown>,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null});
  const first='第1集\n1-1 日 内 大厅\n人物：甲\n甲：出事了。\n△城外山顶，一座云台悬在半空。\n';
  const second='第2集\n2-1 夜 内 客厅\n人物：乙\n乙：此处是第二集的独有内容。\n';
  try {
    for(const unresolvedScope of [false,true]) {
      const project=await db.project.create({data:{title:`离线自动修复-${unresolvedScope}`,episodes:{create:[{number:1,content:first},{number:2,content:second}]}}});
      const originals=await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}});
      const task=await queueFoundationDelivery(project.id,{},db);
      const calls:{stage:string;phase:string;scope:number[]}[]=[];
      await executeFoundationDelivery(project.id,task.id,{db,stageRunner:async(stage,prompt)=>{
        const input=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
        calls.push({stage,phase:input.delivery?.mode,scope:input.scope});
        assert.notEqual(stage,'F1','Already structured fixture does not need source inference');
        if(stage==='F2')return response({format:'ASSET_CATALOG_V2',coverage:input.scope,assets:[]});
        if(input.delivery?.mode==='REPAIR') {
          assert.equal(unresolvedScope,false,'Unknown backend scope must never buy a repair call');
          assert.deepEqual(input.scope,[1]);
          assert.deepEqual(input.source.episodes.map((e:any)=>e.number),[1]);
          assert.ok(input.scenes.every((s:any)=>s.episode===1));
          assert.ok(!prompt.includes('此处是第二集的独有内容'),'Other episode source is not broadcast');
          const todos=[...(input.programTasks??[]),...(input.pendingChoices??[])];
          assert.equal(todos.length,1,'Only the local unresolved issue reaches the worker');
          return response({format:'FOUNDATION_OPTIMIZATION_V2',coverage:[1],changes:{sceneSplits:[{episode:1,sceneKey:'1-1',cuts:[{startLine:5,anchor:'△城外山顶，一座云台悬在半空。',location:'城外山顶',interiorExterior:'外',timeOfDay:'日'}]}]},resolvedUnresolved:todos.map((t:any)=>t.id)});
        }
        return response({format:'FOUNDATION_OPTIMIZATION_V2',coverage:input.scope,changes:{},unresolved:[{
          owner:'PROGRAM',key:'1-1',episodes:unresolvedScope?[]:[1],
          applicationScope:unresolvedScope?{kind:'UNRESOLVED'}:{kind:'SCENES',scenes:[{episode:1,sceneKey:'1-1'}]},
          note:unresolvedScope?'需要拆场，但尚未定位适用范围。':'1-1同时含大厅与城外，须拆场后分别承接。'
        }]});
      }});
      const state=await getFoundationDeliveryState(project.id,db);
      assert.equal(state.task?.error,null,state.task?.error??'');
      if(unresolvedScope) {
        assert.equal(calls.filter(c=>c.phase==='REPAIR').length,0);
        assert.equal(state.complete,false);
        assert.equal(state.requiredChoices.length,0,'Backend defects do not become author questions');
        assert.equal(calls.length,2);
      } else {
        assert.deepEqual(calls.map(c=>[c.stage,c.phase]),[['F2','GENERATE_F2'],['Q1','EDIT'],['Q1','REPAIR']]);
        assert.equal(state.complete,true,JSON.stringify({error:state.task?.error,message:state.task?.message,todos:state.document.editorialTodos}));
        assert.equal(state.document.editorialTodos.length,0);
        assert.equal(state.requiredChoices.length,0);
        const rows=await db.scriptScene.findMany({where:{episode:{projectId:project.id,number:1}},orderBy:{sortOrder:'asc'}});
        assert.deepEqual(rows.map(r=>r.sceneKey),['1-1','1-1__L5']);
        assert.equal(rows.map(r=>r.sourceText).join(''),first);
        assert.equal((await db.scriptScene.findMany({where:{episode:{projectId:project.id,number:2}}})).length,1);
      }
      assert.deepEqual(await db.episode.findMany({where:{projectId:project.id},orderBy:{number:'asc'}}),originals,'Automatic structural repair never rewrites source or episode timestamps');
    }
    for(const violation of ['scene','todo'] as const) {
      const raw=first+'1-2 夜 内 走廊\n甲：不要改此场。\n';
      const project=await db.project.create({data:{title:`拒绝越界-${violation}`,episodes:{create:[{number:1,content:raw},{number:2,content:second}]}}});
      const task=await queueFoundationDelivery(project.id,{},db);
      let attempted=0;
      let beforeRows:unknown;
      await executeFoundationDelivery(project.id,task.id,{db,stageRunner:async(stage,prompt)=>{
        const input=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
        if(stage==='F2')return response({format:'ASSET_CATALOG_V2',coverage:input.scope,assets:[]});
        if(input.delivery?.mode==='REPAIR') {
          attempted++;
          beforeRows??=await db.scriptScene.findMany({where:{episode:{projectId:project.id}},orderBy:{id:'asc'}});
          assert.deepEqual(input.delivery.targets.sceneKeys,['1-1']);
          const state=await getFoundationDeliveryState(project.id,db);
          const unrelated=state.document.editorialTodos.find(t=>t.key==='other-scene')!;
          assert.ok(unrelated);
          return response({format:'FOUNDATION_OPTIMIZATION_V2',coverage:[1],changes:violation==='scene'?{scenes:[{episode:1,sceneKey:'1-2',weather:'擅自下雨'}]}:{},
            ...(violation==='todo'?{resolvedUnresolved:[unrelated.id]}:{})});
        }
        return response({format:'FOUNDATION_OPTIMIZATION_V2',coverage:input.scope,changes:{},unresolved:[
          {owner:'PROGRAM',key:'split-scene',episodes:[1],applicationScope:{kind:'SCENES',scenes:[{episode:1,sceneKey:'1-1'}]},note:'1-1需要拆场。'},
          {owner:'Q1',key:'other-scene',episodes:[1],applicationScope:{kind:'SCENES',scenes:[{episode:1,sceneKey:'1-2'}]},note:'仅核对1-2天气。'}
        ]});
      }});
      assert.ok(attempted>0,'Negative case must actually reach a local repair receiver');
      const state=await getFoundationDeliveryState(project.id,db);
      assert.equal(state.complete,false);
      assert.equal(state.document.editorialTodos.length,2,'Rejected receipts must not close an unrelated todo');
      assert.deepEqual(await db.scriptScene.findMany({where:{episode:{projectId:project.id}},orderBy:{id:'asc'}}),beforeRows,'Rejected local edits must not mutate any scene');
      assert.equal((await db.episode.findFirstOrThrow({where:{projectId:project.id,number:1}})).content,raw);
      assert.ok(state.task?.error,'Receiver rejection must leave observable failure evidence');
    }
    assert.ok(queueConsumptionChecks>0,'The regression must observe a real post-consumption CAS update');
    console.log('PASS controller auto scene split, local episode supply, completion, exact source preservation, queue/task CAS isolation, unresolved nonbroadcast and rejection of unrelated scene/todo edits (offline isolated SQLite)');
  } finally {
    await db.$disconnect();
    const root=path.resolve(tmpdir()),target=path.resolve(directory);
    assert.ok(target.startsWith(root+path.sep)&&path.basename(target).startsWith('workflow-auto-repair-'));
    rmSync(target,{recursive:true,force:true});
  }
}
void main().catch(error=>{console.error(error);process.exitCode=1;});

