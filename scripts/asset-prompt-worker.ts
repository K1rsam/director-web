import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {prisma} from '../lib/prisma';
import {loadFoundationInputs} from '../lib/foundation-state';
import {loadAssetPromptWorkspace,generateAssetPrompt} from '../lib/asset-prompt-service';
import {promptNeedsReview} from '../lib/asset-prompt-contract';
import {AUTOMATION_KEY,automationWorkerAlive,type AssetPromptAutomation} from '../lib/asset-prompt-automation';

export async function runAssetPromptWorker(projectId:string,id:string,token?:string,deps={db:prisma,load:loadAssetPromptWorkspace,inputs:loadFoundationInputs,generate:generateAssetPrompt}){
 const row=await deps.db.sceneSnapshot.findUnique({where:{id}});if(!row||row.projectId!==projectId||row.sceneKey!==AUTOMATION_KEY)return;
 let state=JSON.parse(row.content) as AssetPromptAutomation;
 if(state.status!=='RUNNING'||(token&&state.id!==token)||(state.workerPid&&automationWorkerAlive(state.workerPid)))return;
 const execution=state.id;state={...state,workerPid:process.pid,updatedAt:new Date().toISOString()};
 const claim=await deps.db.sceneSnapshot.updateMany({where:{id,content:row.content},data:{content:JSON.stringify(state)}});if(claim.count!==1)return;
 // Never overwrite another execution or lose a stop that raced a completed item.
 const save=async()=>{for(let retry=0;retry<5;retry++){
  const fresh=await deps.db.sceneSnapshot.findUnique({where:{id}});if(!fresh){state.status='STOPPED';return false;}
  const latest=JSON.parse(fresh.content) as AssetPromptAutomation;if(latest.id!==execution){state.status='STOPPED';return false;}
  if(latest.status==='STOPPED'){state.status='STOPPED';state.error=latest.error;}
  state.updatedAt=new Date().toISOString();const updated=await deps.db.sceneSnapshot.updateMany({where:{id,content:fresh.content},data:{content:JSON.stringify(state)}});if(updated.count===1)return true;
 }throw new Error('后台任务状态同时发生变化，请刷新后继续。');};
 try{
  let w=await deps.load(projectId);
  const queue=w.assets.filter(a=>['CH','GROUP','BEAST'].includes(a.type)&&a.eligible&&(!w.records[a.key]?.body||w.records[a.key]?.status!=='READY'||promptNeedsReview(a,w.records,w.assets))).map(a=>a.key);
  state.total=queue.length;if(!await save())return;
  while(queue.length&&state.status==='RUNNING'){
   const current=await deps.db.sceneSnapshot.findUnique({where:{id}});if(!current||JSON.parse(current.content).id!==execution||JSON.parse(current.content).status!=='RUNNING'){state.status='STOPPED';break;}
   if((await deps.inputs(projectId)).sourceVersion!==state.sourceVersion){state.status='STOPPED';state.error='原文已更新，后续任务停止。';break;}
   w=await deps.load(projectId);if(w.busy){state.status='STOPPED';state.error='第一阶段重新运行，后续任务停止。';break;}
   const at=queue.findIndex(key=>{const a=w.assets.find(a=>a.key===key);if(!a)return true;const ref=a.fromKey??(a.variant?a.baseKey:undefined);if(!ref)return true;const source=w.assets.find(a=>a.key===ref);return Boolean(source&&w.records[ref]?.body&&w.records[ref].status==='READY'&&!promptNeedsReview(source,w.records,w.assets));});
   if(at<0){state.failed+=queue.length;state.error='部分来源形象不存在或未完成，对应变体已跳过。';break;}
   const [key]=queue.splice(at,1);const asset=w.assets.find(a=>a.key===key),previous=w.records[key];
   if(!asset||!asset.eligible){state.failed++;state.error='资产已移除或不再需要独立形象，已跳过。';await save();continue;}
   if(previous?.body&&previous.status==='READY'&&!promptNeedsReview(asset,w.records,w.assets)){state.done++;await save();continue;}
   if(previous?.origin==='MANUAL'&&previous.body){state.failed++;state.error='人工提示词的来源已更新或状态待处理，已保留，请确认后继续。';await save();continue;}
   try{const result=await deps.generate(projectId,key,previous?.revision??0);if(result.status==='READY')state.done++;else{state.failed++;state.error=result.error;}}catch(error){state.failed++;state.error=(error as Error).message;}
   if(!await save())return;
  }
  if(state.status==='RUNNING')state.status=state.failed?'FAILED':'COMPLETE';
 }catch(error){state.status='FAILED';state.error=(error as Error).message;}
 finally{delete state.workerPid;await save();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [projectId,id,token]=process.argv.slice(2);
 (projectId&&id?runAssetPromptWorker(projectId,id,token):Promise.reject(new Error('Missing job identity'))).catch(()=>{process.exitCode=1;}).finally(()=>prisma.$disconnect());
}
