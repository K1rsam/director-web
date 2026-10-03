import { requireProjectAccess } from "@/lib/auth";
import { readProductionEpisodeHandoff } from '@/lib/episode-upstream-material';
export async function GET(request:Request,{params}:{params:Promise<{projectId:string}>}) {
  const {projectId}=await params;
  await requireProjectAccess(projectId);
  const url=new URL(request.url),rawEpisode=url.searchParams.get('episode'),episode=Number(rawEpisode);
  if(rawEpisode===null||!/^(0|[1-9]\d*)$/.test(rawEpisode)||!Number.isSafeInteger(episode))return new Response('无效集号',{status:400});
  try {
    const result=await readProductionEpisodeHandoff(projectId,episode);
    if((url.searchParams.has('revision')&&url.searchParams.get('revision')!==String(result.packet.documentRevision)) ||
       (url.searchParams.has('materialVersion')&&url.searchParams.get('materialVersion')!==result.materialVersion)) {
      return new Response('资料或采用设计已更新，请重新预览后下载',{status:409});
    }
    return new Response(JSON.stringify(result,null,2),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':`attachment; filename=episode-${episode}-handoff.json`,'Cache-Control':'no-store'}});
  } catch(e) {const changed=(e as {code?:string})?.code==='UPSTREAM_CHANGED';return new Response(changed?(e as Error).message:'交接资料暂不可读取，请返回预览重新核对。',{status:changed?409:400});}
}
