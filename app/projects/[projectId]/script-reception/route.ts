import {getCurrentUser} from '@/lib/auth';
import {hasSameLocalOrigin,readLocalJsonObject} from '@/lib/local-json-request';
import {readScriptReception,confirmScriptResolution,revokeScriptResolution,assistScriptResolution} from '@/lib/script-resolution-service';
import {createScriptResolutionJudgment} from '@/lib/script-resolution-judgment';

export const dynamic='force-dynamic';
type Context={params:Promise<{projectId:string}>};
const headers={'Cache-Control':'private, no-store'};
const failed=(error:unknown)=>Response.json({error:error instanceof Error?error.message:'核对操作未完成。',code:(error as {code?:string}).code,assistance:(error as {assistance?:unknown}).assistance},{status:(error as {status?:number}).status??409,headers});
export async function GET(request:Request,{params}:Context){
 const user=await getCurrentUser();if(!user)return Response.json({error:'请先登录。'},{status:401,headers});
 try{const {projectId}=await params,episode=new URL(request.url).searchParams.get('episode');return Response.json(await readScriptReception(projectId,user.id,episode===null?undefined:Number(episode)),{headers});}catch(error){return failed(error);}
}
export async function POST(request:Request,{params}:Context){
 const user=await getCurrentUser();if(!user)return Response.json({error:'请先登录。'},{status:401,headers});
 if(!hasSameLocalOrigin(request))return Response.json({error:'请从当前工作台提交。'},{status:403,headers});
 try{
  const {projectId}=await params,parsed=await readLocalJsonObject(request,8000);
  const {action,...input}=parsed;
  if(action==='confirm')return Response.json(await confirmScriptResolution(projectId,user.id,input),{headers});
  if(action==='revoke')return Response.json(await revokeScriptResolution(projectId,user.id,input),{headers});
  if(action==='assist')return Response.json(await assistScriptResolution(projectId,user.id,input,input.judgmentProvider==='JEV'?{judge:createScriptResolutionJudgment({actorId:user.id,sourceVersion:input.sourceVersion,explicitExternalConsent:input.explicitExternalConsent===true})}:{}),{headers});
  return Response.json({error:'不支持的核对操作。'},{status:400,headers});
 }catch(error){return failed(error);}
}
