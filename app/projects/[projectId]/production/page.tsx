import {requireProjectAccess} from '@/lib/auth';
import {prisma} from '@/lib/prisma';
import {loadAssetPromptWorkspace} from '@/lib/asset-prompt-service';
import {isProductionEpisodeNumber,readProductionScope} from '@/lib/production-episodes';
import {AppChrome} from '@/app/ui/app-chrome';
import {ProductionWorkspace} from './workspace';
import '@/app/page-surfaces.css';

export const dynamic='force-dynamic';
export default async function ProductionPage({params}:{params:Promise<{projectId:string}>}){
 const {projectId}=await params;await requireProjectAccess(projectId,`/projects/${projectId}/production`);
 const [workspace,episodes,scope]=await Promise.all([loadAssetPromptWorkspace(projectId),prisma.episode.findMany({where:{projectId},orderBy:{number:'asc'},select:{id:true,number:true,title:true}}),readProductionScope(projectId)]);
 const productionEpisodes=episodes.filter(e=>isProductionEpisodeNumber(e.number,scope)).map(e=>({...e,title:e.title??'',productionEligible:true}));
 return <AppChrome title={workspace.title} eyebrow="第三阶段 / 连续制作" projectId={projectId} projectLabel={workspace.title} activeSection="production" episodes={productionEpisodes} primaryAction={<a className="quietButton" href={`/projects/${projectId}`}>返回全剧资料</a>}>
  <ProductionWorkspace projectId={projectId} episodes={productionEpisodes} assets={workspace.assets.map(a=>({key:a.key,name:a.name,episodes:a.episodes??[],mode:a.mode}))}/>
 </AppChrome>;
}
