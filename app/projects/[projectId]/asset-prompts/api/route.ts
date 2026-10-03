import { getCurrentUser, requireProjectAccess } from '@/lib/auth';
import {hasSameLocalOrigin,readLocalJsonObject,readLocalFormData,LocalRequestError} from '@/lib/local-json-request';
import { loadAssetPromptWorkspace, saveAssetPrompt, saveAssetStyle, generateAssetPrompt, recoverAssetPrompt,planEpisodeAssetProduction } from '@/lib/asset-prompt-service';
import {saveImageTemplate,uploadAssetReference,removeAssetReference,readAssetReference,readAssetReferencePreview} from '@/lib/asset-image-options-service';
import {stopAssetPromptAutomation,launchAssetPromptAutomation} from '@/lib/asset-prompt-automation';
import {loadFoundationInputs} from '@/lib/foundation-state';
import {readAssetPreparationReview} from '@/lib/episode-upstream-material';
export const dynamic='force-dynamic';
export async function GET(request:Request,{params}:{params:Promise<{projectId:string}>}) {
  const {projectId}=await params;
  if(!await getCurrentUser())return Response.json({error:'请先登录。'},{status:401});
  await requireProjectAccess(projectId);
  const search=new URL(request.url).searchParams;
  if(search.has('reference')){
    if(search.get('view')==='reference-preview'){const preview=await readAssetReferencePreview(projectId,search.get('key')??'',search.get('reference')??'');if(!preview)return Response.json({error:'参考图不存在或已移除。'},{status:404});return new Response(new Uint8Array(preview.bytes),{headers:{'Content-Type':preview.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
    const result=await readAssetReference(projectId,search.get('key')??'',search.get('reference')??'');
    if(!result)return Response.json({error:'参考图不存在或已移除。'},{status:404});
    return new Response(new Uint8Array(result.bytes),{headers:{'Content-Type':result.reference.mime,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
  }
  try{
    const scope=search.has('episodes')?(await planEpisodeAssetProduction(projectId,search.get('episodes')!.split(',').map(Number),search.get('view')==='production-cards'?[]:undefined)).scope:undefined;
    if(search.get('view')==='production-cards'){
      if(!scope)throw new Error('请明确选择制作集数，未读取全剧生产卡。');
      return Response.json(await readAssetPreparationReview(projectId,scope.episodeNumbers),{headers:{'Cache-Control':'private, no-store'}});
    }
    return Response.json(await loadAssetPromptWorkspace(projectId,scope),{headers:{'Cache-Control':'private, no-store'}});
  }catch(error){return Response.json({error:error instanceof Error?error.message:'选集范围无效。'},{status:409});}
}
export async function POST(request:Request,{params}:{params:Promise<{projectId:string}>}) {
  const {projectId}=await params;
  if(!await getCurrentUser())return Response.json({error:'请先登录。'},{status:401});
  await requireProjectAccess(projectId);
  if(!hasSameLocalOrigin(request))return Response.json({error:'请从当前工作台提交。'},{status:403});
  try {
    if(request.headers.get('content-type')?.split(';',1)[0].trim().toLowerCase()==='multipart/form-data'){
      const form=await readLocalFormData(request,11*1024*1024),key=form.get('key'),file=form.get('file'),revision=Number(form.get('revision'));
      if(typeof key!=='string'||key.length>200||!(file instanceof File)||!Number.isSafeInteger(revision)||revision<0)throw new Error('无效的参考图上传。');
      return Response.json(await uploadAssetReference(projectId,key,revision,file));
    }
    const input=await readLocalJsonObject(request,65536);
    if(!Number.isSafeInteger(input.revision)||input.revision<0)throw new Error('无效的内容版本。');
    if(input.action==='stop-automation'){await stopAssetPromptAutomation(projectId);return Response.json(await loadAssetPromptWorkspace(projectId));}
    if(input.action==='prepare-facts'||input.action==='resume-automation'||input.action==='generate-episodes'){
      const workspace=await loadAssetPromptWorkspace(projectId);if(workspace.busy)throw new Error('第一阶段仍在整理，请完成后继续。');
      const numbers=input.episodeNumbers??(input.action==='resume-automation'?workspace.automation?.scope?.episodeNumbers:undefined);
      if(!Array.isArray(numbers)||!numbers.length)throw new Error('请先明确选择制作集数；旧全剧任务未自动恢复。');
      const plan=await planEpisodeAssetProduction(projectId,numbers);
      await launchAssetPromptAutomation(projectId,(await loadFoundationInputs(projectId)).sourceVersion,undefined,input.action==='generate-episodes'?'PROMPTS':'FACTS',plan.scope);
      return Response.json(await loadAssetPromptWorkspace(projectId,plan.scope));
    }
    if(input.action==='style')return Response.json(await saveAssetStyle(projectId,input.prefix,input.revision));
    if(typeof input.key!=='string'||input.key.length>200)throw new Error('请选择有效资产。');
    if(input.action==='save')return Response.json(await saveAssetPrompt(projectId,input.key,input.revision,input.body));
    if(input.action==='generate'){
      if(!Array.isArray(input.episodeNumbers)||!input.episodeNumbers.length)throw new Error('请先明确选择制作集数，未自动扫描全剧。');
      const scope=(await planEpisodeAssetProduction(projectId,input.episodeNumbers)).scope;
      return Response.json(await generateAssetPrompt(projectId,input.key,input.revision,undefined,scope));
    }
    if(input.action==='recover')return Response.json(await recoverAssetPrompt(projectId,input.key,input.revision));
    if(input.action==='image-template')return Response.json(await saveImageTemplate(projectId,input.key,input.revision,input.templateId,input.templateText,input.quality,input.aspectRatio,input.count));
    if(input.action==='remove-reference')return Response.json(await removeAssetReference(projectId,input.key,input.revision,input.id));
    throw new Error('不支持的操作。');
  } catch(error) {return Response.json({error:error instanceof Error?error.message:'操作失败，请稍后重试。'},{status:error instanceof LocalRequestError?error.status:409});}
}
