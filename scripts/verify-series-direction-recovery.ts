import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync, readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {registerHooks} from 'node:module';
import {fileURLToPath} from 'node:url';
import {suppressGeneratedPrismaEnv} from './compare-three-stage-support.mjs';

async function main() {
const directory = mkdtempSync(path.join(tmpdir(), 'direction-recovery-'));
const database = path.join(directory, 'synthetic.db');
const sqlite = new DatabaseSync(database);
for (const folder of readdirSync('prisma/migrations').sort()) if (/^\d/.test(folder)) sqlite.exec(readFileSync(path.join('prisma/migrations', folder, 'migration.sql'), 'utf8'));
sqlite.close();
process.env.DATABASE_URL = `file:${database}`;
globalThis.fetch = async () => {throw new Error('SYNTHETIC_ONLY_NO_NETWORK');};
let guarded = false;
registerHooks({
  resolve(specifier, context, next) {return next(specifier === 'server-only' ? 'next/dist/compiled/server-only/empty.js' : specifier, context);},
  load(url, context, next) {
    const loaded = next(url, context);
    if (url.startsWith('file:') && fileURLToPath(url) === path.resolve('node_modules/.prisma/client/index.js')) {
      guarded = true;
      return {...loaded, source: suppressGeneratedPrismaEnv(loaded.source ? Buffer.from(loaded.source as Uint8Array).toString('utf8') : readFileSync(fileURLToPath(url), 'utf8'))};
    }
    return loaded;
  },
});
const {PrismaClient} = await import('@prisma/client');
assert(guarded);
const db = new PrismaClient({datasourceUrl: `file:${database}`});
(globalThis as any).prisma = db;
const api = await import('../lib/series-direction-service');
const content = {settingTags:['都市'],mechanismTags:[],arcTags:['相互信任'],primaryTone:'克制温情',secondaryTones:['轻喜剧'],audiencePromise:'共同化解误会。',expressionRules:['原文优先。'],avoidances:['不提前揭示。'],episodeFlexibility:'允许局部紧张。'};
const usage = {inputTokens:10,cachedInputTokens:0,uncachedInputTokens:10,outputTokens:2,reasoningOutputTokens:null,totalTokens:12,recordedCalls:1,newRequests:1,reusedCalls:0,unknownCalls:0};
const answer = (data: unknown) => ({data,rawOutput:JSON.stringify(data),stdout:JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:2,cached_input_tokens:0}}),stderr:'',sessionId:null});
const evidence = (units: any[]) => ({coverage:units.map(u=>u.id),summary:'人物共同解决误会。',evidence:units.map(u=>({unitId:u.id,quote:u.text.slice(0,18),signal:'原文中发生的行为。'})),knowledge:units.slice(0,1).map(u=>({unitId:u.id,kind:'CHANGE',claim:'SOURCE',statement:'甲提出请求。',subjects:['甲'],quote:'甲：请开门。',start:999}))});

