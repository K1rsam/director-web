import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PrismaClient} from '@prisma/client';
async function main(){
 const dir=mkdtempSync(path.join(tmpdir(),'mixed-fragments-'));const url=`file:${dir}/test.db`;process.env.DATABASE_URL=url;
 copyFileSync('prisma/schema.prisma',`${dir}/schema.prisma`);execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--schema',`${dir}/schema.prisma`,'--skip-generate'],{env:{...process.env,RUST_LOG:'info'},stdio:'pipe'});
 const db=new PrismaClient({datasourceUrl:url});
 try{
  const {queueFoundationDelivery,executeFoundationDelivery,getFoundationDeliveryState}=await import('../lib/foundation-delivery');
  const episodes=[1,2,3,4].map(number=>({number,title:`第${number}集`,content:`第${number}集\n${number}-1 客厅 日 内\n人物：张三\n`+'张三：他转身离开。\n'.repeat(number===2?1500:2)+(number===2?'2-2 门外 日 外\n'+'张三：他转身离开。\n'.repeat(1800)+'△张三受伤，右手伤口流血。\n':number===3?'张三：右手还不能动。\n':'')}));
  const project=await db.project.create({data:{title:'混合长短稿',episodes:{create:episodes}}});
  const seen:{stage:string;scope:number[];fragment?:{start:number;end:number};text:string}[]=[];
  const task=await queueFoundationDelivery(project.id,{},db);
  let failSave=false,injected=false;
  const failingDb=db.$extends({query:{sceneSnapshot:{create({args,query}){if(args.data.sceneKey==='FOUNDATION_DOCUMENT'&&failSave){failSave=false;throw new Error('paid fragment save failure');}return query(args);}}}}) as unknown as PrismaClient;
  const runner=async(stage:'F1'|'F2'|'Q1',prompt:string)=>{
   const input=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);const scope=input.scope as number[];
   if(scope.includes(3)){assert.deepEqual(scope,[3,4]);const historical=input.facts.format==='FACT_TABLE_V1'?input.facts.groups.historicalStates.map((i:number)=>input.facts.rows[i]):input.facts.historicalStates;assert.match(JSON.stringify(historical),/受伤|伤口/,'后短集必须收到中间长集的受伤状态');assert.ok(input.boundaryContext,'后短集必须收到长集前接上下文');if(stage==='F2'){const saved=await getFoundationDeliveryState(project.id,db);assert.ok(saved.document.f2?.coverage.includes(2),'先完成中间长集再生成后短批');}}
   seen.push({stage,scope,fragment:input.fragment,text:input.source.episodes.map((e:{lines:[number,string][]})=>e.lines.map(([,text])=>text).join('')).join('')});
   const key=input.registry?.find((a:{name:string})=>a.name==='张三')?.key;
   const data=stage==='F2'?{format:'ASSET_CATALOG_V2',coverage:scope,assets:[{...(key?{key}:{}),name:'张三',type:'CH',episodes:scope,sceneRefs:input.scenes.map((s:{episode:number;sceneKey:string})=>({episode:s.episode,sceneKey:s.sceneKey})),preparation:{mode:'REFERENCE'}}]}:{format:'FOUNDATION_OPTIMIZATION_V2',coverage:scope,changes:{}};
   if(stage==='F2'&&input.fragment&&!injected){injected=true;failSave=true;}
   return {data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null};
  };
  await executeFoundationDelivery(project.id,task.id,{db:failingDb,stageRunner:runner});
  const interrupted=await getFoundationDeliveryState(project.id,db);assert.match(interrupted.task?.error??'',/paid fragment save failure/);
  const recovery=await queueFoundationDelivery(project.id,{},db);await executeFoundationDelivery(project.id,recovery.id,{db,stageRunner:runner});
  const state=await getFoundationDeliveryState(project.id,db);assert.equal(state.task?.status,'COMPLETE',state.task?.error??'');
  for(const stage of ['F2','Q1']){const calls=seen.filter(c=>c.stage===stage);const short=calls.filter(c=>!c.fragment);assert.equal(short.length,2);assert.deepEqual(short.map(c=>c.scope),[[1],[3,4]]);const long=calls.filter(c=>c.fragment);assert.ok(long.length>1);assert.ok(long.every(c=>c.scope.length===1&&c.scope[0]===2));assert.equal(long.map(c=>c.text).join(''),episodes[1].content);assert.ok(calls.indexOf(short[1])>calls.indexOf(long.at(-1)!),'短/长按源顺序执行');}
  assert.deepEqual(state.document.editorialCoverage,[1,2,3,4]);
  const {syncFoundationChoices}=await import('../lib/foundation-choice-store');
  await syncFoundationChoices(db,project.id,state.document.sourceVersion,'Q1',[{decisionKey:'local-key',kind:'PRODUCTION_CHOICE',question:'第一场制作采用哪种方向',reason:'第一场制作取舍',episodes:[2],applicationScope:{kind:'SCENES',scenes:[{episode:2,sceneKey:'2-1'}]},options:['保持原文','另作备注'],recommended:'保持原文',recommendationReason:'不改正文',evidence:'第一场'}]);
  const choice=await db.presentationContract.findFirstOrThrow({where:{projectId:project.id}});await db.presentationContract.update({where:{id:choice.id},data:{status:'CONFIRMED',userAnswer:'保持原文',decidedAt:new Date()}});
  const continued=await queueFoundationDelivery(project.id,{},db);const localCalls:{stage:string;start:number;end:number}[]=[];
  await executeFoundationDelivery(project.id,continued.id,{db,stageRunner:async(stage,prompt)=>{const input=JSON.parse(prompt.split('INPUT_JSON:\n').at(-1)!);localCalls.push({stage,start:input.fragment?.start,end:input.fragment?.end});const data={format:'FOUNDATION_OPTIMIZATION_V2',coverage:input.scope,changes:{},appliedDecisions:input.confirmedDecisions.map((d:{id:string})=>({id:d.id,note:'该场已按原文保留'}))};return {data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null};}});
  const resumed=await getFoundationDeliveryState(project.id,db);assert.equal(resumed.task?.status,'COMPLETE',resumed.task?.error??'');assert.equal(localCalls.length,1);assert.equal(localCalls[0].stage,'Q1');assert.equal(localCalls[0].start,0);assert.ok(localCalls[0].end<episodes[1].content.length);
  console.log('PASS actual controller mixed long/short: source-ordered [1], long 2, [3,4]; later short batch receives injury state and previous boundary; paid slice recovery; scene-scoped decision rechecks only affected slice');
 }finally{await db.$disconnect();const resolved=path.resolve(dir);if(!resolved.startsWith(path.resolve(tmpdir())+path.sep))throw new Error('cleanup boundary');rmSync(resolved,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
