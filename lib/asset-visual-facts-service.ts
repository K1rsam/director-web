import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {prisma} from './prisma';
import {loadFoundationInputs} from './foundation-state';
import {loadLatestStoredFoundationDocument} from './foundation-document';
import {runRoleByProvider,resolveProvider} from './role-runner';
import {buildVisualChunks,validateVisualBatch,visualFactSourceLabel,findVisualFactReviewIssues,type VisualChunk,type VisualBatchResult,type VisualFact,type VisualIssue} from './asset-visual-facts-contract';

const CACHE_KEY='ASSET_VISUAL_FACT_BATCH_V1';
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
type BatchCache={schema:typeof CACHE_KEY;cacheKey:string;status:'RUNNING'|'READY'|'FAILED';requestId:string;workerPid?:number;updatedAt:string;error:string;extracted?:VisualBatchResult;audited?:VisualBatchResult};
export type AssetVisualFacts={facts:VisualFact[];issues:VisualIssue[];basis:string;status:'READY'|'REVIEW'};
export type VisualFactsControl={shouldContinue?:()=>Promise<boolean>;onProgress?:(done:number,total:number)=>Promise<void>};
class MissingCatalogue extends Error {}

async function currentBasis(projectId:string){
 const [input,document,extractSkill,auditSkill]=await Promise.all([loadFoundationInputs(projectId),loadLatestStoredFoundationDocument(prisma,projectId),readFile(path.join(process.cwd(),'prompts/asset-visual-extract-v1.md'),'utf8'),readFile(path.join(process.cwd(),'prompts/asset-visual-audit-v1.md'),'utf8')]);
 if(!document?.f2)throw new MissingCatalogue('请先完成 P3 资产名称目录，再整理资产外观事实。');
 const identities=document.f2.assets.map(a=>({key:a.key,name:a.name,baseVersion:{key:a.key,name:a.name},aliases:[...a.aliases].sort(),variants:a.variants.map(v=>({key:v.key,name:v.name})).sort((a,b)=>a.key.localeCompare(b.key))})).sort((a,b)=>a.key.localeCompare(b.key));
 const chunks=buildVisualChunks({background:input.sourceContext.background,episodes:input.sourceIndex.episodes});
 const skills=hash([extractSkill,auditSkill]);
 const batches=chunks.map(chunk=>{const cacheKey=hash({schema:CACHE_KEY,chunk,identities,skills});return {chunk,cacheKey,id:'avfb_'+hash([projectId,cacheKey]).slice(0,40)};});
 return {input,identities,extractSkill,auditSkill,batches,basis:hash(batches.map(b=>b.cacheKey))};
}
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}}
function active(row:BatchCache){return row.status==='RUNNING'&&(row.workerPid?alive(row.workerPid):Date.now()-Date.parse(row.updatedAt)<120000);}
function aggregate(results:VisualBatchResult[],basis:string,chunks:VisualChunk[]):AssetVisualFacts{
 const facts:VisualFact[]=[],issues:VisualIssue[]=[];const seen=new Set<string>();
 for(const batch of results){for(const fact of batch.facts){const signature=hash(fact);if(!seen.has(signature)){seen.add(signature);facts.push({...fact,sourceLabel:visualFactSourceLabel(fact,chunks)});}}issues.push(...batch.issues);}
 issues.push(...findVisualFactReviewIssues(facts,chunks));
 return {facts,issues,basis,status:issues.length?'REVIEW':'READY'};
}

/** Read only: a partial or outdated batch set is never presented as current facts. */
export async function readAssetVisualFacts(projectId:string):Promise<AssetVisualFacts|null>{
 let basis:Awaited<ReturnType<typeof currentBasis>>;
 try{basis=await currentBasis(projectId);}catch(error){if(error instanceof MissingCatalogue)return null;throw error;}
 const rows=await prisma.sceneSnapshot.findMany({where:{projectId,sceneKey:CACHE_KEY,id:{in:basis.batches.map(b=>b.id)}}});
 const results:VisualBatchResult[]=[];
 for(const batch of basis.batches){const row=rows.find(r=>r.id===batch.id);if(!row)return null;
  const cached=JSON.parse(row.content) as BatchCache;if(cached.status!=='READY'||cached.cacheKey!==batch.cacheKey||!cached.audited)return null;
  results.push(validateVisualBatch(cached.audited,batch.chunk,basis.identities));
 }
 if((await currentBasis(projectId)).basis!==basis.basis)return null;
 return aggregate(results,basis.basis,basis.batches.map(b=>b.chunk));
}

