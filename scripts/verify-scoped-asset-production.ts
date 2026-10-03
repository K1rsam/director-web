import assert from 'node:assert/strict';
import {mkdtempSync,readdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

async function main(){
 const file=path.join(mkdtempSync(path.join(tmpdir(),'scoped-assets-')),'test.db'),sql=new DatabaseSync(file);
 for(const migration of readdirSync('prisma/migrations').sort())if(/^\d/.test(migration))sql.exec(readFileSync(path.join('prisma/migrations',migration,'migration.sql'),'utf8'));
 sql.close();process.env.DATABASE_URL=`file:${file}`;
 const {prisma}=await import('../lib/prisma'),{loadFoundationInputs}=await import('../lib/foundation-state'),{createEmptyDocument}=await import('../lib/foundation-document'),facts=await import('../lib/asset-visual-facts-service');
 try{
  const project=await prisma.project.create({data:{title:'按需资产合成样本',episodes:{create:[{number:1,content:'1-1 仓库 日 内\n△甲穿白衣，反锁铁门。'},{number:2,content:'2-1 远方 夜 外\n△乙的秘密宫殿在远方。'}]}}});
  const doc=createEmptyDocument(await loadFoundationInputs(project.id));
  doc.f2={format:'ASSET_CATALOG_V1',coverage:[1,2],issues:[],assets:[{key:'hero',name:'甲',type:'CH',aliases:[],description:'',sourceRefs:[],appearances:[],usageEpisodes:[1],variants:[{key:'future',name:'甲未来王冠',episodes:[2],note:''}]},{key:'future-palace',name:'秘密宫殿',type:'LOC',aliases:[],description:'',sourceRefs:[],appearances:[],usageEpisodes:[2],variants:[]}],episodes:[{number:1,context:'',assetKeys:['hero']},{number:2,context:'',assetKeys:['future-palace','future']}]};
  await prisma.sceneSnapshot.create({data:{projectId:project.id,sceneKey:'FOUNDATION_DOCUMENT',content:JSON.stringify(doc)}});
  const sent:Record<string,any>[]=[];
  const result=await facts.ensureAssetVisualFacts(project.id,async input=>{const p=JSON.parse(input.prompt);sent.push(p);const data={batches:p.chunks.map((c:any)=>({coveredChunkId:c.id,facts:[],issues:[]}))};return {data,rawOutput:JSON.stringify(data),stdout:'',stderr:'',sessionId:null};},{scope:{episodeNumbers:[1]}} as Parameters<typeof facts.ensureAssetVisualFacts>[2]);
  assert.ok(sent.length);assert.ok(sent.every(p=>p.chunks.every((c:any)=>c.episode===1)),'an episode-1 asset request must not read the full series');
  assert.ok(!JSON.stringify(sent).includes('秘密宫殿'),'unrelated future asset is not sent');
  assert.ok(!JSON.stringify(sent).includes('未来王冠'),'future-only version is not sent');
  assert.equal(result.complete,true);assert.deepEqual((result as any).scope?.episodeNumbers,[1]);
  let extraCalls=0;await facts.ensureAssetVisualFacts(project.id,async()=>{extraCalls++;throw new Error('cached');},{scope:{episodeNumbers:[1]}} as Parameters<typeof facts.ensureAssetVisualFacts>[2]);
  assert.equal(extraCalls,0,'same selected scope reuses its exact cache');
  const unscoped=await facts.readAssetVisualFacts(project.id,true);assert.equal(unscoped?.complete,false,'a selected-scope cache never claims full-series completion');
  await assert.rejects(()=>facts.ensureAssetVisualFacts(project.id,undefined,{scope:{episodeNumbers:[]}} as Parameters<typeof facts.ensureAssetVisualFacts>[2]),/选集|范围/);
  const prompts=await import('../lib/asset-prompt-service') as any;
  assert.equal(typeof prompts.planEpisodeAssetProduction,'function','selected-episode production has an explicit service entry');
  const plan=await prompts.planEpisodeAssetProduction(project.id,[1]);
  assert.deepEqual(plan.assetKeys,['hero']);assert.deepEqual(plan.scope.episodeNumbers,[1]);
  let forbidden=0;const noWork=await prompts.generateAssetPromptsForEpisodes(project.id,[1],{assetKeys:[],runner:async()=>{forbidden++;throw new Error('must not call');}});
  assert.deepEqual(noWork.assetKeys,[],'an explicit empty request produces no asset work');assert.equal(forbidden,0);
  await assert.rejects(()=>prompts.planEpisodeAssetProduction(project.id,[99]),/选集|范围/);
  console.log('PASS scoped asset facts: explicit selected episodes, no unrelated future identities or variants, exact scoped cache, honest partial full-series status and scoped service plan, zero real model calls');
 }finally{await prisma.$disconnect();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
