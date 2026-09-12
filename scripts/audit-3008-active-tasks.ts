import { PrismaClient } from '@prisma/client';
const db=new PrismaClient();
async function main(){
 const rows=await db.sceneSnapshot.findMany({where:{id:{startsWith:'foundation-delivery-'}},select:{projectId:true,content:true}});
 const active=rows.flatMap(row=>{let task;try{task=JSON.parse(row.content);}catch{return [{projectId:row.projectId,status:'UNREADABLE'}];}return ['QUEUED','RUNNING'].includes(task.status)?[{projectId:row.projectId,taskId:task.id,status:task.status,phase:task.phase,workerPid:task.workerPid}]:[];});
 const runs=await db.pipelineRun.findMany({where:{status:{in:['RUNNING','QUEUED']}},select:{id:true,projectId:true,stageCode:true,status:true}});
 console.log(JSON.stringify({activeTasks:active,activeRuns:runs}));
 if(active.length||runs.length)process.exitCode=2;
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>db.$disconnect());
