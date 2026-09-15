import assert from 'node:assert/strict';
import {copyFileSync,mkdirSync} from 'node:fs';
import path from 'node:path';
async function main(){
 assert.ok(process.argv[2],'Pass consistent SQLite backup');mkdirSync('outputs/stage15-tests',{recursive:true});const dbFile=path.resolve(`outputs/stage15-tests/visual-facts-${Date.now()}.db`);copyFileSync(process.argv[2],dbFile);process.env.DATABASE_URL=`file:${dbFile.replaceAll('\\','/')}`;
 const {prisma}=await import('../lib/prisma');const {ensureAssetVisualFacts,readAssetVisualFacts}=await import('../lib/asset-visual-facts-service');
 const source=(await prisma.sceneSnapshot.findMany({where:{sceneKey:'FOUNDATION_DOCUMENT'}})).find(r=>JSON.parse(r.content).f2?.assets?.length);assert.ok(source);const doc=JSON.parse(source.content),subject=doc.f2.assets[0];
 const project=await prisma.project.create({data:{title:'isolated visual facts AB',episodes:{create:[{number:1,content:`${subject.name}身穿白衣。`},{number:2,content:`${subject.name}身穿蓝衣。`}]}}});const pid=project.id;
 assert.equal(await readAssetVisualFacts(pid),null);
 const document=await prisma.sceneSnapshot.create({data:{projectId:pid,sceneKey:'FOUNDATION_DOCUMENT',content:source.content}});
 const episodes=await prisma.episode.findMany({where:{projectId:pid},orderBy:{number:'asc'}});
 const originalDocument=(await prisma.sceneSnapshot.findUniqueOrThrow({where:{id:document.id}})).content;
 let calls:{code:string;episode:number}[]=[];let failAudit=true,tamper=false;let release:undefined|(()=>void),started:undefined|(()=>void);
 const runner:any=async(input:any)=>{const parsed=JSON.parse(input.prompt),chunk=parsed.chunk;calls.push({code:input.role.code,episode:chunk.episode});
  if(started&&input.role.code==='A15_A'){const announce=started;started=undefined;announce();await new Promise<void>(r=>release=r);}
  if(input.role.code==='B15_B'&&chunk.episode===2&&failAudit){failAudit=false;throw new Error('injected audit interruption');}
  assert.ok(['A15_A','B15_B'].includes(input.role.code));assert.equal(input.sessionMode,'ephemeral');assert.equal(input.role.model,'gpt-6-astra');assert.ok(input.role.systemPrompt.length>100);
  const line=chunk.lines[0];const data=input.role.code==='B15_B'?structuredClone(parsed.extracted):{coveredChunkId:chunk.id,facts:[{subjectKey:subject.key,attribute:'服装',value:'原文服装',scope:'STATE',versionKey:subject.key,quote:line.text,chunkId:chunk.id,startLine:line.number,endLine:line.number}],issues:[]};
  if(tamper&&input.role.code==='B15_B')data.facts[0].quote='原文里不存在的伪造引用';
  return {data,sessionId:null,stdout:'',stderr:''};};
 await assert.rejects(()=>ensureAssetVisualFacts(pid,runner),/injected audit interruption/);assert.equal(calls.length,4);assert.equal(await readAssetVisualFacts(pid),null);
 const ready=await ensureAssetVisualFacts(pid,runner);assert.equal(calls.length,5);assert.deepEqual(calls.at(-1),{code:'B15_B',episode:2});assert.equal(ready.status,'READY');assert.equal(ready.facts.length,2);assert.equal((await readAssetVisualFacts(pid))?.basis,ready.basis);
 await ensureAssetVisualFacts(pid,runner);assert.equal(calls.length,5);
 assert.deepEqual(await prisma.episode.findMany({where:{projectId:pid},orderBy:{number:'asc'}}),episodes);assert.equal((await prisma.sceneSnapshot.findUniqueOrThrow({where:{id:document.id}})).content,originalDocument);
 // Only the modified second episode incurs another A/B pair; existing first-episode facts remain cached.
 await prisma.episode.update({where:{id:episodes[1].id},data:{content:`${subject.name}身穿红衣。`}});assert.equal(await readAssetVisualFacts(pid),null);tamper=true;
 await assert.rejects(()=>ensureAssetVisualFacts(pid,runner),/引用/);assert.equal(calls.length,7);assert.equal(await readAssetVisualFacts(pid),null);tamper=false;
 await ensureAssetVisualFacts(pid,runner);assert.equal(calls.length,8);assert.deepEqual(calls.slice(5),[{code:'A15_A',episode:2},{code:'B15_B',episode:2},{code:'B15_B',episode:2}]);
 // Same-batch concurrent request is rejected before a duplicate model call.
 await prisma.episode.update({where:{id:episodes[1].id},data:{content:`${subject.name}身穿绿衣。`}});const began=new Promise<void>(r=>started=r);const pending=ensureAssetVisualFacts(pid,runner);await began;await assert.rejects(()=>ensureAssetVisualFacts(pid,runner),/正在处理/);release!();await pending;assert.equal(calls.length,10);
 // Changing the identity catalogue invalidates every current batch rather than accepting stale ownership.
 const changed=JSON.parse(originalDocument);changed.f2.assets[0].aliases.push('测试新别名');await prisma.sceneSnapshot.update({where:{id:document.id},data:{content:JSON.stringify(changed)}});assert.equal(await readAssetVisualFacts(pid),null);await ensureAssetVisualFacts(pid,runner);assert.equal(calls.length,14);
 await prisma.episode.update({where:{id:episodes[1].id},data:{content:`${subject.name}身穿黄衣。`}});let checks=0;const progress:number[][]=[];const beforeStop=calls.length;
 await assert.rejects(()=>ensureAssetVisualFacts(pid,runner,{shouldContinue:async()=>++checks<3,onProgress:async(d,t)=>{progress.push([d,t]);}}),/已停止/);assert.equal(calls.length,beforeStop+1);assert.equal(await readAssetVisualFacts(pid),null);
 const stoppedRows=await prisma.sceneSnapshot.findMany({where:{projectId:pid,sceneKey:'ASSET_VISUAL_FACT_BATCH_V1'}});assert.ok(stoppedRows.some(r=>{const v=JSON.parse(r.content);return v.status==='FAILED'&&v.extracted&&v.error.includes('已停止');}));
 await ensureAssetVisualFacts(pid,runner,{shouldContinue:async()=>true,onProgress:async(d,t)=>{progress.push([d,t]);}});assert.equal(calls.length,beforeStop+2);assert.deepEqual(progress.at(-1),[2,2]);
 console.log('PASS: per-chunk A/B calls; audit-only retry; cache reuse; forged quote rejection; changed-episode reuse; concurrent lock; catalogue invalidation; stop after A and resume B; progress; source and P3 untouched by service; real model calls 0');await prisma.$disconnect();
}main().catch(e=>{console.error(e);process.exitCode=1;});
