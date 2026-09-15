import assert from 'node:assert/strict';
import {copyFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {promptNeedsReview} from '../lib/asset-prompt-contract';

async function main(){
 const backup=process.argv[2];if(!backup)throw new Error('Provide consistent SQLite backup; only a copy is changed.');
 const directory=path.resolve('outputs/stage15-integrity-tests');await mkdir(directory,{recursive:true});
 const database=path.join(directory,`test-${Date.now()}.db`);await copyFile(backup,database);process.env.DATABASE_URL=`file:${database.replaceAll('\\','/')}`;
 const {prisma}=await import('../lib/prisma');
 const {loadAssetPromptWorkspace,generateAssetPrompt,saveAssetPrompt,saveAssetStyle}=await import('../lib/asset-prompt-service');
 try{
  const projectId=process.argv[3];if(!projectId)throw new Error('Provide a project ID present in the backup with a base character and a derived variant.');
  // Clear only prompt fixtures in the isolated copy, so this works with populated backups.
  await prisma.sceneSnapshot.deleteMany({where:{projectId,sceneKey:'ASSET_PROMPT_V1'}});
  const before=await prisma.sceneSnapshot.findMany({where:{projectId,sceneKey:{notIn:['ASSET_PROMPT_V1','ASSET_VISUAL_FACT_BATCH_V1','ASSET_VISUAL_FACT_CALL_V1']}},orderBy:{id:'asc'}});
  let workspace=await loadAssetPromptWorkspace(projectId);
  let base=workspace.assets.find(a=>a.eligible&&!a.variant&&a.type==='CH'&&workspace.assets.some(v=>v.variant&&v.eligible&&v.baseKey===a.key))!;
  let variant=workspace.assets.find(a=>a.eligible&&a.variant&&a.baseKey===base.key)!;assert.ok(base&&variant);
  const {ensureAssetVisualFacts}=await import('../lib/asset-visual-facts-service');
  await ensureAssetVisualFacts(projectId,async input=>{const {chunks,extracted}=JSON.parse(input.prompt);return {data:extracted??{batches:chunks.map((chunk:any)=>{const line=chunk.lines.find((l:any)=>l.text.trim());return {coveredChunkId:chunk.id,facts:line?[{subjectKey:base.baseKey,attribute:'test.fixture',value:'测试固定事实',scope:'STABLE',quote:line.text,chunkId:chunk.id,startLine:line.number,endLine:line.number},{subjectKey:base.baseKey,attribute:'test.variant',value:'测试版本事实',versionKey:variant.key,scope:'STATE',quote:line.text,chunkId:chunk.id,startLine:line.number,endLine:line.number}]:[],issues:[]};})},sessionId:null,stdout:'',stderr:''};});
  workspace=await loadAssetPromptWorkspace(projectId);base=workspace.assets.find(a=>a.key===base.key)!;variant=workspace.assets.find(a=>a.key===variant.key)!;
  const fake:Parameters<typeof generateAssetPrompt>[3]=async input=>({data:{key:JSON.parse(input.prompt).asset.key,body:'原版黑发设定',facts:'原版人物事实',suggestions:'原版设计建议'},sessionId:null,stdout:'',stderr:''});
  const initial=await generateAssetPrompt(projectId,base.key,0,fake);assert.equal(initial.status,'READY');assert.ok(initial.facts);
  const manual=await saveAssetPrompt(projectId,base.key,initial.revision,'用户改为白发造型');
  assert.equal(manual.facts,'');assert.equal(manual.suggestions,'');assert.equal(manual.rawOutput,undefined);assert.equal(manual.requestId,undefined);assert.equal(manual.workerPid,undefined);
  assert.equal(manual.previousDesignAudit?.at(-1)?.facts,initial.facts);assert.equal(manual.previousDesignAudit?.at(-1)?.rawOutput,initial.rawOutput);
  // Old app versions persisted stale AI provenance on manual records. Read-time
  // compatibility must prevent those already-saved rows from polluting children.
  const manualRow=await prisma.sceneSnapshot.findFirstOrThrow({where:{projectId,sceneKey:'ASSET_PROMPT_V1',title:base.key}});
  await prisma.sceneSnapshot.update({where:{id:manualRow.id},data:{content:JSON.stringify({...manual,facts:'旧版遗留错误事实',suggestions:'旧版建议',rawOutput:'旧版AI返回'})}});
  const legacyRead=(await loadAssetPromptWorkspace(projectId)).records[base.key];assert.equal(legacyRead.facts,'');assert.equal(legacyRead.previousDesignAudit?.at(-1)?.facts,'旧版遗留错误事实');
  let sourceFacts:string|undefined;
  const child=await generateAssetPrompt(projectId,variant.key,0,async input=>{sourceFacts=JSON.parse(input.prompt).referenceDesign.facts;return fake!(input);});
  assert.equal(child.status,'READY');assert.equal(sourceFacts,undefined);
  let loaded=await loadAssetPromptWorkspace(projectId);assert.equal(promptNeedsReview(variant,loaded.records,loaded.assets),false);
  for(const status of ['FAILED','RUNNING'] as const){
   const changed={...loaded.records,[base.key]:{...loaded.records[base.key],status}};
   assert.equal(promptNeedsReview(variant,changed,loaded.assets),true,`${status} source invalidates descendants even with same revision`);
  }
  assert.equal(promptNeedsReview(variant,{...loaded.records,[base.key]:{...manual,body:''}},loaded.assets),true,'Empty source is unavailable');
  const duringStyle=await generateAssetPrompt(projectId,base.key,manual.revision,async input=>{await saveAssetStyle(projectId,'生成期间切换水墨',loaded.styleRevision);return fake!(input);});
  assert.equal(duringStyle.status,'FAILED');assert.match(duringStyle.error,/画风已更新/);assert.equal(duringStyle.body,manual.body);assert.ok(duringStyle.rawOutput?.includes('原版人物事实'));
  loaded=await loadAssetPromptWorkspace(projectId);assert.equal(promptNeedsReview(variant,loaded.records,loaded.assets),true);
  assert.equal(loaded.records[base.key].rawOutput,duringStyle.rawOutput,'Failed new response remains available even after a manual design');
  // Restore a usable source, then change its status during a child request without a revision change.
  const restored=await saveAssetPrompt(projectId,base.key,duringStyle.revision,'用户确认的白发造型');
  const duringSource=await generateAssetPrompt(projectId,variant.key,child.revision,async input=>{
   const row=await prisma.sceneSnapshot.findFirstOrThrow({where:{projectId,sceneKey:'ASSET_PROMPT_V1',title:base.key}});
   await prisma.sceneSnapshot.update({where:{id:row.id},data:{content:JSON.stringify({...restored,status:'FAILED'})}});
   return fake!(input);
  });
  assert.equal(duringSource.status,'FAILED');assert.match(duringSource.error,/基础形象已修改或不可用/);assert.equal(duringSource.body,child.body);
  assert.deepEqual(await prisma.sceneSnapshot.findMany({where:{projectId,sceneKey:{notIn:['ASSET_PROMPT_V1','ASSET_VISUAL_FACT_BATCH_V1','ASSET_VISUAL_FACT_CALL_V1']}},orderBy:{id:'asc'}}),before);
  console.log('PASS: manual provenance cleared, descendant facts clean, failed/running/empty sources reviewed, style and source races rejected, prior content and foundation preserved; zero real model calls.');
 }finally{await prisma.$disconnect();}
}
void main().catch(error=>{console.error(error);process.exitCode=1;});
