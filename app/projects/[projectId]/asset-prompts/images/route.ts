import {readImageBrowserStatus,changeImageBrowserState} from '@/lib/image-browser-service';
import {getCurrentUser,requireProjectAccess} from '@/lib/auth';
import {hasSameLocalOrigin,readLocalJsonObject,readLocalFormData,LocalRequestError} from '@/lib/local-json-request';
import {listImageJobs,createImageJob,cancelImageJob,readImageHandoff,importImageJob,readImageJobImage,readImageJobPreview,useImageJobResult} from '@/lib/asset-image-job-service';
export const dynamic='force-dynamic';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
function failure(error:unknown){const message=error instanceof Error?error.message:'图片任务操作未完成。';return Response.json({error:/[A-Za-z]:[\\/]|ENOENT|EACCES|Prisma/i.test(message)?'图片任务操作未完成，请检查本地文件或刷新任务记录。':message},{status:error instanceof LocalRequestError?error.status:409,headers});}
export async function GET(request:Request,{params}:{params:Promise<{projectId:string}>}){
 const {projectId}=await params,user=await getCurrentUser();if(!user)return Response.json({error:'请先登录。'},{status:401});await requireProjectAccess(projectId);
 try{
  const query=new URL(request.url).searchParams,id=query.get('jobId'),view=query.get('view');
  if(view!==null&&view!=='handoff'&&view!=='preview')throw new Error('不支持的图片查看方式。');
  if(view==='preview'){
   if(!id||!query.get('imageId'))throw new Error('请选择待预览的候选图片。');
   const result=await readImageJobPreview(projectId,user.id,id,query.get('imageId')!);
   return new Response(new Uint8Array(result.bytes),{headers:{...headers,'Content-Type':result.mime}});
  }
  if(id&&query.has('imageId')){const result=await readImageJobImage(projectId,user.id,id,query.get('imageId')!);return new Response(new Uint8Array(result.bytes),{headers:{...headers,'Content-Type':result.image.mime}});}
  if(id&&query.get('view')==='handoff'){
   const {references,outputDirectory:_,...job}=await readImageHandoff(projectId,user.id,id);
   return Response.json({...job,references:references.map(({path:__,...ref})=>({...ref,url:`/projects/${projectId}/asset-prompts/api?key=${encodeURIComponent(ref.assetKey)}&reference=${encodeURIComponent(ref.id)}`})),instructions:'请由桌面Codex领取任务并在ChatGPT网页生成，保存原图后回传；此执行包不会自动发送任务。'},{headers});
  }
  return Response.json(await listImageJobs(projectId,user.id,query.get('key')??undefined),{headers});
 }catch(error){return failure(error);}
}
export async function POST(request:Request,{params}:{params:Promise<{projectId:string}>}){
 const {projectId}=await params,user=await getCurrentUser();if(!user)return Response.json({error:'请先登录。'},{status:401});await requireProjectAccess(projectId);
 if(!hasSameLocalOrigin(request))return Response.json({error:'请从当前工作台提交。'},{status:403});
 try{
  if(request.headers.get('content-type')?.split(';',1)[0].toLowerCase()==='multipart/form-data'){
   const form=await readLocalFormData(request,81*1024*1024),files=form.getAll('files');
   if(!files.length||files.some(file=>!(file instanceof File)))throw new Error('请选择对应任务的原图。');
   return Response.json(await importImageJob(projectId,user.id,String(form.get('jobId')),Number(form.get('revision')),files as File[]),{headers});
  }
  const input=await readLocalJsonObject(request,32768);
  if(input.action==='generate'){
   const browser=await readImageBrowserStatus(projectId,user.id);
   if(!browser.available)throw new Error('Chrome 连接尚未就绪，请打开连接设置；未发送生图。');
   const job=await createImageJob(projectId,user.id,input,'CHROME');
   await changeImageBrowserState(projectId,user.id,'enable');
   return Response.json(job,{headers});
  }
  if(input.action==='create')return Response.json(await createImageJob(projectId,user.id,input),{headers});
  if(input.action==='cancel')return Response.json(await cancelImageJob(projectId,user.id,input.jobId,input.revision),{headers});
  if(input.action==='use')return Response.json(await useImageJobResult(projectId,user.id,input.jobId,input.imageId,input.revision,input.expectedOptionsRevision),{headers});
  throw new Error('不支持的图片任务操作。');
 }catch(error){return failure(error);}
}
