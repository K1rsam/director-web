import {spawn} from 'node:child_process';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {prisma} from './prisma';
import type {AssetProductionScope} from './asset-visual-facts-planner';
export const AUTOMATION_KEY='ASSET_PROMPT_AUTOMATION_V1';
export type AssetPromptAutomation={id:string;sourceVersion:string;mode?:'FACTS'|'PROMPTS';scope?:AssetProductionScope;status:'RUNNING'|'COMPLETE'|'STOPPED'|'FAILED';done:number;failed:number;total:number;error:string;updatedAt:string;workerPid?:number};
export function automationWorkerAlive(pid:number){try{process.kill(pid,0);return true;}catch(e){return (e as NodeJS.ErrnoException).code!=='ESRCH';}}
export function effectiveAutomationState(state:AssetPromptAutomation):AssetPromptAutomation{
 if(state.status!=='RUNNING')return state;
 const alive=state.workerPid?automationWorkerAlive(state.workerPid):Date.now()-Date.parse(state.updatedAt)<120000;
 return alive?state:{...state,status:'FAILED',error:'后台进程已退出，已完成的提示词仍保留；可以继续未完成项。'};
}
export async function stopAssetPromptAutomation(projectId:string,db:Pick<typeof prisma,'sceneSnapshot'>=prisma){
 let execution:string|undefined;
 for(let attempt=0;attempt<5;attempt++){
  const row=await db.sceneSnapshot.findFirst({where:{projectId,sceneKey:AUTOMATION_KEY},orderBy:{createdAt:'desc'}});if(!row)return;
  const state=JSON.parse(row.content) as AssetPromptAutomation;
  // A replacement execution is not the task this stop request targeted.
  if(execution!==undefined&&state.id!==execution)throw new Error('后台任务已切换，请刷新后停止当前任务。');
  execution=state.id;
  if(state.status!=='RUNNING')return;
  const stopped=await db.sceneSnapshot.updateMany({where:{id:row.id,content:row.content},data:{content:JSON.stringify({...state,status:'STOPPED',updatedAt:new Date().toISOString(),error:'已停止后续任务，正在执行的单项结果仍会保存。'})}});
  if(stopped.count===1)return;
 }
 throw new Error('后台进度正在更新，停止尚未生效，请再次点击停止。');
}
// A stable per-project row is the database lock; state.id identifies one execution.
export async function launchAssetPromptAutomation(projectId:string,sourceVersion:string,deps={db:prisma,spawnWorker:(rowId:string,token:string)=>{
 const child=spawn(process.execPath,['--import','tsx',path.join(process.cwd(),'scripts/asset-prompt-worker.ts'),projectId,rowId,token],{cwd:process.cwd(),env:process.env,detached:true,windowsHide:true,stdio:'ignore'});child.unref();return child;
}},mode:'FACTS'|'PROMPTS'='FACTS',scope?:AssetProductionScope){
 const rowId='apjob_'+createHash('sha256').update(projectId).digest('hex').slice(0,40);
 const existing=await deps.db.sceneSnapshot.findUnique({where:{id:rowId}});
 const legacy=existing??await deps.db.sceneSnapshot.findFirst({where:{projectId,sceneKey:AUTOMATION_KEY},orderBy:{createdAt:'desc'}});
 if(legacy){const old=effectiveAutomationState(JSON.parse(legacy.content) as AssetPromptAutomation);
  if(old.status==='RUNNING')return;
  if(old.status==='STOPPED'&&old.workerPid&&automationWorkerAlive(old.workerPid))throw new Error('上一轮单项仍在收尾，请等待保存完成后继续。');
 }
 const state:AssetPromptAutomation={id:randomUUID(),sourceVersion,mode,...(scope?{scope}:{}),status:'RUNNING',done:0,failed:0,total:0,error:'',updatedAt:new Date().toISOString()};
 const content=JSON.stringify(state);
 if(existing){const won=await deps.db.sceneSnapshot.updateMany({where:{id:rowId,content:existing.content},data:{content}});if(won.count!==1)return;}
 else{try{await deps.db.sceneSnapshot.create({data:{id:rowId,projectId,sceneKey:AUTOMATION_KEY,title:'P3 后的独立资产任务',content}});}catch(error){if((error as {code?:string}).code==='P2002')return;throw error;}}
 const fail=async(error:Error)=>{await deps.db.sceneSnapshot.updateMany({where:{id:rowId,content},data:{content:JSON.stringify({...state,status:'FAILED',error:error.message,updatedAt:new Date().toISOString()})}});};
 try{const child=deps.spawnWorker(rowId,state.id);child.once('error',error=>{void fail(error).catch(()=>{});});}catch(error){await fail(error as Error);}
}
