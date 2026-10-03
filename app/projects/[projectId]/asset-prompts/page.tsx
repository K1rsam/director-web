import {requireProjectAccess} from '@/lib/auth';
import {loadAssetPromptWorkspace} from '@/lib/asset-prompt-service';
import {AppChrome} from '@/app/ui/app-chrome';
import {AssetPromptWorkspace} from './workspace';
import {prisma} from '@/lib/prisma';
import {isProductionEpisodeNumber,readProductionScope} from '@/lib/production-episodes';
import styles from './workspace.module.css';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{projectId:string}>}) {
  const {projectId}=await params;await requireProjectAccess(projectId,`/projects/${projectId}/asset-prompts`);
  const workspace=await loadAssetPromptWorkspace(projectId);
  const episodes=await prisma.episode.findMany({where:{projectId},orderBy:{number:'asc'},select:{id:true,number:true,title:true}});
  const scope=await readProductionScope(projectId);
  return <div className={styles.shell}><AppChrome title={workspace.title} eyebrow="第二阶段 · 资产形象设计" projectId={projectId} projectLabel={workspace.title} activeSection="assets" episodes={episodes.filter(item=>isProductionEpisodeNumber(item.number,scope)).map(item=>({...item,title:item.title||'',productionEligible:true}))}
    primaryAction={<a className="quietButton" href={`/projects/${projectId}`}>返回第一阶段</a>}>
    <AssetPromptWorkspace initial={workspace}/>
  </AppChrome></div>;
}
