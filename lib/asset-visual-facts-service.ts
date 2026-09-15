import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {prisma} from './prisma';
import {loadFoundationInputs} from './foundation-state';
import {loadLatestStoredFoundationDocument} from './foundation-document';
import {runRoleByProvider,resolveProvider,type RoleRunResult} from './role-runner';
import {buildVisualChunks,validateVisualBatch,visualFactSourceLabel,findVisualFactReviewIssues,type VisualChunk,type VisualBatchResult,type VisualFact,type VisualIssue} from './asset-visual-facts-contract';
import {selectVisualIdentities,groupVisualFactBatches,VISUAL_FACT_PLANNER_VERSION} from './asset-visual-facts-planner';

const CACHE_KEY='ASSET_VISUAL_FACT_BATCH_V1';
export const VISUAL_FACT_CALL_KEY='ASSET_VISUAL_FACT_CALL_V1';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type BatchCache={schema:typeof CACHE_KEY;cacheKey:string;status:'RUNNING'|'READY'|'FAILED';requestId:string;workerPid?:number;updatedAt:string;error:string;usedIdentities?:{key:string;signature:string}[];auditContextHash?:string;extracted?:VisualBatchResult;audited?:VisualBatchResult};
export type AssetVisualFacts={facts:VisualFact[];issues:VisualIssue[];basis:string;status:'READY'|'REVIEW'};
export type VisualFactsControl={shouldContinue?:()=>Promise<boolean>;onProgress?:(done:number,total:number)=>Promise<void>};
class MissingCatalogue extends Error {}

