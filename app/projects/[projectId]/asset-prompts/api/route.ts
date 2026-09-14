import { getCurrentUser, requireProjectAccess } from '@/lib/auth';
import { loadAssetPromptWorkspace, saveAssetPrompt, saveAssetStyle, generateAssetPrompt, recoverAssetPrompt } from '@/lib/asset-prompt-service';
import {saveImageTemplate,uploadAssetReference,removeAssetReference,readAssetReference} from '@/lib/asset-image-options-service';
import {stopAssetPromptAutomation,launchAssetPromptAutomation} from '@/lib/asset-prompt-automation';
import {loadFoundationInputs} from '@/lib/foundation-state';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{projectId:string}>}) {
  const {projectId}=await params;
  if(!await getCurrentUser())return Response.json({error:'请先登录。'},{status:401});
  await requireProjectAccess(projectId);
  const search=new URL(request.url).searchParams;
  if(search.has('reference')){
    const result=await readAssetReference(projectId,search.get('key')??'',search.get('reference')??'');
    if(!result)return Response.json({error:'参考图不存在或已移除。'},{status:404});
    return new Response(new Uint8Array(result.bytes),{headers:{'Content-Type':result.reference.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  }
  return Response.json(await loadAssetPromptWorkspace(projectId),{headers:{'Cache-Control':'private, no-store'}});
}
export async function POST(request:Request,{params}:{params:Promise<{projectId:string}>}) {
  const {projectId}=await params;
  if(!await getCurrentUser())return Response.json({error:'请先登录。'},{status:401});
  await requireProjectAccess(projectId);
  let sameOrigin=false;
  try { const origin=new URL(request.headers.get('origin')??''); sameOrigin=origin.host===request.headers.get('host')&&origin.protocol===new URL(request.url).protocol; } catch {}
  if(!sameOrigin)return Response.json({error:'请从当前工作台提交。'},{status:403});
  try {
    if(Number(request.headers.get('content-length')??0)>11*1024*1024)throw new Error('单次上传不能超过10 MB。');
    if(request.headers.get('content-type')?.includes('multipart/form-data')){
      const form=await request.formData(),key=form.get('key'),file=form.get('file'),revision=Number(form.get('revision'));
      if(typeof key!=='string'||key.length>200||!(file instanceof File)||!Number.isSafeInteger(revision)||revision<0)throw new Error('无效的参考图上传。');
      return Response.json(await uploadAssetReference(projectId,key,revision,file));
    }
    const input=await request.json();
    if(!Number.isSafeInteger(input.revision)||input.revision<0)throw new Error('无效的内容版本。');
    if(input.action==='stop-automation'){await stopAssetPromptAutomation(projectId);return Response.json(await loadAssetPromptWorkspace(projectId));}
    if(input.action==='resume-automation'){const workspace=await loadAssetPromptWorkspace(projectId);if(workspace.busy)throw new Error('第一阶段仍在整理，请完成后继续。');await launchAssetPromptAutomation(projectId,(await loadFoundationInputs(projectId)).sourceVersion);return Response.json(await loadAssetPromptWorkspace(projectId));}
    if(input.action==='style')return Response.json(await saveAssetStyle(projectId,input.prefix,input.revision));
    if(typeof input.key!=='string'||input.key.length>200)throw new Error('请选择有效资产。');
    if(input.action==='save')return Response.json(await saveAssetPrompt(projectId,input.key,input.revision,input.body));
    if(input.action==='generate')return Response.json(await generateAssetPrompt(projectId,input.key,input.revision));
    if(input.action==='recover')return Response.json(await recoverAssetPrompt(projectId,input.key,input.revision));
    if(input.action==='image-template')return Response.json(await saveImageTemplate(projectId,input.key,input.revision,input.templateId,input.templateText,input.quality,input.aspectRatio,input.count));
    if(input.action==='remove-reference')return Response.json(await removeAssetReference(projectId,input.key,input.revision,input.id));
    throw new Error('不支持的操作。');
  } catch(error) {return Response.json({error:error instanceof Error?error.message:'操作失败，请稍后重试。'},{status:409});}
}