async function seed(label: string) {
  const actor = await db.user.create({data:{username:`direction-${label}`,email:`${label}@synthetic.invalid`,passwordHash:'unused-synthetic'}});
  const project = await db.project.create({data:{title:`方向恢复${label}`,executionMode:'CLI',episodes:{create:Array.from({length:13},(_,i)=>({number:i+1,title:`第${i+1}集`,content:`${i+1}-1 日 内 屋\n人物：甲\n甲：请开门。\n▲甲推开门。`}))},roles:{create:{userId:actor.id,role:'ADMIN'}}}});
  const get = () => api.getSeriesDirectionWorkspace(project.id,actor.id,{db});
  const initial = await get();
  // Capture the real canonical source manifest, then explicitly seed a legacy failure in this disposable DB.
  await api.generateSeriesDirectionCandidate(project.id,actor.id,{action:'generate',stateToken:initial.stateToken,sourceVersion:initial.source.sourceVersion,costAcknowledged:true},{db,runner:async()=>{throw new Error('fixture interruption before provider');}});
  const run = await db.pipelineRun.findFirstOrThrow({where:{projectId:project.id,stageCode:'SERIES_DIRECTION'}});
  const packet = await db.sceneSnapshot.findFirstOrThrow({where:{projectId:project.id,sceneKey:'SERIES_DIRECTION_MODEL_INPUT'}});
  const saved = JSON.parse(packet.content);
  const parts = saved.units.map((u:any)=>({...u,id:`${u.id}/part-1-of-1`,sourceOffset:0}));
  const legacyBatches = [parts.slice(0,6),parts.slice(6,12),parts.slice(12)];
  await db.sceneSnapshot.update({where:{id:packet.id},data:{content:JSON.stringify({source:saved.source,units:saved.units})}});
  await db.pipelineRun.update({where:{id:run.id},data:{status:'FAILED',error:'DIRECTION_MODEL_EVIDENCE',inputSummary:JSON.stringify({actorId:actor.id,sourceVersion:initial.source.sourceVersion,planned:{batches:3,calls:4,allowed:true},sessionMode:'ephemeral'}),outputSummary:JSON.stringify({phase:'evidence',completedCalls:1,totalCalls:4,outcome:'UNKNOWN',message:'legacy coordinate error',usage:{...usage,totalTokens:24,inputTokens:20,outputTokens:4,recordedCalls:2,newRequests:2},callUsage:[1,2].map(call=>({call,provider:'CLI',usage}))})}});
  const outputs = [];
  for (let i=0;i<2;i++) outputs.push(await db.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'SERIES_DIRECTION_MODEL_OUTPUT',title:`legacy paid ${i+1}`,metadata:JSON.stringify({runId:run.id,call:i+1}),content:JSON.stringify({data:evidence(legacyBatches[i]),rawOutput:JSON.stringify(evidence(legacyBatches[i]))})}}));
  return {project,actor,runId:run.id,get,outputs,packetId:packet.id,legacyBatches};
}
const resume = (fixture: Awaited<ReturnType<typeof seed>>, view: any, runner: any) => api.generateSeriesDirectionCandidate(fixture.project.id,fixture.actor.id,{action:'resume',stateToken:view.stateToken,sourceVersion:view.source.sourceVersion,costAcknowledged:true} as any,{db,runner});

