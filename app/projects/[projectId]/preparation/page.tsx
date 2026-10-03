import Link from 'next/link';
import {requireProjectAccess} from '@/lib/auth';
import {AppChrome} from '@/app/ui/app-chrome';
import {getSeriesDirectionWorkspace} from '@/lib/series-direction-service';
import {readScriptReception} from '@/lib/script-resolution-service';
import {SeriesDirectionPanel} from '../series-direction-panel';
import {ScriptReceptionPanel} from '../script-reception-panel';
import '@/app/page-surfaces.css';
import '@/app/workbench-refinement.css';

export const dynamic='force-dynamic';
export default async function PreparationPage({params,searchParams}:{params:Promise<{projectId:string}>;searchParams?:Promise<{episode?:string}>}) {
 const {projectId}=await params,user=await requireProjectAccess(projectId);
 const requested=(await searchParams)?.episode,number=requested?.trim()?Number(requested):undefined;
 const selectedEpisode=number!==undefined&&Number.isSafeInteger(number)&&number>=0?number:undefined;
 const [direction,script]=await Promise.all([getSeriesDirectionWorkspace(projectId,user.id),readScriptReception(projectId,user.id,selectedEpisode)]);
 return <AppChrome title={`${script.title} · 整理与定稿`} eyebrow="第一阶段 / 原文与全剧方向" projectId={projectId} activeSection="project"
  primaryAction={<Link className="studioButton" data-variant="secondary" href={`/projects/${projectId}/asset-prompts`}>第二阶段 · 资产形象设计</Link>}
  utility={<Link className="quietButton" href={`/projects/${projectId}`}>返回全剧工作台</Link>}>
  <div className="projectDashboard">
   <section className="studioSection"><div className="sectionHeading"><div><span className="sectionIndex">01</span><h2>先对齐原文，再确认整部剧的方向</h2></div></div>
    <p>原句不改写。普通格式由程序整理，有歧义只核对对应片段；全剧方向只有明确确认后才提供给后续阶段。</p>
    <nav aria-label="整理与定稿区段" style={{display:'flex',gap:12,flexWrap:'wrap'}}><a className="quietButton" href="#script-review">剧本阅读与核对</a><a className="quietButton" href="#series-direction">全剧方向</a></nav>
    <details><summary>资料来源与交接检查</summary><Link className="quietButton" href={`/projects/${projectId}/foundation/handoff`}>资料与来源检查</Link><Link className="quietButton" href={`/projects/${projectId}/source`}>原件与导入记录</Link></details>
   </section>
   <div id="script-review" style={{scrollMarginTop:140}}><ScriptReceptionPanel key={projectId} projectId={projectId} initial={script}/></div>
   <div id="series-direction" style={{scrollMarginTop:140}}><SeriesDirectionPanel key={projectId} projectId={projectId} initialWorkspace={direction}/></div>
  </div>
 </AppChrome>;
}