async function currentBasis(projectId:string){
 const [input,document,extractSkill,auditSkill]=await Promise.all([loadFoundationInputs(projectId),loadLatestStoredFoundationDocument(prisma,projectId),readFile(path.join(process.cwd(),'prompts/asset-visual-extract-v1.md'),'utf8'),readFile(path.join(process.cwd(),'prompts/asset-visual-audit-v1.md'),'utf8')]);
 if(!document?.f2)throw new MissingCatalogue('请先完成 P3 资产名称目录，再整理资产外观事实。');
 const identities=document.f2.assets.map(a=>({key:a.key,name:a.name,type:a.type,baseVersion:{key:a.key,name:a.name},aliases:[...a.aliases].sort(),usageEpisodes:[...a.usageEpisodes].sort((a,b)=>a-b),variants:a.variants.map(v=>({key:v.key,name:v.name,episodes:[...v.episodes].sort((a,b)=>a-b)})).sort((a,b)=>a.key.localeCompare(b.key))})).sort((a,b)=>a.key.localeCompare(b.key));
 const chunks=buildVisualChunks({background:input.sourceContext.background,episodes:input.sourceIndex.episodes});
 const skills=hash([extractSkill,auditSkill]);
 const batches=chunks.map(chunk=>{const local=selectVisualIdentities(chunk,identities);const cacheKey=hash({schema:CACHE_KEY,protocol:VISUAL_FACT_PLANNER_VERSION,chunk,identities:local,skills});return {chunk,identities:local,cacheKey,id:'avfb_'+hash([projectId,cacheKey]).slice(0,40)};});
 return {input,identities,extractSkill,auditSkill,batches,basis:hash(batches.map(b=>b.cacheKey))};
}
type Batch=Awaited<ReturnType<typeof currentBasis>>['batches'][number];
type Identity=Awaited<ReturnType<typeof currentBasis>>['identities'][number];
function dependenciesMatch(state:BatchCache,identities:Identity[]){return (state.usedIdentities??[]).every(used=>{const identity=identities.find(i=>i.key===used.key);return identity&&hash(identity)===used.signature;});}
function usedIdentities(state:BatchCache,identities:Identity[]){
 const keys=new Set([state.extracted,state.audited].flatMap(result=>result?[...result.facts.map(f=>f.subjectKey),...result.issues.flatMap(i=>i.subjectKey?[i.subjectKey]:[])]:[]));
 return identities.filter(i=>keys.has(i.key)).map(i=>({key:i.key,signature:hash(i)}));
}
function authorContext(extracted:VisualBatchResult|undefined,results:Map<string,VisualBatchResult>,batches:Batch[]){
 const subjects=new Set([...(extracted?.facts??[]).map(f=>f.subjectKey),...(extracted?.issues??[]).flatMap(i=>i.subjectKey?[i.subjectKey]:[])]);
 const facts=new Map<string,VisualFact>();
 for(const batch of batches.filter(b=>b.chunk.domain==='EPISODE'))for(const fact of results.get(batch.chunk.id)?.facts??[]){if(!subjects.has(fact.subjectKey))continue;const key=JSON.stringify([fact.subjectKey,fact.attribute,fact.value,fact.versionKey,fact.scope]);if(!facts.has(key))facts.set(key,{...fact,sourceLabel:visualFactSourceLabel(fact,batches.map(b=>b.chunk))});}
 const payload={facts:[...facts.values()]};const serialized=JSON.stringify(payload);
 return {hash:hash(payload),payload,tooLarge:serialized.length>24000,subjects:[...subjects]};
}
function auditMatches(state:BatchCache,batch:Batch,results:Map<string,VisualBatchResult>,batches:Batch[]){return batch.chunk.domain!=='AUTHOR'||(batches.filter(b=>b.chunk.domain==='EPISODE').every(b=>results.has(b.chunk.id))&&state.auditContextHash===authorContext(state.extracted,results,batches).hash);}
const episodeFirst=(batches:Batch[])=>[...batches].sort((a,b)=>Number(a.chunk.domain==='AUTHOR')-Number(b.chunk.domain==='AUTHOR'));
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}}
function active(row:BatchCache){return row.status==='RUNNING'&&(row.workerPid?alive(row.workerPid):Date.now()-Date.parse(row.updatedAt)<120000);}
function aggregate(results:VisualBatchResult[],basis:string,chunks:VisualChunk[]):AssetVisualFacts{
 const facts:VisualFact[]=[],issues:VisualIssue[]=[];const seen=new Set<string>();
 for(const batch of results){for(const fact of batch.facts){const signature=hash(fact);if(!seen.has(signature)){seen.add(signature);facts.push({...fact,sourceLabel:visualFactSourceLabel(fact,chunks)});}}issues.push(...batch.issues);}
 issues.push(...findVisualFactReviewIssues(facts,chunks));
 return {facts,issues,basis,status:issues.length?'REVIEW':'READY'};
}
function reportedUsage(stdout:string):Record<string,unknown>|null{
 let usage:Record<string,unknown>|null=null;
 for(const line of stdout.split(/\r?\n/)){try{const event=JSON.parse(line);if(event.type==='turn.completed'&&event.usage&&typeof event.usage==='object'&&!Array.isArray(event.usage))usage=event.usage;}catch{}}
 return usage;
}
function validatePackage(value:unknown,batches:Batch[],identities:Identity[]):Map<string,VisualBatchResult>{
 if(!value||typeof value!=='object'||!Array.isArray((value as {batches?:unknown}).batches))throw new Error('视觉事实返回缺少 batches 批次列表。');
 const list=(value as {batches:unknown[]}).batches;
 if(list.length!==batches.length)throw new Error('视觉事实返回的批次数量不匹配。');
 const results=new Map<string,VisualBatchResult>();
 for(const raw of list){const chunkId=(raw as {coveredChunkId?:string})?.coveredChunkId;const batch=batches.find(b=>b.chunk.id===chunkId);if(!batch||results.has(batch.chunk.id))throw new Error('视觉事实存在未知或重复的批次回执。');results.set(batch.chunk.id,validateVisualBatch(raw,batch.chunk,identities));}
 return results;
}

/** Read only: a partial or outdated batch set is never presented as current facts. */
export async function readAssetVisualFacts(projectId:string):Promise<AssetVisualFacts|null>{
 let basis:Awaited<ReturnType<typeof currentBasis>>;
 try{basis=await currentBasis(projectId);}catch(error){if(error instanceof MissingCatalogue)return null;throw error;}
 const rows=await prisma.sceneSnapshot.findMany({where:{projectId,sceneKey:CACHE_KEY,id:{in:basis.batches.map(b=>b.id)}}});
 const results=new Map<string,VisualBatchResult>();
 for(const batch of episodeFirst(basis.batches)){const row=rows.find(r=>r.id===batch.id);if(!row)return null;
  const cached=JSON.parse(row.content) as BatchCache;if(cached.status!=='READY'||cached.cacheKey!==batch.cacheKey||!cached.audited||!dependenciesMatch(cached,basis.identities)||!auditMatches(cached,batch,results,basis.batches))return null;
  results.set(batch.chunk.id,validateVisualBatch(cached.audited,batch.chunk,basis.identities));
 }
 const latest=await currentBasis(projectId);if(latest.basis!==basis.basis||rows.some(row=>!dependenciesMatch(JSON.parse(row.content) as BatchCache,latest.identities)))return null;
 return aggregate(basis.batches.map(b=>results.get(b.chunk.id)!),basis.basis,basis.batches.map(b=>b.chunk));
}

