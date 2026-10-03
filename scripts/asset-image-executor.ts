/** Local stdio executor transport. It does not generate images or control a browser. */
import readline from 'node:readline';
import {prisma} from '../lib/prisma';
import {listExecutorImageJobs,imageJobExecutorIdentity,claimImageJob,readImageHandoff,importImageJobPaths,failImageJob} from '../lib/asset-image-job-service';

const definition=(name:string,description:string,properties:Record<string,unknown>,required:string[]=[])=>({name,description,inputSchema:{type:'object',properties,required,additionalProperties:false}});
const text={type:'string'},integer={type:'integer',minimum:0};
const definitions=[
 definition('director_image_jobs','列出3008等待桌面Codex执行及尚未回传的图片任务。只读，不会发送ChatGPT。',{}),
 definition('director_image_claim','确认浏览器登录和原图导出能力后才领取单个任务。领取后禁止自动重发；必须按绑定的直接来源图片执行。',{jobId:text,revision:integer},['jobId','revision']),
 definition('director_image_import','回传该任务originals目录中真实生成原图。使用claimToken和领取后的revision。数量、图片解码、哈希、路径、任务状态会被校验；不会自动采用。',{jobId:text,revision:integer,claimToken:text,paths:{type:'array',items:text,minItems:1,maxItems:4},executionUrl:text},['jobId','revision','claimToken','paths']),
 definition('director_image_fail','登录/生成/导出失败时结束领取，保留错误。禁止偷偷换API或CLI生图；不自动重发。',{jobId:text,revision:integer,claimToken:text,error:text},['jobId','revision','claimToken','error']),
];
export async function executeImageTool(name:string,args:Record<string,any>){
 if(name==='director_image_jobs')return {jobs:await listExecutorImageJobs()};
 if(!definitions.some(d=>d.name===name))throw new Error('未知图片执行工具。');
 const {projectId,actorId}=await imageJobExecutorIdentity(args.jobId);
 if(name==='director_image_claim'){const result=await claimImageJob(projectId,actorId,args.jobId,args.revision);return {...result,handoff:await readImageHandoff(projectId,actorId,args.jobId)};}
 if(name==='director_image_import')return importImageJobPaths(projectId,actorId,args.jobId,args.revision,args.paths,args.claimToken,args.executionUrl);
 return failImageJob(projectId,actorId,args.jobId,args.revision,args.claimToken,args.error);
}
async function rpc(message:any){
 if(message.method==='initialize')return {protocolVersion:message.params?.protocolVersion??'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'director-3008-image-executor',version:'1.0.0'}};
 if(message.method==='ping')return {};
 if(message.method==='tools/list')return {tools:definitions};
 if(message.method==='tools/call'){
  const tool=definitions.find(d=>d.name===message.params?.name),args=message.params?.arguments??{};
  try{
   if(!tool||typeof args!=='object'||Array.isArray(args)||tool.inputSchema.required.some(k=>!(k in args))||Object.keys(args).some(k=>!(k in tool.inputSchema.properties)))throw new Error('执行工具参数无效。');
   return {content:[{type:'text',text:JSON.stringify(await executeImageTool(tool.name,args))}]};
  }catch(error){const message=error instanceof Error?error.message:'图片执行失败。';return {isError:true,content:[{type:'text',text:/Prisma|DATABASE_URL/i.test(message)?'本地图片任务读写失败，请检查部署状态。':message}]};}
 }
 throw new Error('不支持的方法。');
}
const flag=process.argv.indexOf('--call');
if(flag>=0){
 executeImageTool(process.argv[flag+1],JSON.parse(process.argv[flag+2]??'{}')).then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(error=>{process.stderr.write(String(error.message)+'\n');process.exitCode=1;}).finally(()=>prisma.$disconnect());
}else{
 const input=readline.createInterface({input:process.stdin,crlfDelay:Infinity});let queue=Promise.resolve();
 input.on('line',line=>{queue=queue.then(async()=>{let request;try{request=JSON.parse(line);if(request.id===undefined)return;const result=await rpc(request);process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');}catch{process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request?.id??null,error:{code:-32600,message:'Invalid request'}})+'\n');}});});
 input.on('close',()=>void queue.finally(()=>prisma.$disconnect()));
}