/** A extracts, B audits the same original chunk. Neither step edits P3 or invents appearance. */
export async function ensureAssetVisualFacts(projectId:string,runner=runRoleByProvider,control:VisualFactsControl={}):Promise<AssetVisualFacts>{
 const basis=await currentBasis(projectId);const results:VisualBatchResult[]=[];
 const checkContinue=async()=>{if(control.shouldContinue&&!await control.shouldContinue())throw new Error('外观事实任务已停止，已完成的提取缓存仍保留，可稍后继续。');};
 await control.onProgress?.(0,basis.batches.length);
 for(const batch of basis.batches){
  const priorRow=await prisma.sceneSnapshot.findUnique({where:{id:batch.id}});
  const previous=priorRow?JSON.parse(priorRow.content) as BatchCache:undefined;
  if(previous?.status==='READY'&&previous.cacheKey===batch.cacheKey&&previous.audited){await checkContinue();results.push(validateVisualBatch(previous.audited,batch.chunk,basis.identities));await control.onProgress?.(results.length,basis.batches.length);continue;}
  if(previous&&active(previous))throw new Error(`外观事实批次 ${batch.chunk.id} 正在处理，请等待后继续；没有重复提交。`);
  const extracted=previous?.extracted?validateVisualBatch(previous.extracted,batch.chunk,basis.identities):undefined;
  let state:BatchCache={schema:CACHE_KEY,cacheKey:batch.cacheKey,status:'RUNNING',requestId:randomUUID(),workerPid:process.pid,updatedAt:new Date().toISOString(),error:'',...(extracted?{extracted}:{})};
  let expected=JSON.stringify(state);
  if(priorRow){const claimed=await prisma.sceneSnapshot.updateMany({where:{id:batch.id,content:priorRow.content},data:{content:expected}});if(claimed.count!==1)throw new Error('另一任务已开始整理该批外观事实，请稍后继续。');}
  else{try{await prisma.sceneSnapshot.create({data:{id:batch.id,projectId,sceneKey:CACHE_KEY,title:batch.chunk.id,content:expected}});}catch(error){if((error as {code?:string}).code==='P2002')throw new Error('另一任务已开始整理该批外观事实，请稍后继续。');throw error;}}
  const save=async()=>{state.updatedAt=new Date().toISOString();const next=JSON.stringify(state);const saved=await prisma.sceneSnapshot.updateMany({where:{id:batch.id,content:expected},data:{content:next}});if(saved.count!==1)throw new Error('外观事实批次已由另一任务更新，本次结果未覆盖。');expected=next;};
  const call=async(code:string,systemPrompt:string,extra:Record<string,unknown>)=>{
   const result=await runner({projectId,provider:resolveProvider(basis.input.project.executionMode),role:{code,skill:'',systemPrompt,model:'gpt-6-astra',reasoningEffort:'medium'},sessionMode:'ephemeral',prompt:JSON.stringify({chunk:batch.chunk,identities:basis.identities,...extra})});
   return validateVisualBatch(result.data,batch.chunk,basis.identities);
  };
  try{
   await checkContinue();
   if(!state.extracted){state.extracted=await call('A15_A',basis.extractSkill,{});await save();}
   await checkContinue();
   state.audited=await call('B15_B',basis.auditSkill,{extracted:state.extracted});state.status='READY';delete state.workerPid;await save();results.push(state.audited);
  }catch(error){state.status='FAILED';delete state.workerPid;state.error=error instanceof Error?error.message:String(error);await save();throw new Error(`外观事实批次 ${batch.chunk.id} 未完成：${state.error}`,{cause:error});}
  await control.onProgress?.(results.length,basis.batches.length);
 }
 if((await currentBasis(projectId)).basis!==basis.basis)throw new Error('整理期间原文、资产目录或事实规则已更新，已保留批次缓存，请继续整理当前版本。');
 return aggregate(results,basis.basis,basis.batches.map(b=>b.chunk));
}
