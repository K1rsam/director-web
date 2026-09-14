/** Isolated controller regression; stageRunner is always an offline fixture. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import type { RoleRunResult } from '../lib/role-runner';

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(), 'decision-wait-controller-'));
  const url = `file:${directory.replace(/\\/g,'/')}/test.db`;
  process.env.DATABASE_URL = url;
  copyFileSync('prisma/schema.prisma', `${directory}/schema.prisma`);
  execFileSync(process.execPath, [path.resolve('node_modules/prisma/build/index.js'),'db','push','--schema',`${directory}/schema.prisma`,'--skip-generate'], {cwd:directory,env:{...process.env,RUST_LOG:'info'},stdio:'pipe'});
  const db = new PrismaClient({datasourceUrl:url});
  const {queueFoundationDelivery, executeFoundationDelivery, getFoundationDeliveryState} = await import('../lib/foundation-delivery');
  const response = (data:unknown):RoleRunResult => ({data:data as Record<string,unknown>,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null});
  const source = '第1集\n1-1 日 内 大厅\n人物：甲\n甲：出事了。\n△甲看向墙上的图画和门边的石台。\n';
  const choice = {decisionKey:'image-style',kind:'PRODUCTION_CHOICE',question:'图画采用哪种材质？',reason:'本阶段制作必需',options:['金属图面','石质图面'],recommended:'金属图面',recommendationReason:'清晰',evidence:'原文未规定材质',episodes:[1]};
  try {
    for (const independent of [false,true]) {
      const project = await db.project.create({data:{title:`等待选择-${independent}`,episodes:{create:[{number:1,content:source}]}}});
      const task = await queueFoundationDelivery(project.id,{},db);
      const calls:{stage:string;phase:string}[] = [];
      await executeFoundationDelivery(project.id,task.id,{db,stageRunner:async(stage,prompt)=>{
        const input = JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);
        const phase = input.delivery.mode; calls.push({stage,phase});
        assert.ok(!input.repairRequest,'No format repair is expected');
        if (stage === 'F2') return response({format:'ASSET_CATALOG_V2',coverage:[1],humanChoices:[choice],assets:[
          {name:'图画',type:'PROP',episodes:[1],sceneRefs:[[1,'1-1']],preparation:{mode:'UNRESOLVED',note:'材质需用户选择，见humanChoices'}},
          ...(independent ? [{name:'石台',type:'PROP',episodes:[1],sceneRefs:[],preparation:{mode:'REFERENCE'}}] : [])
        ]});
        const rows = await db.presentationContract.findMany({where:{projectId:project.id}});
        if (phase !== 'REPAIR') {
          assert.ok(rows.some(row=>row.status==='SUGGESTED'),'F2 persists its human choice as a suggestion before Q1');
          return response({format:'FOUNDATION_OPTIMIZATION_V2',coverage:[1],changes:{},humanChoices:[choice]});
        }
        assert.equal(independent,true,'Waiting choice alone must never invoke REPAIR');
        assert.equal(calls.filter(call=>call.phase==='REPAIR').length,1);
        const assets = input.candidates.f2.assets;
        const waiting = assets.find((asset:any)=>asset.name==='图画');
        const other = assets.find((asset:any)=>asset.name==='石台');
        assert.ok(input.repairIssues.length > 0);
        assert.ok(input.repairIssues.every((issue:any)=>issue.coordinate!==`assets.${waiting.key}.preparation`),'The real repair request excludes the waiting preparation');
        assert.deepEqual(input.delivery.targets.keys,[other.key],'Only the independent asset is targeted');
        return response({format:'FOUNDATION_OPTIMIZATION_V2',coverage:[1],changes:{assets:[{key:other.key,sceneRefs:[[1,'1-1']]}]}});
      }});
      const state = await getFoundationDeliveryState(project.id,db);
      assert.equal(state.task?.error,null,state.task?.error ?? '');
      assert.equal(state.task?.status,'WAITING_USER');
      assert.equal(state.requiredChoices.length,1);
      assert.deepEqual(calls.map(call=>call.stage),independent?['F2','Q1','Q1']:['F2','Q1']);
      assert.equal(calls.filter(call=>call.phase==='REPAIR').length,independent?1:0);
      assert.equal(await db.pipelineRun.count({where:{projectId:project.id}}),independent?3:2);
      assert.equal((await db.episode.findFirstOrThrow({where:{projectId:project.id}})).content,source);
    }
    console.log('PASS real isolated controller: F2 suggestion + repeated Q1 choice waits with zero REPAIR; independent repair completes with choice preserved; source exact');
  } finally {await db.$disconnect();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
