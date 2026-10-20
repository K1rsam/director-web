import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {registerHooks} from 'node:module';
import {DatabaseSync} from 'node:sqlite';
import type {PrismaClient} from '@prisma/client';
import {suppressGeneratedPrismaEnv} from './compare-three-stage-support.mjs';

test('upstream read error propagation remains scoped to read-only service views',async t=>{
const directory=await mkdtemp(path.join(tmpdir(),'upstream-read-errors-')),database=path.join(directory,'synthetic.db');
const sqlite=new DatabaseSync(database);
for(const folder of (await readdir('prisma/migrations')).sort())if(/^\d/.test(folder))sqlite.exec(await readFile(path.join('prisma/migrations',folder,'migration.sql'),'utf8'));
sqlite.close();
process.env.DATABASE_URL=`file:${database}`;
let networkCalls=0;
globalThis.fetch=async()=>{networkCalls++;throw new Error('SYNTHETIC_ONLY_NO_NETWORK');};
registerHooks({
 resolve(specifier,context,next){return next(specifier==='server-only'?'next/dist/compiled/server-only/empty.js':specifier,context);},
 load(url,context,next){const loaded=next(url,context);return url.startsWith('file:')&&fileURLToPath(url)===path.resolve('node_modules/.prisma/client/index.js')?{...loaded,source:suppressGeneratedPrismaEnv(loaded.source?Buffer.from(loaded.source as Uint8Array).toString('utf8'):readFileSync(fileURLToPath(url),'utf8'))}:loaded;}
});
const {PrismaClient:TestPrismaClient}=await import('@prisma/client'),db=new TestPrismaClient({datasourceUrl:`file:${database}`});
(globalThis as typeof globalThis&{prisma:PrismaClient}).prisma=db;
t.after(async()=>{assert.equal(networkCalls,0);await db.$disconnect();await rm(directory,{recursive:true,force:true});});
const foundation=await import('../lib/foundation-delivery'),direction=await import('../lib/series-direction-service');
const {retryDatabaseRead}=await import('../lib/production-read-guard');
const {loadFoundationInputs}=await import('../lib/foundation-state'),{loadFoundationDocument}=await import('../lib/foundation-document');
const actor=await db.user.create({data:{username:'synthetic-read-errors',email:'read-errors@synthetic.invalid',passwordHash:'synthetic'}});
const project=await db.project.create({data:{title:'合成只读异常测试',executionMode:'CLI',episodes:{create:{number:1,title:'合成集',content:'1-1 日 内 屋\n人物：甲\n甲：请开门。\n△甲站起。'}},roles:{create:{userId:actor.id,role:'ADMIN'}}}});
const episode=await db.episode.findFirstOrThrow({where:{projectId:project.id}});
const input=await loadFoundationInputs(project.id,db),loaded=await loadFoundationDocument(db,project.id,input);
const failed=await db.pipelineRun.create({data:{projectId:project.id,stageCode:'SERIES_DIRECTION',roleName:'合成失败记录',status:'FAILED',inputSummary:'{}',outputSummary:'{}'}});
await db.sceneSnapshot.create({data:{id:`series-direction:${project.id}:current`,projectId:project.id,sceneKey:'SERIES_DIRECTION_CURRENT',content:JSON.stringify({schema:'SERIES_DIRECTION_POINTER_V1',sequence:0,draftId:null,currentId:null,revision:0,generationId:failed.id})}});

const transient=()=>[
 Object.assign(new Error('synthetic socket timeout'),{code:'P1008',cause:new Error('synthetic private cause')}),
 Object.assign(new Error('SQLITE_BUSY: synthetic read lock'),{code:'SQLITE_BUSY'}),
 Object.assign(new Error('synthetic busy read'),{code:'SQLITE_BUSY'}),
 Object.assign(new Error('synthetic locked read'),{code:'SQLITE_LOCKED'}),
 new Error('database is locked')
];
function readOnlyFault(target:PrismaClient,error:Error,point:'scenes'|'recovery'){
 let reached=0;const writes:string[]=[];
 const wrap=(client:object):any=>new Proxy(client,{get(value,key){
  const member=Reflect.get(value,key,value);
  if(key==='$transaction')return (fn:(tx:object)=>Promise<unknown>,options:object)=>member.call(value,(tx:object)=>fn(wrap(tx)),options);
  if(typeof key==='string'&&key.startsWith('$execute'))return ()=>{writes.push(key);throw new Error('READ_MUST_NOT_WRITE');};
  if(!member||typeof member!=='object')return typeof member==='function'?member.bind(value):member;
  return new Proxy(member,{get(delegate,method){const operation=Reflect.get(delegate,method,delegate);if(typeof operation!=='function')return operation;
   return (...args:unknown[])=>{
    if(/^(create|update|upsert|delete)/.test(String(method))){writes.push(`${String(key)}.${String(method)}`);throw new Error('READ_MUST_NOT_WRITE');}
    const where=(args[0] as {where?:{sceneKey?:{in?:string[]}}}|undefined)?.where;
    if(point==='scenes'&&key==='scriptScene'&&method==='findMany'||point==='recovery'&&key==='sceneSnapshot'&&method==='findMany'&&where?.sceneKey?.in?.includes('SERIES_DIRECTION_OUTPUT_REVIEW')){reached++;throw error;}
    return operation.apply(delegate,args);
   };
  }});
 }});
 return {client:wrap(target) as PrismaClient,reached:()=>reached,writes};
}

await t.test('loadLightScenes read failures propagate the exact transient error and cause',async()=>{
 for(const error of transient()){
  const f=readOnlyFault(db,error,'scenes');await assert.rejects(foundation.getFoundationDeliveryState(project.id,f.client,{input,loaded}),value=>value===error);
  assert.equal(f.reached(),1);assert.deepEqual(f.writes,[]);
 }
});
await t.test('non-transient scene/source failure retains the existing source.scenes diagnostic',async()=>{
 const error=Object.assign(new Error('场次来源需要重建'),{code:'SOURCE_PROTOCOL',cause:Object.assign(new Error('synthetic source cause'),{code:'P1008'})}),f=readOnlyFault(db,error,'scenes');
 const view=await foundation.getFoundationDeliveryState(project.id,f.client,{input,loaded});
 assert.ok(view.issues.some(issue=>issue.coordinate==='source.scenes'&&issue.severity==='MAJOR'));assert.equal(view.complete,false);assert.equal(f.reached(),1);assert.deepEqual(f.writes,[]);
});
await t.test('prepareRecovery read failures propagate raw transient errors rather than recoveryIssue/conflict',async()=>{
 for(const error of transient()){
  const f=readOnlyFault(db,error,'recovery');await assert.rejects(direction.getSeriesDirectionWorkspace(project.id,actor.id,{db:f.client}),value=>value===error);
  assert.equal(f.reached(),1);assert.deepEqual(f.writes,[]);
 }
});
await t.test('non-transient saved-source recovery failure remains a read diagnostic without writes',async()=>{
 const message='已保存调用与当前来源不一致，不能复用。',error=Object.assign(new Error(message),{code:'DIRECTION_RECOVERY'}),f=readOnlyFault(db,error,'recovery');
 const view=await direction.getSeriesDirectionWorkspace(project.id,actor.id,{db:f.client});
 assert.equal(view.generation?.resumable,false);assert.equal(view.generation?.recoveryIssue,message);assert.equal(f.reached(),1);assert.deepEqual(f.writes,[]);
});
const projections=[
 ['project',(client:PrismaClient)=>direction.readProjectSeriesDirectionProjection(project.id,{db:client})],
 ['episode',(client:PrismaClient)=>direction.readSeriesDirectionProjection(project.id,episode.id,{db:client})]
] as const;
for(const [scope,read] of projections)await t.test(`${scope} projection read preserves native transient transaction errors without retry`,async()=>{
 for(const error of transient()){
  let calls=0;const throwing={...db,$transaction:async()=>{calls++;throw error;}} as unknown as PrismaClient;
  await assert.rejects(read(throwing),value=>value===error);assert.equal(calls,1);
 }
});
await t.test('projection source/protocol conflicts remain rejected and are not retried by the outer read guard',async()=>{
 for(const [,read] of projections)for(const code of ['SOURCE_PROTOCOL','UPSTREAM_CHANGED','DIRECTION_STALE','DIRECTION_CONFLICT']){
  const error=Object.assign(new Error('synthetic source conflict'),{code,...(code==='SOURCE_PROTOCOL'?{cause:Object.assign(new Error('synthetic source cause'),{code:'P1008'})}:{})});
  let calls=0;const throwing={...db,$transaction:async()=>{calls++;throw error;}} as unknown as PrismaClient;
  await assert.rejects(retryDatabaseRead(()=>read(throwing)),value=>value===error);assert.equal(calls,1);
 }
});
await t.test('workspace read transaction preserves transient errors; write conflicts keep the old contract',async()=>{
 for(const error of transient()){
  const throwing={...db,$transaction:async()=>{throw error;}} as unknown as PrismaClient;
  await assert.rejects(direction.getSeriesDirectionWorkspace(project.id,actor.id,{db:throwing}),value=>value===error);
  await assert.rejects(direction.mutateSeriesDirection(project.id,actor.id,{action:'revoke',sourceVersion:'synthetic',stateToken:'synthetic'},{db:throwing}),value=>error.message.includes('SQLITE_BUSY')||error.message==='database is locked'?(value as {code?:string}).code==='DIRECTION_CONFLICT':value===error);
 }
 for(const code of ['P2002','P2034','P2028']){
  const error=Object.assign(new Error('synthetic write conflict'),{code}),throwing={...db,$transaction:async()=>{throw error;}} as unknown as PrismaClient;
  await assert.rejects(direction.mutateSeriesDirection(project.id,actor.id,{action:'revoke',sourceVersion:'synthetic',stateToken:'synthetic'},{db:throwing}),{code:'DIRECTION_CONFLICT'});
 }
});
});