/** Preserve per-chunk cache/ownership while packing missing work into bounded A/B requests. */
export async function ensureAssetVisualFacts(projectId:string,runner=runRoleByProvider,control:VisualFactsControl={}):Promise<AssetVisualFacts>{
 const basis=await currentBasis(projectId),results=new Map<string,VisualBatchResult>(),pending:Batch[]=[];
 const checkContinue=async()=>{if(control.shouldContinue&&!await control.shouldContinue())throw new Error('外观事实任务已停止，已完成的提取缓存仍保留，可稍后继续。');};
 const progress=()=>control.onProgress?.(results.size,basis.batches.length);
 await progress();
 for(const batch of episodeFirst(basis.batches)){
  const row=await prisma.sceneSnapshot.findUnique({where:{id:batch.id}}),cached=row?JSON.parse(row.content) as BatchCache:undefined;
  if(cached?.status==='READY'&&cached.cacheKey===batch.cacheKey&&cached.audited&&dependenciesMatch(cached,basis.identities)&&auditMatches(cached,batch,results,basis.batches))results.set(batch.chunk.id,validateVisualBatch(cached.audited,batch.chunk,basis.identities));else pending.push(batch);
 }
 await progress();
 const call=async(code:string,systemPrompt:string,batches:Batch[],extracted?:VisualBatchResult[],reviewContext?:unknown)=>{
  const identities=[...new Map(batches.flatMap(b=>b.identities).map(i=>[i.key,i])).values()].sort((a,b)=>a.key.localeCompare(b.key));
  const prompt=JSON.stringify({chunks:batches.map(b=>b.chunk),identities,...(extracted?{extracted:{batches:extracted}}:{}),...(reviewContext?{reviewContext}:{})});
  const id=randomUUID(),started=Date.now();
  const audit={schema:VISUAL_FACT_CALL_KEY,role:code,status:'RUNNING',startedAt:new Date(started).toISOString(),finishedAt:null as string|null,durationMs:null as number|null,chunkIds:batches.map(b=>b.chunk.id),inputChars:systemPrompt.length+prompt.length,outputChars:0,error:'',usage:null as Record<string,unknown>|null,output:null as unknown};
  await prisma.sceneSnapshot.create({data:{id,projectId,sceneKey:VISUAL_FACT_CALL_KEY,title:code,content:JSON.stringify(audit)}});
  let result:RoleRunResult|undefined;
  try{
   result=await runner({projectId,provider:resolveProvider(basis.input.project.executionMode),role:{code,skill:'',systemPrompt,model:'gpt-6-astra',reasoningEffort:'medium'},sessionMode:'ephemeral',prompt});
   audit.output=result.rawOutput??result.data;audit.outputChars=(result.rawOutput??JSON.stringify(result.data)).length;audit.usage=reportedUsage(result.stdout);
   let valid:Map<string,VisualBatchResult>;try{valid=validatePackage(result.data,batches,basis.identities);}catch(error){throw new Error(`模型处理包校验未通过，原始结果已保存，不会自动重复调用：${(error as Error).message}`,{cause:error});}audit.status='READY';return valid;
  }catch(error){audit.status='FAILED';audit.error=error instanceof Error?error.message:String(error);if(!result){const captured=error as {rawOutput?:string;stdout?:string};audit.output=captured.rawOutput??null;audit.outputChars=captured.rawOutput?.length??0;audit.usage=reportedUsage(captured.stdout??'');}throw error;}
  finally{audit.finishedAt=new Date().toISOString();audit.durationMs=Date.now()-started;await prisma.sceneSnapshot.update({where:{id},data:{content:JSON.stringify(audit)}});}
 };
 for(const group of groupVisualFactBatches(pending)){
  const held:{batch:Batch;state:BatchCache;expected:string}[]=[];
  const save=async(item:typeof held[number])=>{item.state.updatedAt=new Date().toISOString();const next=JSON.stringify(item.state);const result=await prisma.sceneSnapshot.updateMany({where:{id:item.batch.id,content:item.expected},data:{content:next}});if(result.count!==1)throw new Error('外观事实批次已由另一任务更新，本次结果未覆盖。');item.expected=next;};
  try{
   await checkContinue();
   for(const batch of group){
    const row=await prisma.sceneSnapshot.findUnique({where:{id:batch.id}}),old=row?JSON.parse(row.content) as BatchCache:undefined;
    if(old?.status==='READY'&&old.audited&&dependenciesMatch(old,basis.identities)&&auditMatches(old,batch,results,basis.batches)){results.set(batch.chunk.id,validateVisualBatch(old.audited,batch.chunk,basis.identities));continue;}
    if(old&&active(old))throw new Error(`外观事实批次 ${batch.chunk.id} 正在处理，请等待后继续；没有重复提交。`);
    const extracted=old?.extracted&&dependenciesMatch(old,basis.identities)?validateVisualBatch(old.extracted,batch.chunk,basis.identities):undefined;
    const state:BatchCache={schema:CACHE_KEY,cacheKey:batch.cacheKey,status:'RUNNING',requestId:randomUUID(),workerPid:process.pid,updatedAt:new Date().toISOString(),error:'',...(extracted?{extracted,usedIdentities:old?.usedIdentities}:{})};
    const item={batch,state,expected:JSON.stringify(state)};
    if(row){const claimed=await prisma.sceneSnapshot.updateMany({where:{id:batch.id,content:row.content},data:{content:item.expected}});if(claimed.count!==1)throw new Error('另一任务已开始整理该批外观事实，请稍后继续。');}
    else{try{await prisma.sceneSnapshot.create({data:{id:batch.id,projectId,sceneKey:CACHE_KEY,title:batch.chunk.id,content:item.expected}});}catch(error){if((error as {code?:string}).code==='P2002')throw new Error('另一任务已开始整理该批外观事实，请稍后继续。');throw error;}}
    held.push(item);
   }
   const missing=held.filter(item=>!item.state.extracted);
   if(missing.length){await checkContinue();const extracted=await call('A15_A',basis.extractSkill,missing.map(item=>item.batch));for(const item of missing){item.state.extracted=extracted.get(item.batch.chunk.id)!;item.state.usedIdentities=usedIdentities(item.state,basis.identities);await save(item);}}
   if(held.length){
    await checkContinue();
    const context=held[0].batch.chunk.domain==='AUTHOR'?authorContext(held[0].state.extracted,results,basis.batches):undefined;
    const reviewContext=context?(context.tooLarge?{status:'TOO_LARGE',message:'相关正文事实超过24000字符，未截断传输；保留疑点待局部核对。'}:context.payload):undefined;
    const audited=await call('B15_B',basis.auditSkill,held.map(item=>item.batch),held.map(item=>item.state.extracted!),reviewContext);
    for(const item of held){
     item.state.audited=audited.get(item.batch.chunk.id)!;
     if(context){item.state.auditContextHash=context.hash;if(context.tooLarge){item.state.audited.issues.push(...(item.state.extracted?.issues??[]),...(context.subjects.length?context.subjects.map(subjectKey=>({subjectKey,message:'相关正文事实超过24000字符，本批未完成跨批核对，原有疑点已保留；需要局部核对。'})):[{message:'相关正文事实超过24000字符，本批需要局部核对。'}]));}}
     item.state.usedIdentities=usedIdentities(item.state,basis.identities);item.state.status='READY';delete item.state.workerPid;await save(item);results.set(item.batch.chunk.id,item.state.audited);
    }
   }
  }catch(error){
   const failures:unknown[]=[];for(const item of held){if(item.state.status==='READY')continue;item.state.status='FAILED';delete item.state.workerPid;item.state.error=error instanceof Error?error.message:String(error);try{await save(item);}catch(failed){failures.push(failed);}}
   if(failures.length)throw new AggregateError([error,...failures],'外观事实请求失败，且部分批次状态未能保存。');
   throw new Error(`外观事实处理包未完成：${error instanceof Error?error.message:String(error)}`,{cause:error});
  }
  await progress();
 }
 await checkContinue();
 if((await currentBasis(projectId)).basis!==basis.basis)throw new Error('整理期间原文、资产目录或事实规则已更新，已保留批次缓存，请继续整理当前版本。');
 const current=await readAssetVisualFacts(projectId);if(!current||current.basis!==basis.basis)throw new Error('整理期间事实归属目录已更新，已保留有效批次，请继续整理。');
 return current;
}
