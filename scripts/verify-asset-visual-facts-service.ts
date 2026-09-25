import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
async function main(){
 mkdirSync('outputs/stage15-tests',{recursive:true});
 process.env.DATABASE_URL=`file:${path.resolve(`outputs/stage15-tests/single-${Date.now()}.db`).replaceAll('\\','/')}`;
 writeFileSync(process.env.DATABASE_URL.slice(5),'');
 execFileSync(process.execPath,['node_modules/prisma/build/index.js','db','push','--skip-generate'],{env:process.env,stdio:'pipe'});
 const {prisma}=await import('../lib/prisma');
 try{
 const {ensureAssetVisualFacts,readAssetVisualFacts,VISUAL_FACT_CALL_KEY}=await import('../lib/asset-visual-facts-service');
 const {loadFoundationInputs}=await import('../lib/foundation-state');
 const {createEmptyDocument}=await import('../lib/foundation-document');
 const {resolveCliModel,resolveCliReasoning}=await import('../lib/role-runner');
 for(const role of ['F1','F2','Q1','A15_A','A15','A15_D','E0','E5']){assert.equal(resolveCliModel(role,'gpt-6-astra'),'gpt-5.6-terra');assert.equal(resolveCliReasoning(role,'high'),'medium');}
 const project=await prisma.project.create({data:{title:'synthetic single pass',episodes:{create:[{number:1,content:'人物甲穿白衣。'},{number:2,content:'人物甲穿蓝衣。'}]}}});const pid=project.id;
 const doc=createEmptyDocument(await loadFoundationInputs(pid));
 doc.f2={format:'ASSET_CATALOG_V1',coverage:[1,2],assets:[{key:'hero',name:'人物甲',type:'CH',aliases:[],description:'',sourceRefs:[],appearances:[],usageEpisodes:[1,2],variants:[]}],episodes:[{number:1,context:'',assetKeys:['hero']},{number:2,context:'',assetKeys:['hero']}],issues:[]};
 const document=await prisma.sceneSnapshot.create({data:{projectId:pid,sceneKey:'FOUNDATION_DOCUMENT',content:JSON.stringify(doc)}});
 let calls=0,tamper=false;let started:(()=>void)|undefined,release:(()=>void)|undefined;
 const scopes:(number|undefined)[][]=[];
 const runner:any=async(input:any)=>{calls++;assert.equal(input.role.code,'A15_A');assert.equal(input.role.model,'gpt-5.6-terra');const v=JSON.parse(input.prompt);scopes.push(v.chunks.map((c:any)=>c.episode));assert.equal(v.reviewContext,undefined);
 if(started){const announce=started;started=undefined;announce();await new Promise<void>(r=>release=r);}
 const data={batches:v.chunks.map((c:any)=>({coveredChunkId:c.id,facts:[{subjectKey:'hero',attribute:'clothing',value:c.lines[0].text,scope:'STATE',versionKey:'hero',quote:tamper?'不存在的引用':c.lines[0].text,chunkId:c.id,startLine:c.lines[0].number,endLine:c.lines[0].number}],issues:[]}))};return {data,rawOutput:JSON.stringify(data),sessionId:null,stdout:JSON.stringify({type:'turn.completed',usage:{input_tokens:100,output_tokens:20}}),stderr:''};};
 const first=await ensureAssetVisualFacts(pid,runner);assert.equal(first.facts.length,2);assert.equal(calls,1);assert.deepEqual(scopes[0],[1,2]);await ensureAssetVisualFacts(pid,runner);assert.equal(calls,1);
 const episodes=await prisma.episode.findMany({where:{projectId:pid},orderBy:{number:'asc'}});
 await prisma.project.update({where:{id:pid},data:{style:'新画风'}});await ensureAssetVisualFacts(pid,runner);assert.equal(calls,1,'style reuses facts');
 await prisma.episode.update({where:{id:episodes[1].id},data:{content:'人物甲穿红衣。'}});assert.equal(await readAssetVisualFacts(pid),null);assert.equal((await readAssetVisualFacts(pid,true))?.facts.length,1);
 tamper=true;await assert.rejects(()=>ensureAssetVisualFacts(pid,runner),/引用/);assert.equal(calls,2);tamper=false;await ensureAssetVisualFacts(pid,runner);assert.equal(calls,3);assert.deepEqual(scopes.at(-1),[2]);
 await prisma.episode.update({where:{id:episodes[1].id},data:{content:'人物甲穿绿衣。'}});const began=new Promise<void>(r=>started=r),pending=ensureAssetVisualFacts(pid,runner);await began;await assert.rejects(()=>ensureAssetVisualFacts(pid,runner),/正在处理/);release!();await pending;assert.equal(calls,4);
 await prisma.episode.update({where:{id:episodes[1].id},data:{content:'人物甲穿黑衣。'}});let checks=0;await assert.rejects(()=>ensureAssetVisualFacts(pid,runner,{shouldContinue:async()=>++checks<3}),/已停止/);assert.equal(calls,5);await ensureAssetVisualFacts(pid,runner);assert.equal(calls,5,'saved extraction resumed without another model call');
 const background='人物甲戴眼镜。';await prisma.sceneSnapshot.create({data:{projectId:pid,sceneKey:'SOURCE_IMPORT',metadata:JSON.stringify({schema:'IMPORTED_SOURCE_TEXT_V2'}),content:JSON.stringify({sourceText:background,sourceStructure:{version:'SOURCE_STRUCTURE_V1',sections:[{key:'author',kind:'BACKGROUND',start:0,end:background.length}],issues:[]}})}});
 await ensureAssetVisualFacts(pid,runner);assert.equal(calls,6);assert.deepEqual(scopes.at(-1),[undefined]);
 await prisma.episode.update({where:{id:episodes[1].id},data:{content:'人物甲穿银衣。'}});await ensureAssetVisualFacts(pid,runner);assert.equal(calls,7,'changed episode does not re-audit author');assert.deepEqual(scopes.at(-1),[2]);
 assert.equal((await prisma.sceneSnapshot.findUniqueOrThrow({where:{id:document.id}})).content,document.content,'P3 untouched');
 assert.equal((await prisma.episode.findUniqueOrThrow({where:{id:episodes[0].id}})).content,episodes[0].content,'source untouched by extraction');
 const logs=(await prisma.sceneSnapshot.findMany({where:{projectId:pid,sceneKey:VISUAL_FACT_CALL_KEY}})).map(r=>JSON.parse(r.content));assert.equal(logs.length,calls);assert.ok(logs.some(l=>l.status==='FAILED'&&l.output));assert.ok(logs.every(l=>l.usage?.input_tokens===100));
 console.log('PASS: isolated synthetic DB; single call per pack, cache, changed-only retry, partial read, quote rejection, concurrent claim, stop/resume, independent author cache, model pin, source/P3 preservation; paid calls 0');
 }finally{await prisma.$disconnect();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