try {
  const fixture = await seed('success');
  const beforeRun = await db.pipelineRun.findUniqueOrThrow({where:{id:fixture.runId}});
  const beforeOutputs = await db.sceneSnapshot.findMany({where:{id:{in:fixture.outputs.map(o=>o.id)}},orderBy:{id:'asc'}});
  let view = await fixture.get();
  assert.equal(view.generation!.pending,false,'a failed, exited request is not running');
  assert.equal((view.generation as any).resumable,true,'unique exact quotes with wrong legacy offsets are replayable without another provider call');
  assert.equal((view.generation as any).reusableCalls,2);
  const sent: any[]=[];
  view = await resume(fixture,view,async(input:any)=>{const p=JSON.parse(input.prompt.split('INPUT_JSON:\n')[1]);sent.push(p);return answer(p.phase==='evidence'?evidence(p.units):{content});});
  assert.equal(sent.length,2,'only the remaining source batch and synthesis are new calls');
  assert.deepEqual(sent[0].units.map((u:any)=>u.id),fixture.legacyBatches[2].map((u:any)=>u.id));
  assert.equal(view.draft!.status,'DRAFT'); assert.equal(view.current,null); assert.deepEqual(view.draft!.reviewedEpisodeIds,[]);
  assert.equal(view.generation!.completedCalls,2); assert.equal((view.generation as any).reusedCalls,2);
  assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({where:{id:fixture.runId}}),beforeRun,'old failure remains unchanged');
  assert.deepEqual(await db.sceneSnapshot.findMany({where:{id:{in:fixture.outputs.map(o=>o.id)}},orderBy:{id:'asc'}}),beforeOutputs);
  assert.equal(view.draft!.knowledgeIndex?.every(k=>k.claim==='CHARACTER_CLAIM'),true,'quoted dialogue remains a claim after coordinate correction');
  console.log('PASS known paid-prefix replay, no duplicate charges, immutable history and unconfirmed candidate');

  // A second stopped run flattens the original references; it never purchases the accepted prefix again.
  for(const chainMode of ['unchanged','late_review']) {
  const chained=await seed(`chained-${chainMode}`);let chainedView=await chained.get();
  let chainCalls=0;
  chainedView=await resume(chained,chainedView,async(input:any)=>{
    chainCalls++;const p=JSON.parse(input.prompt.split('INPUT_JSON:\n')[1]);
    if(p.phase==='evidence')return answer(evidence(p.units));
    // Preserve a valid final response but simulate a local persistence interruption after the provider returned.
    await db.$executeRawUnsafe("CREATE TRIGGER synthetic_fail_card BEFORE INSERT ON SceneSnapshot WHEN NEW.sceneKey='SERIES_DIRECTION_CARD' BEGIN SELECT RAISE(ABORT,'synthetic card write interruption'); END");
    return answer({content});
  });
  await db.$executeRawUnsafe('DROP TRIGGER synthetic_fail_card');
  assert.equal(chainCalls,2);assert.equal(chainedView.generation!.status,'FAILED');
  assert.equal(chainedView.generation!.resumable,true);assert.equal(chainedView.generation!.reusableCalls,4);
  assert.equal(chainedView.generation!.remainingCalls,0,'the saved synthesis can be committed without another provider call');
  if(chainMode==='late_review') {
    const output=chained.outputs[0],changed=evidence(chained.legacyBatches[0]);changed.knowledge[0].statement='甲请求开门。';
    const afterReview=await api.reviewSeriesDirectionResponse(chained.project.id,chained.actor.id,{stateToken:chainedView.stateToken,sourceVersion:chainedView.source.sourceVersion,generationId:chainedView.generation!.id,outputId:output.id,outputHash:createHash('sha256').update(JSON.stringify(output.content)).digest('hex'),correctedData:changed,purpose:'综合已返回后收窄角色请求的表述；旧综合没有消费本次修正。'},{db});
    assert.equal(afterReview.generation!.resumable,false,'a saved synthesis must not be mixed with later reviewed evidence');
    let attempts=0;await assert.rejects(()=>resume(chained,afterReview,async()=>{attempts++;throw new Error('must not rebuy');}));assert.equal(attempts,0);
    continue;
  }
  const beforeResume=await db.pipelineRun.findUniqueOrThrow({where:{id:chainedView.generation!.id}});
  let zeroCalls=0;
  chainedView=await resume(chained,chainedView,async()=>{zeroCalls++;throw new Error('never resend saved synthesis');});
  assert.equal(zeroCalls,0);assert.equal(chainedView.generation!.status,'SUCCEEDED');
  assert.equal(chainedView.generation!.reusedCalls,4);assert.equal(chainedView.generation!.completedCalls,0);
  assert.deepEqual(await db.pipelineRun.findUniqueOrThrow({where:{id:beforeResume.id}}),beforeResume);
  assert.equal(chainedView.current,null);
  }
  console.log('PASS multi-generation replay and saved synthesis reuse with zero new calls');

  const reviewed=await seed('explicit_review'),badRow=reviewed.outputs[1];
  const bad=JSON.parse(badRow.content);bad.data.evidence[0].quote='这不是原稿中的话。';
  await db.sceneSnapshot.update({where:{id:badRow.id},data:{content:JSON.stringify(bad)}});
  const badSaved=await db.sceneSnapshot.findUniqueOrThrow({where:{id:badRow.id}}),rawHash=createHash('sha256').update(JSON.stringify(badSaved.content)).digest('hex');
  let reviewedView=await reviewed.get();assert.equal(reviewedView.generation!.resumable,false);
  const corrected=evidence(reviewed.legacyBatches[1]);
  const reviewCommand={stateToken:reviewedView.stateToken,sourceVersion:reviewedView.source.sourceVersion,generationId:reviewed.runId,outputId:badRow.id,outputHash:rawHash,correctedData:corrected,purpose:'逐字对照本批原稿，修正首条引文抄写错误；不改原回包，不确认全剧方向。'};
  await assert.rejects(()=>api.reviewSeriesDirectionResponse(reviewed.project.id,reviewed.actor.id,{...reviewCommand,outputHash:'wrong'},{db}));
  reviewedView=await api.reviewSeriesDirectionResponse(reviewed.project.id,reviewed.actor.id,reviewCommand,{db});
  assert.equal(reviewedView.generation!.resumable,true);assert.equal(reviewedView.draft,null);assert.equal(reviewedView.current,null);
  assert.notEqual(reviewedView.stateToken,reviewCommand.stateToken);
  await assert.rejects(()=>api.reviewSeriesDirectionResponse(reviewed.project.id,reviewed.actor.id,reviewCommand,{db}),'review CAS is single-use');
  assert.deepEqual(await db.sceneSnapshot.findUniqueOrThrow({where:{id:badRow.id}}),badSaved,'literal review is a separate immutable snapshot');
  const rview=await resume(reviewed,reviewedView,async(input:any)=>{const p=JSON.parse(input.prompt.split('INPUT_JSON:\n')[1]);return answer(p.phase==='evidence'?evidence(p.units):{content});});
  assert.equal(rview.generation!.status,'SUCCEEDED');
  const replayManifest=await db.sceneSnapshot.findFirstOrThrow({where:{projectId:reviewed.project.id,sceneKey:'SERIES_DIRECTION_MODEL_INPUT'},orderBy:{createdAt:'desc'}});
  assert(JSON.parse(replayManifest.content).reusedResponses.some((ref:any)=>ref.outputId===badRow.id&&ref.reviewId&&ref.reviewHash),'actual request manifest pins reviewed evidence');
  console.log('PASS explicit authorized source-bound review repairs a saved response without overwriting it or approving the direction');

  for (const condition of ['unknown','source_changed','ambiguous','missing_output','duplicate_output','foreign_part','reference_hash','duplicate_reference'] as const) {
    const f = await seed(condition);
    if (condition==='unknown') {const r=await db.pipelineRun.findUniqueOrThrow({where:{id:f.runId}});const s=JSON.parse(r.outputSummary!);s.callUsage[1].usage={...usage,unknownCalls:1,totalTokens:null};await db.pipelineRun.update({where:{id:f.runId},data:{outputSummary:JSON.stringify(s)}});}
    if (condition==='source_changed') {const e=await db.episode.findFirstOrThrow({where:{projectId:f.project.id,number:13}});await db.episode.update({where:{id:e.id},data:{content:e.content+'\n▲新的动作。'}});}
    if (condition==='ambiguous') {const o=f.outputs[1];const data=JSON.parse(o.content);data.data.knowledge[0].quote='甲';await db.sceneSnapshot.update({where:{id:o.id},data:{content:JSON.stringify(data)}});}
    if (condition==='missing_output') await db.sceneSnapshot.delete({where:{id:f.outputs[1].id}});
    if(condition==='duplicate_output')await db.sceneSnapshot.create({data:{projectId:f.project.id,sceneKey:'SERIES_DIRECTION_MODEL_OUTPUT',metadata:f.outputs[1].metadata,content:f.outputs[1].content}});
    if(['foreign_part','reference_hash','duplicate_reference'].includes(condition)) {
      const packet=await db.sceneSnapshot.findUniqueOrThrow({where:{id:f.packetId}}),value=JSON.parse(packet.content);
      value.schema='SERIES_DIRECTION_MODEL_INPUT_V2';value.modelBatches=f.legacyBatches;value.reusedResponses=[];value.programRecords=[];
      if(condition==='foreign_part')value.modelBatches[0][0]={...value.modelBatches[0][0],id:'another-source'};
      else value.reusedResponses=[{runId:f.runId,call:1,outputId:f.outputs[0].id,outputHash:condition==='reference_hash'?'tampered':createHash('sha256').update(JSON.stringify(f.outputs[0].content)).digest('hex')}];
      await db.sceneSnapshot.update({where:{id:f.packetId},data:{content:JSON.stringify(value)}});
    }
    const v=await f.get();assert.equal(v.generation!.pending,false);assert.equal((v.generation as any).resumable,false,condition);
    let attempts=0;await assert.rejects(()=>resume(f,v,async()=>{attempts++;throw new Error('must not call');}));assert.equal(attempts,0,condition);
  }
  console.log('PASS unknown usage, changed source, ambiguous quote, incomplete/duplicate output, foreign part and tampered/duplicate replay reference stop before dispatch');
} finally {await db.$disconnect();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
