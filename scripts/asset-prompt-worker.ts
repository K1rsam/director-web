import {prisma} from '../lib/prisma';
import {loadFoundationInputs} from '../lib/foundation-state';
import {loadAssetPromptWorkspace,generateAssetPrompt} from '../lib/asset-prompt-service';
import {promptNeedsReview} from '../lib/asset-prompt-contract';
import type {AssetPromptAutomation} from '../lib/asset-prompt-automation';

async function main(){
 const [projectId,id]=process.argv.slice(2);if(!projectId||!id)throw new Error('Missing job identity');
 const row=await prisma.sceneSnapshot.findUniqueOrThrow({where:{id}});if(row.projectId!==projectId)throw new Error('Wrong project');
 let state=JSON.parse(row.content) as AssetPromptAutomation;state.workerPid=process.pid;
 const save=async()=>{const fresh=await prisma.sceneSnapshot.findUniqueOrThrow({where:{id}});if(JSON.parse(fresh.content).status==='STOPPED')state.status='STOPPED';state.updatedAt=new Date().toISOString();await prisma.sceneSnapshot.updateMany({where:{id,content:fresh.content},data:{content:JSON.stringify(state)}});};
 try{
  let w=await loadAssetPromptWorkspace(projectId);
  const queue=w.assets.filter(a=>['CH','GROUP','BEAST'].includes(a.type)&&a.eligible&&(!w.records[a.key]?.body||promptNeedsReview(a,w.records,w.assets))).map(a=>a.key);
  state.total=queue.length;await save();
  while(queue.length&&state.status==='RUNNING'){
   const current=await prisma.sceneSnapshot.findUniqueOrThrow({where:{id}});if((JSON.parse(current.content) as AssetPromptAutomation).status!=='RUNNING'){state.status='STOPPED';break;}
   if((await loadFoundationInputs(projectId)).sourceVersion!==state.sourceVersion){state.status='STOPPED';state.error='原文已更新，后续任务停止。';break;}
   w=await loadAssetPromptWorkspace(projectId);if(w.busy){state.status='STOPPED';state.error='第一阶段重新运行，后续任务停止。';break;}
   const at=queue.findIndex(key=>{const a=w.assets.find(a=>a.key===key);if(!a)return true;const ref=a.fromKey??(a.variant?a.baseKey:undefined);return !ref||Boolean(w.records[ref]?.body&&w.records[ref].status==='READY'&&!promptNeedsReview(w.assets.find(a=>a.key===ref)!,w.records,w.assets));});
   if(at<0){state.failed+=queue.length;state.error='部分来源形象未完成，对应变体已跳过。';break;}
   const [key]=queue.splice(at,1);const previous=w.records[key];
   if(previous?.origin==='MANUAL'&&previous.body){state.done++;await save();continue;}
   try{const result=await generateAssetPrompt(projectId,key,previous?.revision??0);if(result.status==='READY')state.done++;else{state.failed++;state.error=result.error;}}catch(error){state.failed++;state.error=(error as Error).message;}
   await save();
  }
  if(state.status==='RUNNING')state.status=state.failed?'FAILED':'COMPLETE';await save();
 }catch(error){state.status='FAILED';state.error=(error as Error).message;await save();}
 finally{await prisma.$disconnect();}
}
main().catch(()=>{process.exitCode=1;});
