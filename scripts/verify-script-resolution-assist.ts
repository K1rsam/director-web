import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {PrismaClient} from '@prisma/client';
import * as service from '../lib/script-resolution-service';
import {createScriptResolutionJudgment} from '../lib/script-resolution-judgment';
import {applyScriptResolutions} from '../lib/script-resolution-plan';

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const hasCode=(code:string)=>(error:unknown)=>(error as {code?:string}).code===code;
const candidate=(tokens=14)=>({choice:{type:'CREATIVE_GUIDANCE' as const},note:'仅原句类型候选',usage:{inputTokens:tokens,outputTokens:3,totalTokens:tokens+3,stdout:'must-not-reach-ui',reasoning:'must-not-reach-ui'}});
async function main(){
 const directory=mkdtempSync(path.join(tmpdir(),'script-assist-')),file=path.join(directory,'test.db'),sql=new DatabaseSync(file);
 for(const name of readdirSync('prisma/migrations').sort())if(/^\d/.test(name))sql.exec(readFileSync(path.join('prisma/migrations',name,'migration.sql'),'utf8'));
 sql.close();const db=new PrismaClient({datasourceUrl:`file:${file}`});
 try{
  const user=await db.user.create({data:{username:'assist-reviewer',email:'assist@invalid.test',passwordHash:'synthetic-no-login'}});
  const raw='第一集\n提示：仅核对类型。\n备注：原文仍保留。\n△甲停住。';
  const project=await db.project.create({data:{title:'离线调用状态机',executionMode:'CLI',roles:{create:{userId:user.id,role:'REVIEWER'}},episodes:{create:Array.from({length:8},(_,i)=>({number:i+1,content:raw}))}}});
  const view=(number:number)=>service.readScriptReception(project.id,user.id,number,{db});
  const request=async(number:number)=>({episode:number,sourceVersion:(await view(number)).selected!.sourceVersion,expectedRevision:0,startLine:2,endLine:2});
  let calls=0;const one=await request(1),judge=async()=>{calls++;return candidate();};
  const first=await service.assistScriptResolution(project.id,user.id,one,{db,judge});
  const again=await service.assistScriptResolution(project.id,user.id,one,{db,judge});
  assert.equal(calls,1,'identical paid candidate is reused, never sent again');assert.equal(again.id,first.id);assert.equal(again.cached,true);
  const recovered=(await view(1)).selected!.assistance!.find(item=>item.id===first.id)!;
  assert.equal(recovered.status,'CANDIDATE');assert.deepEqual(recovered.choice,first.choice);assert.ok(!JSON.stringify(recovered).includes('must-not-reach-ui'));assert.equal(calls,1,'page GET never invokes a model');
  assert.equal(typeof (await view(1)).assistProviders!.jevConfigured,'boolean');assert.deepEqual(Object.keys((await view(1)).assistProviders!).sort(),['jevConfigured','project']);
  let unknownCalls=0;
  const noChoice=await service.assistScriptResolution(project.id,user.id,{...one,startLine:3,endLine:3},{db,judge:async()=>{unknownCalls++;return {choice:null,note:'证据不足，仍待人工核对',usage:{providerId:'jev',status:'review',code:'UNKNOWN_CHOICE',requestOutcome:'RESPONDED',inputTokens:11,outputTokens:2}};}});
  assert.equal(noChoice.status,'NO_SUGGESTION');assert.equal((noChoice.usage as {inputTokens:number}).inputTokens,11);
  assert.equal((await service.assistScriptResolution(project.id,user.id,{...one,startLine:3,endLine:3},{db,judge:async()=>{unknownCalls++;return candidate();}})).id,noChoice.id);assert.equal(unknownCalls,1);

  const two=await request(2),entered=deferred(),release=deferred();let concurrencyCalls=0;
  const running=service.assistScriptResolution(project.id,user.id,two,{db,judge:async()=>{concurrencyCalls++;entered.resolve();await release.promise;return candidate();}});
  await entered.promise;
  try{await assert.rejects(()=>service.assistScriptResolution(project.id,user.id,two,{db,judge:async()=>{concurrencyCalls++;return candidate();}}),hasCode('ASSIST_RUNNING'));assert.equal((await view(2)).selected!.assistance![0].status,'RUNNING');assert.equal(concurrencyCalls,1);}finally{release.resolve();}
  assert.equal((await running).status,'CANDIDATE');

  const three=await request(3),enteredOld=deferred(),releaseOld=deferred();let attempts=0;
  const late=service.assistScriptResolution(project.id,user.id,three,{db,judge:async()=>{attempts++;enteredOld.resolve();await releaseOld.promise;return candidate(77);}});
  await enteredOld.promise;
  const pointerRow=await db.sceneSnapshot.findFirstOrThrow({where:{projectId:project.id,sceneKey:'SCRIPT_RESOLUTION_ASSIST_CURRENT_V1',title:'3'}}),pointer=JSON.parse(pointerRow.content);
  await db.sceneSnapshot.update({where:{id:pointerRow.id},data:{content:JSON.stringify({...pointer,leaseUntil:'2000-01-01T00:00:00.000Z'})}});
  const orphan=(await view(3)).selected!.assistance![0];assert.equal(orphan.status,'UNKNOWN');assert.equal(orphan.retryAllowed,true);
  await assert.rejects(()=>service.assistScriptResolution(project.id,user.id,three,{db,judge}),hasCode('ASSIST_RETRY_REQUIRED'));
  await assert.rejects(()=>service.assistScriptResolution(project.id,user.id,{...three,retryAttemptId:'wrong-attempt',acknowledgeRisk:true},{db,judge}),hasCode('ASSIST_RETRY_STALE'));
  let replacement;
  try{replacement=await service.assistScriptResolution(project.id,user.id,{...three,retryAttemptId:orphan.id,acknowledgeRisk:true},{db,judge:async()=>{attempts++;return candidate(22);}});}finally{releaseOld.resolve();}
  const old=await late;assert.equal(old.status,'STALE');assert.equal(old.choice,null);assert.equal(attempts,2);assert.equal(replacement!.status,'CANDIDATE');
  assert.equal((await view(3)).selected!.assistance![0].id,replacement!.id,'late response cannot replace the newer attempt');
  const historical=JSON.parse((await db.sceneSnapshot.findUniqueOrThrow({where:{id:old.id}})).content);assert.equal(historical.judgment.choice.type,'CREATIVE_GUIDANCE');assert.equal(historical.usage.inputTokens,77);

  const four=await request(4);let errorCalls=0;
  const errored=await service.assistScriptResolution(project.id,user.id,four,{db,judge:async()=>{errorCalls++;throw Object.assign(new Error('provider transport unresolved'),{requestOutcome:'UNKNOWN'});}});
  assert.equal(errored.status,'UNKNOWN');assert.equal(errored.usage,null);
  await assert.rejects(()=>service.assistScriptResolution(project.id,user.id,four,{db,judge:async()=>{errorCalls++;return candidate();}}),hasCode('ASSIST_RETRY_REQUIRED'));assert.equal(errorCalls,1);
  const retried=await service.assistScriptResolution(project.id,user.id,{...four,retryAttemptId:errored.id,acknowledgeRisk:true},{db,judge:async()=>{errorCalls++;return candidate();}});assert.equal(retried.status,'CANDIDATE');assert.equal(errorCalls,2);
  assert.ok(await db.sceneSnapshot.findUnique({where:{id:errored.id}}));

  const five=await request(5);
  const stale=await service.assistScriptResolution(project.id,user.id,five,{db,judge:async()=>{await db.episode.updateMany({where:{projectId:project.id,number:5},data:{content:raw+'\n△新原文。'}});return candidate();}});
  assert.equal(stale.status,'STALE');assert.equal(stale.choice,null);assert.equal((await view(5)).selected!.assistance![0].status,'STALE');
  const six=await request(6);
  const revised=await service.assistScriptResolution(project.id,user.id,six,{db,judge:async()=>{await service.confirmScriptResolution(project.id,user.id,{episode:6,sourceVersion:six.sourceVersion,expectedRevision:0,choice:{startLine:3,endLine:3,type:'CREATIVE_GUIDANCE'}},{db});return candidate();}});
  assert.equal(revised.status,'STALE');assert.equal(revised.choice,null);

  const seven=await request(7);let jevCalls=0;
  await assert.rejects(()=>service.assistScriptResolution(project.id,user.id,{...seven,judgmentProvider:'JEV',explicitExternalConsent:false},{db,judge:async()=>{jevCalls++;return candidate();}}),hasCode('EXTERNAL_CONSENT'));assert.equal(jevCalls,0);
  const missing=await service.assistScriptResolution(project.id,user.id,{...seven,judgmentProvider:'JEV',explicitExternalConsent:true},{db,judge:createScriptResolutionJudgment({actorId:user.id,sourceVersion:seven.sourceVersion,explicitExternalConsent:true,readConfig:()=>({apiKey:null})})});
  assert.equal(missing.status,'NOT_SENT');assert.equal((missing.usage as {requestOutcome:string}).requestOutcome,'NOT_SENT');assert.equal(missing.choice,null);
  const local=await service.assistScriptResolution(project.id,user.id,seven,{db,judge:async()=>{jevCalls++;return candidate();}});assert.equal(local.status,'CANDIDATE');assert.equal(jevCalls,1,'provider scopes are separate; unavailable Jev does not fallback by itself');
  const eight=await request(8);
  await db.sceneSnapshot.create({data:{id:'legacy-unknown',projectId:project.id,sceneKey:'SCRIPT_RESOLUTION_ASSIST_V1',title:'8',content:JSON.stringify({schema:'SCRIPT_RESOLUTION_ASSIST_V1',id:'legacy-unknown',episode:8,sourceVersion:eight.sourceVersion,expectedRevision:0,status:'ERROR',choice:null,note:'缓存协议前的未知调用',usage:null,selection:{startLine:2,endLine:2}})}});
  assert.equal((await view(8)).selected!.assistance![0].id,'legacy-unknown');
  const resumed=await service.assistScriptResolution(project.id,user.id,{...eight,retryAttemptId:'legacy-unknown',acknowledgeRisk:true},{db,judge:async()=>candidate()});assert.equal(resumed.status,'CANDIDATE','legacy unknown receipts also have an explicit risk-bound recovery path');
  await db.sceneSnapshot.create({data:{id:'legacy-paid',projectId:project.id,sceneKey:'SCRIPT_RESOLUTION_ASSIST_V1',title:'8',content:JSON.stringify({schema:'SCRIPT_RESOLUTION_ASSIST_V1',id:'legacy-paid',episode:8,sourceVersion:eight.sourceVersion,expectedRevision:0,status:'CANDIDATE',choice:{startLine:3,endLine:3,type:'CREATIVE_GUIDANCE'},note:'旧协议已付候选，provider没有记录',usage:{totalTokens:12},selection:{startLine:3,endLine:3}})}});
  let legacyDuplicateCalls=0;await assert.rejects(()=>service.assistScriptResolution(project.id,user.id,{...eight,startLine:3,endLine:3},{db,judge:async()=>{legacyDuplicateCalls++;return candidate();}}),hasCode('ASSIST_LEGACY_CANDIDATE'));assert.equal(legacyDuplicateCalls,0,'missing old provider metadata must not silently justify a second project-model charge');

  const cli=await service.defaultScriptResolutionJudgment({projectId:project.id,episodeId:'unit',provider:'CLI',episode:1,startLine:2,endLine:2,lines:[{line:2,text:'提示：原句'}]},async()=>({data:{choice:null,note:'尚无建议'},sessionId:null,stdout:JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:20,cached_input_tokens:50}})+'\n'+JSON.stringify({type:'reasoning',text:'must-not-store'}),stderr:''}));
  assert.equal((cli.usage as {totalTokens:number}).totalTokens,120);assert.ok(!JSON.stringify(cli).includes('must-not-store'));assert.equal(cli.choice,null);
  const api=await service.defaultScriptResolutionJudgment({projectId:project.id,episodeId:'unit',provider:'API',episode:1,startLine:2,endLine:2,lines:[{line:2,text:'提示：原句'}]},async()=>({data:{choice:null,note:'尚无建议'},sessionId:null,stdout:'',stderr:'[DeepSeek synthetic-model 3ms prompt=30 completion=7 total=37 cache_hit=0 cache_miss=0 finish=stop request=synthetic]'}));
  assert.equal((api.usage as {totalTokens:number}).totalTokens,37);assert.equal((api.usage as {cachedInputTokens?:number|null}).cachedInputTokens??null,null,'provider placeholder zero is not verified cache usage');
  await db.project.update({where:{id:project.id},data:{executionMode:'API'}});
  const malformedApi=await service.assistScriptResolution(project.id,user.id,{...one,startLine:3,endLine:3},{db,judge:async()=>{throw Object.assign(new Error('JSON未闭合'),{requestOutcome:'RESPONDED',stderr:'JSON未闭合（finish_reason=length；prompt=41 completion=9 total=50；模型=synthetic-model）'});}});
  assert.equal(malformedApi.status,'ERROR');assert.equal((malformedApi.usage as {totalTokens:number}|null)?.totalTokens,50,'API parse failures retain readable provider usage too');
  const originalNote='审计原说明。'.repeat(180),longNote=await service.assistScriptResolution(project.id,user.id,one,{db,judge:async()=>({...candidate(),note:originalNote})});
  assert.ok(longNote.note.length<=800);assert.ok(JSON.parse((await db.sceneSnapshot.findUniqueOrThrow({where:{id:longNote.id}})).content).judgment.note===originalNote,'public brevity must not erase the old paid candidate note in its immutable audit');
  const grouped='人物：甲、乙\n甲：你好。乙：再见。\n提示：辅助待核对。';
  for(const type of ['ACTION','CREATIVE_GUIDANCE'] as const)assert.throws(()=>applyScriptResolutions(grouped,'group',[{startLine:2,endLine:2,type}],['甲','乙']),/多个说者|双说者|多说者/);
  const fixed=applyScriptResolutions(grouped,'group',[{startLine:3,endLine:3,type:'CREATIVE_GUIDANCE'}],['甲','乙']);assert.equal(fixed.plan.schemaVersion,'STANDARD_SCRIPT_PLAN_V2');assert.ok(fixed.compiled);
  await db.episode.updateMany({where:{projectId:project.id,number:8},data:{content:grouped}});let groupCalls=0;const groupSourceVersion=(await view(8)).selected!.sourceVersion;
  await assert.rejects(()=>service.assistScriptResolution(project.id,user.id,{...eight,sourceVersion:groupSourceVersion},{db,judge:async()=>{groupCalls++;return candidate();}}),hasCode('ASSIST_UNSUPPORTED_GROUP'));
  assert.equal(groupCalls,0,'a group that cannot be recast into one allowed type must not incur a useless call');
  for(const mixed of ['林岚os：到了。【字幕：旅客】','林岚：到了。【字幕：旅客】顾辰：收到。']){
   await db.episode.updateMany({where:{projectId:project.id,number:8},data:{content:mixed}});
   const mixedView=(await view(8)).selected!;let mixedCalls=0;
   await assert.rejects(()=>service.assistScriptResolution(project.id,user.id,{...eight,sourceVersion:mixedView.sourceVersion,startLine:1,endLine:1},{db,judge:async()=>{mixedCalls++;return candidate();}}),hasCode('ASSIST_UNSUPPORTED_GROUP'));
   assert.equal(mixedCalls,0,'typed mixed body and unsupported subtitle forms must be stopped before the judge call');
   for(const type of ['ACTION','DIALOGUE','CREATIVE_GUIDANCE'] as const)await assert.rejects(()=>service.confirmScriptResolution(project.id,user.id,{episode:8,sourceVersion:mixedView.sourceVersion,expectedRevision:0,choice:{startLine:1,endLine:1,type,...(type==='DIALOGUE'?{speaker:'林岚',channel:'OS'}:{})}},{db}),hasCode('UNSUPPORTED_MIXED_BODY'));
  }
  console.log('PASS assist scope cache, cross-window lock, stale lease/risk retry, late result CAS, immutable audits, source/revision stale, nullable semantic UNKNOWN, Jev consent/NOT_SENT/no fallback, safe CLI/API usage, explicit dialogue-group guard; isolated SQLite and fake providers only');
 }finally{await db.$disconnect();rmSync(directory,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
