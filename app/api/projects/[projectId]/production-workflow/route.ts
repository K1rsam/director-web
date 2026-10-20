import {getCurrentUser} from '@/lib/auth';
import {hasSameLocalOrigin,readLocalJsonObject,LocalRequestError} from '@/lib/local-json-request';
import {getProductionWorkflow,mutateProductionWorkflow,readProductionDeliveryFile,productionWorkflowFailure,type ProductionWorkflowCommand} from '@/lib/production-workflow';

export const runtime='nodejs';
export const dynamic='force-dynamic';
type Context={params:Promise<{projectId:string}>};
const json=(body:unknown,status=200)=>Response.json(body,{status,headers:{'cache-control':'private, no-store','x-content-type-options':'nosniff'}});
export async function GET(request:Request,context:Context){
 const user=await getCurrentUser();if(!user)return json({code:'UNAUTHORIZED',error:'请先登录。'},401);
 try{
  const params=new URL(request.url).searchParams,projectId=(await context.params).projectId,workflowId=params.get('workflowId'),name=params.get('deliveryFile');
  if(name&&workflowId){const file=await readProductionDeliveryFile(projectId,user.id,workflowId,name);return new Response(file.body,{headers:{'content-type':file.type,'content-disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.filename)}`,'cache-control':'private, no-store','x-content-type-options':'nosniff'}});}
  return json(await getProductionWorkflow(projectId,user.id,workflowId));
 }
 catch(error){const failure=productionWorkflowFailure(error);return json(failure.body,failure.status);}
}
export async function POST(request:Request,context:Context){
 const user=await getCurrentUser();if(!user)return json({code:'UNAUTHORIZED',error:'请先登录。'},401);
 if(!hasSameLocalOrigin(request))return json({code:'WORKFLOW_ORIGIN',error:'请从当前工作台提交。'},403);
 try{
  const command=await readLocalJsonObject(request,32768) as ProductionWorkflowCommand;
  // Project/user identity and directory paths are server-owned, never accepted from the request body.
  return json(await mutateProductionWorkflow((await context.params).projectId,user.id,command),command.action==='create'?201:200);
 }catch(error){if(error instanceof LocalRequestError)return json({code:'WORKFLOW_REQUEST',error:error.message},error.status);const failure=productionWorkflowFailure(error);return json(failure.body,failure.status);}
}
