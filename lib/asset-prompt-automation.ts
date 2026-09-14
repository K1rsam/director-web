import {spawn} from 'node:child_process';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prisma} from './prisma';
export const AUTOMATION_KEY='ASSET_PROMPT_AUTOMATION_V1';
export type AssetPromptAutomation={id:string;sourceVersion:string;status:'RUNNING'|'COMPLETE'|'STOPPED'|'FAILED';done:number;failed:number;total:number;error:string;updatedAt:string;workerPid?:number};
export function effectiveAutomationState(state:AssetPromptAutomation):AssetPromptAutomation{
 if(state.status!=='RUNNING')return state;
 let alive=Date.now()-Date.parse(state.updatedAt)<120000;
 if(state.workerPid){try{process.kill(state.workerPid,0);alive=true;}catch(e){alive=(e as NodeJS.ErrnoException).code!=='ESRCH';}}
 return alive?state:{...state,status:'FAILED',error:'后台进程已退出，已完成的提示词仍保留；可以继续未完成项。'};
}
export async function stopAssetPromptAutomation(projectId:string){
 const row=await prisma.sceneSnapshot.findFirst({where:{projectId,sceneKey:AUTOMATION_KEY},orderBy:{createdAt:'desc'}});if(!row)return;
 const state=JSON.parse(row.content) as AssetPromptAutomation;
 if(state.status==='RUNNING')await prisma.sceneSnapshot.updateMany({where:{id:row.id,content:row.content},data:{content:JSON.stringify({...state,status:'STOPPED',error:'已停止后续任务，正在执行的单项结果仍会保存。'})}});
}
export async function launchAssetPromptAutomation(projectId:string,sourceVersion:string){
 const existing=await prisma.sceneSnapshot.findFirst({where:{projectId,sceneKey:AUTOMATION_KEY},orderBy:{createdAt:'desc'}});
 if(existing){const old=effectiveAutomationState(JSON.parse(existing.content) as AssetPromptAutomation);if(old.status==='RUNNING')return;}
 const id=randomUUID();const state:AssetPromptAutomation={id,sourceVersion,status:'RUNNING',done:0,failed:0,total:0,error:'',updatedAt:new Date().toISOString()};
 await prisma.sceneSnapshot.create({data:{id,projectId,sceneKey:AUTOMATION_KEY,title:'P3 后的资产提示词任务',content:JSON.stringify(state)}});
 try{
  const child=spawn(process.execPath,['--import','tsx',path.join(process.cwd(),'scripts/asset-prompt-worker.ts'),projectId,id],{cwd:process.cwd(),env:process.env,detached:true,windowsHide:true,stdio:'ignore'});
  child.once('error',error=>{void prisma.sceneSnapshot.updateMany({where:{id,content:JSON.stringify(state)},data:{content:JSON.stringify({...state,status:'FAILED',error:error.message})}}).catch(()=>{});});child.unref();
 }catch(error){await prisma.sceneSnapshot.update({where:{id},data:{content:JSON.stringify({...state,status:'FAILED',error:(error as Error).message})}});}
}
