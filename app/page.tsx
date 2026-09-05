import Link from "next/link";
import type { CSSProperties } from "react";
import {
  deriveProjectCardState,
  resolveProjectDestination,
  resolveProjectStyleCover
} from "@/lib/project-entry";
import { requireSessionUser } from "@/lib/auth";
import { getProjectLibrary } from "@/lib/project-library";
import { archiveProjectAction, restoreProjectAction } from "@/app/actions";
import { DeleteProjectButton } from "./delete-project-button";
import { AppChrome } from "./ui/app-chrome";

export const dynamic = "force-dynamic";

const dateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit"
});

export default async function HomePage({ searchParams }: { searchParams: Promise<{ projectId?: string }> }) {
  const currentUser = await requireSessionUser("/");
  const { projectId: requestedProjectId } = await searchParams;
  const { projects, archivedProjects } = await getProjectLibrary(currentUser.id);
  const activeProject = requestedProjectId
    ? projects.find((project) => project.id === requestedProjectId)
    : undefined;

  return (
    <AppChrome
      title="我的剧本项目"
      eyebrow="项目库"
      activeSection="projects"
      projectId={activeProject?.id}
      projectLabel={activeProject?.title}
      utility={(
        <div className="libraryTopbarMeta" aria-label={`${projects.length} 个项目，${archivedProjects.length} 个归档`}>
          <span>{projects.length} 个项目</span>
          <span>{archivedProjects.length} 个归档</span>
        </div>
      )}
      primaryAction={<Link href={activeProject ? `/projects/new?projectId=${encodeURIComponent(activeProject.id)}` : "/projects/new"} className="topbarPrimary">新建项目 <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14" /></svg></Link>}
    >
      <section className="projectLibrary" aria-label="项目列表">
        {projects.length ? (
          <div className={`projectCardGrid ${projects.length === 1 ? "singleProject" : ""}`}>
            {projects.map((project, index) => {
              const productionEpisodes = project.episodes;
              const unitEpisodeCount = productionEpisodes.filter((episode) => episode._count.seedanceUnits > 0).length;
              const state = deriveProjectCardState({
                episodeCount: project._count.episodes,
                snapshotCount: project._count.sceneSnapshots,
                assetCount: project._count.assets,
                unitEpisodeCount
              });
              const posterStyle = {
                "--project-cover": `url("${resolveProjectStyleCover(project.style)}")`
              } as CSSProperties;
              const destination = resolveProjectDestination(project.id);

              return (
                <article className="projectCard" key={project.id} aria-labelledby={`project-${project.id}-title`} aria-describedby={`project-${project.id}-stage`}>
                  <Link
                    href={destination}
                    className="projectCardHitArea"
                    aria-label={`进入项目 ${project.title}`}
                  />
                  <div className="projectPoster" style={posterStyle}>
                    <div className="posterFrame" aria-hidden="true">
                      <span>{String(index + 1).padStart(2, "0")}</span>
                      <i />
                    </div>
                    <span id={`project-${project.id}-stage`} className="projectStageBadge">{state.stage}</span>
                    <strong>{project.style || "未选择风格"}</strong>
                  </div>

                  <div className="projectCardBody">
                    <div className="projectTitleRow">
                      <div>
                        <h2 id={`project-${project.id}-title`}>{project.title}</h2>
                        <p>{project.description || "尚未填写项目简介"}</p>
                      </div>
                      <span className="aspectBadge">{project.aspectRatio}</span>
                    </div>

                    <div className="projectProgress" aria-label={`项目完成度 ${state.progress}%`}>
                      <div>
                        <span>当前进度</span>
                        <b>{state.progress}%</b>
                      </div>
                      <i role="progressbar" aria-label={`${project.title}完成度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.progress} aria-valuetext={`${state.stage}，${state.progress}%`}><span style={{ width: `${state.progress}%` }} /></i>
                    </div>

                    <div className="projectCardFooter">
                      <span>{project._count.episodes} 集 · 更新于 <time dateTime={project.updatedAt.toISOString()}>{dateFormatter.format(project.updatedAt)}</time></span>
                      <Link href={destination} className="continueLink" aria-label={`${state.actionLabel}：${project.title}`}>
                        {state.actionLabel}<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M4 12h16m-6-6 6 6-6 6" /></svg>
                      </Link>
                      <details className="projectCardMenu">
                        <summary aria-label={`${project.title}更多操作`}><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg></summary>
                        <div>
                          <form action={archiveProjectAction}>
                            <input name="projectId" type="hidden" value={project.id} />
                            <button type="submit" className="archiveAction" title="归档项目（不删除，可随时恢复）" aria-label={`归档项目：${project.title}`}>归档项目</button>
                          </form>
                        </div>
                      </details>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <div className="projectEmptyState">
            <span className="emptyMark" aria-hidden="true"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" focusable="false"><path d="M12 5v14M5 12h14" /></svg></span>
            <h2>还没有剧本项目</h2>
            <p>上传完整剧本，选择画面风格后即可开始全剧基础工程。</p>
            <Link href="/projects/new" className="secondaryAction">创建第一个项目</Link>
          </div>
        )}
        {archivedProjects.length ? (
          <details className="archiveSection">
            <summary>归档项目 <span>{archivedProjects.length}</span></summary>
            <div className="projectCardGrid">
              {archivedProjects.map((project) => (
                <article className="projectCard archived" key={project.id} aria-labelledby={`archived-project-${project.id}-title`}>
                  <div className="projectCardBody">
                    <div className="projectTitleRow">
                      <div>
                        <h2 id={`archived-project-${project.id}-title`}>{project.title}</h2>
                        <p>{project.description || "尚未填写项目简介"}</p>
                      </div>
                      <span className="aspectBadge">归档</span>
                    </div>
                    <div className="projectCardFooter">
                      <span>{project._count.episodes} 集 · 归档于 <time dateTime={(project.archivedAt ?? project.updatedAt).toISOString()}>{dateFormatter.format(project.archivedAt ?? project.updatedAt)}</time></span>
                      <form action={restoreProjectAction}>
                        <input name="projectId" type="hidden" value={project.id} />
                        <button type="submit" className="archiveAction" title="恢复到项目列表" aria-label={`恢复项目：${project.title}`}>恢复</button>
                      </form>
                      <DeleteProjectButton projectId={project.id} title={project.title} />
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </details>
        ) : null}
      </section>
    </AppChrome>
  );
}
