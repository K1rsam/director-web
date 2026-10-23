import {getCurrentUser,requireProjectAccess} from '@/lib/auth';
import {hasSameLocalOrigin,readLocalJsonObject,LocalRequestError} from '@/lib/local-json-request';
import {generateSeasonCandidates,mutateSeasonScope,seasonWorkspace} from '@/lib/season-scope-service';
export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{projectId:string}>};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
export async function GET(_request:Request,context:Context){const user=await getCurrentUser();if(!user)return json({error:'请先登录。'},401);const {projectId}=await context.params;await requireProjectAccess(projectId);try{return json(await seasonWorkspace(projectId));}catch(e){return json({error:(e as Error).message},409);}}
export async function POST(request:Request,context:Context){
 const user=await getCurrentUser();if(!user)return json({error:'请先登录。'},401);
 if(!hasSameLocalOrigin(request))return json({error:'请从当前工作台提交。'},403);
 try{const command=await readLocalJsonObject(request,8192),{projectId}=await context.params;await requireProjectAccess(projectId);
  if(command.action==='generate'||command.action==='recover')await generateSeasonCandidates(projectId,user.id,{...command,recoverOnly:command.action==='recover'});
  else await mutateSeasonScope(projectId,user.id,command);
  return json(await seasonWorkspace(projectId));
 }catch(e){return json({code:(e as {code?:string}).code??'SEASON_REQUEST',error:(e as Error).message},e instanceof LocalRequestError?e.status:409);}
}
