import {requireProjectAccess} from '@/lib/auth';
import {loadAssetPromptWorkspace} from '@/lib/asset-prompt-service';
import {AppChrome} from '@/app/ui/app-chrome';
import {AssetPromptWorkspace} from './workspace';
import styles from './workspace.module.css';
export const dynamic='force-dynamic';
export default async function Page({params}:{params:Promise<{projectId:string}>}) {
  const {projectId}=await params;await requireProjectAccess(projectId,`/projects/${projectId}/asset-prompts`);
  const workspace=await loadAssetPromptWorkspace(projectId);
  return <div className={styles.shell}><AppChrome title={workspace.title} eyebrow="1.5 阶段 · 资产形象设计" projectId={projectId} activeSection="project"
    primaryAction={<a className="quietButton" href={`/projects/${projectId}`}>返回第一阶段</a>}>
    <AssetPromptWorkspace initial={workspace}/>
  </AppChrome></div>;
}
