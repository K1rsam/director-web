import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { loadIndexedFoundationRuns, persistIndexedFoundationRunLog } from '../lib/foundation-evidence-index';

async function main() {
  const directory = mkdtempSync(path.join(tmpdir(),'foundation-evidence-index-'));
  const url = `file:${directory.replace(/\\/g,'/')}/test.db`;
  copyFileSync('prisma/schema.prisma',`${directory}/schema.prisma`);
  execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${directory}/schema.prisma`,'--skip-generate'],{env:{...process.env,DATABASE_URL:url,RUST_LOG:'info'},stdio:'pipe'});
  const db = new PrismaClient({datasourceUrl:url});
  let fullReads = 0, listReads = 0;
  const counted = Object.assign(Object.create(db), {pipelineRun: new Proxy(db.pipelineRun, {get(target,key) {
    const method = Reflect.get(target,key);
    if (key === 'findFirst') return (...args: unknown[])=>{fullReads++; return method.apply(target,args);};
    if (key === 'findMany') return (args: {select?:{log?:boolean}})=>{assert.ok(args.select && !args.select.log,'列表不得读取长log');listReads++;return method.call(target,args);};
    return typeof method === 'function' ? method.bind(target) : method;
  }})}) as Prisma.TransactionClient;
  try {
    const project = await db.project.create({data:{title:'evidence cache isolated'}});
    const run = await db.pipelineRun.create({data:{projectId:project.id,stageCode:'F2',roleName:'test',status:'SUCCEEDED',inputSummary:JSON.stringify({deliveryTaskId:'first-task'})}});
    const responded = JSON.stringify({calls:[{sequence:1,requestOutcome:'RESPONDED',providerCallCount:1,response:{rawOutput:'paid response',data:{valid:true}}}]});
    await persistIndexedFoundationRunLog(counted,run.id,{log:responded});
    const first = await loadIndexedFoundationRuns(counted,project.id,{fresh:false});
    const second = await loadIndexedFoundationRuns(counted,project.id,{fresh:false});
    assert.equal(fullReads,0,'写入已缓存，轮询只读短字段');
    assert.equal(first[0].log,responded); assert.equal(second[0].log,responded);
    const unknown = JSON.stringify({calls:[...JSON.parse(responded).calls,{sequence:2,requestOutcome:'UNKNOWN',providerCallCount:1}]});
    await persistIndexedFoundationRunLog(counted,run.id,{log:unknown});
    const next = await loadIndexedFoundationRuns(counted,project.id,{fresh:false});
    assert.equal(next[0].status,'SUCCEEDED');
    assert.equal(JSON.parse(next[0].log!).calls[1].requestOutcome,'UNKNOWN','同status追加UNKNOWN不得被旧cache隐藏');
    await db.pipelineRun.update({where:{id:run.id},data:{status:'FAILED'}});
    assert.equal((await loadIndexedFoundationRuns(counted,project.id,{fresh:false}))[0].status,'FAILED','状态每次新读');
    // An untracked old/test writer must never influence paid recovery through the display cache.
    const tampered = JSON.stringify({calls:[{sequence:1,requestOutcome:'UNKNOWN',providerCallCount:1,response:{data:{valid:false}}}]});
    await db.pipelineRun.update({where:{id:run.id},data:{log:tampered}});
    const fresh = await loadIndexedFoundationRuns(counted,project.id);
    assert.equal(fresh[0].log,tampered,'默认恢复读取必须绕过缓存重校验');
    assert.equal(fullReads,3,'UNKNOWN和FAILED状态的页面同样fresh');
    await persistIndexedFoundationRunLog(counted,run.id,{log:responded});
    const revalidated = await loadIndexedFoundationRuns(counted,project.id);
    assert.equal(JSON.parse(revalidated[0].inputSummary!).deliveryTaskId,'first-task','跨任务保留已付费来源绑定');
    assert.equal(JSON.parse(revalidated[0].log!).calls[0].response.data.valid,true,'恢复拿真实保存响应供现有validator重校验');
    assert.equal(fullReads,4);
    await db.pipelineRun.update({where:{id:run.id},data:{status:'SUCCEEDED'}});
    const legacy = await db.pipelineRun.create({data:{projectId:project.id,stageCode:'Q1',roleName:'legacy',status:'FAILED',log:responded}});
    await loadIndexedFoundationRuns(counted,project.id,{fresh:false});
    await db.pipelineRun.update({where:{id:legacy.id},data:{log:unknown}});
    assert.equal(JSON.parse((await loadIndexedFoundationRuns(counted,project.id,{fresh:false})).find(r=>r.id===legacy.id)!.log!).calls[1].requestOutcome,'UNKNOWN');
    assert.equal(fullReads,6,'旧无版本日志每次保守读取');
    console.log(`PASS evidence index: ${listReads} short listings; tracked polls zero long reads; default fresh, same-status UNKNOWN, legacy mutation and response provenance preserved`);
  } finally { await db.$disconnect(); rmSync(directory,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
